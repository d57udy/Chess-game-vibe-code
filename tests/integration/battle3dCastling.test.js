'use strict';
// Castling through the 3D controller's click path: king to g/c file, rook follows, both colours,
// flipped view, and after undo.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

function withCtl(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const C = await loadBattle3dController(options);
        try { await fn(C); } finally { C.close(); }
    };
}
const lastHighlights = (C) => C.scene.calls.setHighlights[C.scene.calls.setHighlights.length - 1];
const offers = (C, name) => lastHighlights(C).moves.some((m) => m.row === square(name).row && m.col === square(name).col);
const board = (C, name) => { const { row, col } = square(name); return C.get(`board[${row}][${col}]`); };

describe('battle3d controller: castling', () => {
    test('1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.O-O by clicks (human-human)', withCtl(async (C) => {
        C.controller.setMode('human-human');
        for (const mv of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']) await C.play(mv);
        await C.click('e1');
        assert.ok(offers(C, 'g1'), 'g1 offered as a king target');
        await C.click('g1');
        await C.flush();
        const ev = C.units.calls.playMove[C.units.calls.playMove.length - 1];
        assert.deepEqual(ev.castling, { rookFrom: square('h1'), rookTo: square('f1') });
        assert.equal(board(C, 'g1'), 'K');
        assert.equal(board(C, 'f1'), 'R');
        assert.equal(board(C, 'h1'), null);
        assert.equal(C.state().history.at(-1), 'O-O');
        assert.deepEqual(C.units.grid(), C.get('board'), 'units follow the rook');
        // Black castles back
        await C.play('g8f6');
        await C.play('d2d3');
        await C.click('e8');
        assert.ok(offers(C, 'g8'));
        await C.click('g8');
        assert.equal(board(C, 'g8'), 'k');
        assert.equal(board(C, 'f8'), 'r');
        assert.equal(C.state().history.at(-1), 'O-O');
        assert.deepEqual(C.errors, []);
    }));

    test('O-O-O for both colours', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.controller.loadFen('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
        await C.flush();
        await C.play('e1c1');
        assert.equal(board(C, 'c1'), 'K');
        assert.equal(board(C, 'd1'), 'R');
        await C.play('e8c8');
        assert.equal(board(C, 'c8'), 'k');
        assert.equal(board(C, 'd8'), 'r');
        assert.deepEqual(C.state().history, ['O-O-O', 'O-O-O']);
        assert.deepEqual(C.units.grid(), C.get('board'));
    }));

    test('clicking the rook after the king castles (king-onto-rook input)', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.controller.loadFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
        await C.flush();
        await C.click('e1');
        await C.click('h1');
        assert.equal(board(C, 'g1'), 'K', 'king-to-rook click castles kingside');
        assert.equal(board(C, 'f1'), 'R');
        await C.click('e8');
        await C.click('a8');
        assert.equal(board(C, 'c8'), 'k', 'king-to-rook click castles queenside');
        assert.equal(board(C, 'd8'), 'r');
    }));

    test('human as Black (flipped view) castles vs AI, and again after undo', withCtl(async (C) => {
        C.controller.setHumanColor('b');
        await C.step(0.3);
        const replies = ['e7e5', 'g8f6', 'f8c5'];
        for (const [i, ai] of ['e2e4', 'g1f3', 'f1c4'].entries()) {
            await C.answerAI(ai);
            await C.play(replies[i]);
            await C.step(0.3);
        }
        await C.answerAI('d2d3');
        await C.click('e8');
        assert.ok(offers(C, 'g8'));
        await C.click('g8');
        assert.equal(board(C, 'g8'), 'k');
        assert.equal(board(C, 'f8'), 'r');
        C.button('undo').click();
        await C.flush();
        assert.equal(board(C, 'e8'), 'k');
        await C.click('e8');
        assert.ok(offers(C, 'g8'), 'castling offered again after undo');
        await C.click('g8');
        assert.equal(board(C, 'g8'), 'k');
        assert.deepEqual(C.errors, []);
    }));
});
