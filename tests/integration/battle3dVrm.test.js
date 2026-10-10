'use strict';
// v6 vrm.js pure helpers (no @pixiv/three-vrm needed): file detection, GLB sniffing for VRM 0.x /
// 1.0 extensions, licence metadata mapping and warnings; and retarget.js using the VRM humanoid
// table (VRMC_vrm / VRM) to map bones whose node names say nothing.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findThree, registerThree, ROOT } = require('../helpers/loadBattle3dThree');
const { buildGlb, buildHumanoid } = require('../helpers/glbFixture');

const FILE = path.join(ROOT, 'battle3d', 'vrm.js');
const skip = !fs.existsSync(FILE) ? 'vrm.js not present' : !findThree() ? 'three.js not installed' : false;
let V, R, GLTFLoader, maps;
// canonical role -> VRM humanoid bone name
const VRM_BONES = { hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head', upperarml: 'leftUpperArm', lowerarml: 'leftLowerArm', handl: 'leftHand',
    upperarmr: 'rightUpperArm', lowerarmr: 'rightLowerArm', handr: 'rightHand', upperlegl: 'leftUpperLeg', lowerlegl: 'leftLowerLeg', footl: 'leftFoot', toesl: 'leftToes',
    upperlegr: 'rightUpperLeg', lowerlegr: 'rightLowerLeg', footr: 'rightFoot', toesr: 'rightToes' };
// meaningless node names, so only the humanoid table can map them
const OPAQUE = Object.fromEntries(Object.keys(VRM_BONES).map((r, i) => [r, `J_${String(i).padStart(2, '0')}`]));
function vrmGlb(version) {
    return buildHumanoid(OPAQUE, {
        extendJson: (json, { jointBase, roles }) => {
            const nodeOf = (role) => jointBase + roles.indexOf(role);
            if (version === '1') {
                json.extensionsUsed = ['VRMC_vrm'];
                json.extensions = { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Test', authors: ['QA'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit', creditNotation: 'required' },
                    humanoid: { humanBones: Object.fromEntries(roles.filter((r) => VRM_BONES[r]).map((r) => [VRM_BONES[r], { node: nodeOf(r) }])) } } };
            } else {
                json.extensionsUsed = ['VRM'];
                json.extensions = { VRM: { meta: { title: 'Old', author: 'QA' }, humanoid: { humanBones: roles.filter((r) => VRM_BONES[r]).map((r) => ({ bone: VRM_BONES[r], node: nodeOf(r) })) } } };
            }
        },
    });
}
async function parse(buf) {
    return new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
}

describe('battle3d vrm.js (v6)', { skip }, () => {
    before(async () => {
        registerThree(findThree().dir);
        ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
        V = await import(pathToFileURL(FILE).href);
        R = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'retarget.js')).href);
        const RIGS = path.join(ROOT, 'battle3d', 'assets', 'rigs');
        maps = Object.fromEntries(['kaykit', 'mixamo', 'quaternius', 'vrm'].map((n) => [n, JSON.parse(fs.readFileSync(path.join(RIGS, `${n}.json`), 'utf8'))]));
    });

    test('isVrmFile by extension, incl. query/hash; not .glb', () => {
        for (const s of ['a.vrm', 'A.VRM', 'x/y/z.vrm?v=1', 'blob.vrm#k']) assert.equal(V.isVrmFile(s), true, s);
        for (const s of ['a.glb', 'a.vrm.glb', '', null, undefined, 'vrm']) assert.equal(V.isVrmFile(s), false, String(s));
    });

    test('sniffVrm: VRM 1.0 and 0.x GLBs yes; plain GLB and garbage no', () => {
        assert.equal(V.sniffVrm(vrmGlb('1')), true);
        assert.equal(V.sniffVrm(vrmGlb('0')), true);
        const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
        assert.equal(V.sniffVrm(ab(vrmGlb('1'))), true, 'ArrayBuffer input');
        assert.equal(V.sniffVrm(buildGlb()), false);
        assert.equal(V.sniffVrm(Buffer.from('not a glb at all, nope')), false);
        assert.equal(V.sniffVrm(new ArrayBuffer(4)), false);
    });

    test('vrmMeta: 1.0 and 0.x licence fields mapped; warnings for author-only, violence, credit', () => {
        let m = V.vrmMeta({ meta: { metaVersion: '1', name: 'A', authors: ['X'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', commercialUsage: 'personalNonProfit', creditNotation: 'required', allowRedistribution: false } });
        assert.equal(m.version, '1');
        assert.equal(m.commercial, false);
        assert.equal(m.creditRequired, true);
        assert.equal(m.redistribution, false);
        assert.ok(m.warnings.some((w) => /only its author/.test(w)) && m.warnings.some((w) => /Credit required: X/.test(w)), m.warnings.join(' | '));
        m = V.vrmMeta({ userData: { vrm: { meta: { metaVersion: '0', title: 'B', author: 'Y', allowedUserName: 'Everyone', violentUssageName: 'Disallow', commercialUssageName: 'Allow', licenseName: 'CC_BY' } } } });
        assert.equal(m.version, '0');
        assert.equal(m.avatarPermission, 'everyone');
        assert.equal(m.commercial, true);
        assert.ok(m.warnings.some((w) => /violent/.test(w)));
        assert.equal(V.vrmMeta({}), null);
    });

    for (const version of ['1', '0']) {
        test(`retarget maps a VRM ${version === '1' ? '1.0' : '0.x'} humanoid from its table (opaque node names)`, async () => {
            const g = await parse(vrmGlb(version));
            const r = await R.detectRig(g.scene, { gltfJson: g.parser.json, maps });
            assert.equal(r.type, 'vrm', JSON.stringify(r));
            assert.equal(r.animatable, true, `missing ${r.missing}`);
            assert.equal(r.bones.upperarml, 'J_05'.replace(/_/, '_'), 'left upper arm from the table');
        });
    }

    test('the same opaque rig without the VRM table is not animatable (no guessing from J_xx names)', async () => {
        const g = await parse(buildHumanoid(OPAQUE));
        const r = await R.detectRig(g.scene, { gltfJson: g.parser.json, maps });
        assert.equal(r.animatable, false);
    });

    test('three-vrm version pinned and compatible with three 0.186 (peer >= 0.137)', () => {
        assert.match(V.THREE_VRM_VERSION, /^\d+\.\d+\.\d+$/);
        assert.ok(Number(V.THREE_VRM_VERSION.split('.')[0]) >= 3, 'three-vrm 3.x supports three r16x+');
    });
});
