'use strict';
// Hunt for the reported symptom "a pawn captured another pawn sideways, not diagonally" at engine
// level. These checks do not go through chess.js: they state the geometry of pawn moves and the life
// cycle of the en passant target directly, for gameLogic.js + battle3d/rules.js, the ChessAI
// generator (aiPlayer.js) and battle3d/tactics.js.
//   - Every pawn move of every position of seeded playouts: one step forward on its file, two from
//     the start rank, or one step diagonally forward as a capture; never along its rank.
//   - Every applied move changes only the squares it may change, and a capture removes exactly the
//     piece the MoveEvent names (en passant: the pawn beside the capturer that just double-pushed).
//   - The en passant target exists for exactly one ply after a double push and survives undo, redo,
//     a state snapshot (the AI hand-off) and a FEN round trip unchanged.
//   - An en passant target that does not belong to the position (wrong side, wrong rank, no pawn in
//     front, from a hand-written FEN or state) never produces a move.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../helpers/loadEngine');
const R = require('../helpers/chessReference');
const { sq, sqName } = R;

const CORPUS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'rules-corpus.json'), 'utf8'));

const { EP_RICH } = R;

const G = R.loadGame({ client: true });
const A = R.loadAi();
let T;
before(async () => { T = await R.loadTactics(); });

// For every legal move of the current position: the squares whose content changed when it was applied.
G.run(`
function __audit() {
    const before = board.map(r => [...r]);
    return JSON.stringify({
        fen: battle3dFen(),
        target: enPassantTarget ? __sqn(enPassantTarget.row, enPassantTarget.col) : null,
        lastMove: battle3dLastMove(),
        moves: __legal().map(m => {
            const ev = battle3dApplyMove(m.from, m.to, m.uci[4] ? m.uci[4].toUpperCase() : null);
            const changed = {};
            for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
                if (board[r][c] !== before[r][c]) changed[__sqn(r, c)] = [before[r][c], board[r][c]];
            }
            const targetAfter = enPassantTarget ? __sqn(enPassantTarget.row, enPassantTarget.col) : null;
            battle3dUndo(1);
            return { uci: m.uci, piece: m.piece, isEnPassant: m.isEnPassant, ev, changed, targetAfter };
        }),
    });
}`);
const audit = () => JSON.parse(G.run('__audit()'));
const boardOf = (fen) => fen.split(' ')[0].split('/').map((row) => [...row].flatMap((ch) => (ch >= '1' && ch <= '8' ? Array(Number(ch)).fill(null) : [ch])));
const pieceAt = (board, name) => { const s = sq(name); return board[s.row][s.col]; };
const isWhite = (p) => p === p.toUpperCase();

// Geometry of one pawn move (from, to as square names) on `board`; returns 'push' | 'double' | 'capture' | 'enPassant'.
function classifyPawnMove(board, from, to, epTarget, at) {
    const f = sq(from), t = sq(to), pawn = pieceAt(board, from);
    const forward = isWhite(pawn) ? -1 : 1, startRow = isWhite(pawn) ? 6 : 1;
    const dRow = t.row - f.row, dCol = Math.abs(t.col - f.col);
    assert.notEqual(dRow, 0, `a pawn never moves along its rank, ${at}`);
    assert.ok(dRow === forward || dRow === 2 * forward, `a pawn only moves forward one or two ranks, ${at}`);
    const target = pieceAt(board, to);
    if (dCol === 0) {
        assert.equal(target, null, `a pawn does not capture straight ahead, ${at}`);
        if (dRow === forward) return 'push';
        assert.equal(f.row, startRow, `a double push starts on the pawn's start rank, ${at}`);
        assert.equal(board[f.row + forward][f.col], null, `a double push does not jump over a piece, ${at}`);
        return 'double';
    }
    assert.equal(dCol, 1, `a pawn changes file by one at most, ${at}`);
    assert.equal(dRow, forward, `a pawn captures one rank forward, ${at}`);
    if (target) {
        assert.notEqual(isWhite(target), isWhite(pawn), `a pawn captures enemy pieces only, ${at}`);
        return 'capture';
    }
    // A diagonal step onto an empty square is en passant: the target square of the last double push,
    // with the enemy pawn that made it standing beside the capturer.
    assert.equal(to, epTarget, `a diagonal pawn move to an empty square needs the en passant target, ${at}`);
    assert.equal(board[f.row][t.col], isWhite(pawn) ? 'p' : 'P', `the en passant victim is the enemy pawn beside the capturer, ${at}`);
    assert.equal(f.row, isWhite(pawn) ? 3 : 4, `en passant starts on the capturer's fifth rank, ${at}`);
    return 'enPassant';
}

