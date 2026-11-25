import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgendaItem, PhaseRow } from "@/lib/workspace/types";

// The Agenda's reorder (design job 02, `AgendaList.dc.html`, frame.md F302): the grip on the open part's rows, the
// keyboard's steps (Space or Enter lifts and puts down, the arrows move one place with focus kept on the grip, Escape
// or Tab puts back), the pointer's drag (where the row lands, how the others slide), each step's sentence, and the one
// `move` a put down writes: its before/after gives exactly the order the lift showed, and nothing else writes. Node
// only: the pure reorder model, the overlay the page lays over a read, and server renders.

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<object>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/lib/workspace/actions", () => ({
  addAgendaItem: vi.fn(),
  proposeAgendaItems: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  dropAgendaItems: vi.fn(),
  moveAgendaItem: vi.fn(),
  reopenAgendaItems: vi.fn(),
  retryChange: vi.fn(),
  solveAgendaItems: vi.fn(),
}));

const {
  AgendaList,
  agendaParts,
  dragAt,
  dragDelta,
  dragShift,
  EDGE_ZONE,
  edgeScroll,
  Grip,
  gripBlur,
  gripKey,
  liftedOrder,
  movePlace,
} = await import("@/sikstack/workspace/agenda");
const { dates, phaseLookup } = await import("@/lib/workspace/model");
const { begin, EMPTY_OVERLAY, view } =
  await import("@/lib/workspace/optimistic");
const { changeBody } = await import("@/lib/workspace/rules");

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
  { id: "P55-m1", short: "P55", status: "done" },
];

/** `platform`'s agenda in the operator's order: five open agendas with proposed and ended ones between them. */
const AGENDA: AgendaItem[] = [
  item(
    "A12-p3",
    "Say so when the copy has been behind for a day",
    "open",
    "2026-11-13",
    { phases: ["P56-t8", "P55-m1"] },
  ),
  item(
    "A11-f4",
    "A weekly mail of what changed in each project",
    "proposed",
    "2026-11-09",
  ),
  item("A10-h5", "Sign-in emails land in spam", "open", "2026-11-02"),
  item(
    "A7-m3",
    "Keep the reading place across devices",
    "solved",
    "2026-11-12",
  ),
  item("A9-k2", "하이라이트 색을 직접 고르고 싶어요", "open", "2026-11-05"),
  item(
    "A4-c1",
    "Show the API’s version on the status page",
    "open",
    "2026-11-15",
    {
      sync: "waiting",
    },
  ),
  item("A6-j2", "Import highlights from Kindle", "proposed", "2026-10-26"),
  item("A3-n7", "Search inside a book’s notes", "open", "2026-10-30"),
];

const parts = (agenda: readonly AgendaItem[]) =>
  agendaParts(agenda, phaseLookup(PHASES), fmt.date);
const OPEN = parts(AGENDA).open.map((r) => r.id);
const TITLES = new Map(AGENDA.map((it) => [it.id, it.title ?? it.id]));
const title = (id: string) => TITLES.get(id) ?? id;

/** Press keys on grips in turn, as the list does: each step's lift feeds the next. */
function press(steps: [id: string, key: string][]) {
  let lift: { id: string; at: number } | null = null;
  const out = [];
  for (const [id, key] of steps) {
    const step = gripKey(OPEN, title, lift, id, key);
    out.push(step);
    if (step) lift = step.lift;
  }
  return { steps: out, lift };
}

describe("the grip", () => {
  it("leads every open row, named for its item and described by the hidden sentence; the other parts keep the empty cell", () => {
    const out = html(
      createElement(AgendaList, {
        project: PROJECT,
        read: { agenda: AGENDA, unplaced: [] },
        phases: PHASES,
        timeZone: TZ,
      }),
    );
    const how = /aria-describedby="([^"]+-how)"/.exec(out)?.[1];
    expect(how).toBeDefined();
    expect(out).toContain(
      `<li class="row agenda-row" data-row="A10-h5"><button type="button" class="agenda-grip" aria-label="Reorder: Sign-in emails land in spam" aria-describedby="${how}" aria-pressed="false"></button><label class="check agenda-check">`,
    );
    expect(out).toContain(
      `<p class="sr-only" id="${how}">Space picks the agenda up. The arrow keys move it, Space puts it down, Escape puts it back.</p>`,
    );
    expect(out.match(/class="agenda-grip"/g)).toHaveLength(5);
    expect(out).toContain(
      '<li class="row agenda-row" data-row="A7-m3"><span class="agenda-nogrip" aria-hidden="true"></span><label class="check agenda-check">',
    );
    expect(out).toContain(
      '<li class="row agenda-row" data-row="A11-f4"><span class="agenda-nogrip" aria-hidden="true"></span><div class="agenda-body">',
    );
    expect(out.match(/class="agenda-nogrip"/g)).toHaveLength(3);
    expect(
      html(
        createElement(Grip, {
          title: "Sign-in emails land in spam",
          howId: "h",
          lifted: true,
        }),
      ),
    ).toContain('aria-pressed="true"');
  });

  it("holds the sheet's grip: 44 px, the 14 × 8 mark, touch-action none, the accent while lifted, the slide off under reduced motion", () => {
    const css = readFileSync(
      fileURLToPath(
        new URL("../src/sikstack/styles/workspace/agenda.css", import.meta.url),
      ),
      "utf8",
    );
    expect(css).toMatch(
      /\.agenda-grip \{[^}]*width: var\(--control-h\); height: var\(--control-h\);[^}]*cursor: grab; touch-action: none; \}/,
    );
    expect(css).toMatch(
      /\.agenda-grip::before \{[^}]*width: 14px; height: var\(--space-2\); border-block: 2px solid currentColor; \}/,
    );
    expect(css).toContain(
      '.agenda-grip[aria-pressed="true"] { color: var(--accent); cursor: grabbing; }',
    );
    expect(css).toContain(
      ".agenda-dragging .agenda-row:not(.is-lifted) { transition: transform 150ms ease; }",
    );
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) { .agenda-dragging .agenda-row:not(.is-lifted) { transition: none; } }",
    );
  });
});

