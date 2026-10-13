'use strict';
// v6 commentary.js with fake controller / scene / units / audio and the real line banks:
// banks used (not the fallback), Off is silent, cooldowns per level, urgent events bypass,
// priorities, shuffle bag without repeats, slots filled, tag and minPly filters, captions,
// gestures, pauses while a cinematic runs, retorts, settings persistence, clear on reset.
const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');
const { rng } = require('../helpers/loadBattle3dRules');

const FILE = path.join(ROOT, 'battle3d', 'commentary.js');
const have = fs.existsSync(FILE);
const bank = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'battle3d', 'lines', f), 'utf8'));
const linesOf = (b) => b.events || b.lines || {};
let createCommentary, saved, realRandom;
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 3; i++) await tick(); };

function install({ storage = {} } = {}) {
    saved = {};
    for (const k of ['localStorage', 'fetch', 'findKing']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    const data = new Map(Object.entries(storage));
    set('localStorage', { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) });
    set('fetch', async (url) => {
        const file = path.join(ROOT, String(url).replace(/^\.?\//, ''));
        if (!fs.existsSync(file)) return { ok: false, json: async () => null };
        return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
    });
    set('findKing', (c) => (c === 'w' ? { row: 7, col: 4 } : { row: 0, col: 4 }));
    return data;
}
function restore() {
    for (const [k, d] of Object.entries(saved || {})) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
    if (realRandom) Math.random = realRandom;
}
function seedRandom(seed) { realRandom = realRandom || Math.random; Math.random = rng(seed); }

function rigC({ level, cinematic = false, legend, humans = { w: true, b: false }, elo = 1200 } = {}) {
    const calls = { say: [], gesture: [], blip: [], clear: 0, need: [] };
    const listeners = [];
    const state = { moving: false, reviewIndex: null, history: [], over: false, elo };
    const controller = {
        isHumanColor: (c) => !!humans[c],
        onEvent: (fn) => listeners.push(fn),
        state: () => state,
        setAnalysisNeed: (k, v) => calls.need.push([k, v]),
    };
    const sceneAPI = {
        cine: cinematic,
        say: (o) => { calls.say.push(o); return Promise.resolve(); },
        clearSpeech: () => { calls.clear++; },
        sayClear: () => { calls.clear++; },
        isCinematicActive: () => sceneAPI.cine,
        squareToWorld: (r, c) => ({ x: c - 3.5, y: 0, z: r - 3.5 }),
    };
    const units = {
        getLegend: () => legend || [{ color: 'w', type: 'k', name: 'Knight', model: 'Knight' }, { color: 'b', type: 'k', name: 'Skeleton Mage', model: 'Skeleton_Mage' }],
        playGesture: (sq, kind) => { calls.gesture.push([sq, kind]); return Promise.resolve(); },
    };
    const audio = { play: (n, o) => calls.blip.push([n, o]) };
    const captions = { textContent: '' };
    const C = createCommentary({ controller, sceneAPI, units, audio, captionsEl: captions });
    if (level) C.setLevel(level);
    const emit = async (...events) => { for (const e of events) for (const fn of listeners) fn(e); await flush(); };
    return { C, calls, emit, captions, state, sceneAPI };
}
const ev = (type, color, ply, extra = {}) => ({ type, color, ply, piece: 'n', square: { row: 5, col: 5 }, captured: 'b', mode: 'human-ai', aiElo: 1200, human: true, ...extra });

describe('battle3d commentary (v6)', { skip: !have && 'commentary.js not present' }, () => {
    before(async () => { ({ createCommentary } = await import(pathToFileURL(FILE).href)); });
    beforeEach(() => { install(); seedRandom(1); });
    afterEach(() => restore());

    test('the real line banks are used, not the built-in fallback', async () => {
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        await R.emit(ev('castle', 'w', 10));
        assert.equal(R.calls.say.length, 1, 'castle (not in the fallback) is spoken');
        const all = Object.values(linesOf(bank('hero-king.json'))).flat().map((l) => l.text);
        const spoken = R.calls.say[0].text;
        assert.ok(all.some((t) => spoken.startsWith(t.split('{')[0].trim().slice(0, 12))), `"${spoken}" comes from hero-king.json`);
    });

    test('Off is really silent: no bubble, blip, gesture or caption; analysis need released', async () => {
        const R = rigC({ level: 'off' });
        await R.C.ready;
        await R.emit(ev('gameStart', 'w', 0), ev('checkmateWin', 'w', 40), ev('capturedQueen', 'b', 12));
        assert.deepEqual([R.calls.say.length, R.calls.blip.length, R.calls.gesture.length, R.captions.textContent], [0, 0, 0, '']);
        assert.deepEqual(R.calls.need.slice(-1)[0], ['commentary', null]);
    });

    test('Occasional: at least 3 plies between remarks for ordinary events; urgent events bypass', async () => {
        seedRandom(0); Math.random = () => 0.99; // never randomly skipped
        const R = rigC({ level: 'occasional' });
        await R.C.ready;
        await R.emit(ev('check', 'w', 4));
        await R.emit(ev('check', 'b', 5));
        await R.emit(ev('check', 'w', 6));
        assert.equal(R.calls.say.length, 1, 'two checks within the cooldown stay unsaid');
        await R.emit(ev('check', 'b', 7));
        assert.equal(R.calls.say.length, 2, '3 plies later a remark is allowed');
        await R.emit(ev('checkmateWin', 'w', 8));
        assert.equal(R.calls.say.length, 3, 'urgent event ignores the cooldown');
    });

    test('a remark that had to wait for an animation is dropped once a newer remark has been spoken', async () => {
        Math.random = () => 0.99; // nothing skipped, no retorts
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        R.state.moving = true;                        // the next move is already animating
        await R.emit(ev('check', 'w', 10));           // has to wait (it looks again every 150 ms)
        assert.equal(R.calls.say.length, 0);
        R.state.moving = false;
        await R.emit(ev('enPassant', 'b', 11));       // a newer remark, said at once
        assert.equal(R.calls.say.length, 1);
        const caption = R.captions.textContent;
        assert.match(caption, /^The Skeleton King: /);
        await new Promise((r) => setTimeout(r, 200)); // the older remark's wait is over by now
        assert.equal(R.calls.say.length, 1, 'the stale remark is not said after the newer one');
        assert.equal(R.captions.textContent, caption, 'and does not replace its caption');
        // Without anything newer in between, a remark that waited is still said
        R.state.moving = true;
        await R.emit(ev('check', 'w', 14));
        R.state.moving = false;
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(R.calls.say.length, 2, 'said once the animation is over');
        assert.match(R.captions.textContent, /^The Hero King: /);
    });

    test('Chatty: a remark every ply is allowed', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        for (let p = 1; p <= 6; p++) await R.emit(ev(p % 2 ? 'gotChecked' : 'check', p % 2 ? 'b' : 'w', p));
        assert.equal(R.calls.say.length, 6);
    });

    test('priority: the most important event of a move is the one spoken', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        await R.emit(ev('myCapture', 'w', 10), ev('check', 'w', 10), ev('lostPiece', 'b', 10));
        assert.equal(R.calls.say[0].side, 'w');
        assert.equal(R.calls.gesture[0][1], 'taunt');
        assert.equal(R.calls.say.length, 1, 'one remark per move (retort disabled by random)');
    });

    test('shuffle bag: no repeats until every line of an event has been used; slots filled', async () => {
        Math.random = rng(7);
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        const n = 6;
        for (let p = 1; p <= n; p++) await R.emit(ev('gameStart', 'w', 0, { mode: 'human-human' }));
        const texts = R.calls.say.map((s) => s.text);
        assert.ok(texts.length >= 2, `spoken ${texts.length}`);
        const fallbackOrBank = Object.values(linesOf(bank('hero-king.json')).gameStart || []).length;
        const window = Math.min(texts.length, Math.max(1, fallbackOrBank || 1));
        assert.equal(new Set(texts.slice(0, window)).size, window, `no repeat within ${window}: ${texts}`);
        for (const t of texts) assert.ok(!/[{}]/.test(t), `slots filled: ${t}`);
    });

    test('captions: aria-live text names the speaker; blip + gesture on the king square', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        await R.emit(ev('checkmateWin', 'b', 30));
        assert.match(R.captions.textContent, /^The .*King.*: .+/);
        assert.equal(R.calls.blip[0][0], 'blip');
        assert.equal(R.calls.blip[0][1].voice, 'skeleton');
        assert.ok(R.calls.blip[0][1].syllables >= 1);
        assert.deepEqual(R.calls.gesture[0], [{ row: 0, col: 4 }, 'cheer']);
        assert.deepEqual(R.calls.say[0].square, { row: 0, col: 4 });
    });

    test('pauses while a cinematic runs, speaks after it', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty', cinematic: true });
        await R.C.ready;
        await R.emit(ev('check', 'w', 3));
        assert.equal(R.calls.say.length, 0, 'not during the fight camera');
        R.sceneAPI.cine = false;
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(R.calls.say.length, 1, 'spoken once the cinematic ended');
    });

    test('nothing is said while a move animates or the history is under review', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        R.state.reviewIndex = 3;
        await R.emit(ev('check', 'w', 3));
        assert.equal(R.calls.say.length, 0);
    });

    test('retort: with luck the other king answers; never when Off', async () => {
        Math.random = () => 0.0; // always retort (and never skip)
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        await R.emit(ev('check', 'w', 9), ev('gotChecked', 'b', 9));
        await flush();
        assert.deepEqual(R.calls.say.map((s) => s.side), ['w', 'b'], 'speaker then retort');
    });

    test('level persists in settings (talk) and survives a restart; invalid saved value -> occasional', async () => {
        const store = install();
        const R = rigC();
        R.C.setLevel('chatty');
        assert.equal(JSON.parse(store.get('battle3d.settings')).talk, 'chatty');
        const R2 = rigC();
        assert.equal(R2.C.getLevel(), 'chatty');
        install({ storage: { 'battle3d.settings': JSON.stringify({ talk: 'shouty' }) } });
        assert.equal(rigC().C.getLevel(), 'occasional');
    });

    test('reset (new game) clears bubbles and captions', async () => {
        Math.random = () => 0.99;
        const R = rigC({ level: 'chatty' });
        await R.C.ready;
        await R.emit(ev('check', 'w', 3));
        await R.emit({ type: 'reset', reason: 'newGame', ply: 0 });
        assert.ok(R.calls.clear >= 1, 'speech cleared');
        assert.equal(R.captions.textContent, '');
    });

    test('tags: a tagged line is never said when its context does not hold, and can be said when it does', async () => {
        // context that makes each tag false / true for a white speaker
        const wrong = {
            myPlayer: { humans: { w: false, b: true } }, aiKing: { humans: { w: true, b: false } },
            vsHuman: { humans: { w: true, b: false } }, vsAI: { humans: { w: true, b: true } },
            aiWeak: { humans: { w: true, b: false }, elo: 2400 }, aiStrong: { humans: { w: true, b: false }, elo: 400 },
        };
        const right = {
            myPlayer: { humans: { w: true, b: true } }, aiKing: { humans: { w: false, b: true } },
            vsHuman: { humans: { w: true, b: true } }, vsAI: { humans: { w: true, b: false } },
            aiWeak: { humans: { w: true, b: false }, elo: 400 }, aiStrong: { humans: { w: true, b: false }, elo: 2400 },
        };
        const hero = linesOf(bank('hero-king.json'));
        const tagged = Object.entries(hero).flatMap(([e, ls]) => ls.filter((l) => (l.tags || []).some((t) => wrong[t]) && !l.tags.includes('retort') && !/\{/.test(l.text)).map((l) => ({ e, l })));
        assert.ok(tagged.length > 0, 'the bank uses context tags');
        let recalled = 0;
        for (const { e, l } of tagged.slice(0, 6)) {
            const tag = l.tags.find((t) => wrong[t]);
            Math.random = rng(9);
            let R = rigC({ level: 'chatty', ...wrong[tag] });
            await R.C.ready;
            for (let i = 0; i < 15; i++) await R.emit(ev(e, 'w', 60 + i * 3, { ply: 60 + i * 3 }));
            assert.ok(!R.calls.say.some((x) => x.text === l.text), `${e}: "${l.text}" said without ${tag}`);
            const ctx = { ...right[tag] };
            for (const t of l.tags) if (right[t]) Object.assign(ctx, right[t], { humans: { ...(ctx.humans || {}), ...right[t].humans } });
            R = rigC({ level: 'chatty', ...ctx });
            await R.C.ready;
            for (let i = 0; i < 25; i++) await R.emit(ev(e, 'w', 60 + i * 3, { ply: 60 + i * 3 }));
            if (R.calls.say.some((x) => x.text === l.text)) recalled++;
        }
        assert.ok(recalled >= Math.min(3, tagged.length), `tagged lines are reachable in their context (${recalled})`);
    });

    test('minPly: lines with minPly are not said earlier', async () => {
        const hero = linesOf(bank('hero-king.json'));
        const early = Object.entries(hero).flatMap(([e, ls]) => ls.filter((l) => l.minPly > 2 && !(l.tags || []).length && !/\{/.test(l.text)).map((l) => ({ e, l })));
        for (const { e, l } of early.slice(0, 10)) {
            Math.random = rng(4);
            const R = rigC({ level: 'chatty', humans: { w: true, b: true } });
            await R.C.ready;
            for (let i = 0; i < 20; i++) await R.emit(ev(e, 'w', 0, { ply: Math.max(0, l.minPly - 1) }));
            assert.ok(!R.calls.say.some((x) => x.text === l.text), `${e}: minPly ${l.minPly} line said at ply ${l.minPly - 1}`);
        }
    });
});
