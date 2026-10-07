#!/usr/bin/env node
// Match harness: our engine (at slider levels) vs Stockfish UCI_Elo and vs itself, in parallel.
//
//   node tools/calibration/match.mjs --out tools/calibration/out/run1 --games 64 --workers 8 \
//        --engine base=HEAD --engine cand=worktree:tools/calibration/tables/cand.json \
//        --pair base:1300,sf:1320 --pair base:1000,base:1300
//   node tools/calibration/match.mjs --plan tools/calibration/plans/x.json
//
// Players: "sf:<UCI_Elo>" (Stockfish, UCI_LimitStrength), "maia:<1100..1900>" (lc0 + Maia, 1 node), "<engine>:<slider elo>" or
// "<engine>:@<preset>" (an explicit parameter set from the plan's "presets"), where <engine> is a
// name from --engine (default "ours" = working tree, its current table).
// --engine name=<ref>[:<table.json>]: ref is "worktree", a git revision, or a directory.
// Output (resumable, re-running skips finished games): games.jsonl, games.pgn, summary.json.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPENINGS } from './lib/openings.mjs';
import { summarize, printSummary } from './lib/report.mjs';

const SELF = fileURLToPath(import.meta.url);

if (isMainThread) await main(); else await worker();

function parseArgs(argv) {
    const o = { pair: [], engine: [], presets: {}, games: 64, workers: Math.max(1, Math.min(8, os.cpus().length - 2)), seed: 1 };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
        if (k === 'pair' || k === 'engine') { o[k].push(v); i++; }
        else if (['games', 'workers', 'seed'].includes(k)) { o[k] = +v; i++; }
        else if (['out', 'plan'].includes(k)) { o[k] = v; i++; }
        else throw new Error('unknown option ' + argv[i]);
    }
    if (o.plan) { // CLI options win over the plan file
        const plan = JSON.parse(fs.readFileSync(o.plan, 'utf8'));
        o.pair.push(...(plan.pairs || []).map((p) => (Array.isArray(p) ? p.join(',') : p)));
        o.presets = plan.presets || {};
        o.engine.unshift(...Object.entries(plan.engines || {}).map(([n, e]) => `${n}=${e}`));
        for (const k of ['games', 'out', 'seed', 'workers']) if (plan[k] !== undefined && !argv.includes('--' + k)) o[k] = plan[k];
    }
    if (!o.out) throw new Error('--out <dir> is required');
    return o;
}

function parseEngines(list) {
    const engines = { ours: { ref: 'worktree', table: null } };
    for (const e of list) {
        const [name, rest] = e.split('=');
        const [ref, table] = rest.split(/:(.+)/);
        engines[name] = { ref, table: table || null };
    }
    return engines;
}

async function main() {
    const opt = parseArgs(process.argv.slice(2));
    const engines = parseEngines(opt.engine);
    fs.mkdirSync(opt.out, { recursive: true });
    const jsonl = path.join(opt.out, 'games.jsonl'), pgnFile = path.join(opt.out, 'games.pgn');
    const done = new Set();
    const records = [];
    if (fs.existsSync(jsonl)) {
        for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            const r = JSON.parse(line); done.add(r.id); records.push(r);
        }
    }
    const games = opt.games + (opt.games % 2); // colour-reversed pairs
    const jobs = [];
    opt.pair.forEach((pair, pi) => {
        const [a, b] = pair.split(',');
        for (let g = 0; g < games; g++) {
            const id = `${a}|${b}|${g}`;
            if (done.has(id)) continue;
            const o = (Math.floor(g / 2) + pi * 5) % OPENINGS.length;
            const swap = g % 2 === 1;
            jobs.push({ id, a, b, white: swap ? b : a, black: swap ? a : b, opening: OPENINGS[o][0], san: OPENINGS[o][1], seed: hashSeed(opt.seed, id) });
        }
    });
    // Interleave pairings so partial results cover every pairing.
    jobs.sort((x, y) => (+x.id.split('|')[2] - +y.id.split('|')[2]) || x.id.localeCompare(y.id));
    const nWorkers = Math.min(opt.workers, jobs.length);
    console.log(`${jobs.length} games to play (${done.size} already done), ${nWorkers} workers -> ${opt.out}`);
    const { readEngineSources } = await import('./lib/ours.mjs');
    for (const e of Object.values(engines)) e.sourceHash = readEngineSources(e.ref).hash;
    fs.writeFileSync(path.join(opt.out, 'config.json'), JSON.stringify({ engines, presets: opt.presets, pairs: opt.pair, games, seed: opt.seed, workers: nWorkers }, null, 2));

    const t0 = Date.now();
    let next = 0, finished = 0;
    await Promise.all(Array.from({ length: nWorkers }, () => new Promise((resolve, reject) => {
        const w = new Worker(SELF, { workerData: { engines, presets: opt.presets } });
        const feed = () => { if (next < jobs.length) w.postMessage(jobs[next++]); else w.postMessage(null); };
        w.on('message', (msg) => {
            if (msg.ready) return feed();
            if (msg.error) { console.error(`game ${msg.id} failed: ${msg.error}`); finished++; return feed(); }
            const { pgn, ...rec } = msg;
            fs.appendFileSync(jsonl, JSON.stringify(rec) + '\n');
            fs.appendFileSync(pgnFile, pgn + '\n');
            records.push(rec);
            finished++;
            if (finished % 10 === 0 || finished === jobs.length) {
                const el = (Date.now() - t0) / 1000;
                console.log(`${finished}/${jobs.length} games, ${el.toFixed(0)} s, eta ${(el / finished * (jobs.length - finished)).toFixed(0)} s`);
            }
            feed();
        });
        w.on('error', reject);
        w.on('exit', resolve);
    })));
    const summary = summarize(records.filter((r) => opt.pair.some((p) => p === `${r.a},${r.b}`)));
    fs.writeFileSync(path.join(opt.out, 'summary.json'), JSON.stringify(summary, null, 2));
    printSummary(summary);
}


