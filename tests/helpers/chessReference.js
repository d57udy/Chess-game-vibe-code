// Independent rules reference for the engine tests: chess.js (pinned devDependency, test-only; the
// site has no build step and never loads it), plus the probes that read the game's own rule
// implementations in a comparable form:
//   - gameLogic.js generator + battle3d/rules.js battle3dApplyMove (what the 2D and 3D views play),
//   - the ChessAI generator and make/unmake in aiPlayer.js (what the AI searches with),
//   - battle3d/tactics.js legalMoves/applyMove (what the coach detects motifs with).
//
// FEN en passant convention: the game writes the en passant square after every double pawn push
// (the FEN standard); chess.js 1.x prints it only when an en passant capture is legal. The
// comparison does not go through chess.js for that field: the expected square is derived from the
// reference move itself (double push -> the skipped square, anything else -> '-'), so an en
// passant target that is set, kept or cleared wrongly still fails the comparison.
'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Chess } = require('chess.js');
const { loadEngine, source, ROOT } = require('./loadEngine');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Start positions for playouts that reach the special moves quickly
const EP_RICH = '4k3/p1p1p1p1/8/1P1P1P1P/1p1p1p1p/8/P1P1P1P1/4K3 w - - 0 1'; // most double pushes offer en passant
const PROMOTION_RACE = 'r3k2r/1P4P1/8/8/8/8/1p4p1/R3K2R w KQkq - 0 1';       // promotions (also by capture) and castling
const PLAYOUT_STARTS = [
    START_FEN,
    EP_RICH,
    'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', // rooks and pawns: castling, en passant, promotions
    PROMOTION_RACE,
    '4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1',        // pawns only
];
const sq = (name) => ({ row: 8 - Number(name[1]), col: name.charCodeAt(0) - 97 });
const sqName = (row, col) => String.fromCharCode(97 + col) + (8 - row);
const pieceChar = (type, color) => (color === 'w' ? type.toUpperCase() : type);

// --- Reference side -------------------------------------------------------------------------

