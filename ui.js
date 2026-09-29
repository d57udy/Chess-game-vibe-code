// --- START OF FILE ui.js ---
// UI layer: board rendering, input handling, animations, history review and AI orchestration.
// Game rules and state globals live in gameLogic.js; AI moves come from aiClient.js (requestAIMove).

// --- UI State Variables ---
let selectedSquare = null; // { row, col } (logical coordinates)
let legalMovesForSelection = [];
let gameMode = 'ai-human'; // 'ai-ai', 'ai-human', 'human-human'
let aiElo = 1200;
let playerColor = 'w'; // Human color in ai-human mode; also sets board orientation
let soundEnabled = true;

let isAIThinking = false;   // An AI move is scheduled or being computed
let aiRequest = null;       // { promise, cancel } handle of the in-flight AI move request
let aiDelayTimeoutId = null;
let hintRequest = null;     // { promise, cancel } handle of the in-flight hint request
let hintMessage = null;     // Transient status text for a shown hint
let hintTimeoutId = null;

let isAnimating = false;       // A move is being executed/animated; input is locked until it finishes
let pendingPromotion = null;   // { fromRow, fromCol, toRow, toCol } while the promotion dialog is open
let isReviewing = false;       // Browsing history; the AI does not move until the user resumes
let lastMove = null;           // { from: {row, col}, to: {row, col} } of the move leading to the shown position
let positionVersion = 0;       // Bumped whenever the shown position changes; async work compares against it

// --- DOM Elements ---
const boardElement = document.getElementById('chess-board');
const turnIndicator = document.getElementById('turn-indicator');
const statusMessageElement = document.getElementById('status-message');
const difficultyLabel = document.getElementById('difficulty-label');
const gameModeSelect = document.getElementById('game-mode-select');
const aiSettingsDiv = document.getElementById('ai-settings');
const aiEloSlider = document.getElementById('ai-elo-slider');
const aiEloValueSpan = document.getElementById('ai-elo-value');
const playerColorIndicator = document.getElementById('player-color-indicator');
const switchColorsButton = document.getElementById('switch-colors-button');
const humanPlayerSettingsDiv = document.getElementById('human-player-settings');
const newGameButton = document.getElementById('new-game-button');
const undoButton = document.getElementById('undo-button');
const redoButton = document.getElementById('redo-button');
const hintButton = document.getElementById('hint-button');
const muteButton = document.getElementById('mute-button');
const moveHistoryElement = document.getElementById('move-history');
const reviewBar = document.getElementById('review-bar');
const reviewLabel = document.getElementById('review-label');
const resumeButton = document.getElementById('resume-button');
const liveButton = document.getElementById('live-button');
const promotionModal = document.getElementById('promotion-modal');
const promotionPieceButtons = promotionModal.querySelectorAll('button[data-piece]');
const promotionCancelButton = document.getElementById('promotion-cancel');

// --- Audio Elements ---
const sounds = {
    move: new Audio('move.mp3'),
    capture: new Audio('capture.mp3'),
    check: new Audio('check.mp3'),
    gameOver: new Audio('game-over.mp3')
};
Object.values(sounds).forEach(sound => sound.preload = 'auto');

const MOVE_ANIMATION_SECONDS = 0.35;
const HINT_TIME_MS = 1500;
const HINT_DISPLAY_MS = 3000;

function uiLog(...args) {
    if (typeof debugLog === 'function') debugLog(...args);
}

function sideName(player) {
    return player === 'w' ? 'White' : 'Black';
}

function squareName(row, col) {
    return String.fromCharCode('a'.charCodeAt(0) + col) + (BOARD_SIZE - row);
}

// --- Mode helpers ---
function isAIMode() {
    return gameMode === 'ai-human' || gameMode === 'ai-ai';
}

function isHumanTurn() {
    return gameMode === 'human-human' || (gameMode === 'ai-human' && currentPlayer === playerColor);
}

function isAITurn() {
    return gameMode === 'ai-ai' || (gameMode === 'ai-human' && currentPlayer !== playerColor);
}

// True while a move is animating or waiting for a promotion choice
function isInputLocked() {
    return isAnimating || pendingPromotion !== null;
}

// --- Game Initialization ---
function initGame() {
    uiLog("UI: Initializing game...");
    abortInFlightWork();
    isReviewing = false;
    lastMove = null;
    clearSelectionAndHighlights();
    gameHistory = [];
    currentMoveIndex = -1;

    if (!parseFen(INITIAL_BOARD_FEN)) {
        console.error("Failed to parse initial FEN. Cannot start game.");
        statusMessageElement.textContent = "Error: Could not load initial position.";
        return;
    }

    createBoardDOM();
    pushHistoryState({ truncate: false }); // Initial position, no move info
    evaluateGameState();
    gameHistory[currentMoveIndex].statusMessage = gameStatusMessage;

    renderBoard();
    updatePlayerColorIndicator();
    updateGameModeDisplay();
    updateStatusDisplay();
    updateMoveHistoryDisplay();

    checkAndTriggerAIMove(); // AI opens if it plays White
    uiLog(`UI: Game initialized. Mode: ${gameMode}, ELO: ${aiElo}, Current player: ${currentPlayer}`);
}

