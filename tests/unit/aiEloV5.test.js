'use strict';
// v5 engine checks that complement tests/unit/aiPlayer.test.js: device independence (the same
// seeded search gives the same move whatever the clock speed, as long as the safety cap is not
// hit), legal moves over many random positions at every level, hint mode = full-strength best
// move whatever the slider says, weakness statistics ordered by level, and the hint option
// travelling through requestAIMove -> aiWorker.js / main-thread fallback -> engine.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadEngine, source, uci } = require('../helpers/loadEngine');
const { rng } = require('../helpers/loadBattle3dRules');

const STATE = '({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber })';
// Search with explicit params on a FEN; returns "move/nodes/depth" plus info.
function seeded(E, fen, params) {
    E.fen(fen);
    E.set('__p', params);
    const move = E.get(`ChessAI.searchWithParams(${STATE}, __p, [])`);
    const info = E.get('ChessAI.getLastSearchInfo()');
    return { key: `${uci(move)}/${info.nodes}/${info.depth}`, mv: uci(move), info };
}
function legalSet(E) {
    const out = new Set();
    for (const m of E.get('getAllLegalMoves(currentPlayer)')) {
        if (m.isPromotion) for (const p of 'QRBN') out.add(uci({ ...m, promotionPiece: p }));
        else out.add(uci(m));
    }
    return out;
}
// Random playout positions (FENs via gameLogic globals), reproducible.
function randomPositions(E, n, seed) {
    const rand = rng(seed);
    const fens = [];
    E.run(`parseFen(INITIAL_BOARD_FEN)`);
    const fenExpr = `getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) + ' ' + halfmoveClock + ' ' + fullmoveNumber`;
    while (fens.length < n) {
        E.run('parseFen(INITIAL_BOARD_FEN)');
        const plies = 4 + Math.floor(rand() * 70);
        for (let i = 0; i < plies; i++) {
            const moves = E.get('getAllLegalMoves(currentPlayer)');
            if (!moves.length) break;
            E.set('__m', moves[Math.floor(rand() * moves.length)]);
            E.run('ChessAI.applyMoveToGlobals(__m)');
        }
        if (E.get('getAllLegalMoves(currentPlayer)').length) fens.push(E.run(fenExpr));
    }
    return fens;
}