// One chess.js verbose move in the shapes the game uses.
function refMove(m) {
    const double = m.flags.includes('b');
    const enPassant = m.flags.includes('e');
    const kside = m.flags.includes('k'), qside = m.flags.includes('q');
    const after = m.after.split(' ');
    // Game convention for the en passant field (see the header)
    after[3] = double ? m.from[0] + (m.color === 'w' ? '3' : '6') : '-';
    const rank = m.from[1];
    return {
        uci: m.from + m.to + (m.promotion || ''),
        from: m.from, to: m.to, color: m.color,
        piece: pieceChar(m.piece, m.color),
        san: m.san,
        promotion: m.promotion ? m.promotion.toUpperCase() : null,
        double, enPassant,
        castling: kside ? { rookFrom: 'h' + rank, rookTo: 'f' + rank } : qside ? { rookFrom: 'a' + rank, rookTo: 'd' + rank } : null,
        captured: m.captured ? pieceChar(m.captured, m.color === 'w' ? 'b' : 'w') : null,
        // An en passant victim stands on the capturer's rank, on the target file
        capturedSquare: m.captured ? (enPassant ? m.to[0] + m.from[1] : m.to) : null,
        givesCheck: /[+#]$/.test(m.san),
        isMate: m.san.endsWith('#'),
        fen: after.join(' '),
    };
}

// All legal moves of the position, keyed by long algebraic move (promotions: 4 entries).
function refMoves(chess) {
    const out = new Map();
    for (const m of chess.moves({ verbose: true })) { const r = refMove(m); out.set(r.uci, r); }
    return out;
}

// Repetition key by the FIDE definition (Article 9.2): placement, side to move, castling rights and
// the en passant square only when the capture is actually legal (which is what chess.js prints).
const refRepetitionKey = (chess) => chess.fen().split(' ').slice(0, 4).join(' ');

// Rule flags of the reference position. `keys` are the refRepetitionKey() values of the game so
// far including the current position (omit for a position without history).
function refStatus(chess, keys) {
    const key = refRepetitionKey(chess);
    return {
        inCheck: chess.isCheck(),
        end: chess.isCheckmate() ? 'checkmate' : chess.isStalemate() ? 'stalemate' : null,
        fifty: chess.isDrawByFiftyMoves(),
        threefold: keys ? keys.filter((k) => k === key).length >= 3 : false,
        insufficient: chess.isInsufficientMaterial(),
    };
}

// The result string battle3dGameStatus() must report for refStatus() flags (same precedence).
function refResult(s) {
    return s.end || (s.fifty ? 'fifty-move' : s.threefold ? 'threefold' : s.insufficient ? 'insufficient' : null);
}

// --- Game side: gameLogic.js + battle3d/rules.js ----------------------------------------------

// Runs inside the vm context. __probe() describes the current position and, for every legal move
// (promotions expanded), the MoveEvent and position battle3dApplyMove produces; each move is undone
// again and the undo is verified. __position() is the cheap version: rule flags and the generator's
// move list without applying anything.
const GAME_PROBE = `
function __sqn(r, c) { return String.fromCharCode(97 + c) + (8 - r); }
function __state() {
    return {
        fen: battle3dFen(),
        ep: enPassantTarget ? __sqn(enPassantTarget.row, enPassantTarget.col) : null,
        end: checkGameEndCondition(),
        inCheck: isKingInCheck(currentPlayer),
        fifty: halfmoveClock >= 100,
        threefold: checkThreefoldRepetition(),
        insufficient: hasInsufficientMaterial(),
        result: battle3dGameStatus().result,
    };
}
function __legal() {
    return getAllLegalMoves(currentPlayer).flatMap(m => {
        const s = __sqn(m.from.row, m.from.col) + __sqn(m.to.row, m.to.col);
        return (m.isPromotion ? ['q', 'r', 'b', 'n'] : ['']).map(p => ({ uci: s + p, piece: m.piece,
            isEnPassant: m.isEnPassant, isCastling: m.isCastling, isPromotion: m.isPromotion, from: m.from, to: m.to }));
    });
}
function __position() { return JSON.stringify({ ...__state(), moves: __legal() }); }
function __probe() {
    const out = __state();
    const before = out.fen, length = gameHistory.length, index = currentMoveIndex;
    const snapshot = JSON.stringify(gameHistory[currentMoveIndex]);
    out.moves = __legal().map(m => {
        const ev = battle3dApplyMove(m.from, m.to, m.uci[4] ? m.uci[4].toUpperCase() : null);
        const rec = { uci: m.uci, piece: m.piece, isEnPassant: m.isEnPassant, isCastling: m.isCastling, isPromotion: m.isPromotion,
            ev, fen: battle3dFen(), ep: enPassantTarget ? __sqn(enPassantTarget.row, enPassantTarget.col) : null };
        if (battle3dUndo(1) !== 1) throw new Error('undo failed after ' + m.uci);
        if (battle3dFen() !== before || gameHistory.length !== length || currentMoveIndex !== index ||
            JSON.stringify(gameHistory[currentMoveIndex]) !== snapshot) {
            throw new Error('undo of ' + m.uci + ' did not restore ' + before + ' (got ' + battle3dFen() + ')');
        }
        return rec;
    });
    return JSON.stringify(out);
}`;

// gameLogic.js + aiPlayer.js (+ aiClient.js) + battle3d/rules.js in one vm context, like index.html.
function loadGame(options = {}) {
    const E = loadEngine(options);
    vm.runInContext(source('battle3d/rules.js'), E.ctx, { filename: 'battle3d/rules.js' });
    E.run(GAME_PROBE);
    E.load = (fen) => { E.set('__fen', fen); E.run('battle3dLoadFen(__fen)'); };
    E.newGame = () => E.run('battle3dNewGame()');
    E.probe = () => JSON.parse(E.run('__probe()'));
    // Like probe() without applying the moves: rule flags and the generator's move list only
    E.position = () => JSON.parse(E.run('__position()'));
    E.undo = (plies = 1) => E.run(`battle3dUndo(${plies})`);
    E.state = () => E.get('__state()');
    E.legal = () => E.get('__legal()');
    E.apply = (uci) => {
        const f = sq(uci.slice(0, 2)), t = sq(uci.slice(2, 4));
        return E.get(`battle3dApplyMove({ row: ${f.row}, col: ${f.col} }, { row: ${t.row}, col: ${t.col} }, ${uci[4] ? `'${uci[4].toUpperCase()}'` : 'null'})`);
    };
    return E;
}

// --- Game side: the ChessAI generator (aiPlayer.js) ---------------------------------------------

// Runs inside a vm context of its own (writeToGlobals() overwrites the gameLogic.js globals).
// For the position in the globals: every engine-legal move with its flags, the position after
// makeMove, and whether unmakeMove restored position and hash.
const AI_PROBE = `
function __sqn(r, c) { return String.fromCharCode(97 + c) + (8 - r); }
function __aiFen() {
    ChessAI.writeToGlobals();
    return getBoardPositionString({ board, currentPlayer, castlingRights, enPassantTarget }) + ' ' + halfmoveClock + ' ' + fullmoveNumber;
}
function __aiProbe() {
    if (!ChessAI.loadFromGlobals()) return 'null';
    const before = __aiFen(), evalBefore = ChessAI.evaluateWhite();
    const moves = ChessAI.legalMoves().map(m => {
        const g = ChessAI.toGameMove(m);
        const uci = __sqn(g.from.row, g.from.col) + __sqn(g.to.row, g.to.col) + (g.promotionPiece ? g.promotionPiece.toLowerCase() : '');
        ChessAI.makeMove(m);
        const fen = __aiFen(), hashOk = ChessAI.hashIsConsistent();
        ChessAI.unmakeMove();
        const restored = __aiFen() === before && ChessAI.hashIsConsistent() && ChessAI.evaluateWhite() === evalBefore;
        return { uci, piece: g.piece, isEnPassant: g.isEnPassant, isCastling: g.isCastling, isPromotion: g.isPromotion, fen, hashOk, restored };
    });
    return JSON.stringify({ fen: before, moves });
}`;

function loadAi(options = {}) {
    const E = loadEngine(options);
    E.run(AI_PROBE);
    // Probe of a FEN in game convention (the engine reads it through parseFen + loadFromGlobals)
    E.probe = (fen) => { E.fen(fen); return JSON.parse(E.run('__aiProbe()')); };
    return E;
}

// --- Game side: battle3d/tactics.js --------------------------------------------------------------

let tacticsModule = null;
async function loadTactics() {
    if (!tacticsModule) tacticsModule = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'tactics.js')).href);
    return tacticsModule;
}

