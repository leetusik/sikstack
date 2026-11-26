// The canvas shoot in a real browser: canvas.mjs shoots a fixture build served on loopback, and its PNGs are read
// back. Each shot must be the page as a teammate scrolling it would see it:
//   lazy     a loading="lazy" image and iframe 6000 px down are drawn
//   overlay  a position: fixed; inset: 0 tint over a 3000 px page covers the whole shot, bottom rows included
//   grows    the same over a page whose height tracks the window (min-height: 100vh under a header) is shot at its
//            first measured height, never a grown one, and the tint still reaches the bottom row
//   vh       a min-height: 100vh page under a header, with nothing fixed, keeps its height (the window plus 64 px)
//   long     a 12000 px page is cut so that its artboard (a 32 px caption over the shot) holds the shot whole
// Needs node and playwright-cli (the smoke skips it without playwright-cli).
//   node tests/canvas_shoot.mjs [<canvas.mjs>]      (default: the plugin's templates/design/canvas.mjs)
// Prints "shoot ok", or each problem and exits 1; exits 2 when the shoot itself fails.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { DEFAULT_WIDTHS, viewportHeight } from "../templates/design/check.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const canvas = path.resolve(process.argv[2] ?? path.join(here, "..", "templates", "design", "canvas.mjs"));
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>f</title></head><body style="margin:0;background:#fff;font:16px sans-serif">${body}</body></html>`;
const TINT = `<div style="position:fixed;inset:0;background:rgba(0,0,255,0.5)"></div>`;
const FILES = {
  "/red.svg": ["image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#f00"/></svg>`],
  "/green.html": ["text/html", page("")],
  "/lazy/": ["text/html", page(`<div style="height:6000px">top</div><img loading="lazy" src="/red.svg" alt="" width="200" height="200" style="display:block"><iframe loading="lazy" src="/green.html" width="200" height="200" style="display:block;border:0"></iframe><div style="height:200px"></div>`)],
  "/overlay/": ["text/html", page(`<div style="height:3000px">a tall page</div>${TINT}`)],
  "/grows/": ["text/html", page(`<header style="height:64px">header</header><main style="min-height:100vh"><div style="height:1500px">content</div></main>${TINT}`)],
  "/vh/": ["text/html", page(`<header style="height:64px">header</header><main style="min-height:100vh">short</main>`)],
  "/long/": ["text/html", page(`<div style="height:12000px">a very tall page</div>`)],
};
FILES["/green.html"][1] = FILES["/green.html"][1].replace("background:#fff", "background:#0f0");
const NAMES = ["lazy", "overlay", "grows", "vh", "long"];
FILES["/manifest.json"] = ["application/json", JSON.stringify({ pages: NAMES.map((n) => ({ name: n, entry: `/${n}/`, states: [] })) })];

/** A PNG's pixels (8-bit RGB or RGBA, not interlaced): { w, h, at(x, y) -> [r, g, b] }. */
function readPng(buf) {
  let off = 8, w = 0, h = 0, type = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG"); }
    if (kind === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG color type ${type}`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[y * stride + i - bpp] : 0, b = y ? px[(y - 1) * stride + i] : 0, c = i >= bpp && y ? px[(y - 1) * stride + i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + i] = (src[i] + pred) & 255;
    }
  }
  return { w, h, at: (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 3)] };
}

const server = createServer((req, res) => {
  const f = FILES[new URL(req.url, "http://x").pathname];
  if (!f) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": f[0] });
  res.end(f[1]);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = mkdtempSync(path.join(tmpdir(), "canvas-shoot-"));
const problems = [];
let code = 0;
try {
  const mfile = path.join(out, "manifest.json");
  (await import("node:fs")).writeFileSync(mfile, FILES["/manifest.json"][1]);
  const run = await new Promise((resolve) => {
    const p = spawn(process.execPath, [canvas, "--base", base, "--manifest", mfile, "--out", out, "--title", "Fixture"], { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    p.stdout.on("data", (d) => (text += d)); p.stderr.on("data", (d) => (text += d));
    p.on("close", (rc) => resolve({ rc, text }));
  });
  if (run.rc !== 0) { console.log(`the shoot failed (rc ${run.rc}): ${run.text.trim().split("\n").slice(0, 3).join(" ")}`); code = 2; }
  else {
    const plan = JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8"));
    const shot = {}, board = {};
    for (const a of plan.artboards) {
      const name = a.title.split(" · ")[0];
      board[name] = plan.canvas.boards[a.file];
      for (const f of a.shots) shot[`${name}@${/--w(\d+)\./.exec(f)[1]}`] = readPng(readFileSync(path.join(out, "shots", f)));
    }
    const tinted = ([r, g, b]) => b > 200 && r < 170 && g < 170, red = ([r, g, b]) => r > 200 && g < 60 && b < 60, green = ([r, g, b]) => g > 200 && r < 60 && b < 60;
    for (const w of DEFAULT_WIDTHS) {
      const vh = viewportHeight(w), s = (n) => shot[`${n}@${w}`];
      if (!s("lazy") || !red(s("lazy").at(100, 6100))) problems.push(`lazy@${w}: the lazy image 6000 px down is not drawn (${s("lazy")?.at(100, 6100)})`);
      if (!s("lazy") || !green(s("lazy").at(100, 6300))) problems.push(`lazy@${w}: the lazy iframe 6200 px down is not drawn (${s("lazy")?.at(100, 6300)})`);
      const o = s("overlay");
      if (o.h !== 3000) problems.push(`overlay@${w}: shot ${o.h} px, not the page's 3000`);
      for (const y of [0, vh + 10, Math.floor(o.h / 2), o.h - 1]) if (!tinted(o.at(5, y))) { problems.push(`overlay@${w}: the fixed tint does not cover row ${y} of ${o.h} (${o.at(5, y)})`); break; }
      const g = s("grows");
      if (g.h !== 64 + 1500) problems.push(`grows@${w}: shot ${g.h} px, not its first measure ${64 + 1500}`);
      if (!tinted(g.at(5, g.h - 1))) problems.push(`grows@${w}: the fixed tint does not reach the bottom row (${g.at(5, g.h - 1)})`);
      if (s("vh").h !== vh + 64) problems.push(`vh@${w}: shot ${s("vh").h} px, not the window plus the header (${vh + 64})`);
      const l = s("long");
      if (l.h >= 12000 || l.h < 7900) problems.push(`long@${w}: shot ${l.h} px, not cut near 8000`);
      if (board.long.h < 32 + l.h || board.long.h > 8000) problems.push(`long@${w}: its artboard (${board.long.h} px) clips the shot (${l.h} px under a 32 px caption)`);
    }
    if (!new RegExp(` cut=${DEFAULT_WIDTHS.length} `).test(run.text)) problems.push(`the summary does not count the ${DEFAULT_WIDTHS.length} cut shots: ${run.text.split("\n")[0]}`);
    code = problems.length ? 1 : 0;
    for (const p of problems) console.log(p);
    if (!problems.length) console.log("shoot ok");
  }
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}
process.exit(code);
