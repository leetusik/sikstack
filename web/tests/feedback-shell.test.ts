import { describe, expect, it } from "vitest";

import { projectSwitchHref, railFor } from "@/sikstack/shell/model";
import { feedbackHref, feedbackItemHref } from "@/lib/feedback/place";

// P65 — Feedback and the Shell (job 04 round 02, `## Build` § How the two pages connect, F134): with a
// project picked the list and an item opened from it sit under that project's rail with Feedback
// current; an item opened from the org's list keeps the org's Shell, and the org's list filtered to a
// project is still the org's. The rail's Feedback is the list at rest for what the Shell shows.

const item = (path: string, key: string) =>
  railFor(path).items.find((i) => i.key === key);

const current = (path: string, known = true) =>
  [...railFor(path, known).items, railFor(path, known).review]
    .filter((i) => i.current)
    .map((i) => i.key);

describe("Feedback with a project picked", () => {
  const list = feedbackHref("p1");
  const opened = feedbackItemHref("p1", "f1", {
    page: 2,
    q: "refund",
    project: null,
    rating: "liked",
    state: "open",
  });

  it("is a route under the project, for the list and for an item opened from it", () => {
    expect(list).toBe("/projects/p1/feedback");
    expect(opened.split("?")[0]).toBe("/projects/p1/feedback/f1");
  });

  it("shows that project's rail with Feedback current, on the list and on the item", () => {
    for (const path of [
      list,
      `${list}?page=2`,
      opened,
      "/projects/p1/feedback/",
    ]) {
      expect(railFor(path).form).toBe("project");
      expect(current(path)).toEqual(["feedback"]);
    }
  });

  it("points the project rail's Feedback at that project's list at rest", () => {
    for (const path of ["/projects/p1", "/projects/p1/library", opened])
      expect(item(path, "feedback")?.href).toBe("/projects/p1/feedback");
    expect(item("/projects/p%201", "feedback")?.href).toBe(
      "/projects/p%201/feedback",
    );
  });

  it("takes the org form with none current when the project is not the org's", () => {
    expect(railFor("/projects/nope/feedback", false).form).toBe("org");
    expect(current("/projects/nope/feedback/f1", false)).toEqual([]);
  });
});

describe("Feedback with the org alone", () => {
  it("keeps the org's Shell on an item opened from the org's list", () => {
    const opened = feedbackItemHref(null, "f1", {
      page: 3,
      q: "",
      project: "p1",
      rating: null,
      state: "open",
    });
    expect(opened.split("?")[0]).toBe("/feedback/f1");
    expect(railFor(opened).form).toBe("org");
    expect(current(opened)).toEqual(["feedback"]);
  });

  it("keeps the org's Shell on the org's list filtered to a project", () => {
    expect(railFor("/feedback?project=p1").form).toBe("org");
    expect(current("/feedback?project=p1")).toEqual(["feedback"]);
    expect(item("/feedback?project=p1", "feedback")?.href).toBe("/feedback");
  });
});

describe("the project switcher on Feedback (frame:Q9)", () => {
  it("goes to the picked project's home, as on every other page", () => {
    for (const path of ["/feedback", "/feedback/f1", "/projects/p1/feedback"])
      expect(projectSwitchHref(path, "p2")).toBe("/projects/p2");
  });
});
