// Retargeting for the 3D battle: lets humanoid models that are not KayKit (Mixamo, VRM, Quaternius, generic
// rigs) play our shared KayKit clips. See battle3d/CONTRACT.md (v6, section 3).
//
//   await detectRig(object3D, { gltfJson, vrm }) -> { type, confidence, missing, animatable, facing, warnings }
//   await prepare(gltf, THREE, { sourceClips }) -> { root, mixerTarget, rigType, confidence, static, warnings,
//                                                   clipMap(name), hasClip(name), scale, hipHeight }
//
// How it works. The target is first put in its bind pose and wrapped so it faces +Z with Y up (like KayKit).
// Then it is "rebound": every mapped bone gets the KayKit bone's world orientation (arms and legs first
// aligned to the KayKit T-pose directions, so A-pose rigs work) and a uniform world scale equal to the
// target/KayKit leg length ratio; the skin's bone inverses are updated so the mesh does not move. After that a
// mapped target bone simply copies the world rotation of its KayKit bone at every key, so a clip converts by
// forward kinematics on the KayKit rest pose (assets/rigs/kaykit.json) plus one local solve per bone. Mapped
// bones are renamed to our sanitized KayKit names (hips, upperarml, ...) and handslotl/handslotr sockets are
// added, so units.js bone lookups, props and accessories work unchanged. Rebinding changes the proto itself,
// so SkeletonUtils.clone copies of it need nothing at runtime (no per-frame update, unlike VRM normalized bones).

import * as THREE from 'three';

const RIG_BASE = new URL('./assets/rigs/', import.meta.url).href;
const MAP_FILES = ['kaykit', 'mixamo', 'quaternius', 'vrm'];

// Our canonical (KayKit) bones that a target can provide, parent-first.
export const CANONICAL = ['hips', 'spine', 'chest', 'head',
    'upperarml', 'lowerarml', 'handl', 'upperarmr', 'lowerarmr', 'handr',
    'upperlegl', 'lowerlegl', 'footl', 'toesl', 'upperlegr', 'lowerlegr', 'footr', 'toesr'];
// Needed to play the clips; spine or chest (at least one) is checked separately.
export const REQUIRED = ['hips', 'head', 'upperarml', 'lowerarml', 'handl', 'upperarmr', 'lowerarmr', 'handr',
    'upperlegl', 'lowerlegl', 'footl', 'upperlegr', 'lowerlegr', 'footr'];
// Canonical parent (for hierarchy checks and for which mapped ancestor drives a bone).
const PARENT = {
    spine: 'hips', chest: 'spine', head: 'chest',
    upperarml: 'chest', lowerarml: 'upperarml', handl: 'lowerarml',
    upperarmr: 'chest', lowerarmr: 'upperarmr', handr: 'lowerarmr',
    upperlegl: 'hips', lowerlegl: 'upperlegl', footl: 'lowerlegl', toesl: 'footl',
    upperlegr: 'hips', lowerlegr: 'upperlegr', footr: 'lowerlegr', toesr: 'footr'
};
// Limbs are aligned to the KayKit rest direction (bone -> child joint); hands/toes inherit their parent's
// alignment. The torso and head keep their own rest posture (a hunched monster stays hunched).
const ALIGN = { upperarml: 'lowerarml', lowerarml: 'handl', upperarmr: 'lowerarmr', lowerarmr: 'handr',
    upperlegl: 'lowerlegl', lowerlegl: 'footl', footl: 'toesl', upperlegr: 'lowerlegr', lowerlegr: 'footr', footr: 'toesr' };
const INHERIT = { handl: 'lowerarml', handr: 'lowerarmr', toesl: 'footl', toesr: 'footr', footl: 'lowerlegl', footr: 'lowerlegr' };
const SLOTS = { handslotl: 'handl', handslotr: 'handr' };

const sanitize = n => THREE.PropertyBinding.sanitizeNodeName(String(n ?? ''));
const keyOf = n => sanitize(n).toLowerCase().replace(/[^a-z0-9]/g, '');

// --- bone maps -------------------------------------------------------------------------------------------

let mapsPromise = null;
let mapsLoaded = null;

// Loads assets/rigs/*.json once. Tests can call setRigMaps() instead.
export function loadRigMaps(base = RIG_BASE) {
    if (mapsLoaded) return Promise.resolve(mapsLoaded);
    if (!mapsPromise) {
        mapsPromise = Promise.all(MAP_FILES.map(async name => {
            const res = await fetch(new URL(name + '.json', base).href);
            if (!res.ok) throw new Error(`rig map ${name}.json: HTTP ${res.status}`);
            return [name, await res.json()];
        })).then(list => (mapsLoaded = Object.fromEntries(list)))
            .catch(e => { mapsPromise = null; throw e; });
    }
    return mapsPromise;
}

export function setRigMaps(maps) { mapsLoaded = maps; mapsPromise = null; }

// --- analysis ----------------------------------------------------------------------------------------------

function skinnedMeshes(root) {
    const out = [];
    root.traverse(o => { if (o.isSkinnedMesh && o.skeleton) out.push(o); });
    return out;
}

function skeletonBones(root) {
    const set = new Set();
    for (const m of skinnedMeshes(root)) for (const b of m.skeleton.bones) if (b) set.add(b);
    if (!set.size) root.traverse(o => { if (o.isBone) set.add(o); });
    return [...set];
}

const isAncestor = (a, b) => { for (let o = b?.parent; o; o = o.parent) if (o === a) return true; return false; };
const depth = o => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };

// Position in the model's frame: the root's own transform counts (vrm.js turns VRM 0.x scenes), its parent's does not.
const modelPos = (refRoot, o) => {
    const v = o.getWorldPosition(new THREE.Vector3());
    return refRoot.parent ? refRoot.parent.worldToLocal(v) : v;
};

function lca(a, b) {
    const seen = new Set();
    for (let o = a; o; o = o.parent) seen.add(o);
    for (let o = b; o; o = o.parent) if (seen.has(o)) return o;
    return null;
}

// Map from a name-based bone table (mixamo.json, quaternius.json, kaykit.json).
function mapByNames(bones, table) {
    const strip = table.strip ? new RegExp(table.strip, 'i') : null;
    const byKey = new Map();
    for (const b of bones) {
        let k = sanitize(b.name);
        if (strip) k = k.replace(strip, '');
        k = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        const prev = byKey.get(k);
        if (!prev || depth(b) < depth(prev)) byKey.set(k, b);
    }
    const out = {};
    for (const [c, cands] of Object.entries(table.bones || {})) {
        for (const n of [].concat(cands)) {
            const b = byKey.get(keyOf(n));
            if (b) { out[c] = b; break; }
        }
    }
    return out;
}

