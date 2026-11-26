#!/usr/bin/env node
// The layout check: drives playwright-cli over a design build's pages and reports ONLY failures, each with a
// cropped screenshot. A clean build prints one `ok` line. It ships only here, in the plugin; run it as
// node "${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs", or copy it into a product's design folder. It is not a
// product's production-exclusion check (platform's `pnpm --dir web design:check` proves production holds none of
// the design; it measures no page).
//
// Widths: desktop 1440 (a 900 px window), tablet 768 (1024) and phone 375 (812), the iPhone 13 mini: a page that
// fits it fits every phone. A phone width (under 600) runs twice: in Chrome through playwright-cli, and in WebKit
// 18.2 with the iPhone 13 Mini profile (every iOS browser is WebKit; this old one is pinned because it shows a class
// of grid bug newer WebKit builds do not: an auto-fit grid that is its own size container lays out 0 px columns).
// The WebKit driver is playwright-core 1.49.1 and its WebKit build, installed on first use into one folder outside
// any repo: the user's cache (~/Library/Caches/sikstack/playwright-core-1.49.1 on a Mac, ~/.cache/sikstack/... else),
// or SIKSTACK_WEBKIT_HOME, which moves all of it. The browser goes to its browsers/ (PLAYWRIGHT_BROWSERS_PATH, for the
// install and the launch), never to Playwright's shared cache. Once: a download of about 63 MiB (and npm's few MB),
// about 250 MB on disk. When it cannot be installed or launched the check stops with a driver error; it never skips
// WebKit silently. --no-webkit skips it on purpose, and the ok line says so.
//
// What fails, at every width, on every page and every state the page lists:
//   console    a console error or an uncaught page error
//   request    a failed request, or a response of 400 or more
//   overflow   the page scrolls sideways; the crop is the element that sticks out. On WebKit, also a page laid
//              out wider than the phone (no <meta name="viewport">)
//   clipped    an element's own text cut off by overflow hidden or clip (an ellipsis or a line clamp is fine)
//   overlap    two controls that overlap, or a control another element covers; or two runs of text of different
//              elements drawn on one spot (two labels on top of each other)
//   target     a control under 24 x 24 px with less than 24 px of room around it (WCAG 2.5.8; inline text links
//              in a sentence are exempt)
//   state      the page does not show the state its run names (below); that run is not measured
// A control or a run of text is measured where it shows: cut by every scroll or clip box around it, so a row
// scrolled out of a capped table is neither overlapping nor a target. A run of text is its own line boxes, so text in
// a 0 x 0 wrapper counts, and a disabled control's label is text. What is not painted is not measured: under an
// opacity: 0 ancestor (a skip link hidden until focused), visibility: hidden, display: none, or clipped away.
// The page is measured at rest. An overlap is let pass only when the layer on top is laid over the page on purpose
// and what it covers can be moved off it, for text and controls alike:
//   - an opened layer (a dialog or popover open, an aria-modal box, or the out-of-flow popup of an
//     aria-expanded="true" trigger: the one its aria-controls names, else the box right after it or a menu, listbox
//     or dialog beside it) and the full-window backdrop that goes with it: the reader closes it. A box lifted by
//     z-index over its own background is the page unless it is opened, and so is a scrim beside nothing opened.
//   - a fixed box (a header, a foot bar), or a sticky one stuck off its place at rest: fine only where some scroll
//     position shows what it covers whole, in the window and clear of it. A header over the page's first line, a foot
//     bar over its last at the end of the scroll (measured there too), a stray scrim over the whole window: FAIL.
//   - a sticky box in its place at rest is the page; what passes under it once stuck is not measured.
// Each crop outlines what failed (both elements of an overlap, red then blue) and keeps context around it: 48 px each
// side, at least 360 x 220, clamped to the page (to the window scrolled to the end, for what was found there).
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
// Needs playwright-cli (npm install -g @playwright/cli@0.1.25), npm for the WebKit driver's first install, and a
// server already serving the build.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The widths a design is measured at when none are named: desktop, tablet, phone (the iPhone 13 mini). */
export const DEFAULT_WIDTHS = [1440, 768, 375];
/** A width under this is a phone: it also runs on WebKit. */
export const PHONE_MAX = 600;
/** The window's height at a width: a phone 812 (the iPhone 13 mini), a tablet 1024, a desktop 900. */
export const viewportHeight = (w) => (w < PHONE_MAX ? 812 : w <= 1024 ? 1024 : 900);
/** The phone engine: WebKit 18.2 (build 2104) from playwright-core 1.49.1, with its iPhone 13 Mini profile. */
export const WEBKIT = { core: "1.49.1", name: "WebKit 18.2", device: "iPhone 13 Mini" };

