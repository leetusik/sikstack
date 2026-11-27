import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { afterEach, vi } from "vitest";

import ProjectHomePage from "@/app/(app)/projects/[projectId]/page";
import { WorkspacePanel } from "@/app/(app)/projects/[projectId]/parts";
import {
  isMissingProjectStatus,
  libraryRows,
  mintOutcome,
  requestOrigin,
  visibilityOutcome,
  visibilityReducer,
  workspacePart,
  workspaceWords,
  type WorkspacePart,
} from "@/app/(app)/projects/[projectId]/model";
import { MINT_CREDENTIAL_ERRORS } from "@/content/project";
import { railFor } from "@/sikstack/shell/model";
import type { KbOrgLibrary } from "@/lib/knowledge/types";
import type { WorkspaceRead } from "@/lib/workspace/read";
import type { PhaseRow, Workspace } from "@/lib/workspace/types";

// Project home's core rules (job 01 round 03-instrument): the Workspace panel on the project's synced
// workspace (its five newest phases, its agenda's count linking to the Agenda, the way to the Workspace) and the signed sentence
// with the link command for a project not linked; the Library's five newest, a refused visibility
// change, and Not found's statuses.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ requireIdentity: vi.fn() }));
vi.mock("@/lib/knowledge/app", () => ({
  getDocuments: vi.fn(),
  getOrgLibrary: vi.fn(),
  getProjectUsage: vi.fn(),
}));
vi.mock("@/lib/feedback/app", () => ({
  listFeedbackPage: vi.fn(),
  countFeedback: vi.fn(),
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";

/** A phase as the read model lists it, with this host's own names. */
function phase(
  id: string,
  name: string,
  status: string,
  done: number,
  total: number,
  current: string | null = null,
): PhaseRow {
  return {
    id,
    short: id.split("-")[0],
    name,
    objective: null,
    status,
    created: "2026-11-13T10:23:44+09:00",
    started: null,
    completed: null,
    archived: false,
    stream: "default",
    done,
    total,
    current,
    gate: {
      state: "required",
      note: null,
      walkthrough: [],
      words: null,
      cleared: null,
    },
    review: { verdict: null, note: null },
    branches: [],
    agenda: null,
  };
}

/** Newest first, the pointer's phase leading, as `GET …/workspace` orders them. */
const PHASES: PhaseRow[] = [
  phase("P67-b1", "Apply sikstack: Workspace", "in_progress", 4, 18, "S5"),
  phase("P69-qw", "Landing feedback", "done", 6, 6),
  phase("P68-jf", "Assistant on the Claude API", "planned", 0, 0),
  phase("P66-zx", "웹에서 에이전다 고치기", "pending", 7, 9, "REVIEW"),
  phase("P65-nh", "Apply sikstack: Feedback", "in_review", 9, 9),
  phase("P64-3y", "Apply sikstack: Listen and Review", "blocked", 2, 8, "S3"),
];

/** An agenda row as the read lists it; only its state counts on the panel. */
const item = (id: string, state: string) => ({ id, state });

const WORKSPACE = {
  project: PROJECT,
  linked: true,
  version: "97",
  sync: { state: "fresh", at: "2026-11-18T08:40:00Z" },
  streams: [],
  pointer: { phase: "P67-b1", slice: "P67-b1.S5", next: null, waiting: [] },
  phases: PHASES,
  docs: [],
  retired: [],
  agenda: [
    item("A9-k2", "proposed"),
    item("A8-p4", "proposed"),
    item("A7-m3", "in_progress"),
    ...Array.from({ length: 3 }, (_, i) => item(`A${3 + i}-x${i}`, "open")),
    item("A2-d1", "deferred"),
    item("A1-s0", "solved"),
    item("A0-q9", "dropped"),
  ],
  unplaced: [],
} as unknown as Workspace;

/** The same read with each current slice named from its stored `slice.json` (one has no name stored). */
const REFS: Record<string, PhaseRow["currentRef"]> = {
  "P67-b1": {
    id: "S5",
    full: "P67-b1.S5",
    name: "Project home and the rail",
    status: "in_progress",
  },
  "P66-zx": {
    id: "REVIEW",
    full: "P66-zx.REVIEW",
    name: "단계 검토",
    status: "pending",
  },
  "P64-3y": { id: "S3", full: "P64-3y.S3", name: null, status: null },
};
const NAMED = {
  ...WORKSPACE,
  phases: PHASES.map((p) => ({ ...p, currentRef: REFS[p.id] ?? null })),
} as Workspace;

function panel(part: WorkspacePart): string {
  return renderToStaticMarkup(
    createElement(WorkspacePanel, {
      part,
      origin: "https://sikstack.com",
      projectId: PROJECT,
    }),
  );
}

describe("Workspace panel: the current slice by name", () => {
  it("draws `S5 <name>` under the phase's name, a Korean name marked, the id alone without one", () => {
    const part = workspacePart({ state: "ready", value: NAMED }, PROJECT);
    if (part.kind !== "phases") throw new Error(part.kind);
    expect(part.phases.map((p) => [p.slice, p.sliceLang])).toEqual([
      ["S5 Project home and the rail", null],
      [null, null],
      [null, null],
      ["REVIEW 단계 검토", "ko"],
      [null, null],
    ]);
    const html = panel(part);
    expect(html).toContain(
      '<span class="meta ph-sub">S5 Project home and the rail</span>',
    );
    expect(html).toContain(
      '<span class="meta ph-sub" lang="ko">REVIEW 단계 검토</span>',
    );
    const sixth = workspacePart(
      { state: "ready", value: { ...NAMED, phases: NAMED.phases.slice(5) } },
      PROJECT,
    );
    if (sixth.kind !== "phases") throw new Error(sixth.kind);
    expect(sixth.phases[0].slice).toBe("S3"); // no stored name: the short id alone
  });
});

describe("Workspace panel: linked and synced", () => {
  const part = workspacePart({ state: "ready", value: WORKSPACE }, PROJECT);

  it("lists the five newest phases in the read's order, with the agenda's count as the head's link", () => {
    expect(part.kind).toBe("phases");
    if (part.kind !== "phases") return;
    // Open and In progress together; Proposed apart; Deferred, Solved and Dropped in neither
    expect(part.agenda).toEqual({
      text: "4 open · 2 proposed",
      href: `/projects/${PROJECT}/workspace`,
    });
    expect(part.phases.map((p) => p.id)).toEqual([
      "P67",
      "P69",
      "P68",
      "P66",
      "P65",
    ]);
    expect(part.longest).toBe(18);
    expect(part.all).toBe(`/projects/${PROJECT}/workspace/backlog`);
  });

  it("draws each phase: id, the name as a link to it, its current slice, status, count and steps", () => {
    const html = panel(part);
    expect(html).toContain(
      `<p class="meta"><a class="link" href="/projects/${PROJECT}/workspace">4 open · 2 proposed</a></p>`,
    );
    expect(html).toContain(
      `href="/projects/${PROJECT}/workspace/phases/P67-b1"`,
    );
    expect(html).toContain('<span class="dim ph-id">P67</span>');
    expect(html).toContain(
      '<span class="ph-name-text" lang="en">Apply sikstack: Workspace</span>',
    );
    expect(html).toContain('<span class="meta ph-sub">S5</span>');
    expect(html).toContain(
      '<span class="ph-name-text" lang="ko">웹에서 에이전다 고치기</span>',
    );
    // a done phase shows no current slice
    expect(html.match(/ph-sub/g)).toHaveLength(2);
    expect(html).toContain(
      '<span class="status status-live ph-state">In progress</span>',
    );
    expect(html).toContain(
      '<span class="status status-done ph-state">Done</span>',
    );
    expect(html).toContain(
      '<span class="status status-pending ph-state">Waiting on operator</span>',
    );
    expect(html).toContain('<span class="progress-count">4/18</span>');
    expect(html).toContain('aria-label="4 of 18 slices done, 1 in progress"');
    expect(html).toContain("--steps-n:18");
    expect(html).toContain(
      `<a class="link link-row" href="/projects/${PROJECT}/workspace/backlog">See all in Workspace</a>`,
    );
    expect(html).not.toContain("Coming");
    expect(html).not.toContain("No workspace linked yet.");
    expect(html).not.toContain("P64");
  });

  it("loads with three skeleton rows and no count", () => {
    const html = panel({ kind: "loading" });
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/ph-wait/g)).toHaveLength(3);
    expect(html).not.toContain("No workspace linked yet.");
    expect(html).not.toContain("Coming");
    expect(html).not.toContain('class="meta"');
  });
});

describe("Project home's reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the Workspace once and hands the panel its phases", async () => {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
    const headers = await import("next/headers");
    const store = { get: () => undefined };
    vi.mocked(headers.cookies).mockResolvedValue(store as never);
    vi.mocked(headers.headers).mockResolvedValue(
      new Headers({
        host: "sikstack.com",
        "x-forwarded-proto": "https",
      }) as never,
    );
    const guards = await import("@/lib/auth-guards");
    vi.mocked(guards.requireIdentity).mockResolvedValue({
      token: "session-token",
      identity: { tenant: null },
    } as never);
    const app = await import("@/lib/knowledge/app");
    vi.mocked(app.getProjectUsage).mockResolvedValue({
      project: {
        id: PROJECT,
        name: "platform",
        visibility: "private",
        created_at: "2026-03-02T01:30:00Z",
      },
      totals: { documents_created: 0, searches: 0, documents_deleted: 0 },
      daily_counts: [],
      credentials: [],
    } as never);
    vi.mocked(app.getDocuments).mockResolvedValue({ total: 0 } as never);
    const feedback = await import("@/lib/feedback/app");
    vi.mocked(feedback.listFeedbackPage).mockResolvedValue({
      records: [],
      total: 0,
    } as never);
    vi.mocked(feedback.countFeedback).mockResolvedValue(0);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify(NAMED), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const page = await ProjectHomePage({
      params: Promise.resolve({ projectId: PROJECT }),
    });
    const found = findElement(page, WorkspacePanel);
    // The Workspace once, and nothing else: the role read went with the head's switch (P88-ms: Project settings').
    expect(calls).toEqual([`http://kb.test:8766/app/projects/${PROJECT}/workspace`]);
    expect(found?.props.part).toEqual(
      workspacePart({ state: "ready", value: NAMED }, PROJECT),
    );
    const part = found?.props.part as WorkspacePart;
    expect(part.kind === "phases" && part.phases[0].slice).toBe(
      "S5 Project home and the rail",
    );
  });
});

