'use strict';
// Controller hooks for saving and loading games (battle3d/controller.js, used by savegame.js):
//   loadGame(apply, settings)  replaces the whole game without animating, from any state
//   'change' events            fire synchronously whenever the rules state or the game settings changed
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

function withCtl(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const C = await loadBattle3dController(options);
        const events = [];
        C.controller.onEvent((e) => events.push({ type: e.type, reason: e.reason, ply: e.ply }));
        C.events = events;
        C.of = (type) => events.filter((e) => e.type === type).map((e) => e.reason);
        try { await fn(C); } finally { C.close(); }
    };
}
// What savegame.js does: a fresh game plus the moves, applied silently through rules.js
const replay = (C, moves) => () => {
    C.g('battle3dNewGame()');
    for (const mv of moves) C.g(`battle3dApplyMove(${JSON.stringify(square(mv.slice(0, 2)))}, ${JSON.stringify(square(mv.slice(2, 4)))}, null)`);
    return { ok: true, plies: moves.length };
};
const EP_GAME = ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'];
const moveList = (C) => [...C.doc.querySelectorAll('#move-list .mv')].map((e) => e.textContent);

describe('battle3d controller: change events', () => {
    test('a move, undo, new game, loadFen and the game settings each report a change, synchronously', withCtl(async (C) => {
        C.controller.setMode('human-human');
        assert.deepEqual(C.of('change'), ['settings']);
        C.events.length = 0;
        await C.click('e2');
        C.scene.click(square('e4').row, square('e4').col);
        assert.deepEqual(C.of('change'), ['move'], 'reported before the animation ends');
        assert.equal(C.events.find((e) => e.type === 'change').ply, 1, 'the move is already in the rules state');
        assert.equal(C.events.some((e) => e.type === 'moveDone'), false);
        await C.flush();
        C.events.length = 0;
        C.button('undo').click();
        assert.deepEqual(C.of('change'), ['undo']);
        await C.play('e2e4');
        C.events.length = 0;
        assert.equal(C.controller.undoTo(0), true);
        assert.deepEqual(C.of('change'), ['undo']);
        C.events.length = 0;
        C.button('new-game').click();
        assert.deepEqual(C.of('change'), ['newGame']);
        C.events.length = 0;
        C.controller.loadFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
        assert.deepEqual(C.of('change'), ['loadFen']);
        C.events.length = 0;
        C.controller.setHumanColor('b');
        C.controller.setElo(1800);
        C.controller.setMode('human-ai');
        assert.deepEqual(C.of('change'), ['settings', 'settings', 'settings']);
        C.events.length = 0;
        C.controller.setSpeed('fast');
        C.controller.setLabels(false);
        assert.deepEqual(C.of('change'), [], 'view settings are not game settings');
        assert.deepEqual(C.errors, []);
    }));
});

