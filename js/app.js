"use strict";

/* Power tree. Classification already happened in tools/classify.py and is
 * stored on the graph. This file paints that result: what starts open, the
 * badge on a collapsed branch, and the rail table. It does not admit nets.
 *
 * defaultOpen reads hasPmic (any node of kind pmic). It does not read shape.
 * First-paint cap is 48 visible nodes for a discrete board. A PMIC frame
 * targets 24. A click may open more; the rail table always lists every rail.
 */

import { mountShell } from "./lc-kit.js";

/** First paint only. Discrete boards target this. A click may open more. */
export const VISIBLE_CAP = 48;
/** PMIC frame target. The external-regulator step is a no-op when that set is empty. */
export const PMIC_CAP = 24;

export const RAIL_COLUMNS = ["Rail", "Group", "From", "EN", "PWM", "PG", "Series parts", "Loads"];

export const DEFAULT_BOARD = "aml-a311d-cc";

export const FILE_NOTICE =
  "Could not load the board index. If you are opening this from a file:// path, " +
  "serve the directory over HTTP instead — python3 -m http.server.";

export const NO_ENABLE_DETAIL =
  "No enable net on this board. If the PMIC sequences this channel, the netlist does not say so.";

const ID_GRAMMAR = /^[a-z0-9-]+$/;
const FLOW = new Set(["in", "out", "channel", "series", "load"]);
const DOMAINS = [
  ["input", "Input", ["input"]],
  ["cores", "Cores", ["cores", "sram"]],
  ["memory", "Memory", ["memory"]],
  ["io", "IO", ["io"]],
  ["connector", "Connectors", ["display", "storage", "connector"]],
  ["audio", "Audio", ["audio"]],
];

function byId(graph) {
  const map = new Map();
  for (const node of graph.nodes || []) map.set(node.id, node);
  return map;
}

function outgoing(graph, id) {
  return (graph.edges || []).filter((edge) => edge.src === id && FLOW.has(edge.role));
}

function nodeLabel(node) {
  if (!node) return "";
  if (node.refdes && node.value) return `${node.refdes} ${node.value}`;
  return node.refdes || node.name || node.id;
}

function isFuse(node) {
  if (!node || node.kind !== "protection") return false;
  const footprint = node.footprint || "";
  const value = node.value || "";
  return footprint === "FUSE" || footprint === "PPTC_FUSE" || value.startsWith("FUSE");
}

function isBead(node) {
  if (!node || node.kind !== "protection" || isFuse(node)) return false;
  if (/^L\d/.test(node.refdes || "")) return false;
  const footprint = node.footprint || "";
  return footprint.includes("FB0603") || /FB[_-]4P/.test(footprint) || footprint === "FERRITE_BEAD";
}

/** Fuse value, else a fuse count, else one bead value, else a bead count, else nothing. */
export function seriesBadge(parts) {
  const fuses = parts.filter(isFuse);
  const beads = parts.filter(isBead);
  if (fuses.length === 1) return fuses[0].value || "";
  if (fuses.length > 1) return `${fuses.length} fuses`;
  if (beads.length === 1) return beads[0].value || "";
  if (beads.length > 1) return `${beads.length} beads`;
  return "";
}

export function countText(parts) {
  const bits = [];
  const channels = parts.filter((part) => part.kind === "channel");
  const loads = parts.filter((part) => part.kind === "load");
  const ldos = parts.filter((part) => part.kind === "regulator" && part.topology === "ldo");
  const bucks = parts.filter((part) => part.kind === "regulator" && part.topology !== "ldo");
  if (channels.length) bits.push(`${channels.length} channel${channels.length === 1 ? "" : "s"}`);
  if (ldos.length === 1) bits.push("1 LDO");
  else if (ldos.length) bits.push(`${ldos.length} LDOs`);
  if (bucks.length) bits.push(`${bucks.length} regulator${bucks.length === 1 ? "" : "s"}`);
  if (loads.length === 1) bits.push("1 load");
  else if (loads.length) bits.push(`${loads.length} loads`);
  return bits.join(", ");
}

