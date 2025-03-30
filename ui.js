// --- START OF FILE ui.js ---

// --- UI State Variables ---
let selectedSquare = null; // { row: r, col: c }
let legalMovesForSelection = []; // Renamed from legalMoves to avoid conflict with gameLogic.generateLegalMoves
let gameMode = 'ai-human'; // 'ai-ai', 'ai-human', 'human-human' (Default to AI vs Human)
let aiElo = 1200;    // Default ELO, matches slider default
let playerColor = 'w'; // 'w' or 'b', human player's color in ai-human mode
let soundEnabled = true;
let isAIThinking = false;
let aiThinkingTimeoutId = null; // Store timeout ID for AI moves

// --- DOM Elements ---
const boardElement = document.getElementById('chess-board');
const turnIndicator = document.getElementById('turn-indicator');
const statusMessageElement = document.getElementById('status-message');
const difficultyLabel = document.getElementById('difficulty-label');
const gameModeSelect = document.getElementById('game-mode-select'); // ADDED
const aiSettingsDiv = document.getElementById('ai-settings');       // ADDED
const aiEloSlider = document.getElementById('ai-elo-slider');       // ADDED
const aiEloValueSpan = document.getElementById('ai-elo-value');     // ADDED
const playerColorIndicator = document.getElementById('player-color-indicator'); // Added
const switchColorsButton = document.getElementById('switch-colors-button'); // Added
const humanPlayerSettingsDiv = document.getElementById('human-player-settings'); // ADDED
const newGameButton = document.getElementById('new-game-button');
const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');
const hintButton = document.getElementById('hint-button');
const muteButton = document.getElementById('mute-button');
const moveHistoryElement = document.getElementById('move-history');
const promotionModal = document.getElementById('promotion-modal');
const promotionButtons = promotionModal.querySelectorAll('button');
const captureCanvas = document.getElementById('capture-animation-canvas'); // For Three.js (placeholder)

// --- Audio Elements ---
const sounds = {
    move: new Audio('move.mp3'),       // Replace with your sound file paths
    capture: new Audio('capture.mp3'),
    check: new Audio('check.mp3'),
    gameOver: new Audio('game-over.mp3')
};
Object.values(sounds).forEach(sound => sound.preload = 'auto'); // Preload sounds

// --- Three.js Placeholder ---
let scene, camera, renderer;
function init3DAnimation() {
    console.log("Initializing 3D setup (Placeholder)");
    // Placeholder: Basic setup if needed, but likely not required for simple fallback
    if (!renderer) {
         // Setup basic scene/camera/renderer if you intend to use Three.js
         // For now, we just log
         console.log("Placeholder: Three.js would be initialized here.");
    }
}

function animateCapture3D(attackerPiece, defenderPiece, callback) {
    // This remains a placeholder or could be replaced with a 2D canvas animation
    console.log(`Placeholder: 3D Animation - ${attackerPiece} captures ${defenderPiece}`);
    captureCanvas.style.display = 'block'; // Show placeholder area
    // Simulate animation delay
    setTimeout(() => {
        console.log("3D Animation finished (Placeholder)");
        captureCanvas.style.display = 'none'; // Hide placeholder area
        if (callback) callback();
    }, 1500); // Simulate 1.5 second animation
}

// --- Game Initialization (Called from DOMContentLoaded) ---
function initGame() {
    console.log("UI: Initializing game...");
    // Clear any pending AI move timeouts
    if (aiThinkingTimeoutId) {
        clearTimeout(aiThinkingTimeoutId);
        aiThinkingTimeoutId = null;
    }
    isAIThinking = false;
    selectedSquare = null;
    legalMovesForSelection = [];
    gameHistory = []; // Clear history in gameLogic state
    currentMoveIndex = -1; // Reset index in gameLogic state

    // Set initial game mode and ELO from controls
    // updateGameSettingsFromUI(); // Call this to ensure state matches UI on init

    // Initialize board state using gameLogic
    if (!parseFen(INITIAL_BOARD_FEN)) {
        console.error("Failed to parse initial FEN. Cannot start game.");
         statusMessageElement.textContent = "Error: Could not load initial position.";
        return;
    }

    // Set player based on initial FEN (should be white)
    // playerColor is set by user preference, currentPlayer is from FEN
    updatePlayerColorIndicator();

    createBoardDOM(); // Create the visual board squares
    renderBoard();    // Render pieces based on gameLogic.board
    
    // Push the initial state to history (handled in gameLogic via parseFen? No, needs explicit push)
     pushHistoryState({ truncate: false }); // Save the initial state (no move info)
     console.log("Initial state pushed. History length:", gameHistory.length);

    updateStatusDisplay();
    updateMoveHistoryDisplay();
    updateHistoryButtons();
    updateGameModeDisplay(); // Update based on selected mode/ELO
    
    // Check if AI needs to move immediately (e.g., player chose black)
    checkAndTriggerAIMove();
    console.log(`UI: Game Initialized. Mode: ${gameMode}, ELO: ${aiElo}, Current Player: ${currentPlayer}`);
}

// --- Helper function to determine if the game is in AI mode ---
function isAIMode() {
    // return gameMode === 'ai'; // OLD
    return gameMode === 'ai-human' || gameMode === 'ai-ai'; // NEW: True if AI is involved
}

// --- Update display for game mode and player color ---
function updateGameModeDisplay() {
    let modeText = "Mode: Human vs Human";
    if (gameMode === 'ai-human') {
        modeText = "Mode: AI vs Human";
        aiSettingsDiv.style.display = 'block';
        humanPlayerSettingsDiv.style.display = 'block'; // Show for AI vs Human
        playerColorIndicator.style.display = 'block';
    } else if (gameMode === 'ai-ai') {
        modeText = `Mode: AI vs AI (ELO: ${aiElo})`;
        aiSettingsDiv.style.display = 'block';
        // *** MODIFIED: Keep container visible, button will be disabled by updateStatusDisplay ***
        humanPlayerSettingsDiv.style.display = 'block'; 
        playerColorIndicator.style.display = 'none'; // Still hide playing as
    } else { // human-human
        aiSettingsDiv.style.display = 'none';
        humanPlayerSettingsDiv.style.display = 'block'; // Show for Human vs Human
        playerColorIndicator.style.display = 'block';
    }
    difficultyLabel.textContent = modeText;
    // Ensure slider and value display match the state if visible
    if (aiSettingsDiv.style.display !== 'none') {
        aiEloSlider.value = aiElo;
        aiEloValueSpan.textContent = aiElo;
    }
}

// --- Function to read settings from UI and update state ---
function updateGameSettingsFromUI() {
    // *** ADDED: Cancel any pending AI move calculation (Keep as safety) ***
    if (aiThinkingTimeoutId) {
        clearTimeout(aiThinkingTimeoutId);
        aiThinkingTimeoutId = null;
        console.log("UI: Cleared pending AI move timeout due to settings change.");
    }
    // *** END ADDED ***

    // *** isAIThinking flag is now reset directly in the event listener ***
    // const prevGameMode = gameMode; // No longer needed here for resetting flag
    gameMode = gameModeSelect.value;
    aiElo = parseInt(aiEloSlider.value, 10);

    console.log(`UI Settings Updated: Mode=${gameMode}, ELO=${aiElo}`);

    // *** Removed redundant isAIThinking reset logic ***
    // if (isAIThinking && (prevGameMode === 'ai-ai' || gameMode !== prevGameMode)) {
    //    ...
    // }

    updateGameModeDisplay(); // Update labels and visibility

    // Check if AI needs to move based on the *new* settings
    // This should only happen if the flag was successfully reset by the event listener
    if (!isAIThinking) {
        checkAndTriggerAIMove();
    }
     // Update the status display fully at the end to reflect all changes
     updateStatusDisplay();
}

