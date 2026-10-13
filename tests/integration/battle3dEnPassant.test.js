'use strict';
// En passant on the real 3D page (user report: "a pawn was capturing another pawn, but not diagonally,
// but sideways"). The capture was legal; the 3D view walked the attacker sideways to the pawn beside it.
//   A. What the player sees: the attacker moves diagonally onto the target square and strikes from there,
//      the removed pawn's square is marked, the move list says "e.p.", the rule is explained in one line the
//      first three times (also when the AI captures). Human as White and as Black, the AI, Full and Fast,
//      files a and h, two candidate pawns, check, mate; normal and promotion captures stay unlabelled.
//   B. En passant is never offered from a stale state: one move later, undo, "Take it back", review and
//      back, hint, "Show me better", new game, mode and side switches, a late or illegal AI answer
//      (which is asked for again and then replaced by a legal move, see battle3dAiRecovery.test.js).
//   C. The reported game, move for move (White vs the AI, coach on): 20. b4 axb3 e.p. in Fast and Full,
//      with what the coach and the kings say.
// Model position, unit positions and the unit grid are compared after every scenario.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootJourney } = require('../helpers/battle3dCoachJourney');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
const TIP = 'En passant: a pawn that just advanced two squares can be captured as if it had moved only one.';
const TO_YOU = 'En passant: your pawn moved two squares and landed beside their pawn, so it can be taken as if it had moved one.';
const BY_YOU = 'En passant: their pawn moved two squares and landed beside yours, so you can take it as if it had moved one.';
const AI_NOTE = 'The AI could not find a legal move, so a legal move was played for it.';
const SEEN_KEY = 'battle3d.enPassantSeen';
const FAST_MAX = 1.3, FULL_MAX = 5.5; // scene seconds, same budgets as battle3dFights.test.js

let J, P, $, st, sq, settle, idle, pause, fresh, human, ai, pendingAI, unitBoard, liveBoard;
let highlights = null;      // last sceneAPI.setHighlights argument
let notices = [];           // texts shown in the tip panel
let spoken = [];            // screen reader announcements (moves, then the coach when it is on)
let events = [];            // game:event objects
let captionAt = {};         // ply -> the kings' caption right after that move's events (same turn of the event loop)

const name = (s) => String.fromCharCode(97 + s.col) + (8 - s.row);
const rc = (s) => { const [row, col] = sq(s); return { row, col }; };
const world = (s) => { const { row, col } = rc(s); return { x: col - 3.5, z: row - 3.5 }; };
const unit = (s) => P.B.units.unitAt(rc(s).row, rc(s).col);
const piece = (s) => P.board()[rc(s).row][rc(s).col];
const epField = () => st().fen.split(' ')[3];
const moveList = () => [...$('move-list').querySelectorAll('.mv')].map((e) => e.textContent);
const legal = (s) => globalThis.generateLegalMoves(rc(s).row, rc(s).col).map((m) => name(m) + (m.isEnPassant ? ' e.p.' : ''));
const marker = () => P.B.sceneAPI.scene.getObjectByName('last-captured');
const assertSynced = (msg) => assert.equal(unitBoard(), liveBoard(), `${msg}: the 3D units match the model`);

// Squares the board offers after clicking a piece (highlight dots and capture rings); deselects again.
function offered(from) {
    P.B.controller.clickSquare(...sq(from));
    const moves = (highlights?.moves || []).map((m) => name(m) + (m.capture ? 'x' : ''));
    P.key('Escape');
    assert.equal(st().selected, null, 'deselected');
    return moves;
}

// Plays one move frame by frame and records the path of the unit that stood on the from square.
async function traced(move, start) {
    const A = unit(move.slice(0, 2));
    assert.ok(A, `a unit on ${move.slice(0, 2)}`);
    const n = st().history.length;
    const path = [];
    const statuses = new Set();
    let frames = 0, moving = 0;
    await start();
    for (; frames < 1500 && !(st().history.length === n + 1 && !st().moving); frames++) {
        P.B.step(1);
        if (st().moving) { moving++; statuses.add($('status-text').textContent); }
        path.push({ x: A.root.position.x, z: A.root.position.z });
        if (frames % 4 === 0) await pause(0); else await null;
    }
    assert.ok(st().history.length === n + 1 && !st().moving, `${move} was played and finished`);
    await idle();
    return { A, path, seconds: moving / 60, statuses: [...statuses] };
}
const byClicks = (move) => traced(move, async () => {
    P.B.controller.clickSquare(...sq(move.slice(0, 2)));
    P.B.controller.clickSquare(...sq(move.slice(2, 4)));
});
const byAI = async (move) => {
    await settle(() => !!pendingAI(), { ms: 6000, label: `AI request before ${move}` });
    return traced(move, async () => {
        const call = pendingAI();
        call.done = true;
        call.resolve({ from: rc(move.slice(0, 2)), to: rc(move.slice(2, 4)) });
    });
};

