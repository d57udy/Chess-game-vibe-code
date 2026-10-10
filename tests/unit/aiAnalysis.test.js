'use strict';
// v6 coach engine API: ChessAI.analyze / threats / classifyMove (aiPlayer.js), the worker protocol
// (aiWorker.js kind: 'analysis'|'threats') and requestAnalysis / requestThreats / classifyMove
// (aiClient.js, main-thread fallback here since node has no Worker).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadEngine, uci } = require('../helpers/loadEngine');

const ROOT = path.resolve(__dirname, '..', '..');
const ST = '({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber })';
const E = loadEngine();

function analyze(fen, opts = { nodes: 60000, multiPv: 3 }) {
    E.fen(fen);
    E.set('__o', opts);
    return E.get(`ChessAI.analyze(${ST}, __o, [])`);
}
function threats(fen, opts = { nodes: 60000 }) {
    E.fen(fen);
    E.set('__o', opts);
    return E.get(`ChessAI.threats(${ST}, __o, [])`);
}
// Plays a list of game moves from fen; returns false if one is illegal.
function legalLine(fen, moves) {
    E.fen(fen);
    for (const m of moves) {
        E.set('__m', m);
        if (!E.run('ChessAI.applyMoveToGlobals(__m)')) return false;
    }
    return true;
}

const ITALIAN = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
const SCHOLAR = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 3 3';

