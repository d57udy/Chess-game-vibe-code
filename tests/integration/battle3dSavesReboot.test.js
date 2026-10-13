'use strict';
// Autosave, close, reopen, in the 3D game's own wiring: battle3d/controller.js with fake scene and units
// (several pages per process are possible here, unlike the full page in battle3dSaves.test.js) plus the
// real savegame.js, savepanel.js and battle3d/saves.js in the page's window. A game is played by clicks,
// the "app is closed" (a new window gets the same localStorage) and must come back: identical FEN,
// identical offered moves, same settings; then New game and corrupt data on further restarts.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { ROOT } = require('../helpers/loadEngine');

// White can only castle queenside, Black only kingside; ...d5 has just passed the e5 pawn
const MID_GAME = ['e2e4', 'a7a5', 'e4e5', 'a8a6', 'h2h4', 'a6a8', 'h1h3', 'g8f6', 'h3h1', 'f6g8', 'g1f3', 'd7d5'];
const MID_FEN = 'rnbqkbnr/1pp1pppp/8/p2pP3/7P/5N2/PPPP1PP1/RNBQKB1R w Qk d6 0 7';
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// The real save modules in the page's window (saves.js is an ES module: its import / export lines are
// dropped, the two scripts it imports are evaluated first), wired to the controller like main.js does
function wireSaves(C) {
    C.g(source('savegame.js'), 'savegame.js');
    C.g(source('savepanel.js'), 'savepanel.js');
    const saves = source('battle3d/saves.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
    C.g(`(function () { 'use strict';\n${saves}\nwindow.__setupSaves = setupSaves; })();`, 'battle3d/saves.js');
    C.w.__controller = C.controller;
    C.notices = [];
    C.w.__notify = (text) => C.notices.push(text);
    C.saves = C.g('__setupSaves({ controller: __controller, notify: __notify })');
    return C.saves;
}

// Opens the "app": like main.js, an autosaved game comes back in place of the first new game
async function openApp(storage = {}, options = {}) {
    const C = await loadBattle3dController({ ...options, newGame: false, setup(w) { for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v); } });
    wireSaves(C);
    if (!C.saves.resumed) C.controller.newGame();
    await C.flush();
    C.storage = () => Object.fromEntries(Array.from({ length: C.w.localStorage.length }, (_, i) => [C.w.localStorage.key(i), C.w.localStorage.getItem(C.w.localStorage.key(i))]));
    // The squares offered after clicking a piece, as the scene is told to highlight them
    C.offered = async (name) => {
        C.key('Escape', 'Escape');
        await C.click(name);
        const h = C.scene.calls.setHighlights[C.scene.calls.setHighlights.length - 1];
        return h.moves.map((m) => `${String.fromCharCode(97 + m.col)}${8 - m.row}${m.capture ? 'x' : ''}`).sort();
    };
    return C;
}
const settings = (mode, extra = {}) => ({ 'battle3d.settings': JSON.stringify({ mode, speed: 'fast', ...extra }), 'battle3d.tipSeen': '1' });