// VRM: the file's humanoid table says which node is which bone.
function mapVrm(scene, { vrm, gltfJson, parser }, table) {
    const node = {};
    const humanoid = vrm?.humanoid;
    const ext = gltfJson?.extensions || {};
    let list = null;
    if (humanoid?.getRawBoneNode) {
        for (const c of Object.keys(table.bones)) for (const n of table.bones[c]) {
            const b = humanoid.getRawBoneNode(n);
            if (b) { node[c] = b; break; }
        }
        return node;
    }
    if (ext.VRMC_vrm?.humanoid?.humanBones) list = Object.entries(ext.VRMC_vrm.humanoid.humanBones).map(([bone, v]) => ({ bone, node: v.node }));
    else if (Array.isArray(ext.VRM?.humanoid?.humanBones)) list = ext.VRM.humanoid.humanBones;
    if (!list) return null;
    // glTF node index -> Object3D (GLTFLoader keeps parser.associations).
    const byIndex = new Map();
    if (parser?.associations) for (const [obj, a] of parser.associations) if (a?.nodes !== undefined && obj.isObject3D) byIndex.set(a.nodes, obj);
    if (!byIndex.size && gltfJson?.nodes) {
        const names = gltfJson.nodes.map(n => sanitize(n.name));
        scene.traverse(o => { const i = names.indexOf(o.name); if (i >= 0 && !byIndex.has(i)) byIndex.set(i, o); });
    }
    const vrmBone = new Map(list.map(h => [h.bone, byIndex.get(h.node)]));
    for (const c of Object.keys(table.bones)) for (const n of table.bones[c]) {
        const b = vrmBone.get(n);
        if (b) { node[c] = b; break; }
    }
    return node;
}

// Generic humanoid by name heuristics plus topology.
const JUNK = new Set(['mixamorig', 'j', 'bip', 'bip01', 'bip001', 'def', 'org', 'mch', 'b', 'bone', 'c', 'rig', 'cc', 'base', 'jnt', 'joint', 'bn', 'sk', 'char', 'armature']);
const EXCLUDE = /finger|thumb|index|middle|ring|pinky|pinkie|little|toeend|end$|top|tip|nub|twist|roll|ik$|^ik|pole|target|ctrl|control|helper|socket|slot|weapon|eye|jaw|hair|breast|skirt|cape|sec|adj|aim|prop|attach|tongue|teeth|brow|lid|cheek|lip/;