describe('pawn moves and captures over seeded playouts', () => {
    test('no generator ever moves a pawn sideways; every capture removes exactly the named victim', (t) => {
        const rand = R.rng(0xE9A55);
        const seen = { positions: 0, pawnMoves: 0, capture: 0, enPassant: 0, double: 0, enPassantPlayed: 0 };
        for (let game = 0; game < 6; game++) {
            G.load(R.PLAYOUT_STARTS[game % R.PLAYOUT_STARTS.length]);
            for (let ply = 0; ply < 50; ply++) {
                const a = audit();
                if (a.moves.length === 0) break;
                const board = boardOf(a.fen), at0 = `${a.fen}`;
                const epFen = a.fen.split(' ')[3];
                assert.equal(epFen, a.target || '-', `FEN en passant field, ${at0}`);
                // The target exists exactly when the last move was a double pawn push, on the skipped square
                const last = a.lastMove;
                const lastPiece = last && board[last.to.row][last.to.col];
                const wasDouble = !!last && lastPiece && lastPiece.toUpperCase() === 'P' && Math.abs(last.to.row - last.from.row) === 2;
                assert.equal(a.target, wasDouble ? sqName((last.from.row + last.to.row) / 2, last.from.col) : null, `en passant target after the last move, ${at0}`);

                for (const m of a.moves) {
                    const from = m.uci.slice(0, 2), to = m.uci.slice(2, 4), at = `${at0} move ${m.uci}`;
                    const ev = m.ev;
                    let victimSquare = pieceAt(board, to) ? to : null;
                    if (m.piece.toUpperCase() === 'P') {
                        const kind = classifyPawnMove(board, from, to, a.target, at);
                        seen.pawnMoves++;
                        if (kind !== 'push') seen[kind]++;
                        assert.equal(m.isEnPassant, kind === 'enPassant', `generator flag isEnPassant, ${at}`);
                        assert.equal(ev.enPassant, kind === 'enPassant', `MoveEvent.enPassant, ${at}`);
                        if (kind === 'enPassant') {
                            victimSquare = to[0] + from[1];
                            // The victim is the pawn that just double-pushed, nothing else
                            assert.deepEqual(a.lastMove.to, sq(victimSquare), `the en passant victim made the last move, ${at}`);
                        }
                        assert.equal(m.targetAfter, kind === 'double' ? from[0] + (isWhite(m.piece) ? '3' : '6') : null, `en passant target after the move, ${at}`);
                    } else {
                        assert.equal(m.isEnPassant, false, `only pawns capture en passant, ${at}`);
                        assert.equal(ev.enPassant, false, `only pawns capture en passant, ${at}`);
                        assert.equal(m.targetAfter, null, `a piece move leaves no en passant target, ${at}`);
                    }
                    // MoveEvent: the captured piece and its square
                    const expectedCapture = victimSquare ? { piece: pieceAt(board, victimSquare), square: sq(victimSquare) } : null;
                    assert.deepEqual(ev.captured, expectedCapture, `MoveEvent.captured, ${at}`);
                    if (ev.captured) assert.notEqual(isWhite(ev.captured.piece), isWhite(m.piece), `captures take enemy pieces, ${at}`);
                    // Board: only the squares the move may touch changed
                    const allowed = new Set([from, to]);
                    if (victimSquare) allowed.add(victimSquare);
                    if (ev.castling) for (const s of [ev.castling.rookFrom, ev.castling.rookTo]) allowed.add(sqName(s.row, s.col));
                    for (const s of Object.keys(m.changed)) assert.ok(allowed.has(s), `square ${s} changed, ${at}`);
                    assert.deepEqual(m.changed[from], [m.piece, null], `the moving piece leaves its square, ${at}`);
                    if (victimSquare && victimSquare !== to) assert.deepEqual(m.changed[victimSquare], [pieceAt(board, victimSquare), null], `the en passant victim is removed, ${at}`);
                    const placed = ev.promotion ? (isWhite(m.piece) ? ev.promotion : ev.promotion.toLowerCase()) : m.piece;
                    assert.deepEqual(m.changed[to], [pieceAt(board, to), placed], `the moving piece arrives, ${at}`);
                }

                // The ChessAI generator and tactics.js: the same geometry for their pawn moves
                const tokens = a.fen.split(' ');
                for (const m of A.probe(a.fen).moves) {
                    if (m.piece.toUpperCase() !== 'P') { assert.equal(m.isEnPassant, false, `ChessAI flag, ${at0} ${m.uci}`); continue; }
                    const kind = classifyPawnMove(board, m.uci.slice(0, 2), m.uci.slice(2, 4), a.target, `ChessAI ${at0} move ${m.uci}`);
                    assert.equal(m.isEnPassant, kind === 'enPassant', `ChessAI flag isEnPassant, ${at0} ${m.uci}`);
                }
                const flat = T._internal.flat({ board });
                for (const m of T._internal.legalMoves(flat, tokens[1], a.target ? sq(a.target).row * 8 + sq(a.target).col : -1)) {
                    if (flat[m.from].toUpperCase() !== 'P') continue;
                    classifyPawnMove(board, sqName(m.from >> 3, m.from & 7), sqName(m.to >> 3, m.to & 7), a.target, `tactics.js ${at0}`);
                }

                seen.positions++;
                // Prefer en passant, then double pushes and captures, so the special cases come up often
                const ep = a.moves.filter((m) => m.isEnPassant);
                const doubles = a.moves.filter((m) => m.targetAfter);
                const captures = a.moves.filter((m) => m.ev.captured);
                const r = rand();
                const pool = ep.length && r < 0.7 ? ep : doubles.length && r < 0.6 ? doubles : captures.length && r < 0.8 ? captures : a.moves;
                const mv = pool[Math.floor(rand() * pool.length)];
                if (mv.isEnPassant) seen.enPassantPlayed++;
                G.apply(mv.uci);
            }
        }
        t.diagnostic(JSON.stringify(seen));
        assert.ok(seen.positions >= 200 && seen.pawnMoves >= 1500 && seen.capture >= 100 && seen.double >= 200, JSON.stringify(seen));
        assert.ok(seen.enPassant >= 10 && seen.enPassantPlayed >= 5, JSON.stringify(seen));
    });
});

