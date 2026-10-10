'use strict';
// v6 speech bubbles (bubbles.js through sceneAPI.say) on the real scene with a fake renderer:
// one bubble per king (replace resolves the old one), typewriter + auto-dismiss on the scene clock,
// reduced motion, clamped to the viewport, flips below near the top, avoids the HUD and the other
// king's bubble, hidden during letterbox unless showInCinematic, text-only (no HTML injection).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { loadSceneModule, fakeRenderer } = require('../helpers/battle3dSceneHarness');

const skip = findThree() ? false : 'three.js not installed';
const W = 800, H = 600, BW = 200, BH = 60;
let M;

function sizeDom() {
    const stage = document.getElementById('stage');
    Object.defineProperty(stage, 'clientWidth', { value: W, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: H, configurable: true });
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0 });
    const proto = window.HTMLElement.prototype;
    if (!proto.__b3dSized) {
        proto.__b3dSized = true;
        Object.defineProperty(proto, 'offsetWidth', { get() { return this.classList?.contains('b3d-bubble') ? BW : 0; }, configurable: true });
        Object.defineProperty(proto, 'offsetHeight', { get() { return this.classList?.contains('b3d-bubble') ? BH : 0; }, configurable: true });
    }
}
async function makeScene({ reducedMotion = false } = {}) {
    sizeDom();
    const realMM = window.matchMedia;
    if (reducedMotion) window.matchMedia = (q) => ({ ...realMM(q), matches: /prefers-reduced-motion: reduce/.test(q) });
    const renderer = fakeRenderer(document);
    const S = await M.createScene(document.getElementById('stage'), { renderer, sleepAfter: 3 });
    window.matchMedia = realMM;
    await S.setView('w', { animate: false });
    S.stepFrames(2);
    return S;
}
const bubbleEl = (side) => document.querySelector(`.b3d-bubble[data-side="${side}"]`);
function rectOf(side) {
    const el = bubbleEl(side);
    const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform || '');
    if (!m) return null;
    const x = +m[1], y = +m[2];
    return { left: x, top: y, right: x + BW, bottom: y + BH };
}
const visible = (side) => { const el = bubbleEl(side); return !!el && el.style.display !== 'none' && Number(el.style.opacity) > 0; };
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const cleanup = () => { for (const el of document.querySelectorAll('.b3d-bubble, #hud')) el.remove(); };

