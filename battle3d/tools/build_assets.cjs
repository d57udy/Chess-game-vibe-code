// Builds the optimized battle3d assets from the raw KayKit GLBs.
//
// Needs the glTF-Transform packages, meshoptimizer and gl-matrix installed somewhere outside the repo:
//   mkdir /tmp/b3d-tools && cd /tmp/b3d-tools
//   npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions meshoptimizer gl-matrix gltf-validator three@0.186.1
//   NODE_PATH=/tmp/b3d-tools/node_modules node battle3d/tools/build_assets.cjs        (MESHOPT=0 to skip compression)
// Then validate: NODE_PATH=... node battle3d/tools/validate_assets.mjs
// Outputs: assets/characters/*.glb, assets/anims/clips.glb, assets/anims/clips_skeleton.glb, assets/props/*,
// and the computed parts of assets/manifest.json (casting comes from casting.cjs).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { NodeIO, Document, Logger } = require('@gltf-transform/core');
const { prune, dedup, resample, meshopt } = require('@gltf-transform/functions');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptEncoder, MeshoptDecoder } = require('meshoptimizer');
const { vec3 } = require('gl-matrix');
const fk = require('./kaykit_fk.cjs');
const casting = require('./casting.cjs');

const ASSETS = path.join(__dirname, '..', 'assets');
const RAW = path.join(ASSETS, 'raw');
const HEROES = ['Knight', 'Barbarian', 'Mage', 'Rogue', 'Rogue_Hooded'];
const SKELETONS = ['Skeleton_Minion', 'Skeleton_Warrior', 'Skeleton_Mage', 'Skeleton_Rogue'];
const CHARACTERS = [...HEROES, ...SKELETONS];

// Shared clips (hero files all carry identical data for these). Spawn_* only exist in the skeleton files.
const SHARED_CLIPS = [
  'Idle', '2H_Melee_Idle', 'Unarmed_Idle',
  'Walking_A', 'Walking_B', 'Walking_C', 'Walking_Backwards', 'Running_A', 'Running_B',
  'Jump_Full_Long', 'Jump_Full_Short', 'Jump_Start', 'Jump_Idle', 'Jump_Land',
  '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal', '1H_Melee_Attack_Stab',
  '2H_Melee_Attack_Chop', '2H_Melee_Attack_Slice', '2H_Melee_Attack_Spin', '2H_Melee_Attack_Spinning', '2H_Melee_Attack_Stab',
  'Dualwield_Melee_Attack_Chop', 'Dualwield_Melee_Attack_Slice', 'Dualwield_Melee_Attack_Stab',
  'Unarmed_Melee_Attack_Kick', 'Unarmed_Melee_Attack_Punch_A', 'Unarmed_Melee_Attack_Punch_B',
  'Spellcast_Long', 'Spellcast_Raise', 'Spellcast_Shoot', 'Spellcasting', 'Throw',
  'Block', 'Block_Attack', 'Block_Hit', 'Blocking', 'Hit_A', 'Hit_B',
  'Dodge_Backward', 'Dodge_Forward', 'Dodge_Left', 'Dodge_Right',
  'Death_A', 'Death_A_Pose', 'Death_B', 'Death_B_Pose', 'Cheer',
  'Interact', 'PickUp', 'Use_Item', 'T-Pose',
];
const SHARED_FROM_SKELETON = ['Spawn_Air', 'Spawn_Ground'];
const SKELETON_CLIPS = [
  'Death_C_Skeletons', 'Spawn_Ground_Skeletons', 'Skeletons_Awaken_Standing', 'Walking_D_Skeletons',
  'Idle_B', 'Idle_Combat', 'Taunt', 'Taunt_Longer', '1H_Melee_Attack_Jump_Chop', 'Spellcast_Summon',
];

// How to find the hit moment. 'swing': weapon tip speed peak; 'hands'/'limbs': fastest of several effectors;
// 'cast': max hand distance from the chest.
const TIP = [0, 0.7, 0]; // weapons point along handslot local +Y
const EFFECTORS = {
  R: ['handslot.r', TIP], L: ['handslot.l', TIP],
  handR: ['hand.r', [0, 0, 0]], handL: ['hand.l', [0, 0, 0]],
  footR: ['toes.r', [0, 0, 0]], footL: ['toes.l', [0, 0, 0]],
};
function impactRule(clip) {
  if (clip.startsWith('Spellcast')) return { mode: 'cast', effectors: ['handR', 'handL'] };
  if (clip.startsWith('Dualwield')) return { mode: 'swing', effectors: ['R', 'L'] };
  if (clip === 'Unarmed_Melee_Attack_Kick') return { mode: 'swing', effectors: ['footR', 'footL'] };
  if (clip.startsWith('Unarmed_Melee_Attack_Punch')) return { mode: 'swing', effectors: ['handR', 'handL'] };
  if (clip === 'Block_Attack') return { mode: 'swing', effectors: ['R', 'L'] };
  return { mode: 'swing', effectors: ['R'] };
}
const ATTACK_CLIPS = [...SHARED_CLIPS, ...SKELETON_CLIPS].filter(c =>
  /Attack|^Spellcast|^Throw$/.test(c) && c !== '2H_Melee_Attack_Spinning');

