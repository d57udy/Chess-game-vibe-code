'use strict';
// v6 units.playGesture(square, kind) with the real three.js: every kind resolves on scene time and
// returns the king to idle on its square; never makes units busy; cancelled cleanly by moves, skip,
// syncBoard, check and game over; never disturbs a moving unit; safe on empty squares; no stacking.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers/battle3dUnitsHarness');
const { findThree } = require('../helpers/loadBattle3dThree');

const skip = findThree() ? false : 'three.js not installed';
const KINDS = ['talk', 'taunt', 'cheer', 'shrug', 'facepalm'];
const WK = { row: 7, col: 4 }, BK = { row: 0, col: 4 };
let M;

async function rig() {
    const S = H.makeScene(M.THREE);
    const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
    const E = H.rulesAt();
    units.syncBoard(E.get('board'));
    return { S, units, E };
}
const idleName = (u) => u.current?.getClip().name;
function assertRest(R, sq, label) {
    const u = R.units.unitAt(sq.row, sq.col);
    assert.equal(u.nod ?? null, null, `${label}: nod cleared`);
    assert.ok(Math.abs(u.root.position.y) < 1e-6, `${label}: root on the board`);
    assert.ok(Math.abs(u.root.position.x - (sq.col - 3.5)) < 1e-3 && Math.abs(u.root.position.z - (sq.row - 3.5)) < 1e-3, `${label}: on its square`);
    const idle = [].concat(u.role.anims?.idle || u.role.idle || 'Idle');
    assert.ok(idle.includes(idleName(u)) || /Idle/.test(idleName(u) || ''), `${label}: back to idle (${idleName(u)})`);
}

describe('battle3d king gestures (v6)', { skip }, () => {
    before(async () => { M = await H.loadUnitsModule(); });

    for (const kind of KINDS) {
        test(`${kind}: resolves within 2 s of scene time, back to idle on its square, never busy`, async () => {
            const R = await rig();
            assert.equal(typeof R.units.playGesture, 'function');
            const p = R.units.playGesture(WK, kind);
            R.S.stepFrames(3);
            assert.equal(R.units.isBusy(), false, 'a gesture does not make units busy (input stays open)');
            assert.ok(R.units.unitAt(WK.row, WK.col).nod, 'head nod running');
            const secs = await H.runUntil(R.S, p, { max: 2.2, label: kind });
            assert.ok(secs <= 2.2, `${kind} took ${secs.toFixed(2)} s`);
            R.S.stepFrames(30);
            assertRest(R, WK, kind);
        });
    }

    for (const [name, act] of [
        ['playMove', async (R) => { const ev = R.E.apply('e2e4'); await H.runUntil(R.S, R.units.playMove(ev)); }],
        ['skip', async (R) => { R.units.skip(); }],
        ['syncBoard', async (R) => { R.units.syncBoard(R.E.get('board')); }],
        ['playCheck', async (R) => { await H.runUntil(R.S, R.units.playCheck(BK)); }],
        ['playGameOver', async (R) => { await H.runUntil(R.S, R.units.playGameOver({ result: 'draw', loser: null, kingSquare: null })); }],
    ]) {
        test(`a gesture mid-way is cancelled cleanly by ${name}`, async () => {
            const R = await rig();
            const p = R.units.playGesture(WK, 'taunt');
            R.S.stepFrames(20);
            let done = false;
            p.then(() => { done = true; });
            await act(R);
            for (let i = 0; i < 5; i++) await null;
            assert.equal(done, true, 'gesture promise resolved');
            R.S.stepFrames(40);
            assertRest(R, WK, name);
            H.assertSynced(R.S, R.units, R.E, name);
        });
    }

    test('a gesture during a move only nods: the moving unit keeps its clips', async () => {
        const R = await rig();
        const E = H.rulesAt('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
        R.units.syncBoard(E.get('board'));
        const p = R.units.playMove(E.apply('e1e2'));
        R.S.stepFrames(10);
        const king = R.units.unitAt(6, 4);
        const clipBefore = idleName(king);
        const g = R.units.playGesture({ row: 6, col: 4 }, 'cheer');
        R.S.stepFrames(5);
        assert.equal(idleName(king), clipBefore, 'walk clip untouched by the gesture');
        await H.runUntil(R.S, Promise.all([p, g]));
        R.S.stepFrames(30);
        H.assertSynced(R.S, R.units, E, 'after move + gesture');
    });

    test('empty, null and dead-king squares resolve at once', async () => {
        const R = await rig();
        for (const sq of [{ row: 4, col: 4 }, null, undefined]) {
            let done = false;
            R.units.playGesture(sq, 'talk').then(() => { done = true; });
            await null; await null;
            assert.equal(done, true, JSON.stringify(sq));
        }
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await H.runUntil(R.S, R.units.playMove(R.E.apply(mv)));
        await H.runUntil(R.S, R.units.playGameOver({ result: 'checkmate', loser: 'w', kingSquare: WK }));
        let done = false;
        R.units.playGesture(WK, 'talk').then(() => { done = true; });
        await null; await null;
        assert.equal(done, true, 'dead king');
    });

    test('unknown kind falls back to talk; 50 rapid calls leave no stacked state', async () => {
        const R = await rig();
        const ps = [];
        for (let i = 0; i < 50; i++) ps.push(R.units.playGesture(WK, i % 2 ? 'taunt' : 'nonsense'));
        await H.runUntil(R.S, Promise.all(ps), { max: 3 });
        R.S.stepFrames(30);
        assertRest(R, WK, 'after 50 calls');
        H.assertSynced(R.S, R.units, R.E, 'after 50 calls');
        assert.equal(R.units.isBusy(), false);
    });

    test("one king's new gesture does not cut the other king's gesture short", async () => {
        const R = await rig();
        let blackDone = false;
        R.units.playGesture(BK, 'shrug').then(() => { blackDone = true; });
        R.S.stepFrames(5);
        R.units.playGesture(WK, 'talk');
        R.S.stepFrames(5);
        R.units.playGesture(WK, 'taunt'); // replaces only the white king's gesture
        await null; await null;
        assert.equal(blackDone, false, 'black king still gesturing');
        assert.ok(R.units.unitAt(BK.row, BK.col).nod, 'black nod still running');
    });
});