// --- Comparisons ------------------------------------------------------------------------------

const sorted = (it) => [...it].sort();

// Compares one probed game position (E.probe()) with the reference position: legal move set, move
// flags, MoveEvent, SAN and the resulting FEN of every legal move, and the position's rule flags.
// A position read with E.position() skips the per-move part (MoveEvent, SAN, resulting FEN).
function compareGamePosition(probe, chess, keys, at, ref = refMoves(chess)) {
    assert.deepEqual(sorted(probe.moves.map((m) => m.uci)), sorted(ref.keys()), `legal moves, ${at}`);
    for (const g of probe.moves) {
        const r = ref.get(g.uci), where = `${at} move ${g.uci}`;
        assert.equal(g.piece, r.piece, `moving piece, ${where}`);
        assert.equal(g.isEnPassant, r.enPassant, `generator isEnPassant, ${where}`);
        assert.equal(g.isCastling, !!r.castling, `generator isCastling, ${where}`);
        assert.equal(g.isPromotion, !!r.promotion, `generator isPromotion, ${where}`);
        if (!g.ev) continue;
        assert.equal(g.fen, r.fen, `position after, ${where}`);
        assert.equal(g.ep, r.double ? r.from[0] + (r.color === 'w' ? '3' : '6') : null, `en passant target after, ${where}`);
        const ev = g.ev;
        assert.equal(ev.notation, r.san, `SAN, ${where}`);
        assert.equal(ev.color, r.color, `event color, ${where}`);
        assert.equal(ev.piece, r.piece, `event piece, ${where}`);
        assert.deepEqual([sqName(ev.from.row, ev.from.col), sqName(ev.to.row, ev.to.col)], [r.from, r.to], `event squares, ${where}`);
        assert.equal(ev.enPassant, r.enPassant, `event enPassant, ${where}`);
        assert.equal(ev.promotion, r.promotion, `event promotion, ${where}`);
        assert.equal(ev.givesCheck, r.givesCheck, `event givesCheck, ${where}`);
        assert.equal(ev.isMate, r.isMate, `event isMate, ${where}`);
        assert.deepEqual(ev.captured && { piece: ev.captured.piece, square: sqName(ev.captured.square.row, ev.captured.square.col) },
            r.captured && { piece: r.captured, square: r.capturedSquare }, `captured piece and square, ${where}`);
        assert.deepEqual(ev.castling && { rookFrom: sqName(ev.castling.rookFrom.row, ev.castling.rookFrom.col), rookTo: sqName(ev.castling.rookTo.row, ev.castling.rookTo.col) },
            r.castling, `castling rook squares, ${where}`);
    }
    compareGameStatus(probe, chess, keys, at);
    return ref;
}

