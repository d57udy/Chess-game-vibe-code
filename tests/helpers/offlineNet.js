// Network switches for the offline browser tests. Going offline with DevTools' network emulation on the
// page alone is not offline: the service worker fetches in its own target, so it still reaches the server
// and the CDNs. These helpers cut the network where a phone loses it instead:
//   createSite()  serves the repo on a fixed local port that can be taken down (connection refused), made to
//                 hang (connected, no answer: Wi-Fi without internet) or made to fail chosen files;
//   createProxy() an HTTPS proxy (CONNECT tunnels) for the CDNs with the same switches. Start Chrome with
//                 proxyArgs(proxy): localhost bypasses the proxy, everything else goes through it.
// Both log what was asked for, so a test can tell which requests reached the network.
// withOfflineBrowser() runs a test with a site, a proxy and a Chrome that uses it, under a hard time limit.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { ROOT } = require('./loadEngine');
const { TYPES, launchChrome } = require('./headlessChrome');
const { LIST, SW, hashOf, serialize, stamp } = require('../../tools/offline-list');

const listen = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});

// Every socket a server opened, so a switch to 'down' or 'hang' also ends the keep-alive connections
function trackSockets(server) {
    const sockets = new Set();
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return () => { for (const s of sockets) s.destroy(); sockets.clear(); };
}

/**
 * The repo on a local port.
 * @param {object} [o]
 * @param {(pathname: string, body: Buffer) => Buffer|string} [o.transform] changes a file on its way out
 * @param {string} [o.root] the folder to serve (default: the repo); setRoot(dir) switches it (a deploy)
 * @returns {Promise<{ origin, port, log: string[], sent: { path, bytes }[], setMode(mode), setRoot(dir), failWhen(fn|null), delayWhen(fn|null), close() }>}
 *   mode: 'online' | 'down' (port closed) | 'hang' (accepts, never answers);
 *   failWhen(pathname => boolean): matching requests lose their connection (a flaky network);
 *   delayWhen(pathname => ms): matching requests are answered that much later (a slow network)
 */
async function createSite({ transform = null, root = ROOT } = {}) {
    let mode = 'online', fail = null, delay = null, port = 0;
    const log = [], sent = [];
    const server = http.createServer(async (req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        log.push(`${req.method} ${p}`);
        if (mode === 'hang') return; // never answered
        if (fail?.(p)) { req.socket.destroy(); return; }
        const wait = delay?.(p);
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(root, p);
        if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
        let body = fs.readFileSync(file);
        if (transform) body = transform(p, body);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : body);
        sent.push({ path: p, bytes: req.method === 'HEAD' ? 0 : body.length });
    });
    server.unref();
    const dropAll = trackSockets(server);
    port = await listen(server, 0);
    const site = {
        origin: `http://localhost:${port}/`, port, log, sent,
        async setMode(next) {
            if (next === mode) return;
            const wasDown = mode === 'down';
            mode = next;
            dropAll();
            if (next === 'down') await new Promise((resolve) => server.close(() => resolve()));
            else if (wasDown) await listen(server, port);
        },
        failWhen(fn) { fail = fn; },
        delayWhen(fn) { delay = fn; },
        setRoot(dir) { root = dir; },
        close() { mode = 'down'; dropAll(); try { server.close(); } catch (e) { /* not listening */ } },
    };
    return site;
}

/**
 * HTTPS proxy for the CDNs. Tunnels to the real hosts while online.
 * @returns {Promise<{ port, log: string[], bytes(): number, setMode(mode), blockHost(fn|null), close() }>}
 *   bytes(): what the CDNs sent through the proxy so far (TLS included)
 *   mode: 'online' | 'down' (tunnels refused) | 'hang' (tunnels never open); blockHost(host => boolean)
 */
