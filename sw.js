// Service worker for Chess Battle 3D (index.html) and the 2D game (2d.html).
//
// RELEASE: after changing any file of the game or this worker, run `npm run offline-list`. It rewrites
// offline-files.json and the BUILD stamp below; a new stamp means a new worker with new caches. Bump VERSION too (the
// human-readable label). CI (.github/workflows/offline-list.yml) and `npm test` fail while the list or the stamp is
// stale.
//
// Offline (v6.4). Before a version takes over it stores everything either game can use offline: the same-origin
// files of OFFLINE_LIST (app shell, models, clips, props, thumbnails, library packs; written by tools/offline-list.js
// with a content hash each), the pinned CDN modules (three.js and its addons, three-vrm, gsap) and the Google Fonts
// stylesheet with its font files. Install succeeds only when every required file is stored. The first version takes
// over at once (skipWaiting + clients.claim). A newer one waits, so an open game never switches versions in the
// middle: the pages offer a Reload, which posts SKIP_WAITING, or it takes over once no page of the app is open (the
// installed app closed and opened again). When it activates it deletes the older versions' caches. If install
// fails, the previous version keeps serving from its complete caches, and the next visit resumes the download.
//   - The deployed list and this script must hash to BUILD (a deploy still spreading over the CDN, or a release
//     without `npm run offline-list`); one more try past the HTTP cache, then the install fails.
//   - A file whose content hash is unchanged is copied from a cache that already holds it (this version's own first,
//     so a retried install resumes; then older versions), so an update downloads only files whose content changed.
//     A downloaded file must have its listed hash (one more try past the HTTP cache): a required one that does not
//     fails the install, an optional one is kept and reported in the marker and OFFLINE_ERROR.
//   - Each download gets three tries; one that receives nothing for STALL_MS is aborted; the whole install stops
//     after INSTALL_DEADLINE_MS.
//   - Optional files (offline-files.json "optional": thumbnails, other weapons, library packs) that a deploy does not
//     have (HTTP 404) are left out and listed in the marker. Fonts are optional: one short try each, in parallel.
// A finished download stores OFFLINE_MARKER in the shell cache; pages read it for their "Ready to play offline" line
// and get progress from OFFLINE_STATUS messages (battle3d/install.js). A failed try leaves OFFLINE_ERROR for debugging.
//
// Caches
//   chess3d-shell-<VERSION>-<BUILD>    the listed files of this release, its list, the marker. Written only by its
//                                      install: what the active version serves never changes while it is active.
//   chess3d-runtime-<VERSION>-<BUILD>  same-origin files fetched at runtime that are not listed
//   chess3d-cdn                        CDN files and fonts. Their URLs carry the version, so they stay across releases
//                                      and are downloaded once.
// Strategies
//   listed files, pages included   from this version's shell (one version: HTML, scripts and models always match)
//   other pages                    network first (4 s timeout), cached page when offline
//   other same-origin JS/CSS/JSON  stale-while-revalidate; other models, images, audio: cache first
//   CDN modules, fonts             cache first (pinned versions never change); the fonts stylesheet stale-while-revalidate
//   HEAD (asset probes)            cache first
// A request that has to go to the network because nothing is cached gives up after NET_TIMEOUT_MS without an
// answer, so a phone on Wi-Fi without internet does not keep the loading screen waiting.
// Query strings on same-origin URLs (?debug=1, ?v=12, ?nosw=1) are ignored for cache keys, so debug or
// cache-busting links never create duplicate entries.
const VERSION = '6.4.0';
const BUILD = '19296b85f278bfcf'; // written by `npm run offline-list`: hash of offline-files.json and of this file without this line
const PREFIX = 'chess3d-';
const SHELL = `${PREFIX}shell-${VERSION}-${BUILD}`;
const RUNTIME = `${PREFIX}runtime-${VERSION}-${BUILD}`;
const CDN = `${PREFIX}cdn`;
const NAV_TIMEOUT_MS = 4000;
const NET_TIMEOUT_MS = 15000;          // no answer for a file that is not cached
const STALL_MS = 30000;                // a precache download that receives nothing for this long is aborted
const RETRY_MS = [2000, 10000];        // waits before the second and third try of a precached file
const INSTALL_DEADLINE_MS = 240000;    // the whole download; the next visit resumes it
const FONT_TIMEOUT_MS = 5000;          // fonts: one try each
const PARALLEL = 6;                    // precache downloads at a time