describe('v5 engine: device independence', () => {
    test('same seed and node budget give the same move with a 10x faster or slower clock', () => {
        const fens = [
            'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
            'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8',
            '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
        ];
        const run = (speed) => {
            let t = 0;
            const E = loadEngine({ globals: { performance: { now: () => (t += speed) } } });
            const out = [];
            for (const elo of [300, 1000, 1600, 2100]) {
                const p = { ...E.get(`ChessAI.eloParams(${elo})`), seed: 7, timeCapMs: 1e9 };
                p.nodeBudget = Math.min(p.nodeBudget, 30000);
                for (const f of fens) out.push(seeded(E, f, p).key);
            }
            return out;
        };
        const fast = run(0.001), slow = run(10);
        assert.deepEqual(slow, fast, 'node budget decides, not the clock');
    });

    test('the safety time cap still stops a runaway search (and says so)', () => {
        let t = 0;
        const E = loadEngine({ globals: { performance: { now: () => (t += 50) } } });
        const r = seeded(E, 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8', { nodeBudget: 1e9, maxDepth: 64, timeCapMs: 500, seed: 1 });
        assert.equal(r.info.stoppedBy, 'time');
        assert.ok(r.mv && r.mv !== 'null');
    });
});

describe('v5 engine: legality and hint', () => {
    const E = loadEngine();
    const fens = randomPositions(E, 40, 2024);

    test('legal moves over 40 random positions at every level (seeded)', () => {
        const bad = [];
        for (const [i, fen] of fens.entries()) {
            for (const elo of [300, 700, 1000, 1300, 1600, 1900, 2300, 2500]) {
                const p = { ...E.get(`ChessAI.eloParams(${elo})`), seed: i * 31 + elo };
                p.nodeBudget = Math.min(p.nodeBudget, 3000);
                const r = seeded(E, fen, p);
                E.fen(fen);
                if (!legalSet(E).has(r.mv)) bad.push(`${fen} @${elo}: ${r.mv}`);
            }
        }
        assert.deepEqual(bad, []);
    });

    test('node budget is a real cap at every level (weak levels: depth 1 and blind scoring included)', () => {
        const over = [];
        for (const [i, fen] of fens.entries()) {
            for (const elo of [300, 700, 1000, 1600]) {
                const p = { ...E.get(`ChessAI.eloParams(${elo})`), seed: i * 31 + elo };
                const r = seeded(E, fen, p);
                if (r.info.nodes > p.nodeBudget + 1) over.push(`${elo}: ${r.info.nodes}/${p.nodeBudget}`);
            }
        }
        assert.deepEqual(over, []);
    });

    test('hint params: full strength (no weakness), a real node budget, ignores the slider', () => {
        const h = E.get('ChessAI.hintParams()');
        for (const k of ['noiseCp', 'blunderChance', 'missCaptureChance', 'naturalCp']) assert.equal(h[k], 0, k);
        assert.ok(h.nodeBudget >= 100000, `hint budget ${h.nodeBudget}`);
        assert.ok(h.maxDepth >= 8);
        E.fen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
        E.get('calculateBestMove(300, undefined, [], { hint: true })');
        const info = E.get('ChessAI.getLastSearchInfo()');
        assert.equal(info.params.nodeBudget, h.nodeBudget, 'ELO 300 slider does not weaken a hint');
        assert.equal(info.params.noiseCp, 0);
    });

    test('hint returns the strongest move on a tactics set', () => {
        const set = [
            ['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8'],                       // back-rank mate
            ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'f3f7'], // scholar's mate
            ['4k3/8/8/3q4/8/8/3R4/3RK3 w - - 0 1', 'd2d5'],                           // free queen
            ['1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7b8q'],                            // promote with capture
            ['4k3/8/8/8/8/8/3q4/4K3 w - - 0 1', 'e1d2'],                              // take the checking queen
        ];
        for (const [fen, want] of set) {
            E.fen(fen);
            const mv = uci(E.get('calculateBestMove(300, undefined, [], { hint: true })'));
            assert.equal(mv, want, fen);
        }
    });

    test('v5.1 knobs: qsDepth / missQuietChance in every mapping row, hint at full horizon; monotonic', () => {
        const h = E.get('ChessAI.hintParams()');
        assert.equal(h.qsDepth, 99);
        assert.equal(h.missQuietChance, 0);
        let prev = null;
        for (let elo = 300; elo <= 2500; elo += 100) {
            const p = E.get(`ChessAI.eloParams(${elo})`);
            assert.ok(p.qsDepth >= 0 && p.qsDepth <= 99, `qsDepth ${p.qsDepth}`);
            assert.ok(p.missQuietChance >= 0 && p.missQuietChance <= 1);
            if (prev) assert.ok(p.qsDepth >= prev.qsDepth && p.missQuietChance <= prev.missQuietChance, `ELO ${elo}`);
            prev = p;
        }
        assert.equal(E.run('ChessAI.setEloTable([{ elo: 1000, nodeBudget: 2000, qsDepth: 1.5, missQuietChance: 0.4 }, { elo: 2000, nodeBudget: 8000, qsDepth: 5.5, missQuietChance: 0 }])'), true);
        try {
            const mid = E.get('ChessAI.eloParams(1500)');
            assert.ok(Math.abs(mid.qsDepth - 3.5) < 1e-9, `interpolated qsDepth ${mid.qsDepth}`);
            assert.ok(Math.abs(mid.missQuietChance - 0.2) < 1e-9, `interpolated missQuietChance ${mid.missQuietChance}`);
        } finally { E.run('ChessAI.setEloTable(null)'); }
        const clamp = seeded(E, '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', { nodeBudget: 500, qsDepth: 1e9, missQuietChance: 7, seed: 1 }).info.params;
        assert.ok(clamp.qsDepth <= 99 && clamp.missQuietChance <= 1, JSON.stringify(clamp));
    });

    test('a mate the real search finds is always played, whatever the noise and naturalness', () => {
        const mates = [['6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', 'a1a8'], ['r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4', 'f3f7']];
        for (const [fen, want] of mates) {
            for (let seed = 0; seed < 25; seed++) {
                const mv = seeded(E, fen, { nodeBudget: 4000, maxDepth: 3, noiseCp: 300, naturalCp: 200, seed }).mv;
                assert.equal(mv, want, `${fen} seed ${seed}`);
            }
        }
    });

    test('blindDepth: 0 (static eval) may miss mate in 1; >= 1 careless moves still see it', () => {
        const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
        let missed = 0;
        for (let seed = 0; seed < 30; seed++) {
            // budget large enough to score every root move (a tiny budget can cut the root before the mate)
            if (seeded(E, fen, { nodeBudget: 2000, maxDepth: 1, blunderChance: 1, blindDepth: 0, seed }).mv !== 'a1a8') missed++;
            assert.equal(seeded(E, fen, { nodeBudget: 2000, maxDepth: 1, blunderChance: 1, blindDepth: 1, seed }).mv, 'a1a8', `blindDepth 1 seed ${seed}`);
        }
        assert.ok(missed >= 0, `blindDepth 0 missed mate ${missed}/30`);
    });

    test('mate-in-1 misses are a deliberate low-level weakness: fewer with level, none at the top', () => {
        // Human-like target (elo-human): roughly 0.5-0.75 found at the bottom, near-certain by 1300+.
        const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
        const found = {};
        for (const elo of [300, 700, 1300, 1900, 2500]) {
            let n = 0;
            for (let seed = 0; seed < 40; seed++) if (seeded(E, fen, { ...E.get(`ChessAI.eloParams(${elo})`), seed }).mv === 'a1a8') n++;
            found[elo] = n;
        }
        assert.equal(found[2500], 40, JSON.stringify(found));
        assert.ok(found[1900] >= 39, JSON.stringify(found));
        assert.ok(found[1300] >= 36, JSON.stringify(found));
        assert.ok(found[300] >= 12 && found[300] <= 36, `bottom level finds it sometimes, not always: ${JSON.stringify(found)}`);
        assert.ok(found[300] <= found[700] + 4 && found[700] <= found[1300] + 4, JSON.stringify(found));
    });

    test('ties keep the search choice: promotion b2b1q at 2100 for every seed (regression)', () => {
        for (let seed = 0; seed < 30; seed++) {
            const p = { ...E.get('ChessAI.eloParams(2100)'), seed };
            assert.equal(seeded(E, '8/8/8/8/8/k7/1p6/7K b - - 0 1', p).mv, 'b2b1q', `seed ${seed}`);
        }
    });

    test('legal moves with every v5.1 weakness maxed (qsDepth 0, missQuietChance 1) over random positions', () => {
        const p = { nodeBudget: 600, maxDepth: 2, noiseCp: 300, blunderChance: 1, blindDepth: 0, missCaptureChance: 1, naturalCp: 200, qsDepth: 0, missQuietChance: 1 };
        const bad = [];
        for (const [i, fen] of fens.slice(0, 30).entries()) {
            const r = seeded(E, fen, { ...p, seed: i });
            E.fen(fen);
            if (!legalSet(E).has(r.mv)) bad.push(`${fen}: ${r.mv}`);
            if (r.info.nodes > p.nodeBudget + 1 + legalSet(E).size) bad.push(`${fen}: nodes ${r.info.nodes}`);
        }
        assert.deepEqual(bad, []);
    });

    test('weakness is ordered by level: a free queen is missed more often at 300 than 1000 than 1600; never at 2500', () => {
        const fen = 'rnb1kbnr/pppp1ppp/8/4p1q1/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'; // Nxg5 wins the queen
        const hits = {};
        for (const elo of [300, 1000, 1600, 2500]) {
            let n = 0;
            for (let seed = 0; seed < 40; seed++) {
                const p = { ...E.get(`ChessAI.eloParams(${elo})`), seed };
                p.nodeBudget = Math.min(p.nodeBudget, 8000);
                if (seeded(E, fen, p).mv === 'f3g5') n++;
            }
            hits[elo] = n;
        }
        assert.equal(hits[2500], 40, JSON.stringify(hits));
        assert.ok(hits[300] < hits[1000] || hits[300] < 30, JSON.stringify(hits));
        assert.ok(hits[300] <= hits[1600] && hits[1000] <= hits[2500], JSON.stringify(hits));
        assert.ok(hits[300] < 40, `ELO 300 sometimes misses it: ${JSON.stringify(hits)}`);
    });
});

