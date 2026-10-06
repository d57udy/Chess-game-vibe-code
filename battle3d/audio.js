// Sound for the 3D battle game. Everything is synthesized with WebAudio (no sample files, nothing to
// license): each sound is a small recipe of filtered noise bursts, modal resonators (metal, wood, bone),
// low pitch-dropping bodies (thuds) and envelopes. Each recipe is rendered once per variation into an
// AudioBuffer with an OfflineAudioContext (seeded, so variations are stable), then played as a buffer
// source with pitch jitter, stereo pan from the screen position, distance attenuation and slow-mo pitch.
// Until the buffers are rendered (or where OfflineAudioContext is missing) recipes play live.
//
//   createAudio({ muted, ambience }) -> {
//     play(name, { volume, rate, pos, variant, index, pan }), setListener(camera),
//     setMuted(bool), isMuted(), unlock(), setAmbience(bool), isAmbience(), setSlowMo(factor),
//     levels() -> { master, steps, fight, ui, ambience } (0..1 peak), isReady(), has(name, variant)
//   }
// Mix: voices -> bus (steps / fight / ui / ambience) -> master -> compressor -> limiter -> destination.
// Silent no-op where WebAudio is missing; silent until the first user gesture; suspended while the tab is hidden.

const MASTER_VOLUME = 0.8;
const BUS_VOLUME = { steps: 0.42, fight: 0.9, ui: 0.55, ambience: 0.5 };
const MAX_VOICES = 32;
const JITTER = 0.05;             // +-5 % playback rate per play
const SAMPLE_RATE = 44100;

// --- Tiny deterministic RNG so variation N always sounds the same ---
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
}
const lerp = (a, b, k) => a + (b - a) * k;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// --- Synthesis primitives (work on any BaseAudioContext) ---
// AudioBuffers are not tied to a context, so one noise buffer per sample rate serves every render
const noiseCache = new Map();
function noiseBuffer(c) {
    let buffer = noiseCache.get(c.sampleRate);
    if (!buffer || !buffer.getChannelData) {
        const len = Math.floor((c.sampleRate || SAMPLE_RATE) * 1.5);
        buffer = c.createBuffer(1, len, c.sampleRate || SAMPLE_RATE);
        const data = buffer.getChannelData(0);
        let brown = 0;
        for (let i = 0; i < data.length; i++) {
            // Slightly pink-ish: white plus a little leaky integration takes the edge off
            const white = Math.random() * 2 - 1;
            brown = (brown + 0.02 * white) / 1.02;
            data[i] = white * 0.85 + brown * 3;
        }
        noiseCache.set(c.sampleRate, buffer);
    }
    return buffer;
}

// Gain envelope: linear attack, exponential decay to silence
function envelope(c, dest, t, peak, attack, decay) {
    const g = c.createGain();
    peak = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.max(0.001, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.001, attack) + Math.max(0.005, decay));
    g.connect(dest);
    return g;
}

// Filtered noise burst. f2 sweeps the filter over the burst.
function burst(c, dest, t, { type = 'lowpass', f = 1000, f2 = null, q = 0.8, dur = 0.1, peak = 0.5, attack = 0.002 }) {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c);
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(f, t);
    if (f2) filter.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + attack + dur);
    src.connect(filter);
    filter.connect(envelope(c, dest, t, peak, attack, dur));
    src.start(t, Math.random() * 1.2);
    src.stop(t + attack + dur + 0.05);
}

// Oscillator with optional pitch glide
function tone(c, dest, t, { type = 'sine', f, f2 = null, dur = 0.2, peak = 0.3, attack = 0.004, detune = 0 }) {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f, t);
    if (f2) osc.frequency.exponentialRampToValueAtTime(Math.max(10, f2), t + attack + dur);
    if (detune && osc.detune) osc.detune.value = detune;
    osc.connect(envelope(c, dest, t, peak, attack, dur));
    osc.start(t);
    osc.stop(t + attack + dur + 0.05);
}

// Struck resonator: a set of sine partials with their own decays (metal, wood, bone, gongs)
function modal(c, dest, t, { f, ratios, decays, amps, peak = 0.3, attack = 0.001 }) {
    ratios.forEach((ratio, i) => {
        tone(c, dest, t, { f: f * ratio, dur: decays[i] ?? decays[decays.length - 1], peak: peak * (amps?.[i] ?? 1 / (i + 1)), attack });
    });
}

// Low body: pitch-dropping sine, the "weight" of thuds and drums
function body(c, dest, t, { f = 90, f2 = 45, dur = 0.2, peak = 0.6, attack = 0.003 }) {
    tone(c, dest, t, { type: 'sine', f, f2, dur, peak, attack });
}

