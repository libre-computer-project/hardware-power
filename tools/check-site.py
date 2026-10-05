#!/usr/bin/env python3
"""Check the power site before it is published.

The published tree is static JSON. This judges that JSON, not the HTML, for
path-like strings. A regulator edge, a control net, and an unresolved net must
already be names in the layout citation. Alta and Solitude are one extraction
apart from the product and SoC label.

Usage:  tools/check-site.py [--root .]      exit 0 clean, 1 with findings
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import graph as power_graph

ID_GRAMMAR = re.compile(r"^[a-z0-9-]+$")
LINK_OK = ("libre.computer", "hardware.libre.computer", "github.com/libre-computer-project")
INDEX_KEYS = {
    "id", "model", "name", "soc", "vendor", "status", "hidden",
    "rev", "coverage", "shape",
}
STATUSES = {"production", "unreleased", "preprod", "reference"}
PUBLIC = ("aml-s905x-cc-v2", "aml-a311d-cc", "aml-s905d3-cc")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = ap.parse_args()
    root = args.root
    data = root / "data"
    bad = []

    index_path = data / "boards.json"
    if not index_path.exists():
        print(f"FAIL  {index_path} is missing", file=sys.stderr)
        return 1
    index = json.loads(index_path.read_text())
    boards = index.get("boards") or []
    pinout = index.get("pinout_only") or []
    ids = [row.get("id") for row in boards]
    if len(ids) != len(set(ids)):
        bad.append("boards.json: duplicate board id")
    pin_ids = [row.get("id") for row in pinout]
    if len(pin_ids) != len(set(pin_ids)):
        bad.append("boards.json: duplicate pinout_only id")

    expected = {"boards.json"}
    graphs = {}
    for row in boards:
        board_id = row.get("id")
        missing = INDEX_KEYS - set(row)
        if missing:
            bad.append(f"boards.json[{board_id}]: missing {sorted(missing)}")
        if not board_id or not ID_GRAMMAR.match(str(board_id)):
            bad.append(f"boards.json: illegal id {board_id!r}")
            continue
        if row.get("status") not in STATUSES:
            bad.append(f"boards.json[{board_id}]: unknown status {row.get('status')!r}")
        other = row.get("shares_layout_with")
        if other and other not in ids:
            bad.append(f"boards.json[{board_id}]: shares_layout_with names {other!r}")

        base = data / f"{board_id}.json"
        nets = data / f"{board_id}.nets.json"
        expected.add(base.name)
        expected.add(nets.name)
        if not base.exists():
            bad.append(f"{board_id}: data/{base.name} is missing")
            continue
        try:
            document = json.loads(base.read_text())
        except json.JSONDecodeError as exc:
            bad.append(f"{base.name}: does not parse -- {exc}")
            continue
        graphs[board_id] = document
        for error in power_graph.shape_errors(document):
            bad.append(f"{board_id}: {error}")
        for hit in power_graph.leak_hits(document):
            bad.append(f"{board_id}: value names a path or host -- {hit!r}")
        if not nets.exists():
            bad.append(f"{board_id}: data/{nets.name} is missing")
            continue
        try:
            citation = json.loads(nets.read_text())
        except json.JSONDecodeError as exc:
            bad.append(f"{nets.name}: does not parse -- {exc}")
            continue
        for hit in power_graph.leak_hits(citation):
            bad.append(f"{nets.name}: value names a path or host -- {hit!r}")
        names = citation.get("names") or []
        source = document.get("source") or {}
        if citation.get("id") != board_id:
            bad.append(f"{nets.name}: id is {citation.get('id')!r}")
        if source.get("nets_sha256") != power_graph.nets_sha256(names):
            bad.append(f"{board_id}: nets_sha256 does not match the citation")
        if source.get("net_count") != len(names):
            bad.append(f"{board_id}: net_count is not the citation length")
        known = set(names)
        for edge in document.get("edges") or []:
            if edge.get("net") not in known:
                bad.append(f"{board_id}: edge net {edge.get('net')!r} is not in the citation")
            for tag in edge.get("controls") or []:
                if tag.get("net") not in known:
                    bad.append(f"{board_id}: control net {tag.get('net')!r} is not in the citation")
        for item in document.get("unresolved_nets") or []:
            if item.get("net") not in known:
                bad.append(f"{board_id}: unresolved net {item.get('net')!r} is not in the citation")

    for hit in power_graph.leak_hits(index):
        bad.append(f"boards.json: value names a path or host -- {hit!r}")

    alta = graphs.get("aml-a311d-cc")
    solitude = graphs.get("aml-s905d3-cc")
    if alta and solitude:
        if alta == solitude:
            bad.append("Alta and Solitude are identical before product and SoC substitution")
        if not power_graph.graphs_equal_modulo(alta, solitude):
            bad.append("Alta and Solitude differ after product and SoC substitution")

    if not power_graph.gate_open(graphs):
        for row in boards:
            if row.get("hidden") is not True:
                bad.append(f"{row.get('id')}: listed while the regulator pin-join gate is closed")
        for board_id in PUBLIC:
            document = graphs.get(board_id)
            if document is not None and power_graph.regulator_pin_join(document):
                continue
            # Gate closed is the expected state. A listed public id would already
            # have been reported. Nothing else to add when the edge is absent.

    board_ids = set(ids)
    for row in pinout:
        board_id = row.get("id")
        reason = row.get("reason") or ""
        if not board_id or not ID_GRAMMAR.match(str(board_id)):
            bad.append(f"pinout_only: illegal id {board_id!r}")
            continue
        if board_id in board_ids:
            bad.append(f"pinout_only: {board_id} is also a graph id")
        if "pmic" in reason.lower():
            bad.append(f"pinout_only[{board_id}]: reason names a PMIC")
        if (data / f"{board_id}.json").exists() or (data / f"{board_id}.nets.json").exists():
            bad.append(f"pinout_only[{board_id}]: a graph file is published")

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

    listed = sum(1 for row in boards if not row.get("hidden"))
    if bad:
        print(f"FAIL  {len(bad)} finding(s):", file=sys.stderr)
        for item in bad:
            print("  " + item, file=sys.stderr)
        return 1
    print(
        f"OK  {len(boards)} boards ({listed} listed, {len(boards) - listed} unlisted), "
        f"every data file indexed, no path-like values"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
