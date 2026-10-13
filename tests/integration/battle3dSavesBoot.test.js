'use strict';
// The real 3D page opened with unusable stored data (one page per process, hence a file of its own;
// battle3dSaves.test.js boots with a good autosave): an autosave that cannot be replayed and a saves
// list that is not even JSON must not break the boot. The page starts a new game, says so in one
// short notice, stays fully playable, and the unreadable list is set aside when the next save is written.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
const BAD_AUTOSAVE = JSON.stringify({ v: 1, view: '3d', mode: 'ai-ai', humanColor: 'b', elo: 2000, startFen: null, moves: ['e2e4', 'e7e5', 'e4e5', 'a7a6'], san: ['e4', 'e5', 'e5', 'a6'], result: '*', savedAt: 1, startedAt: 1 });
const BAD_SAVES = '{"v":1,"saves":[{"id":"s1","name":"Half a save","mov';
let P;

describe('battle3d boot with unusable saved data (real page)', { skip }, () => {
    before(async () => {
        P = await bootPage({
            setup(w) {
                w.localStorage.setItem('battle3d.tipSeen', '1');
                w.localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', speed: 'fast', talk: 'off' }));
                w.localStorage.setItem('chess.autosave.3d', BAD_AUTOSAVE);
                w.localStorage.setItem('chess.saves', BAD_SAVES);
            },
        });
    });
    after(() => { if (P) P.restore(); });

    test('the page boots into a new game and says so in a short notice', async () => {
        await P.stepUntil(() => !P.state().moving, { label: 'boot' });
        assert.equal(P.state().fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
        assert.deepEqual(P.state().history, []);
        assert.equal(P.state().mode, 'human-human', 'the settings of the broken autosave are not taken over');
        assert.equal(P.$('tip').hidden, false);
        assert.equal(P.$('tip-text').textContent, 'Your saved game could not be read, so a new game was started.');
        assert.equal(P.w.localStorage.getItem('chess.autosave.3d'), null, 'the broken autosave is gone');
        await P.sleep(650);
        assert.equal(P.$('loading').hidden, true);
        assert.deepEqual(P.errors, []);
    });

    test('the game is playable, autosaves again, and Save / Load works next to the unreadable list', async () => {
        for (const name of ['e2', 'e4']) { const { row, col } = square(name); P.B.controller.clickSquare(row, col); }
        P.B.controller.skip();
        await P.stepUntil(() => !P.state().moving, { label: 'first move' });
        assert.deepEqual(P.state().history, ['e4']);
        assert.deepEqual(JSON.parse(P.w.localStorage.getItem('chess.autosave.3d')).moves, ['e2e4']);

        P.$('save-open').click();
        assert.equal(P.$('save-modal').hidden, false);
        assert.equal(P.$('save-list').children.length, 0);
        assert.match(P.$('save-count').textContent, /0 of 30 saves used\. Older saves could not be read and were set aside\./);
        assert.equal(P.w.localStorage.getItem('chess.saves'), BAD_SAVES, 'looking at the list does not touch the stored data');
        P.$('save-name').value = 'After the crash';
        P.$('save-submit').click();
        assert.equal(P.$('save-status').textContent, 'Saved as "After the crash".');
        assert.equal(JSON.parse(P.w.localStorage.getItem('chess.saves')).saves.length, 1);
        assert.equal(P.w.localStorage.getItem('chess.saves.unreadable'), BAD_SAVES, 'kept aside, not deleted');
        P.$('save-close').click();
        assert.deepEqual(P.errors, []);
    });
});
