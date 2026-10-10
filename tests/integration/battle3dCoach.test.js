'use strict';
// v6.1 coach.js in jsdom (index.html markup) with a fake controller and engine stubs. The real-page
// journeys are in battle3dCoachJourneys.test.js; this file pins what needs a controllable engine:
// the thinking state and its outcomes (verdict, no engine, retries), "Mistakes only", Take it back /
// Show me better calls, late answers after undo / new game, the warning before the player's move
// (one at most, cancelled by a move / undo / new game) and the docked review panel (every move
// listed, background judging one at a time, selection rules, stepping, minimise, close, Escape).
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

function setup({ settings, humans = { w: true, b: false }, threats = null, snapshot, engine = true, judgements = null } = {}) {
    const html = fs.readFileSync(path.join(ROOT, page3d()), 'utf8').replace(/<script\b(?![^>]*importmap)[^>]*>[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: 'http://localhost/' });
    const w = dom.window;
    if (settings) w.localStorage.setItem('battle3d.settings', JSON.stringify(settings));
    const calls = { undoTo: [], suggest: [], review: [], exits: 0, threatReqs: [], cancels: 0, judge: [], need: [], focus: [] };
    w.HTMLElement.prototype.focus = function () { calls.focus.push(this.id || this.tagName); };
    w.SVGElement.prototype.focus = function () {};
    const set = (k, v) => { if (!(k in saved)) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
    set('window', w); set('document', w.document); set('localStorage', w.localStorage);
    set('fetch', async (u) => { const f = path.join(ROOT, String(u)); return fs.existsSync(f) ? { ok: true, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) } : { ok: false, json: async () => null }; });
    const state = { turn: 'w', ply: 0, history: [], result: null, over: false, moving: false, reviewIndex: null };
    const board = (snapshot && snapshot.board) || START_BOARD;
    set('getCurrentGameStateSnapshot', () => JSON.parse(JSON.stringify(snapshot || { board, currentPlayer: state.turn, castlingRights: { w: { K: true, Q: true }, b: { K: true, Q: true } }, enPassantTarget: null, halfmoveClock: 0, fullmoveNumber: 1, positionHistory: [] })));
    set('getPieceAt', (r, c) => board[r]?.[c] ?? null);
    set('requestAnalysis', engine ? () => ({ promise: Promise.resolve(null), cancel() {} }) : undefined);
    set('requestThreats', (st) => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const h = { promise, cancel: () => { calls.cancels++; resolve(null); }, resolve, state: st };
        calls.threatReqs.push(h);
        if (threats !== null) Promise.resolve().then(() => resolve(threats));
        return h;
    });
    const listeners = [], infos = [];
    const fire = (e) => { for (const fn of listeners) fn(e); };
    const controller = {
        onEvent: (fn) => listeners.push(fn),
        state: () => state,
        isHumanColor: (c) => !!humans[c],
        setAnalysisNeed: (src, opts) => calls.need.push([src, opts]),
        plyInfo: (ply) => infos[ply] || null,
        // judgements: { ply: result } answers at once; otherwise the test resolves calls.judge[i]
        judgePly: (ply) => {
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            calls.judge.push({ ply, resolve });
            if (judgements && ply in judgements) Promise.resolve().then(() => resolve(judgements[ply]));
            return promise;
        },
        undoTo: (index) => { calls.undoTo.push(index); state.ply = index; state.history.length = index; infos.length = index + 1; state.turn = index % 2 ? 'b' : 'w'; fire({ type: 'reset', reason: 'undo', ply: index }); return true; },
        showSuggestion: (m) => { calls.suggest.push(m); return true; },
        enterReview: (index, opts) => { calls.review.push([index, opts || {}]); state.reviewIndex = index; fire({ type: 'review', index }); return true; },
        exitReview: () => { calls.exits++; state.reviewIndex = null; fire({ type: 'review', index: null }); },
    };
    const coach = createCoach({ controller, sceneAPI: {}, log: () => {} });
    const emit = async (e) => { fire(e); await flush(); };
    const $ = (id) => w.document.getElementById(id);
    // A move was played: the controller knows it (plyInfo, state) and says so (moveDone)
    const played = async (ply, { human = ply % 2 === 1 ? !!humans.w : !!humans.b, notation = `m${ply}`, piece = ply % 2 ? 'B' : 'n', from = { row: 7, col: 5 }, to = { row: 4, col: 2 }, over = false } = {}) => {
        const mover = ply % 2 ? 'w' : 'b';
        infos[ply] = { ply, mover, piece, from, to, notation, moveNumber: Math.floor((ply - 1) / 2) + 1, human };
        state.ply = ply; state.history[ply - 1] = notation; state.turn = mover === 'w' ? 'b' : 'w'; state.over = over; state.result = over ? 'checkmate' : null;
        await emit({ type: 'moveDone', ply, mover, isAI: !human, piece, from, square: to, notation, status: { over } });
    };
    const answer = async (ply, j) => { const c = calls.judge.filter((x) => x.ply === ply && !x.done).pop(); assert.ok(c, `judgePly(${ply}) was asked`); c.done = true; c.resolve(j); await flush(); };
    const card = () => $('coach-card');
    return { w, coach, emit, played, answer, calls, state, $, card, cardText: () => $('coach-text').textContent, warning: () => ($('coach-warning').hidden ? '' : $('coach-warning').textContent),
        badge: () => ($('coach-badge').hidden ? '' : $('coach-badge').textContent), moves: () => [...$('coach-review-list').querySelectorAll('button')] };
}
function restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } saved = {}; }
const BEST = { from: { row: 7, col: 6 }, to: { row: 5, col: 5 } }; // knight g1 to f3
const verdict = (ply, classification = 'blunder', extra = {}) => ({
    ply, mover: ply % 2 ? 'w' : 'b', classification, evalBefore: 30, evalAfter: BAD.includes(classification) ? -600 : 20, motifs: [], brilliant: false,
    bestBefore: BEST, playedBest: classification === 'best', stateBefore: { board: START_BOARD }, ...extra,
});
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const ON = { coach: true, coachFrequency: 'every' }, MISTAKES = { coach: true, coachFrequency: 'mistakes' };