describe('battle3d controller: loadGame', () => {
    test('replaces the game, applies the settings, redraws without animating and reports it', withCtl(async (C) => {
        await C.play('d2d4');
        C.events.length = 0;
        const animated = C.units.calls.playMove.length;
        const result = C.controller.loadGame(replay(C, EP_GAME), { mode: 'human-human', humanColor: 'b', elo: 1730 });
        assert.deepEqual(result, { ok: true, plies: 5 }, 'returns what apply() returned');
        await C.flush();
        const s = C.state();
        assert.deepEqual(s.history, ['e4', 'a6', 'e5', 'd5', 'exd6'], 'standard SAN in the history');
        assert.deepEqual([s.mode, s.humanColor, s.elo, s.turn, s.moving, s.reviewIndex], ['human-human', 'b', 1700, 'b', false, null]);
        assert.deepEqual(C.settings().mode, 'human-human', 'settings are saved');
        assert.deepEqual(C.units.grid(), C.get('board'), 'units show the loaded position');
        assert.equal(C.units.calls.playMove.length, animated, 'nothing was animated');
        assert.deepEqual(moveList(C), ['e4', 'a6', 'e5', 'd5', 'exd6 e.p.'], 'the move list shows the loaded game, en passant marked');
        assert.deepEqual(C.scene.calls.setHighlights.at(-1).lastMove, { from: square('e5'), to: square('d6'), captured: square('d5') });
        assert.equal(C.scene.calls.setView.at(-1), 'b', 'the camera follows the loaded side');
        const types = C.events.map((e) => `${e.type}${e.reason ? ':' + e.reason : ''}`);
        assert.deepEqual(types.filter((t) => /^(reset|change|gameStart|turn)/.test(t)), ['reset:loadGame', 'change:loadGame', 'turn']);
        // The loaded game simply continues
        await C.play('c7d6');
        assert.equal(C.state().history.at(-1), 'cxd6');
        assert.deepEqual(C.errors, []);
    }));

    test('works during a move animation, in review and with the promotion dialog open; a late AI answer is dropped', withCtl({ units: 'manual' }, async (C) => {
        // The AI is thinking, then a human move is still animating
        await C.play('e2e4');
        await C.step(0.3);
        const pending = C.aiCalls().at(-1);
        C.controller.loadGame(replay(C, ['d2d4']), { mode: 'human-human' });
        assert.equal(pending.cancelled, true);
        pending.resolve({ from: square('d7'), to: square('d5') });
        await C.flush();
        assert.deepEqual(C.state().history, ['d4']);
        await C.click('e7');
        C.scene.click(square('e5').row, square('e5').col);
        assert.equal(C.state().moving, true);
        C.controller.loadGame(replay(C, EP_GAME));
        await C.flush();
        assert.equal(C.state().moving, false);
        assert.deepEqual(C.state().history, ['e4', 'a6', 'e5', 'd5', 'exd6']);
        assert.deepEqual(C.units.grid(), C.get('board'));
        // In review
        assert.equal(C.controller.enterReview(2), true);
        C.controller.loadGame(replay(C, ['g1f3']));
        assert.equal(C.state().reviewIndex, null);
        assert.equal(C.doc.getElementById('review-bar').hidden, true);
        assert.deepEqual(C.state().history, ['Nf3']);
        // Promotion dialog open
        C.controller.loadFen('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await C.click('a7');
        await C.click('a8');
        assert.ok(C.state().pendingPromotion);
        C.controller.loadGame(replay(C, ['e2e4', 'e7e5']));
        assert.equal(C.state().pendingPromotion, null);
        assert.equal(C.doc.getElementById('promo').hidden, true);
        assert.deepEqual(C.state().history, ['e4', 'e5']);
        assert.deepEqual(C.units.grid(), C.get('board'));
        assert.deepEqual(C.errors, []);
    }));

    test('human vs AI: the AI moves when the loaded position is its turn; a finished game stays finished', withCtl(async (C) => {
        C.controller.loadGame(replay(C, ['e2e4']), { mode: 'human-ai', humanColor: 'w' });
        await C.step(0.3);
        const call = C.aiCalls().at(-1);
        assert.equal(call.state.currentPlayer, 'b');
        assert.equal(call.cancelled, false);
        await C.answerAI('e7e5');
        assert.deepEqual(C.state().history, ['e4', 'e5']);
        const calls = C.aiCalls().length;
        C.controller.loadGame(replay(C, ['f2f3', 'e7e5', 'g2g4', 'd8h4']));
        await C.step(0.5);
        assert.equal(C.state().over, true);
        assert.equal(C.state().result, 'checkmate');
        assert.equal(C.aiCalls().length, calls, 'no AI request after mate');
        await C.click('e2');
        assert.equal(C.state().selected, null, 'input stays locked');
        assert.deepEqual(C.errors, []);
    }));

    test('a failed load keeps the game: { ok: false } or a throw, no settings applied, reason "loadFailed"', withCtl(async (C) => {
        C.controller.setMode('human-human');
        for (const mv of ['e2e4', 'e7e5']) await C.play(mv);
        const fen = C.state().fen;
        C.events.length = 0;
        const refused = C.controller.loadGame(() => ({ ok: false, error: 'illegal move 3' }), { mode: 'ai-ai', elo: 2000 });
        assert.deepEqual(refused, { ok: false, error: 'illegal move 3' });
        assert.deepEqual([C.state().fen, C.state().mode, C.state().elo], [fen, 'human-human', 1200]);
        assert.deepEqual(C.of('reset'), ['loadFailed']);
        assert.deepEqual(C.of('change'), []);
        const thrown = C.controller.loadGame(() => { throw new Error('boom'); });
        assert.equal(thrown.ok, false);
        assert.match(thrown.error, /boom/);
        assert.equal(C.state().fen, fen);
        assert.ok(C.errors.some((e) => /loadGame failed/.test(e)), 'the failure is logged');
        await C.play('g1f3');
        assert.deepEqual(C.state().history, ['e4', 'e5', 'Nf3'], 'the old game continues');
    }));

    test('before the first new game (boot from an autosave)', async () => {
        const C = await loadBattle3dController({ newGame: false });
        try {
            const result = C.controller.loadGame(replay(C, EP_GAME), { mode: 'human-human' });
            await C.flush();
            assert.equal(result.ok, true);
            assert.deepEqual(C.state().history, ['e4', 'a6', 'e5', 'd5', 'exd6']);
            assert.deepEqual(C.units.grid(), C.get('board'));
            assert.deepEqual(C.errors, []);
        } finally { C.close(); }
    });
});
