// Builds the stratified Lichess puzzle sample used by bench.mjs.
//
//   zstd -dc lichess_db_puzzle.csv.zst | node tools/puzzles/sample.mjs > tools/puzzles/sample.csv
//
// Source: https://database.lichess.org/#puzzles (CC0). The full database is never committed.
// Selection is deterministic: within each 100-point rating band, eligible puzzles are ranked by a
// seeded hash of their id and the first PER_BAND are kept, with at most MAX_THEME_SHARE of a band
// sharing the same motif theme so the sample mixes mates, forks, pins, endgames and so on.
import readline from 'node:readline';

const MIN = 400, MAX = 2900, BAND = 100;
const PER_BAND = Number(process.env.PER_BAND || 120);
const SEED = process.env.SEED || 'elo-human-v1';
const MAX_THEME_SHARE = 0.25;
// Eligibility: well-established ratings, liked by solvers, played enough.
const MAX_RD = 80, MIN_POPULARITY = 80, MIN_PLAYS = 300;
const MOTIFS = ['mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5', 'fork', 'pin', 'skewer', 'hangingPiece',
    'discoveredAttack', 'doubleCheck', 'deflection', 'attraction', 'sacrifice', 'trappedPiece', 'promotion',
    'advancedPawn', 'backRankMate', 'quietMove', 'defensiveMove', 'zugzwang', 'intermezzo', 'xRayAttack',
    'clearance', 'interference', 'capturingDefender', 'exposedKing', 'kingsideAttack', 'endgame'];

function hash(str) { // FNV-1a then a murmur finaliser, 32-bit
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}

const bands = new Map(); // band start -> [{key, line}]
let header = null, total = 0, eligible = 0;
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
    if (!header) { header = line; continue; }
    total++;
    const f = line.split(',');
    const rating = +f[3], rd = +f[4], pop = +f[5], plays = +f[6];
    if (rating < MIN || rating >= MAX || rd > MAX_RD || pop < MIN_POPULARITY || plays < MIN_PLAYS) continue;
    eligible++;
    const band = MIN + Math.floor((rating - MIN) / BAND) * BAND;
    if (!bands.has(band)) bands.set(band, []);
    const arr = bands.get(band);
    arr.push({ key: hash(SEED + f[0]), line });
    if (arr.length > PER_BAND * 40) { arr.sort((a, b) => a.key - b.key); arr.length = PER_BAND * 20; }
}

const motifOf = (line) => {
    const themes = line.split(',')[7].split(' ');
    return MOTIFS.find((m) => themes.includes(m)) || 'other';
};
// Keep only the columns the bench needs (drops GameUrl/OpeningTags/DailyDate to keep the file small).
const slim = (line) => line.split(',').slice(0, 8).join(',');
const out = ['PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes'];
const stats = [];
for (const band of [...bands.keys()].sort((a, b) => a - b)) {
    const arr = bands.get(band).sort((a, b) => a.key - b.key);
    const perMotif = new Map(), picked = [];
    for (const { line } of arr) {
        if (picked.length >= PER_BAND) break;
        const m = motifOf(line), n = perMotif.get(m) || 0;
        if (n >= Math.ceil(PER_BAND * MAX_THEME_SHARE)) continue;
        perMotif.set(m, n + 1);
        picked.push(line);
    }
    picked.forEach((l) => out.push(slim(l)));
    stats.push(`${band}: ${picked.length} picked of ${arr.length}+ eligible`);
}
process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`rows ${total}, eligible ${eligible}\n${stats.join('\n')}\n`);
