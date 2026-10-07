# Web Chess Game

Try the game here:
https://d57udy.github.io/Chess-game-vibe-code/

The site opens the 3D game (`index.html`, see [Chess Battle 3D](#chess-battle-3d)). The classic 2D game is at
`2d.html` (https://d57udy.github.io/Chess-game-vibe-code/2d.html); each page links to the other. Old links to
`battle3d.html` redirect to the 3D game.

## 2D game (`2d.html`)

- Play against the AI (strength 400 to "Max", calibrated to human ratings), watch AI vs AI, or play Human vs Human.
- Play as White or Black. The board is drawn from your side; switching mid-game keeps the position.
- Pawn promotion dialog (Escape or clicking outside cancels the move).
- Hints (the AI suggests a move for the side to play).
- Move history with review mode: click a move or use the Left/Right arrow keys to look at earlier positions.
  While reviewing, the AI waits. Use "Resume from here" to continue from that position (later moves are
  discarded) or "Back to live" to return to the current position. Undo/Redo step back to your own turn.
- Last move highlight, check highlight, sounds (can be muted).
- Battle animations for captures (see below).

## Battle animations

Every capture plays a short scene on the board: the attacker strikes in its own style (pawn jab,
knight leap, bishop beam, rook charge, queen spin with stars, king bonk) and the victim reacts in
its own way (flattened, launched, toppled, crumbled, swooning). A few pairings and events have their
own scenes: pawn takes queen, queen takes pawn, knight takes queen, rook takes rook, bishop takes
bishop, en passant, capture with promotion, and capture that gives check. Checkmate ends with the
mated king toppling over.

- Settings, "Battle animations": Full (about 1 s per capture), Fast (about half), or Off (a plain
  fade). The choice is saved in the browser. Off is the default when the system asks for reduced
  motion. AI vs AI uses Fast unless a mode was picked explicitly.
- Click the board or press a key to skip a scene (a focused button or menu keeps Space, Enter and the arrow keys). Undo, new game and history navigation end it
  right away.
- `battleGallery.html` is a preview page that plays every attacker and victim pairing, the special
  scenes and the finale, at either speed and from either side of the board. It is not linked from
  the game.

## Chess Battle 3D

`index.html` (the default page; the 2D page links to it as "Play in 3D") is the same game on a 3D board: heroes
(White) against skeletons (Black). Pieces walk, knights leap, and every capture is a short fight with
camera shots, sound and effects. Rules, AI and draw detection are the same code as the 2D game.

- Modes: Human vs AI (default), Human vs Human, AI vs AI (uses Fast battles). AI strength slider from 400 to "Max" (about 2400), in human
  rating points (Lichess rapid style; see `docs/elo-calibration.md`). "Max" is the engine's real top strength.
- Play as White or Black (the camera moves to your side). New game, Undo (back to your own turn vs the AI).
- Hint (button or `H`, on your turn): the AI suggests a move at full strength. An arrow on the board points from
  the piece to the square, the piece is pre-selected and gives a small "ready" gesture, and the status line says
  e.g. "Hint: knight to f3." Nothing moves until you click the square. The hint goes away when you move, select
  another piece, undo or start a new game. Not available while the AI thinks, during fights, after the game
  ends or in AI vs AI.
- Battles: Full (cinematic fights, about 3 to 5 s) or Fast (about 1 s, no camera moves). Skip ends the
  current fight right away.
- Piece labels on or off, sound on or off, torch ambience on or off, a "Who's who" legend and the move list.
- Settings are saved in the browser (localStorage).
- Needs WebGL2. Without it the page offers the 2D game instead.

Controls:

| Input | Action |
|---|---|
| Click or tap a unit, then a highlighted square | Move |
| Touch: 1 finger drag | Rotate the view |
| Touch: 2 fingers | Zoom (pinch), move the view (drag) and turn it (twist) |
| Touch: double-tap | Zoom to that spot (double-tap again to zoom back out) |
| Mouse: drag, right-drag or Shift+drag, wheel | Rotate, move the view, zoom |
| Reset view (menu) | Back to the default view for your side |
| Arrow keys, Enter, Esc | Keyboard play: move the square cursor, select or move, cancel |
| Space (or the Skip button) | Skip the current fight |
| H (or the Hint button) | Suggest a move on your turn |

Moves and results are announced to screen readers.

**Install as an app (Android).** The 3D game is a Progressive Web App and works offline after the first
visit. In Chrome on Android, open the game menu (the three-line button at the top) and use the
"Install app" section, or Chrome's own menu > "Add to Home screen" / "Install app". On iPhone and iPad, use
Safari's Share button > "Add to Home Screen". The installed app opens full screen without the browser bar.

**Sound.** Every 3D sound is synthesized in the browser with WebAudio, so there are no audio files to license
or download (the 2D page keeps its own mp3s). Each sound is a small recipe (filtered noise bursts, modal
resonators for metal, wood and bone, low pitch-dropping "bodies" for thuds, envelopes) rendered into 2 to 4
variations on first use; every play picks a variation and adds a little pitch jitter. Footsteps follow the
walk animation (light, armored, heavy and bony steps), pieces settle on their square with a wooden thunk,
fights layer swings, clangs, hits, bone cracks, shatters and spell sounds, and check, checkmate, victory and
draw get their own cues. Sounds are panned by where they happen on screen and quieter further from the
camera, cinematic slow motion lowers their pitch, and a compressor and limiter keep busy fights clean. A very
quiet torch and room ambience can be switched off in the menu. Mute stops everything, and the game is silent
while the tab is hidden. `battle3d/sound-test.html` (served like the game, e.g.
http://localhost:8000/battle3d/sound-test.html) plays every sound and variation, walk cycles and fight
sequences with level meters.

**Cast customization.** "Cast..." opens the cast editor: choose a preset or pick the character model,
weapon, scale and tint for each piece, or import your own `.glb` (it must use the KayKit rig bone
names so the shared animations play on it). The cast is saved in the browser and the "Who's who"
legend follows it.

**Files** (all in `battle3d/`, ES modules unless noted, three.js from a CDN via an import map, no build step):

| File | Purpose |
|---|---|
| `rules.js` | Classic script. Applies moves on the `gameLogic.js` globals and returns move events for the 3D view. |
| `controller.js` | Turn flow, selection, AI, modes, HUD, keyboard play, settings. |
| `main.js` | Boot, loading screen, cast editor, legend, reset view and install wiring. |
| `scene*.js`, `cinematic.js` | Renderer, board and environment, camera, picking, highlights, effects. |
| `units.js`, `fights.js` | Characters, animation, movement and fight choreography. |
| `cast.js`, `cast-ui.js`, `unit-visuals.js` | Casting presets, cast editor, piece markers and labels. |
| `audio.js` | Sound bank, mixing, stereo positioning and ambience (all synthesized with WebAudio). |
| `sound-test.html` | Audition page: every sound and variation, walk cycles, fight sequences, level meters. |
| `install.js` | Service worker registration and the "Install app" menu section. |
| `assets/` | Optimized character, animation and weapon files, `manifest.json`, `CREDITS.md`. |
| `CONTRACT.md` | Interfaces between the modules. |

At the repo root: `manifest.webmanifest` (app name, icons, colours), `sw.js` (service worker) and `icons/`.

Add `?debug=1` to the URL for `window.__b3d` test hooks (`step(n)`, `state()`). See "Releasing" below for
how `?debug=1` and `?nosw=1` affect the service worker.

**Releasing (offline cache).** `sw.js` keeps the app shell (both pages, scripts, styles, three.js and the
default characters) in a versioned cache. On every deploy that changes files, bump `VERSION` at the top of
`sw.js`. The new worker precaches again, takes over open tabs, deletes the old caches and shows a small
"A new version is ready. Reload" toast; it never reloads by itself. HTML is fetched network first, but scripts,
styles and assets come from the cache until `VERSION` changes. Both pages register the worker, so the 2D page
works offline too. While debugging, `?nosw=1` unregisters the worker and bypasses it; `?debug=1` skips
registration but does not unregister an existing worker (DevTools > Application > Service workers can).

**Credits.** Characters, animations and weapons are from KayKit Character Pack: Adventurers 1.0 and
Skeletons 1.0 by Kay Lousberg (CC0 1.0), see `battle3d/assets/CREDITS.md`. 3D rendering uses
three.js (MIT). All 3D sound is synthesized in code, so no audio files need licensing.

## Running locally

No build step. Opening `2d.html` directly works, but browsers may block Web Workers on `file://`
URLs, in which case the AI runs on the main thread and the page can pause while it thinks. Serving
the folder with any static server keeps the AI in the worker, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000 (3D) or http://localhost:8000/2d.html (2D). The 3D page needs to be served
over http(s) (ES modules, service worker); it does not run from `file://`.

## Running tests

The game itself has no dependencies (GSAP loads from a CDN). The tests need Node 22+ and the dev
dependencies jsdom and gsap (the same GSAP version as the CDN, used to run battle scenes in jsdom):

```
npm install
npm test                  # unit + integration (about 12 s)
npm run test:unit         # rules, perft, engine, AI client/worker
npm run test:integration  # UI in jsdom (sounds stubbed; GSAP stubbed or real for battle scenes)
npm run test:slow         # engine self-play and a timing table (about 1 min)
```

The 3D mode has its own tests: `tests/unit/battle3dRules.test.js` and `battle3dAudio.test.js`, and
`tests/integration/battle3d*.test.js` (rules against the 2D UI, controller turn flow with stubbed scene
and units, units and assets). They run as part of `npm test`; to run only them:

```
node --test tests/unit/battle3d*.test.js tests/integration/battle3d*.test.js
```

Tests live in `tests/` (`unit/`, `integration/`, `slow/`); `tests/helpers/` loads the classic
scripts into a `node:vm` context (`loadEngine.js`) or a jsdom window built from `2d.html` (`loadDom.js`).

## Files

| File | Purpose |
|---|---|
| `index.html` | 3D game page (HUD, import map); loads `gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `battle3d/rules.js`, then `battle3d/main.js`. |
| `battle3d.html` | Redirect to `./` for old links. |
| `2d.html` | 2D page layout. Scripts load in order: `gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `battleFx.js`, `ui.js`. |
| `gameLogic.js` | Board state, move generation, game-end detection, history. |
| `aiPlayer.js` | Move search and evaluation. |
| `aiWorker.js` / `aiClient.js` | Runs the AI off the main thread; `requestAIMove()` returns a cancellable request. |
| `battleFx.js` | Capture scenes and the checkmate finale (`window.BattleFX`), the animation setting, skip and cancel. |
| `ui.js` | Rendering, input, animations, history review, AI orchestration. |
| `style.css` | Styles. |
| `battleGallery.html` | Preview page for all battle scenes. |

Captures go through `playCaptureAnimation(attackerPiece, victimPiece, squareEl, ctx)` in `ui.js`,
which hands the scene to `BattleFX.play()` or, with animations off, fades out the captured piece.
Scenes run on copies of the piece glyphs in `.battle-layer`, so the real pieces and the board
orientation are never touched. A scene always ends: when its timeline completes, on skip, on
`BattleFX.cancelAll()`, after a timeout, or when the tab is hidden (browsers pause animation frames
in background tabs).
