# 3D characters and animation pipeline (web, glTF, Three.js)

> Research snapshot as of 2026-10-02; prices and versions change. This is one of four research reports behind the [3D battle plan](../README.md). Light edits only (title, this note); content and sources are unchanged unless marked.


Research date: 2026-10-02. Sources are numbered [n] and listed at the end. Items marked **(unverified)** come only from third-party summaries or search snippets and should be checked on the vendor page before money is spent. Prices change often; treat all figures as snapshots.

## 0. Summary

- **Biggest lever: build 6 characters, not 12.** Generate one mesh per piece type, rig it once, and make the black army a texture/material variant of the same mesh. That gives 6 rigs, one shared humanoid skeleton convention, and every animation works for both armies.
- **Keep every piece humanoid** (on a Mixamo-compatible skeleton) so one animation library covers all six. Knight: armored warrior with a horse-head helm, or a rider bolted onto a separately animated horse. Rook: stone golem or tower-armored brute.
- **Recommended paid route:** concept images in one consistent style, then Meshy (Meshy 7.1 or T2 smart topology, built-in humanoid rig plus a 600+ preset library plus text-to-motion), or Tripo (P2.0 native quads, auto-rig, retarget), with Blender cleanup and gltf-transform compression. Estimated total cash cost for 6 characters plus animations: roughly **$40 to $150** in subscriptions (one or two months), plus about **25 to 50 hours** of hands-on work. *(Note added in this copy: §4.3 of this report gives 45 to 110 h; the plan uses the §4.3 figure.)*
- **Free route for a prototype:** KayKit (Adventurers, Skeletons, Character Animations, all CC0) or Quaternius (Universal Base Characters plus Universal Animation Library 1 and 2, CC0). These are safe to commit to a public GitHub repo.
- **Fights:** don't author 30 unique paired animations. Use one canonical "duel anchor" with a fixed attacker/victim spacing, attack clips that carry an impact time, and shared victim reactions (hit, death). Add hand-made paired showpieces only for a few signature matchups.
- **Legal:** do not commit Mixamo FBX/GLB files to a public repo. Use CC0 packs or your own paid-plan generator outputs for anything open source. Free tiers of Meshy and Tripo license outputs under CC BY 4.0 (attribution required) and are public. Hunyuan3D open weights and HY-Motion exclude the EU, UK and South Korea.

---

## 1. Generative 3D tools (state as of Oct 2026)

### 1.1 Comparison table

