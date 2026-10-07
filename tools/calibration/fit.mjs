#!/usr/bin/env node
// Fits ratings over one or more match outputs (games.jsonl) with Stockfish UCI_Elo as fixed anchors.
//   node tools/calibration/fit.mjs out/baseline/games.jsonl [more.jsonl ...] [--anchor base:1300=1450] [--json out.json]
//        [--alias p:2900=f:2300]   (count games of one player as another with identical parameters)
import fs from 'node:fs';
import { summarize, printSummary } from './lib/report.mjs';

const files = [], extraAnchors = {}, alias = {};
let jsonOut = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--anchor') { const [n, v] = argv[++i].split('='); extraAnchors[n] = +v; }
    else if (argv[i] === '--json') jsonOut = argv[++i];
    else if (argv[i] === '--alias') { const [from, to] = argv[++i].split('='); alias[from] = to; }
    else files.push(argv[i]);
}
const rename = (n) => alias[n] || n;
const records = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)))
    .map((r) => ({ ...r, white: rename(r.white), black: rename(r.black), a: rename(r.a), b: rename(r.b) }));
const summary = summarize(records, extraAnchors);
printSummary(summary);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
