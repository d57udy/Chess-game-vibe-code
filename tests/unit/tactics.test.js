'use strict';
// battle3d/tactics.js motif detectors on the known-motif position set (tests/fixtures/
// tactics-positions.json), statically and with engine analyses (ChessAI.analyze, the way the
// coach calls it). Precision first: every `forbid` must hold in both modes.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadEngine, uci } = require('../helpers/loadEngine');
const fixtures = require('../fixtures/tactics-positions.json');

const ROOT = path.resolve(__dirname, '..', '..');
const ST = '({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber })';
let T;
const E = loadEngine();

before(async () => { T = await import(pathToFileURL(path.join(ROOT, 'battle3d/tactics.js')).href); });

// { before, move, after, anBefore, anAfter } for a fixture case (the move must be legal).
function play(c) {
    E.fen(c.fen);
    const legal = E.get('(ChessAI.loadFromGlobals(), ChessAI.legalMoves().map(m => ChessAI.toGameMove(m)))');
    const move = legal.find((m) => uci(m) === c.move || uci(m) === c.move + 'q');
    assert.ok(move, `${c.name}: ${c.move} is legal`);
    const before = E.get(ST);
    const anBefore = E.get(`ChessAI.analyze(${ST}, { nodes: 60000, multiPv: 1 }, [])`);
    E.set('__m', move);
    assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), true);
    const after = E.get(ST);
    const anAfter = E.get(`ChessAI.analyze(${ST}, { nodes: 60000, multiPv: 1 }, [])`);
    return { before, move, after, anBefore, anAfter };
}

function check(c, got, engine) {
    for (const e of c.expect) {
        const found = got.some((g) => g.motif === e.motif && g.by === e.by && g.squares[0] === e.square && (e.mateIn === undefined || g.mateIn === e.mateIn));
        if (e.engineOnly && !engine) assert.ok(!got.some((g) => g.motif === e.motif), `${c.name}: ${e.motif} claimed without engine data`);
        else assert.ok(found, `${c.name}: expected ${e.motif} by ${e.by} at ${e.square}${e.mateIn ? ` (mate in ${e.mateIn})` : ''}, got ${JSON.stringify(got.map((g) => g.motif + '@' + g.squares[0]))}`);
    }
    for (const f of c.forbid) {
        for (const g of got) assert.ok(f !== '*' && g.motif !== f, `${c.name}: must not report ${g.motif}@${g.squares.join(',')}`);
    }
}

describe('tactics.detect on the known-motif positions', () => {
    for (const c of fixtures.cases) {
        test(c.name, () => {
            const p = play(c);
            check(c, T.detect(p.before, p.move, p.after), false);
            check(c, T.detect(p.before, p.move, p.after, { before: p.anBefore, after: p.anAfter }), true);
            check(c, T.detect(p.before, p.move), false); // stateAfter is optional
        });
    }
});

describe('tactics helpers', () => {
    test('motif shape: squares are algebraic, pieces match the board', () => {
        const p = play(fixtures.cases.find((c) => c.name.startsWith('back-rank mate')));
        const [m] = T.detect(p.before, p.move, p.after);
        assert.deepEqual(m, {
            motif: 'backRank', by: 'w', squares: ['a8', 'g8'], pieces: ['R', 'k'], mate: true,
            square: 'a8', piece: 'R', attacker: 'R', attackerSquare: 'a8', target: 'k', targetSquare: 'g8',
        });
        // Template fields on a fork and a hanging piece.
        const f = play(fixtures.cases.find((c) => c.name === 'royal knight fork Nc7+'));
        const fork = T.detect(f.before, f.move, f.after, { before: f.anBefore, after: f.anAfter }).find((x) => x.motif === 'fork');
        assert.equal(fork.attacker, 'N');
        assert.equal(fork.square, 'c7');
        assert.ok(['r', 'k'].includes(fork.target));
        const h = play(fixtures.cases.find((c) => c.name.startsWith('queen hung')));
        const hang = T.detect(h.before, h.move, h.after).find((x) => x.motif === 'hanging');
        assert.deepEqual([hang.piece, hang.square, hang.attacker, hang.attackerSquare], ['Q', 'h5', 'n', 'f6']);
    });

    test('hangingPieces: queen and pawn attacked by a knight (biggest first), nothing at the start', () => {
        E.fen('rnbqkb1r/pppppppp/5n2/7Q/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 2 2');
        const h = T.hangingPieces(E.get(ST), 'w');
        assert.deepEqual(h.map((x) => x.square), ['h5', 'e4']);
        assert.equal(h[0].square, 'h5');
        assert.equal(h[0].piece, 'Q');
        assert.deepEqual(h[0].attackers, ['f6']);
        assert.equal(h[0].gain, 900);
        E.fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        assert.deepEqual(T.hangingPieces(E.get(ST), 'w'), []);
        assert.deepEqual(T.hangingPieces(E.get(ST), 'b'), []);
    });

    test('hangingPieces respects pins: a pinned attacker does not count', () => {
        // The e7 knight would take the d5 bishop, but it is pinned to the black king by the e1 rook.
        E.fen('4k3/4n3/8/3B4/8/8/8/4R1K1 b - - 0 1');
        assert.deepEqual(T.hangingPieces(E.get(ST), 'w'), []);
    });

    test('SEE: defended pawn, x-ray recapture', () => {
        const I = T._internal;
        E.fen('4k3/8/3p4/4p3/8/8/4R3/4R1K1 w - - 0 1'); // e5 pawn defended by d6; two rooks x-ray
        const b = I.flat(E.get(ST));
        assert.equal(I.see(b, 28, 'w'), 0); // Rxe5 dxe5 Rxe5: 100 - 500 + 100 < 0, so do not capture
        E.fen('4k3/8/8/4p3/8/8/4R3/4R1K1 w - - 0 1'); // undefended
        assert.equal(I.see(I.flat(E.get(ST)), 28, 'w'), 100);
    });

    test('never throws on odd input', () => {
        assert.deepEqual(T.detect({ board: [] }, { from: { row: 0, col: 0 }, to: { row: 1, col: 1 } }), []);
        assert.deepEqual(T.detect(null, null), []);
        assert.deepEqual(T.hangingPieces(null, 'w'), []);
    });

    test('random playouts: no exceptions, every reported square holds the reported piece', () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
        let checked = 0;
        for (let g = 0; g < 6; g++) {
            E.run('parseFen(INITIAL_BOARD_FEN)');
            for (let ply = 0; ply < 60; ply++) {
                const legal = E.get('getAllLegalMoves(currentPlayer)');
                if (legal.length === 0) break;
                const move = legal[Math.floor(rand() * legal.length)];
                const before = E.get(ST);
                E.set('__m', move);
                E.run('ChessAI.applyMoveToGlobals(__m)');
                const after = E.get(ST);
                for (const m of T.detect(before, move, after)) {
                    const ref = ['missedMate', 'missedCapture'].includes(m.motif) ? before : after;
                    m.squares.forEach((sq, i) => {
                        const r = 8 - Number(sq[1]), c = sq.charCodeAt(0) - 97;
                        if (m.motif !== 'allowsMate' || i === 0) assert.equal(ref.board[r][c], m.pieces[i], `${m.motif} ${sq}`);
                    });
                    checked++;
                }
            }
        }
        assert.ok(checked > 10, `checked ${checked} motifs`);
    });
});
