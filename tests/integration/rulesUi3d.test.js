'use strict';
// Rules conformance through the 3D view (index.html + battle3d/main.js booted in node: real scene
// with a fake renderer, real units, controller and HUD, driven by square clicks and buttons): what
// the board offers, what a played move does to the position and to the units, how games end, undo,
// the AI as opponent, a move in progress, and save / load, all compared with the chess.js reference.
// Real pointer clicks go through the scene's ray picking. The scenario tables
// (tests/helpers/rulesUiScenarios.js) and the tests themselves (rulesUiSuite.js) are shared with
// rulesUi2d.test.js; here they also run with the scenes played out, and the same seeded games go
// through both views side by side. Longer runs are in tests/slow/rulesUiPlayouts.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const {
    open2d, open3d, createReference, assertPosition, assertStatus, assertOffers, ALL_SQUARES,
} = require('../helpers/rulesUiDriver');
const {
    defineRulesUiSuite, playout, addStats, start, assertSquares, kingThenRook, pawnThenPawnBeside, pointerSweep, PLAYOUT_STARTS,
} = require('../helpers/rulesUiSuite');
const S = require('../helpers/rulesUiScenarios');

const skip = findThree() ? false : 'three.js not installed';
let page = null, flat = null;
const open = async () => (page ??= await open3d());
after(() => { if (page) page.close(); if (flat) flat.close(); });

defineRulesUiSuite({ view: '3d', open, skip });

describe('3D rules: the same seeded games through the 3D and the 2D view', { skip }, () => {
    test('two games side by side: both views equal the reference and each other at every ply', async (t) => {
        const A = await open();
        flat ??= await open2d();
        const total = {};
        // From the two rich start positions; the start position is played side by side in the slow suite
        addStats(total, await playout([A, flat], { seed: 7, plies: 24, fen: PLAYOUT_STARTS.castling }));
        addStats(total, await playout([A, flat], { seed: 18, plies: 24, fen: PLAYOUT_STARTS.pawns }));
        t.diagnostic(JSON.stringify(total));
        assert.ok(total.plies >= 44, JSON.stringify(total));
        assert.ok(total.enPassant >= 3 && total.castles >= 2 && total.promotions >= 3 && total.captures >= 10, `special moves reached: ${JSON.stringify(total)}`);
        assert.deepEqual(A.takeErrors(), []);
        assert.deepEqual(flat.takeErrors(), []);
    });
});

describe('3D rules: special moves with their scenes played out', { skip }, () => {
    // One of each choreography: every en passant case, the three castling moves, captures of a rook
    // at home, and promotions by push and by capture (queen, and knight by capture)
    const SCENES = /^(en passant|king-side castling|queen-side castling|castling with check|rook captured at home|promotion by push to Q|promotion by capture to [QN]|promotion by capture of a rook)/;
    for (const speed of ['full', 'fast']) {
        test(`battles ${speed}: after every scene the units stand where the reference has the pieces`, async () => {
            const A = await open();
            A.animations = 'play';
            try {
                A.P.$(`speed-${speed}`).click();
                // White's moves at Full, Black's (the mirrored table) at Fast; the slow suite runs both at both
                for (const base of S.SPECIAL_MOVES.filter((x) => SCENES.test(x.name))) {
                    const e = speed === 'full' ? base : S.mirrorEntry(base);
                    const R = await start(A, e);
                    await A.move(e.move);
                    R.play(e.move);
                    assertPosition(A, R, `${e.name}, ${speed}`);
                    assertSquares(A, e, `${e.name}, ${speed}`);
                    assertStatus(A, R, `${e.name}, ${speed}`);
                }
                assert.deepEqual(A.takeErrors(), []);
            } finally {
                A.animations = 'skip';
                A.P.$('speed-fast').click();
            }
        });
    }
});

