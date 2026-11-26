import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BookChapters } from "@/components/book/book-chapters";
import { BookHead } from "@/components/book/book-head";
import {
  clearedView,
  contOf,
  headOf,
  planContinue,
  rowStateView,
  toggleOpen,
  type ContChapter,
  type RowState,
} from "@/lib/book/model";
import type { BookView, RowView } from "@/lib/book/view";

// The book page's rules (sikstack Library, job 03 round 02, `## Build` § Page: book): the way on's five
// modes, one version region open at a time, what a clear turns the page into, and what a visitor sees.
// The look is the fidelity slice's, checked live.

const chapters = (total: number): ContChapter[] =>
  Array.from({ length: total }, (_, i) => ({
    n: i + 1,
    title: `Chapter title ${i + 1}`,
    lang: "en",
    href: `/@o/p/books/b/c${i + 1}`,
  }));

const rows = (...states: RowState[]) =>
  states.map((state, i) => ({ n: i + 1, state, summary: "" }));

function wayOn(
  states: RowState[],
  pointer: { index: number; section?: string; pct?: number } | null,
  signedIn = true,
  extra: { section?: string; lede?: string } = {},
) {
  const plan = planContinue(
    rows(...states),
    signedIn,
    pointer
      ? {
          index: pointer.index,
          section: pointer.section ?? "",
          pct: pointer.pct ?? 0,
        }
      : null,
  );
  return contOf(plan, chapters(states.length), {
    section: extra.section ?? "",
    lede: extra.lede ?? "",
  });
}

describe("the way on: its five modes, each from its reading state", () => {
  it("not started: chapter 1, Read chapter 1, with its lede", () => {
    const c = wayOn(["unopened", "unopened", "unopened"], null, true, {
      lede: "What it is for.",
    });
    expect(c).toMatchObject({
      mode: "start",
      name: "Start reading",
      title: "Chapter title 1",
      facts: ["Chapter 1 of 3"],
      lede: "What it is for.",
      action: "Read chapter 1",
      primary: true,
      href: "/@o/p/books/b/c1",
    });
    // a book of one chapter has no place to give
    expect(wayOn(["unopened"], null).facts).toEqual([]);
  });

  it("in progress: Continue reading, left off at the section, else the percentage, else opened", () => {
    const states: RowState[] = ["finished", "started", "unopened"];
    expect(
      wayOn(states, { index: 1, pct: 64 }, true, { section: "Deduplication" }),
    ).toMatchObject({
      mode: "continue",
      name: "Continue reading",
      title: "Chapter title 2",
      facts: ["Chapter 2 of 3", "Left off at Deduplication"],
      lede: "",
      action: "Continue reading",
      primary: true,
    });
    expect(wayOn(states, { index: 1, pct: 64 }).facts).toEqual([
      "Chapter 2 of 3",
      "Left off at 64%",
    ]);
    expect(wayOn(states, { index: 1, pct: 0 }).facts).toEqual([
      "Chapter 2 of 3",
      "Opened, not read far yet",
    ]);
  });

  it("a finished chapter with a next one: Read next, You finished chapter N, the next one's lede", () => {
    const c = wayOn(
      ["finished", "finished", "unopened", "unopened"],
      { index: 1 },
      true,
      { lede: "The next one." },
    );
    expect(c).toMatchObject({
      mode: "next",
      name: "Next chapter",
      title: "Chapter title 3",
      facts: ["Chapter 3 of 4", "You finished chapter 2"],
      lede: "The next one.",
      action: "Read next",
      primary: true,
      href: "/@o/p/books/b/c3",
    });
  });

  it("all finished: the sentence, no facts, a secondary Read chapter 1 again", () => {
    const c = wayOn(["finished", "finished"], { index: 1 });
    expect(c).toMatchObject({
      mode: "finished",
      name: "Finished",
      title: "You’ve finished all 2 chapters.",
      lang: null,
      facts: [],
      lede: "",
      action: "Read chapter 1 again",
      primary: false,
      href: "/@o/p/books/b/c1",
    });
  });

  it("updated since read: the changed chapter, a primary Read chapter N again", () => {
    const c = wayOn(["finished", "finished", "updated"], { index: 0 });
    expect(c).toMatchObject({
      mode: "finished",
      title: "You’ve finished all 3 chapters.",
      facts: ["Chapter 3 has changed since you finished it."],
      action: "Read chapter 3 again",
      primary: true,
      href: "/@o/p/books/b/c3",
    });
  });

  it("a visitor always starts at chapter 1", () => {
    expect(
      wayOn(["finished", "started"], { index: 1, pct: 40 }, false).mode,
    ).toBe("start");
  });
});