function updatePlayerColorIndicator() {
    const playingAsText = `Playing as: ${playerColor === 'w' ? 'White' : 'Black'}`;
    playerColorIndicator.textContent = playingAsText;
    playerColorIndicator.className = playerColor === 'w' ? 'white' : 'black';
    switchColorsButton.textContent = `Play as ${playerColor === 'w' ? 'Black' : 'White'}`;
    
    // Flip board visually if player chooses black
    boardElement.style.transform = playerColor === 'b' ? 'rotate(180deg)' : 'none';
    document.querySelectorAll('.piece').forEach(piece => {
        piece.style.transform = playerColor === 'b' ? 'rotate(180deg)' : 'none';
    });
    // Uncomment the label rotation logic
     document.querySelectorAll('.square').forEach(square => {
         // Adjust label orientation if board is flipped
         const coordLabel = square.querySelector('.coordinate-label');
         if(coordLabel) coordLabel.style.transform = playerColor === 'b' ? 'rotate(180deg)' : 'none';
     });
}

// --- Board DOM Creation ---
function createBoardDOM() {
    boardElement.innerHTML = ''; // Clear existing board
    for (let r_visual = 0; r_visual < BOARD_SIZE; r_visual++) {
        for (let c_visual = 0; c_visual < BOARD_SIZE; c_visual++) {
             // Determine logical coordinates based on player color
             const r_logical = playerColor === 'w' ? r_visual : BOARD_SIZE - 1 - r_visual;
             const c_logical = playerColor === 'w' ? c_visual : BOARD_SIZE - 1 - c_visual;

            const square = document.createElement('div');
            square.classList.add('square');
            // Color based on logical coordinates for consistency
            square.classList.add((r_logical + c_logical) % 2 === 0 ? 'light' : 'dark');
            square.dataset.row = r_logical; // Store LOGICAL row/col
            square.dataset.col = c_logical;
            
             // Add coordinate labels (always based on logical position)
             const rank = BOARD_SIZE - r_logical;
             const file = String.fromCharCode('a'.charCodeAt(0) + c_logical);
             const notation = file + rank;

             const coordLabel = document.createElement('span');
             coordLabel.classList.add('coordinate-label');
             coordLabel.textContent = notation;
             square.appendChild(coordLabel);

            square.addEventListener('click', () => handleSquareClick(r_logical, c_logical));
            boardElement.appendChild(square);
        }
    }
    // Apply initial rotation based on player color
     updatePlayerColorIndicator(); 
}

// --- Board Rendering (Pieces) ---
function renderBoard() {
    // Remove existing piece elements safely
    boardElement.querySelectorAll('.piece').forEach(p => p.remove());
    // Clear previous check highlights
    boardElement.querySelectorAll('.square.in-check').forEach(sq => sq.classList.remove('in-check'));

    for (let r_logical = 0; r_logical < BOARD_SIZE; r_logical++) {
        for (let c_logical = 0; c_logical < BOARD_SIZE; c_logical++) {
            const piece = getPieceAt(r_logical, c_logical); // Get piece from gameLogic state
            if (piece) {
                const squareElement = getSquareElement(r_logical, c_logical);
                if (squareElement) {
                    const pieceElement = document.createElement('div');
                    pieceElement.classList.add('piece');
                    pieceElement.textContent = PIECES[piece]; // Use constant from gameLogic
                    pieceElement.dataset.piece = piece;
                    pieceElement.dataset.row = r_logical; // Store logical coords
                    pieceElement.dataset.col = c_logical;

                    // Calculate visual position based on logical coords and player color
                    const r_visual = playerColor === 'w' ? r_logical : BOARD_SIZE - 1 - r_logical;
                    const c_visual = playerColor === 'w' ? c_logical : BOARD_SIZE - 1 - c_logical;

                    pieceElement.style.position = 'absolute';
                    pieceElement.style.left = `${c_visual * 100 / BOARD_SIZE}%`;
                    pieceElement.style.top = `${r_visual * 100 / BOARD_SIZE}%`;
                    pieceElement.style.width = `${100 / BOARD_SIZE}%`;
                    pieceElement.style.height = `${100 / BOARD_SIZE}%`;
                    // pieceElement.style.fontSize = '7vmin'; // Let CSS handle font size
                    pieceElement.style.display = 'flex';
                    pieceElement.style.justifyContent = 'center';
                    pieceElement.style.alignItems = 'center';
                    pieceElement.style.lineHeight = '1';
                    // Apply rotation if player is black
                    pieceElement.style.transform = playerColor === 'b' ? 'rotate(180deg)' : 'none';

                    // Add click handler to piece as well (stopPropagation needed)
                    pieceElement.addEventListener('click', (e) => {
                        e.stopPropagation(); // Prevent square click from firing too
                        handleSquareClick(r_logical, c_logical);
                    });

                    boardElement.appendChild(pieceElement);

                    // Highlight king if in check (use gameLogic functions)
                    const kingPieceForCurrent = (currentPlayer === 'w') ? 'K' : 'k';
                    const kingPieceForOpponent = (currentPlayer === 'w') ? 'k' : 'K';
                    
                    if (piece === kingPieceForCurrent && isKingInCheck(currentPlayer)) {
                       squareElement.classList.add('in-check');
                    }
                    if (piece === kingPieceForOpponent && isKingInCheck(getOpponent(currentPlayer))) {
                         squareElement.classList.add('in-check');
                    }
                }
            }
        }
    }
    highlightSelectedSquare();
    highlightLegalMoves(); // Call even if no square selected to clear old highlights
    // console.log("UI: Board rendered.");
}

// --- UI Element Getters ---
// Gets square based on LOGICAL coordinates
function getSquareElement(row, col) {
    return boardElement.querySelector(`.square[data-row="${row}"][data-col="${col}"]`);
}

// Gets piece based on LOGICAL coordinates
function getPieceElement(row, col) {
    // Pieces are direct children of boardElement in this structure
    return boardElement.querySelector(`.piece[data-row="${row}"][data-col="${col}"]`);
}

// --- Event Handling ---
function handleSquareClick(row, col) {
    // console.log(`UI: Clicked logical square: (${row}, ${col})`);
    if (isGameOver || isAIThinking) return;
    
    // Prevent interaction if it's not the human player's turn or in AI vs AI mode
    if (gameMode === 'ai-ai' || (gameMode === 'ai-human' && currentPlayer !== playerColor)) {
        console.log("UI: Not player's turn or AI vs AI mode.");
        return;
    }

    const clickedPiece = getPieceAt(row, col); // From gameLogic

    if (selectedSquare) {
        // Check if the clicked square is a legal move for the selected piece
        const move = legalMovesForSelection.find(m => m.row === row && m.col === col);
        if (move) {
            console.log("UI: Attempting move:", selectedSquare, "->", { row, col }, "Promotion?", move.isPromotion);
            // Initiate the move process
            makeMove(selectedSquare.row, selectedSquare.col, row, col, move.isPromotion);
            clearSelectionAndHighlights();
            // AI move is triggered after player move completes in finishMoveProcessing
        } else {
            // Clicked on a square that is NOT a legal move
            clearSelectionAndHighlights();
            // If clicked on another piece of the current player, select it
            if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
                selectPiece(row, col);
            }
        }
    } else {
        // No piece currently selected
        if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
            selectPiece(row, col);
        }
    }
}