const MESHOPT = process.env.MESHOPT !== '0';
const logger = new Logger(Logger.Verbosity.ERROR);
const io = new NodeIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const compress = () => MESHOPT ? [meshopt({ encoder: MeshoptEncoder, level: 'medium' })] : [];
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const fileSize = f => fs.statSync(f).size;

async function stripCharacter(name) {
  const doc = await io.read(path.join(RAW, `${name}.glb`));
  for (const a of doc.getRoot().listAnimations()) {
    for (const ch of a.listChannels()) ch.dispose();
    for (const s of a.listSamplers()) {
      for (const acc of [s.getInput(), s.getOutput()]) if (acc && !acc.isDisposed()) acc.dispose();
      s.dispose();
    }
    a.dispose();
  }
  // Skinned meshes sit under the identity "Rig" node; move them to the scene root (validator warning, no visual change).
  const scene = doc.getRoot().listScenes()[0];
  for (const n of doc.getRoot().listNodes()) {
    const parent = n.getParentNode();
    if (n.getSkin() && parent) { parent.removeChild(n); scene.addChild(n); }
  }
  await doc.transform(prune(), dedup(), ...compress());
  const out = path.join(ASSETS, 'characters', `${name}.glb`);
  await io.write(out, doc);
  return out;
}

// Bones whose tracks matter: weighted joints, their ancestors, and the hand slots that carry weapons.
function usefulBones(doc) {
  const skin = doc.getRoot().listSkins()[0];
  const joints = skin.listJoints();
  const keep = new Set(['handslot.l', 'handslot.r']);
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getSkin()) continue;
    for (const p of n.getMesh().listPrimitives()) {
      const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0');
      const j = [], w = [];
      for (let i = 0; i < J.getCount(); i++) {
        J.getElement(i, j); W.getElement(i, w);
        for (let k = 0; k < 4; k++) if (w[k] > 0) keep.add(joints[j[k]].getName());
      }
    }
  }
  const parentOf = new Map();
  for (const n of doc.getRoot().listNodes()) for (const c of n.listChildren()) parentOf.set(c.getName(), n);
  for (const name of [...keep]) {
    let p = parentOf.get(name);
    while (p && joints.includes(p)) { keep.add(p.getName()); p = parentOf.get(p.getName()); }
  }
  return keep;
}

// A track can be dropped if it never moves and equals the rest value of that node on every character.
function trackIsRestEverywhere(arr, size, path, nodeName, rests) {
  const tol = path === 'rotation' ? 1e-4 : 1e-4;
  const v0 = arr.slice(0, size);
  for (let i = size; i < arr.length; i += size) for (let k = 0; k < size; k++) if (Math.abs(arr[i + k] - v0[k]) > tol) return false;
  const key = { translation: 't', rotation: 'r', scale: 's' }[path];
  for (const rest of rests) {
    const r = rest.get(nodeName);
    if (!r) return false;
    let d = 0, dneg = 0;
    for (let k = 0; k < size; k++) { d = Math.max(d, Math.abs(r[key][k] - v0[k])); dneg = Math.max(dneg, Math.abs(r[key][k] + v0[k])); }
    if (Math.min(d, path === 'rotation' ? dneg : d) > tol * 10) return false;
  }
  return true;
}