const row = (key: string, n: number, multi: boolean): RowView => ({
  key,
  n,
  title: `Chapter ${n}`,
  lang: "en",
  href: `/c/${key}`,
  updated: false,
  state: rowStateView("started", 40, true),
  langs: [],
  one: multi ? "v2, published Oct 28" : "",
  multiVer: multi,
  groups: multi
    ? [
        {
          code: "en",
          label: "English",
          rows: [2, 1].map((v) => ({
            n: v,
            current: v === 2,
            published: "Published Oct 28",
            from: "",
            aria: `View version ${v}, English`,
            href: `/c/${key}?v=${v}`,
          })),
        },
      ]
    : [],
});

const regions = (html: string) =>
  (html.match(/class="book-versions"/g) ?? []).length;

describe("Version history: one region open at a time", () => {
  it("opening another chapter's history closes the first, and a second press closes it", () => {
    expect(toggleOpen(null, "a")).toBe("a");
    expect(toggleOpen("a", "b")).toBe("b");
    expect(toggleOpen("b", "b")).toBeNull();
  });

  it("draws exactly the open chapter's region", () => {
    const list = [row("a", 1, true), row("b", 2, true), row("c", 3, false)];
    const html = (open: string | null) =>
      renderToStaticMarkup(
        createElement(BookChapters, { rows: list, open, onVersions: () => {} }),
      );
    expect(regions(html(null))).toBe(0);
    expect(regions(html("a"))).toBe(1);
    expect(html("a")).toContain('aria-label="Versions of chapter 1"');
    expect(regions(html("b"))).toBe(1);
    expect(html("b")).toContain('aria-label="Versions of chapter 2"');
    expect(html("b")).not.toContain("Versions of chapter 1");
    // a chapter with no earlier version has no history to open
    expect(regions(html("c"))).toBe(0);
  });
});

function view(): BookView {
  const r = [row("a", 1, true), row("b", 2, false)];
  r[0].state = rowStateView("finished", 100, true);
  r[0].updated = true;
  const start = contOf(
    planContinue(rows("unopened", "unopened"), true, null),
    chapters(2),
    { section: "", lede: "First." },
  );
  return {
    org: "o",
    project: "p",
    slug: "b",
    title: "The book",
    viewer: "member",
    signedIn: true,
    head: headOf({
      title: "The book",
      sub: "",
      description: "",
      place: "Codebase book in p",
      signedIn: true,
      done: 1,
      started: 1,
      total: 2,
    }),
    cont: wayOn(["finished", "started"], { index: 1, pct: 30 }),
    start,
    notes: { href: "/@o/p/notes/b?from=book", line: "3 items in 2 chapters" },
    count: "2 chapters",
    shapeNote: "",
    rows: r,
    data: { chapters: 2, marks: 3 },
    back: { href: "/library", label: "Library" },
    homeHref: "/library",
    signInHref: "/login",
    share: null,
  };
}

describe("a clear", () => {
  it("turns every row Not started, the head Not started, the way on to start, and drops the notes row", () => {
    const before = view();
    expect(before.cont.mode).toBe("continue");
    const after = clearedView(before);
    expect(after.rows.map((r) => r.state)).toEqual([
      { word: "Not started", status: "idle" },
      { word: "Not started", status: "idle" },
    ]);
    expect(after.rows.every((r) => !r.updated)).toBe(true);
    expect(after.head.state).toEqual({ word: "Not started", status: "idle" });
    expect(after.head.pct).toBe(0);
    expect(after.cont).toEqual(before.start);
    expect(after.cont).toMatchObject({
      mode: "start",
      action: "Read chapter 1",
    });
    expect(after.notes).toBeNull();
  });
});

describe("a visitor", () => {
  it("gets no reading state: the count and the line that reading is not saved", () => {
    expect(rowStateView("finished", 100, false)).toBeNull();
    const head = headOf({
      title: "The book",
      sub: "",
      description: "",
      place: "Codebase book in @o / p",
      signedIn: false,
      done: 3,
      started: 1,
      total: 14,
    });
    expect(head.member).toBe(false);
    const html = renderToStaticMarkup(createElement(BookHead, { head }));
    expect(html).toContain("14 chapters");
    expect(html).toContain("Signed-out reading isn’t saved.");
    expect(html).not.toContain("finished");
    expect(html).not.toContain("book-track");
  });

  it("a member reads the state and the track instead", () => {
    const head = headOf({
      title: "The book",
      sub: "",
      description: "",
      place: "Codebase book in p",
      signedIn: true,
      done: 5,
      started: 1,
      total: 14,
    });
    expect(head.state).toEqual({ word: "5 of 14 finished", status: "active" });
    expect(head.pct).toBe(36);
    const html = renderToStaticMarkup(createElement(BookHead, { head }));
    expect(html).toContain("book-track");
    expect(html).not.toContain("Signed-out reading");
  });
});
