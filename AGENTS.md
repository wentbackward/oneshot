# Asteroid Horizon — repo guide

Arcade game collection. Campaign 1: the asteroid shooter in
`asteroids.html` (see `ASTEROIDS.PRD.md`). Campaign 2: the brick-breaker in
`bricks.html` (see `BRICKBREAKER.PRD.md`). Each game is a standalone single
file (vanilla HTML5 + CSS + Canvas 2D + Web Audio, no external assets or
libraries). `index.html` is the hub page (pure CSS, no JS) linking all the
games; each game carries an inert back link to it.

## Distribution

The repo root IS the deployable: `index.html`, `bricks.html`, `asteroids.html`
are exactly the files a host needs. `scripts/package-oneshot.sh` bundles them
into `dist/oneshot.zip` (folder `oneshot/`, python3 std-lib, byte-
deterministic) for drop-in hosting — e.g. extract under a WordPress site and
serve `/oneshot/index.html`. `dist/` is gitignored. The pack's contract is
locked by `tests/oneshot-pack.test.mjs`; when a new game joins the collection,
add it to the packager's `FILES` array, the hub, and the test's expected
members.

## Engineering rules

- Each game is self-contained: all CSS stays in `<style>` and all JS in
  `<script>` inside its own `.html` file.
  No CDNs, no external images/audio — everything procedural (Canvas shapes,
  Web Audio synthesis).
- The file must remain a valid, self-contained, playable game when opened
  directly in a browser.
- Keep the code readable and structured (clear section markers, named
  constants for tuning values, no dead code).
- Changes must keep the game loop at a smooth 60 fps target: avoid allocation
  churn in hot paths, pool or reuse particles where practical.

## Dev loop conventions

- Work happens through the multipi dev loop: one ticket per branch, batched
  gates, ordered squash merges into `main` (see `.devloop.json`).
- Gate checks are plain shell commands over the current campaign's `.html`
  file; if you add
  capabilities the team relies on, consider extending the checks list.
- Browser smoke tests must be self-cleaning: close the `agent-browser`
  session (`agent-browser close`) and stop any ephemeral HTTP server before
  reporting — never leave a headless Chrome or server process running.
