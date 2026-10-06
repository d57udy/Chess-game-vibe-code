// Boots the real battle3d.html page in node: jsdom DOM as globals, the classic scripts in the main
// realm, then battle3d/main.js with the real scene (fake renderer injected through the main.js
// scene wrapper in loadBattle3dThree), real units, controller, audio, cast and cast-ui.
// One page per process (ES modules are cached), so each test file boots at most once.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { findThree, registerThree, installBrowserGlobals, ROOT } = require('./loadBattle3dThree');
const { fakeRenderer } = require('./battle3dSceneHarness');
const { page3d } = require('./pages');

const AI_STUB = `
globalThis.__aiCalls = [];
globalThis.requestAIMove = function (state, elo) {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const call = { state, elo, cancelled: false };
    call.resolve = (m) => resolve(m);
    call.cancel = () => { call.cancelled = true; resolve(null); };
    __aiCalls.push(call);
    return { promise, cancel: call.cancel };
};`;

function fakeContext2d(canvas) {
    return new Proxy({ canvas }, {
        get(t, p) {
            if (p in t) return t[p];
            if (p === 'measureText') return (s) => ({ width: String(s).length * 10 });
            if (p === 'getImageData' || p === 'createImageData') return (x, y, w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h) * 4) });
            if (/^create(Linear|Radial)Gradient$|^createPattern$/.test(p)) return () => ({ addColorStop() {} });
            return () => {};
        },
        set(t, p, v) { t[p] = v; return true; },
    });
}

/**
 * @param {object} [o]
 * @param {(w: Window) => void} [o.setup] before main.js runs (seed localStorage)
 * @returns {Promise<object|null>} null when three is missing
 */
async function bootPage(o = {}) {
    const three = findThree();
    if (!three) return null;
    const html = fs.readFileSync(path.join(ROOT, page3d()), 'utf8')
        .replace(/<script\b(?![^>]*importmap)[^>]*>[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { pretendToBeVisual: true, url: 'http://localhost/' + page3d() + '?debug=1' });
    const w = dom.window;
    w.HTMLCanvasElement.prototype.getContext = function (kind) { return kind === '2d' ? fakeContext2d(this) : null; };
    w.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
    w.HTMLElement.prototype.focus = function () {};
    w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    const errors = [], warnings = [];
    const origError = console.error, origWarn = console.warn, origLog = console.log;
    console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
    console.warn = (...a) => warnings.push(a.map(String).join(' '));
    console.log = () => {};

    // Long page timers (the 20 s first-run tip) must not keep the test process alive.
    const realSetTimeout = globalThis.setTimeout;
    set('setTimeout', (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); if (ms >= 1000) t.unref?.(); return t; });
    const clock = { t: 1000 };
    const raf = { queue: [], id: 1 };
    set('window', w);
    set('document', w.document);
    set('location', w.location);
    set('localStorage', w.localStorage);
    set('navigator', { hardwareConcurrency: 8, userAgent: 'node' });
    set('screen', { width: 1920, height: 1080 });
    set('getComputedStyle', w.getComputedStyle.bind(w));
    set('matchMedia', w.matchMedia);
    set('performance', { now: () => clock.t });
    set('requestAnimationFrame', (cb) => { const id = raf.id++; raf.queue.push({ id, cb }); return id; });
    set('cancelAnimationFrame', (id) => { raf.queue = raf.queue.filter((e) => e.id !== id); });
    set('ResizeObserver', undefined);
    for (const k of ['HTMLElement', 'HTMLCanvasElement', 'Event', 'KeyboardEvent', 'MouseEvent', 'CustomEvent']) set(k, w[k]);
    set('PointerEvent', w.PointerEvent || class PointerEvent extends w.MouseEvent {
        constructor(type, init = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = 'mouse'; this.isPrimary = true; }
    });
    registerThree(three.dir);
    const env = installBrowserGlobals(undefined, { dom: false });

    for (const f of ['gameLogic.js', 'aiPlayer.js', 'aiClient.js', 'battle3d/rules.js']) {
        vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
    }
    vm.runInThisContext(AI_STUB, { filename: 'ai-stub.js' });
    if (o.setup) o.setup(w);
    const renderer = fakeRenderer(w.document);
    globalThis.__b3dSceneOptions = { renderer, sleepAfter: 3 };

    await import(pathToFileURL(path.join(ROOT, 'battle3d', 'main.js')).href);
    const $ = (id) => w.document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 20000;
    while (!w.__b3d && !$('loading').classList.contains('error') && Date.now() < deadline) await sleep(5);
    if (!w.__b3d) throw new Error('boot failed: ' + ($('loading-text').textContent) + '\n' + errors.join('\n'));

    const B = w.__b3d;
    const page = {
        w, doc: w.document, $, B, renderer, errors, warnings, env, sleep,
        aiCalls: () => globalThis.__aiCalls,
        state: () => B.state(),
        board: () => globalThis.battle3dState().board.map((r) => [...r]),
        tick(ms = 1000 / 60) { clock.t += ms; const q = raf.queue; raf.queue = []; for (const e of q) e.cb(clock.t); },
        // Steps scene frames (the debug hook) until pred() or the budget runs out.
        async stepUntil(pred, { seconds = 15, label = 'condition' } = {}) {
            for (let i = 0; i < seconds * 60; i++) {
                if (pred()) return;
                B.step(1);
                await null;
                if (i % 30 === 0) await sleep(0);
            }
            if (!pred()) throw new Error(`timed out (${seconds} s scene time) waiting for ${label}`);
        },
        key(key, code = key, target = w.document.body) { target.dispatchEvent(new w.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true })); },
        restore() {
            console.error = origError; console.warn = origWarn; console.log = origLog;
            try { B.sceneAPI.dispose?.(); } catch (e) { /* ignore */ }
        },
    };
    return page;
}

module.exports = { bootPage };
