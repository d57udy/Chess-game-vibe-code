// Scenario driver for the rules conformance suites (tests/integration/rulesUi2d.test.js,
// rulesUi3d.test.js, tests/slow/rulesUiPlayouts.test.js): what a player can and cannot do through
// clicks, and what the screen and the game state show afterwards. Two adapters, same operations:
//
//   open2d()  the 2D page (2d.html with every script it loads, save / load included) in jsdom,
//             driven by DOM clicks and buttons
//   open3d()  the 3D page (index.html + battle3d/main.js with the real scene, units and controller,
//             fake renderer), driven by square clicks and the HUD buttons. One page per process.
//
//   view                      '2d' | '3d'
//   hasRedo                   the view has a Redo button (2D only)
//   load(fen)                 start from a position (history restarts there)
//   newGame()                 New Game button
//   setMode(mode, human)      'human-human' | 'human-ai' | 'ai-ai', human colour 'w' | 'b' (the view side)
//   click(sq) / escape()      one click on a square / the Escape key
//   select(sq)                selects the piece on sq whatever was selected before: returns offered()
//   offered()                 { targets, captures }: the highlighted squares of the selection
//   selected()                square of the selected piece, or null
//   move(uci)                 click from, click to, pick the promotion piece, wait until finished
//   begin(uci)                the same clicks without waiting: the move is still being animated
//   promotionOpen() / promote(p) / cancelPromotion()
//   undo() / redo()           the buttons; false when the button is disabled
//   press(name)               'undo' | 'redo' | 'newGame': the button alone, without waiting (false: disabled)
//   fen()                     model: full FEN (placement, side, castling, en passant, clocks)
//   shown()                   screen: { placement, problems, fallen } from the piece elements / the units
//   status() / result()       status text / { over, kind, winner, check } parsed from it
//   turnShown()               'w' | 'b' as the turn indicator shows it ('over': the 2D indicator after the end)
//   checkShown()              square carrying the check highlight, or null
//   moveList()                notation of the move list; moveListShown(): the text exactly as listed
//                             (en passant captures carry " e.p." there)
//   lastMoveMarks()           squares marked for the last move: { move: [from, to], captured: square | null }
//   notice()                  text of the short notice on screen ('' when none), forgetTips() resets
//                             the per-device count of en passant explanations
//   saveRecord() / loadRecord(record) / exportPgn() / importPgn(text)   Save / Load as its panel does it
//   autosaved()               the game the page has stored for its next start (null when none)
//   busy()                    a move is animating or the promotion chooser is open
//   settle()                  waits until the move in progress has finished
//   thinking()                the AI has the move and has not answered yet
//   aiRequests() / aiPending() / answerAI(uci)   the stubbed AI: requests so far, open ones, answer the open one
//   pass()                    lets enough time go by for an AI turn to start, if one is due
//   setElo(elo)               the AI strength slider
//   takeErrors()              console errors of the page since the last call
// 2D only: waitAI() with open2d({ realAI: true }). 3D only: animations ('skip' | 'play'), step(frames),
// answerAIWithEngine(), and pointer(sq, where) / pick(sq, where) / pickDetail(sq, where): a real
// pointer click at the square's place on screen (click(sq) starts one step later, at the square the
// scene reports).
//
// createReference() is the chess.js game (tests/helpers/chessReference.js) the scenarios compare
// the views against; the assert* helpers below do those comparisons.
'use strict';
const assert = require('node:assert/strict');
const { Chess, START_FEN, refMove, refMoves, refStatus, refResult, refRepetitionKey } = require('./chessReference');
const { load2dPage } = require('./saveGameHarness');
const { loadEngine, square, squareName } = require('./loadEngine');

const ALL_SQUARES = [];
for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) ALL_SQUARES.push(squareName(r, c));
const sortedUnique = (list) => [...new Set(list)].sort();
const tick = () => new Promise((r) => setImmediate(r));

// --- Reference ----------------------------------------------------------------------------------

