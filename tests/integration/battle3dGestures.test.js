'use strict';
// v3 camera gestures on the real scene.js (fake renderer, synthetic pointer events): two-finger
// pan (clamped), pinch zoom, twist rotate, no click from multi-touch, no orbit from the leftover
// finger, desktop right/shift-drag pan and wheel zoom, resetView, and cinematic end() restoring a
// panned/zoomed player view.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { loadSceneModule, fakeRenderer } = require('../helpers/battle3dSceneHarness');

const skip = findThree() ? false : 'three.js not installed';
let M;

async function makeScene({ side = 'w', reducedMotion = false } = {}) {
    const realMM = window.matchMedia;
    if (reducedMotion) window.matchMedia = (q) => ({ ...realMM(q), matches: /prefers-reduced-motion: reduce/.test(q) });
    const renderer = fakeRenderer(document);
    const canvas = renderer.domElement;
    Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    const S = await M.createScene(document.getElementById('stage'), { renderer, sleepAfter: 3 });
    window.matchMedia = realMM;
    await S.setView(side, { animate: false });
    S.stepFrames(2);
    const clicks = [];
    S.onSquareClick((row, col) => clicks.push({ row, col }));
    return { S, canvas, clicks };
}
const ev = (type, id, x, y, extra = {}) => new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, button: 0, ...extra });
const down = (c, id, x, y, extra) => c.dispatchEvent(ev('pointerdown', id, x, y, extra));
const move = (c, id, x, y, extra) => c.dispatchEvent(ev('pointermove', id, x, y, extra));
const up = (c, id, x, y, extra) => c.dispatchEvent(ev('pointerup', id, x, y, extra));
// Moves two fingers in `steps` increments from a0/b0 to a1/b1.
function twoFinger(c, [a0, b0], [a1, b1], steps = 10) {
    down(c, 1, a0[0], a0[1]); down(c, 2, b0[0], b0[1]);
    for (let i = 1; i <= steps; i++) {
        const k = i / steps;
        move(c, 1, a0[0] + (a1[0] - a0[0]) * k, a0[1] + (a1[1] - a0[1]) * k);
        move(c, 2, b0[0] + (b1[0] - b0[0]) * k, b0[1] + (b1[1] - b0[1]) * k);
    }
    up(c, 1, a1[0], a1[1]); up(c, 2, b1[0], b1[1]);
}
const cam = (S) => S.stats().camera;
const dist = (S) => { const { position: p, target: t } = cam(S); return Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]); };
const azimuth = (S) => { const { position: p, target: t } = cam(S); return Math.atan2(p[0] - t[0], p[2] - t[2]); };
const settle = (S) => S.stepFrames(180);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const sameView = (a, b, eps = 1e-3) => [...a.position, ...a.target].every((v, i) => near(v, [...b.position, ...b.target][i], eps));

