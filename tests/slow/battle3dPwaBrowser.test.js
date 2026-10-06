'use strict';
// Real-browser PWA check (RUN_SLOW=1, needs Google Chrome): serves the repo on a local port, drives
// headless Chrome over the DevTools protocol (no puppeteer) and checks manifest + installability,
// service worker scope/control/cache names, offline reloads of both pages, query-free cache keys,
// an offline AI move through aiWorker.js, and the update path (VERSION bump -> old caches deleted,
// "new version" toast on an already controlled page). Based on b3d-assets' pwacheck.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ROOT } = require('../helpers/loadEngine');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!fs.existsSync(CHROME) && `Chrome not found at ${CHROME} (set CHROME_PATH)`);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.mp3': 'audio/mpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Static server for the repo; `swVersion` (if set) rewrites sw.js's VERSION to simulate a deploy.
function serve() {
    const state = { swVersion: null };
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://x');
        let p = decodeURIComponent(u.pathname);
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
        let body = fs.readFileSync(file);
        if (p === '/sw.js' && state.swVersion) body = Buffer.from(body.toString('utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${state.swVersion}'`));
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, origin: `http://localhost:${server.address().port}/` })));
}

async function chrome() {
    const port = 9400 + Math.floor(Math.random() * 400);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'b3d-pwa-'));
    const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
    let targets;
    for (let i = 0; i < 75 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) { await sleep(200); } }
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0;
    const pending = new Map(), events = [];
    ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d); });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result?.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 80)}: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
        return r.result?.result?.value;
    };
    const waitFor = async (expression, ms = 30000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { try { if (await evaluate(expression)) return true; } catch (e) { /* navigating */ } await sleep(250); }
        throw new Error(`timed out waiting for ${expression}`);
    };
    const close = async () => { ws.close(); proc.kill(); await sleep(300); fs.rmSync(profile, { recursive: true, force: true }); };
    return { send, evaluate, waitFor, events, close };
}

const cacheSummary = `(async () => { const r = {}; for (const k of await caches.keys()) r[k] = (await (await caches.open(k)).keys()).map(q => q.url); return r; })()`;

test('PWA in headless Chrome: installable, offline, query-free cache, offline AI, update path', { skip, timeout: 240000 }, async (t) => {
    const S = await serve();
    const C = await chrome();
    try {
        await C.send('Page.enable'); await C.send('Runtime.enable'); await C.send('Network.enable');
        await C.send('Page.navigate', { url: S.origin });
        await C.waitFor('document.readyState === "complete"');

        const man = await C.send('Page.getAppManifest');
        assert.deepEqual(man.result.errors, [], 'manifest parse errors');
        await C.waitFor('!!navigator.serviceWorker.controller', 60000);
        const reg = await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r && r.scope)');
        assert.equal(reg, S.origin, 'worker scope is the site root');
        const inst = await C.send('Page.getInstallabilityErrors');
        assert.deepEqual(inst.result?.installabilityErrors || [], [], 'Chrome installability errors');

        const version = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
        await C.waitFor(`caches.keys().then(k => k.includes('chess3d-shell-${version}'))`);
        const before = await C.evaluate(cacheSummary);
        const shell = before[`chess3d-shell-${version}`];
        assert.ok(shell.length > 80, `shell entries ${shell.length}`);
        t.diagnostic(`shell cache: ${shell.length} entries`);

        // Offline: 3D (debug variant), then 2D, then an AI move through the worker
        await C.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await C.send('Page.navigate', { url: S.origin + '?debug=1' });
        await C.waitFor('!!window.__b3d', 60000);
        const s3 = await C.evaluate(`({ canvas: !!document.querySelector('#stage canvas'), failed: !!window.__b3dFailed, fallback: !document.getElementById('fallback')?.hidden, turn: __b3d.state().turn })`);
        assert.deepEqual(s3, { canvas: true, failed: false, fallback: false, turn: 'w' }, '3D offline');
        const aiMove = await C.evaluate(`requestAIMove(getCurrentGameStateSnapshot(), 600).promise.then(m => m && (m.from.row + ',' + m.from.col + '>' + m.to.row + ',' + m.to.col))`);
        assert.ok(aiMove, 'AI answered offline');
        const after = await C.evaluate(cacheSummary);
        const allUrls = Object.values(after).flat();
        assert.ok(!allUrls.some((u) => u.includes('?')), `query strings in cache keys: ${allUrls.filter((u) => u.includes('?')).slice(0, 3)}`);
        await C.send('Page.navigate', { url: S.origin + '2d.html' });
        await C.waitFor('document.readyState === "complete" && !!document.querySelector("#chess-board .square")', 30000);
        assert.equal(await C.evaluate('typeof gsap'), 'object', 'gsap from the CDN precache');

        // Update path: online again, deploy a new VERSION, reload the controlled page
        await C.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await C.send('Page.navigate', { url: S.origin });
        await C.waitFor('!!navigator.serviceWorker.controller && document.readyState === "complete"', 60000);
        S.state.swVersion = version + '-next';
        await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update())');
        await C.waitFor(`caches.keys().then(k => k.includes('chess3d-shell-${version}-next') && !k.includes('chess3d-shell-${version}'))`, 90000);
        await C.waitFor(`!!document.querySelector('.b3d-toast') && /new version/i.test(document.querySelector('.b3d-toast').textContent)`, 30000);
        assert.ok(await C.evaluate(`!!document.querySelector('.b3d-toast button.primary')`), 'Reload button');
    } finally {
        await C.close();
        S.server.close();
    }
});
