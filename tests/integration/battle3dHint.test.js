'use strict';
// v5 3D hint (controller.js) with fake scene/units/AI: button + H key only on the human's turn,
// hint-mode request, arrow/gesture/status/announce, pre-selection, clearing and cancelling on
// move / select / Esc / undo / new game / mode change, no stale or illegal hints.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

function withCtl(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const C = await loadBattle3dController({ audio: true, ...options });
        try { await fn(C); } finally { C.close(); }
    };
}
const btn = (C) => C.button('hint');
const last = (arr) => arr[arr.length - 1];
const hintCall = (C) => [...C.aiCalls()].reverse().find((c) => c.options && c.options.hint);
async function answerHint(C, mv) {
    const call = hintCall(C);
    const f = square(mv.slice(0, 2)), t = square(mv.slice(2, 4));
    call.resolve({ from: f, to: t, isPromotion: !!mv[4], promotionPiece: mv[4] ? mv[4].toUpperCase() : null });
    await C.flush();
}
const pressH = (C, extra = {}, target) => {
    const e = new C.w.KeyboardEvent('keydown', { key: 'h', code: 'KeyH', bubbles: true, cancelable: true, ...extra });
    (target || C.doc.body).dispatchEvent(e);
    return e;
};

describe('battle3d hint (v5)', () => {
    test('button exists, enabled on the human turn; request is full-strength hint mode', withCtl(async (C) => {
        assert.ok(btn(C), '#hint button');
        assert.equal(btn(C).disabled, false);
        btn(C).click();
        await C.flush();
        const call = hintCall(C);
        assert.ok(call, 'requestAIMove called with { hint: true }');
        assert.equal(call.options.hint, true);
        assert.ok(call.elo >= 2400, `full strength elo ${call.elo}`);
        assert.equal(call.state.currentPlayer, 'w');
        assert.equal(C.state().hintPending, true);
        assert.equal(btn(C).disabled, true, 'disabled while pending');
        assert.ok(btn(C).classList.contains('busy'));
        assert.equal(btn(C).getAttribute('aria-busy'), 'true');
        assert.match(C.status(), /hint/i);
    }));

    test('result: arrow, gesture, pre-selection, status and announcement; clicking the target plays it', withCtl(async (C) => {
        btn(C).click();
        await C.flush();
        await answerHint(C, 'g1f3');
        const s = C.state();
        assert.deepEqual(s.hint, { from: square('g1'), to: square('f3'), capture: false });
        assert.equal(s.hintPending, false);
        assert.deepEqual(s.selected, square('g1'), 'hinted unit pre-selected');
        assert.deepEqual(last(C.scene.calls.setHint), { from: square('g1'), to: square('f3'), capture: false });
        await C.flush();
        assert.deepEqual(C.units.calls.playHint, [square('g1')]);
        assert.ok(!C.audio.played.includes('select'), 'the units gesture makes the sound, not the controller');
        assert.equal(C.status().includes('Hint: knight to f3.'), true, C.status());
        assert.equal(C.announced(), 'Hint: knight to f3.');
        assert.equal(btn(C).classList.contains('busy'), false);
        assert.equal(C.units.calls.playMove.length, 0, 'the hint is not auto-played');
        await C.click('f3');
        assert.equal(C.units.calls.playMove.length, 1);
        assert.deepEqual(C.units.calls.playMove[0].to, square('f3'));
        assert.equal(C.state().hint, null, 'cleared by the move');
        assert.equal(last(C.scene.calls.setHint), null);
    }));

    test('H key works; with ctrl/meta/alt, while typing, or with a modal open it does nothing', withCtl(async (C) => {
        for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
            pressH(C, mod);
            await C.flush();
        }
        pressH(C, {}, C.button('mode-select'));
        await C.flush();
        assert.equal(hintCall(C), undefined, 'no request from modified keys or typing');
        C.doc.getElementById('promo').hidden = false; // any .modal open
        pressH(C);
        await C.flush();
        assert.equal(hintCall(C), undefined, 'no request with a modal open');
        C.doc.getElementById('promo').hidden = true;
        const e = pressH(C);
        await C.flush();
        assert.ok(hintCall(C), 'H requests a hint');
        assert.equal(e.defaultPrevented, true);
        pressH(C, { key: 'H' });
        await C.flush();
        assert.equal(C.aiCalls().filter((c) => c.options?.hint).length, 1, 'no second request while one is pending');
    }));

    test('hint texts: capture, en passant, promotion, castling', withCtl(async (C) => {
        C.controller.setMode('human-human');
        const cases = [
            ['rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'e4d5', 'Hint: pawn to d5, capture.'],
            ['rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', 'e5f6', 'Hint: pawn to f6, capture.'],
            ['1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8', 'Hint: pawn to a8, promote to queen.'],
            ['1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7b8n', 'Hint: pawn to b8, capture, promote to knight.'],
            ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', 'Hint: castle kingside.'],
            ['r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8c8', 'Hint: castle queenside.'],
        ];
        for (const [fen, mv, text] of cases) {
            C.controller.loadFen(fen);
            await C.flush();
            C.controller.hint();
            await C.flush();
            await answerHint(C, mv);
            assert.equal(C.announced(), text, `${fen} ${mv}`);
            assert.equal(C.state().hint.capture, /capture/.test(text), `${mv} capture flag`);
        }
    }));

    test('human vs human: hints for either side; disabled in AI vs AI', withCtl(async (C) => {
        C.controller.setMode('human-human');
        await C.play('e2e4');
        assert.equal(btn(C).disabled, false, 'Black to move, human');
        C.controller.hint();
        await C.flush();
        assert.equal(hintCall(C).state.currentPlayer, 'b');
        C.controller.setMode('ai-ai');
        await C.flush();
        assert.equal(hintCall(C).cancelled, true, 'mode change cancels the request');
        assert.equal(btn(C).disabled, true);
        pressH(C);
        await C.flush();
        assert.equal(C.aiCalls().filter((c) => c.options?.hint).length, 1);
    }));

    test('disabled while the AI thinks, while a move animates and when the game is over', withCtl({ units: 'manual' }, async (C) => {
        await C.click('e2'); await C.click('e4');
        assert.equal(C.state().moving, true);
        assert.equal(btn(C).disabled, true, 'animating');
        C.controller.hint();
        assert.equal(hintCall(C), undefined);
        C.units.finish();
        await C.flush();
        await C.step(0.3);
        assert.equal(C.state().thinking, true);
        assert.equal(btn(C).disabled, true, 'AI thinking');
        C.controller.hint();
        assert.equal(hintCall(C), undefined);
        await C.answerAI('e7e5');
        assert.equal(btn(C).disabled, false, 'human turn again');
        C.controller.setMode('human-human');
        C.controller.newGame();
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await C.play(mv);
        assert.equal(C.state().over, true);
        assert.equal(btn(C).disabled, true, 'game over');
    }));

    test('disabled while the promotion dialog is open', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.controller.loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await C.click('a7'); await C.click('a8');
        assert.equal(C.doc.getElementById('promo').hidden, false);
        assert.equal(btn(C).disabled, true);
    }));

    for (const [name, act] of [
        ['selecting another piece', async (C) => { await C.click('b1'); }],
        ['deselecting the hinted piece', async (C) => { await C.click('g1'); }],
        ['Esc', async (C) => { C.key('Escape', 'Escape'); await C.flush(); }],
        ['undo', async (C) => { C.controller.undo(); await C.flush(); }],
        ['new game', async (C) => { C.controller.newGame(); await C.flush(); }],
        ['loadFen', async (C) => { C.controller.loadFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1'); await C.flush(); }],
        ['mode change', async (C) => { C.controller.setMode('human-human'); await C.flush(); }],
        ['side switch', async (C) => { C.button('side-b').click(); await C.flush(); }],
    ]) {
        test(`a shown hint clears on ${name}`, withCtl(async (C) => {
            if (name === 'undo') { await C.play('e2e4'); await C.step(0.3); await C.answerAI('e7e5'); }
            C.controller.hint();
            await C.flush();
            await answerHint(C, 'g1f3');
            assert.ok(C.state().hint);
            await act(C);
            assert.equal(C.state().hint, null);
            assert.equal(last(C.scene.calls.setHint), null);
        }));

        test(`a pending hint is cancelled on ${name}; its late answer is ignored`, withCtl(async (C) => {
            if (name === 'undo') { await C.play('e2e4'); await C.step(0.3); await C.answerAI('e7e5'); }
            C.controller.hint();
            await C.flush();
            const call = hintCall(C);
            await act(C);
            assert.equal(call.cancelled || !C.state().hintPending, true);
            assert.equal(call.cancelled, true, 'request cancelled');
            assert.equal(C.state().hintPending, false);
            call.resolve({ from: square('g1'), to: square('f3') });
            await C.flush();
            assert.equal(C.state().hint, null, 'late answer ignored');
            assert.equal(C.units.calls.playHint.length, 0);
        }));
    }

    test('an AI move clears the hint; no stale hint after undo', withCtl(async (C) => {
        C.controller.hint();
        await C.flush();
        await answerHint(C, 'e2e4');
        await C.click('e4'); // play the hint
        await C.step(0.3);
        await C.answerAI('e7e5');
        assert.equal(C.state().hint, null);
        C.controller.hint();
        await C.flush();
        await answerHint(C, 'g1f3');
        C.controller.undo();
        await C.flush();
        assert.equal(C.state().hint, null, 'undo clears');
        assert.equal(C.state().fen.split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
    }));

    test('null, illegal or stale answers show nothing', withCtl(async (C) => {
        C.controller.hint();
        await C.flush();
        hintCall(C).resolve(null);
        await C.flush();
        assert.equal(C.state().hint, null);
        assert.equal(C.state().hintPending, false);
        assert.equal(btn(C).disabled, false, 'can ask again');
        C.controller.hint();
        await C.flush();
        await answerHint(C, 'e2e5'); // illegal
        assert.equal(C.state().hint, null);
        C.controller.hint();
        await C.flush();
        await answerHint(C, 'e7e5'); // opponent's piece
        assert.equal(C.state().hint, null);
        assert.equal(C.units.calls.playHint.length, 0);
        assert.deepEqual(C.errors, []);
    }));

    test('works when scene/units lack setHint/playHint, and when they throw', withCtl(async (C) => {
        C.scene.api.setHint = () => { throw new Error('boom'); };
        C.units.api.playHint = undefined;
        C.controller.hint();
        await C.flush();
        await answerHint(C, 'g1f3');
        assert.ok(C.state().hint, 'hint state still set');
        assert.match(C.announced(), /knight to f3/);
        assert.equal(last(C.audio.played), 'select', 'without a gesture the controller plays select');
    }));
});
