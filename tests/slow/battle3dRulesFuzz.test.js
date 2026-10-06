'use strict';
// 200 seeded random games through battle3d/rules.js, checked ply by ply against the ui.js
// reference and the engine (skipped by `npm test` unless RUN_SLOW=1). A 25-game version runs in
// tests/unit/battle3dRules.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomPlayouts } = require('../helpers/loadBattle3dRules');

const skip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';

test('battle3d rules: 200 random games x 120 plies match the ui.js reference and the engine', { skip }, (t) => {
    const stats = randomPlayouts({ games: 200, plies: 120, seed: 0xB3D });
    t.diagnostic(JSON.stringify(stats));
    assert.ok(stats.plies > 10000, JSON.stringify(stats));
    assert.ok(stats.castles > 5 && stats.eps > 1 && stats.promos > 5 && stats.captures > 1000, JSON.stringify(stats));
    assert.ok(Object.keys(stats.endings).length >= 2, JSON.stringify(stats.endings));
});
