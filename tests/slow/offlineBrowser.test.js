'use strict';
// Offline play of the installed app in headless Chrome (RUN_SLOW=1, needs Google Chrome and the internet for the
// CDNs). The network is cut where a phone loses it (tests/helpers/offlineNet.js): the site's port closes or stops
// answering and the CDN proxy refuses or holds every tunnel, so the service worker cannot reach anything either.
// Each offline start is a fresh app start: no tab memory cache, no HTTP cache, only what the worker stored.
//   1. Fresh install, then offline (refused, then a network that never answers): 3D and 2D start, a move by clicks,
//      the AI replies; the menu lines say "Ready to play offline." and showed the download progress before.
//   2. Update to a new version with a library-pack cast and an imported VRM avatar, then offline: the pack models
//      and the avatar load (no placeholders); the update does not download the CDN files again.
//   3. An update on a flaky connection (some files fail) does not take over: the previous version keeps serving
//      offline; back on a good connection the update completes.
//   4. The update from v6.3 itself (v6.3 served from git first, then this checkout): the first load after it is served
//      by v6.3's worker, so this checkout's pages run v6.3's scripts. 2D and 3D start, the 3D slow-boot notice stays
//      away, and that load installs this version, which waits; closing the app and opening it again switches to it.
// v6.3 failed 1 (hanging network: stuck at "Summoning the armies..."), 2 (default characters and placeholders after
// the update) and 3 (an incomplete version took over; the 3D page could not load its modules offline).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');
const { CHROME, haveChrome, sleep } = require('../helpers/headlessChrome');
const { withOfflineBrowser, offline, online } = require('../helpers/offlineNet');
const { buildHumanoid } = require('../helpers/glbFixture');
const os = require('node:os');
const { execSync } = require('node:child_process');
const { stampOf } = require('../../tools/offline-list');

// v6.3 as published (main before this release); the transition test needs it from git
const V63 = '234a2b7';
const haveV63 = (() => { try { execSync(`git cat-file -e ${V63}^{commit}`, { cwd: ROOT, stdio: 'ignore' }); return true; } catch (e) { return false; } })();

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!haveChrome() && `Chrome not found at ${CHROME} (set CHROME_PATH)`);
const SW_TEXT = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const VERSION = SW_TEXT.match(/const VERSION = '([^']+)'/)[1];
const NEXT = `${VERSION}-next`;
// Cache names carry VERSION and the build stamp: this checkout's shell, and the one of the test release
const OLD_SHELL = `chess3d-shell-${VERSION}-${stampOf(SW_TEXT)}`;
const shellOf = (version) => (version === VERSION ? `'${OLD_SHELL}'` : `(await caches.keys()).find(n => n.startsWith('chess3d-shell-${version}-'))`);
const hasShell = (version) => `(async () => !!(${shellOf(version)}))()`;

const READY_3D = `window.__b3dBooted === true && !!document.querySelector('#stage canvas') && !window.__b3dFailed`;
const READY_2D = `!!document.querySelector('#chess-board .square') && typeof SaveHost !== 'undefined'`;
const marker = (version) => `(async () => { const cacheName = ${shellOf(version)}; return !!cacheName && !!(await caches.match(new URL('offline-ready.json', location.href).href, { cacheName })); })()`;
const activeVersion = `new Promise(resolve => { const c = navigator.serviceWorker.controller; if (!c) return resolve(null);
    navigator.serviceWorker.addEventListener('message', e => e.data?.type === 'VERSION' && resolve(e.data.version)); c.postMessage({ type: 'GET_VERSION' }); setTimeout(() => resolve('no answer'), 5000); })`;
// Units on the board: how many stand in as placeholders, play a pack model, or an imported (retargeted) avatar
const UNITS = `(() => { const out = { placeholders: 0, pack: 0, avatar: 0, units: 0 }; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const u = __b3d.units.unitAt(r, c); if (!u) continue; out.units++; if (!u.proto) out.placeholders++; else if (u.proto.native) out.pack++; else if (u.proto.retarget) out.avatar++; } return out; })()`;
// Every text the offline line shows, recorded from the first moment of every page
const RECORD_STATUS = `addEventListener('DOMContentLoaded', () => { const el = document.getElementById('offline-status'); if (!el) return;
    window.__offlineTexts = []; const note = () => { if (!el.hidden && window.__offlineTexts.at(-1) !== el.textContent) window.__offlineTexts.push(el.textContent); };
    new MutationObserver(note).observe(el, { childList: true, characterData: true, subtree: true, attributes: true }); });`;