export const USAGE = `usage: node check.mjs --base <url> [--manifest <out/manifest.json>] [--all-entries] [--widths <w,w,w>] [--no-webkit] [--out <dir>] [--shots <dir>] [<url-or-path> ...]
  --base         the server the build is served on, e.g. http://127.0.0.1:3042 (paths are joined to it)
  --manifest     the build's manifest; its pages are checked (default: none, the URLs given)
  --all-entries  also check each page's other entries (pages[].entries, presetItems)
  --widths       comma-separated widths (default: 1440,768,375: desktop, tablet, phone)
  --no-webkit    do not run the phone widths (under 600) a second time on ${WEBKIT.name} (default: run them; the
                 driver, playwright-core ${WEBKIT.core} and its browser, installs on first use into one folder in
                 the user's cache, or SIKSTACK_WEBKIT_HOME: a download of about 63 MiB, about 250 MB on disk)
  --out          the folder for the cropped screenshots (default: ./design-check)
  --shots        also save every measured run as viewport-height tiles in this folder (default: none)
Each run opens in a fresh browser context (empty storage); a page with a state widget must show the state its run names.
exit 0: nothing failed, one ok line
exit 1: layout failures, one FAIL line each (console, request, overflow, clipped, overlap, target, state)
exit 2: a usage error, or a driver error (no server, a playwright-cli failure, WebKit not installed or not
        launching, the check's page script failing), printed as "driver error: ..."; nothing after it is checked`;

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
 * first (the page with no state, which must show the first listed state), then each other state, in Chrome. With
 * { webkit: true }, the same runs at each phone width (under 600) follow, on WebKit. Every step opens in a fresh
 * browser context, so nothing one run stores reaches the next. Pure: no browser, no file. */
export function plan(pages, widths, base, { webkit = false } = {}) {
  const steps = [];
  const walk = (ws, engine) => {
    for (const p of pages) {
      const states = p.states ?? [];
      for (const width of ws) {
        steps.push({ page: p.url, name: p.name, url: stateUrl(p.url, base, null), width, engine, state: null, expect: states[0] ?? null, fresh: true });
        for (const s of states.slice(1)) steps.push({ page: p.url, name: p.name, url: stateUrl(p.url, base, s), width, engine, state: s, expect: s, fresh: true });
      }
    }
  };
  walk(widths, "chromium");
  if (webkit) walk(widths.filter((w) => w < PHONE_MAX), "webkit");
  return steps;
}

/** The browser context's options for a run: its width and window height; on WebKit, the iPhone 13 Mini profile
 * (user agent, scale, touch, a mobile viewport) at that width. `devices` is playwright-core's table. */
export function contextOptions(width, engine, devices = null) {
  const viewport = { width, height: viewportHeight(width) };
  if (engine !== "webkit") return { viewport };
  const { defaultBrowserType, ...device } = devices[WEBKIT.device];
  return { ...device, viewport, screen: viewport };
}