describe('battle3d autosave across restarts (controller + saves.js)', () => {
    test('a game played by clicks comes back after the app is closed and reopened', async () => {
        const A = await openApp(settings('human-human', { elo: 1700 }));
        assert.equal(A.saves.resumed, false);
        for (const mv of MID_GAME) await A.play(mv);
        assert.equal(A.state().fen, MID_FEN);
        const pawn = await A.offered('e5'), king = await A.offered('e1');
        assert.deepEqual(pawn, ['d6x', 'e6'], 'en passant on d6 is offered');
        const closed = A.storage();
        A.close();

        const B = await openApp(closed);
        assert.equal(B.saves.resumed, true);
        assert.equal(B.saves.notice, null);
        assert.equal(B.state().fen, MID_FEN, 'identical FEN: en passant square, castling rights, clocks');
        assert.deepEqual(B.state().history, ['e4', 'a5', 'e5', 'Ra6', 'h4', 'Ra8', 'Rh3', 'Nf6', 'Rh1', 'Ng8', 'Nf3', 'd5']);
        assert.deepEqual({ mode: B.state().mode, elo: B.state().elo }, { mode: 'human-human', elo: 1700 });
        assert.deepEqual(await B.offered('e5'), pawn, 'identical offered moves');
        assert.deepEqual(await B.offered('e1'), king);
        B.key('Escape', 'Escape');
        assert.equal(B.doc.getElementById('move-list').querySelectorAll('.mv').length, 12);
        assert.deepEqual(B.units.grid(), B.get('board'), 'the units show the restored position');
        assert.equal(B.units.calls.playMove.length, 0, 'restored without animating the moves');
        assert.deepEqual(B.errors, []);

        // Play on (en passant, then Black castles on the side it still can), close again
        await B.play('e5d6');
        await B.play('e7d6');
        await B.play('f1b5');
        await B.play('c7c6');
        await B.play('b5a4');
        await B.play('g8f6');
        await B.play('d2d3');
        await B.play('f8e7');
        await B.play('c1e3');
        assert.deepEqual(await B.offered('e8'), ['d7', 'f8', 'g8'], 'Black may castle kingside only');
        const fen = B.state().fen;
        const C = await openApp(B.storage());
        assert.equal(C.state().fen, fen);
        assert.deepEqual(await C.offered('e8'), ['d7', 'f8', 'g8']);
        C.key('Escape', 'Escape');
        await C.play('e8g8');
        assert.equal(C.state().history.pop(), 'O-O');

        // New game clears the autosave: the next start is a fresh game
        C.button('new-game').click();
        await C.flush();
        assert.equal(C.w.localStorage.getItem('chess.autosave.3d'), null);
        const D = await openApp(C.storage());
        assert.equal(D.saves.resumed, false);
        assert.deepEqual(D.state().history, []);
        for (const app of [B, C, D]) app.close();
    });

    test('a finished game comes back finished; a game against the AI comes back with the AI to move', async () => {
        const A = await openApp(settings('human-human'));
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await A.play(mv);
        assert.equal(A.state().over, true);
        const B = await openApp(A.storage());
        assert.deepEqual({ over: B.state().over, result: B.state().result }, { over: true, result: 'checkmate' });
        assert.match(B.status(), /Checkmate! Black wins\./);
        assert.equal(JSON.parse(B.w.localStorage.getItem('chess.autosave.3d')).result, '0-1');

        const C = await openApp(settings('human-ai', { humanColor: 'w', elo: 1300 }));
        await C.play('e2e4');
        assert.equal(JSON.parse(C.w.localStorage.getItem('chess.autosave.3d')).moves.length, 1, 'saved while the AI is still to move');
        const D = await openApp(C.storage());
        assert.equal(D.state().turn, 'b');
        await D.step(1);
        assert.equal(D.aiCalls().length, 1, 'the AI is asked for its move after the restart');
        await D.answerAI('e7e5');
        assert.deepEqual(D.state().history, ['e4', 'e5']);
        assert.deepEqual({ mode: D.state().mode, humanColor: D.state().humanColor, elo: D.state().elo }, { mode: 'human-ai', humanColor: 'w', elo: 1300 });
        for (const app of [A, B, C, D]) app.close();
    });

    test('a drawn game and a game from a FEN tag come back as they were (repetition by the game\'s rule, cleaned start position)', async () => {
        // 1. e4 e5 2. Nf3 Nf6 3. Ng1 Ng8 4. Nf3 Nf6 5. Ng1 Ng8: third time the same position at ply 10
        const A = await openApp(settings('human-human'));
        for (const mv of ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) await A.play(mv);
        assert.deepEqual({ over: A.state().over, result: A.state().result }, { over: true, result: 'threefold' });
        assert.equal(JSON.parse(A.w.localStorage.getItem('chess.autosave.3d')).result, '1/2-1/2');
        assert.ok(A.saves.session.pgn().endsWith('5. Ng1 Ng8 1/2-1/2\n'));
        const B = await openApp(A.storage());
        assert.deepEqual({ over: B.state().over, result: B.state().result, plies: B.state().history.length }, { over: true, result: 'threefold', plies: 10 });
        assert.match(B.status(), /Draw by threefold repetition/);

        // d6 is no en passant square in this FEN (a white knight is on d5): the rules drop it, the import says so
        const bogus = '[SetUp "1"]\n[FEN "4k3/8/8/3NP3/8/8/8/4K3 w - d6 0 1"]\n\n';
        const refused = B.saves.session.importPgn(`${bogus}1. exd6`);
        assert.deepEqual({ ok: refused.ok, moveNumber: refused.moveNumber, san: refused.san }, { ok: false, moveNumber: 1, san: 'exd6' });
        assert.equal(B.state().history.length, 10, 'nothing was loaded');
        const loaded = B.saves.session.importPgn(`${bogus}1. Nc7+ Kd7`);
        assert.deepEqual({ ok: loaded.ok, adjusted: loaded.adjusted }, { ok: true, adjusted: true });
        assert.equal(B.state().fen, '8/2Nk4/8/4P3/8/8/8/4K3 w - - 2 2');
        assert.deepEqual(await B.offered('e5'), ['e6']);
        const C = await openApp(B.storage());
        assert.equal(C.saves.resumed, true);
        assert.equal(C.state().fen, '8/2Nk4/8/4P3/8/8/8/4K3 w - - 2 2');
        assert.deepEqual(C.state().history, ['Nc7+', 'Kd7']);
        assert.deepEqual(C.units.grid(), C.get('board'));
        assert.deepEqual([C.errors, C.warnings], [[], []], 'the saved start position is already the cleaned one');
        for (const app of [A, B, C]) app.close();
    });

    test('corrupt, other-version and unplayable autosaves never break the start: new game plus a short notice', async () => {
        const good = { v: 1, view: '3d', mode: 'human-human', humanColor: 'w', elo: 1200, startFen: null, moves: ['e2e4', 'e7e5'], san: ['e4', 'e5'], result: '*', savedAt: 1, startedAt: 1 };
        const cases = {
            'not JSON': '{"v":1,"moves":["e2e4"',
            'older format': JSON.stringify({ ...good, v: 0 }),
            'newer format': JSON.stringify({ ...good, v: 2 }),
            'no version': JSON.stringify({ ...good, v: undefined }),
            'illegal move': JSON.stringify({ ...good, moves: ['e2e4', 'e7e5', 'e4e5'], san: ['e4', 'e5', 'e5'] }),
            'bad start position': JSON.stringify({ ...good, startFen: 'k6R/8/8/8/8/8/8/K7 w - - 0 1', moves: [] }),
            'wrong shape': JSON.stringify({ v: 1, moves: 'e2e4' }),
            'a number': '42',
        };
        for (const [name, raw] of Object.entries(cases)) {
            const A = await openApp({ ...settings('human-human'), 'chess.autosave.3d': raw });
            assert.equal(A.saves.resumed, false, name);
            assert.equal(A.saves.notice, 'Your saved game could not be read, so a new game was started.', name);
            assert.equal(A.state().fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', name);
            await A.play('d2d4');
            assert.deepEqual(A.state().history, ['d4'], `playable after: ${name}`);
            assert.deepEqual(JSON.parse(A.w.localStorage.getItem('chess.autosave.3d')).moves, ['d2d4'], name);
            assert.deepEqual(A.errors, [], name);
            A.close();
        }
        const empty = await openApp(settings('human-human'));
        assert.deepEqual([empty.saves.resumed, empty.saves.notice], [false, null], 'nothing stored: no notice');
        empty.close();
    });

    test('load while a move animates, in review and with the promotion chooser open; a failed load keeps the game', async () => {
        const record = { v: 1, mode: 'human-human', startFen: null, moves: MID_GAME, savedAt: 1, startedAt: 1 };
        const A = await openApp(settings('human-human'), { units: 'manual' });
        const saves = A.saves;

        await A.click('e2');
        await A.click('e4');
        assert.equal(A.state().moving, true, 'the move is animating');
        assert.equal(saves.session.load(record).ok, true);
        assert.deepEqual({ fen: A.state().fen, moving: A.state().moving }, { fen: MID_FEN, moving: false });
        assert.deepEqual(A.units.grid(), A.get('board'));

        A.controller.enterReview(3);
        assert.equal(A.state().reviewIndex, 3);
        assert.equal(saves.session.load({ ...record, moves: MID_GAME.slice(0, 4) }).ok, true);
        assert.deepEqual({ review: A.state().reviewIndex, plies: A.state().history.length }, { review: null, plies: 4 });

        const bad = saves.session.load({ ...record, moves: ['e2e4', 'e7e5', 'e4e5'] });
        assert.equal(bad.ok, false);
        assert.match(bad.error, /move 3 \(e4e5\) is not legal/);
        assert.equal(A.state().history.length, 4, 'the game on the board is kept');
        assert.deepEqual(A.units.grid(), A.get('board'));
        assert.deepEqual(JSON.parse(A.w.localStorage.getItem('chess.autosave.3d')).moves, MID_GAME.slice(0, 4));
        assert.deepEqual(A.errors, []);
        A.close();
    });
});
