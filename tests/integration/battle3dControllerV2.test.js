'use strict';
// v2 controller features in jsdom with fake scene/units/audio: settings persistence and restore,
// keyboard play (cursor, select, move, cancel, view flip, focus rules), audio cues and mute,
// render keepAlive around moves, and screen reader announcements.
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
const seed = (settings) => (w) => w.localStorage.setItem('battle3d.settings', typeof settings === 'string' ? settings : JSON.stringify(settings));
const lastHover = (C) => C.scene.calls.setHighlights[C.scene.calls.setHighlights.length - 1].hover;

describe('battle3d controller v2: settings', () => {
    test('changes are saved to localStorage', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.button('speed-fast').click();
        C.button('labels-toggle').checked = false;
        C.button('labels-toggle').dispatchEvent(new C.w.Event('change'));
        C.button('mute').click();
        const elo = C.button('elo-slider');
        elo.value = '1800';
        elo.dispatchEvent(new C.w.Event('input'));
        C.controller.setMode('human-ai');
        C.button('side-b').click();
        await C.flush();
        assert.deepEqual(C.settings(), { mode: 'human-ai', humanColor: 'b', elo: 1800, speed: 'fast', labels: false, muted: true, ambience: true });
    }));

    test('saved settings are restored on start and pushed to units/audio', withCtl({ setup: seed({ mode: 'human-human', humanColor: 'b', elo: 2100, speed: 'fast', labels: false, muted: true }) }, async (C) => {
        const s = C.state();
        assert.deepEqual([s.mode, s.humanColor, s.elo, s.speed, s.labels, s.muted], ['human-human', 'b', 2100, 'fast', false, true]);
        assert.equal(C.units.calls.setMode.slice(-1)[0], 'fast');
        assert.equal(C.units.calls.setLabels.slice(-1)[0], false);
        assert.equal(C.audio.muted, true);
        assert.equal(C.button('mute').getAttribute('aria-pressed'), 'true');
        assert.equal(C.button('mode-select').value, 'human-human');
        assert.equal(C.button('elo-slider').value, '2100');
        assert.equal(C.button('labels-toggle').checked, false);
        assert.deepEqual(C.scene.calls.setView.slice(-1), ['b'], 'view from the stored side');
    }));

    test('AI vs AI stored without a speed starts in Fast; a stored speed wins', async () => {
        let C = await loadBattle3dController({ audio: true, setup: seed({ mode: 'ai-ai' }) });
        assert.equal(C.state().speed, 'fast');
        C.close();
        C = await loadBattle3dController({ audio: true, setup: seed({ mode: 'ai-ai', speed: 'full' }) });
        assert.equal(C.state().speed, 'full');
        C.close();
    });

    for (const [name, raw] of [
        ['garbage JSON', '{not json'],
        ['wrong types', { mode: 'chaos', humanColor: 'x', elo: 'abc', speed: 3, labels: 'yes', muted: 1 }],
        ['out of range elo', { elo: 99999 }],
        ['null', 'null'],
        ['array', '[1,2]'],
    ]) {
        test(`invalid stored settings (${name}) fall back to defaults`, withCtl({ setup: seed(raw) }, async (C) => {
            const s = C.state();
            assert.equal(s.mode, 'human-ai');
            assert.equal(s.humanColor, 'w');
            const sl = C.button('elo-slider');
            assert.ok(s.elo >= +sl.min && s.elo <= +sl.max, `elo ${s.elo}`);
            assert.equal(s.speed, 'full');
            assert.equal(s.labels, true);
            assert.equal(s.muted, false);
            assert.deepEqual(C.errors, []);
        }));
    }

    test('a throwing localStorage does not break start or saving', withCtl({
        setup: (w) => {
            const bad = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() {} };
            Object.defineProperty(w, 'localStorage', { get: () => bad, configurable: true });
        },
    }, async (C) => {
        assert.equal(C.state().mode, 'human-ai');
        C.button('speed-fast').click();
        assert.equal(C.state().speed, 'fast');
        assert.deepEqual(C.errors, []);
    }));
});

