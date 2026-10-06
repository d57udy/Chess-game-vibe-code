# Generative video for the battle chess characters, and how to keep them consistent

> Research snapshot as of 2026-10-02; prices and versions change. This is one of four research reports behind the [3D battle plan](../README.md). Light edits only (title, this note); content and sources are unchanged unless marked.


Research date: 2026-10-02. Every non-obvious claim has a numbered source (see the end). Claims marked **[unverified]** come from third-party blogs only or could not be confirmed on a vendor page. Prices change monthly; recheck before spending.

## 0. Short answer

1. Video generators produce 2D pixels from one camera. The planned game has a live, rotatable 3D camera. A video clip can never be "the character" in that game; at best it is a cutscene, a motion source, or concept material.
2. The most reliable path for 12 consistent 3D characters is: image models for a style bible and turnaround sheets, then image-to-3D (or hand modeling) onto **one shared humanoid skeleton**, then animation from libraries or text-to-motion, with video-to-mocap only for a few signature moves.
3. Use video generation for: previz of each fight (cheap storyboards for timing), a trailer, and optionally an "arena cutscene" mode. Avoid making 60+ generated video cutscenes the core battle system.
4. Consistency comes from a pipeline, not from a prompt: canonical reference sheets, the same reference set fed to every model, fixed prompt templates, optionally a LoRA, and in 3D a shared mesh/skeleton/material system with per-army palette swaps.

Note on the current repo: battles are presently 2D GSAP animations of cloned piece glyphs in a `.battle-layer` overlay (`battleFx.js`). A video overlay would plug into that layer easily, which is one reason option (a) looks tempting; the camera mismatch only appears once the board becomes 3D.

## 1. Video model landscape (as of 2026-10-02)

### 1.1 Comparison table