function enableNames(edges) {
  const names = [];
  for (const edge of edges) {
    for (const tag of edge.controls || []) {
      if (tag.role === "en" && tag.net && !names.includes(tag.net)) names.push(tag.net);
    }
  }
  return names;
}

/** Descendants that are not themselves open. Member edges are not part of the set. */
export function collapsedParts(graph, rootId, openSet) {
  const nodes = byId(graph);
  const parts = [];
  const edges = [];
  const seen = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    for (const edge of outgoing(graph, id)) {
      const child = nodes.get(edge.dst);
      if (!child || seen.has(child.id)) continue;
      seen.add(child.id);
      if (openSet.has(child.id)) continue;
      parts.push(child);
      edges.push(edge);
      stack.push(child.id);
    }
  }
  return { parts, edges };
}

export function badgeText(graph, rootId, openSet, includeEnables = true) {
  const nodes = byId(graph);
  const { parts, edges } = collapsedParts(graph, rootId, openSet);
  const root = nodes.get(rootId);
  const seriesParts = parts.filter((part) => part.kind === "protection");
  if (root && root.kind === "protection" && !openSet.has(rootId)) seriesParts.unshift(root);
  const bits = [];
  const count = countText(parts);
  const series = seriesBadge(seriesParts);
  const enables = includeEnables ? enableNames(edges) : [];
  if (count) bits.push(count);
  if (series) bits.push(series);
  if (enables.length) bits.push(enables.join(", "));
  return bits.join(" · ");
}

function isSecondStage(graph, regId) {
  const nodes = byId(graph);
  const seen = new Set();
  const stack = [regId];
  while (stack.length) {
    const id = stack.pop();
    for (const edge of graph.edges || []) {
      if (edge.dst !== id || !FLOW.has(edge.role)) continue;
      const src = nodes.get(edge.src);
      if (!src || seen.has(src.id)) continue;
      if (src.kind === "regulator" && src.id !== regId) return true;
      seen.add(src.id);
      stack.push(src.id);
    }
  }
  return false;
}

function regulatorsReached(graph, startId) {
  const nodes = byId(graph);
  const found = new Set();
  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop();
    for (const edge of outgoing(graph, id)) {
      const dst = nodes.get(edge.dst);
      if (!dst || seen.has(dst.id)) continue;
      if (dst.kind === "regulator") {
        found.add(dst.id);
        continue;
      }
      seen.add(dst.id);
      stack.push(dst.id);
    }
  }
  return found;
}

function openDiscrete(graph) {
  const open = new Set();
  const nodes = graph.nodes || [];
  const first = nodes.filter((node) => node.kind === "regulator" && !isSecondStage(graph, node.id));
  for (const regulator of first) {
    open.add(regulator.id);
    for (const edge of outgoing(graph, regulator.id)) {
      if (edge.role === "out") open.add(edge.dst);
    }
  }
  for (const node of nodes) {
    if (node.kind !== "protection" && node.kind !== "switch") continue;
    if (regulatorsReached(graph, node.id).size > 1) open.add(node.id);
  }
  if (open.size > VISIBLE_CAP) {
    const nodesById = byId(graph);
    for (const id of [...open]) {
      const node = nodesById.get(id);
      if (!node || node.kind !== "rail") continue;
      const outs = outgoing(graph, id);
      if (outs.length && outs.every((edge) => edge.role === "load")) open.delete(id);
      if (open.size <= VISIBLE_CAP) break;
    }
  }
  return open;
}

function openPmicFrame(graph) {
  const open = new Set();
  const inputKinds = new Set(["source", "connector", "protection", "switch", "rail"]);
  for (const node of graph.nodes || []) {
    if (node.kind === "pmic") open.add(node.id);
    if (node.group === "input" && inputKinds.has(node.kind)) open.add(node.id);
    if (node.kind === "regulator") {
      open.add(node.id);
      for (const edge of outgoing(graph, node.id)) {
        if (edge.role === "out") open.add(edge.dst);
      }
    }
  }
  if (open.size > PMIC_CAP) {
    const nodesById = byId(graph);
    for (const id of [...open]) {
      const node = nodesById.get(id);
      if (!node || node.kind !== "rail" || node.group === "input") continue;
      open.delete(id);
      if (open.size <= PMIC_CAP) break;
    }
  }
  return open;
}

