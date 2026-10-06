'use strict';
// battle3d/audio.js with a fake WebAudio graph: unlock on gesture, mute, every synth schedules
// valid nodes, samples are fetched relative to the page, voice cap, no throw without WebAudio.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('../helpers/loadEngine');

// Minimal AudioContext: records created nodes and validates AudioParam automation like browsers do
// (exponential ramps to <= 0 throw RangeError).
function fakeAudioContext(log) {
    return class FakeAudioContext {
        constructor() {
            this.state = 'suspended';
            this.currentTime = 0;
            this.sampleRate = 8000;
            this.destination = { name: 'destination' };
            this.nodes = [];
            log.contexts.push(this);
        }
        param(v = 0) {
            return {
                value: v,
                setValueAtTime(x) { if (!Number.isFinite(x)) throw new TypeError('non-finite'); this.value = x; },
                exponentialRampToValueAtTime(x, t) { if (!(x > 0) || !Number.isFinite(t)) throw new RangeError(`bad exp ramp ${x}`); this.value = x; },
                linearRampToValueAtTime(x) { this.value = x; },
                setTargetAtTime(x) { this.value = x; },
                cancelScheduledValues() {},
            };
        }
        node(kind, extra = {}) {
            const n = { kind, connected: [], connect(d) { this.connected.push(d); return d; }, disconnect() { this.connected = []; }, ...extra };
            this.nodes.push(n);
            return n;
        }
        createGain() { return this.node('gain', { gain: this.param(1) }); }
        createOscillator() { return this.node('osc', { type: 'sine', frequency: this.param(440), start(t) { if (!Number.isFinite(t)) throw new TypeError('start'); this.started = true; }, stop() {} }); }
        createBufferSource() { return this.node('src', { buffer: null, loop: false, playbackRate: this.param(1), start() { this.started = true; }, stop() {} }); }
        createBiquadFilter() { return this.node('filter', { type: 'lowpass', Q: this.param(1), frequency: this.param(350) }); }
        createBuffer(ch, len, rate) { const data = new Float32Array(len); return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, getChannelData: () => data }; }
        decodeAudioData(data) { log.decoded.push(data.byteLength); return Promise.resolve({ duration: 0.3 }); }
        resume() { this.state = 'running'; log.resumes++; return Promise.resolve(); }
    };
}

let createAudio, SOUND_NAMES, log, saved;
const tick = () => new Promise((r) => setTimeout(r, 0));

function install({ webAudio = true, ctorThrows = false } = {}) {
    log = { contexts: [], decoded: [], resumes: 0, fetches: [] };
    const listeners = {};
    saved = { AudioContext: globalThis.AudioContext, webkitAudioContext: globalThis.webkitAudioContext, document: globalThis.document, fetch: globalThis.fetch };
    globalThis.AudioContext = webAudio ? (ctorThrows ? class { constructor() { throw new Error('blocked'); } } : fakeAudioContext(log)) : undefined;
    delete globalThis.webkitAudioContext;
    globalThis.document = {
        addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
        removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    };
    globalThis.fetch = async (url) => {
        log.fetches.push(String(url));
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) };
    };
    return {
        gesture(type = 'pointerdown') { for (const fn of [...(listeners[type] || [])]) fn(); },
        listenerCount: () => Object.values(listeners).reduce((n, s) => n + s.size, 0),
    };
}
function restore() {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
}
const started = (ctx) => ctx.nodes.filter((n) => n.started).length;

