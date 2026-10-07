// Reference runs: external UCI engines through the same puzzles, scored exactly like bench.mjs.
// Offline measurement tools only; pass local binaries, never commit them.
//
//   node tools/puzzles/bench-uci.mjs [--sf-elos 1320,1600,2000,2400] [--sf /path/to/stockfish]
//        [--maia /dir/maia-1100.pb.gz,/dir/maia-1900.pb.gz --lc0 /path/to/lc0]
//        [--workers N] [--limit N] [--out results.json]
//
// Stockfish with UCI_LimitStrength ties the puzzle scale to Stockfish's UCI_Elo (anchored by the
// Stockfish authors to CCRL ratings). It picks its weak move at depth 1 + int(skill level), so each
// move searches to exactly that depth (as the calibration harness does) and does not depend on wall
// time. Its weak-move noise is seeded from the clock inside Stockfish, so solves vary a little run to
// run; the bootstrap interval covers puzzle sampling only.
//
// Maia (McIlroy-Young et al. 2020, github.com/CSSLab/maia-chess) under lc0 at nodes=1 plays the most
// likely human move of its training band; the maia1/maia5/maia9 Lichess bots run these weights and
// have public Lichess ratings, which ties the puzzle scale to the human rating pool. Deterministic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { loadEngine } = require('../../tests/helpers/loadEngine.js');
const { stockfishPath, skillLevel } = await import('../calibration/lib/stockfish.mjs');

function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

class Uci {
    constructor(bin, argv) {
        this.p = spawn(bin, argv, { stdio: ['pipe', 'pipe', 'ignore'] });
        this.buf = ''; this.waiters = [];
        this.p.stdout.on('data', (d) => {
            this.buf += d;
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
                const w = this.waiters[0];
                if (w && line.startsWith(w.prefix)) { this.waiters.shift(); w.resolve(line); }
            }
        });
    }
    send(cmd) { this.p.stdin.write(cmd + '\n'); }
    wait(prefix) { return new Promise((resolve) => this.waiters.push({ prefix, resolve })); }
    async init(opts) {
        this.send('uci'); await this.wait('uciok');
        for (const [k, v] of Object.entries(opts)) this.send(`setoption name ${k} value ${v}`);
        this.send('isready'); await this.wait('readyok');
    }
    async best(fen, moves, go) {
        this.send('ucinewgame');
        this.send(`position fen ${fen}${moves.length ? ' moves ' + moves.join(' ') : ''}`);
        this.send(go);
        return (await this.wait('bestmove')).split(/\s+/)[1];
    }
    quit() { this.send('quit'); }
}

async function main() {
    const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
        .map((a) => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
    const players = [];
    if (args['sf-elos']) {
        const sf = args.sf || stockfishPath();
        for (const elo of String(args['sf-elos']).split(',').map(Number)) {
            const depth = 1 + Math.floor(skillLevel(elo));
            players.push({ label: `stockfish UCI_Elo ${elo}`, uciElo: elo, depth, bin: sf, argv: [],
                options: { Threads: 1, Hash: 16, UCI_LimitStrength: true, UCI_Elo: elo }, go: `go depth ${depth}` });
        }
    }
    if (args.maia) {
        if (!args.lc0) throw new Error('--maia needs --lc0 /path/to/lc0');
        for (const w of String(args.maia).split(',')) {
            players.push({ label: path.basename(w).replace(/\.pb\.gz$/, ''), bin: args.lc0, argv: ['--backend=eigen'],
                options: { WeightsFile: w, Threads: 1 }, go: 'go nodes 1' });
        }
    }
    if (!players.length) throw new Error('nothing to run: pass --sf-elos and/or --maia');
    const nWorkers = +(args.workers || Math.max(1, (os.availableParallelism?.() || os.cpus().length) - 2));
    const [, ...lines] = fs.readFileSync(path.join(HERE, 'sample.csv'), 'utf8').trim().split('\n');
    let puzzles = lines.map((l) => { const f = l.split(','); return { id: f[0], fen: f[1], moves: f[2].split(' '), rating: +f[3] }; });
    if (args.limit) puzzles = puzzles.filter((p) => hash('limit' + p.id) % Math.ceil(puzzles.length / +args.limit) === 0);

    // Mate check for alternative moves (Lichess accepts any mating move), using the game's rules.
    const { run, set, fen: loadFen } = loadEngine();
    const isMateAfter = (fen, moves) => {
        loadFen(fen);
        for (const u of moves) {
            set('__m', { from: { row: 8 - +u[1], col: u.charCodeAt(0) - 97 }, to: { row: 8 - +u[3], col: u.charCodeAt(2) - 97 },
                isPromotion: u.length > 4, promotionPiece: u.length > 4 ? u[4].toUpperCase() : null });
            if (!run('ChessAI.applyMoveToGlobals(__m)')) return false;
        }
        return run('ChessAI.loadFromGlobals() && ChessAI.legalMoves().length === 0 && isKingInCheck(currentPlayer)');
    };

    const tasks = [];
    players.forEach((pl, k) => puzzles.forEach((p) => tasks.push({ p, k })));
    tasks.sort((a, b) => hash(a.p.id + a.k) - hash(b.p.id + b.k));
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: nWorkers }, async () => {
        const engines = new Map();
        for (;;) {
            const t = tasks[next++];
            if (!t) break;
            const pl = players[t.k];
            if (!engines.has(t.k)) {
                const e = new Uci(pl.bin, pl.argv);
                await e.init(pl.options);
                engines.set(t.k, e);
            }
            const e = engines.get(t.k), line = t.p.moves;
            let solved = 1;
            for (let i = 1; i < line.length; i += 2) {
                const u = await e.best(t.p.fen, line.slice(0, i), pl.go);
                if (u === line[i]) continue;
                solved = isMateAfter(t.p.fen, [...line.slice(0, i), u]) ? 1 : 0;
                break;
            }
            results.push({ k: t.k, rating: t.p.rating, solved });
            if (process.stderr.isTTY) process.stderr.write(`\r${results.length}/${tasks.length}`);
        }
        for (const e of engines.values()) e.quit();
    }));

    const { fitR, fitFree, bootstrap } = await import('./fit.mjs');
    const summary = players.map((pl, k) => {
        const data = results.filter((r) => r.k === k).map((r) => [r.rating, r.solved]);
        const [lo, hi] = bootstrap(data, 400, 400, hash('boot' + pl.label));
        const free = fitFree(data);
        return { player: pl.label, uciElo: pl.uciElo, depth: pl.depth, n: data.length,
            solved: +(data.reduce((s, d) => s + d[1], 0) / data.length).toFixed(3),
            puzzleRating: Math.round(fitR(data, 400)), ci90: [Math.round(lo), Math.round(hi)],
            freeFit: { R: Math.round(free.R), scale: Math.round(free.s) } };
    });
    const report = { generated: new Date().toISOString(), sfDepthRule: '1 + int(skillLevel(UCI_Elo))', puzzles: puzzles.length, summary };
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(report, null, 1) + '\n');
    console.log('\n| Player | Solved | Puzzle rating (90% CI) | Free fit R / scale |\n|---|---|---|---|');
    for (const s of summary) console.log(`| ${s.player} | ${(s.solved * 100).toFixed(0)}% | ${s.puzzleRating} (${s.ci90[0]} to ${s.ci90[1]}) | ${s.freeFit.R} / ${s.freeFit.scale} |`);
}

main().catch((e) => { console.error(e); process.exit(1); });
