'use strict';
// v6.2 review arrows in scene.js / scene-fx.js (fake renderer): setArrows shows the played and the better
// move at once as two meshes ('arrow-played', 'arrow-better') that differ by more than colour; knight
// moves arc, a shared from-square is drawn side by side, nothing throws or goes NaN; the scene draws
// at once (no rAF, also while paused); the hint arrow and the highlights are independent; invalid
// entries are dropped; arrows survive view changes and clear completely.
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
    S.renderer = renderer;
    return S;
}
const sq = (s) => ({ row: 8 - Number(s[1]), col: s.charCodeAt(0) - 97 });
const mv = (uci, kind, extra = {}) => ({ from: sq(uci.slice(0, 2)), to: sq(uci.slice(2, 4)), kind, ...extra });
const mesh = (S, kind) => S.scene.getObjectByName(`arrow-${kind}`);
const shown = (S) => ['played', 'better'].filter((k) => mesh(S, k)?.visible);
// World-space vertices actually drawn
function verts(S, name) {
    const m = S.scene.getObjectByName(name);
    m.updateMatrixWorld(true);
    const pos = m.geometry.attributes.position, dr = m.geometry.drawRange;
    const idx = m.geometry.index;
    const n = dr.count === Infinity ? (idx ? idx.count : pos.count) : dr.count;
    const out = [], v = new M.THREE.Vector3();
    for (let i = dr.start; i < dr.start + n; i++) out.push(v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld).clone());
    return out;
}
const finite = (vs) => vs.every((v) => [v.x, v.y, v.z].every(Number.isFinite));
const maxY = (vs) => Math.max(...vs.map((v) => v.y));
const centroid = (vs) => vs.reduce((a, v) => a.add(v), new M.THREE.Vector3()).multiplyScalar(1 / vs.length);
const uniform = (S, kind, u) => mesh(S, kind).material.uniforms[u]?.value;

