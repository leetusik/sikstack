import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { KbLibraryDocument, KbOrgLibrary } from "@/lib/knowledge/types";

// An org's public library (job 03, Library round 02, `PublicLibrary.dc.html`; frame.md F52, F71, F321;
// D249-7z, D256-4n): the claims of P63-fk.S6.

const app = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getOrgLibrary: vi.fn(),
}));
const reader = vi.hoisted(() => ({ getReaderLibrary: vi.fn() }));
const auth = vi.hoisted(() => ({ optionalIdentity: vi.fn() }));
vi.mock("@/lib/knowledge/app", () => app);
vi.mock("@/lib/knowledge/reader", () => reader);
vi.mock("@/lib/auth-guards", () => auth);
vi.mock("@/sikstack/shell/data", () => ({
  requestNonce: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers({ "x-kb-request-path": "/nope" })),
}));

const { ApiError } = await import("@/lib/knowledge/client");
const PublicLibraryPage = (
  await import("@/app/(public)/[org]/(library)/(guarded)/page")
).default;
const PublicLibraryGuard = (
  await import("@/app/(public)/[org]/(library)/(guarded)/layout")
).default;
const PublicLibraryNotFound = (
  await import("@/app/(public)/[org]/(library)/not-found")
).default;

function doc(i: number, project: string): KbLibraryDocument {
  return {
    id: 100 - i,
    project,
    slug: `doc-${i}`,
    doc: `2026-11-1${i}-doc-${i}`,
    title: `Document ${i}`,
    date: `2026-11-1${i}`,
    format: "md",
    lang: "en",
    version: 1,
    subject: null,
    canonical_path: `/@june/${project}/doc-${i}`,
  };
}

function listing(
  member: boolean,
  documents: KbLibraryDocument[] = [doc(1, "vocky"), doc(2, "vocky")],
): KbOrgLibrary {
  return {
    org: { id: "t1", slug: "june", name: "Personal", label: "june" },
    member,
    projects: [{ name: "vocky", visibility: "public" }],
    books: [],
    documents,
  };
}

const signedIn = { token: "tok", identity: {} };

/** `notFound()`'s throw. */
const notFoundThrow = (error: unknown) =>
  String((error as { digest?: unknown })?.digest ?? "").startsWith(
    "NEXT_HTTP_ERROR_FALLBACK;404",
  );

async function page(org = "@june"): Promise<string> {
  const el = await PublicLibraryPage({ params: Promise.resolve({ org }) });
  return renderToStaticMarkup(el as ReactElement);
}

async function miss(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    return notFoundThrow(error);
  }
}

beforeEach(() => {
  app.listProjects.mockReset();
  app.getOrgLibrary.mockReset();
  reader.getReaderLibrary.mockReset();
  auth.optionalIdentity.mockReset();
  auth.optionalIdentity.mockResolvedValue(null);
  reader.getReaderLibrary.mockResolvedValue({
    books: [],
    docs: [
      {
        doc: { org: "june", project: "vocky", doc: "2026-11-11-doc-1" },
        position: { state: "finished", fraction: 1 },
      },
    ],
  });
  app.listProjects.mockResolvedValue([{ id: "p2", name: "vocky" }]);
});