// Lowpass brass-ish voice (horn, stings, fanfares)
function brass(c, dest, t, { f, dur = 0.4, peak = 0.12, attack = 0.03, bright = 1600 }) {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.7;
    filter.frequency.setValueAtTime(bright * 0.4, t);
    filter.frequency.exponentialRampToValueAtTime(bright, t + attack + 0.05);
    filter.frequency.exponentialRampToValueAtTime(bright * 0.35, t + attack + dur);
    filter.connect(dest);
    tone(c, filter, t, { type: 'sawtooth', f, dur, peak, attack });
    tone(c, filter, t, { type: 'sawtooth', f: f * 1.004, dur, peak: peak * 0.6, attack });
}

const WOOD = { ratios: [1, 2.32, 4.25], decays: [0.09, 0.05, 0.03], amps: [1, 0.5, 0.25] };
const METAL = { ratios: [1, 2.76, 5.4, 8.93, 13.34], decays: [0.9, 0.6, 0.4, 0.25, 0.15], amps: [1, 0.7, 0.45, 0.3, 0.18] };
const BELL = { ratios: [1, 2.0, 2.76, 4.07], decays: [1.2, 0.8, 0.5, 0.3], amps: [1, 0.35, 0.3, 0.12] };

// --- Sound bank: key -> { bus, len (s), count, gain, fn(c, out, t, r) } where r() is the variation's RNG.
// gain balances the recipes against each other (measured peaks: fights ~0.6 to 0.9, steps ~0.25). ---
const STEP_SOFT = (c, out, t, r) => {
    // Heel then toe: two short lowpassed scuffs on a wooden board
    const f = lerp(500, 850, r());
    burst(c, out, t, { f, q: 0.7, dur: 0.05, peak: 0.42 });
    burst(c, out, t + lerp(0.035, 0.06, r()), { type: 'bandpass', f: lerp(1300, 2200, r()), q: 0.9, dur: 0.035, peak: 0.12 });
    body(c, out, t, { f: lerp(120, 150, r()), f2: 80, dur: 0.05, peak: 0.12 });
};

