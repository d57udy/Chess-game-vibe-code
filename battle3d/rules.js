// --- START OF FILE battle3d/rules.js ---

// Move application for the 3D battle prototype. Classic script (no modules, no DOM) that runs on
// the gameLogic.js globals, mirroring ui.js makeMove() + finishMoveProcessing() but applying the
// whole move at once and returning a MoveEvent the 3D view animates (see battle3d/CONTRACT.md).
//
//   battle3dNewGame()                         reset to the start position, history = [start]
//   battle3dApplyMove(from, to, promotion)    -> MoveEvent, throws on an illegal move
//   battle3dGameStatus()                      -> { over, result, winner, message, inCheck }
//   battle3dUndo(plies)                       -> number of plies actually undone
//   battle3dFen()                             -> FEN of the current position
//   battle3dState()                           -> live { board, currentPlayer, gameHistory, currentMoveIndex, isGameOver }
//
// The gameLogic.js `let` globals are not properties of window, so ES modules read them through
// battle3dState() instead of globalThis.

function battle3dSideName(player) {
    return player === 'w' ? 'White' : 'Black';
}

function battle3dNewGame() {
    gameHistory = [];
    currentMoveIndex = -1;
    if (!parseFen(INITIAL_BOARD_FEN)) throw new Error('battle3d: could not parse the initial FEN');
    pushHistoryState({ truncate: false });
    const entry = gameHistory[currentMoveIndex];
    entry.lastMove = null;
    entry.statusMessage = battle3dGameStatus().message;
}

// Loads an arbitrary position as a fresh game (tests and debugging).
function battle3dLoadFen(fen) {
    gameHistory = [];
    currentMoveIndex = -1;
    if (!parseFen(fen)) throw new Error('battle3d: invalid FEN ' + fen);
    pushHistoryState({ truncate: false });
    gameHistory[currentMoveIndex].lastMove = null;
    gameHistory[currentMoveIndex].statusMessage = battle3dGameStatus().message;
}

function battle3dApplyMove(from, to, promotion = null) {
    const fromRow = from.row, fromCol = from.col, toRow = to.row, toCol = to.col;
    const piece = getPieceAt(fromRow, fromCol);
    if (!piece) throw new Error(`battle3d: no piece on (${fromRow}, ${fromCol})`);
    if (getPlayerForPiece(piece) !== currentPlayer) throw new Error(`battle3d: ${battle3dSideName(currentPlayer)} is to move`);
    const legalMove = generateLegalMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);
    if (!legalMove) throw new Error(`battle3d: illegal move (${fromRow}, ${fromCol}) -> (${toRow}, ${toCol})`);

    const mover = currentPlayer;
    const type = piece.toUpperCase();
    const capturedOnTarget = getPieceAt(toRow, toCol);
    const isCastling = type === 'K' && Math.abs(toCol - fromCol) === 2;
    const isEnPassant = type === 'P' && toCol !== fromCol && !capturedOnTarget &&
        enPassantTarget !== null && toRow === enPassantTarget.row && toCol === enPassantTarget.col;
    // An en passant victim stands beside the attacker, on the attacker's starting rank
    const victimSquare = isEnPassant ? { row: fromRow, col: toCol } : { row: toRow, col: toCol };
    const victimPiece = isEnPassant ? getPieceAt(fromRow, toCol) : capturedOnTarget;
    const promotionType = legalMove.isPromotion ? String(promotion || 'Q').toUpperCase() : null;
    if (promotionType && !'QRBN'.includes(promotionType)) throw new Error('battle3d: bad promotion piece ' + promotion);
    const placedPiece = promotionType ? (mover === 'w' ? promotionType : promotionType.toLowerCase()) : piece;

    // Notation needs the pre-move position (ambiguity check)
    let notation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedOnTarget, isEnPassant, isCastling);
    if (promotionType) notation += '=' + promotionType;
    const moveNumber = fullmoveNumber;

    let castling = null;
    if (isCastling) {
        const rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
        const rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        castling = { rookFrom: { row: fromRow, col: rookFromCol }, rookTo: { row: fromRow, col: rookToCol } };
    }

    // 1. Board
    if (isEnPassant) setPieceAt(fromRow, toCol, null);
    if (castling) {
        setPieceAt(fromRow, castling.rookTo.col, getPieceAt(fromRow, castling.rookFrom.col));
        setPieceAt(fromRow, castling.rookFrom.col, null);
    }
    setPieceAt(toRow, toCol, placedPiece);
    setPieceAt(fromRow, fromCol, null);

    // 2. Castling rights (king or rook moved, rook captured on its home square)
    if (piece === 'K') castlingRights.w.K = castlingRights.w.Q = false;
    if (piece === 'k') castlingRights.b.K = castlingRights.b.Q = false;
    if (piece === 'R' && fromRow === 7) {
        if (fromCol === 0) castlingRights.w.Q = false;
        if (fromCol === 7) castlingRights.w.K = false;
    }
    if (piece === 'r' && fromRow === 0) {
        if (fromCol === 0) castlingRights.b.Q = false;
        if (fromCol === 7) castlingRights.b.K = false;
    }
    if (capturedOnTarget === 'R' && toRow === 7) {
        if (toCol === 0) castlingRights.w.Q = false;
        if (toCol === 7) castlingRights.w.K = false;
    }
    if (capturedOnTarget === 'r' && toRow === 0) {
        if (toCol === 0) castlingRights.b.Q = false;
        if (toCol === 7) castlingRights.b.K = false;
    }

    // 3. En passant target
    enPassantTarget = (type === 'P' && Math.abs(toRow - fromRow) === 2)
        ? { row: (fromRow + toRow) / 2, col: fromCol }
        : null;

    // 4. Clocks
    halfmoveClock = (type === 'P' || victimPiece) ? 0 : halfmoveClock + 1;
    if (mover === 'b') fullmoveNumber++;

    // 5. Switch player and record the new position (truncates any undone future moves)
    currentPlayer = getOpponent(mover);
    pushHistoryState({ notation, moveNumber });
    const entry = gameHistory[currentMoveIndex];
    entry.lastMove = { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };

    // 6. Check / mate / draws (the new position is already in history for the repetition count)
    const status = battle3dGameStatus();
    const givesCheck = status.inCheck;
    const isMate = status.result === 'checkmate';
    entry.moveNotation = notation + (isMate ? '#' : givesCheck ? '+' : '');
    entry.statusMessage = status.message;

    return {
        color: mover,
        piece,
        from: { row: fromRow, col: fromCol },
        to: { row: toRow, col: toCol },
        captured: victimPiece ? { piece: victimPiece, square: victimSquare } : null,
        castling,
        promotion: promotionType,
        givesCheck,
        isMate,
        isAI: false,
        notation: entry.moveNotation,
        enPassant: isEnPassant
    };
}

