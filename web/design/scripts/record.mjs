#!/usr/bin/env node
// Record a project's Workspace from the real API for the design build:
//
//   printf '%s' "$TOKEN" | node design/scripts/record.mjs --project <id> [--api http://127.0.0.1:8766]
//       [--to sample | --to local/<name>] [--state <name>] [--project-name <name>] [--time-zone <zone>]
//
// It reads `GET /app/projects/{id}/workspace` and each `GET …/workspace/agenda/{item}`, with a session
// token (a signed-in bearer) from `$DESIGN_RECORD_TOKEN` or stdin; the token is never written anywhere.
// The project id becomes a fixed sample id and every date moves by one offset so the recording's own
// moment reads as `ANCHOR`; the Shell's names are fixed (never the account's).
//
// `--to sample` writes `design/data/sample/recording.json`, which is committed: record it only from a
// sample project on the local stack (`run.sh up`). Anything else goes to `--to local/<name>`
// (`design/data/local/<name>.json`, gitignored); build it with `pnpm design:build --data local/<name>`.
//
// `--state <name>` records one answer a page's state preset reads (`lib/states.tsx`, `lib/answers.ts`) to
// `design/data/sample/states/<name>.json`: the same shape, but the Workspace may be unlinked or never
// synced (its agenda then absent or empty), and an item its own route does not hold yet (an add that
// waits for the sync) is kept as its row alone.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESIGN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "sikstack-design-build"; // lib/mark.ts
const SAMPLE_PROJECT = "00000000-0000-4000-8000-000000000001";
const SAMPLE_ORG = "00000000-0000-4000-8000-0000000000a1";
const ANCHOR = Date.parse("2026-11-20T09:00:00Z");
const DAY = 86_400_000;

function args(argv) {
  const out = {
    api: "http://127.0.0.1:8766",
    to: "sample",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = [argv[i], argv[i + 1]];
    if (k === "--api") out.api = v.replace(/\/+$/, "");
    else if (k === "--project") out.project = v;
    else if (k === "--to") out.to = v;
    else if (k === "--project-name") out.projectName = v;
    else if (k === "--time-zone") out.timeZone = v;
    else if (k === "--state") out.state = v;
    else throw new Error(`unknown argument ${k}`);
    i++;
  }
  if (!out.project) throw new Error("--project <id> is required");
  if (out.to !== "sample" && !/^local\/[a-z0-9][a-z0-9-]*$/.test(out.to))
    throw new Error("--to takes sample or local/<name> (lowercase letters, digits, dashes)");
  if (out.state !== undefined && (out.to !== "sample" || !/^[a-z0-9][a-z0-9-]*$/.test(out.state)))
    throw new Error("--state takes a name (lowercase letters, digits, dashes) and records only to sample");
  return out;
}

function token() {
  const env = process.env.DESIGN_RECORD_TOKEN;
  if (env) return env.trim();
  if (process.stdin.isTTY) throw new Error("give the token on stdin or in DESIGN_RECORD_TOKEN");
  const t = readFileSync(0, "utf8").trim();
  if (!t) throw new Error("no token on stdin");
  return t;
}

async function get(api, route, bearer) {
  const res = await fetch(api + route, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${route} answered ${res.status}`);
  return res.json();
}

/** The same, or null on a 404 (an item its own route does not hold yet). */
async function getOrNull(api, route, bearer) {
  try {
    return await get(api, route, bearer);
  } catch (e) {
    if (/ answered 404$/.test(e.message)) return null;
    throw e;
  }
}

/** Calendar days in a zone, as `YYYY-MM-DD`. */
function dayIn(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

const CAL = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Every date moved by the same offset, the real project id replaced, in every string. */
function normalizer(projectId, takenAt, timeZone) {
  const shift = ANCHOR - takenAt;
  const days = Math.round(
    (Date.parse(dayIn(ANCHOR, timeZone)) - Date.parse(dayIn(takenAt, timeZone))) / DAY,
  );
  const walk = (v) => {
    if (typeof v === "string") {
      if (CAL.test(v))
        return new Date(Date.parse(`${v}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
      if (INSTANT.test(v)) return new Date(Date.parse(v) + shift).toISOString().replace(/\.\d+Z$/, "Z");
      return v.split(projectId).join(SAMPLE_PROJECT);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk;
}

async function main() {
  const o = args(process.argv.slice(2));
  const bearer = token();
  const base = `/app/projects/${encodeURIComponent(o.project)}`;
  const takenAt = Date.now();
  const workspace = await get(o.api, `${base}/workspace`, bearer);
  if (o.state === undefined && (!workspace.linked || !Array.isArray(workspace.agenda)))
    throw new Error("the project has no synced workspace: link one (`sikstack link`) first");
  const items = {};
  for (const row of workspace.agenda ?? []) {
    const route = `${base}/workspace/agenda/${encodeURIComponent(row.id)}`;
    const own = o.state === undefined ? await get(o.api, route, bearer) : await getOrNull(o.api, route, bearer);
    if (own) items[row.id] = own;
  }
  let project = { name: o.projectName ?? null, visibility: "private", created_at: new Date(takenAt).toISOString() };
  if (!o.projectName) {
    const p = await get(o.api, base, bearer);
    const one = p.project ?? p;
    project = { name: one.name, visibility: one.visibility ?? "private", created_at: one.created_at ?? project.created_at };
  }
  const norm = normalizer(o.project, takenAt, o.timeZone);
  const recording = {
    $design: MARK,
    name: o.state ?? (o.to === "sample" ? "sample" : o.to.slice("local/".length)),
    now: new Date(ANCHOR).toISOString().replace(/\.\d+Z$/, "Z"),
    timeZone: o.timeZone,
    source: {
      routes: ["GET /app/projects/{project}/workspace", "GET /app/projects/{project}/workspace/agenda/{item}"],
      note: "project id and dates normalized; the Shell's names are fixed",
    },
    shell: norm({
      org: { id: SAMPLE_ORG, name: "Sample org" },
      project,
      email: "design@example.invalid",
    }),
    workspace: norm(workspace),
    items: norm(items),
  };
  const text = `${JSON.stringify(recording, null, 2)}\n`;
  if (text.includes(o.project)) throw new Error("the real project id survived normalization: nothing written");
  if (text.includes(bearer)) throw new Error("the token appears in the recording: nothing written");
  const file =
    o.state !== undefined
      ? path.join(DESIGN, "data", "sample", "states", `${o.state}.json`)
      : o.to === "sample"
        ? path.join(DESIGN, "data", "sample", "recording.json")
        : path.join(DESIGN, "data", "local", `${recording.name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(
    `recorded ${(workspace.agenda ?? []).length} agenda item(s) (sync ${workspace.sync?.state}) of project ${SAMPLE_PROJECT} (normalized) to ${path.relative(process.cwd(), file)}`,
  );
}

main().catch((e) => {
  console.error(`record: ${e.message}`);
  process.exit(1);
});
