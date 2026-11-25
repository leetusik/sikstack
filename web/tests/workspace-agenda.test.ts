import {
  createElement,
  createRef,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgendaItem,
  PhaseRow,
  Unplaced,
  Workspace,
} from "@/lib/workspace/types";

// The Agenda at rest (design job 02, `AgendaList.dc.html`, frame.md F300 to F303): the parts' membership and order
// (no Deferred: a stored one reads Proposed), Show all over five, the end cell's words, the confirm's focus,
// an add's title refusal under the field, and one Workspace read a page load. Node only: models, server renders,
// and the page with its reads mocked.

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const dialogs = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@/sikstack/frame/dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    Dialog: (props: Record<string, unknown>) => {
      dialogs.props.push(props);
      return h("dialog", { className: "dlg" }, props.children as ReactNode);
    },
    DialogActions: (props: { children?: ReactNode }) =>
      h("div", { className: "dlg-actions" }, props.children),
  };
});
vi.mock("@/lib/workspace/actions", () => ({
  acceptAgendaItems: vi.fn(),
  addAgendaItem: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  retryChange: vi.fn(),
}));
const reads = vi.hoisted(() => ({ readWorkspace: vi.fn() }));
vi.mock("@/lib/workspace/read", () => reads);
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({
    token: "t",
    identity: {
      tenant: { id: "t1", slug: "june", name: "June's notes" },
      tenants: [],
    },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "kb_tz" ? { value: "Asia/Seoul" } : undefined,
  })),
  headers: vi.fn(async () => new Headers({ host: "p67.localhost:8080" })),
}));

const {
  AddForm,
  AgendaConfirm,
  AgendaList,
  agendaParts,
  endedShown,
  unplacedDone,
  writeShown,
} = await import("@/sikstack/workspace/agenda");
const { EMPTY_OVERLAY, reconcile, view } =
  await import("@/lib/workspace/optimistic");
const { dates, phaseLookup } = await import("@/lib/workspace/model");
const { TITLE_REFUSAL } = await import("@/lib/workspace/rules");
const { AGENDA_ITEM } = await import("@/content/workspace/agenda-item");
const AgendaPage = (
  await import("@/app/(app)/projects/[projectId]/workspace/page")
).default;

const html = (el: ReactElement) => renderToStaticMarkup(el);
const PROJECT = "3f9c2a10-6d4e-4b8a-9f1e-2c7d5b8a0e41";
const fmt = dates("Asia/Seoul", Date.parse("2026-11-18T09:00:00Z"));

const HANGUL = /[가-힯]/;

function item(
  id: string,
  title: string,
  state: AgendaItem["state"],
  changed: string,
  extra: Partial<AgendaItem> = {},
): AgendaItem {
  return {
    id,
    title,
    lang: HANGUL.test(title) ? "ko" : "en",
    note: "",
    state,
    created: "2026-10-20",
    changed,
    phases: [],
    outcome: "",
    reason: "",
    sync: null,
    ...extra,
  };
}

const PHASES: Pick<PhaseRow, "id" | "short" | "status">[] = [
  { id: "P56-t8", short: "P56", status: "in_progress" },
  { id: "P55-m1", short: "P55", status: "done" },
  { id: "P52-d6", short: "P52", status: "done" },
];

/** `platform`'s agenda, in the operator's order. */
const PLATFORM: AgendaItem[] = [
  item(
    "A12-p3",
    "Say so when the copy has been behind for a day",
    "open",
    "2026-11-13",
    {
      phases: ["P56-t8", "P55-m1"],
      note: "On Nov 9 the backlog here was four days old and nothing said it.",
    },
  ),
  item(
    "A11-f4",
    "A weekly mail of what changed in each project",
    "proposed",
    "2026-11-09",
    { phases: ["P56-t8"], proposed: { by: null, at: null } },
  ),
  item("A10-h5", "Sign-in emails land in spam", "open", "2026-11-02", {
    itemsOpen: 2,
    entryCount: 3,
  }),
  item("A8-r5", "하이라이트 색을 직접 고르고 싶어요", "proposed", "2026-11-06", {
    proposed: { by: null, at: null },
  }),
  item(
    "A7-m3",
    "Keep the reading place across devices",
    "solved",
    "2026-11-12",
    { phases: ["P52-d6"], outcome: "Shipped with the reader in P52-d6." },
  ),
  item("A6-j2", "Import highlights from Kindle", "proposed", "2026-10-26", {
    proposed: { by: null, at: null },
  }),
  item("A5-q8", "Search inside a book’s notes", "dropped", "2026-11-14", {
    reason: "The Library's search covers it.",
  }),
  item(
    "A4-c1",
    "Show the API’s version on the status page",
    "open",
    "2026-11-15",
    {
      sync: "waiting",
    },
  ),
];