/** The first element of a type in a server render's tree. */
function findElement(
  node: unknown,
  type: unknown,
): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) return { props: el.props };
  return el.props ? findElement(el.props.children, type) : null;
}

describe("Workspace panel: not linked", () => {
  it("reads the signed sentence with the link command for this origin and project", () => {
    const w = workspaceWords({
      origin: "https://sikstack.com",
      projectId: "p_42",
    });
    expect(w.empty).toBe("No workspace linked yet.");
    expect(w.run).toEqual({
      before: "Run ",
      command:
        "sikstack link https://sikstack.com/projects/p_42",
      after: " in a terminal, in the project’s repo, and paste a Workspace sync key from Keys when it asks.",
    });
    expect(w).not.toHaveProperty("badge");
  });

  it("takes the origin from the request, behind a proxy or not", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(
      requestOrigin(h({ host: "sikstack.com", "x-forwarded-proto": "https" })),
    ).toBe("https://sikstack.com");
    expect(requestOrigin(h({ host: "127.0.0.1:3030" }))).toBe(
      "http://127.0.0.1:3030",
    );
    expect(
      requestOrigin(
        h({
          host: "internal:3000",
          "x-forwarded-host": "staging.sikstack.com",
          "x-forwarded-proto": "https,http",
        }),
      ),
    ).toBe("https://staging.sikstack.com");
    expect(requestOrigin(h({}))).toBeNull();
  });

  it("lets the link command, and only it, break anywhere inside its card", () => {
    // A self-hosted origin with a port is one run longer than a phone's card; `.ui`'s keep-all
    // would otherwise push the page sideways.
    const html = renderToStaticMarkup(
      createElement(WorkspacePanel, {
        part: { kind: "link" },
        origin: "http://kb.example.test:60592",
        projectId: "f4cd8de2-2872-45a5-a975-a964542f1dbc",
      }),
    );
    const codes = [...html.matchAll(/<code\b[^>]*>/g)].map((m) => m[0]);
    expect(codes).toEqual(['<code class="mono ph-cmd">']);
    const css = readFileSync(
      join(
        __dirname,
        "..",
        "src/app/(app)/projects/[projectId]/project-home.css",
      ),
      "utf8",
    );
    const rules = (css.match(/\.ph-cmd\s*\{[^}]*\}/g) ?? []).map((r) =>
      r.replace(/\s+/g, " "),
    );
    expect(rules).toEqual([".ph-cmd { overflow-wrap: anywhere; }"]);
  });

  it("keeps the sentence for a project not linked, never synced or not found, and drops Coming", () => {
    const head = { version: null, sync: { state: "unlinked", at: null } };
    for (const read of [
      { state: "unlinked", head },
      { state: "never", head: { ...head, sync: { state: "never", at: null } } },
      { state: "not-found" },
    ] as WorkspaceRead[]) {
      const part = workspacePart(read, PROJECT);
      expect(part).toEqual({ kind: "link" });
      const html = panel(part);
      expect(html).toContain("No workspace linked yet.");
      expect(html).toContain(
        `<code class="mono ph-cmd">sikstack link https://sikstack.com/projects/${PROJECT}</code>`,
      );
      expect(html).not.toContain("Coming");
      expect(html).not.toContain("See all in Workspace");
      expect(html).not.toContain('class="meta"');
    }
  });

  it("leaves no placeholder in the shipped words", () => {
    const sources = [
      "src/content/project.ts",
      "src/app/(app)/projects/[projectId]/parts.tsx",
      "src/app/(app)/projects/[projectId]/model.ts",
    ].map((f) => readFileSync(join(__dirname, "..", f), "utf8"));
    for (const s of sources) expect(s).not.toContain("[LINK COMMAND]");
  });
});