const BANK = {
    'step:light': { bus: 'steps', len: 0.2, count: 4, fn: STEP_SOFT },
    'step:armor': {
        bus: 'steps', len: 0.3, count: 4, fn(c, out, t, r) {
            STEP_SOFT(c, out, t, r);
            // Small chain/plate clink a moment after the foot lands
            modal(c, out, t + lerp(0.015, 0.04, r()), { f: lerp(2300, 3100, r()), ratios: [1, 1.48, 2.21], decays: [0.09, 0.06, 0.04], amps: [1, 0.6, 0.35], peak: 0.06 });
        }
    },
    'step:heavy': {
        gain: 0.75, bus: 'steps', len: 0.3, count: 3, fn(c, out, t, r) {
            body(c, out, t, { f: lerp(75, 95, r()), f2: 42, dur: 0.14, peak: 0.6 });
            burst(c, out, t, { f: lerp(260, 360, r()), q: 0.6, dur: 0.1, peak: 0.45 });
            burst(c, out, t + 0.01, { type: 'bandpass', f: 1600, q: 1, dur: 0.03, peak: 0.06 });
        }
    },
    'step:bone': {
        bus: 'steps', len: 0.2, count: 4, fn(c, out, t, r) {
            // Dry bony clack: a click and a tiny hollow wooden knock
            burst(c, out, t, { type: 'bandpass', f: lerp(1500, 2600, r()), q: 3.5, dur: 0.018, peak: 0.35 });
            modal(c, out, t, { f: lerp(800, 1100, r()), ...WOOD, decays: [0.045, 0.03, 0.02], peak: 0.13 });
            burst(c, out, t + lerp(0.03, 0.05, r()), { type: 'bandpass', f: lerp(2200, 3200, r()), q: 4, dur: 0.012, peak: 0.12 });
        }
    },
    jump: {
        gain: 1.6, bus: 'steps', len: 0.35, count: 3, fn(c, out, t, r) {
            burst(c, out, t, { type: 'bandpass', f: lerp(280, 360, r()), f2: lerp(1200, 1700, r()), q: 1.2, dur: 0.24, attack: 0.05, peak: 0.35 });
            burst(c, out, t, { f: 500, q: 0.6, dur: 0.05, peak: 0.25 }); // push-off scuff
        }
    },
    land: {
        bus: 'steps', len: 0.45, count: 3, fn(c, out, t, r) {
            body(c, out, t, { f: lerp(85, 105, r()), f2: 40, dur: 0.18, peak: 0.6 });
            burst(c, out, t, { f: 520, q: 0.6, dur: 0.12, peak: 0.45 });
            for (let i = 0; i < 3; i++) {
                modal(c, out, t + 0.02 + i * lerp(0.03, 0.05, r()), { f: lerp(2100, 3300, r()), ratios: [1, 1.52], decays: [0.06, 0.04], amps: [1, 0.5], peak: 0.05 - i * 0.012 });
            }
        }
    },
    settle: {
        bus: 'steps', len: 0.3, count: 3, fn(c, out, t, r) {
            // The wooden base disc plants on the board: hollow thunk, a little click on top
            modal(c, out, t, { f: lerp(150, 185, r()), ...WOOD, decays: [0.14, 0.08, 0.045], peak: 0.4 });
            body(c, out, t, { f: lerp(105, 125, r()), f2: 68, dur: 0.08, peak: 0.35 });
            burst(c, out, t, { type: 'bandpass', f: lerp(1800, 2500, r()), q: 1.2, dur: 0.02, peak: 0.12 });
        }
    },
    select: {
        bus: 'ui', len: 0.35, count: 2, fn(c, out, t, r) {
            modal(c, out, t, { f: lerp(1100, 1300, r()), ...WOOD, decays: [0.035, 0.025, 0.015], peak: 0.25 });
            tone(c, out, t + 0.02, { f: 1760, dur: 0.18, peak: 0.045, attack: 0.006 });
            tone(c, out, t + 0.02, { f: 1760 * 2.76, dur: 0.07, peak: 0.01, attack: 0.006 });
        }
    },
    deselect: {
        bus: 'ui', len: 0.2, count: 2, fn(c, out, t, r) {
            modal(c, out, t, { f: lerp(720, 820, r()), ...WOOD, decays: [0.04, 0.025, 0.015], peak: 0.22 });
        }
    },
    invalid: {
        bus: 'ui', len: 0.2, count: 2, fn(c, out, t, r) {
            burst(c, out, t, { f: lerp(220, 280, r()), q: 0.7, dur: 0.06, peak: 0.35 });
            body(c, out, t, { f: 150, f2: 105, dur: 0.06, peak: 0.25 });
        }
    },
    castle: {
        gain: 2, bus: 'fight', len: 1.0, count: 2, fn(c, out, t, r) {
            const root = lerp(190, 200, r());
            brass(c, out, t, { f: root, dur: 0.16, peak: 0.07 });
            brass(c, out, t + 0.18, { f: root * 4 / 3, dur: 0.55, peak: 0.08 });
        }
    },
    'whoosh:light': {
        gain: 2.2, bus: 'fight', len: 0.3, count: 4, fn(c, out, t, r) {
            burst(c, out, t, { type: 'bandpass', f: lerp(600, 900, r()), f2: lerp(2400, 3400, r()), q: 2.2, dur: 0.16, attack: 0.05, peak: 0.5 });
        }
    },
    'whoosh:heavy': {
        gain: 2, bus: 'fight', len: 0.45, count: 3, fn(c, out, t, r) {
            burst(c, out, t, { type: 'bandpass', f: lerp(220, 300, r()), f2: lerp(800, 1100, r()), q: 1.3, dur: 0.3, attack: 0.09, peak: 0.6 });
            burst(c, out, t + 0.05, { f: 300, q: 0.5, dur: 0.2, peak: 0.15, attack: 0.06 });
        }
    },
    'whoosh:magic': {
        gain: 2, bus: 'fight', len: 0.55, count: 3, fn(c, out, t, r) {
            burst(c, out, t, { type: 'bandpass', f: lerp(500, 700, r()), f2: lerp(2500, 3500, r()), q: 2, dur: 0.24, attack: 0.06, peak: 0.35 });
            for (let i = 0; i < 4; i++) tone(c, out, t + 0.04 + i * 0.05, { f: lerp(1400, 2600, r()), dur: 0.22, peak: 0.03, attack: 0.02 });
        }
    },
    clang: {
        bus: 'fight', len: 1.1, count: 4, fn(c, out, t, r) {
            modal(c, out, t, { f: lerp(560, 860, r()), ...METAL, peak: 0.22 });
            modal(c, out, t + 0.004, { f: lerp(900, 1300, r()), ratios: [1, 2.9], decays: [0.4, 0.2], amps: [0.6, 0.3], peak: 0.12 });
            burst(c, out, t, { type: 'highpass', f: 3200, q: 0.7, dur: 0.025, peak: 0.45 });
        }
    },
    hit: {
        bus: 'fight', len: 0.3, count: 4, fn(c, out, t, r) {
            // Cloth/leather thump with a short crunch
            body(c, out, t, { f: lerp(120, 150, r()), f2: 55, dur: 0.12, peak: 0.75 });
            burst(c, out, t, { f: lerp(800, 1100, r()), f2: 300, q: 0.7, dur: 0.1, peak: 0.6 });
            burst(c, out, t + 0.005, { type: 'bandpass', f: lerp(2200, 3000, r()), q: 1.5, dur: 0.04, peak: 0.22 });
        }
    },
    bone: {
        bus: 'fight', len: 0.25, count: 4, fn(c, out, t, r) {
            burst(c, out, t, { type: 'highpass', f: lerp(1400, 1900, r()), q: 0.8, dur: 0.025, peak: 0.6 });
            modal(c, out, t, { f: lerp(950, 1250, r()), ratios: [1, 2.1, 3.4], decays: [0.05, 0.035, 0.02], amps: [1, 0.5, 0.3], peak: 0.25 });
            body(c, out, t, { f: 180, f2: 90, dur: 0.05, peak: 0.25 });
            burst(c, out, t + lerp(0.025, 0.04, r()), { type: 'bandpass', f: lerp(2400, 3400, r()), q: 3, dur: 0.015, peak: 0.25 });
        }
    },
    shatter: {
        gain: 1.2, bus: 'fight', len: 0.9, count: 3, fn(c, out, t, r) {
            burst(c, out, t, { type: 'highpass', f: 1500, q: 0.8, dur: 0.04, peak: 0.6 });
            body(c, out, t, { f: 160, f2: 70, dur: 0.08, peak: 0.3 });
            // Bones bouncing: dense at first, then sparser and quieter (matches the debris)
            const n = 18 + Math.floor(r() * 8);
            for (let i = 0; i < n; i++) {
                const k = i / n;
                const at = t + 0.02 + 0.62 * Math.pow(k, 1.6) + r() * 0.02;
                const amp = 0.28 * (1 - k * 0.8);
                burst(c, out, at, { type: 'bandpass', f: lerp(1500, 4200, r()), q: lerp(3, 6, r()), dur: 0.012, peak: amp });
                if (r() < 0.5) modal(c, out, at, { f: lerp(900, 1800, r()), ratios: [1, 2.3], decays: [0.03, 0.02], amps: [1, 0.4], peak: amp * 0.35 });
            }
        }
    },
    slam: {
        bus: 'fight', len: 1.0, count: 3, fn(c, out, t, r) {
            body(c, out, t, { f: lerp(58, 70, r()), f2: 28, dur: 0.6, peak: 0.95 });
            burst(c, out, t, { f: lerp(180, 240, r()), q: 0.6, dur: 0.5, peak: 0.7 });
            for (let i = 0; i < 14; i++) {
                burst(c, out, t + 0.03 + r() * 0.4, { type: 'highpass', f: lerp(1800, 4000, r()), q: 1, dur: 0.01, peak: lerp(0.05, 0.16, r()) });
            }
        }
    },
    zap: {
        gain: 2, bus: 'fight', len: 0.5, count: 3, fn(c, out, t, r) {
            const filter = c.createBiquadFilter();
            filter.type = 'bandpass';
            filter.Q.value = 2;
            filter.frequency.setValueAtTime(600, t);
            filter.frequency.exponentialRampToValueAtTime(2600, t + 0.3);
            filter.connect(out);
            tone(c, filter, t, { type: 'sawtooth', f: lerp(260, 320, r()), f2: lerp(1000, 1300, r()), dur: 0.3, peak: 0.25, attack: 0.04 });
            burst(c, out, t, { type: 'bandpass', f: 1500, f2: 5000, q: 1.5, dur: 0.3, attack: 0.05, peak: 0.2 });
        }
    },
    bolt: {
        gain: 1.6, bus: 'fight', len: 0.7, count: 2, fn(c, out, t, r) {
            const filter = c.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 900;
            filter.connect(out);
            const f = lerp(105, 125, r());
            tone(c, filter, t, { type: 'sawtooth', f, f2: f * 1.15, dur: 0.5, peak: 0.12, attack: 0.08 });
            tone(c, filter, t, { type: 'sawtooth', f: f * 1.03, f2: f * 1.2, dur: 0.5, peak: 0.1, attack: 0.08 });
            burst(c, out, t, { type: 'bandpass', f: 2200, q: 2, dur: 0.45, attack: 0.1, peak: 0.12 });
        }
    },
    magicHit: {
        bus: 'fight', len: 0.8, count: 3, fn(c, out, t, r) {
            burst(c, out, t, { type: 'bandpass', f: lerp(1400, 1800, r()), f2: 350, q: 1.4, dur: 0.3, peak: 0.6 });
            body(c, out, t, { f: lerp(190, 230, r()), f2: 75, dur: 0.25, peak: 0.55 });
            for (let i = 0; i < 6; i++) tone(c, out, t + 0.02 + r() * 0.25, { f: lerp(2000, 5000, r()), dur: 0.12, peak: 0.035 });
        }
    },
    fall: {
        bus: 'fight', len: 0.55, count: 3, fn(c, out, t, r) {
            body(c, out, t, { f: lerp(75, 92, r()), f2: 38, dur: 0.3, peak: 0.85 });
            burst(c, out, t, { f: lerp(350, 450, r()), q: 0.6, dur: 0.24, peak: 0.55 });
            burst(c, out, t + lerp(0.08, 0.13, r()), { f: 380, q: 0.6, dur: 0.1, peak: 0.2 }); // small bounce
        }
    },
    dissolve: {
        gain: 1.6, bus: 'fight', len: 1.4, count: 2, fn(c, out, t, r) {
            burst(c, out, t, { type: 'highpass', f: 4200, q: 0.6, dur: 0.9, attack: 0.3, peak: 0.12 });
            for (let i = 0; i < 9; i++) {
                tone(c, out, t + 0.1 + r() * 0.8, { f: lerp(1500, 3200, r()), dur: lerp(0.15, 0.35, r()), peak: 0.03, attack: 0.04 });
            }
        }
    },
    death: {
        gain: 1.8, bus: 'fight', len: 0.9, count: 3, fn(c, out, t, r) {
            tone(c, out, t, { type: 'triangle', f: lerp(380, 450, r()), f2: lerp(120, 150, r()), dur: 0.6, peak: 0.14, attack: 0.02 });
            burst(c, out, t + 0.05, { f: 600, f2: 200, q: 0.5, dur: 0.45, attack: 0.08, peak: 0.12 });
        }
    },
    promote: {
        gain: 1.8, bus: 'fight', len: 1.4, count: 2, fn(c, out, t, r) {
            const root = lerp(520, 540, r());
            [1, 1.26, 1.5, 2, 2.52].forEach((m, i) => {
                modal(c, out, t + i * 0.08, { f: root * m, ...BELL, decays: [0.6, 0.4, 0.25, 0.15], peak: 0.09 });
            });
            burst(c, out, t + 0.1, { type: 'highpass', f: 5000, q: 0.5, dur: 0.8, attack: 0.25, peak: 0.08 });
        }
    },
    check: {
        bus: 'ui', len: 1.0, count: 2, fn(c, out, t, r) {
            body(c, out, t, { f: lerp(68, 76, r()), f2: 48, dur: 0.4, peak: 0.8 });
            burst(c, out, t, { f: 260, q: 0.6, dur: 0.25, peak: 0.5 });
            // Tense sting: a close cluster, brass-like
            brass(c, out, t + 0.04, { f: 220, dur: 0.5, peak: 0.05, bright: 1400 });
            brass(c, out, t + 0.04, { f: 330, dur: 0.5, peak: 0.045, bright: 1400 });
            brass(c, out, t + 0.04, { f: 349.2, dur: 0.5, peak: 0.04, bright: 1400 });
        }
    },
    checkmate: {
        bus: 'ui', len: 3.4, count: 1, fn(c, out, t, r) {
            modal(c, out, t, { f: 88, ratios: [1, 2.14, 2.81, 3.62, 4.9], decays: [3, 2.2, 1.6, 1.1, 0.7], amps: [1, 0.6, 0.45, 0.3, 0.2], peak: 0.35, attack: 0.004 });
            burst(c, out, t, { f: 300, q: 0.6, dur: 0.4, peak: 0.4 });
            [330, 262, 220, 175].forEach((f, i) => tone(c, out, t + 0.5 + i * 0.32, { type: 'triangle', f, dur: i === 3 ? 1.1 : 0.35, peak: 0.08, attack: 0.02 }));
        }
    },
    victory: {
        gain: 3, bus: 'ui', len: 2.4, count: 1, fn(c, out, t) {
            [262, 330, 392, 523].forEach((f, i) => brass(c, out, t + i * 0.06, { f, dur: 1.4, peak: 0.05, attack: 0.25, bright: 3200 }));
            burst(c, out, t + 0.2, { type: 'highpass', f: 6000, q: 0.5, dur: 1.2, attack: 0.4, peak: 0.06 });
            modal(c, out, t + 0.3, { f: 1047, ...BELL, peak: 0.05 });
        }
    },
    draw: {
        gain: 1.6, bus: 'ui', len: 2.0, count: 1, fn(c, out, t) {
            modal(c, out, t, { f: 784, ...BELL, peak: 0.12 });
            modal(c, out, t + 0.35, { f: 587, ...BELL, peak: 0.12 });
        }
    }
};