const OPEN_TITLES = [
  "Retry failed uploads",
  "Dead-letter topic for the importer",
  "Schema drift alerts",
  "Import preview before the first sync",
  "Nightly export to the archive",
  "Admin audit log",
  "Health check page",
  "Token rotation for the connectors",
  "Slow query log",
  "Batch writes for the loader",
  "Partial write recovery",
  "Time zones in reports",
  "Webhook signatures",
  "The retry queue's back-off",
  "Long file names in the upload path",
  "Empty batches from the scheduler",
  "Stale cache rows after a deploy",
  "The dedupe window",
  "Rate limits per key",
  "A usage line per org",
  "Copy of the backlog behind",
];

const PROPOSED_TITLES = [
  "커넥터마다 동기화 시각을 따로 정하기",
  "Schema drift alerts for the nightly export",
  "Webhook signatures on the retry queue",
  "지운 소스의 적재 기록을 30일 남기기",
  "Long file names in the admin audit log",
  "Empty batches in the dedupe window",
  "실패한 행만 골라 다시 내려받기",
  "Stale cache rows in the import preview",
  "Partial writes on the upload path",
  "주간 적재 요약을 메일로도 받기",
  "Token rotation for the health check",
  "Slow queries in the nightly export",
  "Time zones in the usage line",
  "Rate limits on the webhook receiver",
  "Batch writes for the archive",
  "The dedupe window for Korean titles",
  "Failed uploads in the scheduler",
  "Dead letters from the loader",
  "The audit log's retention",
  "Import preview for large sheets",
  "A digest of refused changes",
  "Export of the agenda as Markdown",
  "Labels for deferred jobs",
  "The status page's history",
  "Copy commands for each place",
];

/** A long agenda (`fn-14`'s shape): 21 open, 25 proposed over the last two weeks, 13 ended. */
function longAgenda(): AgendaItem[] {
  const out: AgendaItem[] = [];
  OPEN_TITLES.forEach((t, i) =>
    out.push(item(`A${10 + i}-k${i % 9}`, t, "open", "2026-11-01")),
  );
  PROPOSED_TITLES.forEach((t, i) =>
    out.push(
      item(
        `A${35 + i}-n${(i % 8) + 1}`,
        t,
        "proposed",
        `2026-11-${String(1 + (i % 14)).padStart(2, "0")}`,
      ),
    ),
  );
  for (let i = 0; i < 13; i += 1)
    out.push(
      item(
        `A${60 + i}-r${(i % 8) + 1}`,
        `Ended item ${60 + i}: ${OPEN_TITLES[i].toLowerCase()} (old)`,
        i % 2 ? "dropped" : "solved",
        `2026-10-${String(10 + i).padStart(2, "0")}`,
      ),
    );
  return out;
}

const parts = (agenda: AgendaItem[]) =>
  agendaParts(agenda, phaseLookup(PHASES), fmt.date);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

const list = (agenda: AgendaItem[], extra: { unplaced?: Unplaced[] } = {}) =>
  html(
    createElement(AgendaList, {
      project: PROJECT,
      read: { agenda, unplaced: extra.unplaced ?? [] },
      phases: PHASES,
      timeZone: "Asia/Seoul",
    }),
  );

