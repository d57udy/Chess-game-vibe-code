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

// --- AI Calculation Parameters ---
const ELO_RANDOM_MOVE_THRESHOLD = 700; // Below this ELO, more random moves
const ELO_SIMPLE_EVAL_THRESHOLD = 1500; // Below this ELO, use 1-ply evaluation
const BASE_MINIMAX_DEPTH = 2; // Min depth for minimax
const ELO_PER_DEPTH_INCREASE = 300; // Increase depth every ~300 ELO points above threshold
const MAX_MINIMAX_DEPTH = 5; // Cap depth to prevent excessive calculation time

// --- AI Calculation --- 

/**
 * Calculates the best move for the current player based on ELO rating.
 * Relies on global game state variables from gameLogic.js (board, currentPlayer, etc.)
 * and functions like getAllLegalMoves, evaluateBoard, minimax.
 * @param {number} elo - AI ELO rating (e.g., 300-2500).
 * @returns {object | null} The best move object { from: {r, c}, to: {r, c}, piece, isPromotion, promotionPiece, ... } or null if no moves.
 */
function calculateBestMove(elo) {
    // Assumes currentPlayer is set correctly in gameLogic.js
    const availableMoves = getAllLegalMoves(currentPlayer);
    if (availableMoves.length === 0) {
        console.log(`AI (ELO ${elo}): No legal moves available.`);
        return null;
    }

    // Shuffle moves initially for randomness & tie-breaking
    const shuffledMoves = [...availableMoves].sort(() => Math.random() - 0.5);

    let bestMove = shuffledMoves[0]; // Default to first random move
    let calculationStartTime = performance.now();

    try { // Add try-catch around AI logic
        if (elo < ELO_RANDOM_MOVE_THRESHOLD) {
            // --- Low ELO: Mostly Random --- 
            // Try to find a non-capture move that doesn't immediately hang a piece
            // (Similar to old 'Very Easy' but simpler)
            let nonLosingMoves = shuffledMoves.filter(move => {
                const captured = getPieceAt(move.to.row, move.to.col);
                if (captured) return true; // Captures are okay

                // Simulate move briefly (only check if destination is attacked)
                const piece = getPieceAt(move.from.row, move.from.col);
                // Temporarily modify board state (careful!)
                setPieceAt(move.to.row, move.to.col, piece);
                setPieceAt(move.from.row, move.from.col, null);

                let isHanging = isSquareAttacked(move.to.row, move.to.col, getOpponent(currentPlayer));

                // Undo simulation
                setPieceAt(move.from.row, move.from.col, piece);
                setPieceAt(move.to.row, move.to.col, captured); // Restore original target square content

                return !isHanging; // Prefer moves that don't immediately hang the piece
            });

            if (nonLosingMoves.length > 0) {
                 // Introduce randomness: Sometimes pick a hanging move anyway
                 if (Math.random() > (elo / ELO_RANDOM_MOVE_THRESHOLD) * 0.7) { // Higher ELO = less chance of blunder
                      bestMove = shuffledMoves[0]; // Pick potentially bad move
                      console.log(`AI (ELO ${elo}): Randomly chose potentially hanging move.`);
                 } else {
                      bestMove = nonLosingMoves[0]; // Pick from safer moves
                      console.log(`AI (ELO ${elo}): Chose non-hanging random move.`);
                 }
            } else {
                 // If all moves seem to hang or are captures, just pick the first random one
                 bestMove = shuffledMoves[0];
                 console.log(`AI (ELO ${elo}): Chose random move (all hanging or captures).`);
            }

        } else if (elo < ELO_SIMPLE_EVAL_THRESHOLD) {
            // --- Mid ELO: Simple Evaluation (1-ply) --- 
            let bestScore = (currentPlayer === 'w') ? -Infinity : Infinity;
            let currentBestMove = null;
            let candidateMoves = []; // Store moves and scores

            shuffledMoves.forEach(move => {
                // Simulate move (reusing simulation logic)
                const { score } = simulateMoveAndEvaluate(move); 

                // Store move and score
                candidateMoves.push({ move, score });

                // Keep track of the absolute best score found
                if (currentPlayer === 'w') {
                    if (score > bestScore) { bestScore = score; currentBestMove = move; }
                } else {
                    if (score < bestScore) { bestScore = score; currentBestMove = move; }
                }
            });

             // Add randomness: Sometimes pick a slightly worse move
             const scoreThreshold = 0.5; // How much worse a move can be to still be considered (adjust based on ELO?)
             const goodEnoughMoves = candidateMoves.filter(c => {
                 if (currentPlayer === 'w') return c.score >= bestScore - scoreThreshold;
                 else return c.score <= bestScore + scoreThreshold;
             });

             if (goodEnoughMoves.length > 0 && Math.random() < 0.3) { // 30% chance to pick from 'good enough' moves
                 bestMove = goodEnoughMoves[Math.floor(Math.random() * goodEnoughMoves.length)].move;
                 console.log(`AI (ELO ${elo}): Chose randomly from good moves (Score ~${bestScore.toFixed(2)}).`, bestMove);
             } else if (currentBestMove) {
                 bestMove = currentBestMove;
                 console.log(`AI (ELO ${elo}): Chose best 1-ply move (Score ${bestScore.toFixed(2)}).`, bestMove);
             } else {
                 console.warn(`AI (ELO ${elo}): Simple evaluation failed, falling back to random.`);
                 bestMove = shuffledMoves[0]; // Fallback
             }

        } else {
            // --- High ELO: Minimax --- 
            // Calculate depth based on ELO
            const eloAboveThreshold = Math.max(0, elo - ELO_SIMPLE_EVAL_THRESHOLD);
            let depth = BASE_MINIMAX_DEPTH + Math.floor(eloAboveThreshold / ELO_PER_DEPTH_INCREASE);
            depth = Math.min(depth, MAX_MINIMAX_DEPTH); // Cap depth
            
            console.log(`AI (ELO ${elo}): Starting Minimax search with depth ${depth}...`);
            const result = minimax(depth, -Infinity, Infinity, currentPlayer === 'w');
            
            if (result && result.move) {
                bestMove = result.move;
                 // Ensure promotion piece is included (Minimax should return the full move object from getAllLegalMoves)
                 if (bestMove.isPromotion && !bestMove.promotionPiece) {
                      console.warn(`Minimax returned promotion move without piece type, defaulting to Queen.`);
                      bestMove.promotionPiece = 'Q'; // Default promotion
                 }
                 console.log(`AI (ELO ${elo}): Minimax (Depth ${depth}) found move with score ${result.score.toFixed(2)}`, bestMove);
            } else {
                 console.warn(`Minimax (Depth ${depth}) did not return a valid move (Score: ${result?.score}). Falling back.`);
                 // Fallback: Try 1-ply eval if minimax fails unexpectedly
                 const fallbackMoveData = calculateBestMove(ELO_SIMPLE_EVAL_THRESHOLD - 1); // Use mid-ELO logic
                 if (fallbackMoveData) {
                     bestMove = fallbackMoveData;
                 } else {
                     bestMove = shuffledMoves[0]; // Absolute fallback
                 }
            }
        }

    } catch (error) {
         console.error(`Error during AI (ELO ${elo}) move calculation:`, error);
         // Fallback to random if calculation fails
         bestMove = shuffledMoves[0];
         console.log(`AI (ELO ${elo}): Calculation failed, choosing random move.`);
    }
    
    let calculationEndTime = performance.now();
    console.log(`AI calculation time: ${(calculationEndTime - calculationStartTime).toFixed(1)} ms`);

    return bestMove;
}

