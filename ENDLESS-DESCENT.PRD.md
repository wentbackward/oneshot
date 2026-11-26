# Product Requirements Document: "The Endless Descent"

**Status:** Revised MVP specification

**Normative language:** “Must” and “required” are acceptance requirements;
“post-MVP” describes a later delivery, not permission to leave an MVP
subsystem unfinished.

## Brief
Build a complete, playable, persistent endless dungeon crawler as a static
browser application (vanilla HTML5 + CSS + JavaScript, Canvas or DOM).
Mechanics are original house rules inspired by tabletop D&D, adapted to a
turn-based solo game with short-to-medium-term planning and long-running,
savable characters.

Raw reference catalogs may live in `game-data/`; the game must instead use
**normalized, schema-validated runtime catalogs** described in §17. The
runtime catalogs define playable content and numeric content data. This PRD
defines how that content plays. A conflict is a release-blocking defect, not
something an implementation may resolve silently.

## Concept: "The Endless Descent"
The player creates a character using dice rolls or Point Buy, picks a
species, origin, and class, then explores **one persistent, endless dungeon**
per character. The dungeon is planned and generated in five-floor regions.
The current region and the next two are visible in advance, including their
principal monsters, hazards, boss traits, recommended level, and rewards.

A region's difficulty is fixed when its forecast is created. It never
rerolls or rescales. The player may attempt a dangerous region immediately,
or withdraw, gain levels, acquire suitable equipment, and return with a
stronger, better-informed build. Knowledge and preparation are progression,
not merely flavor.

Reaching the surface banks carried gold, loot, and XP and restores the hero
at the Hub. Banked gold buys bounded permanent upgrades. Cleared rooms,
defeated enemies, emptied chests, activated waystones, and the dungeon
frontier persist between expeditions. There is no final floor.

Characters advance from level 1 to a **maximum of level 10**. Dungeon depth
continues forever through new region identities, encounter compositions,
hazards, boss traits, and increasing rewards rather than unlimited character
or enemy stat inflation. Retirement at level 10 is optional.

Design philosophy:
- **Small readable numbers.** d20 checks, small dice pools, flat modifiers,
  character levels 1–10, and enemy ranks 1–12.
- **Legible death.** The event log must let a player explain why they died in
  one sentence.
- **Strong choices.** Species × class × origin × feats, equipment, and
  advance region intelligence support planning without combinatorial soup.
- **Recovering resources.** Slots and per-floor abilities recover at defined
  boundaries; the game is about pacing, not accounting.
- **Meaningful, non-destructive death.** Unbanked gains are at risk, but the
  character, persistent dungeon, level, and Hub progress survive.
- **No fake security.** Local saves are player-editable. Validation protects
  safety and consistency; it does not punish alleged cheating.

---

## 1. Platforms & Hard Constraints
1. The MVP is a **multi-file static browser application** under
   `endless-descent/`: local HTML, CSS, JavaScript, runtime JSON, and
   procedural assets. A single HTML file is not required.
2. There is no application backend, account system, or server-side game
   logic. Any ordinary static HTTP host must be able to serve it. Because
   native modules/JSON may be fetched, direct `file://` launch is not an MVP
   acceptance requirement.
3. After its static assets load, gameplay requires no network service. The
   only optional network integration is the player-configured LLM narrator
   (§12).
4. No external libraries, CDNs, remote fonts, images, or audio assets are
   permitted at runtime. Visuals use emoji, CSS, and Canvas shapes; sound
   uses Web Audio synthesis.
5. Runtime catalogs and browser assets are checked-in deployable artifacts.
   Offline authoring/validation tools may produce them, but a player-facing
   build step is not required on the host.
6. The hub, packaging manifest, Dockerfile, and gate tests must include the
   complete `endless-descent/` application, not merely its HTML entry point.
7. Generating one floor must take **< 100 ms at p95** over 1,000 seeded
   generation cases on the reference laptop: 4-core 8th-generation Intel
   Core i5 or equivalent, 8 GB RAM, 1280×720 viewport, current stable
   Chrome, with the browser version recorded in the performance report. No
   requirement exists to generate an infinite dungeon eagerly.
8. Target 60 fps during presentation, with visible action feedback within
   100 ms. Turn resolution must not wait for animation or an LLM response.
9. Keyboard-first (WASD/arrows + number keys), with visible on-screen
   buttons for every action so a mouse-only player can also play.
10. The deterministic rules, generation, and snapshot model must be separate
    from browser storage and optional network adapters. A later delivery may
    add an authoritative server for shared-world/MMORPG play, but that is
    explicitly outside the MVP (§15).

## 2. Target Audience
- Solo players who enjoy persistent, multi-session adventures and advancing
  a character through short-to-medium-term goals.
- Players who like learning about a future challenge, preparing a build for
  it, and returning to overcome it.
- Fans of classic dungeon crawlers and tabletop RPGs who want D&D-inspired
  character creation and tactical turns without running a table.

## 3. Core Loop & Persistence
```
                 advance forecasts: current region + next two
                                      │
HUB ──travel to entrance/waystone─────▼──────────────┐
 │                PERSISTENT ENDLESS DUNGEON          │
 │       explore → fight → loot → plan → descend      │
 │                │                      │             │
 │          sanctuary waystone      boss waystone      │
 │                └──────────┬───────────┘             │
 └──── SURFACE: bank, heal, identify, prepare ─────────┘
```

### 3.1 Expeditions and the persistent world
- One **expedition** is the interval between leaving the Hub and reaching the
  surface or dying. The dungeon itself does not reset between expeditions.
- The dungeon entrance, each sanctuary waystone, and each defeated boss's
  waystone are return-travel points. The Hub can send the character to any
  activated waystone.
- A waystone can extract the character only outside combat. Extraction banks
  all carried gold, loot, and XP, ends the expedition, restores HP and slots,
  removes hostile conditions, and returns the character to the Hub.
- Cleared rooms, dead enemies, opened chests, collected loot, triggered
  hazards, unlocked stairs, and activated waystones remain changed after a
  voluntary extraction. Ordinary content does not respawn in the MVP.
- A boss opens the stairs to the next region and activates a permanent boss
  waystone. Killing a boss never forces the player to leave the dungeon.

### 3.2 Death
- Death ends the expedition and returns the character to the Hub.
- All unbanked gold and items are lost. Opened chests and collected loot
  remain opened/collected in the persistent world, so lost items cannot be
  farmed repeatedly through intentional death.
- The character receives **30% of unbanked XP**, rounded down, as memorial
  XP; the other 70% is lost. This is the explicit exception to “unbanked
  rewards are lost.”
- Defeated enemies remain defeated. Surviving members of the interrupted
  encounter return to their spawn positions with full HP and no conditions.
  Other world state persists. Thus neither kills nor damage can be farmed by
  deliberately dying.
- The character keeps level, species, origin, class, feats, banked property,
  and Hub upgrades. Level-ups caused by memorial XP are resolved in the death
  recap before the next expedition.

### 3.3 Hub
The Hub provides: character sheet and identity editing; region forecasts;
equipment and attunement management; bounded permanent upgrades; paid
ability re-rolls; merchants; one identification action per Hub visit;
contracts; waystone travel; save import/export; and Settings.

### 3.4 Contracts
- The board offers up to three currently achievable contracts attached to
  the current or forecast regions. It cannot target dead enemies, collected
  items, or already rescued captives. The character has at most one active
  contract, may abandon it at the Hub for no reward, and accepting one never
  changes region difficulty or locks extraction.
