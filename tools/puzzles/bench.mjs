// Puzzle benchmark: estimates the Lichess puzzle rating of each AI strength level.
//
//   node tools/puzzles/bench.mjs [--levels 300,500,...] [--reps 1] [--workers N]
//                                [--table table.json] [--engine old/aiPlayer.js] [--limit N] [--out results.json]
//
// For every level the engine solves every puzzle in sample.csv the Lichess way: the first move of the
// line is the opponent's, then the engine must find each of its moves in turn while the opponent's
// replies are played from the line. One wrong move fails the puzzle; as on Lichess, any move that
// gives checkmate also counts as correct. The level's puzzle rating is the rating R where it solves
// 50%, from a maximum-likelihood fit of P(solve) = 1 / (1 + 10^((puzzleRating - R) / 400)) (the
// Glicko-2 expectation Lichess uses with the rating deviations ignored), with a bootstrap 90% interval.
// A fit with a free slope is reported too, as a check on how human-like the curve is.
//
// The engine runs through ChessAI.eloParams + ChessAI.searchWithParams with a per-move seed and the
// time cap lifted, so results depend only on the node budget and are reproducible on any machine.
// --table loads a candidate ELO table (JSON array of rows, see aiPlayer.js) via ChessAI.setEloTable.
// --engine benchmarks another aiPlayer.js (e.g. `git show 0187e9a:aiPlayer.js > old.js`). An engine
// without searchWithParams is driven through calculateBestMove with Math.random seeded per move; its
// time budget then makes high levels depend on machine speed and load.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { fitR, fitFree, bootstrap } from './fit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function hash(str) { // FNV-1a then a murmur finaliser, 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

function readSample(file) {
    const [, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
    return lines.map((l) => {
        const [id, fen, moves, rating, rd, popularity, plays, themes] = l.split(',');
        return { id, fen, moves: moves.split(' '), rating: +rating, themes: themes.split(' ') };
    });
}

// Loads gameLogic.js and an aiPlayer.js into an isolated vm context, as the browser loads them.
function makeEngine(enginePath) {
    const root = path.join(HERE, '..', '..');
    const ctx = { console: { log() {}, warn() {}, error() {}, info() {}, debug() {} }, performance, setTimeout, clearTimeout };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root, 'gameLogic.js'), 'utf8'), ctx, { filename: 'gameLogic.js' });
    const ai = enginePath ? path.resolve(enginePath) : path.join(root, 'aiPlayer.js');
    vm.runInContext(fs.readFileSync(ai, 'utf8'), ctx, { filename: 'aiPlayer.js' });
    const run = (code) => vm.runInContext(code, ctx);
    const set = (name, value) => { ctx[name] = value; return value; };
    const get = (expr) => { const j = run(`JSON.stringify(${expr})`); return j === undefined ? undefined : JSON.parse(j); };
    const fen = (f) => { set('__fen', f); if (!run('parseFen(__fen)')) throw new Error('parseFen failed: ' + f); };
    // Seedable Math.random inside the context (mulberry32), for engines without params.seed.
    run(`var __rs = 1; Math.random = () => { __rs = (__rs + 0x6D2B79F5) | 0; let t = __rs;
        t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };`);
    return { run, set, get, fen };
}

