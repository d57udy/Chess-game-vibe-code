// Sound effects for the 3D battle prototype. Fight beats are synthesized with WebAudio (no sample
// files, nothing to license); move/capture/check/game-over reuse the 2D game's mp3s from the repo
// root when they decode, with a synthesized fallback. Silent no-op where WebAudio is missing.
//
//   createAudio({ muted }) -> { play(name, { volume, rate }), setMuted(bool), isMuted(), unlock() }

const SAMPLE_FILES = { move: 'move.mp3', capture: 'capture.mp3', check: 'check.mp3', gameover: 'game-over.mp3' };
const MASTER_VOLUME = 0.55;
const MAX_VOICES = 24; // drop new sounds rather than pile up noise during busy fights

export function createAudio({ muted = false } = {}) {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    let ctx = null, master = null, noise = null;
    let isMutedFlag = !!muted;
    let voices = 0;
    const samples = {};

    function ensureContext() {
        if (ctx || !AudioCtx) return ctx;
        try {
            ctx = new AudioCtx();
        } catch (e) {
            return null;
        }
        master = ctx.createGain();
        master.gain.value = isMutedFlag ? 0 : MASTER_VOLUME;
        master.connect(ctx.destination);
        noise = makeNoiseBuffer(ctx);
        loadSamples();
        return ctx;
    }

    function loadSamples() {
        for (const [name, url] of Object.entries(SAMPLE_FILES)) {
            fetch(url)
                .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(r.status))))
                .then(data => ctx.decodeAudioData(data))
                .then(buffer => { samples[name] = buffer; })
                .catch(() => { /* synthesized fallback */ });
        }
    }

    // Browsers start audio suspended until a user gesture
    function unlock() {
        if (!ensureContext()) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    if (AudioCtx && typeof document !== 'undefined') {
        const onGesture = () => {
            unlock();
            if (ctx?.state === 'running') {
                document.removeEventListener('pointerdown', onGesture, true);
                document.removeEventListener('keydown', onGesture, true);
            }
        };
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
    }

    function play(name, { volume = 1, rate = 1 } = {}) {
        if (isMutedFlag || !ctx || ctx.state !== 'running' || voices >= MAX_VOICES) return;
        const out = ctx.createGain();
        out.gain.value = Math.max(0, Math.min(2, volume));
        out.connect(master);
        const t = ctx.currentTime + 0.005;
        let length;
        try {
            if (samples[name]) {
                const src = ctx.createBufferSource();
                src.buffer = samples[name];
                src.playbackRate.value = rate;
                src.connect(out);
                src.start(t);
                length = samples[name].duration / rate;
            } else {
                const synth = SYNTHS[name];
                if (!synth) return;
                length = synth({ ctx, out, t, rate, noise });
            }
        } catch (e) {
            return;
        }
        voices++;
        setTimeout(() => { voices--; out.disconnect(); }, (length + 0.2) * 1000);
    }

    function setMuted(on) {
        isMutedFlag = !!on;
        if (master) master.gain.setTargetAtTime(isMutedFlag ? 0 : MASTER_VOLUME, ctx.currentTime, 0.02);
        if (!isMutedFlag) unlock();
    }

    return { play, setMuted, isMuted: () => isMutedFlag, unlock };
}

// --- Synthesis helpers ---
function makeNoiseBuffer(ctx) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
}

// Gain node with an attack/decay envelope starting at t
function env(ctx, dest, t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(dest);
    return g;
}

function tone(ctx, dest, t, { type = 'sine', freq, to = null, dur, peak = 0.5, attack = 0.005 }) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    osc.connect(env(ctx, dest, t, peak, attack, dur));
    osc.start(t);
    osc.stop(t + attack + dur + 0.02);
}

function noiseBurst(ctx, dest, noise, t, { type = 'lowpass', freq = 1000, to = null, q = 1, dur, peak = 0.5, attack = 0.005 }) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (to) filter.frequency.exponentialRampToValueAtTime(to, t + attack + dur);
    src.connect(filter);
    filter.connect(env(ctx, dest, t, peak, attack, dur));
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + dur + 0.02);
}

