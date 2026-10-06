// Recording fake of the WebAudio API for audio.js tests: every node and AudioParam automation call
// is kept so tests can inspect pan, gain, playback rate and graph connections. AudioParam methods
// validate like browsers (exponential ramps to <= 0 and non-finite values throw).
'use strict';

function makeParam(owner, name, value = 0) {
    const p = {
        name, owner, value, defaultValue: value, events: [],
        setValueAtTime(v, t) { check(v, t); p.events.push(['set', v, t]); p.value = v; return p; },
        linearRampToValueAtTime(v, t) { check(v, t); p.events.push(['lin', v, t]); p.value = v; return p; },
        exponentialRampToValueAtTime(v, t) {
            if (!(v > 0) && !(v < 0)) throw new RangeError(`${name}: exponential ramp to ${v}`);
            check(v, t); p.events.push(['exp', v, t]); p.value = v; return p;
        },
        setTargetAtTime(v, t, c) { check(v, t); p.events.push(['target', v, t, c]); p.value = v; return p; },
        setValueCurveAtTime(curve, t, d) { p.events.push(['curve', curve, t, d]); p.value = curve[curve.length - 1]; return p; },
        cancelScheduledValues(t) { p.events.push(['cancel', t]); return p; },
        cancelAndHoldAtTime(t) { p.events.push(['cancelHold', t]); return p; },
    };
    // Browsers throw a TypeError when a non-finite number is assigned to AudioParam.value.
    let current = value;
    Object.defineProperty(p, 'value', {
        get: () => current,
        set: (v) => { if (!Number.isFinite(v)) throw new TypeError(`${name}: The provided float value is non-finite (${v})`); current = v; },
        enumerable: true,
    });
    function check(v, t) {
        if (!Number.isFinite(v)) throw new TypeError(`${name}: non-finite value ${v}`);
        if (t !== undefined && !Number.isFinite(t)) throw new TypeError(`${name}: non-finite time ${t}`);
    }
    return p;
}

/**
 * @returns {{ AudioContext: class, log }} log.contexts holds every context created.
 */
function fakeAudio() {
    const log = { contexts: [], decoded: 0 };
    class FakeAudioContext {
        constructor(opts = {}) {
            this.state = 'suspended';
            this.currentTime = 0;
            this.sampleRate = opts.sampleRate || 8000;
            this.nodes = [];
            this.destination = this.node('destination', {});
            this.listener = { positionX: makeParam(null, 'lx'), positionY: makeParam(null, 'ly'), positionZ: makeParam(null, 'lz'), setPosition() {}, setOrientation() {} };
            log.contexts.push(this);
        }
        node(kind, extra) {
            const n = {
                kind, context: this, inputs: [], outputs: [], started: null, stopped: null, disconnected: false,
                connect(dest) { n.outputs.push(dest); if (dest && dest.inputs) dest.inputs.push(n); return dest; },
                disconnect() { n.disconnected = true; for (const d of n.outputs) if (d.inputs) d.inputs.splice(d.inputs.indexOf(n) >>> 0, 1); n.outputs = []; },
                addEventListener(type, fn) { if (type === 'ended') n.onended = fn; },
                removeEventListener() {},
                ...extra,
            };
            this.nodes.push(n);
            return n;
        }
        createGain() { const n = this.node('gain', {}); n.gain = makeParam(n, 'gain', 1); return n; }
        createStereoPanner() { const n = this.node('stereoPanner', {}); n.pan = makeParam(n, 'pan', 0); return n; }
        createPanner() {
            const n = this.node('panner', { panningModel: 'equalpower', distanceModel: 'inverse', refDistance: 1, maxDistance: 10000, rolloffFactor: 1, setPosition(x, y, z) { n.positionX.value = x; n.positionY.value = y; n.positionZ.value = z; } });
            n.positionX = makeParam(n, 'px'); n.positionY = makeParam(n, 'py'); n.positionZ = makeParam(n, 'pz');
            return n;
        }
        createBiquadFilter() { const n = this.node('filter', { type: 'lowpass' }); n.frequency = makeParam(n, 'frequency', 350); n.Q = makeParam(n, 'Q', 1); n.gain = makeParam(n, 'fgain', 0); n.detune = makeParam(n, 'fdetune', 0); return n; }
        createDynamicsCompressor() {
            const n = this.node('compressor', {});
            for (const [k, v] of [['threshold', -24], ['knee', 30], ['ratio', 12], ['attack', 0.003], ['release', 0.25]]) n[k] = makeParam(n, k, v);
            n.reduction = 0;
            return n;
        }
        createWaveShaper() { return this.node('waveShaper', { curve: null, oversample: 'none' }); }
        createConvolver() { return this.node('convolver', { buffer: null, normalize: true }); }
        createDelay() { const n = this.node('delay', {}); n.delayTime = makeParam(n, 'delayTime', 0); return n; }
        createChannelMerger() { return this.node('merger', {}); }
        createChannelSplitter() { return this.node('splitter', {}); }
        createAnalyser() { return this.node('analyser', { fftSize: 2048, getFloatTimeDomainData() {}, getByteFrequencyData() {} }); }
        createOscillator() {
            const n = this.node('osc', { type: 'sine', setPeriodicWave() {} });
            n.frequency = makeParam(n, 'frequency', 440); n.detune = makeParam(n, 'detune', 0);
            n.start = (t = 0) => { if (!Number.isFinite(t)) throw new TypeError('osc start'); n.started = t; };
            n.stop = (t = 0) => { n.stopped = t; };
            return n;
        }
        createConstantSource() {
            const n = this.node('constant', {});
            n.offset = makeParam(n, 'offset', 1);
            n.start = (t = 0) => { n.started = t; }; n.stop = (t = 0) => { n.stopped = t; };
            return n;
        }
        createBufferSource() {
            const n = this.node('src', { buffer: null, loop: false, loopStart: 0, loopEnd: 0 });
            n.playbackRate = makeParam(n, 'playbackRate', 1); n.detune = makeParam(n, 'detune', 0);
            n.start = (t = 0, off = 0, dur) => { if (!Number.isFinite(t)) throw new TypeError('src start'); n.started = t; n.offset = off; n.duration = dur; };
            n.stop = (t = 0) => { n.stopped = t; };
            return n;
        }
        createBuffer(channels, length, rate) {
            if (!(length > 0)) throw new RangeError('buffer length');
            const data = Array.from({ length: channels }, () => new Float32Array(length));
            return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: (c) => data[c], copyToChannel() {} };
        }
        createPeriodicWave() { return {}; }
        decodeAudioData() { log.decoded++; return Promise.resolve(this.createBuffer(1, 10, this.sampleRate)); }
        resume() { this.state = 'running'; return Promise.resolve(); }
        suspend() { this.state = 'suspended'; return Promise.resolve(); }
        close() { this.state = 'closed'; return Promise.resolve(); }
    }
    return { AudioContext: FakeAudioContext, log };
}

// Helpers over a context's node list.
const nodesSince = (ctx, n) => ctx.nodes.slice(n);
const sources = (nodes) => nodes.filter((x) => x.kind === 'osc' || x.kind === 'src' || x.kind === 'constant');
// Walks outputs from a node and returns every node reached (graph downstream).
function downstream(node, seen = new Set()) {
    for (const o of node.outputs || []) if (!seen.has(o)) { seen.add(o); downstream(o, seen); }
    return seen;
}

module.exports = { fakeAudio, nodesSince, sources, downstream, makeParam };