// Evaluates the current position (side to move = currentPlayer). Also updates the gameLogic
// isGameOver / gameStatusMessage globals, like ui.js evaluateGameState().
function battle3dGameStatus() {
    const end = checkGameEndCondition();
    const inCheck = isKingInCheck(currentPlayer);
    let result = null, winner = null, message;
    if (end === 'checkmate') {
        result = 'checkmate';
        winner = getOpponent(currentPlayer);
        message = `Checkmate! ${battle3dSideName(winner)} wins.`;
    } else if (end === 'stalemate') {
        result = 'stalemate';
        message = 'Stalemate! Game is a draw.';
    } else if (halfmoveClock >= 100) {
        result = 'fifty-move';
        message = 'Draw by 50-move rule.';
    } else if (checkThreefoldRepetition()) {
        result = 'threefold';
        message = 'Draw by threefold repetition.';
    } else if (hasInsufficientMaterial()) {
        result = 'insufficient';
        message = 'Draw by insufficient material.';
    } else {
        message = inCheck ? `${battle3dSideName(currentPlayer)} is in check!` : `${battle3dSideName(currentPlayer)} to move.`;
    }
    isGameOver = result !== null;
    gameStatusMessage = message;
    return { over: isGameOver, result, winner, message, inCheck };
}

// Steps back `plies` positions (clamped to the start) and discards the undone moves.
function battle3dUndo(plies = 1) {
    const target = Math.max(0, currentMoveIndex - Math.max(0, plies | 0));
    const undone = currentMoveIndex - target;
    if (undone === 0) return 0;
    loadGameStateSnapshot(gameHistory[target]);
    currentMoveIndex = target;
    gameHistory = gameHistory.slice(0, target + 1);
    battle3dGameStatus();
    return undone;
}

function battle3dLastMove() {
    return gameHistory[currentMoveIndex]?.lastMove || null;
}

function battle3dState() {
    return { board, currentPlayer, gameHistory, currentMoveIndex, isGameOver };
}

function battle3dFen() {
    const state = { board, currentPlayer, castlingRights, enPassantTarget };
    return `${getBoardPositionString(state)} ${halfmoveClock} ${fullmoveNumber}`;
}

// --- END OF FILE battle3d/rules.js ---
