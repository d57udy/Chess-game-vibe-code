// --- START OF FILE aiPlayer.js ---

// Chess AI. A self-contained search engine (negamax + alpha-beta, quiescence search,
// transposition table, killer/history move ordering, iterative deepening with a time
// budget) that reads the gameLogic.js globals but never mutates them during search.
//
// Everything engine-internal lives inside the ChessAI closure so nothing collides with
// ui.js globals (ui.js has its own makeMove). Public globals defined by this file:
//   calculateBestMove(elo, timeMs?, positionHistory?)  -> move | null
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
    const KILLERS = new Int32Array(MAX_PLY * 2);
    const HISTORY = new Int32Array(2 * 64 * 64);
    let nodes = 0, stopped = false, canStop = false, deadline = 0;
    const now = (typeof performance !== 'undefined' && performance.now)
        ? () => performance.now() : () => Date.now();

    function checkTime() {
        if (canStop && now() >= deadline) stopped = true;
    }

    function scoreMoves(start, end, ttMove, ply) {
        const k1 = KILLERS[ply * 2], k2 = KILLERS[ply * 2 + 1];
        const hBase = side === WHITE ? 0 : 4096;
        for (let i = start; i < end; i++) {
            const m = MOVES[i];
            if (m === ttMove) { SCORES[i] = 2000000000; continue; }
            const from = m & 63, to = (m >> 6) & 63, promo = (m >> 12) & 7;
            const victim = (m >> 15) & FLAG_EP ? PAWN : Math.abs(sq[to]);
            if (victim) {
                SCORES[i] = 1000000 + VALUE[victim] * 10 - Math.abs(sq[from]) + (promo === QUEEN ? 9000 : 0);
            } else if (promo) {
                SCORES[i] = promo === QUEEN ? 950000 : -1000;
            } else if (m === k1) {
                SCORES[i] = 900000;
            } else if (m === k2) {
                SCORES[i] = 890000;
            } else {
                SCORES[i] = Math.min(HISTORY[hBase + from * 64 + to], 800000);
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

    function quiesce(alpha, beta, ply) {
        if ((++nodes & 1023) === 0) checkTime();
        if (stopped) return 0;
        if (ply >= MAX_PLY - 1) return evaluate();
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
                const victim = (m >> 15) & FLAG_EP ? PAWN : Math.abs(sq[(m >> 6) & 63]);
                if (stand + VALUE[victim] + 200 <= alpha) continue;
            }
            makeMove(m);
            if (attacked(kingSq[ci(us)], -us)) { unmakeMove(); continue; }
            legal++;
            const score = -quiesce(-beta, -alpha, ply + 1);
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
        if ((++nodes & 1023) === 0) checkTime();
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
        if (depth <= 0) return quiesce(alpha, beta, ply);

        const origAlpha = alpha;
        const idx = hashLo & TT_MASK;
        let ttMove = 0;
        if (TT_FLAG[idx] && TT_LO[idx] === hashLo && TT_HI[idx] === hashHi) {
            ttMove = TT_MOVE[idx];
            if (ply > 0 && TT_DEPTH[idx] >= depth) {
                let s = TT_SCORE[idx];
                if (s > MATE_BOUND) s -= ply; else if (s < -MATE_BOUND) s += ply;
                const f = TT_FLAG[idx];
                if (f === TT_EXACT || (f === TT_LOWER && s >= beta) || (f === TT_UPPER && s <= alpha)) return s;
            }
        }

        // Null-move pruning
        if (allowNull && !checked && ply > 0 && depth >= 3 && beta < MATE_BOUND && hasNonPawnMaterial(us) &&
            evaluate() >= beta) {
            makeNullMove();
            const s = -search(depth - 1 - (depth >= 6 ? 3 : 2), -beta, -beta + 1, ply + 1, false);
            unmakeNullMove();
            if (stopped) return 0;
            if (s >= beta) return s >= MATE_BOUND ? beta : s;
        }

        const start = ply * MOVES_PER_PLY;
        const end = genMoves(start, false);
        scoreMoves(start, end, ttMove, ply);
        let legal = 0, best = -INF, bestMove = 0;
        for (let i = start; i < end; i++) {
            pickMove(i, end);
            const m = MOVES[i];
            makeMove(m);
            if (attacked(kingSq[ci(us)], them)) { unmakeMove(); continue; }
            legal++;
            const quiet = U_CAP[sp - 1] === 0 && ((m >> 12) & 7) === 0;
            let score;
            if (legal === 1) {
                score = -search(depth - 1, -beta, -alpha, ply + 1, true);
            } else {
                // Late move reductions for quiet moves, then PVS re-searches.
                let R = 0;
                if (depth >= 3 && legal > 3 && quiet && !checked &&
                    m !== KILLERS[ply * 2] && m !== KILLERS[ply * 2 + 1] &&
                    !attacked(kingSq[ci(them)], us)) {
                    R = legal > 10 ? 2 : 1;
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

        if (TT_DEPTH[idx] <= depth || TT_LO[idx] !== hashLo || TT_HI[idx] !== hashHi) {
            TT_LO[idx] = hashLo; TT_HI[idx] = hashHi; TT_MOVE[idx] = bestMove;
            TT_SCORE[idx] = best > MATE_BOUND ? best + ply : best < -MATE_BOUND ? best - ply : best;
            TT_DEPTH[idx] = depth;
            TT_FLAG[idx] = best <= origAlpha ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
        }
        return best;
    }

    // Iterative deepening at the root. Returns { move, score, depth, nodes } where move is the
    // best move of the last completed iteration. With noise > 0 every root move within
    // `noise` centipawns of the best gets an exact score and the pick is randomised.
    function searchRoot(maxDepth, timeMs, noise) {
        const root = legalMoves().map((m) => ({ m, score: 0 }));
        if (root.length === 0) return null;
        for (let i = root.length - 1; i > 0; i--) { // shuffle so equal moves vary between games
            const j = Math.floor(Math.random() * (i + 1));
            [root[i], root[j]] = [root[j], root[i]];
        }
        if (root.length === 1) return { move: root[0].m, score: 0, depth: 0, nodes: 0 };

        clearTT();
        KILLERS.fill(0); HISTORY.fill(0);
        nodes = 0; stopped = false;
        const t0 = now();
        deadline = t0 + timeMs;

        let result = null;
        for (let depth = 1; depth <= maxDepth; depth++) {
            canStop = depth > 1; // depth 1 always completes so there is always a move
            let alpha = -INF, iterBest = -INF, iterMove = 0;
            for (let i = 0; i < root.length; i++) {
                const m = root[i].m;
                makeMove(m);
                let s;
                if (noise > 0) {
                    const lower = iterBest === -INF ? -INF : iterBest - noise;
                    s = -search(depth - 1, -INF, -lower, 1, true);
                } else if (i === 0) {
                    s = -search(depth - 1, -INF, INF, 1, true);
                } else {
                    s = -search(depth - 1, -alpha - 1, -alpha, 1, true);
                    if (s > alpha && !stopped) s = -search(depth - 1, -INF, -alpha, 1, true);
                }
                unmakeMove();
                if (stopped) break;
                root[i].score = s;
                if (s > iterBest) { iterBest = s; iterMove = m; }
                if (s > alpha) alpha = s;
            }
            if (stopped) break;

            // Stable sort: best first, keeps previous order among equals.
            root.sort((a, b) => b.score - a.score);
            result = { move: iterMove, score: iterBest, depth, nodes, scores: root.map((x) => ({ m: x.m, score: x.score })) };

            if (Math.abs(iterBest) > MATE_BOUND && depth >= MATE - Math.abs(iterBest)) break;
            if (now() - t0 > timeMs * 0.45) break; // next iteration would very likely not finish
        }
        canStop = false;

        if (result && noise > 0) {
            let pick = result.move, pickVal = -INF;
            for (const { m, score } of result.scores) {
                if (score < result.score - noise) continue;
                const v = score + Math.random() * noise;
                if (v > pickVal) { pickVal = v; pick = m; }
            }
            result.move = pick;
        }
        return result;
    }

    // --- ELO scaling ---
    // [elo, maxDepth, timeMs, noiseCp, randomMoveChance]; values are interpolated.
    const ELO_ANCHORS = [
        [300, 1, 300, 400, 0.45],
        [700, 1, 300, 220, 0.18],
        [1000, 2, 300, 120, 0.07],
        [1300, 3, 400, 70, 0.03],
        [1600, 4, 500, 40, 0.01],
        [1900, 5, 700, 20, 0],
        [2100, 7, 900, 8, 0],
        [2300, 12, 1300, 0, 0],
        [2500, 64, 2000, 0, 0],
    ];

    function eloParams(elo) {
        const e = Math.min(2500, Math.max(300, Number(elo) || 1200));
        let i = 0;
        while (i < ELO_ANCHORS.length - 2 && e > ELO_ANCHORS[i + 1][0]) i++;
        const a = ELO_ANCHORS[i], b = ELO_ANCHORS[i + 1];
        const t = (e - a[0]) / (b[0] - a[0]);
        const lerp = (k) => a[k] + (b[k] - a[k]) * t;
        return {
            maxDepth: Math.max(1, Math.floor(lerp(1))),
            timeMs: Math.round(lerp(2)),
            noise: Math.round(lerp(3)),
            randomChance: lerp(4),
        };
    }

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

    // Best move for a state object (see aiClient.js for the shape). Does not touch globals.
    function findBestMove(state, elo, timeMs, positionHistory) {
        if (!loadState(state, positionHistory)) return null;
        const params = eloParams(elo);
        if (timeMs > 0) params.timeMs = timeMs;
        const moves = legalMoves();
        if (moves.length === 0) return null;
        if (Math.random() < params.randomChance) {
            return toGameMove(moves[Math.floor(Math.random() * moves.length)]);
        }
        const res = searchRoot(params.maxDepth, params.timeMs, params.noise);
        if (!res) return null;
        debugLog(`AI (ELO ${elo}): depth ${res.depth}, score ${res.score}, nodes ${res.nodes}`);
        lastSearchInfo = { depth: res.depth, score: res.score, nodes: res.nodes, params, scores: res.scores };
        return toGameMove(res.move);
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
        eloParams,
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
 * @param {number} [timeMs] - optional time budget override in milliseconds.
 * @param {string[]} [positionHistory] - getBoardPositionString() of earlier positions for
 *        repetition detection. Defaults to gameHistory[0..currentMoveIndex] when available.
 * @returns {object|null} move in the getAllLegalMoves shape, or null if there is no legal move.
 */
function calculateBestMove(elo, timeMs, positionHistory) {
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
        move = ChessAI.findBestMove(state, elo, timeMs, history);
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
