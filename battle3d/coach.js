// Coach mode: the player's own king gives advice. All chess judgement comes from the engine
// (requestAnalysis / requestThreats in the worker, classification and tactics detectors from
// elo-engine); the words come from templates in battle3d/lines/coach.json (b3d-lines).
//   Before the player's move: at most one nudge (threat, hanging piece, opening principles).
//   After it: classification; inaccuracy or worse gets an explanation with "Take it back" and
//   "Show me better"; good moves get occasional praise (frequency "every").
//   Game end: a review panel with key moments, a small eval graph and jump-to-position.
// Never blocks input; every request is cancelled on the next move, undo or new game.
//
//   createCoach({ controller, sceneAPI, audio, log }) -> { setEnabled(bool), setFrequency('every'|'mistakes'), openReview(), state() }

const g = globalThis;
const SETTINGS_KEY = 'battle3d.settings';
const COACH_ANALYSIS = { nodes: 200000, multiPv: 3 }; // about 0.2 s on a Mac, 0.6 s on a phone
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const PRAISE_CHANCE = { best: 0.45, good: 0.15 };
const NUDGE_SECONDS = 1.2;     // let the position settle before nudging
const CARD_SECONDS = 12;       // praise and nudges fade after this long

// Built-in templates in the battle3d/lines/coach.json shape (STYLE.md), used until or unless it loads
const FALLBACK = {
    classification: {
        inaccuracy: [{ text: 'Not the sharpest move. {bestMove} was a little better.' }, { text: 'Hmm, a small slip. Keep an eye out.' }],
        mistake: [{ text: 'That costs us {loss}. {bestMove} was the move.' }, { text: 'That one hurts a bit. Shall we take it back?' }],
        blunder: [{ text: 'Ouch! That gives away {loss}. {bestMove} would have kept us safe.' }, { text: 'Oh dear. Take it back?' }],
        good: [{ text: 'A sound move. Carry on.' }],
        best: [{ text: 'Exactly what I would have played. Splendid!' }],
        brilliant: [{ text: 'Brilliant! A move worth remembering.' }]
    },
    motif: {
        hanging: [{ text: 'Your {piece} on {square} is undefended. Their {attacker} can take it.' }],
        fork: [{ text: 'Careful! Their {attacker} can attack two pieces at once from {square}.' }],
        pin: [{ text: 'Your {target} is pinned. If it moves, the piece behind it is exposed.' }],
        skewer: [{ text: 'A skewer! Their {attacker} hits your {target}, and the piece behind falls.' }],
        backRank: [{ text: 'Our back rank is weak! The king has no escape square.' }],
        missedCapture: [{ text: 'You could have taken their {target} on {square} for free.' }],
        allowsMate: [{ text: 'Careful! After that, they can checkmate. {bestMove} keeps our king safe.' }],
        missedMate: [{ text: 'You had checkmate! {bestMove} would have ended the game.' }],
        trappedPiece: [{ text: 'Your {piece} on {square} has no safe squares left.' }],
        discovered: [{ text: 'When their piece moves, the {attacker} behind it attacks your {target}.' }]
    },
    nudge: {
        threat: [{ text: 'Before you move: their {attacker} is eyeing your {target} on {square}.' }, { text: 'Look out, they have a threat. What is it?' }],
        hangingPiece: [{ text: 'Your {piece} on {square} is unguarded. Maybe give it some company?' }],
        castleSoon: [{ text: 'Shall we castle soon? My crown feels a bit exposed.' }],
        developPieces: [{ text: 'Some knights and bishops are still at home. Let us bring them out!' }],
        controlCentre: [{ text: 'A pawn or knight in the centre gives our pieces room to breathe.' }],
        kingSafety: [{ text: 'My guard looks thin. Perhaps shore up the pawns around the king?' }],
        endgameKingActive: [{ text: 'It is the endgame! The king can fight now. Bring me forward.' }]
    },
    review: {
        wellPlayed: [{ text: 'A fine game! Your moves were clear and brave.' }],
        closeGame: [{ text: 'A close one! A few small moments decided it.' }],
        toughLoss: [{ text: 'A tough loss, but we learn from it. Here are the key moments.' }],
        keyMoment: [{ text: 'This was the turning point. {bestMove} would have kept us on track.' }]
    }
};

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSetting(patch) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch (e) { /* private mode */ }
}
const squareName = (sq) => sq ? String.fromCharCode(97 + sq.col) + (8 - sq.row) : '';
const pick = (list) => (Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : null);