| Tool | Latest model / status | Topology & polycount | Texturing | Multi-view input | Part segmentation | Export | Pricing (snapshot) | Output license | API | Self-host |
|---|---|---|---|---|---|---|---|---|---|---|
| **Meshy** | Meshy 7 (Aug 13, 2026), 7.1 (Sep 18, 2026), Meshy T2 smart topology (Jul 13, 2026); meshy-5 retires Oct 10, `lowpoly` retires Oct 30, 2026 [2] | Remesh to quad or triangle, 100 to 300k faces; T2 smart topology 100 to 15k (default 4k), triangle output with natively separated parts [2][3] | PBR (metallic, roughness, normal), 2k/4k/8k [3] | Yes (Multi Image to 3D endpoint) [3] | T2 "natively separated parts"; Auto Split API (Sep 2026, aimed at printing) [2] | glb, fbx, obj, usdz, stl, 3mf [3] | Free 100 credits/mo; Pro $20/mo (1,000 cr); Studio $60/mo (4,000 cr) [1][1b]. Image to 3D: 25 cr (Meshy 7), 20 cr (Meshy 6); texture 10 cr; remesh, rigging, animation free in web app [1] | Free: CC BY 4.0; paid: private, full rights; user owns outputs [1] | Yes (REST) | No |
| **Tripo (VAST)** | P2.0 (Sep 21, 2026) native quads; Smart Mesh P1.0 (Mar 2026); H3.1 high detail [5][6][7] | P2.0: tri up to 50k, quad up to 25k faces, up to 4 LOD variants per prompt, Mesh Edit regional regen [6][7]; P1.0: tri 500 to 20k [7b] | PBR; "AI Texture" up to 8K [4] | Yes (multiview to 3D, image to multiview) [4] | Segmentation V2 (40 to 50 cr API) [4] | GLB, FBX, OBJ, USDZ [4] | Studio: Free 200 cr; Pro $20/mo annual (3,000 cr); Max $90/mo annual [8] **(unverified, pricing page blocked)**. API: $0.01/credit; image to 3D 20 to 30 cr; auto rig 25 cr; retarget 10 cr per animation [4]. Studio and API are separate products [8] | Free: public, CC BY 4.0; paid: private, full commercial rights [9] **(unverified, terms page blocked)** | Yes | No (but its research arm released UniRig, MIT) |
| **Hyper3D Rodin (Deemos)** | Gen-2 [10][11] | Quad at 4k, 8k, 18k or 50k quads; triangles up to 500k [10] | PBR or shaded; HD/4K on paid [11] | Multi-image on Creator+ [11] | Not a headline feature | GLB, FBX, OBJ, USDZ (typical) | Free: pay per download at $1.50/credit, 10 private assets; Creator $30/mo ($24 annual, about 60 models); Business $120/mo ($96 annual, about 416 models, API, high-poly quads) [11] | Terms: Deemos does not limit use of output, commercial use depends on plan [12][13] | Business+ only [11] | Enterprise on-prem only |
| **Hunyuan3D (Tencent)** | 3.0/3.1 hosted only (Pro, Rapid); open weights for 1.0, 2.0, 2.1, Omni [14][15] | Pro up to 1.5M faces (needs heavy reduction) [15] | 4K PBR (Pro); 2.1 open model has PBR texture synthesis [15][16] | Yes (multi-view on API) [15] | Not core | GLB | Third-party APIs about $0.225 to $0.375 per model [15] | Open-weight licenses exclude EU, UK, South Korea [17][18] | Yes (Tencent Cloud, fal, others) | 2.1: shape 10 GB VRAM, texture 21 GB, both 29 GB [16] |
| **Microsoft TRELLIS.2** | 4B params, Dec 16, 2025 [19] | Dense, generic topology (needs retopo) | PBR incl. transparency, up to 1536³ [19] | Single image focus | No | GLB | Free (self-host) | MIT [19] | Community wrappers | Yes, 24 GB VRAM, Linux, CUDA 12.4 [19] |
| **Stability SF3D / SPAR3D** | 2024 to 2025 models | Low/medium, fast | UV + basic material | Single image | SPAR3D point cloud editing | GLB | Free self-host | Stability Community License: free under $1M annual revenue [20][21] | Stability API | Yes |
| **Meta SAM 3D Objects** | Nov 2025 | Object reconstruction, not character oriented | Texture | Single image | Uses SAM masks | Mesh / splats | Free | SAM License, commercial allowed with AUP and trade restrictions [22] | No | Yes |
| **CSM (Cube)** | **Shut down Jan 5, 2026; acquired by Google** [23] | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| **Luma Genie** | Still available inside Luma plans [24] **(unverified)** | Low/mid | Basic | No | No | GLB etc. | Luma Plus from $30/mo [24] | Check Luma terms | Limited | No |
| **Sloyd** | Parametric / template generator, active [24] | Clean, low poly, props more than characters | Basic | n/a | Parametric parts | GLB, OBJ | Plus about $11/mo annual [24] **(unverified)** | Check terms | Yes | No |
| **Kaedim** | Human-in-the-loop service [24] | Artist cleaned | Yes | Yes | n/a | Standard | About $150 to $600/mo, about 24 h turnaround [24] **(unverified)** | Commercial | Yes | No |

### 1.2 Assessment for this project

- **Meshy** fits best overall: one product does image to 3D, smart topology at a game budget, PBR, A-pose/T-pose output, humanoid rigging, a 600+ animation preset library including a "Fighting" category, and text-to-motion [2][3][25][26]. Credit costs for rig and animation are low (rig 5 credits on API example, animation 3 credits per action) [26][27].
- **Tripo P2.0** is the strongest option if native quad topology matters (e.g. you want to hand-edit or reskin in Blender). Released 11 days ago, so expect rough edges [6][7].
- **Rodin Gen-2** gives quad meshes at fixed densities (4k/8k/18k quads suit game characters) but has no built-in rig/animation; API needs the $120 Business plan [10][11].
- **TRELLIS.2 / Hunyuan3D 2.1** are free and self-hostable but need a 24 GB+ GPU, give dense triangle soup that needs retopo, and Hunyuan's license excludes EU/UK/South Korea [16][17][19]. Useful only if you want zero vendor dependence.
- **Avoid** CSM (gone) and Kaedim (too expensive for this budget).

---

## 2. Rigging

### 2.1 Options

| Tool | Body types | Cost | Output | Notes |
|---|---|---|---|---|
| **Meshy auto rig** | API: "standard humanoid (bipedal)" only; textured GLB, ≤300k faces, facing +Z [26]. Web app marketing claims humanoid and quadruped detection [25] **(quadruped support in web app unverified)** | Free in web app [1]; about 5 credits on API [26] | FBX + GLB with walk/run | Fastest end to end |
| **Tripo auto rig** | "Various types" (no details) [4] | 25 credits API ($0.25) [4] | GLB/FBX | Retarget from 100+ presets, 10 cr each [4] |
| **Mixamo** | Bipedal humanoid only [28] | Free with Adobe account [28] | FBX (65-bone "mixamorig" skeleton) | Stagnant but working; multi-day outage June 2025 [28] |
| **AccuRIG 2.0 (Reallusion)** | Humanoid, fingers | Free, personal and commercial; free ActorCore account needed to export [29][30] | FBX, USD | Windows desktop; good finger rigs |
| **Anything World "Animate Anything"** | Quadrupeds, birds, creatures, bipeds [31] | $60/mo for 100 credits; 5 cr each for rig and animate [31] **(unverified)** | FBX, GLB, glTF | Main paid option for a horse |
| **UniRig (VAST + Tsinghua, SIGGRAPH 2025)** | Any topology | Free, MIT; ≥8 GB VRAM [32] | FBX | Custom bone names (not Mixamo); needs manual renaming for library animations [32] |
| **Blender Rigify / Auto-Rig Pro** | Any | Free / paid add-on | glTF via Blender | Most control, most manual effort |

