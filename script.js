// --- START OF FILE script_new.js ---

// --- Game Constants ---
const BOARD_SIZE = 8;
const PIECES = {
    // White
    P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔',
    // Black
    p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚'
};
const INITIAL_BOARD_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"; // Standard starting position

// --- Game State Variables ---
let board = []; // 2D array representing the board [row][col]
let currentPlayer = 'w'; // 'w' for white, 'b' for black
let selectedSquare = null; // { row: r, col: c }
let legalMoves = []; // Array of possible moves for the selected piece [{ row: r, col: c }, ...]
let gameHistory = []; // Stores past game states { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, moveNotation, moveNumber }
let currentMoveIndex = -1; // Index in gameHistory, points to the *current* state
let isGameOver = false;
let gameStatusMessage = "Game started. White's turn.";
let castlingRights = { w: { K: true, Q: true }, b: { K: true, Q: true } }; // Kingside/Queenside
let enPassantTarget = null; // Square behind a pawn that just moved two steps, e.g., { row: 2, col: 4 }
let halfmoveClock = 0; // For 50-move rule
let fullmoveNumber = 1; // Increments after black moves
let aiDifficulty = 2; // -1: Human vs Human, 0: Very Easy, 1: Easy, 2: Medium, 3: Hard
let soundEnabled = true;
let captureAnimationEnabled = true;
let isAIThinking = false;

// --- DOM Elements ---
const boardElement = document.getElementById('chess-board');
const turnIndicator = document.getElementById('turn-indicator');
const statusMessageElement = document.getElementById('status-message');
const difficultyLabel = document.getElementById('difficulty-label');
const difficultySelect = document.getElementById('difficulty-select');
const newGameButton = document.getElementById('new-game-button');
const undoButton = document.getElementById('undo-button');
const hintButton = document.getElementById('hint-button');
const muteButton = document.getElementById('mute-button');
const toggleAnimationButton = document.getElementById('toggle-animation-button');
const moveHistoryElement = document.getElementById('move-history');
const promotionModal = document.getElementById('promotion-modal');
const promotionButtons = promotionModal.querySelectorAll('button');
const captureCanvas = document.getElementById('capture-animation-canvas'); // For Three.js
const redoButton = document.getElementById('redo-button'); // Add Redo Button

// --- Audio Elements ---
const sounds = {
    move: new Audio('move.mp3'),       // Replace with your sound file path
    capture: new Audio('capture.mp3'), // Replace with your sound file path
    check: new Audio('check.mp3'),     // Replace with your sound file path
    gameOver: new Audio('game-over.mp3') // Replace with your sound file path
};
Object.values(sounds).forEach(sound => sound.preload = 'auto'); // Preload sounds

// --- Three.js Placeholder ---
let scene, camera, renderer;
function init3DAnimation() {
    console.log("Initializing 3D setup (Placeholder)");
    // ... (placeholder code remains the same)
}
function animateCapture3D(attackerPiece, defenderPiece, callback) {
    if (!captureAnimationEnabled) {
        console.log("Capture animation disabled.");
        if (callback) callback();
        return;
    }
    console.log(`Placeholder: 3D Animation - ${attackerPiece} captures ${defenderPiece}`);
    captureCanvas.style.display = 'block';
    setTimeout(() => {
        console.log("3D Animation finished (Placeholder)");
        captureCanvas.style.display = 'none';
        if (callback) callback();
    }, 1500);
}

// --- Game Initialization ---
function initGame() {
    console.log("Initializing game...");
    isGameOver = false;
    isAIThinking = false;
    selectedSquare = null;
    legalMoves = [];
    gameHistory = [];
    currentMoveIndex = -1;
    parseFen(INITIAL_BOARD_FEN);
    createBoardDOM();
    renderBoard();
    pushHistoryState({}); // Save the initial state (no move info)
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    updateHistoryButtons();
    console.log("Game Initialized. Current Player:", currentPlayer);
    
    // Update game mode messaging
    updateGameModeDisplay();
}

// --- Helper function to determine if we're in AI mode ---
function isAIMode() {
    return aiDifficulty >= 0;
}

// --- Update display for game mode ---
function updateGameModeDisplay() {
    const modeText = isAIMode() ? 
        `AI Difficulty: ${difficultySelect.options[aiDifficulty].text}` : 
        "Mode: Human vs Human";
    difficultyLabel.textContent = modeText;
}

// --- FEN Parsing ---
function parseFen(fen) {
    const parts = fen.split(' ');
    const boardFen = parts[0];
    currentPlayer = parts[1];
    const castlingFen = parts[2];
    const enPassantFen = parts[3];
    halfmoveClock = parseInt(parts[4], 10);
    fullmoveNumber = parseInt(parts[5], 10);

    // Parse board
    board = [];
    const rows = boardFen.split('/');
    for (let r = 0; r < BOARD_SIZE; r++) {
        board[r] = [];
        let col = 0;
        for (const char of rows[r]) {
            if (isNaN(char)) {
                board[r][col] = char;
                col++;
            } else {
                const emptySquares = parseInt(char, 10);
                for (let i = 0; i < emptySquares; i++) {
                    board[r][col] = null;
                    col++;
                }
            }
        }
    }

    // Parse castling rights
    castlingRights = { w: { K: false, Q: false }, b: { K: false, Q: false } };
    if (castlingFen !== '-') {
        for (const char of castlingFen) {
            if (char === 'K') castlingRights.w.K = true;
            if (char === 'Q') castlingRights.w.Q = true;
            if (char === 'k') castlingRights.b.K = true;
            if (char === 'q') castlingRights.b.Q = true;
        }
    }

    // Parse en passant target
    enPassantTarget = null;
    if (enPassantFen !== '-') {
        const file = enPassantFen.charCodeAt(0) - 'a'.charCodeAt(0);
        const rank = BOARD_SIZE - parseInt(enPassantFen[1], 10);
        enPassantTarget = { row: rank, col: file };
    }
    // console.log("FEN Parsed:", { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber });
}

// --- Board DOM Creation ---
function createBoardDOM() {
    boardElement.innerHTML = ''; // Clear existing board
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const square = document.createElement('div');
            square.classList.add('square');
            square.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');
            square.dataset.row = r;
            square.dataset.col = c;
            square.dataset.rank = BOARD_SIZE - r;
            square.dataset.file = String.fromCharCode('a'.charCodeAt(0) + c);
            square.addEventListener('click', () => handleSquareClick(r, c));
            boardElement.appendChild(square);
        }
    }
}

// --- Board Rendering ---
function renderBoard() {
    document.querySelectorAll('.piece').forEach(p => p.remove());
    document.querySelectorAll('.square.in-check').forEach(sq => sq.classList.remove('in-check'));

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = board[r][c];
            if (piece) {
                const squareElement = getSquareElement(r, c);
                if (squareElement) {
                    const pieceElement = document.createElement('div');
                    pieceElement.classList.add('piece');
                    pieceElement.textContent = PIECES[piece];
                    pieceElement.dataset.piece = piece;
                    pieceElement.dataset.row = r; // Keep track for finding elements
                    pieceElement.dataset.col = c;

                    pieceElement.style.position = 'absolute';
                    pieceElement.style.left = `${c * 100 / BOARD_SIZE}%`;
                    pieceElement.style.top = `${r * 100 / BOARD_SIZE}%`;
                    pieceElement.style.width = `${100 / BOARD_SIZE}%`;
                    pieceElement.style.height = `${100 / BOARD_SIZE}%`;
                    pieceElement.style.fontSize = '7vmin'; // Adjusted size slightly
                    pieceElement.style.display = 'flex';
                    pieceElement.style.justifyContent = 'center';
                    pieceElement.style.alignItems = 'center';
                    pieceElement.style.lineHeight = '1';

                    // Add click handler BEFORE appending
                    pieceElement.addEventListener('click', (e) => {
                        e.stopPropagation();
                        handleSquareClick(r, c);
                    });

                    boardElement.appendChild(pieceElement);

                    const kingPieceForPlayer = (currentPlayer === 'w') ? 'K' : 'k';
                    if (piece === kingPieceForPlayer && isKingInCheck(currentPlayer)) {
                       squareElement.classList.add('in-check');
                    }
                    // Check opponent's king as well if needed for display
                     const kingPieceForOpponent = (currentPlayer === 'w') ? 'k' : 'K';
                      if (piece === kingPieceForOpponent && isKingInCheck(getOpponent(currentPlayer))) {
                         squareElement.classList.add('in-check');
                      }
                }
            }
        }
    }
    highlightSelectedSquare();
    highlightLegalMoves(); // Call even if no square selected to clear old highlights
    // console.log("Board rendered.");
}


