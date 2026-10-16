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
  setHighlights({ selected, moves: [{ row, col, capture }], lastMove: { from, to, captured? } | null, check: { row, col } | null, hover }),
                                       // lastMove.captured: square of a pawn taken en passant (red frame; omitted otherwise)
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
En passant (`captured.square` differs from `to`): the pawn first walks diagonally onto `to`, turns to the pawn
it passed and strikes from there (plan `enPassant` in Full); it never moves along its own rank.
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

# v6.2: review arrows (played move and better move at once)

Scene (`b3d-scene`, `scene.js` / `scene-fx.js`). `setHint` is unchanged (Hint button, "Show me better").

```js
sceneAPI.setArrows([{ from: {row,col}, to: {row,col}, kind: 'played' | 'better', capture? }])  // replaces all review arrows
sceneAPI.clearArrows()                       // same as setArrows([])
sceneAPI.getArrows() -> [{ from, to, kind, capture }]   // tests; also stats().arrows
sceneAPI.arrowStyle(kind) -> { color, captureColor, dashed, hollowHead }   // for a matching legend in the UI
```

- `better`: the hint look (solid gold arrow, dark outline, gentle pulse, gold square outlines with a soft fill; red
  toward the target when `capture`).
- `played`: told apart by colour and shape: steel blue, dashed shaft, hollow arrowhead, thinner, dimmer (85%), no
  pulse, smaller square outlines without fill. Both read on light and dark squares and from either side.
- Arrows that share a from or to square are shifted sideways (0.16 units, `better` to its left, `played` to its
  right) and `better` is drawn on top; the square outlines are concentric, so neither hides the other.
- Knight moves bend through the L corner and rise over the pieces in between, for both kinds.
- Invalid entries (off-board squares, from equal to to) are dropped; unknown `kind` counts as `better`.
- `setArrows` renders synchronously, so it shows without rAF (background tabs, paused loop). The arrows are separate
  from `setHint` and `setHighlights`, survive camera moves and view changes, and are cleared only by the caller: the
  controller/coach calls `clearArrows()` on Return to game, new game, undo and leaving review.

# v6.3: en passant made readable, controller hooks for saving

Report: "a pawn was capturing another pawn, but not diagonally, but sideways" (20. b4 axb3 e.p. by the AI). The
capture was legal; `fights.js` walked the attacker to the pawn beside it.

- `fights.js`: when `ev.captured.square` differs from `ev.to`, the pawn walks the diagonal onto `ev.to`, turns and
  strikes from there (Full plan `enPassant`, Fast about 1.2 s). It never moves along its own rank.
- `scene.js`: `setHighlights({ lastMove: { from, to, captured? } })`; `captured` is framed in red (mesh `last-captured`).
- `controller.js`: en passant is read from the history (a pawn went diagonally onto an empty square), so stored data
  is untouched: `gameHistory[i].moveNotation` stays standard SAN and `lastMove` stays `{ from, to }`. Display only:
  the move list and `plyInfo(i).notation` say "axb3 e.p."; `plyInfo(i)` adds `enPassant`, `capturedSquare`.
  `createController({ notify })`: `notify(text, { force, seconds })` shows the rule in one line the first 3 times
  (localStorage `battle3d.enPassantSeen`), worded for the player in human vs AI. `moveDone` carries `enPassantLine`.
  A bad AI answer (illegal move, no move, request that fails to start) never stalls the game: it is logged with the
  move and the FEN, `requestAIMove` is called once more with `{ seed: 1 }`, and after a second failure the first legal
  move in board order (a8 to h1, promotions to a queen) is played with a notice.
  `judgePly` adds `allowsEnPassant: ['a4', ...]` (enemy pawns that may now take en passant) and calls a move `best`
  only when it is the engine's choice or within 50 cp of it.
- `coach.js`: the verdict of a two-square pawn move names the pawns that can take it en passant; when the opponent
  takes en passant the card gets one line about it ("Every move").
- `commentary.js`: `enPassant` is spoken regardless of the cooldown.

Click targets. A unit's pick proxy is larger than its figure (radius 0.3, height 0.9; 0.4 and 1.0 on a touch
screen) so units are easy to pick, but seen from the player's side it also stands over the middle of the square behind
it, where that square's move marker is drawn. Picking by proxy alone gave the unit in front every click there.

```js
sceneAPI.registerPickProxy(object3D, getSquare, figure?)  // figure: the unit as drawn (model with gear, or its mount)
sceneAPI.pickAt(x, y)          -> { row, col } | null     // unchanged: the first proxy on the ray, else the board
sceneAPI.pickAt(x, y, true)    -> { row, col, ground, figure, marker }
// ground: the board square on the same ray (null off the board). figure: the square of the nearest unit whose own
// meshes (current pose; no labels, bases, auras or rings) the ray meets, or null when it only passes proxies.
// marker: the offered empty square whose move dot the pointer is on (the dot is drawn over figures and labels).
sceneAPI.onSquareClick((row, col, via) => ...)            // via = { ground, figure, marker } for pointer clicks
controller.clickSquare(row, col, via?)                    // via optional: keyboard and tests mean the square itself
controller.clickedMove(row, col, via?) -> move | null     // what a click would play right now; plays nothing
```

