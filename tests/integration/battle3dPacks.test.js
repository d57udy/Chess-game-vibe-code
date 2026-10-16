'use strict';
// v6 model library: library.json <-> pack.json consistency, license/credit fields, files exist and
// parse, declared sizes match, triangle and texture budgets, declared animation clips and bones exist
// in each GLB, thumbnails are real images, CREDITS.md credits every pack, and the offline list finds
// packs through library.json only (v6.4 precaches them all as optional files; no hand-written list).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const LIB = path.join(ASSETS, 'library.json');
const have = fs.existsSync(LIB);
const TRI_BUDGET = 20000;       // per model
const BYTES_BUDGET = 1.5 * 1024 * 1024; // per model file

function glbJson(file) {
    const d = fs.readFileSync(file);
    assert.equal(d.toString('ascii', 0, 4), 'glTF', `${file} magic`);
    assert.equal(d.readUInt32LE(8), d.length, `${file} length`);
    return JSON.parse(d.subarray(20, 20 + d.readUInt32LE(12)).toString('utf8'));
}
function triangles(json) {
    let n = 0;
    for (const m of json.meshes || []) for (const p of m.primitives) {
        if (p.mode !== undefined && p.mode !== 4) continue;
        const acc = p.indices !== undefined ? json.accessors[p.indices] : json.accessors[p.attributes.POSITION];
        n += Math.floor(acc.count / 3);
    }
    return n;
}
// WebP / PNG / JPEG header check with dimensions
function imageInfo(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = b.toString('ascii', 12, 16);
        if (chunk === 'VP8X') return { type: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
        if (chunk === 'VP8 ') return { type: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { type: 'webp', w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
        return { type: 'webp', w: 0, h: 0 };
    }
    if (b.readUInt32BE(0) === 0x89504e47) return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) return { type: 'jpeg', w: 1, h: 1 };
    return null;
}

describe('battle3d model library (v6)', { skip: !have && 'library.json not present' }, () => {
    const lib = have ? JSON.parse(fs.readFileSync(LIB, 'utf8')) : null;
    const packs = have ? lib.packs.map((p) => ({ entry: p, dir: path.dirname(path.join(ASSETS, p.path)), json: JSON.parse(fs.readFileSync(path.join(ASSETS, p.path), 'utf8')) })) : [];

    test('library.json lists at least 2 packs; entries agree with their pack.json', () => {
        assert.ok(lib.packs.length >= 2, `${lib.packs.length} packs`);
        const ids = new Set();
        for (const { entry, json, dir } of packs) {
            assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`); ids.add(entry.id);
            assert.equal(json.id, entry.id);
            assert.equal(json.name, entry.name);
            assert.equal(json.models.length, entry.models, `${entry.id} model count`);
            const bytes = json.models.reduce((n, m) => n + fs.statSync(path.join(dir, m.file)).size, 0);
            assert.ok(Math.abs(bytes - entry.bytes) <= 64 * 1024 + bytes * 0.2, `${entry.id}: library says ${entry.bytes} bytes, models are ${bytes}`);
            assert.ok(!entry.path.startsWith('/') && !/^https?:/.test(entry.path), 'relative path');
        }
    });

    test('every pack has a verified CC0 license, source URL, credit line and the license file', () => {
        for (const { entry, json, dir } of packs) {
            const L = json.license;
            assert.ok(L && /CC0/.test(L.name), `${entry.id} license name ${L && L.name}`);
            assert.match(L.url, /^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0/);
            assert.match(L.source, /^https:\/\//, `${entry.id} source`);
            assert.match(L.verified, /^\d{4}-\d{2}-\d{2}$/, `${entry.id} verified date`);
            assert.ok(json.credit && json.credit.includes(json.author), `${entry.id} credit line`);
            assert.ok(fs.existsSync(path.join(dir, 'LICENSE.txt')) || fs.existsSync(path.join(dir, 'License.txt')), `${entry.id} license file`);
        }
    });

    test('CREDITS.md credits every pack and its source', () => {
        const credits = fs.readFileSync(path.join(ASSETS, 'CREDITS.md'), 'utf8');
        for (const { json } of packs) {
            assert.ok(credits.includes(json.name) || credits.includes(json.id), `CREDITS.md mentions ${json.name}`);
            assert.ok(credits.includes(json.license.source), `CREDITS.md links ${json.license.source}`);
        }
    });

    test('models: files exist, parse, declared size/tris match, within budgets, thumbnails are images', () => {
        const bad = [];
        for (const { entry, dir, json } of packs) {
            for (const m of json.models) {
                const file = path.join(dir, m.file);
                if (!fs.existsSync(file)) { bad.push(`${entry.id}/${m.file} missing`); continue; }
                const size = fs.statSync(file).size;
                if (m.bytes !== undefined && m.bytes !== size) bad.push(`${entry.id}/${m.id}: bytes ${m.bytes} != ${size}`);
                if (size > BYTES_BUDGET) bad.push(`${entry.id}/${m.id}: ${size} bytes over budget`);
                const j = glbJson(file);
                const tris = triangles(j);
                if (tris > TRI_BUDGET) bad.push(`${entry.id}/${m.id}: ${tris} triangles over ${TRI_BUDGET}`);
                if (m.tris !== undefined && Math.abs(m.tris - tris) > Math.max(10, tris * 0.05)) bad.push(`${entry.id}/${m.id}: tris ${m.tris} vs ${tris}`);
                for (const img of j.images || []) if (img.uri && !img.uri.startsWith('data:')) bad.push(`${entry.id}/${m.id}: external image ${img.uri}`);
                if (!['+z', '-z', '+x', '-x', undefined].includes(m.forward)) bad.push(`${entry.id}/${m.id}: forward ${m.forward}`);
                if (!(m.height > 0.2 && m.height < 1.6)) bad.push(`${entry.id}/${m.id}: height ${m.height}`);
            }
        }
        assert.deepEqual(bad, []);
    });

    test('thumbnails: every model and pack has a real image thumbnail (32..512 px)', () => {
        const bad = [];
        for (const { entry, dir, json } of packs) {
            if (!fs.existsSync(path.join(ASSETS, entry.thumb))) bad.push(`${entry.id}: pack thumb ${entry.thumb}`);
            for (const m of json.models) {
                const t = path.join(dir, m.thumb || '');
                const info = m.thumb && fs.existsSync(t) ? imageInfo(t) : null;
                if (!info) bad.push(`${entry.id}/${m.id}: thumbnail ${m.thumb} missing or not an image`);
                else if (info.w && (info.w < 32 || info.w > 512)) bad.push(`${entry.id}/${m.id}: thumbnail ${info.w}x${info.h}`);
            }
        }
        assert.deepEqual(bad, []);
    });

    test('declared animation clips and bones exist in each model', () => {
        const bad = [];
        for (const { entry, dir, json } of packs) {
            for (const m of json.models) {
                const file = path.join(dir, m.file);
                if (!fs.existsSync(file)) continue;
                const j = glbJson(file);
                const clips = new Set((j.animations || []).map((a) => a.name));
                const nodes = new Set((j.nodes || []).map((n) => n.name));
                for (const [k, v] of Object.entries(m.anims || {})) for (const c of [].concat(v)) if (c && !clips.has(c)) bad.push(`${entry.id}/${m.id}: anims.${k} ${c} not in the GLB`);
                for (const [k, v] of Object.entries(m.bones || {})) if (!nodes.has(v)) bad.push(`${entry.id}/${m.id}: bones.${k} ${v} not a node`);
                for (const c of Object.keys(m.impacts || {})) if (!clips.has(c)) bad.push(`${entry.id}/${m.id}: impact for unknown clip ${c}`);
            }
        }
        assert.deepEqual(bad, []);
    });

    test('the offline list finds packs through library.json: no pack file is listed by hand or in the built-in manifest', () => {
        // v6.4 precaches every pack for offline play (tools/offline-list.js -> offline-files.json, as optional files)
        const { APP_SHELL, offlinePaths } = require('../../tools/offline-list');
        assert.deepEqual(APP_SHELL.filter((p) => /assets\/packs\//.test(p)), [], 'no pack files in APP_SHELL');
        const { required, optional } = offlinePaths(ROOT);
        assert.deepEqual(required.filter((p) => /assets\/packs\//.test(p)), [], 'packs are optional');
        assert.ok(optional.filter((p) => /assets\/packs\//.test(p)).length >= 3 * 3);
        // assetFiles() reads models from manifest roles/models/loadouts: built-in packs must not leak in there
        const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'manifest.json'), 'utf8'));
        const referenced = JSON.stringify([manifest.models, manifest.roles, manifest.loadouts]);
        assert.ok(!/packs\//.test(referenced), 'the built-in manifest does not reference pack files');
    });
});
