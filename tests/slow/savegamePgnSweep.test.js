'use strict';
// 240 seeded random games through the game's rules and chess.js: the exported PGN equals the reference
// byte for byte and imports back to the same game (skipped by `npm test` unless RUN_SLOW=1). A 13-game
// version runs in tests/unit/savegame.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSaveGame, pgnSweep, SETUPS, THREE_QUEENS, SWEEP_KINDS } = require('../helpers/saveGameHarness');

const skip = process.env.RUN_SLOW ? false : 'slow: set RUN_SLOW=1 (npm run test:slow)';

test('savegame: 240 random games x 140 plies export as the reference PGN and import back', { skip }, (t) => {
    const starts = [];
    for (let i = 0; i < 20; i++) starts.push({}, {}, {}, {}, {}, {}, ...SETUPS.map((fen) => ({ fen })), THREE_QUEENS);
    const seen = pgnSweep(loadSaveGame(), { seed: 0x5A7E, starts, plies: 140 });
    t.diagnostic(JSON.stringify(seen));
    assert.equal(seen.games, 240);
    assert.ok(seen.plies > 12000, JSON.stringify(seen));
    for (const key of SWEEP_KINDS) assert.ok(seen[key] > 5, `${key}: ${JSON.stringify(seen)}`);
    assert.ok(seen.results['1-0'] > 5 && seen.results['0-1'] > 5 && seen.results['1/2-1/2'] > 0, JSON.stringify(seen.results));
});
