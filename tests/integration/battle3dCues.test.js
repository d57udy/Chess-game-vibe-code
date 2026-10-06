'use strict';
// v4 sound cues from units.js / fights.js, timed on the scene clock with the real three.js: footsteps
// (count, rhythm, variant per role/army, frame-rate independent), knight jump/land, one settle at the
// end of every move, castle, capture order (whoosh -> impact -> fall -> settle), skeleton shatter,
// hero dissolve, promotion, checkmate victory once, skip silences the rest, slow-mo returns to 1.
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const H = require('../helpers/battle3dUnitsHarness');
const { findThree, ROOT } = require('../helpers/loadBattle3dThree');

const skip = findThree() ? false : 'three.js not installed';
const CONTRACT = ['step', 'jump', 'land', 'settle', 'select', 'deselect', 'invalid', 'castle', 'whoosh', 'clang', 'hit', 'bone',
    'shatter', 'slam', 'zap', 'bolt', 'magicHit', 'fall', 'dissolve', 'death', 'promote', 'check', 'checkmate', 'victory', 'draw'];
const IMPACTS = new Set(['hit', 'bone', 'magicHit', 'clang']);
let M;

async function rig() {
    const S = H.makeScene(M.THREE);
    const audio = H.makeAudio(CONTRACT, { v4: true, clock: S.now });
    const units = await M.createUnits(S, 'battle3d/assets/manifest.json', { audio });
    return { S, units, audio };
}
// Plays moves from a FEN (or the start) and returns the cue list of the last move only.
async function cuesOf(R, fen, moves, { mode = 'full', dt = 1 / 60 } = {}) {
    const E = H.rulesAt(fen);
    R.units.syncBoard(E.get('board'));
    R.units.setMode(mode);
    let cues = [];
    for (const mv of moves) {
        R.S.stepFrames(2, dt);
        const from = R.audio.cues.length;
        await H.runUntil(R.S, R.units.playMove(E.apply(mv)), { dt, label: mv });
        cues = R.audio.cues.slice(from);
    }
    R.S.stepFrames(Math.round(1 / dt)); // trailing cues (late deaths) would show up here
    return { cues, E };
}
const names = (cues) => cues.map((c) => c.name);
const steps = (cues) => cues.filter((c) => c.name === 'step');
const first = (cues, pred) => cues.findIndex(pred);
const finitePos = (c) => c.opts.pos && ['x', 'y', 'z'].every((k) => Number.isFinite(c.opts.pos[k]));

