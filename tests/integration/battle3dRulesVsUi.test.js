'use strict';
// Replays games through battle3d/rules.js (node vm) and through the real 2D UI (jsdom, by
// clicking) and compares the position and notation after every ply.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom } = require('../helpers/loadDom');
const { loadBattle3dRules, STATE_EXPR, LEGAL_UCI_EXPR, rng } = require('../helpers/loadBattle3dRules');

const SCRIPTED_GAME = ('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 e1g1 f8c5 d2d4 e5d4 e4e5 d7d5 e5d6 e8g8 d6c7 c8g4 ' +
    'c7d8q f8d8 f1e1 g4f3 d1f3 d4d3 c4f7 g8f8 f7b3 d3c2 c1d2 c2b1n a1b1 a8c8 e1e8 d8e8 f3f6 g7f6').split(' ');

async function compare(moves, { fen } = {}) {
    const D = await loadDom();
    try {
        D.setMode('human-human');
        const A = loadBattle3dRules();
        if (fen) { D.loadPosition(fen); A.run(`battle3dLoadFen(${JSON.stringify(fen)})`); } else A.run('battle3dNewGame()');
        for (const [i, mv] of moves.entries()) {
            const ev = A.apply(mv);
            await D.play(mv);
            assert.equal(A.state(), D.g(STATE_EXPR), `ply ${i + 1} ${mv}`);
            assert.equal(ev.notation, D.notations()[i], `ply ${i + 1} ${mv}`);
            assert.equal(A.run('gameStatusMessage').replace(' to move.', "'s turn."), D.g('gameStatusMessage'), `status after ${mv}`);
            assert.equal(A.run('isGameOver'), D.g('isGameOver'));
        }
        assert.deepEqual(D.errors, []);
    } finally {
        D.close();
    }
}

describe('battle3d rules.js vs the 2D UI', () => {
    test('scripted game (castling both sides, en passant, promotions, checks)', () => compare(SCRIPTED_GAME));

    test("fool's mate", () => compare(['f2f3', 'e7e5', 'g2g4', 'd8h4']));

    test('threefold repetition', () => compare('g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8'.split(' ')));

    test('underpromotions from a position', () => compare(['a7b8r', 'e8d7', 'b8b7', 'd7e6', 'g7g8n'], { fen: '1n2k3/P5P1/8/8/8/8/8/4K3 w - - 0 1' }));

    test('seeded random games (5 x 60 plies)', async () => {
        const rand = rng(7);
        for (let game = 0; game < 5; game++) {
            const A = loadBattle3dRules();
            A.run('battle3dNewGame()');
            const moves = [];
            for (let ply = 0; ply < 60 && !A.get('battle3dGameStatus()').over; ply++) {
                const legal = A.get(LEGAL_UCI_EXPR);
                const mv = legal[Math.floor(rand() * legal.length)];
                A.apply(mv);
                moves.push(mv);
            }
            await compare(moves);
        }
    });
});
