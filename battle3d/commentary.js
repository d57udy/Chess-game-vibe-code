// Talking kings: picks a predefined line for game events and shows it as a speech bubble above the
// speaking king (sceneAPI.say), with a gesture (units.playGesture), voice blips (audio 'blip') and an
// aria-live caption. Lines live in battle3d/lines/hero-king.json and skeleton-king.json (b3d-lines);
// a few built-in lines keep it working if those files are missing. Never blocks input.
//
//   createCommentary({ controller, sceneAPI, units, audio, captionsEl, levelSelect, log }) -> {
//     setLevel('off' | 'occasional' | 'chatty'), getLevel(), clear(), ready: Promise }

const g = globalThis;
const LEVELS = ['off', 'occasional', 'chatty'];
const SETTINGS_KEY = 'battle3d.settings';
const COOLDOWN_PLIES = { occasional: 3, chatty: 1 };
const RETORT_CHANCE = { occasional: 0.3, chatty: 0.5 };
const URGENT = 80;             // priority that ignores the cooldown
const IDLE_SECONDS = 45;
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

// Retort keys per battle3d/lines/STYLE.md: the other king answers from its counterpart key, retort lines only.
// Events missing here get no retort.
const COUNTERPART = {
    myCapture: 'lostPiece', lostPiece: 'myCapture', capturedQueen: 'lostQueen', lostQueen: 'capturedQueen',
    check: 'gotChecked', gotChecked: 'check', blunderByMe: 'blunderByOpponent', blunderByOpponent: 'blunderByMe',
    winningBig: 'losingBig', losingBig: 'winningBig', checkmateWin: 'checkmateLoss', checkmateLoss: 'checkmateWin',
    mateThreat: 'mateThreat', brilliantMove: 'brilliantMove', hintUsed: 'hintUsed', undoUsed: 'undoUsed',
    gameStart: 'gameStart', repetition: 'repetition', endgame: 'endgame', stalemate: 'stalemate', draw: 'draw'
};
const SLOT_RE = /\{(\w+)\}/g;

// Higher wins when several events happen on the same move
const PRIORITY = {
    checkmateWin: 100, checkmateLoss: 99, stalemate: 90, draw: 90, capturedQueen: 82, lostQueen: 81,
    blunderByOpponent: 76, blunderByMe: 75, brilliantMove: 72, mateThreat: 70, promotion: 65, check: 60,
    gotChecked: 59, winningBig: 55, losingBig: 54, enPassant: 52, castle: 45, myCapture: 40, lostPiece: 39,
    repetition: 38, endgame: 35, longThink: 30, hintUsed: 28, undoUsed: 28, gameStart: 20, idle: 10
};

const GESTURES = {
    myCapture: 'taunt', capturedQueen: 'taunt', check: 'taunt', mateThreat: 'taunt', blunderByOpponent: 'taunt',
    winningBig: 'taunt', checkmateWin: 'cheer', promotion: 'cheer', brilliantMove: 'cheer',
    draw: 'shrug', stalemate: 'shrug', repetition: 'shrug', longThink: 'shrug', idle: 'shrug',
    blunderByMe: 'facepalm', lostQueen: 'facepalm', losingBig: 'facepalm', checkmateLoss: 'facepalm'
};

// Minimal fallback so the feature works before (or without) the line files
const FALLBACK = {
    hero: {
        opponentFallback: 'Lord Rattles',
        events: {
            gameStart: [{ text: 'For honour and glory! Have at thee, {opponent}!' }],
            myCapture: [{ text: 'Your {captured} has been politely escorted off the board.' }],
            lostPiece: [{ text: 'Alas, brave {captured}! We shall sing of you.' }],
            check: [{ text: 'Check! Do mind your crown, {opponent}.' }],
            gotChecked: [{ text: 'A mere scratch on my royal person!' }],
            checkmateWin: [{ text: 'Victory! Someone fetch the trumpets.' }],
            checkmateLoss: [{ text: 'I yield... this time.' }],
            draw: [{ text: 'A draw. Honour is satisfied, mostly.' }],
            stalemate: [{ text: 'Stalemate? How terribly polite of us.' }]
        }
    },
    skeleton: {
        opponentFallback: 'Sir Shiny',
        events: {
            gameStart: [{ text: 'Another game. I have nothing but time. Literally.' }],
            myCapture: [{ text: 'Your {captured} will make an excellent new recruit.' }],
            lostPiece: [{ text: 'Do not worry, my {captured} was mostly bones anyway.' }],
            check: [{ text: 'Check. I can feel your heart racing. I do not have one.' }],
            gotChecked: [{ text: 'Check? I have been in worse places. Like a grave.' }],
            checkmateWin: [{ text: 'Rest in pieces.' }],
            checkmateLoss: [{ text: 'Fine. I will just lie down for a few centuries.' }],
            draw: [{ text: 'A draw. Eternity remains undecided.' }],
            stalemate: [{ text: 'Stalemate. Even my bones are bored.' }]
        }
    }
};

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSetting(key, value) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), [key]: value })); } catch (e) { /* private mode */ }
}