### 2.2 Handling non-humanoid pieces

| Piece | Recommended (budget) | Higher fidelity alternative |
|---|---|---|
| Pawn | Foot soldier with spear/shield | Same |
| Knight | **Humanoid warrior in a horse-head helm and barding-style armor**, uses the shared humanoid skeleton and library | Rider + horse: horse from Quaternius Ultimate Animated Animals (CC0, has gallop, kick, attack, death) [33] or rigged via Anything World; rider is a humanoid with a "sitting/riding" pose parented to a saddle bone. Doubles animation work for every knight fight |
| Bishop | Robed cleric/mage with staff | Same |
| Rook | **Golem or giant in tower-shaped armor, still a biped** (bulky proportions retarget fine if limbs are clear) | Animated tower with arms (non-standard rig, keyframed in Cascadeur Pro or Blender) |
| Queen | Armored warrior queen | Same |
| King | Older armored king with crown and greatsword | Same |

Reason for "all humanoid": one skeleton convention means each animation clip (walk, idle, attack, hit, death) can be retargeted to all six characters with `SkeletonUtils.retargetClip` or in Blender, and the black army reuses the white army's rigs entirely. Rider plus horse is the classic battle chess look but roughly doubles knight animation work and adds a parenting/sync problem.

---

## 3. Animation sources

### 3.1 Libraries and marketplace packs

| Source | Content | License | Public GitHub repo OK? |
|---|---|---|---|
| **Mixamo** | Large humanoid library, includes sword, unarmed, hit reaction, death | Royalty-free for commercial and non-commercial projects including games; **may not redistribute raw character or animation files** as a product or asset package [34][35] | **Risky.** A web game necessarily ships the GLB files to every browser, and a public repo exposes them as files. Third-party guidance says open-source games are acceptable only if the content is "embedded, non-editable" [36] **(unverified, not an Adobe statement)**. Keep Mixamo-derived files out of the public repo. |
| **Meshy animation library** | 631 presets, 5 categories incl. Fighting / AttackingwithWeapon; 24/25/30/60 fps [25][27] | Covered by your Meshy plan (free plan: CC BY 4.0) [1] | Yes on paid plan (your output); attribution needed on free plan |
| **Tripo presets** | 100+ preset motions [4] | Per Tripo plan [9] | As above |
| **Quaternius Universal Animation Library 1 and 2** | 120+ and 130+ animations on a universal humanoid rig, Mixamo compatible, melee combos with separate hits, deaths [37][38][39] | **CC0** [37][38] | Yes |
| **KayKit Character Animations** | 133 humanoid animations: melee 1H/2H/unarmed/dual, hit reactions, deaths [40] | **CC0** [40] | Yes |
| **Synty** | Stylized packs | Subscription license, non-transferable, no IP transfer [41] | No (no redistribution of source assets) |
| **Fab (Epic) Standard License** | Large marketplace | Commercial use in projects; no standalone redistribution [42] | No for raw asset files in a public repo [42][43] |

### 3.2 Text-to-motion AI

| Tool | Notes | Cost | License |
|---|---|---|---|
| **Meshy Text to Motion** (Aug 21, 2026) | 2 to 10 s clips; `prime` (FBX) or `swift` (BVH); apply to a rigged biped via `motion_task_id` [2] | prime 10 cr, swift 3 cr; apply 3 cr [2][27] | Per plan |
| **Uthana** | Text and video to motion, auto rig, GraphQL API, JS client [44][45] | Free tier: unlimited generation, 30 download seconds/mo; pay as you go $0.02 to $0.10 per second by model version [44] | Check terms for commercial use **(unverified)** |
| **DeepMotion SayMotion** | Text to 3D animation | Free 3 credits/mo; Starter $9/mo annual; Pro $39/mo annual [46] **(unverified)** | Commercial license on paid plans [46] |
| **Tencent HY-Motion 1.0** (Dec 30, 2025) | 1B param DiT flow-matching text to motion, open weights [47] | Free self-host | Tencent Hunyuan Community license: excludes EU, UK, South Korea; >1M MAU needs a license; Tencent claims no rights in outputs [48] |
| **MDM, MotionGPT and similar research models** | Research quality, SMPL output | Free | Typically non-commercial due to SMPL body model and dataset terms; avoid for shipping |
| **Cascadeur** (2026.2, Aug 2026) | Keyframe tool with AI inbetweening, motion generation, physics, video mocap, BVH import, animation layers [49][50] | Free: non-commercial, CASC export only; Indie (<$100k revenue) and Pro add FBX/glTF export; retargeting, quadruped autoposing and AutoPhysics environment interaction are Pro only [51] | Commercial on paid plans |

