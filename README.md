# Web Chess Game

Try the game here:
https://d57udy.github.io/Chess-game-vibe-code/

## Features

- Play against the AI (adjustable ELO), watch AI vs AI, or play Human vs Human.
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

## Running locally

No build step. Opening `index.html` directly works, but browsers may block Web Workers on `file://`
URLs, in which case the AI runs on the main thread and the page can pause while it thinks. Serving
the folder with any static server keeps the AI in the worker, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

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

Tests live in `tests/` (`unit/`, `integration/`, `slow/`); `tests/helpers/` loads the classic
scripts into a `node:vm` context (`loadEngine.js`) or a jsdom window built from `index.html` (`loadDom.js`).

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout. Scripts load in order: `gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `battleFx.js`, `ui.js`. |
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
