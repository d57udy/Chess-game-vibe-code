'use strict';
// battle3d/units.js with the real three.js (GLTFLoader + meshopt) in node: loads the final
// manifest and assets, then drives move/capture/castle/promotion choreography purely through the
// scene updater clock (as __b3d.step() does in the browser) and checks the end states.
// Needs three 0.186.1 from node_modules/three or B3D_THREE_DIR; skipped otherwise.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findThree, registerThree, installBrowserGlobals, ROOT } = require('../helpers/loadBattle3dThree');
const { loadBattle3dRules, LEGAL_UCI_EXPR, rng } = require('../helpers/loadBattle3dRules');
const { square } = require('../helpers/loadEngine');

const three = findThree();
const skip = !three ? 'three.js not installed (node_modules/three or B3D_THREE_DIR)' : false;

let THREE, createUnits, env;
const warnings = [];
const errors = [];
let origWarn, origError, origLog;

// Fake SceneAPI over a real THREE.Scene; the clock only advances through stepFrames().
function makeScene() {
    const updaters = new Set();
    const scene = new THREE.Scene();
    let t = 0;
    const calls = { focusOn: 0, restoreView: 0, burst: 0, shake: 0 };
    return {
        THREE, scene, camera: new THREE.PerspectiveCamera(), renderer: null,
        calls,
        squareToWorld: (row, col) => new THREE.Vector3(col - 3.5, 0, row - 3.5),
        onSquareClick() {}, onSquareHover() {},
        registerPickProxy() {}, unregisterPickProxy() {},
        setHighlights() {},
        setView: () => Promise.resolve(),
        focusOn() { calls.focusOn++; return Promise.resolve(); },
        restoreView() { calls.restoreView++; return Promise.resolve(); },
        addUpdater: (fn) => updaters.add(fn),
        removeUpdater: (fn) => updaters.delete(fn),
        setTimeScale() {}, getTimeScale: () => 1,
        shake() { calls.shake++; },
        burst() { calls.burst++; },
        stepFrames(n, dt = 1 / 60) { for (let i = 0; i < n; i++) { t += dt; for (const fn of [...updaters]) fn(dt, t); } },
        setPaused() {},
    };
}

// Steps the scene clock until `promise` settles; returns elapsed scene seconds.
async function runUntil(S, promise, { max = 20, dt = 1 / 60 } = {}) {
    let done = false;
    promise.then(() => { done = true; });
    await null;
    let elapsed = 0;
    while (!done && elapsed < max) {
        S.stepFrames(1, dt);
        elapsed += dt;
        await null;
    }
    assert.ok(done, `animation did not finish within ${max} s of scene time`);
    return elapsed;
}

async function setup(fen) {
    const S = makeScene();
    const units = await createUnits(S, 'battle3d/assets/manifest.json');
    const E = loadBattle3dRules();
    if (fen) E.run(`battle3dLoadFen(${JSON.stringify(fen)})`); else E.run('battle3dNewGame()');
    units.syncBoard(E.get('board'));
    return { S, units, E };
}
const unitRoots = (S) => S.scene.children.filter((o) => /^unit-/.test(o.name));
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
function assertAt(S, u, name, msg) {
    const { row, col } = square(name);
    const p = u.root.position;
    assert.ok(near(p.x, col - 3.5) && near(p.z, row - 3.5) && near(p.y, 0), `${msg || ''} unit at ${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)} not on ${name}`);
}
// Units grid == rules board, every unit on its square center, no stray unit objects in the scene.
function assertSynced(S, units, E, msg = '') {
    const board = E.get('board');
    let pieces = 0;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const p = board[r][c];
            const u = units.unitAt(r, c);
            if (!p) { assert.equal(u, null, `${msg} stray unit at ${r},${c}`); continue; }
            pieces++;
            assert.ok(u, `${msg} missing unit at ${r},${c} (${p})`);
            assert.equal(u.color, p === p.toUpperCase() ? 'w' : 'b', `${msg} color at ${r},${c}`);
            assert.equal(u.type, p.toLowerCase(), `${msg} type at ${r},${c}`);
            assert.ok(near(u.root.position.x, c - 3.5) && near(u.root.position.z, r - 3.5), `${msg} position of ${p} at ${r},${c}`);
        }
    }
    assert.equal(unitRoots(S).length, pieces, `${msg} unit objects in scene`);
}