// Cancels AI/hint work, stops running animations and closes the promotion dialog.
// Invalidates every pending async callback via positionVersion.
function abortInFlightWork() {
    cancelAIRequest();
    cancelHint();
    cancelCaptureAnimations();
    positionVersion++;
    if (typeof gsap !== 'undefined') {
        gsap.killTweensOf(boardElement.querySelectorAll('.piece'));
    }
    isAnimating = false;
    closePromotionDialog();
}

// --- Display for game mode and player color ---
function updateGameModeDisplay() {
    let modeText = "Mode: Human vs Human";
    if (gameMode === 'ai-human') {
        modeText = "Mode: AI vs Human";
        aiSettingsDiv.style.display = 'block';
        playerColorIndicator.style.display = 'block';
    } else if (gameMode === 'ai-ai') {
        modeText = `Mode: AI vs AI (ELO: ${aiElo})`;
        aiSettingsDiv.style.display = 'block';
        playerColorIndicator.style.display = 'none';
    } else {
        aiSettingsDiv.style.display = 'none';
        playerColorIndicator.style.display = 'block';
    }
    humanPlayerSettingsDiv.style.display = 'block';
    difficultyLabel.textContent = modeText;
}

function updatePlayerColorIndicator() {
    playerColorIndicator.textContent = `Playing as: ${sideName(playerColor)}`;
    playerColorIndicator.className = playerColor === 'w' ? 'white' : 'black';
    switchColorsButton.textContent = `Play as ${playerColor === 'w' ? 'Black' : 'White'}`;
}

// --- Board geometry ---
// The board is oriented by mapping coordinates (no CSS rotation): with White at the bottom,
// visual (row, col) equals logical (row, col); with Black at the bottom both axes are mirrored.
function toVisual(row, col) {
    return playerColor === 'w'
        ? { row, col }
        : { row: BOARD_SIZE - 1 - row, col: BOARD_SIZE - 1 - col };
}

function visualPosition(row, col) {
    const v = toVisual(row, col);
    return { left: `${v.col * 100 / BOARD_SIZE}%`, top: `${v.row * 100 / BOARD_SIZE}%` };
}

// --- Board DOM Creation ---
function createBoardDOM() {
    boardElement.innerHTML = '';
    for (let rVisual = 0; rVisual < BOARD_SIZE; rVisual++) {
        for (let cVisual = 0; cVisual < BOARD_SIZE; cVisual++) {
            const rLogical = playerColor === 'w' ? rVisual : BOARD_SIZE - 1 - rVisual;
            const cLogical = playerColor === 'w' ? cVisual : BOARD_SIZE - 1 - cVisual;

            const square = document.createElement('div');
            square.classList.add('square', (rLogical + cLogical) % 2 === 0 ? 'light' : 'dark');
            square.dataset.row = rLogical;
            square.dataset.col = cLogical;

            const coordLabel = document.createElement('span');
            coordLabel.classList.add('coordinate-label');
            coordLabel.textContent = squareName(rLogical, cLogical);
            square.appendChild(coordLabel);

            boardElement.appendChild(square);
        }
    }
}

// --- Board Rendering (Pieces and highlights) ---
function renderBoard() {
    boardElement.querySelectorAll('.piece').forEach(p => p.remove());
    boardElement.querySelectorAll('.square.in-check, .square.last-move')
        .forEach(sq => sq.classList.remove('in-check', 'last-move'));

    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const piece = getPieceAt(r, c);
            if (!piece) continue;

            const pieceElement = document.createElement('div');
            pieceElement.classList.add('piece');
            pieceElement.textContent = PIECES[piece];
            pieceElement.dataset.piece = piece;
            pieceElement.dataset.row = r;
            pieceElement.dataset.col = c;
            const pos = visualPosition(r, c);
            pieceElement.style.left = pos.left;
            pieceElement.style.top = pos.top;
            boardElement.appendChild(pieceElement);
        }
    }

    const kingPos = findKing(currentPlayer);
    if (kingPos && isKingInCheck(currentPlayer)) {
        getSquareElement(kingPos.row, kingPos.col)?.classList.add('in-check');
    }
    if (lastMove) {
        getSquareElement(lastMove.from.row, lastMove.from.col)?.classList.add('last-move');
        getSquareElement(lastMove.to.row, lastMove.to.col)?.classList.add('last-move');
    }

    highlightSelectedSquare();
    highlightLegalMoves();
}

// --- UI Element Getters (logical coordinates) ---
function getSquareElement(row, col) {
    return boardElement.querySelector(`.square[data-row="${row}"][data-col="${col}"]`);
}

function getPieceElement(row, col) {
    return boardElement.querySelector(`.piece[data-row="${row}"][data-col="${col}"]`);
}

