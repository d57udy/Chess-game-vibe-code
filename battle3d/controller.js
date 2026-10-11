// Turn flow for the 3D battle prototype: selection, AI turns, modes, HUD wiring.
// Game state lives in the gameLogic.js globals and is changed only through battle3d/rules.js.
// All gameplay waits run on the scene updater clock so `__b3d.step()` drives everything.

const g = globalThis; // classic-script functions from gameLogic.js, aiClient.js, rules.js
const gs = () => g.battle3dState(); // live gameLogic `let` globals (not on window)
const GLYPHS = { Q: '♕', R: '♖', B: '♗', N: '♘', q: '♛', r: '♜', b: '♝', n: '♞' };

const MOVE_WATCHDOG_SECONDS = 30; // a stuck animation is skipped after this much scene time
const MODES = ['human-ai', 'human-human', 'ai-ai'];
const AI_PAUSE = { 'human-ai': 0.25, 'ai-ai': 0.6 }; // scene seconds before the AI starts thinking
const SETTINGS_KEY = 'battle3d.settings';
const HINT_ELO = 2500;        // hint mode ignores the ELO and plays at full strength with its own node budget
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const squareName = (sq) => String.fromCharCode(97 + sq.col) + (8 - sq.row);
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ANALYSIS_WAIT_SECONDS = 1.5; // after a move's scene, wait at most this long for its analysis before going on
const BIG_EVAL = 300, BIG_EVAL_RESET = 150; // centipawns for winningBig / losingBig

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
// Merges, so settings owned by commentary.js / coach.js in the same object survive
function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...settings })); } catch (e) { /* private mode etc. */ }
}

