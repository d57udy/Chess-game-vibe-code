// Validates the king line banks and coach templates. Run: node battle3d/lines/validate.mjs
// Exits 1 on any error. Prints counts per king and per event.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));

const EVENTS = ['gameStart', 'myCapture', 'lostPiece', 'lostQueen', 'capturedQueen', 'check', 'gotChecked',
  'mateThreat', 'promotion', 'castle', 'enPassant', 'blunderByOpponent', 'blunderByMe', 'brilliantMove',
  'longThink', 'repetition', 'endgame', 'winningBig', 'losingBig', 'stalemate', 'checkmateWin', 'checkmateLoss',
  'draw', 'hintUsed', 'undoUsed', 'idle'];
const KING_SLOTS = ['piece', 'square', 'captured', 'opponent'];
const KING_TAGS = ['retort', 'vsAI', 'vsHuman', 'aiKing', 'myPlayer'];
const KING_MAX = 90;

const COACH_SECTIONS = {
  classification: ['inaccuracy', 'mistake', 'blunder', 'good', 'best', 'brilliant'],
  motif: ['fork', 'pin', 'skewer', 'hanging', 'backRank', 'missedCapture', 'allowsMate', 'missedMate',
    'trappedPiece', 'discovered'],
  nudge: ['threat', 'hangingPiece', 'castleSoon', 'developPieces', 'controlCentre', 'kingSafety',
    'endgameKingActive'],
  review: ['wellPlayed', 'closeGame', 'toughLoss', 'keyMoment'],
};
const COACH_SLOTS = ['piece', 'square', 'attacker', 'target', 'bestMove', 'loss'];
const COACH_TAGS = ['praise'];
const COACH_MAX = 100;

// Longest realistic fill per slot, for the expanded length check.
const SAMPLE = { piece: 'knight', captured: 'bishop', attacker: 'knight', target: 'bishop', square: 'e4',
  opponent: 'Lord Rattles', bestMove: 'bishop takes f7', loss: 'a whole rook' };
const EXPANDED_MAX = 100;

const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const seen = new Map();

function checkText(where, entry, slots, tags, max) {
  if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return err(where, 'missing text');
  const t = entry.text;
  if (t.length > max) err(where, `too long (${t.length} > ${max}): ${t}`);
  if (/[–—]/.test(t) || / - /.test(t)) err(where, `dash used as connector: ${t}`);
  if (/[‘’“”]/.test(t)) err(where, `curly quote, use straight quotes: ${t}`);
  if (t !== t.trim() || /\s{2,}/.test(t)) err(where, `stray whitespace: ${t}`);
  for (const m of t.matchAll(/\{([^}]*)\}/g)) {
    if (!slots.includes(m[1])) err(where, `unknown slot {${m[1]}}: ${t}`);
  }
  if (/[{}]/.test(t.replace(/\{[A-Za-z]+\}/g, ''))) err(where, `unbalanced brace: ${t}`);
  const expanded = t.replace(/\{([A-Za-z]+)\}/g, (_, k) => SAMPLE[k] ?? '');
  if (expanded.length > EXPANDED_MAX) err(where, `too long once filled (${expanded.length}): ${t}`);
  const key = t.toLowerCase().replace(/[^a-z{}]/g, '');
  if (seen.has(key)) err(where, `duplicate of ${seen.get(key)}: ${t}`);
  else seen.set(key, where);
  for (const k of Object.keys(entry)) {
    if (!['text', 'weight', 'minPly', 'tags'].includes(k)) err(where, `unknown field ${k}`);
  }
  if (entry.weight !== undefined && !(typeof entry.weight === 'number' && entry.weight > 0)) err(where, 'bad weight');
  if (entry.minPly !== undefined && !(Number.isInteger(entry.minPly) && entry.minPly >= 0)) err(where, 'bad minPly');
  if (entry.tags !== undefined) {
    if (!Array.isArray(entry.tags)) err(where, 'tags must be an array');
    else for (const tag of entry.tags) if (!tags.includes(tag)) err(where, `unknown tag ${tag}`);
  }
}

function load(name) {
  try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); }
  catch (e) { err(name, `cannot parse: ${e.message}`); return null; }
}

const counts = {};
for (const [file, speaker] of [['hero-king.json', 'hero'], ['skeleton-king.json', 'skeleton']]) {
  const bank = load(file);
  if (!bank) continue;
  if (bank.speaker !== speaker) err(file, `speaker should be "${speaker}"`);
  if (typeof bank.opponentFallback !== 'string' || !bank.opponentFallback) err(file, 'missing opponentFallback');
  const events = bank.events || {};
  for (const k of Object.keys(events)) if (!EVENTS.includes(k)) err(file, `unknown event ${k}`);
  counts[speaker] = { total: 0, retort: 0, perEvent: {} };
  for (const ev of EVENTS) {
    const list = events[ev];
    if (!Array.isArray(list) || !list.length) { err(file, `event ${ev} missing or empty`); continue; }
    // Every event needs at least one line usable in any mode, so commentary always has a fallback.
    if (!list.some((l) => !l.tags || !l.tags.length)) err(`${file} ${ev}`, 'no untagged line');
    list.forEach((l, i) => checkText(`${file} ${ev}[${i}]`, l, KING_SLOTS, KING_TAGS, KING_MAX));
    counts[speaker].perEvent[ev] = list.length;
    counts[speaker].total += list.length;
    counts[speaker].retort += list.filter((l) => l.tags?.includes('retort')).length;
  }
}

const coach = load('coach.json');
const coachCounts = {};
if (coach) {
  for (const voice of ['hero', 'skeleton']) {
    const v = coach.voices?.[voice];
    if (!v) { err('coach.json', `voice ${voice} missing`); continue; }
    coachCounts[voice] = 0;
    for (const [section, keys] of Object.entries(COACH_SECTIONS)) {
      const sec = v[section] || {};
      for (const k of Object.keys(sec)) if (!keys.includes(k)) err(`coach.json ${voice}.${section}`, `unknown key ${k}`);
      for (const k of keys) {
        const list = sec[k];
        const where = `coach.json ${voice}.${section}.${k}`;
        if (!Array.isArray(list) || !list.length) { err(where, 'missing or empty'); continue; }
        if (section === 'motif' && !list.some((l) => !l.tags?.includes('praise'))) err(where, 'needs a warning line');
        list.forEach((l, i) => checkText(`${where}[${i}]`, l, COACH_SLOTS, COACH_TAGS, COACH_MAX));
        coachCounts[voice] += list.length;
      }
    }
  }
}

for (const [speaker, c] of Object.entries(counts)) {
  console.log(`${speaker}: ${c.total} lines (${c.retort} retorts)`);
  console.log('  ' + EVENTS.map((e) => `${e} ${c.perEvent[e] ?? 0}`).join(', '));
}
const kingTotal = Object.values(counts).reduce((a, c) => a + c.total, 0);
const coachTotal = Object.values(coachCounts).reduce((a, n) => a + n, 0);
console.log(`kings total: ${kingTotal}`);
console.log(`coach: ${Object.entries(coachCounts).map(([v, n]) => `${v} ${n}`).join(', ')}, total ${coachTotal}`);

if (errors.length) {
  console.error(`\n${errors.length} error(s):\n` + errors.map((e) => '  ' + e).join('\n'));
  process.exit(1);
}
console.log('OK');
