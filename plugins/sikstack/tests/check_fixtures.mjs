// The layout check in a real browser, over fixture pages this script serves on loopback. Each page must fail or
// pass the check as its name says:
//   chromium  (playwright-cli's Chrome, at 1440, 768 and 375, --no-webkit)
//     labels      FAIL overlap: two labels (a dt and a dd) drawn on one grid cell
//     link        FAIL overlap: two spans inside one link, the second pulled over the first
//     barstuck    FAIL overlap: a fixed bar over the last line of a page that cannot scroll
//     stray       FAIL overlap: a transparent box over the whole window with nothing open covers a link
//     skip        ok: a skip link inside an opacity: 0 band (pointer-events: none) over the wordmark
//     bar         ok: a fixed foot bar over text the page scrolls out from under it
//     menu        ok: an open menu (lifted by z-index over its own background) over the page's text and a link,
//                 with a transparent scrim over the whole window behind it (the menu's dismiss layer) while its
//                 trigger says aria-expanded="true"
//     tiles-*     ok: both stat strips fit in Chrome
//   webkit    (WebKit 18.2 with the iPhone 13 Mini profile, at 375)
//     tiles-broken  FAIL overlap: an auto-fit grid that is its own size container (B1's CSS) lays out 0 px columns,
//                   so its three tiles' labels and figures sit on one spot
//     tiles-fixed   ok: the same strip with the size container moved to a wrapper
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
const PAGES = {
  labels: page(`dl{margin:0} .cell{display:grid} .cell>*{grid-area:1/1;margin:0}`, `<dl class="cell"><dt>Documents created</dt><dd>Searches</dd></dl>`),
  link: page(``, `<p><a href="/link/">P1-d4 <span style="margin-left:-3em">Retry uploads</span></a></p>`),
  barstuck: page(`body{padding:16px 16px 0} .bar{position:fixed;bottom:0;left:0;right:0;margin:0;line-height:18px;background:#eee}`, `<div style="height:calc(100vh - 34px)"></div><p style="margin:0;line-height:18px">The last line of a short page</p><p class="bar">Bookmark this position</p>`),
  skip: page(`.band{position:fixed;top:0;left:0;right:0;z-index:7;height:56px;background:#fff;pointer-events:none;opacity:0} .band a{display:inline-block;padding:16px} header{height:56px} header a{display:inline-block;padding:16px}`,
    `<div class="band"><a href="#main">Skip to content</a></div><header><a href="/skip/">sikstack</a></header><main id="main">${lines(4)}</main>`),
  bar: page(`body{padding:0} .bar{position:fixed;bottom:0;left:0;right:0;margin:0;line-height:18px;background:#eee}`, `${lines(160)}<p class="bar">Bookmark this position</p>`),
  menu: page(`.scrim{position:fixed;inset:0;z-index:2} .wrap{position:relative} .menu{position:absolute;top:0;left:0;z-index:5;width:16em;padding:4px;background:#fff;border:1px solid #ccc}
    .menu button{display:block;width:100%;height:44px;font:inherit;text-align:left;background:none;border:0} .wrap a{display:inline-block;min-height:44px}`,
    `<div class="scrim"></div><button aria-expanded="true" style="position:relative;z-index:3;height:44px">Sample org</button><div class="wrap"><div class="menu"><p style="margin:0">Switch org</p><button>Personal</button><button>KRPD</button></div><p style="margin:0"><a href="/menu/">Open Members</a></p>${lines(6)}</div>`),
  stray: page(`.scrim{position:fixed;inset:0;z-index:2} a{display:inline-block;min-height:44px}`, `<div class="scrim"></div><p><a href="/stray/">Open Members</a></p>`),
  "tiles-broken": page(`.stats{container-type:inline-size} ${TILE}`, STRIP),
  "tiles-fixed": page(`.usage{container-type:inline-size} ${TILE}`, STRIP),
};
const EXPECT = {
  chromium: { labels: "fail", link: "fail", barstuck: "fail", stray: "fail", skip: "ok", bar: "ok", menu: "ok", "tiles-broken": "ok", "tiles-fixed": "ok" },
  webkit: { "tiles-broken": "fail", "tiles-fixed": "ok" },
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
    const fails = run.stdout.split("\n").filter((l) => l.startsWith("FAIL "));
    for (const [name, want] of Object.entries(EXPECT)) {
      const mine = fails.filter((l) => l.split(" ")[2] === `/${name}/`);
      if (want === "ok" && mine.length) problems.push(`${name}: wanted no failure, got ${mine.join(" | ")}`);
      if (want === "fail" && mode === "chromium" && !mine.some((l) => l.startsWith("FAIL overlap "))) problems.push(`${name}: wanted FAIL overlap, got ${mine.length ? mine.join(" | ") : "none"}`);
      // on WebKit only: Chrome passes the same page at the same width, so the failure is the engine's
      if (want === "fail" && mode === "webkit" && !(mine.length && mine.every((l) => l.startsWith("FAIL overlap ") && l.includes(" w=375 webkit "))))
        problems.push(`${name}: wanted FAIL overlap at w=375 webkit only, got ${mine.length ? mine.join(" | ") : "none"}`);
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