describe('battle3d audio', () => {
    beforeEach(async () => {
        ({ createAudio, SOUND_NAMES } = await import(pathToFileURL(path.join(ROOT, 'battle3d', 'audio.js')).href));
    });
    afterEach(() => restore());

    test('exports every contract sound name', () => {
        install();
        const names = ['step', 'whoosh', 'clang', 'hit', 'thud', 'bone', 'magic', 'zap', 'cheer', 'death', 'promote', 'check', 'gameover', 'move', 'capture'];
        assert.deepEqual(names.filter((n) => !SOUND_NAMES.includes(n)), []);
    });

    test('silent until a user gesture unlocks; the gesture listeners are then removed', async () => {
        const doc = install();
        const audio = createAudio();
        audio.play('hit');
        assert.equal(log.contexts.length, 0, 'no AudioContext before a gesture');
        doc.gesture('pointerdown');
        await tick();
        assert.equal(log.contexts.length, 1);
        assert.equal(log.contexts[0].state, 'running');
        doc.gesture('keydown');
        assert.equal(log.contexts.length, 1, 'one context only');
        assert.equal(doc.listenerCount(), 0, 'gesture listeners removed once running');
        const ctx = log.contexts[0];
        const before = started(ctx);
        audio.play('hit');
        assert.ok(started(ctx) > before, 'plays after unlock');
    });

    test('loads the 2D game samples relative to the page', async () => {
        install();
        const audio = createAudio();
        audio.unlock();
        await tick(); await tick();
        assert.deepEqual(log.fetches.sort(), ['capture.mp3', 'check.mp3', 'game-over.mp3', 'move.mp3']);
        for (const f of log.fetches) assert.ok(require('node:fs').existsSync(path.join(ROOT, f)), `${f} exists at the repo root (page dir)`);
        assert.equal(log.decoded.length, 4);
    });

    test('every sound plays without throwing at several rates and volumes', async () => {
        install();
        for (const name of SOUND_NAMES) {
            const audio = createAudio(); // fresh voice budget per sound
            audio.unlock();
            await tick();
            const ctx = log.contexts[log.contexts.length - 1];
            for (const [rate, volume] of [[1, 1], [0.5, 0.2], [1.8, 2], [1, 5]]) {
                const before = ctx.nodes.length;
                assert.doesNotThrow(() => audio.play(name, { rate, volume }), name);
                assert.ok(ctx.nodes.length > before, `${name} rate ${rate} created nodes`);
            }
        }
    });

    test('mute: nothing new plays and the master gain goes to 0; unmute restores', async () => {
        install();
        const audio = createAudio();
        audio.unlock();
        await tick();
        const ctx = log.contexts[0];
        const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connected.includes(ctx.destination));
        assert.ok(master && master.gain.value > 0);
        audio.setMuted(true);
        assert.equal(audio.isMuted(), true);
        assert.equal(master.gain.value, 0);
        const before = ctx.nodes.length;
        audio.play('clang');
        assert.equal(ctx.nodes.length, before, 'muted play creates nothing');
        audio.setMuted(false);
        assert.ok(master.gain.value > 0);
        audio.play('clang');
        assert.ok(ctx.nodes.length > before);
    });

    test('created muted: unlock keeps the master silent', async () => {
        install();
        const audio = createAudio({ muted: true });
        audio.unlock();
        await tick();
        const ctx = log.contexts[0];
        const master = ctx.nodes.find((n) => n.kind === 'gain' && n.connected.includes(ctx.destination));
        assert.equal(master.gain.value, 0);
        assert.equal(audio.isMuted(), true);
    });

    test('voice cap: a burst of sounds stops creating nodes after the limit', async () => {
        install();
        const audio = createAudio();
        audio.unlock();
        await tick();
        const ctx = log.contexts[0];
        for (let i = 0; i < 100; i++) audio.play('step');
        const outs = ctx.nodes.filter((n) => n.kind === 'gain' && n.connected.some((d) => d.kind === 'gain' && d.connected.includes(ctx.destination)));
        assert.ok(outs.length <= 32, `${outs.length} voices`);
    });

    test('unknown names, rate 0 and garbage options do not throw', async () => {
        install();
        const audio = createAudio();
        audio.unlock();
        await tick();
        assert.doesNotThrow(() => audio.play('nope'));
        assert.doesNotThrow(() => audio.play('hit', { rate: 0 }));
        assert.doesNotThrow(() => audio.play('hit', { volume: NaN }));
    });

    test('no WebAudio, or a blocked AudioContext: a silent no-op API', () => {
        install({ webAudio: false });
        let audio = createAudio();
        assert.doesNotThrow(() => { audio.unlock(); audio.play('hit'); audio.setMuted(true); audio.setMuted(false); });
        restore();
        install({ ctorThrows: true });
        audio = createAudio();
        assert.doesNotThrow(() => { audio.unlock(); audio.play('hit'); audio.setMuted(true); audio.setMuted(false); });
    });
});