describe('3D rules: second ways to play a move: king then own rook, pawn then the pawn it takes en passant', { skip }, () => {
    test('a pawn, then the enemy pawn beside it, captures en passant exactly when that capture is legal', async () => {
        const A = await open();
        const entries = S.CORPUS.filter((x) => x.group === 'en passant' && x.fen && !x.heavy).flatMap((x) => (x.both ? [x, S.mirrorEntry(x)] : [x]));
        const { captured, refused } = await pawnThenPawnBeside(A, entries);
        assert.ok(captured >= 10 && refused >= 10, `both outcomes exercised: ${captured} captured, ${refused} refused`);
        assert.deepEqual(A.takeErrors(), []);
    });

    test('king then own rook castles towards that rook exactly when castling there is legal', async () => {
        const A = await open();
        // The positions of the castling table; the cases reached by lead-in moves run in the slow suite
        const entries = S.CORPUS.filter((x) => x.group === 'castling' && !x.moves).flatMap((x) => (x.both ? [x, S.mirrorEntry(x)] : [x]));
        const { castled, refused } = await kingThenRook(A, entries);
        assert.ok(castled >= 12 && refused >= 12, `both outcomes exercised: ${castled} castled, ${refused} refused`);
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('3D rules: real pointer clicks (the scene picks the square)', { skip }, () => {
    const play = async (A, R, e, where) => {
        const from = e.move.slice(0, 2), to = e.move.slice(2, 4);
        await A.pointer(from);
        assert.equal(A.selected(), from, `${e.name}: a click on the unit selects it`);
        assert.deepEqual(A.offered(), R.offered(from), `${e.name}: offered for ${from}`);
        await A.pointer(where?.square || to, where?.at);
        if (e.move[4]) {
            assert.ok(A.promotionOpen(), `${e.name}: promotion chooser`);
            await A.promote(e.move[4]);
        }
        await A.settle();
        R.play(e.move);
        assertPosition(A, R, e.name);
    };

    test('en passant, castling and promotion by capture: click the unit, click the target; afterwards every unit is picked on its square', async () => {
        const A = await open();
        const PLAYED = /^(en passant removes|en passant towards the h-file|en passant from the h-file|king-side castling|queen-side castling|promotion by capture to N)/;
        for (const base of S.SPECIAL_MOVES.filter((x) => PLAYED.test(x.name))) {
            for (const e of [base, S.mirrorEntry(base)]) { // Black's moves are seen and clicked from Black's side
                const R = await start(A, e);
                await play(A, R, e);
                assertSquares(A, e, e.name);
                const occupied = ALL_SQUARES.filter((sq) => R.chess.get(sq));
                for (const sq of [...occupied, ...(e.empties || [])]) assert.equal(A.pick(sq), sq, `${e.name}: pointer on ${sq}`);
            }
        }
        assert.deepEqual(A.takeErrors(), []);
    });

    // The offered square lies directly behind a unit as the player to move sees the board, so that
    // unit's pick proxy stands over the middle of the square (where the move marker is drawn). The
    // scene reports the board square under the pointer as well, and the controller takes it when
    // the pointer is not on the figure itself.
    const BEHIND = [
        { name: 'pawn one step forward: behind its own body', fen: '4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1', move: 'e2e3' },
        { name: 'knight to the square behind an own pawn', fen: '4k3/8/8/8/8/8/5P2/4K1N1 w - - 0 1', move: 'g1f3' },
        { name: 'en passant: the target lies behind the pawn that is captured', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', move: 'e5d6' },
        { name: 'promotion by push on the far rank', fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', move: 'a7a8q' },
    ];
    test('a click on the middle of an offered square plays the move, also when a unit stands in front of it', async () => {
        const A = await open();
        for (const base of BEHIND) {
            for (const e of [base, S.mirrorEntry(base)]) {
                const R = await start(A, e);
                await play(A, R, e, { at: 'middle' });
            }
        }
        assert.deepEqual(A.takeErrors(), []);
    });

    test('sweep: for every piece, a click on the middle of every offered square plays that move, seen from both sides', async () => {
        const A = await open();
        // Two small positions (en passant, promotion on the far rank); the slow suite sweeps the whole table and its mirror
        const SWEPT = /^(bare board, available|by capture or push, every piece)$/;
        const count = await pointerSweep(A, S.CORPUS.filter((x) => SWEPT.test(x.name)));
        assert.ok(count.played >= 20, JSON.stringify(count));
        // a square whose middle is hidden behind a figure (the king's own head, mostly) is the exception
        assert.ok(count.hidden + count.unitsHidden <= count.played / 8, JSON.stringify(count));
        assert.deepEqual(A.takeErrors(), []);
    });

    test('a click on a unit itself still means that unit when the square behind it is offered', async () => {
        const A = await open();
        for (const base of BEHIND.slice(0, 2)) {
            for (const e of [base, S.mirrorEntry(base)]) {
                const R = await start(A, e);
                const from = e.move.slice(0, 2), to = e.move.slice(2, 4);
                const front = to[0] + from[1].replace(/[18]/, (rank) => (rank === '1' ? '2' : '7')); // e2 for e2-e3, f2 for g1-f3
                await A.pointer(from);
                assert.ok(A.offered().targets.includes(to), `${e.name}: ${to} is offered`);
                await A.pointer(front, 'unit');
                await A.settle();
                assertPosition(A, R, `${e.name}: click on the unit on ${front}`);
                // the selected unit is put down, another own unit is picked up instead
                assert.equal(A.selected(), front === from ? null : front, `${e.name}: selection after the click on ${front}`);
            }
        }
        assert.deepEqual(A.takeErrors(), []);
    });

    test('en passant: a click on the pawn that is captured plays the capture', async () => {
        const A = await open();
        for (const e of [BEHIND[2], S.mirrorEntry(BEHIND[2])]) {
            const R = await start(A, e);
            await play(A, R, e, { square: e.move[2] + e.move[1], at: 'unit' }); // the pawn beside the capturer
        }
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('3D rules: looking at an earlier position does not let pieces move', { skip }, () => {
    test('review mode shows the old position, ignores board clicks, and returns to the live game', async () => {
        const A = await open();
        const R = await start(A, { fen: '4k3/4p3/8/8/8/8/3PP3/4K1N1 w - - 0 1', moves: ['e2e4', 'e7e5', 'g1f3'] });
        const live = A.fen();
        A.P.$('move-list').querySelector('span.mv').click(); // 1. e4
        assert.equal(A.P.B.state().reviewIndex, 1);
        assert.equal(A.shown().placement, '4k3/4p3/8/8/4P3/8/3P4/4K1N1', 'units show the reviewed position');
        for (const [from, to] of [['e7', 'e5'], ['d2', 'd4'], ['g1', 'f3']]) {
            await A.click(from);
            assert.deepEqual(A.offered().targets, [], `nothing offered for ${from} while reviewing`);
            await A.click(to);
        }
        assert.equal(A.fen(), live, 'the game itself is untouched');
        await A.escape();
        assert.equal(A.P.B.state().reviewIndex, null);
        assertPosition(A, R, 'back in the live game');
        await assertOffers(A, R, 'back in the live game');
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('3D rules: the engine as opponent', { skip }, () => {
    for (const e of S.AI_OBVIOUS) {
        test(`${e.name}: played and applied as the reference plays it`, async () => {
            const A = await open();
            const R = createReference(e.fen);
            await A.setMode('human-ai', R.turn() === 'w' ? 'b' : 'w');
            await A.setElo(e.forced ? 400 : 2400);
            await A.load(e.fen);
            const move = await A.answerAIWithEngine();
            assert.ok(move, 'the engine returned a move');
            const uci = [...R.legal().values()].find((m) => m.fen === A.fen())?.uci;
            assert.ok(uci, `the engine's move leads to a reference position: ${A.fen()}`);
            assert.ok(e.best.includes(uci), `engine played ${uci}, expected one of ${e.best}`);
            const m = R.play(uci);
            assertPosition(A, R, `engine ${uci}`);
            assertStatus(A, R, `engine ${uci}`);
            if (e.san) assert.equal(m.san, e.san);
            assert.deepEqual(A.takeErrors(), []);
            await A.setMode('human-human');
        });
    }
});
