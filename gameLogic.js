// --- START OF FILE gameLogic.js ---

// --- Game Constants ---
const BOARD_SIZE = 8;
const PIECES = {
    // White
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
    // Black
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
};
const INITIAL_BOARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"; // Standard starting position

// --- Game State Variables (Managed Primarily Here) ---
let board = []; // 2D array representing the board [row][col]
let currentPlayer = 'w'; // 'w' for white, 'b' for black
let castlingRights = { w: { K: true, Q: true }, b: { K: true, Q: true } }; // Kingside/Queenside
let enPassantTarget = null; // Square behind a pawn that just moved two steps, e.g., { row: 2, col: 4 }
let halfmoveClock = 0; // For 50-move rule
let fullmoveNumber = 1; // Increments after black moves
let gameHistory = []; // Stores past game states { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, moveNotation, moveNumber, statusMessage }
let currentMoveIndex = -1; // Index in gameHistory, points to the *current* state
let isGameOver = false;
let gameStatusMessage = ""; // Initial status set in init or UI

// --- Helper function to determine if we're in AI mode (dependent on UI state) ---
// Note: aiDifficulty will be managed in ui.js or aiPlayer.js and passed where needed
// function isAIMode() {
//     return aiDifficulty >= 0;
// }

// --- FEN Parsing ---
function parseFen(fen) {
    console.log("Parsing FEN:", fen);
    const parts = fen.split(' ');
    if (parts.length !== 6) {
        console.error("Invalid FEN string:", fen);
        return false; // Indicate failure
    }
    const boardFen = parts[0];
    currentPlayer = parts[1];
    const castlingFen = parts[2];
    const enPassantFen = parts[3];
    halfmoveClock = parseInt(parts[4], 10);
    fullmoveNumber = parseInt(parts[5], 10);

    // Reset state before parsing
    board = [];
    castlingRights = { w: { K: false, Q: false }, b: { K: false, Q: false } };
    enPassantTarget = null;
    isGameOver = false;
    gameStatusMessage = ""; // Reset status message

    // Parse board
    const rows = boardFen.split('/');
    if (rows.length !== BOARD_SIZE) {
        console.error("Invalid FEN board section:", boardFen);
        return false;
    }
    for (let r = 0; r < BOARD_SIZE; r++) {
        board[r] = [];
        let col = 0;
        for (const char of rows[r]) {
            if (col >= BOARD_SIZE) break; // Prevent overflow
            if (isNaN(char)) {
                if (PIECES[char]) { // Check if it's a valid piece character
                    board[r][col] = char;
                    col++;
                } else {
                    console.error(`Invalid piece character '${char}' in FEN at row ${r}`);
                    return false;
                }
            } else {
                const emptySquares = parseInt(char, 10);
                if (emptySquares < 1 || emptySquares > 8) {
                    console.error(`Invalid empty square count '${char}' in FEN at row ${r}`);
                    return false;
                }
                for (let i = 0; i < emptySquares; i++) {
                    if (col >= BOARD_SIZE) {
                        console.error(`FEN row ${r} definition exceeds board width`);
                        return false;
                    }
                    board[r][col] = null;
                    col++;
                }
            }
        }
         if (col !== BOARD_SIZE) {
             console.error(`FEN row ${r} definition does not match board width (${col} vs ${BOARD_SIZE})`);
             return false;
         }
    }
     if (board.length !== BOARD_SIZE) {
        console.error(`FEN parsing resulted in incorrect board height (${board.length})`);
        return false;
     }

    // Parse castling rights
    if (castlingFen !== '-') {
        for (const char of castlingFen) {
            if (char === 'K') castlingRights.w.K = true;
            else if (char === 'Q') castlingRights.w.Q = true;
            else if (char === 'k') castlingRights.b.K = true;
            else if (char === 'q') castlingRights.b.Q = true;
            // Ignore invalid chars silently? Or error? Let's be strict for now.
            // else { console.warn("Ignoring invalid castling character:", char); }
        }
    }

    // Parse en passant target
    if (enPassantFen !== '-') {
        if (enPassantFen.length === 2) {
            const fileChar = enPassantFen.charCodeAt(0);
            const rankChar = enPassantFen.charCodeAt(1);
            const file = fileChar - 'a'.charCodeAt(0);
            const rank = BOARD_SIZE - (rankChar - '0'.charCodeAt(0)); // Convert rank char to 0-indexed row

             // Basic validation for en passant square coordinates
             if (file >= 0 && file < BOARD_SIZE && rank >= 0 && rank < BOARD_SIZE) {
                  // More specific validation: must be on 3rd or 6th rank
                 if ((currentPlayer === 'w' && rank === 2) || (currentPlayer === 'b' && rank === 5)) {
                     enPassantTarget = { row: rank, col: file };
                 } else {
                      console.warn(`Invalid en passant target rank for player ${currentPlayer}: ${enPassantFen}`);
                      enPassantTarget = null; // Treat as invalid
                 }

             } else {
                 console.warn("Invalid en passant target square format:", enPassantFen);
                 enPassantTarget = null;
             }

        } else {
             console.warn("Invalid en passant target format:", enPassantFen);
             enPassantTarget = null;
        }
    }

    // Validate player turn
    if (currentPlayer !== 'w' && currentPlayer !== 'b') {
         console.error("Invalid player turn in FEN:", currentPlayer);
         return false;
    }
    // Validate clocks
    if (isNaN(halfmoveClock) || halfmoveClock < 0) {
         console.warn("Invalid halfmove clock in FEN, resetting to 0:", parts[4]);
         halfmoveClock = 0;
    }
    if (isNaN(fullmoveNumber) || fullmoveNumber < 1) {
         console.warn("Invalid fullmove number in FEN, resetting to 1:", parts[5]);
         fullmoveNumber = 1;
    }

    console.log("FEN Parsed Successfully:", { board: board.map(r=>r.slice()), currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber });
    return true; // Success
}