describe("Proposed, apart and first (P61-e9)", () => {
  const PROPOSED: AgendaItem[] = [
    item(
      "A8-sf",
      "Retry a sync once after a timeout",
      "proposed",
      "2026-11-20",
      {
        proposed: { by: "agent:fold", at: "2026-11-20T09:00:00+09:00" },
      },
    ),
    item("A9-hb", "Show who wrote each note", "proposed", "2026-11-20", {
      proposed: {
        by: "agent:claude-opus-5-5",
        at: "2026-11-20T10:00:00+09:00",
      },
    }),
  ];

  it("lists the Proposed items in their own part, before Open, each with who proposed it and the day", () => {
    const p = parts([...PROPOSED, ...PLATFORM]);
    expect(ids(p.proposed)).toEqual([
      "A8-sf",
      "A9-hb",
      "A11-f4",
      "A8-r5",
      "A6-j2",
    ]);
    expect(ids(p.open)).not.toContain("A8-sf");
    expect(p.proposed[0].status).toEqual({
      word: "Proposed",
      cls: "status status-pending",
    });
    expect(p.proposed[1].proposed).toEqual({
      by: { name: "claude-opus-5-5", agent: true },
      day: "Nov 20",
    });
    const out = list([...PROPOSED, ...PLATFORM]);
    const proposedHead = out.indexOf(">Proposed</h2>");
    const openHead = out.indexOf(">Open and in progress</h2>");
    expect(proposedHead).toBeGreaterThan(-1);
    expect(proposedHead).toBeLessThan(openHead);
    // Accept stands in Delete's place, named for the item
    expect(out).toContain(
      '<button type="button" class="agenda-del" aria-label="Accept: Show who wrote each note">Accept</button>',
    );
    expect(out).toContain(
      '<span class="ws-author"><span class="strong">fold</span><span class="badge">Agent</span></span>',
    );
  });

  it("draws an item whose Accept waits (`accepting`) Open, first in the open order, waiting, with no Accept after a reload", () => {
    const waiting = [
      { ...PROPOSED[0] },
      { ...PROPOSED[1], accepting: true, sync: "waiting" as const },
      ...PLATFORM,
    ];
    const p = parts(waiting);
    expect(ids(p.proposed)).toEqual(["A8-sf", "A11-f4", "A8-r5", "A6-j2"]);
    expect(ids(p.open)[0]).toBe("A9-hb");
    expect(p.open[0].mark).toBe("waiting");
    const out = list(waiting);
    expect(out).not.toContain('aria-label="Accept: Show who wrote each note"');
    expect(out).toContain(
      'aria-label="Accept: Retry a sync once after a timeout"',
    );
  });
});

