// Plays one game between two players (ours or Stockfish), with a full-strength Stockfish referee
// used only for adjudication.
import { createRequire } from 'node:module';
import { skillLevel } from './stockfish.mjs';

const require = createRequire(import.meta.url);
const { Chess } = require('../.vendor/node_modules/chess.js');

export const ADJUDICATION = {
    resignCp: 1000,      // referee eval (White POV) beyond this ...
    resignPlies: 10,     // ... for this many consecutive plies -> win for that side
    maxPlies: 400,       // then adjudicate: |eval| >= finalCp wins, otherwise draw
    finalCp: 300,
    refereeNodes: 20000, // fixed node count: cheap and independent of machine load
};

// Player spec: { kind: 'sf', elo } or { kind: 'ours', engine: OurEngine, elo, params? }.
// sfPool(elo) returns a ready Stockfish instance for that limited strength.
export async function playGame({ white, black, openingSan, referee, sfPool, seed, adjudication = ADJUDICATION }) {
    const chess = new Chess();
    const startFen = chess.fen();
    const uciMoves = [];
    for (const san of openingSan.split(' ')) {
        const m = chess.move(san);
        uciMoves.push(m.from + m.to + (m.promotion || ''));
    }
    const history = chess.history({ verbose: true }).map((m) => posKey(m.before));
    history.push(posKey(chess.fen()));

    const stats = { w: newStats(), b: newStats() };
    for (const p of [white, black]) {
        if (p.kind === 'ours') p.engine.seed(seed);
        else await (await sfPool(p.elo)).newGame();
    }
    await referee.newGame();

    let streak = 0, streakSide = 0, lastEval = 0, result = null, reason = null;
    while (!result) {
        if (chess.isGameOver()) {
            if (chess.isCheckmate()) { result = chess.turn() === 'w' ? '0-1' : '1-0'; reason = 'checkmate'; }
            else {
                result = '1/2-1/2';
                reason = chess.isStalemate() ? 'stalemate' : chess.isInsufficientMaterial() ? 'insufficient material'
                    : chess.isThreefoldRepetition() ? 'threefold repetition' : '50-move rule';
            }
            break;
        }
        if (uciMoves.length >= adjudication.maxPlies) {
            result = lastEval >= adjudication.finalCp ? '1-0' : lastEval <= -adjudication.finalCp ? '0-1' : '1/2-1/2';
            reason = 'max plies';
            break;
        }
        const stm = chess.turn();
        const p = stm === 'w' ? white : black;
        let uci;
        if (p.kind === 'ours') {
            const r = p.engine.move(chess.fen(), history, p.params || p.elo);
            uci = r.uci;
            const s = stats[stm];
            s.moves++; s.ms += r.ms || 0; s.nodes += r.nodes || 0; s.depth += r.depth || 0; s.blunders += r.blunder ? 1 : 0; s.timeStops += r.timeStop ? 1 : 0;
        } else {
            const sf = await sfPool(p.elo);
            const goArgs = p.elo === 'full' ? 'nodes 200000'
                : String(p.elo).startsWith('maia') ? 'nodes 1'
                    : `depth ${1 + Math.floor(skillLevel(p.elo))}`;
            uci = (await sf.go(startFen, uciMoves, goArgs)).move;
            stats[stm].moves++;
        }
        if (!uci) throw new Error(`no move from ${p.label} in ${chess.fen()}`);
        let mv;
        try { mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { mv = null; }
        if (!mv) throw new Error(`illegal move ${uci} from ${p.label} in ${chess.fen()}`);
        uciMoves.push(uci);
        history.push(posKey(chess.fen()));

        if (!chess.isGameOver()) {
            const ev = await referee.go(startFen, uciMoves, `nodes ${adjudication.refereeNodes}`);
            if (ev.scoreCp !== null) lastEval = chess.turn() === 'w' ? ev.scoreCp : -ev.scoreCp;
            const side = lastEval >= adjudication.resignCp ? 1 : lastEval <= -adjudication.resignCp ? -1 : 0;
            if (side && side === streakSide) streak++; else { streak = side ? 1 : 0; streakSide = side; }
            if (streak >= adjudication.resignPlies) { result = side > 0 ? '1-0' : '0-1'; reason = 'adjudicated (eval)'; }
        }
    }
    const pgn = toPgn(chess, white.label, black.label, result, reason, seed);
    for (const k of ['w', 'b']) {
        const s = stats[k];
        if (s.moves) { s.ms = Math.round(s.ms / s.moves); s.nodes = Math.round(s.nodes / s.moves); s.depth = +(s.depth / s.moves).toFixed(2); }
    }
    return { result, reason, plies: uciMoves.length, stats, pgn };
}

function newStats() { return { moves: 0, ms: 0, nodes: 0, depth: 0, blunders: 0, timeStops: 0 }; }

// Position key in getBoardPositionString() form: the first four FEN fields.
function posKey(fen) { return fen.split(' ').slice(0, 4).join(' '); }

function toPgn(chess, white, black, result, reason, seed) {
    chess.setHeader('Event', 'Elo calibration');
    chess.setHeader('White', white);
    chess.setHeader('Black', black);
    chess.setHeader('Result', result);
    chess.setHeader('Termination', reason);
    chess.setHeader('Seed', String(seed));
    let pgn = chess.pgn();
    if (!pgn.trim().endsWith(result)) pgn = pgn.replace(/\s*(\*|1-0|0-1|1\/2-1\/2)?\s*$/, ` ${result}`);
    return pgn + '\n';
}
