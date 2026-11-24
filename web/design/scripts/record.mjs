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
//
// `--feedback <id>` (repeatable) also records each piece of feedback the pages draw: `GET /app/feedback/{id}` (its
// record) and `GET /app/feedback/{id}/agenda` (the agenda items it is on), as the recording's `feedback` part keyed by
// a fixed sample id (`f1`, `f2`, … as `SAMPLE_FEEDBACK`), each real id replaced wherever it appears (an entry's
// `source: feedback:<id>`, its body's `/feedback/<id>`); the account's user id and every email become sample ones.
// Without `--state`, a recording to `sample` keeps the file's `design` part as it is (`--design` writes it).
//
// `--design` records the Design service's answers instead of the Workspace's: `GET /app/projects/{id}/design/builds`,
// each `GET …/design/builds/{build}`, and, for each private build, the one line `POST …/{build}/share {on: true}`
// answers (a 409: nothing changes). `--gone <build>` adds the 404 a deleted build's address answers. Without
// `--state`, they go into the recording named by `--to` as its `design` part, the rest of the file kept as it
// is; with `--state <name>`, the list alone goes to `design/data/sample/states/<name>.json`. A share link's
// token is replaced by a fixed one (`SHARE_TOKEN`), like the project id.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESIGN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "sikstack-design-build"; // lib/mark.ts
const SAMPLE_PROJECT = "00000000-0000-4000-8000-000000000001";
const SAMPLE_ORG = "00000000-0000-4000-8000-0000000000a1";
const ANCHOR = Date.parse("2026-11-20T09:00:00Z");
const DAY = 86_400_000;
/** What a recorded share link's token becomes: a recording never holds a link that opened a build. */
const SHARE_TOKEN = "sampleshareTOKEN";
/** What a build's `published_from` (the publishing machine's name) becomes: never the account's machine. */
const SAMPLE_CHECKOUT = "sample-checkout";
/** The n-th recorded piece of feedback's id (1-based). */
const SAMPLE_FEEDBACK = (n) => `00000000-0000-4000-8000-0000000000f${n}`;
/** What the account's user id becomes. */
const SAMPLE_USER = "00000000-0000-4000-8000-0000000000b1";
/** What every email becomes: a recording never holds an account's address. */
const SAMPLE_EMAIL = "design@example.invalid";

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
    else if (k === "--feedback") (out.feedback ??= []).push(v);
    else if (k === "--design") {
      out.design = true;
      i--;
    } else if (k === "--gone") out.gone = v;
    else throw new Error(`unknown argument ${k}`);
    i++;
  }
  if (!out.project) throw new Error("--project <id> is required");
  if (out.to !== "sample" && !/^local\/[a-z0-9][a-z0-9-]*$/.test(out.to))
    throw new Error("--to takes sample or local/<name> (lowercase letters, digits, dashes)");
  if (out.state !== undefined && (out.to !== "sample" || !/^[a-z0-9][a-z0-9-]*$/.test(out.state)))
    throw new Error("--state takes a name (lowercase letters, digits, dashes) and records only to sample");
  if (out.gone !== undefined && (!out.design || out.state !== undefined || !/^b[a-z2-7]{25}$/.test(out.gone)))
    throw new Error("--gone takes a build id, with --design and without --state");
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
/** A POST's status and its answer, refused or not. */
async function post(api, route, bearer, body) {
  const res = await fetch(api + route, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

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

/** Every date moved by the same offset, the real project id replaced, in every string; `ids` maps other real ids
 * (a piece of feedback's, the account's) to sample ones, and every email becomes `SAMPLE_EMAIL`. */
function normalizer(projectId, takenAt, timeZone, ids = {}) {
  const shift = ANCHOR - takenAt;
  const days = Math.round(
    (Date.parse(dayIn(ANCHOR, timeZone)) - Date.parse(dayIn(takenAt, timeZone))) / DAY,
  );
  const walk = (v) => {
    if (typeof v === "string") {
      if (CAL.test(v))
        return new Date(Date.parse(`${v}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
      if (INSTANT.test(v)) return new Date(Date.parse(v) + shift).toISOString().replace(/\.\d+Z$/, "Z");
      let out = v.split(projectId).join(SAMPLE_PROJECT);
      for (const [real, sample] of Object.entries(ids)) out = out.split(real).join(sample);
      return out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, SAMPLE_EMAIL);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk;
}

/**
 * Every share link's token replaced by `SHARE_TOKEN` (no recording holds one that opened a build), and every
 * `published_from` by `SAMPLE_CHECKOUT` (the engine sends the machine's name, which may name its owner).
 */
function scrub(v) {
  if (typeof v === "string") return v.replace(/\/_share\/[^/?#\s"]+/g, `/_share/${SHARE_TOKEN}`);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, k === "published_from" && typeof x === "string" ? SAMPLE_CHECKOUT : scrub(x)]),
    );
  return v;
}

/** The Design service's answers for the project: the list, each build as its own route answers it, the refusals. */
async function recordDesign(o, bearer) {
  const base = `/app/projects/${encodeURIComponent(o.project)}/design/builds`;
  const takenAt = Date.now();
  const { builds } = await get(o.api, base, bearer);
  if (!Array.isArray(builds)) throw new Error(`GET ${base} answered no builds list`);
  const norm = normalizer(o.project, takenAt, o.timeZone);
  const design = { builds };
  if (o.state === undefined) {
    design.details = {};
    design.shareRefused = {};
    for (const b of builds) {
      design.details[b.id] = await get(o.api, `${base}/${encodeURIComponent(b.id)}`, bearer);
      if (!b.private) continue;
      const r = await post(o.api, `${base}/${encodeURIComponent(b.id)}/share`, bearer, { on: true });
      if (r.status !== 409 || typeof r.body?.detail !== "string")
        throw new Error(`sharing private build ${b.id} answered ${r.status}, not a 409 line`);
      design.shareRefused[b.id] = r.body.detail;
    }
    if (o.gone !== undefined) {
      const res = await fetch(`${o.api}${base}/${o.gone}`, { headers: { Authorization: `Bearer ${bearer}` } });
      const body = await res.json().catch(() => null);
      if (res.status !== 404) throw new Error(`GET the gone build answered ${res.status}, not 404`);
      design.gone = { build: o.gone, status: res.status, detail: body?.detail ?? null };
    }
  }
  const part = scrub(norm(design));
  const file =
    o.state !== undefined
      ? path.join(DESIGN, "data", "sample", "states", `${o.state}.json`)
      : o.to === "sample"
        ? path.join(DESIGN, "data", "sample", "recording.json")
        : path.join(DESIGN, "data", "local", `${o.to.slice("local/".length)}.json`);
  let out;
  if (o.state !== undefined) {
    out = { $design: MARK, name: o.state, now: new Date(ANCHOR).toISOString().replace(/\.\d+Z$/, "Z"), design: part };
  } else {
    out = JSON.parse(readFileSync(file, "utf8"));
    if (out.$design !== MARK) throw new Error(`${path.relative(process.cwd(), file)} is not a design recording`);
    out.design = part;
    const routes = new Set(out.source?.routes ?? []);
    for (const r of [
      "GET /app/projects/{project}/design/builds",
      "GET /app/projects/{project}/design/builds/{build}",
      "POST /app/projects/{project}/design/builds/{build}/share (a private build's 409)",
    ])
      routes.add(r);
    out.source = { ...out.source, routes: [...routes] };
  }
  const text = `${JSON.stringify(out, null, 2)}\n`;
  if (text.includes(o.project)) throw new Error("the real project id survived normalization: nothing written");
  if (text.includes(bearer)) throw new Error("the token appears in the recording: nothing written");
  for (const b of builds)
    if (b.published_from && text.includes(`"${b.published_from}"`))
      throw new Error("a publishing machine's name survived: nothing written");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(
    `recorded ${builds.length} design build(s) of project ${SAMPLE_PROJECT} (normalized) to ${path.relative(process.cwd(), file)}`,
  );
}

async function main() {
  const o = args(process.argv.slice(2));
  const bearer = token();
  if (o.design) return recordDesign(o, bearer);
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
  // Each piece of feedback the pages draw: its record and the agenda items it is on.
  const feedback = {};
  const ids = {};
  for (const [i, id] of (o.feedback ?? []).entries()) {
    const route = `/app/feedback/${encodeURIComponent(id)}`;
    const { record } = await get(o.api, route, bearer);
    const agenda = await get(o.api, `${route}/agenda`, bearer);
    ids[id] = SAMPLE_FEEDBACK(i + 1);
    if (record.user_id) ids[record.user_id] = SAMPLE_USER;
    feedback[ids[id]] = { record, agenda };
  }
  let project = { name: o.projectName ?? null, visibility: "private", created_at: new Date(takenAt).toISOString() };
  if (!o.projectName) {
    const p = await get(o.api, base, bearer);
    const one = p.project ?? p;
    project = { name: one.name, visibility: one.visibility ?? "private", created_at: one.created_at ?? project.created_at };
  }
  const norm = normalizer(o.project, takenAt, o.timeZone, ids);
  const routes = ["GET /app/projects/{project}/workspace", "GET /app/projects/{project}/workspace/agenda/{item}"];
  if (o.feedback?.length) routes.push("GET /app/feedback/{feedback}", "GET /app/feedback/{feedback}/agenda");
  const recording = {
    $design: MARK,
    name: o.state ?? (o.to === "sample" ? "sample" : o.to.slice("local/".length)),
    now: new Date(ANCHOR).toISOString().replace(/\.\d+Z$/, "Z"),
    timeZone: o.timeZone,
    source: {
      routes,
      note: "project id, feedback ids, the account's id, emails and dates normalized; the Shell's names are fixed",
    },
    shell: norm({
      org: { id: SAMPLE_ORG, name: "Sample org" },
      project,
      email: "design@example.invalid",
    }),
    workspace: norm(workspace),
    items: norm(items),
  };
  if (o.feedback?.length) recording.feedback = norm(feedback);
  const file =
    o.state !== undefined
      ? path.join(DESIGN, "data", "sample", "states", `${o.state}.json`)
      : o.to === "sample"
        ? path.join(DESIGN, "data", "sample", "recording.json")
        : path.join(DESIGN, "data", "local", `${recording.name}.json`);
  // The Design service's part is its own recording (`--design`): a Workspace recording keeps it.
  if (o.state === undefined) {
    try {
      const was = JSON.parse(readFileSync(file, "utf8"));
      if (was.$design === MARK && was.design) {
        recording.design = was.design;
        recording.source.routes = [...new Set([...recording.source.routes, ...(was.source?.routes ?? []).filter((r) => r.includes("/design/"))])];
      }
    } catch {
      // no recording there yet
    }
  }
  const text = `${JSON.stringify(recording, null, 2)}\n`;
  if (text.includes(o.project)) throw new Error("the real project id survived normalization: nothing written");
  if (text.includes(bearer)) throw new Error("the token appears in the recording: nothing written");
  for (const real of Object.keys(ids))
    if (text.includes(real)) throw new Error("a real feedback or account id survived normalization: nothing written");
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
