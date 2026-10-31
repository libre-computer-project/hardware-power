// Pure functions over one schema-2 board document. No DOM here, so
// tools/test-model.mjs can run every one of them under node.

export const STATUS_TEXT = { on: "On", off: "Off", x: "Not determined" };

const KIND_TEXT = {
  buck: "Buck regulator",
  ldo: "LDO regulator",
  switch: "Load switch",
  link: "Link",
  protection: "Input protection",
};

export function kindText(kind) {
  return KIND_TEXT[kind] || kind;
}

export function byId(list) {
  const map = new Map();
  for (const item of list || []) map.set(item.id, item);
  return map;
}

/** Depth of every rail from the board's inputs: an input is 0, a rail is one
 *  more than the deepest rail feeding it. A rail nothing on the board makes,
 *  that is not an input, is "untraced". A loop never raises a depth past the
 *  number of rails. */
export function railDepths(doc) {
  const rails = byId(doc.rails);
  const makers = byId(doc.makers);
  const depth = new Map();
  for (const r of doc.rails || []) if (r.input) depth.set(r.id, 0);
  const limit = (doc.rails || []).length;
  let changed = true;
  for (let pass = 0; changed && pass <= limit; pass++) {
    changed = false;
    for (const r of doc.rails || []) {
      if (r.input) continue;
      let best = -1;
      for (const mid of r.made_by || []) {
        const m = makers.get(mid);
        if (!m || !m.in || !depth.has(m.in)) continue;
        best = Math.max(best, Math.min(depth.get(m.in) + 1, limit));
      }
      if (best >= 0 && depth.get(r.id) !== best) {
        depth.set(r.id, best);
        changed = true;
      }
    }
  }
  const untraced = [...rails.keys()].filter((id) => !depth.has(id));
  return { depth, untraced };
}

/** Rails grouped into columns by depth, each column sorted by voltage
 *  (highest first) then name. Untraced rails are their own last column. */
export function columns(doc) {
  const { depth, untraced } = railDepths(doc);
  const rails = byId(doc.rails);
  const cols = [];
  for (const [id, d] of depth) {
    (cols[d] ||= []).push(rails.get(id));
  }
  const order = (a, b) => (b.v ?? -1) - (a.v ?? -1) || a.name.localeCompare(b.name);
  const out = cols.filter(Boolean).map((c, i) => ({ title: columnTitle(i), rails: c.sort(order) }));
  if (untraced.length) {
    out.push({ title: "Source not traced", rails: untraced.map((id) => rails.get(id)).sort(order) });
  }
  return out;
}

function columnTitle(i) {
  if (i === 0) return "Input";
  return ["First stage", "Second stage", "Third stage", "Fourth stage"][i - 1] || `Stage ${i}`;
}

/** The walk's steps, each with its state document. */
export function steps(doc, walkId) {
  const walk = (doc.walks || []).find((w) => w.id === walkId) || (doc.walks || [])[0];
  if (!walk) return [];
  const states = byId(doc.states);
  return walk.steps.map((s) => ({ ...s, rails: (states.get(s.state) || {}).rails || {} }));
}

/** 'on' | 'off' | 'x' for one rail in one step. A rail the state does not
 *  list is not determined, never assumed off. */
export function status(step, railId) {
  const s = step && step.rails ? step.rails[railId] : undefined;
  return s === "on" || s === "off" ? s : "x";
}

/** The voltage class the pinout site colours by. */
export function voltageClass(v) {
  if (v == null) return "unknown";
  if (v >= 9) return "power12v";
  if (v >= 4.5) return "power5v";
  if (v >= 2.5) return "power3v3";
  return "powerlv";
}

export function voltText(v) {
  if (v == null) return "";
  return `${Number.isInteger(v) ? v.toFixed(0) : v} V`;
}

