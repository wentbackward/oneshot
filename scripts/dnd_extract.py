#!/usr/bin/env python3
"""D&D 2024 source-book extraction pipeline.

Stages (all resumable, std-lib only):

  render    PDF -> 150 dpi PNG pages (pdftoppm)          private/dnd/pages/<book>/
  parse     page image -> verbatim transcript (worker LLM) private/dnd/verbatim/<book>.jsonl
  rewrite   verbatim entry -> original-wording game data   private/dnd/rewritten/<book>-<kind>.jsonl
  validate  schema + MECHANICAL-FIDELITY (number audit) vs verbatim
  merge     validated rewrites -> committed game data       game-data/<kind>.json

The verbatim transcripts are the operator's PRIVATE working copy of the
Internet-Archive source books (gitignored under private/).  Everything that
reaches the repo (game-data/) must come from the rewrite stage: the original
wording is never committed.  Mechanical fidelity is enforced mechanically:
the numeric multiset (dice, HP, AC, damage, costs...) of a rewritten entry
must equal the numeric multiset of its verbatim source.

LLM endpoint: same configuration pi uses for its 'worker' model
(override with DND_LLM_BASE_URL / DND_LLM_API_KEY / DND_LLM_WORKER).
"""

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = ROOT / "private" / "dnd"
GAME_DATA = ROOT / "game-data"

LLM_BASE_URL = os.environ.get("DND_LLM_BASE_URL", "http://limone.royal-armadillo.ts.net:4000/v1")
LLM_API_KEY = os.environ.get("DND_LLM_API_KEY", "boogie")
WORKER_MODEL = os.environ.get("DND_LLM_WORKER", "worker")
DPI = 150
MAX_RETRIES = 5
TIMEOUT_S = 300

BOOKS = {
    "phb2024": {
        "pdf": "docs/PlayersHandbook2024.pdf",
        "label": "Player's Handbook (2024)",
        "kinds": ["spell", "weapon", "armor", "gear", "feat", "background", "race", "class"],
    },
    "phb2014": {
        "pdf": "docs/Player's Handbook.pdf",
        "label": "Player's Handbook (2014)",
        "kinds": ["spell", "weapon", "armor", "gear", "feat", "background", "race", "class"],
    },
    "dmg": {
        "pdf": "docs/Dungeon Master's Guide.pdf",
        "label": "Dungeon Master's Guide (2014)",
        "kinds": ["magic_item", "monster", "world_rule", "adventure_rule"],
    },
    "mm": {
        "pdf": "docs/Monster Manual.pdf",
        "label": "Monster Manual (2014)",
        "kinds": ["monster", "magic_item", "world_rule"],
    },
}

# ---------------------------------------------------------------------------
# LLM client (OpenAI-compatible chat completions, vision via data-URL image)
# ---------------------------------------------------------------------------

def llm_chat(prompt: str, image_png: Path | None = None, max_tokens: int = 16000,
             temperature: float = 0.0) -> str:
    content = [{"type": "text", "text": prompt}]
    if image_png is not None:
        b64 = base64.b64encode(image_png.read_bytes()).decode()
        content.append({"type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{b64}"}})
    body = {
        "model": WORKER_MODEL,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": [{"role": "user", "content": content}],
    }
    req = urllib.request.Request(
        f"{LLM_BASE_URL}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {LLM_API_KEY}",
                 "Content-Type": "application/json"},
    )
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                out = json.load(resp)["choices"][0]["message"]["content"]
            return out.strip()
        except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
            last_err = e
            sleep = min(2 ** attempt * 5, 60)
            print(f"    llm retry {attempt + 1}/{MAX_RETRIES} after {sleep}s ({e})",
                  file=sys.stderr)
            time.sleep(sleep)
    raise RuntimeError(f"LLM call failed after {MAX_RETRIES} attempts: {last_err}")


def parse_json_block(text: str) -> dict:
    """Extract the first JSON object from a model reply (tolerates fences)."""
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in reply: {text[:120]!r}")
    return json.loads(text[start:end + 1])

# ---------------------------------------------------------------------------
# State / io helpers
# ---------------------------------------------------------------------------

_print_lock = threading.Lock()

def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)

def state_path(book: str) -> Path:
    return PRIVATE / "state" / f"{book}.pages.json"

def load_state(book: str) -> dict:
    p = state_path(book)
    return json.loads(p.read_text()) if p.exists() else {}

def save_state(book: str, state: dict) -> None:
    p = state_path(book)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=1))

