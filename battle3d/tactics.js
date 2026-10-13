// --- START OF FILE battle3d/tactics.js ---

// Tactical motif detectors for coach mode. Pure ES module: no DOM, no globals; works on the
// gameLogic.js state shape { board (8x8, 'P'/'p'.. or null, row 0 = rank 8), currentPlayer,
// castlingRights, enPassantTarget } and on game moves { from: {row,col}, to: {row,col},
// promotionPiece? } (promotion is accepted as an alias).
//
//   detect(stateBefore, move, stateAfter?, opts?) -> [motif]
//   hangingPieces(state, side) -> [{ square, piece, attackers, defenders, gain }]
//
// motif = { motif, by, squares, pieces, ...details }
//   motif:   'fork'|'pin'|'skewer'|'hanging'|'backRank'|'missedCapture'|'allowsMate'|'missedMate'|
//            'trappedPiece'|'discovered'
//   by:      the colour ('w'|'b') the motif favours. For 'hanging', 'allowsMate' and the back-rank
//            mate it allows that is the opponent of the mover; for 'missedCapture' and 'missedMate'
//            it is the mover (what they could have had).
//   squares: algebraic names ('e4'), the key squares first (see each detector); pieces: the
//            piece letters on them (in the position the motif refers to).
//   Convenience fields for templates (piece letters / algebraic squares, null when not
//   meaningful): square (where it happens), piece (the piece it is about), attacker /
//   attackerSquare (the piece doing it), target / targetSquare (the piece it hits). Per motif:
//     fork: square = forker's square, attacker = forker, target = first forked piece
//     pin / skewer: attacker = line piece, target = the front piece, behind / behindSquare
//     discovered: attacker = unmasked line piece, target = what it hits, square = where the
//       moved piece went
//     hanging / trappedPiece: piece = target = the piece at risk, square = its square,
//       attacker = its first attacker
//     missedCapture: square = target square, target = piece that could be taken, attacker = taker
//     allowsMate / missedMate: square = mating move's destination, attacker = mating piece
//     backRank: square = checker's square, attacker = checker, target = king
//
// Precision over recall: a motif is only reported when it is really there. Captures must be
// legal (pins and checks respected) and win material by static exchange (SEE); mates are found
// by exact search (mate in one). opts.before / opts.after are ChessAI.analyze() results for
// stateBefore / stateAfter (the coach should always pass them):
//   - fork, skewer, trappedPiece and discovered attacks (non-check) are ONLY reported with
//     opts.after, when its line wins the material: on real games their static versions were
//     refuted by a defence a geometric check cannot see (interpositions, counter-captures,
//     defenders reconnecting after a king move) too often;
//   - hanging (static: a legal capture wins it by SEE) is, with opts.after, only reported when the
//     engine line actually takes it;
//   - missedCapture is engine-only: the engine's best move is that capture and the played move
//     loses >= 100 cp;
//   - allowsMate / missedMate also cover engine mates in two, each verified exactly (all
//     defences tried); a missed mate also needs the mover to be no longer crushing afterwards.
// Always static (exact): pin, discovered check, backRank, hanging, mate in one. Castling is not generated
// (it never matters for these motifs), underpromotion only as a knight.

const VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };
const KNIGHT_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const KING_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

const colorOf = (p) => (p ? (p === p.toUpperCase() ? 'w' : 'b') : null);
const typeOf = (p) => (p ? p.toUpperCase() : null);
const valueOf = (p) => (p ? VALUE[typeOf(p)] : 0);
const other = (c) => (c === 'w' ? 'b' : 'w');
const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
const name = (r, c) => String.fromCharCode(97 + c) + (8 - r);
const sqName = (s) => name(s >> 3, s & 7);

// --- Board helpers (flat 64-entry arrays, index = row * 8 + col) ---

function flat(state) {
    const b = new Array(64).fill(null);
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) b[r * 8 + c] = (state.board[r] && state.board[r][c]) || null;
    return b;
}

function epIndex(state) {
    const e = state && state.enPassantTarget;
    return e && typeof e.row === 'number' ? e.row * 8 + e.col : -1;
}

function kingSquare(b, color) {
    const k = color === 'w' ? 'K' : 'k';
    return b.indexOf(k);
}

