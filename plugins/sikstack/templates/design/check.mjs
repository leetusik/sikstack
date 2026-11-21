#!/usr/bin/env node
// The design check: drives playwright-cli over a design build's pages and reports ONLY failures, each with a
// cropped screenshot. A clean build prints one `ok` line. Copy it into a product's design folder (platform keeps
// its own at web/design/scripts/) or run it from the plugin: node "${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs".
//
// What fails, at 1440 and 390 px wide, on every page and every state the page lists:
//   console    a console error or an uncaught page error
//   request    a failed request, or a response of 400 or more
//   overflow   the page scrolls sideways; the crop is the element that sticks out
//   clipped    an element's own text cut off by overflow hidden or clip (an ellipsis or a line clamp is fine)
//   overlap    two controls that overlap, or a control another element covers
//   target     a control under 24 x 24 px with less than 24 px of room around it (WCAG 2.5.8; inline text links
//              in a sentence are exempt)
// A control is measured where it shows: cut by every scroll or clip box around it, so a row scrolled out of a
// capped table is neither overlapping nor a target. Each crop outlines what failed (both elements of an overlap,
// red then blue) and keeps context around it: 48 px each side, at least 360 x 220, clamped to the page.
// The design-only state widget ([data-design-states]) is never checked.
//
// Pages: the build's out/manifest.json (each pages[].entry; --all-entries adds pages[].entries and presetItems),
// else the URLs given. States: a page's manifest `states` (keys, or {key}), else the keys its state widget lists
// ([data-design-state]); each opens as ?state=<key>. The default state is the page with no state.
//
// Needs playwright-cli (npm install -g @playwright/cli@0.1.25) and a server already serving the build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const USAGE = `usage: node check.mjs --base <url> [--manifest <out/manifest.json>] [--all-entries] [--out <dir>] [<url-or-path> ...]
  --base       the server the build is served on, e.g. http://127.0.0.1:3042 (paths are joined to it)
  --manifest   the build's manifest; its pages are checked (default: none, the URLs given)
  --all-entries  also check each page's other entries (pages[].entries, presetItems)
  --out        the folder for the cropped screenshots (default: ./design-check)
  --widths     comma-separated widths (default: 1440,390)
