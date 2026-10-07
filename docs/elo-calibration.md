# ELO calibration of the chess AI

The AI's strength slider (300 to 2500) is meant to read as a human Lichess rapid rating. This document
describes how the slider levels were measured and re-tuned. Results are in the tables below, and the
tools are in `tools/calibration` (games against engines) and `tools/puzzles` (puzzle benchmark).

Status: final. The shipped table is `tools/calibration/tables/final2.json` (slider 400 to 2400, step 100), verified
by matches (see "Second fit" below).

## Summary

- The slider runs from 400 to 2400 in steps of 100 (`final2.json`), and the top setting is shown as "Max". Each label is
  the Lichess rapid rating the level is estimated to play at.
- Old table (commit 0187e9a): the labels were off by up to about 300 in human terms. Slider 300 played like
  about 650 rapid. Slider 1000 to 1300 played 150 to 400 above their labels. 2100 to 2500 were squeezed into
  about 100 rapid points (2210 to 2310).
- New table: every level is placed on the measured strength curve of the reworked engine (node budgets plus a
  human-like weakness model, see `battle3d/CONTRACT.md` v5). In the verification pass every level plays
  within 66 rapid of its label (19 of 21 within their 95% CI).
- The top is honest. At 1.2M nodes (about 4 s per move on a phone) the engine measures 2382 ± 35 rapid, so the
  slider stops at 2400. Reaching 2500 would need about 7M nodes (20+ s per move on a phone). The engine gains
  only about 65 Elo per doubling of nodes at the top.
- Uncertainty: the statistical error of each level is small (about ±25 to ±70 rapid). The conversion from
  engine Elo to human rapid is the dominant uncertainty: about ±150 in the middle and ±250 at the ends
  (see "Human scale" below).

## Final pass

### First fit (`tables/final.json`, slider 400 to 2300), verified

2736 fresh games (`plans/final.json`, `plans/final-top.json`, seeds 3 and 4), fitted jointly with the path, Maia
and low-ladder games (`results/final-fit.json`). The 2300 row (1.2M nodes) is identical to the path's 1.2M row, so
those games are counted too (`--alias p:2900=f:2300`). No search stopped on time.

| Slider | Target E | Measured E (95% CI) | Lichess rapid H(E) (95% CI) | Verdict |
|---|---|---|---|---|
| 400 | -157 | 151 ± 174 | 616 ± 122 | too strong |
| 500 | -14 | 268 ± 164 | 697 ± 115 | too strong |
| 600 | 129 | 349 ± 156 | 754 ± 110 | too strong |
| 700 | 272 | 500 ± 147 | 860 ± 103 | too strong |
| 800 | 414 | 589 ± 138 | 923 ± 97 | too strong |
| 900 | 557 | 761 ± 125 | 1043 ± 87 | too strong |
| 1000 | 700 | 866 ± 114 | 1116 ± 80 | too strong |
| 1100 | 843 | 906 ± 105 | 1144 ± 74 | on label |
| 1200 | 986 | 968 ± 95 | 1188 ± 67 | on label |
| 1300 | 1129 | 1191 ± 65 | 1344 ± 46 | on label |
| 1400 | 1272 | 1297 ± 52 | 1418 ± 36 | on label |
| 1500 | 1414 | 1440 ± 45 | 1518 ± 31 | on label |
| 1600 | 1557 | 1551 ± 49 | 1595 ± 34 | on label |
| 1700 | 1700 | 1734 ± 50 | 1724 ± 35 | on label |
| 1800 | 1843 | 1891 ± 51 | 1833 ± 35 | on label |
| 1900 | 1986 | 2039 ± 50 | 1937 ± 35 | +37 rapid |
| 2000 | 2129 | 2218 ± 57 | 2063 ± 40 | +63 rapid |
| 2100 | 2272 | 2349 ± 53 | 2154 ± 37 | +54 rapid |
| 2200 | 2414 | 2486 ± 55 | 2250 ± 38 | +50 rapid |
| 2300 | 2557 | 2675 ± 51 | 2382 ± 35 | +82 rapid, rounds to 2400 |

- 1100 to 1800 play at their labels.
- 1900 to 2300 play 40 to 80 rapid above their labels. That is outside the statistical CI but well inside the
  conversion band, and partly within the path's own CI.
- 400 to 1000 play 115 to 215 rapid above their labels. Their games against each other place them higher than
  the path ladder did (chain dependence, see "Caveats").

### Second fit (`tables/final2.json`, slider 400 to 2400)

`final2.json` re-reads the parameters from the final-pass measurements, which now serve as the path:
- Top: the 1.2M-node setting measures 2382 ± 35 rapid, so it is labelled 2400. The rows 1900 to 2300 are
  relabelled from the measured f:1800 to f:2300 points.
