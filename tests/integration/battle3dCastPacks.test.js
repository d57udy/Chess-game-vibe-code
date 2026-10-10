'use strict';
// v6 cast.js with the model library: registerPack for every pack; all presets resolve; pack roles are
// native with bones/impacts/scale; mounted knights get a mount with saddle and rider clip; castPackIds,
// creditsFor, unregistered-pack fallback; prepareCast loads only referenced packs and reports failures;
// importCustomModel: FBX advice, triangle budgets (warn / fail), KayKit / Mixamo (retarget) / static rigs
// and the VRM path through an injected loader.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');
const { findThree, registerThree, installBrowserGlobals } = require('../helpers/loadBattle3dThree');
const { buildGlb, buildHumanoid } = require('../helpers/glbFixture');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const LIB = path.join(ASSETS, 'library.json');
const skip = !fs.existsSync(LIB) ? 'no library.json' : !findThree() ? 'three.js not installed' : false;
let cast, manifest, packs, THREE, GLTFLoader;
const fileOf = (buf, name) => new File([buf], name);
const BASE = 'https://example.github.io/Chess-game-vibe-code/battle3d/assets/';

describe('battle3d cast.js + model library (v6)', { skip }, () => {
    before(async () => {
        registerThree(findThree().dir);
        installBrowserGlobals();
        THREE = await import('three');
        ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
        cast = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'cast.js')).href + '?packs');
        manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
        packs = JSON.parse(fs.readFileSync(LIB, 'utf8')).packs.map((p) => JSON.parse(fs.readFileSync(path.join(ASSETS, p.path), 'utf8')));
    });

    test('prepareCast loads only the packs a cast references and reports the ones that fail', async () => {
        const fetched = [];
        const fetchFn = async (url) => {
            fetched.push(url);
            const rel = url.slice(BASE.length);
            if (rel.includes('quaternius-farm')) return { ok: false, status: 404, json: async () => null };
            const f = path.join(ASSETS, rel);
            return fs.existsSync(f) ? { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) } : { ok: false, status: 404, json: async () => null };
        };
        const c = cast.presetCast('monsters');
        const r = await cast.prepareCast(c, { assetBase: BASE, fetch: fetchFn });
        assert.deepEqual(r.failed, []);
        assert.ok(fetched.some((u) => u.endsWith('packs/quaternius-monsters/pack.json')));
        assert.ok(!fetched.some((u) => /quaternius-(rpg|farm)\/pack\.json/.test(u)), `only referenced packs: ${fetched}`);
        const m = await cast.prepareCast(cast.presetCast('mounted'), { assetBase: BASE, fetch: fetchFn });
        assert.deepEqual(m.failed.map((f) => f.id), ['quaternius-farm'], 'a failing pack is reported, not thrown');
    });

    test('registered packs: every preset resolves; pack roles are native with bones, impacts and scale', () => {
        for (const p of packs) cast.registerPack(p);
        assert.equal(Object.keys(cast.PRESETS).length, 9);
        let packRoles = 0;
        for (const id of Object.keys(cast.PRESETS)) {
            const roles = cast.resolveRoles(manifest, cast.presetCast(id));
            for (const c of ['w', 'b']) for (const t of 'pnbrqk') {
                const r = roles[c][t];
                assert.ok(r.model && r.scale > 0, `${id} ${c}${t}`);
                const want = String(cast.presetCast(id).roles[c][t].model).startsWith('pack:');
                assert.equal(r.source === 'pack', want, `${id} ${c}${t}: pack model resolved from the pack`);
                if (r.source === 'pack') {
                    packRoles++;
                    assert.equal(r.native, true, `${id} ${c}${t} native`);
                    assert.deepEqual(r.props, []);
                    assert.ok(r.bones && typeof r.bones === 'object', 'bones');
                    assert.ok(r.anims && r.anims.idle, 'anims');
                    for (const a of [].concat(r.anims.attack || [])) assert.ok(Number.isFinite(r.impacts?.[a]), `${id} ${c}${t}: impact for ${a}`);
                    assert.ok(fs.existsSync(path.join(ASSETS, r.model)), r.model);
                    for (const k of ['walkSpeed', 'runSpeed']) assert.ok(r[k] === null || (Number.isFinite(r[k]) && r[k] > 0), `${id} ${c}${t} ${k}: ${r[k]}`);
                }
                if (r.mount) for (const k of ['walkSpeed', 'runSpeed']) assert.ok(r.mount[k] === null || (Number.isFinite(r.mount[k]) && r.mount[k] > 0), `${id} ${c}${t} mount ${k}: ${r.mount[k]}`);
            }
        }
        assert.equal(packRoles, 6 + 4 + 6, 'adventurers (6), monsters (4), barnyard (6)');
    });

    test('mounted preset: both knights ride with a saddle and the seated rider clip; only the farm pack is needed', () => {
        const c = cast.presetCast('mounted');
        assert.deepEqual(cast.castPackIds(c), ['quaternius-farm']);
        const roles = cast.resolveRoles(manifest, c);
        const clipNames = new Set((() => { const d = fs.readFileSync(path.join(ASSETS, 'anims', 'clips.glb')); return JSON.parse(d.subarray(20, 20 + d.readUInt32LE(12)).toString('utf8')).animations.map((a) => a.name); })());
        for (const color of ['w', 'b']) {
            const m = roles[color].n.mount;
            assert.ok(m && m.model && fs.existsSync(path.join(ASSETS, m.model)), `${color} knight mount model`);
            assert.ok(m.saddle, 'saddle position');
            assert.equal(m.riderAnim, 'Sit_Chair_Idle');
            assert.ok(clipNames.has('Sit_Chair_Idle'), 'rider clip shipped in clips.glb');
            assert.ok(m.scale > 0 && m.scale < 1, `mount scale ${m.scale}`);
            assert.ok(m.riderScale > 0 && m.riderScale <= 1, `riderScale ${m.riderScale}`);
        }
        const credits = cast.creditsFor(roles);
        assert.ok(credits.some((x) => /Quaternius/.test(x) && /CC0/.test(x)), `credits: ${credits}`);
    });

    test('pack licences: CC0 with a submitted date that CREDITS.md repeats', () => {
        const credits = fs.readFileSync(path.join(ASSETS, 'CREDITS.md'), 'utf8');
        for (const p of packs) {
            assert.match(String(p.license?.submitted), /^\d{4}-\d{2}-\d{2}$/, `${p.id} license.submitted`);
            assert.ok(credits.includes(p.license.submitted), `${p.id}: CREDITS.md lists ${p.license.submitted}`);
        }
    });

    test('an unregistered pack id falls back to the default model without throwing', () => {
        const c = cast.presetCast();
        c.roles.w.q = { model: 'pack:no-such-pack/Ghost' };
        let roles;
        assert.doesNotThrow(() => { roles = cast.resolveRoles(manifest, c); });
        assert.equal(roles.w.q.modelId, cast.resolveRoles(manifest, cast.presetCast()).w.q.modelId);
    });

    describe('importCustomModel validation', () => {
        const imp = (buf, name, opts = {}) => cast.importCustomModel(fileOf(buf, name), THREE, GLTFLoader, { persist: false, ...opts });

        test('FBX is refused with Blender conversion advice; unknown extensions refused', async () => {
            let r = await imp(Buffer.from('fbx'), 'hero.fbx');
            assert.equal(r.ok, false);
            assert.match(r.problems.join(' '), /Blender/);
            r = await imp(buildGlb(), 'hero.obj');
            assert.equal(r.ok, false);
        });

        test('triangle budget: over the warn level imports with a warning; over the max is refused', async () => {
            const B = cast.IMPORT_BUDGET;
            let r = await imp(buildGlb({ skinned: false, triangles: B.trisWarn + 10 }), 'Busy.glb');
            assert.equal(r.ok, true);
            assert.ok(r.warnings.some((w) => /triangles/.test(w)), r.warnings.join(' | '));
            r = await imp(buildGlb({ skinned: false, triangles: B.trisMax + 10 }), 'Huge.glb');
            assert.equal(r.ok, false);
            assert.match(r.problems.join(' '), /Too detailed/);
        });

        test('rigs: KayKit animated; Mixamo retargeted (retarget injected); no skin -> static', async () => {
            let r = await imp(buildGlb(), 'Kay.glb');
            assert.equal(r.rig, 'kaykit');
            assert.equal(r.animated, true);
            const rt = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'retarget.js')).href);
            const maps = Object.fromEntries(['kaykit', 'mixamo', 'quaternius', 'vrm'].map((n) => [n, JSON.parse(fs.readFileSync(path.join(ASSETS, 'rigs', `${n}.json`), 'utf8'))]));
            rt.setRigMaps(maps);
            r = await imp(buildHumanoid('mixamo'), 'Mixy.glb', { retarget: rt });
            assert.equal(r.ok, true);
            assert.equal(r.rig, 'mixamo');
            assert.equal(r.retarget, true);
            const role = cast.resolveRole(manifest, 'w', 'n', { model: r.id });
            assert.ok(role && role.model === r.url, 'castable');
            r = await imp(buildGlb({ skinned: false }), 'Statue.glb');
            assert.equal(r.ok, true);
            assert.equal(r.animated, false);
            assert.equal(r.retarget, false);
        });

        // Real vrm.js over a stub three-vrm library: the plugin attaches { meta } like VRMLoaderPlugin does.
        const stubVrmLib = (meta) => ({
            VRMLoaderPlugin: class { constructor(parser) { this.parser = parser; this.name = 'STUB_VRM'; } async afterRoot(gltf) { gltf.userData.vrm = { meta, humanoid: null }; } },
            VRMUtils: { removeUnnecessaryVertices() {}, rotateVRM0() {} },
        });
        test('VRM licence gate: violent-use Disallow (0.x) or onlyAuthor needs consent; roles fall back until setCustomConsent', async () => {
            const V = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'vrm.js')).href);
            const fallbackModel = cast.resolveRole(manifest, 'w', 'q', {}).model;
            const cases = [
                ['Strict0.vrm', { metaVersion: '0', title: 'Strict', author: 'Ann', licenseName: 'Redistribution_Prohibited', violentUssageName: 'Disallow', allowedUserName: 'Everyone' }, true, /violent/],
                ['Mine1.vrm', { metaVersion: '1', name: 'Mine', authors: ['Bo'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor' }, true, /only its author/],
                ['Open1.vrm', { metaVersion: '1', name: 'Open', authors: ['Cy'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone' }, false, null],
            ];
            try {
                for (const [file, meta, gated, warn] of cases) {
                    V.setVrmLibrary(stubVrmLib(meta));
                    const r = await imp(buildHumanoid('mixamo', { height: 1.85 }), file, { vrm: V });
                    assert.equal(r.ok, true, `${file}: ${r.problems.join(' | ')}`);
                    assert.equal(r.vrm, true);
                    assert.equal(r.needsConsent, gated, file);
                    assert.ok(r.license && r.license.title === (meta.title || meta.name) && r.license.authors.length === 1 && typeof r.license.url === 'string', `${file} license ${JSON.stringify(r.license)}`);
                    if (warn) assert.ok(r.warnings.some((w) => warn.test(w)), `${file}: ${r.warnings.join(' | ')}`);
                    assert.equal(cast.isCustomUsable(r.id), !gated);
                    const role = () => cast.resolveRole(manifest, 'w', 'q', { model: r.id });
                    assert.equal(role().model, gated ? fallbackModel : r.url, `${file}: ${gated ? 'falls back' : 'plays'} before consent`);
                    if (gated) {
                        assert.equal(await cast.setCustomConsent(r.id, true), true);
                        assert.equal(cast.isCustomUsable(r.id), true);
                        assert.equal(role().model, r.url, `${file}: plays after consent`);
                        await cast.setCustomConsent(r.id, false);
                        assert.equal(role().model, fallbackModel, `${file}: consent withdrawn`);
                    }
                }
            } finally { V.setVrmLibrary(null); }
        });

        test('VRM path goes through the injected vrm module', async () => {
            let called = 0;
            const vrm = { loadVRM: async (file, o) => { called++; const g = await new o.GLTFLoader().parseAsync(await file.arrayBuffer(), ''); return g; } };
            const r = await imp(buildHumanoid('mixamo'), 'Avatar.vrm', { vrm });
            assert.equal(called, 1);
            assert.equal(r.ok, true);
            assert.equal(r.vrm, true);
            const none = await imp(buildHumanoid('mixamo'), 'Avatar2.vrm', { vrm: {} });
            assert.equal(none.ok, false, 'no loader -> clear failure');
        });
    });
});
