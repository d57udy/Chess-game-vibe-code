// Coach mode and game review. All chess judgement comes from the engine (requestAnalysis /
// requestThreats in the coach worker, classification and tactics detectors from elo-engine, reached
// through controller.judgePly); the words come from templates in battle3d/lines/coach.json (b3d-lines).
//
// Coach card (when "Coach" is on):
//   "Every move":   after EVERY move of the coached player a verdict (best / good / inaccuracy / mistake /
//                   blunder / brilliant) with one sentence. It shows a thinking state while the engine works
//                   and always resolves. Before the player's move at most one warning (a real threat, a
//                   hanging piece, king safety, opening principles); it never names the best move.
//   "Mistakes only": a card only for inaccuracies, mistakes and blunders; no warnings, no praise.
//   Mistake cards offer "Take it back" (undo to before the move, also after the AI replied) and
//   "Show me better" (the same, then the engine's move as the hint arrow).
// Game review (works with the coach on or off, mid-game or after the game): a docked panel with every
//   move and its verdict, an eval graph, previous / next and flagged stepping, and "Return to game". Looking
//   at an earlier position never closes the panel; it can be minimised to a "Back to review" chip.
// Never blocks input or the AI: analysis runs in the coach worker and is cancelled on undo / new game.
//
//   createCoach({ controller, sceneAPI, units, log }) -> { setEnabled, setFrequency, openReview, closeReview,
//     minimiseReview, select(ply), returnToGame, state() }