describe('the reported game (20. b4 axb3)', () => {
    const line = CORPUS.lines.find((l) => l.name.startsWith('the reported game'));
    const moves = line.moves.split(' ');

    test('every move is legal for all three rule implementations and 20...axb3 takes the b4 pawn', () => {
        G.newGame();
        A.fen(R.START_FEN);
        const chess = new R.Chess();
        let ev = null;
        moves.forEach((mv, i) => {
            const at = `ply ${i + 1} ${mv}`;
            const r = R.refMoves(chess).get(mv);
            assert.ok(r, `legal by the reference, ${at}`);
            ev = G.apply(mv); // gameLogic.js generator + battle3d/rules.js (throws on an illegal move)
            A.set('__m', { from: sq(mv.slice(0, 2)), to: sq(mv.slice(2, 4)), isPromotion: false, promotionPiece: null });
            assert.equal(A.run('ChessAI.applyMoveToGlobals(__m)'), true, `legal for the ChessAI generator, ${at}`);
            chess.move({ from: r.from, to: r.to });
            assert.equal(G.run('battle3dFen()'), r.fen, `position after, ${at}`);
            assert.equal(A.run("getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) + ' ' + halfmoveClock + ' ' + fullmoveNumber"), r.fen, `ChessAI position after, ${at}`);
            assert.equal(ev.notation, r.san, `SAN, ${at}`);
        });
        // 20. b4 was a double push past the black pawn on a4; axb3 lands on b3 and takes the pawn on b4
        assert.equal(ev.notation, 'axb3');
        assert.equal(ev.enPassant, true);
        assert.deepEqual([ev.from, ev.to, ev.captured], [sq('a4'), sq('b3'), { piece: 'P', square: sq('b4') }]);
        for (const E of [G, A]) {
            assert.equal(E.run('getPieceAt(4, 1)'), null, 'b4 is empty');
            assert.equal(E.run('getPieceAt(5, 1)'), 'p', 'the black pawn stands on b3');
            assert.equal(E.run('getPieceAt(4, 0)'), null, 'a4 is empty');
        }
        assert.equal(G.run('battle3dFen()'), line.finalFen);
        // One ply earlier: the capture is the only en passant move, and only because of the double push
        G.undo(1);
        assert.deepEqual(G.legal().filter((m) => m.isEnPassant).map((m) => m.uci), ['a4b3']);
        G.undo(1);
        G.apply('b2b3'); // a single step instead
        assert.ok(!G.legal().some((m) => m.isEnPassant));
        assert.ok(G.legal().some((m) => m.uci === 'a4b3'), 'a4xb3 is then an ordinary capture');
    });
});