def append_jsonl(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as f:
        f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        f.flush()
        os.fsync(f.fileno())

def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text().splitlines():
        if line.strip():
            out.append(json.loads(line))
    return out

def page_map(book: str) -> list[dict]:
    """Page ranges with a section hint, from the (hand-authored) TOC map.

    Map file: scripts/dnd-extract/page-map-<book>.json
      [{"start": 47, "end": 174, "section": "Ch3 Classes"}, ...]
    Page numbers are 1-based PDF FILE numbers (verified per book: for
    phb2024, file n = printed page n+1; others verified during TOC mapping).
    """
    p = ROOT / "scripts" / "dnd-extract" / f"page-map-{book}.json"
    return json.loads(p.read_text())

def section_for(book: str, page: int) -> str:
    for rng in page_map(book):
        if rng["start"] <= page <= rng["end"]:
            return rng.get("section", "")
    return ""

# ---------------------------------------------------------------------------
# Stage: render
# ---------------------------------------------------------------------------

def cmd_render(args) -> None:
    book = BOOKS[args.book]
    pdf = ROOT / book["pdf"]
    outdir = PRIVATE / "pages" / args.book
    outdir.mkdir(parents=True, exist_ok=True)
    if not shutil.which("pdftoppm"):
        sys.exit("pdftoppm not found (poppler-utils)")
    n = int(subprocess.check_output(["pdfinfo", str(pdf)])
            .decode().split("Pages:")[1].split()[0])
    have = {p.name for p in outdir.glob("p-*.png")}
    log(f"[render:{args.book}] {n} pages -> {outdir} ({len(have)} already present)")
    # pdftoppm cannot resume per-page; render missing ranges in one pass each.
    missing = [i for i in range(1, n + 1) if f"p-{i:03d}.png" not in have]
    if not missing:
        log("[render] nothing to do")
        return
    runs = []
    for i in range(len(missing)):
        if i == 0 or missing[i] != missing[i - 1] + 1:
            runs.append([missing[i]])
        else:
            runs[-1].append(missing[i])
    for run in runs:
        lo, hi = run[0], run[-1]
        subprocess.check_call(
            ["pdftoppm", "-png", "-r", str(DPI), "-f", str(lo), "-l", str(hi),
             str(pdf), str(outdir / "p")])
        log(f"[render:{args.book}] pages {lo}-{hi}")

# ---------------------------------------------------------------------------
# Stage: parse (verbatim transcript)
# ---------------------------------------------------------------------------

PARSE_PROMPT = """You are transcribing a scanned page from {label}.
Expected section: {section}

Task 1 (PRIVATE verbatim copy): reproduce the PRINTED TEXT of this page as
exactly as you can read it — every word, number, punctuation mark — inside
JSON fields. Do not correct, summarize, translate, or modernize. Preserve
obvious scan quirks. Group the text into ENTRIES where the page contains
discrete named objects; otherwise put the whole prose in ONE entry named
"(prose)".

Task 2 (classification): for each entry set "kind" to exactly one of:
{kind_list}
("none" if it is pure navigation/blank art.)

Reply with ONLY a JSON object:
{{
  "page_text_verbatim": "<full page text, printed order>",
  "entries": [
    {{"name": "<entry name or (prose)>",
      "kind": "<kind>",
      "fields": {{ "<short key>": "<printed value>" }},   // e.g. level, CR, cost, AC, hp, damage; only what is printed
      "entry_verbatim": "<exact printed text of this entry>"}}
  ]
}}

Rules:
- "entry_verbatim" values must be exact transcriptions, not paraphrases.
- Keep numbers exactly as printed (dice like 1d6, ranges like 20/60).
- No markdown fences, no commentary."""

def parse_one(book: str, page: int) -> dict | None:
    img = PRIVATE / "pages" / book / f"p-{page:03d}.png"
    if not img.exists():
        raise FileNotFoundError(img)
    prompt = PARSE_PROMPT.format(
        label=BOOKS[book]["label"],
        section=section_for(book, page) or "(unknown — infer from the page)",
        kind_list=", ".join(BOOKS[book]["kinds"]) + ", none",
    )
    out = llm_chat(prompt, img)
    data = parse_json_block(out)
    data["_book"], data["_page"] = book, page
    return data

def cmd_parse(args) -> None:
    book = args.book
    if not (PRIVATE / "pages" / book).exists():
        sys.exit(f"pages missing — run: {sys.argv[0]} render --book {book}")
    try:
        ranges = page_map(book)
    except FileNotFoundError:
        sys.exit(f"page map missing: scripts/dnd-extract/page-map-{book}.json")
    todo = [p for r in ranges for p in range(r["start"], r["end"] + 1)]
    if args.pages:
        todo = [int(x) for x in args.pages.split(",")]
    state = load_state(book)
    todo = [p for p in todo if state.get(str(p)) != "ok"]
    log(f"[parse:{book}] {len(todo)} pages to process (concurrency {args.workers})")
    out = PRIVATE / "verbatim" / f"{book}.jsonl"

    def work(page: int) -> None:
        try:
            data = parse_one(book, page)
        except Exception as e:  # noqa: BLE001 — record and move on
            log(f"[parse:{book}] page {page} FAILED: {e}")
            return
        append_jsonl(out, data)
        with _print_lock:
            state[str(page)] = "ok"
        save_state(book, state)
        log(f"[parse:{book}] page {page}: {len(data.get('entries', []))} entries")

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(work, todo))
    done = sum(1 for v in state.values() if v == "ok")
    log(f"[parse:{book}] state: {done} ok pages recorded")

