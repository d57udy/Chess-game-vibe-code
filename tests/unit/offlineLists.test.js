'use strict';
// What offline play downloads (v6.4): offline-files.json and the build stamp in sw.js (tools/offline-list.js) are up
// to date, both files and every listed file are tracked by git with exactly that path, the list splits required from
// optional files as sw.js expects, and the worker computes the same hashes and build id; the lists it is made of
// (asset manifest, library packs, glTF sidecars) checked against the repo; the fonts of a Google Fonts stylesheet
// (sw.js); the size of the same-origin download; and the readiness texts of battle3d/install.js.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');
const L = require('../../tools/offline-list');

const ASSETS = path.join(ROOT, 'battle3d', 'assets');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const plain = (x) => JSON.parse(JSON.stringify(x)); // arrays of this realm (deepEqual compares prototypes)

// sw.js top-level functions, without running any event
function loadSw() {
    const ctx = vm.createContext({
        self: { registration: { scope: 'https://example.github.io/app/' }, location: new URL('https://example.github.io/app/sw.js'), addEventListener() { } },
        URL, caches: {}, fetch() { }, Request: class { }, Response: class { }, setTimeout, clearTimeout, console, Date,
        crypto: require("node:crypto").webcrypto, TextEncoder, TextDecoder,
    });
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), ctx, { filename: 'sw.js' });
    const sw = vm.runInContext('({ fontFiles, cacheKey, hashOf, buildIdOf, BUILD, SHELL })', ctx);
    return { ...sw, fontFiles: (css) => plain(sw.fontFiles(css)) };
}

// Files git tracks, with their exact path (null outside a git checkout)
function gitFiles() {
    try { return new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 26 }).toString().split('\0').filter(Boolean)); } catch (e) { return null; }
}

describe('offline-files.json (tools/offline-list.js)', () => {
    const committed = fs.readFileSync(path.join(ROOT, L.LIST), 'utf8');
    const list = JSON.parse(committed);

    test('the list and the build stamp in sw.js are up to date (else: npm run offline-list)', () => {
        const stale = L.problems(ROOT).filter((p) => !/tracked/.test(p));
        assert.deepEqual(stale, []);
        assert.match(L.stampOf(fs.readFileSync(path.join(ROOT, L.SW), 'utf8')), /^[0-9a-f]{16}$/);
    });

    test('sw.js, offline-files.json and every listed file are tracked by git with exactly that path', (t) => {
        if (!L.gitFiles(ROOT)) { t.skip('not a git checkout'); return; }
        // GitHub Pages is case-sensitive, macOS is not: a deploy without one of them would block every update
        assert.deepEqual(L.problems(ROOT).filter((p) => /tracked/.test(p)), []);
    });

    test('the stamp changes with the list and with the worker code, not with itself', () => {
        const sw = fs.readFileSync(path.join(ROOT, L.SW), 'utf8');
        const id = L.buildId(committed, sw);
        assert.equal(L.buildId(committed, L.stamp(sw, committed)), id, 'restamping is stable');
        assert.notEqual(L.buildId(committed.replace(list.files['ui.js'], '0000000000000000'), sw), id, 'a list change');
        assert.notEqual(L.buildId(committed, sw.replace("const VERSION = '", "const VERSION = 'x")), id, 'a worker change (VERSION included)');
    });

    test('required: the app shell and the default cast; optional: thumbnails, other weapons, library packs', () => {
        const optional = new Set(list.optional);
        for (const p of L.APP_SHELL) assert.ok(p in list.files && !optional.has(p), p);
        const manifest = readJson(path.join(ASSETS, 'manifest.json'));
        const cast = [manifest.clips.file, manifest.clips.skeletonFile];
        for (const side of Object.values(manifest.roles)) for (const r of Object.values(side)) cast.push(r.model, ...(r.props || []).map((p) => p.file));
        for (const f of cast) assert.ok(!optional.has(L.ASSET_DIR + f) && (L.ASSET_DIR + f) in list.files, `default cast: ${f}`);
        for (const p of list.optional) assert.match(p, /^battle3d\/assets\/(thumbs\/|packs\/|props\/)/, p);
        assert.ok(list.optional.some((p) => p.includes('/packs/')) && list.optional.some((p) => p.includes('/thumbs/')));
        for (const p of list.optional) assert.ok(p in list.files, `optional ${p} is listed`);
    });

    test('hashes and the build id: the same in the generator and in sw.js; cache names carry the build', async () => {
        const SW = loadSw();
        const swText = fs.readFileSync(path.join(ROOT, L.SW), 'utf8');
        assert.equal(await SW.buildIdOf(new Uint8Array(Buffer.from(committed)), new Uint8Array(Buffer.from(swText))), L.buildId(committed, swText));
        // With a byte order mark (an editor that adds one): node and the worker still agree, and --check reports it
        const bom = '\ufeff' + swText;
        assert.equal(await SW.buildIdOf(new Uint8Array(Buffer.from(committed)), new Uint8Array(Buffer.from(bom))), L.buildId(committed, bom));
        assert.notEqual(L.buildId(committed, bom), L.buildId(committed, swText));
        assert.equal(SW.BUILD, L.stampOf(swText));
        assert.ok(SW.SHELL.endsWith(`-${SW.BUILD}`), SW.SHELL);
        const bytes = fs.readFileSync(path.join(ROOT, 'ui.js'));
        assert.equal(list.files['ui.js'], L.hashOf(bytes));
        assert.equal(await SW.hashOf(new Uint8Array(bytes)), L.hashOf(bytes));
        assert.ok(Object.values(list.files).every((h) => /^[0-9a-f]{16}$/.test(h)));
        assert.equal(list.files['./'], list.files['index.html'], './ is index.html');
    });
});

