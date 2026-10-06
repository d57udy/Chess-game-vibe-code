# Engine, RTS camera and 3D architecture for the chess game

> Research snapshot as of 2026-10-02; prices and versions change. This is one of four research reports behind the [3D battle plan](../README.md). Light edits only (title, this note); content and sources are unchanged unless marked.


Research date: 2026-10-02. Versions and sizes were checked against live sources on this date (URLs in the Sources section, numbered [n]). Items marked **(unverified)** could not be confirmed from a primary source. Items marked **(judgment)** are engineering recommendations, not facts from a source.

## 0. Summary of recommendations

| Topic | Recommendation |
|---|---|
| Engine | **Three.js r186 (npm 0.186.1)**, plain ES modules through an import map, no build step. Start on `WebGLRenderer`; keep the option to switch to `WebGPURenderer` later. |
| Runner-up | **Babylon.js 9.x** (9.29.0). Pick it if built-in animation retargeting, a richer inspector and a batteries-included scene graph matter more than download size. |
| Not recommended here | Godot 4.7, Unity 6.6, Bevy, PlayCanvas editor workflow, React Three Fiber. Reasons in section 1. |
| Camera | `camera-controls` 3.1.2 (MIT) on top of three, configured as an RTS rig: drag rotate, wheel zoom, WASD/edge pan, clamped pitch and distance, board-bounded target, snap to White/Black view with smooth transition. `MapControls` is a zero-dependency fallback. |
| Movement | Tween the root along a grid path (in place locomotion clips, not root motion). Turn to face first, walk, settle. Sliders path only through empty squares (guaranteed by chess rules); knights hop on an arc; castling is a two-unit choreography. |
| Budget | 32 separate `SkinnedMesh` instances (no skinned instancing needed at this count). About 3k to 8k triangles per character, one 1024 px KTX2 texture per character type, meshopt compression, initial 3D download target under 10 MB. |
| Architecture | Keep `gameLogic.js` and the AI worker untouched. Extract the "apply move" state transition out of `ui.js` into the rules layer, emit move events, and let a 2D view (current DOM board) or a 3D view subscribe. 2D stays the default fallback and accessibility mode. |

## 1. Engine choice

### 1.1 Current state of each option (checked 2026-10-02)

| Engine | Current version | License | Build step for GitHub Pages | Runtime download (gzip, measured or cited) | WebGPU |
|---|---|---|---|---|---|
| Three.js | r186, npm 0.186.1 [1][2] | MIT [2] | No. ES modules via import map from jsDelivr work as static files [11][12] | About 195 KB (three.core.min.js 105 KB + three.module.min.js 90 KB), GLTFLoader 26 KB, meshopt decoder 8 KB (measured from jsDelivr) | `WebGPURenderer` usable, falls back to WebGL 2 automatically [3]. WebGL 2 is still the mature default [4] |
| Babylon.js | 9.0 released 2026-03-26 [5]; 9.29.0 on jsDelivr | Apache 2.0 [4] | No, UMD bundle from CDN works. ES packages (`@babylonjs/core`) are meant for bundlers | Full UMD `babylon.js` 1.86 MB gzip (8.6 MB raw), loaders 210 KB gzip (measured). Tree shaking needs a bundler | Among the most advanced web engines for WebGPU [4] |
| PlayCanvas | Engine 2.23.0 (jsDelivr) | Engine MIT, editor frontend MIT, hosted editor/cloud has paid tiers [6][7] | No for engine only. Editor projects export static builds | Engine min 658 KB gzip (measured); "1 to 2 MB runtime" [4] | Maturing, not the default renderer [4] |
| Godot | 4.7 stable, 2026-06-19 [8] | MIT | Export step from the editor. Single-threaded export is the default since 4.3 and runs on GitHub Pages without COOP/COEP headers; threaded export needs those headers or a PWA service worker workaround [9] | Wasm runtime is several MB compressed **(unverified exact figure)** | Web export uses only the Compatibility renderer (WebGL 2) [9]. C# projects cannot export to web [9] |
| Unity | 6.6 released 2026-08-14 [10] | Proprietary. Personal tier free up to USD 200k revenue/funding [13] | Yes, full editor build | Empty 3D web build about 10.7 MB, empty 2D 7.7 MB (secondary source) [14] | Out of experimental in 6.6, still off by default, WebGL 2 fallback [10] |
| Bevy (Rust/wasm) | 0.19 era | MIT/Apache 2.0 | Yes, Rust toolchain plus wasm-bindgen | A Bevy 0.19 WebGPU wasm build measured about 27.8 MB in one project's CI (likely uncompressed) [15] | WebGPU behind a feature flag; WebGPU builds do not run without WebGPU [15] |