exit 0 and one ok line when nothing fails; exit 1 with one FAIL line per failure; exit 2 on a usage or driver error`;

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
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
const die = (msg) => {
  console.error(`design check: ${msg}`);
  process.exit(2);
};
const base = opt("--base");
const manifestPath = opt("--manifest");
const out = path.resolve(opt("--out", "design-check"));
const widths = opt("--widths", "1440,390").split(",").map(Number).filter((n) => n > 0);
const allEntries = flag("--all-entries");
if (!base) die(`--base is required\n${USAGE}`);
if (!/^https?:\/\//.test(base)) die(`--base must be an http(s) server (playwright-cli blocks file:); serve the folder first`);
if (args.some((a) => a.startsWith("--"))) die(`unknown option ${args.find((a) => a.startsWith("--"))}\n${USAGE}`);

const pages = [];
if (manifestPath) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const p of m.pages ?? []) {
    const urls = [p.entry, ...(allEntries ? [...(p.entries ?? []), ...(p.presetItems ?? [])] : [])].filter(Boolean);
    const states = Array.isArray(p.states) ? p.states.map((s) => (typeof s === "string" ? s : s.key)).filter(Boolean) : null;
    for (const u of [...new Set(urls)]) pages.push({ name: p.name ?? u, url: u, states });
  }
}
for (const u of args) pages.push({ name: u, url: u, states: null });
if (!pages.length) die("no pages: give --manifest or one or more URLs");

const session = `design-check-${process.pid}`;
const scratch = mkdtempSync(path.join(tmpdir(), "design-check-"));
mkdirSync(out, { recursive: true });
const cli = (...a) => spawnSync("playwright-cli", [`-s=${session}`, ...a], { encoding: "utf8", cwd: scratch, maxBuffer: 64 << 20 });

// The page-side run: one call per page, width and state. It returns { failures: [...], states: [...] }.
const RUN = String.raw`async page => {
  const C = __CFG__;
  const failures = [];
  // A failed load is reported once, as its request; its console twin ("Failed to load resource") is dropped.
  const onConsole = (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) failures.push({ kind: "console", detail: m.text().slice(0, 300) }); };
  const onError = (e) => failures.push({ kind: "console", detail: ("uncaught " + (e && e.message || e)).slice(0, 300) });
  const onFailed = (r) => failures.push({ kind: "request", detail: (r.failure() ? r.failure().errorText : "failed") + " " + r.url() });
  const onResponse = (r) => { if (r.status() >= 400) failures.push({ kind: "request", detail: r.status() + " " + r.url() }); };
  page.on("console", onConsole); page.on("pageerror", onError); page.on("requestfailed", onFailed); page.on("response", onResponse);
  let states = [];
  try {
    await page.setViewportSize({ width: C.width, height: C.width < 600 ? 844 : 900 });
    const resp = await page.goto(C.url, { waitUntil: "networkidle", timeout: 30000 });
    if (!resp || !page.url().startsWith("http")) throw new Error("did not load " + C.url + " (at " + page.url() + ")");
    if (resp.status() >= 400) failures.push({ kind: "request", detail: resp.status() + " " + C.url });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.waitForTimeout(250);
    if (C.discover) {
      const pill = page.locator("[data-design-states] > button[aria-expanded]");
      if (await pill.count()) {
        await pill.first().click();
        states = await page.locator("[data-design-state]").evaluateAll((els) => els.map((e) => e.getAttribute("data-design-state")));
        await page.keyboard.press("Escape");
        await page.waitForTimeout(100);
      }
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
  }
  return JSON.stringify({ failures, states });
}`;

const slug = (s) => s.replace(/^https?:\/\/[^/]+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60) || "root";
let failures = 0, checked = 0, stateCount = 0;
// The same failure on the same page in several states or widths is one line: the first crop, then where else.
const seen = new Map();
const report = (page, where, f) => {
  failures += 1;
  const key = `${f.kind}|${page}|${f.detail.replace(/\d+px of \d+/, "")}`;
  if (seen.has(key)) return seen.get(key).where.push(where);
  seen.set(key, { line: `FAIL ${f.kind} ${page} ${where} :: ${f.detail} -> ${f.png}`, where: [where] });
};
const run = (url, width, state, discover, shotBase) => {
  const cfg = { url, width, discover, shot: shotBase };
  const file = path.join(scratch, "run.js");
  writeFileSync(file, RUN.replace("__CFG__", JSON.stringify(cfg)));
  const r = cli("--raw", "run-code", `--filename=${file}`);
  if (r.status !== 0) {
    failures += 1;
    console.log(`FAIL driver ${url} w=${width}${state ? ` state=${state}` : ""} :: ${(r.stdout + r.stderr).trim().split("\n").slice(0, 3).join(" ")}`);
    return { failures: [], states: [] };
  }
  let v = JSON.parse(r.stdout.trim());
  if (typeof v === "string") v = JSON.parse(v);
  return v;
};

try {
  const opened = cli("open", "about:blank");
  if (opened.status !== 0) die(`playwright-cli open failed: ${(opened.stdout + opened.stderr).trim().split("\n")[0]}`);
  for (const p of pages) {
    const url = new URL(p.url, base).href;
    let states = p.states;
    for (const width of widths) {
      const first = run(url, width, null, states === null, path.join(out, `${slug(url)}-w${width}-default`));
      if (states === null) states = first.states;
      states = states.slice(0); // a copy; the first key is the default, which is the page with no state
      checked += 1;
      for (const f of first.failures) report(p.url, `w=${width}`, f);
      for (const s of states.slice(1)) {
        const u = new URL(url);
        u.searchParams.set("state", s);
        const res = run(u.href, width, s, false, path.join(out, `${slug(url)}-w${width}-${slug(s)}`));
        stateCount += width === widths[0] ? 1 : 0;
        for (const f of res.failures) report(p.url, `w=${width} state=${s}`, f);
      }
    }
  }
} finally {
  cli("close");
  rmSync(scratch, { recursive: true, force: true });
}
for (const { line, where } of seen.values()) {
  console.log(line);
  if (where.length > 1) console.log(`  the same at ${where.slice(1).join("; ")}`);
}
if (failures) process.exit(1);
console.log(`ok: ${pages.length} page(s), ${stateCount} state(s) beyond the defaults, at ${widths.join(" and ")} px: no failure`);
