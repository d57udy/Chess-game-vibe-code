'use strict';
// v6 retarget.js deeper checks (suggested by b3d-retarget): tight pose accuracy (5 deg; A-pose 1 deg),
// rest preservation of bones, skinned vertices and matrixAutoUpdate=false children, facing detection
// and correction, posed-save bind restore, floor contact at the end of a death, IK-style feet on the
// real Quaternius RPG models, expected-static non-humanoids (real pack animals, armless and
// one-legged rigs), kaykit.json rest pose vs clips.glb, and vrm.convertMaterials.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findThree, registerThree, installBrowserGlobals, ROOT } = require('../helpers/loadBattle3dThree');
const { buildGlb, buildHumanoid } = require('../helpers/glbFixture');

const skip = !fs.existsSync(path.join(ROOT, 'battle3d', 'retarget.js')) ? 'retarget.js not present' : !findThree() ? 'three.js not installed' : false;
const ASSETS = path.join(ROOT, 'battle3d', 'assets');
let R, V, THREE, GLTFLoader, MeshoptDecoder, maps, clips, knight;

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
async function parse(buf) {
    const l = new GLTFLoader();
    l.setMeshoptDecoder(MeshoptDecoder);
    return l.parseAsync(ab(buf), '');
}
const loadFile = (rel) => parse(fs.readFileSync(path.join(ASSETS, rel)));
const TORSO = [['hips', 'chest'], ['chest', 'head']];
const LIMBS = [...TORSO, ['upperarml', 'lowerarml'], ['lowerarml', 'handl'], ['upperarmr', 'lowerarmr'], ['lowerarmr', 'handr'], ['upperlegl', 'lowerlegl'], ['lowerlegl', 'footl'], ['upperlegr', 'lowerlegr'], ['lowerlegr', 'footr']];
const isLeg = (i) => /leg/.test(LIMBS[i][0]);
const wpos = (root, n) => root.getObjectByName(n).getWorldPosition(new THREE.Vector3());
// Pose root at clip time t (null clip: rest) and return f(root); the mixer is stopped afterwards.
function posed(root, clip, t, f) {
    const mixer = new THREE.AnimationMixer(root);
    if (clip) { mixer.clipAction(clip).play(); mixer.setTime(t); }
    root.updateMatrixWorld(true);
    const out = f(root);
    mixer.stopAllAction();
    root.updateMatrixWorld(true);
    return out;
}
const limbDirs = (root, clip, t) => posed(root, clip, t, (r) => LIMBS.map(([a, b]) => wpos(r, b).sub(wpos(r, a)).normalize()));
// KayKit torso uprightness: chest-hips height relative to rest (retarget.js lies the body down below 0.6).
const uprightness = (clip, t) => posed(knight, clip, t, (r) => wpos(r, 'chest').y - wpos(r, 'hips').y) / posed(knight, null, 0, (r) => wpos(r, 'chest').y - wpos(r, 'hips').y);
// Worst limb direction error vs the KayKit knight. Legs are compared only while the KayKit torso is upright:
// lying poses bend the knees by IK on purpose (b3d-retarget, v6). Arms, spine and head: every frame.
function maxLimbError(p, clipNames, times = [0, 0.33, 0.66], { lyingLegs = false, legsOnly = false } = {}) {
    let worst = { deg: 0, at: '', lyingFrames: 0 };
    for (const name of clipNames) {
        const src = clips.get(name);
        for (const f of times) {
            const t = src.duration * f;
            const lying = !lyingLegs && uprightness(src, t) < 0.6;
            if (lying) worst.lyingFrames++;
            const want = limbDirs(knight, src, t), got = limbDirs(p.root, p.clipMap(name), t);
            want.forEach((w, i) => {
                if ((legsOnly && !isLeg(i)) || (lying && isLeg(i))) return;
                const deg = THREE.MathUtils.radToDeg(w.angleTo(got[i]));
                if (deg > worst.deg) worst = { ...worst, deg, at: `${name}@${t.toFixed(2)} ${LIMBS[i].join('-')}` };
            });
        }
    }
    return worst;
}
const prep = async (buf) => R.prepare(await parse(buf), THREE, { sourceClips: clips, maps });