Browser WebGPU support (for planning only): on by default in Chrome, Edge, Safari 26 and Firefox on Windows and Apple Silicon Macs [3][16]. Firefox for Android still has it disabled by default, and Linux Chrome only on some GPUs [16]. A WebGL 2 path is therefore still required for broad reach.

### 1.2 Animation capabilities

| Capability | Three.js | Babylon.js | PlayCanvas | Godot | Unity |
|---|---|---|---|---|---|
| Skeletal playback and cross fade | Yes. `AnimationMixer` + `AnimationAction` with `crossFadeTo`, `fadeIn/Out`, `setEffectiveWeight`, `warp`, `syncWith` [17] | Yes, AnimationGroups with weights and blending | Yes, anim component | Yes, AnimationPlayer/AnimationTree | Yes, Mecanim |
| State machine | **None built in** [17]. You write a small per-unit FSM (idle, turn, walk, attack, hit, die, victory). For chess this is about 100 lines **(judgment)** | Blend and state machine capabilities [4] | Anim state graph with states, transitions, parameters, layers, additive blending [18]. Docs focus on the editor; engine-only authoring is possible via JSON but not well documented **(unverified)** | AnimationTree state machine, blend spaces | Mecanim state machine |
| Retargeting | `SkeletonUtils.retarget` / `retargetClip` with bone name maps [19]. Works, but expect manual tuning | New in 9.0: `AnimatorAvatar.retargetAnimationGroup`, handles different skeletons, bone lengths and naming [5][20] | Not verified | Retarget via import (humanoid profile) | Humanoid avatar retargeting |
| Root motion | Not built in [17]. Strip or ignore root translation, drive root from code | Not verified | Not verified | Supported in AnimationTree | Supported |
| glTF | First-class (`GLTFLoader`, KTX2, meshopt, Draco) [21] | First-class | First-class | Import into editor | Via packages |

### 1.3 Fit for this project

Constraints from the repo: vanilla JS, classic scripts with globals, no build step, GitHub Pages hosting, tests with `node --test` and jsdom, an owner who is a PM working with AI assistants.

- **Three.js** fits every constraint. It loads as ES modules from a CDN via an import map, so the project stays build-free. It has the largest volume of examples, forum answers and open source chess projects (section 6), which matters most for AI-assisted development: models have seen far more three.js code than any other engine **(judgment)**. Its gaps (no state machine, no root motion, manual retargeting) are small for a game with 6 piece types and turn-based moves.
- **Babylon.js** is the strongest technical alternative. It ships retargeting [20], an inspector, and more game features out of the box. Cost: a roughly 10x larger runtime download in the no-build UMD form (1.86 MB vs about 0.2 MB gzip, measured), and a less common target for generated code. Choose it if characters come from mixed sources with different skeletons and retargeting becomes the main pain.
- **PlayCanvas** is good, but its value is the hosted editor; the engine-only path has thinner documentation for animation graphs [18].
- **Godot / Unity** replace the whole stack. The JS rules engine, AI worker, jsdom tests and DOM UI would have to be rewritten or bridged through JS interop. Downloads are multi-megabyte before any assets [14], and the tooling needs an editor build step. Not a fit for "add a 3D view to an existing JS game".
- **Bevy** is the worst fit: Rust rewrite, large wasm, WebGPU flag issues [15].
- **React Three Fiber** (9.8.1) is productive but implies React plus JSX, which in practice means adding Vite and a build step. Not worth it for one canvas in an existing vanilla app **(judgment)**.