- Bottom: the weakest rows map 400 and 500 onto the path's -300 and -100 settings. They are shifted onto the
  final-pass scale by the offset measured at f:400 (+306 E).

Verified with 2832 fresh games (`plans/final2.json`, seed 5), fitted jointly with all earlier v5d, final-pass
and Maia games (`results/final2-fit.json`). The 2400 row is identical to the 1.2M-node row measured before, so its
games are reused. No search stopped on time.

| Slider | Target E | Measured E (95% CI) | Lichess rapid H(E) (95% CI) | Verdict |
|---|---|---|---|---|
| 400 | -157 | -208 ± 192 | 364 ± 134 | on label |
| 500 | -14 | -79 ± 182 | 454 ± 128 | on label |
| 600 | 129 | 35 ± 174 | 534 ± 122 | on label |
| 700 | 272 | 245 ± 161 | 682 ± 112 | on label |
| 800 | 414 | 424 ± 148 | 807 ± 104 | on label |
| 900 | 557 | 532 ± 139 | 883 ± 97 | on label |
| 1000 | 700 | 638 ± 129 | 956 ± 90 | on label |
| 1100 | 843 | 800 ± 116 | 1070 ± 81 | on label |
| 1200 | 986 | 949 ± 99 | 1174 ± 69 | on label |
| 1300 | 1129 | 1202 ± 65 | 1351 ± 45 | +51 rapid (outside statistical CI, inside conversion band) |
| 1400 | 1272 | 1265 ± 53 | 1395 ± 37 | on label |
| 1500 | 1414 | 1438 ± 45 | 1516 ± 31 | on label |
| 1600 | 1557 | 1570 ± 49 | 1609 ± 35 | on label |
| 1700 | 1700 | 1774 ± 50 | 1752 ± 35 | +52 rapid (outside statistical CI, inside conversion band) |
| 1800 | 1843 | 1856 ± 49 | 1809 ± 35 | on label |
| 1900 | 1986 | 2021 ± 49 | 1925 ± 34 | on label |
| 2000 | 2129 | 2181 ± 55 | 2037 ± 39 | on label |
| 2100 | 2272 | 2307 ± 50 | 2125 ± 35 | on label |
| 2200 | 2414 | 2410 ± 52 | 2197 ± 36 | on label |
| 2300 | 2557 | 2584 ± 53 | 2319 ± 37 | on label |
| 2400 | 2700 | 2675 ± 51 | 2382 ± 35 | on label |

Every level is within 66 rapid of its label. 19 of 21 are on their label within the 95% statistical CI. 1300 and
1700 are about 50 rapid strong, just outside their statistical CI, and far inside the ±150 conversion band.
`final2.json` is the shipped table: `DEFAULT_ELO_TABLE` in `aiPlayer.js`, slider 400 to 2400 with "Max" at 2400.
The table is in `tools/calibration/tables/final2.json`. Node budgets per move: 400: 820, 1000: 2.6k,
1500: 9k, 2000: 57k, 2200: 129k, 2300: 288k, 2400: 1.2M (about 4 s on a phone).

## Method

### Tools (offline only, never shipped)

| Tool | Version | License | Use |
|---|---|---|---|
| Stockfish | 19 (official release `sf_19`, `stockfish-macos-universal.tar.gz`, sha256 a1f0e3bc...) | GPL-3.0 | rated anchor (`UCI_LimitStrength`, `UCI_Elo` 1320 to 3190) and referee |
| lc0 + Maia | lc0 0.32.1 (Homebrew bottle, extracted), Maia weights v1.0 (github.com/CSSLab/maia-chess) | GPL-3.0 | human-pool anchor (Lichess bots maia1/5/9) |
| chess.js | 1.4.0 | BSD-2-Clause | rules, draw detection, PGN in the harness |
| Node.js | 22.19 | | harness runtime |

All of them live in `tools/calibration/.vendor/`, which is gitignored. `tools/calibration/setup.sh` installs
Stockfish, chess.js and the Maia weights. The lc0 binary is copied in by hand (or set `LC0=`). Match output
(`tools/calibration/out/`) is gitignored as well. Small fit summaries are copied to `tools/calibration/results/`.

### Stockfish as the rating anchor

`UCI_Elo` is calibrated at 120 s + 1 s and anchored to CCRL Blitz through matches against versions of the Stash
engine. Its author gives the accuracy as about ±100 Elo against CCRL (Stockfish PR #4341, and the Stockfish
wiki, "UCI & Commands"). Internally, `UCI_Elo` maps to a skill level, and the weak move is picked at search depth
`1 + int(level)` (`src/search.h`, `Skill`). The harness therefore searches to exactly that depth. This
reproduces the calibrated behaviour without depending on wall time. The lowest setting is 1320. Weaker levels
are rated through matches against our own levels (a chained ladder).

