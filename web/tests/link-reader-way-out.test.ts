import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P75 — a reader who arrives by a share link always has a working way out. In an org with nothing Public, the
// org's public library (`/@{org}`) is "Library not found" to a signed-out reader, so a link reader's wordmark,
// org crumb and "Back to <org>" lead to the sikstack home (`/`) instead, on a document, a book page and a
// chapter, and in their loading and not-found states. A public reader (the org library lists something) and a
// member keep their links as they were. Each link is checked for the three readers: the link reader (signed
// out, holding a share cookie, the org library a 404), the public reader (signed out, no share cookie, or one in
// an org whose library lists a Public item) and the member (signed in).

vi.mock("@/lib/reader/actions", () => ({
  saveReaderPosition: vi.fn(async () => ({ ok: true })),
  saveQuizAttempt: vi.fn(async () => ({ ok: true })),
  saveAnnotation: vi.fn(async () => ({ ok: true })),
  editAnnotation: vi.fn(async () => ({ ok: true })),
  removeAnnotation: vi.fn(async () => ({ ok: true })),
  saveBookmark: vi.fn(async () => ({ ok: true })),
  editBookmark: vi.fn(async () => ({ ok: true })),
  removeBookmark: vi.fn(async () => ({ ok: true })),
}));

// Who is reading, what their browser holds, and what the org's public library answers.
const who = vi.hoisted(() => ({
  identity: null as null | { token: string; identity: unknown },
  shareCookie: undefined as string | undefined,
  path: "/",
}));
vi.mock("@/lib/auth-guards", () => ({
  optionalIdentity: vi.fn(async () => who.identity),
}));
vi.mock("@/lib/session", () => ({
  getSession: vi.fn(async () => (who.identity ? { token: "t" } : null)),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "__Host-sikstack_share" && who.shareCookie
        ? { name, value: who.shareCookie }
        : undefined,
  })),
  headers: vi.fn(async () => new Headers({ "x-kb-request-path": who.path })),
}));
const app = vi.hoisted(() => ({
  getOrgLibrary: vi.fn(),
  getBook: vi.fn(),
  getDocument: vi.fn(),
  getDocumentVersions: vi.fn(),
  listProjects: vi.fn(),
}));
vi.mock("@/lib/knowledge/app", async (orig) => ({
  ...(await orig<object>()),
  ...app,
}));
const reader = vi.hoisted(() => ({
  getReaderBook: vi.fn(),
  getReaderBookNotes: vi.fn(),
  getReaderLibrary: vi.fn(),
}));
vi.mock("@/lib/knowledge/reader", async (orig) => ({
  ...(await orig<object>()),
  ...reader,
}));
// The states read the address through the router's hooks.
const nav = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  search: new URLSearchParams(),
  pathname: "/",
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useParams: () => nav.params,
  useSearchParams: () => nav.search,
  usePathname: () => nav.pathname,
}));

const { ApiError } = await import("@/lib/knowledge/client");
const { REQUEST_PATH_HEADER } = await import("@/lib/next-path");
const { DocumentReader, DocumentLoading, DocumentMissing, documentBack } =
  await import("@/sikstack/reader/document");
const { ChapterReader } = await import("@/sikstack/reader/chapter-reader");
const { ReaderMissing, ReaderSegmentContext } =
  await import("@/sikstack/reader/reader-states");
const { bookBack, loadBook } = await import("@/lib/book/load");
const { statePlace } = await import("@/lib/book/place");
const { decodeFrom } = await import("@/lib/library/from");
const { DEFAULT_READER_SETTINGS } = await import("@/lib/reader-cookie");
const { AppRouterContext } =
  await import("next/dist/shared/lib/app-router-context.shared-runtime");
type ReaderView = import("@/lib/reader/types").ReaderView;
type KbBook = import("@/lib/knowledge/types").KbBook;
type KbOrgLibrary = import("@/lib/knowledge/types").KbOrgLibrary;

const router = {
  push: () => {},
  replace: () => {},
  refresh: () => {},
  back: () => {},
  forward: () => {},
  prefetch: () => {},
};

/** The three readers, as the reader's segment knows them. */
type Reader = "link" | "public" | "member";
const READERS: Reader[] = ["link", "public", "member"];
const segment = (r: Reader) => ({
  member: r === "member",
  orgLibrary: r !== "link",
  settings: DEFAULT_READER_SETTINGS,
});

function inSegment(r: Reader, el: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router as never },
      createElement(
        ReaderSegmentContext.Provider,
        { value: segment(r) as never },
        el,
      ),
    ),
  );
}

