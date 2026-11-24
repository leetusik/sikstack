import {
  createElement,
  createRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgendaItem, PhaseRow } from "@/lib/workspace/types";

// The Agenda's picked rows (design job 02, `AgendaList.dc.html`, frame.md F303, F309, round:Q2, round:Q3): each
// part's boxes cover its rows on screen only (a Deferred page, the five ended rows shown), the count, Clear and the
// actions in their one order in the head and in the narrow strip, Drop and Delete asking while the others act at
// once, and each action written as one change for exactly the picked ids (Solve with no outcome, Reopen to the end
// of the open order). Node only: the pure model, server renders, and the actions mocked.

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => ({ refresh: vi.fn() }),
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
const actions = vi.hoisted(() => ({
  addAgendaItem: vi.fn(),
  deferAgendaItems: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  dropAgendaItems: vi.fn(),
  moveAgendaItem: vi.fn(),
  reopenAgendaItems: vi.fn(),
  retryChange: vi.fn(),
  solveAgendaItems: vi.fn(),
}));
vi.mock("@/lib/workspace/actions", () => actions);

const {
  actAsks,
  actSending,
  AgendaConfirm,
  AgendaList,
  agendaParts,
  BulkStrip,
  NO_PICKS,
  PART_ACTS,
  PartBar,
  PartCheck,
  partPick,
  partPicks,
  rowsOnScreen,
  sendAct,
  sendOrder,
  toggleAll,
  toggleRow,
} = await import("@/sikstack/workspace/agenda");
const { AGENDA } = await import("@/content/workspace/agenda");
const { dates, phaseLookup } = await import("@/lib/workspace/model");
const { begin, EMPTY_OVERLAY, view } =
  await import("@/lib/workspace/optimistic");

const html = (el: ReactElement) => renderToStaticMarkup(el);
const PROJECT = "3f9c2a10-6d4e-4b8a-9f1e-2c7d5b8a0e41";
const TZ = "Asia/Seoul";
const fmt = dates(TZ, Date.parse("2026-11-18T09:00:00Z"));

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
    lang: /[가-힯]/.test(title) ? "ko" : "en",
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
];