### Match harness (`tools/calibration/match.mjs`)

- Our engine is loaded into a `node:vm` context (as the browser and the tests do). Each move goes through
  `ChessAI.eloParams` + `ChessAI.searchWithParams` with the time cap lifted to 600 s. Strength therefore depends
  only on the node budget and the weakness knobs, not on machine load: across all v5 runs no search stopped on
  time. `Math.random` in the context is a seeded PRNG per game, so games between our levels replay exactly
  from their seed.
- Openings: 32 balanced mainline positions after 4 to 10 plies (`lib/openings.mjs`). Each one is played twice,
  with colours reversed.
- Adjudication by a referee, Stockfish at full strength searching 20k nodes after every ply:
  - Win: the eval stays beyond ±10 pawns for 10 consecutive plies.
  - Hard stop at 400 plies: a decisive result if the eval is beyond ±3 pawns, otherwise a draw.
  - Checkmate, stalemate, threefold repetition, 50 moves and insufficient material come from chess.js.
- Parallel `worker_threads`. Each worker owns its engine contexts and Stockfish processes. Output is
  `games.jsonl` (one record per game, with seed and per-side search stats), `games.pgn` and `summary.json`.
  Runs are resumable: re-running a plan skips finished games, and raising `games` adds more.
- Use a different `seed` for every new run of the same pairings. Otherwise games between our own levels repeat
  identically and inflate the precision.

### Rating fit (`tools/calibration/lib/elo.mjs`, `fit.mjs`)

- Joint maximum likelihood over all games under the logistic model, P(score) = 1 / (1 + 10^(-diff/400)), with
  draws counted as half a point.
- Stockfish players are fixed at their `UCI_Elo`. Every other player (our levels, Maia) is fitted.
- One virtual draw per pairing keeps 100% scores finite.
- 95% intervals come from the inverse Fisher information.
- Players not connected to an anchor through played games are reported as unlinked, not given a rating.

### From engine Elo to the slider (`tools/calibration/tune.mjs`)

1. Measure engine Elo E at points along the engine's parameter path. The path is elo-engine's table, with
   parameters interpolated between rows: node budget geometrically, the rest linearly.
