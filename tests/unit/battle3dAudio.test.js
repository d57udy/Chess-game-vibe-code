'use strict';
// battle3d/audio.js (v4) against a recording fake WebAudio: contract bank (names, variants,
// variations), no 2D mp3s, every recipe synthesizes with valid parameters (live and rendered),
// stereo pan from screen x and distance attenuation, mute / hidden / ambience, voice cap, slow-mo.
const { test, describe, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');
const { fakeAudio, nodesSince, sources, downstream } = require('../helpers/fakeAudioContext');

const SRC = fs.readFileSync(path.join(ROOT, 'battle3d', 'audio.js'), 'utf8');
const CONTRACT = ['step', 'jump', 'land', 'settle', 'select', 'deselect', 'invalid', 'castle', 'whoosh', 'clang', 'hit', 'bone',
    'shatter', 'slam', 'zap', 'bolt', 'magicHit', 'fall', 'dissolve', 'death', 'promote', 'check', 'checkmate', 'victory', 'draw'];
const VARIANTS = { step: ['light', 'armor', 'heavy', 'bone'], whoosh: ['light', 'heavy', 'magic'] };
// One-shot jingles may have a single variation; everything that repeats needs 2..4.
const JINGLES = new Set(['checkmate', 'victory', 'draw']);

let A, THREE, seq = 0;
const tick = () => new Promise((r) => setTimeout(r, 0));
let env;

// Fresh globals + module instance per test (audio.js keeps module-level caches).
async function setup({ offline = false, muted, ambience = false, hidden = false } = {}) {
    const F = fakeAudio();
    const listeners = {};
    const doc = {
        visibilityState: hidden ? 'hidden' : 'visible',
        addEventListener(t, f) { (listeners[t] ||= new Set()).add(f); },
        removeEventListener(t, f) { listeners[t]?.delete(f); },
    };
    const fetched = [];
    env = { saved: {} };
    for (const k of ['AudioContext', 'webkitAudioContext', 'OfflineAudioContext', 'document', 'fetch']) env.saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    set('AudioContext', F.AudioContext);
    set('webkitAudioContext', undefined);
    set('OfflineAudioContext', offline ? class extends F.AudioContext {
        constructor(ch, len, rate) { super({ sampleRate: rate }); this.len = len; }
        startRendering() { return Promise.resolve(this.createBuffer(1, this.len, this.sampleRate)); }
    } : undefined);
    set('document', doc);
    set('fetch', async (u) => { fetched.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; });
    const mod = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'audio.js')).href + `?t=${++seq}`);
    const opts = { ambience };
    if (muted !== undefined) opts.muted = muted;
    const audio = mod.createAudio(opts);
    const fire = (t) => { for (const f of [...(listeners[t] || [])]) f({ type: t }); };
    return { F, mod, audio, doc, fire, fetched, ctx: () => F.log.contexts[0], listeners };
}
function teardown(T) {
    if (T?.audio) { try { T.audio.setAmbience(false); T.audio.setMuted(true); } catch (e) { /* ignore */ } }
    for (const [k, d] of Object.entries(env?.saved || {})) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
}
async function unlocked(opts) {
    const T = await setup(opts);
    T.fire('pointerdown');
    await tick();
    return T;
}
const master = (ctx) => ctx.nodes.find((n) => n.kind === 'gain' && downstream(n).has(ctx.destination) && n.outputs.some((o) => o.kind === 'compressor'));