describe('battle3d speech bubbles (v6)', { skip }, () => {
    before(async () => { M = await loadSceneModule(); });
    after(() => { if (M) M.restore(); });

    test('say: typewriter on the scene clock, full text, then auto-dismiss resolves the promise', async () => {
        const S = await makeScene();
        assert.equal(typeof S.say, 'function');
        let done = false;
        S.say({ side: 'w', text: 'Have at thee, bony knave!', square: { row: 7, col: 4 }, durationMs: 1500 }).then(() => { done = true; });
        S.stepFrames(3);
        const el = bubbleEl('w');
        assert.ok(el, 'bubble element');
        assert.equal(el.getAttribute('aria-hidden'), 'true', 'captions go to the aria-live region instead');
        const partial = el.textContent.length;
        assert.ok(visible('w'));
        S.stepFrames(60);
        assert.match(el.querySelector('span:nth-child(2)').textContent, /Have at thee, bony knave!/);
        assert.ok(partial > 0);
        S.stepFrames(Math.ceil((1.5 + 0.35) * 60));
        await null; await null;
        assert.equal(done, true, 'resolved after duration + fade');
        assert.equal(el.style.display, 'none');
        S.dispose(); cleanup();
    });

    test('one bubble per king: a new remark replaces the old (old promise resolves); kings are independent', async () => {
        const S = await makeScene();
        let first = false, black = false;
        S.say({ side: 'w', text: 'First', square: { row: 7, col: 4 } }).then(() => { first = true; });
        S.say({ side: 'b', text: 'Rattle', square: { row: 0, col: 4 } }).then(() => { black = true; });
        S.stepFrames(5);
        S.say({ side: 'w', text: 'Second', square: { row: 7, col: 4 } });
        S.stepFrames(30);
        await null; await null;
        assert.equal(first, true, 'replaced bubble resolved');
        assert.equal(black, false, 'other king untouched');
        assert.equal(document.querySelectorAll('.b3d-bubble[data-side="w"]').length, 1, 'reuses one element');
        assert.match(bubbleEl('w').textContent, /Second/);
        assert.ok(visible('b'));
        S.dispose(); cleanup();
    });

    test('reduced motion: full text at once, clear() removes instantly', async () => {
        const S = await makeScene({ reducedMotion: true });
        let done = false;
        S.say({ side: 'b', text: 'Bones do not bleed.', square: { row: 0, col: 4 } }).then(() => { done = true; });
        S.stepFrames(1);
        assert.match(bubbleEl('b').querySelector('span:nth-child(2)').textContent, /^Bones do not bleed\.$/);
        assert.equal(Number(bubbleEl('b').style.opacity), 1, 'no fade-in');
        S.sayClear('b');
        await null; await null;
        assert.equal(done, true, 'cleared instantly');
        S.dispose(); cleanup();
    });

    test('stays inside the viewport for kings on every edge square; flips below near the top', async () => {
        const S = await makeScene();
        for (const sq of [{ row: 0, col: 0 }, { row: 0, col: 7 }, { row: 7, col: 0 }, { row: 7, col: 7 }, { row: 3, col: 3 }]) {
            S.say({ side: 'w', text: 'Edge!', square: sq });
            S.stepFrames(3);
            const r = rectOf('w');
            assert.ok(r, 'positioned');
            assert.ok(r.left >= 8 - 0.5 && r.right <= W - 8 + 0.5 && r.top >= 8 - 0.5 && r.bottom <= H - 8 + 0.5, `${JSON.stringify(sq)} -> ${JSON.stringify(r)}`);
        }
        // an anchor right at the top of the screen puts the bubble below it (tail up)
        // find a world point that projects just below the top edge, then anchor a bubble there
        const v = new M.THREE.Vector3();
        let anchor = null;
        for (let z = -4; z > -40 && !anchor; z -= 0.25) {
            v.set(0, 1, z).project(S.camera);
            const ay = ((1 - v.y) / 2) * H;
            if (ay > 20 && ay < 50 && v.z < 1) anchor = new M.THREE.Vector3(0, 1, z);
        }
        assert.ok(anchor, 'found an anchor near the top of the screen');
        S.say({ side: 'w', text: 'Up here', anchor });
        S.stepFrames(3);
        assert.ok(bubbleEl('w').classList.contains('below'), 'near the top the bubble hangs below its anchor');
        assert.ok(rectOf('w').top >= 8);
        S.dispose(); cleanup();
    });

    test("avoids HUD panels and the other king's bubble", async () => {
        const S = await makeScene();
        const hud = document.createElement('div');
        hud.id = 'hud';
        const panel = document.createElement('div');
        hud.append(panel);
        document.body.append(hud);
        S.say({ side: 'w', text: 'Where am I?', square: { row: 4, col: 4 } });
        S.stepFrames(3);
        const free = rectOf('w');
        panel.getBoundingClientRect = () => ({ left: free.left - 10, top: free.top - 10, right: free.right + 10, bottom: free.bottom + 10, width: BW + 20, height: BH + 20 });
        S.stepFrames(3);
        const moved = rectOf('w');
        const hr = panel.getBoundingClientRect();
        assert.ok(!overlap(moved, hr), `bubble ${JSON.stringify(moved)} avoids HUD ${JSON.stringify(hr)}`);
        // two kings close together: their bubbles do not overlap
        S.say({ side: 'b', text: 'Too close', square: { row: 4, col: 5 } });
        S.stepFrames(3);
        assert.ok(!overlap(rectOf('w'), rectOf('b')), `${JSON.stringify(rectOf('w'))} vs ${JSON.stringify(rectOf('b'))}`);
        S.dispose(); cleanup();
    });

    test('hidden during letterbox (fight cinematic) unless showInCinematic; comes back after', async () => {
        const S = await makeScene();
        S.say({ side: 'w', text: 'Mind the gap', square: { row: 7, col: 4 }, durationMs: 5000 });
        S.say({ side: 'b', text: 'I insist', square: { row: 0, col: 4 }, durationMs: 5000, showInCinematic: true });
        S.stepFrames(10);
        S.cinematic.letterbox(true);
        S.stepFrames(2);
        assert.equal(visible('w'), false, 'hidden in letterbox');
        assert.equal(visible('b'), true, 'showInCinematic stays');
        S.cinematic.letterbox(false);
        S.stepFrames(2);
        assert.equal(visible('w'), true, 'back after letterbox');
        S.dispose(); cleanup();
    });

    test('text is text: no HTML injection; empty text shows nothing', async () => {
        const S = await makeScene();
        S.say({ side: 'w', text: '<img src=x onerror=alert(1)><b>bold</b>', square: { row: 7, col: 4 } });
        S.stepFrames(120);
        const el = bubbleEl('w');
        assert.equal(el.querySelector('img, b'), null, 'no elements created from text');
        assert.match(el.textContent, /<img src=x/);
        let done = false;
        S.say({ side: 'b', text: '   ', square: { row: 0, col: 4 } }).then(() => { done = true; });
        await null; await null;
        assert.equal(done, true);
        assert.equal(visible('b'), false);
        S.dispose(); cleanup();
    });

    test('getBubble / stats().bubbles; sayClear() with no side clears both', async () => {
        const S = await makeScene();
        S.say({ side: 'w', text: 'One', square: { row: 7, col: 4 } });
        S.say({ side: 'b', text: 'Two', square: { row: 0, col: 4 } });
        S.stepFrames(30);
        assert.deepEqual([...S.stats().bubbles].sort(), ['b', 'w']);
        assert.equal(S.getBubble('w').text, 'One');
        assert.ok(S.getBubble('w').shown.length > 0);
        S.sayClear();
        S.stepFrames(30);
        assert.equal(S.getBubble('w'), null);
        assert.equal(S.getBubble('b'), null);
        assert.deepEqual([...S.stats().bubbles], []);
        S.dispose(); cleanup();
    });

    test('render rate: full while typing or fading, idle while holding still', async () => {
        const S = await makeScene();
        M.raf.run(1.5);
        S.say({ side: 'w', text: 'A rather long remark that takes a while to type out.', square: { row: 7, col: 4 }, durationMs: 6000 });
        M.raf.run(0.3);
        assert.equal(S.stats().mode, 'full', 'typing');
        M.raf.run(1.4); // typed out (~38 chars/s), now holding
        assert.equal(S.stats().mode, 'idle', 'holding still');
        S.dispose(); cleanup();
    });

    test('an anchor behind the camera: hidden, no NaN transform', async () => {
        const S = await makeScene();
        const behind = S.camera.position.clone().add(S.camera.getWorldDirection(new M.THREE.Vector3()).multiplyScalar(-5));
        S.say({ side: 'w', text: 'Behind you', anchor: behind });
        S.stepFrames(10);
        assert.equal(visible('w'), false);
        assert.ok(!/NaN/.test(bubbleEl('w').style.transform || ''), bubbleEl('w').style.transform);
        S.dispose(); cleanup();
    });

    test('render-on-demand: say wakes a sleeping scene', async () => {
        const S = await makeScene();
        M.raf.run(5);
        assert.equal(S.stats().mode, 'sleep');
        S.say({ side: 'w', text: 'Wake up!', square: { row: 7, col: 4 } });
        M.raf.run(0.2);
        assert.notEqual(S.stats().mode, 'sleep');
        S.dispose(); cleanup();
    });
});
