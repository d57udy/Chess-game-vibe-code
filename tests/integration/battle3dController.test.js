'use strict';
// battle3d/controller.js turn flow in jsdom with fake scene/units (no three.js, no WebGL).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function withCtl(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const C = await loadBattle3dController(options);
        try { await fn(C); } finally { C.close(); }
    };
}
const lastHighlights = (C) => C.scene.calls.setHighlights[C.scene.calls.setHighlights.length - 1];

describe('battle3d controller: boot and selection', () => {
    test('new game: White (human) to move, no AI request, view from White', withCtl(async (C) => {
        const s = C.state();
        assert.equal(s.fen, START);
        assert.equal(s.turn, 'w');
        assert.equal(s.mode, 'human-ai');
        assert.equal(s.thinking, false, 'human-ai starts on the human turn');
        assert.equal(s.busy, false);
        await C.step(1);
        assert.equal(C.aiCalls().length, 0);
        assert.deepEqual(C.scene.calls.setView, ['w']);
        assert.match(C.status(), /White/);
        assert.deepEqual(C.errors, []);
    }));

    test('clicking an own unit highlights its legal moves; other clicks deselect', withCtl(async (C) => {
        await C.click('g1');
        let h = lastHighlights(C);
        assert.deepEqual(h.selected, square('g1'));
        assert.deepEqual(h.moves.map((m) => m.row * 8 + m.col).sort(), [square('f3'), square('h3')].map((q) => q.row * 8 + q.col).sort());
        assert.equal(C.state().selected.col, 6);
        await C.click('e7'); // opponent unit
        assert.equal(C.state().selected, null);
        await C.click('e2');
        await C.click('e5'); // not a legal target
        assert.equal(C.state().selected, null);
        assert.equal(C.units.calls.playMove.length, 0);
        await C.click('e2');
        C.key('Escape', 'Escape');
        assert.equal(C.state().selected, null);
    }));

    test('capture targets are flagged in highlights (incl. en passant)', withCtl(async (C) => {
        C.controller.setMode('human-human');
        for (const mv of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await C.play(mv);
        await C.click('e5');
        const moves = lastHighlights(C).moves;
        const ep = moves.find((m) => m.row === square('d6').row && m.col === square('d6').col);
        assert.ok(ep, 'en passant square offered');
        assert.equal(ep.capture, true);
    }));
});

describe('battle3d controller: human vs AI flow', () => {
    test('human move -> MoveEvent to units -> AI request after the pause -> AI move', withCtl({ units: 'manual' }, async (C) => {
        await C.click('e2');
        await C.click('e4');
        assert.equal(C.units.calls.playMove.length, 1);
        const ev = C.units.calls.playMove[0];
        assert.deepEqual([ev.from, ev.to, ev.piece, ev.color, ev.isAI], [square('e2'), square('e4'), 'P', 'w', false]);
        assert.equal(C.state().moving, true);
        assert.equal(C.button('skip').disabled, false);
        assert.equal(C.button('undo').disabled, true, 'undo disabled while animating');

        // Input locked while the move animates
        await C.click('d2');
        assert.equal(C.state().selected, null);

        C.units.finish();
        await C.flush();
        assert.equal(C.state().moving, false);
        assert.equal(C.aiCalls().length, 0, 'AI waits for the scene-clock pause');
        await C.step(0.3);
        assert.equal(C.aiCalls().length, 1);
        const call = C.aiCalls()[0];
        assert.equal(call.state.currentPlayer, 'b');
        assert.equal(call.state.positionHistory.length, 2);
        assert.equal(call.elo, 1200);
        assert.equal(C.state().thinking, true);
        assert.match(C.status(), /thinking/);

        // Input locked while the AI thinks
        await C.click('d2');
        assert.equal(C.state().selected, null);

        await C.answerAI('e7e5');
        assert.equal(C.units.calls.playMove[1].isAI, true);
        assert.equal(C.state().turn, 'w');
        assert.deepEqual(C.state().history, ['e4', 'e5']);
        assert.equal(C.state().busy, false);
        assert.equal(C.doc.querySelectorAll('#move-list li').length, 1);
        assert.deepEqual(C.errors, []);
    }));

    test('undo vs AI takes back 2 plies and resyncs units', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3);
        await C.answerAI('e7e5');
        const syncs = C.units.calls.syncBoard;
        assert.equal(C.button('undo').disabled, false);
        C.button('undo').click();
        await C.flush();
        assert.equal(C.state().fen, START);
        assert.deepEqual(C.state().history, []);
        assert.ok(C.units.calls.syncBoard > syncs, 'units.syncBoard after undo');
        assert.deepEqual(C.units.grid(), C.get('board'));
        await C.step(1);
        assert.equal(C.aiCalls().length, 1, 'no new AI request: it is the human turn');
    }));

    test('undo while the AI is thinking takes back the human move and cancels the request', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3);
        assert.equal(C.aiCalls().length, 1);
        C.controller.undo();
        await C.flush();
        assert.equal(C.aiCalls()[0].cancelled, true);
        assert.equal(C.state().fen, START);
        assert.equal(C.state().thinking, false);
    }));

    test('switching to Black: AI plays White, view flips', withCtl(async (C) => {
        C.button('side-b').click();
        await C.step(0.3);
        assert.deepEqual(C.scene.calls.setView.slice(-1), ['b']);
        assert.equal(C.aiCalls().length, 1);
        assert.equal(C.aiCalls()[0].state.currentPlayer, 'w');
        await C.answerAI('d2d4');
        assert.equal(C.state().turn, 'b');
        await C.play('d7d5');
        await C.step(0.3);
        assert.equal(C.aiCalls().length, 2);
    }));

    test('AI promotion is applied without the popup', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.g('battle3dLoadFen("4k3/8/8/8/8/8/p7/4K3 w - - 0 1")');
        C.units.api.syncBoard(C.get('board'));
        C.controller.setMode('human-ai');
        await C.play('e1f2');
        await C.step(0.3);
        await C.answerAI('a2a1q');
        assert.equal(C.units.calls.playMove.slice(-1)[0].promotion, 'Q');
        assert.equal(C.doc.getElementById('promo').hidden, true);
        assert.equal(C.get('board[7][0]'), 'q');
    }));

    test('an illegal AI move is reported, not applied', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3);
        await C.answerAI('e7e4');
        assert.match(C.status(), /AI error/);
        assert.equal(C.state().history.length, 1);
    }));
});