The rule (`controller.js`, "What a click means"):
0. The pointer is on a move dot: that square is played, whatever stands under the dot.
1. The pointer is on a figure: that unit decides. With a unit selected, its square is played if it is an offered
   target (a capture); the own rook castles, the pawn an en passant move takes is captured. Otherwise the click
   selects it, puts the selected unit down, or is refused, as before.
2. The pointer is on no figure: the board square under it decides first (offered target, rook, en passant pawn),
   then the unit whose proxy was crossed (so a tap just beside an enemy unit still captures it).
3. Nothing played: the click selects the figure under the pointer, else one of the mover's own pieces standing on
   the board square under the pointer, else the unit whose proxy was crossed.
Hover is unchanged (it frames the picked square).

Markers: an offered empty square has a gold dot with a dark rim (order 6, texture `target`, no depth test: it is
drawn over figures and labels, so it shows on every offered square from every side) and a gold outline with dark
edges (order 5.5, texture `outline`, depth-tested); both read on light and on dark squares (the old pale dot did
not show on light squares at all). Unit labels are drawn before the markers (order 5), and the selected unit's own
label is hidden while it is selected. Measured by pixel readback in `tests/slow/battle3dLayoutBrowser.test.js`.
While a pawn that can take en passant is selected, the pawn it would remove has a red
frame (`setHighlights({ victim })`, mesh `capture-victim`), the same frame that marks its square after the capture.

Bottom of the screen (`index.html`, `hud.css`): `#tip` (notices, `showNotice`), `#coach-card` and the install / update
toasts (`main.js` passes `.bottom-stack` as their parent) stand in one fixed flex column, `.bottom-stack`, notice on
top, so none covers another at any width; on a phone the stack stands above the review sheet, the review chip or
the review bar. Game review list: `.review-moves` columns are `minmax(0, auto)` (content-sized, never wider than the
panel), the move text is the part that is shortened (`.mv`, ellipsis) and the badge never (`.tag`, `flex: none`);
"e.p." is a `<small class="ep">` inside `.mv`. Both are measured in headless Chrome by
`tests/slow/battle3dLayoutBrowser.test.js`.

Saving (`savegame.js`):

```js
controller.loadGame(apply, { mode, humanColor, elo } = {}) -> result of apply()
// Aborts whatever is in flight, calls apply() (which changes the rules state synchronously and restores the old
// game itself on failure, returning { ok: false }), applies the settings on success, redraws without animating.
// Events: reset { reason: 'loadGame' } + change { reason: 'loadGame' } on success, reset { reason: 'loadFailed' } else.
controller.onEvent(e => ...)   // e.type === 'change', e.reason: 'move' | 'newGame' | 'loadFen' | 'loadGame' | 'undo' | 'settings'
// 'change' fires synchronously right after the rules state or mode / side / AI strength changed ('move': before the animation).
```

# v6.3: save, load and export

Autosave and resume, named saves, PGN export and import, for the 3D and the 2D game. Everything stays in
localStorage on the device; there are no network calls.

## Files

| File | Role |
| --- | --- |
| `savegame.js` (repo root) | All logic, no DOM building: records, storage, PGN writer and reader, SAN matching, clipboard / share / download. Global `SaveGame`. |
| `savepanel.js` (repo root) | The Save / Load dialog (tabs Saved games, Export, Import). Global `SavePanel`. Styled by `hud.css` (3D) and `style.css` (2D) through the `save-*` classes. |
| `battle3d/saves.js` | 3D wiring (ES module): `setupSaves({ controller, coach, notify })`, called by `main.js` in place of the first `controller.newGame()`. |
| `saves2d.js` (repo root) | 2D wiring (classic script after `ui.js`); `ui.js` is unchanged. |

**One file, two loaders, no build step.** `savegame.js` and `savepanel.js` are plain scripts: one function
scope, a global assigned on `globalThis`, no `import` / `export`, no top-level `this`. The 2D page loads them
with `<script src>`; the 3D page gets them through `battle3d/saves.js`, which does `import '../savegame.js'`
(run for the side effect) and re-exports the globals. Keep them free of module syntax.

Rules access: only global functions of `gameLogic.js` and `battle3d/rules.js` (`battle3dNewGame`, `battle3dLoadFen`,
`battle3dApplyMove`, `battle3dState`, `battle3dFen`, `generateLegalMoves`, `getPieceAt`, `getPlayerForPiece`,
`isKingInCheck`, `checkGameEndCondition`, `checkThreefoldRepetition`, `getHistoryRepetitionKey`,
`hasInsufficientMaterial`, `getBoardPositionString`, `loadGameStateSnapshot`), looked up when called. A record's
`result` is the game's own verdict on the last position: mate, stalemate, 50 moves, insufficient material and
repetition with the game's key (also when the 2D view shows an earlier position). `2d.html` loads `battle3d/rules.js` for the
replay; `ui.js` still makes its own moves. The one exception is `snapshot()` / `restore()` in `savegame.js`, which
read and assign the `gameLogic.js` bindings `gameHistory`, `currentMoveIndex`, `isGameOver` and `gameStatusMessage`
by name so that a failed load puts the previous game back exactly (history entries are never changed after the push).

