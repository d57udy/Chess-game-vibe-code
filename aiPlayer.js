// --- START OF FILE aiPlayer.js ---

// --- AI Constants ---
const pieceValues = { P: 1, N: 3, B: 3.1, R: 5, Q: 9, K: 0 }; // King value often 0 or high for endgame only

// --- Piece Square Tables (Simple Examples) ---
// Values represent bonus/penalty for piece being on a square (from white's perspective)
// Higher value is better for white.
const pawnPositionScore = [
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // Rank 8 (Promotion handled implicitly by Q value)
    [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8], // Rank 7 (Strong incentive to advance)
    [0.3, 0.3, 0.4, 0.5, 0.5, 0.4, 0.3, 0.3], // Rank 6
    [0.1, 0.1, 0.2, 0.4, 0.4, 0.2, 0.1, 0.1], // Rank 5
    [0.0, 0.0, 0.1, 0.3, 0.3, 0.1, 0.0, 0.0], // Rank 4
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // Rank 3
    [0.0, 0.0, 0.0,-0.2,-0.2, 0.0, 0.0, 0.0], // Rank 2 (Slight discouragement for blocking development)
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]  // Rank 1
];

const knightPositionScore = [
    [-0.5,-0.4,-0.3,-0.3,-0.3,-0.3,-0.4,-0.5],
    [-0.4,-0.2, 0.0, 0.1, 0.1, 0.0,-0.2,-0.4],
    [-0.3, 0.0, 0.2, 0.3, 0.3, 0.2, 0.0,-0.3],
    [-0.3, 0.1, 0.3, 0.4, 0.4, 0.3, 0.1,-0.3],
    [-0.3, 0.0, 0.3, 0.4, 0.4, 0.3, 0.0,-0.3],
    [-0.3, 0.1, 0.2, 0.3, 0.3, 0.2, 0.1,-0.3],
    [-0.4,-0.2, 0.0, 0.1, 0.1, 0.0,-0.2,-0.4],
    [-0.5,-0.4,-0.3,-0.3,-0.3,-0.3,-0.4,-0.5]
];

const bishopPositionScore = [
    [-0.2,-0.1,-0.1,-0.1,-0.1,-0.1,-0.1,-0.2],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.1, 0.0, 0.1, 0.1, 0.1, 0.1, 0.0,-0.1],
    [-0.1, 0.1, 0.1, 0.2, 0.2, 0.1, 0.1,-0.1],
    [-0.1, 0.0, 0.1, 0.2, 0.2, 0.1, 0.0,-0.1],
    [-0.1, 0.1, 0.0, 0.1, 0.1, 0.0, 0.1,-0.1],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.2,-0.1,-0.1,-0.1,-0.1,-0.1,-0.1,-0.2]
];

