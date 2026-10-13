'use strict';
// The game never stalls on a bad AI answer (battle3d/controller.js): an illegal move is rejected and logged
// with the position, the AI is asked once more, and if that fails too the rules play a legal move with a
// notice. Missing answers and requests that fail to start are handled the same way.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

const NOTE = 'The AI could not find a legal move, so a legal move was played for it.';
function withCtl(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const C = await loadBattle3dController(options);
        try { await fn(C); } finally { C.close(); }
    };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const move = (uci) => (uci ? { from: square(uci.slice(0, 2)), to: square(uci.slice(2, 4)) } : null);
// Answers the pending AI request with a move that may be illegal, or with null (no move)
async function answer(C, uci) {
    const call = C.aiCalls().at(-1);
    call.resolve(move(uci));
    await C.flush();
    return call;
}
// 1. e4 by the human, then the AI's first request
async function afterE4(C) {
    await C.play('e2e4');
    await C.step(0.3);
    return C.aiCalls().at(-1);
}

describe('battle3d controller: recovering from a bad AI answer', () => {
    test('an illegal answer is rejected, logged with the move and the position, and asked for again', withCtl(async (C) => {
        const first = await afterE4(C);
        const fen = C.state().fen;
        await answer(C, 'a7b6'); // a pawn stepping diagonally onto an empty square
        assert.deepEqual(C.state().history, ['e4'], 'the illegal move is not played');
        assert.equal(C.state().fen, fen);
        assert.equal(C.units.calls.playMove.length, 1, 'nothing was animated');
        assert.equal(C.errors.length, 1, 'logged once');
        assert.ok(C.errors[0].includes(`AI move rejected: a7b6 in ${fen}`), C.errors[0]);
        assert.match(C.status(), /Black \(AI 1200\) is thinking/, 'the status shows the AI at work again, not an error');
        await C.step(0.3);
        const second = C.aiCalls().at(-1);
        assert.notEqual(second, first, 'a second request');
        assert.equal(C.aiCalls().length, 2);
        assert.deepEqual(plain(second.state), plain(first.state), 'for the same position');
        assert.equal(first.options.seed, undefined);
        assert.equal(second.options.seed, 1, 'with a seed of its own');
        await C.answerAI('e7e5');
        assert.deepEqual(C.state().history, ['e4', 'e5'], 'the legal second answer is played');
        assert.equal(C.announced().includes(NOTE), false, 'no fallback notice');
        assert.equal(C.warnings.length, 0);
        // The next turn is an ordinary request again
        await C.play('g1f3');
        await C.step(0.3);
        assert.equal(C.aiCalls().length, 3);
        assert.equal(C.aiCalls().at(-1).options.seed, undefined);
    }));

    for (const [name, bad] of [['illegal twice', 'a7b6'], ['no move twice', null]]) {
        test(`${name}: the rules play the first legal move, say so, and the game goes on`, withCtl(async (C) => {
            await afterE4(C);
            const fen = C.state().fen;
            await answer(C, bad);
            await C.step(0.3);
            assert.equal(C.aiCalls().length, 2, 'asked again once');
            await answer(C, bad);
            await C.flush();
            assert.equal(C.aiCalls().length, 2, 'not asked a third time');
            // Black's first legal move in board order (a8 to h1) after 1. e4 is the b8 knight to a6
            assert.deepEqual(C.state().history, ['e4', 'Na6']);
            assert.equal(C.get('board[2][0]'), 'n');
            assert.deepEqual(C.units.grid(), C.get('board'), 'units follow');
            assert.equal(C.units.calls.playMove.at(-1).isAI, true);
            assert.equal(C.errors.length, 2, 'both failures are logged');
            for (const e of C.errors) assert.ok(e.includes(fen) && (bad ? e.includes('AI move rejected: a7b6') : e.includes('AI returned no move')), e);
            assert.ok(C.warnings.some((w) => w.includes(`playing b8a6 for the AI in ${fen}`)), `${C.warnings}`);
            assert.ok(C.announced().includes(NOTE), `announced: ${C.announced()}`);
            assert.match(C.status(), /White to move\. Your move\./, 'no error left in the status line');
            assert.equal(C.state().turn, 'w');
            // The game continues normally
            await C.play('d2d4');
            await C.step(0.3);
            await C.answerAI('e7e6');
            assert.deepEqual(C.state().history, ['e4', 'Na6', 'd4', 'e6']);
        }));
    }

    test('the fallback is the same move for the same position, and promotes to a queen', withCtl(async (C) => {
        const played = [];
        for (let i = 0; i < 2; i++) {
            C.controller.setHumanColor('w');
            C.button('new-game').click();
            await C.flush();
            await afterE4(C);
            await answer(C, 'e8e1');
            await C.step(0.3);
            await answer(C, 'h8h1');
            await C.flush();
            played.push(C.state().history.at(-1));
        }
        assert.deepEqual(played, ['Na6', 'Na6']);
        // The AI has White and only a pawn move ahead of its king in board order: a7-a8 promotes
        C.errors.length = 0;
        C.controller.setHumanColor('b');
        C.controller.loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await C.step(0.3);
        await answer(C, 'a7a6');
        await C.step(0.3);
        await answer(C, 'a7b8');
        await C.flush();
        assert.deepEqual(C.state().history, ['a8=Q+']);
        assert.equal(C.get('board[0][0]'), 'Q');
        assert.equal(C.errors.length, 2);
    }));

    test('a request that fails to start is retried and then replaced by the fallback', withCtl(async (C) => {
        await C.play('e2e4');
        C.g('window.__realRequest = window.requestAIMove; window.requestAIMove = () => { throw new Error("no worker"); };');
        await C.step(0.3);
        await C.step(0.3);
        await C.flush();
        assert.deepEqual(C.state().history, ['e4', 'Na6']);
        assert.equal(C.errors.length, 2);
        assert.ok(C.errors.every((e) => /AI request failed to start in /.test(e)), `${C.errors}`);
        assert.ok(C.announced().includes(NOTE));
        C.g('window.requestAIMove = window.__realRequest;');
        await C.play('d2d4');
        await C.step(0.3);
        await C.answerAI('e7e6');
        assert.equal(C.state().history.at(-1), 'e6');
    }));

    test('taking the move back while the AI is asked again stops the recovery', withCtl(async (C) => {
        await afterE4(C);
        await answer(C, 'a7b6');
        assert.equal(C.state().thinking, true, 'waiting to ask again');
        C.button('undo').click();
        await C.flush();
        await C.step(0.5);
        assert.deepEqual(C.state().history, []);
        assert.equal(C.aiCalls().length, 1, 'no second request');
        assert.equal(C.state().turn, 'w');
        // ... and during the second request
        const first = await afterE4(C);
        assert.equal(C.aiCalls().length, 2);
        await answer(C, 'a7b6');
        await C.step(0.3);
        const retry = C.aiCalls().at(-1);
        assert.notEqual(retry, first);
        C.button('undo').click();
        await C.flush();
        assert.equal(retry.cancelled, true);
        retry.resolve(move('a7b6'));
        await C.flush();
        await C.step(0.5);
        assert.deepEqual(C.state().history, [], 'a cancelled request is not a failure: no fallback move');
    }));

    test('AI vs AI: one side\'s bad answers do not stop the game', withCtl({ newGame: false }, async (C) => {
        C.controller.setMode('ai-ai');
        C.controller.newGame();
        await C.step(0.7);
        await answer(C, 'e2e5');
        await C.step(0.7);
        await answer(C, 'e2e5');
        await C.flush();
        assert.equal(C.state().history.length, 1, 'White got a legal move');
        assert.equal(C.state().turn, 'b');
        await C.step(0.7);
        assert.equal(C.aiCalls().at(-1).state.currentPlayer, 'b', 'Black is asked next');
        await C.answerAI('e7e5');
        assert.equal(C.state().history.at(-1), 'e5');
    }));
});