describe("the parts (no Deferred)", () => {
  it("puts each agenda in its part from its state; a stored Deferred reads Proposed, Proposed over a running phase", () => {
    const p = parts(PLATFORM);
    expect(ids(p.open)).toEqual(["A12-p3", "A10-h5", "A4-c1"]);
    expect(ids(p.proposed)).toEqual(["A11-f4", "A8-r5", "A6-j2"]);
    expect(ids(p.ended)).toEqual(["A5-q8", "A7-m3"]);
    expect(Object.keys(p)).toEqual(["proposed", "open", "ended"]);
    expect(p.proposed[0].status).toEqual({
      word: "Proposed",
      cls: "status status-pending",
    });
    expect(p.open[0].status.word).toBe("In progress");
    expect(p.open[1].status.word).toBe("Open");
    expect(p.ended.map((r) => r.status.word)).toEqual(["Dropped", "Solved"]);
  });

  it("keeps the operator's order for the open part and sorts the ended newest first, ties in order", () => {
    const agenda = [
      item("A3-b2", "Second open", "open", "2026-11-01"),
      item("A2-c3", "Solved early", "solved", "2026-11-01"),
      item("A1-d4", "First open", "open", "2026-11-17"),
      item("A9-e5", "Solved later", "solved", "2026-11-10"),
      item("A8-f6", "Dropped later too", "dropped", "2026-11-10"),
    ];
    const p = parts(agenda);
    expect(ids(p.open)).toEqual(["A3-b2", "A1-d4"]);
    expect(ids(p.ended)).toEqual(["A9-e5", "A8-f6", "A2-c3"]);
  });

  it("draws the parts in their order, Proposed and the ended part only when they hold an agenda; no Deferred", () => {
    const out = list(PLATFORM);
    const heads = [...out.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map(
      (m) => m[1],
    );
    expect(heads).toEqual([
      "Proposed",
      "Open and in progress",
      "Solved and dropped",
    ]);
    expect(out).not.toContain("Deferred");
    expect(out).not.toContain('class="pager"');
    expect(out).toContain('<p class="meta agenda-head-count">3 agendas</p>');
    const only = list([item("A1-d4", "First open", "open", "2026-11-17")]);
    expect(only.match(/<h2 /g)).toHaveLength(1);
    expect(only).toContain('<p class="meta agenda-head-count">1 agenda</p>');
  });

  it("says the empty sentences and makes Add agenda primary only for an empty workspace", () => {
    const none = list([]);
    expect(none).toContain(
      "No agendas yet. Add what you want done or dealt with, at any size.",
    );
    expect(none).toContain('class="btn btn-primary">Add agenda</button>');
    expect(none).toContain('<p class="meta agenda-head-count">0 agendas</p>');
    const noOpen = list([
      item("A6-j2", "Import highlights from Kindle", "solved", "2026-10-26"),
    ]);
    expect(noOpen).toContain(
      "No open agendas. Add what you want done or dealt with next.",
    );
    expect(noOpen).toContain('class="btn">Add agenda</button>');
  });
});

describe("a row", () => {
  it("ends with its open items (`itemsOpen`) and how far its phases are, or the day it changed", () => {
    const p = parts(PLATFORM);
    expect(p.open.map((r) => r.end)).toEqual([
      "1 of 2 phases done",
      "2 open items",
      "",
    ]);
    expect(
      parts([
        item("A3-b2", "One", "open", "2026-11-01", {
          itemsOpen: 1,
          phases: ["P55-m1"],
        }),
        item("A2-c3", "None open", "open", "2026-11-01", { itemsOpen: 0 }),
      ]).open.map((r) => r.end),
    ).toEqual(["1 open item · 1 of 1 phase done", ""]);
    expect(p.ended.map((r) => r.end)).toEqual(["Nov 14", "Nov 12"]);
    // an item's deferred jobs are folded onto its thread (P61-e9): its end cell names none
    const none = parts([item("A3-b2", "No phase", "open", "2026-11-01")]);
    expect(none.open[0].end).toBe("");
  });

  it("draws the body as the frame's row, led by the grip and the box, the mark and Delete named for the item", () => {
    const out = list(PLATFORM);
    expect(out).toMatch(
      /<li class="row agenda-row" data-row="A12-p3"><button type="button" class="agenda-grip" aria-label="Reorder: Say so when the copy has been behind for a day" aria-describedby="[^"]+-how" aria-pressed="false"><\/button><label class="check agenda-check"><input type="checkbox"\/><span class="sr-only">Select: Say so when the copy has been behind for a day<\/span><\/label><div class="agenda-body"><div class="ws-row agenda-cells"><span class="ws-id">A12-p3<\/span>/,
    );
    expect(out).toContain('<span class="dim ws-end">1 of 2 phases done</span>');
    expect(out).toMatch(
      /data-row="A10-h5">.*?<span class="dim ws-end">2 open items<\/span>.*?data-row="A4-c1"/,
    );
    expect(out).not.toMatch(/data-row="A4-c1">(?:(?!data-row=).)*ws-end/);
    expect(out).toContain(
      '<span class="ws-name-text" lang="ko">하이라이트 색을 직접 고르고 싶어요</span>',
    );
    expect(out).toContain(
      'Show the API’s version on the status page</span><span class="badge is-waiting">Waiting for sync</span>',
    );
    expect(out).toContain(
      '<button type="button" class="agenda-del" aria-label="Delete: Sign-in emails land in spam">Delete</button>',
    );
    expect(out).toContain(
      `href="/projects/${PROJECT}/workspace/agenda/A10-h5"`,
    );
  });
});

