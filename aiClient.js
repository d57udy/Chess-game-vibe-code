// --- START OF FILE aiClient.js ---

// Runs AI searches in a Web Worker (aiWorker.js) so the UI stays responsive. When Workers
// cannot be used (e.g. the page is opened via file:// and the constructor throws, or the
// worker script fails to load), the search runs on the main thread inside setTimeout so
// the UI can paint first; the live gameLogic.js globals are saved and restored around it.
//
// Public API:
//   requestAIMove(state, elo, options = {}) -> { promise, cancel }
//     state:   { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock,
//                fullmoveNumber, positionHistory }  (see getCurrentGameStateSnapshot)
//     elo:     300..2500
//     options.timeMs: optional safety time cap in ms (strength comes from the level's node budget).
//     options.hint:   true = full strength with the hint node budget (elo is then ignored).
//     options.seed:   optional integer; the same seed gives the same move on any device.
//     promise: resolves with a move { from:{row,col}, to:{row,col}, piece, isPromotion,
//              promotionPiece ('Q'|'R'|'B'|'N'|null), isCastling, isEnPassant } or null when
//              there is no legal move.
//     cancel(): resolves the promise with null (never with a move) and terminates the worker
//              if it is busy with this request. Calling it after the promise settled is a no-op.
//   getCurrentGameStateSnapshot() -> state object built from the live globals (deep copies),
//     with positionHistory = getBoardPositionString() of gameHistory[0..currentMoveIndex].

const AI_WORKER_URL = 'aiWorker.js';
const AI_MAIN_THREAD_DELAY_MS = 30; // lets the browser paint "thinking" state before blocking

let aiWorker = null;
let aiWorkerUnavailable = false;
let aiRequestCounter = 0;
const aiWorkerRequests = new Map(); // id -> request currently posted to the worker

function cloneAIState(state) {
    return {
        board: state.board.map(row => row.slice()),
        currentPlayer: state.currentPlayer,
        castlingRights: {
            w: { K: !!state.castlingRights?.w?.K, Q: !!state.castlingRights?.w?.Q },
            b: { K: !!state.castlingRights?.b?.K, Q: !!state.castlingRights?.b?.Q }
        },
        enPassantTarget: state.enPassantTarget ? { ...state.enPassantTarget } : null,
        halfmoveClock: state.halfmoveClock || 0,
        fullmoveNumber: state.fullmoveNumber || 1,
        positionHistory: Array.isArray(state.positionHistory) ? state.positionHistory.slice() : []
    };
}

function getCurrentGameStateSnapshot() {
    const positionHistory = [];
    if (Array.isArray(gameHistory)) {
        for (let i = 0; i <= currentMoveIndex && i < gameHistory.length; i++) {
            positionHistory.push(getBoardPositionString(gameHistory[i]));
        }
    }
    return cloneAIState({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, positionHistory });
}

function getAIWorker() {
    if (aiWorker || aiWorkerUnavailable) return aiWorker;
    if (typeof Worker === 'undefined') {
        aiWorkerUnavailable = true;
        return null;
    }
    try {
        aiWorker = new Worker(AI_WORKER_URL);
    } catch (error) {
        debugLog('AI worker unavailable, computing on the main thread:', error);
        aiWorkerUnavailable = true;
        return null;
    }
    aiWorker.onmessage = (event) => {
        const { id, move } = event.data || {};
        const request = aiWorkerRequests.get(id);
        if (!request) return; // cancelled or superseded
        aiWorkerRequests.delete(id);
        request.finish(move || null);
    };
    aiWorker.onerror = (event) => {
        // Script failed to load or crashed: stop using workers and rerun pending requests here.
        if (event && event.preventDefault) event.preventDefault();
        debugLog('AI worker error, falling back to the main thread:', event && event.message);
        aiWorkerUnavailable = true;
        if (aiWorker) aiWorker.terminate();
        aiWorker = null;
        const pending = [...aiWorkerRequests.values()];
        aiWorkerRequests.clear();
        pending.forEach(runAIOnMainThread);
    };
    return aiWorker;
}

function dispatchAIRequest(request) {
    const worker = getAIWorker();
    if (!worker) {
        runAIOnMainThread(request);
        return;
    }
    aiWorkerRequests.set(request.id, request);
    try {
        worker.postMessage({ id: request.id, state: request.state, elo: request.elo, timeMs: request.timeMs, hint: request.hint, seed: request.seed });
    } catch (error) {
        aiWorkerRequests.delete(request.id);
        runAIOnMainThread(request);
    }
}

// Terminates the worker (stopping any running search) and re-posts requests that are
// still waiting to a fresh one.
function restartAIWorker() {
    if (aiWorker) aiWorker.terminate();
    aiWorker = null;
    const pending = [...aiWorkerRequests.values()];
    aiWorkerRequests.clear();
    pending.forEach(dispatchAIRequest);
}

function runAIOnMainThread(request) {
    request.timer = setTimeout(() => {
        request.timer = null;
        if (request.settled) return;
        const saved = { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber };
        let move = null;
        try {
            loadGameStateSnapshot(request.state);
            move = calculateBestMove(request.elo, request.timeMs, request.state.positionHistory, { hint: request.hint, seed: request.seed });
        } catch (error) {
            console.error('AI main-thread calculation failed:', error);
        } finally {
            board = saved.board;
            currentPlayer = saved.currentPlayer;
            castlingRights = saved.castlingRights;
            enPassantTarget = saved.enPassantTarget;
            halfmoveClock = saved.halfmoveClock;
            fullmoveNumber = saved.fullmoveNumber;
        }
        request.finish(move);
    }, AI_MAIN_THREAD_DELAY_MS);
}

function requestAIMove(state, elo, options = {}) {
    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const request = {
        id: ++aiRequestCounter,
        state: cloneAIState(state),
        elo,
        timeMs: options.timeMs > 0 ? options.timeMs : undefined,
        hint: !!options.hint,
        seed: Number.isFinite(options.seed) ? options.seed : undefined,
        settled: false,
        cancelled: false,
        timer: null,
        finish(move) {
            if (request.settled) return;
            request.settled = true;
            resolvePromise(request.cancelled ? null : (move || null));
        }
    };

    dispatchAIRequest(request);

    const cancel = () => {
        if (request.settled) return;
        request.cancelled = true;
        if (request.timer) {
            clearTimeout(request.timer);
            request.timer = null;
        }
        if (aiWorkerRequests.has(request.id)) {
            aiWorkerRequests.delete(request.id);
            restartAIWorker();
        }
        request.finish(null);
    };

    return { promise, cancel };
}

// --- END OF FILE aiClient.js ---
