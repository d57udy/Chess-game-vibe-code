# Generative video: what it can and cannot do for this game

Back to [README](README.md) · [plan](plan.md). Research basis: [research/generative-video-consistency.md](research/generative-video-consistency.md) (cited as Video), [research/characters-animation.md](research/characters-animation.md) (Characters) and [research/design-choreography-production.md](research/design-choreography-production.md) (Design). Snapshot of 2026-10-02; this field changes monthly.

## 1. Short answer

- **Video generators cannot make the characters for this game.** They output 2D pixels from one camera. The planned game has a live, rotatable 3D camera, so a video clip can only ever be a cutscene, a motion source or reference material (Video §0).
- **Recommended uses:** cheap previz of fight timing (about $9 for 30 clips), a trailer, and occasionally a turntable when an image model cannot hold a character across views.
- **Not recommended:** pre-rendered fight cutscenes as the battle system, sprites from video, world models.
- **Where video does fit:** the existing **2D** game. `battleFx.js` already plays capture scenes in an overlay layer, so generated clips (about $160 to $575 for 60, Video §4) could upgrade the 2D captures without any 3D work. That is a separate, smaller project with the consistency and keying problems listed below; it is not part of this plan.
- **Characters are built in 3D** from image-model reference sheets, on one shared skeleton, animated from libraries and keyframes ([character-consistency.md](character-consistency.md)).

## 2. Why video cannot be the character

| Constraint | Effect on this game | Source |
|---|---|---|
| Fixed camera per clip | The board camera is wherever the player left it. A clip must cut away to a fixed "arena" view and back, losing the board and the surrounding pieces | Video §2(a) |
| One sample per clip | 30 attacker/victim pairings x 2 directions = 60 clips minimum, 120 to 180 with variants; each is a fresh sample, so crowns, weapons and colours drift between clips | Video §2(a), §1.2 |
| Reference limits | Consistency features cap at a few reference images (Veo 3.1: 3, Kling 3.0: 4 per subject, Seedance 2.0 and MiniMax H3: 9 in total). Two characters in one shot use them up quickly | Video §1.2 |
| No native transparency | No commercial model outputs alpha; overlays need chroma keying, which is fragile around motion blur, sparks and dust. Safari also needs a separate HEVC-with-alpha encode | Video §1.2, §2(a) |
| Download size | About 1.5 MB per 6 s 720p clip; 60 clips about 90 MB, 180 clips up to about 540 MB (estimate) | Video §2(a) |
| Design changes | Any change to a character means regenerating and paying for every clip it appears in | Video §4 |
| Vendor churn | The Sora API was shut down on 2026-09-24 with no migration target | Video §1.1 |

In 3D, by contrast, one model and one skeleton serve every camera angle, every pairing and both armies.

## 3. Options evaluated

| Option | What you get | Fits a rotatable 3D board? | Consistency risk | Verdict | Source |
|---|---|---|---|---|---|
| (a) Pre-rendered fight cutscenes | 60 to 180 clips played as an overlay | No, must cut away | High | **Not in this plan.** Possible later as an optional "cinematic" mode | Video §2(a) |
| (b) Video as motion source (video to mocap to retarget) | 3D animation clips on your rig | Yes | Low for looks, medium for motion | **Selective**, and prefer filming a person over generating video | Video §2(b) |
| (c) Concept art and turnarounds for image-to-3D | Reference views | Yes, feeds the 3D pipeline | Controlled at sheet stage | **Use image models; video turntable only as a fallback** | Video §2(c) |
| (d) Sprites or billboards from video frames | 2.5D flipbooks | Only from a fixed angle; flat when orbiting | High | **Avoid.** If sprites are ever needed, render them from the 3D models | Video §2(d) |
| (e) World models, 4D, video to animated 3D | Interactive frames or research meshes | Not production usable in 2026 | n/a | **Avoid; re-check in 6 to 12 months** | Video §2(e) |

### Notes per option

