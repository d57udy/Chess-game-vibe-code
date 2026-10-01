'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, square } = require('../helpers/loadEngine');

// make/unmake on the gameLogic.js globals, mirroring ui.js makeMove + finishMoveProcessing.
// Promotions are expanded to all four pieces (getAllLegalMoves reports each promotion once).
const PERFT_HARNESS = `
function perftMake(m) {
    const snap = { b: board.map(r => [...r]), c: JSON.parse(JSON.stringify(castlingRights)), e: enPassantTarget, p: currentPlayer };
    const pc = board[m.from.row][m.from.col];
    const cap = board[m.to.row][m.to.col];
    if (m.isEnPassant) board[m.from.row][m.to.col] = null;
    if (m.isCastling) {
        const rf = m.to.col > m.from.col ? 7 : 0, rt = m.to.col > m.from.col ? m.to.col - 1 : m.to.col + 1;
        board[m.from.row][rt] = board[m.from.row][rf];
        board[m.from.row][rf] = null;
    }
    board[m.to.row][m.to.col] = m.isPromotion ? (currentPlayer === 'w' ? m.promo : m.promo.toLowerCase()) : pc;
    board[m.from.row][m.from.col] = null;
    updateCastlingRightsSim(pc, cap, m.from.row, m.from.col, m.to.row, m.to.col);
    enPassantTarget = (pc.toUpperCase() === 'P' && Math.abs(m.to.row - m.from.row) === 2) ? { row: (m.from.row + m.to.row) / 2, col: m.from.col } : null;
    currentPlayer = getOpponent(currentPlayer);
    return snap;
}
function perftUnmake(s) { board = s.b; castlingRights = s.c; enPassantTarget = s.e; currentPlayer = s.p; }
function perftMoves() {
    const out = [];
    for (const m of getAllLegalMoves(currentPlayer)) {
        if (m.isPromotion) { for (const p of 'QRBN') out.push({ ...m, promo: p }); } else out.push(m);
    }
    return out;
}
function perft(d) {
    if (d === 0) return 1;
    let n = 0;
    for (const m of perftMoves()) { const s = perftMake(m); n += perft(d - 1); perftUnmake(s); }
    return n;
}`;

// The standard perft suite (chessprogramming.org). Depths for the slow gameLogic.js generator are
// kept small; the engine generator is checked one ply deeper.
const PERFT = [
    ['initial', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281], 4, 4],
    ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603], 3, 4],
    ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624], 4, 5],
    ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333], 3, 4],
    ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487], 3, 4],
];

describe('perft', () => {
    const E = loadEngine();
    E.run(PERFT_HARNESS);
    for (const [name, fen, expected, logicDepth, engineDepth] of PERFT) {
        test(`${name}: gameLogic.js generator to depth ${logicDepth}`, () => {
            E.fen(fen);
            for (let d = 1; d <= logicDepth; d++) assert.equal(E.run(`perft(${d})`), expected[d - 1], `depth ${d}`);
        });
        test(`${name}: engine generator to depth ${engineDepth}`, () => {
            E.fen(fen);
            E.run('ChessAI.loadFromGlobals()');
            for (let d = 1; d <= engineDepth; d++) assert.equal(E.run(`ChessAI.perft(${d})`), expected[d - 1], `depth ${d}`);
        });
    }
});

