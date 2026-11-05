# Asteroid Horizon — repo guide

Dark-factory demo repo: a collection of applications built by an autonomous
dev loop (see `README.md` for the framing) — open source software, open-weight
models, commodity hardware, non-technical product owner. Current products,
each a standalone single file (vanilla HTML5 + CSS + Canvas 2D + Web Audio, no
external assets or libraries):

- Campaign 1: the asteroid shooter in `asteroids.html` (see `ASTEROIDS.PRD.md`)
- Campaign 2: the brick-breaker in `bricks.html` (see `BRICKBREAKER.PRD.md`)
- `index.html` is the hub page (pure CSS, no JS) linking all the products;
  each product carries an inert back link to it.

## Distribution

The repo root IS the deployable: `index.html`, `bricks.html`, `asteroids.html`
are exactly the files a host needs. `scripts/package-oneshot.sh` bundles them
into `dist/oneshot.zip` (folder `oneshot/`, python3 std-lib, byte-
deterministic) for drop-in hosting — e.g. extract under a WordPress site and
serve `/oneshot/index.html`. `dist/` is gitignored. The pack's contract is
locked by `tests/oneshot-pack.test.mjs`; when a new game joins the collection,
add it to the packager's `FILES` array, the hub, the test's expected
members, AND the Dockerfile's COPY line (a gate check pins the latter).

## Deployment (Docker + Caddy, same pattern as world-cal)

`Dockerfile` is a single `caddy:latest` stage (no build step — the files ARE
the artifacts) serving the three root-level files from `/srv`. Push to `main`
→ `.github/workflows/deploy.yml`: suite loop → build/push
`ghcr.io/wentbackward/oneshot:{latest,sha}` (automatic `GITHUB_TOKEN`,
package public) → SSH to the VPS → anonymous pull →
`docker run --name oneshot --network infra_app-net`. The VPS edge Caddy
reverse-proxies `oneshot.paulgresham.com` → `oneshot:80` (block in
`infra/Caddyfile.example`; the production Caddyfile lives on the VPS).
Workflow secrets: `VPS_HOST`, `VPS_SSH_KEY` — in GitHub Actions only, never
in this repo. Precondition: repo + package public.

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
