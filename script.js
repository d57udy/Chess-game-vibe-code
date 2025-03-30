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
let gameHistory = []; // Stores past game states { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber }
let currentMoveIndex = -1; // Index in gameHistory, allows undo/redo conceptually (though only undo is implemented)
let isGameOver = false;
let gameStatusMessage = "Game started. White's turn.";
let castlingRights = { w: { K: true, Q: true }, b: { K: true, Q: true } }; // Kingside/Queenside
let enPassantTarget = null; // Square behind a pawn that just moved two steps, e.g., { row: 2, col: 4 }
let halfmoveClock = 0; // For 50-move rule
let fullmoveNumber = 1; // Increments after black moves
let aiDifficulty = 2; // 0: Very Easy, 1: Easy, 2: Medium, 3: Hard
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

// --- Audio Elements ---
const sounds = {
    move: new Audio('move.mp3'),       // Replace with your sound file path
    capture: new Audio('capture.mp3'), // Replace with your sound file path
    check: new Audio('check.mp3'),     // Replace with your sound file path
    gameOver: new Audio('game-over.mp3') // Replace with your sound file path
};
Object.values(sounds).forEach(sound => sound.preload = 'auto'); // Preload sounds

// --- Three.js Placeholder ---
// IMPORTANT: Full 3D animation requires significant setup. These are placeholders.
let scene, camera, renderer;
function init3DAnimation() {
    console.log("Initializing 3D setup (Placeholder)");
    // scene = new THREE.Scene();
    // camera = new THREE.PerspectiveCamera(75, captureCanvas.clientWidth / captureCanvas.clientHeight, 0.1, 1000);
    // renderer = new THREE.WebGLRenderer({ canvas: captureCanvas, alpha: true }); // alpha:true for transparent background
    // renderer.setSize(captureCanvas.clientWidth, captureCanvas.clientHeight);
    // camera.position.z = 5;
    // // Add lighting, etc.
}
function animateCapture3D(attackerPiece, defenderPiece, callback) {
    if (!captureAnimationEnabled) {
        console.log("Capture animation disabled.");
        if (callback) callback();
        return;
    }

    console.log(`Placeholder: 3D Animation - ${attackerPiece} captures ${defenderPiece}`);
    captureCanvas.style.display = 'block'; // Show canvas

    // --- Actual Three.js Logic Would Go Here ---
    // 1. Create 3D representations (e.g., simple geometric shapes) for attacker/defender.
    // 2. Position them in the scene.
    // 3. Define an animation sequence (e.g., attacker moves towards defender, collision effect).
    // 4. Use an animation loop (requestAnimationFrame) and a library like GSAP or Three.js's animation system.
    // 5. On animation completion:
    //    - Hide the canvas: captureCanvas.style.display = 'none';
    //    - Call the callback function.

    // --- Simple Timeout Placeholder ---
    setTimeout(() => {
        console.log("3D Animation finished (Placeholder)");
        captureCanvas.style.display = 'none'; // Hide canvas
        if (callback) callback(); // Continue game logic
    }, 1500); // Simulate 1.5 second animation
}
// init3DAnimation(); // Call this once, perhaps after the board is created


// --- Game Initialization ---
function initGame() {
    console.log("Initializing game...");
    isGameOver = false;
    isAIThinking = false;
    selectedSquare = null;
    legalMoves = [];
    gameHistory = []; // Clear history
    currentMoveIndex = -1; // Reset history index
    parseFen(INITIAL_BOARD_FEN); // Setup board from FEN
    createBoardDOM();
    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay(); // Clear history display
    updateUndoButton();
    pushHistoryState(); // Save the initial state
    console.log("Game Initialized. Current Player:", currentPlayer);
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

    console.log("FEN Parsed:", { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber });
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
            // Add algebraic notation labels (optional but helpful)
            square.dataset.rank = BOARD_SIZE - r; // Rank (1-8)
            square.dataset.file = String.fromCharCode('a'.charCodeAt(0) + c); // File (a-h)

            square.addEventListener('click', () => handleSquareClick(r, c));
            boardElement.appendChild(square);
        }
    }
}

// --- Board Rendering ---
function renderBoard() {
    // Clear existing pieces visually first
    document.querySelectorAll('.piece').forEach(p => p.remove());

    // Clear check highlighting
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
                    pieceElement.dataset.piece = piece; // Store piece type for styling/logic
                    pieceElement.dataset.row = r;
                    pieceElement.dataset.col = c;

                    // Position piece absolutely within its square for animation
                    pieceElement.style.position = 'absolute';
                    pieceElement.style.left = `${c * 100 / BOARD_SIZE}%`;
                    pieceElement.style.top = `${r * 100 / BOARD_SIZE}%`;
                    pieceElement.style.width = `${100 / BOARD_SIZE}%`;
                    pieceElement.style.height = `${100 / BOARD_SIZE}%`;

                    // Make pieces larger and center them
                    pieceElement.style.fontSize = '9vmin'; // Direct size, approximately 70-80% of square size
                    pieceElement.style.display = 'flex';
                    pieceElement.style.justifyContent = 'center';
                    pieceElement.style.alignItems = 'center';
                    pieceElement.style.lineHeight = '1'; // Ensure proper vertical alignment
                    
// Add click handler to the piece that forwards to the square
                    pieceElement.addEventListener('click', (e) => {
                        e.stopPropagation(); // Prevent double-triggering
                        handleSquareClick(r, c);
                    });

                    // Append to the main board element, not the square itself
                    boardElement.appendChild(pieceElement);

                    // Highlight king if in check
                    if ((piece === 'K' || piece === 'k') && isKingInCheck(getPlayerForPiece(piece))) {
                       squareElement.classList.add('in-check');
                    }
                }
            }
        }
    }
    // Highlight selected square and legal moves after rendering pieces
    highlightSelectedSquare();
    highlightLegalMoves();
    console.log("Board rendered.");
}


// --- Square/Piece Utilities ---
function getSquareElement(row, col) {
    return boardElement.querySelector(`.square[data-row="${row}"][data-col="${row}"]`);
}

function getPieceElement(row, col) {
    // Find the piece element positioned over the logical row/col
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
    console.log(`Clicked square: (${row}, ${col})`);
    if (isGameOver || isAIThinking) return;

    const clickedPiece = getPieceAt(row, col);

    if (selectedSquare) {
        // Try to move
        const move = legalMoves.find(m => m.row === row && m.col === col);
        if (move) {
            console.log("Attempting move:", selectedSquare, "->", { row, col });
            makeMove(selectedSquare.row, selectedSquare.col, row, col, move.isPromotion);
            clearSelectionAndHighlights();
                    } else {
            // Clicked on another square, not a legal move
            clearSelectionAndHighlights();
            // If clicked on own piece, select it
            if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
                selectPiece(row, col);
            }
        }
    } else {
        // No piece selected, try to select
        if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
            selectPiece(row, col);
        }
    }
}

function selectPiece(row, col) {
    selectedSquare = { row, col };
    console.log("Selected piece:", getPieceAt(row, col), "at", selectedSquare);
    legalMoves = generateLegalMoves(row, col);
    console.log("Legal moves:", legalMoves);
    highlightSelectedSquare();
    highlightLegalMoves();
}

function clearSelectionAndHighlights() {
    selectedSquare = null;
    legalMoves = [];
    // Remove visual highlights
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

    legalMoves.forEach(move => {
        const squareElement = getSquareElement(move.row, move.col);
        if (squareElement) {
            const isCapture = getPieceAt(move.row, move.col) !== null || move.isEnPassant;
            squareElement.classList.add(isCapture ? 'capture-move' : 'legal-move');
        }
    });
}