// --- Event Handling ---
// Single delegated listener: pieces and squares both carry logical data-row/data-col
function handleBoardClick(event) {
    const target = event.target.closest('.piece, .square');
    if (!target || !boardElement.contains(target)) return;
    handleSquareClick(parseInt(target.dataset.row, 10), parseInt(target.dataset.col, 10));
}

function handleSquareClick(row, col) {
    if (isInputLocked() || isGameOver || isAIThinking) return;
    if (!isHumanTurn()) {
        uiLog("UI: Not the human player's turn.");
        return;
    }

    const clickedPiece = getPieceAt(row, col);

    if (selectedSquare) {
        const move = legalMovesForSelection.find(m => m.row === row && m.col === col);
        if (move) {
            const from = selectedSquare;
            clearSelectionAndHighlights();
            makeMove(from.row, from.col, row, col);
            return;
        }
        clearSelectionAndHighlights();
    }
    if (clickedPiece && isPlayerPiece(clickedPiece, currentPlayer)) {
        selectPiece(row, col);
    }
}

function selectPiece(row, col) {
    const piece = getPieceAt(row, col);
    if (!piece || getPlayerForPiece(piece) !== currentPlayer) return;

    selectedSquare = { row, col };
    legalMovesForSelection = generateLegalMoves(row, col);
    highlightSelectedSquare();
    highlightLegalMoves();
}

// --- Highlighting Functions ---
function clearSelectionAndHighlights() {
    selectedSquare = null;
    legalMovesForSelection = [];
    boardElement.querySelectorAll('.square.selected, .square.legal-move, .square.capture-move')
        .forEach(sq => sq.classList.remove('selected', 'legal-move', 'capture-move'));
    clearHintHighlights();
}

function clearHintHighlights() {
    boardElement.querySelectorAll('.square.hint-from, .square.hint-to')
        .forEach(sq => sq.classList.remove('hint-from', 'hint-to'));
}

function highlightSelectedSquare() {
    boardElement.querySelectorAll('.square.selected').forEach(sq => sq.classList.remove('selected'));
    if (selectedSquare) {
        getSquareElement(selectedSquare.row, selectedSquare.col)?.classList.add('selected');
    }
}

function highlightLegalMoves() {
    boardElement.querySelectorAll('.square.legal-move, .square.capture-move')
        .forEach(sq => sq.classList.remove('legal-move', 'capture-move'));
    legalMovesForSelection.forEach(move => {
        const isCapture = getPieceAt(move.row, move.col) !== null || move.isEnPassant;
        getSquareElement(move.row, move.col)?.classList.add(isCapture ? 'capture-move' : 'legal-move');
    });
}

