// Minimal UCI client for a local Stockfish binary (offline measurement only, never shipped).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function stockfishPath() {
    if (process.env.STOCKFISH && existsSync(process.env.STOCKFISH)) return process.env.STOCKFISH;
    const vendored = path.join(HERE, '..', '.vendor', 'stockfish', 'stockfish-macos-universal');
    if (existsSync(vendored)) return vendored;
    try { return execFileSync('which', ['stockfish']).toString().trim(); } catch { /* fall through */ }
    throw new Error('Stockfish not found: set STOCKFISH=/path/to/stockfish or run tools/calibration/setup.sh');
}

// Same mapping as Stockfish's Skill struct (src/search.h): UCI_Elo -> skill level; the weak move
// is picked at depth 1 + int(level), so searching to exactly that depth gives the calibrated
// behaviour without depending on wall time.
export function skillLevel(elo) {
    const e = (elo - 1320) / (3190 - 1320);
    return Math.min(19, Math.max(0, ((37.2473 * e - 40.8525) * e + 22.2943) * e - 0.311438));
}

// Maia (human-move predictor, lc0 network) for the human anchor: the Lichess bots maia1/5/9 play
// maia-1100/1500/1900 at 1 node and have public Lichess ratings from games against humans.
export function maiaArgs(level) {
    const dir = process.env.MAIA_DIR || path.join(HERE, '..', '.vendor', 'lc0');
    const bin = process.env.LC0 || path.join(dir, 'lc0');
    const weights = path.join(dir, `maia-${level}.pb.gz`);
    if (!existsSync(bin) || !existsSync(weights)) throw new Error(`lc0/Maia not found (${bin}, ${weights}): set LC0 and MAIA_DIR`);
    return [bin, [`--weights=${weights}`, '--backend=eigen', '--threads=1']];
}

// Generic UCI engine process (Stockfish by default, or lc0 with Maia weights).
export class Stockfish {
    constructor(bin = stockfishPath(), args = []) {
        this.proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] });
        this.buf = '';
        this.waiters = [];
        this.lines = [];
        this.proc.stdout.on('data', (d) => {
            this.buf += d.toString();
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i).trim();
                this.buf = this.buf.slice(i + 1);
                this.onLine(line);
            }
        });
    }

    onLine(line) {
        this.lines.push(line);
        const w = this.waiters[0];
        if (w && w.test(line)) {
            this.waiters.shift();
            const lines = this.lines; this.lines = [];
            w.resolve(lines);
        }
    }

    send(cmd) { this.proc.stdin.write(cmd + '\n'); }

    until(test, cmd) {
        return new Promise((resolve) => {
            this.waiters.push({ test, resolve });
            if (cmd) this.send(cmd);
        });
    }

    async init(options = {}) {
        await this.until((l) => l === 'uciok', 'uci');
        for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
        await this.until((l) => l === 'readyok', 'isready');
        return this;
    }

    async newGame() {
        this.send('ucinewgame');
        await this.until((l) => l === 'readyok', 'isready');
    }

    // Returns { move, scoreCp } (score from the side to move, mate mapped to +/-100000).
    async go(fen, moves, goArgs) {
        this.lines = [];
        this.send(`position fen ${fen}${moves.length ? ' moves ' + moves.join(' ') : ''}`);
        const lines = await this.until((l) => l.startsWith('bestmove'), `go ${goArgs}`);
        let scoreCp = null;
        for (const l of lines) {
            if (!l.startsWith('info ')) continue;
            const mp = l.match(/ multipv (\d+)/);
            if (mp && mp[1] !== '1') continue;
            const m = l.match(/ score (cp|mate) (-?\d+)/);
            if (!m) continue;
            scoreCp = m[1] === 'cp' ? +m[2] : (+m[2] > 0 ? 100000 - +m[2] : -100000 - +m[2]);
        }
        const move = lines[lines.length - 1].split(' ')[1];
        return { move: move === '(none)' ? null : move, scoreCp };
    }

    quit() {
        try { this.send('quit'); } catch { /* already gone */ }
        setTimeout(() => { try { this.proc.kill(); } catch { /* ignore */ } }, 500).unref();
    }
}
