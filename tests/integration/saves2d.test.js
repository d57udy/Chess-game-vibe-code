'use strict';
// Save / Load on the real 2D page (2d.html + ui.js in jsdom, every script of the page):
//   - autosave after every move, then the page is opened again with the same storage: identical FEN,
//     identical offered moves, mode, side and AI strength; also while an earlier position was shown;
//     New Game clears it; corrupt data gives a new game with a short notice;
//   - the Save / Load panel with real keyboard focus: dialog, tabs, Tab cycle, Escape, focus return;
//     save, load (asks when the current game is not saved), rename, delete;
//   - export of the user's reported game, played by clicks, equals the reference PGN; copy, share and
//     download fallbacks;
//   - import: the PGN gives the final position back; an illegal move is rejected with its move number
//     and nothing changes, not even the status wording; stepping through a loaded game; AI games.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { Chess, USER_GAME_MOVETEXT, USER_GAME_UCI, USER_GAME_FEN, load2dPage, referencePgn, pgnDate } = require('../helpers/saveGameHarness');

// White can only castle queenside (the h-rook moved), Black only kingside; ...d5 has just passed the e5 pawn
const MID_GAME = ['e2e4', 'a7a5', 'e4e5', 'a8a6', 'h2h4', 'a6a8', 'h1h3', 'g8f6', 'h3h1', 'f6g8', 'g1f3', 'd7d5'];
const MID_FEN = 'rnbqkbnr/1pp1pppp/8/p2pP3/7P/5N2/PPPP1PP1/RNBQKB1R w Qk d6 0 7';
const AUTOSAVE = 'chess.autosave.2d';

// The page, opened with the given localStorage content; `mode` is chosen like a player would
async function openPage({ storage = {}, mode = null, ...options } = {}) {
    const D = await load2dPage({ ...options, setup(w) { for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v); } });
    if (mode) D.setMode(mode);
    const $ = (id) => D.el(id);
    Object.assign(D, {
        $,
        fen: () => D.g('battle3dFen()'),
        stored: (key = AUTOSAVE) => JSON.parse(D.w.localStorage.getItem(key) || 'null'),
        // Squares highlighted after clicking a piece ("x" marks captures)
        offered(name) {
            D.key('Escape');
            D.click(name);
            const marks = [...D.doc.querySelectorAll('#chess-board .square.legal-move, #chess-board .square.capture-move')];
            const out = marks.map((sq) => `${String.fromCharCode(97 + Number(sq.dataset.col))}${8 - Number(sq.dataset.row)}${sq.classList.contains('capture-move') ? 'x' : ''}`).sort();
            D.key('Escape');
            return out;
        },
        // The moves as listed, without the on-screen "e.p." mark of an en passant capture (display only)
        moveList: () => [...$('move-history').querySelectorAll('.move-text')].map((m) => m.textContent.replace(/\s*e\.p\.$/, '')),
        panelOpen: () => !$('save-modal').hidden,
        say: () => $('save-status').textContent,
        names: () => [...$('save-list').querySelectorAll('.save-item-name')].map((n) => n.textContent),
        act(name, action) {
            const li = [...$('save-list').querySelectorAll('.save-item')].find((i) => i.querySelector('.save-item-name')?.textContent === name);
            return li.querySelector(`[data-action="${action}"]`);
        },
        type(el, text) { el.value = text; el.dispatchEvent(new D.w.Event('input', { bubbles: true })); },
        press(el, key, init = {}) { const e = new D.w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }); el.dispatchEvent(e); return e; },
        open(which = 'saves') {
            const opener = $(which === 'export' ? 'export-open' : 'save-open');
            opener.focus();
            opener.click();
            assert.ok(!$('save-modal').hidden, 'the panel opens');
            if (which === 'import') $('save-tab-import').click();
            return opener;
        },
        saveAs(name) { D.type($('save-name'), name); $('save-submit').click(); },
        async idle() { await D.settle(); await D.sleep(2); },
    });
    return D;
}
const shown = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (e.hidden) return false; return !!el; };
const tick = () => new Promise((r) => setImmediate(r));

