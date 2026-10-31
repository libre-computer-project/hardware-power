"use strict";

/* Power tree and power states. The board document (schema 2) is generated
 * from the board's netlist; js/model.js holds every decision this page
 * makes about it, and this file only paints. */

import { mountShell } from "./lc-kit.js";
import {
  STATUS_TEXT, buildQuery, byId, children, columns, controlText, kindText,
  loadLines, parseQuery, regulatorCount, search, status, steps, voltText, voltageClass,
} from "./model.js";

const GPIO_SITE = "https://gpio.hardware.libre.computer/";
const LAYOUT_SITE = "https://layout.hardware.libre.computer/";
const X_HELP =
  "Not determined: what switches this rail at this step cannot be settled from the board's " +
  "published design data, so the page does not guess.";
const STEPS_HELP =
  "These steps stop at reset. Rails that software turns on later (after boot) show the state " +
  "they have before it runs.";
const TREE_HELP =
  "Level n: n parts between the rail and the board's input. Source not traced: nothing on the " +
  "board's netlist that this page can follow makes the rail.";
const VOLT_KEY = [["power5v", "5 V"], ["power3v3", "3.3 V"], ["powerlv", "Below 3 V"], ["unknown", "Not stated"]];
const DEFAULT_BOARD = "aml-s905x-cc-v2";

const el = (id) => document.getElementById(id);
const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let index = { boards: [], pinout_only: [] };
let doc = null;
const view = { board: null, walk: null, step: 1, rail: null, view: "tree", query: "", reveal: false };

/** Every interactive element carries data-focus; a re-render puts keyboard
 *  focus back on the element with the same key. */
function focusable(node, key) {
  node.dataset.focus = key;
  return node;
}

function writeUrl() {
  history.replaceState(null, "", buildQuery({
    board: view.board, walk: view.walk, step: view.step, rail: view.rail, view: view.view,
  }));
}

function notice(text) {
  const host = el("notices");
  host.textContent = "";
  if (!text) return;
  const p = make("p", "lc-notice", text);
  p.setAttribute("role", "status");
  host.appendChild(p);
}

/** One short sentence for screen readers after a step or rail change. */
function announce(text) {
  el("announce").textContent = text;
}

// --- board list --------------------------------------------------------------

