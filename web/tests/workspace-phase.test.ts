import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import PhasePage from "@/app/(app)/projects/[projectId]/workspace/phases/[phaseId]/page";
import {
  agendaItemOf,
  askedDates,
  DecisionList,
  explainedDocuments,
  gatePlace,
  originalParagraphs,
  PhaseGate,
  PhaseIntent,
  PhaseView,
  pullRequestView,
  sliceSub,
} from "@/sikstack/workspace/phase";
import { wsSyncLine } from "@/sikstack/workspace/frame";
import { dates } from "@/lib/workspace/model";
import type {
  AgendaItem,
  Branch,
  Gate,
  Phase,
  PhaseRow,
  SliceRow,
  WithHead,
  Workspace,
} from "@/lib/workspace/types";

// A phase's page (design job 02, `Phase.dc.html` and its parts; frame.md F48, F83, F306): each branch's pull
// request, the decision stop's line, the notebook's Show all, the gate's place, the operator's words drawn as
// written, and the reads the page makes.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/auth-guards", () => ({ requireIdentity: vi.fn() }));

const PROJECT = "3f6c1d2e-8a4b-4c5d-9e0f-1a2b3c4d5e6f";
const D = dates("Asia/Seoul", Date.parse("2026-11-18T10:00:00+09:00"));
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const count = (text: string, needle: string) => text.split(needle).length - 1;

const slice = (over: Partial<SliceRow> & Pick<SliceRow, "id" | "name" | "kind" | "status">): SliceRow => ({
  full: `P8-q4.${over.id}`,
  phase: "P8-q4",
  risk: "low",
  deps: [],
  started: null,
  completed: null,
  outcome: null,
  stop: null,
  ...over,
});

const DECISIONS = [
  "Breakdown (DECOMP): one pass, eighteen slices: S1 server read-model additions, S2 frame, S3 data and writes.",
  "Run words (operator, 2026-11-18): the run goes on with the recommendations taken by default.",
  "D1 Branch (taken by default): `feat/sikstack-workspace` cut in `platform/` from `feat/workspace-sync`.",
  "D2 Writes (taken by default): the web writes only inbox entries through the inbox routes.",
  "D3 Runtime (taken by default): `p67-runtime` at `p67.localhost:<port>`, its own Postgres.",
  "D4 Gaps (taken by default): S1 adds PR `{number, state, url}`, doc version ordinals and the sync line.",
  "D5 Plugin (taken by default): S1 bumps `plugin.json` 0.16.0 → 0.17.0.",
  "D6 Addresses (taken by default): pages under `/projects/<id>/workspace`.",
  "D7 Decided as drawn: no design round; every open item built as drawn and named for the walk.",
  "D8 Project home and filed jobs (taken by default): the panel reads the workspace once linked.",
  "D9 Shape corrected: the grip, the picked-rows bar and strip and the row's Delete are Agenda-local.",
  "S1 shapes (taken by default): `branches[].pr` is `{number, state, url}` or null.",
  "S2 frame (taken by default): the Workspace layout tokens live in `bundle.css` section 1.",
  "S3 data layer (taken by default): reads answer `{state}` and throw only a 401.",
  "S4 Md (taken by default): raw HTML shows as its text, never rendered, never dropped.",
  "S5 home (taken by default): the rail's Workspace links to the Agenda.",
  "S6 agenda (taken by default): the Deferred part pages at ten.",
  "S8 item (taken by default): Defer and Delete on the item's own page.",
  "S9 backlog (taken by default): Archived phases are their own table.",
  "S10 phase (taken by default): the pull request is a link to GitHub in the same tab.",
].map((text, i) => ({
  id: `D${i + 1}`,
  text,
  slice: i < 11 ? "DECOMP" : `S${i - 10}`,
}));

const ORIGINAL =
  "now workspace pages. **build them as signed** and\n# don't redesign\n\n<b>no blocker</b>, 그대로 만들어 주세요 [link](https://example.com)";

