"""Build a schema-1 power graph from a published layout document.

A regulator-to-rail edge exists only when a pin name joins the two ends.
Published pad lists carry positions and no pin names, so a nominated part
with no pin list is unresolved (reason ``no pin_pads``) and is not an edge.
Connector membership is the coordinate join of those positions against
``pin_nets``. A board with no nets, and a board whose every net is unnamed,
is an empty graph written before any part is nominated.
"""

from __future__ import annotations

import copy
import hashlib
import re
from collections import Counter

import classify

NO_NETLIST_REASON = "Mechanical model: placement and values, zero nets."
NO_PIN_PADS = "no pin_pads"
NO_JOIN = "pin list did not join a supply"

# Public picker stays closed until each of these has a pin-joined regulator edge.
PUBLIC_GATE = ("aml-s905x-cc-v2", "aml-a311d-cc", "aml-s905d3-cc")

PMIC_TOKENS = ("MT6358", "MT6365", "MT6319")
# Pending on this catalogue is the MT6358 footprint. MT6365 is still a PMIC
# part when coverage is graph, but Virginia never reaches nomination.
PENDING_TOKEN = "MT6358"

REG_FOOTPRINTS = frozenset({
    "SY81XX", "WL2003E", "TPS56528DDA", "MP1495_0", "MP1495_1",
})
REG_VALUE_PREFIXES = (
    "SY8120", "SY8113", "WL2803", "WL2801", "TPS56528", "MP8756", "MP1495",
)
# Exact footprints that are external regulators on the MT8385 boards, where
# Value and Part_Type are both empty. Category ic keeps a lookalike package
# on another board from being nominated.
BARE_REG_FOOTPRINTS = frozenset({"SOT23-5", "SOT23-6", "WDFN8-2X2"})

FUSE_FOOTPRINTS = frozenset({"FUSE", "PPTC_FUSE"})
BEAD_4P = re.compile(r"FB[_-]4P")
INDUCTOR_REF = re.compile(r"^L\d")
UNNAMED_NET = re.compile(r"net[0-9]+")
_SLUG_DROP = re.compile(r"[^a-z0-9-]")
_SLUG_DASH = re.compile(r"-+")

# Pin names that join a regulator to its output rail. Anything else fails closed.
OUTPUT_PINS = frozenset({"LX", "SW", "VOUT", "OUT", "PHASE", "VSW"})
# A PMIC pin on a rail is a channel unless the pin itself is input, sense, or control.
NOT_CHANNEL_PINS = frozenset({
    "EN", "ENABLE", "PWM", "PG", "PGOOD",
    "FB", "FBB", "SENSE", "SNS", "VSENSE",
    "VIN", "PVIN", "AVIN", "IN",
    "GND", "PGND", "AGND", "DGND",
})
CONTROL_ROLES = frozenset({"en", "pwm", "pg", "key", "override"})

LEAK = re.compile(
    r"""(
        [A-Za-z]:[\\/]
      | \\\\[A-Za-z0-9._-]+\\
      | (?:https?|ftp|file)://
      | [\w.+-]+@[\w-]+\.[\w.-]+
      | /(?:home|Users|mnt|srv|opt)/
    )""",
    re.VERBOSE | re.IGNORECASE,
)


def meta_of(row: dict) -> dict:
    """Identity fields the graph copies from the layout index, not from props."""
    return {
        "id": row["id"],
        "model": row.get("model") or "",
        "name": row.get("name") or "",
        "soc": row.get("soc") or "",
    }


def slug(key: str) -> str:
    text = key.lower().replace("_", "-").replace(".", "-").replace("/", "-")
    text = _SLUG_DROP.sub("", text)
    text = _SLUG_DASH.sub("-", text).strip("-")
    return text or "x"


def node_id(key: str) -> str:
    return "n-" + slug(key)


