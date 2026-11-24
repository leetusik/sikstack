import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadAgendaItem } from "@/app/(app)/projects/[projectId]/workspace/agenda/[item]/load";
import {
  afterSend,
  AgendaItemPage,
  deletedState,
  formSend,
  headActions,
  INITIAL,
  itemLines,
  itemView,
  pageView,
  reduce,
  threadView,
  vanished,
  type ItemPageRead,
  type ItemRead,
  type PageState,
  type PhaseLine,
} from "@/sikstack/workspace/agenda-item";
import { AgendaItemForm } from "@/sikstack/workspace/agenda-item/form";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import { wsSyncLine } from "@/sikstack/workspace/frame";
import { EMPTY_OVERLAY, view } from "@/lib/workspace/optimistic";
import type {
  AgendaItem,
  InboxEntry,
  PhaseRow,
  ThreadEntry,
  WriteAnswer,
} from "@/lib/workspace/types";

// An agenda item's page: the head's buttons by the item's state, what a write leaves on the page (Defer then
// Reopen, Delete, the form's refusals), Not found, and the reads the page makes. The fixture is a real item of
// this kind: a product redesign with four linked phases, as the workspace writes them.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/workspace/actions", () => ({
  acceptAgendaItems: vi.fn(),
  noteAgendaItem: vi.fn(),
  deferAgendaItems: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  dropAgendaItems: vi.fn(),
  editAgendaItem: vi.fn(),
  reopenAgendaItems: vi.fn(),
  retryChange: vi.fn(),
  solveAgendaItems: vi.fn(),
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const TOKEN = "session-token";
const ZONE = "Asia/Seoul";
const NOW = Date.parse("2026-11-18T09:00:00Z");
const HEAD = {
  version: "v97",
  sync: { state: "fresh" as const, at: "2026-11-18T08:58:00Z" },
};

const ITEM: AgendaItem = {
  id: "A7-m3",
  title: "One product at sikstack.com, designed new",
  lang: "en",
  note: "The app, the reader and capture were three things with three looks. Make them one: one address, one sign-in, one design. Build only what is signed.",
  state: "in_progress",
  created: "2026-11-03",
  changed: "2026-11-14",
  phases: ["P57-4q", "P58-r2", "P56-t8", "P55-m1"],
  outcome: "",
  reason: "",
  sync: null,
};

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
    created: "2026-11-10",
    started: null,
    completed: null,
    archived: false,
    stream: "default",
    done,
    total,
    current,
    gate: {
      state: null,
      note: null,
      walkthrough: [],
      words: null,
      cleared: null,
    },
    review: { verdict: null, note: null },
    branches: [],
    agenda: "A7-m3",
  };
}

const PHASES: PhaseRow[] = [
  phase("P57-4q", "sikstack design", "in_progress", 3, 7, "S4"),
  phase("P9-x2", "Export to Markdown", "planned", 0, 1),
  phase("P58-r2", "Project switcher and org home", "planned", 0, 5),
  phase("P56-t8", "One platform at sikstack.com", "done", 5, 5),
  phase("P55-m1", "Three repos under one host", "done", 4, 4),
];
function lines(phases: PhaseRow[]): PhaseLine[] {
  return itemLines(ITEM, { phases }).phases;
}

function read(item: Partial<AgendaItem> = {}, phases = PHASES): ItemRead {
  const it = { ...ITEM, ...item };
  return { item: it, ...itemLines(it, { phases }) };
}

function entry(kind: InboxEntry["kind"], id: string): InboxEntry {
  return {
    id,
    kind,
    items: ["A7-m3"],
    fields: {},
    minted_id: null,
    state: "pending",
    reason: null,
    created_at: "2026-11-18T09:00:00Z",
  };
}

const ok = (e: InboxEntry): WriteAnswer => ({ ok: true, entry: e, item: null });

function page(r: ItemPageRead): string {
  return renderToStaticMarkup(
    createElement(AgendaItemPage, {
      project: PROJECT,
      back: { href: `/projects/${PROJECT}/workspace`, label: "Agenda" },
      line: wsSyncLine(HEAD.sync, HEAD.version, { timeZone: ZONE, now: NOW }),
      timeZone: ZONE,
      now: NOW,
      read: r,
    }),
  );
}

