// Builds tiny, valid skinned GLB files in memory for cast import tests: one triangle skinned to a
// joint chain with the given names, optional animation on the first joint. No three.js needed.
'use strict';

// KayKit rig (Adventurers / Skeletons): joint names and parent index (-1 = root).
const KAYKIT_JOINTS = ['root', 'hips', 'spine', 'chest', 'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
    'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r', 'head', 'upperleg.l', 'lowerleg.l', 'foot.l', 'toes.l',
    'upperleg.r', 'lowerleg.r', 'foot.r', 'toes.r', 'kneeIK.l', 'control-toe-roll.l', 'control-heel-roll.l',
    'control-foot-roll.l', 'heelIK.l', 'IK-foot.l', 'IK-toe.l', 'kneeIK.r', 'control-toe-roll.r', 'control-heel-roll.r',
    'control-foot-roll.r', 'heelIK.r', 'IK-foot.r', 'IK-toe.r', 'elbowIK.l', 'handIK.l', 'elbowIK.r', 'handIK.r'];
const KAYKIT_PARENTS = [-1, 0, 1, 2, 3, 4, 5, 6, 7, 3, 9, 10, 11, 12, 3, 1, 15, 16, 17, 1, 19, 20, 21, 0, 0, 24, 25, 26, 26,
    25, 0, 0, 31, 32, 33, 33, 32, 0, 0, 0, 0];

/**
 * @param {object} [o]
 * @param {string[]} [o.joints] joint names (default: the KayKit rig)
 * @param {number[]} [o.parents] parent index per joint (default: KayKit hierarchy, or a chain)
 * @param {string[]} [o.meshes] extra unskinned mesh node names parented to joint 0 (accessories)
 * @param {string[]} [o.animations] animation names (rotation track on joint 1)
 * @param {boolean} [o.skinned=true] false: a static mesh without a skin
 * @returns {Buffer} GLB bytes
 */
