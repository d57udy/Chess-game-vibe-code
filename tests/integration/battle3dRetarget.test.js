'use strict';
// v6 retarget.js with real three.js + GLTFLoader on built GLB fixtures: rig detection (KayKit,
// Mixamo with ':' names, Unreal/Quaternius-UE names, Quaternius classic names, non-humanoid), bone-map
// files cover every required bone, prepare() renames mapped bones to KayKit names and adds hand
// sockets, retargeted clips only target existing nodes and play, and a static fallback with a clear
// warning when required bones are missing.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findThree, registerThree, installBrowserGlobals, ROOT } = require('../helpers/loadBattle3dThree');
const { buildGlb, buildHumanoid } = require('../helpers/glbFixture');

const FILE = path.join(ROOT, 'battle3d', 'retarget.js');
const skip = !fs.existsSync(FILE) ? 'retarget.js not present' : !findThree() ? 'three.js not installed' : false;
const RIGS = path.join(ROOT, 'battle3d', 'assets', 'rigs');
let R, THREE, GLTFLoader, maps, kaykitClips;

async function parse(buf) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    return new GLTFLoader().parseAsync(ab, '');
}
// A few real clips from the shipped clip file (KayKit bones)
async function realClips() {
    const file = path.join(ROOT, 'battle3d', 'assets', 'anims', 'clips.glb');
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const b = fs.readFileSync(file);
    const g = await loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), '');
    return new Map(g.animations.map((a) => [a.name, a]));
}
const names = (root) => { const s = new Set(); root.traverse((o) => s.add(o.name)); return s; };