// --- Move Execution ---
function makeMove(fromRow, fromCol, toRow, toCol, isPromotion = false) {
    const piece = board[fromRow][fromCol];
    const capturedPiece = board[toRow][toCol]; // Could be null
    let specialMove = null; // 'castling', 'enpassant', 'promotion'

    console.log(`Making move: ${piece} from (${fromRow},${fromCol}) to (${toRow},${toCol})`);

    // --- Pre-move state for history ---
    const prevState = {
        board: board.map(row => [...row]), // Deep copy
        currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)),
        enPassantTarget,
        halfmoveClock,
        fullmoveNumber
    };

    // --- Handle Special Moves ---
    let moveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion);
    // Add descriptive notation
    let descriptiveNotation = getDescriptiveNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion);

    // Pawn Promotion
    if (isPromotion) {
        specialMove = 'promotion';
        // Pass both notations to the promotion dialog
        showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, prevState, moveNotation, descriptiveNotation);
        return; // Stop execution here, continue in promotion callback
    }

    // En Passant Capture
    const isEnPassantCapture = (piece === 'P' || piece === 'p') &&
                               toCol !== fromCol && !capturedPiece &&
                               enPassantTarget && toRow === enPassantTarget.row && toCol === enPassantTarget.col;

    if (isEnPassantCapture) {
        specialMove = 'enpassant';
        const capturedPawnRow = currentPlayer === 'w' ? toRow + 1 : toRow - 1;
        const capturedPawnActual = board[capturedPawnRow][toCol]; // For logging/animation
        console.log(`En Passant Capture! Removing pawn at (${capturedPawnRow}, ${toCol})`);
        animateAndRemovePiece(capturedPawnRow, toCol, capturedPawnActual, true); // Animate captured pawn removal
        setPieceAt(capturedPawnRow, toCol, null); // Remove captured pawn logically
        moveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPawnActual, false, true); // Correct notation
        descriptiveNotation = getDescriptiveNotation(fromRow, fromCol, toRow, toCol, piece, null, false, true);
    }

    // Castling
    const isCastling = (piece === 'K' || piece === 'k') && Math.abs(toCol - fromCol) === 2;
    if (isCastling) {
        specialMove = 'castling';
        const rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
        const rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        const rookRow = fromRow;
        const rook = board[rookRow][rookFromCol];

        console.log(`Castling! Moving rook from (${rookRow}, ${rookFromCol}) to (${rookRow}, ${rookToCol})`);
        // Move rook logically first for validation consistency
        setPieceAt(rookRow, rookToCol, rook);
        setPieceAt(rookRow, rookFromCol, null);
        // Animate rook movement (after king animation finishes)
        const rookElement = getPieceElement(rookRow, rookFromCol);
        const targetSquareElement = getSquareElement(rookRow, rookToCol);
        if (rookElement && targetSquareElement) {
             // We'll chain this after the king's animation
        }
        moveNotation = (toCol > fromCol) ? "O-O" : "O-O-O";
        descriptiveNotation = getDescriptiveNotation(fromRow, fromCol, toRow, toCol, piece, null, false, false, true);
    }

    // --- Update Board State ---
    setPieceAt(toRow, toCol, piece);
    setPieceAt(fromRow, fromCol, null);

    // --- Animate Movement ---
    const pieceElement = getPieceElement(fromRow, fromCol); // Get element *before* logical move
    const targetSquareElement = getSquareElement(toRow, toCol); // Target square

    // If capturing (and not en passant, handled separately)
    if (capturedPiece || isEnPassantCapture) {
        animateAndRemovePiece(toRow, toCol, capturedPiece, false, () => {
            // After capture animation/removal, animate the attacker
            animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, () => {
                // After attacker animation, if castling, move rook
                if (isCastling) {
                     const rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
                     const rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
                     const rookRow = fromRow;
                     const rookElement = getPieceElement(rookRow, rookFromCol); // It was logically moved, find it visually
                     const rookTargetSquareElement = getSquareElement(rookRow, rookToCol);
                     animatePieceMovement(rookElement, rookTargetSquareElement, rookRow, rookToCol, () => finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMove, moveNotation, descriptiveNotation));
                } else {
                    finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMove, moveNotation, descriptiveNotation);
                }
            });
        }, fromRow, fromCol); // Pass attacker position
    } else {
        // Regular move or en passant/castling king move
        animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, () => {
             // After king/attacker animation, if castling, move rook
             if (isCastling) {
                 const rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
                 const rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
                 const rookRow = fromRow;
                 const rookElement = getPieceElement(rookRow, rookFromCol); // Find it visually
                 const rookTargetSquareElement = getSquareElement(rookRow, rookToCol);
                 animatePieceMovement(rookElement, rookTargetSquareElement, rookRow, rookToCol, () => finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMove, moveNotation, descriptiveNotation));
             } else {
                 finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMove, moveNotation, descriptiveNotation);
             }
        });
    }
}


// --- Promotion Handling ---
function showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, prevState, baseMoveNotation, baseDescriptiveNotation) {
    promotionModal.style.display = 'flex'; // Show modal

    // Remove previous listeners to prevent multiple triggers
    promotionButtons.forEach(button => {
        const listener = button.onclick;
        if (listener) button.removeEventListener('click', listener);
    });

    // Add new listeners
    promotionButtons.forEach(button => {
        button.onclick = () => { // Use onclick for simplicity here, or manage listeners more carefully
            const promotionPieceType = button.dataset.piece;
            const promotionPiece = currentPlayer === 'w' ? promotionPieceType.toUpperCase() : promotionPieceType.toLowerCase();
            console.log(`Promotion chosen: ${promotionPiece}`);
            promotionModal.style.display = 'none'; // Hide modal

            // Complete the move with the chosen piece
            setPieceAt(toRow, toCol, promotionPiece); // Place promoted piece
            setPieceAt(fromRow, fromCol, null); // Remove original pawn

            // Update notation
            const finalMoveNotation = baseMoveNotation + promotionPieceType.toUpperCase(); // e.g., e8=Q
            const finalDescriptiveNotation = baseDescriptiveNotation + ` ${promotionPieceType.toUpperCase()}`; // e.g., Pawn from e7 to e8 and promotes to Q

            // Animate capture if necessary, then move the pawn visually (it becomes the new piece after animation)
            const pawnElement = getPieceElement(fromRow, fromCol);
            const targetSquareElement = getSquareElement(toRow, toCol);

            const finishPromotionMove = () => {
                // Update the visual piece *after* animation
                if(pawnElement) {
                    pawnElement.textContent = PIECES[promotionPiece];
                    pawnElement.dataset.piece = promotionPiece;
                }
                 // Now finish the rest of the move processing
                 finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation, finalDescriptiveNotation);
            };

            if (capturedPiece) {
                animateAndRemovePiece(toRow, toCol, capturedPiece, false, () => {
                     animatePieceMovement(pawnElement, targetSquareElement, toRow, toCol, finishPromotionMove);
                });
            } else {
                 animatePieceMovement(pawnElement, targetSquareElement, toRow, toCol, finishPromotionMove);
            }
        };
    });
}


// --- Post-Animation Move Processing ---
function finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMove, moveNotation, descriptiveNotation) {
    console.log("Finishing move processing...");

    // --- Update Castling Rights ---
    if (piece === 'K') { castlingRights.w.K = castlingRights.w.Q = false; }
    if (piece === 'k') { castlingRights.b.K = castlingRights.b.Q = false; }
    if (piece === 'R' && fromRow === 7 && fromCol === 0) { castlingRights.w.Q = false; }
    if (piece === 'R' && fromRow === 7 && fromCol === 7) { castlingRights.w.K = false; }
    if (piece === 'r' && fromRow === 0 && fromCol === 0) { castlingRights.b.Q = false; }
    if (piece === 'r' && fromRow === 0 && fromCol === 7) { castlingRights.b.K = false; }
    // If a rook is captured on its starting square
    if (toRow === 7 && toCol === 0) { castlingRights.w.Q = false; }
    if (toRow === 7 && toCol === 7) { castlingRights.w.K = false; }
    if (toRow === 0 && toCol === 0) { castlingRights.b.Q = false; }
    if (toRow === 0 && toCol === 7) { castlingRights.b.K = false; }


    // --- Update En Passant Target ---
    if (piece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2) {
        enPassantTarget = { row: (fromRow + toRow) / 2, col: fromCol };
        console.log("New en passant target:", enPassantTarget);
    } else {
        enPassantTarget = null;
    }

    // --- Update Clocks ---
    if (piece.toUpperCase() === 'P' || capturedPiece || specialMove === 'enpassant') {
        halfmoveClock = 0; // Reset on pawn move or capture
    } else {
        halfmoveClock++;
    }
    if (currentPlayer === 'b') {
        fullmoveNumber++; // Increment after black moves
    }

    // --- Switch Player ---
const prevPlayer = currentPlayer;
    currentPlayer = (currentPlayer === 'w' ? 'b' : 'w');
    console.log("Player switched to:", currentPlayer);

    // --- Play Sounds ---
    let soundToPlay = null;
    if (capturedPiece || specialMove === 'enpassant') {
        soundToPlay = sounds.capture;
    } else {
        soundToPlay = sounds.move;
    }

    // Check for check *after* switching player
    const opponentKingInCheck = isKingInCheck(currentPlayer);
    if (opponentKingInCheck) {
        soundToPlay = sounds.check; // Override move/capture sound
        moveNotation += '+'; // Add check indicator to notation
        descriptiveNotation += " (check)"; // Add check indicator to descriptive notation
    }

    playSound(soundToPlay);


    // --- Update Game State and UI ---
    updateStatusDisplay(); // Check for checkmate/stalemate here
    renderBoard(); // Re-render to reflect state changes (like check highlight)
    recordMove(prevState, moveNotation, descriptiveNotation); // Add to history display AFTER status update

    console.log("Move processing complete. Current state:", { currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber });

    // NEW CODE: Trigger AI move if it's the AI's turn (after player's move)
    // Small delay to allow UI to update
    if (prevPlayer === 'w' && currentPlayer === 'b' && !isGameOver) {
        console.log("Triggering AI move after player move...");
        setTimeout(triggerAIMove, 200);
    }
}