describe('battle3d controller: ELO slider range (markup-driven)', () => {
    const range = (C) => { const e = C.button('elo-slider'); return { min: +e.min, max: +e.max, step: +e.step || 100 }; };

    for (const [name, stored] of [['above max', 99999], ['below min', 1], ['off-step', 1234], ['old max 2500', 2500], ['old min 300', 300]]) {
        test(`stored elo ${name} (${stored}) is clamped and snapped into the slider range`, withCtl({ setup: seed({ elo: stored }) }, async (C) => {
            const { min, max, step } = range(C);
            const e = C.state().elo;
            assert.ok(e >= min && e <= max, `${e} in [${min}, ${max}]`);
            assert.equal((e - min) % step, 0, `${e} on a ${step} step`);
            assert.equal(String(C.button('elo-slider').value), String(e));
            if (stored >= max) assert.equal(e, max);
            if (stored <= min) assert.equal(e, min);
        }));
    }

    test('the top value is labelled "Max" in the HUD and the thinking status; others show the number', withCtl(async (C) => {
        const { max } = range(C);
        const elo = C.button('elo-slider');
        elo.value = String(max);
        elo.dispatchEvent(new C.w.Event('input'));
        assert.equal(C.state().elo, max);
        assert.equal(C.button('elo-value').textContent, 'Max');
        await C.play('e2e4');
        await C.step(0.3);
        assert.match(C.status(), /Max/, 'thinking status shows Max');
        assert.equal(C.aiCalls().slice(-1)[0].elo, max, 'the engine still gets the number');
        elo.value = String(max - 2 * (+elo.step || 100));
        elo.dispatchEvent(new C.w.Event('input'));
        assert.equal(C.button('elo-value').textContent, String(max - 2 * (+elo.step || 100)));
    }));
});

describe('battle3d controller v2: keyboard play', () => {
    test('arrows place and move a cursor (highlighted as hover), clamped at the edge', withCtl(async (C) => {
        C.key('ArrowUp', 'ArrowUp');
        assert.deepEqual(C.state().cursor, square('e2'), 'first arrow puts the cursor on e2 for White');
        assert.deepEqual(lastHover(C), square('e2'));
        assert.match(C.announced(), /e2.*White pawn/);
        C.key('ArrowUp', 'ArrowUp');
        assert.deepEqual(C.state().cursor, square('e3'));
        for (let i = 0; i < 10; i++) C.key('ArrowRight', 'ArrowRight');
        assert.deepEqual(C.state().cursor, square('h3'), 'clamped at the h file');
        for (let i = 0; i < 10; i++) C.key('ArrowDown', 'ArrowDown');
        assert.deepEqual(C.state().cursor, square('h1'));
    }));

    test('Enter selects, arrows to a target, Enter moves', withCtl(async (C) => {
        C.key('ArrowUp', 'ArrowUp'); // e2
        C.key('Enter', 'Enter');
        assert.deepEqual(C.state().selected, square('e2'));
        assert.match(C.announced(), /Selected e2\. 2 legal moves/);
        C.key('ArrowUp', 'ArrowUp');
        C.key('ArrowUp', 'ArrowUp'); // e4
        assert.match(C.announced(), /e4.*legal move/);
        C.key('Enter', 'Enter');
        await C.flush();
        assert.equal(C.units.calls.playMove.length, 1);
        assert.deepEqual(C.units.calls.playMove[0].to, square('e4'));
        assert.deepEqual(C.state().history, ['e4']);
        assert.match(C.announced(), /White pawn e2 to e4/);
    }));

    test('Escape cancels the selection and the cursor', withCtl(async (C) => {
        C.key('ArrowUp', 'ArrowUp');
        C.key('Enter', 'Enter');
        C.key('Escape', 'Escape');
        assert.equal(C.state().selected, null);
        assert.equal(C.state().cursor, null);
    }));

    test('playing Black: up is away from the viewer and the cursor starts on e7', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.button('side-b').click();
        await C.flush();
        await C.play('e2e4');
        C.key('ArrowUp', 'ArrowUp');
        assert.deepEqual(C.state().cursor, square('e7'));
        C.key('ArrowUp', 'ArrowUp');
        assert.deepEqual(C.state().cursor, square('e6'), 'up moves toward rank 1 from Black\'s side');
        C.key('ArrowLeft', 'ArrowLeft');
        assert.deepEqual(C.state().cursor, square('f6'), 'left is toward the h file from Black\'s side');
    }));

    test('keys typed into form controls are ignored; the cursor is not moved', withCtl(async (C) => {
        const sel = C.button('mode-select');
        C.key('ArrowUp', 'ArrowUp', sel);
        assert.equal(C.state().cursor, null);
        const e = C.key('Space', ' ', C.button('new-game'));
        assert.equal(e.defaultPrevented, false, 'Space on a button is left to the button');
    }));

    test('keyboard input is locked during the AI turn and while a modal is open', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3); // AI thinking
        C.key('ArrowUp', 'ArrowUp');
        C.key('Enter', 'Enter');
        assert.equal(C.state().selected, null);
        await C.answerAI('e7e5');
        C.controller.setMode('human-human');
        C.g('battle3dLoadFen("4k3/P7/8/8/8/8/8/4K3 w - - 0 1")');
        C.units.api.syncBoard(C.get('board'));
        await C.click('a7');
        await C.click('a8');
        assert.equal(C.doc.getElementById('promo').hidden, false);
        const cursor = C.state().cursor;
        C.key('ArrowLeft', 'ArrowLeft');
        assert.deepEqual(C.state().cursor, cursor, 'arrows ignored while the promotion popup is open');
        C.key('Escape', 'Escape');
        assert.equal(C.doc.getElementById('promo').hidden, true, 'Escape cancels the popup');
    }));

    test('Space skips a running move', withCtl({ units: 'manual' }, async (C) => {
        C.controller.setMode('human-human');
        await C.click('e2'); await C.click('e4');
        assert.equal(C.state().moving, true);
        const e = C.key('Space', ' ');
        await C.flush();
        assert.equal(e.defaultPrevented, true);
        assert.equal(C.units.calls.skip, 1);
        assert.equal(C.scene.calls.skipEffects, 1, 'scene effects skipped too');
        assert.equal(C.state().moving, false);
    }));
});

