'use strict';
// Real-browser PWA check (RUN_SLOW=1, needs Google Chrome): serves the repo on a local port, drives
// headless Chrome over the DevTools protocol (no puppeteer) and checks manifest + installability,
// service worker scope/control/cache names, offline reloads of both pages, query-free cache keys,
// an offline AI move through aiWorker.js, and the update path (VERSION bump -> the new version waits and the page
// offers a Reload; Reload -> it takes over, the page reloads, the old caches are deleted). Based on b3d-assets' pwacheck.mjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');
// Server, Chrome and cleanup (a hard time limit, Chrome always ended, nothing left running) are shared
// with the other browser tests
const { CHROME, haveChrome, withBrowser } = require('../helpers/headlessChrome');
const { releaseTransform } = require('../helpers/offlineNet');
const { stampOf } = require('../../tools/offline-list');

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!haveChrome() && `Chrome not found at ${CHROME} (set CHROME_PATH)`);

const cacheSummary = `(async () => { const r = {}; for (const k of await caches.keys()) r[k] = (await (await caches.open(k)).keys()).map(q => q.url); return r; })()`;

test('PWA in headless Chrome: installable, offline, query-free cache, offline AI, update path', { skip, timeout: 270000 }, async (t) => {
    // `version` (once set) makes a new release on the way out of the server: VERSION and the build stamp of sw.js
    const deploy = { version: null, edits: {} };
    const transform = releaseTransform(deploy);
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

        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        const version = sw.match(/const VERSION = '([^']+)'/)[1];
        const shellName = `chess3d-shell-${version}-${stampOf(sw)}`; // cache names carry VERSION and the build stamp
        await C.waitFor(`caches.keys().then(k => k.includes('${shellName}'))`);
        const before = await C.evaluate(cacheSummary);
        const shell = before[shellName];
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
        // Site URLs are stored without their query (?debug=1); CDN URLs keep theirs (the fonts stylesheet's query is its name)
        const siteQueries = allUrls.filter((u) => u.startsWith(S.origin) && u.includes('?'));
        assert.deepEqual(siteQueries, [], 'query strings in site cache keys');
        await C.send('Page.navigate', { url: S.origin + '2d.html' });
        await C.waitFor('document.readyState === "complete" && !!document.querySelector("#chess-board .square")', 30000);
        assert.equal(await C.evaluate('typeof gsap'), 'object', 'gsap from the CDN precache');

        // Update path: online again, deploy a new VERSION, reload the controlled page
        await C.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await C.send('Page.navigate', { url: S.origin });
        await C.waitFor('!!navigator.serviceWorker.controller && document.readyState === "complete"', 60000);
        deploy.version = version + '-next';
        await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update())');
        // The complete new version waits (no switch in the middle of a game) and the page offers a Reload
        await C.waitFor(`!!document.querySelector('.b3d-toast') && /new version/i.test(document.querySelector('.b3d-toast').textContent)`, 90000);
        assert.ok(await C.evaluate(`caches.keys().then(k => k.includes('${shellName}'))`), 'the serving version keeps its caches meanwhile');
        assert.ok(await C.evaluate(`!!document.querySelector('.b3d-toast button.primary')`), 'Reload button');
        // Reload: the new version takes over, the page reloads under it, the old caches go
        await C.evaluate(`document.querySelector('.b3d-toast button.primary').click()`);
        await C.waitFor(`caches.keys().then(k => k.some(n => n.startsWith('chess3d-shell-${version}-next-')) && !k.includes('${shellName}'))`, 90000);
        await C.waitFor('!!navigator.serviceWorker.controller && document.readyState === "complete" && !document.querySelector(".b3d-toast")', 60000);
    }, { timeoutMs: 240000, serve: { transform } });
});
