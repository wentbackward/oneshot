# One-Shot

A **dark factory**: an autonomous dev loop that turns a product owner's plain
language into working software. The owner is intentionally non-technical — they
describe outcomes ("the paddle shouldn't teleport", "add full screen"), and the
loop does the rest: tickets, implementation in isolated worktrees,
independent code review, batched regression gates, ordered squash merges,
deploy.

The whole factory runs on **open source software, open-weight models, and
commodity hardware**. There is no SaaS dependency in the build, the review,
or the deploy path.

## Products

Current output — each one a single self-contained `.html` (vanilla HTML5 +
CSS + Canvas 2D + Web Audio, procedural everything, no build step, no
dependencies — open the file and it runs):

**👉 https://oneshot.paulgresham.com/**

| # | Product | File |
|---|---------|------|
| 01 | **Brick Breaker** — a brick-breaker with three play modes, eight timed powerups, persistent hi-score, full screen, and a hold-right-mouse time warp | [`bricks.html`](bricks.html) |
| 02 | **Asteroids** — a vector asteroid shooter with splitting rocks, drone raids, waves, and a score attack | [`asteroids.html`](asteroids.html) |
| — | **Hub** — the index page linking the products | [`index.html`](index.html) |

Every product ships with hermetic test suites that boot the real code in a
`node:vm` sandbox, and every merge is gated by the full loop.

## How the factory works

The repo carries the entire apparatus — it is part of what this demonstrates:

- `.devloop.json` — the loop config: base branch, gate checks, merge policy
- `.pi/` — the role agents (implementer, code-reviewer, analyst) and their skills
- `scripts/` — gate, merge and worktree tooling
- `tests/` — 40+ suites; each boots the real product code, drives it with a
  pinned clock and pinned randomness, and asserts on behaviour
- `docs/DECISIONS.md` — the decision log: for every ticket, what was decided,
  why, and which alternatives were rejected

Cycle: **spec → tickets → N implementers in parallel worktrees → independent
review until approved → one batched gate per train → ordered squash merges →
deploy.** Nothing in the cycle requires a human to write code; the human
steers by filing feedback.

## Local development

`node` runs the suites — no toolchain to install:

```bash
for f in tests/*.test.mjs; do node "$f"; done
```

Tuning values in each product are `var` constants at the top of the file,
retunable in the browser console while running.

## Packaging for static hosts

The repo root is the deployable. `scripts/package-oneshot.sh` bundles the
deliverables into `dist/oneshot.zip` (folder `oneshot/`, byte-deterministic)
— drop it on any static host, e.g. a WordPress site, and serve
`/oneshot/index.html`.

## Deployment (Docker + Caddy, same pattern as world-cal)

`Dockerfile` is a single `caddy:latest` stage (no build step — the files ARE
the artifacts) serving the products from `/srv`. Push to `main` →
`.github/workflows/deploy.yml`: suite loop → build/push
`ghcr.io/wentbackward/oneshot:{latest,sha}` via the automatic
`GITHUB_TOKEN` → SSH to the VPS → anonymous `docker pull` (public package,
no token on the VPS) → `docker run --name oneshot --network infra_app-net`.
The VPS edge Caddy reverse-proxies `oneshot.paulgresham.com` → `oneshot:80`
(block in `infra/Caddyfile.example`; the production Caddyfile lives on the
VPS). Precondition: the repo — and with it the GHCR package — is **public**;
a private package would break both the push and the anonymous pull.
Workflow secrets: `VPS_HOST`, `VPS_SSH_KEY` — in GitHub Actions only, never
in this repo.