### 3.3 Video-to-motion (record yourself)

| Tool | Multi-person | Cost | Notes |
|---|---|---|---|
| **DeepMotion Animate 3D** | Yes, 2 on free up to 6 to 8 on paid [46][52] | Free 60 cr/mo; Starter about $15/mo with commercial license [52] **(unverified)** | Only easy option for two-person fight capture from one video |
| **Move AI Move One** | Single person on self-serve plans; multi-person on Enterprise [53] | Free 30 credits once; Starter $18/mo; Standard $46/mo (commercial use) [53] | Gen 2 costs 2 credits per person-second [53] |
| **Rokoko Vision** | One performer per clip [54] | Single-camera free (≤15 s); dual camera with Plus $20/mo [54] **(unverified)** | Good free option for solo takes |
| **Cascadeur Video Mocap** | Single | Within Cascadeur plans [50] | Then clean in the same tool |
| **GVHMR, WHAM, 4D-Humans, TRAM** | Research | Free | Depend on SMPL, which is non-commercial; avoid for shipped content [55] |

### 3.4 Retargeting

- **Blender + Rokoko Studio Live add-on (free)**: retarget with presets for Mixamo and UE mannequins; character should be in T-pose [56][57].
- **three.js `SkeletonUtils.retargetClip(target, source, clip, options)`**: options include `names` (target to source bone map), `hip`, `hipInfluence`, `scale`, `trim`, `useFirstFramePosition`, `preserveBonePositions` [58]. There are known issues (off-by-one frame, twisting) [59][60], so prefer **offline retargeting in Blender** and ship per-character clips, or ensure all characters share identical bone names and rest poses so clips can be shared without retargeting at runtime.
- Practical rule: if every character is rigged by the same tool (all Meshy, or all Mixamo-convention bones), clips usually transfer directly when bone names match and rest poses are similar.

### 3.5 Paired, synchronized two-character fights

The problem: attacker and victim clips are authored separately, so blade contact, distance and timing will not line up unless both clips share an origin, a spacing and an impact frame. Games solve this with "paired" or "synced" animations that snap both characters to an alignment point [61].

Ways to get paired content:

1. **Canonical duel anchor (recommended, cheapest).** Define in code: both characters stand on a line through the anchor, facing each other, at `reach[attackerType]` distance. All attack clips are in-place (no root motion) and carry `impactTime` metadata. At impact, start the victim's `hit` or `death` clip. 6 attack clips (or 2 variants each) × shared reactions (hit front, death front, death heavy) covers all 30 pairings. Slight per-pairing variety comes from choosing reaction variants by attacker weight class.
2. **Author pairs in one Blender or Cascadeur scene.** Import both rigs, keyframe or adjust library clips so contact lines up, export each rig's action with the same frame range, and record the relative offset. At runtime parent both to a `pairAnchor` group placed on the target square. Cascadeur Pro adds AutoPhysics interaction [51]. Reserve for 3 to 6 showpiece matchups (e.g. queen vs king).
3. **Two-person mocap.** Record two people sparring on one phone video and run DeepMotion multi-person tracking [52]. Contact is approximate; expect cleanup for hand/weapon contact and foot sliding.
4. **AI two-person generation.** Research models like InterGen produce two-person interactions from text but are CC BY-NC-SA 4.0 (non-commercial) [62]. No commercial text-to-paired-fight service was found in this research **(gap, verify if needed)**.

---

## 4. Recommended pipeline

### 4.1 Step by step (paid route, Meshy primary, Tripo as alternate)

**Step 1. Style bible (2 to 4 h, $0 to $20).** Pick one art direction (e.g. stylized low-poly fantasy, chunky proportions, readable silhouettes from a top-down chess camera). Generate concept images for 6 pieces with one image model, using a fixed style prompt, same lighting, neutral background, full body, **A-pose**, front plus side plus back views. Each piece's silhouette must still read as its chess piece (crown, mitre, tower, horse-head, etc.).

**Step 2. Generate meshes (1 to 2 h per piece, about 50 to 150 credits per piece).** Meshy Multi Image to 3D with `ai_model: meshy-7.1` for detail or `meshy-t2` for smart topology, `pose_mode: a-pose`, `enable_pbr: true`, texture 2k, target 8k to 15k faces [2][3]. Do 2 to 4 attempts per piece and keep the best. Alternate: Tripo P2.0 quad mode at about 10k to 20k quads [6].

**Step 3. Black army variant (0.5 h per piece, about 10 to 30 credits).** Re-texture the same mesh (Meshy AI texturing, 10 credits) [1] or swap materials in Blender (darker metals, different cloth color). Same mesh, same rig, so no extra rigging.