// Older and alternative names map onto the bank (keeps existing callers working)
const ALIASES = {
    step: 'step:light', whoosh: 'whoosh:light', thud: 'fall', magic: 'magicHit', cheer: 'victory',
    gameover: 'checkmate', move: 'settle', capture: 'hit', stalemate: 'draw'
};
const DEFAULT_VARIANT = { step: 'light', whoosh: 'light' };

export const SOUND_BANK = Object.keys(BANK).map(key => ({ key, bus: BANK[key].bus, count: BANK[key].count, length: BANK[key].len }));
export const SOUND_NAMES = [...new Set([...Object.keys(BANK).map(k => k.split(':')[0]), ...Object.keys(ALIASES)])];

// Runs a recipe into dest through its balance gain
function runRecipe(c, def, dest, t, rng) {
    const gain = c.createGain();
    gain.gain.value = def.gain ?? 1;
    gain.connect(dest);
    def.fn(c, gain, t, rng);
}

// Keeps rendered variations below full scale; the limiter handles stacking
function normalize(buffer, ceiling = 0.9) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak > ceiling) {
        const k = ceiling / peak;
        for (let i = 0; i < data.length; i++) data[i] *= k;
    }
    return buffer;
}

// Renders one variation offline (sound-test page, QA). Resolves to an AudioBuffer, or null without OfflineAudioContext.
export async function renderVariation(key, index = 0, sampleRate = SAMPLE_RATE) {
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    const def = BANK[key];
    if (!OfflineCtx || !def) return null;
    const off = new OfflineCtx(1, Math.ceil(def.len * sampleRate), sampleRate);
    runRecipe(off, def, off.destination, 0.005, mulberry32(hash(key) + index * 7919));
    return normalize(await off.startRendering());
}