function selectPiece(row, col) {
    // Ensure it's the correct player's piece
    const piece = getPieceAt(row, col);
    if (!piece || getPlayerForPiece(piece) !== currentPlayer) {
        return;
    }
    
    selectedSquare = { row, col };
    // console.log("UI: Selected piece:", piece, "at", selectedSquare);
    
    // Generate legal moves for this piece using gameLogic
    legalMovesForSelection = generateLegalMoves(row, col); 
    // console.log("UI: Generated legal moves:", legalMovesForSelection);
    
    highlightSelectedSquare();
    highlightLegalMoves();
}

// --- Highlighting Functions ---
function clearSelectionAndHighlights() {
    selectedSquare = null;
    legalMovesForSelection = []; // Clear UI move list
    document.querySelectorAll('.square.selected').forEach(sq => sq.classList.remove('selected'));
    document.querySelectorAll('.square.legal-move').forEach(sq => sq.classList.remove('legal-move'));
    document.querySelectorAll('.square.capture-move').forEach(sq => sq.classList.remove('capture-move'));
     // Clear hint highlights if any
     document.querySelectorAll('.square.hint-from').forEach(sq => sq.classList.remove('hint-from'));
     document.querySelectorAll('.square.hint-to').forEach(sq => sq.classList.remove('hint-to'));
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
    // Clear previous move highlights
    document.querySelectorAll('.square.legal-move, .square.capture-move').forEach(sq => {
        sq.classList.remove('legal-move', 'capture-move');
    });

    // Ensure legalMovesForSelection is always an array before using forEach
    if (Array.isArray(legalMovesForSelection)) {
        legalMovesForSelection.forEach(move => {
            const squareElement = getSquareElement(move.row, move.col);
            if (squareElement) {
                // Check for capture using gameLogic state
                const isCapture = getPieceAt(move.row, move.col) !== null || move.isEnPassant;
                squareElement.classList.add(isCapture ? 'capture-move' : 'legal-move');
            } else {
                 console.warn(`UI: Could not find square element for legal move: ${move.row}, ${move.col}`);
            }
        });
    } else {
         console.error("UI: highlightLegalMoves called when legalMovesForSelection is not an array:", legalMovesForSelection);
         legalMovesForSelection = []; // Reset to prevent further errors if state is corrupt
    }
}

// --- Move Execution (Initiation and Animation) ---
// This function starts the move process, including animations.
// It calls finishMoveProcessing after animations complete.
function makeMove(fromRow, fromCol, toRow, toCol, needsPromotion = false) {
    const piece = getPieceAt(fromRow, fromCol); // Get piece from logic
    if (!piece) {
        console.error("UI Error: Attempted to move from an empty square!", {fromRow, fromCol});
        clearSelectionAndHighlights();
        return;
    }
    const capturedPiece = getPieceAt(toRow, toCol); // Logical captured piece
    let specialMoveType = null; // 'castling', 'enpassant', 'promotion'

    // --- Store previous state info (needed for history) --- 
    const prevStateInfo = {
        currentPlayer: currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)), // Deep copy needed
        enPassantTarget: enPassantTarget ? {...enPassantTarget} : null, // Deep copy needed
        halfmoveClock: halfmoveClock,
        fullmoveNumber: fullmoveNumber
    };

    // --- Determine Move Type and Base Notation --- 
    const isCastling = (piece.toUpperCase() === 'K') && Math.abs(toCol - fromCol) === 2;
    const isEnPassantCapture = (piece.toUpperCase() === 'P') && 
                               toCol !== fromCol && !capturedPiece &&
                               enPassantTarget && toRow === enPassantTarget.row && toCol === enPassantTarget.col;

    if (isCastling) specialMoveType = 'castling';
    if (isEnPassantCapture) specialMoveType = 'enpassant';
    // Promotion is handled slightly differently

    // Calculate base algebraic notation (before check/mate/promotion symbols)
    let baseMoveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isEnPassantCapture, isCastling);

    // --- Handle Promotion --- 
    if (needsPromotion) {
        specialMoveType = 'promotion';
        // Don't execute the move yet, show dialog first.
        // Pass necessary info to the dialog handler.
        showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isEnPassantCapture, prevStateInfo, baseMoveNotation);
        return; // Stop execution here, promotion dialog will continue
    }

    // --- Execute Non-Promotion Moves Logically (Update Board State) --- 
    let capturedPawnActual = null;
    let capturedPawnRow = -1;
    let rookFromCol, rookToCol, rookRow, rookPiece;

    // 1. En Passant: Remove the captured pawn logically
    if (isEnPassantCapture) {
        capturedPawnRow = currentPlayer === 'w' ? toRow + 1 : toRow - 1;
        capturedPawnActual = getPieceAt(capturedPawnRow, toCol); // Should be 'P' or 'p'
        setPieceAt(capturedPawnRow, toCol, null); 
        console.log(`UI: Logical EP capture. Removed pawn at (${capturedPawnRow}, ${toCol})`);
    }

    // 2. Castling: Move the rook logically
    if (isCastling) {
        rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
        rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        rookRow = fromRow;
        rookPiece = getPieceAt(rookRow, rookFromCol); // Get the actual rook piece

        if (rookPiece) {
             setPieceAt(rookRow, rookToCol, rookPiece);
             setPieceAt(rookRow, rookFromCol, null);
             console.log(`UI: Logical castling. Moved rook from ${rookFromCol} to ${rookToCol}`);
        } else {
             console.error("UI Castling Error: Rook not found at expected position:", {rookRow, rookFromCol});
             // TODO: How to handle this error gracefully? Revert King move?
        }
    }

    // 3. Standard Move: Update board array
    setPieceAt(toRow, toCol, piece);
    setPieceAt(fromRow, fromCol, null);

    // --- Animate Movement --- 
    const movingPieceElement = getPieceElement(fromRow, fromCol); // Get element from ORIGINAL pos
    const targetSquareElement = getSquareElement(toRow, toCol);

    // Callback after main piece animation completes
    const onMainMoveComplete = () => {
        // If castling, animate the rook *after* the king finishes
        if (isCastling && rookPiece) {
             // Find the visual rook element *where it logically ended up*
             const finalRookElement = getPieceElement(rookRow, rookToCol); 
             const rookTargetSquareElement = getSquareElement(rookRow, rookToCol);
             
             // We need to *re-render* the board quickly *before* rook animation
             // to create the rook element at its new logical spot if it wasn't rendered yet.
             // However, this might cause flicker. A better way is to create/move the rook element manually.

             // **Alternative: Manually create/move rook for animation**
             let rookElementToAnimate = getPieceElement(rookRow, rookFromCol); // Try finding original
             if (!rookElementToAnimate) {
                // If original doesn't exist (maybe due to previous render issues),
                // create a temporary one for animation? Or find the logically moved one?
                // Let's find the one that *should* be there after the logical move.
                renderBoard(); // Quick render to ensure piece exists visually at rookToCol
                rookElementToAnimate = getPieceElement(rookRow, rookToCol);
                console.warn("Castling animation: Had to re-render to find rook element.")
             } else {
                 // Move existing rook element visually before animation
                  const r_vis = playerColor === 'w' ? rookRow : BOARD_SIZE - 1 - rookRow;
                  const c_vis_start = playerColor === 'w' ? rookFromCol : BOARD_SIZE - 1 - rookFromCol;
                  rookElementToAnimate.style.top = `${r_vis * 100 / BOARD_SIZE}%`;
                  rookElementToAnimate.style.left = `${c_vis_start * 100 / BOARD_SIZE}%`;
                  // Update its dataset AFTER animation
             }

             if (rookElementToAnimate && rookTargetSquareElement) {
                 console.log("UI: Animating castling rook...");
                 animatePieceMovement(rookElementToAnimate, rookTargetSquareElement, rookRow, rookToCol, () => {
                     finishMoveProcessing(prevStateInfo, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMoveType, baseMoveNotation);
                 });
             } else {
                 console.error("UI Castling Animation Error: Rook element not found for animation.");
                 // Proceed without rook animation if element missing
                 finishMoveProcessing(prevStateInfo, piece, capturedPiece, fromRow, fromCol, toRow, toCol, specialMoveType, baseMoveNotation);
             }
        } else {
             // For non-castling moves, or castling where rook animation failed
             // Pass the correct captured piece info (including for en passant)
             const logicalCapture = capturedPiece || (isEnPassantCapture ? capturedPawnActual : null);
             finishMoveProcessing(prevStateInfo, piece, logicalCapture, fromRow, fromCol, toRow, toCol, specialMoveType, baseMoveNotation);
        }
    };

    // --- Handle Capture Animation --- 
    let pieceToAnimateRemoval = null;
    let removalRow = -1, removalCol = -1;
    let removalPieceType = null;

    if (capturedPiece && !isEnPassantCapture) {
         pieceToAnimateRemoval = getPieceElement(toRow, toCol); // Piece at destination
         removalRow = toRow;
         removalCol = toCol;
         removalPieceType = capturedPiece;
         console.log("UI: Standard capture animation setup.");
    } else if (isEnPassantCapture && capturedPawnActual) {
         pieceToAnimateRemoval = getPieceElement(capturedPawnRow, toCol); // Piece at EP capture square
         removalRow = capturedPawnRow;
         removalCol = toCol;
         removalPieceType = capturedPawnActual;
          console.log("UI: En Passant capture animation setup.");
    }

    // Start the animation sequence
    if (pieceToAnimateRemoval) {
        animateAndRemovePiece(removalRow, removalCol, removalPieceType, isEnPassantCapture, () => {
             // After capture animation, animate the main piece move
             if (movingPieceElement && targetSquareElement) {
                  animatePieceMovement(movingPieceElement, targetSquareElement, toRow, toCol, onMainMoveComplete);
             } else {
                 console.warn("UI: Moving piece element missing for animation after capture.");
                 onMainMoveComplete(); // Proceed without animation
             }
         }, fromRow, fromCol); // Pass attacker coords for 3D anim context
    } else {
         // No capture, just animate the main piece move
         if (movingPieceElement && targetSquareElement) {
              animatePieceMovement(movingPieceElement, targetSquareElement, toRow, toCol, onMainMoveComplete);
         } else {
             console.warn("UI: Moving piece element missing for animation (non-capture).");
             onMainMoveComplete(); // Proceed without animation
         }
    }
}

