# Product Requirements Document: "The Endless Descent"

## Brief
Build a complete, playable roguelite dungeon crawler in a single HTML file
(vanilla HTML5 + CSS + JavaScript, canvas or DOM). Game mechanics are
derived from tabletop D&D rules (2024 PHB), adapted to a real-time-ish,
turn-based solo browser game.

## Concept: "The Endless Descent"
A browser roguelite dungeon crawler. The player creates a character using
dice rolls and picks a species, origin, and class; then descends a
procedurally generated dungeon, fighting enemies and looting treasure.
Reaching the portal to the surface **banks** the gold from that run and
returns the hero to the Hub, where banked gold buys permanent upgrades
before the next descent. Each descent is a fresh, deeper, harder dungeon.

Design philosophy (carried from the rules source):
- **Small readable numbers.** d20-style checks, dice pools, flat modifiers.
  A player must be able to explain why they died in one sentence.
- **A handful of strong choices over many weak ones.** Species × Class ×
  Origin × feats should feel orthogonal, not combinatorial soup.
- **Resources that recover.** Everything scarce (slots, charges) refunds at
  rest so a run is about pacing, not accounting.
- **Death is final but cheap to retry.** A run takes minutes; the meta
  progress makes the next run meaningfully stronger.

---

## 1. Platforms & Hard Constraints
1. A single self-contained HTML file. All CSS and JS inline; no external
   libraries, CDNs, images, or audio assets — visuals from emoji/canvas
   shapes, sound from procedural Web Audio synthesis.
2. Fully playable offline; must open directly from disk.
3. Progression (banked gold, character upgrades, unlocks) persists between
   browser sessions on the same device.
4. Must stay comfortably smooth (no jank) on a mid-range laptop; generation
   of a full floor must happen imperceptibly fast (< 50 ms).
5. Keyboard-first (WASD/arrows + number keys), with visible on-screen
   buttons for every action so a mouse-only player can also play.

## 2. Target Audience
- Casual players wanting 5–15 minute runs with replayability.
- Fans of classic dungeon crawlers (NetHack, Wizardry, Diablo-lite) and
  tabletop RPGs who want the *feel* of D&D character creation without
  running a table.
- Low-end-device / offline users.

## 3. Core Loop
```
HUB ──descend──▶ DUNGEON FLOOR 1 ──exit stair──▶ FLOOR 2 ──▶ … ──portal──▶ HUB
 │                                                                 │
 └────── permanent upgrades bought with BANKED gold ◀──────────────┘
                (gold found in run is banked only if the player escapes;
                 dying drops un-banked loot)
```
- **Hub:** view sheet, buy permanent upgrades, re-roll abilities (paid),
  change nothing else (species/origin/class are fixed per character — see
  §12 for new characters).
- **Descent:** clear 5 floors; the 5th ends in the Surface Portal. Optional
  "Deeper Descent" continues to floors 6–10 with a hard-mode twist
  (§8.4) before the portal; the portal is always reachable — abandoning
  a deep floor keeps gold gathered so far.
- **Death:** run ends; un-banked gold and un-banked loot are lost; the
  character keeps level, species, class, and hub upgrades.

## 4. Character Creation (once, per character)
Creation follows a five-stage flow, each stage locking before the next
(identity first):

### 4.0 Identity (stage 1)
Role-playing customization, free-form and cosmetic:
- **Name** (≤ 16 chars, required, uniqueness not enforced).
- **Gender / identity** (optional): free-text or pick from a short list
  (she/her, he/him, they/them, custom, prefer not to say). Used only in
  narration and the character sheet — never gates or scales anything.
- **Description** (optional, ≤ 140 chars): 1–2 sentences of self-authored
  backstory/flavor. Shown on the hub sheet and death/escape recaps, and
  passed to the AI narrative layer (§13) so generated prose can reference it.
- All three are editable in the hub at any time ("Edit sheet") and travel
  with exports (§14).

### 4.1 Ability Scores (dice)
Six abilities, each rolled as **4 six-sided dice, drop the lowest, sum the
rest** (range 3–18; typical ~10). On creation, offer:
- **Roll:** animate the 4d6 roll per ability (fast, ~1 s total), or
- **Point Buy (safe option):** 27 points, 3–15 range, no more than 15 pre-purchase —
  identical end-state budget so both routes are fair.