export function defaultOpen(graph) {
  const hasPmic = (graph.nodes || []).some((node) => node.kind === "pmic");
  return hasPmic ? openPmicFrame(graph) : openDiscrete(graph);
}

function channelGroups(graph, pmicId, openSet) {
  const nodes = byId(graph);
  const grouped = new Map();
  for (const edge of graph.edges || []) {
    if (edge.src !== pmicId || edge.role !== "channel") continue;
    const channel = nodes.get(edge.dst);
    if (!channel) continue;
    const group = channel.group || "other";
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push({ channel, edge });
  }
  return [...grouped.entries()].sort().map(([group, rows]) => {
    const enables = enableNames(rows.map((row) => row.edge));
    return {
      group,
      count: rows.length,
      ids: rows.map((row) => row.channel.id),
      names: rows.map((row) => row.channel.name),
      open: rows.some((row) => openSet.has(row.channel.id)),
      badge: `${rows.length} channel${rows.length === 1 ? "" : "s"}`,
      enables,
      detail: enables.length ? "" : NO_ENABLE_DETAIL,
    };
  });
}

export function unresolvedLine(graph) {
  const count = (graph.unresolved || []).length;
  if (!count) return "";
  return `${count} parts have no pin list, so they are not drawn as feeding anything.`;
}

function membersOf(graph, railId) {
  const nodes = byId(graph);
  const names = [];
  for (const edge of graph.edges || []) {
    if (edge.dst !== railId || edge.role !== "member") continue;
    const src = nodes.get(edge.src);
    if (src && src.refdes) names.push(src.refdes);
  }
  return names;
}

function discreteColumns(graph, openSet) {
  const reachable = new Set();
  const stack = [...openSet];
  const seen = new Set(openSet);
  while (stack.length) {
    const id = stack.pop();
    for (const edge of outgoing(graph, id)) {
      if (seen.has(edge.dst)) continue;
      seen.add(edge.dst);
      reachable.add(edge.dst);
      stack.push(edge.dst);
    }
  }
  const rows = [];
  for (const node of graph.nodes || []) {
    if (node.kind === "connector" || node.kind === "load" || node.kind === "channel") continue;
    const open = openSet.has(node.id);
    if (!open && reachable.has(node.id)) continue;
    if (!open && !reachable.has(node.id) && node.kind === "rail") {
      const inbound = (graph.edges || []).filter((edge) => edge.dst === node.id);
      const fed = inbound.some((edge) => edge.role !== "member");
      const member = inbound.some((edge) => edge.role === "member");
      if (fed || !member) continue;
    }
    rows.push({
      id: node.id,
      kind: node.kind,
      label: nodeLabel(node),
      open,
      badge: badgeText(graph, node.id, openSet),
      members: node.kind === "rail" ? membersOf(graph, node.id) : [],
    });
  }
  rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows;
}

export function draw(graph, openSet) {
  const hasPmic = (graph.nodes || []).some((node) => node.kind === "pmic");
  const open = [...openSet].sort();
  const line = unresolvedLine(graph);
  if (!hasPmic) {
    return {
      hasPmic: false,
      open,
      frame: null,
      external: [],
      columns: discreteColumns(graph, openSet),
      unresolved: line,
    };
  }
  const nodes = byId(graph);
  const frame = (graph.nodes || []).filter((node) => node.kind === "pmic").map((pmic) => ({
    id: pmic.id,
    refdes: pmic.refdes,
    groups: channelGroups(graph, pmic.id, openSet),
  }));
  const external = (graph.nodes || []).filter((node) => node.kind === "regulator").map((regulator) => ({
    id: regulator.id,
    refdes: regulator.refdes,
    open: openSet.has(regulator.id),
    badge: badgeText(graph, regulator.id, openSet),
    rails: outgoing(graph, regulator.id)
      .filter((edge) => edge.role === "out")
      .map((edge) => nodes.get(edge.dst))
      .filter(Boolean)
      .map((rail) => ({
        id: rail.id,
        name: rail.name,
        badge: badgeText(graph, rail.id, openSet),
        members: membersOf(graph, rail.id),
      })),
  }));
  return { hasPmic: true, open, frame, external, columns: [], unresolved: line };
}

