// Boot for the 3D battle game: scene, audio, units, controller, cast editor, legend, first-run tip.
// Debug hooks (window.__b3d) only with ?debug=1.
import * as THREE from 'three';
import { createScene } from './scene.js';
import { createUnits } from './units.js';
import { createController } from './controller.js';
import { createCommentary } from './commentary.js';
import { createCoach } from './coach.js';
import { createAudio } from './audio.js';

const g = globalThis; // classic-script globals from gameLogic.js / rules.js
const MANIFESTS = ['battle3d/assets/manifest.json', 'battle3d/manifest.dev.json'];
const ASSET_BASE = new URL('battle3d/assets/', location.href).href; // library.json and packs/ live here
const TIP_KEY = 'battle3d.tipSeen';
// Longest wait for an answer to one file or module of the boot. The service worker answers cached files at once and
// gives up on the network itself; this covers a first visit without it on a network that never answers. Generous,
// so that a slow connection or a busy phone is never cut off.
const BOOT_WAIT_MS = 30000;
const TYPE_ORDER = ['k', 'q', 'r', 'b', 'n', 'p'];
const TYPE_NAMES = { k: 'King', q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight', p: 'Pawn' };
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const LOADING_HINTS = [
    'Heroes (White) against skeletons (Black). Every capture is a fight.',
    'Bishops cast spells from a distance. Knights leap.',
    'Press Space to skip a fight. Switch Battles to Fast for quick games.',
    'Use Cast to choose which character plays each piece.'
];

// Start loading install.js right away: it must be listening before Chrome fires `beforeinstallprompt`,
// which can happen while the models are still loading. Dynamic so a missing file cannot break the boot.
const pwaReady = import('./install.js').catch(() => null);

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const log = (...args) => { if (debug) console.log('[b3d]', ...args); };
const $ = (id) => document.getElementById(id);

// --- Loading screen ---
const loading = $('loading');
const progressEl = loading.querySelector('.progress');
let hintIndex = 0;
const hintTimer = setInterval(() => {
    hintIndex = (hintIndex + 1) % LOADING_HINTS.length;
    $('loading-hint').textContent = LOADING_HINTS[hintIndex];
}, 3500);

function setProgress(fraction, text) {
    const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
    $('loading-bar').style.width = pct + '%';
    progressEl.setAttribute('aria-valuenow', String(pct));
    if (text) $('loading-text').textContent = text;
}

function hideLoading() {
    clearInterval(hintTimer);
    loading.classList.add('fade');
    setTimeout(() => { loading.hidden = true; }, 600);
}

function showBootError(error) {
    console.error('battle3d: boot failed', error);
    window.__b3dBootError = true; // the slow-boot notice (index.html) stays away
    clearInterval(hintTimer);
    loading.hidden = false;
    loading.classList.remove('fade');
    loading.classList.add('error');
    $('loading-slow')?.setAttribute('hidden', '');
    $('loading-text').textContent = navigator.onLine === false
        ? 'The 3D battle could not start offline. Open it once while online, or play the 2D game.'
        : 'Something went wrong while loading the 3D battle. Try reloading, or play the 2D game.';
    if (!loading.querySelector('.back')) {
        const link = document.createElement('a');
        link.className = 'btn primary back';
        link.href = '2d.html';
        link.textContent = 'Play the 2D game';
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'btn back';
        reload.textContent = 'Reload';
        reload.addEventListener('click', () => (window.__b3dReload ? window.__b3dReload() : location.reload()));
        $('loading-text').after(link, ' ', reload);
    }
    // A newer complete version waits: switch to it now. A reload alone would get this broken version again, and the
    // update toast sits under the loading screen. No game is in progress, and nothing waits after the switch.
    pwaReady.then(pwa => pwa?.updateIfWaiting?.()).catch(() => { });
}

// GLTFLoader uses the default loading manager unless given another one
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => {
    if (total > 0) setProgress(0.15 + 0.8 * (loaded / total), `Summoning the armies... ${loaded}/${total}`);
};

// Settles like `promise`, or fails after `ms`
function within(promise, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
        promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

// fetch() that gives up when no answer arrives within BOOT_WAIT_MS
function fetchWithin(url, options = {}) {
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => abort?.abort(), BOOT_WAIT_MS);
    return within(fetch(url, { ...options, signal: abort?.signal }), BOOT_WAIT_MS, url).finally(() => clearTimeout(timer));
}

async function fetchJson(url) {
    try {
        const response = await fetchWithin(url);
        return response.ok ? await within(response.json(), BOOT_WAIT_MS, url) : null;
    } catch (e) {
        return null;
    }
}

// The production asset manifest, or the dev one where it does not exist. A request that fails gets a second try.
async function pickManifest() {
    for (const url of MANIFESTS) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await fetchWithin(url);
                if (!response.ok) break; // not here: the next one
                return { url, manifest: await within(response.json(), BOOT_WAIT_MS, url) };
            } catch (e) { log('manifest', url, e); }
        }
    }
    return { url: MANIFESTS[0], manifest: null }; // let units.js report the error
}