// --- Promotion Handling --- 
function showPromotionDialog(fromRow, fromCol, toRow, toCol, piece, capturedPiece, isEnPassantCapture, prevStateInfo, baseMoveNotation) {
    promotionModal.style.display = 'flex';

    // Store move details temporarily on the modal element itself
    promotionModal.moveDetails = { fromRow, fromCol, toRow, toCol, piece, capturedPiece, isEnPassantCapture, prevStateInfo, baseMoveNotation };

    // Clear previous listeners by cloning and replacing buttons
    promotionButtons.forEach(button => {
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);
    });
    // Get the new buttons
    const currentPromotionButtons = promotionModal.querySelectorAll('button');

    // Add listeners to the NEW buttons
    currentPromotionButtons.forEach(button => {
        button.onclick = () => { // Use onclick for simplicity after cloning
            const chosenPieceType = button.getAttribute('data-piece');
             // Retrieve stored move details
             const moveDetails = promotionModal.moveDetails;
             if (moveDetails && chosenPieceType) {
                 console.log(`Promotion choice: ${chosenPieceType}`);
                 promotionModal.style.display = 'none';
                 // Execute the promotion logic with the chosen piece
                 executePromotion(
                     moveDetails.fromRow, 
                     moveDetails.fromCol, 
                     moveDetails.toRow, 
                     moveDetails.toCol, 
                     chosenPieceType, 
                     moveDetails.piece, // Original pawn
                     moveDetails.capturedPiece, 
                     moveDetails.isEnPassantCapture, 
                     moveDetails.prevStateInfo, 
                     moveDetails.baseMoveNotation
                 );
             } else {
                 console.error("Error retrieving move details or chosen piece for promotion.");
                 promotionModal.style.display = 'none'; // Hide modal anyway
             }
        }; // End of onclick handler
    }); // End of currentPromotionButtons.forEach
}

// --- Helper function to execute promotion logic after choice --- 
function executePromotion(fromRow, fromCol, toRow, toCol, chosenPieceType, originalPawn, capturedPiece, isEnPassantCapture, prevStateInfo, baseMoveNotation) {
    const promotionPiece = prevStateInfo.currentPlayer === 'w' ? chosenPieceType.toUpperCase() : chosenPieceType.toLowerCase();
    const finalMoveNotation = baseMoveNotation + "=" + chosenPieceType.toUpperCase();

    // --- Execute Promotion Logically --- 
    let capturedPawnActual = null;
    let capturedPawnRow = -1;
    // 1. Handle potential en passant capture during promotion (rare but possible)
    if (isEnPassantCapture) {
        capturedPawnRow = prevStateInfo.currentPlayer === 'w' ? toRow + 1 : toRow - 1;
        capturedPawnActual = getPieceAt(capturedPawnRow, toCol); 
        setPieceAt(capturedPawnRow, toCol, null); 
    }
    // 2. Update board: Place promoted piece, remove original pawn
    setPieceAt(toRow, toCol, promotionPiece);
    setPieceAt(fromRow, fromCol, null);

    // --- Finish Move Processing --- 
    const logicalCapture = capturedPiece || (isEnPassantCapture ? capturedPawnActual : null);
    // Pass 'promotion' as specialMoveType explicitly, and use originalPawn for history tracking
    finishMoveProcessing(prevStateInfo, originalPawn, logicalCapture, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation);
}

