'use strict';
// Save / Load on the real 3D page (index.html + main.js with the real scene, units, controller and
// coach; fake renderer). The page is opened with an autosave in localStorage, like the installed app
// being reopened in the middle of a game:
//   - resume: identical FEN (en passant square, castling rights partly lost, clocks), identical offered
//     moves, the saved mode / side / AI strength, units in sync;
//   - autosave at once on every move (before its animation), on undo and settings; New game clears it;
//   - the Save / Load panel: dialog semantics, save, load (asks when the current game is not saved),
//     rename, delete with confirmation, the cap of 30;
//   - export of the user's reported game, played through the page, equals the reference PGN; copy,
//     share, download and FEN with their fallbacks;
//   - import: that PGN gives the final position back, an illegal move is rejected with its move number
//     and nothing is loaded; "Load and review" opens the game review; loading during a fight.
// A second boot (corrupt autosave) is in battle3dSavesBoot.test.js: one page per process.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const H = require('../helpers/battle3dUnitsHarness');
const { square } = require('../helpers/loadEngine');
const { Chess, USER_GAME_MOVETEXT, USER_GAME_UCI, USER_GAME_FEN, loadSaveGame, plain, referencePgn, pgnDate } = require('../helpers/saveGameHarness');

const skip = findThree() ? false : 'three.js not installed';
// White can only castle queenside (the h-rook moved), Black only kingside; ...d5 has just passed the e5 pawn
const MID_GAME = ['e2e4', 'a7a5', 'e4e5', 'a8a6', 'h2h4', 'a6a8', 'h1h3', 'g8f6', 'h3h1', 'f6g8', 'g1f3', 'd7d5'];
const MID_FEN = 'rnbqkbnr/1pp1pppp/8/p2pP3/7P/5N2/PPPP1PP1/RNBQKB1R w Qk d6 0 7';
const AUTOSAVE = 'chess.autosave.3d';

let P, R, seed, focused = [], active = null;
const $ = (id) => P.$(id);
const st = () => P.state();
const stored = (key = AUTOSAVE) => JSON.parse(P.w.localStorage.getItem(key) || 'null');
const pageRules = () => ({ get: () => P.board() });
const uciOf = (m) => String.fromCharCode(97 + m.from.col) + (8 - m.from.row) + String.fromCharCode(97 + m.to.col) + (8 - m.to.row);
const offered = () => globalThis.getAllLegalMoves(globalThis.battle3dState().currentPlayer).map(uciOf).sort();
const pendingAI = () => P.aiCalls().filter((c) => !c.cancelled && !c.done).pop() || null;
const idle = (label = 'the move to finish') => P.stepUntil(() => !st().moving && !P.B.units.isBusy?.(), { label });

// A move by clicking the two squares. The rules state changes at once; `wait` lets the animation end.
async function click(uci, { wait = true } = {}) {
    const n = st().history.length;
    for (const name of [uci.slice(0, 2), uci.slice(2, 4)]) { const { row, col } = square(name); P.B.controller.clickSquare(row, col); }
    assert.equal(st().history.length, n + 1, `move ${uci} was made`);
    if (wait) { P.B.controller.skip(); await idle(`move ${uci}`); }
}
async function answerAI(uci) {
    await P.stepUntil(() => !!pendingAI(), { label: `AI request before ${uci}` });
    const call = pendingAI();
    call.done = true;
    call.resolve({ from: square(uci.slice(0, 2)), to: square(uci.slice(2, 4)) });
    await P.stepUntil(() => !st().moving && st().history.length % 2 === 0 && !P.B.units.isBusy?.(), { label: `AI move ${uci}` });
}
function setMode(mode) { const el = $('mode-select'); el.value = mode; el.dispatchEvent(new P.w.Event('change', { bubbles: true })); }
async function newGame(mode = 'human-human') {
    for (const c of P.aiCalls()) if (!c.cancelled && !c.done) { c.done = true; c.resolve(null); }
    if (!$('save-modal').hidden) $('save-close').click();
    setMode(mode);
    $('new-game').click();
    await idle('new game');
}
async function playAll(moves) { for (const uci of moves) await click(uci); }

