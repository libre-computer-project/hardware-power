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

# Boards the pinout tool lists that have no power tree here. Tritium (its H3 /
# H5 pinout ids resolve to the one all-h3-cc board), Renegade, Renegade Elite
# and Le Potato are modelled from their published schematics, so they are not
# listed.
PINOUT_ONLY = (
    ("roc-rk3328-cc-v2", "Das Renegade"),
    ("aml-a311d-cc-v01", "Alta (pre-prod)"),
    ("aml-s905d3-cc-v01", "Solitude (pre-prod)"),
)
# Boards with a state model and no layout-site entry (Renegade Elite: its DXF
# carries no part designators), by id -> the drawing revision modelled. The
# other index fields come from the pinout catalogue, which must list the
# board as production.
MODEL_ONLY = {"roc-rk3399-pc": "V1.1-A"}
PINOUT_REASON = (
    "No layout netlist or published schematic modelled in this catalogue. "
    "The pinout electrical table is the SoC pad spec, not a board power tree."
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
    # The pinout tool's own `hidden` (a pre-production board): listed and
    # opened here only under ?hidden=1, as there. Without its catalogue every
    # row is hidden -- a board is not announced because a file was missing.
    hidden = {board_id: True for board_id, _name in PINOUT_ONLY}
    if GPIO_BOARDS.is_file():
        for row in _load(GPIO_BOARDS).get("boards") or []:
            if row.get("id") in names:
                hidden[row["id"]] = bool(row.get("hidden"))
                if row.get("name"):
                    names[row["id"]] = row["name"]
    return [
        {"id": board_id, "name": names[board_id], "reason": PINOUT_REASON,
         "hidden": hidden[board_id]}
        for board_id, _name in PINOUT_ONLY
    ]


def _model_only_rows(out: Path, layout_ids: set[str]) -> list[dict]:
    """Index rows for MODEL_ONLY boards, from the pinout catalogue."""
    catalogue = {row.get("id"): row for row in _load(GPIO_BOARDS).get("boards") or []} \
        if GPIO_BOARDS.is_file() else {}
    rows = []
    for board_id, rev in MODEL_ONLY.items():
        if board_id in layout_ids:
            continue
        row = catalogue.get(board_id)
        if row is None or row.get("status") != "production":
            raise SystemExit(f"{board_id}: not a production board in the pinout catalogue")
        model = out / f"{board_id}.json"
        if not model.is_file() or _load(model).get("schema") != 2:
            raise SystemExit(f"{board_id}: no state model in {out.name}/ (export it first)")
        rows.append({key: row.get(key) for key in ("id", "model", "name", "soc", "vendor", "status", "hidden")}
                    | {"rev": rev})
    return rows


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
        rows += _model_only_rows(out, {row["id"] for row in rows})
    built = {}
    modelled = set()
    for row in rows:
        # A schema-2 file is a state model written by the private builder
        # from the board's netlist. This generator does not overwrite it.
        existing = out / f"{row['id']}.json"
        if existing.is_file() and _load(existing).get("schema") == 2:
            built[row["id"]] = {"coverage": "model", "shape": "model"}
            modelled.add(row["id"])
            print(f"{row['id']}: state model kept")
            continue
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
    opened = graph.gate_open({k: v for k, v in built.items() if k not in modelled})
    document = {
        "boards": [_index_row(row, built[row["id"]]) for row in rows],
        # a board the layout index now carries is listed once, there
        "pinout_only": [r for r in _pinout_rows() if r["id"] not in {row["id"] for row in rows}],
    }
    _dump(out / "boards.json", document)
    # (lc-products.json is the shell kit's, written by its sync: not ours)
    keep = {"boards.json", "lc-products.json"}
    for row in rows:
        keep.add(f"{row['id']}.json")
        if row["id"] not in modelled:
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