async function createProxy() {
    let mode = 'online', block = null, received = 0;
    const log = [];
    const held = new Set();
    const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
    server.unref();
    const dropAll = trackSockets(server);
    server.on('connect', (req, client, head) => {
        const [host, port = '443'] = req.url.split(':');
        log.push(host);
        client.on('error', () => { });
        if (mode === 'hang') { held.add(client); return; }
        if (mode === 'down' || block?.(host)) { client.destroy(); return; }
        const upstream = net.connect(Number(port), host, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) upstream.write(head);
            upstream.on('data', (chunk) => { received += chunk.length; });
            upstream.pipe(client);
            client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
    });
    const port = await listen(server, 0);
    return {
        port, log,
        bytes: () => received,
        setMode(next) { mode = next; held.clear(); dropAll(); },
        blockHost(fn) { block = fn; dropAll(); },
        close() { dropAll(); try { server.close(); } catch (e) { /* not listening */ } },
    };
}

// Chrome switches that send everything but localhost through the proxy (and keep QUIC off, which a proxy cannot carry)
const proxyArgs = (proxy) => [`--proxy-server=http://127.0.0.1:${proxy.port}`, '--disable-quic'];

/**
 * A new release as `npm run offline-list` makes it, applied on the way out of the test server (a createSite
 * transform): deploy.version replaces sw.js's VERSION, deploy.edits ({ 'battle3d/units.js': '// appended' }) changes
 * files, offline-files.json gets their hashes, and sw.js is stamped for that list.
 */
function releaseTransform(deploy) {
    const edited = (file, body) => Buffer.concat([body, Buffer.from(deploy.edits[file])]);
    const listText = () => {
        const list = JSON.parse(fs.readFileSync(path.join(ROOT, LIST), 'utf8'));
        for (const f of Object.keys(deploy.edits)) {
            list.files[f] = hashOf(edited(f, fs.readFileSync(path.join(ROOT, f))));
            if (f === 'index.html') list.files['./'] = list.files[f];
        }
        return serialize(list);
    };
    return (p, body) => {
        const file = p.slice(1);
        if (!deploy.version && !Object.keys(deploy.edits).length) return body;
        if (file === SW) {
            const text = body.toString('utf8');
            return stamp(deploy.version ? text.replace(/const VERSION = '[^']+'/, `const VERSION = '${deploy.version}'`) : text, listText());
        }
        if (file === LIST) return listText();
        return deploy.edits[file] != null ? edited(file, body) : body;
    };
}

/**
 * Runs `run({ C, site, proxy, deploy })` with a site, a CDN proxy and a Chrome that goes through it, under a hard
 * time limit, and always cleans up. Setting deploy.version / deploy.edits makes a new release (releaseTransform).
 * `root` serves another folder first (site.setRoot switches), `args` adds Chrome switches.
 * offline(C, site, proxy, mode) and online(...) below switch everything at once.
 */
async function withOfflineBrowser(run, { timeoutMs = 300000, root = ROOT, args = [] } = {}) {
    const deploy = { version: null, edits: {} };
    const site = await createSite({ transform: releaseTransform(deploy), root });
    const proxy = await createProxy();
    let C = null, timer = null;
    try {
        C = await launchChrome({ args: [...proxyArgs(proxy), ...args], maxLifetimeMs: timeoutMs + 30000 });
        await C.send('Network.enable');
        const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`the offline browser test did not finish within ${timeoutMs / 1000} s`)), timeoutMs); });
        return await Promise.race([run({ C, site, proxy, deploy }), limit]);
    } finally {
        clearTimeout(timer);
        site.close();
        proxy.close();
        await C?.close();
    }
}

// The device loses its network ('down': refused at once, 'hang': connected but nothing answers). Like an app started
// again later: nothing comes from the tab's memory cache or the HTTP cache, only from the service worker.
async function offline(C, site, proxy, mode = 'down') {
    await C.send('Network.clearBrowserCache');
    await C.send('Network.setCacheDisabled', { cacheDisabled: true });
    await site.setMode(mode);
    proxy.setMode(mode);
}
async function online(C, site, proxy) {
    await C.send('Network.setCacheDisabled', { cacheDisabled: false });
    await site.setMode('online');
    proxy.setMode('online');
}

module.exports = { createSite, createProxy, proxyArgs, releaseTransform, withOfflineBrowser, offline, online };