function hashSeed(seed, id) {
    let h = 2166136261 ^ seed;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return h >>> 0;
}

async function worker() {
    const { Stockfish, maiaArgs } = await import('./lib/stockfish.mjs');
    const { OurEngine, readEngineSources } = await import('./lib/ours.mjs');
    const { playGame } = await import('./lib/game.mjs');
    const { engines, presets } = workerData;
    const ours = new Map(), sfs = new Map();
    const engineFor = (name) => {
        if (!ours.has(name)) {
            const e = engines[name];
            if (!e) throw new Error('unknown engine ' + name);
            const table = e.table ? JSON.parse(fs.readFileSync(e.table, 'utf8')) : null;
            ours.set(name, new OurEngine(readEngineSources(e.ref), table));
        }
        return ours.get(name);
    };
    const sfPool = async (elo) => {
        if (!sfs.has(elo)) {
            const sf = typeof elo === 'string' && elo.startsWith('maia')
                ? await new Stockfish(...maiaArgs(elo.slice(4))).init()
                : await new Stockfish().init(elo === 'full' ? SF_OPTIONS : { ...SF_OPTIONS, UCI_LimitStrength: true, UCI_Elo: elo });
            sfs.set(elo, sf);
        }
        return sfs.get(elo);
    };
    const SF_OPTIONS = { Threads: 1, Hash: 16 };
    const referee = await new Stockfish().init(SF_OPTIONS);
    const player = (label) => {
        const [kind, v] = label.split(':');
        if (kind === 'sf') return { kind: 'sf', elo: v === 'full' ? 'full' : +v, label };
        if (kind === 'maia') return { kind: 'sf', elo: 'maia' + v, label };
        if (v.startsWith('@')) {
            const params = presets[v.slice(1)];
            if (!params) throw new Error('unknown parameter preset ' + v);
            return { kind: 'ours', engine: engineFor(kind), elo: null, params, label };
        }
        return { kind: 'ours', engine: engineFor(kind), elo: +v, label };
    };
    parentPort.on('message', async (job) => {
        if (!job) {
            referee.quit(); for (const s of sfs.values()) s.quit();
            process.exit(0);
        }
        const white = player(job.white), black = player(job.black);
        const t0 = Date.now();
        let g;
        try { g = await playGame({ white, black, openingSan: job.san, referee, sfPool, seed: job.seed }); } catch (err) {
            parentPort.postMessage({ id: job.id, error: String(err && err.stack || err) });
            return;
        }
        parentPort.postMessage({ ...job, san: undefined, result: g.result, reason: g.reason, plies: g.plies, stats: g.stats, secs: Math.round((Date.now() - t0) / 1000), pgn: g.pgn });
    });
    parentPort.postMessage({ ready: true });
}