| Model (vendor) | Status | Max length / res | Character consistency features | Frame control | API price (list) | License / ownership |
|---|---|---|---|---|---|---|
| **Veo 3.1** (Google) | GA preview models `veo-3.1-generate-preview`, `-fast-`, `-lite-` [1] | 4/6/8 s; 720p default, 1080p and 4K only at 8 s; extend +7 s up to 20 times at 720p [1] | "Ingredients": up to 3 asset reference images (3.1 and 3.1 Fast only, not Lite) [1] | First and last frame [1] | Standard $0.40/s (720p/1080p), $0.60/s 4K; Fast $0.10/$0.12/$0.30; Lite $0.05/$0.08 [2] | Google does not claim ownership of generated output [3]. SynthID watermark on all output [1] |
| **Gemini Omni Flash** (Google) | Announced I/O 2026 (May 19) as Veo successor; 720p, 10 s at launch [4] **[unverified details, blog sources]** | 10 s, 720p [4] | Multimodal inputs, conversational editing [4] | n/a | Listed on Runway API at 3.4 to 30 credits/s [5] | As Gemini API terms [3] |
| **Sora 2 / 2 Pro** (OpenAI) | **Discontinued.** App closed 2026-04-26, API switched off 2026-09-24, no migration target [6][7] | (was 20 s, up to 1080p) [6] | (had Characters API) [6] | n/a | n/a | Do not plan on it |
| **Kling 3.0 / 3.0 Omni** (Kuaishou) | GA [8] | 3 to 15 s, up to 4K, multi-shot up to 5 shots [9] | Elements 3.0: up to 4 reference images per subject (front/side/back/detail) or video refs; multiple elements per scene [8][10] | Start and end frame [9] | Official API $0.084/s 720p, $0.112/s 1080p without audio; $0.126/$0.168 with audio [11] **[aggregator citing official price]** | Paid plans allow commercial use; free tier non-commercial; Kling claims no ownership [12] **[third-party summary; official API terms page did not render]** |
| **Kling 4.0 / 4.0 Flash** | Flash early access 2026-09-28; full 4.0 "October" [13] | 4.0: 3 to 30 s, up to 4K; Flash 3 to 20 s, 720p [13] | Up to 10 images + 5 videos, 7 elements; up to 10 keyframes [13] | Keyframes [13] | No published price [13] | As Kling. **[specs from a vendor-reseller blog]** |
| **Runway Gen-4.5 / Gen-4 References / Act-Two / Aleph** | GA [5][14] | Gen-4.5: 2 to 10 s [15] | Gen-4 References (single image keeps a character across lighting/location) [14]; Act-Two drives a character from a performance video (body, face, hands) [14] | Image-to-video | API $0.01/credit: gen4.5 12 cr/s ($0.12/s), gen4_turbo 5 cr/s, act_two 5 cr/s, gen4_image 5 to 8 cr/image [5] | Runway also resells Veo 3.1, Seedance 2.5, WAN3 on its API [5] |
| **Luma Ray3 / Ray 3.14 / Ray3.2** | GA; Ray3.2 released 2026-06-09 [16] | 1080p native (3.14); HDR/EXR output [16] | Character Reference on base Ray3 only, not on 3.14 [16] | Up to 16 keyframes (Ray3.2) [16] | About $0.54 to $2.16 per 5 s by resolution; HDR 2x [16] | **[third-party review site]** |
| **MiniMax H3 (Hailuo 03)** | Launched 2026-07-31 [17] | 4 to 15 s, 2K, 24 fps [17] | Up to 9 images, 3 videos, 3 audio refs [17] | n/a | $0.13/s 2K [17][18] | Open weights announced but **not published** as of Aug 2026; planned community license under $20M revenue [17] |
| **Seedance 2.0 / 2.5** (ByteDance) | GA via BytePlus, fal, OpenRouter [19][20] | 4 to 15 s (2.0) [19] | Up to 9 images, 3 video, 3 audio references, named in prompt [19]; "Character sheet" endpoint $0.18 [20] | First and last frame [20] | Approx. $0.07/s 480p to $0.78/s 4K (OpenRouter); fal standard about $0.30/s [20] | Check BytePlus terms per region **[not verified]** |
| **Vidu Q3** (ShengShu) | Reference-to-video launched 2026-04-13 [21] | Up to 16 s, 1080p [21] | 1 to 4 reference images (Mix mode), multi-entity consistency; up to 7 refs reported [21] | Camera switching [21] | Not verified | **[pricing unverified]** |
| **Pika 2.5** | GA [22] | Pikaframes up to 25 s at 1080p [22] | Weak; Pikaframes keyframes | First/last frame [22] | Via fal / Pika API [22] | **[third-party sources only]** |
| **Wan 2.2 / Wan2.2-Animate** (Alibaba) | **Open weights, Apache 2.0** [23][24] | 720p, ~5 s class | Wan2.2-Animate: animate a character image with motion from a driving video, or replace a person in a video [24] | I2V | Self-host GPU cost only | Apache 2.0 allows commercial use [24] |
| **Wan 2.5 / 2.6 / 2.7 / 3.0** | API only; weights not published (3.0 GA 2026-08-24) [25][26] | Wan 3.0 up to 30 s reported [26] | Wan 2.6: up to 3 subject references [25] | n/a | Via Alibaba Cloud, Runway (WAN3 5 to 20 cr/s) [5] | Proprietary API |
| **Wan-Alpha** (research, built on Wan) | Open source, CVPR 2026 [27] | 480x832, 81 frames, 16 fps [27] | none | n/a | Self-host | **Only model found with native RGBA (transparent) video output** [27] |
| **LTX-2 / 2.5** (Lightricks) | Open weights [28] | Up to 20 s, 4K, 50 fps, with audio [28] | LoRA trainable | I2V, keyframes | Self-host | LTX Community License: free commercial use under $10M ARR [28] |
| **HunyuanVideo 1.5** (Tencent) | Open weights [29] | 8.3B params | LoRA | I2V | Self-host | **License excludes EU, UK, South Korea** (no use of model or outputs there) [29] |

### 1.2 Cross-cutting facts that matter for a game

* **Clip length is short.** Most models cap at 8 to 15 s per generation. A capture scene (approach, strike, death) fits in 4 to 8 s, so length is not the blocker.
* **No commercial model found with native alpha output.** For overlays you either generate on a flat chroma background and key it, or use research models like Wan-Alpha (480p) [27]. Keying generated video is fragile around motion blur, sparks, dust and hair.
* **Looping** is not a native feature anywhere I checked; first frame = last frame control (Veo, Kling, Seedance, Pika) is the practical way to get idle loops [1][9][20][22].
* **Camera control** exists as prompting plus keyframes (Luma, Kling 4.0) or reference video (Seedance) [13][16][19]. None of these give a camera that the player can move at runtime.
* **Consistency features cap at a few references** (Veo 3, Kling 4 per element, Seedance 9 total, H3 9). Two characters in one fight shot use up the budget fast, and every vendor still reports drift in details (weapons, emblems, number of crenellations on a rook).
* **Vendor churn is real.** Sora 2 API was shut down nine days ago with no replacement [6][7]. Any pipeline that requires re-generation later (new character, design fix) is exposed to model retirement. Generated assets must be archived; prompts alone are not reproducible across model versions.

