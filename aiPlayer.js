// --- START OF FILE aiPlayer.js ---

// Chess AI. A self-contained search engine (negamax + alpha-beta, quiescence search,
// transposition table, killer/history move ordering, iterative deepening with a time
// budget) that reads the gameLogic.js globals but never mutates them during search.
//
// Everything engine-internal lives inside the ChessAI closure so nothing collides with
// ui.js globals (ui.js has its own makeMove). Public globals defined by this file:
//   calculateBestMove(elo, timeMs?, positionHistory?, options?)  -> move | null
//   getAllLegalMoves(player)                          -> move[] (uses gameLogic.js generator)
//   evaluateBoard()                                   -> score in pawns, White's perspective
//   updateCastlingRightsSim(...)                      -> legacy helper, kept for callers/tests
//   ChessAI                                           -> engine namespace (perft, tests, self-play)
//
// Move shape returned everywhere (same as getAllLegalMoves):
//   { from:{row,col}, to:{row,col}, piece, isPromotion, promotionPiece ('Q'|'R'|'B'|'N'|null),
//     isCastling, isEnPassant }

// Kept for backwards compatibility (in pawns).
const pieceValues = { P: 1, N: 3.2, B: 3.3, R: 5, Q: 9, K: 0 };

const ChessAI = (() => {
    'use strict';

    // --- Representation ---
    // 64-square board, index = row * 8 + col, row 0 = rank 8 (same orientation as gameLogic.js).
    // Pieces are signed ints: +1..+6 White P N B R Q K, -1..-6 Black.
    const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
    const WHITE = 1, BLACK = -1;
    const MATE = 100000;              // mate at ply p scores +/-(MATE - p)
    const MATE_BOUND = MATE - 1000;   // anything beyond this is a mate score
    const INF = 1000000;
    const MAX_PLY = 128;
    const MOVES_PER_PLY = 256;

    // Move encoding: from | to << 6 | promo << 12 | flags << 15. 0 means "no move".
    const FLAG_EP = 1, FLAG_CASTLE = 2, FLAG_DOUBLE = 4;

    const CHAR_TO_PIECE = { P: 1, N: 2, B: 3, R: 4, Q: 5, K: 6, p: -1, n: -2, b: -3, r: -4, q: -5, k: -6 };
    const PIECE_CHARS = 'kqrbnp.PNBRQK'; // index = piece + 6
    const PROMO_CHARS = '..NBRQ';
    const VALUE = [0, 100, 320, 330, 500, 900, 0];

    // Castling bits: 1 = White O-O, 2 = White O-O-O, 4 = Black O-O, 8 = Black O-O-O.
    const CASTLE_MASK = new Int8Array(64).fill(15);
    CASTLE_MASK[0] = 7; CASTLE_MASK[4] = 3; CASTLE_MASK[7] = 11;
    CASTLE_MASK[56] = 13; CASTLE_MASK[60] = 12; CASTLE_MASK[63] = 14;

    // --- Precomputed attack tables ---
    const KNIGHT_TARGETS = [], KING_TARGETS = [];
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]; // 0-3 orthogonal, 4-7 diagonal
    const RAYS = DIRS.map(() => []);
    for (let s = 0; s < 64; s++) {
        const r = s >> 3, c = s & 7;
        KNIGHT_TARGETS[s] = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]
            .filter(([dr, dc]) => r + dr >= 0 && r + dr < 8 && c + dc >= 0 && c + dc < 8)
            .map(([dr, dc]) => (r + dr) * 8 + c + dc);
        KING_TARGETS[s] = DIRS
            .filter(([dr, dc]) => r + dr >= 0 && r + dr < 8 && c + dc >= 0 && c + dc < 8)
            .map(([dr, dc]) => (r + dr) * 8 + c + dc);
        DIRS.forEach(([dr, dc], d) => {
            const ray = [];
            for (let i = 1; ; i++) {
                const rr = r + dr * i, cc = c + dc * i;
                if (rr < 0 || rr > 7 || cc < 0 || cc > 7) break;
                ray.push(rr * 8 + cc);
            }
            RAYS[d][s] = ray;
        });
    }

    // --- Zobrist hashing (two 32-bit halves, deterministic PRNG) ---
    let seed = 0x9E3779B9;
    function rand32() { // mulberry32
        seed = (seed + 0x6D2B79F5) | 0;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return (t ^ (t >>> 14)) | 0;
    }
    const Z_PIECE_LO = new Int32Array(13 * 64), Z_PIECE_HI = new Int32Array(13 * 64);
    for (let i = 0; i < 13 * 64; i++) { Z_PIECE_LO[i] = rand32(); Z_PIECE_HI[i] = rand32(); }
    const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
    for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rand32(); Z_CASTLE_HI[i] = rand32(); }
    const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
    for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rand32(); Z_EP_HI[i] = rand32(); }
    const Z_SIDE_LO = rand32(), Z_SIDE_HI = rand32();

    // --- Position state ---
    const sq = new Int8Array(64);
    const cnt = new Int8Array(13); // piece counts, index piece + 6
    const kingSq = [60, 4];        // [white, black]
    let side = WHITE, castle = 0, ep = -1, halfmove = 0, fullmove = 1;
    let hashLo = 0, hashHi = 0;

    // Undo stack
    const STACK = 1024;
    const U_MOVE = new Int32Array(STACK), U_CAP = new Int8Array(STACK), U_CASTLE = new Int8Array(STACK);
    const U_EP = new Int8Array(STACK), U_HALF = new Int16Array(STACK);
    const U_HLO = new Int32Array(STACK), U_HHI = new Int32Array(STACK);
    let sp = 0;

    // Position hash history for repetition detection (game history + current search path)
    const HIST = 1024, MAX_LOADED_HISTORY = 400;
    const HIST_LO = new Int32Array(HIST), HIST_HI = new Int32Array(HIST);
    let histLen = 0, rootHistIndex = 0;

    const ci = (color) => (color === WHITE ? 0 : 1);

    function hashOf(board64, stm, castleBits, epSq) {
        let lo = 0, hi = 0;
        for (let s = 0; s < 64; s++) {
            const p = board64[s];
            if (p) { lo ^= Z_PIECE_LO[(p + 6) * 64 + s]; hi ^= Z_PIECE_HI[(p + 6) * 64 + s]; }
        }
        lo ^= Z_CASTLE_LO[castleBits]; hi ^= Z_CASTLE_HI[castleBits];
        if (epSq >= 0) { lo ^= Z_EP_LO[epSq & 7]; hi ^= Z_EP_HI[epSq & 7]; }
        if (stm === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
        return [lo, hi];
    }

    function castleBitsFrom(rights) {
        return (rights?.w?.K ? 1 : 0) | (rights?.w?.Q ? 2 : 0) | (rights?.b?.K ? 4 : 0) | (rights?.b?.Q ? 8 : 0);
    }

    // Hash of a getBoardPositionString() string ("<fen board> <side> <castling> <ep>").
    function hashOfPositionString(str) {
        const parts = String(str).split(' ');
        if (parts.length < 4) return null;
        const b = new Int8Array(64);
        const rows = parts[0].split('/');
        if (rows.length !== 8) return null;
        for (let r = 0; r < 8; r++) {
            let c = 0;
            for (const ch of rows[r]) {
                if (ch >= '1' && ch <= '8') c += +ch;
                else { if (c < 8) b[r * 8 + c] = CHAR_TO_PIECE[ch] || 0; c++; }
            }
        }
        let bits = 0;
        for (const ch of parts[2]) bits |= ch === 'K' ? 1 : ch === 'Q' ? 2 : ch === 'k' ? 4 : ch === 'q' ? 8 : 0;
        let epSq = -1;
        if (parts[3] !== '-' && parts[3].length === 2) {
            epSq = (8 - (+parts[3][1])) * 8 + (parts[3].charCodeAt(0) - 97);
        }
        return hashOf(b, parts[1] === 'b' ? BLACK : WHITE, bits, epSq);
    }

    // Load a state object { board, currentPlayer, castlingRights, enPassantTarget,
    // halfmoveClock, fullmoveNumber } plus optional position-string history.
    function loadState(state, positionHistory) {
        sq.fill(0); cnt.fill(0);
        let wk = -1, bk = -1;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                const ch = state.board[r] ? state.board[r][c] : null;
                if (!ch) continue;
                const p = CHAR_TO_PIECE[ch];
                if (!p) continue;
                sq[r * 8 + c] = p;
                cnt[p + 6]++;
                if (p === KING) wk = r * 8 + c;
                if (p === -KING) bk = r * 8 + c;
            }
        }
        if (wk < 0 || bk < 0) return false;
        kingSq[0] = wk; kingSq[1] = bk;
        side = state.currentPlayer === 'b' ? BLACK : WHITE;
        castle = castleBitsFrom(state.castlingRights);
        const e = state.enPassantTarget;
        ep = (e && typeof e.row === 'number' && typeof e.col === 'number') ? e.row * 8 + e.col : -1;
        halfmove = Math.max(0, state.halfmoveClock | 0);
        fullmove = Math.max(1, state.fullmoveNumber | 0);
        [hashLo, hashHi] = hashOf(sq, side, castle, ep);
        sp = 0;

        histLen = 0;
        const hist = Array.isArray(positionHistory) ? positionHistory.slice(-MAX_LOADED_HISTORY) : [];
        for (const str of hist) {
            const h = hashOfPositionString(str);
            if (h) { HIST_LO[histLen] = h[0]; HIST_HI[histLen] = h[1]; histLen++; }
        }
        // History may or may not already include the current position; don't count it twice.
        if (histLen > 0 && HIST_LO[histLen - 1] === hashLo && HIST_HI[histLen - 1] === hashHi) histLen--;
        rootHistIndex = histLen;
        HIST_LO[histLen] = hashLo; HIST_HI[histLen] = hashHi; histLen++;
        return true;
    }

    function loadFromGlobals(positionHistory) {
        return loadState({ board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber }, positionHistory);
    }

    // Write the engine position back into the gameLogic.js globals.
    function writeToGlobals() {
        board = [];
        for (let r = 0; r < 8; r++) {
            board[r] = [];
            for (let c = 0; c < 8; c++) {
                const p = sq[r * 8 + c];
                board[r][c] = p ? PIECE_CHARS[p + 6] : null;
            }
        }
        currentPlayer = side === WHITE ? 'w' : 'b';
        castlingRights = { w: { K: !!(castle & 1), Q: !!(castle & 2) }, b: { K: !!(castle & 4), Q: !!(castle & 8) } };
        enPassantTarget = ep >= 0 ? { row: ep >> 3, col: ep & 7 } : null;
        halfmoveClock = halfmove;
        fullmoveNumber = fullmove;
    }

    // --- Attack detection ---
    function attacked(s, by) {
        const r = s >> 3, c = s & 7;
        if (by === WHITE) {
            if (r < 7) {
                if (c > 0 && sq[s + 7] === PAWN) return true;
                if (c < 7 && sq[s + 9] === PAWN) return true;
            }
        } else if (r > 0) {
            if (c > 0 && sq[s - 9] === -PAWN) return true;
            if (c < 7 && sq[s - 7] === -PAWN) return true;
        }
        const kn = KNIGHT * by;
        const kt = KNIGHT_TARGETS[s];
        for (let i = 0; i < kt.length; i++) if (sq[kt[i]] === kn) return true;
        const kg = KING * by;
        const kgt = KING_TARGETS[s];
        for (let i = 0; i < kgt.length; i++) if (sq[kgt[i]] === kg) return true;
        const q = QUEEN * by, rk = ROOK * by, bs = BISHOP * by;
        for (let d = 0; d < 8; d++) {
            const ray = RAYS[d][s];
            const straight = d < 4;
            for (let i = 0; i < ray.length; i++) {
                const p = sq[ray[i]];
                if (p !== 0) {
                    if (p === q || (straight ? p === rk : p === bs)) return true;
                    break;
                }
            }
        }
        return false;
    }

    const inCheck = () => attacked(kingSq[ci(side)], -side);

    // --- Move generation (pseudo-legal; legality checked after makeMove) ---
    const MOVES = new Int32Array(MAX_PLY * MOVES_PER_PLY);
    const SCORES = new Int32Array(MAX_PLY * MOVES_PER_PLY);

    function genMoves(start, tacticalOnly) {
        let n = start;
        const us = side, them = -side;
        const fwd = us === WHITE ? -8 : 8;
        const promoRow = us === WHITE ? 0 : 7;
        const startRow = us === WHITE ? 6 : 1;
        for (let s = 0; s < 64; s++) {
            const p = sq[s] * us;
            if (p <= 0) continue;
            if (p === PAWN) {
                const r = s >> 3, c = s & 7, t = s + fwd, tr = t >> 3;
                // Quiescence (tacticalOnly) skips non-capturing promotions on purpose: otherwise
                // every quiet root move "promotes at the leaf" and a shallow search never
                // bothers to promote now.
                if (sq[t] === 0 && !tacticalOnly) {
                    if (tr === promoRow) {
                        MOVES[n++] = s | (t << 6) | (QUEEN << 12);
                        MOVES[n++] = s | (t << 6) | (KNIGHT << 12);
                        MOVES[n++] = s | (t << 6) | (ROOK << 12);
                        MOVES[n++] = s | (t << 6) | (BISHOP << 12);
                    } else {
                        MOVES[n++] = s | (t << 6);
                        if (r === startRow && sq[t + fwd] === 0) MOVES[n++] = s | ((t + fwd) << 6) | (FLAG_DOUBLE << 15);
                    }
                }
                for (let dc = -1; dc <= 1; dc += 2) {
                    const nc = c + dc;
                    if (nc < 0 || nc > 7) continue;
                    const ct = tr * 8 + nc;
                    if (sq[ct] * them > 0) {
                        if (tr === promoRow) {
                            MOVES[n++] = s | (ct << 6) | (QUEEN << 12);
                            if (!tacticalOnly) {
                                MOVES[n++] = s | (ct << 6) | (KNIGHT << 12);
                                MOVES[n++] = s | (ct << 6) | (ROOK << 12);
                                MOVES[n++] = s | (ct << 6) | (BISHOP << 12);
                            }
                        } else {
                            MOVES[n++] = s | (ct << 6);
                        }
                    } else if (ct === ep) {
                        MOVES[n++] = s | (ct << 6) | (FLAG_EP << 15);
                    }
                }
            } else if (p === KNIGHT || p === KING) {
                const targets = p === KNIGHT ? KNIGHT_TARGETS[s] : KING_TARGETS[s];
                for (let i = 0; i < targets.length; i++) {
                    const t = targets[i], tp = sq[t] * us;
                    if (tp > 0 || (tacticalOnly && tp === 0)) continue;
                    MOVES[n++] = s | (t << 6);
                }
                if (p === KING && !tacticalOnly) n = genCastling(s, n);
            } else {
                const d0 = p === BISHOP ? 4 : 0, d1 = p === ROOK ? 4 : 8;
                for (let d = d0; d < d1; d++) {
                    const ray = RAYS[d][s];
                    for (let i = 0; i < ray.length; i++) {
                        const t = ray[i], tp = sq[t] * us;
                        if (tp > 0) break;
                        if (tp < 0) { MOVES[n++] = s | (t << 6); break; }
                        if (!tacticalOnly) MOVES[n++] = s | (t << 6);
                    }
                }
            }
        }
        return n;
    }

    function genCastling(s, n) {
        if (side === WHITE) {
            if (s !== 60 || !(castle & 3) || attacked(60, BLACK)) return n;
            if ((castle & 1) && sq[61] === 0 && sq[62] === 0 && sq[63] === ROOK &&
                !attacked(61, BLACK) && !attacked(62, BLACK)) MOVES[n++] = 60 | (62 << 6) | (FLAG_CASTLE << 15);
            if ((castle & 2) && sq[59] === 0 && sq[58] === 0 && sq[57] === 0 && sq[56] === ROOK &&
                !attacked(59, BLACK) && !attacked(58, BLACK)) MOVES[n++] = 60 | (58 << 6) | (FLAG_CASTLE << 15);
        } else {
            if (s !== 4 || !(castle & 12) || attacked(4, WHITE)) return n;
            if ((castle & 4) && sq[5] === 0 && sq[6] === 0 && sq[7] === -ROOK &&
                !attacked(5, WHITE) && !attacked(6, WHITE)) MOVES[n++] = 4 | (6 << 6) | (FLAG_CASTLE << 15);
            if ((castle & 8) && sq[3] === 0 && sq[2] === 0 && sq[1] === 0 && sq[0] === -ROOK &&
                !attacked(3, WHITE) && !attacked(2, WHITE)) MOVES[n++] = 4 | (2 << 6) | (FLAG_CASTLE << 15);
        }
        return n;
    }

    // --- Make / unmake (the single place that applies a move) ---
    function xorPiece(p, s) {
        const i = (p + 6) * 64 + s;
        hashLo ^= Z_PIECE_LO[i]; hashHi ^= Z_PIECE_HI[i];
    }

    function makeMove(m) {
        const from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7, flags = m >> 15;
        const p = sq[from];
        let cap = sq[to];
        U_MOVE[sp] = m; U_CASTLE[sp] = castle; U_EP[sp] = ep; U_HALF[sp] = halfmove;
        U_HLO[sp] = hashLo; U_HHI[sp] = hashHi;

        if (ep >= 0) { hashLo ^= Z_EP_LO[ep & 7]; hashHi ^= Z_EP_HI[ep & 7]; }
        hashLo ^= Z_CASTLE_LO[castle]; hashHi ^= Z_CASTLE_HI[castle];
        halfmove++;

        if (flags & FLAG_EP) {
            const capSq = side === WHITE ? to + 8 : to - 8;
            cap = sq[capSq];
            sq[capSq] = 0;
            xorPiece(cap, capSq);
            cnt[cap + 6]--;
        } else if (cap !== 0) {
            xorPiece(cap, to);
            cnt[cap + 6]--;
        }
        U_CAP[sp] = cap;
        if (cap !== 0 || p === PAWN || p === -PAWN) halfmove = 0;

        xorPiece(p, from);
        sq[from] = 0;
        let placed = p;
        if (promo) {
            placed = promo * side;
            cnt[p + 6]--; cnt[placed + 6]++;
        }
        sq[to] = placed;
        xorPiece(placed, to);
        if (p === KING * side) kingSq[ci(side)] = to;

        if (flags & FLAG_CASTLE) {
            const rf = to > from ? from + 3 : from - 4, rt = to > from ? from + 1 : from - 1;
            const rp = sq[rf];
            sq[rt] = rp; sq[rf] = 0;
            xorPiece(rp, rf); xorPiece(rp, rt);
        }

        castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
        hashLo ^= Z_CASTLE_LO[castle]; hashHi ^= Z_CASTLE_HI[castle];
        ep = (flags & FLAG_DOUBLE) ? (from + to) >> 1 : -1;
        if (ep >= 0) { hashLo ^= Z_EP_LO[ep & 7]; hashHi ^= Z_EP_HI[ep & 7]; }
        if (side === BLACK) fullmove++;
        side = -side;
        hashLo ^= Z_SIDE_LO; hashHi ^= Z_SIDE_HI;
        sp++;
        HIST_LO[histLen] = hashLo; HIST_HI[histLen] = hashHi; histLen++;
    }

    function unmakeMove() {
        sp--; histLen--;
        const m = U_MOVE[sp];
        const from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7, flags = m >> 15;
        side = -side;
        if (side === BLACK) fullmove--;
        const placed = sq[to];
        let p = placed;
        if (promo) {
            p = PAWN * side;
            cnt[placed + 6]--; cnt[p + 6]++;
        }
        sq[from] = p;
        const cap = U_CAP[sp];
        if (flags & FLAG_EP) {
            sq[to] = 0;
            sq[side === WHITE ? to + 8 : to - 8] = cap;
        } else {
            sq[to] = cap;
        }
        if (cap !== 0) cnt[cap + 6]++;
        if (p === KING * side) kingSq[ci(side)] = from;
        if (flags & FLAG_CASTLE) {
            const rf = to > from ? from + 3 : from - 4, rt = to > from ? from + 1 : from - 1;
            sq[rf] = sq[rt]; sq[rt] = 0;
        }
        castle = U_CASTLE[sp]; ep = U_EP[sp]; halfmove = U_HALF[sp];
        hashLo = U_HLO[sp]; hashHi = U_HHI[sp];
    }

    function makeNullMove() {
        U_MOVE[sp] = 0; U_EP[sp] = ep; U_HALF[sp] = halfmove; U_HLO[sp] = hashLo; U_HHI[sp] = hashHi;
        if (ep >= 0) { hashLo ^= Z_EP_LO[ep & 7]; hashHi ^= Z_EP_HI[ep & 7]; }
        ep = -1;
        halfmove = 0; // repetition detection must not look across a null move
        side = -side;
        hashLo ^= Z_SIDE_LO; hashHi ^= Z_SIDE_HI;
        sp++;
        HIST_LO[histLen] = hashLo; HIST_HI[histLen] = hashHi; histLen++;
    }

    function unmakeNullMove() {
        sp--; histLen--;
        side = -side;
        ep = U_EP[sp]; halfmove = U_HALF[sp]; hashLo = U_HLO[sp]; hashHi = U_HHI[sp];
    }

    // Legal moves of the current position as an array of encoded moves.
    function legalMoves() {
        const start = (MAX_PLY - 1) * MOVES_PER_PLY;
        const end = genMoves(start, false);
        const us = side, out = [];
        for (let i = start; i < end; i++) {
            const m = MOVES[i];
            makeMove(m);
            if (!attacked(kingSq[ci(us)], -us)) out.push(m);
            unmakeMove();
        }
        return out;
    }

    function perft(depth) {
        if (depth === 0) return 1;
        let nodes = 0;
        for (const m of legalMoves()) {
            makeMove(m);
            nodes += perft(depth - 1);
            unmakeMove();
        }
        return nodes;
    }

    // --- Draw detection ---
    function isRepetition() {
        // Within the search path one repetition counts as a draw; positions from before the
        // root need two earlier occurrences (i.e. a real threefold repetition).
        const limit = Math.max(0, histLen - 1 - halfmove);
        let older = 0;
        for (let i = histLen - 3; i >= limit; i--) {
            if (HIST_LO[i] === hashLo && HIST_HI[i] === hashHi) {
                if (i >= rootHistIndex) return true;
                if (++older >= 2) return true;
            }
        }
        return false;
    }

    function insufficientMaterial() {
        if (cnt[7] || cnt[5] || cnt[10] || cnt[2] || cnt[11] || cnt[1]) return false; // pawns, rooks, queens
        return cnt[8] + cnt[9] + cnt[4] + cnt[3] <= 1; // at most one minor piece on the board
    }

    const hasNonPawnMaterial = (color) => color === WHITE
        ? (cnt[8] + cnt[9] + cnt[10] + cnt[11]) > 0
        : (cnt[4] + cnt[3] + cnt[2] + cnt[1]) > 0;

    // --- Evaluation (centipawns) ---
    // Piece-square tables written from White's point of view, index 0 = a8.
    // Black pieces use the vertically mirrored square (s ^ 56).
    const PST_PAWN = [
        0, 0, 0, 0, 0, 0, 0, 0,
        50, 50, 50, 50, 50, 50, 50, 50,
        10, 10, 20, 30, 30, 20, 10, 10,
        5, 5, 10, 25, 25, 10, 5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, -5, -10, 0, 0, -10, -5, 5,
        5, 10, 10, -20, -20, 10, 10, 5,
        0, 0, 0, 0, 0, 0, 0, 0];
    const PST_KNIGHT = [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50];
    const PST_BISHOP = [
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -20, -10, -10, -10, -10, -10, -10, -20];
    const PST_ROOK = [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, 10, 10, 10, 10, 5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        0, 0, 0, 5, 5, 0, 0, 0];
    const PST_QUEEN = [
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -5, 0, 5, 5, 5, 5, 0, -5,
        0, 0, 5, 5, 5, 5, 0, -5,
        -10, 5, 5, 5, 5, 5, 0, -10,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20];
    const PST_KING_MG = [
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        20, 20, 0, 0, 0, 0, 20, 20,
        20, 30, 10, 0, 0, 10, 30, 20];
    const PST_KING_EG = [
        -50, -40, -30, -20, -20, -30, -40, -50,
        -30, -20, -10, 0, 0, -10, -20, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 30, 40, 40, 30, -10, -30,
        -30, -10, 20, 30, 30, 20, -10, -30,
        -30, -30, 0, 0, 0, 0, -30, -30,
        -50, -30, -30, -30, -30, -30, -30, -50];
    const PST = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN];
    const PASSED_BONUS = [0, 5, 10, 20, 35, 60, 100, 0]; // by ranks advanced from the pawn's start side
    const TEMPO = 10;

    const wPawnFile = new Int8Array(8), bPawnFile = new Int8Array(8);
    const wMaxRow = new Int8Array(8), bMinRow = new Int8Array(8);

    function mopUp(winK, loseK) {
        const lr = loseK >> 3, lc = loseK & 7, wr = winK >> 3, wc = winK & 7;
        const centerDist = Math.max(3 - lr, lr - 4) + Math.max(3 - lc, lc - 4);
        const kingDist = Math.abs(wr - lr) + Math.abs(wc - lc);
        return 10 * centerDist + 4 * (14 - kingDist);
    }

    // Mobility of knights, bishops, rooks and queens (squares not occupied by own pieces),
    // centipawns from White's point of view, relative to a typical count per piece type.
    const MOB_WEIGHT = [0, 0, 4, 5, 2, 1, 0], MOB_BASE = [0, 0, 4, 6, 6, 12, 0];
    function mobility() {
        let score = 0;
        for (let s = 0; s < 64; s++) {
            const p = sq[s];
            if (p === 0) continue;
            const t = p < 0 ? -p : p;
            if (t === PAWN || t === KING) continue;
            const color = p > 0 ? 1 : -1;
            let n = 0;
            if (t === KNIGHT) {
                const kt = KNIGHT_TARGETS[s];
                for (let i = 0; i < kt.length; i++) if (sq[kt[i]] * color <= 0) n++;
            } else {
                const d0 = t === BISHOP ? 4 : 0, d1 = t === ROOK ? 4 : 8;
                for (let d = d0; d < d1; d++) {
                    const ray = RAYS[d][s];
                    for (let i = 0; i < ray.length; i++) {
                        const q = sq[ray[i]];
                        if (q * color > 0) break;
                        n++;
                        if (q !== 0) break;
                    }
                }
            }
            score += color * MOB_WEIGHT[t] * (n - MOB_BASE[t]);
        }
        return score;
    }

    // Static evaluation from the side to move's point of view.
    function evaluate() {
        let score = 0, wNpm = 0, bNpm = 0, wPawns = 0, bPawns = 0, wBishops = 0, bBishops = 0;
        wPawnFile.fill(0); bPawnFile.fill(0); wMaxRow.fill(-1); bMinRow.fill(8);

        for (let s = 0; s < 64; s++) {
            const p = sq[s];
            if (p === 0) continue;
            if (p > 0) {
                if (p === PAWN) {
                    wPawns++; score += 100 + PST_PAWN[s];
                    const c = s & 7, r = s >> 3;
                    wPawnFile[c]++; if (r > wMaxRow[c]) wMaxRow[c] = r;
                } else if (p !== KING) {
                    score += VALUE[p] + PST[p][s]; wNpm += VALUE[p];
                    if (p === BISHOP) wBishops++;
                }
            } else {
                const t = -p;
                if (t === PAWN) {
                    bPawns++; score -= 100 + PST_PAWN[s ^ 56];
                    const c = s & 7, r = s >> 3;
                    bPawnFile[c]++; if (r < bMinRow[c]) bMinRow[c] = r;
                } else if (t !== KING) {
                    score -= VALUE[t] + PST[t][s ^ 56]; bNpm += VALUE[t];
                    if (t === BISHOP) bBishops++;
                }
            }
        }

        // Game phase: 1 = full middlegame, 0 = bare endgame.
        const phase = Math.min(1, Math.max(0, (wNpm + bNpm - 1500) / 4900));
        const wk = kingSq[0], bk = kingSq[1];
        score += PST_KING_MG[wk] * phase + PST_KING_EG[wk] * (1 - phase);
        score -= PST_KING_MG[bk ^ 56] * phase + PST_KING_EG[bk ^ 56] * (1 - phase);

        if (wBishops >= 2) score += 30;
        if (bBishops >= 2) score -= 30;
        score += mobility();

        // Pawn structure and rooks on open files.
        const passedScale = 1 + (1 - phase);
        for (let s = 0; s < 64; s++) {
            const p = sq[s];
            if (p === PAWN) {
                const r = s >> 3, c = s & 7;
                if ((c === 0 || wPawnFile[c - 1] === 0) && (c === 7 || wPawnFile[c + 1] === 0)) score -= 12;
                if (bMinRow[c] >= r && (c === 0 || bMinRow[c - 1] >= r) && (c === 7 || bMinRow[c + 1] >= r)) {
                    score += PASSED_BONUS[7 - r] * passedScale;
                }
            } else if (p === -PAWN) {
                const r = s >> 3, c = s & 7;
                if ((c === 0 || bPawnFile[c - 1] === 0) && (c === 7 || bPawnFile[c + 1] === 0)) score += 12;
                if (wMaxRow[c] <= r && (c === 0 || wMaxRow[c - 1] <= r) && (c === 7 || wMaxRow[c + 1] <= r)) {
                    score -= PASSED_BONUS[r] * passedScale;
                }
            } else if (p === ROOK) {
                const c = s & 7;
                if (wPawnFile[c] === 0) score += bPawnFile[c] === 0 ? 15 : 8;
            } else if (p === -ROOK) {
                const c = s & 7;
                if (bPawnFile[c] === 0) score -= wPawnFile[c] === 0 ? 15 : 8;
            }
        }
        for (let f = 0; f < 8; f++) {
            if (wPawnFile[f] > 1) score -= 12 * (wPawnFile[f] - 1);
            if (bPawnFile[f] > 1) score += 12 * (bPawnFile[f] - 1);
        }

        // Endgame technique: drive the lone king to the edge and bring our king closer.
        const wMat = wNpm + 100 * wPawns, bMat = bNpm + 100 * bPawns;
        if (bPawns === 0 && wMat - bMat >= 400) score += mopUp(wk, bk);
        else if (wPawns === 0 && bMat - wMat >= 400) score -= mopUp(bk, wk);

        // A side with no pawns and at most one minor piece cannot win.
        if (score > 0 && wPawns === 0 && wNpm <= 330) score = 0;
        if (score < 0 && bPawns === 0 && bNpm <= 330) score = 0;

        return (side === WHITE ? score : -score) + TEMPO;
    }

    // --- Transposition table ---
    const TT_SIZE = 1 << 19, TT_MASK = TT_SIZE - 1;
    const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
    let TT_LO, TT_HI, TT_MOVE, TT_SCORE, TT_DEPTH, TT_FLAG;
    function clearTT() {
        if (!TT_FLAG) {
            TT_LO = new Int32Array(TT_SIZE); TT_HI = new Int32Array(TT_SIZE);
            TT_MOVE = new Int32Array(TT_SIZE); TT_SCORE = new Int32Array(TT_SIZE);
            TT_DEPTH = new Int8Array(TT_SIZE); TT_FLAG = new Uint8Array(TT_SIZE);
        } else {
            TT_FLAG.fill(0);
        }
    }

    // --- Search ---
    const RFP_DEPTH = 4, RFP_MARGIN = 90;
    const FUTILITY_MARGIN = [0, 150, 300];
    const LMP_LIMIT = [0, 5, 10, 18];
    const LMR = new Int8Array(64 * 64); // late move reduction by [depth][move number]
    for (let d = 1; d < 64; d++) for (let n = 1; n < 64; n++) LMR[d * 64 + n] = Math.floor(0.75 + Math.log(d) * Math.log(n) / 2.25);
    const KILLERS = new Int32Array(MAX_PLY * 2);
    const HISTORY = new Int32Array(2 * 64 * 64);
    // Strength is set by a node budget (deterministic on every device); the deadline is only a
    // safety cap. `blind` scores a root move the way a beginner would: no quiescence and no TT.
    let nodes = 0, nodeLimit = Infinity, stopped = false, stoppedBy = null, canStop = false, deadline = 0;
    let blind = false, qsLimit = 99;
    const now = (typeof performance !== 'undefined' && performance.now)
        ? () => performance.now() : () => Date.now();

    function checkTime() {
        if (canStop && now() >= deadline) { stopped = true; stoppedBy = 'time'; }
    }

    // Called once per node by search() and quiesce().
    function countNode() {
        if (stopped) return;
        if (++nodes >= nodeLimit && canStop) { stopped = true; stoppedBy = 'nodes'; }
        else if ((nodes & 1023) === 0) checkTime();
    }

    function scoreMoves(start, end, ttMove, ply) {
        const k1 = KILLERS[ply * 2], k2 = KILLERS[ply * 2 + 1];
        const hBase = side === WHITE ? 0 : 4096;
        for (let i = start; i < end; i++) {
            const m = MOVES[i];
            if (m === ttMove) { SCORES[i] = 2000000000; continue; }
            const from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7;
            const t = sq[to];
            const victim = (m >> 15) & FLAG_EP ? PAWN : (t < 0 ? -t : t);
            if (victim) {
                const a = sq[from];
                SCORES[i] = 1000000 + VALUE[victim] * 10 - (a < 0 ? -a : a) + (promo === QUEEN ? 9000 : 0);
            } else if (promo) {
                SCORES[i] = promo === QUEEN ? 950000 : -1000;
            } else if (m === k1) {
                SCORES[i] = 900000;
            } else if (m === k2) {
                SCORES[i] = 890000;
            } else {
                const h = HISTORY[hBase + (from << 6) + to];
                SCORES[i] = h < 800000 ? h : 800000;
            }
        }
    }

    function pickMove(i, end) {
        let bi = i, bs = SCORES[i];
        for (let j = i + 1; j < end; j++) if (SCORES[j] > bs) { bs = SCORES[j]; bi = j; }
        if (bi !== i) {
            const tm = MOVES[i]; MOVES[i] = MOVES[bi]; MOVES[bi] = tm;
            SCORES[bi] = SCORES[i]; SCORES[i] = bs;
        }
    }

    // qd = capture plies still allowed (params.qsDepth, the tactical horizon of weak levels).
    function quiesce(alpha, beta, ply, qd) {
        countNode();
        if (stopped) return 0;
        if (ply >= MAX_PLY - 1 || blind || qd <= 0) return evaluate();
        const us = side;
        const checked = attacked(kingSq[ci(us)], -us);
        let best = -INF, stand = 0;
        if (!checked) {
            stand = evaluate();
            if (stand >= beta) return stand;
            if (stand > alpha) alpha = stand;
            best = stand;
        }
        const start = ply * MOVES_PER_PLY;
        const end = genMoves(start, !checked);
        scoreMoves(start, end, 0, ply);
        let legal = 0;
        for (let i = start; i < end; i++) {
            pickMove(i, end);
            const m = MOVES[i];
            if (!checked && !((m >> 12) & 7)) {
                // Delta pruning: even winning this piece cannot lift us to alpha.
                const t = sq[(m >> 6) & 63];
                const victim = (m >> 15) & FLAG_EP ? PAWN : (t < 0 ? -t : t);
                if (stand + VALUE[victim] + 200 <= alpha) continue;
                // Losing capture: a bigger piece takes a defended smaller one.
                const a = sq[m & 63];
                const attackerV = VALUE[a < 0 ? -a : a];
                if (attackerV > VALUE[victim] + 50 && attacked((m >> 6) & 63, -us)) continue;
            }
            makeMove(m);
            if (attacked(kingSq[ci(us)], -us)) { unmakeMove(); continue; }
            legal++;
            const score = -quiesce(-beta, -alpha, ply + 1, qd - 1);
            unmakeMove();
            if (stopped) return 0;
            if (score > best) {
                best = score;
                if (score > alpha) {
                    alpha = score;
                    if (alpha >= beta) break;
                }
            }
        }
        if (checked && legal === 0) return -MATE + ply;
        return best;
    }

    function search(depth, alpha, beta, ply, allowNull) {
        countNode();
        if (stopped) return 0;
        const us = side, them = -side;

        if (ply > 0) {
            if (halfmove >= 100 || isRepetition() || insufficientMaterial()) return 0;
            // Mate distance pruning
            if (alpha < -MATE + ply) alpha = -MATE + ply;
            if (beta > MATE - ply - 1) beta = MATE - ply - 1;
            if (alpha >= beta) return alpha;
        }
        if (ply >= MAX_PLY - 2) return evaluate();

        const checked = attacked(kingSq[ci(us)], them);
        if (checked) depth++;
        if (depth <= 0) return quiesce(alpha, beta, ply, qsLimit);

        const origAlpha = alpha;
        const idx = hashLo & TT_MASK;
        let ttMove = 0;
        if (TT_FLAG[idx] && TT_LO[idx] === hashLo && TT_HI[idx] === hashHi) {
            ttMove = TT_MOVE[idx];
            if (ply > 0 && !blind && TT_DEPTH[idx] >= depth) {
                let s = TT_SCORE[idx];
                if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
                const f = TT_FLAG[idx];
                if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
            }
        }

        // Pruning below needs a static eval; it is skipped in check, at PV nodes and in blind mode.
        const pv = beta - alpha > 1;
        const prune = !checked && !pv && ply > 0 && !blind && beta < MATE_BOUND && beta > -MATE_BOUND;
        const staticEval = checked ? -INF : evaluate();

        // Reverse futility pruning: far above beta near the leaves, assume a cutoff.
        if (prune && depth <= RFP_DEPTH && staticEval - RFP_MARGIN * depth >= beta) return staticEval;

        // Null-move pruning
        if (allowNull && !checked && ply > 0 && depth >= 3 && beta < MATE_BOUND && hasNonPawnMaterial(us) &&
            staticEval >= beta) {
            makeNullMove();
            const s = -search(depth - 1 - (depth >= 6 ? 3 : 2), -beta, -beta + 1, ply + 1, false);
            unmakeNullMove();
            if (stopped) return 0;
            if (s >= beta) return s >= MATE_BOUND ? beta : s;
        }

        // Futility pruning and late move pruning of quiet moves near the leaves.
        const futile = prune && depth <= 2 && staticEval + FUTILITY_MARGIN[depth] <= alpha;
        const lmpLimit = prune && depth <= 3 ? LMP_LIMIT[depth] : 1 << 30;

        const start = ply * MOVES_PER_PLY;
        const end = genMoves(start, false);
        scoreMoves(start, end, ttMove, ply);
        let legal = 0, best = -INF, bestMove = 0, quietsTried = 0;
        for (let i = start; i < end; i++) {
            pickMove(i, end);
            const m = MOVES[i];
            // Quiet moves come last in the ordering, so once one is futile (or past the late move
            // limit) the rest are too: stop before even making them. Killers are still searched.
            const quiet = sq[(m >> 6) & 63] === 0 && !((m >> 15) & FLAG_EP) && ((m >> 12) & 7) === 0;
            if (quiet && legal > 0 && (futile || quietsTried >= lmpLimit) &&
                m !== KILLERS[ply * 2] && m !== KILLERS[ply * 2 + 1]) {
                if (best < -MATE_BOUND) best = alpha; // a fail-low bound, not a proven mate
                break;
            }
            makeMove(m);
            if (attacked(kingSq[ci(us)], them)) { unmakeMove(); continue; }
            legal++;
            if (quiet) quietsTried++;
            let score;
            if (legal === 1) {
                score = -search(depth - 1, -beta, -alpha, ply + 1, true);
            } else {
                // Late move reductions for quiet moves, then PVS re-searches.
                let R = 0;
                if (depth >= 3 && legal > 3 && quiet && !checked && !blind &&
                    m !== KILLERS[ply * 2] && m !== KILLERS[ply * 2 + 1] &&
                    !attacked(kingSq[ci(them)], us)) {
                    R = LMR[Math.min(depth, 63) * 64 + Math.min(legal, 63)] - (pv ? 1 : 0);
                    R = Math.max(1, Math.min(R, depth - 2));
                }
                score = -search(depth - 1 - R, -alpha - 1, -alpha, ply + 1, true);
                if (score > alpha && R > 0) score = -search(depth - 1, -alpha - 1, -alpha, ply + 1, true);
                if (score > alpha && score < beta) score = -search(depth - 1, -beta, -alpha, ply + 1, true);
            }
            unmakeMove();
            if (stopped) return 0;
            if (score > best) {
                best = score;
                bestMove = m;
                if (score > alpha) {
                    alpha = score;
                    if (alpha >= beta) {
                        if (quiet) {
                            if (KILLERS[ply * 2] !== m) { KILLERS[ply * 2 + 1] = KILLERS[ply * 2]; KILLERS[ply * 2] = m; }
                            HISTORY[(us === WHITE ? 0 : 4096) + (m & 63) * 64 + ((m >> 6) & 63)] += depth * depth;
                        }
                        break;
                    }
                }
            }
        }
        if (legal === 0) return checked ? -MATE + ply : 0;

        if (!blind && (!TT_FLAG[idx] || TT_DEPTH[idx] <= depth || TT_LO[idx] !== hashLo || TT_HI[idx] !== hashHi)) {
            TT_LO[idx] = hashLo; TT_HI[idx] = hashHi; TT_MOVE[idx] = bestMove;
            TT_SCORE[idx] = best > MATE_BOUND ? best + ply : best < -MATE_BOUND ? best - ply : best;
            TT_DEPTH[idx] = depth;
            TT_FLAG[idx] = best <= origAlpha ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
        }
        return best;
    }

    // --- Seedable RNG (mulberry32) for every random choice the engine makes ---
    // setSeed(n) makes a whole game reproducible (the stream continues across moves);
    // setSeed(null) goes back to a fresh random seed per move. params.seed overrides both.
    let rngState = 0, fixedSeed = null;
    function rnd() {
        rngState = (rngState + 0x6D2B79F5) | 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function setSeed(s) {
        fixedSeed = s == null ? null : (Number(s) >>> 0);
        rngState = fixedSeed === null ? 0 : fixedSeed;
    }
    function seedForSearch(params) {
        if (params.seed != null) rngState = Number(params.seed) >>> 0;
        else if (fixedSeed === null) rngState = (Math.random() * 4294967296) >>> 0;
    }

    // --- Human-like weakness helpers (root only) ---
    const isCapture = (m) => ((m >> 15) & FLAG_EP) !== 0 || sq[(m >> 6) & 63] !== 0;

    // How "natural" a move looks to a human, 0..1: captures, checks, castling, developing a
    // minor piece early, centralising. Wandering king moves in the middlegame look unnatural.
    function naturalness(m) {
        const from = m & 63, to = (m >> 6) & 63, flags = m >> 15;
        const p = Math.abs(sq[from]);
        let v = 0;
        if (isCapture(m)) v += 0.6;
        if (flags & FLAG_CASTLE) v += 0.6;
        const homeRow = side === WHITE ? 7 : 0;
        if ((p === KNIGHT || p === BISHOP) && (from >> 3) === homeRow && fullmove <= 15) v += 0.5;
        const r = to >> 3, c = to & 7;
        const centerDist = Math.max(3 - r, r - 4) + Math.max(3 - c, c - 4); // 0 (centre) .. 6 (corner)
        if (p !== KING) v += 0.25 * (1 - centerDist / 6);
        if (p === KING && !(flags & FLAG_CASTLE) && hasNonPawnMaterial(-side) && cnt[QUEEN + 6] + cnt[-QUEEN + 6] > 0) v -= 0.5;
        makeMove(m);
        if (inCheck()) v += 0.25;
        unmakeMove();
        return Math.max(-0.5, Math.min(1, v));
    }

    // Chance that a beginner never even considers non-forcing move m: quiet moves at `base`,
    // retreats and long slides more often, checks rarely. Captures use missCaptureChance.
    function oversightChance(m, base) {
        if (isCapture(m) || ((m >> 12) & 7) === QUEEN) return 0;
        makeMove(m);
        const check = inCheck();
        unmakeMove();
        if (check) return base * 0.3;
        const from = m & 63, to = (m >> 6) & 63;
        const fwd = side === WHITE ? (from >> 3) - (to >> 3) : (to >> 3) - (from >> 3);
        const dist = Math.max(Math.abs((from >> 3) - (to >> 3)), Math.abs((from & 7) - (to & 7)));
        let f = 1;
        if (fwd < 0) f *= 1.5;
        if (dist >= 4) f *= 1.3;
        return Math.min(0.95, base * f);
    }

    // Score of root move m as seen by a "blind" player: the opponent's next blindDepth plies
    // without quiescence and without the TT. blindDepth 0 is the static eval after the move, so
    // even a mate in one or a stalemate goes unnoticed; 1 sees the direct replies (mates, a
    // piece left hanging) but not the recapture after them. Counts against the node budget;
    // once it is spent, the remaining moves fall back to the static eval (one node each).
    function blindScore(m, blindDepth) {
        makeMove(m);
        let s = -evaluate();
        nodes++;
        if (blindDepth > 0 && !stopped && nodes < nodeLimit) {
            blind = true;
            const deeper = -search(blindDepth, -INF, INF, 1, false);
            blind = false;
            if (!stopped) s = deeper;
        }
        unmakeMove();
        return s;
    }

    // Root search. params (see eloParams): nodeBudget, maxDepth, timeCapMs, noiseCp,
    // blunderChance, blindDepth, missCaptureChance, missQuietChance, naturalCp.
    // Returns { move, score, depth, nodes, stoppedBy, scores, blunder } or null without legal moves.
    //
    // Weakness model (all zero = full strength):
    //  - missCaptureChance: each capture is independently "not seen" and is not considered
    //    (not applied when in check), so hanging pieces are sometimes left on the board.
    //  - missQuietChance: each non-forcing move is not considered with this base chance
    //    (higher for retreats and long slides, lower for checks; see oversightChance), so
    //    quiet key moves, defensive retreats and sacrifices are what beginners miss.
    //  - blunderChance: chance that this is a careless move: every considered move is scored
    //    "blind" (blindScore), so the pick can hang a piece, grab a defended pawn or ignore a
    //    one-move threat. Not every careless move is a mistake.
    //  - noiseCp: misjudgement, uniform-sum noise in [-noiseCp, +noiseCp] added to each score.
    //  - naturalCp: bonus up to naturalCp for natural-looking moves (naturalness()).
    // The other moves get a normal iterative-deepening search within the node budget; the pick
    // is the highest score + bonus + noise.
    function searchRoot(params) {
        const root = legalMoves().map((m) => ({ m, score: 0, blind: false, bonus: 0 }));
        if (root.length === 0) return null;
        for (let i = root.length - 1; i > 0; i--) { // shuffle so equal moves vary between games
            const j = Math.floor(rnd() * (i + 1));
            [root[i], root[j]] = [root[j], root[i]];
        }
        if (root.length === 1) return { move: root[0].m, score: 0, depth: 0, nodes: 0, stoppedBy: 'forced', scores: [], blunder: false };

        clearTT();
        KILLERS.fill(0); HISTORY.fill(0);
        nodes = 0; stopped = false; stoppedBy = null; canStop = false;
        nodeLimit = Math.max(1, params.nodeBudget || Infinity);
        // Fractional qsDepth: 0.4 means horizon 1 on 40% of moves, 0 otherwise.
        const qs = params.qsDepth >= 0 ? params.qsDepth : 99;
        qsLimit = Math.floor(qs) + (rnd() < qs - Math.floor(qs) ? 1 : 0);
        const t0 = now();
        deadline = t0 + (params.timeCapMs > 0 ? params.timeCapMs : Infinity);

        const noise = Math.max(0, params.noiseCp || 0);
        const natural = Math.max(0, params.naturalCp || 0);
        const weak = noise > 0 || natural > 0 || params.blunderChance > 0 || params.missCaptureChance > 0 ||
            params.missQuietChance > 0;
        const checked = inCheck();

        let cand = root;
        if (params.missCaptureChance > 0 && !checked) {
            cand = root.filter((x) => !(isCapture(x.m) && rnd() < params.missCaptureChance));
            if (cand.length === 0) cand = root;
        }
        if (params.missQuietChance > 0 && !checked) {
            const kept = cand.filter((x) => rnd() >= oversightChance(x.m, params.missQuietChance));
            if (kept.length > 0) cand = kept;
        }
        if (natural > 0) for (const x of cand) x.bonus = Math.round(naturalness(x.m) * natural);
        canStop = true; // the budget is a ceiling everywhere, including depth 1 and blind moves
        if (params.blunderChance > 0 && rnd() < params.blunderChance) {
            for (const x of cand) { x.blind = true; x.score = blindScore(x.m, params.blindDepth | 0); }
        }
        const seen = cand.filter((x) => !x.blind);
        const margin = 2 * noise + natural + 1;

        // Static score of every move (one node each): orders depth 1 so the plausible moves are
        // searched first, and is the fallback when the budget runs out before any move is searched.
        for (const x of seen) {
            makeMove(x.m);
            x.score = -evaluate();
            unmakeMove();
            nodes++;
        }
        seen.sort((a, b) => b.score - a.score);

        let result = null;
        // Fractional maxDepth: 1.3 means depth 2 on 30% of moves, depth 1 otherwise.
        const md = Math.max(1, params.maxDepth || 1);
        const maxDepth = Math.floor(md) + (rnd() < md - Math.floor(md) ? 1 : 0);
        for (let depth = 1; depth <= maxDepth && seen.length > 0; depth++) {
            let alpha = -INF, iterBest = -INF, iterMove = 0, done = 0;
            for (let i = 0; i < seen.length && !stopped; i++) {
                const m = seen[i].m;
                makeMove(m);
                let s;
                if (weak) {
                    // Exact scores for every move that could still win after noise and bonus.
                    const lower = iterBest === -INF ? -INF : iterBest - margin;
                    s = -search(depth - 1, -INF, -lower, 1, true);
                } else if (i === 0) {
                    s = -search(depth - 1, -INF, INF, 1, true);
                } else {
                    s = -search(depth - 1, -alpha - 1, -alpha, 1, true);
                    if (s > alpha && !stopped) s = -search(depth - 1, -INF, -alpha, 1, true);
                }
                unmakeMove();
                if (stopped) break;
                seen[i].next = s;
                done++;
                if (s > iterBest) { iterBest = s; iterMove = m; }
                if (s > alpha) alpha = s;
            }
            if (stopped) {
                if (!result) {
                    // Out of budget during depth 1: only the moves searched so far are considered
                    // (in static order); if none was, all of them by their static score.
                    const use = done > 0 ? seen.slice(0, done) : seen;
                    let best = use[0];
                    for (const x of use) {
                        x.ok = true;
                        if (done > 0) x.score = x.next;
                        if (x.score > best.score) best = x;
                    }
                    result = { move: best.m, score: best.score, depth: done > 0 ? 1 : 0 };
                } else if (!weak && done > 0 && iterMove !== result.move) {
                    // A partial iteration still proves its best move at least as good as the old
                    // PV move (searched first), so full-strength play keeps it.
                    result.move = iterMove; result.score = iterBest;
                }
                break;
            }
            // Scores only change once an iteration completes, so all moves share one depth.
            for (const x of seen) { x.score = x.next; x.ok = true; }
            // Stable sort: best first, keeps previous order among equals.
            seen.sort((a, b) => b.score - a.score);
            result = { move: iterMove, score: iterBest, depth };
            if (Math.abs(iterBest) > MATE_BOUND && depth >= MATE - Math.abs(iterBest)) break;
        }
        canStop = false;
        if (!stoppedBy) stoppedBy = 'depth';

        if (!result) result = { move: 0, score: -INF, depth: 0 }; // every considered move was blind
        let blunder = false;
        // A mate the real search found is always played; noise only blurs ordinary scores.
        if (weak && !(result.depth > 0 && result.score > MATE_BOUND)) {
            let pickVal = -INF;
            const searchMove = result.move, searchScore = result.score;
            for (const x of cand) {
                if (!x.blind && !x.ok) continue;
                // Exact ties with the search's own choice keep its tie-break (move ordering
                // prefers promotions and captures), so a won promotion is not postponed forever.
                if (!x.blind && result.depth > 0 && x.score === searchScore && x.m !== searchMove) continue;
                const v = x.score + x.bonus + (noise ? (rnd() + rnd() - 1) * noise : 0);
                if (v > pickVal) { pickVal = v; result.move = x.m; blunder = x.blind; }
            }
        }
        result.nodes = nodes;
        result.stoppedBy = stoppedBy;
        result.blunder = blunder;
        result.scores = cand.map((x) => ({ m: x.m, score: x.score, blind: x.blind, bonus: x.bonus }));
        return result;
    }

    // --- ELO scaling (data-driven) ---
    // Each row is a parameter set at one ELO; eloParams() interpolates between rows.
    //   nodeBudget        positions searched per move (the strength knob; device independent)
    //   maxDepth          iterative-deepening depth cap; fractional values pick the next whole
    //                     depth on that share of moves
    //   qsDepth           capture plies searched past the horizon (tactical horizon; 99 = unlimited);
    //                     fractional values pick the next whole number on that share of moves
    //   timeCapMs         safety cap only (about 3x the expected time on a slow phone)
    //   noiseCp           misjudgement noise, +/- centipawns
    //   blunderChance     chance per move to play carelessly (all moves judged "blind", no quiescence)
    //   blindDepth        opponent plies a blind move looks ahead (0 = static eval, misses even mate in one)
    //   missCaptureChance per capture chance that it is not seen at all
    //   missQuietChance   per quiet move chance that it is not considered (retreats more, checks less)
    //   naturalCp         max bonus for natural-looking moves (captures, checks, development)
    // Fitted by tools/calibration (tables/final2.json) on the human scale: slider = Lichess rapid; 2400 = "Max".
    const SLOW_PHONE_NODES_PER_MS = 60;
    const capFor = (nodeBudget) => Math.round(Math.min(60000, Math.max(500, 3 * nodeBudget / SLOW_PHONE_NODES_PER_MS)));
    const DEFAULT_ELO_TABLE = [
        { elo: 400, nodeBudget: 820, maxDepth: 1, qsDepth: 0, noiseCp: 244, blunderChance: 0.783, blindDepth: 0, missCaptureChance: 0.441, missQuietChance: 0.737, naturalCp: 69 },
        { elo: 500, nodeBudget: 1000, maxDepth: 1, qsDepth: 0.03, noiseCp: 170, blunderChance: 0.569, blindDepth: 0, missCaptureChance: 0.333, missQuietChance: 0.574, naturalCp: 58 },
        { elo: 600, nodeBudget: 1200, maxDepth: 1, qsDepth: 0.19, noiseCp: 122, blunderChance: 0.425, blindDepth: 0, missCaptureChance: 0.253, missQuietChance: 0.454, naturalCp: 50 },
        { elo: 700, nodeBudget: 1400, maxDepth: 1, qsDepth: 0.42, noiseCp: 76, blunderChance: 0.295, blindDepth: 0, missCaptureChance: 0.176, missQuietChance: 0.34, naturalCp: 43 },
        { elo: 800, nodeBudget: 1800, maxDepth: 1, qsDepth: 0.63, noiseCp: 47, blunderChance: 0.179, blindDepth: 0, missCaptureChance: 0.118, missQuietChance: 0.268, naturalCp: 37 },
        { elo: 900, nodeBudget: 2200, maxDepth: 1, qsDepth: 0.78, noiseCp: 40, blunderChance: 0.134, blindDepth: 0, missCaptureChance: 0.094, missQuietChance: 0.236, naturalCp: 34 },
        { elo: 1000, nodeBudget: 2600, maxDepth: 1, qsDepth: 0.9, noiseCp: 40, blunderChance: 0.127, blindDepth: 0, missCaptureChance: 0.087, missQuietChance: 0.217, naturalCp: 32 },
        { elo: 1100, nodeBudget: 3300, maxDepth: 1.1, qsDepth: 1, noiseCp: 38, blunderChance: 0.114, blindDepth: 0, missCaptureChance: 0.075, missQuietChance: 0.19, naturalCp: 29 },
        { elo: 1200, nodeBudget: 4600, maxDepth: 1.45, qsDepth: 1, noiseCp: 33, blunderChance: 0.093, blindDepth: 0, missCaptureChance: 0.058, missQuietChance: 0.155, naturalCp: 26 },
        { elo: 1300, nodeBudget: 5200, maxDepth: 1.55, qsDepth: 1, noiseCp: 32, blunderChance: 0.087, blindDepth: 1, missCaptureChance: 0.052, missQuietChance: 0.145, naturalCp: 24 },
        { elo: 1400, nodeBudget: 6600, maxDepth: 1.81, qsDepth: 1, noiseCp: 28, blunderChance: 0.071, blindDepth: 1, missCaptureChance: 0.039, missQuietChance: 0.119, naturalCp: 22 },
        { elo: 1500, nodeBudget: 9000, maxDepth: 2.13, qsDepth: 1.25, noiseCp: 24, blunderChance: 0.056, blindDepth: 1, missCaptureChance: 0.027, missQuietChance: 0.092, naturalCp: 19 },
        { elo: 1600, nodeBudget: 12000, maxDepth: 2.48, qsDepth: 1.96, noiseCp: 20, blunderChance: 0.046, blindDepth: 1, missCaptureChance: 0.02, missQuietChance: 0.071, naturalCp: 15 },
        { elo: 1700, nodeBudget: 19000, maxDepth: 2.94, qsDepth: 2.88, noiseCp: 16, blunderChance: 0.032, blindDepth: 1, missCaptureChance: 0.011, missQuietChance: 0.044, naturalCp: 11 },
        { elo: 1800, nodeBudget: 27000, maxDepth: 3.71, qsDepth: 25.72, noiseCp: 13, blunderChance: 0.025, blindDepth: 1, missCaptureChance: 0.008, missQuietChance: 0.031, naturalCp: 9 },
        { elo: 1900, nodeBudget: 38000, maxDepth: 4.57, qsDepth: 53.18, noiseCp: 11, blunderChance: 0.02, blindDepth: 2, missCaptureChance: 0.005, missQuietChance: 0.019, naturalCp: 7 },
        { elo: 2000, nodeBudget: 57000, maxDepth: 5.51, qsDepth: 83.16, noiseCp: 9, blunderChance: 0.013, blindDepth: 2, missCaptureChance: 0.002, missQuietChance: 0.007, naturalCp: 6 },
        { elo: 2100, nodeBudget: 83000, maxDepth: 6.64, qsDepth: 99, noiseCp: 7, blunderChance: 0.007, blindDepth: 2, missCaptureChance: 0, missQuietChance: 0, naturalCp: 3 },
        { elo: 2200, nodeBudget: 130000, maxDepth: 8.55, qsDepth: 99, noiseCp: 3, blunderChance: 0, blindDepth: 2, missCaptureChance: 0, missQuietChance: 0, naturalCp: 0 },
        { elo: 2300, nodeBudget: 290000, maxDepth: 64, qsDepth: 99, noiseCp: 0, blunderChance: 0, blindDepth: 2, missCaptureChance: 0, missQuietChance: 0, naturalCp: 0 },
        { elo: 2400, nodeBudget: 1200000, maxDepth: 64, qsDepth: 99, noiseCp: 0, blunderChance: 0, blindDepth: 2, missCaptureChance: 0, missQuietChance: 0, naturalCp: 0 },
    ];
    const HINT_PARAMS = { nodeBudget: 300000, maxDepth: 64, qsDepth: 99, noiseCp: 0, blunderChance: 0, blindDepth: 0, missCaptureChance: 0, missQuietChance: 0, naturalCp: 0 };
    const PARAM_KEYS = ['nodeBudget', 'maxDepth', 'qsDepth', 'timeCapMs', 'noiseCp', 'blunderChance', 'blindDepth', 'missCaptureChance', 'missQuietChance', 'naturalCp'];
    const INT_KEYS = { nodeBudget: 1, maxDepth: 1, timeCapMs: 1, blindDepth: 1, noiseCp: 1, naturalCp: 1 };
    let eloTable = DEFAULT_ELO_TABLE;

    // Fills defaults and clamps one parameter set; never throws.
    function normalizeParams(p) {
        const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
        const out = {
            nodeBudget: Math.max(1, Math.round(n(p.nodeBudget, 300000))),
            maxDepth: Math.max(1, Math.min(64, Math.round(n(p.maxDepth, 64) * 100) / 100)),
            qsDepth: Math.max(0, Math.min(99, Math.round(n(p.qsDepth, 99) * 100) / 100)),
            timeCapMs: 0,
            noiseCp: Math.max(0, Math.round(n(p.noiseCp, 0))),
            blunderChance: Math.max(0, Math.min(1, n(p.blunderChance, 0))),
            blindDepth: Math.max(0, Math.min(4, Math.round(n(p.blindDepth, 0)))),
            missCaptureChance: Math.max(0, Math.min(1, n(p.missCaptureChance, 0))),
            missQuietChance: Math.max(0, Math.min(1, n(p.missQuietChance, 0))),
            naturalCp: Math.max(0, Math.round(n(p.naturalCp, 0))),
        };
        out.timeCapMs = n(p.timeCapMs, 0) > 0 ? Math.round(n(p.timeCapMs, 0)) : capFor(out.nodeBudget);
        if (p.seed != null) out.seed = Number(p.seed) >>> 0;
        return out;
    }

    // Replaces the ELO table (rows { elo, ...params }, any order). Pass null to restore the
    // default. Returns false (and keeps the old table) if the table is unusable.
    function setEloTable(table) {
        if (table == null) { eloTable = DEFAULT_ELO_TABLE; return true; }
        if (!Array.isArray(table)) return false;
        const rows = table.filter((r) => r && Number.isFinite(Number(r.elo)))
            .map((r) => ({ ...r, elo: Number(r.elo) })).sort((a, b) => a.elo - b.elo);
        if (rows.length === 0) return false;
        eloTable = rows;
        return true;
    }

    function eloParams(elo) {
        const rows = eloTable;
        const lo = rows[0].elo, hi = rows[rows.length - 1].elo;
        const e = Math.min(hi, Math.max(lo, Number.isFinite(Number(elo)) && elo !== null ? Number(elo) : 1200));
        if (rows.length === 1) return normalizeParams(rows[0]);
        let i = 0;
        while (i < rows.length - 2 && e > rows[i + 1].elo) i++;
        const a = rows[i], b = rows[i + 1];
        const t = b.elo === a.elo ? 0 : (e - a.elo) / (b.elo - a.elo);
        const out = {};
        for (const k of PARAM_KEYS) {
            if (a[k] == null && b[k] == null) continue;
            const va = Number(a[k] ?? b[k]), vb = Number(b[k] ?? a[k]);
            // Node budgets grow roughly geometrically between rows.
            out[k] = k === 'nodeBudget' && va > 0 && vb > 0 ? va * Math.pow(vb / va, t) : va + (vb - va) * t;
            if (INT_KEYS[k] && k !== 'nodeBudget' && k !== 'maxDepth') out[k] = Math.round(out[k]);
        }
        return normalizeParams(out);
    }

    const hintParams = () => normalizeParams(HINT_PARAMS);

    // --- Conversion to/from the gameLogic.js move shape ---
    function toGameMove(m) {
        const from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7, flags = m >> 15;
        return {
            from: { row: from >> 3, col: from & 7 },
            to: { row: to >> 3, col: to & 7 },
            piece: PIECE_CHARS[sq[from] + 6],
            isPromotion: promo > 0,
            promotionPiece: promo ? PROMO_CHARS[promo] : null,
            isCastling: !!(flags & FLAG_CASTLE),
            isEnPassant: !!(flags & FLAG_EP),
        };
    }

    function findEngineMove(move) {
        const from = move.from.row * 8 + move.from.col, to = move.to.row * 8 + move.to.col;
        const promo = move.isPromotion || move.promotionPiece
            ? PROMO_CHARS.indexOf(String(move.promotionPiece || move.promo || 'Q').toUpperCase()) : 0;
        return legalMoves().find((m) => (m & 63) === from && ((m >> 6) & 63) === to && ((m >> 12) & 7) === Math.max(0, promo)) || 0;
    }

    // Best move for a state object (see aiClient.js for the shape) with an explicit parameter
    // set (see eloParams). Does not touch globals. Used by findBestMove and the calibration harness.
    function searchWithParams(state, params, positionHistory) {
        lastSearchInfo = null;
        if (!loadState(state, positionHistory)) return null;
        const p = normalizeParams(params || {});
        seedForSearch(p);
        const res = searchRoot(p);
        if (!res) return null;
        lastSearchInfo = {
            depth: res.depth, score: res.score, nodes: res.nodes, stoppedBy: res.stoppedBy,
            blunder: res.blunder, params: p, scores: res.scores,
        };
        return toGameMove(res.move);
    }

    // options: { hint: true } plays at full strength with the hint node budget;
    // { seed } makes this move reproducible. timeMs > 0 overrides the safety time cap.
    function findBestMove(state, elo, timeMs, positionHistory, options) {
        const opts = options || {};
        const params = opts.hint ? hintParams() : eloParams(elo);
        if (timeMs > 0) params.timeCapMs = timeMs;
        if (opts.seed != null) params.seed = opts.seed;
        const move = searchWithParams(state, params, positionHistory);
        if (move && lastSearchInfo) {
            debugLog(`AI (${opts.hint ? 'hint' : 'ELO ' + elo}): depth ${lastSearchInfo.depth}, score ${lastSearchInfo.score}, nodes ${lastSearchInfo.nodes}`);
        }
        return move;
    }
    let lastSearchInfo = null;

    // Apply a game-shaped move to the gameLogic.js globals through the engine's makeMove.
    // Used by tests and self-play; returns false if the move is not legal.
    function applyMoveToGlobals(move) {
        if (!loadFromGlobals()) return false;
        const m = findEngineMove(move);
        if (!m) return false;
        makeMove(m);
        writeToGlobals();
        return true;
    }

    return {
        findBestMove,
        searchWithParams,
        eloParams,
        setEloTable,
        getEloTable: () => eloTable.map((r) => ({ ...r })),
        DEFAULT_ELO_TABLE: DEFAULT_ELO_TABLE.map((r) => Object.freeze({ ...r })),
        hintParams,
        setSeed,
        applyMoveToGlobals,
        loadState,
        loadFromGlobals,
        perft,
        makeMove,
        unmakeMove,
        legalMoves,
        toGameMove,
        writeToGlobals,
        hashIsConsistent: () => { const [lo, hi] = hashOf(sq, side, castle, ep); return lo === hashLo && hi === hashHi; },
        evaluateWhite: () => (side === WHITE ? 1 : -1) * (evaluate() - TEMPO),
        getLastSearchInfo: () => lastSearchInfo,
        MATE,
    };
})();