// Progress lines with the time since the test started (the browser tests run for minutes on a busy machine)
const steps = () => { const t0 = Date.now(); return (what) => console.log(`# ${Math.round((Date.now() - t0) / 1000)} s: ${what}`); };
const READY_LINE = `document.getElementById('offline-status').textContent === 'Ready to play offline.'`;

async function open(C, url, ready, ms = 90000) {
    await C.send('Page.navigate', { url });
    await C.waitFor(ready, ms);
}

// Installs the app from `url` and waits until the worker is active, controls the page and the download is complete
async function install(C, site, version = VERSION, url = site.origin) {
    await open(C, url, 'document.readyState === "complete"');
    await C.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!r && !!r.active && r.active.state === 'activated') && !!navigator.serviceWorker.controller`, 120000);
    await C.waitFor(marker(version), 60000);
}

// A complete new version waits until the page asks it to take over (the update toast's Reload does the same)
async function takeOver(C) {
    await C.waitFor('navigator.serviceWorker.getRegistration().then(r => !!r && !!r.waiting)', 180000);
    await C.evaluate(`navigator.serviceWorker.getRegistration().then(r => r.waiting.postMessage({ type: 'SKIP_WAITING' }))`);
}

// A move by clicks (e2-e4) in the 3D game, then the AI's answer
async function play3d(C) {
    await C.evaluate(`localStorage.setItem('battle3d.tipSeen', '1'); document.getElementById('speed-fast').click(); __b3d.controller.clickSquare(6, 4); __b3d.controller.clickSquare(4, 4)`);
    const end = Date.now() + 90000;
    while (Date.now() < end) {
        await C.evaluate('__b3d.step(10, 1 / 30)');
        const s = await C.evaluate('({ history: __b3d.state().history, busy: __b3d.state().busy })');
        if (s.history.length >= 2 && !s.busy) return s.history;
        await sleep(100);
    }
    throw new Error(`the AI did not answer offline: ${JSON.stringify(await C.evaluate('__b3d.state().history'))}`);
}

// The same in the 2D game (human White against the AI)
async function play2d(C) {
    await C.evaluate(`document.querySelector('#chess-board .square[data-row="6"][data-col="4"]').click(); document.querySelector('#chess-board .square[data-row="4"][data-col="4"]').click()`);
    await C.waitFor('!isAnimating && gameHistory.length === 3', 60000);
    return C.evaluate('gameHistory.slice(1).map(h => h.moveNotation)');
}

function vrmAvatar() {
    const VRM = { hips: 'hips', spine: 'spine', chest: 'chest', neck: 'neck', head: 'head', upperarml: 'leftUpperArm', lowerarml: 'leftLowerArm', handl: 'leftHand',
        upperarmr: 'rightUpperArm', lowerarmr: 'rightLowerArm', handr: 'rightHand', upperlegl: 'leftUpperLeg', lowerlegl: 'leftLowerLeg', footl: 'leftFoot', toesl: 'leftToes',
        upperlegr: 'rightUpperLeg', lowerlegr: 'rightLowerLeg', footr: 'rightFoot', toesr: 'rightToes' };
    const names = Object.fromEntries(Object.keys(VRM).map((r, i) => [r, `J_${String(i).padStart(2, '0')}`]));
    return buildHumanoid(names, {
        extendJson: (json, { jointBase, roles }) => {
            json.extensionsUsed = ['VRMC_vrm'];
            json.extensions = { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Offline Avatar', authors: ['QA'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit', violentUsage: true },
                humanoid: { humanBones: Object.fromEntries(roles.filter((r) => VRM[r]).map((r) => [VRM[r], { node: jointBase + roles.indexOf(r) }])) } } };
        },
    });
}

test('fresh install, then offline: 3D and 2D start and play against the AI, also on a network that never answers', { skip, timeout: 630000 }, () => withOfflineBrowser(async ({ C, site, proxy }) => {
    const step = steps();
    await C.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORD_STATUS });
    // A slow network for the models, so the download progress shows in the menu
    site.delayWhen((p) => (/\.(glb|webp)$/.test(p) ? 150 : 0));
    await install(C, site);
    site.delayWhen(null);
    await C.waitFor(READY_LINE, 20000);
    step('installed');
    const texts = await C.evaluate('window.__offlineTexts');
    assert.ok(texts.some((t) => /^Preparing offline play: [1-9]\d?%$/.test(t)), `progress shown while downloading: ${JSON.stringify(texts)}`);
    const caches = await C.evaluate(`(async () => { const r = {}; for (const k of await caches.keys()) r[k] = (await (await caches.open(k)).keys()).length; return r; })()`);
    assert.deepEqual(Object.keys(caches).sort(), ['chess3d-cdn', OLD_SHELL]);

    for (const mode of ['down', 'hang']) {
        await online(C, site, proxy);
        await offline(C, site, proxy, mode);
        // start_url as the installed app opens it
        const t0 = Date.now();
        await open(C, site.origin, READY_3D, 90000);
        const took = Date.now() - t0;
        step(`${mode}: 3D start_url ready in ${took} ms`);
        await C.waitFor(READY_LINE, 15000);
        await C.waitFor(`[...document.styleSheets].some(s => /fonts\\.googleapis/.test(s.href || '') && s.media.mediaText === 'all' && s.cssRules.length > 0)`, 10000);
        // The debug view of the same page to play a move
        await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`, 90000);
        assert.deepEqual(await C.evaluate(UNITS), { placeholders: 0, pack: 0, avatar: 0, units: 32 }, `${mode}: every default model loaded`);
        const moves = await play3d(C);
        assert.equal(moves[0], 'e4', `${mode}: 3D move`);
        step(`${mode}: 3D ${moves.join(' ')}`);
        await open(C, `${site.origin}2d.html`, READY_2D, 60000);
        assert.equal(await C.evaluate('typeof gsap'), 'object', `${mode}: gsap from the cache`);
        await C.waitFor(READY_LINE, 15000);
        const moves2d = await play2d(C);
        assert.equal(moves2d.length, 2, `${mode}: 2D move and AI answer`);
        step(`${mode}: 2D ${moves2d.join(' ')}`);
    }
}, { timeoutMs: 600000 }));