// --- Square/Piece Utilities ---
function getPieceAt(r, c) {
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    // Ensure board[r] exists before accessing board[r][c]
    return board[r] ? board[r][c] : null;
}

function setPieceAt(r, c, piece) {
    if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
        // Ensure the row exists before setting
        if (!board[r]) {
             console.error(`Attempted to set piece on non-existent row: ${r}`);
             // Initialize row if necessary? Or just fail? Let's fail for now.
             return;
        }
        board[r][c] = piece;
    }
}

function isPlayerPiece(piece, player) {
    if (!piece) return false;
    return player === 'w' ? piece === piece.toUpperCase() : piece === piece.toLowerCase();
}

function getPlayerForPiece(piece) {
    if (!piece) return null;
    return piece === piece.toUpperCase() ? 'w' : 'b';
}

function getOpponent(player) {
    return player === 'w' ? 'b' : 'w';
}

// --- Move Generation (The Core Logic) ---
function generateLegalMoves(row, col) {
    const piece = getPieceAt(row, col);
    // Always return an array, even if empty initially
    if (!piece || getPlayerForPiece(piece) !== currentPlayer) {
        return [];
    }

    let potentialMoves = [];
    const pieceType = piece.toUpperCase();

    switch (pieceType) {
        case 'P': potentialMoves = getPawnMoves(row, col, piece); break;
        case 'N': potentialMoves = getKnightMoves(row, col, piece); break;
        case 'B': potentialMoves = getBishopMoves(row, col, piece); break;
        case 'R': potentialMoves = getRookMoves(row, col, piece); break;
        case 'Q': potentialMoves = getQueenMoves(row, col, piece); break;
        case 'K': potentialMoves = getKingMoves(row, col, piece); break;
        default: return []; // Should not happen
    }

    // Filter out moves that leave the king in check
    const legalMovesResult = potentialMoves.filter(move => {
        // Store original state details needed for restoration
        const originalPieceAtTarget = getPieceAt(move.row, move.col);
        const originalCastling = JSON.parse(JSON.stringify(castlingRights)); // Deep copy needed
        const originalEnPassant = enPassantTarget ? {...enPassantTarget} : null; // Deep copy needed

        let capturedEnPassantPawn = null;
        let capturedEnPassantPawnPos = null;
        let rookOrigin = null, rookDest = null, originalRookPiece = null;
        let simError = false; // Flag for simulation errors

        // --- Simulate board changes ---
        setPieceAt(move.row, move.col, piece);
        setPieceAt(row, col, null);

        // Handle en passant simulation
        if (move.isEnPassant) {
             const capturedPawnRow = currentPlayer === 'w' ? move.row + 1 : move.row - 1;
             capturedEnPassantPawn = getPieceAt(capturedPawnRow, move.col); // Get piece before removing
             if (!capturedEnPassantPawn) {
                  console.warn(`En passant simulation: Expected captured pawn at (${capturedPawnRow}, ${move.col}) not found.`);
                  // This implies an invalid EP target state, should maybe invalidate the move
                  simError = true;
             }
             capturedEnPassantPawnPos = {row: capturedPawnRow, col: move.col};
             setPieceAt(capturedPawnRow, move.col, null);
        }

        // Handle castling simulation
        if (move.isCastling) {
            const rookFromCol = move.col > col ? BOARD_SIZE - 1 : 0;
            const rookToCol = move.col > col ? move.col - 1 : move.col + 1;
            rookOrigin = { row: row, col: rookFromCol };
            rookDest = { row: row, col: rookToCol };
            originalRookPiece = getPieceAt(rookOrigin.row, rookOrigin.col);

            if (originalRookPiece && originalRookPiece.toUpperCase() === 'R') {
                 setPieceAt(rookDest.row, rookDest.col, originalRookPiece);
                 setPieceAt(rookOrigin.row, rookOrigin.col, null);
            } else {
                 // This should ideally not happen if castling rights were correct
                 console.warn("Castling simulation: Rook not found at expected position.", rookOrigin);
                 simError = true; // Mark simulation as potentially invalid
            }
        }

        // --- Check validity ---
        // If simulation had an error (like missing rook/pawn), consider the move illegal
        const kingInCheck = simError ? true : isKingInCheck(currentPlayer);

        // --- !!! CRUCIAL: Undo the simulation THOROUGHLY !!! ---
        setPieceAt(row, col, piece); // Put original piece back
        setPieceAt(move.row, move.col, originalPieceAtTarget); // Put target piece back (or null)

        if (move.isEnPassant && capturedEnPassantPawnPos) {
            setPieceAt(capturedEnPassantPawnPos.row, capturedEnPassantPawnPos.col, capturedEnPassantPawn);
        }

        if (move.isCastling && rookOrigin && rookDest) {
            // Restore rook: The piece that was simulated to move (originalRookPiece) goes back to its origin.
            // The destination square is cleared.
            if(originalRookPiece) { // Only restore if we found a rook initially
                setPieceAt(rookOrigin.row, rookOrigin.col, originalRookPiece);
                setPieceAt(rookDest.row, rookDest.col, null);
            }
        }

        // Restore castling rights and en passant target (critical)
        castlingRights = originalCastling;
        enPassantTarget = originalEnPassant;

        // Return true if the king was NOT in check after the simulated move
        return !kingInCheck;
    });

    return legalMovesResult; // Always return the resulting array
}