function phase(over: Partial<Phase> = {}): WithHead<Phase> {
  return {
    id: "P8-q4",
    short: "P8",
    name: "Apply sikstack: Workspace",
    objective:
      "Build the signed Workspace pages (design job 02, round 02-agenda-and-links) into the web app, on the read and inbox routes already built.",
    status: "in_progress",
    created: "2026-11-17",
    started: "2026-11-18",
    completed: null,
    archived: false,
    stream: "default",
    done: 5,
    total: 18,
    current: "S10",
    gate: { state: "required", note: null, walkthrough: [], words: null, cleared: null },
    review: { verdict: null, note: null },
    branches: [
      {
        repo: "platform",
        branch: "feat/sikstack-workspace",
        pr: { number: 10, state: "draft", url: "https://github.com/leetusik/sikstack/pull/10" },
      },
    ],
    agenda: "A7-m3",
    intent: {
      original: ORIGINAL,
      confirmed: "## What\n\nThe eight Workspace pages, **as signed**.\n\n- the Agenda\n- 한 단계의 페이지",
    },
    slices: [
      slice({ id: "DECOMP", name: "Decompose the apply phase", kind: "decomposition", status: "done", outcome: "Eighteen slices in one pass; the pages run as one eight-wide wave." }),
      slice({ id: "S1", name: "Server read-model additions", kind: "implementation", status: "done", outcome: "PR numbers and states, doc ordinals and the sync line on every item route." }),
      slice({ id: "S7", name: "The Agenda: reorder and picked rows", kind: "implementation", status: "pending", stop: { kind: "decision", what: null, words: "accept", since: "2026-11-14" } }),
      slice({ id: "S10", name: "단계 페이지", kind: "implementation", status: "in_progress" }),
      slice({ id: "S11", name: "The slice page", kind: "implementation", status: "blocked", stop: { kind: "operator-action", what: null, words: null, since: "2026-11-15" } }),
      slice({ id: "REVIEW", name: "Review the phase", kind: "review", status: "todo" }),
    ],
    notebook: {
      now: "The page wave runs: S5, S6 and S8 to S13 together, then S7 alone.",
      decisions: DECISIONS,
      questions: [
        { id: "Q1", text: "Does a slice list its commits when nothing stores them?", state: "resolved", answer: "Drawn as the signed absent state (OQ1)." },
        { id: "Q2", text: "Does a stop say what it waits for?", state: "open", answer: "" },
      ],
      docImpact: [{ slice: "S1", text: "architecture: the read model returns PR states and doc ordinals." }],
      notes: [{ text: "(from S4, for S10 to S13) Import Md from the frame." }],
      topics: [{ slug: "breakdown", gist: "Breakdown (DECOMP): one pass, eighteen slices." }],
    },
    explain: null,
    workspace: { version: "97", sync: { state: "fresh", at: "2026-11-18T00:58:00Z" } },
    ...over,
  };
}

const line = wsSyncLine({ state: "fresh", at: "2026-11-18T00:58:00Z" }, "97", { timeZone: "Asia/Seoul", now: Date.parse("2026-11-18T10:00:00+09:00") });
const view = (p: Phase, item = null as ReturnType<typeof agendaItemOf>) =>
  html(
    createElement(PhaseView, {
      phase: p,
      back: { href: `/projects/${PROJECT}/workspace/backlog`, label: "Backlog" },
      line,
      item,
      links: {
        slice: (full: string) => `/projects/${PROJECT}/workspace/slices/${full}`,
        item: (id: string) => `/projects/${PROJECT}/workspace/agenda/${id}`,
      },
      dates: D,
    }),
  );

describe("a branch's pull request (F306)", () => {
  const branch = (pr: Branch["pr"]): Branch => ({ repo: "platform", branch: "feat/sikstack-workspace", pr });
  const url = "https://github.com/leetusik/sikstack/pull/38";

  it("reads each state's word in its shape", () => {
    const states = [
      ["draft", "Draft", "status status-idle"],
      ["open", "Open", "status"],
      ["merged", "Merged", "status status-done"],
      ["closed", "Closed", "status status-revoked"],
    ] as const;
    for (const [state, word, cls] of states) {
      const v = pullRequestView(branch({ number: 38, state, url }));
      expect(v).toEqual({
        opened: true,
        href: url,
        text: "Pull request #38",
        label: `Pull request #38 in platform on GitHub, ${word}`,
        state: { word, cls },
      });
    }
  });

  it("draws the link in the same tab with its hit area, then the word; no pull request reads the line", () => {
    const out = view(phase({
      branches: [
        { repo: "platform", branch: "feat/sikstack-workspace", pr: { number: 38, state: "merged", url } },
        { repo: "vocky", branch: "feat/sikstack-feedback", pr: null },
      ],
    }));
    expect(out).toContain(
      `<div class="fact"><dt>Branch in platform</dt><dd class="row-stack"><span>feat/sikstack-workspace</span><span class="phase-pr"><a class="link phase-pr-link" href="${url}" aria-label="Pull request #38 in platform on GitHub, Merged"><span>Pull request #38</span></a><span class="status status-done">Merged</span></span></dd></div>`,
    );
    expect(out).not.toContain("target=");
    expect(out).toContain(
      '<div class="fact"><dt>Branch in vocky</dt><dd class="row-stack"><span>feat/sikstack-feedback</span><span class="meta">Pull request not opened</span></dd></div>',
    );
  });

  it("draws no state word for an unknown state and no link for an address that is not the web's", () => {
    const v = pullRequestView(branch({ number: null, state: null, url: "javascript:alert(1)" }));
    expect(v).toEqual({ opened: true, href: null, text: "Pull request", label: "Pull request in platform on GitHub", state: null });
  });
});