/** chess.js game that follows the view ply by ply. Expected FENs use the game's en passant convention. */
function createReference(fen = START_FEN) {
    const chess = new Chess(fen);
    const fens = [fen];
    const keys = [refRepetitionKey(chess)];
    const moves = [];
    // chess.js builds SAN and both FENs for every verbose move, so each position is asked once
    let cache = {};
    const legal = () => (cache.legal ??= refMoves(chess));
    const status = () => (cache.status ??= refStatus(chess, keys));
    const R = {
        chess,
        startFen: fen,
        ply: () => moves.length,
        turn: () => chess.turn(),
        fen: () => fens[fens.length - 1],
        /** Map uci -> refMove (promotions: four entries). */
        legal,
        /** Squares of the side to move's pieces. */
        pieces() {
            const out = [];
            for (const row of chess.board()) for (const p of row) if (p && p.color === chess.turn()) out.push(p.square);
            return out.sort();
        },
        /** What a view must offer for the piece on `from`: target squares and which of them capture. */
        offered(from) {
            const list = [...legal().values()].filter((m) => m.from === from);
            return {
                targets: sortedUnique(list.map((m) => m.to)),
                captures: sortedUnique(list.filter((m) => m.captured).map((m) => m.to)),
            };
        },
        play(uci) {
            const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
            const r = refMove(m);
            moves.push(r);
            fens.push(r.fen);
            keys.push(refRepetitionKey(chess));
            cache = {};
            return r;
        },
        undo(plies = 1) {
            for (let i = 0; i < plies && moves.length; i++) { chess.undo(); moves.pop(); fens.pop(); keys.pop(); }
            cache = {};
        },
        status,
        /** { over, kind, winner, check } in the shape of an adapter's result(). */
        result() {
            const s = status(), kind = refResult(s);
            return { over: kind !== null, kind, winner: kind === 'checkmate' ? (chess.turn() === 'w' ? 'b' : 'w') : null, check: kind === null && s.inCheck };
        },
        sans: () => moves.map((m) => m.san),
        last: () => moves[moves.length - 1] || null,
    };
    return R;
}

// Status text -> { over, kind, winner, check }. Both views use the same sentences for results.
function parseStatus(text) {
    const win = /^Checkmate! (White|Black) wins\./.exec(text);
    const kind = win ? 'checkmate'
        : /^Stalemate!/.test(text) ? 'stalemate'
        : /^Draw by 50-move rule\./.test(text) ? 'fifty-move'
        : /^Draw by threefold repetition\./.test(text) ? 'threefold'
        : /^Draw by insufficient material\./.test(text) ? 'insufficient'
        : null;
    return { over: kind !== null, kind, winner: win ? (win[1] === 'White' ? 'w' : 'b') : null, check: kind === null && /is in check!/.test(text) };
}

function placementOf(grid) {
    return grid.map((row) => {
        let out = '', empty = 0;
        for (const p of row) { if (p) { out += (empty || '') + p; empty = 0; } else empty++; }
        return out + (empty || '');
    }).join('/');
}

// FEN of the position an AI request was given (the state of getCurrentGameStateSnapshot)
function stateFen(state) {
    const rights = ['K', 'Q'].filter((x) => state.castlingRights.w[x]).join('') + ['k', 'q'].filter((x) => state.castlingRights.b[x.toUpperCase()]).join('');
    const ep = state.enPassantTarget ? squareName(state.enPassantTarget.row, state.enPassantTarget.col) : '-';
    return `${placementOf(state.board)} ${state.currentPlayer} ${rights || '-'} ${ep} ${state.halfmoveClock} ${state.fullmoveNumber}`;
}

const moveObject = (uci) => ({
    from: square(uci.slice(0, 2)), to: square(uci.slice(2, 4)),
    isPromotion: !!uci[4], promotionPiece: uci[4] ? uci[4].toUpperCase() : null,
});

