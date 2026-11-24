import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A loose document in the Library's reader (P63-fk.S12; job 03, Library round 02: `## Build` § Page: document,
// `Document.dc.html`, `DocumentNotes.dc.html`): the sections' fold, the way back, the marks by format (OQ14),
// the bookmarks' writes, the strict `?v=` and Document not found.

const actions = vi.hoisted(() => ({
  saveReaderPosition: vi.fn(async () => ({ ok: true })),
  saveQuizAttempt: vi.fn(async () => ({ ok: true })),
  saveAnnotation: vi.fn(async () => ({ ok: true })),
  editAnnotation: vi.fn(async () => ({ ok: true })),
  removeAnnotation: vi.fn(async () => ({ ok: true })),
  saveBookmark: vi.fn(async () => ({ ok: true })),
  editBookmark: vi.fn(async () => ({ ok: true })),
  removeBookmark: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/reader/actions", () => actions);

const app = vi.hoisted(() => ({
  getDocumentVersion: vi.fn(),
  getDocumentVersions: vi.fn(),
  resolveDocument: vi.fn(),
  getDocument: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("@/lib/knowledge/app", async (orig) => ({
  ...(await orig<object>()),
  ...app,
}));

import { renderDocument } from "@/components/reader/document-page";
import { READER_DOCUMENT } from "@/content/reader-document";
import {
  DocumentNotes,
  DocumentReader,
  documentBack,
  missingDocument,
  documentMarks,
  phaseRows,
  foldSections,
  hereMarked,
  markPlace,
  runBookmarkWire,
  type DocMark,
} from "@/sikstack/reader/document";
import {
  documentPhaseRows,
  withDocumentPhases,
} from "@/sikstack/reader/document/with-phases";
import { ReaderHead } from "@/sikstack/reader/reader-head";
import {
  bookmarkWire,
  labelWire,
  removeBookmarkWire,
} from "@/sikstack/reader/marks/wire";
import { ApiError } from "@/lib/knowledge/client";
import { validateChapter } from "@/lib/native";
import { layerOn } from "@/lib/reader/layer";
import { loadLooseReader, type LoadedReader } from "@/lib/reader/load";
import type { ReaderNotes, ReaderView } from "@/lib/reader/types";
import type { KbDocument } from "@/lib/knowledge/types";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";

const router = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance;
const inApp = (el: ReactElement) =>
  renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router }, el),
  );

const sections = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    title: `S${i + 1}`,
  }));

// ---- the sections' fold ---------------------------------------------------------------------------------