// --- Move Generation Helpers ---
function addMoveIfValid(moves, fromRow, fromCol, toRow, toCol, piece, options = {}) {
    const { canCapture = true, mustCapture = false, isEnPassant = false, isCastling = false, isPromotion = false } = options;

    if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) return;

    const targetPiece = getPieceAt(toRow, toCol);
    const player = getPlayerForPiece(piece);

    if (targetPiece) {
        if (isPlayerPiece(targetPiece, player)) return; // Cannot capture own piece
        if (!canCapture) return; // Pawn forward move cannot capture
    } else { // Target square is empty
        if (mustCapture && !isEnPassant) return; // Pawn diagonal requires capture (unless en passant)
    }

    moves.push({ row: toRow, col: toCol, isEnPassant, isCastling, isPromotion });
}

function getPawnMoves(r, c, piece) {
    const moves = [];
    const player = getPlayerForPiece(piece);
    const direction = player === 'w' ? -1 : 1;
    const startRow = player === 'w' ? 6 : 1;
    const promotionRow = player === 'w' ? 0 : 7;

    // 1. Move forward one square
    const oneStep = r + direction;
    if (oneStep >= 0 && oneStep < BOARD_SIZE && !getPieceAt(oneStep, c)) {
        const isPromotion = (oneStep === promotionRow);
        addMoveIfValid(moves, r, c, oneStep, c, piece, { canCapture: false, isPromotion: isPromotion });

        // 2. Move forward two squares
        if (r === startRow) {
            const twoSteps = r + 2 * direction;
            // Must also check intermediate square is empty
            if (twoSteps >= 0 && twoSteps < BOARD_SIZE && !getPieceAt(twoSteps, c) && !getPieceAt(oneStep, c)) {
                 addMoveIfValid(moves, r, c, twoSteps, c, piece, { canCapture: false });
            }
        }
    }

    // 3. Captures
    const captureCols = [c - 1, c + 1];
    for (const captureCol of captureCols) {
        if (captureCol >= 0 && captureCol < BOARD_SIZE) {
             const targetPiece = getPieceAt(oneStep, captureCol);
             const isPromotion = (oneStep === promotionRow);
            // Regular capture
            if (targetPiece && !isPlayerPiece(targetPiece, player)) {
                 addMoveIfValid(moves, r, c, oneStep, captureCol, piece, { mustCapture: true, isPromotion: isPromotion });
            }
            // En Passant
            if (enPassantTarget && oneStep === enPassantTarget.row && captureCol === enPassantTarget.col) {
                // Need to ensure the captured pawn exists for validation, but move is valid regardless for generation
                addMoveIfValid(moves, r, c, oneStep, captureCol, piece, { mustCapture: true, isEnPassant: true });
            }
        }
    }
    return moves;
}