// Operations that are the same in both views, built on the view-specific primitives.
function common(A) {
    let errorMark = 0;
    // A click on an own piece selects it in both views, with two exceptions in 3D: a second click on
    // the selected unit puts it down again, and with the king selected a click on an own rook castles.
    A.select = async (sq) => {
        const current = A.view === '3d' ? A.selected() : null;
        if (current === sq) return A.offered();
        if (current && A.kingOn(current)) await A.escape();
        await A.click(sq);
        return A.offered();
    };
    A.begin = async (uci) => {
        await A.select(uci.slice(0, 2));
        await A.click(uci.slice(2, 4));
        if (uci[4]) {
            assert.ok(A.promotionOpen(), `${A.view}: promotion chooser opens for ${uci}`);
            A.choose(uci[4]);
        }
    };
    A.move = async (uci) => { await A.begin(uci); await A.settle(); };
    A.promote = async (piece) => { A.choose(piece); await A.settle(); };
    A.result = () => parseStatus(A.status());
    // Both lists mark en passant captures ("exd6 e.p."); moveList() is the plain notation
    A.moveList = () => A.moveListShown().map((text) => text.replace(/ e\.p\.$/, ''));
    A.aiPending = () => A.aiRequests().filter((c) => !c.cancelled && !c.answered).length;
    /** Console errors since the last call. */
    A.takeErrors = () => { const all = A.allErrors(); const out = all.slice(errorMark); errorMark = all.length; return out; };
    return A;
}

// --- 2D adapter ---------------------------------------------------------------------------------

const MODES_2D = { 'human-human': 'human-human', 'human-ai': 'ai-human', 'ai-ai': 'ai-ai' };

/**
 * @param {object} [options]
 * @param {boolean} [options.realAI] keep aiClient.js's requestAIMove (main-thread engine); default: stubbed
 * @param {number} [options.scenes] load the real GSAP at this time scale, so captures play their
 *        battle scenes (battleFx.js); default: stub tweens, captures fade
 * @param {Object<string, string>} [options.storage] localStorage content the page starts with (e.g.
 *        A.D.storage() of an earlier page: the page then reopens with that page's autosaved game)
 */
