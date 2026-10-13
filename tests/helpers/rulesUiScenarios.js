// Scenario tables for the rules conformance suites (see rulesUiDriver.js for the two view adapters).
// The same tables run through the 2D and the 3D view; every table entry is also checked against the
// reference alone (tests/integration/rulesUi2d.test.js, "scenario tables"), so a wrong FEN or a
// wrong expectation in here fails by itself instead of hiding or inventing a view bug.
//
// Moves are long algebraic ("e5d6", "a7a8n"). Positions are written with White to move where the
// rule is colour-symmetric; mirrorFen()/mirrorUci() give the same case for Black.
'use strict';
const { square, squareName } = require('./loadEngine');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CASTLE = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

const swapCase = (ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());
const mirrorSquare = (s) => s[0] + (9 - Number(s[1]));
/** The same position with colours swapped (ranks flipped), so Black faces what White faced. */
function mirrorFen(fen) {
    const [placement, turn, castling, ep, half, full] = fen.split(' ');
    const rows = placement.split('/').reverse().map((row) => [...row].map((ch) => (/\d/.test(ch) ? ch : swapCase(ch))).join(''));
    const rights = ['K', 'Q', 'k', 'q'].filter((x) => castling.includes(swapCase(x))).join('') || '-';
    return [rows.join('/'), turn === 'w' ? 'b' : 'w', rights, ep === '-' ? '-' : mirrorSquare(ep), half, full].join(' ');
}
const mirrorUci = (uci) => mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
const mirrorResult = (expect) => (expect && expect.winner ? { ...expect, winner: expect.winner === 'w' ? 'b' : 'w' } : expect);

/** Colour-mirrored copy of a table entry (positions, moves and expectations). */
function mirrorEntry(e) {
    const out = { ...e, name: `${e.name} (Black)`, fen: mirrorFen(e.fen || START), mirrored: true };
    for (const key of ['moves', 'must', 'mustNot']) if (e[key]) out[key] = e[key].map(mirrorUci);
    for (const key of ['move', 'ai', 'human']) if (e[key]) out[key] = mirrorUci(e[key]);
    if (e.after) out.after = mirrorFen(e.after);
    if (e.san) out.san = e.san.replace(/[1-8]/g, (d) => String(9 - Number(d)));
    if (e.expect) out.expect = mirrorResult(e.expect);
    if (e.empties) out.empties = e.empties.map(mirrorSquare);
    if (e.holds) out.holds = Object.fromEntries(Object.entries(e.holds).map(([s, p]) => [mirrorSquare(s), swapCase(p)]));
    // After a mirrored move by Black the move number has advanced
    if (out.after && e.move) { const t = out.after.split(' '); if (t[1] === 'w') { t[5] = String(Number(t[5]) + 1); out.after = t.join(' '); } }
    return out;
}

