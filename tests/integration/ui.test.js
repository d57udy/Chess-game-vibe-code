'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadDom, sleep } = require('../helpers/loadDom');

// Runs fn with a fresh page and always closes the window (stops its timers).
function withDom(options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    return async () => {
        const D = await loadDom(options);
        try { await fn(D); } finally { D.close(); }
    };
}

const move = (from, to, extra = {}) => ({ from, to, isPromotion: false, promotionPiece: null, ...extra });
const label = (el) => el.querySelector('.coordinate-label').textContent;

describe('move input and animation lock', () => {
    test('a move locks input until its animation finishes', withDom({ tweens: 'manual' }, async (D) => {
        D.setMode('human-human');
        D.click('e2'); D.click('e4');
        assert.equal(D.g('isAnimating'), true);
        assert.equal(D.pieceAt('e4'), 'P', 'logical board updated immediately');
        D.click('d2'); D.click('d4');
        assert.equal(D.g('selectedSquare'), null, 'clicks during the animation are ignored');
        D.el('undo-button').click();
        D.key('ArrowLeft');
        assert.equal(D.g('currentMoveIndex'), 0, 'undo/navigation ignored during the animation');
        await D.settle();
        assert.deepEqual(D.notations(), ['e4']);
        assert.equal(D.g('currentPlayer'), 'b');
        assert.equal(D.g('isAnimating'), false);
        assert.equal(D.pieceAt('d2'), 'P');
        assert.ok(D.squareEl('e2').classList.contains('last-move') && D.squareEl('e4').classList.contains('last-move'));
        assert.deepEqual(D.played, ['move.mp3']);
    }));

    test('selection highlights legal moves; clicking elsewhere deselects; Escape clears', withDom(async (D) => {
        D.setMode('human-human');
        D.click('g1');
        assert.ok(D.squareEl('g1').classList.contains('selected'));
        assert.ok(D.squareEl('f3').classList.contains('legal-move') && D.squareEl('h3').classList.contains('legal-move'));
        D.click('b8'); // opponent piece: deselect only
        assert.equal(D.g('selectedSquare'), null);
        D.click('b1'); D.click('g1'); // switch selection to another own piece
        assert.deepEqual(D.get('selectedSquare'), { row: 7, col: 6 });
        D.key('Escape');
        assert.equal(D.doc.querySelectorAll('.square.selected, .square.legal-move').length, 0);
        D.click('e2'); D.click('e5'); // illegal target: nothing happens
        assert.equal(D.g('gameHistory.length'), 1);
    }));

    test('new game during an animation aborts that move and releases the lock', withDom({ tweens: 'manual' }, async (D) => {
        D.setMode('human-human');
        D.click('e2'); D.click('e4');
        D.el('new-game-button').click();
        assert.equal(D.g('isAnimating'), false);
        D.tweens.flush();
        await sleep(10);
        assert.equal(D.g('gameHistory.length'), 1);
        assert.equal(D.g('currentPlayer'), 'w');
        assert.equal(D.pieceAt('e2'), 'P');
        await D.play('d2d4');
        assert.deepEqual(D.notations(), ['d4']);
    }));

    test('castling moves the rook; en passant removes the victim; notation', withDom(async (D) => {
        D.setMode('human-human');
        await D.play('e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'a6a5', 'g1f3', 'a5a4', 'f1e2', 'a4a3', 'e1g1');
        const n = D.notations();
        assert.equal(n[4], 'exd6');
        assert.equal(D.pieceAt('d5'), null);
        assert.equal(D.pieceEl('d5'), null, 'victim element removed');
        assert.equal(n[10], 'O-O');
        assert.equal(D.pieceAt('f1'), 'R');
        assert.equal(D.pieceAt('g1'), 'K');
        assert.equal(D.pieceEl('f1').dataset.piece, 'R');
        assert.deepEqual(D.get('castlingRights.w'), { K: false, Q: false });
    }));

    test('check and mate suffixes, including after promotion', withDom(async (D) => {
        D.setMode('human-human');
        D.loadPosition('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await D.play('a7a8q');
        assert.deepEqual(D.notations(), ['a8=Q+']);
        assert.ok(D.squareEl('e8').classList.contains('in-check'));
        assert.equal(D.played.at(-1), 'check.mp3');
        D.loadPosition('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
        await D.play('a1a8');
        assert.deepEqual(D.notations(), ['Ra8#']);
        assert.equal(D.g('isGameOver'), true);
        assert.equal(D.status(), 'Checkmate! White wins.');
        assert.equal(D.played.at(-1), 'game-over.mp3');
    }));
});

describe('promotion dialog', () => {
    test('locks the board, cancels via Escape/backdrop, underpromotes', withDom(async (D) => {
        D.setMode('human-human');
        D.loadPosition('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        const modal = D.el('promotion-modal');
        D.click('a7'); D.click('a8');
        assert.equal(modal.style.display, 'flex');
        assert.notEqual(D.g('pendingPromotion'), null);
        assert.equal(D.pieceAt('a7'), 'P', 'board unchanged while the dialog is open');
        assert.equal(D.pieceAt('a8'), null);

        D.click('e1'); D.click('d1');
        await sleep(20);
        assert.equal(D.pieceAt('e1'), 'K', 'other moves ignored while choosing');
        assert.equal(D.el('undo-button').disabled, true);
        assert.equal(D.el('game-mode-select').disabled, true);

        D.key('Escape');
        assert.equal(modal.style.display, 'none');
        assert.equal(D.g('pendingPromotion'), null);
        assert.equal(D.pieceAt('a7'), 'P');

        D.click('a7'); D.click('a8');
        modal.dispatchEvent(new D.w.MouseEvent('click', { bubbles: true }));
        assert.equal(D.g('pendingPromotion'), null, 'backdrop click cancels');

        D.click('a7'); D.click('a8');
        D.el('promotion-cancel').click();
        assert.equal(D.g('pendingPromotion'), null, 'cancel button cancels');

        D.click('a7'); D.click('a8');
        assert.equal(modal.querySelector('button[data-piece="N"] .promo-symbol').textContent, D.g('PIECES.N'), 'white symbols');
        modal.querySelector('button[data-piece="N"]').click();
        await D.settle();
        assert.equal(D.pieceAt('a8'), 'N');
        assert.equal(D.g('currentPlayer'), 'b');
        assert.deepEqual(D.notations(), ['a8=N']);
    }));

    test('black promotion shows black symbols', withDom(async (D) => {
        D.setMode('human-human');
        D.loadPosition('4k3/8/8/8/8/8/p7/4K3 b - - 0 1');
        D.click('a2'); D.click('a1');
        assert.equal(D.doc.querySelector('#promotion-modal button[data-piece="R"] .promo-symbol').textContent, D.g('PIECES.r'));
        D.doc.querySelector('#promotion-modal button[data-piece="R"]').click();
        await D.settle();
        assert.equal(D.pieceAt('a1'), 'r');
        assert.deepEqual(D.notations(), ['a1=R+']);
    }));

    test('AI underpromotion is applied without the dialog', withDom(async (D) => {
        D.loadPosition('4k3/8/8/8/8/8/p7/4K3 b - - 0 1');
        D.g('checkAndTriggerAIMove()');
        await D.waitFor(() => D.aiCalls().length === 1, { message: 'AI request' });
        D.aiCalls()[0].resolve(move({ row: 6, col: 0 }, { row: 7, col: 0 }, { piece: 'p', isPromotion: true, promotionPiece: 'R' }));
        await D.waitFor(() => D.g('gameHistory.length') === 2);
        await D.settle();
        assert.equal(D.pieceAt('a1'), 'r');
        assert.match(D.notations()[0], /^a1=R/);
        assert.equal(D.g('pendingPromotion'), null);
    }));
});

describe('board orientation', () => {
    test('White at the bottom: a8 top-left, a1 bottom-left', withDom(async (D) => {
        const squares = () => D.doc.querySelectorAll('#chess-board .square');
        assert.equal(label(squares()[0]), 'a8');
        assert.equal(label(squares()[7]), 'h8');
        assert.equal(label(squares()[56]), 'a1');
        const wk = D.doc.querySelector('.piece[data-piece="K"]');
        assert.equal(wk.style.top, '87.5%');
        assert.equal(wk.style.left, '50%');
    }));

    test('Black at the bottom: h1 top-left, a8 bottom-right, pieces mirrored without rotation', withDom(async (D) => {
        D.setMode('human-human');
        const squares = () => D.doc.querySelectorAll('#chess-board .square');
        D.el('switch-colors-button').click();
        assert.equal(label(squares()[0]), 'h1');
        assert.equal(label(squares()[56]), 'h8');
        assert.equal(label(squares()[63]), 'a8');
        assert.equal(D.el('chess-board').style.transform, '');
        const wk = D.doc.querySelector('.piece[data-piece="K"]');
        assert.equal(wk.style.top, '0%');
        assert.equal(wk.style.left, '37.5%');
        assert.equal(wk.style.transform, '');
        assert.equal(D.el('switch-colors-button').textContent, 'Play as White');
        await D.play('e2e4');
        const pawn = D.pieceEl('e4');
        assert.equal(pawn.style.top, '37.5%');
        assert.equal(pawn.style.left, '37.5%');
        assert.ok(D.squareEl('e4').classList.contains('last-move'));
        // Square colors are logical: a1 dark, h1 light.
        assert.ok(D.squareEl('a1').classList.contains('dark') && D.squareEl('h1').classList.contains('light'));
    }));
});

describe('AI orchestration (stubbed engine)', () => {
    test('human move triggers the AI; board locked while thinking; AI move applied', withDom(async (D) => {
        await D.play('e2e4');
        await D.waitFor(() => D.aiCalls().length === 1, { message: 'AI request' });
        assert.match(D.status(), /thinking/);
        assert.ok(D.el('status-message').classList.contains('thinking'));
        assert.equal(D.g('isHumanTurn()'), false);
        D.click('d2'); D.click('d4');
        assert.equal(D.g('selectedSquare'), null, 'no selection on the AI turn');
        const call = D.aiCalls()[0];
        assert.equal(call.elo, 1200);
        assert.equal(call.state.currentPlayer, 'b');
        assert.equal(call.state.positionHistory.length, 2);
        call.resolve(move({ row: 1, col: 4 }, { row: 3, col: 4 }, { piece: 'p' }));
        await D.waitFor(() => D.g('gameHistory.length') === 3);
        await D.settle();
        assert.deepEqual(D.notations(), ['e4', 'e5']);
        assert.equal(D.g('currentPlayer'), 'w');
        assert.equal(D.g('isAIThinking'), false);
    }));

    test('an illegal or empty AI result is reported, not applied', withDom(async (D) => {
        await D.play('e2e4');
        await D.waitFor(() => D.aiCalls().length === 1);
        D.aiCalls()[0].resolve(move({ row: 1, col: 4 }, { row: 4, col: 4 }, { piece: 'p' })); // e7e4
        await sleep(20);
        assert.equal(D.g('gameHistory.length'), 2);
        assert.equal(D.status(), 'AI error: returned an illegal move.');
        assert.equal(D.errors.length, 1, 'the rejected move is logged');
    }));

    test('review mode: history click cancels the AI, AI waits; resume and back to live', withDom(async (D) => {
        const calls = () => D.aiCalls();
        await D.play('e2e4');
        await D.waitFor(() => calls().length === 1);
        calls()[0].resolve(move({ row: 1, col: 4 }, { row: 3, col: 4 }, { piece: 'p' }));
        await D.waitFor(() => D.g('gameHistory.length') === 3);
        await D.settle();

        await D.play('g1f3');
        await D.waitFor(() => calls().length === 2);
        D.doc.querySelector('.move-text[data-history-index="1"]').click();
        assert.equal(calls()[1].cancelled, true);
        assert.equal(D.g('isReviewing'), true);
        assert.equal(D.g('currentMoveIndex'), 1);
        assert.equal(D.el('review-bar').hidden, false);
        assert.equal(D.el('review-label').textContent, 'Reviewing move 1. e4');
        assert.ok(D.doc.querySelector('.move-text[data-history-index="1"]').classList.contains('current-move'));
        assert.ok(D.doc.querySelector('.move-text[data-history-index="3"]').classList.contains('future-move'));
        await sleep(250);
        assert.equal(calls().length, 2, 'AI not triggered while reviewing');
        assert.deepEqual(D.notations(), ['e4', 'e5', 'Nf3']);
        assert.equal(D.el('hint-button').disabled, true, 'no hint on the AI side while reviewing');

        D.key('ArrowRight');
        assert.equal(D.g('currentMoveIndex'), 2);
        assert.equal(D.el('review-label').textContent, 'Reviewing move 1... e5');
        D.key('ArrowLeft');
        assert.equal(D.g('currentMoveIndex'), 1);

        D.el('live-button').click();
        assert.equal(D.g('isReviewing'), false);
        assert.equal(D.g('currentMoveIndex'), 3);
        await D.waitFor(() => calls().length === 3, { message: 'AI resumes at live' });
        assert.equal(calls()[2].index, 3);

        // Resume from an earlier AI-to-move position truncates the later moves.
        D.doc.querySelector('.move-text[data-history-index="1"]').click();
        assert.equal(calls()[2].cancelled, true);
        D.el('resume-button').click();
        assert.equal(D.g('gameHistory.length'), 2);
        assert.equal(D.g('isReviewing'), false);
        await D.waitFor(() => calls().length === 4);
        assert.equal(calls()[3].index, 1);
        calls()[3].resolve(move({ row: 1, col: 2 }, { row: 3, col: 2 }, { piece: 'p' }));
        await D.waitFor(() => D.g('gameHistory.length') === 3);
        await D.settle();
        assert.deepEqual(D.notations(), ['e4', 'c5']);
    }));

    test('a human move while reviewing continues from the reviewed position', withDom(async (D) => {
        D.setMode('human-human');
        await D.play('e2e4', 'e7e5', 'g1f3');
        D.doc.querySelector('.move-text[data-history-index="2"]').click();
        assert.equal(D.g('isReviewing'), true);
        await D.play('b1c3');
        assert.equal(D.g('isReviewing'), false);
        assert.deepEqual(D.notations(), ['e4', 'e5', 'Nc3']);
    }));

    test('undo/redo in AI mode land on the human turn and never trigger the AI', withDom(async (D) => {
        const calls = () => D.aiCalls();
        for (const [human, ai] of [['e2e4', [1, 4, 3, 4]], ['g1f3', [0, 1, 2, 2]]]) {
            await D.play(human);
            await D.waitFor(() => calls().length === (human === 'e2e4' ? 1 : 2));
            calls().at(-1).resolve(move({ row: ai[0], col: ai[1] }, { row: ai[2], col: ai[3] }));
            await D.waitFor(() => !D.g('isAIThinking') && !D.g('isAnimating') && D.g('currentPlayer') === 'w');
        }
        assert.deepEqual(D.notations(), ['e4', 'e5', 'Nf3', 'Nc6']);
        D.el('undo-button').click();
        assert.equal(D.g('currentMoveIndex'), 2);
        assert.equal(D.g('currentPlayer'), 'w');
        D.el('undo-button').click();
        assert.equal(D.g('currentMoveIndex'), 0);
        assert.equal(D.el('undo-button').disabled, true);
        await sleep(250);
        assert.equal(calls().length, 2, 'no AI request after undo');
        D.el('redo-button').click();
        assert.equal(D.g('currentMoveIndex'), 2);
        D.el('redo-button').click();
        assert.equal(D.g('currentMoveIndex'), 4);
        assert.equal(D.g('isReviewing'), false);
        assert.equal(D.el('redo-button').disabled, true);
        // Undo while the AI is thinking cancels it.
        await D.play('f1c4');
        await D.waitFor(() => calls().length === 3);
        D.el('undo-button').click();
        assert.equal(calls()[2].cancelled, true);
        assert.equal(D.g('currentMoveIndex'), 4);
        assert.equal(D.g('isAIThinking'), false);
    }));

    test('new game cancels the AI and ignores its late result', withDom(async (D) => {
        await D.play('e2e4');
        await D.waitFor(() => D.aiCalls().length === 1);
        const stale = D.aiCalls()[0];
        D.el('new-game-button').click();
        assert.equal(stale.cancelled, true);
        stale.resolve(move({ row: 1, col: 3 }, { row: 3, col: 3 }, { piece: 'p' }));
        await sleep(50);
        assert.equal(D.g('gameHistory.length'), 1);
        assert.equal(D.pieceAt('d7'), 'p');
        assert.equal(D.g('isAIThinking'), false);
    }));

    test('playing as Black makes the AI open; mode change mid-animation keeps the lock sane', withDom(async (D) => {
        await sleep(200);
        assert.equal(D.aiCalls().length, 0, 'no AI move at the start as White');
        D.el('switch-colors-button').click();
        await D.waitFor(() => D.aiCalls().length === 1);
        assert.equal(D.aiCalls()[0].state.currentPlayer, 'w');
        D.aiCalls()[0].resolve(move({ row: 6, col: 3 }, { row: 4, col: 3 }, { piece: 'P' }));
        await D.waitFor(() => D.g('gameHistory.length') === 2);
        await D.settle();
        assert.equal(D.g('isHumanTurn()'), true);
        D.click('d7'); D.click('d5');
        D.setMode('human-human');
        await D.settle();
        assert.deepEqual(D.notations(), ['d4', 'd5']);
        assert.equal(D.aiCalls().length, 1);
        assert.equal(D.g('isAIThinking'), false);
    }));

    test('ELO slider: label on input, applied on change, restarts a pending AI request', withDom(async (D) => {
        const s = D.el('ai-elo-slider');
        s.value = '1800';
        s.dispatchEvent(new D.w.Event('input'));
        assert.equal(D.el('ai-elo-value').textContent, '1800');
        assert.equal(D.g('aiElo'), 1200, 'not applied until change');
        s.dispatchEvent(new D.w.Event('change'));
        assert.equal(D.g('aiElo'), 1800);
        assert.equal(s.value, '1800');
        await D.play('e2e4');
        await D.waitFor(() => D.aiCalls().length === 1);
        assert.equal(D.aiCalls()[0].elo, 1800);
        D.setElo(600);
        await D.waitFor(() => D.aiCalls().length === 2);
        assert.equal(D.aiCalls()[0].cancelled, true);
        assert.equal(D.aiCalls()[1].elo, 600);
        assert.match(D.status(), /ELO: 600/);
        D.setMode('human-human');
        assert.equal(s.disabled, true, 'slider disabled without an AI');
    }));

    test('hint: requested at max strength with a time budget, highlighted, then cleared', withDom(async (D) => {
        D.el('hint-button').click();
        const calls = D.aiCalls();
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.timeMs, 1500);
        assert.equal(calls[0].elo, 2500);
        assert.equal(D.el('hint-button').disabled, true);
        assert.equal(D.status(), 'Thinking of a hint...');
        calls[0].resolve(move({ row: 6, col: 4 }, { row: 4, col: 4 }, { piece: 'P' }));
        await sleep(10);
        assert.match(D.status(), /^Hint: Try .* from e2 to e4\.$/);
        assert.ok(D.squareEl('e2').classList.contains('hint-from') && D.squareEl('e4').classList.contains('hint-to'));
        await D.play('d2d4'); // moving clears the hint
        assert.equal(D.doc.querySelectorAll('.hint-from, .hint-to').length, 0);
        assert.doesNotMatch(D.status(), /Hint/);
    }));

    test('hint request is cancelled by navigation and its result ignored', withDom(async (D) => {
        D.setMode('human-human');
        await D.play('e2e4');
        D.el('hint-button').click();
        const call = D.aiCalls()[0];
        D.key('ArrowLeft');
        assert.equal(call.cancelled, true);
        call.resolve(move({ row: 1, col: 4 }, { row: 3, col: 4 }));
        await sleep(10);
        assert.equal(D.doc.querySelectorAll('.hint-from').length, 0);
        assert.equal(D.el('hint-button').disabled, false);
    }));
});

describe('game over and draws', () => {
    test('fool\'s mate; game over state follows history navigation', withDom(async (D) => {
        D.setMode('human-human');
        await D.play('f2f3', 'e7e5', 'g2g4', 'd8h4');
        assert.equal(D.notations()[3], 'Qh4#');
        assert.equal(D.g('isGameOver'), true);
        assert.equal(D.turn(), 'Game Over');
        assert.equal(D.el('hint-button').disabled, true);
        D.click('a2'); D.click('a3');
        assert.equal(D.g('gameHistory.length'), 5, 'no moves after mate');
        D.key('ArrowLeft');
        assert.equal(D.g('isGameOver'), false);
        assert.equal(D.turn(), 'Turn: Black');
        assert.equal(D.el('resume-button').disabled, false);
        D.key('ArrowRight');
        assert.equal(D.g('isGameOver'), true);
        assert.match(D.status(), /^Checkmate! Black wins\./);
    }));

    test('stalemate, 50-move rule, insufficient material, threefold repetition', withDom(async (D) => {
        D.setMode('human-human');
        D.loadPosition('7k/8/5Q2/6K1/8/8/8/8 w - - 0 1');
        await D.play('f6f7');
        assert.equal(D.status(), 'Stalemate! Game is a draw.');

        D.loadPosition('4k3/8/8/8/8/8/8/R3K3 w - - 99 80');
        await D.play('a1a2');
        assert.equal(D.status(), 'Draw by 50-move rule.');
        assert.equal(D.g('isGameOver'), true);

        D.loadPosition('4k3/8/8/8/8/8/1n6/2B1K3 w - - 0 1');
        await D.play('c1b2');
        assert.equal(D.status(), 'Draw by insufficient material.');

        D.loadPosition('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
        await D.play('a1a2', 'e8d8', 'a2a1', 'd8e8', 'a1a2', 'e8d8', 'a2a1');
        assert.equal(D.g('isGameOver'), false, 'second occurrence');
        await D.play('d8e8');
        assert.equal(D.status(), 'Draw by threefold repetition.');
    }));

    test('a capture at halfmove 99 resets the clock (no 50-move draw)', withDom(async (D) => {
        D.setMode('human-human');
        D.loadPosition('4k3/8/8/8/8/8/r7/R3K3 w - - 99 80');
        await D.play('a1a2');
        assert.equal(D.g('halfmoveClock'), 0);
        assert.equal(D.g('isGameOver'), false);
        assert.equal(D.status(), "Black's turn.");
    }));
});

describe('capture hook', () => {
    test('playCaptureAnimation gets attacker, victim, square and ctx; sound flag respected', withDom(async (D) => {
        D.setMode('human-human');
        D.g(`window.__hook = [];
             window.__hookReturns = false;
             const __origCapture = playCaptureAnimation;
             playCaptureAnimation = (a, v, sq, ctx) => {
                 __hook.push({ a, v, sq: sq.querySelector('.coordinate-label').textContent, ...ctx });
                 return __origCapture(a, v, sq, ctx).then(() => __hookReturns);
             };`);
        await D.play('e2e4', 'e7e5', 'f1c4', 'a7a6', 'c4f7');
        let hook = D.get('__hook');
        assert.deepEqual(hook, [{ a: 'B', v: 'p', sq: 'f7', enPassant: false, promotionTo: null, givesCheck: true, isMate: false, isAI: false }]);
        assert.equal(D.played.at(-1), 'check.mp3', 'check sound wins over capture sound');

        await D.play('e8f7');
        assert.equal(D.played.at(-1), 'capture.mp3', 'hook returned false: capture.mp3 plays');
        const before = D.played.length;
        D.g('__hookReturns = true;');
        await D.play('d1h5', 'g7g6', 'h5e5'); // Qh5+ g6 Qxe5 (capture without check)
        assert.deepEqual(D.played.slice(before), ['check.mp3', 'move.mp3'], 'hook played the capture sound: no capture.mp3');
        assert.equal(D.notations().at(-1), 'Qxe5');

        // En passant and promotion-capture contexts.
        D.g('__hookReturns = false; __hook = [];');
        D.loadPosition('1n2k3/P7/8/3pP3/8/8/8/4K3 w - d6 0 2');
        await D.play('e5d6');
        D.loadPosition('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 2');
        await D.play('a7b8q');
        hook = D.get('__hook');
        assert.equal(hook[0].enPassant, true);
        assert.equal(hook[0].sq, 'd5', 'en passant victim square');
        assert.equal(hook[1].promotionTo, 'Q');
        assert.equal(hook[1].givesCheck, true);
        assert.equal(hook[1].v, 'n');
    }));

    test('isAI is set for AI captures', withDom(async (D) => {
        D.g(`window.__hook = []; const __orig = playCaptureAnimation;
             playCaptureAnimation = (a, v, sq, ctx) => { __hook.push(ctx.isAI); return __orig(a, v, sq, ctx); };`);
        await D.play('e2e4');
        await D.waitFor(() => D.aiCalls().length === 1);
        D.aiCalls()[0].resolve(move({ row: 1, col: 3 }, { row: 3, col: 3 }));
        await D.waitFor(() => D.g('gameHistory.length') === 3);
        await D.settle();
        await D.play('e4d5');
        await D.waitFor(() => D.aiCalls().length === 2);
        D.aiCalls()[1].resolve(move({ row: 0, col: 3 }, { row: 3, col: 3 }));
        await D.waitFor(() => D.g('gameHistory.length') === 5);
        await D.settle();
        assert.deepEqual(D.get('__hook'), [false, true]);
        assert.deepEqual(D.notations(), ['e4', 'd5', 'exd5', 'Qxd5']);
    }));

    test('a stalled capture animation is resolved by the timeout', withDom(async (D) => {
        D.setMode('human-human');
        await D.play('e2e4', 'd7d5');
        D.g(`const __realTo = gsap.to; gsap.to = (el, vars) => ('opacity' in vars) ? {} : __realTo(el, vars);`);
        D.click('e4'); D.click('d5');
        await sleep(300);
        assert.equal(D.g('isAnimating'), true, 'still waiting on the capture');
        await D.waitFor(() => !D.g('isAnimating'), { timeout: 2000, message: 'capture timeout' });
        assert.equal(D.notations()[2], 'exd5');
        assert.equal(D.pieceEl('d5').dataset.piece, 'P');
        assert.equal(D.doc.querySelectorAll('.piece').length, 31);
    }));
});

describe('sound toggle', () => {
    test('mute stops sounds', withDom(async (D) => {
        D.setMode('human-human');
        D.el('mute-button').click();
        assert.equal(D.el('mute-button').textContent, 'Unmute Sounds');
        await D.play('e2e4');
        assert.deepEqual(D.played, []);
        D.el('mute-button').click();
        await D.play('e7e5');
        assert.deepEqual(D.played, ['move.mp3']);
    }));
});

describe('real engine (aiClient main-thread fallback)', () => {
    test('AI replies, hint works, cancel on navigation never applies a move', withDom({ realClient: true }, async (D) => {
        D.setElo(800);
        await D.play('e2e4');
        await D.waitFor(() => D.g('gameHistory.length') === 3 && !D.g('isAIThinking') && !D.g('isAnimating'), { timeout: 5000, message: 'AI reply' });
        assert.equal(D.g('currentPlayer'), 'w');

        D.el('hint-button').click();
        await D.waitFor(() => /^Hint: Try/.test(D.status()), { timeout: 5000, message: 'hint' });
        assert.equal(D.doc.querySelectorAll('.hint-from').length, 1);

        await D.play('d2d4');
        await D.waitFor(() => D.g('isAIThinking'));
        D.doc.querySelector('.move-text[data-history-index="1"]').click();
        await sleep(1500);
        assert.equal(D.g('gameHistory.length'), 4);
        assert.equal(D.g('currentMoveIndex'), 1);
        assert.equal(D.g('isReviewing'), true);
        assert.deepEqual(D.errors, []);
    }));

    test('AI vs AI progresses, and stops when switching to human-human', withDom({ realClient: true }, async (D) => {
        D.setElo(300);
        D.setMode('ai-ai');
        assert.equal(D.el('switch-colors-button').disabled, true);
        await D.waitFor(() => D.g('gameHistory.length') >= 7, { timeout: 15000, message: '6 AI plies' });
        D.setMode('human-human');
        await D.settle();
        const len = D.g('gameHistory.length');
        await sleep(800);
        assert.equal(D.g('gameHistory.length'), len, 'no AI moves after leaving AI vs AI');
        assert.equal(D.g('isAIThinking'), false);
        // Every recorded move is legal: replay them with the rules engine.
        const ok = D.g(`(() => {
            const final = getBoardPositionString(gameHistory[gameHistory.length - 1]);
            loadGameStateSnapshot(gameHistory[0]);
            for (let i = 1; i < gameHistory.length; i++) {
                const m = gameHistory[i].lastMove;
                const moved = gameHistory[i - 1].board[m.from.row][m.from.col];
                const promo = moved.toUpperCase() === 'P' && (m.to.row === 0 || m.to.row === 7)
                    ? gameHistory[i].board[m.to.row][m.to.col].toUpperCase() : null;
                if (!ChessAI.applyMoveToGlobals({ ...m, isPromotion: !!promo, promotionPiece: promo })) return 'illegal at ' + i;
                if (getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) !== getBoardPositionString(gameHistory[i])) return 'mismatch at ' + i;
            }
            loadGameStateSnapshot(gameHistory[gameHistory.length - 1]);
            return getBoardPositionString(gameHistory[gameHistory.length - 1]) === final;
        })()`);
        assert.equal(ok, true);
        assert.deepEqual(D.errors, []);
    }));

    test('a full scripted game logs no console errors', withDom({ realClient: true }, async (D) => {
        D.setMode('human-human');
        // Castling both sides, en passant, promotion, captures, checks; then review, undo/redo.
        await D.play('e2e4', 'd7d5', 'e4e5', 'f7f5', 'e5f6', 'g8f6', 'g1f3', 'c8g4', 'f1e2', 'b8c6',
            'e1g1', 'd8d6', 'd2d4', 'e8c8', 'c2c4', 'd5c4', 'b2b4', 'c4c3', 'b4b5', 'c3c2', 'b5c6', 'c2b1r');
        const n = D.notations();
        assert.equal(n[4], 'exf6');
        assert.equal(n[10], 'O-O');
        assert.equal(n[13], 'O-O-O');
        assert.equal(n[21], 'cxb1=R');
        D.key('ArrowLeft'); D.key('ArrowLeft'); D.key('ArrowRight');
        D.el('undo-button').click();
        D.el('redo-button').click();
        D.el('live-button').click();
        await D.play('a1b1');
        D.setMode('ai-human');
        await D.waitFor(() => D.g('gameHistory.length') === 25 && !D.g('isAIThinking') && !D.g('isAnimating'), { timeout: 8000, message: 'AI reply' });
        D.el('new-game-button').click();
        await sleep(50);
        assert.deepEqual(D.errors, []);
        assert.deepEqual(D.warnings, []);
    }));
});
