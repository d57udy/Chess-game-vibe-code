'use strict';
// v6 line banks (battle3d/lines/*.json): schema, counts, every game event covered for both kings,
// valid slots only, short lines, no duplicates, house style (no em/en dashes, no profanity), and
// coach templates covering every motif and classification. Skips until the files exist.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');

const DIR = path.join(ROOT, 'battle3d', 'lines');
const KINGS = ['hero-king.json', 'skeleton-king.json'];
const EVENTS = ['gameStart', 'myCapture', 'lostPiece', 'lostQueen', 'capturedQueen', 'check', 'gotChecked', 'mateThreat',
    'promotion', 'castle', 'enPassant', 'blunderByOpponent', 'blunderByMe', 'brilliantMove', 'longThink', 'repetition',
    'endgame', 'winningBig', 'losingBig', 'stalemate', 'checkmateWin', 'checkmateLoss', 'draw', 'hintUsed', 'undoUsed', 'idle'];
const SLOTS = new Set(['piece', 'square', 'captured', 'opponent']);
const MOTIFS = ['fork', 'pin', 'skewer', 'hanging', 'backRank', 'missedCapture', 'allowsMate', 'missedMate', 'trappedPiece', 'discovered'];
const CLASSES = ['inaccuracy', 'mistake', 'blunder'];
const MAX_LEN = 90;
// PG check: a small deny-list (whole words), plus dashes the house style forbids.
const BAD_WORDS = /\b(damn|hell|crap|shit|fuck|bitch|bastard|ass|idiot|stupid|moron|retard|dumb|kill yourself)\b/i;
const DASHES = /[–—]|\s-\s|--/;

const have = KINGS.every((f) => fs.existsSync(path.join(DIR, f)));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
// Accepts { events: { type: [lines] } } or { type: [lines] } (top-level metadata keys ignored).
function eventsOf(bank) {
    const ev = bank.events && typeof bank.events === 'object' ? bank.events : bank;
    return Object.fromEntries(Object.entries(ev).filter(([k, v]) => Array.isArray(v)));
}
const lineText = (l) => (typeof l === 'string' ? l : l && l.text);