/** The wordmark's href ("sikstack, home"). */
const homeOf = (html: string) =>
  /<a class="mark"[^>]*href="([^"]*)"/.exec(html)?.[1] ?? null;
/** The bar's way back (the crumb): its href and its label. */
const crumbOf = (html: string) => {
  const m =
    /<a class="back bar-back" href="([^"]*)"[^>]*>.*?<span class="bar-long">([^<]*)<\/span>/.exec(
      html,
    );
  return m ? { href: m[1], label: m[2] } : null;
};

/** Where each reader's links go: the link reader to the sikstack home, the others as before. */
const HOME: Record<Reader, string> = {
  link: "/",
  public: "/@june",
  member: "/library",
};

// ---- a document ---------------------------------------------------------------------------------------------

function docView(member: boolean): ReaderView {
  return {
    kind: "loose",
    member,
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
    write: member
      ? { org: "june", project: "platform", doc: "2026-11-14-sessions" }
      : null,
    progress: member
      ? {
          state: "unopened",
          finishedVersion: null,
          maxFraction: 0,
          resume: null,
        }
      : null,
    versions: { ok: true, label: "English", rows: [] },
    book: null,
    headings: [{ id: "one", level: 2, text: "One" }],
    settings: { size: 3, theme: "system" },
  } as ReaderView;
}

describe("a document: the wordmark, the org crumb and Back to <org>", () => {
  for (const r of READERS)
    it(`the ${r} reader`, () => {
      const html = inSegment(
        r,
        createElement(
          DocumentReader,
          {
            view: docView(r === "member"),
            marks: "none",
            org: "june",
            orgName: "June Lab",
          },
          createElement("p", null, "the text"),
        ),
      );
      expect(homeOf(html)).toBe(HOME[r]);
      if (r === "link") {
        expect(crumbOf(html)).toEqual({ href: "/", label: "sikstack" });
        expect(html).toContain(">Back to sikstack</button>");
        expect(html).not.toContain('href="/@june"');
      } else if (r === "public") {
        expect(crumbOf(html)).toEqual({ href: "/@june", label: "June Lab" });
        expect(html).toContain(">Back to June Lab</button>");
      } else {
        expect(crumbOf(html)).toEqual({ href: "/library", label: "Library" });
        expect(html).toContain(">Back to Library</button>");
      }
    });

  it("the way back the end button follows (`documentBack`), for each reader", () => {
    const at = {
      from: null,
      org: "june",
      names: { project: "platform", org: "June Lab" },
    };
    expect(
      documentBack({ ...at, member: false, orgLibrary: false }),
    ).toMatchObject({
      href: "/",
      label: "sikstack",
    });
    expect(
      documentBack({ ...at, member: false, orgLibrary: true }),
    ).toMatchObject({
      href: "/@june",
      label: "June Lab",
    });
    // a `?from=` naming the org's own public library or project page is no way out either
    for (const from of ["/@june?page=2", "/@june/platform"])
      expect(
        documentBack({ ...at, from, member: false, orgLibrary: false }),
      ).toMatchObject({ href: "/", label: "sikstack" });
    // a member's way back never depends on the org's public library
    expect(
      documentBack({ ...at, member: true, orgLibrary: false }),
    ).toMatchObject({
      href: "/library",
      label: "Library",
    });
  });

  for (const r of READERS)
    it(`its loading and not-found states (the ${r} reader)`, () => {
      nav.params = { org: "@june", project: "platform", slug: "sessions" };
      nav.search = new URLSearchParams();
      nav.pathname = "/@june/platform/sessions";
      for (const state of [DocumentLoading, DocumentMissing]) {
        const html = inSegment(r, createElement(state));
        expect(homeOf(html)).toBe(HOME[r]);
        const crumb = crumbOf(html);
        expect(crumb?.href).toBe(HOME[r]);
        if (r === "link") expect(html).not.toContain('href="/@june"');
      }
    });
});

// ---- a chapter -------------------------------------------------------------------------------------------------

