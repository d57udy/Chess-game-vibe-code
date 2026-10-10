'use strict';
// Coach journeys on the real page (index.html + main.js, real controller, coach, units and engine
// analysis; only the AI opponent's moves are scripted), written from what a player expects to see:
//   A. Coach on, "Every move": every move of a coached player gets visible feedback; the other
//      frequency does what its label says; settings survive reload and New game.
//   B. A real threat by the opponent is warned about before the player moves, without the answer.
//   C. "Take it back" and "Show me better" work, repeatedly, vs AI and Human vs Human, after Undo.
// The review journeys (D, E) are in battle3dReviewJourneys.test.js; the driver is helpers/battle3dCoachJourney.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootJourney } = require('../helpers/battle3dCoachJourney');

const skip = findThree() ? false : 'three.js not installed';
let J, P, $, visible, button, st, card, sq, unitBoard, liveBoard, pendingAI, settle, idle, pause, setSelect, setCheck, fresh, human, ai, play, feedbackSince, warningSince, QUIET, QUEEN, REVIEW, reviewGame, reviewDialog, listed, moments, momentFor, isMarked, prevBtn, nextBtn, openReview, backToGame, backToReview, reviewReachable;

describe('battle3d coach journeys (real page)', { skip }, () => {
    before(async () => {
        J = await bootJourney({ settings: { coach: true, coachFrequency: 'mistakes' } });
        ({ P, $, visible, button, st, card, sq, unitBoard, liveBoard, pendingAI, settle, idle, pause, setSelect, setCheck, fresh, human, ai, play, feedbackSince, warningSince, QUIET, QUEEN, REVIEW, reviewGame, reviewDialog, listed, moments, momentFor, isMarked, prevBtn, nextBtn, openReview, backToGame, backToReview, reviewReachable } = J);
    });
    after(() => { if (J) J.restore(); });

    describe('A. feedback on every move, frequency, persistence', () => {
        test('reload: coach on and "Mistakes only" from the last session are restored', () => {
            assert.equal($('coach-toggle').checked, true, 'coach toggle restored');
            assert.equal($('coach-frequency').value, 'mistakes', 'frequency restored');
            assert.equal(P.B.coach.state().enabled, true);
            assert.equal(visible($('coach-frequency')) && !$('coach-frequency').disabled, true, 'frequency usable while the coach is on');
        });

        test('settings are saved when changed and survive New game', async () => {
            await fresh({ coach: true, frequency: 'every' });
            const saved = () => JSON.parse(P.w.localStorage.getItem('battle3d.settings'));
            assert.equal(saved().coach, true);
            assert.equal(saved().coachFrequency, 'every');
            setSelect('coach-frequency', 'mistakes');
            assert.equal(saved().coachFrequency, 'mistakes');
            $('new-game').click();
            await idle();
            assert.equal($('coach-toggle').checked, true);
            assert.equal($('coach-frequency').value, 'mistakes');
            setCheck('coach-toggle', false);
            assert.equal(saved().coach, false);
            $('new-game').click();
            await idle();
            assert.equal($('coach-toggle').checked, false, 'coach stays off after New game');
        });

        for (const [name, opts, humans] of [
            ['vs AI as White', { mode: 'human-ai', side: 'w' }, ['w']],
            ['vs AI as Black', { mode: 'human-ai', side: 'b' }, ['b']],
            ['Human vs Human', { mode: 'human-human' }, ['w', 'b']],
        ]) {
            test(`"Every move", ${name}: each of 10 ordinary moves by a coached player gets visible feedback`, async () => {
                await fresh({ ...opts, frequency: 'every' });
                const silent = [], texts = [];
                await play(QUIET, humans, async (move, color, before, i) => {
                    const f = await feedbackSince(before);
                    if (!f.ok) silent.push(`${Math.floor(i / 2) + 1}${color === 'w' ? '.' : '...'}${move}`);
                    else texts.push(f.text);
                });
                assert.deepEqual(silent, [], `moves without any coach feedback (${texts.length} of ${QUIET.length * humans.length / 2} got some)`);
                assert.deepEqual(P.errors, []);
            });
        }

        test('"Mistakes only": ordinary moves stay quiet, a blunder is explained', async () => {
            await fresh({ frequency: 'mistakes' });
            const noisy = [];
            await play(QUIET.slice(0, 8), ['w'], async (move, color, before) => {
                const f = await feedbackSince(before, { ms: 250 });
                if (f.ok && f.actions) noisy.push(`${move}: ${f.text}`);
                else if (f.ok && !/threat|careful|look out|unguarded|undefended|eyeing|danger/i.test(f.text)) noisy.push(`${move}: ${f.text}`);
            });
            assert.deepEqual(noisy, [], 'verdicts or praise on ordinary moves in "Mistakes only"');
            await fresh({ frequency: 'mistakes' });
            let blunder = null;
            await play(QUEEN.slice(0, 5), ['w'], async (move, color, before) => { if (move === 'h5f7') blunder = await feedbackSince(before); });
            assert.ok(blunder.ok, 'the queen blunder gets a card');
            assert.ok(blunder.actions && blunder.undo, `with "Take it back" (${blunder.text})`);
        });
    });

    describe('B. threat warnings before the move', () => {
        test('as Black: a mate threat (Qh5 + Bc4) is warned about before moving, without the answer', async () => {
            await fresh({ side: 'b' });
            await play(['e2e4', 'e7e5', 'd1h5', 'b8c6'], ['b']);
            const before = J.shows();
            await ai('f1c4'); // threatens Qxf7#
            const f = await warningSince(before);
            assert.ok(f.ok, `a warning appears while it is the player's turn (card: "${f.text}")`);
            assert.equal(st().turn, 'b');
            assert.doesNotMatch(f.warn, /\b(g6|e7|f6|h6)\b|queen to (e7|f6)|pawn to g6/i, `no defence given away: "${f.warn}"`);
            assert.equal(st().hint, null, 'no arrow');
            assert.equal(f.better, false, 'no "Show me better" on a warning');
        });

        test('as White: an attacked queen (Qh5 Nf6) is warned about before moving', async () => {
            await fresh({ side: 'w' });
            await play(['e2e4', 'e7e5', 'd1h5'], ['w']);
            const before = J.shows();
            await ai('g8f6');
            const f = await warningSince(before);
            assert.ok(f.ok, `a warning appears (card: "${f.text}")`);
            assert.doesNotMatch(f.warn, /\b(e5|f3|e2|g4|h4)\b/, `no answer given away: "${f.warn}"`);
            assert.equal(st().hint, null);
        });

        test('no warning when nothing is threatened (first quiet moves)', async () => {
            await fresh({ side: 'w', frequency: 'every' });
            await human('e2e4');
            const before = J.shows();
            await ai('e7e5');
            const f = await warningSince(before, { ms: 250 });
            assert.ok(!f.ok || !/threat|mate|eyeing|danger|look out|careful/i.test(f.warn), `false alarm: "${f.warn}"`);
        });
    });

    describe('C. Take it back and Show me better', () => {
        const PRE = ['e2e4', 'e7e5', 'd1h5', 'b8c6'];
        const blunder = async () => { const before = J.shows(); await human('h5f7'); const f = await feedbackSince(before); assert.ok(f.ok && f.actions, `blunder card with actions (${JSON.stringify(f)})`); return f; };
        const backBeforeBlunder = async (what) => {
            await settle(() => st().history.length === 4 && !st().moving, { label: what });
            await idle();
            assert.equal(st().turn, 'w', `${what}: White to move again`);
            assert.equal(P.board()[3][7], 'Q', `${what}: the queen is back on h5`);
            assert.equal(unitBoard(), liveBoard(), `${what}: 3D pieces match the game`);
        };

        test('vs AI: Take it back before the AI answers, again after it answered, then Show me better', async () => {
            await fresh({ side: 'w' });
            await play(PRE, ['w']);
            await blunder();
            $('coach-undo').click();
            await backBeforeBlunder('take back before the AI reply');
            assert.equal(card().actions, false, 'the mistake card is gone after taking back');
            await pause(60);
            P.B.step(30);
            assert.equal(st().history.length, 4, 'the cancelled AI reply never lands');

            await blunder();
            await ai('e8f7');
            assert.ok(card().visible && card().undo, 'the card is still there after the AI replied');
            $('coach-undo').click();
            await backBeforeBlunder('take back after the AI reply');

            const f = await blunder();
            assert.ok(f.better, '"Show me better" offered');
            $('coach-better').click();
            await backBeforeBlunder('show me better');
            await settle(() => !!st().hint, { label: 'suggestion arrow' });
            const h = st().hint;
            assert.notDeepEqual([h.from, h.to], [{ row: 3, col: 7 }, { row: 1, col: 5 }], 'the suggestion is not the blunder');
            assert.ok(card().visible && card().text, 'the coach says what to try');
            const n = st().history.length;
            // The suggested piece may already be selected for the player; then only the target is clicked
            const sel = st().selected;
            if (!(sel && sel.row === h.from.row && sel.col === h.from.col)) P.B.controller.clickSquare(h.from.row, h.from.col);
            P.B.controller.clickSquare(h.to.row, h.to.col);
            await settle(() => st().history.length === n + 1, { label: `playing the suggested move ${JSON.stringify(h)} (state ${JSON.stringify({ turn: st().turn, moving: st().moving, thinking: st().thinking, selected: st().selected, history: st().history, review: st().reviewIndex })})` });
            assert.deepEqual(P.errors, []);
        });

        test('Show me better: clicking the suggested piece and then the target plays the move', async () => {
            await fresh({ side: 'w' });
            await play(PRE, ['w']);
            await blunder();
            $('coach-better').click();
            await backBeforeBlunder('show me better');
            await settle(() => !!st().hint, { label: 'suggestion arrow' });
            const h = st().hint, n = st().history.length;
            // what a player does on seeing the arrow: click the piece it starts from, then where it points
            P.B.controller.clickSquare(h.from.row, h.from.col);
            P.B.controller.clickSquare(h.to.row, h.to.col);
            const moved = await settle(() => st().history.length === n + 1, { ms: 1500, soft: true });
            assert.ok(moved, 'clicking the arrow\'s piece and then its target makes the move (a click on the pre-selected piece must not put it down)');
        });

        test('vs AI: after the Undo button the coach still reacts and both actions still work', async () => {
            await fresh({ side: 'w' });
            await play(PRE, ['w']);
            await blunder();
            await ai('e8f7');
            $('undo').click();
            await backBeforeBlunder('Undo button');
            assert.equal(card().actions, false, 'no stale mistake card after Undo');
            await blunder();
            $('coach-better').click();
            await backBeforeBlunder('show me better after Undo');
            await settle(() => !!st().hint, { label: 'suggestion arrow after Undo' });
            await blunder();
            $('coach-undo').click();
            await backBeforeBlunder('take back after Undo');
        });

        test('Human vs Human: both players get the actions; they undo one move', async () => {
            await fresh({ mode: 'human-human' });
            await play(PRE, ['w', 'b']);
            await blunder();
            $('coach-undo').click();
            await backBeforeBlunder('HvH take back (White)');
            await human('g1f3');
            const before = J.shows();
            await human('d8h4'); // Black hangs the queen to Nxh4
            const f = await feedbackSince(before);
            assert.ok(f.ok && f.actions && f.better, `Black's blunder card (${JSON.stringify(f)})`);
            $('coach-better').click();
            await settle(() => st().history.length === 5 && !st().moving, { label: 'HvH show me better' });
            assert.equal(st().turn, 'b');
            assert.equal(P.board()[0][3], 'q', 'Black queen back on d8');
            await settle(() => !!st().hint, { label: 'suggestion for Black' });
        });
    });

});