describe('battle3d controller: modes, skip, game over', () => {
    test('mode switch cancels the pending AI request; a late answer is ignored', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3);
        const call = C.aiCalls()[0];
        C.controller.setMode('human-human');
        await C.flush();
        assert.equal(call.cancelled, true);
        assert.equal(C.state().thinking, false);
        call.resolve({ from: square('e7'), to: square('e5') });
        await C.flush();
        assert.equal(C.state().history.length, 1);
        await C.play('e7e5');
        assert.deepEqual(C.state().history, ['e4', 'e5']);
    }));

    test('mode switch during the pre-request pause drops the pending request', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.1);
        C.controller.setMode('human-human');
        await C.step(1);
        assert.equal(C.aiCalls().length, 0);
    }));

    test('AI vs AI requests moves for both sides and switches to fast', withCtl(async (C) => {
        C.controller.setMode('ai-ai');
        assert.equal(C.state().speed, 'fast');
        assert.ok(C.units.calls.setMode.includes('fast'));
        await C.step(0.7);
        assert.equal(C.aiCalls().length, 1);
        await C.answerAI('e2e4');
        await C.step(0.7);
        assert.equal(C.aiCalls().length, 2);
        assert.equal(C.aiCalls()[1].state.currentPlayer, 'b');
        await C.click('e2');
        assert.equal(C.state().selected, null, 'no human input in AI vs AI');
    }));

    test('new game while the AI thinks cancels it and resets', withCtl(async (C) => {
        await C.play('e2e4');
        await C.step(0.3);
        C.button('new-game').click();
        await C.flush();
        assert.equal(C.aiCalls()[0].cancelled, true);
        assert.equal(C.state().fen, START);
        assert.deepEqual(C.state().history, []);
    }));

    test('skip button and Space call units.skip while a move animates', withCtl({ units: 'manual' }, async (C) => {
        C.controller.setMode('human-human');
        await C.click('e2');
        await C.click('e4');
        assert.equal(C.state().moving, true);
        C.button('skip').click();
        await C.flush();
        assert.equal(C.units.calls.skip, 1);
        assert.equal(C.state().moving, false);
        await C.click('e7');
        await C.click('e5');
        C.key('Space', ' ');
        await C.flush();
        assert.equal(C.units.calls.skip, 2);
        assert.deepEqual(C.state().history, ['e4', 'e5']);
    }));

    test("checkmate plays the game-over scene and stops input (fool's mate)", withCtl(async (C) => {
        C.controller.setMode('human-human');
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await C.play(mv);
        const s = C.state();
        assert.equal(s.over, true);
        assert.equal(s.result, 'checkmate');
        assert.deepEqual(C.units.calls.playGameOver, [{ result: 'checkmate', loser: 'w', kingSquare: square('e1') }]);
        assert.equal(C.units.calls.playMove.slice(-1)[0].isMate, true);
        await C.click('e2');
        assert.equal(C.state().selected, null);
        assert.match(C.status(), /Checkmate/);
        C.controller.setMode('human-ai');
        await C.step(1);
        assert.equal(C.aiCalls().length, 0, 'no AI after the game is over');
    }));

    test('check plays the king reaction', withCtl(async (C) => {
        C.controller.setMode('human-human');
        for (const mv of ['e2e4', 'f7f6', 'd1h5']) await C.play(mv);
        assert.deepEqual(C.units.calls.playCheck, [square('e8')]);
        assert.deepEqual(lastHighlights(C).check, square('e8'));
    }));

    test('stalemate reports a draw to units', withCtl(async (C) => {
        C.controller.setMode('human-human');
        C.g('battle3dLoadFen("7k/8/6K1/5Q2/8/8/8/8 w - - 0 1")');
        C.units.api.syncBoard(C.get('board'));
        await C.play('f5f7');
        assert.deepEqual(C.units.calls.playGameOver, [{ result: 'stalemate', loser: null, kingSquare: square('h8') }]);
    }));
});

