import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  designOpenHref,
  designPagesHref,
  roundPages,
  type DesignBuild,
  type DesignManifest,
} from "@/sikstack/design/model";
import { DesignBuildView } from "@/sikstack/design/viewer";

// P84 — a build's round (`design-publish --page`): the viewer lists only the round's pages, with a count and one
// link to every page; the every-page list shows them all and links back. A build without a round is unchanged.

const PAGES = [
  { name: "All pages", route: "/", entry: "/" },
  {
    name: "Feedback item",
    route: "/projects/[projectId]/feedback/[feedbackId]",
    entry: "/projects/p/feedback/f1/",
    states: [
      { key: "offered", label: "Offered" },
      { key: "failed", label: "Failed" },
    ],
  },
  { name: "Feedback item on the agenda", route: "/projects/[projectId]/feedback/[feedbackId]", entry: "/projects/p/feedback/f2/" },
  { name: "Design", route: "/projects/[projectId]/design", entry: "/projects/p/design/" },
  { name: "System", route: "/system", entry: "/system/" },
];

const BUILD: DesignBuild = {
  id: "bxuwwi26kyuptsszqcenbfrwto",
  url: "http://bxuwwi26kyuptsszqcenbfrwto.design.sikstack.localhost:3061/",
  commit: "54a2288ee0ee9a3104e75a1b2a2f17bb7a6066aa",
  branch: "main",
  dirty: false,
  recording: "design/data/sample/recording.json",
  recording_name: "sample",
  private: false,
  size: 1000,
  files: 10,
  pages: 5,
  options: false,
  published_at: "2026-11-26T00:00:00Z",
  published_from: null,
  share: { on: false },
};

describe("a build's round", () => {
  it("is the manifest pages its round names, in the manifest's order", () => {
    const m: DesignManifest = { pages: PAGES, round: { pages: ["/projects/p/design/", "/projects/p/feedback/f1/"] } };
    expect(roundPages(m)?.map((p) => p.entry)).toEqual(["/projects/p/feedback/f1/", "/projects/p/design/"]);
  });

  it("ignores an entry the manifest lacks", () => {
    const m: DesignManifest = { pages: PAGES, round: { pages: ["/gone/", "/system/"] } };
    expect(roundPages(m)?.map((p) => p.entry)).toEqual(["/system/"]);
  });

  it("is no round when absent, empty, invalid or naming no page", () => {
    for (const round of [undefined, null, {}, { pages: [] }, { pages: "x" }, { pages: [1, null] }, { pages: ["/gone/"] }, "x"])
      expect(roundPages({ pages: PAGES, round } as unknown as DesignManifest)).toBeNull();
  });

  it("has its every-page list one level under the viewer", () => {
    expect(designPagesHref("p 1", "bx")).toBe("/projects/p%201/design/bx/pages");
  });
});

const render = (manifest: DesignManifest, scope?: "round" | "all") =>
  renderToStaticMarkup(
    createElement(DesignBuildView, {
      project: "p",
      scope,
      build: BUILD,
      manifest,
      share: { on: false, url: null },
      timeZone: "UTC",
      now: Date.parse("2026-11-26T01:00:00Z"),
    }),
  );
const rows = (html: string) => [...html.matchAll(/<li class="row design-page[^"]*"><a[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);
const whole = "/projects/p/design/bxuwwi26kyuptsszqcenbfrwto/pages";

describe("the viewer with a round", () => {
  const m: DesignManifest = { pages: PAGES, round: { pages: ["/projects/p/design/", "/projects/p/feedback/f1/"] } };

  it("lists only the round's pages, with their count, states and one link to every page", () => {
    const html = render(m);
    expect(rows(html)).toEqual(["Feedback item", "Design"]);
    expect(html).toContain("This round");
    expect(html).toContain(">2 pages<");
    expect(html).toContain(`href="${whole}"`);
    expect(html).toContain("The whole design · 5 pages");
    const offered = designOpenHref("p", BUILD.id, "/projects/p/feedback/f1/?state=offered").replace(/&/g, "&amp;");
    expect(html).toContain(`href="${offered}"`);
    expect(html).toContain(">Failed<");
  });

  it("lists every page on the every-page list, which links back to the round's list", () => {
    const html = render(m, "all");
    expect(rows(html)).toEqual(PAGES.map((p) => p.name));
    expect(html).toContain("Every page");
    expect(html).toContain(">5 pages<");
    expect(html).not.toContain(`href="${whole}"`);
    expect(html).toContain('<a class="back" href="/projects/p/design/bxuwwi26kyuptsszqcenbfrwto">This round</a>');
    const system = designOpenHref("p", BUILD.id, "/system/").replace(/&/g, "&amp;");
    expect(html).toContain(`href="${system}"`);
  });
});

describe("the viewer without a round", () => {
  it("lists every page, as before, with no link to every page", () => {
    const html = render({ pages: PAGES });
    expect(rows(html)).toEqual(PAGES.map((p) => p.name));
    expect(html).toContain(">Pages<");
    expect(html).not.toContain("This round");
    expect(html).not.toContain("The whole design");
    expect(html).not.toContain("/pages\"");
  });
});