/**
 * Calculates the best move for the current player (gameLogic.js globals) at the given ELO.
 * Does not modify any global state and does not use the DOM.
 * @param {number} elo - 300..2500.
 * @param {number} [timeMs] - optional safety time cap in milliseconds (strength comes from the node budget).
 * @param {string[]} [positionHistory] - getBoardPositionString() of earlier positions for
 *        repetition detection. Defaults to gameHistory[0..currentMoveIndex] when available.
 * @param {object} [options] - { hint: true } for full strength with the hint node budget,
 *        { seed } for a reproducible move.
 * @returns {object|null} move in the getAllLegalMoves shape, or null if there is no legal move.
 */
function calculateBestMove(elo, timeMs, positionHistory, options) {
    let history = positionHistory;
    if (!Array.isArray(history)) {
        history = [];
        if (typeof gameHistory !== 'undefined' && Array.isArray(gameHistory) && currentMoveIndex >= 0) {
            history = gameHistory.slice(0, currentMoveIndex + 1).map(getBoardPositionString);
        }
    }
    const state = { board, currentPlayer, castlingRights, enPassantTarget, halfmoveClock, fullmoveNumber };
    const t0 = Date.now();
    let move = null;
    try {
        move = ChessAI.findBestMove(state, elo, timeMs, history, options);
    } catch (error) {
        console.error(`Error during AI (ELO ${elo}) move calculation:`, error);
        const moves = getAllLegalMoves(currentPlayer);
        move = moves.length ? moves[Math.floor(Math.random() * moves.length)] : null;
    }
    debugLog(`AI calculation time: ${Date.now() - t0} ms`, move);
    return move;
}

