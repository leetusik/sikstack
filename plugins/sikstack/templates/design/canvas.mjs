#!/usr/bin/env node
// The canvas copy: shoots a served design build and writes a PLAN for a claude.ai Design canvas. The plan gives one
// artboard per page and state, holding its 1440 and 390 shots side by side. The design folder stays the source; the
// canvas is a copy of its screens for teammates to comment on. This script never writes the canvas's files and never
// publishes. The Artifact tool takes canvas files only when the session writes them with its own file tool, so the
// orchestrator copies each artboard's text from the plan, by design-cowork's reference/claude-canvas.md. Run it as
// node "${CLAUDE_PLUGIN_ROOT}/templates/design/canvas.mjs", beside check.mjs, whose walk it imports.
//
// Shoot (needs playwright-cli and the build served):
//   every page of --manifest (or the --pages named), every state, every width, each in a fresh browser context;
//   the page must show the state its run names (as the layout check confirms it), else that run FAILs (exit 1)
//   and no plan is written; the design-only state widget ([data-design-states]) is hidden; every lazy image and
//   iframe is loaded and every image decoded, as a teammate scrolling the page would see them; when the page holds
//   a fixed element (a modal's backdrop), the window takes the page's height so the element spans the shot (a page
//   that grows with the window is shot at its first measure); a full-page screenshot goes to <out>/shots/, cut at
//   7968 px (the canvas's 8000 px frame limit less the artboard's 32 px caption) and counted.
// --plan-only <shots dir> shoots nothing: it reads the PNG sizes of shots already taken (named as the shoot names
// them) and pairs them with the manifest's pages and states (a page the manifest lists no states for has only its
// default run).
// Either way it writes <out>/plan.json:
//   canvas     the index to copy into project/canvas.json (set createdOnFiles.at when you write it)
//   artboards  per artboard: file, title and the whole .dc.html text, one @@shot:<file>@@ placeholder per image,
//              for the upload's /_blob/ url; the first is Main.dc.html
//   uploads    the shots in batches of at most 25 files and 15 MB
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DriverError, READ_STATE, discoverStep, makeDriver, pagesFromManifest, plan } from "./check.mjs";

export const USAGE = `usage: node canvas.mjs --base <url> --manifest <out/manifest.json> --out <dir> [--pages <name,name>] [--widths <w,w>] [--title <text>] [--format png|jpeg]
       node canvas.mjs --plan-only <shots dir> --manifest <out/manifest.json> --out <dir> [--pages …] [--widths …] [--title …]
  --base       the server the build is served on, e.g. http://127.0.0.1:3042
  --manifest   the build's manifest; its pages are shot
  --out        the folder for shots/ and plan.json
  --pages      only these pages, by their manifest names (default: all)
  --widths     comma-separated widths, side by side in each artboard (default: 1440,390)
  --title      the canvas's title (default: Design screens)
  --format     png (default) or jpeg (quality 85), for a build whose PNG total passes about 120 MB
  --plan-only  shoot nothing: plan from the PNG shots already in this folder
Each run opens in a fresh browser context; a page with a state widget must show the state its run names.
exit 0: plan.json is written, one summary line
exit 1: a run's page did not show its state, one FAIL line each; no plan is written
exit 2: a usage error, a shot missing for --plan-only, or a driver error ("driver error: ...")`;

export const MAX_H = 8000; // the canvas's frame limit
export const ENTRY = "Main.dc.html"; // the canvas's entry: its first artboard
const GAP_X = 80, GAP_Y = 120, CAPTION = 32; // between shots in an artboard; between artboards; a shot's caption
export const SHOT_MAX = MAX_H - CAPTION; // a shot is cut here, so its artboard (caption and shot) holds it whole
const PAGES_MAX = 40; // a canvas holds at most 40 pages
const BATCH_FILES = 25, BATCH_BYTES = 15 << 20;

const slug = (s, n = 40) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, n).replace(/-$/, "") || "x";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");

/** The shots to take, from check.mjs's run plan: one per step, named for its page, state and width. A default run
 * is named for the state it must show (its expect), a page with no states "default". Pure. */
export function shotList(steps, ext = "png") {
  const pageIndex = new Map(), stems = new Set();
  return steps.map((s) => {
    if (!pageIndex.has(s.page)) pageIndex.set(s.page, pageIndex.size);
    const pi = pageIndex.get(s.page), state = s.state ?? s.expect ?? "default";
    let stem = `p${String(pi + 1).padStart(2, "0")}-${slug(s.name, 32)}--${slug(state, 32)}--w${s.width}`;
    for (let k = 2; stems.has(stem); k++) stem = stem.replace(/(-\d+)?$/, `-${k}`); // stems stay unique
    stems.add(stem);
    return { step: s, page: s.name, pageIndex: pi, state, width: s.width, file: `shots/${stem}.${ext}`,
      placeholder: `@@shot:${stem}.${ext}@@`, alt: `${s.name}, state ${state}, at ${s.width} px wide` };
  });
}