# ---------------------------------------------------------------------------
# Stage: rewrite (original wording, same mechanics)
# ---------------------------------------------------------------------------

REWRITE_PROMPT = """You are converting ONE game entry from a tabletop RPG source
into data for a browser roguelite called The Endless Descent.

STRICT RULES:
1. Keep EVERY mechanical fact identical: all numbers, dice, ranges, durations,
   costs, save types, conditions, and trigger timing must carry over exactly.
   Represent every dice expression as its EXACT source string ("1d6",
   "2d6", "7d8") — never decompose a dice value into separate count/size
   numbers. Keep upgrade/scale tables complete (every threshold WITH its
   value). Where a mechanic has no browser analogue, keep its numbers in
   "data" and add "adaptation_note" explaining how the game expresses it.
2. "data" is PURE STRUCTURE: numbers, dice strings, short enums, arrays,
   objects. No prose field of any kind exists in "data" — if you find
   yourself writing a sentence, stop and split it into fields, or move the
   explanation to "adaptation_note". Multiple-choice effects are arrays of
   option objects, each carrying its full values. Scale/upgrade tables are
   arrays of objects: [{{"level_threshold": 5, "value": "2d6"}}] — never
   digit-bearing keys.
3. INVENT NOTHING. Every digit in your output must be traceable to the
   source text. If you cannot represent a source fact structurally, put it
   in "adaptation_note" as a digit-bearing phrase.
4. Write ALL descriptive text in ORIGINAL WORDING. Do not reuse the source
   sentences. Terse game-data voice, no atmosphere prose.
5. Names, item types, schools, and proper nouns are retained as identifiers.
6. Preserve number STYLE: keep digits as digits and number-words as
   number-words exactly as in the source ("three" stays "three" in prose
   contexts; dice always stay "NdM"). Never convert between the two.
7. Key hygiene: snake_case keys, NEVER digits inside key names.
8. "flavor_rewritten" contains NO numbers, number-words, dice, or
   measurements of any kind.

Entry to convert (verbatim source, for your reference ONLY — never copy
its sentences):
{source_json}

Reply with ONLY a JSON object:
{{
  "id": "<slugified-name>",
  "name": "<name>",
  "kind": "<same kind>",
  "source_book": "{book}",
  "data": {{ ...structured facts only... }},
  "flavor_rewritten": "<one or two original sentences, game voice, NO numbers or number-words>",
  "adaptation_note": "<original words, digits OK, number-words NOT OK; empty if none>"
}}
No markdown fences, no commentary."""

def rewrite_entry(book: str, entry: dict, idx: int, page: int) -> dict:
    src = {"name": entry.get("name"), "kind": entry.get("kind"),
           "fields": entry.get("fields", {}),
           "source_text": entry.get("entry_verbatim", "")}
    out = llm_chat(REWRITE_PROMPT.format(source_json=json.dumps(src, indent=1),
                                         book=book))
    data = parse_json_block(out)
    data["_source_page"] = page
    data["_source_idx"] = idx
    return data

