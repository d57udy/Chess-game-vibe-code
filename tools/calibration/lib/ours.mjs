// Loads our engine (gameLogic.js + aiPlayer.js) into an isolated node:vm context, the way the
// browser and tests/helpers/loadEngine.js do, with Math.random replaced by a seeded PRNG so a
// game can be replayed from its seed (fully, once strength is set by a node budget).
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FILES = ['gameLogic.js', 'aiPlayer.js'];

// ref: 'worktree' (default), 'HEAD' or any git revision, or a directory holding the two files.
export function readEngineSources(ref = 'worktree') {
    const out = {};
    for (const f of FILES) {
        if (ref === 'worktree') out[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
        else if (fs.existsSync(ref) && fs.statSync(ref).isDirectory()) out[f] = fs.readFileSync(path.join(ref, f), 'utf8');
        else out[f] = execFileSync('git', ['show', `${ref}:${f}`], { cwd: ROOT, maxBuffer: 1 << 26 }).toString();
    }
    out.hash = crypto.createHash('sha256').update(out['gameLogic.js'] + out['aiPlayer.js']).digest('hex').slice(0, 12);
    return out;
}

export function mulberry32(a) {
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class OurEngine {
    // sources: from readEngineSources; table: optional array/object passed to ChessAI.setEloTable.
    constructor(sources, table) {
        this.rng = mulberry32(1);
        const ctx = { console: { log() {}, warn() {}, error: (...a) => process.stderr.write(a.join(' ') + '\n'), info() {}, debug() {} }, performance, setTimeout, clearTimeout };
        vm.createContext(ctx);
        for (const f of FILES) vm.runInContext(sources[f], ctx, { filename: f });
        ctx.__rng = () => this.rng();
        vm.runInContext('Math.random = function () { return __rng(); };', ctx);
        this.AI = vm.runInContext('ChessAI', ctx);
        if (table) {
            if (typeof this.AI.setEloTable !== 'function') throw new Error('engine has no ChessAI.setEloTable; cannot apply a candidate table');
            this.AI.setEloTable(table);
        }
    }

    seed(s) { this.rng = mulberry32(s | 0); }

    params(elo) { return JSON.parse(JSON.stringify(this.AI.eloParams(elo))); }

    // Parameter set for a player: a slider ELO (through the engine's table) or an explicit set.
    // The time cap is lifted so only the node budget limits the search (load-independent).
    resolveParams(level) {
        if (typeof level === 'object') return { ...level, timeCapMs: NO_TIME_CAP };
        if (!this.AI.searchWithParams) return null; // pre-v5 engine: time-based findBestMove
        return { ...this.params(level), timeCapMs: NO_TIME_CAP };
    }

    // fen: current position; history: position strings (first 4 FEN fields) of the game so far;
    // level: slider ELO or an explicit parameter object. Returns { uci, ms, nodes, depth }.
    move(fen, history, level) {
        const state = stateFromFen(fen);
        const params = this.resolveParams(level);
        const t0 = performance.now();
        const m = params ? this.AI.searchWithParams(state, params, history) : this.AI.findBestMove(state, level, 0, history);
        const ms = performance.now() - t0;
        if (!m) return { uci: null };
        const sqName = (s) => String.fromCharCode(97 + s.col) + (8 - s.row);
        const uci = sqName(m.from) + sqName(m.to) + (m.isPromotion && m.promotionPiece ? m.promotionPiece.toLowerCase() : '');
        const info = this.AI.getLastSearchInfo ? this.AI.getLastSearchInfo() : null;
        return { uci, ms, nodes: info ? info.nodes : null, depth: info ? info.depth : null, blunder: info ? !!info.blunder : false, timeStop: !!(info && info.stoppedBy === 'time') };
    }
}

const NO_TIME_CAP = 600000;

export function stateFromFen(fen) {
    const [placement, stm, castling, epField, half, full] = fen.split(' ');
    const board = placement.split('/').map((row) => {
        const r = [];
        for (const ch of row) {
            if (ch >= '1' && ch <= '8') for (let i = 0; i < +ch; i++) r.push(null);
            else r.push(ch);
        }
        return r;
    });
    return {
        board,
        currentPlayer: stm,
        castlingRights: { w: { K: castling.includes('K'), Q: castling.includes('Q') }, b: { K: castling.includes('k'), Q: castling.includes('q') } },
        enPassantTarget: epField && epField !== '-' ? { row: 8 - +epField[1], col: epField.charCodeAt(0) - 97 } : null,
        halfmoveClock: +half || 0,
        fullmoveNumber: +full || 1,
    };
}