// --- Move Execution ---
// Validates and executes a move for the current player: updates the logical board immediately,
// locks input, animates, then finishMoveProcessing switches the turn and records history.
// promotionChoice ('Q'|'R'|'B'|'N') is required for promotions; without it the dialog opens.
function makeMove(fromRow, fromCol, toRow, toCol, promotionChoice = null) {
    if (isAnimating) return false;
    const piece = getPieceAt(fromRow, fromCol);
    if (!piece) {
        console.error("UI Error: Attempted to move from an empty square!", { fromRow, fromCol });
        return false;
    }
    const legalMove = generateLegalMoves(fromRow, fromCol).find(m => m.row === toRow && m.col === toCol);
    if (!legalMove) {
        console.error("UI Error: Illegal move rejected.", { fromRow, fromCol, toRow, toCol, piece });
        return false;
    }
    if (legalMove.isPromotion && !promotionChoice) {
        showPromotionDialog(fromRow, fromCol, toRow, toCol);
        return false;
    }

    // Gather everything that depends on the pre-move position before mutating the board
    const capturedOnTarget = getPieceAt(toRow, toCol);
    const isCastling = piece.toUpperCase() === 'K' && Math.abs(toCol - fromCol) === 2;
    const isEnPassant = piece.toUpperCase() === 'P' && toCol !== fromCol && !capturedOnTarget &&
        enPassantTarget !== null && toRow === enPassantTarget.row && toCol === enPassantTarget.col;
    // An en passant victim stands beside the attacker, on the attacker's starting rank
    const victimRow = isEnPassant ? fromRow : toRow;
    const victimPiece = isEnPassant ? getPieceAt(fromRow, toCol) : capturedOnTarget;
    const promotionType = legalMove.isPromotion ? promotionChoice.toUpperCase() : null;
    const placedPiece = promotionType
        ? (currentPlayer === 'w' ? promotionType : promotionType.toLowerCase())
        : piece;

    let notation = getAlgebraicNotation(fromRow, fromCol, toRow, toCol, piece, capturedOnTarget, isEnPassant, isCastling);
    if (promotionType) notation += '=' + promotionType;

    const prevStateInfo = {
        currentPlayer,
        castlingRights: JSON.parse(JSON.stringify(castlingRights)),
        enPassantTarget: enPassantTarget ? { ...enPassantTarget } : null,
        halfmoveClock,
        fullmoveNumber
    };

    const movingElement = getPieceElement(fromRow, fromCol);
    const victimSquareElement = victimPiece ? getSquareElement(victimRow, toCol) : null;
    let rookElement = null, rookFromCol = -1, rookToCol = -1;
    if (isCastling) {
        rookFromCol = toCol > fromCol ? BOARD_SIZE - 1 : 0;
        rookToCol = toCol > fromCol ? toCol - 1 : toCol + 1;
        rookElement = getPieceElement(fromRow, rookFromCol);
    }

    // Lock input and apply the move to the logical board
    isAnimating = true;
    const version = ++positionVersion;
    cancelHint();
    clearSelectionAndHighlights();

    if (isEnPassant) setPieceAt(fromRow, toCol, null);
    if (isCastling) {
        setPieceAt(fromRow, rookToCol, getPieceAt(fromRow, rookFromCol));
        setPieceAt(fromRow, rookFromCol, null);
    }
    setPieceAt(toRow, toCol, placedPiece);
    setPieceAt(fromRow, fromCol, null);
    updateStatusDisplay();

    const moveInfo = { prevStateInfo, piece, capturedPiece: victimPiece, fromRow, fromCol, toRow, toCol, notation, captureSoundPlayed: false };
    let capturePhase = Promise.resolve(false);
    if (victimPiece) {
        const outcome = previewCheckAfterMove(piece, fromRow, toRow, fromCol);
        const ctx = {
            enPassant: isEnPassant,
            promotionTo: promotionType,
            givesCheck: outcome.givesCheck,
            isMate: outcome.isMate,
            isAI: isAITurn()
        };
        capturePhase = playCaptureAnimation(piece, victimPiece, victimSquareElement, ctx);
    }

    capturePhase
        .then(soundPlayed => {
            if (version !== positionVersion) return;
            moveInfo.captureSoundPlayed = soundPlayed === true;
            return Promise.all([
                animatePieceTo(movingElement, toRow, toCol),
                isCastling ? animatePieceTo(rookElement, fromRow, rookToCol) : null
            ]);
        })
        .catch(error => console.error("UI: Move animation failed:", error))
        .then(() => {
            if (version !== positionVersion) return; // Aborted by new game / navigation
            finishMoveProcessing(moveInfo);
        });
    return true;
}

// --- Promotion Handling ---
function showPromotionDialog(fromRow, fromCol, toRow, toCol) {
    pendingPromotion = { fromRow, fromCol, toRow, toCol };
    const isWhite = currentPlayer === 'w';
    promotionPieceButtons.forEach(button => {
        const type = button.dataset.piece;
        button.querySelector('.promo-symbol').textContent = PIECES[isWhite ? type : type.toLowerCase()];
    });
    promotionModal.style.display = 'flex';
    updateStatusDisplay();
    promotionPieceButtons[0]?.focus();
}

function closePromotionDialog() {
    pendingPromotion = null;
    promotionModal.style.display = 'none';
}

function choosePromotion(pieceType) {
    const pending = pendingPromotion;
    if (!pending) return;
    closePromotionDialog();
    makeMove(pending.fromRow, pending.fromCol, pending.toRow, pending.toCol, pieceType);
}

// Nothing has changed on the board yet, so cancelling just closes the dialog
function cancelPromotion() {
    if (!pendingPromotion) return;
    closePromotionDialog();
    clearSelectionAndHighlights();
    updateStatusDisplay();
}

// --- Post-Animation Move Processing ---
// Called after the logical board is updated but before the turn switches: does the move give check / mate?
function previewCheckAfterMove(piece, fromRow, toRow, fromCol) {
    const opponent = getOpponent(currentPlayer);
    const savedEnPassant = enPassantTarget;
    enPassantTarget = (piece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2)
        ? { row: (fromRow + toRow) / 2, col: fromCol }
        : null;
    const givesCheck = isKingInCheck(opponent);
    const isMate = givesCheck && !hasLegalMoves(opponent);
    enPassantTarget = savedEnPassant;
    return { givesCheck, isMate };
}