const g = globalThis;
const SETTINGS_KEY = 'battle3d.settings';
const COACH_ANALYSIS = { nodes: 200000, multiPv: 3 }; // about 0.2 s on a Mac, 0.6 to 1 s on a phone
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const LABEL = { best: 'Best', good: 'Good', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder', brilliant: 'Brilliant' };
const WARNING_SECONDS = 1.0;   // let the position settle before warning about threats
const SLOT_RE = /\{(\w+)\}/g;

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
const squareName = (sq) => (sq ? String.fromCharCode(97 + sq.col) + (8 - sq.row) : '');
const pick = (list) => (Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : null);
const pieceName = (p) => PIECE_NAMES[String(p ?? '').toLowerCase()] || '';

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
        card: $('coach-card'), badge: $('coach-badge'), move: $('coach-move'), spinner: $('coach-spinner'),
        text: $('coach-text'), warning: $('coach-warning'), actions: $('coach-actions'),
        undo: $('coach-undo'), better: $('coach-better'), close: $('coach-close'),
        review: $('coach-review'), reviewTitle: $('coach-review-title'), reviewIntro: $('coach-review-intro'),
        reviewGraph: $('coach-review-graph'), reviewList: $('coach-review-list'), reviewDetail: $('coach-review-detail'),
        reviewPrev: $('coach-review-prev'), reviewNext: $('coach-review-next'),
        reviewPrevFlag: $('coach-review-prev-flag'), reviewNextFlag: $('coach-review-next-flag'),
        reviewReturn: $('coach-review-return'), reviewMin: $('coach-review-min'), reviewClose: $('coach-review-close'),
        reviewOpen: $('coach-review-open'), reviewChip: $('coach-review-chip'), announce: $('announce')
    };
    const saved = loadSettings();
    let enabled = saved.coach === true;
    let frequency = saved.coachFrequency === 'mistakes' ? 'mistakes' : 'every';
    let voices = null;                  // coach.json voices: { hero: {...}, skeleton: {...} }
    let records = [];                   // records[ply]: one per move of the game (index 0 unused)
    const card = { ply: null, warning: '', info: '', dismissed: false };
    const review = { open: false, minimised: false, selected: null, token: 0, running: false };
    let threatHandle = null;
    let token = 0;                      // bumped to drop pending warnings
    let warnTimer = null, reviewTimer = null;
    const nudgedOnce = new Set();       // opening and king-safety nudges are given once per game
    const engineAvailable = () => typeof g.requestAnalysis === 'function';

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
    // prefer: slot names a line should use when possible (e.g. a threat warning that names the attacked piece)
    function template(path, slots, { color = 'w', praise = false, prefer = null } = {}) {
        const [section, key] = path.split('.');
        const fromFile = voices?.[voiceFor(color)]?.[section]?.[key];
        const filter = (list) => (Array.isArray(list) ? list : []).filter(l => typeof l?.text === 'string' &&
            (section !== 'motif' || (l.tags?.includes('praise') ?? false) === praise) &&
            [...l.text.matchAll(SLOT_RE)].every(m => slots[m[1]]));
        let usable = filter(fromFile);
        if (!usable.length) usable = filter(FALLBACK[section]?.[key]);
        if (prefer) {
            const specific = usable.filter(l => prefer.every(k => slots[k] && l.text.includes(`{${k}}`)));
            if (specific.length) usable = specific;
        }
        const line = pick(usable);
        return line ? line.text.replace(SLOT_RE, (m, k) => slots[k]).replace(/\s+/g, ' ').trim() : null;
    }

    // "knight to f3" for a move in a given board (the board the move is played from)
    function describeMove(move, board) {
        if (!move?.from || !move?.to) return '';
        const piece = board?.[move.from.row]?.[move.from.col] ?? g.getPieceAt?.(move.from.row, move.from.col);
        const target = board?.[move.to.row]?.[move.to.col];
        return `${pieceName(piece) || 'piece'} ${target ? 'takes' : 'to'} ${squareName(move.to)}`;
    }

    const moveLabel = (r) => `${r.moveNumber}${r.color === 'w' ? '.' : '...'} ${r.notation}`;
    const sideName = (c) => (c === 'w' ? 'White' : 'Black');
    const bothHuman = () => controller.isHumanColor?.('w') && controller.isHumanColor?.('b');

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

    // --- Records: one per move, judged by the engine on demand ---
    function makeRecord(ply, event = null) {
        const info = controller.plyInfo?.(ply) || (event && {
            ply, mover: event.mover, piece: event.piece, from: event.from, to: event.square, notation: event.notation,
            moveNumber: Math.floor((ply - 1) / 2) + 1, human: !event.isAI
        });
        if (!info) return null;
        return {
            ply, color: info.mover, human: !!info.human, notation: info.notation || '', moveNumber: info.moveNumber || Math.floor((ply - 1) / 2) + 1,
            piece: info.piece, from: info.from, to: info.to,
            status: 'new',          // new | pending | done | failed | unavailable
            classification: null, brilliant: false, evalBefore: null, evalAfter: null,
            best: null, bestText: '', motifs: [], text: '', attempts: 0, promise: null
        };
    }

    // Makes sure the history up to the current position has records (review opened mid-game, coach off before)
    function syncRecords() {
        const ply = controller.state().ply ?? controller.state().history.length;
        records.length = Math.min(records.length, ply + 1);
        for (let i = 1; i <= ply; i++) records[i] ||= makeRecord(i);
        return ply;
    }

    const isBad = (r) => r?.status === 'done' && BAD.includes(r.classification);
    const isFlagged = (r) => r?.status === 'done' && r.human && (BAD.includes(r.classification) || r.brilliant);
    const verdictKey = (r) => (r.brilliant ? 'brilliant' : r.classification);

    // Asks the engine about one move. Resolves when the record is done (or cannot be judged).
    function judge(record) {
        if (!record || record.status === 'done' || record.status === 'pending') return record?.promise || Promise.resolve();
        if (!engineAvailable() || typeof controller.judgePly !== 'function') {
            record.status = 'unavailable';
            onRecordChanged(record);
            return Promise.resolve();
        }
        record.status = 'pending';
        record.attempts++;
        record.promise = Promise.resolve(controller.judgePly(record.ply, COACH_ANALYSIS)).catch(e => { log('judgePly failed', e); return null; }).then(j => {
            if (records[record.ply] !== record) return;     // undone or a new game meanwhile
            if (!j || !j.classification) {
                // Cancelled by an undo elsewhere in the game, or the engine gave up: try once more, then say so
                record.status = 'failed';
                if (record.attempts < 3) return new Promise(r => setTimeout(r, 150)).then(() => (records[record.ply] === record ? judge(record) : null));
            } else {
                applyJudgement(record, j);
            }
            onRecordChanged(record);
        });
        onRecordChanged(record);
        return record.promise;
    }

    function applyJudgement(record, j) {
        record.status = 'done';
        record.classification = j.classification;
        record.brilliant = !!j.brilliant;
        record.evalBefore = j.evalBefore;
        record.evalAfter = j.evalAfter;
        record.motifs = j.motifs || [];
        record.playedBest = !!j.playedBest;
        const board = j.stateBefore?.board;
        record.best = j.bestBefore && !j.playedBest ? {
            from: j.bestBefore.from, to: j.bestBefore.to, promotionPiece: j.bestBefore.promotionPiece || null,
            capture: !!board?.[j.bestBefore.to.row]?.[j.bestBefore.to.col]
        } : null;
        record.bestText = record.best ? describeMove(record.best, board) : '';
        record.playedText = describeMove({ from: record.from, to: record.to }, board);
        record.text = composeText(record) || '';
    }

    // One sentence for the move, chosen once so the card and the review say the same thing
    function composeText(record) {
        const color = record.color;
        const drop = Math.abs((record.evalBefore ?? 0) - (record.evalAfter ?? 0));
        const slots = {
            piece: pieceName(record.piece), square: squareName(record.to),
            bestMove: record.bestText, loss: drop >= 60 ? evalWords(drop) : ''
        };
        const withMotif = (motif) => ({ ...slots, ...Object.fromEntries(Object.entries(motifSlots(motif)).filter(([, v]) => v)) });
        if (BAD.includes(record.classification)) {
            // Problems the player allowed (motif favours the opponent) or missed (missedCapture / missedMate)
            const problems = record.motifs.filter(m => m.by !== color || m.motif === 'missedCapture' || m.motif === 'missedMate');
            for (const motif of problems) {
                const text = template(`motif.${motif.motif}`, withMotif(motif), { color });
                if (text) return text;
            }
            return template(`classification.${record.classification}`, slots, { color });
        }
        // A tactic the player executed gets its praise line, else the classification line
        const executed = record.motifs.find(m => m.by === color && m.motif !== 'missedCapture' && m.motif !== 'missedMate');
        const praise = executed && template(`motif.${executed.motif}`, withMotif(executed), { color, praise: true });
        return praise || template(`classification.${verdictKey(record)}`, slots, { color });
    }

    function onRecordChanged(record) {
        if (card.ply === record.ply) renderCard();
        else if (enabled && frequency === 'mistakes' && record.human && isBad(record) && isLatestCoached(record)) showVerdict(record);
        if (review.open) renderReview();
    }

    // The newest move of the coached side(s): only that one may pop up a card
    function isLatestCoached(record) {
        for (let i = records.length - 1; i > record.ply; i--) if (records[i]?.human) return false;
        return true;
    }

    // --- Coach card ---
    function showVerdict(record) {
        card.ply = record.ply;
        card.info = '';
        card.dismissed = false;
        renderCard(true);
    }

    function renderCard(announceIt = false) {
        if (!el.card) return;
        const record = card.ply !== null ? records[card.ply] : null;
        const visible = enabled && !card.dismissed && !!(record || card.warning || card.info);
        el.card.hidden = !visible;
        if (!visible) return;
        let badge = '', badgeClass = '', text = card.info, pending = false, actions = false;
        if (record) {
            el.move.textContent = (bothHuman() ? `${sideName(record.color)}: ` : '') + moveLabel(record);
            if (record.status === 'done') {
                badge = LABEL[verdictKey(record)] || '';
                badgeClass = verdictKey(record);
                text = record.text || `${badge}.`;
                actions = isBad(record) && records.length - 1 >= record.ply;
            } else if (record.status === 'unavailable') {
                text = 'The engine is not available here, so I cannot judge moves.';
            } else if (record.status === 'failed' && record.attempts >= 3) {
                text = 'I could not analyse that move.';
            } else {
                pending = true;
                badge = 'Thinking';
                badgeClass = 'pending';
                text = 'Let me look at that move...';
            }
        } else {
            el.move.textContent = '';
        }
        el.badge.hidden = !badge;
        el.badge.textContent = badge;
        el.badge.className = `coach-badge ${badgeClass}`;
        el.spinner.hidden = !pending;
        el.text.textContent = text || '';
        el.text.hidden = !text;
        el.warning.hidden = !card.warning;
        el.warning.textContent = card.warning;
        el.actions.hidden = !actions;
        if (actions) el.better.hidden = !record.best;
        el.card.classList.toggle('warn', actions);
        el.card.classList.toggle('pending', pending);
        if (!pending && (announceIt || record?.status === 'done') && el.announce) {
            const spoken = [badge && record ? `${badge}.` : '', text, card.warning].filter(Boolean).join(' ');
            if (spoken && spoken !== renderCard.last) { renderCard.last = spoken; el.announce.textContent = ''; el.announce.textContent = `Coach: ${spoken}`; }
        }
    }

    function hideCard() {
        card.ply = null;
        card.warning = '';
        card.info = '';
        renderCard();
    }

    function dismissCard() {
        card.dismissed = true;
        renderCard();
    }

    function showInfo(text) {
        card.ply = null;
        card.warning = '';
        card.info = text;
        card.dismissed = false;
        renderCard(true);
    }

    // --- Requests ---
    function cancelWarning() {
        token++;
        clearTimeout(warnTimer);
        if (threatHandle) {
            const handle = threatHandle;
            threatHandle = null;
            try { handle.cancel(); } catch (e) { /* ignore */ }
        }
    }

    // --- Events ---
    function onEvent(event) {
        if (event.type === 'reset') {
            cancelWarning();
            clearTimeout(reviewTimer);
            if (event.reason === 'newGame' || event.reason === 'loadFen') {
                records = [];
                nudgedOnce.clear();
                review.selected = null;
                review.token++;
            } else {
                records.length = Math.min(records.length, event.ply + 1);
                if (review.selected !== null && review.selected > event.ply) review.selected = null;
            }
            hideCard();
            if (review.open) { renderReview(); runBackfill(); }
            return;
        }
        if (event.type === 'moveDone') {
            cancelWarning();
            onMoveDone(event);
            return;
        }
        if (event.type === 'turn') {
            if (enabled && frequency === 'every' && event.human && !event.over) scheduleWarning(event);
            return;
        }
        if (event.type === 'review') {
            if (event.index === null) announceReview('Back in the game.');
            if (review.open) renderReview();
            updateChip();
        }
    }

    function onMoveDone(event) {
        syncRecords();
        const record = records[event.ply] = makeRecord(event.ply, event) || records[event.ply];
        if (!record) return;
        card.warning = '';
        const coached = enabled && record.human;
        if (coached) {
            if (frequency === 'every') showVerdict(record);     // thinking state now, the verdict when it arrives
            else if (card.ply !== null) hideCard();             // a new move replaces the last mistake card
            judge(record);
        } else {
            renderCard();
        }
        if (review.open) { renderReview(); runBackfill(); }
        if (event.status?.over && enabled) {
            clearTimeout(reviewTimer);
            reviewTimer = setTimeout(() => { if (enabled && controller.state().over) openReview(); }, 2500);
        }
    }

    // Before the player's move ("Every move" only): one warning at most, the most important first.
    // It points at dangers and principles, never at the best move (the Hint button does that).
    function scheduleWarning(event) {
        const myToken = token;
        warnTimer = setTimeout(async () => {
            if (myToken !== token || !enabled) return;
            const text = await findNudge(event, myToken);
            if (!text || myToken !== token || !enabled || controller.state().moving) return;
            card.warning = text;
            card.dismissed = false;
            renderCard(true);
        }, WARNING_SECONDS * 1000);
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
                    }, { color: side, prefer: ['target'] });
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
        // 3. An exposed king (once per game)
        if (!nudgedOnce.has('kingSafety') && kingExposed(state, side, event.ply)) {
            nudgedOnce.add('kingSafety');
            const text = template('nudge.kingSafety', {}, { color: side });
            if (text) return text;
        }
        // 4. Opening principles, each once per game
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

    // --- Actions on a mistake card ---
    function takeBack() {
        const record = card.ply !== null ? records[card.ply] : null;
        if (!record) return;
        if (controller.undoTo?.(record.ply - 1)) showInfo('Taken back. Have another look and try again.');
    }

    function showBetter() {
        const record = card.ply !== null ? records[card.ply] : null;
        const best = record?.best, bestText = record?.bestText;
        if (!record || !best) return;
        if (!controller.undoTo?.(record.ply - 1)) return;
        // After the take-back it is the player's turn again in the position where the better move exists
        const shown = controller.showSuggestion?.(best);
        showInfo(shown ? `Try ${bestText} instead. The arrow shows the way.` : `Taken back. ${bestText} was the better move.`);
    }

    // --- Game review (docked panel) ---
    function setReviewVisible() {
        if (!el.review) return;
        el.review.hidden = !(review.open && !review.minimised);
        document.body.classList.toggle('review-open', review.open && !review.minimised);
        updateChip();
    }

    function updateChip() {
        if (!el.reviewChip) return;
        el.reviewChip.hidden = !(review.open && review.minimised);
        el.reviewChip.textContent = controller.state().reviewIndex !== null ? 'Back to review (viewing an earlier position)' : 'Back to review';
    }

    function announceReview(text) {
        if (!el.announce || !text) return;
        el.announce.textContent = '';
        el.announce.textContent = text;
    }

    function openReview() {
        if (!el.review) return;
        clearTimeout(reviewTimer);
        const wasOpen = review.open;
        review.open = true;
        review.minimised = false;
        syncRecords();
        setReviewVisible();
        renderReview();
        runBackfill();
        if (!wasOpen) el.reviewTitle?.focus?.();
    }

    // Closing the review also returns to the live game
    function closeReview() {
        clearTimeout(reviewTimer);
        if (!review.open) return;
        review.open = false;
        review.token++;
        setReviewVisible();
        if (controller.state().reviewIndex !== null) controller.exitReview?.();
        el.reviewOpen?.focus?.();
    }

    function minimiseReview() {
        if (!review.open) return;
        review.minimised = true;
        setReviewVisible();
        el.reviewChip?.focus?.();
    }

    function returnToGame() {
        if (controller.state().reviewIndex !== null) controller.exitReview?.();
        renderReview();
    }

    // Judges every move that has no verdict yet, one at a time, while the panel is open
    async function runBackfill() {
        if (review.running) return;
        review.running = true;
        const myToken = review.token;
        try {
            for (let i = 1; i < records.length; i++) {
                if (myToken !== review.token || !review.open) break;
                const r = records[i];
                if (!r || r.status === 'done' || r.status === 'unavailable' || (r.status === 'failed' && r.attempts >= 3)) continue;
                await judge(r);
                if (records[i] !== r) i = 0; // history changed (undo): start over
            }
        } finally {
            review.running = false;
        }
        if (review.open) renderReview();
    }

    // Shows a move on the board. Flagged moves with a better move show the position BEFORE the move:
    // the played move's squares are highlighted and the better move is the arrow. Other moves show the
    // position after the move. The last move, when it needs no arrow, is simply the live position.
    function select(ply) {
        const last = syncRecords();
        if (!Number.isInteger(ply) || ply < 1 || ply > last) return;
        const record = records[ply];
        review.selected = ply;
        const label = moveLabel(record);
        const verdict = record.status === 'done' ? LABEL[verdictKey(record)] : '';
        let result;
        if (isBad(record) && record.best) {
            result = controller.enterReview?.(ply - 1, {
                lastMove: { from: record.from, to: record.to }, arrow: record.best, force: true,
                text: `Before ${label} (${verdict.toLowerCase()}): played ${record.playedText}, better was ${record.bestText}. Esc returns to the game.`
            });
        } else if (ply === last) {
            if (controller.state().reviewIndex !== null) controller.exitReview?.();
            result = true;
        } else {
            result = controller.enterReview?.(ply, { force: true, text: `After ${label}${verdict ? ` (${verdict.toLowerCase()})` : ''}. Esc returns to the game.` });
        }
        renderReview();
        const li = el.reviewList?.querySelector(`[data-ply="${ply}"]`);
        li?.scrollIntoView?.({ block: 'nearest' });
        announceReview(`${label}${verdict ? `, ${verdict}` : ''}. ${record.text || ''}${record.best && isBad(record) ? ` Better: ${record.bestText}.` : ''}`);
        return result;
    }

    function step(delta, flaggedOnly = false) {
        const last = syncRecords();
        if (!last) return;
        const viewingLive = controller.state().reviewIndex === null;
        let ply = review.selected ?? (delta < 0 ? last + 1 : 0);
        if (viewingLive && review.selected === null && delta < 0) ply = last + 1;
        for (ply += delta; ply >= 1 && ply <= last; ply += delta) {
            if (!flaggedOnly || isFlagged(records[ply])) { select(ply); return; }
        }
        if (delta > 0 && !flaggedOnly) returnToGame();
    }

    function reviewIntro() {
        const last = records.length - 1;
        if (last < 1) return 'No moves yet. Play a few moves, then come back to look at them.';
        if (!engineAvailable()) return 'The engine is not available here, so moves cannot be judged. You can still step through the game.';
        const done = records.filter(r => r && r.status === 'done').length;
        if (done < last) return `Analysing the moves: ${done} of ${last} done...`;
        const st = controller.state();
        const flagged = records.filter(isFlagged);
        const humans = ['w', 'b'].filter(c => controller.isHumanColor?.(c));
        const color = humans.length === 1 ? humans[0] : null;
        let kind = 'closeGame';
        if (st.result === 'checkmate' && color) kind = st.turn === color ? 'toughLoss' : 'wellPlayed';
        else if (!flagged.some(r => r.classification === 'blunder' || r.classification === 'mistake')) kind = 'wellPlayed';
        const opening = st.over ? (template(`review.${kind}`, {}, { color: color || 'w' }) || '') : '';
        const plural = { inaccuracy: 'inaccuracies', mistake: 'mistakes', blunder: 'blunders' };
        const counts = BAD.map(c => [c, flagged.filter(r => r.classification === c).length]).filter(([, n]) => n);
        const summary = counts.length ? counts.map(([c, n]) => `${n} ${n > 1 ? plural[c] : c}`).join(', ') + ' flagged.' : 'Nothing flagged so far.';
        return `${opening} ${summary}`.trim();
    }

    function renderReview() {
        if (!el.review) return;
        const last = records.length - 1;
        el.reviewIntro.textContent = reviewIntro();
        // Move list: updated in place so the scroll position survives
        const list = el.reviewList;
        while (list.children.length > Math.max(0, last)) list.lastChild.remove();
        for (let ply = 1; ply <= last; ply++) {
            const r = records[ply];
            let button = list.children[ply - 1]?.firstChild;
            if (!button) {
                const li = document.createElement('li');
                button = document.createElement('button');
                button.type = 'button';
                button.innerHTML = '<span class="no"></span><span class="mv"></span><span class="tag"></span>';
                button.addEventListener('click', () => select(Number(button.dataset.ply)));
                li.append(button);
                list.append(li);
            }
            const key = r.status === 'done' ? verdictKey(r) : r.status === 'pending' ? 'pending' : '';
            button.dataset.ply = String(ply);
            button.className = `review-move ${key} ${r.human ? 'human' : 'ai'}${ply === review.selected ? ' selected' : ''}${isFlagged(r) ? ' flagged' : ''}`;
            button.setAttribute('aria-current', ply === review.selected ? 'true' : 'false');
            button.querySelector('.no').textContent = `${r.moveNumber}${r.color === 'w' ? '.' : '...'}`;
            button.querySelector('.mv').textContent = r.notation;
            button.querySelector('.tag').textContent = r.status === 'done' ? LABEL[key] : r.status === 'pending' ? '...' : '';
        }
        // Detail of the selected move
        const sel = review.selected !== null ? records[review.selected] : null;
        el.reviewDetail.textContent = '';
        if (sel) {
            const head = document.createElement('strong');
            head.textContent = `${sideName(sel.color)} ${moveLabel(sel)}${sel.status === 'done' ? `: ${LABEL[verdictKey(sel)]}` : ''}`;
            const body = document.createElement('p');
            body.textContent = sel.status === 'done' ? sel.text : sel.status === 'pending' || sel.status === 'new' ? 'Analysing this move...' : 'No verdict for this move.';
            el.reviewDetail.append(head, body);
            if (sel.status === 'done' && sel.best && BAD.includes(sel.classification)) {
                const better = document.createElement('p');
                better.className = 'better';
                better.textContent = `Played ${sel.playedText}. Better: ${sel.bestText} (the arrow on the board).`;
                el.reviewDetail.append(better);
            }
        } else if (last >= 1) {
            el.reviewDetail.textContent = 'Pick a move, or use the arrows to step through the game.';
        }
        const reviewing = controller.state().reviewIndex !== null;
        el.reviewReturn.disabled = !reviewing;
        el.reviewReturn.textContent = reviewing ? 'Return to game' : 'Viewing the game';
        el.reviewPrev.disabled = el.reviewNext.disabled = last < 1;
        const anyFlag = records.some(isFlagged);
        el.reviewPrevFlag.disabled = el.reviewNextFlag.disabled = !anyFlag;
        drawGraph();
    }

    // Small eval graph: White's advantage over the game, clamped to +-10 pawns; flagged moves as dots,
    // the selected move as a vertical marker. Clicking it selects the nearest move.
    function drawGraph() {
        const svg = el.reviewGraph;
        if (!svg) return;
        const pts = records.filter(r => r && Number.isFinite(r.evalAfter));
        const last = records.length - 1;
        const W = 300, H = 70, clampP = (cp) => Math.max(-1000, Math.min(1000, cp));
        const x = (ply) => (last > 1 ? ((ply - 1) / (last - 1)) * (W - 8) + 4 : W / 2);
        const y = (cp) => H / 2 - (clampP(cp) / 1000) * (H / 2 - 4);
        const line = pts.map((r, i) => `${i ? 'L' : 'M'}${x(r.ply).toFixed(1)},${y(r.evalAfter).toFixed(1)}`).join(' ');
        const area = pts.length ? `${line} L${x(pts[pts.length - 1].ply).toFixed(1)},${H / 2} L${x(pts[0].ply).toFixed(1)},${H / 2} Z` : '';
        const dots = pts.filter(isFlagged).map(r =>
            `<circle class="dot ${verdictKey(r)}" cx="${x(r.ply).toFixed(1)}" cy="${y(r.evalAfter).toFixed(1)}" r="3.5"></circle>`).join('');
        const marker = review.selected ? `<line class="marker" x1="${x(review.selected).toFixed(1)}" y1="0" x2="${x(review.selected).toFixed(1)}" y2="${H}"/>` : '';
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.dataset.last = String(last);
        svg.innerHTML = `<line class="mid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>` +
            (pts.length ? `<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}` : '') + marker;
        svg.setAttribute('aria-label', pts.length ? `Evaluation graph over ${last} moves, ${pts.filter(isFlagged).length} flagged` : 'No evaluation data yet');
    }

    function onGraphClick(event) {
        const last = records.length - 1;
        const box = el.reviewGraph.getBoundingClientRect?.();
        if (last < 1 || !box?.width) return;
        const k = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
        select(Math.max(1, Math.min(last, Math.round(k * (last - 1)) + 1)));
    }

    // --- Settings ---
    function setEnabled(on) {
        enabled = !!on;
        saveSetting({ coach: enabled });
        if (el.toggle) el.toggle.checked = enabled;
        if (el.frequencyRow) el.frequencyRow.classList.toggle('disabled', !enabled);
        if (el.frequency) el.frequency.disabled = !enabled;
        controller.setAnalysisNeed?.('coach', enabled ? COACH_ANALYSIS : null);
        if (!enabled) { cancelWarning(); hideCard(); }
        else renderCard();
    }

    function setFrequency(next) {
        frequency = next === 'mistakes' ? 'mistakes' : 'every';
        saveSetting({ coachFrequency: frequency });
        if (el.frequency) el.frequency.value = frequency;
        if (frequency === 'mistakes') {
            cancelWarning();
            card.warning = '';
            const record = card.ply !== null ? records[card.ply] : null;
            if (record && !isBad(record)) hideCard(); else renderCard();
        }
    }

    controller.onEvent(onEvent);
    el.toggle?.addEventListener('change', () => setEnabled(el.toggle.checked));
    el.frequency?.addEventListener('change', () => setFrequency(el.frequency.value));
    el.undo?.addEventListener('click', takeBack);
    el.better?.addEventListener('click', showBetter);
    el.close?.addEventListener('click', dismissCard);
    el.reviewOpen?.addEventListener('click', openReview);
    el.reviewChip?.addEventListener('click', openReview);
    el.reviewClose?.addEventListener('click', closeReview);
    el.reviewMin?.addEventListener('click', minimiseReview);
    el.reviewReturn?.addEventListener('click', returnToGame);
    el.reviewPrev?.addEventListener('click', () => step(-1));
    el.reviewNext?.addEventListener('click', () => step(1));
    el.reviewPrevFlag?.addEventListener('click', () => step(-1, true));
    el.reviewNextFlag?.addEventListener('click', () => step(1, true));
    el.reviewGraph?.addEventListener('click', onGraphClick);
    el.review?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); step(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); step(1); }
    });
    // Capture phase: Escape first returns from an earlier position (the controller does that); a second
    // Escape, or Escape while already in the live game, closes the panel.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !review.open || review.minimised) return;
        if (controller.state().reviewIndex !== null) return;
        if (document.querySelector('.modal:not([hidden])')) return;
        closeReview();
    }, true);
    setFrequency(frequency);
    setEnabled(enabled);
    setReviewVisible();

    return {
        setEnabled, setFrequency, openReview, closeReview, minimiseReview, returnToGame, select, step,
        state: () => ({
            enabled, frequency,
            cardVisible: !!el.card && !el.card.hidden, cardText: el.text?.textContent || '', cardBadge: el.badge?.hidden ? '' : el.badge?.textContent || '',
            cardWarning: card.warning, cardPly: card.ply, cardPending: !!el.card && el.card.classList.contains('pending') && !el.card.hidden,
            reviewOpen: review.open, reviewMinimised: review.minimised, reviewSelected: review.selected,
            records: records.slice(1).map(r => r && ({ ply: r.ply, color: r.color, human: r.human, notation: r.notation, status: r.status,
                classification: r.classification, brilliant: r.brilliant, text: r.text, bestText: r.bestText, flagged: isFlagged(r) })),
            moments: records.slice(1).filter(isFlagged).map(r => ({ ply: r.ply, notation: r.notation, classification: r.classification }))
        })
    };
}