// --- Square/Piece Utilities ---
function getSquareElement(row, col) {
    return boardElement.querySelector(`.square[data-row="${row}"][data-col="${col}"]`);
}

function getPieceElement(row, col) {
    return boardElement.querySelector(`.piece[data-row="${row}"][data-col="${col}"]`);
}

function getPieceAt(r, c) {
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    return board[r][c];
}

function setPieceAt(r, c, piece) {
    if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) {
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

// --- Event Handling ---
function handleSquareClick(row, col) {
    // console.log(`Clicked square: (${row}, ${col})`);
    if (isGameOver || isAIThinking) return;

    const clickedPiece = getPieceAt(row, col);

    if (selectedSquare) {
        const move = legalMoves.find(m => m.row === row && m.col === col);
        if (move) {
            // console.log("Attempting move:", selectedSquare, "->", { row, col });
            makeMove(selectedSquare.row, selectedSquare.col, row, col, move.isPromotion);
            clearSelectionAndHighlights();
            // Trigger AI move handled within finishMoveProcessing after player move completes
        } else {
            clearSelectionAndHighlights();
            if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
                selectPiece(row, col);
            }
        }
    } else {
        if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
            selectPiece(row, col);
        }
    }
}

function selectPiece(row, col) {
    selectedSquare = { row, col };
    // console.log("Selected piece:", getPieceAt(row, col), "at", selectedSquare);
    legalMoves = generateLegalMoves(row, col); // generateLegalMoves must ALWAYS return an array
    // console.log("Generated legal moves:", legalMoves);
    highlightSelectedSquare();
    highlightLegalMoves();
}

function clearSelectionAndHighlights() {
    selectedSquare = null;
    legalMoves = []; // Reset to empty array
    document.querySelectorAll('.square.selected').forEach(sq => sq.classList.remove('selected'));
    document.querySelectorAll('.square.legal-move').forEach(sq => sq.classList.remove('legal-move'));
    document.querySelectorAll('.square.capture-move').forEach(sq => sq.classList.remove('capture-move'));
}

function highlightSelectedSquare() {
    document.querySelectorAll('.square.selected').forEach(sq => sq.classList.remove('selected'));
    if (selectedSquare) {
        const squareElement = getSquareElement(selectedSquare.row, selectedSquare.col);
        if (squareElement) {
            squareElement.classList.add('selected');
        }
    }
}

function highlightLegalMoves() {
    document.querySelectorAll('.square.legal-move, .square.capture-move').forEach(sq => {
        sq.classList.remove('legal-move', 'capture-move');
    });

    // Ensure legalMoves is always an array before using forEach
    if (Array.isArray(legalMoves)) {
        legalMoves.forEach(move => {
            const squareElement = getSquareElement(move.row, move.col);
            if (squareElement) {
                const isCapture = getPieceAt(move.row, move.col) !== null || move.isEnPassant;
                squareElement.classList.add(isCapture ? 'capture-move' : 'legal-move');
            } else {
                 console.warn(`Could not find square element for legal move: ${move.row}, ${move.col}`);
            }
        });
    } else {
         console.error("highlightLegalMoves called when legalMoves is not an array:", legalMoves);
         legalMoves = []; // Reset to prevent further errors if state is corrupt
    }
}

// --- Move Execution ---
function makeMove(fromRow, fromCol, toRow, toCol, isPromotion = false) {
    const piece = board[fromRow][fromCol];
    if (!piece) {
        console.error("Attempted to move from an empty square!", {fromRow, fromCol});
        clearSelectionAndHighlights(); // Clear selection if invalid state found
        return;
    }
    const capturedPiece = board[toRow][toCol];
    let specialMove = null;

    // Store previous state info
    const prevStateInfo = {
        currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)),
        enPassantTarget,
        halfmoveClock,
        fullmoveNumber
    };

    // Calculate base notation
    let moveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion);

    // --- Handle Special Moves ---

    if (isPromotion) {
        specialMove = 'promotion';
        showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, prevStateInfo, moveNotation);
        return;
    }

    const isEnPassantCapture = (piece.toUpperCase() === 'P') &&
                               toCol !== fromCol && !capturedPiece &&
                               enPassantTarget && toRow === enPassantTarget.row && toCol === enPassantTarget.col;

    if (isEnPassantCapture) {
        specialMove = 'enpassant';
        const capturedPawnRow = currentPlayer === 'w' ? toRow + 1 : toRow - 1;
        const capturedPawnActual = board[capturedPawnRow][toCol];
        setPieceAt(capturedPawnRow, toCol, null);
        animateAndRemovePiece(capturedPawnRow, toCol, capturedPawnActual, true);
    }

    const isCastling = (piece.toUpperCase() === 'K') && Math.abs(toCol - fromCol) === 2;
    let rookFromCol, rookToCol, rookRow, rookPiece; // Renamed 'rook' to 'rookPiece'
    if (isCastling) {
        specialMove = 'castling';
        rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
        rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        rookRow = fromRow;
        rookPiece = board[rookRow][rookFromCol]; // Get the actual rook piece

        // Logically move rook ONLY if it exists
        if (rookPiece) {
             setPieceAt(rookRow, rookToCol, rookPiece);
             setPieceAt(rookRow, rookFromCol, null);
        } else {
             console.error("Castling Error: Rook not found at expected position:", {rookRow, rookFromCol});
             // Decide how to handle this - maybe revert king move? For now, proceed but log error.
        }
        moveNotation = (toCol > fromCol) ? "O-O" : "O-O-O";
    }

    // --- Update Board State (Main Piece Move) ---
    setPieceAt(toRow, toCol, piece);
    setPieceAt(fromRow, fromCol, null);

    // --- Animate Movement ---
    const pieceElement = getPieceElement(fromRow, fromCol);
    const targetSquareElement = getSquareElement(toRow, toCol);

    const onKingMoveComplete = () => {
        if (isCastling) {
             // Find the visual rook element *where it was* before the logical move
             const originalRookElement = getPieceElement(rookRow, rookFromCol);
             const rookTargetSquareElement = getSquareElement(rookRow, rookToCol);
             if (originalRookElement && rookTargetSquareElement) { // Check if element exists
                animatePieceMovement(originalRookElement, rookTargetSquareElement, rookRow, rookToCol, () => {
                    finishMoveProcessing(prevStateInfo, piece, capturedPiece || (isEnPassantCapture ? 'P' : null), fromRow, fromCol, toRow, toCol, specialMove, moveNotation);
                });
             } else {
                 console.error("Castling Animation Error: Rook element not found for animation.");
                 // Proceed without rook animation if element missing
                 finishMoveProcessing(prevStateInfo, piece, capturedPiece || (isEnPassantCapture ? 'P' : null), fromRow, fromCol, toRow, toCol, specialMove, moveNotation);
             }
        } else {
             // Pass the correct captured piece info (including for en passant)
             finishMoveProcessing(prevStateInfo, piece, capturedPiece || (isEnPassantCapture ? 'P' : null), fromRow, fromCol, toRow, toCol, specialMove, moveNotation);
        }
    };

    if (capturedPiece && !isEnPassantCapture) {
        animateAndRemovePiece(toRow, toCol, capturedPiece, false, () => {
            animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, onKingMoveComplete);
        }, fromRow, fromCol);
    } else {
        animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, onKingMoveComplete);
    }
}


