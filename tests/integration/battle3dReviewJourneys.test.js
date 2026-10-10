'use strict';
// Game review journeys on the real page (see battle3dCoachJourneys.test.js for A to C):
//   D. Review: open, pick a flagged move, see the past position, keep the review reachable, step
//      prev/next, return to the exact live game; input locked and no AI move while in the past.
//   E. Edge cases: 0 moves, AI thinking, after undo, after New game, talk Off, coach Off, narrow
//      viewport, Escape and focus.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootJourney } = require('../helpers/battle3dCoachJourney');

const skip = findThree() ? false : 'three.js not installed';
let J, P, $, visible, button, st, card, sq, unitBoard, liveBoard, pendingAI, settle, idle, pause, setSelect, setCheck, fresh, human, ai, play, feedbackSince, warningSince, QUIET, QUEEN, REVIEW, reviewGame, reviewDialog, listed, moments, momentFor, isMarked, prevBtn, nextBtn, openReview, backToGame, backToReview, reviewReachable;

describe('battle3d review journeys (real page)', { skip }, () => {
    before(async () => {
        J = await bootJourney({ settings: { coach: true } });
        ({ P, $, visible, button, st, card, sq, unitBoard, liveBoard, pendingAI, settle, idle, pause, setSelect, setCheck, fresh, human, ai, play, feedbackSince, warningSince, QUIET, QUEEN, REVIEW, reviewGame, reviewDialog, listed, moments, momentFor, isMarked, prevBtn, nextBtn, openReview, backToGame, backToReview, reviewReachable } = J);
    });
    after(() => { if (J) J.restore(); });

    describe('D. game review', () => {
        test('open: the flagged moves of the coached player are listed with a summary and a graph', async () => {
            const G = await reviewGame();
            await openReview();
            assert.ok(momentFor('Nxe5'), `3.Nxe5 listed: ${moments().map((b) => b.textContent)}`);
            assert.ok(momentFor('Qxf7'), `5.Qxf7+ listed: ${moments().map((b) => b.textContent)}`);
            assert.deepEqual(moments().filter((b) => /\.\.\.|\bai\b/.test(`${b.textContent} ${b.className}`)).map((b) => b.textContent), [], 'only the coached player\'s moves (White) are flagged');
            assert.ok($('coach-review-intro').textContent.trim().length > 10, 'a summary sentence');
            assert.ok($('coach-review-graph').querySelector('path, polyline'), 'an evaluation graph');
            assert.equal(st().fen, G.fen, 'opening the review does not change the game');
        });

        test('click a flagged move: the board shows that past position and the review stays reachable', async () => {
            const G = await reviewGame();
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            assert.ok([G.boards[4], G.boards[5]].includes(unitBoard()), 'the 3D board shows the position around 3.Nxe5');
            assert.notEqual(unitBoard(), G.boards[10], 'not the live position');
            assert.equal(st().fen, G.fen, 'the game itself is untouched');
            assert.ok(reviewReachable(), 'the review panel stays open or a visible "Back to review" control exists');
            assert.ok(backToGame(), 'a visible "Return to game" control');
        });

        test('prev / next step through the game while reviewing', async () => {
            const G = await reviewGame();
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            const start = st().reviewIndex;
            const next = nextBtn(), prev = prevBtn();
            assert.ok(next && prev, 'visible Previous and Next controls');
            next.click();
            await settle(() => st().reviewIndex !== start, { label: 'next' });
            assert.ok(st().reviewIndex > start, 'Next goes forward');
            assert.equal(unitBoard(), G.boards[st().reviewIndex], 'board follows Next');
            // A flagged move may show the position before it, which is also the position after the move before:
            // allow one extra Previous before the board has to change to an earlier position.
            for (let i = 0; i < 3 && !(st().reviewIndex < start); i++) { prevBtn().click(); await settle(() => true, { ms: 20 }); await pause(10); }
            await settle(() => st().reviewIndex < start, { label: 'Previous reaches an earlier position within 3 clicks' });
            assert.equal(unitBoard(), G.boards[st().reviewIndex], 'board follows Previous');
            assert.equal(st().fen, G.fen);
        });

        test('while viewing the past: input is locked; Return to game restores the exact live position and turn', async () => {
            const G = await reviewGame();
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            await human('a2a3', { expectMove: false });
            await pause(30);
            assert.equal(st().selected, null, 'clicking a piece does not select it');
            assert.deepEqual(st().history, G.history, 'no move can be made in the past');
            const back = backToGame();
            assert.ok(back, 'a visible "Return to game" control');
            back.click();
            await settle(() => st().reviewIndex === null, { label: 'return to game' });
            await idle();
            assert.equal(st().fen, G.fen, 'exact live position');
            assert.equal(st().turn, 'w', 'same side to move');
            assert.equal(unitBoard(), G.boards[10], '3D board back on the live position');
            assert.equal(visible($('review-bar')), false, 'review bar gone');
            await human('d2d3');
            assert.equal(st().history.length, 11, 'the game continues');
        });

        test('reopening the review keeps the selected move', async () => {
            await reviewGame();
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            const shown = unitBoard();
            assert.equal(listed().filter(isMarked).length, 1, 'exactly one move is marked as selected');
            // put the panel away (minimise if there is such a control) and come back
            const min = button(/minimi[sz]e|hide review/i);
            if (min) { min.click(); await settle(() => !visible(reviewDialog()), { label: 'minimised' }); }
            if (!visible(reviewDialog())) {
                const again = backToReview() || $('coach-review-open');
                assert.ok(again && visible(again), 'a visible way back to the review');
                again.click();
                await settle(() => visible(reviewDialog()), { label: 'review again' });
            }
            const marked = listed().filter(isMarked);
            assert.equal(marked.length, 1, 'exactly one move is marked as selected after reopening');
            assert.match(marked[0].textContent, /Nxe5/);
            assert.equal(unitBoard(), shown, 'the board still shows the selected position');
        });

        test('the game end opens the review by itself (fool\'s mate) and a flagged move can be inspected', async () => {
            await fresh({ side: 'w' });
            await play(['f2f3', 'e7e5', 'g2g4', 'd8h4'], ['w']);
            assert.equal(st().over, true);
            await settle(() => visible(reviewDialog()), { ms: 2500, label: 'review after the game ended' });
            assert.ok(moments().length >= 1, 'the losing moves are flagged');
            moments()[0].click();
            await settle(() => st().reviewIndex !== null, { label: 'past position after game end' });
            assert.ok(reviewReachable(), 'review reachable after the game ended');
        });
    });

    describe('E. edge cases', () => {
        test('0 moves: the review opens with a sensible message, nothing to click, no errors', async () => {
            await fresh();
            await openReview();
            assert.equal(moments().length, 0);
            const intro = $('coach-review-intro').textContent.trim();
            assert.ok(intro.length > 10, 'says something');
            assert.doesNotMatch(intro, /fine game|well played|tough loss|turning point|close one/i, `does not judge a game that has not started: "${intro}"`);
            assert.deepEqual(P.errors, []);
        });

        test('while the AI is thinking: viewing the past holds the AI move until the player returns', async () => {
            await fresh({ side: 'w' });
            await play(QUEEN.slice(0, 6), ['w']);
            await human('g1f3');
            await settle(() => !!pendingAI(), { label: 'AI thinking' });
            await openReview();
            momentFor('Qxf7').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            const shown = unitBoard();
            const call = pendingAI();
            if (call) { call.done = true; call.resolve({ from: { row: 0, col: 6 }, to: { row: 2, col: 5 } }); }
            await pause(60);
            P.B.step(60);
            assert.notEqual(st().reviewIndex, null, 'still viewing the past');
            assert.equal(unitBoard(), shown, 'no AI move is played on the board being reviewed');
            const back = backToGame();
            assert.ok(back, 'a visible "Return to game" control');
            back.click();
            await settle(() => st().reviewIndex === null, { label: 'return' });
            if (st().history.length === 7) await ai('g8f6');
            await idle();
            assert.equal(st().history.length, 8, 'the AI reply arrives once after returning');
            assert.equal(st().turn, 'w');
            assert.equal(unitBoard(), liveBoard());
        });

        test('after Undo: undone moves leave the review', async () => {
            await reviewGame();
            $('undo').click(); // takes back 5.Qxf7+ Kxf7
            await settle(() => st().history.length === 8 && !st().moving, { label: 'undo' });
            await openReview();
            assert.ok(momentFor('Nxe5'), 'earlier flagged move kept');
            assert.equal(momentFor('Qxf7'), undefined, `undone move gone: ${moments().map((b) => b.textContent)}`);
        });

        test('after New game: no stale card, moments or review position', async () => {
            await reviewGame();
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            $('new-game').click();
            await idle();
            assert.equal(st().reviewIndex, null);
            assert.equal(listed().length, 0, 'an open review shows no moves of the old game');
            assert.equal(visible($('review-bar')), false);
            assert.equal(card().actions, false, 'no mistake card from the old game');
            assert.equal(unitBoard(), liveBoard());
            if (!visible(reviewDialog())) await openReview();
            assert.equal(moments().length, 0, 'no moments from the old game');
            assert.doesNotMatch($('coach-review-intro').textContent, /blunder|mistake|flagged/i, 'no summary of the old game');
        });

        test('Kings talk Off: the coach still gives feedback and warnings', async () => {
            await fresh({ side: 'w', talk: 'off' });
            await play(QUEEN.slice(0, 4), ['w']);
            const before = J.shows();
            await human('h5f7');
            const f = await feedbackSince(before);
            assert.ok(f.ok && f.actions, 'blunder card with talk Off');
        });

        test('Coach Off: no card at all; turning it on mid-game explains the very next blunder', async () => {
            await fresh({ side: 'w', coach: false });
            const before = J.shows();
            await play(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f3e5', 'c6e5', 'd1h5', 'e5c6'], ['w']); // a knight lost, unnoticed
            await pause(80);
            assert.equal(J.shows(), before, 'the card never appears');
            assert.equal(card().visible, false);
            setCheck('coach-toggle', true);
            assert.equal(visible($('coach-review-open')), true, 'Review button available');
            const b2 = J.shows();
            await human('h5f7');
            const f = await feedbackSince(b2);
            assert.ok(f.ok && f.actions, `the very next blunder is explained after switching the coach on mid-game (${JSON.stringify(f)})`);
            setCheck('coach-toggle', false);
            assert.equal(card().visible, false, 'switching off hides the card at once');
        });

        test('Escape and focus: the dialog takes focus, Escape closes it and returns focus; Escape leaves the past', async () => {
            const G = await reviewGame();
            J.clearFocused();
            const opener = await openReview();
            assert.ok(J.focused().some((el) => reviewDialog().contains(el)), 'focus moves into the review dialog');
            J.clearFocused();
            P.key('Escape');
            await settle(() => !visible(reviewDialog()), { label: 'Escape closes the review' });
            assert.ok(J.focused().includes(opener), 'focus returns to the control that opened it');
            assert.equal(st().fen, G.fen);
            await openReview();
            momentFor('Nxe5').click();
            await settle(() => st().reviewIndex !== null, { label: 'past position' });
            for (let i = 0; i < 3 && st().reviewIndex !== null; i++) { P.key('Escape'); await pause(10); }
            assert.equal(st().reviewIndex, null, 'Escape (at most twice) gets back to the live game');
            assert.equal(unitBoard(), G.boards[10]);
            assert.deepEqual(P.errors, []);
        });

        test('narrow viewport (360 px): the card, its actions and the review still work', async () => {
            P.w.innerWidth = 360; P.w.innerHeight = 640;
            P.w.dispatchEvent(new P.w.Event('resize'));
            try {
                await fresh({ side: 'w' });
                await play(QUEEN.slice(0, 4), ['w']);
                const before = J.shows();
                await human('h5f7');
                const f = await feedbackSince(before);
                assert.ok(f.ok && f.undo && f.better, 'card with both actions');
                await openReview();
                assert.ok(momentFor('Qxf7'));
                assert.deepEqual(P.errors, []);
            } finally {
                P.w.innerWidth = 1024; P.w.innerHeight = 768;
                P.w.dispatchEvent(new P.w.Event('resize'));
            }
        });
    });
});