const OPEN_TITLES = [
  "Retry failed uploads",
  "Dead-letter topic for the importer",
  "Schema drift alerts",
  "Import preview before the first sync",
  "Nightly export to the archive",
];
const DEFERRED_TITLES = [
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
const ENDED_TITLES = [
  "Keep the reading place across devices",
  "Search inside a book’s notes",
  "Import highlights from Kindle",
  "A shortcut to the last document",
  "Dark mode for the reader",
  "Show the API’s version on the status page",
  "Footnotes in the exported PDF",
  "Copy a passage with its link",
];

/**
 * A long agenda (`fn-14`'s shape, fewer open): 5 open, 25 deferred over two weeks (each day twice, so ties keep the
 * operator's order), 8 ended; the parts interleaved in the operator's order as a real agenda file has them.
 */
function longAgenda(): AgendaItem[] {
  const out: AgendaItem[] = [];
  DEFERRED_TITLES.forEach((t, i) => {
    if (i < OPEN_TITLES.length)
      out.push(
        item(`A${10 + i}-k${i + 1}`, OPEN_TITLES[i], "open", "2026-11-01"),
      );
    out.push(
      item(
        `A${35 + i}-n${(i % 8) + 1}`,
        t,
        "deferred",
        `2026-11-${String(1 + (i % 14)).padStart(2, "0")}`,
      ),
    );
    if (i < ENDED_TITLES.length)
      out.push(
        item(
          `A${60 + i}-r${(i % 8) + 1}`,
          ENDED_TITLES[i],
          i % 2 ? "dropped" : "solved",
          `2026-10-${String(10 + i).padStart(2, "0")}`,
        ),
      );
  });
  return out;
}

const parts = (agenda: readonly AgendaItem[]) =>
  agendaParts(agenda, phaseLookup(PHASES), fmt.date);
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

const list = (agenda: AgendaItem[], page: number | null = null) =>
  html(
    createElement(AgendaList, {
      project: PROJECT,
      read: { agenda, unplaced: [] },
      phases: PHASES,
      timeZone: TZ,
      deferredPage: page,
    }),
  );

describe("what is picked", () => {
  it("is exactly the part's rows on screen that are ticked: a Deferred page's ten, the five ended rows shown", () => {
    const agenda = longAgenda();
    const p = parts(agenda);
    expect(p.deferred).toHaveLength(25);
    const on = rowsOnScreen(p, 2, false);
    const page2 = ids(p.deferred.slice(10, 20));
    expect(ids(on.deferred)).toEqual(page2);
    expect(ids(on.ended)).toEqual(ids(p.ended.slice(0, 5)));
    // The part's box picks the rows on screen, never the whole part.
    const before = partPicks(on, p, NO_PICKS);
    expect(before.deferred.allLabel).toBe(
      "Select the 10 deferred items on this page",
    );
    expect(before.ended.allLabel).toBe(
      "Select the 5 solved and dropped items on this page",
    );
    expect(before.open.allLabel).toBe("Select all 5 open items");
    expect(toggleAll(before.deferred)).toEqual(page2);
    expect(toggleAll(before.ended)).toEqual(ids(p.ended.slice(0, 5)));
    const ticked = {
      ...NO_PICKS,
      deferred: toggleAll(before.deferred),
      ended: toggleAll(before.ended),
    };
    const after = partPicks(on, p, ticked);
    expect(after.deferred.picked).toEqual(page2);
    expect(after.deferred).toMatchObject({
      all: true,
      some: false,
      count: "10 of 25 selected",
    });
    expect(after.ended.picked).toEqual(ids(p.ended.slice(0, 5)));
    expect(after.ended.count).toBe("5 of 8 selected");
    // Ids ticked on another page, or every id of the part, still pick only what is on screen.
    const everything = partPicks(on, p, {
      ...NO_PICKS,
      deferred: ids(p.deferred),
      ended: ids(p.ended),
    });
    expect(everything.deferred.picked).toEqual(page2);
    expect(everything.ended.picked).toEqual(ids(p.ended.slice(0, 5)));
    // Pressed again with all of them picked, the box clears them.
    expect(toggleAll(after.deferred)).toEqual([]);
    // Show all brings the rest on screen, and the box then names all of them.
    const allEnded = partPicks(rowsOnScreen(p, 2, true), p, NO_PICKS).ended;
    expect(allEnded.allLabel).toBe("Select all 8 solved and dropped items");
  });

  it("half sets the box when some are picked, counts them against the whole part, and draws it named", () => {
    const shown = ["A10-k1", "A11-k2", "A12-k3"];
    const one = partPick("open", shown, 3, toggleRow([], "A11-k2"));
    expect(one).toMatchObject({
      picked: ["A11-k2"],
      all: false,
      some: true,
      count: "1 of 3 selected",
    });
    expect(toggleRow(one.picked, "A11-k2")).toEqual([]);
    const none = partPick("open", shown, 3, []);
    expect(none).toMatchObject({ some: false, all: false, count: "3 items" });
    expect(
      html(
        createElement(PartCheck, { pick: partPick("open", shown, 3, shown) }),
      ),
    ).toBe(
      '<label class="check agenda-check"><input type="checkbox" checked=""/><span class="sr-only">Select all 3 open items</span></label>',
    );
  });

  it("draws every part's box and every row's box on the page, the Deferred box named for the page on screen", () => {
    const out = list(longAgenda(), 2);
    expect(out).toContain(
      '<span class="sr-only">Select the 10 deferred items on this page</span>',
    );
    expect(out).toContain(
      '<span class="sr-only">Select all 5 open items</span>',
    );
    expect(out).toContain(
      '<span class="sr-only">Select the 5 solved and dropped items on this page</span>',
    );
    expect(out).toContain(
      '<label class="check agenda-check"><input type="checkbox"/><span class="sr-only">Select: 실패한 행만 골라 다시 내려받기</span></label>',
    );
    // 5 open + 10 deferred + 5 ended rows, and three part boxes; nothing picked yet, so no bar and no strip.
    expect(out.match(/class="check agenda-check"/g)).toHaveLength(23);
    expect(out).not.toContain("agenda-bulk");
    expect(out).not.toContain(">Clear<");
    // An agenda with no open item draws no box over the open part.
    const noOpen = list([
      item("A6-j2", "Import highlights from Kindle", "deferred", "2026-10-26"),
    ]);
    expect(noOpen).not.toContain("Select all 0 open items");
    expect(noOpen).toContain("Select all 1 deferred items");
  });
});

describe("the actions", () => {
  const texts = (out: string) =>
    [
      ...out.matchAll(
        /<button type="button" class="btn[^"]*">([^<]+)<\/button>/g,
      ),
    ].map((m) => m[1]);

  it("come in one order in the head and in the strip: Open, Deferred, Solved and dropped", () => {
    const pick = (part: "open" | "deferred" | "ended") =>
      partPick(part, ["A10-k1", "A11-k2", "A12-k3"], 7, ["A10-k1", "A12-k3"]);
    expect(texts(html(createElement(PartBar, { pick: pick("open") })))).toEqual(
      ["Clear", "Delete", "Defer", "Drop", "Solve"],
    );
    expect(
      texts(html(createElement(PartBar, { pick: pick("deferred") }))),
    ).toEqual(["Clear", "Delete", "Reopen", "Drop", "Solve"]);
    expect(
      texts(html(createElement(PartBar, { pick: pick("ended") }))),
    ).toEqual(["Clear", "Delete", "Reopen"]);
    for (const part of ["open", "deferred", "ended"] as const)
      expect(
        texts(html(createElement(BulkStrip, { pick: pick(part) }))),
      ).toEqual(texts(html(createElement(PartBar, { pick: pick(part) }))));
    expect(PART_ACTS).toEqual({
      open: ["delete", "defer", "drop", "solve"],
      deferred: ["delete", "reopen", "drop", "solve"],
      ended: ["delete", "reopen"],
    });
  });

  it("put Clear and the actions on the head's line from 52em, and the narrow strip at the part's end, named and counted", () => {
    const pick = partPick("open", ["A10-k1", "A11-k2", "A12-k3"], 3, [
      "A11-k2",
      "A12-k3",
    ]);
    expect(html(createElement(PartBar, { pick }))).toBe(
      '<button type="button" class="btn agenda-wide">Clear</button><div class="cluster agenda-head-acts agenda-wide"><button type="button" class="btn">Delete</button><button type="button" class="btn">Defer</button><button type="button" class="btn">Drop</button><button type="button" class="btn">Solve</button></div>',
    );
    const strip = html(createElement(BulkStrip, { pick }));
    expect(strip).toMatch(
      /^<div class="agenda-bulk" role="group" aria-label="Act on the selected open items"><p class="meta agenda-bulk-count">2 of 3 selected<\/p><button type="button" class="btn">Clear<\/button><div class="cluster agenda-bulk-acts">/,
    );
    expect(
      html(
        createElement(BulkStrip, {
          pick: partPick("ended", ["A60-r1"], 8, ["A60-r1"]),
        }),
      ),
    ).toContain('aria-label="Act on the selected solved and dropped items"');
  });

  it("ask first for Drop and Delete only; Defer, Solve and Reopen act at once", () => {
    expect(
      (["delete", "defer", "reopen", "drop", "solve"] as const).map(actAsks),
    ).toEqual([true, false, false, true, false]);
  });

  describe("each writes one change for the picked ids", () => {
    beforeEach(() => {
      for (const fn of Object.values(actions)) {
        fn.mockReset();
        fn.mockResolvedValue({ ok: false, reason: "failed" });
      }
    });
    const picked = ["A37-n3", "A35-n1", "A40-n6"];

    it("Defer, Solve with no outcome, Reopen, Drop with its reason or none, Delete", async () => {
      await sendAct(PROJECT, "defer", picked);
      expect(actions.deferAgendaItems).toHaveBeenCalledWith(PROJECT, picked);
      await sendAct(PROJECT, "solve", picked);
      expect(actions.solveAgendaItems.mock.calls).toEqual([[PROJECT, picked]]);
      await sendAct(PROJECT, "reopen", picked);
      expect(actions.reopenAgendaItems).toHaveBeenCalledWith(PROJECT, picked);
      await sendAct(PROJECT, "drop", picked, "  ");
      await sendAct(PROJECT, "drop", picked, "The Library's search covers it.");
      expect(actions.dropAgendaItems.mock.calls).toEqual([
        [PROJECT, picked, undefined],
        [PROJECT, picked, "The Library's search covers it."],
      ]);
      await sendAct(PROJECT, "delete", picked);
      expect(actions.deleteAgendaItems).toHaveBeenCalledWith(PROJECT, picked);
      for (const fn of [
        actions.deferAgendaItems,
        actions.reopenAgendaItems,
        actions.deleteAgendaItems,
      ])
        expect(fn).toHaveBeenCalledTimes(1);
      expect(actions.moveAgendaItem).not.toHaveBeenCalled();
      // What the page shows at once: the same kind and ids, Solve with no outcome.
      expect(actSending("solve", picked)).toEqual({
        kind: "solve",
        items: picked,
        fields: {},
      });
    });

    it("sends the ids in the agenda's order, so Reopen puts them at the end of the open order as the engine will", () => {
      const agenda = longAgenda();
      const p = parts(agenda);
      // Page 1 of Deferred shows newest first; pick three of its rows in the order shown.
      const on = rowsOnScreen(p, 1, false);
      const shownOrder = [
        on.deferred[0].id,
        on.deferred[4].id,
        on.deferred[7].id,
      ];
      const sent = sendOrder(agenda, shownOrder);
      expect(new Set(sent)).toEqual(new Set(shownOrder));
      expect(sent).toEqual(
        agenda.map((it) => it.id).filter((id) => shownOrder.includes(id)),
      );
      expect(sent).not.toEqual(shownOrder);
      const shown = view(
        { agenda, unplaced: [] },
        begin(EMPTY_OVERLAY, actSending("reopen", sent), TZ).overlay,
      );
      const after = parts(shown.agenda);
      // The engine reopens in the order the ids are given, each last in the open order: the page shows the same.
      expect(ids(after.open)).toEqual([...ids(p.open), ...sent]);
      expect(after.open.slice(-3).every((r) => r.mark === "waiting")).toBe(
        true,
      );
      expect(after.deferred).toHaveLength(22);
    });
  });

  it("say what they did in the status line", () => {
    const t = "Schema drift alerts for the nightly export";
    expect(AGENDA.said.acted("defer", 3, t)).toBe(
      "3 items deferred. They wait for the next sync.",
    );
    expect(AGENDA.said.acted("solve", 1, t)).toBe(
      "“Schema drift alerts for the nightly export” solved. It waits for the next sync.",
    );
    expect(AGENDA.said.acted("reopen", 1, t)).toBe(
      "“Schema drift alerts for the nightly export” reopened, at the end of the open items. It waits for the next sync.",
    );
    expect(AGENDA.said.acted("drop", 2, t)).toBe(
      "2 items dropped. They wait for the next sync.",
    );
    expect(AGENDA.said.acted("delete", 1, t)).toBe(
      "“Schema drift alerts for the nightly export” deleted. It leaves the workspace at the next sync.",
    );
    expect(AGENDA.said.acted("delete", 4, t)).toBe(
      "4 items deleted. They leave the workspace at the next sync.",
    );
  });
});