function resolveKey(name, variant) {
    if (typeof name !== 'string') return null;
    if (BANK[name]) return name;
    if (variant && BANK[`${name}:${variant}`]) return `${name}:${variant}`;
    if (DEFAULT_VARIANT[name] && BANK[`${name}:${DEFAULT_VARIANT[name]}`]) return `${name}:${DEFAULT_VARIANT[name]}`;
    const alias = ALIASES[name];
    return alias && BANK[alias] ? alias : null;
}

export function createAudio({ muted = false, ambience = true } = {}) {
    const g = globalThis;
    const AudioCtx = g.AudioContext || g.webkitAudioContext;
    const OfflineCtx = g.OfflineAudioContext || g.webkitOfflineAudioContext;
    let ctx = null, master = null, masterMeter = null;
    const buses = {}, meters = {};
    let mutedFlag = !!muted, ambienceOn = !!ambience;
    let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    let slowRate = 1;
    let camera = null;
    const voices = new Set();          // { src, out, bus, baseRate, end }
    const rendered = new Map();        // key -> AudioBuffer[]
    const lastIndex = new Map();
    let renderStarted = false, ready = false;
    let amb = null;

    function ensureContext() {
        if (ctx || !AudioCtx) return ctx;
        try { ctx = new AudioCtx(); } catch (e) { return null; }
        master = ctx.createGain();
        master.gain.value = mutedFlag ? 0 : MASTER_VOLUME;
        let tail = master;
        if (typeof ctx.createDynamicsCompressor === 'function') {
            // Gentle glue compressor, then a fast limiter so stacked fight hits never clip
            const glue = ctx.createDynamicsCompressor();
            setParam(glue.threshold, -18); setParam(glue.knee, 12); setParam(glue.ratio, 3);
            setParam(glue.attack, 0.01); setParam(glue.release, 0.2);
            const limiter = ctx.createDynamicsCompressor();
            setParam(limiter.threshold, -3); setParam(limiter.knee, 0); setParam(limiter.ratio, 20);
            setParam(limiter.attack, 0.002); setParam(limiter.release, 0.08);
            tail.connect(glue); glue.connect(limiter); tail = limiter;
        }
        tail.connect(ctx.destination);
        masterMeter = makeMeter(master);
        for (const [name, volume] of Object.entries(BUS_VOLUME)) {
            buses[name] = ctx.createGain();
            buses[name].gain.value = volume;
            buses[name].connect(master);
            meters[name] = makeMeter(buses[name]);
        }
        return ctx;
    }

    function setParam(param, value) { if (param) param.value = value; }

    function makeMeter(node) {
        if (typeof ctx.createAnalyser !== 'function') return null;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        node.connect(analyser);
        return { analyser, data: new Float32Array(analyser.fftSize) };
    }

    function readMeter(meter) {
        if (!meter?.analyser?.getFloatTimeDomainData) return 0;
        meter.analyser.getFloatTimeDomainData(meter.data);
        let peak = 0;
        for (const v of meter.data) peak = Math.max(peak, Math.abs(v));
        return Math.min(1, peak);
    }

    // Renders every variation once, in small async steps so the page stays smooth
    async function renderBank() {
        if (renderStarted || !OfflineCtx) return;
        renderStarted = true;
        for (const [key, def] of Object.entries(BANK)) {
            const list = [];
            for (let i = 0; i < def.count; i++) {
                try {
                    const off = new OfflineCtx(1, Math.ceil(def.len * SAMPLE_RATE), SAMPLE_RATE);
                    runRecipe(off, def, off.destination, 0.005, mulberry32(hash(key) + i * 7919));
                    list.push(normalize(await off.startRendering()));
                } catch (e) {
                    break; // live synthesis stays as the fallback for this key
                }
            }
            if (list.length) rendered.set(key, list);
        }
        ready = true;
    }

    function unlock() {
        if (!ensureContext()) return;
        if (ctx.state === 'suspended' && !hidden) ctx.resume().catch(() => {});
        renderBank();
        updateAmbience();
    }

    if (AudioCtx && typeof document !== 'undefined' && document.addEventListener) {
        const onGesture = () => {
            unlock();
            if (ctx?.state === 'running') {
                document.removeEventListener('pointerdown', onGesture, true);
                document.removeEventListener('keydown', onGesture, true);
            }
        };
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
        document.addEventListener('visibilitychange', () => {
            hidden = document.visibilityState === 'hidden';
            if (!ctx) return;
            if (hidden) ctx.suspend?.().catch(() => {});
            else ctx.resume?.().catch(() => {});
            updateAmbience();
        });
    }

    // Stereo position from the projected screen x, level from the camera distance
    function spatial(pos) {
        if (!pos || !camera?.projectionMatrix || !camera.matrixWorldInverse) return { pan: 0, gain: 1 };
        const v = camera.matrixWorldInverse.elements, p = camera.projectionMatrix.elements;
        const x = pos.x ?? 0, y = pos.y ?? 0, z = pos.z ?? 0;
        if (![x, y, z].every(Number.isFinite)) return { pan: 0, gain: 1 };
        // view space
        const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
        const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
        const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
        // clip space x and w
        const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
        const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
        const ndcX = cw > 0.0001 ? cx / cw : 0;
        const dist = Math.hypot(vx, vy, vz);
        const pan = clamp(ndcX * 0.75, -0.85, 0.85);
        const gain = clamp(Math.pow(11 / Math.max(1, dist), 0.6), 0.4, 1.4);
        return { pan: Number.isFinite(pan) ? pan : 0, gain: Number.isFinite(gain) ? gain : 1 };
    }

    function play(name, { volume = 1, rate = 1, pos = null, variant = null, index = null, pan = null } = {}) {
        if (mutedFlag || hidden || !ctx || ctx.state !== 'running' || voices.size >= MAX_VOICES) return;
        const key = resolveKey(name, variant);
        if (!key) return;
        const def = BANK[key];
        volume = Number.isFinite(volume) ? clamp(volume, 0, 2) : 1;
        rate = Number.isFinite(rate) && rate > 0 ? clamp(rate, 0.25, 4) : 1;
        if (volume <= 0) return;
        const where = spatial(pos);
        const t = ctx.currentTime + 0.005;

        const out = ctx.createGain();
        out.gain.value = volume * where.gain;
        let head = out;
        const panValue = Number.isFinite(pan) ? clamp(pan, -1, 1) : where.pan;
        if (panValue && typeof ctx.createStereoPanner === 'function') {
            const panner = ctx.createStereoPanner();
            panner.pan.value = panValue;
            out.connect(panner);
            head = panner;
        }
        const bus = buses[def.bus] || master;
        head.connect(bus);

        const fightBus = def.bus === 'fight';
        const baseRate = rate * (1 + (Math.random() * 2 - 1) * JITTER);
        const voice = { out, head, fight: fightBus, baseRate, src: null };
        let length;
        try {
            const list = rendered.get(key);
            if (list?.length) {
                let i = Number.isInteger(index) ? clamp(index, 0, list.length - 1) : Math.floor(Math.random() * list.length);
                if (!Number.isInteger(index) && list.length > 1 && i === lastIndex.get(key)) i = (i + 1) % list.length;
                lastIndex.set(key, i);
                const src = ctx.createBufferSource();
                src.buffer = list[i];
                src.playbackRate.value = baseRate * (fightBus ? slowRate : 1);
                src.connect(out);
                src.start(t);
                voice.src = src;
                length = list[i].duration / (baseRate * (fightBus ? slowRate : 1));
            } else {
                // Live fallback (not rendered yet, or no OfflineAudioContext): run the recipe directly.
                // Rate and slow-mo cannot apply here; a fresh random seed gives the variation.
                const seed = Number.isInteger(index) ? hash(key) + index * 7919 : (Math.random() * 1e9) | 0;
                runRecipe(ctx, def, out, t, mulberry32(seed));
                length = def.len;
            }
        } catch (e) {
            out.disconnect?.();
            return;
        }
        voices.add(voice);
        const finish = () => {
            if (!voices.delete(voice)) return;
            try { voice.out.disconnect(); voice.head.disconnect?.(); } catch (e) { /* ignore */ }
        };
        if (voice.src && 'onended' in voice.src) voice.src.onended = finish;
        setTimeout(finish, (length + 0.3) * 1000)?.unref?.();
    }

    function stopAll() {
        for (const voice of [...voices]) {
            try { voice.src?.stop(); } catch (e) { /* ignore */ }
            try { voice.out.disconnect(); voice.head.disconnect?.(); } catch (e) { /* ignore */ }
            voices.delete(voice);
        }
    }

    function setMuted(on) {
        mutedFlag = !!on;
        if (master) {
            master.gain.cancelScheduledValues?.(ctx.currentTime);
            if (mutedFlag) master.gain.value = 0;
            else master.gain.setTargetAtTime(MASTER_VOLUME, ctx.currentTime, 0.02);
        }
        if (mutedFlag) stopAll(); else unlock();
        updateAmbience();
    }

    // Cinematic slow motion: fight sounds drop in pitch (and stretch) with the scene time scale
    function setSlowMo(factor) {
        const next = Math.sqrt(clamp(Number.isFinite(factor) ? factor : 1, 0.1, 1));
        if (Math.abs(next - slowRate) < 0.005) return;
        slowRate = next;
        if (!ctx) return;
        for (const voice of voices) {
            if (voice.fight && voice.src?.playbackRate) {
                voice.src.playbackRate.setTargetAtTime(voice.baseRate * slowRate, ctx.currentTime, 0.04);
            }
        }
    }

    // --- Ambience: quiet room tone and torch crackle (live, not rendered) ---
    function updateAmbience() {
        const want = ambienceOn && !mutedFlag && !hidden && ctx && ctx.state !== 'closed';
        if (want && !amb) startAmbience();
        else if (!want && amb) stopAmbience();
    }

    function startAmbience() {
        const bus = buses.ambience;
        if (!bus) return;
        const out = ctx.createGain();
        out.gain.setValueAtTime(0.0001, ctx.currentTime);
        out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 1.5);
        out.connect(bus);
        // Room tone: looped noise through a low lowpass, very quiet
        const room = ctx.createBufferSource();
        room.buffer = noiseBuffer(ctx);
        room.loop = true;
        const roomFilter = ctx.createBiquadFilter();
        roomFilter.type = 'lowpass';
        roomFilter.frequency.value = 170;
        const roomGain = ctx.createGain();
        roomGain.gain.value = 0.05;
        room.connect(roomFilter); roomFilter.connect(roomGain); roomGain.connect(out);
        room.start();
        // Torch: a soft flame hiss plus random crackles scheduled a little ahead
        const flame = ctx.createBufferSource();
        flame.buffer = noiseBuffer(ctx);
        flame.loop = true;
        const flameFilter = ctx.createBiquadFilter();
        flameFilter.type = 'bandpass';
        flameFilter.frequency.value = 700;
        flameFilter.Q.value = 0.4;
        const flameGain = ctx.createGain();
        flameGain.gain.value = 0.012;
        flame.connect(flameFilter); flameFilter.connect(flameGain); flameGain.connect(out);
        flame.start();
        const timer = setInterval(() => {
            if (!amb || ctx.state !== 'running') return;
            const n = Math.random() < 0.6 ? 1 : 2 + Math.floor(Math.random() * 3);
            for (let i = 0; i < n; i++) {
                const at = ctx.currentTime + 0.05 + Math.random() * 0.25 + i * 0.03;
                burst(ctx, out, at, { type: 'highpass', f: 1800 + Math.random() * 2500, q: 0.8, dur: 0.006 + Math.random() * 0.01, peak: 0.02 + Math.random() * 0.05 });
            }
        }, 300);
        timer?.unref?.(); // node (tests): never keep the process alive
        amb = { out, sources: [room, flame], timer };
    }

    function stopAmbience() {
        const { out, sources, timer } = amb;
        amb = null;
        clearInterval(timer);
        try {
            out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1);
            for (const s of sources) s.stop(ctx.currentTime + 0.5);
        } catch (e) { /* ignore */ }
        setTimeout(() => { try { out.disconnect(); } catch (e) { /* ignore */ } }, 700);
    }

    function setAmbience(on) {
        ambienceOn = !!on;
        updateAmbience();
    }

    return {
        play, unlock, setMuted, setSlowMo, setAmbience,
        has: (name, variant) => resolveKey(name, variant) !== null,
        isMuted: () => mutedFlag,
        isAmbience: () => ambienceOn,
        isReady: () => ready,
        setListener: (cam) => { camera = cam || null; },
        levels: () => ({
            master: readMeter(masterMeter), steps: readMeter(meters.steps), fight: readMeter(meters.fight),
            ui: readMeter(meters.ui), ambience: readMeter(meters.ambience)
        })
    };
}
