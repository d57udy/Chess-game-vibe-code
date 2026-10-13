// The rules conformance tests, written once and run through each view adapter (rulesUiDriver.js)
// with the scenario tables of rulesUiScenarios.js:
//   defineTableChecks()        the tables against the reference alone (no view involved)
//   defineRulesUiSuite(...)    offered moves, executed special moves, game end and draws, undo,
//                              human vs AI with supplied answers; `slow` widens every part
//   playout(...)               one seeded random game through one or more views in lockstep
'use strict';
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { rng } = require('./chessReference');
const {
    createReference, assertPosition, assertStatus, assertOffers, assertInertClicks, stateFen, moveObject, ALL_SQUARES,
} = require('./rulesUiDriver');
const S = require('./rulesUiScenarios');

const withMirrors = (list, all) => list.flatMap((e) => (e.fen && (all || e.both) ? [e, S.mirrorEntry(e)] : [e]));
// Crowded positions first: the 3D view builds a model for every piece it does not have yet, so
// going back and forth between full and nearly empty boards is what costs time there.
const crowded = (e) => !e.fen || e.fen.split(' ')[0].replace(/[^a-z]/gi, '').length > 12;
const crowdedFirst = (list) => [...list.filter(crowded), ...list.filter((e) => !crowded(e))];
const refPieceAt = (R) => (sq) => R.chess.get(sq) || null;

// Placement field -> { square: piece }
function pieceMap(placement) {
    const out = {};
    placement.split('/').forEach((row, r) => {
        let c = 0;
        for (const ch of row) {
            if (/\d/.test(ch)) c += Number(ch);
            else out[String.fromCharCode(97 + c++) + (8 - r)] = ch;
        }
    });
    return out;
}

// What the screen shows on the squares a table entry names.
function assertSquares(A, e, at) {
    const shown = pieceMap(A.shown().placement);
    for (const sq of e.empties || []) assert.equal(shown[sq] || null, null, `${A.view}: ${sq} is empty on screen, ${at}`);
    for (const [sq, piece] of Object.entries(e.holds || {})) assert.equal(shown[sq] || null, piece, `${A.view}: ${piece} stands on ${sq} on screen, ${at}`);
}

/** Sets the mode, loads the entry's position (or a new game) and plays its lead-in moves by clicks. */
async function start(A, e, { mode = 'human-human', human = null, lead = true } = {}) {
    const fen = e.fen || S.START;
    const R = createReference(fen);
    await A.setMode(mode, human || R.turn());
    if (e.fen) await A.load(fen); else await A.newGame();
    assertPosition(A, R, 'start');
    if (lead) await play(A, R, e.moves || []);
    return R;
}

async function play(A, R, moves) {
    for (const mv of moves) {
        await A.move(mv);
        R.play(mv);
        assertPosition(A, R, `after ${mv}`);
    }
}

// The move that turns the reference position into what the view now shows, or null when none does.
function identifyMove(A, R) {
    const fen = A.fen();
    for (const m of R.legal().values()) if (m.fen === fen) return m.uci;
    return null;
}

/**
 * The game is over: nothing is offered for any piece of either side, and no click moves anything.
 * Clicked: every move that would be legal if the game went on (the draws by rule have some); with
 * `thorough`, or on a board with few pieces, also every square each piece might be thought to reach.
 */
async function assertLocked(A, R, at, thorough = false) {
    const before = A.fen();
    const get = refPieceAt(R);
    const pieces = ALL_SQUARES.filter((sq) => get(sq));
    const legal = [...R.legal().values()];
    for (const from of pieces) {
        const got = await A.select(from);
        assert.deepEqual(got.targets, [], `${A.view}: nothing offered for ${from} once the game is over, ${at}`);
        const tries = new Set(legal.filter((m) => m.from === from).map((m) => m.to));
        if (thorough || pieces.length <= 12) for (const sq of S.suspectSquares(get, from)) tries.add(sq);
        for (const sq of tries) {
            await A.select(from);
            await A.click(sq);
            if (A.fen() !== before || A.busy()) assert.fail(`${A.view}: ${from}-${sq} moved after the game was over, ${at}`);
        }
    }
    await A.escape();
}

/**
 * 3D only: with the king selected, a click on an own rook castles towards that rook, and only when
 * the reference allows castling on that side. Returns how often it castled and how often not.
 */