describe("no Deferred part, no pages", () => {
  it("lists every Proposed agenda unpaged and links each agenda with no way back to carry", () => {
    const long = longAgenda();
    const out = list(long);
    const proposed = out.slice(
      out.indexOf(">Proposed</h2>"),
      out.indexOf(">Open and in progress</h2>"),
    );
    expect(proposed.match(/data-row=/g)).toHaveLength(25);
    expect(out).not.toContain('class="pager"');
    expect(out).not.toContain("?deferred=");
    expect(out).not.toContain("from=");
    expect(out).toContain(`href="/projects/${PROJECT}/workspace/agenda/A35-n1"`);
  });
});

describe("Solved and dropped", () => {
  it("shows the newest five and Show all N over five", () => {
    expect(endedShown([1, 2, 3, 4, 5], false)).toEqual({
      rows: [1, 2, 3, 4, 5],
      more: null,
    });
    expect(endedShown([1, 2, 3, 4, 5, 6], false)).toEqual({
      rows: [1, 2, 3, 4, 5],
      more: 6,
    });
    expect(endedShown([1, 2, 3, 4, 5, 6], true).rows).toHaveLength(6);
    const out = list(longAgenda());
    const ended = out.slice(out.indexOf(">Solved and dropped</h2>"));
    expect(ended.match(/data-row=/g)).toHaveLength(5);
    expect(ended).toContain(
      '<button type="button" class="link link-row">Show all 13</button>',
    );
    expect(list(PLATFORM)).not.toContain("Show all");
  });
});

describe("the add form", () => {
  const formIds = { title: "f-title", note: "f-note", error: "f-error" };
  const form = (
    phase: "edit" | "adding" | "title-error" | "failed",
    notice: string | null = null,
  ) =>
    html(
      createElement(AddForm, {
        ids: formIds,
        form: { title: "", note: "", phase, notice },
        onChange: () => {},
        onSubmit: () => {},
        onKeyDown: () => {},
        onCancel: () => {},
      }),
    );

  it("puts an add's title refusal, the route's 422, under the field", () => {
    const shown = writeShown(
      { ok: false, reason: "title", message: TITLE_REFUSAL },
      "Could not add the agenda. Try again.",
    );
    expect(shown).toEqual({ kind: "title", message: TITLE_REFUSAL });
    const out = form("title-error");
    expect(out).toContain('aria-invalid="true" aria-describedby="f-error"');
    expect(out).toContain(
      '<p class="field-error" id="f-error">Enter a title of 1–200 characters.</p>',
    );
    expect(out).not.toContain('role="alert"');
  });

  it("puts a failed send over the fields and the route's other lines verbatim", () => {
    expect(
      writeShown(
        { ok: false, reason: "failed" },
        "Could not add the agenda. Try again.",
      ),
    ).toEqual({
      kind: "notice",
      message: "Could not add the agenda. Try again.",
    });
    expect(
      writeShown(
        {
          ok: false,
          reason: "refused",
          message: "note must be text of at most 20000 characters",
        },
        "x",
      ),
    ).toEqual({
      kind: "notice",
      message: "note must be text of at most 20000 characters",
    });
    const out = form("failed", "Could not add the agenda. Try again.");
    expect(out).toContain(
      '<p class="notice notice-danger" role="alert">Could not add the agenda. Try again.</p>',
    );
    expect(out).not.toContain("field-error");
  });

  it("disables both fields and Cancel while adding, Add showing Adding…", () => {
    const out = form("adding");
    expect(out.match(/disabled=""/g)).toHaveLength(3);
    expect(out).toContain(
      'data-busy="true" aria-busy="true"><span class="swap"><span>Add</span><span>Adding…</span></span>',
    );
    expect(out).toContain('placeholder="e.g. Sign-in emails land in spam"');
  });
});