// Squares of `color` pieces that attack square s on board b.
function attackers(b, s, color) {
    const out = [], r = s >> 3, c = s & 7;
    const own = (p) => p && colorOf(p) === color;
    const pr = color === 'w' ? r + 1 : r - 1; // a white pawn attacks upwards (towards row 0)
    for (const dc of [-1, 1]) {
        if (inside(pr, c + dc)) { const p = b[pr * 8 + c + dc]; if (own(p) && typeOf(p) === 'P') out.push(pr * 8 + c + dc); }
    }
    for (const [dr, dc] of KNIGHT_D) {
        if (inside(r + dr, c + dc)) { const p = b[(r + dr) * 8 + c + dc]; if (own(p) && typeOf(p) === 'N') out.push((r + dr) * 8 + c + dc); }
    }
    for (const [dr, dc] of KING_D) {
        if (inside(r + dr, c + dc)) { const p = b[(r + dr) * 8 + c + dc]; if (own(p) && typeOf(p) === 'K') out.push((r + dr) * 8 + c + dc); }
    }
    for (const [dirs, kinds] of [[ORTHO, 'RQ'], [DIAG, 'BQ']]) {
        for (const [dr, dc] of dirs) {
            for (let rr = r + dr, cc = c + dc; inside(rr, cc); rr += dr, cc += dc) {
                const p = b[rr * 8 + cc];
                if (!p) continue;
                if (own(p) && kinds.includes(typeOf(p))) out.push(rr * 8 + cc);
                break;
            }
        }
    }
    return out;
}

const attacked = (b, s, byColor) => attackers(b, s, byColor).length > 0;
const inCheck = (b, color) => { const k = kingSquare(b, color); return k >= 0 && attacked(b, k, other(color)); };

// Squares the piece on s attacks (pseudo-attacks).
function attacksFrom(b, s) {
    const p = b[s], t = typeOf(p), r = s >> 3, c = s & 7, out = [];
    if (!p) return out;
    if (t === 'P') {
        const dr = colorOf(p) === 'w' ? -1 : 1;
        for (const dc of [-1, 1]) if (inside(r + dr, c + dc)) out.push((r + dr) * 8 + c + dc);
    } else if (t === 'N' || t === 'K') {
        for (const [dr, dc] of t === 'N' ? KNIGHT_D : KING_D) if (inside(r + dr, c + dc)) out.push((r + dr) * 8 + c + dc);
    } else {
        const dirs = t === 'R' ? ORTHO : t === 'B' ? DIAG : ORTHO.concat(DIAG);
        for (const [dr, dc] of dirs) {
            for (let rr = r + dr, cc = c + dc; inside(rr, cc); rr += dr, cc += dc) {
                out.push(rr * 8 + cc);
                if (b[rr * 8 + cc]) break;
            }
        }
    }
    return out;
}

// Applies a move { from, to, promo? } (indices) to a copy of b. Handles en passant and promotion.
function applyMove(b, m, ep) {
    const n = b.slice(), p = n[m.from];
    n[m.from] = null;
    if (typeOf(p) === 'P' && m.to === ep && !b[m.to] && (m.to & 7) !== (m.from & 7)) n[(m.from & ~7) | (m.to & 7)] = null; // en passant victim
    if (typeOf(p) === 'K' && Math.abs((m.to & 7) - (m.from & 7)) === 2) { // castling (when given a game move)
        const row = m.from & ~7, kside = (m.to & 7) === 6;
        n[row + (kside ? 5 : 3)] = n[row + (kside ? 7 : 0)];
        n[row + (kside ? 7 : 0)] = null;
    }
    n[m.to] = m.promo ? (colorOf(p) === 'w' ? m.promo : m.promo.toLowerCase()) : p;
    return n;
}