describe("a slice's line under its name (F83)", () => {
  it("reads `Decision asked <date>` for a decision stop only while a question is open", () => {
    const open = phase();
    const asked = askedDates(open, D.date);
    expect(asked).toEqual({ S7: "Nov 14" });
    const s7 = open.slices.find((s) => s.id === "S7")!;
    expect(sliceSub(s7, asked)).toBe("Decision asked Nov 14");
    const out = view(open);
    expect(out).toContain('<span class="meta ws-sub ws-prose">Decision asked Nov 14</span>');
    expect(count(out, "Decision asked")).toBe(1);

    const answered = phase({
      notebook: { ...open.notebook!, questions: open.notebook!.questions.map((q) => ({ ...q, state: "resolved" as const })) },
    });
    expect(askedDates(answered, D.date)).toEqual({});
    expect(view(answered)).not.toContain("Decision asked");
  });

  it("draws the outcome, nothing for a stop with no sentence, and the current slice as the step", () => {
    const out = view(phase());
    expect(out).toContain('<span class="meta ws-sub ws-prose">Eighteen slices in one pass; the pages run as one eight-wide wave.</span>');
    expect(out).toMatch(/<li class="row ws-row" aria-current="step"><span class="ws-id">S10<\/span>/);
    expect(count(out, 'aria-current="step"')).toBe(1);
    expect(out).toContain('<span class="ws-name-text" lang="ko">단계 페이지</span>');
    expect(out).toMatch(/<span class="ws-id">S11<\/span><a [^>]*><span class="row-stack"><span class="ws-name-text">The slice page<\/span><\/span><\/a>/);
    expect(out).toContain('<span class="dim ws-end">Decomposition</span>');
  });
});

describe("the notebook's Decisions", () => {
  it("shows five, then one button whose two labels share one width and say whether all show", () => {
    const closed = html(createElement(DecisionList, { decisions: DECISIONS, expanded: false }));
    expect(count(closed, '<li class="phase-note">')).toBe(5);
    expect(closed).toContain(
      '<button type="button" class="btn" aria-expanded="false" aria-controls="phase-decisions"><span class="swap"><span>Show all 20 decisions</span><span>Show the first 5</span></span></button>',
    );
    const open = html(createElement(DecisionList, { decisions: DECISIONS, expanded: true }));
    expect(count(open, '<li class="phase-note">')).toBe(20);
    expect(open).toContain(
      '<button type="button" class="btn" aria-expanded="true" aria-controls="phase-decisions" data-swap="true"><span class="swap"><span>Show all 20 decisions</span><span>Show the first 5</span></span></button>',
    );
    expect(open).toContain('<span class="dim phase-note-end"><span class="sr-only">Decided in </span>S9</span>');
  });

  it("draws no button at five or fewer", () => {
    const out = html(createElement(DecisionList, { decisions: DECISIONS.slice(0, 5), expanded: false }));
    expect(out).not.toContain("<button");
  });

  it("puts open questions first and arrives closed on the page", () => {
    const out = view(phase());
    expect(out.indexOf(">Q2<")).toBeLessThan(out.indexOf(">Q1<"));
    expect(out).toContain('<span class="status status-pending phase-note-end">Open</span>');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('<span class="strong">topics/breakdown.md</span>');
  });
});