describe('battle3d scene review arrows (v6.2)', { skip }, () => {
    before(async () => { M = await loadSceneModule(); });
    after(() => { if (M) M.restore(); });

    test('API; nothing shown until arrows are set; played + better show two meshes in order', async () => {
        const S = await makeScene();
        for (const f of ['setArrows', 'clearArrows', 'getArrows']) assert.equal(typeof S[f], 'function', f);
        assert.deepEqual(shown(S), []);
        assert.deepEqual(S.getArrows(), []);
        S.setArrows([mv('f1c4', 'played'), mv('g1f3', 'better')]);
        assert.deepEqual(shown(S), ['played', 'better']);
        assert.deepEqual(S.getArrows().map((a) => [a.kind, a.from, a.to]), [['played', sq('f1'), sq('c4')], ['better', sq('g1'), sq('f3')]]);
        assert.deepEqual((S.stats().arrows || []).map((a) => a.kind), ['played', 'better'], 'stats().arrows');
        assert.ok(finite(verts(S, 'arrow-played')) && finite(verts(S, 'arrow-better')), 'no NaN');
        // each arrow lies over its own move: the centroid is near the middle of from and to
        for (const [kind, a, b] of [['played', 'f1', 'c4'], ['better', 'g1', 'f3']]) {
            const c = centroid(verts(S, `arrow-${kind}`)), fa = sq(a), fb = sq(b);
            const mid = { x: (fa.col + fb.col) / 2 - 3.5, z: (fa.row + fb.row) / 2 - 3.5 };
            assert.ok(Math.hypot(c.x - mid.x, c.z - mid.z) < 1.0, `${kind} arrow over ${a}-${b} (centroid ${c.x.toFixed(2)}, ${c.z.toFixed(2)})`);
        }
        S.dispose();
    });

    test('only the played arrow for a single entry; the two kinds differ by more than colour', async () => {
        const S = await makeScene();
        S.setArrows([mv('e2e4', 'played')]);
        assert.deepEqual(shown(S), ['played'], 'a best or unflagged move shows one arrow');
        S.setArrows([mv('e2e4', 'played'), mv('d2d4', 'better')]);
        const col = (k) => uniform(S, k, 'uColor').getHex();
        assert.notEqual(col('played'), col('better'), 'different colours');
        const shape = (k) => ['uDash', 'uPulse', 'uAlpha'].map((u) => Number(uniform(S, k, u) ?? NaN));
        assert.notDeepEqual(shape('played'), shape('better'), `different style besides colour: ${shape('played')} vs ${shape('better')}`);
        assert.equal(uniform(S, 'played', 'uDash'), 1, 'the played move is dashed');
        assert.equal(uniform(S, 'better', 'uDash'), 0, 'the better move is solid');
        if (typeof S.arrowStyle === 'function') {
            assert.notEqual(S.arrowStyle('played').color, S.arrowStyle('better').color, 'legend colours differ');
            assert.match(String(S.arrowStyle('played').color), /^#[0-9a-f]{6}$/i);
        }
        S.dispose();
        const R = await makeScene({ reducedMotion: true });
        R.setArrows([mv('e2e4', 'played'), mv('d2d4', 'better')]);
        assert.equal(uniform(R, 'better', 'uPulse'), 0, 'no pulse under reduced motion');
        assert.equal(uniform(R, 'played', 'uDash'), 1, 'still told apart by the dashes');
        R.dispose();
    });

    test('draws at once: one render inside setArrows and clearArrows, without rAF, also while paused', async () => {
        const S = await makeScene();
        S.stepFrames(400); // idle long enough to sleep
        let r0 = S.renderer.renders;
        S.setArrows([mv('f1c4', 'played'), mv('g1f3', 'better')]);
        assert.ok(S.renderer.renders > r0, 'rendered inside setArrows (no frame was stepped)');
        r0 = S.renderer.renders;
        S.clearArrows();
        assert.ok(S.renderer.renders > r0, 'rendered inside clearArrows');
        if (typeof S.setPaused === 'function') {
            S.setPaused(true);
            r0 = S.renderer.renders;
            S.setArrows([mv('e2e4', 'played')]);
            assert.ok(S.renderer.renders > r0, 'rendered while paused (hidden tab)');
            S.setPaused(false);
        }
        S.dispose();
    });

    test('knight moves arc over the board; straight moves lie flat; a capture colours the better arrow\'s target', async () => {
        const S = await makeScene();
        S.setArrows([mv('g1h3', 'played'), mv('g1f3', 'better')]);
        assert.ok(maxY(verts(S, 'arrow-played')) > 0.4 && maxY(verts(S, 'arrow-better')) > 0.4, 'both knight arrows arc');
        assert.ok(finite(verts(S, 'arrow-played')) && finite(verts(S, 'arrow-better')));
        S.setArrows([mv('a1a8', 'played'), mv('h1h8', 'better')]);
        assert.ok(maxY(verts(S, 'arrow-played')) < 0.2 && maxY(verts(S, 'arrow-better')) < 0.2, 'straight arrows lie on the board');
        const plain = uniform(S, 'better', 'uTargetColor')?.getHex();
        S.setArrows([mv('a1a8', 'played'), mv('h1h8', 'better', { capture: true })]);
        if (plain !== undefined) assert.notEqual(uniform(S, 'better', 'uTargetColor').getHex(), plain, 'capture target coloured differently');
        S.dispose();
    });

    test('shared from-square: the two arrows are drawn side by side, not on top of each other', async () => {
        const S = await makeScene();
        S.setArrows([mv('c1g5', 'played')]);
        const alone = centroid(verts(S, 'arrow-played'));
        assert.doesNotThrow(() => S.setArrows([mv('c1g5', 'played'), mv('c1f4', 'better')]));
        const shared = centroid(verts(S, 'arrow-played'));
        assert.ok(finite(verts(S, 'arrow-played')) && finite(verts(S, 'arrow-better')));
        assert.ok(alone.distanceTo(shared) > 0.02, `the played arrow moves aside when it shares c1 (${alone.distanceTo(shared).toFixed(3)})`);
        // same squares for both moves (the player found the idea but the engine prefers the same squares another way): no throw
        assert.doesNotThrow(() => S.setArrows([mv('c1g5', 'played'), mv('c1g5', 'better')]));
        assert.ok(finite(verts(S, 'arrow-played')) && finite(verts(S, 'arrow-better')));
        // no shared square: no shift
        S.setArrows([mv('c1g5', 'played'), mv('g1f3', 'better')]);
        assert.ok(alone.distanceTo(centroid(verts(S, 'arrow-played'))) < 1e-3, 'no shift without a shared square');
        // a knight sharing its square with a knight
        assert.doesNotThrow(() => S.setArrows([mv('g1h3', 'played'), mv('g1e2', 'better')]));
        S.dispose();
    });

    test('independent of the hint arrow and the highlights', async () => {
        const S = await makeScene();
        const HINT = { from: sq('e2'), to: sq('e4') };
        S.setHint(HINT);
        S.setHighlights({ selected: sq('e2'), moves: [sq('e3'), sq('e4')], lastMove: null, check: null, hover: null });
        const hintVerts = JSON.stringify(verts(S, 'hint').slice(0, 6).map((v) => v.toArray()));
        S.setArrows([mv('f1c4', 'played'), mv('g1f3', 'better')]);
        assert.deepEqual([S.getHint().from, S.getHint().to], [HINT.from, HINT.to], 'hint untouched by setArrows');
        assert.equal(S.scene.getObjectByName('hint').visible, true);
        assert.equal(JSON.stringify(verts(S, 'hint').slice(0, 6).map((v) => v.toArray())), hintVerts);
        S.clearArrows();
        assert.equal(S.scene.getObjectByName('hint').visible, true, 'hint untouched by clearArrows');
        S.setArrows([mv('f1c4', 'played')]);
        S.setHint(null);
        assert.deepEqual(shown(S), ['played'], 'arrows untouched by setHint(null)');
        S.setHighlights({ selected: null, moves: [], lastMove: null, check: null, hover: null });
        assert.deepEqual(shown(S), ['played'], 'arrows untouched by clearing highlights');
        S.dispose();
    });

    test('invalid entries are dropped; null and [] clear; nothing throws', async () => {
        const S = await makeScene();
        const bad = [{ from: { row: 8, col: 0 }, to: sq('a1'), kind: 'played' }, { from: sq('a1'), to: { row: 0, col: -1 }, kind: 'better' }, { from: sq('a1'), to: sq('a1'), kind: 'played' }, { from: sq('a1'), kind: 'played' }, { kind: 'better' }, null, {}];
        for (const b of bad) {
            assert.doesNotThrow(() => S.setArrows([b]), JSON.stringify(b));
            assert.deepEqual(shown(S), [], `dropped ${JSON.stringify(b)}`);
        }
        S.setArrows([bad[0], mv('g1f3', 'better')]);
        assert.deepEqual(shown(S), ['better'], 'valid entries next to invalid ones are kept');
        for (const empty of [null, undefined, []]) {
            S.setArrows([mv('e2e4', 'played'), mv('d2d4', 'better')]);
            assert.doesNotThrow(() => S.setArrows(empty));
            assert.deepEqual(shown(S), [], `setArrows(${JSON.stringify(empty)}) clears`);
            assert.deepEqual(S.getArrows(), []);
        }
        assert.doesNotThrow(() => S.setArrows([mv('e2e4', 'weird')]));
        assert.equal(shown(S).length, 1, 'an unknown kind still shows one arrow');
        S.dispose();
    });

    test('arrows survive view changes and frames, then clear completely', async () => {
        const S = await makeScene();
        S.setArrows([mv('f1c4', 'played'), mv('g1f3', 'better')]);
        await S.setView('b', { animate: false });
        S.stepFrames(30);
        S.resetView?.({ animate: false });
        S.stepFrames(30);
        assert.deepEqual(shown(S), ['played', 'better']);
        assert.equal(S.getArrows().length, 2);
        assert.ok(finite(verts(S, 'arrow-played')) && finite(verts(S, 'arrow-better')));
        const tokens = [...S.stats().activeTokens];
        S.clearArrows();
        assert.deepEqual(shown(S), []);
        assert.deepEqual(S.getArrows(), []);
        assert.deepEqual(S.stats().activeTokens, tokens, 'no keepAlive token left behind');
        S.dispose();
    });
});
