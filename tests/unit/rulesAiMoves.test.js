'use strict';
// Every move the AI hands to the game is a legal move by the independent reference (chess.js), at
// several strengths, through the hand-off the pages use:
//   getCurrentGameStateSnapshot() (aiClient.js) -> structured clone -> aiWorker.js onmessage ->
//   loadGameStateSnapshot + calculateBestMove -> { id, move } -> battle3dApplyMove(from, to, promotion)
// plus the main-thread paths (calculateBestMove on the live globals, requestAIMove without Worker)
// and the coach analysis (bestMove, alternatives and principal variations). Node budgets are capped
// through ChessAI.setEloTable so the file stays fast; each level keeps its own weakness model
// (missed captures, careless "blind" moves, noise), which is where a wrong move would come from.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { source, ROOT } = require('../helpers/loadEngine');
const R = require('../helpers/chessReference');
const { sqName } = R;

const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-corpus.json'), 'utf8'));
const ELOS = [400, 800, 1200, 1600, 2000, 2400];
const NODE_CAP = 1000;
const CAP_BUDGETS = `ChessAI.setEloTable(ChessAI.getEloTable().map(r => ({ ...r, nodeBudget: Math.min(r.nodeBudget, ${NODE_CAP}) })))`;

// Black is in check from the pawn that just double-pushed; taking it en passant is the only legal move
const ONLY_EN_PASSANT = '5BR1/8/8/7k/6Pp/5K2/8/8 b - g3 0 1';
// The king has no move; the four promotions of the g-pawn are the only legal moves
const ONLY_PROMOTIONS_WHITE = '1r6/6P1/8/4k3/8/8/7r/K7 w - - 0 1';
const ONLY_PROMOTIONS_BLACK = 'k7/7R/8/8/4K3/8/6p1/1R6 b - - 0 1';
const { EP_RICH, PROMOTION_RACE } = R;

const G = R.loadGame({ client: true });
G.run(CAP_BUDGETS);

// aiWorker.js in its own vm context with importScripts / postMessage shims (as in aiClient.test.js)
function makeWorker() {
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
    vm.runInContext(CAP_BUDGETS, scope);
    let id = 0;
    return (message) => {
        scope.onmessage({ data: JSON.parse(JSON.stringify({ id: ++id, ...message })) });
        const reply = posted.pop();
        assert.equal(reply.id, id);
        return reply;
    };
}
const askWorker = makeWorker();

const uciOf = (move) => sqName(move.from.row, move.from.col) + sqName(move.to.row, move.to.col) +
    (move.promotionPiece ? move.promotionPiece.toLowerCase() : '');

// The AI's move object against the reference move list of the position; returns the reference move.
function assertLegalAiMove(move, ref, at) {
    assert.ok(move && move.from && move.to, `the AI returned a move, ${at}`);
    const r = ref.get(uciOf(move));
    assert.ok(r, `AI move ${uciOf(move)} is not legal, ${at} (legal: ${[...ref.keys()].join(' ')})`);
    assert.equal(move.piece, r.piece, `piece, ${at}`);
    assert.equal(move.isEnPassant, r.enPassant, `isEnPassant, ${at}`);
    assert.equal(move.isCastling, !!r.castling, `isCastling, ${at}`);
    assert.equal(move.isPromotion, !!r.promotion, `isPromotion, ${at}`);
    assert.equal(move.promotionPiece, r.promotion, `promotionPiece, ${at}`);
    return r;
}

// Applies the AI move the way battle3d/controller.js does and checks the resulting position.
function applyLikeController(move, r, at) {
    G.set('__m', move);
    const ev = G.get("battle3dApplyMove(__m.from, __m.to, __m.promotionPiece || 'Q')");
    assert.equal(G.run('battle3dFen()'), r.fen, `position after the AI move, ${at}`);
    assert.deepEqual(ev.captured && sqName(ev.captured.square.row, ev.captured.square.col), r.capturedSquare, `captured square, ${at}`);
    return ev;
}