describe('FEN', () => {
    const E = loadEngine();

    test('parses the initial position', () => {
        E.fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        assert.equal(E.run('board[0].join("")'), 'rnbqkbnr');
        assert.equal(E.run('board[7].join("")'), 'RNBQKBNR');
        assert.equal(E.run('board[4].every(p => p === null)'), true);
        assert.equal(E.run('currentPlayer'), 'w');
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: true }, b: { K: true, Q: true } });
        assert.equal(E.run('enPassantTarget'), null);
        assert.equal(E.run('halfmoveClock'), 0);
        assert.equal(E.run('fullmoveNumber'), 1);
    });

    test('parses side, partial castling, en passant square and clocks', () => {
        E.fen('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w Kq f6 0 3');
        assert.equal(E.run('currentPlayer'), 'w');
        assert.deepEqual(E.get('castlingRights'), { w: { K: true, Q: false }, b: { K: false, Q: true } });
        assert.deepEqual(E.get('enPassantTarget'), square('f6'));
        assert.equal(E.run('fullmoveNumber'), 3);
        E.fen('8/8/8/8/8/k7/1p6/7K b - - 17 60');
        assert.equal(E.run('currentPlayer'), 'b');
        assert.equal(E.run('halfmoveClock'), 17);
        assert.equal(E.run('fullmoveNumber'), 60);
    });

    test('ignores an en passant square on the wrong rank for the side to move', () => {
        E.fen('4k3/8/8/8/4P3/8/8/4K3 w - e3 0 1'); // e3 is only valid with Black to move
        assert.equal(E.run('enPassantTarget'), null);
        assert.ok(E.logs.warn.length > 0);
    });

    test('rejects malformed FEN strings', () => {
        const bad = [
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', // 5 fields
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1', // 7 ranks
            'rnbqkbnr/ppppxppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // bad piece
            'rnbqkbnr/ppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // short rank
            'rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', // too many empties
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1', // bad side
        ];
        for (const fen of bad) {
            E.set('__bad', fen);
            assert.equal(E.run('parseFen(__bad)'), false, fen);
        }
    });

    test('getBoardPositionString serializes the first four FEN fields (round trip)', () => {
        const fens = [
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
            'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w Kq f6 0 3',
            'rnbqkbnr/pppp1ppp/8/8/3Pp3/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 2',
            '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 b - - 0 1',
        ];
        for (const fen of fens) {
            E.fen(fen);
            const out = E.run('getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget })');
            assert.equal(out, fen.split(' ').slice(0, 4).join(' '));
            E.set('__pos', out + ' 0 1');
            assert.equal(E.run('parseFen(__pos)'), true);
            assert.equal(E.run('getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget })'), out);
        }
    });

    test('loadGameStateSnapshot deep-copies its input', () => {
        E.fen('4k3/8/8/8/8/8/8/R3K3 w Q - 3 9');
        const state = E.run('({ board: board.map(r => [...r]), currentPlayer, castlingRights: JSON.parse(JSON.stringify(castlingRights)), enPassantTarget, halfmoveClock, fullmoveNumber })');
        E.set('__state', state);
        E.run('loadGameStateSnapshot(__state); board[7][0] = null; castlingRights.w.Q = false;');
        assert.equal(state.board[7][0], 'R');
        assert.equal(state.castlingRights.w.Q, true);
        assert.equal(E.run('halfmoveClock'), 3);
        assert.equal(E.run('fullmoveNumber'), 9);
    });
});

