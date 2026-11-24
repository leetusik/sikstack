import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// P63 (operator decision 4, D152-kw, OQ27): the old addresses as redirects answered before anything renders,
// a member's redirect at a public project's address as a 3xx above the page's loading, and ReaderHead's
// optional tag (the Original layout's head). The real requests' status and Location are in the slice's record.

const app = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getOrgLibrary: vi.fn(),
}));
vi.mock("@/lib/knowledge/app", () => app);
const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock("@/lib/session", () => ({
  openSession: (value: string | undefined) => (value ? session.token : null),
  readSessionCookie: (req: Request) =>
    req.headers.get("cookie") ? "sealed" : undefined,
}));
const guards = vi.hoisted(() => ({ optionalIdentity: vi.fn() }));
vi.mock("@/lib/auth-guards", () => guards);
const path = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () =>
      new Headers(path.value ? { "x-kb-request-path": path.value } : {}),
  ),
}));
vi.mock("next/navigation", async (real) => ({
  ...(await real<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const legacy = await import("@/app/(app)/documents/legacy");
const { GET } = await import("@/app/(app)/documents/route");
const nextConfig = (await import("../next.config")).default;
const { exactProjectSearch, projectAt } =
  await import("@/lib/project-library/load");
const Layout = (await import("@/app/(public)/[org]/[project]/layout")).default;
const { ReaderHead } = await import("@/sikstack/reader/reader-head");

beforeEach(() => {
  vi.clearAllMocks();
  session.token = null;
  path.value = null;
});

// ---- /documents → All documents ---------------------------------------------------------------------------

describe("the old list's address maps onto the Library's own", () => {
  it("keeps the search and names the project by its name, in the Library's parameters", () => {
    const old = legacy.readOldList(
      new URLSearchParams("q=retry%20budget&project=p-1&tag=x&offset=50"),
    );
    expect(old).toEqual({ q: "retry budget", project: "p-1" });
    expect(legacy.documentsRedirect(old, "platform")).toBe(
      "/library?view=all&q=retry+budget&filter=platform",
    );
    expect(legacy.documentsRedirect(old, null)).toBe(
      "/library?view=all&q=retry+budget",
    );
    expect(
      legacy.documentsRedirect(
        legacy.readOldList(new URLSearchParams("q=&project=")),
        null,
      ),
    ).toBe("/library?view=all");
  });
});

const get = (url: string, cookie = false) =>
  GET(
    new Request(`http://localhost${url}`, {
      headers: cookie ? { cookie: "__Host-knowledge_session=x" } : {},
    }),
  );

describe("GET /documents answers a 307 before any page", () => {
  it("without a project: All documents with the search, signed in or out, and no read", async () => {
    for (const cookie of [false, true]) {
      session.token = cookie ? "tok" : null;
      const res = await get("/documents?q=deploy", cookie);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("/library?view=all&q=deploy");
    }
    const bare = await get("/documents");
    expect(bare.headers.get("location")).toBe("/library?view=all");
    expect(app.listProjects).not.toHaveBeenCalled();
  });

  it("with a project, signed out: to sign in, and back to this address", async () => {
    const res = await get("/documents?project=p-1&q=deploy");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/documents?project=p-1&q=deploy")}`,
    );
    expect(app.listProjects).not.toHaveBeenCalled();
  });

  it("with a project, signed in: the project's name as the filter", async () => {
    session.token = "tok";
    app.listProjects.mockResolvedValue([
      { id: "p-1", name: "platform" },
      { id: "p-2", name: "vocky" },
    ]);
    const res = await get("/documents?project=p-2&q=deploy", true);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "/library?view=all&q=deploy&filter=vocky",
    );
    expect(app.listProjects).toHaveBeenCalledWith("tok");
  });

  it("an unknown project, or a read that fails, leaves the filter off", async () => {
    session.token = "tok";
    app.listProjects.mockResolvedValueOnce([{ id: "p-1", name: "platform" }]);
    expect(
      (await get("/documents?project=nope", true)).headers.get("location"),
    ).toBe("/library?view=all");
    app.listProjects.mockRejectedValueOnce(new Error("down"));
    expect(
      (await get("/documents?project=p-1&q=x", true)).headers.get("location"),
    ).toBe("/library?view=all&q=x");
  });
});

// ---- /documents/<id>/versions/<v> → /documents/<id>?v=<v> ----------------------------------------------------

describe("an old version page is a config redirect (before the proxy, before any page)", () => {
  it("next.config answers it with the reader's version view, temporary", async () => {
    const rules = await nextConfig.redirects!();
    expect(rules).toContainEqual({
      source: "/documents/:id/versions/:v",
      destination: "/documents/:id?v=:v",
      permanent: false,
    });
  });
});

// ---- a member at /@org/project: a 307 above the loading ------------------------------------------------------

describe("the project address's layout", () => {
  it("decides only on the exact /@org/project address", () => {
    expect(exactProjectSearch("/@june/platform?page=2&q=x")).toEqual({
      page: "2",
      q: "x",
    });
    expect(exactProjectSearch("/@june/platform/")).toEqual({});
    expect(exactProjectSearch("/%40june/platform")).toEqual({});
    for (const nested of [
      "/@june/platform/books/guide",
      "/@june/platform/books/guide/intro",
      "/@june/platform/notes/guide",
      "/@june/platform/deploy-notes",
      "/@june",
      "/june/platform",
      "",
      null,
    ])
      expect(exactProjectSearch(nested)).toBeNull();
    expect(projectAt({ org: "%40june", project: "my%20docs" })).toEqual({
      org: "june",
      project: "my docs",
    });
    expect(projectAt({ org: "june", project: "x" })).toBeNull();
  });

  const run = (at: string) => {
    path.value = at;
    return Layout({
      children: "page",
      params: Promise.resolve({ org: "@june", project: "platform" }),
    });
  };
  const listing = (member: boolean) => ({
    org: { id: "o1", slug: "june", name: "Personal", label: "" },
    member,
    projects: [{ name: "platform", visibility: "public" }],
    books: [],
    documents: [],
  });

  it("sends a member to the project's library, with the place kept", async () => {
    guards.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    app.getOrgLibrary.mockResolvedValue(listing(true));
    app.listProjects.mockResolvedValue([{ id: "p2", name: "platform" }]);
    await expect(run("/@june/platform?page=2&q=dedupe")).rejects.toMatchObject({
      to: "/projects/p2/library?page=2&q=dedupe",
    });
  });

  it("lets a visitor through with no read of its own", async () => {
    guards.optionalIdentity.mockResolvedValue(null);
    await expect(run("/@june/platform")).resolves.toBe("page");
    expect(app.getOrgLibrary).not.toHaveBeenCalled();
    expect(app.listProjects).not.toHaveBeenCalled();
  });

  it("lets a signed-in reader of another org through", async () => {
    guards.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    app.getOrgLibrary.mockResolvedValue(listing(false));
    await expect(run("/@june/platform")).resolves.toBe("page");
  });

  it("reads nothing on a nested page", async () => {
    guards.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    await expect(run("/@june/platform/books/guide")).resolves.toBe("page");
    expect(guards.optionalIdentity).not.toHaveBeenCalled();
    expect(app.getOrgLibrary).not.toHaveBeenCalled();
  });

  it("leaves a fault to the page", async () => {
    guards.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    app.getOrgLibrary.mockRejectedValue(new Error("down"));
    await expect(run("/@june/platform")).resolves.toBe("page");
  });
});

// ---- ReaderHead's tag ------------------------------------------------------------------------------------------

describe("ReaderHead without a tag renders as before (a guard)", () => {
  const base = {
    title: "Deploy",
    lang: "en",
    where: "Document in platform",
    published: "Nov 6",
  };
  it("an older document, no sections", () => {
    expect(
      renderToStaticMarkup(
        createElement(ReaderHead, {
          ...base,
          version: 2,
          newest: 5,
          noun: "document",
          sections: [],
        }),
      ),
    ).toBe(
      '<header class="read-head"><h1 class="read-title" lang="en">Deploy</h1><div class="read-facts"><span>Document in platform</span><span>v2, published Nov 6</span><button type="button" class="link-row">Version history</button></div><div class="notice read-notice" role="status"><p><strong>Older version.</strong> You’re reading v2 of this document. The current version is v5.</p><button type="button" class="btn">Read v5</button></div></header>',
    );
  });
  it("a chapter with a lede, a translation and folded sections", () => {
    expect(
      renderToStaticMarkup(
        createElement(ReaderHead, {
          ...base,
          version: 3,
          newest: 3,
          noun: "chapter",
          lede: "A lede.",
          translation: { source: "English", from: 2, newest: 3 },
          sections: [
            { id: "a", title: "One" },
            { id: "b", title: "Two", lang: "ko" },
          ],
          fold: { total: 9, open: false, onToggle: () => {} },
        }),
      ),
    ).toBe(
      '<header class="read-head"><h1 class="read-title" lang="en">Deploy</h1><p class="read-lede" lang="en">A lede.</p><div class="read-facts"><span>Document in platform</span><span>v3, published Nov 6</span><button type="button" class="link-row">Version history</button></div><div class="notice read-notice" role="status"><p><strong>Older translation.</strong> Translated from English v2. English is now at v3.</p><button type="button" class="btn">Read English v3</button></div><nav class="read-toc" aria-label="In this chapter"><h2>In this chapter</h2><ol><li><button type="button" class="toc-link" lang="en">One</button></li><li><button type="button" class="toc-link" lang="ko">Two</button></li></ol><div class="cluster read-toc-more"><button type="button" class="link-row" aria-expanded="false" data-swap="false"><span class="swap"><span>Show all 9 sections</span><span>Show fewer</span></span></button></div></nav></header>',
    );
  });
});
