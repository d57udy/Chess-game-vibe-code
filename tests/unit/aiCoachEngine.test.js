'use strict';
// v6 engine analysis for coach mode: classifyMove thresholds (Lichess win% model, both sides,
// boundaries, mate clamp), analyze (multi-PV sorted, legal, White-POV evals, mates, terminal
// positions, node budget, deterministic), threats (null-move ideas, in-check empty), and
// requestAnalysis / requestThreats through the worker and main-thread fallback incl. cancel.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadEngine, source, uci } = require('../helpers/loadEngine');

const E = loadEngine({ globals: { performance: { now: () => 0 } } });
const has = E.run('typeof ChessAI.analyze === "function" && typeof ChessAI.threats === "function" && typeof ChessAI.classifyMove === "function"');
const STATE = '({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber })';
const winPct = (cp) => { const c = Math.max(-1000, Math.min(1000, cp)); return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1); };
// centipawn after-eval that makes the mover (white) lose exactly `loss` win% from `before`
function afterForLoss(before, loss) {
    let lo = -1000, hi = 1000;
    for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (winPct(before) - winPct(mid) > loss) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
}
const analyze = (fen, opts = {}) => { E.fen(fen); E.set('__o', { nodes: 60000, multiPv: 3, ...opts }); return E.get(`ChessAI.analyze(${STATE}, __o, [])`); };
const threats = (fen, opts = {}) => { E.fen(fen); E.set('__o', { nodes: 40000, ...opts }); return E.get(`ChessAI.threats(${STATE}, __o, [])`); };
function legalSet() {
    const out = new Set();
    for (const m of E.get('getAllLegalMoves(currentPlayer)')) { if (m.isPromotion) for (const p of 'QRBN') out.add(uci({ ...m, promotionPiece: p })); else out.add(uci(m)); }
    return out;
}