## Storage format (version 1)

| localStorage key | Content |
| --- | --- |
| `chess.autosave.3d`, `chess.autosave.2d` | One record: the current game of that view. Removed while the game has no moves. |
| `chess.saves` | `{ "v": 1, "saves": [record, ...] }`: the named saves, shared by both views, at most 30. |
| `chess.saves.unreadable` | The raw `chess.saves` string this version could not read (corrupt or another version), set aside on the next write instead of being deleted. |

```js
record = {
  v: 1,                          // format version, on every record and on the saves list
  id: 's<time><random>',         // named saves only
  name: '12 Oct, vs AI 1200',    // named saves only, 1 to 60 characters, unique without regard to case
  savedAt: 1791856000000,        // ms since 1970
  startedAt: 1791855000000,      // when the game started (PGN Date)
  view: '3d' | '2d',             // where it was written (informational: any save loads in either view)
  mode: 'human-ai' | 'human-human' | 'ai-ai' | null,   // 3D names; 2D maps 'human-ai' <-> 'ai-human'
  humanColor: 'w' | 'b' | null,
  elo: 1200 | null,
  startFen: null | '<fen>',      // null = the usual start position
  moves: ['e2e4', 'e7e8q'],      // long algebraic, the authority: a load replays them through battle3dApplyMove
  san: ['e4', 'e8=Q+'],          // standard SAN of the same moves, for export (never "e.p."); not used for loading
  result: '*' | '1-0' | '0-1' | '1/2-1/2',
  fen: '<fen of the last position>',
  cursor: 12                     // autosave of the 2D view only: the earlier position that was shown (redo kept)
}
```

Reading is strict about `v`, `moves` (each `/^[a-h][1-8][a-h][1-8][qrbn]?$/`, at most 2000) and `startFen`
(shape check, one king each); everything else falls back to a default. `SaveGame.normalizeRecord(raw)` returns
the clean record or `null`. Versioning: `SaveGame.MIGRATIONS[n]` turns a version `n` object into `n + 1` and is
applied step by step up to `FORMAT_VERSION`; the table is empty because 1 is the first format. Data of another
version (newer, or older without a migration) or corrupt data is never an error: the autosave is ignored
(`problem: 'version' | 'corrupt'`, the page starts a new game and shows "Your saved game could not be read, so a
new game was started."), single bad entries of the saves list are dropped, an unreadable list reads as empty.
A missing, blocked or full storage makes reads return nothing and writes return `false` / `{ ok: false, error: 'storage' }`.

## Module API (`SaveGame`)

```js
// Records and the rules state
currentRecord({ view, mode, humanColor, elo, startedAt }) -> record | null     // the whole game incl. a 2D redo tail
applyRecord(record) -> { ok: true, record } | { ok: false, error, ply }       // replaces the game, all moves or nothing;
                                                                               // tell the view afterwards (see below)
normalizeRecord(raw) -> record | null        sameGame(a, b) -> boolean (start position and moves)
fenAt(index) -> FEN of gameHistory[index]

// PGN
toPgn(record, { event, site, white, black }) -> string     // Seven Tag Roster (Round "-"), SetUp/FEN when startFen,
                                                           // SAN movetext on one line with the result, final newline
parsePgn(text) -> { tags, sans, result, more }             // tokens of the first game; no rules involved
fromPgn(text) -> { ok: true, record, more, adjusted } | { ok: false, error, ply, moveNumber, color, san }
                                             // every move checked by replaying it; the rules state is put back;
                                             // adjusted: the FEN tag's castling / en passant rights did not fit (see below)
sanToMove(san) -> { move: { from, to, promotion } } | { reason: 'syntax' | 'illegal' | 'ambiguous' }   // current position

// Storage (createStore(storage = localStorage))
store.loadAutosave(view) -> { record, problem }     store.saveAutosave(view, record | null) -> boolean
store.list() -> records, newest first               store.get(id)   store.findByName(name)   store.problem()
store.save(name, record, { replace }) -> { ok: true, id, replaced } | { ok: false, error: 'name' | 'exists' | 'full' | 'storage', id? }
store.rename(id, name)   store.remove(id)   store.max (30)

// Out of the app (each feature-detected; env = { navigator, document, URL, Blob } only in tests)
copyText(text) -> Promise<{ ok, method: 'clipboard' | 'execCommand' | null }>
canShare() -> boolean      shareText({ title, text }) -> Promise<{ ok, reason?: 'unavailable' | 'cancelled' | 'failed' }>
downloadText(filename, text) -> { ok, method: 'blob' | 'data' | null }

// One per page: the glue the panel and the views use
session = createSession({ view, title, settings(), adopt(apply, settings, { review, cursor }), busy?(), fen?(), site?, storage? })
session.autosave(reason)       // call after every change of the game or its settings ('newGame' restarts the PGN date)
session.resume() -> { resumed, notice }    // at boot: puts the autosave back through adopt()
session.load(record, { review }) -> { ok, record } | { ok: false, error }
session.readPgn(text)   session.importPgn(text, { review })   session.unsaved()   session.record()   session.pgn()
session.fen()   session.saveAs(name, { replace })   session.defaultName()   session.fileName()   session.store
```

`adopt` is the view's part of a load: stop what is in flight, call `apply()` (it returns the `applyRecord` result),
apply the settings, redraw. 3D: `controller.loadGame(apply, settings)`, then `coach.openReview()` for `review`.
2D: `apply()`, then `abortInFlightWork()`, the settings through the page's own controls, `navigateToHistoryState(index)`.
The 3D view autosaves on the controller's `change` event; the 2D view when `ui.js` redraws the move list (a
MutationObserver on `#move-history`) and when the mode, strength or colour controls are used.

