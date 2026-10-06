// Validates the built assets: Khronos glTF validator on every output, then a three.js check that every
// manifest clip binds on every cast model, accessories/props exist, and the posed heights look right.
//   NODE_PATH does not apply to ES modules, so run from the tools install dir or pass B3D_TOOLS:
//   B3D_TOOLS=/tmp/b3d-tools/node_modules node battle3d/tools/validate_assets.mjs
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, '..', 'assets');
const mods = process.env.B3D_TOOLS;
const req = createRequire(path.join(mods, 'x.js'));
const imp = p => import(pathToFileURL(path.join(mods, p)).href);
const validator = req('gltf-validator');

// Minimal DOM stubs so GLTFLoader can "decode" embedded PNGs in node.
globalThis.self = globalThis;
globalThis.document = {
  createElementNS: () => {
    const img = { listeners: {}, width: 1, height: 1,
      addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {},
      set src(v) { setTimeout(() => this.listeners.load && this.listeners.load.call(this, {}), 0); } };
    return img;
  },
};

const THREE = await imp('three/build/three.module.js');
const { GLTFLoader } = await imp('three/examples/jsm/loaders/GLTFLoader.js');
const { MeshoptDecoder } = await imp('three/examples/jsm/libs/meshopt_decoder.module.js');
const SkeletonUtils = await imp('three/examples/jsm/utils/SkeletonUtils.js');

const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
let errors = 0;
const fail = msg => { errors++; console.log('FAIL', msg); };

// 1. Khronos validator.
const outputs = [
  ...fs.readdirSync(path.join(ASSETS, 'characters')).map(f => `characters/${f}`),
  ...fs.readdirSync(path.join(ASSETS, 'anims')).map(f => `anims/${f}`),
  ...fs.readdirSync(path.join(ASSETS, 'props')).filter(f => f.endsWith('.gltf')).map(f => `props/${f}`),
];
for (const rel of outputs) {
  const file = path.join(ASSETS, rel);
  const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(file)), {
    uri: rel,
    externalResourceFunction: uri => Promise.resolve(new Uint8Array(fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(uri))))),
  });
  const { numErrors, numWarnings, numInfos } = report.issues;
  console.log(`validator ${rel}: ${numErrors} errors, ${numWarnings} warnings, ${numInfos} infos`);
  for (const m of report.issues.messages.filter(m => m.severity <= 1)) console.log('   ', m.severity ? 'warn' : 'ERROR', m.code, m.message, m.pointer || '');
  if (numErrors) fail(`${rel} has validator errors`);
}

// 2. three.js load + binding checks.
const loader = new GLTFLoader();
if (manifest.meshopt) loader.setMeshoptDecoder(MeshoptDecoder);
const load = rel => new Promise((res, rej) => {
  const buf = fs.readFileSync(path.join(ASSETS, rel));
  loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), pathToFileURL(path.join(ASSETS, path.dirname(rel)) + '/').href, res, rej);
});
const sanitize = n => THREE.PropertyBinding.sanitizeNodeName(n);

const clips = (await load(manifest.clips.file)).animations;
const skelClips = (await load(manifest.clips.skeletonFile)).animations;
const allClips = new Map([...clips, ...skelClips].map(c => [c.name, c]));
console.log(`clips: ${clips.length} shared + ${skelClips.length} skeleton`);
for (const [name, d] of Object.entries(manifest.clipDurations)) {
  const c = allClips.get(name);
  if (!c) fail(`clip ${name} missing from clip files`);
  else if (Math.abs(c.duration - d) > 0.02) fail(`clip ${name} duration ${c.duration} != manifest ${d}`);
}