def nets_sha256(names: list[str]) -> str:
    """sha256 of the sorted names joined by newline. An empty list hashes ''."""
    payload = "\n".join(sorted(names))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def leak_hits(value) -> list[str]:
    """Strings in ``value`` that must not be published."""
    found = []

    def walk(item):
        if isinstance(item, str):
            if LEAK.search(item):
                found.append(item)
        elif isinstance(item, dict):
            for key, child in item.items():
                walk(key)
                walk(child)
        elif isinstance(item, list):
            for child in item:
                walk(child)

    walk(value)
    return found


def iter_parts(layout: dict):
    """Yield part objects from a published layout or a raw CAD document."""
    comps = layout.get("components")
    if isinstance(comps, dict):
        for side in ("top", "bot"):
            for part in comps.get(side) or []:
                if isinstance(part, dict):
                    yield part
        return
    if isinstance(comps, list):
        for part in comps:
            if isinstance(part, dict):
                yield part
        return
    layers = layout.get("layers") or {}
    if isinstance(layers, dict):
        for side in ("top", "bot"):
            block = layers.get(side) or {}
            for part in block.get("components") or []:
                if isinstance(part, dict):
                    yield part


def _refdes(part: dict) -> str:
    return str(part.get("r") or part.get("refdes") or "")


def _footprint(part: dict) -> str:
    return str(part.get("f") or part.get("footprint") or "")


def _category(part: dict) -> str:
    return str(part.get("c") or part.get("category") or "")


def _props(part: dict) -> dict:
    raw = part.get("prop")
    if not isinstance(raw, dict):
        raw = part.get("properties")
    return raw if isinstance(raw, dict) else {}


def _prop(part: dict, key: str) -> str:
    value = _props(part).get(key)
    if value is None:
        return ""
    return str(value)


def _leading_token(footprint: str) -> str:
    return footprint.split("/")[0] if footprint else ""


def _pad_groups(part: dict) -> list:
    pp = part.get("pp")
    if isinstance(pp, list):
        return pp
    if isinstance(pp, dict):
        return list(pp.get("groups") or [])
    raw = part.get("pin_pads")
    if isinstance(raw, dict):
        return list(raw.get("groups") or [])
    if isinstance(raw, list):
        return raw
    return []


