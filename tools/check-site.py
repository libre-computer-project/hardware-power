#!/usr/bin/env python3
"""Check the power site before it is published.

The published data is static JSON; this judges the JSON, not the HTML.

A schema-2 board file (a state model) passes a CLOSED schema: every key is
one this file names, and every string is an id, an enum value, or a name of
a stated shape (net, refdes, SoC pad or ball). Anything else -- a path, a
URL, a hex digest, a register name, free text -- fails. The private builder
checks separately that each net name is already published by the layout
site.

A schema-1 board file (no netlist) keeps its own checks: the coverage /
shape rules in graph.py, its layout citation, and the leak scan.

Usage:  tools/check-site.py [--root .] [--self-test]   exit 0 clean, 1 with findings
"""

from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import graph as power_graph

ID = re.compile(r"^[a-z0-9-]+$")
LINK_OK = ("libre.computer", "hardware.libre.computer", "github.com/libre-computer-project")
INDEX_KEYS = {"id", "model", "name", "soc", "vendor", "status", "hidden", "rev", "coverage", "shape"}
STATUSES = {"production", "unreleased", "preprod", "reference"}
DROPPED = {"unreleased", "preprod", "reference"}

# schema 2 -- the closed schema
NET = re.compile(r"^[A-Z0-9][A-Z0-9_.\-]{0,31}$")
REFDES = re.compile(r"^[0-9]{0,2}[A-Z]{1,3}[0-9]{1,4}$")
PIN = re.compile(r"^[A-Z]?[0-9]{1,3}$")
PAD = re.compile(r"^[A-Za-z][A-Za-z0-9_]{1,31}$")   # the book's own case (AVDD18_Audio_CVBS)
# shapes that are never a rail, part or pad name even when they fit the
# grammar: a register (..._REG1, ..._CNTL), a hex word, an address
FORBIDDEN = re.compile(r"(_REG\d|CNTL|^0X[0-9A-F]+$|^[0-9A-F]{16,}$)", re.I)
KINDS = {"buck", "ldo", "switch", "link", "protection"}
LINKS = {"fuse", "bead", "inductor", "jumper"}
ROLES = {"enable", "gate"}
DRIVERS = {"tie", "pad", "circuit", "pull"}
DIRS = {"up", "down", "divider"}
STATUS = {"on", "off", "x"}
TIERS = {"netlist"}
INPUTS = {"USB-C", "Micro-USB", "DC jack", "input"}
LABELS = {"Power-on", "Unplugged", "Plugged in, SoC in reset"}
TOP = {"schema", "id", "model", "name", "soc", "tier", "rails", "makers", "signals", "walks", "states",
       "transitions"}