function getKnightMoves(r, c, piece) {
    const moves = [];
    const knightMoves = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]
    ];
    knightMoves.forEach(([dr, dc]) => {
        addMoveIfValid(moves, r, c, r + dr, c + dc, piece);
    });
    return moves;
}

function getSlidingMoves(r, c, piece, directions) {
    const moves = [];
    const player = getPlayerForPiece(piece);
    directions.forEach(([dr, dc]) => {
        for (let i = 1; ; i++) {
            const toRow = r + i * dr;
            const toCol = c + i * dc;
            if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) break; // Off board
            const targetPiece = getPieceAt(toRow, toCol);
            if (targetPiece) {
                if (!isPlayerPiece(targetPiece, player)) {
                    addMoveIfValid(moves, r, c, toRow, toCol, piece); // Capture opponent
                }
                break; // Blocked (by own or opponent piece)
            } else {
                addMoveIfValid(moves, r, c, toRow, toCol, piece); // Empty square
            }
        }
    });
    return moves;
}

function getBishopMoves(r, c, piece) {
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    return getSlidingMoves(r, c, piece, directions);
}

function getRookMoves(r, c, piece) {
    const directions = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    return getSlidingMoves(r, c, piece, directions);
}

function getQueenMoves(r, c, piece) {
    // Combine results, ensuring no duplicates (though unlikely with current addMoveIfValid)
    const bishopMoves = getBishopMoves(r, c, piece);
    const rookMoves = getRookMoves(r, c, piece);
    return [...bishopMoves, ...rookMoves];
}

