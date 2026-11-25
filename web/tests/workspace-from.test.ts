import { describe, expect, it } from "vitest";

import {
  agendaHref,
  agendaItemHref,
  backlogHref,
  decodeWorkspaceFrom,
  docHref,
  docsHref,
  FROM_PARAM,
  listHref,
  phaseHref,
  retiredJobHref,
  sliceHref,
  wayBack,
  workspaceHref,
  type WorkspaceList,
} from "@/lib/workspace/address";

// The Workspace's addresses and its own way back: every page under `/projects/<id>/workspace`, the
// list's page in the address (1-based, page 1 written as none), and `?from=` decoded strictly: only
// a Workspace list page of the same project, with its own keys and their charsets, rebuilt from its
// parts. Anything else is no list, and the item goes back to its own default.

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const OTHER = "0b9e4d27-5c3a-4f81-a6d2-91e7c8b3f540";
const ws = `/projects/${PROJECT}/workspace`;

describe("the addresses", () => {
  it("puts every page under the project's workspace", () => {
    expect(workspaceHref(PROJECT)).toBe(ws);
    expect(agendaHref(PROJECT)).toBe(ws);
    expect(agendaItemHref(PROJECT, "A13-n1")).toBe(`${ws}/agenda/A13-n1`);
    expect(backlogHref(PROJECT, { archived: 3 })).toBe(
      `${ws}/backlog?archived=3`,
    );
    expect(phaseHref(PROJECT, "P8-q4")).toBe(`${ws}/phases/P8-q4`);
    expect(sliceHref(PROJECT, "P8-q4.S1")).toBe(`${ws}/slices/P8-q4.S1`);
    expect(docsHref(PROJECT)).toBe(`${ws}/docs`);
    expect(docHref(PROJECT, "architecture")).toBe(`${ws}/docs/architecture`);
    expect(docHref(PROJECT, "architecture", { version: "v2611171507" })).toBe(
      `${ws}/docs/architecture?version=v2611171507`,
    );
  });

  it("writes page 1 as no key", () => {
    expect(backlogHref(PROJECT, { archived: 1 })).toBe(`${ws}/backlog`);
  });

  it("sends a retired deferred job's address to the item its fold entry names, else the Agenda (P61-e9)", () => {
    expect(retiredJobHref(PROJECT, "A2-k5")).toBe(`${ws}/agenda/A2-k5`);
    expect(retiredJobHref(PROJECT, null)).toBe(ws);
  });

  it("carries the list an item was opened from", () => {
    const from: WorkspaceList = { list: "agenda" };
    const href = agendaItemHref(PROJECT, "A20-a3", from);
    const url = new URL(href, "https://sikstack.test");
    expect(url.pathname).toBe(`${ws}/agenda/A20-a3`);
    expect(url.searchParams.get(FROM_PARAM)).toBe(listHref(PROJECT, from));
    expect(
      decodeWorkspaceFrom(url.searchParams.get(FROM_PARAM), PROJECT),
    ).toEqual(from);
    const doc = new URL(
      docHref(PROJECT, "product", { version: "v0001" }, { list: "docs" }),
      "https://sikstack.test",
    );
    expect(doc.searchParams.get("version")).toBe("v0001");
    expect(doc.searchParams.get(FROM_PARAM)).toBe(`${ws}/docs`);
  });
});

