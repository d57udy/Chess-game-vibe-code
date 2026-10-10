'use strict';
// v6 pack presets end to end with the real three.js: every preset that uses packs resolves (packs
// registered from the repo), units.setCast builds the board in sync, native pack models only ever play
// their own clips, mounted knights get a horse that jumps / dies with them, and captures in Fast and
// Full end in sync with no NaN positions.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('../helpers/battle3dUnitsHarness');
const { findThree, ROOT } = require('../helpers/loadBattle3dThree');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const skip = !findThree() ? 'three.js not installed' : !fs.existsSync(path.join(ASSETS, 'library.json')) ? 'no library' : false;
let M, cast, manifest;

const fileFetch = async (url) => {
    const p = decodeURIComponent(new URL(url).pathname);
    const file = url.startsWith('file:') ? p : path.join(ROOT, p);
    return fs.existsSync(file) ? { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) } : { ok: false, status: 404, json: async () => null };
};
async function rolesFor(id) {
    const c = cast.presetCast(id);
    const r = await cast.prepareCast(c, { assetBase: pathToFileURL(ASSETS + '/').href, fetch: fileFetch });
    assert.deepEqual(r.failed, [], `${id}: packs failed to load`);
    return cast.resolveRoles(manifest, c);
}
async function rig(roles) {
    const S = H.makeScene(M.THREE);
    const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
    const E = H.rulesAt();
    units.syncBoard(E.get('board'));
    if (roles) await units.setCast(roles);
    return { S, units, E };
}
// Records every clip name a unit's mixer is asked to play
function spyClips(units) {
    const seen = new Map();
    for (const u of units._units) {
        if (!u.mixer || seen.has(u)) continue;
        const orig = u.mixer.clipAction.bind(u.mixer);
        const set = new Set();
        seen.set(u, set);
        u.mixer.clipAction = (clip, ...a) => { set.add(typeof clip === 'string' ? clip : clip.name); return orig(clip, ...a); };
    }
    return seen;
}