// --- Promotion Handling ---
function showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, prevStateInfo, baseMoveNotation) {
    promotionModal.style.display = 'flex';

    // Clear previous listeners first
    promotionButtons.forEach(button => {
        const newButton = button.cloneNode(true); // Clone to remove listeners easily
        button.parentNode.replaceChild(newButton, button);
    });
    // Re-select buttons after cloning
    const currentPromotionButtons = promotionModal.querySelectorAll('button');

    currentPromotionButtons.forEach(button => {
        button.onclick = () => { // Use onclick for simplicity after cloning
            const promotionPieceType = button.dataset.piece;
            const promotionPiece = currentPlayer === 'w' ? promotionPieceType.toUpperCase() : promotionPieceType.toLowerCase();
            promotionModal.style.display = 'none';

            // Store original piece for proper history before modifying board
            const originalPiece = piece;
            
            setPieceAt(toRow, toCol, promotionPiece); // Finalize board state
            setPieceAt(fromRow, fromCol, null); // Remove pawn from original position

            const finalMoveNotation = baseMoveNotation + "=" + promotionPieceType.toUpperCase();

            const pawnElement = getPieceElement(toRow, toCol); // Find the piece visually *at the destination* now

            const finishPromotionMove = () => {
                if(pawnElement) {
                    pawnElement.textContent = PIECES[promotionPiece];
                    pawnElement.dataset.piece = promotionPiece;
                } else {
                    console.warn("Pawn element for promotion update not found, might need re-render.");
                }
                
                // Make sure we store the promotion explicitly in state
                finishMoveProcessing(prevStateInfo, originalPiece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation);
            };

            if (pawnElement) {
                pawnElement.textContent = PIECES[promotionPiece];
                pawnElement.dataset.piece = promotionPiece;
            }
            
            finishMoveProcessing(prevStateInfo, originalPiece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation);
            renderBoard(); // Force render after promotion choice to be sure
        };
    });
}


// --- Post-Animation Move Processing ---
function finishMoveProcessing(prevStateInfo, piece, capturedPieceLogical, fromRow, fromCol, toRow, toCol, specialMove, finalMoveNotation) {
    // Note: capturedPieceLogical includes 'P'/'p' for en passant

    // --- Update Castling Rights ---
    const playerMoved = prevStateInfo.currentPlayer; // The player who just moved
    if (piece === 'K') { castlingRights.w.K = castlingRights.w.Q = false; }
    if (piece === 'k') { castlingRights.b.K = castlingRights.b.Q = false; }
    if (piece === 'R' && fromRow === 7 && fromCol === 0) { castlingRights.w.Q = false; } // Moved from a1
    if (piece === 'R' && fromRow === 7 && fromCol === 7) { castlingRights.w.K = false; } // Moved from h1
    if (piece === 'r' && fromRow === 0 && fromCol === 0) { castlingRights.b.Q = false; } // Moved from a8
    if (piece === 'r' && fromRow === 0 && fromCol === 7) { castlingRights.b.K = false; } // Moved from h8

    // If a rook is captured *on its starting square*
    if (capturedPieceLogical && capturedPieceLogical.toUpperCase() === 'R') {
         if (toRow === 7 && toCol === 0) { castlingRights.w.Q = false; } // a1 captured
         if (toRow === 7 && toCol === 7) { castlingRights.w.K = false; } // h1 captured
         if (toRow === 0 && toCol === 0) { castlingRights.b.Q = false; } // a8 captured
         if (toRow === 0 && toCol === 7) { castlingRights.b.K = false; } // h8 captured
    }


    // --- Update En Passant Target ---
    if (piece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2) {
        enPassantTarget = { row: (fromRow + toRow) / 2, col: fromCol };
    } else {
        enPassantTarget = null;
    }

    // --- Update Clocks ---
    if (piece.toUpperCase() === 'P' || capturedPieceLogical) {
        halfmoveClock = 0;
    } else {
        halfmoveClock++;
    }
    if (playerMoved === 'b') {
        fullmoveNumber++;
    }

    // --- Switch Player ---
    currentPlayer = getOpponent(playerMoved); // Switch to the other player

    // --- Check/Checkmate/Stalemate Calculation ---
    const opponentPlayer = currentPlayer; // The player whose turn it is now
    const kingInCheckNow = isKingInCheck(opponentPlayer);
    let isCheck = false;
    let isMate = false;
    let isStale = false; // Added stalemate flag

    if (!hasLegalMoves(opponentPlayer)) { // Check if the player whose turn it is has any moves
         if (kingInCheckNow) {
             isMate = true; // No legal moves and in check = Checkmate
         } else {
             isStale = true; // No legal moves and not in check = Stalemate
         }
    } else if (kingInCheckNow) {
         isCheck = true; // Has legal moves but is in check
    }


    // Apply check/mate symbols to notation *before* checking draw conditions
    if (isMate) {
        finalMoveNotation += '#';
        isGameOver = true;
        gameStatusMessage = `Checkmate! ${playerMoved === 'w' ? 'White' : 'Black'} wins.`;
        playSound(sounds.gameOver);
    } else if (isCheck) {
        finalMoveNotation += '+';
    } else if (isStale) {
         isGameOver = true;
         gameStatusMessage = "Stalemate! Game is a draw.";
         playSound(sounds.gameOver);
    }


    // --- Play Sounds ---
    let soundToPlay = sounds.move; // Default
    if (capturedPieceLogical) {
         soundToPlay = sounds.capture;
    }
    if (isCheck || isMate) { // Check/Mate sound overrides others
         soundToPlay = sounds.check;
    }
    if (isGameOver && !isMate) { // Play game over for draws too
         soundToPlay = sounds.gameOver;
    }
    playSound(soundToPlay);

    // --- Draw condition checks (only if not already mate/stalemate) ---
    if (!isGameOver) {
         if (halfmoveClock >= 100) {
             gameStatusMessage = "Draw by 50-move rule.";
             isGameOver = true;
             playSound(sounds.gameOver);
         } else if (checkThreefoldRepetition()) {
             gameStatusMessage = "Draw by threefold repetition.";
             isGameOver = true;
             playSound(sounds.gameOver);
         } else if (hasInsufficientMaterial()) {
             gameStatusMessage = "Draw by insufficient material.";
             isGameOver = true;
             playSound(sounds.gameOver);
         }
    }

    // --- Record History ---
    recordMove(prevStateInfo, finalMoveNotation);

    // --- Update UI ---
    renderBoard();
    updateStatusDisplay();

    // --- Trigger AI if applicable ---
    if (!isGameOver && currentPlayer === 'b' && isAIMode()) { // Only trigger AI if in AI mode
        triggerAIMove();
    }
    // console.log("Move processing complete.");
}


// --- Animation Functions ---
function animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, onComplete) {
    if (!pieceElement || !targetSquareElement) {
        console.warn("Animation target elements missing for move.", {pieceElement, targetSquareElement});
        if (onComplete) onComplete();
        return;
    }

    const targetLeft = `${toCol * 100 / BOARD_SIZE}%`;
    const targetTop = `${toRow * 100 / BOARD_SIZE}%`;

    gsap.to(pieceElement, {
        left: targetLeft,
        top: targetTop,
        duration: 0.35,
        ease: "power2.out",
        onComplete: () => {
            // Update data attributes *after* animation
            pieceElement.dataset.row = toRow;
            pieceElement.dataset.col = toCol;
            if (onComplete) {
                onComplete();
            }
        }
    });
}

function animateAndRemovePiece(row, col, pieceType, isEnPassant = false, onComplete, attackerRow, attackerCol) {
    const pieceElement = getPieceElement(row, col); // Find piece at capture square
    if (pieceElement) {
         if (captureAnimationEnabled && !isEnPassant) {
             let attackerPiece = null;
             // Try to determine attacker from selected square or AI hint
             if (selectedSquare) {
                 attackerPiece = getPieceAt(selectedSquare.row, selectedSquare.col);
             } else if (attackerRow !== undefined && attackerCol !== undefined) {
                 attackerPiece = getPieceAt(attackerRow, attackerCol);
             }
             if (attackerPiece) {
                 animateCapture3D(attackerPiece, pieceType, () => {
                     pieceElement.remove();
                     if (onComplete) onComplete();
                 });
                 return; // Use 3D animation if possible
             } else {
                  console.warn("Could not determine attacker for 3D animation, using fade.");
             }
         }

         // Fallback: Simple fade out
         pieceElement.style.transition = 'opacity 0.3s ease-out';
         pieceElement.style.opacity = '0';
         setTimeout(() => {
             // Double check element exists before removing, might have been removed by other means
             if (document.body.contains(pieceElement)) {
                pieceElement.remove();
             }
             if (onComplete) onComplete();
         }, 300);

    } else {
        console.warn(`Capture Animation: Piece element not found at target (${row}, ${col})`);
        if (onComplete) onComplete(); // Ensure callback happens
    }
}