describe('ChessAI.analyze', () => {
    test('shape, multiPv lines in order for the side to move, legal pvs', () => {
        for (const fen of [ITALIAN, SCHOLAR]) {
            const a = analyze(fen);
            assert.equal(a.alternatives.length, 3);
            assert.equal(uci(a.bestMove), uci(a.alternatives[0].move));
            assert.equal(a.eval, a.alternatives[0].eval);
            const sign = fen.split(' ')[1] === 'w' ? 1 : -1; // evals are White's point of view
            for (let i = 1; i < 3; i++) assert.ok(sign * a.alternatives[i - 1].eval >= sign * a.alternatives[i].eval, `${fen} order`);
            for (const alt of a.alternatives) {
                assert.ok(alt.pv.length >= 1 && uci(alt.pv[0]) === uci(alt.move));
                assert.ok(legalLine(fen, alt.pv), `legal pv ${alt.pv.map(uci).join(' ')}`);
            }
            assert.ok(a.depth >= 4 && a.nodes <= 60001 && a.terminal === null);
        }
    });

    test('scholar position: Black must stop Qxf7#; it finds a defence, not a6', () => {
        const a = analyze(SCHOLAR);
        assert.ok(!['a7a6', 'h7h6'].includes(uci(a.bestMove)), uci(a.bestMove));
        assert.equal(a.mate, null);
    });

    test('mates: mate in one for White, mated and stalemate terminals', () => {
        const m = analyze('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
        assert.equal(uci(m.bestMove), 'a1a8');
        assert.equal(m.mate, 1);
        assert.ok(m.eval > 99000);
        const b = analyze('r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1');
        assert.equal(uci(b.bestMove), 'a8a1');
        assert.equal(b.mate, -1); // Black mates: negative from White's point of view
        const mated = analyze('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
        assert.equal(mated.terminal, 'checkmate');
        assert.equal(mated.bestMove, null);
        assert.ok(mated.eval < -99000);
        const stale = analyze('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
        assert.equal(stale.terminal, 'stalemate');
        assert.equal(stale.eval, 0);
    });

    test('deterministic: same result twice, and after unrelated searches', () => {
        const a1 = analyze(ITALIAN);
        analyze(SCHOLAR, { nodes: 30000, multiPv: 5 });
        E.fen(SCHOLAR);
        E.run('calculateBestMove(900, undefined, [])');
        const a2 = analyze(ITALIAN);
        assert.deepEqual(a2, a1);
    });

    test('node budget and multiPv are respected (1..8)', () => {
        for (const [nodes, multiPv] of [[5000, 1], [20000, 8], [100000, 2]]) {
            const a = analyze(ITALIAN, { nodes, multiPv });
            assert.ok(a.nodes <= nodes + 1, `${a.nodes} > ${nodes}`);
            assert.equal(a.alternatives.length, multiPv);
        }
        assert.equal(analyze(ITALIAN, { nodes: 5000, multiPv: 99 }).alternatives.length, 8);
    });

    test('does not touch the gameLogic globals', () => {
        E.fen(ITALIAN);
        const before = E.run('JSON.stringify(' + ST + ')');
        E.run(`ChessAI.analyze(${ST}, { nodes: 20000 }, [])`);
        E.run(`ChessAI.threats(${ST}, { nodes: 20000 }, [])`);
        assert.equal(E.run('JSON.stringify(' + ST + ')'), before);
    });
});

describe('ChessAI.threats', () => {
    test('scholar position (Black to move): White threatens Qxf7 mate', () => {
        const t = threats(SCHOLAR);
        assert.equal(t.inCheck, false);
        assert.equal(uci(t.threats[0].move), 'f3f7');
        assert.equal(t.threats[0].motif, 'mate');
        assert.equal(t.threats[0].mate, 1);
    });

    test('a hanging knight: the capture threat with its gain', () => {
        const t = threats('rnbqkbnr/pppp1ppp/8/4p3/3N4/8/PPPPPPPP/RNBQKB1R w KQkq - 0 1');
        const cap = t.threats.find((x) => uci(x.move) === 'e5d4');
        assert.ok(cap, JSON.stringify(t.threats.map((x) => uci(x.move))));
        assert.equal(cap.motif, 'capture');
        assert.ok(cap.gain >= 200, `gain ${cap.gain}`);
    });

    test('a knight fork threat (Nc2+ wins the a1 rook)', () => {
        const t = threats('r1bqkbnr/pppp1ppp/8/4p2Q/1n2P3/8/PP1P1PPP/RNB1KBNR w KQkq - 0 1');
        const fork = t.threats.find((x) => uci(x.move) === 'b4c2');
        assert.ok(fork, JSON.stringify(t.threats.map((x) => uci(x.move) + ':' + x.motif)));
        assert.equal(fork.motif, 'fork');
    });

    test('quiet start position: no threats; in check: none (inCheck true)', () => {
        assert.deepEqual(threats('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1').threats, []);
        const c = threats('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1');
        assert.deepEqual(c, { threats: [], inCheck: true });
    });
});

describe('classifyMove (Lichess-style win% loss)', () => {
    const win = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);
    test('thresholds 2 / 10 / 20 / 30 win% for best / good / inaccuracy / mistake / blunder', () => {
        assert.deepEqual(E.get('ChessAI.CLASSIFY_THRESHOLDS'), { best: 2, good: 10, inaccuracy: 20, mistake: 30 });
        assert.ok(Math.abs(E.get('ChessAI.winPercent(150)') - win(150)) < 1e-9);
        const cls = (b, a, s) => E.get(`ChessAI.classifyMove(${b}, ${a}, '${s}')`);
        assert.equal(cls(30, 25, 'w'), 'best');
        assert.equal(cls(30, -40, 'w'), 'good');
        assert.equal(cls(30, -120, 'w'), 'inaccuracy');
        assert.equal(cls(30, -230, 'w'), 'mistake');
        assert.equal(cls(30, -350, 'w'), 'blunder');
        assert.equal(cls(-30, 350, 'b'), 'blunder'); // Black's view is mirrored
        assert.equal(cls(-30, -400, 'b'), 'best'); // Black improving is never a mistake
        assert.equal(cls(800, 99990, 'w'), 'best'); // mates are capped like big scores
        assert.equal(cls(99990, 300, 'w'), 'mistake'); // a won mate turned into +3: win% 97.6 -> 75.1
        assert.equal(cls(5000, 3000, 'w'), 'best'); // still totally winning
        // Accepts analyze() results too.
        assert.equal(E.get(`ChessAI.classifyMove({ eval: 30 }, { eval: -350 }, 'w')`), 'blunder');
    });
});

describe('worker protocol (aiWorker.js kind: analysis | threats)', () => {
    test('posts { id, result } for coach requests and { id, move } for moves', () => {
        const posted = [];
        const scope = { console: { log() {}, warn() {}, error() {} }, performance, setTimeout, clearTimeout };
        scope.self = scope;
        scope.postMessage = (d) => posted.push(JSON.parse(JSON.stringify(d)));
        vm.createContext(scope);
        scope.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f }));
        vm.runInContext(fs.readFileSync(path.join(ROOT, 'aiWorker.js'), 'utf8'), scope, { filename: 'aiWorker.js' });
        E.fen(SCHOLAR);
        const state = { ...E.get(ST), positionHistory: [] };
        scope.onmessage({ data: { id: 1, kind: 'analysis', state, opts: { nodes: 20000, multiPv: 2 } } });
        scope.onmessage({ data: { id: 2, kind: 'threats', state, opts: { nodes: 20000 } } });
        scope.onmessage({ data: { id: 3, state, elo: 1200 } });
        assert.equal(posted.length, 3);
        assert.equal(posted[0].id, 1);
        assert.equal(posted[0].result.alternatives.length, 2);
        assert.equal(uci(posted[1].result.threats[0].move), 'f3f7');
        assert.equal(posted[2].id, 3);
        assert.ok(posted[2].move && !('result' in posted[2]));
        assert.deepEqual(posted[0].result, E.get(`ChessAI.analyze(${ST}, { nodes: 20000, multiPv: 2 }, [])`));
    });
});