function buildGlb(o = {}) {
    const joints = o.joints || KAYKIT_JOINTS;
    const parents = o.parents || (o.joints ? joints.map((_, i) => i - 1) : KAYKIT_PARENTS);
    const skinned = o.skinned !== false;
    const chunks = [];
    let offset = 0;
    const bufferViews = [], accessors = [];
    const addView = (buf, target) => {
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
        chunks.push(buf); offset += buf.length;
        return bufferViews.length - 1;
    };
    const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
    const addAcc = (buf, componentType, count, type, extra = {}, target) => {
        accessors.push({ bufferView: addView(buf, target), componentType, count, type, ...extra });
        return accessors.length - 1;
    };

    // o.triangles: a static mesh with that many (tiny, stacked) triangles, for budget tests
    const triVerts = o.triangles ? (() => { const a = new Float32Array(o.triangles * 9); for (let t = 0; t < o.triangles; t++) { a[t * 9 + 3] = 0.5; a[t * 9 + 7] = 1; } return Array.from(a); })() : [0, 0, 0, 0.5, 0, 0, 0, 1, 0];
    // o.height: top of the body triangle (default 1); retarget measures body height from skinned vertices
    const top = o.height || 1;
    if (top !== 1) for (let k = 1; k < triVerts.length; k += 3) triVerts[k] *= top;
    const pos = addAcc(f32(triVerts), 5126, triVerts.length / 3, 'VEC3', { min: [0, 0, 0], max: [0.5, top, 0] }, 34962);
    const attributes = { POSITION: pos };
    if (skinned) {
        const wj = o.weightedJoints || [0, 1, Math.min(2, joints.length - 1)];
        attributes.JOINTS_0 = addAcc(Buffer.from(new Uint8Array([wj[0], 0, 0, 0, wj[1], 0, 0, 0, wj[2], 0, 0, 0])), 5121, 3, 'VEC4', {}, 34962);
        attributes.WEIGHTS_0 = addAcc(f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 5126, 3, 'VEC4', {}, 34962);
    }
    const nodes = [];
    // node 0: armature, node 1: body mesh, nodes 2..: joints, then accessory meshes
    nodes.push({ name: 'Rig', children: [] });
    nodes.push({ name: 'Body', mesh: 0, ...(skinned ? { skin: 0 } : {}) });
    const jointBase = 2;
    joints.forEach((name, i) => nodes.push({ name, translation: o.translations ? o.translations[i] : [0, i === 0 ? 0 : 0.1, 0] }));
    joints.forEach((_, i) => {
        const p = parents[i];
        if (p < 0) nodes[0].children.push(jointBase + i);
        else (nodes[jointBase + p].children ||= []).push(jointBase + i);
    });
    for (const name of o.meshes || []) {
        nodes.push({ name, mesh: 1 });
        (nodes[jointBase].children ||= []).push(nodes.length - 1);
    }
    const meshes = [
        { name: 'Body', primitives: [{ attributes, material: 0 }] },
        { name: 'Accessory', primitives: [{ attributes: { POSITION: pos }, material: 0 }] },
    ];
    const json = {
        asset: { version: '2.0', generator: 'battle3d test fixture' },
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
        nodes, meshes,
        materials: [{ name: 'M', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] } }],
        accessors, bufferViews,
    };
    if (skinned) {
        const ibm = [];
        joints.forEach((_, i) => {
            const w = o.worldPositions ? o.worldPositions[i] : [0, 0.1 * i, 0];
            ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1); // pure-translation bind pose
        });
        json.skins = [{ joints: joints.map((_, i) => jointBase + i), inverseBindMatrices: addAcc(f32(ibm), 5126, joints.length, 'MAT4') }];
    }
    if (o.animations && o.animations.length) {
        const times = addAcc(f32([0, 1]), 5126, 2, 'SCALAR', { min: [0], max: [1] });
        const rots = addAcc(f32([0, 0, 0, 1, 0, 0.7071, 0, 0.7071]), 5126, 2, 'VEC4');
        json.animations = o.animations.map((name) => ({
            name,
            samplers: [{ input: times, output: rots, interpolation: 'LINEAR' }],
            channels: [{ sampler: 0, target: { node: jointBase + Math.min(1, joints.length - 1), path: 'rotation' } }],
        }));
    }
    if (o.extendJson) o.extendJson(json, { jointBase });
    const bin = Buffer.concat(chunks);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    json.buffers = [{ byteLength: binPadded.length }];
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const total = 12 + 8 + jsonBuf.length + 8 + binPadded.length;
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004E4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, binPadded]);
}

module.exports = { buildGlb, KAYKIT_JOINTS, KAYKIT_PARENTS };