const variant = (doc: string) => ({
  lang: "en",
  doc,
  doc_id: 1,
  title: "x",
  version: 1,
  format: "native" as const,
});

const doc = (id: number, date: string, project = "platform") => ({
  id,
  project,
  slug: `d${id}`,
  doc: `${date}-d${id}`,
  title: `Doc ${id}`,
  date,
  format: "md" as const,
  lang: id === 2 ? "ko" : "en",
  version: 1,
  subject: null,
  canonical_path: null,
});

const listing: KbOrgLibrary = {
  org: { id: "t1", slug: "june", name: "Personal", label: "june" },
  member: true,
  projects: [{ name: "platform", visibility: "private" }],
  books: [
    {
      project: "platform",
      slug: "handbook",
      title: "The platform handbook",
      kind: "codebase",
      subject: null,
      chapters: Array.from({ length: 14 }, (_, i) => ({
        key: `c${i}`,
        position: i,
        title: null,
        variants: [
          variant(`2026-11-${String(i < 13 ? 1 : 10).padStart(2, "0")}-c${i}`),
        ],
      })),
    },
  ],
  documents: [
    doc(1, "2026-11-14"),
    doc(2, "2026-11-12"),
    doc(3, "2026-11-09"),
    doc(4, "2026-11-06"),
    doc(5, "2026-10-01"),
    doc(6, "2026-11-15", "vocky"),
    doc(7, "2026-09-01"),
  ],
};