describe("the sections fold past six (F68's fold, `LB.FOLD`)", () => {
  it("six list whole, with no control", () => {
    const f = foldSections(sections(6), false);
    expect(f.shown).toHaveLength(6);
    expect(f.fold).toBeNull();
  });
  it("seven list five, folded", () => {
    const f = foldSections(sections(7), false);
    expect(f.shown.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(f.fold).toEqual({ total: 7, open: false });
  });
  it("forty list five, and all forty once opened", () => {
    expect(foldSections(sections(40), false).shown).toHaveLength(5);
    const open = foldSections(sections(40), true);
    expect(open.shown).toHaveLength(40);
    expect(open.fold).toEqual({ total: 40, open: true });
  });
});

// ---- ReaderHead: the fold prop ------------------------------------------------------------------------

const headProps = {
  noun: "document" as const,
  title: "Sessions",
  lang: "en",
  where: "Document in platform",
  version: 1,
  newest: 1,
  published: "Nov 14",
};

describe("ReaderHead's fold", () => {
  it("without the prop renders as before, byte for byte (a guard)", () => {
    const html = renderToStaticMarkup(
      createElement(ReaderHead, { ...headProps, sections: sections(2) }),
    );
    expect(html).toBe(
      '<header class="read-head"><h1 class="read-title" lang="en">Sessions</h1>' +
        '<div class="read-facts"><span>Document in platform</span><span>v1, published Nov 14</span>' +
        '<button type="button" class="link-row">Version history</button></div>' +
        '<nav class="read-toc" aria-label="In this document"><h2>In this document</h2><ol>' +
        '<li><button type="button" class="toc-link" lang="en">S1</button></li>' +
        '<li><button type="button" class="toc-link" lang="en">S2</button></li>' +
        "</ol></nav></header>",
    );
  });

  it("with it, the toggle is the nav's last line, with aria-expanded and both labels in one cell", () => {
    const f = foldSections(sections(40), false);
    const html = renderToStaticMarkup(
      createElement(ReaderHead, {
        ...headProps,
        sections: f.shown,
        fold: { ...f.fold!, onToggle: () => {} },
      }),
    );
    expect(html.match(/class="toc-link"/g)).toHaveLength(5);
    expect(html).toMatch(
      /<\/ol><div class="cluster read-toc-more"><button type="button" class="link-row" aria-expanded="false" data-swap="false"><span class="swap"><span>Show all 40 sections<\/span><span>Show fewer<\/span><\/span><\/button><\/div><\/nav><\/header>$/,
    );
    const open = renderToStaticMarkup(
      createElement(ReaderHead, {
        ...headProps,
        sections: sections(40),
        fold: { total: 40, open: true, onToggle: () => {} },
      }),
    );
    expect(open).toContain('aria-expanded="true" data-swap="true"');
  });
});

// ---- the way back -------------------------------------------------------------------------------------

describe("the way back (F324, F328): the list's view and page", () => {
  it("a member with no list goes back to the Library", () => {
    expect(
      documentBack({ member: true, from: null, org: "june" }),
    ).toMatchObject({ href: "/library", label: "Library" });
  });
  it("each origin names its list, at its place", () => {
    expect(
      documentBack({
        member: true,
        from: "/library?view=all&page=3&q=auth",
        org: "june",
      }),
    ).toMatchObject({
      href: "/library?view=all&page=3&q=auth",
      label: "Library",
    });
    expect(
      documentBack({
        member: true,
        from: "/projects/p1/library?page=2",
        org: "june",
        names: { project: "platform" },
      }),
    ).toMatchObject({ href: "/projects/p1/library?page=2", label: "platform" });
    expect(
      documentBack({ member: false, from: "/@june?page=2", org: "june" }),
    ).toMatchObject({ href: "/@june?page=2", label: "june" });
  });
  it("a visitor never gets a member's list: the public library of the address's org", () => {
    expect(
      documentBack({ member: false, from: "/library?page=2", org: "june" }),
    ).toMatchObject({ href: "/@june", label: "june" });
    expect(documentBack({ member: false, from: null, org: null })).toBeNull();
  });
  it("a hostile value is the Library", () => {
    expect(
      documentBack({ member: true, from: "//evil.example.com", org: null }),
    ).toMatchObject({ href: "/library" });
  });
});

// ---- the marks by format (OQ14) -----------------------------------------------------------------------

const notes = (plain: boolean): ReaderNotes => ({
  plain,
  sections: [],
  items: [],
  unanchored: [],
  bookmarks: [
    {
      id: "b1",
      block: null,
      at: null,
      exact: true,
      fraction: 0.4,
      label: "",
      snippet: "x",
      pos: true,
      approx: false,
      lang: "en",
      version: 1,
      created: "2026-11-14",
    },
  ],
  other: [],
  otherBookmarks: [],
  langNames: { en: "English" },
});

function view(over: Partial<ReaderView> = {}): ReaderView {
  return {
    kind: "loose",
    member: true,
    title: "Sessions",
    lang: "en",
    langs: [],
    version: 1,
    newest: 1,
    summary: null,
    date: "2026-11-14",
    project: "platform",
    staleSource: null,
    target: {
      kind: "document",
      id: 7,
      canonicalPath: "/@june/platform/sessions",
    },
    write: { org: "june", project: "platform", doc: "2026-11-14-sessions" },
    progress: {
      state: "unopened",
      finishedVersion: null,
      maxFraction: 0,
      resume: null,
    },
    versions: { ok: true, label: "English", rows: [] },
    book: null,
    headings: [
      { id: "one", level: 2, text: "One" },
      { id: "two", level: 2, text: "Two" },
    ],
    settings: { size: 3, theme: "system" },
    ...over,
  };
}

function loaded(format: "md" | "native", v: ReaderView): LoadedReader {
  const text =
    format === "md"
      ? "# Sessions\n\n## One\n\nText one.\n\n## Two\n\nText two.\n"
      : "---\nformat: native\nsyntax: 1\ntitle: Sessions\n---\n\n## One {#one}\n\nText one.\n";
  return {
    view: v,
    checked: validateChapter(text, format),
    docId: 7,
    assets: null,
    resolveRef: () => null,
    quiz: {},
    notes: notes(format === "md"),
  };
}

describe("the marks follow the format (OQ14 = by-format)", () => {
  const member = view();
  const visitor = view({ member: false, write: null, progress: null });
  it("chooses bookmarks for Markdown and the layer for native, member and visitor", () => {
    expect(documentMarks(loaded("md", member))).toBe("bookmarks");
    expect(documentMarks(loaded("md", visitor))).toBe("bookmarks");
    expect(documentMarks(loaded("native", member))).toBe("layer");
    expect(documentMarks(loaded("native", visitor))).toBe("layer");
    // a member with nowhere to save (a tenant with no org slug) gets neither
    expect(documentMarks(loaded("md", view({ write: null })))).toBe("none");
  });

  for (const [who, v] of [
    ["a member", member],
    ["a visitor", visitor],
  ] as const) {
    it(`a Markdown document mounts no annotation layer and shows DocumentNotes (${who})`, () => {
      const el = renderDocument(
        { kind: "reader", reader: loaded("md", v) },
        { from: null, org: "june" },
      );
      if (
        !isValidElement<{ children: ReactElement<{ reader: LoadedReader }> }>(
          el,
        )
      )
        throw new Error("no element");
      const body = el.props.children.props.reader;
      expect(body.notes).toBeNull();
      expect(layerOn(body)).toBe(false);
      const html = inApp(
        createElement(
          DocumentReader,
          {
            view: v,
            marks: "bookmarks",
            bookmarks: v.member ? notes(true).bookmarks : [],
          },
          createElement("p", null, "the text"),
        ),
      );
      expect(html).not.toContain("marks-slot");
      expect(html).toContain("Bookmark this position");
      if (v.member) expect(html).toContain("About 40% through");
      else
        expect(html).toContain(
          READER_DOCUMENT.notes.empty("Bookmark this position"),
        );
    });

    it(`a native document mounts the layer and no DocumentNotes (${who})`, () => {
      const el = renderDocument(
        { kind: "reader", reader: loaded("native", v) },
        { from: null, org: "june" },
      );
      if (
        !isValidElement<{
          marks: string;
          children: ReactElement<{ reader: LoadedReader }>;
        }>(el)
      )
        throw new Error("no element");
      expect(el.props.marks).toBe("layer");
      expect(layerOn(el.props.children.props.reader)).toBe(true);
      const html = inApp(
        createElement(
          DocumentReader,
          { view: v, marks: "layer" },
          createElement("p", null, "the text"),
        ),
      );
      expect(html).toContain("marks-slot");
      expect(html).not.toContain("Bookmark this position");
      expect(html).not.toContain("No bookmarks in this document");
    });
  }
});

// ---- the document's frame -----------------------------------------------------------------------------

describe("the document's frame", () => {
  it("draws the head's noun, Document in <project>, the foot's pill alone, no Ask, Back to <list>", () => {
    const html = inApp(
      createElement(
        DocumentReader,
        {
          view: view({
            headings: Array.from({ length: 40 }, (_, i) => ({
              id: `h${i}`,
              level: 2 as const,
              text: `H${i}`,
            })),
          }),
          marks: "bookmarks",
          from: "/projects/p1/library?page=2",
        },
        createElement("p", null, "the text"),
      ),
    );
    expect(html).toContain("In this document");
    expect(html).toContain("<span>Document in platform</span>");
    expect(html).toContain("Show all 40 sections");
    expect(html.match(/class="toc-link"/g)).toHaveLength(5);
    expect(html).toContain(">Back to platform</button>");
    expect(html).toContain('href="/projects/p1/library?page=2"');
    expect(html).not.toMatch(/>Ask</);
    expect(html).not.toContain("reader-side");
    expect(html.match(/<main/g)).toHaveLength(1);
  });

  it("an older version: the bar's tag, the head's notice and Read v5", () => {
    const html = inApp(
      createElement(
        DocumentReader,
        { view: view({ version: 2, newest: 5 }), marks: "none" },
        createElement("p", null, "v2"),
      ),
    );
    expect(html).toContain('<span class="badge">Older version</span>');
    expect(html).toContain(
      "You’re reading v2 of this document. The current version is v5.",
    );
    expect(html).toContain(">Read v5</button>");
  });
  it("a visitor's way back reads the org's name the read carries, else the address's slug (P63-fk.S26)", () => {
    const visitor = view({ member: false, write: null, progress: null });
    const page = (orgName: string | null) =>
      inApp(
        renderDocument(
          { kind: "reader", reader: { ...loaded("md", visitor), orgName } },
          { from: null, org: "june" },
        ),
      );
    const named = page("June Lab");
    expect(named).toContain(">Back to June Lab</button>");
    expect(named).toContain('href="/@june"');
    expect(page(null)).toContain(">Back to june</button>");
  });
});

// ---- DocumentNotes and the bookmarks' writes ----------------------------------------------------------

describe("DocumentNotes (bookmarks only)", () => {
  it("reads the count, the button at the same width, the rows, the empty line", () => {
    const base = {
      action: "Bookmark this position",
      signInHref: "/login",
      onBookmark: () => {},
      onOpen: () => {},
      onLabel: () => {},
      onDelete: () => {},
      onUndo: () => {},
      onGone: () => {},
      onDismiss: () => {},
    };
    const empty = renderToStaticMarkup(
      createElement(DocumentNotes, {
        ...base,
        count: READER_DOCUMENT.notes.count(0),
        hereMarked: false,
        asking: false,
        rows: [],
      }),
    );
    expect(empty).toContain(
      '<span class="meta" role="status">0 bookmarks</span>',
    );
    expect(empty).toContain(
      "No bookmarks in this document yet. Bookmark this position keeps your place.",
    );
    const marked = renderToStaticMarkup(
      createElement(DocumentNotes, {
        ...base,
        count: READER_DOCUMENT.notes.count(1),
        hereMarked: true,
        asking: false,
        rows: [
          {
            mark: {
              id: "b1",
              kind: "position",
              lang: "en",
              version: 1,
              state: "ok",
              review: null,
            },
            place: "About 40% through",
          },
        ],
      }),
    );
    expect(marked).toContain("1 bookmark<");
    expect(marked).toContain('data-swap="true" aria-disabled="true"');
    expect(marked).toContain("<span>Bookmarked here</span>");
    expect(marked).toContain("Bookmark, position");
    const asking = renderToStaticMarkup(
      createElement(DocumentNotes, {
        ...base,
        count: READER_DOCUMENT.notes.count(0),
        hereMarked: false,
        asking: true,
        rows: [],
      }),
    );
    expect(asking).toContain(
      "Signed in, your bookmarks are kept across your devices.",
    );
    expect(asking).not.toContain("No bookmarks in this document yet");
  });

  it("a position's place and the 2% rule", () => {
    const m: DocMark = {
      id: "b",
      block: null,
      at: null,
      fraction: 0.4,
      label: "",
      pos: true,
      lang: "en",
      version: 1,
    };
    expect(markPlace(m, () => null)).toBe("About 40% through");
    expect(
      hereMarked({ kind: "position", section: null, fraction: 0.42 }, [m]),
    ).toBe(true);
    expect(
      hereMarked({ kind: "position", section: null, fraction: 0.43 }, [m]),
    ).toBe(false);
  });
});

describe("a bookmark's write and removal send what the existing actions took (a guard)", () => {
  beforeEach(() => {
    for (const f of Object.values(actions)) f.mockClear();
  });
  const write = {
    org: "june",
    project: "platform",
    doc: "2026-11-14-sessions",
  };

  it("a new position bookmark", async () => {
    await runBookmarkWire(
      bookmarkWire({
        write,
        id: "0b6c7d0e-2b1a-4c1e-9d3f-111111111111",
        version: 2,
        anchor: { fraction: 0.4 },
        snippet: "Text one.",
      }),
    );
    expect(actions.saveBookmark).toHaveBeenCalledWith({
      org: "june",
      project: "platform",
      doc: "2026-11-14-sessions",
      id: "0b6c7d0e-2b1a-4c1e-9d3f-111111111111",
      version: 2,
      anchor: { fraction: 0.4 },
      snippet: "Text one.",
    });
    expect(actions.editBookmark).not.toHaveBeenCalled();
  });

  it("a label, and a cleared one", async () => {
    await runBookmarkWire(labelWire("b1", "Roles"));
    await runBookmarkWire(labelWire("b1", ""));
    expect(actions.editBookmark.mock.calls).toEqual([
      [{ id: "b1", label: "Roles" }],
      [{ id: "b1", label: null }],
    ]);
  });

  it("a removal", async () => {
    await runBookmarkWire(removeBookmarkWire("b1"));
    expect(actions.removeBookmark).toHaveBeenCalledWith({ id: "b1" });
    expect(actions.saveBookmark).not.toHaveBeenCalled();
  });
});

// ---- versions: `?v=` strict on a loose document -------------------------------------------------------

const doc = (over: Partial<KbDocument> = {}): KbDocument =>
  ({
    id: 7,
    project: "platform",
    rel_path: "2026-11-14-sessions.md",
    title: "Sessions",
    date: "2026-11-14",
    version: 5,
    format: "md",
    markdown: "# Sessions\n\nNow.\n",
    canonical_path: "/@june/platform/sessions",
    ...over,
  }) as KbDocument;

const settings = { size: 3, theme: "system" } as const;

describe("an earlier version at `?v=n` (a loose document)", () => {
  beforeEach(() => {
    app.getDocumentVersion.mockReset();
    app.getDocumentVersions.mockReset();
    app.getDocumentVersions.mockResolvedValue({ versions: [] });
  });

  it("?v=2 reads v2, and the frame says Older version", async () => {
    app.getDocumentVersion.mockResolvedValue({
      format: "md",
      title: "Sessions",
      markdown: "# Sessions\n\nThen.\n",
      date: "2026-11-14",
    });
    const out = await loadLooseReader({
      token: undefined,
      doc: doc(),
      v: 2,
      settings,
      strictVersion: true,
    });
    expect(out.kind).toBe("reader");
    if (out.kind !== "reader") return;
    expect(out.reader.view.version).toBe(2);
    expect(out.reader.view.newest).toBe(5);
    expect(app.getDocumentVersion).toHaveBeenCalledWith(undefined, 7, 2);
  });

  for (const [what, v] of [
    ["above the newest", 9],
    ["zero", 0],
  ] as const)
    it(`a version ${what} is Document not found`, async () => {
      await expect(
        loadLooseReader({
          token: undefined,
          doc: doc(),
          v,
          settings,
          strictVersion: true,
        }),
      ).rejects.toMatchObject({ digest: expect.stringMatching(/;404$/) });
    });

  it("a version the archive misses is Document not found", async () => {
    app.getDocumentVersion.mockRejectedValue(new ApiError(404, "nope"));
    await expect(
      loadLooseReader({
        token: undefined,
        doc: doc(),
        v: 3,
        settings,
        strictVersion: true,
      }),
    ).rejects.toMatchObject({ digest: expect.stringMatching(/;404$/) });
  });

  it("without strict (the chapter's reading) a missing version still reads the newest", async () => {
    const out = await loadLooseReader({
      token: undefined,
      doc: doc(),
      v: 9,
      settings,
    });
    expect(out.kind === "reader" && out.reader.view.version).toBe(5);
  });

  it("an html document keeps today's reading (the newest)", async () => {
    const out = await loadLooseReader({
      token: undefined,
      doc: doc({ format: "html" }),
      v: 9,
      settings,
      strictVersion: true,
    }).catch((e: unknown) => e);
    expect((out as { digest?: string }).digest ?? "").not.toMatch(/;404$/);
  });
});

// ---- the way back to the phases (P61-e9) -------------------------------------------------------------

describe("the way back to the phases the document was explained from (P61-e9)", () => {
  const PID = "3f6c1d2e-8a4b-4c5d-9e0f-1a2b3c4d5e6f";
  const PHASES = [
    { id: "P50-4b", name: "Order books", role: "source" as const },
    {
      id: "P48-q4",
      name: "Explain the arbitrage loop",
      role: "explain" as const,
    },
    { id: "P51-3q", name: "주문 처리", role: "source" as const },
  ];

  it("lists the explain phase first, then the sources, each linking to its phase page", () => {
    const rows = phaseRows(PHASES, PID);
    expect(rows.map((r) => [r.key, r.sub, r.href])).toEqual([
      [
        "P48-q4",
        "P48-q4 · Explain phase",
        `/projects/${PID}/workspace/phases/P48-q4`,
      ],
      [
        "P50-4b",
        "P50-4b · Source phase",
        `/projects/${PID}/workspace/phases/P50-4b`,
      ],
      [
        "P51-3q",
        "P51-3q · Source phase",
        `/projects/${PID}/workspace/phases/P51-3q`,
      ],
    ]);
    expect(rows[2].lang).toBe("ko");
    expect(phaseRows([], PID)).toEqual([]);
    expect(phaseRows(undefined, PID)).toEqual([]);
    expect(phaseRows(PHASES, null)).toEqual([]);
  });

  it("the reader draws them under the end, and nothing for none", () => {
    const html = inApp(
      createElement(
        DocumentReader,
        { view: view(), marks: "bookmarks", phases: phaseRows(PHASES, PID) },
        createElement("p", null, "the text"),
      ),
    );
    expect(html).toContain(
      '<h2 id="doc-phases-head" class="end-next-title">Explained from</h2>',
    );
    expect(html).toContain(
      `<a class="link-strong chapter-open" href="/projects/${PID}/workspace/phases/P48-q4"><span class="row-stack"><span>Explain the arbitrage loop</span><span class="meta">P48-q4 · Explain phase</span></span></a>`,
    );
    const order = ["P48-q4", "P50-4b", "P51-3q"].map((id) =>
      html.indexOf(`/workspace/phases/${id}"`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.indexOf('data-end="1"')).toBeLessThan(
      html.indexOf("doc-phases-head"),
    );
    const none = inApp(
      createElement(
        DocumentReader,
        { view: view(), marks: "bookmarks", phases: [] },
        createElement("p", null, "the text"),
      ),
    );
    expect(none).not.toContain("Explained from");
    expect(none).not.toContain("/workspace/phases/");
  });

  it("the page finds the project's id by the document's project, and reads nothing when no phase is named", async () => {
    app.listProjects.mockReset();
    app.listProjects.mockResolvedValue([
      { id: "other", name: "vocky" },
      { id: PID, name: "platform" },
    ]);
    const rows = await documentPhaseRows("tok", {
      project: "platform",
      phases: PHASES,
    });
    expect(rows[0].href).toBe(`/projects/${PID}/workspace/phases/P48-q4`);
    expect(app.listProjects).toHaveBeenCalledWith("tok");
    app.listProjects.mockClear();
    expect(
      await documentPhaseRows("tok", { project: "platform", phases: [] }),
    ).toEqual([]);
    expect(
      await documentPhaseRows(undefined, {
        project: "platform",
        phases: PHASES,
      }),
    ).toEqual([]);
    expect(app.listProjects).not.toHaveBeenCalled();
    app.listProjects.mockRejectedValue(new ApiError(500, "down"));
    expect(
      await documentPhaseRows("tok", { project: "platform", phases: PHASES }),
    ).toEqual([]);
  });

  it("hands the rows to the reader's element, and leaves another element as it was", () => {
    const rows = phaseRows(PHASES, PID);
    const el = renderDocument(
      { kind: "reader", reader: loaded("md", view()) },
      { from: null, org: "june" },
    );
    const out = withDocumentPhases(el, rows);
    expect(out.type).toBe(DocumentReader);
    expect((out.props as { phases?: unknown }).phases).toBe(rows);
    expect(withDocumentPhases(el, [])).toBe(el);
    const other = createElement("div");
    expect(withDocumentPhases(other, rows)).toBe(other);
  });
});

// ---- Document not found at an unknown address (D249-7z) ------------------------------------------------

describe("an unknown three-segment address reaches Document not found (D249-7z)", () => {
  it("`/@org/p/nope` and `/nope/x/y`: the page calls notFound()", async () => {
    vi.doMock("@/lib/auth-guards", () => ({
      optionalIdentity: async () => null,
    }));
    vi.doMock("next/headers", () => ({
      cookies: async () => ({ get: () => undefined }),
      headers: async () => new Headers(),
    }));
    app.resolveDocument.mockRejectedValue(new ApiError(404, "nope"));
    const { default: Page } =
      await import("@/app/(public)/[org]/[project]/[slug]/page");
    const call = (org: string, project: string, slug: string) =>
      Page({
        params: Promise.resolve({ org, project, slug }),
        searchParams: Promise.resolve({}),
      });
    await expect(call("@org", "p", "nope")).rejects.toMatchObject({
      digest: expect.stringMatching(/;404$/),
    });
    // the guard answers before any read upstream
    app.resolveDocument.mockClear();
    await expect(call("nope", "x", "y")).rejects.toMatchObject({
      digest: expect.stringMatching(/;404$/),
    });
    expect(app.resolveDocument).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/auth-guards");
    vi.doUnmock("next/headers");
  });
});

describe("Document not found: a member's and a visitor's words", () => {
  it("a member: the sentence and Back to Library", () => {
    const m = missingDocument({
      member: true,
      back: { href: "/library", label: "Library" },
      signInHref: "/login",
    });
    expect(m.title).toBe("Document not found");
    expect(m.text).toBe(
      "This document doesn’t exist, or it isn’t part of your org.",
    );
    expect(m.actions).toEqual([
      {
        kind: "link",
        label: "Back to Library",
        href: "/library",
        variant: "default",
      },
    ]);
  });
  it("a visitor: the shared-link sentence and Sign in back to this address", () => {
    const m = missingDocument({
      member: false,
      back: { href: "/@june", label: "june" },
      signInHref: "/login?next=%2F%40org%2Fp%2Fnope",
    });
    expect(m.text).toBe(
      "This link doesn’t point at a shared document. It may have moved, been unshared, or never existed.",
    );
    expect(m.actions).toEqual([
      {
        kind: "link",
        label: "Sign in",
        href: "/login?next=%2F%40org%2Fp%2Fnope",
        variant: "default",
      },
    ]);
  });
});