function compareGameStatus(state, chess, keys, at) {
    const s = refStatus(chess, keys);
    assert.equal(state.inCheck, s.inCheck, `in check, ${at}`);
    assert.equal(state.end, s.end, `checkmate/stalemate, ${at}`);
    assert.equal(state.fifty, s.fifty, `50-move rule, ${at}`);
    assert.equal(state.threefold, s.threefold, `threefold repetition, ${at}`);
    assert.equal(state.insufficient, s.insufficient, `insufficient material, ${at}`);
    assert.equal(state.result, refResult(s), `game result, ${at}`);
}

// Compares the ChessAI generator and make/unmake (A.probe(fen)) with the reference position.
function compareAiPosition(aiProbe, chess, at, ref = refMoves(chess)) {
    assert.ok(aiProbe, `engine could not load, ${at}`);
    assert.deepEqual(sorted(aiProbe.moves.map((m) => m.uci)), sorted(ref.keys()), `engine legal moves, ${at}`);
    for (const g of aiProbe.moves) {
        const r = ref.get(g.uci), where = `${at} engine move ${g.uci}`;
        assert.equal(g.piece, r.piece, `moving piece, ${where}`);
        assert.equal(g.isEnPassant, r.enPassant, `isEnPassant, ${where}`);
        assert.equal(g.isCastling, !!r.castling, `isCastling, ${where}`);
        assert.equal(g.isPromotion, !!r.promotion, `isPromotion, ${where}`);
        assert.equal(g.fen, r.fen, `position after makeMove, ${where}`);
        assert.ok(g.hashOk, `incremental hash after makeMove, ${where}`);
        assert.ok(g.restored, `unmakeMove restores position, hash and eval, ${where}`);
    }
}

// Compares tactics.js legalMoves/applyMove with the reference. tactics.js leaves out castling and
// generates promotions to queen and knight only (documented there), so those are filtered.
function compareTacticsPosition(T, fen, chess, at, ref = refMoves(chess)) {
    const tokens = fen.split(' ');
    const board = tokens[0].split('/').map((row) => [...row].flatMap((ch) => (ch >= '1' && ch <= '8' ? Array(Number(ch)).fill(null) : [ch])));
    const ep = tokens[3] === '-' ? -1 : sq(tokens[3]).row * 8 + sq(tokens[3]).col;
    const b = T._internal.flat({ board });
    const expected = [...ref.values()].filter((r) => !r.castling && (!r.promotion || r.promotion === 'Q' || r.promotion === 'N'));
    const idx = (s) => sqName(s >> 3, s & 7);
    const moves = T._internal.legalMoves(b, tokens[1], ep);
    assert.deepEqual(sorted(moves.map((m) => idx(m.from) + idx(m.to) + (m.promo ? m.promo.toLowerCase() : ''))), sorted(expected.map((r) => r.uci)), `tactics.js legal moves, ${at}`);
    for (const m of moves) {
        const uci = idx(m.from) + idx(m.to) + (m.promo ? m.promo.toLowerCase() : '');
        const rows = [];
        const n = T._internal.applyMove(b, m, ep);
        for (let r = 0; r < 8; r++) {
            let row = '', empty = 0;
            for (let c = 0; c < 8; c++) {
                const p = n[r * 8 + c];
                if (p) { row += (empty || '') + p; empty = 0; } else empty++;
            }
            rows.push(row + (empty || ''));
        }
        assert.equal(rows.join('/'), ref.get(uci).fen.split(' ')[0], `tactics.js board after ${uci}, ${at}`);
    }
}

