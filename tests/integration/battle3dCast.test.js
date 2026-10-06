'use strict';
// battle3d/cast.js: presets resolve to valid roles (files, nodes, bones, clips all exist), user
// overrides merge, invalid configs fall back, localStorage failures are safe, importCustomModel
// flags rigs with missing bones (tiny GLB fixtures), and units.setCast rebuilds in sync.
const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');
const { findThree } = require('../helpers/loadBattle3dThree');
const { buildGlb, KAYKIT_JOINTS } = require('../helpers/glbFixture');
const H = require('../helpers/battle3dUnitsHarness');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
const three = findThree();
let cast;

// Node names and clip names straight from the GLB JSON chunks.
const glbCache = new Map();
function glbJson(rel) {
    if (!glbCache.has(rel)) {
        const file = path.join(ASSETS, rel);
        const d = fs.readFileSync(file);
        let json;
        if (rel.endsWith('.gltf')) json = JSON.parse(d.toString('utf8'));
        else json = JSON.parse(d.subarray(20, 20 + d.readUInt32LE(12)).toString('utf8'));
        glbCache.set(rel, json);
    }
    return glbCache.get(rel);
}
const nodeNames = (rel) => new Set((glbJson(rel).nodes || []).map((n) => n.name));
const clipNames = () => new Set([manifest.clips.file, manifest.clips.skeletonFile].filter(Boolean).flatMap((f) => (glbJson(f).animations || []).map((a) => a.name)));

// Every file, node, bone and clip a resolved role refers to must exist.
function validateRole(role, label) {
    const problems = [];
    if (!fs.existsSync(path.join(ASSETS, role.model))) { problems.push(`${label}: model ${role.model} missing`); return problems; }
    const names = nodeNames(role.model);
    for (const n of [...role.show, ...role.hide]) if (!names.has(n)) problems.push(`${label}: node ${n} not in ${role.model}`);
    for (const p of role.props) {
        if (!fs.existsSync(path.join(ASSETS, p.file))) problems.push(`${label}: prop ${p.file} missing`);
        if (!names.has(p.bone)) problems.push(`${label}: bone ${p.bone} not in ${role.model}`);
    }
    const clips = clipNames();
    for (const [k, v] of Object.entries(role.anims || {})) for (const n of [].concat(v)) if (n && !clips.has(n)) problems.push(`${label}: anims.${k} clip ${n} missing`);
    if (!(role.scale > 0.1 && role.scale < 1)) problems.push(`${label}: scale ${role.scale}`);
    return problems;
}

function fakeStorage({ throwOn = [] } = {}) {
    const data = new Map();
    const guard = (op) => { if (throwOn.includes(op)) throw new Error(`${op} blocked`); };
    return {
        data,
        getItem(k) { guard('get'); return data.has(k) ? data.get(k) : null; },
        setItem(k, v) { guard('set'); data.set(k, String(v)); },
        removeItem(k) { guard('remove'); data.delete(k); },
    };
}