describe("the keyboard", () => {
  it("lifts with Space, moves one place an arrow, and a put down writes the move before the item it now precedes", () => {
    // A9-k2 is 3 of 5; up one, then down two, then up one: 3 of 5 again, then up once more to 2 of 5.
    const { steps } = press([
      ["A9-k2", " "],
      ["A9-k2", "ArrowUp"],
      ["A9-k2", "ArrowDown"],
      ["A9-k2", "ArrowDown"],
      ["A9-k2", "ArrowUp"],
      ["A9-k2", "ArrowUp"],
      ["A9-k2", " "],
    ]);
    expect(steps.map((s) => s?.said)).toEqual([
      "“하이라이트 색을 직접 고르고 싶어요” picked up, 3 of 5. The arrow keys move it, Space puts it down, Escape puts it back.",
      "“하이라이트 색을 직접 고르고 싶어요” moved to 2 of 5.",
      "“하이라이트 색을 직접 고르고 싶어요” moved to 3 of 5.",
      "“하이라이트 색을 직접 고르고 싶어요” moved to 4 of 5.",
      "“하이라이트 색을 직접 고르고 싶어요” moved to 3 of 5.",
      "“하이라이트 색을 직접 고르고 싶어요” moved to 2 of 5.",
      "“하이라이트 색을 직접 고르고 싶어요” put down at 2 of 5. It waits for the next sync.",
    ]);
    // Only the put down writes, and it writes one move: before Sign-in emails, which now follows it.
    expect(steps.slice(0, 6).every((s) => s?.put === null)).toBe(true);
    expect(steps[6]?.put).toEqual({ id: "A9-k2", place: { before: "A10-h5" } });
    expect(steps[6]?.lift).toBeNull();
    // Enter lifts and puts down too; to the end it writes after the last item.
    const end = press([
      ["A12-p3", "Enter"],
      ...Array.from({ length: 6 }, (): [string, string] => [
        "A12-p3",
        "ArrowDown",
      ]),
      ["A12-p3", "Enter"],
    ]);
    expect(end.steps.at(-1)?.put).toEqual({
      id: "A12-p3",
      place: { after: "A3-n7" },
    });
    expect(end.steps.at(-1)?.said).toBe(
      "“Say so when the copy has been behind for a day” put down at 5 of 5. It waits for the next sync.",
    );
    // The fifth ArrowDown is at the end already: no step said, nothing moves.
    expect(end.steps[5]?.said).toBeNull();
    // Put down where it was: nothing written.
    const still = press([
      ["A10-h5", " "],
      ["A10-h5", "ArrowDown"],
      ["A10-h5", "ArrowUp"],
      ["A10-h5", " "],
    ]);
    expect(still.steps.at(-1)?.put).toBeNull();
    expect(still.steps.at(-1)?.said).toBe(
      "“Sign-in emails land in spam” put down where it was.",
    );
  });

  it("writes exactly the order the lift showed, for every move of every row, among proposed and ended agendas", () => {
    const read = { agenda: AGENDA, unplaced: [] };
    for (const id of OPEN) {
      for (let at = 0; at < OPEN.length; at += 1) {
        const place = movePlace(OPEN, id, at);
        const lifted = liftedOrder(
          OPEN.map((x) => ({ id: x })),
          { id, at },
        ).map((r) => r.id);
        if (OPEN.indexOf(id) === at) {
          expect(place).toBeNull();
          continue;
        }
        expect(place).not.toBeNull();
        // The route takes it, and it names an open item beside the moved one.
        const target = "before" in place! ? place.before : place!.after;
        expect(OPEN).toContain(target);
        expect(target).not.toBe(id);
        expect(
          changeBody({ kind: "move", items: [id], fields: place! }).ok,
        ).toBe(true);
        const shown = view(
          read,
          begin(
            EMPTY_OVERLAY,
            { kind: "move", items: [id], fields: place! },
            TZ,
          ).overlay,
        );
        const after = parts(shown.agenda);
        expect(after.open.map((r) => r.id)).toEqual(lifted);
        // The moved row waits for the sync; every other keeps its mark, and no other part changes.
        for (const r of after.open)
          expect(r.mark).toBe(
            r.id === id || r.id === "A4-c1" ? "waiting" : null,
          );
        expect(after.proposed.map((r) => r.id)).toEqual(["A11-f4", "A6-j2"]);
        expect(after.ended.map((r) => r.id)).toEqual(["A7-m3"]);
      }
    }
  });

  it("puts the row back on Escape or Tab, says where it is, and writes nothing", () => {
    const esc = press([
      ["A4-c1", " "],
      ["A4-c1", "ArrowUp"],
      ["A4-c1", "ArrowUp"],
      ["A4-c1", "Escape"],
    ]);
    expect(esc.steps.at(-1)).toEqual({
      lift: null,
      said: "Move cancelled. “Show the API’s version on the status page” is back at 4 of 5.",
      put: null,
      focus: "A4-c1",
    });
    expect(esc.steps.every((s) => s?.put === null)).toBe(true);
    // Tab is not the grip's: it does its default, and the blur puts the row back.
    const lifted = press([
      ["A4-c1", " "],
      ["A4-c1", "ArrowUp"],
    ]);
    expect(gripKey(OPEN, title, lifted.lift, "A4-c1", "Tab")).toBeNull();
    expect(gripBlur(OPEN, title, lifted.lift, "A4-c1", null)).toEqual({
      lift: null,
      said: "Move cancelled. “Show the API’s version on the status page” is back at 4 of 5.",
      put: null,
      focus: null,
    });
    // A grip that is not lifted, or no lift at all: nothing.
    expect(gripBlur(OPEN, title, lifted.lift, "A10-h5", null)).toBeNull();
    expect(gripBlur(OPEN, title, null, "A4-c1", null)).toBeNull();
    // Arrows and Escape on a grip that is not lifted are not the grip's.
    expect(gripKey(OPEN, title, null, "A4-c1", "ArrowUp")).toBeNull();
    expect(gripKey(OPEN, title, null, "A4-c1", "Escape")).toBeNull();
  });

  it("keeps the focus on the moved row's grip through every step, the blur of the re-order not putting it back", () => {
    const { steps, lift } = press([
      ["A10-h5", " "],
      ["A10-h5", "ArrowDown"],
      ["A10-h5", "ArrowDown"],
      ["A10-h5", "ArrowUp"],
    ]);
    expect(steps.map((s) => s?.focus)).toEqual([
      "A10-h5",
      "A10-h5",
      "A10-h5",
      "A10-h5",
    ]);
    expect(lift).toEqual({ id: "A10-h5", at: 2 });
    // The list re-orders under the focused grip: that blur is the step's, and the row stays lifted.
    expect(gripBlur(OPEN, title, lift, "A10-h5", "A10-h5")).toBeNull();
    expect(
      liftedOrder(
        OPEN.map((id) => ({ id })),
        lift,
      ).map((r) => r.id),
    ).toEqual(["A12-p3", "A9-k2", "A10-h5", "A4-c1", "A3-n7"]);
    // The put down keeps it too.
    const put = gripKey(OPEN, title, lift, "A10-h5", " ");
    expect(put?.focus).toBe("A10-h5");
    expect(put?.put).toEqual({ id: "A10-h5", place: { before: "A4-c1" } });
  });
});

