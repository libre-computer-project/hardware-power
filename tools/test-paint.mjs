import { readFileSync } from "node:fs";

import {
  RAIL_COLUMNS,
  FILE_NOTICE,
  NO_ENABLE_DETAIL,
  badgeText,
  boardNotice,
  defaultOpen,
  draw,
  railTable,
  seriesBadge,
  unresolvedLine,
} from "../js/app.js";

const root = new URL(".", import.meta.url);
const source = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");

function load(rel) {
  return JSON.parse(readFileSync(new URL(rel, root), "utf8"));
}

const discrete = load("./fixtures/discrete.json");
const hybrid = load("./fixtures/hybrid.json");
const pmic = load("./fixtures/pmic.json");
const index = load("../data/boards.json");

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS ${name}`);
    return;
  }
  failures += 1;
  console.log(`FAIL ${name}${detail ? " " + detail : ""}`);
}

function same(name, got, want) {
  const left = typeof got === "string" ? got : JSON.stringify(got);
  const right = typeof want === "string" ? want : JSON.stringify(want);
  check(name, left === right, `got ${left} want ${right}`);
}

function sortedOpen(graph) {
  return [...defaultOpen(graph)].sort();
}

const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
check("file notice is in the page", page.includes(FILE_NOTICE));
check("page has no innerHTML", !page.includes("innerHTML"));
check("app.js has no innerHTML", !source.includes("innerHTML"));
check("app.js does not reimplement classifyNet", !source.includes("function classifyNet"));
check("app.js does not say always-on", !/always-on|always on/i.test(source));

same("rail columns", RAIL_COLUMNS, ["Rail", "Group", "From", "EN", "PWM", "PG", "Series parts", "Loads"]);

same("two fuses", seriesBadge([
  { kind: "protection", refdes: "6F1", value: "FUSE-1A", footprint: "PPTC_FUSE" },
  { kind: "protection", refdes: "6F2", value: "FUSE-500mA", footprint: "FUSE" },
]), "2 fuses");
same("one fuse", seriesBadge([
  { kind: "protection", refdes: "1F1", value: "FUSE-2.5A", footprint: "FUSE" },
]), "FUSE-2.5A");
same("one bead", seriesBadge([
  { kind: "protection", refdes: "6FB1", value: "600R@100MHZ", footprint: "FB0603" },
]), "600R@100MHZ");
same("two beads", seriesBadge([
  { kind: "protection", refdes: "FB1", value: "220R", footprint: "FERRITE_BEAD" },
  { kind: "protection", refdes: "FB2", value: "600R", footprint: "FB0603" },
]), "2 beads");
same("inductor excluded", seriesBadge([
  { kind: "protection", refdes: "L2", value: "2.2uH_2A", footprint: "FB0603" },
]), "");
same("fuse before bead", seriesBadge([
  { kind: "protection", refdes: "6F1", value: "FUSE-1A", footprint: "FUSE" },
  { kind: "protection", refdes: "6FB1", value: "600R@100MHZ", footprint: "FB0603" },
]), "FUSE-1A");

const discreteOpen = sortedOpen(discrete);
same("discrete open", discreteOpen, ["n-1f1", "n-1u1", "n-1u3", "n-vcck", "n-vdd-ee"]);
for (const id of ["n-1u2", "n-6f1", "n-6fb1", "n-6j2", "n-usbhost-a-5v", "n-vcc1-8v", "n-load-soc", "n-load-ddr", "n-load-io", "n-load-usb"]) {
  check(`discrete closed ${id}`, !discreteOpen.includes(id));
}
const discreteDrawn = draw(discrete, defaultOpen(discrete));
check("discrete has no frame", discreteDrawn.frame === null && discreteDrawn.hasPmic === false);
check("discrete has no external column", discreteDrawn.external.length === 0);
const columnIds = discreteDrawn.columns.map((row) => row.id);
check("discrete column includes closed fuse", columnIds.includes("n-6f1"));
check("discrete column omits usb rail", !columnIds.includes("n-usbhost-a-5v"));
const memberOnly = {
  schema: 1,
  nodes: [
    { id: "n-1j1", kind: "connector", refdes: "1J1", group: "input" },
    { id: "n-5v-in", kind: "rail", name: "5V_IN", group: "input" },
  ],
  edges: [
    { src: "n-1j1", dst: "n-5v-in", role: "member", net: "5V_IN", provenance: "connector-pin", controls: [] },
  ],
  unresolved: [],
};
const memberDrawn = draw(memberOnly, defaultOpen(memberOnly));
const memberRail = memberDrawn.columns.find((row) => row.id === "n-5v-in");
check("member-only rail stays visible", Boolean(memberRail) && memberRail.members.join(",") === "1J1");
check("discrete column omits loads", discreteDrawn.columns.every((row) => row.kind !== "load" && row.kind !== "connector"));
same("discrete 1u2 badge", badgeText(discrete, "n-1u2", defaultOpen(discrete)), "1 load · 600R@100MHZ · VCC1_8V_EN");

const discreteRows = railTable(discrete);
const vcck = discreteRows.find((row) => row.Rail === "VCCK");
const usb = discreteRows.find((row) => row.Rail === "USBHOST_A_5V");
same("vcck from", vcck && vcck.From, "1U1");
same("vcck pwm", vcck && vcck.PWM, "VCCK_PWM_D");
same("vcck loads", vcck && vcck.Loads, "2");
same("usb series", usb && usb["Series parts"], "FUSE-1A");
same("usb loads", usb && usb.Loads, "1");
check("member edge is not a load", usb && usb.Loads === "1");

const hybridOpen = sortedOpen(hybrid);
same("hybrid open", hybridOpen, ["n-cn1", "n-power-3v3", "n-u1", "n-u2001", "n-vad-5v"]);
for (const id of ["n-ch-dvdd-core", "n-ch-dvdd-sram-core", "n-ch-emi-vdd2", "n-load-wifi"]) {
  check(`hybrid closed ${id}`, !hybridOpen.includes(id));
}
const hybridDrawn = draw(hybrid, defaultOpen(hybrid));
check("hybrid one frame", hybridDrawn.hasPmic === true && hybridDrawn.frame.length === 1 && hybridDrawn.frame[0].refdes === "U2001");
check("hybrid groups collapsed", hybridDrawn.frame[0].groups.every((group) => group.open === false));
same("hybrid external", hybridDrawn.external.map((row) => row.refdes), ["U1"]);
same("hybrid unresolved", unresolvedLine(hybrid), "1 parts have no pin list, so they are not drawn as feeding anything.");
const coreGroup = hybridDrawn.frame[0].groups.find((group) => group.group === "cores");
const sramGroup = hybridDrawn.frame[0].groups.find((group) => group.group === "sram");
check("hybrid cores have an enable", coreGroup && coreGroup.enables.includes("EXT_PMIC_EN1") && coreGroup.detail === "");
same("hybrid sram detail", sramGroup && sramGroup.detail, NO_ENABLE_DETAIL);
const coreRow = railTable(hybrid).find((row) => row.Rail === "DVDD_CORE");
same("channel from", coreRow && coreRow.From, "U2001 channel");
same("channel en", coreRow && coreRow.EN, "EXT_PMIC_EN1");

const hybridClone = structuredClone(hybrid);
hybridClone.shape = "discrete";
const hybridCloneDrawn = draw(hybridClone, defaultOpen(hybridClone));
same("shape ignored hybrid open", sortedOpen(hybridClone), hybridOpen);
check("shape ignored hybrid frame", hybridCloneDrawn.hasPmic === true && hybridCloneDrawn.frame.length === 1 && hybridCloneDrawn.external.length === 1);

const pmicOpen = sortedOpen(pmic);
const pmicDrawn = draw(pmic, defaultOpen(pmic));
check("pmic frame", pmicDrawn.hasPmic === true && pmicDrawn.frame.length === 1 && pmicDrawn.frame[0].refdes === "U2001");
same("pmic external", pmicDrawn.external, []);
check("pmic groups collapsed", pmicDrawn.frame[0].groups.every((group) => group.open === false));
check("pmic no enable detail", pmicDrawn.frame[0].groups.every((group) => group.detail === NO_ENABLE_DETAIL));
const pmicClone = structuredClone(pmic);
pmicClone.shape = "discrete";
const pmicCloneDrawn = draw(pmicClone, defaultOpen(pmicClone));
same("shape ignored pmic open", sortedOpen(pmicClone), pmicOpen);
check("shape ignored pmic frame", pmicCloneDrawn.hasPmic === true && pmicCloneDrawn.external.length === 0 && pmicCloneDrawn.frame !== null);

for (const raw of ["<script>", "not a board!", "Alta", "../etc"]) {
  const notice = boardNotice(raw, index, false);
  same(`illegal ${raw}`, notice, "No board is selected.");
  check(`illegal hides ${raw}`, typeof notice === "string" && !notice.includes(raw));
}
const pin = index.pinout_only.find((row) => row.id === "roc-rk3399-pc");
same("pinout notice", boardNotice("roc-rk3399-pc", index, false), pin.reason);
check("pinout notice has no pmic", !/pmic/i.test(boardNotice("roc-rk3399-pc", index, false)));
same("hidden notice", boardNotice("aml-a311d-cc", index, false), "aml-a311d-cc is not listed publicly.");
same("missing notice", boardNotice("no-such-board", index, false), "No board no-such-board.");
same("empty notice", boardNotice("", index, false), null);

console.log("PRIMARY reading tree");
console.log("PRIMARY discrete-open " + discreteOpen.join(","));
console.log("PRIMARY discrete-badge-1u2 " + badgeText(discrete, "n-1u2", defaultOpen(discrete)));
console.log("PRIMARY discrete-usb " + (usb ? `${usb["Series parts"]}|${usb.Loads}` : ""));
console.log("PRIMARY discrete-vcck " + (vcck ? `${vcck.From}|${vcck.PWM}|${vcck.Loads}` : ""));
console.log("PRIMARY hybrid-open " + hybridOpen.join(","));
console.log("PRIMARY hybrid-frame " + hybridDrawn.frame.map((frame) => frame.refdes).join(","));
console.log("PRIMARY hybrid-external " + hybridDrawn.external.map((row) => row.refdes).join(","));
console.log("PRIMARY hybrid-channel " + (coreRow ? `${coreRow.Rail}|${coreRow.From}|${coreRow.EN}` : ""));
console.log("PRIMARY pmic-external " + pmicDrawn.external.length);
console.log("PRIMARY pmic-frame " + pmicDrawn.frame.map((frame) => frame.refdes).join(","));
console.log("PRIMARY columns " + RAIL_COLUMNS.join("|"));
console.log("PRIMARY no-enable " + NO_ENABLE_DETAIL);

if (failures) {
  console.log(`FAIL ${failures}`);
  process.exit(1);
}
console.log("PASS");