## 2. Fit analysis: 2D video vs an interactive 3D game

| Option | What you get | Fits a rotatable 3D board? | Consistency risk | Cost/effort | Verdict |
|---|---|---|---|---|---|
| (a) Pre-rendered fight cutscenes | 1 clip per pairing, played as overlay | No; must cut away from the live camera | High (60+ independent generations) | Low $ / medium curation | **Optional mode only** |
| (b) Video as motion source (video to mocap to retarget) | 3D animation clips on your own rig | Yes | Low for looks (looks come from 3D), medium for motion | Low $ / high cleanup labor | **Use selectively** (signature moves) |
| (c) Concept art / turnarounds for image-to-3D | Reference sheets, multi-view inputs | Yes (feeds the 3D pipeline) | Controlled at sheet stage | Low | **Recommended** (prefer image models; video turntables as fallback) |
| (d) Sprites / billboards from video frames | 2.5D flipbooks | Only from a fixed camera angle | High | Medium | **Avoid** for 3D; acceptable if game stays 2D |
| (e) World models / 4D / video-to-animated-3D | Interactive worlds or animated meshes | Not production-usable in 2026 | n/a | n/a | **Avoid** (watch list) |

### (a) Pre-rendered cutscenes

* **Count.** A king is never captured, so attacker x victim = 6 x 5 = 30 type pairings. Each pairing occurs for white attacking black and black attacking white: **60 clips** minimum. Add 2 to 3 variants per pairing to avoid repetition: 120 to 180 clips. Promotion, en passant, check flourishes add more.
* **Camera mismatch.** The live board camera is arbitrary; the clip camera is fixed. The clean way is what the 1988 Battle Chess design implied: cut or fade from the board to a fixed "arena" view, play the clip, fade back. This hides the mismatch but breaks spatial continuity (pieces leave the board), and the arena background must match across all 60+ clips, which video models do not guarantee.
* **Board context.** A clip cannot show the surrounding pieces or the actual squares. Any board-aware staging (attack from the left vs the right) needs mirrored or extra clips.
* **File size.** Rough budget: a 6 s 720p H.264 clip at about 2 Mbps is about 1.5 MB; 1080p at about 4 Mbps is about 3 MB (my estimate, encoder-dependent). 60 clips: 90 to 180 MB; 180 clips: 270 to 540 MB. Stream on demand rather than preload. Transparent overlays need VP9-alpha WebM (Chromium/Firefox) and HEVC-with-alpha for Safari, i.e. two encodes per clip.
* **Consistency.** Each clip is a new sample. Even with 3 to 4 reference images per character, expect drift in props, silhouette and palette between clips; a reviewer will notice the queen's crown differing between "queen takes rook" and "queen takes pawn". Re-generation when the design changes means re-paying for all clips.
* **Use it for:** a selectable "Cinematic battles" mode, a trailer, or a 2D version of the game. Do not make it the only way battles are shown.

### (b) Video as motion source

Pipeline: generate a fight clip (or film yourself), run monocular motion recovery, retarget to the shared skeleton, clean up in Blender.

* **Tools.** GVHMR improves on WHAM in world-grounded accuracy (W-MPJPE 276.5 vs 354.8 mm, RTE 2.0% vs 6.0%) [30]; TRAM uses SLAM plus a video transformer [30]. Commercial: Move.ai from about $0.012/s, DeepMotion credit plans about $15 to $300/month, Rokoko Vision free but jittery [31]. Uthana does video-to-motion and text-to-motion with retargeting and FBX/GLB export [32].
* **License trap.** GVHMR weights are licensed for education, research and non-profit use only [33], and the SMPL/SMPL-X body model they output is non-commercial unless licensed via Meshcapade [34]. Most open research mocap (WHAM, TRAM, 4DHumans) sits on SMPL as well. For a commercial game, use a commercial service (Move.ai, DeepMotion, Uthana) or obtain licenses.
* **Quality limits.** Close two-person contact (a sword hitting a body, grappling) is an open research problem because of mutual occlusion; methods still fail on very close interactions [35]. Expect foot sliding, jitter, interpenetration, and wrong hand/weapon contact. Generated video adds its own physics errors (limbs morphing, weapon changing hands), which mocap will faithfully reproduce.
* **Non-humanoid pieces.** Human pose estimators assume a human body. A knight as a horse, or a rook as a walking tower, will not track. Either design those pieces as humanoids (rider on foot, stone golem) or animate them by hand/procedurally.
* **Practical recipe:** capture one actor per clip (attacker and victim separately, choreographed to a shared timing), not both in one frame. That removes the occlusion problem. Video generation adds little over filming yourself on a phone for this; its value is quick choreography exploration.
* **Cheaper alternative for most moves:** library animations (Mixamo is still free and royalty-free for games but unmaintained and humanoid-only [36]; Meshy has 500+ presets and free auto-rigging [37]) and text-to-motion (Tencent HY-Motion 1.0, released 2025-12-30 [38]; Uthana [32]). Check HY-Motion's license before use, since other Hunyuan licenses exclude the EU [29][39] **[HY-Motion license not verified]**.

