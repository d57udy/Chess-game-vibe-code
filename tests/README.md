# Tests

`npm test` runs everything under `tests/` with `node:test` (jsdom for the pages, three.js from
`node_modules` for the 3D modules). The long runs live in `tests/slow/` and only run with
`npm run test:slow` (`RUN_SLOW=1`).

## Rules test matrix

Which chess rule is checked where. "Engine" is the rule code itself (`gameLogic.js`,
`battle3d/rules.js`, the AI's own generator in `aiPlayer.js`). "2D view" and "3D view" are the pages
driven by clicks: what the board offers, what a move does to the position and to the screen, and
what the status line says. All three columns compare against chess.js (`tests/helpers/chessReference.js`,
a test-only devDependency).

File names are relative to `tests/`. `rulesUi2d` / `rulesUi3d` stand for
`integration/rulesUi2d.test.js` / `integration/rulesUi3d.test.js`; both run the same scenario tables
(`helpers/rulesUiScenarios.js`) through one adapter per view (`helpers/rulesUiDriver.js`).

| Rule | Engine | 2D view | 3D view |
|---|---|---|---|
| Legal moves of every piece in a position | `unit/rulesDifferential` (100-position corpus, scripted lines, playouts), `unit/rulesPerft` | `rulesUi2d` "offered moves": highlighted targets equal the legal targets for every piece, capture marks included | `rulesUi3d` "offered moves": same table, read from the scene's highlight meshes |
| A square that is not offered cannot be played | `unit/rulesEnPassant` (`battle3dApplyMove` refuses) | `rulesUi2d`: clicks on not-offered squares leave the position alone | `rulesUi3d`: same; the two shortcuts (king then own rook, pawn then the pawn it takes en passant) play their move only when it is legal |
| En passant: available, expired after one move, exposing the king along the rank, pinned pawn (file, both diagonals), while in check (three cases), files a and h, two capturers | `unit/rulesDifferential` corpus "en passant", `unit/rulesEnPassant` (pawn geometry, life cycle of the target) | `rulesUi2d` corpus "en passant" (21 positions, 10 of them also for Black) | `rulesUi3d` same table; how the capture looks and is explained: `integration/battle3dEnPassant` |
| En passant executed: the pawn beside disappears, target square, check uncovered along the rank | `unit/rulesDifferential` (MoveEvent, FEN after), `unit/rulesEnPassant` | `rulesUi2d` "executed special moves" (7 cases, 6 of them for both colours), also with the battle scene (real GSAP) | `rulesUi3d` "executed special moves", plus scenes played out at Full and Fast: units stand where the pieces are |
| Castling: both sides and colours, through / out of / into check, rook or b-file attacked, pieces in between, rights in the FEN | `unit/rulesDifferential` corpus "castling", `unit/rulesPerft` | `rulesUi2d` corpus "castling" (17 positions, 9 of them also for Black) | `rulesUi3d` same table, `integration/battle3dCastling` |
| Castling rights lost: king or rook moved and came back, rook captured at home (another rook stands there) | `unit/rulesDifferential` lines | `rulesUi2d` corpus "castling" (played by clicks), "executed special moves" (rights field after each move) | `rulesUi3d` same |
| Castling executed: rook lands on f/d file, O-O with check | `unit/rulesDifferential` | `rulesUi2d` "executed special moves" | `rulesUi3d` same, with scenes |
| Pins, double check, check evasion by capture, block and king move, positions with one legal move | `unit/rulesDifferential` corpus "pin", "check", "king" | `rulesUi2d` corpus "pins", "check" | `rulesUi3d` same |
| Promotion by push and by capture, every piece, both colours; chooser can be cancelled | `unit/rulesDifferential` corpus "promotion", `unit/rulesPerft` | `rulesUi2d` corpus "promotion", "executed special moves" (9 promotions x 2 colours), cancel test | `rulesUi3d` same |
| Clocks: half-move clock reset by pawn moves and captures, move number | `unit/rulesDifferential` (FEN after every move) | `rulesUi2d` "executed special moves" (clocks) | `rulesUi3d` same |
| Checkmate (also by promotion, underpromotion, castling) and stalemate: shown with the last move, not before | `unit/rulesDifferential` corpus "end" | `rulesUi2d` "game end and draws" | `rulesUi3d` same (the mated king is the only unit lying on the board) |
| Threefold repetition: counts castling rights and a real en passant right, ignores a double push nobody can capture | `unit/rulesDifferential` lines (`threefoldAt`) | `rulesUi2d` "game end and draws" (4 lines, exact ply) | `rulesUi3d` same |
| 50-move rule: draw with the 100th half-move, reset by pawn move or capture, mate on the 100th half-move wins | `unit/rulesDifferential` corpus "50 moves" and lines | `rulesUi2d` "game end and draws" | `rulesUi3d` same |
| Insufficient material: K v K, K+B v K, K+N v K, K+B v K+B same colour are draws; opposite bishops, K+N+N v K, K+B v K+N, K+N v K+N play on | `unit/rulesDifferential` corpus "material" | `rulesUi2d` "game end and draws" (reached by capture or underpromotion) | `rulesUi3d` same |
| A finished game takes no more moves; the AI is not asked again | (n/a) | `rulesUi2d` "game end and draws": nothing offered, clicks inert, human vs AI and AI vs AI | `rulesUi3d` same |
| Undo (and Redo in 2D) restores the exact FEN: rights, en passant square, clocks; en passant and castling offered again | `unit/rulesEnPassant` (undo, redo, snapshot), `unit/rulesDifferential` (undo of every legal move) | `rulesUi2d` "executed special moves" (undo, redo, undo, play again), "undo keeps the rules state", history navigation | `rulesUi3d` same without Redo; review mode locks the board |
| Undo against the AI takes back both plies; undo while the AI thinks; late AI answer ignored | (n/a) | `rulesUi2d` "undo keeps the rules state" | `rulesUi3d` same, `integration/battle3dEnPassant` part B |
| The AI's move is legal and lands as the reference plays it (en passant, castling, promotion, underpromotion) | `unit/rulesAiMoves` (worker hand-off, main thread, six strengths with capped node budgets; coach analysis lines), `slow/rulesDifferentialDeep` (real node budgets) | `rulesUi2d` "human vs AI" (supplied answers), "the engine as opponent" (real engine in the page) | `rulesUi3d` same (engine answers computed from the state the page hands over) |
| An illegal or missing AI answer is refused, asked for once more, then replaced by the first legal move with a notice | `unit/rulesEnPassant`, `unit/battle3dRules` (`battle3dApplyMove` throws and leaves the position alone) | `rulesUi2d` "human vs AI" (position unchanged, logged with move and FEN, second request, fallback move and notice), `integration/ui.test.js` | `rulesUi3d` same shared tests; `integration/battle3dAiRecovery`: logged with move and FEN, one retry, then the first legal move is played with a notice (also for a missing answer or a failed request) |
| Notation in the move list | `unit/rulesDifferential` (SAN of every legal move) | `rulesUi2d`: list equals the reference SAN after every move (the "e.p." mark aside) | `rulesUi3d` same |
| Whole games: seeded random playouts, every ply compared | `unit/rulesDifferential` (10 x 50 with undo, and the reported 40-ply game as a scripted line), `unit/battle3dRules` (25 games), `slow/rulesDifferentialDeep` (200 x 200, every legal move applied), `slow/battle3dRulesFuzz` | `rulesUi2d` (3 games, 78 plies by clicks), `slow/rulesUiPlayouts` (30 x 120) | `rulesUi3d` (2 games, 56 plies, 3D and 2D side by side), `slow/rulesUiPlayouts` (15 x 100, scenes skipped and played) |
| Pointer input: a click on the screen becomes the right square | (n/a) | clicks are click events on the piece and square elements in every `rulesUi2d` test | `rulesUi3d` "real pointer clicks": en passant, castling and capture with promotion played by pointer events through the scene's ray picking, both colours and views; a click on the middle of an offered square that lies behind a unit; a click on the pawn taken en passant; a click on a unit itself; a sweep over every offered square of two positions (`slow/rulesUiPlayouts`: of the whole table and its mirror, from both sides). The picking itself (figure against proxy, sweep of 345 targets from both sides, eight camera states): `integration/battle3dClickTargets`; with touch-sized proxies and taps: `integration/battle3dClickTargetsTouch` |
| En passant shown as such: "e.p." after the move in the list (stored notation stays standard), the square of the captured pawn marked, the rule explained the first three times on a device in the words that fit who captured | (n/a) | `rulesUi2d` "executed special moves" (label and marks after every special move), "human vs AI" (explanation), "en passant on the page" | `rulesUi3d` same shared tests; `integration/battle3dEnPassant` |
| The reported game, move for move against the AI: 20. b4 axb3 e.p., the b4 pawn gone, Undo takes both plies back | `unit/rulesDifferential` (scripted line) | `rulesUi2d` "human vs AI" | `rulesUi3d` same, `integration/battle3dEnPassant` part C |
| A move in progress cannot be disturbed: Undo, Redo, Escape, board clicks, New Game, mode switch; the AI is asked only after the move, for the position after it | (n/a) | `rulesUi2d` "a move in progress cannot be disturbed" (also: a save taken meanwhile is a whole position), "a move in progress and the other controls of the page" (keys, move list, colours, hint, strength, AI vs AI), autosave and Load during a move | `rulesUi3d` "a move in progress cannot be disturbed" |
| Save, load, PGN export and import keep the rules state: same FEN (en passant square, castling rights partly lost), same offered moves, play and Undo go on | `unit/savegame`, `slow/savegamePgnSweep` | `rulesUi2d` "a saved game comes back as it was", and the page reopened with its autosave ("Save / Load and the autosave around a move in progress, and the page reopened"); the panel: `integration/saves2d` | `rulesUi3d` same shared tests (load into the running page); the page reopened: `integration/battle3dSaves*` (one 3D page per test process) |
| Move generation depth (perft) with capture, en passant, castle, promotion, check and mate counts | `unit/rulesPerft`, `slow/rulesPerftDeep` (through `battle3dApplyMove` and through the AI's generator) | (n/a) | (n/a) |
| A hand-written FEN or state whose en passant target or castling rights do not fit the position | `unit/rulesEnPassant` (target and rights are dropped, no generator uses them) | (n/a) | (n/a) |

`slow/rulesUiPlayouts.test.js` also reruns every table entry for both colours and clicks all 64
squares for every piece. The fast suites run the Black mirror of the entries marked `both`, click
the squares a piece could be thought to reach (all 64 on the two bare en passant positions), and
stop at the offers on crowded boards and on the mirrored entries.

### The files behind the matrix

| Area | Files |
|---|---|
| Views by clicks (this matrix's 2D and 3D columns) | `integration/rulesUi2d.test.js`, `integration/rulesUi3d.test.js`, `slow/rulesUiPlayouts.test.js`; `helpers/rulesUiDriver.js` (the two adapters), `helpers/rulesUiScenarios.js` (tables), `helpers/rulesUiSuite.js` (shared tests) |
| Rules engine against chess.js | `unit/rulesDifferential.test.js`, `unit/rulesPerft.test.js`, `unit/rulesEnPassant.test.js`, `unit/rulesAiMoves.test.js`, `slow/rulesDifferentialDeep.test.js`, `slow/rulesPerftDeep.test.js`; `helpers/chessReference.js`, `helpers/perftSuite.js`, `fixtures/rules-corpus.json` |
| En passant as the 3D view shows it, AI recovery, what a click means | `integration/battle3dEnPassant.test.js`, `integration/battle3dAiRecovery.test.js`, `integration/battle3dClickTargets.test.js`, `integration/battle3dClickTargetsTouch.test.js` |
| Save, load, autosave, PGN | `unit/savegame.test.js`, `integration/saves2d.test.js`, `integration/battle3dSaves.test.js`, `integration/battle3dSavesBoot.test.js`, `integration/battle3dSavesReboot.test.js`, `integration/battle3dControllerLoadGame.test.js`, `slow/savegamePgnSweep.test.js`, `slow/savesBrowser.test.js`; `helpers/saveGameHarness.js`, `helpers/headlessChrome.js` |
| Older view tests that also touch rules | `integration/ui.test.js` (2D), `integration/battle3dRulesVsUi.test.js`, `integration/battle3dCastling.test.js`, `unit/battle3dRules.test.js`, `slow/battle3dRulesFuzz.test.js` |

### Known gaps

- 3D input starts at the square level (`controller.clickSquare`, the callback the scene calls) in
  all tests but "real pointer clicks". The pointer path is covered from the default camera of each
  side only (no orbiting, zoom or touch), and a square whose middle is hidden behind a figure (about
  4% of the offered squares, mostly the one behind the king itself) has to be clicked beside the figure.
- 2D clicks are real click events on the piece and square elements, but jsdom has no layout: that a
  piece is drawn where its `left` / `top` says is taken on trust.
- Draws are automatic at the third repetition and the 100th half-move. There is no claim flow, and
  dead positions beyond the material cases in the table are not detected (by design, see
  `hasInsufficientMaterial` in `gameLogic.js`).
- The 2D battle scenes run with the real GSAP for five captures only (en passant for both colours
  and towards the a-file, capture with promotion, plain capture); the other tests use the plain fade.
- Loading a position into the 2D page uses the test helper (`loadPosition`); the page itself has no
  position input. The 2D page is booted with every script of `2d.html` (`helpers/saveGameHarness.js`
  `load2dPage`), so autosave runs during the rules suites; the Save / Load panel itself is tested in
  `integration/saves2d`.
- The 2D view applies a move in two steps (board first, rights, clocks and side to move after the
  animation). Nothing on the page can act in between (tests above), but code that reads the rules
  state directly during an animation would see the first half only.
