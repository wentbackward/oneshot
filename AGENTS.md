# Asteroid Horizon — repo guide

Single-file arcade space shooter. The entire game lives in `index.html`
(vanilla HTML5 + CSS + Canvas 2D + Web Audio, no external assets or libraries).
See `PRD.md` for the product requirements.

## Engineering rules

- All CSS stays in `<style>` and all JS in `<script>` inside `index.html`.
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
- Gate checks are plain shell commands over `index.html`; if you add
  capabilities the team relies on, consider extending the checks list.
