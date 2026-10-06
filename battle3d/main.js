// Boot for the 3D battle game: scene, audio, units, controller, cast editor, legend, first-run tip.
// Debug hooks (window.__b3d) only with ?debug=1.
import * as THREE from 'three';
import { createScene } from './scene.js';
import { createUnits } from './units.js';
import { createController } from './controller.js';
import { createAudio } from './audio.js';

const g = globalThis; // classic-script globals from gameLogic.js / rules.js
const MANIFESTS = ['battle3d/assets/manifest.json', 'battle3d/manifest.dev.json'];
const TIP_KEY = 'battle3d.tipSeen';
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
    clearInterval(hintTimer);
    loading.hidden = false;
    loading.classList.remove('fade');
    loading.classList.add('error');
    $('loading-text').textContent = 'Something went wrong while loading the 3D battle. Try reloading, or play the 2D game.';
    if (!loading.querySelector('.back')) {
        const link = document.createElement('a');
        link.className = 'btn primary back';
        link.href = '2d.html';
        link.textContent = 'Play the 2D game';
        $('loading-text').after(link);
    }
}

// GLTFLoader uses the default loading manager unless given another one
THREE.DefaultLoadingManager.onProgress = (url, loaded, total) => {
    if (total > 0) setProgress(0.15 + 0.8 * (loaded / total), `Summoning the armies... ${loaded}/${total}`);
};

async function pickManifest() {
    for (const url of MANIFESTS) {
        try {
            const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            if (response.ok) return url;
        } catch (e) { /* try the next one */ }
    }
    return MANIFESTS[0]; // let units.js report the error
}

async function fetchJson(url) {
    try {
        const response = await fetch(url);
        return response.ok ? await response.json() : null;
    } catch (e) {
        return null;
    }
}

// Optional modules from other agents: the game still runs without them
async function optionalImport(path) {
    try { return await import(path); } catch (e) { log('optional module missing', path, e); return null; }
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
function setupCast({ units, manifest, castMod, controller }) {
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

    async function apply(cast) {
        current = cast;
        castMod.saveUserCast?.(cast);
        if (controller.state().moving) controller.skip();
        controller.clearRings();
        try {
            await units.setCast(castMod.resolveRoles(manifest, cast));
            units.syncBoard(g.battle3dState().board);
        } catch (error) {
            console.error('battle3d: applying the cast failed', error);
        }
        controller.forgetRings(); // units were rebuilt; their old decorations are gone
        controller.refresh();
        renderLegend(units, manifest);
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

// --- First-run tip ---
function showFirstRunTip(sceneAPI) {
    let seen = false;
    try { seen = localStorage.getItem(TIP_KEY) === '1'; } catch (e) { /* ignore */ }
    if (seen) return;
    const tip = $('tip');
    const coarse = sceneAPI.isCoarsePointer?.() ?? matchMedia?.('(pointer: coarse)').matches;
    $('tip-text').textContent = `${coarse ? 'Tap' : 'Click'} a hero, then a highlighted square.`;
    tip.hidden = false;
    const dismiss = () => {
        tip.hidden = true;
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

    const audio = createAudio();
    const manifestUrl = await pickManifest();
    log('manifest', manifestUrl);
    const [manifest, castMod] = await Promise.all([fetchJson(manifestUrl), optionalImport('./cast.js')]);
    const units = await createUnits(sceneAPI, manifestUrl, { audio });

    // A stored custom cast is applied before the first frame is shown
    // Imported custom models live in IndexedDB; their blob URLs exist only after this
    try { await castMod?.restoreCustomModels?.(); } catch (e) { log('restoring custom models failed', e); }
    const savedCast = castMod?.loadUserCast?.();
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
        pwaReady.then(pwa => pwa?.showInstallHint?.());
    };
    const controller = createController({ sceneAPI, units, audio, onMoveEnd, debug, log });
    await sceneAPI.setView(controller.viewSide(), { animate: false });
    controller.newGame();

    setupCast({ units, manifest, castMod, controller });
    renderLegend(units, manifest);
    setupResetView(sceneAPI);

    if (debug) {
        window.__b3d = {
            sceneAPI, units, controller, audio,
            step: (n = 1, dt = 1 / 60) => sceneAPI.stepFrames(n, dt),
            state: () => controller.state()
        };
    }
    setProgress(1, 'Ready.');
    hideLoading();
    showFirstRunTip(sceneAPI);
    setupInstall(); // after the first frame: the service worker and install UI are not needed to play
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

// PWA: service worker + "Install app" section in the menu (battle3d/install.js)
async function setupInstall() {
    const mount = $('install-mount');
    const pwa = await pwaReady;
    Promise.resolve()
        .then(() => pwa?.registerServiceWorker?.({
            disabled: debug || params.get('nosw') === '1',
            onUpdate: () => pwa.showUpdateToast?.()
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

boot().catch(showBootError);
