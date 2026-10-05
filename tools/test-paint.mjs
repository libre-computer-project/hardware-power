import { readFileSync } from "node:fs";

import {
  RAIL_COLUMNS,
  FILE_NOTICE,
  NO_ENABLE_DETAIL,
  NO_FEED_NOTICE,
  SEARCH_PLACEHOLDER,
  badgeText,
  boardNotice,
  domainOf,
  draw,
  feedNotice,
  permalinkState,
  defaultOpen,
  railTable,
  searchReport,
  seriesBadge,
  stageForHit,
  unresolvedLine,
  visibleWhen,
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
const regulator = discreteDrawn.columns.find((row) => row.id === "n-1u1");
check(
  "discrete regulator child",
  Boolean(regulator) && regulator.open === true && (regulator.children || []).some((child) => child.id === "n-vcck"),
);
same("discrete fixture has a feed", feedNotice(discrete), "");
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
same("hybrid unresolved", unresolvedLine(hybrid), "1 part, U3, has no pin list, so it is not drawn as feeding anything.");
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
same("alta notice", boardNotice("aml-a311d-cc", index, false), null);
same("unreleased stays out", boardNotice("aml-s905x-cc-v3", index, true), "No board aml-s905x-cc-v3.");
same("missing notice", boardNotice("no-such-board", index, false), "No board no-such-board.");
same("empty notice", boardNotice("", index, false), null);
same(
  "public names",
  index.boards.filter((row) => row.hidden !== true).map((row) => row.name),
  ["Sweet Potato", "La Frite", "Alta", "Solitude"],
);
check("html placeholder", page.includes(`placeholder="${SEARCH_PLACEHOLDER}"`));
same("other domain", domainOf("other"), "other");

const alta = load("../data/aml-a311d-cc.json");
const kept = permalinkState({
  wanted: "aml-a311d-cc",
  rail: "5V_IN",
  showHidden: false,
  index,
  graph: alta,
});
same("permalink keeps rail", kept.rail, "5V_IN");
same("permalink url", kept.url, "?board=aml-a311d-cc&rail=5V_IN");
same("permalink reading", kept.reading, "rails");
check("permalink selects the rail", kept.selected === true);
same("permalink listed notice", kept.pinnedNotice, "");
same("permalink has no rail notice", kept.railNotice, "");

const early = permalinkState({
  wanted: "aml-a311d-cc",
  rail: "5V_IN",
  showHidden: false,
  index,
  graph: null,
});
same("permalink keeps rail before the graph loads", early.rail, "5V_IN");
same("permalink url before the graph loads", early.url, "?board=aml-a311d-cc&rail=5V_IN");
check("permalink does not select before the graph loads", early.selected === false);

const missingRail = permalinkState({
  wanted: "aml-a311d-cc",
  rail: "NOT_A_RAIL",
  showHidden: false,
  index,
  graph: alta,
});
same("unknown rail stays in the url", missingRail.rail, "NOT_A_RAIL");
same("unknown rail url", missingRail.url, "?board=aml-a311d-cc&rail=NOT_A_RAIL");
same("unknown rail notice", missingRail.railNotice, "No rail NOT_A_RAIL.");
same("unknown rail keeps the tree", missingRail.reading, "tree");
check("unknown rail is not a selection", missingRail.selected === false);

const otherBoard = permalinkState({
  wanted: "no-such-board",
  rail: "5V_IN",
  showHidden: false,
  index,
  graph: alta,
});
same("different board drops the rail", otherBoard.rail, "");
same("different board url", otherBoard.url, "?board=aml-a311d-cc");
same("different board notice", otherBoard.pinnedNotice, "No board no-such-board.");

const sweet = load("../data/aml-s905x-cc-v2.json");
const solitude = load("../data/aml-s905d3-cc.json");
const frite = load("../data/aml-s805x-ac.json");
same("alta no feed", feedNotice(alta), NO_FEED_NOTICE);
same("sweet no feed", feedNotice(sweet), NO_FEED_NOTICE);
same("solitude no feed", feedNotice(solitude), NO_FEED_NOTICE);
same("la frite reason", frite.reason, "Mechanical model: placement and values, zero nets.");
same("la frite has no feed notice", feedNotice(frite), "");
check("alta has no pin-join", !(alta.edges || []).some((edge) => edge.provenance === "pin-join" && edge.role === "out"));
check("sweet has no pin-join", !(sweet.edges || []).some((edge) => edge.provenance === "pin-join" && edge.role === "out"));
check("solitude has no pin-join", !(solitude.edges || []).some((edge) => edge.provenance === "pin-join" && edge.role === "out"));
const altaDrawn = draw(alta, defaultOpen(alta));
same("alta feed on the drawing", altaDrawn.feed, NO_FEED_NOTICE);
check("alta tree has no fed child", altaDrawn.columns.every((row) => !(row.children || []).length));
check("alta names unresolved refdes", unresolvedLine(alta).includes(", 1U1,"));
const hiddenOther = new Set(["other"]);
for (const name of ["VCC3_3V", "VCC5V", "VDDAO_3_3V"]) {
  const row = railTable(alta).find((item) => item.Rail === name);
  check(`${name} group other`, Boolean(row) && row.Group === "other");
  check(`${name} leaves when other is off`, Boolean(row) && visibleWhen(hiddenOther, row.Group) === false);
  check(`${name} returns when other is on`, Boolean(row) && visibleWhen(new Set(), row.Group) === true);
}
const railHit = searchReport(alta, "5V_IN");
const railStage = stageForHit((railHit.hits || []).find((hit) => hit.rail === "5V_IN"));
check("5V_IN is a hit", railHit.miss === "" && railStage.reading === "rails" && railStage.rail === "5V_IN");
const partHit = (searchReport(alta, "1U1").hits || []).find((hit) => hit.part === "1U1" && hit.rail === "");
same("1U1 stage", stageForHit(partHit), { reading: "tree", rail: "", part: "1U1", openId: "" });
same("foreign name", searchReport(alta, "U2001").miss, "U2001 is not on this board.");

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
console.log("PRIMARY permalink " + kept.url + " " + kept.reading + " " + kept.selected);
console.log("PRIMARY unknown-rail " + missingRail.url + " " + missingRail.railNotice);

if (failures) {
  console.log(`FAIL ${failures}`);
  process.exit(1);
}
console.log("PASS");