// --- hint option through aiClient -> worker / main thread -> engine --------------------------------
function workerScope(onPost) {
    const scope = { console, performance, setTimeout, clearTimeout, postMessage: (d) => onPost(d) };
    scope.self = scope;
    scope.importScripts = (...files) => { for (const f of files) vm.runInContext(source(f), scope, { filename: f }); };
    vm.createContext(scope);
    vm.runInContext(source('aiWorker.js'), scope, { filename: 'aiWorker.js' });
    return scope;
}
function clientWith(transport) {
    let workerScopeRef = null;
    class FakeWorker {
        constructor() {
            if (transport === 'main') throw new Error('no workers here');
            this.onmessage = null;
            workerScopeRef = workerScope((data) => setTimeout(() => this.onmessage && this.onmessage({ data }), 0));
        }
        postMessage(data) { setTimeout(() => workerScopeRef.self.onmessage({ data }), 0); }
        terminate() {}
        addEventListener() {}
    }
    const E = loadEngine({ client: true, globals: { Worker: FakeWorker } });
    return { E, engineInfo: () => (transport === 'main' ? E.get('ChessAI.getLastSearchInfo()') : JSON.parse(vm.runInContext('JSON.stringify(ChessAI.getLastSearchInfo())', workerScopeRef))) };
}

