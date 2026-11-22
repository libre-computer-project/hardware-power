// A board's power rails as plain HTML: what tools/render.mjs puts in each
// board's own page (/<id>/), so a reader or crawler that runs no JavaScript
// gets the tree in words. Pure, from js/model.js's wording; no DOM.

import { byId, controlText, kindText, loadLines, voltText } from "./model.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ESC[c]);

/** The boards that get a page: listed without ?hidden=1, with a power model. */
export function pagedBoards(index) {
  return (index.boards || []).filter((b) => !b.hidden && b.coverage === "model");
}

/** One row per rail: its voltage, where power enters or what makes it (and
 *  from which rail, switched how), and what it feeds. */
export function railsHtml(doc, row) {
  const rails = byId(doc.rails);
  const makers = byId(doc.makers);
  const fedBy = (r) => {
    if (r.input) return `Board input (${esc(r.input)})`;
    const ms = (r.made_by || []).map((id) => makers.get(id)).filter(Boolean);
    if (!ms.length) return "Source not traced";
    return ms.map((m) => {
      const from = m.in && rails.get(m.in) ? ` from ${esc(rails.get(m.in).name)}` : "";
      const ctl = controlText(doc, m);
      return `${esc(m.refdes)} (${esc(kindText(m.kind, m.link))}${from})${ctl ? `; ${esc(ctl)}` : ""}`;
    }).join("<br>");
  };
  const rows = [...doc.rails]
    .sort((a, b) => (b.v ?? -1) - (a.v ?? -1) || a.name.localeCompare(b.name))
    .map((r) => `<tr><th scope="row"><code>${esc(r.name)}</code></th>
      <td>${esc(voltText(r.v)) || "Not stated"}</td>
      <td>${fedBy(r)}</td>
      <td>${loadLines(r).map(esc).join("<br>") || "—"}</td></tr>`).join("");
  const title = row.model ? `${row.name} (${row.model})` : row.name;
  const source = doc.tier === "transcribed"
    ? "read off the board's published schematic"
    : "traced from the board's layout netlist";
  return `
    <section class="pw-text" aria-labelledby="pw-text-h">
      <h2 id="pw-text-h">${esc(title)}: power rails</h2>
      <p>${doc.rails.length} rails and ${(doc.makers || []).length} parts that make or pass them,
        ${source}. Each rail's voltage is the nominal its name states.</p>
      <div class="lc-table-scroll"><table class="lc-table">
        <thead><tr><th scope="col">Rail</th><th scope="col">Voltage</th>
          <th scope="col">Fed by</th><th scope="col">Feeds</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
}