### (c) Concept art and turnarounds feeding image-to-3D

* Image models are better than video models for this: they give exact control of pose (A-pose/T-pose), background and framing. Use video only for a 360 turntable when a model cannot hold identity across separate views, then pick 4 to 8 frames.
* Image-to-3D options (2026): Meshy (textured image-to-3D about 30 API credits, about $0.60 on Pro; rigging and animation presets free) [37]; Tripo (auto-rig, retopology) [40]; Rodin (quad topology, no rigging) [40]; Hunyuan3D 3.x hosted with up to 8 views and paid auto-rig, while open Hunyuan3D 2.1 excludes the EU/UK/South Korea from its license [39]; TRELLIS 2 [40].
* Generated meshes usually need retopology, UV cleanup and manual weight fixes before they behave on a shared skeleton. Budget artist time.

### (d) Sprites / billboards

Rendering 8 directions x N frames from video means generating each direction separately, and consistency between directions is the hardest case for video models. Billboards also look flat when the camera orbits. Acceptable only if the game keeps a fixed or near-fixed camera. If you want 2.5D sprites, render them from the 3D models instead (perfect consistency for free).

### (e) World models, 4D, video-to-3D

* Genie 3 (DeepMind) generates interactive worlds, available via Project Genie to Google AI Ultra subscribers (launched 2026-01-29, later broadened) [41]. It renders frames; it does not export meshes, rigs or deterministic game logic. Not usable as a chess game engine or asset source.
* 4D/animated-mesh research (ActionMesh at CVPR 2026, AnimateAnyMesh++, R-DMesh, BLARM, Puppeteer) is promising but research-grade: no stable commercial API, variable topology, and limited control [42]. Re-evaluate in 6 to 12 months.

### Recommendation

1. **Build characters in 3D** with a shared humanoid skeleton. Video is not the asset format.
2. **Use image models** for the style bible and turnaround sheets; image-to-3D or a 3D artist for meshes.
3. **Animate** from libraries plus text-to-motion; use commercial video-to-mocap for 3 to 6 signature moves where a library lacks the action.
4. **Use video generation** for previz (cheap timing studies per pairing), marketing, and at most an optional cinematic mode.
5. **Avoid**: Sora (discontinued), Hunyuan open weights if you are in the EU, GVHMR/SMPL-based tools for commercial output without licenses, world models, sprite sheets from video.

## 3. Character consistency playbook

### 3.1 Style bible (write once, before generating anything)

| Element | Decide and document |
|---|---|
| Shape language | Per piece a primary silhouette shape readable at board scale: pawn small/round, rook square/blocky, bishop tall/pointed, knight angular/forward-leaning, queen tall/elegant, king broad/crowned. Silhouette must identify the piece in a black fill test |
| Proportions | Head heights per piece (e.g. pawn 3, others 5 to 6) and a height ladder: pawn < knight < bishop/rook < queen < king, matching chess value |
| Palette | Shared neutral base (skin, leather, metal) plus one army accent pair (e.g. ivory+gold vs obsidian+crimson). Hex values listed. Accents limited to fixed zones (cape, crest, trim) |
| Materials | 4 to 6 PBR materials total (painted metal, cloth, leather, stone, gem, skin), same roughness ranges for all characters |
| Signature props | One per piece, fixed design: pawn spear, rook wall shield or fortified body, bishop staff/mitre, knight lance + horse motif, queen staff/orb, king sword + crown |
| Lighting | One key/fill/rim setup and one color grade for all reference renders and all video prompts |
| Do-not list | No real people, no likeness of existing franchises (including the original Battle Chess designs), no text/logos |

### 3.2 Canonical reference sheets

For each of 6 piece types: front, 3/4, side, back, in A-pose, neutral background, same lighting, same focal length, same scale bar. Plus a close-up sheet for prop and face. Then make the opposite army by **palette swap of the same sheet** (edit model recolor), never by regenerating from scratch. That yields 12 sheets from 6 designs, and guarantees the two armies match in form.