async function open2d(options = {}) {
    // The page with every script it loads (rules, AI, battle scenes, ui.js, save / load)
    const D = await load2dPage({
        realClient: !!options.realAI,
        ...(options.scenes ? { realGsap: true, gsapSpeed: options.scenes } : {}),
        setup: (w) => {
            // The "AI is thinking" pauses do not need real time here; long timers (notices) keep theirs
            const real = w.setTimeout.bind(w);
            w.setTimeout = (fn, ms, ...a) => real(fn, ms <= 600 ? Math.min(Number(ms) || 0, 2) : ms, ...a);
            for (const [key, value] of Object.entries(options.storage || {})) w.localStorage.setItem(key, value);
        },
    });
    const { doc, w } = D;
    const glyphs = Object.fromEntries(Object.entries(D.get('PIECES')).map(([piece, glyph]) => [glyph, piece]));
    const el = Object.fromEntries(['chess-board', 'move-history', 'promotion-modal', 'status-message', 'turn-indicator', 'game-notice',
        'new-game-button', 'undo-button', 'redo-button', 'switch-colors-button', 'promotion-cancel'].map((id) => [id, doc.getElementById(id)]));
    const board = el['chess-board'];
    // The board's children are the 64 squares in screen order, then the pieces. They are read by
    // walking the siblings: selector queries cost a scan of the whole document in jsdom.
    const children = () => {
        const squares = [], pieces = [];
        for (let node = board.firstChild; node; node = node.nextSibling) {
            if (node.nodeType !== 1) continue;
            const cls = node.className;
            if (/(^| )piece( |$)/.test(cls)) pieces.push(node);
            else if (/(^| )square( |$)/.test(cls)) squares.push(node);
        }
        return { squares, pieces };
    };
    const at = (node) => squareName(Number(node.getAttribute('data-row')), Number(node.getAttribute('data-col')));
    const names = (cls) => children().squares.filter((sq) => sq.classList.contains(cls)).map(at).sort();
    const button = (id) => {
        if (el[id].disabled) return false;
        el[id].click();
        return true;
    };
    // Finishes the move in progress: completes its tweens (capture fade, then the slide) as they appear.
    // An answered AI request starts its move a task later, hence the first tick.
    const settle = async () => {
        await tick();
        if (options.scenes) return D.settle(10000); // real GSAP runs on its own clock
        for (let i = 0; i < 2000 && (D.g('isAnimating') || D.tweens.pending() > 0); i++) {
            D.tweens.flush();
            await tick();
        }
        assert.equal(D.g('isAnimating'), false, '2D move animation finished');
    };

    const A = common({
        view: '2d',
        hasRedo: true,
        D,
        async load(fen) {
            D.key('Escape');
            D.loadPosition(fen);
            D.g('checkAndTriggerAIMove()');
        },
        async newGame() { button('new-game-button'); await settle(); },
        async setMode(mode, human = 'w') {
            if (!MODES_2D[mode]) throw new Error('unknown mode ' + mode);
            D.setMode(MODES_2D[mode]);
            if (D.g('playerColor') !== human) button('switch-colors-button');
        },
        // Clicks the piece drawn on the square if there is one, else the square itself (as a pointer would)
        async click(sq) {
            const { squares, pieces } = children();
            const target = pieces.find((node) => at(node) === sq) || squares.find((node) => at(node) === sq);
            target.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        },
        async escape() { D.key('Escape'); },
        offered() {
            const captures = names('capture-move');
            return { targets: [...names('legal-move'), ...captures].sort(), captures };
        },
        selected: () => names('selected')[0] || null,
        promotionOpen: () => el['promotion-modal'].style.display !== 'none',
        choose(piece) { el['promotion-modal'].querySelector(`button[data-piece="${piece.toUpperCase()}"]`).click(); },
        async cancelPromotion() { button('promotion-cancel'); },
        press: (name) => button({ undo: 'undo-button', redo: 'redo-button', newGame: 'new-game-button' }[name]),
        async undo() { const ok = button('undo-button'); await settle(); return ok; },
        async redo() { const ok = button('redo-button'); await settle(); return ok; },
        fen: () => D.g(`getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) + ' ' + halfmoveClock + ' ' + fullmoveNumber`),
        // Every piece element, placed by its left/top on the square whose coordinate label sits there
        shown() {
            const { squares, pieces } = children();
            const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
            const problems = [];
            if (squares.length !== 64) problems.push(`${squares.length} squares drawn`);
            for (const node of pieces) {
                const vCol = parseFloat(node.style.left) / 12.5, vRow = parseFloat(node.style.top) / 12.5;
                const cell = Number.isInteger(vCol) && Number.isInteger(vRow) ? squares[vRow * 8 + vCol] : null;
                const tag = node.getAttribute('data-piece');
                if (!cell) { problems.push(`piece ${tag} drawn off the grid at ${node.style.left}, ${node.style.top}`); continue; }
                const name = cell.firstChild.textContent; // the coordinate label
                const { row, col } = square(name);
                const piece = glyphs[node.textContent];
                if (grid[row][col]) problems.push(`two pieces drawn on ${name}`);
                if (piece !== tag) problems.push(`glyph ${node.textContent} on ${name} is tagged ${tag}`);
                if (at(node) !== name) problems.push(`piece drawn on ${name} answers clicks as ${at(node)}`);
                if (at(cell) !== name) problems.push(`square labelled ${name} answers clicks as ${at(cell)}`);
                grid[row][col] = piece;
            }
            return { placement: placementOf(grid), problems, fallen: [] };
        },
        status: () => el['status-message'].textContent,
        turnShown() {
            const text = el['turn-indicator'].textContent;
            return text === 'Game Over' ? 'over' : text === 'Turn: White' ? 'w' : text === 'Turn: Black' ? 'b' : text;
        },
        checkShown: () => names('in-check')[0] || null,
        // Moves up to the shown position (undone moves stay listed, greyed, for Redo)
        moveListShown() {
            const out = [];
            for (let pair = el['move-history'].firstChild; pair; pair = pair.nextSibling) {
                for (let node = pair.firstChild; node; node = node.nextSibling) {
                    if (node.nodeType === 1 && node.classList.contains('move-text') && !node.classList.contains('future-move')) out.push(node.textContent);
                }
            }
            return out;
        },
        lastMoveMarks: () => ({ move: names('last-move'), captured: names('last-capture')[0] || null }),
        notice: () => el['game-notice'].textContent,
        forgetTips() { w.localStorage.removeItem('battle3d.enPassantSeen'); },
        autosaved: () => JSON.parse(w.localStorage.getItem('chess.autosave.2d') || 'null'),
        saveRecord: () => D.get('SaveHost.record()'),
        async loadRecord(record) { const result = D.get(`SaveHost.load(${JSON.stringify(record)})`); await settle(); return result; },
        exportPgn: () => D.g('SaveHost.session.pgn()'),
        async importPgn(text) { const result = D.get(`SaveHost.session.importPgn(${JSON.stringify(text)})`); await settle(); return result; },
        busy: () => !!D.g('isAnimating') || D.g('pendingPromotion') !== null,
        settle,
        aiRequests: () => (options.realAI ? [] : [...D.aiCalls()]),
        thinking: () => !!D.g('isAIThinking'),
        async pass() { await D.sleep(12); await settle(); },
        async setElo(elo) { D.setElo(elo); },
        // Waits for the AI request of the current position and answers it with `uci` (or a raw move object).
        async answerAI(uci) {
            for (let i = 0; i < 400 && A.aiPending() === 0; i++) await D.sleep(1);
            assert.ok(A.aiPending() > 0, '2D AI request');
            const call = A.aiRequests().filter((c) => !c.cancelled && !c.answered).pop();
            call.answered = true;
            call.resolve(typeof uci === 'string' ? moveObject(uci) : uci);
            await settle();
        },
        // With realAI: waits until the engine's move has been played (or the game is over).
        async waitAI(timeout = 20000) {
            await D.waitFor(() => !D.g('isAIThinking') && !D.g('isAnimating'), { timeout, message: '2D engine move' });
            await settle();
        },
        allErrors: () => D.errors,
        close() { D.close(); },
    });
    return A;
}