// Legal moves of `color` (no castling; promotions to Q and N).
function legalMoves(b, color, ep) {
    const out = [];
    const push = (from, to, promo) => {
        const m = { from, to, promo: promo || null };
        if (!inCheck(applyMove(b, m, ep), color)) out.push(m);
    };
    for (let s = 0; s < 64; s++) {
        const p = b[s];
        if (!p || colorOf(p) !== color) continue;
        const t = typeOf(p), r = s >> 3, c = s & 7;
        if (t === 'P') {
            const dr = color === 'w' ? -1 : 1, last = color === 'w' ? 0 : 7, start = color === 'w' ? 6 : 1;
            const add = (to) => { if ((to >> 3) === last) { push(s, to, 'Q'); push(s, to, 'N'); } else push(s, to); };
            if (inside(r + dr, c) && !b[(r + dr) * 8 + c]) {
                add((r + dr) * 8 + c);
                if (r === start && !b[(r + 2 * dr) * 8 + c]) push(s, (r + 2 * dr) * 8 + c);
            }
            for (const dc of [-1, 1]) {
                if (!inside(r + dr, c + dc)) continue;
                const to = (r + dr) * 8 + c + dc, q = b[to];
                // En passant only takes the enemy pawn standing beside this one (so an ep square that
                // belongs to the other side's last move never gives `color` a diagonal step)
                const enPassant = to === ep && !q && b[r * 8 + c + dc] === (color === 'w' ? 'p' : 'P');
                if ((q && colorOf(q) !== color) || enPassant) add(to);
            }
        } else {
            for (const to of attacksFrom(b, s)) {
                const q = b[to];
                if (!q || colorOf(q) !== color) push(s, to);
            }
        }
    }
    return out;
}

const isMate = (b, color, ep = -1) => inCheck(b, color) && legalMoves(b, color, ep).length === 0;

// Mating moves for `color` to move on b.
function matesInOne(b, color, ep) {
    return legalMoves(b, color, ep).filter((m) => isMate(applyMove(b, m, ep), other(color)));
}

// Least valuable attacker of `color` on s (kings last).
function leastValuable(b, s, color) {
    let best = -1, bv = Infinity;
    for (const a of attackers(b, s, color)) { const v = valueOf(b[a]); if (v < bv) { bv = v; best = a; } }
    return best;
}

// Static exchange: material `byColor` wins by starting a capture sequence on s (>= 0; 0 when no
// capture is worthwhile). With a forced first capturer `first` (a square) the result can be
// negative (that capture loses material). X-rays are handled by recomputing attackers after each
// capture; a king never captures into a defended square.
function see(b0, s, byColor, first = -1) {
    const b = b0.slice();
    const gains = [];
    let target = valueOf(b[s]);
    let side = byColor;
    let from = first >= 0 ? first : leastValuable(b, s, side);
    if (from < 0) return 0;
    let d = 0;
    gains[0] = target;
    for (;;) {
        const moverValue = valueOf(b[from]);
        if (typeOf(b[from]) === 'K' && attackers(b, s, other(side)).filter((x) => x !== from).length > 0) {
            gains.pop(); d--; // the king may not capture a defended piece
            break;
        }
        b[s] = b[from]; b[from] = null;
        side = other(side);
        from = leastValuable(b, s, side);
        if (from < 0) break;
        d++;
        gains[d] = moverValue - gains[d - 1];
        target = moverValue;
    }
    for (let i = gains.length - 1; i > 0; i--) gains[i - 1] = -Math.max(-gains[i - 1], gains[i]);
    if (d < 0) return first >= 0 ? -Infinity : 0;
    return first >= 0 ? gains[0] : Math.max(0, gains[0]);
}

// Best material `byColor` wins on s with a legal first capture (0 if none).
function legalCaptureGain(b, s, byColor, ep) {
    let best = 0;
    for (const m of legalMoves(b, byColor, ep)) {
        if (m.to !== s || !b[s]) continue;
        best = Math.max(best, see(b, s, byColor, m.from));
    }
    return best;
}

// --- Public: hanging pieces ---

// Pieces of `side` (not the king) that the other side can win material on with a legal capture.
// attackers/defenders: algebraic squares; gain: centipawns the capturer wins by SEE.
export function hangingPieces(state, side) {
    try {
        const b = flat(state), ep = epIndex(state), opp = other(side), out = [];
        for (let s = 0; s < 64; s++) {
            const p = b[s];
            if (!p || colorOf(p) !== side || typeOf(p) === 'K') continue;
            const att = attackers(b, s, opp);
            if (att.length === 0) continue;
            const gain = legalCaptureGain(b, s, opp, ep);
            if (gain < 100) continue;
            out.push({ square: sqName(s), piece: p, attackers: att.map(sqName), defenders: attackers(b, s, side).map(sqName), gain });
        }
        return out.sort((a, b2) => b2.gain - a.gain);
    } catch (e) {
        return [];
    }
}