describe('battle3d controller v2: audio, keepAlive, announcements', () => {
    test('v4 game-state cues: none for quiet moves or captures, check, checkmate, draw; UI cues on input', withCtl(async (C) => {
        C.controller.setMode('human-human');
        const ui = new Set(['select', 'deselect', 'invalid']);
        const state = () => C.audio.played.filter((n) => !ui.has(n));
        await C.play('e2e4');
        assert.deepEqual(state(), [], 'arrival sounds come from units, not the controller');
        assert.ok(C.audio.played.includes('select'), 'select on picking a unit');
        await C.play('f7f6');
        await C.play('d1h5');
        assert.deepEqual(state(), ['check']);
        C.audio.played.length = 0;
        C.controller.newGame();
        for (const mv of ['e2e4', 'd7d5', 'e4d5']) await C.play(mv);
        assert.deepEqual(state(), [], 'capture: the fight makes the sound');
        C.audio.played.length = 0;
        C.controller.newGame();
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await C.play(mv);
        assert.deepEqual(state(), ['checkmate'], 'victory belongs to units, not the controller');
        assert.match(C.announced(), /checkmate/i);
        C.audio.played.length = 0;
        C.controller.loadFen('7k/8/6K1/5Q2/8/8/8/8 w - - 0 1');
        await C.play('f5f7');
        assert.deepEqual(state(), ['draw']);
        C.audio.played.length = 0;
        await C.click('h8'); // game over: no knock
        C.controller.newGame();
        await C.click('e2'); await C.click('e2');
        assert.deepEqual(C.audio.played, ['select', 'deselect']);
        await C.click('e2'); await C.click('e5');
        assert.deepEqual(C.audio.played.slice(2), ['select', 'invalid']);
        C.audio.played.length = 0;
        C.controller.loadFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
        await C.play('e1g1');
        assert.deepEqual(state(), [], 'castle belongs to units, not the controller');
    }));

    test('cues carry a board position (stereo follows the square)', withCtl(async (C) => {
        C.controller.setMode('human-human');
        const seen = [];
        const orig = C.audio.play;
        C.audio.play = (name, opts) => { seen.push({ name, pos: opts?.pos }); return orig(name, opts); };
        await C.click('a2');
        assert.equal(seen[0].name, 'select');
        assert.deepEqual(seen[0].pos, { x: -3.5, y: 0, z: 2.5 }, 'select at a2');
    }));

    test('mute button toggles audio and its pressed state', withCtl(async (C) => {
        C.button('mute').click();
        assert.equal(C.audio.muted, true);
        assert.equal(C.button('mute').getAttribute('aria-pressed'), 'true');
        C.button('mute').click();
        assert.equal(C.audio.muted, false);
        assert.equal(C.button('mute').getAttribute('aria-pressed'), 'false');
    }));

    test('controller-move keepAlive is held only while a move animates, incl. new game mid-move', withCtl({ units: 'manual' }, async (C) => {
        C.controller.setMode('human-human');
        await C.click('e2'); await C.click('e4');
        assert.ok(C.scene.tokens.has('controller-move'));
        C.units.finish();
        await C.flush();
        assert.equal(C.scene.tokens.has('controller-move'), false);
        await C.click('e7'); await C.click('e5');
        assert.ok(C.scene.tokens.has('controller-move'));
        C.button('new-game').click();
        await C.flush();
        assert.equal(C.scene.tokens.has('controller-move'), false, 'released when the move is aborted');
        await C.click('d2'); await C.click('d4');
        C.button('undo').click(); // disabled while moving
        C.units.finish();
        await C.flush();
        C.button('undo').click();
        await C.flush();
        assert.equal(C.scene.tokens.has('controller-move'), false);
    }));

    test('no errors over a short human vs AI game', withCtl(async (C) => {
        for (const [h, a] of [['e2e4', 'e7e5'], ['g1f3', 'b8c6'], ['f1c4', 'g8f6']]) {
            await C.play(h);
            await C.step(0.3);
            await C.answerAI(a);
        }
        assert.equal(C.state().history.length, 6);
        assert.deepEqual(C.errors, []);
    }));
});
