'use strict';
// Differential rules test: the game's three rule implementations against chess.js (test-only
// devDependency, see tests/helpers/chessReference.js).
//   - gameLogic.js generator + battle3d/rules.js battle3dApplyMove: legal move set, generator flags,
//     MoveEvent (captured piece and square, castling rook, promotion, check, mate), SAN, the FEN after
//     every legal move, undo, and the check / mate / stalemate / 50-move / threefold / insufficient
//     material flags;
//   - the ChessAI generator and make/unmake (aiPlayer.js): legal move set, flags, position after
//     makeMove, hash, and unmakeMove;
//   - battle3d/tactics.js legalMoves / applyMove (the coach's motif detector).
// Positions come from a corpus of rule corner cases (tests/fixtures/rules-corpus.json), scripted
// lines and seeded playouts. tests/slow/rulesDifferentialDeep.test.js runs many more playouts.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');
const R = require('../helpers/chessReference');

const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-corpus.json'), 'utf8'));
const G = R.loadGame();
const A = R.loadAi();
let T;
before(async () => { T = await R.loadTactics(); });

// Full comparison of the position loaded in G with the reference; returns the three move lists.
function compareEverything(chess, keys, at) {
    const ref = R.refMoves(chess);
    const probe = G.probe();
    R.compareGamePosition(probe, chess, keys, at, ref);
    const ai = A.probe(probe.fen);
    R.compareAiPosition(ai, chess, at, ref);
    R.compareTacticsPosition(T, probe.fen, chess, at, ref);
    return { ref, probe, game: probe.moves.map((m) => m.uci), ai: ai.moves.map((m) => m.uci) };
}

function assertMoves(lists, must, mustNot, at) {
    for (const [who, moves] of [['chess.js', [...lists.ref.keys()]], ['gameLogic.js', lists.game], ['ChessAI', lists.ai]]) {
        for (const mv of must || []) assert.ok(moves.includes(mv), `${who} must allow ${mv}, ${at}`);
        for (const mv of mustNot || []) assert.ok(!moves.includes(mv), `${who} must not allow ${mv}, ${at}`);
    }
}

describe('rules corpus: every position agrees with the reference', () => {
    for (const position of CORPUS.positions) {
        test(position.name, () => {
            const at = position.fen;
            G.load(position.fen);
            assert.equal(G.run('battle3dFen()'), position.fen, 'the FEN survives the round trip through parseFen');
            const chess = new R.Chess(position.fen);
            const lists = compareEverything(chess, undefined, at);
            assertMoves(lists, position.must, position.mustNot, at);
            if ('end' in position) assert.equal(lists.probe.end, position.end, 'checkmate / stalemate');
            if ('insufficient' in position) assert.equal(lists.probe.insufficient, position.insufficient, 'insufficient material');
            if ('fifty' in position) assert.equal(lists.probe.fifty, position.fifty, '50-move rule');
        });
    }
});

describe('scripted lines: every ply agrees with the reference', () => {
    for (const line of CORPUS.lines) {
        test(line.name, () => {
            const start = line.fen || R.START_FEN;
            G.load(start);
            const chess = new R.Chess(start);
            const keys = [R.refRepetitionKey(chess)];
            const moves = line.moves.split(' ');
            let lists = compareEverything(chess, keys, `${start} ply 0`);
            let threefoldAt = null, lastEvent = null;
            moves.forEach((mv, i) => {
                const ply = i + 1, at = `${start} ply ${ply} ${mv}`;
                const r = lists.ref.get(mv);
                assert.ok(r, `the line's move is legal, ${at}`);
                lastEvent = G.apply(mv);
                chess.move({ from: r.from, to: r.to, promotion: r.promotion ? r.promotion.toLowerCase() : undefined });
                keys.push(R.refRepetitionKey(chess));
                lists = compareEverything(chess, keys, at);
                assert.equal(lists.probe.fen, r.fen, `position, ${at}`);
                if (lists.probe.threefold && threefoldAt === null) threefoldAt = ply;
                if (line.results && String(ply) in line.results) assert.equal(lists.probe.result, line.results[ply], `game result, ${at}`);
            });
            if ('threefoldAt' in line) assert.equal(threefoldAt, line.threefoldAt, 'first ply with a threefold repetition');
            if (line.finalFen) assert.equal(lists.probe.fen, line.finalFen, 'final position');
            if (line.lastMove) {
                assert.deepEqual({
                    san: lastEvent.notation, enPassant: lastEvent.enPassant, captured: lastEvent.captured.piece,
                    capturedSquare: R.sqName(lastEvent.captured.square.row, lastEvent.captured.square.col),
                }, line.lastMove, 'MoveEvent of the last move');
            }
            assertMoves(lists, line.finalMust, line.finalMustNot, `${start} after ${line.moves}`);
        });
    }
});

describe('seeded playouts: every ply agrees with the reference', () => {
    test('10 games x 50 plies through battle3dApplyMove, the ChessAI generator and tactics.js', (t) => {
        const stats = R.differentialPlayouts({ games: 10, plies: 50, seed: 0xC0FFEE, fullEvery: 4, starts: R.PLAYOUT_STARTS, tactics: T, game: G, ai: A });
        t.diagnostic(JSON.stringify(stats));
        assert.ok(stats.plies > 350, JSON.stringify(stats));
        assert.ok(stats.enPassant >= 5 && stats.castles >= 2 && stats.promotions >= 5 && stats.captures >= 50 && stats.undos >= 5, JSON.stringify(stats));
    });
});