// Small deterministic PRNG (mulberry32).
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Seeded playouts through battle3dApplyMove with chess.js alongside. Every ply compares the game
// position (legal moves, generator flags, rule flags, FEN), the ChessAI generator and tactics.js with
// the reference; every `fullEvery`-th ply and every ply that offers en passant, castling or a
// promotion also applies each legal move (MoveEvent, SAN, resulting FEN, undo). Special moves and
// captures are chosen more often than a uniform pick would, and now and then a few plies are taken
// back, so en passant, castling rights, clocks and repetition history are exercised through undo.
// Throws an AssertionError on the first difference; returns coverage statistics.
function differentialPlayouts({ games, plies: maxPlies, seed, fullEvery = 1, starts = [START_FEN], tactics = null, game = loadGame(), ai = loadAi() }) {
    const rand = rng(seed);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const stats = { plies: 0, positions: 0, fullProbes: 0, undos: 0, enPassant: 0, enPassantOffered: 0, castles: 0, promotions: 0, captures: 0, results: {} };
    for (let g = 0; g < games; g++) {
        const start = starts[g % starts.length];
        game.load(start);
        const chess = new Chess(start);
        const keys = [refRepetitionKey(chess)];
        const fens = [start]; // expected game FEN per ply
        for (let ply = 0; ply < maxPlies; ply++) {
            const at = `seed ${seed} game ${g} ply ${ply} (${fens[fens.length - 1]})`;
            const ref = refMoves(chess);
            const moves = [...ref.values()];
            const special = moves.filter((m) => m.enPassant || m.castling || m.promotion);
            const full = ply % fullEvery === 0 || special.length > 0;
            const position = full ? game.probe() : game.position();
            assert.equal(position.fen, fens[fens.length - 1], `position, ${at}`);
            compareGamePosition(position, chess, keys, at, ref);
            compareAiPosition(ai.probe(position.fen), chess, at, ref);
            if (tactics) compareTacticsPosition(tactics, position.fen, chess, at, ref);
            stats.positions++;
            if (full) stats.fullProbes++;
            if (moves.some((m) => m.enPassant)) stats.enPassantOffered++;

            const result = refResult(refStatus(chess, keys));
            if (result) { stats.results[result] = (stats.results[result] || 0) + 1; break; }
            if (keys.length > 3 && rand() < 0.04) { // take back 1 to 3 plies and go another way
                const back = 1 + Math.floor(rand() * 3);
                assert.equal(game.undo(back), back, `undo ${back}, ${at}`);
                for (let i = 0; i < back; i++) { chess.undo(); keys.pop(); fens.pop(); }
                stats.undos++;
                continue;
            }
            const captures = moves.filter((m) => m.captured);
            // Double pushes that land beside an enemy pawn: the next ply is offered en passant
            const setups = moves.filter((m) => m.double && [-1, 1].some((d) => {
                const neighbour = chess.get(String.fromCharCode(m.to.charCodeAt(0) + d) + m.to[1]);
                return neighbour && neighbour.type === 'p' && neighbour.color !== m.color;
            }));
            const r = rand();
            const mv = special.length && r < 0.5 ? pick(special) : setups.length && r < 0.75 ? pick(setups)
                : captures.length && r < 0.85 ? pick(captures) : pick(moves);
            game.apply(mv.uci);
            chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion ? mv.promotion.toLowerCase() : undefined });
            keys.push(refRepetitionKey(chess));
            fens.push(mv.fen);
            stats.plies++;
            if (mv.enPassant) stats.enPassant++;
            if (mv.castling) stats.castles++;
            if (mv.promotion) stats.promotions++;
            if (mv.captured) stats.captures++;
        }
        if (!refResult(refStatus(chess, keys))) stats.results.unfinished = (stats.results.unfinished || 0) + 1;
    }
    return stats;
}

module.exports = {
    differentialPlayouts,
    Chess, START_FEN, EP_RICH, PROMOTION_RACE, PLAYOUT_STARTS, sq, sqName, rng,
    refMove, refMoves, refStatus, refResult, refRepetitionKey,
    loadGame, loadAi, loadTactics,
    compareGamePosition, compareGameStatus, compareAiPosition, compareTacticsPosition,
};