/** The head's button labels, in order, and which of them is the primary one. */
function buttons(html: string): { labels: string[]; primary: string[] } {
  const actions = html.slice(
    html.indexOf("agendaitem-actions"),
    html.indexOf("</header>"),
  );
  const all = [
    ...actions.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g),
  ];
  const text = (inner: string) =>
    inner.match(/<span>([^<]*)<\/span>/)?.[1] ?? inner.replace(/<[^>]+>/g, "");
  return {
    labels: all.map((m) => text(m[2])),
    primary: all
      .filter((m) => m[1].includes("btn-primary"))
      .map((m) => text(m[2])),
  };
}

describe("the head's actions by the item's state (F303, F309)", () => {
  it("reads Delete, Edit, Defer, Drop, Solve open or in progress; Delete, Edit, Reopen set aside", () => {
    for (const s of ["open", "in_progress"] as const)
      expect(headActions(s)).toEqual([
        "delete",
        "edit",
        "defer",
        "drop",
        "solve",
      ]);
    for (const s of ["deferred", "solved", "dropped"] as const)
      expect(headActions(s)).toEqual(["delete", "edit", "reopen"]);
  });

  it("draws them on the page, Solve primary only while every linked phase is done", () => {
    // in progress: a linked phase runs
    let html = page({ state: "ready", ...read() });
    expect(buttons(html)).toEqual({
      labels: ["Delete", "Edit", "Defer", "Drop", "Solve"],
      primary: [],
    });
    expect(html).toContain('class="status status-live">In progress');
    expect(html).not.toContain("Every linked phase is done.");

    // open, every phase done
    const done = PHASES.filter((p) => p.status === "done");
    html = page({
      state: "ready",
      ...read({ state: "open", phases: ["P56-t8", "P55-m1"] }, done),
    });
    expect(buttons(html)).toEqual({
      labels: ["Delete", "Edit", "Defer", "Drop", "Solve"],
      primary: ["Solve"],
    });
    expect(html).toContain("<span>Every linked phase is done.</span>");

    // open, no phase: no sentence, no primary, the command to plan one
    html = page({
      state: "ready",
      ...read({ state: "open", phases: [] }),
    });
    expect(buttons(html).primary).toEqual([]);
    expect(html).toContain(
      "No phase yet. Run this in the project’s repo to plan one.",
    );
    expect(html).toContain(
      '<span class="copy-value mono">/create-phase A7-m3</span>',
    );

    for (const [state, fact] of [
      ["deferred", null],
      ["solved", "Outcome"],
      ["dropped", "Reason"],
    ] as const) {
      html = page({
        state: "ready",
        ...read({
          state,
          outcome: state === "solved" ? "Shipped as P56-t8 and P57-4q." : "",
          reason: state === "dropped" ? "Folded into D141-4r." : "",
        }),
      });
      expect(buttons(html), state).toEqual({
        labels: ["Delete", "Edit", "Reopen"],
        primary: [],
      });
      for (const label of ["Outcome", "Reason"])
        expect(html.includes(`<dt>${label}</dt>`), `${state} ${label}`).toBe(
          label === fact,
        );
    }
    // a deferred item keeps its note and dates, and no outcome or reason (F301)
    html = page({
      state: "ready",
      ...read({
        state: "deferred",
        outcome: "kept by mistake",
        reason: "kept too",
      }),
    });
    expect(html).not.toMatch(/<dt>(Outcome|Reason)<\/dt>/);
    expect(html).toContain("<dt>Note</dt>");
  });

  it("names the current slice under a running phase, its id alone when the store has no name", () => {
    const named = PHASES.map((p) =>
      p.id === "P57-4q"
        ? {
            ...p,
            currentRef: {
              id: "S4",
              full: "P57-4q.S4",
              name: "Agenda and links",
              status: "in_progress",
            },
          }
        : p,
    );
    expect(lines(named)[0].current).toBe("S4 Agenda and links");
    expect(lines(PHASES)[0].current).toBe("S4");
    // a done phase shows none
    const html = page({ state: "ready", ...read({}, named) });
    expect(html).toContain(
      '<span class="meta ws-sub">S4 Agenda and links</span>',
    );
    expect(html.match(/ws-sub/g)).toHaveLength(1);
  });

  it("lists the linked phases in the Workspace's order with one steps width, and no Deferred jobs panel", () => {
    const r = read();
    expect(r.phases.map((p) => p.id)).toEqual([
      "P57-4q",
      "P58-r2",
      "P56-t8",
      "P55-m1",
    ]);
    const html = page({ state: "ready", ...r });
    expect(html).toContain('<p class="meta">4 phases</p>');
    expect(html).toContain("--steps-n:7");
    expect(html).toContain(`/projects/${PROJECT}/workspace/phases/P57-4q`);
    // a folded job reads as its `issue` entry in the thread (P61-e9): no jobs panel, no job page
    expect(html).not.toContain("agendaitem-jobs");
    expect(html).not.toContain("/workspace/deferred/");
    // an ended item with no phase draws no Phases panel
    const ended = page({
      state: "ready",
      ...read({ state: "solved", phases: [] }),
    });
    expect(ended).not.toContain('id="agendaitem-phases"');
  });
});