describe("Library panel", () => {
  it("lists at most five of the project's rows, newest first", () => {
    const rows = libraryRows(listing, "platform");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-11-14",
      "2026-11-12",
      "2026-11-10",
      "2026-11-09",
      "2026-11-06",
    ]);
    expect(rows.some((r) => r.title === "Doc 6")).toBe(false);
    expect(rows[1].lang).toBe("ko");
  });

  it("gives a book its badge, its chapter count and its link", () => {
    const book = libraryRows(listing, "platform").find((r) => r.book);
    expect(book).toBeDefined();
    expect(book?.title).toBe("The platform handbook");
    expect(book?.length).toBe("14 chapters");
    expect(book?.href).toBe("/@june/platform/books/handbook");
  });
});

describe("Head: visibility", () => {
  it("a refused change shows the not-saved state and keeps the shown visibility", () => {
    const saving = visibilityReducer(
      { visibility: "private", phase: "idle" },
      { type: "press" },
    );
    expect(saving).toEqual({ visibility: "private", phase: "saving" });
    const answer = visibilityOutcome({
      error: "Could not update visibility. Please try again.",
    });
    expect(answer).toBe("refused");
    expect(visibilityReducer(saving, { type: answer })).toEqual({
      visibility: "private",
      phase: "failed",
    });
  });

  it("a second press while saving does nothing; a saved change flips", () => {
    const saving = { visibility: "private", phase: "saving" } as const;
    expect(visibilityReducer(saving, { type: "press" })).toBe(saving);
    expect(
      visibilityReducer(saving, { type: visibilityOutcome({ error: null }) }),
    ).toEqual({ visibility: "public", phase: "idle" });
  });

  it("takes the server's visibility on a refresh, unless a change is being saved", () => {
    const shown = { visibility: "public", phase: "idle" } as const;
    expect(
      visibilityReducer(shown, { type: "sync", visibility: "private" }),
    ).toEqual({ visibility: "private", phase: "idle" });
    expect(
      visibilityReducer(shown, { type: "sync", visibility: "public" }),
    ).toBe(shown);
    const saving = { visibility: "public", phase: "saving" } as const;
    expect(
      visibilityReducer(saving, { type: "sync", visibility: "private" }),
    ).toBe(saving);
  });
});

