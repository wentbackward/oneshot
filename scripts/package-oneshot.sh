#!/usr/bin/env bash
# package-oneshot.sh — build the drop-in demo package for hosting the
# one-shot games somewhere else (e.g. a WordPress site under /oneshot/).
#
# The .html files in the repo root ARE the deployable artifacts: each game
# (plus the index.html hub) is fully self-contained, so packaging is a
# pure copy under one folder name — no build step, no templating.
#
# Usage:  scripts/package-oneshot.sh
# Output: dist/oneshot.zip  ->  oneshot/index.html
#                                oneshot/bricks.html
#                                oneshot/asteroids.html
#
# Extract the zip on the host and the `oneshot/` folder is ready to serve;
# visitors land on oneshot/index.html (the hub) and the games are linked
# by relative paths, so the folder works at any mount depth.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT_DIR="$ROOT/dist"
OUT="$OUT_DIR/oneshot.zip"

FILES=("index.html" "bricks.html" "asteroids.html")

# Fail loudly on a missing source — a partial package is worse than none.
missing=0
for f in "${FILES[@]}"; do
  [ -f "$ROOT/$f" ] || { echo "package-oneshot: missing $f (expected in repo root)" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || exit 1

mkdir -p "$OUT_DIR"
rm -f "$OUT"

# python3 stdlib only (no `zip` binary dependency); the file timestamps
# are pinned so identical sources produce a byte-identical archive.
python3 - "$ROOT" "$OUT" "${FILES[@]}" <<'PY'
import sys, zipfile

root, out = sys.argv[1], sys.argv[2]
files = sys.argv[3:]
fixed_ts = (1980, 1, 1, 0, 0, 0)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for name in files:
        info = zipfile.ZipInfo("oneshot/" + name, date_time=fixed_ts)  # positional arg is the archive name
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16  # regular file, rw-r--r--
        with open(root + "/" + name, "rb") as fh:
            zf.writestr(info, fh.read())
PY

echo "wrote $OUT:"
python3 -c '
import sys, zipfile
for i in zipfile.ZipFile(sys.argv[1]).infolist():
    print("  %-26s %6d bytes" % (i.filename, i.file_size))
' "$OUT"
