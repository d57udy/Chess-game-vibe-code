'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, uci, GLOBALS_EXPR } = require('../helpers/loadEngine');

// Load-robust: the engine's clock is frozen, so the safety time cap never cuts a search and every
// result depends only on node budgets (device and load independent). The top level's huge budget
// (the real table's 1.2M nodes) is capped for behaviour tests; R keeps the real table for mapping
// checks, and a full-budget top-level search runs in tests/slow (RUN_SLOW).
const FROZEN = { performance: { now: () => 0 } };
const E = loadEngine({ globals: FROZEN });
const R = loadEngine({ globals: FROZEN });
const TEST_TOP_BUDGET = 150000;
const capTop = () => E.run(`ChessAI.setEloTable(ChessAI.DEFAULT_ELO_TABLE.map((r) => ({ ...r, nodeBudget: Math.min(r.nodeBudget, ${TEST_TOP_BUDGET}) })))`);
capTop();

// Best move for a FEN. hist = earlier getBoardPositionString() values ([] = no history).
// Every search is seeded from (fen, elo): weak-ish levels (e.g. 1900 misses a back-rank mate in 1
// about 1% of the time by design) would otherwise draw a fresh Math.random seed per move and make
// these tests flaky. The engine's own distribution is checked statistically in aiEloV5.test.js.
const seedOf = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };
function best(fen, elo, timeMs, hist = []) {
    E.run(`ChessAI.setSeed(${seedOf(`${fen}|${elo}|${hist.join('/')}`)})`);
    E.fen(fen);
    E.set('__args', [elo, timeMs, hist]);
    const t0 = Date.now();
    const move = E.get('calculateBestMove(...__args)');
    return { move, mv: uci(move), ms: Date.now() - t0, info: E.get('ChessAI.getLastSearchInfo()') };
}

// Legal moves of the current position in long algebraic form, promotions expanded to q/r/b/n.
function legalUci() {
    const out = new Set();
    for (const m of E.get('getAllLegalMoves(currentPlayer)')) {
        if (m.isPromotion) for (const p of 'QRBN') out.add(uci({ ...m, promotionPiece: p }));
        else out.add(uci(m));
    }
    return out;
}

// Deterministic PRNG for reproducible random playouts.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

