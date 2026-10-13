// --- START OF FILE savegame.js ---
// Saving, loading and exporting games: autosave, named saves, PGN export and import.
// View-agnostic: the 2D game (2d.html) and the 3D game (index.html) both use it, with savepanel.js as
// the shared panel. No DOM building here; the browser is only touched for localStorage, the clipboard,
// the share sheet and file downloads, each feature-detected. Nothing is sent over the network.
//
// ONE file, two ways to load it, no build step:
//   2D page   <script src="savegame.js"></script>            classic script, defines the global `SaveGame`
//   3D page   import { SaveGame } from './battle3d/saves.js'   (that module runs this file for its side
//             effect with `import '../savegame.js'` and re-exports the global)
// So this file has no import/export statements, no top-level `this`, and one function scope.
//
// Rules: the game's own. Everything goes through the global functions of gameLogic.js and
// battle3d/rules.js (looked up when called, so the load order does not matter): a load replays the
// start position plus the moves with battle3dLoadFen / battle3dNewGame + battle3dApplyMove, all or
// nothing (snapshot() / restore() below put the previous game back when a move is illegal).
//
// Record (storage format version 1, see battle3d/CONTRACT.md "v6.3"):
//   { v: 1, id?, name?, savedAt, startedAt, view: '3d' | '2d', mode: 'human-ai' | 'human-human' | 'ai-ai' | null,
//     humanColor: 'w' | 'b' | null, elo: number | null, startFen: fen | null (null = the usual start position),
//     moves: ['e2e4', 'e7e8q', ...] (replayed on load), san: ['e4', 'e8=Q+', ...] (standard SAN, for export),
//     result: '*' | '1-0' | '0-1' | '1/2-1/2', fen: final position, cursor?: shown position (2D, when not the last) }
// localStorage keys: chess.autosave.3d, chess.autosave.2d (one record each), chess.saves ({ v: 1, saves: [record] }).
(function (root) {
    'use strict';

    const FORMAT_VERSION = 1;
    const MAX_SAVES = 30;
    const MAX_NAME = 60;
    const MAX_PLIES = 2000;          // far beyond any real game; guards against junk data
    const MAX_PGN_CHARS = 1000000;
    const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const SAVES_KEY = 'chess.saves';
    const UNREADABLE_KEY = 'chess.saves.unreadable'; // a saves list this version could not read is set aside here, not deleted
    const autosaveKey = (view) => `chess.autosave.${view === '2d' ? '2d' : '3d'}`;
    const MODES = ['human-ai', 'human-human', 'ai-ai'];
    const RESULTS = ['*', '1-0', '0-1', '1/2-1/2'];
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

    // Older formats are upgraded step by step: MIGRATIONS[n] turns a version n object into version n + 1.
    // Version 1 is the first format, so the table is empty. Data written by a newer version is not read.
    const MIGRATIONS = {};

    // The game's rules, as global functions (gameLogic.js, battle3d/rules.js)
    const R = new Proxy({}, {
        get(target, name) {
            const fn = root[name];
            if (typeof fn !== 'function') throw new Error(`savegame: ${String(name)}() is not loaded`);
            return fn;
        }
    });

    // The whole game, kept aside for all-or-nothing loads. gameLogic.js holds the game in top-level `let`
    // bindings, which every script and module of the page shares by name (they are not properties of
    // window). These two functions are the only place that touches them; history entries are never
    // changed after they are pushed, so keeping the array is enough.
    /* global gameHistory:writable, currentMoveIndex:writable, isGameOver:writable, gameStatusMessage:writable */
    function snapshot() {
        return { history: gameHistory, index: currentMoveIndex, over: isGameOver, message: gameStatusMessage };
    }
    function restore(saved) {
        gameHistory = saved.history;
        currentMoveIndex = saved.index;
        if (saved.history[saved.index]) R.loadGameStateSnapshot(saved.history[saved.index]);
        isGameOver = saved.over;
        gameStatusMessage = saved.message;
    }

    const squareName = (sq) => String.fromCharCode(97 + sq.col) + (8 - sq.row);
    const squareAt = (name) => ({ row: 8 - Number(name[1]), col: name.charCodeAt(0) - 97 });
    const fenOf = (entry) => `${R.getBoardPositionString(entry)} ${entry.halfmoveClock} ${entry.fullmoveNumber}`;
    // Stored SAN and exported PGN are standard: an on-screen decoration such as "e.p." never gets in
    const cleanSan = (san) => String(san || '').replace(/\s*e\.\s?p\.?/i, '').trim();

    // --- Records ---------------------------------------------------------------------------------

    function upgrade(data) {
        let d = data;
        while (d && typeof d === 'object' && Number.isInteger(d.v) && d.v < FORMAT_VERSION && typeof MIGRATIONS[d.v] === 'function') d = MIGRATIONS[d.v](d);
        return d && typeof d === 'object' && !Array.isArray(d) && d.v === FORMAT_VERSION ? d : null;
    }

    // 'version' when the data says it is another format, else 'corrupt'
    const problemOf = (data) => (data && typeof data === 'object' && Number.isInteger(data.v) && data.v !== FORMAT_VERSION ? 'version' : 'corrupt');

    // Light shape check, enough to keep junk away from parseFen (which logs errors); legality is the rules' job
    function plausibleFen(fen) {
        if (typeof fen !== 'string' || fen.length > 100) return false;
        const parts = fen.trim().split(/\s+/);
        if (parts.length !== 6 || !/^[wb]$/.test(parts[1]) || !/^(-|[KQkq]{1,4})$/.test(parts[2]) || !/^(-|[a-h][36])$/.test(parts[3])) return false;
        if (!/^\d+$/.test(parts[4]) || !/^\d+$/.test(parts[5])) return false;
        const rows = parts[0].split('/');
        if (rows.length !== 8) return false;
        for (const row of rows) {
            let width = 0;
            for (const ch of row) {
                if (/[1-8]/.test(ch)) width += Number(ch);
                else if (/[pnbrqkPNBRQK]/.test(ch)) width++;
                else return false;
            }
            if (width !== 8) return false;
        }
        return (parts[0].match(/K/g) || []).length === 1 && (parts[0].match(/k/g) || []).length === 1;
    }

    const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

    // A clean copy of a stored or imported record, or null when it cannot be a game
    function normalizeRecord(raw) {
        const d = upgrade(raw);
        if (!d || !Array.isArray(d.moves) || d.moves.length > MAX_PLIES) return null;
        if (!d.moves.every(m => typeof m === 'string' && UCI_RE.test(m))) return null;
        let startFen = null;
        if (d.startFen !== null && d.startFen !== undefined) {
            if (!plausibleFen(d.startFen)) return null;
            startFen = d.startFen.trim().split(/\s+/).join(' ');
            if (startFen === START_FEN) startFen = null;
        }
        const time = (t) => (Number.isFinite(t) && t > 0 ? t : null);
        const record = {
            v: FORMAT_VERSION,
            savedAt: time(d.savedAt) ?? 0,
            startedAt: time(d.startedAt) ?? time(d.savedAt) ?? 0,
            view: d.view === '2d' ? '2d' : '3d',
            mode: MODES.includes(d.mode) ? d.mode : null,
            humanColor: d.humanColor === 'w' || d.humanColor === 'b' ? d.humanColor : null,
            elo: Number.isFinite(d.elo) ? d.elo : null,
            startFen,
            moves: d.moves.slice(),
            san: Array.isArray(d.san) && d.san.length === d.moves.length && d.san.every(s => typeof s === 'string') ? d.san.map(cleanSan) : null,
            result: RESULTS.includes(d.result) ? d.result : '*',
            fen: typeof d.fen === 'string' && plausibleFen(d.fen) ? d.fen : null
        };
        if (typeof d.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(d.id)) record.id = d.id;
        if (typeof d.name === 'string' && cleanName(d.name)) record.name = cleanName(d.name);
        if (Number.isInteger(d.cursor) && d.cursor >= 0 && d.cursor < d.moves.length) record.cursor = d.cursor;
        return record;
    }

    const sameGame = (a, b) => !!a && !!b && (a.startFen || null) === (b.startFen || null) && a.moves.join(' ') === b.moves.join(' ');

    // Result of the last position of the game. The 2D view may be showing an earlier position; the last
    // one is then put on the board for the check and the shown one put back.
    function finalResult(state = R.battle3dState()) {
        const hist = state.gameHistory, last = hist[hist.length - 1];
        const atEnd = state.currentMoveIndex === hist.length - 1;
        if (!atEnd) R.loadGameStateSnapshot(last);
        try {
            const end = R.checkGameEndCondition();
            if (end === 'checkmate') return last.currentPlayer === 'w' ? '0-1' : '1-0';
            if (end === 'stalemate' || last.halfmoveClock >= 100 || R.hasInsufficientMaterial()) return '1/2-1/2';
            if (atEnd) return R.checkThreefoldRepetition() ? '1/2-1/2' : '*';
            // checkThreefoldRepetition() counts up to the shown position: count over the whole game, with the
            // game's own repetition key (an en passant square only counts when the capture is legal)
            const key = R.getHistoryRepetitionKey(hist.length - 1);
            let seen = 0;
            for (let i = 0; i < hist.length; i++) if (R.getHistoryRepetitionKey(i) === key) seen++;
            return seen >= 3 ? '1/2-1/2' : '*';
        } finally {
            if (!atEnd) R.loadGameStateSnapshot(hist[state.currentMoveIndex]);
        }
    }

    // The game in the rules state as a record. meta: { view, mode, humanColor, elo, startedAt }.
    // Null when there is no game yet (or a history entry carries no move squares).
    function currentRecord(meta = {}) {
        const state = R.battle3dState();
        const hist = state.gameHistory;
        if (!Array.isArray(hist) || !hist.length || state.currentMoveIndex < 0) return null;
        const moves = [], san = [];
        for (let i = 1; i < hist.length; i++) {
            const before = hist[i - 1], after = hist[i], move = after.lastMove;
            if (!move?.from || !move?.to) return null;
            const piece = before.board[move.from.row][move.from.col];
            const placed = after.board[move.to.row][move.to.col];
            const promotion = piece && placed && piece.toLowerCase() === 'p' && placed.toLowerCase() !== 'p' ? placed.toLowerCase() : '';
            moves.push(squareName(move.from) + squareName(move.to) + promotion);
            san.push(cleanSan(after.moveNotation));
        }
        const start = fenOf(hist[0]);
        const now = Date.now();
        const record = {
            v: FORMAT_VERSION,
            savedAt: now,
            startedAt: Number.isFinite(meta.startedAt) ? meta.startedAt : now,
            view: meta.view === '2d' ? '2d' : '3d',
            mode: MODES.includes(meta.mode) ? meta.mode : null,
            humanColor: meta.humanColor === 'w' || meta.humanColor === 'b' ? meta.humanColor : null,
            elo: Number.isFinite(meta.elo) ? meta.elo : null,
            startFen: start === START_FEN ? null : start,
            moves, san,
            result: finalResult(state),
            fen: fenOf(hist[hist.length - 1])
        };
        if (state.currentMoveIndex < hist.length - 1) record.cursor = state.currentMoveIndex;
        return record;
    }

    // Loads a start position into the rules state; throws when it is not a playable position
    function startFrom(startFen) {
        if (!startFen) { R.battle3dNewGame(); return; }
        if (!plausibleFen(startFen)) throw new Error('invalid FEN');
        R.battle3dLoadFen(startFen);
        const mover = R.battle3dState().currentPlayer;
        if (R.isKingInCheck(mover === 'w' ? 'b' : 'w')) throw new Error('the side that just moved is in check');
    }

    // Replaces the game in the rules state with the record: all moves or nothing. The view must be told
    // afterwards (3D: controller.loadGame(() => applyRecord(record)), 2D: showLoadedGame() in saves2d.js);
    // session.load() below does both.
    // -> { ok: true, record } | { ok: false, error, ply } with the previous game untouched.
    function applyRecord(raw) {
        const record = normalizeRecord(raw);
        if (!record) return { ok: false, ply: 0, error: 'This saved game cannot be read.' };
        const saved = snapshot();
        let ply = 0;
        try {
            startFrom(record.startFen);
            for (const uci of record.moves) {
                ply++;
                R.battle3dApplyMove(squareAt(uci.slice(0, 2)), squareAt(uci.slice(2, 4)), uci[4] ? uci[4].toUpperCase() : null);
            }
            return { ok: true, record };
        } catch (e) {
            restore(saved);
            return {
                ok: false, ply,
                error: ply ? `This saved game cannot be loaded: its move ${ply} (${record.moves[ply - 1]}) is not legal.`
                    : 'This saved game cannot be loaded: its start position is not valid.'
            };
        }
    }

    // --- PGN export --------------------------------------------------------------------------------

    const pad = (n) => String(n).padStart(2, '0');
    function pgnDate(time) {
        const d = new Date(time);
        if (!Number.isFinite(time) || !time || Number.isNaN(d.getTime())) return '????.??.??';
        return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
    }

    function playerName(record, color) {
        const ai = Number.isFinite(record.elo) ? `AI (ELO ${record.elo})` : 'AI';
        if (record.mode === 'human-human') return 'Human';
        if (record.mode === 'ai-ai') return ai;
        if (record.mode === 'human-ai') return color === (record.humanColor || 'w') ? 'Human' : ai;
        return '?';
    }

    const tagValue = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    // Standard PGN: the Seven Tag Roster (plus SetUp and FEN for a game that did not start from the usual
    // position), a blank line, then the movetext in SAN with move numbers and the result on one line.
    // options: { event, site, white, black } override the defaults.
    function toPgn(record, options = {}) {
        if (!record || !Array.isArray(record.san) || record.san.length !== record.moves.length) throw new Error('savegame: the record has no SAN moves');
        const result = RESULTS.includes(record.result) ? record.result : '*';
        const tags = [
            ['Event', options.event || 'Chess game'],
            ['Site', options.site || '?'],
            ['Date', pgnDate(record.startedAt || record.savedAt)],
            ['Round', '-'],
            ['White', options.white || playerName(record, 'w')],
            ['Black', options.black || playerName(record, 'b')],
            ['Result', result]
        ];
        if (record.startFen) tags.push(['SetUp', '1'], ['FEN', record.startFen]);
        const parts = (record.startFen || START_FEN).split(' ');
        let number = parseInt(parts[5], 10) || 1;
        let white = parts[1] !== 'b';
        const text = [];
        record.san.forEach((san, i) => {
            if (white) text.push(`${number}.`);
            else if (i === 0) text.push(`${number}...`);
            text.push(cleanSan(san));
            if (!white) number++;
            white = !white;
        });
        text.push(result);
        return `${tags.map(([k, v]) => `[${k} "${tagValue(v)}"]`).join('\n')}\n\n${text.join(' ')}\n`;
    }

    // --- PGN import --------------------------------------------------------------------------------

    // Splits PGN text into its tags and the SAN tokens of the first game's main line. Comments ({...} and
    // ; to the end of the line), % lines, NAGs ($n), variations (...) with any nesting, move numbers,
    // detached !? marks and "e.p." are skipped. No rules involved.
    // -> { tags, sans: [string], result: string | null, more: boolean (text continues with another game) }
    function parsePgn(input) {
        const text = String(input ?? '').slice(0, MAX_PGN_CHARS).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^%.*$/gm, '');
        const tags = {};
        const tagRe = /\s*\[\s*([A-Za-z0-9_]+)\s*"((?:[^"\\\n]|\\.)*)"\s*\]/y;
        let i = 0;
        for (let m; (tagRe.lastIndex = i, m = tagRe.exec(text));) {
            tags[m[1]] = m[2].replace(/\\(["\\])/g, '$1');
            i = tagRe.lastIndex;
        }
        const sans = [];
        let result = null, depth = 0, more = false;
        const n = text.length;
        while (i < n) {
            const ch = text[i];
            if (/\s/.test(ch)) { i++; continue; }
            if (ch === '{') { const end = text.indexOf('}', i); i = end < 0 ? n : end + 1; continue; }
            if (ch === ';') { const end = text.indexOf('\n', i); i = end < 0 ? n : end + 1; continue; }
            if (ch === '(') { depth++; i++; continue; }
            if (ch === ')') { depth = Math.max(0, depth - 1); i++; continue; }
            if (ch === '[' && depth === 0) { more = true; break; } // tags of a second game
            let j = i;
            while (j < n && !/[\s{}();]/.test(text[j])) j++;
            if (j === i) { i++; continue; }                             // a stray "}"
            let token = text.slice(i, j);
            i = j;
            if (depth > 0) continue;
            if (/^(1-0|0-1|1\/2-1\/2|\u00bd-\u00bd|\*)$/.test(token)) {
                result = token === '\u00bd-\u00bd' ? '1/2-1/2' : token;
                more = /\S/.test(text.slice(i).replace(/\{[^}]*\}|;[^\n]*/g, ''));
                break;
            }
            token = token.replace(/^\d+\.+/, '');                       // "12." "12..." "12.Nf3"
            if (!token || /^\.+$/.test(token) || /^\$\d+$/.test(token) || /^[!?]+$/.test(token) || /^e\.?p\.?$/i.test(token)) continue;
            sans.push(token);
        }
        return { tags, sans, result, more };
    }

    // Finds the legal move a SAN token means in the current position (side to move), by matching the
    // token against the game's own legal moves: no rule logic here. Tolerates check and annotation marks,
    // "e.p.", 0-0 for O-O, a missing or extra x, more disambiguation than needed ("Nbd7", "Ng1f3",
    // "e2-e4") and promotions written "e8Q" or "e8=q".
    // -> { move: { from, to, promotion } } | { reason: 'syntax' | 'illegal' | 'ambiguous' }
    function sanToMove(san) {
        const state = R.battle3dState();
        const side = state.currentPlayer;
        const token = String(san || '').trim().replace(/[+#!?]/g, '').replace(/e\.?p\.?$/i, '');
        const candidates = [];
        const collect = (type, accept) => {
            for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
                const piece = R.getPieceAt(row, col);
                if (!piece || R.getPlayerForPiece(piece) !== side || piece.toUpperCase() !== type) continue;
                for (const m of R.generateLegalMoves(row, col)) if (accept(m, row, col)) candidates.push({ from: { row, col }, to: { row: m.row, col: m.col }, isPromotion: !!m.isPromotion });
            }
        };
        let promotion = null;
        const castle = /^([O0o])-\1(-\1)?$/.exec(token);
        if (castle) {
            const queenside = !!castle[2];
            collect('K', (m, row, col) => m.isCastling && (m.col < col) === queenside);
        } else {
            const m = /^([KQRBN])?([a-h])?([1-8])?[x:-]?([a-h])([1-8])(?:=?([QRBNqrbn]))?$/.exec(token);
            if (!m) return { reason: 'syntax' };
            const type = m[1] || 'P';
            const fromCol = m[2] ? m[2].charCodeAt(0) - 97 : null, fromRow = m[3] ? 8 - Number(m[3]) : null;
            const to = squareAt(m[4] + m[5]);
            promotion = m[6] ? m[6].toUpperCase() : null;
            if (promotion && type !== 'P') return { reason: 'syntax' };
            collect(type, (move, row, col) => move.row === to.row && move.col === to.col &&
                (fromCol === null ? type !== 'P' || col === to.col : col === fromCol) &&   // "d5" is the pawn push, never exd5
                (fromRow === null || row === fromRow) &&
                !!move.isPromotion === !!promotion);
        }
        if (!candidates.length) return { reason: 'illegal' };
        if (candidates.length > 1) return { reason: 'ambiguous' };
        return { move: { from: candidates[0].from, to: candidates[0].to, promotion } };
    }

    // Game settings from the White / Black tags this module writes ("Human", "AI (ELO 1200)"); other names give {}
    function settingsFromTags(tags) {
        const ai = (name) => { const m = /^AI(?: \(ELO (\d+)\))?$/.exec(name || ''); return m ? { elo: m[1] ? Number(m[1]) : null } : null; };
        const whiteAi = ai(tags.White), blackAi = ai(tags.Black);
        const whiteHuman = tags.White === 'Human', blackHuman = tags.Black === 'Human';
        if (whiteHuman && blackHuman) return { mode: 'human-human' };
        if (whiteHuman && blackAi) return { mode: 'human-ai', humanColor: 'w', elo: blackAi.elo };
        if (whiteAi && blackHuman) return { mode: 'human-ai', humanColor: 'b', elo: whiteAi.elo };
        if (whiteAi && blackAi) return { mode: 'ai-ai', elo: whiteAi.elo ?? blackAi.elo };
        return {};
    }

    const SAN_PROBLEM = {
        syntax: 'is not a chess move',
        illegal: 'is not a legal move in that position',
        ambiguous: 'could be more than one piece'
    };

    // Castling rights and en passant square of a FEN, comparable whatever the order of the letters
    const fenRights = (fen) => { const parts = fen.split(' '); return `${[...parts[2]].sort().join('')} ${parts[3]}`; };

    // Reads PGN text into a record, validating every move with the game's rules. The rules state is used
    // for the replay and put back afterwards, so nothing is loaded here (see applyRecord / session.load).
    // A FEN tag is taken as the rules read it: parseFen drops castling rights without king and rook at home
    // and an en passant square without a pawn that just made a double step; `adjusted` says that happened
    // (record.startFen is the cleaned position, and a move that needed the dropped right is illegal).
    // -> { ok: true, record, more, adjusted } | { ok: false, error, ply, moveNumber, color, san }
    function fromPgn(input) {
        const pgn = parsePgn(input);
        const hasFen = typeof pgn.tags.FEN === 'string' && pgn.tags.FEN.trim() !== '' && pgn.tags.SetUp !== '0';
        if (!pgn.sans.length && !hasFen) return { ok: false, ply: 0, error: 'No moves found. Paste the moves of a game, for example: 1. e4 e5 2. Nf3' };
        if (pgn.sans.length > MAX_PLIES) return { ok: false, ply: 0, error: 'This game is too long to load.' };
        const fenParts = hasFen ? pgn.tags.FEN.trim().split(/\s+/) : null;
        if (fenParts && fenParts.length === 4) fenParts.push('0', '1'); // some programs leave the clocks out
        const startFen = fenParts ? fenParts.join(' ') : null;
        const saved = snapshot();
        try {
            try { startFrom(startFen); } catch (e) {
                return { ok: false, ply: 0, error: 'The start position (FEN) of this game is not valid. Nothing was loaded.' };
            }
            for (let i = 0; i < pgn.sans.length; i++) {
                const state = R.battle3dState();
                const color = state.currentPlayer;
                const moveNumber = state.gameHistory[state.currentMoveIndex].fullmoveNumber;
                const found = sanToMove(pgn.sans[i]);
                let reason = found.reason;
                if (found.move) {
                    try { R.battle3dApplyMove(found.move.from, found.move.to, found.move.promotion); } catch (e) { reason = 'illegal'; }
                }
                if (reason) {
                    return {
                        ok: false, ply: i + 1, moveNumber, color, san: pgn.sans[i],
                        error: `Move ${moveNumber} for ${color === 'w' ? 'White' : 'Black'} ("${pgn.sans[i].slice(0, 12)}") ${SAN_PROBLEM[reason]}. Nothing was loaded.`
                    };
                }
            }
            const started = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(pgn.tags.Date || '');
            const startedAt = started ? new Date(Number(started[1]), Number(started[2]) - 1, Number(started[3]), 12).getTime() : NaN;
            const record = currentRecord({ ...settingsFromTags(pgn.tags), startedAt: Number.isFinite(startedAt) ? startedAt : Date.now() });
            const adjusted = !!startFen && fenRights(startFen) !== fenRights(record.startFen || START_FEN);
            return { ok: true, record, more: pgn.more, adjusted };
        } finally {
            restore(saved);
        }
    }

    // --- Words for the panel ---------------------------------------------------------------------------

    const shortDate = (time, withYear = false) => {
        const d = new Date(time);
        if (!time || Number.isNaN(d.getTime())) return '';
        return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`;
    };

    function opponentLabel(record) {
        const elo = Number.isFinite(record.elo) ? ` ${record.elo}` : '';
        if (record.mode === 'human-human') return '2 players';
        if (record.mode === 'ai-ai') return `AI vs AI${elo}`;
        return `vs AI${elo}`;
    }

    // "12 Oct, vs AI 1200"
    const defaultName = (record, time = Date.now()) => `${shortDate(time)}, ${opponentLabel(record)}`;

    const RESULT_WORDS = { '1-0': 'White won', '0-1': 'Black won', '1/2-1/2': 'draw', '*': 'in progress' };
    const moveCount = (record) => Math.ceil(record.moves.length / 2);

    // "12 Oct 2026, 20 moves, in progress"
    function describe(record) {
        const moves = moveCount(record);
        return [shortDate(record.savedAt, true), `${moves} ${moves === 1 ? 'move' : 'moves'}`, RESULT_WORDS[record.result] || RESULT_WORDS['*']].filter(Boolean).join(', ');
    }

    function pgnFileName(record) {
        const d = new Date(record.startedAt || record.savedAt || Date.now());
        return `chess-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${moveCount(record)}-moves.pgn`;
    }

    // --- Storage -----------------------------------------------------------------------------------

    function defaultStorage() {
        try { return root.localStorage || null; } catch (e) { return null; } // blocked storage throws on access
    }

    // Autosave slots and the list of named saves. Every method is safe with a missing, full, throwing or
    // corrupted storage: reads fall back to "nothing there", writes report false / { ok: false }.
    function createStore(storage = defaultStorage()) {
        const read = (key) => { try { return storage ? storage.getItem(key) : null; } catch (e) { return null; } };
        const write = (key, value) => { try { if (!storage) return false; storage.setItem(key, value); return true; } catch (e) { return false; } };
        const drop = (key) => { try { storage?.removeItem(key); } catch (e) { /* ignore */ } };

        // -> { record, problem }: problem is 'corrupt' or 'version' when something was stored but is unusable
        function loadAutosave(view) {
            const raw = read(autosaveKey(view));
            if (raw === null || raw === '') return { record: null, problem: null };
            let data;
            try { data = JSON.parse(raw); } catch (e) { return { record: null, problem: 'corrupt' }; }
            const record = normalizeRecord(data);
            return record ? { record, problem: null } : { record: null, problem: problemOf(data) };
        }

        // record null clears the slot
        function saveAutosave(view, record) {
            if (!record) { drop(autosaveKey(view)); return true; }
            return write(autosaveKey(view), JSON.stringify(record));
        }

        function readSaves() {
            const raw = read(SAVES_KEY);
            if (raw === null || raw === '') return { saves: [], problem: null, raw: null };
            let data;
            try { data = JSON.parse(raw); } catch (e) { return { saves: [], problem: 'corrupt', raw }; }
            const list = upgrade(data);
            if (!list || !Array.isArray(list.saves)) return { saves: [], problem: problemOf(data), raw };
            // Single damaged entries are dropped, the rest of the list survives
            const saves = list.saves.map(normalizeRecord).filter(r => r && r.id && r.name).slice(0, MAX_SAVES);
            return { saves, problem: null, raw };
        }

        function writeSaves(saves, previous) {
            if (previous.problem && previous.raw) write(UNREADABLE_KEY, previous.raw);
            return write(SAVES_KEY, JSON.stringify({ v: FORMAT_VERSION, saves }));
        }

        // Newest first
        const list = () => readSaves().saves.sort((a, b) => b.savedAt - a.savedAt);
        const problem = () => readSaves().problem;
        const get = (id) => readSaves().saves.find(s => s.id === id) || null;
        const findByName = (name) => { const key = cleanName(name).toLowerCase(); return readSaves().saves.find(s => s.name.toLowerCase() === key) || null; };

        // Saves `record` under `name`. A save with the same name is replaced only with { replace: true }.
        // -> { ok: true, id, replaced } | { ok: false, error: 'name' | 'exists' | 'full' | 'storage', id? }
        function save(name, record, { replace = false } = {}) {
            const clean = cleanName(name);
            const normal = normalizeRecord(record);
            if (!clean || !normal) return { ok: false, error: 'name' };
            const current = readSaves();
            const existing = current.saves.find(s => s.name.toLowerCase() === clean.toLowerCase());
            if (existing && !replace) return { ok: false, error: 'exists', id: existing.id };
            if (!existing && current.saves.length >= MAX_SAVES) return { ok: false, error: 'full' };
            const id = existing ? existing.id : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
            const entry = { ...normal, id, name: clean, savedAt: Date.now() };
            delete entry.cursor;
            const saves = current.saves.filter(s => s.id !== id).concat(entry);
            return writeSaves(saves, current) ? { ok: true, id, replaced: !!existing } : { ok: false, error: 'storage' };
        }

        function rename(id, name) {
            const clean = cleanName(name);
            const current = readSaves();
            const entry = current.saves.find(s => s.id === id);
            if (!entry || !clean) return { ok: false, error: 'name' };
            if (current.saves.some(s => s.id !== id && s.name.toLowerCase() === clean.toLowerCase())) return { ok: false, error: 'exists' };
            entry.name = clean;
            return writeSaves(current.saves, current) ? { ok: true } : { ok: false, error: 'storage' };
        }

        function remove(id) {
            const current = readSaves();
            const saves = current.saves.filter(s => s.id !== id);
            if (saves.length === current.saves.length) return { ok: false, error: 'name' };
            return writeSaves(saves, current) ? { ok: true } : { ok: false, error: 'storage' };
        }

        return { loadAutosave, saveAutosave, list, problem, get, findByName, save, rename, remove, max: MAX_SAVES };
    }

    // --- Getting text out of the app ----------------------------------------------------------------
    // env ({ navigator, document, URL, Blob }) is only passed by tests.

    // Clipboard API first; when it is missing or refuses (no permission, page not focused, http) the old
    // execCommand way. -> { ok, method: 'clipboard' | 'execCommand' | null }
    async function copyText(text, env = {}) {
        const nav = env.navigator ?? root.navigator, doc = env.document ?? root.document;
        try {
            if (typeof nav?.clipboard?.writeText === 'function') {
                await nav.clipboard.writeText(text);
                return { ok: true, method: 'clipboard' };
            }
        } catch (e) { /* fall through */ }
        try {
            if (doc?.body && typeof doc.execCommand === 'function') {
                const area = doc.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.setAttribute('aria-hidden', 'true');
                area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
                doc.body.append(area);
                area.select();
                area.setSelectionRange?.(0, text.length);
                const copied = doc.execCommand('copy');
                area.remove();
                if (copied) return { ok: true, method: 'execCommand' };
            }
        } catch (e) { /* fall through */ }
        return { ok: false, method: null };
    }

    const canShare = (env = {}) => typeof (env.navigator ?? root.navigator)?.share === 'function';

    // The system share sheet (Android, iOS, some desktops). -> { ok, reason?: 'unavailable' | 'cancelled' | 'failed' }
    async function shareText({ title, text }, env = {}) {
        const nav = env.navigator ?? root.navigator;
        if (typeof nav?.share !== 'function') return { ok: false, reason: 'unavailable' };
        try {
            await nav.share({ title, text });
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: e?.name === 'AbortError' ? 'cancelled' : 'failed' };
        }
    }

    // Saves text as a file through a temporary download link. -> { ok, method: 'blob' | 'data' | null }
    function downloadText(filename, text, env = {}) {
        const doc = env.document ?? root.document, URLApi = env.URL ?? root.URL, BlobApi = env.Blob ?? root.Blob;
        if (!doc?.body) return { ok: false, method: null };
        const click = (href) => {
            const link = doc.createElement('a');
            link.href = href;
            link.download = filename;
            link.style.display = 'none';
            doc.body.append(link);
            link.click();
            link.remove();
        };
        try {
            if (typeof BlobApi === 'function' && typeof URLApi?.createObjectURL === 'function') {
                const url = URLApi.createObjectURL(new BlobApi([text], { type: 'application/vnd.chess-pgn' }));
                click(url);
                setTimeout(() => { try { URLApi.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 2000);
                return { ok: true, method: 'blob' };
            }
        } catch (e) { /* fall through */ }
        try {
            click(`data:application/vnd.chess-pgn;charset=utf-8,${encodeURIComponent(text)}`);
            return { ok: true, method: 'data' };
        } catch (e) {
            return { ok: false, method: null };
        }
    }

    // --- Session: one per page, the glue between a view and everything above ------------------------------

    const RESUME_NOTICE = 'Your saved game could not be read, so a new game was started.';

    // host: {
    //   view: '3d' | '2d', title: PGN Event name, site?: PGN Site (default: the page origin),
    //   settings(): { mode, humanColor, elo }             the view's current game settings (record names)
    //   adopt(apply, settings, { review, cursor }) -> result   performs a load: stop what is in flight, call
    //                                                     apply() (= applyRecord, returns { ok, ... }), apply
    //                                                     the given settings and redraw; review: open the review
    //   busy?(): string | null                            why a load is not possible right now
    //   fen?(): string                                    the position on screen, when it is not the live one
    //   storage?: Storage (tests)
    // }
    function createSession(host) {
        const view = host.view === '2d' ? '2d' : '3d';
        const store = createStore(host.storage === undefined ? defaultStorage() : host.storage);
        let startedAt = Date.now();

        const site = () => {
            if (host.site) return host.site;
            const origin = root.location?.origin;
            return origin && origin !== 'null' ? origin : '?';
        };

        const record = () => currentRecord({ ...host.settings(), view, startedAt });

        // Called by the view after every change of the game or its settings (reason 'newGame' restarts the clock).
        // A new game without moves clears the slot.
        function autosave(reason) {
            if (reason === 'newGame') startedAt = Date.now();
            if (host.busy?.()) return false; // mid-move (2D): the redraw after the move saves it
            let current = null;
            try { current = record(); } catch (e) { return false; }
            if (!current) return false;
            return store.saveAutosave(view, current.moves.length || current.startFen ? current : null);
        }

        // Loads a record into the game. -> { ok: true, record } | { ok: false, error }
        function load(raw, { review = false } = {}) {
            const why = host.busy?.();
            if (why) return { ok: false, error: why };
            const rec = normalizeRecord(raw);
            if (!rec) return { ok: false, error: 'This saved game cannot be read.' };
            const settings = {};
            if (rec.mode) settings.mode = rec.mode;
            if (rec.humanColor) settings.humanColor = rec.humanColor;
            if (rec.elo !== null) settings.elo = rec.elo;
            let result;
            try {
                result = host.adopt(() => applyRecord(rec), settings, { review, cursor: rec.cursor ?? null });
            } catch (e) {
                result = { ok: false, error: 'The game could not be loaded.' };
            }
            if (!result?.ok) return { ok: false, error: result?.error || 'The game could not be loaded.', ply: result?.ply };
            startedAt = rec.startedAt || rec.savedAt || Date.now();
            autosave('loadGame');
            return { ok: true, record: rec };
        }

        // At boot: puts the autosaved game back. -> { resumed, notice }: notice is a short text to show when
        // stored data was unusable (the caller starts a new game unless resumed).
        function resume() {
            let saved;
            try { saved = store.loadAutosave(view); } catch (e) { saved = { record: null, problem: 'corrupt' }; }
            if (!saved.record) return { resumed: false, notice: saved.problem ? RESUME_NOTICE : null };
            if (!saved.record.moves.length && !saved.record.startFen) return { resumed: false, notice: null };
            const result = load(saved.record);
            if (result.ok) return { resumed: true, notice: null };
            store.saveAutosave(view, null);
            return { resumed: false, notice: RESUME_NOTICE };
        }

        // True when loading another game would lose moves: the game has moves and no named save holds it
        function unsaved() {
            const current = record();
            return !!current && current.moves.length > 0 && !store.list().some(s => sameGame(s, current));
        }

        const pgn = () => { const current = record(); return current ? toPgn(current, { event: host.title, site: site() }) : ''; };
        const fen = () => host.fen?.() || R.battle3dFen();

        const busy = () => host.busy?.() || null;

        // Validates PGN text without loading it. -> fromPgn() result, or { ok: false, error } while the view is busy
        function readPgn(text) {
            const why = busy();
            return why ? { ok: false, error: why } : fromPgn(text);
        }

        // Validates PGN text and loads it. -> { ok: true, record, more, adjusted } | { ok: false, error, moveNumber?, color?, san? }
        function importPgn(text, options = {}) {
            const parsed = readPgn(text);
            if (!parsed.ok) return parsed;
            const loaded = load(parsed.record, options);
            return loaded.ok ? { ok: true, record: loaded.record, more: parsed.more, adjusted: parsed.adjusted } : loaded;
        }

        return {
            view, store, record, autosave, load, resume, unsaved, pgn, fen, readPgn, importPgn, busy,
            title: host.title,
            saveAs: (name, options) => { const current = record(); return current ? store.save(name, current, options) : { ok: false, error: 'name' }; },
            defaultName: () => { const current = record(); return current ? defaultName(current) : ''; },
            fileName: () => pgnFileName(record() || { moves: [] })
        };
    }

    root.SaveGame = {
        FORMAT_VERSION, MAX_SAVES, MAX_NAME, START_FEN, MIGRATIONS,
        KEYS: { saves: SAVES_KEY, unreadable: UNREADABLE_KEY, autosave: autosaveKey },
        currentRecord, applyRecord, normalizeRecord, sameGame,
        fenAt: (index) => fenOf(R.battle3dState().gameHistory[index]), // FEN of a history position
        toPgn, parsePgn, fromPgn, sanToMove,
        defaultName, describe, pgnFileName,
        createStore, createSession,
        copyText, canShare, shareText, downloadText
    };
})(globalThis);
// --- END OF FILE savegame.js ---