function buildSelect() {
  const sel = el("board-select");
  sel.textContent = "";
  const listed = index.boards.filter((b) => !b.hidden);
  const modelled = listed.filter((b) => b.coverage === "model");
  const other = listed.filter((b) => b.coverage !== "model");
  const group = (label, rows) => {
    if (!rows.length) return;
    const g = make("optgroup");
    g.label = label;
    for (const b of rows) {
      const o = make("option", null, b.model ? `${b.name} (${b.model})` : b.name);
      o.value = b.id;
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  group("Power tree and states", modelled);
  group("Power tree not available yet", [...other, ...(index.pinout_only || [])]);
  sel.addEventListener("change", () => chooseBoard(sel.value, true));
}

async function chooseBoard(id, fresh, said = "") {
  const row = index.boards.find((b) => b.id === id) || index.pinout_only.find((b) => b.id === id);
  if (!row) {
    const fallback = index.boards.find((b) => b.id === DEFAULT_BOARD);
    return chooseBoard(DEFAULT_BOARD, true,
      `No board "${id}" here; showing ${fallback ? fallback.name : DEFAULT_BOARD} instead.`);
  }
  view.board = id;
  el("board-select").value = id;
  if (fresh) Object.assign(view, { walk: null, step: null, rail: null });
  doc = null;
  if (row.coverage === "model") {
    try {
      const r = await fetch(`data/${id}.json`);
      if (!r.ok) throw new Error(String(r.status));
      doc = await r.json();
    } catch (e) {
      said = `Could not load the power data for ${row.name}.`;
    }
  }
  notice(said);
  if (!doc) {
    paintEmpty(row, row.coverage === "model");
    view.step = null;
    writeUrl();
    return;
  }
  const walk = (doc.walks || [])[0];
  if (!view.walk || !(doc.walks || []).some((w) => w.id === view.walk)) view.walk = walk ? walk.id : null;
  const n = steps(doc, view.walk).length;
  if (view.step == null || view.step >= n) view.step = Math.max(0, n - 1);
  if (view.rail && !doc.rails.some((r) => r.id === view.rail)) view.rail = null;
  render();
}

function paintEmpty(row, failed) {
  document.body.classList.remove("pw-sheet-open");
  el("board-meta").textContent = "";
  el("board-meta").appendChild(make("p", "pw-meta-name", row.name));
  const sub = [row.model, row.soc].filter(Boolean).join(" · ");
  if (sub) el("board-meta").appendChild(make("p", "pw-meta-sub", sub));
  el("search").disabled = true;
  el("walk").textContent = "";
  el("legend").textContent = "";
  el("state-heading").hidden = true;
  el("view-heading").hidden = true;
  el("view-seg").hidden = true;
  el("detail").hidden = true;
  el("rails").hidden = true;
  const tree = el("tree");
  tree.hidden = false;
  tree.textContent = "";
  if (failed) return;
  const box = make("div", "pw-empty");
  box.appendChild(make("p", null,
    "This board's power tree is not available yet: it is drawn from the board's design files, and those are not published for this board."));
  const a = make("a", null, "Its header pins and their I/O voltages are on the GPIO pinout");
  a.href = `${GPIO_SITE}?board=${encodeURIComponent(row.id)}`;
  box.appendChild(a);
  tree.appendChild(box);
}

// --- render ------------------------------------------------------------------

function current() {
  const all = steps(doc, view.walk);
  return { all, step: all[view.step] || all[all.length - 1] };
}

/** Where focus goes when the element that had it is gone or disabled. */
const FOCUS_FALLBACK = { next: "prev", prev: "next", close: null };

function render() {
  const focusKey = document.activeElement && document.activeElement.dataset
    ? document.activeElement.dataset.focus : null;
  for (const id of ["state-heading", "view-heading", "view-seg"]) el(id).hidden = false;
  el("search").disabled = false;
  document.body.classList.toggle("pw-sheet-open", Boolean(view.rail));
  paintMeta();
  paintWalk();
  paintLegend();
  const tree = view.view === "tree";
  el("view-tree").setAttribute("aria-pressed", String(tree));
  el("view-rails").setAttribute("aria-pressed", String(!tree));
  el("tree").hidden = !tree;
  el("rails").hidden = tree;
  if (tree) paintTree();
  else paintRails();
  paintDetail();
  writeUrl();
  if (focusKey) {
    const find = (k) => k && document.querySelector(`[data-focus="${CSS.escape(k)}"]`);
    let again = find(focusKey);
    // a key that is gone: its stand-in, else the selected rail's card or
    // row (a rail link in the detail panel), else the card it was opened from
    if (!again || again.disabled) {
      again = find(FOCUS_FALLBACK[focusKey]) || (view.rail && (find(`rail-${view.rail}`) || find(`row-${view.rail}`)))
        || find(view.lastRail) || (view.lastRail && find(view.lastRail.replace(/^rail-/, "row-")));
    }
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }
}

function paintMeta() {
  const box = el("board-meta");
  box.textContent = "";
  box.appendChild(make("p", "pw-meta-name", doc.name || doc.id));
  box.appendChild(make("p", "pw-meta-sub", [doc.model, doc.soc].filter(Boolean).join(" · ")));
  box.appendChild(make("p", "pw-meta-sub",
    `${doc.rails.length} rails · ${regulatorCount(doc)} regulators and switches`));
}

function paintWalk() {
  const host = el("walk");
  host.textContent = "";
  const walks = doc.walks || [];
  if (walks.length > 1) {
    const sel = make("select", "pw-walk-select");
    sel.setAttribute("aria-label", "Sequence");
    for (const w of walks) {
      const o = make("option", null, w.label);
      o.value = w.id;
      sel.appendChild(o);
    }
    sel.value = view.walk;
    sel.addEventListener("change", () => {
      view.walk = sel.value;
      view.step = steps(doc, view.walk).length - 1;
      render();
    });
    host.appendChild(sel);
  } else if (walks[0]) {
    host.appendChild(make("p", "pw-walk-name", walks[0].label));
  }
  const { all } = current();
  const ol = make("ol", "pw-steps");
  all.forEach((s, i) => {
    const li = make("li");
    const b = focusable(make("button", "pw-step", s.label), `step-${i}`);
    b.type = "button";
    b.setAttribute("aria-pressed", String(i === view.step));
    const on = Object.values(s.rails).filter((v) => v === "on").length;
    b.title = `${on} of ${Object.keys(s.rails).length} rails on`;
    b.addEventListener("click", () => goStep(i));
    li.appendChild(b);
    ol.appendChild(li);
  });
  host.appendChild(ol);
  host.appendChild(make("p", "pw-help", STEPS_HELP));
  const nav = make("div", "pw-step-nav");
  const prev = focusable(make("button", "pw-nav", "◀ Previous"), "prev");
  const next = focusable(make("button", "pw-nav", "Next ▶"), "next");
  prev.type = next.type = "button";
  prev.disabled = view.step <= 0;
  next.disabled = view.step >= all.length - 1;
  prev.addEventListener("click", () => stepBy(-1));
  next.addEventListener("click", () => stepBy(1));
  nav.append(prev, next);
  host.appendChild(nav);
}

function stepBy(d) {
  const n = current().all.length;
  const s = Math.min(n - 1, Math.max(0, view.step + d));
  if (s !== view.step) goStep(s);
}

function goStep(i) {
  view.step = i;
  render();
  const { all, step } = current();
  const on = doc.rails.filter((r) => status(step, r.id) === "on").length;
  announce(`Step ${i + 1} of ${all.length}: ${step.label}. ${on} of ${doc.rails.length} rails on.`);
}

function paintLegend() {
  const host = el("legend");
  host.textContent = "";
  const { step } = current();
  const counts = { on: 0, off: 0, x: 0 };
  for (const r of doc.rails) counts[status(step, r.id)]++;
  for (const k of ["on", "off", "x"]) {
    const row = make("span", `pw-legend-item pw-s-${k}`);
    row.appendChild(make("span", "pw-dot"));
    row.appendChild(make("span", null, `${STATUS_TEXT[k]} ${counts[k]}`));
    host.appendChild(row);
  }
  if (counts.x) host.appendChild(make("p", "pw-help", X_HELP));
  const key = make("div", "pw-vkey");
  key.setAttribute("role", "group");
  key.setAttribute("aria-label", "Edge colour: voltage");
  for (const [cls, text] of VOLT_KEY) {
    const item = make("span", `pw-vkey-item pw-v-${cls}`);
    item.appendChild(make("span", "pw-vbar"));
    item.appendChild(make("span", null, text));
    key.appendChild(item);
  }
  host.appendChild(key);
  if (view.view === "tree") host.appendChild(make("p", "pw-help", TREE_HELP));
}

function railCard(rail, step, makers, rails) {
  const st = status(step, rail.id);
  const card = focusable(make("button", `pw-rail pw-s-${st} pw-v-${voltageClass(rail.v)}`), `rail-${rail.id}`);
  card.type = "button";
  card.dataset.rail = rail.id;
  card.setAttribute("aria-pressed", String(view.rail === rail.id));
  if (view.query && !search(doc, view.query).includes(rail.id)) card.classList.add("pw-dim");
  for (const mid of rail.made_by || []) {
    const m = makers.get(mid);
    if (!m) continue;
    const line = make("span", "pw-maker");
    line.appendChild(make("span", "pw-ref", m.refdes));
    line.appendChild(make("span", null, ` ${kindText(m.kind, m.link)}`));
    // the wires say this on a wide screen; a narrow one has no wires
    if (m.in) line.appendChild(make("span", "pw-from", ` from ${(rails.get(m.in) || {}).name}`));
    if (m.kind !== "link") line.appendChild(make("span", "pw-ctl", ` · ${controlText(doc, m)}`));
    card.appendChild(line);
  }
  if (rail.input) card.appendChild(make("span", "pw-maker", `${rail.input} input`));
  const head = make("span", "pw-rail-head");
  head.appendChild(make("span", "pw-dot"));
  head.appendChild(make("span", "pw-name", rail.name));
  if (rail.v != null) head.appendChild(make("span", "pw-volt", voltText(rail.v)));
  head.appendChild(make("span", "pw-state", STATUS_TEXT[st]));
  card.appendChild(head);
  const loads = loadLines(rail);
  if (loads.length) card.appendChild(make("span", "pw-loads", loads.join(" · ")));
  // read the rail first, then what makes it: the visual order puts the
  // maker line on top
  const makerText = (rail.made_by || []).map((mid) => makers.get(mid)).filter(Boolean)
    .map((m) => `${m.refdes} ${kindText(m.kind, m.link)}${m.kind !== "link" ? `, ${controlText(doc, m)}` : ""}`);
  card.setAttribute("aria-label", [
    `${rail.name}${rail.v != null ? ` ${voltText(rail.v)}` : ""}: ${STATUS_TEXT[st]}`,
    rail.input ? `${rail.input} input` : "", ...makerText, loads.join(", "),
  ].filter(Boolean).join(". "));
  card.addEventListener("click", () => {
    view.rail = view.rail === rail.id ? null : rail.id;
    if (!view.rail) view.lastRail = `rail-${rail.id}`;
    render();
    if (view.rail) announce(`${rail.name} details open`);
  });
  return card;
}

function paintTree() {
  const tree = el("tree");
  tree.textContent = "";
  const { step } = current();
  const makers = byId(doc.makers);
  const rails = byId(doc.rails);
  const grid = make("div", "pw-cols");
  for (const col of columns(doc)) {
    const c = make("section", "pw-col");
    c.appendChild(make("h4", "pw-col-title", col.title));
    for (const r of col.rails) c.appendChild(railCard(r, step, makers, rails));
    if (col.more) {
      c.appendChild(make("h4", "pw-col-title pw-col-more", col.more.title));
      for (const r of col.more.rails) c.appendChild(railCard(r, step, makers, rails));
    }
    grid.appendChild(c);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("pw-wires");
  svg.setAttribute("aria-hidden", "true");
  tree.append(svg, grid);
  requestAnimationFrame(() => {
    drawWires(tree, svg, step);
    if (view.reveal && view.rail) {
      const card = tree.querySelector(`[data-rail="${CSS.escape(view.rail)}"]`);
      // with the detail as a bottom sheet, "nearest" would park the card
      // behind it: bring it to the top of the stage instead
      const sheet = matchMedia("(max-width: 1100px)").matches;
      if (card) card.scrollIntoView({ block: sheet ? "start" : "nearest", inline: "nearest" });
    }
    view.reveal = false;
  });
}

function drawWires(tree, svg, step) {
  const box = tree.getBoundingClientRect();
  svg.setAttribute("width", String(tree.scrollWidth));
  svg.setAttribute("height", String(tree.scrollHeight));
  svg.textContent = "";
  const pos = new Map();
  for (const card of tree.querySelectorAll(".pw-rail")) {
    const r = card.getBoundingClientRect();
    const top = r.top - box.top + tree.scrollTop;
    pos.set(card.dataset.rail, {
      x0: r.left - box.left + tree.scrollLeft, x1: r.right - box.left + tree.scrollLeft,
      top, bottom: top + r.height, y: top + Math.min(r.height / 2, 28),
    });
  }
  const kids = children(doc);
  for (const [parent, list] of kids) {
    const a = pos.get(parent);
    if (!a) continue;
    // fan the wires out along the parent's edge in the order their children
    // sit, so a bundle from one parent can be told apart
    const ends = list.map(({ rail }) => ({ rail, b: pos.get(rail) }))
      .filter(({ b }) => b && b.x0 > a.x1)
      .sort((p, q) => p.b.y - q.b.y);
    const span = Math.max(0, a.bottom - a.top - 16);
    ends.forEach(({ rail, b }, k) => {
      const ya = ends.length > 1 ? a.top + 8 + (span * k) / (ends.length - 1) : a.y;
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const mid = a.x1 + (b.x0 - a.x1) * (0.35 + 0.3 * (k / Math.max(1, ends.length - 1)));
      path.setAttribute("d", `M${a.x1},${ya} C${mid},${ya} ${mid},${b.y} ${b.x0},${b.y}`);
      path.setAttribute("class", `pw-wire pw-s-${status(step, rail)}`
        + (view.rail && (view.rail === rail || view.rail === parent) ? " pw-wire-hot" : ""));
      svg.appendChild(path);
    });
  }
}

function paintRails() {
  const host = el("rails");
  host.textContent = "";
  const { all, step } = current();
  const makers = byId(doc.makers);
  const rails = byId(doc.rails);
  const table = make("table", "pw-table");
  const head = make("tr");
  for (const t of ["Rail", "Voltage", "Made by", "From", "Control", "Loads", ...all.map((s) => s.label)]) {
    head.appendChild(make("th", null, t));
  }
  const thead = make("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const body = make("tbody");
  const hits = view.query ? new Set(search(doc, view.query)) : null;
  for (const col of columns(doc)) {
    for (const r of [...col.rails, ...(col.more ? col.more.rails : [])]) {
      if (hits && !hits.has(r.id)) continue;
      const tr = make("tr", view.rail === r.id ? "pw-row-hot" : null);
      const name = focusable(make("button", "pw-link", r.name), `row-${r.id}`);
      name.type = "button";
      name.addEventListener("click", () => {
        view.rail = r.id;
        render();
      });
      const td0 = make("td");
      td0.appendChild(name);
      tr.appendChild(td0);
      tr.appendChild(make("td", null, voltText(r.v)));
      const ms = (r.made_by || []).map((m) => makers.get(m)).filter(Boolean);
      tr.appendChild(make("td", null, r.input ? `${r.input} input`
        : ms.map((m) => `${m.refdes} ${kindText(m.kind, m.link)}`).join(", ")));
      tr.appendChild(make("td", null,
        [...new Set(ms.map((m) => (rails.get(m.in) || {}).name).filter(Boolean))].join(", ")));
      tr.appendChild(make("td", null, ms.filter((m) => m.kind !== "link")
        .map((m) => (ms.length > 1 ? `${m.refdes}: ` : "") + controlText(doc, m)).join("; ")));
      tr.appendChild(make("td", "pw-cell-loads", loadLines(r).join("; ")));
      all.forEach((s, i) => {
        const st = status(s, r.id);
        const td = make("td", `pw-cell pw-s-${st}${i === view.step ? " pw-cell-now" : ""}`);
        td.appendChild(make("span", "pw-swatch"));
        td.appendChild(make("span", "pw-cell-text", STATUS_TEXT[st]));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  }
  table.appendChild(body);
  const wrap = make("div", "pw-table-wrap");
  wrap.appendChild(table);
  host.appendChild(wrap);
  void step;
}

function paintDetail() {
  const host = el("detail");
  host.textContent = "";
  const rail = view.rail && doc.rails.find((r) => r.id === view.rail);
  host.hidden = !rail;
  if (!rail) return;
  const makers = byId(doc.makers);
  const rails = byId(doc.rails);
  const { all } = current();
  const close = focusable(make("button", "pw-close", "×"), "close");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeDetail);
  host.appendChild(close);
  host.appendChild(make("h3", "pw-detail-title", rail.name));
  if (rail.v != null) host.appendChild(make("p", "pw-detail-v", voltText(rail.v)));
  const chips = make("div", "pw-chips");
  all.forEach((s, i) => {
    const st = status(s, rail.id);
    const c = focusable(make("button", `pw-chip pw-s-${st}`, `${i + 1}. ${s.label}: ${STATUS_TEXT[st]}`),
      `chip-${i}`);
    c.type = "button";
    c.setAttribute("aria-pressed", String(i === view.step));
    c.addEventListener("click", () => goStep(i));
    chips.appendChild(c);
  });
  host.appendChild(chips);
  const railLink = (id) => {
    const r = rails.get(id);
    const b = focusable(make("button", "pw-link", r ? r.name : id), `link-${id}`);
    b.type = "button";
    b.addEventListener("click", () => {
      view.rail = id;
      view.reveal = true;
      render();
    });
    return b;
  };
  const section = (title) => {
    host.appendChild(make("h4", null, title));
    const ul = make("ul", "pw-list");
    host.appendChild(ul);
    return ul;
  };
  if (rail.input) {
    section("Source").appendChild(make("li", null, `${rail.input}: power enters the board here`));
  }
  if ((rail.made_by || []).length) {
    const ul = section("Made by");
    if (rail.made_by.length > 1) {
      ul.appendChild(make("li", "pw-sub", "More than one part can drive this rail; what switches each decides which one does."));
    }
    for (const mid of rail.made_by) {
      const m = makers.get(mid);
      if (!m) continue;
      const li = make("li");
      li.appendChild(make("strong", null, `${m.refdes} `));
      li.appendChild(document.createTextNode(`${kindText(m.kind, m.link)} from `));
      if (m.in) li.appendChild(railLink(m.in));
      li.appendChild(make("div", "pw-sub", controlText(doc, m)));
      ul.appendChild(li);
    }
  } else if (!rail.input) {
    section("Made by").appendChild(make("li", "pw-sub", "Nothing on the netlist that this page can trace makes this rail."));
  }
  const kids = children(doc).get(rail.id) || [];
  if (kids.length) {
    const ul = section("Feeds");
    const through = new Map();
    for (const { rail: rid, maker } of kids) {
      if (!through.has(rid)) through.set(rid, []);
      through.get(rid).push((makers.get(maker) || {}).refdes);
    }
    for (const [rid, refs] of through) {
      const li = make("li");
      li.appendChild(railLink(rid));
      li.appendChild(make("span", "pw-sub", ` through ${refs.join(", ")}`));
      ul.appendChild(li);
    }
  }
  const l = rail.loads || {};
  if ((l.soc || []).length || (l.connectors || []).length || (l.parts || []).length) {
    const ul = section("Loads");
    if ((l.soc || []).length) ul.appendChild(make("li", null, `SoC supply balls: ${l.soc.join(", ")}`));
    for (const c of l.connectors || []) {
      const li = make("li");
      if (c.header40) {
        const a = make("a", null, `40-pin header pin${c.pins.length > 1 ? "s" : ""} ${c.pins.join(", ")}`);
        a.href = `${GPIO_SITE}?board=${encodeURIComponent(doc.id)}`;
        li.appendChild(a);
      } else {
        li.textContent = `${c.refdes} pin${c.pins.length > 1 ? "s" : ""} ${c.pins.join(", ")}`;
      }
      ul.appendChild(li);
    }
    if ((l.parts || []).length) ul.appendChild(make("li", null, `Parts: ${l.parts.join(", ")}`));
  }
  const p = make("p", "pw-sub");
  const a = make("a", null, "Find these parts on the board layout");
  a.href = `${LAYOUT_SITE}?board=${encodeURIComponent(doc.id)}`;
  p.appendChild(a);
  host.appendChild(p);
}

/** Close the detail and hand focus back to the card it was opened from. */
function closeDetail() {
  if (view.rail) view.lastRail = `rail-${view.rail}`;
  const back = view.lastRail;
  view.rail = null;
  render();
  const card = document.querySelector(`[data-focus="${CSS.escape(back)}"]`)
    || document.querySelector(`[data-focus="${CSS.escape(back.replace(/^rail-/, "row-"))}"]`);
  if (card) card.focus({ preventScroll: true });
}

// --- wiring ------------------------------------------------------------------

function bind() {
  el("view-tree").addEventListener("click", () => {
    view.view = "tree";
    if (doc) render();
  });
  el("view-rails").addEventListener("click", () => {
    view.view = "rails";
    if (doc) render();
  });
  el("search").addEventListener("input", (e) => {
    view.query = e.target.value;
    if (!doc) return;
    render();
    if (view.query.trim()) {
      const n = search(doc, view.query).length;
      announce(`${n} rail${n === 1 ? "" : "s"} match`);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (!doc || e.target.closest("input, select, textarea")) return;
    if (e.key === "ArrowRight") stepBy(1);
    else if (e.key === "ArrowLeft") stepBy(-1);
    else if (e.key === "Escape" && view.rail) closeDetail();
  });
  let t = null;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => doc && view.view === "tree" && paintTree(), 120);
  });
}

async function init() {
  mountShell();
  bind();
  try {
    const r = await fetch("data/boards.json");
    index = await r.json();
  } catch (e) {
    notice("Could not load the board index.");
    return;
  }
  buildSelect();
  const q = parseQuery(location.search);
  Object.assign(view, { walk: q.walk, step: q.step, rail: q.rail, view: q.view, reveal: Boolean(q.rail) });
  await chooseBoard(q.board || DEFAULT_BOARD, false);
}

if (typeof document !== "undefined") init();