/** One artboard: the Design type's skeleton, a root fixed at w×h holding the shots side by side, top-aligned, each
 * under a caption naming its width. A shot taller than the room under its caption is clipped there. Pure. */
export function artboardHtml(board) {
  const { w, h, title, shots } = board;
  const cols = shots.map((s) => `<div style="width: ${s.width}px; flex: none">
<p style="margin: 0; height: ${CAPTION}px; font: 500 14px/${CAPTION}px system-ui, sans-serif; color: #3d3d3d">${s.width} px</p>
<img src="${s.placeholder}" alt="${esc(s.alt)}" width="${s.width}" height="${s.h}" style="display: block; width: ${s.width}px; height: ${s.h}px">
</div>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{margin:0}
</style>
</helmet>
<div style="width: ${w}px; height: ${h}px; overflow: hidden; background: #ffffff; display: flex; align-items: flex-start; gap: ${GAP_X}px">
${cols}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${w},"height":${h}}}'>
class Component extends DCLogic {
renderVals() {
return {};
}
}
</script>
</body>
</html>
`;
}

/** The plan, from shots with their sizes (w = width, h, bytes): one artboard per page and state, its widths side by
 * side in the order taken; one canvas page per design page while there are 40 or fewer (else none); the artboards
 * of a canvas page stacked 120 px apart; the first artboard Main.dc.html. Pure. */
export function planCanvas(shots, { title }) {
  const designPages = [...new Map(shots.map((s) => [s.pageIndex, s.page])).entries()].sort((a, b) => a[0] - b[0]);
  const paged = designPages.length <= PAGES_MAX;
  const pages = paged ? designPages.map(([i, name]) => ({ id: `p${String(i + 1).padStart(2, "0")}-${slug(name, 32)}`, name })) : [];
  const pageId = new Map(paged ? designPages.map(([i], k) => [i, pages[k].id]) : []);
  const groups = new Map();
  for (const s of shots) {
    const key = `${s.pageIndex}\u0000${s.state}`;
    if (!groups.has(key)) groups.set(key, { pageIndex: s.pageIndex, page: s.page, state: s.state, shots: [] });
    groups.get(key).shots.push(s);
  }
  const boards = {}, order = [], artboards = [], tops = new Map(), stems = new Set();
  for (const g of groups.values()) {
    let stem = `p${String(g.pageIndex + 1).padStart(2, "0")}-${slug(g.page, 32)}--${slug(g.state, 32)}`;
    for (let k = 2; stems.has(stem); k++) stem = stem.replace(/(-\d+)?$/, `-${k}`);
    stems.add(stem);
    const file = artboards.length === 0 ? ENTRY : `${stem}.dc.html`;
    const w = Math.max(40, Math.min(MAX_H, g.shots.reduce((a, s) => a + s.w, 0) + GAP_X * (g.shots.length - 1)));
    const h = Math.max(40, Math.min(MAX_H, CAPTION + Math.max(...g.shots.map((s) => s.h))));
    const cp = paged ? pageId.get(g.pageIndex) : "";
    const y = tops.get(cp) ?? 0;
    const board = { file, title: `${g.page} · ${g.state}`, w, h, shots: g.shots };
    boards[file] = { x: 0, y, w, h, title: board.title, ...(paged ? { page: cp } : {}) };
    order.push(file);
    artboards.push({ file, title: board.title, w, h, shots: g.shots.map((s) => path.basename(s.file)), html: artboardHtml(board) });
    tops.set(cp, y + h + GAP_Y);
  }
  const canvas = { v: 3, createdOnFiles: { v: 1, at: null }, title, launch: { view: "canvas" }, pages, boards, order, designSystems: [] };
  return { canvas, artboards, uploads: batches(shots) };
}

/** Upload batches: shots in order, at most 25 files and 15 MB a call. */
export function batches(shots) {
  const out = [];
  let cur = [], bytes = 0;
  for (const s of shots) {
    if (cur.length && (cur.length >= BATCH_FILES || bytes + s.bytes > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(s.file); bytes += s.bytes;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** A PNG's size from its IHDR chunk, or null. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const RUN = String.raw`async sessionPage => {
  const C = __CFG__;
  __READ_STATE__
  const browser = sessionPage.context().browser();
  if (!browser) throw new Error("the session's browser cannot open a fresh context (a persistent profile?)");
  const ctx = await browser.newContext({ viewport: { width: C.width, height: C.vh } });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(C.url, { waitUntil: "networkidle", timeout: 30000 });
    if (!resp || !page.url().startsWith("http")) throw new Error("did not load " + C.url + " (at " + page.url() + ")");
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(250);
    const { states, shows, widget } = await readState(page, C);
    if (C.discover) return JSON.stringify({ states, shows, widget });
    if (C.expect !== null && shows !== C.expect) return JSON.stringify({ mismatch: true, shows, widget });
    await page.addStyleTag({ content: "[data-design-states]{display:none !important}" });
    // Load what a teammate scrolling the page would load: every lazy image and iframe now, each image decoded, and
    // the network quiet again (at most 15 s).
    const inflight = new Set();
    let last = Date.now();
    page.on("request", (r) => { inflight.add(r); last = Date.now(); });
    const done = (r) => { inflight.delete(r); last = Date.now(); };
    page.on("requestfinished", done); page.on("requestfailed", done);
    const settle = async () => { const t0 = Date.now(); while (Date.now() - t0 < 15000 && (inflight.size || Date.now() - last < 300)) await page.waitForTimeout(50); };
    await page.evaluate(() => { for (const el of document.querySelectorAll("img[loading=lazy], iframe[loading=lazy]")) el.loading = "eager"; });
    await settle();
    await page.evaluate(() => Promise.race([Promise.all([...document.images].map((i) => i.decode().catch(() => null))), new Promise((r) => setTimeout(r, 10000))]));
    await page.waitForTimeout(150);
    const measure = () => page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight));
    const full = await measure();
    const h = Math.max(40, Math.min(full, C.maxH));
    // A fixed element (a modal's backdrop, a bottom bar) is drawn over the window only, so the window takes the
    // shot's height when the page holds one. A page whose height tracks the window (100vh under a header) grows
    // with it; it is still shot at its first measure, which is what it held before the window grew.
    const fixed = await page.evaluate(() => [...document.querySelectorAll("body *")].some((el) => {
      if (getComputedStyle(el).position !== "fixed") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }));
    let grown = null;
    if (fixed && h > C.vh) {
      await page.setViewportSize({ width: C.width, height: h });
      await settle();
      await page.waitForTimeout(150);
      const again = await measure();
      if (again > full) grown = again;
    }
    await page.screenshot({ path: C.file, fullPage: true, clip: { x: 0, y: 0, width: C.width, height: h }, type: C.type, ...(C.type === "jpeg" ? { quality: 85 } : {}) });
    return JSON.stringify({ shows, widget, w: C.width, h, full, cut: full > C.maxH, fixed, grown });
  } finally {
    await ctx.close();
  }
}`.replace("__READ_STATE__", () => READ_STATE);

const mb = (b) => (b / (1 << 20)).toFixed(1) + " MB";

function main(argv) {
  const args = argv.slice(0);
  if (args.includes("--help") || args.includes("-h")) { console.log(USAGE); return 0; }
  const opt = (name, fallback = null) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const usage = (msg) => { console.error(`canvas: ${msg}`); return 2; };
  const planOnly = opt("--plan-only"), outArg = opt("--out"), base = opt("--base"), manifestPath = opt("--manifest");
  const only = opt("--pages"), title = opt("--title", "Design screens"), format = opt("--format", "png");
  const widths = (opt("--widths", "1440,390") ?? "").split(",").map(Number).filter((n) => n > 0);
  if (args.length) return usage(`unexpected ${args[0]}\n${USAGE}`);
  if (!outArg) return usage(`--out is required\n${USAGE}`);
  const out = path.resolve(outArg);
  if (!manifestPath) return usage(`--manifest is required\n${USAGE}`);
  if (!planOnly && !base) return usage(`--base is required to shoot (or --plan-only <shots dir>)\n${USAGE}`);
  if (!planOnly && !/^https?:\/\//.test(base)) return usage(`--base must be an http(s) server (playwright-cli blocks file:); serve the folder first`);
  if (!widths.length) return usage(`--widths takes comma-separated widths, e.g. 1440,390`);
  if (format !== "png" && format !== "jpeg") return usage(`--format is png or jpeg`);
  let pages;
  try { pages = pagesFromManifest(JSON.parse(readFileSync(manifestPath, "utf8"))); } catch (e) { return usage(`cannot read the manifest ${manifestPath}: ${e.message}`); }
  if (only) {
    const names = only.split(",").map((s) => s.trim()).filter(Boolean);
    const missing = names.filter((n) => !pages.some((p) => p.name === n));
    if (missing.length) return usage(`no page named ${missing.join(", ")} in the manifest`);
    pages = pages.filter((p) => names.includes(p.name));
  }
  if (!pages.length) return usage("the manifest lists no pages");
  const shots = [];

  if (planOnly) {
    const dir = path.resolve(planOnly);
    for (const p of pages) if (p.states === null) p.states = [];
    for (const s of shotList(plan(pages, widths, base ?? "http://127.0.0.1"), "png")) {
      const f = path.join(dir, path.basename(s.file));
      let buf;
      try { buf = readFileSync(f); } catch { return usage(`no shot ${f}: shoot first (a page whose states the manifest leaves out has only its default here)`); }
      const size = pngSize(buf);
      if (!size) return usage(`not a PNG: ${f}`);
      delete s.step;
      shots.push({ ...s, file: path.relative(out, f).split(path.sep).join("/"), w: size.w, h: size.h, cut: size.h >= SHOT_MAX, bytes: buf.length });
    }
  } else {
    const session = `design-canvas-${process.pid}`;
    const scratch = mkdtempSync(path.join(tmpdir(), "design-canvas-"));
    const { cli, firstLines, runCode } = makeDriver(session, scratch);
    rmSync(path.join(out, "shots"), { recursive: true, force: true });
    mkdirSync(path.join(out, "shots"), { recursive: true });
    rmSync(path.join(out, "plan.json"), { force: true });
    const run = (step, file) => runCode(RUN.replace("__CFG__", JSON.stringify({ url: step.url, width: step.width, expect: step.expect,
      discover: !!step.discover, file, type: format, maxH: SHOT_MAX, vh: step.width < 600 ? 844 : 900 })), `${step.url} w=${step.width}${step.state ? ` state=${step.state}` : ""}`);
    let driverErr = null;
    const fails = [];
    try {
      const opened = cli("open", "about:blank");
      if (opened.status !== 0) throw new DriverError(`playwright-cli open failed: ${firstLines(opened)}`);
      for (const p of pages) if (p.states === null) { const f = run(discoverStep(p, widths[0], base), null); p.states = f.widget ? f.states : []; }
      for (const s of shotList(plan(pages, widths, base), format === "jpeg" ? "jpg" : "png")) {
        const r = run(s.step, path.join(out, s.file));
        if (r.mismatch) { fails.push(`FAIL state ${s.step.page} w=${s.width}${s.step.state === null ? "" : ` state=${s.step.state}`} :: ${r.widget ? "shows " + (r.shows ?? "no marked state") : "has no state widget"}, not ${s.step.expect}`); continue; }
        delete s.step;
        shots.push({ ...s, w: r.w, h: r.h, cut: r.cut, bytes: statSync(path.join(out, s.file)).size });
      }
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
      driverErr = e;
    } finally {
      cli("close");
      rmSync(scratch, { recursive: true, force: true });
    }
    if (driverErr) { console.error(`driver error: ${driverErr.message}`); console.error("canvas: stopped at the driver error; no plan was written (exit 2)"); return 2; }
    if (fails.length) { for (const f of fails) console.log(f); console.error(`canvas: ${fails.length} run(s) did not show their state; no plan was written (exit 1)`); return 1; }
  }

  mkdirSync(out, { recursive: true });
  const p = planCanvas(shots, { title });
  writeFileSync(path.join(out, "plan.json"), JSON.stringify(p, null, 1) + "\n");
  const shotBytes = shots.reduce((a, s) => a + s.bytes, 0);
  const htmlBytes = p.artboards.reduce((a, b) => a + Buffer.byteLength(b.html), 0) + Buffer.byteLength(JSON.stringify(p.canvas));
  const files = shots.length + p.artboards.length + 1;
  const biggest = shots.reduce((a, s) => (s.bytes > a.bytes ? s : a), shots[0]);
  console.log(`artboards=${p.artboards.length} shots=${shots.length} pages=${pages.length} widths=${widths.join(",")} cut=${shots.filter((s) => s.cut).length} bytes=${shotBytes + htmlBytes} out=${out}`);
  console.log(`  shots ${mb(shotBytes)} (largest ${biggest.file}, ${mb(biggest.bytes)}, ${biggest.w}x${biggest.h}); ${files} files to the canvas; ${p.uploads.length} upload batch(es); plan.json`);
  if (p.artboards.length > 250) console.log(`warning: ${p.artboards.length} artboards; one publish holds 255 files: shoot fewer pages (--pages)`);
  if (files > 512) console.log(`warning: ${files} files pass a canvas's 512 (the type's own files count too)`);
  if (shotBytes + htmlBytes > 256 << 20) console.log(`warning: ${mb(shotBytes + htmlBytes)} passes a canvas's 256 MB`);
  if (format === "png" && shotBytes > 120 << 20) console.log(`warning: the PNG shots total ${mb(shotBytes)}, over about 120 MB: shoot again with --format jpeg`);
  for (const s of shots) if (s.bytes > 16 << 20) console.log(`warning: ${s.file} is ${mb(s.bytes)}, over one upload call's 16 MB`);
  return 0;
}

// Run only as the entry script; an import (the smoke's plan test) runs nothing.
const entry = () => {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1] || process.execArgv.some((a) => a === "-e" || a === "--eval" || a === "-p" || a === "--print")) return false;
  try {
    return realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (entry()) process.exitCode = main(process.argv.slice(2));
