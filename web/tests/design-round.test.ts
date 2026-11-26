import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  designOpenHref,
  designPagesHref,
  roundPages,
  roundShowsOptions,
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

const render = (
  manifest: DesignManifest,
  scope?: "round" | "all",
  more: Partial<Parameters<typeof DesignBuildView>[0]> = {},
) =>
  renderToStaticMarkup(
    createElement(DesignBuildView, {
      project: "p",
      scope,
      build: BUILD,
      manifest,
      share: { on: false, url: null },
      timeZone: "UTC",
      now: Date.parse("2026-11-26T01:00:00Z"),
      ...more,
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

describe("the viewer with a round, in a build with an options page", () => {
  const OPTIONS = {
    name: null,
    entry: "/options/",
    directions: [
      { key: "a", label: "Direction A", entry: "/options/?direction=a" },
      { key: "b", label: "Direction B", entry: "/options/?direction=b" },
    ],
  };
  const two = ["/projects/p/design/", "/projects/p/feedback/f1/"];

  it("hides the options when the round does not name the options page", () => {
    const html = render({ pages: PAGES, options: OPTIONS, round: { pages: two } });
    expect(rows(html)).toEqual(["Feedback item", "Design"]);
    expect(html).not.toContain('id="design-options"');
    expect(html).not.toContain("Direction A");
    expect(html).toContain(">2 pages<");
  });

  it("shows the options when the round names the options page, with the round's pages", () => {
    const m = { pages: PAGES, options: OPTIONS, round: { pages: [...two, "/options/"] } };
    expect(roundShowsOptions(m)).toBe(true);
    const html = render(m);
    expect(html).toContain('id="design-options"');
    expect(html).toContain("2 directions");
    expect(rows(html)).toEqual(["Feedback item", "Design"]);
    expect(html).toContain(">2 pages<");
  });

  it("is an options-only round when it names only the options page: the options and the whole-design link", () => {
    const m = { pages: PAGES, options: OPTIONS, round: { pages: ["/options/"] } };
    expect(roundPages(m)).toEqual([]);
    const html = render(m);
    expect(html).toContain('id="design-options"');
    expect(html).toContain("Direction B");
    expect(rows(html)).toEqual([]);
    expect(html).toContain("This round");
    expect(html).not.toContain("0 pages");
    expect(html).toContain(`href="${whole}"`);
    expect(html).toContain("The whole design · 5 pages");
  });

  it("names the options entry only when the build has an options page", () => {
    expect(roundPages({ pages: PAGES, round: { pages: ["/options/"] } })).toBeNull();
    expect(roundShowsOptions({ pages: PAGES, round: { pages: ["/options/"] } })).toBe(false);
  });

  it("shows the options on the every-page list, framed as on a no-round build, whatever the round names", () => {
    const frameOf = (d: { key: string }) => createElement("i", { className: `frame-${d.key}` });
    const section = (h: string) =>
      h.slice(h.indexOf('<section aria-labelledby="design-options"'), h.indexOf('<section aria-labelledby="design-pages"'));
    const plain = render({ pages: PAGES, options: OPTIONS }, undefined, { frameOf });
    for (const pages of [two, [...two, "/options/"], ["/options/"], undefined]) {
      const m = { pages: PAGES, options: OPTIONS, ...(pages ? { round: { pages } } : {}) };
      const html = render(m, "all", { frameOf });
      expect(rows(html)).toEqual(PAGES.map((p) => p.name));
      expect(html).toContain('id="design-options"');
      expect(html).toContain("2 directions");
      expect(html).toContain('class="frame-a"');
      expect(html).toContain('class="frame-b"');
      expect(html).toContain("Every page");
      expect(html).toContain(">5 pages<");
      expect(html.indexOf('id="design-options"')).toBeLessThan(html.indexOf('id="design-pages"'));
      // The same section as the build's own viewer without a round.
      expect(section(html)).toBe(section(plain));
    }
  });

  it("shows the options with every page when the build has no round", () => {
    const html = render({ pages: PAGES, options: OPTIONS });
    expect(rows(html)).toEqual(PAGES.map((p) => p.name));
    expect(html).toContain('id="design-options"');
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

  it("names the build's list, not a round, on the every-page list's way back", () => {
    for (const round of [undefined, { pages: [] }, { pages: ["/gone/"] }]) {
      const html = render({ pages: PAGES, ...(round ? { round } : {}) } as DesignManifest, "all");
      expect(html).toContain('<a class="back" href="/projects/p/design/bxuwwi26kyuptsszqcenbfrwto">Pages</a>');
      expect(html).not.toContain("This round");
      expect(rows(html)).toEqual(PAGES.map((p) => p.name));
    }
  });
});

describe("the viewer's links between the round's list and every page", () => {
  const m: DesignManifest = { pages: PAGES, round: { pages: ["/system/"] } };

  it("are production's routes by default", () => {
    expect(render(m)).toContain(`<a class="link-strong" href="${whole}">`);
    expect(render(m, "all")).toContain('<a class="back" href="/projects/p/design/bxuwwi26kyuptsszqcenbfrwto">This round</a>');
  });

  it("take the addresses a host gives them (the design folder draws both lists as states of one page)", () => {
    const links = { whole: "/b/?state=every-page", back: "/b/?state=round" };
    const round = render(m, "round", { links });
    expect(round).toContain('<a class="link-strong" href="/b/?state=every-page">');
    expect(round).not.toContain(`href="${whole}"`);
    expect(render(m, "all", { links })).toContain('<a class="back" href="/b/?state=round">This round</a>');
  });
});