**Step 4. Blender cleanup (2 to 4 h per piece, free).**
- Apply transforms; scale to meters (character about 1.6 to 2.0 m tall, or normalize all to the same height and scale in-engine); feet at origin; face **+Z** (glTF forward, also required by Meshy rigging) [26].
- Merge by distance, remove floaters/internal faces, fix normals, check symmetry.
- If needed, Decimate (Collapse) or remesh to the budget; for quads, Tripo P2.0 or Rodin quad output avoids this.
- Check UVs; if broken, Smart UV Project and bake the original textures (base color, normal, ORM) from the high-poly to the low-poly at 1024 or 2048.
- One material per character where possible; pack occlusion/roughness/metallic into one ORM texture.
- Naming: `piece_<type>_<army>.glb`, mesh `Body`, materials `M_<type>_<army>`, clips `Idle`, `Walk`, `Attack_A`, `Hit`, `Death`, `Victory`.

**Step 5. Rig (0.25 to 1 h per piece).** Meshy auto rig (free in web app) [1] or Mixamo/AccuRIG for a standard humanoid skeleton [28][29]. Check deformation at shoulders, hips, armor plates and capes; fix weights in Blender if needed (stiff armor pieces can be parented rigidly to one bone).

**Step 6. Animations per piece (about 8 clips each).** Idle, Walk (in place, root motion removed), Attack (1 to 2 variants), Hit, Death, Victory, optional Block/Taunt.
- First pull from the Meshy library (Fighting category) or Quaternius/KayKit CC0 [25][37][40].
- Fill gaps with Meshy text-to-motion (10 credits per prime clip) or Uthana [2][44].
- Edit timing, weapon contact and impact frames in Blender (NLA) or Cascadeur Indie/Pro [51].
- Time: about 0.5 to 1.5 h per clip including cleanup; about 50 clips total for 6 pieces → **25 to 60 h**.

**Step 7. Export glTF (Blender glTF 2.0 exporter).** Format: glTF Binary (.glb); Include: selected objects; Transform: +Y up; Mesh: apply modifiers, UVs, normals, tangents only if normal maps need them; Skinning: on, max 4 influences; Animation: export all actions (or NLA tracks) as separate clips, "Always sample animations" on, sampling rate 30 fps; disable shape keys unless used. Export once per piece with all clips. (Exporter options are documented in the Blender manual [63].)

**Step 8. Compress (gltf-transform CLI) [64].**
```
gltf-transform optimize in.glb out.glb --compress meshopt --texture-compress ktx2
# or, finer control:
gltf-transform resize in.glb tmp.glb --width 1024 --height 1024
gltf-transform uastc tmp.glb tmp2.glb --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture}" --level 4 --rdo --zstd 18
gltf-transform etc1s tmp2.glb tmp3.glb --quality 255
gltf-transform meshopt tmp3.glb out.glb
```
Meshopt also compresses animation keyframes, which Draco does not [64][65], so meshopt is the better default for animated characters. In Three.js, register `MeshoptDecoder` and `KTX2Loader` on the `GLTFLoader`. WebP is a simpler alternative to KTX2 if GPU memory is not a concern [65].

**Step 9. Validate.** Run the Khronos glTF Validator (web or CLI) [66] and `gltf-transform inspect` for size, texture and animation stats. Load each GLB in a Three.js test scene (or gltf-viewer) to check every clip, scale, facing and the black/white variants side by side.

### 4.2 Quality bar checklist (per character)

- [ ] Reads clearly as its chess piece from the default camera at board scale
- [ ] Same visual style, proportions and lighting response as the other 5
- [ ] 5k to 15k triangles; 1 material (2 max); textures ≤ 2048 (1024 preferred)
- [ ] Skeleton ≤ about 70 bones, ≤ 4 weights per vertex, consistent bone names across all pieces
- [ ] Feet on ground at origin, faces +Z, uniform scale, transforms applied
- [ ] No floating geometry, inverted normals, visible texture seams, or interpenetrating armor during clips
- [ ] All clips in place, loop cleanly where needed (Idle, Walk), no foot sliding beyond tolerance
- [ ] Attack clip has a documented impact time; Death ends in a stable pose
- [ ] Compressed GLB ≤ about 1.5 to 3 MB per character including all clips
- [ ] Passes Khronos validator with no errors
- [ ] License source recorded per asset (generator plan, pack, URL) in an `ASSETS_LICENSES.md`

### 4.3 Cost and time estimate (paid route)

