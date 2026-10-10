// Regenerates kaykit.json's rest pose from anims/clips.glb (node TRS of the shared clip rig).
// Usage: node battle3d/assets/rigs/make_kaykit_rest.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..');
const d = fs.readFileSync(path.join(ASSETS, 'anims', 'clips.glb'));
const j = JSON.parse(d.subarray(20, 20 + d.readUInt32LE(12)));
const san = n => n.replace(/\s/g, '_').replace(/[[\].:/]/g, '');   // GLTFLoader's node name sanitizing
const parent = {};
j.nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
const r = x => Math.round(x * 1e5) / 1e5;
const order = [];
const visit = i => { if (j.nodes[i].name !== 'Rig') order.push(i); (j.nodes[i].children || []).forEach(visit); };
j.scenes[0].nodes.forEach(visit);

const rest = {};
for (const i of order) {
    const n = j.nodes[i];
    const p = parent[i] !== undefined && j.nodes[parent[i]].name !== 'Rig' ? san(j.nodes[parent[i]].name) : null;
    const e = { parent: p, t: (n.translation || [0, 0, 0]).map(r), r: (n.rotation || [0, 0, 0, 1]).map(r) };
    if (n.scale && n.scale.some(s => Math.abs(s - 1) > 1e-6)) e.s = n.scale.map(r);
    rest[san(n.name)] = e;
}
const file = path.join(__dirname, 'kaykit.json');
const out = JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = ['{'];
for (const k of ['type', 'label', 'notes']) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`);
lines.push('  "bones": {', Object.entries(out.bones).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'), '  },');
lines.push('  "rest": {', Object.entries(rest).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n'), '  }', '}');
fs.writeFileSync(file, lines.join('\n') + '\n');
console.log('wrote', file, Object.keys(rest).length, 'bones');
