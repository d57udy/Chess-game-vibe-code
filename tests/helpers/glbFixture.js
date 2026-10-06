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

    const pos = addAcc(f32([0, 0, 0, 0.5, 0, 0, 0, 1, 0]), 5126, 3, 'VEC3', { min: [0, 0, 0], max: [0.5, 1, 0] }, 34962);
    const attributes = { POSITION: pos };
    if (skinned) {
        attributes.JOINTS_0 = addAcc(Buffer.from(new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, Math.min(2, joints.length - 1), 0, 0, 0])), 5121, 3, 'VEC4', {}, 34962);
        attributes.WEIGHTS_0 = addAcc(f32([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 5126, 3, 'VEC4', {}, 34962);
    }
    const nodes = [];
    // node 0: armature, node 1: body mesh, nodes 2..: joints, then accessory meshes
    nodes.push({ name: 'Rig', children: [] });
    nodes.push({ name: 'Body', mesh: 0, ...(skinned ? { skin: 0 } : {}) });
    const jointBase = 2;
    joints.forEach((name, i) => nodes.push({ name, translation: [0, i === 0 ? 0 : 0.1, 0] }));
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
        joints.forEach((_, i) => ibm.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.1 * i, 0, 1));
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
