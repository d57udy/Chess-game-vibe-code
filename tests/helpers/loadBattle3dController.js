// Boots battle3d.html in jsdom with the classic game scripts + battle3d/rules.js evaluated in the
// window (same realm rules as the browser: top-level let/const are NOT window properties), then
// evaluates battle3d/controller.js in that window with fake SceneAPI / UnitsAPI objects, so the
// turn flow can be driven without three.js or WebGL. The module's `export` is stripped and the
// body wrapped in a strict-mode function, which is equivalent for a file without imports.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { ROOT, square } = require('./loadEngine');

const AI_STUB = `
window.__aiCalls = [];
window.requestAIMove = function (state, elo, options = {}) {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const call = { state, elo, options, cancelled: false };
    call.resolve = (move) => resolve(move);
    call.cancel = () => { call.cancelled = true; resolve(null); };
    __aiCalls.push(call);
    return { promise, cancel: call.cancel };
};`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake SceneAPI: records calls; the updater clock only moves through stepFrames().
function fakeScene() {
    const updaters = new Set();
    const calls = { setView: [], setHighlights: [], focusOn: 0, restoreView: 0, skipEffects: 0, renders: 0 };
    const tokens = new Set();
    let clickCb = null, hoverCb = null, t = 0;
    return {
        calls,
        updaters,
        tokens,
        click: (row, col) => clickCb && clickCb(row, col),
        hover: (row, col) => hoverCb && hoverCb(row, col),
        api: {
            THREE: null, scene: null, camera: null, renderer: null,
            squareToWorld: (row, col) => ({ x: col - 3.5, y: 0, z: row - 3.5 }),
            onSquareClick(cb) { clickCb = cb; },
            onSquareHover(cb) { hoverCb = cb; },
            registerPickProxy() {}, unregisterPickProxy() {},
            setHighlights(h) { calls.setHighlights.push(JSON.parse(JSON.stringify(h))); },
            setView(side, opts) { calls.setView.push(side); return Promise.resolve(); },
            focusOn() { calls.focusOn++; return Promise.resolve(); },
            restoreView() { calls.restoreView++; return Promise.resolve(); },
            addUpdater(fn) { updaters.add(fn); },
            removeUpdater(fn) { updaters.delete(fn); },
            setTimeScale() {}, getTimeScale: () => 1,
            shake() {}, burst() {},
            stepFrames(n, dt = 1 / 60) { for (let i = 0; i < n; i++) { t += dt; for (const fn of [...updaters]) fn(dt, t); } },
            setPaused() {},
            keepAlive(token, on) { if (on) tokens.add(token); else tokens.delete(token); },
            requestRender() { calls.renders++; },
            skipEffects() { calls.skipEffects++; },
            isCoarsePointer: () => false,
        },
    };
}

// Fake audio: records play names and mute state.
function fakeAudio() {
    const a = { played: [], muted: null, play(name, opts) { a.played.push(name); }, setMuted(on) { a.muted = !!on; }, isMuted: () => !!a.muted, unlock() {} };
    return a;
}

// Fake UnitsAPI. mode 'auto': animations resolve on the next microtask. 'manual': they stay
// pending until finish() / skip(). Keeps its own piece map so unitAt() is meaningful.
function fakeUnits(mode = 'auto') {
    const calls = { syncBoard: 0, playMove: [], playCheck: [], playGameOver: [], setMode: [], skip: 0, setLabels: [] };
    let grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    let pending = [];
    const settle = () => { const p = pending; pending = []; for (const f of p) f(); };
    const animate = (apply) => new Promise((resolve) => {
        const done = () => { apply(); resolve(); };
        if (fake.mode === 'auto') Promise.resolve().then(done);
        else if (fake.mode === 'never') pending.push(() => {}); // only skip/watchdog can rescue
        else pending.push(done);
    });
    const fake = {
        mode,
        calls,
        grid: () => grid,
        pending: () => pending.length,
        finish: settle,
        api: {
            syncBoard(board) { calls.syncBoard++; grid = JSON.parse(JSON.stringify(board)); },
            unitAt: (row, col) => (grid[row][col] ? { piece: grid[row][col] } : null),
            playMove(ev) {
                calls.playMove.push(JSON.parse(JSON.stringify(ev)));
                return animate(() => {
                    if (ev.captured) grid[ev.captured.square.row][ev.captured.square.col] = null;
                    if (ev.castling) {
                        grid[ev.castling.rookTo.row][ev.castling.rookTo.col] = grid[ev.castling.rookFrom.row][ev.castling.rookFrom.col];
                        grid[ev.castling.rookFrom.row][ev.castling.rookFrom.col] = null;
                    }
                    const placed = ev.promotion ? (ev.color === 'w' ? ev.promotion : ev.promotion.toLowerCase()) : ev.piece;
                    grid[ev.from.row][ev.from.col] = null;
                    grid[ev.to.row][ev.to.col] = placed;
                });
            },
            playCheck(sq) { calls.playCheck.push(JSON.parse(JSON.stringify(sq))); return animate(() => {}); },
            playGameOver(info) { calls.playGameOver.push(JSON.parse(JSON.stringify(info))); return animate(() => {}); },
            setMode(m) { calls.setMode.push(m); },
            skip() { calls.skip++; settle(); },
            isBusy: () => pending.length > 0,
            setLabels(on) { calls.setLabels.push(on); },
        },
    };
    return fake;
}