**Recommendation: Three.js, WebGLRenderer first.** WebGPU gives little for 32 skinned characters, and WebGL 2 has the widest mobile reach [4][16]. Use `three/addons` (GLTFLoader, KTX2Loader, MeshoptDecoder, SkeletonUtils) through the same import map. Pin exact versions in URLs (for example `three@0.186.1`).

**Runner-up: Babylon.js 9**, mainly for built-in retargeting and the inspector.

Note on mixing script types: the existing classic scripts declare top-level `let`/`const` globals (`board`, `currentPlayer`, ...). A `<script type="module">` added after them can read those bindings, because module code resolves free identifiers through the shared global scope. The 3D view can therefore be a module without converting the rest of the app **(judgment, standard JS semantics; test it early)**.

## 2. RTS-style camera and interaction

### 2.1 Camera library options

| Option | Notes |
|---|---|
| `camera-controls` 3.1.2 (MIT) | Polar, azimuth and distance limits; `setBoundary()` to keep the target inside a box; smooth transitions on `setLookAt`, `rotateTo`, `dollyTo` with SmoothDamp; truck (pan) and dolly; one, two and three finger touch mappings [22]. ES module at `dist/camera-controls.module.js`, peer dependency `three >= 0.126.1` (from its package.json). Requires calling `CameraControls.install({ THREE })` with a subset of three classes [22]. |
| three `MapControls` | Built-in, extends OrbitControls. Left drag pans, right drag rotates, wheel or middle zooms; one finger pan, two finger rotate and pinch; arrow keys pan after `listenToKeyEvents()`; damping and polar/azimuth/distance limits inherited from OrbitControls [23]. No animated transitions. |
| three `OrbitControls` | Orbit by default (left drag rotate). Fine for a "free orbit" mode. |
| Babylon `ArcRotateCamera` | Equivalent if Babylon is chosen (alpha/beta/radius with limits and panning). Docs page did not render through the fetch tool **(unverified details)**. |

**Recommendation:** `camera-controls`, because view snapping (White side, Black side, top-down, follow the active fight) needs smooth programmatic transitions, which MapControls does not provide.

### 2.2 Suggested rig (judgment)

- Target always on the board plane, clamped to the board plus a small margin via `setBoundary`.
- Pitch (polar) clamped between about 25 and 70 degrees from vertical, so the board is never seen edge-on or from below. Distance clamped to roughly 0.8x to 2.5x the board width.
- Inputs. Desktop: left click selects/orders, right drag rotates, middle drag or Shift+left drag pans, wheel zooms toward cursor, WASD/arrow keys pan, Q/E rotate 45 degrees, Home or `F` resets, `1`/`2` snap to White or Black, `T` top-down. Edge scrolling off by default (it fights with the side panel and is irritating in a browser window); offer it as a setting.
- Mobile: one finger tap selects, one finger drag rotates (not pans, because the board is small and rotation is the common need), two finger pinch zooms and drag pans. Distinguish tap from drag with a movement threshold of about 8 px.
- Auto camera moments: on capture, ease to a side view framing both units, then return to the player's last view. Respect a "camera follows action" setting and reduced motion (section 2.6).
- On player switch in Human vs Human, optionally rotate 180 degrees; default off.

### 2.3 Picking

- Use `THREE.Raycaster` against a small set of invisible pick proxies: one flat box per square (64 objects) and one capsule per unit. Do not raycast skinned meshes (raycasts use the bind pose unless you compute skinning on the CPU, and they are slower). Map proxy `userData` to `{row, col}`.
- Pointer events on the canvas, with `pointerdown`/`pointerup` distance check to separate clicks from camera drags.
- Hover feedback: outline or emissive tint on the unit, ring decal on the square. Cursor changes when hovering a legal destination.

### 2.4 Move order UX (judgment)