describe('2D autosave and resume (the page is opened again with the same storage)', () => {
    test('a game played by clicks comes back: identical FEN and offered moves, same mode', async () => {
        const A = await openPage({ mode: 'human-human' });
        assert.equal(A.w.localStorage.getItem(AUTOSAVE), null, 'nothing is stored for an untouched new game');
        await A.play(MID_GAME);
        await A.idle();
        assert.equal(A.fen(), MID_FEN);
        assert.deepEqual(A.stored().moves, MID_GAME);
        assert.deepEqual({ v: A.stored().v, view: A.stored().view, mode: A.stored().mode }, { v: 1, view: '2d', mode: 'human-human' });
        const pawn = A.offered('e5'), king = A.offered('e1'), blackKing = A.offered('e8');
        assert.deepEqual(pawn, ['d6x', 'e6'], 'en passant on d6 is offered');

        const B = await openPage({ storage: A.storage() });
        assert.equal(B.fen(), MID_FEN, 'identical FEN: en passant square, castling rights, clocks');
        assert.deepEqual(B.moveList(), ['e4', 'a5', 'e5', 'Ra6', 'h4', 'Ra8', 'Rh3', 'Nf6', 'Rh1', 'Ng8', 'Nf3', 'd5']);
        assert.deepEqual(B.offered('e5'), pawn, 'identical offered moves');
        assert.deepEqual(B.offered('e1'), king);
        assert.deepEqual(B.offered('e8'), blackKing);
        assert.equal(B.$('game-mode-select').value, 'human-human', 'the mode comes back with the game');
        assert.equal(B.status(), "White's turn.");
        assert.equal(B.doc.getElementById('save-notice'), null, 'no notice when the resume worked');
        assert.equal(B.doc.querySelectorAll('#chess-board .piece').length, 32);
        assert.deepEqual(B.errors, []);

        // Play on: en passant, and the autosave follows
        await B.play('e5d6');
        await B.idle();
        assert.equal(B.pieceAt('d5'), null, 'the passed pawn is gone');
        assert.deepEqual(B.stored().moves, [...MID_GAME, 'e5d6']);
        assert.equal(B.stored().san[12], 'exd6');
        A.close(); B.close();
    });

    test('mode, side and AI strength come back; the AI is asked for its move after the restart', async () => {
        const A = await openPage();
        A.setElo(1700);
        A.el('switch-colors-button').click(); // play Black: the AI opens
        await A.waitFor(() => A.aiCalls().length === 1, { message: 'AI request' });
        A.aiCalls()[0].resolve({ from: { row: 6, col: 4 }, to: { row: 4, col: 4 } });
        await A.sleep(2);
        await A.idle();
        await A.play('c7c5');
        await A.idle();
        assert.deepEqual({ moves: A.stored().moves, mode: A.stored().mode, humanColor: A.stored().humanColor, elo: A.stored().elo },
            { moves: ['e2e4', 'c7c5'], mode: 'human-ai', humanColor: 'b', elo: 1700 });

        const B = await openPage({ storage: A.storage() });
        assert.equal(B.fen().split(' ')[1], 'w');
        assert.equal(B.$('game-mode-select').value, 'ai-human');
        assert.equal(B.$('ai-elo-slider').value, '1700');
        assert.equal(B.el('player-color-indicator').textContent, 'Playing as: Black');
        assert.equal(B.doc.querySelector('#chess-board .square').dataset.row, '7', 'the board is turned for Black');
        await B.waitFor(() => B.aiCalls().some((c) => !c.cancelled && c.elo === 1700), { message: 'AI request after the restart' });
        const call = B.aiCalls().filter((c) => !c.cancelled).pop();
        assert.equal(call.state.currentPlayer, 'w');
        call.resolve({ from: { row: 7, col: 6 }, to: { row: 5, col: 5 } });
        await B.sleep(2);
        await B.idle();
        assert.deepEqual(B.moveList(), ['e4', 'c5', 'Nf3']);
        assert.deepEqual(B.errors, []);
        A.close(); B.close();
    });

    test('an earlier position that was being looked at comes back as that position, with the later moves kept', async () => {
        const A = await openPage({ mode: 'human-human' });
        await A.play('e2e4', 'e7e5', 'g1f3', 'b8c6');
        await A.idle();
        A.key('ArrowLeft');
        A.key('ArrowLeft');
        await A.idle();
        assert.deepEqual({ moves: A.stored().moves.length, cursor: A.stored().cursor }, { moves: 4, cursor: 2 });
        const B = await openPage({ storage: A.storage() });
        assert.equal(B.get('currentMoveIndex'), 2);
        assert.equal(B.fen().split(' ')[0], 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
        assert.equal(B.el('review-bar').hidden, false, 'in review, like before');
        assert.equal(B.moveList().length, 4, 'the later moves are still there');
        assert.equal(B.el('redo-button').disabled, false);
        B.el('redo-button').click();
        B.el('redo-button').click();
        await B.idle();
        assert.equal(B.get('currentMoveIndex'), 4);
        assert.equal(B.stored().cursor, undefined, 'back at the end: no cursor stored');
        A.close(); B.close();
    });

    test('a finished game comes back finished; New Game clears the autosave', async () => {
        const A = await openPage({ mode: 'human-human' });
        await A.play('f2f3', 'e7e5', 'g2g4', 'd8h4');
        await A.idle();
        assert.equal(A.stored().result, '0-1');
        const B = await openPage({ storage: A.storage() });
        assert.match(B.status(), /Checkmate! Black wins\./);
        assert.equal(B.turn(), 'Game Over');
        B.el('new-game-button').click();
        await B.idle();
        assert.equal(B.w.localStorage.getItem(AUTOSAVE), null);
        const C = await openPage({ storage: B.storage() });
        assert.deepEqual(C.moveList(), []);
        A.close(); B.close(); C.close();
    });

    test('corrupt, other-version and unplayable autosaves: a new game and a short notice, never a broken page', async () => {
        const good = { v: 1, view: '2d', mode: 'human-human', humanColor: 'w', elo: 1200, startFen: null, moves: ['e2e4', 'e7e5'], san: ['e4', 'e5'], result: '*', savedAt: 1, startedAt: 1 };
        const cases = {
            'not JSON': '{"v":1,"moves":["e2',
            'older format': JSON.stringify({ ...good, v: 0 }),
            'newer format': JSON.stringify({ ...good, v: 3 }),
            'illegal move': JSON.stringify({ ...good, moves: ['e2e4', 'e7e5', 'e4e5'], san: ['e4', 'e5', 'e5'] }),
        };
        for (const [name, raw] of Object.entries(cases)) {
            const A = await openPage({ storage: { [AUTOSAVE]: raw, 'chess.saves': '{{{' } });
            assert.equal(A.fen(), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', name);
            assert.equal(A.el('save-notice').textContent, 'Your saved game could not be read, so a new game was started.', name);
            assert.equal(A.el('save-notice').hidden, false, name);
            assert.equal(A.status(), "White's turn.", `2D wording after a failed restore: ${name}`);
            A.setMode('human-human');
            await A.play('d2d4');
            await A.idle();
            assert.deepEqual(A.stored().moves, ['d2d4'], `playable and autosaving after: ${name}`);
            A.open();
            assert.match(A.$('save-count').textContent, /Older saves could not be read and were set aside/, name);
            assert.deepEqual(A.errors, [], name);
            A.close();
        }
    });
});

describe('2D Save / Load panel', () => {
    test('a modal dialog: focus goes in, Tab stays inside, arrows switch tabs, Escape closes and returns the focus', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        await D.play('e2e4', 'e7e5');
        await D.idle();
        const opener = D.open();
        const card = $('save-modal').querySelector('[role="dialog"]');
        assert.equal(card.getAttribute('aria-modal'), 'true');
        assert.equal(card.getAttribute('aria-labelledby'), 'save-title');
        assert.equal(D.doc.activeElement, $('save-title'), 'focus moves into the dialog');
        for (const field of card.querySelectorAll('input:not([type="file"]), textarea')) {
            assert.ok(card.querySelector(`label[for="${field.id}"]`) || field.getAttribute('aria-label'), `${field.id} has a label`);
        }
        for (const b of card.querySelectorAll('button')) assert.ok((b.textContent.trim() || b.getAttribute('aria-label')), 'every button has a name');

        // Tab cycle: forward from the last control, backward from the first
        const focusable = [...card.querySelectorAll('button, input, textarea')].filter((n) => shown(n) && !n.disabled && n.tabIndex !== -1);
        const first = focusable[0], last = focusable[focusable.length - 1];
        assert.equal(first, $('save-close'));
        last.focus();
        assert.equal(D.press(last, 'Tab').defaultPrevented, true);
        assert.equal(D.doc.activeElement, first);
        assert.equal(D.press(first, 'Tab', { shiftKey: true }).defaultPrevented, true);
        assert.equal(D.doc.activeElement, last);
        $('save-name').focus();
        assert.equal(D.press($('save-name'), 'Tab').defaultPrevented, false, 'Tab in the middle is the browser\'s');

        // Tabs: roving tabindex, arrow keys
        const tabs = ['saves', 'export', 'import'].map((k) => $(`save-tab-${k}`));
        assert.deepEqual(tabs.map((t) => t.tabIndex), [0, -1, -1]);
        tabs[0].focus();
        D.press(tabs[0], 'ArrowRight');
        assert.equal(D.doc.activeElement, tabs[1]);
        assert.deepEqual(tabs.map((t) => t.getAttribute('aria-selected')), ['false', 'true', 'false']);
        assert.deepEqual([$('save-pane-saves').hidden, $('save-pane-export').hidden, $('save-pane-import').hidden], [true, false, true]);
        assert.equal($('save-pane-export').getAttribute('aria-labelledby'), 'save-tab-export');
        D.press(tabs[1], 'ArrowRight');
        D.press(tabs[2], 'ArrowRight');
        assert.equal(D.doc.activeElement, tabs[0], 'wraps around');
        D.press(tabs[0], 'ArrowLeft');
        assert.equal(D.doc.activeElement, tabs[2]);
        D.press(tabs[2], 'Home');
        assert.equal(D.doc.activeElement, tabs[0]);
        assert.equal(D.get('currentMoveIndex'), 2, 'the arrow keys did not step through the game behind the dialog');

        D.press(D.doc.activeElement, 'Escape');
        assert.equal(D.panelOpen(), false);
        assert.equal(D.doc.activeElement, opener, 'focus returns to the button that opened it');

        // Focus lost to the page behind (it should not happen): Tab comes back in, Escape still closes
        D.open();
        D.doc.activeElement.blur();
        assert.equal(D.press(D.doc.body, 'Tab').defaultPrevented, true);
        assert.equal(D.doc.activeElement, $('save-close'));
        D.doc.activeElement.blur();
        D.press(D.doc.body, 'Escape');
        assert.equal(D.panelOpen(), false);

        // The backdrop closes it too; the Export button opens the export tab ready to copy
        D.open();
        $('save-modal').dispatchEvent(new D.w.MouseEvent('click', { bubbles: true }));
        assert.equal(D.panelOpen(), false);
        const exportOpener = D.open('export');
        assert.equal($('save-tab-export').getAttribute('aria-selected'), 'true');
        assert.equal(D.doc.activeElement, $('save-copy'));
        $('save-close').click();
        assert.equal(D.doc.activeElement, exportOpener);
        assert.deepEqual(D.errors, []);
        D.close();
    });

    test('save, new game, load (asks when the current game is not saved), replace, rename, delete', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        D.open();
        assert.equal($('save-submit').disabled, true, 'nothing to save before the first move');
        assert.match($('save-count').textContent, /No moves yet/);
        $('save-close').click();
        await D.play('e2e4', 'c7c5', 'g1f3');
        await D.idle();
        const fen = D.fen();
        D.open();
        assert.match($('save-name').value, /^\d{1,2} [A-Z][a-z]{2}, 2 players$/, 'default name: date plus opponent');
        D.saveAs('Sicilian');
        assert.equal(D.say(), 'Saved as "Sicilian".');
        assert.deepEqual(D.names(), ['Sicilian']);
        assert.match($('save-list').querySelector('.save-item-meta').textContent, /^\d{1,2} [A-Z][a-z]{2} \d{4}, 2 moves, in progress$/);
        assert.equal(D.stored('chess.saves').saves[0].view, '2d');
        $('save-close').click();

        D.el('new-game-button').click();
        await D.idle();
        await D.play('d2d4');
        await D.idle();
        D.open();
        D.act('Sicilian', 'load').click();
        assert.equal(shown($('save-confirm')), true);
        assert.match($('save-confirm-text').textContent, /Your current game is not saved\. Leave it and load "Sicilian"\?/);
        assert.equal(D.doc.activeElement, $('save-confirm-no'), 'Cancel has the focus');
        D.press($('save-confirm-no'), 'Escape');
        assert.equal(shown($('save-confirm')), false, 'Escape cancels the question, not the dialog');
        assert.ok(D.panelOpen());
        assert.equal(D.doc.activeElement, D.act('Sicilian', 'load'), 'focus goes back to the button that asked');
        assert.deepEqual(D.moveList(), ['d4']);
        D.act('Sicilian', 'load').click();
        $('save-confirm-yes').click();
        assert.equal(D.panelOpen(), false);
        assert.equal(D.fen(), fen);
        assert.deepEqual(D.moveList(), ['e4', 'c5', 'Nf3']);
        assert.equal(D.el('save-notice').textContent, 'Loaded "Sicilian".');
        assert.equal(D.status(), "Black's turn.");
        assert.deepEqual(D.stored().moves, ['e2e4', 'c7c5', 'g1f3']);

        D.open();
        D.act('Sicilian', 'load').click();
        assert.equal(D.panelOpen(), false, 'no question when the game on the board is already saved');

        await D.play('d7d6');
        await D.idle();
        D.open();
        D.saveAs('sicilian');
        assert.match($('save-confirm-text').textContent, /A save named "Sicilian" exists\. Replace it with this game\?/);
        $('save-confirm-yes').click();
        assert.equal(D.stored('chess.saves').saves.length, 1);
        assert.equal(D.stored('chess.saves').saves[0].moves.length, 4);

        D.act('sicilian', 'rename').click();
        const input = $('save-list').querySelector('.save-rename');
        assert.equal(D.doc.activeElement, input);
        D.type(input, 'Najdorf plans');
        D.press(input, 'Enter');
        assert.deepEqual(D.names(), ['Najdorf plans']);
        assert.equal(D.doc.activeElement, D.act('Najdorf plans', 'rename'));

        D.act('Najdorf plans', 'delete').click();
        assert.match($('save-confirm-text').textContent, /Delete the save "Najdorf plans"\? This cannot be undone\./);
        $('save-confirm-no').click();
        assert.deepEqual(D.names(), ['Najdorf plans']);
        D.act('Najdorf plans', 'delete').click();
        $('save-confirm-yes').click();
        assert.deepEqual(D.names(), []);
        assert.equal($('save-empty').hidden, false);
        assert.deepEqual(D.errors, []);
        D.close();
    });

    test('saves are shared between the views: a 3D save loads in 2D with its settings', async () => {
        const save = { v: 1, id: 's3d', name: 'From the 3D game', view: '3d', mode: 'human-ai', humanColor: 'b', elo: 2000, startFen: null,
            moves: ['d2d4', 'g8f6', 'c2c4'], san: ['d4', 'Nf6', 'c4'], result: '*', savedAt: Date.now(), startedAt: Date.now() };
        const D = await openPage({ mode: 'human-human', storage: { 'chess.saves': JSON.stringify({ v: 1, saves: [save] }) } });
        D.open();
        D.act('From the 3D game', 'load').click();
        assert.deepEqual(D.moveList(), ['d4', 'Nf6', 'c4']);
        assert.equal(D.$('game-mode-select').value, 'ai-human');
        assert.equal(D.$('ai-elo-slider').value, '2000');
        assert.equal(D.el('player-color-indicator').textContent, 'Playing as: Black');
        assert.equal(D.fen().split(' ')[1], 'b', 'Black, the human, is to move');
        await D.sleep(150);
        assert.equal(D.aiCalls().filter((c) => !c.cancelled).length, 0, 'the AI does not move for the human');
        assert.deepEqual(D.errors, []);
        D.close();
    });

    test('the panel does not open while a move is animating', async () => {
        const D = await openPage({ mode: 'human-human', tweens: 'manual' });
        D.click('e2');
        D.click('e4');
        assert.equal(D.g('isAnimating'), true);
        D.el('save-open').click();
        assert.equal(D.panelOpen(), false);
        assert.equal(D.el('save-notice').textContent, 'Wait until the move has finished, then try again.');
        assert.equal(D.w.SaveHost.load({ v: 1, moves: ['d2d4'] }).ok, false, 'and nothing can be loaded over a half-made move');
        await D.settle();
        D.el('save-open').click();
        assert.equal(D.panelOpen(), true);
        D.close();
    });
});