// Material in words (bands agreed with b3d-lines); mates read as "the game"
function evalWords(cp) {
    const v = Math.abs(cp);
    if (v >= 5000) return 'the game';
    if (v >= 700) return "a queen's worth";
    if (v >= 400) return 'a whole rook';
    if (v >= 150) return "a piece's worth";
    return 'about a pawn';
}

export function createCoach({ controller, sceneAPI, units = null, log = () => {} }) {
    const $ = (id) => document.getElementById(id);
    const el = {
        toggle: $('coach-toggle'), frequency: $('coach-frequency'), frequencyRow: $('coach-frequency-row'),
        card: $('coach-card'), text: $('coach-text'), actions: $('coach-actions'),
        undo: $('coach-undo'), better: $('coach-better'), close: $('coach-close'),
        review: $('coach-review'), reviewList: $('coach-review-list'), reviewGraph: $('coach-review-graph'),
        reviewIntro: $('coach-review-intro'), reviewClose: $('coach-review-close'), reviewOpen: $('coach-review-open'),
        announce: $('announce')
    };
    const saved = loadSettings();
    let enabled = saved.coach === true;
    let frequency = saved.coachFrequency === 'mistakes' ? 'mistakes' : 'every';
    let voices = null;          // coach.json voices: { hero: {...}, skeleton: {...} }
    let lastMistake = null;     // { bestBefore } for "Show me better"
    let threatHandle = null;
    let token = 0;
    let cardTimer = null, nudgeTimer = null;
    const nudgedOnce = new Set();       // opening nudges are given once per game
    const moments = [];                 // per move: { ply, color, notation, classification, evalAfter, human }

    fetch('battle3d/lines/coach.json').then(r => (r.ok ? r.json() : null)).then(data => {
        if (data?.voices && typeof data.voices === 'object') voices = data.voices;
    }).catch(() => {});

    let tacticsModule;
    const loadTactics = () => (tacticsModule ??= import('./tactics.js').catch(() => null));

    // --- Text ---
    // The coach speaks as the player's own king: the skeleton voice for a skeleton king (cast), else the hero
    function voiceFor(color) {
        try {
            const king = units?.getLegend?.().find(e => e.color === color && e.type === 'k');
            const text = `${king?.model || ''} ${king?.name || ''}`;
            if (/skelet/i.test(text)) return 'skeleton';
            if (text.trim()) return 'hero';
        } catch (e) { /* fall through */ }
        return color === 'b' ? 'skeleton' : 'hero';
    }

    // Picks a template whose slots can all be filled (STYLE.md); motif lines tagged "praise" only when praising
    function template(path, slots, { color = currentColor(), praise = false } = {}) {
        const [section, key] = path.split('.');
        const fromFile = voices?.[voiceFor(color)]?.[section]?.[key];
        const filter = (list) => (Array.isArray(list) ? list : []).filter(l => typeof l?.text === 'string' &&
            (section !== 'motif' || (l.tags?.includes('praise') ?? false) === praise) &&
            [...l.text.matchAll(/\{(\w+)\}/g)].every(m => slots[m[1]]));
        let usable = filter(fromFile);
        if (!usable.length) usable = filter(FALLBACK[section]?.[key]);
        const line = pick(usable);
        return line ? line.text.replace(/\{(\w+)\}/g, (m, k) => slots[k]).replace(/\s+/g, ' ').trim() : null;
    }

    function currentColor() {
        const turn = controller.state().turn;
        return controller.isHumanColor?.(turn) ? turn : (turn === 'w' ? 'b' : 'w');
    }

    function describeMove(move) {
        if (!move?.from || !move?.to) return 'another move';
        const piece = g.getPieceAt?.(move.from.row, move.from.col);
        const name = PIECE_NAMES[String(piece || '').toLowerCase()] || 'piece';
        return `${name} to ${squareName(move.to)}`;
    }

    // --- Card ---
    function showCard(text, { actions = false, sticky = false } = {}) {
        if (!enabled || !text) return;
        clearTimeout(cardTimer);
        el.text.textContent = text;
        el.actions.hidden = !actions;
        el.card.hidden = false;
        el.card.classList.toggle('warn', actions);
        if (el.announce) { el.announce.textContent = ''; el.announce.textContent = `Coach: ${text}`; }
        if (!sticky) cardTimer = setTimeout(hideCard, CARD_SECONDS * 1000);
    }

    function hideCard() {
        clearTimeout(cardTimer);
        if (el.card) el.card.hidden = true;
    }

    // --- Requests ---
    function cancelRequests() {
        token++;
        clearTimeout(nudgeTimer);
        if (threatHandle) {
            const handle = threatHandle;
            threatHandle = null;
            try { handle.cancel(); } catch (e) { /* ignore */ }
        }
    }

    // --- Events ---
    function onEvent(event) {
        if (event.type === 'reset') {
            cancelRequests();
            hideCard();
            lastMistake = null;
            if (event.reason === 'newGame' || event.reason === 'loadFen') { moments.length = 0; nudgedOnce.clear(); closeReview(); }
            else while (moments.length && moments[moments.length - 1].ply > event.ply) moments.pop();
            return;
        }
        if (event.type === 'moveDone') {
            cancelRequests();
            onMoveDone(event);
            return;
        }
        if (event.type === 'turn') {
            if (enabled && event.human && !event.over) scheduleNudge(event);
        }
    }

    function onMoveDone(event) {
        moments.push({
            ply: event.ply, color: event.mover, notation: event.notation, classification: event.classification,
            evalAfter: event.evalAfter, evalBefore: event.evalBefore, human: controller.isHumanColor?.(event.mover) ?? !event.isAI,
            motif: event.motif, bestMove: event.bestBefore ? describeBestBefore(event) : '',
            piece: PIECE_NAMES[String(event.piece || '').toLowerCase()] || '', square: squareName(event.square)
        });
        if (event.status?.over) {
            hideCard();
            if (enabled) setTimeout(() => { if (enabled) openReview(); }, 2500);
            return;
        }
        if (!enabled || event.isAI || !(controller.isHumanColor?.(event.mover) ?? true)) {
            if (!el.card.hidden && !el.card.classList.contains('warn')) hideCard();
            return;
        }
        const c = event.classification;
        if (!c) { hideCard(); return; }
        const drop = Math.abs((event.evalBefore ?? 0) - (event.evalAfter ?? 0));
        const color = event.mover;
        const slots = {
            piece: PIECE_NAMES[String(event.piece || '').toLowerCase()] || '',
            square: squareName(event.square),
            // The better move belongs to the position before the move, which the board no longer shows
            bestMove: event.bestBefore ? describeBestBefore(event) : '',
            loss: drop >= 60 ? evalWords(drop) : ''
        };
        if (BAD.includes(c)) {
            let text = null;
            // Problems the player allowed (motif favours the opponent) or missed (missedCapture / missedMate)
            const problems = (event.motifs || []).filter(m => m.by !== event.mover || m.motif === 'missedCapture' || m.motif === 'missedMate');
            for (const motif of problems) {
                const extra = Object.fromEntries(Object.entries(motifSlots(motif)).filter(([, v]) => v));
                text = template(`motif.${motif.motif}`, { ...slots, ...extra }, { color });
                if (text) break;
            }
            text ||= template(`classification.${c}`, slots, { color });
            lastMistake = event.bestBefore ? { bestBefore: event.bestBefore } : null;
            el.better.hidden = !lastMistake;
            showCard(text, { actions: true, sticky: true });
        } else if (frequency === 'every' && (event.brilliant || Math.random() < (PRAISE_CHANCE[c] ?? 0))) {
            // A tactic the player executed gets its motif praise line, else the classification praise
            const executed = (event.motifs || []).find(m => m.by === event.mover && m.motif !== 'missedCapture' && m.motif !== 'missedMate');
            const extra = executed ? Object.fromEntries(Object.entries(motifSlots(executed)).filter(([, v]) => v)) : {};
            const praise = executed && template(`motif.${executed.motif}`, { ...slots, ...extra }, { color, praise: true });
            showCard(praise || template(`classification.${event.brilliant ? 'brilliant' : c}`, slots, { color }));
        } else {
            hideCard();
        }
    }

    // Slot values from a tactics.detect() motif. squares / pieces orders per battle3d/tactics.js:
    //   fork [forker, ...targets], pin|skewer|discovered [slider, front, behind|moved],
    //   hanging|trappedPiece [piece, ...attackers], missedCapture [target, capturer],
    //   allowsMate|missedMate [from, to] of the mating move, backRank [checker, king]
    function motifSlots(motif) {
        const P = motif.pieces || [], S = motif.squares || [];
        const n = (p) => PIECE_NAMES[String(p ?? '').toLowerCase()] || '';
        // tactics.js now names the roles on every motif; the per-motif orders below are the fallback
        if (motif.attacker !== undefined || motif.target !== undefined) {
            const slots = { attacker: n(motif.attacker), target: n(motif.target), piece: n(motif.piece), square: motif.square || '' };
            if (motif.motif === 'fork') slots.piece = slots.attacker;           // praise: the player's forking piece
            if (motif.motif === 'missedCapture') { slots.piece = slots.attacker; slots.loss = Number.isFinite(motif.gain) ? evalWords(motif.gain) : ''; }
            if (motif.motif === 'missedMate' && slots.attacker && slots.square) slots.bestMove = `${slots.attacker} to ${slots.square}`;
            return slots;
        }
        switch (motif.motif) {
            case 'fork': return { attacker: n(P[0]), piece: n(P[0]), square: S[0], target: n(P[1]) };
            case 'pin': case 'skewer': case 'discovered': return { attacker: n(P[0]), target: n(P[1]), square: S[1] };
            case 'hanging': case 'trappedPiece': return { piece: n(P[0]), square: S[0], attacker: n(P[1]), target: n(P[0]) };
            case 'missedCapture': return { target: n(P[0]), square: S[0], piece: n(P[1]), loss: Number.isFinite(motif.gain) ? evalWords(motif.gain) : '' };
            case 'allowsMate': return { attacker: n(P[0]), square: S[1] };
            case 'missedMate': return { piece: n(P[0]), square: S[1], bestMove: P[0] && S[1] ? `${n(P[0])} to ${S[1]}` : '' };
            case 'backRank': return { attacker: n(P[0]), square: S[1] };
            default: return { attacker: n(P[0]), target: n(P[1]), square: S[0] };
        }
    }

    function describeBestBefore(event) {
        const best = event.bestBefore;
        if (!best?.from || !best?.to) return 'another move';
        const piece = event.stateBefore?.board?.[best.from.row]?.[best.from.col];
        const name = PIECE_NAMES[String(piece || '').toLowerCase()] || 'piece';
        return `${name} to ${squareName(best.to)}`;
    }

    // Before the player's move: one nudge at most, the most important first
    function scheduleNudge(event) {
        const myToken = token;
        nudgeTimer = setTimeout(async () => {
            if (myToken !== token || !enabled) return;
            const nudge = await findNudge(event, myToken);
            if (nudge && myToken === token && enabled && el.card.hidden) showCard(nudge);
        }, NUDGE_SECONDS * 1000);
    }

    async function findNudge(event, myToken) {
        const side = event.color;
        const state = g.getCurrentGameStateSnapshot?.();
        if (!state) return null;
        // 1. Their threats (worker), e.g. "they threaten your queen" or a mate
        if (typeof g.requestThreats === 'function') {
            try {
                threatHandle = g.requestThreats(state);
                const result = await threatHandle.promise;
                threatHandle = null;
                if (myToken !== token) return null;
                const threat = result?.threats?.find(t => t.motif === 'allowsMate' || t.motif === 'mate' || (t.gain ?? 0) >= 250);
                if (threat) {
                    const to = threat.move?.to, from = threat.move?.from;
                    const target = to ? state.board[to.row]?.[to.col] : null;
                    const attacker = from ? state.board[from.row]?.[from.col] : null;
                    const text = template('nudge.threat', {
                        attacker: attacker ? PIECE_NAMES[attacker.toLowerCase()] : '',
                        target: target ? PIECE_NAMES[target.toLowerCase()] : '',
                        square: squareName(to)
                    }, { color: side });
                    if (text) return text;
                }
            } catch (e) { threatHandle = null; log('threats failed', e); }
        }
        // 2. Our hanging pieces (pure JS)
        const tactics = await loadTactics();
        if (myToken !== token) return null;
        try {
            const hanging = (tactics?.hangingPieces?.(state, side) || [])
                .filter(h => PIECE_VALUES[String(h.piece).toLowerCase()] >= 3)
                .sort((a, b) => PIECE_VALUES[String(b.piece).toLowerCase()] - PIECE_VALUES[String(a.piece).toLowerCase()]);
            if (hanging.length) {
                const h = hanging[0];
                return template('nudge.hangingPiece', { piece: PIECE_NAMES[String(h.piece).toLowerCase()], square: typeof h.square === 'string' ? h.square : squareName(h.square) }, { color: side });
            }
        } catch (e) { log('hangingPieces failed', e); }
        // 3. An exposed king (once per game; a real danger, so also in "mistakes only" mode)
        if (!nudgedOnce.has('kingSafety') && kingExposed(state, side, event.ply)) {
            nudgedOnce.add('kingSafety');
            const text = template('nudge.kingSafety', {}, { color: side });
            if (text) return text;
        }
        // 4. Opening principles, each once per game
        if (frequency !== 'every') return null;
        return openingNudge(state, side, event.ply);
    }

    // The king is exposed when the enemy still has heavy pieces and either (a) it never castled and
    // the centre is open after move 10, or (b) its pawn shield is mostly gone and an enemy queen or
    // rook is lined up near it. Tuned to fire rarely.
    function kingExposed(state, side, ply) {
        const board = state.board;
        const mine = (p) => p && (side === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
        const enemyHeavy = [];
        let kr = -1, kc = -1;
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            const p = board[r][c];
            if (!p) continue;
            if (mine(p) && p.toLowerCase() === 'k') { kr = r; kc = c; }
            if (!mine(p) && (p.toLowerCase() === 'q' || p.toLowerCase() === 'r')) enemyHeavy.push({ r, c, q: p.toLowerCase() === 'q' });
        }
        if (kr < 0 || !enemyHeavy.some(h => h.q)) return false;   // without an enemy queen the danger is small
        const back = side === 'w' ? 7 : 0, ahead = side === 'w' ? -1 : 1;
        const pawn = side === 'w' ? 'P' : 'p';
        // (a) Uncastled in the middle with open central files
        if (Math.floor(ply / 2) >= 10 && kr === back && kc >= 3 && kc <= 5) {
            const fileOpen = (c) => !board.some(row => row[c] === pawn);
            if (fileOpen(3) || fileOpen(4)) return true;
        }
        // (b) Pawn shield: own pawns on the king's file and its neighbours, one or two ranks ahead
        let shield = 0;
        for (let dc = -1; dc <= 1; dc++) {
            const c = kc + dc;
            if (c < 0 || c > 7) continue;
            for (const d of [1, 2]) if (board[kr + ahead * d]?.[c] === pawn) { shield++; break; }
        }
        const files = [kc - 1, kc, kc + 1].filter(c => c >= 0 && c <= 7).length;
        const lined = enemyHeavy.some(h => Math.abs(h.c - kc) <= 1 || (h.q && Math.max(Math.abs(h.r - kr), Math.abs(h.c - kc)) <= 3));
        return Math.floor(ply / 2) >= 8 && shield <= files - 2 && lined;
    }

    function openingNudge(state, side, ply) {
        const board = state.board;
        const back = side === 'w' ? 7 : 0;
        const own = (p) => p && (side === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
        const at = (r, c) => board[r]?.[c];
        const moves = Math.floor(ply / 2);
        if (moves >= 2 && moves <= 4 && !nudgedOnce.has('centre')) {
            const pawnRow = side === 'w' ? 6 : 1;
            const p = side === 'w' ? 'P' : 'p';
            if (at(pawnRow, 3) === p && at(pawnRow, 4) === p) { nudgedOnce.add('centre'); return template('nudge.controlCentre', {}, { color: side }); }
        }
        if (moves >= 5 && moves <= 10 && !nudgedOnce.has('develop')) {
            const minors = side === 'w' ? ['N', 'B', 'B', 'N'] : ['n', 'b', 'b', 'n'];
            const home = [1, 2, 5, 6].filter((c, i) => at(back, c) === minors[i]).length;
            if (home >= 2) { nudgedOnce.add('develop'); return template('nudge.developPieces', {}, { color: side }); }
        }
        if (moves >= 7 && moves <= 14 && !nudgedOnce.has('castle')) {
            const king = side === 'w' ? 'K' : 'k';
            const rights = state.castlingRights?.[side];
            if (at(back, 4) === king && own(at(back, 4)) && (rights?.K || rights?.Q)) { nudgedOnce.add('castle'); return template('nudge.castleSoon', {}, { color: side }); }
        }
        // Endgame: few pieces left and our king still hiding on the back rank
        if (!nudgedOnce.has('endgameKing') && moves >= 20) {
            let heavy = 0;
            for (const row of board) for (const p of row) if (p && 'qrQR'.includes(p)) heavy++;
            const king = side === 'w' ? 'K' : 'k';
            if (heavy <= 1 && board[back].includes(king)) { nudgedOnce.add('endgameKing'); return template('nudge.endgameKingActive', {}, { color: side }); }
        }
        return null;
    }

    // --- Actions ---
    function takeBack() {
        hideCard();
        controller.undo();
    }

    function showBetter() {
        const best = lastMistake?.bestBefore;
        hideCard();
        if (!best) return;
        controller.undo();
        // After the take-back it is our turn again in the position where the better move exists
        setTimeout(() => {
            if (controller.showSuggestion?.(best)) showCard(`Try ${describeMove(best)} instead. The arrow shows the way.`);
        }, 50);
    }

    // --- End-of-game review ---
    function openReview() {
        if (!el.review) return;
        el.reviewList.textContent = '';
        const key = moments.filter(m => m.human && (BAD.includes(m.classification) || m.classification === 'best' && m.motif));
        const analysed = moments.some(m => Number.isFinite(m.evalAfter));
        el.reviewIntro.textContent = !analysed
            ? 'No engine analysis was available for this game, so there is nothing to review.'
            : reviewIntro(key);
        for (const m of key) {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `moment ${m.classification}`;
            const moveNo = Math.floor((m.ply - 1) / 2) + 1;
            button.innerHTML = '<span class="tag"></span><span class="mv"></span>';
            button.querySelector('.tag').textContent = m.classification;
            button.querySelector('.mv').textContent = `${moveNo}${m.color === 'w' ? '.' : '...'} ${m.notation}`;
            button.addEventListener('click', () => { closeReview(); controller.enterReview?.(m.ply); });
            li.append(button);
            el.reviewList.append(li);
        }
        drawGraph();
        el.review.hidden = false;
        el.reviewClose?.focus();
    }

    // Opening words by result, then the turning point (the human move that lost the most)
    function reviewIntro(key) {
        const st = controller.state();
        const humans = ['w', 'b'].filter(c => controller.isHumanColor?.(c));
        const color = humans.length === 1 ? humans[0] : null;
        let kind = 'closeGame';
        if (st.result === 'checkmate' && color) kind = st.turn === color ? 'toughLoss' : 'wellPlayed';
        else if (!key.some(m => m.classification === 'blunder' || m.classification === 'mistake')) kind = 'wellPlayed';
        let text = template(`review.${kind}`, {}, { color: color || 'w' }) || '';
        const worst = key.filter(m => BAD.includes(m.classification))
            .sort((a, b) => Math.abs((b.evalBefore ?? 0) - (b.evalAfter ?? 0)) - Math.abs((a.evalBefore ?? 0) - (a.evalAfter ?? 0)))[0];
        const lost = worst ? Math.abs((worst.evalBefore ?? 0) - (worst.evalAfter ?? 0)) : 0;
        const turning = worst && template('review.keyMoment', {
            // "better by {loss}" does not read with "the game": a mate swing leaves {loss} empty so another line is used
            bestMove: worst.bestMove, piece: worst.piece, square: worst.square, loss: lost >= 60 && lost < 5000 ? evalWords(lost) : ''
        }, { color: worst.color });
        if (turning) text += ` ${turning}`;
        return text.trim();
    }

    function closeReview() {
        if (el.review) el.review.hidden = true;
    }

    // Small eval graph: White's advantage over the game, clamped to +-10 pawns, mistakes as dots
    function drawGraph() {
        const svg = el.reviewGraph;
        if (!svg) return;
        const pts = moments.filter(m => Number.isFinite(m.evalAfter));
        const W = 300, H = 90, clampP = (cp) => Math.max(-1000, Math.min(1000, cp));
        const x = (i) => (pts.length > 1 ? (i / (pts.length - 1)) * W : W / 2);
        const y = (cp) => H / 2 - (clampP(cp) / 1000) * (H / 2 - 4);
        const line = pts.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(m.evalAfter).toFixed(1)}`).join(' ');
        const area = pts.length ? `${line} L${x(pts.length - 1).toFixed(1)},${H / 2} L${x(0).toFixed(1)},${H / 2} Z` : '';
        const dots = pts.map((m, i) => (m.human && BAD.includes(m.classification)
            ? `<circle class="dot ${m.classification}" cx="${x(i).toFixed(1)}" cy="${y(m.evalAfter).toFixed(1)}" r="3.5"><title>${m.notation}: ${m.classification}</title></circle>` : '')).join('');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.innerHTML = `<line class="mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>` +
            (pts.length ? `<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}` : '');
        svg.setAttribute('aria-label', pts.length ? `Evaluation graph over ${pts.length} moves` : 'No evaluation data');
    }

    // --- Settings ---
    function setEnabled(on) {
        enabled = !!on;
        saveSetting({ coach: enabled });
        if (el.toggle) el.toggle.checked = enabled;
        if (el.frequencyRow) el.frequencyRow.classList.toggle('disabled', !enabled);
        if (el.frequency) el.frequency.disabled = !enabled;
        if (el.reviewOpen) el.reviewOpen.hidden = !enabled;
        controller.setAnalysisNeed?.('coach', enabled ? COACH_ANALYSIS : null);
        if (!enabled) { cancelRequests(); hideCard(); }
    }

    function setFrequency(next) {
        frequency = next === 'mistakes' ? 'mistakes' : 'every';
        saveSetting({ coachFrequency: frequency });
        if (el.frequency) el.frequency.value = frequency;
    }

    controller.onEvent(onEvent);
    el.toggle?.addEventListener('change', () => setEnabled(el.toggle.checked));
    el.frequency?.addEventListener('change', () => setFrequency(el.frequency.value));
    el.undo?.addEventListener('click', takeBack);
    el.better?.addEventListener('click', showBetter);
    el.close?.addEventListener('click', hideCard);
    el.reviewClose?.addEventListener('click', closeReview);
    el.reviewOpen?.addEventListener('click', openReview);
    el.review?.addEventListener('click', (e) => { if (e.target === el.review) closeReview(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && el.review && !el.review.hidden) closeReview(); });
    setFrequency(frequency);
    setEnabled(enabled);

    return {
        setEnabled, setFrequency, openReview, closeReview,
        state: () => ({ enabled, frequency, cardVisible: !!el.card && !el.card.hidden, cardText: el.text?.textContent || '', moments: moments.slice() })
    };
}
