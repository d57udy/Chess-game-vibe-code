'use strict';
// v6 coach.js flow in jsdom (index.html markup) with a fake controller and engine stubs:
// off by default and persisted; after a human mistake the card explains (motif first, else the
// classification) with Take it back / Show me better; AI moves and good moves (frequency
// 'mistakes') stay quiet; at most one nudge per move (threat > hanging piece > opening);
// requests cancelled on move / undo / new game and late answers ignored; review panel at game end.
const { test, describe, before, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');
const { ROOT } = require('../helpers/loadEngine');
const { page3d } = require('../helpers/pages');

const FILE = path.join(ROOT, 'battle3d', 'coach.js');
const have = fs.existsSync(FILE);
let createCoach, saved = {};
const START_BOARD = [
    ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'], Array(8).fill('p'), Array(8).fill(null), Array(8).fill(null),
    Array(8).fill(null), Array(8).fill(null), Array(8).fill('P'), ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']];
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup({ settings, humans = { w: true, b: false }, threats = null, snapshot } = {}) {
    const html = fs.readFileSync(path.join(ROOT, page3d()), 'utf8').replace(/<script\b(?![^>]*importmap)[^>]*>[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    const w = dom.window;
    if (settings) w.localStorage.setItem('battle3d.settings', JSON.stringify(settings));
    const calls = { undo: 0, suggest: [], review: [], threatReqs: [], cancels: 0 };
    const set = (k, v) => { if (!(k in saved)) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
    set('window', w); set('document', w.document); set('localStorage', w.localStorage);
    set('fetch', async (u) => { const f = path.join(ROOT, String(u)); return fs.existsSync(f) ? { ok: true, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) } : { ok: false, json: async () => null }; });
    const state = { turn: 'w', result: null, over: false };
    const board = (snapshot && snapshot.board) || START_BOARD;
    set('getCurrentGameStateSnapshot', () => JSON.parse(JSON.stringify(snapshot || { board, currentPlayer: state.turn, castlingRights: { w: { K: true, Q: true }, b: { K: true, Q: true } }, enPassantTarget: null, halfmoveClock: 0, fullmoveNumber: 1, positionHistory: [] })));
    set('getPieceAt', (r, c) => board[r]?.[c] ?? null);
    set('requestThreats', (st) => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const h = { promise, cancel: () => { calls.cancels++; resolve(null); }, resolve, state: st };
        calls.threatReqs.push(h);
        if (threats !== null) Promise.resolve().then(() => resolve(threats));
        return h;
    });
    const listeners = [];
    const controller = {
        onEvent: (fn) => listeners.push(fn),
        state: () => state,
        isHumanColor: (c) => !!humans[c],
        undo: () => { calls.undo++; },
        showSuggestion: (m) => { calls.suggest.push(m); return true; },
        enterReview: (ply) => calls.review.push(ply),
    };
    const coach = createCoach({ controller, sceneAPI: {}, log: () => {} });
    const emit = async (e) => { for (const fn of listeners) fn(e); await flush(); };
    const $ = (id) => w.document.getElementById(id);
    return { w, coach, emit, calls, state, $, card: () => $('coach-card'), cardText: () => $('coach-text').textContent };
}
function restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } saved = {}; }
const moveDone = (extra = {}) => ({
    type: 'moveDone', ply: 9, mover: 'w', notation: 'Bc4', classification: 'blunder', evalBefore: 30, evalAfter: -600, isAI: false,
    piece: 'B', square: { row: 4, col: 2 }, motifs: [], bestBefore: { from: { row: 7, col: 6 }, to: { row: 5, col: 5 } },
    stateBefore: { board: START_BOARD }, status: { over: false }, ...extra,
});

describe('battle3d coach (v6)', { skip: !have && 'coach.js not present' }, () => {
    before(async () => { ({ createCoach } = await import(pathToFileURL(FILE).href)); });
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); restore(); });

    test('off by default; the toggle enables it and is saved; frequency saved', async () => {
        const C = setup();
        assert.equal(C.$('coach-toggle').checked, false);
        await C.emit(moveDone());
        assert.equal(C.card().hidden, true, 'no advice while off');
        C.$('coach-toggle').checked = true;
        C.$('coach-toggle').dispatchEvent(new C.w.Event('change'));
        const s = JSON.parse(C.w.localStorage.getItem('battle3d.settings'));
        assert.equal(s.coach, true);
        C.$('coach-frequency').value = 'mistakes';
        C.$('coach-frequency').dispatchEvent(new C.w.Event('change'));
        assert.equal(JSON.parse(C.w.localStorage.getItem('battle3d.settings')).coachFrequency, 'mistakes');
    });

    test('a human blunder: sticky card with actions, the better move named; Take it back undoes', async () => {
        const C = setup({ settings: { coach: true } });
        await C.emit(moveDone());
        assert.equal(C.card().hidden, false);
        assert.equal(C.$('coach-actions').hidden, false, 'Take it back / Show me better');
        assert.ok(C.cardText().length > 10 && !/[{}]/.test(C.cardText()), C.cardText());
        mock.timers.tick(60000);
        assert.equal(C.card().hidden, false, 'mistake cards stay until acted on');
        C.$('coach-undo').click();
        assert.equal(C.calls.undo, 1);
        assert.equal(C.card().hidden, true);
    });

    test('Show me better: undo, then the engine best move is shown as a suggestion', async () => {
        const C = setup({ settings: { coach: true } });
        const ev = moveDone();
        await C.emit(ev);
        assert.equal(C.$('coach-better').hidden, false);
        C.$('coach-better').click();
        assert.equal(C.calls.undo, 1);
        mock.timers.tick(100);
        assert.deepEqual(C.calls.suggest, [ev.bestBefore]);
        assert.equal(C.card().hidden, false, 'explains the arrow');
    });

    test('motif explanation wins over the generic classification text', async () => {
        const C = setup({ settings: { coach: true } });
        await C.emit(moveDone({ motifs: [{ motif: 'hanging', by: 'b', squares: ['c4', 'b5'], pieces: ['B', 'p'] }] }));
        const text = C.cardText();
        assert.match(text, /bishop|c4/i, `motif text mentions the hanging bishop: ${text}`);
    });

    test("AI moves, the opponent's moves and good moves with 'mistakes only' stay quiet", async () => {
        const C = setup({ settings: { coach: true, coachFrequency: 'mistakes' } });
        await C.emit(moveDone({ isAI: true, mover: 'b' }));
        assert.equal(C.card().hidden, true, 'AI move');
        await C.emit(moveDone({ classification: 'best' }));
        assert.equal(C.card().hidden, true, 'no praise in mistakes-only');
        await C.emit(moveDone({ classification: 'good' }));
        assert.equal(C.card().hidden, true);
    });

    test('praise in "every" mode is non-sticky and fades', async () => {
        const C = setup({ settings: { coach: true, coachFrequency: 'every' } });
        await C.emit(moveDone({ classification: 'best', brilliant: true }));
        assert.equal(C.card().hidden, false, 'brilliant move praised');
        assert.equal(C.$('coach-actions').hidden, true);
        mock.timers.tick(60000);
        assert.equal(C.card().hidden, true, 'praise fades');
    });

    test('nudge: a threat warning before the human move, at most one per move', async () => {
        const C = setup({ settings: { coach: true }, threats: { threats: [{ move: { from: { row: 1, col: 4 }, to: { row: 6, col: 4 } }, gain: 300, motif: 'capture' }] } });
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
        mock.timers.tick(1300);
        await flush();
        assert.equal(C.calls.threatReqs.length, 1, 'one threat request');
        assert.equal(C.card().hidden, false, 'threat nudge shown');
        const first = C.cardText();
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
        mock.timers.tick(1300);
        await flush();
        assert.equal(C.cardText(), first, 'no second nudge while one is shown');
    });

    test('no nudges while off, on the AI turn, or after game over', async () => {
        const C = setup({ settings: { coach: false } });
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
        mock.timers.tick(2000); await flush();
        assert.equal(C.calls.threatReqs.length, 0);
        const D = setup({ settings: { coach: true } });
        await D.emit({ type: 'turn', color: 'b', human: false, over: false, ply: 11 });
        await D.emit({ type: 'turn', color: 'w', human: true, over: true, ply: 11 });
        mock.timers.tick(2000); await flush();
        assert.equal(D.calls.threatReqs.length, 0);
    });

    for (const [name, ev] of [['a move', { type: 'moveDone', ...moveDone({ classification: 'good' }) }], ['undo', { type: 'reset', reason: 'undo', ply: 8 }], ['new game', { type: 'reset', reason: 'newGame', ply: 0 }]]) {
        test(`a pending threat request is cancelled by ${name} and its late answer ignored`, async () => {
            const C = setup({ settings: { coach: true } });
            await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
            mock.timers.tick(1300); await flush();
            const h = C.calls.threatReqs[0];
            assert.ok(h, 'request in flight');
            await C.emit(ev);
            assert.equal(C.calls.cancels, 1, 'cancelled');
            h.resolve({ threats: [{ move: { from: { row: 1, col: 4 }, to: { row: 6, col: 4 } }, gain: 900, motif: 'capture' }] });
            await flush();
            if (name !== 'a move') assert.equal(C.card().hidden, true, 'late answer ignored');
        });
    }

    test('game end: review panel lists the human key moments; clicking one jumps to that position', async () => {
        const C = setup({ settings: { coach: true } });
        await C.emit(moveDone({ ply: 5, classification: 'mistake', evalBefore: 20, evalAfter: -200 }));
        await C.emit(moveDone({ ply: 6, mover: 'b', isAI: true, classification: 'blunder', evalBefore: -200, evalAfter: 300 }));
        await C.emit(moveDone({ ply: 9, classification: 'good', evalBefore: 300, evalAfter: 290, status: { over: true } }));
        mock.timers.tick(3000); await flush();
        const panel = C.$('coach-review');
        assert.equal(panel.hidden, false, 'review opens after game over');
        const items = [...C.$('coach-review-list').querySelectorAll('button')];
        assert.equal(items.length, 1, 'only the human mistake is a key moment');
        assert.match(items[0].textContent, /mistake/);
        items[0].click();
        assert.deepEqual(C.calls.review, [5]);
        assert.equal(panel.hidden, true);
    });

    test('review: every keyMoment template of the voice is reachable (all slots supplied)', async () => {
        const voices = JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'lines', 'coach.json'), 'utf8')).voices;
        const lines = Object.values(voices).flatMap((v) => v.review.keyMoment.map((l) => l.text));
        const heads = lines.map((t) => t.split('{')[0].trim()).filter((h) => h.length > 4);
        const seen = new Set();
        const realRandom = Math.random;
        try {
            for (let i = 0; i < 40; i++) {
                Math.random = ((x) => () => ((x = (x * 9301 + 49297) % 233280) / 233280))(i + 1);
                const C = setup({ settings: { coach: true } });
                await C.emit(moveDone({ ply: 5, classification: 'blunder', evalBefore: 50, evalAfter: -700 }));
                await C.emit(moveDone({ ply: 9, classification: 'good', status: { over: true } }));
                mock.timers.tick(3000); await flush();
                const intro = C.$('coach-review-intro').textContent;
                assert.ok(!/[{}]/.test(intro), `slots filled: ${intro}`);
                for (const h of heads) if (intro.includes(h)) seen.add(h);
                restore();
            }
        } finally { Math.random = realRandom; }
        const hero = voices.hero.review.keyMoment.map((l) => l.text.split('{')[0].trim()).filter((h) => h.length > 4);
        assert.ok(hero.every((h) => seen.has(h)), `hero keyMoment lines used: ${[...seen].length} of ${heads.length}; missing ${hero.filter((h) => !seen.has(h))}`);
    });

    test('new game clears the review moments and the card', async () => {
        const C = setup({ settings: { coach: true } });
        await C.emit(moveDone());
        await C.emit({ type: 'reset', reason: 'newGame', ply: 0 });
        assert.equal(C.card().hidden, true);
        C.coach.openReview();
        assert.equal(C.$('coach-review-list').querySelectorAll('button').length, 0);
    });
});