describe('en passant target life cycle', () => {
    const legal = () => G.legal().map((m) => m.uci);
    const target = () => G.state().ep;
    const play = (moves) => moves.split(' ').forEach((mv) => G.apply(mv));

    test('set by a double push, gone after the next move whatever it is', () => {
        G.newGame();
        assert.equal(target(), null);
        play('e2e4');
        assert.equal(target(), 'e3');
        play('a7a6');
        assert.equal(target(), null, 'a single push clears it and sets none');
        play('e4e5 d7d5');
        assert.equal(target(), 'd6');
        assert.ok(legal().includes('e5d6'));
        play('a2a3');
        assert.equal(target(), null);
        play('a6a5');
        assert.ok(!legal().includes('e5d6'), 'the right expired with the move not taken');
        assert.equal(G.run('battle3dFen()').split(' ')[3], '-');
    });

    test('a capture, a castling move and a promotion leave no target; a king or piece move neither', () => {
        for (const [fen, mv] of [
            ['4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4d5'],
            ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'],
            ['8/P7/8/8/8/8/8/k6K w - - 0 1', 'a7a8q'],
            ['4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'e1d2'],
            ['4k3/8/8/8/8/8/4P3/4K2R w - - 0 1', 'h1h3'],
        ]) {
            G.load(fen);
            G.apply(mv);
            assert.equal(target(), null, `${fen} ${mv}`);
        }
    });

    test('after the capture: capturer on the target square, victim gone, target cleared, nothing else moved', () => {
        G.load('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
        const ev = G.apply('e5f6');
        assert.equal(ev.enPassant, true);
        assert.deepEqual(ev.to, sq('f6'));
        assert.deepEqual(ev.captured, { piece: 'p', square: sq('f5') });
        assert.equal(ev.notation, 'exf6');
        assert.equal(G.run('battle3dFen()'), 'rnbqkbnr/ppp1p1pp/5P2/3p4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 3', 'the d5 pawn is untouched');
    });

    test('undo and redo restore the target and the right exactly', () => {
        G.newGame();
        play('e2e4 a7a6 e4e5 d7d5');
        const withRight = G.run('battle3dFen()');
        play('a2a3');
        assert.equal(G.undo(1), 1);
        assert.equal(G.run('battle3dFen()'), withRight);
        assert.equal(target(), 'd6');
        assert.ok(legal().includes('e5d6'), 'the right is back after undoing the move that let it expire');
        assert.equal(G.undo(1), 1);
        assert.equal(target(), null, 'before the double push there is no target');
        play('d7d6'); // another way: a single push
        assert.equal(target(), null);
        const ordinary = G.apply('e5d6'); // now an ordinary capture of the pawn on d6
        assert.equal(ordinary.enPassant, false);
        assert.deepEqual(ordinary.captured, { piece: 'p', square: sq('d6') });
        assert.equal(G.undo(2), 2);
        play('d7d5'); // redo the double push
        assert.equal(G.run('battle3dFen()'), withRight);
        const ev = G.apply('e5d6');
        assert.deepEqual(ev.captured, { piece: 'p', square: sq('d5') });
        assert.equal(G.undo(1), 1);
        assert.equal(G.run('battle3dFen()'), withRight, 'undoing the capture puts the pawn back beside the capturer');
        assert.equal(G.run('getPieceAt(3, 3)'), 'p');
        assert.equal(G.run('getPieceAt(2, 3)'), null);
    });

    test('a state snapshot (AI hand-off) and a FEN round trip carry the same right at every ply', () => {
        const worker = R.loadGame();
        const reloaded = R.loadGame();
        const rand = R.rng(77);
        let offered = 0;
        for (const start of [R.START_FEN, EP_RICH]) {
            G.load(start);
            for (let ply = 0; ply < 50; ply++) {
                const moves = G.legal();
                if (moves.length === 0) break;
                const uci = moves.map((m) => m.uci).sort();
                // aiClient.js snapshot -> structured clone -> aiWorker.js loadGameStateSnapshot
                worker.set('__s', JSON.parse(JSON.stringify(G.get('getCurrentGameStateSnapshot()'))));
                worker.run('loadGameStateSnapshot(__s)');
                assert.deepEqual(worker.legal().map((m) => m.uci).sort(), uci, `snapshot, ${G.run('battle3dFen()')}`);
                assert.equal(worker.run('battle3dFen()'), G.run('battle3dFen()'));
                // FEN out, FEN in
                reloaded.load(G.run('battle3dFen()'));
                assert.deepEqual(reloaded.legal().map((m) => m.uci).sort(), uci, `FEN reload, ${G.run('battle3dFen()')}`);
                assert.equal(reloaded.run('battle3dFen()'), G.run('battle3dFen()'));
                if (moves.some((m) => m.isEnPassant)) offered++;
                // Prefer double pushes that land beside an enemy pawn: the next position offers en passant
                const board = boardOf(G.run('battle3dFen()'));
                const setups = moves.filter((m) => {
                    const to = sq(m.uci.slice(2, 4));
                    return m.piece.toUpperCase() === 'P' && Math.abs(Number(m.uci[3]) - Number(m.uci[1])) === 2 &&
                        [to.col - 1, to.col + 1].some((c) => board[to.row][c] === (m.piece === 'P' ? 'p' : 'P'));
                });
                const pool = setups.length && rand() < 0.8 ? setups : moves;
                G.apply(pool[Math.floor(rand() * pool.length)].uci);
            }
        }
        assert.ok(offered >= 3, `en passant was offered in ${offered} positions`);
    });
});

describe('en passant is never offered when it should not be', () => {
    test('not to the side that just double-pushed (generators asked for the wrong colour)', () => {
        G.newGame();
        G.apply('e2e4'); // target e3 belongs to Black; White's d2 and f2 pawns stand diagonally below it
        const white = G.get("getAllLegalMoves('w')");
        assert.ok(white.length > 0);
        for (const m of white) {
            assert.equal(m.isEnPassant, false, JSON.stringify(m));
            if (m.piece === 'P') assert.equal(m.from.col, m.to.col, `no diagonal pawn move: ${JSON.stringify(m)}`);
        }
        const state = G.get('getCurrentGameStateSnapshot()');
        const b = T._internal.flat(state), ep = state.enPassantTarget.row * 8 + state.enPassantTarget.col;
        for (const m of T._internal.legalMoves(b, 'w', ep)) {
            if (b[m.from] === 'P') assert.equal(m.from & 7, m.to & 7, `tactics.js: no diagonal pawn move for the side that pushed (${m.from} -> ${m.to})`);
        }
        // Black, whose target it is, has no pawn beside e4 and gets nothing either
        assert.ok(G.legal().every((m) => !m.isEnPassant));
    });

    const BOGUS = [
        ['target on the wrong rank', '4k3/8/8/3pP3/8/8/8/4K3 w - d5 0 1'],
        ['target of the side to move (rank 3 with White to move)', '4k3/8/8/8/3Pp3/8/8/4K3 w - d3 0 1'],
        ['target of the side to move (rank 6 with Black to move)', '4k3/8/8/3pP3/8/8/8/4K3 b - d6 0 1'],
        ['no pawn in front of the target', '4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1'],
        ['an own piece in front of the target', '4k3/8/8/3NP3/8/8/8/4K3 w - d6 0 1'],
        ['an enemy piece that is not a pawn in front of the target', '4k3/8/8/3nP3/8/8/8/4K3 w - d6 0 1'],
        ['the target square is occupied', '4k3/8/3n4/3pP3/8/8/8/4K3 w - d6 0 1'],
        ['the start square behind the target is occupied', '4k3/3n4/8/3pP3/8/8/8/4K3 w - d6 0 1'],
        ['Black: an own piece in front of the target', '4k3/8/8/8/3np3/8/8/4K3 b - d3 0 1'],
    ];
    for (const [name, fen] of BOGUS) {
        test(`hand-written FEN: ${name}`, () => {
            G.load(fen);
            assert.equal(G.state().ep, null, 'parseFen drops the target');
            assert.equal(G.run('battle3dFen()').split(' ')[3], '-');
            const moves = G.legal();
            assert.ok(moves.every((m) => !m.isEnPassant));
            const board = boardOf(fen);
            for (const m of moves) if (m.piece.toUpperCase() === 'P') classifyPawnMove(board, m.uci.slice(0, 2), m.uci.slice(2, 4), null, `${fen} ${m.uci}`);
            assert.ok(A.probe(fen).moves.every((m) => !m.isEnPassant), 'ChessAI');
        });
    }

    test('hand-written state (bypassing parseFen): no generator takes anything but an enemy pawn', () => {
        // White pawn d5, white knight e5, target e6: "d5xe6 e.p." would remove White's own knight
        const cases = [
            ['4k3/8/8/3PN3/8/8/8/4K3 w - - 0 1', { row: 2, col: 4 }],
            ['4k3/8/8/3Pn3/8/8/8/4K3 w - - 0 1', { row: 2, col: 4 }],
            ['4k3/8/8/3P4/8/8/8/4K3 w - - 0 1', { row: 2, col: 4 }],
            ['4k3/8/8/8/3pN3/8/8/4K3 b - - 0 1', { row: 5, col: 4 }],
            ['4k3/8/8/8/8/8/3P4/4K3 w - - 0 1', { row: 5, col: 4 }], // a stale target of White's own push
        ];
        for (const [fen, target] of cases) {
            G.load(fen);
            const state = G.get('getCurrentGameStateSnapshot()');
            state.enPassantTarget = target;
            G.set('__s', state);
            G.run('loadGameStateSnapshot(__s)');
            const moves = G.legal();
            assert.ok(moves.every((m) => !m.isEnPassant), `gameLogic.js ${fen}`);
            const board = boardOf(fen);
            for (const m of moves) if (m.piece.toUpperCase() === 'P') classifyPawnMove(board, m.uci.slice(0, 2), m.uci.slice(2, 4), null, `${fen} ${m.uci}`);
            // ChessAI.loadState and tactics.js with the same state
            A.set('__s', state);
            assert.equal(A.run('ChessAI.loadState(__s, [])'), true);
            const engine = A.get('ChessAI.legalMoves().map(m => ChessAI.toGameMove(m))');
            assert.ok(engine.every((m) => !m.isEnPassant), `ChessAI ${fen}`);
            for (const m of engine) if (m.piece.toUpperCase() === 'P') classifyPawnMove(board, sqName(m.from.row, m.from.col), sqName(m.to.row, m.to.col), null, `ChessAI ${fen}`);
            const flat = T._internal.flat(state);
            for (const m of T._internal.legalMoves(flat, state.currentPlayer, target.row * 8 + target.col)) {
                if (flat[m.from].toUpperCase() === 'P') classifyPawnMove(board, sqName(m.from >> 3, m.from & 7), sqName(m.to >> 3, m.to & 7), null, `tactics.js ${fen}`);
            }
        }
    });

    test('battle3dApplyMove refuses the sideways capture and the stale en passant capture', () => {
        G.load('4k3/8/8/8/3pP3/8/8/4K3 w - - 0 1'); // pawns side by side
        const before = G.run('battle3dFen()');
        for (const mv of ['e4d4', 'e4d5', 'e4d3', 'e4f4']) assert.throws(() => G.apply(mv), /illegal move/, mv);
        assert.equal(G.run('battle3dFen()'), before);
        G.newGame();
        'e2e4 a7a6 e4e5 d7d5 a2a3 a6a5'.split(' ').forEach((mv) => G.apply(mv));
        assert.throws(() => G.apply('e5d6'), /illegal move/);
    });
});

describe('castling rights from a hand-written FEN', () => {
    const CASES = [
        ['king not on its home square', '4k3/8/8/8/8/8/4K2R/8 w K - 0 1', '-', ['e2g2']],
        ['no rooks', '4k3/8/8/8/8/8/8/4K3 w KQ - 0 1', '-', ['e1g1', 'e1c1']],
        ['one rook missing', 'r3k2r/8/8/8/8/8/8/4K2R w KQkq - 0 1', 'Kkq', ['e1c1']],
        ['Black king moved', 'r2k3r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'KQ', ['d8f8', 'd8b8']],
        ['an enemy rook on the home square', '4k3/8/8/8/8/8/8/r3K2R w KQ - 0 1', 'K', ['e1c1']],
    ];
    for (const [name, fen, rights, mustNot] of CASES) {
        test(name, () => {
            G.load(fen);
            assert.equal(G.run('battle3dFen()').split(' ')[2], rights);
            const moves = G.legal();
            assert.ok(moves.every((m) => !m.isCastling || rights !== '-'));
            for (const mv of mustNot) assert.ok(!moves.some((m) => m.uci === mv), `gameLogic.js must not allow ${mv}`);
            const engine = A.probe(fen).moves;
            for (const mv of mustNot) assert.ok(!engine.some((m) => m.uci === mv), `ChessAI must not allow ${mv}`);
        });
    }

    test('hand-written state with rights but the king elsewhere: no castling', () => {
        G.load('4k3/8/8/8/8/8/4K2R/8 w - - 0 1');
        const state = G.get('getCurrentGameStateSnapshot()');
        state.castlingRights.w.K = true;
        G.set('__s', state);
        G.run('loadGameStateSnapshot(__s)');
        assert.ok(G.legal().every((m) => !m.isCastling && m.uci !== 'e2g2'));
        A.set('__s', state);
        A.run('ChessAI.loadState(__s, [])');
        assert.ok(A.get('ChessAI.legalMoves().map(m => ChessAI.toGameMove(m))').every((m) => !m.isCastling));
    });
});