/**
 * Helper function to simulate a move, evaluate the board, and undo the move.
 * Used by Mid ELO AI.
 * @param {object} move - The move object to simulate.
 * @returns {{score: number}} - The evaluation score after the move.
 */
function simulateMoveAndEvaluate(move) {
    // --- Simulate Move --- 
     const piece = getPieceAt(move.from.row, move.from.col);
     const captured = getPieceAt(move.to.row, move.to.col);
     // Need to handle state changes carefully for evaluation only
     const prevEnPassant = enPassantTarget ? {...enPassantTarget} : null; 
     const prevCastling = JSON.parse(JSON.stringify(castlingRights)); // Need for accurate eval?
     let capturedEnPassant = null, capturedEnPassantPos = null;

     setPieceAt(move.to.row, move.to.col, piece);
     setPieceAt(move.from.row, move.from.col, null);
     if (move.isEnPassant) {
         capturedEnPassantPos = { row: move.from.row, col: move.to.col }; // Pos of captured pawn
         capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col); // Get the piece
         if (capturedEnPassant) setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
     }
      // Simplified state updates for 1-ply evaluation (EP target might matter)
      if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
           enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
      } else {
           enPassantTarget = null;
      }
      // Castling rights update needed? For 1-ply maybe not critical, but good practice
       updateCastlingRightsSim(piece, captured, move.from.row, move.from.col, move.to.row, move.to.col);

    // --- Evaluate --- 
    let score = evaluateBoard();
    
    // --- Undo Simulation --- 
     castlingRights = prevCastling; // Restore castling rights
     enPassantTarget = prevEnPassant; // Restore EP target
     setPieceAt(move.from.row, move.from.col, piece); // Put moving piece back
     setPieceAt(move.to.row, move.to.col, captured); // Put captured piece back (or null)
     if (move.isEnPassant && capturedEnPassantPos && capturedEnPassant) {
         setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant); // Restore EP captured pawn
     }
     
     return { score };
}