const rookPositionScore = [
    [ 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [ 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.1], // Bonus for 7th rank
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [-0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,-0.1],
    [ 0.0, 0.0, 0.0, 0.1, 0.1, 0.0, 0.0, 0.0] // Slight preference for center files in opening
];

// Simplified King safety (prefers castled, penalizes center in middle game)
const kingPositionScore = [
    [-0.3,-0.4,-0.4,-0.5,-0.5,-0.4,-0.4,-0.3], // Penalty for back rank if not castled
    [-0.3,-0.4,-0.4,-0.5,-0.5,-0.4,-0.4,-0.3],
    [-0.3,-0.4,-0.4,-0.5,-0.5,-0.4,-0.4,-0.3],
    [-0.3,-0.4,-0.4,-0.5,-0.5,-0.4,-0.4,-0.3],
    [-0.2,-0.3,-0.3,-0.4,-0.4,-0.3,-0.3,-0.2],
    [-0.1,-0.2,-0.2,-0.2,-0.2,-0.2,-0.2,-0.1],
    [ 0.2, 0.2, 0.0, 0.0, 0.0, 0.0, 0.2, 0.2], // Slight preference for castling squares
    [ 0.2, 0.3, 0.1, 0.0, 0.0, 0.1, 0.3, 0.2]  // Preference for castling squares
];
// TODO: Add King endgame tables

// --- AI Calculation --- 

/**
 * Calculates the best move for the current player using different strategies based on difficulty.
 * Relies on global game state variables from gameLogic.js (board, currentPlayer, etc.)
 * and functions like getAllLegalMoves, evaluateBoard, minimax.
 * @param {number} difficulty - AI difficulty level (0-3).
 * @returns {object | null} The best move object { from: {r, c}, to: {r, c}, piece, ... } or null if no moves.
 */
function calculateBestMove(difficulty) {
    // Assumes currentPlayer is set correctly in gameLogic.js
    const availableMoves = getAllLegalMoves(currentPlayer);
    if (availableMoves.length === 0) {
        console.log("AI: No legal moves available.");
        return null;
    }

    // Shuffle moves for randomness in lower difficulties and breaking ties
    // Use a copy to avoid modifying the original order if needed elsewhere
    const shuffledMoves = [...availableMoves].sort(() => Math.random() - 0.5);

    let bestMove = shuffledMoves[0]; // Default to first random move
    let calculationStartTime = performance.now();

    try { // Add try-catch around AI logic
        switch (difficulty) {
            case 0: // Very Easy: Random move, avoids immediate obvious blunders if possible
                // Try to find a non-capture move that doesn't hang a piece trivially
                let nonLosingMoves = shuffledMoves.filter(move => {
                    const captured = getPieceAt(move.to.row, move.to.col);
                    if (captured) return true; // Captures are okay
                    
                    // Simulate the move briefly
                    const piece = getPieceAt(move.from.row, move.from.col);
                    setPieceAt(move.to.row, move.to.col, piece);
                    setPieceAt(move.from.row, move.from.col, null);

                    // Check if the moved piece is now attacked by a lower-value piece
                    let isHanging = false;
                    const opponent = getOpponent(currentPlayer);
                    if (isSquareAttacked(move.to.row, move.to.col, opponent)) {
                         // More detailed check: is it attacked by something less valuable?
                         // (Simplified: just check if attacked at all for 'very easy')
                         isHanging = true;
                    }

                    // Undo simulation
                    setPieceAt(move.from.row, move.from.col, piece);
                    setPieceAt(move.to.row, move.to.col, null); // Must clear the 'to' square

                    return !isHanging; // Prefer moves that don't immediately hang the piece
                });

                if (nonLosingMoves.length > 0) {
                    bestMove = nonLosingMoves[0];
                } 
                // else: bestMove remains the first random move (might be a blunder)
                console.log("AI (Very Easy): Chose move (potentially random).", bestMove);
                break;

            case 1: // Easy: Prioritizes captures, otherwise random
                const captureMoves = shuffledMoves.filter(move => getPieceAt(move.to.row, move.to.col) || move.isEnPassant);
                if (captureMoves.length > 0) {
                    bestMove = captureMoves[0]; // Pick a random capture
                    console.log("AI (Easy): Chose capture move.", bestMove);
                } else {
                    console.log("AI (Easy): Chose random non-capture move.", bestMove);
                     // bestMove remains the first random non-capture move
                }
                break;

            case 2: // Medium: Simple evaluation (1-ply lookahead)
                let bestScore = (currentPlayer === 'w') ? -Infinity : Infinity;
                let currentBestMove = null; // Track best move found so far

                shuffledMoves.forEach(move => {
                    // Simulate move
                    const piece = getPieceAt(move.from.row, move.from.col);
                    const captured = getPieceAt(move.to.row, move.to.col);
                    const prevEnPassant = enPassantTarget ? {...enPassantTarget} : null; // Store prev EP
                    let capturedEnPassant = null, capturedEnPassantPos = null;
                    
                    setPieceAt(move.to.row, move.to.col, piece);
                    setPieceAt(move.from.row, move.from.col, null);
                    if (move.isEnPassant) {
                        // Determine captured pawn position correctly (relative to *destination* square)
                        capturedEnPassantPos = { row: currentPlayer === 'w' ? move.to.row + 1 : move.to.row - 1, col: move.to.col };
                        capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                        if (capturedEnPassant) setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
                        else console.warn("AI Sim: EP capture simulation failed, no pawn found at", capturedEnPassantPos);
                    }
                    // Update EP target temporarily if pawn moved two steps
                    if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                         enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
                    } else {
                         enPassantTarget = null;
                    }

                    let score = evaluateBoard(); // Evaluate the board *after* the move
                    
                    // Undo simulation carefully
                    enPassantTarget = prevEnPassant; // Restore EP *before* putting pieces back
                    setPieceAt(move.from.row, move.from.col, piece); // Put moving piece back
                    setPieceAt(move.to.row, move.to.col, captured); // Put captured piece back (or null)
                    if (move.isEnPassant && capturedEnPassantPos && capturedEnPassant) {
                        setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant); // Restore EP captured pawn
                    }

                    // Compare score
                    if (currentPlayer === 'w') { // Maximize for white
                        if (score > bestScore) { bestScore = score; currentBestMove = move; }
                    } else { // Minimize for black (AI is usually black)
                        if (score < bestScore) { bestScore = score; currentBestMove = move; }
                    }
                });
                
                if (currentBestMove) { // Ensure a move was actually selected
                     bestMove = currentBestMove;
                     console.log(`AI (Medium): Chose move with score ${bestScore.toFixed(2)}`, bestMove);
                } else {
                     console.warn("AI (Medium): No move selected by evaluation, falling back to random.");
                     bestMove = shuffledMoves[0]; // Fallback if something went wrong
                }
                break;

            case 3: // Hard: Minimax with Alpha-Beta Pruning
                const depth = 3; // Adjust depth for performance vs strength (3 is decent)
                 console.log(`AI (Hard): Starting Minimax search with depth ${depth}...`);
                const result = minimax(depth, -Infinity, Infinity, currentPlayer === 'w');
                if (result && result.move) { // Check if minimax returned a valid result
                    bestMove = result.move;
                     console.log(`AI (Hard): Minimax found move with score ${result.score.toFixed(2)}`, bestMove);
                } else {
                     console.warn(`Minimax did not return a valid move (Score: ${result?.score}). Falling back to Medium AI.`);
                     // Fallback to Medium logic if minimax fails
                     bestMove = calculateBestMove(2); // Recalculate using Medium logic
                     if (!bestMove) bestMove = shuffledMoves[0]; // Further fallback to random
                }
                break;
            
            default: // Should not happen
                console.warn("Invalid AI difficulty level, using random move.");
                bestMove = shuffledMoves[0]; 
        }
    } catch (error) {
         console.error("Error during AI move calculation:", error);
         // Fallback to random if calculation fails
         bestMove = shuffledMoves[0];
    }
    
    let calculationEndTime = performance.now();
    console.log(`AI calculation time: ${(calculationEndTime - calculationStartTime).toFixed(1)} ms`);

    return bestMove;
}