describe('AI moves through the worker hand-off are legal by the reference', () => {
    const STARTS = [...R.PLAYOUT_STARTS, R.START_FEN];

    test('seeded AI against AI games at six strengths', (t) => {
        const stats = { moves: 0, enPassant: 0, promotions: 0, castles: 0, captures: 0 };
        ELOS.forEach((elo, i) => {
            const start = STARTS[i % STARTS.length];
            G.load(start);
            const chess = new R.Chess(start);
            const keys = [R.refRepetitionKey(chess)];
            for (let ply = 0; ply < 44; ply++) {
                const ref = R.refMoves(chess);
                if (ref.size === 0 || R.refResult(R.refStatus(chess, keys))) break;
                const at = `ELO ${elo} ply ${ply} (${G.run('battle3dFen()')})`;
                const state = G.get('getCurrentGameStateSnapshot()');
                const { move } = askWorker({ state, elo, seed: 1000 * (i + 1) + ply });
                const r = assertLegalAiMove(move, ref, at);
                applyLikeController(move, r, at);
                chess.move({ from: r.from, to: r.to, promotion: r.promotion ? r.promotion.toLowerCase() : undefined });
                keys.push(R.refRepetitionKey(chess));
                stats.moves++;
                if (r.enPassant) stats.enPassant++;
                if (r.promotion) stats.promotions++;
                if (r.castling) stats.castles++;
                if (r.captured) stats.captures++;
            }
        });
        t.diagnostic(JSON.stringify(stats));
        assert.ok(stats.moves >= 200 && stats.captures >= 30, JSON.stringify(stats));
        assert.ok(stats.enPassant >= 1 && stats.promotions >= 2, JSON.stringify(stats));
    });

    test('en passant as the only legal move is found and applied at every strength', () => {
        assert.deepEqual([...R.refMoves(new R.Chess(ONLY_EN_PASSANT)).keys()], ['h4g3']);
        for (const elo of ELOS) {
            G.load(ONLY_EN_PASSANT);
            const ref = R.refMoves(new R.Chess(ONLY_EN_PASSANT));
            const { move } = askWorker({ state: G.get('getCurrentGameStateSnapshot()'), elo, seed: elo });
            const r = assertLegalAiMove(move, ref, `ELO ${elo}`);
            assert.equal(move.isEnPassant, true);
            const ev = applyLikeController(move, r, `ELO ${elo}`);
            assert.equal(ev.enPassant, true);
            assert.deepEqual(ev.captured, { piece: 'P', square: R.sq('g4') });
            assert.equal(G.run('battle3dFen()'), '5BR1/8/8/7k/8/5Kp1/8/8 w - - 0 2');
        }
    });

    test('promotion as the only legal move comes back with a promotion piece at every strength', () => {
        for (const fen of [ONLY_PROMOTIONS_WHITE, ONLY_PROMOTIONS_BLACK]) {
            const ref = R.refMoves(new R.Chess(fen));
            assert.equal(ref.size, 4);
            assert.ok([...ref.values()].every((r) => r.promotion));
            for (const elo of ELOS) {
                G.load(fen);
                const { move } = askWorker({ state: G.get('getCurrentGameStateSnapshot()'), elo, seed: elo });
                const r = assertLegalAiMove(move, ref, `${fen} ELO ${elo}`);
                assert.ok('QRBN'.includes(move.promotionPiece));
                const ev = applyLikeController(move, r, `${fen} ELO ${elo}`);
                assert.equal(ev.promotion, move.promotionPiece);
            }
        }
    });

    test('a hint request (full strength) in en passant and promotion positions is legal', () => {
        for (const fen of [ONLY_EN_PASSANT, ONLY_PROMOTIONS_WHITE, EP_RICH]) {
            G.load(fen);
            const { move } = askWorker({ state: G.get('getCurrentGameStateSnapshot()'), elo: 1200, hint: true, seed: 5 });
            assertLegalAiMove(move, R.refMoves(new R.Chess(fen)), `hint ${fen}`);
        }
    });
});