// The en passant choreography: the pawn makes its real move first (a straight diagonal onto the target
// square) and strikes the pawn it passed from there. It never moves along its own rank.
function assertDiagonalThenStrike(path, move, victim) {
    const f = world(move.slice(0, 2)), t = world(move.slice(2, 4)), v = world(victim);
    let arrived = -1;
    path.forEach((p, i) => {
        const side = (p.x - f.x) / (t.x - f.x), fwd = (p.z - f.z) / (t.z - f.z);
        if (arrived < 0) {
            assert.ok(Math.abs(side - fwd) < 0.06, `frame ${i}: on the diagonal (file ${side.toFixed(2)}, rank ${fwd.toFixed(2)})`);
            assert.ok(side > -0.02 && side < 1.02, `frame ${i}: between the two squares`);
            if (Math.hypot(p.x - t.x, p.z - t.z) < 0.03) arrived = i;
        } else {
            assert.ok(Math.abs(p.x - t.x) < 0.03, `frame ${i}: stays on the target file after arriving (x off by ${(p.x - t.x).toFixed(2)})`);
            assert.ok(Math.hypot(p.x - t.x, p.z - t.z) < 0.46, `frame ${i}: stays on the target square`);
        }
        assert.ok(!(Math.abs(p.z - f.z) < 0.02 && Math.abs(p.x - f.x) > 0.05), `frame ${i}: no sideways step along the start rank`);
    });
    assert.ok(arrived > 0, 'the attacker reaches the target square before the strike');
    const closest = Math.min(...path.slice(arrived).map((p) => Math.hypot(p.x - v.x, p.z - v.z)));
    assert.ok(closest < 0.75 && closest > 0.4, `the strike comes from the target square, toward the passed pawn (closest ${closest.toFixed(2)})`);
    const last = path[path.length - 1];
    assert.ok(Math.hypot(last.x - t.x, last.z - t.z) < 0.01, 'the attacker ends on the centre of the target square');
}

// Everything that must hold right after an en passant capture `move` that took the pawn on `victim`.
function assertEnPassantDone({ move, victim, san, A, V, mover }) {
    const from = move.slice(0, 2), to = move.slice(2, 4);
    assert.equal(piece(to), mover === 'w' ? 'P' : 'p', `model: the pawn stands on ${to}`);
    assert.equal(piece(from), null, `model: ${from} is empty`);
    assert.equal(piece(victim), null, `model: the passed pawn on ${victim} is gone`);
    assert.equal(epField(), '-', 'model: no en passant target after the capture');
    assertSynced(move);
    assert.equal(unit(to), A, 'the same unit that moved stands on the target square');
    assert.deepEqual(A.square, rc(to));
    assert.equal(unit(victim), null, `no unit on ${victim}`);
    assert.equal(unit(from), null, `no unit on ${from}`);
    assert.ok(!V.root.parent, 'the captured unit left the scene');
    assert.equal(st().history.at(-1), san, 'history keeps plain SAN');
    assert.equal(moveList().at(-1), `${san} e.p.`, 'the move list marks the capture as en passant');
    assert.deepEqual(highlights.lastMove, { from: rc(from), to: rc(to), captured: rc(victim) }, 'last-move highlight: from, to and the removed pawn\'s square');
    assert.equal(marker().visible, true, 'the removed square is framed on the board');
    assert.deepEqual([marker().position.x, marker().position.z], [world(victim).x, world(victim).z]);
    assert.ok(spoken.some((t) => t.includes(`takes pawn on ${victim} en passant`)), `screen reader announcement: ${JSON.stringify(spoken.slice(-3))}`);
    assert.ok(events.some((e) => e.type === 'enPassant' && e.color === mover), 'the kings get an enPassant event from the capturing side');
}

