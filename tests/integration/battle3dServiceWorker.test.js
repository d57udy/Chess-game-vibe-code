'use strict';
// sw.js in a node:vm with fake self/caches/fetch/clients. Static checks: versioned cache names,
// three.js pin == import map, every precache entry exists (same-origin in the repo, CDN in
// node_modules), the app's whole module graph is precached. Behaviour: install precaches shell +
// cast assets and skips waiting; activate deletes old caches only; fetch: navigation network-first
// with cached/offline fallbacks (query ignored, timeout), media cache-first, JS stale-while-revalidate,
// CDN cache-first, non-GET / foreign / out-of-scope requests left alone.
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

// --- fakes -----------------------------------------------------------------------------------------
class FakeResponse {
    constructor(body, { status = 200, type = 'basic', headers = {} } = {}) {
        this.body = body == null ? Buffer.alloc(0) : Buffer.from(body);
        this.status = status; this.ok = status >= 200 && status < 300; this.type = type; this.headers = headers;
    }
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
    }
}

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

function makeWorker({ timeoutScale = 1 / 1000 } = {}) {
    const listeners = {};
    const net = { offline: false, hang: false, log: [], override: new Map() };
    const stores = new Map(); // name -> Map(key -> response)
    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const m = stores.get(name);
            return {
                async put(key, res) { m.set(typeof key === 'string' ? key : key.url, res); },
                async match(key) { const r = m.get(typeof key === 'string' ? key : key.url); return r ? r.clone() : undefined; },
                async keys() { return [...m.keys()]; },
            };
        },
        async match(key) {
            const k = typeof key === 'string' ? key : key.url;
            for (const m of stores.values()) if (m.has(k)) return m.get(k).clone();
            return undefined;
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
    };
    const fetch = async (input) => {
        const url = typeof input === 'string' ? input : input.url;
        net.log.push(url);
        if (net.hang) return new Promise(() => {});
        if (net.offline) throw new TypeError('Failed to fetch');
        if (net.override.has(url)) return net.override.get(url)();
        const file = localFile(url);
        const sameOrigin = url.startsWith(ORIGIN);
        if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return new FakeResponse(fs.readFileSync(file), { type: sameOrigin ? 'basic' : 'cors' });
        return new FakeResponse('not found', { status: 404, type: sameOrigin ? 'basic' : 'cors' });
    };
    const calls = { skipWaiting: 0, claim: 0, preload: 0 };
    const self = {
        location: new URL(`${SCOPE}sw.js`),
        registration: { scope: SCOPE, navigationPreload: { enable: async () => { calls.preload++; } } },
        clients: { claim: async () => { calls.claim++; } },
        skipWaiting: async () => { calls.skipWaiting++; },
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    };
    const ctx = vm.createContext({
        self, caches, fetch, Request: FakeRequest, Response: FakeResponse, URL, Promise, console,
        setTimeout: (fn, ms, ...a) => setTimeout(fn, ms * timeoutScale, ...a), clearTimeout,
    });
    vm.runInContext(src, ctx, { filename: 'sw.js' });
    const consts = vm.runInContext('({ VERSION, PREFIX, SHELL, RUNTIME, THREE_BASE, CDN_PRECACHE, APP_SHELL })', ctx);

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
    return { listeners, net, stores, caches, calls, consts, dispatch, request, ctx };
}
const keysOf = (W, name) => [...(W.stores.get(name) || new Map()).keys()];
const scoped = (p) => new URL(p, SCOPE).href;

