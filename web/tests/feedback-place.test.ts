import { describe, expect, it } from "vitest";

import {
  AT_REST,
  decodeFeedbackFrom,
  feedbackBackHref,
  feedbackChangeHref,
  feedbackHref,
  feedbackItemHref,
  feedbackListHref,
  feedbackPageHref,
  isFiltered,
  readFeedbackPlace,
  valid,
  type FeedbackPlace,
} from "@/lib/feedback/place";

// P65 — the Feedback list's place and the way back (job 04 round 02, F128, F134, F340): blanks are absent,
// a search or a filter starts at the first page, a page keeps the rest, the way back returns to the
// list's last address and nothing else, and an address no list answers is No such view.

const ORG = { projects: [{ id: "p1" }, { id: "p2" }] };
const place = (over: Partial<FeedbackPlace> = {}): FeedbackPlace => ({
  ...AT_REST,
  ...over,
});

describe("the list's place", () => {
  it("reads the address, blanks absent, a repeated key its first value", () => {
    expect(readFeedbackPlace({})).toEqual(AT_REST);
    expect(
      readFeedbackPlace({ q: "  ", project: "", rating: "", page: "" }),
    ).toEqual(AT_REST);
    expect(
      readFeedbackPlace({
        page: "3",
        q: " 결제 ",
        project: ["p1", "p2"],
        rating: "disliked",
        cursor: "abc",
      }),
    ).toEqual({
      page: 3,
      q: "결제",
      project: "p1",
      rating: "disliked",
      state: "open",
    });
  });

  it("has no project filter in a project's list", () => {
    expect(readFeedbackPlace({ project: "p2", q: "x" }, "p1")).toEqual(
      place({ q: "x" }),
    );
    expect(feedbackListHref("p1", place({ project: "p2", q: "x" }))).toBe(
      "/projects/p1/feedback?q=x",
    );
  });

  it("writes blanks and page 1 out of the address", () => {
    expect(feedbackListHref(null, AT_REST)).toBe("/feedback");
    expect(feedbackListHref(null, place({ q: " " }))).toBe("/feedback");
    expect(
      feedbackListHref(
        null,
        place({ page: 2, q: "a b", project: "p1", rating: "liked" }),
      ),
    ).toBe("/feedback?page=2&q=a+b&project=p1&rating=liked");
  });

  it("round-trips through the address", () => {
    const p = place({
      page: 4,
      q: "환불 & refund",
      project: "p2",
      rating: "liked",
    });
    const url = new URL(feedbackListHref(null, p), "https://x.invalid");
    expect(readFeedbackPlace(Object.fromEntries(url.searchParams))).toEqual(p);
  });

  it("starts at the first page on a search or a filter change, keeping the rest", () => {
    const at = place({ page: 3, q: "refund", project: "p1", rating: "liked" });
    expect(feedbackChangeHref(null, at, { rating: "disliked" })).toBe(
      "/feedback?q=refund&project=p1&rating=disliked",
    );
    expect(feedbackChangeHref(null, at, { q: "late" })).toBe(
      "/feedback?q=late&project=p1&rating=liked",
    );
    expect(feedbackChangeHref(null, at, { project: null })).toBe(
      "/feedback?q=refund&rating=liked",
    );
  });

  it("keeps the search and filters on a page link", () => {
    const at = place({ page: 3, q: "refund", project: "p1", rating: "liked" });
    expect(feedbackPageHref(null, at, 5)).toBe(
      "/feedback?page=5&q=refund&project=p1&rating=liked",
    );
    expect(feedbackPageHref(null, at, 1)).toBe(
      "/feedback?q=refund&project=p1&rating=liked",
    );
    expect(feedbackPageHref("p1", place({ q: "x" }), 2)).toBe(
      "/projects/p1/feedback?page=2&q=x",
    );
  });

  it("says whether a search or a filter is set (the page is neither)", () => {
    expect(isFiltered(place({ page: 4 }))).toBe(false);
    expect(isFiltered(place({ q: "a" }))).toBe(true);
    expect(isFiltered(place({ rating: "liked" }))).toBe(true);
  });
});

