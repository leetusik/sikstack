#!/usr/bin/env node
// Serve the design build (`design/out/`) on loopback with a plain static file server: files as they are,
// `dir/` as `dir/index.html`, the query ignored, anything else the build's `404.html` with a 404. No API,
// no rewrites, nothing written.
//
//   node design/scripts/serve.mjs [--port 3040] [--log]     (pnpm --dir web design:serve)
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

const argv = process.argv.slice(2);
const portArg = argv.indexOf("--port");
let port = portArg >= 0 ? Number(argv[portArg + 1]) : Number(process.env.PORT || 3040);
const log = argv.includes("--log");

function file(p) {
  try {
    return statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

function resolve(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = path.join(OUT, path.normalize(rel));
  if (full !== OUT && !full.startsWith(OUT + path.sep)) return null;
  return file(full) ?? file(path.join(full, "index.html"));
}

try {
  statSync(path.join(OUT, "index.html"));
} catch {
  console.error(`serve: no build in ${OUT}: run pnpm --dir web design:build first`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const urlPath = (req.url || "/").split("?", 1)[0];
  const found = req.method === "GET" || req.method === "HEAD" ? resolve(urlPath) : null;
  const target = found ?? path.join(OUT, "404.html");
  const status = found ? 200 : 404;
  if (log) console.log(`${status} ${req.method} ${req.url}`);
  res.writeHead(status, {
    "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(target).pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE" && portArg < 0) {
    port += 1;
    server.listen(port, "127.0.0.1");
  } else {
    console.error(`serve: ${e.message}`);
    process.exit(1);
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`design build: http://127.0.0.1:${port}/ (serving ${path.relative(process.cwd(), OUT) || OUT})`);
});