// --- Animation Functions ---
function animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, onComplete) {
    if (!pieceElement || !targetSquareElement) {
        console.warn("Animation target elements missing.");
        if (onComplete) onComplete();
        return;
    }

    // Instead of using getBoundingClientRect for absolute positioning,
    // directly animate using the chess board's grid percentage system
    
    // Calculate the target position as percentages (same as how pieces are positioned initially)
    const targetLeft = `${toCol * 100 / BOARD_SIZE}%`;
    const targetTop = `${toRow * 100 / BOARD_SIZE}%`;

    // Use GSAP for smooth animation
    gsap.to(pieceElement, {
        left: targetLeft,
        top: targetTop,
        duration: 0.4, // Animation duration in seconds
        ease: "power2.out", // Easing function
        onComplete: () => {
            // Update piece element's data attributes after animation
            pieceElement.dataset.row = toRow;
            pieceElement.dataset.col = toCol;
            
            if (onComplete) {
                onComplete(); // Callback after animation finishes
            }
        }
    });
}


function animateAndRemovePiece(row, col, pieceType, isEnPassant = false, onComplete, attackerRow, attackerCol) {
    const pieceElement = getPieceElement(row, col);
    if (pieceElement) {
         if (captureAnimationEnabled && !isEnPassant) { // Use 3D for standard captures if enabled
             // Use attackerRow/attackerCol parameters if selectedSquare is null (for AI moves)
             let attackerPiece;
             if (selectedSquare) {
                 attackerPiece = getPieceAt(selectedSquare.row, selectedSquare.col);
             } else if (attackerRow !== undefined && attackerCol !== undefined) {
attackerPiece = getPieceAt(attackerRow, attackerCol);
             } else {
                 // Fallback if no attacker info is available
                 attackerPiece = currentPlayer === 'w' ? 'P' : 'p';
             }

             // Call the 3D animation placeholder
             animateCapture3D(attackerPiece, pieceType, () => {
                 pieceElement.remove(); // Remove element after 3D animation
                 if (onComplete) onComplete();
             });
         } else {
             // Fallback: Simple fade out for en passant or if 3D disabled
             pieceElement.style.transition = 'opacity 0.3s ease-out';
             pieceElement.style.opacity = '0';
             setTimeout(() => {
                 pieceElement.remove();
                 if (onComplete) onComplete();
             }, 300); // Wait for fade out
         }
    } else {
        console.warn(`Captured piece element not found at (${row}, ${col})`);
        if (onComplete) onComplete(); // Ensure callback is always called
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
         // Potentially initialize Three.js here if it wasn't done initially
         // init3DAnimation();
         console.log("Note: 3D animation setup is still a placeholder.");
     }
}

// --- Move Generation (The Core Logic) ---
function generateLegalMoves(row, col) {
    const piece = getPieceAt(row, col);
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
    }

    // Filter out moves that leave the king in check
    const legalMoves = potentialMoves.filter(move => {
        // Simulate the move
        const originalPieceAtTarget = getPieceAt(move.row, move.col);
        let capturedEnPassantPawn = null;
        let capturedEnPassantPawnPos = null;

        setPieceAt(move.row, move.col, piece);
        setPieceAt(row, col, null);

        // Handle en passant simulation
        if (move.isEnPassant) {
             const capturedPawnRow = currentPlayer === 'w' ? move.row + 1 : move.row - 1;
             capturedEnPassantPawn = getPieceAt(capturedPawnRow, move.col);
             capturedEnPassantPawnPos = {row: capturedPawnRow, col: move.col};
             setPieceAt(capturedEnPassantPawnPos.row, capturedEnPassantPawnPos.col, null);
        }

        // Handle castling simulation (move the rook too)
        let rookOrigin = null, rookDest = null, originalRook = null;
        if (move.isCastling) {
            const rookFromCol = move.col > col ? BOARD_SIZE - 1 : 0;
            const rookToCol = move.col > col ? move.col - 1 : move.col + 1;
            rookOrigin = { row: row, col: rookFromCol };
            rookDest = { row: row, col: rookToCol };
            originalRook = getPieceAt(rookOrigin.row, rookOrigin.col);
            setPieceAt(rookDest.row, rookDest.col, originalRook);
            setPieceAt(rookOrigin.row, rookOrigin.col, null);
        }


        const kingInCheck = isKingInCheck(currentPlayer);

        // Undo the simulation
        setPieceAt(row, col, piece);
        setPieceAt(move.row, move.col, originalPieceAtTarget);
        if (move.isEnPassant && capturedEnPassantPawnPos) {
             setPieceAt(capturedEnPassantPawnPos.row, capturedEnPassantPawnPos.col, capturedEnPassantPawn);
        }
        if (move.isCastling && rookOrigin && rookDest && originalRook) {
            setPieceAt(rookOrigin.row, rookOrigin.col, originalRook);
            setPieceAt(rookDest.row, rookDest.col, null);
        }


        return !kingInCheck;
    });

    return legalMoves;
}

function addMoveIfValid(moves, fromRow, fromCol, toRow, toCol, piece, options = {}) {
    const { canCapture = true, mustCapture = false, isEnPassant = false, isCastling = false, isPromotion = false } = options;

    if (toRow < 0 || toRow >= BOARD_SIZE || toCol < 0 || toCol >= BOARD_SIZE) return; // Off board

    const targetPiece = getPieceAt(toRow, toCol);
    const player = getPlayerForPiece(piece);

    if (targetPiece) {
        // Cannot capture own piece
        if (isPlayerPiece(targetPiece, player)) return;
        // If move rule requires empty square (pawn forward), invalid capture
        if (!canCapture) return;
        // If must capture but target is empty (e.g., pawn diagonal without capture)
        // This check is implicitly handled by mustCapture being false for non-capture moves
    } else {
        // If must capture but target is empty (pawn diagonal)
        if (mustCapture && !isEnPassant) return; // Allow en passant target to be empty
    }

    moves.push({ row: toRow, col: toCol, isEnPassant, isCastling, isPromotion });
}