describe('battle3d controller: promotion popup', () => {
    const PROMO_FEN = '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1';
    async function setup(C) {
        C.controller.setMode('human-human');
        C.g(`battle3dLoadFen(${JSON.stringify(PROMO_FEN)})`);
        C.units.api.syncBoard(C.get('board'));
    }

    test('choosing a piece applies the promotion', withCtl(async (C) => {
        await setup(C);
        await C.click('a7');
        await C.click('b8');
        assert.equal(C.doc.getElementById('promo').hidden, false);
        assert.ok(C.state().pendingPromotion);
        await C.click('e1'); // input locked while the popup is open
        assert.deepEqual(C.state().selected, square('a7'));
        C.doc.querySelector('#promo button[data-piece="N"]').click();
        await C.flush();
        assert.equal(C.doc.getElementById('promo').hidden, true);
        const ev = C.units.calls.playMove[0];
        assert.equal(ev.promotion, 'N');
        assert.deepEqual(ev.captured, { piece: 'n', square: square('b8') });
        assert.deepEqual(C.state().history, ['axb8=N']);
    }));

    test('popup glyphs match the side to move', withCtl(async (C) => {
        await setup(C);
        await C.click('a7');
        await C.click('a8');
        const glyphs = [...C.doc.querySelectorAll('#promo .glyph')].map((e) => e.textContent);
        assert.deepEqual(glyphs, ['♕', '♖', '♗', '♘']);
    }));

    test('cancel (button or Escape) leaves the position unchanged', withCtl(async (C) => {
        await setup(C);
        await C.click('a7');
        await C.click('a8');
        C.button('promo-cancel').click();
        await C.flush();
        assert.equal(C.doc.getElementById('promo').hidden, true);
        assert.equal(C.state().history.length, 0);
        await C.click('a7');
        await C.click('a8');
        C.key('Escape', 'Escape');
        await C.flush();
        assert.equal(C.state().pendingPromotion, null);
        assert.equal(C.units.calls.playMove.length, 0);
    }));
});

describe('battle3d controller: robustness', () => {
    test('a stuck animation is skipped by the scene-clock watchdog', withCtl({ units: 'never' }, async (C) => {
        C.controller.setMode('human-human');
        await C.click('e2');
        await C.click('e4');
        assert.equal(C.state().moving, true);
        await C.step(31, 1 / 10);
        assert.equal(C.state().moving, false);
        assert.ok(C.units.calls.skip >= 1);
        assert.deepEqual(C.units.grid(), C.get('board'), 'units resynced after the watchdog');
        assert.ok(C.warnings.some((w) => /timed out/.test(w)));
    }));

    test('units out of sync after an animation are resynced', withCtl(async (C) => {
        C.controller.setMode('human-human');
        const orig = C.units.api.playMove;
        C.units.api.playMove = () => Promise.resolve(); // forgets to move the unit
        const before = C.units.calls.syncBoard;
        await C.play('e2e4');
        assert.ok(C.units.calls.syncBoard > before);
        assert.deepEqual(C.units.grid(), C.get('board'));
        C.units.api.playMove = orig;
    }));

    test('labels toggle and speed buttons reach units', withCtl(async (C) => {
        const labels = C.button('labels-toggle');
        labels.checked = false;
        labels.dispatchEvent(new C.w.Event('change'));
        assert.equal(C.units.calls.setLabels.slice(-1)[0], false);
        C.button('speed-fast').click();
        assert.equal(C.units.calls.setMode.slice(-1)[0], 'fast');
        C.button('speed-full').click();
        assert.equal(C.units.calls.setMode.slice(-1)[0], 'full');
    }));

    test('AI vs AI plays a whole game on scene time and stops at mate', withCtl(async (C) => {
        C.controller.setMode('ai-ai');
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
            await C.step(0.7, 0.1);
            await C.answerAI(mv);
        }
        assert.equal(C.state().over, true);
        assert.equal(C.aiCalls().length, 4);
        await C.step(2, 0.1);
        assert.equal(C.aiCalls().length, 4, 'no request after mate');
        assert.equal(C.units.calls.playGameOver.length, 1);
        assert.deepEqual(C.errors, []);
    }));
});
