// Shared harness for running battle3d/units.js in node with the real three.js: a recording fake
// SceneAPI (v2 cinematic + fx + keepAlive), a fake audio, scene-clock stepping and sync checks.
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findThree, registerThree, installBrowserGlobals, ROOT } = require('./loadBattle3dThree');
const { loadBattle3dRules } = require('./loadBattle3dRules');
const { square } = require('./loadEngine');

const finiteVec = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/**
 * Loads three + units.js; returns null when three is not installed.
 * @param {object} [o] o.dom=false keeps an existing document/location (e.g. the jsdom scene harness).
 */
async function loadUnitsModule(o = {}) {
    const three = findThree();
    if (!three) return null;
    registerThree(three.dir);
    const env = installBrowserGlobals(undefined, { dom: o.dom !== false });
    const THREE = await import('three');
    const { createUnits } = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'units.js')).href);
    return { THREE, createUnits, env };
}

/**
 * Fake SceneAPI over a real THREE.Scene. With `v2: false` it has no cinematic / fx (fallback path).
 * Records cinematic calls, open trails, FX calls and keepAlive tokens, and validates arguments.
 */
function makeScene(THREE, { v2 = true, coarse = false } = {}) {
    const updaters = new Set();
    const scene = new THREE.Scene();
    let t = 0;
    const rec = {
        problems: [],             // invalid arguments seen (NaN vectors, unknown kinds)
        shots: [], slowMo: 0, letterbox: false, letterboxOn: 0, ends: 0,
        trailsOpen: 0, trailsStarted: 0, impacts: 0, debris: 0, decals: 0, projectiles: 0,
        tokens: new Set(), renders: 0, focusOn: 0, restoreView: 0, skips: 0,
    };
    const check = (cond, msg) => { if (!cond) rec.problems.push(msg); };
    const S = {
        THREE, scene, camera: new THREE.PerspectiveCamera(), renderer: null, rec,
        squareToWorld: (row, col) => new THREE.Vector3(col - 3.5, 0, row - 3.5),
        onSquareClick() {}, onSquareHover() {},
        registerPickProxy() {}, unregisterPickProxy() {},
        setHighlights() {},
        setView: () => Promise.resolve(),
        focusOn() { rec.focusOn++; return Promise.resolve(); },
        restoreView() { rec.restoreView++; return Promise.resolve(); },
        addUpdater: (fn) => updaters.add(fn),
        removeUpdater: (fn) => updaters.delete(fn),
        setTimeScale() {}, getTimeScale: () => 1,
        shake(s) { check(Number.isFinite(s), 'shake NaN'); },
        burst(p, kind) { check(finiteVec(p), `burst ${kind} NaN position`); },
        stepFrames(n, dt = 1 / 60) { for (let i = 0; i < n; i++) { t += dt; for (const fn of [...updaters]) fn(dt, t); } },
        now: () => t,
        setPaused() {},
        requestRender() { rec.renders++; },
        keepAlive(token, on) { if (on) rec.tokens.add(token); else rec.tokens.delete(token); },
        isCoarsePointer: () => coarse,
    };
    if (v2) {
        S.cinematic = {
            shot(type, subjects, opts = {}) {
                check(['two-shot', 'closeup', 'over-shoulder', 'orbit'].includes(type), `unknown shot ${type}`);
                check(Array.isArray(subjects) && subjects.length > 0 && subjects.every(finiteVec), `shot ${type} bad subjects`);
                rec.shots.push(type);
                return Promise.resolve();
            },
            slowMo(scale, dur) { check(scale > 0 && scale <= 1 && dur >= 0, 'slowMo args'); rec.slowMo++; return Promise.resolve(); },
            letterbox(on) { rec.letterbox = !!on; if (on) rec.letterboxOn++; },
            end() { rec.ends++; return Promise.resolve(); },
        };
        S.fx = {
            trail(obj, opts = {}) {
                check(obj && obj.isObject3D, 'trail target not an Object3D');
                rec.trailsOpen++; rec.trailsStarted++;
                let stopped = false;
                return { stop() { if (!stopped) { stopped = true; rec.trailsOpen--; } } };
            },
            impact(p, d, kind) {
                check(finiteVec(p) && finiteVec(d), 'impact NaN');
                check(['slash', 'blunt', 'pierce', 'magic', 'bone'].includes(kind), `impact kind ${kind}`);
                rec.impacts++;
            },
            debris(p, opts = {}) { check(finiteVec(p), 'debris NaN'); check(['bones', 'armor', 'wood'].includes(opts.kind), `debris kind ${opts.kind}`); rec.debris++; },
            decal(p, kind) { check(finiteVec(p), 'decal NaN'); check(['scorch', 'crack'].includes(kind), `decal kind ${kind}`); rec.decals++; },
            skip() { rec.skips++; },
        };
        S.projectile = (from, to, opts) => { check(finiteVec(from) && finiteVec(to), 'projectile NaN'); rec.projectiles++; return Promise.resolve(); };
    }
    return S;
}