/**
 * Helper function for difficulty 0 AI to check if a piece at a given square
 * is attacked by any piece of the opponent.
 * (This is a simplified version, doesn't check piece values)
 * @param {string} attackedPlayer - The player whose piece might be attacked ('w' or 'b').
 * @param {string} attackerPiece - The piece type that just moved.
 * @param {number} attackerRow - The row the attacker moved to.
 * @param {number} attackerCol - The column the attacker moved to.
 * @returns {boolean} - True if any opponent piece is attacked by the attackerPiece.
 */
function isAnyPieceAttackedBy(attackedPlayer, attackerPiece, attackerRow, attackerCol) {
    // This function name is slightly misleading based on original use. 
    // It seems intended to check if the *attacker* itself attacks any opponent piece *from its new square*.
    // Let's refine this based on the likely intent for simple AI.
    
    // Get potential moves *from the attacker's new position*
    const attackerPlayer = getPlayerForPiece(attackerPiece);
    const opponent = getOpponent(attackerPlayer);
    let potentialAttacks = [];
    const pieceType = attackerPiece.toUpperCase();

    // Generate basic attack patterns (not full legal moves, just direct attacks)
    switch (pieceType) {
        case 'P':
            const dir = attackerPlayer === 'w' ? -1 : 1;
            potentialAttacks = [
                {r: attackerRow + dir, c: attackerCol - 1},
                {r: attackerRow + dir, c: attackerCol + 1}
            ];
            break;
        case 'N':
             const knightDeltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
             potentialAttacks = knightDeltas.map(([dr, dc]) => ({r: attackerRow + dr, c: attackerCol + dc}));
            break;
        case 'B':
            potentialAttacks = getSlidingAttackSquares(attackerRow, attackerCol, [[-1,-1],[-1,1],[1,-1],[1,1]], attackerPlayer);
            break;
        case 'R':
             potentialAttacks = getSlidingAttackSquares(attackerRow, attackerCol, [[-1,0],[1,0],[0,-1],[0,1]], attackerPlayer);
            break;
        case 'Q':
            potentialAttacks = [
                 ...getSlidingAttackSquares(attackerRow, attackerCol, [[-1,-1],[-1,1],[1,-1],[1,1]], attackerPlayer),
                 ...getSlidingAttackSquares(attackerRow, attackerCol, [[-1,0],[1,0],[0,-1],[0,1]], attackerPlayer)
            ];
            break;
         case 'K':
             const kingDeltas = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
             potentialAttacks = kingDeltas.map(([dr, dc]) => ({r: attackerRow + dr, c: attackerCol + dc}));
             break;
    }
    
    // Check if any of the attacked squares contain an opponent's piece
    for (const attack of potentialAttacks) {
         if (attack.r >= 0 && attack.r < BOARD_SIZE && attack.c >= 0 && attack.c < BOARD_SIZE) {
            const target = getPieceAt(attack.r, attack.c);
            // Check if the target piece exists and belongs to the opponent
            if (target && getPlayerForPiece(target) === opponent) {
                return true; // Yes, the moved piece attacks an opponent piece
            }
        }
    }
    return false; // The moved piece does not attack any opponent piece
}