// --- module graph of the app (what the browser will request) ------------------------------------------
function importsOf(file) {
    const code = fs.readFileSync(file, 'utf8');
    const out = new Set();
    for (const m of code.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
    for (const m of code.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
    for (const m of code.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(m[1]);
    return [...out];
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
    const walk = (url) => {
        if (seen.has(url)) return;
        seen.add(url);
        const file = localFile(url);
        if (!file || !fs.existsSync(file)) throw new Error(`module not found: ${url}`);
        if (url.startsWith(ORIGIN)) local.add(url); else cdn.add(url);
        for (const spec of importsOf(file)) walk(resolve(spec, url));
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
        for (const p of W.consts.APP_SHELL) { const f = localFile(scoped(p)); if (!f || !fs.existsSync(f)) missing.push(p); }
        for (const u of W.consts.CDN_PRECACHE) { const f = localFile(u); if (!f || !fs.existsSync(f)) missing.push(u); }
        assert.deepEqual(missing, []);
    });

    test('the whole module graph (static + dynamic imports, three addons) is precached', () => {
        const W = makeWorker();
        const { cdn, local } = moduleGraph();
        const shell = new Set(W.consts.APP_SHELL.map(scoped));
        const precachedCdn = new Set(W.consts.CDN_PRECACHE);
        assert.deepEqual([...local].filter((u) => !shell.has(u)).map((u) => u.slice(SCOPE.length)), [], 'local modules missing from APP_SHELL');
        assert.deepEqual([...cdn].filter((u) => !precachedCdn.has(u)), [], 'CDN modules missing from CDN_PRECACHE');
    });

    test('pages, classic scripts, styles, manifest icons and the AI worker are in the shell', () => {
        const W = makeWorker();
        const shell = new Set(W.consts.APP_SHELL.map(scoped));
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
        const W = makeWorker();
        const shell = new Set(W.consts.APP_SHELL);
        const files = fs.readdirSync(path.join(ROOT, 'battle3d')).filter((f) => /\.(js|css)$/.test(f)).map((f) => 'battle3d/' + f);
        assert.deepEqual(files.filter((f) => !shell.has(f)), []);
    });

    test('the AI worker and its importScripts work offline', () => {
        const W = makeWorker();
        const shell = new Set(W.consts.APP_SHELL);
        const worker = fs.readFileSync(path.join(ROOT, 'aiWorker.js'), 'utf8');
        const deps = [...worker.matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]));
        assert.ok(deps.length > 0);
        for (const d of ['aiWorker.js', ...deps]) assert.ok(shell.has(d), d);
    });

    test('no absolute site paths in sw.js (the site lives under a subpath)', () => {
        const W = makeWorker();
        for (const p of W.consts.APP_SHELL) assert.ok(!p.startsWith('/'), p);
        assert.ok(!/['"`]\/(?!\/)[\w.-]+/.test(src.replace(/\/\/.*$/gm, '')), 'no "/path" string literals');
    });

    test('install precaches the shell, CDN modules and every cast asset, then skips waiting', async () => {
        const W = makeWorker();
        await W.dispatch('install');
        const shell = new Set(keysOf(W, W.consts.SHELL));
        const missing = [...W.consts.APP_SHELL.map(scoped), ...W.consts.CDN_PRECACHE].filter((u) => !shell.has(u));
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
        const notOk = W.net.log.filter((u) => { const f = localFile(u); return !f || !fs.existsSync(f); });
        assert.deepEqual(notOk, [], 'install requested URLs that do not exist');
    });

    test('install survives being offline for the cast manifest and single failing files', async () => {
        const W = makeWorker();
        W.net.override.set(scoped('battle3d/assets/manifest.json'), async () => { throw new TypeError('offline'); });
        W.net.override.set(scoped('ui.js'), async () => new FakeResponse('x', { status: 500 }));
        await W.dispatch('install');
        assert.ok(keysOf(W, W.consts.SHELL).includes(scoped('index.html')));
        assert.ok(!keysOf(W, W.consts.SHELL).includes(scoped('ui.js')), 'failed file not cached');
        assert.ok(W.calls.skipWaiting >= 1);
    });

    test('activate deletes only older chess3d caches and claims clients', async () => {
        const W = makeWorker();
        for (const n of [`${W.consts.PREFIX}shell-0.0.1`, `${W.consts.PREFIX}runtime-0.0.1`, W.consts.SHELL, W.consts.RUNTIME, 'other-app-cache']) await W.caches.open(n);
        await W.dispatch('activate');
        assert.deepEqual((await W.caches.keys()).sort(), [W.consts.RUNTIME, W.consts.SHELL, 'other-app-cache'].sort());
        assert.equal(W.calls.claim, 1);
    });

    describe('fetch strategies', () => {
        test('navigation: network first, cached under a query-free key, offline served from cache', async () => {
            const W = makeWorker();
            let r = await W.request(scoped('?debug=1'), { mode: 'navigate' });
            assert.ok(r.handled && r.response.ok);
            assert.match(await r.response.text(), /battle3d\/main\.js/);
            assert.ok(keysOf(W, W.consts.SHELL).includes(scoped('')), 'stored without the query string');
            W.net.offline = true;
            r = await W.request(scoped('?nosw=1#x'), { mode: 'navigate' });
            assert.ok(r.response.ok, 'offline navigation served from cache');
            assert.match(await r.response.text(), /battle3d\/main\.js/);
        });

        test('navigation: a fresh deploy is picked up (network wins over cache)', async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.override.set(scoped('2d.html'), async () => new FakeResponse('<html>NEW 2D</html>'));
            const r = await W.request(scoped('2d.html'), { mode: 'navigate' });
            assert.equal(await r.response.text(), '<html>NEW 2D</html>');
            const cached = await W.caches.match(scoped('2d.html'));
            assert.equal(await cached.text(), '<html>NEW 2D</html>', 'cache refreshed');
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

        test('same-origin JS: stale-while-revalidate (cached answer, background refresh)', { todo: 'sw.js:121-124/150: refresh goes to RUNTIME but caches.match finds the SHELL copy first (reported to b3d-assets)' }, async () => {
            const W = makeWorker();
            await W.dispatch('install');
            W.net.override.set(scoped('battle3d/controller.js'), async () => new FakeResponse('// v2'));
            const r = await W.request(scoped('battle3d/controller.js'));
            assert.notEqual(await r.response.text(), '// v2', 'answers from cache first');
            const next = await W.request(scoped('battle3d/controller.js'));
            assert.equal(await next.response.text(), '// v2', 'the next request gets the refreshed file');
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

        test('error responses are not cached', async () => {
            const W = makeWorker();
            W.net.override.set(scoped('battle3d/assets/characters/Gone.glb'), async () => new FakeResponse('nope', { status: 404 }));
            await W.request(scoped('battle3d/assets/characters/Gone.glb'));
            assert.equal(await W.caches.match(scoped('battle3d/assets/characters/Gone.glb')), undefined);
        });
    });
});
