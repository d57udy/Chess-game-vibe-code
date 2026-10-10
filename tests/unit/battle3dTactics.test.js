'use strict';
// v6 tactics.js motif detectors: recall on a fixture set of known motifs (tests/fixtures/motifs.json)
// and precision: a negative position reporting anything is a failure, and a positive case may not
// report motifs from the forbidden list. Plus a random-playout precision sweep for 'hanging', the
// hangingPieces() contract, robustness on garbage input, and purity (inputs not mutated).
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, square } = require('../helpers/loadEngine');
const { loadBattle3dRules, LEGAL_UCI_EXPR, rng } = require('../helpers/loadBattle3dRules');

const FILE = path.join(ROOT, 'battle3d', 'tactics.js');
const have = fs.existsSync(FILE);
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'motifs.json'), 'utf8'));
let T;

const STATE = '({ board: board.map(r => [...r]), currentPlayer, castlingRights: JSON.parse(JSON.stringify(castlingRights)), enPassantTarget, halfmoveClock, fullmoveNumber })';
// stateBefore, game move and stateAfter for a FEN + long-algebraic move, via rules.js
function position(fen, uciMove) {
    const E = loadBattle3dRules();
    E.run(`battle3dLoadFen(${JSON.stringify(fen)})`);
    const before = E.get(STATE);
    const move = { from: square(uciMove.slice(0, 2)), to: square(uciMove.slice(2, 4)), promotionPiece: uciMove[4] ? uciMove[4].toUpperCase() : null };
    E.apply(uciMove);
    const after = E.get(STATE);
    return { before, move, after, E };
}
// squares come back as algebraic names ('d5'); accept {row,col} too
const sqName = (s) => (typeof s === 'string' ? s : String.fromCharCode(97 + s.col) + (8 - s.row));
// Engine analyses for opts.before / opts.after (tactics.js reports fork, skewer, trapped and
// non-check discovered attacks only when the engine line confirms the gain, as the coach passes them).
const { loadEngine } = require('../helpers/loadEngine');
const AE = loadEngine({ globals: { performance: { now: () => 0 } } });
function analysis(state) { AE.set('__s', state); return AE.get('ChessAI.analyze(__s, { nodes: 60000, multiPv: 3 }, [])'); }
const optsFor = (before, after) => ({ before: analysis(before), after: analysis(after) });
const kinds = (res) => [...new Set((res || []).map((m) => m.motif))].sort();

