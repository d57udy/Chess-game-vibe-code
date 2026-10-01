// Loads the classic (non-module) game scripts into an isolated node:vm context, the same way the
// browser loads them as globals. Top-level `let`/`const` bindings (board, currentPlayer, ...) are
// only reachable through code evaluated in the context, hence run().
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Chess-coordinate helpers shared by the tests (row 0 = rank 8, col 0 = file a).
function square(name) {
    return { row: 8 - Number(name[1]), col: name.charCodeAt(0) - 97 };
}
function squareName(row, col) {
    return String.fromCharCode(97 + col) + (8 - row);
}
// Move object -> long algebraic ("e2e4", "b2b1q"); null -> "null".
function uci(move) {
    if (!move) return 'null';
    return squareName(move.from.row, move.from.col) + squareName(move.to.row, move.to.col) +
        (move.isPromotion && move.promotionPiece ? move.promotionPiece.toLowerCase() : '');
}

/**
 * @param {object} [options]
 * @param {boolean} [options.client]  also load aiClient.js
 * @param {object}  [options.globals] extra context globals (e.g. Worker, setTimeout)
 * @returns {{ctx, run, get, set, fen, uci, logs}} logs collects console output by level.
 */
function loadEngine(options = {}) {
    const logs = { log: [], warn: [], error: [] };
    const capture = (level) => (...args) => logs[level].push(args.map(String).join(' '));
    const ctx = {
        console: { log: capture('log'), warn: capture('warn'), error: capture('error'), info: capture('log'), debug: capture('log') },
        performance,
        setTimeout,
        clearTimeout,
        ...options.globals,
    };
    vm.createContext(ctx);
    const files = ['gameLogic.js', 'aiPlayer.js'];
    if (options.client) files.push('aiClient.js');
    for (const file of files) vm.runInContext(source(file), ctx, { filename: file });

    const run = (code) => vm.runInContext(code, ctx);
    // Passes a host value into the context as a (var-like) global property.
    const set = (name, value) => { ctx[name] = value; return value; };
    // Evaluates an expression and returns it as a plain host value (JSON round trip), so
    // assert.deepEqual does not trip over objects created in the other realm.
    const get = (expr) => {
        const json = run(`JSON.stringify(${expr})`);
        return json === undefined ? undefined : JSON.parse(json);
    };
    const fen = (f) => {
        set('__fen', f);
        const ok = run('parseFen(__fen)');
        if (!ok) throw new Error('parseFen failed: ' + f);
        return ok;
    };
    return { ctx, run, get, set, fen, uci, logs };
}

// Snapshot of the rule-state globals, for "does not mutate" assertions.
const GLOBALS_EXPR = 'JSON.stringify({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber, gameHistory, currentMoveIndex })';

module.exports = { loadEngine, source, ROOT, square, squareName, uci, GLOBALS_EXPR };