// New document with just the rig hierarchy (named like the characters) plus the chosen clips.
function buildClipDoc(rigDoc, sources, keepBones, rests) {
  const doc = new Document().setLogger(logger);
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const byName = new Map();
  const copyNode = (src) => {
    const name = src.getName();
    const isBone = keepBones.has(name) || name === 'Rig';
    if (!isBone) return null;
    const n = doc.createNode(name).setTranslation(src.getTranslation()).setRotation(src.getRotation()).setScale(src.getScale());
    byName.set(name, n);
    for (const c of src.listChildren()) { const cc = copyNode(c); if (cc) n.addChild(cc); }
    return n;
  };
  for (const n of rigDoc.getRoot().listScenes()[0].listChildren()) { const c = copyNode(n); if (c) scene.addChild(c); }

  const stats = { kept: 0, dropped: 0 };
  for (const { doc: srcDoc, clips } of sources) {
    for (const clipName of clips) {
      const src = srcDoc.getRoot().listAnimations().find(a => a.getName() === clipName);
      if (!src) throw new Error(`missing clip ${clipName}`);
      const anim = doc.createAnimation(clipName);
      const duration = fk.clipDuration(src);
      for (const ch of src.listChannels()) {
        const nodeName = ch.getTargetNode().getName();
        const target = byName.get(nodeName);
        const p = ch.getTargetPath();
        const s = ch.getSampler();
        const size = p === 'rotation' ? 4 : 3;
        if (!target || trackIsRestEverywhere(s.getOutput().getArray(), size, p, nodeName, rests)) { stats.dropped++; continue; }
        stats.kept++;
        const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(s.getInput().getArray())).setBuffer(buffer);
        const output = doc.createAccessor().setType(size === 4 ? 'VEC4' : 'VEC3').setArray(new Float32Array(s.getOutput().getArray())).setBuffer(buffer);
        const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(s.getInterpolation());
        anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(p).setSampler(sampler));
      }
      // Keep the authored duration even if trailing keys were constant: anchor one track to the full length.
      if (anim.listChannels().length === 0) {
        const hips = byName.get('hips');
        const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0])).setBuffer(buffer);
        const output = doc.createAccessor().setType('VEC4').setArray(new Float32Array(rests[0].get('hips').r)).setBuffer(buffer);
        const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
        anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(hips).setTargetPath('rotation').setSampler(sampler));
      }
      anim.setExtras({ duration });
    }
  }
  return { doc, stats };
}

function durationsOf(doc) {
  const out = {};
  for (const a of doc.getRoot().listAnimations()) out[a.getName()] = round(fk.clipDuration(a), 3);
  return out;
}

function computeImpact(doc, rest, anim) {
  const rule = impactRule(anim.getName());
  const tracks = fk.clipTracks(anim);
  const d = fk.clipDuration(anim);
  const dt = 1 / 120;
  const samples = [];
  for (let t = 0; t <= d + 1e-9; t += dt) {
    const W = fk.worldMatrices(doc, rest, tracks, t);
    const pts = {};
    for (const e of rule.effectors) pts[e] = fk.pointOn(W.get(EFFECTORS[e][0]), EFFECTORS[e][1]);
    samples.push({ t, pts, chest: fk.pointOn(W.get('chest')) });
  }
  let best = { score: -1, i: 0, eff: null };
  if (rule.mode === 'cast') {
    for (let i = 0; i < samples.length; i++) for (const e of rule.effectors) {
      const ext = vec3.distance(samples[i].pts[e], samples[i].chest);
      if (ext > best.score) best = { score: ext, i, eff: e };
    }
    return { time: round(samples[best.i].t, 3), effector: EFFECTORS[best.eff][0], mode: 'max hand extension', peak: round(best.score) };
  }
  const speed = (i, e) => vec3.distance(samples[i].pts[e], samples[i - 1].pts[e]) / dt;
  // Only count the swing while the effector is in front of the body (+Z), so spins and wind-ups
  // behind the back do not win.
  const front = (i, e) => samples[i].pts[e][2] - samples[i].chest[2] > 0.25 ? 1 : 0.3;
  for (let i = 1; i < samples.length; i++) for (const e of rule.effectors) {
    const v = speed(i, e) * front(i, e);
    if (v > best.score) best = { score: v, i, eff: e };
  }
  // Contact = halfway between the speed peak and the end of the swing (speed below 35% of peak).
  let end = best.i;
  while (end + 1 < samples.length && speed(end + 1, best.eff) * front(end + 1, best.eff) > 0.35 * best.score) end++;
  const tPeak = samples[best.i].t - dt / 2;
  const tEnd = samples[end].t;
  return { time: round((tPeak + tEnd) / 2, 3), peakTime: round(tPeak, 3), effector: EFFECTORS[best.eff][0], mode: 'peak speed', peak: round(best.score, 2) };
}

function bindBounds(doc) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const n of doc.getRoot().listNodes()) {
    if (!n.getSkin()) continue;
    for (const p of n.getMesh().listPrimitives()) {
      const P = p.getAttribute('POSITION');
      const lo = P.getMin([]), hi = P.getMax([]);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], lo[k]); max[k] = Math.max(max[k], hi[k]); }
    }
  }
  return { min: min.map(v => round(v)), max: max.map(v => round(v)), height: round(max[1] - min[1]) };
}