describe("Drop's and Delete's confirm", () => {
  beforeEach(() => {
    dialogs.props = [];
  });
  const confirm = (
    ask: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    html(
      createElement(AgendaConfirm, {
        ask: {
          ids: ["A36-n2"],
          title: "Schema drift alerts for the nightly export",
          lang: "en",
          busy: false,
          notice: null,
          ...ask,
        } as never,
        cancelRef: createRef<HTMLButtonElement>(),
        reasonId: "r-reason",
        onCancel: () => {},
        onConfirm: () => {},
        returnFocus: () => null,
        ...extra,
      }),
    );

  it("asks Drop with one optional Reason and Yes, drop", () => {
    const one = confirm({ kind: "drop", reason: "" });
    expect(one).toContain(
      '<h2>Drop “<span lang="en">Schema drift alerts for the nightly export</span>”?</h2><p>It moves to Solved and dropped. Reopen brings it back.</p>',
    );
    expect(one).toContain(
      '<div class="field"><label class="label" for="r-reason">Reason (optional)</label><input class="input" id="r-reason" type="text" autoComplete="off" value=""/></div>',
    );
    expect(one).toMatch(
      />Cancel<\/button><button type="button" class="btn btn-primary"><span class="swap"><span>Yes, drop<\/span><span>Dropping…<\/span>/,
    );
    expect(dialogs.props[0].label).toBe(
      "Drop “Schema drift alerts for the nightly export”?",
    );
    const many = confirm({
      kind: "drop",
      ids: ["A36-n2", "A35-n1", "A47-n5"],
      reason: "Covered by the export",
    });
    expect(many).toContain(
      "<h2>Drop 3 items?</h2><p>They move to Solved and dropped. Reopen brings one back.</p>",
    );
    expect(many).toContain('value="Covered by the export"');
    expect(dialogs.props[1].label).toBe("Drop 3 items?");
  });

  it("asks Delete with no field and Yes, delete; many items say they leave for good", () => {
    const many = confirm({ kind: "delete", ids: ["A36-n2", "A35-n1"] });
    expect(many).toContain(
      "<h2>Delete 2 items?</h2><p>They leave the agenda for good, with their notes. Their phases and deferred jobs stay. You cannot undo this.</p>",
    );
    expect(many).not.toContain("Reason (optional)");
    expect(many).toMatch(
      /class="btn btn-danger"><span class="swap"><span>Yes, delete<\/span><span>Deleting…<\/span>/,
    );
  });

  it("holds while it is sent: Escape does nothing and the Reason cannot change", () => {
    const onCancel = vi.fn();
    const out = confirm(
      { kind: "drop", reason: "Covered", busy: true },
      { onCancel },
    );
    expect(out).toContain('disabled="" value="Covered"');
    expect(dialogs.props[0].locked).toBe(true);
    (dialogs.props[0].onClose as () => void)();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