describe("the confirm", () => {
  beforeEach(() => {
    dialogs.props = [];
  });

  const find = (
    node: ReactNode,
    test: (el: ReactElement<Record<string, unknown>>) => boolean,
  ): ReactElement<Record<string, unknown>> | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, test);
        if (hit) return hit;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    const el = node as ReactElement<Record<string, unknown>>;
    if (test(el)) return el;
    return find(el.props.children as ReactNode, test);
  };

  it("opens on Cancel and Cancel or Escape closes it, focus back to its opener", () => {
    const cancelRef = createRef<HTMLButtonElement>();
    const onCancel = vi.fn();
    const out = html(
      createElement(AgendaConfirm, {
        ask: {
          ids: ["A10-h5"],
          title: "Sign-in emails land in spam",
          lang: "en",
          busy: false,
          notice: null,
        },
        cancelRef,
        onCancel,
        onConfirm: () => {},
        returnFocus: () => null,
      }),
    );
    expect(out).toContain(
      '<h2>Delete “<span lang="en">Sign-in emails land in spam</span>”?</h2>',
    );
    expect(out).toContain(
      "<p>It leaves the workspace for good, with its items. Its phases stay. You cannot undo this.</p>",
    );
    expect(out).toMatch(
      />Cancel<\/button><button type="button" class="btn btn-danger"><span class="swap"><span>Yes, delete<\/span><span>Deleting…<\/span>/,
    );
    const props = dialogs.props[0];
    expect(props.label).toBe("Delete “Sign-in emails land in spam”?");
    expect(props.initialFocus).toBe(cancelRef);
    const cancel = find(
      props.children as ReactNode,
      (el) => el.props["data-cancel"] === "true",
    );
    expect(cancel?.props.ref).toBe(cancelRef);
    expect((props.returnFocus as () => unknown)()).toBeNull();
    (props.onClose as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("says the items go with the agenda and only its phases stay, on the agenda page's Delete too", () => {
    // a delete removes the agenda with all its items, folded jobs included (P61-e9)
    expect(AGENDA_ITEM.confirm.text).toBe(
      "It leaves the workspace for good, with its items. Its phases stay. You cannot undo this.",
    );
  });

  it("holds while the delete is sent: Escape does nothing", () => {
    const onCancel = vi.fn();
    html(
      createElement(AgendaConfirm, {
        ask: {
          ids: ["A10-h5"],
          title: "Sign-in emails land in spam",
          lang: "en",
          busy: true,
          notice: null,
        },
        cancelRef: createRef<HTMLButtonElement>(),
        onCancel,
        onConfirm: () => {},
        returnFocus: () => null,
      }),
    );
    const props = dialogs.props[0];
    expect(props.locked).toBe(true);
    (props.onClose as () => void)();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("the open changes no row carries", () => {
  it("draws a waiting one with its mark and Discard, a refused one with the engine's line, Try again and Discard", () => {
    const out = list(PLATFORM, {
      unplaced: [
        {
          entry: "6f1d2c3b-0a9e-4c7d-8b2a-1e3f4a5b6c7d",
          kind: "edit",
          items: ["A3-x9"],
          fields: { title: "Gone" },
          sync: "waiting",
          refused: null,
          created: "2026-11-17T09:00:00Z",
        },
        {
          entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
          kind: "move",
          items: ["A2-y8"],
          fields: { before: "A1-z7" },
          sync: {
            refused: "A1-z7 names no agenda item",
            entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
          },
          refused: "A1-z7 names no agenda item",
          created: "2026-11-17T09:05:00Z",
        },
      ],
    });
    const open = out.slice(out.indexOf(">Open and in progress</h2>"));
    const top = open.slice(0, open.indexOf('<ul class="ws-list"'));
    expect(top).toContain(
      '<span class="ws-id">A3-x9</span><span class="badge is-waiting">Waiting for sync</span>',
    );
    expect(top).toContain("The workspace did not take this change. ");
    expect(top).toContain(
      '<span class="ws-nobr">A1-z7</span> names no agenda item.',
    );
    expect(top.match(/>Discard</g)).toHaveLength(2);
    expect(top.match(/>Try again</g)).toHaveLength(1);
  });

  it("labels a refused notice's Try again by its change's kind (a move saves, a drop drops)", () => {
    const notice = (kind: Unplaced["kind"]): Unplaced => ({
      entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
      kind,
      items: ["A2-y8"],
      fields: {},
      sync: {
        refused: "A2-y8 names no agenda item",
        entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
        kind,
      },
      refused: "A2-y8 names no agenda item",
      created: "2026-11-17T09:05:00Z",
    });
    const retryOf = (out: string) =>
      out.match(
        /<span class="swap"><span>Try again<\/span><span>([^<]*)<\/span><\/span>/,
      )?.[1];
    for (const [kind, pending] of [
      ["drop", "Dropping…"],
      ["propose", "Proposing…"],
      ["item-done", "Saving…"],
      ["split", "Splitting…"],
      ["add", "Adding…"],
      ["move", "Saving…"],
    ] as const)
      expect(retryOf(list(PLATFORM, { unplaced: [notice(kind)] })), kind).toBe(
        pending,
      );
  });
});

describe("after Discard or Try again on an open change no row carries", () => {
  const refused: Unplaced = {
    entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
    kind: "move",
    items: ["A2-y8"],
    fields: { before: "A1-z7" },
    sync: {
      refused: "A1-z7 names no agenda item",
      entry: "7a2e3d4c-1b0f-4d8e-9c3b-2f4a5b6c7d8e",
    },
    refused: "A1-z7 names no agenda item",
    created: "2026-11-17T09:05:00Z",
  };
  const read = { agenda: PLATFORM, unplaced: [refused] };
  const closed = (state: "discarded" | "pending", id = refused.entry) => ({
    id,
    kind: "move" as const,
    items: ["A2-y8"],
    fields: { before: "A1-z7" },
    minted_id: null,
    state,
    reason: null,
    created_at: "2026-11-18T09:00:00Z",
  });

  it("closes the notice and gives the focus to the open part's box (F303: Add item when the part is gone)", () => {
    const done = unplacedDone(
      EMPTY_OVERLAY,
      refused.entry,
      "discard",
      {
        ok: true,
        entry: closed("discarded"),
        item: null,
      },
      "Asia/Seoul",
    );
    expect(view(read, done.overlay).unplaced).toEqual([]);
    expect(done.focus).toBe("open");

    const again = unplacedDone(
      EMPTY_OVERLAY,
      refused.entry,
      "retry",
      {
        ok: true,
        entry: closed("pending", "8b3f4e5d-2c6a-4b7c-9d0e-1f2a3b4c5d6e"),
        item: null,
      },
      "Asia/Seoul",
    );
    expect(again.focus).toBe("open");
    expect(
      view(read, again.overlay).unplaced.map((u) => u.entry),
    ).not.toContain(refused.entry);
  });

  it("Try again on a refused add shows the item it was re-sent as, waiting for sync, once", () => {
    // a refused add no row carries (a newer change took its row's mark, or a delete hides it)
    const add: Unplaced = {
      entry: "9d3c2b1a-0f4e-4a5b-8c7d-6e5f4a3b2c1d",
      kind: "add",
      items: ["A31-q7"],
      fields: { title: "Cache the reader's fonts on the box" },
      sync: {
        refused: "agenda item A31-q7 already exists",
        entry: "9d3c2b1a-0f4e-4a5b-8c7d-6e5f4a3b2c1d",
        kind: "add",
      },
      refused: "agenda item A31-q7 already exists",
      created: "2026-11-18T09:00:00Z",
    };
    const before = { agenda: PLATFORM, unplaced: [add] };
    const again = unplacedDone(
      EMPTY_OVERLAY,
      add.entry,
      "retry",
      {
        ok: true,
        entry: {
          id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          kind: "add",
          items: ["A42-m8"],
          fields: { title: "Cache the reader's fonts on the box" },
          minted_id: "A42-m8",
          state: "pending",
          reason: null,
          created_at: "2026-11-18T09:10:00Z",
        },
        item: "A42-m8",
      },
      "Asia/Seoul",
    ).overlay;
    const resent = (r: { agenda: AgendaItem[]; unplaced: Unplaced[] }) => {
      const shown = view(r, reconcile(again, r));
      return {
        rows: shown.agenda
          .filter((row) => row.id === "A42-m8")
          .map((row) => row.sync),
        notices: shown.unplaced.length,
      };
    };
    const waitingOnce = { rows: ["waiting"], notices: 0 };
    // the read taken before Try again, still naming the refusal
    expect(resent(before)).toEqual(waitingOnce);
    // the read after it: the route draws the re-sent add as its own row, waiting
    const after = {
      agenda: [
        {
          ...PLATFORM[0],
          id: "A42-m8",
          title: "Cache the reader's fonts on the box",
          sync: "waiting" as const,
        },
        ...PLATFORM,
      ],
      unplaced: [],
    };
    expect(resent(after)).toEqual(waitingOnce);
    expect(
      view(after, again).agenda.filter((r) => r.id === "A42-m8"),
    ).toHaveLength(1);
  });

  it("keeps the notice when the send failed; its buttons were disabled while it ran, so the focus still goes to the box", () => {
    const done = unplacedDone(
      EMPTY_OVERLAY,
      refused.entry,
      "discard",
      {
        ok: false,
        reason: "failed",
      },
      "Asia/Seoul",
    );
    expect(done.overlay).toBe(EMPTY_OVERLAY);
    expect(view(read, done.overlay).unplaced).toHaveLength(1);
    expect(done.focus).toBe("open");
  });
});

describe("the page", () => {
  const workspace = (agenda: AgendaItem[]): Workspace => ({
    project: PROJECT,
    linked: true,
    version: "v97",
    sync: { state: "fresh", at: "2026-11-18T08:58:00Z" },
    streams: [],
    pointer: { phase: null, slice: null, next: null, waiting: [] },
    phases: PHASES.map((p) => ({ ...p, name: null }) as unknown as PhaseRow),
    docs: [],
    retired: [],
    agenda,
    unplaced: [],
  });
  const render = async () =>
    html(
      (await AgendaPage({
        params: Promise.resolve({ projectId: PROJECT }),
      })) as ReactElement,
    );

  beforeEach(() => {
    reads.readWorkspace.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("no fetch in a page render");
      }),
    );
  });

  it("makes one Workspace read a page load", async () => {
    reads.readWorkspace.mockResolvedValue({
      state: "ready",
      value: workspace(longAgenda()),
    });
    const out = await render();
    expect(reads.readWorkspace).toHaveBeenCalledTimes(1);
    expect(reads.readWorkspace).toHaveBeenCalledWith("t", PROJECT);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(out).toContain('<a class="subnav-item" aria-current="page"');
    expect(out).toContain('<p class="meta agenda-head-count">25 agendas</p>');
  });

  it("draws WsNav alone when the workspace is not linked, the head and the failed part when the read failed", async () => {
    reads.readWorkspace.mockResolvedValue({
      state: "unlinked",
      head: { version: null, sync: { state: "unlinked", at: null } },
    });
    const unlinked = await render();
    expect(unlinked).toContain(
      "No workspace linked yet. Run this in the project’s repo.",
    );
    expect(unlinked).toContain(
      `sikstack link http://p67.localhost:8080/projects/${PROJECT}`,
    );
    expect(unlinked).not.toContain("agenda-part");
    reads.readWorkspace.mockResolvedValue({
      state: "never",
      head: { version: null, sync: { state: "never", at: null } },
    });
    expect(await render()).toContain("Nothing has synced yet.");
    reads.readWorkspace.mockResolvedValue({ state: "error", status: 503 });
    const failed = await render();
    expect(failed).toContain("The agenda did not load.");
    expect(failed).toContain(">Try again</button>");
    expect(failed).not.toContain("agenda-head-count");
    expect(failed).not.toContain("Add agenda");
    reads.readWorkspace.mockResolvedValue({ state: "not-found" });
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads.readWorkspace).toHaveBeenCalledTimes(4);
  });
});
