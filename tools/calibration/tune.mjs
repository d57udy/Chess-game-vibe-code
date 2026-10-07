#!/usr/bin/env node
// Re-labels an engine's ELO table from measured ratings. The engine's table defines a path through
// parameter space (eloParams(label)); the matches measured the strength M(label) at some labels.
// For each slider value S we want strength T(S) (engine Elo target, from the human-scale
// conversion), so the new row for S is eloParams(L) of the old table with M(L) = T(S).
//
//   node tools/calibration/tune.mjs --fit out/v5-default/fit.json --player v5 \
//        --engine tools/calibration/out/snap-v5a [--table old.json] \
//        --targets tables/targets.json --out tables/cand1.json
//
// targets.json: [[slider, engineEloTarget], ...] (interpolated linearly; rows are emitted at those sliders).
import fs from 'node:fs';
import { OurEngine, readEngineSources } from './lib/ours.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (i % 2 ? a : [...a, [v.replace(/^--/, ''), arr[i + 1]]]), []));
const fit = JSON.parse(fs.readFileSync(args.fit, 'utf8')).ratings;
const engine = new OurEngine(readEngineSources(args.engine || 'worktree'), args.table ? JSON.parse(fs.readFileSync(args.table, 'utf8')) : null);
const targets = JSON.parse(fs.readFileSync(args.targets, 'utf8'));
const prefix = (args.player || 'ours') + ':';

// Measured points (label -> engine Elo), made monotone (pool adjacent violators, weighted by 1/se^2).
let pts = Object.entries(fit)
    .filter(([n]) => n.startsWith(prefix) && /^-?\d+$/.test(n.slice(prefix.length)))
    .map(([n, r]) => ({ label: +n.slice(prefix.length), elo: r.elo, w: 1 / Math.max(1, r.se) ** 2 }))
    .sort((a, b) => a.label - b.label);
const blocks = [];
for (const p of pts) {
    blocks.push({ ...p, n: 1, labels: [p.label] });
    while (blocks.length > 1 && blocks[blocks.length - 2].elo >= blocks[blocks.length - 1].elo) {
        const b = blocks.pop(), a = blocks.pop();
        const w = a.w + b.w;
        blocks.push({ elo: (a.elo * a.w + b.elo * b.w) / w, w, labels: [...a.labels, ...b.labels] });
    }
}
pts = blocks.flatMap((b) => b.labels.map((label) => ({ label, elo: b.elo })));
// Ties after pooling: spread them minimally so the inverse stays defined.
for (let i = 1; i < pts.length; i++) if (pts[i].elo <= pts[i - 1].elo) pts[i].elo = pts[i - 1].elo + 1;

function labelFor(t) {
    if (t <= pts[0].elo) return { label: pts[0].label, clamped: t < pts[0].elo - 25 ? 'below' : null };
    const last = pts[pts.length - 1];
    if (t >= last.elo) return { label: last.label, clamped: t > last.elo + 25 ? 'above' : null };
    let i = 0;
    while (pts[i + 1].elo < t) i++;
    const a = pts[i], b = pts[i + 1];
    return { label: a.label + (b.label - a.label) * (t - a.elo) / (b.elo - a.elo), clamped: null };
}

const rows = [];
console.log('slider  target  old-label  nodeBudget maxDepth noise blunder miss natural');
for (const [slider, target] of targets) {
    const { label, clamped } = labelFor(target);
    const p = engine.params(label);
    delete p.timeCapMs; // the engine derives its safety cap from the node budget
    rows.push({ elo: slider, ...p });
    console.log(`${String(slider).padStart(6)} ${String(Math.round(target)).padStart(7)} ${label.toFixed(0).padStart(10)}${clamped ? ' (' + clamped + ' measured range!)' : ''}  ${p.nodeBudget} ${p.maxDepth} ${p.noiseCp} ${p.blunderChance.toFixed(3)} ${p.missCaptureChance.toFixed(3)} ${p.naturalCp}`);
}
if (args.out) fs.writeFileSync(args.out, JSON.stringify(rows, null, 2) + '\n');
