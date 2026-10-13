'use strict';
// Deep perft with per-category counts for the standard positions (chessprogramming.org), through
// gameLogic.js + battle3d/rules.js and through the ChessAI generator (skipped by `npm test` unless
// RUN_SLOW=1). The fast depths run in tests/unit/rulesPerft.test.js.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadGame, loadAi } = require('../helpers/chessReference');
const { POSITIONS, GAME_PERFT, expected, gamePerft, aiPerft } = require('../helpers/perftSuite');

const skip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';

// [gameLogic.js depth, ChessAI depth] per position
const DEPTHS = {
    'initial position': [4, 6],
    'position 2 (Kiwipete)': [3, 5],
    'position 3': [4, 6],
    'position 4': [3, 5],
    'position 4 (mirrored)': [3, 5],
    'position 5': [3, 5],
    'position 6': [3, 5],
};

describe('deep perft: gameLogic.js generator + battle3d/rules.js move application', { skip }, () => {
    for (const position of POSITIONS) {
        const depth = DEPTHS[position.name][0];
        test(`${position.name} at depth ${depth}`, () => {
            const G = loadGame();
            G.run(GAME_PERFT);
            assert.deepEqual(gamePerft(G, position.fen, depth), expected(position, depth));
        });
    }
});

describe('deep perft: ChessAI generator and make/unmake (aiPlayer.js)', { skip }, () => {
    for (const position of POSITIONS) {
        const depth = DEPTHS[position.name][1];
        test(`${position.name} at depth ${depth}`, () => {
            const A = loadAi();
            // Rows with the node count only (positions 5 and 6 at depth 5) use the plain counter
            const nodesOnly = position.counts[depth - 1].length === 1;
            assert.deepEqual(aiPerft(A, position.fen, depth, nodesOnly), expected(position, depth));
        });
    }
});
