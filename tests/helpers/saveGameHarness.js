// Shared by the save / load tests (tests/unit/savegame.test.js, tests/integration/saves2d.test.js,
// battle3dSaves*.test.js): savegame.js next to the game's rules in a vm context, the chess.js
// reference PGN, an in-memory Storage, and the user's reported game.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { source, ROOT } = require('./loadEngine');
const { Chess, START_FEN, loadGame, rng } = require('./chessReference');

// The game from the bug report that started this feature: 40 plies, the last one en passant.
const USER_GAME_MOVETEXT = '1. e4 d6 2. Bb5+ Nc6 3. h3 Nf6 4. Nc3 Nxe4 5. Nxe4 Bxh3 6. Rxh3 e6 7. d4 Be7 8. f4 Bh4+ 9. Kf1 d5 10. Nc5 Be1 ' +
    '11. Kxe1 e5 12. Nxb7 Qf6 13. dxe5 Qe6 14. Qd3 O-O 15. Qc3 Ne7 16. Qxc7 Qxh3 17. gxh3 Nf5 18. Bd7 a5 19. Bxf5 a4 20. b4 axb3';
const USER_GAME_UCI = ['e2e4', 'd7d6', 'f1b5', 'b8c6', 'h2h3', 'g8f6', 'b1c3', 'f6e4', 'c3e4', 'c8h3', 'h1h3', 'e7e6', 'd2d4', 'f8e7', 'f2f4', 'e7h4',
    'e1f1', 'd6d5', 'e4c5', 'h4e1', 'f1e1', 'e6e5', 'c5b7', 'd8f6', 'd4e5', 'f6e6', 'd1d3', 'e8g8', 'd3c3', 'c6e7', 'c3c7', 'e6h3', 'g2h3', 'e7f5',
    'b5d7', 'a7a5', 'd7f5', 'a5a4', 'b2b4', 'a4b3'];
const USER_GAME_FEN = 'r4rk1/1NQ2ppp/8/3pPB2/5P2/1p5P/P1P5/R1B1K1N1 w - - 0 21';

// gameLogic.js + aiPlayer.js + battle3d/rules.js + savegame.js in one vm context (chessReference.loadGame
// plus the module). E.SG is the SaveGame global; plain() turns its results into host objects.
function loadSaveGame(options = {}) {
    const E = loadGame(options);
    vm.runInContext(source('savegame.js'), E.ctx, { filename: 'savegame.js' });
    E.SG = E.ctx.SaveGame;
    // Applies a long algebraic move without building a result object (E.apply returns the MoveEvent)
    E.run('function __move(a, b, c, d, p) { battle3dApplyMove({ row: a, col: b }, { row: c, col: d }, p); }');
    E.move = (uci) => E.ctx.__move(8 - Number(uci[1]), uci.charCodeAt(0) - 97, 8 - Number(uci[3]), uci.charCodeAt(2) - 97, uci[4] ? uci[4].toUpperCase() : null);
    E.newGame();
    return E;
}
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// What localStorage offers, in memory. `fail` makes setItem throw (a full or blocked storage).
function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    const storage = {
        fail: false,
        data,
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem(key, value) { if (storage.fail) throw new Error('QuotaExceededError'); data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
        json: (key) => JSON.parse(data.get(key)),
    };
    return storage;
}

