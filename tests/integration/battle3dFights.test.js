'use strict';
// v2 fights (battle3d/fights.js through units.js) with the real three.js: every attacker x victim
// pairing in both colors in Full and Fast, timing budgets, signature pairings, Skip at random
// frames, FX/trail/cinematic bookkeeping, keepAlive tokens and the no-cinematic fallback.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('../helpers/battle3dUnitsHarness');
const { findThree, ROOT } = require('../helpers/loadBattle3dThree');
const { rng } = require('../helpers/loadBattle3dRules');

const skip = findThree() ? false : 'three.js not installed';
const ATTACKERS = ['p', 'n', 'b', 'r', 'q', 'k'];
const VICTIMS = ['p', 'n', 'b', 'r', 'q'];
const FULL_RANGE = [2.5, 5.5];   // contract: Full 3 to 5 s (fights agent sweep: 3.0 to 5.07)
const FAST_MAX = 1.3;            // contract: Fast <= ~1.3 s

let M, SOUND_NAMES, fights;

// One units instance per scene flavor; each capture re-syncs the board.
async function rig(opts = {}) {
    const S = H.makeScene(M.THREE, opts);
    const audio = H.makeAudio(SOUND_NAMES);
    const units = await M.createUnits(S, 'battle3d/assets/manifest.json', { audio });
    return { S, units, audio };
}

// Plays one capture; returns { secs, plan }. Leaves the board synced (asserted).
async function capture(R, color, a, v, mode, label, dt = 1 / 60) {
    const { fen, move } = H.captureSetup(color, a, v);
    const E = H.rulesAt(fen);
    R.units.syncBoard(E.get('board'));
    R.units.setMode(mode);
    const ev = E.apply(move);
    const victim = R.units.unitAt(ev.captured.square.row, ev.captured.square.col);
    const p = R.units.playMove(ev);
    assert.equal(R.units.unitAt(ev.captured.square.row, ev.captured.square.col) === victim && (ev.captured.square.row !== ev.to.row || ev.captured.square.col !== ev.to.col), false, `${label}: victim no longer on the grid`);
    const secs = await H.runUntil(R.S, p, { dt, label });
    H.assertSynced(R.S, R.units, E, label);
    assert.ok(!victim.root.parent, `${label}: victim removed from the scene`);
    return { secs, plan: R.units.lastFightPlan(), E };
}

