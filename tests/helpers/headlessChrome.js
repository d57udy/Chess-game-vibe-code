// Real-browser helpers for the slow tests: a static server for the repo and a headless Google Chrome
// driven over the DevTools protocol (no puppeteer; node 22 has WebSocket and fetch).
//
// A browser test must never hang the slow run or leave a Chrome behind, whatever goes wrong:
//   - close() ends Chrome, waits for the process to be gone, then removes its profile with retries; it can
//     be called twice and never throws (a profile that will not go away is logged, not a test failure);
//   - every protocol call fails after a timeout, and at once when Chrome dies or the connection closes;
//   - each Chrome has a maximum lifetime, after which it is killed (pending calls then fail);
//   - the server and the Chrome process are unref'd, so nothing of this keeps the test process alive;
//   - Chrome is killed when the test process exits or is interrupted;
//   - withBrowser() adds a hard time limit for the whole test and always cleans up.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ROOT } = require('./loadEngine');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.mp3': 'audio/mpeg' };
const CALL_TIMEOUT_MS = 120000;     // one protocol call (an evaluate that awaits a slow page promise included)
const MAX_LIFETIME_MS = 600000;     // one Chrome
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const haveChrome = () => fs.existsSync(CHROME);
const warn = (...args) => console.warn('headlessChrome:', ...args);

// Chromes still running, so none outlives this process (normal exit, process.exit, Ctrl+C, a runner's SIGTERM).
// The hooks are installed with the first Chrome: files that only load this module (skipped tests) get none.
const live = new Set();
let hooked = false;
function killAll() {
    for (const proc of live) { try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ } }
    live.clear();
}
function hookProcessEnd() {
    if (hooked) return;
    hooked = true;
    process.once('exit', killAll);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.once(signal, () => { killAll(); process.kill(process.pid, signal); }); // then the default: end the process
    }
}

/**
 * Serves the repo on a free local port.
 * @param {object} [o]
 * @param {(pathname: string, body: Buffer) => Buffer|string} [o.transform] changes a file on its way out
 * @returns {Promise<{ server, origin: string, close(): void }>} origin ends with "/"
 */
function serveRepo({ transform = null } = {}) {
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (p.endsWith('/')) p += 'index.html';
        const file = path.join(ROOT, p);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
        let body = fs.readFileSync(file);
        if (transform) body = transform(p, body);
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(body);
    });
    server.unref();
    // The browser's keep-alive connections would hold close() open
    const close = () => { try { server.closeAllConnections?.(); server.close(); } catch (e) { /* not listening */ } };
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, close, origin: `http://localhost:${server.address().port}/` })));
}

/**
 * Starts headless Chrome (software WebGL) with a fresh profile.
 * @param {object} [o]
 * @param {number} [o.maxLifetimeMs] Chrome is killed after this long (default 10 min)
 * @param {number} [o.callTimeoutMs] a protocol call fails after this long (default 2 min)
 * @param {string[]} [o.args] extra Chrome switches (e.g. --proxy-server for the offline tests)
 * @returns {Promise<{ send(method, params), evaluate(js), waitFor(js, ms), events, problems(), close() }>}
 *   evaluate runs as a user gesture; problems() lists uncaught exceptions and console errors so far;
 *   events are the protocol events received; close() is safe to call at any time, any number of times.
 */
