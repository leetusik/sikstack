#!/usr/bin/env node
// The layout check: drives playwright-cli over a design build's pages and reports ONLY failures, each with a
// cropped screenshot. A clean build prints one `ok` line. It ships only here, in the plugin; run it as
// node "${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs", or copy it into a product's design folder. It is not a
// product's production-exclusion check (platform's `pnpm --dir web design:check` proves production holds none of
// the design; it measures no page).
//
// What fails, at 1440 and 390 px wide, on every page and every state the page lists:
//   console    a console error or an uncaught page error
//   request    a failed request, or a response of 400 or more
//   overflow   the page scrolls sideways; the crop is the element that sticks out
//   clipped    an element's own text cut off by overflow hidden or clip (an ellipsis or a line clamp is fine)
//   overlap    two controls that overlap, or a control another element covers
//   target     a control under 24 x 24 px with less than 24 px of room around it (WCAG 2.5.8; inline text links
//              in a sentence are exempt)
//   state      the page does not show the state its run names (below); that run is not measured
// A control is measured where it shows: cut by every scroll or clip box around it, so a row scrolled out of a
// capped table is neither overlapping nor a target. Each crop outlines what failed (both elements of an overlap,
// red then blue) and keeps context around it: 48 px each side, at least 360 x 220, clamped to the page.
// The design-only state widget ([data-design-states]) is never measured.
//
// Pages: the build's out/manifest.json (each pages[].entry; --all-entries adds pages[].entries and presetItems),
// else the URLs given. States: a page's manifest `states` (keys, or {key}), else the keys its state widget lists
// ([data-design-state]); each opens as ?state=<key>. The default run is the page with no state; it must show the
// first listed state.
//
// Every run (one page, at one width, in one state) opens in a fresh browser context: empty localStorage,
// sessionStorage, cookies and cache, so no run sees what an earlier one stored. A page with a state widget must show
// the state its run names: the widget's data-design-current, else the pressed state in its list.
//
// --shots <dir> also saves what a person sees, for the design critic to open: every measured run's page in
// viewport-height tiles from the top (at most 12 a run), <page>-w<width>-<state>-t<n>.png. Without it, none.
//
// Needs playwright-cli (npm install -g @playwright/cli@0.1.25) and a server already serving the build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const USAGE = `usage: node check.mjs --base <url> [--manifest <out/manifest.json>] [--all-entries] [--widths <w,w>] [--out <dir>] [--shots <dir>] [<url-or-path> ...]
  --base         the server the build is served on, e.g. http://127.0.0.1:3042 (paths are joined to it)
  --manifest     the build's manifest; its pages are checked (default: none, the URLs given)
  --all-entries  also check each page's other entries (pages[].entries, presetItems)
  --widths       comma-separated widths (default: 1440,390)
  --out          the folder for the cropped screenshots (default: ./design-check)
  --shots        also save every measured run as viewport-height tiles in this folder (default: none)
