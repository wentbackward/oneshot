#!/bin/bash
# Post-parse supervisor: for each book, wait for its parse job to finish,
# then run rewrite -> validate -> repair (<=3 rounds) -> merge for every
# kind. Sequential across books so the local LLM sees one workload at a
# time. Safe to re-run (all stages are resume/idempotent).
set -uo pipefail
cd "$(dirname "$0")/.."

BOOKS=(phb2024 dmg mm phb2014)
MAX_WAIT_HOURS=14

wait_for_parse() {
  local book=$1
  local total=$(python3 -c "import json;print(sum(r['end']-r['start']+1 for r in json.load(open(f'scripts/dnd-extract/page-map-$book.json'))))")
  local start_ts=$SECONDS
  while :; do
    local ok=$(python3 -c "import json,os;p='private/dnd/state/$book.pages.json';print(sum(1 for v in json.load(open(p)).values() if v=='ok') if os.path.exists(p) else 0)")
    [ "$ok" -ge "$total" ] && return 0
    local now=$SECONDS
    if [ $((now - start_ts)) -gt $((MAX_WAIT_HOURS * 3600)) ]; then
      echo "[supervise:$book] WARNING: parse incomplete ($ok/$total) after ${MAX_WAIT_HOURS}h — continuing with what exists" >&2
      return 0
    fi
    sleep 120
  done
}

for book in "${BOOKS[@]}"; do
  echo "[supervise:$book] waiting for parse completion"
  wait_for_parse "$book" || true
  echo "[supervise:$book] rewriting"
  python3 scripts/dnd_extract.py rewrite --book "$book" --workers 2 || true
  for round in 1 2 3; do
    if python3 scripts/dnd_extract.py validate --book "$book"; then
      echo "[supervise:$book] validate GREEN (round $round)"
      break
    fi
    echo "[supervise:$book] repair round $round"
    python3 scripts/dnd_extract.py repair --book "$book" || true
  done
done

echo "[supervise] merging validated data into game-data/"
for book in "${BOOKS[@]}"; do
  for kind in spell weapon armor gear magic_item monster feat background race; do
    python3 scripts/dnd_extract.py merge --book "$book" --kind "$kind" || true
  done
done
echo "[supervise] ALL DONE"