describe('battle3d retarget (v6)', { skip }, () => {
    before(async () => {
        registerThree(findThree().dir);
        installBrowserGlobals(); // textures in the KayKit GLB need image decoding stubs
        THREE = await import('three');
        ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
        R = await import(pathToFileURL(FILE).href);
        maps = Object.fromEntries(['kaykit', 'mixamo', 'quaternius', 'vrm'].map((n) => [n, JSON.parse(fs.readFileSync(path.join(RIGS, `${n}.json`), 'utf8'))]));
        R.setRigMaps?.(maps);
        kaykitClips = await realClips();
    });

    test('bone maps: every required canonical bone has candidates in each map; KayKit rest pose present', () => {
        for (const [name, m] of Object.entries(maps)) {
            if (name === 'kaykit') { assert.ok(m.rest && m.rest.hips, 'kaykit rest pose'); continue; }
            assert.ok(m.bones && typeof m.bones === 'object', `${name}.bones`);
            const missing = R.REQUIRED.filter((b) => !(Array.isArray(m.bones[b]) && m.bones[b].length));
            assert.deepEqual(missing, [], `${name} map lacks required bones`);
            assert.ok(m.type && m.label, `${name} type/label`);
        }
    });

    for (const [label, build, type] of [
        ['KayKit', () => buildGlb(), 'kaykit'],
        ['Mixamo (mixamorig: names)', () => buildHumanoid('mixamo'), 'mixamo'],
        ['Quaternius classic (UpperArm.L)', () => buildHumanoid('quaternius'), 'quaternius'],
        ['Unreal / Quaternius UAL (upperarm_l)', () => buildHumanoid('unreal'), 'quaternius'],
    ]) {
        test(`detectRig: ${label} -> ${type}, animatable`, async () => {
            const g = await parse(build());
            const r = await R.detectRig(g.scene, { gltfJson: g.parser?.json, maps });
            assert.equal(r.type, type, JSON.stringify(r));
            assert.equal(r.animatable, true, JSON.stringify(r.missing));
            assert.deepEqual(r.missing, []);
            assert.ok(r.confidence > 0.5, `confidence ${r.confidence}`);
        });
    }

    test('detectRig: missing required bones -> not animatable, missing list names them', async () => {
        const g = await parse(buildHumanoid('mixamo', { omit: ['handl', 'handr', 'head'] }));
        const r = await R.detectRig(g.scene, { maps });
        assert.equal(r.animatable, false);
        for (const b of ['handl', 'handr', 'head']) assert.ok(r.missing.includes(b), `missing ${b}: ${r.missing}`);
    });

    test('detectRig: an unskinned / non-humanoid model is not animatable (no crash)', async () => {
        for (const buf of [buildGlb({ skinned: false }), buildGlb({ joints: ['Root', 'Body', 'Tail', 'Tail2'], parents: [-1, 0, 1, 2] })]) {
            const g = await parse(buf);
            const r = await R.detectRig(g.scene, { maps });
            assert.equal(r.animatable, false);
            assert.ok(Array.isArray(r.warnings));
        }
    });

    for (const naming of ['mixamo', 'quaternius', 'unreal']) {
        test(`prepare (${naming}): renamed KayKit bones + hand sockets, retargeted clips bind and play`, async () => {
            const g = await parse(buildHumanoid(naming));
            const p = await R.prepare(g, THREE, { sourceClips: kaykitClips, maps });
            assert.equal(p.static, false, p.warnings.join(' | '));
            assert.ok(p.root && p.mixerTarget);
            const n = names(p.root);
            for (const b of ['hips', 'head', 'upperarml', 'lowerarmr', 'footl', 'handslotl', 'handslotr']) assert.ok(n.has(b), `${b} in the rebound model`);
            for (const clipName of ['Idle', 'Walking_A', '1H_Melee_Attack_Chop', 'Death_A']) {
                assert.equal(p.hasClip(clipName), true, clipName);
                const clip = p.clipMap(clipName);
                assert.ok(clip && clip.tracks.length > 0, `${clipName} converted`);
                for (const t of clip.tracks) {
                    const node = THREE.PropertyBinding.parseTrackName(t.name).nodeName;
                    assert.ok(n.has(node), `${clipName}: track targets missing node ${node}`);
                    for (const v of t.values) assert.ok(Number.isFinite(v), `${clipName}: NaN in ${t.name}`);
                }
                const mixer = new THREE.AnimationMixer(p.mixerTarget);
                const action = mixer.clipAction(clip);
                action.play();
                mixer.update(0.3);
                p.root.updateMatrixWorld(true);
                p.root.traverse((o) => { if (o.isBone) assert.ok(o.matrixWorld.elements.every(Number.isFinite), `${clipName}: NaN bone ${o.name}`); });
            }
            assert.ok(p.scale > 0 && Number.isFinite(p.hipHeight));
        });
    }

    test('retargeted poses match KayKit: limb directions within 5 degrees across clips and times', async () => {
        const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        const kb = fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', 'characters', 'Knight.glb'));
        const knight = (await loader.parseAsync(kb.buffer.slice(kb.byteOffset, kb.byteOffset + kb.length), '')).scene;
        const LIMBS = [['upperarml', 'lowerarml'], ['lowerarml', 'handl'], ['upperarmr', 'lowerarmr'], ['upperlegl', 'lowerlegl'], ['lowerlegl', 'footl'], ['upperlegr', 'lowerlegr']];
        const dirs = (root, t, clip) => {
            const mixer = new THREE.AnimationMixer(root);
            mixer.clipAction(clip).play();
            mixer.setTime(t);
            root.updateMatrixWorld(true);
            const pos = (n) => root.getObjectByName(n).getWorldPosition(new THREE.Vector3());
            return LIMBS.map(([a, b]) => pos(b).sub(pos(a)).normalize());
        };
        const p = await R.prepare(await parse(buildHumanoid('mixamo')), THREE, { sourceClips: kaykitClips, maps });
        const worst = [];
        for (const clipName of ['Idle', 'Walking_A', '1H_Melee_Attack_Chop']) {
            const src = kaykitClips.get(clipName);
            for (const t of [0, src.duration * 0.33, src.duration * 0.66]) {
                const want = dirs(knight, t, src);
                const got = dirs(p.root, t, p.clipMap(clipName));
                want.forEach((w, i) => {
                    const deg = THREE.MathUtils.radToDeg(w.angleTo(got[i]));
                    if (deg > 5) worst.push(`${clipName}@${t.toFixed(2)} ${LIMBS[i].join('-')}: ${deg.toFixed(1)} deg`);
                });
            }
        }
        assert.deepEqual(worst, []);
    });

    test('prepare: same rig twice reuses converted clips (cache) and gives identical tracks', async () => {
        const a = await R.prepare(await parse(buildHumanoid('mixamo')), THREE, { sourceClips: kaykitClips, maps });
        const b = await R.prepare(await parse(buildHumanoid('mixamo')), THREE, { sourceClips: kaykitClips, maps });
        const ca = a.clipMap('Idle'), cb = b.clipMap('Idle');
        assert.equal(ca.tracks.length, cb.tracks.length);
        assert.deepEqual(Array.from(ca.tracks[0].values.slice(0, 8)), Array.from(cb.tracks[0].values.slice(0, 8)));
    });

    test('prepare: KayKit rigs pass through (no wrapping); unmappable rigs fall back to static with a warning', async () => {
        const k = await R.prepare(await parse(buildGlb()), THREE, { sourceClips: kaykitClips, maps });
        assert.equal(k.rigType, 'kaykit');
        assert.equal(k.static, false);
        assert.equal(k.clipMap('Idle'), kaykitClips.get('Idle'), 'original clips');
        const s = await R.prepare(await parse(buildHumanoid('mixamo', { omit: ['upperlegl', 'lowerlegl', 'footl', 'toesl'] })), THREE, { sourceClips: kaykitClips, maps });
        assert.equal(s.static, true);
        assert.equal(s.clipMap('Idle'), null);
        assert.equal(s.hasClip('Idle'), false);
        assert.ok(s.warnings.length > 0 && /static|missing|cannot/i.test(s.warnings.join(' ')), s.warnings.join(' | '));
        const st = await R.prepare(await parse(buildGlb({ skinned: false })), THREE, { sourceClips: kaykitClips, maps });
        assert.equal(st.static, true);
    });
});