| Item | Cost | Time |
|---|---|---|
| Concept images (any image model you already have) | $0 to $20 | 2 to 4 h |
| Meshy Studio for 1 month ($60, 4,000 credits) or Pro for 2 months ($40, 2,000 credits) [1] | $40 to $60 | |
| 6 meshes × 3 attempts × 25 credits + texture variants | about 600 to 900 credits | 6 to 12 h |
| Rigging (Meshy free in web app) | $0 | 2 to 6 h |
| About 50 clips: library free; about 15 text-to-motion clips × 13 credits | about 200 credits | 25 to 60 h incl. cleanup |
| Optional Cascadeur Indie (1 month) for paired fights [51] | about $16 to $19 | 5 to 15 h |
| Optional Tripo Pro month for P2.0 quads [8] | about $20 to $30 | |
| Blender, gltf-transform, glTF Validator | $0 | 6 to 12 h |
| **Total** | **about $40 to $150** | **about 45 to 110 h** |

Per character: about $7 to $25 and 7 to 18 h including its 8 clips. Per animation clip: $0 (library) to about $0.20 (text-to-motion credits), 0.5 to 1.5 h of cleanup.

---

## 5. Free / CC0 fallback route (prototype in 1 to 3 days)

| Asset | Use for | License | Link |
|---|---|---|---|
| KayKit Character Pack: Adventurers (knight, barbarian, mage, rogue; rigged, 75 anims, 25+ weapons, glTF) | King/queen/bishop/pawn base bodies | CC0 [67] | https://kaylousberg.itch.io/kaykit-adventurers , https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0 |
| KayKit Character Pack: Skeletons (4 rigged skeletons, weapons) | The black army, or a whole undead side | CC0 [68] | https://kaylousberg.itch.io/kaykit-skeletons , https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0 |
| KayKit Character Animations (133 clips: melee, hit, death) | All combat clips for KayKit rigs | CC0 [40] | https://kaylousberg.com/game-assets/character-animations , https://kaylousberg.itch.io/kaykit-character-animations |
| Quaternius Universal Base Characters (6 bodies, about 13k tris, glTF) | Neutral humanoid bases | CC0; standard tier free, source tier paid [69] | https://quaternius.com/packs/universalbasecharacters.html |
| Quaternius Universal Animation Library 1 and 2 (120+ / 130+ clips, Mixamo compatible) | Locomotion, melee combos, deaths | CC0; free standard tier, paid source tier with .blend [37][38] | https://quaternius.com/packs/universalanimationlibrary.html , https://quaternius.com/packs/universalanimationlibrary2.html |
| Quaternius Ultimate Animated Animals (incl. horse and white horse, attack/death/gallop) | Knight's horse | CC0 [33] | https://quaternius.com/packs/ultimateanimatedanimals.html |
| Kenney Animated Characters 1 to 3 (idle, jump, run only) | Placeholder only | CC0 [70] | https://kenney.nl/assets/animated-characters-protagonists |

Fastest prototype: KayKit Adventurers (white) + KayKit Skeletons (black) + KayKit Character Animations. All share KayKit's rig, so no retargeting is needed, and everything is CC0 and safe to commit. Piece identity comes from weapons/accessories and a tinted material per side. Quaternius tier prices vary between pages; confirm on the site before buying **(unverified)**.

---

## 6. Legal

| Source | Who owns output | Commercial use | Attribution | Public repo / open source |
|---|---|---|---|---|
| Meshy free | User owns; licensed CC BY 4.0, public [1] | Yes, with attribution [1] | Required | OK with attribution |
| Meshy paid | User, private license [1] | Yes | No | OK |
| Tripo free | Public, CC BY 4.0; one source says Tripo retains rights on free plan [9] **(conflicting, verify terms)** | Disputed | Required | Avoid; use paid plan |
| Tripo paid | User holds all rights [9] **(unverified)** | Yes | No | OK |
| Rodin | Deemos does not limit output use; rights depend on plan [12][13] | Paid plans | Check | OK on paid plan |
| Hunyuan3D 2.x open / HY-Motion | Tencent claims no rights in outputs (HY-Motion) [48] | Yes, but not in EU/UK/South Korea; >1M MAU needs license [17][48] | License + notice when redistributing weights | Outputs usable outside excluded territories; risky if players/devs are in EU/UK |
| TRELLIS.2 | n/a (MIT model) [19] | Yes | MIT notice for code | OK |
| SF3D / SPAR3D | Community License [20][21] | Under $1M revenue | Per license | OK |
| Mixamo | Adobe content, royalty-free use [34] | Yes, in projects | No | **Do not commit raw files** [34][35] |
| CC0 packs (KayKit, Quaternius, Kenney) | Public domain dedication | Yes | No | OK |
| Synty, Fab Standard | Licensed, not owned [41][42] | Yes in shipped product | No | **No** raw assets in public repo |

Additional points:

- **Copyright in AI outputs.** The US Copyright Office (Part 2 report, Jan 29, 2025) says purely AI-generated material without sufficient human authorship is not copyrightable; human selection, arrangement and modification can be [71][72]. Practical effect: others could probably reuse your raw generated meshes; your Blender edits, composition and code remain protectable. This does not block shipping.
- **Training data.** Commercial generators do not fully disclose training data. Avoid prompting with trademarked or copyrighted characters (e.g. existing game or film designs). Keep your own concept images as the inputs and archive them.
- **Repo hygiene.** If the game repo is public: commit only CC0 assets and your own paid-plan generator outputs. Keep Mixamo, Synty and Fab files out (git-ignored, loaded from a private bucket, or not used). Add `ASSETS_LICENSES.md` listing each file, its source, plan and license, plus any CC BY 4.0 credit lines.
- **Plan timing.** Generate final assets while subscribed to a paid plan; outputs made on free tiers carry CC BY 4.0 and are public. Whether upgrading later re-licenses earlier free outputs was not confirmed **(unverified)**.

---

## 7. Open questions and gaps

- Tripo pricing and terms pages returned HTTP 403 to the fetcher; Tripo figures come from third-party summaries and Tripo's developer page.
- Meshy quadruped rigging: API docs say humanoid only [26]; marketing pages say quadruped too [25]. Test before relying on it for a horse.
- No commercial AI service for synchronized two-character combat was confirmed.
- Mixamo's position on open-source repos rests on secondary sources; Adobe's FAQ page blocked the fetcher.

---

## Sources