// --- Sound Control ---
function playSound(audioElement) {
    if (soundEnabled && audioElement) {
        audioElement.currentTime = 0; // Rewind to start
        audioElement.play().catch(e => console.error("Error playing sound:", e));
    }
}
function toggleMute() {
    soundEnabled = !soundEnabled;
    muteButton.textContent = soundEnabled ? "Mute Sounds" : "Unmute Sounds";
    console.log("Sound enabled:", soundEnabled);
}
function toggleCaptureAnimation() {
    captureAnimationEnabled = !captureAnimationEnabled;
    toggleAnimationButton.textContent = captureAnimationEnabled ? "Disable Capture Animations" : "Enable Capture Animations";
    console.log("Capture animations enabled:", captureAnimationEnabled);
     if (captureAnimationEnabled && !renderer) {
         console.log("Note: 3D animation setup is still a placeholder.");
     }
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

    // --- START: FIX for 'forEach of undefined' ---
    // Filter out moves that leave the king in check
    const legalMovesResult = potentialMoves.filter(move => {
        // Store original state details needed for restoration
        const originalPieceAtTarget = getPieceAt(move.row, move.col);
        const originalCastling = JSON.parse(JSON.stringify(castlingRights)); // Deep copy
        const originalEnPassant = enPassantTarget;

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

            if (originalRookPiece) {
                 setPieceAt(rookDest.row, rookDest.col, originalRookPiece);
                 setPieceAt(rookOrigin.row, rookOrigin.col, null);
            } else {
                 // This should ideally not happen if castling rights were correct
                 console.warn("Castling simulation: Rook not found at expected position.", rookOrigin);
                 simError = true; // Mark simulation as potentially invalid
            }
        }

        // --- Check validity ---
        // If simulation had an error (like missing rook for castling), consider the move illegal
        const kingInCheck = simError ? true : isKingInCheck(currentPlayer);

        // --- !!! CRUCIAL: Undo the simulation THOROUGHLY !!! ---
        setPieceAt(row, col, piece); // Put original piece back
        setPieceAt(move.row, move.col, originalPieceAtTarget); // Put target piece back (or null)

        if (move.isEnPassant && capturedEnPassantPawnPos) {
            setPieceAt(capturedEnPassantPawnPos.row, capturedEnPassantPawnPos.col, capturedEnPassantPawn);
        }

        if (move.isCastling && rookOrigin && rookDest) {
            // Carefully restore rook: piece that was moved goes back to origin, destination becomes null
            const movedRook = getPieceAt(rookDest.row, rookDest.col); // Get what ended up at destination
            setPieceAt(rookOrigin.row, rookOrigin.col, movedRook); // Put it back
            setPieceAt(rookDest.row, rookDest.col, null); // Clear destination
        }

        // Restore castling rights and en passant target (critical)
        castlingRights = originalCastling;
        enPassantTarget = originalEnPassant;

        // Return true if the king was NOT in check after the simulated move
        return !kingInCheck;
    });
    // --- END: FIX ---

    return legalMovesResult; // Always return the resulting array
}

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
            if (twoSteps >= 0 && twoSteps < BOARD_SIZE && !getPieceAt(twoSteps, c) && !getPieceAt(oneStep,c) ) {
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
                // Need to ensure the captured pawn exists for validation, but move is valid regardless
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
    directions.forEach(([dr, dc]) => {
        for (let i = 1; ; i++) {
            const toRow = r + i * dr;
            const toCol = c + i * dc;
            if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) break; // Off board
            const targetPiece = getPieceAt(toRow, toCol);
            if (targetPiece) {
                if (!isPlayerPiece(targetPiece, getPlayerForPiece(piece))) {
                    addMoveIfValid(moves, r, c, toRow, toCol, piece); // Capture opponent
                }
                break; // Blocked
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
    return [...getBishopMoves(r, c, piece), ...getRookMoves(r, c, piece)];
}
function getKingMoves(r, c, piece) {
    const moves = [];
    const kingMoves = [
        [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]
    ];
    kingMoves.forEach(([dr, dc]) => {
        addMoveIfValid(moves, r, c, r + dr, c + dc, piece);
    });

    // Castling
    const player = getPlayerForPiece(piece);
    if (!isSquareAttacked(r, c, getOpponent(player))) { // Can't castle out of check
        // Kingside (O-O)
        if (castlingRights[player].K) {
            if (!getPieceAt(r, c + 1) && !getPieceAt(r, c + 2) && // Squares empty
                getPieceAt(r, c + 3) && getPieceAt(r, c+3).toUpperCase() === 'R' && // Rook exists
                !isSquareAttacked(r, c + 1, getOpponent(player)) && // Squares not attacked
                !isSquareAttacked(r, c + 2, getOpponent(player)))
            {
                addMoveIfValid(moves, r, c, r, c + 2, piece, { isCastling: true });
            }
        }
        // Queenside (O-O-O)
        if (castlingRights[player].Q) {
             if (!getPieceAt(r, c - 1) && !getPieceAt(r, c - 2) && !getPieceAt(r, c - 3) && // Squares empty
                 getPieceAt(r, c - 4) && getPieceAt(r, c-4).toUpperCase() === 'R' && // Rook exists
                 !isSquareAttacked(r, c - 1, getOpponent(player)) && // Squares not attacked
                 !isSquareAttacked(r, c - 2, getOpponent(player)))
                 // Note: King doesn't move over c-3, so it doesn't need attack check
             {
                 addMoveIfValid(moves, r, c, r, c - 2, piece, { isCastling: true });
             }
        }
    }
    return moves;
}

// --- Check, Checkmate, Stalemate Logic ---
function getOpponent(player) {
    return player === 'w' ? 'b' : 'w';
}
function isSquareAttacked(r, c, attackerPlayer) {
    // Check pawns
    const pawnDir = attackerPlayer === 'w' ? 1 : -1;
    const pawnSources = [{ r: r + pawnDir, c: c - 1 }, { r: r + pawnDir, c: c + 1 }];
    for (const pos of pawnSources) {
        const p = getPieceAt(pos.r, pos.c);
        if (p && getPlayerForPiece(p) === attackerPlayer && p.toUpperCase() === 'P') return true;
    }
    // Check knights
    const knightMoves = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of knightMoves) {
        const p = getPieceAt(r + dr, c + dc);
        if (p && getPlayerForPiece(p) === attackerPlayer && p.toUpperCase() === 'N') return true;
    }
    // Check sliding pieces + king
    const slideDirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [dr, dc] of slideDirs) {
        for (let i = 1; ; i++) {
            const checkR = r + i * dr;
            const checkC = c + i * dc;
            if (checkR < 0 || checkR >= BOARD_SIZE || checkC < 0 || checkC >= BOARD_SIZE) break;
            const p = getPieceAt(checkR, checkC);
            if (p) {
                if (getPlayerForPiece(p) === attackerPlayer) {
                    const pType = p.toUpperCase();
                    const isDiag = dr !== 0 && dc !== 0;
                    const isOrth = dr === 0 || dc === 0;
                    if (pType === 'Q' ||
                        (pType === 'B' && isDiag) ||
                        (pType === 'R' && isOrth) ||
                        (pType === 'K' && i === 1)) // King only attacks adjacent
                    {
                        return true;
                    }
                }
                break; // Path blocked
            }
            // Kings block rays for other sliding pieces
            if (getPieceAt(checkR, checkC) && getPieceAt(checkR, checkC).toUpperCase() === 'K') {
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
    console.error(`King not found for player ${player}!`);
    return null;
}
function isKingInCheck(player) {
    const kingPos = findKing(player);
    if (!kingPos) return false; // Should not happen
    return isSquareAttacked(kingPos.row, kingPos.col, getOpponent(player));
}
function hasLegalMoves(player) {
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (getPieceAt(r, c) && getPlayerForPiece(getPieceAt(r, c)) === player) {
                if (generateLegalMoves(r, c).length > 0) {
                    return true;
                }
            }
        }
    }
    return false;
}
// isCheckmate/isStalemate determined in finishMoveProcessing based on hasLegalMoves and isKingInCheck

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
                pieces[player].push(type);
                if (type === 'B') {
                     if ((r + c) % 2 === 0) darkBishops[player]++;
                     else lightBishops[player]++;
                }
            }
        }
    }

    // King vs King
    if (pieceCount === 2) return true;

    // Function to check if a side has ONLY king, king+knight, or king+bishop(s) all on same color
    const checkSide = (player) => {
        const pList = pieces[player];
        if (pList.length === 1) return true; // King only
        if (pList.length === 2 && pList.includes('N')) return true; // King + Knight
        if (pList.length >= 2 && pList.every(p => p === 'K' || p === 'B')) {
             // King + Bishop(s)
             if (lightBishops[player] > 0 && darkBishops[player] > 0) return false; // Bishops on different colors CAN mate
             return true; // Only king or king + bishops on same color
        }
        return false; // Has rooks, queens, pawns, or multiple knights etc.
    };

    // If BOTH sides have insufficient material based on the check
    if (checkSide('w') && checkSide('b')) {
        return true;
    }

    return false;
}
function getBoardPositionString(currentBoard) {
    let boardString = currentBoard.map(row => {
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
    boardString += ` ${currentPlayer} ${getCastlingString()} ${getEnPassantString()}`;
    return boardString;
}
function getCastlingString() {
    let str = "";
    if (castlingRights.w.K) str += 'K';
    if (castlingRights.w.Q) str += 'Q';
    if (castlingRights.b.K) str += 'k';
    if (castlingRights.b.Q) str += 'q';
    return str === "" ? "-" : str;
}
function getEnPassantString() {
    if (!enPassantTarget) return "-";
    const file = String.fromCharCode('a'.charCodeAt(0) + enPassantTarget.col);
    const rank = BOARD_SIZE - enPassantTarget.row;
    return `${file}${rank}`;
}
function checkThreefoldRepetition() {
    if (currentMoveIndex < 8) return false; // Not possible before a few moves

    const currentPosition = getBoardPositionString(board);
    let repetitionCount = 0;

    // Check only relevant past states (same player to move)
    for (let i = currentMoveIndex % 2; i <= currentMoveIndex; i += 2) {
        const pastState = gameHistory[i];
        // Regenerate string ensuring board state is used, not just pointer
        const pastPosition = getBoardPositionString(pastState.board);
        if (pastPosition === currentPosition) {
            repetitionCount++;
        }
    }
    return repetitionCount >= 3;
}

// --- Update UI ---
function updateStatusDisplay() {
    let currentStatus = "";
    if (isGameOver) {
        currentStatus = gameStatusMessage; // Use the final stored game over message
    } else {
        const check = isKingInCheck(currentPlayer);
        if (check) {
            currentStatus = `${currentPlayer === 'w' ? 'White' : 'Black'} is in Check! `;
        }
        currentStatus += `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`;
    }

    // Update message only if it changed or game just ended
    if (currentStatus !== statusMessageElement.textContent || isGameOver) {
        statusMessageElement.textContent = currentStatus;
        // Update the stored message only if game is over, otherwise it's dynamic
        if(isGameOver) gameStatusMessage = currentStatus;
    }

    turnIndicator.textContent = isGameOver ? "Game Over" : `Turn: ${currentPlayer === 'w' ? 'White' : 'Black'}`;
    
    // Use our updateGameModeDisplay function instead of direct access
    updateGameModeDisplay();

    boardElement.style.pointerEvents = (isGameOver || isAIThinking) ? 'none' : 'auto';
    hintButton.disabled = isGameOver || isAIThinking || (currentPlayer !== 'w' || !isAIMode());
    updateHistoryButtons();
}

// --- Move History & Notation ---
function getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion = false) {
     const pieceType = piece.toUpperCase();
     const destFile = String.fromCharCode('a'.charCodeAt(0) + toCol);
     const destRank = BOARD_SIZE - toRow;
     const fromFile = String.fromCharCode('a'.charCodeAt(0) + fromCol);
     const fromRank = BOARD_SIZE - fromRow;

     if (pieceType === 'K' && Math.abs(toCol - fromCol) === 2) {
         return (toCol > fromCol) ? "O-O" : "O-O-O";
     }

     let notation = "";

     if (pieceType === 'P') {
         if (capturedPiece) {
             notation = fromFile + 'x';
         }
         notation += destFile + destRank;
         // Promotion =Q added later
     } else {
         notation = pieceType;
         const ambiguity = checkAmbiguity(fromRow, fromCol, toRow, toCol, piece);
         if (ambiguity.file && ambiguity.rank) notation += fromFile + fromRank; // Need both if file/rank alone not enough
         else if (ambiguity.file) notation += fromFile;
         else if (ambiguity.rank) notation += fromRank;

         if (capturedPiece) {
             notation += 'x';
         }
         notation += destFile + destRank;
     }
     // Check/Mate +/# added later
     return notation;
}
function checkAmbiguity(fR, fC, tR, tC, piece) {
    let fileAmbig = false, rankAmbig = false, needsFile = false, needsRank = false;
    const pieceType = piece.toUpperCase();
    const player = getPlayerForPiece(piece);

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            if (r === fR && c === fC) continue;
            const otherPiece = getPieceAt(r, c);
            if (otherPiece === piece) { // Same type and color
                const originalPlayer = currentPlayer; // Backup player context
                currentPlayer = player; // Set context for move generation
                const otherLegalMoves = generateLegalMoves(r, c);
                currentPlayer = originalPlayer; // Restore context
                if (otherLegalMoves.some(move => move.row === tR && move.col === tC)) {
                    if (c !== fC) fileAmbig = true; // Another piece on different file can move there
                    if (r !== fR) rankAmbig = true; // Another piece on different rank can move there
                    if (c === fC) needsRank = true; // Another piece on SAME file needs rank
                    if (r === fR) needsFile = true; // Another piece on SAME rank needs file
                }
            }
        }
    }
     // Determine requirement
     if(needsFile && needsRank) return { file: true, rank: true }; // e.g. Rfa1
     if(needsFile) return { file: true, rank: false }; // e.g. Rfa1 if ranks are same
     if(needsRank) return { file: false, rank: true }; // e.g. R1a3 if files are same
     // If ambiguous but file/rank alone is enough
     if (fileAmbig) return { file: true, rank: false }; // Default to file if ranks different
     if (rankAmbig) return { file: false, rank: true }; // Use rank only if files were same

    return { file: false, rank: false }; // No ambiguity
}

