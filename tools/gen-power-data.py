#!/usr/bin/env python3
"""Write schema-1 power graphs from published layout JSON.

Reads the layout index and each production ``data/<id>.json``. Writes
``data/<id>.json``, ``data/<id>.nets.json``, and, on a full run,
``data/boards.json``. A full run keeps only ``status == production`` and
deletes graph files for every other layout id. ``--board`` updates one
production board and leaves the index alone. An unreleased, preprod, or
reference id is refused.

``hidden`` is copied from the layout index. A pin name that is not a
regulator output does not become an edge. When no regulator pin joins a
rail, the page says so instead of hiding the board.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import graph  # noqa: E402

LAYOUT_DATA = Path.home() / "git/libre-computer/hardware-layout/data"
GPIO_BOARDS = Path.home() / "git/libre-computer/hardware-gpio/data/boards.json"
OUT_DATA = TOOLS.parent / "data"

PINOUT_ONLY = (
    ("all-h3-cc-h3", "Tritium H3"),
    ("all-h3-cc-h5", "Tritium H5"),
    ("roc-rk3328-cc", "Renegade"),
    ("roc-rk3328-cc-v2", "Das Renegade"),
    ("roc-rk3399-pc", "Renegade Elite"),
    ("aml-s905x-cc", "Le Potato"),
    ("aml-a311d-cc-v01", "Alta (pre-prod)"),
    ("aml-s905d3-cc-v01", "Solitude (pre-prod)"),
)
PINOUT_REASON = (
    "No layout netlist in this catalogue. The pinout electrical table is "
    "the SoC pad spec, not a board power tree."
)
DROPPED_STATUS = frozenset({"unreleased", "preprod", "reference"})


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def _dump(path: Path, obj) -> None:
    hits = graph.leak_hits(obj)
    if hits:
        raise SystemExit(f"{path.name} carries a non-public string")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1) + "\n")


def _pinout_rows() -> list[dict]:
    names = {board_id: name for board_id, name in PINOUT_ONLY}
    if GPIO_BOARDS.is_file():
        for row in _load(GPIO_BOARDS).get("boards") or []:
            if row.get("id") in names and row.get("name"):
                names[row["id"]] = row["name"]
    return [
        {"id": board_id, "name": names[board_id], "reason": PINOUT_REASON}
        for board_id, _name in PINOUT_ONLY
    ]


def _index_row(layout_row: dict, built: dict) -> dict:
    hidden = bool(layout_row.get("hidden"))
    share = layout_row.get("shares_layout_with")
    return {
        "id": layout_row["id"],
        "model": layout_row.get("model") or "",
        "name": layout_row.get("name") or "",
        "soc": layout_row.get("soc") or "",
        "vendor": layout_row.get("vendor") or "",
        "status": layout_row.get("status") or "",
        "hidden": hidden,
        "rev": layout_row.get("rev") or "",
        "coverage": built["coverage"],
        "shape": built["shape"],
        "shares_layout_with": share if share else None,
    }


def generate(src: Path, out: Path, board: str) -> int:
    index = _load(src / "boards.json")
    rows = [row for row in index.get("boards") or [] if row.get("id")]
    if board:
        rows = [row for row in rows if row["id"] == board]
        if not rows:
            raise SystemExit(f"no layout board {board}")
        status = rows[0].get("status") or ""
        if status in DROPPED_STATUS or status != "production":
            raise SystemExit(f"{board} is not a production board")
    else:
        rows = [row for row in rows if row.get("status") == "production"]
    built = {}
    for row in rows:
        path = src / f"{row['id']}.json"
        if not path.is_file():
            raise SystemExit(f"missing layout file {path.name}")
        layout = _load(path)
        document, citation = graph.build_graph(layout, graph.meta_of(row))
        errors = graph.shape_errors(document)
        if errors:
            raise SystemExit(f"{row['id']} shape: {errors[0]}")
        _dump(out / f"{row['id']}.json", document)
        _dump(out / f"{row['id']}.nets.json", citation)
        built[row["id"]] = document
        print(graph.report(document))
    if board:
        return 0
    opened = graph.gate_open(built)
    document = {
        "boards": [_index_row(row, built[row["id"]]) for row in rows],
        "pinout_only": _pinout_rows(),
    }
    _dump(out / "boards.json", document)
    keep = {"boards.json"}
    for row in rows:
        keep.add(f"{row['id']}.json")
        keep.add(f"{row['id']}.nets.json")
    for path in sorted(out.glob("*.json")):
        if path.name in keep:
            continue
        path.unlink()
        print(f"removed {path.name}")
    listed = sum(1 for row in document["boards"] if not row["hidden"])
    print(
        f"index boards={len(document['boards'])} listed={listed} "
        f"pinout_only={len(document['pinout_only'])} gate={'open' if opened else 'closed'}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate power graphs from layout JSON")
    parser.add_argument("--src", default=str(LAYOUT_DATA), help="layout data directory")
    parser.add_argument("--out", default=str(OUT_DATA), help="power data directory")
    parser.add_argument("--board", default="", help="one board id; skip boards.json")
    args = parser.parse_args()
    return generate(Path(args.src), Path(args.out), args.board)


if __name__ == "__main__":
    raise SystemExit(main())
