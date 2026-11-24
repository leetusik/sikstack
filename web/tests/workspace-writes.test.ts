import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  acceptAgendaItems,
  addAgendaItem,
  deferAgendaItems,
  deleteAgendaItems,
  discardChange,
  dropAgendaItems,
  editAgendaItem,
  moveAgendaItem,
  noteAgendaItem,
  reopenAgendaItems,
  retryChange,
  solveAgendaItems,
} from "@/lib/workspace/actions";
import {
  begin,
  deletedHere,
  discarded,
  EMPTY_OVERLAY,
  reconcile,
  retried,
  settle,
  view,
  written,
  type AgendaRead,
  type Overlay,
} from "@/lib/workspace/optimistic";
import { changeBody, TITLE_REFUSAL } from "@/lib/workspace/rules";
import type { AgendaItem, InboxEntry, Unplaced } from "@/lib/workspace/types";

// The web's agenda writes, and the optimistic model the Agenda and an item's page share. The
// actions post the route's exact payload through the BFF with the session and answer the page with
// data (the entry, the item, the error's words); a change the route would refuse is answered at
// once and sends nothing. The model shows a written change as Waiting for sync until a read shows
// it applied or refused, and never shows one twice.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/session", async (load) => ({
  ...(await load<typeof import("@/lib/session")>()),
  getSession: vi.fn(async () => "session-token"),
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const BASE = `http://kb.test:8766/app/projects/${PROJECT}/workspace`;
const ZONE = "Asia/Seoul";
const NOW = Date.parse("2026-11-18T09:00:00Z");

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function api(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        body:
          init.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

let entries = 0;
function entry(patch: Partial<InboxEntry>): InboxEntry {
  entries += 1;
  return {
    id: `7c1e4b2a-0d3f-4a5b-8c6d-${String(entries).padStart(12, "0")}`,
    kind: "defer",
    items: ["A2-k5"],
    fields: {},
    minted_id: null,
    state: "pending",
    reason: null,
    created_at: "2026-11-18T09:00:00Z",
    ...patch,
  };
}

beforeAll(() => {
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the write actions post the route's exact payload", () => {
  it("adds through the add route, with the id the route minted", async () => {
    const answer = entry({
      kind: "add",
      items: ["A14-c3"],
      minted_id: "A14-c3",
      fields: { title: "Sign-in emails land in spam" },
    });
    const calls = api(201, { entry: answer, item: "A14-c3" });
    const result = await addAgendaItem(PROJECT, {
      title: "  Sign-in emails land in spam ",
      note: "",
    });
    expect(result).toEqual({ ok: true, entry: answer, item: "A14-c3" });
    expect(calls).toEqual([
      {
        url: `${BASE}/agenda`,
        method: "POST",
        body: { title: "Sign-in emails land in spam" },
      },
    ]);
    api(201, { entry: answer, item: "A14-c3" });
    await addAgendaItem(PROJECT, {
      title: "검색이 느려요",
      note: "문단까지 못 찾아요.",
    });
  });

  it("writes each change as one {kind, items, fields}", async () => {
    const cases: [() => Promise<unknown>, unknown][] = [
      [
        () =>
          editAgendaItem(PROJECT, "A2-k5", {
            title: "Uploads that fail twice",
          }),
        {
          kind: "edit",
          items: ["A2-k5"],
          fields: { title: "Uploads that fail twice" },
        },
      ],
      [
        () => editAgendaItem(PROJECT, "A2-k5", { note: "" }),
        { kind: "edit", items: ["A2-k5"], fields: { note: "" } },
      ],
      [
        () => moveAgendaItem(PROJECT, "A2-k5", { before: "A1-h7" }),
        { kind: "move", items: ["A2-k5"], fields: { before: "A1-h7" } },
      ],
      [
        () => moveAgendaItem(PROJECT, "A2-k5", { after: "A1-h7" }),
        { kind: "move", items: ["A2-k5"], fields: { after: "A1-h7" } },
      ],
      [
        () => deferAgendaItems(PROJECT, ["A2-k5", "A11-f4"]),
        { kind: "defer", items: ["A2-k5", "A11-f4"], fields: {} },
      ],
      [
        () => solveAgendaItems(PROJECT, ["A2-k5"]),
        { kind: "solve", items: ["A2-k5"], fields: {} },
      ],
      [
        () => solveAgendaItems(PROJECT, ["A2-k5"], " Indexed. "),
        { kind: "solve", items: ["A2-k5"], fields: { outcome: "Indexed." } },
      ],
      [
        () =>
          dropAgendaItems(PROJECT, ["A8-r5", "A6-j2"], "Kindle has no export."),
        {
          kind: "drop",
          items: ["A8-r5", "A6-j2"],
          fields: { reason: "Kindle has no export." },
        },
      ],
      [
        () => dropAgendaItems(PROJECT, ["A8-r5"], "  "),
        { kind: "drop", items: ["A8-r5"], fields: {} },
      ],
      [
        () => reopenAgendaItems(PROJECT, ["A1-h7", "A1-h7"]),
        { kind: "reopen", items: ["A1-h7"], fields: {} },
      ],
      [
        () => deleteAgendaItems(PROJECT, ["A6-j2", "A8-r5"]),
        { kind: "delete", items: ["A6-j2", "A8-r5"], fields: {} },
      ],
      // P61-e9: Accept on Proposed items, and a note on an item's thread (the server adds its author and source)
      [
        () => acceptAgendaItems(PROJECT, ["A9-hb", "A9-hb"]),
        { kind: "accept", items: ["A9-hb"], fields: {} },
      ],
      [
        () =>
          noteAgendaItem(
            PROJECT,
            "A3-1z",
            "  Seen on the **2 GB** export too.\n",
          ),
        {
          kind: "entry",
          items: ["A3-1z"],
          fields: { kind: "note", body: "Seen on the **2 GB** export too." },
        },
      ],
    ];
    for (const [act, body] of cases) {
      const calls = api(201, { entry: entry({}) });
      const result = (await act()) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(calls).toEqual([
        { url: `${BASE}/agenda/changes`, method: "POST", body },
      ]);
    }
  });

  it("discards and tries again on the entry's own route", async () => {
    const closed = entry({ state: "discarded" });
    let calls = api(200, { entry: closed });
    expect(await discardChange(PROJECT, closed.id)).toEqual({
      ok: true,
      entry: closed,
      item: null,
    });
    expect(calls).toEqual([
      {
        url: `${BASE}/inbox/${closed.id}/discard`,
        method: "POST",
        body: undefined,
      },
    ]);
    const again = entry({
      kind: "add",
      items: ["A15-x2"],
      minted_id: "A15-x2",
    });
    calls = api(201, { entry: again, item: "A15-x2" });
    expect(await retryChange(PROJECT, closed.id)).toEqual({
      ok: true,
      entry: again,
      item: "A15-x2",
    });
    expect(calls[0].url).toBe(`${BASE}/inbox/${closed.id}/retry`);
  });

  it("sends nothing for a change the route would refuse, and says the route's words", async () => {
    const refusals: [() => Promise<unknown>, unknown][] = [
      [
        () => addAgendaItem(PROJECT, { title: "   " }),
        { ok: false, reason: "title", message: TITLE_REFUSAL },
      ],
      [
        () => addAgendaItem(PROJECT, { title: "x".repeat(201) }),
        { ok: false, reason: "title", message: TITLE_REFUSAL },
      ],
      [
        () => addAgendaItem(PROJECT, { title: "Two\nlines" }),
        { ok: false, reason: "title", message: TITLE_REFUSAL },
      ],
      [
        () => addAgendaItem(PROJECT, { title: "One\u2028line" }),
        { ok: false, reason: "title", message: TITLE_REFUSAL },
      ],
      [
        () => editAgendaItem(PROJECT, "A2-k5", { title: "" }),
        { ok: false, reason: "title", message: TITLE_REFUSAL },
      ],
      [
        () => editAgendaItem(PROJECT, "A2-k5", {}),
        {
          ok: false,
          reason: "refused",
          message: "edit takes a title, a note or both",
        },
      ],
      [
        () => deferAgendaItems(PROJECT, []),
        {
          ok: false,
          reason: "refused",
          message: "items must list one or more agenda ids",
        },
      ],
      [
        () => deferAgendaItems(PROJECT, ["A51-05"]),
        {
          ok: false,
          reason: "refused",
          message: "A51-05 is not a full agenda id (like A7-m3)",
        },
      ],
      [
        () => deleteAgendaItems(PROJECT, ["A2-k5", "A2"]),
        {
          ok: false,
          reason: "refused",
          message: "A2 is not a full agenda id (like A7-m3)",
        },
      ],
      [
        () => moveAgendaItem(PROJECT, "A2-k5", { before: "A2-k5" }),
        {
          ok: false,
          reason: "refused",
          message: "an item cannot move before itself",
        },
      ],
      [
        () => discardChange(PROJECT, "not-an-entry"),
        { ok: false, reason: "not-found", message: null },
      ],
      [
        () => deferAgendaItems("../keys", ["A2-k5"]),
        { ok: false, reason: "not-found", message: null },
      ],
    ];
    for (const [act, answer] of refusals) {
      const calls = api(201, { entry: entry({}) });
      expect(await act()).toEqual(answer);
      expect(calls).toEqual([]);
    }
    // A title of 200 characters (Hangul counted by character) passes.
    const calls = api(201, { entry: entry({ kind: "add" }), item: "A16-b4" });
    expect((await addAgendaItem(PROJECT, { title: "검".repeat(200) })).ok).toBe(
      true,
    );
    expect(calls).toHaveLength(1);
  });

  it("refuses an empty note and a second item before sending, in the route's words", async () => {
    const calls = api(201, { entry: entry({}) });
    expect(await noteAgendaItem(PROJECT, "A3-1z", "   ")).toEqual({
      ok: false,
      reason: "refused",
      message: "an entry needs a body of text",
    });
    expect(
      changeBody({
        kind: "entry",
        items: ["A3-1z", "A2-k5"],
        fields: { kind: "note", body: "x" },
      }),
    ).toEqual({ ok: false, error: "entry takes exactly one item" });
    expect(
      changeBody({
        kind: "entry",
        items: ["A3-1z"],
        fields: { kind: "shout" as "note", body: "x" },
      }),
    ).toEqual({
      ok: false,
      error:
        "an entry's kind must be one of note, issue, feedback, question, decision",
    });
    expect(calls).toEqual([]);
  });

  it("sends an edit's note untouched: the item page trims only a note it changed (D308)", () => {
    const code = "    indented code\nstays code";
    expect(
      changeBody({
        kind: "edit",
        items: ["A2-k5"],
        fields: { title: " New title ", note: code },
      }),
    ).toEqual({
      ok: true,
      body: {
        kind: "edit",
        items: ["A2-k5"],
        fields: { title: "New title", note: code },
      },
    });
  });

  it("answers the route's refusals verbatim", async () => {
    api(422, { detail: "A9-zz names no agenda item" });
    expect(await deferAgendaItems(PROJECT, ["A9-zz"])).toEqual({
      ok: false,
      reason: "refused",
      message: "A9-zz names no agenda item",
    });
    api(422, { detail: TITLE_REFUSAL });
    expect(
      await addAgendaItem(PROJECT, { title: "Sign-in emails land in spam" }),
    ).toEqual({
      ok: false,
      reason: "title",
      message: TITLE_REFUSAL,
    });
    api(409, { detail: "this change is applied, not open" });
    expect(await discardChange(PROJECT, entry({}).id)).toEqual({
      ok: false,
      reason: "closed",
      message: "this change is applied, not open",
    });
    api(404, { detail: "workspace not found" });
    expect(await deferAgendaItems(PROJECT, ["A2-k5"])).toEqual({
      ok: false,
      reason: "not-found",
      message: "workspace not found",
    });
    api(503, { detail: "the workspace store is unavailable" });
    expect(await deferAgendaItems(PROJECT, ["A2-k5"])).toEqual({
      ok: false,
      reason: "failed",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await deferAgendaItems(PROJECT, ["A2-k5"])).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

// -- the optimistic model ------------------------------------------------------------------------

function row(
  id: string,
  title: string,
  patch: Partial<AgendaItem> = {},
): AgendaItem {
  return {
    id,
    title,
    lang: /[가-힯]/.test(title) ? "ko" : "en",
    note: "",
    state: "open",
    created: "2026-11-01",
    changed: "2026-11-10",
    phases: [],
    outcome: "",
    reason: "",
    sync: null,
    ...patch,
  };
}

const STORED: AgendaItem[] = [
  row("A2-k5", "Uploads that fail", {
    state: "in_progress",
    phases: ["P8-q4"],
    note: "Seen twice last week.",
  }),
  row("A11-f4", "A weekly mail of what changed in each project"),
  row("A8-r5", "하이라이트 색을 직접 고르고 싶어요"),
  row("A1-h7", "검색이 느려요", {
    state: "solved",
    outcome: "Indexed.",
    changed: "2026-10-20",
  }),
];

function mark(
  items: AgendaItem[],
  marks: Record<string, AgendaItem["sync"]>,
): AgendaItem[] {
  return items.map((r) => (r.id in marks ? { ...r, sync: marks[r.id] } : r));
}

/** Write a change as the page does: the route's answer goes into the overlay. */
function write(overlay: Overlay, e: InboxEntry): Overlay {
  return written(overlay, e, ZONE, NOW);
}

function shown(read: AgendaRead, overlay: Overlay) {
  return view(read, reconcile(overlay, read));
}

describe("the optimistic model", () => {
  it("marks a written change Waiting for sync and shows its result", () => {
    const defer = entry({ kind: "defer", items: ["A11-f4"] });
    const overlay = write(EMPTY_OVERLAY, defer);
    const { agenda } = view({ agenda: STORED }, overlay);
    expect(agenda.find((r) => r.id === "A11-f4")).toMatchObject({
      state: "deferred",
      sync: "waiting",
      changed: "2026-11-18",
    });
    expect(agenda.filter((r) => r.sync === "waiting").map((r) => r.id)).toEqual(
      ["A11-f4"],
    );
  });

  it("keeps a pending change through a read that does not project it, and clears on one that applies it", () => {
    const solve = entry({
      kind: "solve",
      items: ["A11-f4"],
      fields: { outcome: "Sent weekly." },
    });
    let overlay = write(EMPTY_OVERLAY, solve);
    // A read from before the write: no mark, the stored values.
    let read: AgendaRead = { agenda: STORED };
    overlay = reconcile(overlay, read);
    expect(
      view(read, overlay).agenda.find((r) => r.id === "A11-f4"),
    ).toMatchObject({
      state: "solved",
      outcome: "Sent weekly.",
      sync: "waiting",
    });
    // The read after it: the mark, the stored values (the overlay does not project a solve).
    read = { agenda: mark(STORED, { "A11-f4": "waiting" }) };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toHaveLength(1);
    expect(
      view(read, overlay).agenda.find((r) => r.id === "A11-f4"),
    ).toMatchObject({ state: "solved", sync: "waiting" });
    // The sync lands: the stored item is solved, its mark gone.
    read = {
      agenda: STORED.map((r) =>
        r.id === "A11-f4"
          ? { ...r, state: "solved", outcome: "Sent weekly." }
          : r,
      ),
    };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
    expect(
      view(read, overlay).agenda.find((r) => r.id === "A11-f4"),
    ).toMatchObject({ state: "solved", sync: null });
  });

  it("clears a change once seen waiting, even when the engine took it otherwise", () => {
    const reopen = entry({ kind: "reopen", items: ["A1-h7"] });
    let overlay = write(EMPTY_OVERLAY, reopen);
    overlay = reconcile(overlay, {
      agenda: mark(STORED, { "A1-h7": "waiting" }),
    });
    // Reopened, the item reads In progress as its phases say: no mark, and the read wins.
    const read = {
      agenda: STORED.map((r) =>
        r.id === "A1-h7" ? { ...r, state: "in_progress" } : r,
      ),
    };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
  });

  it("clears a change the engine applied otherwise than it was sent, once a sync landed after it (D311)", () => {
    const edit = entry({
      kind: "edit",
      items: ["A11-f4"],
      fields: { title: "A weekly mail" },
      created_at: "2026-11-18T09:00:00Z",
    });
    let overlay = write(EMPTY_OVERLAY, edit);
    // applied before any read showed it waiting, stored otherwise (the engine kept its own words), no mark
    const stored = STORED.map((r) =>
      r.id === "A11-f4" ? { ...r, title: "A weekly mail, per project" } : r,
    );
    // a read from before the write: it stays
    overlay = reconcile(overlay, {
      agenda: stored,
      synced: "2026-11-18T08:58:00Z",
    });
    expect(overlay.changes).toHaveLength(1);
    // the read after the sync that took it: it clears, and the stored title shows without a mark
    const read: AgendaRead = { agenda: stored, synced: "2026-11-18T09:01:00Z" };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
    expect(
      view(read, overlay).agenda.find((r) => r.id === "A11-f4"),
    ).toMatchObject({
      title: "A weekly mail, per project",
      sync: null,
    });
  });

  it("never takes another member's waiting change on the item as this change seen (D311)", () => {
    const move = entry({
      kind: "move",
      items: ["A8-r5"],
      fields: { before: "A2-k5" },
      created_at: "2026-11-18T09:00:00Z",
    });
    let overlay = write(EMPTY_OVERLAY, move);
    // a read from before the write: another member's change on A8-r5 waits
    overlay = reconcile(overlay, {
      agenda: mark(STORED, { "A8-r5": "waiting" }),
      synced: "2026-11-18T08:58:00Z",
    });
    // the next read, still from before this write: that change was taken, this one was not
    const read: AgendaRead = { agenda: STORED, synced: "2026-11-18T08:59:00Z" };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toHaveLength(1);
    const shownRows = view(read, overlay).agenda;
    expect(shownRows.map((r) => r.id).slice(0, 2)).toEqual(["A8-r5", "A2-k5"]);
    expect(shownRows[0].sync).toBe("waiting");
  });

  it("shows an Accept at once, and a thread entry as its item waiting (P61-e9)", () => {
    const proposed = row("A9-hb", "Show who wrote each note", {
      state: "proposed",
      proposed: { by: "agent:claude-opus-5-5", at: "2026-11-20T09:00:00Z" },
    });
    const accept = entry({ kind: "accept", items: ["A9-hb"] });
    const note = entry({
      kind: "entry",
      items: ["A11-f4"],
      fields: { kind: "note", body: "Seen again." },
    });
    let overlay = write(write(EMPTY_OVERLAY, accept), note);
    const read: AgendaRead = { agenda: [proposed, ...STORED] };
    const rows = view(read, overlay).agenda;
    expect(rows.find((r) => r.id === "A9-hb")).toMatchObject({
      state: "proposed",
      accepting: true,
      sync: "waiting",
    });
    expect(rows.find((r) => r.id === "A11-f4")).toMatchObject({
      title: "A weekly mail of what changed in each project",
      sync: "waiting",
    });
    // the read says the accept waits itself (`accepting`): one row, the read's
    overlay = reconcile(overlay, {
      agenda: [
        { ...proposed, accepting: true, sync: "waiting" },
        ...mark(STORED, { "A11-f4": "waiting" }),
      ],
    });
    expect(overlay.changes.map((c) => c.kind)).toEqual(["accept", "entry"]);
  });

  it("shows a refused change's line once, from the read", () => {
    const drop = entry({
      kind: "drop",
      items: ["A8-r5"],
      fields: { reason: "Not now." },
    });
    let overlay = write(EMPTY_OVERLAY, drop);
    const line = "agenda-drop: A8-r5 is already dropped";
    const read: AgendaRead = {
      agenda: mark(STORED, { "A8-r5": { refused: line, entry: drop.id } }),
    };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
    const { agenda, unplaced } = view(read, overlay);
    const lines = agenda.filter(
      (r) =>
        r.sync !== null &&
        typeof r.sync === "object" &&
        r.sync.refused === line,
    );
    expect(lines).toHaveLength(1);
    expect(agenda.find((r) => r.id === "A8-r5")).toMatchObject({
      state: "open",
      sync: { refused: line, entry: drop.id },
    });
    expect(unplaced).toEqual([]);
    // Even unreconciled, a change the read shows refused is not also shown waiting.
    expect(
      view(read, write(EMPTY_OVERLAY, drop)).agenda.find(
        (r) => r.id === "A8-r5",
      )?.sync,
    ).toEqual({ refused: line, entry: drop.id });
  });

  it("hides a pending delete's item, and lets the read take over", () => {
    const del = entry({ kind: "delete", items: ["A8-r5", "A11-f4"] });
    let overlay = write(EMPTY_OVERLAY, del);
    // A read from before the delete still holds them: hidden here.
    expect(shown({ agenda: STORED }, overlay).agenda.map((r) => r.id)).toEqual([
      "A2-k5",
      "A1-h7",
    ]);
    expect(deletedHere(overlay, "A8-r5")).toBe(true);
    // The read hides them itself: the change is the read's now.
    const read = {
      agenda: STORED.filter((r) => r.id !== "A8-r5" && r.id !== "A11-f4"),
    };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
    expect(view(read, overlay).agenda.map((r) => r.id)).toEqual([
      "A2-k5",
      "A1-h7",
    ]);
  });

  it("puts an add first, and never shows it twice", () => {
    const add = entry({
      kind: "add",
      items: ["A14-c3"],
      minted_id: "A14-c3",
      fields: { title: "알림을 한 번만 보내기", note: "두 번 갑니다." },
    });
    let overlay = write(EMPTY_OVERLAY, add);
    let { agenda } = shown({ agenda: STORED }, overlay);
    expect(agenda[0]).toMatchObject({
      id: "A14-c3",
      title: "알림을 한 번만 보내기",
      lang: "ko",
      state: "open",
      sync: "waiting",
      created: "2026-11-18",
    });
    // The read carries the add as its own row: one row, the read's.
    const read = {
      agenda: [
        row("A14-c3", "알림을 한 번만 보내기", { sync: "waiting" }),
        ...STORED,
      ],
    };
    overlay = reconcile(overlay, read);
    expect(overlay.changes).toEqual([]);
    ({ agenda } = view(read, overlay));
    expect(agenda.filter((r) => r.id === "A14-c3")).toHaveLength(1);
    // Unreconciled too.
    expect(
      view(read, write(EMPTY_OVERLAY, add)).agenda.filter(
        (r) => r.id === "A14-c3",
      ),
    ).toHaveLength(1);
  });

  it("moves an item before or after another, and reopens to the end of the order", () => {
    let overlay = write(
      EMPTY_OVERLAY,
      entry({ kind: "move", items: ["A8-r5"], fields: { before: "A2-k5" } }),
    );
    expect(view({ agenda: STORED }, overlay).agenda.map((r) => r.id)).toEqual([
      "A8-r5",
      "A2-k5",
      "A11-f4",
      "A1-h7",
    ]);
    overlay = write(
      EMPTY_OVERLAY,
      entry({ kind: "move", items: ["A2-k5"], fields: { after: "A8-r5" } }),
    );
    expect(view({ agenda: STORED }, overlay).agenda.map((r) => r.id)).toEqual([
      "A11-f4",
      "A8-r5",
      "A2-k5",
      "A1-h7",
    ]);
    overlay = write(EMPTY_OVERLAY, entry({ kind: "reopen", items: ["A1-h7"] }));
    const deferredFirst = [STORED[3], ...STORED.slice(0, 3)];
    const reopened = view({ agenda: deferredFirst }, overlay).agenda;
    expect(reopened.map((r) => r.id)).toEqual([
      "A2-k5",
      "A11-f4",
      "A8-r5",
      "A1-h7",
    ]);
    expect(reopened[3]).toMatchObject({
      state: "open",
      outcome: "",
      sync: "waiting",
    });
  });

  it("edits the title, note and language", () => {
    const overlay = write(
      EMPTY_OVERLAY,
      entry({
        kind: "edit",
        items: ["A2-k5"],
        fields: { title: "업로드가 실패해요" },
      }),
    );
    expect(view({ agenda: STORED }, overlay).agenda[0]).toMatchObject({
      title: "업로드가 실패해요",
      lang: "ko",
      note: "Seen twice last week.",
      sync: "waiting",
    });
  });

  it("drops a change the route did not take, and keeps one it did", () => {
    const begun = begin(
      EMPTY_OVERLAY,
      { kind: "move", items: ["A11-f4"], fields: { before: "A2-k5" } },
      ZONE,
      NOW,
    );
    expect(view({ agenda: STORED }, begun.overlay).agenda[0].id).toBe("A11-f4");
    // A read while it is sent cannot clear it.
    expect(reconcile(begun.overlay, { agenda: STORED }).changes).toHaveLength(
      1,
    );
    expect(settle(begun.overlay, begun.key, { ok: false }).changes).toEqual([]);
    const move = entry({
      kind: "move",
      items: ["A11-f4"],
      fields: { before: "A2-k5" },
    });
    const kept = settle(begun.overlay, begun.key, { ok: true, entry: move });
    expect(kept.changes).toMatchObject([
      { entry: move.id, kind: "move", seen: false },
    ]);
  });

  it("discards a refused change at once, a refused add with its row", () => {
    const add = entry({
      kind: "add",
      items: ["A14-c3"],
      minted_id: "A14-c3",
      state: "refused",
      reason: "agenda-add: A14-c3 exists",
    });
    const edit = entry({
      kind: "edit",
      items: ["A2-k5"],
      state: "refused",
      reason: "agenda-edit: refused",
    });
    const read: AgendaRead = {
      agenda: [
        row("A14-c3", "Sign-in emails land in spam", {
          sync: { refused: add.reason as string, entry: add.id },
        }),
        ...mark(STORED, {
          "A2-k5": { refused: edit.reason as string, entry: edit.id },
        }),
      ],
    };
    let overlay = discarded(EMPTY_OVERLAY, { ...add, state: "discarded" });
    overlay = discarded(overlay, { ...edit, state: "discarded" });
    const { agenda } = shown(read, overlay);
    expect(agenda.map((r) => r.id)).toEqual([
      "A2-k5",
      "A11-f4",
      "A8-r5",
      "A1-h7",
    ]);
    expect(agenda[0].sync).toBeNull();
    // The read without them: nothing left to hide.
    expect(reconcile(overlay, { agenda: STORED }).closed).toEqual([]);
  });

  it("tries again: the old refusal goes and the new change waits, once", () => {
    const refusedEntry = entry({
      kind: "defer",
      items: ["A11-f4"],
      state: "refused",
      reason: "agenda-defer: locked",
    });
    const again = entry({ kind: "defer", items: ["A11-f4"] });
    const read: AgendaRead = {
      agenda: mark(STORED, {
        "A11-f4": { refused: "agenda-defer: locked", entry: refusedEntry.id },
      }),
    };
    const overlay = retried(EMPTY_OVERLAY, refusedEntry.id, again, ZONE, NOW);
    const { agenda } = shown(read, overlay);
    expect(agenda.find((r) => r.id === "A11-f4")).toMatchObject({
      state: "deferred",
      sync: "waiting",
    });
  });

  it("lists an unplaced change from the read, and hides one discarded here", () => {
    const gone = entry({
      kind: "solve",
      items: ["A3-q8"],
      state: "refused",
      reason: "A3-q8 names no agenda item",
    });
    const unplaced: Unplaced[] = [
      {
        entry: gone.id,
        kind: "solve",
        items: ["A3-q8"],
        fields: {},
        sync: { refused: "A3-q8 names no agenda item", entry: gone.id },
        refused: "A3-q8 names no agenda item",
        created: "2026-11-17T22:10:00Z",
      },
    ];
    expect(shown({ agenda: STORED, unplaced }, EMPTY_OVERLAY).unplaced).toEqual(
      unplaced,
    );
    const overlay = discarded(EMPTY_OVERLAY, { ...gone, state: "discarded" });
    expect(shown({ agenda: STORED, unplaced }, overlay).unplaced).toEqual([]);
    // A change of ours whose item went is the read's to list, once.
    const ours = write(EMPTY_OVERLAY, gone);
    expect(reconcile(ours, { agenda: STORED, unplaced }).changes).toEqual([]);
  });
});
