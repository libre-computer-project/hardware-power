// node tools/test-model.mjs -- js/model.js against a fixture, then every
// committed schema-2 board file. Exit 1 on any failure.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQuery, children, columns, controlText, kindText, loadLines, parseQuery, railDepths,
  regulatorCount, related, search, status, steps, stopsAtReset, voltText, voltageClass,
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
eq("column titles", cols.map((c) => c.title), ["Input", "Level 1", "Level 2"]);
eq("untraced rails under the input", cols[0].more && cols[0].more.rails.map((r) => r.id), ["r-d"]);
eq("level 1 sorted by voltage then name", cols[1].rails.map((r) => r.name), ["VCC5V", "VCC3V3", "VDD_CORE"]);
eq("three level 1 rails keep their own column", cols[0].stack, null);
// one input feeding two rails: Level 1 stacks under the input, and Level 2
// becomes the second column
const lvl1 = cols[1].rails.map((r) => r.id);
const keep = lvl1.find((id) => id === "r-a") || lvl1[0];
const drop = new Set(lvl1.filter((id) => id !== keep).slice(1));
const two = { ...fx, rails: fx.rails.filter((r) => !drop.has(r.id)) };
const scols = columns(two);
eq("two level 1 rails stack under the input", scols[0].stack && scols[0].stack.title, "Level 1");
eq("and leave their column", scols.map((c) => c.title), ["Input", "Level 2"]);
eq("untraced rails still last in the first column", scols[0].more && scols[0].more.rails.map((r) => r.id), ["r-d"]);

// states: a rail the state does not list is not determined, never off
const st = steps(fx, "cold-boot");
eq("two steps", st.map((s) => s.label), ["Unplugged", "Plugged in, SoC in reset"]);
eq("on", status(st[1], "r-a"), "on");
eq("x", status(st[1], "r-c"), "x");
eq("listed off", status(st[1], "r-e"), "off");
eq("absent is x", status({ rails: {} }, "r-e"), "x");
eq("unknown walk falls back to the first", steps(fx, "nope").length, 2);
eq("a walk ending in reset stops at reset", stopsAtReset(st), true);
eq("a walk with a firmware step after reset does not",
  stopsAtReset([...st, { stage: "linux", label: "Linux running", rails: {} }]), false);
eq("no steps is not a stop", stopsAtReset([]), false);

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
eq("step 0 is not a step", parseQuery("?step=0").step, null);
eq("the URL counts from 1", parseQuery("?step=2").step, 1);
eq("and writes from 1", new URLSearchParams(buildQuery({ step: 0 })).get("step"), "1");
eq("link kinds", [kindText("link", "fuse"), kindText("link", "bead"), kindText("buck")],
  ["Fuse", "Ferrite bead", "Buck regulator"]);
eq("pad with its pull", controlText({ ...fx, signals: [{ id: "s", role: "enable",
  driver: { kind: "pad", pads: ["GPIODV_25"], dir: "up" } }] }, { kind: "buck", control: "s" }),
  "Enable from SoC GPIODV_25, pulled up");
eq("regulator count leaves out links and protection", regulatorCount(fx), 4);

// a selected rail keeps what it depends on and what depends on it
const sorted2 = (s) => [...s].sort();
eq("related to a middle rail: its source, its control's rail, what it feeds",
  sorted2(related(fx, "r-a")), ["r-a", "r-b", "r-in"]);
eq("related to a leaf: the chain up to the input", sorted2(related(fx, "r-b")), ["r-a", "r-b", "r-in"]);
eq("related to the input: everything it feeds", sorted2(related(fx, "r-in")), ["r-a", "r-b", "r-c", "r-e", "r-in"]);
eq("an untraced rail relates only to itself", sorted2(related(fx, "r-d")), ["r-d"]);
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