describe('battle3d scene gestures (v3)', { skip }, () => {
    before(async () => { M = await loadSceneModule(); });
    after(() => { if (M) M.restore(); });

    test('API: resetView and getPan exist; default view has zero pan', async () => {
        const { S } = await makeScene();
        assert.equal(typeof S.resetView, 'function');
        assert.equal(typeof S.getPan, 'function');
        const p = S.getPan();
        assert.ok(near(p.x, 0) && near(p.z, 0), JSON.stringify(p));
        S.dispose();
    });

    test('two-finger drag pans the target; the board follows the fingers', async () => {
        const { S, canvas, clicks } = await makeScene();
        const r0 = dist(S), a0 = azimuth(S);
        twoFinger(canvas, [[300, 300], [500, 300]], [[200, 300], [400, 300]]); // drag left
        settle(S);
        const p = S.getPan();
        assert.ok(p.x > 0.2, `dragging left moves the target right (x ${p.x.toFixed(2)}) so the board slides left`);
        assert.ok(near(p.z, 0, 0.05), `horizontal drag keeps z (${p.z.toFixed(3)})`);
        assert.ok(near(dist(S), r0, 1e-2), 'pure pan does not zoom');
        assert.ok(near(azimuth(S), a0, 1e-3), 'pure pan does not rotate');
        twoFinger(canvas, [[300, 300], [500, 300]], [[300, 400], [500, 400]]); // drag down
        settle(S);
        assert.ok(S.getPan().z < p.z - 0.2, `dragging down brings the far side closer (z ${S.getPan().z.toFixed(2)})`);
        assert.deepEqual(clicks, [], 'no square click from a two-finger gesture');
        S.dispose();
    });

    test('pan distance matches the finger (world units per pixel at the target distance)', async () => {
        const { S, canvas } = await makeScene();
        const r = dist(S);
        const perPx = (2 * r * Math.tan((S.camera.fov * Math.PI) / 360)) / 600;
        twoFinger(canvas, [[300, 300], [500, 300]], [[400, 300], [600, 300]]); // 100 px right
        settle(S);
        const p = S.getPan();
        assert.ok(near(p.x, -100 * perPx, 0.05 * 100 * perPx), `pan x ${p.x.toFixed(3)} vs ${(-100 * perPx).toFixed(3)}`);
        assert.ok(near(dist(S), r, 1e-2));
        S.dispose();
    });

    test('Black side: setView(b) starts unpanned from the other side; pans are mirrored', async () => {
        const W = await makeScene();
        const B = await makeScene({ side: 'b' });
        const p0 = B.S.getPan();
        assert.ok(near(p0.x, 0) && near(p0.z, 0));
        assert.ok(near(Math.abs(azimuth(B.S)), Math.PI, 1e-3), `theta ${azimuth(B.S)}`);
        const mouse = { pointerType: 'mouse', shiftKey: true };
        for (const R of [W, B]) {
            down(R.canvas, 1, 400, 300, mouse);
            for (let y = 310; y <= 380; y += 10) move(R.canvas, 1, 400, y, mouse);
            up(R.canvas, 1, 400, 380, mouse);
            settle(R.S);
        }
        const pw = W.S.getPan(), pb = B.S.getPan();
        assert.ok(pw.z < -0.5, `white drag down pans z ${pw.z.toFixed(2)}`);
        assert.ok(near(pb.z, -pw.z, 0.05) && near(pb.x, -pw.x, 0.05), `black mirrored ${JSON.stringify(pb)} vs ${JSON.stringify(pw)}`);
        W.S.dispose(); B.S.dispose();
    });

    test('gestures wake render-on-demand from sleep', async () => {
        const { S, canvas } = await makeScene();
        M.raf.run(5);
        assert.equal(S.stats().mode, 'sleep');
        down(canvas, 1, 300, 300); down(canvas, 2, 500, 300);
        move(canvas, 1, 280, 300); move(canvas, 2, 480, 300);
        M.raf.run(0.1);
        assert.equal(S.stats().mode, 'full', 'two-finger drag renders at full rate');
        up(canvas, 1, 280, 300); up(canvas, 2, 480, 300);
        M.raf.run(2);
        assert.notEqual(S.stats().mode, 'full', 'settles back after the gesture');
        S.dispose();
    });

    test('reduced motion: resetView is instant', async () => {
        const { S, canvas } = await makeScene({ reducedMotion: true });
        const home = cam(S);
        twoFinger(canvas, [[300, 300], [500, 300]], [[150, 200], [450, 250]]);
        settle(S);
        S.resetView();
        S.stepFrames(1);
        assert.ok(sameView(cam(S), home), 'one frame later the default view is back');
        S.dispose();
    });

    test('pan is clamped to the board plus a margin', async () => {
        const { S, canvas } = await makeScene();
        for (let i = 0; i < 8; i++) twoFinger(canvas, [[100, 100], [300, 100]], [[700, 550], [900, 550]], 5);
        settle(S);
        const t = cam(S).target;
        assert.ok(Math.abs(t[0]) <= 5.001 && Math.abs(t[2]) <= 5.001, `target ${t.map((v) => v.toFixed(2))}`);
        assert.ok(Math.abs(t[0]) > 4 || Math.abs(t[2]) > 4, 'reached the clamp');
        S.dispose();
    });

    test('pinch zooms in and out; twist rotates around the vertical axis', async () => {
        const { S, canvas } = await makeScene();
        const r0 = dist(S);
        twoFinger(canvas, [[350, 300], [450, 300]], [[325, 300], [475, 300]]); // spread 1.5x: zoom in
        settle(S);
        const r1 = dist(S);
        assert.ok(near(r1, r0 / 1.5, 0.03 * r0), `spread zooms in ${r0.toFixed(2)} -> ${r1.toFixed(2)}`);
        for (let i = 0; i < 6; i++) twoFinger(canvas, [[300, 300], [500, 300]], [[200, 300], [600, 300]]);
        settle(S);
        const rMin = dist(S);
        assert.ok(rMin > 2 && rMin < r1, `zoom-in is clamped (${rMin.toFixed(2)})`);
        await S.resetView({ animate: false });
        S.stepFrames(2);
        twoFinger(canvas, [[350, 300], [450, 300]], [[325, 300], [475, 300]]);
        twoFinger(canvas, [[325, 300], [475, 300]], [[350, 300], [450, 300]]); // pinch: zoom back out
        settle(S);
        assert.ok(near(dist(S), r0, 0.05 * r0), `pinch back restores the distance (${dist(S).toFixed(2)} vs ${r0.toFixed(2)})`);
        const a0 = azimuth(S), rr = dist(S);
        // rotate the pair 45 degrees around their midpoint
        const c = [400, 300], R = 100;
        const at = (deg, s) => [c[0] + s * R * Math.cos(deg * Math.PI / 180), c[1] + s * R * Math.sin(deg * Math.PI / 180)];
        down(canvas, 1, ...at(0, -1)); down(canvas, 2, ...at(0, 1));
        for (let d = 5; d <= 45; d += 5) { move(canvas, 1, ...at(d, -1)); move(canvas, 2, ...at(d, 1)); }
        up(canvas, 1, ...at(45, -1)); up(canvas, 2, ...at(45, 1));
        settle(S);
        const turned = Math.atan2(Math.sin(azimuth(S) - a0), Math.cos(azimuth(S) - a0));
        assert.ok(Math.abs(Math.abs(turned) - Math.PI / 4) < 0.1, `twist rotates about 45 deg (${(turned * 180 / Math.PI).toFixed(1)})`);
        assert.ok(near(dist(S), rr, 0.05 * rr), 'twist keeps the distance');
        S.dispose();
    });

    test('the finger left after a two-finger gesture does not orbit; a third finger is ignored', async () => {
        const { S, canvas } = await makeScene();
        down(canvas, 1, 300, 300); down(canvas, 2, 500, 300);
        down(canvas, 3, 400, 100); // third finger
        move(canvas, 3, 400, 400);
        up(canvas, 2, 500, 300);
        const before = cam(S);
        for (let x = 300; x >= 100; x -= 20) move(canvas, 1, x, 300);
        up(canvas, 1, 100, 300); up(canvas, 3, 400, 400);
        settle(S);
        assert.ok(sameView(cam(S), before, 1e-2), 'no orbit from the leftover finger');
        S.dispose();
    });

    test('a single tap still clicks; a one-finger drag orbits without clicking', async () => {
        const { S, canvas, clicks } = await makeScene();
        down(canvas, 7, 400, 330); up(canvas, 7, 400, 330);
        assert.equal(clicks.length, 1, 'tap picks a square');
        const a0 = azimuth(S);
        await new Promise((r) => setTimeout(r, 0));
        down(canvas, 8, 200, 330);
        for (let x = 220; x <= 400; x += 20) move(canvas, 8, x, 330);
        up(canvas, 8, 400, 330);
        settle(S);
        assert.equal(clicks.length, 1, 'drag does not click');
        assert.ok(Math.abs(azimuth(S) - a0) > 0.2, 'one-finger drag orbits');
        S.dispose();
    });

    test('desktop: right-drag and shift+drag pan, wheel zooms, left drag orbits', async () => {
        const { S, canvas, clicks } = await makeScene();
        const mouse = { pointerType: 'mouse' };
        const p0 = S.getPan();
        down(canvas, 1, 400, 300, { ...mouse, button: 2 });
        for (let x = 380; x >= 200; x -= 20) move(canvas, 1, x, 300, { ...mouse, button: 2 });
        up(canvas, 1, 200, 300, { ...mouse, button: 2 });
        settle(S);
        const p1 = S.getPan();
        assert.ok(p1.x - p0.x > 0.2, `right-drag pans (${p1.x.toFixed(2)})`);
        down(canvas, 2, 400, 300, { ...mouse, shiftKey: true });
        for (let y = 320; y <= 450; y += 10) move(canvas, 2, 400, y, { ...mouse, shiftKey: true });
        up(canvas, 2, 400, 450, { ...mouse, shiftKey: true });
        settle(S);
        assert.ok(S.getPan().z < p1.z - 0.2, 'shift+drag pans');
        const r0 = dist(S);
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
        settle(S);
        assert.ok(dist(S) < r0, 'wheel up zooms in');
        assert.deepEqual(clicks, [], 'no clicks from drags');
        const ctx = new Event('contextmenu', { cancelable: true, bubbles: true });
        canvas.dispatchEvent(ctx);
        assert.equal(ctx.defaultPrevented, true, 'context menu suppressed so right-drag works');
        S.dispose();
    });

    test('resetView undoes pan, zoom and orbit (animated and instant)', async () => {
        const { S, canvas } = await makeScene();
        const home = cam(S);
        twoFinger(canvas, [[300, 300], [500, 300]], [[150, 200], [450, 250]]);
        canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }));
        settle(S);
        assert.ok(!sameView(cam(S), home, 0.05));
        await S.resetView({ animate: false });
        S.stepFrames(2);
        assert.ok(sameView(cam(S), home), 'instant reset');
        twoFinger(canvas, [[300, 300], [500, 300]], [[150, 200], [450, 250]]);
        settle(S);
        const p = S.resetView();
        S.stepFrames(60);
        await p;
        S.stepFrames(30);
        assert.ok(sameView(cam(S), home), 'animated reset');
        const pan = S.getPan();
        assert.ok(near(pan.x, 0) && near(pan.z, 0));
        S.dispose();
    });

    test('cinematic end() restores the panned and zoomed player view; resetView during a shot lands on default', async () => {
        const { S, canvas } = await makeScene();
        const home = cam(S);
        twoFinger(canvas, [[300, 300], [500, 300]], [[200, 350], [450, 350]]);
        settle(S);
        const player = cam(S);
        const pan = S.getPan();
        const V = (x, z) => new M.THREE.Vector3(x, 0, z);
        S.cinematic.letterbox(true);
        const shot = S.cinematic.shot('two-shot', [V(-2.5, 1.5), V(1.5, -0.5)], { duration: 0.6 });
        S.stepFrames(40);
        await shot;
        assert.ok(!sameView(cam(S), player, 0.05), 'shot moved the camera');
        const pDuring = S.getPan();
        assert.ok(near(pDuring.x, pan.x) && near(pDuring.z, pan.z), 'getPan reports the stored player view during a shot');
        // gestures are ignored while the fight camera owns the view
        twoFinger(canvas, [[300, 300], [500, 300]], [[100, 300], [300, 300]]);
        const end = S.cinematic.end({ duration: 0.4 });
        S.stepFrames(40);
        await end;
        S.stepFrames(5);
        assert.ok(sameView(cam(S), player), 'end() returns to the panned view');
        // resetView during a shot: end() lands on the default view
        const shot2 = S.cinematic.shot('closeup', [V(0.5, 0.5)], { duration: 0.3 });
        S.stepFrames(20);
        await shot2;
        await S.resetView();
        const end2 = S.cinematic.end({ duration: 0.3 });
        S.stepFrames(30);
        await end2;
        S.stepFrames(5);
        assert.ok(sameView(cam(S), home), 'reset during a shot lands on default after end()');
        S.dispose();
    });
});