test('update with a library-pack cast and an imported VRM avatar, then offline: all characters load', { skip, timeout: 630000 }, () => withOfflineBrowser(async ({ C, site, proxy, deploy }) => {
    const step = steps();
    await install(C, site);
    step('installed');
    await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`);
    // White: the Quaternius adventurers pack; Black's pawns: an imported VRM avatar (IndexedDB)
    const avatar = vrmAvatar().toString('base64');
    const imported = await C.evaluate(`(async () => {
        const cast = await import('./battle3d/cast.js');
        const THREE = await import('three');
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const bytes = Uint8Array.from(atob('${avatar}'), c => c.charCodeAt(0));
        const r = await cast.importCustomModel(new File([bytes], 'OfflineAvatar.vrm'), THREE, GLTFLoader, {});
        const c = cast.presetCast('adventurers'); c.preset = 'custom'; c.roles.b.p = { model: r.id };
        localStorage.setItem('battle3d.cast.v1', JSON.stringify(c));
        return r.ok ? r.id : JSON.stringify(r.problems);
    })()`);
    assert.match(imported, /^custom:OfflineAvatar_/);
    await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`);
    assert.deepEqual(await C.evaluate(UNITS), { placeholders: 0, pack: 16, avatar: 8, units: 32 }, 'online');
    step('cast with a pack and an avatar, online');

    // A new release: the worker downloads it, takes over and deletes the old version's caches. The CDN files are
    // kept: tag one, it must come out of the update untouched (a new download would replace it).
    const tagged = await C.evaluate(`(async () => {
        const cdn = await caches.open('chess3d-cdn');
        const url = (await cdn.keys()).map(r => r.url).find(u => u.endsWith('/three.core.js'));
        const old = await cdn.match(url);
        const headers = new Headers(old.headers); headers.set('x-kept', '${VERSION}');
        await cdn.put(url, new Response(await old.blob(), { status: 200, headers }));
        return url;
    })()`);
    deploy.version = NEXT;
    const sentBefore = site.sent.length;
    await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => null)');
    await C.waitFor(marker(NEXT), 180000);
    await takeOver(C);
    await C.waitFor(`(async () => ${hasShell(NEXT)} && !(await caches.keys()).includes('${OLD_SHELL}'))()`, 60000);
    // Nothing changed but sw.js: the update copies every file from the old version's cache
    assert.deepEqual(site.sent.slice(sentBefore).map((x) => x.path).filter((p) => p !== '/sw.js'), ['/offline-files.json'], 'only the list is downloaded');
    step('updated');
    assert.equal(await C.evaluate(`caches.open('chess3d-cdn').then(c => c.match('${tagged}')).then(r => r && r.headers.get('x-kept'))`), VERSION, 'the CDN modules are kept, not downloaded again');

    await offline(C, site, proxy, 'down');
    await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`, 90000);
    assert.equal(await C.evaluate(activeVersion), NEXT);
    assert.deepEqual(await C.evaluate(UNITS), { placeholders: 0, pack: 16, avatar: 8, units: 32 }, 'offline after the update');
    assert.equal(await C.evaluate(`document.getElementById('tip').hidden || !/could not be loaded/.test(document.getElementById('tip-text').textContent)`), true, 'no "could not be loaded" notice');
    assert.equal((await play3d(C))[0], 'e4');
    step('offline: cast loaded, move played');
}, { timeoutMs: 600000 }));

test('an update on a flaky connection does not take over; the previous version keeps working offline', { skip, timeout: 630000 }, () => withOfflineBrowser(async ({ C, site, proxy, deploy }) => {
    const step = steps();
    await install(C, site);
    step('installed');
    deploy.version = NEXT;
    deploy.edits = { 'battle3d/units.js': '\n// next version\n', 'battle3d/coach.js': '\n// next version\n' };
    // The two files the new version changes keep failing (the worker retries each one)
    site.failWhen((p) => /battle3d\/(units|coach)\.js$/.test(p));
    const before = site.log.length;
    await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => null)');
    const tries = () => site.log.slice(before).filter((l) => l.endsWith('/battle3d/units.js')).length;
    for (let end = Date.now() + 120000; tries() < 3 && Date.now() < end;) await sleep(250);
    assert.ok(tries() >= 3, 'each failing file is tried three times');
    await C.waitFor(`navigator.serviceWorker.getRegistration().then(r => !r.installing && !r.waiting)`, 120000);
    await C.waitFor(READY_LINE, 20000);
    step('flaky update failed');
    assert.equal(await C.evaluate(activeVersion), VERSION, 'the old version still serves');
    assert.equal(await C.evaluate(marker(VERSION)), true);
    assert.equal(await C.evaluate(hasShell(NEXT)), true, 'the partial download is kept for the next try');
    assert.equal(await C.evaluate(marker(NEXT)), false, 'and not marked complete');

    await offline(C, site, proxy, 'down');
    await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`, 90000);
    assert.deepEqual(await C.evaluate(UNITS), { placeholders: 0, pack: 0, avatar: 0, units: 32 });
    assert.equal((await play3d(C))[0], 'e4');
    step('offline on the previous version: move played');
    await open(C, `${site.origin}2d.html`, READY_2D, 60000);
    assert.equal(await C.evaluate('typeof gsap'), 'object');

    // Back on a good connection: the update completes and takes over
    site.failWhen(null);
    await online(C, site, proxy);
    await open(C, site.origin, 'document.readyState === "complete"');
    await C.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update()).catch(() => null)');
    await C.waitFor(marker(NEXT), 180000);
    await takeOver(C);
    await C.waitFor(`(async () => ${hasShell(NEXT)} && !(await caches.keys()).includes('${OLD_SHELL}'))()`, 60000);
    assert.equal(await C.evaluate(`(async () => (await (await caches.match(new URL('battle3d/units.js', location.href).href, { cacheName: ${shellOf(NEXT)} })).text()).endsWith('// next version\\n'))()`), true, 'the new units.js');
    step('update completed on a good connection');
}, { timeoutMs: 600000 }));