// --- Worker: solve puzzles ---
function workerMain() {
    const { table, puzzles, engine } = workerData;
    const { run, set, fen: loadFen } = makeEngine(engine);
    if (table) { set('__table', table); if (!run('ChessAI.setEloTable(__table)')) throw new Error('bad ELO table'); }
    const hasParamsApi = run('typeof ChessAI.searchWithParams === "function" && typeof ChessAI.eloParams === "function"');

    // Plays one UCI move on the gameLogic globals; returns false if illegal.
    const play = (u) => {
        const fr = { row: 8 - +u[1], col: u.charCodeAt(0) - 97 }, to = { row: 8 - +u[3], col: u.charCodeAt(2) - 97 };
        set('__m', { from: fr, to, isPromotion: u.length > 4, promotionPiece: u.length > 4 ? u[4].toUpperCase() : null });
        return run('ChessAI.applyMoveToGlobals(__m)');
    };
    const uciOf = (m) => String.fromCharCode(97 + m.from.col) + (8 - m.from.row) + String.fromCharCode(97 + m.to.col) +
        (8 - m.to.row) + (m.isPromotion && m.promotionPiece ? m.promotionPiece.toLowerCase() : '');
    const isMate = () => run('ChessAI.loadFromGlobals() && ChessAI.legalMoves().length === 0 && isKingInCheck(currentPlayer)');
    const STATE = '({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber })';

    function engineMove(elo, seed) {
        if (hasParamsApi) {
            set('__elo', elo); set('__seed', seed);
            return run(`(() => { const p = ChessAI.eloParams(__elo); p.seed = __seed; p.timeCapMs = 600000;
                return ChessAI.searchWithParams(${STATE}, p, []); })()`);
        }
        set('__elo', elo); set('__seed', seed);
        return run('__rs = __seed; calculateBestMove(__elo, undefined, [])');
    }

    // Returns { solved, failPly (index into moves of the first wrong move, or -1), nodes }.
    function solve(p, elo, rep) {
        loadFen(p.fen);
        if (!play(p.moves[0])) throw new Error(`puzzle ${p.id}: illegal setup move`);
        for (let i = 1; i < p.moves.length; i += 2) {
            const m = engineMove(elo, hash(`${p.id}:${elo}:${i}:${rep}`));
            if (!m) return { solved: false, failPly: i, played: null };
            const u = uciOf(m);
            if (u !== p.moves[i]) {
                play(u);
                return isMate() ? { solved: true, failPly: -1, played: u } : { solved: false, failPly: i, played: u };
            }
            play(u);
            if (i + 1 < p.moves.length && !play(p.moves[i + 1])) throw new Error(`puzzle ${p.id}: illegal reply`);
        }
        return { solved: true, failPly: -1, played: null };
    }

    parentPort.on('message', (msg) => {
        if (msg === 'done') { process.exit(0); }
        const { tasks } = msg;
        const out = tasks.map(([pi, elo, rep]) => {
            const r = solve(puzzles[pi], elo, rep);
            return [pi, elo, rep, r.solved ? 1 : 0, r.failPly, r.played];
        });
        parentPort.postMessage(out);
    });
    parentPort.postMessage({ ready: true, hasParamsApi });
}