describe('battle3d en passant (real page)', { skip }, () => {
    before(async () => {
        J = await bootJourney({ settings: { coach: false } });
        ({ P, $, st, sq, settle, idle, pause, fresh, human, ai, pendingAI, unitBoard, liveBoard } = J);
        const S = P.B.sceneAPI, orig = S.setHighlights;
        S.setHighlights = (h) => { highlights = JSON.parse(JSON.stringify({ ...highlights, ...h })); return orig(h); };
        const tip = $('tip');
        const seen = () => { if (!tip.hidden) notices.push($('tip-text').textContent); };
        new P.w.MutationObserver(seen).observe(tip, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true, characterData: true });
        P.w.addEventListener('game:event', (e) => {
            events.push(e.detail);
            // The commentary decides in a microtask queued by the first event of a move; this one runs after it
            if (e.detail.type === 'moveDone') Promise.resolve().then(() => { captionAt[e.detail.ply] = $('captions').textContent; });
        });
        new P.w.MutationObserver(() => { const t = $('announce').textContent; if (t) spoken.push(t); }).observe($('announce'), { childList: true, characterData: true, subtree: true });
    });
    after(() => { if (J) J.restore(); });

    async function game(opts = {}) {
        await fresh({ mode: 'human-human', coach: false, talk: 'off', ...opts });
        if (opts.speed === 'full') $('speed-full').click();
        if (!opts.keepSeen) P.w.localStorage.removeItem(SEEN_KEY); // as on a device that never saw the rule
        $('tip').hidden = true;
        notices = [];
        events = [];
        spoken = [];
        captionAt = {};
    }
    async function position(fen) {
        await game();
        P.B.controller.loadFen(fen);
        await idle('position');
        notices = [];
        events = [];
    }
    const epNotices = () => notices.filter((t) => /^En passant:/.test(t));
    // Runs the scene until pred() holds. The budget is frames, not seconds: a busy machine makes this slower,
    // never wrong (the real 1 ms pauses only let the engine's timers fire).
    async function until(pred, what, frames = 12000) {
        for (let i = 0; i < frames && !pred(); i += 6) { P.B.step(6); await pause(1); }
        assert.ok(pred(), what);
    }
    const capturesReported = () => events.filter((e) => e.type === 'moveDone' && e.ev?.enPassant).length;
    const done = () => assert.deepEqual(P.errors, [], 'no console errors');

    describe('A. what the player sees', () => {
        test('a normal pawn capture: straight at the victim, no en passant label, no notice', async () => {
            await game();
            for (const m of ['e2e4', 'd7d5']) await human(m);
            const V = unit('d5');
            const { A, path } = await byClicks('e4d5');
            const f = world('e4'), t = world('d5');
            for (const p of path) assert.ok(Math.abs((p.x - f.x) / (t.x - f.x) - (p.z - f.z) / (t.z - f.z)) < 0.06, 'diagonal all the way');
            assert.equal(unit('d5'), A);
            assert.ok(!V.root.parent);
            assertSynced('exd5');
            assert.deepEqual(moveList(), ['e4', 'd5', 'exd5']);
            assert.deepEqual(highlights.lastMove, { from: rc('e4'), to: rc('d5') }, 'no extra square for a normal capture');
            assert.equal(marker().visible, false);
            assert.deepEqual(epNotices(), []);
            assert.equal(events.some((e) => e.type === 'enPassant'), false);
            done();
        });

        for (const speed of ['full', 'fast']) {
            test(`White takes en passant by clicks (${speed} battles): diagonal move, then the strike; labels and the rule in one line`, async (t) => {
                await game({ speed });
                for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await human(m);
                assert.equal(epField(), 'd6');
                assert.deepEqual(offered('e5'), ['e6', 'd6x'], 'e6 and the en passant capture on d6 are offered');
                const V = unit('d5');
                P.B.controller.clickSquare(...sq('e5'));
                const run = traced('e5d6', async () => {
                    P.B.controller.clickSquare(...sq('d6'));
                    // While the move plays: the status names it and the rule is explained
                    assert.equal($('status-text').textContent, 'En passant! White takes the pawn on d5.');
                    assert.equal($('tip').hidden, false, 'the explanation shows as the move starts');
                    assert.equal($('tip-text').textContent, TIP);
                });
                const { A, path, seconds } = await run;
                assertDiagonalThenStrike(path, 'e5d6', 'd5');
                assertEnPassantDone({ move: 'e5d6', victim: 'd5', san: 'exd6', A, V, mover: 'w' });
                assert.deepEqual(moveList(), ['e4', 'a6', 'e5', 'd5', 'exd6 e.p.']);
                assert.equal($('move-list').querySelector('.mv.last').title, TIP, 'the move list entry carries the rule as a tooltip');
                assert.deepEqual(epNotices(), [TIP], 'explained once');
                assert.match($('announce').textContent, /En passant: a pawn that just advanced two squares/, 'the rule is announced to screen readers the first time');
                assert.ok(seconds <= (speed === 'fast' ? FAST_MAX : FULL_MAX), `${speed}: ${seconds.toFixed(2)} s`);
                assert.equal(P.B.units.lastFightPlan(), speed === 'fast' ? 'fast' : 'enPassant');
                t.diagnostic(`${speed}: ${seconds.toFixed(2)} s of scene time`);
                done();
            });
        }

        test('the human as Black (flipped view) takes en passant against the AI', async () => {
            await game({ mode: 'human-ai', side: 'b' });
            await ai('a2a3'); await human('e7e5'); await ai('a3a4'); await human('e5e4'); await ai('d2d4');
            assert.equal(epField(), 'd3');
            assert.deepEqual(offered('e4'), ['e3', 'd3x']);
            const V = unit('d4');
            const { A, path } = await byClicks('e4d3');
            assertDiagonalThenStrike(path, 'e4d3', 'd4');
            assertEnPassantDone({ move: 'e4d3', victim: 'd4', san: 'exd3', A, V, mover: 'b' });
            assert.deepEqual(epNotices(), [BY_YOU], 'worded from the player\'s side');
            done();
        });

        test('the AI takes en passant against the human: same choreography, same explanation', async () => {
            await game({ mode: 'human-ai', side: 'w' });
            await human('a2a3'); await ai('e7e5'); await human('a3a4'); await ai('e5e4'); await human('d2d4');
            const V = unit('d4');
            const { A, path } = await byAI('e4d3');
            assertDiagonalThenStrike(path, 'e4d3', 'd4');
            assertEnPassantDone({ move: 'e4d3', victim: 'd4', san: 'exd3', A, V, mover: 'b' });
            assert.deepEqual(epNotices(), [TO_YOU], 'the rule is explained when the AI does it to the player, in the player\'s terms');
            assert.match($('announce').textContent, /your pawn moved two squares and landed beside their pawn/);
            assert.equal(st().turn, 'w');
            done();
        });

        test('files a and h, both colours', async () => {
            for (const [setup, move, victim, san, mover] of [
                [['b2b4', 'h7h6', 'b4b5', 'a7a5'], 'b5a6', 'a5', 'bxa6', 'w'],
                [['g2g4', 'a7a6', 'g4g5', 'h7h5'], 'g5h6', 'h5', 'gxh6', 'w'],
                [['h2h3', 'b7b5', 'h3h4', 'b5b4', 'a2a4'], 'b4a3', 'a4', 'bxa3', 'b'],
                [['a2a3', 'g7g5', 'a3a4', 'g5g4', 'h2h4'], 'g4h3', 'h4', 'gxh3', 'b'],
            ]) {
                await game();
                for (const m of setup) await human(m);
                const V = unit(victim);
                const { A, path } = await byClicks(move);
                assertDiagonalThenStrike(path, move, victim);
                assertEnPassantDone({ move, victim, san, A, V, mover });
            }
            done();
        });

        test('two pawns can take en passant onto the same square: each is offered, the chosen one moves', async () => {
            const setup = ['e2e4', 'a7a6', 'e4e5', 'b7b6', 'c2c4', 'h7h6', 'c4c5', 'd7d5'];
            for (const [move, san, stays] of [['c5d6', 'cxd6', 'e5'], ['e5d6', 'exd6', 'c5']]) {
                await game();
                for (const m of setup) await human(m);
                assert.ok(offered('c5').includes('d6x') && offered('e5').includes('d6x'), 'both pawns may capture on d6');
                const V = unit('d5'), other = unit(stays);
                const { A, path } = await byClicks(move);
                assertDiagonalThenStrike(path, move, 'd5');
                assertEnPassantDone({ move, victim: 'd5', san, A, V, mover: 'w' });
                assert.equal(piece(stays), 'P');
                assert.equal(unit(stays), other, `the pawn on ${stays} did not move`);
                assert.ok(Math.abs(other.root.position.x - world(stays).x) < 1e-6 && Math.abs(other.root.position.z - world(stays).z) < 1e-6);
            }
            done();
        });

        test('en passant that gives check, and en passant that mates', async () => {
            await position('8/3pk3/8/4P3/8/8/8/4K3 b - - 0 1');
            await human('d7d5');
            let V = unit('d5');
            let { A, path } = await byClicks('e5d6');
            assertDiagonalThenStrike(path, 'e5d6', 'd5');
            assertEnPassantDone({ move: 'e5d6', victim: 'd5', san: 'exd6+', A, V, mover: 'w' });
            assert.equal(moveList().at(-1), 'exd6+ e.p.');
            assert.match($('status-text').textContent, /Black is in check/);

            // The capture clears d5 and e5 at once: the rook on a5 mates along the rank
            await position('5B2/3pN3/8/R3P2k/8/6K1/8/8 b - - 0 1');
            await human('d7d5');
            V = unit('d5');
            ({ A, path } = await byClicks('e5d6'));
            assertDiagonalThenStrike(path, 'e5d6', 'd5');
            assertEnPassantDone({ move: 'e5d6', victim: 'd5', san: 'exd6#', A, V, mover: 'w' });
            assert.equal(moveList().at(-1), 'exd6# e.p.');
            assert.equal(st().over, true);
            assert.equal(st().result, 'checkmate');
            assert.match($('status-text').textContent, /Checkmate! White wins/);
            done();
        });

        test('a promotion by capture is an ordinary capture: no label, no notice, units in sync', async () => {
            await position('r1n1k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
            const V = unit('a8');
            P.B.controller.clickSquare(...sq('b7'));
            P.B.controller.clickSquare(...sq('a8'));
            assert.equal($('promo').hidden, false, 'promotion dialog');
            $('promo').querySelector('button[data-piece="Q"]').click();
            await settle(() => st().history.length === 1 && !st().moving, { ms: 6000, label: 'promotion' });
            await idle();
            assert.equal(piece('a8'), 'Q');
            assert.equal(piece('b7'), null);
            assertSynced('bxa8=Q');
            assert.equal(unit('a8').type, 'q');
            assert.ok(!V.root.parent);
            assert.deepEqual(moveList(), ['bxa8=Q']);
            assert.deepEqual(highlights.lastMove, { from: rc('b7'), to: rc('a8') });
            assert.deepEqual(epNotices(), []);
            done();
        });

        test('Skip, and opening a past position, in the middle of the en passant fight end on the right squares', async () => {
            for (const interrupt of ['skip', 'review']) {
                await game({ speed: 'full' });
                for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await human(m);
                const A = unit('e5'), V = unit('d5');
                P.B.controller.clickSquare(...sq('e5'));
                P.B.controller.clickSquare(...sq('d6'));
                for (let i = 0; i < 20; i++) { P.B.step(1); await null; } // about a third of the diagonal walk
                assert.equal(st().moving, true, 'still animating');
                if (interrupt === 'skip') $('skip').click();
                else $('move-list').querySelector('.mv[data-index="2"]').click(); // look at 1...a6 while the fight runs
                await settle(() => !st().moving, { ms: 6000, label: interrupt });
                if (interrupt === 'review') {
                    await settle(() => st().reviewIndex === 2, { label: 'the review opens after the move' });
                    assert.equal(unit('d7').color, 'b', 'the past position is shown');
                    $('review-exit').click();
                    await settle(() => st().reviewIndex === null, { label: 'return' });
                }
                await idle();
                assertSynced(interrupt);
                assert.equal(piece('d6'), 'P');
                assert.equal(piece('d5'), null);
                assert.equal(unit('d5'), null);
                assert.equal(unit('d6').type, 'p');
                assert.ok(Math.hypot(unit('d6').root.position.x - world('d6').x, unit('d6').root.position.z - world('d6').z) < 1e-6, 'the pawn stands on the centre of d6');
                if (interrupt === 'skip') assert.equal(unit('d6'), A);
                assert.ok(!V.root.parent, 'the captured unit left the scene');
                assert.equal(moveList().at(-1), 'exd6 e.p.');
                assert.deepEqual(highlights.lastMove, { from: rc('e5'), to: rc('d6'), captured: rc('d5') });
            }
            done();
        });

        test('the rule is explained the first three times on a device; later captures are only labelled', async () => {
            const twice = ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'a6a5', 'h2h4', 'a5a4', 'b2b4'];
            await game();
            for (const m of twice) await human(m);
            assert.deepEqual(epNotices(), [TIP], 'first en passant (White)');
            const V = unit('b4');
            const { A, path } = await byClicks('a4b3');
            assertDiagonalThenStrike(path, 'a4b3', 'b4');
            assertEnPassantDone({ move: 'a4b3', victim: 'b4', san: 'axb3', A, V, mover: 'b' });
            assert.deepEqual(epNotices(), [TIP, TIP], 'second en passant (Black), same game');
            assert.deepEqual(moveList().filter((m) => /e\.p\./.test(m)), ['exd6 e.p.', 'axb3 e.p.']);
            await game({ keepSeen: true });
            for (const m of twice) await human(m);
            assert.deepEqual(epNotices(), [TIP], 'third time: explained');
            await human('a4b3');
            assert.deepEqual(epNotices(), [TIP], 'fourth time: no notice any more');
            assert.equal(P.w.localStorage.getItem(SEEN_KEY), '3');
            assert.equal(moveList().at(-1), 'axb3 e.p.', 'still labelled');
            assert.deepEqual(highlights.lastMove, { from: rc('a4'), to: rc('b3'), captured: rc('b4') }, 'still marked');
            assert.match(spoken.at(-1), /takes pawn on b4 en passant\.$/, 'announced without the rule');
            done();
        });

        test('review: the en passant move keeps its label and its three marked squares; returning restores the live marks', async () => {
            await game();
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'h7h6']) await human(m);
            const live = liveBoard(), fen = st().fen;
            $('move-list').querySelector('.mv[data-index="5"]').click();
            await settle(() => st().reviewIndex === 5, { label: 'review of exd6' });
            assert.deepEqual(highlights.lastMove, { from: rc('e5'), to: rc('d6'), captured: rc('d5') });
            assert.equal(marker().visible, true);
            assert.equal(highlights.check, null);
            assert.match($('status-text').textContent, /^Reviewing 3\. exd6 e\.p\. Esc returns to the game\.$/);
            assert.equal(unit('d5'), null, 'the past position after the capture has no pawn on d5');
            assert.equal(unit('d6').type, 'p');
            // The position before the capture: both pawns stand side by side
            $('move-list').querySelector('.mv[data-index="4"]').click();
            await settle(() => st().reviewIndex === 4, { label: 'review of d5' });
            assert.equal(unit('d5').color, 'b');
            assert.equal(unit('e5').color, 'w');
            assert.deepEqual(highlights.lastMove, { from: rc('d7'), to: rc('d5') });
            assert.equal(marker().visible, false);
            await human('e5d6', { expectMove: false });
            assert.equal(st().history.length, 6, 'no move can be made in the past');
            $('review-exit').click();
            await settle(() => st().reviewIndex === null, { label: 'return to game' });
            await idle();
            assert.equal(st().fen, fen);
            assert.equal(unitBoard(), live, 'the live position is back on the board');
            assert.deepEqual(highlights.lastMove, { from: rc('h7'), to: rc('h6') });
            assert.equal(marker().visible, false);
            // The coach's review list uses the same label
            await J.openReview();
            assert.ok(J.listed().some((b) => b.textContent.includes('exd6 e.p.')), `review list: ${J.listed().map((b) => b.textContent)}`);
            P.B.coach.closeReview();
            done();
        });
    });

    describe('B. en passant is not offered from a stale state', () => {
        const notOffered = (from, to, msg) => {
            assert.equal(legal(from).some((m) => m.startsWith(to)), false, `${msg}: the rules do not allow ${from}${to}`);
            assert.equal(offered(from).some((m) => m.startsWith(to)), false, `${msg}: the board does not offer ${from}${to}`);
        };

        test('the right lasts one move: declined once, it is gone, and clicking the square does nothing', async () => {
            await game();
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await human(m);
            assert.deepEqual(legal('e5'), ['e6', 'd6 e.p.']);
            for (const m of ['h2h3', 'h7h6']) await human(m);
            assert.equal(epField(), '-');
            notOffered('e5', 'd6', 'one move later');
            await human('e5d6', { expectMove: false });
            await pause(20);
            assert.equal(st().history.length, 6, 'no move was made');
            assert.equal(piece('d5'), 'p');
            assert.equal(piece('e5'), 'P');
            assertSynced('declined');
            assert.deepEqual(epNotices(), []);
            done();
        });

        test('a single-step pawn beside it cannot be taken en passant; taking it on its own square is a normal capture', async () => {
            await game();
            for (const m of ['e2e4', 'd7d6', 'e4e5', 'a7a6']) await human(m);
            assert.equal(epField(), '-');
            const V = unit('d6');
            await human('e5d6');
            assert.deepEqual(moveList().at(-1), 'exd6');
            assert.ok(!V.root.parent);
            assert.deepEqual(highlights.lastMove, { from: rc('e5'), to: rc('d6') });
            // d7-d6-d5 in two steps: the pawns stand side by side, but nothing may be taken in passing
            await game();
            for (const m of ['e2e4', 'd7d6', 'e4e5', 'd6d5']) await human(m);
            assert.equal(piece('d5'), 'p');
            assert.equal(epField(), '-');
            notOffered('e5', 'd6', 'pawn arrived in two single steps');
            done();
        });

        test('undo: back to the position with the right it is offered again; one step further back it is not', async () => {
            await game();
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6']) await human(m);
            $('undo').click();
            await idle('undo');
            assert.deepEqual(st().history, ['e4', 'a6', 'e5', 'd5']);
            assert.equal(piece('d5'), 'p', 'the captured pawn is back');
            assert.equal(piece('e5'), 'P');
            assert.equal(piece('d6'), null);
            assertSynced('undo of the capture');
            assert.equal(epField(), 'd6');
            assert.ok(offered('e5').includes('d6x'), 'offered again: this is the position right after the double step');
            assert.deepEqual(moveList(), ['e4', 'a6', 'e5', 'd5']);
            assert.deepEqual(highlights.lastMove, { from: rc('d7'), to: rc('d5') });
            assert.equal(marker().visible, false);
            $('undo').click();
            await idle('undo');
            assert.equal(epField(), '-');
            assert.equal(st().turn, 'b');
            await human('h7h6');
            notOffered('e5', 'd6', 'before the double step');
            assertSynced('second undo');
            done();
        });

        test('human vs AI: Undo and "Take it back" (undoTo) clear the right; a different AI reply does not bring it back', async () => {
            await game({ mode: 'human-ai', side: 'w' });
            await human('e2e4'); await ai('a7a6'); await human('e4e5'); await ai('d7d5');
            assert.ok(offered('e5').includes('d6x'));
            $('undo').click(); // two plies: back to White's second move
            await idle('undo');
            assert.deepEqual(st().history, ['e4', 'a6']);
            assert.equal(epField(), '-');
            await human('e4e5'); await ai('h7h6');
            notOffered('e5', 'd6', 'after undo and another reply');
            // The coach's "Take it back" goes through controller.undoTo
            await human('a2a3'); await ai('d7d5');
            assert.equal(epField(), 'd6');
            assert.equal(P.B.controller.undoTo(4), true);
            await idle('take back');
            assert.deepEqual(st().history, ['e4', 'a6', 'e5', 'h6']);
            assert.equal(epField(), '-');
            notOffered('e5', 'd6', 'after Take it back');
            assertSynced('take back');
            done();
        });

        test('review and back, hint and "Show me better" never change what is offered', async () => {
            await game();
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await human(m);
            const fen = st().fen;
            $('move-list').querySelector('.mv[data-index="2"]').click();
            await settle(() => st().reviewIndex === 2, { label: 'review' });
            assert.equal(st().fen, fen, 'looking at the past does not touch the game');
            await human('e5d6', { expectMove: false });
            assert.equal(st().history.length, 4);
            $('review-exit').click();
            await settle(() => st().reviewIndex === null, { label: 'return' });
            await idle();
            assertSynced('after review');
            assert.ok(offered('e5').includes('d6x'), 'still offered after returning: the live position did not change');
            // Hint: the engine suggests the capture; nothing is played
            $('hint').click();
            await settle(() => !!pendingAI(), { label: 'hint request' });
            assert.deepEqual(pendingAI().state.enPassantTarget, rc('d6'), 'the hint engine gets the live en passant square');
            const call = pendingAI(); call.done = true; call.resolve({ from: rc('e5'), to: rc('d6') });
            await settle(() => !!st().hint, { label: 'hint shown' });
            assert.equal($('status-text').textContent, 'Hint: pawn to d6, capture en passant.');
            assert.equal(st().fen, fen);
            P.key('Escape');
            // One move later the same suggestion is refused
            for (const m of ['h2h3', 'h7h6']) await human(m);
            assert.equal(P.B.controller.showSuggestion({ from: rc('e5'), to: rc('d6') }), false, '"Show me better" cannot show an expired en passant');
            notOffered('e5', 'd6', 'after hint and review');
            done();
        });

        test('new game, mode and side switches', async () => {
            await game({ mode: 'human-ai', side: 'w' });
            await human('e2e4'); await ai('a7a6'); await human('e4e5'); await ai('d7d5');
            // Mode switch and back: same position, same right
            J.setSelect('mode-select', 'human-human');
            assert.ok(offered('e5').includes('d6x'));
            J.setSelect('mode-select', 'human-ai');
            // Side switch: the AI now has White and gets the live en passant square
            $('side-b').click();
            await settle(() => !!pendingAI(), { ms: 6000, label: 'AI request as White' });
            assert.deepEqual(pendingAI().state.enPassantTarget, rc('d6'));
            assert.equal(pendingAI().state.currentPlayer, 'w');
            const V = unit('d5');
            const { A, path } = await byAI('e5d6');
            assertDiagonalThenStrike(path, 'e5d6', 'd5');
            assertEnPassantDone({ move: 'e5d6', victim: 'd5', san: 'exd6', A, V, mover: 'w' });
            // New game from a position with the right pending
            await game();
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await human(m);
            $('new-game').click();
            await idle('new game');
            assert.equal(epField(), '-');
            assert.deepEqual(moveList(), []);
            assert.equal(marker().visible, false);
            for (const m of ['e2e4', 'a7a6', 'e4e5', 'h7h6']) await human(m);
            notOffered('e5', 'd6', 'new game');
            done();
        });

        test('an AI answer that arrives late is dropped; one that is not legal (sideways pawn capture, expired en passant) is never played', async () => {
            await game({ mode: 'human-ai', side: 'w' });
            await human('e2e4'); await ai('a7a6'); await human('e4e5');
            await settle(() => !!pendingAI(), { ms: 6000, label: 'AI request' });
            const late = pendingAI();
            $('undo').click(); // the human move is taken back while the AI thinks
            await idle('undo');
            late.done = true;
            late.resolve({ from: rc('d7'), to: rc('d5') });
            for (let i = 0; i < 10; i++) { P.B.step(6); await pause(1); }
            assert.deepEqual(st().history, ['e4', 'a6'], 'the late answer is dropped');
            assert.equal(st().turn, 'w');

            // The AI insists on an illegal move: rejected and logged, asked again, then the rules move for it
            const refuse = async (from, to, what) => {
                const before = { history: st().history.slice(), fen: st().fen, units: unitBoard() };
                for (const attempt of [1, 2]) {
                    await settle(() => !!pendingAI(), { ms: 6000, label: `AI request ${attempt}` });
                    const call = pendingAI(); call.done = true; call.resolve({ from: rc(from), to: rc(to) });
                    await pause(2);
                    if (attempt === 1) {
                        assert.deepEqual(st().history, before.history, `${what}: not played`);
                        assert.equal(st().fen, before.fen);
                        assert.equal(unitBoard(), before.units, `${what}: the units did not move`);
                    }
                }
                await settle(() => st().history.length === before.history.length + 1 && !st().moving, { ms: 6000, label: 'the legal move played for the AI' });
                await idle();
                assert.equal(P.errors.length, 2, 'both refusals are logged');
                for (const e of P.errors) assert.ok(e.includes(`AI move rejected: ${from}${to} in ${before.fen}`), e);
                P.errors.length = 0;
                assert.equal(piece(from), 'p', `${what}: the pawn that was told to make it has not moved`);
                assert.equal(st().turn, 'w', 'the game goes on with the player to move');
                assert.ok(notices.includes(AI_NOTE), `a notice says a legal move was played: ${JSON.stringify(notices)}`);
                assert.doesNotMatch($('status-text').textContent, /error/i);
                assertSynced(what);
            };
            // Black pawn d5 beside White's e5: taking it sideways is not a move
            await human('e4e5'); await ai('d7d6'); await human('a2a3'); await ai('d6d5'); await human('a3a4');
            await refuse('d5', 'e5', 'sideways pawn capture');
            assert.equal(piece('e5'), 'P', 'the pawn beside it was not taken');
            // White's d2-d4 passed e4 two moves ago: the right has expired
            await game({ mode: 'human-ai', side: 'w' });
            await human('a2a3'); await ai('e7e5'); await human('a3a4'); await ai('e5e4'); await human('d2d4'); await ai('h7h6'); await human('h2h3');
            await refuse('e4', 'd3', 'expired en passant');
            assert.equal(piece('d4'), 'P', 'the pawn that was passed is still on d4');
            assert.equal(piece('d3'), null);
            done();
        });
    });

    // The game from the user's report ("a pawn was capturing another pawn, but not diagonally, but sideways"):
    // 3D view, White against the AI, coach on "Every move", kings on Occasional. The last move is en passant.
    describe('C. the reported game: 20. b4 axb3 e.p.', () => {
        const GAME = ('e2e4 d7d6 f1b5 b8c6 h2h3 g8f6 b1c3 f6e4 c3e4 c8h3 h1h3 e7e6 d2d4 f8e7 f2f4 e7h4 e1f1 d6d5 e4c5 h4e1 f1e1 e6e5 ' +
            'c5b7 d8f6 d4e5 f6e6 d1d3 e8g8 d3c3 c6e7 c3c7 e6h3 g2h3 e7f5 b5d7 a7a5 d7f5 a5a4 b2b4 a4b3').split(' ');
        const SAN = ('e4 d6 Bb5+ Nc6 h3 Nf6 Nc3 Nxe4 Nxe4 Bxh3 Rxh3 e6 d4 Be7 f4 Bh4+ Kf1 d5 Nc5 Be1 Kxe1 e5 Nxb7 Qf6 dxe5 Qe6 ' +
            'Qd3 O-O Qc3 Ne7 Qxc7 Qxh3 gxh3 Nf5 Bd7 a5 Bxf5 a4 b4 axb3').split(' ');
        const NOTE = 'Their pawn on a4 can now take this pawn en passant, as if it had moved only one square.';

        // 20. b4 by the player, then what the coach says about it while the AI thinks
        async function playB4() {
            const before = J.shows();
            await human('b2b4');
            assert.equal(epField(), 'b3');
            const said = await J.feedbackSince(before, { ms: 4000 });
            assert.ok(said.ok, `a verdict on 20. b4: ${JSON.stringify(said)}`);
            assert.equal($('coach-move').textContent, '20. b4');
            assert.ok(said.text.includes(NOTE), `the verdict says the pawn can be taken en passant: "${said.text}"`);
        }
        // 20...axb3 by the AI, then everything the player sees
        async function aiTakes(speed) {
            const V = unit('b4');
            const { A, path, seconds, statuses } = await byAI('a4b3');
            assertDiagonalThenStrike(path, 'a4b3', 'b4');
            assertEnPassantDone({ move: 'a4b3', victim: 'b4', san: 'axb3', A, V, mover: 'b' });
            assert.ok(statuses.includes('En passant! Black takes the pawn on b4.'), `status while it plays: ${JSON.stringify(statuses)}`);
            assert.ok(seconds <= (speed === 'fast' ? FAST_MAX : FULL_MAX), `${speed}: ${seconds.toFixed(2)} s`);
            assert.equal(P.B.units.lastFightPlan(), speed === 'fast' ? 'fast' : 'enPassant');
            assert.equal(st().fen, 'r4rk1/1NQ2ppp/8/3pPB2/5P2/1p5P/P1P5/R1B1K1N1 w - - 0 21');
            assert.deepEqual(st().history, SAN, 'stored notation is standard SAN');
            assert.equal(moveList().at(-1), 'axb3 e.p.');
            assert.equal($('move-list').querySelector('.mv.last').textContent, 'axb3 e.p.', 'the highlighted move list entry is marked');
            return seconds;
        }

        test('replayed move for move: the AI takes en passant on move 20 (Fast, then Full after Undo)', async (t) => {
            await game({ mode: 'human-ai', side: 'w', coach: true, frequency: 'every', talk: 'occasional' });
            for (let i = 0; i < 38; i++) { if (i % 2 === 0) await human(GAME[i]); else await ai(GAME[i]); }
            assert.deepEqual(st().history, SAN.slice(0, 38));
            assert.equal(st().fen, 'r4rk1/1NQ2ppp/8/3pPB2/p4P2/7P/PPP5/R1B1K1N1 w - - 0 20');
            await playB4();
            notices = [];
            events = [];
            const fast = await aiTakes('fast');
            assert.deepEqual(epNotices(), [TO_YOU], 'the rule, in the player\'s terms, as the capture starts');
            // Coach and kings react to the move's events, which follow its analysis: wait for the events themselves
            await until(() => capturesReported() === 1, 'the capture was reported (moveDone)');
            await null; await null;
            // The coach: the card still shows the player's 20. b4, now with a line about the reply
            assert.ok(J.card().warning.includes(TO_YOU), `the coach explains the AI's en passant: "${J.card().warning}"`);
            assert.equal($('coach-move').textContent, '20. b4');
            // The capturing king names it, whatever was said on the moves before
            assert.ok(events.some((e) => e.type === 'enPassant' && e.color === 'b' && e.isAI));
            assert.match(captionAt[40], /^The Skeleton King: .*(passant|passing)/i, 'the king\'s remark, said with the move\'s events');
            await pause(120); // a later "before you move" warning may join the coach's line, never replace it
            assert.ok(J.card().warning.includes(TO_YOU));
            assert.match($('captions').textContent, /^The Skeleton King: .*(passant|passing)/i, 'and no stale remark replaces it');

            // The same move with Full battles
            $('undo').click();
            await idle('undo');
            assert.deepEqual(st().history, SAN.slice(0, 38), 'Undo takes back 20. b4 axb3');
            assert.equal(piece('b2'), 'P');
            assert.equal(piece('a4'), 'p');
            assertSynced('undo of the en passant');
            $('speed-full').click();
            await playB4();
            notices = [];
            const full = await aiTakes('full');
            assert.deepEqual(epNotices(), [TO_YOU], 'second time on this device: explained again');
            await until(() => capturesReported() === 2, 'the second capture was reported');
            await null; await null;
            assert.ok(J.card().warning.includes(TO_YOU), 'the coach explains it too');
            t.diagnostic(`20...axb3 e.p.: fast ${fast.toFixed(2)} s, full ${full.toFixed(2)} s of scene time`);
            $('speed-fast').click();
            done();
        });
    });
});

