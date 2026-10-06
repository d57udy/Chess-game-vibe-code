// Forward kinematics over a glTF-Transform document: sample a clip at time t and get bone world matrices.
const { mat4, quat, vec3 } = require('gl-matrix');

function restPose(doc) {
  const pose = new Map();
  for (const n of doc.getRoot().listNodes()) {
    pose.set(n.getName(), { t: n.getTranslation().slice(), r: n.getRotation().slice(), s: n.getScale().slice(), node: n });
  }
  return pose;
}

function clipTracks(anim) {
  const tracks = new Map();
  for (const ch of anim.listChannels()) {
    const s = ch.getSampler();
    const key = ch.getTargetNode().getName();
    if (!tracks.has(key)) tracks.set(key, {});
    tracks.get(key)[ch.getTargetPath()] = { input: s.getInput().getArray(), output: s.getOutput().getArray(), interp: s.getInterpolation() };
  }
  return tracks;
}

function clipDuration(anim) {
  let d = 0;
  for (const s of anim.listSamplers()) d = Math.max(d, s.getInput().getMax([])[0]);
  return d;
}

function sampleTrack(tr, t, size) {
  const { input, output } = tr;
  const n = input.length;
  if (t <= input[0] || n === 1) return Array.from(output.slice(0, size));
  if (t >= input[n - 1]) return Array.from(output.slice((n - 1) * size, n * size));
  let i = 0;
  while (i < n - 2 && input[i + 1] < t) i++;
  const a = Array.from(output.slice(i * size, (i + 1) * size));
  const b = Array.from(output.slice((i + 1) * size, (i + 2) * size));
  if (tr.interp === 'STEP') return a;
  const u = (t - input[i]) / (input[i + 1] - input[i]);
  if (size === 4) { const q = quat.create(); quat.slerp(q, a, b, u); return Array.from(q); }
  return a.map((v, k) => v + (b[k] - v) * u);
}

// World matrices for every node under the scene, for a clip (or null = rest pose) at time t.
function worldMatrices(doc, rest, tracks, t) {
  const out = new Map();
  const visit = (node, parentM) => {
    const name = node.getName();
    const r = rest.get(name);
    const tr = tracks && tracks.get(name);
    const T = tr && tr.translation ? sampleTrack(tr.translation, t, 3) : r.t;
    const R = tr && tr.rotation ? sampleTrack(tr.rotation, t, 4) : r.r;
    const S = tr && tr.scale ? sampleTrack(tr.scale, t, 3) : r.s;
    const local = mat4.create();
    mat4.fromRotationTranslationScale(local, R, T, S);
    const world = mat4.create();
    mat4.multiply(world, parentM, local);
    out.set(name, world);
    for (const c of node.listChildren()) visit(c, world);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, mat4.create());
  return out;
}

function pointOn(m, local = [0, 0, 0]) {
  const p = vec3.create();
  vec3.transformMat4(p, local, m);
  return p;
}

module.exports = { restPose, clipTracks, clipDuration, sampleTrack, worldMatrices, pointOn };