const THREE_BASE = 'https://cdn.jsdelivr.net/npm/three@0.186.1/';
const VRM_BASE = 'https://cdn.jsdelivr.net/npm/@pixiv/three-vrm@';
const VRM_MODULE = `${VRM_BASE}3.5.5/lib/three-vrm.module.min.js`; // = the import map and vrm.js; imports only 'three'
const FONTS_CSS = 'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&display=swap'; // = index.html
const CDN_PRECACHE = [
    `${THREE_BASE}build/three.module.js`,
    `${THREE_BASE}build/three.core.js`,
    `${THREE_BASE}examples/jsm/environments/RoomEnvironment.js`,
    `${THREE_BASE}examples/jsm/geometries/RoundedBoxGeometry.js`,
    `${THREE_BASE}examples/jsm/libs/meshopt_decoder.module.js`,
    `${THREE_BASE}examples/jsm/loaders/GLTFLoader.js`,
    `${THREE_BASE}examples/jsm/utils/BufferGeometryUtils.js`,
    `${THREE_BASE}examples/jsm/utils/SkeletonUtils.js`,
    VRM_MODULE,
    'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js',
];
// Relative to the worker's scope (the site root, e.g. /Chess-game-vibe-code/)
const OFFLINE_LIST = 'offline-files.json';   // { files: { path: hash }, optional: [path] }
const OFFLINE_MARKER = 'offline-ready.json'; // { version, build, files, missing, mismatched, completed }
const OFFLINE_ERROR = 'offline-error.json';  // { version, error, at } after a failed try (or optional files that differ)
const MEDIA = /\.(glb|gltf|bin|png|jpe?g|webp|svg|mp3|ogg|wav|woff2?)$/i;

const scoped = path => new URL(path, self.registration.scope).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Same-origin requests are cached without their query string.
function cacheKey(request) {
    const url = new URL(typeof request === 'string' ? request : request.url);
    if (url.origin !== self.location.origin) return url.href;
    url.search = '';
    url.hash = '';
    return url.href;
}

// Font files of a Google Fonts stylesheet.
function fontFiles(css) {
    return [...new Set([...String(css || '').matchAll(/url\(\s*['"]?(https:[^'")\s]+)['"]?\s*\)/g)].map(m => m[1]))];
}

