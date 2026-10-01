// --- START OF FILE aiWorker.js ---

// Classic Web Worker that runs the chess AI off the main thread.
// Request:  { id, state, elo, timeMs }   (state shape: see aiClient.js)
// Response: { id, move }                 (move is null when there is no legal move or on error)

importScripts('gameLogic.js', 'aiPlayer.js');

self.onmessage = function (event) {
    const { id, state, elo, timeMs } = event.data || {};
    let move = null;
    try {
        loadGameStateSnapshot(state);
        move = calculateBestMove(elo, timeMs, Array.isArray(state.positionHistory) ? state.positionHistory : []);
    } catch (error) {
        console.error('aiWorker: move calculation failed', error);
        move = null;
    }
    self.postMessage({ id, move });
};

// --- END OF FILE aiWorker.js ---