1. Click own unit: selection ring under it, unit plays a short "ready" idle. Legal squares light up via `generateLegalMoves(row, col)` (already in `gameLogic.js`): quiet moves in one color, captures with a red marker over the victim, special moves (castle, en passant, promotion) with distinct icons.
2. Hover a legal square: draw the path the unit will take (a dashed line or footprints on the board for sliders, an arc for knights, two paths for castling).
3. Click destination: unit turns and walks. Input locks until the move completes, which matches the current `isAnimating` lock in `ui.js`.
4. Click elsewhere or press Escape: deselect.
5. Promotion: reuse the existing DOM promotion modal; it works over a canvas.
6. Clicking an enemy unit shows its moves in a muted style (useful for learning, and common in tactics games).

### 2.5 Choreography of special moves (judgment)

- **Knight**: parabolic hop from square centre to square centre, peak height about 0.6 square, duration about 0.6 to 0.8 s, with jump start, airborne and land clips. This also matches the rule that knights are not blocked.
- **Castling**: king walks two squares while the rook walks around (rook path goes one square off the rank and back, or simply after the king passes) so the meshes never intersect. Sequence king first, rook second with 0.2 s overlap.
- **En passant**: attacker steps diagonally, fight happens beside it against the victim on the adjacent square, matching the `victimRow` logic already in `makeMove`.
- **Promotion**: pawn reaches the last rank, plays a transform effect, model swaps to the promoted piece.

### 2.6 Accessibility

- Keep the 2D DOM board as a first-class mode and the default when WebGL 2 is missing or the device is weak. It already has keyboard history navigation.
- In 3D: keyboard cursor over squares (arrow keys move a focus ring, Enter selects and confirms), reusing the same selection state as the mouse. Announce moves through an `aria-live` region with algebraic notation (`moveNotation` is already produced).
- Honour `prefers-reduced-motion`, as `battleFx.js` already does: no automatic camera moves, short or no fight scenes (`off`/`fast`/`full` setting already exists and can be reused), no screen shake.
- A text move input field as an alternative, as in joshprandall/3d-battle-chess [24].

## 3. Movement on the 8x8 grid

### 3.1 Root driven by code vs root motion

| Approach | Pros | Cons |
|---|---|---|
| **Code-driven root + in-place clips** (recommended) | Exact landing on square centres; timing set per move; same clip works for 1 or 7 squares; easy to make deterministic for tests | Slight foot sliding if walk speed and clip cadence differ; fix by setting `timeScale = speed / clipNativeSpeed` |
| Root motion | Feet match the ground perfectly | three.js has no root motion support [17]; distances vary per move, so you still need to scale or correct; harder to land exactly on a square |

Practical rule: strip root translation from locomotion clips at import (or use "in place" variants, which Mixamo offers), keep root translation only for fight clips where the attacker lunges, and snap the unit to the square centre at the end.

### 3.2 Sequence per move (judgment)

1. Turn to face: rotate around Y with shortest-angle slerp, about 0.2 s, while blending idle to walk.
2. Locomotion: walk or run along the path at about 1.5 to 2 squares per second; cap total move time at about 1.5 s by switching to run for long slides (queen across the board).
3. Arrive: blend to idle over 0.2 s, snap to centre, face the "forward" direction of its side.
4. Total time target: 0.6 s for a one-square move, 1.5 s maximum for long moves, plus fight time for captures. Provide a global speed multiplier and a "skip" (click or key) like the current BattleFX skip.

### 3.3 Collisions

Chess legality already solves most of this:
- Pawns, bishops, rooks, queens and kings move along files, ranks or diagonals through **empty** squares only, so a straight-line path never crosses another unit. The only contact is with the victim on the destination square, which is the fight.
- Knights jump, so the arc must clear neighbours (peak height above unit height).
- Diagonal moves pass close to the corners of adjacent occupied squares. With characters at about 60 to 70 percent of a square in footprint there is no visual overlap **(judgment)**.
- Castling is the one case where two moving units cross; handle it with the choreography in 2.5.
- Captures: the attacker stops one half square short, fight plays, victim dies and is removed, attacker steps into the centre. No physics engine is needed.

