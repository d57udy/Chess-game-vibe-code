'use strict';
// savegame.js (the view-agnostic save / load / export module) next to the game's own rules in a vm
// context, with chess.js as the PGN reference:
//   - PGN writer and parser round trip on seeded random games (castling, en passant, promotions and
//     underpromotions, checks, mates, disambiguation by file, rank and both, SetUp/FEN games, Black to
//     move first) and on the user's reported game,
//   - import tolerance (comments, NAGs, variations, "e.p.", 0-0, sloppy SAN) and rejection of illegal or
//     unreadable moves with the move number, nothing loaded,
//   - records: all-or-nothing replay, mid-game positions with en passant and partly lost castling rights,
//   - storage: format version, corrupt data, the cap of 30 saves, a failing storage,
//   - the session (autosave, resume, unsaved check) and the clipboard / share / download fallbacks.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { GLOBALS_EXPR } = require('../helpers/loadEngine');
const { rng } = require('../helpers/chessReference');
const {
    Chess, START_FEN, USER_GAME_MOVETEXT, USER_GAME_UCI, USER_GAME_FEN, SETUPS, THREE_QUEENS, SWEEP_KINDS,
    loadSaveGame, plain, memoryStorage, referencePgn, pgnDate, pgnSweep,
} = require('../helpers/saveGameHarness');

const E = loadSaveGame();
const SG = E.SG;
const STARTED = new Date(2026, 9, 12, 18, 30).getTime();
const META = { mode: 'human-ai', humanColor: 'w', elo: 1200, startedAt: STARTED, view: '3d' };
const TAGS = { event: 'Chess Battle 3D', site: 'https://example.test' };
const REF_TAGS = { ...TAGS, date: '2026.10.12', white: 'Human', black: 'AI (ELO 1200)' };

const apply = (uci) => E.move(uci);

// Plays UCI moves from a start position in the game and in chess.js
function play(moves, fen = null) {
    const chess = new Chess(fen || START_FEN);
    if (fen) E.load(fen); else E.newGame();
    for (const uci of moves) {
        chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        apply(uci);
    }
    return chess;
}
const record = (meta = META) => plain(SG.currentRecord(meta));
const exported = (meta = META) => SG.toPgn(SG.currentRecord(meta), TAGS);
// Rules state plus the status the views show (a rejected load must put all of it back)
const globals = () => E.run(GLOBALS_EXPR) + E.run('JSON.stringify([isGameOver, gameStatusMessage])');