describe("an address with no @ (/nope) is Page not found, and a library this reader cannot see Library not found, both a real 404", () => {
  it("the guard refuses /nope above the Loading boundary before any read, and lets a public address through", async () => {
    expect(
      await miss(() =>
        PublicLibraryGuard({
          params: Promise.resolve({ org: "nope" }),
          children: null,
        }),
      ),
    ).toBe(true);
    expect(
      await miss(() =>
        PublicLibraryGuard({
          params: Promise.resolve({ org: "@" }),
          children: null,
        }),
      ),
    ).toBe(true);
    expect(auth.optionalIdentity).not.toHaveBeenCalled();
    expect(app.getOrgLibrary).not.toHaveBeenCalled();
    app.getOrgLibrary.mockResolvedValue(listing(false));
    expect(
      await PublicLibraryGuard({
        params: Promise.resolve({ org: "@june" }),
        children: "page",
      }),
    ).toBe("page");
  });

  it("the guard refuses an unknown org, and one with nothing public to this reader, before the page streams (P78, F13)", async () => {
    app.getOrgLibrary.mockRejectedValue(new ApiError(404, "not found"));
    const guard = () =>
      PublicLibraryGuard({
        params: Promise.resolve({ org: "@nobody" }),
        children: "page",
      });
    expect(await miss(guard)).toBe(true);
    app.getOrgLibrary.mockReset();
    app.getOrgLibrary.mockResolvedValue(listing(false, []));
    expect(await miss(guard)).toBe(true);
    // a fault is the page's to draw, not a miss
    app.getOrgLibrary.mockReset();
    app.getOrgLibrary.mockRejectedValue(new ApiError(503, "down"));
    expect(await guard()).toBe("page");
  });

  it("/nope's not-found is Page not found: Go to sikstack signed out, Back to the org signed in (P78, F12)", async () => {
    const visitor = renderToStaticMarkup(
      (await PublicLibraryNotFound()) as ReactElement,
    );
    expect(visitor).toContain("Page not found");
    expect(visitor).not.toContain("Library not found");
    expect(visitor).toContain('href="/"');
    auth.optionalIdentity.mockResolvedValue({
      token: "tok",
      identity: { tenant: { name: "Personal" }, tenants: [] },
    });
    const member = renderToStaticMarkup(
      (await PublicLibraryNotFound()) as ReactElement,
    );
    expect(member).toContain("Page not found");
    expect(member).toContain("Back to Personal");
  });

  it("an @ address's not-found is the new block: the visitor's words and Sign in, else the member's and Back to Library", async () => {
    const { headers } = await import("next/headers");
    const at = () => new Headers({ "x-kb-request-path": "/@nobody" }) as never;
    vi.mocked(headers).mockResolvedValueOnce(at()).mockResolvedValueOnce(at());
    const visitor = renderToStaticMarkup(
      (await PublicLibraryNotFound()) as ReactElement,
    );
    expect(visitor).toContain('class="block block-page"');
    expect(visitor).toContain("Library not found");
    expect(visitor).toContain(
      "This link doesn’t point at a public library. It may have moved, been made private, or never existed.",
    );
    expect(visitor).toContain('href="/login');
    auth.optionalIdentity.mockResolvedValue(signedIn);
    const member = renderToStaticMarkup(
      (await PublicLibraryNotFound()) as ReactElement,
    );
    expect(member).toContain(
      "This library doesn’t exist, or nothing in it is public.",
    );
    expect(member).toContain('href="/library"');
    expect(member).toContain("Back to Library");
  });
});

describe("an org with nothing public reads Not found to a visitor and Nothing public to its member", () => {
  it("a visitor: the server's one 404 is the miss", async () => {
    app.getOrgLibrary.mockRejectedValue(new ApiError(404, "not found"));
    expect(await miss(() => page())).toBe(true);
  });

  it("a signed-in reader of another org: public projects with nothing to read are the miss", async () => {
    auth.optionalIdentity.mockResolvedValue(signedIn);
    app.getOrgLibrary.mockResolvedValue(listing(false, []));
    expect(await miss(() => page())).toBe(true);
  });

  it("a member: the head with 0 documents and the one sentence, its link to org home", async () => {
    auth.optionalIdentity.mockResolvedValue(signedIn);
    app.getOrgLibrary.mockResolvedValue({
      ...listing(true, []),
      projects: [],
    });
    const html = await page();
    expect(html).toContain("<h1>Personal</h1>");
    expect(html).toContain('<span class="publib-count">0 documents</span>');
    expect(html).toContain(
      'Nothing is public yet: open one of <a class="link publib-in" href="/dashboard"><span>Personal’s projects</span></a> and choose Make public.',
    );
    expect(html).not.toContain("publib-shelves");
  });
});

describe("a visitor's rows carry no reading state", () => {
  it("a visitor: no state on a row, the signed-out note, the list carried on", async () => {
    app.getOrgLibrary.mockResolvedValue(listing(false));
    const html = await page();
    expect(html).toContain("Document 1");
    expect(html).toContain("panel shelf-list no-state");
    expect(html).not.toContain("Finished");
    expect(html).not.toContain("Not started");
    expect(html).toContain("Nothing you read here is saved.");
    expect(html).toContain(`from=${encodeURIComponent("/@june")}`);
    expect(reader.getReaderLibrary).not.toHaveBeenCalled();
  });

  it("a signed-in reader: their own states, the private note", async () => {
    auth.optionalIdentity.mockResolvedValue(signedIn);
    app.getOrgLibrary.mockResolvedValue(listing(true));
    const html = await page();
    expect(html).not.toContain("no-state");
    expect(html).toContain("Finished");
    expect(html).toContain("Not started");
    expect(html).toContain("Your progress here is private to you.");
  });
});

describe("a shelf's foot link goes to the project's library by the viewer", () => {
  it("a member of the org: /projects/<id>/library", async () => {
    auth.optionalIdentity.mockResolvedValue(signedIn);
    app.getOrgLibrary.mockResolvedValue(listing(true));
    const html = await page();
    expect(html).toContain(
      '<a class="link-row" href="/projects/p2/library">All 2 documents</a>',
    );
  });

  it("a visitor, and a signed-in reader of another org: /@<org>/<project>", async () => {
    app.getOrgLibrary.mockResolvedValue(listing(false));
    expect(await page()).toContain(
      '<a class="link-row" href="/@june/vocky">All 2 documents</a>',
    );
    auth.optionalIdentity.mockResolvedValue(signedIn);
    expect(await page()).toContain(
      '<a class="link-row" href="/@june/vocky">All 2 documents</a>',
    );
    expect(app.listProjects).not.toHaveBeenCalled();
  });
});