1. Meshy pricing and credits docs: https://docs.meshy.ai/en/webapp/pricing  
1b. Meshy plan prices (third-party summary): https://www.gamsgo.com/blog/meshy-ai-cost , https://aitrendtool.com/tools/meshy
2. Meshy API changelog: https://docs.meshy.ai/en/api/changelog
3. Meshy Image to 3D API: https://docs.meshy.ai/en/api/image-to-3d
4. Tripo developer platform (API pricing, models): https://developers.tripo3d.ai/en
5. Tripo P2.0 blog: https://www.tripo3d.ai/blog/tripo-p2-0-preview
6. VoxelMatters, Tripo P2.0 launch (Sep 21, 2026): https://www.voxelmatters.com/tripo-ai-launches-p2-0-model-to-generate-native-quad-meshes-for-production-pipelines/
7. Digital Production, Tripo P2.0 test: https://digitalproduction.com/2026/09/29/tripo-p2-0-put-quad-mesh-generation-to-the-test/  
7b. Tripo Smart Mesh P1.0: https://www.tripo3d.ai/blog/introducing-smart-mesh-v1 , https://aiwiki.ai/wiki/tripo_p1
8. Tripo plan summary (third party): https://www.therundown.ai/tools/tripo-ai , https://www.media.io/comparison/tripo-ai-review.html
9. Tripo commercial use help and blog: https://www.tripo3d.ai/help/privacy-policy/how-to-use-tripo-models-commercially , https://www.tripo3d.ai/blog/commercial-use-ai-3d-models , https://medium.com/@theovarn/tripo-ai-review-2026-fast-3d-models-tight-free-tier-a8d140045f4a
10. Rodin Gen-2 on Scenario: https://www.scenario.com/models/rodin-gen-2 ; API spec: https://developer.hyper3d.ai/api-specification/rodin-generation-gen2
11. Hyper3D pricing: https://hyper3d.ai/pricing
12. Hyper3D terms: https://hyper3d.ai/legal/terms
13. Rodin review summary: https://www.therundown.ai/tools/rodin
14. Hunyuan3D versions overview: https://triposr.org/blog/hunyuan3d-versions
15. Hunyuan 3D API summaries: https://www.3daistudio.com/Platform/API/Hunyuan3D , https://wavespeed.ai/blog/posts/hunyuan-3d-api/ , https://costgoat.com/pricing/hunyuan-3d
16. Hunyuan3D-2.1 GitHub: https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
17. Hunyuan3D-2.1 license: https://huggingface.co/tencent/Hunyuan3D-2.1/blob/main/LICENSE
18. Hunyuan3D-2 license: https://huggingface.co/tencent/Hunyuan3D-2/blob/main/LICENSE
19. TRELLIS.2-4B model card: https://huggingface.co/microsoft/TRELLIS.2-4B ; repo: https://github.com/microsoft/TRELLIS.2
20. Stable Fast 3D model card: https://huggingface.co/stabilityai/stable-fast-3d
21. Stability AI license: https://stability.ai/license
22. SAM 3D Objects license: https://github.com/facebookresearch/sam-3d-objects/blob/main/LICENSE
23. CSM shutdown and Google acquisition: https://www.aicerts.ai/news/google-ai-acquisition-boosts-spatial-3d-strategy/ , https://app.cinevva.com/guides/ai-3d-model-generators
24. Luma/Sloyd/Kaedim summaries: https://www.layer3labs.io/guides/is-luma-ai-worth-it , https://ziva.sh/blogs/best-ai-3d-asset-generators
25. Meshy animation library and rigging blog: https://www.meshy.ai/animation-library , https://www.meshy.ai/blog/best-ai-auto-rigging-tool
26. Meshy Rigging API: https://docs.meshy.ai/en/api/rigging
27. Meshy Animation API: https://docs.meshy.ai/en/api/animation
28. Meshy on Mixamo status: https://www.meshy.ai/blog/mixamo-alternative
29. AccuRIG 2.0: https://www.cgchannel.com/2025/07/rig-and-animate-3d-characters-for-free-with-accurig-2-0/
30. AccuRIG FAQ: https://actorcore.reallusion.com/learn-and-support/faq/accurig
31. Anything World: https://app.anything.world/animation-rigging , https://app.cinevva.com/guides/free-character-animations-rigging
32. UniRig: https://github.com/VAST-AI-Research/UniRig
33. Quaternius Ultimate Animated Animals: https://quaternius.com/packs/ultimateanimatedanimals.html
34. Mixamo FAQ: https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html (fetch blocked; terms quoted via [35])
35. Mixamo licensing summary: https://renderedinfluence.com/notes/adobe-mixamo-and-substance-3d-character-tooling-documentation/ , https://community.adobe.com/questions-696/mixamo-faq-licensing-royalties-ownership-eula-and-tos-589400
36. Mixamo in open-source games discussion: https://community.adobe.com/questions-617/can-i-use-mixamo-in-open-source-game-448304
37. Quaternius Universal Animation Library: https://quaternius.com/packs/universalanimationlibrary.html
38. Quaternius Universal Animation Library 2: https://quaternius.com/packs/universalanimationlibrary2.html
39. UAL on itch.io: https://quaternius.itch.io/universal-animation-library
40. KayKit Character Animations: https://kaylousberg.com/game-assets/character-animations
41. Synty subscription licence: https://syntystore.com/pages/standard-subscription-licence
42. Fab Standard License: https://www.fab.com/eula
43. Epic forum on GitHub distribution of Fab assets: https://forums.unrealengine.com/t/github-project-distribution-and-free-fab-assets/2665655
44. Uthana pricing: https://uthana.com/pricing
45. Uthana JS client: https://github.com/Uthana/uthana-js-client
46. DeepMotion pricing summary: https://www.saasworthy.com/product/deepmotion
47. HY-Motion 1.0 model and paper: https://huggingface.co/tencent/HY-Motion-1.0 , https://arxiv.org/html/2512.23464v1
48. HY-Motion license: https://huggingface.co/tencent/HY-Motion-1.0/blob/main/LICENSE.txt
49. Cascadeur 2026.2: https://www.cgchannel.com/2026/08/nekki-releases-cascadeur-2026-2-with-animation-layers/
50. Cascadeur AI tools help: https://cascadeur.com/help/category/285
51. Cascadeur plans: https://cascadeur.com/plans
52. DeepMotion plan summary: https://techshark.io/tools/deepmotion/
53. Move AI pricing: https://docs.move.ai/knowledge/move-one-pricing
54. Rokoko Vision: https://www.cgchannel.com/2023/09/check-out-free-browser-based-ai-mocap-tool-rokoko-vision/ , https://us.fitgap.com/products/052529/rokoko-video
55. GVHMR repo (SMPL dependency): https://github.com/zju3dv/GVHMR
56. Rokoko Blender retargeting: https://support.rokoko.com/hc/en-us/articles/4410463481489-Retarget-an-animation-in-Blender
57. Rokoko add-on repo: https://github.com/Rokoko/rokoko-studio-live-blender
58. three.js SkeletonUtils docs: https://threejs.org/docs/pages/module-SkeletonUtils.html
59. retargetClip off-by-one issue: https://github.com/mrdoob/three.js/issues/25288
60. retargetClip fixes discussion: https://discourse.threejs.org/t/fixing-skeletonutils-retarget-and-retargetclip-functions/65149
61. Paired animation explainer: https://critpoints.net/2020/03/24/what-the-fuck-is-paired-animation/
62. InterGen: https://tr3e.github.io/intergen-page/
63. Blender glTF exporter manual: https://docs.blender.org/manual/en/latest/addons/import_export/scene_gltf2.html
64. glTF Transform: https://gltf-transform.dev/ , https://www.npmjs.com/package/@gltf-transform/cli
65. KTX2/Basis notes: https://deepwiki.com/KhronosGroup/glTF-Sample-Models/5.1-texture-compression-with-ktx2-and-basis-universal
66. Khronos glTF Validator: https://github.khronos.org/glTF-Validator/
67. KayKit Adventurers: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
68. KayKit Skeletons: https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0
69. Quaternius Universal Base Characters: https://quaternius.com/packs/universalbasecharacters.html
70. Kenney Animated Characters: https://kenney.nl/assets/animated-characters-protagonists , https://opengameart.org/content/animated-characters-2
71. US Copyright Office AI page: https://www.copyright.gov/ai/
72. Part 2 report summary: https://www.jenner.com/en/news-insights/client-alerts/us-copyright-office-issues-report-on-copyrightability-of-works-incorporating-ai-generated-material