// Optional modules from other agents: the game still runs without them
async function optionalImport(path) {
    try { return await within(import(path), BOOT_WAIT_MS, path); } catch (e) { log('optional module missing', path, e); return null; }
}

// --- Who's who legend ---
function legendEntries(units, manifest) {
    const fromUnits = typeof units.getLegend === 'function' ? units.getLegend() : null;
    if (Array.isArray(fromUnits) && fromUnits.length) return fromUnits;
    const entries = [];
    for (const color of ['w', 'b']) {
        for (const type of TYPE_ORDER) {
            const role = manifest?.roles?.[color]?.[type];
            if (!role) continue;
            const model = String(role.model || '').split('/').pop().replace(/\.(glb|gltf)$/i, '').replace(/_/g, ' ');
            entries.push({ color, type, name: role.name || model, model });
        }
    }
    return entries;
}

function renderLegend(units, manifest) {
    const tbody = $('legend').querySelector('tbody');
    tbody.textContent = '';
    const entries = legendEntries(units, manifest);
    for (const type of TYPE_ORDER) {
        const tr = document.createElement('tr');
        const piece = document.createElement('td');
        piece.className = 'glyph-cell';
        piece.textContent = GLYPH[type];
        const label = document.createElement('span');
        label.textContent = TYPE_NAMES[type];
        piece.append(label);
        tr.append(piece);
        for (const color of ['w', 'b']) {
            const td = document.createElement('td');
            const entry = entries.find(e => e.color === color && e.type === type);
            td.textContent = entry ? (entry.name || entry.model || '?') : '-';
            if (entry?.model && entry.model !== entry.name) td.title = entry.model;
            tr.append(td);
        }
        tbody.append(tr);
    }
}

// --- Cast editor ---
function setupCast({ units, manifest, castMod, controller, sceneAPI }) {
    const modal = $('cast-modal');
    const mount = $('cast-mount');
    const openButton = $('cast-open');
    let editor = null;
    let current = castMod?.loadUserCast?.() || null;

    if (!castMod || typeof units.setCast !== 'function' || !manifest) {
        openButton.disabled = true;
        openButton.title = 'Cast editor not available in this build';
        return;
    }

    // Applies run one at a time (a double click or a quick second Apply must not interleave two rebuilds).
    // prepareCast is idempotent: it loads every pack the cast uses (models and mounts) before resolveRoles,
    // so a live Apply builds the same units as a reload. Failures leave the defaults in place and say so.
    let queue = Promise.resolve();
    function apply(cast) {
        const run = queue.then(() => applyNow(cast));
        queue = run.catch(() => {});
        return run;
    }

    async function applyNow(cast) {
        current = cast;
        castMod.saveUserCast?.(cast);
        let failed = [];
        try {
            ({ failed = [] } = await castMod.prepareCast?.(cast, { assetBase: ASSET_BASE }) || {});
        } catch (error) {
            failed = [{ id: 'library', error: String(error?.message || error) }];
        }
        if (controller.state().moving) controller.skip();
        controller.clearRings();
        let ok = true;
        try {
            await units.setCast(castMod.resolveRoles(manifest, cast));
            units.syncBoard(g.battle3dState().board);
        } catch (error) {
            ok = false;
            console.error('battle3d: applying the cast failed', error);
        }
        controller.forgetRings(); // units were rebuilt; their old decorations are gone
        controller.refresh();
        renderLegend(units, manifest);
        // Draw the rebuilt board now (a zero-length frame poses the new units, then renders): with rAF
        // paused (background tab) the canvas would otherwise keep showing the old cast.
        try { sceneAPI?.stepFrames?.(1, 0); } catch (e) { /* ignore */ }
        sceneAPI?.requestRender?.();
        if (!ok) showNotice('The new cast could not be built. Reload the page to try again.', { force: true });
        else if (failed.length) showNotice(`Could not download ${failed.map(f => f.id).join(', ')}. Those pieces use the default characters.`, { force: true });
        return { ok, failed };
    }

    function close() {
        modal.hidden = true;
        try { editor?.destroy?.(); } catch (e) { /* ignore */ }
        editor = null;
        openButton.focus();
    }

    async function open() {
        modal.hidden = false;
        mount.innerHTML = '<p class="muted">Loading the cast editor...</p>';
        const ui = await optionalImport('./cast-ui.js');
        if (modal.hidden) return;
        if (!ui?.mountCastEditor) {
            mount.innerHTML = '<p class="muted">The cast editor could not be loaded.</p>';
            return;
        }
        mount.textContent = '';
        editor = ui.mountCastEditor(mount, {
            manifest,
            cast: current,
            assetBase: ASSET_BASE,
            onApply: async (cast) => { await apply(cast); close(); }
        });
        $('cast-close').focus();
    }

    openButton.addEventListener('click', open);
    $('cast-close').addEventListener('click', close);
    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !modal.hidden) close(); });

    return { apply, initial: current };
}

