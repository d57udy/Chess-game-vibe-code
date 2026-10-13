'use strict';
// The differential rules test at volume (skipped by `npm test` unless RUN_SLOW=1): seeded playouts
// in which every ply applies every legal move through battle3dApplyMove and compares it, the
// ChessAI generator and tactics.js with chess.js, and AI games at the real node budgets of the
// levels. The fast versions run in tests/unit/rulesDifferential.test.js and rulesAiMoves.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source } = require('../helpers/loadEngine');
const R = require('../helpers/chessReference');

const skip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';

describe('deep differential playouts', { skip }, () => {
    for (const seed of [0xD1FF, 0xBEEF]) {
        test(`100 games x 200 plies, every legal move applied at every ply (seed ${seed})`, async (t) => {
            const tactics = await R.loadTactics();
            const stats = R.differentialPlayouts({ games: 100, plies: 200, seed, fullEvery: 1, starts: R.PLAYOUT_STARTS, tactics });
            t.diagnostic(JSON.stringify(stats));
            assert.ok(stats.plies > 10000 && stats.fullProbes === stats.positions, JSON.stringify(stats));
            assert.ok(stats.enPassant > 100 && stats.castles > 30 && stats.promotions > 100 && stats.captures > 1500 && stats.undos > 200, JSON.stringify(stats));
            for (const result of ['checkmate', 'stalemate', 'insufficient', 'threefold']) assert.ok(stats.results[result] > 0, `no game ended by ${result}: ${JSON.stringify(stats.results)}`);
        });
    }
});

describe('AI moves at the real node budgets are legal by the reference', { skip }, () => {
    const sqName = R.sqName;
    const uciOf = (move) => sqName(move.from.row, move.from.col) + sqName(move.to.row, move.to.col) + (move.promotionPiece ? move.promotionPiece.toLowerCase() : '');

    test('AI against AI through the worker hand-off, seven strengths x five start positions', (t) => {
        const G = R.loadGame({ client: true });
        const posted = [];
        const scope = {
            console: { log() {}, warn() {}, error: (...a) => { throw new Error('aiWorker: ' + a.map(String).join(' ')); } },
            performance,
            importScripts: (...files) => { for (const f of files) vm.runInContext(source(f), scope, { filename: f }); },
            postMessage: (data) => posted.push(JSON.parse(JSON.stringify(data))),
        };
        scope.self = scope;
        vm.createContext(scope);
        vm.runInContext(source('aiWorker.js'), scope, { filename: 'aiWorker.js' });

        const stats = { moves: 0, enPassant: 0, promotions: 0, underpromotions: 0, castles: 0, captures: 0 };
        // The top level searches 1.2 million nodes a move, so it gets fewer plies
        for (const [elo, plies] of [[400, 80], [800, 80], [1200, 80], [1600, 80], [2000, 60], [2200, 40], [2400, 12]]) {
            R.PLAYOUT_STARTS.forEach((start, s) => {
                G.load(start);
                const chess = new R.Chess(start);
                const keys = [R.refRepetitionKey(chess)];
                for (let ply = 0; ply < plies; ply++) {
                    const ref = R.refMoves(chess);
                    if (ref.size === 0 || R.refResult(R.refStatus(chess, keys))) break;
                    const at = `ELO ${elo} start ${s} ply ${ply} (${G.run('battle3dFen()')})`;
                    scope.onmessage({ data: JSON.parse(JSON.stringify({ id: stats.moves, state: G.get('getCurrentGameStateSnapshot()'), elo, seed: elo * 1000 + s * 100 + ply })) });
                    const { move } = posted.pop();
                    assert.ok(move, `the AI returned a move, ${at}`);
                    const r = ref.get(uciOf(move));
                    assert.ok(r, `AI move ${uciOf(move)} is not legal, ${at}`);
                    assert.deepEqual([move.isEnPassant, move.isCastling, move.isPromotion, move.promotionPiece], [r.enPassant, !!r.castling, !!r.promotion, r.promotion], `flags, ${at}`);
                    G.set('__m', move);
                    G.run("battle3dApplyMove(__m.from, __m.to, __m.promotionPiece || 'Q')");
                    assert.equal(G.run('battle3dFen()'), r.fen, `position after the AI move, ${at}`);
                    chess.move({ from: r.from, to: r.to, promotion: r.promotion ? r.promotion.toLowerCase() : undefined });
                    keys.push(R.refRepetitionKey(chess));
                    stats.moves++;
                    if (r.enPassant) stats.enPassant++;
                    if (r.promotion) stats.promotions++;
                    if (r.promotion && r.promotion !== 'Q') stats.underpromotions++;
                    if (r.castling) stats.castles++;
                    if (r.captured) stats.captures++;
                }
            });
        }
        t.diagnostic(JSON.stringify(stats));
        assert.ok(stats.moves > 1200 && stats.enPassant >= 5 && stats.promotions >= 20 && stats.castles >= 5 && stats.captures > 200, JSON.stringify(stats));
    });
});