describe("a Proposed item, the thread, and the fixes it carries (P61-e9)", () => {
  const PROPOSED_BY = {
    by: "agent:claude-opus-5-5",
    at: "2026-11-20T09:00:00+09:00",
  };
  const THREAD: ThreadEntry[] = [
    {
      id: "20261124T015846.624077Z-913g",
      kind: "issue",
      author: "agent:fold",
      by: "agent",
      name: "fold",
      source: "slice:P67-b1.REVIEW",
      created: "2026-11-17T09:00:00Z",
      body: "Folded from deferred job D305-8m.",
      job: "D305-8m",
      sync: null,
    },
    {
      id: "20261124T042949.905151Z-akrs",
      kind: "note",
      author: "person:mina",
      by: "person",
      name: "mina",
      source: "web:agenda",
      created: "2026-11-18T08:00:00Z",
      body: "Download reads like a file save to me.",
      job: null,
      sync: null,
    },
    {
      id: "0ff1c2d3-0000-4000-8000-000000000001",
      kind: "feedback",
      author: "person:you",
      by: "person",
      name: "you",
      source: "feedback:e7a57758-bb40-4a09-9963-bb0752b3c3e9",
      created: "2026-11-18T08:50:00Z",
      body: "Export hangs at 99%.\n\n/feedback/e7a57758-bb40-4a09-9963-bb0752b3c3e9",
      job: null,
      sync: null,
    },
    {
      id: "7c1e4b2a-0d3f-4a5b-8c6d-000000000099",
      kind: "note",
      author: "person:you",
      by: "person",
      name: "you",
      source: "web:agenda",
      created: "2026-11-18T08:59:00Z",
      body: "Seen on the **2 GB** export too.",
      job: null,
      sync: "waiting",
    },
  ];

  it("offers Delete, Edit, Drop and Accept on a Proposed item, Accept the primary, and says who proposed it", () => {
    expect(headActions("open", true)).toEqual([
      "delete",
      "edit",
      "drop",
      "accept",
    ]);
    const html = page({
      state: "ready",
      ...read({ state: "proposed", phases: [], proposed: PROPOSED_BY }),
    });
    expect(buttons(html)).toEqual({
      labels: ["Delete", "Edit", "Drop", "Accept"],
      primary: ["Accept"],
    });
    expect(html).toContain(
      '<span class="status status-pending">Proposed</span>',
    );
    expect(html).toContain("<dt>Proposed by</dt>");
    expect(html).toContain(
      '<span class="ws-author"><span class="strong">claude-opus-5-5</span><span class="badge">Agent</span></span>',
    );
  });

  it("reads an item whose Accept waits (`accepting`) as Open, with no second Accept after a reload", () => {
    const html = page({
      state: "ready",
      ...read({
        state: "proposed",
        phases: [],
        proposed: PROPOSED_BY,
        accepting: true,
        sync: "waiting",
      }),
    });
    expect(buttons(html).labels).toEqual([
      "Delete",
      "Edit",
      "Defer",
      "Drop",
      "Solve",
    ]);
    expect(html).not.toContain(">Accept<");
    expect(html).toContain("Waiting for sync");
  });

  it("draws the thread oldest first: author (an agent marked), kind, source and time; a feedback entry's kind links to it", () => {
    const view = threadView(THREAD, {
      project: PROJECT,
      when: (v) => (v ? v.slice(11, 16) : ""),
    });
    expect(
      view.map((e) => [
        e.author?.name,
        e.author?.agent,
        e.kind,
        e.source?.text,
        e.mark,
      ]),
    ).toEqual([
      ["fold", true, "Issue", "P67-b1.REVIEW", null],
      ["mina", false, "Note", "Web", null],
      ["you", false, "Feedback", "Feedback", null],
      ["you", false, "Note", "Web", "waiting"],
    ]);
    expect(view[2].source?.href).toBe(
      `/projects/${PROJECT}/feedback/e7a57758-bb40-4a09-9963-bb0752b3c3e9`,
    );
    // the way back to the feedback is the kind's link, so the body's last line is left out
    expect(view[2].body).toBe("Export hangs at 99%.");
    const html = page({
      state: "ready",
      ...read({ phases: [], entries: THREAD }),
    });
    const thread = html.slice(html.indexOf('class="thread"'));
    expect(thread.indexOf("fold")).toBeLessThan(thread.indexOf("mina"));
    expect(thread.indexOf("mina")).toBeLessThan(thread.indexOf("Seen on the"));
    expect(html).toContain("<h2 id=");
    expect(html).toContain(">Thread</h2>");
    expect(html).toContain(">4 entries</p>");
    expect(html).toContain('<label class="label"');
    expect(html).toContain(">Add note<");
    // Thread before Phases
    expect(html.indexOf(">Thread</h2>")).toBeLessThan(
      html.indexOf("agendaitem-phases"),
    );
  });

  it("draws a waiting note's Markdown as a synced one's, from the server's prose (D305)", () => {
    const item = { ...ITEM, entries: THREAD };
    const prose = itemProse(item);
    const waiting = THREAD[3].body;
    expect(Object.hasOwn(prose, waiting)).toBe(true);
    const html = renderToStaticMarkup(
      createElement(AgendaItemPage, {
        project: PROJECT,
        back: { href: `/projects/${PROJECT}/workspace`, label: "Agenda" },
        line: null,
        timeZone: ZONE,
        now: NOW,
        prose,
        read: { state: "ready", ...read({ phases: [], entries: THREAD }) },
      }),
    );
    expect(html).toContain("Seen on the <strong>2 GB</strong> export too.");
    expect(html).not.toContain("Seen on the **2 GB** export too.");
  });

  it("draws Item deleted for an item whose delete waits (`deleting`), on a reload (D309)", () => {
    const r: ItemPageRead = {
      state: "ready",
      ...read({ deleting: true, sync: "waiting" }),
    };
    expect(pageView(r, INITIAL)).toEqual({
      kind: "gone",
      title: "One product at sikstack.com, designed new",
    });
    const html = page(r);
    expect(html).toContain("Item deleted");
    expect(html).not.toContain("isn’t part of");
  });

  it("sends the note untouched when an edit changed only the title (D308)", () => {
    const note = "    an indented code block\nstays code";
    expect(
      formSend("edit", { title: " A new title ", note, line: "" }, { note }),
    ).toEqual({ kind: "edit", title: "A new title", note });
    // a note the edit changed is trimmed, as F45 says
    expect(
      formSend("edit", { title: "T", note: "  changed  ", line: "" }, { note }),
    ).toEqual({ kind: "edit", title: "T", note: "changed" });
  });
});