/**
 * Helper for generating squares attacked by sliding pieces.
 * @param {number} r - Starting row.
 * @param {number} c - Starting column.
 * @param {Array<Array<number>>} directions - Array of [dr, dc] pairs.
 * @param {string} player - The player whose piece is attacking.
 * @returns {Array<object>} List of squares {r, c} under attack.
 */
function getSlidingAttackSquares(r, c, directions, player) {
    const attackedSquares = [];
    const opponent = getOpponent(player);
    directions.forEach(([dr, dc]) => {
        for (let i = 1; ; i++) {
            const toRow = r + i * dr;
            const toCol = c + i * dc;
            if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) break; // Off board
            
            attackedSquares.push({ r: toRow, c: toCol }); // Add the square itself
            
            const targetPiece = getPieceAt(toRow, toCol);
            if (targetPiece) {
                break; // Path blocked, stop checking further along this line
            }
        }
    });
    return attackedSquares;
}


/**
 * Generates all legal moves for a given player.
 * This is a crucial function for the AI.
 * @param {string} player - The player ('w' or 'b') whose moves to generate.
 * @returns {Array<object>} A list of all legal move objects for that player.
 *                         Each move object: { from: {r, c}, to: {r, c}, piece, isPromotion, isCastling, isEnPassant }
 */
function getAllLegalMoves(player) {
    const allMoves = [];
    const originalPlayer = currentPlayer; // Backup context
    // Temporarily set the global currentPlayer for generateLegalMoves context
    // This is a slight coupling, could be refactored to pass player context explicitly
    currentPlayer = player;

    try {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                const piece = getPieceAt(r, c);
                if (piece && getPlayerForPiece(piece) === player) {
                    // generateLegalMoves filters for check internally
                    const moves = generateLegalMoves(r, c); // Uses the temporary currentPlayer context
                    
                    moves.forEach(move => {
                        // Add detailed info needed by AI
                        allMoves.push({
                            from: { row: r, col: c },
                            to: { row: move.row, col: move.col },
                            piece: piece,
                            isPromotion: move.isPromotion || false,
                            isCastling: move.isCastling || false,
                            isEnPassant: move.isEnPassant || false
                        });
                    });
                }
            }
        }
    } finally {
        currentPlayer = originalPlayer; // Restore original player context IMPORTANT!
    }
    return allMoves;
}