def check_model(doc: dict, row: dict) -> list[str]:
    """Closed-schema findings for one schema-2 board file."""
    bad = []
    tag = doc.get("id", "?")

    def name(value, where, pattern=NET):
        if not isinstance(value, str) or not pattern.match(value) or FORBIDDEN.search(value):
            bad.append(f"{tag}: {where} {value!r} is not a published name")

    def keys(obj, allowed, where):
        if not isinstance(obj, dict):
            bad.append(f"{tag}: {where} is not an object")
            return False
        extra = set(obj) - allowed
        if extra:
            bad.append(f"{tag}: {where} has keys outside the schema: {sorted(extra)}")
        return True

    keys(doc, TOP, "document")
    if doc.get("schema") != 2:
        bad.append(f"{tag}: schema is not 2")
    for k in ("id", "model", "name", "soc"):
        if doc.get(k) != row.get(k):
            bad.append(f"{tag}: {k} {doc.get(k)!r} differs from boards.json {row.get(k)!r}")
    if doc.get("tier") not in TIERS:
        bad.append(f"{tag}: tier {doc.get('tier')!r}")
    rails = doc.get("rails") or []
    makers = doc.get("makers") or []
    signals = doc.get("signals") or []
    rail_ids = {r.get("id") for r in rails}
    maker_ids = {m.get("id") for m in makers}
    sig_ids = {s.get("id") for s in signals}
    for r in rails:
        if not keys(r, {"id", "name", "v", "input", "made_by", "loads"}, "rail"):
            continue
        if not ID.match(str(r.get("id"))):
            bad.append(f"{tag}: rail id {r.get('id')!r}")
        name(r.get("name"), "rail name")
        v = r.get("v")
        if v is not None and not (isinstance(v, (int, float)) and 0 < v < 50):
            bad.append(f"{tag}: rail {r.get('name')} voltage {v!r}")
        if r.get("input") is not None and r.get("input") not in INPUTS:
            bad.append(f"{tag}: rail {r.get('name')} input label {r.get('input')!r}")
        for m in r.get("made_by") or []:
            if m not in maker_ids:
                bad.append(f"{tag}: rail {r.get('name')} made by unknown {m!r}")
        loads = r.get("loads")
        if keys(loads, {"soc", "connectors", "parts"}, f"rail {r.get('name')} loads"):
            for b in loads.get("soc") or []:
                name(b, "SoC ball", PAD)
            for p in loads.get("parts") or []:
                name(p, "part", REFDES)
            for c in loads.get("connectors") or []:
                if keys(c, {"refdes", "pins", "header40"}, "connector"):
                    name(c.get("refdes"), "connector", REFDES)
                    for p in c.get("pins") or []:
                        name(p, "connector pin", PIN)
                    if not isinstance(c.get("header40"), bool):
                        bad.append(f"{tag}: connector header40 is not a boolean")
    for m in makers:
        if not keys(m, {"id", "refdes", "kind", "in", "out", "control", "link"}, "maker"):
            continue
        if m.get("kind") == "link" and m.get("link") not in LINKS:
            bad.append(f"{tag}: link kind {m.get('link')!r}")
        if not ID.match(str(m.get("id"))):
            bad.append(f"{tag}: maker id {m.get('id')!r}")
        name(m.get("refdes"), "maker refdes", REFDES)
        if m.get("kind") not in KINDS:
            bad.append(f"{tag}: maker kind {m.get('kind')!r}")
        if m.get("in") is not None and m.get("in") not in rail_ids:
            bad.append(f"{tag}: maker {m.get('id')} input {m.get('in')!r}")
        if m.get("out") not in rail_ids:
            bad.append(f"{tag}: maker {m.get('id')} output {m.get('out')!r}")
        if m.get("control") is not None and m.get("control") not in sig_ids:
            bad.append(f"{tag}: maker {m.get('id')} control {m.get('control')!r}")
    for s in signals:
        if not keys(s, {"id", "role", "driver"}, "signal"):
            continue
        if not ID.match(str(s.get("id"))):
            bad.append(f"{tag}: signal id {s.get('id')!r}")
        if s.get("role") not in ROLES:
            bad.append(f"{tag}: signal role {s.get('role')!r}")
        d = s.get("driver")
        if keys(d, {"kind", "rail", "pads", "to", "dir"}, "driver"):
            if d.get("kind") not in DRIVERS:
                bad.append(f"{tag}: driver kind {d.get('kind')!r}")
            for p in d.get("pads") or []:
                name(p, "SoC pad", PAD)
            for k in ("rail", "to"):
                if d.get(k) is not None and d.get(k) not in rail_ids:
                    bad.append(f"{tag}: driver {k} {d.get(k)!r}")
            if d.get("dir") is not None and d.get("dir") not in DIRS:
                bad.append(f"{tag}: driver dir {d.get('dir')!r}")
    state_ids = set()
    for st in doc.get("states") or []:
        if not keys(st, {"id", "label", "rails"}, "state"):
            continue
        state_ids.add(st.get("id"))
        if not ID.match(str(st.get("id"))) or st.get("label") not in LABELS:
            bad.append(f"{tag}: state {st.get('id')!r} / {st.get('label')!r}")
        rs = st.get("rails") or {}
        if set(rs) != rail_ids:
            bad.append(f"{tag}: state {st.get('id')} does not list every rail exactly once")
        for v in rs.values():
            if v not in STATUS:
                bad.append(f"{tag}: state {st.get('id')} value {v!r}")
    for w in doc.get("walks") or []:
        if not keys(w, {"id", "label", "steps"}, "walk"):
            continue
        if not ID.match(str(w.get("id"))) or w.get("label") not in LABELS:
            bad.append(f"{tag}: walk {w.get('id')!r} / {w.get('label')!r}")
        for s in w.get("steps") or []:
            if keys(s, {"stage", "label", "state"}, "step"):
                if not ID.match(str(s.get("stage"))) or s.get("label") not in LABELS:
                    bad.append(f"{tag}: step {s.get('stage')!r} / {s.get('label')!r}")
                if s.get("state") not in state_ids:
                    bad.append(f"{tag}: step {s.get('stage')} names unknown state {s.get('state')!r}")
    for t in doc.get("transitions") or []:
        if keys(t, {"walk", "from", "to", "trigger"}, "transition"):
            for k in ("walk", "from", "to", "trigger"):
                if not ID.match(str(t.get(k))):
                    bad.append(f"{tag}: transition {k} {t.get(k)!r}")
    for hit in power_graph.leak_hits(doc):
        bad.append(f"{tag}: value names a path or host -- {hit!r}")
    return bad


def check_graph(root: Path, data: Path, row: dict, expected: set) -> list[str]:
    """Schema-1 checks for a board with no state model."""
    bad = []
    board_id = row["id"]
    base = data / f"{board_id}.json"
    nets = data / f"{board_id}.nets.json"
    expected.update({base.name, nets.name})
    if not base.exists() or not nets.exists():
        return [f"{board_id}: data/{base.name} or its .nets.json is missing"]
    document = json.loads(base.read_text())
    citation = json.loads(nets.read_text())
    bad += [f"{board_id}: {e}" for e in power_graph.shape_errors(document)]
    for hit in power_graph.leak_hits(document) + power_graph.leak_hits(citation):
        bad.append(f"{board_id}: value names a path or host -- {hit!r}")
    names = citation.get("names") or []
    source = document.get("source") or {}
    if citation.get("id") != board_id:
        bad.append(f"{nets.name}: id is {citation.get('id')!r}")
    if source.get("nets_sha256") != power_graph.nets_sha256(names):
        bad.append(f"{board_id}: nets_sha256 does not match the citation")
    if source.get("net_count") != len(names):
        bad.append(f"{board_id}: net_count is not the citation length")
    return bad