function finishMoveProcessing({ prevStateInfo, piece, capturedPiece, fromRow, fromCol, toRow, toCol, notation, captureSoundPlayed }) {
    const playerWhoMoved = prevStateInfo.currentPlayer;

    // 1. Castling rights
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
    // A rook captured on its starting square
    if (capturedPiece === 'R' && toRow === 7) {
        if (toCol === 0) castlingRights.w.Q = false;
        if (toCol === 7) castlingRights.w.K = false;
    }
    if (capturedPiece === 'r' && toRow === 0) {
        if (toCol === 0) castlingRights.b.Q = false;
        if (toCol === 7) castlingRights.b.K = false;
    }

    // 2. En passant target
    enPassantTarget = (piece.toUpperCase() === 'P' && Math.abs(toRow - fromRow) === 2)
        ? { row: (fromRow + toRow) / 2, col: fromCol }
        : null;

    // 3. Clocks
    halfmoveClock = (piece.toUpperCase() === 'P' || capturedPiece) ? 0 : halfmoveClock + 1;
    if (playerWhoMoved === 'b') fullmoveNumber++;

    // 4. Switch player and record the new position (truncates any reviewed future moves)
    currentPlayer = getOpponent(playerWhoMoved);
    pushHistoryState({ notation, moveNumber: prevStateInfo.fullmoveNumber });
    const entry = gameHistory[currentMoveIndex];
    entry.lastMove = { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } };

    // 5. Game end / check (the new position is already in history for the repetition count)
    const { isCheck, isCheckmate } = evaluateGameState();
    entry.moveNotation = notation + (isCheckmate ? '#' : isCheck ? '+' : '');
    entry.statusMessage = gameStatusMessage;

    if (isGameOver) playSound(sounds.gameOver);
    else if (isCheck) playSound(sounds.check);
    else if (!capturedPiece) playSound(sounds.move);
    else if (!captureSoundPlayed) playSound(sounds.capture);

    lastMove = entry.lastMove;
    isAnimating = false;
    isReviewing = false;
    positionVersion++;

    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    checkAndTriggerAIMove();
}

// Sets isGameOver and gameStatusMessage for the current position (whose state is at gameHistory[currentMoveIndex])
function evaluateGameState() {
    const endCondition = checkGameEndCondition();
    const isCheck = isKingInCheck(currentPlayer);
    isGameOver = true;
    if (endCondition === 'checkmate') {
        gameStatusMessage = `Checkmate! ${sideName(getOpponent(currentPlayer))} wins.`;
    } else if (endCondition === 'stalemate') {
        gameStatusMessage = "Stalemate! Game is a draw.";
    } else if (halfmoveClock >= 100) {
        gameStatusMessage = "Draw by 50-move rule.";
    } else if (checkThreefoldRepetition()) {
        gameStatusMessage = "Draw by threefold repetition.";
    } else if (hasInsufficientMaterial()) {
        gameStatusMessage = "Draw by insufficient material.";
    } else {
        isGameOver = false;
        gameStatusMessage = isCheck ? `${sideName(currentPlayer)} is in check!` : `${sideName(currentPlayer)}'s turn.`;
    }
    return { isCheck, isCheckmate: endCondition === 'checkmate' };
}

// --- AI Orchestration ---
function checkAndTriggerAIMove() {
    if (isAIThinking || isInputLocked() || isReviewing || isGameOver || !isAITurn()) {
        updateStatusDisplay();
        return;
    }
    const version = positionVersion;
    isAIThinking = true;
    updateStatusDisplay();

    const delay = gameMode === 'ai-ai' ? 500 : 100; // Lets the "thinking" state render first
    aiDelayTimeoutId = setTimeout(() => {
        aiDelayTimeoutId = null;
        startAIRequest(version);
    }, delay);
}

function startAIRequest(version) {
    if (!isAIThinking || version !== positionVersion) return;
    uiLog(`UI: Requesting AI move for ${currentPlayer} (ELO ${aiElo})`);

    let handle;
    try {
        handle = requestAIMove(getCurrentGameStateSnapshot(), aiElo);
    } catch (error) {
        console.error("UI: AI request failed to start:", error);
        isAIThinking = false;
        updateStatusDisplay();
        statusMessageElement.textContent = "AI error: could not compute a move.";
        return;
    }
    aiRequest = handle;

    handle.promise.then(move => {
        if (aiRequest !== handle) return; // Cancelled or superseded
        aiRequest = null;
        isAIThinking = false;
        if (version !== positionVersion) {
            uiLog("UI: Discarding AI move for a stale position.");
            checkAndTriggerAIMove();
            return;
        }
        applyAIMove(move);
    }).catch(error => {
        if (aiRequest !== handle) return;
        aiRequest = null;
        isAIThinking = false;
        console.error("UI: AI move request failed:", error);
        updateStatusDisplay();
        statusMessageElement.textContent = "AI error: could not compute a move.";
    });
}

function applyAIMove(move) {
    if (!move || !move.from || !move.to) {
        if (move) console.error("UI: AI returned a malformed move:", move);
        updateStatusDisplay();
        statusMessageElement.textContent = "AI could not find a move.";
        return;
    }
    uiLog("UI: AI chose move:", move);
    const started = makeMove(move.from.row, move.from.col, move.to.row, move.to.col, move.promotionPiece || 'Q');
    if (!started) {
        updateStatusDisplay();
        statusMessageElement.textContent = "AI error: returned an illegal move.";
    }
}

function cancelAIRequest() {
    if (aiDelayTimeoutId) {
        clearTimeout(aiDelayTimeoutId);
        aiDelayTimeoutId = null;
    }
    if (aiRequest) {
        const handle = aiRequest;
        aiRequest = null;
        handle.cancel();
    }
    isAIThinking = false;
}