// --- Engine-line helpers (optional verification) ---

function idxOf(sq) { return sq.row * 8 + sq.col; }

// Material swing for `color` along the first `plies` moves of an engine pv starting on b, and the
// squares `color` captured on. Stops quietly at a move that does not fit the board.
function pvGains(b0, ep0, pv, color, plies) {
    let b = b0.slice(), ep = ep0, swing = 0;
    const capturedOn = [];
    for (let i = 0; i < Math.min(plies, (pv || []).length); i++) {
        const mv = pv[i];
        if (!mv || !mv.from || !mv.to) break;
        const from = idxOf(mv.from), to = idxOf(mv.to), p = b[from];
        if (!p) break;
        const epVictim = typeOf(p) === 'P' && to === ep && !b[to];
        const victim = epVictim ? b[(from & ~7) | (to & 7)] : b[to];
        const promo = mv.promotionPiece ? String(mv.promotionPiece).toUpperCase() : null;
        if (victim) {
            const v = valueOf(victim);
            if (colorOf(p) === color) { swing += v; capturedOn.push(to); } else swing -= v;
        }
        if (promo) swing += (colorOf(p) === color ? 1 : -1) * (VALUE[promo] - VALUE.P);
        const nextEp = typeOf(p) === 'P' && Math.abs((to >> 3) - (from >> 3)) === 2 ? (from + to) >> 1 : -1;
        b = applyMove(b, { from, to, promo }, ep);
        ep = nextEp;
    }
    return { swing, capturedOn };
}

// True when the engine line from b (opponent of `color` to move) wins `minGain` for `color`
// within `plies` plies by capturing on one of `targets` (any square when targets is null).
function engineConfirms(after, b, ep, color, targets, minGain = 100, plies = 6, required = true) {
    if (!after || !Array.isArray(after.pv)) return !required; // no engine data
    const { swing, capturedOn } = pvGains(b, ep, after.pv, color, plies);
    return swing >= minGain && (targets === null || capturedOn.some((s) => targets.includes(s)));
}

// Exact check that `attacker` (to move on b) mates in at most 2 starting with `first`: after it the
// defender is mated, or every defender reply allows a mate in one.
function verifyMateIn2(b, ep, attacker, first) {
    const n = applyMove(b, first, ep), def = other(attacker);
    const nextEp = typeOf(b[first.from]) === 'P' && Math.abs((first.to >> 3) - (first.from >> 3)) === 2 ? (first.from + first.to) >> 1 : -1;
    const replies = legalMoves(n, def, nextEp);
    if (replies.length === 0) return inCheck(n, def);
    return replies.every((r) => {
        const rEp = typeOf(n[r.from]) === 'P' && Math.abs((r.to >> 3) - (r.from >> 3)) === 2 ? (r.from + r.to) >> 1 : -1;
        return matesInOne(applyMove(n, r, nextEp), attacker, rEp).length > 0;
    });
}

const gameToIdx = (mv) => ({ from: idxOf(mv.from), to: idxOf(mv.to), promo: mv.promotionPiece ? String(mv.promotionPiece).toUpperCase() : null });

// Engine mate for `color` (moves) from an analysis result, or null.
function engineMate(analysis, color) {
    if (!analysis || analysis.mate == null) return null;
    const m = color === 'w' ? analysis.mate : -analysis.mate;
    return m > 0 ? m : null;
}

// --- Detectors ---

function motif(kind, by, squares, b, extra) {
    return { motif: kind, by, squares: squares.map(sqName), pieces: squares.map((s) => b[s] || null), ...extra };
}

// Moved piece creates two or more real threats at once: attacks the king and/or pieces it wins
// by exchange (worth more than itself, or undefended), and it cannot be captured profitably.
function detectFork(bA, epA, to, mover, opts) {
    const p = bA[to], opp = other(mover);
    if (!p || typeOf(p) === 'K') return null;
    if (legalCaptureGain(bA, to, opp, epA) > 0) return null; // the forking piece just gets taken
    const targets = [];
    for (const t of attacksFrom(bA, to)) {
        const q = bA[t];
        if (!q || colorOf(q) !== opp) continue;
        if (typeOf(q) === 'K') { targets.push(t); continue; }
        if (valueOf(q) < VALUE.N) continue; // pawns are not fork targets
        if (valueOf(q) > valueOf(p) || see(bA, t, mover, to) >= VALUE.N) targets.push(t);
    }
    if (targets.length < 2) return null;
    // The line must win material; often on another square (the forked piece takes the forker).
    if (!engineConfirms(opts.after, bA, epA, mover, null, 100)) return null;
    return motif('fork', mover, [to, ...targets], bA, {});
}