// --- Game History Management ---
function pushHistoryState(moveInfo = {}) {
    // Important: Create a deep copy of the board to ensure promotion pieces are properly stored
    const boardCopy = board.map(row => [...row]);
    
    const state = {
        board: boardCopy,
        currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)),
        enPassantTarget: enPassantTarget ? {...enPassantTarget} : null, // Deep copy
        halfmoveClock,
        fullmoveNumber,
        statusMessage: gameStatusMessage,
        moveNotation: moveInfo.notation || null,
        moveNumber: moveInfo.moveNumber || null
    };
    
    // If we're not at the end of history, we need to truncate future moves when making a new move
    // But NOT when simply restoring states during undo/redo navigation
    if (moveInfo.truncate !== false && currentMoveIndex < gameHistory.length - 1) {
        gameHistory = gameHistory.slice(0, currentMoveIndex + 1);
    }
    
    gameHistory.push(state);
    currentMoveIndex++;
    updateHistoryButtons();
}

// --- Update both undo and redo buttons state ---
function updateHistoryButtons() {
    undoButton.disabled = isGameOver || isAIThinking || currentMoveIndex < 1;
    redoButton.disabled = isGameOver || isAIThinking || currentMoveIndex >= gameHistory.length - 1;
}

// --- Replace updateUndoButton with the more comprehensive function ---
function updateUndoButton() {
    updateHistoryButtons();
}

// --- Add the missing recordMove function ---
function recordMove(prevStateInfo, finalNotation) {
    const moveNumber = prevStateInfo.fullmoveNumber; // Number of the move being made
    pushHistoryState({ notation: finalNotation, moveNumber: moveNumber });
    updateMoveHistoryDisplay(); // Update AFTER push ensures correct index is used
}

// --- Undo/Redo Functions ---
function handleUndo() {
    if (isAIThinking || currentMoveIndex < 1) {
        console.log("Cannot undo.");
        return;
    }
    isGameOver = false; // Allow game to continue

    // Determine how many states to go back (usually 2 for Player+AI, 1 if only Player moved)
    const playerWhoseTurnItIsNow = gameHistory[currentMoveIndex].currentPlayer;
    const undoSteps = (playerWhoseTurnItIsNow === 'w' && currentMoveIndex >= 2) ? 2 : 1;

    const targetIndex = Math.max(0, currentMoveIndex - undoSteps);
    
    restoreGameState(targetIndex);
    
    // Update UI
    clearSelectionAndHighlights();
    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    updateHistoryButtons();
    
    console.log(`Undo complete. New Index: ${currentMoveIndex}`);
}