// Each synth schedules its nodes and returns its length in seconds.
const SYNTHS = {
    step({ ctx, out, t, rate, noise }) {
        noiseBurst(ctx, out, noise, t, { freq: 420 * rate, dur: 0.07, peak: 0.35 });
        tone(ctx, out, t, { freq: 110 * rate, to: 60 * rate, dur: 0.06, peak: 0.25 });
        return 0.1;
    },
    whoosh({ ctx, out, t, rate, noise }) {
        noiseBurst(ctx, out, noise, t, { type: 'bandpass', freq: 400 * rate, to: 2400 * rate, q: 2.5, dur: 0.22, attack: 0.06, peak: 0.6 });
        return 0.3;
    },
    clang({ ctx, out, t, rate, noise }) {
        // Inharmonic partials read as struck metal
        for (const [f, p, d] of [[523, 0.3, 0.7], [1247, 0.22, 0.5], [1871, 0.16, 0.4], [2659, 0.12, 0.3], [3511, 0.08, 0.2]]) {
            tone(ctx, out, t, { type: 'sine', freq: f * rate, dur: d, peak: p, attack: 0.002 });
        }
        noiseBurst(ctx, out, noise, t, { type: 'highpass', freq: 3000, dur: 0.05, peak: 0.4, attack: 0.001 });
        return 0.75;
    },
    hit({ ctx, out, t, rate, noise }) {
        noiseBurst(ctx, out, noise, t, { freq: 1400 * rate, to: 300, dur: 0.14, peak: 0.7, attack: 0.002 });
        tone(ctx, out, t, { freq: 150 * rate, to: 55, dur: 0.16, peak: 0.6, attack: 0.002 });
        return 0.2;
    },
    thud({ ctx, out, t, rate, noise }) {
        tone(ctx, out, t, { freq: 95 * rate, to: 38, dur: 0.35, peak: 0.8, attack: 0.003 });
        noiseBurst(ctx, out, noise, t, { freq: 300 * rate, dur: 0.25, peak: 0.5, attack: 0.003 });
        return 0.4;
    },
    bone({ ctx, out, t, rate, noise }) {
        // A short rattle of dry clicks
        for (let i = 0; i < 6; i++) {
            const at = t + i * 0.035 + Math.random() * 0.02;
            noiseBurst(ctx, out, noise, at, { type: 'bandpass', freq: (1800 + Math.random() * 1800) * rate, q: 6, dur: 0.035, peak: 0.6 - i * 0.07, attack: 0.001 });
            tone(ctx, out, at, { type: 'triangle', freq: (700 + Math.random() * 500) * rate, dur: 0.03, peak: 0.15, attack: 0.001 });
        }
        return 0.3;
    },
    magic({ ctx, out, t, rate, noise }) {
        const notes = [659, 784, 988, 1319, 1568];
        notes.forEach((f, i) => tone(ctx, out, t + i * 0.05, { type: 'triangle', freq: f * rate, dur: 0.35, peak: 0.18, attack: 0.01 }));
        noiseBurst(ctx, out, noise, t, { type: 'bandpass', freq: 2000 * rate, to: 6000 * rate, q: 4, dur: 0.5, peak: 0.15, attack: 0.08 });
        return 0.65;
    },
    zap({ ctx, out, t, rate }) {
        tone(ctx, out, t, { type: 'sawtooth', freq: 1400 * rate, to: 180 * rate, dur: 0.22, peak: 0.3, attack: 0.002 });
        tone(ctx, out, t + 0.02, { type: 'square', freq: 900 * rate, to: 120 * rate, dur: 0.18, peak: 0.12, attack: 0.002 });
        return 0.28;
    },
    death({ ctx, out, t, rate, noise }) {
        tone(ctx, out, t, { type: 'triangle', freq: 330 * rate, to: 70 * rate, dur: 0.75, peak: 0.35, attack: 0.02 });
        tone(ctx, out, t + 0.05, { type: 'sine', freq: 247 * rate, to: 55 * rate, dur: 0.8, peak: 0.25, attack: 0.02 });
        noiseBurst(ctx, out, noise, t + 0.45, { freq: 250, dur: 0.3, peak: 0.35 });
        return 0.95;
    },
    cheer({ ctx, out, t, rate }) {
        // Short brass-like fanfare: G C E G
        [[392, 0], [523, 0.12], [659, 0.24], [784, 0.36]].forEach(([f, at], i) => {
            tone(ctx, out, t + at, { type: 'sawtooth', freq: f * rate, dur: i === 3 ? 0.6 : 0.14, peak: 0.13, attack: 0.02 });
            tone(ctx, out, t + at, { type: 'square', freq: f * rate / 2, dur: i === 3 ? 0.6 : 0.14, peak: 0.05, attack: 0.02 });
        });
        return 1.05;
    },
    promote({ ctx, out, t, rate }) {
        [523, 659, 784, 1047, 1319].forEach((f, i) => {
            tone(ctx, out, t + i * 0.07, { type: 'sine', freq: f * rate, dur: 0.5, peak: 0.22, attack: 0.004 });
            tone(ctx, out, t + i * 0.07, { type: 'sine', freq: f * 2.76 * rate, dur: 0.25, peak: 0.05, attack: 0.004 });
        });
        return 0.9;
    },
    check({ ctx, out, t, rate }) {
        tone(ctx, out, t, { type: 'triangle', freq: 880 * rate, dur: 0.18, peak: 0.3 });
        tone(ctx, out, t + 0.16, { type: 'triangle', freq: 660 * rate, dur: 0.3, peak: 0.3 });
        return 0.5;
    },
    gameover({ ctx, out, t, rate }) {
        [523, 415, 349, 262].forEach((f, i) => tone(ctx, out, t + i * 0.22, { type: 'triangle', freq: f * rate, dur: i === 3 ? 0.9 : 0.25, peak: 0.28, attack: 0.01 }));
        return 1.6;
    },
    move({ ctx, out, t, rate, noise }) {
        noiseBurst(ctx, out, noise, t, { type: 'bandpass', freq: 900 * rate, q: 1.5, dur: 0.06, peak: 0.5, attack: 0.002 });
        tone(ctx, out, t, { freq: 200 * rate, to: 120 * rate, dur: 0.06, peak: 0.3, attack: 0.002 });
        return 0.1;
    },
    capture({ ctx, out, t, rate, noise }) {
        SYNTHS.hit({ ctx, out, t, rate, noise });
        return 0.2;
    }
};

export const SOUND_NAMES = Object.keys(SYNTHS);
