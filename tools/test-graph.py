#!/usr/bin/env python3
"""Criterion 3: graphs from published layout data follow the pin-join rule.

This file calls graph.build_graph. It does not re-implement nomination,
coverage, or the coordinate join.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import graph  # noqa: E402

LAYOUT = Path.home() / "git/libre-computer/hardware-layout/data"
DATA = TOOLS.parent / "data"

REQUIRED = (
    "aml-s905x-cc-v2",
    "aml-a311d-cc",
    "aml-s905d3-cc",
    "aml-s805x-ac",
    "med-mt88-mx",
    "med-mt83-ace",
)
PUBLISHED = (
    "aml-s905x-cc-v2",
    "aml-s805x-ac",
    "aml-a311d-cc",
    "aml-s905d3-cc",
)
DROPPED = (
    "aml-s905x-cc-v3",
    "aml-s805x-ac-v2",
    "aml-a311d-cm",
    "med-mt83-ace",
    "med-mt88-mx",
    "mtk-g500-mmd",
)

LIVIA_NETS = (
    "DRVBUS",
    "HDMI_POWER_IN",
    "VA12_PMU",
    "VAUD28_PMU",
    "VAUX18_PMU",
    "VBIF28_PMU",
    "VCN18_PMU_IT66121",
    "VCN33_PMU_IT66121",
    "VCORE",
    "VDRAM1",
    "VEMC_PMU",
    "VGPU",
    "VMC_PMU",
    "VMODEM",
    "VPA",
    "VPA_PMU",
    "VPROC11",
    "VPROC12",
    "VRF12_PMU_IT66121",
    "VRTC28",
    "VRTC28_L",
    "VS1",
    "VS1_PMU",
    "VS2",
    "VS2_PMU",
    "VUSB_PMU",
)

# Nominated on Sweet Potato by the measured part rules, and three parts that
# must stay out (reference, shunt, supervisor).
SWEET_PRESENT = (
    "1F1", "1U1", "1U2", "1U3", "1U4", "1U6", "1U7", "3U2", "6U2", "6F1", "6F2", "6FB1",
)
SWEET_ABSENT = ("1U5", "1U8", "2U2")
LIVIA_PARTS = ("U2001", "U1", "U3", "U4", "U5", "U2002")
LIVIA_BEADS = ("FB1", "FB2", "FB3", "FB4", "FB5", "FB6", "U6", "U7", "U9", "U10", "U11")


def _fail(errors: list[str], message: str) -> None:
    errors.append(message)
    print(f"FAIL {message}")


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


def _meta(board_id: str, index: dict) -> dict:
    for row in index["boards"]:
        if row["id"] == board_id:
            return graph.meta_of(row)
    raise SystemExit(f"layout index has no {board_id}")


def _edge(document: dict, src: str, net: str) -> dict | None:
    for edge in document["edges"]:
        if edge["src"] == src and edge["net"] == net:
            return edge
    return None


def _node(document: dict, node_id: str) -> dict | None:
    for node in document["nodes"]:
        if node["id"] == node_id:
            return node
    return None


def _unresolved(document: dict, refdes: str) -> dict | None:
    for row in document["unresolved"]:
        if row["refdes"] == refdes:
            return row
    return None


def _first_diff(left, right, path: str = "") -> str | None:
    if type(left) is not type(right):
        return f"{path} type {type(left).__name__} != {type(right).__name__}"
    if isinstance(left, dict):
        for key in sorted(set(left) | set(right)):
            if key not in left or key not in right:
                return f"{path}.{key} missing"
            found = _first_diff(left[key], right[key], f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(left, list):
        if len(left) != len(right):
            return f"{path} len {len(left)} != {len(right)}"
        for index, (item, other) in enumerate(zip(left, right)):
            found = _first_diff(item, other, f"{path}[{index}]")
            if found:
                return found
        return None
    if left != right:
        return f"{path} {left!r} != {right!r}"
    return None


def _check_sweet(document: dict, errors: list[str]) -> None:
    edge = _edge(document, "n-6j2", "USBHOST_A_5V")
    node = _node(document, "n-6j2")
    if edge is None or edge["role"] != "member" or edge["provenance"] != "connector-pin":
        _fail(errors, "Sweet Potato 6J2 is not a member of USBHOST_A_5V")
    elif edge["dst"] != "n-usbhost-a-5v" or edge["controls"] != []:
        _fail(errors, "Sweet Potato USBHOST_A_5V edge shape")
    else:
        print("PASS sweet-potato USBHOST_A_5V membership")
    if node is None or node["kind"] != "connector":
        _fail(errors, "Sweet Potato 6J2 is not a connector")
    elif node["kind"] == "source":
        _fail(errors, "Sweet Potato 6J2 is a source")
    else:
        print("PASS sweet-potato 6J2 connector")
    if any(item.get("refdes") == "1J1" for item in document["nodes"]):
        _fail(errors, "Sweet Potato 1J1 is a node")
    else:
        print("PASS sweet-potato 1J1 absent")
    if any(item.get("name") == "DC_5V_IN" for item in document["nodes"]):
        _fail(errors, "Sweet Potato DC_5V_IN is a node")
    elif any(item["net"] == "DC_5V_IN" for item in document["edges"]):
        _fail(errors, "Sweet Potato DC_5V_IN is an edge")
    else:
        print("PASS sweet-potato DC_5V_IN absent")
    for refdes in SWEET_PRESENT:
        row = _unresolved(document, refdes)
        if row is None or row["reason"] != graph.NO_PIN_PADS:
            _fail(errors, f"Sweet Potato {refdes} is not unresolved no pin_pads")
    for refdes in SWEET_ABSENT:
        if _unresolved(document, refdes) is not None:
            _fail(errors, f"Sweet Potato {refdes} was nominated")
    if document["unresolved_nets"] != []:
        _fail(errors, "Sweet Potato unresolved_nets is not empty")
    if document["shape"] != "discrete" or document["coverage"] != "graph":
        _fail(errors, f"Sweet Potato shape {document['shape']} coverage {document['coverage']}")
    print(
        "PASS sweet-potato unresolved "
        + " ".join(refdes for refdes in SWEET_PRESENT if _unresolved(document, refdes))
    )


def _check_livia(document: dict, errors: list[str]) -> None:
    edge = _edge(document, "n-cn1", "VAD_5V")
    node = _node(document, "n-cn1")
    if edge is None or edge["dst"] != "n-vad-5v" or edge["role"] != "member":
        _fail(errors, "Livia CN1 is not a member of VAD_5V")
    elif edge["provenance"] != "connector-pin":
        _fail(errors, "Livia VAD_5V provenance")
    else:
        print("PASS livia VAD_5V membership")
    if node is None or node["kind"] != "connector" or node.get("group") != "input":
        _fail(errors, "Livia CN1 group is not input")
    if any(item.get("net") == "VSYS" or item.get("name") == "VSYS" for item in document["edges"] + document["nodes"]):
        _fail(errors, "Livia VSYS is on the graph")
    else:
        print("PASS livia VSYS absent")
    for refdes in LIVIA_PARTS:
        row = _unresolved(document, refdes)
        if row is None or row["reason"] != graph.NO_PIN_PADS or row["value"] != "":
            _fail(errors, f"Livia {refdes} unresolved row")
    for refdes in LIVIA_BEADS:
        row = _unresolved(document, refdes)
        if row is None or row["reason"] != graph.NO_PIN_PADS:
            _fail(errors, f"Livia bead {refdes} missing")
    nets = [row["net"] for row in document["unresolved_nets"]]
    if tuple(nets) != LIVIA_NETS:
        _fail(errors, f"Livia unresolved_nets {len(nets)} != 26")
    else:
        print("PASS livia unresolved_nets 26")
    kinds = {item["kind"] for item in document["nodes"]}
    if kinds - {"connector", "rail"}:
        _fail(errors, f"Livia node kinds {sorted(kinds)}")
    if document["shape"] != "pending":
        _fail(errors, f"Livia shape {document['shape']}")
    else:
        print("PASS livia pending")
    if any(item["provenance"] == "pin-join" for item in document["edges"]):
        _fail(errors, "Livia has a pin-join edge")


def _check_empty(document: dict, layout: dict, errors: list[str], label: str) -> None:
    parts = sum(1 for _part in graph.iter_parts(layout))
    arrays = (
        document["nodes"],
        document["edges"],
        document["unresolved"],
        document["unresolved_nets"],
    )
    if any(arrays):
        _fail(errors, f"{label} graph is not empty")
    elif parts == 0:
        _fail(errors, f"{label} layout has no parts to skip")
    elif document["shape"] != "empty":
        _fail(errors, f"{label} shape {document['shape']}")
    else:
        print(f"PASS {label} empty parts-skipped={parts}")


def _check_synthetic(errors: list[str]) -> None:
    """A named output pin joins. The same footprint with only a position does not."""
    layout = {
        "nets": {"1": "VOUT_3V3", "2": "VIN_5V"},
        "pin_nets": [0.0, 0.0, 1, 1.0, 0.0, 2, 2.0, 0.0, 1],
        "components": {
            "top": [
                {
                    "r": "1U1",
                    "f": "SY81XX",
                    "c": "ic",
                    "prop": {"Value": "SY8120B1ABC", "Part_Type": "IC DC-DC"},
                    "pp": [{"pins": ["LX", "VIN"], "pos": [0.0, 0.0, 1.0, 0.0]}],
                },
                {
                    "r": "1U3",
                    "f": "SY81XX",
                    "c": "ic",
                    "prop": {"Value": "SY8120B1ABC", "Part_Type": "IC DC-DC"},
                    "pp": [{"pos": [2.0, 0.0]}],
                },
                {
                    "r": "1U9",
                    "f": "SY81XX",
                    "c": "ic",
                    "prop": {"Value": "SY8120B1ABC", "Part_Type": "IC DC-DC"},
                    "pp": [{"pins": ["5"], "pos": [0.0, 0.0]}],
                },
            ],
            "bot": [],
        },
    }
    meta = {"id": "pin-join-fixture", "model": "FIXTURE", "name": "Fixture", "soc": "TEST"}
    document, _citation = graph.build_graph(layout, meta)
    joined = _edge(document, "n-1u1", "VOUT_3V3")
    if (
        joined is None
        or joined["provenance"] != "pin-join"
        or joined["role"] != "out"
        or joined["dst"] != "n-vout-3v3"
    ):
        _fail(errors, "synthetic LX pin did not join VOUT_3V3")
    elif any(edge["net"] == "VIN_5V" for edge in document["edges"]):
        _fail(errors, "synthetic VIN pin became an edge")
    else:
        print("PASS synthetic pin-join LX to VOUT_3V3")
    if any(edge["src"] == "n-1u3" for edge in document["edges"]):
        _fail(errors, "synthetic position without a pin name became an edge")
    else:
        row = _unresolved(document, "1U3")
        if row is None or row["reason"] != graph.NO_PIN_PADS:
            _fail(errors, "synthetic 1U3 is not unresolved no pin_pads")
        else:
            print("PASS synthetic no coordinate edge")
    if any(edge["src"] == "n-1u9" for edge in document["edges"]):
        _fail(errors, "synthetic numeric pin 5 became an edge")
    else:
        row = _unresolved(document, "1U9")
        if row is None or row["reason"] != graph.NO_JOIN:
            _fail(errors, "synthetic 1U9 is not unresolved pin list did not join")
        else:
            print("PASS synthetic numeric pin does not join")
    regulator = _node(document, "n-1u1")
    if regulator is None or regulator.get("topology") != "buck":
        _fail(errors, "synthetic 1U1 topology")
    found = graph.shape_errors(document)
    if found:
        _fail(errors, f"synthetic shape {found[0]}")


def main() -> int:
    index_path = LAYOUT / "boards.json"
    if not index_path.is_file():
        print(f"FAIL missing {index_path}")
        return 1
    index = _load(index_path)
    errors: list[str] = []
    built = {}
    for board_id in REQUIRED:
        layout_path = LAYOUT / f"{board_id}.json"
        layout = _load(layout_path)
        document, citation = graph.build_graph(layout, _meta(board_id, index))
        built[board_id] = document
        print(graph.report(document))
        found = graph.shape_errors(document)
        if found:
            _fail(errors, f"{board_id} shape {found[0]}")
        if citation["id"] != board_id or citation["names"] != sorted(citation["names"]):
            _fail(errors, f"{board_id} citation")
        digest = graph.nets_sha256(citation["names"])
        if document["source"]["nets_sha256"] != digest:
            _fail(errors, f"{board_id} hash")
        if document["source"]["net_count"] != len(citation["names"]):
            _fail(errors, f"{board_id} net_count")
        written = DATA / f"{board_id}.json"
        written_nets = DATA / f"{board_id}.nets.json"
        if board_id in PUBLISHED:
            if not written.is_file() or not written_nets.is_file():
                _fail(errors, f"{board_id} generated file missing")
            else:
                diff = _first_diff(_load(written), document)
                if diff:
                    _fail(errors, f"{board_id} file differs from build_graph at {diff}")
                if _load(written_nets) != citation:
                    _fail(errors, f"{board_id} citation file differs")
        elif written.is_file() or written_nets.is_file():
            _fail(errors, f"{board_id} dropped file is still published")
        else:
            print(f"PASS {board_id} not published")
        pin_joins = [edge for edge in document["edges"] if edge["provenance"] == "pin-join"]
        if pin_joins:
            _fail(errors, f"{board_id} invented {len(pin_joins)} pin-join edges")
        else:
            print(f"PASS {board_id} no pin-join edge")
        if "shares_layout_with" in document:
            _fail(errors, f"{board_id} graph carries shares_layout_with")

    sweet = built["aml-s905x-cc-v2"]
    livia = built["med-mt83-ace"]
    la_frite = built["aml-s805x-ac"]
    virginia = built["med-mt88-mx"]
    alta = built["aml-a311d-cc"]
    solitude = built["aml-s905d3-cc"]

    _check_sweet(sweet, errors)
    _check_livia(livia, errors)
    _check_empty(la_frite, _load(LAYOUT / "aml-s805x-ac.json"), errors, "la-frite")
    if la_frite["coverage"] != "no-netlist" or la_frite["reason"] != graph.NO_NETLIST_REASON:
        _fail(errors, "La Frite coverage or reason")
    elif la_frite["source"]["net_count"] != 0:
        _fail(errors, "La Frite net_count")
    else:
        print("PASS la-frite no-netlist")
    _check_empty(virginia, _load(LAYOUT / "med-mt88-mx.json"), errors, "virginia")
    if virginia["coverage"] != "unnamed":
        _fail(errors, f"Virginia coverage {virginia['coverage']}")
    elif "$$$" not in virginia["reason"] or "net<digits>" not in virginia["reason"]:
        _fail(errors, "Virginia reason does not name the unnamed nets")
    elif "MT6365" in json.dumps(virginia) or "U200" in json.dumps(virginia):
        _fail(errors, "Virginia nominated U200")
    else:
        print("PASS virginia unnamed")

    if alta == solitude:
        _fail(errors, "Alta and Solitude are identical before substitution")
    elif not graph.graphs_equal_modulo(alta, solitude):
        blank_a = graph._blank_identity(alta)
        blank_s = graph._blank_identity(solitude)
        _fail(errors, "Alta/Solitude differ after substitution: " + str(_first_diff(blank_a, blank_s)))
    else:
        print("PASS alta solitude equal after product and soc substitution")
    alta_edge = _edge(alta, "n-1j1", "5V_IN")
    if alta_edge is None or alta_edge["role"] != "member":
        _fail(errors, "Alta 1J1 is not a member of 5V_IN")
    elif _node(alta, "n-1j1") and _node(alta, "n-1j1")["kind"] != "connector":
        _fail(errors, "Alta 1J1 is not a connector")
    else:
        print("PASS alta 5V_IN membership")

    _check_synthetic(errors)

    boards_path = DATA / "boards.json"
    if not boards_path.is_file():
        _fail(errors, "boards.json missing")
    else:
        boards = _load(boards_path)
        got = [(row.get("id"), row.get("name")) for row in boards["boards"]]
        want = [
            ("aml-s905x-cc-v2", "Sweet Potato"),
            ("aml-s805x-ac", "La Frite"),
            ("aml-a311d-cc", "Alta"),
            ("aml-s905d3-cc", "Solitude"),
        ]
        if got != want:
            _fail(errors, "picker is " + " ".join(f"{board_id}:{name}" for board_id, name in got))
        elif any(
            row.get("hidden") is not False or row.get("status") != "production"
            for row in boards["boards"]
        ):
            _fail(errors, "a listed row is hidden or not production")
        else:
            print("PASS picker lists Sweet Potato, La Frite, Alta, Solitude")
        present = [
            name for board_id in DROPPED
            if (DATA / f"{board_id}.json").is_file() or (DATA / f"{board_id}.nets.json").is_file()
        ]
        if present:
            _fail(errors, "dropped files still published: " + " ".join(present))
        elif any(row.get("status") in {"unreleased", "preprod", "reference"} for row in boards["boards"]):
            _fail(errors, "index still has a dropped status")
        else:
            print("PASS dropped boards are absent")
        pinout_ids = [row["id"] for row in boards["pinout_only"]]
        if "roc-rk3399-pc" not in pinout_ids:
            _fail(errors, "pinout_only missing Renegade Elite")
        elif any("PMIC" in row["reason"] or "pmic" in row["reason"] for row in boards["pinout_only"]):
            _fail(errors, "pinout_only calls a board a PMIC")
        else:
            print("PASS pinout_only notice")
        board_ids = {row["id"] for row in boards["boards"]}
        if board_ids & set(pinout_ids):
            _fail(errors, "pinout_only overlaps boards")
        if "mtk-g500-mmd" in board_ids:
            _fail(errors, "G500 is published")

    print(f"boards {len(REQUIRED)} failures {len(errors)}")
    if errors:
        print("FAIL")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