// --- Piece Move Functions ---
function getPawnMoves(r, c, piece) {
    const moves = [];
    const player = getPlayerForPiece(piece);
    const direction = player === 'w' ? -1 : 1; // White moves up (-1), Black moves down (+1)
    const startRow = player === 'w' ? 6 : 1;
    const promotionRow = player === 'w' ? 0 : 7;

    // 1. Move forward one square
    const oneStep = r + direction;
    if (oneStep >= 0 && oneStep < BOARD_SIZE && !getPieceAt(oneStep, c)) {
        const isPromotion = (oneStep === promotionRow);
        addMoveIfValid(moves, r, c, oneStep, c, piece, { canCapture: false, isPromotion: isPromotion });

        // 2. Move forward two squares (only from start row)
        if (r === startRow) {
            const twoSteps = r + 2 * direction;
            if (twoSteps >= 0 && twoSteps < BOARD_SIZE && !getPieceAt(twoSteps, c)) {
                 addMoveIfValid(moves, r, c, twoSteps, c, piece, { canCapture: false });
            }
        }
    }

    // 3. Captures (diagonal)
    const captureCols = [c - 1, c + 1];
    for (const captureCol of captureCols) {
        if (captureCol >= 0 && captureCol < BOARD_SIZE) {
            const targetPiece = getPieceAt(oneStep, captureCol);
            const isPromotion = (oneStep === promotionRow);
            // Regular capture
            if (targetPiece && !isPlayerPiece(targetPiece, player)) {
                 addMoveIfValid(moves, r, c, oneStep, captureCol, piece, { mustCapture: true, isPromotion: isPromotion });
            }
            // En Passant capture
            if (enPassantTarget && oneStep === enPassantTarget.row && captureCol === enPassantTarget.col) {
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
                break; // Blocked by own or opponent piece
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
    return [
        ...getBishopMoves(r, c, piece),
        ...getRookMoves(r, c, piece)
    ];
}

function getKingMoves(r, c, piece) {
    const moves = [];
    const kingMoves = [
        [-1, -1], [-1, 0], [-1, 1],
        [0, -1],           [0, 1],
        [1, -1], [1, 0], [1, 1]
    ];

    kingMoves.forEach(([dr, dc]) => {
        addMoveIfValid(moves, r, c, r + dr, c + dc, piece);
    });

    // Castling Moves
    const player = getPlayerForPiece(piece);
    if (!isSquareAttacked(r, c, getOpponent(player))) { // Can't castle out of check
        // Kingside
        if (castlingRights[player].K) {
            if (!getPieceAt(r, c + 1) && !getPieceAt(r, c + 2) &&
                !isSquareAttacked(r, c + 1, getOpponent(player)) &&
                !isSquareAttacked(r, c + 2, getOpponent(player)))
            {
                addMoveIfValid(moves, r, c, r, c + 2, piece, { isCastling: true });
            }
        }
        // Queenside
        if (castlingRights[player].Q) {
             if (!getPieceAt(r, c - 1) && !getPieceAt(r, c - 2) && !getPieceAt(r, c - 3) &&
                 !isSquareAttacked(r, c - 1, getOpponent(player)) &&
                 !isSquareAttacked(r, c - 2, getOpponent(player)))
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

// Checks if a specific square is attacked by the opponent
function isSquareAttacked(r, c, attackerPlayer) {
    // Check attacks from pawns
    const pawnDirection = attackerPlayer === 'w' ? 1 : -1; // Direction pawns move TO attack the square
    const pawnAttackSources = [
        { row: r + pawnDirection, col: c - 1 },
        { row: r + pawnDirection, col: c + 1 }
    ];
    for (const pos of pawnAttackSources) {
        if (pos.row >= 0 && pos.row < BOARD_SIZE && pos.col >= 0 && pos.col < BOARD_SIZE) {
             const piece = getPieceAt(pos.row, pos.col);
             if (piece && getPlayerForPiece(piece) === attackerPlayer && piece.toUpperCase() === 'P') {
                 // console.log(`Square (${r},${c}) attacked by pawn at (${pos.row},${pos.col})`);
                 return true;
             }
        }
    }

    // Check attacks from knights
    const knightMoves = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]
    ];
    for (const [dr, dc] of knightMoves) {
        const piece = getPieceAt(r + dr, c + dc);
        if (piece && getPlayerForPiece(piece) === attackerPlayer && piece.toUpperCase() === 'N') {
             // console.log(`Square (${r},${c}) attacked by knight at (${r+dr},${c+dc})`);
             return true;
        }
    }

    // Check attacks from sliding pieces (Rook, Bishop, Queen) and King
    const slidingDirections = [
        [-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]
    ];
    for (const [dr, dc] of slidingDirections) {
        for (let i = 1; ; i++) {
            const checkRow = r + i * dr;
            const checkCol = c + i * dc;

            if (checkRow < 0 || checkRow >= BOARD_SIZE || checkCol < 0 || checkCol >= BOARD_SIZE) break; // Off board

            const piece = getPieceAt(checkRow, checkCol);
            if (piece) {
                if (getPlayerForPiece(piece) === attackerPlayer) {
                    const pieceType = piece.toUpperCase();
                    const isDiagonal = Math.abs(dr) === 1 && Math.abs(dc) === 1;
                    const isOrthogonal = Math.abs(dr) + Math.abs(dc) === 1;

                    if (pieceType === 'Q' ||
                        (pieceType === 'B' && isDiagonal) ||
                        (pieceType === 'R' && isOrthogonal) ||
                        (pieceType === 'K' && i === 1) // King only attacks adjacent squares
                       )
                    {
                       // console.log(`Square (${r},${c}) attacked by ${piece} at (${checkRow},${checkCol})`);
                       return true;
                    }
                }
                break; // Path blocked
            }
            // If checking for king attacks, stop after 1 step
             if (i === 1 && getPieceAt(checkRow, checkCol) && getPieceAt(checkRow, checkCol).toUpperCase() === 'K' && getPlayerForPiece(getPieceAt(checkRow, checkCol)) === attackerPlayer) {
                 // This case is handled above, but double check for clarity
             } else if (getPieceAt(checkRow, checkCol) && getPieceAt(checkRow, checkCol).toUpperCase() === 'K') {
                 break; // Another king blocks further sliding checks along this line
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
    return null; // Should not happen in a normal game
}

function isKingInCheck(player) {
    const kingPos = findKing(player);
    if (!kingPos) return false; // King not found?
    return isSquareAttacked(kingPos.row, kingPos.col, getOpponent(player));
}

function hasLegalMoves(player) {
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece && getPlayerForPiece(piece) === player) {
                const moves = generateLegalMoves(r, c); // This function already filters for check
                if (moves.length > 0) {
                    return true;
                }
            }
        }
    }
    return false;
}


function isCheckmate(player) {
    return isKingInCheck(player) && !hasLegalMoves(player);
}

function isStalemate(player) {
    return !isKingInCheck(player) && !hasLegalMoves(player);
}

// --- Draw Condition Checks ---

// Basic check for insufficient mating material
function hasInsufficientMaterial() {
    const pieces = { w: [], b: [] };
    let pieceCount = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece) {
                pieceCount++;
                const player = getPlayerForPiece(piece);
                pieces[player].push(piece.toUpperCase());
            }
        }
    }

    // King vs King
    if (pieceCount === 2) return true;

    const checkInsufficient = (playerPieces) => {
        // King only
        if (playerPieces.length === 1) return true;
        // King and Knight
        if (playerPieces.length === 2 && playerPieces.includes('N')) return true;
        // King and Bishop
        if (playerPieces.length === 2 && playerPieces.includes('B')) return true;
        // King and multiple Bishops on the same color square (more complex to check accurately without square info)
        // For simplicity, we won't check the bishop color here. Two bishops *can* mate.

        return false;
    };

    // If BOTH sides have insufficient material (e.g., K vs K+N, K vs K+B)
    if (checkInsufficient(pieces.w) && checkInsufficient(pieces.b)) {
        return true;
    }

    // Add specific cases: K+N vs K, K+B vs K are draws.
    if ((pieces.w.length === 1 && checkInsufficient(pieces.b)) ||
        (pieces.b.length === 1 && checkInsufficient(pieces.w))) {
        return true;
    }
     if ((pieces.w.length === 2 && pieces.w.includes('N') && pieces.b.length === 1) ||
         (pieces.b.length === 2 && pieces.b.includes('N') && pieces.w.length === 1)) {
         return true;
     }
      if ((pieces.w.length === 2 && pieces.w.includes('B') && pieces.b.length === 1) ||
          (pieces.b.length === 2 && pieces.b.includes('B') && pieces.w.length === 1)) {
          return true;
      }


    // Note: K+B vs K+B (same color bishops) is a draw - requires board state check, omitted for simplicity.

    return false;
}


// Generates a simple string representation of the board position (excluding move counts etc.)
function getBoardPositionString(currentBoard) {
    let boardString = '';
    for (let r = 0; r < BOARD_SIZE; r++) {
        let emptyCount = 0;
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = currentBoard[r][c];
            if (piece) {
                if (emptyCount > 0) {
                    boardString += emptyCount;
                    emptyCount = 0;
                }
                boardString += piece;
            } else {
                emptyCount++;
            }
        }
        if (emptyCount > 0) {
            boardString += emptyCount;
        }
        if (r < BOARD_SIZE - 1) {
            boardString += '/';
        }
    }
    // Add relevant state for repetition check
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


// Checks for threefold repetition
function checkThreefoldRepetition() {
    const currentPosition = getBoardPositionString(board);
    let repetitionCount = 0;

    // Iterate through *past* states in history
    for (let i = 0; i <= currentMoveIndex; i++) {
        const pastState = gameHistory[i];
        const pastPosition = getBoardPositionString(pastState.board); // Regenerate string from past board
        if (pastPosition === currentPosition) {
            repetitionCount++;
        }
    }
    // console.log(`Repetition count for current position: ${repetitionCount}`);
    return repetitionCount >= 3; // The current position counts as one
}


// --- Update UI ---
function updateStatusDisplay() {
    let message = "";
    if (isGameOver) {
        message = gameStatusMessage; // Use the final game over message
    } else {
        const inCheck = isKingInCheck(currentPlayer);
        if (inCheck) {
            message = `${currentPlayer === 'w' ? 'White' : 'Black'} is in Check! `;
        }

        // Check for Game Over conditions BEFORE general turn message
        if (isCheckmate(currentPlayer)) {
            message = `Checkmate! ${getOpponent(currentPlayer) === 'w' ? 'White' : 'Black'} wins.`;
            isGameOver = true;
            playSound(sounds.gameOver);
        } else if (isStalemate(currentPlayer)) {
            message = "Stalemate! Game is a draw.";
            isGameOver = true;
             playSound(sounds.gameOver);
        } else if (halfmoveClock >= 100) { // 50 moves by each player = 100 half-moves
             message = "Draw by 50-move rule.";
             isGameOver = true;
              playSound(sounds.gameOver);
        } else if (checkThreefoldRepetition()) {
             message = "Draw by threefold repetition.";
             isGameOver = true;
             playSound(sounds.gameOver);
        } else if (hasInsufficientMaterial()) {
             message = "Draw by insufficient material.";
             isGameOver = true;
              playSound(sounds.gameOver);
        } else {
             // If no game over, add whose turn it is
             message += `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`;
        }
    }

    gameStatusMessage = message; // Store the potentially final message
    statusMessageElement.textContent = message;
    turnIndicator.textContent = isGameOver ? "Game Over" : `Turn: ${currentPlayer === 'w' ? 'White' : 'Black'}`;
    difficultyLabel.textContent = `AI Difficulty: ${difficultySelect.options[aiDifficulty].text}`;

     // Disable interaction if game over or AI is thinking
     boardElement.style.pointerEvents = (isGameOver || isAIThinking) ? 'none' : 'auto';
     hintButton.disabled = isGameOver || isAIThinking || currentPlayer !== 'w'; // Only hints for player
     undoButton.disabled = isGameOver || isAIThinking || currentMoveIndex < 1; // Need at least player + AI move to undo
}

// --- Move History & Notation ---
function getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion = false, isEnPassant = false, check = false, checkmate = false) {
    let notation = "";
    const pieceType = piece.toUpperCase();

    if (isPromotion) { // Handle promotion first
        const file = String.fromCharCode('a'.charCodeAt(0) + fromCol);
        const destFile = String.fromCharCode('a'.charCodeAt(0) + toCol);
        const destRank = BOARD_SIZE - toRow;
        if (capturedPiece) {
             notation = `${file}x${destFile}${destRank}`; // e.g. exd8
        } else {
             notation = `${destFile}${destRank}`; // e.g. e8
        }
        // Promotion piece added later by showPromotionDialog/finishMoveProcessing
        return notation; // Return partial notation here
    }

    if (pieceType === 'P') {
        if (capturedPiece || isEnPassant) {
            notation = String.fromCharCode('a'.charCodeAt(0) + fromCol) + 'x'; // e.g., 'ex'
        }
    } else {
        notation = pieceType; // N, B, R, Q, K

        // Disambiguation needed? Check if other pieces of the same type can move to the same square
        // Basic disambiguation (file only for now, rank or full coordinate might be needed)
        const ambiguity = checkAmbiguity(fromRow, fromCol, toRow, toCol, piece);
        if (ambiguity.file) notation += String.fromCharCode('a'.charCodeAt(0) + fromCol);
        if (ambiguity.rank) notation += (BOARD_SIZE - fromRow);

    }

    if (capturedPiece || isEnPassant) {
        notation += 'x';
    }

    notation += String.fromCharCode('a'.charCodeAt(0) + toCol); // Destination file
    notation += (BOARD_SIZE - toRow); // Destination rank

    // Append check/checkmate symbols (will be added later in finishMoveProcessing if needed)
    // if (checkmate) notation += '#';
    // else if (check) notation += '+';

    // Special case for castling is handled directly in makeMove

    return notation;
}

