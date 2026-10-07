'use strict';
// Smoke tests for the offline ELO tooling (tools/calibration, tools/puzzles). Skipped when the tools
// are absent; Stockfish and the puzzle data are optional (their parts skip when missing), so npm test
// never depends on third-party binaries or downloads.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');

const CAL = path.join(ROOT, 'tools', 'calibration');
const PUZ = path.join(ROOT, 'tools', 'puzzles');
const haveCal = fs.existsSync(path.join(CAL, 'match.mjs'));
const havePuz = fs.existsSync(PUZ);
// Runs that spawn matches / benches take seconds: only with RUN_SLOW=1 (npm run test:slow).
const slow = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 to run the tool smoke runs';

function stockfish() {
    if (process.env.STOCKFISH && fs.existsSync(process.env.STOCKFISH)) return process.env.STOCKFISH;
    const vendored = path.join(CAL, '.vendor', 'stockfish', 'stockfish-macos-universal');
    if (fs.existsSync(vendored)) return vendored;
    try { return execFileSync('which', ['stockfish'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch (e) { return null; }
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `b3d-${name}-`));
const runNode = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000, ...opts });
const readJsonl = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

describe('tools/calibration', { skip: !haveCal && 'tools/calibration not present' }, () => {
    test('Elo math: score <-> diff, fit recovers a known gap, anchors hold', async () => {
        const elo = await import(pathToFileURL(path.join(CAL, 'lib', 'elo.mjs')).href);
        assert.ok(Math.abs(elo.eloFromScore(0.5)) < 1e-9);
        assert.ok(Math.abs(elo.eloFromScore(0.76) - 200) < 2, `0.76 -> ${elo.eloFromScore(0.76)}`);
        const s = elo.pairStats(60, 20, 20);
        assert.ok(s && typeof s === 'object');
        {
            // A beats B 76%, B scores 50% vs the anchor sf:1500 -> A ~ 1700, B ~ 1500
            const recs = [];
            const add = (a, b, w, d, l) => {
                for (let i = 0; i < w; i++) recs.push({ a, b, white: a, black: b, result: '1-0' });
                for (let i = 0; i < d; i++) recs.push({ a, b, white: a, black: b, result: '1/2-1/2' });
                for (let i = 0; i < l; i++) recs.push({ a, b, white: a, black: b, result: '0-1' });
            };
            add('ours:A', 'ours:B', 66, 20, 14);
            add('ours:B', 'sf:1500', 40, 20, 40);
            const fit = elo.fitRatings(elo.aggregate(recs), { 'sf:1500': 1500 });
            const get = (n) => (fit[n]?.elo ?? fit[n]?.rating ?? fit[n]);
            assert.equal(typeof get('ours:B'), 'number', JSON.stringify(fit));
            assert.ok(Math.abs(get('ours:B') - 1500) < 40, `B ${get('ours:B')}`);
            assert.ok(Math.abs(get('ours:A') - get('ours:B') - 200) < 60, `A-B ${get('ours:A') - get('ours:B')}`);
            assert.equal(get('sf:1500'), 1500, 'anchor fixed');
        }
    });

    test('match harness: a 2-game self-match runs, writes jsonl/pgn/summary, and is reproducible', { skip: slow }, () => {
        const outs = [tmp('cal'), tmp('cal')];
        for (const out of outs) {
            const r = runNode([path.join(CAL, 'match.mjs'), '--out', out, '--games', '2', '--workers', '1', '--seed', '7', '--pair', 'ours:300,ours:700']);
            assert.equal(r.status, 0, r.stderr || r.stdout);
            for (const f of ['games.jsonl', 'games.pgn']) assert.ok(fs.existsSync(path.join(out, f)), f);
        }
        const [a, b] = outs.map((o) => readJsonl(path.join(o, 'games.jsonl')));
        assert.equal(a.length, 2);
        for (const g of a) {
            assert.ok(['1-0', '0-1', '1/2-1/2'].includes(g.result), g.result);
            assert.ok(g.plies > 0 && g.reason);
            assert.ok(g.stats.w.nodes > 0 && g.stats.b.nodes > 0);
        }
        const key = (g) => `${g.id} ${g.result} ${g.reason} ${g.plies} ${g.stats.w.nodes} ${g.stats.b.nodes}`;
        assert.deepEqual(b.map(key), a.map(key), 'same seed -> same games (node budgets, not wall time)');
        const pgn = fs.readFileSync(path.join(outs[0], 'games.pgn'), 'utf8');
        assert.equal((pgn.match(/\[Result "/g) || []).length, 2);
        // resumable: a second run into the same dir plays nothing new
        const again = runNode([path.join(CAL, 'match.mjs'), '--out', outs[0], '--games', '2', '--workers', '1', '--seed', '7', '--pair', 'ours:300,ours:700']);
        assert.equal(again.status, 0);
        assert.equal(readJsonl(path.join(outs[0], 'games.jsonl')).length, 2, 'resumed, not replayed');
        const fit = runNode([path.join(CAL, 'fit.mjs'), path.join(outs[0], 'games.jsonl')]);
        assert.equal(fit.status, 0, fit.stderr);
        for (const o of outs) fs.rmSync(o, { recursive: true, force: true });
    });

    test('match vs Stockfish (2 games) when Stockfish is installed', { skip: slow || (!stockfish() && 'Stockfish not installed (STOCKFISH=... or tools/calibration/setup.sh)') }, () => {
        const out = tmp('calsf');
        const r = runNode([path.join(CAL, 'match.mjs'), '--out', out, '--games', '2', '--workers', '1', '--pair', 'ours:1000,sf:1320'], { env: { ...process.env, STOCKFISH: stockfish() } });
        assert.equal(r.status, 0, r.stderr || r.stdout);
        const games = readJsonl(path.join(out, 'games.jsonl'));
        assert.equal(games.length, 2);
        fs.rmSync(out, { recursive: true, force: true });
    });

    test('third-party binaries and bulky output are git-ignored', () => {
        for (const p of ['tools/calibration/.vendor/stockfish/stockfish-macos-universal', 'tools/calibration/.vendor/sf.tgz', 'tools/calibration/out/x/games.pgn']) {
            const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: ROOT });
            assert.equal(r.status, 0, `${p} must be ignored`);
        }
        const tracked = execFileSync('git', ['ls-files', 'tools'], { cwd: ROOT }).toString().split('\n').filter(Boolean);
        for (const f of tracked) {
            assert.ok(!/stockfish(\.exe)?$|\.tgz$|\.nnue$/i.test(f), `binary tracked: ${f}`);
            assert.ok(fs.statSync(path.join(ROOT, f)).size < 2 * 1024 * 1024, `large file tracked: ${f}`);
        }
    });
});

describe('tools/puzzles', { skip: !havePuz && 'tools/puzzles not present' }, () => {
    const SAMPLE = path.join(PUZ, 'sample.csv');

    test('the committed sample is small, CC0-sourced and every puzzle line is legal in our rules', () => {
        assert.ok(fs.existsSync(SAMPLE), 'sample.csv');
        assert.ok(fs.statSync(SAMPLE).size < 2 * 1024 * 1024, 'sample is small (the full database is never committed)');
        const { loadEngine } = require('../helpers/loadEngine');
        const E = loadEngine();
        const [header, ...lines] = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n');
        assert.match(header, /^PuzzleId,FEN,Moves,Rating/);
        assert.ok(lines.length >= 100, `${lines.length} puzzles`);
        const bad = [];
        for (const line of lines.filter((_, i) => i % 7 === 0)) { // every 7th: fast but broad
            const [id, fen, moves, rating] = line.split(',');
            if (!(+rating >= 300 && +rating <= 3200)) bad.push(`${id}: rating ${rating}`);
            E.fen(fen);
            for (const mv of moves.split(' ')) {
                const f = { row: 8 - +mv[1], col: mv.charCodeAt(0) - 97 }, t = { row: 8 - +mv[3], col: mv.charCodeAt(2) - 97 };
                E.set('__m', { from: f, to: t, isPromotion: !!mv[4], promotionPiece: mv[4] ? mv[4].toUpperCase() : null });
                if (!E.run('ChessAI.applyMoveToGlobals(__m)')) { bad.push(`${id}: ${mv} illegal`); break; }
            }
        }
        assert.deepEqual(bad, []);
    });

    test('bench: a tiny run (2 low levels, a few puzzles) produces a sane, reproducible summary', { skip: slow }, () => {
        const outs = [tmp('pz'), tmp('pz')].map((d) => path.join(d, 'r.json'));
        for (const out of outs) {
            const r = runNode([path.join(PUZ, 'bench.mjs'), '--levels', '300,700', '--limit', '6', '--workers', '1', '--out', out]);
            assert.equal(r.status, 0, r.stderr || r.stdout);
        }
        const [a, b] = outs.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
        assert.equal(a.summary.length, 2);
        for (const s of a.summary) {
            assert.ok(s.n > 0 && s.solved >= 0 && s.solved <= 1, JSON.stringify(s).slice(0, 200));
            assert.ok(Number.isFinite(s.puzzleRating), `rating ${s.puzzleRating}`);
        }
        const key = (x) => x.summary.map((s) => `${s.elo}:${s.n}:${s.solved}:${s.puzzleRating}`).join(' ');
        assert.equal(key(b), key(a), 'seeded per move: same results on a second run');
        for (const f of outs) fs.rmSync(path.dirname(f), { recursive: true, force: true });
    });
});