describe('battle3d retarget, deep checks (v6)', { skip }, () => {
    before(async () => {
        registerThree(findThree().dir);
        installBrowserGlobals();
        THREE = await import('three');
        ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
        ({ MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js'));
        R = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'retarget.js')).href);
        V = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'vrm.js')).href);
        maps = Object.fromEntries(['kaykit', 'mixamo', 'quaternius', 'vrm'].map((n) => [n, JSON.parse(fs.readFileSync(path.join(ASSETS, 'rigs', `${n}.json`), 'utf8'))]));
        clips = new Map((await loadFile('anims/clips.glb')).animations.map((a) => [a.name, a]));
        knight = (await loadFile('characters/Knight.glb')).scene;
    });

    for (const naming of ['mixamo', 'quaternius', 'unreal']) {
        test(`pose accuracy (${naming}): limb directions within 5 deg of KayKit over 4 clips (legs only while upright)`, async () => {
            const p = await prep(buildHumanoid(naming));
            const w = maxLimbError(p, ['Idle', 'Walking_A', '1H_Melee_Attack_Chop', 'Death_A'], [0, 0.33, 0.66, 0.999]);
            assert.ok(w.deg <= 5, `worst ${w.deg.toFixed(2)} deg at ${w.at}`);
            assert.ok(w.lyingFrames >= 1, 'Death_A reaches a lying frame (arms, spine and head still checked there)');
        });
    }

    test('A-pose bind (arms 45 deg down): Idle and T-Pose limb directions within 1 deg', async () => {
        const d = 0.28 * Math.SQRT1_2, e = 0.26 * Math.SQRT1_2;
        const positions = {
            lowerarml: [0.2 + d, 1.45 - d, 0], handl: [0.2 + d + e, 1.45 - d - e, 0],
            lowerarmr: [-0.2 - d, 1.45 - d, 0], handr: [-0.2 - d - e, 1.45 - d - e, 0],
        };
        const p = await prep(buildHumanoid('mixamo', { positions }));
        const w = maxLimbError(p, ['Idle', 'T-Pose'].filter((n) => clips.has(n)), [0, 0.5]);
        assert.ok(w.deg <= 1, `worst ${w.deg.toFixed(2)} deg at ${w.at}`);
    });

    test('rest preserved: bones, skinned vertices and matrixAutoUpdate=false children do not move', async () => {
        const g = await parse(buildHumanoid('mixamo'));
        const scene = g.scene;
        scene.updateMatrixWorld(true);
        const head = scene.getObjectByName('mixamorigHead');
        const hair = new THREE.Object3D();
        hair.name = 'spring_hair';
        hair.position.set(0, 0.12, 0.03);
        head.add(hair);
        hair.updateMatrix();
        hair.matrixAutoUpdate = false; // like three-vrm spring joints
        scene.updateMatrixWorld(true);
        const bones = [];
        scene.traverse((o) => { if (o.isBone) bones.push([o, o.getWorldPosition(new THREE.Vector3())]); });
        const hairBefore = hair.getWorldPosition(new THREE.Vector3());
        const mesh = scene.getObjectByProperty('isSkinnedMesh', true);
        const verts = [0, 1, 2].map((i) => mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
        const p = await R.prepare(g, THREE, { sourceClips: clips, maps });
        p.root.updateMatrixWorld(true);
        const tol = 1e-4 * 1.8;
        for (const [b, w] of bones) assert.ok(b.getWorldPosition(new THREE.Vector3()).distanceTo(w) < tol, `bone ${b.name} moved`);
        assert.ok(hair.getWorldPosition(new THREE.Vector3()).distanceTo(hairBefore) < tol, 'matrixAutoUpdate=false child stays on the head');
        verts.forEach((v, i) => assert.ok(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).distanceTo(v) < tol, `vertex ${i} moved`));
    });

    test('facing: a -Z facing rig is detected and turned; an already-turned scene is not turned again', async () => {
        const mirror = (q) => [-q[0], q[1], -q[2]];
        let g = await parse(buildHumanoid('mixamo', { transform: mirror }));
        let r = await R.detectRig(g, { maps });
        assert.equal(r.facing, '-z', JSON.stringify(r));
        const p = await R.prepare(g, THREE, { sourceClips: clips, maps });
        const fix = p.root.children[0];
        assert.ok(Math.abs(Math.abs(fix.quaternion.y) - 1) < 1e-3, 'retarget-facing turned by PI about Y');
        p.root.updateMatrixWorld(true);
        const arm = p.root.getObjectByName('upperarml').getWorldPosition(new THREE.Vector3());
        assert.ok(arm.x > 0.1, `left upper arm at +X after facing fix (${arm.x.toFixed(3)})`);
        g = await parse(buildHumanoid('mixamo', { transform: mirror }));
        g.scene.rotation.y = Math.PI; // like vrm.js does for VRM 0.x
        g.scene.updateMatrixWorld(true);
        r = await R.detectRig(g, { maps });
        assert.equal(r.facing, '+z', 'already facing +Z');
    });

    test('posed save: bind pose restored with a warning', async () => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.6).toArray();
        // the posed bone carries skin weights: restored, with a warning
        let g = await parse(buildHumanoid('mixamo', { rotations: { upperarml: q }, weighted: ['hips', 'upperarml', 'lowerarml'] }));
        let p = await R.prepare(g, THREE, { sourceClips: clips, maps });
        assert.ok(p.warnings.some((w) => /bind pose/i.test(w)), p.warnings.join(' | '));
        p.root.updateMatrixWorld(true);
        const elbow = p.root.getObjectByName('lowerarml').getWorldPosition(new THREE.Vector3());
        assert.ok(Math.abs(elbow.y - 1.45) < 0.01 && elbow.x > 0.4, `elbow back at the bind position ${elbow.toArray().map((v) => v.toFixed(3))}`);
        // an off-bind bone without skin weights is not touched (and gives no warning)
        g = await parse(buildHumanoid('mixamo', { rotations: { upperarml: q }, weighted: ['hips', 'spine', 'chest'] }));
        const arm = g.scene.getObjectByName('mixamorigLeftArm');
        p = await R.prepare(g, THREE, { sourceClips: clips, maps });
        assert.ok(!p.warnings.some((w) => /bind pose/i.test(w)), 'unweighted bone left alone');
    });

    // Long shins, high hips; body height from the skinned mesh (floor 0). retarget.js lies the torso down at
    // KayKit's height scaled by body height (KAYKIT_HEIGHT 2.2) and bends the knees by lifting-only leg IK.
    const LONG = { hips: [0, 1.15, 0], spine: [0, 1.22, 0], upperlegl: [0.11, 1.1, 0], upperlegr: [-0.11, 1.1, 0], lowerlegl: [0.11, 0.6, 0], lowerlegr: [-0.11, 0.6, 0] };
    const H = 1.85, KAYKIT_H = 2.2;
    const lowTorso = (r) => Math.min(...['hips', 'chest', 'head'].map((n) => wpos(r, n).y));

    test('lying (long legs): ankles stay above the floor at the end of Death_A; no leg IK while walking', async () => {
        const p = await prep(buildHumanoid('mixamo', { positions: LONG, height: H }));
        const end = clips.get('Death_A').duration - 1e-3;
        const ankles = posed(p.mixerTarget, p.clipMap('Death_A'), end, (r) => ['footl', 'footr'].map((n) => wpos(r, n).y));
        for (const y of ankles) assert.ok(y >= -0.02 * H, `ankle ${y.toFixed(3)} not below the floor`);
        const w = maxLimbError(p, ['Walking_A'], [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875], { legsOnly: true });
        assert.equal(w.lyingFrames, 0);
        assert.ok(w.deg <= 2, `walking legs: worst ${w.deg.toFixed(2)} deg at ${w.at}`);
    });

    test('lying (long legs): lowest torso joint at KayKit height per body height (within 0.03) at the end of Death_A', async () => {
        const p = await prep(buildHumanoid('mixamo', { positions: LONG, height: H }));
        const death = clips.get('Death_A'), end = death.duration - 1e-3;
        const kLow = posed(knight, death, end, lowTorso) / KAYKIT_H;
        const low = posed(p.mixerTarget, p.clipMap('Death_A'), end, lowTorso) / H;
        assert.ok(Math.abs(low - kLow) <= 0.03, `lowest torso joint ${low.toFixed(3)} body heights vs KayKit ${kLow.toFixed(3)} (no floating)`);
    });

    // Deaths, dense (team-lead v6): torso follows KayKit on every frame; every leg that leaves KayKit's
    // direction does so because KayKit's leg on this body would put the ankle under its rest clearance (the
    // lifting IK), never on one side for no reason; the corpse lies at KayKit's height per body height.
    const DEATH_RIGS = [['mixamo', {}], ['quaternius', {}], ['unreal', {}], ['mixamo long legs', { positions: LONG }]];
    const DEATHS = ['Death_A', 'Death_B'];
    function sweepDeath(p, name, frames = 40) {
        const src = clips.get(name), clip = p.clipMap(name), out = [];
        p.root.updateMatrixWorld(true);
        const rest = Object.fromEntries(['l', 'r'].map((sd) => [sd, { ankle: wpos(p.root, 'foot' + sd).y, th: wpos(p.root, 'upperleg' + sd).distanceTo(wpos(p.root, 'lowerleg' + sd)), sh: wpos(p.root, 'lowerleg' + sd).distanceTo(wpos(p.root, 'foot' + sd)) }]));
        // Uniform samples plus every key of the retargeted clip (the IK acts on keys; between keys the pose is
        // interpolated, so the "explained by the IK" rule is checked on keys only).
        const keys = new Set(clip.tracks.flatMap((tr) => [...tr.times]).map((x) => Math.min(src.duration - 1e-3, x)));
        const times = [...new Set([...keys, ...Array.from({ length: frames + 1 }, (_, i) => Math.min(src.duration - 1e-3, (src.duration * i) / frames))])].sort((a, b) => a - b);
        for (const t of times) {
            const k = posed(knight, src, t, (r) => ({ dirs: limbDirs(r, null, 0), low: lowTorso(r), up: wpos(r, 'chest').y - wpos(r, 'hips').y }));
            k.up /= kRestTorso();
            const f = posed(p.mixerTarget, clip, t, (r) => {
                const finite = []; r.traverse((o) => { if (o.isBone && !o.getWorldPosition(new THREE.Vector3()).toArray().every(Number.isFinite)) finite.push(o.name); });
                const legs = Object.fromEntries(['l', 'r'].map((sd) => [sd, { hip: wpos(r, 'upperleg' + sd), knee: wpos(r, 'lowerleg' + sd).y, ankle: wpos(r, 'foot' + sd).y }]));
                return { dirs: limbDirs(r, null, 0), low: lowTorso(r), legs, nan: finite };
            });
            out.push({ t, k, f, rest, key: keys.has(t) });
        }
        return out;
    }
    const kRestTorso = () => posed(knight, null, 0, (r) => wpos(r, 'chest').y - wpos(r, 'hips').y);
    const devOf = (s, i) => THREE.MathUtils.radToDeg(s.k.dirs[i].angleTo(s.f.dirs[i]));
    const legIdx = (sd) => [LIMBS.findIndex(([a]) => a === 'upperleg' + sd), LIMBS.findIndex(([a]) => a === 'lowerleg' + sd)];

    for (const [label, opts] of DEATH_RIGS) {
        test(`deaths (${label}): no NaN; torso like KayKit on every frame; leg changes only where the IK must lift; corpse at KayKit height`, async () => {
            const p = await prep(buildHumanoid(label.split(' ')[0], { ...opts, height: H }));
            for (const name of DEATHS) {
                const frames = sweepDeath(p, name);
                let lifted = 0;
                // Per leg and frame: would KayKit's leg directions, on this body's hip and bone lengths, sink the knee
                // or the ankle under the IK's clearance line (floor + rest ankle clearance x lying weight, lying =
                // clamp((0.65 - upright) / 0.2) as in retarget.js)? That is the only reason a leg may leave KayKit.
                const sinks = (s, sd) => {
                    const [th, sh] = legIdx(sd);
                    const knee = s.f.legs[sd].hip.clone().addScaledVector(s.k.dirs[th], s.rest[sd].th);
                    const ankle = knee.clone().addScaledVector(s.k.dirs[sh], s.rest[sd].sh);
                    const line = s.rest[sd].ankle * Math.min(1, Math.max(0, (0.65 - s.k.up) / 0.2)) + 0.02 * H;
                    // Smallest change any two-bone solve needs (a lower bound, in degrees). The IK lifts the ankle straight up
                    // to its clearance line with the hip fixed: the new hip-ankle direction d' and distance D' fix the thigh's
                    // and shin's angles to d' (alpha', beta', law of cosines), so each bone moves at least |angle(old, d') - new|.
                    // A knee under the line needs at least the rigid thigh turn that lifts it there. A straight leg lifted a
                    // few mm needs a real knee bend, which this captures (a pure hip turn would not).
                    const hip = s.f.legs[sd].hip, a = s.rest[sd].th, b = s.rest[sd].sh;
                    const clear = s.rest[sd].ankle * Math.min(1, Math.max(0, (0.65 - s.k.up) / 0.2));
                    const deg = THREE.MathUtils.radToDeg, acos = (x) => Math.acos(Math.min(1, Math.max(-1, x)));
                    let lift = 0, kneeTurn = 0;
                    if (ankle.y < clear) {
                        const T = ankle.clone().setY(clear), dv = T.clone().sub(hip), D = Math.min(a + b, Math.max(Math.abs(a - b), dv.length()));
                        dv.normalize();
                        const al = acos((a * a + D * D - b * b) / (2 * a * D)), be = acos((b * b + D * D - a * a) / (2 * b * D));
                        lift = Math.max(Math.abs(acos(s.k.dirs[th].dot(dv)) - al), Math.abs(acos(s.k.dirs[sh].dot(dv)) - be));
                    }
                    if (knee.y < clear) {
                        const r = a, y = knee.y - hip.y, ty = clear - hip.y;
                        kneeTurn = Math.max(0, acos(-ty / r) - acos(-y / r));
                    }
                    const minTurn = deg(Math.max(lift, kneeTurn));
                    return { yes: Math.min(knee.y, ankle.y) < line, knee: knee.y, ankle: ankle.y, line, minTurn };
                };
                const keyIdx = frames.map((s, i) => (s.key ? i : -1)).filter((i) => i >= 0);
                frames.forEach((s, i) => {
                    const at = `${name}@${s.t.toFixed(2)}`;
                    assert.deepEqual(s.f.nan, [], `${at}: non-finite bones`);
                    for (const j of [0, 1]) assert.ok(devOf(s, j) <= 5, `${at} ${LIMBS[j].join('-')}: torso ${devOf(s, j).toFixed(1)} deg off KayKit`);
                    // Between two keys the pose is a blend of both, so a frame is also explained by its bracketing keys.
                    const prevKey = frames[keyIdx.filter((k) => k <= i).pop() ?? i], nextKey = frames[keyIdx.find((k) => k >= i) ?? i];
                    for (const sd of ['l', 'r']) {
                        const [th, sh] = legIdx(sd);
                        const dev = Math.max(devOf(s, th), devOf(s, sh));
                        if (dev <= 5) continue;
                        lifted++;
                        const here = sinks(s, sd);
                        assert.ok(here.yes || sinks(prevKey, sd).yes || sinks(nextKey, sd).yes, `${at} leg ${sd}: ${dev.toFixed(1)} deg off KayKit although knee ${here.knee.toFixed(3)} / ankle ${here.ankle.toFixed(3)} would stay above ${here.line.toFixed(3)} here and at the neighbouring keys (upright ${s.k.up.toFixed(2)}): not explained by the IK`);
                        // Size of the change: on a lifting key the leg may move at most 4x the two-bone lower bound plus 5 deg.
                        // The bound is loose on big lifts (the knee swing adds to it; current code reaches 3.4x, 4.4 deg under
                        // this limit), but a knee re-planed about a wrong hinge moves 17..49 deg on lifts that need 0.3 deg and
                        // fails by 11..43 deg; a flipped knee solution fails by 65 deg (scratch mutants of retarget.js liftFoot).
                        if (s.key && here.yes) assert.ok(dev <= 4 * here.minTurn + 5, `${at} leg ${sd}: ${dev.toFixed(1)} deg off KayKit for a lift whose two-bone minimum is ${here.minTurn.toFixed(1)} deg (allowed ${(4 * here.minTurn + 5).toFixed(1)}): the IK moves the leg more than the lift needs`);
                    }
                });
                assert.ok(lifted > 0, `${name}: the IK lifts somewhere (otherwise this check is vacuous)`);
                const end = frames[frames.length - 1];
                assert.ok(Math.abs(end.f.low / H - end.k.low / KAYKIT_H) <= 0.03, `${name} end: lowest torso joint ${(end.f.low / H).toFixed(3)} vs KayKit ${(end.k.low / KAYKIT_H).toFixed(3)} body heights`);
            }
        });

        // Known limit (b3d-retarget, v6): only joints are checked. Mesh volume such as Seed-san's backpack can still
        // dip about 0.2 world units into the board while lying on its back; no joint-based check can see that.
        test(`deaths (${label}): no knee or ankle below the floor on any frame`, async () => {
            const p = await prep(buildHumanoid(label.split(' ')[0], { ...opts, height: H }));
            const bad = [];
            for (const name of DEATHS) for (const s of sweepDeath(p, name)) for (const sd of ['l', 'r']) for (const j of ['knee', 'ankle']) {
                const y = s.f.legs[sd][j];
                if (y < -0.02 * H) bad.push(`${name}@${s.t.toFixed(2)} ${j} ${sd} ${(y / H).toFixed(3)} H`);
            }
            assert.deepEqual(bad, []);
        });
    }

    test('IK-style rig (real Quaternius RPG): animatable, feet follow the shins while walking', async () => {
        const dir = path.join(ASSETS, 'packs', 'quaternius-rpg');
        if (!fs.existsSync(dir)) return;
        const g = await loadFile('packs/quaternius-rpg/Warrior.glb');
        const p = await R.prepare(g, THREE, { sourceClips: clips, maps });
        assert.equal(p.static, false, p.warnings.join(' | '));
        assert.ok(p.root.getObjectByName('hips'), 'hips mapped and renamed');
        const walk = p.clipMap('Walking_A');
        const mixer = new THREE.AnimationMixer(p.mixerTarget);
        mixer.clipAction(walk).play();
        const dist = [];
        for (const f of [0, 0.25, 0.5, 0.75]) {
            mixer.setTime(walk.duration * f);
            p.root.updateMatrixWorld(true);
            const a = p.root.getObjectByName('lowerlegl').getWorldPosition(new THREE.Vector3());
            const b = p.root.getObjectByName('footl').getWorldPosition(new THREE.Vector3());
            dist.push(a.distanceTo(b));
        }
        const spread = (Math.max(...dist) - Math.min(...dist)) / Math.max(...dist);
        assert.ok(spread <= 0.01, `shin-to-foot distance varies ${(spread * 100).toFixed(2)}% (${dist.map((d) => d.toFixed(3))})`);
    });

    test('expected static: real pack animals and armless / one-legged rigs', async () => {
        for (const rel of ['packs/quaternius-farm/Horse.glb', 'packs/quaternius-monsters/Slime.glb', 'packs/quaternius-monsters/Bat.glb']) {
            if (!fs.existsSync(path.join(ASSETS, rel))) continue;
            const r = await R.detectRig(await loadFile(rel), { maps });
            assert.equal(r.animatable, false, `${rel} is not a humanoid`);
        }
        const armless = await R.detectRig(await parse(buildHumanoid('mixamo', { omit: ['upperarml', 'lowerarml', 'handl', 'upperarmr', 'lowerarmr', 'handr'] })), { maps });
        assert.equal(armless.animatable, false);
        const oneLeg = await R.detectRig(await parse(buildHumanoid('mixamo', { omit: ['upperlegr', 'lowerlegr', 'footr', 'toesr'] })), { maps });
        assert.equal(oneLeg.animatable, false);
    });

    test('kaykit.json rest pose matches the clip file skeleton', async () => {
        const json = (() => { const d = fs.readFileSync(path.join(ASSETS, 'anims', 'clips.glb')); return JSON.parse(d.subarray(20, 20 + d.readUInt32LE(12)).toString('utf8')); })();
        const byKey = new Map(json.nodes.map((n) => [String(n.name).toLowerCase().replace(/[^a-z0-9]/g, ''), n]));
        const bad = [];
        for (const [bone, rest] of Object.entries(maps.kaykit.rest)) {
            const n = byKey.get(bone.replace(/[^a-z0-9]/g, ''));
            if (!n) { bad.push(`${bone}: not in clips.glb`); continue; }
            const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1];
            if (t.some((v, i) => Math.abs(v - rest.t[i]) > 1e-4)) bad.push(`${bone}: t ${rest.t} vs ${t}`);
            const norm = (q) => Math.hypot(...q);
            const dot = Math.abs(r.reduce((s, v, i) => s + v * rest.r[i], 0)) / (norm(r) * norm(rest.r)); // json rounds to 5 decimals
            if (dot < 1 - 1e-8) bad.push(`${bone}: r ${rest.r} vs ${r}`);
        }
        assert.deepEqual(bad, []);
    });

    test('vrm.convertMaterials: MToon outlines hidden; MToon/Basic -> Standard keeping map, transparency, alphaTest, side', () => {
        const map = new THREE.Texture();
        const mtoon = Object.assign(new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }), { isMToonMaterial: true });
        const outline = Object.assign(new THREE.MeshBasicMaterial(), { isMToonMaterial: true, isOutline: true });
        const basic = new THREE.MeshBasicMaterial({ map });
        const root = new THREE.Group();
        const g = new THREE.BoxGeometry();
        const a = new THREE.Mesh(g, mtoon), b = new THREE.Mesh(g, outline), c = new THREE.Mesh(g, [basic, mtoon]);
        root.add(a, b, c);
        V.convertMaterials(root);
        assert.ok(a.material.isMeshStandardMaterial);
        assert.equal(a.material.map, map);
        assert.equal(a.material.transparent, true);
        assert.equal(a.material.alphaTest, 0.4);
        assert.equal(a.material.side, THREE.DoubleSide);
        assert.ok(b.material.visible === false || b.material.colorWrite === false || b.material.opacity === 0, 'outline hidden');
        assert.ok(c.material.every((m) => m.isMeshStandardMaterial), 'array materials converted');
        assert.equal(c.material[1], a.material, 'shared materials converted once');
    });
});