// --- Post-Animation Move Processing (Handles Logic Updates, State Checks, UI Updates) ---
function finishMoveProcessing(prevStateInfo, movedPiece, capturedPieceLogical, fromRow, fromCol, toRow, toCol, specialMoveType, finalMoveNotationBase) {
    // console.log("UI: Finishing move processing for:", finalMoveNotationBase);
    const playerWhoMoved = prevStateInfo.currentPlayer;

    // --- Update Game State (Castling, EP, Clocks) --- 
    // 1. Update Castling Rights
    if (movedPiece === 'K') { castlingRights.w.K = castlingRights.w.Q = false; }
    if (movedPiece === 'k') { castlingRights.b.K = castlingRights.b.Q = false; }
    if (movedPiece === 'R') {
         if (playerWhoMoved === 'w') {
             if (fromRow === 7 && fromCol === 0) castlingRights.w.Q = false; // a1
             if (fromRow === 7 && fromCol === 7) castlingRights.w.K = false; // h1
         } else {
             if (fromRow === 0 && fromCol === 0) castlingRights.b.Q = false; // a8
             if (fromRow === 0 && fromCol === 7) castlingRights.b.K = false; // h8
         }
    }
    // If a rook is captured *on its starting square*
    if (capturedPieceLogical && capturedPieceLogical.toUpperCase() === 'R') {
         const opponent = getOpponent(playerWhoMoved);
         if (opponent === 'w') {
             if (toRow === 7 && toCol === 0) castlingRights.w.Q = false; // a1 captured
             if (toRow === 7 && toCol === 7) castlingRights.w.K = false; // h1 captured
         } else {
             if (toRow === 0 && toCol === 0) castlingRights.b.Q = false; // a8 captured
             if (toRow === 0 && toCol === 7) castlingRights.b.K = false; // h8 captured
         }
    }

    // 2. Update En Passant Target
    if (movedPiece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2) {
        enPassantTarget = { row: (fromRow + toRow) / 2, col: fromCol };
    } else {
        enPassantTarget = null;
    }

    // 3. Update Clocks
    if (movedPiece.toUpperCase() === 'P' || capturedPieceLogical) {
        halfmoveClock = 0;
    } else {
        halfmoveClock++;
    }
    if (playerWhoMoved === 'b') {
        fullmoveNumber++;
    }

    // 4. Switch Player
    currentPlayer = getOpponent(playerWhoMoved);

    // --- Check Game End Conditions --- 
    let endCondition = checkGameEndCondition(); // Checks for mate/stalemate for the *new* current player
    let isCheck = false;
    let finalMoveNotation = finalMoveNotationBase;

    if (endCondition === 'checkmate') {
        isGameOver = true;
        gameStatusMessage = `Checkmate! ${playerWhoMoved === 'w' ? 'White' : 'Black'} wins.`;
        finalMoveNotation += '#';
        playSound(sounds.gameOver);
    } else if (endCondition === 'stalemate') {
        isGameOver = true;
        gameStatusMessage = "Stalemate! Game is a draw.";
        playSound(sounds.gameOver);
    } else {
        // Not mate/stalemate, check for other draw conditions or simple check
        isCheck = isKingInCheck(currentPlayer); // Is the *new* current player in check?
        if (isCheck) {
             finalMoveNotation += '+';
        }

        if (halfmoveClock >= 100) {
            isGameOver = true;
            gameStatusMessage = "Draw by 50-move rule.";
            playSound(sounds.gameOver);
        } else if (checkThreefoldRepetition()) { // Needs history access
            isGameOver = true;
            gameStatusMessage = "Draw by threefold repetition.";
            playSound(sounds.gameOver);
        } else if (hasInsufficientMaterial()) {
            isGameOver = true;
            gameStatusMessage = "Draw by insufficient material.";
            playSound(sounds.gameOver);
        }
    }
    
    // If game didn't end, set status based on check
    if (!isGameOver) {
         if (isCheck) {
             gameStatusMessage = `${currentPlayer === 'w' ? 'White' : 'Black'} is in Check!`;
             playSound(sounds.check); // Play check sound
         } else {
              gameStatusMessage = `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`;
              // Play move/capture sound only if not check/game over
              playSound(capturedPieceLogical ? sounds.capture : sounds.move);
         }
    }

    // --- Record History --- 
    // Push state AFTER all logical updates for the move are done
    pushHistoryState({ notation: finalMoveNotation, moveNumber: prevStateInfo.fullmoveNumber });

    // Reset AI thinking flag AFTER all processing but BEFORE UI updates for the *next* turn
    if ((gameMode === 'ai-human' && playerWhoMoved !== playerColor) || gameMode === 'ai-ai') {
        isAIThinking = false;
        console.log("UI: Reset isAIThinking flag after AI move completion.");
    }

    // --- Update UI --- 
    renderBoard(); // Re-render with new piece positions and check highlights
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    updateHistoryButtons();

    // --- Trigger AI if applicable --- 
    checkAndTriggerAIMove();
    // console.log("UI: Move processing complete.");
}

// --- Helper to check conditions and trigger AI --- 
function checkAndTriggerAIMove() {
    if (isAIThinking) {
         console.log("AI is already thinking, skipping trigger.");
         return;
    }
    // Check if AI needs to move based on game mode
    let shouldAIMove = false;
    if (gameMode === 'ai-human' && currentPlayer !== playerColor) {
        shouldAIMove = true;
    } else if (gameMode === 'ai-ai') {
        shouldAIMove = true;
    }

    if (shouldAIMove && !isGameOver) {
        const delay = gameMode === 'ai-ai' ? 500 : 100; // Longer delay for AI vs AI
        console.log(`UI: Triggering AI move for ${currentPlayer} (ELO: ${aiElo}) with delay ${delay}ms. Mode: ${gameMode}`);
        isAIThinking = true;
        updateStatusDisplay(); // Update status to show spinner and message
        boardElement.classList.add('ai-thinking');
        
        // Store timeout ID so it can be cleared if needed (e.g., new game)
        if (aiThinkingTimeoutId) clearTimeout(aiThinkingTimeoutId); // Clear previous if any
        aiThinkingTimeoutId = setTimeout(() => {
             triggerAIMove();
             aiThinkingTimeoutId = null; // Clear ID after execution
        }, delay); 
    } else {
        isAIThinking = false; 
        updateStatusDisplay(); // Ensure status is correct and spinner is removed
        boardElement.classList.remove('ai-thinking');
    }
}

function triggerAIMove() {
    // Revised condition check:
    let abort = false;
    if (!isAIMode()) { // Abort if not any AI mode
        abort = true;
        console.log("Aborting AI trigger: Not an AI mode.");
    } else if (gameMode === 'ai-human' && currentPlayer === playerColor) { // Abort in AI vs Human if it IS the human's turn
        abort = true;
         console.log("Aborting AI trigger: It's human's turn in ai-human mode.");
    // *** ADDED: Check if the thinking flag is still true. It might have been reset by user interaction. ***
    } else if (!isAIThinking) {
         abort = true;
         console.log("Aborting AI trigger: AI thinking flag is not set (likely interrupted).");
         boardElement.classList.remove('ai-thinking'); // Clean up UI just in case
         return;
    }
    // *** END ADDED ***

    if (abort) {
        console.log("Aborting AI move trigger: Conditions not met.");
        // Ensure thinking flag is reset if we abort here, unless it was already false
        if (isAIThinking) {
            isAIThinking = false; 
            updateStatusDisplay(); // Update status to remove spinner
        }
        boardElement.classList.remove('ai-thinking');
        return;
    }

    // Clear the timeout ID as we are now executing
    aiThinkingTimeoutId = null;

    console.log(`Requesting AI move calculation with ELO: ${aiElo}`);
    const aiMove = calculateBestMove(aiElo);

    // *** ADDED: Check if still thinking after calculation, might have been interrupted ***
    if (!isAIThinking) {
        console.log("AI move calculation finished, but thinking was interrupted. Discarding move.");
        boardElement.classList.remove('ai-thinking');
        // No need to call updateStatusDisplay again unless state changed unexpectedly
        return;
    }
    // *** END ADDED ***

    if (aiMove) {
        console.log("UI: AI chose move:", aiMove);
        // Ensure the move object has the necessary 'from' and 'to' structure
        if (aiMove.from && aiMove.to) {
            // Check if promotion is needed based on AI move details
            const needsPromotion = aiMove.isPromotion || (aiMove.piece?.toUpperCase() === 'P' && (aiMove.to.row === 0 || aiMove.to.row === 7));

            if (needsPromotion) {
                 // AI should ideally decide promotion piece type.
                 // For now, assume Queen promotion if AI doesn't specify.
                 // The calculateBestMove should be updated to return promotion choice.
                 // Let's assume the AI function adds a 'promotionPiece' property if needed.
                 let promotionPieceType = aiMove.promotionPiece || 'Q'; // Default to Queen
                 console.log(`AI promoting pawn to ${promotionPieceType}`);
                 // *** Pass thinking flag reset responsibility to the called function ***
                 handleAIPromotion(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col, promotionPieceType);
            } else {
                 // Simulate making the move through the UI function to trigger animations/updates
                 // Use the core makeMove logic, but skip the player turn check
                 console.log(`Executing AI move: ${JSON.stringify(aiMove.from)} -> ${JSON.stringify(aiMove.to)}`);
                 // *** Pass thinking flag reset responsibility to the called function ***
                 makeMove(aiMove.from.row, aiMove.from.col, aiMove.to.row, aiMove.to.col, false);
                 // makeMove already handles setting isAIThinking to false via finishMoveProcessing AFTER processing is complete
            }
        } else {
            console.error("AI move object is missing 'from' or 'to' properties:", aiMove);
            statusMessageElement.textContent = "AI Error: Invalid move format.";
            isAIThinking = false; // Reset thinking flag on error
            updateStatusDisplay(); // Re-evaluate game status and remove spinner
            boardElement.classList.remove('ai-thinking');
        }
    } else {
        console.log("UI: AI returned no move. Game might be over.");
        isAIThinking = false; // Reset thinking flag
        updateStatusDisplay(); // Re-evaluate game status and remove spinner
        boardElement.classList.remove('ai-thinking');
    }
}