// Notices, the coach card and the install / update toasts stand in one column at the bottom centre (hud.css
// .bottom-stack), so none of them covers another
const bottomStack = () => document.querySelector('.bottom-stack') || document.body;

// --- First-run tip ---
// Short notice in the tip panel (when the first-run tip is not showing, unless forced)
let noticeTimer = null;
function showNotice(text, { force = false, seconds = 8 } = {}) {
    const tip = $('tip');
    if (!tip.hidden && !force) return;
    $('tip-text').textContent = text;
    tip.hidden = false;
    const hide = () => { tip.hidden = true; };
    $('tip-close').addEventListener('click', hide, { once: true });
    clearTimeout(noticeTimer); // an older notice's timer must not hide this one early
    noticeTimer = setTimeout(hide, seconds * 1000);
}

function showFirstRunTip(sceneAPI) {
    let seen = false;
    try { seen = localStorage.getItem(TIP_KEY) === '1'; } catch (e) { /* ignore */ }
    if (seen) return;
    const tip = $('tip');
    const coarse = sceneAPI.isCoarsePointer?.() ?? matchMedia?.('(pointer: coarse)').matches;
    const text = `${coarse ? 'Tap' : 'Click'} a hero, then a highlighted square.`;
    $('tip-text').textContent = text;
    tip.hidden = false;
    const dismiss = () => {
        if ($('tip-text').textContent === text) tip.hidden = true; // a later notice in the same panel stays
        try { localStorage.setItem(TIP_KEY, '1'); } catch (e) { /* ignore */ }
        $('stage').removeEventListener('pointerup', onStage);
    };
    let clicks = 0;
    const onStage = () => { if (++clicks >= 2) dismiss(); }; // after selecting and moving
    $('tip-close').addEventListener('click', dismiss);
    $('stage').addEventListener('pointerup', onStage);
    setTimeout(dismiss, 20000);
}

