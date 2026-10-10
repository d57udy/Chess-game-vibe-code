// --- START OF FILE aiWorker.js ---

// Classic Web Worker that runs the chess AI off the main thread.
// Request:  { id, state, elo, timeMs, hint, seed }   (state shape: see aiClient.js)
// Response: { id, move }                 (move is null when there is no legal move or on error)
// Coach requests: { id, kind: 'analysis'|'threats', state, opts } -> { id, result } (null on error),
// see ChessAI.analyze / ChessAI.threats in aiPlayer.js.

importScripts('gameLogic.js', 'aiPlayer.js');

self.onmessage = function (event) {
    const { id, kind, state, elo, timeMs, hint, seed, opts } = event.data || {};
    if (kind === 'analysis' || kind === 'threats') {
        let result = null;
        try {
            const history = Array.isArray(state.positionHistory) ? state.positionHistory : [];
            result = kind === 'analysis' ? ChessAI.analyze(state, opts, history) : ChessAI.threats(state, opts, history);
        } catch (error) {
            console.error('aiWorker: ' + kind + ' failed', error);
        }
        self.postMessage({ id, result });
        return;
    }
    let move = null;
    try {
        loadGameStateSnapshot(state);
        move = calculateBestMove(elo, timeMs, Array.isArray(state.positionHistory) ? state.positionHistory : [], { hint: !!hint, seed });
    } catch (error) {
        console.error('aiWorker: move calculation failed', error);
        move = null;
    }
    self.postMessage({ id, move });
};

// --- END OF FILE aiWorker.js ---
