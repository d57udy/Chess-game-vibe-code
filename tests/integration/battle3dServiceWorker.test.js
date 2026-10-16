'use strict';
// sw.js in a node:vm with fake self/caches/fetch/clients. Static checks: versioned cache names,
// three.js pin == import map, every precache entry exists (same-origin in the repo, CDN in
// node_modules), the app's whole module graph is in offline-files.json. Behaviour: install stores the
// list's files + CDN + fonts and skips waiting only when complete (retries, stalled downloads, the
// install deadline, optional files missing from a deploy, an incomplete download never takes over and
// resumes on the next try, files copied by content hash from older versions, CDN files kept across
// versions, unfinished shells dropped); activate deletes old caches only; fetch: navigation
// network-first with cached/offline fallbacks (query ignored, timeout), media cache-first, JS
// stale-while-revalidate, CDN cache-first, HEAD from the cache, cache misses give up on a network that
// never answers, non-GET / foreign / out-of-scope requests left alone; progress messages and the
// offline marker (v6.4). The fake server's ETags change with every deploy, as on GitHub Pages.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('../helpers/loadEngine');

const SW = path.join(ROOT, 'sw.js');
const have = fs.existsSync(SW);
const src = have ? fs.readFileSync(SW, 'utf8') : '';
const ORIGIN = 'https://example.github.io';
const SCOPE = `${ORIGIN}/Chess-game-vibe-code/`;
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const crypto = require('node:crypto');
const { APP_SHELL, LIST, hashOf, stamp } = require('../../tools/offline-list');
const LIST_TEXT = fs.readFileSync(path.join(ROOT, LIST), 'utf8');
const OFFLINE = JSON.parse(LIST_TEXT);
const LISTED = Object.keys(OFFLINE.files); // every same-origin file the worker stores
// CDN files that are not in node_modules: served from here by the fake network
const VRM_URL = 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@3.5.5/lib/three-vrm.module.min.js';
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap';
const FONT_FILES = ['https://fonts.gstatic.com/s/cinzel/v26/a.woff2', 'https://fonts.gstatic.com/s/cinzel/v26/b.woff2'];
const VIRTUAL = new Map([
    [VRM_URL, "import * as THREE from 'three'; export const VRMLoaderPlugin = class {};"],
    [FONTS_CSS, FONT_FILES.map((u) => `@font-face { font-family: 'Cinzel'; src: url(${u}) format('woff2'); }`).join('\n')],
    ...FONT_FILES.map((u) => [u, 'wOF2']),
]);

// --- fakes -----------------------------------------------------------------------------------------
class FakeResponse {
    constructor(body, { status = 200, type = 'basic', headers = {} } = {}) {
        this.body = body == null ? Buffer.alloc(0) : Buffer.from(body);
        this.status = status; this.ok = status >= 200 && status < 300; this.type = type; this.headers = new Headers(headers);
    }
    static error() { return new FakeResponse(null, { status: 0, type: 'error' }); }
    clone() { return new FakeResponse(this.body, this); }
    async text() { return this.body.toString('utf8'); }
    async json() { return JSON.parse(this.body.toString('utf8')); }
    async arrayBuffer() { return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.length); }
}
class FakeRequest {
    constructor(input, init = {}) {
        this.url = typeof input === 'string' ? input : input.url;
        this.method = init.method || input.method || 'GET';
        this.mode = init.mode || input.mode || 'cors';
        this.cache = init.cache || input.cache || 'default';
        this.headers = new Headers(init.headers || input.headers || {});
    }
}
// GitHub Pages: W/"<deploy time>-<size>", so every deploy changes every ETag (the worker must not rely on them)
let deploy = 1;
const etagOf = (body) => `W/"deploy${deploy}-${body.length.toString(16)}"`;
// offline-files.json as a deploy would have it after `npm run offline-list`, with some files changed
const listWith = (changed) => {
    const files = { ...OFFLINE.files };
    for (const [p, body] of Object.entries(changed)) files[p] = hashOf(Buffer.from(body));
    return JSON.stringify({ ...OFFLINE, files });
};

// Maps a URL to a local file: site paths to the repo, three.js CDN to node_modules, gsap to node_modules.
function localFile(url) {
    const u = new URL(url);
    if (u.origin === ORIGIN && u.pathname.startsWith('/Chess-game-vibe-code/')) {
        let p = decodeURIComponent(u.pathname.slice('/Chess-game-vibe-code/'.length));
        if (p === '' || p.endsWith('/')) p += 'index.html';
        return path.join(ROOT, p);
    }
    const m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/three@([\d.]+)\/(.*)$/);
    if (m) return path.join(THREE_DIR, m[2]);
    if (/cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.12\.2\/gsap\.min\.js$/.test(url)) return path.join(ROOT, 'node_modules', 'gsap', 'dist', 'gsap.min.js');
    return null;
}

