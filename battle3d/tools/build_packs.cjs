// Builds the downloadable model packs (battle3d/assets/packs/<id>/) and the library index (assets/library.json)
// from CC0 sources on OpenGameArt (uploaded by the authors themselves). Steps per model: download the archive,
// FBX -> GLB (FBX2glTF), attach textures, matte materials, rename clips to unique "<Model>|<Clip>" names,
// resample + meshopt, WebP textures (max 512 px), measure height / facing / impact times, write pack.json.
//
//   cd /tmp/b3d-tools && npm i @gltf-transform/core @gltf-transform/functions @gltf-transform/extensions \
//       meshoptimizer gl-matrix fbx2gltf sharp
//   NODE_PATH=/tmp/b3d-tools/node_modules node battle3d/tools/build_packs.cjs
//   node battle3d/tools/make_thumbs.mjs          (thumbnails, headless Chrome)
// Archives are cached in $PACK_CACHE (default: <os tmp>/b3d-pack-cache).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { NodeIO, Logger } = require('@gltf-transform/core');
const { prune, dedup, resample, meshopt, textureCompress, weld } = require('@gltf-transform/functions');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { MeshoptEncoder, MeshoptDecoder } = require('meshoptimizer');
const sharp = require('sharp');
const { vec3 } = require('gl-matrix');
const fk = require('./kaykit_fk.cjs');

