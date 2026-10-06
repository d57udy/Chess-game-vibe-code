# 3D battle chess: design, choreography and production research

> Research snapshot as of 2026-10-02; prices and versions change. This is one of four research reports behind the [3D battle plan](../README.md). Light edits only (title, this note); content and sources are unchanged unless marked.


Date: 2026-10-02. Scope: research and design only, no code changes. Builds on the existing 2D capture system (`battleFx.js`, composition rule "signature pairing, else attack[attacker] + impact + death[victim]") and an earlier internal 2D proposal (not included in this folder; path removed in this copy).

Citation style: `[n]` refers to the Sources section. Items marked **(unverified)** came from search snippets of pages that blocked direct fetching, or are my own estimates.

## TL;DR

* Animated chess captures are a proven hook with a proven failure mode: every product in this niche (Battle Chess 1988, Combat Chess 1997, Battle vs Chess 2011, Game of Kings 2015, chess.com Battle Mode) drew the same complaint, that the scenes are fun a few times and then get switched off [3][4][8][13][15]. Design for that from day one: short default fights, a fast mode, skip, and a "show each pairing in full once" policy.
* "BATTLE CHESS" is a live US trademark of Interplay for downloadable video games (Reg. 6610412, 2022) [5], and Interplay has enforced it against "Battle vs. Chess" [7]. Do not use "Battle Chess" (or "Battle ... Chess" variants) in the product name, and do not recreate its signature gags (rock monster rook, Black Knight limb gag, Indiana Jones gun parody) [1].
* Recommended theme: **Clockwork Toybox** (two wind-up toy armies). Rigid, segmented hard-surface parts are the cheapest thing to keep consistent with AI-assisted generation, rig without skin weighting, and "kill" without gore (springs pop, gears scatter, the toy winds down). Two alternatives are evaluated below.
* Choreography: 30 legal pairings (6 attackers x 5 victims, the king is never captured) built from **per-attacker attack sets + per-victim reaction/death sets + 6 to 8 bespoke paired scenes**, aligned at runtime on a shared "battle anchor" with a contact-frame sync. About 100 to 130 clips total for the full cast, shared across both armies via one rig per role.
* Target durations: Full 2.5 to 4 s, Fast about 1.2 s, Instant (no cut, about 0.4 s). AI vs AI defaults to Fast with no camera cuts.
* Production: a solo PM with AI assistants can reach a playable 3D prototype with CC0 assets in about 3 weeks of part-time work, and a vertical slice in another 5 to 7. The full bespoke cast is the expensive part; budget scenarios range from about $0 to $500 (AI and CC0 only) up to about $25k to $60k (freelance modeling and animation) **(estimate)**.

---

## 1. Prior art

### 1.1 What exists and what players said

| Title | Year | Format | What worked | What players complained about | Sources |
|---|---|---|---|---|---|
| Battle Chess (Interplay) | 1988 | Isometric animated pieces, 2D board toggle | Humor and personality, 35 distinct battle scenes, movie parodies, "what happens if X takes Y" curiosity; sold 250,000 by 1993 | Scenes take 5 to 10 s per capture, game feels sluggish, weak chess AI; players switch to the 2D view, which loses the animations | [1][4] |
| Battle Chess II: Chinese Chess / Battle Chess 4000 | 1990 / 1992 | Same formula, xiangqi; sci-fi clay animation | Theme variety (4000 was a sci-fi spoof) | Same pacing issue | [1] |
| Combat Chess (Empire) | 1997 | 3D pieces, battle animations | Animations described as impressive | GameSpot: battle animation "simply a novelty, which wears thin rather quickly" (6.2/10); Pelit noted the camera hid smaller pieces behind larger ones | [8][9] |
| Battle vs. Chess / Check vs. Mate (TopWare) | 2011 | 3D fantasy armies | Optional 2D view, animations can be disabled | Few attack animations per piece, so it gets repetitive; trademark suit forced a rename in North America | [7][15] |
| Battle Chess: Game of Kings (Olde Sküül, Interplay) | 2015 | Full 3D remake, idle animations, several battlegrounds | Dozens of combat and idle animations | 52% positive of 360 Steam reviews; "the novelty definitely wears off, to the point of me turning off the animations"; only one animation for common endgame pairings such as Queen vs King; developer cited content rating as a constraint | [2][3] |
| chess.com "Battle Mode" | 2016, later removed | 2D capture effects | Liked for replays of won games and casual blitz | "Good to watch 1 to 2 times ... not for always"; "too violent for me"; "kid's stuff" | [13] |
| Archon (Free Fall / EA) | 1983 | Chess-like board, capture opens a real-time arena fight | Captures are a skill contest, so they never feel like a cutscene | Not chess rules; different genre | [10] |
| Star Wars holochess (dejarik) | 1977, revived 2015 onward | Stop-motion creatures on a round board (Phil Tippett, Jon Berg) | Iconic because each creature has a strong, distinct silhouette and a short, readable motion | Film reference only; Lucasfilm IP, do not copy creatures | [11] |
| Wizard's Chess (Harry Potter) | Book 1997, film 2001 | Stone pieces that obey spoken orders and smash captured pieces | The "commander giving orders to living pieces" fantasy, pieces that talk back | Warner Bros. IP; the smashing is the brutal tone to soften | [14] |
| Chess Ultra (Ripstone) | 2017 | Photoreal 3D boards, VR | Environments and presentation; 76% positive on Steam | No capture fights; shows the audience for "premium board" presentation | [12] |