const pad = (n) => String(n).padStart(2, '0');
const pgnDate = (time) => { const d = new Date(time); return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`; };

// PGN of a chess.js game (with at least one move) carrying the tags the app writes. Two known differences
// to chess.js are evened out here: it prints a black first move as "12. ... Kd7" (the PGN standard and
// the app: "12... Kd7") and it ends without a newline.
function referencePgn(chess, { event, site, date, white, black, result }) {
    const tags = { Event: event, Site: site, Date: date, Round: '-', White: white, Black: black, Result: result };
    for (const [name, value] of Object.entries(tags)) chess.setHeader(name, value);
    return `${chess.pgn({ newline: '\n', maxWidth: 0 }).replace(/^(\d+)\. \.\.\. /m, '$1... ')}\n`;
}

// Result string of a chess.js position, by the same rules the game ends on
function referenceResult(chess) {
    if (chess.isCheckmate()) return chess.turn() === 'w' ? '0-1' : '1-0';
    if (chess.isStalemate() || chess.isInsufficientMaterial() || chess.isThreefoldRepetition() || chess.isDrawByFiftyMoves()) return '1/2-1/2';
    return '*';
}

// The 2D page (2d.html in jsdom) with every script the page loads. loadDom() evaluates a fixed list (rules,
// AI, battle scenes, ui.js); the page's other classic scripts are added here in page order, after the game
// has started, which is also when the real page runs saves2d.js's setup. Options as for loadDom().
async function load2dPage(options = {}) {
    const { loadDom } = require('./loadDom');
    const { page2d } = require('./pages');
    const D = await loadDom(options);
    if (!D.w.SaveHost) {
        const html = fs.readFileSync(path.join(ROOT, page2d()), 'utf8');
        const scripts = [...html.matchAll(/<script\b(?![^>]*type=)[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]).filter((src) => !/^(https?:)?\/\//.test(src));
        for (const src of scripts) if (!LOADDOM_SCRIPTS.includes(src)) D.g(source(src), src);
        await D.sleep(0);
    }
    D.storage = () => Object.fromEntries(Array.from({ length: D.w.localStorage.length }, (_, i) => [D.w.localStorage.key(i), D.w.localStorage.getItem(D.w.localStorage.key(i))]));
    return D;
}
const LOADDOM_SCRIPTS = ['gameLogic.js', 'aiPlayer.js', 'aiClient.js', 'battleFx.js', 'ui.js'];

// --- Seeded random games: export against the reference, import back -----------------------------------

const SETUPS = [
    'r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R b KQkq - 4 9',      // Black first, all castling rights
    '6k1/PPPP4/8/8/8/8/pppp4/6K1 w - - 0 30',                                   // promotions on both sides
    '6k1/8/2n1n3/Q6Q/3n4/8/8/Q3K3 w - - 0 1',                                    // three queens, three knights
    'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3',            // en passant on the first move
    '1r2k2r/8/8/8/8/8/8/R3K1R1 w Qk - 10 40',                                   // castling rights partly lost
];
// Three queens that can all reach d4: the first move needs file and rank ("Qa1d4")
const THREE_QUEENS = { fen: '6k1/8/8/8/Q7/8/8/Q2Q3K w - - 0 1', first: ['a1d4'] };
// Every kind of move text a sweep has to have seen
const SWEEP_KINDS = ['setup', 'blackFirst', 'castleK', 'castleQ', 'enPassant', 'promo', 'under', 'check', 'mate', 'byFile', 'byRank', 'bySquare'];

// A seeded game in chess.js and in the game (E), preferring the rare moves (mates, castling, en passant,
// promotions) so a handful of games covers every kind of SAN. `first` are moves played before the random ones.
function randomGame(E, rand, { fen = null, first = [], plies = 90 } = {}) {
    const chess = new Chess(fen || START_FEN);
    if (fen) E.load(fen); else E.newGame();
    const moves = [];
    const pick = (list) => list[Math.floor(rand() * list.length)];
    for (let ply = 0; ply < plies && !chess.isGameOver(); ply++) {
        let m;
        if (first[ply]) {
            m = chess.move({ from: first[ply].slice(0, 2), to: first[ply].slice(2, 4), promotion: first[ply][4] });
        } else {
            // SAN strings only: chess.js builds two FENs per move for the verbose list, which is slow
            const legal = chess.moves();
            const mates = legal.filter((san) => san.endsWith('#'));
            const rare = legal.filter((san) => san.startsWith('O-O') || san.includes('=') ||
                (/^[a-h]x[a-h][36]/.test(san) && !chess.get(san.slice(2, 4)))); // a pawn takes onto an empty square: en passant
            m = chess.move(mates.length && rand() < 0.8 ? pick(mates) : rare.length && rand() < 0.5 ? pick(rare) : pick(legal));
        }
        const uci = m.from + m.to + (m.promotion || '');
        E.move(uci);
        moves.push({ uci, san: m.san, flags: m.flags, promotion: m.promotion });
    }
    return { chess, moves };
}

// Plays one random game per entry of `starts` ({ fen?, first? }) and checks, for each: the exported PGN is
// the reference PGN byte for byte, the record holds the moves and SAN of the reference, and importing our
// text and chess.js's own text gives the same moves, start, final position and result while the game in
// E stays untouched. Returns what the games contained.
function pgnSweep(E, { seed, starts, plies = 90 }) {
    const SG = E.SG;
    const rand = rng(seed);
    const started = new Date(2026, 9, 12, 18, 30).getTime();
    const meta = { mode: 'human-ai', humanColor: 'w', elo: 1200, startedAt: started, view: '3d' };
    const tags = { event: 'Chess Battle 3D', site: 'https://example.test' };
    const globals = () => E.run('JSON.stringify({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, currentMoveIndex, plies: gameHistory.length })');
    const seen = { games: 0, plies: 0, results: {} };
    for (const kind of SWEEP_KINDS) seen[kind] = 0;
    for (const [index, start] of starts.entries()) {
        const fen = start.fen || null;
        const game = randomGame(E, rand, { plies, ...start });
        const at = `game ${index} (${fen || 'start'})`;
        if (!game.moves.length) continue;
        const result = referenceResult(game.chess);
        const record = plain(SG.currentRecord(meta));
        const pgn = SG.toPgn(SG.currentRecord(meta), tags);
        assert.equal(pgn, referencePgn(game.chess, { ...tags, date: '2026.10.12', white: 'Human', black: 'AI (ELO 1200)', result }), `exported PGN, ${at}`);
        assert.equal(record.result, result, `result, ${at}`);
        assert.deepEqual(record.moves, game.moves.map((m) => m.uci), `stored moves, ${at}`);
        assert.deepEqual(record.san, game.moves.map((m) => m.san), `stored SAN, ${at}`);
        assert.equal(record.startFen, fen, `start position, ${at}`);

        const before = globals();
        for (const [name, text] of [['own', pgn], ['chess.js', game.chess.pgn()]]) {
            const read = plain(SG.fromPgn(text));
            assert.equal(read.ok, true, `import (${name}) ${at}: ${read.error}`);
            assert.deepEqual(read.record.moves, record.moves, `imported moves (${name}), ${at}`);
            assert.equal(read.record.fen, record.fen, `imported final position (${name}), ${at}`);
            assert.equal(read.record.startFen, fen, `imported start position (${name}), ${at}`);
            assert.equal(read.record.result, result, `imported result (${name}), ${at}`);
        }
        assert.equal(globals(), before, `fromPgn leaves the game untouched, ${at}`);

        seen.games++;
        seen.plies += game.moves.length;
        if (fen) seen.setup++;
        if (fen && fen.split(' ')[1] === 'b') seen.blackFirst++;
        seen.results[result] = (seen.results[result] || 0) + 1;
        for (const m of game.moves) {
            if (m.san.startsWith('O-O-O')) seen.castleQ++; else if (m.san.startsWith('O-O')) seen.castleK++;
            if (m.flags.includes('e')) seen.enPassant++;
            if (m.promotion) { seen.promo++; if (m.promotion !== 'q') seen.under++; }
            if (m.san.endsWith('+')) seen.check++;
            if (m.san.endsWith('#')) seen.mate++;
            if (/^[QRBN][a-h][1-8]x?[a-h][1-8]/.test(m.san)) seen.bySquare++;
            else if (/^[QRBN][a-h]x?[a-h][1-8]/.test(m.san)) seen.byFile++;
            else if (/^[QRBN][1-8]x?[a-h][1-8]/.test(m.san)) seen.byRank++;
        }
    }
    return seen;
}

module.exports = {
    SETUPS, THREE_QUEENS, SWEEP_KINDS, randomGame, pgnSweep,
    Chess, START_FEN, USER_GAME_MOVETEXT, USER_GAME_UCI, USER_GAME_FEN,
    loadSaveGame, load2dPage, plain, memoryStorage, referencePgn, referenceResult, pgnDate,
};
