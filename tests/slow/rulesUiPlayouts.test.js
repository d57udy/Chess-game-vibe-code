'use strict';
// The long version of the rules conformance suites (tests/integration/rulesUi2d.test.js and
// rulesUi3d.test.js), skipped by `npm test` unless RUN_SLOW=1:
//   - every scenario table entry for both colours, with all 64 squares clicked for every piece
//   - many seeded random games by clicks through the 2D view, and through the 3D and the 2D view
//     side by side (the 3D games alternately with skipped and with played-out scenes)
//   - every special move for both colours with its 3D scene played out at Full and at Fast
//   - real pointer clicks on the middle of every offered square, for every piece of every table
//     position and its mirror, seen from both sides
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { open2d, open3d, assertPosition, assertStatus } = require('../helpers/rulesUiDriver');
const {
    defineRulesUiSuite, playout, addStats, start, assertSquares, kingThenRook, pawnThenPawnBeside, pointerSweep, PLAYOUT_STARTS,
} = require('../helpers/rulesUiSuite');
const S = require('../helpers/rulesUiScenarios');

const slowSkip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';
const skip3d = slowSkip || (findThree() ? false : 'three.js not installed');
let flat = null, page = null;
const open2 = async () => (flat ??= await open2d());
const open3 = async () => (page ??= await open3d());
after(() => { if (flat) flat.close(); if (page) page.close(); });

const STARTS = [S.START, PLAYOUT_STARTS.castling, PLAYOUT_STARTS.pawns];

defineRulesUiSuite({ view: '2d', open: open2, skip: slowSkip, slow: true });
defineRulesUiSuite({ view: '3d', open: open3, skip: skip3d, slow: true });

describe('2D rules: long seeded random games by clicks', { skip: slowSkip }, () => {
    test('30 games x 120 plies: offers, position, screen, status and move list equal the reference', async (t) => {
        const A = await open2();
        const total = {};
        for (let game = 0; game < 30; game++) addStats(total, await playout([A], { seed: 0x2D00 + game, plies: 120, fen: STARTS[game % 3] }));
        t.diagnostic(JSON.stringify(total));
        assert.ok(total.plies > 2500, JSON.stringify(total));
        assert.ok(total.enPassant > 20 && total.castles > 10 && total.promotions > 20 && total.captures > 300, JSON.stringify(total));
        assert.ok(Object.keys(total.results).length >= 2, `some games finish: ${JSON.stringify(total.results)}`);
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('3D rules: long seeded random games through the 3D and the 2D view', { skip: skip3d }, () => {
    test('15 games x 100 plies side by side, scenes skipped and played out in turn', async (t) => {
        const A = await open3(), B = await open2();
        const total = {};
        try {
            for (let game = 0; game < 15; game++) {
                A.animations = game % 2 ? 'play' : 'skip';
                A.P.$(game % 4 < 2 ? 'speed-fast' : 'speed-full').click();
                addStats(total, await playout([A, B], { seed: 0x3D00 + game, plies: 100, fen: STARTS[game % 3] }));
            }
        } finally {
            A.animations = 'skip';
            A.P.$('speed-fast').click();
        }
        t.diagnostic(JSON.stringify(total));
        assert.ok(total.plies > 1000, JSON.stringify(total));
        assert.ok(total.enPassant > 8 && total.castles > 5 && total.promotions > 8 && total.captures > 100, JSON.stringify(total));
        assert.deepEqual(A.takeErrors(), []);
        assert.deepEqual(B.takeErrors(), []);
    });
});

describe('3D rules: every special move with its scene played out', { skip: skip3d }, () => {
    for (const speed of ['full', 'fast']) {
        test(`battles ${speed}, both colours`, async () => {
            const A = await open3();
            A.animations = 'play';
            try {
                A.P.$(`speed-${speed}`).click();
                for (const base of S.SPECIAL_MOVES) {
                    for (const e of [base, S.mirrorEntry(base)]) {
                        const R = await start(A, e);
                        await A.move(e.move);
                        R.play(e.move);
                        assertPosition(A, R, `${e.name}, ${speed}`);
                        assertSquares(A, e, `${e.name}, ${speed}`);
                        assertStatus(A, R, `${e.name}, ${speed}`);
                    }
                }
                assert.deepEqual(A.takeErrors(), []);
            } finally {
                A.animations = 'skip';
                A.P.$('speed-fast').click();
            }
        });
    }
});

describe('3D rules: real pointer clicks on every offered square of the whole table', { skip: skip3d }, () => {
    test('for every piece, a click on the middle of every offered square plays that move, seen from both sides', async (t) => {
        const A = await open3();
        const count = await pointerSweep(A, S.CORPUS.flatMap((x) => (x.fen ? [x, S.mirrorEntry(x)] : [x])));
        t.diagnostic(JSON.stringify(count));
        assert.ok(count.played > 3000, JSON.stringify(count));
        assert.ok(count.hidden + count.unitsHidden <= count.played / 15, `squares hidden behind a figure stay the exception: ${JSON.stringify(count)}`);
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('3D rules: king then own rook and pawn then the pawn beside, every case', { skip: skip3d }, () => {
    test('a pawn, then the enemy pawn beside it, captures en passant exactly when that capture is legal', async () => {
        const A = await open3();
        const entries = S.CORPUS.filter((x) => x.group === 'en passant').flatMap((x) => (x.fen ? [x, S.mirrorEntry(x)] : [x]));
        const { captured, refused } = await pawnThenPawnBeside(A, entries);
        assert.ok(captured >= 20 && refused >= 20, `both outcomes exercised: ${captured} captured, ${refused} refused`);
        assert.deepEqual(A.takeErrors(), []);
    });

    test('king then own rook castles towards that rook exactly when castling there is legal', async () => {
        const A = await open3();
        const entries = S.CORPUS.filter((x) => x.group === 'castling').flatMap((x) => (x.fen ? [x, S.mirrorEntry(x)] : [x]));
        const { castled, refused } = await kingThenRook(A, entries);
        assert.ok(castled >= 20 && refused >= 30, `both outcomes exercised: ${castled} castled, ${refused} refused`);
        assert.deepEqual(A.takeErrors(), []);
    });
});