/** The discovery run for a page the manifest lists no states for: its state widget's keys, read at one width. */
export function discoverStep(p, width, base) {
  return { page: p.url, name: p.name, url: stateUrl(p.url, base, null), width, engine: "chromium", state: null, expect: null, fresh: true, discover: true };
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

/** Where the WebKit driver lives: SIKSTACK_WEBKIT_HOME, else a folder in the user's cache (never in a repo). */
export function webkitHome(env = process.env) {
  if (env.SIKSTACK_WEBKIT_HOME) return path.resolve(env.SIKSTACK_WEBKIT_HOME);
  const cache = env.XDG_CACHE_HOME || (process.platform === "darwin" ? path.join(homedir(), "Library", "Caches") : path.join(homedir(), ".cache"));
  return path.join(cache, "sikstack", `playwright-core-${WEBKIT.core}`);
}

const coreAt = (home) => path.join(home, "node_modules", "playwright-core");
/** Where the WebKit browser lives: a store inside the driver's home, so one folder holds both and
 * SIKSTACK_WEBKIT_HOME moves both (never Playwright's shared ms-playwright cache). */
export const browsersAt = (home) => path.join(home, "browsers");
// playwright-core reads PLAYWRIGHT_BROWSERS_PATH once, when it loads, for both its install and its launch: set it first
const useStore = (home) => (process.env.PLAYWRIGHT_BROWSERS_PATH = browsersAt(home));
const coreVersion = (home) => {
  try {
    return JSON.parse(readFileSync(path.join(coreAt(home), "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

/** Whether the WebKit driver is ready without installing anything: the pinned playwright-core in its home and its
 * WebKit build in the home's store. (The smoke runs its WebKit fixture only then.) It points this process's
 * PLAYWRIGHT_BROWSERS_PATH at that store. */
export function webkitReady(env = process.env) {
  const home = webkitHome(env);
  if (coreVersion(home) !== WEBKIT.core) return false;
  useStore(home);
  try {
    return existsSync(createRequire(path.join(home, "package.json"))(coreAt(home)).webkit.executablePath());
  } catch {
    return false;
  }
}

/** The WebKit driver: playwright-core 1.49.1's WebKit 18.2 in this process, installed on first use. Its runCode runs
 * the same page-side script the playwright-cli driver runs, handed a page of its own browser. Every failure to
 * install, launch or run is a DriverError: never a silent skip. log(line) reports an install. */
export async function makeWebkitDriver(log = (l) => console.error(l)) {
  const home = webkitHome();
  const store = useStore(home);
  const sh = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: store } });
  const tail = (r) => `${r.error ? r.error.message : ""} ${r.stderr ?? ""} ${r.stdout ?? ""}`.trim().split("\n").slice(-3).join(" ");
  const by_hand = `install it by hand (npm install --prefix ${home} playwright-core@${WEBKIT.core}, then PLAYWRIGHT_BROWSERS_PATH=${store} node ${coreAt(home)}/cli.js install webkit), or run with --no-webkit`;
  if (coreVersion(home) !== WEBKIT.core) {
    log(`layout check: installing ${WEBKIT.name}'s driver, playwright-core ${WEBKIT.core}, into ${home} (once)`);
    const staging = `${home}.part-${process.pid}`;
    try {
      mkdirSync(path.dirname(home), { recursive: true });
    } catch (e) {
      throw new DriverError(`${WEBKIT.name}: cannot make ${path.dirname(home)}: ${e.message}; ${by_hand}`);
    }
    rmSync(staging, { recursive: true, force: true });
    const r = sh("npm", ["install", "--prefix", staging, "--no-audit", "--no-fund", "--loglevel=error", `playwright-core@${WEBKIT.core}`]);
    if (r.status !== 0 || coreVersion(staging) !== WEBKIT.core) {
      rmSync(staging, { recursive: true, force: true });
      throw new DriverError(`${WEBKIT.name}: npm could not install playwright-core ${WEBKIT.core}: ${tail(r)}; ${by_hand}`);
    }
    rmSync(home, { recursive: true, force: true });
    renameSync(staging, home);
  }
  let pc;
  try {
    pc = createRequire(path.join(home, "package.json"))(coreAt(home));
  } catch (e) {
    throw new DriverError(`${WEBKIT.name}: cannot load playwright-core from ${home}: ${e.message}; ${by_hand}`);
  }
  if (!existsSync(pc.webkit.executablePath())) {
    log(`layout check: installing ${WEBKIT.name} (playwright's WebKit build for playwright-core ${WEBKIT.core}) into ${store} (a download of about 63 MiB, about 240 MB on disk, once)`);
    const r = sh(process.execPath, [path.join(coreAt(home), "cli.js"), "install", "webkit"]);
    if (r.status !== 0) throw new DriverError(`${WEBKIT.name}: the browser install failed: ${tail(r)}; ${by_hand}`);
  }
  let browser;
  try {
    browser = await pc.webkit.launch();
  } catch (e) {
    throw new DriverError(`${WEBKIT.name} does not launch here: ${String(e.message).split("\n").slice(0, 3).join(" ")}; run with --no-webkit to skip it`);
  }
  const session = await (await browser.newContext()).newPage();
  const runCode = async (source, at) => {
    let v;
    try {
      // the same `async sessionPage => {...}` text playwright-cli's run-code takes, called on this browser's page
      v = await (0, eval)(`(${source})`)(session);
    } catch (e) {
      throw new DriverError(`${at} webkit :: ${String(e && e.message || e).split("\n").slice(0, 3).join(" ")}`);
    }
    try {
      return JSON.parse(v);
    } catch {
      throw new DriverError(`${at} webkit :: the page script answered no result`);
    }
  };
  return { runCode, devices: pc.devices, version: browser.version(), close: () => browser.close().catch(() => {}) };
}

// The page-side run: one playwright-cli run-code call per step, in a fresh browser context it opens and closes.
// It returns { failures: [...], states: [...], shows, widget }.
const RUN = String.raw`async sessionPage => {
  __READ_STATE__
  const C = __CFG__;
  const browser = sessionPage.context().browser();
  if (!browser) throw new Error("the session's browser cannot open a fresh context (a persistent profile?)");
  const ctx = C.fresh ? await browser.newContext(C.ctx) : sessionPage.context();
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
    if (!C.fresh) await page.setViewportSize(C.ctx.viewport);
    const resp = await page.goto(C.url, { waitUntil: "networkidle", timeout: 30000 });
    if (!resp || !page.url().startsWith("http")) throw new Error("did not load " + C.url + " (at " + page.url() + ")");
    if (resp.status() >= 400) failures.push({ kind: "request", detail: resp.status() + " " + C.url });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(250);
    ({ states, shows, widget } = await readState(page, C));
    if (C.discover) return JSON.stringify({ failures: [], states, shows, widget });
    if (C.expect !== null && shows !== C.expect) {
      const png = C.shot + "-state.png";
      await page.screenshot({ path: png, scale: "css" });
      return JSON.stringify({ failures: [{ kind: "state", detail: (widget ? "shows " + (shows === null ? "no marked state" : shows) : "has no state widget") + ", not " + C.expect + "; not measured", png }], states, shows, widget, mismatch: true });
    }
    const found = await page.evaluate((C) => {
      const W = innerWidth, out = [];
      const skip = (el) => !!el.closest("[data-design-states]");
      // faded: under an opacity: 0 ancestor (or itself at 0), so nothing of it is painted (a skip link hidden until focused)
      const fadedMemo = new Map();
      const faded = (el) => {
        if (!el || el === document.documentElement) return false;
        if (fadedMemo.has(el)) return fadedMemo.get(el);
        const v = Number(getComputedStyle(el).opacity) === 0 || faded(el.parentElement);
        fadedMemo.set(el, v);
        return v;
      };
      const visible = (el) => {
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.visibility !== "hidden" && s.display !== "none" && !faded(el) && r.width > 1 && r.height > 1;
      };
      const box = (r) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });
      const label = (el) => {
        const t = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
        return el.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 50) + '"' : "");
      };
      // Layers. An overlap is let pass only when the layer on top is laid over the page on purpose AND what it covers
      // can be moved off it. The layer an element is drawn in is its nearest box that is one of:
      //   over    an opened layer: a dialog or popover open, an aria-modal="true" box, or the popup an
      //           aria-expanded="true" trigger names by aria-controls (failing that, the box right after the trigger,
      //           or a visible menu, listbox or dialog beside it), when that popup lies out of flow; and a fixed box
      //           over the whole window that is the backdrop of an opened layer (it holds one, or its parent does).
      //           The reader closes it, so it is never compared with what lies outside it.
      //   pinned  any other fixed box (a header, a foot bar, a stray scrim), and a sticky box stuck off its place at
      //           rest: what it covers is fine only if some scroll position shows that thing whole, inside the window
      //           and clear of the painted box covering it (seenClear). A header over the page's first line, or a
      //           foot bar over its last at the end of the scroll, never moves off it.
      //   (none)  the page: everything else, a sticky box in its place at rest and a box lifted by z-index included.
      // Measured at rest, and again at the end of the page's scroll for what a fixed box covers there; content passing
      // under a stuck sticky bar while scrolled is not measured.
      const de = document.documentElement;
      const VW = de.clientWidth, VH = de.clientHeight, restX = scrollX, restY = scrollY;
      const maxX = Math.max(0, de.scrollWidth - VW), maxY = Math.max(0, de.scrollHeight - VH);
      const opaque = (c) => !/^(transparent|rgba\(.*,\s*0\))$/.test(c);
      const painted = (e) => { const s = getComputedStyle(e); return opaque(s.backgroundColor) || s.backgroundImage !== "none"; };
      const topLayer = (e) => { try { return e.matches("dialog[open], :popover-open"); } catch { return e.matches("dialog[open]"); } };
      const outOfFlow = (e) => topLayer(e) || /^(absolute|fixed)$/.test(getComputedStyle(e).position);
      const opened = new Set();
      for (const e of document.querySelectorAll('dialog[open], [aria-modal="true"]')) if (!skip(e)) opened.add(e);
      try { for (const e of document.querySelectorAll(":popover-open")) if (!skip(e)) opened.add(e); } catch {}
      for (const t of document.querySelectorAll('[aria-expanded="true"]')) {
        if (skip(t)) continue;
        let pop = (t.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean);
        if (!pop.length && t.nextElementSibling) pop = [t.nextElementSibling];
        if (!pop.some((e) => visible(e) && outOfFlow(e)) && t.parentElement)
          pop = [...t.parentElement.querySelectorAll("[role=menu],[role=listbox],[role=dialog]")];
        for (const e of pop) if (!skip(e) && visible(e) && outOfFlow(e)) opened.add(e);
      }
      const wholeWindow = (e) => { const r = e.getBoundingClientRect(); return r.left <= 1 && r.top <= 1 && r.right >= VW - 1 && r.bottom >= VH - 1; };
      const backdrop = (e) => [...opened].some((o) => e.contains(o) || (e.parentElement && e.parentElement.contains(o)));
      // a sticky box is stuck when it is drawn off the place it holds in the flow (its box as position: static)
      const stuck = (e) => {
        const a = e.getBoundingClientRect(), style = e.getAttribute("style");
        e.style.setProperty("position", "static", "important");
        const b = e.getBoundingClientRect();
        if (style === null) e.removeAttribute("style"); else e.setAttribute("style", style);
        return Math.abs(a.top - b.top) > 1 || Math.abs(a.left - b.left) > 1;
      };
      let pass = "rest", layerMemo = new Map();
      const layerOf = (el) => {
        if (!el || el === document.body || el === de) return null;
        if (layerMemo.has(el)) return layerMemo.get(el);
        const s = getComputedStyle(el);
        const v = opened.has(el) || (s.position === "fixed" && wholeWindow(el) && backdrop(el)) ? { el, kind: "over" }
          : s.position === "fixed" ? { el, kind: "pinned" }
          : s.position === "sticky" && stuck(el) ? { el, kind: pass === "rest" ? "pinned" : "stuck" }
          : layerOf(el.parentElement);
        layerMemo.set(el, v);
        return v;
      };
      // whether a span [b0, b1] of the page (page px) can be scrolled, by s in [0, max], into [a, z] of the window:
      // whole, or, when it is longer than [a, z], filling it (2 px of slack)
      const into = (b0, b1, a, z, max) => {
        if (z - a < 2) return false;
        const [lo, hi] = b1 - b0 <= z - a ? [b1 - z, b0 - a] : [b0 - a, b1 - z];
        return Math.max(lo - 2, 0) <= Math.min(hi + 2, max);
      };
      // whether a thing that scrolls with the page (m: its box in the window now) is seen whole at some scroll
      // position, inside the window and clear of a box fixed to the window (f)
      const seenClear = (m, f) => {
        const t = m.top + scrollY, b = m.bottom + scrollY, l = m.left + scrollX, r = m.right + scrollX;
        const inX = into(l, r, 0, VW, maxX), inY = into(t, b, 0, VH, maxY);
        const clearY = into(t, b, 0, Math.min(f.top, VH), maxY) || into(t, b, Math.max(f.bottom, 0), VH, maxY);
        const clearX = into(l, r, 0, Math.min(f.left, VW), maxX) || into(l, r, Math.max(f.right, 0), VW, maxX);
        return (clearY && inX) || (clearX && inY);
      };
      // what of a pinned layer covers: the nearest painted box from the thing up to the layer's box, else the thing
      const coverBox = (e, r, L) => {
        for (let a = e; a; a = a.parentElement) { if (painted(a)) return a.getBoundingClientRect(); if (a === L.el) break; }
        return r;
      };
      // whether two overlapping things (elements a and b, ra and rb their boxes in the window) are let pass. At the end
      // of the scroll only a pinned layer against the page is measured; the rest was measured at rest.
      const apart = (a, ra, b, rb) => {
        const la = layerOf(a), lb = layerOf(b);
        if ((la && la.el) === (lb && lb.el)) return pass === "end";
        if ((la && la.kind === "over") || (lb && lb.kind === "over")) return true;
        if ((la && la.kind === "stuck") || (lb && lb.kind === "stuck")) return true;
        if (la && lb) return pass === "end";
        const [L, fe, fr, mr] = la ? [la, a, ra, rb] : [lb, b, rb, ra];
        return seenClear(mr, coverBox(fe, fr, L));
      };
      // WebKit's phone profile lays a page out 980 px wide unless it says <meta name="viewport" content="width=device-width">
      if (C.engine === "webkit" && document.documentElement.clientWidth > C.width + 1)
        out.push({ kind: "overflow", detail: "the page lays out " + document.documentElement.clientWidth + "px wide in a " + C.width + "px phone window (no <meta name=\"viewport\" content=\"width=device-width\">?)", marks: null });
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
      // a box cut by each box, from the one given up, that scrolls or clips, stopping after a fixed one
      const cutBy = (r, from) => {
        let l = r.left, t = r.top, rt = r.right, b = r.bottom;
        for (let a = from; a && a !== document.documentElement; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX !== "visible" || s.overflowY !== "visible") {
            const ar = a.getBoundingClientRect(), x0 = ar.left + a.clientLeft, y0 = ar.top + a.clientTop;
            if (s.overflowX !== "visible") { l = Math.max(l, x0); rt = Math.min(rt, x0 + a.clientWidth); }
            if (s.overflowY !== "visible") { t = Math.max(t, y0); b = Math.min(b, y0 + a.clientHeight); }
          }
          if (s.position === "fixed") break;
        }
        return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
      };
      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (getComputedStyle(el).position === "fixed") return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        return cutBy(r, el.parentElement);
      };
      const hit = (a, b, pad = 0) => a.left - pad < b.right && b.left < a.right + pad && a.top - pad < b.bottom && b.top < a.bottom + pad;
      const said = new Set();
      // a failure found at the end of the scroll is cropped there (a fixed box is drawn where the window is)
      const push = (f) => { if (said.has(f.detail)) return; said.add(f.detail); if (pass === "end") f.end = true; out.push(f); };
      // the controls on screen now: a control scrolled out of its box (or under 2 px of it showing) is skipped
      const controls = () => {
        const cands = [...document.body.querySelectorAll(CTRL)].filter((el) => !skip(el) && visible(el) && !el.disabled);
        const cut = cands.map(shown);
        const keep = cut.map((r) => r.width > 2 && r.height > 2);
        return { ctrls: cands.filter((_, i) => keep[i]), rects: cut.filter((_, i) => keep[i]) };
      };
      const measureControls = ({ ctrls, rects }) => {
        for (let i = 0; i < ctrls.length; i++) for (let j = i + 1; j < ctrls.length; j++) {
          const a = rects[i], b = rects[j];
          if (ctrls[i].contains(ctrls[j]) || ctrls[j].contains(ctrls[i])) continue;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 2 && h > 2 && !apart(ctrls[i], a, ctrls[j], b)) push({ kind: "overlap", detail: label(ctrls[i]) + " overlaps " + label(ctrls[j]) + " by " + Math.round(w) + "x" + Math.round(h) + "px",
            marks: [box(a), box(b)] });
        }
        ctrls.forEach((el, i) => {
          const r = rects[i], cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return;
          const top = document.elementFromPoint(cx, cy);
          if (!top || el.contains(top) || top.contains(el) || skip(top) || (top.tagName === "LABEL" && top.control === el)) return;
          const tr = top.getBoundingClientRect();
          if (apart(el, r, top, tr)) return;
          push({ kind: "overlap", detail: label(el) + " is covered by " + label(top), marks: [box(r), box(tr)] });
        });
      };
      const { ctrls, rects } = controls();
      const whole = ctrls.map((el) => el.getBoundingClientRect());
      measureControls({ ctrls, rects });
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
      // text: two runs of text of different elements drawn on one spot. A run is a text node's own line boxes (a Range
      // over it, never its wrapper's box: text in a 0 x 0 wrapper is painted), cut by the boxes that scroll or clip
      // it; what is not painted (faded, visibility: hidden, clipped away by clip or clip-path: inset(50%)) is left
      // out. Two runs inside two different controls the control check measures are the controls' overlap above; any
      // other two are compared here (two spans in one link, a disabled button's label). An overlap counts when it is
      // over 2 px wide and at least half the shorter run's height, so a tight line height between a heading and the
      // line under it is not one.
      const hidden = (el) => {
        for (let a = el; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if ((s.clip && s.clip !== "auto") || s.clipPath === "inset(50%)") return true;
        }
        return false;
      };
      const ctrlOf = (el) => el.closest(CTRL);
      const pairs = new Set();
      let extra = 0;
      const measureText = (measured) => {
        const runs = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.nodeValue.trim()) continue;
          const el = n.parentElement;
          if (!el || el.closest("script,style,noscript,template,textarea,select,svg") || skip(el)) continue;
          const s = getComputedStyle(el);
          if (s.visibility === "hidden" || s.display === "none" || faded(el) || hidden(el)) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (r.width < 2 || r.height < 2) continue;
            const c = s.position === "fixed" ? r : cutBy(r, el);
            if (c.width >= 2 && c.height >= 2) runs.push({ n, el, r: c });
          }
        }
        runs.sort((a, b) => a.r.top - b.r.top);
        for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length && runs[j].r.top < runs[i].r.bottom; j++) {
          const a = runs[i], b = runs[j];
          if (a.n === b.n || a.el === b.el) continue;
          const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (w <= 2 || h < Math.max(2, 0.5 * Math.min(a.r.height, b.r.height))) continue;
          const ca = ctrlOf(a.el), cb = ctrlOf(b.el);
          if (ca && cb && ca !== cb && measured.has(ca) && measured.has(cb)) continue;
          if (apart(a.el, a.r, b.el, b.r)) continue;
          const key = [a.el, b.el];
          if ([...pairs].some((p) => (p[0] === key[0] && p[1] === key[1]) || (p[0] === key[1] && p[1] === key[0]))) continue;
          pairs.add(key);
          if (pairs.size > 8) { extra += 1; continue; }
          const text = (x) => x.el.tagName.toLowerCase() + ' "' + x.n.nodeValue.trim().replace(/\s+/g, " ").slice(0, 40) + '"';
          push({ kind: "overlap", detail: "text " + text(a) + " overlaps text " + text(b) + " by " + Math.round(w) + "x" + Math.round(h) + "px",
            marks: [box(a.r), box(b.r)] });
        }
      };
      measureText(new Set(ctrls));
      // the end of the scroll: what a fixed box covers there (a foot bar over the page's last lines), measured again
      if (maxX > 0 || maxY > 0) {
        pass = "end";
        layerMemo = new Map();
        // instant, so a page's scroll-behavior: smooth does not leave the scroll mid-way while this measures
        scrollTo({ left: maxX, top: maxY, behavior: "instant" });
        try {
          const end = controls();
          measureControls(end);
          measureText(new Set(end.ctrls));
        } finally {
          scrollTo({ left: restX, top: restY, behavior: "instant" });
        }
      }
      if (extra) out.push({ kind: "overlap", detail: "and " + extra + " more overlapping text pair(s) on this page", marks: null });
      return out;
    }, { engine: C.engine, width: C.width });
    failures.push(...found);
    // --shots: the page as a person scrolls it, one viewport-height tile at a time, taken after measuring
    if (C.tiles) {
      const vh = await page.evaluate(() => innerHeight), full = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let k = 0; k < 12 && (k === 0 || k * vh < full); k++) {
        await page.evaluate((y) => scrollTo(0, y), Math.min(k * vh, Math.max(0, full - vh)));
        await page.waitForTimeout(80);
        await page.screenshot({ path: C.tiles + "-t" + (k + 1) + ".png", scale: "css" });
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
        // outline each mark (red, then blue) above the page, without moving anything
        await page.evaluate((marks) => marks.forEach((b, k) => {
          const d = document.createElement("div");
          d.setAttribute("data-design-check-mark", "");
          d.style.cssText = "position:absolute;pointer-events:none;z-index:2147483647;box-sizing:border-box;left:" + (b.x - 2) + "px;top:" + (b.y - 2) + "px;width:" + (b.w + 4) + "px;height:" + (b.h + 4) + "px;border:2px " + (k ? "dashed #2563eb" : "solid #dc2626");
          document.documentElement.appendChild(d);
        }), f.marks);
        if (f.end) {
          // found at the end of the scroll: crop the window scrolled there, where the fixed box covering it is drawn
          const v = await page.evaluate(() => { const de = document.documentElement; scrollTo({ left: de.scrollWidth, top: de.scrollHeight, behavior: "instant" }); return { sx: scrollX, sy: scrollY, vw: de.clientWidth, vh: de.clientHeight }; });
          const [x, width] = span(x0 - v.sx, x1 - v.sx, 360, 1600, v.vw), [y, height] = span(y0 - v.sy, y1 - v.sy, 220, 1200, v.vh);
          await page.screenshot({ path: f.png, clip: { x, y, width, height }, scale: "css" });
          await page.evaluate(() => scrollTo({ left: 0, top: 0, behavior: "instant" }));
        } else {
          const [x, width] = span(x0, x1, 360, 1600, page_w), [y, height] = span(y0, y1, 220, 1200, page_h);
          await page.screenshot({ path: f.png, fullPage: true, clip: { x, y, width, height }, scale: "css" });
        }
        await page.evaluate(() => document.querySelectorAll("[data-design-check-mark]").forEach((d) => d.remove()));
      } else {
        await page.screenshot({ path: f.png, scale: "css" });
      }
      delete f.marks;
      delete f.end;
    }
  } finally {
    page.off("console", onConsole); page.off("pageerror", onError); page.off("requestfailed", onFailed); page.off("response", onResponse);
    if (C.fresh) await ctx.close();
  }
  return JSON.stringify({ failures, states, shows, widget, tiles });
}`.replace("__READ_STATE__", () => READ_STATE);

const slug = (s) => s.replace(/^https?:\/\/[^/]+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60) || "root";

async function main(argv) {
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
  const widths = (opt("--widths", DEFAULT_WIDTHS.join(",")) ?? "").split(",").map(Number).filter((n) => n > 0);
  const allEntries = flag("--all-entries");
  const noWebkit = flag("--no-webkit");
  const shotsArg = opt("--shots");
  const shots = shotsArg ? path.resolve(shotsArg) : null;
  if (!base) return usage(`--base is required\n${USAGE}`);
  if (!/^https?:\/\//.test(base)) return usage(`--base must be an http(s) server (playwright-cli blocks file:); serve the folder first`);
  if (args.some((a) => a.startsWith("--"))) return usage(`unknown option ${args.find((a) => a.startsWith("--"))}\n${USAGE}`);
  if (!widths.length) return usage(`--widths takes comma-separated widths, e.g. ${DEFAULT_WIDTHS.join(",")}`);

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

  const phones = widths.filter((w) => w < PHONE_MAX);
  const webkit = phones.length > 0 && !noWebkit;
  const session = `design-check-${process.pid}`;
  const scratch = mkdtempSync(path.join(tmpdir(), "design-check-"));
  mkdirSync(out, { recursive: true });
  if (shots) mkdirSync(shots, { recursive: true });
  const { cli, firstLines, runCode } = makeDriver(session, scratch);
  let wk = null;
  const exec = async (step, shot, tiles = null) => {
    const ctx = contextOptions(step.width, step.engine, step.engine === "webkit" ? wk.devices : null);
    const cfg = { url: step.url, width: step.width, engine: step.engine, ctx, fresh: step.fresh, expect: step.expect, discover: !!step.discover, shot, tiles };
    const at = `${step.url} w=${step.width}${step.state ? ` state=${step.state}` : ""}`;
    return (step.engine === "webkit" ? wk.runCode : runCode)(RUN.replace("__CFG__", () => JSON.stringify(cfg)), at);
  };

  let failures = 0, stateCount = 0, driver = null, tileCount = 0, opened = null;
  // The same failure on the same page in several states, widths or engines is one line: the first crop, then where else.
  const seen = new Map();
  const report = (page, where, f) => {
    failures += 1;
    const key = `${f.kind}|${page}|${f.detail.replace(/\d+px of \d+/, "")}`;
    if (seen.has(key)) return seen.get(key).where.push(where);
    seen.set(key, { line: `FAIL ${f.kind} ${page} ${where} :: ${f.detail} -> ${f.png}`, where: [where] });
  };
  try {
    // WebKit first: a driver that cannot be installed or launched stops the check before anything is measured
    if (webkit) wk = await makeWebkitDriver();
    opened = cli("open", "about:blank");
    if (opened.status !== 0) throw new DriverError(`playwright-cli open failed: ${firstLines(opened)}`);
    for (const p of pages) {
      if (p.states !== null) continue;
      const found = await exec(discoverStep(p, widths[0], base), path.join(out, `${slug(p.url)}-discover`));
      p.states = found.widget ? found.states : [];
    }
    for (const p of pages) stateCount += Math.max(0, p.states.length - 1);
    for (const step of plan(pages, widths, base, { webkit })) {
      const engine = step.engine === "webkit" ? "-webkit" : "";
      const name = `${slug(step.page)}-w${step.width}${engine}-${step.state === null ? "default" : slug(step.state)}`;
      const res = await exec(step, path.join(out, name), shots && path.join(shots, name));
      tileCount += res.tiles ?? 0;
      const where = `w=${step.width}${step.engine === "webkit" ? " webkit" : ""}${step.state === null ? "" : ` state=${step.state}`}`;
      for (const f of res.failures) report(step.page, where, f);
    }
  } catch (e) {
    if (!(e instanceof DriverError)) throw e;
    driver = e;
  } finally {
    if (opened) cli("close");
    if (wk) await wk.close();
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
  const engines = !phones.length ? "" : webkit ? ` (${phones.join(" and ")} also on ${WEBKIT.name}, ${WEBKIT.device})` : ` (WebKit skipped: --no-webkit)`;
  console.log(`ok: ${pages.length} page(s), ${stateCount} state(s) beyond the defaults, at ${widths.join(" and ")} px${engines}, each run from empty storage: no failure`);
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
if (entry()) process.exitCode = await main(process.argv.slice(2));