/**
 * Generates all legal moves for a given player using the gameLogic.js generator.
 * @param {string} player - 'w' or 'b'.
 * @returns {Array<object>} { from, to, piece, isPromotion, promotionPiece, isCastling, isEnPassant }
 */
function getAllLegalMoves(player) {
    const allMoves = [];
    const originalPlayer = currentPlayer; // Backup context
    currentPlayer = player; // Temporarily set global context

    try {
        for (let r = 0; r < BOARD_SIZE; r++) {
            for (let c = 0; c < BOARD_SIZE; c++) {
                const piece = getPieceAt(r, c);
                if (piece && getPlayerForPiece(piece) === player) {
                    const moves = generateLegalMoves(r, c); // Uses the temporary currentPlayer
                    moves.forEach(move => {
                        allMoves.push({
                            from: { row: r, col: c },
                            to: { row: move.row, col: move.col },
                            piece: piece,
                            isPromotion: move.isPromotion || false,
                            isCastling: move.isCastling || false,
                            isEnPassant: move.isEnPassant || false,
                            promotionPiece: move.isPromotion ? 'Q' : null
                        });
                    });
                }
            }
        }
    } finally {
        currentPlayer = originalPlayer; // Restore original player context IMPORTANT!
    }
    return allMoves;
}

/**
 * Evaluates the current board (gameLogic.js globals) from White's perspective, in pawns.
 */