/**
 * Generates all legal moves for a given player.
 * This is a crucial function for the AI.
 * @param {string} player - The player ('w' or 'b') whose moves to generate.
 * @returns {Array<object>} A list of all legal move objects for that player.
 *                         Each move object: { from: {r, c}, to: {r, c}, piece, isPromotion, promotionPiece, isCastling, isEnPassant }
 */
function getAllLegalMoves(player) {
    const allMoves = [];
    const originalPlayer = currentPlayer; // Backup context
    currentPlayer = player; // Temporarily set global context

    try {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                const piece = getPieceAt(r, c);
                if (piece && getPlayerForPiece(piece) === player) {
                    // generateLegalMoves filters for check internally
                    const moves = generateLegalMoves(r, c); // Uses the temporary currentPlayer
                    
                    moves.forEach(move => {
                        // Construct the detailed move object needed by AI
                        const moveDetails = {
                            from: { row: r, col: c },
                            to: { row: move.row, col: move.col },
                            piece: piece,
                            isPromotion: move.isPromotion || false,
                            isCastling: move.isCastling || false,
                            isEnPassant: move.isEnPassant || false,
                            promotionPiece: move.isPromotion ? 'Q' : null // *** ADDED Default Promotion Piece ***
                        };
                        // TODO: Allow AI to choose promotion? For now, default to Queen.
                        // If minimax logic is refined, it could potentially return a different piece.
                        allMoves.push(moveDetails);
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
             const piece = move.piece;
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights)); // Deep copy!
             const prevEnPassant = enPassantTarget ? { ...enPassantTarget } : null; // Deep copy!
             const prevHalfmove = halfmoveClock;
             const prevFullmove = fullmoveNumber;
             const prevCurrentPlayer = currentPlayer;
             let capturedEnPassant = null, capturedEnPassantPos = null; // Keep track for undo

             // Make the move on the board
             // Handle promotion piece correctly during simulation if needed?
             // For evaluation, placing the *actual* promoted piece matters.
             const pieceToPlace = move.isPromotion ? (maximizingPlayer ? move.promotionPiece.toUpperCase() : move.promotionPiece.toLowerCase()) : piece;
             setPieceAt(move.to.row, move.to.col, pieceToPlace); 
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
              if (piece.toUpperCase() === 'P' || captured || move.isEnPassant || move.isPromotion) halfmoveClock = 0;
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
                  bestMoveForNode = move; // Store the *entire move object*
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
             const piece = move.piece;
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
             if (piece.toUpperCase() === 'P' || captured || move.isEnPassant || move.isPromotion) halfmoveClock = 0;
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