describe('battle3d coach (v6.1)', { skip: !have && 'coach.js not present' }, () => {
    before(async () => { ({ createCoach } = await import(pathToFileURL(FILE).href)); });
    beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
    afterEach(() => { mock.timers.reset(); restore(); });

    test('off by default: no card, no analysis need; the toggle enables it and both settings are saved', async () => {
        const C = setup();
        assert.equal(C.$('coach-toggle').checked, false);
        assert.deepEqual(C.calls.need.pop(), ['coach', null]);
        await C.played(1);
        assert.equal(C.card().hidden, true, 'no card while off');
        assert.equal(C.calls.judge.length, 0, 'nothing judged while off');
        C.$('coach-toggle').checked = true;
        C.$('coach-toggle').dispatchEvent(new C.w.Event('change'));
        assert.equal(JSON.parse(C.w.localStorage.getItem('battle3d.settings')).coach, true);
        assert.ok(C.calls.need.pop()[1].nodes > 0, 'asks the controller for analysis');
        C.$('coach-frequency').value = 'mistakes';
        C.$('coach-frequency').dispatchEvent(new C.w.Event('change'));
        assert.equal(JSON.parse(C.w.localStorage.getItem('battle3d.settings')).coachFrequency, 'mistakes');
        assert.equal(C.$('coach-review-open').hidden, false, 'Review game is available with the coach on or off');
    });

    test('"Every move": thinking at once, then the verdict; it stays through the AI reply and never fades', async () => {
        const C = setup({ settings: ON });
        await C.played(1, { notation: 'Bc4' });
        assert.equal(C.card().hidden, false, 'card at once');
        assert.ok(C.card().classList.contains('pending'));
        assert.equal(C.badge(), 'Thinking');
        assert.equal(C.$('coach-spinner').hidden, false);
        assert.match(C.$('coach-move').textContent, /1\.\s*Bc4/);
        await C.answer(1, verdict(1, 'good'));
        assert.equal(C.card().classList.contains('pending'), false);
        assert.equal(C.badge(), 'Good');
        assert.equal(C.$('coach-spinner').hidden, true);
        assert.ok(C.cardText().length > 5 && !/[{}]/.test(C.cardText()), C.cardText());
        assert.equal(C.$('coach-actions').hidden, true, 'no actions on a good move');
        assert.match(C.$('announce').textContent, /^Coach: Good\./);
        await C.played(2);
        mock.timers.tick(60000);
        assert.equal(C.card().hidden, false, 'still there after the AI reply and a minute');
        assert.equal(C.badge(), 'Good');
        await C.played(3, { notation: 'Nf3' });
        assert.equal(C.badge(), 'Thinking', 'the next coached move replaces it');
        assert.match(C.$('coach-move').textContent, /2\.\s*Nf3/);
    });

    test('Human vs Human: both sides are coached and the card says whose move it was', async () => {
        const C = setup({ settings: ON, humans: { w: true, b: true } });
        await C.played(1, { notation: 'e4' });
        assert.match(C.$('coach-move').textContent, /White:/);
        await C.played(2, { notation: 'e5' });
        assert.match(C.$('coach-move').textContent, /Black:/);
        assert.deepEqual(C.calls.judge.map((j) => j.ply), [1, 2]);
    });

    test('a blunder: warn card with Take it back and Show me better; both undo to before the move', async () => {
        const C = setup({ settings: ON });
        await C.played(1);
        await C.played(2);
        await C.played(3, { notation: 'Bc4' });
        await C.answer(3, verdict(3, 'blunder'));
        assert.equal(C.badge(), 'Blunder');
        assert.ok(C.card().classList.contains('warn'));
        assert.equal(C.$('coach-actions').hidden, false);
        assert.equal(C.$('coach-better').hidden, false);
        await C.played(4); // the AI already replied
        assert.equal(C.$('coach-actions').hidden, false, 'actions survive the AI reply');
        C.$('coach-undo').click();
        assert.deepEqual(C.calls.undoTo, [2], 'back to before the blunder (both plies)');
        assert.equal(C.card().hidden, false);
        assert.match(C.cardText(), /taken back/i);
        assert.equal(C.$('coach-actions').hidden, true);
        // again: same move, same blunder, this time Show me better
        await C.played(3, { notation: 'Bc4' });
        await C.answer(3, verdict(3, 'blunder'));
        C.$('coach-better').click();
        assert.deepEqual(C.calls.undoTo, [2, 2]);
        assert.deepEqual(C.calls.suggest.map((m) => [m.from, m.to]), [[BEST.from, BEST.to]]);
        assert.match(C.cardText(), /knight to f3/i, 'names the better move');
    });

    test('no better move known (the played move was best of a bad lot): Show me better is hidden', async () => {
        const C = setup({ settings: ON });
        await C.played(1);
        await C.answer(1, verdict(1, 'mistake', { bestBefore: null }));
        assert.equal(C.$('coach-actions').hidden, false);
        assert.equal(C.$('coach-better').hidden, true);
    });

    test('motif explanation wins over the generic classification text', async () => {
        const C = setup({ settings: ON });
        await C.played(1, { notation: 'Bc4' });
        await C.answer(1, verdict(1, 'blunder', { motifs: [{ motif: 'hanging', by: 'b', squares: ['c4', 'b5'], pieces: ['B', 'p'] }] }));
        assert.match(C.cardText(), /bishop|c4/i, `motif text mentions the hanging bishop: ${C.cardText()}`);
    });

    test('"Mistakes only": no thinking state, no praise, no warnings; a mistake gets a card; the next move clears it', async () => {
        const C = setup({ settings: MISTAKES, threats: { threats: [{ move: { from: { row: 1, col: 4 }, to: { row: 6, col: 4 } }, gain: 900, motif: 'capture' }] } });
        await C.played(1);
        assert.equal(C.card().hidden, true, 'no thinking card');
        await C.answer(1, verdict(1, 'best'));
        assert.equal(C.card().hidden, true, 'no praise');
        await C.played(2);
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 2 });
        mock.timers.tick(3000); await flush();
        assert.equal(C.calls.threatReqs.length, 0, 'no warnings in this mode');
        await C.played(3);
        await C.answer(3, verdict(3, 'mistake'));
        assert.equal(C.card().hidden, false);
        assert.equal(C.badge(), 'Mistake');
        assert.equal(C.$('coach-actions').hidden, false);
        await C.played(4);
        assert.equal(C.card().hidden, false, 'kept through the AI reply');
        await C.played(5);
        assert.equal(C.card().hidden, true, 'a new coached move hides the old mistake card');
    });

    test('no engine: the card says so; a failing analysis is retried twice, then reported', async () => {
        const N = setup({ settings: ON, engine: false });
        await N.played(1);
        assert.equal(N.card().hidden, false);
        assert.match(N.cardText(), /engine is not available/i);
        assert.equal(N.calls.judge.length, 0);
        restore();
        const C = setup({ settings: ON });
        await C.played(1);
        for (let attempt = 1; attempt <= 3; attempt++) {
            assert.equal(C.calls.judge.length, attempt, `attempt ${attempt}`);
            assert.equal(C.badge(), 'Thinking');
            await C.answer(1, null);
            mock.timers.tick(200); await flush();
        }
        assert.equal(C.calls.judge.length, 3, 'three attempts at most');
        assert.match(C.cardText(), /could not analyse/i);
        assert.equal(C.card().classList.contains('pending'), false);
    });

    for (const [name, reset] of [['undo', (C) => C.emit({ type: 'reset', reason: 'undo', ply: 0 })], ['new game', (C) => C.emit({ type: 'reset', reason: 'newGame' })]]) {
        test(`a verdict that arrives after ${name} is dropped`, async () => {
            const C = setup({ settings: ON });
            await C.played(1);
            C.state.ply = 0; C.state.history.length = 0;
            await reset(C);
            assert.equal(C.card().hidden, true, 'card cleared');
            await C.answer(1, verdict(1, 'blunder'));
            mock.timers.tick(1000); await flush();
            assert.equal(C.card().hidden, true, 'late verdict ignored');
            C.coach.openReview();
            assert.equal(C.moves().length, 0, 'and not in the review');
        });
    }

    test('the close button dismisses the card until there is something new', async () => {
        const C = setup({ settings: ON });
        await C.played(1);
        await C.answer(1, verdict(1, 'good'));
        C.$('coach-close').click();
        assert.equal(C.card().hidden, true);
        await C.played(2);
        assert.equal(C.card().hidden, true, 'the AI reply does not bring it back');
        await C.played(3);
        assert.equal(C.card().hidden, false, 'the next coached move does');
    });

    test('warning: a threat is shown before the human move in its own line, at most one, cleared by the move', async () => {
        const C = setup({ settings: ON, threats: { threats: [{ move: { from: { row: 1, col: 4 }, to: { row: 6, col: 4 } }, gain: 300, motif: 'capture' }] } });
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
        mock.timers.tick(900);
        assert.equal(C.calls.threatReqs.length, 0, 'waits about a second');
        mock.timers.tick(300);
        await flush();
        assert.equal(C.calls.threatReqs.length, 1, 'one threat request');
        assert.equal(C.card().hidden, false);
        const first = C.warning();
        assert.ok(first.length > 5 && !/[{}]/.test(first), `warning shown: ${first}`);
        assert.equal(C.$('coach-actions').hidden, true, 'a warning has no actions');
        assert.doesNotMatch(first, /\be2\b.*\bto\b|try /i);
        await C.played(11);
        assert.equal(C.warning(), '', 'cleared by the move');
    });

    test('no warnings while off, on the AI turn, or after game over', async () => {
        const C = setup({ settings: { coach: false } });
        await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
        mock.timers.tick(2000); await flush();
        assert.equal(C.calls.threatReqs.length, 0);
        restore();
        const D = setup({ settings: ON });
        await D.emit({ type: 'turn', color: 'b', human: false, over: false, ply: 11 });
        await D.emit({ type: 'turn', color: 'w', human: true, over: true, ply: 11 });
        mock.timers.tick(2000); await flush();
        assert.equal(D.calls.threatReqs.length, 0);
    });

    for (const [name, act] of [['a move', (C) => C.played(11)], ['undo', (C) => C.emit({ type: 'reset', reason: 'undo', ply: 8 })], ['new game', (C) => C.emit({ type: 'reset', reason: 'newGame', ply: 0 })]]) {
        test(`a pending threat request is cancelled by ${name} and its late answer ignored`, async () => {
            const C = setup({ settings: ON });
            await C.emit({ type: 'turn', color: 'w', human: true, over: false, ply: 10 });
            mock.timers.tick(1300); await flush();
            const h = C.calls.threatReqs[0];
            assert.ok(h, 'request in flight');
            await act(C);
            assert.equal(C.calls.cancels, 1, 'cancelled');
            h.resolve({ threats: [{ move: { from: { row: 1, col: 4 }, to: { row: 6, col: 4 } }, gain: 900, motif: 'capture' }] });
            await flush();
            assert.equal(C.warning(), '', 'late answer ignored');
        });
    }

    // A 6-ply game: White (human) blundered on ply 3 and played a mistake with no better move on ply 5
    async function game(C, { judged = true } = {}) {
        const J = { 1: verdict(1, 'good'), 2: verdict(2, 'blunder'), 3: verdict(3, 'blunder'), 4: verdict(4, 'good'), 5: verdict(5, 'mistake', { bestBefore: null }), 6: verdict(6, 'best') };
        for (let ply = 1; ply <= 6; ply++) {
            await C.played(ply, { notation: ['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7'][ply - 1] });
            if (judged && ply % 2 === 1) await C.answer(ply, J[ply]);
        }
        return J;
    }

    test('review: opens mid-game as a docked panel, lists every move, judges the rest one at a time', async () => {
        const C = setup({ settings: ON });
        const J = await game(C);
        C.$('coach-review-open').click();
        const panel = C.$('coach-review');
        assert.equal(panel.hidden, false);
        assert.equal(panel.classList.contains('modal'), false, 'not a modal: the board stays usable');
        assert.ok(C.w.document.body.classList.contains('review-open'));
        assert.equal(C.moves().length, 6, 'every move listed');
        assert.deepEqual(C.moves().map((b) => b.dataset.ply), ['1', '2', '3', '4', '5', '6']);
        assert.deepEqual(C.moves().map((b) => (b.classList.contains('human') ? 'h' : 'a')).join(''), 'hahaha');
        assert.match(C.$('coach-review-intro').textContent, /Analysing the moves: 3 of 6 done/);
        // the AI's moves are judged in the background, one request at a time
        const open = () => C.calls.judge.filter((j) => !j.done).map((j) => j.ply);
        assert.deepEqual(open(), [2]);
        await C.answer(2, J[2]);
        assert.deepEqual(open(), [4]);
        await C.answer(4, J[4]);
        await C.answer(6, J[6]);
        assert.match(C.$('coach-review-intro').textContent, /1 mistake, 1 blunder flagged\./, C.$('coach-review-intro').textContent);
        assert.deepEqual(C.moves().filter((b) => b.classList.contains('flagged')).map((b) => b.dataset.ply), ['3', '5'], 'only the human player\'s bad moves are flagged (not the AI blunder on ply 2)');
        assert.ok(C.$('coach-review-graph').querySelector('path'), 'graph drawn');
        assert.ok(!/[{}]/.test(panel.textContent), 'no unfilled slots');
    });

    test('review selection: a flagged move with a better move shows the position before it with the arrow; others the position after; the last move is the live game', async () => {
        const C = setup({ settings: ON });
        await game(C);
        C.coach.openReview();
        C.moves()[2].click(); // 2.Qh5, blunder with a better move
        let [index, opts] = C.calls.review.pop();
        assert.equal(index, 2, 'the position before ply 3');
        assert.deepEqual([opts.arrow.from, opts.arrow.to], [BEST.from, BEST.to]);
        assert.ok(opts.lastMove && opts.lastMove.from && opts.lastMove.to, 'the played move is highlighted');
        assert.equal(C.$('coach-review').hidden, false, 'the panel stays open');
        assert.deepEqual(C.moves().filter((b) => b.classList.contains('selected') && b.getAttribute('aria-current') === 'true').map((b) => b.dataset.ply), ['3']);
        assert.match(C.$('coach-review-detail').textContent, /Blunder/);
        assert.match(C.$('coach-review-detail').textContent, /knight to f3/i);
        C.moves()[4].click(); // 3.Qxf7+, a mistake without a better move
        [index, opts] = C.calls.review.pop();
        assert.equal(index, 5, 'the position after ply 5');
        assert.equal(opts.arrow, undefined);
        C.moves()[1].click(); // an AI move
        assert.equal(C.calls.review.pop()[0], 2);
        const exits = C.calls.exits;
        C.moves()[5].click(); // the last move
        assert.equal(C.calls.exits, exits + 1, 'the last move is the live position');
        assert.equal(C.state.reviewIndex, null);
        assert.equal(C.$('coach-review-return').disabled, true, '"Return to game" is disabled while live');
    });

    test('review stepping: prev / next, flagged prev / next, arrows keys; Next past the end returns to the game', async () => {
        const C = setup({ settings: ON });
        await game(C);
        C.coach.openReview();
        const sel = () => C.coach.state().reviewSelected;
        C.$('coach-review-prev').click();
        assert.equal(sel(), 6, 'Previous from the live game selects the last move');
        C.$('coach-review-prev').click();
        assert.equal(sel(), 5);
        C.$('coach-review-prev-flag').click();
        assert.equal(sel(), 3, 'previous flagged');
        C.$('coach-review-next-flag').click();
        assert.equal(sel(), 5, 'next flagged');
        C.$('coach-review').dispatchEvent(new C.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        assert.equal(sel(), 4, 'Left arrow');
        C.$('coach-review').dispatchEvent(new C.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        assert.equal(sel(), 5, 'Right arrow');
        C.$('coach-review-next').click();
        assert.equal(sel(), 6);
        C.state.reviewIndex = 3; // as if an earlier position were still on the board
        C.$('coach-review-next').click();
        assert.equal(C.state.reviewIndex, null, 'Next past the last move returns to the game');
    });

    test('review minimise / chip / close / Escape: selection kept, close returns to the game and hands focus back', async () => {
        const C = setup({ settings: ON });
        await game(C);
        C.coach.openReview();
        assert.ok(C.calls.focus.includes('coach-review-title'), 'focus moves into the panel');
        C.moves()[2].click();
        C.$('coach-review-min').click();
        assert.equal(C.$('coach-review').hidden, true);
        assert.equal(C.$('coach-review-chip').hidden, false);
        assert.match(C.$('coach-review-chip').textContent, /Back to review.*earlier position/);
        assert.equal(C.state.reviewIndex, 2, 'the board stays on the earlier position');
        C.$('coach-review-chip').click();
        assert.equal(C.$('coach-review').hidden, false);
        assert.equal(C.$('coach-review-chip').hidden, true);
        assert.deepEqual(C.moves().filter((b) => b.classList.contains('selected')).map((b) => b.dataset.ply), ['3'], 'selection kept');
        // Escape: the first one belongs to the controller (leave the earlier position); the panel closes only when live
        const esc = () => C.w.document.dispatchEvent(new C.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        esc();
        assert.equal(C.$('coach-review').hidden, false, 'Escape while viewing the past does not close the panel');
        C.$('coach-review-return').click();
        assert.equal(C.state.reviewIndex, null);
        esc();
        assert.equal(C.$('coach-review').hidden, true, 'Escape in the live game closes it');
        assert.equal(C.calls.focus.pop(), 'coach-review-open', 'focus back on the Review game button');
        // the close button from an earlier position also returns to the game
        C.coach.openReview();
        C.moves()[2].click();
        const exits = C.calls.exits;
        C.$('coach-review-close').click();
        assert.equal(C.$('coach-review').hidden, true);
        assert.equal(C.calls.exits, exits + 1);
        assert.equal(C.w.document.body.classList.contains('review-open'), false);
    });

    test('game over: the review opens by itself after 2.5 s (coach on), with a result line; not when the coach is off', async () => {
        const C = setup({ settings: ON });
        await game(C);
        await C.played(7, { notation: 'Qh5#', over: true });
        await C.answer(7, verdict(7, 'best'));
        mock.timers.tick(2000);
        assert.equal(C.$('coach-review').hidden, true);
        mock.timers.tick(600); await flush();
        assert.equal(C.$('coach-review').hidden, false, 'opens after game over');
        restore();
        const D = setup({ settings: { coach: false } });
        await D.played(1, { over: true });
        mock.timers.tick(5000); await flush();
        assert.equal(D.$('coach-review').hidden, true);
        D.$('coach-review-open').click();
        assert.equal(D.$('coach-review').hidden, false, 'still available by hand');
    });

    test('zero moves and no engine: the review says so and stepping does nothing harmful', async () => {
        const C = setup({ settings: ON });
        C.coach.openReview();
        assert.match(C.$('coach-review-intro').textContent, /No moves yet/);
        assert.equal(C.moves().length, 0);
        C.$('coach-review-prev').click();
        C.$('coach-review-next').click();
        assert.deepEqual(C.calls.review, []);
        restore();
        const N = setup({ settings: ON, engine: false });
        await N.played(1); await N.played(2);
        N.coach.openReview();
        assert.match(N.$('coach-review-intro').textContent, /engine is not available/i);
        N.$('coach-review-prev').click();
        N.$('coach-review-prev').click();
        assert.equal(N.calls.review.pop()[0], 1, 'stepping still works without the engine');
    });

    test('new game clears the records, the card and the selection; undo truncates them', async () => {
        const C = setup({ settings: ON });
        await game(C);
        C.coach.openReview();
        C.moves()[4].click();
        C.state.ply = 4; C.state.history.length = 4;
        await C.emit({ type: 'reset', reason: 'undo', ply: 4 });
        assert.equal(C.moves().length, 4, 'undone moves leave the list');
        assert.equal(C.coach.state().reviewSelected, null, 'a selection on an undone move is dropped');
        C.state.ply = 0; C.state.history.length = 0;
        await C.emit({ type: 'reset', reason: 'newGame' });
        assert.equal(C.card().hidden, true);
        assert.equal(C.moves().length, 0);
        assert.match(C.$('coach-review-intro').textContent, /No moves yet/);
    });
});