// --- 3D adapter ---------------------------------------------------------------------------------

// Highlight meshes of battle3d/scene.js by render order (see "highlights" there).
const HL_ORDER = { lastMove: 2, check: 3, selected: 4, target: 6 };

/**
 * Boots the 3D page once (ES modules are cached per process). Returns null when three.js is missing.
 * The kings' commentary and the coach are switched off: they only add engine analysis per move.
 */
async function open3d() {
    const { bootPage } = require('./loadBattle3dPage');
    const P = await bootPage({
        setup: (w) => {
            w.localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', speed: 'fast', talk: 'off', coach: false }));
            w.localStorage.setItem('battle3d.tipSeen', '1');
        },
    });
    if (!P) return null;
    const { B, $, w } = P;
    const scene = B.sceneAPI.scene;
    const highlights = scene.getObjectByName('highlights');
    const meshSquares = (order) => highlights.children
        .filter((m) => m.visible && m.renderOrder === order)
        .map((m) => ({ name: squareName(Math.round(m.position.z + 3.5), Math.round(m.position.x + 3.5)), ring: m.scale.x > 0.9 }));
    const button = (id) => {
        const el = $(id);
        if (el.disabled) return false;
        el.click();
        return true;
    };
    let engine = null; // vm context with the real aiClient.js, for answerAIWithEngine()

    const A = common({
        view: '3d',
        hasRedo: false,
        P,
        /** 'skip': every animation is ended with the Skip button; 'play': it runs on the scene clock. */
        animations: 'skip',
        async load(fen) { B.controller.loadFen(fen); await tick(); },
        async newGame() { button('new-game'); await tick(); },
        async setMode(mode, human = 'w') {
            const select = $('mode-select');
            select.value = mode;
            select.dispatchEvent(new w.Event('change'));
            if (B.state().humanColor !== human) $(human === 'w' ? 'side-w' : 'side-b').click();
            await tick();
        },
        async click(sq) { const { row, col } = square(sq); B.controller.clickSquare(row, col); await tick(); },
        async escape() { P.key('Escape'); },
        offered() {
            const list = meshSquares(HL_ORDER.target);
            return { targets: list.map((m) => m.name).sort(), captures: list.filter((m) => m.ring).map((m) => m.name).sort() };
        },
        selected: () => meshSquares(HL_ORDER.selected).map((m) => m.name)[0] || null,
        kingOn(sq) { const { row, col } = square(sq); return /k/i.test(globalThis.getPieceAt(row, col) || ''); },
        promotionOpen: () => !$('promo').hidden,
        choose(piece) { $('promo').querySelector(`button[data-piece="${piece.toUpperCase()}"]`).click(); },
        async cancelPromotion() { button('promo-cancel'); await tick(); },
        press: (name) => (name === 'redo' ? false : button({ undo: 'undo', newGame: 'new-game' }[name])),
        async undo() { const ok = button('undo'); await tick(); return ok; },
        async redo() { return false; },
        fen: () => globalThis.battle3dFen(), // the page's scripts run in this realm; same value as __b3d.state().fen
        // Every unit, placed by where its model stands in the scene. fallen: units lying dead on
        // their square (the mated king after the final scene).
        shown() {
            const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
            const problems = [], fallen = [];
            let count = 0;
            for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
                const u = B.units.unitAt(r, c);
                if (!u) continue;
                count++;
                const p = u.root.position;
                const row = Math.round(p.z + 3.5), col = Math.round(p.x + 3.5);
                const piece = u.color === 'w' ? u.type.toUpperCase() : u.type;
                const at = `${piece} of ${squareName(r, c)}`;
                if (Math.abs(p.x - (col - 3.5)) > 1e-3 || Math.abs(p.z - (row - 3.5)) > 1e-3 || Math.abs(p.y) > 1e-3) {
                    problems.push(`${at} stands off centre at ${p.toArray().map((v) => v.toFixed(3))}`);
                }
                if (row < 0 || row > 7 || col < 0 || col > 7) { problems.push(`${at} stands off the board`); continue; }
                if (row !== r || col !== c) problems.push(`${at} stands on ${squareName(row, col)}`);
                if (grid[row][col]) problems.push(`two units stand on ${squareName(row, col)}`);
                if (u.dying || u.root.visible === false || u.root.parent !== scene) problems.push(`${at} is leaving or not in the scene`);
                if (u.dead) fallen.push(squareName(r, c));
                grid[row][col] = piece;
            }
            const roots = scene.children.filter((o) => /^unit-/.test(o.name)).length;
            if (roots !== count) problems.push(`${roots} unit models in the scene for ${count} pieces`);
            return { placement: placementOf(grid), problems, fallen };
        },
        status: () => $('status-text').textContent,
        turnShown: () => ($('turn-dot').classList.contains('w') ? 'w' : $('turn-dot').classList.contains('b') ? 'b' : $('turn-dot').className),
        checkShown: () => meshSquares(HL_ORDER.check).map((m) => m.name)[0] || null,
        moveListShown: () => [...$('move-list').querySelectorAll('span.mv')].map((el) => el.textContent),
        // Last-move meshes of the scene: the two filled squares, and the frame on the square of a pawn taken en passant
        lastMoveMarks() {
            // 'capture-victim' has the same order: it marks the pawn a selected pawn would take en passant
            const marks = highlights.children.filter((m) => m.visible && m.renderOrder === HL_ORDER.lastMove && m.name !== 'capture-victim');
            const name = (m) => squareName(Math.round(m.position.z + 3.5), Math.round(m.position.x + 3.5));
            return { move: marks.filter((m) => m.name !== 'last-captured').map(name).sort(), captured: marks.filter((m) => m.name === 'last-captured').map(name)[0] || null };
        },
        notice: () => ($('tip').hidden ? '' : $('tip-text').textContent),
        forgetTips() { w.localStorage.removeItem('battle3d.enPassantSeen'); },
        autosaved: () => JSON.parse(w.localStorage.getItem('chess.autosave.3d') || 'null'),
        saveRecord: () => JSON.parse(JSON.stringify(B.saves.session.record())),
        async loadRecord(record) { const result = B.saves.session.load(JSON.parse(JSON.stringify(record))); await A.settle(); return result; },
        exportPgn: () => B.saves.session.pgn(),
        async importPgn(text) { const result = B.saves.session.importPgn(text); await A.settle(); return result; },
        // As the HUD shows it: Skip is enabled while a move animates, the chooser is up for a promotion
        busy: () => !$('skip').disabled || !$('promo').hidden,
        // Lets a started move finish: its scene, then the check / game-over scene.
        async settle() {
            await tick();
            for (let i = 0; i < 3000 && B.state().moving; i++) {
                if (A.animations === 'skip') button('skip');
                B.step(1);
                await tick();
            }
            assert.equal(B.state().moving, false, '3D move animation finished');
            await tick();
        },
        aiRequests: () => P.aiCalls(),
        thinking: () => B.state().thinking,
        async pass() { await A.step(90); },
        async setElo(elo) { const el = $('elo-slider'); el.value = String(elo); el.dispatchEvent(new w.Event('input')); },
        // Runs the scene clock through the pause before the AI request, then answers it.
        async answerAI(uci) {
            for (let i = 0; i < 600 && A.aiPending() === 0; i++) { B.step(1); await tick(); }
            assert.ok(A.aiPending() > 0, '3D AI request');
            const call = A.aiRequests().filter((c) => !c.cancelled && !c.answered).pop();
            call.answered = true;
            call.resolve(typeof uci === 'string' ? moveObject(uci) : uci);
            await A.settle();
        },
        // Answers the pending request with the real engine's move for the state the page passed.
        async answerAIWithEngine() {
            for (let i = 0; i < 600 && A.aiPending() === 0; i++) { B.step(1); await tick(); }
            assert.ok(A.aiPending() > 0, '3D AI request');
            const call = A.aiRequests().filter((c) => !c.cancelled && !c.answered).pop();
            engine ??= loadEngine({ client: true });
            engine.set('__state', JSON.parse(JSON.stringify(call.state)));
            engine.set('__elo', call.elo);
            const move = await engine.run('requestAIMove(__state, __elo).promise');
            call.answered = true;
            call.resolve(move && JSON.parse(JSON.stringify(move)));
            await A.settle();
            return move;
        },
        allErrors: () => P.errors,
        close() { P.restore(); },
    });
    // Counts the scene steps a test needs (the AI pause, animations) without touching real time
    A.step = async (frames = 1) => { for (let i = 0; i < frames; i++) { B.step(1); await tick(); } };

    // The input chain below clickSquare: where the square is on screen, and a pointer press and
    // release there, which the scene turns into a square by ray picking. `where`:
    //   'auto'    the body of the unit standing on the square, or the far part of an empty square
    //             (the part no unit on the square in front can cover)
    //   'unit'    the body of the unit standing there
    //   'middle'  the middle of the square on the board, where its move marker is drawn
    const canvas = P.renderer.domElement;
    function screenPoint(sq, where = 'auto') {
        const { row, col } = square(sq);
        const { camera, THREE } = B.sceneAPI;
        for (let i = 0; i < 600 && B.sceneAPI.isCameraBusy(); i++) B.step(1); // a view change still turning the camera
        const away = B.sceneAPI.getViewSide() === 'b' ? 0.45 : -0.45;
        const onUnit = where === 'unit' || (where === 'auto' && B.units.unitAt(row, col));
        const point = onUnit ? new THREE.Vector3(col - 3.5, 0.45, row - 3.5)
            : new THREE.Vector3(col - 3.5, 0, row - 3.5 + (where === 'middle' ? 0 : away));
        camera.updateMatrixWorld();
        point.project(camera);
        const rect = canvas.getBoundingClientRect();
        return { clientX: rect.left + (point.x + 1) / 2 * rect.width, clientY: rect.top + (1 - point.y) / 2 * rect.height };
    }
    /** The square the scene picks at the screen position of `sq`. */
    A.pick = (sq, where) => {
        const { clientX, clientY } = screenPoint(sq, where);
        const hit = B.sceneAPI.pickAt(clientX, clientY);
        return hit ? squareName(hit.row, hit.col) : null;
    };
    /**
     * What the scene finds at the screen position of `sq`: the picked square, the board square under
     * the pointer, and the square of the unit whose figure is drawn there (null: the pointer is on
     * the board, or only within reach of a unit).
     */
    A.pickDetail = (sq, where) => {
        const { clientX, clientY } = screenPoint(sq, where);
        const hit = B.sceneAPI.pickAt(clientX, clientY, true);
        const name = (s) => (s ? squareName(s.row, s.col) : null);
        return hit ? { square: name(hit), ground: name(hit.ground), figure: name(hit.figure) } : null;
    };
    /** A mouse click (pointerdown + pointerup on the canvas) at the screen position of `sq`. */
    A.pointer = async (sq, where) => {
        const init = { ...screenPoint(sq, where), pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerdown', init));
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerup', init));
        await tick();
    };
    return A;
}