function getKingMoves(r, c, piece) {
    const moves = [];
    const player = getPlayerForPiece(piece);
    const kingMoves = [
        [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]
    ];
    kingMoves.forEach(([dr, dc]) => {
        addMoveIfValid(moves, r, c, r + dr, c + dc, piece);
    });

    // Castling
    // Check castling rights BEFORE checking if attacked (simplifies)
    const canCastleK = castlingRights[player]?.K; // Optional chaining for safety
    const canCastleQ = castlingRights[player]?.Q;

    if (canCastleK || canCastleQ) {
        // Can't castle if currently in check
        if (!isSquareAttacked(r, c, getOpponent(player))) {
            // Kingside (O-O)
            if (canCastleK) {
                // Check squares are empty and rook exists
                if (!getPieceAt(r, c + 1) && !getPieceAt(r, c + 2) &&
                    getPieceAt(r, c + 3) && getPieceAt(r, c+3) === (player === 'w' ? 'R' : 'r'))
                 {
                    // Check squares king moves *through* are not attacked
                    if (!isSquareAttacked(r, c + 1, getOpponent(player)) &&
                        !isSquareAttacked(r, c + 2, getOpponent(player)))
                    {
                        addMoveIfValid(moves, r, c, r, c + 2, piece, { isCastling: true });
                    }
                 }
            }
            // Queenside (O-O-O)
            if (canCastleQ) {
                // Check squares are empty and rook exists
                 if (!getPieceAt(r, c - 1) && !getPieceAt(r, c - 2) && !getPieceAt(r, c - 3) &&
                     getPieceAt(r, c - 4) && getPieceAt(r, c-4) === (player === 'w' ? 'R' : 'r'))
                 {
                     // Check squares king moves *through* are not attacked
                     if (!isSquareAttacked(r, c - 1, getOpponent(player)) &&
                         !isSquareAttacked(r, c - 2, getOpponent(player)))
                     // Note: King lands on c-2, moves over c-1 and c-2. c-3 does not need attack check.
                     {
                         addMoveIfValid(moves, r, c, r, c - 2, piece, { isCastling: true });
                     }
                 }
            }
        }
    }
    return moves;
}

// --- Check, Checkmate, Stalemate Logic ---
function isSquareAttacked(r, c, attackerPlayer) {
    // Check pawns
    const pawnDir = attackerPlayer === 'w' ? 1 : -1; // Direction pawns move *relative to the target square*
    const pawnSources = [{ r: r + pawnDir, c: c - 1 }, { r: r + pawnDir, c: c + 1 }];
    for (const pos of pawnSources) {
        const p = getPieceAt(pos.r, pos.c);
        if (p && getPlayerForPiece(p) === attackerPlayer && p.toUpperCase() === 'P') {
             // console.log(`Square (${r},${c}) attacked by pawn at (${pos.r},${pos.c})`);
             return true;
        }
    }

    // Check knights
    const knightMoves = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of knightMoves) {
        const p = getPieceAt(r + dr, c + dc);
        if (p && getPlayerForPiece(p) === attackerPlayer && p.toUpperCase() === 'N') {
            // console.log(`Square (${r},${c}) attacked by knight at (${r+dr},${c+dc})`);
             return true;
        }
    }

    // Check sliding pieces + king
    const slideDirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [dr, dc] of slideDirs) {
        for (let i = 1; ; i++) {
            const checkR = r + i * dr;
            const checkC = c + i * dc;
            if (checkR < 0 || checkR >= BOARD_SIZE || checkC < 0 || checkC >= BOARD_SIZE) break; // Off board

            const p = getPieceAt(checkR, checkC);
            if (p) {
                if (getPlayerForPiece(p) === attackerPlayer) {
                    const pType = p.toUpperCase();
                    const isDiag = dr !== 0 && dc !== 0;
                    const isOrth = dr === 0 || dc === 0;

                    // Check if piece type matches attack direction or is Queen/King
                    if (pType === 'Q' ||
                        (pType === 'B' && isDiag) ||
                        (pType === 'R' && isOrth) ||
                        (pType === 'K' && i === 1)) // King only attacks adjacent squares (i=1)
                    {
                         // console.log(`Square (${r},${c}) attacked by ${p} at (${checkR},${checkC})`);
                         return true;
                    }
                }
                // Any piece (own or opponent) blocks further checks along this line
                break;
            }
        }
    }
    return false;
}