PGN import tolerance: comments (`{...}`, `;` to the end of the line, `%` lines), NAGs, nested variations, move
numbers in any style, detached `!?`, `e.p.`, `0-0` / `0-0-0`, a missing or extra `x`, more disambiguation than
needed (`Nbd7`, `Ng1f3`, `e2-e4`), promotions as `e8Q` or `e8=q`, wrong or missing check marks. Of several games the
first is read (`more: true`). A `[FEN]` tag (with or without the two clocks) is loaded through `battle3dLoadFen`, so
the position is the one the rules accept: `parseFen` drops castling rights without king and rook at home and an en
passant square without a double-pushed pawn in front of it. `record.startFen` is that cleaned position,
`adjusted: true` reports the difference (the panel adds "they were ignored" to its notice), and a move that
needed the dropped right is illegal like any other. A FEN that is not a position (wrong shape, a king missing,
the side that just moved in check) is refused. The first move that is unreadable, illegal or ambiguous stops the import:
`Move 8 for Black ("Kc5") is not a legal move in that position. Nothing was loaded.`

## DOM ids (for tests)

Openers: `save-open`, `export-open` (both pages). Panel: `save-modal` (`hidden` when closed; class `modal` on the 3D
page so the controller's shortcuts stay out), `save-title`, `save-close`, tabs `save-tab-saves|export|import` with
panes `save-pane-*`, `save-status` (role status), `save-confirm` with `save-confirm-text`, `save-confirm-yes`,
`save-confirm-no`. Saved games: `save-form`, `save-name`, `save-submit`, `save-count`, `save-list` (items
`.save-item[data-id]` with `.save-item-name`, `.save-item-meta`, buttons `[data-action="load|rename|delete"]`,
while renaming `.save-rename` and `[data-action="rename-ok|rename-cancel"]`), `save-empty`. Export: `save-pgn`,
`save-copy`, `save-share` (hidden without `navigator.share`), `save-download`, `save-fen`, `save-copy-fen`.
Import: `save-import-text`, `save-import-error` (role alert), `save-import-play`, `save-import-review`,
`save-import-pick`, `save-import-file`. 2D only: `save-notice`. Test hooks: `window.__b3d.saves` (3D, with
`?debug=1`) and `window.SaveHost` (2D), both `{ session, panel }`.

Tests: `tests/unit/savegame.test.js`, `tests/integration/battle3dSaves.test.js` (real page, opened with an
autosave), `battle3dSavesBoot.test.js` (real page, unusable data), `battle3dSavesReboot.test.js` (controller +
`saves.js`, close and reopen), `saves2d.test.js` (real 2D page); slow: `tests/slow/savegamePgnSweep.test.js` and
`savesBrowser.test.js` (headless Chrome at 360 px, `tests/helpers/headlessChrome.js`). Shared helpers:
`tests/helpers/saveGameHarness.js`.

# Rules audit (v6.3)

Every place that generates, validates or applies a move, and where the rule state lives. Reference for the engine
tests (`tests/unit/rules*.test.js`, chess.js as the independent reference, see `tests/helpers/chessReference.js`).

## Who generates, validates and applies moves

| Place | Role |
| --- | --- |
| `gameLogic.js` `generateLegalMoves(row, col)` (`getPawnMoves`, `getKnightMoves`, `getSlidingMoves`, `getKingMoves`) | THE generator of both views. Pseudo-legal moves of one piece of `currentPlayer`, each simulated on the board and kept when `isKingInCheck` is false. Move = `{ row, col, isEnPassant, isCastling, isPromotion }`, one entry per promotion square (the applier picks the piece). |
| `gameLogic.js` `hasLegalMoves`, `checkGameEndCondition`, `isKingInCheck`, `isSquareAttacked` | Check, checkmate, stalemate. `hasLegalMoves(player)` and `checkAmbiguity` (SAN) switch `currentPlayer` for the call and put it back. |
| `aiPlayer.js` `getAllLegalMoves(player)` | All pieces through `generateLegalMoves`, in the AI move shape (`promotionPiece` always `'Q'`). |
| `ui.js` `makeMove` + `finishMoveProcessing` | 2D applier. Validates with `generateLegalMoves`, changes the board at once, then rights, en passant target, clocks, turn and history after the animation. |
| `battle3d/rules.js` `battle3dApplyMove` | 3D applier (also used by `savegame.js` to replay). Validates with `generateLegalMoves`, takes `isEnPassant` / `isCastling` from the generator's move, applies everything in one step, pushes history, returns the MoveEvent. Throws on an illegal move without changing anything. |
| `aiPlayer.js` `ChessAI` `genMoves` / `genCastling` / `legalMoves`, `makeMove` / `unmakeMove` / `makeNullMove` | The AI's own generator on a 64-square int board with flags `FLAG_EP`, `FLAG_CASTLE`, `FLAG_DOUBLE`; legality by make + `attacked`. Never touches the game state during a search. `toGameMove` turns the result into the AI move shape; both appliers validate it again with `generateLegalMoves`, so an AI move the game rules reject is never played. |
| `ChessAI.applyMoveToGlobals` / `writeToGlobals`, `perft`, `perftCounts` | Tests and self-play only. |
| `battle3d/tactics.js` `legalMoves` / `applyMove` | Coach motif detection only (no castling, promotions to queen and knight). Never applied to the game. |

## Where the rule state lives

- Live position: `gameLogic.js` globals `board[row][col]` (row 0 = rank 8), `currentPlayer`, `castlingRights { w: { K, Q }, b: { K, Q } }`,
  `enPassantTarget { row, col } | null` (the square the pawn skipped), `halfmoveClock`, `fullmoveNumber`.
- History: `gameHistory[i]` is the position AFTER ply `i` (entry 0 = start), written once by `pushHistoryState()` with deep
  copies of board, rights and target plus the clocks; `currentMoveIndex` is the shown one. Entries are never changed
  afterwards except `moveNotation`, `statusMessage`, `lastMove` set right after the push.
- En passant target: set to the skipped square after every double pawn push and to `null` by every other move
  (`battle3dApplyMove` step 3, `ui.js finishMoveProcessing`, `ChessAI.makeMove`: `ep`). A capture is generated only onto the
  empty target with the enemy pawn standing beside the capturer.
- Castling rights: cleared by a king move, a rook leaving its home square and a rook captured on its home square (both
  appliers; `ChessAI`: `CASTLE_MASK[from] & CASTLE_MASK[to]`). Castling needs the king on e1/e8, the rook on its
  corner, empty squares between, and e/f/g or e/d/c not attacked (b1/b8 and the rook may be attacked).
- Clocks: `halfmoveClock` is 0 after a pawn move or capture, else +1; draw at 100. `fullmoveNumber` +1 after Black.
- Repetition: `checkThreefoldRepetition()` counts `getRepetitionKey()` over `gameHistory[0..currentMoveIndex]`: placement,
  side, castling rights, and the en passant square only when a capture is legal (FIDE 9.2). The AI gets the same keys as
  `positionHistory` (`getHistoryRepetitionKey(i)` in `getCurrentGameStateSnapshot`) and hashes them (Zobrist). Inside its
  own search tree the AI still hashes the en passant file after every double push, so there it can notice a repetition
  that begins with such a position one occurrence late (a search heuristic, not a rule the game applies).
- Undo: 3D `battle3dUndo(plies)` = `loadGameStateSnapshot(gameHistory[target])` and cuts the history; 2D
  `navigateToHistoryState(i)` copies the same fields and keeps later entries for redo (cut by the next move).
  `savegame.js` `snapshot()` / `restore()` keep and put back the whole history around a replay (all-or-nothing loads).
- Copies: `loadGameStateSnapshot(state)` (deep copy in; undo, `aiWorker.js`, the main-thread AI fallback, which saves
  and restores the live globals around it), `getCurrentGameStateSnapshot()` / `cloneAIState` (deep copy out),
  `ChessAI.loadState(state, positionHistory)` (own board; drops an en passant target that does not fit the position).
- FEN in: `parseFen` (six fields, eight rows of eight, known pieces, side `w`/`b`). Since v6.3 it also drops, with a
  `console.warn`, an en passant target that is not on the mover's sixth rank, not empty, without the double-pushed enemy
  pawn in front or with the start square behind occupied, and castling rights without king and rook on their home squares.
- FEN out: `getBoardPositionString(state)` + clocks (`battle3dFen()`). The en passant square is written after every
  double push (the FEN standard); chess.js writes it only when a capture is legal. The tests derive the expected field
  from the reference move (double push or not) instead of normalising it away.
- Draw checks in `battle3dGameStatus()` / `ui.js evaluateGameState()`, in this order: checkmate, stalemate, 50 moves,
  threefold, insufficient material (K v K, one minor piece, any number of bishops all on one square colour). The AI's
  own `isRepetition` / `insufficientMaterial` (at most one minor piece) only score positions inside its search.

## Findings (all fixed in v6.3)

| Bug | Minimal reproduction |
| --- | --- |
| A hand-written FEN could make a pawn capture "en passant" a piece that is not a double-pushed pawn, its own piece included (`gameLogic.js getPawnMoves`, `parseFen`). | `4k3/8/8/3NP3/8/8/8/4K3 w - d6 0 1`, e5d6: was legal and removed White's knight on d5. |
| `ChessAI` generated an en passant move without any pawn to take from such a FEN (`aiPlayer.js loadState`). | `4k3/8/8/4P3/8/8/8/4K3 w - d6 0 1`: e5d6 was in `ChessAI.legalMoves()`. |
| Castling rights from a FEN were trusted without the king on its home square (`gameLogic.js getKingMoves`, `parseFen`). | `4k3/8/8/8/8/8/4K2R/8 w K - 0 1`, e2g2: was "O-O" on the second rank. |
| Threefold repetition counted a position right after a double push as different even when nobody could capture en passant (`gameLogic.js checkThreefoldRepetition`). | 1. e4 e5 2. Nf3 Nf6 3. Ng1 Ng8 4. Nf3 Nf6 5. Ng1 Ng8: draw only one ply later. |
| `tactics.js legalMoves` gave the side that just double-pushed a diagonal pawn step onto its own en passant square (coach only, `trapped()` asks for the side not to move). | After 1. e4, `legalMoves(b, 'w', e3)` contained d2-e3 and f2-e3. |

The reported "pawn captured another pawn sideways" has no engine cause: 20. b4 axb3 was a legal en passant capture
(replayed against chess.js in `tests/fixtures/rules-corpus.json`); the MoveEvent names the victim beside the attacker
(`captured.square = { row: from.row, col: to.col }`) and the view walked there. See "v6.3: en passant made readable".

## Engine tests

`tests/unit/rulesPerft.test.js` (perft with capture / en passant / castle / promotion / check / mate counts, through
`battle3dApplyMove` and through `ChessAI`), `rulesDifferential.test.js` (100 corner positions, 21 lines, seeded playouts
against chess.js: move sets, flags, MoveEvents, SAN, FEN after every move, draw flags; also `ChessAI` and `tactics.js`),
`rulesEnPassant.test.js` (pawn geometry, en passant target life cycle, invalid FEN and state), `rulesAiMoves.test.js`
(AI moves through the worker hand-off at six strengths). Deeper runs: `tests/slow/rulesPerftDeep.test.js`,
`tests/slow/rulesDifferentialDeep.test.js` (`npm run test:slow`).

# v6.4: offline

Owner report (Android, installed app): "I tried to play the game offline after having it installed on my Android
phone, but that didn't work. It was stuck in some initial loading phase."

## Root causes (v6.3, reproduced in headless Chrome with the network cut where a phone loses it)

| Case | v6.3 | Cause |
|---|---|---|
| Connected, but nothing answers (Wi-Fi without internet, a weak mobile signal) | Stuck at "Summoning the armies..." for as long as the network stays silent (94 s and counting in the test) | `main.js` probed `battle3d/assets/manifest.json` with a HEAD request; `sw.js` sent HEAD to the network first, without a timeout. Cache misses (CDN, fonts) waited without a limit too, and the Google Fonts stylesheet blocked the page while it loaded. |
| An update, then offline, with a library-pack cast | Default characters instead of the pack | Packs were cached at runtime in `chess3d-runtime-<VERSION>`, which every release deleted. |
| An update, then offline, with an imported VRM avatar | Placeholders ("Could not load the VRM library (offline?)") | three-vrm was not precached; its runtime copy was deleted with the release. |
| An update on a flaky connection | The 3D page showed "Could not load the 3D engine" offline; the 2D page lost its animations | `precache()` used `Promise.allSettled` and `skipWaiting()` anyway: a version with 128 of 134 files took over and deleted the complete previous version. |
| Any offline start | Title font missing | The fonts stylesheet was a no-cors request; its opaque answer was never stored. |

Offline with DevTools' network emulation on the page alone is not offline: the service worker fetches in its own
target and still reached the server (37 requests in one start). `tests/helpers/offlineNet.js` closes the site's port
or holds it, and sends the CDNs through a proxy with the same switches.

## Design (`sw.js`, `offline-files.json`)

- **Everything is precached**: the same-origin files of `offline-files.json` (app shell, every model, clip, prop and
  thumbnail of the asset manifest, every library pack: `library.json` -> `pack.json` -> models and thumbnails, at the
  paths `cast.js` asks for), the CDN modules (three.js and its addons, three-vrm, gsap) and the Google Fonts
  stylesheet with its font files.
- **`offline-files.json` and the build stamp** (committed, both written by `tools/offline-list.js`,
  `npm run offline-list`): the list maps each same-origin path to a content hash (SHA-256, 16 hex digits) and names
  the optional ones; the generator derives it from the manifests, so new casts and packs need no worker change. The
  stamp `const BUILD = '...'` in `sw.js` is a hash of the list and of `sw.js` without the stamp line (bytes as saved;
  `--check` rejects a byte order mark in either file, and the worker keeps one when it hashes, as node does). Cache names
  carry VERSION and BUILD, so any change of a listed file or of the worker code (after `npm run offline-list`) gives
  a new worker and a new shell, even without a VERSION bump; VERSION is the human-readable label.
- **Guards against a forgotten `npm run offline-list`**: `node tools/offline-list.js --check` (run by
  `.github/workflows/offline-list.yml` on pushes and pull requests to main, and by `tests/unit/offlineLists.test.js`)
  fails when the list or the stamp is stale, or when `sw.js`, the list or a listed file is not tracked by git with
  exactly that path (GitHub Pages is case-sensitive, macOS is not). Pages publishes main with the built-in "pages
  build and deployment", so the check cannot block a deploy; it marks the commit red. At install the worker hashes the
  deployed list with its own script: a mismatch (a release without the stamp, or a deploy still spreading over the
  CDN) gets one more try with `cache: 'reload'`, then the install fails and the previous version keeps serving.
  A downloaded file must have its listed hash (one more try with `cache: 'reload'`): a required file that differs
  fails the install; an optional one is kept and listed in the marker's `mismatched` and in `offline-error.json`.
- **Required and optional**: the app shell, the default cast (role models, their props, the clip files) and the CDN
  modules are required. Thumbnails, the other weapons of the cast editor and the library packs are optional: a 404
  for them (the deploy does not have the file) is left out and listed in the marker's `missing`. Any other failure
  of any file keeps the version from taking over. Fonts are optional: one try each (5 s), in parallel with the rest.
- **A version takes over only when complete.** Each download gets 3 tries (2 s, then 10 s apart); one that receives
  nothing for 30 s, headers or body, is aborted. The whole install stops after 4 minutes, posts `failed` and
  leaves what it stored. If anything required is missing, install fails: the previous version keeps serving from its
  complete caches, and the next visit (or the device coming back online, when the page has a worker) resumes. A
  complete download stores `offline-ready.json` (`{ version, build, files, missing, mismatched, completed }`); a
  failed one stores `offline-error.json` (`{ version, error, at }`, for the debug view only) in the shell.
- **Only changed files are downloaded.** For every listed file the worker first looks for a cached copy whose content
  has the listed hash: in this version's own cache (a retried install resumes), then in older versions' caches (an
  update copies unchanged files; an older version's partial download counts too). Only files without such a copy are
  downloaded. ETags play no part: GitHub Pages gives every file of a deploy a new one. Measured in headless Chrome: an
  update that changes one JS file (`battle3d/coach.js`) downloads `sw.js` twice (the browser's update check and the
  worker's stamp check), `offline-files.json` and that file: 117 KB before gzip, nothing from the CDNs, instead of
  all same-origin files again (about 6.8 MB).
- **One version at a time**: the active worker answers every listed file, pages included, from its own shell, and
  nothing but its install writes that shell. HTML, scripts and models therefore always come from one version, online
  or offline (before, the first load after a deploy mixed new HTML from the network with old scripts, and
  stale-while-revalidate let a newer deploy's files into the active offline copy). New versions reach open pages only
  through a complete install and the Reload toast. Navigation preload is turned off (listed pages never use it).
- **No switch in the middle of a game**: only the first version takes over at once (skipWaiting when there is no
  active worker, then clients.claim). A newer complete version waits: the pages show "A new version is ready." with
  Reload (`install.js applyUpdate()` posts SKIP_WAITING and reloads on `controllerchange`) and the status line says
  "Ready to play offline. An update is ready. Reload to use it." Without a Reload it takes over once no page of the
  app is open, so the installed app picks it up after a full close and reopen (checked in headless Chrome; a real
  Android phone is not checked). When another tab switches, the remaining tabs get the Reload toast again (also when
  they dismissed it before; one toast at a time). If the switch does not come within 5 s of a Reload, the page
  reloads anyway. A boot that fails switches to a waiting version at once (`updateIfWaiting()` in `showBootError`:
  a plain reload would get the broken version again, and the toast sits under the loading screen); the Reload buttons
  of the boot error and of the slow-boot notice (`window.__b3dReload`, which loads `install.js` on its own) switch
  first too. An installed app brought back from the recent apps list loads no page, so the page asks the worker to
  check for an update when it becomes visible, at most once an hour.
- **The update from v6.3**: its first load is served by v6.3's worker (network-first HTML, cached scripts), so this
  version's pages run v6.3's scripts once. `2d.html` loads `install.js` with a dynamic import and feature checks
  (v6.3's has no `mountOfflineStatus`; registration must not depend on it), and `index.html`'s slow-boot notice also
  counts the loading screen's own state (v6.3's `main.js` sets neither `__b3dBooted` nor `__b3dBootError`).
- **Caches**: `chess3d-shell-<VERSION>-<BUILD>` (the listed files, the list, the marker; written only by the install),
  `chess3d-runtime-<VERSION>-<BUILD>` (same-origin files that are not listed, fetched at runtime: network first for
  pages, stale-while-revalidate for scripts, cache first for media), `chess3d-cdn` (CDN files and fonts, kept across
  releases because their URLs carry the version; entries no version uses any more are dropped on activate). After the
  copy phase of an install, shells of other versions without a marker (downloads that never finished) are dropped once
  a version with a marker exists; a pre-6.4 shell (no marker) stays while it may be the one serving.
- **No endless waits**: the active worker answers only from its own caches; HEAD probes answer from the cache;
  a file that is not cached gives up after 15 s without an answer (pages that are not listed fall back to the cache
  after 4 s).
- **Progress**: the installing worker posts `{ type: 'OFFLINE_STATUS', version, state: 'installing' | 'ready' |
  'failed', done, total, error }` to every page (also uncontrolled ones). `GET_STATUS` asks for it; an active worker
  answers `ready` from its marker.
- First offline download (measured in headless Chrome): 176 files, 9.3 MB stored, about 6.5 MB over the wire with
  gzip (v6.3: 134 files, 6.6 MB, about 3.9 MB). The library packs are 2.5 MB of it.

## Pages

- `battle3d/install.js`: `mountOfflineStatus(el)`, `watchOfflineStatus(onChange)`, `offlineMarker()`,
  `offlineStatusText(status)`, `offlineReport()` (marker and last failed download; `__b3d.offline()` with
  `?debug=1`). One quiet line: "Ready to play offline.", "Preparing offline play: 60%", "Ready to play offline.
  Downloading an update: 40%", "Offline play is not ready yet. ..." (online and offline wording). A failing update
  keeps "Ready to play offline." (the previous version works). Screen readers hear changes of state through a visually
  hidden live region next to the line, not every percent. An `online` event lets an existing worker try again; it never
  registers one. The installed app also asks for persistent storage (`navigator.storage.persist()`, no prompt in
  Chrome).
- 3D menu: `#offline-status` above the Install section (also shown while the app runs installed). 2D page: the same id
  under the Controls buttons. Neither page shows it with `?debug=1` or `?nosw=1` (no worker is registered there).
- 3D boot (`main.js`): no HEAD probe (the production manifest is fetched, with a second try, and the dev manifest
  only where the production one does not exist); manifest, cast module and pack files give up after 30 s without an
  answer (`BOOT_WAIT_MS`), packs then fall back to the default characters with the existing notice. In `units.js`
  every file the loader fetches (a model's bytes, a `.gltf`'s buffers and textures) counts as progress; pending
  model, clip and prop loads fail (placeholder, as for a missing file) only when nothing has moved for 30 s. The boot
  lets one task pass after `createScene` before its first request: requests started in the task that ends the
  module's first run failed at once in Chrome, and a failed `import()` stays failed for the page (v6.3's HEAD probe
  failed the same way, without harm). The service worker is registered after the first frame, or after 30 s / a failed
  boot, so a first visit always gets offline play. `window.__b3dBooted` is set when the board is up,
  `window.__b3dBootError` when the boot shows its error.
- 3D loading screen: after 20 s without a board (and without a boot error), `#loading-slow` offers "Play the 2D game"
  (the boot goes on). The WebGL fallback and the boot error say when the device is offline. The fonts stylesheet loads
  with `crossorigin` and `media="print"` until loaded, so it never blocks the page.

## Release

After any change to a file of the game or to `sw.js`:

1. Bump `VERSION` in `sw.js` (the label users and logs see; the caches change with the stamp anyway).
2. `npm run offline-list`: rewrites `offline-files.json` and the build stamp in `sw.js`. Run it last: editing any
   listed file or `sw.js` afterwards makes the stamp stale again.
3. `npm test` (includes `tools/offline-list.js --check`).
4. Commit `offline-files.json` and `sw.js` with the change; new files must be committed with exactly the case the
   list uses. The workflow `.github/workflows/offline-list.yml` checks the same on the push.

## Tests

`tests/unit/offlineLists.test.js` (the list and the stamp are up to date, `sw.js`, the list and every listed file
are tracked by git with exact case, the stamp follows the list and the worker code, required versus optional, the
lists it is made of, hashes and build id equal in node and in the worker, download size, the status texts),
`tests/integration/battle3dServiceWorker.test.js` (install, retries, 404s of optional and required files, resume
after a failed try with per-deploy ETags, copy by content hash across versions, a copy whose content no longer matches,
an older partial download reused before it is dropped, stalled bodies, the install deadline, unfinished shells dropped,
CDN cache kept, a release without a new stamp, a missing list, a list from a deploy still spreading, downloaded bytes
that differ from the list, listed pages and scripts from one version, no drift of the active shell while a newer
install is pending, messages, marker, HEAD and cache-miss timeouts), `tests/integration/battle3dInstall.test.js` (the status line: percent on screen, announcements on a
change of state only, no registration from an `online` event), `tests/slow/offlineBrowser.test.js` (the cases above
in headless Chrome, with moves against the AI in 3D and 2D, an update that downloads only the list, and the update
from v6.3 itself: v6.3 from git first, then this checkout, the first 3D and 2D loads after it, the install that waits,
and a restart that switches).