## 4. Performance budget

### 4.1 Rendering facts

- Each `SkinnedMesh` is drawn separately; three's `InstancedMesh` does not provide per-instance skeletal animation. Workarounds are vertex animation textures (VAT) or batching through newer node systems, which are aimed at hundreds to thousands of units [25][26]. Babylon offers baked vertex animation textures with thin instances for the same purpose [26].
- At 32 units this is unnecessary. 32 characters at 1 to 3 materials each is roughly 32 to 100 draw calls plus the board and environment, well within budget even on mid-range phones **(judgment)**.
- GPU skinning is the default in three (vertex shader). Keep bone counts modest (about 30 to 65 bones; drop finger bones). r186 added support for bone counts exceeding the UBO limit [27], but that is not something to rely on for mobile.
- Share resources: load each character type once and use `SkeletonUtils.clone` for the other instances (8 pawns), which reuses geometry and materials by reference [19]. Animation clips are shared per rig.
- Shadows: one directional light shadow map covering the board only (1024 px on mobile, 2048 px on desktop). Shadow passes re-render skinned meshes, so this roughly doubles skinned draw calls. Offer "shadows off" on low quality **(judgment)**.

### 4.2 Asset targets (judgment, sized for this game)

| Item | Desktop | Mobile / low |
|---|---|---|
| Triangles per character | 5k to 10k | 2k to 4k (LOD or separate low set) |
| Whole scene triangles | under 400k | under 150k |
| Bones per rig | up to 65 | up to 40 |
| Texture per character type | 1024 px base color + optional normal, KTX2 | 512 px, KTX2 ETC1S |
| Textures overall | one atlas per side is ideal | same |
| Download for first playable 3D | under 10 MB | under 5 MB |
| Frame time | 60 fps | 30 fps acceptable, pause rendering when idle |

LOD: with a camera clamped to a board, all 32 units are usually at similar distance, so distance LOD helps little. A quality toggle (high/low asset set) is more useful than automatic LOD.

Render on demand: in a turn-based game, render only while something animates or the camera moves; idle breathing loops can run at reduced rate or stop on mobile to save battery **(judgment)**.

### 4.3 Compression pipeline

- `@gltf-transform/cli` 4.5.1: `prune`, `dedup`, `resample` (lossless keyframe dedup), `simplify`, `meshopt` (compresses geometry and animation), `draco` (geometry only), `etc1s`/`uastc` (KTX2 + Basis), `resize`, `webp` [28].
- Prefer **meshopt over Draco** for animated characters, since meshopt also compresses animation data [28] and its decoder is about 8 KB gzip (measured) versus a larger Draco wasm decoder.
- KTX2 textures stay compressed in GPU memory after transcoding, which matters on phones [21]. ETC1S for base color (small), UASTC for normal maps (quality). `KTX2Loader.detectSupport(renderer)` must be called before loading [21]. The Basis transcoder (wasm) can be loaded from the same CDN path.
- KTX2 encoding needs the KTX-Software `toktx` tool installed locally **(unverified for gltf-transform 4.5; check the CLI help)**. This is an offline asset step, not a site build step, so the site remains build-free.

### 4.4 Loading strategy

- Load the 2D board immediately (as today). Load three.js and the 3D assets only when the user turns on 3D, with a progress bar.
- Order: board and environment, then one set per side (6 character types each), then fight clips lazily on first capture or during idle time.
- GitHub Pages limits: published site up to 1 GB, soft bandwidth limit 100 GB per month [29]. At 10 MB per first visit that is about 10,000 3D sessions per month before the soft limit **(arithmetic, cache hits reduce real usage)**.
- Low-end fallback: detect WebGL 2 failure, context loss, or low frame rate during the first seconds, and offer the 2D mode.

## 5. Architecture fit

### 5.1 What exists today

