'use strict';
// Regression: Apply in the Cast editor must rebuild the board live with library packs (pack models and
// mounted knights), exactly like a reload with the saved cast does. A pack that cannot be downloaded
// falls back to the default characters with a visible notice instead of silently doing nothing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { findThree, ROOT } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const H = require('../helpers/battle3dUnitsHarness');

const skip = !findThree() ? 'three.js not installed'
    : !fs.existsSync(path.join(ROOT, 'battle3d', 'assets', 'library.json')) ? 'no library' : false;
let P;
const pageRules = () => ({ get: () => P.board() });
const KNIGHTS = [[7, 1], [7, 6], [0, 1], [0, 6]];

async function applyPreset(id) {
    const deadline = Date.now() + 15000;
    if (P.$('cast-modal').hidden) P.$('cast-open').click();
    while (!P.$('cast-mount').querySelector('.ce-primary') && Date.now() < deadline) await P.sleep(10);
    const mount = P.$('cast-mount');
    const select = mount.querySelector('select.ce-select');
    select.value = id;
    select.dispatchEvent(new P.w.Event('change'));
    // Apply right away: the live path must not depend on the preset's pack download having finished
    const btn = mount.querySelector('.ce-primary');
    btn.click();
    btn.click(); // a double click must not start a second, interleaved rebuild
    while (!P.$('cast-modal').hidden && Date.now() < deadline) await P.sleep(10);
    assert.equal(P.$('cast-modal').hidden, true, `${id}: modal closes after Apply`);
    assert.equal(JSON.parse(P.w.localStorage.getItem('battle3d.cast.v1')).preset, id);
}

describe('battle3d cast editor: live Apply with library packs', { skip }, () => {
    before(async () => { P = await bootPage({ setup: (w) => w.localStorage.setItem('battle3d.tipSeen', '1') }); });
    after(() => { if (P) P.restore(); });

    test('a pack that fails to download: defaults stand in and a notice says so', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (input, init) => (/quaternius-farm/.test(String(input?.url || input))
            ? Promise.resolve(new Response(null, { status: 404 })) : realFetch(input, init));
        try { await applyPreset('mounted'); } finally { globalThis.fetch = realFetch; }
        for (const [r, c] of KNIGHTS) assert.equal(P.B.units.unitAt(r, c).horse, undefined, `knight ${r},${c} on foot`);
        assert.equal(P.$('tip').hidden, false, 'notice visible');
        assert.match(P.$('tip-text').textContent, /quaternius-farm/);
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after a failed pack');
        P.$('tip-close').click();
    });

    test('Mounted knights: Apply rebuilds the board with every knight on a horse (no reload)', async () => {
        await applyPreset('mounted');
        for (const [r, c] of KNIGHTS) {
            const u = P.B.units.unitAt(r, c);
            assert.ok(u.horse && u.horse.model.parent, `knight ${r},${c} rides a horse in the scene`);
        }
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after mounted');
    });

    test('Adventurers vs Skeletons: pack models replace the white army live, horses are gone', async () => {
        const cast = await import(require('node:url').pathToFileURL(path.join(ROOT, 'battle3d', 'cast.js')).href);
        const ids = cast.castPackIds(cast.presetCast('adventurers'));
        assert.ok(ids.length, 'adventurers uses a pack');
        const before = new Set(P.B.units._units);
        await applyPreset('adventurers');
        const roles = cast.resolveRoles(JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', 'manifest.json'), 'utf8')), cast.presetCast('adventurers'));
        assert.match(roles.w.k.model, /^packs\//, 'white king is a pack model');
        const legend = P.B.units.getLegend();
        assert.equal(legend.find((e) => e.color === 'w' && e.type === 'k').model, roles.w.k.model.split('/').pop().replace(/\.(glb|gltf)$/i, '').replace(/_/g, ' '));
        for (const u of P.B.units._units) assert.ok(!before.has(u), 'every unit rebuilt');
        for (const [r, c] of KNIGHTS) assert.equal(P.B.units.unitAt(r, c).horse, undefined);
        H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after adventurers');
        assert.deepEqual(P.errors.filter((e) => !/Error creating WebGL context/.test(e)), []);
    });

    // Background tab: rAF never fires (this harness only runs rAF callbacks on P.tick, which is never
    // called here) and timers are throttled. The rebuild must still finish and reach the canvas.
    test('switches to Mounted with rAF paused: the rendered frame shows the new cast right after Apply', async () => {
        const rendered = [];
        const orig = P.renderer.render;
        P.renderer.render = (scene, camera) => {
            const live = [...P.B.units._units];
            let onBoard = 0;
            scene.traverse((o) => { if (live.some((u) => u.root === o)) onBoard++; });
            let roots = 0;
            for (const u of live) if (u.root.parent) roots++;
            rendered.push({ horses: live.filter((u) => u.horse && u.horse.model.parent === u.root).length, units: live.length, onBoard, roots, king: P.B.units.getLegend()[0].name });
            return orig.call(P.renderer, scene, camera);
        };
        try {
            for (const [id, horses] of [['classic', 0], ['mounted', 4], ['adventurers', 0], ['mounted', 4]]) {
                const n = rendered.length;
                await applyPreset(id);
                assert.ok(rendered.length > n, `${id}: a frame was drawn after Apply without rAF`);
                const last = rendered.at(-1);
                assert.equal(last.horses, horses, `${id}: horses in the drawn frame`);
                assert.equal(last.units, 32);
                assert.equal(last.onBoard, 32, `${id}: only the rebuilt units are in the scene`);
                for (const [r, c] of KNIGHTS) assert.equal(!!P.B.units.unitAt(r, c).horse, horses > 0, `${id}: knight ${r},${c}`);
                H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), `after ${id}`);
            }
            // The debug hook: a fractional frame count still advances one frame and renders it
            const n = rendered.length;
            P.B.step(1 / 30);
            assert.equal(rendered.length, n + 1, 'step(1 / 30) renders');
            for (const u of P.B.units._units) assert.ok([u.root.position.x, u.root.position.z].every(Number.isFinite));
        } finally { P.renderer.render = orig; }
        assert.deepEqual(P.errors.filter((e) => !/Error creating WebGL context/.test(e)), []);
    });
});