// --- AI Promotion Handler --- 
// Simplified version of makeMove for AI promotion (always Queen)
function handleAIPromotion(fromRow, fromCol, toRow, toCol, chosenPieceType) {
     console.log(`UI: Handling AI promotion to ${chosenPieceType}`);
     const piece = getPieceAt(fromRow, fromCol); 
     const capturedPiece = getPieceAt(toRow, toCol); // May be null
     const promotionPiece = currentPlayer === 'w' ? chosenPieceType.toUpperCase() : chosenPieceType.toLowerCase(); // AI's color

     if (!piece || piece.toUpperCase() !== 'P') {
          console.error("AI Promotion Error: Invalid piece for promotion.", {fromRow, fromCol, piece});
           isAIThinking = false; // Reset flag on error
           updateStatusDisplay(); // Update status to remove spinner
          return;
     }

     const prevStateInfo = {
         currentPlayer: currentPlayer, // AI is making the move
         castlingRights: JSON.parse(JSON.stringify(castlingRights)),
         enPassantTarget: enPassantTarget ? {...enPassantTarget} : null,
         halfmoveClock: halfmoveClock,
         fullmoveNumber: fullmoveNumber
     };

     let baseMoveNotation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedPiece, false, false); // No EP/Castle
     const finalMoveNotation = baseMoveNotation + "=" + chosenPieceType.toUpperCase(); // Standard notation uses uppercase

     // --- Execute Promotion Logically --- 
     setPieceAt(toRow, toCol, promotionPiece); // Place promoted piece
     setPieceAt(fromRow, fromCol, null);      // Remove original pawn

     // --- Animation (Skip complex animation for AI promo) ---
     // Rely on finishMoveProcessing -> renderBoard for visual update.

     // --- Finish Move Processing --- 
     finishMoveProcessing(prevStateInfo, piece, capturedPiece, fromRow, fromCol, toRow, toCol, 'promotion', finalMoveNotation);
     
     // isAIThinking will be set to false inside finishMoveProcessing if it triggers the next player's turn correctly.
}

// --- Animation Functions ---
function animatePieceMovement(pieceElement, targetSquareElement, toRow, toCol, onComplete) {
    if (!pieceElement || !targetSquareElement) {
        console.warn("UI Animation: Target elements missing for move.", {pieceElement, targetSquareElement});
        if (onComplete) onComplete();
        return;
    }

    // Calculate visual destination based on logical coords and player color
    const r_visual = playerColor === 'w' ? toRow : BOARD_SIZE - 1 - toRow;
    const c_visual = playerColor === 'w' ? toCol : BOARD_SIZE - 1 - toCol;

    const targetLeft = `${c_visual * 100 / BOARD_SIZE}%`;
    const targetTop = `${r_visual * 100 / BOARD_SIZE}%`;

    // Ensure the piece is visually on top during animation
    pieceElement.style.zIndex = '100'; 

    gsap.to(pieceElement, {
        left: targetLeft,
        top: targetTop,
        duration: 0.35,
        ease: "power2.out",
        onComplete: () => {
            // Update data attributes AFTER animation
            pieceElement.dataset.row = toRow;
            pieceElement.dataset.col = toCol;
             // Reset z-index after animation
             pieceElement.style.zIndex = '10'; 
            if (onComplete) {
                onComplete();
            }
        }
    });
}

function animateAndRemovePiece(row, col, pieceType, isEnPassant = false, onComplete, attackerRow, attackerCol) {
    const pieceElement = getPieceElement(row, col); // Find piece at logical capture square
    if (pieceElement) {
        // Try to get attacker piece type for 3D animation context
        let attackerPiece = null;
        if (selectedSquare) { // If human move
            attackerPiece = getPieceAt(selectedSquare.row, selectedSquare.col);
        } else if (attackerRow !== undefined && attackerCol !== undefined) { // If AI move
            attackerPiece = getPieceAt(attackerRow, attackerCol);
        }
        
        if (attackerPiece && !isEnPassant) { // Use 3D animation if attacker found and not EP
            console.log("UI: Triggering 3D capture animation (placeholder).");
            animateCapture3D(attackerPiece, pieceType, () => {
                if (document.body.contains(pieceElement)) pieceElement.remove();
                if (onComplete) onComplete();
            });
            return; // Use 3D animation
        } else if (!isEnPassant) {
            console.warn("UI: Could not determine attacker for 3D animation or it was En Passant, using fade.");
        }

        // Fallback: Simple fade out (also used for En Passant)
        console.log("UI: Using fade out animation for captured piece.");
        pieceElement.style.transition = 'opacity 0.3s ease-out';
        pieceElement.style.opacity = '0';
        setTimeout(() => {
            // Double check element exists before removing
            if (document.body.contains(pieceElement)) {
                pieceElement.remove();
            }
            if (onComplete) onComplete();
        }, 300); // Duration matches transition

    } else {
        console.warn(`UI Capture Animation: Piece element not found at target (${row}, ${col})`);
        if (onComplete) onComplete(); // Ensure callback happens even if piece missing
    }
}

// --- Sound Control ---
function playSound(audioElement) {
    if (soundEnabled && audioElement) {
        audioElement.currentTime = 0; // Rewind to start
        audioElement.play().catch(e => console.warn("Sound play failed:", e)); // Be less noisy on errors
    }
}
function toggleMute() {
    soundEnabled = !soundEnabled;
    muteButton.textContent = soundEnabled ? "Mute Sounds" : "Unmute Sounds";
    console.log("UI: Sound enabled:", soundEnabled);
}