function tokens(name) {
    return sanitize(name).replace(/^mixamorig\d*/i, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2')
        .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function sideOf(toks) {
    for (const t of toks) {
        if (t === 'l' || t === 'left' || /^left/.test(t) || /left$/.test(t)) return 'l';
        if (t === 'r' || t === 'right' || /^right/.test(t) || /right$/.test(t)) return 'r';
    }
    return null;
}

function categoryOf(name) {
    const toks = tokens(name);
    const side = sideOf(toks);
    const core = toks.filter(t => !JUNK.has(t) && !/^\d+$/.test(t) && t !== 'l' && t !== 'r')
        .map(t => t.replace(/^left|^right|left$|right$/g, '')).filter(Boolean).join('');
    if (!core || EXCLUDE.test(core)) return null;
    let cat = null;
    if (/thigh|upleg|upperleg|legupper|femur/.test(core) || (side && /^hip$/.test(core))) cat = 'upperleg';
    else if (/calf|shin|lowerleg|leglower|knee|crus/.test(core)) cat = 'lowerleg';
    else if (/foot|ankle/.test(core)) cat = 'foot';
    else if (/toe|ball/.test(core)) cat = 'toes';
    else if (/forearm|lowerarm|armlower|elbow|radius|ulna/.test(core)) cat = 'lowerarm';
    else if (/upperarm|uparm|armupper|humerus/.test(core)) cat = 'upperarm';
    else if (/shoulder|clavicle|collar/.test(core)) cat = 'shoulder';
    else if (/hand|wrist|fist|palm/.test(core)) cat = 'hand';
    else if (/^leg$/.test(core)) cat = 'leg';
    else if (/^arm$/.test(core)) cat = 'arm';
    else if (/hips?$|pelvis/.test(core) && !side) cat = 'hips';
    else if (/neck/.test(core)) cat = 'neck';
    else if (/head/.test(core)) cat = 'head';
    else if (/spine|abdomen|torso|waist|belly|chest|rib/.test(core)) cat = 'spine';
    if (!cat) return null;
    return { cat, side };
}

function mapGeneric(bones, refRoot) {
    const cand = {};
    for (const b of bones) {
        const c = categoryOf(b.name);
        if (!c) continue;
        let side = c.side;
        if (!side && /arm|leg|hand|foot|toes|shoulder/.test(c.cat)) {
            // No side in the name: decide by position (glTF characters face +Z, so their left is +X).
            const p = modelPos(refRoot, b);
            if (Math.abs(p.x) > 1e-4) side = p.x > 0 ? 'l' : 'r';
        }
        const k = side ? c.cat + side : c.cat;
        (cand[k] ||= []).push(b);
    }
    for (const k in cand) cand[k].sort((a, b) => depth(a) - depth(b));
    const pick = (k, under) => (cand[k] || []).find(b => !under || isAncestor(under, b)) || null;
    const out = {};
    for (const s of ['l', 'r']) {
        // Legs: thigh/upleg, else a plain "leg" with another leg/calf below it.
        let up = pick('upperleg' + s);
        if (!up) up = (cand['leg' + s] || []).find(b => (cand['leg' + s] || []).concat(cand['lowerleg' + s] || []).some(o => isAncestor(b, o))) || null;
        let low = up && (pick('lowerleg' + s, up) || (cand['leg' + s] || []).find(b => isAncestor(up, b)));
        let foot = pick('foot' + s, low || up);
        if (!low && up && foot && foot.parent !== up) low = foot.parent;
        const toes = foot && pick('toes' + s, foot);
        // Arms: upperarm, else a plain "arm" (Mixamo-like LeftArm) that is not a shoulder.
        let ua = pick('upperarm' + s) || (cand['arm' + s] || [])[0] || null;
        let la = ua && pick('lowerarm' + s, ua);
        const hand = pick('hand' + s, la || ua);
        if (!la && ua && hand && hand.parent !== ua) la = hand.parent;
        Object.assign(out, { ['upperleg' + s]: up, ['lowerleg' + s]: low, ['foot' + s]: foot, ['toes' + s]: toes,
            ['upperarm' + s]: ua, ['lowerarm' + s]: la, ['hand' + s]: hand });
    }
    // Torso by topology: chest is where the arms meet, hips where the legs meet.
    const chest = out.upperarml && out.upperarmr ? lca(out.upperarml, out.upperarmr) : null;
    let hips = pick('hips');
    const legsMeet = out.upperlegl && out.upperlegr ? lca(out.upperlegl, out.upperlegr) : null;
    if (!hips || (legsMeet && !(hips === legsMeet || isAncestor(hips, legsMeet))) || (chest && !isAncestor(hips, chest))) hips = legsMeet;
    if (hips && chest && !isAncestor(hips, chest) && hips !== chest) hips = lca(hips, chest);
    if (chest && chest !== hips) {
        out.chest = chest;
        const path = [];
        for (let o = chest.parent; o && o !== hips; o = o.parent) path.unshift(o);
        if (path.length) out.spine = path[0];
    }
    out.hips = hips;
    out.head = pick('head', chest || hips);
    for (const k in out) if (!out[k]) delete out[k];
    return out;
}

// Checks the canonical hierarchy: each bone must sit below its canonical parent (skipping missing ones).
// Hands and feet driven by IK in their source tool are often parented to the rig root instead of the forearm or
// shin (Quaternius RPG characters). They are accepted as "detached": the clip then also positions them.
const DETACHABLE = new Set(['handl', 'handr', 'footl', 'footr']);

function validate(map) {
    repairTorso(map);
    const missing = REQUIRED.filter(c => !map[c]);
    if (!map.spine && !map.chest) missing.push('chest');
    const problems = [];
    const detached = [];
    for (const c of CANONICAL) {
        if (!map[c]) continue;
        let p = PARENT[c];
        while (p && !map[p]) p = PARENT[p];
        if (!p || isAncestor(map[p], map[c])) continue;
        if (DETACHABLE.has(c) && !isAncestor(map[c], map[p]) && map[c] !== map[p]) detached.push(c);
        else problems.push(`${c} is not below ${p}`);
    }
    const used = new Set();
    for (const c of CANONICAL) if (map[c]) { if (used.has(map[c])) problems.push(`${c} reuses a bone`); used.add(map[c]); }
    return { missing, problems, detached, ok: !missing.length && !problems.length };
}

// Rigs whose thighs hang from a "Body" bone next to the bone named Hips (Quaternius RPG): the pelvis is where
// legs and spine meet, and the named hips becomes part of the spine.
function repairTorso(map) {
    const { upperlegl: L, upperlegr: R } = map;
    if (!map.hips || !L || !R || (isAncestor(map.hips, L) && isAncestor(map.hips, R))) return;
    const top = map.chest || map.spine;
    const legs = lca(L, R);
    const pelvis = top ? lca(legs, top) : legs;
    if (!pelvis || pelvis === top || !pelvis.isBone) return;
    if (!map.spine && top && isAncestor(map.hips, top) && isAncestor(pelvis, map.hips)) map.spine = map.hips;
    map.hips = pelvis;
}

// Facing from the mapped bones: returns the quaternion that turns the model to face +Z with Y up.
function facingOf(map, refRoot) {
    const P = c => modelPos(refRoot, map[c]);
    const left = new THREE.Vector3();
    if (map.upperarml && map.upperarmr) left.add(P('upperarml').sub(P('upperarmr')));
    if (map.upperlegl && map.upperlegr) left.add(P('upperlegl').sub(P('upperlegr')));
    const up = map.head && map.hips ? P('head').sub(P('hips')) : new THREE.Vector3(0, 1, 0);
    if (left.lengthSq() < 1e-12 || up.lengthSq() < 1e-12) return { facing: '+z', fix: new THREE.Quaternion() };
    const snap = v => {
        const a = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
        const i = a.indexOf(Math.max(...a));
        const s = new THREE.Vector3();
        s.setComponent(i, Math.sign(v.getComponent(i)));
        return s;
    };
    const u = snap(up);
    const fwd = snap(new THREE.Vector3().crossVectors(left, up));
    if (Math.abs(u.dot(fwd)) > 0.5) return { facing: '+z', fix: new THREE.Quaternion() };
    const l = new THREE.Vector3().crossVectors(u, fwd);
    // Basis (l, u, fwd) in model space -> (x, y, z).
    const m = new THREE.Matrix4().makeBasis(l, u, fwd).transpose();
    const fix = new THREE.Quaternion().setFromRotationMatrix(m);
    const name = u.y > 0.5 ? ({ '0,0,1': '+z', '0,0,-1': '-z', '1,0,0': '+x', '-1,0,0': '-x' })[fwd.toArray().map(Math.round).join(',')] : 'tilted';
    return { facing: name || 'tilted', fix };
}

function analyze(scene, maps, { vrm = null, gltfJson = null, parser = null } = {}) {
    const warnings = [];
    const meshes = skinnedMeshes(scene);
    scene.updateMatrixWorld(true);
    if (!meshes.length) {
        return { type: 'none', confidence: 0, missing: [...REQUIRED], animatable: false, facing: '+z', fix: new THREE.Quaternion(),
            warnings: ['No skinned mesh: the model will stand in a static pose.'], map: {} };
    }
    const bones = skeletonBones(scene);
    const names = new Set(bones.map(b => sanitize(b.name)));
    const tries = [];
    const isVrm = !!(vrm || gltfJson?.extensions?.VRMC_vrm || gltfJson?.extensions?.VRM);
    if (isVrm && maps.vrm) {
        const m = mapVrm(scene, { vrm, gltfJson, parser }, maps.vrm);
        if (m) tries.push({ type: 'vrm', map: m, confidence: 1 });
    }
    if (maps.kaykit && ['root', 'hips', 'handslotr', 'handslotl', 'wristl', 'upperarml'].every(n => names.has(n))) {
        tries.push({ type: 'kaykit', map: mapByNames(bones, maps.kaykit), confidence: 1 });
    }
    for (const t of ['mixamo', 'quaternius']) {
        if (!maps[t]) continue;
        const m = mapByNames(bones, maps[t]);
        const n = Object.keys(m).length;
        if (n) tries.push({ type: t, map: m, confidence: n / CANONICAL.length });
    }
    const g = mapGeneric(bones, scene);
    tries.push({ type: 'generic', map: g, confidence: 0.7 * Object.keys(g).length / CANONICAL.length });
    let best = null;
    for (const t of tries) {
        t.check = validate(t.map);
        if (t.check.ok && (!best || t.confidence > best.confidence)) best = t;
        if (t.type === 'vrm' && t.check.ok) { best = t; break; }
    }
    if (!best) {
        // Report the most complete attempt.
        const top = tries.reduce((a, b) => (Object.keys(b.map).length > Object.keys(a.map).length ? b : a));
        warnings.push(`Could not find a humanoid skeleton (missing: ${top.check.missing.join(', ') || 'none'}${top.check.problems.length ? '; ' + top.check.problems.join('; ') : ''}). The model will stand in a static pose.`);
        return { type: top.type === 'generic' ? 'none' : top.type, confidence: 0, missing: top.check.missing, animatable: false,
            facing: '+z', fix: new THREE.Quaternion(), warnings, map: top.map };
    }
    const { facing, fix } = facingOf(best.map, scene);
    if (facing !== '+z') warnings.push(facing === 'tilted' ? 'The model was lying down or tilted; it is stood up automatically.' : `The model faced ${facing}; it is turned to face +Z.`);
    if (!best.map.spine) warnings.push('No separate spine bone: waist bends are skipped.');
    if (!best.map.toesl || !best.map.toesr) warnings.push('No toe bones: toe motion is skipped.');
    if (best.check.detached.length) warnings.push(`IK-style ${best.check.detached.join(', ')} (not parented to the limb): positioned by the clips.`);
    return { type: best.type, confidence: Math.round(best.confidence * 100) / 100, missing: [], animatable: true, facing, fix, warnings, map: best.map, detached: best.check.detached };
}

// Public: rig check for the cast editor. Accepts a GLTFLoader result (preferred: VRM tables are read from it)
// or any Object3D. Does not modify the model.
export async function detectRig(gltfOrObject, { gltfJson = null, vrm = null, parser = null, maps = null } = {}) {
    const isGltf = !!gltfOrObject?.scene && !gltfOrObject.isObject3D;
    const scene = isGltf ? gltfOrObject.scene : gltfOrObject;
    if (isGltf && gltfOrObject.humanoid) vrm ||= gltfOrObject;   // a three-vrm VRM instance
    else if (isGltf) {
        parser ||= gltfOrObject.parser || null;
        gltfJson ||= parser?.json || null;
        vrm ||= gltfOrObject.userData?.vrm || null;
    }
    const m = maps || await loadRigMaps();
    const r = analyze(scene, m, { vrm, gltfJson, parser });
    const bones = {};
    for (const c of CANONICAL) if (r.map[c]) bones[c] = r.map[c].name;
    return { type: r.type, confidence: r.confidence, missing: r.missing, animatable: r.animatable, facing: r.facing, warnings: r.warnings, bones };
}

// --- bind pose ---------------------------------------------------------------------------------------------

// Puts the mapped humanoid bones back into their bind pose (the pose the mesh was skinned in) when the saved
// node pose differs. In the bind pose boneWorld * boneInverse is the same matrix K for every bone of a skin
// (glTF ignores the mesh node's own transform; GLTFLoader binds with an identity bind matrix). K is taken from
// the skin's top weighted humanoid bone. Other bones (hair, accessories, twist helpers) are left as saved.
function restoreBindPose(scene, mapped) {
    scene.updateMatrixWorld(true);
    const want = new Map();
    const box = new THREE.Box3().setFromObject(scene);
    const size = Math.max(1e-6, box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length());
    const differs = (a, b, s) => {
        for (let j = 0; j < 16; j++) {
            const tol = j >= 12 ? 0.01 * size : 0.02 * s;   // translation vs rotation/scale part
            if (Math.abs(a.elements[j] - b.elements[j]) > tol) return true;
        }
        return false;
    };
    for (const mesh of skinnedMeshes(scene)) {
        const { bones, boneInverses } = mesh.skeleton;
        const used = new Set();
        const si = mesh.geometry?.attributes?.skinIndex, sw = mesh.geometry?.attributes?.skinWeight;
        if (si && sw) for (let v = 0; v < si.count; v++) for (let c = 0; c < 4; c++) if (sw.getComponent(v, c) > 0) used.add(si.getComponent(v, c));
        const idx = [...used].filter(i => bones[i] && mapped.has(bones[i])).sort((i, j) => depth(bones[i]) - depth(bones[j]));
        if (idx.length < 2) continue;
        const K = new THREE.Matrix4().multiplyMatrices(bones[idx[0]].matrixWorld, boneInverses[idx[0]]);
        const s = Math.max(1e-6, K.getMaxScaleOnAxis());
        const P = new THREE.Matrix4();
        for (const i of idx) {
            const b = bones[i];
            if (want.has(b) || !differs(P.multiplyMatrices(b.matrixWorld, boneInverses[i]), K, s)) continue;
            want.set(b, new THREE.Matrix4().multiplyMatrices(K, new THREE.Matrix4().copy(boneInverses[i]).invert()));
        }
    }
    const tmp = new THREE.Matrix4();
    if (!want.size) return [];
    const list = [...want.keys()].sort((a, b) => depth(a) - depth(b));
    const pinv = new THREE.Matrix4();
    for (const b of list) {
        b.parent.updateWorldMatrix(true, false);
        pinv.copy(b.parent.matrixWorld).invert();
        tmp.multiplyMatrices(pinv, want.get(b));
        tmp.decompose(b.position, b.quaternion, b.scale);
        b.updateMatrix();
        b.updateMatrixWorld(true);
    }
    return list.map(b => b.name);
}

// --- prepare -----------------------------------------------------------------------------------------------

const clipCache = new Map();   // rig signature -> Map(clip name -> converted clip)

/**
 * Prepares a loaded model to play our KayKit clips.
 * @param {object} gltf GLTFLoader result (or vrm.js loadVRM result: gltf.userData.vrm), or a bare Object3D
 * @param {object} [_THREE] accepted for the contract; this module imports three itself
 * @param {object} [o]
 * @param {Map<string,THREE.AnimationClip>|THREE.AnimationClip[]} [o.sourceClips] our KayKit clips (live Map is fine)
 */
export async function prepare(gltf, _THREE = null, { sourceClips = null, maps = null } = {}) {
    const m = maps || await loadRigMaps();
    const scene = gltf?.scene || gltf;
    const vrm = gltf?.userData?.vrm || null;
    const gltfJson = gltf?.parser?.json || null;
    const source = sourceClips instanceof Map ? sourceClips
        : new Map((sourceClips || []).map(c => [c.name, c]));
    const warnings = [];

    let a = analyze(scene, m, { vrm, gltfJson, parser: gltf?.parser });
    if (a.animatable) {
        const restored = restoreBindPose(scene, new Set(Object.values(a.map)));
        if (restored.length) {
            a = analyze(scene, m, { vrm, gltfJson, parser: gltf?.parser });
            a.warnings.unshift(`The model was saved posed; ${restored.length} bone(s) were reset to the bind pose (${restored.slice(0, 4).join(', ')}${restored.length > 4 ? ', ...' : ''}).`);
        }
    }
    warnings.push(...a.warnings);
    if (gltf?.animations?.length && a.type !== 'kaykit') warnings.push(`The model's own ${gltf.animations.length} animation(s) are not used; it plays the shared clips.`);

    if (a.type === 'kaykit' && a.animatable) {
        return {
            root: scene, mixerTarget: scene, rigType: 'kaykit', confidence: 1, static: false, warnings, scale: 1,
            hipHeight: m.kaykit.rest.hips.t[1],
            clipMap: name => source.get(name) || null, hasClip: name => source.has(name)
        };
    }

    const root = new THREE.Group();
    root.name = 'retarget-root';
    const fix = new THREE.Group();
    fix.name = 'retarget-facing';
    fix.quaternion.copy(a.fix);
    if (scene.parent) scene.parent.remove(scene);
    root.add(fix);
    fix.add(scene);
    root.updateMatrixWorld(true);

    if (!a.animatable) {
        return { root, mixerTarget: root, rigType: a.type, confidence: 0, static: true, warnings, scale: 1, hipHeight: 0,
            clipMap: () => null, hasClip: () => false };
    }

    const rig = rebind(root, a.map, m.kaykit.rest, a.detached || []);
    const sig = a.type + '|' + rig.signature;
    if (!clipCache.has(sig)) clipCache.set(sig, new Map());
    const cache = clipCache.get(sig);
    const clipMap = name => {
        if (cache.has(name)) return cache.get(name);
        const src = source.get(name);
        if (!src) return null;
        const out = convertClip(src, rig, m.kaykit.rest);
        cache.set(name, out);
        return out;
    };
    return { root, mixerTarget: root, rigType: a.type, confidence: a.confidence, static: false, warnings,
        scale: rig.ratio, hipHeight: rig.hipHeight, clipMap, hasClip: name => source.has(name) };
}

// KayKit rest pose in model space: world matrices of every rig node.
function kaykitWorld(rest) {
    const world = {};
    for (const [n, b] of Object.entries(rest)) {
        const local = new THREE.Matrix4().compose(new THREE.Vector3().fromArray(b.t), new THREE.Quaternion().fromArray(b.r),
            b.s ? new THREE.Vector3().fromArray(b.s) : new THREE.Vector3(1, 1, 1));
        world[n] = b.parent ? new THREE.Matrix4().multiplyMatrices(world[b.parent], local) : local;
    }
    return world;
}

function decompose(m) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return { p, q, s };
}

// Rebinds the target skeleton to KayKit-like bone frames (see header) and renames it. Returns what convertClip needs.
function rebind(root, map, rest, detachedList = []) {
    const K = kaykitWorld(rest);
    const src = Object.fromEntries(Object.keys(K).map(n => [n, decompose(K[n])]));
    root.updateMatrixWorld(true);
    const old = new Map();
    root.traverse(o => old.set(o, o.matrixWorld.clone()));
    const T = Object.fromEntries(Object.entries(map).map(([c, b]) => [c, decompose(old.get(b))]));

    // Scale: target leg length / KayKit leg length.
    const leg = (P, s) => P['upperleg' + s].p.distanceTo(P['lowerleg' + s].p) + P['lowerleg' + s].p.distanceTo(P['foot' + s].p);
    const ratio = (leg(T, 'l') + leg(T, 'r')) / (leg(src, 'l') + leg(src, 'r'));
    const ground = Math.min(T.footl.p.y, T.footr.p.y) - Math.min(src.footl.p.y, src.footr.p.y) * ratio;

    // Alignment of limbs to the KayKit rest directions.
    const align = {};
    for (const c of CANONICAL) {
        if (!map[c]) continue;
        const child = ALIGN[c];
        if (child && map[child]) {
            const vt = T[child].p.clone().sub(T[c].p).normalize();
            const vs = src[child].p.clone().sub(src[c].p).normalize();
            align[c] = new THREE.Quaternion().setFromUnitVectors(vt, vs);
        } else align[c] = (INHERIT[c] && align[INHERIT[c]]) ? align[INHERIT[c]].clone() : new THREE.Quaternion();
    }

    // New world matrices for mapped bones: position kept, rotation = align^-1 * KayKit rest, uniform scale = ratio.
    const neu = new Map();
    const S = new THREE.Vector3(ratio, ratio, ratio);
    for (const c of CANONICAL) {
        if (!map[c]) continue;
        const q = align[c].clone().invert().multiply(src[c].q);
        neu.set(map[c], new THREE.Matrix4().compose(T[c].p, q, S));
    }

    // Bone inverses: keep each mesh vertex where it is (W_new * inv_new = W_old * inv_old).
    const tmp = new THREE.Matrix4();
    const done = new Set();
    root.traverse(o => {
        if (!o.isSkinnedMesh || !o.skeleton || done.has(o.skeleton)) return;
        done.add(o.skeleton);
        o.skeleton.bones.forEach((b, i) => {
            if (!neu.has(b)) return;
            tmp.copy(neu.get(b)).invert().multiply(old.get(b)).multiply(o.skeleton.boneInverses[i]);
            o.skeleton.boneInverses[i].copy(tmp);
        });
    });

    // New locals for the whole model, parent-first (unmapped nodes keep their world transform).
    const top = root;
    const pinv = new THREE.Matrix4();
    const visit = o => {
        for (const ch of o.children) {
            const w = neu.get(ch) || old.get(ch);
            o.updateWorldMatrix(false, false);
            pinv.copy(o.matrixWorld).invert();
            tmp.multiplyMatrices(pinv, w);
            tmp.decompose(ch.position, ch.quaternion, ch.scale);
            ch.updateMatrix();   // also for nodes with matrixAutoUpdate off (three-vrm spring joints)
            ch.updateMatrixWorld(false);
            ch.matrixWorld.copy(w);
            visit(ch);
        }
    };
    top.updateMatrixWorld(true);
    visit(top);
    root.updateMatrixWorld(true);

    // Rename: free the canonical names, then name mapped bones like KayKit's sanitized bones.
    const reserved = new Set([...CANONICAL, ...Object.keys(SLOTS), 'root']);
    const mapped = new Set(Object.values(map));
    root.traverse(o => { if (!mapped.has(o) && reserved.has(sanitize(o.name))) o.name = sanitize(o.name) + '_orig'; });
    for (const c of CANONICAL) if (map[c]) map[c].name = c;

    // Sockets for props: same transform relative to the hand frame as KayKit's handslot (hand frame is now KayKit-like).
    const nodes = { ...map };
    for (const [slot, hand] of Object.entries(SLOTS)) {
        const b = new THREE.Bone();
        b.name = slot;
        b.position.fromArray(rest[slot].t);
        b.quaternion.fromArray(rest[slot].r);
        // KayKit hand joint sits 0.074 past the wrist; target hand joints usually are the wrist itself.
        const wristToHand = src[hand].p.clone().sub(src['wrist' + hand.slice(-1)].p).applyQuaternion(src[hand].q.clone().invert());
        b.position.add(wristToHand);
        nodes[hand].add(b);
        nodes[slot] = b;
    }
    root.updateMatrixWorld(true);

    // Per-bone solve data, parent-first: nearest mapped ancestor and the rest rotation of the real parent relative to it.
    const order = [...CANONICAL.filter(c => map[c]), ...Object.keys(SLOTS)];
    const entries = [];
    const worldQ = o => o.getWorldQuaternion(new THREE.Quaternion());
    for (const c of order) {
        const bone = nodes[c];
        let anc = null;
        for (let o = bone.parent; o && o !== root; o = o.parent) {
            const hit = order.find(k => nodes[k] === o);
            if (hit) { anc = hit; break; }
        }
        const parentQ = worldQ(bone.parent);
        const rel = anc ? worldQ(nodes[anc]).invert().multiply(parentQ) : parentQ;
        entries.push({ c, src: c, anc, rel });
    }
    const hips = nodes.hips;
    const hipsParentInv = hips.parent.matrixWorld.clone().invert();
    const hipsPos = hips.getWorldPosition(new THREE.Vector3());
    // Hip translation follows the thigh joints, not the hips joint: KayKit's hips joint sits below its thighs,
    // others sit at or above them. The midpoint of the thighs moves like KayKit's, scaled by the leg ratio.
    const mid = (P) => P.upperlegl.p.clone().add(P.upperlegr.p).multiplyScalar(0.5);
    const legMid = mid(T), legMidSrc = mid(src);
    const hipsQ = hips.getWorldQuaternion(new THREE.Quaternion());
    const legOffset = legMid.clone().sub(hipsPos).applyQuaternion(hipsQ.invert());   // in the hips frame (unit scale)
    const r4 = x => Math.round(x * 1e4) / 1e4;
    const signature = entries.map(e => `${e.c}:${e.anc}:${e.rel.toArray().map(r4)}`).join(';') +
        `|${r4(ratio)}|${legOffset.toArray().map(r4)}|${hipsPos.toArray().map(r4)}|${hipsParentInv.elements.map(r4)}`;
    // Detached hands/feet: rest transform relative to their canonical parent (lower arm / shin), in rebound frames.
    const detached = detachedList.map(c => {
        let p = PARENT[c];
        while (p && !map[p]) p = PARENT[p];
        return { c, parent: nodes[p], offset: nodes[p].matrixWorld.clone().invert().multiply(nodes[c].matrixWorld) };
    });
    // Rest pose bookkeeping for convertClip, which poses the proto temporarily to measure floor contact.
    const restLocal = order.map(c => [nodes[c], nodes[c].position.clone(), nodes[c].quaternion.clone()]);
    const restore = () => {
        for (const [b, p, q] of restLocal) { b.position.copy(p); b.quaternion.copy(q); }
        root.updateMatrixWorld(true);
    };
    const rootInv = root.matrixWorld.clone().invert();
    const lowest = (pos) => Math.min(...CONTACTS.filter(c => nodes[c] && rest[c]).map(pos));
    // Floor = lowest skinned vertex at rest; leg data for the lifting IK; KayKit torso height for "lying".
    let floor = Infinity;
    const vtx = new THREE.Vector3();
    root.traverse(o => {
        if (!o.isSkinnedMesh) return;
        const n = o.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 4000));
        for (let k = 0; k < n; k += step) { o.getVertexPosition(k, vtx); floor = Math.min(floor, vtx.applyMatrix4(o.matrixWorld).applyMatrix4(rootInv).y); }
    });
    if (!Number.isFinite(floor)) floor = ground;
    // A mesh that does not reach the feet (or a test fixture) must not put the floor above the ankles and toes.
    for (const c of ['footl', 'footr', 'toesl', 'toesr']) if (nodes[c]) floor = Math.min(floor, nodes[c].getWorldPosition(vtx).applyMatrix4(rootInv).y);
    const box = new THREE.Box3();
    root.traverse(o => { if (o.isSkinnedMesh) box.union(new THREE.Box3().setFromObject(o).applyMatrix4(rootInv)); });
    const bodyRatio = box.isEmpty() ? ratio : (box.max.y - floor) / KAYKIT_HEIGHT;
    const entryOf = c => entries.findIndex(e => e.c === c);
    const legs = ['l', 'r'].filter(sd => nodes['upperleg' + sd] && nodes['lowerleg' + sd] && nodes['foot' + sd]).map(sd => ({
        bones: [nodes['upperleg' + sd], nodes['lowerleg' + sd], nodes['foot' + sd]],
        clear: nodes['foot' + sd].getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv).y - floor,
        thighEntry: entryOf('upperleg' + sd), shinEntry: entryOf('lowerleg' + sd), footEntry: entryOf('foot' + sd)
    }));
    const srcTorso = (src.chest ? src.chest.p.y : src.head.p.y) - src.hips.p.y;
    const restLow = {
        src: lowest(c => src[c].p.y),
        tgt: lowest(c => nodes[c].getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv).y)
    };
    const sig = signature + '|' + r4(floor) + '|' + r4(bodyRatio) + '|' + detachedList.join(',') + '|' + CONTACTS.filter(c => nodes[c]).map(c => nodes[c].getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv).toArray().map(r4)).join(';');
    return { entries, nodes, root, restore, restLow, detached, floor, legs, srcTorso, bodyRatio, ratio, legMid, legMidSrc, legOffset, hipsParentInv, hipsPos,
        hipHeight: hipsPos.y - ground, ground, signature: sig };
}