describe('battle3d tactics.js (v6)', { skip: !have && 'tactics.js not present' }, () => {
    before(async () => { T = await import(pathToFileURL(FILE).href); });

    test('API: detect and hangingPieces exported', () => {
        assert.equal(typeof T.detect, 'function');
        assert.equal(typeof T.hangingPieces, 'function');
    });

    for (const c of FIX.cases) {
        const negative = c.expect.length === 0;
        test(`${negative ? 'precision' : 'recall'}: ${c.name}`, () => {
            const { before, move, after } = position(c.fen, c.move);
            const res = T.detect(before, move, after, optsFor(before, after));
            assert.ok(Array.isArray(res), 'array');
            const got = kinds(res);
            if (negative) assert.deepEqual(got, [], `false positive(s) on a quiet move: ${JSON.stringify(res)}`);
            for (const want of c.expect) assert.ok(got.includes(want), `expected ${want}, got ${JSON.stringify(got)}`);
            for (const bad of c.forbid || []) assert.ok(!got.includes(bad), `forbidden ${bad}`);
            for (const m of res) {
                assert.ok(['w', 'b'].includes(m.by), `by: ${m.by}`);
                assert.ok(Array.isArray(m.squares) && m.squares.every((s) => /^[a-h][1-8]$/.test(s)), `squares ${m.squares}`);
            }
        });
    }

    test('motif details: fork names both targets; pin/skewer name the line; by = the right side', () => {
        let r = position('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
        const fork = T.detect(r.before, r.move, r.after, optsFor(r.before, r.after)).find((m) => m.motif === 'fork');
        assert.equal(fork.by, 'w');
        assert.ok(fork.squares.includes('c7') && fork.squares.includes('e8') && fork.squares.includes('a8'), JSON.stringify(fork));
        r = position('rnbqkbnr/pppp1ppp/8/4p3/3PP3/2N5/PPP2PPP/R1BQKBNR b KQkq d3 0 2', 'f8b4');
        const pin = T.detect(r.before, r.move, r.after, optsFor(r.before, r.after)).find((m) => m.motif === 'pin');
        assert.equal(pin.by, 'b');
        assert.ok(pin.squares.includes('c3') && pin.squares.includes('e1'), JSON.stringify(pin));
        r = position('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'f1a6');
        const hang = T.detect(r.before, r.move, r.after, optsFor(r.before, r.after)).find((m) => m.motif === 'hanging');
        assert.equal(hang.by, 'b', 'hanging favours the opponent of the mover');
        assert.ok(hang.squares.includes('a6'));
        r = position('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1', 'e1f1');
        const miss = T.detect(r.before, r.move, r.after, optsFor(r.before, r.after)).find((m) => m.motif === 'missedCapture');
        assert.equal(miss.by, 'w', 'missedCapture favours the mover');
        assert.ok(miss.squares.includes('d5'));
    });

    test('hangingPieces: free pieces listed with attackers/defenders; defended pieces are not', () => {
        const E = loadBattle3dRules();
        E.run('battle3dLoadFen("4k3/8/8/3q4/8/8/3R4/4K3 b - - 0 1")');
        let h = T.hangingPieces(E.get(STATE), 'b');
        assert.equal(h.length, 1, JSON.stringify(h));
        assert.equal(sqName(h[0].square), 'd5');
        assert.equal(h[0].piece, 'q');
        assert.deepEqual(h[0].attackers, ['d2'], 'attacker squares');
        assert.deepEqual(h[0].defenders, []);
        assert.equal(h[0].gain, 900);
        E.run('battle3dLoadFen("4k3/4p3/8/3q4/8/8/3R4/4K3 b - - 0 1")'); // queen defended by e... no: e7 pawn does not defend d5
        E.run('battle3dLoadFen("4k3/8/4p3/3q4/8/8/3R4/4K3 b - - 0 1")'); // e6 pawn defends d5, but a rook for a queen still wins
        h = T.hangingPieces(E.get(STATE), 'b');
        assert.ok(h.some((x) => x.piece === 'q'), 'queen attacked by a rook is en prise even when defended (SEE)');
        E.run('battle3dLoadFen("4k3/8/4p3/3n4/8/8/3R4/4K3 b - - 0 1")'); // knight defended by a pawn, attacked by a rook
        h = T.hangingPieces(E.get(STATE), 'b');
        assert.deepEqual(h, [], 'defended knight attacked by a rook is not hanging');
        E.run('battle3dLoadFen(INITIAL_BOARD_FEN)');
        assert.deepEqual(T.hangingPieces(E.get(STATE), 'w'), []);
        assert.deepEqual(T.hangingPieces(E.get(STATE), 'b'), []);
    });

    test('precision sweep: in quiet random playout moves, "hanging" is only reported when the piece really can be won', () => {
        const rand = rng(606);
        const E = loadBattle3dRules();
        let checked = 0, reported = 0;
        const wrong = [];
        for (let game = 0; game < 6; game++) {
            E.run('battle3dNewGame()');
            for (let ply = 0; ply < 40 && !E.get('battle3dGameStatus()').over; ply++) {
                const legal = E.get(LEGAL_UCI_EXPR);
                const mv = legal[Math.floor(rand() * legal.length)];
                const before = E.get(STATE);
                const move = { from: square(mv.slice(0, 2)), to: square(mv.slice(2, 4)), promotionPiece: mv[4] ? mv[4].toUpperCase() : null };
                E.apply(mv);
                const after = E.get(STATE);
                const res = T.detect(before, move, after);
                checked++;
                for (const m of res.filter((x) => x.motif === 'hanging')) {
                    reported++;
                    // verify: the opponent has a capture on that square that wins material by SEE (per hangingPieces)
                    const list = T.hangingPieces(after, before.currentPlayer);
                    if (!list.some((x) => sqName(x.square) === m.squares[0])) wrong.push(`${mv}: ${JSON.stringify(m)}`);
                }
            }
        }
        assert.ok(checked > 150, `checked ${checked}`);
        assert.deepEqual(wrong, [], `hanging reports not backed by hangingPieces (${reported} reports)`);
    });

    test('without engine analysis, fork / skewer are not claimed from geometry alone (precision first)', () => {
        for (const [fen, mv, k] of [['r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7', 'fork'], ['4k2q/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8', 'skewer']]) {
            const r = position(fen, mv);
            assert.ok(!kinds(T.detect(r.before, r.move, r.after)).includes(k), `${k} needs opts.after`);
        }
    });

    test('precision vs the engine: a strong engine move never "allows mate" or "misses mate" (60 positions)', () => {
        const { loadEngine } = require('../helpers/loadEngine');
        const X = loadEngine({ globals: { performance: { now: () => 0 } } });
        const rand = rng(42);
        const E = loadBattle3dRules();
        const bad = [];
        let n = 0;
        for (let game = 0; game < 12 && n < 60; game++) {
            E.run('battle3dNewGame()');
            for (let ply = 0; ply < 60 && n < 60; ply++) {
                if (E.get('battle3dGameStatus()').over) break;
                const legal = E.get(LEGAL_UCI_EXPR);
                // mostly random play to reach varied positions; every 6th ply ask the engine
                if (ply % 6 !== 5) { E.apply(legal[Math.floor(rand() * legal.length)]); continue; }
                const before = E.get(STATE);
                X.set('__s', before);
                const best = X.get('ChessAI.searchWithParams(__s, { nodeBudget: 40000, maxDepth: 64, seed: 1 }, [])');
                if (!best) break;
                const mv = String.fromCharCode(97 + best.from.col) + (8 - best.from.row) + String.fromCharCode(97 + best.to.col) + (8 - best.to.row) + (best.promotionPiece ? best.promotionPiece.toLowerCase() : '');
                const move = { from: best.from, to: best.to, promotionPiece: best.promotionPiece };
                E.apply(mv);
                const res = kinds(T.detect(before, move, E.get(STATE)));
                n++;
                for (const k of ['allowsMate', 'missedMate']) if (res.includes(k)) bad.push(`${k} after engine move ${mv}`);
            }
        }
        assert.ok(n >= 40, `checked ${n}`);
        assert.deepEqual(bad, []);
    });

    test('robust and pure: garbage input returns [] without throwing; inputs are not mutated', () => {
        for (const args of [[null, null, null], [{}, {}, {}], [{ board: [] }, { from: { row: 9, col: 9 }, to: { row: 0, col: 0 } }]]) {
            let r;
            assert.doesNotThrow(() => { r = T.detect(...args); }, JSON.stringify(args));
            assert.deepEqual(r, []);
        }
        const { before, move, after } = position('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
        const snap = JSON.stringify([before, move, after]);
        T.detect(before, move, after);
        T.detect(before, move); // stateAfter optional
        T.hangingPieces(after, 'b');
        assert.equal(JSON.stringify([before, move, after]), snap, 'no mutation');
        assert.deepEqual(kinds(T.detect(before, move)), kinds(T.detect(before, move, after)), 'stateAfter optional and consistent');
    });
});