// --- UI Update Functions ---
function updateStatusDisplay() {
    let baseStatusText = "";
    if (isGameOver) {
        baseStatusText = gameStatusMessage;
    } else {
        baseStatusText = gameStatusMessage || `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`;
        if (isAIThinking && isAIMode()) {
             baseStatusText = `AI (ELO: ${aiElo}) is thinking...`;
        }
    }
    // Always set text content at the end
    statusMessageElement.textContent = baseStatusText;

    turnIndicator.textContent = isGameOver ? "Game Over" : `Turn: ${currentPlayer === 'w' ? 'White' : 'Black'}`;

    // Enable/disable board interaction
    const isHumanTurn = !isGameOver && !isAIThinking &&
                        (gameMode === 'human-human' || (gameMode === 'ai-human' && currentPlayer === playerColor));
    boardElement.style.pointerEvents = isHumanTurn ? 'auto' : 'none';
    boardElement.style.opacity = isHumanTurn ? '1' : '0.7'; // Dim board when not interactive

    // Add/Remove thinking class for visual feedback (e.g., spinner)
    if (isAIThinking && isAIMode()) {
        boardElement.classList.add('ai-thinking');
    } else {
        boardElement.classList.remove('ai-thinking');
    }

    // Update button states
    hintButton.disabled = isGameOver || isAIThinking || gameMode !== 'ai-human' || currentPlayer !== playerColor;
    undoButton.disabled = isAIThinking || currentMoveIndex < 1 || gameMode === 'ai-ai';
    redoButton.disabled = isAIThinking || currentMoveIndex >= gameHistory.length - 1 || gameMode === 'ai-ai';
    switchColorsButton.disabled = isAIThinking || gameMode === 'ai-ai';

    // *** REVERTED: Disable controls when AI is thinking or not human turn ***
    gameModeSelect.disabled = !isHumanTurn && gameMode !== 'human-human'; // Disable if not human turn (except in HvsH)
    aiEloSlider.disabled = !isHumanTurn || gameMode === 'human-human'; // Disable if not human turn or in HvsH
    newGameButton.disabled = isAIThinking; // Disable New Game only when AI is actively thinking
    // *** END REVERTED ***

    updateGameModeDisplay(); // Ensure mode display is current
}

// --- Game History & Navigation ---
function updateMoveHistoryDisplay() {
    moveHistoryElement.innerHTML = ''; // Clear previous history
    let currentPairDiv = null;

    // Start from index 1 (after initial state) up to the current state
    for (let i = 1; i <= currentMoveIndex; i++) { 
        const state = gameHistory[i]; // The state *after* the move was made
        const prevState = gameHistory[i-1]; // The state *before* the move was made
        
        // Ensure move notation exists for this state transition
        if (!state || !state.moveNotation) continue; 

        const moveNum = state.moveNumber; 
        const playerWhoMadeMove = prevState.currentPlayer; // Player who made the move leading to state i
        const isCurrentDisplayPosition = (i === currentMoveIndex);

        // Start a new row for White's move
        if (playerWhoMadeMove === 'w') {
             currentPairDiv = document.createElement('div');
             currentPairDiv.className = 'move-pair';
             moveHistoryElement.appendChild(currentPairDiv);
             
             const moveNumSpan = document.createElement('span');
             moveNumSpan.className = 'move-number';
             moveNumSpan.textContent = `${moveNum}.`;
             currentPairDiv.appendChild(moveNumSpan);
        }
        
        // Ensure pair div exists (should normally exist if starting with white)
        if (!currentPairDiv && i > 0) {
            // This might happen if history somehow starts with black move or gets corrupted
            console.warn("Move history rendering issue: Pair div missing for move index", i);
            currentPairDiv = document.createElement('div'); // Create defensively
            currentPairDiv.className = 'move-pair';
            moveHistoryElement.appendChild(currentPairDiv);
            // Add placeholder for missing white move? Or just log?
        }

        if (currentPairDiv) {
            const moveSpan = document.createElement('span');
            moveSpan.className = `move-text ${playerWhoMadeMove}-move`;
            if (isCurrentDisplayPosition) {
                moveSpan.classList.add('current-move');
            }
            moveSpan.textContent = state.moveNotation;
            
            // Add click handler for move navigation
            moveSpan.dataset.historyIndex = i; // Store index for click handler
            moveSpan.addEventListener('click', (e) => {
                if (!isAIThinking) {
                    const targetIdx = parseInt(e.target.dataset.historyIndex, 10);
                    if (!isNaN(targetIdx)) {
                        navigateToHistoryState(targetIdx);
                    }
                }
            });
            
            currentPairDiv.appendChild(moveSpan);
        }

        // Reset pair div after Black's move (or if white didn't create one)
        if (playerWhoMadeMove === 'b') {
            currentPairDiv = null; 
        }
    }
    
    // Scroll to the bottom
    moveHistoryElement.scrollTop = moveHistoryElement.scrollHeight;
}

function updateHistoryButtons() {
    undoButton.disabled = isAIThinking || currentMoveIndex < 1;
    redoButton.disabled = isAIThinking || currentMoveIndex >= gameHistory.length - 1;
}

// Renamed from restoreGameState to avoid conflict/confusion
function navigateToHistoryState(targetIndex) {
    if (targetIndex < 0 || targetIndex >= gameHistory.length) {
        console.error("UI Error: Invalid game state index for navigation:", targetIndex);
        return;
    }
    
    console.log(`UI: Navigating to history index: ${targetIndex}`);
    const stateToRestore = gameHistory[targetIndex];
    currentMoveIndex = targetIndex; // Update current index tracker
    
    // --- Restore Core Game Logic State --- 
    // Create deep copies when restoring to prevent mutations
    board = stateToRestore.board.map(row => [...row]); 
    currentPlayer = stateToRestore.currentPlayer;
    castlingRights = JSON.parse(JSON.stringify(stateToRestore.castlingRights));
    enPassantTarget = stateToRestore.enPassantTarget ? {...stateToRestore.enPassantTarget} : null;
    halfmoveClock = stateToRestore.halfmoveClock;
    fullmoveNumber = stateToRestore.fullmoveNumber;
    gameStatusMessage = stateToRestore.statusMessage || `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`; // Restore status message
    isGameOver = false; // When navigating history, game is no longer considered over
     isAIThinking = false; // Ensure AI thinking flag is off

    // --- Update UI --- 
    clearSelectionAndHighlights();
    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay(); // Highlight the correct move
    updateHistoryButtons();
    
    // Check if AI needs to move from this restored state
    checkAndTriggerAIMove(); 
}

function handleUndo() {
    if (isAIThinking || currentMoveIndex < 1) return;

    // Determine how many steps to undo
    let steps = 1;
    // If AI is enabled and the move *before* the current one was made by the AI,
    // undo two steps (AI move + Player move) to get back to the player's previous turn.
     if (isAIMode() && currentMoveIndex >= 2) {
         const playerWhoMadePrevMove = gameHistory[currentMoveIndex - 1]?.currentPlayer; // Player before the *previous* state
         if (playerWhoMadePrevMove !== playerColor) { // If the player who made the move leading to state N-1 was the AI
             steps = 2;
         }
     }
    
    const targetIndex = Math.max(0, currentMoveIndex - steps);
    console.log(`UI: Undoing ${steps} step(s) to index ${targetIndex}`);
    navigateToHistoryState(targetIndex);
}

function handleRedo() {
    if (isAIThinking || currentMoveIndex >= gameHistory.length - 1) return;

     // Determine how many steps to redo
     let steps = 1;
      // If AI is enabled and the player whose turn it is *now* is the AI,
      // redo two steps (Player move + AI move) to get to the next player turn.
     if (isAIMode() && currentMoveIndex < gameHistory.length - 2) { // Ensure there are at least 2 moves ahead
          const playerWhoseTurnIsNext = gameHistory[currentMoveIndex + 1]?.currentPlayer;
          if (playerWhoseTurnIsNext !== playerColor) { // If the turn after the next state belongs to the AI
               steps = 2;
          }
     }
     // Ensure we don't go past the end of history
     steps = Math.min(steps, gameHistory.length - 1 - currentMoveIndex);

    const targetIndex = currentMoveIndex + steps;
     console.log(`UI: Redoing ${steps} step(s) to index ${targetIndex}`);
    navigateToHistoryState(targetIndex);
}