describe("the acceptance gate", () => {
  const gate = (over: Partial<Gate>): Gate => ({ state: null, note: null, walkthrough: [], words: null, cleared: null, ...over });

  it("sits first in the main column while open, in the side while not, and nowhere while undeclared", () => {
    expect(gatePlace(gate({ state: "open" }))).toBe("main");
    expect(gatePlace(gate({ state: "cleared" }))).toBe("side");
    expect(gatePlace(gate({ state: "not_required" }))).toBe("side");
    expect(gatePlace(gate({ state: null }))).toBeNull();
    expect(view(phase({ gate: gate({ state: null }) }))).not.toContain("Acceptance gate");
    const open = view(phase({
      gate: gate({ state: "open", note: "Opened by the review on Nov 14.", walkthrough: ["Open the Agenda.", "Add an item.", "Reload: it reads Waiting for sync."] }),
    }));
    expect(open.indexOf("Acceptance gate")).toBeLessThan(open.indexOf('id="phase-slices-head"'));
    expect(open).toContain('<div class="md"><ol><li>Open the Agenda.</li><li>Add an item.</li><li>Reload: it reads Waiting for sync.</li></ol></div>');
    expect(open).toContain('<p class="strong phase-gate-text">“accept” clears the gate and closes the phase.</p>');
    const side = view(phase({ gate: gate({ state: "required" }) }));
    expect(side.indexOf("Acceptance gate")).toBeGreaterThan(side.indexOf('id="phase-review-head"'));
  });

  it("says when a cleared gate was cleared", () => {
    const out = html(createElement(PhaseGate, { gate: gate({ state: "cleared", cleared: "2026-11-13", note: "Accepted on the walk." }), date: D.date }));
    expect(out).toContain('<span class="status status-done">Cleared</span>');
    expect(out).toContain('<div class="stack gap-2"><p>Cleared on Nov 13.</p><p class="phase-gate-text">Accepted on the walk.</p></div>');
  });
});

describe("Intent", () => {
  it("draws the operator's words as written, never as Markdown", () => {
    expect(originalParagraphs(ORIGINAL)).toEqual([
      ["now workspace pages. **build them as signed** and", "# don't redesign"],
      ["<b>no blocker</b>, 그대로 만들어 주세요 [link](https://example.com)"],
    ]);
    const out = html(createElement(PhaseIntent, { intent: phase().intent }));
    expect(out).toContain(
      '<div class="md"><blockquote><p><span>now workspace pages. **build them as signed** and</span><span><br/># don&#x27;t redesign</span></p><p><span>&lt;b&gt;no blocker&lt;/b&gt;, 그대로 만들어 주세요 [link](https://example.com)</span></p></blockquote></div>',
    );
    // nothing of the words is read: no emphasis, no heading, no HTML, no link
    expect(out).not.toContain("<strong>build them as signed</strong>");
    expect(out).not.toContain("<b>no blocker</b>");
    expect(out).not.toContain('href="https://example.com"');
    expect(count(out, 'class="md-wrap"')).toBe(1);
    // the confirmed intent is Markdown, at the fourth step, anchored for the page
    expect(out).toContain('<div class="md-h1" role="heading" aria-level="4" id="phase-intent-1">What</div>');
    expect(out).toContain("<strong>as signed</strong>");
  });
});

describe("the agenda item", () => {
  const row = (over: Partial<AgendaItem>): AgendaItem => ({
    id: "A7-m3", title: "Workspace pages on sikstack", lang: "en", note: "", state: "open", created: "2026-11-12",
    changed: null, phases: ["P8-q4"], outcome: "", reason: "", sync: null, ...over,
  }) as AgendaItem;
  const phases: Pick<PhaseRow, "id" | "short" | "status">[] = [{ id: "P8-q4", short: "P8", status: "in_progress" }];

  it("reads the item's state over the Workspace's phases and its mark", () => {
    expect(agendaItemOf("A7-m3", [row({})], phases)).toEqual({
      id: "A7-m3", title: "Workspace pages on sikstack", lang: "en",
      state: { word: "In progress", cls: "status status-live" }, mark: null,
    });
    expect(agendaItemOf("A7-m3", [row({ sync: "waiting" })], phases)?.mark).toBe("waiting");
    expect(agendaItemOf("A7-m3", [row({ sync: { refused: "A7-m3 is solved", entry: "e1" } })], phases)?.mark).toBe("refused");
    expect(agendaItemOf("A7-m3", [], phases)).toBeNull();
    expect(agendaItemOf(null, [row({})], phases)).toBeNull();
    const out = view(phase(), agendaItemOf("A7-m3", [row({ sync: "waiting" })], phases));
    expect(out).toContain('<span class="ws-end"><span class="badge is-waiting">Waiting for sync</span></span>');
  });
});

