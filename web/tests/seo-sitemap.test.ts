import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { KbSitemapItem } from "@/lib/knowledge/sitemap";

// P87 — `/sitemap.xml` lists `/` plus every Public document, book and chapter (and each org's public library
// holding one) from the anonymous `GET /app/sitemap`, each URL the same as that page's canonical tag; a read
// that fails lists `/` alone. The fetch is stubbed; the pages' metadata functions run with their loaders mocked
// to the same items, so a drift between the sitemap's URL and a page's canonical fails here.

const SITE = "http://127.0.0.1:3030";

vi.mock("next/server", async (orig) => ({
  ...(await orig<object>()),
  connection: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/auth-guards", () => ({
  optionalIdentity: vi.fn(async () => null),
}));
const loads = vi.hoisted(() => ({
  loadBookOnce: vi.fn(),
  loadChapterReaderOnce: vi.fn(),
  loadLooseReader: vi.fn(),
  resolveDocument: vi.fn(),
  getDocumentOnce: vi.fn(),
  loadPublicLibraryOnce: vi.fn(),
}));
vi.mock("@/lib/book/load", () => ({ loadBookOnce: loads.loadBookOnce }));
vi.mock("@/lib/reader/load", async (orig) => ({
  ...(await orig<object>()),
  loadChapterReaderOnce: loads.loadChapterReaderOnce,
  loadLooseReader: loads.loadLooseReader,
}));
vi.mock("@/lib/knowledge/app", async (orig) => ({
  ...(await orig<object>()),
  resolveDocument: loads.resolveDocument,
}));
vi.mock("@/app/(public)/documents/[id]/read", () => ({
  getDocumentOnce: loads.getDocumentOnce,
}));
vi.mock("@/lib/public-library/load", () => ({
  loadPublicLibraryOnce: loads.loadPublicLibraryOnce,
}));
vi.mock("@/lib/public-library/model", async (orig) => ({
  ...(await orig<object>()),
  publicLibraryView: vi.fn(() => ({ orgName: "Acme" })),
}));

const TENANT = "5fc07688-83f9-45bf-beb7-51a1b8614ea5";
const ITEMS: KbSitemapItem[] = [
  {
    kind: "book",
    org: "acme",
    project: "lab",
    slug: "guide",
    updated_at: "2026-11-02T10:00:00+00:00",
    chapters: [
      { key: "intro", updated_at: "2026-11-01T10:00:00+00:00" },
      { key: "setup", updated_at: "2026-11-02T10:00:00+00:00" },
    ],
  },
  {
    kind: "doc",
    org: "acme",
    project: "lab",
    slug: "notes",
    id: 41,
    canonical_path: "/@acme/lab/notes",
    updated_at: "2026-11-03T10:00:00+00:00",
  },
  {
    kind: "doc",
    org: TENANT,
    project: "lab",
    slug: "draft",
    id: 7,
    canonical_path: null,
    updated_at: null,
  },
];

const EXPECTED = [
  `${SITE}/@acme`,
  `${SITE}/@${TENANT}`,
  `${SITE}/@acme/lab/books/guide`,
  `${SITE}/@acme/lab/books/guide/intro`,
  `${SITE}/@acme/lab/books/guide/setup`,
  `${SITE}/@acme/lab/notes`,
  `${SITE}/documents/7`,
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.KB_API_BASE_URL = "http://kb.test/";
  fetchMock = vi.fn(async () => Response.json({ items: ITEMS }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function sitemapUrls(): Promise<string[]> {
  const { default: sitemap } = await import("@/app/sitemap");
  return (await sitemap()).map((e) => e.url);
}

describe("/sitemap.xml", () => {
  it("lists / and every Public item's public URL, from one anonymous, hourly read", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries[0].url).toBe(SITE);
    expect(
      entries
        .slice(1)
        .map((e) => e.url)
        .sort(),
    ).toEqual([...EXPECTED].sort());
    expect(new Set(entries.map((e) => e.url)).size).toBe(entries.length);
    // A stored time becomes the entry's lastModified; none is invented.
    const at = Object.fromEntries(entries.map((e) => [e.url, e.lastModified]));
    expect(at[`${SITE}/@acme/lab/books/guide/intro`]).toBe(
      "2026-11-01T10:00:00+00:00",
    );
    expect(at[`${SITE}/@acme`]).toBe("2026-11-03T10:00:00+00:00");
    expect(at[`${SITE}/documents/7`]).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { next?: unknown },
    ];
    expect(url).toBe("http://kb.test/app/sitemap");
    expect(init.next).toEqual({ revalidate: 3600 });
    expect(init.cache).toBeUndefined();
    // No bearer, org or share header: the read is the same for everyone.
    expect(Object.keys(init.headers ?? {})).toEqual(["Accept"]);
  });

  it("falls back to / alone when the read fails", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await sitemapUrls()).toEqual([SITE]);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    expect(await sitemapUrls()).toEqual([SITE]);
    fetchMock.mockResolvedValueOnce(Response.json({ detail: "x" }));
    expect(await sitemapUrls()).toEqual([SITE]);
    delete process.env.KB_API_BASE_URL;
    expect(await sitemapUrls()).toEqual([SITE]);
  });
});