describe('battle3d king line banks', { skip: !have && 'battle3d/lines not written yet' }, () => {
    const banks = have ? Object.fromEntries(KINGS.map((f) => [f, eventsOf(load(f))])) : {};

    test('about 300 lines in total, about 150 per king', () => {
        const counts = Object.fromEntries(KINGS.map((f) => [f, Object.values(banks[f]).reduce((n, a) => n + a.length, 0)]));
        for (const f of KINGS) assert.ok(counts[f] >= 120 && counts[f] <= 220, `${f}: ${counts[f]} lines`);
        const total = counts[KINGS[0]] + counts[KINGS[1]];
        assert.ok(total >= 260 && total <= 400, `total ${total}`);
    });

    test('every event type is covered by both kings; no unknown event keys', () => {
        for (const f of KINGS) {
            const keys = Object.keys(banks[f]);
            const missing = EVENTS.filter((e) => !(banks[f][e] && banks[f][e].length));
            assert.deepEqual(missing, [], `${f} missing events`);
            assert.deepEqual(keys.filter((k) => !EVENTS.includes(k)), [], `${f} unknown event keys`);
            for (const e of ['gameStart', 'myCapture', 'lostPiece', 'check', 'gotChecked', 'checkmateWin', 'checkmateLoss']) {
                assert.ok(banks[f][e].length >= 3, `${f} ${e}: at least 3 lines for variety (${banks[f][e].length})`);
            }
        }
    });

    test('line schema: text (+ optional weight, minPly, tags) with sane values', () => {
        const bad = [];
        for (const f of KINGS) {
            for (const [e, lines] of Object.entries(banks[f])) {
                for (const l of lines) {
                    if (typeof l === 'string') continue;
                    if (!l || typeof l.text !== 'string') { bad.push(`${f} ${e}: ${JSON.stringify(l)}`); continue; }
                    const extra = Object.keys(l).filter((k) => !['text', 'weight', 'minPly', 'tags'].includes(k));
                    if (extra.length) bad.push(`${f} ${e}: unknown keys ${extra}`);
                    if (l.weight !== undefined && !(l.weight > 0 && l.weight <= 10)) bad.push(`${f} ${e}: weight ${l.weight}`);
                    if (l.minPly !== undefined && !(Number.isInteger(l.minPly) && l.minPly >= 0)) bad.push(`${f} ${e}: minPly ${l.minPly}`);
                    if (l.tags !== undefined && !(Array.isArray(l.tags) && l.tags.every((t) => typeof t === 'string' && t))) bad.push(`${f} ${e}: tags ${l.tags}`);
                }
            }
        }
        assert.deepEqual(bad, []);
    });

    test('slots: only {piece} {square} {captured} {opponent}; balanced braces; slots fit their events', () => {
        const bad = [];
        for (const f of KINGS) {
            for (const [e, lines] of Object.entries(banks[f])) {
                for (const l of lines) {
                    const t = lineText(l);
                    const slots = [...t.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
                    for (const s of slots) if (!SLOTS.has(s)) bad.push(`${f} ${e}: unknown slot {${s}} in "${t}"`);
                    if ((t.match(/\{/g) || []).length !== (t.match(/\}/g) || []).length) bad.push(`${f} ${e}: unbalanced braces "${t}"`);
                    if (slots.includes('captured') && !['myCapture', 'lostPiece', 'lostQueen', 'capturedQueen', 'enPassant', 'blunderByOpponent', 'blunderByMe', 'brilliantMove'].includes(e)) {
                        bad.push(`${f} ${e}: {captured} used in an event without a capture "${t}"`);
                    }
                }
            }
        }
        assert.deepEqual(bad, []);
    });

    test(`short (<= ${MAX_LEN} chars after filling slots), no duplicates, house style (no dashes, PG)`, () => {
        const bad = [];
        const seen = new Map();
        const fill = (t) => t.replace(/\{piece\}/g, 'knight').replace(/\{square\}/g, 'f3').replace(/\{captured\}/g, 'bishop').replace(/\{opponent\}/g, 'the Skeleton King');
        for (const f of KINGS) {
            for (const [e, lines] of Object.entries(banks[f])) {
                for (const l of lines) {
                    const t = lineText(l);
                    if (!t.trim()) bad.push(`${f} ${e}: empty`);
                    if (fill(t).length > MAX_LEN) bad.push(`${f} ${e}: ${fill(t).length} chars "${t}"`);
                    if (DASHES.test(t)) bad.push(`${f} ${e}: dash "${t}"`);
                    if (BAD_WORDS.test(t)) bad.push(`${f} ${e}: wording "${t}"`);
                    if (t !== t.trim() || /\s{2,}/.test(t)) bad.push(`${f} ${e}: whitespace "${t}"`);
                    const key = t.toLowerCase().replace(/[^a-z0-9{} ]/g, '');
                    if (seen.has(key)) bad.push(`duplicate "${t}" (${seen.get(key)} and ${f} ${e})`);
                    seen.set(key, `${f} ${e}`);
                }
            }
        }
        assert.deepEqual(bad, []);
    });

    test('the two kings have distinct voices (no shared lines)', () => {
        const a = new Set(Object.values(banks[KINGS[0]]).flat().map((l) => lineText(l).toLowerCase()));
        const shared = Object.values(banks[KINGS[1]]).flat().map((l) => lineText(l).toLowerCase()).filter((t) => a.has(t));
        assert.deepEqual(shared, []);
    });
});

describe('battle3d lines validator (b3d-lines)', { skip: !fs.existsSync(path.join(DIR, 'validate.mjs')) && 'validate.mjs not present' }, () => {
    test('battle3d/lines/validate.mjs passes on the shipped files', () => {
        const { spawnSync } = require('node:child_process');
        const r = spawnSync(process.execPath, [path.join(DIR, 'validate.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    });
});

describe('battle3d coach templates', { skip: !fs.existsSync(path.join(DIR, 'coach.json')) && 'coach.json not written yet' }, () => {
    test('templates cover every motif and every classification; house style; valid slots', () => {
        const coach = JSON.parse(fs.readFileSync(path.join(DIR, 'coach.json'), 'utf8'));
        const text = JSON.stringify(coach);
        for (const m of MOTIFS) assert.ok(text.includes(`"${m}"`), `motif ${m} has templates`);
        for (const c of CLASSES) assert.ok(text.includes(`"${c}"`), `classification ${c} has templates`);
        const strings = [];
        const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
        walk(coach);
        const bad = strings.filter((s) => s.length > 3 && (DASHES.test(s) || BAD_WORDS.test(s)));
        assert.deepEqual(bad, [], 'house style');
        const slots = new Set(strings.flatMap((s) => [...s.matchAll(/\{([^}]*)\}/g)].map((m) => m[1])));
        assert.ok(slots.size > 0, 'templates use slots');
        for (const s of slots) assert.match(s, /^[a-zA-Z]+$/, `slot name {${s}}`);
    });
});
