#!/usr/bin/env node
// Prove production holds none of the design build (`pnpm --dir web design:check`):
//
// 1. `web/.dockerignore` keeps `design/` out of the image's build context.
// 2. No file under `src/` imports from `design/`.
// 3. A production `next build` of a scratch copy of `web/` (never this checkout: the build rewrites `.next`)
//    holds no design page, recording or store: none of the design's marks appears in its output.
//
// `--plant` first plants a page in the copy's `src/` that imports the design (its recording and its mark),
// so the check must fail: the proof that it can. `--keep` leaves the scratch copy; `--scratch <dir>` names it.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESIGN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.dirname(DESIGN);
// What only the design build carries: lib/mark.ts (store keys, recordings, the frame's attribute), the
// Reset control and the stub pages' title.
const MARKS = ["sikstack-design-build", "Reset design data", "Not in this design"];
const SKIP_COPY = new Set([
  "node_modules",
  ".next",
  "tsconfig.tsbuildinfo",
  path.join("design", ".next"),
  path.join("design", "out"),
  path.join("design", "data", "local"),
]);

const argv = process.argv.slice(2);
const plant = argv.includes("--plant");
const keep = argv.includes("--keep");
const at = argv.indexOf("--scratch");
const failures = [];
const say = (line) => console.log(`design:check: ${line}`);

// -- 1. the image ---------------------------------------------------------------------------------

function dockerignoreKeepsDesign() {
  const lines = readFileSync(path.join(WEB, ".dockerignore"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  let out = false;
  for (const l of lines) {
    const neg = l.startsWith("!");
    const pat = (neg ? l.slice(1) : l).replace(/^\/+/, "").replace(/\/+$/, "");
    if (pat === "design" || pat === "design/**" || pat === "**/design") out = !neg;
    else if (neg && pat.startsWith("design/")) out = false; // a re-included part of it
  }
  return out;
}
if (dockerignoreKeepsDesign()) say("ok   web/.dockerignore keeps design/ out of the image");
else failures.push("web/.dockerignore does not keep design/ out of the image");

// -- the scratch copy -----------------------------------------------------------------------------

const scratch = at >= 0 ? path.resolve(argv[at + 1]) : mkdtempSync(path.join(os.tmpdir(), "design-check-"));
const copy = path.join(scratch, "web");
if (existsSync(copy)) rmSync(copy, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
cpSync(WEB, copy, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(WEB, src);
    return !SKIP_COPY.has(rel) && !/^\.env.*\.local$/.test(path.basename(rel));
  },
});
// node_modules: an APFS clone where it can (no space, a second), else a plain copy. Turbopack refuses a
// node_modules symlink that leaves the project.
const cloned = spawnSync("cp", ["-cR", path.join(WEB, "node_modules"), path.join(copy, "node_modules")]);
if (cloned.status !== 0) cpSync(path.join(WEB, "node_modules"), path.join(copy, "node_modules"), { recursive: true, verbatimSymlinks: true });
say(`scratch copy of web/ at ${copy}`);

if (plant) {
  const dir = path.join(copy, "src", "app", "design-plant");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "page.tsx"),
    `import recording from "../../../design/data/sample/recording.json";
import { DESIGN_MARK } from "../../../design/lib/mark";

export default function Planted() {
  return <p data-mark={DESIGN_MARK}>{recording.name}</p>;
}
`,
  );
  say("planted src/app/design-plant/page.tsx importing the design's recording and mark (the check must fail)");
}

// -- 2. the source --------------------------------------------------------------------------------

function* files(dir, test) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p, test);
    else if (test(p)) yield p;
  }
}
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g;
for (const file of files(path.join(copy, "src"), (p) => /\.(m?[jt]sx?|css)$/.test(p))) {
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const spec = m[1];
    const target = spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : null;
    if ((target && target.startsWith(path.join(copy, "design") + path.sep)) || /^@\/\.\.\/design\//.test(spec))
      failures.push(`src imports the design: ${path.relative(copy, file)} → ${spec}`);
  }
}
if (!failures.some((f) => f.startsWith("src imports"))) say("ok   no file under src/ imports from design/");

// -- 3. the production build ----------------------------------------------------------------------

say("running the production build (next build) in the scratch copy ...");
const built = spawnSync(path.join(copy, "node_modules", ".bin", "next"), ["build"], {
  cwd: copy,
  encoding: "utf8",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
writeFileSync(path.join(scratch, "build.log"), `${built.stdout}\n${built.stderr}`);
if (built.status !== 0) {
  failures.push(`the production build failed (log: ${path.join(scratch, "build.log")})`);
} else {
  const next = path.join(copy, ".next");
  const hits = new Map();
  for (const file of files(next, (p) => !p.includes(`${path.sep}cache${path.sep}`))) {
    const text = readFileSync(file, "latin1");
    for (const mark of MARKS) if (text.includes(mark)) hits.set(path.relative(copy, file), mark);
  }
  if (hits.size === 0) say(`ok   the production build (.next/) holds no design mark (${MARKS.map((m) => `"${m}"`).join(", ")})`);
  for (const [file, mark] of hits) failures.push(`the production build holds the design: "${mark}" in ${file}`);
}

if (!keep) rmSync(scratch, { recursive: true, force: true });
else say(`kept ${scratch}`);

if (failures.length > 0) {
  for (const f of failures) console.error(`design:check: FAIL ${f}`);
  process.exit(1);
}
say("PASS production holds none of the design build");