def cmd_rewrite(args) -> None:
    book = args.book
    vpath = PRIVATE / "verbatim" / f"{book}.jsonl"
    pages = [int(x) for x in args.pages.split(",")] if args.pages else None
    rows = load_jsonl(vpath)
    if pages:
        rows = [r for r in rows if r.get("_page") in pages]
    todo = [(r, i) for r in rows for i, e in enumerate(r.get("entries", []))
            if e.get("kind") in BOOKS[book]["kinds"]]
    out = PRIVATE / "rewritten" / f"{book}-all.jsonl"
    lock = threading.Lock()
    done_ids = {(d.get("id"), d.get("_source_page"), d.get("_source_idx"))
                for d in load_jsonl(out)}
    log(f"[rewrite:{book}] {len(todo)} candidate entries "
        f"({len(done_ids)} already done), {args.workers} worker(s)")

    def work(pair):
        r, i = pair
        data = rewrite_entry(book, r["entries"][i], i, r.get("_page"))
        key = (data.get("id"), r.get("_page"), i)
        with lock:
            if key in done_ids:
                return
            done_ids.add(key)
            append_jsonl(out, data)
            log(f"[rewrite:{book}] {data.get('id')} (page {r.get('_page')})")

    if args.workers <= 1:
        for pair in todo:
            try:
                work(pair)
            except Exception as ex:  # noqa: BLE001
                log(f"[rewrite:{book}] page {pair[0].get('_page')} "
                    f"entry {pair[1]} FAILED: {ex}")
    else:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(work, pair) for pair in todo]
            for fut in as_completed(futures):
                try:
                    fut.result()
                except Exception as ex:  # noqa: BLE001
                    log(f"[rewrite:{book}] entry FAILED: {ex}")

# ---------------------------------------------------------------------------
# Stage: validate (schema + mechanical fidelity: number audit)
# ---------------------------------------------------------------------------

NUM_RE = re.compile(r"\b\d+\s*d\s*\d+\b|\b\d{1,3}(?:\.\d+)?\b")

def normalize_numbers(text: str) -> str:
    t = text.lower().replace(",", "")
    t = re.sub(r"(\d)\s+\b(d\s*\d+)", r"\1d\2", t)  # "1 d6" -> "1d6"
    t = re.sub(r"\b(d\s*\d+)\b", lambda m: m.group(1).replace(" ", ""), t)
    return t

def number_multiset(text: str) -> Counter:
    return Counter(NUM_RE.findall(normalize_numbers(text)))

def cmd_validate(args) -> None:
    book = args.book
    verbatim = {}
    for r in load_jsonl(PRIVATE / "verbatim" / f"{book}.jsonl"):
        for i, e in enumerate(r.get("entries", [])):
            verbatim[(r.get("_page"), i)] = e
    problems, checked = [], 0
    for d in load_jsonl(PRIVATE / "rewritten" / f"{book}-all.jsonl"):
        src = verbatim.get((d.get("_source_page"), d.get("_source_idx")))
        if src is None:
            problems.append(f"{d.get('id')}: missing verbatim source")
            continue
        checked += 1
        audit_blob = {k: d.get(k) for k in ("data", "adaptation_note")}
        audit_blob.pop("effect_description", None)  # legacy free-prose field
        new_text = json.dumps(audit_blob)
        old_c, new_c = (number_multiset(src.get("entry_verbatim", "")),
                        number_multiset(new_text))
        missing, extra = old_c - new_c, new_c - old_c
        if missing:
            problems.append(f"{d.get('id')}: MISSING {dict(missing)}")
        if extra:
            problems.append(f"{d.get('id')}: EXTRA(info) {dict(extra)}")
        if src.get("name") and d.get("name") != src["name"]:
            problems.append(f"{d.get('id')}: NAME-MISMATCH "
                            f"{src['name']!r} -> {d.get('name')!r}")
    expected = sum(1 for r in load_jsonl(PRIVATE / "verbatim" / f"{book}.jsonl")
                   for e in r.get("entries", [])
                   if e.get("kind") in BOOKS[book]["kinds"])
    if checked == 0 and expected > 0:
        log(f"[validate:{book}] FAIL: 0 rewritten entries on disk "
            f"(~{expected} expected) - rewrite never ran or crashed")
        sys.exit(1)
    if 0 < checked < expected:
        log(f"[validate:{book}] NOTE: {checked}/{expected} entries rewritten "
            "(partial - re-running rewrite will fill the gap)")
    hard = [p for p in problems if "EXTRA(info)" not in p]
    log(f"[validate:{book}] {checked} entries, {len(hard)} failing, "
        f"{len(problems) - len(hard)} info-only")
    for p in problems[:60]:
        log("  " + p)
    vdir = PRIVATE / "validation"
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / f"{book}-problems.txt").write_text("\n".join(problems) + "\n")
    sys.exit(1 if hard else 0)