These sheets are the single source of truth: every image, video and 3D generation receives them as references, and the QA rubric scores against them.

### 3.3 Prompt discipline

* A fixed prompt template per character: `[style tokens] + [character block, identical text every time] + [action] + [camera] + [lighting block, identical]`. Store it in the repo next to assets.
* Fixed seeds where the tool exposes them (open-weight models, some APIs). Seeds are not reproducible across model versions, so archive outputs, not just prompts.
* Change one variable at a time when iterating.

### 3.4 Image model reference features

| Tool | Mechanism | Notes |
|---|---|---|
| Midjourney V8.x | Omni Reference (`--oref`, `--ow` weight); V8.2 Edit Model takes up to 4 references (face, pose, outfit, setting) [43] | `--ow` above about 400 copies the reference; not compatible with inpainting [43]. Some users report weak identity hold [43] |
| FLUX.2 | Native multi-reference, 2 to 10 images, 4 to 6 effective [44] | FLUX.2 dev weights are non-commercial for serving the model; outputs can be used commercially; klein-4B is Apache 2.0 [44] |
| FLUX.1 Kontext | Single-image instruction editing [44] | Good for recolor (army swap) and pose edits |
| Gemini 3 Pro Image / 3.1 Flash Image | Multi-image editing; $0.134 per 1K/2K image (Pro), about $0.045 to $0.151 (3.1 Flash) [2] | Same SynthID watermark regime; output ownership per Gemini terms [3] |
| GPT Image (OpenAI) | Multi-image reference editing | Available through Runway API too (GPT Image 2.5 variant) [5] **[OpenAI page not checked]** |
| IP-Adapter / InstantID | Open adapters for SD/SDXL/Flux workflows | InstantID is face-focused, of little use for stylized armored figures |

### 3.5 Character LoRA (when references alone drift)

* Train one LoRA per piece type (6, not 12), with army colors handled by prompt or recolor. Or one "style" LoRA plus per-character LoRAs.
* Data: 15 images minimum, 25 to 40 recommended, varied poses and angles, captioned [45]. Source them from the approved reference sheets plus curated generations that passed QA. Same recipe for Wan 2.2 video LoRA via AI-Toolkit or Musubi-Tuner [45].
* Base model choice drives license: Wan 2.2 (Apache 2.0) [23], LTX-2 (free under $10M ARR) [28], FLUX.2 dev (non-commercial model license) [44].

### 3.6 Multi-reference video features (if you do make clips)

Feed the same canonical sheet to every clip: Kling Elements (4 images per element) [8], Veo 3.1 (3 asset refs) [1], Seedance 2.0 (9 images) [19], MiniMax H3 (9 images) [17], Vidu Q3 (up to 4 to 7) [21]. Prefer image-to-video from an approved first frame (posed render from your 3D models, if they exist) over text-to-video: the first frame then carries identity and the model only has to keep it. Using **first and last frame** both from approved stills bounds the drift at both ends.

Best consistency trick overall: **render the first frame from the 3D model**, then use video-to-video or image-to-video to stylize. Identity then comes from geometry.

### 3.7 3D consistency (where consistency is cheapest)

* **One base humanoid mesh + one skeleton** (Mixamo/Unreal-mannequin-compatible bone names) for all humanoid pieces; scale per piece for the height ladder. All animations then retarget across characters for free.
* **Kitbashing**: per-piece armor/prop meshes attached to shared sockets (hand_r, head, back). Variants come from swapping parts, not new characters.
* **Army swap via material, not geometry**: same meshes, two material sets or a shader with an `armyColor` uniform and a mask texture. Twelve characters, six meshes.
* **Texture atlas**: one atlas (or one per army) with a shared texel density; a single palette texture keeps colors exact.
* **Consistent lighting/post**: one environment map, one tone mapping and grade for board and battle views.
* **Non-humanoids**: knight horse and any tower-creature rook need their own rig; keep them stylistically tied by materials and palette.

### 3.8 QA rubric (score each asset 0 to 2 per row vs the canonical sheet; ship at 16+/20 with no zeros in rows 1 to 4)