// Joints that can touch the floor; KayKit's lowest one keeps the same (scaled) clearance on the target.
const CONTACTS = ['hips', 'head', 'handl', 'handr', 'lowerlegl', 'lowerlegr', 'footl', 'footr', 'toesl', 'toesr'];
const TORSO = ['hips', 'chest', 'head'];
const KAYKIT_HEIGHT = 2.2;   // a KayKit character is about 2.2 model units tall

// Two-bone IK that only lifts, active in clips where the KayKit body ends up lying (deaths): ankle and knee stay
// above the floor, and while lying they also keep the ankle's rest clearance (scaled by the lying weight). The thigh and shin turn
// in their bend plane, the knee then swings about the hip-ankle axis if it would go under the floor, and the foot
// keeps its world rotation.
const _ik = { H: new THREE.Vector3(), K: new THREE.Vector3(), A: new THREE.Vector3(), T: new THREE.Vector3(), n: new THREE.Vector3(),
    d: new THREE.Vector3(), q: new THREE.Quaternion(), qf: new THREE.Quaternion(), pq: new THREE.Quaternion(), u: new THREE.Vector3() };
function liftFoot(rig, leg, rootInv, outQ, prev, i, refresh, weight, falling) {
    const { H, K, A, T, n, d, q, qf, pq, u } = _ik;
    const [thigh, shin, foot] = leg.bones;
    const pos = (o, out) => out.setFromMatrixPosition(o.matrixWorld).applyMatrix4(rootInv);
    pos(foot, A); pos(thigh, H); pos(shin, K);
    const eps = 1e-4 * rig.ratio;
    if (!falling) return;
    const ankleMin = rig.floor + leg.clear * weight, kneeMin = ankleMin;
    if (A.y >= ankleMin - eps && K.y >= kneeMin - eps) return;
    T.copy(A).setY(Math.max(A.y, ankleMin));
    const a = H.distanceTo(K), b = K.distanceTo(A);
    let dist = H.distanceTo(T);
    dist = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, dist));
    // Hinge: the leg's current bend plane, so small lifts make small changes; a nearly straight leg uses the thigh's
    // X axis instead (bone frames are KayKit's after rebinding, where X is the knee axis).
    n.subVectors(A, H).cross(u.subVectors(K, H));
    if (n.lengthSq() < 1e-6 * a * a * b * b) {
        thigh.getWorldQuaternion(q);
        n.set(1, 0, 0).applyQuaternion(q);
    }
    n.normalize();
    const alpha = Math.acos(Math.min(1, Math.max(-1, (a * a + dist * dist - b * b) / (2 * a * dist))));
    d.subVectors(T, H).normalize();
    // Of the two knee solutions keep the one nearer the current knee (no flipping).
    const c1 = d.clone().applyAxisAngle(n, alpha), c2 = d.clone().applyAxisAngle(n, -alpha);
    const kd = u.subVectors(K, H).normalize();
    const newThighDir = (c1.dot(kd) >= c2.dot(kd) ? c1 : c2).clone();
    // Knee circle about the hip-ankle axis: centre C, radius r; swing the knee up just enough to clear the floor.
    const C = H.clone().addScaledVector(d, a * Math.cos(alpha)), r = a * Math.sin(alpha);
    if (r > eps) {
        const e1 = H.clone().addScaledVector(newThighDir, a).sub(C).normalize();
        const e2 = d.clone().cross(e1);
        const R = Math.hypot(e1.y, e2.y);
        if (C.y + r * e1.y < kneeMin && R > 1e-6) {
            const phi = Math.atan2(e2.y, e1.y);
            const c = (kneeMin - C.y) / (r * R);
            let theta = phi;   // highest knee when the floor cannot be cleared
            if (c <= 1) {
                const w = Math.acos(Math.max(-1, c));
                const wrap = x => Math.atan2(Math.sin(x), Math.cos(x));
                const lo = wrap(phi - w), hi = wrap(phi + w);
                theta = Math.abs(lo) < Math.abs(hi) ? lo : hi;   // smallest swing into the allowed arc
            }
            const k = C.clone().addScaledVector(e1, r * Math.cos(theta)).addScaledVector(e2, r * Math.sin(theta));
            newThighDir.copy(k.sub(H).normalize());
        }
    }
    foot.getWorldQuaternion(qf);
    const turn = (bone, from, to) => {
        bone.getWorldQuaternion(q);
        q.premultiply(pq.setFromUnitVectors(from, to));
        bone.parent.getWorldQuaternion(pq);
        bone.quaternion.copy(pq.invert().multiply(q));
        bone.updateMatrixWorld(true);
    };
    turn(thigh, K.clone().sub(H).normalize(), newThighDir.clone());
    refresh();
    pos(shin, K); pos(foot, A);
    turn(shin, A.clone().sub(K).normalize(), T.clone().sub(K).normalize());
    refresh();
    // Foot keeps its world rotation (when it hangs below the shin).
    if (leg.footEntry >= 0) {
        foot.parent.getWorldQuaternion(pq);
        foot.quaternion.copy(pq.invert().multiply(qf));
        foot.updateMatrixWorld(true);
    }
    for (const [bone, k] of [[thigh, leg.thighEntry], [shin, leg.shinEntry], [foot, leg.footEntry]]) {
        if (k < 0) continue;
        q.copy(bone.quaternion);
        if (i && q.dot(prev[k]) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prev[k].copy(q);
        q.toArray(outQ[k], i * 4);
    }
}