const ASSETS = path.join(__dirname, '..', 'assets');
const PACKS_DIR = path.join(ASSETS, 'packs');
const CACHE = process.env.PACK_CACHE || path.join(os.tmpdir(), 'b3d-pack-cache');
const FBX2GLTF = path.join(path.dirname(require.resolve('fbx2gltf/package.json')), 'bin', os.type(), os.type() === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF');
const TODAY = new Date().toISOString().slice(0, 10);

// Clip roles: idle, walk, run, attack[], death[], hit[], block, cheer, spawn, jump. Values are clip suffixes
// (after "Armature|"); "A/B" means A, or B when the model has no A. The build checks they exist.
const HUMANOID_BONES = { head: 'Head', chest: 'Torso', hips: 'Hips', handR: 'Fist.R', handL: 'Fist.L' };
const RPG_BASE = { idle: 'Idle', walk: 'Walk', run: 'Run', death: ['Death'], hit: ['RecieveHit'], block: 'RecieveHit_Attacking', cheer: 'PickUp', spawn: 'Idle', jump: 'Roll' };
const PACKS = [
  {
    id: 'quaternius-rpg', name: 'Quaternius RPG Characters', author: 'Quaternius',
    page: 'https://opengameart.org/content/lowpoly-rpg-characters', submitted: '2021-06-18',
    zip: 'https://opengameart.org/sites/default/files/rpg_characters_-_nov_2020.zip',
    description: 'Six fantasy adventurers with their own weapons and animations.',
    rig: 'quaternius-character', kind: 'humanoid', army: 'heroes', textures: 'RPG Characters - Nov 2020/Textures', fbx: 'RPG Characters - Nov 2020/FBX',
    height: 0.85,
    models: {
      Warrior: { label: 'Warrior', anims: { ...RPG_BASE, idle: 'Idle_Weapon', attack: ['Sword_Attack', 'Sword_AttackFast'] }, bones: { ...HUMANOID_BONES, handR: 'Weapon.R' }, tags: ['sword', 'melee'] },
      Wizard: { label: 'Wizard', anims: { ...RPG_BASE, idle: 'Idle_Weapon', attack: ['Spell1', 'Spell2'] }, ranged: true, tags: ['staff', 'magic'] },
      Rogue: { label: 'Rogue', anims: { ...RPG_BASE, idle: 'Attacking_Idle', attack: ['Dagger_Attack', 'Dagger_Attack2'] }, tags: ['dagger', 'melee'] },
      Ranger: { label: 'Ranger', anims: { ...RPG_BASE, idle: 'Idle_Weapon', attack: ['Bow_Attack_Shoot'] }, ranged: true, tags: ['bow', 'ranged'] },
      Cleric: { label: 'Cleric', anims: { ...RPG_BASE, idle: 'Idle_Weapon', attack: ['Staff_Attack', 'Spell1'] }, tags: ['staff', 'magic'] },
      Monk: { label: 'Monk', anims: { ...RPG_BASE, idle: 'Idle_Attacking', attack: ['Attack', 'Attack2'] }, tags: ['unarmed', 'melee'] },
    },
  },
  {
    id: 'quaternius-monsters', name: 'Quaternius Animated Monsters', author: 'Quaternius',
    page: 'https://opengameart.org/content/lowpoly-animated-monsters', submitted: '2018-08-16',
    zip: 'https://opengameart.org/sites/default/files/Animated%20Monster%20Pack%20by%20%40Quaternius.zip',
    description: 'A slime, a bat, a dragon and a skeleton with attacks, deaths and hits.',
    rig: 'quaternius-monster', kind: 'creature', army: 'monsters', fbx: 'Animated Monster Pack by @Quaternius/FBX',
    models: {
      Slime: { label: 'Slime', height: 0.45, forward: '+z', anims: { idle: 'Slime_Idle', walk: 'Slime_Walk', run: 'Slime_Walk', attack: ['Slime_Attack'], death: ['Slime_Death'], hit: ['Slime_Attack'], block: 'Slime_Idle', cheer: 'Slime_Attack', spawn: 'Slime_Idle', jump: 'Slime_Walk' }, bones: { head: 'Head', chest: 'Body' }, tags: ['small'] },
      Bat: { label: 'Bat', height: 0.75, anims: { idle: 'Bat_Flying', walk: 'Bat_Flying', run: 'Bat_Flying', attack: ['Bat_Attack', 'Bat_Attack2'], death: ['Bat_Death'], hit: ['Bat_Hit'], block: 'Bat_Hit', cheer: 'Bat_Attack2', spawn: 'Bat_Flying', jump: 'Bat_Flying' }, bones: { head: 'Head', chest: 'Body' }, tags: ['flying'] },
      Dragon: { label: 'Dragon', height: 0.95, anims: { idle: 'Dragon_Flying', walk: 'Dragon_Flying', run: 'Dragon_Flying', attack: ['Dragon_Attack', 'Dragon_Attack2'], death: ['Dragon_Death'], hit: ['Dragon_Hit'], block: 'Dragon_Hit', cheer: 'Dragon_Attack2', spawn: 'Dragon_Flying', jump: 'Dragon_Flying' }, bones: { head: 'Head', chest: 'Body' }, tags: ['flying', 'big'] },
      Skeleton: { label: 'Bone Brute', height: 0.85, anims: { idle: 'Skeleton_Idle', walk: 'Skeleton_Running', run: 'Skeleton_Running', attack: ['Skeleton_Attack'], death: ['Skeleton_Death'], hit: ['Skeleton_Attack'], block: 'Skeleton_Idle', cheer: 'Skeleton_Spawn', spawn: 'Skeleton_Spawn', jump: 'Skeleton_Running' }, bones: { head: 'Head', chest: 'Torso', hips: 'Hips' }, tags: ['undead'] },
    },
  },
  {
    id: 'quaternius-farm', name: 'Quaternius Farm Animals', author: 'Quaternius',
    page: 'https://opengameart.org/content/lowpoly-animated-farm-animal-pack', submitted: '2018-06-08',
    zip: 'https://opengameart.org/sites/default/files/Farm%20Animals%20by%20%40Quaternius.zip',
    description: 'A horse for mounted knights, plus a whole barnyard army.',
    rig: 'quaternius-animal', kind: 'animal', army: 'animals', fbx: 'Farm Animals by @Quaternius/FBX',
    models: Object.fromEntries([['Horse', 0.85], ['Zebra', 0.85], ['Cow', 0.8], ['Llama', 0.9], ['Pig', 0.5], ['Sheep', 0.55], ['Pug', 0.4]].map(([m, h]) => [m, {
      label: m, height: h, mountable: m === 'Horse' || m === 'Zebra',
      ...(m === 'Horse' || m === 'Zebra' ? { mount: { height: 0.9, saddle: [0, 4.75, 0.2], riderScale: 0.85 } } : {}),
      anims: { idle: 'Idle', walk: 'Walk/Jump', run: 'Run/Jump', attack: ['Jump'], death: ['Death/Idle'], hit: ['Jump'], block: 'Idle', cheer: 'Jump', spawn: 'Idle', jump: 'Jump' },
      bones: { head: 'Head', chest: 'Torso', hips: 'Hips' }, tags: m === 'Horse' || m === 'Zebra' ? ['mount'] : ['animal'],
    }])),
  },
];

const logger = new Logger(Logger.Verbosity.ERROR);
const io = new NodeIO().setLogger(logger).registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

async function download(pack) {
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, `${pack.id}.zip`);
  if (!fs.existsSync(zip)) {
    const res = await fetch(pack.zip);
    if (!res.ok) throw new Error(`download ${pack.zip}: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  }
  const dir = path.join(CACHE, pack.id);
  if (!fs.existsSync(dir)) execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
  const license = (function find(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const r = find(p); if (r) return r; } else if (/^license/i.test(e.name)) return p;
    }
    return null;
  })(dir);
  const text = license ? fs.readFileSync(license, 'utf8') : '';
  if (!/CC0/.test(text)) throw new Error(`${pack.id}: bundled license is not CC0`);
  return { dir, licenseText: text.trim() };
}

function convert(fbx, outBase) {
  execFileSync(FBX2GLTF, ['--binary', '--input', fbx, '--output', outBase], { stdio: 'ignore' });
  return outBase + '.glb';
}

// Peak speed of the fastest leaf bone, then halfway to the end of that swing (same rule as the KayKit clips).
function impactOf(doc, anim) {
  const rest = fk.restPose(doc);
  const tracks = fk.clipTracks(anim);
  const d = fk.clipDuration(anim);
  const joints = doc.getRoot().listSkins()[0]?.listJoints() || [];
  const leaves = joints.filter(j => !j.listChildren().some(c => joints.includes(c))).map(j => j.getName());
  const dt = 1 / 60;
  const samples = [];
  for (let t = 0; t <= d + 1e-9; t += dt) {
    const W = fk.worldMatrices(doc, rest, tracks, t);
    samples.push({ t, p: Object.fromEntries(leaves.map(n => [n, fk.pointOn(W.get(n))])) });
  }
  const speed = (i, n) => vec3.distance(samples[i].p[n], samples[i - 1].p[n]) / dt;
  let best = { v: -1, i: 1, n: leaves[0] };
  for (let i = 1; i < samples.length; i++) for (const n of leaves) { const v = speed(i, n); if (v > best.v) best = { v, i, n }; }
  let end = best.i;
  while (end + 1 < samples.length && speed(end + 1, best.n) > 0.35 * best.v) end++;
  return round((samples[best.i].t - dt / 2 + samples[end].t) / 2);
}

// Ground speed of a locomotion clip in native units/s at rate 1: feet sweep back by one step per half cycle,
// so speed = 2 * (foot range along the facing axis) / duration (same rule units.js uses for KayKit clips).
function strideSpeed(doc, anim, forward) {
  if (!anim) return null;
  const rest = fk.restPose(doc), tracks = fk.clipTracks(anim), d = fk.clipDuration(anim);
  const feet = [...rest.keys()].filter(n => /foot/i.test(n) && !/pole|ik/i.test(n));
  if (!feet.length || d <= 0) return null;
  const axis = forward.endsWith('x') ? 0 : 2;
  const ranges = feet.map(() => [Infinity, -Infinity]);
  for (let i = 0; i <= 48; i++) {
    const W = fk.worldMatrices(doc, rest, tracks, d * i / 48);
    feet.forEach((f, k) => { const v = fk.pointOn(W.get(f))[axis]; ranges[k][0] = Math.min(ranges[k][0], v); ranges[k][1] = Math.max(ranges[k][1], v); });
  }
  const r = ranges.map(([a, b]) => b - a).sort((a, b) => b - a);
  const range = (r[0] + (r[1] ?? r[0])) / 2; // two most mobile feet
  return range > 1e-4 ? 2 * range / d : null;
}

// Which horizontal axis the model faces: the head bone (or the front of the bind bounding box) relative to the hips.
function facing(doc, kind) {
  const rest = fk.restPose(doc);
  const W = fk.worldMatrices(doc, rest, null, 0);
  const names = [...W.keys()];
  const find = re => names.find(n => re.test(n));
  if (kind === 'humanoid') {
    // Feet point forward: the foot bone tip (its child, or toe end) sits in front of the ankle.
    const foot = find(/^Foot\.L$/), leg = find(/^LowerLeg\.L$/);
    if (foot && leg) {
      const f = fk.pointOn(W.get(foot), [0, 1, 0]), a = fk.pointOn(W.get(foot));
      const dx = f[0] - a[0], dz = f[2] - a[2];
      return Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? '+z' : '-z') : (dx > 0 ? '+x' : '-x');
    }
  }
  const head = find(/^head$/i) || find(/head/i), tail = find(/^hips$/i) || find(/tail/i) || find(/^body$/i) || find(/^root$/i);
  if (!head || !tail) return '+z';
  const h = fk.pointOn(W.get(head)), t = fk.pointOn(W.get(tail));
  const dx = h[0] - t[0], dz = h[2] - t[2];
  return Math.abs(dz) >= Math.abs(dx) ? (dz > 0 ? '+z' : '-z') : (dx > 0 ? '+x' : '-x');
}

// Bounds of the model as rendered in a pose (skinned vertices through joint world matrices x inverse binds).
function bounds(doc, anim) {
  const { mat4 } = require('gl-matrix');
  const W = fk.worldMatrices(doc, fk.restPose(doc), anim ? fk.clipTracks(anim) : null, 0);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = p => { for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); } };
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh();
    if (!m) continue;
    const skin = n.getSkin();
    const joints = skin ? skin.listJoints().map((j, i) => {
      const ibm = Array.from(skin.getInverseBindMatrices().getElement(i, []));
      return mat4.multiply(mat4.create(), W.get(j.getName()), ibm);
    }) : null;
    const wm = W.get(n.getName()) || n.getWorldMatrix();
    for (const p of m.listPrimitives()) {
      const P = p.getAttribute('POSITION'), J = p.getAttribute('JOINTS_0'), Wt = p.getAttribute('WEIGHTS_0');
      const v = [], j = [], w = [];
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, v);
        if (joints && J && Wt) {
          J.getElement(i, j); Wt.getElement(i, w);
          const out = [0, 0, 0];
          for (let k = 0; k < 4; k++) if (w[k] > 0) { const t = vec3.transformMat4([0, 0, 0], v, joints[j[k]]); for (let c = 0; c < 3; c++) out[c] += t[c] * w[k]; }
          add(out);
        } else add(vec3.transformMat4([0, 0, 0], v, wm));
      }
    }
  }
  return { min, max };
}

async function buildModel(pack, src, texDir, id, cfg, outDir) {
  const doc = await io.read(src);
  const root = doc.getRoot();

  // Textures referenced by material name (RPG pack): FBX2glTF drops them when the FBX paths are absolute.
  if (texDir) for (const m of root.listMaterials()) {
    const file = path.join(texDir, `${m.getName()}.png`);
    if (!m.getBaseColorTexture() && fs.existsSync(file)) {
      let tex = root.listTextures().find(t => t.getName() === m.getName());
      if (!tex) tex = doc.createTexture(m.getName()).setImage(fs.readFileSync(file)).setMimeType('image/png').setURI(`${m.getName()}.png`);
      m.setBaseColorTexture(tex).setBaseColorFactor([1, 1, 1, 1]);
    }
  }
  for (const m of root.listMaterials()) m.setMetallicFactor(0).setRoughnessFactor(0.75);

  // Unique clip names + the clips the role map needs.
  const clipNames = new Map();
  for (const a of root.listAnimations()) {
    const suffix = a.getName().split('|').pop();
    a.setName(`${id}|${suffix}`);
    clipNames.set(suffix, a.getName());
  }
  const anims = {};
  for (const [key, val] of Object.entries(cfg.anims)) {
    const list = [].concat(val).map(alts => {
      const s = alts.split('/').find(a => clipNames.has(a));
      if (!s) throw new Error(`${id}: no clip ${alts}`);
      return clipNames.get(s);
    });
    anims[key] = Array.isArray(val) ? list : list[0];
  }

  const kind = cfg.kind || pack.kind;
  const forward = cfg.forward || facing(doc, kind);
  const impacts = {}, clipDurations = {};
  for (const a of root.listAnimations()) clipDurations[a.getName()] = round(fk.clipDuration(a));
  for (const name of anims.attack) impacts[name] = impactOf(doc, root.listAnimations().find(a => a.getName() === name));
  const b = bounds(doc, root.listAnimations().find(a => a.getName() === anims.idle));
  const nativeHeight = b.max[1] - Math.min(0, b.min[1]);
  const anim = name => root.listAnimations().find(a => a.getName() === name);
  const walkNative = anims.walk !== anims.jump ? strideSpeed(doc, anim(anims.walk), forward) : null; // hopping animals: no stride
  const runNative = anims.run !== anims.walk ? strideSpeed(doc, anim(anims.run), forward) : null;
  const tris = root.listMeshes().reduce((s, m) => s + m.listPrimitives().reduce((t, p) => t + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0), 0);

  await doc.transform(
    weld(),
    resample({ tolerance: 1e-4 }),
    dedup(),
    prune({ keepLeaves: true }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 85 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const file = path.join(outDir, `${id}.glb`);
  await io.write(file, doc);
  const textures = root.listTextures().map(t => t.getSize()).filter(Boolean);
  const height = cfg.height || pack.height || 0.85;
  return {
    id, label: cfg.label || id, file: `${id}.glb`, thumb: `thumbs/${id}.webp`,
    kind, rig: pack.rig, native: true, forward,
    scale: round(height / nativeHeight, 4), nativeHeight: round(nativeHeight), height,
    tris: Math.round(tris), textures, bytes: fs.statSync(file).size,
    // Ground speed at playback rate 1 in native units/s (multiply by the role scale); null = not a stepping clip.
    walkSpeedNative: walkNative ? round(walkNative) : null, runSpeedNative: runNative ? round(runNative) : null,
    ranged: !!cfg.ranged, mountable: !!cfg.mountable, tags: cfg.tags || [],
    ...(cfg.mount ? { mount: { scale: round(cfg.mount.height / nativeHeight, 4), saddle: cfg.mount.saddle, riderScale: cfg.mount.riderScale } } : {}),
    bones: cfg.bones || HUMANOID_BONES, anims, impacts, clipDurations,
  };
}

async function main() {
  await MeshoptEncoder.ready; await MeshoptDecoder.ready;
  fs.mkdirSync(PACKS_DIR, { recursive: true });
  const library = { version: 1, generated: TODAY, packs: [] };
  for (const pack of PACKS) {
    const { dir, licenseText } = await download(pack);
    const outDir = path.join(PACKS_DIR, pack.id);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'thumbs'), { recursive: true });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `b3d-${pack.id}-`));
    const models = [];
    for (const [id, cfg] of Object.entries(pack.models)) {
      const src = convert(path.join(dir, pack.fbx, `${id}.fbx`), path.join(tmp, id));
      const texDir = pack.textures ? path.join(dir, pack.textures) : null;
      models.push(await buildModel(pack, src, texDir, id, cfg, outDir).catch(e => { throw new Error(`${pack.id}/${id}: ${e.message}`); }));
      console.log(`${pack.id}/${id}: ${models.at(-1).bytes} bytes, ${models.at(-1).tris} tris, forward ${models.at(-1).forward}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    const license = { name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/', source: pack.page, submitted: pack.submitted, verified: TODAY, note: 'CC0 stated on the OpenGameArt page (uploaded by the author) and in the bundled License.txt.' };
    fs.writeFileSync(path.join(outDir, 'LICENSE.txt'), licenseText + '\n');
    const json = {
      version: 1, id: pack.id, name: pack.name, author: pack.author, description: pack.description,
      license, credit: `${pack.name} by ${pack.author} (CC0), ${pack.page}`,
      rig: pack.rig, kind: pack.kind, army: pack.army, models,
    };
    fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(json, null, 2) + '\n');
    const bytes = models.reduce((s, m) => s + m.bytes, 0);
    library.packs.push({
      id: pack.id, name: pack.name, author: pack.author, description: pack.description, license: license.name,
      path: `packs/${pack.id}/pack.json`, thumb: `packs/${pack.id}/${models[0].thumb}`, models: models.length,
      kind: pack.kind, army: pack.army, bytes,
    });
  }
  fs.writeFileSync(path.join(ASSETS, 'library.json'), JSON.stringify(library, null, 2) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
