// node tools/test-model.mjs -- js/model.js against a fixture, then every
// committed schema-2 board file. Exit 1 on any failure.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQuery, children, columns, controlText, loadLines, parseQuery, railDepths, search,
  status, steps, voltText, voltageClass,
} from "../js/model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fails = [];
const eq = (name, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fails.push(`${name}: got ${g}, want ${w}`);
};

const fx = JSON.parse(readFileSync(join(root, "tools/fixtures/model.json"), "utf8"));

// depths and columns
const { depth, untraced } = railDepths(fx);
eq("input depth", depth.get("r-in"), 0);
eq("first stage", depth.get("r-a"), 1);
eq("second stage", depth.get("r-b"), 2);
eq("untraced rail", untraced, ["r-d"]);
const cols = columns(fx);
eq("column titles", cols.map((c) => c.title), ["Input", "First stage", "Second stage", "Source not traced"]);
eq("first column sorted by voltage then name", cols[1].rails.map((r) => r.name), ["VCC5V", "VCC3V3", "VDD_CORE"]);

// states: a rail the state does not list is not determined, never off
const st = steps(fx, "cold-boot");
eq("two steps", st.map((s) => s.label), ["Unplugged", "Plugged in, SoC in reset"]);
eq("on", status(st[1], "r-a"), "on");
eq("x", status(st[1], "r-c"), "x");
eq("listed off", status(st[1], "r-e"), "off");
eq("absent is x", status({ rails: {} }, "r-e"), "x");
eq("unknown walk falls back to the first", steps(fx, "nope").length, 2);

// words
const m = Object.fromEntries(fx.makers.map((x) => [x.id, x]));
eq("pull text", controlText(fx, m["m-u1"]), "Enable pulled up to VIN_5V");
eq("tie text", controlText(fx, m["m-u2"]), "Enable tied to its input");
eq("pad text", controlText(fx, m["m-u3"]), "Enable from SoC GPIOAO_4");
eq("circuit text", controlText(fx, m["m-q1"]), "Gate through a transistor stage");
eq("loads", loadLines(fx.rails[1]), ["SoC VDDIO_AO", "40-pin header pins 1, 17", "U9"]);
eq("voltage class 5", voltageClass(5), "power5v");
eq("voltage class 1.8", voltageClass(1.8), "powerlv");
eq("voltage class none", voltageClass(null), "unknown");
eq("volt text", [voltText(5), voltText(3.3), voltText(null)], ["5 V", "3.3 V", ""]);
eq("children of the input", (children(fx).get("r-in") || []).map((c) => c.rail).sort(), ["r-a", "r-c", "r-e"]);

// search: rail name, maker, SoC pad, SoC ball
eq("search rail", search(fx, "1v8"), ["r-b"]);
eq("search maker", search(fx, "u3"), ["r-c"]);
eq("search pad", search(fx, "gpioao_4"), ["r-c"]);
eq("search ball", search(fx, "vddee"), ["r-c"]);
eq("search empty", search(fx, "  "), []);

// query round trip
const q = { board: "aml-s905x-cc-v2", walk: "cold-boot", step: 1, rail: "r-a", view: "rails" };
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
eq("query round trip", sorted(parseQuery(buildQuery(q))), sorted(q));
eq("bad step", parseQuery("?step=-3").step, null);
eq("default view", parseQuery("").view, "tree");

// every committed schema-2 board: references resolve, states are complete
let boards = 0;
for (const f of readdirSync(join(root, "data"))) {
  if (f === "boards.json" || !f.endsWith(".json")) continue;
  const d = JSON.parse(readFileSync(join(root, "data", f), "utf8"));
  if (d.schema !== 2) continue;
  boards++;
  const rails = new Set(d.rails.map((r) => r.id));
  const makers = new Set(d.makers.map((x) => x.id));
  const sigs = new Set(d.signals.map((s) => s.id));
  const states = new Set(d.states.map((s) => s.id));
  for (const r of d.rails) for (const mm of r.made_by) if (!makers.has(mm)) fails.push(`${f}: ${r.id} made by unknown ${mm}`);
  for (const x of d.makers) {
    if (x.in && !rails.has(x.in)) fails.push(`${f}: ${x.id} input ${x.in} unknown`);
    if (!rails.has(x.out)) fails.push(`${f}: ${x.id} output ${x.out} unknown`);
    if (x.control && !sigs.has(x.control)) fails.push(`${f}: ${x.id} control ${x.control} unknown`);
  }
  for (const w of d.walks) for (const s of w.steps) if (!states.has(s.state)) fails.push(`${f}: step ${s.stage} state unknown`);
  for (const s of d.states) {
    for (const r of rails) if (!["on", "off", "x"].includes(s.rails[r])) fails.push(`${f}: ${s.id} ${r} = ${s.rails[r]}`);
  }
  if (!columns(d).length) fails.push(`${f}: no columns`);
}

for (const f of fails) console.log(`FAIL ${f}`);
console.log(`test-model: ${fails.length ? "FAIL" : "PASS"} (${fails.length} failing; ${boards} board files checked)`);
process.exit(fails.length ? 1 : 0);
