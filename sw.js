// Service worker for Chess Battle 3D (index.html) and the 2D game (2d.html).
//
// RELEASE: bump VERSION on every deploy that changes files. The new worker precaches everything again,
// takes over open pages (skipWaiting + clients.claim) and deletes the caches of older versions.
// Strategies:
//   navigations / HTML        network first (4 s timeout), cached page when offline
//   same-origin JS/CSS/JSON   stale-while-revalidate
//   models, images, audio     cache first (runtime cache)
//   three.js @0.186.1, gsap   cache first (pinned versions never change)
//   Google Fonts              stale-while-revalidate
// Query strings on same-origin URLs (?debug=1, ?v=12, ?nosw=1) are ignored for cache keys, so debug or
// cache-busting links never create duplicate entries.
const VERSION = '5.0.0';
const PREFIX = 'chess3d-';
const SHELL = `${PREFIX}shell-${VERSION}`;
const RUNTIME = `${PREFIX}runtime-${VERSION}`;
const NAV_TIMEOUT_MS = 4000;

const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
const CDN_PRECACHE = [
    `${THREE_BASE}build/three.module.js`,
    `${THREE_BASE}build/three.core.js`,
    `${THREE_BASE}examples/jsm/environments/RoomEnvironment.js`,
    `${THREE_BASE}examples/jsm/geometries/RoundedBoxGeometry.js`,
    `${THREE_BASE}examples/jsm/libs/meshopt_decoder.module.js`,
    `${THREE_BASE}examples/jsm/loaders/GLTFLoader.js`,
    `${THREE_BASE}examples/jsm/utils/BufferGeometryUtils.js`,
    `${THREE_BASE}examples/jsm/utils/SkeletonUtils.js`,
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js',
];

// App shell, relative to the worker's scope (the site root, e.g. /Chess-game-vibe-code/).
const APP_SHELL = [
    './', 'index.html', '2d.html', 'battle3d.html', 'manifest.webmanifest',
    'gameLogic.js', 'aiPlayer.js', 'aiClient.js', 'aiWorker.js', 'ui.js', 'battleFx.js', 'style.css',
    'move.mp3', 'capture.mp3', 'check.mp3', 'game-over.mp3',
    'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png',
    'icons/apple-touch-icon.png', 'icons/favicon-32.png', 'icons/favicon.svg', 'icons/icon.svg',
    'battle3d/main.js', 'battle3d/controller.js', 'battle3d/rules.js', 'battle3d/audio.js',
    'battle3d/scene.js', 'battle3d/scene-rig.js', 'battle3d/scene-world.js', 'battle3d/scene-fx.js',
    'battle3d/scene-textures.js', 'battle3d/cinematic.js', 'battle3d/units.js', 'battle3d/fights.js',
    'battle3d/unit-visuals.js', 'battle3d/cast.js', 'battle3d/cast-ui.js', 'battle3d/install.js',
    'battle3d/hud.css', 'battle3d/cast.css', 'battle3d/install.css',
    'battle3d/assets/manifest.json',
];
const ASSET_MANIFEST = 'battle3d/assets/manifest.json';

const scoped = path => new URL(path, self.registration.scope).href;

// Same-origin requests are cached without their query string.
function cacheKey(request) {
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return request.url;
    url.search = '';
    url.hash = '';
    return url.href;
}

// Every model, clip file and prop the cast can use (the editor can pick any of them), read from the asset
// manifest so new casts need no worker change.
async function castAssets() {
    const res = await fetch(scoped(ASSET_MANIFEST), { cache: 'no-cache' });
    const m = await res.json();
    const base = scoped('battle3d/assets/');
    const files = new Set();
    for (const f of [m.clips?.file, m.clips?.skeletonFile]) if (f) files.add(f);
    for (const model of Object.values(m.models || {})) if (model.file) files.add(model.file);
    for (const side of Object.values(m.roles || {})) for (const role of Object.values(side)) {
        if (role.model) files.add(role.model);
        for (const p of role.props || []) files.add(p.file);
    }
    for (const l of Object.values(m.loadouts || {})) for (const p of l.props || []) files.add(p.file);
    const urls = [...files].map(f => new URL(f, base).href);
    // glTF props reference a .bin and a texture next to them.
    const extra = await Promise.all(urls.filter(u => u.endsWith('.gltf')).map(async u => {
        try {
            const j = await (await fetch(u)).json();
            return [...(j.buffers || []), ...(j.images || [])].filter(x => x.uri && !x.uri.startsWith('data:')).map(x => new URL(x.uri, u).href);
        } catch (e) { return []; }
    }));
    return [...new Set([...urls, ...extra.flat()])];
}