describe('battle3d audio v4', () => {
    let T;
    before(async () => { THREE = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js')).href); });
    afterEach(() => { teardown(T); T = null; });

    test('bank: every contract name resolves; step/whoosh variants; 2-4 variations (jingles 1+)', async () => {
        T = await setup();
        const keys = new Map(T.mod.SOUND_BANK.map((b) => [b.key, b]));
        for (const name of CONTRACT) {
            assert.ok(T.mod.SOUND_NAMES.includes(name), `${name} in SOUND_NAMES`);
            const entries = VARIANTS[name] ? VARIANTS[name].map((v) => keys.get(`${name}:${v}`)) : [keys.get(name)];
            for (const [i, e] of entries.entries()) {
                assert.ok(e, `${name}${VARIANTS[name] ? ':' + VARIANTS[name][i] : ''} in the bank`);
                const min = JINGLES.has(name) ? 1 : 2;
                assert.ok(e.count >= min && e.count <= 4, `${e.key}: ${e.count} variations`);
                assert.ok(['steps', 'fight', 'ui'].includes(e.bus), `${e.key} bus ${e.bus}`);
            }
        }
        assert.ok(keys.get('step:light').bus === 'steps' && keys.get('clang').bus === 'fight' && keys.get('select').bus === 'ui');
    });

    test('has(name) reports the bank (units.js gates v4 cues on it)', async () => {
        T = await setup();
        assert.equal(typeof T.audio.has, 'function', 'createAudio() must expose has(); without it units.js silences settle/castle/bolt');
        for (const n of CONTRACT) assert.equal(T.audio.has(n), true, n);
        assert.equal(T.audio.has('nope'), false);
    });

    test('the 3D game never loads or plays the 2D mp3s', async () => {
        assert.ok(!/\.mp3\b/.test(SRC), 'audio.js mentions no mp3');
        for (const f of fs.readdirSync(path.join(ROOT, 'battle3d')).filter((x) => x.endsWith('.js'))) {
            assert.ok(!/\.mp3\b/.test(fs.readFileSync(path.join(ROOT, 'battle3d', f), 'utf8')), `battle3d/${f} references an mp3`);
        }
        assert.ok(!/\.mp3\b/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')), 'index.html references an mp3');
        T = await unlocked();
        for (const n of CONTRACT) T.audio.play(n);
        await tick();
        assert.deepEqual(T.fetched, [], 'no network requests at all');
        // the 2D page keeps its samples
        const ui = fs.readFileSync(path.join(ROOT, 'ui.js'), 'utf8');
        for (const f of ['move.mp3', 'capture.mp3', 'check.mp3', 'game-over.mp3']) assert.ok(ui.includes(f), `2D keeps ${f}`);
    });

    test('sound-test.html: audition page uses only bank names and builds a card per bank entry', async () => {
        T = await setup();
        const html = fs.readFileSync(path.join(ROOT, 'battle3d', 'sound-test.html'), 'utf8');
        assert.match(html, /from '\.\/audio\.js'/);
        assert.match(html, /for \(const entry of SOUND_BANK\)/, 'bank cards come from SOUND_BANK (new sounds appear automatically)');
        const used = new Set([...html.matchAll(/\[\s*[\d.]+\s*,\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
        assert.ok(used.size >= 15, `sequence names: ${[...used]}`);
        for (const n of used) assert.equal(T.audio.has(n), true, `sound-test uses unknown sound ${n}`);
        for (const m of html.matchAll(/variant:\s*'(\w+)'/g)) assert.ok(['light', 'armor', 'heavy', 'bone', 'magic'].includes(m[1]), m[1]);
        assert.ok(!/\.mp3\b/.test(html));
    });

    test('silent until a gesture; one context; gesture listeners removed once running', async () => {
        T = await setup();
        T.audio.play('settle');
        assert.equal(T.F.log.contexts.length, 0);
        T.fire('pointerdown');
        await tick();
        assert.equal(T.F.log.contexts.length, 1);
        assert.equal(T.ctx().state, 'running');
        assert.equal(T.listeners.pointerdown?.size || 0, 0);
        assert.equal(T.listeners.keydown?.size || 0, 0);
        const n = T.ctx().nodes.length;
        T.audio.play('settle');
        assert.ok(T.ctx().nodes.length > n);
    });

    test('mix graph: buses -> master -> compressor -> limiter -> destination', async () => {
        T = await unlocked();
        const ctx = T.ctx();
        const m = master(ctx);
        assert.ok(m, 'master gain feeds a compressor chain');
        const comps = ctx.nodes.filter((n) => n.kind === 'compressor');
        assert.ok(comps.length >= 2, 'glue compressor + limiter');
        assert.ok(downstream(comps[comps.length - 1]).has(ctx.destination));
        const busGains = ctx.nodes.filter((n) => n.kind === 'gain' && n.outputs.includes(m));
        assert.ok(busGains.length >= 4, `buses into master: ${busGains.length}`);
    });

    test('every bank entry synthesizes live with valid AudioParam values, at several rates', async () => {
        T = await unlocked();
        const ctx = T.ctx();
        for (const { key } of T.mod.SOUND_BANK) {
            const [name, variant] = key.split(':');
            for (const rate of [0.5, 1, 1.9]) {
                const n = ctx.nodes.length;
                assert.doesNotThrow(() => T.audio.play(name, { variant, rate, index: 0 }), key);
                const made = nodesSince(ctx, n);
                assert.ok(sources(made).length > 0, `${key} at rate ${rate} scheduled sources`);
                assert.ok(sources(made).every((s) => Number.isFinite(s.started)), `${key} sources started`);
            }
            await tick(); // let voices expire timers not matter; keep the cap away
            T.audio.setMuted(true); T.audio.setMuted(false); // stopAll resets voices between keys
        }
    });

    test('rendered bank: OfflineAudioContext renders every variation; plays buffers with jitter', async () => {
        T = await unlocked({ offline: true });
        for (let i = 0; i < 50 && !T.audio.isReady?.(); i++) await tick();
        assert.equal(T.audio.isReady(), true);
        const ctx = T.ctx();
        const n = ctx.nodes.length;
        for (let i = 0; i < 20; i++) T.audio.play('clang', { rate: 1 });
        const srcs = nodesSince(ctx, n).filter((x) => x.kind === 'src');
        assert.equal(srcs.length, 20);
        const rates = srcs.map((s) => s.playbackRate.value);
        assert.ok(rates.every((r) => r >= 0.94 && r <= 1.06), `jitter within 5%: ${rates.map((r) => r.toFixed(3))}`);
        assert.ok(new Set(rates.map((r) => r.toFixed(4))).size > 5, 'pitch varies');
        const bufs = new Set(srcs.map((s) => s.buffer));
        assert.ok(bufs.size >= 2, 'variations rotate');
        for (let i = 1; i < srcs.length; i++) assert.notEqual(srcs[i].buffer, srcs[i - 1].buffer, 'never the same variation twice in a row');
    });

    describe('spatial', () => {
        function camera() {
            const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 400);
            cam.position.set(0, 9, 11);
            cam.lookAt(0, 0, 0);
            cam.updateMatrixWorld(true);
            cam.updateProjectionMatrix();
            return cam;
        }
        const playAt = (T, pos, name = 'hit') => {
            const ctx = T.ctx();
            const n = ctx.nodes.length;
            T.audio.play(name, { pos, index: 0 });
            const made = nodesSince(ctx, n);
            const panner = made.find((x) => x.kind === 'stereoPanner');
            const src = sources(made)[0];
            const out = made.find((x) => x.kind === 'gain' && (x === src?.outputs[0] || made.indexOf(x) === 0));
            return { pan: panner ? panner.pan.value : 0, gain: made[0].kind === 'gain' ? made[0].gain.value : out?.gain.value };
        };

        test('pan follows screen x (left negative, right positive, centre zero)', async () => {
            T = await unlocked();
            T.audio.setListener(camera());
            const left = playAt(T, new THREE.Vector3(-3.5, 0, 0));
            const right = playAt(T, new THREE.Vector3(3.5, 0, 0));
            const mid = playAt(T, new THREE.Vector3(0, 0, 0));
            assert.ok(left.pan < -0.2, `left pan ${left.pan}`);
            assert.ok(right.pan > 0.2, `right pan ${right.pan}`);
            assert.ok(Math.abs(mid.pan) < 0.05, `centre pan ${mid.pan}`);
            assert.ok(Math.abs(left.pan + right.pan) < 0.05, 'symmetric');
            assert.ok(left.pan >= -1 && right.pan <= 1);
            const plain = { x: 3.5, y: 0, z: 0 };
            assert.ok(playAt(T, plain).pan > 0.2, 'plain {x,y,z} objects work too');
        });

        test('nearer sources are louder (distance attenuation), within sane bounds', async () => {
            T = await unlocked();
            T.audio.setListener(camera());
            const near = playAt(T, new THREE.Vector3(0, 0, 3.5));
            const far = playAt(T, new THREE.Vector3(0, 0, -3.5));
            assert.ok(near.gain > far.gain, `near ${near.gain} > far ${far.gain}`);
            assert.ok(far.gain > 0.2 && near.gain < 2, 'never inaudible, never blasting');
        });

        test('without a listener or position: centred at full level; NaN positions are safe', async () => {
            T = await unlocked();
            assert.deepEqual(playAt(T, new THREE.Vector3(3, 0, 0)), { pan: 0, gain: 1 });
            T.audio.setListener(camera());
            const r = playAt(T, { x: NaN, y: 0, z: 0 });
            assert.ok(Number.isFinite(r.pan) && Number.isFinite(r.gain), JSON.stringify(r));
        });
    });

    test('mute: nothing plays, master at 0, ambience stopped; unmute restores', async () => {
        T = await unlocked({ ambience: true });
        const ctx = T.ctx();
        const loops = () => ctx.nodes.filter((x) => x.kind === 'src' && x.loop && x.started !== null && x.stopped === null);
        assert.ok(loops().length >= 1, 'ambience running');
        T.audio.setMuted(true);
        assert.equal(T.audio.isMuted(), true);
        assert.equal(master(ctx).gain.value, 0);
        assert.equal(loops().length, 0, 'ambience stopped when muted');
        const n = ctx.nodes.length;
        T.audio.play('clang');
        assert.equal(ctx.nodes.length, n);
        T.audio.setMuted(false);
        assert.ok(master(ctx).gain.value > 0);
        assert.ok(loops().length >= 1, 'ambience back');
    });

    test('hidden tab: context suspended, nothing plays, ambience off; visible again resumes', async () => {
        T = await unlocked({ ambience: true });
        const ctx = T.ctx();
        const loops = () => ctx.nodes.filter((x) => x.kind === 'src' && x.loop && x.stopped === null);
        T.doc.visibilityState = 'hidden';
        T.fire('visibilitychange');
        await tick();
        assert.equal(ctx.state, 'suspended');
        assert.equal(loops().length, 0);
        const n = ctx.nodes.length;
        T.audio.play('hit');
        assert.equal(ctx.nodes.length, n);
        T.doc.visibilityState = 'visible';
        T.fire('visibilitychange');
        await tick();
        assert.equal(ctx.state, 'running');
        assert.ok(loops().length >= 1);
    });

    test('a page that starts hidden stays silent until shown', async () => {
        T = await setup({ hidden: true });
        T.fire('keydown');
        await tick();
        const ctx = T.ctx();
        const n = ctx ? ctx.nodes.length : 0;
        T.audio.play('settle');
        assert.equal(ctx ? ctx.nodes.length : 0, n, 'no sound while the page was never visible');
    });

    test('ambience toggle', async () => {
        T = await unlocked({ ambience: false });
        const ctx = T.ctx();
        const loops = () => ctx.nodes.filter((x) => x.kind === 'src' && x.loop && x.stopped === null);
        assert.equal(loops().length, 0);
        T.audio.setAmbience(true);
        assert.equal(T.audio.isAmbience(), true);
        assert.ok(loops().length >= 1);
        T.audio.setAmbience(true);
        assert.ok(loops().length <= 2, 'toggling on twice does not stack loops');
        T.audio.setAmbience(false);
        assert.equal(loops().length, 0);
    });

    test('voice cap: a burst stops adding voices', async () => {
        T = await unlocked({ offline: true }); // rendered: one buffer source per voice
        for (let i = 0; i < 50 && !T.audio.isReady(); i++) await tick();
        const ctx = T.ctx();
        const n = ctx.nodes.length;
        for (let i = 0; i < 200; i++) T.audio.play('step', { variant: 'light' });
        const voices = nodesSince(ctx, n).filter((x) => x.kind === 'src').length;
        assert.ok(voices >= 16 && voices <= 32, `voices ${voices}`);
    });

    test('slow-mo pitches running fight sounds down and back; UI sounds untouched', async () => {
        T = await unlocked({ offline: true });
        for (let i = 0; i < 50 && !T.audio.isReady(); i++) await tick();
        const ctx = T.ctx();
        let n = ctx.nodes.length;
        T.audio.play('clang');
        const fight = nodesSince(ctx, n).find((x) => x.kind === 'src');
        n = ctx.nodes.length;
        T.audio.play('select');
        const ui = nodesSince(ctx, n).find((x) => x.kind === 'src');
        const base = fight.playbackRate.value;
        T.audio.setSlowMo(0.25);
        const last = fight.playbackRate.events[fight.playbackRate.events.length - 1];
        assert.equal(last[0], 'target');
        assert.ok(Math.abs(last[1] - base * 0.5) < 1e-6, `slow-mo 0.25 -> rate x0.5 (sqrt), got ${last[1] / base}`);
        assert.equal(ui.playbackRate.events.filter((e) => e[0] === 'target').length, 0, 'UI voice not slowed');
        n = ctx.nodes.length;
        T.audio.play('hit');
        const during = nodesSince(ctx, n).find((x) => x.kind === 'src');
        assert.ok(during.playbackRate.value < 0.6, 'new fight sounds start slowed');
        T.audio.setSlowMo(1);
        const back = fight.playbackRate.events[fight.playbackRate.events.length - 1];
        assert.ok(Math.abs(back[1] - base) < 1e-6, 'restored');
        assert.doesNotThrow(() => { T.audio.setSlowMo(NaN); T.audio.setSlowMo(0); T.audio.setSlowMo(-1); });
    });

    test('no WebAudio or a blocked constructor: silent no-op API', async () => {
        T = await setup();
        Object.defineProperty(globalThis, 'AudioContext', { value: undefined, configurable: true, writable: true });
        const mod = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'audio.js')).href + `?t=${++seq}`);
        let a = mod.createAudio();
        assert.doesNotThrow(() => { a.unlock(); a.play('hit', { pos: { x: 1, y: 0, z: 0 } }); a.setMuted(true); a.setMuted(false); a.setAmbience(true); a.setSlowMo(0.3); a.setListener(null); });
        Object.defineProperty(globalThis, 'AudioContext', { value: class { constructor() { throw new Error('blocked'); } }, configurable: true, writable: true });
        a = mod.createAudio();
        assert.doesNotThrow(() => { a.unlock(); a.play('hit'); a.setAmbience(true); });
    });

    test('garbage arguments never throw', async () => {
        T = await unlocked();
        for (const args of [['nope'], [undefined], [42], ['hit', { rate: 0 }], ['hit', { volume: NaN }], ['hit', { pos: 'x' }], ['step', { variant: 'nope' }], ['hit', { index: 99 }]]) {
            assert.doesNotThrow(() => T.audio.play(...args), JSON.stringify(args));
        }
    });
});