// Rays from mover's line pieces: [front, behind] opponent pieces on one line.
function lines(b, color, only) {
    const out = [];
    for (let s = 0; s < 64; s++) {
        const p = b[s];
        if (!p || colorOf(p) !== color || !'BRQ'.includes(typeOf(p))) continue;
        if (only && !only(s)) continue;
        const dirs = typeOf(p) === 'R' ? ORTHO : typeOf(p) === 'B' ? DIAG : ORTHO.concat(DIAG);
        for (const [dr, dc] of dirs) {
            let front = -1;
            for (let r = (s >> 3) + dr, c = (s & 7) + dc; inside(r, c); r += dr, c += dc) {
                const q = b[r * 8 + c];
                if (!q) continue;
                if (front < 0) { if (colorOf(q) === color) break; front = r * 8 + c; continue; }
                if (colorOf(q) !== color) out.push({ slider: s, front, behind: r * 8 + c });
                break;
            }
        }
    }
    return out;
}

const lineKey = (l) => `${l.slider}:${l.front}:${l.behind}`;

// Pins (front piece cannot or should not move because of a more valuable piece behind it) and
// skewers (a more valuable front piece must move and exposes the piece behind), new after the move.
function detectPinsAndSkewers(bB, bA, epA, mover, opts) {
    const out = [], opp = other(mover);
    const before = new Set(lines(bB, mover).map(lineKey));
    for (const l of lines(bA, mover)) {
        if (before.has(lineKey(l))) continue;
        const S = bA[l.slider], F = bA[l.front], B = bA[l.behind];
        const vS = valueOf(S), vF = valueOf(F), vB = valueOf(B);
        if (typeOf(F) === 'K') {
            // Skewer through the king: the king must step aside and B falls.
            if (legalCaptureGain(bA, l.slider, opp, epA) > 0) continue;
            if (vB < VALUE.N || (vB <= vS && attackers(bA, l.behind, opp).length > 0)) continue;
            if (!engineConfirms(opts.after, bA, epA, mover, null, 100)) continue;
            out.push(motif('skewer', mover, [l.slider, l.front, l.behind], bA, { absolute: true }));
        } else if (typeOf(B) === 'K' || (vB > vF && vB > vS)) {
            // Pin: absolute (king behind) or relative (more valuable piece behind than both).
            if (vF < VALUE.N && typeOf(B) !== 'K') continue;
            if (typeOf(F) === 'P' && typeOf(B) === 'K') continue; // pinned pawns are rarely worth a word
            if (legalCaptureGain(bA, l.slider, opp, epA) > 0) continue; // the pinner just gets taken
            out.push(motif('pin', mover, [l.slider, l.front, l.behind], bA, { absolute: typeOf(B) === 'K' }));
        } else if (vF > vS && vF > vB && vB >= VALUE.N) {
            // Skewer: valuable front piece attacked by a cheaper piece, something worth taking behind.
            if (legalCaptureGain(bA, l.slider, opp, epA) > 0) continue;
            if (vB <= vS && attackers(bA, l.behind, opp).length > 0) continue;
            if (!engineConfirms(opts.after, bA, epA, mover, null, 100)) continue;
            out.push(motif('skewer', mover, [l.slider, l.front, l.behind], bA, { absolute: false }));
        }
    }
    return out;
}

