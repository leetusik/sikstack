import { describe, expect, it } from "vitest";

import {
  closeMenuOnEscape,
  filterProjects,
  hasProjectSwitcher,
  newestFirst,
  nonceFromCsp,
  railFor,
  reviewCount,
  showsProjectFilter,
} from "@/sikstack/shell/model";

// P58 — the Shell's rules (frame.md F9; the org rail per job 03 round 02, F320; Workspace a link to
// the Agenda, F74). The look is verified live (S11), never here.

describe("the project switcher", () => {
  const named = (names: string[]) => names.map((name) => ({ name }));

  it("is absent with no project", () => {
    expect(hasProjectSwitcher([])).toBe(false);
    expect(hasProjectSwitcher(named(["platform"]))).toBe(true);
  });

  it("shows its filter only over 7 projects", () => {
    expect([0, 7, 8, 24].map(showsProjectFilter)).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("filters by name, case-insensitively, trimmed", () => {
    const ps = named([
      "Data-contracts",
      "docs-site",
      "한국어 문서 번역",
      "web",
    ]);
    expect(filterProjects(ps, "  DOC ").map((p) => p.name)).toEqual([
      "docs-site",
    ]);
    expect(filterProjects(ps, "data").map((p) => p.name)).toEqual([
      "Data-contracts",
    ]);
    expect(filterProjects(ps, "문서").map((p) => p.name)).toEqual([
      "한국어 문서 번역",
    ]);
    expect(filterProjects(ps, "")).toHaveLength(4);
    expect(filterProjects(ps, "zzz")).toEqual([]);
  });

  it("lists the newest project first", () => {
    const ps = [
      { id: "a", created_at: "2026-01-01T00:00:00Z" },
      { id: "b", created_at: "2026-11-15T00:00:00Z" },
      { id: "c", created_at: "2026-06-01T00:00:00Z" },
    ];
    expect(newestFirst(ps).map((p) => p.id)).toEqual(["b", "c", "a"]);
  });
});

describe("the rail", () => {
  const current = (path: string) =>
    [...railFor(path).items, railFor(path).review]
      .filter((i) => i.current)
      .map((i) => i.key);

  it("takes the project form on /projects/<id> and beneath it, the org form elsewhere", () => {
    expect(railFor("/projects/p1").form).toBe("project");
    expect(railFor("/projects/p1/anything").form).toBe("project");
    for (const path of [
      "/dashboard",
      "/library",
      "/feedback",
      "/review",
      "/documents",
      "/projects",
    ])
      expect(railFor(path).form).toBe("org");
  });

  it("holds the signed items in order (no Documents in the org form; Members after Feedback, P78)", () => {
    expect(railFor("/dashboard").items.map((i) => i.key)).toEqual([
      "overview",
      "library",
      "feedback",
      "members",
    ]);
    expect(railFor("/projects/p1").items.map((i) => i.key)).toEqual([
      "overview",
      "workspace",
      "library",
      "feedback",
      "design",
    ]);
  });

  it("marks exactly one item current on each known path, and none elsewhere", () => {
    expect(current("/dashboard")).toEqual(["overview"]);
    expect(current("/library")).toEqual(["library"]);
    expect(current("/feedback")).toEqual(["feedback"]);
    expect(current("/feedback/f1")).toEqual(["feedback"]);
    expect(current("/review")).toEqual(["review"]);
    expect(current("/members")).toEqual(["members"]);
    expect(railFor("/members").form).toBe("org");
    expect(current("/projects/p1")).toEqual(["overview"]);
    expect(current("/documents")).toEqual([]);
  });

  it("reads Library current on an org's public library, /@<org>, and on nothing else of it (P63)", () => {
    expect(current("/@june")).toEqual(["library"]);
    expect(current("/@june?page=2")).toEqual(["library"]);
    expect(current("/%40june")).toEqual(["library"]);
    expect(railFor("/@june").form).toBe("org");
    // its Not found for an address without the `@`, and the project and reader addresses beneath it
    for (const path of ["/nope", "/@", "/@june/handbook", "/@june/p/books/b"])
      expect(current(path)).toEqual([]);
  });

  it("links Workspace to the project's Agenda, current on every Workspace page and Overview then not", () => {
    const workspace = (path: string) =>
      railFor(path).items.find((i) => i.key === "workspace");
    expect(workspace("/projects/p1")).toEqual({
      key: "workspace",
      href: "/projects/p1/workspace",
      current: false,
    });
    for (const path of [
      "/projects/p1/workspace",
      "/projects/p1/workspace?deferred=2",
      "/projects/p1/workspace/agenda/A7-m3",
      "/projects/p1/workspace/backlog?archived=2",
      "/projects/p1/workspace/phases/P67-b1",
      "/projects/p1/workspace/slices/P67-b1.S5",
      "/projects/p1/workspace/deferred?status=done",
      "/projects/p1/workspace/deferred/D290-4p",
      "/projects/p1/workspace/docs",
      "/projects/p1/workspace/docs/qa?version=v0002_x",
    ]) {
      expect(workspace(path)?.href).toBe("/projects/p1/workspace");
      expect(current(path)).toEqual(["workspace"]);
    }
    // a path that only starts with the word is not the Workspace
    expect(current("/projects/p1/workspaces")).toEqual(["overview"]);
  });

  it("links the project form to the project's pages", () => {
    const hrefs = railFor("/projects/p%201").items.map((i) => i.href);
    expect(hrefs).toEqual([
      "/projects/p%201",
      "/projects/p%201/workspace",
      "/projects/p%201/library",
      "/projects/p%201/feedback",
      "/projects/p%201/design",
    ]);
  });

  it("links Design to the project's builds, current on the list and every build's viewer, Overview then not (P77)", () => {
    const design = (path: string) =>
      railFor(path).items.find((i) => i.key === "design");
    expect(design("/projects/p1")).toEqual({
      key: "design",
      href: "/projects/p1/design",
      current: false,
    });
    for (const path of [
      "/projects/p1/design",
      "/projects/p1/design/",
      "/projects/p1/design?x=1",
      "/projects/p1/design/babcdefghijklmnopqrstuvwxy",
      "/projects/p1/design/babcdefghijklmnopqrstuvwxy/",
    ]) {
      expect(railFor(path).form).toBe("project");
      expect(design(path)?.href).toBe("/projects/p1/design");
      expect(current(path)).toEqual(["design"]);
    }
    // a path that only starts with the word is not Design
    expect(current("/projects/p1/designs")).toEqual(["overview"]);
    // the org form has no Design
    expect(railFor("/dashboard").items.some((i) => i.key === "design")).toBe(false);
  });

  it("links the org form's Feedback to the org's list at rest", () => {
    expect(
      railFor("/dashboard").items.find((i) => i.key === "feedback")?.href,
    ).toBe("/feedback");
  });
});

describe("Review's count", () => {
  it("reads 99+ over 99 and is absent at 0", () => {
    expect([0, -3, 1, 99, 100, 112].map(reviewCount)).toEqual([
      "",
      "",
      "1",
      "99",
      "99+",
      "99+",
    ]);
  });
});

describe("the request nonce", () => {
  it("is read from the CSP's 'nonce-…' source", () => {
    expect(
      nonceFromCsp(
        "object-src 'none'; script-src 'self' 'nonce-abc+/=' 'strict-dynamic'",
      ),
    ).toBe("abc+/=");
    expect(nonceFromCsp("object-src 'none'")).toBeUndefined();
    expect(nonceFromCsp(null)).toBeUndefined();
  });
});

describe("a menu's Escape", () => {
  /** A key event on a menu's anchor whose first button (the trigger) records its focus. */
  function keyOn(key: string) {
    const log: string[] = [];
    const trigger = { focus: () => log.push("focus trigger") };
    const event = {
      key,
      preventDefault: () => log.push("prevent"),
      currentTarget: {
        querySelector: (selectors: "button") =>
          selectors === "button" ? trigger : null,
      },
    };
    return { event, log, close: () => log.push("close") };
  }

  it("closes the open menu and puts focus back on its trigger", () => {
    const { event, log, close } = keyOn("Escape");
    expect(closeMenuOnEscape(event, true, close)).toBe(true);
    expect(log).toEqual(["prevent", "close", "focus trigger"]);
  });

  it("leaves every other key, and Escape with no menu open, alone", () => {
    for (const [key, open] of [
      ["Enter", true],
      ["Tab", true],
      ["Escape", false],
    ] as const) {
      const { event, log, close } = keyOn(key);
      expect(closeMenuOnEscape(event, open, close)).toBe(false);
      expect(log).toEqual([]);
    }
  });
});