describe("2D export and import (the user's reported game)", () => {
    test('played by clicks: the exported PGN equals the reference; copy, share and download with their fallbacks', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        await D.play(USER_GAME_UCI);
        await D.idle();
        assert.equal(D.fen(), USER_GAME_FEN);
        D.open('export');
        const chess = new Chess();
        chess.loadPgn(USER_GAME_MOVETEXT);
        const pgn = referencePgn(chess, { event: 'Chess (2D)', site: 'http://localhost', date: pgnDate(Date.now()), white: 'Human', black: 'Human', result: '*' });
        assert.equal($('save-pgn').value, pgn);
        assert.equal($('save-fen').value, USER_GAME_FEN);

        // No clipboard and no execCommand on this page: the text is selected for copying by hand
        $('save-copy').click();
        await tick();
        assert.match(D.say(), /Copying is blocked here\. The text is selected: copy it by hand\./);
        assert.equal(D.doc.activeElement, $('save-pgn'));
        assert.deepEqual([$('save-pgn').selectionStart, $('save-pgn').selectionEnd], [0, pgn.length]);

        const copied = [];
        Object.defineProperty(D.w.navigator, 'clipboard', { value: { writeText: async (text) => { copied.push(text); } }, configurable: true });
        $('save-copy').click();
        await tick();
        assert.deepEqual(copied, [pgn]);
        assert.equal(D.say(), 'Moves copied.');
        $('save-copy-fen').click();
        await tick();
        assert.deepEqual(copied, [pgn, USER_GAME_FEN]);

        // Clipboard permission refused: the old way
        Object.defineProperty(D.w.navigator, 'clipboard', { value: { writeText: async () => { throw new D.w.DOMException('denied', 'NotAllowedError'); } }, configurable: true });
        const commands = [];
        D.doc.execCommand = (name) => { commands.push([name, D.doc.activeElement.value]); return true; };
        $('save-copy').click();
        await tick();
        assert.deepEqual(commands, [['copy', pgn]]);
        assert.equal(D.say(), 'Moves copied.');
        assert.equal(D.doc.querySelector('textarea[aria-hidden="true"]'), null, 'the helper field is removed again');

        // Share sheet: hidden without one; cancelling is quiet; a refusal copies instead
        assert.equal($('save-share').hidden, true);
        const shared = [];
        D.w.navigator.share = async (data) => { shared.push(data); };
        $('save-tab-export').click();
        assert.equal($('save-share').hidden, false);
        $('save-share').click();
        await tick();
        assert.deepEqual(JSON.parse(JSON.stringify(shared)), [{ title: 'Chess (2D)', text: pgn }]);
        assert.equal(D.say(), 'Shared.');
        D.w.navigator.share = async () => { throw new D.w.DOMException('closed', 'AbortError'); };
        $('save-share').click();
        await tick();
        assert.equal(D.say(), '');
        D.w.navigator.share = async () => { throw new D.w.DOMException('no', 'NotAllowedError'); };
        $('save-share').click();
        await tick();
        await tick();
        assert.equal(D.say(), 'Sharing did not work here, so the moves were copied instead.');
        assert.equal(commands.length, 2);

        // Download: jsdom has no Blob URLs, so the link carries the text itself
        let link = null;
        const grab = (event) => { if (event.target.download) { link = { name: event.target.download, href: event.target.href }; event.preventDefault(); } };
        D.doc.addEventListener('click', grab, true);
        $('save-download').click();
        D.doc.removeEventListener('click', grab, true);
        assert.match(link.name, /^chess-\d{4}-\d{2}-\d{2}-20-moves\.pgn$/);
        assert.equal(decodeURIComponent(link.href.replace(/^data:[^,]*,/, '')), pgn);
        assert.match(D.say(), /^Saved as chess-/);
        assert.deepEqual(D.errors, []);
        D.close();
    });

    test('import: the PGN gives the final position back; an illegal move is rejected with its move number, nothing changes', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        await D.play('c2c4');
        await D.idle();
        const before = { fen: D.fen(), moves: D.moveList(), status: D.status(), turn: D.turn(), autosave: D.w.localStorage.getItem(AUTOSAVE), board: D.doc.getElementById('chess-board').innerHTML };
        D.open('import');
        $('save-import-play').click();
        assert.match($('save-import-error').textContent, /Paste the moves of a game first/);
        assert.equal(D.doc.activeElement, $('save-import-text'));
        D.type($('save-import-text'), '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O Qd4 6. Nxd4 Ke7 7. Qh5 Kd6 8. Qxe5+ Kc5 9. b4+');
        $('save-import-play').click();
        assert.equal($('save-import-error').textContent, 'Move 8 for Black ("Kc5") is not a legal move in that position. Nothing was loaded.');
        assert.equal($('save-import-error').getAttribute('role'), 'alert');
        assert.ok(D.panelOpen());
        assert.equal(shown($('save-confirm')), false);
        assert.deepEqual({ fen: D.fen(), moves: D.moveList(), status: D.status(), turn: D.turn(), autosave: D.w.localStorage.getItem(AUTOSAVE), board: D.doc.getElementById('chess-board').innerHTML }, before,
            'position, move list, status wording, autosave and board are untouched');

        D.type($('save-import-text'), `[Event "Chess Battle 3D"]\n[White "Human"]\n[Black "AI (ELO 1200)"]\n\n${USER_GAME_MOVETEXT} *`);
        $('save-import-play').click();
        assert.match($('save-confirm-text').textContent, /Leave it and load the pasted game\?/);
        $('save-confirm-yes').click();
        assert.equal(D.panelOpen(), false);
        assert.equal(D.fen(), USER_GAME_FEN);
        assert.equal(D.moveList().length, 40);
        assert.equal(D.$('game-mode-select').value, 'ai-human', 'the players of the PGN set the mode');
        assert.equal(D.el('save-notice').textContent, 'Loaded a game of 20 moves.');
        assert.deepEqual(D.stored().moves, USER_GAME_UCI);
        assert.equal($('save-import-text').value, '', 'the box is cleared after a load');
        await D.play('c7c8'); // White (the human) plays on
        await D.idle();
        assert.equal(D.moveList().length, 41);
        assert.deepEqual(D.errors, []);
        D.close();
    });

    test('games from a FEN tag: a valid one loads as written, a bogus en passant square is ignored and said so; both survive a reopen', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        const valid = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3';
        D.open('import');
        D.type($('save-import-text'), `[SetUp "1"]\n[FEN "${valid}"]\n\n3... dxe3 4. dxe3`);
        $('save-import-play').click();
        assert.equal(D.panelOpen(), false);
        assert.equal(D.el('save-notice').textContent, 'Loaded a game of 1 move.');
        assert.deepEqual(D.moveList(), ['dxe3', 'dxe3']);
        assert.equal(D.el('move-history').querySelector('.move-number').textContent, '3...', 'numbered from the FEN');
        assert.equal(D.stored().startFen, valid);
        D.open('export');
        assert.ok($('save-pgn').value.includes(`[SetUp "1"]\n[FEN "${valid}"]\n\n3... dxe3 4. dxe3 *\n`));
        $('save-close').click();

        // d6 is no en passant square here (a white knight stands on d5): the capture it would allow is refused
        const bogus = '[SetUp "1"]\n[FEN "4k3/8/8/3NP3/8/8/8/4K3 w - d6 0 1"]\n\n';
        D.open('import');
        D.type($('save-import-text'), `${bogus}1. exd6`);
        $('save-import-play').click();
        assert.equal($('save-import-error').textContent, 'Move 1 for White ("exd6") is not a legal move in that position. Nothing was loaded.');
        assert.deepEqual(D.moveList(), ['dxe3', 'dxe3'], 'the game on the board is kept');
        D.type($('save-import-text'), `${bogus}1. Nc7+ Kd7`);
        $('save-import-play').click();
        $('save-confirm-yes').click();
        assert.equal(D.el('save-notice').textContent, 'Loaded a game of 1 move. Its start position named castling or en passant rights that do not fit the board: they were ignored.');
        assert.equal(D.fen(), '8/2Nk4/8/4P3/8/8/8/4K3 w - - 2 2');
        assert.equal(D.stored().startFen, '4k3/8/8/3NP3/8/8/8/4K3 w - - 0 1', 'the cleaned position is what gets saved');
        assert.deepEqual(D.offered('e5'), ['e6'], 'no capture onto d6');

        const B = await openPage({ storage: D.storage() });
        assert.equal(B.fen(), '8/2Nk4/8/4P3/8/8/8/4K3 w - - 2 2');
        assert.deepEqual(B.moveList(), ['Nc7+', 'Kd7']);
        assert.equal(B.doc.querySelectorAll('#chess-board .piece').length, 4);
        assert.deepEqual([D.errors, B.errors, B.warnings], [[], [], []], 'the saved position needs no correcting any more');
        D.close(); B.close();
    });

    test('"Load and step through" shows the first position; the arrow keys walk the game; a file can be picked', async () => {
        const D = await openPage({ mode: 'human-human' });
        const { $ } = D;
        D.open('import');
        assert.equal($('save-import-review').textContent, 'Load and step through');
        const file = new D.w.File(['1. e4 {king pawn} e5 2. Nf3 (2. f4 exf4) Nc6 3. Bb5 a6 4. Ba4 Nf6 5. 0-0 Be7 1/2-1/2'], 'ruy.pgn', { type: 'text/plain' });
        Object.defineProperty($('save-import-file'), 'files', { value: [file], configurable: true });
        $('save-import-file').dispatchEvent(new D.w.Event('change', { bubbles: true }));
        await D.waitFor(() => $('save-import-text').value.includes('1. e4'), { message: 'file read' });
        assert.match(D.say(), /Read ruy\.pgn/);
        $('save-import-review').click();
        assert.equal(D.panelOpen(), false, 'no question: the new game had no moves');
        assert.equal(D.get('currentMoveIndex'), 0, 'at the first position');
        assert.equal(D.el('review-bar').hidden, false);
        assert.deepEqual(D.moveList(), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
        D.key('ArrowRight');
        D.key('ArrowRight');
        assert.equal(D.fen().split(' ')[0], 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR');
        D.el('live-button').click();
        assert.equal(D.get('currentMoveIndex'), 10);
        assert.deepEqual(D.errors, []);
        D.close();
    });
});