describe("what a write leaves on the page", () => {
  const send = (
    state: PageState,
    busy: "defer" | "reopen" | "delete",
    e: InboxEntry,
    title?: string,
  ) =>
    reduce(reduce(state, { type: "send", busy }), {
      type: "answer",
      answer: ok(e),
      timeZone: ZONE,
      now: NOW,
      title,
    });

  it("Defer, then Reopen, puts the item back at the end of the open items, waiting for sync", () => {
    const deferred = send(
      INITIAL,
      "defer",
      entry("defer", "6f1d2c3b-0a4e-4f5a-9b8c-7d6e5f4a3b21"),
    );
    const v1 = itemView(read(), deferred.overlay);
    expect(v1?.status).toBe("deferred");
    expect(v1?.actions).toEqual(["delete", "edit", "reopen"]);
    expect(v1?.waiting).toBe(true);
    expect(deferred.focus?.on).toBe("reopen");

    const reopened = send(
      deferred,
      "reopen",
      entry("reopen", "7a2e3d4c-1b5f-4a6b-8c9d-0e1f2a3b4c5d"),
    );
    expect(reopened.focus?.on).toBe("edit");
    const v2 = itemView(read(), reopened.overlay);
    expect(v2?.status).toBe("in_progress");
    expect(v2?.waiting).toBe(true);
    // the same overlay over the Agenda's read: the item comes back last
    const agenda = [
      { ...ITEM },
      {
        ...ITEM,
        id: "A12-p8",
        title: "Readers lose their place between phone and laptop",
      },
      {
        ...ITEM,
        id: "A9-k1",
        title: "하이라이트 색을 직접 고르고 싶어요",
        lang: "ko" as const,
      },
    ];
    expect(view({ agenda }, reopened.overlay).agenda.map((i) => i.id)).toEqual([
      "A12-p8",
      "A9-k1",
      "A7-m3",
    ]);
  });

  it("after its own Delete says Item deleted, whatever the next read says", () => {
    let s = reduce(INITIAL, { type: "ask" });
    expect(s.asking).toBe(true);
    s = send(
      s,
      "delete",
      entry("delete", "8b3f4e5d-2c6a-4b7c-9d0e-1f2a3b4c5d6e"),
      ITEM.title ?? "",
    );
    expect(s.asking).toBe(false);
    expect(s.gone).toBe("One product at sikstack.com, designed new");
    expect(itemView(read(), s.overlay)).toBeNull();
    // a read that no longer holds the item (the delete waits) does not undo it
    s = reduce(s, { type: "read", item: { ...ITEM, id: "A12-p8" } });
    expect(s.gone).not.toBeNull();
    const model = deletedState(s.gone ?? "", {
      href: "/projects/x/workspace",
      label: "Agenda",
    });
    expect(model).toMatchObject({
      title: "Item deleted",
      text: "“One product at sikstack.com, designed new” leaves the workspace at the next sync.",
      actions: [
        {
          kind: "link",
          label: "Back to Agenda",
          href: "/projects/x/workspace",
        },
      ],
    });
  });

  it("after Discard or Try again on a refused change, the notice gone, puts the focus on Edit (F303)", () => {
    const refused = "5e0c1b2a-9f3d-4e4f-8a7b-6c5d4e3f2a10";
    const discarded = reduce(
      reduce(INITIAL, { type: "send", busy: "discard" }),
      {
        type: "answer",
        answer: ok({ ...entry("edit", refused), state: "discarded" }),
        timeZone: ZONE,
        now: NOW,
      },
    );
    expect(discarded.busy).toBeNull();
    expect(discarded.focus?.on).toBe("edit");

    const retried = reduce(reduce(discarded, { type: "send", busy: "retry" }), {
      type: "answer",
      answer: ok(entry("edit", "9c4d3e2f-1a0b-4c5d-8e6f-7a8b9c0d1e2f")),
      timeZone: ZONE,
      now: NOW,
      refusedEntry: refused,
    });
    expect(retried.focus?.on).toBe("edit");
    expect(retried.focus?.n).toBe((discarded.focus?.n ?? 0) + 1);

    // a send that failed leaves the notice and its buttons where they are: the focus is not moved
    const failed = reduce(reduce(INITIAL, { type: "send", busy: "retry" }), {
      type: "answer",
      answer: {
        ok: false,
        reason: "closed",
        message: "This change is no longer open.",
      },
      timeZone: ZONE,
      now: NOW,
      refusedEntry: refused,
    });
    expect(failed.focus).toBeNull();
  });

  it("labels Try again on a refused change by its kind after a reload, Saving… when the read names none", () => {
    const line = "refused: A7-m3 is In progress through P56-t8";
    const entryId = "5e0c1b2a-9f3d-4e4f-8a7b-6c5d4e3f2a10";
    const retryOf = (html: string) =>
      html.match(
        /<span class="swap"><span>Try again<\/span><span>([^<]*)<\/span><\/span>/,
      )?.[1];
    for (const [kind, pending] of [
      ["drop", "Dropping…"],
      ["defer", "Deferring…"],
      ["solve", "Solving…"],
      ["reopen", "Reopening…"],
      ["delete", "Deleting…"],
      ["edit", "Saving…"],
      ["move", "Saving…"],
    ] as const) {
      const html = page({
        state: "ready",
        ...read({ sync: { refused: line, entry: entryId, kind } }),
      });
      expect(retryOf(html), kind).toBe(pending);
    }
    // an older read with no kind: the edit's label
    const bare = page({
      state: "ready",
      ...read({ sync: { refused: line, entry: entryId } }),
    });
    expect(retryOf(bare)).toBe("Saving…");
  });

  it("puts the title refusal under the field and a 409's line over the form; the form stays open", () => {
    const opened = reduce(INITIAL, { type: "open", form: "edit", item: ITEM });
    expect(opened.draft.title).toBe(ITEM.title);
    expect(opened.focus?.on).toBe("first");

    // refused here first: nothing is sent
    let s = reduce(
      reduce(opened, { type: "change", field: "title", value: "   " }),
      { type: "submit" },
    );
    expect(s.phase).toBe("title-error");
    expect(s.busy).toBeNull();
    s = reduce(s, {
      type: "change",
      field: "title",
      value: "One product at sikstack.com",
    });
    expect(s.phase).toBe("rest");

    // the route's own refusal of the title
    s = reduce(s, { type: "submit" });
    expect(s.busy).toBe("form");
    const titled = reduce(s, {
      type: "answer",
      answer: {
        ok: false,
        reason: "title",
        message: "Enter a title of 1–200 characters.",
      },
      timeZone: ZONE,
    });
    expect(titled).toMatchObject({
      form: "edit",
      phase: "title-error",
      busy: null,
    });

    // a 409: the change is no longer open
    const closed = reduce(
      reduce(titled, { type: "change", field: "title", value: "One product" }),
      {
        type: "submit",
      },
    );
    const after = reduce(closed, {
      type: "answer",
      answer: {
        ok: false,
        reason: "closed",
        message: "the change is no longer open",
      },
      timeZone: ZONE,
    });
    expect(after).toMatchObject({
      form: "edit",
      phase: "send-failed",
      notice: "the change is no longer open",
      draft: { title: "One product" },
    });

    const form = (phase: PageState["phase"], notice: string | null) =>
      renderToStaticMarkup(
        createElement(AgendaItemForm, {
          kind: "edit",
          phase,
          notice,
          draft: after.draft,
          onChange: () => {},
          onSubmit: () => {},
          onCancel: () => {},
        }),
      );
    expect(form("send-failed", after.notice)).toContain(
      '<p class="notice notice-danger" role="alert">the change is no longer open</p>',
    );
    expect(form("send-failed", null)).toContain(
      "Could not save the item. Try again.",
    );
    const refusedTitle = form("title-error", null);
    expect(refusedTitle).toContain('aria-invalid="true"');
    expect(refusedTitle).toContain('class="field-error"');
    expect(refusedTitle).toContain("Enter a title of 1–200 characters.");
  });
});

