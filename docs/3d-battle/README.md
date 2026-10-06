# 3D battle mode: executive summary

Status: plan for review, 2026-10-02. No code has changed. Research behind every number is in [`research/`](research/); prices and model versions are a snapshot of that date.

## What we will build

A second, optional view of the existing chess game, tested first with a two-week throwaway spike: a rotatable 3D board seen from an RTS-style camera (pan, rotate, zoom, snap to White or Black), with 32 animated toy characters. You click a unit, see where it can go, click a square, and it turns, walks (or hops, for the knight) and settles. When it captures, attacker and victim play a short, synchronized fight on the destination square. Turns, rules and the AI stay exactly as they are today. The current 2D board stays the default and the fallback.

## Key decisions

| Topic | Decision | One-line rationale |
|---|---|---|
| Engine | **Three.js r186** (pinned `0.186.1`) loaded through an import map, no build step; `camera-controls` 3.1.2 for the camera | Fits the vanilla JS, GitHub Pages, `node --test` setup; about 0.2 MB gzip vs 1.86 MB for Babylon without a bundler; most example code for AI assistants to draw on ([Engine §1](research/engine-camera.md)) |
| Theme | **Clockwork Toybox**: Porcelain Guard (ivory, blue enamel) vs Iron Legion (black iron, orange enamel) | Rigid toy parts are the easiest thing to keep consistent and rig; defeats are mechanical (springs, gears), so no gore ([Design §2.4](research/design-choreography-production.md)) |
| Characters | **6 meshes, 1 shared humanoid skeleton, 2 palettes.** Knight is a toy lancer riding a hobby horse, rook is a wind-up tin tower golem, both bipeds. Generated meshes are split into rigid parts and bound to the skeleton in Blender (about 4 to 10 h per role for an experienced user) | One animation library covers all six roles and both armies ([Characters §0, §2.2](research/characters-animation.md)); toy styling keeps the theme ([character-consistency.md](character-consistency.md#2-reconciling-the-theme-with-the-shared-skeleton)) |
| Animation | CC0 libraries (Quaternius Universal Animation Library) first, then text-to-motion (your own output on a paid plan), then freelance keyframing for knight, rook, finishers and a few paired scenes. **No Mixamo files and no Meshy preset clips in the shipped game or the public repo.** Any Meshy clip needs retargeting to the shared skeleton | CC0 is safe in a public repo; Mixamo forbids redistributing raw files, a web game ships the files, and Meshy presets are library content with the same open question ([Characters §3.1, §6](research/characters-animation.md); [plan.md conflicts 5 and 19](plan.md#reconciled-conflicts)) |
| Fights | Composed scenes: attacker clip with a tagged impact time plus victim reaction, aligned on a "duel anchor"; 2 bespoke paired scenes in the slice, 4 on the recommended path, cap 8 | Covers all 30 attacker/victim pairings from a small library ([Design §3](research/design-choreography-production.md), [Characters §3.5](research/characters-animation.md)) |
| Generative video | **Not used for in-game characters or fights.** Used for cheap previz of fight timing (about $0.05 per second, done in the spike), a trailer, and as a fallback for concept turntables. It could upgrade today's **2D** capture scenes without any 3D (about $160 to $575 for 60 clips), but that is not this plan | A video clip is 2D pixels from one fixed camera; the game has a live, rotatable camera ([generative-video.md](generative-video.md)) |
| Consistency | A pipeline, not a prompt: style bible, one approved "golden" character, canonical turnaround sheets fed to every generation, second army by recolour, shared skeleton and materials in 3D, a scored QA rubric, archived outputs | Every vendor still drifts on details; 3D geometry is where consistency is cheapest ([character-consistency.md](character-consistency.md)) |
| 2D | Stays the default, the fallback for weak devices, missing WebGL 2 or `file://`, the accessibility mode, and (from phase 6) the 3D minimap | 2D already works, has tests and keyboard support ([Engine §2.6, §5.2](research/engine-camera.md)) |

## Cost and time by path

Owner time is "PM working with AI coding assistants", with no prior three.js or Blender experience assumed. Calendar assumes about 12 hours per week. Cash includes a 30% contingency. All figures are estimates; derivations, the labour split and the unit rates are in [plan.md](plan.md#budget).

| Path | Cash | Owner hours | Calendar | Quality ceiling |
|---|---|---|---|---|
| A. AI tools and free assets only | about $100 to $450 | about 410 to 740 h | about 34 to 62 weeks | Good placeholders, uneven knight and rook animation, 2 to 3 bespoke scenes |
| **B. Hybrid with freelancers (recommended)** | about $5k to $27k (lean scope: freelancer does the rig work, knight and rook clips, finishers, 4 bespoke scenes) | about 295 to 520 h | about 25 to 43 weeks | Consistent cast, hand-keyed knight, rook and finishers, 4 bespoke scenes |
| C. Fully freelance | about $32k to $137k | about 260 to 450 h | about 22 to 38 weeks (freelancer bound) | Highest; all clips custom |

The ranges are wide mainly because freelance per-clip rates in the research span $100 to $600 and are partly unverified. The research report's own summary totals ($10k to $25k hybrid, $25k to $60k freelance) do not match its unit rates; the plan uses recomputed figures.

The spike and the first four phases (S and 0 to 3: spike, refactor, 3D board, movement, fights with CC0 placeholders) cost the same on every path, about 125 to 205 hours and under $40. The path decision can wait until the vertical slice (phase 4) shows real costs.

## Next 7 days

1. Approve the spike (phase S in [plan.md](plan.md#phase-s-spike-prove-the-riskiest-assumptions-first)): 15 to 25 h, under $40, throwaway code.
2. Pick the two reference phones (one older Android, one iPhone).
3. Run a 30-minute USPTO and EUIPO search for a working title.
4. Subscribe to Meshy Pro for one month ($20).
5. Answer decisions 1, 3 and 6 below.

## Decisions you need to make

| # | Decision | Recommendation | Needed by |
|---|---|---|---|
| 1 | **Theme** | Clockwork Toybox, or "living carved pieces" (cheaper, less expressive) | **Now** (the spike pawn needs it); revisit at phase 4 |
| 2 | **Budget path** (A, B or C) | Approve only the spike now (under $40). At phase 4 approve $3k for the slice (its full list is about $1.5k to $7.5k; bespoke scenes only after a paid test clip). Decide the rest at the phase 4 gate | Spike now; $3k at phase 4 |
| 3 | **Public repo and commercial intent** | The repo and site are public today. If it stays public, only CC0 and paid-plan generator outputs can be committed. If you might sell the game, plan a trademark check and confirm vendor terms before release | **Now** |
| 4 | **Name** | Not "Battle Chess": Interplay holds the live US mark (Reg. 6610412) and enforced it in 2012 (TopWare) and 2021 (cancelled a third-party BATTLE CHESS registration). Working title such as "Clockwork Gambit" ([plan.md conflict 21](plan.md#reconciled-conflicts)) | Search in week 1; name before any public release |
| 5 | **Default fight pacing** | "First time Full, then Fast": each pairing plays its 2.5 to 3.5 s full scene once per player, then about 1.2 s. One setting shared with 2D ([plan.md conflicts 1 and 20](plan.md#reconciled-conflicts)) | Phase 3 |
| 6 | **Mobile scope** | 3D on desktop and recent phones, 2D automatically on weak devices. 3D required everywhere adds roughly a phase of performance work | **Now** (sets the spike's pass criteria) |
| 7 | **Tool vendors** | One image model for all reference art (for example Gemini 3 Pro Image or FLUX.2) and one 3D generator on a paid plan (Meshy recommended, Tripo as alternate). Changing vendors mid-project breaks consistency | Meshy now for the spike; image model by phase 4 |
| 8 | **Optional cinematic video mode** | No. Revisit after release if players ask | Any time |

## Reading guide

| Document | Read it for |
|---|---|
| [plan.md](plan.md) | Spike and phases, acceptance criteria, timeline, budget and labour split, risk register, asset list, reconciled conflicts |
| [architecture.md](architecture.md) | How the code changes: `applyMove()` refactor, view interface, Three.js scene, duel anchor, tests |
| [character-consistency.md](character-consistency.md) | The answer to "how do we make characters consistent?": style bible, prompts, 3D rules, QA rubric, archiving |
| [generative-video.md](generative-video.md) | What generative video can and cannot do for this game, model comparison, costs, legal |
| [research/engine-camera.md](research/engine-camera.md) | Engine comparison, camera, movement, performance, testing |
| [research/characters-animation.md](research/characters-animation.md) | 3D generators, rigging, animation sources, licensing |
| [research/generative-video-consistency.md](research/generative-video-consistency.md) | Video models, consistency techniques, costs, legal |
| [research/design-choreography-production.md](research/design-choreography-production.md) | Prior art, theme, choreography, UX, production estimates |
