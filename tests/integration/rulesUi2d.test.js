'use strict';
// Rules conformance through the 2D view (2d.html with all its scripts in jsdom, driven by clicks):
// what the board offers, what a played move does to the position and to the screen, how games end,
// undo and redo, the AI as opponent, a move in progress, and save / load, all compared with the
// chess.js reference. The scenario tables
// (tests/helpers/rulesUiScenarios.js) and the tests themselves (rulesUiSuite.js) are shared with
// rulesUi3d.test.js; longer runs are in tests/slow/rulesUiPlayouts.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const {
    open2d, createReference, assertPosition, assertShown, assertStatus, assertOffers, assertInertClicks, stateFen,
} = require('../helpers/rulesUiDriver');
const {
    defineTableChecks, defineRulesUiSuite, playout, addStats, start, identifyMove, assertSquares, PLAYOUT_STARTS,
} = require('../helpers/rulesUiSuite');
const S = require('../helpers/rulesUiScenarios');
const { rng } = require('../helpers/chessReference');

let page = null, enginePage = null;
const open = async () => (page ??= await open2d());
after(() => { if (page) page.close(); if (enginePage) enginePage.close(); });

defineTableChecks();
defineRulesUiSuite({ view: '2d', open });

describe('2D rules: seeded random games by clicks', () => {
    test('three games: offers, position, screen, status and move list equal the reference at every ply', async (t) => {
        const A = await open();
        const total = {};
        addStats(total, await playout([A], { seed: 39, plies: 30 }));
        addStats(total, await playout([A], { seed: 37, plies: 24, fen: PLAYOUT_STARTS.castling }));
        addStats(total, await playout([A], { seed: 11, plies: 24, fen: PLAYOUT_STARTS.pawns }));
        t.diagnostic(JSON.stringify(total));
        assert.ok(total.plies >= 75, JSON.stringify(total));
        assert.ok(total.enPassant >= 3 && total.castles >= 2 && total.promotions >= 3 && total.captures >= 10, `special moves reached: ${JSON.stringify(total)}`);
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: the engine as opponent (aiClient.js on the main thread, same globals as the board)', () => {
    const engine = async () => (enginePage ??= await open2d({ realAI: true }));

    for (const e of S.AI_OBVIOUS) {
        test(`${e.name}: played and applied as the reference plays it`, async () => {
            const A = await engine();
            const R = createReference(e.fen);
            await A.setElo(e.forced ? 400 : 2400);
            await A.setMode('human-ai', R.turn() === 'w' ? 'b' : 'w');
            await A.load(e.fen);
            await A.waitAI();
            const uci = identifyMove(A, R);
            assert.ok(uci, `the engine's move leads to a reference position: ${A.fen()}`);
            assert.ok(e.best.includes(uci), `engine played ${uci}, expected one of ${e.best}`);
            const m = R.play(uci);
            assertPosition(A, R, `engine ${uci}`);
            assertStatus(A, R, `engine ${uci}`);
            if (e.san) assert.equal(m.san, e.san);
            assert.deepEqual(A.takeErrors(), []);
        });
    }

    test('a short game: every engine reply is a legal reference move and lands identically', async () => {
        const A = await engine();
        const R = await start(A, {}, { mode: 'human-ai', human: 'w' });
        await A.setElo(600);
        const rand = rng(77);
        for (let i = 0; i < 6 && !R.result().over; i++) {
            const moves = [...R.legal().keys()].sort();
            const mv = moves[Math.floor(rand() * moves.length)];
            await A.move(mv); R.play(mv);
            if (R.result().over) break;
            await A.waitAI();
            const reply = identifyMove(A, R);
            assert.ok(reply, `engine reply after ${R.sans().join(' ')} is a legal move: ${A.fen()}`);
            R.play(reply);
            assertPosition(A, R, `engine reply ${reply}`);
            assertStatus(A, R, `engine reply ${reply}`);
        }
        await assertOffers(A, R, 'after the game');
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: board seen from Black', () => {
    test('special moves on the flipped board land on the labelled squares', async () => {
        const A = await open();
        for (const e of S.SPECIAL_MOVES.filter((x) => /^(en passant removes|king-side castling|queen-side castling|promotion by capture to N)/.test(x.name))) {
            const R = await start(A, e, { human: 'b' });
            await A.move(e.move); R.play(e.move);
            assertPosition(A, R, `${e.name} (flipped)`);
            assertSquares(A, e, `${e.name} (flipped)`);
            await assertOffers(A, R, `${e.name} (flipped)`);
        }
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: looking at an earlier position and playing on from it', () => {
    test('arrow keys and a click in the move list show that position with its own rights; a move there replaces the later ones', async () => {
        const A = await open();
        const R = await start(A, { fen: 'r3k2r/8/8/8/3p4/8/4P3/R3K2R w KQkq - 0 1', moves: ['e2e4', 'h8g8', 'h1g1', 'g8h8', 'g1h1', 'a8b8'] });
        const key = (k) => A.D.key(k);
        key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft'); key('ArrowLeft');
        R.undo(5);
        assertPosition(A, R, 'five plies back');
        assertStatus(A, R, 'five plies back');
        assert.equal(A.fen().split(' ').slice(2, 4).join(' '), 'KQkq e3', 'rights and en passant square of that moment');
        assert.deepEqual(await A.select('d4'), { targets: ['d3', 'e3'], captures: ['e3'] });
        await assertOffers(A, R, 'five plies back');
        key('ArrowRight');
        R.play('h8g8');
        assertPosition(A, R, 'one ply forward again');
        A.D.doc.querySelector('#move-history .move-text').click(); // 1. e4
        R.undo(1);
        assertPosition(A, R, 'clicked the first move');
        await A.move('d4e3'); R.play('d4e3');
        assertPosition(A, R, 'en passant from the earlier position');
        assertStatus(A, R, 'en passant from the earlier position');
        assert.deepEqual(A.moveList(), ['e4', 'dxe3'], 'the later moves are gone');
        assert.equal(await A.redo(), false, 'nothing left to redo');
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: a move in progress and the other controls of the page', () => {
    test('arrow keys, a click in the move list, Switch colours, Get Hint and the strength slider during a move leave the game alone', async () => {
        const A = await open();
        const D = A.D;
        const R = await start(A, { fen: 'r3k2r/8/8/8/3p4/8/4P3/R3K2R w KQkq - 0 1', moves: ['e2e4', 'h8g8'] });
        assert.equal(await A.undo(), true); // back after 1. e4: Black can take en passant, and there is a move to redo
        R.undo();
        await A.begin('d4e3');
        assert.equal(A.busy(), true);
        D.key('ArrowLeft'); D.key('ArrowRight');
        D.doc.querySelector('#move-history .move-text').click();
        for (const id of ['redo-button', 'switch-colors-button', 'hint-button']) {
            assert.equal(D.el(id).disabled, true, `${id} is disabled during the move`);
            D.el(id).click();
        }
        D.setElo(800);
        assert.equal(A.busy(), true, 'still the same move');
        // Until the move has finished, the game is the one before it for everything that reads it
        assert.deepEqual([D.g('currentPlayer'), D.g('currentMoveIndex'), D.g('gameHistory.length')], ['b', 1, 3]);
        assert.equal(A.aiRequests().filter((c) => !c.cancelled && !c.answered).length, 0);
        await A.settle();
        R.play('d4e3');
        assertPosition(A, R, 'after the en passant capture');
        assertStatus(A, R, 'after the en passant capture');
        assert.deepEqual(A.moveListShown(), ['e4', 'dxe3 e.p.'], 'the move replaced the one that could have been redone');
        assert.equal(await A.redo(), false);
        assert.deepEqual(A.takeErrors(), []);
    });

    test('switching to AI vs AI during a move: the AI takes over after it, with the position after it', async () => {
        const A = await open();
        const R = await start(A, { fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1' });
        const asked = A.aiRequests().length;
        await A.begin('e5d6');
        await A.setMode('ai-ai', 'w');
        assert.equal(A.aiRequests().length, asked);
        await A.settle();
        R.play('e5d6');
        await A.pass();
        const pending = A.aiRequests().filter((c) => !c.cancelled && !c.answered);
        assert.equal(pending.length, 1);
        assert.equal(stateFen(pending[0].state), R.fen());
        await A.setMode('human-human', 'w');
        assertPosition(A, R, 'back to two humans');
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: Save / Load and the autosave around a move in progress, and the page reopened', () => {
    test('during a move nothing is stored and a load is refused; the finished move is stored whole', async () => {
        const A = await open();
        const D = A.D;
        const R = await start(A, { moves: S.SAVED_GAME.moves });
        const record = A.saveRecord();
        assert.equal(A.autosaved().fen, S.SAVED_GAME.fen);
        await A.begin('e5d6');
        // what the page saves on: a redraw of the move list, the mode, the strength slider
        D.setElo(900);
        const mode = D.el('game-mode-select');
        mode.dispatchEvent(new D.w.Event('change', { bubbles: true }));
        assert.equal(A.autosaved().fen, S.SAVED_GAME.fen, 'the stored game is still the one before the move');
        assert.equal(A.saveRecord().fen, S.SAVED_GAME.fen, 'a record taken now is the game before the move');
        const refused = D.get(`SaveHost.load(${JSON.stringify(record)})`);
        assert.equal(refused.ok, false, 'no load while the move is being played');
        assert.equal(A.busy(), true);
        await A.settle();
        R.play('e5d6');
        assertPosition(A, R, 'after the en passant capture');
        assert.equal(A.autosaved().fen, R.fen());
        assert.deepEqual(A.autosaved().moves, [...S.SAVED_GAME.moves, 'e5d6']);
        assert.deepEqual(A.autosaved().san.at(-1), 'exd6', 'stored notation is standard, without the on-screen mark');
        assert.deepEqual(A.takeErrors(), []);
    });

    test('the page reopened in the middle of a game: same FEN (en passant square, castling rights), same offered moves', async () => {
        const A = await open();
        const R = await start(A, { moves: S.SAVED_GAME.moves });
        const offers = {};
        for (const from of R.pieces()) offers[from] = await A.select(from);
        await A.escape();
        const B = await open2d({ storage: A.D.storage() }); // a second page with the first one's stored data
        try {
            assert.equal(B.fen(), S.SAVED_GAME.fen, 'the autosaved game is on the board');
            assertPosition(B, R, 'reopened');
            assertStatus(B, R, 'reopened');
            for (const from of R.pieces()) assert.deepEqual(await B.select(from), offers[from], `offered for ${from} after reopening`);
            await assertOffers(B, R, 'reopened');
            await B.move('e5d6'); R.play('e5d6');
            assertPosition(B, R, 'en passant after reopening');
            assert.equal(B.moveListShown().at(-1), 'exd6 e.p.');
            assert.equal(await B.undo(), true); R.undo();
            assert.equal(await B.undo(), true); R.undo();
            assertPosition(B, R, 'undone into the reopened game');
            assert.deepEqual(B.takeErrors(), []);
        } finally { B.close(); }
    });
});

describe('2D rules: en passant on the page', () => {
    test('the move list entry carries the rule as its tooltip; reviewing the move names it; Undo and Redo move the mark', async () => {
        const A = await open();
        const D = A.D;
        const R = await start(A, { fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', moves: ['e5d6', 'e8d7'] });
        const entries = [...D.doc.querySelectorAll('#move-history .move-text')];
        assert.deepEqual(entries.map((el) => [el.textContent, el.title]), [['exd6 e.p.', S.TEXT.enPassant], ['Kd7', '']]);
        assert.deepEqual(D.notations(), ['exd6', 'Kd7'], 'the stored notation stays standard');
        assert.equal(A.lastMoveMarks().captured, null, 'the mark belongs to the en passant move only');
        assert.equal(await A.undo(), true); R.undo();
        assert.deepEqual(A.lastMoveMarks(), { move: ['d6', 'e5'], captured: 'd5' });
        assert.equal(D.el('review-label').textContent, 'Reviewing move 1. exd6 e.p.');
        assert.equal(await A.undo(), true); R.undo();
        assert.deepEqual(A.lastMoveMarks(), { move: [], captured: null });
        assert.equal(await A.redo(), true); R.play('e5d6');
        assert.deepEqual(A.lastMoveMarks(), { move: ['d6', 'e5'], captured: 'd5' });
        assertPosition(A, R, 'redone');
        assert.equal(D.el('game-notice').getAttribute('role'), 'status', 'the notice is a live region');
        assert.deepEqual(A.takeErrors(), []);
    });
});

describe('2D rules: captures with their battle scenes (real GSAP)', () => {
    test('en passant, capture with promotion and a plain capture end with the screen showing the position', async () => {
        const A = await open2d({ scenes: 40 });
        try {
            for (const base of S.SPECIAL_MOVES.filter((x) => /^(en passant removes|en passant towards the a-file|promotion by capture to N|capture resets)/.test(x.name))) {
                for (const e of /^en passant removes/.test(base.name) ? [base, S.mirrorEntry(base)] : [base]) {
                    const R = await start(A, e);
                    await A.click(e.move.slice(0, 2));
                    await A.click(e.move.slice(2, 4));
                    if (e.move[4]) await A.promote(e.move[4]); else await A.settle();
                    R.play(e.move);
                    await A.D.waitFor(() => A.D.layer().children.length === 0, { message: 'scene cleared' });
                    assertPosition(A, R, `${e.name} with its scene`);
                    assertSquares(A, e, `${e.name} with its scene`);
                    assertStatus(A, R, `${e.name} with its scene`);
                    assert.equal(await A.undo(), true); R.undo();
                    assertPosition(A, R, `${e.name}: undo after the scene`);
                }
            }
            assert.deepEqual(A.takeErrors(), []);
        } finally { A.close(); }
    });
});

describe('the conformance checks notice the reported kind of bug', () => {
    test('a pawn that may also capture sideways fails the offers check, the click check and the position check', async () => {
        const A = await open2d(); // the rule is broken in this page only
        try {
            A.D.g(`{
                const real = getPawnMoves;
                getPawnMoves = function (r, c, piece) {
                    const moves = real(r, c, piece);
                    for (const dc of [-1, 1]) {
                        const beside = getPieceAt(r, c + dc);
                        if (beside && beside.toUpperCase() === 'P' && !isPlayerPiece(beside, getPlayerForPiece(piece))) {
                            moves.push({ row: r, col: c + dc, isEnPassant: false, isCastling: false, isPromotion: false });
                        }
                    }
                    return moves;
                };
            }`);
            const R = await start(A, { fen: '4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1' });
            await assert.rejects(assertOffers(A, R, 'broken rule'), /2d targets offered for e5/);
            await assert.rejects(assertInertClicks(A, R, 'broken rule'), /clicking e5 then d5 \(not offered\) changed the game/);
            await A.settle();
            assert.equal(A.D.pieceAt('d5'), 'P', 'the broken page did play e5xd5');
            assert.throws(() => assertPosition(A, R, 'broken rule'), /2d position/);
        } finally { A.close(); }
        assertShown(await open(), 'the shared page is untouched');
    });
});
