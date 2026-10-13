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
//   requestAnalysis(state, { nodes = 300000, multiPv = 3 }) -> { promise, cancel }
//     promise: resolves with ChessAI.analyze() output { eval, mate, bestMove, pv, alternatives:
//              [{ move, eval, mate, pv }], depth, nodes, stoppedBy, terminal } (eval: White-POV
//              centipawns), or null when cancelled or on error.
//   requestThreats(state, { nodes = 100000, max = 3 }) -> { promise, cancel }
//     promise: resolves with ChessAI.threats() output { threats: [{ move, gain, mate, motif, pv }],
//              inCheck }: the opponent's best ideas if it were their move; null when cancelled.
//   classifyMove(evalBefore, evalAfter, side) -> 'best'|'good'|'inaccuracy'|'mistake'|'blunder'
//     synchronous (Lichess-style win% loss, see ChessAI.classifyMove).
//   All requests are deterministic (same state and options give the same result). Coach requests
//   (analysis, threats) run in their own worker, so they never delay or cancel AI moves; a
//   cancelled request terminates its channel's worker and that channel's other requests are
//   re-posted.
//   getCurrentGameStateSnapshot() -> state object built from the live globals (deep copies),
//     with positionHistory = getRepetitionKey() of gameHistory[0..currentMoveIndex] (the format of
//     getBoardPositionString(); the en passant square only where a capture is legal, so the AI
//     counts repetitions like checkThreefoldRepetition()).

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
            positionHistory.push(getHistoryRepetitionKey(i));
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
        const { id, move, result } = event.data || {};
        const request = aiWorkerRequests.get(id);
        if (!request) return; // cancelled or superseded
        aiWorkerRequests.delete(id);
        request.finish(request.kind === 'move' ? (move || null) : (result || null));
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

// Coach channel: a second worker (same script) for analysis and threats, so coach requests
// neither wait behind nor cancel AI moves. Falls back to the main thread like the move channel.
const coachChannel = { worker: null, unavailable: false, requests: new Map() };

function getCoachWorker() {
    const ch = coachChannel;
    if (ch.worker || ch.unavailable) return ch.worker;
    if (typeof Worker === 'undefined' || aiWorkerUnavailable) {
        ch.unavailable = true;
        return null;
    }
    try {
        ch.worker = new Worker(AI_WORKER_URL);
    } catch (error) {
        ch.unavailable = true;
        return null;
    }
    ch.worker.onmessage = (event) => {
        const { id, result } = event.data || {};
        const request = ch.requests.get(id);
        if (!request) return;
        ch.requests.delete(id);
        request.finish(result || null);
    };
    ch.worker.onerror = (event) => {
        if (event && event.preventDefault) event.preventDefault();
        ch.unavailable = true;
        if (ch.worker) ch.worker.terminate();
        ch.worker = null;
        const pending = [...ch.requests.values()];
        ch.requests.clear();
        pending.forEach(runAIOnMainThread);
    };
    return ch.worker;
}

function dispatchCoachRequest(request) {
    const worker = getCoachWorker();
    if (!worker) {
        runAIOnMainThread(request);
        return;
    }
    coachChannel.requests.set(request.id, request);
    try {
        worker.postMessage({ id: request.id, kind: request.kind, state: request.state, opts: request.opts });
    } catch (error) {
        coachChannel.requests.delete(request.id);
        runAIOnMainThread(request);
    }
}

function restartCoachWorker() {
    if (coachChannel.worker) coachChannel.worker.terminate();
    coachChannel.worker = null;
    const pending = [...coachChannel.requests.values()];
    coachChannel.requests.clear();
    pending.forEach(dispatchCoachRequest);
}

function dispatchAIRequest(request) {
    if (request.kind !== 'move') {
        dispatchCoachRequest(request);
        return;
    }
    const worker = getAIWorker();
    if (!worker) {
        runAIOnMainThread(request);
        return;
    }
    aiWorkerRequests.set(request.id, request);
    try {
        if (request.kind === 'move') {
            worker.postMessage({ id: request.id, state: request.state, elo: request.elo, timeMs: request.timeMs, hint: request.hint, seed: request.seed });
        } else {
            worker.postMessage({ id: request.id, kind: request.kind, state: request.state, opts: request.opts });
        }
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
        if (request.kind !== 'move') {
            // ChessAI.analyze/threats load the state themselves and never touch the globals.
            let result = null;
            try {
                const history = request.state.positionHistory;
                result = request.kind === 'analysis'
                    ? ChessAI.analyze(request.state, request.opts, history)
                    : ChessAI.threats(request.state, request.opts, history);
            } catch (error) {
                console.error('AI main-thread ' + request.kind + ' failed:', error);
            }
            request.finish(result);
            return;
        }
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
    return startAIClientRequest({
        kind: 'move',
        elo,
        timeMs: options.timeMs > 0 ? options.timeMs : undefined,
        hint: !!options.hint,
        seed: Number.isFinite(options.seed) ? options.seed : undefined,
    }, state);
}

function requestAnalysis(state, options = {}) {
    return startAIClientRequest({
        kind: 'analysis',
        opts: { nodes: options.nodes > 0 ? options.nodes : 300000, multiPv: options.multiPv > 0 ? options.multiPv : 3 },
    }, state);
}

function requestThreats(state, options = {}) {
    return startAIClientRequest({
        kind: 'threats',
        opts: { nodes: options.nodes > 0 ? options.nodes : 100000, max: options.max > 0 ? options.max : 3 },
    }, state);
}

function classifyMove(evalBefore, evalAfter, side) {
    return ChessAI.classifyMove(evalBefore, evalAfter, side);
}

// Shared request plumbing: fields = { kind, ...kind-specific fields }.
function startAIClientRequest(fields, state) {
    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const request = {
        ...fields,
        id: ++aiRequestCounter,
        state: cloneAIState(state),
        settled: false,
        cancelled: false,
        timer: null,
        finish(value) {
            if (request.settled) return;
            request.settled = true;
            resolvePromise(request.cancelled ? null : (value || null));
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
        } else if (coachChannel.requests.has(request.id)) {
            coachChannel.requests.delete(request.id);
            restartCoachWorker();
        }
        request.finish(null);
    };

    return { promise, cancel };
}

// --- END OF FILE aiClient.js ---