2. Make the curve monotone (pool adjacent violators) and invert it.
3. Convert each slider value S to a target engine Elo using the conversion agreed with elo-human (see "Human
   scale"). Lichess rapid H = 1611 + 0.70 (E - 1573), so the target is E = 1573 + (S - 1611) / 0.70.
4. The new row for S is the path's parameter set at the point whose measured E equals the target.
5. Verify the resulting table with a fresh, independently seeded match pass (the final pass).

## Results

### Baseline: the old table (commit 0187e9a)

The old engine was time-based (fixed depth caps and wall-time budgets), so its high levels depend on machine
load. The load was high during the run (load average 12 to 15 on 16 cores). 688 games:
`tools/calibration/plans/baseline.json` and `baseline-low.json`.

| Slider | Engine Elo E (95% CI) | Lichess rapid H(E) |
|---|---|---|
| 300 | 193 ± 281 | 645 |
| 500 | 410 ± 258 | 797 |
| 700 | 762 ± 194 | 1043 |
| 850 | 919 ± 181 | 1153 |
| 1000 | 1287 ± 89 | 1411 |
| 1150 | 1350 ± 86 | 1455 |
| 1300 | 1607 ± 88 | 1635 |
| 1600 | 1917 ± 103 | 1852 |
| 1900 | 2103 ± 103 | 1982 |
| 2100 | 2430 ± 105 | 2211 |
| 2300 | 2496 ± 103 | 2257 |
| 2500 | 2576 ± 109 | 2313 |

The step from 850 to 1000 (depth 1 to 2) was a jump of about 370 engine Elo.

### Iterations

Each row below is a separate match run. The plans are in `tools/calibration/plans/`.

| Run | Engine | Games | What it showed |
|---|---|---|---|
| maia-anchor | Maia 1100/1500/1900 vs SF 1320 to 1900 | 768 | Human-pool anchor: Maia E = 1437 / 1581 / 1676 (± 47) against Lichess rapid 1533 / 1629 / 1672 |
| v5-default | first v5 table (node budgets) | 448 | strength spread too narrow at the top (2100 to 2500 within 130 E) |
| v5b-default | v5 + tactical horizon (`qsDepth`), quiet-move misses | 912 | E 263 (300) to 2487 (2500); middle levels 150 to 250 too strong in human terms |
| cand1 | v5b path relabelled | 1008 | relabel works in the middle; 900 to 1100 (depth 1 to 2) still a step; both ends out of reach |
| v5c-low | fractional depth, new weak rows -100/100 | 1856 | -100 and 100 only about 55 E apart; needed a weaker -300 row |
| v5d-path, v5d-low | frozen v5d engine (pruning + mobility, +170 E at equal nodes); full path including 600k / 1.2M / 2.4M full-strength rows | 6546 | path used for the final table (below) |
| final, final-top | `tables/final.json` | see below | verification |

### Strength of the v5d path (basis of the final table)

E per path point (`tools/calibration/results/v5d-path-fit.json`), with Maia games included:

| Path point | Nodes per move (avg used) | E (95% CI) | H(E) |
|---|---|---|---|
| row -300 | 8 | -476 ± 115 | 177 |
| row -100 | 16 | -354 ± 111 | 262 |
| row 100 | 28 | -180 ± 106 | 384 |
| row 300 | 48 | 57 ± 100 | 551 |
| row 500 | 62 | 259 ± 92 | 691 |
| row 700 | 80 | 633 ± 76 | 953 |
| 800 | 276 | 737 ± 70 | 1026 |
| 900 | 635 | 1077 ± 52 | 1264 |
| 1000 | 759 | 1204 ± 45 | 1353 |
| row 1100 | 846 | 1339 ± 31 | 1447 |
| 1200 | 1570 | 1442 ± 30 | 1519 |
| 1300 | 2416 | 1577 ± 28 | 1614 |
| row 1500 | 3874 | 1674 ± 50 | 1682 |
| 1700 | 11k | 1939 ± 60 | 1867 |
| row 1900 | 27k | 2114 ± 64 | 1990 |
| row 2100 | 70k | 2344 ± 62 | 2151 |
| row 2300 | 175k | 2454 ± 59 | 2228 |
| 300k nodes, full strength | 293k | 2490 ± 61 | 2253 |
| 600k nodes, full strength | 584k | 2564 ± 66 | 2305 |
| 1.2M nodes, full strength | 1.16M | 2608 ± 87 | 2336 |
| 2.4M nodes, full strength | 2.31M | 2723 ± 129 | 2416 |

At full strength, each doubling of the node budget adds about 65 E (about 45 rapid). Raising the budget does
not reach 2500.

## How to re-run

All commands run from the repository root. Run times are for an M4 Max with 12 workers at moderate load. Low
levels take 1 to 3 s per game, 2200 takes about 40 s, and the 1.2M-node top level takes about 170 s.

```sh
tools/calibration/setup.sh                      # Stockfish 19, chess.js, Maia weights into .vendor (gitignored)
# optional, for maia:* players: copy an lc0 binary to tools/calibration/.vendor/lc0/lc0 (or set LC0=...)

# Snapshot the engine you measure, so later edits to aiPlayer.js don't mix into a run:
mkdir -p tools/calibration/out/snap-X && cp gameLogic.js aiPlayer.js tools/calibration/out/snap-X/

# 1. Measure a path (an engine plus a table) against Stockfish/Maia anchors: about 1 h for ~2000 games
node tools/calibration/match.mjs --plan tools/calibration/plans/v5d-path.json --workers 12
node tools/calibration/fit.mjs tools/calibration/out/v5d-path/games.jsonl tools/calibration/out/maia-anchor/games.jsonl \
     --json tools/calibration/out/v5d-path/fit.json

# 2. Fit a table to targets ([[slider, engine Elo target], ...]; see tables/targets-final.json)
node tools/calibration/tune.mjs --fit tools/calibration/out/v5d-path/fit.json --player p \
     --engine tools/calibration/out/snap-v5d --table tools/calibration/tables/path-v5d.json \
     --targets tools/calibration/tables/targets-final.json --out tools/calibration/tables/final-raw.json

# 3. Verify the table with a fresh seed: about 1 h for ~2700 games
node tools/calibration/match.mjs --plan tools/calibration/plans/final.json --workers 12
node tools/calibration/match.mjs --plan tools/calibration/plans/final-top.json --workers 12
# (second iteration, the shipped table: plans/final2.json, then fit with --alias p:2900=g:2400 --alias f:2300=g:2400)
node tools/calibration/fit.mjs tools/calibration/out/final*/games.jsonl tools/calibration/out/v5d-path/games.jsonl \
     tools/calibration/out/v5d-low/games.jsonl tools/calibration/out/maia-anchor/games.jsonl --alias p:2900=f:2300

# Ad-hoc match, e.g. one level against Stockfish 1500, 64 games:
node tools/calibration/match.mjs --out tools/calibration/out/adhoc --games 64 --pair ours:1400,sf:1500
```

- Player names: `sf:<UCI_Elo>`, `maia:<1100..1900>`, `<engine>:<slider>` or `<engine>:@<preset>`. The engines are
  defined in the plan as `name: "<ref>[:<table.json>]"`, where ref is `worktree`, a git revision or a snapshot
  directory.
- `npm test` includes a quick smoke test of the harness (`tests/integration/calibrationTools.test.js`). It
  skips the parts that need Stockfish when Stockfish is absent.
- When the engine changes (search, eval or weakness model), re-measure the path. Every level shifts: the v5d
  search change alone added about +170 E at equal nodes. Then refit and verify.

## Caveats

- **Human conversion dominates the error.** The statistical CIs above are for engine Elo. Converting to Lichess
  rapid relies on three Maia bots (a narrow 1530 to 1670 rapid band), a puzzle cross-check and a slope of 0.70.
  The slope is supported by two independent routes but is extrapolated below about 1300 and above about 2000
  rapid. Read each label as ±150 rapid in the middle and ±250 at the ends.
- **Stockfish's own scale.** `UCI_Elo` is accurate to about ±100 against CCRL, by its author's estimate. The
  Stockfish 19 weak-move picker is seeded from the clock, so games against Stockfish do not replay exactly.
- **Below Stockfish's 1320 floor** the scale is chained through our own levels (8 to 10 ladder steps, 4480 extra
  games). The chain depends on its steps. With the same parameters, the final-pass ladder (steps of 100) placed
  the weakest level about 300 E higher than the path ladder (wider steps). That is outside both CIs. The low end
  is therefore uncertain beyond its statistical CI. Engine-vs-engine ladders between deliberately error-prone players may stretch or shrink the scale
  compared with how those players would score against humans. Treat the bottom of the slider as "beginner,
  roughly 400 to 700".