function findKing(player) {
    const kingPiece = player === 'w' ? 'K' : 'k';
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (getPieceAt(r, c) === kingPiece) {
                return { row: r, col: c };
            }
        }
    }
    console.error(`King not found for player ${player}! Board state potentially corrupt.`);
    return null;
}

function isKingInCheck(player) {
    const kingPos = findKing(player);
    if (!kingPos) return false; // Should not happen, but avoid error if king is missing
    return isSquareAttacked(kingPos.row, kingPos.col, getOpponent(player));
}

function hasLegalMoves(player) {
     // Need to temporarily set currentPlayer to check moves for the given player
     const originalPlayer = currentPlayer;
     currentPlayer = player;
     let foundMove = false;
     try {
         for (let r = 0; r < BOARD_SIZE; r++) {
             for (let c = 0; c < BOARD_SIZE; c++) {
                 const piece = getPieceAt(r, c);
                 if (piece && getPlayerForPiece(piece) === player) {
                     if (generateLegalMoves(r, c).length > 0) {
                         foundMove = true;
                         break; // Found a legal move, no need to check further
                     }
                 }
             }
             if (foundMove) break;
         }
     } finally {
         currentPlayer = originalPlayer; // Restore original player context
     }
     return foundMove;
}

// --- Game Outcome Determination ---
// Determines checkmate/stalemate based on current player having no moves
// Returns: 'checkmate', 'stalemate', or null
function checkGameEndCondition() {
    if (!hasLegalMoves(currentPlayer)) {
        if (isKingInCheck(currentPlayer)) {
            return 'checkmate';
        } else {
            return 'stalemate';
        }
    }
    return null; // Game is not over due to lack of moves
}

// --- Draw Condition Checks ---
function hasInsufficientMaterial() {
    const pieces = { w: [], b: [] };
    let lightBishops = { w: 0, b: 0 };
    let darkBishops = { w: 0, b: 0 };
    let pieceCount = 0;

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece) {
                pieceCount++;
                const player = getPlayerForPiece(piece);
                const type = piece.toUpperCase();
                if (!pieces[player]) pieces[player] = []; // Ensure array exists
                pieces[player].push(type);

                if (type === 'B') {
                     const squareColor = (r + c) % 2; // 0 for dark, 1 for light (standard algebraic)
                     if (squareColor === 0) darkBishops[player]++;
                     else lightBishops[player]++;
                }
            }
        }
    }

    // King vs King
    if (pieceCount <= 2) return true;

    // Function to check if a side has ONLY: K, K+N, K+B (single), K+B's (all same color)
    const checkSide = (player) => {
        const pList = pieces[player] || []; // Handle case where player has no pieces (shouldn't happen if K exists)
        if (pList.length === 0) return true; // Should be impossible if called correctly
        if (pList.length === 1 && pList[0] === 'K') return true; // King only
        if (pList.length === 2 && pList.includes('N') && pList.includes('K')) return true; // King + Knight
        if (pList.length >= 2 && pList.includes('K') && pList.every(p => p === 'K' || p === 'B')) {
             // King + Bishop(s)
             // Check if there are bishops on *both* light and dark squares
             if (lightBishops[player] > 0 && darkBishops[player] > 0) {
                 return false; // Bishops on different colors CAN mate (KBB vs K)
             }
             return true; // Only king or king + bishops all on the same color squares
        }
        // If any other pieces (P, R, Q, multiple knights) exist, it's sufficient material
        return false;
    };

    // Check if BOTH sides have insufficient material
    if (checkSide('w') && checkSide('b')) {
        return true;
    }

    // Specific K+B vs K+B case where bishops are same color (draw)
    if (pieceCount === 4 && pieces.w.length === 2 && pieces.b.length === 2 &&
        pieces.w.includes('K') && pieces.w.includes('B') &&
        pieces.b.includes('K') && pieces.b.includes('B')) {
        // Check if both bishops are on the same color squares
        const wBishColor = lightBishops.w > 0 ? 'light' : 'dark';
        const bBishColor = lightBishops.b > 0 ? 'light' : 'dark';
        if (wBishColor === bBishColor) {
            return true;
        }
    }


    return false;
}