function checkAmbiguity(fR, fC, tR, tC, piece) {
    // Simplified: Only checks if another piece of the same type attacks the target square.
    // A full check would see if *moving* that other piece is legal.
    // This basic version often suffices.
    let fileAmbiguity = false;
    let rankAmbiguity = false;
    const pieceType = piece.toUpperCase();
    const player = getPlayerForPiece(piece);

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            // Skip the original piece
            if (r === fR && c === fC) continue;

            const otherPiece = getPieceAt(r, c);
            if (otherPiece && otherPiece === piece) { // Same type and color
                // Can this other piece potentially move to the target square?
                // Generate its *potential* moves (ignoring check for simplicity here)
                let potentialMoves;
                 switch (pieceType) {
                     case 'N': potentialMoves = getKnightMoves(r, c, piece); break;
                     case 'B': potentialMoves = getBishopMoves(r, c, piece); break;
                     case 'R': potentialMoves = getRookMoves(r, c, piece); break;
                     case 'Q': potentialMoves = getQueenMoves(r, c, piece); break;
                     default: potentialMoves = []; // Pawn/King ambiguity is rare/handled differently
                 }
                 // Check if any potential move lands on the target square
                 if (potentialMoves.some(move => move.row === tR && move.col === tC)) {
                     // Ambiguity exists! Determine type.
                     if (fC !== c) fileAmbiguity = true; // Different file
                     if (fR !== r) rankAmbiguity = true; // Different rank
                     // If file is different, file notation is usually preferred.
                     // If file is same but rank different, use rank.
                     // If both same (error in logic?) or need full coord, handle that.
                     // Basic: prioritize file if ambiguous
                     if (fileAmbiguity) rankAmbiguity = false;

                     return { file: fileAmbiguity, rank: rankAmbiguity }; // Found one, return
                 }
            }
        }
    }
    return { file: false, rank: false }; // No ambiguity found
}

// Add this new function after getAlgebraicNotation()
function getDescriptiveNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isPromotion = false, isEnPassant = false, isCastling = false) {
    // Get algebraic coordinates
    const fromFile = String.fromCharCode('a'.charCodeAt(0) + fromCol);
    const fromRank = BOARD_SIZE - fromRow;
    const toFile = String.fromCharCode('a'.charCodeAt(0) + toCol);
    const toRank = BOARD_SIZE - toRow;
    
    // Special case for castling
    if (isCastling) {
        return (toCol > fromCol) ? 
            `K castle O-O` : 
            `K castle O-O-O`;
    }
    
    // Get piece letter (uppercase for consistent display)
    const pieceType = piece.toUpperCase();
    
    // Basic format: "P e2 > e4"
    let notation = `${pieceType} ${fromFile}${fromRank} > ${toFile}${toRank}`;
    
    // Add capture information: "P e4 > d5 c P"
    if (capturedPiece) {
        notation += ` c ${capturedPiece.toUpperCase()}`;
    } else if (isEnPassant) {
        notation += ` c P (e.p.)`;
    }
    
    // Add promotion information: "P e7 > e8 Q"
    if (isPromotion) {
        notation += ` →`; // The actual promotion piece will be added later
    }
    
    return notation;
}

// --- Game History Management ---
function pushHistoryState() {
    const state = {
        board: board.map(row => [...row]), // Deep copy
        currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)),
        enPassantTarget,
        halfmoveClock,
        fullmoveNumber,
        statusMessage: gameStatusMessage // Store message as well
    };

    // If we undid moves, overwrite the future history
    if (currentMoveIndex < gameHistory.length - 1) {
        gameHistory = gameHistory.slice(0, currentMoveIndex + 1);
    }

    gameHistory.push(state);
    currentMoveIndex++;
    updateUndoButton();
    console.log(`History pushed. Index: ${currentMoveIndex}, Length: ${gameHistory.length}`);
}

// Update recordMove to store both notations
function recordMove(prevState, notation, descriptiveNotation) {
    if (currentMoveIndex > 0) {
        const moveNumber = (prevState.currentPlayer === 'w') ? prevState.fullmoveNumber : '';
        const playerPrefix = (prevState.currentPlayer === 'w') ? `${moveNumber}. ` : '';
        gameHistory[currentMoveIndex - 1].moveNotation = notation;
        gameHistory[currentMoveIndex - 1].descriptiveNotation = descriptiveNotation;
        gameHistory[currentMoveIndex - 1].playerPrefix = playerPrefix;
        gameHistory[currentMoveIndex - 1].moveNumber = moveNumber;
    }
    
    updateMoveHistoryDisplay();
    pushHistoryState();
}