async function boot() {
    if (window.__b3dFailed) return; // WebGL2 check failed, fallback is showing
    setProgress(0.05, 'Building the board...');
    g.battle3dNewGame();

    const sceneAPI = await createScene($('stage'), { debug });
    setProgress(0.15, 'Summoning the armies...');
    // Requests started in the same task that ends the module's first run failed at once in Chrome ("Failed to fetch"
    // without reaching the server; also the old manifest probe). A failed module import stays failed for the page,
    // so let one task pass first.
    await new Promise(resolve => setTimeout(resolve, 0));

    const audio = createAudio();
    audio.setListener?.(sceneAPI.camera); // stereo pan and distance follow the camera; units drive setSlowMo
    const [{ url: manifestUrl, manifest }, castMod] = await Promise.all([pickManifest(), optionalImport('./cast.js')]);
    log('manifest', manifestUrl);
    const units = await createUnits(sceneAPI, manifestUrl, { audio });

    // A stored cast is applied before the first frame is shown. prepareCast restores imported models
    // (IndexedDB blob URLs) and loads the pack.json of every library pack the cast uses. Packs that do not
    // load in time fall back to the default characters.
    const savedCast = castMod?.loadUserCast?.();
    let castFailed = [];
    if (savedCast && castMod?.prepareCast) {
        try {
            ({ failed: castFailed = [] } = await within(castMod.prepareCast(savedCast, { assetBase: ASSET_BASE, fetch: fetchWithin }), BOOT_WAIT_MS, 'cast') || {});
        } catch (e) { log('preparing the cast failed', e); castFailed = [{ id: 'cast', error: String(e?.message || e) }]; }
    } else {
        try { await castMod?.restoreCustomModels?.(); } catch (e) { log('restoring custom models failed', e); }
    }
    if (savedCast && manifest && typeof units.setCast === 'function') {
        setProgress(0.95, 'Assembling your cast...');
        try { await units.setCast(castMod.resolveRoles(manifest, savedCast)); } catch (e) { console.error('battle3d: stored cast failed', e); }
    }
    units.syncBoard(g.battle3dState().board);

    // One-time install suggestion after the player's first finished move (only when the browser offers install)
    let hintTried = false;
    const onMoveEnd = (ev) => {
        if (hintTried || ev.isAI || !$('tip').hidden) return; // one toast at a time
        hintTried = true;
        pwaReady.then(pwa => pwa?.showInstallHint?.(bottomStack()));
    };
    const controller = createController({ sceneAPI, units, audio, onMoveEnd, notify: showNotice, debug, log });
    // Talking kings and coach listen to controller events; create them before the first game starts
    const commentary = createCommentary({ controller, sceneAPI, units, audio, captionsEl: $('captions'), levelSelect: $('talk-select'), log });
    const coach = createCoach({ controller, sceneAPI, units, audio, log });
    await sceneAPI.setView(controller.viewSide(), { animate: false });
    // Save / Load panel and autosave (battle3d/saves.js): an autosaved game comes back in place of a new one
    let saves = null;
    try {
        saves = (await optionalImport('./saves.js'))?.setupSaves({ controller, coach, notify: showNotice }) || null;
    } catch (e) {
        console.error('battle3d: save and load are unavailable', e);
    }
    if (!saves) for (const id of ['save-open', 'export-open']) $(id)?.setAttribute('disabled', '');
    if (!saves?.resumed) controller.newGame();

    setupCast({ units, manifest, castMod, controller, sceneAPI });
    renderLegend(units, manifest);
    setupResetView(sceneAPI);

    if (debug) {
        window.__b3d = {
            sceneAPI, units, controller, audio, commentary, coach, saves,
            step: (n = 1, dt = 1 / 60) => sceneAPI.stepFrames(n, dt),
            state: () => controller.state(),
            offline: () => pwaReady.then(pwa => pwa?.offlineReport?.() ?? null) // marker and last failed download
        };
    }
    setProgress(1, 'Ready.');
    window.__b3dBooted = true;
    $('loading-slow')?.setAttribute('hidden', '');
    hideLoading();
    showFirstRunTip(sceneAPI);
    if (castFailed.length) showNotice('Some characters could not be loaded (offline?), so the default ones stand in.');
    if (saves?.notice) showNotice(saves.notice, { force: true });
    log('booted');
}

function setupResetView(sceneAPI) {
    const button = $('reset-view');
    if (typeof sceneAPI.resetView !== 'function') {
        button.disabled = true;
        return;
    }
    button.addEventListener('click', () => {
        sceneAPI.resetView({ animate: !matchMedia?.('(prefers-reduced-motion: reduce)').matches });
        sceneAPI.requestRender?.();
    });
}

// PWA: service worker, offline readiness line and "Install app" section in the menu (battle3d/install.js)
async function setupInstall() {
    const mount = $('install-mount');
    const pwa = await pwaReady;
    // Not with ?debug=1 or ?nosw=1: the worker is not registered there, so there is nothing to report
    if (!debug && params.get('nosw') !== '1') {
        try { pwa?.mountOfflineStatus?.($('offline-status')); } catch (e) { log('offline status failed', e); }
    }
    Promise.resolve()
        .then(() => pwa?.registerServiceWorker?.({
            disabled: debug || params.get('nosw') === '1',
            onUpdate: () => pwa.showUpdateToast?.(bottomStack())
        }))
        .catch(e => log('service worker registration failed', e));
    if (typeof pwa?.mountInstallUI === 'function') {
        try {
            // Hides the whole menu section (heading included) while the app runs installed
            pwa.mountInstallUI(mount, { host: mount.closest('.menu-section') });
            return;
        } catch (e) {
            log('install UI failed', e);
        }
    }
    mount.closest('.menu-section').hidden = true;
}

const booted = boot();
booted.catch(showBootError);
// The service worker and the install UI are not needed to play: set them up after the first frame, but also when the
// boot fails or takes long, so a first visit still gets offline play
Promise.race([booted.catch(() => { }), new Promise(resolve => setTimeout(resolve, BOOT_WAIT_MS))]).then(setupInstall);