// The moved piece unmasks a line piece: discovered check, or a discovered attack winning material.
function detectDiscovered(bB, bA, epA, from, to, mover, opts) {
    const out = [], opp = other(mover);
    for (let s = 0; s < 64; s++) {
        const S = bA[s];
        if (!S || colorOf(S) !== mover || !'BRQ'.includes(typeOf(S)) || s === to) continue;
        // Did `from` sit on a line from S, with an opponent piece behind it now attacked?
        const dr = Math.sign((from >> 3) - (s >> 3)), dc = Math.sign((from & 7) - (s & 7));
        const straight = (from >> 3) === (s >> 3) || (from & 7) === (s & 7);
        const diagonal = Math.abs((from >> 3) - (s >> 3)) === Math.abs((from & 7) - (s & 7));
        if (!(straight || diagonal) || (straight && typeOf(S) === 'B') || (diagonal && typeOf(S) === 'R')) continue;
        let blockedBefore = false, target = -1;
        for (let r = (s >> 3) + dr, c = (s & 7) + dc; inside(r, c); r += dr, c += dc) {
            const i = r * 8 + c;
            if (i === from) { blockedBefore = true; continue; }
            if (!blockedBefore && bA[i]) break;
            if (blockedBefore && bA[i]) { target = i; break; }
        }
        if (!blockedBefore || target < 0 || colorOf(bA[target]) !== opp || target === to) continue;
        // The line was blocked by the moving piece (and by nothing else) before.
        const T = bA[target];
        if (typeOf(T) === 'K') {
            out.push(motif('discovered', mover, [s, target, to], bA, { check: true, double: inCheckBy(bA, to, target) }));
        } else if (valueOf(T) >= VALUE.N && see(bA, target, mover, s) >= VALUE.N) {
            // A discovered attack only wins when the moved piece makes a second threat (or the
            // engine line shows the gain): otherwise the target simply steps away.
            const second = inCheck(bA, opp) || attacksFrom(bA, to).some((t) => t !== target &&
                bA[t] && colorOf(bA[t]) === opp && valueOf(bA[t]) >= VALUE.N && see(bA, t, mover, to) >= VALUE.N);
            if (!opts.after && !second) continue;
            if (legalCaptureGain(bA, s, opp, epA) > 0) continue; // the unmasked piece is itself lost
            // The win may come on another square (e.g. the target interposes): any material gain.
            if (!engineConfirms(opts.after, bA, epA, mover, null, 100)) continue;
            out.push(motif('discovered', mover, [s, target, to], bA, { check: false }));
        }
    }
    return out;
}

const inCheckBy = (b, s, kingSq) => attacksFrom(b, s).includes(kingSq);

// Back-rank mate on b (loser to move, already mated): king on its home rank, mated by a rook or
// queen along that rank, its escape squares on the next rank blocked by its own pieces.
function backRankMate(b, loser) {
    const k = kingSquare(b, loser), home = loser === 'w' ? 7 : 0;
    if (k < 0 || (k >> 3) !== home) return null;
    const checkers = attackers(b, k, other(loser));
    if (checkers.length !== 1) return null;
    const ch = checkers[0];
    if ((ch >> 3) !== home || !'RQ'.includes(typeOf(b[ch]))) return null;
    const next = loser === 'w' ? home - 1 : home + 1, kc = k & 7;
    let ownBlockers = 0;
    for (let c = kc - 1; c <= kc + 1; c++) {
        if (!inside(next, c)) continue;
        const q = b[next * 8 + c];
        if (q && colorOf(q) === loser) ownBlockers++;
    }
    return ownBlockers > 0 ? { checker: ch, king: k } : null;
}

// Pieces of `victim` (minor or better) attacked and with no safe square, newly so after the move.
function trapped(b, ep, victim) {
    const out = [], hunter = other(victim);
    for (let s = 0; s < 64; s++) {
        const p = b[s];
        if (!p || colorOf(p) !== victim || valueOf(p) < VALUE.N || typeOf(p) === 'K') continue;
        if (see(b, s, hunter) < VALUE.N - 100) continue; // not actually lost where it stands
        const att = attackers(b, s, hunter);
        if (!att.some((a) => valueOf(b[a]) < valueOf(p))) continue; // defending it would be enough
        // Lost unless some move saves it: moving it to a safe square (or taking something worth
        // the loss), interposing, taking the hunter, or another piece giving check.
        const safe = legalMoves(b, victim, ep).some((m) => {
            const n = applyMove(b, m, ep);
            if (m.from !== s && inCheck(n, hunter)) return true; // another piece's check may save it
            const loc = m.from === s ? m.to : s;
            const won = m.from === s && b[m.to] ? valueOf(b[m.to]) : 0;
            return won - see(n, loc, hunter) >= 0 || see(n, loc, hunter) < VALUE.N - 100;
        });
        if (!safe) out.push(s);
    }
    return out;
}