def cmd_merge(args) -> None:
    book = args.book
    flagged = {p.partition(":")[0].strip()
               for p in (PRIVATE / "validation" / f"{book}-problems.txt").read_text()
               .splitlines()
               if p.strip() and "EXTRA(info)" not in p}
    rows = load_jsonl(PRIVATE / "rewritten" / f"{book}-all.jsonl")
    GAME_DATA.mkdir(exist_ok=True)
    dest = GAME_DATA / f"{args.kind}.json"
    merged = load_jsonl(dest.with_suffix(".jsonl")) if dest.with_suffix('.jsonl').exists() else []
    existing = {m.get("id") for m in merged}
    added, skipped = 0, 0
    for d in rows:
        if d.get("kind") != args.kind or d.get("id") in existing:
            continue
        if d.get("id") in flagged:
            skipped += 1
            continue
        clean = {k: v for k, v in d.items() if not k.startswith("_")}
        merged.append(clean)
        existing.add(d.get("id"))
        added += 1
    merged.sort(key=lambda m: (m.get("name") or "").lower())
    if not merged and not dest.exists():
        log(f"[merge] {dest.relative_to(ROOT)}: nothing to write (no validated entries yet)")
        return
    dest.write_text(json.dumps(merged, indent=1, ensure_ascii=False) + "\n")
    log(f"[merge] {dest.relative_to(ROOT)}: +{added} ({len(merged)} total, "
        f"{skipped} skipped due to validation problems)")

def cmd_repair(args) -> None:
    book = args.book
    pf = PRIVATE / "validation" / f"{book}-problems.txt"
    if not pf.exists():
        sys.exit("run validate first")
    failing = {}
    for line in pf.read_text().splitlines():
        if "EXTRA(info)" in line or not line.strip():
            continue
        iid, _, detail = line.partition(":")
        failing.setdefault(iid.strip(), []).append(detail.strip())
    verbatim = {}
    for r in load_jsonl(PRIVATE / "verbatim" / f"{book}.jsonl"):
        for i, e in enumerate(r.get("entries", [])):
            verbatim[(r.get("_page"), i)] = e
    rows = load_jsonl(PRIVATE / "rewritten" / f"{book}-all.jsonl")
    new_rows, fixed = [], 0
    for d in rows:
        if d.get("id") not in failing:
            new_rows.append(d)
            continue
        src_entry = verbatim.get((d.get("_source_page"), d.get("_source_idx")))
        if src_entry is None:
            new_rows.append(d)
            continue
        prompt = (REWRITE_PROMPT.format(
            source_json=json.dumps({"name": src_entry.get("name"),
                                    "kind": src_entry.get("kind"),
                                    "fields": src_entry.get("fields", {}),
                                    "source_text": src_entry.get("entry_verbatim", "")},
                                   indent=1), book=book)
            + "\n\nA PREVIOUS ATTEMPT was rejected by the number audit for: "
            + "; ".join(failing[d["id"]])
            + "\nFix exactly those gaps. Do not introduce ANY number that is "
              "not present in the source text.")
        try:
            data = parse_json_block(llm_chat(prompt))
            data["_source_page"], data["_source_idx"] = (
                d.get("_source_page"), d.get("_source_idx"))
            new_rows.append(data)
            fixed += 1
            log(f"[repair:{book}] {d.get('id')} re-rewritten")
        except Exception as ex:  # noqa: BLE001
            log(f"[repair:{book}] {d.get('id')} FAILED (kept old): {ex}")
            new_rows.append(d)
    p = PRIVATE / "rewritten" / f"{book}-all.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in new_rows) + "\n")
    log(f"[repair:{book}] {fixed}/{len(failing)} repaired; re-run validate")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("render")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.set_defaults(fn=cmd_render)

    p = sub.add_parser("parse")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.add_argument("--workers", type=int, default=3)
    p.add_argument("--pages", help="comma list of page overrides")
    p.set_defaults(fn=cmd_parse)

    p = sub.add_parser("rewrite")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.add_argument("--workers", type=int, default=1)
    p.add_argument("--pages", help="restrict to verbatim pages")
    p.set_defaults(fn=cmd_rewrite)

    p = sub.add_parser("validate")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("repair")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.set_defaults(fn=cmd_repair)

    p = sub.add_parser("merge")
    p.add_argument("--book", required=True, choices=sorted(BOOKS))
    p.add_argument("--kind", required=True,
                   choices=["spell", "weapon", "armor", "gear", "magic_item",
                            "monster", "feat", "background", "race", "class"])
    p.set_defaults(fn=cmd_merge)

    args = ap.parse_args()
    args.fn(args)

if __name__ == "__main__":
    main()