| # | Criterion | 0 | 1 | 2 |
|---|---|---|---|---|
| 1 | Silhouette identifies the piece in a black fill at board scale | Ambiguous | Readable with color | Instantly readable |
| 2 | Signature prop matches sheet (shape, hand, size) | Wrong/missing | Minor deviation | Exact |
| 3 | Army palette: accents in the correct zones, hex within tolerance | Wrong army colors | Shifted hue/zone | Matches |
| 4 | Proportions/height ladder | Off by > 1 head | Slight | Matches |
| 5 | Face/helmet design | Different character | Similar | Same |
| 6 | Materials (metal vs cloth vs stone) | Wrong | Mixed | Matches |
| 7 | Style (line/shading/detail density) vs bible | Different style | Close | Same |
| 8 | Lighting/grade | Different | Close | Same |
| 9 | Temporal stability (video/animation): no morphing, popping, prop swaps | Visible morph | Brief flicker | Stable |
| 10 | Artifacts: extra fingers, merged limbs, text, watermarks | Present | Minor, fixable | None |

Process: two reviewers, side by side with the canonical sheet; keep a rejection log with the failing row to refine prompts/LoRAs.

## 4. Costs and time

Assumptions: 60 base clips (30 pairings x 2 directions), 6 s each, about 4 takes per accepted clip (based on typical acceptance rates reported by users; my assumption) [11].

| Path | Unit price | Generation volume | Est. generation cost | Human time (estimate) |
|---|---|---|---|---|
| (a) Cutscenes, Kling 3.0 1080p no audio | $0.112/s [11] | 60 x 6 s x 4 = 1,440 s | about $160 | 30 to 60 h prompting/curation/edit; +50% for chroma keying |
| (a) Cutscenes, Veo 3.1 Fast 1080p (ingredients supported) | $0.12/s [2] | 1,440 s | about $175 | as above |
| (a) Cutscenes, Veo 3.1 Standard 1080p | $0.40/s [2] | 1,440 s | about $575 | as above |
| (a) with 3 variants per pairing | | 4,320 s | about $480 (Kling) to $1,730 (Veo Std) | 90 to 150 h |
| Previz only (720p, 1 take per pairing) | Veo 3.1 Lite $0.05/s [2] | 30 x 6 s | about $9 | 5 to 10 h |
| (b) Motion source: generate + commercial mocap | Kling $0.084/s 720p [11]; Move.ai about $0.012/s [31] | 6 moves x 4 takes x 6 s | under $20 | 2 to 4 h cleanup per move, 12 to 24 h |
| (c) Reference sheets | Gemini 3 Pro Image $0.134/image [2] | 6 types x 5 views x 5 tries + recolors, about 200 images | about $27 | 15 to 30 h art direction |
| (c) Image-to-3D | Meshy about $0.60 per textured generation [37] | 6 meshes x 10 tries | about $36 (plus Pro subscription $20/mo) [37] | 40 to 120 h retopo/UV/rig fixes (main cost) |
| LoRA training (optional) | cloud GPU or fal trainer | 6 LoRAs | tens of dollars **[unverified per-run price]** | 6 to 12 h dataset prep |
| Animation from libraries / text-to-motion | Mixamo free [36]; Meshy presets free [37] | idle, walk, attack, hit, death per piece | about $0 | 20 to 40 h selection, retarget, blending |

Takeaway: generation fees are small in every path (tens to low hundreds of dollars). The cost is human curation and 3D cleanup. Path (a) has the worst cost-to-reuse ratio: every design change re-incurs the full clip set.

## 5. Legal points