function handleRedo() {
    if (isAIThinking || currentMoveIndex >= gameHistory.length - 1) {
        console.log("Cannot redo.");
        return;
    }
    isGameOver = false; // Allow game to continue

    // For redo, we typically go forward one move at a time
    // But if AI mode is active and current player is white, we may need to go forward 2 steps
    const stepsForward = 1;
    const targetIndex = Math.min(gameHistory.length - 1, currentMoveIndex + stepsForward);
    
    restoreGameState(targetIndex);
    
    // Update UI
    clearSelectionAndHighlights();
    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    updateHistoryButtons();
    
    console.log(`Redo complete. New Index: ${currentMoveIndex}`);
}

// --- Helper function to restore a game state at the given index ---
function restoreGameState(targetIndex) {
    if (targetIndex < 0 || targetIndex >= gameHistory.length) {
        console.error("Invalid game state index:", targetIndex);
        return;
    }
    
    const stateToRestore = gameHistory[targetIndex];
    currentMoveIndex = targetIndex; // Update index
    
    // Restore board state with proper deep copy
    board = stateToRestore.board.map(row => [...row]);
    
    // Restore other game state variables
    currentPlayer = stateToRestore.currentPlayer;
    castlingRights = JSON.parse(JSON.stringify(stateToRestore.castlingRights));
    enPassantTarget = stateToRestore.enPassantTarget ? {...stateToRestore.enPassantTarget} : null;
    halfmoveClock = stateToRestore.halfmoveClock;
    fullmoveNumber = stateToRestore.fullmoveNumber;
    gameStatusMessage = stateToRestore.statusMessage || `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`;
}

// --- Move History Display with Highlighting for Current Position ---
function updateMoveHistoryDisplay() {
    moveHistoryElement.innerHTML = '';
    let currentPairDiv = null;
    
    for (let i = 1; i <= gameHistory.length - 1; i++) { // Index 0 is initial state
        const state = gameHistory[i];
        const prevState = gameHistory[i-1];
        if (!state.moveNotation) continue;
        
        const moveNum = state.moveNumber;
        const playerWhoMoved = prevState.currentPlayer;
        const isCurrentPosition = (i === currentMoveIndex);

        if (playerWhoMoved === 'w') {
             currentPairDiv = document.createElement('div');
             currentPairDiv.className = 'move-pair';
             moveHistoryElement.appendChild(currentPairDiv);
             
             const moveNumSpan = document.createElement('span');
             moveNumSpan.className = 'move-number';
             moveNumSpan.textContent = `${moveNum}.`;
             currentPairDiv.appendChild(moveNumSpan);
        }
        
        // Ensure pair div exists (e.g., if history starts with black move somehow)
        if (!currentPairDiv && i > 0) {
            // This case shouldn't happen in standard chess start, but defensively create div
            currentPairDiv = document.createElement('div');
            currentPairDiv.className = 'move-pair';
            moveHistoryElement.appendChild(currentPairDiv);
            
            const moveNumSpan = document.createElement('span');
            moveNumSpan.className = 'move-number';
            moveNumSpan.textContent = `${moveNum}.`; // Still use current move number
            currentPairDiv.appendChild(moveNumSpan);
            
            const emptySpan = document.createElement('span');
            emptySpan.className = 'move-text w-move';
            emptySpan.textContent = "..."; // Indicate missing white move
            currentPairDiv.appendChild(emptySpan);
        }

        if (currentPairDiv) {
            const moveSpan = document.createElement('span');
            moveSpan.className = `move-text ${playerWhoMoved}-move`;
            if (isCurrentPosition) {
                moveSpan.classList.add('current-move');
            }
            moveSpan.textContent = state.moveNotation;
            
            // Add click handler for move navigation
            moveSpan.addEventListener('click', () => {
                if (!isAIThinking) {
                    restoreGameState(i);
                    clearSelectionAndHighlights();
                    renderBoard();
                    updateStatusDisplay();
                    updateMoveHistoryDisplay();
                    updateHistoryButtons();
                }
            });
            
            currentPairDiv.appendChild(moveSpan);
        }

        if (playerWhoMoved === 'b') {
            currentPairDiv = null; // Black move completes the pair
        }
    }
    
    moveHistoryElement.scrollTop = moveHistoryElement.scrollHeight;
}

// --- AI Logic ---
function triggerAIMove() {
    if (isGameOver || currentPlayer !== 'b') return; // Only AI ('b') moves

    isAIThinking = true;
    updateStatusDisplay(); // Show AI thinking, disable controls

    // Use setTimeout to allow UI to update before potentially heavy calculation
    setTimeout(() => {
        try {
             const aiMove = calculateBestMove(aiDifficulty);
             isAIThinking = false; // Done thinking *before* making move

             if (aiMove) {
                 // Check promotion *before* calling makeMove
                 const piece = getPieceAt(aiMove.from.row, aiMove.from.col);
                 // Ensure piece exists before checking type/promotion
                 if (!piece) {
                     console.error("AI Error: Attempting to move non-existent piece.", aiMove);
                     updateStatusDisplay(); // Re-enable UI if AI failed
                     return;
                 }
                 const isPromotion = (piece.toUpperCase() === 'P' && aiMove.to.row === 7); // AI is black, promotes on row 7

                 if(isPromotion) {
                     handleAIPromotion(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col, 'Q');
                 } else {
                     makeMove(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col);
                 }
             } else {
                 console.error("AI could not find a valid move! (Game state might be checkmate/stalemate)");
                 // Game should be over, update display to reflect final state
                  updateStatusDisplay();
             }
        } catch (error) {
             console.error("Error during AI move calculation or execution:", error);
             isAIThinking = false; // Ensure thinking flag is reset on error
             updateStatusDisplay(); // Re-enable UI
        }
        // UI updates happen within makeMove/handleAIPromotion -> finishMoveProcessing
    }, 50); // Small delay
}

function handleAIPromotion(fromRow, fromCol, toRow, toCol, chosenPieceType) {
     const piece = getPieceAt(fromRow, fromCol); // Should be 'p'
     const capturedPiece = getPieceAt(toRow, toCol); // May be null
     const promotionPiece = chosenPieceType.toLowerCase(); // AI is black

     if (!piece || piece !== 'p') {
          console.error("AI Promotion Error: Invalid piece at source.", {fromRow, fromCol, piece});
          return;
     }

     const prevStateInfo = {
         currentPlayer: 'b', // AI is making the move
         castlingRights: JSON.parse(JSON.stringify(castlingRights)),
         enPassantTarget,
         halfmoveClock,
         fullmoveNumber
     };

     let baseMoveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, true);
     const finalMoveNotation = baseMoveNotation + "=" + chosenPieceType.toUpperCase(); // Standard notation uses uppercase

     // Update board state logically
     setPieceAt(toRow, toCol, promotionPiece);
     setPieceAt(fromRow, fromCol, null);

     // --- Animation ---
     // Since AI moves don't involve selecting, getPieceElement might fail if called before render
     // We'll skip fine-grained animation control for AI promotion for simplicity,
     // rely on finishMoveProcessing calling renderBoard.

     // Update visual state directly might be needed if skipping animation
     // const pieceElement = getPieceElement(fromRow, fromCol); // Might not exist yet
     // ... update element ...

     // Finish processing move normally
     finishMoveProcessing(prevStateInfo, piece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation);
     // Rely on renderBoard inside finishMoveProcessing
}