function getBoardPositionString(currentBoardState) {
    // Takes a board state object { board, currentPlayer, castlingRights, enPassantTarget }
    let boardString = currentBoardState.board.map(row => {
        let emptyCount = 0;
        let rowStr = '';
        for (const piece of row) {
            if (piece) {
                if (emptyCount > 0) rowStr += emptyCount;
                rowStr += piece;
                emptyCount = 0;
            } else {
                emptyCount++;
            }
        }
        if (emptyCount > 0) rowStr += emptyCount;
        return rowStr;
    }).join('/');

    // Add other state info for accurate repetition check
    boardString += ` ${currentBoardState.currentPlayer}`;
    boardString += ` ${getCastlingString(currentBoardState.castlingRights)}`;
    boardString += ` ${getEnPassantString(currentBoardState.enPassantTarget)}`;
    // Note: Halfmove/Fullmove clocks are NOT part of the position string for repetition check
    return boardString;
}

function getCastlingString(castlingState) {
    let str = "";
    if (castlingState?.w?.K) str += 'K'; // Use optional chaining
    if (castlingState?.w?.Q) str += 'Q';
    if (castlingState?.b?.K) str += 'k';
    if (castlingState?.b?.Q) str += 'q';
    return str === "" ? "-" : str;
}

function getEnPassantString(epTarget) {
    if (!epTarget) return "-";
    // Ensure row/col are valid before creating string
    if (typeof epTarget.row !== 'number' || typeof epTarget.col !== 'number') return "-";
    const file = String.fromCharCode('a'.charCodeAt(0) + epTarget.col);
    const rank = BOARD_SIZE - epTarget.row;
    // Basic validation on generated string
    if (epTarget.col < 0 || epTarget.col >= BOARD_SIZE || rank < 1 || rank > BOARD_SIZE) return "-";
    return `${file}${rank}`;
}

function checkThreefoldRepetition() {
    // Needs gameHistory access
    if (currentMoveIndex < 8) return false; // Not possible before move 4 by black

    const currentState = { board, currentPlayer, castlingRights, enPassantTarget };
    const currentPositionString = getBoardPositionString(currentState);
    let repetitionCount = 0;

    // Check past states in gameHistory
    for (let i = 0; i <= currentMoveIndex; i++) {
        const pastState = gameHistory[i];
        // Check if board/player/castling/ep match (use helper to generate string)
        const pastPositionString = getBoardPositionString(pastState);
        if (pastPositionString === currentPositionString) {
            repetitionCount++;
        }
    }
    // console.log(`Repetition check for ${currentPositionString}: count = ${repetitionCount}`);
    return repetitionCount >= 3;
}


// --- Game History Management ---
function pushHistoryState(moveInfo = {}) {
    // Important: Create deep copies of mutable state parts
    const boardCopy = board.map(row => [...row]); // Deep copy board
    const castlingCopy = JSON.parse(JSON.stringify(castlingRights)); // Deep copy castling
    const enPassantCopy = enPassantTarget ? { ...enPassantTarget } : null; // Deep copy EP

    const state = {
        board: boardCopy,
        currentPlayer,
        castlingRights: castlingCopy,
        enPassantTarget: enPassantCopy,
        halfmoveClock,
        fullmoveNumber,
        statusMessage: gameStatusMessage, // Store the message *before* this state was entered
        // Move info associated with the move *leading* to this state
        moveNotation: moveInfo.notation || null,
        moveNumber: moveInfo.moveNumber || null
    };

    // If we're not at the end of history (e.g., after undo), truncate future moves
    if (moveInfo.truncate !== false && currentMoveIndex < gameHistory.length - 1) {
        gameHistory = gameHistory.slice(0, currentMoveIndex + 1);
         console.log(`History truncated. Length now: ${gameHistory.length}`);
    }

    gameHistory.push(state);
    currentMoveIndex++;
    // console.log(`History pushed. Index: ${currentMoveIndex}, Length: ${gameHistory.length}, Notation: ${state.moveNotation}`);

    // History button updates belong in UI logic
}