- `gameLogic.js`: rules with mutable globals (`board`, `currentPlayer`, `castlingRights`, `gameHistory`, ...).
- `aiWorker.js` / `aiClient.js`: AI in a Web Worker with a cancellable `requestAIMove()`; state passed as a snapshot. This is view independent already and needs no change.
- `ui.js`: renders the DOM board, handles input, **and also performs part of the state transition**. `makeMove()` mutates the board, plays the capture scene, then `finishMoveProcessing()` updates castling rights, en passant, clocks and history after the animation resolves.
- `battleFx.js`: GSAP 2D scenes, with skip/cancel, speed modes and reduced motion handling.

### 5.2 Proposed split (judgment)

1. **Move the full move application into the rules layer**: a function like `applyMove(move) -> moveResult` in `gameLogic.js` that does everything `makeMove` + `finishMoveProcessing` do to state (board, castling rights, en passant, clocks, history push, game end evaluation) and returns a description: `{ from, to, piece, placedPiece, captured: {piece, row, col} | null, isCastling, rook: {from, to} | null, isEnPassant, promotion, notation, givesCheck, isMate, isGameOver }`. This makes the rules testable on their own and lets any view animate from the result.
2. **A controller** (the non-DOM part of `ui.js`) owns turn flow, AI requests, history review, undo/redo, and `positionVersion` cancellation. It calls `applyMove`, then asks the active view to present it: `await view.playMove(moveResult, {speed, skipSignal})`.
3. **Views implement one interface**: `mount(container)`, `render(position, {lastMove, check, selection, legalTargets})`, `playMove(result, opts) -> Promise`, `playFinale(result)`, `cancelAll()`, `setOrientation(color)`, `dispose()`, and they emit input intents (`squareClicked(row, col)`, `pieceSelected`). The current DOM board + BattleFX becomes `View2D`; the three.js scene becomes `View3D`.
4. **Events** (a small EventTarget or callback bus): `positionChanged`, `selectionChanged`, `moveStarted`, `captureStarted`, `captureImpact`, `captureFinished`, `moveFinished`, `checkGiven`, `gameOver`, `reviewEntered/Exited`. Sounds and the move history panel subscribe to these, so they work with either view.
5. **State sync rule**: views never read live globals during an animation. They receive a position snapshot plus the move result, and on `cancelAll()` or a new `render()` they snap to the given position. This is the same pattern as the current `positionVersion` checks and the BattleFX "always ends" rule.
6. The 2D view stays the default and the fallback; a setting switches views at any time by calling `dispose()` on one and `mount()` + `render()` on the other.

### 5.3 Testing strategy

- **Rules**: the extracted `applyMove` gets unit tests in Node (existing `tests/unit`, plus perft already exists).
- **Controller**: test with a fake view that resolves `playMove` immediately or on demand; this replaces most jsdom DOM-timing tests for flow logic.
- **View3D logic without a GPU**: keep scene graph code separate from rendering. In Node, construct the three.js scene (three runs without a canvas for math and scene graph), call `playMove` with a **manual clock** (three r183 deprecated `Clock` in favour of `Timer` [30]; inject a timer you advance by fixed steps) and assert unit positions and active clip names at given times.
- **Rendering smoke and visual regression**: Playwright with headless Chromium. Without a GPU Chromium falls back to SwiftShader, a CPU rasterizer [31], *(note added in this copy: since Chrome M139 this fallback is no longer automatic; headless runs need `--enable-unsafe-swiftshader` or `--use-angle=swiftshader`)* which is slow but deterministic enough for screenshots of key frames (start position, after a capture, each camera snap) [31][32]. Freeze the animation clock and disable idle loops before screenshots. Allow a small pixel tolerance.
- **Manual device checks**: real phones (an older Android and an iPhone) before each release; automated tests cannot cover mobile GPU drivers [24].

## 6. Reference projects