describe('battle3d pack casts (v6)', { skip }, () => {
    before(async () => {
        M = await H.loadUnitsModule();
        cast = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'cast.js')).href);
        manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
    });

    test('every preset resolves; pack presets reference loaded packs; legends name every role', async () => {
        for (const id of Object.keys(cast.PRESETS)) {
            const roles = await rolesFor(id);
            for (const c of ['w', 'b']) for (const t of 'pnbrqk') {
                const r = roles[c][t];
                assert.ok(r && r.model, `${id} ${c}${t} model`);
                const file = path.join(ASSETS, r.model);
                assert.ok(fs.existsSync(file), `${id} ${c}${t}: ${r.model} exists`);
                if (r.mount) assert.ok(fs.existsSync(path.join(ASSETS, r.mount.model || r.mount.file || '')), `${id} ${c}${t}: mount model exists`);
            }
            const legend = cast.legendFor(roles);
            assert.equal(legend.length, 12);
        }
    });

    for (const id of ['monsters', 'adventurers', 'barnyard', 'mounted']) {
        test(`${id}: setCast builds the board in sync; Fast and Full captures stay in sync, no NaN`, async (t) => {
            if (!cast.PRESETS[id]) return t.skip(`no ${id} preset`);
            const roles = await rolesFor(id);
            const R = await rig(roles);
            H.assertSynced(R.S, R.units, R.E, `${id} after setCast`);
            const spies = spyClips(R.units);
            for (const mode of ['fast', 'full']) {
                for (const [color, a, v] of [['w', 'n', 'p'], ['b', 'q', 'r'], ['w', 'b', 'n'], ['b', 'p', 'q'], ['w', 'k', 'b']]) {
                    const { fen, move } = H.captureSetup(color, a, v);
                    const E = H.rulesAt(fen);
                    R.units.syncBoard(E.get('board'));
                    for (const [u, set] of spyClips(R.units)) spies.set(u, set);
                    R.units.setMode(mode);
                    await H.runUntil(R.S, R.units.playMove(E.apply(move)), { dt: 1 / 30, label: `${id} ${mode} ${color}${a}x${v}` });
                    H.assertSynced(R.S, R.units, E, `${id} ${mode} ${color}${a}x${v}`);
                    for (const u of R.units._units) assert.ok(u.root.position.toArray().every(Number.isFinite), 'finite positions');
                }
            }
            // native pack models only ever play clips they own
            if (id !== 'mounted') assert.ok([...spies.keys()].some((u) => u.proto?.native && spies.get(u).size > 0), `${id}: native pack units actually played clips`);
            const bad = [];
            for (const [u, set] of spies) {
                if (!u.proto?.native || !u.proto.clipNames) continue;
                for (const name of set) if (!u.proto.clipNames.has(name)) bad.push(`${u.color}${u.type} played foreign clip ${name}`);
            }
            assert.deepEqual(bad, []);
        });
    }

    test('mounted knights: a horse is attached, jumps while airborne, idles on the square after', async (t) => {
        if (!cast.PRESETS.mounted) return t.skip('no mounted preset');
        const R = await rig(await rolesFor('mounted'));
        const knight = R.units.unitAt(7, 6); // g1
        assert.ok(knight.horse, 'white knight has a horse');
        assert.ok(knight.horse.model.parent, 'horse model in the scene graph');
        const baseScale = (u) => [...new Set(u.base.filter((o) => o.isMesh && o.parent === u.root).map((o) => o.scale.x))];
        assert.deepEqual(baseScale(knight), [1.25], 'mounted base is 1.25 wide');
        assert.deepEqual(baseScale(R.units.unitAt(6, 4)), [1], 'unmounted pawn base unchanged');
        const ev = R.E.apply('g1f3');
        const p = R.units.playMove(ev);
        const keys = new Set();
        let done = false;
        p.then(() => { done = true; });
        for (let i = 0; i < 400 && !done; i++) { R.S.stepFrames(1, 1 / 60); keys.add(knight.horse.key); await null; }
        assert.ok(done);
        assert.ok(keys.has('jump') || keys.has('run') || keys.has('walk'), `horse moved: ${[...keys]}`);
        R.S.stepFrames(30);
        assert.equal(knight.horse.key, 'idle');
        H.assertSynced(R.S, R.units, R.E, 'after a mounted move');
    });

    test('mounted knight captured: its horse dies with it and is removed', async (t) => {
        if (!cast.PRESETS.mounted) return t.skip('no mounted preset');
        const R = await rig(await rolesFor('mounted'));
        const { fen, move } = H.captureSetup('w', 'q', 'n');
        const E = H.rulesAt(fen);
        R.units.syncBoard(E.get('board'));
        const victim = R.units.unitAt(3, 3);
        assert.ok(victim.horse, 'black knight rides');
        const horseModel = victim.horse.model;
        const keys = new Set();
        const p = R.units.playMove(E.apply(move));
        let done = false;
        p.then(() => { done = true; });
        for (let i = 0; i < 600 && !done; i++) { R.S.stepFrames(1, 1 / 60); if (victim.horse) keys.add(victim.horse.key); await null; }
        assert.ok(done);
        assert.ok(keys.has('death'), `victim horse died: ${[...keys]}`);
        assert.ok(!horseModel.parent || !R.S.scene.getObjectById(horseModel.id), 'horse removed with its rider');
        H.assertSynced(R.S, R.units, E, 'after capturing a mounted knight');
    });

    // b3d-units v6: a pack model used as a plain (non-native) role is retargeted onto the KayKit clips; while it
    // dies the body is lowered until its lowest torso bone rests about 0.1 above the board (no floating corpse).
    test('plain-role Quaternius Warrior: retargeted (forward ignored), in sync both ways, corpse hips on the board before fading', async (t) => {
        const file = 'packs/quaternius-rpg/Warrior.glb';
        if (!fs.existsSync(path.join(ASSETS, file))) return t.skip('no quaternius-rpg pack');
        const roles = cast.resolveRoles(manifest, cast.presetCast());
        for (const c of ['w', 'b']) for (const ty of ['r', 'q']) roles[c][ty] = { ...roles[c][ty], model: file, modelId: 'plain-warrior', props: [], gear: [], recolor: null, native: false, source: 'custom', forward: '-z' };
        const R = await rig(roles);
        const warriors = [...R.units._units].filter((u) => u.proto?.retarget && u.type === 'r');
        assert.ok(warriors.length >= 2, 'rooks are retargeted Warriors');
        for (const u of warriors) {
            assert.equal(u.proto.retarget.rigType, 'quaternius');
            assert.ok(u.mixer, 'animated (has a mixer)');
            assert.equal(u.model.rotation.y, 0, 'retargeted roots already face +z: role.forward is ignored');
        }
        for (const mode of ['fast', 'full']) {
            R.units.setMode(mode);
            for (const [color, a, v] of [['w', 'r', 'q'], ['b', 'q', 'r'], ['w', 'q', 'r']]) {
                const label = `${mode} ${color}${a}x${v}`;
                const { fen, move } = H.captureSetup(color, a, v);
                const E = H.rulesAt(fen);
                R.units.syncBoard(E.get('board'));
                const to = move.slice(2);
                const victim = R.units.unitAt(8 - Number(to[1]), to.charCodeAt(0) - 97);
                assert.ok(victim?.proto?.retarget, `${label}: victim is a Warrior`);
                let lastHips = null, done = false;
                R.units.playMove(E.apply(move)).then(() => { done = true; });
                await null;
                for (let k = 0; k < 1200 && !done; k++) {
                    R.S.stepFrames(1, 1 / 60);
                    if (victim.dying && !victim.fading) lastHips = victim.bones.hips.getWorldPosition(new M.THREE.Vector3()).y;
                    await null;
                }
                assert.ok(done, `${label} finished`);
                assert.ok(lastHips !== null, `${label}: the victim died`);
                assert.ok(lastHips < 0.25, `${label}: corpse hips ${lastHips.toFixed(3)} above the board before fading`);
                H.assertSynced(R.S, R.units, E, label);
            }
        }
    });

    // b3d-units: VRM is chosen by .vrm, role.vrm or role.rig === 'vrm'. A CC0 pack .glb with vrm: true goes
    // through vrm.js (stub three-vrm library records the load) and still animates in sync.
    test('role.vrm on a .glb loads through vrm.js; the unit animates and stays in sync', async (t) => {
        const file = 'packs/quaternius-rpg/Warrior.glb';
        if (!fs.existsSync(path.join(ASSETS, file))) return t.skip('no quaternius-rpg pack');
        const V = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'vrm.js')).href);
        const loaded = [];
        V.setVrmLibrary({
            VRMLoaderPlugin: class { constructor(parser) { this.name = 'STUB_VRM'; } async afterRoot(g) { loaded.push(g); g.userData.vrm = { meta: { metaVersion: '1', name: 'Warrior', authors: ['Quaternius'], avatarPermission: 'everyone' }, humanoid: null }; } },
            VRMUtils: { removeUnnecessaryVertices() {}, rotateVRM0() {} },
        });
        try {
            const roles = cast.resolveRoles(manifest, cast.presetCast());
            for (const c of ['w', 'b']) roles[c].b = { ...roles[c].b, model: file, modelId: 'vrm-warrior', props: [], gear: [], recolor: null, native: false, source: 'custom', vrm: true };
            const R = await rig(roles);
            assert.equal(loaded.length, 1, 'vrm.js loaded the model once (shared proto)');
            const bishops = [...R.units._units].filter((u) => u.type === 'b');
            assert.equal(bishops.length, 4);
            for (const u of bishops) assert.ok(u.mixer && u.proto?.retarget, `${u.color}b animated through retarget`);
            const { fen, move } = H.captureSetup('w', 'b', 'n');
            const E = H.rulesAt(fen);
            R.units.syncBoard(E.get('board'));
            await H.runUntil(R.S, R.units.playMove(E.apply(move)), { dt: 1 / 30, label: 'vrm bishop capture' });
            H.assertSynced(R.S, R.units, E, 'after a vrm bishop capture');
        } finally { V.setVrmLibrary(null); }
    });
});