describe('AI moves on the main thread are legal by the reference', () => {
    // Corpus positions that offer en passant, castling or a promotion, and the checks and pins
    const positions = CORPUS.positions.filter((p) => /^(en passant|castling|promotion|check|pin|pawn)/.test(p.name));

    test('calculateBestMove on every special-move corpus position at six strengths', () => {
        assert.ok(positions.length >= 60, `${positions.length} positions`);
        let enPassantChosen = 0, promotionsChosen = 0;
        positions.forEach((position, i) => {
            const ref = R.refMoves(new R.Chess(position.fen));
            G.load(position.fen);
            const before = G.run('battle3dFen()');
            for (const elo of ELOS) {
                const move = G.get(`calculateBestMove(${elo}, 0, undefined, { seed: ${i * 10 + elo} })`);
                const r = assertLegalAiMove(move, ref, `${position.fen} ELO ${elo}`);
                if (r.enPassant) enPassantChosen++;
                if (r.promotion) promotionsChosen++;
            }
            assert.equal(G.run('battle3dFen()'), before, 'the search leaves the position alone');
        });
        assert.ok(enPassantChosen >= 10 && promotionsChosen >= 10, `en passant ${enPassantChosen}, promotions ${promotionsChosen}`);
    });

    test('requestAIMove without a Worker (file:// fallback) returns legal moves', async () => {
        assert.equal(G.run('typeof Worker'), 'undefined');
        const cases = [ONLY_EN_PASSANT, ONLY_PROMOTIONS_BLACK, EP_RICH, R.START_FEN];
        const pending = cases.map((fen, i) => {
            G.load(fen);
            return G.run(`requestAIMove(getCurrentGameStateSnapshot(), ${ELOS[i]}, { seed: ${i + 1} }).promise`);
        });
        const moves = await Promise.all(pending);
        moves.forEach((move, i) => assertLegalAiMove(JSON.parse(JSON.stringify(move)), R.refMoves(new R.Chess(cases[i])), cases[i]));
        assert.equal(G.run('battle3dFen()'), cases[cases.length - 1], 'the fallback restores the live globals');
    });
});

describe('the search sees en passant replies', () => {
    // The reported game after 20. b4: Black's best reply is axb3 e.p. (the coach judged 20. b4 here)
    const AFTER_B4 = 'r4rk1/1NQ2ppp/8/3pPB2/pP3P2/7P/P1P5/R1B1K1N1 b - b3 0 20';

    test('analysis of the position after 20. b4: en passant is the main line and costs White evaluation', () => {
        G.load(AFTER_B4);
        const withRight = G.get('getCurrentGameStateSnapshot()');
        const withoutRight = { ...withRight, enPassantTarget: null, positionHistory: [] };
        G.set('__with', withRight);
        G.set('__without', withoutRight);
        const a = G.get('ChessAI.analyze(__with, { nodes: 20000, multiPv: 3 }, [])');
        const b = G.get('ChessAI.analyze(__without, { nodes: 20000, multiPv: 3 }, [])');
        assert.equal(uciOf(a.bestMove), 'a4b3');
        assert.equal(a.bestMove.isEnPassant, true);
        assert.equal(uciOf(a.pv[1]), 'c2b3', 'the line continues with the recapture on b3');
        assert.ok(!b.alternatives.some((x) => x.move.isEnPassant || uciOf(x.move) === 'a4b3'), 'no en passant without the right');
        // White-POV centipawns: the same position is worth less to White when Black may take en passant
        assert.ok(a.eval < b.eval - 50, `with the en passant reply ${a.eval}, without ${b.eval}`);
    });

    test('the top level plays an en passant capture that wins the queen', () => {
        // Black just played d7-d5; exd6 e.p. uncovers the rook on e1 against the queen on e7
        const fen = '4k3/4q3/8/3pP3/8/8/8/4RK2 w - d6 0 1';
        G.load(fen);
        const { move } = askWorker({ state: G.get('getCurrentGameStateSnapshot()'), elo: 2400, seed: 3 });
        const r = assertLegalAiMove(move, R.refMoves(new R.Chess(fen)), fen);
        assert.equal(r.uci, 'e5d6');
    });
});

describe('coach analysis lines are legal by the reference', () => {
    test('bestMove, alternatives and principal variations replay legally', () => {
        const fens = [ONLY_EN_PASSANT, ONLY_PROMOTIONS_WHITE, EP_RICH, PROMOTION_RACE,
            'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3',
            'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
            'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1'];
        let plies = 0;
        for (const fen of fens) {
            G.load(fen);
            const analysis = G.get('ChessAI.analyze(getCurrentGameStateSnapshot(), { nodes: 4000, multiPv: 3 }, [])');
            const ref = R.refMoves(new R.Chess(fen));
            assertLegalAiMove(analysis.bestMove, ref, `bestMove ${fen}`);
            assert.ok(analysis.alternatives.length >= 1);
            for (const alternative of analysis.alternatives) {
                assertLegalAiMove(alternative.move, ref, `alternative ${fen}`);
                const chess = new R.Chess(fen);
                alternative.pv.forEach((move, ply) => {
                    const r = assertLegalAiMove(move, R.refMoves(chess), `pv ply ${ply} of ${uciOf(alternative.move)}, ${fen}`);
                    chess.move({ from: r.from, to: r.to, promotion: r.promotion ? r.promotion.toLowerCase() : undefined });
                    plies++;
                });
            }
        }
        assert.ok(plies >= 40, `${plies} pv plies`);
    });
});
