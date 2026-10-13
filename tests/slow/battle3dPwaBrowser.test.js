'use strict';
// Real-browser PWA check (RUN_SLOW=1, needs Google Chrome): serves the repo on a local port, drives
// headless Chrome over the DevTools protocol (no puppeteer) and checks manifest + installability,
// service worker scope/control/cache names, offline reloads of both pages, query-free cache keys,
// an offline AI move through aiWorker.js, and the update path (VERSION bump -> old caches deleted,
// "new version" toast on an already controlled page). Based on b3d-assets' pwacheck.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');
// Server, Chrome and cleanup (a hard time limit, Chrome always ended, nothing left running) are shared
// with the other browser tests
const { CHROME, haveChrome, withBrowser } = require('../helpers/headlessChrome');

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!haveChrome() && `Chrome not found at ${CHROME} (set CHROME_PATH)`);

const cacheSummary = `(async () => { const r = {}; for (const k of await caches.keys()) r[k] = (await (await caches.open(k)).keys()).map(q => q.url); return r; })()`;

test('PWA in headless Chrome: installable, offline, query-free cache, offline AI, update path', { skip, timeout: 270000 }, async (t) => {
    // `swVersion` (once set) rewrites sw.js's VERSION on its way out, to simulate a deploy
    const deploy = { swVersion: null };
    const transform = (pathname, body) => (pathname === '/sw.js' && deploy.swVersion
        ? body.toString('utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${deploy.swVersion}'`) : body);
    await withBrowser(async ({ C, S }) => {
        await C.send('Network.enable');
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
        deploy.swVersion = version + '-next';
        await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update())');
        await C.waitFor(`caches.keys().then(k => k.includes('chess3d-shell-${version}-next') && !k.includes('chess3d-shell-${version}'))`, 90000);
        await C.waitFor(`!!document.querySelector('.b3d-toast') && /new version/i.test(document.querySelector('.b3d-toast').textContent)`, 30000);
        assert.ok(await C.evaluate(`!!document.querySelector('.b3d-toast button.primary')`), 'Reload button');
    }, { timeoutMs: 240000, serve: { transform } });
});
