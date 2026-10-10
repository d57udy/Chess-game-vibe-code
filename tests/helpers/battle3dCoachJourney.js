'use strict';
// Shared driver for the coach and review journey tests (battle3dCoachJourneys / battle3dReviewJourneys):
// boots the real page once per test file and plays it the way a player would (clicks on squares and
// controls). Only the AI opponent's move choice is scripted. Real timers run 20x faster (coach delays
// are wall-clock) and engine analysis is capped so a move is judged in a few milliseconds.
// Controls without a settled id are found by their visible text or aria-label.
const assert = require('node:assert/strict');
const { bootPage } = require('./loadBattle3dPage');

/** @returns {Promise<object>} the journey driver J (J.P is the booted page) */
async function bootJourney({ settings = null } = {}) {
let P, focused = [], shows = 0;
const realSetTimeout = setTimeout;
const pause = (ms) => new Promise((r) => realSetTimeout(r, ms));
const SCALE = 20, NODES = 4000;


// --- page helpers ---
const $ = (id) => P.$(id);
const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (e.hidden || e.getAttribute('aria-hidden') === 'true' && e !== el) return false; return !!el; };
const label = (el) => `${el.textContent.replace(/\s+/g, ' ').trim()} ${el.getAttribute('aria-label') || ''} ${el.title || ''}`.trim();
const buttons = (re, root = P.doc) => [...root.querySelectorAll('button, [role="button"], a[href]')].filter((b) => visible(b) && !b.disabled && re.test(label(b)));
const button = (re, root) => buttons(re, root)[0] || null;
const st = () => P.state();
// The card's words: the verdict sentence plus, when shown, the warning before the player's move
const warningText = () => { const w = $('coach-warning'); return w && visible(w) ? w.textContent.trim() : ''; };
const card = () => ({ visible: visible($('coach-card')), text: `${$('coach-text').textContent.trim()} ${warningText()}`.trim(), warning: warningText(), actions: visible($('coach-actions')), undo: visible($('coach-undo')), better: visible($('coach-better')) });
// A "thinking" state the coach may show while the engine works (any of these conventions)
const thinkingShown = () => !!P.doc.querySelector('#coach-card[aria-busy="true"]:not([hidden]), #coach-card.thinking:not([hidden]), #coach-card.pending:not([hidden]), #coach-thinking:not([hidden]), [data-coach-state="thinking"]:not([hidden])');
const sq = (s) => [8 - Number(s[1]), s.charCodeAt(0) - 97];
const unitBoard = () => Array.from({ length: 8 }, (_, r) => Array.from({ length: 8 }, (_, c) => { const u = P.B.units.unitAt(r, c); return u ? (u.color === 'w' ? u.type.toUpperCase() : u.type) : ''; }).join(',')).join('/');
const boardKey = (b) => b.map((row) => row.map((p) => p || '').join(',')).join('/');
const liveBoard = () => boardKey(P.board());
const pendingAI = () => P.aiCalls().filter((c) => !c.cancelled && !c.done).pop() || null;

async function settle(pred, { ms = 1500, label: what = 'condition', soft = false } = {}) {
    const end = Date.now() + ms;
    for (;;) {
        if (pred()) return true;
        if (Date.now() > end) { if (soft) return false; throw new Error(`timed out waiting for ${what}`); }
        P.B.step(6);
        await pause(1);
    }
}
const idle = (what) => settle(() => !st().moving && !P.B.units.isBusy?.(), { ms: 6000, label: what || 'move animation' });

function setSelect(id, value) { const el = $(id); if (el.value !== value) { el.value = value; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); } }
function setCheck(id, on) { const el = $(id); if (el.checked !== on) el.click(); }