/**
 * Evaluates the current board state from White's perspective.
 * Positive score favors White, negative score favors Black.
 * Uses material count and positional bonuses.
 * @returns {number} The evaluation score.
 */
function evaluateBoard() {
    let score = 0;
    let whiteMaterial = 0;
    let blackMaterial = 0;
    let whitePositional = 0;
    let blackPositional = 0;

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece) {
                const player = getPlayerForPiece(piece);
                const type = piece.toUpperCase();
                const value = pieceValues[type] || 0;
                let positionScore = 0;

                // Apply position scores based on piece type
                // Scores are from white's perspective, flip index for black
                const tableRow = (player === 'w') ? r : 7 - r;
                const tableCol = c; // Column is the same

                switch (type) {
                    case 'P': positionScore = pawnPositionScore[tableRow]?.[tableCol] || 0; break;
                    case 'N': positionScore = knightPositionScore[tableRow]?.[tableCol] || 0; break;
                    case 'B': positionScore = bishopPositionScore[tableRow]?.[tableCol] || 0; break;
                    case 'R': positionScore = rookPositionScore[tableRow]?.[tableCol] || 0; break;
                    case 'K': positionScore = kingPositionScore[tableRow]?.[tableCol] || 0; break;
                    // Queen uses average of Rook+Bishop for simplicity, or could have its own table
                    case 'Q': positionScore = ((bishopPositionScore[tableRow]?.[tableCol] || 0) + (rookPositionScore[tableRow]?.[tableCol] || 0)) / 2; break; 
                }

                if (player === 'w') {
                    whiteMaterial += value;
                    whitePositional += positionScore;
                } else {
                    blackMaterial += value;
                    blackPositional += positionScore; // Add score from black's perspective (using flipped row index)
                }
            }
        }
    }

    // Combine material and positional scores
    // Positional score weighted less (e.g., 0.1) - adjust weighting as needed
    score = (whiteMaterial - blackMaterial) + (whitePositional - blackPositional) * 0.1; 

    // Add bonus for check? (Could be risky, might lead to sacrificing for check)
    // Consider adding mobility score (number of legal moves) later?
    // Consider king safety evaluation later? (e.g., penalty for king in open file)

    return score;
}

/**
 * Minimax algorithm with Alpha-Beta Pruning.
 * Finds the best move for the player whose turn it is.
 * @param {number} depth - Current search depth.
 * @param {number} alpha - Alpha value for pruning (best score for maximizer).
 * @param {number} beta - Beta value for pruning (best score for minimizer).
 * @param {boolean} maximizingPlayer - True if the current node is maximizing (White), False if minimizing (Black).
 * @returns {{score: number, move: object | null}} - The best score and the corresponding move.
 */