describe('battle3d cast.js', () => {
    before(async () => {
        cast = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'cast.js')).href);
    });
    let savedLS;
    beforeEach(() => { savedLS = Object.getOwnPropertyDescriptor(globalThis, 'localStorage'); });
    afterEach(() => {
        if (savedLS) Object.defineProperty(globalThis, 'localStorage', savedLS); else delete globalThis.localStorage;
    });
    const setLS = (v) => Object.defineProperty(globalThis, 'localStorage', { value: v, configurable: true, writable: true });

    test('every preset resolves all 12 roles to existing files, nodes, bones and clips', () => {
        const problems = [];
        for (const id of Object.keys(cast.PRESETS)) {
            const roles = cast.resolveRoles(manifest, cast.presetCast(id));
            for (const c of cast.COLORS) for (const t of cast.TYPES) problems.push(...validateRole(roles[c][t], `${id} ${c}${t}`));
        }
        assert.deepEqual(problems, []);
    });

    test('every model with every loadout of its army resolves to valid assets', () => {
        const problems = [];
        for (const [modelId, info] of Object.entries(manifest.models)) {
            for (const [loadoutId, l] of Object.entries(manifest.loadouts)) {
                if (l.army && l.army !== info.army && loadoutId !== 'none') continue;
                const r = cast.resolveRole(manifest, 'w', 'n', { model: modelId, loadout: loadoutId });
                assert.equal(r.modelId, modelId);
                assert.equal(r.loadout, loadoutId);
                problems.push(...validateRole(r, `${modelId}+${loadoutId}`));
            }
        }
        assert.deepEqual(problems, []);
    });

    test('the default preset reproduces manifest.roles (the build resolves it)', () => {
        const roles = cast.resolveRoles(manifest, cast.presetCast());
        for (const c of cast.COLORS) {
            for (const t of cast.TYPES) {
                const a = roles[c][t], b = manifest.roles[c][t];
                assert.equal(a.model, b.model, `${c}${t} model`);
                assert.equal(a.scale, b.scale, `${c}${t} scale`);
                assert.deepEqual([...a.show].sort(), [...b.show].sort(), `${c}${t} show`);
            }
        }
    });

    test('resolveRoles(manifest) with no cast equals the classic preset', () => {
        assert.deepEqual(cast.resolveRoles(manifest), cast.resolveRoles(manifest, cast.presetCast('classic')));
        assert.deepEqual(cast.resolveRoles(manifest, null), cast.resolveRoles(manifest, cast.presetCast('classic')));
    });

    test('user overrides merge over the preset; untouched roles keep preset values', () => {
        const base = cast.resolveRoles(manifest, cast.presetCast('classic'));
        const user = cast.presetCast('classic');
        user.preset = 'custom';
        user.roles.w.q = { model: 'Mage', loadout: 'staff', gear: ['Mage_Hat', 'Knight_Helmet'], scale: 1.2, tint: '#ff0000', accessories: ['crown', 'bogus'], recolor: { to: 120 } };
        const roles = cast.resolveRoles(manifest, user);
        const q = roles.w.q;
        assert.equal(q.model, manifest.models.Mage.file);
        assert.equal(q.loadout, 'staff');
        assert.ok(q.show.includes('Mage_Hat') && !q.show.includes('Knight_Helmet'), 'gear filtered to the model');
        assert.equal(q.scale, Math.round((manifest.baseScale || 0.38) * cast.TYPE_SIZE.q * 1.2 * 1000) / 1000);
        assert.equal(q.tint, '#ff0000');
        assert.deepEqual(q.accessories, ['crown']);
        assert.equal(q.crown, true);
        assert.equal(q.recolor.to, 120);
        assert.equal(q.ranged, !!manifest.loadouts.staff.ranged);
        for (const c of cast.COLORS) for (const t of cast.TYPES) if (!(c === 'w' && t === 'q')) assert.deepEqual(roles[c][t], base[c][t], `${c}${t} unchanged`);
    });

    test('a partial cast is filled from its preset', () => {
        const roles = cast.resolveRoles(manifest, { preset: 'swapped', roles: { w: { p: { model: 'Knight' } } } });
        const swapped = cast.resolveRoles(manifest, cast.presetCast('swapped'));
        assert.equal(roles.w.p.modelId, 'Knight');
        assert.deepEqual(roles.b.k, swapped.b.k);
        assert.deepEqual(roles.w.n, swapped.w.n);
    });

    test('invalid configs never throw and fall back to defaults', () => {
        const classic = cast.resolveRoles(manifest, cast.presetCast('classic'));
        const bad = [
            undefined, null, {}, 42, 'x', { roles: 'x' }, { roles: { w: null } }, { preset: 'nonsense' },
            { roles: { w: { p: { model: 'Nope', loadout: 'nope', gear: 'x', scale: -1, recolor: { to: 'abc' }, tint: 5, accessories: 'crown' } } } },
            { roles: { w: { p: { model: 'Knight', scale: NaN } } } },
            { roles: { w: { p: { model: 'Knight', scale: '2' } } } },
            { roles: { w: { p: { model: 'custom:missing_1' } } } },
        ];
        for (const c of bad) {
            let roles;
            assert.doesNotThrow(() => { roles = cast.resolveRoles(manifest, c); }, JSON.stringify(c));
            for (const col of cast.COLORS) for (const t of cast.TYPES) assert.deepEqual(validateRole(roles[col][t], `${JSON.stringify(c)} ${col}${t}`), []);
        }
        const r = cast.resolveRoles(manifest, bad[8]).w.p;
        assert.equal(r.modelId, classic.w.p.modelId, 'unknown model -> preset model');
        assert.equal(r.loadout, classic.w.p.loadout, 'unknown loadout -> model default');
        assert.equal(r.scale, classic.w.p.scale, 'bad scale -> 1x');
        assert.equal(r.recolor, null);
        assert.equal(r.tint, null);
        assert.equal(cast.resolveRoles(manifest, bad[12]).w.p.modelId, classic.w.p.modelId, 'stale custom id -> preset model');
    });

    test('normalizeCast keeps a usable preset id', () => {
        for (const c of [{ preset: 'nonsense' }, {}, null]) {
            const n = cast.normalizeCast(c);
            assert.ok(n.preset === 'custom' || cast.PRESETS[n.preset], `preset ${n.preset} from ${JSON.stringify(c)}`);
        }
        assert.deepEqual([cast.normalizeCast({ preset: 'nonsense', name: 'x' }).preset, cast.normalizeCast({ preset: 'nonsense', name: 'x' }).name], ['classic', cast.PRESETS.classic.name]);
        const mine = cast.normalizeCast({ preset: 'custom', name: 'Mine' });
        assert.deepEqual([mine.preset, mine.name], ['custom', 'Mine']);
    });

    test('loadUserCast/saveUserCast round trip', () => {
        setLS(fakeStorage());
        assert.equal(cast.loadUserCast(), null);
        const c = cast.presetCast('mixed');
        c.roles.b.k.scale = 1.3;
        assert.equal(cast.saveUserCast(c), true);
        const back = cast.loadUserCast();
        assert.equal(back.preset, 'mixed');
        assert.equal(back.roles.b.k.scale, 1.3);
        assert.equal(cast.clearUserCast(), true);
        assert.equal(cast.loadUserCast(), null);
    });

    test('localStorage missing, throwing, full or corrupt: safe', () => {
        delete globalThis.localStorage;
        assert.equal(cast.loadUserCast(), null);
        assert.doesNotThrow(() => cast.saveUserCast(cast.presetCast()));
        Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
        assert.equal(cast.loadUserCast(), null);
        assert.doesNotThrow(() => cast.saveUserCast(cast.presetCast()));
        setLS(fakeStorage({ throwOn: ['get', 'set', 'remove'] }));
        assert.equal(cast.loadUserCast(), null);
        assert.equal(cast.saveUserCast(cast.presetCast()), false, 'quota error reported');
        const s = fakeStorage();
        setLS(s);
        for (const raw of ['{', 'null', '"str"', '{"roles":5}', '[]']) {
            s.data.set('battle3d.cast.v1', raw);
            let r;
            assert.doesNotThrow(() => { r = cast.loadUserCast(); }, raw);
            if (r) assert.doesNotThrow(() => cast.resolveRoles(manifest, r), raw);
        }
    });

    test('saveUserCast reports false when storage is unavailable', () => {
        delete globalThis.localStorage;
        assert.equal(cast.saveUserCast(cast.presetCast()), false, 'no storage');
        Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
        assert.equal(cast.saveUserCast(cast.presetCast()), false, 'blocked storage');
    });

    test('legendFor lists 12 roles with glyphs', () => {
        const legend = cast.legendFor(cast.resolveRoles(manifest, cast.presetCast()));
        assert.equal(legend.length, 12);
        assert.ok(legend.every((e) => e.glyph && e.name && e.model));
    });

    describe('importCustomModel (GLB fixtures)', { skip: !three && 'three.js not installed' }, () => {
        let THREE, GLTFLoader;
        before(async () => {
            THREE = await import(pathToFileURL(path.join(three.dir, 'build', 'three.module.js')).href);
            ({ GLTFLoader } = await import(pathToFileURL(path.join(three.dir, 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href));
        });
        const fileOf = (buf, name) => new File([buf], name, { type: 'model/gltf-binary' });

        test('a KayKit-compatible rig is accepted as animated, no problems', async () => {
            const r = await cast.importCustomModel(fileOf(buildGlb(), 'Hero.glb'), THREE, GLTFLoader, { persist: false });
            assert.equal(r.ok, true);
            assert.equal(r.animated, true);
            assert.deepEqual(r.problems, []);
            assert.match(r.id, /^custom:/);
            assert.ok(cast.getCustomModel(r.id));
            const role = cast.resolveRole(manifest, 'w', 'k', { model: r.id });
            assert.equal(role.army, 'custom');
            assert.equal(role.static, false);
            assert.equal(role.model, r.url);
            assert.ok(cast.listModels(manifest).some((m) => m.id === r.id && m.custom));
            await cast.removeCustomModel(r.id);
            assert.equal(cast.getCustomModel(r.id), null);
        });

        test('bone names without dots are accepted (dots optional)', async () => {
            const joints = KAYKIT_JOINTS.map((n) => n.replace(/\./g, ''));
            const r = await cast.importCustomModel(fileOf(buildGlb({ joints, parents: undefined }), 'Nodots.glb'), THREE, GLTFLoader, { persist: false });
            assert.equal(r.animated, true, r.problems.join(' | '));
        });

        test('missing bones are flagged and the model is static', async () => {
            const joints = KAYKIT_JOINTS.filter((n) => n !== 'head' && n !== 'hand.r' && n !== 'handslot.r');
            const parents = joints.map((_, i) => (i === 0 ? -1 : 0));
            const r = await cast.importCustomModel(fileOf(buildGlb({ joints, parents }), 'Broken.glb'), THREE, GLTFLoader, { persist: false });
            assert.equal(r.ok, true, 'still showable');
            assert.equal(r.animated, false);
            const msg = r.problems.join(' | ');
            assert.match(msg, /missing bones/i);
            for (const b of ['head', 'hand.r', 'handslot.r']) assert.ok(msg.includes(b), `${b} named in: ${msg}`);
            assert.equal(cast.resolveRole(manifest, 'b', 'q', { model: r.id }).static, true);
        });

        test('a static (unskinned) mesh is flagged', async () => {
            const r = await cast.importCustomModel(fileOf(buildGlb({ skinned: false }), 'Statue.glb'), THREE, GLTFLoader, { persist: false });
            assert.equal(r.ok, true);
            assert.equal(r.animated, false);
            assert.match(r.problems.join(' '), /skinned/i);
        });

        test('garbage bytes, wrong extension and no file are rejected without throwing', async () => {
            let r = await cast.importCustomModel(fileOf(Buffer.from('not a glb at all'), 'junk.glb'), THREE, GLTFLoader, { persist: false });
            assert.equal(r.ok, false);
            assert.ok(r.problems.length > 0);
            r = await cast.importCustomModel(fileOf(buildGlb(), 'model.obj'), THREE, GLTFLoader, { persist: false });
            assert.match(r.problems.join(' '), /\.glb/);
            r = await cast.importCustomModel(null, THREE, GLTFLoader);
            assert.equal(r.ok, false);
        });

        test('persist=true without IndexedDB still resolves', async () => {
            const r = await cast.importCustomModel(fileOf(buildGlb(), 'Persist.glb'), THREE, GLTFLoader);
            assert.equal(r.ok, true);
            await cast.removeCustomModel(r.id);
            assert.ok(Array.isArray(await cast.restoreCustomModels()));
        });
    });

    describe('units.setCast', { skip: !three && 'three.js not installed' }, () => {
        let M;
        before(async () => { M = await H.loadUnitsModule(); });

        test('every preset rebuilds all units in sync, keeping positions mid-game', async () => {
            const S = H.makeScene(M.THREE);
            const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
            const E = H.rulesAt();
            units.syncBoard(E.get('board'));
            units.setMode('fast');
            for (const mv of ['e2e4', 'd7d5', 'e4d5', 'g8f6']) await H.runUntil(S, units.playMove(E.apply(mv)));
            for (const id of Object.keys(cast.PRESETS)) {
                const roles = cast.resolveRoles(manifest, cast.presetCast(id));
                await units.setCast(roles);
                H.assertSynced(S, units, E, `preset ${id}`);
                const legend = units.getLegend();
                const wq = legend.find((e) => e.color === 'w' && e.type === 'q');
                assert.ok(wq.model && roles.w.q.model.includes(wq.model.replace(/ /g, '_')), `${id}: legend shows ${wq.model} for ${roles.w.q.model}`);
                for (const u of units._units) assert.ok(u.mixer, `${id} ${u.color}${u.type} is a real character`);
                // A capture still plays after a cast change
            }
            await H.runUntil(S, units.playMove(E.apply('d1f3')));
            H.assertSynced(S, units, E, 'move after setCast');
        });

        test('setCast during a fight skips it and stays in sync', async () => {
            const S = H.makeScene(M.THREE);
            const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
            const { fen, move } = H.captureSetup('w', 'q', 'r');
            const E = H.rulesAt(fen);
            units.syncBoard(E.get('board'));
            const p = units.playMove(E.apply(move));
            S.stepFrames(40);
            await units.setCast(cast.resolveRoles(manifest, cast.presetCast('heroes')));
            await H.runUntil(S, p, { max: 1 });
            H.assertSynced(S, units, E, 'setCast mid-fight');
            assert.equal(S.rec.trailsOpen, 0);
        });

        test('a custom imported model (static) can be cast and rendered', async () => {
            const THREE = M.THREE;
            const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
            const r = await cast.importCustomModel(new File([buildGlb({ skinned: false })], 'Statue.glb'), THREE, GLTFLoader, { persist: false });
            const c = cast.presetCast();
            c.roles.w.r = { model: r.id };
            const roles = cast.resolveRoles(manifest, c);
            const S = H.makeScene(THREE);
            const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
            const E = H.rulesAt();
            units.syncBoard(E.get('board'));
            await units.setCast(roles);
            H.assertSynced(S, units, E, 'custom rook');
            units.setMode('fast');
            for (const mv of ['a2a4', 'a7a6', 'a1a3']) await H.runUntil(S, units.playMove(E.apply(mv)));
            H.assertSynced(S, units, E, 'custom rook moved');
        });
    });
});