// --- Move Notation ---
// Generates base algebraic notation (e.g., "Nf3", "exd5", "O-O").
// Check/mate symbols (+/#) are added later after verifying game state.
// Promotion piece (=Q) added later if applicable.
function getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPieceLogical, isEnPassant, isCastling) {
     const pieceType = piece.toUpperCase();
     const destFile = String.fromCharCode('a'.charCodeAt(0) + toCol);
     const destRank = BOARD_SIZE - toRow;
     const fromFile = String.fromCharCode('a'.charCodeAt(0) + fromCol);
     const fromRank = BOARD_SIZE - fromRow;

     if (isCastling) {
         return (toCol > fromCol) ? "O-O" : "O-O-O";
     }

     let notation = "";
     const isCapture = capturedPieceLogical || isEnPassant; // Check if it's logically a capture

     if (pieceType === 'P') {
         if (isCapture) {
             notation = fromFile + 'x'; // Pawn captures include departure file
         }
         notation += destFile + destRank;
         // Promotion notation (=Q) is added separately later if needed
     } else {
         notation = pieceType; // Start with piece letter (except pawns)

         // Check for ambiguity (if another piece of the same type could move to the same square)
         const ambiguity = checkAmbiguity(fromRow, fromCol, toRow, toCol, piece);
         if (ambiguity.needsFile && ambiguity.needsRank) {
             notation += fromFile + fromRank; // Need both file and rank
         } else if (ambiguity.needsFile) {
             notation += fromFile; // Need file only
         } else if (ambiguity.needsRank) {
             notation += fromRank; // Need rank only
         }
         // If fileAmbig is true but needsFile is false, it means file alone resolves ambiguity (e.g. two rooks on same rank)
         else if (ambiguity.fileAmbig) {
              notation += fromFile;
         }
          // If rankAmbig is true but needsRank is false, it means rank alone resolves ambiguity (e.g. two rooks on same file)
         else if (ambiguity.rankAmbig) {
               notation += fromRank;
         }


         if (isCapture) {
             notation += 'x'; // Add 'x' for captures
         }
         notation += destFile + destRank; // Add destination square
     }

     return notation;
}

// Helper to check if notation needs disambiguation (e.g., Rae1 vs Re1)
function checkAmbiguity(fR, fC, tR, tC, piece) {
    let fileAmbig = false; // Is there another piece on a different file that can move?
    let rankAmbig = false; // Is there another piece on a different rank that can move?
    let needsFile = false; // Is there another piece on the same rank? -> need file
    let needsRank = false; // Is there another piece on the same file? -> need rank

    const player = getPlayerForPiece(piece);
    const originalCurrentPlayer = currentPlayer; // Backup context
    currentPlayer = player; // Set context for checking moves of the *moving* player

    try {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                // Skip the piece we're actually moving
                if (r === fR && c === fC) continue;

                const otherPiece = getPieceAt(r, c);
                // Check if it's the same type and color
                if (otherPiece === piece) {
                    // Check if this other piece can also move to the target square
                    const otherLegalMoves = generateLegalMoves(r, c); // Use the set currentPlayer context

                    if (otherLegalMoves.some(move => move.row === tR && move.col === tC)) {
                        // Ambiguity exists! Now determine what's needed.
                        if (c !== fC) fileAmbig = true; // Another piece is on a different file
                        if (r !== fR) rankAmbig = true; // Another piece is on a different rank

                        // If the ambiguous piece is on the same rank, we need the file
                        if (r === fR) needsFile = true;
                        // If the ambiguous piece is on the same file, we need the rank
                        if (c === fC) needsRank = true;
                    }
                }
            }
        }
    } finally {
        currentPlayer = originalCurrentPlayer; // Restore context
    }

     // Determine requirement based on flags
     // needsFile/needsRank take precedence as they indicate the *only* way to disambiguate in specific cases
     return { fileAmbig, rankAmbig, needsFile, needsRank };
}


// --- END OF FILE gameLogic.js --- 