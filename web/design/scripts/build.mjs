#!/usr/bin/env node
// Build the design folder: `next build design` (a static export to `design/out/`), then
// `design/out/manifest.json` (the pages, their entry paths, the recording each reads, the source commit),
// then a link check: every in-site link the pages draw must have a file in `out/`, so nothing the design
// links to 404s on a static server.
//
//   node design/scripts/build.mjs [--data sample | --data local/<name>]     (pnpm --dir web design:build)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESIGN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.dirname(DESIGN);
const OUT = path.join(DESIGN, "out");
const MARK = "sikstack-design-build"; // lib/mark.ts

function die(message) {
  console.error(`design:build: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const at = argv.indexOf("--data");
const data = at >= 0 ? argv[at + 1] : "sample";
let recordingRel;
if (data === "sample") recordingRel = "data/sample/recording.json";
else if (/^local\/[a-z0-9][a-z0-9-]*$/.test(data)) recordingRel = `data/${data}.json`;
else die("--data takes sample or local/<name>");
const recordingPath = path.join(DESIGN, recordingRel);
if (!existsSync(recordingPath)) die(`no recording at design/${recordingRel} (record one with design:record)`);
const recording = JSON.parse(readFileSync(recordingPath, "utf8"));
if (recording.$design !== MARK) die(`design/${recordingRel} is not a design recording`);

const next = path.join(WEB, "node_modules", ".bin", "next");
const built = spawnSync(next, ["build", "design"], {
  cwd: WEB,
  stdio: "inherit",
  env: { ...process.env, DESIGN_RECORDING: recordingRel, NEXT_TELEMETRY_DISABLED: "1" },
});
if (built.status !== 0) die("next build failed");

// -- the manifest -------------------------------------------------------------------------------

const git = (...args) => {
  const r = spawnSync("git", args, { cwd: WEB, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const project = recording.workspace.project;
const ws = `/projects/${encodeURIComponent(project)}/workspace/`;
const itemDir = path.join(OUT, "projects", project, "workspace", "agenda");
const itemIds = existsSync(itemDir) ? readdirSync(itemDir).filter((d) => existsSync(path.join(itemDir, d, "index.html"))) : [];
const recorded = recording.workspace.agenda.map((a) => a.id);
const recordedSet = new Set(recorded);
const num = (id) => Number(/^A(\d+)-/.exec(id)?.[1] ?? 0);
// The answers the pages' state presets read (`lib/answers.ts`), and the item pages their data sets hold.
const STATES = path.join(DESIGN, "data", "sample", "states");
const stateFiles = existsSync(STATES) ? readdirSync(STATES).filter((f) => f.endsWith(".json")).sort() : [];
const stateIds = new Set();
for (const f of stateFiles)
  for (const a of JSON.parse(readFileSync(path.join(STATES, f), "utf8")).workspace.agenda ?? [])
    if (!recordedSet.has(a.id)) stateIds.add(a.id);
const presetItems = itemIds.filter((id) => stateIds.has(id)).sort((a, b) => num(a) - num(b));
const minted = itemIds
  .filter((id) => !recordedSet.has(id) && !stateIds.has(id))
  .sort((a, b) => num(a) - num(b));
const recordingRef = `design/${recordingRel}`;

const manifest = {
  $design: MARK,
  built_at: new Date().toISOString(),
  source: {
    repo: "platform",
    commit: git("rev-parse", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: (git("status", "--porcelain", "--", ".") ?? "") !== "",
  },
  recording: { file: recordingRef, name: recording.name, now: recording.now, project },
  // Each page lists its states on the state widget (`lib/states.tsx`); `?state=<key>` opens one.
  states: stateFiles.map((f) => `design/data/sample/states/${f}`),
  pages: [
    {
      name: "Workspace · Agenda",
      route: "/projects/[projectId]/workspace",
      production: "src/app/(app)/projects/[projectId]/workspace/page.tsx",
      entry: ws,
      recording: recordingRef,
      reads: ["workspace"],
    },
    {
      name: "Agenda item",
      route: "/projects/[projectId]/workspace/agenda/[item]",
      production: "src/app/(app)/projects/[projectId]/workspace/agenda/[item]/page.tsx",
      entry: `${ws}agenda/${recorded[0]}/`,
      entries: recorded.map((id) => `${ws}agenda/${id}/`),
      presetItems: presetItems.map((id) => `${ws}agenda/${id}/`),
      browserAdded: minted.map((id) => `${ws}agenda/${id}/`),
      recording: recordingRef,
      reads: ["workspace", "items"],
    },
  ],
};
writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// -- the link check -----------------------------------------------------------------------------

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith(".html")) yield p;
  }
}
const has = (urlPath) => {
  const p = path.join(OUT, decodeURIComponent(urlPath));
  return (existsSync(p) && statSync(p).isFile()) || existsSync(path.join(p, "index.html"));
};
const missing = new Map();
for (const file of htmlFiles(OUT)) {
  const html = readFileSync(file, "utf8");
  for (const m of html.matchAll(/\shref="(\/[^"#?]*)/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (href.startsWith("//") || has(href)) continue;
    const page = path.relative(OUT, file);
    if (!missing.has(href)) missing.set(href, page);
  }
}
if (missing.size > 0) {
  for (const [href, page] of missing) console.error(`  ${href} (linked from ${page})`);
  die(`${missing.size} link(s) without a page in out/: add them to lib/away.ts`);
}

console.log(
  `design:build: out/ (${manifest.pages.length} pages, ${recorded.length} recorded, ${presetItems.length} preset and ${minted.length} browser-added item pages) and out/manifest.json from ${recordingRef}`,
);
