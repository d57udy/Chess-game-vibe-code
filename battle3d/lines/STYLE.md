# Talking kings: voice and line rules

Files in this folder:

| File | What |
|---|---|
| `hero-king.json` | White king's remarks, keyed by event type |
| `skeleton-king.json` | Black king's remarks, keyed by event type |
| `coach.json` | Coach templates, one voice per side |
| `validate.mjs` | Shape and style checks: `node battle3d/lines/validate.mjs` (exit 1 on error) |

Run the validator after every edit.

## The two kings

**Hero King** (White, a crowned knight). Pompous, chivalrous, vain, theatrical, secretly anxious. Talks about
ballads, tapestries, portraits, trumpets, his cape and crown. Brave words, then a nervous aside ("Please nobody
look at my knees."). Calls his own player "Commander". Calls the Skeleton King "bones", "bone bag", "Lord Rattles".
British spelling (armour, honour, practise).

**Skeleton King** (Black, a crowned skeleton mage). Dry, deadpan gallows humour, centuries of ennui. Bone and
death puns (humerus, grave, crypt, rest in pieces, no nerves, no lips, no eyelids), oddly specific old dates,
understatement ("Checked. Oh no. Anyway."). Calls his own player "Summoner". Calls the Hero King "tin can",
"tin crown", "shiny one", "Sir Shiny".

Both kings are fond of each other underneath. The rivalry is a double act, not a feud.

## Rules for every line

- Family friendly (PG). No profanity, no real people, no real groups, nothing about bodies other than cartoon
  skeleton jokes. Violence stays at cartoon chess level (pieces are "removed", "taken", "sent to the crypt").
- Kind-hearted snark: tease the opponent, the player, and often yourself. Never mean about skill; mistakes are
  funny, not shameful.
- Max 90 characters raw, 100 once slots are filled. One or two short sentences.
- Vary the shape: exclamations, deadpan fragments, questions, a setup and a turn. No two lines with the same joke.
- No em or en dashes and no " - " as a connector. Straight quotes only.
- Lines must read naturally for any piece type and any square that the slot can hold.

## Slots (king banks)

| Slot | Filled with | Example |
|---|---|---|
| `{piece}` | lower-case type of the piece that moved (the actor) | `knight` |
| `{captured}` | lower-case type of the piece that was taken | `bishop` |
| `{square}` | destination square of the move | `e4` |
| `{opponent}` | the other side's player name if set, else this file's `opponentFallback` | `Lord Rattles` |

Per event: `myCapture` piece = my capturer, captured = their piece. `lostPiece` piece = their capturer, captured =
my piece. `check` piece = my checking piece. `gotChecked` piece = their checking piece. `promotion` piece = the new
piece. A slot the event cannot fill means the line is skipped for that event (commentary picks another).

`{opponent}` works as a name, both as address ("Check, {opponent}!") and as subject. Never put "the" in front.

## Tags (king banks)

A line with no tags can be said in any mode. A tagged line is only eligible when all its tags hold.

| Tag | Line is eligible when |
|---|---|
| `retort` | only as a reply: the other king just spoke about this same move (see below) |
| `vsAI` | this king's side is human and the opponent is the computer |
| `vsHuman` | both sides are human |
| `aiKing` | this king's side is played by the computer |
| `myPlayer` | this king's side is human (the line addresses "Commander"/"Summoner") |

Every event keeps at least one untagged line, so there is always a fallback.

## File shape

`{ version, speaker: "hero"|"skeleton", side: "w"|"b", opponentFallback, events: { <eventType>: [line] } }`,
line = `{ text, weight?, minPly?, tags? }`. `weight` (default 1) raises the chance in the shuffle bag; used on one
signature line per frequent event. `minPly` keeps a line back until that many plies have been played.

## Who speaks for which event

Event types are from the speaking king's own point of view. For one move, the controller emits the pair:

| Mover's king hears | The other king hears |
|---|---|
| `myCapture` | `lostPiece` |
| `capturedQueen` | `lostQueen` |
| `check` | `gotChecked` |
| `blunderByMe` | `blunderByOpponent` |
| `brilliantMove` | (none, or the other king retorts) |
| `promotion`, `castle`, `enPassant` | (none) |
| `winningBig` | `losingBig` |
| `checkmateWin` | `checkmateLoss` |
| `mateThreat` (the threatening king) | `mateThreat` retort lines (the threatened king) |

Shared events: `gameStart`, `repetition`, `endgame`, `stalemate`, `draw` (either king). `hintUsed`, `undoUsed`: the
king of the side that used it speaks (untagged lines, self-voiced); the other king may tease with its own
`hintUsed` / `undoUsed` `retort` lines. `longThink` and `idle`:
spoken by the waiting king, teasing the side to move.

**Retorts.** After king A speaks, commentary may let king B answer from B's own key for that move (the counterpart
in the table above, or the same key for shared events and for `mateThreat`, `hintUsed`, `undoUsed`), choosing only `retort` lines. Retort lines are never used as
the first remark. Examples: A `check` then B `gotChecked` retort; A `myCapture` then B `lostPiece` retort; A
`lostPiece` then B `myCapture` retort.

## Coach templates (`coach.json`)

Spoken by the player's own king (hero voice when playing White, skeleton voice when playing Black). Warm,
encouraging mentor; a little of the character's flavour, but the chess explanation comes first and is plain
language. No engine numbers or jargon ("your knight on c3 is undefended", never "-2.3" or "eval").

Sections per voice: `classification` (inaccuracy, mistake, blunder, good, best, brilliant), `motif` (fork, pin,
skewer, hanging, backRank, missedCapture, allowsMate, missedMate, trappedPiece, discovered), `nudge` (threat,
hangingPiece, castleSoon, developPieces, controlCentre, kingSafety, endgameKingActive), `review` (wellPlayed,
closeGame, toughLoss, keyMoment). Max 100 characters raw.

| Slot | Filled with | Example |
|---|---|---|
| `{piece}` | the player's piece concerned | `knight` |
| `{square}` | the relevant square | `c3` |
| `{attacker}` | the enemy piece doing the attacking | `bishop` |
| `{target}` | the piece being attacked (player's, or theirs in praise and missedCapture lines) | `queen` |
| `{bestMove}` | the engine's best move in words | `knight to f3`, `bishop takes f7` |
| `{loss}` | material in words, a noun phrase | `about a pawn`, `a whole rook` |

Motif lines without tags explain a problem the player allowed or missed. Lines tagged `praise` describe the
player executing that motif (use them after a good, best or brilliant move). Coach picks a template whose slots it
can all fill; if no motif template fits, it uses the classification line.
