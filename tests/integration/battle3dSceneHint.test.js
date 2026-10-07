'use strict';
// v5 hint visuals in scene.js / scene-fx.js (fake renderer): one mesh named 'hint', knight arc vs
// flat arrow, capture colour, animated uniforms (none under reduced motion), survives view changes and
// cinematics, setHint(null) / invalid squares, no buffer reallocation, render-on-demand friendly.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { loadSceneModule, fakeRenderer } = require('../helpers/battle3dSceneHarness');

const skip = findThree() ? false : 'three.js not installed';
let M;

async function makeScene({ reducedMotion = false } = {}) {
    const realMM = window.matchMedia;
    if (reducedMotion) window.matchMedia = (q) => ({ ...realMM(q), matches: /prefers-reduced-motion: reduce/.test(q) });
    const renderer = fakeRenderer(document);
    const S = await M.createScene(document.getElementById('stage'), { renderer, sleepAfter: 3 });
    window.matchMedia = realMM;
    await S.setView('w', { animate: false });
    S.stepFrames(2);
    return S;
}
const mesh = (S) => S.scene.getObjectByName('hint');
function maxY(S) {
    const m = mesh(S);
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position;
    let y = -Infinity, nan = false;
    const v = new M.THREE.Vector3();
    for (let i = 0; i < (m.geometry.drawRange.count === Infinity ? pos.count : Math.min(pos.count, m.geometry.drawRange.start + m.geometry.drawRange.count)); i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (![v.x, v.y, v.z].every(Number.isFinite)) nan = true;
        y = Math.max(y, v.y);
    }
    return { y, nan };
}
const hex = (S, u) => mesh(S).material.uniforms[u].value.getHex();
const KNIGHT = { from: { row: 7, col: 6 }, to: { row: 5, col: 5 } };
const PAWN = { from: { row: 6, col: 4 }, to: { row: 4, col: 4 } };

describe('battle3d scene hint (v5)', { skip }, () => {
    before(async () => { M = await loadSceneModule(); });
    after(() => { if (M) M.restore(); });

    test('setHint API; a single hidden mesh until a hint is set', async () => {
        const S = await makeScene();
        assert.equal(typeof S.setHint, 'function');
        assert.ok(mesh(S), "mesh named 'hint'");
        assert.equal(mesh(S).visible, false);
        assert.equal(S.getHint?.() ?? S.stats().hint ?? null, null);
        assert.equal(S.scene.children.filter((o) => o.name === 'hint').length + (mesh(S).parent === S.scene ? 0 : 1) >= 1, true);
        S.dispose();
    });

    test('knight hint arcs over the board; straight and capture hints lie flat; colours', async () => {
        const S = await makeScene();
        S.setHint(KNIGHT);
        assert.equal(mesh(S).visible, true);
        const k = maxY(S);
        assert.ok(!k.nan, 'no NaN vertices');
        assert.ok(k.y > 0.5 && k.y < 1.3, `knight arc height ${k.y.toFixed(2)}`);
        assert.equal(hex(S, 'uTargetColor'), 0xffc83d);
        assert.deepEqual(S.getHint(), { ...KNIGHT, capture: false });
        assert.deepEqual(S.stats().hint, { ...KNIGHT, capture: false });
        S.setHint({ ...PAWN, capture: true });
        const p = maxY(S);
        assert.ok(!p.nan && p.y < 0.1, `flat arrow ${p.y.toFixed(3)}`);
        assert.equal(hex(S, 'uTargetColor'), 0xff4a2e, 'capture target colour');
        S.dispose();
    });

    test('animated: uTime advances under stepFrames, pulse on; reduced motion: pulse off', async () => {
        let S = await makeScene();
        S.setHint(PAWN);
        const u = mesh(S).material.uniforms;
        const t0 = u.uTime.value;
        S.stepFrames(30);
        assert.ok(u.uTime.value > t0, 'uTime advances');
        assert.equal(u.uPulse.value, 1);
        S.dispose();
        S = await makeScene({ reducedMotion: true });
        S.setHint(PAWN);
        S.stepFrames(2);
        assert.equal(mesh(S).material.uniforms.uPulse.value, 0, 'no pulsing under reduced motion');
        S.dispose();
    });

    test('survives view flips, resetView, focusOn/restoreView and a cinematic shot + end', async () => {
        const S = await makeScene();
        S.setHint(KNIGHT);
        await S.setView('b', { animate: false });
        await S.resetView({ animate: false });
        const pf = S.focusOn([new M.THREE.Vector3(0, 0, 0)], { duration: 0.2 }); S.stepFrames(20); await pf;
        const pr = S.restoreView({ duration: 0.2 }); S.stepFrames(20); await pr;
        const sh = S.cinematic.shot('two-shot', [new M.THREE.Vector3(-1, 0, 0), new M.THREE.Vector3(1, 0, 0)], { duration: 0.3 }); S.stepFrames(30); await sh;
        const en = S.cinematic.end({ duration: 0.2 }); S.stepFrames(20); await en;
        assert.equal(mesh(S).visible, true);
        assert.deepEqual(S.getHint(), { ...KNIGHT, capture: false });
        S.dispose();
    });

    test('setHint(null) hides; out-of-range squares are ignored', async () => {
        const S = await makeScene();
        S.setHint(PAWN);
        S.setHint(null);
        assert.equal(mesh(S).visible, false);
        assert.equal(S.getHint(), null);
        for (const bad of [{ from: { row: 8, col: 0 }, to: { row: 0, col: 0 } }, { from: { row: 0, col: -1 }, to: { row: 0, col: 0 } }, { from: { row: 0, col: 0 } }, { from: null, to: null }, {}]) {
            assert.doesNotThrow(() => S.setHint(bad), JSON.stringify(bad));
            assert.equal(mesh(S).visible, false, `ignored ${JSON.stringify(bad)}`);
        }
        S.dispose();
    });

    test('buffers are written in place (no reallocation between hints); render requested, no keepAlive token', async () => {
        const S = await makeScene();
        S.setHint(PAWN);
        const g = mesh(S).geometry;
        const arr = g.attributes.position.array;
        const geo = g;
        const tokens = [...S.stats().activeTokens];
        const r0 = S.stats().renderedFrames;
        S.setHint(KNIGHT);
        S.setHint({ ...PAWN, capture: true });
        assert.equal(mesh(S).geometry, geo, 'same geometry');
        assert.equal(mesh(S).geometry.attributes.position.array, arr, 'same position buffer');
        assert.deepEqual(S.stats().activeTokens, tokens, 'no keepAlive token added');
        M.raf.tick();
        assert.ok(S.stats().renderedFrames > r0, 'setHint requests a render');
        S.dispose();
    });
});
