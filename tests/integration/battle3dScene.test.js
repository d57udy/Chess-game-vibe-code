'use strict';
// battle3d/scene.js in node with a fake renderer: render-on-demand (full / idle ~20 fps / sleep),
// wake-ups, cinematic shots (finite cameras, end() restores the view), FX pools back to baseline,
// and a real units.js fight on the real scene (cinematic + fx) ending with clean pools and view.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { loadSceneModule, fakeRenderer } = require('../helpers/battle3dSceneHarness');
const H = require('../helpers/battle3dUnitsHarness');

const skip = findThree() ? false : 'three.js not installed';
let M;

const finite = (arr) => arr.every(Number.isFinite);
async function makeScene(opts = {}) {
    const renderer = fakeRenderer(document);
    const stage = document.getElementById('stage');
    const S = await M.createScene(stage, { renderer, sleepAfter: 3, ...opts });
    await S.setView('w', { animate: false });
    return { S, renderer };
}
// Renders counted over `seconds` of rAF ticks at 60 Hz.
function rendersOver(R, seconds) {
    const r0 = R.renderer.renders;
    M.raf.run(seconds);
    return R.renderer.renders - r0;
}
const fxTotal = (S) => Object.values(S.stats().fxAlive).reduce((a, b) => a + b, 0);
const camState = (S) => { const s = S.stats().camera; return [...s.position, ...s.target]; };
// Steps scene frames until promise settles (cinematic clocks run inside frame()).
async function settle(S, promise, max = 10, label = 'promise') {
    let done = false;
    promise.then(() => { done = true; });
    for (let i = 0; i < max * 60 && !done; i++) { S.stepFrames(1); await null; }
    assert.ok(done, `${label} did not resolve within ${max} s`);
}