describe('v6 engine analysis (coach)', { skip: !has && 'analysis API not present' }, () => {
    test('classifyMove: Lichess thresholds 2/10/20/30 win%, just below and above each boundary', () => {
        const cases = [[0.5, 'best'], [2.5, 'good'], [9.5, 'good'], [10.5, 'inaccuracy'], [19.5, 'inaccuracy'], [20.5, 'mistake'], [29.5, 'mistake'], [30.5, 'blunder'], [60, 'blunder']];
        for (const before of [0, 150, -200]) {
            for (const [loss, want] of cases) {
                if (winPct(before) - loss < winPct(-1000) + 0.5) continue; // not reachable inside the clamp
                const after = afterForLoss(before, loss);
                assert.equal(E.run(`ChessAI.classifyMove(${before}, ${after}, 'w')`), want, `white before ${before} loses ${loss}%`);
                // the same move seen from Black: mirrored evals
                assert.equal(E.run(`ChessAI.classifyMove(${-before}, ${-after}, 'b')`), want, `black before ${-before} loses ${loss}%`);
            }
        }
    });

    test('classifyMove: improving or keeping the eval is best; mates clamp at +/-1000 cp; accepts analyze() objects', () => {
        assert.equal(E.run("ChessAI.classifyMove(0, 300, 'w')"), 'best');
        assert.equal(E.run("ChessAI.classifyMove(0, -300, 'b')"), 'best');
        assert.equal(E.run("ChessAI.classifyMove(5000, 1500, 'w')"), 'best', 'both beyond the clamp: still winning');
        assert.equal(E.run("ChessAI.classifyMove(800, -800, 'w')"), 'blunder');
        assert.equal(E.run("ChessAI.classifyMove({ eval: 100 }, { eval: -400 }, 'w')"), 'blunder');
        assert.equal(E.run("ChessAI.classifyMove(NaN, undefined, 'w')"), 'best', 'garbage -> no loss');
    });

    test('analyze: multi-PV alternatives sorted for the side to move, legal moves, White-POV evals', () => {
        for (const [fen, stm] of [['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 'w'], ['r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 4', 'b']]) {
            const a = analyze(fen);
            assert.equal(a.alternatives.length, 3);
            E.fen(fen);
            const legal = legalSet();
            for (const alt of a.alternatives) assert.ok(legal.has(uci(alt.move)), `legal ${uci(alt.move)}`);
            assert.deepEqual(a.bestMove, a.alternatives[0].move);
            assert.equal(a.eval, a.alternatives[0].eval);
            const evals = a.alternatives.map((x) => x.eval);
            const sorted = [...evals].sort((x, y) => (stm === 'w' ? y - x : x - y));
            assert.deepEqual(evals, sorted, `${stm}: best first from the mover's view`);
            assert.ok(a.nodes <= 60000 + 1, `nodes ${a.nodes}`);
        }
    });

    test('analyze: winning material is a big White-POV eval; mate in 1 reported with mate; terminal positions', () => {
        let a = analyze('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1');
        assert.equal(uci(a.bestMove), 'd2d5');
        assert.ok(a.eval > 300, `eval ${a.eval}`);
        a = analyze('4k3/8/8/3Q4/8/8/3r4/4K3 b - - 0 1');
        assert.equal(uci(a.bestMove), 'd2d5');
        assert.ok(a.eval < -300, `black winning -> negative White-POV eval ${a.eval}`);
        a = analyze('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
        assert.equal(uci(a.bestMove), 'a1a8');
        assert.equal(a.mate, 1, `mate ${a.mate}`);
        a = analyze('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
        assert.equal(a.terminal, 'checkmate');
        assert.equal(a.bestMove, null);
        a = analyze('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
        assert.equal(a.terminal, 'stalemate');
        assert.equal(a.eval, 0);
    });

    test('analyze is deterministic for a fixed input (same nodes, same lines)', () => {
        const fen = 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8';
        assert.deepEqual(analyze(fen), analyze(fen));
    });

    test('threats: a hanging queen shows up as a capture threat; in check -> none; quiet start -> none', () => {
        let t = threats('4k3/8/8/3q4/8/8/3R4/4K3 b - - 0 1'); // black to move: white threatens Rxd5
        assert.ok(t.threats.some((x) => uci(x.move) === 'd2d5' && x.motif === 'capture' && x.gain >= 500), JSON.stringify(t.threats));
        t = threats('6k1/5ppp/8/8/8/8/5PPP/R5K1 b - - 0 1'); // white threatens Ra8#
        assert.ok(t.threats.some((x) => x.motif === 'mate' && x.mate === 1), JSON.stringify(t.threats));
        t = threats('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1'.replace('3r4', '4r3')); // white in check
        if (t.inCheck) assert.deepEqual(t.threats, []);
        t = threats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        assert.deepEqual(t.threats, [], 'no threats at the start');
    });
});

// requestAnalysis / requestThreats via aiClient: worker and main-thread transports, cancel.
function clientWith(transport) {
    let scopeRef = null;
    class FakeWorker {
        constructor() {
            if (transport === 'main') throw new Error('no workers');
            this.onmessage = null;
            const scope = { console, performance: { now: () => 0 }, setTimeout, clearTimeout, postMessage: (d) => setTimeout(() => this.onmessage && this.onmessage({ data: d }), 0) };
            scope.self = scope;
            scope.importScripts = (...f) => { for (const x of f) vm.runInContext(source(x), scope, { filename: x }); };
            vm.createContext(scope);
            vm.runInContext(source('aiWorker.js'), scope, { filename: 'aiWorker.js' });
            scopeRef = scope;
        }
        postMessage(d) { setTimeout(() => scopeRef.self.onmessage({ data: d }), 0); }
        terminate() {}
        addEventListener() {}
    }
    return loadEngine({ client: true, globals: { Worker: FakeWorker, performance: { now: () => 0 } } });
}

describe('v6 requestAnalysis / requestThreats (aiClient)', { skip: !has && 'analysis API not present' }, () => {
    for (const transport of ['worker', 'main']) {
        test(`${transport}: analysis and threats resolve with engine results; cancel resolves null`, async () => {
            const C = clientWith(transport);
            C.fen('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1');
            C.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
            const a = await C.run('requestAnalysis(getCurrentGameStateSnapshot(), { nodes: 20000, multiPv: 2 }).promise');
            assert.equal(uci(a.bestMove), 'd2d5');
            assert.equal(a.alternatives.length, 2);
            C.fen('4k3/8/8/3q4/8/8/3R4/4K3 b - - 0 1');
            const t = await C.run('requestThreats(getCurrentGameStateSnapshot(), { nodes: 20000 }).promise');
            assert.ok(t.threats.some((x) => uci(x.move) === 'd2d5'));
            const c = await C.run('(() => { const h = requestAnalysis(getCurrentGameStateSnapshot(), { nodes: 300000 }); h.cancel(); return h.promise; })()');
            assert.equal(c, null, 'cancelled analysis resolves null');
            assert.equal(C.run("classifyMove(100, -400, 'w')"), 'blunder', 'synchronous classifyMove');
        });
    }
});
