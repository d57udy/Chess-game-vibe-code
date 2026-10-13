// Perft data and runners shared by tests/unit/rulesPerft.test.js and tests/slow/rulesPerftDeep.test.js.
//
// POSITIONS holds the standard perft positions of https://www.chessprogramming.org/Perft_Results
// with their leaf counts per depth as [nodes, captures, en passant, castles, promotions, checks,
// checkmates] (captures include en passant; a category counts the moves of the last ply only).
// The wiki publishes node counts only for positions 5 and 6; their category counts were computed
// with chess.js (the independent reference) and are marked `derived`.
'use strict';
const CATEGORIES = ['nodes', 'captures', 'ep', 'castles', 'promotions', 'checks', 'checkmates'];

const POSITIONS = [
    {
        name: 'initial position',
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        counts: [
            [20, 0, 0, 0, 0, 0, 0],
            [400, 0, 0, 0, 0, 0, 0],
            [8902, 34, 0, 0, 0, 12, 0],
            [197281, 1576, 0, 0, 0, 469, 8],
            [4865609, 82719, 258, 0, 0, 27351, 347],
            [119060324, 2812008, 5248, 0, 0, 809099, 10828],
        ],
    },
    {
        name: 'position 2 (Kiwipete)',
        fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
        counts: [
            [48, 8, 0, 2, 0, 0, 0],
            [2039, 351, 1, 91, 0, 3, 0],
            [97862, 17102, 45, 3162, 0, 993, 1],
            [4085603, 757163, 1929, 128013, 15172, 25523, 43],
            [193690690, 35043416, 73365, 4993637, 8392, 3309887, 30171],
        ],
    },
    {
        name: 'position 3',
        fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
        counts: [
            [14, 1, 0, 0, 0, 2, 0],
            [191, 14, 0, 0, 0, 10, 0],
            [2812, 209, 2, 0, 0, 267, 0],
            [43238, 3348, 123, 0, 0, 1680, 17],
            [674624, 52051, 1165, 0, 0, 52950, 0],
            [11030083, 940350, 33325, 0, 7552, 452473, 2733],
        ],
    },
    {
        name: 'position 4',
        fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
        counts: [
            [6, 0, 0, 0, 0, 0, 0],
            [264, 87, 0, 6, 48, 10, 0],
            [9467, 1021, 4, 0, 120, 38, 22],
            [422333, 131393, 0, 7795, 60032, 15492, 5],
            [15833292, 2046173, 6512, 0, 329464, 200568, 50562],
        ],
    },
    {
        // Position 4 with colours swapped: the same counts, Black's rules instead of White's
        name: 'position 4 (mirrored)',
        fen: 'r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1',
        counts: [
            [6, 0, 0, 0, 0, 0, 0],
            [264, 87, 0, 6, 48, 10, 0],
            [9467, 1021, 4, 0, 120, 38, 22],
            [422333, 131393, 0, 7795, 60032, 15492, 5],
            [15833292, 2046173, 6512, 0, 329464, 200568, 50562],
        ],
    },
    {
        name: 'position 5',
        fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
        derived: true,
        counts: [
            [44, 6, 0, 1, 4, 0, 0],
            [1486, 222, 0, 0, 0, 117, 0],
            [62379, 8517, 0, 1081, 5068, 1201, 44],
            [2103487, 296153, 0, 0, 0, 158486, 240],
            [89941194],
        ],
    },
    {
        name: 'position 6',
        fen: 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
        derived: true,
        counts: [
            [46, 4, 0, 0, 0, 1, 0],
            [2079, 203, 0, 0, 0, 40, 0],
            [89890, 9470, 0, 0, 0, 1783, 0],
            [3894594, 440388, 0, 0, 0, 68985, 0],
            [164075551],
        ],
    },
];

const asObject = (row) => Object.fromEntries(CATEGORIES.slice(0, row.length).map((k, i) => [k, row[i]]));
const expected = (position, depth) => asObject(position.counts[depth - 1]);

// Perft through gameLogic.js generateLegalMoves and the production move application of the 3D game
// (battle3dApplyMove / battle3dUndo); the categories are read off the MoveEvents. Runs inside the vm
// context of chessReference.loadGame(). __legal() comes from that helper.
const GAME_PERFT = `
function __perft(depth, acc) {
    for (const m of __legal()) {
        const ev = battle3dApplyMove(m.from, m.to, m.uci[4] ? m.uci[4].toUpperCase() : null);
        if (depth > 1) {
            __perft(depth - 1, acc);
        } else {
            acc.nodes++;
            if (ev.captured) acc.captures++;
            if (ev.enPassant) acc.ep++;
            if (ev.castling) acc.castles++;
            if (ev.promotion) acc.promotions++;
            if (ev.givesCheck) acc.checks++;
            if (ev.isMate) acc.checkmates++;
        }
        battle3dUndo(1);
    }
    return acc;
}`;

// Leaf counts of `fen` at `depth` through the game rules; verifies the position is restored.
function gamePerft(G, fen, depth) {
    G.load(fen);
    const counts = G.get(`__perft(${depth}, { nodes: 0, captures: 0, ep: 0, castles: 0, promotions: 0, checks: 0, checkmates: 0 })`);
    if (G.run('battle3dFen()') !== fen) throw new Error(`perft left ${G.run('battle3dFen()')} instead of ${fen}`);
    return counts;
}

// Leaf counts through the ChessAI generator and make/unmake (aiPlayer.js). nodesOnly uses the
// plain ChessAI.perft().
function aiPerft(A, fen, depth, nodesOnly = false) {
    A.fen(fen);
    if (!A.run('ChessAI.loadFromGlobals()')) throw new Error('engine could not load ' + fen);
    return nodesOnly ? { nodes: A.run(`ChessAI.perft(${depth})`) } : A.get(`ChessAI.perftCounts(${depth})`);
}

module.exports = { POSITIONS, CATEGORIES, GAME_PERFT, expected, gamePerft, aiPerft };