export function createController({ sceneAPI, units, audio = null, onMoveEnd = null, debug = false, log = () => {} }) {
    const $ = (id) => document.getElementById(id);
    const el = {
        hud: $('hud'), hudToggle: $('hud-toggle'),
        statusLine: document.querySelector('.status-line'), statusText: $('status-text'), turnDot: $('turn-dot'),
        mode: $('mode-select'), elo: $('elo-slider'), eloValue: $('elo-value'), eloRow: $('elo-row'),
        sideLabel: $('side-label'), sideW: $('side-w'), sideB: $('side-b'),
        speedFull: $('speed-full'), speedFast: $('speed-fast'), labels: $('labels-toggle'),
        newGame: $('new-game'), undo: $('undo'), skip: $('skip'), hint: $('hint'),
        moveList: $('move-list'), moveCount: $('move-count'),
        promo: $('promo'), promoCancel: $('promo-cancel'),
        reviewBar: $('review-bar'), reviewExit: $('review-exit'),
        mute: $('mute'), ambience: $('ambience-toggle'), announce: $('announce'), stage: $('stage')
    };

    // The AI strength range lives in the slider's min/max/step/value attributes (index.html), so a
    // recalibration only edits the markup. The top end is labelled "Max" (the engine's real top strength).
    const ELO = {
        min: Number(el.elo.min) || 300,
        max: Number(el.elo.max) || 2500,
        step: Number(el.elo.step) || 100,
        def: Number(el.elo.defaultValue) || 1200
    };
    const clampElo = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return ELO.def;
        const snapped = ELO.min + Math.round((n - ELO.min) / ELO.step) * ELO.step;
        return Math.max(ELO.min, Math.min(ELO.max, snapped));
    };
    const eloLabel = (elo) => (elo >= ELO.max ? 'Max' : String(elo));

    const st = {
        mode: 'human-ai',
        humanColor: 'w',
        elo: ELO.def,
        speed: 'full',
        labels: true,
        muted: false,
        ambience: true,
        cursor: null,            // keyboard cursor { row, col }
        selected: null,          // { row, col }
        moves: [],               // legal moves of the selected unit
        hover: null,
        moving: false,           // a move is being animated (input locked)
        phase: null,             // while moving: 'move' | 'check' | 'finale' (result stays hidden until done)
        anim: null,              // { color, capture } of the move being animated
        aiHandle: null,          // { promise, cancel }
        aiWaiting: false,        // pause before the AI request
        aiToken: 0,              // bumped by cancelAI so a pending pause drops out
        pendingPromotion: null,  // { from, to }
        hint: null,              // { from, to, capture, piece, promotion, castling } shown on the board
        hintHandle: null,        // in-flight hint request { promise, cancel }
        hintToken: 0,            // bumped by clearHint so a late answer drops out
        version: 0,              // bumped whenever the position changes underneath async work
        resets: 0,               // bumped by new game / undo / loadFen (drops late analysis results)
        reviewIndex: null,       // history index shown in review mode (input locked), null = live
        reviewNote: null,        // status text while reviewing (from the coach's review panel)
        pendingReview: null,     // [index, options] requested while a move was animating
        turnStartedAt: 0,        // performance.now() when the side to move got the turn
        bigSide: null,           // 'w' | 'b' after a winningBig event, until the eval comes back
        endgameAnnounced: false,
        repeated: new Set(),     // position strings already reported as repeating
        error: null
    };

    // --- Scene-clock timers ---
    const timers = new Set();
    sceneAPI.addUpdater((dt) => {
        for (const t of [...timers]) {
            t.left -= dt;
            if (t.left <= 0) { timers.delete(t); t.resolve(); }
        }
    });
    function wait(seconds) {
        return new Promise(resolve => timers.add({ left: seconds, resolve }));
    }

    // --- Helpers ---
    const isAIColor = (color) => st.mode === 'ai-ai' || (st.mode === 'human-ai' && color !== st.humanColor);
    const isHumanTurn = () => !isAIColor(gs().currentPlayer);
    const status = () => g.battle3dGameStatus();
    const viewSide = () => (st.mode === 'ai-ai' ? 'w' : st.humanColor);
    const thinking = () => st.aiWaiting || st.aiHandle !== null;
    const inputLocked = () => st.moving || st.pendingPromotion !== null || st.reviewIndex !== null || gs().isGameOver || !isHumanTurn() || thinking();
    const opponent = (c) => (c === 'w' ? 'b' : 'w');
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    function checkSquare() {
        return g.isKingInCheck(gs().currentPlayer) ? g.findKing(gs().currentPlayer) : null;
    }

    function refreshHighlights() {
        const showMoves = !st.moving && st.selected;
        const showCheck = !st.moving || st.phase === 'check';
        sceneAPI.setHighlights({
            selected: showMoves ? st.selected : null,
            moves: showMoves ? st.moves.map(m => ({
                row: m.row, col: m.col, capture: !!g.getPieceAt(m.row, m.col) || !!m.isEnPassant
            })) : [],
            lastMove: g.battle3dLastMove(),
            check: showCheck ? checkSquare() : null,
            hover: !st.moving && !inputLocked() ? (st.cursor || st.hover) : null
        });
        updateRings(showMoves, showCheck);
        sceneAPI.requestRender?.();
    }

    // Unit decoration rings (unit.deco from unit-visuals.js; units without it are skipped).
    // Only changes are pushed so the pulse animations do not restart on every hover.
    const rings = new Map(); // deco -> { selected, threatened }

    function updateRings(showMoves, showCheck) {
        const want = new Map();
        const mark = (row, col, key) => {
            const deco = typeof units.unitAt === 'function' ? units.unitAt(row, col)?.deco : null;
            if (!deco) return;
            const entry = want.get(deco) || { selected: false, threatened: false };
            entry[key] = true;
            want.set(deco, entry);
        };
        if (showMoves) {
            mark(st.selected.row, st.selected.col, 'selected');
            for (const m of st.moves) {
                if (m.isEnPassant) mark(st.selected.row, m.col, 'threatened');
                else if (g.getPieceAt(m.row, m.col)) mark(m.row, m.col, 'threatened');
            }
        }
        const king = showCheck ? checkSquare() : null;
        if (king) mark(king.row, king.col, 'threatened');
        applyRings(want);
    }

    function applyRings(want) {
        for (const [deco, was] of rings) {
            const now = want.get(deco);
            if (was.selected && !now?.selected) callDeco(deco, 'setSelected', false);
            if (was.threatened && !now?.threatened) callDeco(deco, 'setThreatened', false);
        }
        for (const [deco, now] of want) {
            const was = rings.get(deco);
            if (now.selected && !was?.selected) callDeco(deco, 'setSelected', true);
            if (now.threatened && !was?.threatened) callDeco(deco, 'setThreatened', true);
        }
        rings.clear();
        for (const [deco, now] of want) rings.set(deco, now);
    }

    function callDeco(deco, method, on) {
        try { deco[method]?.(on); } catch (e) { log('deco', method, 'failed', e); }
    }

    // Turns every ring off. forget: the units were rebuilt (setCast), so old decos are just dropped.
    function clearRings({ forget = false } = {}) {
        if (forget) rings.clear();
        else applyRings(new Map());
    }

    // Screen reader announcement (aria-live region)
    function announce(text) {
        if (!el.announce) return;
        el.announce.textContent = '';
        el.announce.textContent = text;
    }

    function describeMove(ev, s) {
        const who = `${sideName(ev.color)} ${PIECE_NAMES[ev.piece.toLowerCase()]}`;
        let text = ev.castling
            ? `${sideName(ev.color)} castles ${ev.to.col > ev.from.col ? 'kingside' : 'queenside'}.`
            : `${who} ${squareName(ev.from)} to ${squareName(ev.to)}` +
              (ev.captured ? `, takes ${PIECE_NAMES[ev.captured.piece.toLowerCase()]}` : '') +
              (ev.promotion ? `, promotes to ${PIECE_NAMES[ev.promotion.toLowerCase()]}` : '') + '.';
        if (s.over) text += ' ' + s.message;
        else if (s.inCheck) text += ' Check.';
        return text;
    }

    function clearSelection() {
        st.selected = null;
        st.moves = [];
    }

    // --- HUD ---
    function sideName(c) { return c === 'w' ? 'White' : 'Black'; }

    function updateHud() {
        const s = status();
        // While a move animates, check and the result are not revealed until their scene plays
        const showCheck = st.moving ? st.phase === 'check' : !s.over && s.inCheck;
        const showOver = !st.moving && s.over;
        let text;
        if (st.error) text = st.error;
        else if (st.reviewIndex !== null) text = reviewText(st.reviewIndex);
        else if (st.moving && st.phase === 'check') text = `${sideName(gs().currentPlayer)} is in check!`;
        else if (st.moving) text = st.anim?.capture ? 'Battle in progress...' : `${sideName(st.anim?.color)} is moving...`;
        else if (showOver) text = s.message;
        else if (thinking()) text = `${sideName(gs().currentPlayer)} (AI ${eloLabel(st.elo)}) is thinking...`;
        else if (st.pendingPromotion) text = 'Choose a promotion piece.';
        else if (st.hintHandle) text = 'Thinking of a hint...';
        else if (st.hint) text = hintText(st.hint);
        else text = s.message + (st.mode === 'human-ai' && isHumanTurn() ? ' Your move.' : '');
        el.statusText.textContent = text;
        el.statusText.title = text;
        el.turnDot.className = `turn-dot ${st.moving && st.phase === 'move' ? st.anim?.color : gs().currentPlayer}`;
        el.statusLine.classList.toggle('thinking', !st.moving && !s.over && (thinking() || !!st.hintHandle));
        el.statusLine.classList.toggle('check', showCheck);
        el.statusLine.classList.toggle('over', showOver);

        el.undo.disabled = st.moving || st.pendingPromotion !== null || undoPlies() === 0;
        el.skip.disabled = !st.moving;
        if (el.hint) {
            el.hint.disabled = !canHint();
            el.hint.classList.toggle('busy', !!st.hintHandle);
            el.hint.setAttribute('aria-busy', String(!!st.hintHandle));
        }
        el.sideW.disabled = el.sideB.disabled = st.mode === 'ai-ai';
        el.sideLabel.textContent = st.mode === 'human-human' ? 'View from' : 'Play as';
        el.eloRow.classList.toggle('disabled', st.mode === 'human-human');
        el.elo.disabled = st.mode === 'human-human';
        setSeg(el.sideW, el.sideB, st.humanColor === 'w');
        setSeg(el.speedFull, el.speedFast, st.speed === 'full');
        el.mode.value = st.mode;
        el.eloValue.textContent = eloLabel(st.elo);
        el.labels.checked = st.labels;
        if (el.mute) {
            el.mute.setAttribute('aria-pressed', String(st.muted));
            el.mute.title = st.muted ? 'Sound off (click to unmute)' : 'Sound on (click to mute)';
        }
        if (el.ambience) {
            el.ambience.checked = st.ambience;
            el.ambience.disabled = st.muted;
        }
    }

    function persist() {
        saveSettings({ mode: st.mode, humanColor: st.humanColor, elo: st.elo, speed: st.speed, labels: st.labels, muted: st.muted, ambience: st.ambience });
    }

    function setSeg(a, b, aActive) {
        a.classList.toggle('active', aActive);
        b.classList.toggle('active', !aActive);
        a.setAttribute('aria-pressed', String(aActive));
        b.setAttribute('aria-pressed', String(!aActive));
    }

    function renderMoveList() {
        el.moveList.textContent = '';
        let li = null;
        let count = 0;
        // The move being animated is listed once its scene has played (its +/# would spoil it)
        const last = gs().currentMoveIndex - (st.moving && st.phase === 'move' ? 1 : 0);
        for (let i = 1; i <= last; i++) {
            const entry = gs().gameHistory[i];
            if (!entry?.moveNotation) continue;
            const mover = gs().gameHistory[i - 1].currentPlayer;
            if (mover === 'w' || !li) {
                li = document.createElement('li');
                const num = document.createElement('span');
                num.className = 'num';
                num.textContent = `${entry.moveNumber}.`;
                li.append(num);
                if (mover === 'b') li.append(document.createElement('span')); // black moved first (e.g. after a FEN load)
                el.moveList.append(li);
            }
            const span = document.createElement('span');
            span.textContent = entry.moveNotation;
            span.dataset.index = String(i);
            span.className = 'mv' + (i === last && st.reviewIndex === null ? ' last' : '') + (i === st.reviewIndex ? ' reviewed' : '');
            li.append(span);
            count++;
            if (mover === 'b') li = null;
        }
        el.moveCount.textContent = count ? `(${count})` : '';
        el.moveList.scrollTop = el.moveList.scrollHeight;
    }

    // --- AI ---
    function cancelAI() {
        st.aiToken++;
        st.aiWaiting = false;
        if (st.aiHandle) {
            const handle = st.aiHandle;
            st.aiHandle = null;
            handle.cancel();
        }
    }

    async function maybeStartAI() {
        if (st.moving || thinking() || st.reviewIndex !== null || gs().isGameOver || isHumanTurn()) return;
        const version = st.version;
        const token = st.aiToken;
        st.aiWaiting = true;
        updateHud();
        await wait(AI_PAUSE[st.mode] ?? 0.25);
        if (token !== st.aiToken || version !== st.version) return;
        st.aiWaiting = false;

        let handle;
        try {
            handle = g.requestAIMove(g.getCurrentGameStateSnapshot(), st.elo);
        } catch (error) {
            console.error('battle3d: AI request failed to start', error);
            st.error = 'AI error: could not compute a move.';
            updateHud();
            return;
        }
        st.aiHandle = handle;
        updateHud();
        let move = null;
        try {
            move = await handle.promise;
        } catch (error) {
            console.error('battle3d: AI request failed', error);
        }
        if (st.aiHandle !== handle) return; // cancelled or superseded
        st.aiHandle = null;
        if (version !== st.version) { maybeStartAI(); return; }
        if (!move?.from || !move?.to) {
            st.error = 'AI could not find a move.';
            updateHud();
            return;
        }
        log('AI move', move);
        await playMove(move.from, move.to, move.promotionPiece || 'Q', true);
    }

    // --- Moves ---
    async function playMove(from, to, promotion, isAI) {
        if (st.reviewIndex !== null) exitReview({ quiet: true });
        const keyBefore = g.battle3dFen();
        const stateBefore = g.getCurrentGameStateSnapshot();
        const thinkSeconds = st.turnStartedAt ? (now() - st.turnStartedAt) / 1000 : 0;
        const resets = st.resets;
        let ev;
        try {
            ev = g.battle3dApplyMove(from, to, promotion);
        } catch (error) {
            console.error('battle3d: move rejected', error);
            st.error = isAI ? 'AI error: returned an illegal move.' : null;
            updateHud();
            return false;
        }
        ev.isAI = isAI;
        clearHint();
        const analysisAfter = analyzeCurrent(); // runs in the worker while the scene plays
        log('move', ev.notation, ev);
        const version = ++st.version;
        st.moving = true;
        st.phase = 'move';
        st.anim = { color: ev.color, capture: !!ev.captured };
        st.error = null;
        clearSelection();
        clearRings();
        sceneAPI.keepAlive?.('controller-move', true);
        refreshHighlights();
        renderMoveList();
        updateHud();

        await runAnimation(() => units.playMove(ev), 'playMove');
        if (version !== st.version) return true; // new game / undo while animating
        ensureBoardInSync();

        const s = status();
        st.phase = s.over ? 'finale' : s.inCheck ? 'check' : 'move';
        refreshHighlights();
        renderMoveList();
        updateHud();
        announce(describeMove(ev, s));
        // units.js plays every motion and fight sound, including castle and the victory cheer at mate;
        // the controller adds only the game-state cues: check, checkmate, draw
        if (s.over) {
            const king = g.findKing(gs().currentPlayer);
            const mate = s.result === 'checkmate';
            sfx(mate ? 'checkmate' : 'draw', king);
            await runAnimation(() => units.playGameOver({
                result: mate ? 'checkmate' : s.result === 'stalemate' ? 'stalemate' : 'draw',
                loser: mate ? gs().currentPlayer : null,
                kingSquare: king
            }), 'playGameOver');
        } else if (s.inCheck) {
            const king = g.findKing(gs().currentPlayer);
            await runAnimation(() => units.playCheck(king), 'playCheck');
            if (version === st.version) sfx('check', king);
        }
        if (version !== st.version) return true;

        endMoving();
        refreshHighlights();
        renderMoveList();
        updateHud();
        try { onMoveEnd?.(ev); } catch (e) { log('onMoveEnd failed', e); }

        // A review requested during the animation opens now (the AI then waits until the player returns)
        if (st.pendingReview) {
            const [index, opts] = st.pendingReview;
            st.pendingReview = null;
            enterReview(index, opts);
        }
        // The analysis runs in its own worker, so the AI starts right away
        maybeStartAI();

        // Commentary and coach events: wait briefly for this position's analysis (it ran during the scene)
        let after = analysisAfter?.result ?? null;
        if (!after && analysisAfter) {
            // Give up only when both the scene clock and the wall clock have run out (tests step the scene fast)
            const giveUp = Promise.all([wait(ANALYSIS_WAIT_SECONDS), new Promise(r => setTimeout(r, ANALYSIS_WAIT_SECONDS * 1000))]);
            after = await Promise.race([analysisAfter.promise, giveUp.then(() => null)]);
        }
        if (resets === st.resets) {
            const before = analysisCache.get(keyBefore)?.result ?? null;
            await emitMoveEvents(ev, s, { before, after, stateBefore, thinkSeconds });
            if (version === st.version) startTurn(); // a newer move emits its own turn
        }
        return true;
    }

    function endMoving() {
        sceneAPI.keepAlive?.('controller-move', false);
        sceneAPI.requestRender?.();
        st.moving = false;
        st.phase = null;
        st.anim = null;
    }

    // Runs a units animation with a scene-clock watchdog; never throws and never hangs the game.
    async function runAnimation(start, name) {
        let timedOut = false;
        const watchdog = wait(MOVE_WATCHDOG_SECONDS).then(() => { timedOut = true; });
        try {
            await Promise.race([Promise.resolve().then(start), watchdog]);
        } catch (error) {
            console.error(`battle3d: units.${name} failed`, error);
            safeSync();
        }
        if (timedOut) {
            console.warn(`battle3d: units.${name} timed out, skipping`);
            try { units.skip(); } catch (e) { /* ignore */ }
            safeSync();
        }
    }

    function safeSync() {
        try { units.syncBoard(gs().board); } catch (error) { console.error('battle3d: syncBoard failed', error); }
        clearRings({ forget: true }); // syncBoard may rebuild units; the next refreshHighlights reapplies rings
    }

    // Cheap consistency check after an animation: every occupied square has a unit and vice versa.
    function ensureBoardInSync() {
        if (typeof units.unitAt !== 'function') return;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (!!gs().board[r][c] !== !!units.unitAt(r, c)) {
                    log('units out of sync at', r, c, '- resyncing');
                    safeSync();
                    return;
                }
            }
        }
    }

    // --- Input ---
    // Plays a sound at a board square (stereo position follows the camera)
    function sfx(name, square = null, opts = {}) {
        if (!audio) return;
        let pos = null;
        try { if (square) pos = sceneAPI.squareToWorld?.(square.row, square.col) || null; } catch (e) { pos = null; }
        audio.play(name, { ...opts, pos });
    }

    function castlingTowardRook(from, moves, row, col) {
        const king = g.getPieceAt(from.row, from.col), rook = g.getPieceAt(row, col);
        if (!king || king.toUpperCase() !== 'K' || !rook || rook !== (king === 'K' ? 'R' : 'r') || row !== from.row) return null;
        return moves.find(m => m.isCastling && Math.sign(m.col - from.col) === Math.sign(col - from.col)) || null;
    }

    function onSquareClick(row, col) {
        if (row === null || row === undefined) return;
        if (inputLocked()) {
            // Not your turn (AI thinking, opponent's move): a dull knock says "not now"
            if (!st.moving && !gs().isGameOver && !st.pendingPromotion) sfx('invalid', { row, col });
            return;
        }
        const piece = g.getPieceAt(row, col);
        if (st.selected) {
            // King then own rook castles toward that rook (the rook's pick proxy can also cover g1/c1)
            const move = st.moves.find(m => m.row === row && m.col === col) ||
                castlingTowardRook(st.selected, st.moves, row, col);
            if (move) {
                const from = st.selected;
                if (move.isPromotion) {
                    openPromotion(from, { row, col });
                } else {
                    playMove(from, { row: move.row, col: move.col }, null, false);
                }
                return;
            }
        }
        const own = piece && g.getPlayerForPiece(piece) === gs().currentPlayer;
        const sameSquare = st.selected && st.selected.row === row && st.selected.col === col;
        // A suggested piece (hint, "Show me better") is already selected: clicking it is "pick it up", not "put it down"
        if (sameSquare && st.hint && st.hint.from.row === row && st.hint.from.col === col && !st.hint.picked) {
            st.hint.picked = true;
            sfx('select', { row, col });
            return;
        }
        if (own && !sameSquare) {
            st.selected = { row, col };
            st.moves = g.generateLegalMoves(row, col);
            sfx(st.moves.length ? 'select' : 'invalid', { row, col });
        } else {
            // Re-clicking the selected unit cancels; any other square is not a legal target
            if (st.selected) sfx(sameSquare ? 'deselect' : 'invalid', { row, col });
            else if (piece) sfx('invalid', { row, col });
            clearSelection();
        }
        // A click on the board cancels a hint still being computed; a shown hint stays only while its piece is selected
        if (st.hintHandle || (st.hint && !(st.selected && st.selected.row === st.hint.from.row && st.selected.col === st.hint.from.col))) clearHint();
        refreshHighlights();
        updateHud();
    }

    function onSquareHover(row, col) {
        const next = row === null || row === undefined ? null : { row, col };
        if (next?.row === st.hover?.row && next?.col === st.hover?.col) return;
        st.hover = next;
        st.cursor = null; // the mouse takes over from the keyboard cursor
        refreshHighlights();
    }

    function openPromotion(from, to) {
        st.pendingPromotion = { from, to };
        const white = gs().currentPlayer === 'w';
        el.promo.querySelectorAll('button[data-piece]').forEach(button => {
            const type = button.dataset.piece;
            button.querySelector('.glyph').textContent = GLYPHS[white ? type : type.toLowerCase()];
        });
        el.promo.hidden = false;
        el.promo.querySelector('button[data-piece]').focus();
        updateHud();
    }

    function closePromotion() {
        st.pendingPromotion = null;
        el.promo.hidden = true;
    }

    function choosePromotion(type) {
        const pending = st.pendingPromotion;
        if (!pending) return;
        closePromotion();
        playMove(pending.from, pending.to, type, false);
    }

    function cancelPromotion() {
        if (!st.pendingPromotion) return;
        closePromotion();
        clearSelection();
        refreshHighlights();
        updateHud();
    }

    // --- Hint ---
    const canHint = () => !st.moving && !thinking() && !st.hintHandle && !st.pendingPromotion && st.reviewIndex === null &&
        !gs().isGameOver && st.mode !== 'ai-ai' && isHumanTurn();

    function hintText(h) {
        if (h.castling) return `Hint: castle ${h.to.col > h.from.col ? 'kingside' : 'queenside'}.`;
        let text = `Hint: ${PIECE_NAMES[h.piece.toLowerCase()]} to ${squareName(h.to)}`;
        if (h.capture) text += ', capture';
        if (h.promotion) text += `, promote to ${PIECE_NAMES[h.promotion.toLowerCase()]}`;
        return text + '.';
    }

    // Asks the AI for the best move at full strength and shows it; the player still makes the move.
    async function requestHint() {
        if (!canHint()) return;
        const token = ++st.hintToken;
        const version = st.version;
        let handle;
        try {
            handle = g.requestAIMove(g.getCurrentGameStateSnapshot(), HINT_ELO, { hint: true });
        } catch (error) {
            console.error('battle3d: hint request failed to start', error);
            return;
        }
        st.hintHandle = handle;
        updateHud();
        let move = null;
        try { move = await handle.promise; } catch (error) { console.error('battle3d: hint failed', error); }
        if (token !== st.hintToken || st.hintHandle !== handle) return; // cleared or superseded
        st.hintHandle = null;
        if (version !== st.version || !move?.from || !move?.to) {
            updateHud();
            return;
        }
        if (!showSuggestion(move)) { updateHud(); return; }
        emit('hintUsed', { color: gs().currentPlayer, hint: { from: st.hint.from, to: st.hint.to } }); // the user's own king
    }

    // Shows a suggested move as the hint arrow with the piece pre-selected (hint button, coach "Show me better").
    // Returns false when the move is not legal in the current position.
    function showSuggestion(move) {
        if (!move?.from || !move?.to || st.moving || st.reviewIndex !== null || !isHumanTurn() || gs().isGameOver) return false;
        const piece = g.getPieceAt(move.from.row, move.from.col);
        if (!piece || g.getPlayerForPiece(piece) !== gs().currentPlayer) return false;
        const legal = g.generateLegalMoves(move.from.row, move.from.col);
        const target = legal.find(m => m.row === move.to.row && m.col === move.to.col);
        if (!target) return false;
        clearHint();
        st.hint = {
            from: { row: move.from.row, col: move.from.col },
            to: { row: move.to.row, col: move.to.col },
            capture: !!g.getPieceAt(move.to.row, move.to.col) || !!target.isEnPassant,
            piece,
            promotion: target.isPromotion ? (move.promotionPiece || 'Q') : null,
            castling: !!target.isCastling
        };
        // Pre-select the suggested unit so one click on the target plays it
        st.selected = { ...st.hint.from };
        st.moves = legal;
        st.cursor = null;
        try { sceneAPI.setHint?.({ from: st.hint.from, to: st.hint.to, capture: st.hint.capture }); } catch (e) { log('setHint failed', e); }
        if (typeof units.playHint === 'function') {
            // The gesture plays its own soft select sound
            const from = st.hint.from;
            Promise.resolve().then(() => units.playHint(from)).catch(e => log('playHint failed', e));
        } else {
            sfx('select', st.hint.from);
        }
        refreshHighlights();
        updateHud();
        announce(hintText(st.hint));
        return true;
    }

    // Removes the shown hint and cancels a running hint request
    function clearHint() {
        st.hintToken++;
        if (st.hintHandle) {
            const handle = st.hintHandle;
            st.hintHandle = null;
            try { handle.cancel(); } catch (e) { /* ignore */ }
        }
        if (st.hint) {
            st.hint = null;
            try { sceneAPI.setHint?.(null); } catch (e) { log('setHint failed', e); }
        }
    }

    // --- Game events (commentary.js, coach.js) ---
    // Each line-bank event carries `color` = the king who would naturally say it (its own point of view).
    // Lifecycle events for the coach: reset, turn, moveDone. Unknown types are ignored by listeners.
    const eventListeners = new Set();

    function onEvent(fn) {
        eventListeners.add(fn);
        return () => eventListeners.delete(fn);
    }

    function emit(type, data = {}) {
        const event = { type, ply: gs().currentMoveIndex, mode: st.mode, humanColor: st.humanColor, aiElo: st.elo, ...data };
        for (const fn of [...eventListeners]) {
            try { fn(event); } catch (e) { log('event listener failed', type, e); }
        }
        try { window.dispatchEvent(new CustomEvent('game:event', { detail: event })); } catch (e) { /* no DOM events */ }
    }

    function resetEventState() {
        st.bigSide = null;
        st.endgameAnnounced = false;
        st.repeated.clear();
    }

    function startTurn() {
        st.turnStartedAt = now();
        if (!gs().isGameOver) analyzeCurrent(); // usually cached from the move's scene; new game / undo start it here
        emit('turn', { color: gs().currentPlayer, human: isHumanTurn(), over: !!gs().isGameOver });
    }

    // Centipawns from White's point of view (requestAnalysis: eval is White-POV cp, mates +-(100000 - plies))
    function evalCp(result) {
        if (!result) return null;
        const e = result.eval ?? result.score ?? result;
        if (typeof e === 'number') return Number.isFinite(e) ? e : null;
        if (e && typeof e === 'object') {
            if (Number.isFinite(e.mate)) return Math.sign(e.mate || 1) * (10000 - 10 * Math.abs(e.mate));
            if (Number.isFinite(e.cp)) return e.cp;
        }
        return null;
    }
    const povCp = (cp, color) => (cp === null ? null : color === 'w' ? cp : -cp);

    // Lichess-style win% model; classifyMove from the engine wins when it exists
    function classify(beforeCp, afterCp, mover, played, bestBefore) {
        if (beforeCp === null || afterCp === null) return null;
        if (typeof g.classifyMove === 'function') {
            try { const c = g.classifyMove(beforeCp, afterCp, mover); if (c) return c; } catch (e) { log('classifyMove failed', e); }
        }
        const win = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
        const drop = win(povCp(beforeCp, mover)) - win(povCp(afterCp, mover));
        if (drop >= 30) return 'blunder';
        if (drop >= 20) return 'mistake';
        if (drop >= 10) return 'inaccuracy';
        if (bestBefore && sameMove(bestBefore, played)) return 'best';
        return 'good';
    }
    const sameMove = (a, b) => a && b && a.from?.row === b.from?.row && a.from?.col === b.from?.col &&
        a.to?.row === b.to?.row && a.to?.col === b.to?.col;

    let tacticsModule;
    function loadTactics() {
        tacticsModule ??= import('./tactics.js').catch(() => null);
        return tacticsModule;
    }

    async function emitMoveEvents(ev, s, { before, after, stateBefore, thinkSeconds }) {
        const mover = ev.color, other = opponent(mover);
        const evalBefore = evalCp(before), evalAfter = evalCp(after);
        const played = { from: ev.from, to: ev.to, promotion: ev.promotion };
        const classification = classify(evalBefore, evalAfter, mover, played, before?.bestMove);
        let motifs = [];
        if (classification) {
            const tactics = await loadTactics();
            try {
                motifs = tactics?.detect?.(stateBefore, { from: ev.from, to: ev.to, promotionPiece: ev.promotion },
                    g.getCurrentGameStateSnapshot(), { before, after }) || [];
            } catch (e) { log('tactics failed', e); }
        }
        const brilliant = classification === 'best' && !s.over && isSacrifice(ev);
        const base = {
            mover, brilliant, piece: ev.piece, square: ev.to, from: ev.from, captured: ev.captured?.piece || null,
            evalBefore, evalAfter, classification, motif: motifs[0]?.motif || null, motifs,
            thinkSeconds, isAI: !!ev.isAI, notation: ev.notation
        };
        const out = [];
        const push = (color, type, extra) => out.push([type, { ...base, color, ...extra }]);

        if (ev.captured) {
            const queen = ev.captured.piece.toLowerCase() === 'q';
            push(mover, queen ? 'capturedQueen' : 'myCapture');
            push(other, queen ? 'lostQueen' : 'lostPiece');
        }
        if (ev.castling) push(mover, 'castle');
        if (ev.enPassant) push(mover, 'enPassant');
        if (ev.promotion) push(mover, 'promotion');
        if (s.over) {
            if (s.result === 'checkmate') { push(mover, 'checkmateWin'); push(other, 'checkmateLoss'); }
            else if (s.result === 'stalemate') { push(mover, 'stalemate'); push(other, 'stalemate'); }
            else { push(mover, 'draw', { reason: s.result }); push(other, 'draw', { reason: s.result }); }
        } else {
            if (s.inCheck) { push(mover, 'check'); push(other, 'gotChecked'); }
            const key = g.getBoardPositionString(gs().gameHistory[gs().currentMoveIndex]);
            if (repetitions() >= 2 && !st.repeated.has(key)) { st.repeated.add(key); push(mover, 'repetition'); push(other, 'repetition'); }
            if (!st.endgameAnnounced && isEndgame()) { st.endgameAnnounced = true; push(mover, 'endgame'); push(other, 'endgame'); }
            if (classification === 'blunder') { push(mover, 'blunderByMe'); push(other, 'blunderByOpponent'); }
            else if (brilliant) push(mover, 'brilliantMove');
            const moverCp = povCp(evalAfter, mover);
            if (moverCp !== null) {
                if (Math.abs(evalAfter) < BIG_EVAL_RESET) st.bigSide = null;
                const leader = evalAfter >= BIG_EVAL ? 'w' : evalAfter <= -BIG_EVAL ? 'b' : null;
                if (leader && leader !== st.bigSide && Math.abs(evalAfter) < 9000) {
                    st.bigSide = leader;
                    push(leader, 'winningBig'); push(opponent(leader), 'losingBig');
                }
                const mate = after?.mate; // moves to mate, + White mates, - Black mates
                if (Number.isFinite(mate) && mate !== 0 && (mate > 0) === (mover === 'w') && Math.abs(mate) <= 2 && !s.inCheck) push(mover, 'mateThreat');
            }
            if (!ev.isAI && thinkSeconds >= 30) push(other, 'longThink');
        }
        for (const [type, data] of out) emit(type, data);
        emit('moveDone', {
            ...base, color: mover, ev, status: s, before, after, stateBefore,
            bestBefore: before?.bestMove || null, alternatives: before?.alternatives || null
        });
    }

    function repetitions() {
        const hist = gs().gameHistory, idx = gs().currentMoveIndex;
        const current = g.getBoardPositionString(hist[idx]);
        let n = 0;
        for (let i = 0; i <= idx; i++) if (g.getBoardPositionString(hist[i]) === current) n++;
        return n;
    }

    // Endgame: no queens, or at most one minor/rook per side besides pawns
    function isEndgame() {
        let queens = 0, minors = 0;
        for (const row of gs().board) for (const p of row) {
            if (!p) continue;
            const t = p.toLowerCase();
            if (t === 'q') queens++;
            else if (t !== 'p' && t !== 'k') minors += PIECE_VALUES[t];
        }
        return queens === 0 ? minors <= 16 : minors <= 6;
    }

    // A best move that leaves a more valuable piece where the opponent can take it
    function isSacrifice(ev) {
        const moved = (ev.promotion || ev.piece).toLowerCase();
        const gained = ev.captured ? PIECE_VALUES[ev.captured.piece.toLowerCase()] : 0;
        if (PIECE_VALUES[moved] - gained < 2) return false;
        try { return g.isSquareAttacked(ev.to.row, ev.to.col, opponent(ev.color)); } catch (e) { return false; }
    }

    // --- Analysis (elo-engine's requestAnalysis in the worker), cached per position ---
    const analysisNeeds = new Map(); // source -> { nodes, multiPv }
    const analysisCache = new Map(); // fen -> { nodes, multiPv, handle, result, promise }

    function setAnalysisNeed(source, opts) {
        if (opts) analysisNeeds.set(source, opts); else analysisNeeds.delete(source);
    }

    function analysisOptions() {
        let nodes = 0, multiPv = 1;
        for (const o of analysisNeeds.values()) { nodes = Math.max(nodes, o.nodes || 0); multiPv = Math.max(multiPv, o.multiPv || 1); }
        return nodes > 0 ? { nodes, multiPv } : null;
    }

    function analyzeCurrent() {
        const opts = analysisOptions();
        return opts ? analyzeState(g.getCurrentGameStateSnapshot(), g.battle3dFen(), opts) : null;
    }

    // Analysis of any position (current or from the history), cached under its FEN key
    function analyzeState(state, key, opts) {
        if (!opts || !state || typeof g.requestAnalysis !== 'function') return null;
        const cached = analysisCache.get(key);
        if (cached && cached.nodes >= opts.nodes && cached.multiPv >= opts.multiPv) return cached;
        let handle;
        try { handle = g.requestAnalysis(state, opts); } catch (e) { log('analysis failed to start', e); return null; }
        const entry = { ...opts, handle, result: null, promise: null };
        entry.promise = Promise.resolve(handle?.promise).then(result => {
            entry.handle = null;
            entry.result = result || null;
            if (!result && analysisCache.get(key) === entry) analysisCache.delete(key);
            return entry.result;
        }, error => {
            log('analysis failed', error);
            if (analysisCache.get(key) === entry) analysisCache.delete(key);
            return null;
        });
        analysisCache.set(key, entry);
        if (analysisCache.size > 300) analysisCache.delete(analysisCache.keys().next().value);
        return entry;
    }

    function cancelAnalyses() {
        for (const [key, entry] of [...analysisCache]) {
            if (!entry.handle) continue;
            analysisCache.delete(key);
            try { entry.handle.cancel(); } catch (e) { /* ignore */ }
        }
    }

    // Coach / review: analysis of the current position, or null when unavailable
    function analysisFor(key = g.battle3dFen()) {
        return analysisCache.get(key) || null;
    }

    // --- Per-ply judgement (coach verdicts, game review) ---
    // Same key format as battle3dFen(), so live analyses and history lookups share the cache
    const historyKey = (entry) => `${g.getBoardPositionString(entry)} ${entry.halfmoveClock} ${entry.fullmoveNumber}`;

    function historyState(index) {
        const hist = gs().gameHistory, e = hist[index];
        if (!e) return null;
        return {
            board: e.board.map(row => row.slice()),
            currentPlayer: e.currentPlayer,
            castlingRights: JSON.parse(JSON.stringify(e.castlingRights)),
            enPassantTarget: e.enPassantTarget ? { ...e.enPassantTarget } : null,
            halfmoveClock: e.halfmoveClock,
            fullmoveNumber: e.fullmoveNumber,
            positionHistory: hist.slice(0, index + 1).map(h => g.getBoardPositionString(h))
        };
    }

    // Facts about the move that led to history entry `index` (no engine needed)
    function plyInfo(index) {
        const hist = gs().gameHistory, prev = hist[index - 1], cur = hist[index];
        if (!prev || !cur?.lastMove) return null;
        const { from, to } = cur.lastMove;
        const piece = prev.board[from.row][from.col];
        const placed = cur.board[to.row][to.col];
        const promotion = piece && placed && piece.toLowerCase() === 'p' && placed.toLowerCase() !== 'p' ? placed.toUpperCase() : null;
        return {
            ply: index, mover: prev.currentPlayer, piece, from: { ...from }, to: { ...to }, promotion,
            captured: prev.board[to.row][to.col] || null, notation: cur.moveNotation, moveNumber: cur.moveNumber,
            human: !isAIColor(prev.currentPlayer)
        };
    }

    // Engine verdict on the move that led to history entry `index`: waits for the analyses of the positions
    // before and after it (requesting them when missing), however long they take. Resolves null when the
    // engine is unavailable, the request was cancelled (new game, undo) or the move no longer exists.
    async function judgePly(index, opts = analysisOptions() || { nodes: 200000, multiPv: 1 }) {
        const hist = gs().gameHistory, prev = hist[index - 1], cur = hist[index];
        const info = plyInfo(index);
        if (!info) return null;
        const stateBefore = historyState(index - 1), stateAfter = historyState(index);
        const entryBefore = analyzeState(stateBefore, historyKey(prev), opts);
        const entryAfter = analyzeState(stateAfter, historyKey(cur), opts);
        if (!entryBefore || !entryAfter) return null;
        const [before, after] = await Promise.all([entryBefore.promise, entryAfter.promise]);
        if (!before || !after || gs().gameHistory[index] !== cur) return null;
        const evalBefore = evalCp(before), evalAfter = evalCp(after);
        const played = { from: info.from, to: info.to, promotionPiece: info.promotion };
        const classification = classify(evalBefore, evalAfter, info.mover, played, before.bestMove);
        let motifs = [], brilliant = false;
        const tactics = await loadTactics();
        try {
            motifs = tactics?.detect?.(stateBefore, played, stateAfter, { before, after }) || [];
            // Brilliant: a best move that really leaves a piece (not a pawn) to be taken
            const moved = (info.promotion || info.piece || '').toLowerCase();
            const square = squareName(info.to);
            brilliant = classification === 'best' && !after.terminal && PIECE_VALUES[moved] >= 3 &&
                (tactics?.hangingPieces?.(stateAfter, info.mover) || []).some(h => h.square === square);
        } catch (e) { log('tactics failed', e); }
        return {
            ...info, evalBefore, evalAfter, classification, motifs, brilliant, stateBefore,
            bestBefore: before.bestMove || null, playedBest: sameMove(before.bestMove, played), mateAfter: after.mate ?? null
        };
    }

    // --- Review mode: look at an earlier position without changing the game ---
    function reviewText(i) {
        if (st.reviewNote) return st.reviewNote;
        const entry = gs().gameHistory[i];
        if (!entry || i === 0) return 'Reviewing the start position. Esc returns to the game.';
        const mover = gs().gameHistory[i - 1].currentPlayer;
        return `Reviewing ${entry.moveNumber}${mover === 'w' ? '.' : '...'} ${entry.moveNotation}. Esc returns to the game.`;
    }

    // Shows history position `index`. Options: lastMove (squares to highlight instead of the move that led
    // there), arrows ([{ from, to, kind: 'played' | 'better', capture }] drawn with sceneAPI.setArrows; without
    // that API the 'better' arrow falls back to the hint arrow), arrow (a single suggested move), text (status).
    // While a move animates the animation is skipped and the review opens right after (returns 'pending').
    function enterReview(index, { lastMove, arrow = null, arrows = null, text = null, force = false } = {}) {
        const hist = gs().gameHistory;
        if (!Number.isInteger(index) || index < 0 || index >= hist.length) return false;
        if (st.pendingPromotion) cancelPromotion();
        if (st.moving) {
            st.pendingReview = [index, { lastMove, arrow, arrows, text, force }];
            try { units.skip(); sceneAPI.skipEffects?.(); } catch (e) { /* ignore */ }
            return 'pending';
        }
        if (index === gs().currentMoveIndex && st.reviewIndex === null && !force && !arrow && !arrows) return false;
        st.reviewNote = text;
        cancelAI();
        clearHint();
        closePromotion();
        clearSelection();
        clearRings();
        st.reviewIndex = index;
        try { units.syncBoard(hist[index].board); } catch (e) { log('review sync failed', e); }
        clearRings({ forget: true });
        sceneAPI.setHighlights({ selected: null, moves: [], lastMove: lastMove !== undefined ? lastMove : (hist[index].lastMove || null), check: null, hover: null });
        showReviewArrows(arrows, arrow);
        sceneAPI.requestRender?.();
        el.reviewBar && (el.reviewBar.hidden = false);
        renderMoveList();
        updateHud();
        announce(reviewText(index));
        emit('review', { index });
        return true;
    }

    // Review arrows: the multi-arrow layer when the scene has it, else the single hint arrow for the better move
    function showReviewArrows(arrows, arrow = null) {
        const list = (arrows || []).filter(a => a?.from && a?.to).map(a => ({ from: { ...a.from }, to: { ...a.to }, kind: a.kind === 'better' ? 'better' : 'played', capture: !!a.capture }));
        let single = arrow;
        try {
            if (typeof sceneAPI.setArrows === 'function') sceneAPI.setArrows(list.length ? list : null);
            else single = single || list.find(a => a.kind === 'better') || null;
            sceneAPI.setHint?.(single ? { from: single.from, to: single.to, capture: !!single.capture } : null);
        } catch (e) { log('review arrows failed', e); }
    }

    function clearReviewArrows() {
        try { sceneAPI.setArrows?.(null); sceneAPI.setHint?.(null); } catch (e) { /* ignore */ }
    }

    function exitReview({ quiet = false } = {}) {
        st.pendingReview = null;
        if (st.reviewIndex === null) return;
        st.reviewIndex = null;
        st.reviewNote = null;
        clearReviewArrows();
        el.reviewBar && (el.reviewBar.hidden = true);
        safeSync();
        refreshHighlights();
        renderMoveList();
        updateHud();
        if (!quiet) {
            emit('review', { index: null });
            maybeStartAI();
        }
    }

    // --- Commands ---
    // Stops anything in flight and invalidates pending async continuations.
    function abortInFlight() {
        clearRings(); // before units are skipped and resynced
        clearHint();
        cancelAnalyses();
        st.resets++;
        st.pendingReview = null;
        st.reviewNote = null;
        if (st.reviewIndex !== null) clearReviewArrows();
        st.reviewIndex = null;
        if (el.reviewBar) el.reviewBar.hidden = true;
        cancelAI();
        closePromotion();
        st.version++; // stale scene-clock waits still resolve, their continuations see the new version
        if (st.moving) {
            try { units.skip(); } catch (e) { /* ignore */ }
            endMoving();
        }
        clearSelection();
        st.error = null;
    }

    function resyncView() {
        safeSync();
        refreshHighlights();
        renderMoveList();
        updateHud();
    }

    function newGame() {
        abortInFlight();
        g.battle3dNewGame();
        resetEventState();
        resyncView();
        sceneAPI.setView(viewSide(), { animate: true });
        emit('reset', { reason: 'newGame' });
        emit('gameStart', { color: 'w' });
        emit('gameStart', { color: 'b' });
        startTurn();
        maybeStartAI();
    }

    // Debug/test: start from an arbitrary position
    function loadFen(fen) {
        abortInFlight();
        g.battle3dLoadFen(fen);
        resetEventState();
        resyncView();
        emit('reset', { reason: 'loadFen' });
        startTurn();
        maybeStartAI();
    }

    // Plies to undo so a human vs AI game lands on the human's turn.
    function undoPlies() {
        if (gs().currentMoveIndex < 1) return 0;
        if (st.mode !== 'human-ai') return 1;
        if (gs().currentPlayer === st.humanColor) return Math.min(2, gs().currentMoveIndex);
        return 1;
    }

    function undo() {
        if (st.moving || st.pendingPromotion) return;
        const plies = undoPlies();
        if (!plies) return;
        abortInFlight();
        g.battle3dUndo(plies);
        resyncView();
        emit('reset', { reason: 'undo', plies });
        // The side that took moves back is now to move; its king speaks and the other may retort
        emit('undoUsed', { color: gs().currentPlayer });
        startTurn();
        maybeStartAI();
    }

    // Takes the game back to history position `index` (coach "Take it back"), also during an animation
    function undoTo(index) {
        const plies = gs().currentMoveIndex - index;
        if (!Number.isInteger(index) || index < 0 || plies <= 0) return false;
        abortInFlight();
        g.battle3dUndo(plies);
        resyncView();
        emit('reset', { reason: 'undo', plies });
        emit('undoUsed', { color: gs().currentPlayer });
        startTurn();
        maybeStartAI();
        return true;
    }

    function setMode(mode) {
        if (!MODES.includes(mode)) return;
        clearHint();
        cancelAI();
        closePromotion();
        st.mode = mode;
        if (mode === 'ai-ai') setSpeed('fast');
        persist();
        clearSelection();
        st.error = null;
        sceneAPI.setView(viewSide(), { animate: true });
        refreshHighlights();
        updateHud();
        // A move animation in flight finishes and then calls maybeStartAI itself
        if (!st.moving) maybeStartAI();
    }

    function setHumanColor(color) {
        if (st.mode === 'ai-ai' || color === st.humanColor) return;
        clearHint();
        cancelAI();
        closePromotion();
        st.humanColor = color;
        persist();
        clearSelection();
        sceneAPI.setView(viewSide(), { animate: true });
        refreshHighlights();
        updateHud();
        if (!st.moving) maybeStartAI();
    }

    function setSpeed(speed) {
        st.speed = speed === 'fast' ? 'fast' : 'full';
        units.setMode(st.speed);
        persist();
        updateHud();
    }

    function setLabels(on) {
        st.labels = !!on;
        units.setLabels(st.labels);
        persist();
        updateHud();
    }

    function setElo(elo) {
        st.elo = clampElo(elo);
        persist();
        updateHud();
    }

    function setAmbience(on) {
        st.ambience = !!on;
        audio?.setAmbience?.(st.ambience);
        persist();
        updateHud();
    }

    function setMuted(on) {
        st.muted = !!on;
        audio?.setMuted(st.muted);
        persist();
        updateHud();
    }

    function skip() {
        if (!st.moving) return;
        units.skip();
        sceneAPI.skipEffects?.(); // camera tween, cinematic shot, projectiles, particles
        sceneAPI.requestRender?.();
    }

    // --- Keyboard play ---
    const KEY_STEPS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };

    function moveCursor(key) {
        const flip = viewSide() === 'b' ? -1 : 1; // "up" is always away from the viewer
        if (!st.cursor) {
            st.cursor = st.selected ? { ...st.selected } : (st.hover ? { ...st.hover } : { row: viewSide() === 'w' ? 6 : 1, col: 4 });
        } else {
            const [dr, dc] = KEY_STEPS[key];
            st.cursor = {
                row: Math.max(0, Math.min(7, st.cursor.row + dr * flip)),
                col: Math.max(0, Math.min(7, st.cursor.col + dc * flip))
            };
        }
        refreshHighlights();
        const piece = g.getPieceAt(st.cursor.row, st.cursor.col);
        const isTarget = st.moves.some(m => m.row === st.cursor.row && m.col === st.cursor.col);
        announce(`${squareName(st.cursor)}${piece ? ', ' + sideName(g.getPlayerForPiece(piece)) + ' ' + PIECE_NAMES[piece.toLowerCase()] : ''}${isTarget ? ', legal move' : ''}`);
    }

    function onKeyDown(event) {
        const tag = event.target?.tagName;
        const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
        const onControl = typing || tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY';
        const modalOpen = !!document.querySelector('.modal:not([hidden])');
        if (event.key === 'Escape') {
            if (st.reviewIndex !== null && !modalOpen) { exitReview(); return; }
            if (st.pendingPromotion) cancelPromotion();
            else if (!modalOpen) {
                if (st.selected) sfx('deselect', st.selected);
                clearSelection(); st.cursor = null; clearHint(); refreshHighlights(); updateHud();
            }
            return;
        }
        if (modalOpen || typing) return;
        if ((event.key === 'h' || event.key === 'H') && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            requestHint();
        } else if (event.code === 'Space' && !onControl) {
            event.preventDefault();
            skip();
        } else if (KEY_STEPS[event.key] && !onControl) {
            event.preventDefault();
            moveCursor(event.key);
        } else if (event.key === 'Enter' && !onControl && st.cursor) {
            event.preventDefault();
            const before = st.selected;
            onSquareClick(st.cursor.row, st.cursor.col);
            if (!st.moving && st.selected && st.selected !== before) {
                announce(`Selected ${squareName(st.selected)}. ${st.moves.length} legal ${st.moves.length === 1 ? 'move' : 'moves'}.`);
            }
        }
    }

    // --- Wiring ---
    sceneAPI.onSquareClick(onSquareClick);
    sceneAPI.onSquareHover(onSquareHover);
    el.mode.addEventListener('change', () => setMode(el.mode.value));
    el.elo.addEventListener('input', () => setElo(el.elo.value));
    el.sideW.addEventListener('click', () => setHumanColor('w'));
    el.sideB.addEventListener('click', () => setHumanColor('b'));
    el.speedFull.addEventListener('click', () => setSpeed('full'));
    el.speedFast.addEventListener('click', () => setSpeed('fast'));
    el.labels.addEventListener('change', () => setLabels(el.labels.checked));
    el.newGame.addEventListener('click', newGame);
    el.undo.addEventListener('click', undo);
    el.skip.addEventListener('click', skip);
    el.hint?.addEventListener('click', requestHint);
    el.reviewExit?.addEventListener('click', () => exitReview());
    el.moveList.addEventListener('click', (event) => {
        const index = Number(event.target?.dataset?.index);
        if (!Number.isInteger(index)) return;
        if (index === gs().currentMoveIndex && st.reviewIndex !== null) exitReview();
        else enterReview(index);
    });
    el.promo.querySelectorAll('button[data-piece]').forEach(button =>
        button.addEventListener('click', () => choosePromotion(button.dataset.piece)));
    el.promoCancel.addEventListener('click', cancelPromotion);
    el.hudToggle.addEventListener('click', () => setHudCollapsed(!el.hud.classList.contains('collapsed')));
    el.mute?.addEventListener('click', () => setMuted(!st.muted));
    el.ambience?.addEventListener('change', () => setAmbience(el.ambience.checked));
    document.addEventListener('keydown', onKeyDown);

    function setHudCollapsed(collapsed) {
        el.hud.classList.toggle('collapsed', collapsed);
        el.hudToggle.setAttribute('aria-expanded', String(!collapsed));
    }
    if (window.matchMedia?.('(max-width: 640px)').matches) setHudCollapsed(true);

    // Restore stored settings (mode first: entering AI vs AI forces Fast, a stored speed wins after)
    const saved = loadSettings();
    if (MODES.includes(saved.mode)) st.mode = saved.mode;
    if (saved.humanColor === 'w' || saved.humanColor === 'b') st.humanColor = saved.humanColor;
    if (Number.isFinite(saved.elo)) st.elo = clampElo(saved.elo); // older saves may lie outside a new range
    if (saved.speed === 'full' || saved.speed === 'fast') st.speed = saved.speed;
    else if (st.mode === 'ai-ai') st.speed = 'fast';
    if (typeof saved.labels === 'boolean') st.labels = saved.labels;
    if (typeof saved.muted === 'boolean') st.muted = saved.muted;
    if (typeof saved.ambience === 'boolean') st.ambience = saved.ambience;
    el.elo.value = st.elo;
    units.setMode(st.speed);
    units.setLabels(st.labels);
    audio?.setMuted(st.muted);
    audio?.setAmbience?.(st.ambience);

    function state() {
        const s = status();
        return {
            fen: g.battle3dFen(),
            turn: gs().currentPlayer,
            busy: st.moving || thinking() || (typeof units.isBusy === 'function' && units.isBusy()),
            moving: st.moving,
            thinking: thinking(),
            history: gs().gameHistory.slice(1, gs().currentMoveIndex + 1).map(h => h.moveNotation),
            over: s.over,
            result: s.result,
            message: s.message,
            mode: st.mode,
            humanColor: st.humanColor,
            speed: st.speed,
            labels: st.labels,
            muted: st.muted,
            ambience: st.ambience,
            elo: st.elo,
            cursor: st.cursor,
            selected: st.selected,
            pendingPromotion: st.pendingPromotion,
            hint: st.hint ? { from: st.hint.from, to: st.hint.to, capture: st.hint.capture } : null,
            hintPending: !!st.hintHandle,
            reviewIndex: st.reviewIndex,
            ply: gs().currentMoveIndex
        };
    }

    return {
        newGame, loadFen, undo, setMode, setHumanColor, setSpeed, setLabels, setElo, setMuted, setAmbience, skip,
        hint: requestHint, clearHint,
        onEvent, setAnalysisNeed, showSuggestion, judgePly, plyInfo, undoTo, analyzeCurrent, analysisFor, enterReview, exitReview,
        isHumanColor: (c) => !isAIColor(c),
        viewSide,
        clickSquare: onSquareClick,
        // Cast changes rebuild every unit: drop rings before setCast, refresh() reapplies them after
        clearRings: () => clearRings(),
        forgetRings: () => clearRings({ forget: true }),
        refresh: () => { refreshHighlights(); updateHud(); },
        choosePromotion, cancelPromotion,
        // Test helper: plays a move as if a human clicked it (bypasses turn ownership checks)
        move: (from, to, promotion = null) => playMove(from, to, promotion, false),
        state
    };
}