- MVP objectives use this closed schema; arbitrary natural-language goals are
  not executable content:
  - `slay {targetSpawnId}` — kill the indicated boss or named creature.
  - `retrieve {itemInstanceId}` — acquire the item and extract with it.
  - `rescue {captiveId}` — interact with the captive and then extract. The
    captive is abstract after rescue and is not a combat companion.
  - `cull {factionId, count}` — defeat the required number of that faction
    after accepting the contract.
- Ordinary gains bank even if the contract is incomplete. An incomplete
  contract remains active while its objective is still achievable and pays
  nothing. If persistent world changes make it impossible, it fails without
  a separate penalty.
- A contract pays its gold and XP bonus only when its completion state is
  banked at a waystone. Death fails the active contract and forfeits its
  bonus, including for an already slain target; rescued captives remain
  safe and required carried items are lost. A failed contract cannot be
  retaken against the same consumed objective.
- Boss portals and extraction do not implicitly complete unrelated contract
  objectives. Free expeditions remain pure treasure/exploration runs.

---

## 4. Character Creation (once, per character)
Creation has five locking stages: identity → abilities → species → origin →
class, followed by a summary. Identity remains editable at the Hub.

### 4.0 Identity
- **Name:** required, 1–16 Unicode code points after trimming.
- **Gender / identity:** optional list choice or custom text, ≤ 40 code
  points. Used only in narration and the sheet.
- **Description:** optional, ≤ 140 code points; shown on recaps and included
  in LLM narration prompts only when that feature is enabled.
- Identity never gates or scales gameplay. All fields render as text, never
  trusted HTML, and travel in non-secret save data.

### 4.1 Ability Scores
**Roll:** six independent 4d6-drop-the-lowest rolls, range 3–18, exact mean
12.2446. The animation lasts at most one second and is skippable.

**Point Buy:** six scores start at 8 and may be raised to at most 15 using
no more than 27 points:

| Score | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Cost from 8 | 0 | 1 | 2 | 3 | 4 | 5 | 7 | 9 |

Rolling and Point Buy are alternatives, not mathematically identical power
budgets. Point Buy is the predictable option.

Ability modifier is always:

`modifier(score) = floor((score − 10) / 2)`

Base scores are 3–18. Species bonuses can produce final scores 3–20, hence
modifiers −4 through +5.

| Ability | Rules it drives |
|---|---|
| **STR** | Melee/thrown attack and damage, shove, consumable stack capacity |
| **DEX** | Ranged/finesse attack and damage, initiative, armor-dependent AC, locks |
| **CON** | Max HP and Poison/Bleed/Stun saves |
| **INT** | Wizard spell attack/power; arcana locks, doors, and traps |
| **WIS** | Cleric/Druid/Ranger/Monk powers; trap detection; Fear/Charm saves |
| **CHA** | Bard/Paladin/Sorcerer/Warlock powers; prices and Intimidate |

There is no separate DEX critical-chance roll and no second dodge roll;
§5 defines both precisely.

**Paid re-roll:** pay for a 4d6-drop-lowest attempt against one current base
score, then keep the old score or take the new one. The cost is paid either
way. Attempts may target any ability repeatedly. Attempt `n` (zero-based,
global for the character) costs `n < 15 ? roundUpTo5(50 × 2^n) :
1,000,000` gp. The piecewise price avoids evaluating huge exponentials and
prevents numeric overflow during long-running play. The save records every
attempt, its before/rolled values, cost, and accept/reject decision.
Species bonuses apply after the final base score and are not re-rolled.

### 4.2 Species (pick 1 of 10)
Each species grants +2/+1 abilities (except Human), one signature passive,
and any Darkvision flag in its runtime entry. Darkvision is cosmetic because
there are no light rules; it is not granted universally. Active species
abilities such as Breath Weapon and Radiance use a primary action unless
their text explicitly says otherwise.

- **Dragonborn** (+2 STR, +1 CHA) — **Breath Weapon:** once per encounter,
  choose fire/cold/lightning/poison at creation; a three-tile cone deals
  2d6 of that type, DEX save for half.
- **Dwarf** (+2 CON, +1 WIS) — **Stonecunning:** hidden doors/traps appear
  as minimap outlines; +2 saves vs. Poison and Bleed.
- **Elf** (+2 DEX, +1 INT) — **Keen Senses:** +1 trap detection and +1 saves
  vs. Charm/Fear. **Fey Ancestry:** immune to Sleep; Stun from a sleep source
  is capped at one turn instead.
- **Gnome** (+2 INT, +1 DEX) — **Tinkerer:** one additional consumable-only
  pack slot; Hub potion prices ×0.8 after other price rules.
- **Goliath** (+2 STR, +1 CON) — **Power Throw:** thrown attacks may use STR;
  once per expedition, survive a killing blow at 1 HP.
- **Halfling** (+2 DEX, +1 CHA) — **Lucky:** three times per floor, after a
  failed own check or save, roll twice and take the better result.