describe("a change that takes the item from under the page", () => {
  // The operator added "Cache the reader's fonts on the box"; the workspace refused it, because an item it made
  // meanwhile holds the same id (the engine's line). The route draws a refused add as its own row, or, when an
  // item holds its id, as that item carrying the add's mark.
  const REFUSED = "6d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
  const AGAIN = "7e2f3a4b-5c6d-4e7f-9a81-92b3c4d5e6f7";
  const LINE = "agenda item A31-q7 already exists";
  const MARK = { refused: LINE, entry: REFUSED, kind: "add" as const };
  const ADDED: AgendaItem = {
    id: "A31-q7",
    title: "Cache the reader's fonts on the box",
    lang: "en",
    note: "The reader fetches its two fonts again on every page.",
    state: "open",
    created: "2026-11-18",
    changed: "2026-11-18",
    phases: [],
    outcome: "",
    reason: "",
    sync: MARK,
  };
  const HELD: AgendaItem = { ...ITEM, id: "A31-q7", sync: MARK };
  const addEntry = (
    id: string,
    minted: string,
    state: InboxEntry["state"],
  ): InboxEntry => ({
    id,
    kind: "add",
    items: [minted],
    fields: { title: ADDED.title, note: ADDED.note },
    minted_id: minted,
    state,
    reason: null,
    created_at: "2026-11-18T09:00:00Z",
  });
  const RESENT = addEntry(AGAIN, "A42-m8", "pending");
  const DISCARDED = addEntry(REFUSED, "A31-q7", "discarded");
  const ready = (item: AgendaItem): ItemPageRead => ({
    state: "ready",
    ...read(item),
  });
  const GONE: ItemPageRead = { state: "not-found", projectName: "platform" };
  const AGENDA = `/projects/${PROJECT}/workspace?deferred=2`;
  const at = (shown: string) => ({
    project: PROJECT,
    shown,
    from: { list: "agenda" as const, deferred: 2 },
    back: AGENDA,
  });
  const press = (
    busy: "retry" | "discard",
    answer: WriteAnswer,
    title: string,
    refusedEntry?: string,
  ) =>
    reduce(reduce(INITIAL, { type: "send", busy }), {
      type: "answer",
      answer,
      timeZone: ZONE,
      now: NOW,
      refusedEntry,
      title,
    });
  const shown = (d: ReturnType<typeof pageView>) =>
    d.kind === "item"
      ? {
          id: d.view.item.id,
          title: d.view.item.title,
          waiting: d.view.waiting,
          refused: d.view.refused,
          phases: d.view.phases.length,
        }
      : d;

  it("Try again on a refused add shows the id it was re-sent under, waiting for sync, and the address follows it", () => {
    for (const item of [ADDED, HELD]) {
      const answer: WriteAnswer = { ok: true, entry: RESENT, item: "A42-m8" };
      const s = press("retry", answer, item.title ?? "", REFUSED);
      const drawn = {
        id: "A42-m8",
        title: ADDED.title,
        waiting: true,
        refused: null,
        phases: 0,
      };
      expect(shown(pageView(ready(item), s)), item.title ?? "").toEqual(drawn);
      // the old id's read no longer holds anything: still the new id, never Not found
      expect(shown(pageView(GONE, s))).toEqual(drawn);
      expect(s.focus?.on).toBe("edit");
      const step = afterSend("retry", answer, at("A31-q7"));
      expect(step).toMatchObject({ go: "replace", item: "A42-m8" });
      const url = new URL(step.go === "refresh" ? "" : step.href, "http://x");
      expect(url.pathname).toBe(`/projects/${PROJECT}/workspace/agenda/A42-m8`);
      expect(url.searchParams.get("from")).toBe(AGENDA);
    }
  });

  it("reads the new id again as the same item waiting for sync, once, whether or not the page kept its state", () => {
    const pending: AgendaItem = { ...ADDED, id: "A42-m8", sync: "waiting" };
    const html = page(ready(pending));
    expect(html).toContain("A42-m8");
    expect(html).toContain("Cache the reader&#x27;s fonts on the box");
    expect(html).toContain("Waiting for sync");
    expect(html).not.toContain("not found");
    // the page kept its state: the read carries the add now, so the page's own copy goes
    const s = reduce(
      press(
        "retry",
        { ok: true, entry: RESENT, item: "A42-m8" },
        ADDED.title ?? "",
        REFUSED,
      ),
      { type: "read", item: pending },
    );
    expect(s.overlay.changes).toEqual([]);
    expect(shown(pageView(ready(pending), s))).toMatchObject({
      id: "A42-m8",
      waiting: true,
    });
  });

  it("Discard on a refused add: Item deleted once the next read no longer holds it, and the Agenda opens", () => {
    const answer: WriteAnswer = { ok: true, entry: DISCARDED, item: null };
    let s = press("discard", answer, ADDED.title ?? "");
    // until that read, the send stays busy and the page as it was
    expect(s.busy).toBe("discard");
    expect(shown(pageView(ready(ADDED), s))).toMatchObject({
      id: "A31-q7",
      refused: { entry: REFUSED },
    });
    expect(afterSend("discard", answer, at("A31-q7"))).toEqual({
      go: "refresh",
    });
    expect(vanished(ready(ADDED), s)).toBe(false);
    expect(vanished(GONE, s)).toBe(true);
    expect(pageView(GONE, s)).toEqual({
      kind: "gone",
      title: "Cache the reader's fonts on the box",
    });
    s = reduce(s, { type: "missing" });
    expect(s.busy).toBeNull();
    expect(s.gone).toBe("Cache the reader's fonts on the box");
    expect(vanished(GONE, s)).toBe(false);
  });

  it("Discard on a refused add whose id an item holds: that item stays, its mark gone, the focus on Edit", () => {
    const answer: WriteAnswer = { ok: true, entry: DISCARDED, item: null };
    const s = press("discard", answer, ITEM.title ?? "");
    for (const after of [{ ...HELD, sync: null }, HELD]) {
      // the read after the discard (or one taken before it, still naming the add)
      const next = reduce(s, { type: "read", item: after });
      expect(next.busy).toBeNull();
      expect(next.gone).toBeNull();
      expect(next.focus?.on).toBe("edit");
      expect(shown(pageView(ready(after), next))).toEqual({
        id: "A31-q7",
        title: ITEM.title,
        waiting: false,
        refused: null,
        phases: 4,
      });
      expect(vanished(ready(after), next)).toBe(false);
    }
  });

  it("Try again on a refused delete says Item deleted and opens the Agenda, as Delete does", () => {
    const again: InboxEntry = { ...entry("delete", AGAIN) };
    const answer: WriteAnswer = { ok: true, entry: again, item: null };
    const refusedDelete = {
      refused: LINE,
      entry: REFUSED,
      kind: "delete" as const,
    };
    const s = press("retry", answer, ITEM.title ?? "", REFUSED);
    expect(pageView(ready({ ...ITEM, sync: refusedDelete }), s)).toEqual({
      kind: "gone",
      title: ITEM.title,
    });
    expect(pageView(GONE, s).kind).toBe("gone");
    expect(afterSend("retry", answer, at("A7-m3"))).toEqual({
      go: "push",
      href: AGENDA,
    });
  });

  it("Try again and Discard on any other kind leave the page on its item: waiting, or its mark gone", () => {
    for (const kind of [
      "edit",
      "move",
      "defer",
      "solve",
      "drop",
      "reopen",
    ] as const) {
      const r = ready({
        ...ITEM,
        sync: { refused: LINE, entry: REFUSED, kind },
      });
      const again: WriteAnswer = {
        ok: true,
        entry: entry(kind, AGAIN),
        item: null,
      };
      const retried = press("retry", again, ITEM.title ?? "", REFUSED);
      expect(shown(pageView(r, retried)), kind).toMatchObject({
        id: "A7-m3",
        waiting: true,
        refused: null,
      });
      expect(afterSend("retry", again, at("A7-m3")), kind).toEqual({
        go: "refresh",
      });
      const closed: WriteAnswer = {
        ok: true,
        entry: { ...entry(kind, REFUSED), state: "discarded" },
        item: null,
      };
      const dropped = press("discard", closed, ITEM.title ?? "");
      expect(dropped.busy, kind).toBeNull();
      expect(shown(pageView(r, dropped)), kind).toMatchObject({
        id: "A7-m3",
        waiting: false,
        refused: null,
      });
      expect(afterSend("discard", closed, at("A7-m3")), kind).toEqual({
        go: "refresh",
      });
    }
    // a send that failed reads the page again where it is
    expect(
      afterSend("retry", { ok: false, reason: "failed" }, at("A7-m3")),
    ).toEqual({ go: "refresh" });
  });
});