* **Output ownership.** Google: "as between you and Google", generated output is yours and Google will not claim ownership; similar output may be generated for others [3]. Kling: commercial use on paid plans, free tier non-commercial [12] **[official terms page not readable; confirm before shipping]**. Open weights: Wan 2.2/Animate Apache 2.0 [23][24]; LTX-2 free under $10M ARR [28]; HunyuanVideo and Hunyuan3D 2.1 licenses exclude EU, UK, South Korea, including outputs [29][39]. FLUX.2 dev: serving the model commercially needs a license [44].
* **Copyright protection of your assets.** The US Supreme Court denied certiorari in Thaler v. Perlmutter on 2026-03-02, leaving "human authorship required" in place [46]. Purely generated characters may not be protectable, so others could copy them. Human-made modeling, editing, compositing and the selection/arrangement strengthen your claim. Keep records of human contributions.
* **Likeness and third-party IP.** Do not use real people or existing franchise characters (including Interplay's Battle Chess designs) as references. Video vendors restrict real-person generation (Veo `personGeneration` controls by region [1]).
* **Watermarks and provenance.** Veo output carries an invisible SynthID watermark [1]; SynthID survives re-encoding and cropping [47]. Sora used visible watermarks plus C2PA (moot now) [6]. Kling free tier adds a watermark; paid removes it [12]. Do not try to strip provenance markers.
* **EU AI Act Article 50** (binding since 2026-08-02): deployers must disclose AI-generated "deep fake" content; evidently artistic or fictional works get a lighter, non-intrusive disclosure regime [48]. Fantasy chess characters are unlikely to qualify as deep fakes (they do not resemble real persons), but a short credits/about-page note that some assets were AI-assisted is a cheap, low-risk practice. **[Not legal advice; confirm with counsel if the game is sold in the EU.]**
* **Research-only mocap models.** GVHMR and SMPL/SMPL-X are non-commercial by default [33][34]; outputs used in a commercial game need commercial licenses or a commercial tool.

## Sources

1. Google, Veo 3.1 in the Gemini API (models, durations, reference images, first/last frame, extension, SynthID, personGeneration): https://ai.google.dev/gemini-api/docs/veo
2. Google, Gemini API pricing (Veo 3.1 Standard/Fast/Lite, Gemini image models): https://ai.google.dev/gemini-api/docs/pricing
3. Google, Gemini API Additional Terms of Service: https://ai.google.dev/gemini-api/terms ; summary https://terms.law/ai-output-rights/gemini/
4. Gemini Omni announcements and review: https://gemini.google/overview/video-generation/ ; https://www.buildfastwithai.com/blogs/gemini-omni-flash-review-google-ai-video-model-2026
5. Runway API pricing: https://docs.dev.runwayml.com/guides/pricing/
6. Sora API status and specs: https://unifically.com/blogs/sora-api
7. Sora API shutdown 2026-09-24: https://pasqualepillitteri.it/en/news/18764/openai-sora2-api-dismessa-en ; https://www.newsbytesapp.com/news/science/sora-api-shuts-down-september-24-what-users-should-do/story
8. Kling 3.0 subject binding / Elements: https://kling.ai/blog/kling-3-subject-binding-character-consistency ; https://kling.ai/quickstart/klingai-video-3-model-user-guide
9. Kling 3.0 durations, resolution, start/end frames: https://kling.ai/quickstart/klingai-video-3-omni-model-user-guide ; https://kingy.ai/news/kling-3-0-review-a-serious-step-toward-ai-video-as-a-production-system/
10. Kling 3.0 four-image references: https://www.atlascloud.ai/blog/guides/how-to-use-kling-3.0-for-character-consistency
11. Kling API pricing: https://aireiter.com/blog/kling-3-api-pricing-guide-2026 ; https://www.cloudzero.com/blog/kling-ai-pricing/
12. Kling commercial use and ownership: https://wavespeed.ai/blog/video-model-access/can-i-use-kling-ai-api-for-commercial-projects/ ; https://kling.ai/document-api/guides/protocols/paid-service
13. Kling 4.0 / 4.0 Flash specs: https://www.atlascloud.ai/blog/tips/kling-4-flash-vs-full
14. Runway Gen-4 References, Act-Two, Aleph: https://runway.com/research/introducing-runway-gen-4 ; https://runway.com/changelog
15. Runway Gen-4.5 overview: https://www.therundown.ai/tools/runway-gen-4-5
16. Luma Ray3 family: https://genra.ai/blog/luma-ray3-complete-guide-review ; https://www.therundown.ai/tools/ray-3-2 ; https://lumalabs.ai/ray
17. MiniMax H3 (community article): https://huggingface.co/blog/ResterChed/minimax-h3-hailuo-3-0
18. MiniMax H3 pricing: https://openrouter.ai/minimax/hailuo-3
19. Seedance 2.0: https://seed.bytedance.com/en/seedance2_0 ; https://github.com/seedance-official/Seedance-2.0
20. Seedance pricing: https://openrouter.ai/bytedance/seedance-2.0 ; https://github.com/fal-ai/seedance-2.0-api
21. Vidu Q3 Reference-to-Video: https://www.prnewswire.com/news-releases/shengshu-launches-vidu-q3-reference-to-video-with-expanded-visual-and-audio-capabilities-302740489.html ; https://www.atlascloud.ai/models/vidu/q3/reference-to-video
22. Pika 2.5 / Pikaframes: https://aitoolsdevpro.com/ai-tools/pika-guide/ ; https://wavespeed.ai/models/pika/v2.2-pikaframes
23. Wan 2.2 repository: https://github.com/Wan-Video/Wan2.2
24. Wan2.2-Animate: https://huggingface.co/Wan-AI/Wan2.2-Animate-14B ; https://wan.video/blog/wan2.2-animate
25. Wan 2.5/2.6 weights status: https://fuser.studio/articles/best-open-source-video-models ; https://wan27.org/blog/wan-2-6-open-source-guide
26. Wan 3.0 status: https://www.kavel.ai/blog/wan-3-0-release-status-2026 ; https://kingy.ai/blog/wan-3-0-analysis/
27. Wan-Alpha (RGBA video): https://github.com/WeChatCV/Wan-Alpha ; https://arxiv.org/html/2509.24979v1
28. LTX-2: https://www.globenewswire.com/news-release/2026/01/06/3213304/0/en/Lightricks-Open-Sources-LTX-2-the-First-Production-Ready-Audio-and-Video-Generation-Model-With-Truly-Open-Weights.html ; https://en.wikipedia.org/wiki/LTX-2
29. HunyuanVideo 1.5 license / territory: https://huggingface.co/tencent/HunyuanVideo-1.5/blob/main/NOTICE ; https://deepwiki.com/Tencent/HunyuanVideo/5-license-and-legal
30. GVHMR vs WHAM vs TRAM: https://www.alphaxiv.org/abs/2409.06662 ; https://arxiv.org/pdf/2312.07531 ; https://arxiv.org/pdf/2403.17346
31. Video mocap tools and pricing: https://tato.studio/blog/best-ai-video-to-mocap ; https://uthana.com/resources/best-ai-motion-capture-tools
32. Uthana text/video-to-motion: https://uthana.com/ ; https://www.scenario.com/blog/uthana-video-and-text-to-motion
33. GVHMR license: https://github.com/zju3dv/GVHMR/blob/main/LICENSE
34. SMPL-X model license: https://smpl-x.is.tue.mpg.de/modellicense.html
35. Close two-person interaction reconstruction limits: https://arxiv.org/pdf/2507.02565 ; https://arxiv.org/html/2604.13581v1
36. Mixamo status 2026: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html ; https://app.cinevva.com/guides/free-character-animations-rigging
37. Meshy pricing, rigging, API: https://docs.meshy.ai/en/webapp/pricing ; https://www.meshy.ai/tutorials/meshy-credits-guide ; https://meshyiai.com/api-pricing/
38. HY-Motion 1.0: https://blog.brightcoding.dev/2026/04/04/hy-motion-10-the-revolutionary-3d-animation-tool-every-developer-needs
39. Hunyuan3D versions and license: https://triposr.org/blog/hunyuan3d-versions ; https://www.tencentcloud.com/techpedia/148273?lang=en
40. Image-to-3D comparisons: https://learn.rundiffusion.com/ai-3d-model-generators/ ; https://www.3daistudio.com/3d-generator-ai-comparison-alternatives-guide/best-image-to-3d-tools-2026
41. Genie 3 / Project Genie: https://9to5google.com/2026/01/29/google-project-genie/ ; https://en.wikipedia.org/wiki/Genie_(world_model)
42. 4D / video-to-animated-mesh research: https://remysabathier.github.io/actionmesh/ ; https://arxiv.org/pdf/2605.13838 ; https://arxiv.org/pdf/2608.31113 ; https://arxiv.org/pdf/2508.10898
43. Midjourney V8 Omni Reference: https://www.ud.hk/en/blogs/insight/article/midjourney-consistent-look-2026-08-07 ; https://miraflow.ai/blog/midjourney-v8-2-edit-model-guide-prompts-2026
44. FLUX.2 multi-reference and license: https://www.together.ai/blog/flux-2-multi-reference-image-generation-now-available-on-together-ai ; https://huggingface.co/black-forest-labs/FLUX.2-dev ; https://invideo.io/blog/flux-ai-image-generator/
45. Wan 2.2 LoRA dataset guidance: https://wan27.org/blog/wan-2-2-lora-training-guide ; https://www.stablediffusiontutorials.com/2025/10/wan2.2-lora-training.html
46. Thaler v. Perlmutter cert denied: https://www.cnbc.com/2026/03/02/us-supreme-court-declines-to-hear-dispute-over-copyrights-for-ai-generated-material.html
47. SynthID and C2PA: https://c2paviewer.com/articles/openai-google-c2pa-synthid-2026
48. EU AI Act Article 50: https://www.twobirds.com/en/insights/2026/taking-the-eu-ai-act-to-practice-understanding-the-draft-transparency-code-of-practice ; https://www.legal500.com/intelligence/european-union/technology/eu-ai-act-article-50

### Caveats

* Many 2026 pages found are aggregator or SEO blogs; vendor pages were used where reachable (Google Veo docs and pricing, Runway API pricing, GVHMR and SMPL-X licenses). Treat Kling, Luma, Vidu, Pika, Seedance prices as indicative.
* Time and take-count estimates are my own planning assumptions, not sourced figures.