type Meta = { alternates?: { canonical?: unknown } | null };
const search = Promise.resolve({});

describe("each public page's canonical URL is the one the sitemap lists", () => {
  it("the org library", async () => {
    loads.loadPublicLibraryOnce.mockResolvedValue({
      listing: { org: { id: TENANT, slug: null, name: "Bare", label: TENANT } },
      state: null,
      ids: null,
    });
    const page = await import("@/app/(public)/[org]/(library)/(guarded)/page");
    const meta: Meta = await page.generateMetadata({
      params: Promise.resolve({ org: `%40${TENANT}` }),
    });
    expect(meta.alternates?.canonical).toBe(`${SITE}/@${TENANT}`);
    expect(EXPECTED).toContain(meta.alternates?.canonical);
  });

  it("a book, asked by its tenant id, names its slug's address", async () => {
    loads.loadBookOnce.mockResolvedValue({
      title: "Guide",
      org: "acme",
      project: "lab",
      slug: "guide",
    });
    const page =
      await import("@/app/(public)/[org]/[project]/books/[book]/page");
    const meta: Meta = await page.generateMetadata({
      params: Promise.resolve({
        org: `%40${TENANT}`,
        project: "lab",
        book: "guide",
      }),
      searchParams: search,
    });
    expect(meta.alternates?.canonical).toBe(`${SITE}/@acme/lab/books/guide`);
    expect(EXPECTED).toContain(meta.alternates?.canonical);
  });

  it("a chapter, whatever language or version is on screen", async () => {
    const target = {
      kind: "chapter",
      org: "acme",
      project: "lab",
      book: "guide",
      chapter: "setup",
    };
    loads.loadChapterReaderOnce.mockResolvedValue({
      kind: "legacy",
      legacy: { view: { title: "Setup", target } },
    });
    const page =
      await import("@/app/(public)/[org]/[project]/books/[book]/[chapter]/page");
    const meta: Meta = await page.generateMetadata({
      params: Promise.resolve({
        org: "%40acme",
        project: "lab",
        book: "guide",
        chapter: "setup",
      }),
      searchParams: Promise.resolve({ lang: "ko", v: "2" }),
    });
    expect(meta.alternates?.canonical).toBe(
      `${SITE}/@acme/lab/books/guide/setup`,
    );
    expect(EXPECTED).toContain(meta.alternates?.canonical);
  });

  it("a document on its pretty address", async () => {
    loads.resolveDocument.mockResolvedValue({
      id: 41,
      project: "lab",
      title: "Notes",
      canonical_path: "/@acme/lab/notes",
      chapter: null,
    });
    loads.loadLooseReader.mockResolvedValue({
      kind: "reader",
      reader: {
        view: {
          title: "Notes",
          target: {
            kind: "document",
            id: 41,
            canonicalPath: "/@acme/lab/notes",
          },
        },
      },
    });
    const page = await import("@/app/(public)/[org]/[project]/[slug]/page");
    const meta: Meta = await page.generateMetadata({
      params: Promise.resolve({
        org: "%40acme",
        project: "lab",
        slug: "notes",
      }),
      searchParams: Promise.resolve({ v: "1" }),
    });
    expect(meta.alternates?.canonical).toBe(`${SITE}/@acme/lab/notes`);
    expect(EXPECTED).toContain(meta.alternates?.canonical);
  });

  it("a slug-less org's document on its id address", async () => {
    loads.getDocumentOnce.mockResolvedValue({
      id: 7,
      project: "lab",
      title: "Draft",
      canonical_path: null,
      chapter: null,
    });
    loads.loadLooseReader.mockResolvedValue({
      kind: "reader",
      reader: {
        view: {
          title: "Draft",
          target: { kind: "document", id: 7, canonicalPath: null },
        },
      },
    });
    const page = await import("@/app/(public)/documents/[id]/page");
    const meta: Meta = await page.generateMetadata({
      params: Promise.resolve({ id: "7" }),
      searchParams: search,
    });
    expect(meta.alternates?.canonical).toBe(`${SITE}/documents/7`);
    expect(EXPECTED).toContain(meta.alternates?.canonical);
  });
});