// Fresh game with the given settings. Leaves review mode and dialogs first.
async function fresh({ mode = 'human-ai', side = 'w', coach = true, frequency = 'every', talk = 'occasional' } = {}) {
    for (const c of P.aiCalls()) if (!c.cancelled && !c.done) { c.done = true; c.resolve(null); }
    try { P.B.controller.exitReview?.(); } catch (e) { /* ignore */ }
    try { P.B.coach.closeReview?.(); } catch (e) { /* ignore */ }
    await idle('previous journey to settle');
    setSelect('mode-select', mode);
    if (mode === 'human-ai') $(side === 'w' ? 'side-w' : 'side-b').click();
    $('speed-fast').click();
    setSelect('talk-select', talk);
    setCheck('coach-toggle', coach);
    if (coach) setSelect('coach-frequency', frequency);
    $('new-game').click();
    await idle('new game');
    assert.deepEqual(st().history, [], 'new game starts empty');
    P.errors.length = 0;
}

// A human move by clicking the from and to squares. Resolves when the move has been made.
async function human(move, { expectMove = true } = {}) {
    const n = st().history.length;
    P.B.controller.clickSquare(...sq(move.slice(0, 2)));
    P.B.controller.clickSquare(...sq(move.slice(2, 4)));
    if (!expectMove) return;
    await settle(() => st().history.length === n + 1 && !st().moving, { ms: 6000, label: `human move ${move}` });
}
// The scripted AI answers its pending request with this move.
async function ai(move) {
    const n = st().history.length;
    await settle(() => !!pendingAI(), { ms: 6000, label: `AI request before ${move}` });
    const call = pendingAI();
    call.done = true;
    const [fr, fc] = sq(move.slice(0, 2)), [tr, tc] = sq(move.slice(2, 4));
    call.resolve({ from: { row: fr, col: fc }, to: { row: tr, col: tc } });
    await settle(() => st().history.length === n + 1 && !st().moving, { ms: 6000, label: `AI move ${move}` });
}
// Plays alternating moves from the start; `humans` says which colours are played by clicking.
async function play(moves, humans, each) {
    for (let i = 0; i < moves.length; i++) {
        const color = (st().history.length % 2 === 0) ? 'w' : 'b';
        const before = shows;
        if (humans.includes(color)) { await human(moves[i]); if (each) await each(moves[i], color, before, i); } else await ai(moves[i]);
    }
}
// Visible coach feedback that appeared after `since` (the show counter before the move): a card with
// text, or a thinking state that resolves into one.
async function feedbackSince(since, { ms = 600 } = {}) {
    let thought = false;
    const ok = await settle(() => { thought ||= thinkingShown(); return shows > since && card().visible && card().text.length > 0 && !thinkingShown(); }, { ms, soft: true });
    return { ok, thought, ...card() };
}

// A warning before the player's move that appeared after `since`: the dedicated warning line, or (older
// layout) a card without mistake actions whose words changed while it is the player's turn.
const WARNISH = /mate|threat|attack|eyeing|danger|careful|look out|watch|before you move|their|unguarded|undefended/i;
async function warningSince(since, { ms = 900 } = {}) {
    const start = card().text;
    const has = () => { const c = card(); return c.visible && !thinkingShown() && (c.warning ? true : shows > since && c.text !== start && !c.actions && WARNISH.test(c.text)); };
    const ok = await settle(has, { ms, soft: true });
    const c = card();
    return { ok, ...c, warn: c.warning || c.text };
}

// Ordinary developing moves (Giuoco Pianissimo), 10 per side
const QUIET = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3', 'g8f6', 'd2d3', 'd7d6', 'e1g1', 'e8g8', 'f1e1', 'a7a6', 'c4b3', 'c5a7', 'h2h3', 'h7h6', 'b1d2', 'f8e8'];
// White throws the queen away on move 3 (Qxf7+ Kxf7)
const QUEEN = ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'h5f7', 'e8f7', 'g1f3', 'g8f6'];
// Two separate swings for the review: a knight on move 3 (Nxe5 Nxe5), the queen on move 5 (Qxf7+ Kxf7)
const REVIEW = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f3e5', 'c6e5', 'd1h5', 'e5c6', 'h5f7', 'e8f7'];