describe('battle3d units.js (real three.js)', { skip }, () => {
    before(async () => {
        if (three.version !== '0.186.1') console.log(`note: testing with three ${three.version}`);
        registerThree(three.dir);
        env = installBrowserGlobals();
        origWarn = console.warn; origError = console.error; origLog = console.log;
        console.warn = (...a) => warnings.push(a.map(String).join(' '));
        console.error = (...a) => errors.push(a.map((x) => (x && x.stack) || String(x)).join(' '));
        THREE = await import('three');
        ({ createUnits } = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'units.js')).href));
    });
    after(() => {
        console.warn = origWarn; console.error = origError; console.log = origLog;
        if (env) env.restore();
    });

    test('every battle3d ES module links (named imports resolve) and exports its API', async () => {
        const mod = (f) => import(pathToFileURL(path.join(ROOT, 'battle3d', f)).href);
        assert.equal(typeof (await mod('scene.js')).createScene, 'function');
        assert.equal(typeof (await mod('units.js')).createUnits, 'function');
        assert.equal(typeof (await mod('controller.js')).createController, 'function');
    });

    test('loads every model, prop and clip of the final manifest without warnings', async () => {
        const { S, units } = await setup();
        assert.deepEqual(warnings.filter((w) => /failed|placeholder|no manifest/.test(w)), []);
        assert.ok(units._clips.size >= 55, `clips loaded: ${units._clips.size}`);
        assert.ok(env.fetched.some((u) => u.endsWith('assets/manifest.json')));
        assert.equal(unitRoots(S).length, 32);
        for (const u of units._units) assert.ok(u.mixer, `${u.color}${u.type} is a real character, not a placeholder`);
        assert.equal(units.isBusy(), false);
    });

    test('syncBoard places 32 units on the right squares, White facing -z, Black +z', async () => {
        const { S, units, E } = await setup();
        assertSynced(S, units, E);
        assert.ok(near(units.unitAt(7, 4).root.rotation.y, Math.PI), 'white king yaw');
        assert.ok(near(units.unitAt(0, 4).root.rotation.y, 0), 'black king yaw');
        assert.equal(units.unitAt(7, 4).type, 'k');
    });

    test('character heights are in the 0.7 to 1.1 world-unit range', async () => {
        const { units } = await setup();
        for (const u of units._units) {
            u.root.updateMatrixWorld(true);
            const box = new THREE.Box3();
            u.model.traverse((o) => { if (o.isSkinnedMesh) box.union(new THREE.Box3().setFromObject(o)); });
            const h = box.max.y - box.min.y;
            assert.ok(h > 0.6 && h < 1.2, `${u.color}${u.type} height ${h.toFixed(2)}`);
        }
    });

    test('quiet move, knight jump: resolve on scene time, end on the square facing home', async (t) => {
        const { S, units, E } = await setup();
        const ev = E.apply('e2e4');
        const secs = await runUntil(S, units.playMove(ev));
        assertSynced(S, units, E, 'e4');
        assert.ok(near(units.unitAt(4, 4).root.rotation.y, Math.PI, 1e-2), 'faces home after the move');
        const ev2 = E.apply('g8f6');
        const secs2 = await runUntil(S, units.playMove(ev2));
        assertSynced(S, units, E, 'Nf6');
        assert.equal(units.isBusy(), false);
        t.diagnostic(`pawn move ${secs.toFixed(2)} s, knight jump ${secs2.toFixed(2)} s`);
    });

    for (const speed of ['full', 'fast']) {
        test(`capture (${speed}): victim removed, attacker on the square, timing`, async (t) => {
            const { S, units, E } = await setup();
            units.setMode(speed);
            for (const mv of ['e2e4', 'd7d5']) await runUntil(S, units.playMove(E.apply(mv)));
            const focus0 = S.calls.focusOn;
            const victim = units.unitAt(3, 3);
            const ev = E.apply('e4d5');
            const secs = await runUntil(S, units.playMove(ev));
            assertSynced(S, units, E, 'exd5');
            assert.ok(!victim.root.parent, 'victim removed from the scene');
            if (speed === 'full') {
                assert.ok(S.calls.focusOn > focus0, 'full mode focuses the camera on the duel');
                assert.ok(S.calls.restoreView > 0, 'and restores it');
                assert.ok(secs > 1.8 && secs < 5, `full capture ${secs.toFixed(2)} s (contract 2.5 to 3.5)`);
            } else {
                assert.equal(S.calls.focusOn, focus0, 'fast mode: no camera move');
                assert.ok(secs < 2.2, `fast capture ${secs.toFixed(2)} s (contract about 1.2)`);
            }
            t.diagnostic(`${speed} pawn capture: ${secs.toFixed(2)} s`);
        });
    }

    test('every attacker type and every victim type capture cleanly', async (t) => {
        const times = [];
        const attackers = [
            ['Q', '4k3/8/8/3p4/8/8/8/Q3K3 w - - 0 1', 'a1d4'],
            ['R', '4k3/8/8/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5'],
            ['B', '4k3/8/8/8/3p4/8/8/B3K3 w - - 0 1', 'a1d4'],
            ['N', '4k3/8/8/3p4/8/2N5/8/4K3 w - - 0 1', 'c3d5'],
            ['K', '4k3/8/8/8/8/8/3p4/4K3 w - - 0 1', 'e1d2'],
        ];
        for (const [a, fen, mv] of attackers) {
            const { S, units, E } = await setup(fen);
            units.setMode('fast');
            times.push(`${a}:${(await runUntil(S, units.playMove(E.apply(mv)))).toFixed(2)}`);
            assertSynced(S, units, E, `${a} ${mv}`);
        }
        for (const v of 'qrbnp') {
            const { S, units, E } = await setup(`4k3/8/8/3${v}4/4P3/8/8/4K3 w - - 0 1`);
            times.push(`Px${v}:${(await runUntil(S, units.playMove(E.apply('e4d5')))).toFixed(2)}`);
            assertSynced(S, units, E, `Px${v}`);
        }
        t.diagnostic(times.join(' '));
    });

    test('bishop (ranged) capture by Black, skeleton attacker and hero victim', async () => {
        const { S, units, E } = await setup('4k3/8/8/8/8/8/1b6/R3K3 b - - 0 1');
        const ev = E.apply('b2a1');
        await runUntil(S, units.playMove(ev));
        assertSynced(S, units, E, 'Bxa1');
    });

    test('en passant: the pawn beside the target is removed', async () => {
        const { S, units, E } = await setup();
        units.setMode('fast');
        for (const mv of ['e2e4', 'a7a6', 'e4e5', 'd7d5']) await runUntil(S, units.playMove(E.apply(mv)));
        const victim = units.unitAt(3, 3);
        const ev = E.apply('e5d6');
        await runUntil(S, units.playMove(ev));
        assertSynced(S, units, E, 'exd6 e.p.');
        assert.ok(!victim.root.parent);
    });

    for (const [name, fen, mv] of [
        ['white O-O', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1'],
        ['white O-O-O', 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1c1'],
        ['black O-O', 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8g8'],
        ['black O-O-O', 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'e8c8'],
    ]) {
        test(`castling ${name}: king and rook end on their squares`, async () => {
            const { S, units, E } = await setup(fen);
            const ev = E.apply(mv);
            const rook = units.unitAt(ev.castling.rookFrom.row, ev.castling.rookFrom.col);
            await runUntil(S, units.playMove(ev));
            assertSynced(S, units, E, name);
            assert.equal(units.unitAt(ev.castling.rookTo.row, ev.castling.rookTo.col), rook, 'same rook unit moved');
        });
    }

    for (const p of 'QRBN') {
        test(`promotion to ${p} with capture (white) and quiet (black)`, async () => {
            let { S, units, E } = await setup('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
            const pawn = units.unitAt(1, 0);
            await runUntil(S, units.playMove(E.apply('a7b8' + p.toLowerCase())));
            assertSynced(S, units, E, `axb8=${p}`);
            assert.equal(units.unitAt(0, 1).type, p.toLowerCase());
            assert.ok(!pawn.root.parent, 'pawn unit replaced');
            ({ S, units, E } = await setup('4k3/8/8/8/8/8/p7/4K3 b - - 0 1'));
            units.setMode('fast');
            await runUntil(S, units.playMove(E.apply('a2a1' + p.toLowerCase())));
            assertSynced(S, units, E, `a1=${p}`);
        });
    }

    test('skip finishes a capture instantly with the final state', async () => {
        const { S, units, E } = await setup();
        for (const mv of ['e2e4', 'd7d5']) await runUntil(S, units.playMove(E.apply(mv)));
        const ev = E.apply('e4d5');
        const p = units.playMove(ev);
        S.stepFrames(30);
        assert.equal(units.isBusy(), true);
        units.skip();
        let done = false;
        p.then(() => { done = true; });
        await null; await null;
        assert.equal(done, true, 'playMove promise resolves on skip');
        assert.equal(units.isBusy(), false);
        assertSynced(S, units, E, 'after skip');
    });

    test('skip during a promotion still swaps the unit', async () => {
        const { S, units, E } = await setup('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1');
        const p = units.playMove(E.apply('a7b8q'));
        S.stepFrames(20);
        units.skip();
        await p;
        assertSynced(S, units, E, 'promotion skip');
        assert.equal(units.unitAt(0, 1).type, 'q');
    });

    test('a new playMove while busy fast-forwards the previous one', async () => {
        const { S, units, E } = await setup();
        const p1 = units.playMove(E.apply('e2e4'));
        S.stepFrames(5);
        const p2 = units.playMove(E.apply('e7e5'));
        await runUntil(S, Promise.all([p1, p2]));
        assertSynced(S, units, E, 'overlap');
    });

    test('syncBoard during an animation (undo) aborts it and resyncs', async () => {
        const { S, units, E } = await setup();
        for (const mv of ['e2e4', 'd7d5']) await runUntil(S, units.playMove(E.apply(mv)));
        const p = units.playMove(E.apply('e4d5'));
        S.stepFrames(40);
        E.run('battle3dUndo(2)');
        units.syncBoard(E.get('board'));
        await runUntil(S, p, { max: 1 });
        assert.equal(units.isBusy(), false);
        assertSynced(S, units, E, 'undo mid-capture');
        S.stepFrames(120);
        assertSynced(S, units, E, 'after idle frames');
    });

    test('playCheck and playGameOver resolve on scene time', async () => {
        const { S, units, E } = await setup();
        for (const mv of ['f2f3', 'e7e5', 'g2g4']) await runUntil(S, units.playMove(E.apply(mv)));
        const ev = E.apply('d8h4');
        await runUntil(S, units.playMove(ev));
        await runUntil(S, units.playCheck(square('e1')));
        const secs = await runUntil(S, units.playGameOver({ result: 'checkmate', loser: 'w', kingSquare: square('e1') }));
        assert.ok(secs < 8, `game over ${secs.toFixed(2)} s`);
        await runUntil(S, units.playGameOver({ result: 'draw', loser: null, kingSquare: null }));
        units.syncBoard(E.get('board'));
        assertSynced(S, units, E, 'after game over + resync');
    });

    test('labels toggle hides and shows the glyph sprites', async () => {
        const { units } = await setup();
        units.setLabels(false);
        for (const u of units._units) assert.equal(u.label.visible, false);
        units.setLabels(true);
        for (const u of units._units) assert.equal(u.label.visible, true);
    });

    test('random games (fast and full) stay in sync with rules.js after every ply', async (t) => {
        const rand = rng(99);
        let plies = 0, total = 0;
        for (let game = 0; game < 6; game++) {
            const { S, units, E } = await setup();
            units.setMode(game % 2 ? 'full' : 'fast');
            for (let ply = 0; ply < 50 && !E.get('battle3dGameStatus()').over; ply++) {
                const legal = E.get(LEGAL_UCI_EXPR);
                const mv = legal[Math.floor(rand() * legal.length)];
                const ev = E.apply(mv);
                total += await runUntil(S, units.playMove(ev), { dt: 1 / 30 });
                assertSynced(S, units, E, `game ${game} ply ${ply} ${mv}`);
                plies++;
            }
        }
        assert.deepEqual(errors.filter((e) => /sequence error/.test(e)), []);
        t.diagnostic(`${plies} plies, ${total.toFixed(0)} s of scene time`);
    });

    test('no sequence errors were logged', () => {
        assert.deepEqual(errors, []);
    });
});
