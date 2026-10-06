'use strict';
// End-to-end boot of battle3d.html + main.js in node (real scene with a fake renderer, real units,
// controller, audio, cast, cast-ui): clean boot, legend, first-run tip, keyboard play against a
// stubbed AI with units staying in sync, the Cast editor flow (preset -> Apply -> saved, units
// rebuilt, legend updated), and render-on-demand going to sleep when the game is idle.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const H = require('../helpers/battle3dUnitsHarness');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
let P;

// assertSynced adapter: the page's rules state instead of a vm rules context
const pageRules = () => ({ get: (expr) => { assert.equal(expr, 'board'); return P.board(); } });

describe('battle3d page boot (main.js, real modules)', { skip }, () => {
    before(async () => { P = await bootPage(); });
    after(() => { if (P) P.restore(); });

    test('boots cleanly: debug hook, status, no console errors, loading screen hidden', async () => {
        assert.ok(P.B && P.B.controller && P.B.units && P.B.sceneAPI);
        assert.equal(P.state().fen.split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');
        assert.match(P.$('status-text').textContent, /White/);
        await P.sleep(700);
        assert.equal(P.$('loading').hidden, true);
        assert.deepEqual(P.errors, []);
        assert.deepEqual(P.warnings, [], 'no console warnings');
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'boot');
    });

    test("who's who legend has 6 rows naming both armies", () => {
        const rows = [...P.$('legend').querySelectorAll('tbody tr')];
        assert.equal(rows.length, 6);
        for (const tr of rows) {
            const cells = [...tr.querySelectorAll('td')].map((td) => td.textContent.trim());
            assert.equal(cells.length, 3);
            assert.ok(cells[1] && cells[1] !== '-' && cells[2] && cells[2] !== '-', cells.join(' | '));
        }
    });

    test('first-run tip shows once and is remembered when dismissed', () => {
        assert.equal(P.$('tip').hidden, false);
        P.$('tip-close').click();
        assert.equal(P.$('tip').hidden, true);
        assert.equal(P.w.localStorage.getItem('battle3d.tipSeen'), '1');
    });

    test('keyboard play vs the AI: moves animate on scene time and units stay in sync', async () => {
        P.key('ArrowUp'); P.key('Enter'); // select e2
        assert.deepEqual(P.state().selected, square('e2'));
        P.key('ArrowUp'); P.key('ArrowUp'); P.key('Enter'); // e4
        assert.equal(P.state().moving, true);
        await P.stepUntil(() => P.aiCalls().length === 1, { label: 'AI request' });
        const call = P.aiCalls()[0];
        assert.equal(call.state.currentPlayer, 'b');
        call.resolve({ from: square('d7'), to: square('d5') });
        await P.stepUntil(() => !P.state().busy && P.state().turn === 'w', { label: 'AI move' });
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after d5');
        // a capture: e4xd5 in Full
        P.B.controller.clickSquare(4, 4);
        P.B.controller.clickSquare(3, 3);
        await P.stepUntil(() => P.aiCalls().length === 2, { label: 'capture + AI request' });
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after exd5');
        assert.deepEqual(P.state().history, ['e4', 'd5', 'exd5']);
        const stats = P.B.sceneAPI.stats();
        assert.equal(stats.camera.scripted, false, 'fight camera handed back');
        assert.ok(stats.camera.position.every(Number.isFinite));
        assert.deepEqual(P.errors, []);
    });

    test('Cast editor: open, pick a preset, Apply -> saved, units rebuilt, legend updated', async () => {
        P.aiCalls()[1].resolve({ from: square('g8'), to: square('f6') });
        await P.stepUntil(() => !P.state().busy && P.state().turn === 'w', { label: 'AI reply' });
        const legendBefore = P.$('legend').textContent;
        P.$('cast-open').click();
        assert.equal(P.$('cast-modal').hidden, false);
        const deadline = Date.now() + 10000;
        while (!P.$('cast-mount').querySelector('.ce-primary') && Date.now() < deadline) await P.sleep(10);
        const mount = P.$('cast-mount');
        assert.ok(mount.querySelector('.ce-primary'), `cast editor mounted: ${mount.textContent.slice(0, 120)}`);
        const select = mount.querySelector('select.ce-select');
        select.value = 'skeletons';
        select.dispatchEvent(new P.w.Event('change'));
        mount.querySelector('.ce-primary').click();
        while (!P.$('cast-modal').hidden && Date.now() < deadline) await P.sleep(10);
        assert.equal(P.$('cast-modal').hidden, true, 'modal closes after Apply');
        const saved = JSON.parse(P.w.localStorage.getItem('battle3d.cast.v1'));
        assert.equal(saved.preset, 'skeletons');
        const legend = P.B.units.getLegend();
        assert.ok(legend.filter((e) => e.color === 'w').every((e) => /Skeleton/i.test(e.name + e.model)), `white army is skeletons: ${legend.map((e) => e.name).join(', ')}`);
        assert.notEqual(P.$('legend').textContent, legendBefore, 'HUD legend re-rendered');
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after setCast');
        // the game goes on with the new cast
        P.B.controller.clickSquare(7, 6);
        P.B.controller.clickSquare(5, 5);
        await P.stepUntil(() => P.aiCalls().length === 3, { label: 'move after cast change' });
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'move after setCast');
        // node has no WebGL: the editor's live preview logs this and falls back (expected here only)
        assert.deepEqual(P.errors.filter((e) => !/Error creating WebGL context/.test(e)), []);
    });

    test('Escape and the close button close the cast editor without applying', async () => {
        P.$('cast-open').click();
        assert.equal(P.$('cast-modal').hidden, false);
        P.key('Escape');
        assert.equal(P.$('cast-modal').hidden, true);
        P.$('cast-open').click();
        P.$('cast-close').click();
        assert.equal(P.$('cast-modal').hidden, true);
        assert.equal(JSON.parse(P.w.localStorage.getItem('battle3d.cast.v1')).preset, 'skeletons');
    });

    test('idle game: the render loop throttles and then sleeps', () => {
        P.aiCalls()[2].cancel();
        for (let i = 0; i < 60 * 6; i++) P.tick();
        const r0 = P.renderer.renders;
        for (let i = 0; i < 60; i++) P.tick();
        assert.equal(P.B.sceneAPI.stats().mode, 'sleep', JSON.stringify(P.B.sceneAPI.stats().activeTokens));
        assert.equal(P.renderer.renders - r0, 0);
    });
});