describe('aiClient requestAnalysis / requestThreats / classifyMove (main-thread fallback)', () => {
    const C = loadEngine({ client: true });
    const snapshot = (fen) => { C.fen(fen); return C.get('getCurrentGameStateSnapshot()'); };

    test('analysis and threats resolve with the engine results', async () => {
        C.set('__s', snapshot(SCHOLAR));
        const a = await C.run('requestAnalysis(__s, { nodes: 20000, multiPv: 2 }).promise');
        assert.equal(JSON.parse(JSON.stringify(a)).alternatives.length, 2);
        const t = await C.run('requestThreats(__s, { nodes: 20000 }).promise');
        assert.equal(uci(JSON.parse(JSON.stringify(t)).threats[0].move), 'f3f7');
        assert.equal(C.run("classifyMove(30, -350, 'w')"), 'blunder');
    });

    test('cancel resolves null and never the result; moves still work alongside', async () => {
        C.set('__s', snapshot(ITALIAN));
        C.run('var __h = requestAnalysis(__s, { nodes: 20000 }); __h.cancel();');
        assert.equal(await C.run('__h.promise'), null);
        const m = await C.run('requestAIMove(__s, 1200).promise');
        assert.ok(m && m.from && m.to);
    });
});

describe('coach requests use their own worker (never delay or cancel AI moves)', () => {
    // Browser-like Worker running the real aiWorker.js in its own vm context.
    function makeWorkerClass() {
        const instances = [];
        class FakeWorker {
            constructor(url) {
                assert.equal(url, 'aiWorker.js');
                instances.push(this);
                this.posted = [];
                this.terminated = false;
                const scope = { console: { log() {}, warn() {}, error() {} }, performance, setTimeout, clearTimeout };
                scope.self = scope;
                scope.postMessage = (d) => setTimeout(() => {
                    if (!this.terminated && this.onmessage) this.onmessage({ data: JSON.parse(JSON.stringify(d)) });
                }, 0);
                vm.createContext(scope);
                scope.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), scope, { filename: f }));
                vm.runInContext(fs.readFileSync(path.join(ROOT, 'aiWorker.js'), 'utf8'), scope, { filename: 'aiWorker.js' });
                this.scope = scope;
            }
            postMessage(msg) {
                const data = JSON.parse(JSON.stringify(msg));
                this.posted.push(data);
                setTimeout(() => { if (!this.terminated) this.scope.onmessage({ data }); }, 5);
            }
            terminate() { this.terminated = true; }
        }
        FakeWorker.instances = instances;
        return FakeWorker;
    }

    test('analysis goes to a second worker; cancelling it leaves the move worker and its move alone', async () => {
        const Worker = makeWorkerClass();
        const C = loadEngine({ client: true, globals: { Worker } });
        C.fen(ITALIAN);
        C.set('__s', C.get('getCurrentGameStateSnapshot()'));
        C.run('var __mv = requestAIMove(__s, 1200); var __an = requestAnalysis(__s, { nodes: 20000 });');
        assert.equal(Worker.instances.length, 2);
        const [moveWorker, coachWorker] = Worker.instances;
        assert.equal(moveWorker.posted[0].kind, undefined);
        assert.equal(coachWorker.posted[0].kind, 'analysis');
        C.run('__an.cancel()');
        assert.equal(coachWorker.terminated, true);
        assert.equal(moveWorker.terminated, false);
        const move = await C.run('__mv.promise');
        assert.ok(move && move.from, 'the AI move still arrives');
        assert.equal(await C.run('__an.promise'), null);
        // A new coach request gets a fresh coach worker; threats arrive.
        const t = await C.run('requestThreats(__s, { nodes: 20000 }).promise');
        assert.ok(t && Array.isArray(t.threats));
        assert.equal(Worker.instances.length, 3);
        assert.equal(Worker.instances[2].posted[0].kind, 'threats');
        // Cancelling a move does not touch the coach worker.
        C.run('var __mv2 = requestAIMove(__s, 1200); var __an2 = requestAnalysis(__s, { nodes: 20000 }); __mv2.cancel();');
        assert.equal(Worker.instances[2].terminated, false);
        assert.ok((await C.run('__an2.promise')).bestMove);
    });
});
