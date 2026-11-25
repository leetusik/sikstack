import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  Gate,
  PhaseRow,
  SliceName,
  Waiting,
  Workspace,
} from "@/lib/workspace/types";

// The backlog (job 02, `Backlog*.dc.html`, frame.md F304): what waits on the operator, Now, the phases in play
// and the archived ones ten a page, from the Workspace's one read and the address.

vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({
    token: "session-token",
    identity: { tenant: { id: "t1", slug: "june", name: "Personal" } },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(
    async () =>
      new Headers({ host: "sikstack.localhost", "x-forwarded-proto": "https" }),
  ),
}));
vi.mock("next/navigation", async (real) => ({
  ...(await real<typeof import("next/navigation")>()),
  useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
  useParams: () => ({ projectId: PROJECT }),
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const BASE = `/projects/${PROJECT}/workspace`;

const { backlogView, idleSentence, askedPage } =
  await import("@/sikstack/workspace/backlog");
const { BacklogNow, BacklogPhases, BacklogWaiting } =
  await import("@/sikstack/workspace/backlog");
const BacklogPage = (
  await import("@/app/(app)/projects/[projectId]/workspace/backlog/page")
).default;

// -- a fixture that reads like this host's own workspace ----------------------------------------

const GATE: Gate = {
  state: "not_required",
  note: null,
  walkthrough: [],
  words: null,
  cleared: null,
};

let n = 0;
function phase(
  id: string,
  name: string,
  status: string,
  done: number,
  total: number,
  more: Partial<PhaseRow> = {},
): PhaseRow {
  n += 1;
  return {
    id,
    short: id.split("-")[0],
    name,
    objective: null,
    status,
    created: `2026-11-${String(1 + (n % 17)).padStart(2, "0")}`,
    started: null,
    completed: null,
    archived: false,
    stream: "default",
    done,
    total,
    current: null,
    gate: GATE,
    review: { verdict: status === "done" ? "pass" : null, note: null },
    branches: [],
    agenda: null,
    ...more,
  };
}

const LIVE: PhaseRow[] = [
  phase("P12-q4", "Apply sikstack: Workspace", "in_progress", 9, 18, {
    current: "S9",
  }),
  phase("P13-r2", "The assistant on the Workspace", "planned", 0, 1),
  phase("P11-k9", "Apply sikstack: Feedback", "pending", 12, 12, {
    gate: { ...GATE, state: "open" },
  }),
  phase("P10-d6", "Apply sikstack: Library", "in_review", 16, 16),
  phase("P9-c7", "Workspace sync to the cloud", "done", 8, 8),
  phase("P7-m3", "검색 결과를 문단까지", "blocked", 2, 5, { current: "S3" }),
];

const ARCHIVE_NAMES = [
  "Three repos under one host",
  "Blind code reader",
  "PR lifecycle",
  "PR rule v1",
  "Loop phases",
  "Explain pointers",
  "Per-page design rounds",
  "Clean reads",
  "Private update press",
  "Ids with a tail",
  "Rotate the backlog",
  "Drafter model per phase",
  "One platform at sikstack.com",
  "Reader bookmark sync",
  "Sign-in lands on org home",
  "Search relevance tuning",
  "Usage metering export",
  "Capture deduplication",
  "Document export to Markdown",
  "Reader font and width settings",
  "Search index rebuild",
  "Feedback rating scale",
  "Owner alert digest",
];
/** Twenty-three archived phases, newest first: three pages of ten, the last of three. */
const ARCHIVED: PhaseRow[] = ARCHIVE_NAMES.map((name, i) =>
  phase(`P${55 - i}-a${i % 10}`, name, "done", 3 + (i % 4), 3 + (i % 4), {
    archived: true,
  }),
);
// the longest archived phase: longer than any phase in play
ARCHIVED[4] = { ...ARCHIVED[4], done: 24, total: 24 };

const WAITING: Waiting[] = [
  {
    type: "stop",
    phase: "P12-q4",
    slice: "P12-q4.S14",
    kind: "operator-action",
    what: null,
    words: "fill the Operator Runtime, then say go",
  },
  {
    type: "gate",
    phase: "P11-k9",
    slice: null,
    kind: null,
    what: null,
    words: null,
  },
  {
    type: "stop",
    phase: "P7-m3",
    slice: "P7-m3.S3",
    kind: "decision",
    what: null,
    words: "keep the old index until P7-m3.S4 lands",
  },
];

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    project: PROJECT,
    linked: true,
    version: "97",
    sync: { state: "fresh", at: "2026-11-18T08:40:00Z" },
    streams: [
      {
        id: "default",
        label: null,
        branch: null,
        phase: "P12-q4",
        slice: "P12-q4.S9",
      },
    ],
    pointer: {
      phase: "P12-q4",
      slice: "P12-q4.S9",
      next: "P12-q4.S10",
      waiting: WAITING,
    },
    phases: [...LIVE, ...ARCHIVED],
    docs: [],
    retired: [],
    agenda: [],
    unplaced: [],
    ...over,
  };
}

// -- the model -----------------------------------------------------------------------------------

describe("the phases and the archived phases (F304)", () => {
  it("leave archived phases out of Phases and count only the phases in play", () => {
    const v = backlogView(workspace(), PROJECT);
    expect(v.phases.rows.map((r) => r.id)).toEqual(LIVE.map((p) => p.id));
    expect(v.phases.count).toBe("6 phases");
    expect(v.archived?.count).toBe("23 phases");
  });

  it("page the archived phases at ten, the page from the address", () => {
    const first = backlogView(workspace(), PROJECT, 1).archived!;
    expect(first.rows.map((r) => r.id)).toEqual(
      ARCHIVED.slice(0, 10).map((p) => p.id),
    );
    expect([first.page, first.pages, first.total]).toEqual([1, 3, 23]);
    const last = backlogView(workspace(), PROJECT, 3).archived!;
    expect(last.rows.map((r) => r.id)).toEqual(
      ARCHIVED.slice(20).map((p) => p.id),
    );
    // a page past the last is the last; nothing below 1
    expect(backlogView(workspace(), PROJECT, 99).archived!.page).toBe(3);
    expect(backlogView(workspace(), PROJECT, 0).archived!.page).toBe(1);
  });

  it("read the page from ?archived=N only, 1-based", () => {
    expect(askedPage("3")).toBe(3);
    expect(askedPage(["2", "5"])).toBe(2);
    for (const bad of [undefined, "", "0", "-2", "2.5", "x", "01"])
      expect(askedPage(bad)).toBe(1);
  });

  it("draw no Archived phases panel with no archived phase", () => {
    expect(
      backlogView(workspace({ phases: LIVE }), PROJECT).archived,
    ).toBeNull();
  });

  it("give each panel its own longest phase as --steps-n", () => {
    const v = backlogView(workspace(), PROJECT);
    expect(v.phases.longest).toBe(18);
    expect(v.archived!.longest).toBe(24);
    const html = renderToStaticMarkup(
      BacklogPhases({
        phases: v.phases,
        archived: v.archived,
        project: PROJECT,
      }),
    );
    const widths = [
      ...html.matchAll(/ws-list backlog-phases" style="--steps-n:(\d+)/g),
    ].map((m) => Number(m[1]));
    expect(widths).toEqual([18, 24]);
  });

  it("carry the archived page on a phase's link, and the pager to ?archived=N", () => {
    const v = backlogView(workspace(), PROJECT, 2);
    expect(v.phases.rows[0].href).toBe(
      `${BASE}/phases/P12-q4?from=${encodeURIComponent(`${BASE}/backlog?archived=2`)}`,
    );
    expect(backlogView(workspace(), PROJECT, 1).phases.rows[0].href).toBe(
      `${BASE}/phases/P12-q4`,
    );
    const html = renderToStaticMarkup(
      BacklogPhases({
        phases: v.phases,
        archived: v.archived,
        project: PROJECT,
      }),
    );
    expect(html).toContain('aria-label="Archived phases, pages"');
    expect(html).toContain(`href="${BASE}/backlog?archived=3"`);
    expect(html).toContain(`href="${BASE}/backlog"`); // page 1 is no key
    expect(html).toContain("11–20 of 23");
  });

  it("draw a row's current slice while it is not done, its verdict and its progress", () => {
    const rows = backlogView(workspace(), PROJECT).phases.rows;
    expect(rows[0].sub).toBe("S9");
    expect(rows[0].verdict.word).toBe("Not reviewed");
    expect(rows[0].steps).toEqual({ done: 9, total: 18, live: true });
    expect(rows[4].verdict.word).toBe("Pass");
    expect(rows[5].lang).toBe("ko");
    const html = renderToStaticMarkup(
      BacklogPhases({
        phases: { ...backlogView(workspace(), PROJECT).phases },
        archived: null,
        project: PROJECT,
      }),
    );
    expect(html).toContain('<span class="backlog-k">Review</span>');
    expect(html).toContain('aria-label="9 of 18 slices done, 1 in progress"');
    expect(html).not.toMatch(/\btrack\b/);
  });
});

describe("what waits on the operator (F83)", () => {
  it("lists what waits in the read's order: a stop opens its slice, a gate its phase", () => {
    const w = backlogView(workspace(), PROJECT).waiting;
    expect(w.map((x) => [x.type, x.id, x.href])).toEqual([
      ["stop", "P12-q4.S14", `${BASE}/slices/P12-q4.S14`],
      ["gate", "P11-k9", `${BASE}/phases/P11-k9`],
      ["stop", "P7-m3.S3", `${BASE}/slices/P7-m3.S3`],
    ]);
    expect(w.map((x) => x.kind)).toEqual(["Operator action", null, "Decision"]);
    expect(w[1].name).toBe("Apply sikstack: Feedback");
    expect(w[1].words).toBe("“accept” clears the gate and closes the phase.");
    expect(w[0].words).toBe("fill the Operator Runtime, then say go");
    expect(w.every((x) => x.what === null)).toBe(true);
  });

  it("draws the kind as a badge and the words in ink-2, no sentence the read lacks, ids kept whole", () => {
    const html = renderToStaticMarkup(
      BacklogWaiting({ items: backlogView(workspace(), PROJECT).waiting }),
    );
    expect(html).toContain(
      '<span class="status status-pending">Waiting on operator</span>',
    );
    expect(html.match(/<li class="row backlog-wait">/g)).toHaveLength(3);
    expect(html).toContain('<span class="badge">Decision</span>');
    expect(html).toContain('<span class="ws-nobr">P7-m3.S4</span>');
    expect(html.match(/<p>/g)).toBeNull();
    expect(renderToStaticMarkup(BacklogWaiting({ items: [] }))).toBe("");
  });
});

describe("Now", () => {
  it("draws the stream's Phase, Slice and Next as links, and the phase's status and progress", () => {
    const now = backlogView(workspace(), PROJECT).now;
    expect(now.blocks).toHaveLength(1);
    expect(now.blocks[0].cells.map((c) => [c.label, c.id, c.href])).toEqual([
      ["Phase", "P12-q4", `${BASE}/phases/P12-q4`],
      ["Slice", "P12-q4.S9", `${BASE}/slices/P12-q4.S9`],
      ["Next", "P12-q4.S10", `${BASE}/slices/P12-q4.S10`],
    ]);
    expect(now.blocks[0].cells[0].status?.word).toBe("In progress");
    expect(now.streams).toBeNull();
    expect(now.none).toBe(false);
    const html = renderToStaticMarkup(BacklogNow({ now }));
    // the deferred jobs are retired (P61-e9): Now names none, and with something waiting it draws no facts row
    expect(html).not.toContain("Deferred jobs");
    expect(html).not.toContain("/workspace/deferred");
    expect(html).not.toContain("backlog-facts");
    expect(html).toContain('class="steps is-compact"');
    expect(html).toContain("--steps-n:18");
    expect(html).not.toContain(">None<");
  });

  it("says Waiting on operator None only when nothing waits", () => {
    const now = backlogView(
      workspace({
        pointer: { phase: null, slice: null, next: null, waiting: [] },
      }),
      PROJECT,
    ).now;
    expect(now.none).toBe(true);
    expect(renderToStaticMarkup(BacklogNow({ now }))).toContain(
      '<dd class="backlog-value is-none"><span class="backlog-ref"><span>None</span></span></dd>',
    );
  });

  it("says one sentence when no stream has a phase, by what the phases are", () => {
    const done = LIVE.map((p) => ({ ...p, status: "done" }));
    expect(idleSentence(done)).toBe(
      "Nothing is in progress. Every phase is done.",
    );
    expect(idleSentence([...done, { status: "planned" }])).toBe(
      "Nothing is in progress. A planned phase starts when it is run in the workspace.",
    );
    expect(idleSentence([{ status: "blocked" }, { status: "done" }])).toBe(
      "Nothing is in progress.",
    );
    expect(idleSentence([])).toBe("Nothing is in progress.");
    const idle = backlogView(
      workspace({
        streams: [
          {
            id: "default",
            label: null,
            branch: null,
            phase: null,
            slice: null,
          },
        ],
      }),
      PROJECT,
    ).now;
    expect(idle.blocks).toEqual([]);
    expect(idle.idle).toBe(
      "Nothing is in progress. A planned phase starts when it is run in the workspace.",
    );
  });

  it("names each stream and counts them only with two or more", () => {
    const now = backlogView(
      workspace({
        streams: [
          {
            id: "default",
            label: "Default stream",
            branch: "main",
            phase: "P12-q4",
            slice: null,
          },
          {
            id: "w1",
            label: "Feedback",
            branch: "feat/sikstack-feedback",
            phase: "P11-k9",
            slice: null,
          },
        ],
      }),
      PROJECT,
    ).now;
    expect(now.streams).toBe("2 streams");
    expect(now.blocks[1].cells.map((c) => c.label)).toEqual(["Phase"]);
    expect(renderToStaticMarkup(BacklogNow({ now }))).toContain(
      "<h3>Feedback</h3>",
    );
  });
});

// -- slices by name --------------------------------------------------------------------------------

const S9: SliceName = {
  id: "S9",
  full: "P12-q4.S9",
  name: "The backlog page",
  status: "in_progress",
};
const S14: SliceName = {
  id: "S14",
  full: "P12-q4.S14",
  name: "Fidelity: the Agenda and its item",
  status: "pending",
};
const KO_S3: SliceName = {
  id: "S3",
  full: "P7-m3.S3",
  name: "색인을 문단 단위로 다시 만들기",
  status: "pending",
};
/** The next slice has no stored `slice.json` yet: the read names it, with no name or status. */
const S10: SliceName = {
  id: "S10",
  full: "P12-q4.S10",
  name: null,
  status: null,
};

/** The same workspace, read with each slice it names carrying its stored name and status. */
function named(): Workspace {
  const ws = workspace();
  const refs: Record<string, SliceName> = {
    [S14.full]: S14,
    [KO_S3.full]: KO_S3,
  };
  return {
    ...ws,
    streams: ws.streams.map((s) => ({ ...s, sliceRef: S9 })),
    pointer: {
      ...ws.pointer,
      sliceRef: S9,
      nextRef: S10,
      waiting: ws.pointer.waiting.map((w) => ({
        ...w,
        sliceRef: w.slice ? refs[w.slice] : null,
      })),
    },
    phases: ws.phases.map((p) =>
      p.id === "P12-q4"
        ? { ...p, currentRef: S9 }
        : p.id === "P7-m3"
          ? { ...p, currentRef: KO_S3 }
          : { ...p, currentRef: null },
    ),
  };
}

describe("slices by their stored name and status", () => {
  it("draws Now's Slice and Next by id and name, each with its status", () => {
    const cells = backlogView(named(), PROJECT).now.blocks[0].cells;
    expect(
      cells
        .slice(1)
        .map((c) => [c.label, c.id, c.name, c.status?.word ?? null]),
    ).toEqual([
      ["Slice", "P12-q4.S9", "The backlog page", "In progress"],
      ["Next", "P12-q4.S10", null, null],
    ]);
    const html = renderToStaticMarkup(
      BacklogNow({ now: backlogView(named(), PROJECT).now }),
    );
    expect(html).toContain(
      '<span class="ws-id">P12-q4.S9</span><span lang="en">The backlog page</span>',
    );
    expect(html).toContain(
      '<span class="status status-live">In progress</span>',
    );
    // a slice the store has no record of: the id alone, no status
    expect(html).toContain(
      '<span class="backlog-ref"><span class="ws-id">P12-q4.S10</span></span>',
    );
  });

  it("names a stopped slice in Waiting on operator, a Korean one marked", () => {
    const w = backlogView(named(), PROJECT).waiting;
    expect(w.map((x) => [x.id, x.name, x.lang])).toEqual([
      ["P12-q4.S14", "Fidelity: the Agenda and its item", "en"],
      ["P11-k9", "Apply sikstack: Feedback", "en"],
      ["P7-m3.S3", "색인을 문단 단위로 다시 만들기", "ko"],
    ]);
    const html = renderToStaticMarkup(BacklogWaiting({ items: w }));
    expect(html).toContain(
      '<span lang="ko">색인을 문단 단위로 다시 만들기</span>',
    );
  });

  it("draws a phase row's current slice as `S9 <name>`, the id alone without one", () => {
    const rows = backlogView(named(), PROJECT).phases.rows;
    expect([rows[0].sub, rows[0].subLang]).toEqual([
      "S9 The backlog page",
      "en",
    ]);
    expect([rows[5].sub, rows[5].subLang]).toEqual([
      "S3 색인을 문단 단위로 다시 만들기",
      "ko",
    ]);
    const html = renderToStaticMarkup(
      BacklogPhases({
        phases: backlogView(named(), PROJECT).phases,
        archived: null,
        project: PROJECT,
      }),
    );
    expect(html).toContain(
      '<span class="meta ws-sub" lang="ko">S3 색인을 문단 단위로 다시 만들기</span>',
    );
    // an older read (no refs): the short id, as before
    expect(backlogView(workspace(), PROJECT).phases.rows[0].sub).toBe("S9");
  });
});

// -- the page ------------------------------------------------------------------------------------

function api(answer: { status: number; body: unknown }): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

async function page(archived?: string): Promise<string> {
  const el = await BacklogPage({
    params: Promise.resolve({ projectId: PROJECT }),
    searchParams: Promise.resolve(archived ? { archived } : {}),
  });
  return renderToStaticMarkup(el);
}

beforeAll(() => {
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the backlog page", () => {
  it("makes one read, the Workspace's, and draws its four parts in order", async () => {
    const calls = api({ status: 200, body: workspace() });
    const html = await page("3");
    expect(calls).toEqual([
      `http://kb.test:8766/app/projects/${PROJECT}/workspace`,
    ]);
    const at = (s: string) => html.indexOf(s);
    expect(at('aria-label="Waiting on operator"')).toBeGreaterThan(-1);
    expect(at('aria-label="Waiting on operator"')).toBeLessThan(
      at('aria-label="Now"'),
    );
    expect(at('aria-label="Now"')).toBeLessThan(at(">Phases</h2>"));
    expect(at(">Phases</h2>")).toBeLessThan(at(">Archived phases</h2>"));
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("21–23 of 23");
  });

  it("draws the slices' names from that one read", async () => {
    const calls = api({ status: 200, body: named() });
    const html = await page();
    expect(calls).toHaveLength(1);
    expect(html).toContain(">The backlog page</span>");
    expect(html).toContain(">S9 The backlog page</span>");
    expect(html).toContain(">Fidelity: the Agenda and its item</span>");
  });

  it("draws only WsNav's panel for a workspace not linked", async () => {
    api({
      status: 200,
      body: {
        project: PROJECT,
        linked: false,
        version: null,
        sync: { state: "unlinked", at: null },
      },
    });
    const html = await page();
    expect(html).toContain("No workspace linked yet.");
    expect(html).toContain(
      `sikstack link https://sikstack.localhost/projects/${PROJECT}`,
    );
    expect(html).not.toContain('aria-label="Now"');
  });

  it("keeps Now's head and says the backlog did not load, Phases not drawn", async () => {
    api({
      status: 503,
      body: { detail: "the workspace store is unavailable" },
    });
    const html = await page();
    expect(html).toContain("The backlog did not load.");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain(">Phases</h2>");
  });

  it("is Not found for a project the Workspace does not hold", async () => {
    api({ status: 404, body: { detail: "project not found" } });
    await expect(page()).rejects.toThrow("NOT_FOUND");
  });
});
