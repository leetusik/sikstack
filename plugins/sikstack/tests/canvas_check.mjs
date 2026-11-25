// The canvas folder's check: run it over the folder the orchestrator wrote by hand from canvas.mjs's plan, before
// publishing the artboards after Main.dc.html. It only reads.
//   node "${CLAUDE_PLUGIN_ROOT}/tests/canvas_check.mjs" <root>     (the folder holding project/)
// Prints "canvas ok N" (N artboards), or each problem and exits 1.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) { console.log("usage: node canvas_check.mjs <root holding project/>"); process.exit(2); }
const problems = [];
const bad = (m) => problems.push(m);
const proj = path.join(root, "project");
let canvas, files;
try {
  canvas = JSON.parse(readFileSync(path.join(proj, "canvas.json"), "utf8"));
  files = readdirSync(proj).filter((f) => f.endsWith(".dc.html"));
} catch (e) {
  console.log(`cannot read ${proj}/canvas.json: ${e.message}`);
  process.exit(1);
}
const VOID = new Set(["meta", "img", "br", "hr", "input", "link", "source", "area", "base", "col", "embed", "track", "wbr"]);

if (canvas.v !== 3 || canvas.createdOnFiles?.v !== 1 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(canvas.createdOnFiles?.at ?? "")) bad("the index header (v 3, createdOnFiles {v 1, at now})");
if (canvas.launch?.view !== "canvas" || typeof canvas.title !== "string" || !canvas.title) bad("launch or title");
const boards = canvas.boards ?? {}, order = canvas.order ?? [], keys = Object.keys(boards);
if (keys.length !== order.length || [...new Set(order)].sort().join() !== [...keys].sort().join()) bad("boards and order name different files");
for (const f of keys) if (!files.includes(f)) bad(`missing file: project/${f}`);
for (const f of files) if (!(f in boards)) bad(`a file boards does not name: project/${f}`);
if (order[0] !== "Main.dc.html") bad(`the first artboard is ${order[0]}, not Main.dc.html`);
const pages = (canvas.pages ?? []).map((p) => p.id);
if (pages.length > 40 || pages.some((id) => !/^[A-Za-z0-9_-]{1,40}$/.test(id))) bad("pages");
if (pages.length && boards["Main.dc.html"] && boards["Main.dc.html"].page !== pages[0]) bad("Main.dc.html is not on the first page");
for (const [name, b] of Object.entries(boards)) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.dc\.html$/.test(name)) bad(`path rule: ${name}`);
  for (const k of ["w", "h"]) if (!(Number.isInteger(b[k]) && b[k] >= 40 && b[k] <= 8000)) bad(`${name}: ${k}=${b[k]} outside 40-8000`);
  if (pages.length ? !pages.includes(b.page) : b.page !== undefined) bad(`${name}: page ${b.page}`);
  let html;
  try { html = readFileSync(path.join(proj, name), "utf8"); } catch { continue; }
  const head = html.slice(0, html.indexOf("</head>"));
  if (!head.split("\n").includes('<script src="./support.js"></script>')) bad(`${name}: the support.js head line`);
  if (!/<body>\n<x-dc>\n<helmet>\n<style>\nbody\{margin:0\}\n/.test(html) || !html.includes("</x-dc>")) bad(`${name}: <x-dc> and <helmet>`);
  const stack = [];
  for (const m of html.replace(/<script type="text\/x-dc"[^>]*>[\s\S]*?<\/script>/, "<script></script>").matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, tag0, attrs] = m, tag = tag0.toLowerCase();
    if (/=[^"'\s]/.test(attrs)) bad(`${name}: unquoted attribute in <${tag}>`);
    if (VOID.has(tag)) continue;
    if (!close) stack.push(tag);
    else if (stack.pop() !== tag) bad(`${name}: </${tag}> closes the wrong element`);
  }
  if (stack.length) bad(`${name}: unclosed ${stack.join(",")}`);
  const dc = html.match(/<script type="text\/x-dc" data-dc-script data-props='([^']*)'>\n([\s\S]*?)<\/script>/);
  if (!dc) bad(`${name}: no data-dc-script block`);
  else {
    let props = {};
    try { props = JSON.parse(dc[1]); } catch { bad(`${name}: data-props is not JSON`); }
    if (props.$preview?.width !== b.w || props.$preview?.height !== b.h) bad(`${name}: $preview ${dc[1]} is not the frame ${b.w}x${b.h}`);
    if (!/class Component extends DCLogic \{\s*renderVals\(\) \{/.test(dc[2])) bad(`${name}: no DCLogic component`);
  }
  if (!html.includes(`width: ${b.w}px; height: ${b.h}px`)) bad(`${name}: root not fixed at the frame ${b.w}x${b.h}`);
  const imgs = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  if (!imgs.length) bad(`${name}: no <img>`);
  for (const img of imgs) {
    const src = img.match(/ src="([^"]*)"/)?.[1] ?? "";
    if (!/^\/_blob\/[^\s"'<>]+$/.test(src)) bad(`${name}: <img src="${src}"> is not a /_blob/ url`);
    if (!/ alt="[^"]+"/.test(img)) bad(`${name}: an <img> without alt`);
  }
  if (html.includes("@@shot:")) bad(`${name}: a placeholder is left`);
  if (/<iframe|<object|<embed|data:/.test(html)) bad(`${name}: an iframe, object, embed or data: url`);
}
const all = Object.entries(boards);
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
  const [na, a] = all[i], [nb, b] = all[j];
  if (a.page === b.page && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad(`frames overlap: ${na} ${nb}`);
}
if (problems.length) { console.log(problems.slice(0, 30).join("\n") + (problems.length > 30 ? `\n… ${problems.length - 30} more` : "")); process.exit(1); }
console.log(`canvas ok ${keys.length}`);