async function precache() {
    const cache = await caches.open(SHELL);
    let assets = [];
    try { assets = await castAssets(); } catch (e) { /* offline install: shell only */ }
    const urls = [...APP_SHELL.map(scoped), ...assets, ...CDN_PRECACHE];
    // One missing file must not abort the install; the runtime caches fill gaps later.
    await Promise.allSettled(urls.map(async url => {
        const req = new Request(url, { cache: 'reload', mode: url.startsWith(self.location.origin) ? 'same-origin' : 'cors', credentials: 'omit' });
        const res = await fetch(req);
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        await cache.put(cacheKey(req), res);
    }));
}

self.addEventListener('install', event => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== SHELL && k !== RUNTIME).map(k => caches.delete(k)));
        if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => { });
        await self.clients.claim();
    })());
});

self.addEventListener('message', event => {
    if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();
    if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION });
});

async function fromCache(request) {
    const key = cacheKey(request);
    return (await caches.match(key)) || null;
}

// Refreshed copies go into the cache that already holds the key (caches.match() searches SHELL first, so a
// newer RUNTIME copy of a precached file would never be served).
async function put(request, response, cacheName = RUNTIME) {
    if (!response || response.status !== 200 || (response.type !== 'basic' && response.type !== 'cors')) return;
    const key = cacheKey(request);
    const shell = await caches.open(SHELL);
    const cache = cacheName === SHELL || (await shell.match(key)) ? shell : await caches.open(cacheName);
    await cache.put(key, response);
}

async function networkFirstPage(event) {
    const { request } = event;
    const network = (async () => {
        const preload = await event.preloadResponse;
        const res = preload || await fetch(request);
        if (res.ok) await put(request, res.clone(), SHELL);
        return res;
    })();
    const timeout = new Promise(resolve => setTimeout(resolve, NAV_TIMEOUT_MS, null));
    try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
    } catch (e) { /* offline: fall through to the cache */ }
    const cached = await fromCache(request);
    if (cached) return cached;
    try { return await network; } catch (e) { /* still offline */ }
    // Unknown page while offline: the 3D game for the scope root, else the 2D game.
    return (await caches.match(scoped('index.html'))) || (await caches.match(scoped('2d.html'))) ||
        new Response('Offline and this page is not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function staleWhileRevalidate(event) {
    const { request } = event;
    const cached = await fromCache(request);
    const update = fetch(request).then(async res => { await put(request, res.clone()); return res; });
    if (cached) {
        event.waitUntil(update.catch(() => { }));
        return cached;
    }
    return update;
}

async function cacheFirst(request) {
    const cached = await fromCache(request);
    if (cached) return cached;
    const res = await fetch(request);
    await put(request, res.clone());
    return res;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (request.method === 'HEAD' && url.origin === self.location.origin) {
        // Existence probes (main.js checks which asset manifest exists) still answer offline.
        event.respondWith(fetch(request).catch(async () => {
            const cached = await fromCache(request);
            return cached ? new Response(null, { status: cached.status, headers: cached.headers }) : Response.error();
        }));
        return;
    }
    if (request.method !== 'GET') return;

    if (request.mode === 'navigate') { event.respondWith(networkFirstPage(event)); return; }

    if (url.origin === self.location.origin) {
        if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
        if (/\.(glb|gltf|bin|png|jpe?g|webp|svg|mp3|ogg|wav|woff2?)$/i.test(url.pathname)) {
            // Media elements send Range requests: answer from the cache when we have the whole file.
            event.respondWith(cacheFirst(request));
            return;
        }
        event.respondWith(staleWhileRevalidate(event));
        return;
    }

    if (request.url.startsWith(THREE_BASE) || url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(cacheFirst(request));
        return;
    }
    if (url.hostname === 'fonts.googleapis.com') event.respondWith(staleWhileRevalidate(event));
});