// --- humanoid fixtures for retargeting tests ---------------------------------------------------------
// A T-pose humanoid (1.8 units tall, facing +Z, its left arm along +X) as [role, parentRole, world xyz].
const HUMANOID = [
    ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 1.1, 0]], ['chest', 'spine', [0, 1.3, 0]], ['neck', 'chest', [0, 1.5, 0]], ['head', 'neck', [0, 1.62, 0]],
    ['upperarml', 'chest', [0.2, 1.45, 0]], ['lowerarml', 'upperarml', [0.48, 1.45, 0]], ['handl', 'lowerarml', [0.74, 1.45, 0]],
    ['upperarmr', 'chest', [-0.2, 1.45, 0]], ['lowerarmr', 'upperarmr', [-0.48, 1.45, 0]], ['handr', 'lowerarmr', [-0.74, 1.45, 0]],
    ['upperlegl', 'hips', [0.11, 0.9, 0]], ['lowerlegl', 'upperlegl', [0.11, 0.5, 0]], ['footl', 'lowerlegl', [0.11, 0.08, 0]], ['toesl', 'footl', [0.11, 0.02, 0.14]],
    ['upperlegr', 'hips', [-0.11, 0.9, 0]], ['lowerlegr', 'upperlegr', [-0.11, 0.5, 0]], ['footr', 'lowerlegr', [-0.11, 0.08, 0]], ['toesr', 'footr', [-0.11, 0.02, 0.14]],
];
const NAMING = {
    mixamo: { hips: 'mixamorig:Hips', spine: 'mixamorig:Spine', chest: 'mixamorig:Spine2', neck: 'mixamorig:Neck', head: 'mixamorig:Head',
        upperarml: 'mixamorig:LeftArm', lowerarml: 'mixamorig:LeftForeArm', handl: 'mixamorig:LeftHand',
        upperarmr: 'mixamorig:RightArm', lowerarmr: 'mixamorig:RightForeArm', handr: 'mixamorig:RightHand',
        upperlegl: 'mixamorig:LeftUpLeg', lowerlegl: 'mixamorig:LeftLeg', footl: 'mixamorig:LeftFoot', toesl: 'mixamorig:LeftToeBase',
        upperlegr: 'mixamorig:RightUpLeg', lowerlegr: 'mixamorig:RightLeg', footr: 'mixamorig:RightFoot', toesr: 'mixamorig:RightToeBase' },
    unreal: { hips: 'pelvis', spine: 'spine_01', chest: 'spine_03', neck: 'neck_01', head: 'head',
        upperarml: 'upperarm_l', lowerarml: 'lowerarm_l', handl: 'hand_l', upperarmr: 'upperarm_r', lowerarmr: 'lowerarm_r', handr: 'hand_r',
        upperlegl: 'thigh_l', lowerlegl: 'calf_l', footl: 'foot_l', toesl: 'ball_l', upperlegr: 'thigh_r', lowerlegr: 'calf_r', footr: 'foot_r', toesr: 'ball_r' },
    quaternius: { hips: 'Hips', spine: 'Abdomen', chest: 'Chest', neck: 'Neck', head: 'Head',
        upperarml: 'UpperArm.L', lowerarml: 'LowerArm.L', handl: 'Wrist.L', upperarmr: 'UpperArm.R', lowerarmr: 'LowerArm.R', handr: 'Wrist.R',
        upperlegl: 'UpperLeg.L', lowerlegl: 'LowerLeg.L', footl: 'Foot.L', toesl: 'Toes.L', upperlegr: 'UpperLeg.R', lowerlegr: 'LowerLeg.R', footr: 'Foot.R', toesr: 'Toes.R' },
};
/**
 * Humanoid GLB with a naming convention ('mixamo' | 'unreal' | 'quaternius' | a {role: name} map).
 * omit: roles to leave out (children re-parented to the omitted bone's parent).
 */
function buildHumanoid(naming, { omit = [], animations, transform = null, positions = {}, rotations = {}, weighted = null } = {}) {
    const names = typeof naming === 'string' ? NAMING[naming] : naming;
    const kept = HUMANOID.filter(([role]) => !omit.includes(role) && names[role]);
    const world = Object.fromEntries(HUMANOID.map(([r, , p]) => {
        const q = positions[r] || p;
        return [r, transform ? transform(q, r) : q];
    }));
    const parentOf = Object.fromEntries(HUMANOID.map(([r, p]) => [r, p]));
    const keptRoles = kept.map(([r]) => r);
    const effParent = (role) => { let p = parentOf[role]; while (p && !keptRoles.includes(p)) p = parentOf[p]; return p; };
    const joints = kept.map(([r]) => names[r]);
    const parents = kept.map(([r]) => { const p = effParent(r); return p ? keptRoles.indexOf(p) : -1; });
    const translations = kept.map(([r]) => { const p = effParent(r); const a = world[r], b = p ? world[p] : [0, 0, 0]; return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; });
    const userExtend = arguments[1]?.extendJson;
    return buildGlb({
        joints, parents, translations, worldPositions: kept.map(([r]) => world[r]), animations, height: arguments[1]?.height,
        weightedJoints: weighted ? weighted.map((r) => keptRoles.indexOf(r)) : undefined,
        extendJson: (json, info) => {
            // posed save: a node rotation that differs from the bind pose (inverse binds stay unrotated)
            for (const [role, q] of Object.entries(rotations)) {
                const i = keptRoles.indexOf(role);
                if (i >= 0) json.nodes[info.jointBase + i].rotation = q;
            }
            if (userExtend) userExtend(json, { ...info, roles: keptRoles });
        },
    });
}

module.exports.buildHumanoid = buildHumanoid;
module.exports.HUMANOID_NAMING = NAMING;
