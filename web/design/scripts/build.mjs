#!/usr/bin/env node
// Build the design folder: `next build design` (a static export to `design/out/`), then
// `design/out/manifest.json` (the pages, their entry paths, the recording each reads, the source commit, and the
// options page's entry and directions when there is one),
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
    {
      name: "System",
      route: "/system",
      production: null,
      entry: "/system/",
      reads: ["src/sikstack/styles/tokens.css", "@/sikstack/ui", "@/sikstack/frame", "@/sikstack/states", "@/sikstack/shell"],
    },
  ],
};
// The options page, when the build has one (`templates/design/options.html`, copied into the design folder for
// a named decision): its entry and each direction's key and label, read from the page's `DIRECTIONS`, so a
// viewer can put the directions side by side, `?direction=<key>` opening each.
function* pageFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "_next") yield* pageFiles(p);
    } else if (name.endsWith(".html")) yield p;
  }
}
const quoted = (body, field) => {
  const m = new RegExp(`\\b${field}\\s*:\\s*(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`).exec(body);
  return m ? m[2].replace(/\\(.)/g, "$1") : null;
};
const optionPages = [];
for (const file of pageFiles(OUT)) {
  const html = readFileSync(file, "utf8");
  const at = html.search(/\bconst\s+DIRECTIONS\s*=\s*\[/);
  if (at < 0) continue;
  const list = html.slice(at, html.indexOf("];", at) + 1);
  const directions = [];
  for (const [object] of list.matchAll(/\{[^{}]*\}/g)) {
    const key = quoted(object, "key");
    const label = quoted(object, "label");
    if (key && label) directions.push({ key, label });
  }
  const rel = path.relative(OUT, file).split(path.sep).join("/");
  if (directions.length === 0) die(`${rel} has a DIRECTIONS list with no { key, label } entries`);
  const entry = rel.endsWith("/index.html") || rel === "index.html" ? `/${rel.slice(0, -"index.html".length)}` : `/${rel}`;
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim() || null;
  optionPages.push({
    name: title,
    entry,
    directions: directions.map((d) => ({ ...d, entry: `${entry}?direction=${encodeURIComponent(d.key)}` })),
  });
}
if (optionPages.length > 1) die(`more than one options page (${optionPages.map((o) => o.entry).join(", ")}): keep one`);
if (optionPages.length === 1) manifest.options = optionPages[0];

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

// -- the system page holds the file's tokens and every shared export -------------------------------

const systemHtml = readFileSync(path.join(OUT, "system", "index.html"), "utf8");
const attrs = (name) => new Set([...systemHtml.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]));
const tokensCss = readFileSync(path.join(WEB, "src", "sikstack", "styles", "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const fileTokens = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const pageTokens = attrs("data-token");
const tokenGaps = [
  ...[...fileTokens].filter((t) => !pageTokens.has(t)).map((t) => `  ${t}: in tokens.css, not on /system/`),
  ...[...pageTokens].filter((t) => !fileTokens.has(t)).map((t) => `  ${t}: on /system/, not in tokens.css`),
];
if (tokenGaps.length > 0) {
  for (const g of tokenGaps) console.error(g);
  die(`/system/'s tokens differ from src/sikstack/styles/tokens.css`);
}
const drawn = new Set([...attrs("data-component")].flatMap((c) => c.split(" ")));
const listed = attrs("data-export");
const exportGaps = [];
for (const part of ["ui", "frame", "states", "shell"]) {
  const index = readFileSync(path.join(WEB, "src", "sikstack", part, "index.ts"), "utf8").replace(/\/\/.*$/gm, "");
  for (const m of index.matchAll(/export\s*\{([^}]*)\}\s*from/g))
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (!name || name.startsWith("type ")) continue;
      if (!drawn.has(name) && !listed.has(name)) exportGaps.push(`  ${name} (@/sikstack/${part})`);
    }
}
if (exportGaps.length > 0) {
  for (const g of exportGaps) console.error(g);
  die(`${exportGaps.length} shared export(s) neither drawn nor listed on /system/ (lib/system-board.tsx)`);
}

console.log(
  `design:build: /system/ holds ${fileTokens.size} tokens and ${drawn.size + listed.size} shared exports`,
);
console.log(
  `design:build: out/ (${manifest.pages.length} pages${manifest.options ? `, an options page of ${manifest.options.directions.length} directions` : ""}, ${recorded.length} recorded, ${presetItems.length} preset and ${minted.length} browser-added item pages) and out/manifest.json from ${recordingRef}`,
);
