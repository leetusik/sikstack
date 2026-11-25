import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AgendaItemPage,
  itemActions,
  itemLines,
  itemView,
  openCount,
  splitError,
  threadView,
  type ItemPageRead,
} from "@/sikstack/workspace/agenda-item";
import { wsSyncLine } from "@/sikstack/workspace/frame";
import { EMPTY_OVERLAY } from "@/lib/workspace/optimistic";
import type { AgendaItem, ThreadEntry } from "@/lib/workspace/types";

// An agenda's items (the agenda items phase): each item with its ref, its state (Open, Done, Dismissed; Deleted while
// its delete waits) and who set it; Done, Dismiss, Delete on an open item, Reopen and Delete on a done or dismissed
// one; the Split's early checks; and the read's prediction while a change waits (the item's state, the agenda closing
// itself when its last open item goes) drawn as the read gives it, waiting for the sync. Node only: the pure model
// and server renders.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/workspace/actions", () => ({
  acceptAgendaItems: vi.fn(),
  changeAgendaEntries: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  dropAgendaItems: vi.fn(),
  editAgendaItem: vi.fn(),
  noteAgendaItem: vi.fn(),
  proposeAgendaItems: vi.fn(),
  reopenAgendaItems: vi.fn(),
  retryChange: vi.fn(),
  solveAgendaItems: vi.fn(),
  splitAgenda: vi.fn(),
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const ZONE = "Asia/Seoul";
const NOW = Date.parse("2026-11-25T09:00:00Z");
const HEAD = {
  version: "v97",
  sync: { state: "fresh" as const, at: "2026-11-25T08:58:00Z" },
};

function entry(
  tail: string,
  extra: Partial<ThreadEntry> = {},
): ThreadEntry {
  const id = `20261124T0${tail.length}0000.00000${tail.length}Z-${tail}`;
  return {
    id,
    file: `${id}.json`,
    ref: `A2-k5/${tail}`,
    state: "open",
    stateBy: null,
    stateAt: null,
    deleting: false,
    kind: "note",
    author: "person:mina",
    by: "person",
    name: "mina",
    source: "web:agenda",
    created: "2026-11-24T08:00:00Z",
    body: `About ${tail}.`,
    job: null,
    sync: null,
    ...extra,
  };
}

const ITEMS: ThreadEntry[] = [
  entry("xa01", {
    kind: "issue",
    author: "agent:fold",
    by: "agent",
    name: "fold",
    source: "slice:P7-k2.S1",
  }),
  entry("hnj0", {
    state: "done",
    stateBy: "person:sg",
    stateAt: "2026-11-24T09:00:00Z",
  }),
  entry("b7c2", { state: "dismissed", stateBy: "agent:claude" }),
  entry("q9r4", { deleting: true, sync: "waiting" }),
  {
    ...entry("zz00"),
    id: "0ff1c2d3-0000-4000-8000-000000000001",
    file: null,
    ref: null,
    body: "A note the engine has not written yet.",
    sync: "waiting",
  },
];

const AGENDA: AgendaItem = {
  id: "A2-k5",
  title: "Uploads that fail on a slow network",
  lang: "en",
  note: "",
  state: "open",
  created: "2026-11-20",
  changed: "2026-11-24",
  phases: [],
  outcome: "",
  reason: "",
  entryCount: 4,
  itemsOpen: 1,
  sync: null,
  entries: ITEMS,
};

const at = { project: PROJECT, when: (v: string | null) => (v ? v.slice(5, 10) : "") };

function page(item: AgendaItem): string {
  const read: ItemPageRead = {
    state: "ready",
    item,
    ...itemLines(item, { phases: [] }),
  };
  return renderToStaticMarkup(
    createElement(AgendaItemPage, {
      project: PROJECT,
      back: { href: `/projects/${PROJECT}/workspace`, label: "Agenda" },
      line: wsSyncLine(HEAD.sync, HEAD.version, { timeZone: ZONE, now: NOW }),
      timeZone: ZONE,
      now: NOW,
      read,
    }),
  );
}