function controlColumn(edges, role) {
  const names = [];
  for (const edge of edges) {
    for (const tag of edge.controls || []) {
      if (tag.role === role && tag.net && !names.includes(tag.net)) names.push(tag.net);
    }
  }
  return names.join(", ");
}

export function railTable(graph) {
  const nodes = byId(graph);
  const rows = [];
  for (const node of graph.nodes || []) {
    if (node.kind !== "rail" && node.kind !== "channel") continue;
    const inbound = (graph.edges || []).filter((edge) => edge.dst === node.id && edge.role !== "member");
    let from = "";
    if (node.kind === "channel") {
      const pmic = nodes.get(node.pmic);
      from = `${pmic && pmic.refdes ? pmic.refdes : "PMIC"} channel`;
    } else {
      const src = inbound
        .map((edge) => nodes.get(edge.src))
        .find((item) => item && item.refdes && item.kind !== "connector");
      from = src ? src.refdes : "";
    }
    const seriesParts = inbound
      .filter((edge) => edge.role === "series")
      .map((edge) => nodes.get(edge.src))
      .filter(Boolean);
    const loads = (graph.edges || []).filter((edge) => edge.src === node.id && edge.role === "load");
    rows.push({
      Rail: node.name,
      Group: node.group || "",
      From: from,
      EN: controlColumn(inbound, "en"),
      PWM: controlColumn(inbound, "pwm"),
      PG: controlColumn(inbound, "pg"),
      "Series parts": seriesBadge(seriesParts),
      Loads: String(loads.length),
    });
  }
  rows.sort((a, b) => a.Rail.localeCompare(b.Rail) || a.From.localeCompare(b.From));
  return rows;
}

/** Notice for a ?board= value. Illegal ids produce a fixed sentence. */
export function boardNotice(wanted, index, showHidden) {
  if (wanted == null || wanted === "") return null;
  if (!ID_GRAMMAR.test(wanted)) return "No board is selected.";
  const pinout = (index.pinout_only || []).find((row) => row.id === wanted);
  if (pinout) return pinout.reason;
  const row = (index.boards || []).find((item) => item.id === wanted);
  if (row && row.hidden && !showHidden) return `${wanted} is not listed publicly.`;
  if (!row) return `No board ${wanted}.`;
  return null;
}

function railRowMatches(row, rail) {
  return row.Rail === rail || row.EN === rail || row.PWM === rail || row.PG === rail;
}