async function kingThenRook(A, entries) {
    const count = { castled: 0, refused: 0 };
    for (const e of entries) {
        for (const [rookFile, kingFile, san] of [['h', 'g', /^O-O[+#]?$/], ['a', 'c', /^O-O-O[+#]?$/]]) {
            const R = await start(A, e);
            const rank = R.turn() === 'w' ? '1' : '8';
            const king = 'e' + rank, rook = rookFile + rank, castle = king + kingFile + rank;
            if (!R.pieces().includes(king) || !R.pieces().includes(rook)) continue;
            const legal = R.legal().has(castle);
            await A.select(king);
            await A.click(rook);
            await A.settle();
            if (legal) R.play(castle);
            assertPosition(A, R, `${e.name}: ${king} then ${rook}`);
            if (legal) assert.match(A.moveList().at(-1), san, `${e.name}: ${king} then ${rook}`);
            count[legal ? 'castled' : 'refused']++;
        }
    }
    return count;
}

/**
 * 3D only: with a pawn selected, a click on an enemy pawn beside it captures that pawn en passant,
 * and only when the reference allows exactly that capture. Returns how often it captured and not.
 */
async function pawnThenPawnBeside(A, entries) {
    const count = { captured: 0, refused: 0 };
    for (const e of entries) {
        const probe = await start(A, e);
        const get = refPieceAt(probe);
        const pairs = probe.pieces().filter((sq) => get(sq).type === 'p').flatMap((from) => [-1, 1]
            .map((d) => String.fromCharCode(from.charCodeAt(0) + d) + from[1])
            .filter((beside) => get(beside)?.type === 'p' && get(beside).color !== probe.turn())
            .map((beside) => [from, beside]));
        for (const [from, beside] of pairs) {
            const R = await start(A, e);
            const capture = [...R.legal().values()].find((m) => m.from === from && m.enPassant && m.capturedSquare === beside);
            await A.select(from);
            await A.click(beside);
            await A.settle();
            if (capture) R.play(capture.uci);
            assertPosition(A, R, `${e.name}: ${from} then ${beside}`);
            if (capture) assertSquares(A, { empties: [from, beside], holds: { [capture.to]: capture.piece } }, `${e.name}: ${from} then ${beside}`);
            count[capture ? 'captured' : 'refused']++;
        }
    }
    return count;
}

/**
 * 3D only, real pointer clicks, seen from each of `sides`: for every piece of the side to move and
 * every square offered for it, click the unit, then the middle of that square (where its marker is
 * drawn). The move must be played (for a promotion: the chooser opens). The one exception is a
 * square whose middle is hidden behind the figure of another unit: that click belongs to the unit,
 * and must not play anything but a legal move. Returns how often each happened.
 */
async function pointerSweep(A, entries, sides = ['w', 'b']) {
    const count = { played: 0, hidden: 0, unitsHidden: 0 };
    for (const e of entries) {
        for (const side of sides) {
            const R = await start(A, e, { human: side });
            const before = A.fen();
            for (const from of R.result().over ? [] : R.pieces()) {
                for (const to of R.offered(from).targets) {
                    const at = `${e.name}, seen from ${side === 'w' ? 'White' : 'Black'}: ${from}, then the middle of ${to}`;
                    const moves = [...R.legal().values()].filter((m) => m.from === from && m.to === to);
                    await A.escape();
                    if (A.pickDetail(from, 'unit').square !== from) { count.unitsHidden++; continue; } // another figure stands in front of this unit's body
                    await A.pointer(from, 'unit');
                    assert.equal(A.selected(), from, `${at}: the unit is selected`);
                    const target = A.pickDetail(to, 'middle');
                    await A.pointer(to, 'middle');
                    const chooser = A.promotionOpen();
                    if (chooser) await A.cancelPromotion();
                    await A.settle();
                    const after = A.fen();
                    const played = moves[0].promotion ? chooser && after === before : after === moves[0].fen;
                    if (played) {
                        count.played++;
                    } else {
                        assert.ok(target.figure && target.figure !== to,
                            `${at}: not played, although no figure hides the middle of ${to} (picked ${target.square}, board ${target.ground}): ${after}`);
                        assert.ok(after === before || [...R.legal().values()].some((m) => m.fen === after), `${at}: the click on ${target.figure} left a legal position`);
                        count.hidden++;
                    }
                    if (after !== before) assert.equal(await A.undo(), true, `${at}: undo`);
                    assert.equal(A.fen(), before, `${at}: back to the position`);
                }
            }
            await A.escape();
        }
    }
    return count;
}

// --- Table checks (reference only) --------------------------------------------------------------

function defineTableChecks() {
    describe('rules scenario tables agree with the reference', () => {
        const replay = (e) => { const R = createReference(e.fen || S.START); for (const mv of e.moves || []) R.play(mv); return R; };

        test('every position is a possible one: the side that has just moved is not in check', () => {
            const tables = { CORPUS: S.CORPUS, SPECIAL_MOVES: S.SPECIAL_MOVES, ENDINGS: S.ENDINGS, FINISHED: S.FINISHED, AI_REPLIES: S.AI_REPLIES, AI_OBVIOUS: S.AI_OBVIOUS };
            for (const [table, list] of Object.entries(tables)) {
                for (const e of withMirrors(list.filter((x) => x.fen), true)) {
                    const fields = e.fen.split(' ');
                    const other = createReference([fields[0], fields[1] === 'w' ? 'b' : 'w', fields[2], '-', fields[4], fields[5]].join(' '));
                    assert.equal(other.status().inCheck, false, `${table}: ${e.name}: ${e.fen}`);
                }
            }
        });

        test('offered-move corpus: named moves are legal / illegal as stated', () => {
            for (const e of withMirrors(S.CORPUS, true)) {
                const R = replay(e), legal = R.legal();
                assert.equal(R.result().over, false, `${e.group}: ${e.name}: the game is not over in this position`);
                for (const mv of e.must || []) assert.ok(legal.has(mv), `${e.group}: ${e.name}: ${mv} must be legal`);
                for (const mv of e.mustNot || []) assert.ok(!legal.has(mv), `${e.group}: ${e.name}: ${mv} must be illegal`);
                if (e.single) assert.equal(new Set([...legal.values()].map((m) => m.from + m.to)).size, 1, `${e.group}: ${e.name}: exactly one legal move`);
            }
        });

        test('special moves: position, notation and squares after the move', () => {
            for (const e of withMirrors(S.SPECIAL_MOVES, true)) {
                const R = replay({ fen: e.fen });
                const m = R.play(e.move);
                assert.equal(m.fen, e.after, `${e.name}: position after ${e.move}`);
                assert.equal(m.san, e.san, `${e.name}: notation`);
                const map = pieceMap(m.fen.split(' ')[0]);
                for (const sq of e.empties || []) assert.equal(map[sq], undefined, `${e.name}: ${sq} empty`);
                for (const [sq, piece] of Object.entries(e.holds || {})) assert.equal(map[sq], piece, `${e.name}: ${piece} on ${sq}`);
            }
        });

        test('game ends: the result comes with the last move and not before', () => {
            for (const e of withMirrors(S.ENDINGS, true)) {
                const R = createReference(e.fen || S.START);
                for (const [i, mv] of e.moves.entries()) {
                    assert.equal(R.result().over, false, `${e.name}: not over before ply ${i + 1}`);
                    R.play(mv);
                }
                const got = R.result();
                assert.equal(got.kind, e.expect.kind, `${e.name}: result`);
                if (e.expect.winner) assert.equal(got.winner, e.expect.winner, `${e.name}: winner`);
                if (e.san) assert.equal(R.last().san, e.san, `${e.name}: notation`);
            }
            for (const e of S.FINISHED) assert.equal(createReference(e.fen).result().kind, e.expect.kind, `finished position: ${e.name}`);
        });

        test('AI scenarios: replies and best moves are legal', () => {
            for (const e of withMirrors(S.AI_REPLIES, true)) {
                const R = createReference(e.fen);
                R.play(e.human);
                const m = R.play(e.ai);
                assert.equal(m.san, e.san, `${e.name}: notation`);
            }
            for (const e of S.AI_OBVIOUS) {
                const legal = createReference(e.fen).legal();
                for (const mv of e.best) assert.ok(legal.has(mv), `${e.name}: ${mv} is legal`);
            }
        });

        test('the reported game and the game to save: moves, notation and final position', () => {
            const game = replay({ moves: S.REPORTED_GAME.moves });
            assert.equal(game.sans().map((san, i) => (i % 2 ? san : `${i / 2 + 1}. ${san}`)).join(' '), S.REPORTED_GAME.san);
            assert.equal(game.fen(), S.REPORTED_GAME.fen);
            assert.deepEqual([game.last().enPassant, game.last().capturedSquare, game.last().color], [true, 'b4', 'b'], '20...axb3 is en passant and takes the b4 pawn');
            const saved = replay({ moves: S.SAVED_GAME.moves });
            assert.equal(saved.fen(), S.SAVED_GAME.fen);
            assert.equal(saved.legal().get('e5d6').enPassant, true);
        });

        test('mirroring a position twice gives it back', () => {
            for (const e of S.CORPUS.filter((c) => c.fen)) assert.equal(S.mirrorFen(S.mirrorFen(e.fen)), e.fen);
        });
    });
}

// --- The suite ----------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {'2d'|'3d'} o.view
 * @param {() => Promise<object>} o.open resolves the (shared) adapter; the caller closes it
 * @param {boolean|string} [o.skip]
 * @param {boolean} [o.slow] every entry mirrored, all 64 squares clicked for every piece
 */
function defineRulesUiSuite({ view, open, skip = false, slow = false }) {
    const label = view.toUpperCase();
    let A = null;
    const page = async () => (A = await open());
    // Every test must leave the page's console clean
    const clean = () => { if (A) assert.deepEqual(A.takeErrors(), [], `${label} console errors`); };

    describe(`${label} rules: offered moves equal the legal moves`, { skip }, () => {
        afterEach(clean);
        for (const e of crowdedFirst(withMirrors(S.CORPUS, slow))) {
            const name = `${e.group}: ${e.name}`;
            test(name, async () => {
                await page();
                const R = await start(A, e);
                assertStatus(A, R, name);
                await assertOffers(A, R, name);
                // Fast suite: the mirrored and the crowded entries stop at the offers
                if (slow || !(e.heavy || e.mirrored)) {
                    const squares = slow || e.full ? undefined : (from) => S.suspectSquares(refPieceAt(R), from);
                    await assertInertClicks(A, R, name, squares);
                }
                assertPosition(A, R, 'after the clicks');
            });
        }

        test('a target offered before an undo is not accepted after it', async () => {
            await page();
            const R = await start(A, { fen: '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1', moves: ['d7d5'] });
            assert.deepEqual((await A.select('e5')).targets, ['d6', 'e6']);
            assert.equal(await A.undo(), true); // back before ...d5: Black to move, the white pawn is not selectable
            R.undo();
            await A.click('d6');
            await A.click('e6');
            assertPosition(A, R, 'clicks on the old targets');
            assert.deepEqual(A.offered().targets, []);
        });

        test('cancelling the promotion chooser leaves the position alone', async () => {
            await page();
            const R = await start(A, { fen: '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1' });
            for (const to of ['a8', 'b8']) {
                await A.select('a7');
                await A.click(to);
                assert.equal(A.promotionOpen(), true, `chooser opens for a7-${to}`);
                assertPosition(A, R, 'while the chooser is open');
                await A.click('e1'); await A.click('e2'); // the board is locked meanwhile
                assertPosition(A, R, 'clicks behind the chooser');
                await A.cancelPromotion();
                assert.equal(A.promotionOpen(), false);
                assertPosition(A, R, 'after cancel');
            }
            await A.select('a7'); await A.click('a8');
            await A.escape();
            assert.equal(A.promotionOpen(), false, 'Escape closes the chooser');
            assertPosition(A, R, 'after Escape');
            await assertOffers(A, R, 'after the cancelled promotions');
        });
    });

    describe(`${label} rules: executed special moves equal the reference`, { skip }, () => {
        afterEach(clean);
        for (const e of withMirrors(S.SPECIAL_MOVES, slow)) {
            const name = `${e.group}: ${e.name}`;
            test(name, async () => {
                await page();
                const R = await start(A, e);
                const before = A.fen();
                await A.move(e.move);
                const m = R.play(e.move);
                assertPosition(A, R, e.move);
                assert.equal(A.fen(), e.after, 'position after the move');
                assertSquares(A, e, `after ${e.move}`);
                assertStatus(A, R, e.move);
                assert.equal(A.moveListShown().at(-1), m.enPassant ? `${m.san} e.p.` : m.san, 'listed notation, en passant marked');
                assert.deepEqual(A.lastMoveMarks(), { move: [m.from, m.to].sort(), captured: m.enPassant ? m.capturedSquare : null }, 'last-move marks');
                await assertOffers(A, R, `after ${e.move}`);

                // Undo gives back the exact position, rights and en passant square included
                assert.equal(await A.undo(), true, 'undo available');
                R.undo();
                assert.equal(A.fen(), before, 'undo restores the exact FEN');
                assertPosition(A, R, 'after undo');
                assertStatus(A, R, 'after undo');
                await assertOffers(A, R, 'after undo');
                if (A.hasRedo) {
                    assert.equal(await A.redo(), true, 'redo available');
                    R.play(e.move);
                    assertPosition(A, R, 'after redo');
                    assertSquares(A, e, 'after redo');
                    assertStatus(A, R, 'after redo');
                    assert.equal(await A.undo(), true);
                    R.undo();
                    assertPosition(A, R, 'after the second undo');
                }
                // and the move can be played again
                await A.move(e.move);
                R.play(e.move);
                assertPosition(A, R, 'played again after undo');
                assertSquares(A, e, 'played again after undo');
            });
        }
    });

    describe(`${label} rules: game end and draws`, { skip }, () => {
        afterEach(clean);
        for (const e of crowdedFirst(withMirrors(S.ENDINGS, slow))) {
            const name = `${e.group}: ${e.name}`;
            test(name, async () => {
                await page();
                const R = await start(A, e, { lead: false });
                for (const mv of e.moves) {
                    assert.equal(A.result().over, false, `not over before ${mv}`);
                    await A.move(mv);
                    R.play(mv);
                    assertPosition(A, R, `after ${mv}`);
                    assertStatus(A, R, `after ${mv}`);
                }
                const got = A.result();
                assert.equal(got.kind, e.expect.kind, `result shown: "${A.status()}"`);
                if (e.expect.winner) assert.equal(got.winner, e.expect.winner, 'winner shown');
                if (e.san) assert.equal(A.moveList().at(-1), e.san, 'listed notation');
                if (!e.expect.kind) {
                    assert.ok(R.legal().size > 0);
                    await assertOffers(A, R, 'the game goes on');
                    return;
                }
                await assertLocked(A, R, name, slow);
                assertPosition(A, R, 'after clicking around the finished game');
                // Taking the last move back reopens the game; playing it again ends it again
                assert.equal(await A.undo(), true, 'undo available after the end');
                R.undo();
                assertPosition(A, R, 'after undo');
                assertStatus(A, R, 'after undo');
                assert.equal(A.result().over, false, 'game open again after undo');
                await assertOffers(A, R, 'after undo');
                const last = e.moves.at(-1);
                await A.move(last);
                R.play(last);
                assertStatus(A, R, 'last move played again');
                assert.equal(A.result().kind, e.expect.kind);
            });
        }

        for (const e of S.FINISHED) {
            test(`finished position: ${e.name}`, async () => {
                await page();
                const R = await start(A, e);
                assertStatus(A, R, e.name);
                assert.equal(A.result().kind, e.expect.kind, `result shown: "${A.status()}"`);
                if (e.expect.winner) assert.equal(A.result().winner, e.expect.winner);
                await assertLocked(A, R, e.name, slow);
            });
        }

        test('human vs AI: no AI turn after the human mates, stalemates or draws', async () => {
            await page();
            for (const e of S.ENDINGS.filter((x) => x.fen && x.moves.length === 1 && x.expect.kind && /^(back-rank mate|stalemate|K v K after the last capture)$/.test(x.name))) {
                const R = await start(A, e, { mode: 'human-ai', human: 'w', lead: false });
                const asked = A.aiRequests().length;
                await A.move(e.moves[0]);
                R.play(e.moves[0]);
                assertStatus(A, R, e.name);
                await A.pass();
                assert.equal(A.aiRequests().length, asked, `${e.name}: the AI is not asked to move`);
                assert.equal(A.thinking(), false);
                assert.equal(A.result().kind, e.expect.kind, `${e.name}: result stays on screen: "${A.status()}"`);
                assertPosition(A, R, `${e.name}: after waiting`);
            }
        });

        test('human vs AI: after the AI mates, the human cannot move and the AI is not asked again', async () => {
            await page();
            const R = await start(A, { fen: '1r4k1/5ppp/8/8/8/8/P4PPP/6K1 w - - 0 1' }, { mode: 'human-ai', human: 'w' });
            const before = A.fen();
            await A.move('a2a3'); R.play('a2a3');
            await A.answerAI('b8b1'); R.play('b8b1');
            assertPosition(A, R, 'after the AI mates');
            assertStatus(A, R, 'after the AI mates');
            assert.deepEqual(A.result(), { over: true, kind: 'checkmate', winner: 'b', check: false });
            const asked = A.aiRequests().length;
            await assertLocked(A, R, 'mated by the AI');
            await A.pass();
            assert.equal(A.aiRequests().length, asked);
            // Undo takes back both plies and the game is open again
            assert.equal(await A.undo(), true);
            R.undo(2);
            assert.equal(A.fen(), before);
            assertStatus(A, R, 'after undo');
            await assertOffers(A, R, 'after undo');
        });

        test('AI vs AI: no further AI turn after the game ends', async () => {
            await page();
            const R = createReference('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
            await A.setMode('ai-ai');
            await A.load(R.fen());
            await A.answerAI('a1a8'); R.play('a1a8');
            assertPosition(A, R, 'after the mate');
            assert.equal(A.result().kind, 'checkmate');
            const asked = A.aiRequests().length;
            await A.pass();
            assert.equal(A.aiRequests().length, asked);
            await A.setMode('human-human');
        });
    });

    describe(`${label} rules: undo keeps the rules state`, { skip }, () => {
        afterEach(clean);

        test('en passant is offered again after undoing back to its position, and not one move later', async () => {
            await page();
            const R = await start(A, { moves: ['e2e4', 'a7a6', 'e4e5', 'd7d5'] });
            const available = A.fen();
            assert.equal(available.split(' ')[3], 'd6');
            assert.deepEqual(await A.select('e5'), { targets: ['d6', 'e6'], captures: ['d6'] });
            await play(A, R, ['h2h3', 'h7h6']);
            assert.deepEqual(await A.select('e5'), { targets: ['e6'], captures: [] }, 'expired one move later');
            await A.click('d6');
            assertPosition(A, R, 'click on the expired en passant square');
            assert.equal(await A.undo(), true); R.undo();
            assert.equal(await A.undo(), true); R.undo();
            assert.equal(A.fen(), available, 'both plies undone: the en passant square is back');
            assert.deepEqual(await A.select('e5'), { targets: ['d6', 'e6'], captures: ['d6'] }, 'offered again');
            await assertOffers(A, R, 'after undo');
            await play(A, R, ['e5d6']);
            assertSquares(A, { empties: ['d5', 'e5'], holds: { d6: 'P' } }, 'en passant after undo');
            // Undoing the capture itself puts the captured pawn back beside the capturer
            assert.equal(await A.undo(), true); R.undo();
            assert.equal(A.fen(), available);
            assertSquares(A, { empties: ['d6'], holds: { d5: 'p', e5: 'P' } }, 'capture undone');
            // Undoing the double push too: no en passant square, Black to move
            assert.equal(await A.undo(), true); R.undo();
            assert.equal(A.fen().split(' ')[3], '-');
            assertPosition(A, R, 'double push undone');
        });

        test('human vs AI: en passant expires and comes back with undo', async () => {
            await page();
            const R = await start(A, {}, { mode: 'human-ai', human: 'w' });
            for (const [human, ai] of [['e2e4', 'a7a6'], ['e4e5', 'd7d5']]) {
                await A.move(human); R.play(human);
                await A.answerAI(ai); R.play(ai);
                assertPosition(A, R, `${human} ${ai}`);
            }
            const available = A.fen();
            assert.deepEqual((await A.select('e5')).targets, ['d6', 'e6']);
            await A.move('h2h3'); R.play('h2h3');
            await A.answerAI('h7h6'); R.play('h7h6');
            assert.deepEqual((await A.select('e5')).targets, ['e6']);
            assert.equal(await A.undo(), true); R.undo(2);
            assert.equal(A.fen(), available);
            assert.deepEqual((await A.select('e5')).targets, ['d6', 'e6']);
            await A.move('e5d6'); R.play('e5d6');
            assertPosition(A, R, 'en passant after undo');
            assertSquares(A, { empties: ['d5', 'e5'], holds: { d6: 'P' } }, 'en passant after undo');
        });

        test('castling is offered again after undoing a king move, and the rights are back', async () => {
            await page();
            const R = await start(A, { fen: S.CASTLE });
            const before = A.fen();
            await play(A, R, ['e1e2', 'e8e7', 'e2e1', 'e7e8']);
            assert.equal(A.fen().split(' ')[2], '-');
            assert.deepEqual((await A.select('e1')).targets.filter((t) => t === 'g1' || t === 'c1'), []);
            for (let i = 0; i < 4; i++) { assert.equal(await A.undo(), true); R.undo(); assertPosition(A, R, `undo ${i + 1}`); }
            assert.equal(A.fen(), before);
            assert.deepEqual((await A.select('e1')).targets.filter((t) => t === 'g1' || t === 'c1'), ['c1', 'g1']);
            await play(A, R, ['e1g1', 'e8c8']);
            assertSquares(A, { holds: { g1: 'K', f1: 'R', c8: 'k', d8: 'r' }, empties: ['e1', 'h1', 'e8', 'a8'] }, 'both sides castled after undo');
            assert.equal(await A.undo(), true); R.undo();
            assertSquares(A, { holds: { e8: 'k', a8: 'r', g1: 'K', f1: 'R' }, empties: ['c8', 'd8'] }, 'castling undone: the rook is back in the corner');
            assertPosition(A, R, 'castling undone');
        });

        test('human vs AI: undo while the AI is thinking takes back the human move, and a late answer is ignored', async () => {
            await page();
            const R = await start(A, { fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1' }, { mode: 'human-ai', human: 'w' });
            const before = A.fen();
            await A.move('e5d6');
            await A.pass();
            const call = A.aiRequests().filter((c) => !c.cancelled && !c.answered).pop();
            assert.ok(call, 'the AI was asked');
            assert.equal(await A.undo(), true);
            assert.equal(A.fen(), before, 'the en passant capture is taken back, square and all');
            call.resolve({ from: { row: 0, col: 4 }, to: { row: 1, col: 4 }, isPromotion: false, promotionPiece: null }); // ...Ke7, too late
            await A.pass();
            assertPosition(A, R, 'after the late answer');
            assertSquares(A, { holds: { d5: 'p', e5: 'P' }, empties: ['d6'] }, 'after the late answer');
            assert.deepEqual((await A.select('e5')).targets, ['d6', 'e6'], 'en passant offered again');
        });

        const VS_AI = /^(en passant removes|king-side castling|queen-side castling|rook captured at home|promotion by push to Q|promotion by capture to R)/;
        for (const e of S.SPECIAL_MOVES.filter((x) => VS_AI.test(x.name)).flatMap((x) => (slow || x.group === 'en passant' ? [x, S.mirrorEntry(x)] : [x]))) {
            test(`human vs AI: ${e.name}, the AI answers, undo takes back both plies`, async () => {
                await page();
                const R = await start(A, e, { mode: 'human-ai' });
                const before = A.fen();
                await A.move(e.move); R.play(e.move);
                assertPosition(A, R, e.move);
                const reply = [...R.legal().keys()].sort()[0];
                await A.answerAI(reply); R.play(reply);
                assertPosition(A, R, `AI reply ${reply}`);
                assertStatus(A, R, `AI reply ${reply}`);
                assert.equal(await A.undo(), true);
                R.undo(2);
                assert.equal(A.fen(), before, 'undo restores the exact FEN before the human move');
                assertPosition(A, R, 'after undo');
                await assertOffers(A, R, 'after undo');
                await A.move(e.move); R.play(e.move);
                assertPosition(A, R, 'played again');
                assertSquares(A, e, 'played again');
            });
        }
    });

    describe(`${label} rules: human vs AI, the AI's move is applied as the reference plays it`, { skip }, () => {
        afterEach(clean);
        for (const e of withMirrors(S.AI_REPLIES, true)) {
            test(e.name, async () => {
                await page();
                const R = await start(A, e, { mode: 'human-ai' });
                const before = A.fen();
                await A.move(e.human); R.play(e.human);
                await A.answerAI(e.ai);
                const m = R.play(e.ai);
                assertPosition(A, R, `AI ${e.ai}`);
                assertSquares(A, e, `AI ${e.ai}`);
                assertStatus(A, R, `AI ${e.ai}`);
                assert.equal(A.moveList().at(-1), m.san);
                await assertOffers(A, R, `after AI ${e.ai}`);
                assert.equal(await A.undo(), true);
                R.undo(2);
                assert.equal(A.fen(), before, 'undo takes back the AI move and the human move');
                assertPosition(A, R, 'after undo');
            });
        }

        test('an AI promotion without a piece becomes a queen', async () => {
            await page();
            const R = await start(A, { fen: '4k3/8/8/8/8/8/p7/4K3 w - - 0 1' }, { mode: 'human-ai', human: 'w' });
            await A.move('e1e2'); R.play('e1e2');
            await A.answerAI({ from: { row: 6, col: 0 }, to: { row: 7, col: 0 } });
            R.play('a2a1q');
            assertPosition(A, R, 'AI promotion without a piece');
        });

        test('an illegal AI move (pawn taking sideways, two steps after its first move, a flying king, en passant without the right) is refused and asked for again', async () => {
            await page();
            const e = { fen: '4k3/8/8/8/3pP3/8/8/4K3 w - - 0 1', human: 'e1e2', bad: ['d4e4', 'd4d2', 'e8e1', 'd4e3'] };
            for (const bad of e.bad) {
                const R = await start(A, e, { mode: 'human-ai', human: 'w' });
                await A.move(e.human); R.play(e.human);
                await A.answerAI(bad);
                assertPosition(A, R, `after the refused AI move ${bad}`);
                assert.ok(A.takeErrors().some((line) => line.includes(`AI move rejected: ${bad} in ${R.fen()}`)), `the refusal of ${bad} is logged with the position`);
                assert.equal(A.thinking(), true, 'still the AI turn');
                // a legal answer to the second request is played as usual
                await A.answerAI('d4d3'); R.play('d4d3');
                assertPosition(A, R, `legal answer after the refused ${bad}`);
                assertStatus(A, R, `legal answer after the refused ${bad}`);
                assert.notEqual(A.notice(), S.TEXT.aiFallback);
            }
        });

        test('two unusable AI answers in a row: the first legal move is played for the AI, with a notice', async () => {
            await page();
            const R = await start(A, { fen: '4k3/8/8/8/3pP3/8/8/4K3 w - - 0 1' }, { mode: 'human-ai', human: 'w' });
            await A.move('e1e2'); R.play('e1e2');
            const asked = A.aiRequests().length;
            await A.answerAI('d4e4');   // sideways
            await A.answerAI(null);     // no answer at all
            assert.equal(A.aiRequests().length, asked + 2, 'asked twice, not a third time');
            assert.ok(A.takeErrors().length >= 2, 'both are logged');
            R.play('e8d8');             // the first legal move in board order (a8 to h1)
            assertPosition(A, R, 'move played for the AI');
            assertStatus(A, R, 'move played for the AI');
            assert.equal(A.notice(), S.TEXT.aiFallback);
            assert.equal(A.thinking(), false);
            await assertOffers(A, R, 'the human goes on');
        });

        test('the reported game, move for move against the AI: 20. b4 axb3 is en passant, the b4 pawn is gone', async () => {
            await page();
            A.forgetTips();
            const R = await start(A, {}, { mode: 'human-ai', human: 'w' });
            const moves = S.REPORTED_GAME.moves;
            for (let i = 0; i < moves.length; i += 2) {
                await A.move(moves[i]); R.play(moves[i]);
                await A.answerAI(moves[i + 1]); R.play(moves[i + 1]);
                assertPosition(A, R, `move ${i / 2 + 1}`);
            }
            assert.equal(A.fen(), S.REPORTED_GAME.fen);
            assertStatus(A, R, 'after 20...axb3');
            assertSquares(A, { empties: ['b4', 'a4', 'b2'], holds: { b3: 'p' } }, 'after 20...axb3');
            assert.equal(A.moveListShown().at(-1), 'axb3 e.p.', 'listed as en passant');
            assert.deepEqual(A.lastMoveMarks(), { move: ['a4', 'b3'], captured: 'b4' }, 'the square of the captured pawn is marked');
            assert.equal(A.notice(), S.TEXT.enPassantToYou, 'the rule is explained to the player whose pawn was taken');
            await assertOffers(A, R, 'after 20...axb3');
            // Undo: 20. b4 and the capture are taken back together, the pawn stands on b2 again
            assert.equal(await A.undo(), true);
            R.undo(2);
            assertPosition(A, R, 'after undo');
            assertSquares(A, { empties: ['b3', 'b4'], holds: { b2: 'P', a4: 'p' } }, 'after undo');
            assert.equal(A.lastMoveMarks().captured, null);
            // and when the player pushes one square only, there is nothing to take
            await A.move('b2b3'); R.play('b2b3');
            await A.answerAI('a4b3'); R.play('a4b3');
            assert.equal(A.moveListShown().at(-1), 'axb3', 'an ordinary capture, not marked');
            assertPosition(A, R, 'ordinary capture on b3');
        });

        test('en passant is explained the first three times on a device, in the words that fit who captured', async () => {
            await page();
            A.forgetTips();
            const bare = { fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1' };
            // 1. the AI takes the player's pawn
            let R = await start(A, S.AI_REPLIES[0], { mode: 'human-ai' });
            await A.move(S.AI_REPLIES[0].human); R.play(S.AI_REPLIES[0].human);
            await A.answerAI(S.AI_REPLIES[0].ai); R.play(S.AI_REPLIES[0].ai);
            assert.equal(A.notice(), S.TEXT.enPassantToYou);
            // 2. the player takes
            R = await start(A, bare, { mode: 'human-ai', human: 'w' });
            await A.move('e5d6'); R.play('e5d6');
            assert.equal(A.notice(), S.TEXT.enPassantByYou);
            assertPosition(A, R, 'the player takes en passant');
            // 3. two humans: no "you"
            R = await start(A, bare);
            await A.begin('e5d6');
            assert.equal(A.notice(), S.TEXT.enPassant, 'shown when the move starts');
            await A.settle(); R.play('e5d6');
            assertPosition(A, R, 'human vs human');
            // 4. not explained a fourth time (the capture is still marked in the list)
            R = await start(A, S.AI_REPLIES[0], { mode: 'human-ai' });
            await A.move(S.AI_REPLIES[0].human); R.play(S.AI_REPLIES[0].human);
            await A.answerAI(S.AI_REPLIES[0].ai); R.play(S.AI_REPLIES[0].ai);
            assert.notEqual(A.notice(), S.TEXT.enPassantToYou, 'the fourth capture is not explained again');
            assert.equal(A.moveListShown().at(-1), 'dxe3 e.p.');
            assertPosition(A, R, 'fourth capture');
        });
    });

    describe(`${label} rules: a move in progress cannot be disturbed`, { skip }, () => {
        afterEach(clean);
        const MOVES = [
            { name: 'en passant', fen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', move: 'e5d6' },
            { name: 'castling', fen: S.CASTLE, move: 'e1g1' },
            { name: 'capture with promotion', fen: '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', move: 'a7b8q' },
        ];
        const open = () => A.aiRequests().filter((c) => !c.cancelled && !c.answered);

        test('Undo, Redo, Escape and clicks on the board during a move change nothing; the move completes', async () => {
            await page();
            for (const e of MOVES) {
                const R = await start(A, e);
                await A.begin(e.move);
                assert.equal(A.busy(), true, `${e.name}: the move is being animated`);
                assert.equal(A.press('undo'), false, `${e.name}: Undo is disabled`);
                assert.equal(A.press('redo'), false, `${e.name}: Redo is disabled`);
                await A.escape();
                for (const sq of ['e1', 'd1', 'e8', 'd8', e.move.slice(2, 4), e.move.slice(0, 2)]) await A.click(sq);
                assert.equal(A.busy(), true, `${e.name}: still the same move`);
                await A.settle();
                R.play(e.move);
                assertPosition(A, R, `${e.name}: after the move`);
                assertStatus(A, R, `${e.name}: after the move`);
                assert.equal(await A.undo(), true, `${e.name}: Undo works again`);
                R.undo();
                assertPosition(A, R, `${e.name}: undone`);
                await assertOffers(A, R, `${e.name}: undone`);
            }
        });

        test('New Game during a move starts a new game with nothing of that move in it', async () => {
            await page();
            for (const e of MOVES.slice(0, 2)) {
                await start(A, e);
                await A.begin(e.move);
                assert.equal(A.press('newGame'), true);
                await A.settle();
                const R = createReference();
                assertPosition(A, R, `${e.name}: new game`);
                assertStatus(A, R, `${e.name}: new game`);
                await play(A, R, ['e2e4', 'e7e5']);
                assertStatus(A, R, `${e.name}: play in the new game`);
            }
        });

        test('switching to human vs AI during a move: the AI is asked once, after the move, for the position after it', async () => {
            await page();
            for (const e of MOVES) {
                const R = await start(A, e);
                const asked = A.aiRequests().length;
                await A.begin(e.move);
                await A.setMode('human-ai', R.turn()); // the side that is moving stays human
                assert.equal(A.busy(), true, `${e.name}: the move goes on`);
                assert.equal(A.aiRequests().length, asked, `${e.name}: no request for a half-played move`);
                await A.settle();
                R.play(e.move);
                assertPosition(A, R, `${e.name}: after the move`);
                await A.pass();
                assert.equal(A.aiRequests().length, asked + 1, `${e.name}: one request`);
                assert.equal(stateFen(open()[0].state), R.fen(), `${e.name}: the AI is given the position after the move`);
                const reply = [...R.legal().keys()].sort()[0];
                await A.answerAI(reply); R.play(reply);
                assertPosition(A, R, `${e.name}: AI reply ${reply}`);
                assertStatus(A, R, `${e.name}: AI reply ${reply}`);
            }
        });

        test('a save taken while a move is in progress holds a whole position, never half a move', async () => {
            await page();
            const replayed = (record) => { const game = createReference(record.startFen || S.START); for (const mv of record.moves) game.play(mv); return game.fen(); };
            for (const e of MOVES) {
                const R = await start(A, e);
                const before = R.fen();
                await A.begin(e.move);
                const during = [A.saveRecord(), A.autosaved()].filter(Boolean); // nothing is stored yet for a position without moves
                await A.settle();
                R.play(e.move);
                for (const record of during) {
                    assert.equal(record.fen, replayed(record), `${e.name}: the saved position is the one its moves lead to`);
                    assert.ok(record.fen === before || record.fen === R.fen(), `${e.name}: saved before or after the move: ${record.fen}`);
                }
                assert.equal(A.autosaved().fen, R.fen(), `${e.name}: stored for the next start once the move is done`);
                assert.deepEqual(A.autosaved().moves, [e.move]);
            }
        });

        test('human vs AI: the AI is not asked while the human move is still being played, and its own move cannot be disturbed either', async () => {
            await page();
            const e = MOVES[0];
            const R = await start(A, e, { mode: 'human-ai', human: 'w' });
            const asked = A.aiRequests().length;
            await A.begin(e.move);
            assert.equal(A.aiRequests().length, asked);
            assert.equal(A.press('undo'), false);
            await A.settle();
            R.play(e.move);
            await A.pass();
            assert.equal(open().length, 1);
            assert.equal(stateFen(open()[0].state), R.fen());
            // The AI's own move in progress is just as safe: Undo and the board wait for it to finish
            const call = open()[0];
            call.answered = true;
            call.resolve(moveObject('e8d7'));
            for (let i = 0; i < 20; i++) await null; // promise callbacks only: a timer tick could already finish the 2D animation
            assert.equal(A.busy(), true, 'the AI move is being animated');
            assert.equal(A.press('undo'), false);
            for (const sq of ['e1', 'e2', 'd6', 'd7']) await A.click(sq);
            await A.settle();
            R.play('e8d7');
            assertPosition(A, R, 'after the AI move');
            assertStatus(A, R, 'after the AI move');
            // Undo now takes both moves back; the en passant right is there again
            assert.equal(await A.undo(), true);
            R.undo(2);
            assertPosition(A, R, 'undo after the AI move');
            assert.deepEqual((await A.select('e5')).targets, ['d6', 'e6']);
        });
    });

    describe(`${label} rules: a saved game comes back as it was`, { skip }, () => {
        afterEach(clean);
        const offersOf = async (R) => {
            const out = {};
            for (const from of R.pieces()) out[from] = await A.select(from);
            await A.escape();
            return out;
        };

        test('saved with en passant available and castling rights partly lost, played on, loaded: same FEN, same offered moves', async () => {
            await page();
            const R = await start(A, { moves: S.SAVED_GAME.moves });
            assert.equal(A.fen(), S.SAVED_GAME.fen);
            const offers = await offersOf(R);
            assert.deepEqual(offers.e5, { targets: ['d6', 'e6'], captures: ['d6'] }, 'en passant is offered before saving');
            const record = A.saveRecord();
            assert.deepEqual(record.moves, S.SAVED_GAME.moves);
            await play(A, R, ['e5d6', 'c7d6', 'f1b5']);
            const loaded = await A.loadRecord(record);
            assert.equal(loaded.ok, true, `load: ${loaded.error || ''}`);
            R.undo(3);
            assert.equal(A.fen(), S.SAVED_GAME.fen, 'FEN after load: en passant square and castling rights included');
            assertPosition(A, R, 'after load');
            assertStatus(A, R, 'after load');
            assert.deepEqual(await offersOf(R), offers, 'offered moves after load');
            await assertOffers(A, R, 'after load');
            // the loaded game plays on, and Undo walks back into the loaded moves
            await play(A, R, ['e5d6']);
            assertSquares(A, { empties: ['d5', 'e5'], holds: { d6: 'P' } }, 'en passant after load');
            assert.equal(A.moveListShown().at(-1), 'exd6 e.p.');
            assert.equal(await A.undo(), true); R.undo();
            assert.equal(await A.undo(), true); R.undo();
            assertPosition(A, R, 'undone into the loaded game');
            await assertOffers(A, R, 'undone into the loaded game');
        });

        test('exported as PGN, new game, imported: the same position with its rights and offers', async () => {
            await page();
            const R = await start(A, { moves: S.SAVED_GAME.moves });
            const pgn = A.exportPgn();
            assert.match(pgn, /1\. e4 a5 2\. e5 Ra6 3\. h4 Ra8 4\. Rh3 Nf6 5\. Rh1 Ng8 6\. Nf3 d5/);
            await A.newGame();
            assert.equal(A.fen(), S.START);
            const imported = await A.importPgn(pgn);
            assert.equal(imported.ok, true, `import: ${imported.error || ''}`);
            assert.equal(A.fen(), S.SAVED_GAME.fen);
            assertPosition(A, R, 'after import');
            assertStatus(A, R, 'after import');
            await assertOffers(A, R, 'after import');
        });

        test('a game that began from a set-up position and has castled: saved and loaded with its rights', async () => {
            await page();
            const R = await start(A, { fen: 'r3k2r/8/8/8/3p4/8/4P3/R3K2R w KQkq - 0 1', moves: ['e1g1', 'e8c8', 'e2e4'] });
            const fen = A.fen();
            assert.equal(fen.split(' ').slice(2, 4).join(' '), '- e3');
            const record = A.saveRecord();
            await A.newGame();
            const loaded = await A.loadRecord(record);
            assert.equal(loaded.ok, true, `load: ${loaded.error || ''}`);
            assert.equal(A.fen(), fen);
            assertPosition(A, R, 'after load');
            assertStatus(A, R, 'after load');
            await assertOffers(A, R, 'after load');
            await play(A, R, ['d4e3']);
            assertSquares(A, { empties: ['d4', 'e4'], holds: { e3: 'p' } }, 'en passant after load');
        });
    });
}

// --- Playouts -----------------------------------------------------------------------------------

// Start positions for playouts that reach the special moves within a few plies: castling at once
// for both sides, and pawns about to promote with en passant chances on three files.
const PLAYOUT_STARTS = {
    castling: 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1',
    pawns: '4k3/1P5p/8/2pP2P1/p7/8/1P4p1/4K3 w - c6 0 1',
};

const WEIGHT = (m) => (m.enPassant ? 80 : m.castling ? 30 : m.promotion ? 6 : m.captured ? 4 : m.double ? 4 : m.piece.toLowerCase() === 'p' ? 2 : 1);

/**
 * One seeded random game through the given views in lockstep. At every ply: each view's position,
 * screen, status and move list equal the reference, every piece's offered targets equal the
 * reference, and the views equal each other. Special moves are preferred so short games reach them.
 * @returns stats { plies, captures, enPassant, castles, promotions, checks, result }
 */
async function playout(adapters, { seed, plies, fen = S.START }) {
    const rand = rng(seed);
    const R = createReference(fen);
    for (const A of adapters) {
        await A.setMode('human-human', 'w');
        if (fen === S.START) await A.newGame(); else await A.load(fen);
    }
    const stats = { plies: 0, captures: 0, enPassant: 0, castles: 0, promotions: 0, checks: 0, result: null };
    for (let ply = 0; ; ply++) {
        const at = `seed ${seed} ply ${ply} (${R.sans().slice(-3).join(' ')})`;
        for (const A of adapters) {
            assertPosition(A, R, at);
            assertStatus(A, R, at);
            await assertOffers(A, R, at);
        }
        for (const A of adapters.slice(1)) {
            assert.equal(A.fen(), adapters[0].fen(), `${A.view} and ${adapters[0].view} positions, ${at}`);
            assert.deepEqual(A.moveList(), adapters[0].moveList(), `${A.view} and ${adapters[0].view} move lists, ${at}`);
            assert.deepEqual(A.result(), adapters[0].result(), `${A.view} and ${adapters[0].view} results, ${at}`);
        }
        const result = R.result();
        if (result.over) { stats.result = result.kind; break; }
        if (ply >= plies) break;
        const moves = [...R.legal().values()];
        let pick = rand() * moves.reduce((sum, m) => sum + WEIGHT(m), 0);
        const m = moves.find((x) => (pick -= WEIGHT(x)) < 0) || moves[moves.length - 1];
        for (const A of adapters) await A.move(m.uci);
        R.play(m.uci);
        stats.plies++;
        if (m.captured) stats.captures++;
        if (m.enPassant) stats.enPassant++;
        if (m.castling) stats.castles++;
        if (m.promotion) stats.promotions++;
        if (m.givesCheck) stats.checks++;
    }
    return stats;
}

const addStats = (total, s) => {
    for (const k of ['plies', 'captures', 'enPassant', 'castles', 'promotions', 'checks']) total[k] = (total[k] || 0) + s[k];
    total.results = total.results || {};
    const key = s.result || 'unfinished';
    total.results[key] = (total.results[key] || 0) + 1;
    return total;
};

module.exports = {
    defineTableChecks, defineRulesUiSuite, playout, addStats, PLAYOUT_STARTS, kingThenRook, pawnThenPawnBeside, pointerSweep, start, play, identifyMove, assertLocked, assertSquares, pieceMap,
};