// --- Animation ---
function animatePieceTo(pieceElement, row, col) {
    return new Promise(resolve => {
        if (!pieceElement) return resolve();
        const { left, top } = visualPosition(row, col);
        const done = () => {
            pieceElement.dataset.row = row;
            pieceElement.dataset.col = col;
            pieceElement.style.zIndex = '';
            resolve();
        };
        if (typeof gsap === 'undefined') {
            pieceElement.style.left = left;
            pieceElement.style.top = top;
            done();
            return;
        }
        pieceElement.style.zIndex = '100'; // Stay above other pieces while moving
        gsap.to(pieceElement, { left, top, duration: MOVE_ANIMATION_SECONDS, ease: "power2.out", onComplete: done });
    });
}

// Capture animation hook. attackerPiece/victimPiece are piece codes ('N', 'p', ...) and squareEl is
// the square the victim stands on (differs from the destination for en passant).
// ctx = { enPassant, promotionTo, givesCheck, isMate, isAI }.
// Resolves once the victim's piece element is gone: true if the animation already played the capture
// sound (finishMoveProcessing then skips capture.mp3). It must never stall the move flow, so it also
// resolves after a timeout or when the page is hidden. Currently a simple fade that plays no sound.
const CAPTURE_FADE_SECONDS = 0.25;

function playCaptureAnimation(attackerPiece, victimPiece, squareEl, ctx = {}) {
    const victimElement = squareEl ? getPieceElement(squareEl.dataset.row, squareEl.dataset.col) : null;
    return new Promise(resolve => {
        let settled = false;
        let timeoutId = null;
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') finish();
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (victimElement) {
                if (typeof gsap !== 'undefined') gsap.killTweensOf(victimElement);
                victimElement.remove();
            }
            resolve(false);
        };
        if (!victimElement || typeof gsap === 'undefined') return finish();
        timeoutId = setTimeout(finish, CAPTURE_FADE_SECONDS * 1000 + 500);
        document.addEventListener('visibilitychange', onVisibilityChange);
        gsap.to(victimElement, { opacity: 0, duration: CAPTURE_FADE_SECONDS, ease: "power1.out", onComplete: finish });
    });
}

// Stops running capture animations (called on undo/navigation, new game and color flip).
// No-op for the fade; the battle animation system will hook in here.
function cancelCaptureAnimations() {}

// --- Sound Control ---
function playSound(audioElement) {
    if (!soundEnabled || !audioElement) return;
    try {
        audioElement.currentTime = 0;
        const playback = audioElement.play();
        if (playback && playback.catch) playback.catch(e => console.warn("Sound play failed:", e));
    } catch (e) {
        console.warn("Sound play failed:", e);
    }
}

function toggleMute() {
    soundEnabled = !soundEnabled;
    muteButton.textContent = soundEnabled ? "Mute Sounds" : "Unmute Sounds";
}

// --- Status and Controls (single source of truth for all button states) ---
function updateStatusDisplay() {
    const locked = isInputLocked();
    let text;
    if (isGameOver) text = gameStatusMessage;
    else if (isAIThinking) text = `AI (ELO: ${aiElo}) is thinking...`;
    else if (hintRequest) text = "Thinking of a hint...";
    else if (hintMessage) text = hintMessage;
    else text = gameStatusMessage || `${sideName(currentPlayer)}'s turn.`;
    statusMessageElement.textContent = text;
    statusMessageElement.classList.toggle('thinking', !isGameOver && (isAIThinking || hintRequest !== null));
    turnIndicator.textContent = isGameOver ? "Game Over" : `Turn: ${sideName(currentPlayer)}`;

    const canMove = !isGameOver && !isAIThinking && !locked && isHumanTurn();
    boardElement.classList.toggle('interactive', canMove);
    boardElement.classList.toggle('ai-thinking', isAIThinking);

    undoButton.disabled = locked || currentMoveIndex < 1;
    redoButton.disabled = locked || currentMoveIndex >= gameHistory.length - 1;
    hintButton.disabled = locked || isGameOver || isAIThinking || hintRequest !== null || !isHumanTurn();
    switchColorsButton.disabled = locked || gameMode === 'ai-ai';
    gameModeSelect.disabled = pendingPromotion !== null;
    aiEloSlider.disabled = gameMode === 'human-human';

    updateReviewBar();
}

function updateReviewBar() {
    reviewBar.hidden = !isReviewing;
    if (!isReviewing) return;
    const state = gameHistory[currentMoveIndex];
    if (currentMoveIndex === 0 || !state?.moveNotation) {
        reviewLabel.textContent = "Reviewing start position.";
    } else {
        const mover = gameHistory[currentMoveIndex - 1].currentPlayer;
        reviewLabel.textContent = `Reviewing move ${state.moveNumber}${mover === 'w' ? '.' : '...'} ${state.moveNotation}`;
    }
    const locked = isInputLocked();
    resumeButton.disabled = locked || isGameOver;
    liveButton.disabled = locked;
}