/** Query string writeUrl will put in the address bar. */
export function permalinkQuery({ showHidden, boardId, rail }) {
  const params = new URLSearchParams();
  if (showHidden) params.set("hidden", "1");
  if (boardId) params.set("board", boardId);
  if (rail) params.set("rail", rail);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * First-paint decision for ?board= and ?rail=.
 * The rail stays when the board on screen is the board that was requested.
 * A rail that is on that graph selects the Rails reading. An unknown rail
 * stays in the URL and produces a notice.
 */
export function permalinkState({ wanted, rail, showHidden, index, graph }) {
  const notice = boardNotice(wanted, index, showHidden);
  const boards = index.boards || [];
  const visible = boards.filter((row) => showHidden || !row.hidden);
  let start = visible.find((row) => row.id === wanted) ||
    visible.find((row) => row.id === DEFAULT_BOARD) ||
    visible[0];
  if (!start) start = boards.find((row) => row.id === DEFAULT_BOARD) || boards[0] || null;
  let pinnedNotice = notice || "";
  if (!pinnedNotice && start && start.hidden && !showHidden) {
    pinnedNotice = `${start.id} is not listed publicly.`;
  }
  const sameBoard = Boolean(start && (wanted == null || wanted === "" || start.id === wanted));
  const keepRail = sameBoard ? (rail || "") : "";
  const rows = graph ? railTable(graph) : [];
  const selected = Boolean(keepRail && rows.some((row) => railRowMatches(row, keepRail)));
  return {
    boardId: start ? start.id : "",
    rail: keepRail,
    reading: selected ? "rails" : "tree",
    pinnedNotice,
    railNotice: keepRail && graph && !selected ? `No rail ${keepRail}.` : "",
    selected,
    url: permalinkQuery({ showHidden, boardId: start ? start.id : "", rail: keepRail }),
  };
}

function setNotice(text) {
  const host = document.getElementById("notices");
  host.replaceChildren();
  if (!text) return;
  const note = document.createElement("p");
  note.className = "lc-notice";
  note.setAttribute("role", "status");
  note.textContent = text;
  host.appendChild(note);
}

function addNotice(text) {
  if (!text) return;
  const host = document.getElementById("notices");
  const note = document.createElement("p");
  note.className = "lc-notice";
  note.setAttribute("role", "status");
  note.textContent = text;
  host.appendChild(note);
}

let index = { boards: [], pinout_only: [] };
let showHidden = false;
let graph = null;
let meta = null;
let reading = "tree";
let hiddenDomains = new Set();
let showProtection = true;
let showEnables = true;
let railQuery = "";
let pinnedNotice = "";
let openSet = null;

function visibleBoards() {
  return (index.boards || []).filter((row) => showHidden || !row.hidden);
}

function buildSelect() {
  const select = document.getElementById("board-select");
  select.replaceChildren();
  const rows = visibleBoards();
  const vendors = [...new Set(rows.map((row) => row.vendor || "Board"))];
  for (const vendor of vendors) {
    const group = document.createElement("optgroup");
    group.label = vendor;
    for (const row of rows.filter((item) => (item.vendor || "Board") === vendor)) {
      const option = document.createElement("option");
      option.value = row.id;
      option.textContent = `${row.name} (${row.model})`;
      group.appendChild(option);
    }
    select.appendChild(group);
  }
}

function writeUrl(boardId, rail) {
  const params = new URLSearchParams();
  if (showHidden) params.set("hidden", "1");
  if (boardId) params.set("board", boardId);
  if (rail) params.set("rail", rail);
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function domainOf(group) {
  for (const [id, _label, groups] of DOMAINS) {
    if (groups.includes(group)) return id;
  }
  return null;
}

function hiddenByDomain(node) {
  if (!showProtection && (node.kind === "protection")) return true;
  const domain = domainOf(node.group);
  return domain ? hiddenDomains.has(domain) : false;
}

function toggleIds(ids) {
  if (!openSet) return;
  const anyOpen = ids.some((id) => openSet.has(id));
  for (const id of ids) {
    if (anyOpen) openSet.delete(id);
    else openSet.add(id);
  }
  render();
}

function paintDetail(drawn) {
  const host = document.getElementById("detail");
  if (!host) return;
  host.replaceChildren();
  if (!drawn.frame) return;
  const needs = drawn.frame.some((pmic) => pmic.groups.some((group) => group.detail));
  if (!needs) return;
  const line = document.createElement("p");
  line.className = "power-detail";
  line.textContent = NO_ENABLE_DETAIL;
  host.appendChild(line);
}

function paintTree(drawn) {
  const host = document.getElementById("tree");
  host.replaceChildren();
  if (drawn.unresolved) {
    const line = document.createElement("p");
    line.className = "power-unresolved";
    line.textContent = drawn.unresolved;
    host.appendChild(line);
  }
  if (graph && graph.nodes.length === 0) {
    const line = document.createElement("p");
    line.textContent = graph.reason || "No power tree.";
    host.appendChild(line);
    return;
  }
  const layout = document.createElement("div");
  layout.className = "power-layout";
  if (drawn.frame) {
    for (const pmic of drawn.frame) {
      const frame = document.createElement("section");
      frame.className = "power-frame";
      const title = document.createElement("h3");
      title.textContent = pmic.refdes;
      frame.appendChild(title);
      for (const group of pmic.groups) {
        if (hiddenDomains.has(domainOf(group.group))) continue;
        const row = document.createElement("p");
        row.className = "power-node";
        row.dataset.open = group.open ? "true" : "false";
        const name = document.createElement("span");
        name.textContent = group.group;
        row.appendChild(name);
        const badge = document.createElement("span");
        badge.className = "power-badge";
        const enable = showEnables && group.enables.length ? ` · ${group.enables.join(", ")}` : "";
        badge.textContent = `${group.badge}${enable}`;
        row.appendChild(badge);
        row.addEventListener("click", () => toggleIds(group.ids));
        frame.appendChild(row);
        if (group.open) {
          for (const channelName of group.names) {
            const line = document.createElement("p");
            line.className = "power-node power-child";
            line.textContent = channelName;
            frame.appendChild(line);
          }
        } else if (group.detail) {
          const detail = document.createElement("p");
          detail.className = "power-detail";
          detail.textContent = group.detail;
          frame.appendChild(detail);
        }
      }
      layout.appendChild(frame);
    }
    if (drawn.external.length) {
      const column = document.createElement("section");
      column.className = "power-col power-external";
      const title = document.createElement("h3");
      title.textContent = "Regulators";
      column.appendChild(title);
      for (const regulator of drawn.external) {
        const row = document.createElement("p");
        row.className = "power-node";
        row.dataset.open = regulator.open ? "true" : "false";
        row.textContent = regulator.refdes;
        row.addEventListener("click", () => toggleIds([regulator.id]));
        const regBadge = badgeText(graph, regulator.id, openSet, showEnables);
        if (regBadge) {
          const badge = document.createElement("span");
          badge.className = "power-badge";
          badge.textContent = regBadge;
          row.appendChild(badge);
        }
        column.appendChild(row);
        for (const rail of regulator.rails) {
          const railRow = document.createElement("p");
          railRow.className = "power-node";
          railRow.textContent = rail.name;
          const railBadge = badgeText(graph, rail.id, openSet, showEnables);
          if (railBadge) {
            const badge = document.createElement("span");
            badge.className = "power-badge";
            badge.textContent = railBadge;
            railRow.appendChild(badge);
          }
          column.appendChild(railRow);
        }
      }
      layout.appendChild(column);
    }
  } else {
    const column = document.createElement("section");
    column.className = "power-col";
    for (const row of drawn.columns) {
      const node = byId(graph).get(row.id);
      if (node && hiddenByDomain(node)) continue;
      const line = document.createElement("p");
      line.className = "power-node";
      line.dataset.open = row.open ? "true" : "false";
      line.textContent = row.label;
      line.addEventListener("click", () => toggleIds([row.id]));
      const liveBadge = badgeText(graph, row.id, openSet, showEnables);
      if (liveBadge) {
        const badge = document.createElement("span");
        badge.className = "power-badge";
        badge.textContent = liveBadge;
        line.appendChild(badge);
      }
      if (row.members && row.members.length) {
        const tag = document.createElement("span");
        tag.className = "power-tag";
        tag.textContent = row.members.join(", ");
        line.appendChild(tag);
      }
      column.appendChild(line);
    }
    layout.appendChild(column);
  }
  host.appendChild(layout);
}

function paintRails(rows) {
  const host = document.getElementById("rails");
  host.replaceChildren();
  const table = document.createElement("table");
  table.className = "power-rails";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const name of RAIL_COLUMNS) {
    const cell = document.createElement("th");
    cell.textContent = name;
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = document.createElement("tbody");
  for (const row of rows) {
    if (hiddenDomains.has(domainOf(row.Group))) continue;
    const tr = document.createElement("tr");
    if (railQuery && railRowMatches(row, railQuery)) {
      tr.className = "power-hit";
    }
    for (const name of RAIL_COLUMNS) {
      const cell = document.createElement("td");
      let text = row[name];
      if (!showEnables && (name === "EN" || name === "PWM" || name === "PG")) text = "";
      cell.textContent = text;
      tr.appendChild(cell);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  host.appendChild(table);
}

function render() {
  if (!graph) return;
  if (graph.schema !== 1) {
    setNotice("This board's power file is not schema 1.");
    return;
  }
  if (!openSet) openSet = defaultOpen(graph);
  const drawn = draw(graph, openSet);
  const rows = railTable(graph);
  setNotice(pinnedNotice);
  document.getElementById("view-tree").setAttribute("aria-pressed", reading === "tree" ? "true" : "false");
  document.getElementById("view-rails").setAttribute("aria-pressed", reading === "rails" ? "true" : "false");
  document.getElementById("tree").hidden = reading !== "tree";
  document.getElementById("rails").hidden = reading !== "rails";
  paintTree(drawn);
  paintRails(rows);
  paintDetail(drawn);
  const metaHost = document.getElementById("board-meta");
  metaHost.replaceChildren();
  if (meta) {
    const line = document.createElement("p");
    const shape = meta.shape || graph.shape || "";
    line.textContent = `${meta.name} · ${meta.soc}${shape ? ` · ${shape}` : ""}`;
    metaHost.appendChild(line);
    if (meta.shares_layout_with) {
      const other = (index.boards || []).find((row) => row.id === meta.shares_layout_with);
      if (other && (showHidden || !other.hidden)) {
        const same = document.createElement("p");
        same.appendChild(document.createTextNode("same PCB as "));
        const link = document.createElement("a");
        link.textContent = other.model;
        link.href = `?board=${other.id}${showHidden ? "&hidden=1" : ""}`;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          chooseBoard(other.id);
        });
        same.appendChild(link);
        metaHost.appendChild(same);
      }
    }
  }
  paintToggles();
  const railState = permalinkState({
    wanted: meta && meta.id,
    rail: railQuery,
    showHidden,
    index,
    graph,
  });
  if (railState.railNotice) addNotice(railState.railNotice);
  const hit = document.querySelector("tr.power-hit");
  if (hit) hit.scrollIntoView({ block: "nearest" });
}

function paintToggles() {
  const host = document.getElementById("domain-toggles");
  host.replaceChildren();
  const present = new Set((graph.nodes || []).map((node) => node.group).filter(Boolean));
  for (const [id, label, groups] of DOMAINS) {
    if (!groups.some((group) => present.has(group))) continue;
    host.appendChild(toggleButton(label, !hiddenDomains.has(id), () => {
      if (hiddenDomains.has(id)) hiddenDomains.delete(id);
      else hiddenDomains.add(id);
      render();
    }));
  }
  if ((graph.nodes || []).some((node) => node.kind === "protection") || (graph.unresolved || []).length) {
    host.appendChild(toggleButton("Protection", showProtection, () => {
      showProtection = !showProtection;
      render();
    }));
  }
  const hasEnable = (graph.edges || []).some((edge) => (edge.controls || []).some((tag) => tag.role === "en"));
  if (hasEnable) {
    host.appendChild(toggleButton("Enables", showEnables, () => {
      showEnables = !showEnables;
      render();
    }));
  }
}

function toggleButton(label, pressed, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lc-toggle";
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function searchHits(term) {
  const query = term.trim().toLowerCase();
  if (!query || !graph) return [];
  const hits = [];
  for (const node of graph.nodes || []) {
    const hay = [node.refdes, node.name, node.value, node.footprint].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(query)) hits.push({ label: nodeLabel(node), rail: railFor(node) });
  }
  for (const edge of graph.edges || []) {
    for (const tag of edge.controls || []) {
      if (tag.net && tag.net.toLowerCase().includes(query)) {
        hits.push({ label: tag.net, rail: tag.net });
      }
    }
  }
  for (const row of graph.unresolved || []) {
    const hay = [row.refdes, row.value, row.footprint].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(query)) hits.push({ label: row.refdes, rail: "" });
  }
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.label}|${hit.rail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

function railFor(node) {
  if (node.kind === "rail" || node.kind === "channel") return node.name || "";
  const edge = (graph.edges || []).find((item) => item.src === node.id && (item.role === "out" || item.role === "channel"));
  return edge ? edge.net : "";
}

function paintSearch(term) {
  const host = document.getElementById("search-hits");
  host.replaceChildren();
  for (const hit of searchHits(term)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "power-hit-btn";
    button.textContent = hit.label;
    button.addEventListener("click", () => {
      railQuery = hit.rail || "";
      if (railQuery) reading = "rails";
      hiddenDomains = new Set();
      showProtection = true;
      showEnables = true;
      writeUrl(meta && meta.id, railQuery);
      host.replaceChildren();
      render();
    });
    host.appendChild(button);
  }
}

async function loadBoard(row) {
  meta = row;
  hiddenDomains = new Set();
  showProtection = true;
  showEnables = true;
  const response = await fetch(`data/${row.id}.json`);
  if (!response.ok) throw new Error(`data/${row.id}.json`);
  graph = await response.json();
  openSet = defaultOpen(graph);
  const railState = permalinkState({
    wanted: meta.id,
    rail: railQuery,
    showHidden,
    index,
    graph,
  });
  railQuery = railState.rail;
  reading = railState.reading;
  const select = document.getElementById("board-select");
  if ([...select.options].some((option) => option.value === row.id)) select.value = row.id;
  render();
}

function chooseBoard(id) {
  const row = (index.boards || []).find((item) => item.id === id);
  if (!row || !ID_GRAMMAR.test(id)) return;
  railQuery = "";
  pinnedNotice = "";
  writeUrl(id, "");
  setNotice("");
  loadBoard(row).catch(() => setNotice(FILE_NOTICE));
}

async function init() {
  mountShell();
  if (location.protocol === "file:") {
    setNotice(FILE_NOTICE);
    return;
  }
  try {
    index = await fetch("data/boards.json").then((response) => {
      if (!response.ok) throw new Error("boards");
      return response.json();
    });
  } catch (_error) {
    setNotice(FILE_NOTICE);
    return;
  }
  const params = new URLSearchParams(location.search);
  showHidden = ["1", "true", "yes"].includes((params.get("hidden") || "").toLowerCase());
  railQuery = params.get("rail") || "";
  buildSelect();
  const wanted = params.get("board");
  const opened = permalinkState({ wanted, rail: railQuery, showHidden, index, graph: null });
  pinnedNotice = opened.pinnedNotice;
  railQuery = opened.rail;
  if (pinnedNotice) setNotice(pinnedNotice);
  if (!opened.boardId) {
    addNotice("No board is selected.");
    return;
  }
  if (wanted && opened.pinnedNotice) writeUrl(opened.boardId, opened.rail);
  const start = (index.boards || []).find((row) => row.id === opened.boardId);
  try {
    await loadBoard(start);
  } catch (_error) {
    setNotice(FILE_NOTICE);
  }
  document.getElementById("board-select").addEventListener("change", (event) => {
    chooseBoard(event.target.value);
  });
  document.getElementById("view-tree").addEventListener("click", () => {
    reading = "tree";
    render();
  });
  document.getElementById("view-rails").addEventListener("click", () => {
    reading = "rails";
    render();
  });
  document.getElementById("search").addEventListener("input", (event) => {
    paintSearch(event.target.value);
  });
}

if (typeof window !== "undefined") {
  window.PowerTree = {
    defaultOpen,
    draw,
    seriesBadge,
    badgeText,
    railTable,
    boardNotice,
    permalinkState,
    permalinkQuery,
    unresolvedLine,
    collapsedParts,
    countText,
    FILE_NOTICE,
    NO_ENABLE_DETAIL,
    RAIL_COLUMNS,
    VISIBLE_CAP,
    PMIC_CAP,
    DEFAULT_BOARD,
  };
}

if (typeof document !== "undefined") init();