// --- Hint System ---
function handleHint() {
    if (isGameOver || isAIThinking || gameMode === 'ai-ai' ) return; // Also disable hints in AI vs AI

    // Determine whose turn it *should* be for the hint
    // In Human vs Human, hint for current player
    // In AI vs Human, hint *only* for the human player
    let playerToHintFor = currentPlayer;
    if (gameMode === 'ai-human' && currentPlayer !== playerColor) {
        console.log("UI: Hint requested, but it's AI's turn.");
        statusMessageElement.textContent = "Hint available only on your turn.";
        // Temporarily show message, then revert
        setTimeout(() => { updateStatusDisplay(); }, 2000);
        return;
    } 

    console.log("UI: Generating hint for player:", playerToHintFor);
    // Show thinking message directly
    statusMessageElement.textContent = "Thinking of a hint...";
    hintButton.disabled = true; // Disable while thinking

    // Use setTimeout to allow UI update before calculation
    setTimeout(() => {
        let hintMove = null;
        try {
            // Calculate the best move using the MAXIMUM ELO setting
            const maxElo = parseInt(aiEloSlider.max, 10) || 2500; // Read max from slider or use default max
            console.log(`UI: Calculating hint using AI ELO: ${maxElo}`);
            // Ensure the context for calculateBestMove has the correct player
            const originalPlayerForHint = currentPlayer; // Store original
            currentPlayer = playerToHintFor; // Set context for the calculation
            
            hintMove = calculateBestMove(maxElo); // Use max ELO
            
            currentPlayer = originalPlayerForHint; // Restore original player context

        } catch (error) {
             console.error("Error generating hint:", error);
             statusMessageElement.textContent = "Error generating hint."; // Show error (no spinner)
             updateStatusDisplay(); // Re-enable hint button potentially
             return;
        }

        // Update status AFTER calculation is done 
        if (hintMove && hintMove.from && hintMove.to) {
            console.log("UI Hint:", hintMove);
            clearSelectionAndHighlights(); // Clear previous highlights

            const fromSq = getSquareElement(hintMove.from.row, hintMove.from.col);
            const toSq = getSquareElement(hintMove.to.row, hintMove.to.col);
            
            if (fromSq && toSq) {
                 // Use distinct classes for hint highlighting
                 fromSq.classList.add('hint-from'); 
                 const isCaptureHint = getPieceAt(hintMove.to.row, hintMove.to.col) !== null || hintMove.isEnPassant;
                 toSq.classList.add('hint-to');
                 toSq.classList.add(isCaptureHint ? 'capture-move' : 'legal-move'); // Reuse existing styles

                // Convert logical coords to algebraic for message
                 const fromAlg = String.fromCharCode('a'.charCodeAt(0) + hintMove.from.col) + (BOARD_SIZE - hintMove.from.row);
                 const toAlg = String.fromCharCode('a'.charCodeAt(0) + hintMove.to.col) + (BOARD_SIZE - hintMove.to.row);
                 const pieceToMove = getPieceAt(hintMove.from.row, hintMove.from.col); // Get piece from logical board
                 const pieceSymbol = pieceToMove ? PIECES[pieceToMove] : ''; // Get symbol
                 statusMessageElement.textContent = `Hint: Try ${pieceSymbol} from ${fromAlg} to ${toAlg}.`;

                // Remove hint highlight after a delay
                setTimeout(() => {
                    // Check if classes are still present before removing
                     if (fromSq.classList.contains('hint-from')) fromSq.classList.remove('hint-from');
                     if (toSq.classList.contains('hint-to')) {
                          toSq.classList.remove('hint-to', 'legal-move', 'capture-move');
                     }
                      // Restore status message if it hasn't changed
                      if (statusMessageElement.textContent.startsWith("Hint:")) {
                           gameStatusMessage = `${currentPlayer === 'w' ? 'White' : 'Black'}'s turn.`; // Reset based on current turn
                           updateStatusDisplay();
                      }
                }, 3000); // Show hint for 3 seconds
            } else {
                 console.warn("UI Hint Error: Could not find square elements for hint.");
                 statusMessageElement.textContent = "Could not display hint.";
                 updateStatusDisplay();
            }
        } else {
            statusMessageElement.textContent = "No good move found for hint.";
            console.log("UI: No hint generated or invalid hint move.");
             updateStatusDisplay(); // Update buttons and potentially revert status text after delay
        }
         updateStatusDisplay(); // Update buttons and revert status text after delay

    }, 30); // Short delay for UI
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    console.log("Setting up event listeners...");
    newGameButton.addEventListener('click', initGame);
    undoButton.addEventListener('click', handleUndo);
    redoButton.addEventListener('click', handleRedo);
    hintButton.addEventListener('click', handleHint);
    switchColorsButton.addEventListener('click', () => {
        // *** ADDED: Interrupt AI on color switch ***
        if (aiThinkingTimeoutId) clearTimeout(aiThinkingTimeoutId);
        isAIThinking = false;
        boardElement.classList.remove('ai-thinking');
        updateStatusDisplay(); // << Add immediate UI update
        // *** END ADDED ***
        playerColor = (playerColor === 'w') ? 'b' : 'w';
        updatePlayerColorIndicator();
        createBoardDOM();
        renderBoard();
        checkAndTriggerAIMove();
    });
    muteButton.addEventListener('click', toggleMute);

    // ADD new listeners with immediate interruption
    gameModeSelect.addEventListener('change', () => {
        console.log("Game mode changed via UI.");
        // *** Interrupt AI Immediately ***
        if (aiThinkingTimeoutId) {
            clearTimeout(aiThinkingTimeoutId);
            aiThinkingTimeoutId = null;
            console.log("Cleared pending AI move timeout (Game Mode Change).");
        }
        if (isAIThinking) {
            isAIThinking = false;
            boardElement.classList.remove('ai-thinking');
            console.log("Reset isAIThinking flag (Game Mode Change).");
            updateStatusDisplay(); // << Add immediate UI update
        }
        // *** Now update settings ***
        updateGameSettingsFromUI(); // This still handles subsequent logic
    });
    aiEloSlider.addEventListener('input', () => {
         // Update display value live
         aiEloValueSpan.textContent = aiEloSlider.value;
         // We don't need to interrupt calculation on every *input* event,
         // only when the value is *finalized* (on 'change').
         // However, the current setup calls updateGameSettingsFromUI on input,
         // let's modify to interrupt on input as well for consistency,
         // though 'change' event might be better UX.
        console.log("ELO slider input detected.");
        // *** Interrupt AI Immediately ***
        if (aiThinkingTimeoutId) {
            clearTimeout(aiThinkingTimeoutId);
            aiThinkingTimeoutId = null;
             console.log("Cleared pending AI move timeout (ELO Slider Input).");
        }
        if (isAIThinking) {
            isAIThinking = false;
            boardElement.classList.remove('ai-thinking');
            console.log("Reset isAIThinking flag (ELO Slider Input).");
            updateStatusDisplay(); // << Add immediate UI update
        }
        // *** Now update settings ***
        updateGameSettingsFromUI(); // This still handles subsequent logic
    });

    // Ensure initial UI state is correct based on default HTML values
    updateGameSettingsFromUI();
    updatePlayerColorIndicator();

    console.log("Event listeners setup complete.");
}

// --- Initialization on Load ---
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded.");
    setupEventListeners(); // Setup listeners first
    initGame();            // Then initialize the game state and board
     init3DAnimation(); // Initialize 3D placeholder if needed
});

// --- END OF FILE ui.js --- 