function chapterView(member: boolean): ReaderView {
  const target = {
    kind: "chapter" as const,
    org: "june",
    project: "platform",
    book: "handbook",
    chapter: "c1",
  };
  return {
    kind: "chapter",
    member,
    title: "Sessions and sign-in",
    lang: "en",
    langs: [{ lang: "en", label: "English" }],
    version: 1,
    newest: 1,
    summary: "A lede.",
    date: "2026-11-02",
    project: "platform",
    staleSource: null,
    target,
    write: member ? { org: "june", project: "platform", doc: "c1" } : null,
    progress: null,
    versions: { ok: true, label: "English", rows: [] },
    book: {
      title: "The platform handbook",
      backHref: "/@june/platform/books/handbook",
      n: 1,
      total: 2,
      prev: null,
      next: null,
      chapters: [],
      finished: 0,
    },
    headings: [{ id: "s1", level: 2, text: "One" }],
    settings: { size: 3, theme: "system" },
  } as unknown as ReaderView;
}

describe("a chapter: the wordmark (its crumb is the book, which the link opens)", () => {
  for (const r of READERS)
    it(`the ${r} reader`, () => {
      const html = inSegment(
        r,
        createElement(
          ChapterReader,
          { view: chapterView(r === "member") } as never,
          createElement("p", null, "the text"),
        ),
      );
      expect(homeOf(html)).toBe(HOME[r]);
      expect(crumbOf(html)?.href).toBe("/@june/platform/books/handbook");
    });

  for (const r of READERS)
    it(`Chapter not found (the ${r} reader)`, () => {
      nav.params = {
        org: "@june",
        project: "platform",
        book: "handbook",
        chapter: "nope",
      };
      nav.pathname = "/@june/platform/books/handbook/nope";
      const html = inSegment(r, createElement(ReaderMissing));
      expect(homeOf(html)).toBe(HOME[r]);
      if (r === "link") expect(html).not.toContain('href="/@june"');
    });
});

// ---- a book page --------------------------------------------------------------------------------------------

describe("a book page's way back and wordmark, from its read", () => {
  const read = {
    owner: "june",
    slug: "june",
    orgName: "June Lab",
    project: "platform",
  };
  it("`bookBack` for each reader", () => {
    expect(
      bookBack(decodeFrom(""), { ...read, member: false, orgLibrary: false }),
    ).toEqual({ href: "/", label: "sikstack" });
    expect(
      bookBack(decodeFrom("/@june?page=2"), {
        ...read,
        member: false,
        orgLibrary: false,
      }),
    ).toEqual({ href: "/", label: "sikstack" });
    expect(
      bookBack(decodeFrom(""), { ...read, member: false, orgLibrary: true }),
    ).toEqual({ href: "/@june", label: "June Lab" });
    expect(
      bookBack(decodeFrom(""), { ...read, member: true, orgLibrary: false }),
    ).toEqual({ href: "/library", label: "Library" });
  });

  it("its states' place (loading, Book not found) for each reader", () => {
    const path = "/@june/platform/books/guide";
    const link = statePlace(path, false, false);
    expect(link.homeHref).toBe("/");
    expect(link.back).toEqual({ href: "/", label: "sikstack" });
    const pub = statePlace(path, false, true);
    expect(pub.homeHref).toBe("/@june");
    expect(pub.back).toEqual({ href: "/@june", label: "june" });
    const member = statePlace(path, true, false);
    expect(member.homeHref).toBe("/library");
    expect(member.back).toEqual({ href: "/library", label: "Library" });
  });
});

// ---- what the server finds out: does the org's public library read for this reader? ----------------------------

const BOOK = {
  project: "platform",
  slug: "guide",
  title: "The guide",
  kind: "codebase",
  subject: null,
  description: null,
  canonical_path: "/@june/platform/books/guide",
  org: { slug: "june", name: "June Lab" },
  chapters: [
    {
      key: "one",
      position: 1,
      title: null,
      source: null,
      variants: [
        {
          lang: "en",
          doc_id: 11,
          rel_path: "platform/one.md",
          title: "One",
          slug: "one",
          version: 1,
          format: "md",
          updated_at: "2026-11-12T09:00:00+00:00",
          translated_from: null,
        },
      ],
    },
  ],
} as unknown as KbBook;

const LISTING: KbOrgLibrary = {
  org: { id: "t1", slug: "june", name: "June Lab", label: "june" },
  member: false,
  projects: [{ name: "platform", visibility: "private" }],
  books: [],
  documents: [
    {
      id: 3,
      project: "platform",
      slug: "open",
      doc: "2026-11-01-open",
      title: "Open to all",
      date: "2026-11-01",
      format: "md",
      lang: "en",
      version: 1,
      subject: null,
      canonical_path: "/@june/platform/open",
    },
  ],
};

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const MEMBER = {
  token: "t",
  identity: {
    tenant: { id: "t1", slug: "june", name: "June Lab" },
    tenants: [],
  },
};

