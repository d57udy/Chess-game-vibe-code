'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, uci, GLOBALS_EXPR } = require('../helpers/loadEngine');

const E = loadEngine();

// Best move for a FEN. hist = earlier getBoardPositionString() values ([] = no history).
function best(fen, elo, timeMs, hist = []) {
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
    test('eloParams: depth and time grow with ELO, randomness shrinks', () => {
        let prev = null;
        for (let elo = 300; elo <= 2500; elo += 100) {
            const p = E.get(`ChessAI.eloParams(${elo})`);
            if (prev) {
                assert.ok(p.maxDepth >= prev.maxDepth && p.timeMs >= prev.timeMs, `ELO ${elo}`);
                assert.ok(p.noise <= prev.noise && p.randomChance <= prev.randomChance, `ELO ${elo}`);
            }
            prev = p;
        }
        assert.equal(E.get('ChessAI.eloParams(9999)').timeMs, E.get('ChessAI.eloParams(2500)').timeMs);
        assert.equal(E.get('ChessAI.eloParams(-5)').maxDepth, E.get('ChessAI.eloParams(300)').maxDepth);
    });

    test('max ELO stays within its time budget (under 2.5s)', () => {
        const budget = E.get('ChessAI.eloParams(2500)').timeMs;
        assert.ok(budget <= 2000);
        for (const fen of [
            'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8',
            'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
        ]) {
            const r = best(fen, 2500, undefined);
            assert.ok(r.move, 'returns a move');
            assert.ok(r.ms < 2500, `took ${r.ms}ms`);
            assert.ok(r.info.depth >= 4, `depth ${r.info.depth}`);
        }
    });

    test('an explicit time budget (hint: 1500ms) is respected', () => {
        const r = best('r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP1B1PPP/R2QKB1R w KQ - 0 8', 2500, 300);
        assert.ok(r.ms < 800, `took ${r.ms}ms with a 300ms budget`);
        const h = best('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 2500, 1500);
        assert.ok(h.ms < 2000, `took ${h.ms}ms with a 1500ms budget`);
    });
});