// `stores` (cache name -> Map) can be shared by two workers, like two versions of sw.js in one browser.
// A release as `npm run offline-list` makes it: `version` (another VERSION) and `list` (another offline-files.json,
// served by the fake network), sw.js stamped for them. `source` then rewrites the script as it is deployed (e.g. a
// VERSION bump without a new stamp). The fake network serves the running script as sw.js (the worker checks it
// against its stamp). Timers run at `timeoutScale`; the install deadline at `deadlineScale` (24 s by default: a busy
// machine must not cut an install short that should complete).
const DEADLINE_MS = Number(src.match(/const INSTALL_DEADLINE_MS = (\d+)/)?.[1]);
function makeWorker({ timeoutScale = 1 / 1000, deadlineScale = 1 / 10, stores = new Map(), version = null, list = null, source = (x) => x, active = false } = {}) {
    let script = version ? src.replace(/const VERSION = '[^']+'/, `const VERSION = '${version}'`) : src;
    if (version || list) script = stamp(script, list ?? LIST_TEXT);
    script = source(script);
    const listeners = {};
    // offline: requests fail at once; hang: they never answer; fail(url) -> true: that request fails;
    // delay: every answer comes this many ms later
    const net = { offline: false, hang: false, fail: null, delay: 0, log: [], requests: [], override: new Map() };
    const keyOf = (key) => (typeof key === 'string' ? key : key.url);
    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return {
                async put(key, res) { m.set(keyOf(key), res); },
                async match(key) { const r = m.get(keyOf(key)); return r ? r.clone() : undefined; },
                async keys() { return [...m.keys()]; },
                async delete(key) { return m.delete(keyOf(key)); },
            };
        },
        async match(key, { cacheName } = {}) {
            const k = keyOf(key);
            for (const [name, m] of stores) if ((!cacheName || name === cacheName) && m.has(k)) return m.get(k).clone();
            return undefined;
        },
        async has(name) { return stores.has(name); },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
    };
    const fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        net.log.push(url);
        net.requests.push(input);
        if (net.delay) await new Promise((resolve) => setTimeout(resolve, net.delay)); // real time, not scaled
        if (net.hang) return new Promise(() => {});
        if (net.offline || net.fail?.(url)) throw new TypeError('Failed to fetch');
        if (net.override.has(url)) return net.override.get(url)();
        const sameOrigin = url.startsWith(ORIGIN);
        const type = sameOrigin ? 'basic' : 'cors';
        if (VIRTUAL.has(url)) return new FakeResponse(VIRTUAL.get(url), { type });
        const file = localFile(url);
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
            const body = fs.readFileSync(file);
            return new FakeResponse(body, { type, headers: sameOrigin ? { ETag: etagOf(body) } : {} });
        }
        return new FakeResponse('not found', { status: 404, type });
    };
    const calls = { skipWaiting: 0, claim: 0, preload: 0, preloadOff: 0 };
    const messages = []; // what the worker posted to pages
    const self = {
        location: new URL(`${SCOPE}sw.js`),
        registration: { scope: SCOPE, active: active ? { state: 'activated' } : null, navigationPreload: { enable: async () => { calls.preload++; }, disable: async () => { calls.preloadOff++; } } },
        clients: {
            claim: async () => { calls.claim++; },
            matchAll: async () => [{ postMessage: (m) => messages.push(m) }],
        },
        skipWaiting: async () => { calls.skipWaiting++; },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    };
    const ctx = vm.createContext({
        self, caches, fetch, Request: FakeRequest, Response: FakeResponse, Headers, URL, Promise, console, Date,
        AbortController, TextDecoder, TextEncoder, crypto: crypto.webcrypto,
        setTimeout: (fn, ms, ...a) => setTimeout(fn, ms * (ms === DEADLINE_MS ? deadlineScale : timeoutScale), ...a), clearTimeout,
    });
    vm.runInContext(script, ctx, { filename: 'sw.js' });
    net.override.set(`${SCOPE}sw.js`, async () => new FakeResponse(script));
    if (list) net.override.set(`${SCOPE}${LIST}`, async () => new FakeResponse(list));
    const consts = vm.runInContext('({ VERSION, PREFIX, SHELL, RUNTIME, CDN, THREE_BASE, CDN_PRECACHE, OFFLINE_LIST, OFFLINE_MARKER, OFFLINE_ERROR, FONTS_CSS, VRM_MODULE, INSTALL_DEADLINE_MS })', ctx);

    async function dispatch(type, extra = {}) {
        const waits = [];
        const e = { ...extra, waitUntil(p) { waits.push(p); } };
        for (const fn of listeners[type] || []) fn(e);
        await Promise.all(waits);
        return e;
    }
    // Fires a fetch event; returns { handled, response, background } (background = waitUntil promises).
    async function request(url, { mode = 'cors', method = 'GET' } = {}) {
        let responded = null;
        const waits = [];
        const e = {
            request: new FakeRequest(url, { mode, method }),
            preloadResponse: Promise.resolve(undefined),
            respondWith(p) { responded = Promise.resolve(p); },
            waitUntil(p) { waits.push(p); },
        };
        for (const fn of listeners.fetch || []) fn(e);
        if (!responded) return { handled: false };
        const response = await responded;
        await Promise.allSettled(waits);
        return { handled: true, response };
    }
    return { listeners, net, stores, caches, calls, consts, dispatch, request, ctx, messages };
}
const keysOf = (W, name) => [...(W.stores.get(name) || new Map()).keys()];
// Same-origin paths a worker asked the network for, in order
// (sw.js left out: the worker reads its own script once per install to check its stamp)
const sameOriginAsked = (W) => W.net.log.filter((u) => u.startsWith(SCOPE) && u !== `${SCOPE}sw.js`).map((u) => u.slice(SCOPE.length));
const scoped = (p) => new URL(p, SCOPE).href;

// --- module graph of the app (what the browser will request) ------------------------------------------
// Static imports must resolve; dynamic import('./x.js') targets are optional modules (the code
// catches a failed import), so a not-yet-written one is skipped rather than failing the walk.
function importsOf(file) {
    const code = fs.readFileSync(file, 'utf8');
    const out = new Map();
    for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) out.set(m[1], false);
    for (const m of code.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) out.set(m[1], false);
    for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) if (!out.has(m[1])) out.set(m[1], true);
    return [...out].map(([spec, dynamic]) => ({ spec, dynamic }));
}
// Resolves import-map specifiers to CDN URLs and walks local + three modules.
function moduleGraph() {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
    const seen = new Set(), cdn = new Set(), local = new Set();
    const resolve = (spec, fromUrl) => {
        if (spec in map) return map[spec];
        for (const [k, v] of Object.entries(map)) if (k.endsWith('/') && spec.startsWith(k)) return v + spec.slice(k.length);
        return new URL(spec, fromUrl).href;
    };
    const walk = (url, dynamic = false) => {
        if (seen.has(url)) return;
        seen.add(url);
        const file = localFile(url);
        if (!file || !fs.existsSync(file)) {
            if (dynamic) return; // optional module not present (yet)
            throw new Error(`module not found: ${url}`);
        }
        if (url.startsWith(ORIGIN)) local.add(url); else cdn.add(url);
        for (const { spec, dynamic: d } of importsOf(file)) walk(resolve(spec, url), d);
    };
    walk(scoped('battle3d/main.js'));
    return { cdn, local, map };
}