Each run opens in a fresh browser context (empty storage); a page with a state widget must show the state its run names.
exit 0: nothing failed, one ok line
exit 1: layout failures, one FAIL line each (console, request, overflow, clipped, overlap, target, state)
exit 2: a usage error, or a driver error (no server, a playwright-cli failure, the check's page script failing),
        printed as "driver error: ..."; nothing after it is checked`;

/** The pages to check, from a build manifest: each page's entry (and, with allEntries, its other entries),
 * with its listed state keys, or null when the manifest lists none (the state widget is read instead). */
export function pagesFromManifest(manifest, allEntries = false) {
  const pages = [];
  for (const p of manifest.pages ?? []) {
    const urls = [p.entry, ...(allEntries ? [...(p.entries ?? []), ...(p.presetItems ?? [])] : [])].filter(Boolean);
    const states = Array.isArray(p.states) ? p.states.map((s) => (typeof s === "string" ? s : s && s.key)).filter(Boolean) : null;
    for (const u of [...new Set(urls)]) pages.push({ name: p.name ?? u, url: u, states });
  }
  return pages;
}

/** A page's state run's address: ?state=<key> joined to the page, the default (null) the page itself. */
export function stateUrl(url, base, state) {
  const u = new URL(url, base);
  if (state !== null) u.searchParams.set("state", state);
  return u.href;
}

/** The run plan: every page (its states known: a list, empty when it has no widget) at every width, the default
 * first (the page with no state, which must show the first listed state), then each other state. Every step opens
 * in a fresh browser context, so nothing one run stores reaches the next. Pure: no browser, no file. */
export function plan(pages, widths, base) {
  const steps = [];
  for (const p of pages) {
    const states = p.states ?? [];
    for (const width of widths) {
      steps.push({ page: p.url, name: p.name, url: stateUrl(p.url, base, null), width, state: null, expect: states[0] ?? null, fresh: true });
      for (const s of states.slice(1)) steps.push({ page: p.url, name: p.name, url: stateUrl(p.url, base, s), width, state: s, expect: s, fresh: true });
    }
  }
  return steps;
}

/** The discovery run for a page the manifest lists no states for: its state widget's keys, read at one width. */
export function discoverStep(p, width, base) {
  return { page: p.url, name: p.name, url: stateUrl(p.url, base, null), width, state: null, expect: null, fresh: true, discover: true };
}

export class DriverError extends Error {}

/** The page-side state reading, shared with canvas.mjs: defines `readState(page, C)`, which returns
 * { states, shows, widget }: the keys the state widget lists (read when C.discover or no mark), the state on screen
 * (the widget's data-design-current, else the pressed state), and whether the page has a widget. */
export const READ_STATE = String.raw`const readState = async (page, C) => {
    let states = [], shows = null;
    // The state on screen: the widget's mark, given a moment to settle on the state the run names.
    const pill = page.locator("[data-design-states] > button[aria-expanded]");
    const widget = (await page.locator("[data-design-states]").count()) > 0;
    if (widget && C.expect !== null)
      await page.waitForFunction((k) => { const v = document.querySelector("[data-design-states]").getAttribute("data-design-current"); return v === null || v === k; }, C.expect, { timeout: 3000 }).catch(() => {});
    if (widget) shows = await page.locator("[data-design-states]").first().getAttribute("data-design-current");
    if (widget && (C.discover || shows === null) && (await pill.count())) {
      await pill.first().click();
      const listed = await page.locator("[data-design-state]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-design-state"), e.getAttribute("aria-pressed")]));
      states = listed.map((s) => s[0]);
      if (shows === null) shows = (listed.find((s) => s[1] === "true") || [null])[0];
      await page.keyboard.press("Escape");
      await page.waitForTimeout(100);
    }
    return { states, shows, widget };
  };`;

/** The playwright-cli driver, shared with canvas.mjs: one named session, run-code from a file in `scratch`.
 * runCode(source, at) runs one page-side script and returns its parsed JSON answer; a failure is a DriverError. */
export function makeDriver(session, scratch) {
  const cli = (...a) => spawnSync("playwright-cli", [`-s=${session}`, ...a], { encoding: "utf8", cwd: scratch, maxBuffer: 64 << 20 });
  const firstLines = (r) => `${r.error ? r.error.message : ""} ${r.stdout ?? ""} ${r.stderr ?? ""}`.trim().split("\n").slice(0, 3).join(" ");
  const runCode = (source, at) => {
    const file = path.join(scratch, "run.js");
    writeFileSync(file, source);
    const r = cli("--raw", "run-code", `--filename=${file}`);
    if (r.status !== 0) throw new DriverError(`${at} :: ${firstLines(r)}`);
    try {
      let v = JSON.parse(r.stdout.trim());
      if (typeof v === "string") v = JSON.parse(v);
      return v;
    } catch {
      throw new DriverError(`${at} :: the page script answered no result: ${firstLines(r)}`);
    }
  };
  return { cli, firstLines, runCode };
}

// The page-side run: one playwright-cli run-code call per step, in a fresh browser context it opens and closes.
// It returns { failures: [...], states: [...], shows, widget }.
const RUN = String.raw`async sessionPage => {
  __READ_STATE__
  const C = __CFG__;
  const browser = sessionPage.context().browser();
  if (!browser) throw new Error("the session's browser cannot open a fresh context (a persistent profile?)");
  const ctx = C.fresh ? await browser.newContext({ viewport: { width: C.width, height: C.width < 600 ? 844 : 900 } }) : sessionPage.context();
  const page = C.fresh ? await ctx.newPage() : sessionPage;
  const failures = [];
  // A failed load is reported once, as its request; its console twin ("Failed to load resource") is dropped.
  const onConsole = (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) failures.push({ kind: "console", detail: m.text().slice(0, 300) }); };
  const onError = (e) => failures.push({ kind: "console", detail: ("uncaught " + (e && e.message || e)).slice(0, 300) });
  const onFailed = (r) => failures.push({ kind: "request", detail: (r.failure() ? r.failure().errorText : "failed") + " " + r.url() });
  const onResponse = (r) => { if (r.status() >= 400) failures.push({ kind: "request", detail: r.status() + " " + r.url() }); };
  page.on("console", onConsole); page.on("pageerror", onError); page.on("requestfailed", onFailed); page.on("response", onResponse);
  let states = [], shows = null, widget = false, tiles = 0;
  try {
    if (!C.fresh) await page.setViewportSize({ width: C.width, height: C.width < 600 ? 844 : 900 });
    const resp = await page.goto(C.url, { waitUntil: "networkidle", timeout: 30000 });
    if (!resp || !page.url().startsWith("http")) throw new Error("did not load " + C.url + " (at " + page.url() + ")");
    if (resp.status() >= 400) failures.push({ kind: "request", detail: resp.status() + " " + C.url });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(250);
    ({ states, shows, widget } = await readState(page, C));
    if (C.discover) return JSON.stringify({ failures: [], states, shows, widget });
    if (C.expect !== null && shows !== C.expect) {
      const png = C.shot + "-state.png";
      await page.screenshot({ path: png });
      return JSON.stringify({ failures: [{ kind: "state", detail: (widget ? "shows " + (shows === null ? "no marked state" : shows) : "has no state widget") + ", not " + C.expect + "; not measured", png }], states, shows, widget, mismatch: true });
    }
    const found = await page.evaluate(() => {
      const W = innerWidth, out = [];
      const skip = (el) => !!el.closest("[data-design-states]");
      const visible = (el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0 && r.width > 1 && r.height > 1;
      };
      const box = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
      const label = (el) => {
        const t = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
        return el.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 50) + '"' : "");
      };
      const all = [...document.body.querySelectorAll("*")].filter((el) => !skip(el));
      // overflow: the page scrolls sideways; name the leaf-most elements that stick out
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
        const clipsX = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o !== "visible") return true; } return false; };
        const wide = all.filter((el) => { const r = el.getBoundingClientRect(); return visible(el) && (r.right > W + 1 || r.left < -1) && !clipsX(el); });
        const leaves = wide.filter((el) => !wide.some((o) => o !== el && el.contains(o))).slice(0, 3);
        for (const el of leaves) out.push({ kind: "overflow", detail: label(el) + " reaches " + Math.round(el.getBoundingClientRect().right) + "px of " + W, marks: [box(el.getBoundingClientRect())] });
        if (!leaves.length) out.push({ kind: "overflow", detail: "the page is " + document.documentElement.scrollWidth + "px wide at " + W, marks: null });
      }
      // clipped: an element's own text cut off by its own overflow
      for (const el of all) {
        if (!visible(el) || el.clientWidth <= 1) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const s = getComputedStyle(el);
        if (s.clip !== "auto" && s.clip !== "" || s.clipPath !== "none") continue;
        const cutX = /hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== "ellipsis";
        const cutY = /hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1 && s.webkitLineClamp === "none" && s.textOverflow !== "ellipsis";
        if (cutX || cutY) out.push({ kind: "clipped", detail: label(el) + " shows " + el.clientWidth + "x" + el.clientHeight + " of " + el.scrollWidth + "x" + el.scrollHeight, marks: [box(el.getBoundingClientRect())] });
      }
      // controls: overlap, cover, and target size
      const CTRL = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[tabindex]:not([tabindex^='-'])";
      // the part of an element that shows: its box cut by each ancestor that scrolls or clips (a fixed element by none)
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        let l = r.left, t = r.top, rt = r.right, b = r.bottom;
        if (getComputedStyle(el).position !== "fixed") for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX === "visible" && s.overflowY === "visible") continue;
          const ar = a.getBoundingClientRect(), x0 = ar.left + a.clientLeft, y0 = ar.top + a.clientTop;
          if (s.overflowX !== "visible") { l = Math.max(l, x0); rt = Math.min(rt, x0 + a.clientWidth); }
          if (s.overflowY !== "visible") { t = Math.max(t, y0); b = Math.min(b, y0 + a.clientHeight); }
          if (s.position === "fixed") break;
        }
        return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
      };
      const cands = [...document.body.querySelectorAll(CTRL)].filter((el) => !skip(el) && visible(el) && !el.disabled);
      const cut = cands.map(shown);
      // a control scrolled out of its box (or under 2 px of it showing) is not on screen: skip it
      const ctrls = cands.filter((_, i) => cut[i].width > 2 && cut[i].height > 2);
      const rects = cut.filter((r) => r.width > 2 && r.height > 2);
      const whole = ctrls.map((el) => el.getBoundingClientRect());
      const hit = (a, b, pad = 0) => a.left - pad < b.right && b.left < a.right + pad && a.top - pad < b.bottom && b.top < a.bottom + pad;
      for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
        const a = rects[i], b = rects[j];
        if (ctrls[i].contains(ctrls[j]) || ctrls[j].contains(ctrls[i])) continue;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2) out.push({ kind: "overlap", detail: label(ctrls[i]) + " overlaps " + label(ctrls[j]) + " by " + Math.round(w) + "x" + Math.round(h) + "px",
          marks: [box(a), box(b)] });
      }
      ctrls.forEach((el, i) => {
        const r = rects[i], cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
        const top = document.elementFromPoint(cx, cy);
        if (!top || el.contains(top) || top.contains(el) || skip(top) || (top.tagName === "LABEL" && top.control === el)) return;
        out.push({ kind: "overlap", detail: label(el) + " is covered by " + label(top), marks: [box(r), box(top.getBoundingClientRect())] });
      });
      ctrls.forEach((el, i) => {
        const r = whole[i];
        if (r.width >= 24 && r.height >= 24) return;
        if (el.tagName === "A" && getComputedStyle(el).display === "inline" && (el.parentElement.textContent || "").trim().length > (el.textContent || "").trim().length) return;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const room = { left: cx - 12, right: cx + 12, top: cy - 12, bottom: cy + 12 };
        const near = rects.findIndex((o, j) => j !== i && !ctrls[j].contains(el) && !el.contains(ctrls[j]) && hit(room, o));
        if (near < 0) return;
        out.push({ kind: "target", detail: label(el) + " is " + Math.round(r.width) + "x" + Math.round(r.height) + "px with " + label(ctrls[near]) + " within 24px", marks: [box(r), box(rects[near])] });
      });
      return out;
    });
    failures.push(...found);
    // --shots: the page as a person scrolls it, one viewport-height tile at a time, taken after measuring
    if (C.tiles) {
      const vh = await page.evaluate(() => innerHeight), full = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let k = 0; k < 12 && (k === 0 || k * vh < full); k++) {
        await page.evaluate((y) => scrollTo(0, y), Math.min(k * vh, Math.max(0, full - vh)));
        await page.waitForTimeout(80);
        await page.screenshot({ path: C.tiles + "-t" + (k + 1) + ".png" });
        tiles += 1;
      }
      await page.evaluate(() => scrollTo(0, 0));
    }
    let n = 0;
    for (const f of failures) {
      n += 1;
      f.png = C.shot + "-" + f.kind + "-" + n + ".png";
      const page_w = await page.evaluate(() => document.documentElement.scrollWidth), page_h = await page.evaluate(() => document.documentElement.scrollHeight);
      if (f.marks && f.marks.length) {
        // the crop: the marks' union, 48 px of context each side, grown to 360 x 220 about its centre, kept on the page
        const x0 = Math.min(...f.marks.map((b) => b.x)), y0 = Math.min(...f.marks.map((b) => b.y));
        const x1 = Math.max(...f.marks.map((b) => b.x + b.w)), y1 = Math.max(...f.marks.map((b) => b.y + b.h));
        const span = (lo, hi, min, max, limit) => {
          let a = lo - 48, b = hi + 48;
          if (b - a < min) { const c = (lo + hi) / 2; a = c - min / 2; b = c + min / 2; }
          if (b - a > max) b = a + max;
          if (a < 0) { b -= a; a = 0; }
          if (b > limit) { a = Math.max(0, a - (b - limit)); b = limit; }
          return [a, Math.max(8, b - a)];
        };
        const [x, width] = span(x0, x1, 360, 1600, page_w), [y, height] = span(y0, y1, 220, 1200, page_h);
        // outline each mark (red, then blue) above the page, without moving anything
        await page.evaluate((marks) => marks.forEach((b, k) => {
          const d = document.createElement("div");
          d.setAttribute("data-design-check-mark", "");
          d.style.cssText = "position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;left:" + (b.x - 2) + "px;top:" + (b.y - 2) + "px;width:" + (b.w + 4) + "px;height:" + (b.h + 4) + "px;border:2px " + (k ? "dashed #2563eb" : "solid #dc2626");
          document.documentElement.appendChild(d);
        }), f.marks);
        await page.screenshot({ path: f.png, fullPage: true, clip: { x, y, width, height } });
        await page.evaluate(() => document.querySelectorAll("[data-design-check-mark]").forEach((d) => d.remove()));
      } else {
        await page.screenshot({ path: f.png });
      }
      delete f.marks;
    }
  } finally {
    page.off("console", onConsole); page.off("pageerror", onError); page.off("requestfailed", onFailed); page.off("response", onResponse);
    if (C.fresh) await ctx.close();
  }
  return JSON.stringify({ failures, states, shows, widget, tiles });
}`.replace("__READ_STATE__", () => READ_STATE);

const slug = (s) => s.replace(/^https?:\/\/[^/]+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60) || "root";

function main(argv) {
  const args = argv.slice(0);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const opt = (name, fallback = null) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const usage = (msg) => {
    console.error(`layout check: ${msg}`);
    return 2;
  };
  const base = opt("--base");
  const manifestPath = opt("--manifest");
  const out = path.resolve(opt("--out", "design-check"));
  const widths = (opt("--widths", "1440,390") ?? "").split(",").map(Number).filter((n) => n > 0);
  const allEntries = flag("--all-entries");
  const shotsArg = opt("--shots");
  const shots = shotsArg ? path.resolve(shotsArg) : null;
  if (!base) return usage(`--base is required\n${USAGE}`);
  if (!/^https?:\/\//.test(base)) return usage(`--base must be an http(s) server (playwright-cli blocks file:); serve the folder first`);
  if (args.some((a) => a.startsWith("--"))) return usage(`unknown option ${args.find((a) => a.startsWith("--"))}\n${USAGE}`);
  if (!widths.length) return usage(`--widths takes comma-separated widths, e.g. 1440,390`);

  let pages = [];
  if (manifestPath) {
    let m;
    try {
      m = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      return usage(`cannot read the manifest ${manifestPath}: ${e.message}`);
    }
    pages = pagesFromManifest(m, allEntries);
  }
  for (const u of args) pages.push({ name: u, url: u, states: null });
  if (!pages.length) return usage("no pages: give --manifest or one or more URLs");

  const session = `design-check-${process.pid}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "design-check-"));
  mkdirSync(out, { recursive: true });
  if (shots) mkdirSync(shots, { recursive: true });
  const { cli, firstLines, runCode } = makeDriver(session, scratch);
  const exec = (step, shot, tiles = null) => {
    const cfg = { url: step.url, width: step.width, fresh: step.fresh, expect: step.expect, discover: !!step.discover, shot, tiles };
    return runCode(RUN.replace("__CFG__", JSON.stringify(cfg)), `${step.url} w=${step.width}${step.state ? ` state=${step.state}` : ""}`);
  };

  let failures = 0, stateCount = 0, driver = null, tileCount = 0;
  // The same failure on the same page in several states or widths is one line: the first crop, then where else.
  const seen = new Map();
  const report = (page, where, f) => {
    failures += 1;
    const key = `${f.kind}|${page}|${f.detail.replace(/\d+px of \d+/, "")}`;
    if (seen.has(key)) return seen.get(key).where.push(where);
    seen.set(key, { line: `FAIL ${f.kind} ${page} ${where} :: ${f.detail} -> ${f.png}`, where: [where] });
  };
  try {
    const opened = cli("open", "about:blank");
    if (opened.status !== 0) throw new DriverError(`playwright-cli open failed: ${firstLines(opened)}`);
    for (const p of pages) {
      if (p.states !== null) continue;
      const found = exec(discoverStep(p, widths[0], base), path.join(out, `${slug(p.url)}-discover`));
      p.states = found.widget ? found.states : [];
    }
    for (const p of pages) stateCount += Math.max(0, p.states.length - 1);
    for (const step of plan(pages, widths, base)) {
      const name = `${slug(step.page)}-w${step.width}-${step.state === null ? "default" : slug(step.state)}`;
      const res = exec(step, path.join(out, name), shots && path.join(shots, name));
      tileCount += res.tiles ?? 0;
      const where = `w=${step.width}${step.state === null ? "" : ` state=${step.state}`}`;
      for (const f of res.failures) report(step.page, where, f);
    }
  } catch (e) {
    if (!(e instanceof DriverError)) throw e;
    driver = e;
  } finally {
    cli("close");
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const { line, where } of seen.values()) {
    console.log(line);
    if (where.length > 1) console.log(`  the same at ${where.slice(1).join("; ")}`);
  }
  if (shots) console.log(`shots: ${tileCount} tile(s) in ${shots}`);
  if (driver) {
    console.error(`driver error: ${driver.message}`);
    console.error("layout check: stopped at the driver error; nothing after it was checked (exit 2)");
    return 2;
  }
  if (failures) return 1;
  console.log(`ok: ${pages.length} page(s), ${stateCount} state(s) beyond the defaults, at ${widths.join(" and ")} px, each run from empty storage: no failure`);
  return 0;
}

// Run only as the entry script (`node check.mjs ...`); an import (the plan test) runs nothing.
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
