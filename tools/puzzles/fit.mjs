// Logistic fits shared by bench.mjs and bench-stockfish.mjs.
// P(solve) = 1 / (1 + 10^((puzzleRating - R) / s)); s = 400 is the Elo/Glicko expectation.
const LN10 = Math.log(10);
// Negative log-likelihood and its derivatives in R for P = 1/(1+10^((r-R)/s)).
export function fitR(data, s) {
    let R = 1500;
    for (let it = 0; it < 100; it++) {
        let g = 0, h = 0;
        for (const [r, y] of data) {
            const p = 1 / (1 + Math.pow(10, (r - R) / s));
            g += (y - p) * LN10 / s;           // d logL / dR
            h -= p * (1 - p) * (LN10 / s) ** 2; // d2 logL / dR2
        }
        if (h === 0) break;
        const step = Math.max(-300, Math.min(300, -g / h));
        R = Math.max(-1500, Math.min(5000, R + step));
        if (Math.abs(step) < 0.01) break;
    }
    return R;
}
export function logLik(data, R, s) {
    let L = 0;
    for (const [r, y] of data) {
        const p = Math.min(1 - 1e-12, Math.max(1e-12, 1 / (1 + Math.pow(10, (r - R) / s))));
        L += y ? Math.log(p) : Math.log(1 - p);
    }
    return L;
}
export function fitFree(data) { // golden-section over the slope, R fitted for each slope
    let a = 50, b = 3000;
    const f = (s) => -logLik(data, fitR(data, s), s);
    for (let i = 0; i < 40; i++) {
        const c = b - (b - a) / 1.618, d = a + (b - a) / 1.618;
        if (f(c) < f(d)) b = d; else a = c;
    }
    const s = (a + b) / 2;
    return { R: fitR(data, s), s };
}
export function bootstrap(data, s, n, seed) {
    let st = seed >>> 0;
    const rnd = () => { st = (st + 0x6D2B79F5) | 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const Rs = [];
    for (let k = 0; k < n; k++) {
        const sample = data.map(() => data[Math.floor(rnd() * data.length)]);
        Rs.push(fitR(sample, s));
    }
    Rs.sort((x, y) => x - y);
    return [Rs[Math.floor(n * 0.05)], Rs[Math.floor(n * 0.95)]];
}