async function fetchBank(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        const events = data?.events || data?.lines; // { events } per battle3d/lines/STYLE.md
        return events && typeof events === 'object' ? { ...data, events } : null;
    } catch (e) {
        return null;
    }
}

export function createCommentary({ controller, sceneAPI, units, audio = null, captionsEl = null, levelSelect = null, base = 'battle3d/lines/', log = () => {} }) {
    const saved = loadSettings().talk;
    let level = LEVELS.includes(saved) ? saved : 'occasional';
    const banks = { hero: FALLBACK.hero, skeleton: FALLBACK.skeleton };
    const bags = new Map();     // `${voice}:${event}:${ctx}` -> remaining line indices
    let lastSpokenPly = -99;
    let pending = [];           // events of the current batch
    let flushQueued = false;
    let idleTimer = null;
    let speakToken = 0;

    const ready = Promise.all([fetchBank(`${base}hero-king.json`), fetchBank(`${base}skeleton-king.json`)]).then(([hero, skeleton]) => {
        if (hero) banks.hero = hero;
        if (skeleton) banks.skeleton = skeleton;
        log('commentary lines', hero ? 'hero ok' : 'hero fallback', skeleton ? 'skeleton ok' : 'skeleton fallback');
    });

    // Which bank speaks for a colour: the cast decides (a skeleton king uses the skeleton lines)
    function voiceFor(color) {
        try {
            const king = units.getLegend?.().find(e => e.color === color && e.type === 'k');
            const text = `${king?.model || ''} ${king?.name || ''}`;
            if (/skelet/i.test(text)) return 'skeleton';
            if (text.trim()) return 'hero';
        } catch (e) { /* fall through */ }
        return color === 'b' ? 'skeleton' : 'hero';
    }
    const kingName = (voice) => (voice === 'skeleton' ? 'The Skeleton King' : 'The Hero King');

    // Tags from the speaking king's side (STYLE.md): vsAI, vsHuman, aiKing, myPlayer, aiWeak, aiStrong
    function contextTags(color) {
        const human = controller.isHumanColor?.(color) ?? true;
        const otherHuman = controller.isHumanColor?.(color === 'w' ? 'b' : 'w') ?? true;
        const tags = new Set();
        if (human) tags.add('myPlayer'); else tags.add('aiKing');
        if (human && otherHuman) tags.add('vsHuman');
        if (human && !otherHuman) tags.add('vsAI');
        // AI level flavour, whenever a side is played by the computer
        const elo = controller.state().elo;
        if ((!human || !otherHuman) && Number.isFinite(elo)) {
            if (elo <= 1000) tags.add('aiWeak');
            if (elo >= 2000) tags.add('aiStrong');
        }
        return tags;
    }

    // A line fits when its text is usable, the game is far enough along, all its context tags hold,
    // every slot it uses can be filled, and it is a retort exactly when we are answering
    function eligible(line, event, tags, slots, retort) {
        if (!line || typeof line.text !== 'string' || !line.text.trim()) return false;
        if (Number.isFinite(line.minPly) && event.ply < line.minPly) return false;
        const lineTags = Array.isArray(line.tags) ? line.tags : [];
        if (lineTags.includes('retort') !== retort) return false;
        if (!lineTags.every(t => t === 'retort' || tags.has(t))) return false;
        return [...line.text.matchAll(SLOT_RE)].every(m => slots[m[1]]);
    }

    // Shuffle bag per voice and event: every eligible line once before any repeats (weights repeat entries)
    function pickLine(voice, event, retort = false) {
        const list = banks[voice]?.events?.[event.type] || FALLBACK[voice].events[event.type] || [];
        if (!list.length) return null;
        const tags = contextTags(event.color);
        const slots = slotValues(event, voice);
        const pool = list.map((line, i) => i).filter(i => eligible(list[i], event, tags, slots, retort));
        if (!pool.length) return null;
        const key = `${voice}:${event.type}:${[...tags].sort().join(',')}:${retort}`;
        let bag = bags.get(key)?.filter(i => pool.includes(i));
        if (!bag?.length) {
            bag = [];
            for (const i of pool) {
                const w = Math.max(1, Math.min(5, Math.round(list[i].weight ?? 1)));
                for (let k = 0; k < w; k++) bag.push(i);
            }
            for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
        }
        const index = bag.pop();
        bags.set(key, bag.filter(i => i !== index)); // weighted duplicates of the same line go too
        return { ...list[index], text: fill(list[index].text, slotValues(event, voice)) };
    }

    // Slots per STYLE.md: {piece} = the piece that moved (the new piece for promotion), {captured} = the taken
    // piece, {square} = the destination, {opponent} = this bank's opponentFallback. Empty = cannot fill.
    function slotValues(event, voice) {
        const piece = event.type === 'promotion' && event.promotion ? event.promotion : event.piece;
        return {
            piece: PIECE_NAMES[String(piece || '').toLowerCase()] || '',
            captured: PIECE_NAMES[String(event.captured || '').toLowerCase()] || '',
            square: event.square ? String.fromCharCode(97 + event.square.col) + (8 - event.square.row) : '',
            opponent: banks[voice]?.opponentFallback || FALLBACK[voice].opponentFallback
        };
    }

    const fill = (text, slots) => text.replace(SLOT_RE, (m, k) => slots[k] || m).replace(/\s+/g, ' ').trim();

    function onEvent(event) {
        if (event.type === 'reset' || event.type === 'review') {
            pending = [];
            clear();
            if (event.type === 'reset') lastSpokenPly = event.reason === 'newGame' ? -99 : Math.min(lastSpokenPly, event.ply);
            return;
        }
        if (event.type === 'turn') {
            armIdle(event);
            return;
        }
        clearTimeout(idleTimer);
        if (level === 'off' || !(event.type in PRIORITY) || (event.color !== 'w' && event.color !== 'b')) return;
        pending.push(event);
        if (!flushQueued) {
            flushQueued = true;
            queueMicrotask(flush); // one decision per move: the controller emits a move's events together
        }
    }

    function flush() {
        flushQueued = false;
        const batch = pending;
        pending = [];
        if (!batch.length || level === 'off') return;
        batch.sort((a, b) => PRIORITY[b.type] - PRIORITY[a.type] + (Math.random() - 0.5) * 0.1);
        const top = batch[0];
        const priority = PRIORITY[top.type];
        const plyGap = top.ply - lastSpokenPly;
        if (priority < URGENT && plyGap < COOLDOWN_PLIES[level] && top.type !== 'gameStart') return;
        // Occasional: small talk sometimes stays unsaid, so the kings do not comment on every capture
        if (level === 'occasional' && priority < 45 && Math.random() < 0.4) return;
        const voice = voiceFor(top.color);
        const line = pickLine(voice, top);
        if (!line) return;
        lastSpokenPly = top.ply;
        const token = ++speakToken;
        speak(top, voice, line.text).then(() => {
            if (token !== speakToken || level === 'off') return;
            const answerType = COUNTERPART[top.type];
            if (!answerType || Math.random() >= RETORT_CHANCE[level]) return;
            const other = top.color === 'w' ? 'b' : 'w';
            const answer = batch.find(e => e.color === other && e.type === answerType) || { ...top, type: answerType, color: other };
            const otherVoice = voiceFor(other);
            const reply = pickLine(otherVoice, answer, true);
            if (reply) speak(answer, otherVoice, reply.text);
        });
    }

    async function speak(event, voice, text) {
        // Wait out a cinematic shot (fights end before events, but an AI move may already be starting)
        for (let i = 0; i < 20 && (sceneAPI.isCinematicActive?.() || controller.state().moving); i++) {
            await new Promise(r => setTimeout(r, 150));
        }
        if (controller.state().moving || controller.state().reviewIndex !== null) return;
        const square = g.findKing?.(event.color);
        const name = kingName(voice);
        const durationMs = Math.min(5000, 1800 + 45 * text.length);
        if (captionsEl) captionsEl.textContent = `${name}: ${text}`;
        const words = text.split(/\s+/).length;
        try {
            const pos = square ? sceneAPI.squareToWorld?.(square.row, square.col) : null;
            audio?.play('blip', { voice, syllables: Math.min(14, Math.ceil(words * 1.4)), pos });
        } catch (e) { log('blip failed', e); }
        try { if (square) units.playGesture?.(square, GESTURES[event.type] || 'talk'); } catch (e) { log('gesture failed', e); }
        let shown = null;
        try { shown = sceneAPI.say?.({ square, text, side: event.color, durationMs }); } catch (e) { log('say failed', e); }
        await Promise.race([Promise.resolve(shown), new Promise(r => setTimeout(r, durationMs + 300))]);
    }

    // The waiting king pipes up when the player to move has been idle for a while
    function armIdle(event) {
        clearTimeout(idleTimer);
        if (level === 'off' || !event.human || event.over) return;
        idleTimer = setTimeout(() => {
            const st = controller.state();
            if (st.moving || st.over || st.reviewIndex !== null || st.history.length !== event.ply) return;
            onEvent({ ...event, type: 'idle', color: event.color === 'w' ? 'b' : 'w', ply: event.ply });
        }, IDLE_SECONDS * 1000);
    }

    function clear() {
        speakToken++;
        clearTimeout(idleTimer);
        try { sceneAPI.clearSpeech?.(); } catch (e) { /* ignore */ }
        if (captionsEl) captionsEl.textContent = '';
    }

    function setLevel(next) {
        level = LEVELS.includes(next) ? next : 'occasional';
        saveSetting('talk', level);
        if (levelSelect) levelSelect.value = level;
        controller.setAnalysisNeed?.('commentary', level === 'off' ? null : { nodes: 80000, multiPv: 1 });
        if (level === 'off') clear();
    }

    controller.onEvent(onEvent);
    if (levelSelect) {
        levelSelect.value = level;
        levelSelect.addEventListener('change', () => setLevel(levelSelect.value));
    }
    setLevel(level);

    return { setLevel, getLevel: () => level, clear, ready };
}
