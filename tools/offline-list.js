#!/usr/bin/env node
// The same-origin files sw.js downloads for offline play, each with a short content hash, written to
// offline-files.json at the site root (committed; the worker reads it at install), and the build stamp in sw.js.
//
//   npm run offline-list                      after changing any file of the game or sw.js: rewrites the list and
//                                             the stamp (a new stamp means a new worker and new caches)
//   node tools/offline-list.js --check        exits 1 when the list or the stamp is stale, or when sw.js, the list or
//                                             a listed file is not tracked by git with exactly that path (CI runs it)
//
// The build stamp (`const BUILD = '...'` in sw.js) is a hash of offline-files.json and of sw.js with the stamp left
// out. The worker's cache names carry it, so any change of a listed file or of the worker code gives a new worker and
// a new shell, whether or not VERSION was bumped. At install the worker checks the deployed list and its own script
// against it. The worker copies a file from an older version's cache when its content hash is unchanged and downloads
// it otherwise, so an update downloads only what changed.
//
// Required files block an update until they are stored: the app shell and the default cast (the roles of the asset
// manifest: models, props, clip files). Optional files may be missing from a deploy (HTTP 404) without blocking it:
// thumbnails, the other weapons of the cast editor, and the library packs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LIST = 'offline-files.json';
const SW = 'sw.js';
const ASSET_DIR = 'battle3d/assets/';
const STAMP = /^const BUILD = '[0-9a-f]*';/m;

// App shell, relative to the worker's scope (the site root, e.g. /Chess-game-vibe-code/). './' is index.html.
const APP_SHELL = [
    './', 'index.html', '2d.html', 'battle3d.html', 'manifest.webmanifest',
    'gameLogic.js', 'aiPlayer.js', 'aiClient.js', 'aiWorker.js', 'ui.js', 'battleFx.js', 'style.css',
    'savegame.js', 'savepanel.js', 'saves2d.js',
    'move.mp3', 'capture.mp3', 'check.mp3', 'game-over.mp3',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png',
    'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon.svg', 'icons/icon.svg',
    'battle3d/main.js', 'battle3d/controller.js', 'battle3d/rules.js', 'battle3d/audio.js',
    'battle3d/scene.js', 'battle3d/scene-rig.js', 'battle3d/scene-world.js', 'battle3d/scene-fx.js',
    'battle3d/scene-textures.js', 'battle3d/cinematic.js', 'battle3d/units.js', 'battle3d/fights.js',
    'battle3d/unit-visuals.js', 'battle3d/cast.js', 'battle3d/cast-ui.js', 'battle3d/install.js',
    'battle3d/commentary.js', 'battle3d/coach.js', 'battle3d/bubbles.js', 'battle3d/tactics.js',
    'battle3d/retarget.js', 'battle3d/vrm.js', 'battle3d/saves.js',
    'battle3d/hud.css', 'battle3d/cast.css', 'battle3d/install.css',
    'battle3d/lines/hero-king.json', 'battle3d/lines/skeleton-king.json', 'battle3d/lines/coach.json',
    'battle3d/assets/rigs/kaykit.json', 'battle3d/assets/rigs/mixamo.json', 'battle3d/assets/rigs/quaternius.json', 'battle3d/assets/rigs/vrm.json',
    'battle3d/assets/manifest.json', 'battle3d/assets/library.json',
];

// Files of the asset manifest, relative to the assets folder: { required, optional }. Required: what the default
// cast plays with (clip files, role models and their props). Optional: library cards and the other weapons.
function assetFiles(m) {
    const required = new Set(), optional = new Set();
    for (const f of [m?.clips?.file, m?.clips?.skeletonFile]) if (f) required.add(f);
    for (const side of Object.values(m?.roles || {})) for (const role of Object.values(side)) {
        if (role.model) required.add(role.model);
        for (const p of role.props || []) if (p.file) required.add(p.file);
    }
    for (const [id, model] of Object.entries(m?.models || {})) {
        if (model.file) optional.add(model.file);
        optional.add(`thumbs/${id}.webp`); // cast editor library cards
    }
    for (const l of Object.values(m?.loadouts || {})) for (const p of l.props || []) if (p.file) optional.add(p.file);
    for (const f of required) optional.delete(f);
    return { required: [...required], optional: [...optional] };
}

// Files a .gltf references next to itself (buffers, textures), relative to the assets folder like `file`.
function gltfFiles(gltf, file) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    return [...(gltf?.buffers || []), ...(gltf?.images || [])]
        .filter(x => x.uri && !x.uri.startsWith('data:'))
        .map(x => new URL(x.uri, `https://x/${dir}`).pathname.slice(1));
}

// Library packs: each pack.json, its card thumbnail, and every model and thumbnail in it, at the paths cast.js asks
// for (packs/<id>/<file>), relative to the assets folder. `packs` are the parsed pack.json files.
function packFiles(library, packs) {
    const files = new Set();
    for (const entry of library?.packs || []) {
        files.add(entry.path || `packs/${entry.id}/pack.json`);
        if (entry.thumb) files.add(entry.thumb);
    }
    for (const pack of packs || []) for (const m of pack?.models || []) {
        if (m.file) files.add(`packs/${pack.id}/${m.file}`);
        if (m.thumb) files.add(`packs/${pack.id}/${m.thumb}`);
    }
    return [...files];
}

const hashOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const fileOf = (p) => (p === './' ? 'index.html' : p);

// Every precached same-origin path, relative to the site root: { required: [...], optional: [...] }
function offlinePaths(root = ROOT) {
    const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    const manifest = read(`${ASSET_DIR}manifest.json`);
    const library = read(`${ASSET_DIR}library.json`);
    const packs = (library.packs || []).map(p => read(ASSET_DIR + (p.path || `packs/${p.id}/pack.json`)));
    const { required, optional } = assetFiles(manifest);
    const sidecars = (list) => list.filter(f => f.endsWith('.gltf')).flatMap(f => gltfFiles(read(ASSET_DIR + f), f));
    const req = new Set([...APP_SHELL, ...[...required, ...sidecars(required)].map(f => ASSET_DIR + f)]);
    const opt = new Set([...optional, ...sidecars(optional), ...packFiles(library, packs)].map(f => ASSET_DIR + f).filter(f => !req.has(f)));
    return { required: [...req], optional: [...opt] };
}

// The list as committed: { about, files: { path: hash }, optional: [path] }, sorted for stable diffs
function buildList(root = ROOT) {
    const { required, optional } = offlinePaths(root);
    const all = [...required, ...optional].sort();
    const files = {};
    for (const p of all) files[p] = hashOf(fs.readFileSync(path.join(root, fileOf(p))));
    return {
        about: 'Files sw.js precaches for offline play, with a content hash each. Generated by tools/offline-list.js (npm run offline-list); do not edit.',
        files,
        optional: optional.slice().sort(),
    };
}

const serialize = (list) => JSON.stringify(list, null, 2) + '\n';

// The build id of a list text and a sw.js text (its stamp left out), as sw.js computes it at install
const blankStamp = (swText) => swText.replace(STAMP, "const BUILD = '';");
const buildId = (listText, swText) => hashOf(Buffer.concat([Buffer.from(listText), Buffer.from('\n' + blankStamp(swText))]));
const stamp = (swText, listText) => swText.replace(STAMP, `const BUILD = '${buildId(listText, swText)}';`);
const stampOf = (swText) => swText.match(STAMP)?.[0].slice("const BUILD = '".length, -2) ?? null;

// Files git tracks with their exact path, or null outside a git checkout
function gitFiles(root = ROOT) {
    try {
        const out = require('node:child_process').execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 });
        return new Set(out.toString().split('\0').filter(Boolean));
    } catch (e) { return null; }
}

// What keeps this checkout from shipping a correct offline list: [] when fine
function problems(root = ROOT) {
    const out = [];
    const listText = fs.readFileSync(path.join(root, LIST), 'utf8');
    const swText = fs.readFileSync(path.join(root, SW), 'utf8');
    const fresh = serialize(buildList(root));
    if (fresh !== listText) {
        const now = JSON.parse(fresh).files, then = JSON.parse(listText).files;
        const changed = [...new Set([...Object.keys(now), ...Object.keys(then)])].filter((p) => now[p] !== then[p]);
        out.push(`${LIST} is stale (${changed.slice(0, 5).join(', ') || 'optional files'}): run npm run offline-list`);
    }
    for (const [name, text] of [[SW, swText], [LIST, listText]]) {
        if (text.charCodeAt(0) === 0xfeff) out.push(`${name} starts with a byte order mark: save it as UTF-8 without one`);
    }
    if (!STAMP.test(swText)) out.push(`${SW} has no "const BUILD = '...';" line`);
    else if (stampOf(swText) !== buildId(listText, swText)) out.push(`the build stamp in ${SW} does not match ${LIST} and ${SW}: run npm run offline-list`);
    const tracked = gitFiles(root);
    if (tracked) {
        for (const f of [SW, LIST]) if (!tracked.has(f)) out.push(`${f} is not tracked by git`);
        const untracked = Object.keys(JSON.parse(listText).files).map(fileOf).filter((f) => !tracked.has(f));
        if (untracked.length) out.push(`listed but not tracked by git with exactly this path: ${untracked.slice(0, 5).join(', ')}`);
    }
    return out;
}

module.exports = { APP_SHELL, ASSET_DIR, LIST, SW, assetFiles, gltfFiles, packFiles, offlinePaths, buildList, serialize, hashOf, fileOf, buildId, stamp, stampOf, gitFiles, problems };

if (require.main === module) {
    if (process.argv.includes('--check')) {
        const found = problems();
        for (const p of found) console.error(`offline-list: ${p}`);
        if (found.length) process.exit(1);
        console.log(`offline-list: ${LIST} and the build stamp in ${SW} are up to date`);
    } else {
        const list = buildList();
        const listText = serialize(list);
        fs.writeFileSync(path.join(ROOT, LIST), listText);
        const swText = stamp(fs.readFileSync(path.join(ROOT, SW), 'utf8'), listText);
        fs.writeFileSync(path.join(ROOT, SW), swText);
        console.log(`${LIST}: ${Object.keys(list.files).length} files (${list.optional.length} optional); ${SW} build ${stampOf(swText)}`);
    }
}