// Update display function to use descriptive notation
function updateMoveHistoryDisplay() {
    moveHistoryElement.innerHTML = '';
    let movePairs = {};

    for (let i = 0; i < currentMoveIndex; i++) {
        const state = gameHistory[i];
        if (state.descriptiveNotation) { // Use descriptive notation
            const moveNum = state.moveNumber;
            if (!movePairs[moveNum]) {
                movePairs[moveNum] = { white: '', black: '' };
            }
            if (state.playerPrefix.includes('.')) { // White's move
                movePairs[moveNum].white = state.descriptiveNotation;
            } else { // Black's move
                movePairs[moveNum].black = state.descriptiveNotation;
            }
        }
    }

    // Display grouped moves
    Object.keys(movePairs).sort((a, b) => parseInt(a) - parseInt(b)).forEach(moveNum => {
        const pair = movePairs[moveNum];
        
        // Create a div for each move number
        const div = document.createElement('div');
        div.className = 'move-pair';
        
        // White's move
        if (pair.white) {
            const whiteMove = document.createElement('div');
            whiteMove.className = 'move white-move';
            whiteMove.innerHTML = `<span class="move-number">${moveNum}.</span> <span class="move-text">${pair.white}</span>`;
            div.appendChild(whiteMove);
        }
        
        // Black's move
        if (pair.black) {
            const blackMove = document.createElement('div');
            blackMove.className = 'move black-move';
            blackMove.innerHTML = `<span class="move-text">${pair.black}</span>`;
            div.appendChild(blackMove);
        }
        
        moveHistoryElement.appendChild(div);
    });

    // Scroll to bottom
    moveHistoryElement.scrollTop = moveHistoryElement.scrollHeight;
}


function handleUndo() {
    if (isAIThinking) return; // Don't undo while AI is thinking
    if (currentMoveIndex >= 2) { // Need at least player + AI move (or 2 player moves if that mode existed)
        console.log(`Undoing move. Current Index: ${currentMoveIndex}`);
        isGameOver = false; // Game might not be over anymore

        // Go back TWO states (one player move, one AI move)
        currentMoveIndex -= 2;
        const stateToRestore = gameHistory[currentMoveIndex];

        console.log("Restoring state:", stateToRestore);

        // Restore state variables
        board = stateToRestore.board.map(row => [...row]);
        currentPlayer = stateToRestore.currentPlayer;
        castlingRights = JSON.parse(JSON.stringify(stateToRestore.castlingRights));
        enPassantTarget = stateToRestore.enPassantTarget;
        halfmoveClock = stateToRestore.halfmoveClock;
        fullmoveNumber = stateToRestore.fullmoveNumber;
        gameStatusMessage = stateToRestore.statusMessage || `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`; // Restore message


        clearSelectionAndHighlights();
        renderBoard();
        updateStatusDisplay();
        updateMoveHistoryDisplay(); // Update display to reflect removed moves
        updateUndoButton();

        console.log(`Undo complete. New Index: ${currentMoveIndex}`);

    } else {
        console.log("Cannot undo further.");
    }
}

function updateUndoButton() {
    undoButton.disabled = isGameOver || isAIThinking || currentMoveIndex < 2; // Allow undo if at least 2 moves recorded (initial + 1 pair)
}


// --- AI Logic ---
function triggerAIMove() {
    if (isGameOver || currentPlayer === 'w') return; // Only AI ('b') moves

    isAIThinking = true;
    updateStatusDisplay(); // Show AI is thinking, disable board
    console.log(`AI (Difficulty: ${aiDifficulty}) is thinking...`);

    // Use setTimeout to allow UI update before potentially blocking AI calculation
    setTimeout(() => {
        const aiMove = calculateBestMove(aiDifficulty);

        isAIThinking = false; // Done thinking

        if (aiMove) {
            console.log("AI Move chosen:", aiMove);
             // Check if the move involves promotion before calling makeMove
            const piece = getPieceAt(aiMove.from.row, aiMove.from.col);
            const isPromotion = (piece.toUpperCase() === 'P' && aiMove.to.row === (currentPlayer === 'w' ? 0 : 7));

            if(isPromotion) {
                // AI Promotion: Default to Queen for simplicity
                handleAIPromotion(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col, 'Q');
            } else {
                makeMove(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col);
            }
        } else {
            console.error("AI could not find a valid move!");
            // This should ideally not happen if checkmate/stalemate detection is correct
            isGameOver = true; // Force game over if AI fails unexpectedly
            updateStatusDisplay();
        }
        // No need to updateStatusDisplay here again, makeMove handles it.
        // No need to call renderBoard here, makeMove handles it.
    }, 50); // Small delay (e.g., 50ms)
}

function handleAIPromotion(fromRow, fromCol, toRow, toCol, chosenPieceType) {
     console.log(`AI promoting pawn at (${fromRow}, ${fromCol}) to ${chosenPieceType}`);
     const piece = board[fromRow][fromCol];
     const capturedPiece = board[toRow][toCol];
     const promotionPiece = currentPlayer === 'w' ? chosenPieceType.toUpperCase() : chosenPieceType.toLowerCase();

     // --- Pre-move state for history ---
     const prevState = {
         board: board.map(row => [...row]),
         currentPlayer,
         castlingRights: JSON.parse(JSON.stringify(castlingRights)),
         enPassantTarget,
         halfmoveClock,
         fullmoveNumber
     };

     // Get notation *before* placing the piece
     let moveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, true); // isPromotion = true
     moveNotation += chosenPieceType.toUpperCase(); // Add promotion piece like =Q
     let descriptiveNotation = getDescriptiveNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, true);
     descriptiveNotation += ` ${chosenPieceType.toUpperCase()}`;

     // Update board state
     setPieceAt(toRow, toCol, promotionPiece);
     setPieceAt(fromRow, fromCol, null);

     // --- Animate ---
     const pawnElement = getPieceElement(fromRow, fromCol);
     const targetSquareElement = getSquareElement(toRow, toCol);

     const finishAIPromotionMove = () => {
         // Update visual piece *after* animation
         if (pawnElement) {
             pawnElement.textContent = PIECES[promotionPiece];
             pawnElement.dataset.piece = promotionPiece;
         }
         // Finish the rest of the move processing
         finishMoveProcessing(prevState, piece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', moveNotation, descriptiveNotation);
     };

     if (capturedPiece) {
         animateAndRemovePiece(toRow, toCol, capturedPiece, false, () => {
             animatePieceMovement(pawnElement, targetSquareElement, toRow, toCol, finishAIPromotionMove);
         });
     } else {
         animatePieceMovement(pawnElement, targetSquareElement, toRow, toCol, finishAIPromotionMove);
     }
}