// --- Game History & Navigation ---
function updateMoveHistoryDisplay() {
    moveHistoryElement.innerHTML = '';
    let currentPairDiv = null;
    let currentMoveElement = null;

    for (let i = 1; i < gameHistory.length; i++) {
        const state = gameHistory[i];
        if (!state || !state.moveNotation) continue;
        const mover = gameHistory[i - 1].currentPlayer;

        if (mover === 'w' || !currentPairDiv) {
            currentPairDiv = document.createElement('div');
            currentPairDiv.className = 'move-pair';
            moveHistoryElement.appendChild(currentPairDiv);

            const moveNumSpan = document.createElement('span');
            moveNumSpan.className = 'move-number';
            moveNumSpan.textContent = mover === 'w' ? `${state.moveNumber}.` : `${state.moveNumber}...`;
            currentPairDiv.appendChild(moveNumSpan);
        }

        const moveSpan = document.createElement('span');
        moveSpan.className = `move-text ${mover}-move`;
        if (i === currentMoveIndex) {
            moveSpan.classList.add('current-move');
            currentMoveElement = moveSpan;
        } else if (i > currentMoveIndex) {
            moveSpan.classList.add('future-move');
        }
        moveSpan.textContent = state.moveNotation;
        moveSpan.dataset.historyIndex = i;
        currentPairDiv.appendChild(moveSpan);

        if (mover === 'b') currentPairDiv = null;
    }

    if (currentMoveElement && typeof currentMoveElement.scrollIntoView === 'function') {
        currentMoveElement.scrollIntoView({ block: 'nearest' });
    } else if (currentMoveIndex === gameHistory.length - 1) {
        moveHistoryElement.scrollTop = moveHistoryElement.scrollHeight;
    }
}

// Shows a stored position. Positions before the end of history enter review mode, where the AI
// waits until the user resumes or moves. Returning to the last position resumes live play.
function navigateToHistoryState(targetIndex) {
    if (isInputLocked()) return;
    if (targetIndex < 0 || targetIndex >= gameHistory.length) {
        console.error("UI Error: Invalid game state index for navigation:", targetIndex);
        return;
    }

    cancelAIRequest();
    cancelHint();
    cancelCaptureAnimations();
    positionVersion++;

    const state = gameHistory[targetIndex];
    currentMoveIndex = targetIndex;
    board = state.board.map(row => [...row]);
    currentPlayer = state.currentPlayer;
    castlingRights = JSON.parse(JSON.stringify(state.castlingRights));
    enPassantTarget = state.enPassantTarget ? { ...state.enPassantTarget } : null;
    halfmoveClock = state.halfmoveClock;
    fullmoveNumber = state.fullmoveNumber;
    lastMove = state.lastMove || null;
    evaluateGameState();

    isReviewing = targetIndex < gameHistory.length - 1;

    clearSelectionAndHighlights();
    renderBoard();
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    checkAndTriggerAIMove(); // No-op while reviewing
}

// Continue the game from the reviewed position; later moves are discarded
function resumeFromHere() {
    if (!isReviewing || isInputLocked() || isGameOver) return;
    gameHistory = gameHistory.slice(0, currentMoveIndex + 1);
    isReviewing = false;
    positionVersion++;
    updateStatusDisplay();
    updateMoveHistoryDisplay();
    checkAndTriggerAIMove();
}

function backToLive() {
    navigateToHistoryState(gameHistory.length - 1);
}

// In ai-human mode undo/redo skip over AI positions so the user lands on their own turn
function stepsLandOnAITurn(index) {
    return gameMode === 'ai-human' && gameHistory[index].currentPlayer !== playerColor;
}

function handleUndo() {
    if (isInputLocked() || currentMoveIndex < 1) return;
    let target = currentMoveIndex - 1;
    if (target > 0 && stepsLandOnAITurn(target)) target--;
    navigateToHistoryState(target);
}

function handleRedo() {
    if (isInputLocked() || currentMoveIndex >= gameHistory.length - 1) return;
    let target = currentMoveIndex + 1;
    if (target < gameHistory.length - 1 && stepsLandOnAITurn(target)) target++;
    navigateToHistoryState(target);
}

