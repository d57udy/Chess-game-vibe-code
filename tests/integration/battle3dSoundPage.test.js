'use strict';
// v4 sound on the real page (main.js + controller + units + audio): the game-state cues from the
// controller and the motion cues from units together, so nothing is doubled: one settle per quiet
// move, one castle per castling, one check per check, checkmate + one victory on mate, draw on
// stalemate; UI cues on selection; no mp3 requested by the 3D page; ambience setting persists.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { findThree } = require('../helpers/loadBattle3dThree');
const { bootPage } = require('../helpers/loadBattle3dPage');
const { square } = require('../helpers/loadEngine');

const skip = findThree() ? false : 'three.js not installed';
let P, rec;

async function play(mv) {
    const f = square(mv.slice(0, 2)), t = square(mv.slice(2, 4));
    const from = rec.length;
    P.B.controller.clickSquare(f.row, f.col);
    P.B.controller.clickSquare(t.row, t.col);
    if (mv[4]) P.B.controller.choosePromotion(mv[4].toUpperCase());
    await P.stepUntil(() => !P.state().busy && !P.B.units.isBusy(), { label: mv });
    P.B.step(120); // trailing cues
    return rec.slice(from).filter((n) => !['select', 'deselect', 'invalid'].includes(n));
}
const count = (list, n) => list.filter((x) => x === n).length;

describe('battle3d v4 sound on the page', { skip }, () => {
    before(async () => {
        P = await bootPage({ setup: (w) => w.localStorage.setItem('battle3d.settings', JSON.stringify({ mode: 'human-human', speed: 'fast' })) });
        rec = [];
        const orig = P.B.audio.play;
        P.B.audio.play = (name, opts) => { rec.push(name); return orig.call(P.B.audio, name, opts); };
    });
    after(() => { if (P) P.restore(); });

    test('the 3D page requests no mp3', () => {
        assert.deepEqual(P.env.fetched.filter((u) => /\.mp3(\?|$)/.test(u)), []);
    });

    test('selection cues: select, deselect on re-click, invalid on an illegal square', () => {
        const from = rec.length;
        P.B.controller.clickSquare(6, 4); // e2
        P.B.controller.clickSquare(6, 4); // again: cancel
        P.B.controller.clickSquare(6, 4);
        P.B.controller.clickSquare(3, 4); // e5: illegal
        assert.deepEqual(rec.slice(from), ['select', 'deselect', 'select', 'invalid']);
    });

    test('quiet moves: exactly one settle each, no 2D-style move/capture cues', async () => {
        for (const mv of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']) {
            const cues = await play(mv);
            assert.equal(count(cues, 'settle'), 1, `${mv}: ${cues.join(' ')}`);
            assert.ok(!cues.includes('move') && !cues.includes('capture'), `${mv}: legacy cue`);
        }
    });

    test('castling: castle once, settle for king and rook', async () => {
        const cues = await play('e1g1');
        assert.equal(count(cues, 'castle'), 1, `castle doubled? ${cues.join(' ')}`);
        assert.equal(count(cues, 'settle'), 2, cues.join(' '));
    });

    test('check: one check cue after the king reacts', async () => {
        P.B.controller.loadFen('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
        await P.stepUntil(() => !P.state().busy);
        const cues = await play('a1a8');
        assert.equal(count(cues, 'check'), 1, cues.join(' '));
        assert.ok(cues.lastIndexOf('check') > cues.indexOf('settle'), 'check after the arrival');
    });

    test('checkmate: one checkmate gong and one victory', async () => {
        P.B.controller.newGame();
        await P.stepUntil(() => !P.state().busy);
        let cues = [];
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) cues = await play(mv);
        P.B.step(600);
        cues = rec.slice(rec.lastIndexOf('checkmate') - 20);
        assert.equal(count(cues, 'checkmate'), 1, cues.join(' '));
        assert.equal(count(cues, 'victory'), 1, `victory doubled? ${cues.join(' ')}`);
        assert.equal(count(cues, 'draw'), 0);
    });

    test('stalemate: draw, no checkmate or victory', async () => {
        P.B.controller.loadFen('7k/8/6K1/5Q2/8/8/8/8 w - - 0 1');
        await P.stepUntil(() => !P.state().busy);
        const cues = await play('f5f7');
        P.B.step(600);
        const tail = rec.slice(rec.lastIndexOf('settle'));
        assert.equal(count(tail, 'draw'), 1, tail.join(' '));
        assert.ok(!tail.includes('victory') && !tail.includes('checkmate'), tail.join(' '));
        void cues;
    });

    test('ambience toggle is in the menu and persists in settings', () => {
        const box = P.$('ambience-toggle');
        assert.ok(box, '#ambience-toggle exists');
        box.checked = false;
        box.dispatchEvent(new P.w.Event('change'));
        assert.equal(JSON.parse(P.w.localStorage.getItem('battle3d.settings')).ambience, false);
        assert.equal(P.B.audio.isAmbience(), false);
        box.checked = true;
        box.dispatchEvent(new P.w.Event('change'));
        assert.equal(JSON.parse(P.w.localStorage.getItem('battle3d.settings')).ambience, true);
        P.$('mute').click();
        assert.equal(box.disabled, true, 'ambience control disabled while muted');
        P.$('mute').click();
    });

    test('no console errors', () => {
        assert.deepEqual(P.errors.filter((e) => !/Error creating WebGL context/.test(e)), []);
    });
});