function calculateBestMove(difficulty) {
    const availableMoves = getAllLegalMoves(currentPlayer);

    if (availableMoves.length === 0) {
        return null; // Should be checkmate or stalemate
    }

    let bestMove = null;

    switch (difficulty) {
        case 0: // Very Easy (Random, avoids captures/threats if possible)
            let nonCaptureMoves = availableMoves.filter(move => !getPieceAt(move.to.row, move.to.col) && !move.isEnPassant);
             // Further filter: avoid moves that immediately threaten opponent pieces (simplistic check)
            let safeMoves = nonCaptureMoves.filter(move => {
                 // Simulate move briefly
                 const piece = getPieceAt(move.from.row, move.from.col);
                 const originalTarget = getPieceAt(move.to.row, move.to.col);
                 setPieceAt(move.to.row, move.to.col, piece);
                 setPieceAt(move.from.row, move.from.col, null);
                 const attacksOpponent = isAnyPieceAttackedBy(getOpponent(currentPlayer), piece, move.to.row, move.to.col);
                 // Undo simulation
                 setPieceAt(move.from.row, move.from.col, piece);
                 setPieceAt(move.to.row, move.to.col, originalTarget);
                 return !attacksOpponent;
            });

             if (safeMoves.length > 0) {
                 bestMove = safeMoves[Math.floor(Math.random() * safeMoves.length)];
             } else if (nonCaptureMoves.length > 0) {
                  bestMove = nonCaptureMoves[Math.floor(Math.random() * nonCaptureMoves.length)];
             } else {
                  // If only captures are available, pick one randomly
                  bestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
             }
            break;

        case 1: // Easy (Random, but prioritizes captures)
            const captureMoves = availableMoves.filter(move => getPieceAt(move.to.row, move.to.col) || move.isEnPassant);
            if (captureMoves.length > 0) {
                bestMove = captureMoves[Math.floor(Math.random() * captureMoves.length)];
            } else {
                bestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
            }
            break;

        case 2: // Medium (Simple evaluation, 1-ply search)
            let bestScore = -Infinity;
            bestMove = availableMoves[0]; // Default to first move

            availableMoves.forEach(move => {
                // Simulate move
                const piece = getPieceAt(move.from.row, move.from.col);
                const captured = getPieceAt(move.to.row, move.to.col);
                 let capturedEnPassant = null, capturedEnPassantPos = null;
                setPieceAt(move.to.row, move.to.col, piece);
                setPieceAt(move.from.row, move.from.col, null);
                 if (move.isEnPassant) {
                     capturedEnPassantPos = { row: currentPlayer === 'w' ? move.to.row + 1 : move.to.row - 1, col: move.to.col };
                     capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                     setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
                 }

                let score = evaluateBoard();
                // Simple check bonus/penalty
                if (isKingInCheck(getOpponent(currentPlayer))) score += 0.5;
                // simulate making the move for opponent and subtract their best score? No, that's minimax.
                // Just evaluate the resulting board state from AI's perspective.

                // Undo simulation
                 setPieceAt(move.from.row, move.from.col, piece);
                 setPieceAt(move.to.row, move.to.col, captured);
                 if (move.isEnPassant && capturedEnPassantPos) {
                     setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
                 }


                // AI is 'b', wants to minimize the score (White positive, Black negative)
if (currentPlayer === 'b') {
                     if (score < bestScore || bestMove === availableMoves[0]) { // Prioritize minimizing, take first if all equal
                         bestScore = score;
                         bestMove = move;
                     }
                 } else { // Just in case AI plays white
                     if (score > bestScore || bestMove === availableMoves[0]) {
                         bestScore = score;
                         bestMove = move;
                     }
                 }

            });
             console.log("Medium AI best score:", bestScore);
            break;

        case 3: // Hard (Minimax with Alpha-Beta - Placeholder Structure)
             console.log("Running Minimax...");
             const depth = 3; // Adjust depth for performance/strength trade-off
             const alpha = -Infinity;
             const beta = Infinity;
             const maximizingPlayer = currentPlayer === 'w'; // True if AI is White
             const result = minimax(depth, alpha, beta, maximizingPlayer);
             bestMove = result.move;
             console.log(`Minimax result (depth ${depth}): Score ${result.score}, Move:`, bestMove);
             // Fallback if minimax fails (shouldn't happen with valid moves)
             if (!bestMove && availableMoves.length > 0) {
                 console.warn("Minimax failed to return a move, choosing randomly.");
                 bestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
             }
            break;

        default: // Fallback to random
            bestMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
    }

    return bestMove;
}

// Helper for Very Easy AI - checks if moving a piece attacks any opponent piece
function isAnyPieceAttackedBy(attackedPlayer, attackerPiece, attackerRow, attackerCol) {
    // Generate moves for the piece *from its new square*
     const pieceType = attackerPiece.toUpperCase();
     let potentialAttacks = [];
     switch (pieceType) {
         // Pawns only attack diagonally forward
         case 'P':
             const direction = getPlayerForPiece(attackerPiece) === 'w' ? -1 : 1;
             potentialAttacks.push({row: attackerRow + direction, col: attackerCol - 1});
             potentialAttacks.push({row: attackerRow + direction, col: attackerCol + 1});
             break;
         case 'N': potentialAttacks = getKnightMoves(attackerRow, attackerCol, attackerPiece); break;
         case 'B': potentialAttacks = getBishopMoves(attackerRow, attackerCol, attackerPiece); break;
         case 'R': potentialAttacks = getRookMoves(attackerRow, attackerCol, attackerPiece); break;
         case 'Q': potentialAttacks = getQueenMoves(attackerRow, attackerCol, attackerPiece); break;
         case 'K': potentialAttacks = getKingMoves(attackerRow, attackerCol, attackerPiece); break;
     }

     // Check if any potential attack target square contains an opponent's piece
     for (const attack of potentialAttacks) {
          if (attack.row >= 0 && attack.row < BOARD_SIZE && attack.col >= 0 && attack.col < BOARD_SIZE) {
             const targetPiece = getPieceAt(attack.row, attack.col);
             if (targetPiece && getPlayerForPiece(targetPiece) === attackedPlayer) {
                 return true; // Found an attacked opponent piece
             }
         }
     }
    return false;
}


function getAllLegalMoves(player) {
    const allMoves = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece && getPlayerForPiece(piece) === player) {
                const moves = generateLegalMoves(r, c);
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
    return allMoves;
}

// --- Evaluation Function (Simple) ---
const pieceValues = { P: 1, N: 3, B: 3.1, R: 5, Q: 9, K: 100 }; // K value high but doesn't dominate unless endgame

// Positional scores (simplified example - center control)
// Values are from White's perspective
const pawnPositionScore = [
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], // Slightly advance pawns
    [0.1, 0.1, 0.2, 0.3, 0.3, 0.2, 0.1, 0.1],
    [0.05,0.05, 0.1, 0.25,0.25, 0.1,0.05,0.05], // Center pawns
    [0.0, 0.0, 0.0, 0.2, 0.2, 0.0, 0.0, 0.0],
    [0.05,-0.05,-0.1, 0.0, 0.0,-0.1,-0.05,0.05],
    [0.05, 0.1, 0.1,-0.2,-0.2, 0.1, 0.1, 0.05], // Penalize backward pawns slightly
    [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
];
const knightPositionScore = [
    [-0.5,-0.4,-0.3,-0.3,-0.3,-0.3,-0.4,-0.5],
    [-0.4,-0.2, 0.0, 0.05,0.05, 0.0,-0.2,-0.4],
    [-0.3, 0.05, 0.1, 0.15,0.15, 0.1, 0.05,-0.3],
    [-0.3, 0.0, 0.15, 0.2, 0.2, 0.15, 0.0,-0.3], // Center knights
    [-0.3, 0.05, 0.15, 0.2, 0.2, 0.15, 0.05,-0.3],
    [-0.3, 0.0, 0.1, 0.15,0.15, 0.1, 0.0,-0.3],
    [-0.4,-0.2, 0.0, 0.0, 0.0, 0.0,-0.2,-0.4],
    [-0.5,-0.4,-0.3,-0.3,-0.3,-0.3,-0.4,-0.5]
];
// Add similar tables for Bishop, Rook, Queen, King (King safety important)

function evaluateBoard() {
    let score = 0;
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (piece) {
                const pieceType = piece.toUpperCase();
                const value = pieceValues[pieceType] || 0;
                let positionScore = 0;

                // Add positional scores (adjusting for black)
                 if (pieceType === 'P') {
                     positionScore = (getPlayerForPiece(piece) === 'w') ? pawnPositionScore[r][c] : -pawnPositionScore[BOARD_SIZE - 1 - r][c];
                 } else if (pieceType === 'N') {
                     positionScore = (getPlayerForPiece(piece) === 'w') ? knightPositionScore[r][c] : -knightPositionScore[BOARD_SIZE - 1 - r][c];
                 } // Add other piece types...


                score += (getPlayerForPiece(piece) === 'w' ? value + positionScore : -(value + positionScore));
            }
        }
    }
    return score; // Positive favors White, Negative favors Black
}