// --- Main ---
async function main() {
    const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
        .map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
    const levels = String(args.levels || '300,500,700,900,1100,1300,1500,1700,1900,2100,2300,2500').split(',').filter((x) => x.trim()).map(Number);
    const reps = +(args.reps || 1);
    const nWorkers = +(args.workers || Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
    const table = args.table ? JSON.parse(fs.readFileSync(args.table, 'utf8')) : null;
    let puzzles = readSample(path.join(HERE, 'sample.csv'));
    if (args.limit) puzzles = puzzles.filter((p) => hash('limit' + p.id) % Math.ceil(puzzles.length / +args.limit) === 0);

    const tasks = [];
    for (const elo of levels) for (let rep = 0; rep < reps; rep++) puzzles.forEach((_, pi) => tasks.push([pi, elo, rep]));
    // Interleave expensive (high level) and cheap tasks so workers finish together.
    tasks.sort((x, y) => hash(x.join(':')) - hash(y.join(':')));

    const t0 = Date.now();
    const results = [];
    let next = 0, hasParamsApi = null;
    const CHUNK = 20;
    await Promise.all(Array.from({ length: nWorkers }, () => new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url), { workerData: { table, puzzles, engine: args.engine || null } });
        const send = () => {
            if (next >= tasks.length) { w.postMessage('done'); resolve(); return; }
            w.postMessage({ tasks: tasks.slice(next, next + CHUNK) });
            next += CHUNK;
        };
        w.on('message', (msg) => {
            if (msg.ready) { hasParamsApi = msg.hasParamsApi; send(); return; }
            results.push(...msg);
            if (process.stderr.isTTY) process.stderr.write(`\r${results.length}/${tasks.length}`);
            send();
        });
        w.on('error', reject);
    })));
    const secs = (Date.now() - t0) / 1000;

    // Record the parameter set each level used, so results stay interpretable after the table changes.
    const eng = makeEngine(args.engine || null);
    if (table) { eng.set('__table', table); eng.run('ChessAI.setEloTable(__table)'); }
    const paramsOf = (elo) => (hasParamsApi ? eng.get(`ChessAI.eloParams(${elo})`) : null);

    const summary = levels.map((elo) => {
        const rs = results.filter((r) => r[1] === elo);
        const data = rs.map((r) => [puzzles[r[0]].rating, r[3]]);
        const R = fitR(data, 400);
        const [lo, hi] = bootstrap(data, 400, 400, hash('boot' + elo));
        const free = fitFree(data);
        // Solve rate per 200-point puzzle band and on one-move / short puzzles (weakness model check).
        const bands = {};
        for (const r of rs) {
            const p = puzzles[r[0]], b = Math.floor(p.rating / 200) * 200;
            (bands[b] ||= [0, 0])[0] += r[3]; bands[b][1]++;
        }
        const rate = (pred) => { const x = rs.filter((r) => pred(puzzles[r[0]])); return x.length ? +(x.reduce((s, r) => s + r[3], 0) / x.length).toFixed(3) : null; };
        return {
            elo, params: paramsOf(elo), n: rs.length, solved: +(rs.reduce((s, r) => s + r[3], 0) / rs.length).toFixed(3),
            puzzleRating: Math.round(R), ci90: [Math.round(lo), Math.round(hi)],
            freeFit: { R: Math.round(free.R), scale: Math.round(free.s) },
            byBand: Object.fromEntries(Object.entries(bands).map(([b, [s, n]]) => [b, +(s / n).toFixed(3)])),
            oneMove: rate((p) => p.themes.includes('oneMove')),
            mateIn1: rate((p) => p.themes.includes('mateIn1')),
            hangingPiece: rate((p) => p.themes.includes('hangingPiece')),
            shortUnder1200: rate((p) => p.rating < 1200 && (p.themes.includes('short') || p.themes.includes('oneMove'))),
            firstMoveMissRate: +(rs.filter((r) => r[4] === 1).length / rs.length).toFixed(3),
        };
    });

    const report = {
        generated: new Date().toISOString(), engineApi: hasParamsApi ? 'eloParams+searchWithParams' : 'calculateBestMove',
        table: args.table || 'default', engine: args.engine || 'aiPlayer.js', puzzles: puzzles.length, reps, workers: nWorkers, seconds: Math.round(secs), summary,
    };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 1) + '\n');
    if (args.raw) fs.writeFileSync(args.raw, JSON.stringify(results.map((r) => [puzzles[r[0]].id, ...r.slice(1)])) + '\n');

    console.log(`\n${puzzles.length} puzzles x ${levels.length} levels x ${reps} reps, ${nWorkers} workers, ${Math.round(secs)} s, API ${report.engineApi}`);
    console.log('| Slider | Solved | Puzzle rating (90% CI) | Free fit R / scale | 1-move | mate-in-1 | hanging piece |');
    console.log('|---|---|---|---|---|---|---|');
    for (const s of summary) {
        console.log(`| ${s.elo} | ${(s.solved * 100).toFixed(0)}% | ${s.puzzleRating} (${s.ci90[0]} to ${s.ci90[1]}) | ${s.freeFit.R} / ${s.freeFit.scale} | ${s.oneMove} | ${s.mateIn1} | ${s.hangingPiece} |`);
    }
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
