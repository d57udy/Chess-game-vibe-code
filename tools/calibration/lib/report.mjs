// Summaries of game records: head-to-head scores, anchored ratings, per-level search statistics.
import { aggregate, pairStats, fitRatings } from './elo.mjs';

export function summarize(records, extraAnchors = {}) {
    const pairs = aggregate(records);
    const anchors = { ...extraAnchors };
    for (const p of pairs) for (const n of [p.a, p.b]) if (n.startsWith('sf:')) anchors[n] = +n.slice(3);
    const head = pairs.map((p) => ({ a: p.a, b: p.b, ...pairStats(p.w, p.d, p.l) }));
    const perf = {};
    for (const r of records) for (const [side, name] of [['w', r.white], ['b', r.black]]) {
        if (/^(sf|maia):/.test(name) || !r.stats[side].moves) continue;
        const s = perf[name] || (perf[name] = { moves: 0, ms: 0, nodes: 0, depth: 0 });
        const m = r.stats[side].moves;
        s.ms += r.stats[side].ms * m; s.nodes += r.stats[side].nodes * m; s.depth += r.stats[side].depth * m; s.moves += m;
    }
    for (const s of Object.values(perf)) { s.ms = Math.round(s.ms / s.moves); s.nodes = Math.round(s.nodes / s.moves); s.depth = +(s.depth / s.moves).toFixed(2); }
    const ratings = Object.keys(anchors).length ? fitRatings(pairs, anchors) : null;
    return { head, ratings, perf };
}

export function printSummary({ head, ratings, perf }) {
    console.log('\nHead to head (score of first player):');
    for (const h of head) {
        console.log(`  ${h.a.padEnd(14)} vs ${h.b.padEnd(14)} +${h.w} =${h.d} -${h.l}  ${(100 * h.score).toFixed(1)}%  diff ${fmt(h.elo)} [${fmt(h.lo)}, ${fmt(h.hi)}]`);
    }
    if (ratings) {
        console.log('\nAnchored ratings (Stockfish UCI_Elo fixed):');
        for (const [n, r] of Object.entries(ratings).sort((x, y) => x[1].elo - y[1].elo)) {
            if (r.anchor) continue;
            const p = perf[n];
            console.log(`  ${n.padEnd(14)} ${fmt(r.elo)} +/- ${Math.round(1.96 * r.se)}  (${r.games} games${p ? `, ${p.ms} ms/move, ${p.nodes} nodes, depth ${p.depth}` : ''})`);
        }
        const unlinked = Object.keys(perf).filter((n) => !ratings[n]);
        if (unlinked.length) console.log(`  not linked to an anchor: ${unlinked.join(', ')}`);
    }
}

const fmt = (x) => (Number.isFinite(x) ? Math.round(x) : String(x));