describe("Explained in", () => {
  const doc = (id: number, title: string) => ({ id, rel_path: `guides/doc-${id}.md`, title, href: `/documents/${id}` });
  const linked = (id: number, title: string, role: "explain" | "source") => ({ ...doc(id, title), phase: "P9-e1", role });

  it("lists an explain phase's documents and a source phase's, each once, as links to the reader", () => {
    const explain = phase({ explain: { title: "How the agenda works", documents: [doc(41, "How the agenda works")] }, explainedIn: [linked(41, "How the agenda works", "explain")] });
    expect(explainedDocuments(explain)).toEqual([{ key: 41, title: "How the agenda works", href: "/documents/41" }]);
    const source = phase({ explain: null, explainedIn: [linked(41, "How the agenda works", "source"), linked(42, "에이전다 읽기", "source")] });
    const out = view(source);
    expect(out).toContain('<h2 id="phase-doc-head">Explained in</h2>');
    expect(out).toContain('<a class="link-strong ws-open" href="/documents/41"><span class="row-stack"><span class="ws-name-text">How the agenda works</span><span class="meta ws-sub">Library</span></span></a>');
    expect(out).toContain('<a class="link-strong ws-open" href="/documents/42"><span class="row-stack"><span class="ws-name-text" lang="ko">에이전다 읽기</span>');
    expect(count(out, 'class="row phase-link-row"')).toBe(2);
    // never the project's library list
    expect(out).not.toContain(`/projects/${PROJECT}/library`);
  });

  it("draws no panel when the phase names no document", () => {
    for (const over of [{ explain: null }, { explain: { title: "An explain phase" } }, { explain: { title: "x", documents: [] }, explainedIn: [] }] as Partial<Phase>[]) {
      expect(explainedDocuments(phase(over))).toEqual([]);
      expect(view(phase(over))).not.toContain("Explained in");
    }
  });
});

describe("the page's reads", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function run(record: WithHead<Phase> | null, status = 200) {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
    const headers = await import("next/headers");
    vi.mocked(headers.cookies).mockResolvedValue({ get: () => undefined } as never);
    const guards = await import("@/lib/auth-guards");
    vi.mocked(guards.requireIdentity).mockResolvedValue({ token: "session-token", identity: { tenant: null } } as never);
    const calls: string[] = [];
    const workspace = {
      project: PROJECT, linked: true, version: "97", sync: { state: "fresh", at: "2026-11-18T00:58:00Z" },
      streams: [], pointer: { phase: "P8-q4", slice: "S10", next: null, waiting: [] },
      phases: [{ id: "P8-q4", short: "P8", status: "in_progress" }], docs: [], retired: [],
      agenda: [{ id: "A7-m3", title: "Workspace pages on sikstack", lang: "en", note: "", state: "open", created: "2026-11-12", changed: null, phases: ["P8-q4"], outcome: "", reason: "", sync: null }],
      unplaced: [],
    } as unknown as Workspace;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const body = url.includes("/phases/") ? record : url.endsWith("/workspace") ? workspace : { project: { id: PROJECT, name: "platform" } };
        const code = url.includes("/phases/") ? status : 200;
        return new Response(JSON.stringify(code === 200 ? body : { detail: "no" }), { status: code, headers: { "content-type": "application/json" } });
      }),
    );
    await PhasePage({
      params: Promise.resolve({ projectId: PROJECT, phaseId: "P8-q4" }),
      searchParams: Promise.resolve({}),
    });
    return calls;
  }

  const base = `http://kb.test:8766/app/projects/${PROJECT}/workspace`;

  it("reads the phase once, and the Workspace once only for the agenda item", async () => {
    expect(await run(phase({ agenda: null }))).toEqual([`${base}/phases/P8-q4`]);
    expect(await run(phase())).toEqual([`${base}/phases/P8-q4`, base]);
  });

  it("reads the sync line and the project's name for Not found", async () => {
    const calls = await run(null, 404);
    expect(calls[0]).toBe(`${base}/phases/P8-q4`);
    expect(calls.slice(1).sort()).toEqual([base, `http://kb.test:8766/app/projects/${PROJECT}`].sort());
  });
});
