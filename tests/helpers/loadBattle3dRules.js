// Loads gameLogic.js + aiPlayer.js + battle3d/rules.js into a node:vm context (the browser load
// order from battle3d/CONTRACT.md), plus a reference move application that mirrors ui.js
// makeMove + finishMoveProcessing without the DOM, so rules.js can be compared ply by ply.
'use strict';
const vm = require('node:vm');
const { loadEngine, source, square, squareName } = require('./loadEngine');

// ui.js makeMove + finishMoveProcessing + evaluateGameState, minus animation, sound and rendering.
// Returns the notation with its +/# suffix, or null for an illegal move.
const REFERENCE_HARNESS = `
function refApply(fromRow, fromCol, toRow, toCol, promotionChoice) {
    const piece = getPieceAt(fromRow, fromCol);
    if (!piece) return null;
    const legalMove = generateLegalMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);
    if (!legalMove) return null;
    if (legalMove.isPromotion && !promotionChoice) return null;
    const capturedOnTarget = getPieceAt(toRow, toCol);
    const isCastling = piece.toUpperCase() === 'K' && Math.abs(toCol - fromCol) === 2;
    const isEnPassant = piece.toUpperCase() === 'P' && toCol !== fromCol && !capturedOnTarget &&
        enPassantTarget !== null && toRow === enPassantTarget.row && toCol === enPassantTarget.col;
    const victimPiece = isEnPassant ? getPieceAt(fromRow, toCol) : capturedOnTarget;
    const promotionType = legalMove.isPromotion ? promotionChoice.toUpperCase() : null;
    const placedPiece = promotionType ? (currentPlayer === 'w' ? promotionType : promotionType.toLowerCase()) : piece;
    let notation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedOnTarget, isEnPassant, isCastling);
    if (promotionType) notation += '=' + promotionType;
    const playerWhoMoved = currentPlayer;
    const prevFullmove = fullmoveNumber;
    if (isEnPassant) setPieceAt(fromRow, toCol, null);
    if (isCastling) {
        const rookFromCol = toCol > fromCol ? 7 : 0, rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        setPieceAt(fromRow, rookToCol, getPieceAt(fromRow, rookFromCol));
        setPieceAt(fromRow, rookFromCol, null);
    }
    setPieceAt(toRow, toCol, placedPiece);
    setPieceAt(fromRow, fromCol, null);
    if (piece === 'K') castlingRights.w.K = castlingRights.w.Q = false;
    if (piece === 'k') castlingRights.b.K = castlingRights.b.Q = false;
    if (piece === 'R' && fromRow === 7) { if (fromCol === 0) castlingRights.w.Q = false; if (fromCol === 7) castlingRights.w.K = false; }
    if (piece === 'r' && fromRow === 0) { if (fromCol === 0) castlingRights.b.Q = false; if (fromCol === 7) castlingRights.b.K = false; }
    if (victimPiece === 'R' && toRow === 7) { if (toCol === 0) castlingRights.w.Q = false; if (toCol === 7) castlingRights.w.K = false; }
    if (victimPiece === 'r' && toRow === 0) { if (toCol === 0) castlingRights.b.Q = false; if (toCol === 7) castlingRights.b.K = false; }
    enPassantTarget = (piece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2) ? { row: (fromRow + toRow) / 2, col: fromCol } : null;
    halfmoveClock = (piece.toUpperCase() === 'P' || victimPiece) ? 0 : halfmoveClock + 1;
    if (playerWhoMoved === 'b') fullmoveNumber++;
    currentPlayer = getOpponent(playerWhoMoved);
    pushHistoryState({ notation, moveNumber: prevFullmove });
    const end = checkGameEndCondition();
    const isCheck = isKingInCheck(currentPlayer);
    notation += end === 'checkmate' ? '#' : isCheck ? '+' : '';
    gameHistory[currentMoveIndex].moveNotation = notation;
    return notation;
}
function refNewGame() {
    parseFen(INITIAL_BOARD_FEN);
    gameHistory = []; currentMoveIndex = -1;
    pushHistoryState({ truncate: false });
}`;

// Full position string: placement, side, castling, ep, halfmove, fullmove (FEN field order).
const STATE_EXPR = `getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) + ' ' + halfmoveClock + ' ' + fullmoveNumber`;

/**
 * @param {object} [options]
 * @param {boolean} [options.rules=true] load battle3d/rules.js (false: reference only)
 * @returns loadEngine() API plus state(), apply(uci) for rules.js and refApply(uci) / refNewGame().
 */