### 1.2 Lessons

1. **Repetition is the core risk, not quality.** Even good animation becomes a tax by the tenth game [3][8]. Variety per pairing plus aggressive length control matters more than polish.
2. **Long scenes push players to the 2D view**, which then removes the feature entirely [4][15]. A "Fast" mode that keeps a short, satisfying hit is better than a binary on/off.
3. **Camera occlusion** of small pieces behind large ones was already a criticism in 1997 [9]. An RTS camera makes this worse unless occluders fade.
4. **Endgame pairings repeat most** (Queen or Rook vs lone pieces) [3]. Give the late-game common pairings the most variants, not the rare ones.
5. **Tone and rating** constrained even the official remake [3]. Choose a theme where "defeat" is naturally non-violent.
6. **Personality sells it** (Battle Chess parodies, Wizard's Chess pieces that talk back) [1][14]. Short voice barks and idles carry personality without lengthening captures.

### 1.3 IP and trademark

| Item | Status | Implication |
|---|---|---|
| "BATTLE CHESS", US Reg. 6610412, Serial 87188582, class 9 (downloadable video game software), owner Interplay Entertainment Corp., registered 2022-01-11, first use 1988 | Live/registered [5] | Do not name the product "Battle Chess" or anything likely to be confused with it. |
| "BATTLE CHESS", Reg. 6124855, Serial 87173349, board games | Cancelled under Section 18 (2021) after an opposition proceeding involving Ye Olde Gaming Companye [6] **(unverified, snippet only)**. *Correction added in this copy: the plan review checked USPTO TTABVUE 92077183; it was Interplay that petitioned to cancel Ye Olde Gaming Companye's registration, and it won by default. This is a second enforcement action by Interplay.* | Not a green light; the video game mark above is the relevant one. |
| Interplay v. TopWare ("Battle vs. Chess") | Default judgment for Interplay, settlement about $200,000 plus interest (2012); the game was renamed "Check vs. Mate" for North America [7] | Interplay enforces the mark. Note the judgment was by default, not a ruling on the merits, but it still shows willingness to sue. |

What to avoid copying (expression, not the general idea of animated captures):

* Specific Battle Chess characters and gags: the rook turning into a rock monster that eats the queen, the knight vs knight Monty Python Black Knight limb gag (also Monty Python's material), the king vs bishop Indiana Jones parody [1].
* Holochess creatures (Lucasfilm), Wizard's Chess stone pieces and the film's visual design (Warner Bros.) [11][14].
* Box art, logo typography, or the phrase "Battle Chess" in marketing copy. A descriptive phrase like "animated captures" is safer.

Naming direction: invented names such as "Clockwork Gambit", "Checkmate Toybox" or "Gambit Tactics". Run a USPTO search before publishing anything public. This is not legal advice; a short trademark attorney check is cheap insurance before any commercial release.

Repo note: internal file names (`battleFx.js`, `battleGallery.html`) and README wording "battle animations" are generic and fine.

---

## 2. Character concept and art direction

### 2.1 Art direction: stylized over realistic

| Factor | Stylized low-poly / toon | Realistic |
|---|---|---|
| Consistency across 12 characters made with AI tools and different freelancers | High. Flat colors and simple shapes hide differences in authoring | Low. Material, proportion and detail mismatches are obvious |
| Texture cost | Palette texture or vertex colors, one shared atlas | PBR maps per character (albedo, normal, roughness, AO) |
| Animation tolerance | Exaggeration and snappy timing read as intentional | Needs mocap level nuance; keyframed flaws look wrong (uncanny) |
| Browser performance | 1.5k to 5k triangles per piece, 32 pieces on screen is light | High poly plus PBR on 32 skinned meshes stresses mobile GPUs |
| Rating and tone | Violence reads as cartoon or fantasy [19] | Same action reads as more violent |
| Readability from a high RTS camera | Exaggerated silhouettes survive distance (TF2 approach) [16] | Fine detail is lost at distance anyway |

Valve's Team Fortress 2 paper is the standard reference: characters designed so they are identifiable from silhouette alone, with team identity, role and weapon readable at a glance, and warm to cool shading instead of black shadows [16]. Apply the same three questions: friend or foe (team), which piece (role), and is it threatened (state).

### 2.2 Readability rules for an RTS camera

| Rule | Detail |
|---|---|
| Height ladder | Pawn 1.0, Knight 1.4, Bishop 1.6, Rook 1.6 but twice as wide, Queen 1.8, King 2.0 (relative). Same order as a Staunton set, so chess players do not need to learn it. |
| Staunton head echo | Each character's head or headgear echoes the classic top: bishop mitre slit, rook crenellation, knight horse head, queen spiked crown, king cross. A chess player should identify every piece from above at 30 to 60 degrees. |
| Team by value, not just hue | One army light (ivory, cream), one dark (ebony, charcoal), plus a team accent with a colorblind safe pairing (blue vs orange works for the common red/green deficiencies). Never rely on hue alone [20]. |
| Base disc | Every piece stands on a round base in the team accent color. Bases carry state: selection ring, threat ring, check pulse. Bases stay readable even when the body is occluded. |
| Toggleable glyph labels | Optional floating chess glyph or letter above each piece for beginners and accessibility. |
| Occlusion | Pieces between the camera and the cursor or selected piece dither fade (lesson from Combat Chess) [9]. |

### 2.3 Non-humanoid pieces (knight, rook)

* **Knight**: either a rider on a mount (two rigs, expensive) or a single creature with a horse head (one quadruped or biped rig). For a small team: one biped with a horse head silhouette, or in the toy theme a rocking horse or hobby horse soldier (one rig, no rider sync).
* **Rook**: the hardest. Options: a walking tower on legs, a tower on wheels or treads, or a tower that hides a small operator who pops out. Treads plus a hatch is cheap: the body is rigid, treads are a UV scroll, and the "personality" lives in the hatch and a periscope or cannon.
* **Rule of thumb**: design non-humanoids as rigid parts with a few bones (hard-surface segment rig). Each mesh part is 100% weighted to one bone, which removes skin weighting problems and works well with AI-generated or kitbashed parts.
* **Retargeting**: humanoid roles (pawn, bishop, queen, king) can share one humanoid skeleton and reuse CC0 or Mixamo libraries [25][26]. Knight and rook need custom clips regardless.

### 2.4 Theme options

| Option | Concept | Pros | Cons |
|---|---|---|---|
| **A. Clockwork Toybox (recommended)** | Two wind-up toy armies on a nursery floor or toy-shop table: Porcelain Guard (ivory, blue enamel) vs Iron Legion (black iron, orange enamel) | Rigid parts suit AI generation and segment rigs; deaths are mechanical (spring pops, gears scatter, wind-down, tip over), so PEGI 7 / ESRB E10+ territory is plausible [19]; non-humanoids are natural (rocking horse knight, tin tank rook); wind-up keys give an idle and "ready" animation for free; board can be a toy-box lid | Risk of looking generic; toy soldier imagery is common (not protected, but avoid copying specific franchises such as Toy Story or Nutcracker designs) |
| B. Living carved pieces | Staunton-like wooden pieces with faces and small arms, no legs, hop on their base | Most readable for chess players; trivial silhouettes; very cheap to model; closest to "chess but alive" | Limited expressive range for fights; may feel close to Battle Chess's animated pieces in spirit; deaths are splinters or toppling, which is fine |
| C. Sun vs Moon elemental kingdoms | Light army of sun knights and glass golems vs night army of moths, owls and shadow golems | Strong team identity by design language, not only color; rich VFX; creature variety (knight as a griffin, rook as a golem) | Highest asset cost (two distinct casts, 12 unique rigs); VFX heavy; consistency hardest with AI tools |
| D. Animal kingdoms (optional) | Badger and fox militaries, rabbit pawns, owl bishops, bear rooks | Charming, broad appeal | Fur and faces are harder for AI generators to keep consistent; quadruped and biped mixes complicate rigs |

### 2.5 Recommended cast: Clockwork Toybox

Both armies use the same rig and the same clips per role; they differ in mesh details, materials and voice barks. That halves animation cost while still giving two personalities.

| Role | Porcelain Guard (light) | Iron Legion (dark) | Signature move and personality |
|---|---|---|---|
| Pawn | Drummer boy toy with a toy bayonet | Tin trooper with a spoon spear | Eager, jabby, marches in step; idle drum taps; promotion is the big moment |
| Knight | Rocking horse cavalier (horse head body, short lance) | Tin hobby horse lancer | Show-off; hop and gallop arcs, rears up before charging |
| Bishop | Music box cleric with a crank organ crozier | Clockwork astrologer with a brass orrery staff | Ranged "sound wave" or "orrery beam" attacks, diagonal sweeps; prim and fussy |
| Rook | Porcelain castle on caster wheels, a small soldier in the turret | Iron siege tank tower on treads, periscope | Heavy brute; slow wind-up, ram, cork cannon; turret hatch peeks for personality |
| Queen | Ballerina music box automaton with fan blades | Iron sorceress with a spinning top skirt | Fast spins and pirouette strikes; the most variants (she captures most often) |
| King | Porcelain king with a too-large key on his back | Iron king with a pocket watch scepter | Reluctant, fussy, hides behind others; never dies, only "surrenders" (winds down, crown topples) |

Defeat language (all roles): key spins off, spring pops out of the chest, plates crack into a few large chunks (no fragments resembling body parts), the toy winds down and tips over, then sinks into the board or is "collected" off-board by a toy-box claw or puff of dust.

---

## 3. Combat choreography system

### 3.1 Pairing count

Legal capturer/victim pairs: 6 attacker roles x 5 victim roles (king is never captured) = **30 pairings**. En passant (pawn x pawn variant), capture with promotion, and capture with check or mate are event modifiers on top.

### 3.2 Composition model

```
if bespoke[attacker x victim] and policy allows  -> play paired bespoke scene
else -> approach[attacker] + exchange(attack variant[attacker], parry?[victim])
        + finisher[attacker, hitType] + death[victim, hitType] + exit
```

Each attack clip is tagged with a **hit type** (thrust, smash, sweep, ranged/magic, trample, bonk). Each victim has deaths for 3 hit groups (blunt knockback, crush, magic/ranged). This gives every pairing a distinct look from a small library, matching how the 2D `battleFx.js` already composes attacker and victim parts.

### 3.3 Synchronization (how two clips line up)

* **Battle anchor**: a transform placed on the destination square, oriented along the attacker's approach direction. The victim's root is placed at the anchor; the attacker's root at anchor minus `contactDistance[attackType]` along that direction.
* **Bespoke scenes** are authored as true paired animations: both characters animated in one Blender scene around a shared origin, exported as two clips, and played with both roots snapped to the anchor. This is the same principle as Unreal's Contextual Animation system and Motion Warping (align actors to a shared transform, warp root motion toward named targets) [17]. In a web engine (three.js or Babylon.js) it is just two `AnimationAction`s started at the same time with roots placed at the anchor.
* **Composed scenes** use a **contact frame** marker: each attack clip stores the time of impact, each reaction clip stores the time it expects to be hit. At runtime, start the reaction so both markers coincide, then hit-stop on that frame. Distance classes: melee (about 0.7 square), reach (about 1.0 square), ranged (1.5 squares or more).
* **Approach**: the attacker travels from its origin square using its move clip (walk, gallop, roll, hop for the knight), compressed for long moves (rook or queen across the board: speed ramp so travel never exceeds about 0.8 s in Full).
* **Neighbors**: pieces on adjacent squares play a "flinch" or "watch" look-at so the scene feels staged on a living board, and do not collide with the fight space (a square is about 1 unit; keep fight motion inside 1.5 units of the anchor).

### 3.4 Beat structure and target durations

| Beat | Content | Full | Fast | Instant |
|---|---|---|---|---|
| Approach | Travel to contact distance, speed ramped | 0.3 to 0.8 s | 0.3 s | slide, 0.25 s |
| Square up | Face each other, short anticipation | 0.2 s | cut | cut |
| Exchange (optional) | 1 to 2 strikes, defender parries once ("parry then lose") | 0.6 to 1.0 s | cut | cut |
| Finisher | Decisive hit, hit-stop, VFX burst | 0.4 s | 0.3 s | flash only |
| Death | Hit-type specific defeat | 0.6 to 0.8 s | 0.4 s | fade 0.15 s |
| Exit | Attacker settles on square, remains sink or get collected, camera returns | 0.3 to 0.5 s | 0.2 s | none |
| **Total** | | **2.5 to 4.0 s** | **about 1.2 s** | **about 0.4 s** |

Compare: Battle Chess captures ran 5 to 10 s and were the main complaint [4]. The current 2D build uses about 1 s Full and 0.5 s Fast (README). A 3D Full mode can afford more because of the camera payoff, but should stay under 4 s.

**"Parry then lose"**: the defender gets one parry or dodge in about half of Full scenes, so the victim has a moment of agency before losing. Higher value victims (queen, rook) parry more often, which also signals that the capture mattered.

### 3.5 Variety without content explosion

| Lever | How |
|---|---|
| Variants | 2 attack variants per attacker (3 for the queen and rook, the most frequent late-game capturers [3]); 3 deaths per victim |
| Shuffle bag | Random without immediate repeats per pairing; store "last variant" per pairing |
| First-time showcase | The first time a pairing occurs (per profile, stored in localStorage), play its bespoke or full scene; later, prefer the short exchange. Creates "collection" curiosity like Battle Chess [1] |
| Context modifiers | Low-value takes high-value (pawn takes queen) gets the bespoke "upset" scene and a crowd gasp; capture that gives check adds a taunt pose |
| Unlocks (optional) | Extra variants unlocked by achievements, as players suggested for Game of Kings [3] |
| Procedural seasoning | Random camera side within the 180 degree rule, random bark, small timing jitter (5%), randomized debris |

### 3.6 Bespoke pairings (6 to 8)

Pick by frequency and story value: Pawn x Queen (upset), Queen x Pawn (contempt), Knight x Bishop, Rook x Rook (sumo shove), Bishop x Bishop (duel of instruments), Queen x Queen (dance-off), Pawn x Pawn en passant, Knight x Queen. Each is a true paired clip (2 clips) at about 3 s.

### 3.7 Special moves and game events

| Event | Scene | Length (Full / Fast) |
|---|---|---|
| En passant | Victim pawn has just marched past; attacker taps it on the shoulder from behind, victim turns, gets bonked. Camera shows the pawn's real square and the capture square (the rule is confusing for beginners, the scene teaches it) | 2.5 s / 1 s |
| Promotion | Pawn reaches last rank, steps onto a wind-up turntable, pieces spin into a blur, model swap at the brightest frame, new piece poses. If capture-promotion: fight first, then transform | 2 s / 0.8 s |
| Castling | Non-combat: rook rolls past, king hops over it, both salute. Shows the two-piece move clearly | 1.5 s / 0.6 s |
| Check | Checked king plays "alarm" (startle, looks at attacker), checking piece points; base ring pulses. No camera cut | 0.8 s overlay, never blocks input |
| Checkmate | Finale: camera orbits mated king; king winds down and the crown topples, victorious army cheers. No king "death", consistent with chess and the Game of Kings developer note [3] | 4 to 6 s, skippable |
| Stalemate / draws | Both kings shrug, pieces sit down on their bases; a "draw" banner | 2 s |
| Resign | Resigning king lays down its scepter | 1.5 s |

### 3.8 Pacing modes and skip

| Setting | Behavior |
|---|---|
| Battles: Full | Cinematic camera, exchanges, bespoke scenes |
| Battles: Fast (default after first 3 games, or always in AI vs AI) | No camera cut; fight plays in place from the player's camera; finisher plus death only |
| Battles: First time only | Full for the first occurrence of each pairing, Fast after |
| Battles: Off / Instant | Slide and fade, no hit-stop or shake |
| Skip | Click, tap, Escape or Space skips to the end state immediately, as in the current 2D build |
| Reduced motion | Defaults to Instant, no shake, no camera moves |

AI vs AI: Fast, no cuts, finale only on mate. XCOM 2 is a useful warning: players asked to disable automatic camera moves and "action cams", and the fix that shipped was a global action cam toggle plus "Zip Mode" [23]. Offer both equivalents from the start.

Engineering constraint carried over from the 2D build: game state never waits on an animation that might not finish. Every scene resolves on completion, skip, timeout, or tab hidden, and the board state is applied regardless.

### 3.9 Cinematic camera rules

1. **Line of action**: the axis from attacker to victim. Choose the battle camera on the side of that line closest to the player's current camera, and never cross it within a scene (180 degree rule) [22]. This keeps attacker and victim on consistent screen sides.
2. **Prefer moves over cuts**: blend from the player camera into the battle framing over about 0.4 s (an orbit plus dolly). At most one cut per scene, used for the finisher close-up, and only in Full mode.
3. **Two-shot framing**: frame both characters at about 3/4 view, attacker on the side it approaches from, both within the middle two thirds of the frame. Camera height slightly below chest height of the taller character gives weight; for very uneven pairs (pawn vs rook) frame on the smaller character and let the larger one break the frame.
4. **Occlusion**: dither fade any piece inside the camera to subject capsule.
5. **Return**: save the exact player camera state (target, yaw, pitch, zoom) and blend back to it over about 0.4 s. Never leave the player in a different view than they chose.
6. **No camera moves** in Fast, Instant, reduced motion, or AI vs AI unless the user opted into a "spectator cinematic" mode.

### 3.10 Hit-stop, VFX, audio

* **Hit-stop**: freeze both characters on the contact frame while VFX and camera continue. A widely used guide: about 35 ms for light hits, 70 ms for heavy, 90 ms for a decisive strike, capped around 120 ms because longer reads as a dropped frame [18]. Use light hit-stop on exchange hits and heavy on the finisher.
* **Screen shake**: small (a few pixels), only on heavy finishers, off with reduced motion.
* **VFX set** (shared, recolored per army): impact star, dust puff, gear and spring burst, porcelain chunk burst, sound wave (bishop), cork cannon smoke (rook), spin trail (queen), promotion swirl, check pulse ring, selection ring, legal-move markers, mate confetti. Keep flashes below 3 per second (WCAG 2.3.1) [21].
* **Audio**: layered foley per hit (whoosh, impact, material: porcelain clink, tin clank, wood knock), wind-up ratchet for idles, spring "boing" deaths, small music stingers for check, mate, promotion. Voice barks as non-verbal gibberish or grunts (no localization cost), 3 to 5 per role per army (select, move, attack, defeat, taunt). Subtitles or icons for barks are optional since they carry no information.

### 3.11 Avoiding gore (rating)

* PEGI 7 allows non-realistic violence toward fantasy characters, or implied violence; PEGI 12 allows more graphic fantasy violence or non-realistic violence toward human-like characters [19].
* ESRB "Cartoon Violence" covers cartoon-like situations where characters may be unharmed afterwards; "Fantasy Violence" covers situations easily distinguished from real life [19].
* With toy characters that break into mechanical parts and no blood, PEGI 7 / ESRB E or E10+ is the likely target **(estimate; ratings depend on the full submission)**. Avoid: blood, dismemberment of humanlike limbs, decapitation (even of toys with faces), lingering on defeated faces, screams of pain. The chess.com feedback ("too violent for me") shows even mild 2D effects can feel too much for some players [13].

---

## 4. RTS-style turn UX

### 4.1 Camera (Command and Conquer feel)

| Control | Mouse / keyboard | Touch |
|---|---|---|
| Pan | WASD, arrow keys, edge scroll (optional, off by default in a browser window), middle drag | Two finger drag |
| Rotate | Q / E snap 90 degrees; right drag free orbit | Two finger twist |
| Zoom | Wheel, with min and max that keep the full board reachable | Pinch |
| Tilt | Tied to zoom (closer means lower angle), C&C style | Automatic |
| Reset | Home: own side at the bottom, full board | Double tap empty area |
| Top-down | Tab toggles a flat orthographic 2D-like view (keeps animations, just from above) | Button |

### 4.2 Turn flow

1. **Hover** a piece: base highlight, tooltip with piece name.
2. **Select** (left click or tap): selection ring, piece plays a short "ready" acknowledgment (wind-up key turn plus bark). Number keys or Tab can cycle through own pieces for keyboard players.
3. **Legal destinations**: ground decals on squares, dots for moves, crossed swords ring for captures, a special icon for castling, en passant and promotion squares. Knight shows the arc path; sliding pieces show a path line on hover.
4. **Move preview**: hovering a destination shows a translucent ghost of the piece there and, optionally, which enemy pieces would then attack it (red lines) and which of yours it would defend (blue lines).
5. **Order**: left click destination (or right click, configurable). Optional "Confirm moves" setting adds a second click; default off, recommended for touch.
6. **Execution**: piece moves; capture triggers the battle per pacing setting.

### 4.3 Board state readability

* **Threats**: optional "Show threats" toggle marks own pieces under attack (red ring on the base) and undefended pieces (dashed ring). This is the Into the Breach principle of surfacing consequences before the player commits [24]; for chess it should be a toggle, since it changes difficulty.
* **Check**: king's base pulses and a line connects to the checking piece.
* **Last move**: origin and destination squares tinted, as in the 2D build.
* **Minimap**: a small 2D board (reuse the existing DOM board renderer) in a corner, clickable for moves, always readable regardless of camera. It doubles as the accessibility fallback and the review view.
* **Captured pieces**: shown as small trophies on a shelf beside the board.

### 4.4 Idles and personality

* Base idle loop plus 2 fidgets per role, triggered randomly every 8 to 20 s per piece and never on more than 2 pieces at once, so the board stays calm.
* Contextual idles: threatened pieces glance at their attacker; the king fidgets nervously when in check; pieces near a fresh capture flinch.
* No idle may move a piece off its square or change its silhouette height noticeably (readability).

### 4.5 AI turn presentation

* "Thinking" indicator on the AI king (a ticking key or gears) while the worker searches.
* Before moving, the AI's chosen piece gets a 0.3 s selection ring, so the human sees what moved. The camera does not follow unless "Follow AI moves" is on.
* AI vs AI: Fast battles, no camera moves, adjustable delay between moves.

### 4.6 Undo, review, replay

* Review mode (existing history panel and arrow keys): pieces slide to positions with no battles, captured pieces fade back in. Replays of a single capture can be triggered from the move list ("watch this capture").
* Undo plays the move backwards as a quick slide; no reverse battle.

### 4.7 Accessibility

| Need | Measure | Source |
|---|---|---|
| Colorblind | Team by value plus accent plus base shape; threats by ring style, not only red | [20] |
| Motion sensitivity | Reduced motion honors `prefers-reduced-motion`; Instant battles; no shake; no camera moves | [20] |
| Photosensitivity | Max 3 flashes per second, no full-screen white flashes | [21] |
| Keyboard only | Algebraic move entry box ("Nf3"), focusable squares on the minimap | (design) |
| Screen reader | Announce moves and captures via an `aria-live` region, using the existing move list | (design) |
| Low end devices | Quality setting: 2D board mode as full fallback | (design) |

---

## 5. Production plan inputs

### 5.1 Asset list

**Characters**: 6 roles x 2 armies = 12 skins on 6 rigs (4 can share a humanoid skeleton). Target 1.5k to 5k triangles each, one palette texture atlas per army.

**Animation clips per role** (shared by both armies):

| Category | Clips | Count per role |
|---|---|---|
| Idle loop | idle | 1 |
| Fidgets / contextual | fidget A, fidget B, nervous, look-at (procedural head turn) | 3 |
| Command | select acknowledge, move (walk, gallop, roll, hop) | 2 |
| Attack | approach-to-strike variant A, B (queen and rook: C) | 2 to 3 |
| Exchange | parry / dodge | 1 |
| Finisher | finisher (tagged hit type) | 1 |
| Reactions | light hit react | 1 |
| Death | death by hit group: blunt, crush, magic | 3 |
| Events | victory cheer, check alarm (king) or point (others), mate surrender (king only), promotion pose (non-pawns) | 2 |
| **Per role** | | **16 to 17** |

Totals: 6 roles x about 16 = **about 98 clips**, plus 8 bespoke paired scenes x 2 = **16 clips**, plus specials (en passant, promotion transform, castling pair, mate finale) about **8 clips**. **About 120 to 125 clips**, of which roughly 40 can start from CC0 or Mixamo humanoid libraries and be retimed [25][26][27].

**VFX**: about 15 effects (see 3.10). **SFX**: about 60 to 80 files (foley layers, barks 12 x 4, stingers, UI). **UI**: move markers, threat rings, minimap, battle mode settings, trophy shelf. **Environments**: 1 board plus surrounding (toy-box table) for the slice, 2 to 3 alternative boards later (nursery floor, toy shop window, attic at night). **Music**: 2 to 3 loops (CC0 or commissioned).

### 5.2 Free prototype sources

| Source | License | Use |
|---|---|---|
| Quaternius Universal Animation Library 1 and 2 (120+ and 130+ clips, glTF/FBX, one humanoid rig) | CC0 [26] | Locomotion, hits, deaths for the prototype |
| Quaternius / KayKit characters and animation packs | CC0 [27] | Placeholder characters |
| Mixamo | Free with Adobe ID; royalty free in commercial games, but raw character and animation files may not be redistributed as assets [25] **(from FAQ snippet; page blocked direct fetch)** | Extra humanoid clips; note that a web game ships GLB files that users can download, so check whether this counts as redistribution. Prefer CC0 for anything shipped. |
| AI 3D generators (Meshy, Tripo) with auto rigging for humanoids and quadrupeds | Commercial terms vary by plan **(unverified)** [29] | Concept meshes and rigid props; expect manual cleanup and retopology |

### 5.3 Phased roadmap

Assumption: owner works about 10 to 15 hours per week with AI coding assistants. Durations are estimates.

| Phase | Goal | Deliverables | Duration |
|---|---|---|---|
| 0. Tech spike | Prove 3D board, camera and rules integration in the browser | three.js (or Babylon.js) board reusing `gameLogic.js` and the worker AI; RTS camera; 32 placeholder capsules or CC0 characters; click to move; legal markers; minimap | 2 to 3 weeks |
| 1. Prototype battles | Prove the choreography system with free assets | Battle anchor, contact-frame sync, composed scenes for all 30 pairings with Quaternius clips, Fast/Full/Off, skip, camera blend in and out, hit-stop | 3 to 4 weeks |
| 2. Vertical slice | Prove the art direction and fun | 2 bespoke roles in both armies (Pawn and Rook recommended: most common and hardest non-humanoid), 2 bespoke paired scenes, final VFX and audio for those, 1 finished board; playtest with 5 to 10 players for repetition fatigue | 5 to 7 weeks |
| 3. Full cast | All 6 roles, both armies | Remaining 4 roles, all clips, 6 to 8 bespoke pairings, specials (en passant, promotion, castling, mate) | 8 to 14 weeks (depends heavily on freelance use) |
| 4. Polish and release | Ship quality | Performance pass (mobile), accessibility, settings, 2 more boards, sound mix, onboarding, trademark check | 4 to 6 weeks |
| **Total** | | | **about 22 to 34 weeks part time** |

### 5.4 Effort and cost scenarios

Freelance reference rates (2025 to 2026):

| Work | Reference rate | Source |
|---|---|---|
| Stylized game character, model plus texture plus simple rig | $2,000 to $5,000 per character (indie stylized) | [28] |
| Low-poly rigged character by triangle count | about $800 (under 1k tris) to $2,500+ (under 5k tris) **(snippet)** | [28] |
| Rigging only, standard humanoid | from about $100 to $120 per character on marketplaces; complex or non-humanoid higher | [28] |
| 3D animators on Upwork | $17 to $30 per hour typical, median about $25; advanced about $60 **(snippet, page blocked direct fetch)** | [28] |
| Freelance animators globally | $20 to $220 per hour; mid level about $58, senior about $103 | [28] |

Per clip estimate **(my estimate)**: a stylized 1 to 3 s game clip takes about 3 to 10 hours of keyframing; a paired bespoke scene about 12 to 25 hours. At $30 to $60 per hour that is about $100 to $600 per clip and $400 to $1,500 per paired scene.

| Scenario | Characters | Animation | Approx. cash cost **(estimate)** | Risk |
|---|---|---|---|---|
| A. AI and CC0 only | AI-generated meshes, kitbashed toy parts, segment rigs done by the owner in Blender with AI guidance | CC0 humanoid clips retimed; knight and rook keyed by owner; bespoke scenes reduced to 2 to 3 | $0 to $500 (tool subscriptions) | High time cost for owner; consistency risk |
| B. Hybrid (recommended) | Owner and AI produce concepts; one freelancer models and rigs 6 roles (two skins each via material and small mesh swaps) | CC0 for humanoid basics; freelancer keys knight, rook, all finishers, deaths and 6 bespoke scenes (about 60 clips) | about $10k to $25k | Moderate; requires a clear style guide and a test character first |
| C. Full freelance | 12 distinct models | All about 125 clips custom | about $25k to $60k | Lowest owner time; highest cash; coordination overhead |

Owner time per role in scenario B **(estimate)**: about 6 to 10 hours (brief, review, import, wiring tags and contact frames).

### 5.5 Key risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Repetition fatigue (documented for every predecessor) [3][8][13] | Feature gets turned off | Fast default after the first games, "first time only" mode, variants weighted toward common pairings, short Full mode |
| Animation scope creep | Never ships | Fixed clip budget per role (table 5.1); bespoke scenes capped at 8; composed system covers all 30 pairings first |
| Inconsistent AI-generated art | Cast looks mismatched | Toybox theme with rigid parts and one palette atlas; style guide with a turnaround sheet per role; one "golden" character approved before the rest |
| Non-humanoid rig and retarget problems | Knight and rook look stiff or break | Segment rigs, custom clips budgeted from the start; prototype the rook first in the vertical slice |
| Trademark conflict | Forced rename, takedown | Avoid "Battle Chess" in any name or copy [5][7]; USPTO search and a short attorney review before public release |
| Asset license contamination | Cannot ship or must replace assets | CREDITS file with license per asset; prefer CC0; treat Mixamo and AI tool output terms as needing review before shipping [25][29] |
| Browser performance (32 skinned meshes plus effects) | Low frame rate on phones | Under 5k tris per piece, shared materials, compressed glTF (meshopt or Draco, KTX2 textures), quality setting with a 2D fallback **(standard practice, not benchmarked here)** |
| Camera discomfort or confusion | Motion sickness, lost orientation | No cuts in Fast, 180 degree rule, always restore player camera, reduced motion mode [22] |
| Animation blocking game state | Stuck games (a bug class already fixed in the 2D build) | Keep the existing contract: scene promise always resolves on completion, skip, timeout or hidden tab; state applies regardless |
| Rating creep from "smashing" scenes | Narrower audience | Mechanical defeat language only, review against PEGI 7 descriptors [19] |

---

## Sources

1. Battle Chess, Wikipedia: https://en.wikipedia.org/wiki/Battle_Chess
2. Battle Chess: Game of Kings, Steam store page: https://store.steampowered.com/app/200150/Battle_Chess_Game_of_Kings/
3. "Animations", Battle Chess: Game of Kings Steam discussion: https://steamcommunity.com/app/200150/discussions/0/611696927928073903/
4. ChessBase, "Battle Chess": https://en.chessbase.com/post/battle-chess
5. BATTLE CHESS, Serial 87188582, Reg. 6610412, Trademarkia: https://www.trademarkia.com/battle-chess-87188582
6. BATTLE CHESS, Serial 87173349, Justia Trademarks (search snippet, page blocked): https://trademark.justia.com/871/73/battle-87173349.html and TTAB record: https://ttabvue.uspto.gov/ttabvue/v?pno=87173349&pty=EXT
7. Battle vs. Chess, Wikipedia: https://en.wikipedia.org/wiki/Battle_vs._Chess
8. GameSpot, Combat Chess review: https://www.gamespot.com/reviews/combat-chess-review/1900-2538451/
9. Combat Chess, Wikipedia: https://en.wikipedia.org/wiki/Combat_Chess
10. Archon: The Light and the Dark, Wikipedia: https://en.wikipedia.org/wiki/Archon:_The_Light_and_the_Dark
11. Lucasfilm, Tippett Studio interview: https://www.lucasfilm.com/news/tippett-studio-star-wars-interview/ ; ILM, Dejarik creatures: https://www.ilm.com/mandalorian-grogu-star-wars-dejarik-monster-battle-interview-vfx-ilm/
12. Chess Ultra, Wikipedia: https://en.wikipedia.org/wiki/Chess_Ultra ; Steam: https://store.steampowered.com/app/518060/Chess_Ultra/
13. chess.com forum, "Have you tried Battle Mode animation style?": https://www.chess.com/forum/view/community/have-you-tried-battle-mode-animation-style
14. Wizard Chess, Harry Potter wiki: https://harrypotterbooks.fandom.com/wiki/Wizard_Chess
15. Battle vs Chess review (InVision Community): https://invisioncommunity.co.uk/battle-vs-chess-review/
16. Valve, "Stylization with a Purpose: The Illustrative World of Team Fortress 2" (GDC 2008): https://cdn.fastly.steamstatic.com/apps/valve/2008/GDC2008_StylizationWithAPurpose_TF2.pdf
17. Epic, Motion Warping in Unreal Engine: https://dev.epicgames.com/documentation/en-us/unreal-engine/motion-warping-in-unreal-engine ; Contextual Animation plugin guide: https://vorixo.github.io/devtricks/contextual-anim/
18. Hit-stop: https://swordarcade.xyz/guides/game-feel-hitstop-and-screen-shake/ ; https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit/ ; Sakurai column: https://sourcegaming.info/2015/11/11/thoughts-on-hitstop-sakurais-famitsu-column-vol-490-1/
19. PEGI labels: https://pegi.info/what-do-the-labels-mean ; ESRB ratings guide: https://www.esrb.org/ratings-guide/
20. Game Accessibility Guidelines, colour: https://gameaccessibilityguidelines.com/ensure-no-essential-information-is-conveyed-by-a-fixed-colour-alone/ ; Xbox Accessibility Guideline 103: https://learn.microsoft.com/en-us/gaming/accessibility/xbox-accessibility-guidelines/103
21. W3C, Understanding SC 2.3.1 Three Flashes or Below Threshold: https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html
22. 180-degree rule, Wikipedia: https://en.wikipedia.org/wiki/180-degree_rule
23. XCOM 2 Steam discussion on camera and action cam: https://steamcommunity.com/app/268500/discussions/0/144512753469839919/
24. Into the Breach UX: https://blog.prototypr.io/into-the-breachs-ux-makes-you-feel-smart-a9cb03210757 ; Game Developer, Road to the IGF: https://www.gamedeveloper.com/game-platforms/road-to-the-igf-subset-games-i-into-the-breach-i-
25. Adobe, Mixamo FAQ (snippet, page blocked direct fetch): https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html
26. Quaternius, Universal Animation Library: https://quaternius.com/packs/universalanimationlibrary.html ; itch.io: https://quaternius.itch.io/universal-animation-library ; UAL 2: https://quaternius.com/packs/universalanimationlibrary2.html
27. KayKit Character Animations (OpenGameArt): https://opengameart.org/content/kaykit-character-animations
28. Rates: RocketBrush 3D character prices: https://rocketbrush.com/blog/3d-character-art-prices-guide ; KatsBits freelance rates: https://www.katsbits.com/articles/how-much-should-i-charge-for-freelance-3d-modeling-work.php ; CAD Crowd rigging costs: https://www.cadcrowd.com/blog/3d-rigging-and-3d-rig-services-costs-rates-and-pricing-for-companies-and-firms-2/ ; Upwork 3D animator cost (snippet): https://www.upwork.com/hire/3d-animators/cost/ ; goLance animator rates 2026: https://golance.com/hiring/best-freelance-animators-hourly-rate
29. AI auto rigging comparison 2026 (Tripo, Meshy, Cascadeur, AccuRig, Mixamo): https://www.strayspark.studio/blog/ai-auto-rigging-showdown-2026-tripo-meshy-cascadeur-mixamo ; Meshy vs Tripo: https://www.selfcad.com/blog/meshy-vs-tripo

### Unverified or estimated items

* Cancellation of Reg. 6124855 and the opposition details (Justia snippet only).
* Upwork rate figures and Mixamo license wording (search snippets; pages returned 403).
* Low-poly price tiers by triangle count (snippet; source attribution within [28] uncertain).
* AI 3D tool commercial terms (not checked; review the current terms of the chosen plan).
* All hour, week and cost estimates in 5.3 and 5.4, the rating target in 3.11, and the browser performance budget.