// --- Minimax with Alpha-Beta Pruning ---
function minimax(depth, alpha, beta, maximizingPlayer) {
    // Base Case: Depth limit reached or game over
    if (depth === 0 || isGameOver) { // Check global isGameOver flag or re-evaluate
        // Re-evaluate game state if checkmate/stalemate wasn't caught before recursion
         if(isCheckmate(currentPlayer)) return { score: maximizingPlayer ? -Infinity : Infinity, move: null };
         if(isStalemate(currentPlayer) || hasInsufficientMaterial() || halfmoveClock >= 100 || checkThreefoldRepetition()) return { score: 0, move: null };
        // Otherwise return static evaluation
        return { score: evaluateBoard(), move: null };
    }

    const availableMoves = getAllLegalMoves(currentPlayer); // Get moves for the *current* player in simulation

     // If no moves available at this depth, it's checkmate or stalemate
     if (availableMoves.length === 0) {
          if (isKingInCheck(currentPlayer)) {
               return { score: maximizingPlayer ? -Infinity : Infinity, move: null }; // Checkmate
          } else {
               return { score: 0, move: null }; // Stalemate
          }
     }


    let bestMove = null;

    if (maximizingPlayer) { // White's turn (or AI if white)
        let maxEval = -Infinity;
        // Sort moves? (e.g., captures first) - can improve pruning
        for (const move of availableMoves) {
            // --- Simulate Move ---
            const piece = getPieceAt(move.from.row, move.from.col);
            const captured = getPieceAt(move.to.row, move.to.col);
            const prevCastling = JSON.parse(JSON.stringify(castlingRights));
            const prevEnPassant = enPassantTarget;
            const prevHalfmove = halfmoveClock;
            const prevFullmove = fullmoveNumber;
            const prevPlayer = currentPlayer;
             let capturedEnPassant = null, capturedEnPassantPos = null;

            setPieceAt(move.to.row, move.to.col, piece);
            setPieceAt(move.from.row, move.from.col, null);
             // Handle special move simulations briefly (need full logic for accurate state)
             if (move.isEnPassant) {
                 capturedEnPassantPos = { row: prevPlayer === 'w' ? move.to.row + 1 : move.to.row - 1, col: move.to.col };
                 capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                 setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
             }
             // Update castling, en passant, clocks based on simulated move (simplified)
             // Need to properly update these for accurate deeper search
             currentPlayer = getOpponent(prevPlayer);


            // --- Recurse ---
            const result = minimax(depth - 1, alpha, beta, false); // Switch to minimizing player
            const evaluation = result.score;


            // --- Undo Simulation ---
             setPieceAt(move.from.row, move.from.col, piece);
             setPieceAt(move.to.row, move.to.col, captured);
             if (move.isEnPassant && capturedEnPassantPos) {
                 setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
             }
             castlingRights = prevCastling;
             enPassantTarget = prevEnPassant;
             halfmoveClock = prevHalfmove;
             fullmoveNumber = prevFullmove;
             currentPlayer = prevPlayer;


            // --- Update Max and Alpha ---
            if (evaluation > maxEval) {
                 maxEval = evaluation;
                 bestMove = move; // Store the move that led to this score
            }
            alpha = Math.max(alpha, evaluation);
            if (beta <= alpha) {
                break; // Beta cut-off
            }
        }
        return { score: maxEval, move: bestMove };

    } else { // Minimizing player (Black's turn or AI if black)
        let minEval = Infinity;
        for (const move of availableMoves) {
             // --- Simulate Move ---
             const piece = getPieceAt(move.from.row, move.from.col);
             const captured = getPieceAt(move.to.row, move.to.col);
             const prevCastling = JSON.parse(JSON.stringify(castlingRights));
             const prevEnPassant = enPassantTarget;
             const prevHalfmove = halfmoveClock;
             const prevFullmove = fullmoveNumber;
             const prevPlayer = currentPlayer;
              let capturedEnPassant = null, capturedEnPassantPos = null;


             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
             if (move.isEnPassant) {
                 capturedEnPassantPos = { row: prevPlayer === 'w' ? move.to.row + 1 : move.to.row - 1, col: move.to.col };
                 capturedEnPassant = getPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col);
                 setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, null);
             }
             // Update castling, en passant, clocks based on simulated move (simplified)
             currentPlayer = getOpponent(prevPlayer);

            // --- Recurse ---
             const result = minimax(depth - 1, alpha, beta, true); // Switch to maximizing player
             const evaluation = result.score;

             // --- Undo Simulation ---
             setPieceAt(move.from.row, move.from.col, piece);
             setPieceAt(move.to.row, move.to.col, captured);
             if (move.isEnPassant && capturedEnPassantPos) {
                 setPieceAt(capturedEnPassantPos.row, capturedEnPassantPos.col, capturedEnPassant);
             }
             castlingRights = prevCastling;
             enPassantTarget = prevEnPassant;
             halfmoveClock = prevHalfmove;
             fullmoveNumber = prevFullmove;
             currentPlayer = prevPlayer;


            // --- Update Min and Beta ---
            if (evaluation < minEval) {
                 minEval = evaluation;
                 bestMove = move; // Store the move that led to this score
            }
            beta = Math.min(beta, evaluation);
            if (beta <= alpha) {
                break; // Alpha cut-off
            }
        }
         return { score: minEval, move: bestMove };
    }
}


// --- Hint System ---
function handleHint() {
    if (isGameOver || isAIThinking || currentPlayer !== 'w') return; // Only hints for player

    console.log("Generating hint...");
    // Use the AI calculation for the current player's perspective
    let hintMove = null;
    let tempDifficulty = aiDifficulty; // Use current difficulty for hint strength

    // For Very Easy, provide a simpler hint (e.g., a random safe move or capture)
     if (tempDifficulty === 0) {
         const availableMoves = getAllLegalMoves(currentPlayer);
         const captureMoves = availableMoves.filter(move => getPieceAt(move.to.row, move.to.col) || move.isEnPassant);
         const safeMoves = availableMoves.filter(move => {
             // Basic safety check: doesn't move into direct attack by pawn/knight/king
             const piece = getPieceAt(move.from.row, move.from.col);
             const originalTarget = getPieceAt(move.to.row, move.to.col);
             setPieceAt(move.to.row, move.to.col, piece);
             setPieceAt(move.from.row, move.from.col, null);
             const isAttacked = isSquareAttacked(move.to.row, move.to.col, getOpponent(currentPlayer));
             setPieceAt(move.from.row, move.from.col, piece);
             setPieceAt(move.to.row, move.to.col, originalTarget);
             return !isAttacked;
         });

         if (captureMoves.length > 0) {
             hintMove = captureMoves[Math.floor(Math.random() * captureMoves.length)];
         } else if (safeMoves.length > 0) {
             hintMove = safeMoves[Math.floor(Math.random() * safeMoves.length)];
         } else if (availableMoves.length > 0) {
              hintMove = availableMoves[Math.floor(Math.random() * availableMoves.length)];
         }

     } else {
         // Use minimax/evaluation for better hints on higher difficulties
         // Temporarily switch perspective for calculation if needed
         const originalPlayer = currentPlayer;
         // currentPlayer = 'w'; // Ensure calculation is from White's perspective
         // Note: calculateBestMove and minimax should handle the player correctly
         hintMove = calculateBestMove(tempDifficulty); // Get the AI's suggested move
         // currentPlayer = originalPlayer; // Switch back
     }


    if (hintMove) {
        console.log("Hint:", hintMove);
        // Highlight the suggested move temporarily
        clearSelectionAndHighlights(); // Clear previous highlights
        const fromSq = getSquareElement(hintMove.from.row, hintMove.from.col);
        const toSq = getSquareElement(hintMove.to.row, hintMove.to.col);
        if (fromSq && toSq) {
             fromSq.classList.add('selected'); // Highlight starting square
             toSq.classList.add(getPieceAt(hintMove.to.row, hintMove.to.col) ? 'capture-move' : 'legal-move'); // Highlight destination

            // Remove hint highlight after a delay
            setTimeout(() => {
                fromSq.classList.remove('selected');
                toSq.classList.remove('legal-move', 'capture-move');
            }, 1500); // Show hint for 1.5 seconds
        }
         statusMessageElement.textContent = `Hint: Consider moving ${PIECES[hintMove.piece]} from ${String.fromCharCode('a'.charCodeAt(0) + hintMove.from.col)}${BOARD_SIZE - hintMove.from.row} to ${String.fromCharCode('a'.charCodeAt(0) + hintMove.to.col)}${BOARD_SIZE - hintMove.to.row}.`;
    } else {
        statusMessageElement.textContent = "No hint available (game over or no moves?).";
        console.log("No hint generated.");
    }
}


// --- Event Listeners ---
newGameButton.addEventListener('click', initGame);
undoButton.addEventListener('click', handleUndo);
hintButton.addEventListener('click', handleHint);
muteButton.addEventListener('click', toggleMute);
toggleAnimationButton.addEventListener('click', toggleCaptureAnimation);
difficultySelect.addEventListener('change', (e) => {
    aiDifficulty = parseInt(e.target.value, 10);
    difficultyLabel.textContent = `AI Difficulty: ${difficultySelect.options[aiDifficulty].text}`;
    console.log("Difficulty changed to:", aiDifficulty);
    // Optionally start a new game on difficulty change? Or just apply to next AI move.
    // initGame(); // Uncomment to force new game on difficulty change
});

// --- Initial Game Load ---
document.addEventListener('DOMContentLoaded', () => {
     console.log("DOM Loaded. Initializing Chess Game...");
     initGame();
     // init3DAnimation(); // Initialize Three.js scene if capture animations are enabled by default
 });