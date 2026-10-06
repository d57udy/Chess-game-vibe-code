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