describe("the pointer", () => {
  // Five rows of 60 px from y 100: their middles.
  const mids = [130, 190, 250, 310, 370];

  it("lands the row where its middle passes the others' middles, and the rows between slide by its height", () => {
    expect(dragAt(mids, 3, 0)).toBe(3);
    expect(dragAt(mids, 3, -29)).toBe(3);
    expect(dragAt(mids, 3, -61)).toBe(2);
    expect(dragAt(mids, 3, -130)).toBe(1);
    expect(dragAt(mids, 3, -500)).toBe(0);
    expect(dragAt(mids, 0, 125)).toBe(2);
    expect(dragAt(mids, 0, 900)).toBe(4);
    const up = { id: "A4-c1", from: 3, at: 1, dy: -130, h: 60 };
    expect([0, 1, 2, 3, 4].map((k) => dragShift(k, up))).toEqual([
      0, 60, 60, -130, 0,
    ]);
    const down = { id: "A12-p3", from: 0, at: 2, dy: 125, h: 60 };
    expect([0, 1, 2, 3, 4].map((k) => dragShift(k, down))).toEqual([
      125, -60, -60, 0, 0,
    ]);
    expect(dragShift(2, null)).toBe(0);
  });

  it("puts a released row down at its gap with one move; released where it was, nothing", () => {
    // A4-c1 (4 of 5) dragged up past two middles: it lands at 2 of 5, before Sign-in emails.
    const at = dragAt(mids, 3, -130);
    expect(movePlace(OPEN, "A4-c1", at)).toEqual({ before: "A10-h5" });
    expect(movePlace(OPEN, "A4-c1", dragAt(mids, 3, 20))).toBeNull();
    expect(movePlace(OPEN, "A12-p3", dragAt(mids, 0, 900))).toEqual({
      after: "A3-n7",
    });
  });
});