// --- Comparisons --------------------------------------------------------------------------------

/** Model FEN equals the reference, and the screen shows that position. */
function assertPosition(A, R, at) {
    assert.equal(A.fen(), R.fen(), `${A.view} position, ${at}`);
    assertShown(A, at);
}

/**
 * The pieces on screen are exactly the model's pieces, each on its own square. In 3D nobody lies
 * dead on the board, except the mated king once the game is over.
 */
function assertShown(A, at) {
    const shown = A.shown();
    const [placement, turn] = A.fen().split(' ');
    assert.deepEqual(shown.problems, [], `${A.view} screen, ${at}`);
    assert.equal(shown.placement, placement, `${A.view} screen shows the model position, ${at}`);
    if (shown.fallen.length) {
        const mated = A.result().kind === 'checkmate' ? shown.fallen.filter((sq) => pieceOn(placement, sq) === (turn === 'w' ? 'K' : 'k')) : [];
        assert.deepEqual(shown.fallen, mated, `${A.view}: only a mated king lies on the board, ${at}`);
    }
}

function pieceOn(placement, sq) {
    const { row, col } = square(sq);
    let c = 0;
    for (const ch of placement.split('/')[row]) {
        if (/\d/.test(ch)) c += Number(ch);
        else if (c++ === col) return ch;
        if (c > col) break;
    }
    return null;
}