async function main() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  for (const d of ['characters', 'anims', 'props']) fs.mkdirSync(path.join(ASSETS, d), { recursive: true });
  const raw = {};
  for (const c of CHARACTERS) raw[c] = await io.read(path.join(RAW, `${c}.glb`));
  const rests = CHARACTERS.map(c => fk.restPose(raw[c]));

  // 1. Characters without animations.
  const sizes = {};
  const models = {};
  for (const c of CHARACTERS) {
    const out = await stripCharacter(c);
    sizes[`characters/${c}.glb`] = fileSize(out);
    const accessories = raw[c].getRoot().listNodes().filter(n => n.getMesh() && !n.getSkin())
      .map(n => ({ name: n.getName(), bone: n.getParentNode().getName() }));
    models[c] = { bind: bindBounds(raw[c]), accessories };
  }
  // Mounts of the embedded hero weapons (used to place standalone props on any character).
  const mounts = {};
  for (const c of HEROES) for (const n of raw[c].getRoot().listNodes()) {
    const parent = n.getParentNode();
    if (n.getMesh() && !n.getSkin() && parent && /^handslot/.test(parent.getName()) && !mounts[n.getName()]) {
      mounts[n.getName()] = { bone: parent.getName(), position: n.getTranslation(), quaternion: n.getRotation() };
    }
  }

  // 2. Clip files. Keep only tracks for bones that deform the mesh or carry weapons.
  const keepBones = usefulBones(raw.Knight);
  for (const c of CHARACTERS) for (const b of usefulBones(raw[c])) keepBones.add(b);
  keepBones.add('root');
  const shared = buildClipDoc(raw.Knight, [
    { doc: raw.Knight, clips: SHARED_CLIPS },
    { doc: raw.Skeleton_Minion, clips: SHARED_FROM_SKELETON },
  ], keepBones, rests);
  const skel = buildClipDoc(raw.Skeleton_Minion, [{ doc: raw.Skeleton_Minion, clips: SKELETON_CLIPS }], keepBones, rests);
  for (const [{ doc }, file] of [[shared, 'anims/clips.glb'], [skel, 'anims/clips_skeleton.glb']]) {
    await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }), ...compress());
    await io.write(path.join(ASSETS, file), doc);
    sizes[file] = fileSize(path.join(ASSETS, file));
  }

  // 3. Verify every clip track targets a node name present in every character.
  const verify = [];
  for (const [file, { doc }] of [['anims/clips.glb', shared], ['anims/clips_skeleton.glb', skel]]) {
    const reread = await io.read(path.join(ASSETS, file));
    const targets = new Set();
    for (const a of reread.getRoot().listAnimations()) for (const ch of a.listChannels()) targets.add(ch.getTargetNode().getName());
    for (const c of CHARACTERS) {
      const names = new Set(rests[CHARACTERS.indexOf(c)].keys());
      const missing = [...targets].filter(t => !names.has(t));
      if (missing.length) verify.push(`${file} -> ${c}: missing ${missing.join(',')}`);
    }
    verify.push(`${file}: ${reread.getRoot().listAnimations().length} clips, ${targets.size} target bones, all present in ${CHARACTERS.length} characters`);
  }

  // 4. Impact times from the source (unreduced) data on the Knight / Minion rigs.
  const impacts = {}, impactInfo = {};
  for (const clip of ATTACK_CLIPS) {
    const srcName = SKELETON_CLIPS.includes(clip) ? 'Skeleton_Minion' : 'Knight';
    const anim = raw[srcName].getRoot().listAnimations().find(a => a.getName() === clip);
    const info = computeImpact(raw[srcName], fk.restPose(raw[srcName]), anim);
    impacts[clip] = info.time;
    impactInfo[clip] = info;
  }

  const clipDurations = { ...durationsOf(shared.doc), ...durationsOf(skel.doc) };
  const catalog = casting.buildCatalog({ mounts, bindModels: models });
  const cast = await import(pathToFileURL(path.join(__dirname, '..', 'cast.js')).href);
  const roles = cast.resolveRoles({ models: catalog.models, loadouts: catalog.loadouts, armyAnims: catalog.armyAnims, baseScale: casting.BASE_SCALE }, cast.presetCast('classic'));
  const manifest = casting.buildManifest({ impacts, clipDurations, catalog, roles, meshopt: MESHOPT });

  // Every prop any loadout can use (they are small), plus the textures they reference.
  fs.rmSync(path.join(ASSETS, 'props'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ASSETS, 'props'));
  for (const name of catalog.propFiles) {
    const json = JSON.parse(fs.readFileSync(path.join(RAW, 'props', `${name}.gltf`), 'utf8'));
    const files = [`${name}.gltf`, ...json.buffers.map(b => b.uri), ...(json.images || []).map(i => i.uri)];
    for (const f of files) {
      fs.copyFileSync(path.join(RAW, 'props', f), path.join(ASSETS, 'props', f));
      sizes[`props/${f}`] = fileSize(path.join(ASSETS, 'props', f));
    }
  }

  fs.writeFileSync(path.join(ASSETS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const report = { sizes, total: Object.values(sizes).reduce((a, b) => a + b, 0), trackStats: { shared: shared.stats, skeleton: skel.stats }, keepBones: [...keepBones], verify, impactInfo };
  console.log(JSON.stringify(report, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