describe('battle3d v4 sound cues (units/fights)', { skip }, () => {
    before(async () => { M = await H.loadUnitsModule(); });

    test('quiet pawn move: steady light steps, one settle at the end, every cue positioned', async () => {
        const R = await rig();
        const { cues } = await cuesOf(R, null, ['e2e4']);
        const st = steps(cues);
        assert.ok(st.length >= 3 && st.length <= 10, `steps ${st.length}: ${names(cues)}`);
        assert.ok(st.every((c) => c.opts.variant === 'light'), `variants ${st.map((c) => c.opts.variant)}`);
        const gaps = st.slice(1).map((c, i) => c.t - st[i].t);
        assert.ok(gaps.every((g) => g >= 0.12), `min gap ${Math.min(...gaps).toFixed(3)}`);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
        assert.ok(sd / mean < 0.35, `steady rhythm: gaps ${gaps.map((g) => g.toFixed(2))}`);
        assert.equal(names(cues).filter((n) => n === 'settle').length, 1, 'exactly one settle');
        assert.equal(cues[cues.length - 1].name, 'settle', 'settle is the last cue');
        assert.ok(cues.every(finitePos), 'every cue has a finite world position');
        assert.deepEqual(R.audio.played.filter((n) => /INVALID|BADRATE/.test(n)), []);
    });

    test('a 3-square walk: about two steps per walk cycle, the same at 30 and 60 fps', async () => {
        const counts = {};
        for (const fps of [60, 30]) {
            const R = await rig();
            const { cues } = await cuesOf(R, '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', ['a1a4'], { dt: 1 / fps });
            const st = steps(cues);
            counts[fps] = st.length;
            assert.ok(st.every((c) => c.opts.variant === 'heavy'), 'rook steps are heavy');
            const dur = st[st.length - 1].t - st[0].t;
            const perSec = (st.length - 1) / Math.max(0.01, dur);
            assert.ok(perSec > 1.2 && perSec < 6, `${fps} fps: ${st.length} steps, ${perSec.toFixed(2)}/s`);
        }
        assert.ok(Math.abs(counts[60] - counts[30]) <= 2, `fps independent: ${JSON.stringify(counts)}`);
    });

    test('foot contacts: two phases per cycle from the clip; each step fires at a contact', async () => {
        const R = await rig();
        for (const clip of ['Walking_A', 'Walking_B', 'Walking_D_Skeletons']) {
            const st = R.units._clipStats(clip);
            assert.ok(Array.isArray(st.contacts) && st.contacts.length === 2, `${clip} ${JSON.stringify(st.contacts)}`);
            for (const c of st.contacts) assert.ok(c >= 0 && c < 1, `${clip}: contact phase ${c} in [0,1)`);
            const gap = Math.abs(st.contacts[1] - st.contacts[0]);
            assert.ok(gap > 0.3 && gap < 0.7, `${clip}: feet about half a cycle apart (${gap.toFixed(2)})`);
        }
        // At every step cue, the walking unit's clip phase sits on one of its contacts (within ~1 frame).
        const misses = [];
        let checked = 0;
        const orig = R.audio.play;
        R.audio.play = (name, opts) => {
            if (name === 'step') {
                for (const u of R.units._units) {
                    const L = u.loco;
                    if (!L) continue;
                    const dur = L.action.getClip().duration;
                    const phase = (L.action.time % dur) / dur;
                    checked++;
                    const d = Math.min(...L.contacts.map((c) => { const x = Math.abs(phase - c); return Math.min(x, 1 - x); }));
                    const tol = (L.action.getEffectiveTimeScale() / 60) / dur + 0.01;
                    if (d > tol) misses.push(`${u.color}${u.type} phase ${phase.toFixed(3)} vs ${L.contacts.map((c) => c.toFixed(3))}`);
                }
            }
            return orig(name, opts);
        };
        await cuesOf(R, null, ['e2e4', 'e7e5', 'b1c3', 'f8c5']);
        await cuesOf(R, '4k3/8/8/8/8/8/8/R3K3 w - - 0 1', ['a1a5']);
        assert.ok(steps(R.audio.cues).length > 8);
        assert.ok(checked >= steps(R.audio.cues).length, `checked ${checked} steps against a walking unit`);
        assert.deepEqual(misses, []);
    });

    test('step variants by role and army: armor for knight/king heroes, bone for skeletons', async () => {
        const R = await rig();
        let { cues } = await cuesOf(R, '4k3/8/8/8/8/8/8/4K3 w - - 0 1', ['e1e2']);
        assert.ok(steps(cues).every((c) => c.opts.variant === 'armor'), `king ${steps(cues).map((c) => c.opts.variant)}`);
        ({ cues } = await cuesOf(R, null, ['e2e4', 'e7e5']));
        assert.ok(steps(cues).length > 0 && steps(cues).every((c) => c.opts.variant === 'bone'), `skeleton pawn ${steps(cues).map((c) => c.opts.variant)}`);
        ({ cues } = await cuesOf(R, '4k2r/8/8/8/8/8/8/4K3 b - - 0 1', ['h8h5']));
        assert.ok(steps(cues).every((c) => c.opts.variant === 'heavy'), 'skeleton rook heavy');
    });

    test('knight: jump then land, then one settle; no walking steps mid-air', async () => {
        const R = await rig();
        const { cues } = await cuesOf(R, null, ['g1f3']);
        const n = names(cues);
        const j = n.indexOf('jump'), l = n.indexOf('land');
        assert.ok(j >= 0 && l > j, `jump before land: ${n}`);
        assert.equal(n.filter((x) => x === 'jump').length, 1);
        assert.equal(n.filter((x) => x === 'land').length, 1);
        assert.ok(cues[l].t - cues[j].t > 0.2, 'airtime between jump and land');
        assert.ok(!cues.slice(j + 1, l).some((c) => c.name === 'step'), 'no steps in the air');
        assert.equal(n[n.length - 1], 'settle');
        assert.equal(n.filter((x) => x === 'settle').length, 1);
    });

    test('castling: castle first, both pieces settle', async () => {
        const R = await rig();
        const { cues } = await cuesOf(R, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1']);
        const n = names(cues);
        assert.equal(n[0], 'castle', n.join(' '));
        assert.equal(n.filter((x) => x === 'settle').length, 2, 'king and rook settle');
        assert.equal(n[n.length - 1], 'settle');
    });

    test('capture of a skeleton (Full): whoosh -> impact -> shatter/fall, then the attacker settles', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('w', 'r', 'p');
        const { cues } = await cuesOf(R, fen, [move]);
        const n = names(cues);
        const w = first(cues, (c) => c.name === 'whoosh');
        const i = first(cues, (c) => IMPACTS.has(c.name));
        const sh = n.indexOf('shatter');
        assert.ok(w >= 0 && i > w, `whoosh before impact: ${n}`);
        assert.ok(sh > i, 'skeleton shatters after the hit');
        assert.ok(cues.filter((c) => c.name === 'whoosh').every((c) => ['light', 'heavy', 'magic'].includes(c.opts.variant)), 'whoosh variants');
        assert.ok(n.includes('bone'), 'bone hit on a skeleton');
        assert.equal(n.filter((x) => x === 'shatter').length, 1);
        assert.equal(n[n.length - 1], 'settle', `settle last: ${n.slice(-4)}`);
        assert.equal(n.filter((x) => x === 'settle').length, 1);
    });

    test('capture of a hero (Full): hit, fall, dissolve, death; nothing doubled', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('b', 'q', 'n');
        const { cues } = await cuesOf(R, fen, [move]);
        const n = names(cues);
        for (const want of ['hit', 'fall', 'dissolve', 'death']) assert.ok(n.includes(want), `${want} in ${n}`);
        assert.ok(n.indexOf('hit') < n.indexOf('fall'), 'hit before fall');
        for (const once of ['fall', 'dissolve', 'death', 'settle']) assert.equal(n.filter((x) => x === once).length, 1, `${once} once`);
        assert.ok(!n.includes('shatter'), 'heroes do not shatter');
    });

    test('bishop: zap at the cast, bolt in flight, magicHit on arrival', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('w', 'b', 'r');
        const { cues } = await cuesOf(R, fen, [move]);
        const n = names(cues);
        const z = n.indexOf('zap'), b = n.indexOf('bolt'), h = n.indexOf('magicHit');
        assert.ok(z >= 0 && b >= 0 && h >= 0, n.join(' '));
        assert.ok(b < h, 'bolt before its hit');
    });

    test('Fast captures still give whoosh, impact and settle (no cinematic beats)', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('w', 'n', 'p');
        const { cues } = await cuesOf(R, fen, [move], { mode: 'fast' });
        const n = names(cues);
        assert.ok(n.includes('whoosh') && n.some((x) => IMPACTS.has(x)), n.join(' '));
        assert.equal(n[n.length - 1], 'settle');
    });

    test('promotion emits promote once', async () => {
        const R = await rig();
        const { cues } = await cuesOf(R, '1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q']);
        assert.equal(names(cues).filter((x) => x === 'promote').length, 1, names(cues).join(' '));
    });

    test('checkmate: the mated king falls; victory exactly once; draw gives no victory', async () => {
        const R = await rig();
        const E = H.rulesAt();
        R.units.syncBoard(E.get('board'));
        for (const mv of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) await H.runUntil(R.S, R.units.playMove(E.apply(mv)));
        let from = R.audio.cues.length;
        await H.runUntil(R.S, R.units.playGameOver({ result: 'checkmate', loser: 'w', kingSquare: { row: 7, col: 4 } }));
        R.S.stepFrames(240);
        let n = names(R.audio.cues.slice(from));
        assert.equal(n.filter((x) => x === 'victory').length, 1, n.join(' '));
        assert.ok(n.includes('fall'), 'the king falls');
        from = R.audio.cues.length;
        await H.runUntil(R.S, R.units.playGameOver({ result: 'stalemate', loser: null, kingSquare: null }));
        R.S.stepFrames(240);
        n = names(R.audio.cues.slice(from));
        assert.ok(!n.includes('victory') && !n.includes('checkmate'), `draw finale: ${n}`);
    });

    test('skip: no cue plays during or after the fast-forward', async () => {
        const R = await rig();
        const { fen, move } = H.captureSetup('w', 'q', 'r');
        const E = H.rulesAt(fen);
        R.units.syncBoard(E.get('board'));
        const p = R.units.playMove(E.apply(move));
        R.S.stepFrames(30);
        const n = R.audio.cues.length;
        R.units.skip();
        await p;
        R.S.stepFrames(600);
        assert.deepEqual(names(R.audio.cues.slice(n)), [], 'silent after skip');
        assert.equal(R.audio.slowMo.length ? R.audio.slowMo[R.audio.slowMo.length - 1] : 1, 1, 'slow-mo released');
    });

    test('slow-mo hooks always end at 1 across Full fights', async () => {
        const R = await rig();
        for (const [c, a, v] of [['w', 'p', 'q'], ['b', 'r', 'r'], ['w', 'k', 'n'], ['b', 'q', 'q']]) {
            const { fen, move } = H.captureSetup(c, a, v);
            await cuesOf(R, fen, [move]);
        }
        assert.ok(R.audio.slowMo.length > 0, 'slow-mo used in Full fights');
        assert.equal(R.audio.slowMo[R.audio.slowMo.length - 1], 1);
        assert.ok(R.audio.slowMo.every((f) => Number.isFinite(f) && f > 0 && f <= 1), JSON.stringify(R.audio.slowMo));
    });

    test('every cue name is in the contract bank', async () => {
        const R = await rig();
        for (const [c, a, v] of [['w', 'b', 'b'], ['b', 'n', 'n'], ['w', 'r', 'r'], ['b', 'p', 'q']]) {
            const { fen, move } = H.captureSetup(c, a, v);
            await cuesOf(R, fen, [move]);
        }
        assert.deepEqual(R.audio.played.filter((n) => /INVALID|BADRATE/.test(n)), []);
        assert.ok(R.audio.cues.every(finitePos), 'positioned');
    });
});
