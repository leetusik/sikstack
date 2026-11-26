// The layout check in a real browser, over fixture pages this script serves on loopback. Each page must fail or
// pass the check as its name says:
//   chromium  (playwright-cli's Chrome, at 1440, 768 and 375, --no-webkit)
//     labels        FAIL overlap: two labels (a dt and a dd) drawn on one grid cell
//     link          FAIL overlap: two spans inside one link, the second pulled over the first
//     barstuck      FAIL overlap: a fixed bar over the last line of a page that cannot scroll
//     stray         FAIL overlap: a transparent box over the whole window with nothing open covers a link
//     headtop-link  FAIL overlap: a fixed header over the first link of a scrolling page (no room kept under it)
//     headtop-text  FAIL overlap: the same header over the first heading's text
//     sticky-text   FAIL overlap: a sticky header pulled over the first heading (in its place at rest)
//     footcover     FAIL overlap: a fixed foot bar over the last link of a page that scrolls by less than the bar
//     bar-end       FAIL overlap: a tall page whose last line (a link) stays under the fixed foot bar at the end
//     badge-link    FAIL overlap: an absolute z-index: 1 badge with a fill over a link, nothing open
//     badge-text    FAIL overlap: the same badge over a heading's text
//     straywithopen FAIL overlap: the stray scrim beside an unrelated aria-expanded="true" (an open disclosure)
//     zerowrap      FAIL overlap: text in a 0 x 0 wrapper drawn over an h2
//     disabledpair  FAIL overlap: two disabled buttons whose labels overlap
//     skip          ok: a skip link inside an opacity: 0 band (pointer-events: none) over the wordmark
//     bar           ok: a fixed foot bar over text the page scrolls out from under it, its room kept at the end
//     head-kept     ok: a fixed header over a scrolling page that keeps the header's room at its top
//     sticky-head   ok: a sticky header in its place at rest, over a scrolling page
//     menu          ok: an open menu (the box right after its aria-expanded="true" trigger, lifted over its own
//                   background) over the page's text and a link, with a transparent scrim over the whole window
//                   behind it (the menu's dismiss layer), as the app's org menu is drawn
//     menu-controls ok: an open role=menu its trigger names by aria-controls, drawn elsewhere in the page
//     tiles-*       ok: both stat strips fit in Chrome
//   webkit    (WebKit 18.2 with the iPhone 13 Mini profile, at 375)
//     tiles-broken  FAIL overlap at w=375 webkit only: an auto-fit grid that is its own size container (B1's CSS)
//                   lays out 0 px columns, so its three tiles' labels and figures sit on one spot
//     tiles-fixed   ok: the same strip with the size container moved to a wrapper
//     headtop-link  FAIL overlap at w=375 webkit (as in Chrome)
// Needs node and playwright-cli; webkit also needs the check's WebKit driver (the smoke runs it only when the driver
// is already installed: check.mjs's webkitReady()).
//   node tests/check_fixtures.mjs chromium|webkit [<check.mjs>]   (default: the plugin's templates/design/check.mjs)
// Prints "<mode> ok", or each problem and exits 1; exits 2 when the check itself fails to run. CHECK_FIXTURES_OUT=<dir>
// keeps the check's crops there; CHECK_FIXTURES_VERBOSE=1 prints its output.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];
const check = path.resolve(process.argv[3] ?? path.join(here, "..", "templates", "design", "check.mjs"));
if (mode !== "chromium" && mode !== "webkit") {
  console.log("usage: node check_fixtures.mjs chromium|webkit [<check.mjs>]");
  process.exit(2);
}
const page = (style, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>f</title><style>body{margin:0;padding:16px;background:#fff;color:#111;font:16px/1.5 sans-serif} ${style}</style></head><body>${body}</body></html>`;
const lines = (n) => Array.from({ length: n }, (_, i) => `<p style="margin:0;line-height:18px">Line ${i + 1} of the page's running text</p>`).join("");
// B1: the usage strip as production drew it, and as fixed (the size container on a wrapper, not on the grid)
const STRIP = `<section class="usage"><dl class="stats"><div class="stat"><dt>Documents created</dt><dd>12</dd></div><div class="stat"><dt>Searches</dt><dd>40</dd></div><div class="stat"><dt>Deleted</dt><dd>0</dd></div></dl></section>`;
const TILE = `dl,dd{margin:0} .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(10em,100%),1fr));overflow:hidden;border:1px solid #ccc;border-radius:6px}
  .stat{display:flex;flex-direction:column;gap:4px;min-width:0;margin:-1px 0 0 -1px;padding:16px;border-top:1px solid #ccc;border-left:1px solid #ccc}
  dd{font-size:28px;font-weight:600;line-height:1.2}
  @container (max-width:29.99em){.stat:nth-child(3){grid-column:1/-1}}`;
const HEAD = `body{padding:0} .head{position:fixed;top:0;left:0;right:0;height:56px;margin:0;padding:0 16px;line-height:56px;background:#eee;z-index:3}`;
const STICKY = `body{padding:0} .head{position:sticky;top:0;height:56px;margin:0;padding:0 16px;line-height:56px;background:#eee;z-index:3}`;
const FOOT = `.bar{position:fixed;bottom:0;left:0;right:0;margin:0;line-height:18px;background:#eee}`;
const BADGE = `.card{position:relative;padding:16px;border:1px solid #ccc} .badge{position:absolute;top:16px;left:16px;z-index:1;background:#fde;padding:0 4px}`;
const H1 = `<h1 style="margin:0;padding:8px 16px;font-size:20px;line-height:24px">Usage this month</h1>`;
const SCRIM = `.scrim{position:fixed;inset:0;z-index:2}`;
const PAGES = {
  labels: page(`dl{margin:0} .cell{display:grid} .cell>*{grid-area:1/1;margin:0}`, `<dl class="cell"><dt>Documents created</dt><dd>Searches</dd></dl>`),
  link: page(``, `<p><a href="/link/">P1-d4 <span style="margin-left:-3em">Retry uploads</span></a></p>`),
  barstuck: page(`body{padding:16px 16px 0} ${FOOT}`, `<div style="height:calc(100vh - 34px)"></div><p style="margin:0;line-height:18px">The last line of a short page</p><p class="bar">Bookmark this position</p>`),
  stray: page(`${SCRIM} a{display:inline-block;min-height:44px}`, `<div class="scrim"></div><p><a href="/stray/">Open Members</a></p>`),
  // painted and in the way at rest, and no scroll position moves it off what it covers
  "headtop-link": page(`${HEAD} main a{display:inline-block;min-height:44px;padding:12px 16px}`, `<p class="head">sikstack Overview</p><main><a href="/x/">Open Members</a></main>${lines(120)}`),
  "headtop-text": page(HEAD, `<p class="head">sikstack Overview</p>${H1}${lines(120)}`),
  "sticky-text": page(`${STICKY} .head{margin-bottom:-56px}`, `<p class="head">sikstack Overview</p>${H1}${lines(120)}`),
  footcover: page(`body{padding:0} .bar{position:fixed;bottom:0;left:0;right:0;margin:0;line-height:60px;background:#eee} .last{display:inline-block;min-height:44px;line-height:44px}`,
    `<div style="height:calc(100vh - 34px)"></div><p style="margin:0"><a class="last" href="/z/">Last link</a></p><p class="bar">Bookmark this position</p>`),
  "bar-end": page(`body{padding:0} ${FOOT}`, `${lines(160)}<p style="margin:0;line-height:18px"><a href="/z/">Load more</a></p><p class="bar">Bookmark this position</p>`),
  "badge-link": page(`${BADGE} .badge{line-height:44px} .card a{display:inline-block;min-height:44px;line-height:44px}`, `<div class="card"><span class="badge">New release</span><a href="/y/">Open Members</a></div>`),
  "badge-text": page(`${BADGE} .badge{line-height:24px}`, `<div class="card"><span class="badge">New release</span><h2 style="margin:0;font-size:20px;line-height:24px">Documents created</h2></div>`),
  straywithopen: page(`${SCRIM} a{display:inline-block;min-height:44px}`, `<div class="scrim"></div><button aria-expanded="true" style="height:44px">Details</button><p>The details, shown</p><p><a href="/stray/">Open Members</a></p>`),
  zerowrap: page(``, `<h2 style="margin:0;font-size:20px;line-height:24px">Documents created<span style="display:inline-block;width:0;height:0;vertical-align:top"><span style="position:absolute;left:16px;white-space:nowrap;line-height:24px">NEW TOOLTIP</span></span></h2>`),
  disabledpair: page(`button{width:160px;height:44px;font:inherit}`, `<p><button disabled>Save draft</button><button disabled style="margin-left:-120px">Publish now</button></p>`),
  // what lies over the page on purpose, or is moved off what it covers by a scroll
  skip: page(`.band{position:fixed;top:0;left:0;right:0;z-index:7;height:56px;background:#fff;pointer-events:none;opacity:0} .band a{display:inline-block;padding:16px} header{height:56px} header a{display:inline-block;padding:16px}`,
    `<div class="band"><a href="#main">Skip to content</a></div><header><a href="/skip/">sikstack</a></header><main id="main">${lines(4)}</main>`),
  bar: page(`body{padding:0 0 18px} ${FOOT}`, `${lines(160)}<p class="bar">Bookmark this position</p>`),
  "head-kept": page(`${HEAD} body{padding-top:56px} main a{display:inline-block;min-height:44px;padding:12px 16px}`, `<p class="head">sikstack Overview</p>${H1}<main><a href="/x/">Open Members</a></main>${lines(120)}`),
  "sticky-head": page(STICKY, `<p class="head">sikstack Overview</p>${H1}${lines(120)}`),
  menu: page(`${SCRIM} .anchor{position:relative;z-index:3} .menu{position:absolute;top:100%;left:0;z-index:5;width:16em;margin:0;padding:4px;background:#fff;border:1px solid #ccc}
    .menu button{display:block;width:100%;height:44px;font:inherit;text-align:left;background:none;border:0} main a{display:inline-block;min-height:44px}`,
    `<div class="scrim"></div><div class="anchor"><button aria-expanded="true" aria-haspopup="true" style="height:44px">Sample org</button><form class="menu" role="group"><p style="margin:0">Switch org</p><button>Personal</button><button>KRPD</button></form></div><main><p style="margin:0"><a href="/menu/">Open Members</a></p>${lines(6)}</main>`),
  "menu-controls": page(`.pop{position:absolute;top:60px;left:16px;z-index:5;width:16em;padding:4px;background:#fff;border:1px solid #ccc}
    .pop button{display:block;width:100%;height:44px;font:inherit;text-align:left;background:none;border:0} main a{display:inline-block;min-height:44px}`,
    `<header><button aria-expanded="true" aria-controls="acts" style="height:44px">Actions</button></header><main><p style="margin:0"><a href="/menu/">Open Members</a></p>${lines(6)}</main><div id="acts" class="pop" role="menu"><button role="menuitem">Rename</button><button role="menuitem">Delete</button></div>`),
  "tiles-broken": page(`.stats{container-type:inline-size} ${TILE}`, STRIP),
  "tiles-fixed": page(`.usage{container-type:inline-size} ${TILE}`, STRIP),
};
const CASES = ["headtop-link", "headtop-text", "sticky-text", "footcover", "bar-end", "badge-link", "badge-text", "straywithopen", "zerowrap", "disabledpair"];
const EXPECT = {
  chromium: {
    labels: "fail", link: "fail", barstuck: "fail", stray: "fail", ...Object.fromEntries(CASES.map((c) => [c, "fail"])),
    skip: "ok", bar: "ok", "head-kept": "ok", "sticky-head": "ok", menu: "ok", "menu-controls": "ok", "tiles-broken": "ok", "tiles-fixed": "ok",
  },
  webkit: { "tiles-broken": "webkit-only", "tiles-fixed": "ok", "headtop-link": "webkit-too" },
}[mode];

const server = createServer((req, res) => {
  const name = new URL(req.url, "http://x").pathname.replace(/^\/|\/$/g, "");
  if (!(name in PAGES)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGES[name]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const keep = process.env.CHECK_FIXTURES_OUT ? path.resolve(process.env.CHECK_FIXTURES_OUT) : null; // keep the crops there
const out = keep ?? mkdtempSync(path.join(tmpdir(), "check-fixtures-"));
let code = 0;
try {
  const args = [check, "--base", base, "--out", out, ...(mode === "chromium" ? ["--widths", "1440,768,375", "--no-webkit"] : ["--widths", "375"]), ...Object.keys(EXPECT).map((n) => `/${n}/`)];
  const run = await new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (rc) => resolve({ rc, stdout, stderr }));
  });
  if (run.rc === 2 || (run.rc !== 0 && run.rc !== 1)) {
    console.log(`the check did not run (rc ${run.rc}): ${(run.stderr + run.stdout).trim().split("\n").slice(0, 3).join(" ")}`);
    code = 2;
  } else {
    const problems = [];
    // each FAIL line ("FAIL <kind> <page> <where> :: ..."), with the runs it names: its own, and those of the
    // "  the same at <where>; <where>" line under it
    const fails = [];
    for (const l of run.stdout.split("\n")) {
      if (l.startsWith("FAIL ")) {
        const head = l.slice(0, l.indexOf(" :: ")).split(" ");
        fails.push({ line: l, kind: head[1], page: head[2], where: [head.slice(3).join(" ")] });
      } else if (l.startsWith("  the same at ") && fails.length) fails[fails.length - 1].where.push(...l.slice(14).split("; "));
    }
    const show = (mine) => (mine.length ? mine.map((f) => f.line).join(" | ") : "none");
    for (const [name, want] of Object.entries(EXPECT)) {
      const mine = fails.filter((f) => f.page === `/${name}/`);
      const overlap = mine.filter((f) => f.kind === "overlap");
      if (want === "ok" && mine.length) problems.push(`${name}: wanted no failure, got ${show(mine)}`);
      if (want === "fail" && !overlap.length) problems.push(`${name}: wanted FAIL overlap, got ${show(mine)}`);
      // only on WebKit: Chrome passes the same page at the same width, so the failure is the engine's
      if (want === "webkit-only" && !(mine.length && mine.every((f) => f.kind === "overlap" && f.where.every((w) => w.startsWith("w=375 webkit")))))
        problems.push(`${name}: wanted FAIL overlap at w=375 webkit only, got ${show(mine)}`);
      if (want === "webkit-too" && !overlap.some((f) => f.where.some((w) => w.startsWith("w=375 webkit"))))
        problems.push(`${name}: wanted FAIL overlap at w=375 webkit, got ${show(mine)}`);
    }
    for (const p of problems) console.log(p);
    if (process.env.CHECK_FIXTURES_VERBOSE) console.log(run.stdout.trim());
    code = problems.length ? 1 : 0;
    if (!problems.length) console.log(`${mode} ok`);
  }
} finally {
  server.close();
  if (!keep) rmSync(out, { recursive: true, force: true });
}
process.exit(code);