describe("the Workspace's from", () => {
  it("admits each list page of the same project, rebuilt from its parts", () => {
    const lists: WorkspaceList[] = [
      { list: "agenda" },
      { list: "backlog" },
      { list: "backlog", archived: 6 },
      { list: "docs" },
    ];
    for (const list of lists) {
      expect(decodeWorkspaceFrom(listHref(PROJECT, list), PROJECT)).toEqual(
        list,
      );
    }
  });

  it("falls back on a foreign path", () => {
    for (const raw of [
      "/library",
      `/projects/${PROJECT}/library`,
      `/projects/${PROJECT}/library?page=2`,
      `/projects/${PROJECT}`,
      `/projects/${PROJECT}/workspace/agenda/A2-k5`,
      `/projects/${PROJECT}/workspace/phases`,
      `/projects/${PROJECT}/workspace/backlog/extra`,
      // the retired Deferred jobs list is no list any more (P61-e9)
      `/projects/${PROJECT}/workspace/deferred`,
      `/projects/${PROJECT}/workspace/deferred?page=2`,
      "https://evil.example/projects/x/workspace",
      `//evil.example${ws}`,
      `${ws}/../../../library`,
      "",
    ]) {
      expect(decodeWorkspaceFrom(raw, PROJECT), raw).toBeNull();
    }
    expect(decodeWorkspaceFrom([ws, ws], PROJECT)).toBeNull();
    expect(decodeWorkspaceFrom(undefined, PROJECT)).toBeNull();
  });

  it("falls back on another project's list", () => {
    expect(
      decodeWorkspaceFrom(`/projects/${OTHER}/workspace/backlog`, PROJECT),
    ).toBeNull();
    expect(
      decodeWorkspaceFrom(`/projects/${OTHER}/workspace`, PROJECT),
    ).toBeNull();
  });

  it("falls back on an unknown, repeated or malformed key", () => {
    for (const raw of [
      `${ws}?page=2`,
      `${ws}/backlog?deferred=2`,
      `${ws}/docs?version=v0001`,
      // the Agenda has no paged part since Deferred went: an old `?deferred=N` is no list of ours
      `${ws}?deferred=2`,
      `${ws}/backlog?archived=02`,
      `${ws}/backlog?archived=2&archived=3`,
      `${ws}/backlog?archived=-1`,
      `${ws}/backlog?archived=two`,
      `${ws}/backlog#archived`,
    ]) {
      expect(decodeWorkspaceFrom(raw, PROJECT), raw).toBeNull();
    }
  });

  it("falls back on an escaped segment", () => {
    for (const raw of [
      `/projects/${PROJECT}/workspace/%64ocs`,
      `/projects/${PROJECT}/%77orkspace`,
      `/projects/${PROJECT.replace("3f", "%33f")}/workspace`,
      `/projects/${PROJECT}/workspace/deferred%2Fx`,
    ]) {
      expect(decodeWorkspaceFrom(raw, PROJECT), raw).toBeNull();
    }
  });
});

describe("the way back", () => {
  it("goes to the item's own list at the page it was opened from", () => {
    expect(
      wayBack(PROJECT, { kind: "agenda-item" }, { list: "agenda" }),
    ).toEqual({
      href: ws,
      to: "agenda",
      list: { list: "agenda" },
    });
    expect(
      wayBack(PROJECT, { kind: "phase" }, { list: "backlog", archived: 3 })
        .href,
    ).toBe(`${ws}/backlog?archived=3`);
    expect(wayBack(PROJECT, { kind: "doc" }, { list: "docs" }).href).toBe(
      `${ws}/docs`,
    );
  });

  it("ignores a list that is not the item's own, so the label matches the link", () => {
    expect(
      wayBack(PROJECT, { kind: "phase" }, { list: "agenda" }),
    ).toEqual({
      href: `${ws}/backlog`,
      to: "backlog",
      list: null,
    });
    expect(
      wayBack(PROJECT, { kind: "agenda-item" }, { list: "backlog" }).to,
    ).toBe("agenda");
  });

  it("takes a slice to its phase and an earlier version to its doc, carrying the list on", () => {
    const back = wayBack(
      PROJECT,
      { kind: "slice", phase: "P8-q4" },
      { list: "backlog", archived: 2 },
    );
    expect(back.to).toBe("phase");
    const url = new URL(back.href, "https://sikstack.test");
    expect(url.pathname).toBe(`${ws}/phases/P8-q4`);
    expect(
      decodeWorkspaceFrom(url.searchParams.get(FROM_PARAM), PROJECT),
    ).toEqual({
      list: "backlog",
      archived: 2,
    });
    expect(
      wayBack(PROJECT, { kind: "doc-version", doc: "product" }, null),
    ).toEqual({
      href: `${ws}/docs/product`,
      to: "doc",
      list: null,
    });
  });
});