describe('the lists offline-files.json is made of', () => {
    const SW = loadSw();
    const manifest = readJson(path.join(ASSETS, 'manifest.json'));
    const library = readJson(path.join(ASSETS, 'library.json'));
    const packs = library.packs.map((p) => readJson(path.join(ASSETS, p.path)));

    test('assetFiles: every clip file, model, thumbnail and prop of the manifest, each once, all in the repo', () => {
        const { required, optional } = plain(L.assetFiles(manifest));
        const files = [...required, ...optional];
        assert.equal(new Set(files).size, files.length, 'no duplicates');
        assert.deepEqual(files.filter((f) => !fs.existsSync(path.join(ASSETS, f))), [], 'missing files');
        for (const f of [manifest.clips.file, manifest.clips.skeletonFile]) assert.ok(required.includes(f), f);
        for (const [id, m] of Object.entries(manifest.models)) {
            assert.ok(files.includes(m.file), m.file);
            assert.ok(optional.includes(`thumbs/${id}.webp`), `thumb of ${id}`);
        }
        const props = new Set();
        for (const side of Object.values(manifest.roles)) for (const r of Object.values(side)) for (const p of r.props || []) props.add(p.file);
        for (const l of Object.values(manifest.loadouts || {})) for (const p of l.props || []) props.add(p.file);
        assert.ok(props.size > 0);
        assert.deepEqual([...props].filter((f) => !files.includes(f)), [], 'props');
        assert.deepEqual(plain(L.assetFiles(null)), { required: [], optional: [] });
    });

    test('gltfFiles: buffers and textures next to the .gltf, data: URIs skipped', () => {
        const gltf = { buffers: [{ uri: 'a.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ uri: 'tex/a.png' }, { uri: '../shared/b.png' }, { bufferView: 0 }] };
        assert.deepEqual(L.gltfFiles(gltf, 'props/sword.gltf'), ['props/a.bin', 'props/tex/a.png', 'shared/b.png']);
        assert.deepEqual(L.gltfFiles(gltf, 'sword.gltf'), ['a.bin', 'tex/a.png', 'shared/b.png']);
        assert.deepEqual(L.gltfFiles({}, 'x.gltf'), []);
        const { required, optional } = L.assetFiles(manifest);
        for (const f of [...required, ...optional].filter((x) => x.endsWith('.gltf'))) {
            const extra = L.gltfFiles(readJson(path.join(ASSETS, f)), f);
            assert.deepEqual(extra.filter((x) => !fs.existsSync(path.join(ASSETS, x))), [], f);
        }
    });

    test('packFiles: every pack.json, card thumbnail, model and model thumbnail, at the paths cast.js asks for', () => {
        const files = L.packFiles(library, packs);
        assert.equal(new Set(files).size, files.length, 'no duplicates');
        assert.deepEqual(files.filter((f) => !fs.existsSync(path.join(ASSETS, f))), [], 'missing files');
        for (const entry of library.packs) {
            assert.ok(files.includes(entry.path), entry.path);
            if (entry.thumb) assert.ok(files.includes(entry.thumb), entry.thumb);
        }
        let models = 0;
        for (const pack of packs) for (const m of pack.models) {
            models++;
            assert.ok(files.includes(`packs/${pack.id}/${m.file}`), m.file);
            if (m.thumb) assert.ok(files.includes(`packs/${pack.id}/${m.thumb}`), m.thumb);
        }
        assert.equal(models, library.packs.reduce((n, p) => n + p.models, 0), 'library.json model counts');
        // cast.js registers pack models at packs/<id>/<file>: the same URL the game requests
        const cast = fs.readFileSync(path.join(ROOT, 'battle3d', 'cast.js'), 'utf8');
        assert.match(cast, /file: `packs\/\$\{pack\.id\}\/\$\{m\.file\}`/);
        assert.deepEqual(L.packFiles(null, null), []);
        assert.deepEqual(L.packFiles({ packs: [{ id: 'x' }] }, []), ['packs/x/pack.json']);
    });

    test('fontFiles (sw.js): the font URLs of a Google Fonts stylesheet, each once', () => {
        const css = `@font-face { src: url(https://fonts.gstatic.com/s/cinzel/v26/a.woff2) format('woff2'); }
            @font-face { src: url('https://fonts.gstatic.com/s/cinzel/v26/b.woff2') format('woff2'); }
            @font-face { src: url( "https://fonts.gstatic.com/s/cinzel/v26/a.woff2" ) format('woff2'); }`;
        assert.deepEqual(SW.fontFiles(css), ['https://fonts.gstatic.com/s/cinzel/v26/a.woff2', 'https://fonts.gstatic.com/s/cinzel/v26/b.woff2']);
        assert.deepEqual(SW.fontFiles(''), []);
        assert.deepEqual(SW.fontFiles(null), []);
        assert.deepEqual(SW.fontFiles('src: url(data:font/woff2;base64,AAAA)'), [], 'only https files');
    });

    test('cacheKey (sw.js) drops query and hash on the site, keeps them for CDN URLs', () => {
        assert.equal(SW.cacheKey('https://example.github.io/app/?debug=1#x'), 'https://example.github.io/app/');
        assert.equal(SW.cacheKey({ url: 'https://example.github.io/app/ui.js?v=2' }), 'https://example.github.io/app/ui.js');
        const fonts = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap';
        assert.equal(SW.cacheKey(fonts), fonts);
    });

    test('the same-origin download for offline play stays small', (t) => {
        const list = readJson(path.join(ROOT, L.LIST));
        const files = [...new Set(Object.keys(list.files).map(L.fileOf))];
        const bytes = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
        const packBytes = files.filter((f) => f.includes('/packs/')).reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
        t.diagnostic(`${files.length} same-origin files, ${(bytes / 1048576).toFixed(2)} MB (library packs ${(packBytes / 1048576).toFixed(2)} MB), plus the CDN modules`);
        assert.ok(bytes < 10 * 1048576, `${bytes} bytes: a phone downloads all of this before it can play offline`);
    });
});

describe('offline readiness texts (battle3d/install.js)', () => {
    let I;
    before(async () => { I = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'install.js')).href); });

    test('one short line per state, measured wording', () => {
        const text = I.offlineStatusText;
        assert.equal(text({ state: 'ready', percent: null, online: true }), 'Ready to play offline.');
        assert.equal(text({ state: 'ready', percent: 40, online: true }), 'Ready to play offline. Downloading an update: 40%');
        assert.equal(text({ state: 'ready', percent: null, online: true, update: true }), 'Ready to play offline. An update is ready. Reload to use it.');
        assert.equal(text({ state: 'preparing', percent: 60, online: true }), 'Preparing offline play: 60%');
        assert.equal(text({ state: 'preparing', percent: null, online: true }), 'Preparing offline play...');
        assert.match(text({ state: 'incomplete', percent: null, online: true }), /^Offline play is not ready yet\. .*next time/);
        assert.match(text({ state: 'incomplete', percent: null, online: false }), /^Offline play is not ready yet\. Connect to the internet once/);
        assert.equal(text({ state: 'unsupported', percent: null, online: true }), '');
        for (const state of ['ready', 'preparing', 'incomplete']) for (const online of [true, false]) {
            const s = text({ state, percent: 5, online });
            assert.ok(!/\u2014|\u2013| - /.test(s), `no dashes as connectors: ${s}`);
        }
    });

    test('without a browser: unsupported, nothing to mount', () => {
        const seen = [];
        I.watchOfflineStatus((s) => seen.push(s.state))();
        assert.deepEqual(seen, ['unsupported']);
        assert.equal(typeof I.mountOfflineStatus(null).destroy, 'function');
    });
});