const cache = new Map();
const report = [];
for (const color of ['w', 'b']) {
  for (const [type, role] of Object.entries(manifest.roles[color])) {
    if (!cache.has(role.model)) cache.set(role.model, await load(role.model));
    const gltf = cache.get(role.model);
    const model = SkeletonUtils.clone(gltf.scene);
    for (const n of [...role.show, ...role.hide]) if (!model.getObjectByName(sanitize(n))) fail(`${color}${type}: accessory ${n} not found`);
    for (const n of role.hide) model.getObjectByName(sanitize(n)).visible = false;
    for (const p of role.props) {
      if (!fs.existsSync(path.join(ASSETS, p.file))) fail(`${color}${type}: prop file ${p.file} missing`);
      if (!model.getObjectByName(sanitize(p.bone))) fail(`${color}${type}: bone ${p.bone} not found`);
    }
    const mixer = new THREE.AnimationMixer(model);
    const a = role.anims;
    const used = [a.idle, a.walk, a.block, a.cheer, a.spawn, a.jump, ...a.attack, ...a.death, ...a.hit];
    for (const name of used) {
      const clip = allClips.get(name);
      if (!clip) { fail(`${color}${type}: clip ${name} missing`); continue; }
      const action = mixer.clipAction(clip);
      const unbound = action._propertyBindings.filter(b => !b.binding.node).length;
      if (unbound) fail(`${color}${type}: ${name} has ${unbound} unbound tracks`);
      const tracks = clip.tracks.filter(t => !model.getObjectByName(t.name.split('.')[0])).map(t => t.name);
      if (tracks.length) fail(`${color}${type}: ${name} tracks without target: ${tracks.slice(0, 3).join(',')}`);
      mixer.uncacheAction(clip);
    }
    if (!(a.attack.every(n => typeof manifest.impacts[n] === 'number'))) fail(`${color}${type}: attack without impact`);

    // Posed height (Idle at t=0.3) at manifest scale, skinned meshes only.
    model.scale.setScalar(role.scale);
    const idle = mixer.clipAction(allClips.get(a.idle));
    idle.play();
    mixer.update(0.3);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const accBox = new THREE.Box3();
    model.traverse(o => {
      if (o.isSkinnedMesh) {
        o.skeleton.update();
        o.computeBoundingBox();
        box.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
      } else if (o.isMesh && o.visible && o.parent.visible) {
        accBox.union(new THREE.Box3().setFromObject(o));
      }
    });
    const all = box.clone().union(accBox);
    report.push(`${color}${type} ${role.label.padEnd(6)} ${path.basename(role.model).padEnd(22)} scale ${role.scale} body ${box.max.y.toFixed(2)} with gear ${all.max.y.toFixed(2)} depth z [${box.min.z.toFixed(2)}, ${box.max.z.toFixed(2)}]`);
  }
}
console.log(report.join('\n'));

// 3. Every preset and every model x loadout combination resolves to existing files and known clips.
const castMod = await import(pathToFileURL(path.join(here, '..', 'cast.js')).href);
let combos = 0;
for (const id of Object.keys(castMod.PRESETS)) {
  const roles = castMod.resolveRoles(manifest, castMod.presetCast(id));
  for (const c of ['w', 'b']) for (const t of castMod.TYPES) {
    const r = roles[c][t];
    if (!fs.existsSync(path.join(ASSETS, r.model))) fail(`preset ${id} ${c}${t}: missing ${r.model}`);
  }
}
for (const model of Object.keys(manifest.models)) for (const loadout of Object.keys(manifest.loadouts)) {
  const r = castMod.resolveRole(manifest, 'w', 'q', { model, loadout });
  combos++;
  for (const p of r.props) if (!fs.existsSync(path.join(ASSETS, p.file))) fail(`${model}/${loadout}: missing ${p.file}`);
  for (const a of [r.anims.idle, ...r.anims.attack]) if (!allClips.has(a)) fail(`${model}/${loadout}: unknown clip ${a}`);
}
console.log(`presets: ${Object.keys(castMod.PRESETS).length}, model x loadout combinations: ${combos}`);
console.log(errors ? `${errors} problems` : 'all asset checks passed');
process.exit(errors ? 1 : 0);
