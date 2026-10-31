# Asteroid Horizon — repo guide

Arcade game collection. Campaign 1: the asteroid shooter in
`asteroids.html` (see `ASTEROIDS.PRD.md`). Campaign 2: the brick-breaker in
`bricks.html` (see `BRICKBREAKER.PRD.md`). Each game is a standalone single
file (vanilla HTML5 + CSS + Canvas 2D + Web Audio, no external assets or
libraries).

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