// Short content hash, as tools/offline-list.js writes it (SHA-256, first 16 hex digits).
async function hashOf(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

// The build id of a list and of this worker's script (both as deployed bytes), as tools/offline-list.js stamps it. A
// byte order mark stays in, as node keeps it (ignoreBOM); --check rejects one anyway.
async function buildIdOf(listBytes, scriptBytes) {
    const scriptText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(scriptBytes);
    const script = new TextEncoder().encode('\n' + scriptText.replace(/^const BUILD = '[0-9a-f]*';/m, "const BUILD = '';"));
    const both = new Uint8Array(listBytes.length + script.length);
    both.set(listBytes);
    both.set(script, listBytes.length);
    return hashOf(both);
}

// A response to store, from a body already read (decoded, so the encoding headers go).
function storable(bytes, from) {
    const headers = new Headers(from.headers);
    headers.delete('Content-Encoding');
    headers.delete('Content-Length');
    return new Response(bytes, { status: from.status, statusText: from.statusText, headers });
}
const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

// --- install: download everything, take over only when complete ------------------------------------------------

let status = { type: 'OFFLINE_STATUS', version: VERSION, state: 'idle', done: 0, total: 0 };
let lastBroadcast = 0;
async function broadcast(next, force = false) {
    status = { ...status, ...next };
    const now = Date.now();
    if (!force && now - lastBroadcast < 250) return;
    lastBroadcast = now;
    try {
        const pages = (await self.clients.matchAll?.({ type: 'window', includeUncontrolled: true })) || [];
        for (const page of pages) page.postMessage(status);
    } catch (e) { /* no pages */ }
}

// Settles like `promise`, or fails after `ms` (a network that never answers)
function within(promise, ms, what = 'request') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s: ${what}`)), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}
// fetch() that fails when no answer arrives within `ms` (the body may still stream in afterwards)
const fetchWithin = (request, ms) => within(fetch(request), ms, request.url || request);

// One try. The answer and then the body must keep arriving: nothing for `stallMs`, or the end of the install
// (`signal`), aborts it. `cache: 'reload'` skips the HTTP cache. Returns { response, bytes }; an HTTP error carries
// its status.
async function fetchBytes(url, { signal = null, stallMs = STALL_MS, cache = 'no-cache' } = {}) {
    const sameOrigin = new URL(url).origin === self.location.origin;
    const abort = new AbortController();
    const stopped = new Promise((resolve, reject) => abort.signal.addEventListener('abort',
        () => reject(new Error(signal?.aborted ? 'install stopped' : `nothing received for ${stallMs / 1000} s`))));
    stopped.catch(() => { });
    let timer = null;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), stallMs); };
    const stop = () => abort.abort();
    signal?.addEventListener('abort', stop);
    try {
        if (signal?.aborted) throw new Error('install stopped');
        touch();
        const response = await Promise.race([fetch(new Request(url, {
            mode: sameOrigin ? 'same-origin' : 'cors', credentials: sameOrigin ? 'same-origin' : 'omit', cache, signal: abort.signal,
        })), stopped]);
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        touch();
        let bytes;
        if (typeof response.body?.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            for (;;) {
                const { done, value } = await Promise.race([reader.read(), stopped]);
                if (done) break;
                chunks.push(value);
                size += value.length;
                touch();
            }
            bytes = new Uint8Array(size);
            let at = 0;
            for (const c of chunks) { bytes.set(c, at); at += c.length; }
        } else bytes = new Uint8Array(await Promise.race([response.arrayBuffer(), stopped]));
        return { response, bytes };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
    }
}

// fetchBytes with up to three tries (RETRY_MS apart). A 404 is not retried.
async function download(url, { signal = null, cache } = {}) {
    let error = null;
    for (let attempt = 0; attempt <= RETRY_MS.length && !signal?.aborted; attempt++) {
        if (attempt) await sleep(RETRY_MS[attempt - 1]);
        try { return await fetchBytes(url, { signal, cache }); } catch (e) {
            error = e;
            if (e.status === 404) break;
        }
    }
    throw Object.assign(new Error(`${url}: ${error?.message || 'install stopped'}`), { status: error?.status });
}

// This deploy's list, checked against BUILD together with this worker's own script. A mismatch (a deploy that is
// still spreading over the CDN, or a release without `npm run offline-list`) gets one more try past the HTTP cache.
async function readList(signal) {
    for (const cache of ['no-cache', 'reload']) {
        const [list, script] = await Promise.all([download(scoped(OFFLINE_LIST), { signal, cache }), download(self.location.href, { signal, cache })]);
        if (await buildIdOf(list.bytes, script.bytes) === BUILD) {
            return { ...list, files: JSON.parse(new TextDecoder().decode(list.bytes)) };
        }
    }
    throw new Error(`${OFFLINE_LIST} and sw.js of this deploy do not match build ${BUILD || '(none)'}: run npm run offline-list before deploying`);
}

// A cached copy of `url` with this content hash, from the first of `cacheNames` that has one: { response, cacheName }
async function copyWithHash(url, hash, cacheNames) {
    for (const cacheName of cacheNames) {
        const hit = await caches.match(url, { cacheName });
        if (hit && await hashOf(new Uint8Array(await hit.clone().arrayBuffer())) === hash) return { response: hit, cacheName };
    }
    return null;
}

// Partial downloads of versions that never took over are dropped, except this version's own (it resumes). Only while
// a version with a marker serves: a pre-6.4 shell has none and may still be the one serving. Runs after the copy
// phase, so their files could still be reused.
async function dropUnfinishedShells() {
    const shells = (await caches.keys()).filter(k => k.startsWith(`${PREFIX}shell-`) && k !== SHELL);
    const marked = await Promise.all(shells.map(cacheName => caches.match(scoped(OFFLINE_MARKER), { cacheName })));
    if (!marked.some(Boolean)) return;
    await Promise.all(shells.filter((k, i) => !marked[i]).map(k => caches.delete(k)));
}

// Fonts are optional: one short try each, in parallel with the rest. The stylesheet we already have is reused (its
// font URLs carry a version). Returns { stored, missing }.
async function precacheFonts(signal) {
    const cdn = await caches.open(CDN);
    const out = { stored: 0, missing: [] };
    let css;
    try {
        const kept = await cdn.match(FONTS_CSS);
        if (kept) css = await kept.text();
        else {
            const { response, bytes } = await fetchBytes(FONTS_CSS, { signal, stallMs: FONT_TIMEOUT_MS });
            await cdn.put(FONTS_CSS, storable(bytes, response));
            css = new TextDecoder().decode(bytes);
        }
        out.stored++;
    } catch (e) {
        out.missing.push(FONTS_CSS);
        return out;
    }
    await Promise.all(fontFiles(css).map(async url => {
        try {
            if (!(await cdn.match(url))) {
                const { response, bytes } = await fetchBytes(url, { signal, stallMs: FONT_TIMEOUT_MS });
                await cdn.put(url, storable(bytes, response));
            }
            out.stored++;
        } catch (e) { out.missing.push(url); }
    }));
    return out;
}

// A listed file from the network, with its listed content. One more try past the HTTP cache when the bytes differ;
// then `mismatched` is set (the deploy changed the file without `npm run offline-list`).
async function downloadListed(job, signal) {
    let got = await download(job.url, { signal });
    if (await hashOf(got.bytes) === job.hash) return got;
    got = await download(job.url, { signal, cache: 'reload' });
    return { ...got, mismatched: await hashOf(got.bytes) !== job.hash };
}

async function precache(signal) {
    await broadcast({ state: 'installing', done: 0, total: 0, error: null }, true);
    const shell = await caches.open(SHELL), cdn = await caches.open(CDN);
    const fonts = precacheFonts(signal);
    const list = await readList(signal);
    const optional = new Set(list.files.optional || []);
    const sources = [SHELL, ...(await caches.keys()).filter(k => k.startsWith(PREFIX) && k !== SHELL && k !== CDN)];
    const jobs = [
        ...Object.entries(list.files.files || {}).map(([path, hash]) => ({ url: scoped(path), hash, optional: optional.has(path) })),
        ...CDN_PRECACHE.map(url => ({ url, cdn: true })),
    ];
    const failed = [], missing = [], mismatched = [];
    let next = 0, done = 0;
    await broadcast({ done, total: jobs.length }, true);
    const worker = async () => {
        while (next < jobs.length && !signal?.aborted) {
            const job = jobs[next++];
            try {
                if (job.cdn) {
                    // CDN files are immutable: a copy we already have (in any cache, also v6.3's shell) is kept
                    const kept = await caches.match(job.url);
                    if (!kept) {
                        const { response, bytes } = await download(job.url, { signal });
                        await cdn.put(job.url, storable(bytes, response));
                    } else if (!(await cdn.match(job.url))) await cdn.put(job.url, kept);
                } else {
                    const copy = await copyWithHash(job.url, job.hash, sources);
                    if (copy && copy.cacheName !== SHELL) await shell.put(job.url, copy.response);
                    else if (!copy) {
                        const got = await downloadListed(job, signal);
                        if (got.mismatched && !job.optional) throw new Error(`${job.url}: content does not match ${OFFLINE_LIST}`);
                        if (got.mismatched) mismatched.push(job.url);
                        await shell.put(job.url, storable(got.bytes, got.response));
                    }
                }
            } catch (e) {
                // An optional file this deploy does not have is left out; anything else keeps this version from taking over
                if (job.optional && e.status === 404) missing.push(job.url);
                else failed.push({ ...job, error: String(e?.message || e) });
            }
            await broadcast({ done: ++done });
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    await dropUnfinishedShells();
    const fontsResult = await fonts;
    // The deadline counts only when it cut something required short (fonts are optional)
    if (signal?.aborted && (done < jobs.length || failed.length)) throw new Error(`offline download stopped after ${INSTALL_DEADLINE_MS / 60000} min at ${done} of ${jobs.length} files`);
    if (failed.length) throw new Error(`offline download incomplete, ${failed.length} of ${jobs.length} files missing: ${failed.slice(0, 3).map(f => f.error).join('; ')}`);
    await shell.put(scoped(OFFLINE_LIST), storable(list.bytes, list.response));
    await shell.put(scoped(OFFLINE_MARKER), jsonResponse({
        version: VERSION, build: BUILD, files: jobs.length - missing.length + fontsResult.stored,
        missing: [...missing, ...fontsResult.missing], mismatched, completed: new Date().toISOString(),
    }));
    if (mismatched.length) await shell.put(scoped(OFFLINE_ERROR), jsonResponse({ version: VERSION, error: `optional files differ from ${OFFLINE_LIST}: ${mismatched.join(', ')}`, at: new Date().toISOString() }));
    else await shell.delete(scoped(OFFLINE_ERROR));
}

self.addEventListener('install', event => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), INSTALL_DEADLINE_MS);
    event.waitUntil(precache(deadline.signal).finally(() => clearTimeout(timer)).then(
        async () => {
            await broadcast({ state: 'ready', done: status.total }, true);
            // Only the first version takes over at once; a newer one waits for the Reload (SKIP_WAITING) or a restart
            if (!self.registration.active) await self.skipWaiting();
        },
        async error => {
            const message = String(error?.message || error);
            // For the debug view (install.js offlineReport); the pages keep showing what works
            try { await (await caches.open(SHELL)).put(scoped(OFFLINE_ERROR), jsonResponse({ version: VERSION, error: message, at: new Date().toISOString() })); } catch (e) { /* storage full */ }
            await broadcast({ state: 'failed', error: message }, true);
            throw error;
        }));
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = [SHELL, RUNTIME, CDN];
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith(PREFIX) && !keep.includes(k)).map(k => caches.delete(k)));
        // CDN files of versions no longer used (fonts are kept: their URLs come from the stylesheet)
        const cdn = await caches.open(CDN);
        const wanted = new Set(CDN_PRECACHE);
        for (const req of await cdn.keys()) {
            const url = typeof req === 'string' ? req : req.url;
            if (!wanted.has(url) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) await cdn.delete(req);
        }
        // Listed pages come from the shell: a preloaded navigation (enabled by earlier versions) would be wasted
        if (self.registration.navigationPreload) await self.registration.navigationPreload.disable().catch(() => { });
        await self.clients.claim();
    })());
});

// The active worker knows it is ready by its marker; an installing one reports its progress.
async function currentStatus() {
    if (status.state !== 'idle') return status;
    const ready = await caches.match(scoped(OFFLINE_MARKER), { cacheName: SHELL });
    return { ...status, state: ready ? 'ready' : 'idle' };
}

self.addEventListener('message', event => {
    if (event.data === 'SKIP_WAITING' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();
    if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION, build: BUILD });
    if (event.data?.type === 'GET_STATUS') event.waitUntil?.(currentStatus().then(s => event.source?.postMessage(s)));
});

// --- fetch ------------------------------------------------------------------------------------------------
// The active version answers every listed file, pages included, from its own shell, which only its install writes:
// HTML, scripts and models always come from one version, online or not. New versions arrive through a complete
// install and the pages' Reload. The network serves everything else; those copies go to RUNTIME and CDN.

const fromShell = async (request) => (await caches.match(cacheKey(request), { cacheName: SHELL })) || null;

// This version's caches only: a newer version that is still downloading must not answer for it.
async function fromCache(request) {
    const key = cacheKey(request);
    for (const cacheName of [SHELL, RUNTIME, CDN]) {
        const hit = await caches.match(key, { cacheName });
        if (hit) return hit;
    }
    return null;
}

// Runtime copies: same-origin files to RUNTIME, CDN files to CDN, never to the shell.
async function put(request, response) {
    if (!response || response.status !== 200 || (response.type !== 'basic' && response.type !== 'cors')) return;
    const key = cacheKey(request);
    await (await caches.open(new URL(key).origin === self.location.origin ? RUNTIME : CDN)).put(key, response);
}

// Pages that are not listed (or anything before a version is installed): network first, the cached copy when offline.
async function networkFirstPage(event) {
    const { request } = event;
    const network = (async () => {
        const res = await fetch(request);
        if (res.ok) await put(request, res.clone());
        return res;
    })();
    const timeout = new Promise(resolve => setTimeout(resolve, NAV_TIMEOUT_MS, null));
    try {
        const res = await Promise.race([network, timeout]);
        if (res) return res;
    } catch (e) { /* offline: fall through to the cache */ }
    const cached = await fromCache(request);
    if (cached) return cached;
    try { return await within(network, NET_TIMEOUT_MS, request.url); } catch (e) { /* still offline */ }
    // Unknown page while offline: the 3D game for the scope root, else the 2D game.
    return (await fromCache(scoped('index.html'))) || (await fromCache(scoped('2d.html'))) ||
        new Response('Offline and this page is not cached yet.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

async function staleWhileRevalidate(event) {
    const { request } = event;
    const cached = await fromCache(request);
    const update = fetchWithin(request, NET_TIMEOUT_MS).then(async res => { await put(request, res.clone()); return res; });
    if (cached) {
        event.waitUntil(update.catch(() => { }));
        return cached;
    }
    return update;
}

async function cacheFirst(request) {
    const cached = await fromCache(request);
    if (cached) return cached;
    const res = await fetchWithin(request, NET_TIMEOUT_MS);
    await put(request, res.clone());
    return res;
}

self.addEventListener('fetch', event => {
    const { request } = event;
    const url = new URL(request.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (request.method === 'HEAD' && url.origin === self.location.origin) {
        // Existence probes: the cache answers first, so they also work offline and on a network that never answers.
        event.respondWith((async () => {
            const cached = await fromCache(request);
            if (cached) return new Response(null, { status: cached.status, headers: cached.headers });
            return fetchWithin(request, NET_TIMEOUT_MS).catch(() => Response.error());
        })());
        return;
    }
    if (request.method !== 'GET') return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => (await fromShell(request)) || networkFirstPage(event))());
        return;
    }

    if (url.origin === self.location.origin) {
        if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
        event.respondWith((async () => {
            const listed = await fromShell(request);
            if (listed) return listed;
            // Media elements send Range requests: answer from the cache when we have the whole file.
            return MEDIA.test(url.pathname) ? cacheFirst(request) : staleWhileRevalidate(event);
        })());
        return;
    }

    if (request.url.startsWith(THREE_BASE) || request.url.startsWith(VRM_BASE) || url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(cacheFirst(request));
        return;
    }
    if (url.hostname === 'fonts.googleapis.com') event.respondWith(staleWhileRevalidate(event));
});