def iter_pads(part: dict):
    """Yield ``(pin_name or None, x, y)`` for one part.

    Published groups store ``pos`` and no ``pins``. A raw group stores
    ``positions`` and ``pins``. A missing pin name is None, not an empty label.
    """
    for group in _pad_groups(part):
        if not isinstance(group, dict):
            continue
        pos = group.get("pos")
        if pos is None:
            pos = group.get("positions") or []
        pins = group.get("pins") or []
        for index in range(len(pos) // 2):
            pin = pins[index] if index < len(pins) else None
            if pin is not None:
                pin = str(pin)
                if pin == "":
                    pin = None
            yield pin, pos[2 * index], pos[2 * index + 1]


def has_pin_names(part: dict) -> bool:
    return any(pin for pin, _x, _y in iter_pads(part))


def nominate(part: dict) -> str | None:
    """Power-part kind from Value, footprint, and Part_Type, or None.

    Nomination does not read pad coordinates. Without a pin name the caller
    records an unresolved row and does not emit an edge.
    """
    footprint = _footprint(part)
    value = _prop(part, "Value")
    part_type = _prop(part, "Part_Type")
    token = _leading_token(footprint)
    if token in PMIC_TOKENS or any(value.startswith(item) for item in PMIC_TOKENS):
        return "pmic"
    if (
        part_type == "IC DC-DC"
        or part_type.startswith("IC DC-DC")
        or part_type == "LDO"
        or part_type.startswith("LDO")
        or footprint in REG_FOOTPRINTS
        or any(value.startswith(prefix) for prefix in REG_VALUE_PREFIXES)
    ):
        return "regulator"
    if (
        _category(part) == "ic"
        and value == ""
        and part_type == ""
        and footprint in BARE_REG_FOOTPRINTS
    ):
        return "regulator"
    if footprint in FUSE_FOOTPRINTS or value.startswith("FUSE") or "Fuse" in part_type:
        return "protection"
    refdes = _refdes(part)
    if INDUCTOR_REF.match(refdes):
        return None
    if "FB0603" in footprint or BEAD_4P.search(footprint) or footprint == "FERRITE_BEAD":
        return "protection"
    return None


def net_name_list(layout: dict) -> list[str]:
    nets = layout.get("nets") or {}
    if isinstance(nets, dict):
        return ["" if value is None else str(value) for value in nets.values()]
    if isinstance(nets, list):
        return ["" if value is None else str(value) for value in nets]
    return []


def _is_unnamed(name: str) -> bool:
    return (
        name in {"$NONE$", ""}
        or name.startswith("$$$")
        or UNNAMED_NET.fullmatch(name) is not None
    )


def coverage_of(names: list[str]) -> str:
    """Short-circuit before nomination. Zero nets is no-netlist, not unnamed."""
    if len(names) == 0:
        return "no-netlist"
    if all(_is_unnamed(name) for name in names):
        return "unnamed"
    return "graph"


def unnamed_reason(names: list[str]) -> str:
    digits = sum(1 for name in names if UNNAMED_NET.fullmatch(name))
    sentinels = [name for name in names if name.startswith("$$$")]
    if len(sentinels) == 1:
        sentinel = f"the {sentinels[0]} sentinel"
    else:
        sentinel = f"{len(sentinels)} $$$ sentinels"
    return (
        f"Unnamed nets only: {digits} net<digits> names and {sentinel}. "
        "No power tree."
    )


def _net_lookup(layout: dict):
    nets = layout.get("nets") or {}
    pin_nets = layout.get("pin_nets") or []
    at = {}
    for index in range(0, len(pin_nets) - 2, 3):
        key = (round(float(pin_nets[index]), 3), round(float(pin_nets[index + 1]), 3))
        at[key] = pin_nets[index + 2]

    def net_name(x, y) -> str:
        nid = at.get((round(float(x), 3), round(float(y), 3)))
        if nid is None or not isinstance(nets, dict):
            return ""
        value = nets.get(str(nid), nets.get(nid, ""))
        return "" if value is None else str(value)

    return net_name


def _unresolved_row(part: dict, reason: str) -> dict:
    return {
        "refdes": _refdes(part),
        "footprint": _footprint(part),
        "value": _prop(part, "Value"),
        "reason": reason,
    }


def _topology(part: dict) -> str | None:
    part_type = _prop(part, "Part_Type")
    if part_type == "LDO" or part_type.startswith("LDO"):
        return "ldo"
    if part_type == "IC DC-DC" or part_type.startswith("IC DC-DC"):
        return "buck"
    return None


def _control_tags(classified: list[tuple[str, str, dict]]) -> list[dict]:
    seen = set()
    tags = []
    for _pin, name, got in classified:
        if got["disposition"] != "control" or not got["emitted"]:
            continue
        role = got["control_role"]
        if role not in CONTROL_ROLES:
            continue
        key = (role, name)
        if key in seen:
            continue
        seen.add(key)
        tags.append({"role": role, "net": name, "source": "board-net"})
    tags.sort(key=lambda tag: (tag["role"], tag["net"]))
    return tags


def _rail_node(name: str) -> dict:
    return {
        "id": node_id(name),
        "kind": "rail",
        "name": name,
        "group": classify.group_of(name),
    }


def _add_membership(part, net_at, nodes: dict, edges: list) -> None:
    """One member edge per admitted rail on a connector. Not a source."""
    rails = []
    for pin, x, y in iter_pads(part):
        name = net_at(x, y)
        if not name:
            continue
        got = classify.classify_net(name, pin_name=pin)
        if got["disposition"] == "rail":
            rails.append(name)
    unique = sorted(set(rails))
    if not unique:
        return
    groups = {classify.group_of(name) for name in unique}
    group = next(iter(groups)) if len(groups) == 1 else "connector"
    refdes = _refdes(part)
    cid = node_id(refdes)
    nodes[cid] = {
        "id": cid,
        "kind": "connector",
        "refdes": refdes,
        "footprint": _footprint(part),
        "group": group,
    }
    seen = {(edge["src"], edge["dst"], edge["net"], edge["role"]) for edge in edges}
    for name in unique:
        rid = node_id(name)
        nodes.setdefault(rid, _rail_node(name))
        key = (cid, rid, name, "member")
        if key in seen:
            continue
        edges.append({
            "src": cid,
            "dst": rid,
            "role": "member",
            "net": name,
            "provenance": "connector-pin",
            "controls": [],
        })


def _pin_join(part, kind: str, net_at, nodes: dict, edges: list) -> bool:
    """Join output pins to rails. Return False when no pin joined a rail.

    Regulator outputs are the known switch-node pin names. A PMIC pin on a
    rail becomes a channel. A pad position without a pin name never joins.
    """
    classified = []
    for pin, x, y in iter_pads(part):
        if not pin:
            continue
        name = net_at(x, y)
        if not name:
            continue
        got = classify.classify_net(name, pin_name=pin, part_kind=kind)
        classified.append((pin, name, got))

    outputs = []
    for pin, name, got in classified:
        if got["disposition"] != "rail":
            continue
        pin_name = pin.upper()
        if kind == "regulator" and pin_name in OUTPUT_PINS:
            outputs.append(name)
        elif kind == "pmic" and pin_name not in NOT_CHANNEL_PINS:
            outputs.append(name)
    if not outputs:
        return False

    unique = sorted(set(outputs))
    refdes = _refdes(part)
    footprint = _footprint(part)
    src = node_id(refdes)
    controls = _control_tags(classified)
    if kind == "regulator":
        groups = {classify.group_of(name) for name in unique}
        node = {
            "id": src,
            "kind": "regulator",
            "refdes": refdes,
            "value": _prop(part, "Value"),
            "footprint": footprint,
            "group": next(iter(groups)) if len(groups) == 1 else "other",
        }
        topology = _topology(part)
        if topology:
            node["topology"] = topology
        nodes[src] = node
        for name in unique:
            rid = node_id(name)
            nodes.setdefault(rid, _rail_node(name))
            edges.append({
                "src": src,
                "dst": rid,
                "role": "out",
                "net": name,
                "provenance": "pin-join",
                "controls": list(controls),
            })
        return True

    nodes[src] = {
        "id": src,
        "kind": "pmic",
        "refdes": refdes,
        "value": _leading_token(footprint) or _prop(part, "Value"),
        "footprint": footprint,
        "group": "input",
    }
    for name in unique:
        cid = "n-ch-" + slug(name)
        nodes[cid] = {
            "id": cid,
            "kind": "channel",
            "pmic": src,
            "name": name,
            "group": classify.group_of(name),
        }
        edges.append({
            "src": src,
            "dst": cid,
            "role": "channel",
            "net": name,
            "provenance": "pin-join",
            "controls": list(controls),
        })
    return True


def _assign_shape(nodes: list, edges: list, unresolved: list) -> str:
    kinds = {node["kind"] for node in nodes}
    has_pmic = "pmic" in kinds
    has_reg = "regulator" in kinds
    has_channel = "channel" in kinds
    only_member = all(
        edge.get("role") == "member" and edge.get("provenance") == "connector-pin"
        for edge in edges
    )
    tokens = [_leading_token(row.get("footprint") or "") for row in unresolved]
    pending = (
        not has_pmic
        and not has_reg
        and not has_channel
        and only_member
        and PENDING_TOKEN in tokens
        and any(token != PENDING_TOKEN for token in tokens)
    )
    if pending:
        return "pending"
    if has_pmic and has_reg:
        return "hybrid"
    if has_pmic and not has_reg:
        return "pmic"
    return "discrete"


def build_graph(layout_doc: dict, meta: dict) -> tuple[dict, dict]:
    """Return ``(graph, citation)`` for one layout document.

    ``meta`` supplies ``id``, ``model``, ``name``, and ``soc``. Coverage is
    decided from the net names before any part is read.
    """
    board_id = meta["id"]
    names = net_name_list(layout_doc)
    citation = {"id": board_id, "names": sorted(names)}
    source = {
        "layout_id": board_id,
        "net_count": len(names),
        "nets_sha256": nets_sha256(names),
    }
    coverage = coverage_of(names)
    graph = {
        "schema": 1,
        "id": board_id,
        "model": meta.get("model") or "",
        "name": meta.get("name") or "",
        "soc": meta.get("soc") or "",
        "coverage": coverage,
        "shape": "empty",
        "source": source,
        "nodes": [],
        "edges": [],
        "unresolved": [],
        "unresolved_nets": [],
    }
    if coverage == "no-netlist":
        graph["reason"] = NO_NETLIST_REASON
        return graph, citation
    if coverage == "unnamed":
        graph["reason"] = unnamed_reason(names)
        return graph, citation

    net_at = _net_lookup(layout_doc)
    nodes: dict[str, dict] = {}
    edges: list[dict] = []
    unresolved = []
    for part in iter_parts(layout_doc):
        if not _refdes(part):
            continue
        if _category(part) == "connector":
            _add_membership(part, net_at, nodes, edges)
        kind = nominate(part)
        if kind is None:
            continue
        if not has_pin_names(part):
            unresolved.append(_unresolved_row(part, NO_PIN_PADS))
            continue
        if not _pin_join(part, kind, net_at, nodes, edges):
            unresolved.append(_unresolved_row(part, NO_JOIN))

    unresolved_nets = []
    for name in sorted(set(names)):
        if not name:
            continue
        got = classify.classify_net(name)
        if got["disposition"] == "unresolved_net":
            unresolved_nets.append({"net": name, "reason": classify.UNRESOLVED_REASON})

    graph["nodes"] = sorted(nodes.values(), key=lambda node: (node["kind"], node["id"]))
    graph["edges"] = sorted(
        edges, key=lambda edge: (edge["src"], edge["dst"], edge["net"], edge["role"])
    )
    graph["unresolved"] = sorted(unresolved, key=lambda row: row["refdes"])
    graph["unresolved_nets"] = unresolved_nets
    graph["shape"] = _assign_shape(graph["nodes"], graph["edges"], graph["unresolved"])
    return graph, citation


def shape_errors(graph: dict) -> list[str]:
    """Checker rows that relate coverage and shape to the nodes and edges."""
    errors = []
    if graph.get("schema") != 1:
        errors.append("schema is not 1")
    coverage = graph.get("coverage")
    shape = graph.get("shape")
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    unresolved = graph.get("unresolved") or []
    unresolved_nets = graph.get("unresolved_nets") or []
    kinds = {node.get("kind") for node in nodes}
    by_id = {node["id"]: node for node in nodes if "id" in node}
    has_pmic = "pmic" in kinds
    has_reg = "regulator" in kinds
    has_channel = "channel" in kinds

    if "control" in kinds:
        errors.append("control is a tag, not a node")
    if shape == "pmic" and has_reg:
        errors.append("pmic shape has a regulator node")
    if shape == "discrete" and has_pmic:
        errors.append("discrete shape has a pmic node")
    if shape == "hybrid" and not (has_pmic and has_reg):
        errors.append("hybrid shape needs a pmic node and a regulator node")
    if shape == "empty" and (nodes or edges or unresolved or unresolved_nets):
        errors.append("empty shape is not empty")
    if coverage in {"unnamed", "no-netlist"}:
        if nodes or edges or unresolved or unresolved_nets:
            errors.append(f"{coverage} must be empty arrays")
        if shape != "empty":
            errors.append(f"{coverage} shape is {shape}")
    if shape == "pending":
        if coverage != "graph":
            errors.append("pending coverage is not graph")
        if has_pmic or has_reg or has_channel:
            errors.append("pending has a pmic, regulator, or channel node")
        for edge in edges:
            if edge.get("role") != "member" or edge.get("provenance") != "connector-pin":
                errors.append("pending edge is not connector membership")
                break
        tokens = [_leading_token(row.get("footprint") or "") for row in unresolved]
        if PENDING_TOKEN not in tokens:
            errors.append("pending has no MT6358 footprint")
        if not any(token != PENDING_TOKEN for token in tokens):
            errors.append("pending has no other part")

    for node in nodes:
        if node.get("kind") in {"rail", "channel"}:
            got = classify.classify_net(node.get("name") or "")
            if got["disposition"] != "rail":
                errors.append(f"{node.get('id')} name is {got['disposition']}")
        if node.get("kind") == "channel":
            if "refdes" in node or not node.get("pmic"):
                errors.append(f"{node.get('id')} channel identity")
        if node.get("kind") in {"regulator", "pmic", "connector"} and not node.get("refdes"):
            errors.append(f"{node.get('id')} has no refdes")

    for edge in edges:
        got = classify.classify_net(edge.get("net") or "")
        if got["disposition"] != "rail":
            errors.append(f"edge {edge.get('net')} is {got['disposition']}")
        src = by_id.get(edge.get("src"), {})
        dst = by_id.get(edge.get("dst"), {})
        if edge.get("role") == "member":
            if src.get("kind") != "connector" or dst.get("kind") != "rail":
                errors.append(f"member endpoints {edge.get('net')}")
            if edge.get("provenance") != "connector-pin":
                errors.append(f"member provenance {edge.get('net')}")
        if edge.get("provenance") == "pin-join" and src.get("kind") not in {
            "regulator", "pmic", "protection", "switch",
        }:
            errors.append(f"pin-join source {edge.get('src')}")
        if edge.get("role") == "channel" and edge.get("net") != dst.get("name"):
            errors.append("channel name differs from its edge")
        for tag in edge.get("controls") or []:
            if tag.get("source") != "board-net":
                errors.append(f"control source {tag}")
    return errors


def regulator_pin_join(graph: dict) -> bool:
    """True when a regulator node is the source of a pin-join edge."""
    by_id = {node["id"]: node for node in graph.get("nodes") or []}
    for edge in graph.get("edges") or []:
        if edge.get("provenance") != "pin-join":
            continue
        if by_id.get(edge.get("src"), {}).get("kind") == "regulator":
            return True
    return False


def gate_open(graphs: dict) -> bool:
    """True only when every public board has a pin-joined regulator edge."""
    for board_id in PUBLIC_GATE:
        graph = graphs.get(board_id)
        if graph is None or not regulator_pin_join(graph):
            return False
    return True


def graphs_equal_modulo(left: dict, right: dict) -> bool:
    """Deep equality after id, model, name, soc, and source.layout_id.

    ``shares_layout_with`` is an index field. It is not on the graph, so a
    substitution of that key is not part of this compare.
    """
    return _blank_identity(left) == _blank_identity(right)


def _blank_identity(graph: dict) -> dict:
    out = copy.deepcopy(graph)
    for key in ("id", "model", "name", "soc"):
        out[key] = ""
    source = out.get("source")
    if isinstance(source, dict):
        source["layout_id"] = ""
    return out


def report(graph: dict) -> str:
    """One local line: coverage, shape, node counts, where the edges came from."""
    kinds = Counter(node["kind"] for node in graph["nodes"])
    provenance = Counter(edge["provenance"] for edge in graph["edges"])
    kind_text = ",".join(f"{key}:{kinds[key]}" for key in sorted(kinds)) or "none"
    if not graph["edges"]:
        how = "none"
    elif set(provenance) == {"connector-pin"}:
        how = "connectors-only"
    elif set(provenance) == {"pin-join"}:
        how = "pin-join"
    else:
        how = ",".join(f"{key}:{provenance[key]}" for key in sorted(provenance))
    return (
        f"{graph['id']} coverage={graph['coverage']} shape={graph['shape']} "
        f"nodes={kind_text} unresolved={len(graph['unresolved'])} "
        f"unresolved_nets={len(graph['unresolved_nets'])} edges={how}"
    )