- **Human** (+1 to two different abilities, player's choice) — **Versatile:**
  choose one additional feat at creation.
- **Orc** (+2 STR, +1 CON) — **Menacing:** +1 damage vs. creatures of a
  larger size class; ordinary enemies have −2 tiles to their initial
  detection radius against the player, minimum 1 tile.
- **Tiefling** (+2 CHA, +1 INT) — **Infernal Legacy:** a free fire cantrip
  that never costs a slot and follows §7.3.
- **Aasimar** (+2 CHA, +1 CON; heroic variant replaces CON with +1 STR) —
  **Radiance:** once per floor, purge all hostile conditions from yourself
  and heal 1d4.

“Per floor” means one dungeon floor, not a character level. Per-floor uses
refresh on the first entry to each floor during an expedition; backtracking
does not refresh them. A new expedition refreshes them again. “Per
expedition” means between Hub departures and surface/death returns.

### 4.3 Origin / Background (pick 1 of 6)
Each origin grants the following complete package; there is no hidden skill
or durability subsystem:

- **Acrobat** — +1 AC from dodge and +1 DEX checks against floor traps;
  rope: open one marked shortcut per floor; climbing gear and torch; 50 gp.
- **Criminal** — +1 lock-pick checks and +1 percentage point of shop discount;
  thieves' tools; dagger and lockpicks; 50 gp.
- **Guild Artisan** — sells items at 55% instead of 50%; craft tools and a
  voucher for one free Hub potion at character creation; 50 gp.
- **Noble** — +1 Intimidate checks; fine clothes and signets; 100 gp instead
  of 50; CHA shop discount reduced by one percentage point.
- **Outlander** — +1 survival checks and +1 Poison saves; navigator's tools,
  cloak, and rations: heal 1 HP after the first sanctuary rest in each
  region; 50 gp.
- **Sage** — +1 arcana checks and +1 damage once per non-cantrip spell cast;
  scholar's pack and scroll case: one free scroll per expedition; 50 gp.

### 4.4 Class (pick 1 of 12)
A class supplies its starting weapon family, two starter abilities/spells,
one signature with a cooldown, and permanent milestones at character levels
3 and 6. Signatures start each floor ready; their cooldowns count the
owner's completed combat turns and persist between encounters on that floor.
Activated milestones use a primary action unless their text says free,
quick, passive, or modifies another action. Outside combat, using a
signature starts combat turns if a hostile encounter results.

| Class | Starter abilities | Signature (cooldown) | L3 / L6 milestones |
|---|---|---|---|
| Barbarian | Primal Strikes + Reckless (+2 damage, −2 AC for 2 turns) | **Rage** (10): 3 turns, +2 damage and physical resistance | Second Wind: heal 1d10+level once/encounter · **Brutal Strike:** first melee hit each turn gets +2 damage and pushes 1 tile |
| Bard | Healing Word + Vicious Mockery | **Inspire** (8): next 3 attack rolls threaten criticals on 18–20 | Jack of Trades: +1 to one chosen check/floor · Slumber: one enemy Sleeps 1 turn |
| Cleric | Divine Smite + Healing Prayer | **Divine Favor** (10): smite damage +2 for 2 turns | Lay on Hands: 50-point heal pool, refreshed/floor · Sanctuary: immune to damage 2 turns; melee attackers are pushed 1 tile |
| Druid | Elemental Dart + Druidic Healing | **Wild Shape** (12): 2 turns as bear (+2 AC, 2d8 melee) or wolf (+2 dodge, speed 6, 1d8 melee) | Land's Stride: ignore difficult terrain · Conjure: one 10 HP beast for 5 turns |
| Fighter | Weapon Mastery Training + Combat Maneuvers (once/encounter: Shove as a quick action) | **Action Surge** (12): free activation; one additional primary action this turn | Second Wind: heal 1d10+level once/encounter · **Extra Attack:** Attack action makes two basic attacks |
| Monk | Unarmed Flurry + Ki Restore | **Flurry** (8): three strikes, each resolved normally at half final damage, rounded down per strike | Evasion: ranged/spell damage halved · Stunning Strike: hit inflicts Stun 1 turn, CON save negates |
| Paladin | Lay on Hands (40-point heal pool, refreshed/floor) + Divine Smite | **Aura** (12): self +1 AC and nearby enemies Slowed for 2 turns | Divine Health: immune to Poison · **Smite Breaker:** declare before one melee Attack action/encounter; its first attack is a guaranteed hit +1d8 radiant |
| Ranger | Hunt Shot + Favored Enemy (+2 damage vs. chosen type) | **Call Beast** (15): one active 10 HP companion until killed or extraction | Natural Explorer: floor map outlines · Hunter's Mark: primary action; attacks against one target have advantage until it dies, extraction, or a new mark |
| Rogue | Backstab (+2 after moving or when the target is adjacent to your companion) + Poison Blade (twice/floor: on hit, Poison 1d4 for 2 turns) | **Evasion** (8): +2 dodge and +1 critical threat range for 2 turns | Sneak Attack: +2 damage after moving · Uncanny Dodge: automatically negate one hit/floor, with no reaction spent |
| Sorcerer | Fire Bolt + Chill | **Surge** (10): next spell this turn is free and overcharged one rank | Metamagic: one spell/floor has doubled duration · Elemental Affinity: chosen element gets +2 damage and +1 save DC |
| Warlock | Hex + Eldritch Blast | **Pact** (10): next 3 attacks within 2 turns gain +1d6 spell damage | Otherworldly: teleport 3 tiles once/floor · Devil's Bargain: free activation; spend 5 HP to reset signature cooldown once/floor |
| Wizard | Light (reveal current room) + Ray of Frost | **Focus** (10): next spell costs no slot | Arcane Recovery: restore one spent slot/floor · Arcane Mastery: choose a school; its spells get +1 damage and +1 save DC |

Fighter's Second Wind exists only at L3; Fighter L6, not Barbarian L6, is
Extra Attack. Barbarian's Brutal Strike and Monk's Flurry apply the heroic
damage bonus only once for the whole signature action (§5.3).

Class weapon families are explicit runtime data. Fighter chooses two of the
four families at creation; every other class gets the one listed for it.
Spellcasting abilities are Wizard=INT, Cleric/Druid/Ranger/Monk=WIS, and
Bard/Paladin/Sorcerer/Warlock=CHA. Non-caster scrolls use the scroll's fixed
ability and modifier.

---

## 5. Combat (turn-based)
### 5.1 Grid, encounters, and turns
- The grid uses orthogonal 10-ft tiles. Base Move is 4 tiles; difficult
  terrain costs 2 movement points per tile. Range and reach use Manhattan
  distance, with deterministic line-of-sight between tile centers.
- Outside combat, every accepted move or interaction advances one dungeon
  turn; only aware/pursuing enemies act. An enemy's base detection radius is
  6 tiles with line of sight. An attack alerts its target and hostiles within
  3 tiles of the target.
- An encounter begins when at least one enemy detects the character. Each
  participant rolls `d20 + DEX modifier`; higher acts first. Ties resolve
  player-first, then ascending immutable spawn ID. Alert places the player
  before all non-Alert participants.
- Each combatant gets one turn per round. On the player's turn:
  - **One primary action:** Attack, Cast, Item, Signature, Shove, Intimidate,
    or Flee.
  - **One quick action:** Move up to Speed, make an eligible Light off-hand
    attack, or use a feature explicitly marked quick. An item is primary
    unless Swift Quaff makes drinking a potion quick.
  - The quick Move may happen before or after the primary action. It is not
    split. Fleet supplies one additional free one-tile step each turn.
  - One reaction per round is available only when a card/feature defines it.
- Extra Attack adds one basic attack to the Attack action. Action Surge adds
  a primary action; it does not add another quick action or reaction.
- A duration of N turns ends after N completed turns of the affected
  creature. A cooldown of N becomes ready after N completed turns of the
  owner. UI shows remaining turns before commitment.
- **Flee:** a primary action, prohibited while Prone or Stunned. Make a DEX
  check at TN 12. On success, Move up to Speed, ignoring difficult terrain,
  and disengage; enemies get one pursuit turn before the encounter ends. On
  failure, no movement occurs. Extraction remains unavailable until combat
  has ended.
- **Shove:** an adjacent primary action, `d20 + STR modifier + proficiency`
  against `8 + target proficiency + max(target STR, DEX modifier)`. Success
  pushes 1 tile or knocks Prone, attacker's choice. A tile is pushable only
  if it is enterable; ledge hazards then resolve normally.
- **Intimidate:** once per floor, make a CHA check at TN 12 against one
  visible enemy. On success it gains Fear for 2 turns; a Gutter at or below
  25% max HP instead flees the encounter. A fled enemy despawns without XP
  or loot and is recorded as fled, not killed.

### 5.2 Attacks, checks, and saves
- Weapon attack: `d20 + proficiency + applicable ability modifier + bonuses`
  vs. AC. Melee/thrown uses STR; ranged uses DEX; Finesse may use either.
  Spell attacks substitute the class spellcasting ability.
- Natural 1 always misses and produces a fumble callout, with no hidden
  counterattack. Natural 20 always hits and is a critical.
- A critical doubles all damage dice belonging to that attack, including
  added Smite dice, but not modifiers, ongoing damage, Cleave, or Graze.
  Effects that add +1 critical threat range expand it by one natural number
  (for example 19–20), never below 16–20.
- **Advantage/disadvantage:** roll two d20 and take the higher/lower. Any
  number of each cancels to one d20; they do not stack. All features call
  this single implementation.
- Saving throws are a deliberate solo-game house rule:
  `d20 + relevant ability modifier + proficiency vs. save DC`.
  A character/enemy effect uses `8 + source proficiency + source ability
  modifier`. A rank-T hazard uses `8 + P(T) + severity + depthBand`, where
  severity is easy 0, routine 2, hard 4, or expert 6.
- Ordinary checks use `d20 + ability modifier + proficiency if proficient`
  against TN 10 easy, 12 routine, 15 hard, or 18 expert. Rules and tooltips
  expose the formula; the event log shows the total and ✓/✗ without log spam.
  Passive trap-detection radius is `max(0, 1 + WIS modifier) + bonuses`
  tiles; an active Search primary action checks the current room once.

### 5.3 Damage, AC, and dodge
- Base damage is `weapon/spell dice + applicable ability modifier + listed
  bonuses`, minimum 0 unless a rule states otherwise. AC never subtracts
  damage. Whenever a rule halves a final damage total, round down after all
  additions.
- Basic weapon attacks and damaging cantrips add **heroic damage**:
  `floor((character level − 1) / 2)`, maximum +4 at level 10. It applies once
  per basic attack or cantrip cast, not to DoTs, Cleave, Graze, or signature
  multi-strikes except once for the whole signature.
- Physical resistance halves bludgeoning/piercing/slashing damage after all
  additions, rounded down. Other resistance halves its listed type. Multiple
  halving effects do not compound.
- AC is `armor result + shield + dodge bonuses − dodge penalties`, minimum 1.
  “+1 dodge” always means +1 AC; “−1 dodge” means −1 AC. There is no second
  avoidance roll.
- Unarmored AC is `10 + DEX modifier`. Armor formulas are in §6.2.

### 5.4 Conditions
Durations come from the source. Reapplying an existing condition keeps the
longer remaining duration. A creature can hold at most two hostile
conditions; applying a third replaces the oldest. Icons show order and
remaining turns.

| Condition | Exact effect |
|---|---|
| Prone | Melee attacks against the creature have advantage; its attacks have disadvantage; it cannot Flee. It stands at the end of its next turn. |
| Stunned | Skip primary, quick, movement, and reactions. A source that permits a save uses CON at end of turn. |
| Sleep | Acts as Stunned; ends immediately when the creature takes damage. |
| Poison | At end of turn take the listed damage, then make a CON save; success ends Poison. |
| Bleed | Stack to 3. At end of turn take listed damage per stack, then make a CON save; success removes all stacks. |
| Charm | Cannot target the source with attacks or hostile effects; WIS save at end of turn ends it. |
| Fear | Cannot voluntarily move closer to the source; attacks against it have disadvantage; WIS save at end of turn ends it. |
| Slow | Lose the quick action. |

### 5.5 Enemy archetypes and fixed rank statistics
Every playable non-boss monster maps to one archetype plus at most two
disclosed traits; bosses use the disclosed boss-trait count in §8.4. Raw
challenge ratings are not used directly. Region rank T is 1–12 and
`P(T) = 2 + floor((T − 1) / 4)`.

| Archetype | Max HP | AC | Attack bonus | Damage | Speed / budget cost |
|---|---:|---:|---:|---|---|
| Gutter | `6 + 2T` | `11 + P(T)` | `3 + P(T)` | `1d4 + floor(T/2)` | 5 / 1 |
| Brute | `12 + 4T` | `13 + P(T)` | `3 + P(T)` | `1d8 + floor(T/2)` | 3 / 3 |
| Caster | `8 + 2T` | `10 + P(T)` | `4 + P(T)` | `1d6 + floor(T/2)`, range 6 | 3 / 2 |
| Boss | `30 + 8T` | `14 + P(T)` | `4 + P(T)` | Basic `1d8 + floor(T/2)`; special `2d6 + floor(T/2)` | 4 / not budgeted |

Enemies use the same attack, critical, damage, and save rules as the player.
For an enemy's saves and effect DCs, its relevant ability modifier is
`floor((T − 1) / 4)`, or one higher for a boss, unless a disclosed trait
supplies a different value. The same derived value supplies STR, DEX, and
WIS when a Shove or detection rule needs one. A boss special is telegraphed
one full round and has a three-turn cooldown.
There are no hidden elite tiers or flat percentage save-resist rolls.

---

## 6. Weapons & Equipment
### 6.1 Weapon properties and Mastery
Weapons have damage dice, range, one property, one Mastery tag, and one of
four families: simple/melee, simple/ranged, martial/melee, martial/ranged.
A class unlocks Mastery for its listed family; Fighter gets two. Cross-
Training unlocks one additional family. Origins do not secretly unlock them.

| Property | Exact effect |
|---|---|
| Finesse | Use STR or DEX for attack and damage, chosen per attack. |
| Light | After a primary Attack with a Light weapon, the quick action may make one basic attack with a different equipped Light weapon instead of Move. Add no ability modifier to this off-hand damage. |
| Versatile | One-handed uses base dice; two-handed increases each damage die one step (`d4→d6→d8→d10→d12`). A shield or off-hand weapon prevents two-handed use. |
| Ranged | Uses DEX, requires line of sight, and has unlimited ammo. A hostile adjacent enemy imposes disadvantage. |
| Reach | May target one or two tiles away. |
| Thrown | May make a ranged attack up to 3 tiles; uses STR unless Finesse or Power Throw says otherwise. |

Mastery triggers at most once per turn unless the feature says otherwise:

| Mastery | Exact effect |
|---|---|
| Cleave | On hit, strike a second enemy adjacent to the target and within reach for half final damage; no on-hit riders. |
| Vex | The target's next attack has disadvantage. |
| Topple | On hit, target makes a STR save against the attacker's effect DC or falls Prone. |
| Graze | On a miss, deal only the applicable ability modifier as damage; no other bonuses. |
| Push | On hit, target makes a STR save against the attacker's effect DC or is pushed 1 tile. |

### 6.2 Armor and shields
| Armor | AC rule | Additional rule |
|---|---|---|
| Light | `base 11 + full DEX modifier` | None |
| Medium | `catalog base 12–15 + min(DEX modifier, 2)` | None unless a disclosed item trait says otherwise |
| Heavy | `fixed catalog base 14–18`; no DEX addition | +1 saves vs. Poison/Bleed; requires STR 13. Below STR 13: Speed −1 and −1 to DEX checks/saves |
| Shield | `+2 AC` | Occupies the shield hand; prevents two-handed and off-hand weapon use |

### 6.3 Loadout, pack, and attunement
- Loadout slots are one armor, one shield, and two weapons. Equipped items
  do not consume pack slots.
- The pack has 5 general slots. Vault-Keeper adds 1, up to three Hub
  purchases add 1 each, and Gnome adds 1 consumable-only slot.
- Gear uses one slot per item. Identical consumables stack to
  `max(1, 3 + STR modifier)` per slot; Gnome's slot accepts only consumables.
- At most three magic items may be attuned. Equipping a fourth requires the
  player to choose a replacement; nothing is silently unequipped.
- Banked equipment survives death. Unbanked items are marked by expedition
  and are lost on death even if temporarily equipped.

---

## 7. Magic
### 7.1 Slots and rest
Classes have full (Bard, Cleric, Druid, Sorcerer, Warlock, Wizard), hybrid
(Monk, Paladin, Ranger), or martial (Barbarian, Fighter, Rogue) slot tracks,
with 3, 2, or 1 slot respectively.

Slots are **per-floor resources**: they refill on the first entry to a floor
during an expedition and once at that floor's sanctuary, not on backtracking
or between ordinary encounters. There are no long rests inside a floor.

| Character level | Full track | Hybrid track | Martial track |
|---|---|---|---|
| 1–2 | 1 / 1 / 1 | 1 / 1 | 1 |
| 3–4 | 1 / 1 / 2 | 1 / 2 | 2 |
| 5–7 | 1 / 2 / 3 | 2 / 3 | 3 |
| 8–9 | 2 / 3 / 3 | 3 / 3 | 3 |
| 10 | 3 / 3 / 3 | 3 / 3 | 3 |

Numbers are slot ranks, not additional slots. Overcharge spends a higher-
rank slot on a lower-rank spell and applies the card's one-rank overcharge
rule; no effect may be overcharged more than one rank.

### 7.2 Spell cards
Every playable spell normalizes to:
`{id, level 0–3, school, classes, castTime action|reaction|passive,
rangeTiles, duration, effect, save, overcharge}`.

The eight schools have distinct verbs: Evocation=damage, Abjuration=ward,
Transmutation=move/alter, Necromancy=drain, Enchantment=Charm/Fear,
Illusion=decoy, Conjuration=summon/projectile, Divination=reveal/detect.
Runtime validation rejects effects outside implemented verbs.

### 7.3 Cantrips
Cantrips cost no slot. Damaging cantrips use a normalized 1d6 base die at
level 1, upgrading to 1d8 at level 3, 1d10 at level 5, and 1d12 at level 8.
They also receive heroic damage (§5.3). Non-damaging cantrips disclose
range/duration upgrades on their cards at the same levels. No cantrip grows
after level 8.

---

## 8. Endless Dungeon & Advance Planning
### 8.1 Persistent identity and lazy generation
- A new character receives one 128-bit dungeon seed and one persistent
  dungeon. There is no final floor or deepest level.
- Region manifests and floor layouts derive from `(dungeonSeed, regionIndex,
  localFloor, GENERATOR_VERSION, CATALOG_VERSION)`.
- Only manifests and entered floors need materialization. Future floors are
  generated on demand; an infinite dungeon is never held in memory.
- All gameplay randomness uses named, serializable, seed-keyed PRNG streams.
  Manifest generation, floor generation, combat, and loot use independent
  streams; neither `Math.random`, wall-clock time, nor narration output may
  advance them.
- Once a manifest or floor is generated, its gameplay content is immutable
  except for player-caused state changes. Character level-ups never rescale
  existing content.

### 8.2 Five-floor regions
Region indices R are zero-based. Each region has five local floors:

1. **Arrival:** entrance and branching exploration.
2. **Development:** guaranteed weapon/armor drop and contract opportunities.
3. **Sanctuary:** no hostile spawns and enemies cannot enter; crossing its
   threshold ends any active encounter. It contains one fountain, one
   merchant, and a waystone activated on entry.
4. **Pressure:** harder encounter composition and a deep-chest opportunity.
5. **Boss:** one boss with disclosed traits. Its defeat unlocks the next
   region and activates a permanent extraction/travel waystone.

Each non-sanctuary floor has 4–8 rooms, a guaranteed walkable route from
entry to exit, and branches/dead ends. Doors may be open, barred, locked
(DEX/STR), or secret (passive WIS radius/active search). Loops and shortcuts
are included where valid. Connectivity validation covers every required
objective, not merely the stairs.

### 8.3 Rolling three-region forecast
- At character creation, region 0 is current and manifests 0, 1, and 2 are
  planned.
- **Current region** means the highest region entered for the first time,
  not the region physically being revisited. On that first entry to region
  R, ensure manifests R+1 and R+2 exist. Any newly required manifest uses
  the character's level at that moment. Backtracking and boss kills do not
  move the window or replan anything; entering the newly unlocked region
  does. Thus a player can extract, level up, and then enter the next region
  before its next two successors are planned.
- The Hub sheet and dungeon map display the current and next two manifests.
  This is the player's short-to-medium-term planning surface.
- Each forecast discloses: region identity/creator/purpose/history/faction;
  recommended level and challenge class; rank; monster archetypes, families,
  damage types, and notable traits; hazard families; boss traits; biome; and
  exact reward multiplier. Hidden room layouts and exact loot rolls remain
  unknown.
- Manifest IDs and contents never reroll, including after death, import, or
  a game restart.

### 8.4 Region rank and endless complexity
When a manifest is created, seed the challenge class using this exact table:
60% standard (+0), 25% dangerous (+1), 15% apex (+2). Region 0 is always
standard. Each manifest stores its immutable `plannedCharacterLevel` and
challenge class.

`regionRank = min(12, max(1, plannedCharacterLevel + challengeOffset))`

The recommended level displays `min(10, regionRank)`; ranks 11–12 carry a
clear “beyond normal level cap—prepare gear and counters” warning. Entering
early is allowed.

Depth adds bounded complexity rather than infinite raw stat inflation:

`depthBand = min(4, floor(R / 2))`

`rewardMultiplier(R) = min(10, 1 + 0.15R)`

The gold multiplier rises to ×10 and then remains capped; exact values are
shown in forecasts and all arithmetic remains within safe-integer bounds for
individual rewards.

Balance is tested with a versioned reference bot and reference loadouts
checked into the test suite. Over 1,000 simulated attempts per cell, target
boss-clear rates are: standard at recommended level 65–90%, dangerous at
recommended level 50–80%, and apex with its disclosed counters and rarity≤2
equipment 35–70%. For ranks ≤10, returning two character levels higher with
the same policy must improve the clear rate by at least 10 percentage points
unless the 90% ceiling prevents the full increase.

- depthBand increases encounter budgets (§8.5) and hazard DC/damage.
- Bosses receive `min(3, 1 + floor(R / 3))` disclosed traits, selected
  without replacement from the validated boss-trait pool.
- Example traits: **Armored** (+1 AC); **Frenzied** (+1 Speed below 50% HP);
  **Venomous** (on hit, Poison 1d2, CON negates); **Summoner** (every third
  turn, summon one Gutter, maximum two alive); **Burning** (+1 fire damage
  and a telegraphed burning tile).
- After caps are reached, new seeds continue combining identities, factions,
  room graphs, hazards, traits, and rewards. There is no final boss.

### 8.5 Encounter and threat budgets
Archetype costs are Gutter 1, Caster 2, Brute 3. Each non-sanctuary,
non-boss floor has:

`B = 6 + challengeOffset + 2 × depthBand + min(3, floor((regionRank − 1) / 3))`

Procedural placement spends at least B−1 and at most B, distributed across
4–8 rooms. No spawn is placed on the entry tile or an unavoidable required
path tile without an adjacent escape tile.

A boss floor contains the boss plus a minion budget of
`min(8, 2 + depthBand + challengeOffset)`. Boss traits and summons are not
silently charged against this budget; their disclosed effects define the
whole encounter.

### 8.6 Biomes, hazards, and treasure
- Region identity fixes its monster pool, room purposes, boss identity, and
  visual theme. Biomes include Damp Cellars, Root Cellars, Grave Tunnels,
  Molten Depths, and Cracked Void; palettes vary by floor.
- Hazard damage is `1d6 + floor(regionRank/2) + depthBand`; saves use §5.2.
  Collapsing floors also destroy one seeded unbanked, unequipped pack item
  and name it in the log. Spore clouds inflict Poison; plates and pits make
  DEX checks or deal damage.
- Each ordinary floor has 1–3 gold piles. Base pile value is a seeded integer
  5–60 gp, multiplied by `rewardMultiplier(R)`, rounded down.
- Local floor 2 guarantees one weapon/armor drop and one class-compatible
  scroll. Local floor 4 has a 50% seeded chance of a second scroll.
- Weapon tier by region rank: ranks 1–2 simple; ranks 3–5 a seeded 50/50
  simple/martial choice; ranks 6+ martial.
- Magic items occur only in deep chests (region 2+) and from bosses:

| Source | Rarity 1 | Rarity 2 | Rarity 3 |
|---|---:|---:|---:|
| Deep chest | 70% | 25% | 5% |
| Standard boss | 0% | 90% | 10% |
| Dangerous boss | 0% | 75% | 25% |
| Apex boss | 0% | 0% | 100% |
| Boss of region 4, 9, 14, … | 0% | 0% | 100% |

The every-fifth-region guarantee overrides the boss row above it. Ordinary
chests contain no magic items. Magic items are found, never bought. Rarity
controls value and which runtime drop table is eligible; every playable
magic item must belong to a reachable table.

### 8.7 Sanctuary services
A sanctuary fountain is usable once per expedition: restore all slots, heal
`ceil(25% of max HP) + max(0, WIS modifier)`, and purge Poison/Bleed. Its
merchant has six seeded items. Enemies cannot cross the sanctuary threshold,
so its waystone is always outside combat once the character has entered.

---

## 9. Progression
### 9.1 One character-level track
There are no temporary in-dungeon levels. XP is unbanked until extraction or
death. Apply banked XP and all resulting level-ups in the surface/death
recap, then restore full HP. Existing region ranks never change.

Cumulative lifetime XP required for level L is:

`XP(L) = 50 × (L − 1) × L`, for 1 ≤ L ≤ 10

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Total XP | 0 | 100 | 300 | 600 | 1000 | 1500 | 2100 | 2800 | 3600 | 4500 |

At level 10, XP displays `MAX` and no further XP accumulates. Gold, loot,
contracts, region forecasts, and Descension continue to provide goals.

### 9.2 Derived values
- `max HP = 10 + character level + CON modifier + 5 × HP upgrade count + 5
  if Tough`, minimum 1.
- `proficiency = 2 + floor((character level − 1) / 4)`.
- `heroic damage = floor((character level − 1) / 2)`, §5.3.
- Class milestones arrive at levels 3 and 6; proficiency, cantrips, and slot
  ranks follow their own tables.

### 9.3 Feats
At levels 3, 5, 8, and 10, choose one of three seeded offers from this
12-feat pool. Human Versatile grants one unrestricted choice at creation.
Offers and selections are recorded in the save. Magus may appear again only
if it selects a different class cantrip.

- **Lucky:** two additional Lucky-style re-rolls/floor.
- **Resilient:** after failing a save, automatically pass it once/floor.
- **Weathered:** +1 saves against one chosen condition or damage type.
- **Cross-Training:** unlock one additional weapon family's Mastery tags.
- **Alert:** act before non-Alert combatants; initiative is still rolled for
  ordering against other Alert actors.
- **Fleet:** one additional free one-tile step each turn.
- **Swift Quaff:** drinking a potion is a quick action.
- **Forge:** Hub potion price ×0.5 after other price rules.
- **Magus:** learn one damaging cantrip from another class, using your
  class's spellcasting ability.
- **Tough:** +5 max HP.
- **Skirmisher:** +1 Move Speed.
- **Keen:** +1 initiative and +1 trap-detection radius.

### 9.4 Epic Boons
- Level 5 — **Undying:** once per expedition, survive lethal damage at 1 HP
  and purge hostile conditions. This has a separate charge from Goliath's
  passive; Goliath's triggers first.
- Level 8 — **Vault-Keeper:** +1 general pack slot.
- Level 10 — **Warden's Eye:** reveal floor geometry on entry. Secrets,
  traps, monsters, and loot still require discovery.

### 9.5 XP and contract rewards
- Regular kills grant `10 × archetype cost + 2 × (regionRank − 1)` XP.
- Bosses grant `50 + 10 × regionRank` XP. Summoned enemies grant 0 XP and
  drop no loot.
- Contract XP is `25 + 10 × regionRank`, paid only on successful extraction.
- These values are multiplied by nothing else. The region reward multiplier
  applies to gold only, keeping the road to level 10 predictable.

---

## 10. Economy
### 10.1 Coins and prices
All MVP prices and balances are non-negative safe-integer gp; there are no
sp/platinum subunits. Display exact gp values. `roundUpTo5(x)` means
`5 × ceil(x / 5)`, evaluated with decimal/rational arithmetic rather than
binary floating-point accumulation. A gold gain that would exceed the safe-
integer balance limit is rejected with a **Vault Full** warning and remains
claimable at its source until the player makes space; no overflow is
silently wrapped or discarded.

CHA shop discount uses the final score: `clamp(CHA score − 10, 0, 10)`
percentage points.
Criminal adds one point and Noble subtracts one, clamped to 0–10. Gnome and
Forge multiply the resulting potion price by 0.8 and 0.5 respectively.
Descension applies last (§11). Round final prices up to the next integer,
minimum 1 gp.

### 10.2 Bounded permanent upgrades
For an upgrade with zero-based purchase index n:

`price = roundUpTo5(basePrice × multiplier^n)`

| Upgrade | Base / multiplier | Purchase cap |
|---|---|---:|
| +5 max HP | 100 gp / 1.5 | 10 |
| +1 weapon damage | 150 gp / 1.5 | 10 |
| +1 AC | 200 gp / 1.6 | 5 |
| +1 general pack slot | 500 gp / 2.0 | 3 |

Weapon upgrade damage applies once per weapon damage roll. Ability re-roll
pricing is in §4.1. Caps are validated on import and included in enemy
balance simulations.

### 10.3 Merchants and loot
- Hub and sanctuary stalls contain six seeded items. Sanctuary stock is fixed
  when its floor is generated.
- Ordinary items sell for 50% of base price, or 55% for Guild Artisan,
  rounded down. Simple/martial base values are 25/75 gp before item traits.
- Contract gold is `roundUpTo5((40 + 20 × regionRank) × rewardMultiplier(R))`.
- A magic item shows a silhouette until identified. The free Hub Identify
  action reveals one banked item per Hub visit. Rarity 1–3 controls value and
  drop-table eligibility; three attunement slots are enforced at all times.

---

## 11. Retirement & Reincarnation
- At level 10, **Retire & Reincarnate** becomes available but is never
  required. Continuing the same endless dungeon is fully supported.
- Retirement banks everything, archives a small memorial summary, and starts
  character creation with a new character and new dungeon seed.
- Banked gold and capped Hub upgrades persist. The new character keeps one
  identified heirloom magic item from the retired character; all other
  carried property is converted to its normal sale value before creation.
- Descension rank increases by one with no rank cap. Final shop prices are
  multiplied by `1 − min(50, 10 × Descension rank) / 100`.
- The MVP has one active character, not a roster or party.

---

## 12. Optional Generative Layer (LLM)
### 12.1 MVP boundary: narration only
The LLM is optional, off by default, and **cannot change gameplay in the
MVP**. It may write room flavor, NPC/monster color, contract prose for an
already validated objective, encounter intros, and recap lines. Procedural
contracts, numbers, maps, placements, loot, hazards, objectives, and rewards
are complete without it.

A later gameplay-editing layer is post-MVP (§12.7), not an implicit MVP
requirement.

### 12.2 Non-blocking behavior
- Procedural content and default text appear immediately. Network requests
  never delay floor entry, turns, extraction, saves, or death resolution.
- The Settings timeout is configurable and defaults to 30 seconds; it is a
  reliability setting, not a gameplay timing requirement. Timeout, refusal,
  rate limit, malformed output, and offline operation retain default text.
- A response arriving after its element closed is discarded. Text is cached
  by `(dungeonSeed, elementId, model, promptVersion, GAME_VERSION,
  CATALOG_VERSION)`.

### 12.3 Endpoint and browser constraints
Settings accepts an OpenAI Chat Completions–compatible endpoint URL, model,
and optional API key, plus a “cast test” button. Supported browser caveats
(CORS, mixed content, loopback availability) are shown next to the setting;
failure always falls back safely.

### 12.4 Prompt and output limits
- Prompts contain only the condensed style brief, identity explicitly
  provided by the player, and the relevant region manifest/current element.
  The serialized game payload is at most 24,000 characters; the infinite
  dungeon is never sent.
- MVP response schema is `{ "text": string }`, maximum 500 Unicode code
  points. Responses render with `textContent`, never `innerHTML`; control
  characters are stripped and no markup, URL, or script is executable.
- Typewriter presentation is optional, skippable, and never blocks input.

### 12.5 Privacy and credentials
- The API key is stored separately from game snapshots and is **never
  included in save exports, prompts, caches, audit logs, or the last-
  prompt/response viewer**.
- The viewer displays the most recent redacted prompt/response. Identity
  text is sent only when the player enables the narrator.
- The game ships no telemetry or backend of its own.

### 12.6 Determinism
With the narrator off, identical `(seed, region, floor, generator version,
catalog version)` input produces byte-identical canonical gameplay content.
Narrator responses never enter combat RNG, generation RNG, or save-state
validation.

### 12.7 Post-MVP gameplay editor requirements
Any future LLM gameplay proposal must use a closed JSON schema and bounded
IDs/verbs; pass referential, numeric, threat-budget, connectivity, objective
solvability, and safe-text validation; preserve immutable existing manifests;
and fall back atomically to procedural content. Natural-language objectives
are never executable. This paragraph does not authorize MVP gameplay changes.

---

## 13. Save / Load — Complete Logical Snapshots
### 13.1 Snapshot model
The MVP uses a **complete logical snapshot**, not an action/event replay.
Immutable generated geometry may be re-derived from the saved seed and
generator version, but every mutable fact required to continue exactly is
stored explicitly. No random outcome or prior player action is replayed.

A snapshot contains:
- `SAVE_VERSION`, `GAME_VERSION`, `GENERATOR_VERSION`, `CATALOG_VERSION`;
- identity, creation method, immutable creation-base scores, current base
  scores, species bonuses, final derived scores, Point Buy spend, complete
  paid re-roll ledger, feat offers/selections, boons, class milestones;
- character level/XP, current/max HP, banked and unbanked gold, upgrades,
  Descension rank and memorial archive, inventory/loadout/attunement, and
  identification state;
- active expedition position, turn/round, slots, conditions, cooldowns,
  per-encounter/floor/expedition/Hub-visit uses, reactions, companions, and
  every RNG stream state;
- dungeon seed, every planned region manifest (including all forecast data),
  current planning region, physical region/floor, activated waystones, and
  contract state;
- for every generated floor: enemies (identity, spawn ID, HP, position,
  conditions, alive/dead/fled), doors, chests, items, hazards, NPCs, fountain
  uses, merchant stock/purchases, boss/portal/stairs state, and objective
  mutations;
- current-floor full mutable tile state and compact complete mutable records
  for previously visited floors;
- cached accepted narration text where useful. API keys and gameplay-affecting
  LLM proposals are absent.

### 13.2 Autosave and failure handling
- Autosave after every completed player action, floor transition, extraction,
  death recap, and on `visibilitychange`.
- A single serializer serves local save and export. Writes use a checked new
  primary value while retaining the previous known-good backup; parsing and
  validating the new value completes before it becomes primary.
- Quota/serialization failures produce a blocking **Save Failed** overlay
  with Retry and Export options. The game never silently continues as though
  progress were saved.
- Compact mutable records and lazy immutable geometry keep snapshots bounded
  by explored/mutated content rather than total dungeon depth.

### 13.3 Export and import
- Export downloads `endless-descent-save-v{N}.json` from the Hub or pause
  overlay. Non-secret Settings may be included; credentials never are.
- Import sequence: size limit (50 MB) → JSON parse → canonical checksum →
  schema/version validation → semantic validation → summary preview →
  explicit confirm → atomic apply.
- Corrupt, foreign, malformed, unsupported-higher-version, or semantically
  impossible files are rejected with field-specific errors. The current save
  is never partially overwritten.
- Future versions migrate only through named migrators. An incompatible old
  generator is migrated explicitly or refused; generation is never guessed.

### 13.4 Integrity and legal character validation
Validation protects against corruption, unsafe input, and impossible game
state. It is **not an anti-cheat claim**. A player may edit a save; internally
consistent edits within the rules load normally.

- Rolled creation bases are 3–18. Point Buy bases are 8–15, use the exact cost
  table, and spend ≤27.
- Current base scores are 3–18. Species bonuses derive from the chosen
  species; final scores are 3–20. There is no level-based STAT_MAX and no
  aggregate `Σ(score−3)` budget.
- Re-roll attempts form a sequence from creation bases: before values match
  the preceding state, rolled values are 3–18, accepted outcomes equal either
  before or rolled, and costs match §4.1.
- Level is 1–10; XP is in the range for that level and level 10 stores 4500.
  HP is within the derived maximum; gold/XP are non-negative safe integers.
- Feats match recorded legal offers, milestones/boons match their levels,
  upgrades respect caps, inventory IDs belong to runtime catalogs, and
  attunement is ≤3.
- Region manifests match their seed/version/rank rules. Spawn references,
  waystones, objectives, and floor mutations are referentially complete.
- A checksum is `SHA-256` of canonical UTF-8 JSON (object keys recursively
  sorted, arrays preserved, no whitespace, finite numbers only), excluding
  the checksum field itself. It detects accidental corruption only.
- Runtime anomalies open a recoverable error report and use the previous
  known-good snapshot or an explicit export. There is no clamp-and-punish
  path, SILENCED power, VOIDED stamp, or permanent penalty.

---

## 14. UI / Presentation
### 14.1 Graphics and layout
Emoji-first visuals on a dark tile grid with CSS glows; Canvas is reserved
for dice, effects, and screen shake. Use system monospace, text ≥14 px, and
colorblind-safe ✓/✗ plus color.

### 14.2 HUD and planning surfaces
- Top-left: name/identity; left: HP, XP, conditions; center-bottom: last five
  events; right: pack, slot pips, floor/region/biome; top-right: carried and
  banked gold.
- A persistent **Region Forecast** panel shows current + next two regions,
  challenge class, recommended level, threats, boss traits, and rewards.
  The Hub supports comparing equipment against disclosed damage types and
  hazards.
- The map distinguishes entrance, sanctuary, boss, extraction waystones,
  current frontier, and known contract objectives.

### 14.3 Feedback and accessibility
- Creation rolls animate at most one second and are skippable. Combat rolls
  show a brief local sprite/total; the rules screen exposes exact formulas.
- Every action produces visible feedback within 100 ms; animations never
  delay the next accepted turn.
- Web Audio supplies hit, crit, gold, portal, death, and biome cues with
  master mute/volume.
- All actions have keyboard and mouse paths. No gameplay input is time
  limited. Reduced-motion mode disables shake/typewriter effects.
- Screens: title → builder → Hub (sheet, forecasts, shop, upgrades, contracts,
  travel, saves, Settings) → dungeon/pause → death/surface recap → Hub.
- Settings: narrator endpoint/model/key and test button, redacted last
  prompt/response, sound, animation/reduced motion, and type-CONFIRM data wipe.

---

## 15. Out of Scope (MVP Exclusions)
- Multiplayer, parties, MMORPG/shared-world simulation, authoritative game
  servers, accounts, leaderboards, and online persistence.
- LLM modification of maps, numbers, encounters, loot, hazards, objectives,
  or rewards (§12.7 is post-MVP).
- Multiple active characters or multiple simultaneous dungeons per character.
- Combat companions beyond Ranger/Druid summons; rescued captives are
  abstract objective state.
- Crafting UI beyond listed potion discounts/vouchers; gear durability.
- Localization beyond English; day/night, weather, illumination, ammunition
  inventory, and encumbrance beyond §6.3.
- Direct `file://` launch, DRM, cheat attribution, and punishment for edited
  local saves.

---

## 16. Acceptance Criteria (definition of done)
1. **First play:** a new visitor can create a character, understand the three-
   region forecast, extract or defeat a boss, prepare at the Hub, and return
   to the same persistent dungeon without external instructions.
2. **Endless structure:** an automated run can cross regions 0–9 (50 floors)
   without encountering a final-floor branch. Every region 5th local floor
   has a boss and every boss unlocks the next region. Character level never
   exceeds 10 and new regions still generate at MAX.
3. **Locked planning:** for 1,000 seeds, a manifest's rank, threats, boss
   traits, and reward multiplier are identical before and after level-ups,
   death, extraction, and reload. Region rank follows §8.4; the current and
   next two forecasts are always available.
4. **Return stronger:** a recorded dangerous-region fixture entered below
   its recommended level retains identical enemy stats when revisited at a
   higher level. Activated waystones permit extraction and direct return.
5. **Combat rules:** table-driven tests cover initiative ties, quick/primary
   actions, Extra Attack vs. Action Surge, Light off-hand attacks, natural
   1/20, expanded threat ranges, advantage cancellation, AC/dodge, critical
   dice, resistance rounding, every condition, Shove, Flee, and all 12 class
   milestone pairs. AC never reduces damage.
6. **Scaling and performance:** archetype stats match §5.5 for ranks 1–12;
   encounter/depth budgets and caps match §8. Floor generation meets §1.7,
   and a maximum-complexity region stays within the 60 fps target on the
   reference laptop. Seeded combat simulations cover levels 1, 5, and 10,
   including standard/dangerous/apex regions, and report the documented
   balance bands rather than merely map connectivity.
7. **Persistent consequences:** extraction and death preserve exactly the
   world mutations specified in §3. Intentional death cannot duplicate loot,
   reset defeated enemies, or yield repeatable XP from dead/summoned enemies.
8. **Exact snapshot restore:** export → wipe → import reproduces canonical
   logical state after a fixture containing wounded/dead enemies, opened
   doors/chests, collected loot, conditions, cooldowns, companions, active
   contracts, forecasts, waystones, and accepted narration. A 25-region
   explored save also round-trips without action replay.
9. **Creation/import correctness:** clean saves for rolled 18s, species-
   boosted 20s, every legal Point Buy spread, and accepted/rejected re-rolls
   all pass. Corrupt JSON, bad checksums, impossible provenance, foreign
   catalogs, and higher versions leave the existing save untouched. No
   import path applies VOIDED/SILENCED or any other punishment.
10. **Offline determinism:** with the narrator off, seeded canonical floor
    content is byte-identical across two fresh runs. No network is needed
    after static assets load. Chrome and Firefox have no uncaught console
    errors when served by a static host.
11. **Narrator isolation:** with the narrator disabled, unreachable, timing
    out, returning non-JSON, oversized text, HTML/script, or arbitrary
    gameplay proposals, no gameplay number or RNG state changes. Safe
    procedural play continues immediately. Exported saves contain no API key.
12. **Content coverage:** schema validation rejects malformed runtime entries
    and unimplemented verbs. Seeded reachability tests prove every playable
    weapon, armor, spell, monster, and magic item belongs to at least one
    legal generation, class-starting, feat, or drop table. Raw reference-only
    entries are excluded explicitly, not counted as playable content.
13. **Rules and access:** every formula and mechanic in §4–§11 is available
    in tooltips or the Rules screen. A complete expedition is playable using
    mouse only and keyboard only; reduced-motion and mute settings persist.

---

## 17. Runtime Data, Source Fidelity & Intellectual Property
### 17.1 Runtime catalog contract
Raw `game-data/` files are reference/authoring input, not directly playable
truth. The MVP ships a separate normalized runtime catalog with:
- stable IDs and `kind`; schema and catalog versions;
- explicit playable/reference-only status;
- class/species/origin data matching this PRD;
- monster archetype, size, faction, damage types, and at most two traits for
  non-bosses (the disclosed region-specific count for bosses);
- normalized spell cards (§7.2), weapon/armor properties, and implemented
  item effects;
- drop/generation table membership and source/license provenance.

Locations, prose fragments, audit notes, unimplemented effects, duplicate
class-specific raw entries, and raw challenge-rating/stat blocks are not
playable entries. Release validation fails on unknown fields, broken IDs,
unsafe text, or mechanics outside the PRD.

### 17.2 Source fidelity and licensing
The mechanics are original adaptations and descriptive game text must be
original or appropriately licensed. The project must not claim that PHB,
DMG, MM, or other source material is automatically reusable merely because
mechanics have been rewritten.

Every runtime entry carries source and license/provenance metadata. Adding
source text, trademarked setting material, or non-open descriptive content
requires a documented licensing review and, where necessary, permission from
the relevant rights holder. This PRD is not a legal non-infringement opinion.

---

## 18. Suggested Delivery Increments
These increments order implementation; they do not reduce the final MVP
acceptance criteria.

1. **Vertical slice:** normalized minimal catalog, three classes, one
   five-floor region, combat/action economy, boss/sanctuary waystones,
   extraction/death persistence, and exact local/export snapshots.
2. **Persistent endless game:** rolling three-region forecasts, locked
   ranks, endless regions, full encounter/hazard/loot tables, waystone
   travel, and long-run snapshot/performance tests.
3. **Full character game:** all classes/species/origins, levels 1–10, feats,
   boons, contracts, economy caps, retirement, and balance simulations.
4. **Presentation and optional narrator:** accessibility, audio/animation,
   forecast comparison tools, and isolated narration-only LLM integration.
5. **Later products:** LLM gameplay editing and authoritative shared-world/
   MMORPG services, each with a separate specification and security model.
## 19. Visual Direction & Media Design (standing requirement)

Before any visual work on this product starts, the digital-media-designer
skill (asset-forge toolchain) defines and documents the overall look and feel:

- Style and a one-sentence concept line for the world and mood.
- Colour palette per theme: a named hex list per theme or biome; contrast
  hierarchy so gameplay-critical elements (danger, affordances, party state)
  pop against receding scenery.
- Consistency anchors: light direction, outline policy, detail level.
- Required assets and animation direction: for every element that moves —
  what moves, how, frame count and cadence, easing.
- The palette/theme definitions are part of each ticket's acceptance
  criteria; final image assets follow docs/ASSET-SOURCING.md (where
  applicable).