async function launchChrome({ maxLifetimeMs = MAX_LIFETIME_MS, callTimeoutMs = CALL_TIMEOUT_MS, args = [] } = {}) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-browser-'));
    // Port 0: Chrome picks a free one and writes it to DevToolsActivePort, so parallel runs cannot collide
    const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...args, 'about:blank'], { stdio: 'ignore' });
    proc.unref();
    live.add(proc);
    hookProcessEnd();
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const pending = new Map(), events = [];
    let ws = null, id = 0, closing = null, gone = null;

    // Chrome died or the connection closed: nothing will answer any more
    const fail = (reason) => {
        gone ||= reason;
        for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`${reason}`)); }
        pending.clear();
    };
    exited.then(() => { live.delete(proc); fail('Chrome exited'); });
    proc.once('error', (error) => fail(`Chrome could not be started: ${error.message}`));

    // Ends Chrome, waits until it is gone (it writes its profile until then), then removes the profile
    const close = () => (closing ||= (async () => {
        clearTimeout(lifetime);
        fail('the browser was closed');
        try { ws?.close(); } catch (e) { /* ignore */ }
        try { proc.kill(); } catch (e) { /* ignore */ }
        if (await Promise.race([exited.then(() => false), sleep(5000).then(() => true)])) {
            try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
            if (await Promise.race([exited.then(() => false), sleep(3000).then(() => true)])) warn(`Chrome (pid ${proc.pid}) did not exit`);
        }
        try {
            await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (error) {
            warn(`could not remove the profile ${profile}: ${error.message}`);
        }
    })());
    const lifetime = setTimeout(() => { warn(`Chrome was still open after ${Math.round(maxLifetimeMs / 1000)} s and is closed now`); close(); }, maxLifetimeMs);
    lifetime.unref();

    try {
        let targets;
        for (let i = 0; i < 150 && !targets && !gone; i++) {
            try {
                const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
                targets = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json();
            } catch (e) { await sleep(200); }
        }
        if (!targets) throw new Error(gone || 'Chrome did not start');
        ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', () => reject(new Error('no connection to Chrome')), { once: true });
        });
    } catch (error) {
        await close();
        throw error;
    }
    ws.addEventListener('close', () => fail('the connection to Chrome closed'));
    ws.addEventListener('message', (m) => {
        const d = JSON.parse(m.data);
        const call = d.id && pending.get(d.id);
        if (call) { pending.delete(d.id); clearTimeout(call.timer); call.resolve(d); } else events.push(d);
    });

    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (gone) { reject(new Error(`${gone} (${method})`)); return; }
        const i = ++id;
        const timer = setTimeout(() => { pending.delete(i); reject(new Error(`${method} did not answer within ${callTimeoutMs / 1000} s`)); }, callTimeoutMs);
        pending.set(i, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id: i, method, params })); } catch (error) { pending.delete(i); clearTimeout(timer); reject(error); }
    });
    const evaluate = async (expression) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.result?.exceptionDetails) throw new Error(`eval failed: ${expression.slice(0, 100)}: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
        return r.result?.result?.value;
    };
    const waitFor = async (expression, ms = 30000) => {
        const end = Date.now() + ms;
        while (Date.now() < end && !gone) { try { if (await evaluate(expression)) return true; } catch (e) { /* navigating */ } await sleep(200); }
        throw new Error(gone ? `${gone} while waiting for ${expression}` : `timed out waiting for ${expression}`);
    };
    const problems = () => events.flatMap((e) => {
        if (e.method === 'Runtime.exceptionThrown') return [`exception: ${JSON.stringify(e.params.exceptionDetails).slice(0, 300)}`];
        if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') return [`console.error: ${e.params.args.map((a) => a.value || a.description).join(' ').slice(0, 300)}`];
        return [];
    });
    try {
        await send('Page.enable');
        await send('Runtime.enable');
    } catch (error) {
        await close();
        throw error;
    }
    return { send, evaluate, waitFor, events, problems, close };
}

/**
 * Runs a browser test with a server and a Chrome, under a hard time limit, and always cleans up:
 *   test('...', { skip, timeout: 330000 }, () => withBrowser(async ({ C, S }) => { ... }, { timeoutMs: 300000 }));
 * When the limit passes, the test fails with a clear message and Chrome is closed (whatever the test was
 * waiting for then fails too). Give node:test's own `timeout` a little more, as a second net.
 * @param {(ctx: { C, S }) => Promise<any>} run
 * @param {object} [o]
 * @param {number} [o.timeoutMs] default 4 min
 * @param {object} [o.serve] options for serveRepo()
 * @param {object} [o.chrome] options for launchChrome() (args)
 */
async function withBrowser(run, { timeoutMs = 240000, serve = {}, chrome = {} } = {}) {
    const S = await serveRepo(serve);
    let C = null, timer = null;
    try {
        C = await launchChrome({ ...chrome, maxLifetimeMs: timeoutMs + 30000 });
        const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`the browser test did not finish within ${timeoutMs / 1000} s`)), timeoutMs); });
        return await Promise.race([run({ C, S }), limit]);
    } finally {
        clearTimeout(timer);
        S.close();
        await C?.close();
    }
}

module.exports = { CHROME, TYPES, haveChrome, serveRepo, launchChrome, withBrowser, sleep };