/**
 * Recording fake audio. With `v4: true` it exposes has() for the given names (the v4 bank), so
 * units.js plays its v4 cue names; `clock` (e.g. S.now) stamps each cue with scene time.
 */
function makeAudio(validNames, { v4 = false, clock = null } = {}) {
    const played = [];
    const cues = []; // { name, opts, t }
    const slowMo = [];
    const a = {
        played, cues, slowMo,
        play(name, opts = {}) {
            if (validNames && !validNames.includes(name)) played.push('INVALID:' + name);
            else played.push(name);
            if (opts && opts.rate !== undefined && !(opts.rate > 0)) played.push('BADRATE:' + name);
            cues.push({ name, opts: opts || {}, t: clock ? clock() : 0 });
        },
        setSlowMo(f) { slowMo.push(f); },
        setMuted() {}, isMuted: () => false, unlock() {}, setListener() {}, setAmbience() {},
    };
    if (v4) a.has = (name) => !validNames || validNames.includes(name);
    return a;
}

// Steps the scene clock until `promise` settles; returns elapsed scene seconds.
async function runUntil(S, promise, { max = 20, dt = 1 / 60, label = 'animation' } = {}) {
    let done = false;
    promise.then(() => { done = true; });
    await null;
    let elapsed = 0;
    while (!done && elapsed < max) {
        S.stepFrames(1, dt);
        elapsed += dt;
        await null;
    }
    assert.ok(done, `${label} did not finish within ${max} s of scene time`);
    return elapsed;
}

const unitRoots = (S) => S.scene.children.filter((o) => /^unit-/.test(o.name));
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

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
            assert.ok(near(u.root.position.x, c - 3.5) && near(u.root.position.z, r - 3.5) && near(u.root.position.y, 0),
                `${msg} position of ${p} at ${r},${c}: ${u.root.position.toArray().map((x) => x.toFixed(3))}`);
        }
    }
    assert.equal(unitRoots(S).length, pieces, `${msg} unit objects in scene`);
}

// A rules context (gameLogic + rules.js) sharing nothing with units.
function rulesAt(fen) {
    const E = loadBattle3dRules();
    if (fen) E.run(`battle3dLoadFen(${JSON.stringify(fen)})`); else E.run('battle3dNewGame()');
    return E;
}

// Builds a FEN from { square: pieceChar } with the side to move.
function fenOf(pieces, turn = 'w') {
    const rows = [];
    for (let r = 0; r < 8; r++) {
        let row = '', empty = 0;
        for (let c = 0; c < 8; c++) {
            const name = String.fromCharCode(97 + c) + (8 - r);
            const p = pieces[name];
            if (p) { if (empty) row += empty; empty = 0; row += p; } else empty++;
        }
        rows.push(row + (empty ? empty : ''));
    }
    return `${rows.join('/')} ${turn} - - 0 1`;
}

// Capture setups: attacker of each type (incl. king) takes a victim of each capturable type, both colors.
// White victims stand on d4, black victims on d5; the attacker comes from a square that reaches it.
const ATTACK_FROM = {
    w: { q: 'd1', r: 'd1', b: 'a2', n: 'c3', p: 'e4', k: 'e4' },
    b: { q: 'd8', r: 'd8', b: 'a7', n: 'c6', p: 'e5', k: 'e5' },
};
function captureSetup(color, attacker, victim) {
    const target = color === 'w' ? 'd5' : 'd4';
    const from = ATTACK_FROM[color][attacker];
    const pieces = {};
    const up = (t, c) => (c === 'w' ? t.toUpperCase() : t);
    const foe = color === 'w' ? 'b' : 'w';
    pieces[from] = up(attacker, color);
    pieces[target] = up(victim, foe);
    // Kings out of the way (and not adjacent to each other)
    if (attacker !== 'k') pieces[color === 'w' ? 'h1' : 'h8'] = up('k', color);
    pieces[color === 'w' ? (attacker === 'k' ? 'a8' : 'h8') : (attacker === 'k' ? 'a1' : 'h1')] = up('k', foe);
    return { fen: fenOf(pieces, color), move: from + target };
}

module.exports = { loadUnitsModule, makeScene, makeAudio, runUntil, assertSynced, unitRoots, rulesAt, fenOf, captureSetup, finiteVec, square };