// --- Hint System ---
function handleHint() {
    if (isInputLocked() || isGameOver || isAIThinking || hintRequest || !isHumanTurn()) return;

    const version = positionVersion;
    const hintElo = parseInt(aiEloSlider.max, 10) || 2500;
    let handle;
    try {
        handle = requestAIMove(getCurrentGameStateSnapshot(), hintElo, { timeMs: HINT_TIME_MS });
    } catch (error) {
        console.error("UI: Hint request failed to start:", error);
        showHintMessage("Error generating hint.", version);
        return;
    }
    clearSelectionAndHighlights();
    hintRequest = handle;
    updateStatusDisplay();

    handle.promise.then(move => {
        if (hintRequest !== handle) return;
        hintRequest = null;
        if (version !== positionVersion) return;
        if (!move || !move.from || !move.to) {
            showHintMessage("No good move found for hint.", version);
            return;
        }
        const fromSq = getSquareElement(move.from.row, move.from.col);
        const toSq = getSquareElement(move.to.row, move.to.col);
        const piece = getPieceAt(move.from.row, move.from.col);
        fromSq?.classList.add('hint-from');
        toSq?.classList.add('hint-to');
        const promo = move.promotionPiece ? `=${move.promotionPiece}` : '';
        showHintMessage(`Hint: Try ${piece ? PIECES[piece] : ''} from ${squareName(move.from.row, move.from.col)} to ${squareName(move.to.row, move.to.col)}${promo}.`, version);
    }).catch(error => {
        if (hintRequest !== handle) return;
        hintRequest = null;
        console.error("UI: Hint request failed:", error);
        showHintMessage("Error generating hint.", version);
    });
}

function showHintMessage(message, version) {
    hintMessage = message;
    updateStatusDisplay();
    clearTimeout(hintTimeoutId);
    hintTimeoutId = setTimeout(() => {
        hintTimeoutId = null;
        if (version !== positionVersion) return;
        hintMessage = null;
        clearHintHighlights();
        updateStatusDisplay();
    }, HINT_DISPLAY_MS);
}

function cancelHint() {
    if (hintRequest) {
        const handle = hintRequest;
        hintRequest = null;
        handle.cancel();
    }
    clearTimeout(hintTimeoutId);
    hintTimeoutId = null;
    hintMessage = null;
    clearHintHighlights();
}

// --- Settings handlers ---
function handleGameModeChange() {
    gameMode = gameModeSelect.value;
    cancelAIRequest();
    cancelHint();
    clearSelectionAndHighlights();
    updateGameModeDisplay();
    updateStatusDisplay();
    checkAndTriggerAIMove();
}

function handleEloChange() {
    aiElo = parseInt(aiEloSlider.value, 10);
    aiEloValueSpan.textContent = aiElo;
    if (isAIThinking) {
        cancelAIRequest(); // Restart the pending AI move at the new strength
    }
    updateGameModeDisplay();
    updateStatusDisplay();
    checkAndTriggerAIMove();
}

function handleSwitchColors() {
    if (isInputLocked()) return;
    cancelAIRequest();
    cancelHint();
    cancelCaptureAnimations();
    playerColor = playerColor === 'w' ? 'b' : 'w';
    clearSelectionAndHighlights();
    createBoardDOM();
    renderBoard();
    updatePlayerColorIndicator();
    updateStatusDisplay();
    checkAndTriggerAIMove();
}

function handleKeyDown(event) {
    if (event.key === 'Escape') {
        if (pendingPromotion) cancelPromotion();
        else clearSelectionAndHighlights();
        return;
    }
    const tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // Keep native arrow behavior
    if (event.key === 'ArrowLeft' && currentMoveIndex > 0) {
        event.preventDefault();
        navigateToHistoryState(currentMoveIndex - 1);
    } else if (event.key === 'ArrowRight' && currentMoveIndex < gameHistory.length - 1) {
        event.preventDefault();
        navigateToHistoryState(currentMoveIndex + 1);
    }
}

// --- Event Listeners Setup ---
function setupEventListeners() {
    boardElement.addEventListener('click', handleBoardClick);
    newGameButton.addEventListener('click', initGame);
    undoButton.addEventListener('click', handleUndo);
    redoButton.addEventListener('click', handleRedo);
    hintButton.addEventListener('click', handleHint);
    switchColorsButton.addEventListener('click', handleSwitchColors);
    muteButton.addEventListener('click', toggleMute);
    resumeButton.addEventListener('click', resumeFromHere);
    liveButton.addEventListener('click', backToLive);

    moveHistoryElement.addEventListener('click', (event) => {
        const moveSpan = event.target.closest('.move-text');
        if (!moveSpan) return;
        const index = parseInt(moveSpan.dataset.historyIndex, 10);
        if (!isNaN(index)) navigateToHistoryState(index);
    });

    promotionPieceButtons.forEach(button => {
        button.addEventListener('click', () => choosePromotion(button.dataset.piece));
    });
    promotionCancelButton.addEventListener('click', cancelPromotion);
    promotionModal.addEventListener('click', (event) => {
        if (event.target === promotionModal) cancelPromotion(); // Backdrop click
    });

    gameModeSelect.addEventListener('change', handleGameModeChange);
    aiEloSlider.addEventListener('input', () => {
        aiEloValueSpan.textContent = aiEloSlider.value; // Label only; applied on 'change'
    });
    aiEloSlider.addEventListener('change', handleEloChange);
    document.addEventListener('keydown', handleKeyDown);

    // Sync state with the initial control values
    gameMode = gameModeSelect.value;
    aiElo = parseInt(aiEloSlider.value, 10);
    aiEloValueSpan.textContent = aiElo;
}

// --- Initialization on Load ---
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initGame();
});

// --- END OF FILE ui.js ---