describe('PGN export and import against chess.js', () => {
    test('seeded random games: exported PGN equals the reference, import gives the same moves and position', () => {
        const starts = [...Array(5).fill({}), ...SETUPS.map((fen) => ({ fen })), { fen: SETUPS[0] }, { fen: SETUPS[3] }, THREE_QUEENS];
        const seen = pgnSweep(E, { seed: 20261012, starts, plies: 80 });
        for (const key of SWEEP_KINDS) assert.ok(seen[key] > 0, `the random games cover "${key}": ${JSON.stringify(seen)}`);
        assert.ok(seen.results['1-0'] > 0 && seen.results['0-1'] > 0 && seen.results['*'] > 0, `decided and unfinished games: ${JSON.stringify(seen.results)}`);
        assert.ok(seen.games >= 12 && seen.plies > 500, JSON.stringify(seen));
    });

    test("the user's game: export equals the reference PGN, import reproduces the final position", () => {
        const chess = play(USER_GAME_UCI);
        const pgn = exported();
        assert.equal(pgn, referencePgn(chess, { ...REF_TAGS, result: '*' }));
        assert.equal(pgn, [
            '[Event "Chess Battle 3D"]', '[Site "https://example.test"]', '[Date "2026.10.12"]', '[Round "-"]',
            '[White "Human"]', '[Black "AI (ELO 1200)"]', '[Result "*"]', '', `${USER_GAME_MOVETEXT} *`, '',
        ].join('\n'));
        assert.equal(pgn.split('\n').pop(), '', 'ends with a newline');
        assert.ok(!/e\.p\./.test(pgn), 'en passant carries no "e.p." in the PGN');
        E.newGame();
        for (const text of [pgn, USER_GAME_MOVETEXT, `${USER_GAME_MOVETEXT} e.p.`]) {
            const read = plain(SG.fromPgn(text));
            assert.equal(read.ok, true, read.error);
            assert.deepEqual(read.record.moves, USER_GAME_UCI);
            assert.equal(read.record.fen, USER_GAME_FEN);
            assert.equal(read.record.san[39], 'axb3', 'the en passant capture is stored as plain SAN');
        }
        assert.deepEqual(plain(SG.fromPgn(pgn)).record.mode, 'human-ai', 'the game settings come back from the White / Black tags');
        assert.equal(plain(SG.fromPgn(pgn)).record.elo, 1200);
    });

    test('tags: players by mode and side, date, SetUp/FEN only for other start positions, escaping', () => {
        play(['e2e4', 'e7e5']);
        const tag = (pgn, name) => new RegExp(`^\\[${name} "(.*)"\\]$`, 'm').exec(pgn)?.[1];
        const black = SG.toPgn(SG.currentRecord({ ...META, humanColor: 'b', elo: 2400 }), TAGS);
        assert.deepEqual([tag(black, 'White'), tag(black, 'Black')], ['AI (ELO 2400)', 'Human']);
        const two = SG.toPgn(SG.currentRecord({ ...META, mode: 'human-human' }), TAGS);
        assert.deepEqual([tag(two, 'White'), tag(two, 'Black')], ['Human', 'Human']);
        const ais = SG.toPgn(SG.currentRecord({ ...META, mode: 'ai-ai', elo: 800 }), TAGS);
        assert.deepEqual([tag(ais, 'White'), tag(ais, 'Black')], ['AI (ELO 800)', 'AI (ELO 800)']);
        assert.equal(tag(two, 'Date'), pgnDate(STARTED));
        assert.equal(tag(two, 'Site'), 'https://example.test');
        assert.ok(!/\[SetUp|\[FEN/.test(two), 'no SetUp/FEN for the usual start position');
        assert.equal(tag(SG.toPgn(SG.currentRecord(META), { event: 'A "quoted" \\ name', site: 'x' }), 'Event'), 'A \\"quoted\\" \\\\ name');
        assert.equal(plain(SG.parsePgn(SG.toPgn(SG.currentRecord(META), { event: 'A "quoted" \\ name', site: 'x' }))).tags.Event, 'A "quoted" \\ name');
        // Settings come back from the tags
        assert.deepEqual((({ mode, humanColor, elo }) => ({ mode, humanColor, elo }))(plain(SG.fromPgn(black)).record), { mode: 'human-ai', humanColor: 'b', elo: 2400 });
        assert.equal(plain(SG.fromPgn(two)).record.mode, 'human-human');
        assert.equal(plain(SG.fromPgn(ais)).record.mode, 'ai-ai');
        assert.equal(plain(SG.fromPgn('[White "Carlsen"]\n[Black "Caruana"]\n\n1. e4 e5')).record.mode, null, 'other names say nothing about the mode');

        // A position game without moves still exports and imports
        const fen = SETUPS[4];
        play([], fen);
        const setup = exported();
        assert.equal(tag(setup, 'SetUp'), '1');
        assert.equal(tag(setup, 'FEN'), fen);
        assert.ok(setup.endsWith(']\n\n*\n'), 'tags, blank line, result');
        assert.equal(plain(SG.fromPgn(setup)).record.startFen, fen);
        play([]);
        assert.ok(exported().endsWith('[Result "*"]\n\n*\n'), 'a new game exports as an empty game');
    });

    test('results: mate for either side, stalemate and other draws', () => {
        play(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        assert.equal(record().result, '0-1');
        assert.ok(exported().endsWith('2. g4 Qh4# 0-1\n'));
        play(['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7']);
        assert.equal(record().result, '1-0');
        play(['g5g6'], '7k/5K2/8/6Q1/8/8/8/8 w - - 0 1'); // Qg6: stalemate
        assert.equal(E.state().end, 'stalemate');
        assert.equal(record().result, '1/2-1/2');
        assert.ok(exported().endsWith('1. Qg6 1/2-1/2\n'));
        play(['b2a1'], 'k7/8/8/8/8/8/1K6/n7 w - - 0 1'); // Kxa1: bare kings
        assert.equal(record().result, '1/2-1/2');
        play(['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
        assert.equal(record().result, '1/2-1/2', 'threefold repetition');
        // The 2D view may be showing an earlier position: the result is still the one of the last position
        const shown = E.run('JSON.stringify(gameHistory[3].board)');
        E.run('currentMoveIndex = 3; loadGameStateSnapshot(gameHistory[3]);');
        assert.deepEqual({ result: record().result, cursor: record().cursor, plies: record().moves.length }, { result: '1/2-1/2', cursor: 3, plies: 8 });
        assert.equal(E.run('JSON.stringify(board)'), shown, 'the shown position is put back');
        play(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
        E.run('currentMoveIndex = 1; loadGameStateSnapshot(gameHistory[1]);');
        assert.equal(record().result, '0-1', 'mate at the end, seen from move 1');
        assert.equal(E.run('battle3dFen()'), 'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/RNBQKBNR b KQkq - 0 1');
    });
});

describe('the game decides: repetition and start positions as the rules see them', () => {
    // After 1. e4 e5 the en passant square e6 is set but nobody can capture there, so the position after
    // 3...Ng8 and 5...Ng8 is the same position again (FIDE 9.2): a draw at ply 10, not one move later
    const LINE = ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const TEXT = '1. e4 e5 2. Nf3 Nf6 3. Ng1 Ng8 4. Nf3 Nf6 5. Ng1 Ng8';

    test('1. e4 e5 2. Nf3 Nf6 3. Ng1 Ng8 4. Nf3 Nf6 5. Ng1 Ng8 is a draw by repetition, saved, exported and imported as one', () => {
        play(LINE.slice(0, 9));
        assert.equal(record().result, '*', 'not yet after 5. Ng1');
        const chess = play(LINE);
        assert.equal(E.state().result, 'threefold', 'the live game says draw at ply 10');
        assert.equal(chess.isThreefoldRepetition(), true, 'so does the reference');
        assert.equal(record().result, '1/2-1/2');
        const pgn = exported();
        assert.equal(pgn, referencePgn(chess, { ...REF_TAGS, result: '1/2-1/2' }));
        assert.ok(pgn.includes('[Result "1/2-1/2"]') && pgn.endsWith(`${TEXT} 1/2-1/2\n`));

        // The 2D view showing an earlier position: same result, from the game's own repetition key
        const saved = record();
        for (const shown of [0, 2, 3, 9]) {
            E.run(`currentMoveIndex = ${shown}; loadGameStateSnapshot(gameHistory[${shown}]);`);
            const fen = E.run('battle3dFen()');
            assert.deepEqual({ result: record().result, cursor: record().cursor }, { result: '1/2-1/2', cursor: shown }, `while position ${shown} is shown`);
            assert.equal(E.run('battle3dFen()'), fen, 'the shown position is put back');
        }

        // Loaded and imported games get the result the live game had
        E.newGame();
        assert.equal(plain(SG.applyRecord(saved)).ok, true);
        assert.equal(E.state().result, 'threefold');
        assert.equal(record().result, '1/2-1/2');
        E.newGame();
        for (const text of [pgn, TEXT, `${TEXT} *`]) {
            const read = plain(SG.fromPgn(text));
            assert.deepEqual({ ok: read.ok, result: read.record.result, plies: read.record.moves.length }, { ok: true, result: '1/2-1/2', plies: 10 }, text);
        }
        assert.equal(plain(SG.fromPgn('1. e4 e5 2. Nf3 Nf6 3. Ng1 Ng8 4. Nf3 Nf6 5. Ng1')).record.result, '*');
    });

    test('a valid SetUp/FEN game keeps its start position, en passant square included', () => {
        E.newGame();
        const before = globals();
        const warned = E.logs.warn.length;
        const fen = 'rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3';
        const read = plain(SG.fromPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n3... dxe3 4. dxe3 Qxd1+ 5. Kxd1 *`));
        assert.deepEqual({ ok: read.ok, adjusted: read.adjusted, startFen: read.record.startFen, san: read.record.san },
            { ok: true, adjusted: false, startFen: fen, san: ['dxe3', 'dxe3', 'Qxd1+', 'Kxd1'] });
        assert.equal(read.record.moves[0], 'd4e3', 'the first move is the en passant capture');
        assert.equal(E.logs.warn.length, warned, 'the rules had nothing to correct');
        assert.equal(globals(), before);
        assert.equal(plain(SG.applyRecord(read.record)).ok, true);
        assert.match(exported(), /\[SetUp "1"\]\n\[FEN "rnbqkbnr\/ppp1pppp\/8\/8\/3pP3\/8\/PPPP1PPP\/RNBQKBNR b KQkq e3 0 3"\]\n\n3\.\.\. dxe3 4\. dxe3 Qxd1\+ 5\. Kxd1 \*\n$/);
        // Castling letters in another order are the same rights
        const order = plain(SG.fromPgn('[FEN "r3k2r/8/8/8/8/8/8/R3K2R w qkQK - 0 1"]\n\n1. O-O O-O-O'));
        assert.deepEqual({ ok: order.ok, adjusted: order.adjusted, startFen: order.record.startFen }, { ok: true, adjusted: false, startFen: 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1' });
    });

    test('a FEN tag with a bogus en passant square or castling right: the cleaned position is used and said so', () => {
        E.newGame();
        const before = globals();
        // d6 is not behind a pawn that just made a double step (there is a white knight on d5)
        const bogus = '[SetUp "1"]\n[FEN "4k3/8/8/3NP3/8/8/8/4K3 w - d6 0 1"]\n\n';
        const capture = plain(SG.fromPgn(`${bogus}1. exd6`));
        assert.deepEqual({ ok: capture.ok, moveNumber: capture.moveNumber, color: capture.color, san: capture.san }, { ok: false, moveNumber: 1, color: 'w', san: 'exd6' },
            'the "en passant" capture that square would have allowed is not legal');
        assert.match(capture.error, /^Move 1 for White \("exd6"\) is not a legal move in that position\. Nothing was loaded\.$/);
        const other = plain(SG.fromPgn(`${bogus}1. Nc7+ Kd7 2. e6+`));
        assert.deepEqual({ ok: other.ok, adjusted: other.adjusted, startFen: other.record.startFen, san: other.record.san },
            { ok: true, adjusted: true, startFen: '4k3/8/8/3NP3/8/8/8/4K3 w - - 0 1', san: ['Nc7+', 'Kd7', 'e6+'] });
        assert.equal(globals(), before);

        // What is saved and exported is the cleaned position, which then reads back unchanged
        assert.equal(plain(SG.applyRecord(other.record)).ok, true);
        assert.equal(E.get('gameHistory[0].enPassantTarget'), null);
        const pgn = exported();
        assert.ok(pgn.includes('[FEN "4k3/8/8/3NP3/8/8/8/4K3 w - - 0 1"]'));
        E.newGame();
        const again = plain(SG.fromPgn(pgn));
        assert.deepEqual({ ok: again.ok, adjusted: again.adjusted, moves: again.record.moves }, { ok: true, adjusted: false, moves: other.record.moves });

        // Castling right without the king on its home square
        const castle = '[FEN "4k3/8/8/8/8/8/4K2R/8 w K - 0 1"]\n\n';
        assert.equal(plain(SG.fromPgn(`${castle}1. O-O`)).ok, false);
        const rook = plain(SG.fromPgn(`${castle}1. Rh8+`));
        assert.deepEqual({ ok: rook.ok, adjusted: rook.adjusted, startFen: rook.record.startFen }, { ok: true, adjusted: true, startFen: '4k3/8/8/8/8/8/4K2R/8 w - - 0 1' });
        assert.deepEqual(E.logs.error, [], 'the rules warn about such a FEN, they do not fail');
    });
});

describe('PGN import: tolerant reading, strict legality', () => {
    const read = (text) => plain(SG.fromPgn(text));
    const moves = (text) => { const r = read(text); assert.equal(r.ok, true, `${text}: ${r.error}`); return r.record.san.join(' '); };

    test('comments, NAGs, variations, "e.p.", 0-0, annotations, numbering styles', () => {
        E.newGame();
        const ruy = 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7';
        assert.equal(moves('1. e4 {best by test} e5 $1 (1... c5 2. Nf3 (2. c3 d5) 2... d6) 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. 0-0 Be7 *'), ruy);
        assert.equal(moves('1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 4.Ba4 Nf6 5.O-O Be7'), ruy, 'no space after the move number');
        assert.equal(moves('1. e4 1... e5 2. Nf3 2... Nc6 3. Bb5 3. ... a6 4. Ba4 Nf6 5. o-o Be7 1/2-1/2'), ruy, 'black move numbers');
        assert.equal(moves('e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7'), ruy, 'bare moves');
        assert.equal(moves('1. e4! e5?! 2. Nf3!! Nc6 ?? 3. Bb5 ; the Spanish\n a6 4. Ba4 Nf6 5. O-O Be7'), ruy, 'annotations and a rest-of-line comment');
        assert.equal(moves('﻿[Event "x"]\r\n[Site "y"]\r\n\r\n1. e4 e5\r\n2. Nf3 Nc6\r\n% an escaped line\r\n3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7\r\n'), ruy, 'BOM, CRLF, % line');
        assert.equal(moves('1. e4 d5 2. e5 f5 3. exf6 e.p. Nxf6'), 'e4 d5 e5 f5 exf6 Nxf6', 'detached e.p.');
        assert.equal(moves('1. e4 d5 2. e5 f5 3. exf6e.p. Nxf6'), 'e4 d5 e5 f5 exf6 Nxf6', 'attached e.p.');
        assert.equal(moves('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 5. d3 0-0'), 'e4 e5 Nf3 Nc6 Bc4 Bc5 O-O Nf6 d3 O-O', 'zeros for castling');
        assert.equal(moves('1. d4 d5 2. Nc3 Nc6 3. Bf4 Bf5 4. Qd2 Qd7 5. 0-0-0 O-O-O'), 'd4 d5 Nc3 Nc6 Bf4 Bf5 Qd2 Qd7 O-O-O O-O-O');
    });

    test('sloppy SAN: missing x, extra disambiguation, long algebraic, promotion spellings, wrong check marks', () => {
        E.newGame();
        assert.equal(moves('1. e4 d5 2. ed5 Qd5 3. Nc3 Qd8'), 'e4 d5 exd5 Qxd5 Nc3 Qd8', 'captures without x');
        assert.equal(moves('1. Ng1f3 Ng8-f6 2. e2-e4 e7e5 3. Nbc3 Nb8c6'), 'Nf3 Nf6 e4 e5 Nc3 Nc6', 'more disambiguation than needed');
        assert.equal(moves('1. e4+ e5# 2. Nf3 Nc6'), 'e4 e5 Nf3 Nc6', 'check marks are recomputed, not trusted');
        const promo = '[SetUp "1"]\n[FEN "6k1/PPPP4/8/8/8/8/pppp4/6K1 w - - 0 30"]\n\n';
        assert.equal(moves(`${promo}30. a8Q+ Kg7 31. b8=n a1=Q+ 32. Kg2 b1R 33. c8B`), 'a8=Q+ Kg7 b8=N a1=Q+ Kg2 b1=R c8=B');
        assert.equal(read(`${promo}30. a8`).ok, false, 'a promotion needs its piece');
        assert.equal(moves('[FEN "6k1/PPPP4/8/8/8/8/pppp4/6K1 w - -"]\n\n1. a8=Q+'), 'a8=Q+', 'a FEN tag without clocks');
        assert.equal(read(`${promo}30. Kg2=Q`).ok, false);
    });

    test('an illegal or unreadable move stops the import with the move number and loads nothing', () => {
        play(['d2d4', 'd7d5']);
        const before = globals();
        const cases = [
            ['1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6 5. O-O Qd4 6. Nxd4 Ke7 7. Qh5 Kd6 8. Qxe5+ Kc5', { ply: 16, moveNumber: 8, color: 'b', san: 'Kc5' }, /Move 8 for Black \("Kc5"\) is not a legal move/],
            ['1. e4 e5 2. Ke3', { ply: 3, moveNumber: 2, color: 'w', san: 'Ke3' }, /Move 2 for White/],
            ['1. e4 e5 2. Nf3 Nc6 3. O-O', { ply: 5, moveNumber: 3, color: 'w', san: 'O-O' }, /Move 3 for White \("O-O"\) is not a legal move/],
            ['1. e4 e5 2. Zf3', { ply: 3, moveNumber: 2, color: 'w', san: 'Zf3' }, /Move 2 for White \("Zf3"\) is not a chess move/],
            ['1. e4 e5 2. Nf3 d6 3. Bb5+ Nc6 4. d4 Nxd4', { ply: 8, moveNumber: 4, color: 'b', san: 'Nxd4' }, /Move 4 for Black \("Nxd4"\) is not a legal move/], // pinned
            ['1. Nf3 Nf6 2. Nc3 Nc6 3. Nd4 e5 4. Nb5', { ply: 7, moveNumber: 4, color: 'w', san: 'Nb5' }, /Move 4 for White \("Nb5"\) could be more than one piece/],
        ];
        for (const [text, expected, message] of cases) {
            const r = read(text);
            assert.equal(r.ok, false, text);
            assert.deepEqual({ ply: r.ply, moveNumber: r.moveNumber, color: r.color, san: r.san }, expected, text);
            assert.match(r.error, message);
            assert.match(r.error, /Nothing was loaded\.$/);
            assert.equal(globals(), before, `the game is untouched after: ${text}`);
        }
        // Move numbers follow the FEN of a SetUp game
        const setup = read('[SetUp "1"]\n[FEN "r3k2r/pppq1ppp/2n2n2/3pp3/3PP3/2N2N2/PPPQ1PPP/R3K2R b KQkq - 4 9"]\n\n9... O-O 10. O-O-O Qd8 11. Kb1 Qd7 12. Kb2');
        assert.deepEqual({ ok: setup.ok, moveNumber: setup.moveNumber, color: setup.color, san: setup.san }, { ok: false, moveNumber: 12, color: 'w', san: 'Kb2' });
        assert.equal(globals(), before);
    });

    test('nothing to read, bad start positions, several games, junk', () => {
        E.newGame();
        const before = globals();
        for (const text of ['', '   \n', '[Event "x"]\n[Site "y"]\n', '{only a comment}', '*', null, undefined]) {
            const r = read(text);
            assert.equal(r.ok, false, JSON.stringify(text));
            assert.match(r.error, /No moves found/);
        }
        for (const fen of ['not a fen', '8/8/8/8/8/8/8/8 w - - 0 1', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1', 'k6R/8/8/8/8/8/8/K7 w - - 0 1', '9/8/8/8/8/8/8/Kk6 w - - 0 1']) {
            const r = read(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Kb2`);
            assert.equal(r.ok, false, fen);
            assert.match(r.error, /start position \(FEN\) of this game is not valid/, fen);
        }
        const two = read('[Event "one"]\n\n1. e4 e5 2. Nf3 1-0\n\n[Event "two"]\n\n1. d4 d5 0-1\n');
        assert.deepEqual({ ok: two.ok, moves: two.record.moves, more: two.more }, { ok: true, moves: ['e2e4', 'e7e5', 'g1f3'], more: true });
        assert.equal(read('1. e4 e5 2. Nf3 *').more, false);
        assert.equal(read('}}} ((( 1. e4 ))) ) e5 { open').ok, false, 'unbalanced brackets do not hang or load junk');
        assert.equal(read('}} ) 1. e4 e5').record.moves.length, 2);
        assert.equal(read('x'.repeat(5000)).ok, false);
        assert.equal(globals(), before);
        assert.deepEqual(E.logs.error, [], 'bad input is rejected before the rules log errors');
    });

    test('random text never throws, hangs or changes the game', () => {
        play(['e2e4', 'e7e5']);
        const before = globals();
        const rand = rng(77);
        const pieces = ['e4', 'e5', 'Nf3', 'Nc6', 'O-O', '0-0-0', 'exd5', 'e8=Q', 'Qh4#', '1.', '2...', '{', '}', '(', ')', ';', '\n', ' ', ' ', '[', ']', '"', '$3', '!?', '*', '1-0',
            '[FEN "8/8/8/8/8/8/8/K1k5 w - - 0 1"]', '[SetUp "1"]', 'e.p.', '%', '\\', 'Zz9', '--', '½-½'];
        let loaded = 0;
        for (let i = 0; i < 400; i++) {
            const text = Array.from({ length: 1 + Math.floor(rand() * 25) }, () => pieces[Math.floor(rand() * pieces.length)]).join(rand() < 0.7 ? ' ' : '');
            const r = read(text);
            assert.equal(typeof r.ok, 'boolean', text);
            if (r.ok) { loaded++; assert.ok(Array.isArray(r.record.moves), text); } else assert.equal(typeof r.error, 'string', text);
        }
        assert.ok(loaded > 0 && loaded < 400, `some of the random texts are games, most are not (${loaded})`);
        assert.equal(globals(), before);
    });
});

describe('records', () => {
    test('a mid-game position with en passant available and castling rights partly lost comes back exactly', () => {
        // White has castled rights only queenside (the h-rook moved), Black only kingside; d5 was just pushed past e5
        const line = ['e2e4', 'a7a5', 'e4e5', 'a8a6', 'h2h4', 'a6a8', 'h1h3', 'g8f6', 'h3h1', 'f6g8', 'g1f3', 'd7d5'];
        play(line);
        const fen = E.run('battle3dFen()');
        assert.equal(fen, 'rnbqkbnr/1pp1pppp/8/p2pP3/7P/5N2/PPPP1PP1/RNBQKB1R w Qk d6 0 7');
        const legal = JSON.stringify(E.legal().map((m) => m.uci).sort());
        assert.ok(legal.includes('"e5d6"'), 'en passant is on offer');
        const saved = record();
        assert.equal(saved.fen, fen);
        const stored = JSON.parse(JSON.stringify(saved));

        const F = loadSaveGame(); // a freshly opened page
        const applied = plain(F.SG.applyRecord(stored));
        assert.equal(applied.ok, true, applied.error);
        assert.equal(F.run('battle3dFen()'), fen, 'identical FEN: en passant square, castling rights, clocks');
        assert.equal(JSON.stringify(F.legal().map((m) => m.uci).sort()), legal, 'identical offered moves');
        assert.deepEqual(F.get('gameHistory.slice(1).map(h => h.moveNotation)'), E.get('gameHistory.slice(1).map(h => h.moveNotation)'));
        assert.deepEqual(F.get('gameHistory.map(h => h.lastMove || null)'), E.get('gameHistory.map(h => h.lastMove || null)'));
        assert.equal(F.get('currentMoveIndex'), line.length);
        F.apply('e5d6');
        assert.equal(F.get('gameHistory[currentMoveIndex].moveNotation'), 'exd6');
    });

    test('games from another start position, promotions and finished games round trip', () => {
        for (const [fen, line] of [
            [SETUPS[1], ['a7a8n', 'a2a1r', 'g1h2', 'b2b1b', 'b7b8q']],
            [SETUPS[0], ['e8c8', 'e1g1', 'd5e4']],
            [null, ['f2f3', 'e7e5', 'g2g4', 'd8h4']],
        ]) {
            play(line, fen);
            const saved = record();
            const state = E.state();
            E.newGame();
            assert.equal(plain(SG.applyRecord(saved)).ok, true);
            assert.deepEqual(E.state(), state, `position and result after loading ${line.join(' ')}`);
            assert.deepEqual(record().moves, line);
            assert.equal(record().startFen, fen);
        }
    });

    test('all or nothing: a record with an illegal move, a bad start or junk leaves the game as it was', () => {
        play(['e2e4', 'e7e5', 'g1f3']);
        const before = globals();
        const good = record();
        const cases = [
            [{ ...good, moves: ['e2e4', 'e7e5', 'e4e5'] }, /move 3 \(e4e5\) is not legal/, 3],
            [{ ...good, moves: ['e2e4', 'e2e4'] }, /move 2/, 2],
            [{ ...good, startFen: 'k6R/8/8/8/8/8/8/K7 w - - 0 1', moves: [] }, /start position is not valid/, 0],
            [{ ...good, v: 2 }, /cannot be read/, 0],
            [{ ...good, v: undefined }, /cannot be read/, 0],
            [{ ...good, moves: ['e2e4', 'castle'] }, /cannot be read/, 0],
            [{ ...good, moves: 'e2e4' }, /cannot be read/, 0],
            [{ ...good, startFen: 'junk' }, /cannot be read/, 0],
            [null, /cannot be read/, 0],
            ['{"v":1}', /cannot be read/, 0],
        ];
        for (const [raw, message, ply] of cases) {
            const r = plain(SG.applyRecord(raw));
            assert.equal(r.ok, false, JSON.stringify(raw));
            assert.match(r.error, message);
            assert.equal(r.ply, ply);
            assert.equal(globals(), before, `untouched after ${JSON.stringify(raw)?.slice(0, 80)}`);
        }
        assert.deepEqual(E.logs.error, []);
    });

    test('normalizeRecord keeps what it knows and drops the rest', () => {
        play(['e2e4', 'e7e5']);
        const good = record();
        const n = (raw) => plain(SG.normalizeRecord(raw));
        assert.deepEqual(n({ ...good, extra: 1, name: '  My   game  ', id: 'abc' }), { ...good, name: 'My game', id: 'abc' });
        assert.equal(n({ ...good, mode: 'blitz' }).mode, null);
        assert.equal(n({ ...good, result: 'won' }).result, '*');
        assert.equal(n({ ...good, san: ['e4'] }).san, null, 'SAN of the wrong length is not trusted');
        assert.equal(n({ ...good, startFen: START_FEN }).startFen, null);
        assert.equal(n({ ...good, cursor: 1 }).cursor, 1);
        assert.equal(n({ ...good, cursor: 2 }).cursor, undefined, 'a cursor at the end is the default');
        assert.equal(n({ ...good, name: 'x'.repeat(200) }).name.length, SG.MAX_NAME);
        assert.equal(n({ ...good, moves: Array(3000).fill('e2e4') }), null);
        assert.equal(SG.sameGame(good, { ...good, name: 'other', savedAt: 5 }), true);
        assert.equal(SG.sameGame(good, { ...good, moves: ['e2e4'] }), false);
        assert.equal(SG.sameGame(good, { ...good, startFen: SETUPS[0] }), false);
    });

    test('words for the list: default name, description, file name', () => {
        play(USER_GAME_UCI);
        const saved = { ...record(), savedAt: STARTED };
        assert.equal(SG.defaultName(saved, STARTED), '12 Oct, vs AI 1200');
        assert.equal(SG.defaultName({ ...saved, mode: 'human-human' }, STARTED), '12 Oct, 2 players');
        assert.equal(SG.defaultName({ ...saved, mode: 'ai-ai', elo: 800 }, STARTED), '12 Oct, AI vs AI 800');
        assert.equal(SG.describe(saved), '12 Oct 2026, 20 moves, in progress');
        assert.equal(SG.describe({ ...saved, moves: ['e2e4'], result: '1-0' }), '12 Oct 2026, 1 move, White won');
        assert.equal(SG.describe({ ...saved, result: '1/2-1/2' }), '12 Oct 2026, 20 moves, draw');
        assert.equal(SG.pgnFileName(saved), 'chess-2026-10-12-20-moves.pgn');
    });
});

describe('storage', () => {
    const game = (n = 2) => { play(['e2e4', 'e7e5', 'g1f3', 'b8c6'].slice(0, n)); return record(); };

    test('format: a version field on every record and on the list, documented keys', () => {
        const storage = memoryStorage();
        const store = SG.createStore(storage);
        const saved = game();
        assert.equal(saved.v, 1);
        assert.equal(SG.FORMAT_VERSION, 1);
        store.saveAutosave('3d', saved);
        store.saveAutosave('2d', saved);
        assert.equal(plain(store.save('First', saved)).ok, true);
        assert.deepEqual([...storage.data.keys()].sort(), ['chess.autosave.2d', 'chess.autosave.3d', 'chess.saves']);
        assert.equal(storage.json('chess.autosave.3d').v, 1);
        const list = storage.json('chess.saves');
        assert.equal(list.v, 1);
        assert.equal(list.saves.length, 1);
        assert.deepEqual(Object.keys(list.saves[0]).sort(), ['elo', 'fen', 'humanColor', 'id', 'mode', 'moves', 'name', 'result', 'san', 'savedAt', 'startFen', 'startedAt', 'v', 'view']);
        assert.deepEqual(list.saves[0].moves, ['e2e4', 'e7e5']);
        assert.deepEqual(list.saves[0].san, ['e4', 'e5']);
        assert.deepEqual(plain(store.loadAutosave('3d')), { record: saved, problem: null });
        store.saveAutosave('3d', null);
        assert.equal(storage.getItem('chess.autosave.3d'), null, 'null clears the slot');
        assert.deepEqual(plain(store.loadAutosave('3d')), { record: null, problem: null });
    });

    test('other versions are not read, corrupt data never throws, MIGRATIONS upgrades older data', () => {
        const saved = game();
        const cases = [
            [JSON.stringify({ ...saved, v: 2 }), 'version'],
            [JSON.stringify({ ...saved, v: 0 }), 'version'],
            [JSON.stringify({ ...saved, v: undefined }), 'corrupt'],
            ['{"v":1,"moves":["e2e4"', 'corrupt'],
            ['null', 'corrupt'], ['[]', 'corrupt'], ['"text"', 'corrupt'], ['42', 'corrupt'],
            [JSON.stringify({ ...saved, moves: ['e2e9'] }), 'corrupt'],
            [JSON.stringify({ ...saved, moves: null }), 'corrupt'],
            [JSON.stringify({ ...saved, startFen: 5 }), 'corrupt'],
        ];
        for (const [raw, problem] of cases) {
            const store = SG.createStore(memoryStorage({ 'chess.autosave.3d': raw, 'chess.saves': raw }));
            assert.deepEqual(plain(store.loadAutosave('3d')), { record: null, problem }, raw);
            assert.deepEqual(plain(store.list()), [], raw);
            assert.equal(typeof store.problem(), 'string', raw);
        }
        // An older format gets its migration step
        try {
            SG.MIGRATIONS[0] = (old) => ({ ...old, v: 1, moves: old.plies });
            const store = SG.createStore(memoryStorage({ 'chess.autosave.3d': JSON.stringify({ v: 0, plies: ['e2e4'] }) }));
            assert.deepEqual(plain(store.loadAutosave('3d')).record.moves, ['e2e4']);
        } finally {
            delete SG.MIGRATIONS[0];
        }
    });

    test('named saves: newest first, replace by name, rename, delete; damaged entries are dropped one by one', () => {
        const storage = memoryStorage();
        const store = SG.createStore(storage);
        const a = plain(store.save('Alpha', game(1)));
        const b = plain(store.save('  Beta  ', game(2)));
        assert.equal(a.ok && b.ok, true);
        const names = () => plain(store.list()).map((s) => s.name).sort();
        assert.deepEqual(names(), ['Alpha', 'Beta']);
        assert.equal(plain(store.get(b.id)).name, 'Beta', 'names are trimmed');
        assert.equal(plain(store.findByName('beta')).id, b.id);

        assert.deepEqual(plain(store.save('ALPHA', game(3))), { ok: false, error: 'exists', id: a.id }, 'same name, any case');
        assert.equal(plain(store.get(a.id)).moves.length, 1, 'not replaced without asking');
        assert.deepEqual(plain(store.save('ALPHA', game(3), { replace: true })), { ok: true, id: a.id, replaced: true });
        assert.equal(plain(store.get(a.id)).moves.length, 3);
        assert.equal(plain(store.list()).length, 2);

        assert.equal(plain(store.save('', game())).error, 'name');
        assert.equal(plain(store.save('   ', game())).error, 'name');
        assert.equal(plain(store.save('Gamma', null)).error, 'name');
        assert.deepEqual(plain(store.rename(a.id, 'Beta')), { ok: false, error: 'exists' });
        assert.deepEqual(plain(store.rename(a.id, '  ')), { ok: false, error: 'name' });
        assert.deepEqual(plain(store.rename('nope', 'X')), { ok: false, error: 'name' });
        assert.deepEqual(plain(store.rename(a.id, 'Alpha 2')), { ok: true });
        assert.deepEqual(names(), ['Alpha 2', 'Beta']);
        assert.deepEqual(plain(store.remove(a.id)), { ok: true });
        assert.deepEqual(plain(store.remove(a.id)), { ok: false, error: 'name' });
        assert.deepEqual(names(), ['Beta']);

        const list = storage.json('chess.saves');
        list.saves.push({ v: 1, id: 'x', name: 'Broken', moves: ['zz'] }, null, { ...list.saves[0], id: 'y', name: 'Fine too' });
        storage.setItem('chess.saves', JSON.stringify(list));
        assert.deepEqual(names(), ['Beta', 'Fine too']);
        assert.equal(store.problem(), null);
    });

    test('the cap: 30 saves, the 31st is refused, replacing still works', () => {
        const store = SG.createStore(memoryStorage());
        const saved = game();
        assert.equal(SG.MAX_SAVES, 30);
        assert.equal(store.max, 30);
        for (let i = 1; i <= 30; i++) assert.equal(plain(store.save(`Game ${i}`, saved)).ok, true, `save ${i}`);
        assert.deepEqual(plain(store.save('One too many', saved)), { ok: false, error: 'full' });
        assert.equal(plain(store.list()).length, 30);
        assert.equal(plain(store.save('Game 7', game(4), { replace: true })).ok, true, 'a full list still takes a replacement');
        assert.equal(plain(store.list()).length, 30);
        store.remove(plain(store.findByName('Game 1')).id);
        assert.equal(plain(store.save('Fits again', saved)).ok, true);
    });

    test('a missing, blocked or full storage never throws; unreadable saves are set aside, not deleted', () => {
        const saved = game();
        for (const storage of [null, { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } }]) {
            const store = SG.createStore(storage);
            assert.deepEqual(plain(store.loadAutosave('3d')), { record: null, problem: null });
            assert.equal(store.saveAutosave('3d', saved), false);
            assert.equal(store.saveAutosave('3d', null), true);
            assert.deepEqual(plain(store.list()), []);
            assert.deepEqual(plain(store.save('A', saved)), { ok: false, error: 'storage' });
        }
        const full = memoryStorage();
        const store = SG.createStore(full);
        assert.equal(plain(store.save('Kept', saved)).ok, true);
        full.fail = true;
        assert.deepEqual(plain(store.save('Lost', saved)), { ok: false, error: 'storage' });
        assert.equal(store.saveAutosave('3d', saved), false);
        assert.deepEqual(plain(store.list()).map((s) => s.name), ['Kept']);

        const newer = JSON.stringify({ v: 7, games: { a: 1 } });
        const storage = memoryStorage({ 'chess.saves': newer });
        const other = SG.createStore(storage);
        assert.equal(other.problem(), 'version');
        assert.equal(storage.getItem('chess.saves'), newer, 'reading does not touch it');
        assert.equal(plain(other.save('New list', saved)).ok, true);
        assert.equal(storage.getItem('chess.saves.unreadable'), newer, 'kept aside on the first write');
        assert.equal(other.problem(), null);
    });
});

describe('session (what a page does with it)', () => {
    // A host like the views: adopt() runs the load and remembers what it was asked
    function makeSession(storage, { busy = null } = {}) {
        const host = {
            view: '3d', title: 'Chess Battle 3D', site: 'https://example.test', storage,
            state: { mode: 'human-ai', humanColor: 'w', elo: 1200 },
            adopted: [],
            settings: () => host.state,
            busy: () => busy,
            adopt(apply, settings, options) {
                const result = apply();
                if (result.ok) Object.assign(host.state, settings);
                host.adopted.push({ ok: result.ok, settings, options });
                return result;
            },
        };
        return { host, session: SG.createSession(host) };
    }

    test('autosave after every change, resume on the next start, new game clears it', () => {
        const storage = memoryStorage();
        const { session } = makeSession(storage);
        E.newGame();
        session.autosave('newGame');
        assert.equal(storage.getItem('chess.autosave.3d'), null, 'an untouched new game is not stored');
        apply('e2e4');
        session.autosave('move');
        apply('c7c5');
        session.autosave('move');
        assert.deepEqual(storage.json('chess.autosave.3d').moves, ['e2e4', 'c7c5']);
        assert.equal(storage.json('chess.autosave.3d').mode, 'human-ai');
        const fen = E.run('battle3dFen()');

        // "Reopen": another page with the same storage
        const F = loadSaveGame();
        const again = { view: '3d', title: 't', storage, state: { mode: 'human-human', humanColor: 'b', elo: 400 } };
        again.settings = () => again.state;
        again.adopt = (apply, settings) => { const r = apply(); Object.assign(again.state, settings); return r; };
        const resumed = plain(F.SG.createSession(again).resume());
        assert.deepEqual(resumed, { resumed: true, notice: null });
        assert.equal(F.run('battle3dFen()'), fen);
        assert.deepEqual(again.state, { mode: 'human-ai', humanColor: 'w', elo: 1200 }, 'mode, side and AI strength come back with the game');

        E.newGame();
        session.autosave('newGame');
        assert.equal(storage.getItem('chess.autosave.3d'), null, 'New game clears the autosave');
        assert.deepEqual(plain(makeSession(storage).session.resume()), { resumed: false, notice: null });
    });

    test('corrupt, old-format or unplayable autosaves fall back to a new game with a short notice', () => {
        E.newGame();
        apply('e2e4');
        const good = record();
        for (const raw of ['{broken', JSON.stringify({ ...good, v: 0 }), JSON.stringify({ ...good, v: 9 }), JSON.stringify({ ...good, moves: ['e2e4', 'e2e4'] }), 'null', '{}']) {
            E.newGame();
            const before = globals();
            const { session, host } = makeSession(memoryStorage({ 'chess.autosave.3d': raw }));
            const r = plain(session.resume());
            assert.equal(r.resumed, false, raw);
            assert.equal(r.notice, 'Your saved game could not be read, so a new game was started.', raw);
            assert.ok(r.notice.length < 80, 'short');
            assert.equal(globals(), before, `the new game is untouched: ${raw}`);
            assert.ok(host.adopted.every((a) => !a.ok));
        }
        const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
        assert.deepEqual(plain(makeSession(throwing).session.resume()), { resumed: false, notice: null }, 'blocked storage: just a new game');
        assert.deepEqual(plain(makeSession(null).session.resume()), { resumed: false, notice: null });
    });

    test('save, load with settings, unsaved check, export text, import, busy view', () => {
        const storage = memoryStorage();
        const { session, host } = makeSession(storage);
        play(USER_GAME_UCI);
        assert.equal(session.unsaved(), true);
        assert.match(session.defaultName(), /^\d{1,2} [A-Z][a-z]{2}, vs AI 1200$/);
        const saved = plain(session.saveAs('Bug report'));
        assert.equal(saved.ok, true);
        assert.equal(session.unsaved(), false, 'a game that equals a named save is saved');
        assert.ok(session.pgn().includes('[Event "Chess Battle 3D"]') && session.pgn().includes('[Site "https://example.test"]'));
        assert.ok(session.pgn().endsWith(`${USER_GAME_MOVETEXT} *\n`));
        assert.equal(session.fen(), USER_GAME_FEN);
        assert.match(session.fileName(), /^chess-\d{4}-\d{2}-\d{2}-20-moves\.pgn$/);

        E.newGame();
        assert.equal(session.unsaved(), false, 'no moves, nothing to lose');
        apply('d2d4');
        assert.equal(session.unsaved(), true);
        host.state = { mode: 'human-human', humanColor: 'b', elo: 400 };
        const loaded = plain(session.load(session.store.get(saved.id), { review: true }));
        assert.equal(loaded.ok, true);
        assert.equal(E.run('battle3dFen()'), USER_GAME_FEN);
        assert.deepEqual(plain(host.adopted.pop()), { ok: true, settings: { mode: 'human-ai', humanColor: 'w', elo: 1200 }, options: { review: true, cursor: null } });
        assert.deepEqual(storage.json('chess.autosave.3d').moves, USER_GAME_UCI, 'the loaded game is the autosave now');

        const bad = plain(session.importPgn('1. e4 e5 2. Ke3'));
        assert.equal(bad.ok, false);
        assert.equal(bad.moveNumber, 2);
        assert.equal(E.run('battle3dFen()'), USER_GAME_FEN, 'a rejected import loads nothing');
        const good = plain(session.importPgn('1. d4 d5 2. c4', { review: false }));
        assert.deepEqual({ ok: good.ok, moves: good.record.moves }, { ok: true, moves: ['d2d4', 'd7d5', 'c2c4'] });
        assert.deepEqual(plain(host.adopted.pop().settings), {}, 'a game without our player tags keeps the current settings');

        const blocked = makeSession(storage, { busy: 'Wait until the move has finished, then try again.' }).session;
        assert.deepEqual(plain(blocked.load(session.store.get(saved.id))), { ok: false, error: 'Wait until the move has finished, then try again.' });
        assert.equal(plain(blocked.importPgn('1. e4')).ok, false);
        assert.equal(plain(blocked.readPgn('1. e4')).ok, false);
    });
});

describe('getting text out: clipboard, share sheet, download', () => {
    const fakeDocument = ({ copies = true } = {}) => {
        const doc = { appended: [], clicked: [], commands: [] };
        doc.createElement = (tag) => ({
            tag, style: {}, attrs: {}, removed: false,
            setAttribute(k, v) { this.attrs[k] = v; }, select() { this.selected = true; }, setSelectionRange() {},
            click() { doc.clicked.push(this); }, remove() { this.removed = true; },
        });
        doc.body = { append: (node) => doc.appended.push(node) };
        doc.execCommand = (name) => { doc.commands.push(name); if (copies === 'throw') throw new Error('no'); return copies; };
        return doc;
    };

    test('copyText: Clipboard API, then execCommand when it is missing or refuses, else a clean failure', async () => {
        const written = [];
        const ok = { clipboard: { writeText: async (t) => { written.push(t); } } };
        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: ok, document: fakeDocument() })), { ok: true, method: 'clipboard' });
        assert.deepEqual(written, ['pgn']);

        const denied = { clipboard: { writeText: async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; } } };
        const doc = fakeDocument();
        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: denied, document: doc })), { ok: true, method: 'execCommand' });
        assert.deepEqual(doc.commands, ['copy']);
        assert.equal(doc.appended[0].value, 'pgn');
        assert.ok(doc.appended[0].selected && doc.appended[0].removed, 'the helper field is selected, then removed');

        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: {}, document: fakeDocument() })), { ok: true, method: 'execCommand' }, 'no Clipboard API (http page)');
        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: denied, document: fakeDocument({ copies: false }) })), { ok: false, method: null });
        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: denied, document: fakeDocument({ copies: 'throw' }) })), { ok: false, method: null });
        assert.deepEqual(plain(await SG.copyText('pgn', { navigator: {}, document: {} })), { ok: false, method: null });
    });

    test('shareText: the share sheet when there is one; cancelling is not an error', async () => {
        const shared = [];
        assert.equal(SG.canShare({ navigator: {} }), false);
        assert.equal(SG.canShare({ navigator: { share() {} } }), true);
        assert.deepEqual(plain(await SG.shareText({ title: 'Chess', text: 'pgn' }, { navigator: { share: async (d) => { shared.push(d); } } })), { ok: true });
        assert.deepEqual(plain(shared), [{ title: 'Chess', text: 'pgn' }]);
        const failing = (name) => ({ share: async () => { const e = new Error(name); e.name = name; throw e; } });
        assert.deepEqual(plain(await SG.shareText({ text: 'pgn' }, { navigator: failing('AbortError') })), { ok: false, reason: 'cancelled' });
        assert.deepEqual(plain(await SG.shareText({ text: 'pgn' }, { navigator: failing('NotAllowedError') })), { ok: false, reason: 'failed' });
        assert.deepEqual(plain(await SG.shareText({ text: 'pgn' }, { navigator: {} })), { ok: false, reason: 'unavailable' });
    });

    test('downloadText: a Blob link, a data: link without Blob URLs', () => {
        const doc = fakeDocument();
        const urls = [];
        const URLApi = { createObjectURL: (blob) => { urls.push(blob); return 'blob:1'; }, revokeObjectURL() {} };
        class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options.type; } }
        assert.deepEqual(plain(SG.downloadText('game.pgn', '1. e4 *', { document: doc, URL: URLApi, Blob: FakeBlob })), { ok: true, method: 'blob' });
        assert.deepEqual([doc.clicked[0].href, doc.clicked[0].download, doc.clicked[0].removed], ['blob:1', 'game.pgn', true]);
        assert.deepEqual([urls[0].parts[0], urls[0].type], ['1. e4 *', 'application/vnd.chess-pgn']);

        const plainDoc = fakeDocument();
        assert.deepEqual(plain(SG.downloadText('game.pgn', '1. e4 e5 *', { document: plainDoc, URL: {}, Blob: undefined })), { ok: true, method: 'data' });
        assert.equal(plainDoc.clicked[0].href, 'data:application/vnd.chess-pgn;charset=utf-8,1.%20e4%20e5%20*');
        assert.deepEqual(plain(SG.downloadText('game.pgn', 'x', { document: {} })), { ok: false, method: null });
    });
});