// Controller alone (fake scene and units): the marks of a reviewed position survive pointer movement.
describe('battle3d en passant: review marks (controller)', () => {
    test('hovering while reviewing keeps the reviewed move\'s squares and shows no check from the live game', async () => {
        const C = await loadBattle3dController();
        try {
            C.controller.setMode('human-human');
            // 3.exd6 e.p., later 5.cxd8=Q+: the live position has Black in check
            for (const mv of ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6', 'h7h6', 'd6c7', 'h6h5', 'c7d8q']) await C.play(mv);
            const last = () => C.scene.calls.setHighlights.at(-1);
            assert.deepEqual(last().check, square('e8'), 'live: the checked king is marked');
            assert.deepEqual(C.state().history.slice(4, 5), ['exd6']);
            assert.equal(C.controller.enterReview(5), true);
            const marks = { from: square('e5'), to: square('d6'), captured: square('d5') };
            assert.deepEqual(last().lastMove, marks);
            assert.equal(last().check, null);
            C.scene.hover(4, 4);
            await C.flush();
            C.controller.refresh();
            assert.deepEqual(last().lastMove, marks, 'still the reviewed move, not the live last move');
            assert.equal(last().check, null, 'no check glow from the live position on a past board');
            C.controller.exitReview();
            await C.flush();
            assert.deepEqual(last().lastMove, { from: square('c7'), to: square('d8') });
            assert.deepEqual(last().check, square('e8'));
            assert.deepEqual(C.errors, []);
        } finally { C.close(); }
    });
});

// The coach called 20. b4 "Best" in the reported game: with White 19 pawns up every move keeps the win chance.
describe('battle3d coach verdicts: "best" needs more than an unchanged win chance (controller)', () => {
    const GAME = ('e2e4 d7d6 f1b5 b8c6 h2h3 g8f6 b1c3 f6e4 c3e4 c8h3 h1h3 e7e6 d2d4 f8e7 f2f4 e7h4 e1f1 d6d5 e4c5 h4e1 f1e1 e6e5 ' +
        'c5b7 d8f6 d4e5 f6e6 d1d3 e8g8 d3c3 c6e7 c3c7 e6h3 g2h3 e7f5 b5d7 a7a5 d7f5 a5a4 b2b4').split(' ');
    const move = (uci) => ({ from: square(uci.slice(0, 2)), to: square(uci.slice(2, 4)) });

    test('20. b4 (engine: Nd6, 1.8 pawns better) is "good"; the engine\'s own move, or one level with it, stays "best"', async () => {
        const C = await loadBattle3dController();
        try {
            C.controller.setMode('human-human');
            for (const mv of GAME) await C.play(mv);
            assert.equal(C.state().history.at(-1), 'b4');
            // Evals as the real engine gives them here (200 000 nodes): +19.58 before (Nd6), +17.79 after b4 (axb3 e.p.)
            let before;
            C.w.requestAnalysis = (state) => ({
                promise: Promise.resolve(state.currentPlayer === 'w' ? before : { eval: 1779, bestMove: move('a4b3'), alternatives: [] }),
                cancel() {},
            });
            before = { eval: 1958, bestMove: move('b7d6'), alternatives: [{ move: move('b7d6'), eval: 1958 }, { move: move('c7d6'), eval: 1953 }] };
            let j = await C.controller.judgePly(39, { nodes: 1000, multiPv: 3 });
            assert.equal(j.playedBest, false);
            assert.equal(j.classification, 'good', 'not the engine\'s move and 179 centipawns behind it');
            assert.equal(j.enPassant, false, '20. b4 itself is not en passant');
            before = { eval: 1958, bestMove: move('b2b4'), alternatives: [{ move: move('b2b4'), eval: 1958 }] };
            j = await C.controller.judgePly(39, { nodes: 2000, multiPv: 3 });
            assert.equal(j.classification, 'best', 'the engine\'s own choice');
            before = { eval: 1958, bestMove: move('b7d6'), alternatives: [{ move: move('b7d6'), eval: 1958 }, { move: move('b2b4'), eval: 1940 }] };
            j = await C.controller.judgePly(39, { nodes: 3000, multiPv: 3 });
            assert.equal(j.classification, 'best', 'level with the engine\'s choice in the same search');
            // The reply itself is recognised as en passant from the history
            await C.play('a4b3');
            const info = JSON.parse(JSON.stringify(C.controller.plyInfo(40)));
            assert.deepEqual([info.enPassant, info.captured, info.capturedSquare, info.notation], [true, 'P', square('b4'), 'axb3 e.p.']);
            assert.equal(C.state().history.at(-1), 'axb3', 'history stays standard SAN');
            assert.equal(C.get('gameHistory[40].moveNotation'), 'axb3');
            assert.deepEqual(C.get('gameHistory[40].lastMove'), { from: square('a4'), to: square('b3') });
            assert.deepEqual(C.errors, []);
        } finally { C.close(); }
    });
});