function minimax(depth, alpha, beta, maximizingPlayer) {
     // Check terminal conditions (Checkmate, Stalemate, Draw?)
     // Need to check for the player whose turn it WILL BE after the simulated move.
     const playerToEvaluate = maximizingPlayer ? 'w' : 'b'; // Whose turn is it at this node?
     const opponent = getOpponent(playerToEvaluate);
     
     // Check game end conditions for the player whose turn it is at this node.
     const possibleMoves = getAllLegalMoves(playerToEvaluate);
     const isInCheck = isKingInCheck(playerToEvaluate);
     let nodeValue;

     if (possibleMoves.length === 0) { // Game potentially over
         if (isInCheck) {
             // Checkmate: Assign extreme score favoring the winner
             // Add depth bonus/penalty to encourage faster mates
             nodeValue = maximizingPlayer ? -Infinity - depth : Infinity + depth;
         } else {
             // Stalemate: Draw, score is 0
             nodeValue = 0;
         }
          // console.log(`Depth ${depth}, Player ${playerToEvaluate}, Terminal Node: ${isInCheck ? 'Checkmate' : 'Stalemate'}, Score: ${nodeValue}`);
          return { score: nodeValue, move: null };
     }
     // TODO: Add draw condition checks (50-move, repetition, insufficient material) here?
     // if (checkThreefoldRepetition() || hasInsufficientMaterial() || halfmoveClock >= 100) {
     //    return { score: 0, move: null };
     // }

     if (depth === 0) { // Depth limit reached, evaluate the position
         nodeValue = evaluateBoard();
         // console.log(`Depth 0, Player ${playerToEvaluate}, Eval: ${nodeValue.toFixed(2)}`);
         return { score: nodeValue, move: null };
     }

     let bestMoveForNode = null;
     // Use a shuffled copy for move ordering (potentially improves pruning)
     const orderedMoves = [...possibleMoves].sort(() => Math.random() - 0.5); 
     // Simple random shuffle, better ordering (captures, checks) could be implemented.

     if (maximizingPlayer) { // White's turn (or AI if white)
         let maxEval = -Infinity;
         
         for (const move of orderedMoves) {
             // --- Simulate Move --- 
             // Store state needed for undo. Crucial for correctness.
             const piece = getPieceAt(move.from.row, move.from.col);
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights)); // Deep copy!
             const prevEnPassant = enPassantTarget ? { ...enPassantTarget } : null; // Deep copy!
             const prevHalfmove = halfmoveClock;
             const prevFullmove = fullmoveNumber;
             const prevCurrentPlayer = currentPlayer;
              let capturedEnPassant = null, capturedEnPassantPos = null; // Keep track for undo

             // Make the move on the board
             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
              
              // Handle simulation of special move side effects carefully
              if (move.isEnPassant) {
                  // Captured pawn is on the same RANK as the moving pawn STARTED, but the destination COL
                  capturedEnPassantPos = { row: move.from.row, col: move.to.col }; 
                  capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col); // Get the piece *before* removing
                   if (capturedEnPassant) {
                        setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
                   } else {
                        // This indicates an issue with the move generation or simulation state
                        console.error("Minimax Sim Error: En passant capture failed, no pawn found at", capturedEnPassantPos, "for move", move);
                   }
              }
              // Update castling rights based on the move (simplified version needed here)
              // Need to replicate the logic from the main move execution regarding King/Rook moves/captures
              // This is complex and prone to errors if not perfectly matched. Consider a dedicated simulateMove function.
              updateCastlingRightsSim(piece, captured, move.from.row, move.from.col, move.to.row, move.to.col);
              
              // Update EP target temporarily
              if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                   enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
              } else {
                   enPassantTarget = null;
              }
              // Update clocks temporarily
              if (piece.toUpperCase() === 'P' || captured || move.isEnPassant) halfmoveClock = 0;
              else halfmoveClock++;
              if (prevCurrentPlayer === 'b') fullmoveNumber++; // Increment if it was black's move

              currentPlayer = opponent; // Switch player for recursive call

             // --- Recurse --- 
             const result = minimax(depth - 1, alpha, beta, false); // Go deeper, now it's minimizer's turn
             const evaluation = result.score;

             // --- Undo Simulation --- 
              currentPlayer = prevCurrentPlayer; // Switch back
              fullmoveNumber = prevFullmove; // Restore clocks/state
              halfmoveClock = prevHalfmove;
              enPassantTarget = prevEnPassant; 
              castlingRights = prevCastling; // Restore castling rights (deep copied version)
              
              // Restore board pieces
              setPieceAt(move.from.row, move.from.col, piece); // Put moving piece back
              setPieceAt(move.to.row, move.to.col, captured); // Put captured piece back (or null)
              if (move.isEnPassant && capturedEnPassantPos && capturedEnPassant) { // Restore captured EP pawn
                  setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
              }
              // --- Simulation Undo Complete --- 

             // --- Update Max and Alpha --- 
             if (evaluation > maxEval) {
                  maxEval = evaluation;
                  bestMoveForNode = move; // Store the move that led to this best score
             }
             alpha = Math.max(alpha, evaluation);
             if (beta <= alpha) {
                 // console.log(`Beta cutoff at depth ${depth} for max player`);
                 break; // Beta cut-off
             }
         }
         return { score: maxEval, move: bestMoveForNode };

     } else { // Minimizing player (Black's turn or AI if black)
         let minEval = Infinity;
         
         for (const move of orderedMoves) {
              // --- Simulate Move (Similar to maximizing player) --- 
             const piece = getPieceAt(move.from.row, move.from.col);
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights));
             const prevEnPassant = enPassantTarget ? { ...enPassantTarget } : null;
             const prevHalfmove = halfmoveClock;
             const prevFullmove = fullmoveNumber;
             const prevCurrentPlayer = currentPlayer;
             let capturedEnPassant = null, capturedEnPassantPos = null;

             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
             if (move.isEnPassant) {
                 capturedEnPassantPos = { row: move.from.row, col: move.to.col };
                 capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                  if (capturedEnPassant) {
                       setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
                  } else {
                      console.error("Minimax Sim Error (Min): En passant capture failed, no pawn found at", capturedEnPassantPos, "for move", move);
                  }
             }
             updateCastlingRightsSim(piece, captured, move.from.row, move.from.col, move.to.row, move.to.col);
             if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                 enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
             } else {
                 enPassantTarget = null;
             }
             if (piece.toUpperCase() === 'P' || captured || move.isEnPassant) halfmoveClock = 0;
             else halfmoveClock++;
              if (prevCurrentPlayer === 'b') fullmoveNumber++;

             currentPlayer = opponent; // Switch player

             // --- Recurse --- 
              const result = minimax(depth - 1, alpha, beta, true); // Go deeper, now it's maximizer's turn
              const evaluation = result.score;

             // --- Undo Simulation --- 
              currentPlayer = prevCurrentPlayer;
              fullmoveNumber = prevFullmove;
              halfmoveClock = prevHalfmove;
              enPassantTarget = prevEnPassant;
              castlingRights = prevCastling;
              setPieceAt(move.from.row, move.from.col, piece);
              setPieceAt(move.to.row, move.to.col, captured);
              if (move.isEnPassant && capturedEnPassantPos && capturedEnPassant) {
                  setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
              }
              // --- Simulation Undo Complete --- 

             // --- Update Min and Beta --- 
             if (evaluation < minEval) {
                  minEval = evaluation;
                  bestMoveForNode = move; // Store move
             }
             beta = Math.min(beta, evaluation);
             if (beta <= alpha) {
                  // console.log(`Alpha cutoff at depth ${depth} for min player`);
                 break; // Alpha cut-off
             }
         }
          return { score: minEval, move: bestMoveForNode };
     }
}