// --- The panel, as a user sees it ---
const panelOpen = () => !$('save-modal').hidden;
const shown = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) if (e.hidden) return false; return !!el; };
const status = () => $('save-status').textContent;
const saveNames = () => [...$('save-list').querySelectorAll('.save-item-name')].map((n) => n.textContent);
const item = (name) => [...$('save-list').querySelectorAll('.save-item')].find((li) => li.querySelector('.save-item-name')?.textContent === name);
const act = (name, action) => item(name).querySelector(`[data-action="${action}"]`);
const type = (el, text) => { el.value = text; el.dispatchEvent(new P.w.Event('input', { bubbles: true })); };
const key = (el, k) => el.dispatchEvent(new P.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
function openPanel(which = 'saves') {
    const opener = $(which === 'export' ? 'export-open' : 'save-open');
    opener.click();
    assert.ok(panelOpen(), 'the panel opens');
    if (which === 'import') $('save-tab-import').click();
    return opener;
}
function saveAs(name) { type($('save-name'), name); $('save-submit').click(); }
const tick = () => new Promise((r) => setImmediate(r));

describe('battle3d save / load (real page, reopened with an autosave)', { skip }, () => {
    before(async () => {
        R = loadSaveGame();
        for (const uci of MID_GAME) R.move(uci);
        seed = plain(R.SG.currentRecord({ view: '3d', mode: 'human-ai', humanColor: 'w', elo: 1500, startedAt: Date.now() - 3600000 }));
        P = await bootPage({
            setup(w) {
                w.localStorage.setItem('battle3d.tipSeen', '1');
                // The stored settings disagree with the saved game on purpose: the game's own settings win
                w.localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', humanColor: 'b', elo: 800, speed: 'fast', talk: 'off' }));
                w.localStorage.setItem(AUTOSAVE, JSON.stringify(seed));
                // bootPage turns focus() into a no-op; record it and keep document.activeElement in step
                w.HTMLElement.prototype.focus = function () { focused.push(this); active = this; };
                Object.defineProperty(w.document, 'activeElement', { get: () => (active && w.document.contains(active) ? active : w.document.body), configurable: true });
            },
        });
    });
    after(() => { if (P) P.restore(); });

    describe('autosave and resume', () => {
        test('reopening resumes the game: same FEN, same offered moves, saved mode, side and AI strength', async () => {
            await idle('boot');
            assert.equal(seed.fen, MID_FEN);
            assert.equal(st().fen, MID_FEN, 'en passant square, castling rights and clocks are back');
            assert.deepEqual(st().history, seed.san);
            assert.deepEqual(offered(), R.legal().map((m) => m.uci.slice(0, 4)).sort(), 'the same moves are on offer');
            assert.ok(offered().includes('e5d6'), 'en passant is on offer');
            assert.ok(!offered().includes('e1g1') && !offered().includes('e1c1'), 'no castling through pieces');
            assert.deepEqual({ mode: st().mode, humanColor: st().humanColor, elo: st().elo }, { mode: 'human-ai', humanColor: 'w', elo: 1500 });
            assert.equal($('mode-select').value, 'human-ai');
            assert.equal($('elo-slider').value, '1500');
            assert.equal($('move-list').querySelectorAll('.mv').length, 12, 'the move list is back');
            assert.match($('status-text').textContent, /White to move/);
            assert.equal($('tip').hidden, true, 'no notice when the resume worked');
            assert.equal(pendingAI(), null, 'it is the human turn');
            H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after resume');
            assert.deepEqual(P.errors, []);
        });

        test('a move is saved at once, before its animation; the saved game replays to the position on screen', async () => {
            await click('e5d6', { wait: false }); // en passant
            assert.equal(st().moving, true, 'the capture is still being animated');
            assert.deepEqual(stored().moves, [...MID_GAME, 'e5d6'], 'already in the autosave');
            assert.equal(stored().san[12], 'exd6', 'stored SAN is standard (no "e.p.")');
            P.B.controller.skip();
            await idle('en passant');
            // The move list may decorate the capture on screen ("exd6 e.p."); what is stored never does
            assert.match($('move-list').textContent, /exd6/);
            assert.ok(stored().san.every((san) => !/e\.p/i.test(san)));
            await answerAI('c7d6');
            assert.deepEqual(stored().moves, [...MID_GAME, 'e5d6', 'c7d6']);
            assert.deepEqual({ mode: stored().mode, humanColor: stored().humanColor, elo: stored().elo, view: stored().view, v: stored().v },
                { mode: 'human-ai', humanColor: 'w', elo: 1500, view: '3d', v: 1 });
            assert.equal(stored().fen, st().fen);

            // What the next start would restore
            const F = loadSaveGame();
            assert.equal(plain(F.SG.applyRecord(stored())).ok, true);
            assert.equal(F.run('battle3dFen()'), st().fen);
            assert.deepEqual(F.legal().map((m) => m.uci.slice(0, 4)).sort(), offered());
        });

        test('undo and settings changes are saved too; New game clears the autosave', async () => {
            $('undo').click();
            await idle('undo');
            assert.deepEqual(stored().moves, MID_GAME, 'undo takes back the human move and the answer');
            const slider = $('elo-slider');
            slider.value = '900';
            slider.dispatchEvent(new P.w.Event('input', { bubbles: true }));
            assert.equal(stored().elo, 900);
            $('side-b').click();
            assert.equal(stored().humanColor, 'b');
            $('side-w').click();
            await newGame('human-human');
            assert.equal(P.w.localStorage.getItem(AUTOSAVE), null, 'New game clears it');
            await click('e2e4');
            assert.deepEqual(stored().moves, ['e2e4']);
            assert.equal(stored().mode, 'human-human');
        });
    });

    describe('Save / Load panel', () => {
        test('opens as a dialog from the menu, with labelled fields and a default name; Escape closes and returns the focus', async () => {
            await newGame('human-ai');
            const opener = openPanel();
            const card = $('save-modal').querySelector('[role="dialog"]');
            assert.equal(card.getAttribute('aria-modal'), 'true');
            assert.equal(card.getAttribute('aria-labelledby'), 'save-title');
            assert.equal(focused[focused.length - 1], $('save-title'), 'focus moves into the dialog');
            assert.deepEqual([...card.querySelectorAll('[role="tab"]')].map((t) => [t.textContent, t.getAttribute('aria-selected')]),
                [['Saved games', 'true'], ['Export', 'false'], ['Import', 'false']]);
            for (const field of card.querySelectorAll('input:not([type="file"]), textarea')) {
                assert.ok(card.querySelector(`label[for="${field.id}"]`) || field.getAttribute('aria-label'), `${field.id} has a label`);
            }
            assert.equal($('save-submit').disabled, true, 'nothing to save before the first move');
            assert.match($('save-count').textContent, /No moves yet.*0 of 30 saves used/);
            assert.equal($('save-empty').hidden, false);
            key($('save-title'), 'Escape');
            assert.equal(panelOpen(), false);
            assert.equal(focused[focused.length - 1], opener, 'focus returns to the button that opened it');

            await click('e2e4');
            await answerAI('e7e5');
            openPanel();
            assert.equal($('save-submit').disabled, false);
            assert.match($('save-name').value, /^\d{1,2} [A-Z][a-z]{2}, vs AI \d+$/, 'default name: date plus opponent');
            $('save-close').click();
            assert.equal(panelOpen(), false);
        });

        test('save, new game, load: asks first when the current game is not saved, not when it is', async () => {
            const fen = st().fen;
            openPanel();
            saveAs('Alpha');
            assert.equal(status(), 'Saved as "Alpha".');
            assert.deepEqual(saveNames(), ['Alpha']);
            assert.match(item('Alpha').querySelector('.save-item-meta').textContent, /^\d{1,2} [A-Z][a-z]{2} \d{4}, 1 move, in progress$/);
            assert.match($('save-count').textContent, /This game is saved as "Alpha"\. 1 of 30 saves used\./);
            $('save-close').click();

            await newGame('human-human');
            await click('d2d4'); // another game, not saved
            openPanel();
            act('Alpha', 'load').click();
            assert.equal(shown($('save-confirm')), true, 'asks before leaving an unsaved game');
            assert.match($('save-confirm-text').textContent, /Your current game is not saved\. Leave it and load "Alpha"\?/);
            assert.equal(focused[focused.length - 1], $('save-confirm-no'), 'Cancel has the focus');
            $('save-confirm-no').click();
            assert.equal(shown($('save-confirm')), false);
            assert.deepEqual(st().history, ['d4'], 'Cancel keeps the game');
            assert.ok(panelOpen());

            act('Alpha', 'load').click();
            $('save-confirm-yes').click();
            assert.equal(panelOpen(), false, 'the panel closes after a load');
            await idle('load');
            assert.equal(st().fen, fen);
            assert.deepEqual(st().history, ['e4', 'e5']);
            assert.deepEqual({ mode: st().mode, humanColor: st().humanColor }, { mode: 'human-ai', humanColor: 'w' }, 'the save brings its mode back');
            assert.equal($('tip-text').textContent, 'Loaded "Alpha".');
            assert.equal($('tip').hidden, false);
            assert.deepEqual(stored().moves, ['e2e4', 'e7e5'], 'the loaded game is the autosave now');
            H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after load');

            openPanel();
            act('Alpha', 'load').click();
            assert.equal(panelOpen(), false, 'no question when the game on the board is already saved');
            await idle('reload');
            assert.equal(st().fen, fen);
        });

        test('same name asks to replace; rename; delete asks and can be cancelled', async () => {
            await click('g1f3');
            await answerAI('b8c6');
            openPanel();
            saveAs('alpha');
            assert.match($('save-confirm-text').textContent, /A save named "Alpha" exists\. Replace it with this game\?/);
            $('save-confirm-yes').click();
            assert.equal(status(), 'Replaced the save "alpha".');
            assert.deepEqual(saveNames(), ['alpha']);
            assert.match(item('alpha').querySelector('.save-item-meta').textContent, /2 moves/);
            saveAs('Second');
            assert.deepEqual(saveNames().sort(), ['Second', 'alpha']);

            act('alpha', 'rename').click();
            const input = $('save-list').querySelector('.save-rename');
            assert.equal(input.value, 'alpha');
            assert.equal(input.getAttribute('aria-label'), 'New name for alpha');
            type(input, 'Second');
            key(input, 'Enter');
            assert.equal(status(), 'Another save already has that name.');
            type(input, 'Sicilian try');
            key(input, 'Enter');
            assert.deepEqual(saveNames().sort(), ['Second', 'Sicilian try']);
            assert.equal(status(), 'Renamed to "Sicilian try".');
            act('Second', 'rename').click();
            key($('save-list').querySelector('.save-rename'), 'Escape');
            assert.ok(panelOpen(), 'Escape only cancels the rename');
            assert.deepEqual(saveNames().sort(), ['Second', 'Sicilian try']);

            act('Second', 'delete').click();
            assert.match($('save-confirm-text').textContent, /Delete the save "Second"\? This cannot be undone\./);
            key($('save-confirm-no'), 'Escape');
            assert.ok(panelOpen(), 'Escape only cancels the question');
            assert.deepEqual(saveNames().sort(), ['Second', 'Sicilian try']);
            act('Second', 'delete').click();
            $('save-confirm-yes').click();
            assert.deepEqual(saveNames(), ['Sicilian try']);
            assert.equal(status(), 'Deleted "Second".');
            assert.equal(stored('chess.saves').saves.length, 1);
            $('save-close').click();
        });

        test('the cap: the panel says when all 30 slots are used and refuses a 31st', () => {
            const store = P.B.saves.session.store;
            const record = P.B.saves.session.record();
            for (let i = store.list().length; i < 30; i++) assert.equal(store.save(`Filler ${i}`, { ...record, moves: record.moves.slice(0, 1 + (i % 3)), san: record.san.slice(0, 1 + (i % 3)) }).ok, true);
            openPanel();
            assert.equal(saveNames().length, 30);
            assert.match($('save-count').textContent, /All 30 save slots are used\. Delete a save to add another/);
            saveAs('One too many');
            assert.equal(status(), 'All 30 save slots are used. Delete a save to make room.');
            assert.equal(saveNames().length, 30);
            for (const s of store.list()) if (s.name.startsWith('Filler')) store.remove(s.id);
            $('save-close').click();
        });
    });

    describe("export and import (the user's reported game)", () => {
        let pgn;

        test('played through the page, the exported PGN equals the reference (plain SAN, whatever the move list shows)', async () => {
            await newGame('human-human');
            await playAll(USER_GAME_UCI);
            assert.equal(st().fen, USER_GAME_FEN);
            assert.match($('move-list').textContent, /axb3/);
            const opener = openPanel('export');
            assert.equal($('save-tab-export').getAttribute('aria-selected'), 'true', '"Export moves" opens the export tab');
            assert.equal(focused[focused.length - 1], $('save-copy'), 'ready to copy');
            const chess = new Chess();
            chess.loadPgn(USER_GAME_MOVETEXT);
            pgn = referencePgn(chess, { event: 'Chess Battle 3D', site: 'http://localhost', date: pgnDate(Date.now()), white: 'Human', black: 'Human', result: '*' });
            assert.equal($('save-pgn').value, pgn);
            assert.ok($('save-pgn').value.endsWith(`${USER_GAME_MOVETEXT} *\n`));
            assert.ok($('save-pgn').readOnly);
            assert.equal($('save-fen').value, USER_GAME_FEN);
            assert.equal(opener.id, 'export-open');
        });

        test('copy: Clipboard API, the old way when it refuses, and select-for-hand-copy when both fail', async () => {
            // The test page has neither a clipboard nor execCommand: the text gets selected instead
            $('save-copy').click();
            await tick();
            assert.match(status(), /Copying is blocked here\. The text is selected: copy it by hand\./);
            assert.deepEqual([$('save-pgn').selectionStart, $('save-pgn').selectionEnd], [0, pgn.length]);

            const copied = [];
            globalThis.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
            $('save-copy').click();
            await tick();
            assert.deepEqual(copied, [pgn]);
            assert.equal(status(), 'Moves copied.');
            $('save-copy-fen').click();
            await tick();
            assert.deepEqual(copied, [pgn, USER_GAME_FEN]);
            assert.equal(status(), 'Position (FEN) copied.');

            globalThis.navigator.clipboard = { writeText: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } };
            const commands = [];
            P.doc.execCommand = (name) => { commands.push(name); return true; };
            $('save-copy').click();
            await tick();
            assert.deepEqual(commands, ['copy'], 'falls back to execCommand');
            assert.equal(status(), 'Moves copied.');
            delete P.doc.execCommand;
            delete globalThis.navigator.clipboard;
        });

        test('share: only offered with a share sheet; cancelling is quiet, a failure copies instead', async () => {
            assert.equal($('save-share').hidden, true, 'no share button without navigator.share');
            const shared = [];
            globalThis.navigator.share = async (data) => { shared.push(data); };
            $('save-tab-export').click();
            assert.equal($('save-share').hidden, false);
            $('save-share').click();
            await tick();
            assert.deepEqual(shared, [{ title: 'Chess Battle 3D', text: pgn }]);
            assert.equal(status(), 'Shared.');

            globalThis.navigator.share = async () => { const e = new Error('dismissed'); e.name = 'AbortError'; throw e; };
            $('save-share').click();
            await tick();
            assert.equal(status(), '', 'closing the share sheet is not an error');

            const copied = [];
            globalThis.navigator.clipboard = { writeText: async (text) => { copied.push(text); } };
            globalThis.navigator.share = async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e; };
            $('save-share').click();
            await tick();
            await tick();
            assert.deepEqual(copied, [pgn]);
            assert.equal(status(), 'Sharing did not work here, so the moves were copied instead.');
            delete globalThis.navigator.share;
            delete globalThis.navigator.clipboard;
        });

        test('download: a .pgn file with the same text', async () => {
            let link = null;
            const grab = (event) => { if (event.target.download) { link = { name: event.target.download, href: event.target.href }; event.preventDefault(); } };
            P.doc.addEventListener('click', grab, true);
            $('save-download').click();
            P.doc.removeEventListener('click', grab, true);
            assert.match(link.name, /^chess-\d{4}-\d{2}-\d{2}-20-moves\.pgn$/);
            // node has Blob URLs (like browsers), so the link points at a Blob
            const blob = require('node:buffer').resolveObjectURL(link.href);
            assert.equal(blob.type, 'application/vnd.chess-pgn');
            assert.equal(await blob.text(), pgn);
            assert.match(status(), /^Saved as chess-.*\.pgn\.$/);
            assert.equal(P.doc.querySelector('a[download]'), null, 'the temporary link is gone');
        });

        test('"Copy position" follows the board: an earlier position while one is shown', () => {
            $('save-close').click();
            P.B.controller.enterReview(2);
            openPanel('export');
            assert.equal($('save-fen').value, 'rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
            assert.ok($('save-pgn').value.endsWith(`${USER_GAME_MOVETEXT} *\n`), 'the PGN is always the whole game');
            $('save-close').click();
            P.B.controller.exitReview();
            assert.equal(st().fen, USER_GAME_FEN);
        });

        test('import: a PGN with an illegal move is rejected with its move number and nothing is loaded', async () => {
            await newGame('human-human');
            await click('c2c4');
            const before = { fen: st().fen, history: st().history, autosave: P.w.localStorage.getItem(AUTOSAVE) };
            openPanel('import');
            assert.equal($('save-tab-import').getAttribute('aria-selected'), 'true');
            $('save-import-play').click();
            assert.match($('save-import-error').textContent, /Paste the moves of a game first/);
            type($('save-import-text'), '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O Qd4 6. Nxd4 Ke7 7. Qh5 Kd6 8. Qxe5+ Kc5 9. b4+');
            $('save-import-play').click();
            assert.equal($('save-import-error').textContent, 'Move 8 for Black ("Kc5") is not a legal move in that position. Nothing was loaded.');
            assert.equal($('save-import-error').getAttribute('role'), 'alert');
            assert.ok(panelOpen(), 'the panel stays open with the message');
            assert.equal(shown($('save-confirm')), false, 'no question about leaving the game for text that cannot be loaded');
            assert.deepEqual({ fen: st().fen, history: st().history, autosave: P.w.localStorage.getItem(AUTOSAVE) }, before);
            H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after a rejected import');
        });

        test('import: the exported PGN gives the final position back, and play continues from it', async () => {
            type($('save-import-text'), pgn);
            $('save-import-play').click();
            assert.match($('save-confirm-text').textContent, /Your current game is not saved\. Leave it and load the pasted game\?/);
            $('save-confirm-yes').click();
            assert.equal(panelOpen(), false);
            await idle('import');
            assert.equal(st().fen, USER_GAME_FEN);
            assert.deepEqual(st().history, USER_GAME_MOVETEXT.replace(/\d+\. /g, '').split(' '));
            assert.equal(st().mode, 'human-human', 'White "Human" / Black "Human" in the tags');
            assert.equal($('tip-text').textContent, 'Loaded a game of 20 moves.');
            assert.deepEqual(stored().moves, USER_GAME_UCI);
            H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after import');
            await click('c7c8'); // 21. Qc8: play goes on
            assert.equal(st().history.length, 41);
            assert.deepEqual(P.errors, []);
        });

        test('import with "Load and review" opens the game review on the loaded game', async () => {
            await newGame('human-human');
            openPanel('import');
            type($('save-import-text'), '1. e4 e5 2. Nf3 {a comment} Nc6 (2... d6) 3. Bb5 a6 4. Ba4 Nf6 5. 0-0 Be7 *');
            $('save-import-review').click();
            assert.equal(panelOpen(), false, 'no question: the new game had no moves');
            await idle('import for review');
            assert.deepEqual(st().history, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
            assert.equal($('coach-review').hidden, false, 'the review panel is open');
            assert.equal($('coach-review-list').querySelectorAll('button').length, 10, 'with the loaded moves');
            $('coach-review-close').click();
        });

        test('a file can be picked instead of pasting', async () => {
            globalThis.FileReader = P.w.FileReader; // jsdom files have no text(): the FileReader path
            openPanel('import');
            const file = new P.w.File(['[Event "x"]\n\n1. d4 d5 2. c4 e6 *\n'], 'queens-gambit.pgn', { type: 'application/vnd.chess-pgn' });
            Object.defineProperty($('save-import-file'), 'files', { value: [file], configurable: true });
            $('save-import-file').dispatchEvent(new P.w.Event('change', { bubbles: true }));
            await P.stepUntil(() => $('save-import-text').value.includes('1. d4'), { label: 'file read' });
            assert.match(status(), /Read queens-gambit\.pgn/);
            $('save-import-play').click();
            if (shown($('save-confirm'))) $('save-confirm-yes').click();
            await idle('file import');
            assert.deepEqual(st().history, ['d4', 'd5', 'c4', 'e6']);
            delete globalThis.FileReader;
        });

        test('loading while a fight is running stops it and shows the loaded game', async () => {
            await newGame('human-human');
            await playAll(['e2e4', 'd7d5']);
            await click('e4d5', { wait: false });
            assert.equal(st().moving, true);
            const result = P.B.saves.session.load(seed);
            assert.equal(result.ok, true);
            assert.equal(st().moving, false);
            await idle('load during a fight');
            assert.equal(st().fen, MID_FEN);
            H.assertSynced(P.B.sceneAPI, P.B.units, pageRules(), 'after loading during a fight');
            assert.deepEqual(P.errors, []);
        });
    });
});