**(a) Cutscenes.** Cheap in fees (about $160 to $575 for 60 clips, see costs), expensive in curation (30 to 60 h plus 50% for keying) and in consistency. The 2D game could use video more easily than the 3D game, since `battleFx.js` already plays scenes in an overlay layer (Video §0), but that is not the goal here.

**(b) Motion source.** Generated video adds its own physics errors (morphing limbs, weapons changing hands) that mocap reproduces faithfully, and close two-person contact is an unsolved tracking problem (Video §2(b)). The practical recipe is one performer per clip, attacker and victim filmed separately to a shared count, run through a commercial service (Move AI, DeepMotion, Uthana), then cleaned in Blender. Filming yourself on a phone works as well as generating the video. Do not use GVHMR, WHAM, TRAM or other SMPL-based research tools for shipped content: their licenses are non-commercial (Video §2(b), §5; Characters §3.3). Pose estimators also assume a human body, which is one more reason the knight and rook are bipeds in this plan.

**(c) Concept art.** Image models give exact control of pose, background and framing, which is what image-to-3D needs. Use a video turntable only when an image model cannot hold identity across separate views, then pick 4 to 8 frames (Video §2(c)).

## 4. Recommended uses in this plan

| Use | When | Model suggestion | Cost | Plan phase |
|---|---|---|---|---|
| Fight previz: one short clip per pairing to explore timing and staging before tagging clips | Phase S (3 to 5 pairings), more in phase 3 if needed | Veo 3.1 Lite, 720p, 1 take per pairing | about $0.05 per second; 5 x 6 s about $1.50, all 30 about $9 | S, 3 |
| Turntable fallback for a reference sheet | Only if an image model fails a view | Any model with first and last frame control; first frame from an approved view | under $5 per character **(estimate)** | 4 to 5 |
| Signature move reference (3 to 6 moves) | If a library lacks a move | Film a person; or generate with Kling 3.0 720p, then commercial mocap | under $20 in total (Video §4) plus 2 to 4 h cleanup per move | 4 to 5 |
| Trailer and store clips | Release | Image-to-video from **renders of the 3D models** (first and last frame), so identity comes from geometry | tens of dollars | 6 |
| Optional cinematic mode | Only after release and only if players ask | As above, rendered from 3D | $160 to $1,730 depending on model and variants (Video §4) | not planned |

## 5. Current model comparison (2026-10-02)

Condensed from Video §1.1; see the research report for all sources. Prices are list API prices; aggregator figures are marked there.

| Model | Status | Length and resolution | Consistency features | API price | License notes |
|---|---|---|---|---|---|
| Veo 3.1 / Fast / Lite (Google) | GA preview models | 4, 6 or 8 s; 720p default; 1080p and 4K at 8 s | Up to 3 reference images (not Lite); first and last frame | Standard $0.40/s, Fast $0.10 to $0.30/s, Lite $0.05 to $0.08/s | Google does not claim output ownership; SynthID watermark |
| Kling 3.0 / 3.0 Omni | GA | 3 to 15 s, up to 4K | Elements: 4 images per subject; start and end frame | about $0.084/s 720p, $0.112/s 1080p without audio | Paid plans commercial, free tier non-commercial (third-party summary) |
| Kling 4.0 / 4.0 Flash | Flash early access 2026-09-28; 4.0 "October" | up to 30 s | up to 10 images, 7 elements, 10 keyframes | not published | Specs from a reseller blog |
| Runway Gen-4.5, Gen-4 References, Act-Two | GA | 2 to 10 s | Single-image character reference; Act-Two drives a character from a performance video | $0.12/s (Gen-4.5) | Also resells Veo, Seedance, Wan |
| Luma Ray3 family | GA | 1080p, HDR | Character reference on base Ray3 only; up to 16 keyframes (Ray3.2) | about $0.54 to $2.16 per 5 s | Third-party review figures |
| MiniMax H3 | Launched 2026-07-31 | 4 to 15 s, 2K | 9 images, 3 videos | $0.13/s | Open weights announced, not published |
| Seedance 2.0 / 2.5 | GA via BytePlus, fal, OpenRouter | 4 to 15 s | 9 images, 3 videos; first and last frame | about $0.07 to $0.78/s | Check BytePlus terms per region |
| Vidu Q3 | Reference-to-video since 2026-04-13 | up to 16 s, 1080p | 1 to 4 (up to 7) references | unverified | |
| Wan 2.2 / Wan2.2-Animate | Open weights | about 5 s, 720p | Animate a character image from a driving video | self-host | **Apache 2.0**, commercial use allowed |
| LTX-2 | Open weights | up to 20 s, 4K | LoRA trainable | self-host | Free commercial use under $10M ARR |
| HunyuanVideo 1.5 | Open weights | | LoRA | self-host | **Excludes EU, UK, South Korea, including outputs: do not use** |
| Sora 2 | **Discontinued**; API off 2026-09-24 | | | | Do not plan on it |