Modifiers = `round((score − 10) / 2)` (−3 to +4 at creation).

| Ability | Drives in this game |
|---|---|
| **STR** | Melee weapon damage, carrying capacity (loot slots), push/shove actions |
| **DEX** | Ranged weapon accuracy, dodge chance, **critical chance**, initiative |
| **CON** | Max Hit Points (`10 + CON mod + level`), resist poisons/bleeds |
| **INT** | Spell power (adds to spell damage), arcana traps (locks & arcane doors) |
| **WIS** | Trap detection radius, shrine & fountain potency, save vs. fear/charm |
| **CHA** | Shop prices (−% per point above 10), intimidate (enemies may flee/miss once per floor) |

Hub re-roll: pay escalating gold (first 50, then ×2 each) to re-roll any
single ability (keep-or-take, no re-roll of re-rolls).

### 4.2 Species (pick 1 of 10)
Each species grants Darkvision (dungeons have no light rules — cosmetic
flavor) plus **one signature passive** and a +2/+1 to abilities:
- **Dragonborn** (+2 STR, +1 CHA) — Breath Weapon: once per fight, dump one
  charge to deal a cone of one damage type (chosen at creation: fire/cold/
  lightning/poison).
- **Dwarf** (+2 CON, +1 WIS) — Stonecunning: sees hidden doors/traps on the
  minimap outline; +2 vs. poisons and bleeds.
- **Elf** (+2 DEX, +1 INT) — Keen Senses: +1 trap detection, +1 save vs.
  charm/fear; Fey Ancestry: immune to being put to sleep (stunned ≤ 1 turn).
- **Gnome** (+2 INT, +1 DEX) — Tinkerer: may carry one extra consumable slot;
  crafted items (potions bought in hub) are 20 % cheaper.
- **Goliath** (+2 STR, +1 CON) — Power Throw: ranged thrown attacks also use
  STR; once per run, survive a killing blow with 1 HP.
- **Halfling** (+2 DEX, +1 CHA) — Lucky: 3 re-rolls of failed *own* checks per
  floor (re-roll once, take the better — the "advantage" mechanic, see §6.2).