function calculateBestMove(difficulty) {
    const availableMoves = getAllLegalMoves(currentPlayer);
    if (availableMoves.length === 0) return null;

    // Shuffle moves for randomness in lower difficulties and breaking ties
    availableMoves.sort(() => Math.random() - 0.5);

    let bestMove = availableMoves[0]; // Default to first random move

    try { // Add try-catch around AI logic
        switch (difficulty) {
            case 0: // Very Easy: Random move, prefers non-captures that don't attack
                let nonCaptureSafeMoves = availableMoves.filter(move => {
                    if (getPieceAt(move.to.row, move.to.col) || move.isEnPassant) return false; // Not a capture
                    // Simulate briefly to check if it attacks anything
                    const piece = getPieceAt(move.from.row, move.from.col);
                    setPieceAt(move.to.row, move.to.col, piece);
                    setPieceAt(move.from.row, move.from.col, null);
                    const attacks = isAnyPieceAttackedBy(getOpponent(currentPlayer), piece, move.to.row, move.to.col);
                    setPieceAt(move.from.row, move.from.col, piece); // Undo simulation
                    setPieceAt(move.to.row, move.to.col, null);
                    return !attacks;
                });
                if (nonCaptureSafeMoves.length > 0) bestMove = nonCaptureSafeMoves[0];
                else { // If no such moves, take any non-capture, else any capture
                    let nonCaptures = availableMoves.filter(move => !getPieceAt(move.to.row, move.to.col) && !move.isEnPassant);
                    if (nonCaptures.length > 0) bestMove = nonCaptures[0];
                    // else bestMove remains the first random move (could be capture)
                }
                break;

            case 1: // Easy: Random, but prioritize captures
                const captureMoves = availableMoves.filter(move => getPieceAt(move.to.row, move.to.col) || move.isEnPassant);
                if (captureMoves.length > 0) bestMove = captureMoves[0];
                // else bestMove remains the first random move
                break;

            case 2: // Medium: Simple evaluation (1-ply)
                let bestScore = (currentPlayer === 'w') ? -Infinity : Infinity; // Init based on player
                availableMoves.forEach(move => {
                    // Simulate move
                    const piece = getPieceAt(move.from.row, move.from.col);
                    const captured = getPieceAt(move.to.row, move.to.col);
                    const prevEnPassant = enPassantTarget; // Store prev EP
                     let capturedEnPassant = null, capturedEnPassantPos = null;
                    setPieceAt(move.to.row, move.to.col, piece);
                    setPieceAt(move.from.row, move.from.col, null);
                    if (move.isEnPassant) {
                        capturedEnPassantPos = { row: currentPlayer === 'w' ? move.to.row + 1 : move.to.row - 1, col: move.to.col };
                        capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                        setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
                    }
                    // Update EP target temporarily if pawn moved two steps
                    if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                         enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
                    } else {
                         enPassantTarget = null;
                    }

                    let score = evaluateBoard();
                    // Undo simulation carefully
                    enPassantTarget = prevEnPassant; // Restore EP *before* putting pieces back
                    setPieceAt(move.from.row, move.from.col, piece);
                    setPieceAt(move.to.row, move.to.col, captured);
                    if (move.isEnPassant && capturedEnPassantPos) {
                        setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
                    }

                    if (currentPlayer === 'w') { // Maximize for white
                        if (score > bestScore) { bestScore = score; bestMove = move; }
                    } else { // Minimize for black
                        if (score < bestScore) { bestScore = score; bestMove = move; }
                    }
                });
                // console.log("Medium AI best score:", bestScore);
                break;

            case 3: // Hard: Minimax
                const depth = 3; // Depth 3 is reasonable for simple eval
                const result = minimax(depth, -Infinity, Infinity, currentPlayer === 'w');
                if (result.move) bestMove = result.move; // Use minimax move if found
                else console.warn("Minimax did not return a move, using random.");
                // console.log(`Minimax result (depth ${depth}): Score ${result.score}, Move:`, bestMove);
                break;
        }
    } catch (error) {
         console.error("Error during calculateBestMove:", error);
         // Fallback to random if calculation fails
         bestMove = availableMoves[0];
    }
    return bestMove;
}
function isAnyPieceAttackedBy(attackedPlayer, attackerPiece, attackerRow, attackerCol) {
    const pieceType = attackerPiece.toUpperCase();
    let potentialAttacks = []; // Use simple move generation, don't need full legal check
    switch (pieceType) {
        case 'P':
            const dir = getPlayerForPiece(attackerPiece) === 'w' ? -1 : 1;
            potentialAttacks = [{r: attackerRow + dir, c: attackerCol - 1}, {r: attackerRow + dir, c: attackerCol + 1}];
            break;
        case 'N':
             const knightDeltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
             potentialAttacks = knightDeltas.map(([dr, dc]) => ({r: attackerRow + dr, c: attackerCol + dc}));
            break;
        // Simplified: just check immediate squares for others
         case 'B': case 'R': case 'Q': case 'K':
             const slideDirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
              potentialAttacks = slideDirs.map(([dr, dc]) => ({r: attackerRow + dr, c: attackerCol + dc}));
             break; // Quick check is enough for "very easy" AI avoidance
    }
    for (const attack of potentialAttacks) {
         if (attack.r >= 0 && attack.r < BOARD_SIZE && attack.c >= 0 && attack.c < BOARD_SIZE) {
            const target = getPieceAt(attack.r, attack.c);
            if (target && getPlayerForPiece(target) === attackedPlayer) return true;
        }
    }
    return false;
}
function getAllLegalMoves(player) {
    const allMoves = [];
    const originalPlayer = currentPlayer; // Backup context
    currentPlayer = player; // Set context for generateLegalMoves

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece && getPlayerForPiece(piece) === player) {
                const moves = generateLegalMoves(r, c); // Will use the temporary currentPlayer context
                moves.forEach(move => {
                    allMoves.push({
                        from: { row: r, col: c },
                        to: { row: move.row, col: move.col },
                        piece: piece,
                        isPromotion: move.isPromotion,
                        isCastling: move.isCastling,
                        isEnPassant: move.isEnPassant
                    });
                });
            }
        }
    }
    currentPlayer = originalPlayer; // Restore context
    return allMoves;
}
const pieceValues = { P: 1, N: 3, B: 3.1, R: 5, Q: 9, K: 0 }; // King value often 0 or high for endgame only
const pawnPositionScore = [
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], // Rank 8
    [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0], // Rank 7 (High value for near promotion)
    [1.0, 1.0, 2.0, 3.0, 3.0, 2.0, 1.0, 1.0], // Rank 6
    [0.5, 0.5, 1.0, 2.5, 2.5, 1.0, 0.5, 0.5], // Rank 5
    [0.0, 0.0, 0.0, 2.0, 2.0, 0.0, 0.0, 0.0], // Rank 4
    [0.5,-0.5,-1.0, 0.0, 0.0,-1.0,-0.5, 0.5], // Rank 3
    [0.5, 1.0, 1.0,-2.0,-2.0, 1.0, 1.0, 0.5], // Rank 2 (Discourage blocking pieces)
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]  // Rank 1
];
const knightPositionScore = [
    [-5.0,-4.0,-3.0,-3.0,-3.0,-3.0,-4.0,-5.0],
    [-4.0,-2.0, 0.0, 0.0, 0.0, 0.0,-2.0,-4.0],
    [-3.0, 0.0, 1.0, 1.5, 1.5, 1.0, 0.0,-3.0],
    [-3.0, 0.5, 1.5, 2.0, 2.0, 1.5, 0.5,-3.0],
    [-3.0, 0.0, 1.5, 2.0, 2.0, 1.5, 0.0,-3.0],
    [-3.0, 0.5, 1.0, 1.5, 1.5, 1.0, 0.5,-3.0],
    [-4.0,-2.0, 0.0, 0.5, 0.5, 0.0,-2.0,-4.0],
    [-5.0,-4.0,-3.0,-3.0,-3.0,-3.0,-4.0,-5.0]
];
// TODO: Add tables for B, R, Q, K
function evaluateBoard() {
    let score = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece) {
                const player = getPlayerForPiece(piece);
                const type = piece.toUpperCase();
                const value = pieceValues[type] || 0;
                let positionScore = 0;
                 if (type === 'P') positionScore = (player === 'w') ? pawnPositionScore[r][c] : pawnPositionScore[7 - r][c];
                 else if (type === 'N') positionScore = (player === 'w') ? knightPositionScore[r][c] : knightPositionScore[7 - r][c];
                 // Add other piece tables here...

                score += (player === 'w' ? value + (positionScore*0.1) : -(value + (positionScore*0.1))); // Positional score weighted less
            }
        }
    }
    // Add bonus for check? Could encourage aggressive play but might be naive.
    // if (isKingInCheck(getOpponent(currentPlayer))) score += (currentPlayer === 'w' ? 0.5 : -0.5);
    return score;
}
function minimax(depth, alpha, beta, maximizingPlayer) {
     // Check game over conditions at this node
     const possibleMoves = getAllLegalMoves(currentPlayer); // Check moves for player whose turn it is *at this node*
     const isInCheck = isKingInCheck(currentPlayer);
     let nodeValue;

     if (possibleMoves.length === 0) { // Game over condition
         if (isInCheck) {
             nodeValue = maximizingPlayer ? -Infinity - depth : Infinity + depth; // Checkmate (add depth bonus)
         } else {
             nodeValue = 0; // Stalemate
         }
          return { score: nodeValue, move: null };
     }

     if (depth === 0) { // Depth limit reached
         nodeValue = evaluateBoard();
         return { score: nodeValue, move: null };
     }

     let bestMoveForNode = null;

     if (maximizingPlayer) { // White's turn (or AI if white)
         let maxEval = -Infinity;
         // Sort availableMoves? (Captures first, checks second?) - For pruning efficiency
         for (const move of possibleMoves) {
             // --- Simulate Move ---
             const piece = getPieceAt(move.from.row, move.from.col);
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights));
             const prevEnPassant = enPassantTarget;
             const prevHalfmove = halfmoveClock;
              let capturedEnPassant = null, capturedEnPassantPos = null; // Keep track for undo

             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
              // Handle simulation of special move side effects
              if (move.isEnPassant) {
                  capturedEnPassantPos = { row: move.from.row, col: move.to.col }; // Pawn captured is on same row as moving pawn started
                  capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                  setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
              }
              // Update castling rights temporarily (needs full logic from finishMoveProcessing)
              // Update EP target temporarily
              if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                   enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
              } else {
                   enPassantTarget = null;
              }
              // Update halfmove clock temporarily
              if (piece.toUpperCase() === 'P' || captured || move.isEnPassant) halfmoveClock = 0;
              else halfmoveClock++;

              currentPlayer = getOpponent(currentPlayer); // Switch player for recursive call

             // --- Recurse ---
             const result = minimax(depth - 1, alpha, beta, false); // Now it's minimizer's turn
             const evaluation = result.score;

             // --- Undo Simulation ---
             currentPlayer = getOpponent(currentPlayer); // Switch back
             halfmoveClock = prevHalfmove; // Restore clock
             enPassantTarget = prevEnPassant; // Restore EP
             castlingRights = prevCastling; // Restore castling rights
              if (move.isEnPassant && capturedEnPassantPos) { // Restore captured EP pawn
                  setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
              }
              setPieceAt(move.from.row, move.from.col, piece); // Put moving piece back
              setPieceAt(move.to.row, move.to.col, captured); // Put captured piece back (or null)


             // --- Update Max and Alpha ---
             if (evaluation > maxEval) {
                  maxEval = evaluation;
                  bestMoveForNode = move; // Store the move that led to this best score
             }
             alpha = Math.max(alpha, evaluation);
             if (beta <= alpha) {
                 break; // Beta cut-off
             }
         }
         return { score: maxEval, move: bestMoveForNode };

     } else { // Minimizing player (Black's turn or AI if black)
         let minEval = Infinity;
         for (const move of possibleMoves) {
              // --- Simulate Move (Similar to maximizing player) ---
             const piece = getPieceAt(move.from.row, move.from.col);
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights));
             const prevEnPassant = enPassantTarget;
             const prevHalfmove = halfmoveClock;
              let capturedEnPassant = null, capturedEnPassantPos = null;

             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
              if (move.isEnPassant) {
                   capturedEnPassantPos = { row: move.from.row, col: move.to.col };
                   capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                   setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
              }
              if (piece.toUpperCase() === 'P' && Math.abs(move.to.row - move.from.row) === 2) {
                   enPassantTarget = { row: (move.from.row + move.to.row) / 2, col: move.from.col };
              } else {
                   enPassantTarget = null;
              }
              if (piece.toUpperCase() === 'P' || captured || move.isEnPassant) halfmoveClock = 0;
              else halfmoveClock++;

             currentPlayer = getOpponent(currentPlayer); // Switch player

             // --- Recurse ---
              const result = minimax(depth - 1, alpha, beta, true); // Now it's maximizer's turn
              const evaluation = result.score;

             // --- Undo Simulation ---
              currentPlayer = getOpponent(currentPlayer); // Switch back
              halfmoveClock = prevHalfmove;
              enPassantTarget = prevEnPassant;
              castlingRights = prevCastling;
              if (move.isEnPassant && capturedEnPassantPos) {
                  setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
              }
              setPieceAt(move.from.row, move.from.col, piece);
              setPieceAt(move.to.row, move.to.col, captured);

             // --- Update Min and Beta ---
             if (evaluation < minEval) {
                  minEval = evaluation;
                  bestMoveForNode = move; // Store move
             }
             beta = Math.min(beta, evaluation);
             if (beta <= alpha) {
                 break; // Alpha cut-off
             }
         }
          return { score: minEval, move: bestMoveForNode };
     }
}

