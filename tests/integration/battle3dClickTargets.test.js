'use strict';
// What a click means when a unit stands between the camera and an offered square. A unit's pick proxy is
// larger than the figure and covers the middle of the square behind it, so a click on that square's move
// marker used to land on the unit in front: the en passant square behind the pawn it captures, every
// one-step pawn move away from the viewer, Nf3 behind the f2 pawn, a promotion push.
// Now the scene reports the board square under the pointer, the unit whose drawn figure the pointer is on, and
// the move dot it is on (dots are drawn over figures and labels); the controller plays the dot, else the
// offered square unless the pointer is on a figure.
//   1. Real pointer events on the real page: marker clicks play the move, clicks on a figure keep their
//      meaning, the far rank, and a sweep over the middle of every offered target of every piece in a set
//      of positions from both sides (default views played out, turned / tilted / zoomed views resolved).
//   2. The controller's rules alone (fake scene): which of picked square, board square and figure decides.
// Touch (the larger proxies of a coarse pointer) is in battle3dClickTargetsTouch.test.js.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootJourney } = require('../helpers/battle3dCoachJourney');
const { loadBattle3dController } = require('../helpers/loadBattle3dController');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
const name = (s) => (s ? String.fromCharCode(97 + s.col) + (8 - s.row) : null);

