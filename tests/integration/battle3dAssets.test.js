'use strict';
// Static validation of the battle3d asset set: every file the manifests reference exists, every
// GLB/glTF parses, every clip the manifest names exists, and every animation track targets a bone
// that every character skeleton has. GLB JSON chunks are parsed by hand (no three.js needed).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const MANIFEST = path.join(ASSETS, 'manifest.json');
const DEV_MANIFEST = path.join(ROOT, 'battle3d', 'manifest.dev.json');
const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
const SIZE_BUDGET = 6 * 1024 * 1024; // total download for the final asset set

// Returns { json, bin } for .glb or .gltf (external buffers checked for existence and length).
function readGltf(file) {
    const data = fs.readFileSync(file);
    if (file.endsWith('.gltf')) {
        const json = JSON.parse(data.toString('utf8'));
        for (const b of json.buffers || []) {
            if (!b.uri || b.uri.startsWith('data:')) continue;
            const bf = path.join(path.dirname(file), decodeURIComponent(b.uri));
            assert.ok(fs.existsSync(bf), `${path.basename(file)}: buffer ${b.uri} missing`);
            assert.ok(fs.statSync(bf).size >= b.byteLength, `${path.basename(file)}: buffer ${b.uri} too short`);
        }
        for (const img of json.images || []) {
            if (img.uri && !img.uri.startsWith('data:')) {
                assert.ok(fs.existsSync(path.join(path.dirname(file), decodeURIComponent(img.uri))), `${path.basename(file)}: image ${img.uri} missing`);
            }
        }
        return { json, bin: null, size: data.length };
    }
    assert.equal(data.toString('ascii', 0, 4), 'glTF', `${file}: bad magic`);
    assert.equal(data.readUInt32LE(4), 2, `${file}: glTF version`);
    assert.equal(data.readUInt32LE(8), data.length, `${file}: header length != file size`);
    let off = 12, json = null, bin = null;
    while (off < data.length) {
        const len = data.readUInt32LE(off), type = data.readUInt32LE(off + 4);
        assert.ok(off + 8 + len <= data.length, `${file}: chunk overruns file`);
        const chunk = data.subarray(off + 8, off + 8 + len);
        if (type === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
        else if (type === 0x004E4942) bin = chunk;
        off += 8 + len;
    }
    assert.ok(json, `${file}: no JSON chunk`);
    // Buffer views must fit their buffers (meshopt views reference the compressed buffer).
    for (const [i, bv] of (json.bufferViews || []).entries()) {
        const mo = bv.extensions?.EXT_meshopt_compression;
        const ref = mo || bv;
        const buf = json.buffers[ref.buffer];
        const avail = ref.buffer === 0 && !buf.uri && bin ? bin.length : buf.byteLength;
        if (buf.extensions?.EXT_meshopt_compression?.fallback) continue;
        assert.ok((ref.byteOffset || 0) + ref.byteLength <= avail, `${path.basename(file)}: bufferView ${i} out of range`);
    }
    for (const img of json.images || []) {
        if (img.uri && !img.uri.startsWith('data:')) {
            assert.ok(fs.existsSync(path.join(path.dirname(file), decodeURIComponent(img.uri))), `${path.basename(file)}: image ${img.uri} missing`);
        }
    }
    return { json, bin, size: data.length };
}

const nodeNames = (json) => new Set((json.nodes || []).map((n) => n.name));
const jointNames = (json) => new Set((json.skins || []).flatMap((s) => s.joints.map((j) => json.nodes[j].name)));
// clip name -> { duration, targets: Set<node name> }
function clipsOf(json) {
    const out = new Map();
    for (const a of json.animations || []) {
        let duration = 0;
        const targets = new Set();
        for (const ch of a.channels) {
            if (ch.target.node !== undefined) targets.add(json.nodes[ch.target.node].name);
            const input = json.accessors[a.samplers[ch.sampler].input];
            if (input.max) duration = Math.max(duration, input.max[0]);
        }
        out.set(a.name, { duration, targets });
    }
    return out;
}
// Every clip name a role uses (roles[c][t].anims) plus the fight tables.
function roleClipNames(manifest) {
    const names = new Set();
    for (const c of ['w', 'b']) {
        for (const t of TYPES) {
            for (const v of Object.values(manifest.roles[c][t].anims || {})) [].concat(v).forEach((n) => names.add(n));
        }
    }
    for (const t of TYPES) {
        const f = manifest.fight?.[t];
        if (!f) continue;
        (f.attack || []).forEach((n) => names.add(n));
        Object.keys(f.impact || {}).forEach((n) => names.add(n));
    }
    return names;
}

const haveFinal = fs.existsSync(MANIFEST);

describe('battle3d assets: final manifest', { skip: !haveFinal && 'battle3d/assets/manifest.json not built yet' }, () => {
    const manifest = haveFinal ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
    const resolve = (rel) => path.join(ASSETS, rel);
    const cache = new Map();
    const load = (rel) => { if (!cache.has(rel)) cache.set(rel, readGltf(resolve(rel))); return cache.get(rel); };

    test('has a role for every color and piece type', () => {
        for (const c of ['w', 'b']) {
            for (const t of TYPES) {
                const r = manifest.roles?.[c]?.[t];
                assert.ok(r, `roles.${c}.${t}`);
                assert.equal(typeof r.model, 'string');
                assert.ok(r.scale > 0, `roles.${c}.${t}.scale`);
            }
        }
    });

    test('every referenced file exists and parses', () => {
        const files = new Set([manifest.clips.file, manifest.clips.skeletonFile].filter(Boolean));
        for (const c of ['w', 'b']) {
            for (const t of TYPES) {
                files.add(manifest.roles[c][t].model);
                for (const p of manifest.roles[c][t].props || []) files.add(p.file);
            }
        }
        for (const f of files) {
            assert.ok(fs.existsSync(resolve(f)), `missing ${f}`);
            load(f);
        }
    });

    test('meshopt flag matches the extensions the GLBs require', () => {
        for (const [rel, { json }] of cache) {
            const req = json.extensionsRequired || [];
            if (req.includes('EXT_meshopt_compression')) assert.equal(manifest.meshopt, true, `${rel} needs meshopt`);
            assert.ok(!req.includes('KHR_draco_mesh_compression'), `${rel}: draco is not wired up`);
            for (const e of req) assert.ok(['EXT_meshopt_compression', 'KHR_mesh_quantization', 'KHR_texture_transform', 'KHR_materials_emissive_strength'].includes(e), `${rel}: unexpected required extension ${e}`);
        }
    });

    test('show/hide nodes and prop bones exist in each model', () => {
        for (const c of ['w', 'b']) {
            for (const t of TYPES) {
                const r = manifest.roles[c][t];
                const names = nodeNames(load(r.model).json);
                for (const n of [...(r.show || []), ...(r.hide || [])]) assert.ok(names.has(n), `${c}.${t} ${r.model}: node ${n}`);
                for (const p of r.props || []) assert.ok(names.has(p.bone), `${c}.${t} ${r.model}: bone ${p.bone}`);
                if (r.crown) assert.ok(names.has('head'), `${c}.${t}: crown needs a head bone`);
            }
        }
    });

    test('every clip the manifest names exists in the clip files', () => {
        const clips = new Map([...clipsOf(load(manifest.clips.file).json)]);
        if (manifest.clips.skeletonFile) for (const [k, v] of clipsOf(load(manifest.clips.skeletonFile).json)) clips.set(k, v);
        const missing = [...roleClipNames(manifest)].filter((n) => !clips.has(n));
        assert.deepEqual(missing, []);
        const missingImpacts = Object.keys(manifest.impacts || {}).filter((n) => !clips.has(n));
        assert.deepEqual(missingImpacts, [], 'impacts keys');
        const missingDur = Object.keys(manifest.clipDurations || {}).filter((n) => !clips.has(n));
        assert.deepEqual(missingDur, [], 'clipDurations keys');
    });

    test('clipDurations match the clip data and impacts fall inside their clips', () => {
        const clips = new Map([...clipsOf(load(manifest.clips.file).json)]);
        if (manifest.clips.skeletonFile) for (const [k, v] of clipsOf(load(manifest.clips.skeletonFile).json)) clips.set(k, v);
        for (const [name, d] of Object.entries(manifest.clipDurations || {})) {
            if (!clips.has(name)) continue;
            assert.ok(Math.abs(clips.get(name).duration - d) < 0.02, `${name}: manifest ${d}, data ${clips.get(name).duration}`);
        }
        for (const t of TYPES) {
            for (const [name, at] of Object.entries(manifest.fight?.[t]?.impact || {})) {
                const dur = clips.get(name)?.duration;
                assert.ok(at > 0 && dur !== undefined && at < dur, `${t} ${name}: impact ${at} vs duration ${dur}`);
            }
        }
    });

    test('every animation track targets a bone present in every character skeleton', () => {
        const models = new Set();
        for (const c of ['w', 'b']) for (const t of TYPES) models.add(manifest.roles[c][t].model);
        const problems = [];
        for (const file of [manifest.clips.file, manifest.clips.skeletonFile].filter(Boolean)) {
            const clips = clipsOf(load(file).json);
            const targets = new Set([...clips.values()].flatMap((c) => [...c.targets]));
            for (const m of models) {
                const joints = jointNames(load(m).json);
                const names = nodeNames(load(m).json);
                const missing = [...targets].filter((n) => !joints.has(n) && !names.has(n));
                if (missing.length) problems.push(`${file} -> ${m}: ${missing.join(', ')}`);
            }
        }
        assert.deepEqual(problems, []);
    });

    test('characters share one skeleton (same joint names)', () => {
        const models = new Set();
        for (const c of ['w', 'b']) for (const t of TYPES) models.add(manifest.roles[c][t].model);
        const sets = [...models].map((m) => [m, [...jointNames(load(m).json)].sort().join(',')]);
        for (const [m, s] of sets) assert.equal(s, sets[0][1], `${m} joints differ from ${sets[0][0]}`);
        assert.ok(sets[0][1].split(',').length >= 20, 'skeleton has joints');
    });

    test('scaled heights are in the piece-size range', () => {
        for (const c of ['w', 'b']) {
            for (const t of TYPES) {
                const r = manifest.roles[c][t];
                const h = manifest.models?.[r.model]?.bind?.height;
                if (!h) continue;
                const world = h * r.scale;
                assert.ok(world > 0.6 && world < 1.2, `${c}.${t}: height ${world.toFixed(2)} world units`);
            }
        }
    });

    test('total download size is within budget', (t) => {
        let total = 0;
        const add = (f) => { total += fs.statSync(f).size; };
        for (const rel of cache.keys()) {
            add(resolve(rel));
            const { json } = cache.get(rel);
            for (const b of json.buffers || []) if (b.uri && !b.uri.startsWith('data:')) add(path.join(path.dirname(resolve(rel)), b.uri));
            for (const i of json.images || []) if (i.uri && !i.uri.startsWith('data:')) add(path.join(path.dirname(resolve(rel)), i.uri));
        }
        t.diagnostic(`battle3d asset download: ${(total / 1024 / 1024).toFixed(2)} MB over ${cache.size} manifest files`);
        assert.ok(total < SIZE_BUDGET, `${total} bytes`);
    });
});

describe('battle3d assets: dev manifest (raw KayKit files)', { skip: !fs.existsSync(DEV_MANIFEST) && 'no dev manifest' }, () => {
    test('every referenced raw file exists and parses; names resolve', () => {
        const manifest = JSON.parse(fs.readFileSync(DEV_MANIFEST, 'utf8'));
        const base = path.dirname(DEV_MANIFEST);
        for (const c of ['w', 'b']) {
            for (const t of TYPES) {
                const r = manifest.roles[c][t];
                const file = path.join(base, r.model);
                assert.ok(fs.existsSync(file), r.model);
                const { json } = readGltf(file);
                const names = nodeNames(json);
                for (const n of [...(r.show || []), ...(r.hide || [])]) assert.ok(names.has(n), `${c}.${t}: node ${n}`);
                for (const p of r.props || []) {
                    assert.ok(fs.existsSync(path.join(base, p.file)), p.file);
                    readGltf(path.join(base, p.file));
                    assert.ok(names.has(p.bone), `${c}.${t}: bone ${p.bone}`);
                }
                const clips = clipsOf(json);
                for (const n of manifest.fight?.[t]?.attack || []) {
                    if (!clips.has(n)) assert.fail(`${c}.${t} ${r.model}: embedded clip ${n} missing`);
                }
            }
        }
    });
});