/**
 * @param {object} [options]
 * @param {'auto'|'manual'|'never'} [options.units] fake animation completion mode (default 'auto')
 * @param {boolean} [options.newGame=true] call controller.newGame() like main.js does
 * @param {boolean} [options.audio] pass a recording fake audio (C.audio)
 * @param {(w: Window) => void} [options.setup] runs before the controller is created (seed localStorage)
 */
async function loadBattle3dController(options = {}) {
    const html = fs.readFileSync(path.join(ROOT, 'battle3d.html'), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (tag) => (tag.includes('importmap') ? tag : ''));
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/battle3d.html' });
    const w = dom.window;
    const errors = [], warnings = [];
    w.console.log = () => {};
    w.console.warn = (...a) => warnings.push(a.map(String).join(' '));
    w.console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
    w.HTMLElement.prototype.focus = function () {};

    const ctx = dom.getInternalVMContext();
    const g = (code, filename = 'test-expr') => new vm.Script(code, { filename }).runInContext(ctx);
    const get = (expr) => { const s = g(`JSON.stringify(${expr})`); return s === undefined ? undefined : JSON.parse(s); };
    const file = (f) => g(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);
    file('gameLogic.js');
    file('aiPlayer.js');
    file('aiClient.js');
    g(AI_STUB, 'ai-stub.js');
    file('battle3d/rules.js');
    const src = fs.readFileSync(path.join(ROOT, 'battle3d/controller.js'), 'utf8');
    if (/^\s*import\s/m.test(src)) throw new Error('controller.js now has imports; the loader needs updating');
    g(`(function () { 'use strict';\n${src.replace(/^export\s+/gm, '')}\nwindow.__createController = createController; })();`, 'battle3d/controller.js');

    if (options.setup) options.setup(w);
    const scene = fakeScene();
    const units = fakeUnits(options.units || 'auto');
    const audio = options.audio ? fakeAudio() : null;
    w.__audio = audio;
    g('battle3dNewGame()');
    units.api.syncBoard(get('board'));
    w.__scene = scene.api;
    w.__units = units.api;
    const controller = g('__createController({ sceneAPI: __scene, units: __units, audio: __audio, debug: false })');
    if (options.newGame !== false) controller.newGame();
    await sleep(0);

    const api = {
        w, doc: w.document, g, get, errors, warnings, scene, units, controller, audio,
        settings: () => JSON.parse(w.localStorage.getItem('battle3d.settings') || 'null'),
        sleep,
        state: () => JSON.parse(JSON.stringify(controller.state())),
        aiCalls: () => g('__aiCalls'),
        status: () => w.document.getElementById('status-text').textContent,
        // Advances the scene clock by `seconds` and lets promise continuations run.
        async step(seconds = 0, dt = 1 / 60) {
            const frames = Math.ceil(seconds / dt);
            for (let i = 0; i < frames; i++) { scene.api.stepFrames(1, dt); await sleep(0); }
            await sleep(0);
        },
        async flush() { for (let i = 0; i < 5; i++) await sleep(0); },
        async click(name) { const { row, col } = square(name); scene.click(row, col); await api.flush(); },
        // Plays "e2e4" / "a7a8n" by clicks (+ promotion button), then waits for the move to finish.
        async play(mv) {
            await api.click(mv.slice(0, 2));
            await api.click(mv.slice(2, 4));
            if (mv[4]) { api.doc.querySelector(`#promo button[data-piece="${mv[4].toUpperCase()}"]`).click(); await api.flush(); }
            if (units.mode !== 'auto') units.finish();
            await api.flush();
        },
        // Answers the latest pending AI request with a long-algebraic move.
        async answerAI(mv) {
            const calls = api.aiCalls();
            const call = calls[calls.length - 1];
            const f = square(mv.slice(0, 2)), t = square(mv.slice(2, 4));
            call.resolve({ from: f, to: t, isPromotion: !!mv[4], promotionPiece: mv[4] ? mv[4].toUpperCase() : null });
            await api.flush();
            if (units.mode !== 'auto') units.finish();
            await api.flush();
        },
        button: (id) => w.document.getElementById(id),
        key(code, key, target = w.document.body) { const e = new w.KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true }); target.dispatchEvent(e); return e; },
        announced: () => w.document.getElementById('announce')?.textContent || '',
        close() { w.close(); },
    };
    return api;
}

module.exports = { loadBattle3dController, sleep };