| Project | What to study | Notes |
|---|---|---|
| [ImVux21/battle-chess-3d](https://github.com/ImVux21/battle-chess-3d) (MIT) [33] | Closest to the goal: skeletal animated units per faction, attack animations, white/black/isometric/free orbit camera presets, decimated models with compressed PBR textures. Models generated with Meshy | Uses TypeScript + Vite (build step). Live demo on GitHub Pages |
| [joshprandall/3d-battle-chess](https://github.com/joshprandall/3d-battle-chess) [24] | No build: three.js and OrbitControls via pinned jsDelivr import map. Modular files (`engine.js`, `duels.js`, `attacks.js`). Touch input, coordinate-move input field for accessibility. Node tests for rules | Procedural sets rather than skinned characters. Good template for the no-build setup |
| [ShawTim/chess3d](https://github.com/ShawTim/chess3d) [34] | Pure engine module without three imports so the AI runs in a worker and tests run in Node. Camera presets that solve framing against the live UI layout (board stays visible at any window size, tilts toward top-down on narrow screens). Vendored three via import map, no build | Its note that Node tests caught bugs visual review missed supports the testing plan |
| [feenix100/battle_chess](https://github.com/feenix100/battle_chess) [35] | Projectile capture effects per piece class | Simpler |
| three.js example `webgl_animation_skinning_blending` | Canonical cross fade between idle/walk/run clips with `AnimationMixer` | Starting point for the unit FSM |

Lessons:
1. All three no-build references confirm that three.js via import map on a static host is a working pattern [24][34].
2. Keep the rules engine free of rendering imports (ShawTim) [34]; this repo already mostly does, except for the state transition inside `ui.js` (section 5.2).
3. Camera presets that adapt to viewport size matter more than free orbit for usability on phones [34].
4. AI-generated models (Meshy) plus decimation and texture compression are a viable asset path for a solo developer [33]; check the license of each generator separately (covered by the character research track).
5. Mixamo characters and animations are royalty free for games, but the FAQ forbids redistributing raw character or animation files as a product [36]. Shipping `.glb` files inside a public game repo is normal game distribution, but whether a public GitHub repo of raw assets counts as redistribution is a legal question **(unverified, worth a check)**.

## Sources

1. three.js releases, r186 notes (skinning: bone counts above UBO limit): https://github.com/mrdoob/three.js/releases and https://github.com/mrdoob/three.js/releases/tag/r186 . Note: the fetch tool reported a 2024 date for r186, which conflicts with r183 being February 2026 [3]; jsDelivr resolves `three@latest` to 0.186.1 on 2026-10-02.
2. jsDelivr package resolution and package.json for three 0.186.1 (MIT): https://data.jsdelivr.com/v1/packages/npm/three/resolved?specifier=latest
3. utsubo, "What's New in Three.js (2026)" and r183 notes (WebGPU on by default in major browsers, WebGPURenderer falls back to WebGL 2): https://www.utsubo.com/blog/threejs-2026-what-changed , https://github.com/mrdoob/three.js/releases/tag/r183
4. Cinevva, "Web game engines in 2026: PlayCanvas vs Three.js vs Babylon.js vs Unity WebGL" (2026-06-09): https://app.cinevva.com/blog/2026-06-09-web-game-engines-2026-comparison
5. Windows Developer Blog, "Announcing Babylon.js 9.0" (2026-03-26): https://blogs.windows.com/windowsdeveloper/2026/03/26/announcing-babylon-js-9-0/
6. PlayCanvas Editor frontend open sourced (MIT): https://blog.playcanvas.com/playcanvas-editor-frontend-is-now-open-source/
7. PlayCanvas open source mission: https://developer.playcanvas.com/user-manual/getting-started/open-source/
8. Godot 4.7 stable download: https://godotengine.org/download/archive/4.7-stable/ ; release coverage: https://app.cinevva.com/news/2026-06-19-godot-4-7-released
9. Godot docs, Exporting for the Web: https://github.com/godotengine/godot-docs/blob/master/tutorials/export/exporting_for_web.rst
10. Unity 6.6 availability and WebGPU out of experimental: https://discussions.unity.com/t/unity-6-6-is-now-available/1735357 , https://discussions.unity.com/t/webgpu-out-of-experimental-in-unity-6-6/1734694
11. three.js manual, installation (import maps): https://threejs.org/manual/#en/installation (page did not render through the fetch tool; pattern confirmed by [24] and [34])
12. Bundle sizes measured on 2026-10-02 by downloading and gzipping: `three@0.186.1/build/three.core.min.js`, `three.module.min.js`, `three.webgpu.min.js` (205 KB gzip), `examples/jsm/loaders/GLTFLoader.js`, `examples/jsm/libs/meshopt_decoder.module.js`, `babylonjs@9.29.0/babylon.js`, `babylonjs-loaders/babylonjs.loaders.min.js`, `playcanvas@2.23.0/build/playcanvas.min.js` from https://cdn.jsdelivr.net/npm/
13. Unity pricing updates (Personal up to USD 200k): https://unity.com/products/pricing-updates
14. Cinevva, Godot vs Unity for web games (Unity empty build sizes; secondary source): https://app.cinevva.com/guides/godot-vs-unity-web-games
15. Bevy 0.19 wasm size in a third-party CI: https://github.com/Tristan578/project-forge/pull/10268 ; Bevy wasm notes: https://bevy-cheatbook.github.io/platforms/wasm.html
16. caniuse WebGPU: https://caniuse.com/webgpu
17. three.js AnimationAction docs: https://threejs.org/docs/pages/AnimationAction.html
18. PlayCanvas anim state graph assets: https://developer.playcanvas.com/user-manual/animation/anim-state-graph-assets/
19. three.js SkeletonUtils (clone, retarget, retargetClip): https://threejs.org/docs/pages/module-SkeletonUtils.html
20. Babylon.js animation retargeting docs and AnimatorAvatar: https://doc.babylonjs.com/features/featuresDeepDive/animation/animationRetargeting , https://doc.babylonjs.com/typedoc/classes/_babylonjs_core.AnimatorAvatar
21. three.js KTX2Loader: https://threejs.org/docs/pages/KTX2Loader.html
22. camera-controls (MIT, v3.1.2 on jsDelivr): https://github.com/yomotsu/camera-controls
23. three.js MapControls: https://threejs.org/docs/pages/MapControls.html
24. joshprandall/3d-battle-chess: https://github.com/joshprandall/3d-battle-chess
25. three.js SkinnedMesh and BatchNode docs: https://threejs.org/docs/pages/SkinnedMesh.html , https://threejs.org/docs/pages/BatchNode.html
26. Babylon.js, "Creating thousands of animated entities" (baked vertex animation with thin instances): https://babylonjs.medium.com/creating-thousands-of-animated-entities-in-babylon-js-ce3c439bdacf
27. three.js r186 release notes: https://github.com/mrdoob/three.js/releases/tag/r186
28. glTF Transform CLI: https://gltf-transform.dev/cli
29. GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
30. three.js r183 (Clock deprecated in favour of Timer): https://github.com/mrdoob/three.js/releases/tag/r183
31. Testing WebGL with Playwright in headless Chrome: https://www.createit.com/blog/headless-chrome-testing-webgl-using-playwright/ ; SwiftShader fallback: https://scrappey.com/qa/anti-bot/what-is-the-swiftshader-renderer-tell
32. Testing 3D applications with Playwright on GPU: https://blog.promaton.com/testing-3d-applications-with-playwright-on-gpu-1e9cfc8b54a9
33. ImVux21/battle-chess-3d: https://github.com/ImVux21/battle-chess-3d
34. ShawTim/chess3d: https://github.com/ShawTim/chess3d
35. feenix100/battle_chess: https://github.com/feenix100/battle_chess
36. Mixamo FAQ (Adobe): https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html

### Could not verify

- Exact Godot 4.7 web runtime size (the optimization guide returned HTTP 429).
- Babylon `ArcRotateCamera` parameter details (docs pages did not render through the fetch tool).
- Whether PlayCanvas anim state graphs are practical to author without the editor.
- Whether gltf-transform 4.5 bundles KTX encoding or still needs `toktx` installed.
- Exact r186 release date (tool output inconsistent, see source 1).