describe('tactics', () => {
    test('white mate in 1 (back rank Ra8#) at several strengths', () => {
        for (const elo of [1900, 2100, 2500]) {
            assert.equal(best('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', elo).mv, 'a1a8', `ELO ${elo}`);
        }
    });

    test('black mate in 1 (Ra1#)', () => {
        assert.equal(best('r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1', 2500).mv, 'a8a1');
    });

    test('mate in 2 (Ra6 with b-pawn net)', () => {
        const r = best('kbK5/pp6/1P6/8/8/8/8/R7 w - - 0 1', 2500);
        assert.equal(r.mv, 'a1a6');
        assert.ok(r.info.score > E.run('ChessAI.MATE') - 10, 'reports a mate score');
    });

    test('mate in 2 (Nf6+ gxf6 Bxf7#)', () => {
        assert.equal(best('r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 10', 2500).mv, 'd5f6');
    });

    test('black promotes b1=Q at all deterministic strengths', () => {
        for (const elo of [1900, 2100, 2500]) {
            assert.equal(best('8/8/8/8/8/k7/1p6/7K b - - 0 1', elo).mv, 'b2b1q', `ELO ${elo}`);
        }
    });

    test('recaptures a queen instead of leaving it (Kxd1 / Nxd1)', () => {
        const r = best('rnb1kbnr/pppp1ppp/8/4p3/3P4/2N5/PPP1PPPP/R1BqKBNR w KQkq - 0 3', 2000);
        assert.ok(['e1d1', 'c3d1'].includes(r.mv), r.mv);
    });

    test('does not leave its queen hanging to a pawn', () => {
        // White queen on d4 is attacked by the c5 pawn.
        const fen = 'rnbqkbnr/pp1ppppp/8/2p5/3Q4/8/PPP1PPPP/RNB1KBNR w KQkq - 0 3';
        for (let i = 0; i < 3; i++) {
            const r = best(fen, 2000);
            E.fen(fen);
            E.set('__m', r.move);
            assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), true);
            // Black's best reply must not win the queen.
            E.set('__args', [2500, 400, []]);
            const reply = E.get('calculateBestMove(...__args)');
            E.set('__m', reply);
            E.run('ChessAI.applyMoveToGlobals(__m)');
            assert.equal(E.run('board.flat().includes("Q")'), true, `after ${r.mv} ${uci(reply)}`);
        }
    });

    test('a lost position still returns a legal move', () => {
        for (const fen of ['k7/8/1K6/8/8/8/8/7R b - - 0 1', '7k/p7/6K1/8/8/8/8/R7 b - - 0 1']) {
            const r = best(fen, 2500, 500);
            E.fen(fen);
            assert.ok(legalUci().has(r.mv), `${fen}: ${r.mv}`);
        }
    });

    test('returns null when there is no legal move (mate or stalemate)', () => {
        assert.equal(best('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 1200).move, null);
        assert.equal(best('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 2500).move, null);
    });
});

describe('draw awareness', () => {
    // Root scores of the last search keyed by long algebraic move.
    function rootScores(fen, elo, hist, timeMs = 300) {
        const r = best(fen, elo, timeMs, hist);
        E.run('ChessAI.loadFromGlobals()');
        const scores = {};
        for (const x of r.info.scores) scores[uci(E.get(`ChessAI.toGameMove(${x.m})`))] = x.score;
        return { best: r.mv, scores };
    }

    test('winning side avoids a threefold repetition; one earlier occurrence is not a draw', () => {
        const repeated = '6k1/8/8/8/8/8/Q7/6K1 b - -'; // after Qa1-a2
        let r = rootScores('6k1/8/8/8/8/8/8/Q5K1 w - - 10 40', 2500, [repeated, 'x', repeated, 'y']);
        assert.equal(r.scores.a1a2, 0);
        assert.notEqual(r.best, 'a1a2');
        r = rootScores('6k1/8/8/8/8/8/8/Q5K1 w - - 10 40', 2500, [repeated, 'x']);
        assert.ok(r.scores.a1a2 > 0);
    });

    test('losing side steers into a repetition', () => {
        const repeated = '5k2/8/8/8/8/8/8/Q5K1 w - -';
        const r = rootScores('6k1/8/8/8/8/8/8/Q5K1 b - - 10 40', 2500, [repeated, 'a', repeated, 'b']);
        assert.equal(r.best, 'g8f8');
    });

    test('50-move rule: quiet moves at halfmove 99 score as draws, a capture does not', () => {
        const r = rootScores('6k1/8/8/8/8/8/r7/Q5K1 w - - 99 80', 2500, []);
        for (const [mv, score] of Object.entries(r.scores)) if (mv !== 'a1a2') assert.equal(score, 0, mv);
        assert.equal(r.best, 'a1a2');
    });
});

describe('robustness', () => {
    test('never returns an illegal move in random playout positions; generators agree', () => {
        const rand = mulberry32(12345);
        const elos = [300, 700, 1200, 1600, 2000, 2500];
        let checked = 0;
        for (let game = 0; game < 8; game++) {
            E.fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
            for (let ply = 0; ply < 80; ply++) {
                const legal = E.get('getAllLegalMoves(currentPlayer)');
                if (legal.length === 0) break;
                if (ply % 10 === 5) {
                    // Engine and gameLogic.js generators agree on this position.
                    E.run('ChessAI.loadFromGlobals()');
                    const engineMoves = new Set(E.get('ChessAI.legalMoves().map(m => ChessAI.toGameMove(m))').map(uci));
                    assert.deepEqual([...engineMoves].sort(), [...legalUci()].sort());
                    // The chosen move is legal (short budget; low ELOs exercise the random-move path).
                    E.set('__args', [elos[checked % elos.length], 25, []]);
                    const before = E.run(GLOBALS_EXPR);
                    const move = E.get('calculateBestMove(...__args)');
                    assert.equal(E.run(GLOBALS_EXPR), before, 'globals untouched');
                    assert.ok(engineMoves.has(uci(move)), `illegal ${uci(move)} in ${E.run('getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget })')}`);
                    checked++;
                }
                const m = legal[Math.floor(rand() * legal.length)];
                if (m.isPromotion) m.promotionPiece = 'QRBN'[Math.floor(rand() * 4)];
                E.set('__m', m);
                assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), true);
            }
        }
        assert.ok(checked >= 30, `checked ${checked} positions`);
    });

    test('Zobrist hash stays consistent through make/unmake (depth 3)', () => {
        E.run(`function __hashPerft(d) {
            if (!ChessAI.hashIsConsistent()) throw new Error('hash mismatch');
            if (d === 0) return 1;
            let n = 0;
            for (const m of ChessAI.legalMoves()) { ChessAI.makeMove(m); n += __hashPerft(d - 1); ChessAI.unmakeMove(); }
            return n;
        }`);
        const cases = [
            ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 97862],
            ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', 9467],
            ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 2812],
        ];
        for (const [fen, nodes] of cases) {
            E.fen(fen);
            E.run('ChessAI.loadFromGlobals()');
            assert.equal(E.run('__hashPerft(3)'), nodes);
        }
    });

    test('calculateBestMove does not mutate the gameLogic.js globals', () => {
        E.fen('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4');
        E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
        const before = E.run(GLOBALS_EXPR);
        E.run('calculateBestMove(2500, 300)'); // history defaults to gameHistory
        E.run('calculateBestMove(300)');
        assert.equal(E.run(GLOBALS_EXPR), before);
    });

    test('applyMoveToGlobals rejects illegal moves', () => {
        E.fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        const before = E.run(GLOBALS_EXPR);
        E.set('__m', { from: { row: 6, col: 4 }, to: { row: 3, col: 4 } }); // e2e5
        assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), false);
        assert.equal(E.run(GLOBALS_EXPR), before);
    });
});