describe('battle3d click targets: real pointer clicks (real page)', { skip }, () => {
    let J, P, $, st, settle, idle, fresh, canvas;
    before(async () => {
        J = await bootJourney({ settings: { coach: false } });
        ({ P, $, st, settle, idle, fresh } = J);
        canvas = P.renderer.domElement;
    });
    after(() => { if (J) J.restore(); });

    // Screen position of a square: 'unit' = the body of the figure standing there (or a height above the
    // board on its axis), 'middle' = the middle of the square on the board, where its move dot or capture ring is drawn
    function screenPoint(sq, where) {
        const { row, col } = square(sq);
        const { camera, THREE } = P.B.sceneAPI;
        for (let i = 0; i < 600 && P.B.sceneAPI.isCameraBusy?.(); i++) P.B.step(1);
        const point = new THREE.Vector3(col - 3.5, typeof where === 'number' ? where : where === 'unit' ? 0.45 : 0, row - 3.5);
        camera.updateMatrixWorld();
        point.project(camera);
        const rect = canvas.getBoundingClientRect();
        return { clientX: rect.left + (point.x + 1) / 2 * rect.width, clientY: rect.top + (1 - point.y) / 2 * rect.height };
    }
    const pick = (sq, where, detail) => { const p = screenPoint(sq, where); return P.B.sceneAPI.pickAt(p.clientX, p.clientY, detail); };
    async function pointer(sq, where) {
        const init = { ...screenPoint(sq, where), pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerdown', init));
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerup', init));
        await null;
    }
    async function position(fen, { side = 'w' } = {}) {
        await fresh({ mode: 'human-human', coach: false, talk: 'off' });
        $(side === 'w' ? 'side-w' : 'side-b').click(); // human vs human: the side the board is seen from
        if (fen) P.B.controller.loadFen(fen);
        await idle('position');
        P.errors.length = 0;
    }
    const played = (n) => settle(() => st().history.length === n && !st().moving, { ms: 6000, label: `move ${n}` });
    const selected = () => name(st().selected);

    test('the scene tells the figure from its proxy: the middle of the square behind a pawn is board, not pawn', async () => {
        await position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
        assert.deepEqual(pick('d6', 'middle'), square('d5'), 'plain pick: the proxy of the pawn in front still wins (unchanged)');
        const behind = pick('d6', 'middle', true);
        assert.deepEqual([name(behind), name(behind.ground), name(behind.figure)], ['d5', 'd6', null], 'detail: board square d6, no figure is hit');
        const body = pick('d5', 'unit', true);
        assert.deepEqual([name(body), name(body.figure)], ['d5', 'd5'], 'a click on the pawn\'s body is a click on the pawn');
        // Legs, body and head of a skeleton and of a hero pawn, in their current pose (skinned meshes)
        for (const sq of ['d5', 'e5']) {
            for (const height of [0.15, 0.3, 0.6, 0.7]) {
                const hit = pick(sq, height, true);
                assert.deepEqual([name(hit), name(hit.figure)], [sq, sq], `${sq} at height ${height}`);
            }
        }
        const free = pick('a1', 'middle', true);
        assert.deepEqual([name(free), name(free.ground), name(free.figure)], ['a1', 'a1', null], 'an empty square with nothing in front');
        assert.equal(behind.marker, null, 'nothing is selected: no move dot anywhere');
        // With the capturing pawn selected e6 has a move dot (d6 has the capture ring, which is not one)
        await pointer('e5', 'unit');
        assert.deepEqual([name(pick('e6', 'middle', true).marker), name(pick('d6', 'middle', true).marker), name(pick('e5', 'unit', true).marker)], ['e6', null, null]);
        P.key('Escape');
    });

    test('en passant: clicking the ring on the target square, or the pawn that is taken, captures', async () => {
        for (const [target, where] of [['d6', 'middle'], ['d5', 'unit']]) {
            await position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
            await pointer('e5', 'unit');
            assert.equal(selected(), 'e5');
            await pointer(target, where);
            await played(1);
            assert.deepEqual(st().history, ['exd6'], `click on ${target} (${where})`);
            assert.equal(P.board()[3][3], null, 'the d5 pawn is gone');
            assert.equal(J.unitBoard(), J.liveBoard());
        }
        assert.deepEqual(P.errors, []);
    });

    test('a move dot behind the selected pawn, behind another own unit, and a promotion square', async () => {
        await position('4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1');
        await pointer('e2', 'unit');
        await pointer('e3', 'middle');
        await played(1);
        assert.deepEqual(st().history, ['e3'], 'one step forward, away from the viewer');

        await position(null);
        await pointer('g1', 'unit');
        assert.equal(selected(), 'g1');
        await pointer('f3', 'middle');
        await played(1);
        assert.deepEqual(st().history, ['Nf3'], 'the knight jumps behind the f2 pawn');

        await position('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await pointer('a7', 'unit');
        await pointer('a8', 'middle');
        assert.equal($('promo').hidden, false, 'the promotion dialog opens');
        assert.deepEqual(st().pendingPromotion.to, square('a8'));
        $('promo').querySelector('button[data-piece="Q"]').click();
        await played(1);
        assert.deepEqual(st().history, ['a8=Q+']);
        assert.deepEqual(P.errors, []);
    });

    test('seen from Black\'s side the same holds', async () => {
        await position('4k3/3pp3/8/8/8/8/8/4K3 b - - 0 1', { side: 'b' });
        await pointer('e7', 'unit');
        assert.equal(selected(), 'e7');
        await pointer('e6', 'middle');
        await played(1);
        assert.deepEqual(st().history, ['e6']);
    });

    test('clicks on a figure keep their meaning: another own unit is selected, the selected one is put down', async () => {
        await position(null);
        await pointer('g1', 'unit');
        assert.equal(selected(), 'g1');
        await pointer('f2', 'unit'); // f3, behind it, is a knight target: the pawn's body still selects the pawn
        assert.equal(selected(), 'f2');
        assert.deepEqual(st().history, []);
        await pointer('f2', 'unit'); // f3 is a pawn target too: the body of the selected pawn still deselects
        assert.equal(selected(), null);
        assert.deepEqual(st().history, []);
        // An enemy unit that cannot be taken, with an offered square behind it
        await position('4k3/8/8/8/8/2p5/8/R3K3 w - - 0 1');
        await pointer('a1', 'unit');
        await pointer('c3', 'unit');
        assert.equal(selected(), null, 'not a target: the selection is dropped, nothing moves');
        assert.deepEqual(st().history, []);
        assert.deepEqual(P.errors, []);
    });

    // --- Sweep -------------------------------------------------------------------------------------------
    const SWEEP = {
        w: ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 6',
            'r3k2r/pp3ppp/2n1bn2/q2pp3/1b2P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 9',
            '4k3/P6P/8/3pP3/8/8/p6p/4K3 w - d6 0 1',
            'k7/4p3/5N2/8/2Q5/8/5PPP/R5K1 w - - 0 1',
            '8/3P1k2/8/8/8/8/3p1K2/8 w - - 0 1'],
        b: ['rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
            'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R b KQkq - 0 6',
            'r3k2r/pp3ppp/2n1bn2/q2pp3/1b2P3/2NPBN2/PPPQ1PPP/R3K2R b KQkq - 0 9',
            '4k3/P6P/8/8/3pP3/8/p6p/4K3 b - e3 0 1',
            'r5k1/5ppp/8/2q5/8/5n2/4P3/K7 b - - 0 1',
            '8/3P1k2/8/8/8/8/3p1K2/8 b - - 0 1'],
    };
    const at = (x, z) => {
        const { camera, THREE } = P.B.sceneAPI;
        const point = new THREE.Vector3(x, 0, z);
        camera.updateMatrixWorld();
        point.project(camera);
        const rect = canvas.getBoundingClientRect();
        return { clientX: rect.left + (point.x + 1) / 2 * rect.width, clientY: rect.top + (1 - point.y) / 2 * rect.height };
    };
    const detailAt = (x, z) => { const p = at(x, z); return P.B.sceneAPI.pickAt(p.clientX, p.clientY, true); };
    function click(x, z) {
        const init = { ...at(x, z), pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerdown', init));
        canvas.dispatchEvent(new globalThis.PointerEvent('pointerup', init));
    }
    // Every own piece with legal moves and each of its targets, for the side to move of a position
    function* targetsOf(fen, side) {
        P.B.controller.loadFen(fen);
        const board = P.board();
        for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
            const piece = board[row][col];
            if (!piece || (piece === piece.toUpperCase() ? 'w' : 'b') !== side) continue;
            for (const m of globalThis.generateLegalMoves(row, col)) yield { from: { row, col }, to: { row: m.row, col: m.col }, promotion: !!m.isPromotion, board };
        }
    }
    const sameSq = (p, q) => !!p && !!q && p.row === q.row && p.col === q.col;
    // A point of the target square to click: its middle. An empty square has its dot there, drawn over whatever
    // stands in front. On a capture square the drawn figure of another unit can cover the middle (then that
    // click means that unit, as it should): the first free point of the square instead
    function pointOn(to) {
        const cx = to.col - 3.5, cz = to.row - 3.5;
        const free = (x, z) => { const d = detailAt(x, z); return d && (sameSq(d.marker, to) || !d.figure || sameSq(d.figure, to)); };
        if (free(cx, cz)) return { x: cx, z: cz, middle: true };
        for (const dz of [-0.36, 0.36, -0.2, 0.2, 0]) for (const dx of [0, -0.3, 0.3]) if (free(cx + dx, cz + dz)) return { x: cx + dx, z: cz + dz, middle: false };
        return null;
    }
    async function view(side) {
        await fresh({ mode: 'human-human', coach: false, talk: 'off' });
        $(side === 'w' ? 'side-w' : 'side-b').click();
        await idle('view');
        for (let i = 0; i < 900 && P.B.sceneAPI.isCameraBusy?.(); i++) P.B.step(1);
        P.errors.length = 0;
    }

    test('sweep, default views: a click on the middle of every offered target of every piece plays that move', async (t) => {
        const stats = { targets: 0, middle: 0, moved: 0, coveredBy: {}, underFigure: [] };
        for (const side of ['w', 'b']) {
            await view(side);
            for (const fen of SWEEP[side]) {
                for (const { from, to, promotion, board } of [...targetsOf(fen, side)]) {
                    const label = `${fen.split(' ')[0]} ${side} ${name(from)}${name(to)}`;
                    P.B.controller.loadFen(fen);
                    P.B.controller.clickSquare(from.row, from.col);
                    assert.deepEqual(JSON.parse(JSON.stringify(st().selected)), from, `${label}: selected`);
                    const point = pointOn(to);
                    assert.ok(point, `${label}: some part of the target square is free of other figures`);
                    stats.targets++;
                    if (point.middle) stats.middle++;
                    else {
                        // The middle is under a figure in front: record whose, and check that click means that unit
                        const cover = detailAt(to.col - 3.5, to.row - 3.5).figure;
                        const who = board[cover.row][cover.col].toLowerCase();
                        stats.coveredBy[who] = (stats.coveredBy[who] || 0) + 1;
                        stats.underFigure.push({ square: name(to), empty: !board[to.row][to.col] });
                        assert.equal(P.B.controller.clickedMove(cover.row, cover.col, { ground: to, figure: cover })?.row === to.row &&
                            P.B.controller.clickedMove(cover.row, cover.col, { ground: to, figure: cover })?.col === to.col &&
                            !sameSq(cover, to), false, `${label}: a click on the ${who} in front is not this move`);
                        stats.moved++;
                    }
                    click(point.x, point.z);
                    if (promotion) {
                        assert.deepEqual(JSON.parse(JSON.stringify(st().pendingPromotion)), { from, to }, `${label}: promotion dialog for the target`);
                    } else {
                        assert.equal(st().history.length, 1, `${label}: the move was played`);
                        assert.deepEqual(JSON.parse(JSON.stringify(globalThis.battle3dLastMove())), { from, to }, `${label}: onto the clicked square`);
                    }
                }
            }
        }
        // Every empty target plays from its middle (the dot is on top); only on a capture square can the figure
        // of a unit in front stand over the middle
        assert.ok(stats.targets > 250 && stats.middle / stats.targets > 0.95, JSON.stringify(stats));
        assert.deepEqual(stats.underFigure.filter((sq) => sq.empty), [], 'no empty target needed another point than its middle');
        t.diagnostic(`${stats.targets} targets, ${stats.middle} played by a click on the middle, ${stats.moved} capture squares with the middle under a figure in front (${JSON.stringify(stats.coveredBy)}), played beside it`);
        await view('w'); // leave the page in a clean state
        assert.deepEqual(P.errors, []);
    });

    test('sweep, turned, tilted and zoomed views: the same rule holds for every camera state', async (t) => {
        const { THREE } = P.B.sceneAPI;
        const cam = P.B.sceneAPI.camera;
        const VIEWS = [
            { name: 'turned a quarter left', twist: Math.PI / 2 }, { name: 'turned a quarter right', twist: -Math.PI / 2 },
            { name: 'turned 35 degrees', twist: 0.6 }, { name: 'seen from the other side', twist: Math.PI },
            { name: 'flat', tilt: 0.3 }, { name: 'steep', tilt: -0.45 }, { name: 'zoomed in', zoom: 0.55 }, { name: 'zoomed out, turned', zoom: 1.5, twist: -0.4 },
        ];
        const report = [];
        for (const side of ['w', 'b']) {
            await view(side);
            const home = { position: cam.position.clone(), quaternion: cam.quaternion.clone() };
            for (const v of VIEWS) {
                // Orbit the camera around the point it looks at on the board (no frames run while it stands there)
                cam.position.copy(home.position); cam.quaternion.copy(home.quaternion); cam.updateMatrixWorld(true);
                const dir = cam.getWorldDirection(new THREE.Vector3());
                const target = cam.position.clone().addScaledVector(dir, -cam.position.y / dir.y);
                const sph = new THREE.Spherical().setFromVector3(cam.position.clone().sub(target));
                sph.theta += v.twist || 0;
                sph.phi = Math.min(1.35, Math.max(0.12, sph.phi + (v.tilt || 0)));
                sph.radius *= v.zoom || 1;
                cam.position.copy(target).add(new THREE.Vector3().setFromSpherical(sph));
                cam.lookAt(target);
                cam.updateMatrixWorld(true);
                let targets = 0, middle = 0;
                for (const fen of SWEEP[side]) {
                    let selected = null;
                    for (const { from, to } of targetsOf(fen, side)) {
                        if (!sameSq(selected, from)) {
                            if (selected) P.B.controller.clickSquare(selected.row, selected.col); // put down
                            P.B.controller.clickSquare(from.row, from.col);
                            selected = from;
                        }
                        const label = `${v.name}, ${side}: ${fen.split(' ')[0]} ${name(from)}${name(to)}`;
                        const point = pointOn(to);
                        assert.ok(point, `${label}: some part of the target square is free of other figures`);
                        const d = detailAt(point.x, point.z);
                        const move = P.B.controller.clickedMove(d.row, d.col, { ground: d.ground, figure: d.figure, marker: d.marker });
                        assert.deepEqual(move && { row: move.row, col: move.col }, to, `${label}: a click there plays the move`);
                        targets++;
                        if (point.middle) middle++;
                    }
                }
                report.push(`${side} ${v.name}: ${middle}/${targets} by the middle`);
            }
            cam.position.copy(home.position); cam.quaternion.copy(home.quaternion); cam.updateMatrixWorld(true);
        }
        t.diagnostic(report.join('; '));
        await view('w');
        assert.deepEqual(P.errors, []);
    });

    // Share of a square (a 9 x 9 grid of points on it) where a click would play the move onto it
    function playableShare(to) {
        let n = 0;
        for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
            const d = detailAt(to.col - 4 + (i + 0.5) / 9, to.row - 4 + (j + 0.5) / 9);
            const move = d && P.B.controller.clickedMove(d.row, d.col, { ground: d.ground, figure: d.figure, marker: d.marker });
            if (move && move.row === to.row && move.col === to.col) n++;
        }
        return n / 81;
    }

    test('the far rank: the board is seen flat there and the unit in front stands over the square; its dot is on top and plays', async (t) => {
        const shares = [];
        // Ne8 behind the e7 pawn, a promotion push on a centre file, and the same from Black's side
        for (const [fen, side, from, to, san] of [
            ['k7/4p3/5N2/8/8/8/8/4K3 w - - 0 1', 'w', 'f6', 'e8', 'Ne8'],
            ['8/3P1k2/8/8/8/8/5K2/8 w - - 0 1', 'w', 'd7', 'd8', null],
            ['4k3/8/8/8/8/2n5/3P4/7K b - - 0 1', 'b', 'c3', 'd1', 'Nd1'],
            ['8/5k2/8/8/8/8/3p1K2/8 b - - 0 1', 'b', 'd2', 'd1', null],
        ]) {
            await position(fen, { side });
            await pointer(from, 'unit');
            assert.equal(selected(), from);
            const target = square(to);
            const middle = detailAt(target.col - 3.5, target.row - 3.5);
            assert.deepEqual(middle.marker, target, `${to}: the pointer on the middle is on the move dot`);
            const share = playableShare(target);
            shares.push(`${to} ${(100 * share).toFixed(0)}%${middle.figure ? ` (the ${name(middle.figure)} figure stands over the middle)` : ''}`);
            assert.ok(share >= 0.6, `${to}: most of the square plays the move (${(100 * share).toFixed(0)}%)`);
            await pointer(to, 'middle'); // the dot, also where a figure in front stands over it
            if (san) {
                await played(1);
                assert.deepEqual(st().history, [san]);
            } else {
                assert.equal($('promo').hidden, false, `${to}: the promotion dialog opens`);
                assert.deepEqual(JSON.parse(JSON.stringify(st().pendingPromotion.to)), target);
                $('promo-cancel').click();
            }
        }
        // An occupied far square: by the figure standing there and by the middle of its square
        for (const where of ['unit', 'middle']) {
            await position('r5k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
            await pointer('a1', 'unit');
            await pointer('a8', where);
            await played(1);
            assert.match(st().history.join(' '), /^Rxa8[+#]$/, `a8 by its ${where}`);
        }
        t.diagnostic(`share of the far-rank square that plays the move: ${shares.join(', ')}`);
        assert.deepEqual(P.errors, []);
    });

    test('precise figure rule: a figure behind another unit\'s proxy is the unit that is clicked', async () => {
        // Black to move, seen from White's side: Black's pawns stand in front of Black's pieces, and the top of a
        // pawn's proxy reaches over the legs of the piece behind it
        await position('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
        const { camera, THREE } = P.B.sceneAPI;
        const found = [];
        for (let col = 0; col < 8; col++) {
            for (const height of [0.3, 0.45, 0.6, 0.75]) {
                for (const dx of [-0.2, -0.1, 0, 0.1, 0.2]) {
                    const point = new THREE.Vector3(col - 3.5 + dx, height, 0 - 3.5);
                    camera.updateMatrixWorld();
                    point.project(camera);
                    const rect = canvas.getBoundingClientRect();
                    const p = { clientX: rect.left + (point.x + 1) / 2 * rect.width, clientY: rect.top + (1 - point.y) / 2 * rect.height };
                    const d = P.B.sceneAPI.pickAt(p.clientX, p.clientY, true);
                    if (d && d.row === 1 && d.figure && d.figure.row === 0) found.push({ p, d });
                }
            }
        }
        assert.ok(found.length >= 16, `points on a back-rank piece whose ray first crosses the proxy of the pawn in front: ${found.length}`);
        const pieces = new Set();
        for (const { p, d } of found) {
            const init = { ...p, pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true, cancelable: true };
            canvas.dispatchEvent(new globalThis.PointerEvent('pointerdown', init));
            canvas.dispatchEvent(new globalThis.PointerEvent('pointerup', init));
            // b8 and g8 (knights) have moves; the others have none yet, and selecting them is still what the click means
            assert.equal(selected(), name(d.figure), `the piece on ${name(d.figure)} is selected, not the pawn on ${name(d)} whose proxy is in front`);
            pieces.add(name(d.figure));
            P.key('Escape');
        }
        assert.equal(pieces.size, 8, `every back-rank piece: ${[...pieces]}`);
        assert.deepEqual(P.errors, []);
    });

    test('markers: every offered empty square has an outline that reaches its visible part; labels are drawn under the markers', async () => {
        await position(null);
        await pointer('g1', 'unit');
        const hl = P.B.sceneAPI.scene.getObjectByName('highlights');
        const shown = (order) => hl.children.filter((m) => m.visible && m.renderOrder === order);
        const squares = (list) => list.map((m) => name({ row: Math.round(m.position.z + 3.5), col: Math.round(m.position.x + 3.5) })).sort();
        assert.deepEqual(squares(shown(6)), ['f3', 'h3'], 'the targets themselves (dots)');
        assert.deepEqual(squares(shown(5.5)), ['f3', 'h3'], 'one outline per dot');
        for (const m of shown(5.5)) assert.ok(m.scale.x > 0.85 && m.scale.x < 1, 'the outline spans the square, the dot only its middle');
        const labels = [];
        P.B.sceneAPI.scene.traverse((o) => { if (o.isSprite && /^unit-/.test(o.parent?.name || '')) labels.push(o.renderOrder); });
        assert.ok(labels.length >= 32 && labels.every((order) => order < 5.5), `unit labels are drawn before the target markers: ${[...new Set(labels)]}`);
        // En passant: ring on the target, red frame on the pawn that would be removed
        await position('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
        await pointer('e5', 'unit');
        const victim = P.B.sceneAPI.scene.getObjectByName('capture-victim');
        assert.equal(victim.visible, true);
        assert.deepEqual([victim.position.x, victim.position.z], [3 - 3.5, 3 - 3.5], 'on d5');
        assert.ok(shown(6).some((m) => m.scale.x > 0.9 && Math.round(m.position.x + 3.5) === 3 && Math.round(m.position.z + 3.5) === 2), 'capture ring on d6');
        P.key('Escape');
        assert.equal(victim.visible, false, 'gone with the selection');
        assert.deepEqual(P.errors, []);
    });
});

describe('battle3d click targets: the controller\'s rules (fake scene)', () => {
    function withCtl(fn) {
        return async () => {
            const C = await loadBattle3dController();
            C.controller.setMode('human-human');
            C.at = async (fen) => { C.controller.loadFen(fen); await C.flush(); };
            // A pointer click as the scene reports it: the picked square (first proxy on the ray), the board square
            // under the pointer, and the square of the unit whose figure the pointer is on (null: on no figure)
            C.tap = async (sq, ground, figure = null, marker = null) => {
                const p = square(sq);
                C.controller.clickSquare(p.row, p.col, ground === undefined ? null : { ground: ground && square(ground), figure: figure && square(figure), marker: marker && square(marker) });
                await C.flush();
            };
            try { await fn(C); } finally { C.close(); }
        };
    }
    const sel = (C) => name(C.state().selected);

    test('the pawn an en passant move takes is a click target for that move (pointer or keyboard)', withCtl(async (C) => {
        await C.at('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
        await C.tap('e5');
        const shown = C.scene.calls.setHighlights.at(-1);
        assert.deepEqual(shown.victim, square('d5'), 'the pawn that would be removed is framed while the capturing pawn is selected');
        assert.deepEqual(shown.moves.filter((m) => m.capture), [{ ...square('d6'), capture: true }], 'the ring is on the target square');
        await C.tap('d5');
        assert.deepEqual(C.state().history, ['exd6']);
        assert.equal(C.get('board[3][3]'), null);
        assert.equal(C.scene.calls.setHighlights.at(-1).victim, null, 'gone once the move is made');
        // A pawn beside it without the right is not a target
        await C.at('4k3/8/8/3pP3/8/8/8/4K3 w - - 0 1');
        await C.tap('e5');
        assert.equal(C.scene.calls.setHighlights.at(-1).victim, null, 'no frame without the right');
        await C.tap('d5');
        assert.deepEqual(C.state().history, []);
        assert.equal(sel(C), null, 'an enemy piece that cannot be taken clears the selection, as before');
    }));

    test('not on a figure: the offered board square under the pointer is played, wherever a proxy stands in the way', withCtl(async (C) => {
        const PAWNS = '4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1';
        await C.at(PAWNS);
        await C.tap('e2');
        await C.tap('e2', 'e3');
        assert.deepEqual(C.state().history, ['e3'], 'proxy of the selected pawn, pointer over e3');
        // The picked unit is itself a target, and so is the square behind it: the square the pointer is over wins
        const QUEEN = '4k3/8/8/3pQ3/8/8/8/4K3 w - - 0 1';
        await C.at(QUEEN);
        await C.tap('e5');
        await C.tap('d5', 'd6');
        assert.deepEqual(C.state().history, ['Qd6'], 'the dot on d6, not the pawn whose proxy covers it');
        // ... and the generous proxy still captures when the board square under the pointer is no target
        await C.at(QUEEN);
        await C.tap('e5');
        await C.tap('d5', 'c6');
        assert.deepEqual(C.state().history, ['Qxd5'], 'just beside the pawn: its proxy is enough');
        // Promotion through the board square: the dialog is for the offered square, not the picked one
        await C.at('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        await C.tap('a7');
        await C.tap('a7', 'a8');
        assert.deepEqual(JSON.parse(JSON.stringify(C.state().pendingPromotion)), { from: square('a7'), to: square('a8') });
        C.doc.querySelector('#promo button[data-piece="N"]').click();
        await C.flush();
        assert.deepEqual(C.state().history, ['a8=N']);
        // The board square holds the piece to take, the pointer is on its square but not on its figure
        await C.at(QUEEN);
        await C.tap('e5');
        await C.tap('e5', 'd5');
        assert.deepEqual(C.state().history, ['Qxd5'], 'anywhere on an offered square');
        // En passant and castling aliases work through the board square too
        await C.at('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
        await C.tap('e5');
        await C.tap('e5', 'd5');
        assert.deepEqual(C.state().history, ['exd6']);
        await C.at('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
        await C.tap('e1');
        await C.tap('e1', 'h1');
        assert.deepEqual(C.state().history, ['O-O']);
        assert.deepEqual(C.errors, []);
    }));

    test('on a figure: that unit, whatever lies behind it or in front of it', withCtl(async (C) => {
        const PAWNS = '4k3/8/8/8/8/8/3PP3/4K3 w - - 0 1';
        await C.at(PAWNS);
        await C.tap('e2');
        await C.tap('e2', 'e3', 'e2');
        assert.deepEqual([C.state().history, sel(C)], [[], null], 'the selected pawn\'s own figure: put down, although e3 behind it is offered');
        await C.at(PAWNS);
        await C.tap('e2');
        await C.tap('e2');
        assert.deepEqual([C.state().history, sel(C)], [[], null], 'no pointer detail (keyboard, clickSquare): as before');
        // The move dot is drawn over the figure: a click on the dot plays the move, also where a figure is under it
        await C.at(PAWNS);
        await C.tap('e2');
        await C.tap('e2', 'e3', 'e2', 'e3');
        assert.deepEqual(C.state().history, ['e3'], 'on the dot of e3, over the selected pawn\'s own head');
        await C.at('4k3/8/8/3pQ3/8/8/8/4K3 w - - 0 1');
        await C.tap('e5');
        await C.tap('d5', 'd6', 'd5', 'd6');
        assert.deepEqual(C.state().history, ['Qd6'], 'the dot of d6 over the d5 pawn: the dot, not the capture');
        await C.at(PAWNS);
        await C.tap('e2');
        await C.tap('d2', 'd3', 'd2');
        assert.deepEqual([C.state().history, sel(C)], [[], 'd2'], 'another own figure: the selection switches');
        // A figure that is an offered target is captured, also when the square behind it is offered too
        const QUEEN = '4k3/8/8/3pQ3/8/8/8/4K3 w - - 0 1';
        await C.at(QUEEN);
        await C.tap('e5');
        await C.tap('d5', 'd6', 'd5');
        assert.deepEqual(C.state().history, ['Qxd5']);
        // The figure can stand behind the first proxy on the ray: it still decides
        await C.at(QUEEN);
        await C.tap('e5');
        await C.tap('e5', 'd6', 'd5');
        assert.deepEqual(C.state().history, ['Qxd5'], 'picked e5 (own proxy in front), figure d5');
        // An enemy figure that cannot be taken drops the selection, as before
        await C.at('4k3/8/8/8/8/2p5/8/R3K3 w - - 0 1');
        await C.tap('a1');
        await C.tap('c3', 'c4', 'c3');
        assert.deepEqual([C.state().history, sel(C)], [[], null]);
        assert.deepEqual(C.errors, []);
    }));

    test('selecting: the figure under the pointer, else an own piece on the board square, else the generous proxy', withCtl(async (C) => {
        const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        await C.at(START);
        await C.tap('d1', 'd2');
        assert.equal(sel(C), 'd2', 'the pointer is over the d2 pawn\'s square and only crosses the queen\'s proxy');
        await C.at(START);
        await C.tap('d1', 'd2', 'd1');
        assert.equal(sel(C), 'd1', 'on the queen\'s figure: the queen');
        await C.at(START);
        await C.tap('d1', 'd2', 'd2');
        assert.equal(sel(C), 'd2', 'on the pawn\'s figure behind the queen\'s proxy: the pawn');
        await C.at(START);
        await C.tap('d2', 'd3');
        assert.equal(sel(C), 'd2', 'nothing of the mover\'s on the board square: the proxy that was hit');
        await C.at(START);
        await C.tap('d2', null);
        assert.equal(sel(C), 'd2', 'off the board behind a unit: the proxy');
        // Not the other side's pieces: Black's pawn on the board square does not take a white unit's click
        await C.at('4k3/8/8/8/8/3p4/3P4/4K3 w - - 0 1');
        await C.tap('d2', 'd3');
        assert.equal(sel(C), 'd2');
        assert.deepEqual(C.errors, []);
    }));

    test('locked input stays locked whatever the pointer detail says', withCtl(async (C) => {
        C.controller.setMode('human-ai');
        await C.play('e2e4');
        await C.step(0.3); // the AI is thinking
        await C.tap('d2', 'd3');
        assert.equal(sel(C), null);
        assert.deepEqual(C.state().history, ['e4']);
    }));
});