function evaluateBoard() {
    if (!ChessAI.loadFromGlobals()) return 0;
    return ChessAI.evaluateWhite() / 100;
}

/**
 * Updates the GLOBAL castlingRights for a move (king move, rook leaving its corner, or a
 * rook captured on its corner). Kept for callers and test harnesses.
 */
function updateCastlingRightsSim(piece, capturedPiece, fromRow, fromCol, toRow, toCol) {
     const player = getPlayerForPiece(piece);
     const opponent = getOpponent(player);

     if (piece.toUpperCase() === 'K') {
         castlingRights[player].K = castlingRights[player].Q = false;
     }
     if (piece.toUpperCase() === 'R') {
         const homeRow = player === 'w' ? 7 : 0;
         if (fromRow === homeRow && fromCol === 0) castlingRights[player].Q = false;
         if (fromRow === homeRow && fromCol === 7) castlingRights[player].K = false;
     }
     if (capturedPiece && capturedPiece.toUpperCase() === 'R') {
         const homeRow = opponent === 'w' ? 7 : 0;
         if (toRow === homeRow && toCol === 0) castlingRights[opponent].Q = false;
         if (toRow === homeRow && toCol === 7) castlingRights[opponent].K = false;
     }
}

// --- END OF FILE aiPlayer.js ---