function loadBattle3dRules(options = {}) {
    const E = loadEngine(options);
    if (options.rules !== false) vm.runInContext(source('battle3d/rules.js'), E.ctx, { filename: 'battle3d/rules.js' });
    E.run(REFERENCE_HARNESS);
    E.state = () => E.run(STATE_EXPR);
    // "e2e4" / "e7e8q" -> rules.js MoveEvent as a plain host object.
    E.apply = (mv) => {
        const f = square(mv.slice(0, 2)), t = square(mv.slice(2, 4));
        const promo = mv[4] ? JSON.stringify(mv[4].toUpperCase()) : 'null';
        return E.get(`battle3dApplyMove({ row: ${f.row}, col: ${f.col} }, { row: ${t.row}, col: ${t.col} }, ${promo})`);
    };
    E.refApply = (mv) => {
        const f = square(mv.slice(0, 2)), t = square(mv.slice(2, 4));
        const promo = mv[4] ? JSON.stringify(mv[4].toUpperCase()) : 'null';
        return E.run(`refApply(${f.row}, ${f.col}, ${t.row}, ${t.col}, ${promo})`);
    };
    E.refNewGame = () => E.run('refNewGame()');
    // Loads a FEN as a fresh game (history restarts at that position).
    E.position = (fen) => {
        E.fen(fen);
        E.run('gameHistory = []; currentMoveIndex = -1; pushHistoryState({ truncate: false });');
    };
    E.notations = () => E.get('gameHistory.slice(1, currentMoveIndex + 1).map(s => s.moveNotation)');
    return E;
}

// All legal moves of the side to move as uci strings, promotions expanded to q r b n.
const LEGAL_UCI_EXPR = `getAllLegalMoves(currentPlayer).flatMap(m => {
    const s = String.fromCharCode(97 + m.from.col) + (8 - m.from.row) + String.fromCharCode(97 + m.to.col) + (8 - m.to.row);
    return m.isPromotion ? ['q', 'r', 'b', 'n'].map(p => s + p) : [s];
})`;

// Small deterministic PRNG (mulberry32).
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


// Plays seeded random games through rules.js and, ply by ply, through the ui.js reference
// (full FEN + SAN) and ChessAI.applyMoveToGlobals (FEN without ep: the engine only records a
// capturable ep square). Throws an AssertionError on the first difference; returns move stats.
function randomPlayouts({ games, plies: maxPlies = 120, seed }) {
    const assert = require('node:assert/strict');
    const rand = rng(seed);
    const A = loadBattle3dRules();
    const R = loadBattle3dRules({ rules: false });
    const X = loadEngine();
    const XSTATE = `getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget: null }) + ' ' + halfmoveClock + ' ' + fullmoveNumber`;
    const stats = { plies: 0, captures: 0, castles: 0, eps: 0, promos: 0, endings: {} };
    for (let game = 0; game < games; game++) {
        A.run('battle3dNewGame()');
        R.refNewGame();
        X.fen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        for (let ply = 0; ply < maxPlies; ply++) {
            if (A.get('battle3dGameStatus()').over) break;
            const legal = A.get(LEGAL_UCI_EXPR);
            const mv = legal[Math.floor(rand() * legal.length)];
            const at = `game ${game} ply ${ply} ${mv}`;
            let ev;
            assert.doesNotThrow(() => { ev = A.apply(mv); }, at);
            assert.equal(ev.notation, R.refApply(mv), at);
            assert.equal(A.state(), R.state(), at);
            X.set('__m', { from: square(mv.slice(0, 2)), to: square(mv.slice(2, 4)), isPromotion: !!mv[4], promotionPiece: mv[4] ? mv[4].toUpperCase() : null });
            assert.equal(X.run('ChessAI.applyMoveToGlobals(__m)'), true, `engine rejects ${at}`);
            assert.equal(A.run(XSTATE), X.run(XSTATE), `engine state ${at}`);
            stats.plies++;
            if (ev.captured) stats.captures++;
            if (ev.castling) stats.castles++;
            if (ev.enPassant) stats.eps++;
            if (ev.promotion) stats.promos++;
        }
        const result = A.get('battle3dGameStatus()').result || 'unfinished';
        stats.endings[result] = (stats.endings[result] || 0) + 1;
        assert.deepEqual(A.notations(), R.notations(), `game ${game} notation`);
    }
    return stats;
}

module.exports = { loadBattle3dRules, randomPlayouts, REFERENCE_HARNESS, STATE_EXPR, LEGAL_UCI_EXPR, rng, square, squareName };