describe("an agenda's items", () => {
  it("reads each item's ref, state, who set it, and what it offers", () => {
    const view = threadView(ITEMS, at);
    expect(
      view.map((e) => [e.ref, e.status.word, e.stateBy?.name ?? null, e.actions]),
    ).toEqual([
      ["A2-k5/xa01", "Open", null, ["done", "dismiss", "delete"]],
      ["A2-k5/hnj0", "Done", "sg", ["reopen", "delete"]],
      ["A2-k5/b7c2", "Dismissed", "claude", ["reopen", "delete"]],
      // its delete waits: marked, nothing offered
      ["A2-k5/q9r4", "Deleted", null, []],
      // a note not yet written has no file: nothing to change yet
      [null, "Open", null, []],
    ]);
    expect(view.map((e) => e.status.cls)).toEqual([
      "status status-idle",
      "status status-done",
      "status status-revoked",
      "status status-revoked",
      "status status-idle",
    ]);
    expect(view[1].file).toBe("20261124T040000.000004Z-hnj0.json");
    // an older read with no state reads open
    expect(itemActions({ file: "x.json", state: undefined })).toEqual([
      "done",
      "dismiss",
      "delete",
    ]);
    // open now: not done, not dismissed, not waiting to be deleted, not a note not yet written
    expect(openCount(view)).toBe(1);
  });

  it("draws the Items panel: count, Split, each item's state, ref and its buttons named for it", () => {
    const html = page(AGENDA);
    expect(html).toContain(">Items</h2>");
    // the item whose delete waits leaves the count, as it leaves the read's
    expect(html).toContain(">4 items, 1 open</p>");
    expect(html).toContain('<button type="button" class="btn">Split</button>');
    expect(html).toContain('<span class="status status-done">Done</span>');
    expect(html).toContain(
      '<span class="dim">by <span class="ws-author"><span class="strong">sg</span></span></span>',
    );
    expect(html).toContain('<span class="ws-id">A2-k5/hnj0</span>');
    expect(html).toContain('aria-label="Done: A2-k5/xa01"');
    expect(html).toContain('aria-label="Dismiss: A2-k5/xa01"');
    expect(html).toContain('aria-label="Delete: A2-k5/xa01"');
    expect(html).toContain('aria-label="Reopen: A2-k5/hnj0"');
    expect(html).not.toContain('aria-label="Done: A2-k5/q9r4"');
    expect(html).toContain('<span class="status status-revoked">Deleted</span>');
    // the buttons swap to their pending label while sent, at the same width
    expect(html).toContain(
      '<span class="swap"><span>Dismiss</span><span>Dismissing…</span></span>',
    );
    // no Split with one item that can move
    const one = page({ ...AGENDA, entries: [ITEMS[0]], entryCount: 1 });
    expect(one).not.toContain(">Split</button>");
  });

  it("draws the read's prediction while an item change waits: the item Done, the agenda Solved with its outcome", () => {
    // the server's read after Done on the last open item: the item done by the account, the agenda closed itself
    const predicted: AgendaItem = {
      ...AGENDA,
      state: "solved",
      outcome: "all items dealt with: 2 done, 1 dismissed",
      itemsOpen: 0,
      sync: "waiting",
      entries: ITEMS.slice(0, 3).map((e, i) =>
        i === 0
          ? {
              ...e,
              state: "done",
              stateBy: "person:you",
              stateAt: "2026-11-25T08:59:00Z",
              sync: "waiting",
            }
          : e,
      ),
    };
    const v = itemView(
      { item: predicted, phases: [] },
      EMPTY_OVERLAY,
    );
    expect(v?.status).toBe("solved");
    expect(v?.waiting).toBe(true);
    expect(v?.actions).toEqual(["delete", "edit", "reopen"]);
    expect(v?.end).toEqual({
      label: "outcome",
      text: "all items dealt with: 2 done, 1 dismissed",
    });
    const html = page(predicted);
    expect(html).toContain('class="status status-done">Solved');
    expect(html).toContain("all items dealt with: 2 done, 1 dismissed");
    expect(html).toContain("Waiting for sync");
    const items = html.slice(html.indexOf('class="thread"'));
    expect(items).toContain('<span class="status status-done">Done</span>');
    expect(items).toContain('aria-label="Reopen: A2-k5/xa01"');
    expect(html).toContain(">3 items</p>");
  });
});

describe("the Split's early checks", () => {
  const files = ITEMS.slice(0, 3).map((e) => e.file as string);

  it("needs an item picked, at least one left behind, and a title by the signed rule", () => {
    expect(splitError([], files, "Retry")).toEqual({
      field: "items",
      message: "Select the items to move first.",
    });
    expect(splitError(files, files, "Retry")).toEqual({
      field: "items",
      message: "Leave at least one item here.",
    });
    expect(splitError([files[0]], files, "  ")).toEqual({
      field: "title",
      message: "Enter a title of 1–200 characters.",
    });
    expect(splitError([files[0], "gone.json"], files, "Retry")).toBeNull();
  });
});