describe('check, checkmate, stalemate', () => {
    const E = loadEngine();
    const end = (fen) => { E.fen(fen); return E.run('checkGameEndCondition()'); };

    test('fool\'s mate is checkmate', () => {
        assert.equal(end('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'), 'checkmate');
        assert.equal(E.run('isKingInCheck("w")'), true);
    });

    test('back rank mate', () => {
        assert.equal(end('R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1'), 'checkmate');
    });

    test('check that can be escaped is not game over', () => {
        assert.equal(end('4k3/8/8/8/8/8/8/4R1K1 b - - 0 1'), null);
        assert.equal(E.run('isKingInCheck("b")'), true);
    });

    test('stalemate', () => {
        assert.equal(end('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), 'stalemate');
        assert.equal(E.run('isKingInCheck("b")'), false);
        assert.equal(end('k7/2Q5/1K6/8/8/8/8/8 b - - 0 1'), 'stalemate');
    });

    test('pinned piece may not move off the pin line', () => {
        E.fen('4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1');
        assert.equal(E.run('generateLegalMoves(6, 4).length'), 0);
    });

    test('en passant that exposes the king is illegal', () => {
        // White Kb5, pawn c5; Black d7-d5 then ...; capturing c5xd6 would expose b5 king to h5 rook along rank 5.
        E.fen('8/8/8/1KPp3r/8/8/8/4k3 w - d6 0 2');
        const moves = E.get('generateLegalMoves(3, 2)');
        assert.equal(moves.some(m => m.isEnPassant), false);
    });

    test('castling is not allowed out of, through, or into check', () => {
        E.fen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
        let castles = E.get('generateLegalMoves(7, 4).filter(m => m.isCastling).map(m => m.col)').sort();
        assert.deepEqual(castles, [2, 6]);
        E.fen('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1'.replace('4k3', '4r1k1')); // e-file rook: king in check
        assert.equal(E.run('generateLegalMoves(7, 4).some(m => m.isCastling)'), false);
        E.fen('5rk1/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // f1 attacked: no O-O, O-O-O fine
        castles = E.get('generateLegalMoves(7, 4).filter(m => m.isCastling).map(m => m.col)');
        assert.deepEqual(castles, [2]);
        E.fen('2r3k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // c1 attacked: no O-O-O
        castles = E.get('generateLegalMoves(7, 4).filter(m => m.isCastling).map(m => m.col)');
        assert.deepEqual(castles, [6]);
        E.fen('1r4k1/8/8/8/8/8/8/R3K2R w KQ - 0 1'); // only b1 attacked: O-O-O still legal
        castles = E.get('generateLegalMoves(7, 4).filter(m => m.isCastling).map(m => m.col)').sort();
        assert.deepEqual(castles, [2, 6]);
    });
});

describe('insufficient material', () => {
    const E = loadEngine();
    const cases = [
        ['K v K', '8/8/8/4k3/8/8/8/4K3 w - - 0 1', true],
        ['K+B v K', '8/8/8/4k3/8/8/8/2B1K3 w - - 0 1', true],
        ['K+N v K', '8/8/8/4k3/8/8/8/1N2K3 w - - 0 1', true],
        ['K v K+N', '8/8/8/4k3/8/8/8/1n2K3 w - - 0 1', true],
        ['K+B v K+B, same-colored bishops (c1, b8 dark)', '1b6/8/8/4k3/8/8/8/2B1K3 w - - 0 1', true],
        ['K+B+B v K, bishops on the same color (c1, a3)', '8/8/8/4k3/8/B7/8/2B1K3 w - - 0 1', true],
        ['K+B v K+B, opposite-colored bishops (c1, c8)', '2b5/8/8/4k3/8/8/8/2B1K3 w - - 0 1', false],
        ['K+B v K+N', '1n6/8/8/4k3/8/8/8/2B1K3 w - - 0 1', false],
        ['K+N+N v K', '8/8/8/4k3/8/8/8/1N2KN2 w - - 0 1', false],
        ['K+B+B v K, opposite colors', '8/8/8/4k3/8/8/8/2BBK3 w - - 0 1', false],
        ['K+R v K', '8/8/8/4k3/8/8/8/R3K3 w - - 0 1', false],
        ['K+Q v K', '8/8/8/4k3/8/8/8/Q3K3 w - - 0 1', false],
        ['K+P v K', '8/8/8/4k3/8/8/P7/4K3 w - - 0 1', false],
    ];
    for (const [name, fen, draw] of cases) {
        test(`${name}: ${draw ? 'draw' : 'not a draw'}`, () => {
            E.fen(fen);
            assert.equal(E.run('hasInsufficientMaterial()'), draw);
        });
    }
});

describe('threefold repetition and 50-move clock', () => {
    const E = loadEngine();
    // Plays long-algebraic moves through the engine's rules and records history like ui.js does.
    function play(moves) {
        for (const mv of moves) {
            E.set('__m', { from: square(mv.slice(0, 2)), to: square(mv.slice(2, 4)), promotionPiece: mv[4] ? mv[4].toUpperCase() : null, isPromotion: !!mv[4] });
            assert.equal(E.run('ChessAI.applyMoveToGlobals(__m)'), true, 'legal: ' + mv);
            E.run('pushHistoryState({ notation: "x" })');
        }
    }
    function newGame(fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1') {
        E.fen(fen);
        E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
    }

    test('third occurrence of the start position is a draw', () => {
        newGame();
        play(['g1f3', 'g8f6', 'f3g1', 'f6g8']);
        assert.equal(E.run('checkThreefoldRepetition()'), false, 'second occurrence');
        play(['g1f3', 'g8f6', 'f3g1']);
        assert.equal(E.run('checkThreefoldRepetition()'), false);
        play(['f6g8']);
        assert.equal(E.run('currentMoveIndex'), 8);
        assert.equal(E.run('checkThreefoldRepetition()'), true, 'third occurrence');
    });

    test('the current position is counted once (two occurrences are not a draw)', () => {
        newGame();
        play(['b1c3', 'b8c6', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'c3b1', 'c6b8']);
        // Back at the start position for the second time (index 0 and 8).
        assert.equal(E.run('currentMoveIndex'), 8);
        assert.equal(E.run('checkThreefoldRepetition()'), false);
        play(['b1c3', 'b8c6']); // position after 1...Nc6: index 2, 6, 10
        assert.equal(E.run('checkThreefoldRepetition()'), true);
    });

    // Known simplification (engine and UI agree): the en passant square is part of the position
    // key after every double pawn push, even when no en passant capture is possible.
    test('a position right after a double pawn push differs from the same placement later', () => {
        newGame();
        play(['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
        assert.equal(E.run('checkThreefoldRepetition()'), false);
        play(['g1f3', 'g8f6', 'f3g1', 'f6g8']);
        assert.equal(E.run('checkThreefoldRepetition()'), true);
    });

    test('positions differing in castling rights are not repetitions', () => {
        newGame('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
        play(['e1f1', 'e8f8', 'f1e1', 'f8e8', 'e1f1', 'e8f8', 'f1e1', 'f8e8']);
        // Same piece placement as the start three times, but castling rights were lost.
        assert.equal(E.run('checkThreefoldRepetition()'), false);
        play(['e1f1', 'e8f8', 'f1e1', 'f8e8']);
        assert.equal(E.run('checkThreefoldRepetition()'), true);
    });

    test('halfmove clock counts quiet moves and resets on pawn moves and captures', () => {
        newGame('4k3/8/8/3p4/8/8/4P3/R3K3 w - - 40 30');
        play(['a1a2']);
        assert.equal(E.run('halfmoveClock'), 41);
        play(['e8d8']);
        assert.equal(E.run('halfmoveClock'), 42);
        assert.equal(E.run('fullmoveNumber'), 31);
        play(['e2e4']);
        assert.equal(E.run('halfmoveClock'), 0);
        play(['d5e4']);
        assert.equal(E.run('halfmoveClock'), 0);
    });
});

describe('algebraic notation', () => {
    const E = loadEngine();
    // Base SAN from gameLogic.getAlgebraicNotation (ui.js appends =Q and +/#).
    function san(fen, mv, flags = {}) {
        E.fen(fen);
        const from = square(mv.slice(0, 2)), to = square(mv.slice(2, 4));
        E.set('__a', [from.row, from.col, to.row, to.col]);
        E.set('__f', flags);
        return E.run(`(() => {
            const [fr, fc, tr, tc] = __a;
            const piece = getPieceAt(fr, fc);
            const target = getPieceAt(tr, tc);
            return getAlgebraicNotation(fr, fc, tr, tc, piece, target, !!__f.ep, !!__f.castle);
        })()`);
    }

    test('plain piece and pawn moves', () => {
        const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        assert.equal(san(start, 'e2e4'), 'e4');
        assert.equal(san(start, 'g1f3'), 'Nf3');
        assert.equal(san('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2', 'e4d5'), 'exd5');
        assert.equal(san('rnbqkbnr/ppp1pppp/8/3p4/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', 'd8d6'), 'Qd6');
        assert.equal(san('rnbqkbnr/ppp1pppp/8/3p4/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', 'd5e4'), 'dxe4');
    });

    test('file disambiguation (Nbd2), pieces on the same rank or different rank and file', () => {
        assert.equal(san('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1', 'b1d2'), 'Nbd2');
        assert.equal(san('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1', 'f3d2'), 'Nfd2');
        assert.equal(san('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1', 'f1d2'), 'Nfd2');
        assert.equal(san('4k3/8/8/8/8/8/8/R4RK1 w - - 0 1', 'a1d1'), 'Rad1');
    });

    test('rank disambiguation (R1e2) for pieces on the same file', () => {
        assert.equal(san('4k3/8/8/8/8/4R3/8/4R1K1 w - - 0 1', 'e1e2'), 'R1e2');
        assert.equal(san('4k3/8/8/8/8/4R3/8/4R1K1 w - - 0 1', 'e3e2'), 'R3e2');
    });

    test('file and rank disambiguation with capture (Qh4xe1)', () => {
        const fen = '8/8/8/8/4Q2Q/K7/8/k3r2Q w - - 0 1';
        assert.equal(san(fen, 'h4e1'), 'Qh4xe1');
        assert.equal(san(fen, 'e4e1'), 'Qexe1');
        assert.equal(san(fen, 'h1e1'), 'Q1xe1');
    });

    test('a pinned piece does not cause disambiguation', () => {
        // Nc3 is pinned by the a5 bishop, so only the g1 knight can reach e2.
        assert.equal(san('4k3/8/8/b7/8/2N5/8/4K1N1 w - - 0 1', 'g1e2'), 'Ne2');
    });

    test('castling, en passant and promotion base notation', () => {
        assert.equal(san('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1', { castle: true }), 'O-O');
        assert.equal(san('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1c1', { castle: true }), 'O-O-O');
        assert.equal(san('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8c8', { castle: true }), 'O-O-O');
        assert.equal(san('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', 'e5d6', { ep: true }), 'exd6');
        assert.equal(san('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8'), 'a8');
        assert.equal(san('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7b8'), 'axb8');
    });
});