test('the update from v6.3: its first load runs v6.3 scripts under the new pages, installs this version, a restart switches', { skip: skip || (!haveV63 && `git commit ${V63} (v6.3) not available`), timeout: 630000 }, async () => {
    const v63 = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-v63-'));
    try {
        execSync(`git archive ${V63} -- . ':!battle3d/assets/raw' | tar -x -C "${v63}"`, { cwd: ROOT });
        await withOfflineBrowser(async ({ C, site }) => {
            const step = steps();
            // v6.3 installed and serving
            await open(C, site.origin, 'document.readyState === "complete"');
            await C.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!r && !!r.active && r.active.state === 'activated') && !!navigator.serviceWorker.controller`, 120000);
            await C.waitFor(`caches.keys().then(k => k.includes('chess3d-shell-6.3.0'))`, 60000);
            await C.waitFor(`document.getElementById('loading').hidden`, 120000);
            step('v6.3 installed');

            // This checkout is deployed. The first loads are still served by v6.3's worker: new HTML, v6.3 scripts.
            site.setRoot(ROOT);
            const problemsBefore = C.problems().length;
            await open(C, `${site.origin}2d.html`, READY_2D, 60000);
            assert.equal(await C.evaluate(`!!document.getElementById('offline-status')`), true, 'this checkout\'s 2d.html');
            assert.equal(await C.evaluate(`document.getElementById('offline-status').hidden`), true, 'v6.3\'s install.js has no status line: hidden, nothing breaks');
            assert.equal(await C.evaluate('document.querySelectorAll("#chess-board .square").length'), 64);
            step('2D first load after the update');
            const t0 = Date.now();
            await open(C, site.origin, `document.getElementById('loading').hidden && !!document.querySelector('#stage canvas')`, 90000);
            assert.equal(await C.evaluate(`!!document.getElementById('loading-slow') && window.__b3dBooted === undefined`), true, 'this checkout\'s index.html with v6.3\'s main.js');
            await sleep(Math.max(0, 22000 - (Date.now() - t0))); // past the 20 s of the slow-boot notice
            assert.equal(await C.evaluate(`document.getElementById('loading-slow').hidden`), true, 'no "taking longer" box over a running game');
            step('3D first load after the update');
            const errors = C.problems().slice(problemsBefore).filter((p) => /SyntaxError|does not provide an export|is not a function/.test(p));
            assert.deepEqual(errors, [], 'no script errors from the mix');

            // That load installed this version, completely, and it waits: no switch under the open game
            await C.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!r && !!r.waiting)`, 180000);
            assert.equal(await C.evaluate(marker(VERSION)), true, 'complete');
            assert.equal(await C.evaluate(activeVersion), '6.3.0', 'v6.3 still serves the open page');
            step('this version installed and waiting');

            // Close the app and open it again: the waiting version takes over
            await C.send('Page.navigate', { url: 'about:blank' });
            await sleep(2000);
            await open(C, `${site.origin}?debug=1`, `!!window.__b3d && ${READY_3D}`, 90000);
            assert.equal(await C.evaluate(activeVersion), VERSION);
            assert.equal(await C.evaluate(`caches.keys().then(k => k.includes('chess3d-shell-6.3.0'))`), false, 'v6.3 caches gone');
            assert.equal((await play3d(C))[0], 'e4');
            await open(C, site.origin, READY_3D, 90000);
            await C.waitFor(READY_LINE, 20000);
            step('restarted on this version');
        }, { timeoutMs: 600000, root: v63, args: ['--disable-features=BackForwardCache'] });
    } finally {
        fs.rmSync(v63, { recursive: true, force: true });
    }
});