/** Set the reader up: who they are, their share cookie, and the org library's answer to them. */
function as(r: Reader | "link-in-public-org") {
  who.identity = r === "member" ? MEMBER : null;
  who.shareCookie =
    r === "link" || r === "link-in-public-org" ? TOKEN : undefined;
  app.getOrgLibrary.mockReset();
  if (r === "link")
    app.getOrgLibrary.mockRejectedValue(new ApiError(404, "Library not found"));
  else app.getOrgLibrary.mockResolvedValue(LISTING);
}

beforeEach(() => {
  for (const f of [...Object.values(app), ...Object.values(reader)])
    f.mockReset();
  app.getBook.mockResolvedValue(BOOK);
  app.getDocument.mockImplementation(async (_t: unknown, id: number) => ({
    id,
    format: "md",
    source: "# One\n",
  }));
  app.getDocumentVersions.mockResolvedValue({ versions: [] });
  reader.getReaderBook.mockRejectedValue(new ApiError(404, "no state"));
  reader.getReaderBookNotes.mockResolvedValue({
    annotations: [],
    unanchored: [],
    bookmarks: [],
  });
  reader.getReaderLibrary.mockResolvedValue({ books: [], docs: [] });
});

describe("the book page as each reader loads it", () => {
  const cases: [
    Reader | "link-in-public-org",
    string,
    { href: string; label: string },
  ][] = [
    ["link", "/", { href: "/", label: "sikstack" }],
    ["link-in-public-org", "/@june", { href: "/@june", label: "June Lab" }],
    ["public", "/@june", { href: "/@june", label: "June Lab" }],
    ["member", "/library", { href: "/library", label: "Library" }],
  ];
  for (const [r, home, back] of cases)
    it(`the ${r} reader`, async () => {
      as(r);
      const view = await loadBook("june", "platform", "guide", "");
      expect(view.homeHref).toBe(home);
      expect(view.back).toEqual(back);
    });

  it("a visitor with no link and a member cost no extra read of the org library", async () => {
    for (const r of ["public", "member"] as const) {
      as(r);
      await loadBook("june", "platform", "guide", "");
      expect(app.getOrgLibrary).not.toHaveBeenCalled();
    }
  });
});

describe("the reader routes' layouts tell their states and readers whether the org library reads", () => {
  type Segment = { props: { orgLibrary?: boolean; member: boolean } };
  const run = async (
    load: () => Promise<{ default: (p: never) => Promise<ReactElement> }>,
    params: Record<string, string>,
  ) => {
    const { default: Layout } = await load();
    const el = (await Layout({
      children: null as ReactNode,
      params: Promise.resolve(params),
    } as never)) as unknown as Segment;
    return el.props;
  };
  const layouts = [
    [
      "a document",
      () => import("@/app/(public)/[org]/[project]/[slug]/layout"),
      { org: "@june", project: "platform", slug: "sessions" },
    ],
    [
      "a chapter",
      () =>
        import("@/app/(public)/[org]/[project]/books/[book]/[chapter]/layout"),
      { org: "@june", project: "platform", book: "guide", chapter: "one" },
    ],
  ] as const;
  for (const [name, load, params] of layouts) {
    it(`${name}: the link reader in an org with nothing Public`, async () => {
      as("link");
      expect((await run(load as never, params as never)).orgLibrary).toBe(
        false,
      );
    });
    it(`${name}: a link reader in an org with a Public item, a public reader, a member`, async () => {
      for (const r of ["link-in-public-org", "public", "member"] as const) {
        as(r);
        expect((await run(load as never, params as never)).orgLibrary).toBe(
          true,
        );
      }
    });
  }

  it("the book's loading and not-found routes pass it on to their bar", async () => {
    who.path = "/@june/platform/books/guide";
    const loads = [
      () => import("@/app/(public)/[org]/[project]/books/[book]/loading"),
      () => import("@/app/(public)/[org]/[project]/books/[book]/not-found"),
    ];
    for (const load of loads)
      for (const r of READERS) {
        as(r);
        const { default: Route } = await load();
        const html = renderToStaticMarkup(
          createElement(
            AppRouterContext.Provider,
            { value: router as never },
            (await Route()) as ReactElement,
          ),
        );
        expect(homeOf(html)).toBe(HOME[r]);
        expect(crumbOf(html)?.href).toBe(HOME[r]);
      }
  });
  it("the path header is the app's own", () =>
    expect(REQUEST_PATH_HEADER).toBe("x-kb-request-path"));
});