/**
 * Motifs of `move` (played from stateBefore). stateAfter is optional (computed when omitted).
 * opts: { before, after } ChessAI.analyze() results (optional, see the header).
 */
export function detect(stateBefore, move, stateAfter, opts = {}) {
    try {
        return detectUnsafe(stateBefore, move, stateAfter, opts || {}).map(enrich);
    } catch (e) {
        return [];
    }
}

// Adds square / piece / attacker / target (+ their squares) for templates, see the header.
function enrich(m) {
    const S = m.squares, P = m.pieces;
    const at = (list, i) => (i === null || i >= list.length ? null : list[i]);
    const set = (square, piece, a, t) => Object.assign(m, {
        square: at(S, square), piece: at(P, piece),
        attacker: at(P, a), attackerSquare: at(S, a),
        target: at(P, t), targetSquare: at(S, t),
    });
    switch (m.motif) {
        case 'fork': set(0, 0, 0, 1); break;
        case 'pin': case 'skewer': set(0, 1, 0, 1); m.behind = at(P, 2); m.behindSquare = at(S, 2); break;
        case 'discovered': set(2, 0, 0, 1); break;
        case 'hanging': case 'trappedPiece': set(0, 0, 1, 0); break;
        case 'missedCapture': set(0, 0, 1, 0); break;
        case 'allowsMate': case 'missedMate': set(1, 0, 0, null); break;
        case 'backRank': set(0, 0, 0, 1); break;
        default: set(0, 0, null, null);
    }
    return m;
}

function detectUnsafe(stateBefore, move, stateAfter, opts) {
    const bB = flat(stateBefore), epB = epIndex(stateBefore);
    const from = idxOf(move.from), to = idxOf(move.to);
    const piece = bB[from];
    if (!piece) return [];
    const mover = colorOf(piece), opp = other(mover);
    const promoChar = move.promotionPiece || move.promotion;
    const promo = promoChar ? String(promoChar).toUpperCase() : (move.isPromotion ? 'Q' : null);
    const bA = stateAfter ? flat(stateAfter) : applyMove(bB, { from, to, promo }, epB);
    const epA = stateAfter ? epIndex(stateAfter)
        : (typeOf(piece) === 'P' && Math.abs((to >> 3) - (from >> 3)) === 2 ? (from + to) >> 1 : -1);
    const out = [];

    const matedNow = isMate(bA, opp, epA);

    // missedMate: the mover had a mate and did not play one.
    if (!matedNow) {
        const mates = matesInOne(bB, mover, epB);
        const engineHad = engineMate(opts.before, mover);
        const engineKeeps = engineMate(opts.after, mover);
        if (mates.length > 0) {
            const m = mates[0];
            out.push(motif('missedMate', mover, [m.from, m.to], bB, { mateIn: 1 }));
        } else if (engineHad !== null && engineHad <= 2 && engineKeeps === null && opts.before.bestMove &&
            (mover === 'w' ? 1 : -1) * (opts.after.eval || 0) < 800 &&
            verifyMateIn2(bB, epB, mover, gameToIdx(opts.before.bestMove))) {
            // A forced mate in two (verified exactly), given up for a position that is no longer crushing.
            const bm = opts.before.bestMove;
            out.push(motif('missedMate', mover, [idxOf(bm.from), idxOf(bm.to)], bB, { mateIn: engineHad }));
        }
    }

    // backRank: this move mates on the back rank.
    if (matedNow) {
        const br = backRankMate(bA, opp);
        if (br) out.push(motif('backRank', mover, [br.checker, br.king], bA, { mate: true }));
    }

    if (!matedNow) {
        // allowsMate: the opponent now mates (in one by search; longer when the engine says so).
        const mates = matesInOne(bA, opp, epA);
        if (mates.length > 0) {
            const m = mates[0];
            out.push(motif('allowsMate', opp, [m.from, m.to], bA, { mateIn: 1 }));
            const after = applyMove(bA, m, epA);
            const br = backRankMate(after, mover);
            if (br) out.push(motif('backRank', opp, [m.to, br.king], after, { mate: false, threat: true }));
        } else {
            const em = engineMate(opts.after, opp);
            if (em !== null && em <= 2 && opts.after.bestMove && verifyMateIn2(bA, epA, opp, gameToIdx(opts.after.bestMove))) {
                const bm = opts.after.bestMove;
                out.push(motif('allowsMate', opp, [idxOf(bm.from), idxOf(bm.to)], bA, { mateIn: em }));
            }
        }

        // hanging: the mover's pieces the opponent can now win (new: not hanging before the move).
        const hungBefore = new Set(hangingPieces({ board: toRows(bB), enPassantTarget: null }, mover).map((h) => h.square + h.piece));
        for (const h of hangingPieces({ board: toRows(bA), enPassantTarget: epA >= 0 ? { row: epA >> 3, col: epA & 7 } : null }, mover)) {
            if (h.gain < VALUE.N - 100 && valueOf(h.piece) < VALUE.N) continue; // ignore loose pawns
            const s = idxOf(parse(h.square));
            if (opts.after && opts.after.pv && !pvGains(bA, epA, opts.after.pv, opp, 4).capturedOn.includes(s)) continue;
            out.push(motif('hanging', opp, [s, ...h.attackers.map((x) => idxOf(parse(x)))], bA, { gain: h.gain, moved: s === to, new: !hungBefore.has(h.square + h.piece) }));
        }

        const fork = detectFork(bA, epA, to, mover, opts);
        if (fork) out.push(fork);
        out.push(...detectPinsAndSkewers(bB, bA, epA, mover, opts));
        out.push(...detectDiscovered(bB, bA, epA, from, to, mover, opts));

        // trappedPiece: an opponent piece that was not trapped before is now (not while in check:
        // then every non-evasion is illegal and "no safe square" means nothing).
        const wasTrapped = new Set(trapped(bB, epB, opp).map((s) => bB[s] + s));
        for (const s of inCheck(bA, opp) ? [] : trapped(bA, epA, opp)) {
            if (wasTrapped.has(bA[s] + s)) continue;
            // The engine may let it run first and win it elsewhere: any material gain counts.
            if (!engineConfirms(opts.after, bA, epA, mover, null, valueOf(bA[s]) - 100, 8)) continue;
            out.push(motif('trappedPiece', mover, [s, ...attackers(bA, s, mover)], bA, {}));
        }

        // missedCapture: a capture winning a piece was available and not taken.
        const missed = missedCapture(bB, epB, bA, from, to, mover, opts);
        if (missed) out.push(missed);
    }
    return out;
}