/** Status text, turn indicator, check highlight (a mated king keeps it) and move list agree with the reference game. */
function assertStatus(A, R, at) {
    const want = R.result(), got = A.result();
    if (want.over || !A.thinking()) assert.deepEqual(got, want, `${A.view} status "${A.status()}", ${at}`);
    assert.equal(A.turnShown(), want.over && A.view === '2d' ? 'over' : R.turn(), `${A.view} turn indicator, ${at}`);
    assert.equal(A.checkShown(), R.status().inCheck ? kingSquare(R) : null, `${A.view} check highlight, ${at}`);
    assert.deepEqual(A.moveList(), R.sans(), `${A.view} move list, ${at}`);
}

function kingSquare(R) {
    for (const row of R.chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === R.chess.turn()) return p.square;
    return null;
}

/**
 * For every piece of the side to move: the highlighted targets equal the reference's legal targets
 * (and the capture marks its captures). Returns the number of pieces checked.
 */
async function assertOffers(A, R, at) {
    const over = R.result().over;
    const pieces = R.pieces();
    for (const from of pieces) {
        const want = over ? { targets: [], captures: [] } : R.offered(from);
        const got = await A.select(from);
        assert.deepEqual(got.targets, want.targets, `${A.view} targets offered for ${from}, ${at}`);
        assert.deepEqual(got.captures, want.captures, `${A.view} capture marks for ${from}, ${at}`);
    }
    await A.escape();
    return pieces.length;
}

