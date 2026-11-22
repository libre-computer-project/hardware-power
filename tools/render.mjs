#!/usr/bin/env node
/** Writes each board's own page and what a crawler looks for, from the
 * published data, so a reader that runs no JavaScript (GPTBot, ClaudeBot, a
 * link preview) gets the power tree in words:
 *
 *   <id>/index.html    index.html with the board's rails (js/text.js), its
 *                      title, description and canonical, and data-board;
 *                      the tool opens on that board on top of them
 *   index.html         its canonical
 *   robots.txt, sitemap.xml, llms.txt
 *
 *     node tools/render.mjs
 *
 * Boards: those listed without ?hidden=1 that have a power model
 * (js/text.js pagedBoards). Run after the data changes and commit what it
 * writes (README "Board pages"); tools/check-site.py fails a stale or stray
 * page.
 */
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://power.hardware.libre.computer";
const { pagedBoards, railsHtml } = await import(pathToFileURL(path.join(ROOT, "js/text.js")).href);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const read = (f) => readFile(path.join(ROOT, f), "utf8");
const json = async (f) => JSON.parse(await read(f));
const meta = (html, re) => (html.match(re) || [, ""])[1];

function canonical(html, url) {
  const tag = `<link rel="canonical" href="${esc(url)}">`;
  return /<link rel="canonical"[^>]*>/.test(html)
    ? html.replace(/<link rel="canonical"[^>]*>/, tag)
    : html.replace(/(<meta name="description"[^>]*>)/, `$1\n${tag}`);
}

const index = await json("data/boards.json");
const boards = pagedBoards(index);
let home = canonical(await read("index.html"), `${ORIGIN}/`);
await writeFile(path.join(ROOT, "index.html"), home);
const desc = meta(home, /<meta name="description" content="([^"]*)"/);
const siteTitle = meta(home, /<title>([^<]*)<\/title>/);

for (const b of boards) {
  const doc = await json(`data/${b.id}.json`);
  const name = b.model ? `${b.name} (${b.model})` : b.name;
  const html = canonical(home, `${ORIGIN}/${b.id}/`)
    // a directory down: the page's own files from the site root
    .replace(/(href|src)="(css|js)\//g, '$1="/$2/')
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(`${name}: power tree — Libre Computer`)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(`${name}: ${desc}`)}"`)
    .replace(/<body([^>]*)>/, `<body$1 data-board="${esc(b.id)}">`)
    .replace(/(<div id="rails" hidden><\/div>)/, `$1\n${railsHtml(doc, b)}`);
  await mkdir(path.join(ROOT, b.id), { recursive: true });
  await writeFile(path.join(ROOT, b.id, "index.html"), html);
}
// a board that lost its page: its directory goes (only pages this wrote)
for (const d of await readdir(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory() || boards.some((b) => b.id === d.name)) continue;
  const f = path.join(ROOT, d.name, "index.html");
  if ((await readFile(f, "utf8").catch(() => "")).includes(" data-board=")) await rm(path.dirname(f), { recursive: true });
}

const urls = [`${ORIGIN}/`, ...boards.map((b) => `${ORIGIN}/${b.id}/`)];
await writeFile(path.join(ROOT, "robots.txt"), `User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
await writeFile(path.join(ROOT, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join("\n")}\n</urlset>\n`);
await writeFile(path.join(ROOT, "llms.txt"), [
  `# ${siteTitle.replace(/ — Libre Computer$/, "")}`, "",
  `> ${desc}`, "",
  "Part of Libre Computer (https://libre.computer/llms.txt). Each board's page lists its power rails as HTML: voltage, what makes each rail and how it is switched, and what it feeds.", "",
  "## Boards", "",
  ...boards.map((b) => `- [${b.model ? `${b.name} ${b.model}` : b.name}](${ORIGIN}/${b.id}/)`), "",
].join("\n"));
console.log(`rendered ${boards.length} board pages, robots.txt, sitemap.xml, llms.txt`);