// Converts one KayKit clip for a rebound rig: forward kinematics on the KayKit rest pose, then per-bone local solve.
// Hips translation: the thigh midpoint follows KayKit's (scaled by the leg ratio), then a vertical correction keeps
// floor contact like KayKit's (feet when standing, torso when lying, with leg IK), so chibi vs realistic
// proportions neither sink a body into the board nor leave it hovering when it falls.
function convertClip(clip, rig, rest) {
    const names = Object.keys(rest);
    const qTrack = new Map(), pTrack = new Map();
    for (const t of clip.tracks) {
        const dot = t.name.lastIndexOf('.');
        const node = t.name.slice(0, dot), prop = t.name.slice(dot + 1);
        if (!rest[node]) continue;
        if (prop === 'quaternion') qTrack.set(node, t);
        else if (prop === 'position' && (node === 'hips' || node === 'root')) pTrack.set(node, t);
    }
    const timeSet = new Set();
    for (const t of [...qTrack.values(), ...pTrack.values()]) for (const x of t.times) timeSet.add(Math.round(x * 1e5) / 1e5);
    if (!timeSet.size) timeSet.add(0);
    const times = [...timeSet].sort((a, b) => a - b);
    const interp = new Map();
    for (const [n, t] of qTrack) interp.set(n + '.q', t.createInterpolant());
    for (const [n, t] of pTrack) interp.set(n + '.p', t.createInterpolant());

    const restQ = Object.fromEntries(names.map(n => [n, new THREE.Quaternion().fromArray(rest[n].r)]));
    const restT = Object.fromEntries(names.map(n => [n, new THREE.Vector3().fromArray(rest[n].t)]));
    const contacts = CONTACTS.filter(c => rig.nodes[c] && rest[c]);

    const outQ = rig.entries.map(() => new Float32Array(times.length * 4));
    const outP = new Float32Array(times.length * 3);
    const outD = rig.detached.map(() => new Float32Array(times.length * 3));
    const M = new THREE.Matrix4(), dq = new THREE.Quaternion(), ds = new THREE.Vector3();
    const wq = {}, wp = {}, lq = new THREE.Quaternion(), tq = new THREE.Quaternion();
    const prev = rig.entries.map(() => new THREE.Quaternion());
    const tw = {};
    const P = new THREE.Vector3(), v = new THREE.Vector3(), off = new THREE.Vector3(), mid = new THREE.Vector3();
    const rootInv = rig.root.matrixWorld.clone().invert();
    let low0 = null;
    try {
        // KayKit forward kinematics (rotations and positions in model space).
        const fk = time => {
            for (const n of names) {
                const ip = interp.get(n + '.q');
                if (ip) lq.fromArray(ip.evaluate(time)).normalize(); else lq.copy(restQ[n]);
                const p = rest[n].parent;
                const ipp = (n === 'hips' || n === 'root') ? interp.get(n + '.p') : null;
                const t = ipp ? v.fromArray(ipp.evaluate(time)) : restT[n];
                wq[n] = (wq[n] || new THREE.Quaternion()).copy(p ? wq[p] : new THREE.Quaternion()).multiply(lq);
                wp[n] = (wp[n] || new THREE.Vector3()).copy(t);
                if (p) wp[n].applyQuaternion(wq[p]).add(wp[p]);
            }
            return ((wp.chest || wp.head).y - wp.hips.y) / rig.srcTorso;
        };
        // Clips where the body ends up lying (deaths) keep knees and ankles above the floor on every frame;
        // other clips (walks, attacks) never run the leg IK.
        const fallingClip = times.some(t => fk(t) < 0.65);
        times.forEach((time, i) => {
            const upright = fk(time);
            rig.entries.forEach((e, k) => {
                // Target world rotation = KayKit world rotation of the same bone; parent world from the mapped ancestor.
                tw[e.c] = wq[e.src];
                tq.copy(e.anc ? tw[e.anc] : new THREE.Quaternion()).multiply(e.rel).invert().multiply(wq[e.src]);
                if (i && tq.dot(prev[k]) < 0) tq.set(-tq.x, -tq.y, -tq.z, -tq.w);
                prev[k].copy(tq);
                tq.toArray(outQ[k], i * 4);
                rig.nodes[e.c].quaternion.copy(tq);
            });
            // KayKit thigh midpoint -> target thigh midpoint -> target hips joint (rotated with the hips).
            P.copy(mid.copy(wp.upperlegl).add(wp.upperlegr).multiplyScalar(0.5))
                .sub(rig.legMidSrc).multiplyScalar(rig.ratio).add(rig.legMid)
                .sub(off.copy(rig.legOffset).applyQuaternion(wq.hips));
            // Detached hands/feet follow their limb: world = limb world * rest offset.
            const placeDetached = out => rig.detached.forEach((d, k) => {
                const b = rig.nodes[d.c];
                M.multiplyMatrices(d.parent.matrixWorld, d.offset).premultiply(b.parent.matrixWorld.clone().invert());
                M.decompose(v, dq, ds);
                b.position.copy(v);
                if (out) v.toArray(outD[k], i * 3);
            });
            if (contacts.length || rig.detached.length) {
                rig.nodes.hips.position.copy(v.copy(P).applyMatrix4(rig.hipsParentInv));
                rig.root.updateMatrixWorld(true);
                if (rig.detached.length) { placeDetached(false); rig.root.updateMatrixWorld(true); }
                if (!low0) low0 = rig.restLow;
                const height = c => v.setFromMatrixPosition(rig.nodes[c].matrixWorld).applyMatrix4(rootInv).y;
                // Standing: the joint that is lowest on KayKit (usually a foot) keeps its scaled clearance relative
                // to rest. Lying (KayKit torso near horizontal): the lowest torso joint gets KayKit's scaled height
                // above the floor instead, so long-legged bodies lie down rather than resting on their heels; the
                // legs are then bent by two-bone IK below so the feet stay above the floor.
                let ls = Infinity, low = null;
                for (const c of contacts) if (wp[c].y < ls) { ls = wp[c].y; low = c; }
                let dy = contacts.length ? (ls - low0.src) * rig.ratio - (height(low) - low0.tgt) : 0;
                const lying = Math.min(1, Math.max(0, (0.65 - upright) / 0.2));
                if (lying > 0) {
                    let lsT = Infinity, lowT = null;
                    for (const c of TORSO) if (rig.nodes[c] && wp[c].y < lsT) { lsT = wp[c].y; lowT = c; }
                    // Lying height scales with body size (KayKit is ~2.2 units tall), not with leg length.
                    const dyT = lsT * rig.bodyRatio + rig.floor - height(lowT);
                    dy += (dyT - dy) * lying;
                }
                P.y += dy;
                rig.nodes.hips.position.copy(v.copy(P).applyMatrix4(rig.hipsParentInv));
                rig.root.updateMatrixWorld(true);
                const refresh = () => { if (rig.detached.length) { placeDetached(false); rig.root.updateMatrixWorld(true); } };
                refresh();
                for (const leg of rig.legs) liftFoot(rig, leg, rootInv, outQ, prev, i, refresh, lying, fallingClip);
                if (rig.detached.length) placeDetached(true);
            }
            v.copy(P).applyMatrix4(rig.hipsParentInv).toArray(outP, i * 3);
        });
    } finally {
        rig.restore();
    }
    const tracks = rig.entries.map((e, k) => new THREE.QuaternionKeyframeTrack(`${e.c}.quaternion`, times, outQ[k]));
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', times, outP));
    rig.detached.forEach((d, k) => tracks.push(new THREE.VectorKeyframeTrack(`${d.c}.position`, times, outD[k])));
    const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
    out.userData = { ...(clip.userData || {}), retargeted: true };
    return out;
}