describe("No such view", () => {
  it("is a filter naming a project outside the org", () => {
    expect(valid(ORG, readFeedbackPlace({ project: "p1" }))).toBe(true);
    expect(valid(ORG, readFeedbackPlace({ project: "other-org" }))).toBe(false);
    expect(valid({ projects: [] }, readFeedbackPlace({ project: "p1" }))).toBe(
      false,
    );
  });

  it("is a rating other than liked and disliked", () => {
    for (const rating of ["unrated", "1", "Liked", "x"])
      expect(valid(ORG, readFeedbackPlace({ rating }))).toBe(false);
    expect(valid(ORG, readFeedbackPlace({ rating: "liked" }))).toBe(true);
  });

  it("is a page that is not a whole number from 1", () => {
    for (const page of ["0", "x", "-1", "1.5", "01", "9999999"])
      expect(valid(ORG, readFeedbackPlace({ page }))).toBe(false);
    expect(valid(ORG, readFeedbackPlace({ page: "12" }))).toBe(true);
  });

  it("never throws", () => {
    expect(() =>
      readFeedbackPlace({ page: "%", q: "\u0000", rating: ["?"] }),
    ).not.toThrow();
  });
});

describe("the way back", () => {
  const left = place({ page: 3, q: "refund", project: "p1", rating: "liked" });

  it("carries the list's address on an item opened from it, and returns there", () => {
    const href = feedbackItemHref(null, "f 1", left);
    const url = new URL(href, "https://x.invalid");
    expect(url.pathname).toBe("/feedback/f%201");
    const from = url.searchParams.get("from");
    expect(from).toBe("/feedback?page=3&q=refund&project=p1&rating=liked");
    expect(feedbackBackHref(null, from)).toBe(from);
  });

  it("carries a project's list's address within that project", () => {
    const href = feedbackItemHref(
      "p1",
      "f1",
      place({ page: 2, rating: "disliked" }),
    );
    const from = new URL(href, "https://x.invalid").searchParams.get("from");
    expect(href.split("?")[0]).toBe("/projects/p1/feedback/f1");
    expect(feedbackBackHref("p1", from)).toBe(
      "/projects/p1/feedback?page=2&rating=disliked",
    );
  });

  it("carries nothing from a list at rest", () => {
    expect(feedbackItemHref(null, "f1", AT_REST)).toBe("/feedback/f1");
    expect(feedbackItemHref("p1", "f1")).toBe("/projects/p1/feedback/f1");
  });

  it("falls back to the list at rest for a hostile, foreign or unknown address", () => {
    for (const raw of [
      "//evil.example.com",
      "//evil.example.com/feedback",
      "https://x",
      "https://x/feedback?page=2",
      "/\\evil.example.com/feedback",
      "/library",
      "/library?page=2",
      "/feedback/../library",
      "/feedback?cursor=abc",
      "/feedback?feedback_value=1",
      "/feedback?page=2&page=3",
      "/feedback?rating=unrated",
      "/feedback?page=0",
      "/feedback?page=x",
      "/feedback?page=2#top",
      "/feedback?q=re\tfund",
      `/feedback?q=${"a".repeat(2100)}`,
      "/feedbackx?page=2",
      "/projects/p1/feedback?page=2",
      "",
      null,
      undefined,
      ["/feedback?page=2"],
    ])
      expect(feedbackBackHref(null, raw)).toBe("/feedback");
  });

  it("keeps an item's way back within its own scope", () => {
    expect(feedbackBackHref("p1", "/feedback?page=2")).toBe(
      "/projects/p1/feedback",
    );
    expect(feedbackBackHref("p1", "/projects/p2/feedback?page=2")).toBe(
      "/projects/p1/feedback",
    );
    expect(feedbackBackHref("p1", "/projects/p1/feedback?project=p2")).toBe(
      "/projects/p1/feedback",
    );
  });

  it("is rebuilt from its parts, never echoed", () => {
    expect(decodeFeedbackFrom("/feedback?rating=liked&q=a", null)).toEqual(
      place({ q: "a", rating: "liked" }),
    );
    expect(feedbackBackHref(null, "/feedback?rating=liked&q=a")).toBe(
      "/feedback?q=a&rating=liked",
    );
  });

  it("leads the rail and Clear to the list at rest for what the Shell shows", () => {
    expect(feedbackHref()).toBe("/feedback");
    expect(feedbackHref("p 1")).toBe("/projects/p%201/feedback");
  });
});