describe("reading an agenda item", () => {
  interface Call {
    url: string;
  }
  function api(
    answer: (url: string) => { status: number; body: unknown },
  ): Call[] {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push({ url });
        const { status, body } = answer(url);
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return calls;
  }
  const base = `http://kb.test:8766/app/projects/${PROJECT}`;
  const WORKSPACE = {
    project: PROJECT,
    linked: true,
    ...HEAD,
    streams: [],
    pointer: { phase: "P57-4q", slice: "P57-4q.S4", next: null, waiting: [] },
    phases: PHASES,
    docs: [],
    retired: [],
    agenda: [ITEM],
    unplaced: [],
  };

  beforeAll(() => {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the item's route, plus the Workspace once for its phases' rows", async () => {
    const calls = api((url) =>
      url.endsWith("/agenda/A7-m3")
        ? { status: 200, body: { ...ITEM, workspace: HEAD } }
        : { status: 200, body: WORKSPACE },
    );
    const r = await loadAgendaItem(TOKEN, PROJECT, "A7-m3");
    expect(calls.map((c) => c.url)).toEqual([
      `${base}/workspace/agenda/A7-m3`,
      `${base}/workspace`,
    ]);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.head).toEqual(HEAD);
    expect(r.phases).toEqual(lines(PHASES));
    expect(r.synced).toBe(HEAD.sync.at);
  });

  it("reads only the item's route when it holds no phase", async () => {
    const calls = api(() => ({
      status: 200,
      body: { ...ITEM, phases: [], workspace: HEAD },
    }));
    const r = await loadAgendaItem(TOKEN, PROJECT, "A7-m3");
    expect(calls).toHaveLength(1);
    expect(r.state).toBe("ready");
  });

  it("answers a gone item as Not found, naming the project, with the sync line", async () => {
    const calls = api((url) =>
      url.endsWith("/agenda/A7-m3")
        ? { status: 404, body: { detail: "A7-m3 names no agenda item" } }
        : url.endsWith("/workspace")
          ? { status: 200, body: WORKSPACE }
          : {
              status: 200,
              body: { project: { id: PROJECT, name: "platform" } },
            },
    );
    const r = await loadAgendaItem(TOKEN, PROJECT, "A7-m3");
    expect(calls.map((c) => c.url).sort()).toEqual(
      [`${base}`, `${base}/workspace`, `${base}/workspace/agenda/A7-m3`].sort(),
    );
    expect(r).toEqual({
      state: "not-found",
      head: HEAD,
      projectName: "platform",
      missing: false,
    });
    const html = page({ state: "not-found", projectName: "platform" });
    expect(html).toContain("Agenda item not found");
    expect(html).toContain(
      "This agenda item doesn’t exist, or it isn’t part of platform.",
    );
    expect(html).toContain("Back to Agenda");
    expect(html).toContain("Synced 2m ago");
  });

  it("answers a failed read as an error, for the route's boundary", async () => {
    api(() => ({
      status: 503,
      body: { detail: "the workspace store is unavailable" },
    }));
    expect(await loadAgendaItem(TOKEN, PROJECT, "A7-m3")).toEqual({
      state: "error",
    });
  });
});