## 6. Costs

From Video §4 (assumption there: about 4 takes per accepted clip).

| Path | Unit price | Volume | Generation cost | Human time |
|---|---|---|---|---|
| Previz only, Veo 3.1 Lite 720p, 1 take | $0.05/s | 30 x 6 s | about $9 | 5 to 10 h |
| Cutscenes, Kling 3.0 1080p | $0.112/s | 60 x 6 s x 4 takes = 1,440 s | about $160 | 30 to 60 h, +50% for keying |
| Cutscenes, Veo 3.1 Fast 1080p | $0.12/s | 1,440 s | about $175 | as above |
| Cutscenes, Veo 3.1 Standard 1080p | $0.40/s | 1,440 s | about $575 | as above |
| Cutscenes with 3 variants per pairing | | 4,320 s | about $480 to $1,730 | 90 to 150 h |
| Motion source (generate plus commercial mocap) | Kling $0.084/s, Move AI about $0.012/s | 6 moves x 4 takes x 6 s | under $20 | 12 to 24 h cleanup |
| Reference sheets with an image model | about $0.134 per image | about 200 images | about $27 | 15 to 30 h |

The fees are small in every path. Human curation and 3D cleanup are the real cost, and cutscenes have the worst reuse: every design change repeats the whole clip set (Video §4).

## 7. Legal notes

Not legal advice. Confirm with counsel before a commercial release.

| Topic | Point | Source |
|---|---|---|
| Output ownership | Google does not claim ownership of Veo and Gemini output; similar output may be generated for others. Kling: commercial use on paid plans only (third-party summary; confirm on the official terms page) | Video §5 |
| Region exclusions | HunyuanVideo and Hunyuan3D 2.1 licenses exclude the EU, UK and South Korea, including outputs; HY-Motion as well (license file cited in Characters §3.2). Excluded from this project | Video §5, Characters §6 |
| Research mocap | GVHMR weights and the SMPL and SMPL-X body models are non-commercial by default | Video §5 |
| Copyright in generated assets | The US Supreme Court denied certiorari in Thaler v. Perlmutter on 2026-03-02, leaving "human authorship required" in place. Purely generated characters may not be protectable; human modelling, editing and arrangement strengthen the claim. Keep records | Video §5 |
| Likeness and third-party IP | No real people and no existing franchise characters (including Interplay's Battle Chess designs) as references or prompts | Video §5, Design §1.3 |
| Watermarks | Veo output carries an invisible SynthID watermark that survives re-encoding; Kling free tier adds a visible one. Do not try to strip provenance markers | Video §5 |
| EU AI Act Article 50 (binding since 2026-08-02) | Disclosure duties target deep fakes; fantasy toy characters are unlikely to qualify. A short "some assets were made with AI assistance" note on the about page is cheap good practice | Video §5 |

## 8. What to re-check later

- Native alpha output in a commercial model (today only the research model Wan-Alpha, at 480p, Video §1.2).
- 4D and video-to-animated-mesh research (ActionMesh, AnimateAnyMesh++, Puppeteer and others): promising, research grade in 2026 (Video §2(e)).
- A commercial service for synchronized two-character fight motion: none was found (Characters §3.5).
- Kling 4.0 pricing and terms once published.