- **Human** (+1 to two abilities, player's choice) — Versatile: take one
  extra feat at creation for free (§10.3).
- **Orc** (+2 STR, +1 CON) — Menacing: +1 damage vs. creatures larger than the
  player's tier; aggro resistance (fewer enemies notice the player at spawn).
- **Tiefling** (+2 CHA, +1 INT) — Infernal Legacy: innate minor flame —
  a free cantrip that never costs a slot (§8.3).
- **Aasimar** (+2 CHA, +1 CON — or +1 STR for the heroic variant) — Radiance:
  once per floor, purge all hostile conditions off yourself and heal 1d4.

### 4.3 Origin / Background (pick 1 of ~6, trimmed from the 16-table)
Each origin is a free "story perk": **+1 to two skills-flavored bonuses,
one tool (a minor passive), and a starting kit + 50 gold**:
- **Acrobat** — +1 dodge & trap step-over; tool: rope (climb a free shortcut
  once per floor); kit: climbing gear + torch.
- **Criminal** — +1 lock-pick & shop haggle; tool: thieves' tools; kit: dagger,
  lockpicks.
- **Guild Artisan** — +1 crafted-gear durability & shop sell prices; tool:
  craft tools; kit: workbench voucher (free potion craft in hub).
- **Noble** — +1 CHA-flavored effects; tool: signets; kit: fine clothes,
  100 gp instead of 50 (but shop discounts reduced by 1).
- **Outlander** — +1 survival & poison resistance; tool: navigator's tools;
  kit: cloak + rations (auto-heal 1 HP after each floor's first rest).
- **Sage** — +1 arcana & spell power; tool: scholar's pack; kit: scroll case
  (one free scroll per run).

### 4.4 Class (pick 1 of 12)
A class defines: starting weapon tier, **two starter abilities/spells**, a
**Signature Ability** (on a cooldown), and **milestone powers** at
character levels 3 and 6 (permanent, earned across runs, §10).
Roles are deliberately distinct — 3 melee, 3 ranged/hybrid, 3 caster, 3 support:

| Class | Role | Starter kit (2) | Signature (cooldown) | Milestones L3 / L6 |
|---|---|---|---|---|
| Barbarian | Melee tank | 2 melee strikes + Reckless (damage up, AC down 2 turns) | **Rage** (3 turns: +2 dmg, damage resistance) | L3: 2nd Wind (self-heal once/fight) · L6: **Extra Strike** (one extra melee attack) |
| Bard | Support/buffer | Healing word + Vicious mock | **Inspire** (ally/enemy-debuff: next 3 of your hits crit-ready) | L3: Jack of Trades (+1 to one check per floor, free) · L6: Slumber (1 enemy asleep 1 turn) |
| Cleric | Healer/smiter | Smite (single-target burst) + Healing | **Divine Favor** (2 turns: smite dmg +2) | L3: Lay on Hands (big heal, once/floor) · L6: Sanctuary (immune 2 turns, knockback) |
| Druid | Shapeshifter | Elemental dart + Heal | **Wild Shape** (2 turns: transform — either a bear: +AC +melee, or a wolf: +speed/dodge) | L3: Land's Stride (ignore difficult terrain) · L6: Conjure (summon 1 minor beast for 5 turns) |
| Fighter | Melee damage | 2 weapon proficiencies + Second Wind (L3, pulled forward) | **Action Surge** (extra action this turn) | L3: 2nd Wind · L6: **Cunning Action** (move+attack as one turn) |
| Monk | Finesse striker | Unarmed flurry + Ki heal | **Flurry** (3 quick strikes, each ½ dmg, no miss on 10+) | L3: Evasion (halves ranged/spell dmg) · L6: Stunning Strike (hit = stun 1 turn) |
| Paladin | Smite tank | Lay on hands + Smite | **Aura** (2 turns: self + nearby-enemies slow) | L3: Divine Health (poison immune) · L6: **Smite Breaker** (guaranteed hit + bonus dmg) |
| Ranger | Ranged/pet | Hunt shot + Favored Enemy (pick type: +2 dmg vs it) | **Call Beast** (companion animal, fights beside you, 10 HP) | L3: Natural Explorer (floor map outlines on HUD) · L6: Hunter's Mark (mark: all hits advantage) |
| Rogue | Crit/dodge | Backstab (flanking bonus) + Poison blade | **Evasion** (2 turns: +dodge, +crit) | L3: Sneak Attack (+2 dmg after moving) · L6: **Uncanny Dodge** (auto-parry one hit/floor) |
| Sorcerer | Burst caster | 2 evocation spells (fire bolt, chill) | **Surge** (next spell this floor: free, +1 level) | L3: Metamagic (one spell/floor gains extended duration) · L6: Elemental Affinity (your damage type: +2 dmg, save DC +1) |
| Warlock | Pact caster | Hex (DoT on 1 target) + Eldritch blast | **Pact** (2 turns: next 3 attacks gain spell-damage bonus) | L3: Otherworldly (once/floor, teleport 3 tiles) · L6: **Devil's Bargain** (spend HP: refund a used signature charge) |
| Wizard | Utility caster | 2 spells (light + ray frost) | **Focus** (next spell costs no slot) | L3: Arcane Recovery (refund 1 used slot per floor, once) · L6: Arcane Mastery (pick: +1 to a school's effect each floor) |

(Classes are thematically modeled on the twelve 2024 PHB classes; names and
flavor are free to adapt, but the *role shape* above is the requirement.)

## 5. Combat (turn-based)
5.1 **Turn structure:** alternate player/enemy turns; initiative (DEX-based)
sets who starts each fight. Player turn actions: **Move, Attack, Cast,
Item, Signature, Flee** — one primary action + up to one "quick" action
(move or free item). A class milestone may grant an extra action per turn
(Fighter L6), mirroring Extra Attack.
5.2 **Attack:** roll d20 + proficiency (2 at L1, +1 per 4 levels) + ability
mod (STR or DEX by weapon property) vs. enemy **AC**. **Natural 20 =
critical** (double the damage dice, not the modifiers). **Natural 1 = fumble**:
enemy may counter at −2. *Halfling Lucky, Ranger's Mark, and similar perks
grant "advantage": roll twice, take the better; "disadvantage": twice, take
the worse.*
5.3 **Damage:** weapon dice + ability mod − armor reduction implied by AC;
elemental/bleed/poison DoTs tick at end of their owner's turn. Crits and
fumbles show big centered callouts.
5.4 **Conditions (replaces ad-hoc status effects):** Prone (next attack on
you crits; you may not flee), Stunned (skip turn), Sleep (wake on damage),
Poison (DoT + CON save to halt), Bleed (DoT, stacks, max 3), Charm/Fear
(WIS save to end early), Slow (loses quick action). Max **2 hostile
conditions** on one creature — display icons in the enemy HUD.
5.5 **Enemy tiers:** 4 silhouettes scaled per floor — **Gutter** (weak, fast),
**Brute** (tank, reach), **Caster** (kept at range, single-target bolt),
**Elite** (mini-boss every 3rd floor; one signature tell, e.g. charges
unless blocked by a closed door).

## 6. Dice & Checks (house rules distilled from D&D)
6.1 Every contested event resolves as **d20 + modifier vs. a Target
Number** (10 for easy, 12 routine, 15 hard, 18 expert) or vs. AC in combat.
Never show the math in play; only color-code success (green) / fail (red) /
margin ("easy success" on 10+ under).
6.2 **Advantage/disadvantage** as above. Implement exactly once, reused by all
features that mention it.
6.3 **Saving throws** (Poison/Bleed/Fear/Stun) = d20 + relevant mod ≥ 12
(tunable); enemies get an equivalent flat 30 % base resist scaled by tier.

## 7. Weapons & Equipment
7.1 **Weapon tiers** mirror the rulebook's two tiers and four groups
(simple/melee, simple/ranged, martial/melee, martial/ranged). In-game:
tier determined by floor (floors 1–2 drop simple, 3+ martial). Each weapon
has: damage dice, range, one **property tag**, and one **Mastery tag**
(unlocked only if your class origin/feat matches the weapon family — see
below, the 2024 "weapon mastery" hook):

| Property tag | Effect | | Mastery tag | Effect |
|---|---|---|---|---|
| Finesse | use STR *or* DEX | | Cleave | on hit, also strike a 2nd adjacent enemy (½ dmg) |
| Light | quick: frees the quick action | | Vex | target's next attack has disadvantage |
| Versatile | one-hand: 1 attack · two-hand: +1 dice side | | Topple | hit = enemy falls Prone (save to avoid) |
| Ranged | ranged, ammo unlimited (bandolier refills on floor) | | Graze | even on a miss, deal ability-mod damage |
| Reach | attack 2 tiles away | | Push | hit = shove enemy 1 tile (off ledges!) |

7.2 **Armor:** three weight classes with the classic trade-off — Light:
base AC 11 + DEX (full DEX), no penalties; Medium: base 12–15 + DEX capped
at +2, some hide poorly (−1 dodge); Heavy: fixed high AC (14–18), requires
STR ≥ 13 to keep dodge, −1 dodge always, but +1 save vs. all DoTs.
Plus a **shield (+2 AC)** occupying a slot. Exactly one armor + one shield.
7.3 **Inventory:** 5 slots (+1 for Gnome tinkerer). Weight (STR) adds a
soft cap on consumables, not on gear. Sell = half price (§11.3).

## 8. Magic
8.1 **Slots:** casters carry **3 slots per run**; slots refund on any rest
(fountain, camp, or clearing the floor) — no long rests inside a run.
Slot levels 1–3 scale with character level (L1: 3×L1 · L3+: 2×L1 + 1×L2 ·
L5+: 1×L1 + 2×L2 + 1×L3, max). A higher slot may be poured into a lower
spell (**Overcharge**: spell effect +1 tier, costs the bigger slot).
Non-caster classes use slots too but get 1–2 fewer, and may refill via
their Signature (Wizard Focus, Sorcerer Surge).
8.2 **Spell cards:** every spell is defined by {level (0–3 in game),
school, classes that know it, cost time (action/react/passive), range,
duration (instant / X turns / until next rest), effect, overcharge rule}.
Eight schools, each with a distinct verb: **Evocation** (burst damage),
**Abjuration** (ward/negate), **Transmutation** (move self/world),
**Necromancy** (drain: hurt → heal), **Enchantment** (frighten/charm 1
enemy), **Illusion** (decoy tile/phantom ally), **Conjuration** (summon
minor creature or projectile), **Divination** (reveal: true floor map for 1
floor, detect elite).
8.3 **Cantrips:** each class has 1–2 free abilities that never cost slots;
they **upgrade automatically at character levels 3, 5, and 8** (dice grow:
1d6→1d8→1d10→1d12) — direct port of the 2024 "cantrip upgrade" so starter
kits stay viable late.
8.4 **Deep Descent (floors 6–10):** optional, started from the floor-5
choice (see §3). Darkness (visibility 3 tiles, torch
consumable), gravity wells (Prone hazards), and enemies at +1 tier.
The same Surface Portal appears again after floor 10 — abandoning a
deep floor keeps all gold gathered so far. No soft-lock.

## 9. Dungeon
9.1 **Map:** 40×40 tile grid per floor, generated fully up front. Guaranteed
walkable path from entry stair to exit (stair down on floors 1–4, portal on
5, stair back-up on every floor). Rooms + corridors; 4–8 rooms.
9.2 **Depth biomes** (visual + hazard shift every 2 floors): Damp Cellars →
Root Cellars/Grave Tunnels → Molten Depths → Cracked Void. Hazards:
collapsing floor (fall = lose a tile of HP and the item), spore clouds
(Poison), pressure plates (elite-only), spike pits (Dex check or damage).
9.3 **Placement rules:**
- Density: floors add enemies (+2 per floor) and reduce potions (−1 per 2 floors).
- **Rest floor every 3rd floor:** no spawns; one fountain + a merchant NPC.
- Treasures: gold piles (size scales), 1 weapon or armor drop per 2 floors
(guaranteed: floor 2 and floor 4), 1 spell-scroll drop per floor ≥ 2
(random school known to the player, 50 % chance it's their class's school).
- Traps on walls/floor tiles; detection = WIS-based radius highlight (§4.1).
9.4 **Elites** on floors 3 and 5 (portal guardian): unique name + banner,
drop a guaranteed rarity 2 item or 3× gold.

## 10. Progression
10.1 **In-run XP:** kills grant XP (tier-scaled); level-ups mid-run heal
`1d(level die) + CON mod` (level die: d6 for most classes, d8 melee, d4
caster-light — thematic echo of hit dice). Mid-run level grants +1 to the
level modifier and heals, nothing more (powers come from character level).
10.2 **Character level (meta):** XP banks on escape alongside gold (or a
fixed 30 % of run XP if killed — "memorial XP"). Character level 1→10;
each level: +1 to max HP formula, and at 3 & 6 the chosen class milestone
power (§4.4). Proficiency grows on the same ladder.
10.3 **Feats (permanents, earned at character levels 3, 5, 8, 10 — pick 1
of 3 offered):** draw from a curated ~12 feat pool mirroring the PHB
categories:
- *Origin-style (story-flavored, small):* Lucky (2 free re-rolls/floor),
  Resilient (auto-pass one bad condition/floor), Weathered (+1 save vs. one
  type).
- *Skill-style:* Cross-Training (unlock a 2nd weapon family's mastery
  tags), Alert (always act first in a fight), Fleet (free 1-tile step
  each turn).
- *Craft/power-style:* Swift Quaff (items are quick-actions always),
  Forge (hub potions cost 50 %), **Magus** (borrow one cantrip from another
  class — repeatable per new class's list).
10.4 **Epic Boons (milestones, auto-granted at character levels 5, 8, 10 —
no choice, big & thematic):** 5 → "Undying" (once per run: die at 1 HP,
purge conditions). 8 → "Vault-Keeper" (+1 inventory slot). 10 →
"Warden's Eye" (full map reveal each floor start).

## 11. Economy
11.1 **Coins:** gp with sp subunits; display as `12 gp` (split pennies
rounded). No platinum in v1.
11.2 **Merchant (rest floors + hub):** rotating 6-item stall; CHA discount
§4.1. Hub upgrade prices (permanent): +5 max HP = 100 gp ×(1.5 per purchase);
+1 weapon dmg = 150 gp ×(1.5); +1 AC = 200 gp ×(1.6); +1 slot capacity =
500 gp ×(2); ability re-roll = 50 gp ×(2).
11.3 **Loot values:** gold piles 5–60 gp by floor; items priced by tier
(simple 25 gp, martial 75 gp) — sells at ½.
11.4 **Magic items:** found, not bought (elite drops / chests only).
Two rules borrowed wholesale: **Attunement** — max 3 magic items equipped;
equipping a 4th unequips the oldest — and **Identification**: a found
magic item shows a silhouette ("glowing, unknown") until the player reads
it via a hub action (free, 1 item) — its full statline is revealed. Rarity
1–3 governs value and drop odds (elite = rarity 2+, floor 10 chest = rarity 3).

## 12. New Characters / Replay
- On first visit: single-character save (no party).
- After reaching character level 10, offer **Retire & Reincarnate**:
  bank everything, +1 permanent "Descension" bonus (−1 gold cost per 10 %
  of prices), fresh character at L1 keeping a *single* heirloom magic item.

## 13. Narrative Layer (Optional AI Color)
13.1 **Purpose:** an OPTIONAL cosmetic layer. When enabled, an LLM endpoint
  supplied by the player writes word-based embellishment for the dungeon:
  floor-transition flavor, monster intros, elite banners, treasure
  descriptions, and one-line reactions to notable beats (level-up,
  near-death, companion loss). Prose only — it makes the run immersive,
  never changes it.
13.2 **Endpoint compatibility:** any OpenAI Chat Completions–compatible API
  — OpenAI itself, Ollama (served at `/v1/chat/completions`), LM Studio,
  or any local/self-hosted server speaking the same protocol. Configured in
  hub Settings: endpoint URL, model name, optional API key (stored with the
  save file, §14). **Defaults to OFF**; the game must be complete and
  indistinguishable in gameplay with it off, including from `file://`
  with no network.
13.3 **Prompt payload:** (a) a condensed rules-and-world brief derived from
  this PRD (biomes, factions, loot table vocabulary), (b) the player's full
  character identity and sheet (§4.0–§4.4), (c) the seed-generated dungeon
  context (floor number, biome, room inventory, named entities present with
  tier/type, and the specific event hook: floor entry, encounter, treasure,
  elite, or beat). Nothing about the player beyond what they typed.
13.4 **Hard contract (presentation isolation):**
- Model output is untrusted decoration: game logic must never parse it,
  act on it, or let it influence anything. Damage, drops, RNG outcomes,
  saves, and win/loss compute identically whether AI is on, off, or lying.
- Responses are constrained to a JSON shape (`{"title": str ≤ 8 words,
  "lines": [str] each ≤ 20 words, total ≤ 60 words}`); anything malformed,
  oversized, or non-JSON is discarded and the fallback is used.
- 8-second timeout. On timeout / error / refusal / rate-limit the game
  falls back to a **static prose bank** (hand-written lines per biome,
  enemy, treasure tier, and event — see §16) with no visible degradation.
13.5 **Presentation:** floor banners, encounter intros (one line; elites get
  title + line), treasure toasts, and recap lines render with a typewriter
  effect. Responses are cached per (seed, floor, entity-id/event) so
  revisits and replays of a run do not re-request.
13.6 **Privacy & transparency:** Settings exposes "show last prompt /
  response"; the key goes only to the user-configured endpoint; the game
  ships no backend, telemetry, or account system of its own.
13.7 **Determinism:** with the AI layer disabled, a run on a given seed
  produces identical in-game text every time (prose bank is seed-keyed) —
  this must be unit-testable without a network.

## 14. Save / Load (Portable Save Files)
14.1 **Export:** from the Hub and from the in-run pause overlay, "Export
  save" downloads a single JSON file (`endless-descent-save-v{N}.json`)
  containing: identity (§4.0), abilities, species/origin/class, feats, boons,
  character level/XP, banked gold, hub upgrades, Descension rank, settings
  (AI config included — the export dialog warns "this file contains your
  API key"), and, mid-run: floor, run seed, tile position, HP, slot state,
  inventory, and elapsed turns — plus the integrity footer (§14.5): the
  rolling hash chain and the accepted paid re-roll ledger.
14.2 **Import:** upload of the same file format. Sequence: schema +
  `SAVE_VERSION` validation → summary preview (name, level, gold, run
  state?) → explicit confirm → atomic apply (all-or-nothing). Corrupt,
  foreign, or wrong-version files are rejected with a clear error; the
  current save is never partially overwritten.
14.3 **Relation to autosave:** the automatic local save (restored on
  re-open — acceptance item 2 of §18) remains the primary store; export/import is the backup
  and cross-device path. Both directions share one serializer — no second
  encoding.
14.4 **Versioning:** files carry `SAVE_VERSION` (integer, starts at 1) and
  a `GAME_VERSION` string. Future versions may migrate forward via named
  migrators only; unknown higher versions are refused, not guessed.
14.5 **Integrity validation & anti-cheat (import-time, enforced in code):**
  Save files are untrusted input; the human editor is a first-class threat
  model. Every import runs the full validator before anything is applied,
  against a **sanity ledger** derivable from the save itself:
  - **Per-level stat caps:** every ability score must satisfy
    `3 ≤ score ≤ STAT_MAX(level)`, where `STAT_MAX(level) = min(18,
    14 + level)` (L1: 15 · L2: 16 · L3: 17 · L4+: 18). "Set everything to
    18" therefore fails outright below level 4, and is still caught by
    the next rule above it.
  - **Aggregate budget:** total point-spend `Σ(score − 3) ≤
    27 + 2·(level−1) + 9·(accepted paid re-rolls on record)`, no score
    above 15 unless the delta is backed by a recorded re-roll — exactly
    the creation economics of §4.1, so a legal high-roll character (one
    18, rest middling) passes while a flat 18×6 never can.
  - **Cross-field consistency:** HP ≤ the max-HP formula for (level, CON);
    gold and XP are integers within [0, next threshold]; feats ⊆ the
    12-feat pool; milestone powers present only at their granting levels
    (3/6); boons only at 5/8/10; Descension rank ≤ 1; inventory items ⊆
    the content catalog with rarity bounded by the floor found on; equipped
    magic items ≤ 3.
  - **Hash chain:** each save write appends `SHA-256(prev hash ‖ state)`;
    the last 50 links ride in the file. A hand-edited field breaks the
    chain. Recomputing it faithfully requires replaying the game, which
    defeats the point — the chain is a tripwire and legible proof, not
    DRM.
  **Verdict & punishment (deterministic, all-or-nothing):**
  - Clean → load proceeds, no notification.
  - Any violation → a **Tamper Report** dialog lists every broken rule per
    field ("STR 18 exceeds STAT_MAX(L2) = 16", "hash chain broken at link
    37/50"), and the punishment is applied *before* the save loads:
    1. Every over-cap score is clamped down to `STAT_MAX(level)`.
    2. The character's **two class-core abilities** (the pair its class
       keys off — e.g. Barbarian: STR & CON) take a further −4, floor 5.
       Maximum pain, aimed exactly where the build lives.
    3. **All class bonuses are disabled**: the signature ability, both
       starter abilities, and any earned milestone powers are stamped
       `SILENCED` (greyed on the sheet, tooltip explains why) and stay
       silenced for the life of the character — recoverable only via
       Retire & Reincarnate (§12). Hub upgrades, feats, and species
       passives are untouched.
  - Runtime anomalies (HP above formula, impossible inventory, negative
    gold) route through the same handler mid-run: report, clamp, silence.
  - Once punished, the sheet carries a permanent red
    `VOIDED — tampered save detected` stamp, and exports of that
    character carry the stamp forward so it cannot be laundered by
    re-import.
  - Verdicts are idempotent: re-importing an already-punished, unmodified
    save produces no further penalty.

## 15. UI / Presentation (decided)
15.1 **Graphics:** emoji-first (🧝 ⚔️ 🐉 💰 ✨ …) on a dark tile grid with
  subtle CSS glows; canvas only for dice-roller and screen shake. Retro
  pixel font via system monospace.
15.2 **HUD:** top-left: character name + identity tag; left: HP bar, XP
  sliver, active conditions; center-bottom: last-5 events log (colored,
  typewriter for AI lines); right: inventory 5-slot, slots pips, floor
  label + biome icon; top-right: gold.
15.3 **Dice presentation:** 4d6 roll *animates* on creation and on paid
  re-roll (one second, skippable); in-combat rolls show as a brief sprite
  pop (20d + total) at the actor, no log spam.
15.4 **Audio (Web Audio synth only):** hit thock, crit chime, gold
  jingle, portal hum, death sting, 4-floor biome stingers. Master mute.
15.5 **Screens:** title (New/Continue/Reset) → character builder (5 stages,
  summary sheet) → hub (sheet + Edit sheet + shop + upgrades + descend +
  Export/Import save + Settings) → run (HUD + floor banner + pause
  overlay with Export) → death/escape recap (stats, XP, gold breakdown,
  signature AI line when enabled) → hub.
15.6 **Feedback budget:** every action must produce visible feedback
  (shake, float, flash, sound) within 100 ms; no silent state changes.
15.7 **Accessibility:** colorblind-safe success/fail markers (✓/✗ + color),
  all text ≥ 14 px, no time-limited inputs except optional 2 s flee-confirm.
15.8 **Settings (hub):** AI narrative endpoint (URL, model, key — off by
  default, "cast test" button, last prompt/response viewer), master sound,
  dice-animation toggle, and wipe-all-data (type-CONFIRM).

## 16. Content Budgets (v1 completeness)
- 10 species, 6 origins, 12 classes — all implemented to the §4 tables.
- ≥ 24 spells (3 per school × 8) + 12 cantrips (1–2 per class).
- ≥ 16 enemies (4 tiers × 4 biomes), 2 elites, 10 weapon prototypes
  (2 per group) + property/mastery tags, 6 armors (1 per weight class × 2),
  4 shield variants, 6 potions/scrolls, 6 magic items (rarity 1–3).
- Feats: 12; Boons: 3; Hub upgrades: the five in §11.2.
- Static prose bank (AI fallback, §13.4): ≥ 8 lines per biome (×4),
  ≥ 1 enemy line per enemy prototype, ≥ 8 treasure lines, ≥ 8 event lines
  (level-up, near-death, elite kill, escape, death).

## 17. Non-Goals (explicit)
- No multiplayer, no leaderboards, no online persistence beyond the local
  save.
- No backend operated by the game: the AI narrative layer uses only the
  user's own endpoint and is optional (§13).
- No DRM: anti-tamper is client-side validation, tripwires, and in-game
  punishment (§14.5); it does not attempt to encrypt, obfuscate, or make
  cheating impossible from a single HTML file.
- No party/companions beyond the Ranger's summoned beast (single entity).
- No crafting UI beyond the Gnome/Forge discounts on shop potions.
- No localization beyond English.
- No day/night, weather, or light simulation (Darkvision is flavor).

## 18. Acceptance Criteria (definition of done)
1. A brand-new visitor can go from title screen → death/escape → second run
   without any external help, in under 5 minutes.
2. Re-opening the browser restores banked gold, level, and unlocks exactly.
3. A floor generates < 50 ms and the game holds a smooth frame rate with
   all 16 entities + effects on screen.
4. Every rule quoted in §4–§11 is visible in-game somewhere (tooltips on
   hover / a "Rules" screen summarizing the house rules).
5. All content budgets in §16 exist and are reachable in a full run
   (floors 1–10, no dead content).
6. Works from `file://` and offline; console-free in Chrome and Firefox.
7. Save round-trip: export → wipe local save → import reproduces an
   equivalent playable state; a corrupt/foreign file leaves the existing
   save intact with a visible error.
8. AI isolation: with the endpoint off (or unreachable), a seeded run
   produces byte-identical in-game text and identical outcomes across
   replays; a mocked LLM returning garbage (non-JSON, oversize, insults)
   changes no number anywhere.
9. Anti-tamper: importing a crafted save (all-elevated scores), a
   single-field hand edit (broken chain), or an out-of-pool feat shows the
   Tamper Report, applies exactly the §14.5 punishment (clamp, −4 to the
   two class-core scores, SILENCED class powers), and the resulting
   character is fully playable; a clean export→import cycle passes with no
   report; re-importing an already-punished unmodified save adds no
   further penalty.
