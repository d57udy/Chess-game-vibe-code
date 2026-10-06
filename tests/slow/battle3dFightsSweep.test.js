'use strict';
// Heavy fight sweep (RUN_SLOW=1): every attacker x victim x color, 3 repetitions per mode at 30 and
// 60 fps, plus Skip at 6 frame offsets for each pairing. Reports timing ranges per mode and fps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../helpers/battle3dUnitsHarness');
const { findThree } = require('../helpers/loadBattle3dThree');

const skip = !process.env.RUN_SLOW ? 'slow: set RUN_SLOW=1 (npm run test:slow)' : (!findThree() && 'three.js not installed');

test('battle3d fights sweep: budgets, sync and skip at many offsets', { skip, timeout: 600000 }, async (t) => {
    const M = await H.loadUnitsModule();
    const S = H.makeScene(M.THREE);
    const units = await M.createUnits(S, 'battle3d/assets/manifest.json', {});
    const ranges = {};
    let skips = 0;
    for (const color of ['w', 'b']) {
        for (const a of 'pnbrqk') {
            for (const v of 'pnbrq') {
                for (const mode of ['full', 'fast']) {
                    for (const fps of [20, 30, 60]) {
                        for (let rep = 0; rep < 3; rep++) {
                            const { fen, move } = H.captureSetup(color, a, v);
                            const E = H.rulesAt(fen);
                            units.syncBoard(E.get('board'));
                            units.setMode(mode);
                            const secs = await H.runUntil(S, units.playMove(E.apply(move)), { dt: 1 / fps });
                            H.assertSynced(S, units, E, `${mode}@${fps} ${color}${a}x${v}`);
                            const key = `${mode}@${fps}`;
                            const r = (ranges[key] ||= { min: Infinity, max: 0 });
                            r.min = Math.min(r.min, secs); r.max = Math.max(r.max, secs);
                        }
                    }
                    for (const frames of [1, 15, 45, 90, 160, 260]) {
                        const { fen, move } = H.captureSetup(color, a, v);
                        const E = H.rulesAt(fen);
                        units.syncBoard(E.get('board'));
                        units.setMode(mode);
                        const p = units.playMove(E.apply(move));
                        S.stepFrames(frames);
                        units.skip();
                        await p;
                        H.assertSynced(S, units, E, `skip@${frames} ${mode} ${color}${a}x${v}`);
                        assert.equal(S.rec.trailsOpen, 0);
                        assert.equal(S.rec.letterbox, false);
                        skips++;
                    }
                }
            }
        }
    }
    assert.deepEqual(S.rec.problems, []);
    assert.ok(ranges['full@60'].min >= 2.5 && ranges['full@60'].max <= 5.5, JSON.stringify(ranges));
    assert.ok(ranges['fast@60'].max <= 1.3 && ranges['fast@30'].max <= 1.3, JSON.stringify(ranges));
    assert.ok(ranges['full@30'].min >= 2.5 && ranges['full@30'].max <= 5.5, JSON.stringify(ranges));
    t.diagnostic(`${skips} skips; ` + Object.entries(ranges).map(([k, r]) => `${k} ${r.min.toFixed(2)}-${r.max.toFixed(2)} s`).join(', '));
});