/**
 * Clicking a square that is not offered never changes the position. `squares(from)` limits the
 * squares tried per piece (default: all 64). The 3D view has two second ways to play an offered
 * move: king then own rook castles towards that rook, and pawn then the pawn it takes en passant
 * captures it. Those clicks are left out when that move is legal (kingThenRook and
 * pawnThenPawnBeside in rulesUiSuite.js check them).
 */
async function assertInertClicks(A, R, at, squares = () => ALL_SQUARES) {
    const before = A.fen(), list = A.moveList().length;
    let clicks = 0;
    for (const from of R.pieces()) {
        const { targets } = R.offered(from);
        const moves = [...R.legal().values()].filter((m) => m.from === from);
        const shortcuts = A.view === '3d' ? [...moves.filter((m) => m.castling).map((m) => m.castling.rookFrom), ...moves.filter((m) => m.enPassant).map((m) => m.capturedSquare)] : [];
        for (const sq of squares(from)) {
            if (sq === from || targets.includes(sq) || shortcuts.includes(sq)) continue;
            await A.select(from);
            await A.click(sq);
            clicks++;
            if (A.fen() !== before || A.busy()) {
                assert.fail(`${A.view}: clicking ${from} then ${sq} (not offered) changed the game, ${at}: ${A.fen()}`);
            }
        }
    }
    await A.escape();
    assert.equal(A.moveList().length, list, `${A.view} move list unchanged, ${at}`);
    return clicks;
}

module.exports = {
    open2d, open3d, createReference, parseStatus, moveObject, placementOf, stateFen,
    assertPosition, assertShown, assertStatus, assertOffers, assertInertClicks,
    ALL_SQUARES, START_FEN, tick,
};
