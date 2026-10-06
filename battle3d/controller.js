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
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const squareName = (sq) => String.fromCharCode(97 + sq.col) + (8 - sq.row);

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings(settings) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode etc. */ }
}

export function createController({ sceneAPI, units, audio = null, debug = false, log = () => {} }) {
    const $ = (id) => document.getElementById(id);
    const el = {
        hud: $('hud'), hudToggle: $('hud-toggle'),
        statusLine: document.querySelector('.status-line'), statusText: $('status-text'), turnDot: $('turn-dot'),
        mode: $('mode-select'), elo: $('elo-slider'), eloValue: $('elo-value'), eloRow: $('elo-row'),
        sideLabel: $('side-label'), sideW: $('side-w'), sideB: $('side-b'),
        speedFull: $('speed-full'), speedFast: $('speed-fast'), labels: $('labels-toggle'),
        newGame: $('new-game'), undo: $('undo'), skip: $('skip'),
        moveList: $('move-list'), moveCount: $('move-count'),
        promo: $('promo'), promoCancel: $('promo-cancel'),
        mute: $('mute'), announce: $('announce'), stage: $('stage')
    };

    const st = {
        mode: 'human-ai',
        humanColor: 'w',
        elo: 1200,
        speed: 'full',
        labels: true,
        muted: false,
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
        version: 0,              // bumped whenever the position changes underneath async work
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
    const inputLocked = () => st.moving || st.pendingPromotion !== null || gs().isGameOver || !isHumanTurn() || thinking();

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
        else if (st.moving && st.phase === 'check') text = `${sideName(gs().currentPlayer)} is in check!`;
        else if (st.moving) text = st.anim?.capture ? 'Battle in progress...' : `${sideName(st.anim?.color)} is moving...`;
        else if (showOver) text = s.message;
        else if (thinking()) text = `${sideName(gs().currentPlayer)} (AI ${st.elo}) is thinking...`;
        else if (st.pendingPromotion) text = 'Choose a promotion piece.';
        else text = s.message + (st.mode === 'human-ai' && isHumanTurn() ? ' Your move.' : '');
        el.statusText.textContent = text;
        el.statusText.title = text;
        el.turnDot.className = `turn-dot ${st.moving && st.phase === 'move' ? st.anim?.color : gs().currentPlayer}`;
        el.statusLine.classList.toggle('thinking', !st.moving && !s.over && thinking());
        el.statusLine.classList.toggle('check', showCheck);
        el.statusLine.classList.toggle('over', showOver);

        el.undo.disabled = st.moving || st.pendingPromotion !== null || undoPlies() === 0;
        el.skip.disabled = !st.moving;
        el.sideW.disabled = el.sideB.disabled = st.mode === 'ai-ai';
        el.sideLabel.textContent = st.mode === 'human-human' ? 'View from' : 'Play as';
        el.eloRow.classList.toggle('disabled', st.mode === 'human-human');
        el.elo.disabled = st.mode === 'human-human';
        setSeg(el.sideW, el.sideB, st.humanColor === 'w');
        setSeg(el.speedFull, el.speedFast, st.speed === 'full');
        el.mode.value = st.mode;
        el.eloValue.textContent = st.elo;
        el.labels.checked = st.labels;
        if (el.mute) {
            el.mute.setAttribute('aria-pressed', String(st.muted));
            el.mute.title = st.muted ? 'Sound off (click to unmute)' : 'Sound on (click to mute)';
        }
    }

    function persist() {
        saveSettings({ mode: st.mode, humanColor: st.humanColor, elo: st.elo, speed: st.speed, labels: st.labels, muted: st.muted });
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
            if (i === last) span.className = 'last';
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
        if (st.moving || thinking() || gs().isGameOver || isHumanTurn()) return;
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
        if (s.over) audio?.play('gameover');
        else if (s.inCheck) audio?.play('check');
        else if (!ev.captured) audio?.play('move', { volume: 0.6 });
        if (s.over) {
            const king = g.findKing(gs().currentPlayer);
            await runAnimation(() => units.playGameOver({
                result: s.result === 'checkmate' ? 'checkmate' : s.result === 'stalemate' ? 'stalemate' : 'draw',
                loser: s.result === 'checkmate' ? gs().currentPlayer : null,
                kingSquare: king
            }), 'playGameOver');
        } else if (s.inCheck) {
            await runAnimation(() => units.playCheck(g.findKing(gs().currentPlayer)), 'playCheck');
        }
        if (version !== st.version) return true;

        endMoving();
        refreshHighlights();
        renderMoveList();
        updateHud();
        maybeStartAI();
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
    function onSquareClick(row, col) {
        if (row === null || row === undefined || inputLocked()) return;
        const piece = g.getPieceAt(row, col);
        if (st.selected) {
            const move = st.moves.find(m => m.row === row && m.col === col);
            if (move) {
                const from = st.selected;
                if (move.isPromotion) {
                    openPromotion(from, { row, col });
                } else {
                    playMove(from, { row, col }, null, false);
                }
                return;
            }
        }
        if (piece && g.getPlayerForPiece(piece) === gs().currentPlayer &&
            !(st.selected && st.selected.row === row && st.selected.col === col)) {
            st.selected = { row, col };
            st.moves = g.generateLegalMoves(row, col);
        } else {
            clearSelection();
        }
        refreshHighlights();
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

    // --- Commands ---
    // Stops anything in flight and invalidates pending async continuations.
    function abortInFlight() {
        clearRings(); // before units are skipped and resynced
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
        resyncView();
        sceneAPI.setView(viewSide(), { animate: true });
        maybeStartAI();
    }

    // Debug/test: start from an arbitrary position
    function loadFen(fen) {
        abortInFlight();
        g.battle3dLoadFen(fen);
        resyncView();
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
        maybeStartAI();
    }

    function setMode(mode) {
        if (!MODES.includes(mode)) return;
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
        st.elo = Math.max(300, Math.min(2500, Math.round(Number(elo) || 1200)));
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
            if (st.pendingPromotion) cancelPromotion();
            else if (!modalOpen) { clearSelection(); st.cursor = null; refreshHighlights(); }
            return;
        }
        if (modalOpen || typing) return;
        if (event.code === 'Space' && !onControl) {
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
    el.promo.querySelectorAll('button[data-piece]').forEach(button =>
        button.addEventListener('click', () => choosePromotion(button.dataset.piece)));
    el.promoCancel.addEventListener('click', cancelPromotion);
    el.hudToggle.addEventListener('click', () => setHudCollapsed(!el.hud.classList.contains('collapsed')));
    el.mute?.addEventListener('click', () => setMuted(!st.muted));
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
    if (Number.isFinite(saved.elo)) st.elo = Math.max(300, Math.min(2500, Math.round(saved.elo)));
    if (saved.speed === 'full' || saved.speed === 'fast') st.speed = saved.speed;
    else if (st.mode === 'ai-ai') st.speed = 'fast';
    if (typeof saved.labels === 'boolean') st.labels = saved.labels;
    if (typeof saved.muted === 'boolean') st.muted = saved.muted;
    el.elo.value = st.elo;
    units.setMode(st.speed);
    units.setLabels(st.labels);
    audio?.setMuted(st.muted);

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
            elo: st.elo,
            cursor: st.cursor,
            selected: st.selected,
            pendingPromotion: st.pendingPromotion
        };
    }

    return {
        newGame, loadFen, undo, setMode, setHumanColor, setSpeed, setLabels, setElo, setMuted, skip,
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