- **Opening book.** The 32 balanced mainlines skip the opening phase, where weak human players lose much of
  their material. The weakness model (missed captures and threats, natural-move bias) applies from move one in
  real games, so in the game app the low levels may play the opening worse than in these matches.
- **Maia bots** are opponents that humans choose to play, at instant speed. Their Lichess ratings may be biased
  by who challenges them and how.
- **Time controls.** Engine strength here has no clock (node budgets). The human target is rapid (10+ minutes).
- **Baseline** numbers are time-based and were measured under load. Use them only to compare with the old table.


<!-- human-scale:start -->
## Human scale (puzzle benchmark and conversion to Lichess rapid)

Owner: elo-human. Tools: `tools/puzzles/` (see its README). Raw summaries: `tools/puzzles/results/*.json`.

The slider is meant to read as a human Lichess rapid rating. Engine-vs-engine matches (sections above) measure an
engine Elo E on Stockfish's UCI_Elo scale. This section ties that scale to humans in two independent ways:
direct games against Maia (a human-pool anchor) and Lichess puzzles (a second, human-rated yardstick).

### Puzzle benchmark

- Data: 2661 puzzles sampled from the Lichess puzzle database (CC0, https://database.lichess.org/#puzzles),
  about 120 per 100-point band from 500 to 2700. Filters: RD <= 80, popularity >= 80, at least 300 plays,
  themes mixed (at most a quarter of a band shares one motif).
- Solving follows the Lichess rules. The first move of the line is the opponent's. Every engine move must match
  the solution, and the opponent's replies come from the line. As on Lichess, any move that mates counts as
  correct. Each level plays through `ChessAI.eloParams` + `ChessAI.searchWithParams` with a per-move seed and the
  time cap lifted, so the result depends on the node budget only and reproduces on any machine.
- Puzzle rating of a level: the rating R at which it solves 50%. This is the maximum-likelihood fit of
  P(solve) = 1 / (1 + 10^((puzzle rating - R) / 400)), the Glicko-2 expectation Lichess uses (rating deviations
  ignored; at the sample's median RD the correction factor is about 0.97). The interval is a bootstrap 90% CI.
  A free-slope fit is also reported. A human's curve has a scale of 400 by construction, so a much larger
  scale means misses that do not depend on difficulty.

### Reference players on the same puzzles

| Player | Known rating | Puzzle rating (90% CI) |
|---|---|---|
| Stockfish 19, UCI_Elo 1320 / 1500 / 1700 / 1900 / 2100 / 2400 / 2800 (depth 1 + int(skill), as in the match harness) | UCI_Elo (CCRL-anchored engine scale) | 1437 / 1618 / 1854 / 2006 / 2166 / 2398 / 2969 (each about ±35) |
| Maia 1100 ... 1900 under lc0, `go nodes 1` | Lichess bots maia1 / maia5 / maia9 (maia-1100 / 1500 / 1900): rapid 1533 / 1629 / 1672 | 1331 to 1381 for all nine networks |

For Stockfish, puzzle rating ≈ UCI_Elo + 100. Maia picks the most likely human move with no search, so it is
weak at puzzles, which reward calculation. Its puzzle rating is about 250 below its game rating, the opposite of
humans. Takeaway: the puzzle-minus-game gap depends on the kind of player, so a human offset must not be applied
to an engine without a check. That check is the second route below.

### Results per slider level (shipped table, final2)

The shipped table is `tools/calibration/tables/final2.json`, which is also `DEFAULT_ELO_TABLE` in `aiPlayer.js`.
All 21 levels from 400 to 2400 were run. Summary file: `tools/puzzles/results/final2.json`.

The run used the v5d search code with `--table final2.json`. The shipped `aiPlayer.js` differs from that only in
the table and the hint budget. A spot check on the shipped file (1059 puzzle and level pairs) gave identical
results.

Columns:
- P: the puzzle rating, with its 90% CI.
- Curve scale: the free-fit scale. A human's is 400.
- E: the engine Elo from the final match fit (`tools/calibration/results/final2-fit.json`, 95% CI).
- H(E): the agreed conversion, 1611 + 0.70 (E - 1573), giving a Lichess rapid rating.
- H(P) = P - 258: the human puzzle offset, giving a Lichess rapid rating.
- H(P) - T: the same with the tactical-engine correction T from "Conversion and why" below. T is -60 below rapid
  1300, +80 above 1700, and linear in between.
- Mate-in-1 and Hanging piece: solve rates on those motifs.

| Slider | P (90% CI) | Curve scale | E | H(E) | H(P) | H(P) - T | Mate-in-1 | Hanging piece |
|---|---|---|---|---|---|---|---|---|
| 400 | 602 (570 to 632) | 1440 | -208 ±192 | 364 | 344 | 404 | 0.28 | 0.23 |
| 500 | 632 (599 to 664) | 1326 | -79 ±182 | 455 | 374 | 434 | 0.37 | 0.22 |
| 600 | 734 (704 to 763) | 1376 | 35 ±174 | 534 | 476 | 536 | 0.52 | 0.30 |
| 700 | 838 (809 to 867) | 1239 | 245 ±161 | 681 | 580 | 640 | 0.62 | 0.32 |
| 800 | 1021 (991 to 1051) | 1159 | 424 ±148 | 807 | 763 | 823 | 0.80 | 0.45 |
| 900 | 1111 (1081 to 1141) | 1154 | 532 ±139 | 882 | 853 | 913 | 0.85 | 0.45 |
| 1000 | 1163 (1131 to 1192) | 1035 | 638 ±129 | 956 | 905 | 965 | 0.83 | 0.38 |
| 1100 | 1232 (1202 to 1265) | 1157 | 800 ±116 | 1070 | 974 | 1034 | 0.82 | 0.43 |
| 1200 | 1363 (1334 to 1398) | 1137 | 949 ±99 | 1174 | 1105 | 1165 | 0.84 | 0.51 |
| 1300 | 1504 (1474 to 1537) | 1013 | 1202 ±65 | 1351 | 1246 | 1306 | 0.94 | 0.64 |
| 1400 | 1609 (1580 to 1639) | 958 | 1265 ±53 | 1395 | 1351 | 1393 | 0.94 | 0.70 |
| 1500 | 1717 (1689 to 1748) | 928 | 1438 ±45 | 1516 | 1459 | 1463 | 0.99 | 0.68 |
| 1600 | 1869 (1837 to 1899) | 937 | 1570 ±49 | 1609 | 1611 | 1562 | 0.99 | 0.77 |
| 1700 | 1964 (1938 to 1993) | 945 | 1774 ±50 | 1752 | 1706 | 1626 | 0.99 | 0.80 |
| 1800 | 2093 (2065 to 2122) | 930 | 1856 ±49 | 1809 | 1835 | 1755 | 0.99 | 0.83 |
| 1900 | 2196 (2169 to 2224) | 881 | 2021 ±49 | 1925 | 1938 | 1858 | 0.99 | 0.83 |
| 2000 | 2272 (2244 to 2296) | 885 | 2181 ±55 | 2037 | 2014 | 1934 | 1.00 | 0.84 |
| 2100 | 2359 (2335 to 2384) | 890 | 2307 ±50 | 2125 | 2101 | 2021 | 1.00 | 0.88 |
| 2200 | 2463 (2434 to 2490) | 895 | 2410 ±52 | 2197 | 2205 | 2125 | 1.00 | 0.90 |
| 2300 | 2619 (2587 to 2646) | 872 | 2584 ±53 | 2319 | 2361 | 2281 | 1.00 | 0.93 |
| 2400 (Max) | 2723 (2690 to 2753) | 911 | 2675 ±51 | 2382 | 2465 | 2385 | 1.00 | 0.94 |

Reading:
- The puzzle route is independent of the match fit that set the table, and it agrees with the slider.
  - With the correction, H(P) - T is within ±80 of the slider value at every level from 400 to 2400.
  - Without it, H(P) is within ±65 from 1300 up and reads 40 to 125 low below 1300.
  - Puzzle ratings rise monotonically with the slider.
- The match route, H(E), is within ±66 of the slider at every level, as the table was fitted to it.
- Both routes put the levels where the slider says, well inside the conversion band (±150 in the middle, ±250 at
  the ends). The remaining uncertainty is in the conversion itself, not in the measurements.

Earlier runs, for comparison (`tools/puzzles/results/`):
- Baseline table at 0187e9a, slider 300 / 700 / 1000 / 1300 / 1600 / 1900 / 2100 / 2500: puzzle 821 / 1229 / 1664 /
  1975 / 2162 / 2326 / 2468 / 2654. It was time-based and run under heavy load. It read about 300 to 400 points too
  strong from slider 700 to 1600 (slider 1000 played at about rapid 1400).
- v5b default table, slider 300 to 2500: puzzle 921 / 1072 / 1215 / 1342 / 1597 / 1749 / 2033 / 2191 / 2344 / 2428 /
  2543 / 2577. Its engine route (H(E) = 694 ... 2251) and its puzzle route agreed within ±110 at every level, and
  T was measured there.
- final.json (an intermediate table, 400 to 2300): `results/final-v5d.json`.

### Conversion and why

Sources and confidence: H = primary source or code, M = a decent dataset, L = forum or anecdote.

1. **Engine Elo to Lichess rapid (primary).** Maia 1100 / 1500 / 1900 were played against the Stockfish anchors
   (768 games). The fit gives E = 1437 / 1581 / 1676 (±47). The Lichess bots running the same networks at
   `go nodes 1` are rated 1533 / 1629 / 1672 rapid (RD 45, 217k to 634k games; lichess.org/api/user/maia1, maia5,
   maia9; github.com/CSSLab/maia-chess). This is the only direct link to the human rating pool, and it gives
   H = 1611 + 0.70 (E - 1573). (M: bot opponents are self-selected and the anchor spans only about 140 rapid
   points, so the slope comes mostly from the cross-checks below.)
2. **Slope cross-check from puzzles.**
   - Our engine: puzzle rating rises 0.77 points per engine Elo point (baseline table, E >= 1287). Stockfish: 0.89.
   - Humans: puzzle rating rises about 1.15 per rapid point (range 1.0 to 1.2). Derivation: the chessanalysis.co
     regression (n = 2763, R = 0.815) is Chess.com rapid ≈ 0.918 puzzle - 463. That regression slope is
     attenuated by R; correcting it gives about 1.13 Chess.com points per puzzle point. ChessGoals has Chess.com
     rapid rising about 1.29 per Lichess rapid point between 1500 and 2400.
   - Combined: dH/dE ≈ 0.77 / 1.15 ≈ 0.67 to 0.77, matching the Maia slope (0.67) and the forum-grade estimate
     that engine lists stretch gaps by about 0.7 against human lists (talkchess.com/viewtopic.php?t=71053, L).
3. **Puzzle offset for humans.** Lichess puzzle rating averages 258 above Lichess rapid (chessanalysis.co, n = 2763,
   R = 0.815; M, one dataset). Claims that the gap is larger at low ratings look like regression to the mean,
   so a constant is used, with about ±100 of uncertainty.
4. **Tactical-engine correction.** Puzzles reward exactly what a searching engine is good at (short forcing lines,
   never tired, never short of time), while human puzzle ratings carry their own inflation (unlimited time, knowing
   a tactic exists). Measured on our engine, the net effect is T = H(P) - H(E):
   - about -60 at slider 300 to 1300, where the weakness model makes the engine miss easy tactics;
   - about +80 at slider 1500 to 2500, where it plays near full tactical strength.
   So the puzzle route for this engine is H ≈ P - 258 - T, with T ≈ +80 above about rapid 1700 and ≈ -60 below.
   The correction is smaller than expected because the human offset already includes most of the
   tactical-bias effect. Use the engine route as the primary number and the puzzle route as a check that the
   weakness model did not shift a level's tactics relative to its play.

Other conversions, for display only (ChessGoals, https://chessgoals.com/rating-comparison/, only 1066 Lichess rapid
profiles, M; no data below Lichess rapid 1290):

| Lichess rapid | Lichess blitz | Chess.com rapid | FIDE |
|---|---|---|---|
| 1500 | 1300 | 1100 | n/a |
| 1800 | 1625 | 1505 | about 1690 |
| 2100 | 1995 | 1915 | about 1900 |
| 2400 | 2410 | 2260 | about 2245 |

Lichess's own computer levels have no official ratings: the only published configuration is in
github.com/lichess-org/fishnet src/api.rs, and the rating estimates are forum posts (L), so they are not used.

### Is the weakness human-like on puzzles?

- First v5 table: no. At slider 300 to 900 the solve curve had a scale of about 1250, three times flatter than a
  human's. Slider 300 solved 38% of the 400 to 600 puzzles, where a human of its puzzle rating solves about
  85 to 90%. It also found 81% of mates in one but took only 14% of hanging pieces, the reverse of a beginner.
- v5b: elo-engine added a tactical-horizon knob (qsDepth), made blind moves a pure static eval, trimmed the check
  bonus, and lowered missCaptureChance. Results:
  - Hanging pieces at slider 300 rose from 0.14 to 0.42.
  - Mate-in-1 fell from 0.81 to 0.67.
  - The scale is now 900 to 1100 from slider 500 up. That is still flatter than a human. Part of the gap is
    inherent: an engine with even a small search sometimes finds hard puzzles that humans of its level never
    see, and its random oversights also cost it easy ones.
  - Slider 300 remains the least human-like (scale 1352).
- Shipped table (final2): yes for the ordering, partly for the rate.
  - Misses now scale with difficulty. At every level the solve rate falls steadily from easy to hard bands.
  - By motif, slider 1000 and up match a human of the same puzzle rating within about 5 points (short, long,
    fork, mate in one). Hanging pieces are at or above the human rate.
  - The curve is still about 3 times flatter than a human's at the bottom (scale 1240 to 1440 at 400 to 700, about
    930 from 1400 up).
    - Slider 400 (P 602): solves 20% of the 400 to 800 puzzles, where a human of P 602 solves about 41%, and 7% of
      the 1200 to 1600 puzzles, where that human solves about 1%.
    - Slider 1000 (P 1163): 67% vs 94% on the easy band, and 19% vs 3% on the 1600 to 2000 band.
  - In plain terms, low levels miss some easy tactics that a beginner of that rating would see, and now and then
    find a hard one that the beginner would not. The total comes out right, so the rating does not shift, but
    individual games feel more erratic than a human's. This is partly inherent: even a 1-ply search with a little
    capture search finds some hard tactics.
  - Mate in one is no longer too easy at the very bottom (0.28 vs about 0.24 for a human at slider 400). It is
    still easy at 600 to 800 (0.52 vs 0.36 at 600, 0.80 vs 0.65 at 800), because a mate the real search finds is
    always played. Forks are found less often than by humans at 400 to 600 (0.04 to 0.08 vs 0.10 to 0.16).
- Game blunder rates measured by elo-engine (moves losing 2+ pawns): 38% at slider 300, 7.5% at 1100, 3% at 1500.
  Published human rates are lower per move. Lichess blitz: 7.2% under 1200, 5.1% at 1200 to 1600, 3.9% at 1600
  to 2000 (github.com/arkid-lutaj/blunder-predictor, M, definition unclear). So the lowest levels blunder more
  often than the humans they stand in for.

### Caveats

- Every human link is indirect: three bot ratings, one puzzle-versus-rapid dataset, one rating-comparison site.
  Treat any slider value as ±150 rapid in the middle (1300 to 1900) and ±250 at the ends.
- Below Lichess rapid of about 1300 and above about 2000 the conversion is an extrapolation of the 0.70 slope.
  Very few rated Lichess rapid players are below 600 (the floor is 400).
- Puzzle results for the reference engines: Stockfish's weak-move noise is clock-seeded, so it does not reproduce
  exactly. The baseline table was time-limited and run under heavy machine load.
- Rerun on the shipped engine: `node tools/puzzles/bench.mjs --levels 400,500,600,...,2400 --out tools/puzzles/results/final2.json`
  (about 10 minutes on 14 workers; deterministic).
- The puzzle sample is thin below 500 and above 2700, so ratings near those ends rest on extrapolation of the
  logistic.
<!-- human-scale:end -->
