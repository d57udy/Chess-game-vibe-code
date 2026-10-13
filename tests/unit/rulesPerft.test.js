'use strict';
// Perft with per-category leaf counts (nodes, captures, en passant, castles, promotions, checks,
// checkmates) for the standard positions of chessprogramming.org/Perft_Results, run separately
// through the two rule implementations that decide what gets played:
//   - gameLogic.js generateLegalMoves + battle3d/rules.js battle3dApplyMove/battle3dUndo (the rules
//     of the 2D and 3D views; the categories are read off the MoveEvents the 3D view animates),
//   - the ChessAI generator and make/unmake in aiPlayer.js (the rules the AI searches with).
// Depths are chosen to keep this file fast; tests/slow/rulesPerftDeep.test.js goes deeper.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame, loadAi } = require('../helpers/chessReference');
const { POSITIONS, GAME_PERFT, expected, gamePerft, aiPerft } = require('../helpers/perftSuite');

// [gameLogic.js depth, ChessAI depth] per position
const DEPTHS = {
    'initial position': [2, 4],
    'position 2 (Kiwipete)': [2, 3],
    'position 3': [3, 5],
    'position 4': [3, 4],
    'position 4 (mirrored)': [2, 4],
    'position 5': [2, 3],
    'position 6': [1, 3],
};

describe('perft: gameLogic.js generator + battle3d/rules.js move application', () => {
    const G = loadGame();
    G.run(GAME_PERFT);
    for (const position of POSITIONS) {
        const depth = DEPTHS[position.name][0];
        test(`${position.name} to depth ${depth}`, () => {
            for (let d = 1; d <= depth; d++) assert.deepEqual(gamePerft(G, position.fen, d), expected(position, d), `depth ${d}`);
        });
    }
});

describe('perft: ChessAI generator and make/unmake (aiPlayer.js)', () => {
    const A = loadAi();
    for (const position of POSITIONS) {
        const depth = DEPTHS[position.name][1];
        test(`${position.name} to depth ${depth}`, () => {
            for (let d = 1; d <= depth; d++) {
                assert.deepEqual(aiPerft(A, position.fen, d), expected(position, d), `depth ${d}`);
                // The plain node counter the other suites use agrees with the categorised one
                if (d <= 3) assert.equal(aiPerft(A, position.fen, d, true).nodes, position.counts[d - 1][0], `ChessAI.perft depth ${d}`);
            }
        });
    }
});

describe('perft: the table covers every special move', () => {
    test('en passant, castling, promotion and checkmate all occur at the tested depths', () => {
        for (const side of [0, 1]) {
            const total = { ep: 0, castles: 0, promotions: 0, checkmates: 0 };
            for (const position of POSITIONS) {
                const e = expected(position, DEPTHS[position.name][side]);
                for (const k of Object.keys(total)) total[k] += e[k];
            }
            for (const [k, n] of Object.entries(total)) assert.ok(n > 0, `${side ? 'ChessAI' : 'gameLogic.js'}: no ${k} at the tested depths`);
        }
    });
});
