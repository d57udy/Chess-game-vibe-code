'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dRules, LEGAL_UCI_EXPR, randomPlayouts, rng, square } = require('../helpers/loadBattle3dRules');

const sq = (name) => square(name);
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Covers both castlings, en passant, promotions with capture (=Q and =N), disambiguation, checks.
const SCRIPTED_GAME = ('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1 f8c5 d2d4 e5d4 e4e5 d7d5 e5d6 e8g8 d6c7 c8g4 ' +
    'c7d8q f8d8 f1e1 g4f3 d1f3 d4d3 c4f7 g8f8 f7b3 d3c2 c1d2 c2b1n a1b1 a8c8 e1e8 d8e8 f3f6 g7f6').split(' ');
const SCRIPTED_SAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'O-O', 'Bc5', 'd4', 'exd4', 'e5', 'd5', 'exd6', 'O-O',
    'dxc7', 'Bg4', 'cxd8=Q', 'Rfxd8', 'Re1', 'Bxf3', 'Qxf3', 'd3', 'Bxf7+', 'Kf8', 'Bb3', 'dxc2', 'Bd2', 'cxb1=N',
    'Raxb1', 'Rac8', 'Re8+', 'Rxe8', 'Qxf6+', 'gxf6'];

function fresh() {
    const E = loadBattle3dRules();
    E.run('battle3dNewGame()');
    return E;
}
function at(E, fen) {
    const E2 = E || loadBattle3dRules();
    E2.position(fen);
    return E2;
}
const play = (E, moves) => moves.map((m) => E.apply(m));
const FULL_STATE = 'JSON.stringify({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, currentMoveIndex, n: gameHistory.length })';

describe('battle3d rules: API surface', () => {
    test('exposes the contract functions as globals', () => {
        const E = fresh();
        for (const f of ['battle3dApplyMove', 'battle3dGameStatus', 'battle3dNewGame', 'battle3dUndo']) {
            assert.equal(E.run(`typeof ${f}`), 'function', f);
        }
    });

    test('new game: start position, one history entry, White to move', () => {
        const E = fresh();
        assert.equal(E.state(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        assert.equal(E.run('gameHistory.length'), 1);
        assert.equal(E.run('currentMoveIndex'), 0);
        assert.deepEqual(E.get('battle3dGameStatus()'), { over: false, result: null, winner: null, message: 'White to move.', inCheck: false });
    });

    test('new game resets after moves, an undo and a finished game', () => {
        const E = fresh();
        play(E, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        assert.equal(E.get('battle3dGameStatus()').over, true);
        E.run('battle3dNewGame()');
        assert.equal(E.state(), START);
        assert.equal(E.run('gameHistory.length'), 1);
        assert.equal(E.run('isGameOver'), false);
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: true }, b: { K: true, Q: true } });
        assert.equal(E.apply('e2e4').notation, 'e4');
    });
});

