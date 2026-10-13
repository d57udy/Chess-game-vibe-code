'use strict';
// Click targets on a touch screen (coarse pointer): the pick proxies are larger there (radius 0.4, height
// 1.0), so before the fix a unit took even more of the square behind it. Real touch pointer events on the
// real page, booted as a phone would boot it. See battle3dClickTargets.test.js for the rule.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
const name = (s) => (s ? String.fromCharCode(97 + s.col) + (8 - s.row) : null);
const sameSq = (p, q) => !!p && !!q && p.row === q.row && p.col === q.col;
const SWEEP = {
    w: ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r3k2r/pp3ppp/2n1bn2/q2pp3/1b2P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 9',
        '4k3/P6P/8/3pP3/8/8/p6p/4K3 w - d6 0 1'],
    b: ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        'r3k2r/pp3ppp/2n1bn2/q2pp3/1b2P3/2NPBN2/PPPQ1PPP/R3K2R b KQkq - 0 9',
        '4k3/P6P/8/8/3pP3/8/p6p/4K3 b - e3 0 1'],
};

describe('battle3d click targets on a touch screen (real page, coarse pointer)', { skip }, () => {
    let P, B, S, canvas;
    const realSetTimeout = setTimeout;
    const pause = (ms) => new Promise((r) => realSetTimeout(r, ms));
    before(async () => {
        P = await bootPage({
            setup(w) {
                w.localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', speed: 'fast', talk: 'off', coach: false }));
                w.localStorage.setItem('battle3d.tipSeen', '1');
                const plain = w.matchMedia;
                w.matchMedia = (q) => ({ ...plain(q), matches: /pointer:\s*coarse/.test(q) });
            },
        });
        B = P.B; S = B.sceneAPI; canvas = P.renderer.domElement;
    });
    after(() => { if (P) P.restore(); });

    const st = () => P.state();
    const selected = () => name(st().selected);
    async function position(fen, side = 'w') {
        P.$(side === 'w' ? 'side-w' : 'side-b').click();
        B.controller.loadFen(fen);
        for (let i = 0; i < 900 && (S.isCameraBusy() || i < 20); i++) { B.step(1); if (i % 30 === 0) await pause(0); }
        P.errors.length = 0;
    }
    const at = (x, y, z) => {
        const point = new S.THREE.Vector3(x, y, z);
        S.camera.updateMatrixWorld();
        point.project(S.camera);
        const rect = canvas.getBoundingClientRect();
        return { clientX: rect.left + (point.x + 1) / 2 * rect.width, clientY: rect.top + (1 - point.y) / 2 * rect.height };
    };
    const detailAt = (x, z, y = 0) => { const p = at(x, y, z); return S.pickAt(p.clientX, p.clientY, true); };
    // A tap. The clock moves on first (a frame runs, the figures breathe), so two taps in a row are never read
    // as a double tap, which zooms. `settled` skips that when the caller has just looked at what is under the point.
    function tap(x, z, y = 0, settled = false) {
        if (!settled) P.tick(400);
        const init = { ...at(x, y, z), pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true };
        const down = new globalThis.PointerEvent('pointerdown', init), up = new globalThis.PointerEvent('pointerup', init);
        for (const e of [down, up]) Object.defineProperty(e, 'pointerType', { value: 'touch' });
        canvas.dispatchEvent(down);
        canvas.dispatchEvent(up);
    }
    const tapUnit = (sq) => { const s = square(sq); tap(s.col - 3.5, s.row - 3.5, 0.45); };
    const tapMiddle = (sq) => { const s = square(sq); tap(s.col - 3.5, s.row - 3.5); };
    async function played(n) {
        for (let i = 0; i < 600 && !(st().history.length === n && !st().moving); i++) { B.step(2); if (i % 10 === 0) await pause(0); }
        assert.ok(st().history.length === n && !st().moving, `move ${n} was played`);
    }

    test('the page runs with the touch-sized proxies', () => {
        assert.equal(S.isCoarsePointer(), true);
        const unit = B.units.unitAt(6, 4);
        assert.ok(Math.abs(unit.proxy.geometry.parameters.radiusTop - 0.4) < 1e-9 && Math.abs(unit.proxy.geometry.parameters.height - 1.0) < 1e-9);
    });

    test('the four reported cases by taps: en passant square and pawn, a pawn\'s step, Nf3 behind f2, a promotion', async () => {
        for (const target of ['d6', 'd5']) {
            await position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
            tapUnit('e5');
            assert.equal(selected(), 'e5');
            if (target === 'd6') tapMiddle('d6'); else tapUnit('d5');
            await played(1);
            assert.deepEqual(st().history, ['exd6'], `tap on ${target}`);
        }
        await position('4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1');
        tapUnit('e2');
        tapMiddle('e3');
        await played(1);
        assert.deepEqual(st().history, ['e3']);
        await position('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        tapUnit('g1');
        assert.equal(selected(), 'g1');
        tapMiddle('f3');
        await played(1);
        assert.deepEqual(st().history, ['Nf3']);
        await position('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        tapUnit('a7');
        tapMiddle('a8');
        assert.equal(P.$('promo').hidden, false);
        assert.deepEqual(JSON.parse(JSON.stringify(st().pendingPromotion.to)), square('a8'));
        P.$('promo-cancel').click();
        // Black's side
        await position('4k3/3pp3/8/8/8/8/8/4K3 b - - 0 1', 'b');
        tapUnit('e7');
        tapMiddle('e6');
        await played(1);
        assert.deepEqual(st().history, ['e6']);
        assert.deepEqual(P.errors, []);
    });

    test('sweep by taps: a tap on every offered target of every piece plays that move, from both sides', async (t) => {
        let targets = 0, middle = 0;
        for (const side of ['w', 'b']) {
            for (const fen of SWEEP[side]) {
                await position(fen, side);
                const board = P.board();
                const list = [];
                for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
                    const piece = board[row][col];
                    if (!piece || (piece === piece.toUpperCase() ? 'w' : 'b') !== side) continue;
                    for (const m of globalThis.generateLegalMoves(row, col)) list.push({ from: { row, col }, to: { row: m.row, col: m.col }, promotion: !!m.isPromotion });
                }
                for (const { from, to, promotion } of list) {
                    const label = `${fen.split(' ')[0]} ${side} ${name(from)}${name(to)}`;
                    B.controller.loadFen(fen);
                    B.controller.clickSquare(from.row, from.col);
                    P.tick(400);
                    // The middle of the square, or beside the figure that stands over it
                    const cx = to.col - 3.5, cz = to.row - 3.5;
                    const free = (x, z) => { const d = detailAt(x, z); return d && (sameSq(d.marker, to) || !d.figure || sameSq(d.figure, to)); };
                    let point = free(cx, cz) ? { x: cx, z: cz, middle: true } : null;
                    for (const dz of [-0.36, 0.36, -0.2, 0.2, 0]) for (const dx of [0, -0.3, 0.3]) if (!point && free(cx + dx, cz + dz)) point = { x: cx + dx, z: cz + dz };
                    assert.ok(point, `${label}: some part of the target square is free of other figures`);
                    tap(point.x, point.z, 0, true);
                    if (promotion) assert.deepEqual(JSON.parse(JSON.stringify(st().pendingPromotion)), { from, to }, `${label}: promotion dialog`);
                    else assert.deepEqual(JSON.parse(JSON.stringify(globalThis.battle3dLastMove())), { from, to }, `${label}: played`);
                    targets++;
                    if (point.middle) middle++;
                }
            }
        }
        assert.ok(targets >= 140 && middle / targets > 0.95, `${middle}/${targets}`); // the rest: capture squares with a figure in front over the middle
        t.diagnostic(`${targets} targets by taps, ${middle} on the middle of the square`);
        assert.deepEqual(P.errors, []);
    });

    test('nothing selected: a tap on a square with one of the mover\'s pieces picks that piece, not the neighbour whose proxy it crosses', async () => {
        await position('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        const cases = [];
        for (let col = 0; col < 8; col++) {
            for (const dz of [-0.4, -0.25, 0.25, 0.4]) for (const dx of [-0.35, 0, 0.35]) {
                const x = col - 3.5 + dx, z = 6 - 3.5 + dz; // points on the board of the second-rank squares
                const d = detailAt(x, z);
                if (d && !d.figure && sameSq(d.ground, { row: 6, col }) && !sameSq(d, d.ground)) cases.push({ x, z, own: d.ground, crossed: { row: d.row, col: d.col } });
            }
        }
        assert.ok(cases.length >= 8, `points on a pawn's square where the proxy of a neighbour is crossed first: ${cases.length}`);
        for (const c of cases.slice(0, 16)) {
            P.tick(400);
            const now = detailAt(c.x, c.z);
            if (now.figure || sameSq(now, now.ground)) continue; // the figures moved a little since the scan
            tap(c.x, c.z, 0, true);
            assert.equal(selected(), name(c.own), `the pawn on ${name(c.own)}, not the unit on ${name(c.crossed)}`);
            B.controller.clickSquare(c.own.row, c.own.col); // put down
            assert.equal(selected(), null);
        }
        // The generous proxy stays: a tap that only meets a unit's proxy over an empty square selects that unit
        const loose = [];
        for (let col = 0; col < 8; col++) for (const dz of [-0.45, -0.3, -0.15]) {
            const x = col - 3.5, z = 5 - 3.5 + dz + 0.5; // the near part of the third rank, behind the pawns
            const d = detailAt(x, z);
            if (d && !d.figure && d.ground && d.ground.row === 5 && d.row === 6) loose.push({ x, z, unit: { row: d.row, col: d.col } });
        }
        assert.ok(loose.length >= 4, `points over an empty square inside a pawn's proxy: ${loose.length}`);
        for (const c of loose.slice(0, 8)) {
            P.tick(400);
            const now = detailAt(c.x, c.z);
            if (now.figure || !sameSq(now, c.unit) || !now.ground || now.ground.row !== 5) continue;
            tap(c.x, c.z, 0, true);
            assert.equal(selected(), name(c.unit), 'easy to pick: the proxy is enough');
            B.controller.clickSquare(c.unit.row, c.unit.col);
        }
        assert.deepEqual(P.errors, []);
    });
});