describe("Not found", () => {
  it("draws the Shell with no project and no rail item current", () => {
    const rail = railFor("/projects/no-such-project", false);
    expect(rail.form).toBe("org");
    expect([...rail.items, rail.review].some((i) => i.current)).toBe(false);
    expect(railFor("/projects/p1", true).form).toBe("project");
  });

  it("maps a missing, foreign or malformed id to Not found, and nothing else", () => {
    for (const s of [404, 400, 422])
      expect(isMissingProjectStatus(s)).toBe(true);
    for (const s of [401, 403, 500, 502])
      expect(isMissingProjectStatus(s)).toBe(false);
  });
});

describe("Keys: mint answer", () => {
  it("maps the kept action's answers to Keys' result", () => {
    expect(mintOutcome({ error: null, key: "vk_x", ok: 1 })).toEqual({
      ok: true,
      key: "vk_x",
    });
    expect(mintOutcome({ error: MINT_CREDENTIAL_ERRORS.invalidName })).toEqual({
      ok: false,
      reason: "invalid-name",
    });
    expect(mintOutcome({ error: MINT_CREDENTIAL_ERRORS.generic })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

describe("Workspace panel: the items its head counts (P78, F16)", () => {
  it("lists Open and In progress first, then Proposed, at most five, each a link to its page", () => {
    const part = workspacePart({ state: "ready", value: WORKSPACE }, PROJECT);
    if (part.kind !== "phases") throw new Error(part.kind);
    expect(part.items.map((i) => [i.id, i.state])).toEqual([
      ["A7-m3", "in_progress"],
      ["A3-x0", "open"],
      ["A4-x1", "open"],
      ["A5-x2", "open"],
      ["A9-k2", "proposed"],
    ]);
    const html = panel(part);
    expect(html).toContain(
      `href="/projects/${PROJECT}/workspace/agenda/A7-m3"`,
    );
    expect(html).not.toContain("A2-d1");
  });

  it("an empty workspace says so in one line, never an empty card", () => {
    const empty = { ...WORKSPACE, phases: [], agenda: [] } as Workspace;
    const part = workspacePart({ state: "ready", value: empty }, PROJECT);
    if (part.kind !== "phases") throw new Error(part.kind);
    expect(part.items).toEqual([]);
    expect(panel(part)).toContain(
      "Nothing open on the agenda, and no phases yet.",
    );
    expect(
      panel(workspacePart({ state: "ready", value: WORKSPACE }, PROJECT)),
    ).not.toContain("Nothing open on the agenda");
  });
});