def check(root: Path) -> list[str]:
    data = root / "data"
    bad = []
    index_path = data / "boards.json"
    if not index_path.exists():
        return [f"{index_path} is missing"]
    index = json.loads(index_path.read_text())
    boards = index.get("boards") or []
    pinout = index.get("pinout_only") or []
    ids = [row.get("id") for row in boards]
    if len(ids) != len(set(ids)):
        bad.append("boards.json: duplicate board id")
    expected = {"boards.json"}
    for row in boards:
        board_id = row.get("id")
        missing = INDEX_KEYS - set(row)
        if missing:
            bad.append(f"boards.json[{board_id}]: missing {sorted(missing)}")
        if not board_id or not ID.match(str(board_id)):
            bad.append(f"boards.json: illegal id {board_id!r}")
            continue
        if row.get("status") not in STATUSES or row.get("status") in DROPPED:
            bad.append(f"boards.json[{board_id}]: status {row.get('status')!r} is not production")
        if row.get("coverage") == "model":
            expected.add(f"{board_id}.json")
            path = data / f"{board_id}.json"
            if not path.exists():
                bad.append(f"{board_id}: data/{path.name} is missing")
                continue
            bad += check_model(json.loads(path.read_text()), row)
        else:
            bad += check_graph(root, data, row, expected)
    for hit in power_graph.leak_hits(index):
        bad.append(f"boards.json: value names a path or host -- {hit!r}")
    board_ids = set(ids)
    for row in pinout:
        board_id = row.get("id")
        if not board_id or not ID.match(str(board_id)):
            bad.append(f"pinout_only: illegal id {board_id!r}")
            continue
        if board_id in board_ids:
            bad.append(f"pinout_only: {board_id} is also a board id")
        if (data / f"{board_id}.json").exists():
            bad.append(f"pinout_only[{board_id}]: a board file is published")
    for path in sorted(data.glob("*.json")):
        if path.name not in expected:
            bad.append(f"data/{path.name}: not referenced by boards.json")
    for page in sorted(root.glob("*.html")):
        html = page.read_text()
        for ref in re.findall(r'(?:src|href)="([^"#?]+)"', html):
            if ref.startswith(("http://", "https://", "data:", "mailto:", "//")):
                if ref.startswith(("http://", "https://")) and not any(host in ref for host in LINK_OK):
                    bad.append(f"{page.name}: links off-site to {ref}")
                continue
            if not (root / ref).exists():
                bad.append(f"{page.name}: references missing {ref}")
    return bad


def self_test(root: Path) -> int:
    """The closed schema must pass the fixture and refuse each leak shape."""
    fx = json.loads((root / "tools/fixtures/model.json").read_text())
    row = {k: fx[k] for k in ("id", "model", "name", "soc")}
    fails = []
    if check_model(fx, row):
        fails.append(f"fixture refused: {check_model(fx, row)}")
    arms = [
        ("repo-relative path in a rail name", lambda d: d["rails"][0].__setitem__("name", "amlogic/gxl/x.pdf")),
        ("hex digest as a rail name", lambda d: d["rails"][0].__setitem__("name", "ECF2AACBF65F1BCCAF51")),
        ("register name as a rail name", lambda d: d["rails"][0].__setitem__("name", "AO_RTI_PWR_CNTL_REG1")),
        ("a part number on a maker", lambda d: d["makers"][0].__setitem__("part", "SY8120B1ABC")),
        ("a resistor value in a driver", lambda d: d["signals"][0]["driver"].__setitem__("ohms", 10000)),
        ("free text as a step label", lambda d: d["walks"][0]["steps"][0].__setitem__("label", "see 2026 audit")),
        ("a URL as an input label", lambda d: d["rails"][0].__setitem__("input", "https://x")),
        ("a state missing a rail", lambda d: d["states"][0]["rails"].pop("r-in")),
    ]
    for label, mutate in arms:
        d = copy.deepcopy(fx)
        mutate(d)
        if not check_model(d, row):
            fails.append(f"not refused: {label}")
    for f in fails:
        print(f"FAIL {f}")
    print(f"check-site self-test: {'PASS' if not fails else 'FAIL'} ({len(arms)} must-fire arms, "
          f"{len(fails)} failing)")
    return 1 if fails else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test(args.root)
    bad = check(args.root)
    if bad:
        print(f"FAIL  {len(bad)} finding(s):", file=sys.stderr)
        for item in bad:
            print("  " + item, file=sys.stderr)
        return 1
    index = json.loads((args.root / "data/boards.json").read_text())
    models = sum(1 for r in index.get("boards", []) if r.get("coverage") == "model")
    print(f"OK  {len(index.get('boards', []))} boards ({models} state models), every data file indexed, "
          f"closed schema clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