/** One line saying what switches a maker. */
export function controlText(doc, maker) {
  if (maker.kind === "link") return "Always connected";
  if (maker.kind === "protection") return "Passes the input";
  if (!maker.control) return "No enable pin";
  const sig = (doc.signals || []).find((s) => s.id === maker.control);
  if (!sig) return "";
  const word = sig.role === "gate" ? "Gate" : "Enable";
  const rails = byId(doc.rails);
  const name = (id) => (rails.get(id) || {}).name || "a rail";
  const d = sig.driver || {};
  if (d.kind === "tie") {
    if (d.rail && d.rail === maker.in) return `${word} tied to its input`;
    return d.rail ? `${word} tied to ${name(d.rail)}` : `${word} tied on`;
  }
  if (d.kind === "pad") return `${word} from SoC ${d.pads.join(", ")}`;
  if (d.kind === "circuit") {
    return d.pads && d.pads.length
      ? `${word} through a transistor stage from SoC ${d.pads.join(", ")}`
      : `${word} through a transistor stage`;
  }
  if (d.kind === "pull") {
    if (d.dir === "up") return `${word} pulled up${d.to ? ` to ${name(d.to)}` : ""}`;
    if (d.dir === "down") return `${word} pulled down`;
    return `${word} set by a resistor divider`;
  }
  return "";
}

/** The rails each rail feeds, through any maker. */
export function children(doc) {
  const makers = byId(doc.makers);
  const out = new Map();
  for (const r of doc.rails || []) {
    for (const mid of r.made_by || []) {
      const m = makers.get(mid);
      if (!m || !m.in) continue;
      if (!out.has(m.in)) out.set(m.in, []);
      out.get(m.in).push({ rail: r.id, maker: m.id });
    }
  }
  return out;
}

/** Short load lines for a rail card. */
export function loadLines(rail) {
  const l = rail.loads || {};
  const lines = [];
  if (l.soc && l.soc.length) lines.push(`SoC ${l.soc.join(", ")}`);
  for (const c of l.connectors || []) {
    const pins = c.pins.length ? ` pin${c.pins.length > 1 ? "s" : ""} ${c.pins.join(", ")}` : "";
    lines.push(c.header40 ? `40-pin header${pins}` : `${c.refdes}${pins}`);
  }
  if (l.parts && l.parts.length) lines.push(l.parts.join(", "));
  return lines;
}

/** Rails, parts and pads matching a search term. */
export function search(doc, term) {
  const t = term.trim().toUpperCase();
  if (!t) return [];
  const makers = byId(doc.makers);
  const sigs = byId(doc.signals);
  const hits = [];
  for (const r of doc.rails || []) {
    const via = (r.made_by || []).map((m) => makers.get(m)).filter(Boolean);
    const pads = via.flatMap((m) => ((sigs.get(m.control) || {}).driver || {}).pads || []);
    const parts = [...via.map((m) => m.refdes), ...((r.loads || {}).parts || []),
      ...((r.loads || {}).connectors || []).map((c) => c.refdes)];
    const fields = [r.name, ...parts, ...pads, ...((r.loads || {}).soc || [])];
    if (fields.some((f) => f && f.toUpperCase().includes(t))) hits.push(r.id);
  }
  return hits;
}

/** Query string -> view state; anything missing or unknown is null. */
export function parseQuery(search) {
  const q = new URLSearchParams(search);
  const step = Number.parseInt(q.get("step") || "", 10);
  const view = q.get("view");
  return {
    board: q.get("board"),
    rail: q.get("rail"),
    walk: q.get("walk"),
    step: Number.isFinite(step) && step >= 0 ? step : null,
    view: view === "rails" ? "rails" : "tree",
  };
}

export function buildQuery({ board, walk, step, rail, view }) {
  const q = new URLSearchParams();
  if (board) q.set("board", board);
  if (walk) q.set("walk", walk);
  if (step != null) q.set("step", String(step));
  if (rail) q.set("rail", rail);
  if (view === "rails") q.set("view", "rails");
  return `?${q}`;
}