/**
 * Simplified update of castling rights for AI simulation.
 * Needs to mirror the logic in the main game execution.
 * Modifies the GLOBAL castlingRights object during simulation.
 */
function updateCastlingRightsSim(piece, capturedPiece, fromRow, fromCol, toRow, toCol) {
     const player = getPlayerForPiece(piece);
     const opponent = getOpponent(player);

     // King move
     if (piece.toUpperCase() === 'K') {
         if (player === 'w') { castlingRights.w.K = castlingRights.w.Q = false; }
         else { castlingRights.b.K = castlingRights.b.Q = false; }
     }
     // Rook move from starting square
     if (piece.toUpperCase() === 'R') {
         if (player === 'w') {
             if (fromRow === 7 && fromCol === 0) castlingRights.w.Q = false; // a1
             if (fromRow === 7 && fromCol === 7) castlingRights.w.K = false; // h1
         } else {
             if (fromRow === 0 && fromCol === 0) castlingRights.b.Q = false; // a8
             if (fromRow === 0 && fromCol === 7) castlingRights.b.K = false; // h8
         }
     }
     // Capture of opponent's rook on its starting square
     if (capturedPiece && capturedPiece.toUpperCase() === 'R') {
         if (opponent === 'w') { // Opponent is white, their rook was captured
             if (toRow === 7 && toCol === 0) castlingRights.w.Q = false; // a1 captured
             if (toRow === 7 && toCol === 7) castlingRights.w.K = false; // h1 captured
         } else { // Opponent is black, their rook was captured
             if (toRow === 0 && toCol === 0) castlingRights.b.Q = false; // a8 captured
             if (toRow === 0 && toCol === 7) castlingRights.b.K = false; // h8 captured
         }
     }
}


// --- END OF FILE aiPlayer.js --- 