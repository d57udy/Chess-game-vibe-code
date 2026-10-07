// Elo statistics: logistic model P(win) = 1 / (1 + 10^(-diff/400)), draws count as half a point.
const K = Math.LN10 / 400;
const expected = (diff) => 1 / (1 + Math.pow(10, -diff / 400));
export const eloFromScore = (s) => -400 * Math.log10(1 / s - 1);

// Head-to-head score with a 95% confidence interval (trinomial variance of the per-game score).
export function pairStats(w, d, l) {
    const n = w + d + l;
    const s = (w + d / 2) / n;
    const v = (w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s ** 2) / n;
    const se = Math.sqrt(v / n);
    const clamp = (x) => Math.min(1 - 0.5 / n, Math.max(0.5 / n, x));
    return {
        n, w, d, l, score: s,
        elo: eloFromScore(clamp(s)),
        lo: eloFromScore(clamp(s - 1.96 * se)),
        hi: eloFromScore(clamp(s + 1.96 * se)),
    };
}

// Aggregates game records ({ white, black, result }) into per-pair totals keyed "a|b" (a < b).
export function aggregate(records) {
    const pairs = new Map();
    for (const r of records) {
        const [a, b] = [r.white, r.black].sort();
        const key = a + '|' + b;
        if (!pairs.has(key)) pairs.set(key, { a, b, w: 0, d: 0, l: 0 }); // w/l from a's side
        const p = pairs.get(key);
        const whitePts = r.result === '1-0' ? 1 : r.result === '0-1' ? 0 : 0.5;
        const aPts = r.white === a ? whitePts : 1 - whitePts;
        if (aPts === 1) p.w++; else if (aPts === 0) p.l++; else p.d++;
    }
    return [...pairs.values()];
}

// Maximum-likelihood ratings for all players, with `anchors` ({ name: elo }) held fixed.
// `prior` virtual draws per pairing keep 100% / 0% scores finite. Returns
// { name: { elo, se, lo, hi, games } }; se comes from the inverse Fisher information.
export function fitRatings(allPairs, anchors, { prior = 1 } = {}) {
    // Only players connected to an anchor through played games have a defined rating.
    const linked = new Set(Object.keys(anchors));
    for (let grew = true; grew;) {
        grew = false;
        for (const p of allPairs) {
            if (linked.has(p.a) !== linked.has(p.b)) { linked.add(p.a); linked.add(p.b); grew = true; }
        }
    }
    const pairs = allPairs.filter((p) => linked.has(p.a));
    const names = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
    const free = names.filter((n) => !(n in anchors));
    const idx = new Map(free.map((n, i) => [n, i]));
    const R = new Map(names.map((n) => [n, n in anchors ? anchors[n] : guess(n)]));
    const data = pairs.map((p) => ({ a: p.a, b: p.b, n: p.w + p.d + p.l + prior, s: p.w + p.d / 2 + prior / 2 }));

    let H = null;
    for (let iter = 0; iter < 200; iter++) {
        const g = new Float64Array(free.length);
        H = free.map(() => new Float64Array(free.length));
        for (const { a, b, n, s } of data) {
            const p = expected(R.get(a) - R.get(b));
            const grad = (s - n * p) * K, h = n * p * (1 - p) * K * K;
            const ia = idx.get(a), ib = idx.get(b);
            if (ia !== undefined) { g[ia] += grad; H[ia][ia] += h; }
            if (ib !== undefined) { g[ib] -= grad; H[ib][ib] += h; }
            if (ia !== undefined && ib !== undefined) { H[ia][ib] -= h; H[ib][ia] -= h; }
        }
        const step = solve(H.map((r) => [...r]), [...g]);
        let maxStep = 0;
        free.forEach((n, i) => {
            const st = Math.max(-200, Math.min(200, step[i]));
            maxStep = Math.max(maxStep, Math.abs(st));
            R.set(n, R.get(n) + st);
        });
        if (maxStep < 0.01) break;
    }
    const cov = invert(H.map((r) => [...r]));
    const games = new Map(names.map((n) => [n, 0]));
    for (const p of pairs) { const n = p.w + p.d + p.l; games.set(p.a, games.get(p.a) + n); games.set(p.b, games.get(p.b) + n); }
    const out = {};
    for (const n of names) {
        const i = idx.get(n);
        const se = i === undefined ? 0 : Math.sqrt(Math.max(0, cov[i][i]));
        out[n] = { elo: R.get(n), se, lo: R.get(n) - 1.96 * se, hi: R.get(n) + 1.96 * se, games: games.get(n), anchor: n in anchors };
    }
    return out;
}

// Starting point: the number in the player name, if any (e.g. "base:1300").
function guess(name) { const m = name.match(/:(-?\d+)$/); return m ? +m[1] : 1500; }

function solve(A, b) {
    const n = b.length;
    for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
        if (Math.abs(A[c][c]) < 1e-15) continue;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = A[r][c] / A[c][c];
            for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
            b[r] -= f * b[c];
        }
    }
    return b.map((x, i) => (Math.abs(A[i][i]) < 1e-15 ? 0 : x / A[i][i]));
}

function invert(A) {
    const n = A.length;
    return Array.from({ length: n }, (_, j) => solve(A.map((r) => [...r]), Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))))
        .reduce((M, col, j) => { col.forEach((v, i) => { M[i][j] = v; }); return M; }, Array.from({ length: n }, () => new Array(n).fill(0)));
}