describe('sw.js', { skip: !have && 'no sw.js yet' }, () => {
    test('versioned cache names and a release VERSION constant', () => {
        const W = makeWorker();
        assert.match(W.consts.VERSION, /^\d+\.\d+\.\d+/);
        assert.ok(W.consts.SHELL.includes(W.consts.VERSION) && W.consts.RUNTIME.includes(W.consts.VERSION));
        assert.ok(W.consts.SHELL.startsWith(W.consts.PREFIX) && W.consts.RUNTIME.startsWith(W.consts.PREFIX));
        // CDN files carry their version in the URL: their cache outlives releases
        assert.ok(W.consts.CDN.startsWith(W.consts.PREFIX) && !W.consts.CDN.includes(W.consts.VERSION));
    });

    test('three.js CDN pin matches the import map version', () => {
        const W = makeWorker();
        const { map } = moduleGraph();
        assert.ok(map.three.startsWith(W.consts.THREE_BASE), `${map.three} vs ${W.consts.THREE_BASE}`);
        assert.ok(map['three/addons/'].startsWith(W.consts.THREE_BASE));
        const pkg = JSON.parse(fs.readFileSync(path.join(THREE_DIR, 'package.json'), 'utf8'));
        assert.ok(W.consts.THREE_BASE.includes(`three@${pkg.version}/`), 'devDependency three == CDN pin');
        for (const u of W.consts.CDN_PRECACHE) if (u.includes('/three@')) assert.ok(u.startsWith(W.consts.THREE_BASE), u);
    });

    test('every precache entry exists (repo files, node_modules for CDN)', () => {
        const W = makeWorker();
        const missing = [];
        for (const p of LISTED) { const f = localFile(scoped(p)); if (!f || !fs.existsSync(f)) missing.push(p); }
        for (const u of W.consts.CDN_PRECACHE) { if (u === W.consts.VRM_MODULE) continue; const f = localFile(u); if (!f || !fs.existsSync(f)) missing.push(u); }
        assert.deepEqual(missing, []);
    });

    test('three-vrm and the fonts stylesheet are the ones the pages load', () => {
        const W = makeWorker();
        const { map } = moduleGraph();
        assert.equal(W.consts.VRM_MODULE, map['@pixiv/three-vrm'], 'import map');
        const vrm = fs.readFileSync(path.join(ROOT, 'battle3d', 'vrm.js'), 'utf8');
        const version = vrm.match(/THREE_VRM_VERSION = '([^']+)'/)[1];
        assert.ok(W.consts.VRM_MODULE.includes(`@pixiv/three-vrm@${version}/`), 'vrm.js fallback URL');
        assert.ok(W.consts.CDN_PRECACHE.includes(W.consts.VRM_MODULE), 'precached (imported models play offline)');
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const sheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="(https:[^"]+)"[^>]*>/g)];
        assert.deepEqual(sheets.map((m) => m[1].replace(/&amp;/g, '&')), [W.consts.FONTS_CSS]);
        assert.match(sheets[0][0], /\bcrossorigin\b/, 'CORS, so the worker can store it');
        assert.match(sheets[0][0], /media="print"/, 'does not hold up the page when the network never answers');
    });

    test('the whole module graph (static + dynamic imports, three addons) is precached', () => {
        const W = makeWorker();
        const { cdn, local } = moduleGraph();
        const shell = new Set(LISTED.map(scoped));
        const precachedCdn = new Set(W.consts.CDN_PRECACHE);
        assert.deepEqual([...local].filter((u) => !shell.has(u)).map((u) => u.slice(SCOPE.length)), [], 'local modules missing from offline-files.json');
        assert.deepEqual([...cdn].filter((u) => !precachedCdn.has(u)), [], 'CDN modules missing from CDN_PRECACHE');
    });

    test('pages, classic scripts, styles, manifest icons and the AI worker are in the shell', () => {
        const W = makeWorker();
        const shell = new Set(LISTED.map(scoped));
        const want = new Set(['./', 'index.html', '2d.html', 'manifest.webmanifest', 'aiWorker.js']);
        for (const page of ['index.html', '2d.html']) {
            const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
            for (const m of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
                const u = m[1];
                if (/^(https?:)?\/\//.test(u)) continue;
                want.add(u);
            }
        }
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
        for (const i of manifest.icons) want.add(i.src);
        const missing = [...want].filter((p) => !shell.has(scoped(p)));
        assert.deepEqual(missing, []);
        const external = [];
        for (const page of ['index.html', '2d.html']) {
            for (const m of fs.readFileSync(path.join(ROOT, page), 'utf8').matchAll(/<script\b[^>]*\bsrc="(https?:[^"]+)"/g)) external.push(m[1]);
        }
        for (const u of external) assert.ok(W.consts.CDN_PRECACHE.includes(u), `external script ${u} precached`);
    });

    test('every battle3d/*.js and *.css file is in the shell (catches files added later)', () => {
        const shell = new Set(APP_SHELL);
        const files = fs.readdirSync(path.join(ROOT, 'battle3d')).filter((f) => /\.(js|css)$/.test(f)).map((f) => 'battle3d/' + f);
        assert.deepEqual(files.filter((f) => !shell.has(f)), []);
    });

    test('the AI worker and its importScripts work offline', () => {
        const shell = new Set(APP_SHELL);
        const worker = fs.readFileSync(path.join(ROOT, 'aiWorker.js'), 'utf8');
        const deps = [...worker.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
        assert.ok(deps.length > 0);
        for (const d of ['aiWorker.js', ...deps]) assert.ok(shell.has(d), d);
    });

    test('no absolute site paths in sw.js (the site lives under a subpath)', () => {
        const W = makeWorker();
        for (const p of LISTED) assert.ok(!p.startsWith('/'), p);
        assert.ok(!/['"`]\/(?!\/)[\w.-]+/.test(src.replace(/\/\/.*$/gm, '')), 'no "/path" string literals');
    });

    test('install precaches the shell, CDN modules and every cast asset, then skips waiting', async () => {
        const W = makeWorker();
        await W.dispatch('install');
        const shell = new Set([...keysOf(W, W.consts.SHELL), ...keysOf(W, W.consts.CDN)]);
        const missing = [...LISTED.map(scoped), ...W.consts.CDN_PRECACHE].filter((u) => !shell.has(u));
        assert.deepEqual(missing, [], 'precache misses');
        const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', 'manifest.json'), 'utf8'));
        const assets = new Set([m.clips.file, m.clips.skeletonFile, ...Object.values(m.models).map((x) => x.file)]);
        for (const side of Object.values(m.roles)) for (const r of Object.values(side)) { assets.add(r.model); for (const p of r.props || []) assets.add(p.file); }
        for (const l of Object.values(m.loadouts || {})) for (const p of l.props || []) assets.add(p.file);
        for (const f of [...assets]) {
            if (!f.endsWith('.gltf')) continue;
            const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', f), 'utf8'));
            for (const x of [...(j.buffers || []), ...(j.images || [])]) if (x.uri) assets.add(path.posix.join(path.posix.dirname(f), x.uri));
        }
        const missingAssets = [...assets].filter(Boolean).filter((f) => !shell.has(scoped('battle3d/assets/' + f)));
        assert.deepEqual(missingAssets, [], 'cast assets not precached');
        assert.ok(W.calls.skipWaiting >= 1);
        const notOk = W.net.log.filter((u) => { const f = localFile(u); return !VIRTUAL.has(u) && (!f || !fs.existsSync(f)); });
        assert.deepEqual(notOk, [], 'install requested URLs that do not exist');
        assert.ok(keysOf(W, W.consts.CDN).length >= W.consts.CDN_PRECACHE.length, 'CDN files in their own cache');
        assert.deepEqual(keysOf(W, W.consts.SHELL).filter((u) => !u.startsWith(ORIGIN)), [], 'only same-origin files in the shell');
    });

    test('v6 library: lines, rigs, library.json, built-in thumbs and every library pack are precached', { skip: !fs.existsSync(path.join(ROOT, 'battle3d', 'assets', 'library.json')) && 'no library.json' }, async () => {
        const W = makeWorker();
        const shell = new Set(APP_SHELL);
        const dirJson = (d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.json')).map((f) => `${d}/${f}`);
        const want = ['battle3d/assets/library.json', ...dirJson('battle3d/lines'), ...dirJson('battle3d/assets/rigs')];
        assert.ok(want.length >= 1 + 3 + 4);
        assert.deepEqual(want.filter((f) => !shell.has(f)), [], 'v6 data files missing from APP_SHELL');
        assert.deepEqual([...shell].filter((f) => f.includes('/packs/')), [], 'pack files come from library.json, not a hand-written list');
        await W.dispatch('install');
        const cached = keysOf(W, W.consts.SHELL);
        const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', 'manifest.json'), 'utf8'));
        const thumbs = Object.keys(m.models).map((id) => `battle3d/assets/thumbs/${id}.webp`);
        assert.deepEqual(thumbs.filter((t) => !fs.existsSync(path.join(ROOT, t))), [], 'built-in thumbnails exist');
        assert.deepEqual(thumbs.filter((t) => !cached.includes(scoped(t))), [], 'built-in thumbnails precached');
        // Every pack a cast can use, at the paths cast.js asks for (packs/<id>/<file>)
        const library = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', 'library.json'), 'utf8'));
        const packFiles = [];
        for (const entry of library.packs) {
            packFiles.push(entry.path, entry.thumb);
            const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'assets', entry.path), 'utf8'));
            for (const model of pack.models) packFiles.push(`packs/${pack.id}/${model.file}`, `packs/${pack.id}/${model.thumb}`);
        }
        assert.ok(packFiles.length >= 3 * 3);
        assert.deepEqual(packFiles.filter((f) => !cached.includes(scoped(`battle3d/assets/${f}`))), [], 'library pack files precached');
    });

    test('a file that fails once is retried and the install completes', async () => {
        const W = makeWorker();
        const tries = new Map();
        W.net.fail = (url) => { if (!/\/ui\.js$|Knight\.glb$|three\.core\.js$/.test(url)) return false; tries.set(url, (tries.get(url) || 0) + 1); return tries.get(url) === 1; };
        await W.dispatch('install');
        assert.equal(tries.size, 3);
        for (const [url, n] of tries) assert.equal(n, 2, `${url} asked twice`);
        assert.ok(await W.caches.match(scoped('ui.js'), { cacheName: W.consts.SHELL }));
        assert.ok(await W.caches.match(scoped(W.consts.OFFLINE_MARKER), { cacheName: W.consts.SHELL }), 'marked complete');
        assert.equal(W.calls.skipWaiting, 1);
    });

    test('an incomplete download never takes over: install fails, the previous version keeps its caches', async () => {
        const stores = new Map();
        const old = makeWorker({ stores });
        await old.dispatch('install');
        await old.dispatch('activate');
        const before = new Map([...stores].map(([name, m]) => [name, m.size]));
        // The new version changes two files, and a flaky phone network fails them. gsap is not asked for again: the
        // CDN files of the old version are kept.
        const changed = listWith({ 'battle3d/units.js': '// v99', 'battle3d/assets/characters/Knight.glb': 'glTF v99' });
        const next = makeWorker({ stores, version: '99.0.0', list: changed });
        next.net.fail = (url) => /Knight\.glb$|units\.js$/.test(url) || url.includes('cdnjs.cloudflare.com');
        await assert.rejects(next.dispatch('install'), /offline download incomplete, 2 of \d+ files missing/);
        assert.equal(next.calls.skipWaiting, 0, 'does not take over');
        assert.equal(await next.caches.match(scoped(next.consts.OFFLINE_MARKER), { cacheName: next.consts.SHELL }), undefined, 'not marked complete');
        assert.equal(next.messages.at(-1).state, 'failed');
        for (const [name, size] of before) assert.equal(stores.get(name)?.size, size, `${name} untouched`);
        assert.ok(await old.caches.match(scoped(old.consts.OFFLINE_MARKER), { cacheName: old.consts.SHELL }), 'the old version still serves offline');
        // Each failing file was tried ATTEMPTS times
        assert.equal(next.net.log.filter((u) => u.endsWith('/units.js')).length, 3);
        // The next visit tries again and completes: only the new version's caches remain after it takes over
        const retry = makeWorker({ stores, version: '99.0.0', list: changed });
        retry.net.override.set(scoped('battle3d/units.js'), async () => new FakeResponse('// v99'));
        retry.net.override.set(scoped('battle3d/assets/characters/Knight.glb'), async () => new FakeResponse('glTF v99'));
        await retry.dispatch('install');
        assert.deepEqual(sameOriginAsked(retry).sort(), ['battle3d/assets/characters/Knight.glb', 'battle3d/units.js', 'offline-files.json']);
        await retry.dispatch('activate');
        assert.deepEqual([...stores.keys()].sort(), [retry.consts.CDN, retry.consts.SHELL].sort());
    });

    test('install fails when its file list cannot be read', async () => {
        const W = makeWorker();
        W.net.override.set(scoped('offline-files.json'), async () => { throw new TypeError('offline'); });
        await assert.rejects(W.dispatch('install'), /offline-files\.json/);
        assert.equal(W.calls.skipWaiting, 0);
    });

    test('a required file the deploy does not have blocks the update; optional ones are left out and listed', async () => {
        const thumb = 'battle3d/assets/thumbs/Knight.webp', pack = 'battle3d/assets/packs/quaternius-farm/Horse.glb';
        assert.ok(OFFLINE.optional.includes(thumb) && OFFLINE.optional.includes(pack), 'thumbnails and packs are optional');
        for (const p of ['./', 'battle3d/units.js', 'battle3d/assets/characters/Knight.glb', 'battle3d/assets/anims/clips.glb']) assert.ok(!OFFLINE.optional.includes(p), `${p} is required`);
        const W = makeWorker();
        for (const p of [thumb, pack]) W.net.override.set(scoped(p), async () => new FakeResponse('not found', { status: 404 }));
        await W.dispatch('install');
        const marker = await (await W.caches.match(scoped(W.consts.OFFLINE_MARKER), { cacheName: W.consts.SHELL })).json();
        assert.deepEqual(marker.missing.sort(), [scoped(pack), scoped(thumb)].sort());
        assert.equal(W.net.log.filter((u) => u === scoped(thumb)).length, 1, 'a 404 is not retried');
        assert.equal(W.calls.skipWaiting, 1);
        const W2 = makeWorker();
        W2.net.override.set(scoped('battle3d/units.js'), async () => new FakeResponse('not found', { status: 404 }));
        await assert.rejects(W2.dispatch('install'), /units\.js: HTTP 404/);
        assert.equal(W2.calls.skipWaiting, 0);
    });

    test('fonts are optional: the install completes without them and the marker says so', async () => {
        const W = makeWorker();
        W.net.fail = (url) => url.startsWith('https://fonts.gstatic.com/');
        await W.dispatch('install');
        const marker = await (await W.caches.match(scoped(W.consts.OFFLINE_MARKER), { cacheName: W.consts.SHELL })).json();
        assert.deepEqual(marker.missing.sort(), FONT_FILES);
        assert.equal(W.calls.skipWaiting, 1);
        const W2 = makeWorker();
        W2.net.fail = (url) => url === FONTS_CSS;
        await W2.dispatch('install');
        assert.equal(W2.calls.skipWaiting, 1, 'no stylesheet: nothing to add');
    });

    test('a retried install resumes: only what the failed try could not store is downloaded', async () => {
        // The reviewer's case: the first try stores all files but one, and the deploy's ETags change in between
        const stores = new Map();
        deploy = 1;
        const a1 = makeWorker({ stores });
        a1.net.fail = (url) => url.endsWith('/battle3d/units.js');
        await assert.rejects(a1.dispatch('install'), new RegExp(`offline download incomplete, 1 of ${LISTED.length + a1.consts.CDN_PRECACHE.length} files missing`));
        assert.equal(sameOriginAsked(a1).filter((p) => p !== 'offline-files.json').length, LISTED.length + 2, 'every file once, units.js three times');
        const note = await (await a1.caches.match(scoped(a1.consts.OFFLINE_ERROR), { cacheName: a1.consts.SHELL })).json();
        assert.match(note.error, /units\.js/);
        deploy = 2;
        const a2 = makeWorker({ stores });
        await a2.dispatch('install');
        assert.deepEqual(sameOriginAsked(a2), ['offline-files.json', 'battle3d/units.js']);
        assert.deepEqual(a2.net.log.filter((u) => !u.startsWith(ORIGIN)), [], 'nor the CDN files and fonts');
        assert.ok(await a2.caches.match(scoped(a2.consts.OFFLINE_MARKER), { cacheName: a2.consts.SHELL }));
        assert.equal(await a2.caches.match(scoped(a2.consts.OFFLINE_ERROR), { cacheName: a2.consts.SHELL }), undefined, 'the error note goes');
        assert.equal(a2.calls.skipWaiting, 1);
    });

    test('an update downloads only files whose content changed (content hash, not ETag); CDN files are kept', async () => {
        const stores = new Map();
        deploy = 1;
        const old = makeWorker({ stores });
        await old.dispatch('install');
        await old.dispatch('activate');
        deploy = 2; // every ETag changes, as on GitHub Pages
        const next = makeWorker({ stores, version: '99.0.0', list: listWith({ 'ui.js': '// changed' }) });
        next.net.override.set(scoped('ui.js'), async () => new FakeResponse('// changed', { headers: { ETag: etagOf(Buffer.from('// changed')) } }));
        await next.dispatch('install');
        assert.deepEqual(sameOriginAsked(next), ['offline-files.json', 'ui.js']);
        assert.deepEqual(next.net.log.filter((u) => !u.startsWith(ORIGIN)), [], 'CDN files and fonts are not downloaded again');
        assert.equal(await (await next.caches.match(scoped('ui.js'), { cacheName: next.consts.SHELL })).text(), '// changed');
        const knight = await next.caches.match(scoped('battle3d/assets/characters/Knight.glb'), { cacheName: next.consts.SHELL });
        assert.ok(knight && knight.body.length > 1000, 'unchanged model copied into the new shell');
        await next.dispatch('activate');
        assert.ok(!stores.has(old.consts.SHELL), 'old shell deleted after the new one is complete');
        assert.ok(keysOf(next, next.consts.CDN).includes(next.consts.VRM_MODULE));
    });

    test('a cached copy whose content does not match the list is downloaded, not copied', async () => {
        const stores = new Map();
        const old = makeWorker({ stores });
        await old.dispatch('install');
        // stale-while-revalidate refreshed the active version's copy with other content than its list says
        await (await old.caches.open(old.consts.SHELL)).put(scoped('battle3d/controller.js'), new FakeResponse('// refreshed from the network'));
        const next = makeWorker({ stores, version: '99.0.0' });
        await next.dispatch('install');
        assert.deepEqual(sameOriginAsked(next), ['offline-files.json', 'battle3d/controller.js']);
        const copy = await next.caches.match(scoped('battle3d/controller.js'), { cacheName: next.consts.SHELL });
        assert.equal(hashOf(copy.body), OFFLINE.files['battle3d/controller.js']);
    });

    test('an update from v6.3 (CDN files in its shell cache) copies them instead of downloading them', async () => {
        const stores = new Map();
        const W = makeWorker({ stores });
        const old = await W.caches.open(`${W.consts.PREFIX}shell-6.3.0`);
        for (const url of W.consts.CDN_PRECACHE.filter((u) => u !== W.consts.VRM_MODULE)) await old.put(url, new FakeResponse(`// ${url}`, { type: 'cors' }));
        await W.dispatch('install');
        const cdnAsked = W.net.log.filter((u) => /jsdelivr|cdnjs/.test(u));
        assert.deepEqual(cdnAsked, [W.consts.VRM_MODULE], 'only three-vrm (new in v6.4) is downloaded');
        for (const url of W.consts.CDN_PRECACHE) assert.ok(await W.caches.match(url, { cacheName: W.consts.CDN }), url);
        await W.dispatch('activate');
        assert.ok(!stores.has(`${W.consts.PREFIX}shell-6.3.0`), 'v6.3 deleted once v6.4 is complete');
        assert.equal(await (await W.caches.match(W.consts.CDN_PRECACHE[0], { cacheName: W.consts.CDN })).text(), `// ${W.consts.CDN_PRECACHE[0]}`);
    });

    test('a download that stops sending is aborted and tried again; then the install fails', async () => {
        const W = makeWorker();
        const silent = { ok: true, status: 200, headers: new Headers(), body: null, arrayBuffer: () => new Promise(() => { }) };
        W.net.override.set(scoped('battle3d/units.js'), async () => silent); // headers arrive, the body never does
        await assert.rejects(W.dispatch('install'), /units\.js: nothing received for 30 s/);
        assert.equal(W.net.log.filter((u) => u.endsWith('/battle3d/units.js')).length, 3);
        assert.equal(W.messages.at(-1).state, 'failed');
    });

    test('the install deadline stops a slow download cleanly; the next visit resumes it', async () => {
        // Timers at 1/100: deadline 2.4 s, stall limit 0.3 s. Every file answers after 0.1 s: never stalled, but slow.
        const stores = new Map();
        const W = makeWorker({ stores, timeoutScale: 1 / 100, deadlineScale: 1 / 100 });
        W.net.delay = 100;
        await assert.rejects(W.dispatch('install'), /offline download stopped after 4 min at \d+ of \d+ files/);
        assert.equal(W.messages.at(-1).state, 'failed');
        assert.equal(W.calls.skipWaiting, 0);
        const note = await (await W.caches.match(scoped(W.consts.OFFLINE_ERROR), { cacheName: W.consts.SHELL })).json();
        assert.match(note.error, /stopped after 4 min/);
        const storedBefore = keysOf(W, W.consts.SHELL).filter((u) => !u.endsWith('.json') || !/offline-/.test(u)).length;
        assert.ok(storedBefore > 0 && storedBefore < LISTED.length, `${storedBefore} files stored before the deadline`);
        const again = makeWorker({ stores });
        await again.dispatch('install');
        const asked = sameOriginAsked(again).filter((p) => p !== 'offline-files.json').length;
        assert.ok(asked <= LISTED.length - storedBefore + 6, `resumed: ${asked} downloads after ${storedBefore} stored`);
        assert.equal(again.calls.skipWaiting, 1);
    });

    test('unfinished shells of other versions are dropped once a complete version serves; a pre-6.4 shell stays until then', async () => {
        const stores = new Map();
        const W = makeWorker({ stores });
        await (await W.caches.open(`${W.consts.PREFIX}shell-6.3.0`)).put(scoped('index.html'), new FakeResponse('<html>v6.3</html>'));
        await W.dispatch('install');
        assert.ok(stores.has(`${W.consts.PREFIX}shell-6.3.0`), 'no complete version yet: v6.3 may still be serving');
        await (await W.caches.open(`${W.consts.PREFIX}shell-0.9.9`)).put(scoped('ui.js'), new FakeResponse('// unfinished'));
        const N = makeWorker({ stores, version: '99.0.0' });
        await (await N.caches.open(N.consts.SHELL)).put(scoped('ui.js'), new FakeResponse(fs.readFileSync(path.join(ROOT, 'ui.js'))));
        await N.dispatch('install');
        assert.deepEqual([...stores.keys()].filter((k) => k.includes('shell-')).sort(), [W.consts.SHELL, N.consts.SHELL].sort());
    });

    test('a release without npm run offline-list (VERSION bumped, stamp not) never installs; the old version keeps serving', async () => {
        const stores = new Map();
        const old = makeWorker({ stores });
        await old.dispatch('install');
        await old.dispatch('activate');
        // The reviewer's stale-list case: ui.js and Knight.glb changed on the server, the list and stamp did not
        const next = makeWorker({ stores, source: (x) => x.replace(/const VERSION = '[^']+'/, "const VERSION = '6.4.1'") });
        next.net.override.set(scoped('ui.js'), async () => new FakeResponse('// ui v2'));
        next.net.override.set(scoped('battle3d/assets/characters/Knight.glb'), async () => new FakeResponse('glTF v2'));
        await assert.rejects(next.dispatch('install'), /offline-files\.json and sw\.js of this deploy do not match build/);
        assert.equal(next.calls.skipWaiting, 0);
        assert.equal(sameOriginAsked(next).filter((p) => p !== 'offline-files.json').length, 0, 'no file copied or downloaded');
        assert.equal(next.net.requests.filter((r) => r.url === `${SCOPE}sw.js`).map((r) => r.cache).join(' '), 'no-cache reload', 'checked twice, the second time past the HTTP cache');
        assert.ok(await old.caches.match(scoped(old.consts.OFFLINE_MARKER), { cacheName: old.consts.SHELL }));
    });

    test('a deploy without offline-files.json never installs', async () => {
        const W = makeWorker();
        W.net.override.set(scoped('offline-files.json'), async () => new FakeResponse('not found', { status: 404 }));
        await assert.rejects(W.dispatch('install'), /offline-files\.json: HTTP 404/);
        assert.equal(W.calls.skipWaiting, 0);
    });

    test('a list that does not belong to this worker (a deploy still spreading) gets one more try past the HTTP cache', async () => {
        const old = listWith({ 'ui.js': '// the previous deploy' });
        // The first answer comes from a stale cache; the reload gets the deployed list
        const W = makeWorker();
        W.net.override.set(scoped('offline-files.json'), async () => new FakeResponse(W.net.requests.filter((r) => r.url.endsWith('/offline-files.json')).length === 1 ? old : LIST_TEXT));
        await W.dispatch('install');
        assert.deepEqual(W.net.requests.filter((r) => r.url.endsWith('/offline-files.json')).map((r) => r.cache), ['no-cache', 'reload']);
        assert.equal(W.calls.skipWaiting, 1);
        // Still the wrong list after the reload: the install fails
        const W2 = makeWorker();
        W2.net.override.set(scoped('offline-files.json'), async () => new FakeResponse(old));
        await assert.rejects(W2.dispatch('install'), /do not match build/);
        assert.equal(W2.calls.skipWaiting, 0);
    });

    test('downloaded bytes must have their listed hash: a required file that differs fails, an optional one is kept and reported', async () => {
        const W = makeWorker();
        W.net.override.set(scoped('battle3d/units.js'), async () => new FakeResponse('// edited after npm run offline-list'));
        await assert.rejects(W.dispatch('install'), /units\.js: content does not match offline-files\.json/);
        assert.deepEqual(W.net.requests.filter((r) => r.url.endsWith('/battle3d/units.js')).map((r) => r.cache), ['no-cache', 'reload'], 'one more try past the HTTP cache');
        const thumb = 'battle3d/assets/thumbs/Knight.webp';
        const W2 = makeWorker();
        W2.net.override.set(scoped(thumb), async () => new FakeResponse('another picture'));
        await W2.dispatch('install');
        const marker = await (await W2.caches.match(scoped(W2.consts.OFFLINE_MARKER), { cacheName: W2.consts.SHELL })).json();
        assert.deepEqual(marker.mismatched, [scoped(thumb)]);
        const note = await (await W2.caches.match(scoped(W2.consts.OFFLINE_ERROR), { cacheName: W2.consts.SHELL })).json();
        assert.match(note.error, /optional files differ.*Knight\.webp/);
        assert.equal(await (await W2.caches.match(scoped(thumb), { cacheName: W2.consts.SHELL })).text(), 'another picture', 'kept');
    });

    test('an older partial download is reused before it is dropped', async () => {
        const stores = new Map();
        const W = makeWorker({ stores });
        await W.dispatch('install');
        await W.dispatch('activate');
        // Version 6.5 stored the new ui.js, then failed on coach.js; version 6.6 has the same ui.js and coach.js
        const changed = listWith({ 'ui.js': '// new ui', 'battle3d/coach.js': '// new coach' });
        const p65 = makeWorker({ stores, version: '6.5.0', list: changed });
        p65.net.override.set(scoped('ui.js'), async () => new FakeResponse('// new ui'));
        p65.net.override.set(scoped('battle3d/coach.js'), async () => { throw new TypeError('offline'); });
        await assert.rejects(p65.dispatch('install'));
        assert.ok(stores.has(p65.consts.SHELL), 'its own partial shell is kept');
        const v66 = makeWorker({ stores, version: '6.6.0', list: changed });
        v66.net.override.set(scoped('battle3d/coach.js'), async () => new FakeResponse('// new coach'));
        await v66.dispatch('install');
        assert.deepEqual(sameOriginAsked(v66), ['offline-files.json', 'battle3d/coach.js'], 'ui.js came from the 6.5 partial shell');
        assert.ok(!stores.has(p65.consts.SHELL), 'then the partial shell is dropped');
    });

    test('only the first version takes over at once; an update waits for SKIP_WAITING (the Reload) or a restart', async () => {
        const stores = new Map();
        const first = makeWorker({ stores });
        await first.dispatch('install');
        assert.equal(first.calls.skipWaiting, 1, 'no version yet: take over');
        await first.dispatch('activate');
        const next = makeWorker({ stores, version: '99.0.0', active: true });
        await next.dispatch('install');
        assert.equal(next.calls.skipWaiting, 0, 'a version serves: wait, no switch in the middle of a game');
        assert.equal(next.messages.at(-1).state, 'ready');
        assert.ok(stores.has(first.consts.SHELL), 'the serving version keeps its caches until the new one activates');
        await next.dispatch('message', { data: { type: 'SKIP_WAITING' }, source: null });
        assert.equal(next.calls.skipWaiting, 1, 'the Reload asks it to take over');
    });

    test('progress messages while downloading, then the marker; GET_STATUS answers', async () => {
        const W = makeWorker();
        await W.dispatch('install');
        const states = W.messages.map((m) => m.state);
        assert.equal(states[0], 'installing');
        assert.equal(states.at(-1), 'ready');
        const last = W.messages.at(-1);
        assert.equal(last.total, LISTED.length + W.consts.CDN_PRECACHE.length);
        assert.equal(last.done, last.total);
        assert.ok(W.messages.every((m) => m.type === 'OFFLINE_STATUS' && m.version === W.consts.VERSION));
        const marker = await (await W.caches.match(scoped(W.consts.OFFLINE_MARKER), { cacheName: W.consts.SHELL })).json();
        assert.equal(marker.version, W.consts.VERSION);
        assert.deepEqual(marker.missing, []);
        assert.equal(marker.files, last.total + 1 + FONT_FILES.length, 'files, CDN modules, the fonts stylesheet and its fonts');
        // A restarted active worker (no state in memory) knows it is ready from the marker
        const again = makeWorker({ stores: W.stores });
        const answers = [];
        await again.dispatch('message', { data: { type: 'GET_STATUS' }, source: { postMessage: (m) => answers.push(m) } });
        assert.equal(answers[0]?.state, 'ready');
    });

    test('activate deletes only older chess3d caches and claims clients', async () => {
        const W = makeWorker();
        for (const n of [`${W.consts.PREFIX}shell-0.0.1`, `${W.consts.PREFIX}runtime-0.0.1`, W.consts.SHELL, W.consts.RUNTIME, W.consts.CDN, 'other-app-cache']) await W.caches.open(n);
        const cdn = await W.caches.open(W.consts.CDN);
        const oldThree = 'https://cdn.jsdelivr.net/npm/three@0.150.0/build/three.module.js';
        for (const u of [oldThree, W.consts.CDN_PRECACHE[0], FONTS_CSS, FONT_FILES[0]]) await cdn.put(u, new FakeResponse('x', { type: 'cors' }));
        await W.dispatch('activate');
        assert.deepEqual((await W.caches.keys()).sort(), [W.consts.CDN, W.consts.RUNTIME, W.consts.SHELL, 'other-app-cache'].sort());
        assert.deepEqual((await cdn.keys()).sort(), [W.consts.CDN_PRECACHE[0], FONTS_CSS, FONT_FILES[0]].sort(), 'CDN files no version uses any more are dropped');
        assert.equal(W.calls.claim, 1);
        assert.equal(W.calls.preloadOff, 1, 'listed pages come from the shell: no navigation preload');
    });

    describe('fetch strategies', () => {
        test('navigation before a version is installed: network first, kept in RUNTIME under a query-free key, offline from there', async () => {
            const W = makeWorker();
            let r = await W.request(scoped('?debug=1'), { mode: 'navigate' });
            assert.ok(r.handled && r.response.ok);
            assert.match(await r.response.text(), /battle3d\/main\.js/);
            assert.ok(keysOf(W, W.consts.RUNTIME).includes(scoped('')), 'stored without the query string');
            assert.deepEqual(keysOf(W, W.consts.SHELL), [], 'only an install writes the shell');
            W.net.offline = true;
            r = await W.request(scoped('?nosw=1#x'), { mode: 'navigate' });
            assert.ok(r.response.ok, 'offline navigation served from cache');
            assert.match(await r.response.text(), /battle3d\/main\.js/);
        });

        test('listed pages and their scripts come from this version\'s shell, also when a newer deploy is online', async () => {
            // The first load after a deploy used to mix the new HTML (network first) with the old scripts
            const W = makeWorker();
            await W.dispatch('install');
            await W.dispatch('activate');
            W.net.override.set(scoped('index.html'), async () => new FakeResponse('<html>NEW 3D</html>'));
            W.net.override.set(scoped('battle3d/main.js'), async () => new FakeResponse('// new main'));
            const asked = W.net.log.length;
            const page = await W.request(scoped('?debug=1'), { mode: 'navigate' });
            const main = await W.request(scoped('battle3d/main.js'));
            assert.equal(await page.response.text(), fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));
            assert.equal(await main.response.text(), fs.readFileSync(path.join(ROOT, 'battle3d', 'main.js'), 'utf8'));
            assert.equal(W.net.log.length, asked, 'no network for listed files');
            // An unlisted page still goes to the network (and into RUNTIME)
            W.net.override.set(scoped('docs/notes.html'), async () => new FakeResponse('<html>notes</html>'));
            const other = await W.request(scoped('docs/notes.html'), { mode: 'navigate' });
            assert.equal(await other.response.text(), '<html>notes</html>');
            assert.ok(keysOf(W, W.consts.RUNTIME).includes(scoped('docs/notes.html')));
        });

        test('the active shell does not drift: a page load while a newer install is pending changes nothing it serves', async () => {
            // The reviewer's case: deploy 2 points the asset manifest at a model the active version does not have
            const stores = new Map();
            const W = makeWorker({ stores });
            await W.dispatch('install');
            await W.dispatch('activate');
            const before = new Map([...stores.get(W.consts.SHELL)].map(([k, r]) => [k, r.body.toString('base64')]));
            const manifest = scoped('battle3d/assets/manifest.json');
            W.net.override.set(manifest, async () => new FakeResponse('{"roles":{"w":{"n":{"model":"characters/Knight_v2.glb"}}}}'));
            W.net.override.set(scoped('ui.js'), async () => new FakeResponse('// deploy 2'));
            const pending = makeWorker({ stores, version: '99.0.0' });
            pending.net.hang = true; // the new version's download does not get far
            const install = pending.dispatch('install').catch(() => {});
            for (const u of [manifest, scoped('ui.js'), scoped('2d.html')]) await W.request(u, u.endsWith('.html') ? { mode: 'navigate' } : {});
            W.net.offline = true;
            assert.doesNotMatch(await (await W.request(manifest)).response.text(), /Knight_v2/, 'offline: still this version\'s manifest');
            const after = new Map([...stores.get(W.consts.SHELL)].map(([k, r]) => [k, r.body.toString('base64')]));
            assert.deepEqual(after, before, 'the active shell is unchanged');
            assert.deepEqual(keysOf(W, W.consts.RUNTIME), [], 'nothing listed was fetched again');
            pending.net.hang = false;
            await install;
        });

        test('navigation: hanging network falls back to the cache after the timeout', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.hang = true;
            const r = await W.request(scoped('2d.html'), { mode: 'navigate' });
            assert.ok(r.response.ok);
            assert.match(await r.response.text(), /ui\.js/);
        });

        test('navigation offline: unknown page -> the 3D game; nothing cached -> 503', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.offline = true;
            const r = await W.request(scoped('nope.html'), { mode: 'navigate' });
            assert.match(await r.response.text(), /battle3d\/main\.js/);
            const W2 = makeWorker();
            W2.net.offline = true;
            const r2 = await W2.request(scoped(''), { mode: 'navigate' });
            assert.equal(r2.response.status, 503);
        });

        test('models, images and audio: cache first (no network once cached), work offline', async () => {
            const W = makeWorker();
            const url = scoped('battle3d/assets/characters/Knight.glb');
            let r = await W.request(url);
            assert.ok(r.response.ok);
            const n = W.net.log.length;
            W.net.offline = true;
            r = await W.request(url + '?v=2');
            assert.ok(r.response.ok, 'served from cache offline (query ignored)');
            assert.equal(W.net.log.length, n, 'no network for a cached asset');
            for (const p of ['icons/icon-192.png', 'move.mp3']) {
                W.net.offline = false;
                await W.request(scoped(p));
                W.net.offline = true;
                assert.ok((await W.request(scoped(p))).response.ok, p);
            }
        });

        test('same-origin JS: listed files from the shell, never refreshed; other files stale-while-revalidate in RUNTIME', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.override.set(scoped('battle3d/controller.js'), async () => new FakeResponse('// v2'));
            for (let i = 0; i < 2; i++) assert.notEqual(await (await W.request(scoped('battle3d/controller.js'))).response.text(), '// v2');
            const other = scoped('tools/offline-list.js'); // same-origin, not listed
            assert.ok(!LISTED.includes('tools/offline-list.js'));
            W.net.override.set(other, async () => new FakeResponse('// v1'));
            assert.equal(await (await W.request(other)).response.text(), '// v1');
            W.net.override.set(other, async () => new FakeResponse('// v2'));
            assert.equal(await (await W.request(other)).response.text(), '// v1', 'answers from cache first');
            assert.equal(await (await W.request(other)).response.text(), '// v2', 'the next request gets the refreshed file');
            assert.ok(keysOf(W, W.consts.RUNTIME).includes(other) && !keysOf(W, W.consts.SHELL).includes(other));
        });

        test('three.js CDN: cache first; foreign, out-of-scope and non-GET requests are not handled', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.offline = true;
            const r = await W.request(`${W.consts.THREE_BASE}build/three.module.js`);
            assert.ok(r.handled && r.response.ok);
            assert.equal((await W.request('https://evil.example/x.js')).handled, false);
            assert.equal((await W.request(`${ORIGIN}/other-site/app.js`)).handled, false);
            assert.equal((await W.request(scoped('index.html'), { method: 'POST' })).handled, false);
        });

        test('HEAD probes are answered from the cache, also on a network that never answers', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.hang = true;
            const r = await W.request(scoped('battle3d/assets/manifest.json'), { method: 'HEAD' });
            assert.equal(r.response.status, 200);
            const miss = await W.request(scoped('battle3d/manifest.dev.json'), { method: 'HEAD' });
            assert.equal(miss.response.type, 'error', 'not cached: fails after the timeout instead of waiting forever');
        });

        test('a file that is not cached gives up on a network that never answers', async () => {
            const W = makeWorker();
            W.net.hang = true;
            await assert.rejects(W.request(scoped('battle3d/assets/packs/nope/Nope.glb')), /no answer within 15 s/);
            await assert.rejects(W.request(scoped('battle3d/nope.js')), /no answer within 15 s/);
            await assert.rejects(W.request(`${W.consts.THREE_BASE}examples/jsm/nope.js`), /no answer within 15 s/);
            const r = await W.request(scoped('nope.html'), { mode: 'navigate' });
            assert.equal(r.response.status, 503, 'an unknown page while nothing is cached');
        });

        test('a newer version that is still downloading never answers for the active one', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            (await W.caches.open(`${W.consts.PREFIX}shell-99.0.0`)).put(scoped('battle3d/units.js'), new FakeResponse('// unfinished next version'));
            W.net.offline = true;
            const r = await W.request(scoped('battle3d/units.js'));
            assert.notEqual(await r.response.text(), '// unfinished next version');
        });

        test('error responses are not cached', async () => {
            const W = makeWorker();
            W.net.override.set(scoped('battle3d/assets/characters/Gone.glb'), async () => new FakeResponse('nope', { status: 404 }));
            await W.request(scoped('battle3d/assets/characters/Gone.glb'));
            assert.equal(await W.caches.match(scoped('battle3d/assets/characters/Gone.glb')), undefined);
        });
    });
});