// --- 1. Offered moves ---------------------------------------------------------------------------
// must / mustNot name the moves the case is about; the views are compared with the reference for
// every piece of the side to move. both: the fast suite also runs the mirrored (Black) case, as
// far as the offers. full: the fast suite clicks all 64 squares for every piece (default: the
// squares the piece could be thought to reach, see suspectSquares). heavy: crowded position, offers
// only in the fast suite. The slow suite mirrors every entry and clicks all 64 squares everywhere.
const CORPUS = [
    // En passant
    { group: 'en passant', name: 'available right after the double push, only against that pawn', fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', must: ['e5f6', 'e5e6'], mustNot: ['e5d6'], both: true, heavy: true },
    { group: 'en passant', name: 'expired: same pawns, no en passant square', fen: 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 4', must: ['e5e6'], mustNot: ['e5f6', 'e5d6'], both: true, heavy: true },
    { group: 'en passant', name: 'expired after one move by each side (played by clicks)', moves: ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'h2h3', 'h7h6'], must: ['e5e6'], mustNot: ['e5d6'], heavy: true },
    { group: 'en passant', name: 'available after the double push (played by clicks)', moves: ['e2e4', 'a7a6', 'e4e5', 'd7d5'], must: ['e5d6', 'e5e6'], heavy: true },
    { group: 'en passant', name: 'available for Black after the double push (played by clicks)', moves: ['a2a3', 'e7e5', 'a3a4', 'e5e4', 'd2d4'], must: ['e4d3', 'e4e3'], heavy: true },
    { group: 'en passant', name: 'bare board, available', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', must: ['e5d6', 'e5e6'], both: true, full: true },
    { group: 'en passant', name: 'bare board, pawns side by side without the right', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1', must: ['e5e6'], mustNot: ['e5d6'], both: true, full: true },
    { group: 'en passant', name: 'would expose the own king along the rank (rook)', fen: '8/8/8/K2pP2r/8/8/8/7k w - d6 0 1', must: ['e5e6'], mustNot: ['e5d6'], both: true },
    { group: 'en passant', name: 'would expose the own king along the rank (king on the other side)', fen: '7k/8/8/r2pP2K/8/8/8/8 w - d6 0 1', must: ['e5e6'], mustNot: ['e5d6'] },
    { group: 'en passant', name: 'pawn pinned on its file', fen: '4r2k/8/8/3pP3/8/8/8/4K3 w - d6 0 1', must: ['e5e6'], mustNot: ['e5d6'], both: true },
    { group: 'en passant', name: 'pawn pinned on the diagonal it captures along', fen: '1b5k/8/8/3pP3/8/6K1/8/8 w - d6 0 1', must: ['e5d6'], mustNot: ['e5e6'] },
    { group: 'en passant', name: 'pawn pinned on the other diagonal', fen: '7b/8/8/3pP3/8/8/8/K6k w - d6 0 1', mustNot: ['e5d6', 'e5e6'] },
    { group: 'en passant', name: 'in check from the pawn that just advanced: the capture is the only move', fen: 'k7/8/7p/5ppP/7K/r7/8/8 w - g6 0 1', must: ['h5g6'], single: true, both: true },
    { group: 'en passant', name: 'in check from another piece: the capture does not help', fen: '2b4k/8/8/3pP3/8/7K/8/8 w - d6 0 1', must: ['e5e6'], mustNot: ['e5d6'] },
    { group: 'en passant', name: 'in check: the capturing pawn lands on the blocking square', fen: '1b5k/8/8/2Pp4/8/6K1/8/8 w - d6 0 1', must: ['c5d6'] },
    { group: 'en passant', name: 'a-file pawn is captured, the h-file pair has no right', fen: '4k3/8/8/pP4Pp/8/8/8/4K3 w - a6 0 1', must: ['b5a6'], mustNot: ['g5h6'], both: true },
    { group: 'en passant', name: 'h-file pawn is captured, the a-file pair has no right', fen: '4k3/8/8/pP4Pp/8/8/8/4K3 w - h6 0 1', must: ['g5h6'], mustNot: ['b5a6'] },
    { group: 'en passant', name: 'capturing pawn on the a-file', fen: '4k3/8/8/Pp4pP/8/8/8/4K3 w - b6 0 1', must: ['a5b6'], mustNot: ['h5g6'] },
    { group: 'en passant', name: 'capturing pawn on the h-file', fen: '4k3/8/8/Pp4pP/8/8/8/4K3 w - g6 0 1', must: ['h5g6'], mustNot: ['a5b6'], both: true },
    { group: 'en passant', name: 'two pawns can capture', fen: '4k3/8/8/2PpP3/8/8/8/4K3 w - d6 0 1', must: ['c5d6', 'e5d6'], both: true },
    { group: 'en passant', name: 'square set but no pawn can capture', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', heavy: true },

    // Castling
    { group: 'castling', name: 'both sides available', fen: CASTLE, must: ['e1g1', 'e1c1'], both: true },
    { group: 'castling', name: 'through check on the f-file', fen: '5r2/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1c1'], mustNot: ['e1g1'], both: true },
    { group: 'castling', name: 'through check on the d-file', fen: '3r4/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1g1'], mustNot: ['e1c1'] },
    { group: 'castling', name: 'out of check', fen: '4r3/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', mustNot: ['e1g1', 'e1c1'], both: true },
    { group: 'castling', name: 'into check on g1', fen: '6r1/1k6/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1c1'], mustNot: ['e1g1'], both: true },
    { group: 'castling', name: 'into check on c1', fen: '2r5/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1g1'], mustNot: ['e1c1'] },
    { group: 'castling', name: 'queen-side rook and b1 attacked: still legal', fen: 'rr6/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1c1', 'e1g1'] },
    { group: 'castling', name: 'king-side rook attacked: still legal', fen: '7r/6k1/8/8/8/8/8/R3K2R w KQ - 0 1', must: ['e1g1', 'e1c1'] },
    { group: 'castling', name: 'own pieces in between', fen: 'r3k2r/8/8/8/8/8/8/RN2K1NR w KQkq - 0 1', mustNot: ['e1g1', 'e1c1'] },
    { group: 'castling', name: 'enemy pieces in between', fen: 'r3k2r/8/8/8/8/8/8/R2nK1nR w KQkq - 0 1', mustNot: ['e1g1', 'e1c1'] },
    { group: 'castling', name: 'no rights in the position', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1', mustNot: ['e1g1', 'e1c1'], both: true },
    { group: 'castling', name: 'only the king-side right', fen: 'r3k2r/8/8/8/8/8/8/R3K2R w Kq - 0 1', must: ['e1g1'], mustNot: ['e1c1'] },
    { group: 'castling', name: 'rights lost: king moved and came back', fen: CASTLE, moves: ['e1e2', 'e8e7', 'e2e1', 'e7e8'], mustNot: ['e1g1', 'e1c1'], both: true },
    { group: 'castling', name: 'rights lost: the other king moved and came back', fen: CASTLE, moves: ['e1e2', 'e8e7', 'e2e1', 'e7e8', 'h1h2'], mustNot: ['e8g8', 'e8c8'] },
    { group: 'castling', name: 'rights lost: king-side rook moved and came back', fen: CASTLE, moves: ['h1h2', 'h8h7', 'h2h1', 'h7h8'], must: ['e1c1'], mustNot: ['e1g1'], both: true },
    { group: 'castling', name: 'rights lost: queen-side rook moved and came back', fen: CASTLE, moves: ['a1a2', 'a8a7', 'a2a1', 'a7a8'], must: ['e1g1'], mustNot: ['e1c1'], both: true },
    { group: 'castling', name: 'rights lost: rook captured at home, another rook stands there now', fen: 'r3k2r/7r/8/8/8/8/1B6/R3K2R w KQkq - 0 1', moves: ['b2h8', 'h7h8', 'a1b1'], must: ['e8c8'], mustNot: ['e8g8'], both: true },

    // Pins
    { group: 'pins', name: 'pinned knight cannot move', fen: '4r2k/8/8/8/8/8/4N3/4K3 w - - 0 1', mustNot: ['e2c3', 'e2g3'] },
    { group: 'pins', name: 'pinned rook moves along the file only', fen: '4r2k/8/8/8/8/8/4R3/4K3 w - - 0 1', must: ['e2e8', 'e2e3'], mustNot: ['e2a2'] },
    { group: 'pins', name: 'pinned bishop moves along the diagonal only', fen: '7k/8/8/8/1b6/8/3B3P/4K3 w - - 0 1', must: ['d2b4', 'd2c3'], mustNot: ['d2e3'] },
    { group: 'pins', name: 'pawn pinned on its file may push, not capture', fen: '4r2k/8/8/8/8/3p4/4P3/4K3 w - - 0 1', must: ['e2e3', 'e2e4'], mustNot: ['e2d3'], both: true },
    { group: 'pins', name: 'pawn pinned on a diagonal may capture the pinner, not push', fen: '7k/8/8/8/8/2b5/3P4/4K3 w - - 0 1', must: ['d2c3'], mustNot: ['d2d3', 'd2d4'] },
    { group: 'pins', name: 'pinned queen moves along the rank only', fen: '7k/8/8/8/8/8/8/r2QK3 w - - 0 1', must: ['d1a1', 'd1b1'], mustNot: ['d1d8', 'd1h5'] },

    // Checks
    { group: 'check', name: 'double check: only the king moves', fen: '4r3/6k1/8/8/8/5n2/3P4/R3K2R w KQ - 0 1', must: ['e1f1', 'e1d1', 'e1f2'], mustNot: ['e1g1', 'e1c1', 'd2d3', 'a1a8'], both: true },
    { group: 'check', name: 'evasions by capture, block and king move', fen: '4r2k/8/8/1B6/8/8/3R4/4K3 w - - 0 1', must: ['b5e8', 'b5e2', 'd2e2', 'e1d1', 'e1f1', 'e1f2'], mustNot: ['d2d8', 'b5a6', 'e1e2'], both: true },
    { group: 'check', name: 'knight check cannot be blocked', fen: '8/6k1/8/8/8/3n4/8/R3K2R w KQ - 0 1', must: ['e1d1', 'e1d2', 'e1e2', 'e1f1'], mustNot: ['e1f2', 'e1g1', 'e1c1', 'a1a3'] },
    { group: 'check', name: 'only move: the king takes the checking queen', fen: 'k7/8/8/8/8/8/6q1/7K w - - 0 1', must: ['h1g2'], single: true, both: true },
    { group: 'check', name: 'only move: a knight blocks', fen: 'r6k/8/8/8/8/8/1P6/KN6 w - - 0 1', must: ['b1a3'], single: true },
    { group: 'check', name: 'only move: the pawn promotes', fen: '8/P7/8/8/8/6p1/5k2/7K w - - 0 1', must: ['a7a8q', 'a7a8n'], single: true, both: true },

    // Promotion
    { group: 'promotion', name: 'by push, every piece', fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', must: ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'], both: true },
    { group: 'promotion', name: 'by capture or push, every piece', fen: '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', must: ['a7b8q', 'a7b8r', 'a7b8b', 'a7b8n', 'a7a8q'], both: true },
    { group: 'promotion', name: 'blocked pawn on the seventh rank', fen: 'n3k3/P7/8/8/8/8/8/4K3 w - - 0 1', mustNot: ['a7a8q', 'a7b8q'] },
    { group: 'promotion', name: 'h-file, capture towards the g-file', fen: '4k1n1/7P/8/8/8/8/8/4K3 w - - 0 1', must: ['h7g8q', 'h7h8n'] },

    // Whole positions (the standard move-generation test positions)
    { group: 'positions', name: 'start position', fen: START, heavy: true },
    { group: 'positions', name: 'Kiwipete (castling, pins, captures)', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', heavy: true, both: true },
    { group: 'positions', name: 'rook endgame with a rank pin', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1' },
    { group: 'positions', name: 'promotions and castling under attack', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', heavy: true, both: true },
    { group: 'positions', name: 'pawn on the seventh with discovered checks', fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', heavy: true },
    { group: 'positions', name: 'quiet middlegame', fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', heavy: true },
];

// --- 2. Executed special moves ------------------------------------------------------------------
// move is played by clicks from fen; after is the full FEN expected then (game convention: the en
// passant square is written after every double push); san the listed notation; empties / holds
// what the screen must show on the squares that matter. Every entry also runs mirrored.
const SPECIAL_MOVES = [
    { group: 'en passant', name: 'en passant removes the pawn beside, not a piece on the target', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', move: 'e5d6', after: '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1', san: 'exd6', empties: ['d5', 'e5'], holds: { d6: 'P' }, both: true },
    { group: 'en passant', name: 'en passant towards the a-file', fen: '4k3/8/8/pP6/8/8/8/4K3 w - a6 0 1', move: 'b5a6', after: '4k3/8/P7/8/8/8/8/4K3 b - - 0 1', san: 'bxa6', empties: ['a5', 'b5'], holds: { a6: 'P' }, both: true },
    { group: 'en passant', name: 'en passant towards the h-file', fen: '4k3/8/8/6Pp/8/8/8/4K3 w - h6 0 1', move: 'g5h6', after: '4k3/8/7P/8/8/8/8/4K3 b - - 0 1', san: 'gxh6', empties: ['h5', 'g5'], holds: { h6: 'P' }, both: true },
    { group: 'en passant', name: 'en passant from the h-file', fen: '4k3/8/8/6pP/8/8/8/4K3 w - g6 0 1', move: 'h5g6', after: '4k3/8/6P1/8/8/8/8/4K3 b - - 0 1', san: 'hxg6', empties: ['g5', 'h5'], holds: { g6: 'P' }, both: true },
    { group: 'en passant', name: 'en passant uncovers a check along the rank', fen: '8/8/8/k2pP2R/8/8/8/4K3 w - d6 0 1', move: 'e5d6', after: '8/8/3P4/k6R/8/8/8/4K3 b - - 0 1', san: 'exd6+', empties: ['d5', 'e5'], holds: { d6: 'P' }, both: true },
    { group: 'en passant', name: 'ordinary pawn capture next to an en passant chance', fen: '4k3/8/3n4/3pP3/8/8/8/4K3 w - - 0 1', move: 'e5d6', after: '4k3/8/3P4/3p4/8/8/8/4K3 b - - 0 1', san: 'exd6', empties: ['e5'], holds: { d6: 'P', d5: 'p' } },
    { group: 'en passant', name: 'double push writes the en passant square', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', move: 'e2e4', after: '4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1', san: 'e4', empties: ['e2', 'e3'], holds: { e4: 'P' }, both: true },

    { group: 'castling', name: 'king-side castling moves the rook to the f-file', fen: CASTLE, move: 'e1g1', after: 'r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1', san: 'O-O', empties: ['e1', 'h1'], holds: { g1: 'K', f1: 'R', a1: 'R' }, both: true },
    { group: 'castling', name: 'queen-side castling moves the rook to the d-file', fen: CASTLE, move: 'e1c1', after: 'r3k2r/8/8/8/8/8/8/2KR3R b kq - 1 1', san: 'O-O-O', empties: ['e1', 'a1', 'b1'], holds: { c1: 'K', d1: 'R', h1: 'R' }, both: true },
    { group: 'castling', name: 'castling with check', fen: '5k2/8/8/8/8/8/8/4K2R w K - 0 1', move: 'e1g1', after: '5k2/8/8/8/8/8/8/5RK1 b - - 1 1', san: 'O-O+', empties: ['e1', 'h1'], holds: { g1: 'K', f1: 'R' }, both: true },
    { group: 'castling', name: 'king move gives up both rights', fen: CASTLE, move: 'e1e2', after: 'r3k2r/8/8/8/8/8/4K3/R6R b kq - 1 1', san: 'Ke2' },
    { group: 'castling', name: 'king-side rook move gives up that right only', fen: CASTLE, move: 'h1h2', after: 'r3k2r/8/8/8/8/8/7R/R3K3 b Qkq - 1 1', san: 'Rh2' },
    { group: 'castling', name: 'queen-side rook move gives up that right only', fen: CASTLE, move: 'a1a2', after: 'r3k2r/8/8/8/8/8/R7/4K2R b Kkq - 1 1', san: 'Ra2' },
    { group: 'castling', name: 'rook captured at home loses the right', fen: 'r3k2r/8/8/8/8/8/1B6/R3K2R w KQkq - 0 1', move: 'b2h8', after: 'r3k2B/8/8/8/8/8/8/R3K2R b KQq - 0 1', san: 'Bxh8', holds: { h8: 'B' }, both: true },
    { group: 'castling', name: 'rook takes rook at home: both sides lose that right', fen: CASTLE, move: 'h1h8', after: 'r3k2R/8/8/8/8/8/8/R3K3 b Qq - 0 1', san: 'Rxh8+', empties: ['h1'], holds: { h8: 'R' }, both: true },

    ...['q', 'r', 'b', 'n'].flatMap((p) => {
        const P = p.toUpperCase(), check = p === 'q' || p === 'r' ? '+' : '';
        return [
            { group: 'promotion', name: `promotion by push to ${P}`, fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', move: `a7a8${p}`, after: `${P}3k3/8/8/8/8/8/8/4K3 b - - 0 1`, san: `a8=${P}${check}`, empties: ['a7'], holds: { a8: P }, both: true },
            { group: 'promotion', name: `promotion by capture to ${P}`, fen: '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', move: `a7b8${p}`, after: `1${P}2k3/8/8/8/8/8/8/4K3 b - - 0 1`, san: `axb8=${P}${check}`, empties: ['a7'], holds: { b8: P }, both: true },
        ];
    }),
    { group: 'promotion', name: 'promotion by capture of a rook at home', fen: 'r3k2r/6P1/8/8/8/8/8/R3K2R w KQkq - 0 1', move: 'g7h8q', after: 'r3k2Q/8/8/8/8/8/8/R3K2R b KQq - 0 1', san: 'gxh8=Q+', empties: ['g7'], holds: { h8: 'Q' }, both: true },

    { group: 'clocks', name: 'capture resets the half-move clock', fen: '4k3/8/8/3p4/8/8/8/3RK3 w - - 7 20', move: 'd1d5', after: '4k3/8/8/3R4/8/8/8/4K3 b - - 0 20', san: 'Rxd5', empties: ['d1'], holds: { d5: 'R' } },
    { group: 'clocks', name: 'quiet piece move counts up the half-move clock', fen: '4k3/8/8/3p4/8/8/8/3RK3 w - - 7 20', move: 'd1d4', after: '4k3/8/8/3p4/3R4/8/8/4K3 b - - 8 20', san: 'Rd4' },
    { group: 'clocks', name: 'pawn move resets the half-move clock', fen: '4k3/8/8/8/8/8/4P3/4K3 w - - 7 20', move: 'e2e3', after: '4k3/8/8/8/8/4P3/8/4K3 b - - 0 20', san: 'e3' },
];

// --- 3. Game end and draws ----------------------------------------------------------------------
// The moves are played by clicks; the result must appear with the last one and not before.
// expect.kind: 'checkmate' | 'stalemate' | 'threefold' | 'fifty-move' | 'insufficient' | null (the
// game goes on: the documented non-draws).
const ENDINGS = [
    { group: 'checkmate', name: "fool's mate", moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], expect: { kind: 'checkmate', winner: 'b' }, san: 'Qh4#' },
    { group: 'checkmate', name: "scholar's mate", moves: ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'], expect: { kind: 'checkmate', winner: 'w' }, san: 'Qxf7#' },
    { group: 'checkmate', name: 'back-rank mate', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', moves: ['a1a8'], expect: { kind: 'checkmate', winner: 'w' }, san: 'Ra8#', both: true },
    { group: 'checkmate', name: 'mate by promotion to a queen', fen: '7k/P5pp/8/8/8/8/8/K7 w - - 0 1', moves: ['a7a8q'], expect: { kind: 'checkmate', winner: 'w' }, san: 'a8=Q#' },
    { group: 'checkmate', name: 'mate by underpromotion to a rook', fen: '7k/P5pp/8/8/8/8/8/K7 w - - 0 1', moves: ['a7a8r'], expect: { kind: 'checkmate', winner: 'w' }, san: 'a8=R#' },
    { group: 'checkmate', name: 'no mate by underpromotion to a knight', fen: '7k/P5pp/8/8/8/8/8/K7 w - - 0 1', moves: ['a7a8n'], expect: { kind: null }, san: 'a8=N' },
    { group: 'checkmate', name: 'mate by castling', fen: '8/8/8/8/6p1/2N2k2/3P3P/4K2R w K - 0 1', moves: ['e1g1'], expect: { kind: 'checkmate', winner: 'w' }, san: 'O-O#', both: true },
    { group: 'checkmate', name: 'mate on the 100th half-move is a mate, not a draw', fen: '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 99 80', moves: ['a1a8'], expect: { kind: 'checkmate', winner: 'w' }, san: 'Ra8#' },

    { group: 'stalemate', name: 'stalemate', fen: '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1', moves: ['g5g6'], expect: { kind: 'stalemate' }, san: 'Qg6', both: true },
    { group: 'stalemate', name: 'stalemate with pieces that cannot move', fen: 'k7/P7/1K6/8/8/8/8/7R w - - 0 1', moves: ['h1h2'], expect: { kind: 'stalemate' }, san: 'Rh2' },

    { group: 'threefold', name: 'knights out and back twice', moves: ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'], expect: { kind: 'threefold' } },
    { group: 'threefold', name: 'same placement with other castling rights does not count', fen: CASTLE, moves: ['a1b1', 'a8b8', 'b1a1', 'b8a8', 'a1b1', 'a8b8', 'b1a1', 'b8a8', 'a1b1', 'a8b8'], expect: { kind: 'threefold' } },
    { group: 'threefold', name: 'same placement with a real en passant right does not count', fen: '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1', moves: ['d7d5', 'e1e2', 'e8e7', 'e2e1', 'e7e8', 'e1e2', 'e8e7', 'e2e1', 'e7e8', 'e1e2'], expect: { kind: 'threefold' } },
    { group: 'threefold', name: 'a double push nobody can capture does not make the position different', moves: ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'], expect: { kind: 'threefold' } },

    { group: '50-move rule', name: 'draw with the 100th half-move', fen: '7k/8/8/8/8/8/8/R3K3 w - - 98 80', moves: ['a1a2', 'h8g8'], expect: { kind: 'fifty-move' }, both: true },
    { group: '50-move rule', name: 'a pawn move starts the count again', fen: '7k/8/8/8/8/8/P7/4K3 w - - 99 80', moves: ['a2a3'], expect: { kind: null } },
    { group: '50-move rule', name: 'a capture starts the count again', fen: '7k/8/8/8/8/8/p7/R3K3 w - - 99 80', moves: ['a1a2'], expect: { kind: null } },

    { group: 'insufficient material', name: 'K v K after the last capture', fen: '4k3/8/8/8/8/8/3p4/4K3 w - - 0 1', moves: ['e1d2'], expect: { kind: 'insufficient' }, both: true },
    { group: 'insufficient material', name: 'K+B v K', fen: '4k3/8/8/8/8/8/3p4/2B1K3 w - - 0 1', moves: ['c1d2'], expect: { kind: 'insufficient' } },
    { group: 'insufficient material', name: 'K+N v K', fen: '4k3/8/8/8/8/8/3p4/1N2K3 w - - 0 1', moves: ['b1d2'], expect: { kind: 'insufficient' } },
    { group: 'insufficient material', name: 'K+B v K+B, bishops on the same colour', fen: '4kb2/8/8/8/8/8/3p4/2B1K3 w - - 0 1', moves: ['c1d2'], expect: { kind: 'insufficient' } },
    { group: 'insufficient material', name: 'K+B v K+B, bishops on opposite colours: play goes on', fen: '4k1b1/8/8/8/8/8/3p4/2B1K3 w - - 0 1', moves: ['c1d2'], expect: { kind: null } },
    { group: 'insufficient material', name: 'K+N+N v K: play goes on', fen: '4k3/8/8/8/8/8/3p4/1NN1K3 w - - 0 1', moves: ['b1d2'], expect: { kind: null } },
    { group: 'insufficient material', name: 'K+B v K+N: play goes on', fen: '4kn2/8/8/8/8/8/3p4/2B1K3 w - - 0 1', moves: ['c1d2'], expect: { kind: null } },
    { group: 'insufficient material', name: 'K+N v K+N: play goes on', fen: '4kn2/8/8/8/8/8/3p4/1N2K3 w - - 0 1', moves: ['b1d2'], expect: { kind: null } },
    { group: 'insufficient material', name: 'underpromotion to a bishop leaves K+B v K', fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', moves: ['a7a8b'], expect: { kind: 'insufficient' }, san: 'a8=B' },
    { group: 'insufficient material', name: 'promotion to a queen: play goes on', fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1', moves: ['a7a8q'], expect: { kind: null }, san: 'a8=Q+' },
];

// Positions that are already over when loaded: nothing is offered and nothing can be moved.
const FINISHED = [
    { name: 'checkmate', fen: '6k1/5ppp/8/8/8/8/5PPP/r5K1 w - - 0 1', expect: { kind: 'checkmate', winner: 'b' } },
    { name: 'stalemate', fen: '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1', expect: { kind: 'stalemate' } },
    { name: 'bare kings', fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', expect: { kind: 'insufficient' } },
    { name: '100 half-moves without progress', fen: '7k/8/8/8/8/8/8/R3K3 w - - 100 80', expect: { kind: 'fifty-move' } },
];

// --- 6. Human vs AI -----------------------------------------------------------------------------
// The human (White) plays `human`, the AI answers `ai` (given to the page as the engine would
// return it); the answer must land exactly as the reference plays it. Every entry also runs
// mirrored (human as Black, moving first from the mirrored position).
const AI_REPLIES = [
    { name: 'AI captures en passant', fen: '4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1', human: 'e2e4', ai: 'd4e3', san: 'dxe3', empties: ['e4', 'd4'], holds: { e3: 'p' } },
    { name: 'AI castles king-side', fen: 'r3k2r/8/8/8/8/8/8/4K3 w kq - 0 1', human: 'e1d1', ai: 'e8g8', san: 'O-O', empties: ['e8', 'h8'], holds: { g8: 'k', f8: 'r' } },
    { name: 'AI castles queen-side with check', fen: 'r3k2r/8/8/8/8/8/8/4K3 w kq - 0 1', human: 'e1d1', ai: 'e8c8', san: 'O-O-O+', empties: ['e8', 'a8'], holds: { c8: 'k', d8: 'r' } },
    { name: 'AI promotes to a queen', fen: '4k3/8/8/8/8/8/p7/4K3 w - - 0 1', human: 'e1e2', ai: 'a2a1q', san: 'a1=Q', empties: ['a2'], holds: { a1: 'q' } },
    { name: 'AI promotes by capture to a knight', fen: '4k3/8/8/8/8/8/p7/1N2K3 w - - 0 1', human: 'e1e2', ai: 'a2b1n', san: 'axb1=N', empties: ['a2'], holds: { b1: 'n' } },
    { name: 'AI promotes to a rook', fen: '4k3/8/8/8/8/8/p7/4K3 w - - 0 1', human: 'e1e2', ai: 'a2a1r', san: 'a1=R', empties: ['a2'], holds: { a1: 'r' } },
];

// Positions where the engine has one sensible move: the only legal one (forced: any strength must
// play it), or a mate in one (asked at full strength). The AI is to move in `fen`; `best` is what
// it must play.
const AI_OBVIOUS = [
    { name: 'en passant is the only legal move', fen: 'k7/8/7p/5ppP/7K/r7/8/8 w - g6 0 1', best: ['h5g6'], san: 'hxg6', forced: true },
    { name: 'castling is the only mate in one', fen: '8/8/8/8/6p1/2N2k2/3P3P/4K2R w K - 0 1', best: ['e1g1'], san: 'O-O#' },
    { name: 'promotion is the only legal move', fen: '8/P7/8/8/8/6p1/5k2/7K w - - 0 1', best: ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n'], forced: true },
    { name: 'promotion by capture is the only mate in one', fen: '1n5k/P5pp/8/8/8/8/8/K7 w - - 0 1', best: ['a7b8q', 'a7b8r'] },
];

// --- The reported game ---------------------------------------------------------------------------
// White: the human, Black: the AI. The last move, 20...axb3, is the AI capturing en passant: the
// capture the player described as "a pawn capturing another pawn sideways".
const REPORTED_GAME = {
    san: '1. e4 d6 2. Bb5+ Nc6 3. h3 Nf6 4. Nc3 Nxe4 5. Nxe4 Bxh3 6. Rxh3 e6 7. d4 Be7 8. f4 Bh4+ 9. Kf1 d5 10. Nc5 Be1 ' +
        '11. Kxe1 e5 12. Nxb7 Qf6 13. dxe5 Qe6 14. Qd3 O-O 15. Qc3 Ne7 16. Qxc7 Qxh3 17. gxh3 Nf5 18. Bd7 a5 19. Bxf5 a4 20. b4 axb3',
    moves: ['e2e4', 'd7d6', 'f1b5', 'b8c6', 'h2h3', 'g8f6', 'b1c3', 'f6e4', 'c3e4', 'c8h3', 'h1h3', 'e7e6', 'd2d4', 'f8e7', 'f2f4', 'e7h4',
        'e1f1', 'd6d5', 'e4c5', 'h4e1', 'f1e1', 'e6e5', 'c5b7', 'd8f6', 'd4e5', 'f6e6', 'd1d3', 'e8g8', 'd3c3', 'c6e7', 'c3c7', 'e6h3', 'g2h3', 'e7f5',
        'b5d7', 'a7a5', 'd7f5', 'a5a4', 'b2b4', 'a4b3'],
    fen: 'r4rk1/1NQ2ppp/8/3pPB2/5P2/1p5P/P1P5/R1B1K1N1 w - - 0 21',
};

// A game to save in the middle: e5xd6 en passant is available, White can only castle queen-side
// (the h-rook has moved and come back), Black only king-side.
const SAVED_GAME = {
    moves: ['e2e4', 'a7a5', 'e4e5', 'a8a6', 'h2h4', 'a6a8', 'h1h3', 'g8f6', 'h3h1', 'f6g8', 'g1f3', 'd7d5'],
    fen: 'rnbqkbnr/1pp1pppp/8/p2pP3/7P/5N2/PPPP1PP1/RNBQKB1R w Qk d6 0 7',
};

// What the views say (the same sentences in both)
const TEXT = {
    enPassant: 'En passant: a pawn that just advanced two squares can be captured as if it had moved only one.',
    enPassantToYou: 'En passant: your pawn moved two squares and landed beside their pawn, so it can be taken as if it had moved one.',
    enPassantByYou: 'En passant: their pawn moved two squares and landed beside yours, so you can take it as if it had moved one.',
    aiFallback: 'The AI could not find a legal move, so a legal move was played for it.',
};

// --- Geometry for the "not offered" clicks ------------------------------------------------------

const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

/**
 * Squares a player could expect the piece on `from` to reach if rules were missing: every
 * neighbour, the knight jumps, the lines up to the first piece, for pawns two steps ahead, and for
 * kings two steps sideways plus the own rooks' corners.
 * @param {(sq: string) => {type: string, color: string}|null|undefined} pieceAt reference board
 */
function suspectSquares(pieceAt, from) {
    const { row, col } = square(from);
    const piece = pieceAt(from);
    const out = new Set();
    const add = (r, c) => { if (inside(r, c) && !(r === row && c === col)) out.add(squareName(r, c)); };
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) add(row + dr, col + dc);
    if (!piece) return [...out];
    if (piece.type === 'p') { add(row - 2, col); add(row + 2, col); }
    if (piece.type === 'n') for (const [dr, dc] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) add(row + dr, col + dc);
    if (piece.type === 'k') { add(row, col - 2); add(row, col + 2); add(row, 0); add(row, 7); }
    const lines = { b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], r: [[1, 0], [-1, 0], [0, 1], [0, -1]] };
    lines.q = [...lines.b, ...lines.r];
    for (const [dr, dc] of lines[piece.type] || []) {
        for (let i = 1; inside(row + i * dr, col + i * dc); i++) {
            add(row + i * dr, col + i * dc);
            if (pieceAt(squareName(row + i * dr, col + i * dc))) break;
        }
    }
    return [...out];
}

module.exports = {
    START, CASTLE, CORPUS, SPECIAL_MOVES, ENDINGS, FINISHED, AI_REPLIES, AI_OBVIOUS, REPORTED_GAME, SAVED_GAME, TEXT,
    mirrorFen, mirrorUci, mirrorSquare, mirrorEntry, suspectSquares,
};