// P91-v3 — the list shows one state at a time (`?state=filed|resolved|dropped`, absent for Open, the default): the
// state is the list's own place, kept by a search, a filter, a page and the way back, and a state the list does not
// show is No such view.
describe("the state in the list's place", () => {
  it("reads Open from no state, and each other state from its value", () => {
    expect(readFeedbackPlace({})).toEqual(place({ state: "open" }));
    expect(readFeedbackPlace({ state: "open" })).toEqual(AT_REST);
    for (const s of ["filed", "resolved", "dropped"] as const)
      expect(readFeedbackPlace({ state: s })).toEqual(place({ state: s }));
    expect(readFeedbackPlace({ state: "dropped" }, "p1")).toEqual(
      place({ state: "dropped" }),
    );
  });

  it("is No such view for a state the list does not show", () => {
    for (const s of ["all", "Filed", "dismissed", "x"])
      expect(valid(ORG, readFeedbackPlace({ state: s }))).toBe(false);
  });

  it("writes Open out of the address and every other state into it", () => {
    expect(feedbackListHref(null, place({ state: "open" }))).toBe("/feedback");
    expect(feedbackListHref(null, place({ state: "filed" }))).toBe(
      "/feedback?state=filed",
    );
    expect(
      feedbackListHref("p1", place({ page: 2, q: "x", state: "resolved" })),
    ).toBe("/projects/p1/feedback?page=2&q=x&state=resolved");
  });

  it("is kept by a search, a filter and a page; a state change starts at page 1", () => {
    const at = place({ page: 3, q: "refund", state: "dropped" });
    expect(feedbackChangeHref(null, at, { q: "late" })).toBe(
      "/feedback?q=late&state=dropped",
    );
    expect(feedbackChangeHref(null, at, { rating: "liked" })).toBe(
      "/feedback?q=refund&rating=liked&state=dropped",
    );
    expect(feedbackPageHref(null, at, 4)).toBe(
      "/feedback?page=4&q=refund&state=dropped",
    );
    expect(feedbackChangeHref(null, at, { state: "open" })).toBe(
      "/feedback?q=refund",
    );
    expect(feedbackChangeHref(null, at, { state: "filed" })).toBe(
      "/feedback?q=refund&state=filed",
    );
  });

  it("rides in the way back and returns there", () => {
    const href = feedbackItemHref(null, "f1", place({ state: "resolved" }));
    const from = new URL(href, "https://x.invalid").searchParams.get("from");
    expect(from).toBe("/feedback?state=resolved");
    expect(decodeFeedbackFrom(from, null)).toEqual(place({ state: "resolved" }));
    expect(feedbackBackHref(null, from)).toBe(from);
    const proj = feedbackItemHref("p1", "f1", place({ page: 2, state: "filed" }));
    expect(
      feedbackBackHref(
        "p1",
        new URL(proj, "https://x.invalid").searchParams.get("from"),
      ),
    ).toBe("/projects/p1/feedback?page=2&state=filed");
    expect(feedbackBackHref(null, "/feedback?state=all")).toBe("/feedback");
    expect(feedbackBackHref(null, "/feedback?state=filed&state=dropped")).toBe(
      "/feedback",
    );
  });

  it("is not a search or a filter: Clear does not show for a state alone", () => {
    expect(isFiltered(place({ state: "dropped" }))).toBe(false);
  });
});