describe("the pointer near the window's edge", () => {
  // A phone: a window 844 px tall over a page that scrolls 1,400 px; the open rows 190 px tall.
  const VIEW = 844;
  const MAX = 1400;

  it("scrolls the window while the lifted row's pointer is within the edge band, faster nearer the edge", () => {
    expect(edgeScroll(420, VIEW, 300, MAX)).toBe(0);
    expect(edgeScroll(EDGE_ZONE, VIEW, 300, MAX)).toBe(0);
    expect(edgeScroll(VIEW - EDGE_ZONE, VIEW, 300, MAX)).toBe(0);
    const down = [VIEW - EDGE_ZONE + 8, VIEW - 30, VIEW - 2].map((y) =>
      edgeScroll(y, VIEW, 300, MAX),
    );
    expect(down.every((d) => d > 0)).toBe(true);
    expect(down[0]).toBeLessThan(down[1]);
    expect(down[1]).toBeLessThan(down[2]);
    const up = edgeScroll(6, VIEW, 300, MAX);
    expect(up).toBeLessThan(0);
    expect(up).toBe(-edgeScroll(VIEW - 6, VIEW, 300, MAX));
    // a captured pointer dragged past the window's edge scrolls at the band's top speed, no faster
    expect(edgeScroll(VIEW + 200, VIEW, 300, MAX)).toBe(
      edgeScroll(VIEW, VIEW, 300, MAX),
    );
    expect(edgeScroll(-200, VIEW, 300, MAX)).toBe(
      edgeScroll(0, VIEW, 300, MAX),
    );
  });

  it("stops at the ends: never above the top or past the bottom", () => {
    expect(edgeScroll(4, VIEW, 0, MAX)).toBe(0);
    expect(edgeScroll(VIEW - 4, VIEW, MAX, MAX)).toBe(0);
    expect(edgeScroll(4, VIEW, 3, MAX)).toBe(-3);
    expect(edgeScroll(VIEW - 4, VIEW, MAX - 5, MAX)).toBe(5);
    // a page that does not scroll never does
    expect(edgeScroll(VIEW - 4, VIEW, 0, 0)).toBe(0);
    // held at the bottom edge, frame after frame, the window comes to rest exactly at the end
    let top = 0;
    let frames = 0;
    for (let step = 1; step !== 0 && frames < 1000; frames += 1) {
      step = edgeScroll(VIEW - 10, VIEW, top, MAX);
      top += step;
    }
    expect(top).toBe(MAX);
    expect(frames).toBeLessThan(200);
  });

  it("moves the lifted row by the pointer and the scroll together, and a drop after a scroll writes the place it shows", () => {
    // The five open rows from y 205 at the drag's start (two below the window's edge).
    const mids = [300, 490, 680, 870, 1060];
    expect(dragDelta(820, 300, 0, 0)).toBe(520);
    expect(dragDelta(820, 300, 600, 0)).toBe(1120);
    expect(dragDelta(30, 820, 100, 700)).toBe(-1390);
    // held at the bottom edge without a scroll, Say so (1 of 5) only reaches the rows on screen
    expect(
      movePlace(OPEN, "A12-p3", dragAt(mids, 0, dragDelta(820, 300, 0, 0))),
    ).toEqual({
      before: "A4-c1",
    });
    // after the window scrolled 900 px under the held pointer, it lands last: after the last open item
    const at = dragAt(mids, 0, dragDelta(820, 300, 900, 0));
    expect(at).toBe(4);
    expect(movePlace(OPEN, "A12-p3", at)).toEqual({ after: "A3-n7" });
    // and back up: the last row, the window scrolled back to the top, lands first
    expect(
      movePlace(
        OPEN,
        "A3-n7",
        dragAt(mids, 4, dragDelta(40, 1060 - 900, 0, 900)),
      ),
    ).toEqual({ before: "A12-p3" });
  });
});
