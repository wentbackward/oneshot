# Asset Sourcing Runbook (ticket #137)

How placeholder art is replaced with final, human-approved art for
**bricks** and **fishtank**. The asset contract itself is normative in
`docs/DECISIONS.md` (Ticket #137 entries). Two standing exclusions:

- **Asteroids never takes image assets** — its look is faithful to the
  original arcade game and stays fully procedural.
- **Audio is synthesized Web Audio in every game, forever** — this
  runbook covers image assets only.

## Channel priority (cheapest clean license first)

1. **Freely licensed libraries** — CC0 / public domain collections
   (Kenney.nl, OpenGameArt.org): fastest, and the cleanest fit for an
   open-source repo.
2. **Commission or stock purchase** — only with perpetual web-usage
   rights that cover redistribution in an open-source repository.
3. **Open-weight-model generation** — with per-asset license/usage
   verification: the model license AND its usage/training terms must
   explicitly permit this use; the check is recorded per asset, not
   assumed.

## Human-in-the-loop gates (the loop does not approve art)

- A human **visually approves each asset** before it is committed under
  `assets/<game>/`.
- A human **verifies the license/attribution** for that asset before
  merge.
- The loop's job stops at STAGING: place the file at the slot's name,
  update the manifest, rebuild, run the suites, and assemble the
  regression evidence below.
- Both approvals are recorded on the intake checklist: one line in the
  PR/ticket thread (approver role, asset name, license verdict) plus the
  permanent attribution in `assets/<game>/LICENSE.txt`.

## Intake runbook (one slot → final art)

1. **Slot geometry is the manifest's.** The slot's name, required
   dimensions, frame count and alpha/tiling expectations are declared in
   `assets/<game>/manifest.json` (`width × height`,
   `frameWidth × frameHeight × frames`, `alpha: opaque|alpha`,
   `tiling: bool`, `category`). Final art replaces the file IN PLACE at
   `assets/<game>/<file>` — renaming the slot is a code change and a
   separate ticket.
2. **License placement.** Set the manifest entry's `license` field
   (license id + author) and add the matching attribution line to
   `assets/<game>/LICENSE.txt`. Any non-CC0 collection also earns one
   credit line in the README's products section.
3. **Flip the flag.** `placeholder: true → false` on that entry. The
   integrity suite keeps enforcing dimensions/frames/alpha/seams either
   way — the flag is data for humans and future tests, not a bypass.
4. **Tiles must be seamless.** A `tiling: true` slot fails
   `tests/assets-integrity.test.mjs` if the wrap edge is sharper than
   the texture's own finest interior step.
5. **Budgets still bind.** Per-game raw total ≤ `MAX_RAW_ASset_BYTES_
   PER_GAME` (1 MiB) and each shipped file ≤ `MAX_SHIPPED_HTML_BYTES`
   (1.5 MiB) — named constants in `scripts/lib/assets.mjs`, asserted by
   the integrity suite.
6. **Rebuild + re-embed.** Fishtank: `node scripts/build-fishtank.mjs`.
   Bricks: `node scripts/embed-bricks-assets.mjs`. The payload picks up
   the new bytes in stable sorted manifest order; both commands are
   also `--check`-able for CI freshness.
7. **Regression evidence to attach to the PR** (before human approval):
   - **fishtank:** browser screenshots at ALL lighting phases (Day /
     Dusk / Bioluminescent Night) — the textures overlay the procedural
     ambient, so each phase must read correctly;
   - **bricks:** gameplay states — start screen, mid-board play on
     BOTH stage aspects (classic 960×600 landscape and alleyway 480×800
     portrait — remember the vertical-only-pattern rule for arena
     backgrounds), and game over;
   - a local full-suite run (`for f in tests/*.test.mjs; do node "$f";
     done`) with the pass counts.
8. **Merge is the human step.** The loop stages and proves; the human
   approves art + license and merges.

## Multi-set asset sets (ticket #143)

Bricks ships one art set per theme (classic / neon / minimal). The manifest stays single:
every entry carries the `set` field, slot names are unique per (set, name) pair, and the
entries are pre-sorted by (set, name). File naming: the canonical set keeps the slot's
bare name (`bg.png`), the others suffix theirs (`bg-neon.png`). Provenance for a set
commits under `art/<game>-<theme>/` (spec, run record, per-candidate metadata); the raw
candidates and contact sheets stay in the shared art workspace (path referenced from the
PR notes).

## Placeholder → final swap, per slot (summary)

replace file → edit manifest entry (license + `placeholder: false`) →
rebuild → run suites → human approves art and license → commit.

No renderer changes are expected — both games draw their slots by
manifest name. If a slot's SHAPE must change (e.g. a single frame becomes
an animation sheet), that is a follow-up ticket, not a silent edit.
