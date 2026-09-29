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

## Running locally

No build step. Opening `index.html` directly works, but browsers may block Web Workers on `file://`
URLs, in which case the AI runs on the main thread and the page can pause while it thinks. Serving
the folder with any static server keeps the AI in the worker, for example:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Running tests

The game itself has no dependencies. The tests need Node 22+ and jsdom (dev dependency):

```
npm install
npm test                  # unit + integration (about 12 s)
npm run test:unit         # rules, perft, engine, AI client/worker
npm run test:integration  # UI in jsdom (GSAP and sounds stubbed)
npm run test:slow         # engine self-play and a timing table (about 1 min)
```

Tests live in `tests/` (`unit/`, `integration/`, `slow/`); `tests/helpers/` loads the classic
scripts into a `node:vm` context (`loadEngine.js`) or a jsdom window built from `index.html` (`loadDom.js`).

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout. Scripts load in order: `gameLogic.js`, `aiPlayer.js`, `aiClient.js`, `ui.js`. |
| `gameLogic.js` | Board state, move generation, game-end detection, history. |
| `aiPlayer.js` | Move search and evaluation. |
| `aiWorker.js` / `aiClient.js` | Runs the AI off the main thread; `requestAIMove()` returns a cancellable request. |
| `ui.js` | Rendering, input, animations, history review, AI orchestration. |
| `style.css` | Styles. |

Capture animations go through `playCaptureAnimation(attackerPiece, victimPiece, squareEl)` in `ui.js`,
which currently fades out the captured piece.