// The live game for the review journeys: 10 plies, White blundered on plies 5 (Nxe5) and 9 (Qxf7+), White to move.
async function reviewGame(opts = {}) {
    await fresh({ side: 'w', ...opts });
    const boards = [liveBoard()];
    for (const m of REVIEW) {
        if (st().history.length % 2 === 0) await human(m); else await ai(m);
        boards.push(liveBoard());
    }
    await idle();
    return { boards, fen: st().fen, history: st().history.slice() };
}
const reviewDialog = () => $('coach-review');
const listed = () => [...$('coach-review-list').querySelectorAll('button')].filter(visible);
// Flagged moves: marked as such in a list of all moves, or (older layout) the only ones listed
const moments = () => { const all = listed(); return all.some((b) => /\breview-move\b/.test(b.className)) ? all.filter((b) => /\bflagged\b/.test(b.className)) : all; };
const momentFor = (san) => moments().find((b) => b.textContent.includes(san));
const isMarked = (b) => ['true', 'step', 'location', 'page'].includes(b.getAttribute('aria-current')) || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true' || /\b(selected|current|active)\b/.test(b.className);
const ctl = (id, re) => { const el = $(id); return el && visible(el) && !el.disabled ? el : button(re); };
const prevBtn = () => ctl('coach-review-prev', /^(?!.*flag).*prev/i), nextBtn = () => ctl('coach-review-next', /^(?!.*flag).*next/i);
async function openReview() {
    const opener = button(/review/i, $('hud-controls')) || $('coach-review-open');
    assert.ok(opener && visible(opener), 'a visible "Review game" control');
    opener.click();
    await settle(() => visible(reviewDialog()), { label: 'review dialog' });
    return opener;
}
const backToGame = () => ctl('coach-review-return', /^(?!.*close).*((back|return) to (the )?game|resume)/i);
const backToReview = () => button(/back to (the )?review|show review|review( panel| list)?$/i);
const reviewReachable = () => visible(reviewDialog()) || !!backToReview();

P = await bootPage({
    setup(w) {
                if (settings) w.localStorage.setItem('battle3d.settings', JSON.stringify(settings));
        w.localStorage.setItem('battle3d.tipSeen', '1');
        const prev = globalThis.setTimeout;
        globalThis.setTimeout = (fn, ms = 0, ...a) => prev(fn, ms >= 30 ? ms / SCALE : ms, ...a);
        w.HTMLElement.prototype.focus = function () { focused.push(this); };
    },
});
for (const name of ['requestAnalysis', 'requestThreats']) {
    const orig = globalThis[name];
    if (typeof orig === 'function') globalThis[name] = (state, opts = {}) => orig(state, { ...opts, nodes: Math.min(opts.nodes || NODES, NODES) });
}
// Count every time the coach card appears or its text changes while visible
const obs = new P.w.MutationObserver(() => { if (card().visible && card().text) shows++; });
obs.observe($('coach-card'), { attributes: true, attributeFilter: ['hidden', 'class', 'aria-busy'], childList: true, subtree: true, characterData: true });
const restore = () => { globalThis.setTimeout = realSetTimeout; P.restore(); };
return {
    P, $, visible, label, buttons, button, st, card, warningText, thinkingShown, sq, unitBoard, boardKey, liveBoard, pendingAI, settle, idle, pause,
    setSelect, setCheck, fresh, human, ai, play, feedbackSince, warningSince, QUIET, QUEEN, REVIEW,
    reviewGame, reviewDialog, listed, moments, momentFor, isMarked, ctl, prevBtn, nextBtn, openReview, backToGame, backToReview, reviewReachable,
    shows: () => shows, focused: () => focused, clearFocused: () => { focused = []; }, restore,
};
}

module.exports = { bootJourney };
