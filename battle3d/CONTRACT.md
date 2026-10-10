# Battle 3D prototype: team contract

Prototype goal: a playable 3D "classic battle chess" view using the free CC0 KayKit character packs
(Heroes = White, Skeletons = Black). Fixed three-quarter camera like the 1988 original, with a flip
button and limited orbit. Pieces walk to squares and fight on captures. Rules and AI come from the
existing game (`gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `aiWorker.js` at the repo root).
Prototype quality: it must look good and work, but it is throwaway-friendly code.

## Files and owners

| Path | Owner | What |
|---|---|---|
| `battle3d.html` (repo root) | game | Page shell, HUD, import map, loads classic scripts then `battle3d/main.js` |
| `battle3d/main.js` | game | Boot: create scene, units, controller; debug hooks |
| `battle3d/rules.js` | game | Classic script (NOT a module): move application on gameLogic globals, testable in node vm |
| `battle3d/controller.js` | game | Turn flow, selection, AI, modes, HUD wiring (ES module) |
| `battle3d/scene.js` | scene | Renderer, board, environment, lights, camera, picking, highlights, VFX helpers (ES module) |
| `battle3d/units.js` | units | Character loading, animation, movement, fights (ES module) |
| `battle3d/assets/characters/*.glb`, `battle3d/assets/anims/*.glb`, `battle3d/assets/manifest.json`, `battle3d/assets/CREDITS.md` | assets | Optimized assets + casting manifest |
| `tests/unit/battle3dRules.test.js`, `tests/integration/battle3d*.test.js` | qa | Tests |

Page lives at the repo root so `aiClient.js` finds `aiWorker.js` (worker path is relative to the page).
Do not modify root game files (`ui.js`, `index.html`, `gameLogic.js`, ...) without asking the team lead.

## Loading

- three.js `0.186.1` via import map from jsDelivr:
  `"three": "https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js"`,
  `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/"`.
  Use `OrbitControls`, `GLTFLoader`, `SkeletonUtils` (`three/addons/utils/SkeletonUtils.js`) from addons.
  If you use meshopt compression, use `three/addons/libs/meshopt_decoder.module.js`.
- Classic scripts in order before the module: `gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `battle3d/rules.js`.
- No build step. Serve with `python3 -m http.server` from the repo root.

## World coordinates

- Y up. Board top surface at y = 0. One square = 1 world unit.
- Square center: `x = col - 3.5`, `z = row - 3.5`. `row`/`col` are gameLogic coordinates (row 0 = rank 8,
  col 0 = file a). So White's back rank (row 7) is at z = +3.5 and Black's (row 0) at z = -3.5.
- Default (White) view: camera on the +z side, above, looking toward -z. Black view: mirrored on -z side.
- White units face -z at rest, Black units face +z at rest.
- Character height target about 0.8 to 0.9 world units for a normal piece (scale from manifest).

## Asset manifest (`battle3d/assets/manifest.json`)

```json
{
  "clips": { "file": "anims/clips.glb", "skeletonFile": "anims/clips_skeleton.glb" },
  "roles": {
    "w": { "p": { "model": "characters/Rogue_Hooded.glb", "scale": 0.5, "show": ["Knife"], "hide": [], "props": [], "crown": false, "label": "Pawn" } },
    "b": { "p": { "model": "characters/Skeleton_Minion.glb", "scale": 0.5, "show": [], "props": [{ "file": "props/Skeleton_Blade.gltf", "bone": "handslot.r" }], "crown": false } }
  },
  "fight": { "p": { "attack": ["1H_Melee_Attack_Stab"], "impact": { "1H_Melee_Attack_Stab": 0.42 } } },
  "clipDurations": { "Walking_A": 1.07 }
}
```

- `roles[color][type]` for type in `p n b r q k`. `show`/`hide` are embedded mesh node names to toggle
  (hero GLBs embed all their weapons; hide the ones not used). `props` are external glTFs attached to a bone.
- `crown: true` means units.js adds a small procedural gold crown on the `head` bone.
- `clips.file` holds the shared animation clips (same 41 bone names on every character, so a clip from one
  character plays on any other via `AnimationMixer`). `skeletonFile` (optional) holds skeleton-only clips
  such as `Death_C_Skeletons`, `Spawn_Ground_Skeletons`, `Walking_D_Skeletons`.
- `impact` times are seconds into the attack clip where the hit lands (computed from hand bone speed).
- Until the assets agent finishes, the placeholders in `battle3d/assets/raw/` (unoptimized, every GLB embeds
  all clips) can be used: units.js must accept clips embedded in the character GLB as a fallback.

Available clip names (identical on all characters; skeletons have a few extra):
`Idle, Idle_B (skeleton), Idle_Combat (skeleton), 2H_Melee_Idle, Unarmed_Idle, Walking_A/B/C, Walking_D_Skeletons,
Walking_Backwards, Running_A/B, Jump_Full_Long, Jump_Full_Short, Jump_Start, Jump_Idle, Jump_Land,
1H_Melee_Attack_Chop/Slice_Diagonal/Slice_Horizontal/Stab, 1H_Melee_Attack_Jump_Chop (skeleton),
2H_Melee_Attack_Chop/Slice/Spin/Spinning/Stab, Dualwield_Melee_Attack_Chop/Slice/Stab,
Unarmed_Melee_Attack_Kick/Punch_A/Punch_B, Spellcast_Long/Raise/Shoot/Summon(skeleton), Spellcasting, Throw,
Block, Block_Attack, Block_Hit, Blocking, Hit_A, Hit_B, Dodge_Backward/Forward/Left/Right,
Death_A, Death_A_Pose, Death_B, Death_B_Pose, Death_C_Skeletons, Cheer, Taunt (skeleton), Taunt_Longer (skeleton),
Spawn_Air, Spawn_Ground, Spawn_Ground_Skeletons, Skeletons_Awaken_Standing, Interact, PickUp, Use_Item, T-Pose`.

## scene.js API

```js
export async function createScene(container, { debug }) -> SceneAPI
SceneAPI = {
  THREE, scene, camera, renderer,
  squareToWorld(row, col) -> THREE.Vector3,          // y = 0
  onSquareClick(cb(row, col)),                        // clicks on squares or registered unit proxies
  onSquareHover(cb(row | null, col | null)),
  registerPickProxy(object3D, () => ({ row, col })),  // units register a simple invisible collider
  unregisterPickProxy(object3D),
  setHighlights({ selected, moves: [{ row, col, capture }], lastMove: { from, to } | null, check: { row, col } | null, hover }),
  setView(side 'w' | 'b', { animate = true }) -> Promise,
  focusOn(points: THREE.Vector3[], { duration = 0.6, distance } = {}) -> Promise,  // fight close-up
  restoreView({ duration = 0.6 } = {}) -> Promise,
  addUpdater(fn(dt, t)), removeUpdater(fn),          // dt already multiplied by time scale
  setTimeScale(s), getTimeScale(),
  shake(strength = 1), burst(position, kind 'dust' | 'spark' | 'magic' | 'poof', { color, count }),
  addMarker / removeMarker are internal; units may add children to scene directly.
  stepFrames(n, dt = 1/60),                          // debug/test: advance manually (no rAF needed)
  setPaused(bool)                                    // debug/test
}
```

Render loop: requestAnimationFrame; calls updaters with `dt * timeScale` (clamp dt to 0.05). `stepFrames` runs
the same update + render path synchronously so automation works in hidden tabs.

## units.js API

```js
export async function createUnits(sceneAPI, manifestUrl) -> UnitsAPI
UnitsAPI = {
  syncBoard(board),                    // instantly place units for a gameLogic board (8x8 of piece chars/null)
  unitAt(row, col) -> Unit | null,
  playMove(ev) -> Promise,             // animates a move event (below); resolves when all motion is done
  playCheck(kingSquare) -> Promise,    // short king reaction
  playGameOver({ result: 'checkmate' | 'stalemate' | 'draw', loser: 'w' | 'b' | null, kingSquare }) -> Promise,
  setMode('full' | 'fast'),            // fast: shorter clips, no camera close-up, quicker walks
  skip(),                              // finish the current animation instantly (units snap to final state)
  isBusy() -> boolean,
  setLabels(bool)                      // floating piece glyph labels above heads (default on)
}
MoveEvent = {
  color: 'w' | 'b', piece: 'P' | 'n' | ...,       // moving piece char before the move
  from: { row, col }, to: { row, col },
  captured: { piece, square: { row, col } } | null,   // en passant: square differs from `to`
  castling: { rookFrom: { row, col }, rookTo: { row, col } } | null,
  promotion: 'Q' | 'R' | 'B' | 'N' | null,
  givesCheck: boolean, isMate: boolean, isAI: boolean
}
```

Choreography rules (units.js): sliders walk in a straight line; knights jump (arc); castling king walks two
squares while the rook walks around; capture = attacker approaches to about 0.6 units from the victim, both
face each other, attacker plays a role attack, victim reacts at the impact time (Hit, sometimes Block_Hit first),
then dies (skeletons may use `Death_C_Skeletons`), the body sinks/fades, the attacker steps onto the square.
Bishop attacks are ranged (Spellcast_Shoot + magic projectile). Promotion: the pawn plays a short flourish,
poof, and is replaced by the new unit (Spawn_Air or Spawn_Ground_Skeletons). Full mode: camera `focusOn` the
duel then `restoreView`. Fast mode: no camera move, total capture time about 1.2 s. Full capture about 2.5 to 3.5 s.
Idle variety: occasional idle fidget, never during the opponent's selection highlight logic.

## controller.js responsibilities

Selection (click own unit, legal squares from `generateLegalMoves`, click destination), AI turns via
`requestAIMove(getCurrentGameStateSnapshot(), elo)`, modes (Human vs AI default with human = White,
Human vs Human, AI vs AI), side switch (flips view and who the human plays), new game, undo (2 plies vs AI,
uses `units.syncBoard`), speed Full/Fast, skip button and Space key, labels toggle, status text, move list,
promotion choice (simple 4-button popup; AI promotes automatically), end detection (checkmate, stalemate,
50-move, threefold, insufficient material) using gameLogic helpers. The controller applies moves through
`battle3d/rules.js` which returns a MoveEvent and updates gameLogic globals + `gameHistory` (via
`pushHistoryState`) so the AI's repetition logic works.

`rules.js` (classic script) API: `battle3dApplyMove(from, to, promotion) -> MoveEvent` (throws on illegal move),
`battle3dGameStatus() -> { over, result, winner, message, inCheck }`, `battle3dNewGame()`, `battle3dUndo(plies)`.

## Debug hooks (for QA and the team lead's browser UAT)

With `?debug=1`: `window.__b3d = { sceneAPI, units, controller, step(n, dt), state() }` where `state()` returns
`{ fen, turn, busy, history, over, mode }`. All animations must progress under `step()` alone (no reliance on
rAF or wall-clock timers for gameplay sequencing; use the updater clock).

## Style

Match the repo: plain JS, small functions, comments only where they help, no console noise (use a `log` helper
behind `debug`). No em-dashes in prose. Do not commit.

---

# v2: finalization (owner feedback: richer fights, clearer pieces, customizable cast, remove rough edges)

## File ownership (v2)

| Agent | Owns |
|---|---|
| fights | `battle3d/units.js`, new `battle3d/fights.js` (choreography data + sequences), `battle3d/units-test.html` |
| scene | `battle3d/scene.js`, `scene-world.js`, `scene-fx.js`, `scene-textures.js`, new `battle3d/cinematic.js`, `scene-test.html` |
| cast | new `battle3d/cast.js`, `battle3d/unit-visuals.js`, `battle3d/cast-ui.js`, `battle3d/cast.css`, `battle3d/assets/**` (manifest, props, tools) |
| game | `battle3d.html`, `battle3d/main.js`, `controller.js`, `rules.js`, `hud.css`, new `battle3d/audio.js`, `battle3d/assets/audio/**`, root `index.html` (add a "Play in 3D" link only), `README.md` |
| qa | `tests/**` for battle3d, `package.json` scripts only if needed (ask lead first) |

Only edit files you own. Need something from another file: message its owner.

## New interfaces

### scene.js additions (scene agent)
```js
sceneAPI.cinematic = {
  // Plays a short camera shot; resolves when done. Shots: 'two-shot' (frames both points, side-on to their line,
  // never occluded), 'closeup' (one point, low angle), 'over-shoulder' (from behind subjects[0] looking at subjects[1]),
  // 'orbit' (slow arc around the midpoint). Long-distance pairs (> 2.5 squares) must still frame well (cut between
  // the two ends or use a wide two-shot); all shots avoid other units and the board frame.
  shot(type, subjects: THREE.Vector3[], { duration = 0.8, cut = false } = {}) -> Promise,
  slowMo(scale = 0.25, duration = 0.35) -> Promise,   // eases global time scale down and back (hit-stop/finisher)
  letterbox(on: boolean),                              // cinematic bars during Full fights
  end({ duration = 0.5 } = {}) -> Promise              // back to the player's view (replaces restoreView in fights)
};
sceneAPI.fx.trail(object3D, { color, width, length }) -> { stop() }   // weapon swing trail following a bone/object
sceneAPI.fx.impact(position, direction, kind 'slash'|'blunt'|'pierce'|'magic'|'bone')  // sparks + flash + ring
sceneAPI.fx.debris(position, { kind 'bones'|'armor'|'wood', count = 10, direction }) // physics-lite pieces that bounce and fade
sceneAPI.fx.decal(position, kind 'scorch'|'crack')    // fades out after a few seconds
sceneAPI.requestRender(); sceneAPI.keepAlive(token, on: boolean)   // render-on-demand (below)
sceneAPI.isCoarsePointer() -> boolean
```
Render-on-demand: render while any keepAlive token is on, while the camera moves, while FX are alive, and for one
frame after requestRender(). Idle animations: units keep an 'idle' token on but scene throttles to ~20 fps when only
'idle' is active, and drops to 0 fps after 45 s without input (resume on any pointer/key/game event) and while the
tab is hidden. `stepFrames` keeps working for tests.

### cast.js / unit-visuals.js (cast agent)
```js
// cast.js
export const PRESETS = { classic: {...}, swapped: {...}, ... };          // named casts
export function loadUserCast() -> CastConfig | null;                     // localStorage, try/catch
export function saveUserCast(cast);
export function resolveRoles(manifest, cast) -> manifest-shaped roles { w: { p: role, ... }, b: {...} }
export async function importCustomModel(file: File, THREE, GLTFLoader) -> { id, url, ok, problems: [] }  // checks rig bone names
// unit-visuals.js
export function decorateUnit(unit, { THREE, color, type, role, labels }) -> { setLabel(on), setSelected(on), setThreatened(on), dispose() }
// base disc with an engraved piece icon on top (readable from the camera), team rim colour, role accessories
// (crown/tiara/cape/aura), optional floating glyph label, optional team tint.
// cast-ui.js
export function mountCastEditor(containerEl, { manifest, cast, onApply(cast) })   // panel: presets, per-role model/weapon/scale/tint, import .glb, legend "who is who"
```
units.js (fights agent) must: call `resolveRoles` result via `units.setCast(roles) -> Promise` (reload models as needed, rebuild units keeping positions), use `decorateUnit` instead of its own disc/label/crown code, and expose `units.getLegend() -> [{color, type, name, model}]`.

### units.js / fights.js (fights agent)
`createUnits(sceneAPI, manifestUrl, { audio })`. Fights become multi-beat sequences (approach, clash, exchange, finisher, death, aftermath) using `sceneAPI.cinematic`, `fx.*` and `audio.play(name, {volume, rate})`. Victims no longer just vanish: they react, stagger/knockback, die with a readable fall (skeletons shatter into bone debris; heroes fall and fade to light sparks), the body stays a beat, then sinks. Fast mode keeps total capture <= ~1.3 s without cinematic shots. Full mode target 3 to 5 s with Skip always available.

### audio.js (game agent)
```js
export function createAudio() -> { play(name, { volume = 1, rate = 1 } = {}), setMuted(bool), isMuted(), unlock() }
// names: 'step', 'whoosh', 'clang', 'hit', 'thud', 'bone', 'magic', 'zap', 'cheer', 'death', 'promote', 'check', 'gameover', 'move', 'capture'
// WebAudio; CC0 samples in assets/audio if available, else synthesized; small (< 400 KB total)
```

---

# v3: 3D as default, installable app (PWA), two-finger pan

Owner feedback (Android test): works great. (1) Make 3D the default. (2) Make it installable on Android, with a
message about it in the hamburger menu. (3) Two fingers: zoom (works) AND move the view so pieces at the board
edge can be brought into focus, and look around.

## File layout after v3 (game agent does the moves with `git mv`)

| Path | Content |
|---|---|
| `index.html` | the 3D game (was `battle3d.html`) |
| `2d.html` | the 2D game (was `index.html`) |
| `battle3d.html` | tiny redirect to `./` keeping the query string (old links/bookmarks) |
| `manifest.webmanifest`, `sw.js`, `icons/*` | PWA (pwa agent); sw.js at the repo root so its scope covers both pages |

All links use relative paths (the site lives under `/Chess-game-vibe-code/` on GitHub Pages). 3D page: "Back to the
2D game" and the WebGL2 fallback point to `2d.html`. 2D page: "Play in 3D" points to `./`. README updated.

## Ownership (v3)

| Agent | Owns |
|---|---|
| scene (`b3d-scene`) | `scene.js`, `scene-rig.js`, `cinematic.js` (gestures, pan, view reset) |
| pwa (`b3d-assets`) | `manifest.webmanifest`, `sw.js`, `icons/**`, new `battle3d/install.js`, `battle3d/tools/make_icons.*` |
| game (`b3d-game`) | `index.html`, `2d.html`, `battle3d.html` (redirect), `battle3d/main.js`, `controller.js`, `hud.css`, `README.md`, the 2D page's link only |
| qa (`b3d-qa`) | `tests/**` (including updating helpers for the renamed pages) |

## Interfaces

```js
// scene (b3d-scene)
sceneAPI.resetView({ animate = true } = {})   // back to the fitted default for the current side (also undoes pan/zoom)
sceneAPI.getPan() -> { x, z }                  // debug/tests
// Gestures: 1 finger drag = orbit (unchanged); 2 fingers = pinch zoom + pan (move the look-at target over the board
// plane, clamped to the board area plus a small margin) + twist to rotate around the vertical axis; double-tap keeps
// working. Desktop: right-drag or shift+drag pans, wheel zooms. Pan/zoom are part of the "player's view" that
// cinematic.end() restores. Respect reduced motion.

// pwa (b3d-assets) battle3d/install.js
export function registerServiceWorker({ disabled })            // no-op when unsupported or ?nosw=1 / ?debug=1
export function mountInstallUI(containerEl)                     // hamburger-menu section: "Install app" button via
// beforeinstallprompt (Android Chrome/Edge), else short instructions ("Chrome menu ⋮ > Add to Home screen" / iOS Share >
// Add to Home Screen); hidden when already installed (display-mode: standalone); a one-time gentle hint is allowed.
export function isInstalled() -> boolean
```

PWA requirements: manifest with name "Chess Battle 3D", short_name "Chess 3D", start_url "./", scope "./",
display "standalone" (or "fullscreen" with standalone fallback), orientation "any", background/theme colours from the
HUD palette, icons 192 and 512 PNG (any + maskable), screenshots optional. sw.js: versioned cache, precache the app
shell (both pages, all battle3d JS/CSS, rules/AI scripts, manifest, icons) plus three.js 0.186.1 modules from jsDelivr
and the default cast assets; runtime cache for other assets; network-first for HTML so updates arrive, cache-first for
versioned assets; works offline after the first load; cleans old caches on activate. Must pass Chrome's installability
criteria.

---

# v4: 3D sound design (owner: "walking and finishing the move still sound like the 2D game; match all sounds to the 3D motion and effects")

The 3D game must not use the 2D mp3s (move/capture/check/game-over) any more. All 3D sounds are synthesized
(license-free), positioned in stereo by where they happen on screen, and timed to the animation events.
The 2D game (2d.html) keeps its mp3s unchanged.

## Ownership (v4)

| Agent | Owns |
|---|---|
| audio (`b3d-game`) | `battle3d/audio.js` (sound bank, mixing, spatial, ambience), `controller.js` cues, HUD sound settings, new `battle3d/sound-test.html` (audition page), README |
| motion (`b3d-units`) | cue timing in `units.js` / `fights.js` (footsteps on foot contacts, jumps, arrivals, deaths, debris, promotions) |
| qa (`b3d-qa`) | tests |

## audio.js API (v4)

```js
createAudio() -> {
  play(name, { volume = 1, rate = 1, pos = null /* THREE.Vector3 or {x,y,z} world position */, variant } = {}),
  setListener(camera),            // main.js calls once; panning/attenuation use the camera each play
  setMuted(bool), isMuted(), unlock(),
  setAmbience(on), setSlowMo(factor) // slowMo pitches active fight sounds down while cinematic.slowMo runs
}
```

## Sound bank (names are the contract; each has 2 to 4 random variations, small pitch jitter)

| Name | When | Character |
|---|---|---|
| `step` + variant `light` / `armor` / `heavy` / `bone` | every foot contact while walking (motion agent derives contacts from the walk clip phase) | soft leather on stone/wood; armored adds a small metal clink; heavy (rook) low thump; skeleton dry bony clack |
| `jump` / `land` | knight takeoff / landing | short whoosh and grunt-free effort; landing thud with armor rattle |
| `settle` | a piece arrives and plants on its square (replaces 2D move.mp3) | wooden base-disc thunk on the board, size dependent |
| `select` / `deselect` / `invalid` | controller: pick a unit, cancel, click an illegal square | soft wooden tick plus a tiny metal "ready" note / lower tick / muted dull knock |
| `castle` | castling start | two-note royal horn flourish, quiet |
| `whoosh` + variant `light` / `heavy` / `magic` | weapon swings by weapon weight | |
| `clang` | metal on metal (block, parry) | modal metallic ring |
| `hit` | blade/blunt hit on a hero | cloth/leather thump with a short crunch |
| `bone` | hit on a skeleton | dry crack |
| `shatter` | skeleton bursts into bone debris | burst of many small bony clicks spread over ~0.6 s (matching the debris bounces) |
| `slam` | rook ground smash / crack decal | low boom with stone crackle |
| `zap` / `bolt` / `magicHit` | spell cast / projectile flight hum / magic impact | |
| `fall` | a body hits the board | size-dependent thud |
| `dissolve` | hero fades into light | airy shimmer |
| `death` | the dying character's final beat | short descending tone, no voice |
| `promote` | promotion | rising magical arpeggio plus shimmer |
| `check` | after the check reaction | tense low drum hit with a short brass-like sting (not the 2D mp3) |
| `checkmate` | mate finale | low gong and descending figure |
| `victory` / `draw` | winners cheer / stalemate or draw | bright fanfare-ish chord swell / neutral chime |
| ambience (loop) | while the game is on screen | very quiet torch crackle and room tone; own on/off in the menu; off when muted or hidden |

Mixing: master gain, gentle compressor/limiter, fight bus vs footstep bus vs UI bus, voice cap kept. Stereo pan from the
source's screen x (-1..1), distance attenuation from the camera, fully muted when the tab is hidden.

---

# v5: ELO calibration (steps 1 to 5) and a hint button in 3D

Owner asked: calibrate the AI strength (1 Stockfish matches, 2 re-tune the slider mapping, 3 device-independent
search budget, 4 human-like weakness at low levels, 5 human-scale check), and bring back the 2D game's hint button
in the 3D game. Target scale: the slider should mean a human Lichess-style rating (rapid). Engine (CCRL-style)
ratings are also recorded so the scale can be switched later.

## Ownership (v5)

| Agent | Owns |
|---|---|
| engine (`elo-engine`) | `aiPlayer.js` (search budget, weakness model, ELO mapping), `aiWorker.js`/`aiClient.js` only if the API needs it |
| calibration (`elo-calibrate`) | `tools/calibration/**` (match harness vs Stockfish, Elo fitting, reports), `docs/elo-calibration.md` |
| human benchmark (`elo-human`) | `tools/puzzles/**` (Lichess puzzle sample + solver benchmark), the human-scale section of `docs/elo-calibration.md` |
| game (`b3d-game`) | 3D hint: `controller.js`, `index.html`, `hud.css`, `main.js`, README |
| scene (`b3d-scene`) | hint visuals in `scene.js` / `scene-fx.js` |
| units (`b3d-units`) | optional hint gesture on the hinted unit in `units.js` |
| qa (`b3d-qa`) | tests |

Third-party tools (Stockfish, puzzle data) are used only for offline measurement, installed outside the shipped game
(scratch dir or a tools-local install that is gitignored). Never commit GPL binaries or the full puzzle database; commit
scripts, small result tables and a small CC0 puzzle sample at most.

## Engine API (v5)

```js
// aiPlayer.js (unchanged entry points stay working)
ChessAI.eloParams(elo) -> { nodeBudget, maxDepth, timeCapMs, noise..., blunder... }   // the mapping, data-driven
ChessAI.setEloTable(table)                            // calibration can inject a candidate mapping for matches
ChessAI.searchWithParams(state, params) -> move        // used by the calibration harness
// requestAIMove(state, elo, { timeMs, hint: true }) for hints: full strength, node budget sized for ~1 s on a phone
```

Device independence: strength is set by a node budget (positions searched), with the time limit only as a safety cap,
so the same level plays the same moves on a phone and a Mac (given the same random seed).

Weakness model at low levels (replaces uniform random moves): with a level-dependent probability, overlook threats
(e.g. search without quiescence or with a reduced horizon), miss captures of hanging pieces, misjudge by limited noise,
and prefer "natural" moves (captures, checks, developing moves). Must stay legal and never crash.

## Hint in 3D (game, scene, units)

A "Hint" button in the HUD (and the `H` key) on the human's turn: asks the AI at full strength (hint mode), then shows
the suggestion: a glowing arrow from the piece to the target square on the board, highlights both squares, the piece
does a small "ready" gesture, and the status line says e.g. "Hint: knight to f3". It disappears on the next move,
undo, new game, or when the player selects another piece. Disabled while the AI thinks, during animations, when the
game is over, and in AI vs AI. Cancel any running hint request on those events.

```js
sceneAPI.setHint({ from: {row,col}, to: {row,col}, capture } | null)   // scene: arrow + square glow, render-on-demand aware
units.playHint(square)                                                 // units: short gesture, optional, must be safe to skip
```

---

# v6: talking kings, coach mode, model library (more models, casts, characters)

Owner decisions: (1) kings make fun, snarky, engaging remarks from a PREDEFINED bank of about 300 phrases (no live AI);
(2) a training/coach mode where the player's own king gives advice; (3) load more models for the pieces: a model
library with more CC0 packs, a retargeting layer (VRM + Mixamo/Quaternius-style humanoids onto our animations), and
new casts/characters. All three are on by agreement; build with the agent team.

## Ownership (v6)

| Agent | Owns |
|---|---|
| lines writer (`b3d-lines`, new) | `battle3d/lines/*.json` (king banks, coach templates), `battle3d/lines/STYLE.md` |
| commentary + coach UI (`b3d-game`) | new `battle3d/commentary.js`, new `battle3d/coach.js` (UI/flow), `controller.js`, `main.js`, `index.html`, `hud.css`, `audio.js` (voice blips), README, `sw.js` VERSION bump at release |
| speech bubbles (`b3d-scene`) | bubble rendering in `scene.js` / new `battle3d/bubbles.js` (+ CSS it needs, coordinate with b3d-game) |
| king gestures + loading retargeted models (`b3d-units`) | `units.js` |
| analysis engine (`elo-engine`) | `aiPlayer.js` analysis API, `aiWorker.js`, `aiClient.js`, new `battle3d/tactics.js` (motif detectors, pure JS) |
| retargeting + import (`b3d-retarget`, new) | new `battle3d/retarget.js`, new `battle3d/vrm.js`, bone maps under `battle3d/assets/rigs/` |
| model library + packs (`b3d-assets`) | `battle3d/assets/**` (new packs, manifest, library index, credits), `cast.js`, `cast-ui.js`, `cast.css`, `battle3d/tools/**`, `sw.js` precache list |
| qa (`b3d-qa`) | tests |

## 1. Talking kings

Event bus: controller emits `game:event` objects `{ type, color, piece, square, captured, evalBefore, evalAfter,
classification, motif, ply, thinkSeconds }`. Event types (the line bank uses these keys):
`gameStart, myCapture, lostPiece, lostQueen, capturedQueen, check, gotChecked, mateThreat, promotion, castle,
enPassant, blunderByOpponent, blunderByMe, brilliantMove, longThink, repetition, endgame, winningBig, losingBig,
stalemate, checkmateWin, checkmateLoss, draw, hintUsed, undoUsed, idle`.

`battle3d/lines/hero-king.json` and `skeleton-king.json`: about 150 lines each (about 300 total), keyed by event type,
each line `{ text, weight?, minPly?, tags? }` with slots `{piece} {square} {captured} {opponent}`; PG and kind-hearted
snark (teasing the opponent and the player, never insulting real people, no profanity), short (max ~90 chars), the
hero king pompous and chivalrous, the skeleton king dry gallows humour. Both kings react to the same events from their
own side's point of view. Optional per-AI-level flavour via `tags`.

`commentary.js`: chooses who speaks (usually the king affected; the opponent king may retort), priority per event type,
global cooldown (Occasional: >= 3 plies between remarks; Chatty: >= 1), a shuffle bag per event (no repeats until
exhausted), settings Off / Occasional (default) / Chatty saved with settings; captions to an aria-live region;
pauses during cinematics; never blocks input; works offline.

Bubbles (`b3d-scene`): `sceneAPI.say({ unitWorldPos or square, text, side, durationMs })` shows a comic speech bubble
anchored above the king's head (HTML overlay positioned by projecting the head position each frame, clamped to the
viewport, readable on phones, one bubble per king, fades out). Units: `units.playGesture(square, kind 'talk'|'taunt'|
'cheer'|'shrug'|'facepalm')` short, interruptible, safe to skip. Audio: `audio.play('blip', { voice: 'hero'|'skeleton',
syllables })` short mumbly voice blips per bubble (synthesized), respects mute.

## 2. Coach mode

Toggle "Coach" in the menu (works vs AI and human vs human; off by default). All chess judgement comes from the engine
(`elo-engine`), never from text generation. Engine API via the worker:

```js
requestAnalysis(state, { nodes = 300000, multiPv = 3 }) -> { promise -> { eval, bestMove, pv, alternatives: [{move, eval}] }, cancel }
requestThreats(state) -> { promise -> { threats: [{ move, gain, motif }] }, cancel }   // opponent's best ideas if it were their move
classifyMove(evalBefore, evalAfter, side) -> 'best'|'good'|'inaccuracy'|'mistake'|'blunder' // win% model like Lichess
tactics.detect(stateBefore, move, stateAfter) -> [{ motif: 'fork'|'pin'|'skewer'|'hanging'|'backRank'|'missedCapture'|
  'allowsMate'|'missedMate'|'trappedPiece'|'discovered', squares: [...], pieces: [...] }]
tactics.hangingPieces(state, side) -> [{ square, piece, attackers, defenders }]
```

Coach flow (`coach.js`, b3d-game): before the player's move: optional nudges (threat warning, hanging piece, opening
principles: castle, develop, centre) at most one per move; after the move: classify; for inaccuracy or worse, the
player's king explains in plain language from coach templates in `battle3d/lines/coach.json` (by motif and
classification, with slots) and offers "Take it back" (undo) and "Show me better" (hint arrow with the engine's best
move); good moves get occasional praise. End of game: a short review panel (key moments with classifications, a small
eval graph, jump to position via history review). Coach strength independent of the opponent's level; frequency
setting (Every move / Mistakes only). Analysis runs in the worker, cancellable, about 0.3 to 1 s on a phone; the UI
never blocks.

## 3. Model library, retargeting, new casts

Formats: `.glb`/`.gltf` (embedded) and `.vrm` (via `@pixiv/three-vrm`, MIT, loaded only when needed through the import
map, version compatible with three 0.186.1; verify). FBX is not supported in-browser (convert in Blender; say so).

Retargeting (`b3d-retarget`): detect the skeleton type (KayKit, Mixamo `mixamorig:*`, VRM humanoid, Quaternius,
generic humanoid by name heuristics), map bones onto our clips' bones (data files in `assets/rigs/`), correct
rest-pose differences so our shared clips (walk, attacks, deaths...) play correctly on other humanoids; fall back to
"static" with a clear warning when it can't map. Expose `retarget.prepare(gltfOrVrm, THREE) -> { root, mixerTarget,
clipMap, rigType, warnings }` for units.js.

Model library (`b3d-assets`): three sources in the cast editor: Built-in (bundled CC0), More packs (hosted in the repo
but downloaded only when chosen; each pack has `pack.json` with models, thumbnails, license, credit) and Import your
own (`.glb`/`.vrm`, existing IndexedDB storage). Add at least 2 new CC0 packs (verify licenses from the source; record
in CREDITS.md), e.g. Quaternius characters/monsters and animals (a real horse for knights), optimized like the KayKit
assets (meshopt, small textures). New presets/casts using them (e.g. a monsters army, a mounted-knights variant).
Thumbnails generated by a reproducible script. Validation on import: triangle and texture budgets, rig check,
auto-scale and facing, team tint. Update sw.js precache for built-in assets only (packs cached at runtime when used).

units.js (`b3d-units`): load models through `retarget.prepare` when a role uses a non-KayKit rig; mounted knight
support (rider + horse, both animated, or the horse alone) if a horse model is added.

# v6.1 coach journeys (owner feedback after playing v6)

Owner: "I've enabled the coach, but I'm not getting suggestions every move. The game review seems interesting, but
when I click on a special move in the past and then go back to the game the game review modal is no longer there."

Journeys were mapped on the real page: `main.js` booted in jsdom (real scene with a fake renderer, real units, coach,
controller and engine; only `requestAIMove` answered by the script) and in headless Chrome on a local server
(1280x800 and 390x780, driven with `__b3d.step`). "Was" is v6.0 (commit 601a61f), "Now" is v6.1.

## Journey table

| # | Journey | Expected | Was (v6.0) | Now (v6.1) |
|---|---|---|---|---|
| A1 | Coach on, "Every move", 10 quiet moves as White vs AI | Feedback after every move of the player | 4 of 10 moves got a card, and each vanished when the AI replied | 10 of 10: thinking state at once, then a verdict (Best / Good / ...) with one sentence; it stays through the AI's reply |
| A2 | Same as Black vs AI | Same | 5 of 10 | 10 of 10 |
| A3 | Same in Human vs Human | Feedback for both players | White 5 of 10, Black 4 of 10 | 10 of 10 for each side, labelled "White: ..." / "Black: ..." |
| A4 | Analysis slow, missing or cancelled | Thinking state, then a result, never nothing | Analysis later than 1.5 s, or a missing "before" analysis: card silently hidden | The coach waits for the analysis itself (no time cap), requests a missing "before" analysis from the history, retries a cancelled one up to 3 times, and otherwise says it could not analyse the move |
| A5 | "Mistakes only" | Only inaccuracy / mistake / blunder cards | Correct for verdicts, but threat and king-safety nudges still appeared | Card only for inaccuracy, mistake, blunder; no warnings, no praise, no thinking state |
| A6 | Settings persist over reload and new game | Yes | Yes | Yes (`coach`, `coachFrequency` in `battle3d.settings`) |
| A7 | Card after the user dismissed one | Next move shows a card again | Yes | Yes (dismissed only until the next content) |
| B | Advice before the move at "Every move" | A non-spoiling warning about a real danger; Hint stays the way to get a move | A nudge existed but only showed when no card was visible | One warning line in the card ("Before you move: ...") from, in order: opponent threats (mate, or 250+ centipawns), a hanging piece worth 3+, an exposed king, opening principles, endgame king. Never the best move |
| C1 | "Take it back" on a mistake card, vs AI, after the AI replied | Both plies undone, player to move | Worked only when nothing was animating; during the AI's reply animation the button did nothing | `controller.undoTo(ply - 1)`: works while the AI thinks or animates and after it replied; card then says "Taken back..." |
| C2 | "Show me better" | Undo, then the engine's move as an arrow | Same limitation as C1 | Same undo, then the hint arrow with the piece pre-selected; repeatable |
| C3 | Both in Human vs Human | One ply undone | Worked | Works |
| D1 | Open review mid-game | Possible | Only after game over, or via a button that existed only while the coach was on | "Review game" is always in the menu; opens any time, coach on or off |
| D2 | Click a flagged move | Board shows it; review stays reachable | The modal closed (`closeReview()` before `enterReview`), no way back | Docked panel stays open; flagged moves show the position before the move with the played move highlighted and the better move as the arrow |
| D3 | Step through moves | Prev / next, prev / next flagged | Not possible | Buttons and Left / Right keys; "next" past the last move returns to the game |
| D4 | Return to game | Live position restored exactly, AI resumes | Via Esc / "Back to game" only, with the review gone | "Return to game" in the panel (also Esc, or closing the panel): same FEN, arrow cleared, AI asked again |
| D5 | AI while reviewing | Must not move | Correct | Correct (request cancelled on entering review, re-issued on return) |
| D6 | Minimise / reopen | Scroll and selection kept | n/a | Minimise to a "Back to review" chip; reopening keeps the selection and scroll (the list is updated in place) |
| D7 | Moves without analysis (coach was off, commentary budget only) | Review still useful | Review said nothing was analysed | Missing verdicts are computed in the background while the panel is open, with a progress line |
| E1 | Review with 0 moves | Clear message | Empty modal | "No moves yet..." |
| E2 | Review while the AI is thinking | AI stops, resumes on return | Worked through the move list only | Works from the panel |
| E3 | Review during a capture animation | Works | `enterReview` refused while a move animated | The animation is skipped and the review opens right after (`enterReview` returns `'pending'`) |
| E4 | After undo / new game | No stale data | Stale card possible until the next move | Undo truncates the records, new game clears them, the card and the selection |
| E5 | Talk off / coach off | Review independent | Review button hidden with the coach off | Review works with both off |
| E6 | Phone width (390x780) | Card and review must not cover the board or the install banner | Card overlapped the install toast | Card sits above the toast; the review is a bottom sheet (38 % of the height) that can be minimised; the card hides while the panel is open |
| E7 | Keyboard and screen reader | Focus, Escape, live region | Modal with focus on close | Panel is a labelled region; focus goes to its title; Left / Right step; Escape returns to the game, a second Escape closes the panel; verdicts and review steps are announced through the live region |

## Root causes (v6.0, `git show 601a61f:<file>`)

1. Random praise: `battle3d/coach.js:18` and `:233` showed a card for good moves only with probability 0.45 (best) / 0.15 (good).
2. The AI's reply hid the player's card: `coach.js:206`.
3. Fade after 12 s: `coach.js:20`, `:154`.
4. No verdict when the analysis was late: the controller waited at most 1.5 s (`controller.js:17`) and the coach hid the card without a classification (`coach.js:210`). A missing "before" analysis (coach enabled mid-game, analysis cancelled) had the same effect.
5. Nudges needed an empty card: `coach.js:285`.
6. The review closed itself before showing a position: `coach.js:437`; it was a modal, so nothing could stay beside the board.
7. Undo refused during animations: `controller.js:972`; review refused during animations: `controller.js:878`.
8. The review button was hidden with the coach off: `coach.js:495`.

## Fixes

- `controller.js`: `judgePly(index, opts)` (waits for both analyses of a move, requesting missing ones from the
  history; same classification, tactics and brilliancy code for live moves and review), `plyInfo(index)`,
  `undoTo(index)`, `enterReview(index, { lastMove, arrow, text, force })` (queues behind a running animation),
  `exitReview` clears the arrow. Analysis stays in the coach worker and never delays the AI's move.
- `coach.js`: rewritten around one record per move; the card renders the record of the last coached move; the review
  panel renders all records.
- `index.html`, `hud.css`: card with badge / move / spinner / warning; docked review panel, chip, phone layout.

## Measured analysis time (default coach budget: 200 000 nodes, multiPv 3)

| Where | Time per position |
|---|---|
| node, main thread, 6 middlegame / endgame positions (Mac) | median 185 ms, max 190 ms |
| headless Chrome, coach worker (same Mac, under load) | about 305 ms |
| Phone estimate (3 to 5 times slower) | about 0.6 to 1.0 s |

A verdict needs the positions before and after the move; the "before" one is normally already cached from the
previous move, so one analysis per move. Commentary alone uses 80 000 nodes (about 70 ms on the Mac).

## DOM ids and APIs (for tests)

Card: `#coach-card`, `#coach-badge`, `#coach-move`, `#coach-spinner`, `#coach-text`, `#coach-warning`, `#coach-actions`,
`#coach-undo`, `#coach-better`, `#coach-close`. Review: `#coach-review-open`, `#coach-review` (aside, not a modal),
`#coach-review-intro`, `#coach-review-graph`, `#coach-review-prev`, `#coach-review-next`, `#coach-review-prev-flag`,
`#coach-review-next-flag`, `#coach-review-return`, `#coach-review-detail`, `#coach-review-list`
(`button.review-move[data-ply]`), `#coach-review-min`, `#coach-review-close`, `#coach-review-chip`; `body.review-open`.
`coach.state()`: `{ enabled, frequency, cardVisible, cardText, cardBadge, cardWarning, cardPly, cardPending, reviewOpen,
reviewMinimised, reviewSelected, records, moments }`; `coach.openReview / closeReview / minimiseReview / returnToGame /
select(ply) / step(delta, flaggedOnly)`.