function missedCapture(bB, epB, bA, from, to, mover, opts) {
    if (inCheck(bB, mover)) return null;
    let best = null;
    for (const m of legalMoves(bB, mover, epB)) {
        if (!bB[m.to]) continue;
        const gain = see(bB, m.to, mover, m.from);
        if (gain >= VALUE.N - 100 && (!best || gain > best.gain)) best = { m, gain };
    }
    if (!best || best.m.to === to) return null; // took it (or something on that square)
    const playedGain = bB[to] ? see(bB, to, mover, from) : 0;
    if (playedGain >= best.gain) return null; // took something at least as good
    if (!(opts.before && opts.before.bestMove)) return null; // engine-only (see the header)
    {
        // The engine must agree: its best move is that capture and the played move is clearly worse.
        const bm = opts.before.bestMove;
        if (idxOf(bm.to) !== best.m.to) return null;
        if (opts.after && typeof opts.after.eval === 'number' && typeof opts.before.eval === 'number') {
            const sgn = mover === 'w' ? 1 : -1;
            if (sgn * (opts.before.eval - opts.after.eval) < 100) return null;
        }
    }
    return motif('missedCapture', mover, [best.m.to, best.m.from], bB, { gain: best.gain });
}

function toRows(b) {
    const rows = [];
    for (let r = 0; r < 8; r++) rows.push(b.slice(r * 8, r * 8 + 8));
    return rows;
}

function parse(n) { return { row: 8 - Number(n[1]), col: n.charCodeAt(0) - 97 }; }

// Exposed for tests and the coach (e.g. "is this side mated", SEE checks).
export const _internal = { flat, legalMoves, applyMove, matesInOne, see, attackers, isMate, backRankMate, trapped, VALUE };

// --- END OF FILE battle3d/tactics.js ---
