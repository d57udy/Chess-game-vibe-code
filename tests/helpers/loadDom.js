// Boots index.html in jsdom with the game scripts evaluated in the window, without the CDN
// script (GSAP is replaced by a stub). Returns the window plus helpers to drive the UI.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { ROOT, square } = require('./loadEngine');

// Minimal gsap: to() + killTweensOf(). Tweens set their end values and call onComplete either on
// the next macrotask ('auto') or when the test calls tweens.flush() ('manual').
const GSAP_STUB = `
window.__tweens = [];
window.__tweenMode = 'auto';
window.__completeTween = function (t) {
    if (t.done) return;
    t.done = true;
    clearTimeout(t.timer);
    for (const k of ['left', 'top', 'opacity']) if (k in t.vars) t.el.style[k] = t.vars[k];
    if (t.vars.onComplete) t.vars.onComplete();
};
window.gsap = {
    to(el, vars) {
        const t = { el, vars, done: false, killed: false };
        __tweens.push(t);
        if (__tweenMode === 'auto') t.timer = setTimeout(() => __completeTween(t), 0);
        return t;
    },
    killTweensOf(targets) {
        const set = new Set(targets && targets.length !== undefined ? Array.from(targets) : [targets]);
        for (const t of __tweens) if (!t.done && set.has(t.el)) { t.done = true; t.killed = true; clearTimeout(t.timer); }
    }
};`;

// Records every requestAIMove call; the test resolves or inspects them.
const AI_STUB = `
window.__aiCalls = [];
window.requestAIMove = function (state, elo, options = {}) {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const call = { state, elo, options, cancelled: false, index: state.positionHistory.length - 1 };
    call.resolve = (move) => resolve(move);
    call.cancel = () => { call.cancelled = true; resolve(null); };
    __aiCalls.push(call);
    return { promise, cancel: call.cancel };
};`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [options]
 * @param {boolean} [options.realClient] keep the real aiClient.js requestAIMove (jsdom has no
 *        Worker, so the engine runs through the main-thread fallback). Default: stubbed.
 * @param {'auto'|'manual'} [options.tweens] how GSAP tweens complete. Default 'auto'.
 */
async function loadDom(options = {}) {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
        .replace(/<script[^>]*\bsrc=[^>]*><\/script>/g, '');
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
    const w = dom.window;
    const doc = w.document;

    const played = []; // basenames of sounds played, in order
    w.HTMLMediaElement.prototype.play = function () { played.push(path.basename(this.src || '')); return Promise.resolve(); };
    w.HTMLMediaElement.prototype.load = () => {};
    w.HTMLMediaElement.prototype.pause = () => {};
    const errors = [];
    const warnings = [];
    w.console.log = () => {};
    w.console.info = () => {};
    w.console.debug = () => {};
    w.console.warn = (...a) => warnings.push(a.map(String).join(' '));
    w.console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));

    const ctx = dom.getInternalVMContext();
    const g = (code, filename = 'test-expr') => new vm.Script(code, { filename }).runInContext(ctx);
    // JSON round trip for values that are compared with deepEqual.
    const get = (expr) => { const s = g(`JSON.stringify(${expr})`); return s === undefined ? undefined : JSON.parse(s); };
    const file = (f) => g(fs.readFileSync(path.join(ROOT, f), 'utf8'), f);

    g(GSAP_STUB, 'gsap-stub.js');
    g(`__tweenMode = ${JSON.stringify(options.tweens || 'auto')};`);
    file('gameLogic.js');
    file('aiPlayer.js');
    file('aiClient.js');
    if (!options.realClient) g(AI_STUB, 'ai-stub.js');
    file('ui.js');
    if (doc.readyState === 'loading') await new Promise((r) => doc.addEventListener('DOMContentLoaded', r));
    else doc.dispatchEvent(new w.Event('DOMContentLoaded'));
    await sleep(0);

    const pendingTweens = () => g('__tweens.filter(t => !t.done).length');
    const flushTweens = () => g('__tweens.filter(t => !t.done).forEach(__completeTween)');

    const api = {
        w, doc, g, get, errors, warnings, played,
        aiCalls: () => g('__aiCalls'),
        tweens: { pending: pendingTweens, flush: flushTweens },
        sleep,
        el: (id) => doc.getElementById(id),
        status: () => doc.getElementById('status-message').textContent,
        turn: () => doc.getElementById('turn-indicator').textContent,
        notations: () => get('gameHistory.slice(1).map(s => s.moveNotation)'),
        pieceAt: (name) => { const { row, col } = square(name); return g(`getPieceAt(${row}, ${col})`); },
        squareEl(name) {
            const { row, col } = square(name);
            return doc.querySelector(`#chess-board .square[data-row="${row}"][data-col="${col}"]`);
        },
        pieceEl(name) {
            const { row, col } = square(name);
            return doc.querySelector(`#chess-board .piece[data-row="${row}"][data-col="${col}"]`);
        },
        // Clicks the piece element on a square if there is one, else the square (as a user would).
        click(name) {
            const target = api.pieceEl(name) || api.squareEl(name);
            target.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        },
        key(k) { doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true })); },
        setMode(mode) {
            const sel = doc.getElementById('game-mode-select');
            sel.value = mode;
            sel.dispatchEvent(new w.Event('change'));
        },
        setElo(elo) {
            const s = doc.getElementById('ai-elo-slider');
            s.value = String(elo);
            s.dispatchEvent(new w.Event('input'));
            s.dispatchEvent(new w.Event('change'));
        },
        async waitFor(pred, { timeout = 3000, message = 'condition' } = {}) {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                if (pred()) return;
                await sleep(5);
            }
            throw new Error(`timed out waiting for ${message}`);
        },
        // Completes animations until the move in progress has been processed.
        async settle(timeout = 3000) {
            const end = Date.now() + timeout;
            while (Date.now() < end) {
                if (pendingTweens() > 0) flushTweens();
                await sleep(0);
                if (!g('isAnimating') && pendingTweens() === 0) return;
            }
            throw new Error('move animation did not finish');
        },
        // Plays long-algebraic moves ("e2e4", "a7a8n") by clicking, waiting for each to finish.
        async play(...moves) {
            for (const mv of moves.flat()) {
                api.click(mv.slice(0, 2));
                api.click(mv.slice(2, 4));
                if (mv[4]) doc.querySelector(`#promotion-modal button[data-piece="${mv[4].toUpperCase()}"]`).click();
                await api.settle();
            }
        },
        // Replaces the game with a position (history restarts there) and redraws.
        loadPosition(fen) {
            g(`abortInFlightWork(); isReviewing = false; lastMove = null; parseFen(${JSON.stringify(fen)});
               gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });
               evaluateGameState(); createBoardDOM(); renderBoard(); updateStatusDisplay(); updateMoveHistoryDisplay();`);
        },
        close() { w.close(); },
    };
    return api;
}

module.exports = { loadDom, sleep };