describe('strength scaling and time budget', () => {
    const KEYS = ['nodeBudget', 'maxDepth', 'qsDepth', 'timeCapMs', 'noiseCp', 'blunderChance', 'blindDepth', 'missCaptureChance', 'missQuietChance', 'naturalCp'];

    test('eloParams: budget and depth grow with ELO, weakness shrinks', () => {
        let prev = null;
        for (let elo = -300; elo <= 2500; elo += 50) {
            const p = E.get(`ChessAI.eloParams(${elo})`);
            for (const k of KEYS) assert.ok(Number.isFinite(p[k]), `ELO ${elo} ${k}`);
            if (prev) {
                assert.ok(p.nodeBudget >= prev.nodeBudget && p.maxDepth >= prev.maxDepth && p.qsDepth >= prev.qsDepth, `ELO ${elo}`);
                for (const k of ['noiseCp', 'blunderChance', 'missCaptureChance', 'missQuietChance', 'naturalCp']) assert.ok(p[k] <= prev[k], `ELO ${elo} ${k}`);
            }
            prev = p;
        }
        assert.deepEqual(E.get('ChessAI.eloParams(9999)'), E.get('ChessAI.eloParams(2500)'));
        assert.deepEqual(E.get('ChessAI.eloParams(-5000)'), E.get('ChessAI.eloParams(400)'));
        assert.deepEqual(E.get('ChessAI.eloParams(undefined)'), E.get('ChessAI.eloParams(1200)'));
    });

    test('Max level and hint: real budgets (top row and hintParams), no weakness, budget respected, stopped by nodes or depth', () => {
        const table = R.get('ChessAI.getEloTable()');
        const top = table[table.length - 1];
        const maxP = R.get(`ChessAI.eloParams(${top.elo})`);
        assert.deepEqual(R.get('ChessAI.eloParams(9999)'), maxP, 'above the table clamps to the top row');
        assert.equal(maxP.nodeBudget, top.nodeBudget);
        assert.ok(maxP.nodeBudget >= 1000000, `top level budget ${maxP.nodeBudget}`);
        for (const k of ['noiseCp', 'blunderChance', 'missCaptureChance', 'missQuietChance', 'naturalCp']) assert.equal(maxP[k], 0, `top ${k}`);
        assert.ok(maxP.maxDepth >= 30 && maxP.qsDepth >= 99);
        const hint = R.get('ChessAI.hintParams()');
        assert.equal(hint.nodeBudget, 300000, 'hint budget');
        assert.ok(hint.nodeBudget >= R.get('ChessAI.eloParams(2300)').nodeBudget, 'hint at least as strong as slider 2300');
        assert.ok(hint.timeCapMs >= 1000, `hint safety cap ${hint.timeCapMs}`);
        // A real hint search (frozen clock: the cap cannot interfere, so this is deterministic)
        R.fen('r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8');
        assert.ok(R.get('calculateBestMove(400, undefined, [], { hint: true })'), 'hint move');
        const hi = R.get('ChessAI.getLastSearchInfo()');
        assert.equal(hi.params.nodeBudget, hint.nodeBudget, 'hint ignores the slider');
        assert.ok(hi.nodes <= hint.nodeBudget + 1, `hint nodes ${hi.nodes}`);
        assert.ok(['nodes', 'depth', 'forced'].includes(hi.stoppedBy), `hint stopped by ${hi.stoppedBy}`);
        assert.ok(hi.depth >= 6, `hint depth ${hi.depth}`);
    });

    test('an explicit timeMs caps the search time (simulated clock)', () => {
        let t = 0;
        const T = loadEngine({ globals: { performance: { now: () => (t += 10) } } }); // every clock read = 10 ms
        T.run('ChessAI.setEloTable([{ elo: 2500, nodeBudget: 1e9, maxDepth: 64 }])');
        T.fen('r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8');
        const mv = T.get('calculateBestMove(2500, 300, [])');
        const info = T.get('ChessAI.getLastSearchInfo()');
        assert.ok(mv, 'still returns a move');
        assert.equal(info.stoppedBy, 'time');
        assert.equal(info.params.timeCapMs, 300);
    });
});