describe('battle3d fights (v2)', { skip }, () => {
    before(async () => {
        M = await H.loadUnitsModule();
        ({ SOUND_NAMES } = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'audio.js')).href));
        fights = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'fights.js')).href);
    });

    test('fights.js data: every role has variants, pairings are well formed', () => {
        for (const t of ATTACKERS) {
            const list = fights.ROLE_STYLES[t];
            assert.ok(Array.isArray(list) && list.length >= 2, `${t} variants`);
            for (const s of list) assert.ok(s.name && s.finisher, `${t} ${JSON.stringify(s)}`);
        }
        const ids = fights.PAIRINGS.map((p) => p.id);
        for (const id of ['underdog', 'queenDuel', 'shieldClash', 'knightDuel', 'spellDuel', 'royal']) assert.ok(ids.includes(id), id);
        for (const p of fights.PAIRINGS) assert.equal(typeof p.match, 'function');
    });

    for (const mode of ['full', 'fast']) {
        test(`every attacker x victim, both colors (${mode}): in budget, in sync, FX and camera balanced`, async (t) => {
            const R = await rig();
            const times = [];
            const plans = new Set();
            for (const color of ['w', 'b']) {
                for (const a of ATTACKERS) {
                    for (const v of VICTIMS) {
                        const label = `${mode} ${color}${a}x${v}`;
                        const ends0 = R.S.rec.ends, lb0 = R.S.rec.letterboxOn;
                        const { secs, plan } = await capture(R, color, a, v, mode, label);
                        times.push(secs);
                        plans.add(plan);
                        if (mode === 'full') {
                            assert.ok(secs >= FULL_RANGE[0] && secs <= FULL_RANGE[1], `${label} [${plan}]: ${secs.toFixed(2)} s`);
                            assert.ok(R.S.rec.letterboxOn > lb0, `${label}: letterbox on`);
                            assert.ok(R.S.rec.ends > ends0, `${label}: cinematic.end() called`);
                        } else {
                            assert.ok(secs <= FAST_MAX, `${label} [${plan}]: ${secs.toFixed(2)} s`);
                            assert.equal(R.S.rec.letterboxOn, lb0, `${label}: no cinematic in fast mode`);
                        }
                        assert.equal(R.S.rec.letterbox, false, `${label}: letterbox off afterwards`);
                        assert.equal(R.S.rec.trailsOpen, 0, `${label}: every trail stopped`);
                        assert.equal(R.S.rec.tokens.has('units-fight'), false, `${label}: fight keepAlive released`);
                        assert.equal(R.units.isBusy(), false);
                    }
                }
            }
            assert.deepEqual(R.S.rec.problems, [], 'invalid FX/camera arguments');
            assert.deepEqual(R.audio.played.filter((n) => /INVALID|BADRATE/.test(n)), [], 'audio names');
            if (mode === 'full') {
                for (const id of ['underdog', 'queenDuel', 'shieldClash', 'knightDuel', 'spellDuel']) assert.ok(plans.has(id), `pairing ${id} played (saw ${[...plans]})`);
                assert.ok(R.S.rec.trailsStarted > 20 && R.S.rec.impacts > 30 && R.S.rec.shots.length > 60, JSON.stringify({ trails: R.S.rec.trailsStarted, impacts: R.S.rec.impacts, shots: R.S.rec.shots.length }));
                assert.ok(R.S.rec.debris > 0 && R.S.rec.decals > 0, 'debris and decals used');
                assert.ok(['whoosh', 'hit', 'death'].every((n) => R.audio.played.includes(n)), 'fight sounds');
            }
            const min = Math.min(...times), max = Math.max(...times);
            t.diagnostic(`${mode}: ${times.length} captures, ${min.toFixed(2)} to ${max.toFixed(2)} s, plans: ${[...plans].join(' ')}`);
        });
    }

    test('Fast stays within budget at 30 fps (low-end devices)', async (t) => {
        const R = await rig();
        let max = 0;
        for (const color of ['w', 'b']) {
            for (const a of ATTACKERS) {
                for (const v of VICTIMS) {
                    const { secs, plan } = await capture(R, color, a, v, 'fast', `fast@30 ${color}${a}x${v}`, 1 / 30);
                    assert.ok(secs <= FAST_MAX, `fast@30 ${color}${a}x${v} [${plan}]: ${secs.toFixed(2)} s`);
                    max = Math.max(max, secs);
                }
            }
        }
        t.diagnostic(`fast@30 max ${max.toFixed(2)} s`);
    });

    test('every role variant appears over repeated Full captures', async () => {
        const R = await rig();
        const seen = new Set();
        for (let i = 0; i < 6; i++) {
            for (const a of ATTACKERS) {
                const { plan } = await capture(R, i % 2 ? 'b' : 'w', a, 'p', 'full', `variant ${a} #${i}`);
                seen.add(`${a}:${plan}`);
            }
        }
        const missing = [];
        for (const a of ATTACKERS) for (const s of fights.ROLE_STYLES[a]) if (!seen.has(`${a}:${s.name}`) && !(a === 'k' && seen.has('k:royal'))) missing.push(`${a}:${s.name}`);
        // Random choice: allow at most one variant to be unlucky in 6 tries.
        assert.ok(missing.length <= 1, `variants never played: ${missing.join(', ')}`);
    });

    test('Skip at random frames always ends in sync with no open trails or letterbox', async () => {
        const R = await rig();
        const rand = rng(31337);
        for (let i = 0; i < 40; i++) {
            const color = rand() < 0.5 ? 'w' : 'b';
            const a = ATTACKERS[Math.floor(rand() * ATTACKERS.length)];
            const v = VICTIMS[Math.floor(rand() * VICTIMS.length)];
            const mode = rand() < 0.7 ? 'full' : 'fast';
            const frames = Math.floor(rand() * (mode === 'full' ? 300 : 70));
            const { fen, move } = H.captureSetup(color, a, v);
            const E = H.rulesAt(fen);
            R.units.syncBoard(E.get('board'));
            R.units.setMode(mode);
            const label = `skip #${i} ${mode} ${color}${a}x${v} at frame ${frames}`;
            const p = R.units.playMove(E.apply(move));
            R.S.stepFrames(frames, 1 / 60);
            R.units.skip();
            let done = false;
            p.then(() => { done = true; });
            for (let k = 0; k < 5; k++) await null;
            assert.equal(done, true, `${label}: playMove resolved after skip`);
            assert.equal(R.units.isBusy(), false, label);
            H.assertSynced(R.S, R.units, E, label);
            assert.equal(R.S.rec.trailsOpen, 0, `${label}: trails`);
            assert.equal(R.S.rec.letterbox, false, `${label}: letterbox`);
            assert.equal(R.S.rec.tokens.has('units-fight'), false, `${label}: keepAlive`);
            // Idle frames afterwards must not move anyone off their square
            R.S.stepFrames(60, 1 / 30);
            H.assertSynced(R.S, R.units, E, `${label} + idle`);
        }
        assert.deepEqual(R.S.rec.problems, []);
    });

    test('no sounds and no FX calls while skipping (fast-forward is silent)', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('w', 'r', 'q');
        const E = H.rulesAt(fen);
        R.units.syncBoard(E.get('board'));
        R.units.setMode('full');
        const p = R.units.playMove(E.apply(move));
        R.S.stepFrames(10);
        const sounds = R.audio.played.length, impacts = R.S.rec.impacts, debris = R.S.rec.debris;
        R.units.skip();
        await p;
        assert.equal(R.audio.played.length, sounds, 'no audio during skip');
        assert.equal(R.S.rec.impacts, impacts);
        assert.equal(R.S.rec.debris, debris);
    });

    test('without cinematic/fx (v1 scene API) captures still complete and sync', async () => {
        const R = await rig({ v2: false });
        for (const [a, v] of [['p', 'q'], ['b', 'b'], ['r', 'r'], ['n', 'n'], ['k', 'p'], ['q', 'q']]) {
            for (const mode of ['full', 'fast']) await capture(R, 'w', a, v, mode, `fallback ${mode} ${a}x${v}`);
        }
        assert.ok(R.S.rec.focusOn > 0 && R.S.rec.restoreView > 0, 'falls back to focusOn/restoreView');
    });

    test('keepAlive: idle while units exist, units-fight only while busy', async () => {
        const R = await rig();
        const E = H.rulesAt();
        R.units.syncBoard(E.get('board'));
        R.S.stepFrames(2);
        assert.ok(R.S.rec.tokens.has('idle'), 'idle token');
        const p = R.units.playMove(E.apply('e2e4'));
        R.S.stepFrames(2);
        assert.ok(R.S.rec.tokens.has('units-fight'), 'fight token while moving');
        await H.runUntil(R.S, p);
        R.S.stepFrames(2);
        assert.equal(R.S.rec.tokens.has('units-fight'), false);
    });

    test('coarse pointer enlarges pick proxies', async () => {
        const fine = await rig({ coarse: false });
        const coarse = await rig({ coarse: true });
        const E = H.rulesAt();
        fine.units.syncBoard(E.get('board'));
        coarse.units.syncBoard(E.get('board'));
        const radius = (R) => { const u = R.units.unitAt(6, 4); u.proxy.geometry.computeBoundingBox(); return u.proxy.geometry.boundingBox.max.x; };
        assert.ok(radius(coarse) > radius(fine), `${radius(coarse)} > ${radius(fine)}`);
    });

    test('legend lists all 12 roles with glyphs and names', async () => {
        const R = await rig();
        const legend = R.units.getLegend();
        assert.equal(legend.length, 12);
        for (const e of legend) {
            assert.ok(['w', 'b'].includes(e.color) && 'pnbrqk'.includes(e.type), JSON.stringify(e));
            assert.ok(e.name && e.glyph && e.role, JSON.stringify(e));
        }
    });
});