// --- Hint System ---
function handleHint() {
    if (isGameOver || isAIThinking || currentPlayer !== 'w' || !isAIMode()) return; // Only hints for player ('w') in AI mode

    console.log("Generating hint...");
    statusMessageElement.textContent = "Thinking of a hint..."; // Give feedback

    // Use setTimeout to allow UI update before calculation
    setTimeout(() => {
        let hintMove = null;
        try {
            // Use AI calculation for the current player's perspective
            hintMove = calculateBestMove(aiDifficulty); // Use current difficulty for hint strength
        } catch (error) {
             console.error("Error generating hint:", error);
             statusMessageElement.textContent = "Error generating hint.";
             return;
        }

        if (hintMove && hintMove.from && hintMove.to) { // Check move is valid
            console.log("Hint:", hintMove);
            clearSelectionAndHighlights(); // Clear previous highlights
            const fromSq = getSquareElement(hintMove.from.row, hintMove.from.col);
            const toSq = getSquareElement(hintMove.to.row, hintMove.to.col);
            if (fromSq && toSq) {
                 fromSq.classList.add('selected'); // Highlight starting square like selection
                 toSq.classList.add(getPieceAt(hintMove.to.row, hintMove.to.col) ? 'capture-move' : 'legal-move'); // Highlight destination

                // Remove hint highlight after a delay
                setTimeout(() => {
                    // Only remove if the square hasn't been re-selected or involved in a move
                     if(fromSq.classList.contains('selected') && (!selectedSquare || selectedSquare.row !== hintMove.from.row || selectedSquare.col !== hintMove.from.col)) {
                          fromSq.classList.remove('selected');
                     }
                     toSq.classList.remove('legal-move', 'capture-move');
                }, 2000); // Show hint for 2 seconds
            }
             const fromAlg = String.fromCharCode('a'.charCodeAt(0) + hintMove.from.col) + (BOARD_SIZE - hintMove.from.row);
             const toAlg = String.fromCharCode('a'.charCodeAt(0) + hintMove.to.col) + (BOARD_SIZE - hintMove.to.row);
             statusMessageElement.textContent = `Hint: Try ${PIECES[hintMove.piece]} from ${fromAlg} to ${toAlg}.`;
        } else {
            statusMessageElement.textContent = "No good move found for hint.";
            console.log("No hint generated or invalid hint move.");
        }
    }, 30); // Short delay
}


// --- Event Listeners ---
newGameButton.addEventListener('click', initGame);
undoButton.addEventListener('click', handleUndo);
redoButton.addEventListener('click', handleRedo);
hintButton.addEventListener('click', handleHint);
muteButton.addEventListener('click', toggleMute);
toggleAnimationButton.addEventListener('click', toggleCaptureAnimation);
difficultySelect.addEventListener('change', (e) => {
    const newDifficulty = parseInt(e.target.value, 10);
    if (aiDifficulty !== newDifficulty) {
        const wasAIMode = isAIMode(); // Store previous mode
        aiDifficulty = newDifficulty;
        const isNowAIMode = isAIMode(); // New mode after change
        
        updateGameModeDisplay(); // Update UI to show new mode
        console.log("Difficulty/Mode changed to:", aiDifficulty, 
                   isNowAIMode ? "AI mode" : "Human vs Human");
        
        // If we switched TO AI mode and it's currently black's turn, trigger AI move
        if (!wasAIMode && isNowAIMode && currentPlayer === 'b' && !isGameOver) {
            triggerAIMove(); // Start AI move if it's black's turn
        }
        
        // Update UI to reflect any changes in available actions
        updateStatusDisplay();
    }
});

// --- Initial Game Load ---
document.addEventListener('DOMContentLoaded', () => {
     console.log("DOM Loaded. Initializing Chess Game...");
     
     // Check if URL has mode parameter
     const urlParams = new URLSearchParams(window.location.search);
     const modeParam = urlParams.get('mode');
     if (modeParam) {
         const modeValue = parseInt(modeParam, 10);
         if (!isNaN(modeValue) && modeValue >= -1 && modeValue <= 3) {
             aiDifficulty = modeValue;
             difficultySelect.value = modeValue.toString();
         }
     }
     
     initGame();
     // init3DAnimation(); // Consider initializing based on captureAnimationEnabled state
 });

// --- END OF FILE script_new.js ---