describe('v5: node budget, seed, weakness model', () => {
    const FENS = [
        'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
        'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8',
        '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
    ];
    // Move + node count for a fixed seed via searchWithParams (no time cap pressure).
    function seeded(fen, params) {
        E.fen(fen);
        E.set('__p', params);
        const move = E.get('ChessAI.searchWithParams({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber }, __p, [])');
        const info = E.get('ChessAI.getLastSearchInfo()');
        return `${uci(move)}/${info.nodes}/${info.depth}`;
    }

    test('same seed gives the same move and node count at every level', () => {
        for (const elo of [300, 800, 1200, 1700, 2200, 2500]) {
            const p = { ...E.get(`ChessAI.eloParams(${elo})`), seed: 42 };
            for (const fen of FENS) assert.equal(seeded(fen, p), seeded(fen, p), `ELO ${elo} ${fen}`);
        }
    });

    test('setSeed makes a sequence of moves reproducible', () => {
        const run = () => {
            E.run('ChessAI.setSeed(99)');
            return FENS.map((f) => { E.fen(f); return uci(E.get('calculateBestMove(500, undefined, [])')); }).join(' ');
        };
        try { assert.equal(run(), run()); } finally { E.run('ChessAI.setSeed(null)'); }
    });

    test('node budget is respected (depth 1 always completes)', () => {
        for (const nodeBudget of [5000, 20000, 80000]) {
            for (const fen of FENS) {
                const [, nodes] = seeded(fen, { nodeBudget, maxDepth: 64, seed: 1 }).split('/');
                assert.ok(+nodes <= nodeBudget + 1, `${nodes} > ${nodeBudget}`);
            }
        }
    });

    test('setEloTable injects a mapping; invalid tables are rejected; null restores the default', () => {
        const def = E.get('ChessAI.eloParams(1000)');
        assert.equal(E.run('ChessAI.setEloTable("nope")'), false);
        assert.equal(E.run('ChessAI.setEloTable([])'), false);
        assert.equal(E.run('ChessAI.setEloTable([{ elo: 2000, nodeBudget: 8000, noiseCp: 0 }, { elo: 1000, nodeBudget: 2000, noiseCp: 50 }])'), true);
        try {
            const mid = E.get('ChessAI.eloParams(1500)');
            assert.equal(mid.nodeBudget, 4000); // geometric between rows
            assert.equal(mid.noiseCp, 25);
            assert.equal(E.get('ChessAI.eloParams(300)').nodeBudget, 2000);
        } finally {
            capTop(); // the default table (budgets capped for these tests)
        }
        assert.deepEqual(E.get('ChessAI.eloParams(1000)'), def);
    });

    test('weak levels: legal moves with every weakness maxed, never crash', () => {
        const p = { nodeBudget: 300, maxDepth: 2, qsDepth: 0, noiseCp: 300, blunderChance: 1, blindDepth: 1, missCaptureChance: 1, missQuietChance: 1, naturalCp: 200 };
        for (let seed = 0; seed < 20; seed++) {
            for (const fen of FENS.concat(['k7/8/1K6/8/8/8/8/7R b - - 0 1', '4k3/8/8/8/8/8/3q4/4K3 w - - 0 1'])) {
                const mv = seeded(fen, { ...p, seed }).split('/')[0];
                E.fen(fen);
                assert.ok(legalUci().has(mv), `${fen}: ${mv}`);
            }
        }
    });

    test('careless moves with blindDepth >= 1 still see a mate in 1 (blindDepth 0 may miss it)', () => {
        for (let seed = 0; seed < 10; seed++) {
            const p = { nodeBudget: 2000, maxDepth: 1, blunderChance: 1, blindDepth: 1, seed };
            assert.equal(seeded('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', p).split('/')[0], 'a1a8', `seed ${seed}`);
        }
    });

    test('low levels hang material more often than high levels', () => {
        // White to move; the knight on e5 is attacked by the d6 pawn. Count how often it is lost.
        const fen = 'rnbqkb1r/ppp2ppp/3p1n2/4N3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 4';
        const keeps = (elo) => {
            let ok = 0;
            for (let seed = 0; seed < 40; seed++) {
                const mv = seeded(fen, { ...E.get(`ChessAI.eloParams(${elo})`), seed }).split('/')[0];
                if (mv.startsWith('e5')) ok++;
            }
            return ok;
        };
        const low = keeps(300), high = keeps(2000);
        assert.ok(high >= 38, `ELO 2000 saved the knight ${high}/40`);
        assert.ok(low < high, `ELO 300 saved it ${low}/40, ELO 2000 ${high}/40`);
    });
});