describe('battle3d rules: illegal input throws without mutating', () => {
    const cases = [
        ['pawn three squares', 'e2e5'],
        ['empty square', 'e4e5'],
        ['opponent piece', 'e7e5'],
        ['knight to own piece', 'g1e2'],
        ['bishop through pawn', 'f1c4'],
    ];
    for (const [name, mv] of cases) {
        test(name, () => {
            const E = fresh();
            const before = E.run(FULL_STATE);
            assert.throws(() => E.apply(mv));
            assert.equal(E.run(FULL_STATE), before);
        });
    }

    test('moving a pinned piece / into check throws', () => {
        const E = at(null, '4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1');
        const before = E.run(FULL_STATE);
        assert.throws(() => E.apply('e2c3'), 'pinned knight');
        assert.throws(() => E.apply('e1e2'), 'king onto own piece');
        const E2 = at(null, '4k3/8/8/8/8/8/3r4/K7 w - - 0 1');
        assert.throws(() => E2.apply('a1b2'), 'king into check');
        assert.equal(E.run(FULL_STATE), before);
    });

    test('castling through check or after rights are lost throws', () => {
        const E = at(null, 'r3k2r/8/8/8/8/8/8/R3K2R w Qkq - 0 1');
        assert.throws(() => E.apply('e1g1'), 'no K right');
        const E2 = at(null, 'r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1');
        assert.throws(() => E2.apply('e1g1'), 'f1 attacked');
    });

    test('invalid promotion piece throws and leaves the position alone', () => {
        const E = at(null, '4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        const before = E.run(FULL_STATE);
        assert.throws(() => E.apply('a7a8k'));
        assert.throws(() => E.apply('a7a8p'));
        assert.equal(E.run(FULL_STATE), before);
    });
});

describe('battle3d rules: MoveEvent', () => {
    test('quiet pawn push', () => {
        const E = fresh();
        const ev = E.apply('e2e4');
        assert.deepEqual(
            { color: ev.color, piece: ev.piece, from: ev.from, to: ev.to, captured: ev.captured, castling: ev.castling, promotion: ev.promotion, givesCheck: ev.givesCheck, isMate: ev.isMate, isAI: ev.isAI },
            { color: 'w', piece: 'P', from: sq('e2'), to: sq('e4'), captured: null, castling: null, promotion: null, givesCheck: false, isMate: false, isAI: false });
        assert.equal(E.state(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
        assert.deepEqual(E.get('gameHistory[1].lastMove'), { from: sq('e2'), to: sq('e4') });
    });

    test('black knight move uses lowercase piece and bumps the clocks', () => {
        const E = fresh();
        E.apply('e2e4');
        const ev = E.apply('g8f6');
        assert.equal(ev.color, 'b');
        assert.equal(ev.piece, 'n');
        assert.equal(E.state(), 'rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2');
    });

    test('capture: captured piece on the target square, halfmove clock reset', () => {
        const E = fresh();
        play(E, ['e2e4', 'd7d5', 'g1f3', 'g8f6']);
        const ev = E.apply('e4d5');
        assert.deepEqual(ev.captured, { piece: 'p', square: sq('d5') });
        assert.equal(ev.notation, 'exd5');
        assert.equal(E.run('halfmoveClock'), 0);
    });

    test('en passant: captured square differs from the target and the pawn is removed', () => {
        const E = fresh();
        play(E, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
        assert.deepEqual(E.get('enPassantTarget'), sq('d6'));
        const ev = E.apply('e5d6');
        assert.deepEqual(ev.captured, { piece: 'p', square: sq('d5') });
        assert.deepEqual(ev.to, sq('d6'));
        assert.equal(ev.notation, 'exd6');
        assert.equal(E.state(), 'rnbqkbnr/1pp1pppp/p2P4/8/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3');
    });

    test('black en passant', () => {
        const E = fresh();
        play(E, ['a2a3', 'e7e5', 'a3a4', 'e5e4', 'd2d4']);
        const ev = E.apply('e4d3');
        assert.deepEqual(ev.captured, { piece: 'P', square: sq('d4') });
        assert.equal(E.run('getPieceAt(4, 3)'), null);
    });

    const CASTLE_FEN = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const castles = [
        ['white O-O', 'w', 'e1g1', 'h1', 'f1', 'O-O', { w: { K: false, Q: false }, b: { K: true, Q: true } }],
        ['white O-O-O', 'w', 'e1c1', 'a1', 'd1', 'O-O-O', { w: { K: false, Q: false }, b: { K: true, Q: true } }],
        ['black O-O', 'b', 'e8g8', 'h8', 'f8', 'O-O', { w: { K: true, Q: true }, b: { K: false, Q: false } }],
        ['black O-O-O', 'b', 'e8c8', 'a8', 'd8', 'O-O-O', { w: { K: true, Q: true }, b: { K: false, Q: false } }],
    ];
    for (const [name, color, mv, rookFrom, rookTo, san, rights] of castles) {
        test(`castling ${name}`, () => {
            const E = at(null, color === 'w' ? CASTLE_FEN : CASTLE_FEN.replace(' w ', ' b '));
            const ev = E.apply(mv);
            assert.deepEqual(ev.castling, { rookFrom: sq(rookFrom), rookTo: sq(rookTo) });
            assert.equal(ev.captured, null);
            assert.equal(ev.piece, color === 'w' ? 'K' : 'k');
            assert.equal(ev.notation, san);
            assert.equal(E.run(`getPieceAt(${sq(rookTo).row}, ${sq(rookTo).col})`), color === 'w' ? 'R' : 'r');
            assert.equal(E.run(`getPieceAt(${sq(rookFrom).row}, ${sq(rookFrom).col})`), null);
            assert.equal(E.run(`getPieceAt(${sq(mv.slice(2)).row}, ${sq(mv.slice(2)).col})`), color === 'w' ? 'K' : 'k');
            assert.deepEqual(E.get('castlingRights'), rights);
        });
    }

    test('rook moves and rook captures on home squares clear the matching rights', () => {
        const E = at(null, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
        const ev = E.apply('a1a8');
        assert.deepEqual(ev.captured, { piece: 'r', square: sq('a8') });
        assert.equal(ev.notation, 'Rxa8+');
        assert.equal(ev.givesCheck, true);
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: false }, b: { K: true, Q: false } });
        E.apply('e8e7');
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: false }, b: { K: false, Q: false } });
        E.apply('h1h2');
        assert.equal(E.get('castlingRights').w.K, false);
    });

    // a7-a8 (quiet) and a7xb8 (capture of a knight) for every promotion piece.
    const promos = [
        ['a7a8q', 'Q', null, 'a8=Q', false], ['a7a8r', 'R', null, 'a8=R', false],
        ['a7a8b', 'B', null, 'a8=B', false], ['a7a8n', 'N', null, 'a8=N', false],
        ['a7b8q', 'Q', 'n', 'axb8=Q+', true], ['a7b8r', 'R', 'n', 'axb8=R+', true],
        ['a7b8b', 'B', 'n', 'axb8=B', false], ['a7b8n', 'N', 'n', 'axb8=N', false],
    ];
    for (const [mv, promo, cap, san, check] of promos) {
        test(`white promotion ${san}`, () => {
            const E = at(null, '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
            const ev = E.apply(mv);
            assert.equal(ev.promotion, promo);
            assert.equal(ev.piece, 'P', 'MoveEvent.piece is the piece before the move');
            assert.deepEqual(ev.captured, cap ? { piece: cap, square: sq(mv.slice(2, 4)) } : null);
            assert.equal(ev.notation, san);
            assert.equal(ev.givesCheck, check);
            const t = sq(mv.slice(2, 4));
            assert.equal(E.run(`getPieceAt(${t.row}, ${t.col})`), promo);
            assert.equal(E.run('halfmoveClock'), 0);
        });
    }

    test('black promotions place lowercase pieces', () => {
        for (const p of 'qrbn') {
            const E = at(null, '4k3/8/8/8/8/8/p7/4K3 b - - 0 1');
            const ev = E.apply('a2a1' + p);
            assert.equal(ev.promotion, p.toUpperCase());
            assert.equal(E.run('getPieceAt(7, 0)'), p);
            assert.equal(ev.notation, 'a1=' + p.toUpperCase() + (p === 'q' || p === 'r' ? '+' : ''));
        }
    });

    test('a promotion without a choice defaults to a queen (AI path)', () => {
        const E = at(null, '4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        assert.equal(E.apply('a7a8').promotion, 'Q');
        assert.equal(E.run('getPieceAt(0, 0)'), 'Q');
    });

    test('promotion argument is ignored on a non-promotion move', () => {
        const E = fresh();
        const ev = E.apply('e2e4q');
        assert.equal(ev.promotion, null);
        assert.equal(E.run('getPieceAt(4, 4)'), 'P');
    });
});

describe('battle3d rules: SAN', () => {
    test('scripted game notation matches expected SAN', () => {
        const E = fresh();
        assert.deepEqual(play(E, SCRIPTED_GAME).map((e) => e.notation), SCRIPTED_SAN);
        assert.deepEqual(E.notations(), SCRIPTED_SAN, 'history moveNotation carries the suffixes');
    });

    test('file, rank and full disambiguation', () => {
        assert.equal(at(null, '4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1').apply('b1d2').notation, 'Nbd2');
        assert.equal(at(null, '4k3/8/8/8/8/8/8/R4RK1 w - - 0 1').apply('a1d1').notation, 'Rad1');
        assert.equal(at(null, '7k/8/8/R7/8/8/8/R5K1 w - - 0 1').apply('a1a3').notation, 'R1a3');
        assert.equal(at(null, 'k7/8/8/8/8/2Q1Q3/8/K1Q5 w - - 0 1').apply('c3d2').notation, 'Qc3d2');
    });

    test('check and mate suffixes; givesCheck/isMate', () => {
        const E = fresh();
        const evs = play(E, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        assert.equal(evs[3].notation, 'Qh4#');
        assert.equal(evs[3].givesCheck, true);
        assert.equal(evs[3].isMate, true);
        assert.ok(evs.slice(0, 3).every((e) => !e.givesCheck && !e.isMate));
        const E2 = fresh();
        const ev = play(E2, ['e2e4', 'f7f6', 'd1h5'])[2];
        assert.equal(ev.notation, 'Qh5+');
        assert.equal(ev.givesCheck, true);
        assert.equal(ev.isMate, false);
    });
});

describe('battle3d rules: game status', () => {
    test("checkmate (fool's mate)", () => {
        const E = fresh();
        play(E, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        assert.deepEqual(E.get('battle3dGameStatus()'),
            { over: true, result: 'checkmate', winner: 'b', message: 'Checkmate! Black wins.', inCheck: true });
        assert.equal(E.run('isGameOver'), true);
    });

    test('white checkmate (back rank)', () => {
        const E = at(null, '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
        const ev = E.apply('a1a8');
        assert.equal(ev.isMate, true);
        assert.equal(ev.notation, 'Ra8#');
        assert.deepEqual(E.get('battle3dGameStatus()').winner, 'w');
    });

    test('stalemate', () => {
        const E = at(null, '7k/8/6K1/5Q2/8/8/8/8 w - - 0 1');
        const ev = E.apply('f5f7');
        assert.equal(ev.notation, 'Qf7');
        assert.equal(ev.givesCheck, false);
        assert.equal(ev.isMate, false);
        const s = E.get('battle3dGameStatus()');
        assert.deepEqual(s, { over: true, result: 'stalemate', winner: null, message: 'Stalemate! Game is a draw.', inCheck: false });
    });

    test('50-move rule at halfmove 100, not at 99', () => {
        const E = at(null, '4k3/8/8/8/8/8/8/R3K3 w - - 98 60');
        E.apply('a1a2');
        assert.equal(E.get('battle3dGameStatus()').over, false);
        E.apply('e8d8');
        assert.equal(E.run('halfmoveClock'), 100);
        const s = E.get('battle3dGameStatus()');
        assert.equal(s.over, true);
        assert.equal(s.winner, null);
        assert.equal(s.message, 'Draw by 50-move rule.');
    });

    test('mate on the 100th halfmove is checkmate, not a draw', () => {
        const E = at(null, '6k1/5ppp/8/8/8/8/8/R5K1 w - - 99 80');
        E.apply('a1a8');
        assert.equal(E.get('battle3dGameStatus()').result, 'checkmate');
    });

    test('threefold repetition through history (knight shuffle)', () => {
        const E = fresh();
        const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
        play(E, shuffle);
        play(E, shuffle.slice(0, 3));
        assert.equal(E.get('battle3dGameStatus()').over, false, 'after 7 plies');
        E.apply('f6g8');
        const s = E.get('battle3dGameStatus()');
        assert.equal(s.over, true);
        assert.equal(s.message, 'Draw by threefold repetition.');
        assert.equal(E.run('checkThreefoldRepetition()'), true);
    });

    test('undo breaks the repetition', () => {
        const E = fresh();
        const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
        play(E, shuffle.concat(shuffle));
        assert.equal(E.get('battle3dGameStatus()').over, true);
        E.run('battle3dUndo(1)');
        assert.equal(E.get('battle3dGameStatus()').over, false);
        assert.equal(E.run('isGameOver'), false);
    });

    test('insufficient material after the last capture', () => {
        const E = at(null, '4k3/8/8/8/8/8/3p4/4K3 w - - 0 1');
        const ev = E.apply('e1d2');
        assert.equal(ev.notation, 'Kxd2');
        const s = E.get('battle3dGameStatus()');
        assert.equal(s.over, true);
        assert.equal(s.message, 'Draw by insufficient material.');
    });

    test('in check status', () => {
        const E = fresh();
        play(E, ['e2e4', 'f7f6', 'd1h5']);
        const s = E.get('battle3dGameStatus()');
        assert.equal(s.over, false);
        assert.equal(s.inCheck, true);
        assert.equal(s.message, 'Black is in check!');
    });

    test('result strings are distinct per draw kind', () => {
        const results = new Set();
        let E = at(null, '7k/8/6K1/5Q2/8/8/8/8 w - - 0 1'); E.apply('f5f7'); results.add(E.get('battle3dGameStatus()').result);
        E = at(null, '4k3/8/8/8/8/8/8/R3K3 b - - 99 60'); E.apply('e8d8'); results.add(E.get('battle3dGameStatus()').result);
        E = at(null, '4k3/8/8/8/8/8/3p4/4K3 w - - 0 1'); E.apply('e1d2'); results.add(E.get('battle3dGameStatus()').result);
        E = fresh(); play(E, 'g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'.split(' ')); results.add(E.get('battle3dGameStatus()').result);
        assert.equal(results.size, 4);
        assert.ok(![...results].includes(null));
    });
});

describe('battle3d rules: history and undo', () => {
    test('every move pushes one history entry with notation and move number', () => {
        const E = fresh();
        play(E, ['e2e4', 'e7e5', 'g1f3']);
        assert.equal(E.run('gameHistory.length'), 4);
        assert.equal(E.run('currentMoveIndex'), 3);
        assert.deepEqual(E.get('gameHistory.map(h => h.moveNumber)'), [null, 1, 1, 2]);
        assert.deepEqual(E.notations(), ['e4', 'e5', 'Nf3']);
    });

    test('undo restores exact state for every ply of the scripted game', () => {
        const E = fresh();
        const snaps = [E.run(FULL_STATE)];
        for (const mv of SCRIPTED_GAME) { E.apply(mv); snaps.push(E.run(FULL_STATE)); }
        for (let i = SCRIPTED_GAME.length - 1; i >= 0; i--) {
            assert.equal(E.run('battle3dUndo(1)'), 1);
            const want = JSON.parse(snaps[i]);
            const got = JSON.parse(E.run(FULL_STATE));
            assert.deepEqual(got, want, `after undoing ply ${i + 1}`);
        }
        assert.equal(E.run('battle3dUndo(1)'), 0, 'nothing left to undo');
        assert.equal(E.state(), START);
    });

    test('multi-ply undo (2 plies vs AI) and clamping', () => {
        const E = fresh();
        play(E, ['e2e4', 'd7d5', 'e4d5', 'c7c5']);
        const afterTwo = E.state();
        play(E, ['d5c6', 'b7c6']);
        assert.equal(E.run('battle3dUndo(2)'), 2);
        assert.equal(E.state(), afterTwo);
        assert.deepEqual(E.get('enPassantTarget'), sq('c6'));
        assert.equal(E.run('gameHistory.length'), 5, 'undone entries are discarded');
        assert.equal(E.run('battle3dUndo(99)'), 4);
        assert.equal(E.state(), START);
        assert.equal(E.run('battle3dUndo(0)'), 0);
    });

    test('undo restores castling rights and lets the side castle again', () => {
        const E = at(null, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
        E.apply('e1g1');
        E.run('battle3dUndo(1)');
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: true }, b: { K: true, Q: true } });
        assert.equal(E.apply('e1c1').notation, 'O-O-O');
    });

    test('undo after checkmate reopens the game', () => {
        const E = fresh();
        play(E, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        E.run('battle3dUndo(1)');
        assert.equal(E.get('battle3dGameStatus()').over, false);
        assert.equal(E.run('isGameOver'), false);
        assert.equal(E.apply('d8g5').notation, 'Qg5');
    });

    test('a new move after undo truncates the old future', () => {
        const E = fresh();
        play(E, ['e2e4', 'e7e5', 'g1f3']);
        E.run('battle3dUndo(2)');
        E.apply('c7c5');
        assert.deepEqual(E.notations(), ['e4', 'c5']);
        assert.equal(E.run('gameHistory.length'), 3);
    });

    test('positionHistory for the AI reflects the applied moves', () => {
        const E = loadBattle3dRules({ client: true });
        E.run('battle3dNewGame()');
        play(E, ['e2e4', 'e7e5']);
        const snap = E.get('getCurrentGameStateSnapshot()');
        assert.equal(snap.positionHistory.length, 3);
        assert.equal(snap.currentPlayer, 'w');
    });
});

describe('battle3d rules: equivalence with ui.js move application', () => {
    test('scripted game: rules.js and the ui.js reference agree after every ply', () => {
        const A = fresh();
        const R = loadBattle3dRules({ rules: false });
        R.refNewGame();
        for (const mv of SCRIPTED_GAME) {
            const ev = A.apply(mv);
            const san = R.refApply(mv);
            assert.equal(ev.notation, san, mv);
            assert.equal(A.state(), R.state(), mv);
        }
    });

    test('random playouts (25 games x 120 plies, seeded) match the reference and the engine', () => {
        const stats = randomPlayouts({ games: 25, plies: 120, seed: 0xB3D });
        // Sanity: the fuzz actually exercised captures, castling and promotion.
        assert.ok(stats.plies > 1500, JSON.stringify(stats));
        assert.ok(stats.castles > 0 && stats.promos > 0 && stats.captures > 150, JSON.stringify(stats));
    });

    test('random playouts with random undo keep history consistent', () => {
        const rand = rng(42);
        const A = loadBattle3dRules();
        for (let game = 0; game < 30; game++) {
            A.run('battle3dNewGame()');
            const states = [A.run(FULL_STATE)];
            for (let ply = 0; ply < 80; ply++) {
                if (A.get('battle3dGameStatus()').over) break;
                if (states.length > 2 && rand() < 0.15) {
                    const n = 1 + Math.floor(rand() * 2);
                    const done = A.run(`battle3dUndo(${n})`);
                    states.length -= done;
                    assert.deepEqual(JSON.parse(A.run(FULL_STATE)), JSON.parse(states[states.length - 1]));
                    continue;
                }
                const legal = A.get(LEGAL_UCI_EXPR);
                A.apply(legal[Math.floor(rand() * legal.length)]);
                states.push(A.run(FULL_STATE));
                assert.equal(A.run('gameHistory.length'), states.length);
            }
        }
    });
});