describe('battle3d scene.js (fake renderer)', { skip }, () => {
    before(async () => { M = await loadSceneModule(); });
    after(() => { if (M) M.restore(); });

    test('boots with the contract API and a finite camera', async () => {
        const { S } = await makeScene();
        for (const k of ['squareToWorld', 'onSquareClick', 'onSquareHover', 'registerPickProxy', 'setHighlights', 'setView', 'focusOn', 'restoreView',
            'addUpdater', 'removeUpdater', 'setTimeScale', 'shake', 'burst', 'stepFrames', 'setPaused', 'requestRender', 'keepAlive', 'isCoarsePointer']) {
            assert.equal(typeof S[k], 'function', k);
        }
        for (const k of ['shot', 'slowMo', 'letterbox', 'end']) assert.equal(typeof S.cinematic[k], 'function', `cinematic.${k}`);
        for (const k of ['trail', 'impact', 'debris', 'decal']) assert.equal(typeof S.fx[k], 'function', `fx.${k}`);
        assert.ok(finite(camState(S)));
        assert.equal(fxTotal(S), 0);
        S.dispose();
    });

    test('render-on-demand: full after a poke, ~20 fps idle, nothing after sleepAfter', async () => {
        const R = await makeScene();
        M.raf.run(1.5); // let the boot poke expire
        const idle = rendersOver(R, 1);
        assert.equal(R.S.stats().mode, 'idle');
        assert.ok(idle >= 12 && idle <= 25, `idle fps ${idle}`);
        M.raf.run(2); // past sleepAfter (3 s) since the last activity
        assert.equal(R.S.stats().mode, 'sleep');
        assert.equal(rendersOver(R, 2), 0, 'no renders while asleep');
        R.S.dispose();
    });

    test('an idle-only token throttles but still sleeps; a fight token keeps full rate', async () => {
        const R = await makeScene();
        R.S.keepAlive('idle', true);
        M.raf.run(1.5);
        const idle = rendersOver(R, 1);
        assert.ok(idle >= 12 && idle <= 25, `idle token fps ${idle}`);
        M.raf.run(3);
        assert.equal(R.S.stats().mode, 'sleep', 'idle token alone does not prevent sleep');
        R.S.keepAlive('units-fight', true);
        const full = rendersOver(R, 1);
        assert.ok(full >= 55, `fight token fps ${full}`);
        M.raf.run(5);
        assert.equal(R.S.stats().mode, 'full', 'no sleep while a non-idle token is on');
        R.S.keepAlive('units-fight', false);
        M.raf.run(1.5);
        assert.equal(R.S.stats().mode, 'idle');
        R.S.dispose();
    });

    test('wakes from sleep on requestRender, pointer and key input', async () => {
        const R = await makeScene();
        const canvas = R.renderer.domElement;
        const wakers = [
            ['requestRender', () => R.S.requestRender()],
            ['pointerdown', () => canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, clientY: 300, bubbles: true, button: 0 }))],
            ['pointermove', () => canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 410, clientY: 310, bubbles: true }))],
            ['keydown', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))],
        ];
        for (const [name, wake] of wakers) {
            M.raf.run(5);
            assert.equal(R.S.stats().mode, 'sleep', `${name}: asleep first`);
            wake();
            if (name === 'pointerdown') canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: 400, clientY: 300, bubbles: true })); // captured pointer
            assert.ok(rendersOver(R, 0.2) >= 1, `${name} renders again`);
            assert.notEqual(R.S.stats().mode, 'sleep', `${name} leaves sleep`);
        }
        R.S.dispose();
    });

    test('hidden tab renders nothing, stepFrames still works', async () => {
        const R = await makeScene();
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        try {
            R.S.keepAlive('units-fight', true);
            assert.equal(rendersOver(R, 1), 0);
            let ticks = 0;
            const fn = () => { ticks++; };
            R.S.addUpdater(fn);
            const r0 = R.renderer.renders;
            R.S.stepFrames(10);
            assert.equal(ticks, 10, 'updaters run under stepFrames');
            assert.ok(R.renderer.renders > r0, 'stepFrames renders');
            R.S.removeUpdater(fn);
        } finally {
            delete document.hidden;
        }
        R.S.dispose();
    });

    test('cinematic shots of every type resolve with finite cameras; end() restores the view', async () => {
        const R = await makeScene();
        const S = R.S;
        const V = (x, z) => new M.THREE.Vector3(x, 0, z);
        const pairs = [
            ['adjacent', [V(0.5, 0.5), V(0.5, -0.5)]],
            ['diagonal far', [V(-3.5, 3.5), V(3.5, -3.5)]],
            ['same point', [V(1.5, 1.5), V(1.5, 1.5)]],
            ['edge', [V(-3.5, -3.5), V(-3.5, -1.5)]],
            ['single', [V(2.5, -2.5)]],
        ];
        const before = camState(S);
        for (const type of ['two-shot', 'closeup', 'over-shoulder', 'orbit']) {
            for (const [name, pts] of pairs) {
                for (const cut of [false, true]) {
                    const label = `${type} ${name} cut=${cut}`;
                    S.cinematic.letterbox(true);
                    const p = S.cinematic.shot(type, pts, { duration: 0.6, cut });
                    let done = false;
                    p.then(() => { done = true; });
                    for (let i = 0; i < 120 && !done; i++) {
                        S.stepFrames(1);
                        assert.ok(finite(camState(S)), `${label}: camera NaN at frame ${i}`);
                        await null;
                    }
                    assert.ok(done, `${label} resolved`);
                    const cam = S.camera.position;
                    assert.ok(cam.y > 0.2, `${label}: camera above the board (${cam.y.toFixed(2)})`);
                    await settle(S, S.cinematic.end({ duration: 0.3 }), 3, `${label} end`);
                    const after = camState(S);
                    assert.ok(after.every((v, i) => Math.abs(v - before[i]) < 1e-3), `${label}: view restored (${after.map((v) => v.toFixed(2))} vs ${before.map((v) => v.toFixed(2))})`);
                }
            }
        }
        S.dispose();
    });

    test('slowMo eases back to normal; a skip mid-shot leaves a finite camera and no fades', async () => {
        const R = await makeScene();
        const S = R.S;
        await settle(S, S.cinematic.slowMo(0.25, 0.3), 3, 'slowMo');
        S.stepFrames(30);
        assert.equal(S.stats().slowFactor, 1);
        const before = camState(S);
        S.cinematic.shot('orbit', [new M.THREE.Vector3(0, 0, 0), new M.THREE.Vector3(1, 0, 1)], { duration: 1 });
        S.cinematic.slowMo(0.2, 1);
        S.stepFrames(10);
        S.skipEffects();
        await settle(S, S.cinematic.end({ duration: 0 }), 1, 'end after skip');
        S.stepFrames(2);
        assert.equal(S.stats().slowFactor, 1);
        assert.ok(camState(S).every((v, i) => Math.abs(v - before[i]) < 1e-3), 'view restored after skip + end(0)');
        S.dispose();
    });

    test('FX pools return to zero: trails, impacts, debris, decals, bursts, projectiles', async () => {
        const R = await makeScene();
        const S = R.S;
        const childCount = S.scene.children.length;
        const V = (x, y, z) => new M.THREE.Vector3(x, y, z);
        const holder = new M.THREE.Object3D();
        S.scene.add(holder);
        const trails = [S.fx.trail(holder, { color: '#ffffff', width: 0.08, length: 14 }), S.fx.trail(holder, { color: '#ff0000' })];
        for (let i = 0; i < 20; i++) { holder.position.set(Math.sin(i / 3), 0.5, Math.cos(i / 3)); S.stepFrames(1); }
        for (const kind of ['slash', 'blunt', 'pierce', 'magic', 'bone']) S.fx.impact(V(0, 0.5, 0), V(1, 0, 0), kind);
        for (const kind of ['bones', 'armor', 'wood']) S.fx.debris(V(1, 0.4, 1), { kind, count: 12, direction: V(0, 0, 1) });
        S.fx.decal(V(0.5, 0, 0.5), 'scorch');
        S.fx.decal(V(-0.5, 0, 0.5), 'crack');
        for (const kind of ['dust', 'spark', 'magic', 'poof']) S.burst(V(0, 0.3, 0), kind, { count: 20 });
        S.projectile(V(-2, 0.5, 0), V(2, 0.5, 0), { duration: 0.4, color: '#88ccff' });
        const alive = S.stats().fxAlive;
        assert.ok(alive.trails === 2 && alive.impacts > 0 && alive.debris > 0 && alive.decals === 2, JSON.stringify(alive));
        assert.ok(S.stats().mode === 'full' || rendersOver(R, 0.1) > 4, 'FX alive keeps full rate');
        for (const t of trails) t.stop();
        S.stepFrames(60 * 12, 1 / 60); // decals fade after a few seconds
        assert.deepEqual(S.stats().fxAlive, { particles: 0, trails: 0, debris: 0, decals: 0, impacts: 0, projectiles: 0 });
        S.scene.remove(holder);
        assert.equal(S.scene.children.length, childCount, 'no FX objects left in the scene');
        S.dispose();
    });

    test('skipEffects finishes every FX immediately', async () => {
        const R = await makeScene();
        const S = R.S;
        const V = (x, y, z) => new M.THREE.Vector3(x, y, z);
        S.fx.debris(V(0, 0.4, 0), { kind: 'bones', count: 20 });
        S.fx.decal(V(0, 0, 0), 'scorch');
        S.fx.impact(V(0, 0.5, 0), V(1, 0, 0), 'slash');
        S.burst(V(0, 0.3, 0), 'spark', { count: 30 });
        S.stepFrames(2);
        S.skipEffects();
        S.stepFrames(1);
        const alive = S.stats().fxAlive;
        assert.equal(alive.debris + alive.impacts + alive.particles, 0, JSON.stringify(alive));
        S.dispose();
    });

    test('real fights on the real scene: pools empty, view restored, camera finite, then sleep', async (t) => {
        const R = await makeScene();
        const S = R.S;
        const U = await H.loadUnitsModule({ dom: false });
        const units = await U.createUnits(S, 'battle3d/assets/manifest.json', {});
        const childCount0 = S.scene.children.length;
        const viewBefore = camState(S);
        const plans = [];
        let peakFx = 0;
        S.addUpdater(() => { peakFx = Math.max(peakFx, fxTotal(S)); });
        for (const [color, a, v] of [['w', 'p', 'q'], ['b', 'b', 'b'], ['w', 'r', 'r'], ['b', 'n', 'n'], ['w', 'k', 'r'], ['b', 'q', 'p']]) {
            const { fen, move } = H.captureSetup(color, a, v);
            const E = H.rulesAt(fen);
            units.syncBoard(E.get('board'));
            const childBase = S.scene.children.length;
            units.setMode('full');
            const p = units.playMove(E.apply(move));
            let done = false;
            p.then(() => { done = true; });
            for (let i = 0; i < 8 * 60 && !done; i++) {
                S.stepFrames(1);
                if (i % 10 === 0) assert.ok(finite(camState(S)), `${color}${a}x${v}: camera NaN at frame ${i}`);
                await null;
            }
            assert.ok(done, `${color}${a}x${v} finished`);
            plans.push(`${color}${a}x${v}:${units.lastFightPlan()}`);
            S.stepFrames(60 * 10); // let decals/debris fade and the camera settle
            H.assertSynced(S, units, E, `${color}${a}x${v}`);
            const alive = S.stats().fxAlive;
            assert.equal(Object.values(alive).reduce((x, y) => x + y, 0), 0, `${color}${a}x${v}: FX left ${JSON.stringify(alive)}`);
            assert.ok(camState(S).every((x, i) => Math.abs(x - viewBefore[i]) < 1e-3), `${color}${a}x${v}: view restored`);
            assert.equal(S.stats().camera.scripted, false);
            assert.ok(S.scene.children.length <= childBase, `${color}${a}x${v}: scene children ${S.scene.children.length} > ${childBase}`);
            void childCount0;
        }
        assert.ok(peakFx > 0, 'fights produced FX');
        t.diagnostic(`${plans.join(' ')}; peak live FX ${peakFx}`);
        // With units idle, the loop throttles, then sleeps.
        M.raf.run(1.5);
        assert.ok(['idle', 'sleep'].includes(S.stats().mode), S.stats().mode);
        M.raf.run(4);
        assert.equal(S.stats().mode, 'sleep');
        S.dispose();
    });
});