describe('v5 hint option end to end (requestAIMove)', () => {
    for (const transport of ['worker', 'main']) {
        test(`${transport}: { hint: true } reaches the engine (hintParams used)`, async () => {
            const C = clientWith(transport);
            C.E.fen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
            C.E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
            const move = await C.E.run('requestAIMove(getCurrentGameStateSnapshot(), 300, { hint: true }).promise');
            assert.ok(move && move.from, 'a move');
            const info = C.engineInfo();
            const hint = C.E.get('ChessAI.hintParams()');
            assert.equal(info.params.nodeBudget, hint.nodeBudget, 'hint node budget, not ELO 300');
            assert.equal(info.params.noiseCp, 0);
        });
    }

    test('worker message carries hint and seed; a seeded request is reproducible; cancel resolves null', async () => {
        const posted = [];
        class SpyWorker {
            constructor() { this.onmessage = null; this.scope = workerScope((data) => setTimeout(() => this.onmessage && this.onmessage({ data }), 0)); }
            postMessage(data) { posted.push(JSON.parse(JSON.stringify(data))); setTimeout(() => this.scope.self.onmessage({ data }), 0); }
            terminate() { this.terminated = true; }
            addEventListener() {}
        }
        const E = loadEngine({ client: true, globals: { Worker: SpyWorker } });
        E.fen('r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8');
        E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
        const m1 = await E.run('requestAIMove(getCurrentGameStateSnapshot(), 900, { seed: 5 }).promise');
        const m2 = await E.run('requestAIMove(getCurrentGameStateSnapshot(), 900, { seed: 5 }).promise');
        assert.equal(uci(m1), uci(m2), 'same seed, same move');
        assert.equal(posted[0].seed, 5);
        await E.run('requestAIMove(getCurrentGameStateSnapshot(), 900, { hint: true }).promise');
        assert.equal(posted[posted.length - 1].hint, true);
        const r = await E.run('(() => { const h = requestAIMove(getCurrentGameStateSnapshot(), 2500, { hint: true }); h.cancel(); return h.promise; })()');
        assert.equal(r, null, 'cancelled hint resolves null');
    });

    test('normal requests still use the ELO mapping through the worker', async () => {
        const C = clientWith('worker');
        C.E.fen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
        C.E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
        const move = await C.E.run('requestAIMove(getCurrentGameStateSnapshot(), 700).promise');
        assert.ok(move && move.from);
        assert.equal(C.engineInfo().params.nodeBudget, C.E.get('ChessAI.eloParams(700)').nodeBudget);
    });
});
