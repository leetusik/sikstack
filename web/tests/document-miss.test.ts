import { beforeEach, describe, expect, it, vi } from "vitest";

// P78, F13: `/documents/<unknown>` answers a real HTTP 404: the document's layout refuses the miss above the page's
// Loading boundary (`notFound()` before anything streams), by the page's own cached read.

const app = vi.hoisted(() => ({ getDocument: vi.fn() }));
const auth = vi.hoisted(() => ({ optionalIdentity: vi.fn() }));
vi.mock("@/lib/knowledge/app", () => app);
vi.mock("@/lib/auth-guards", () => auth);
vi.mock("@/sikstack/shell/data", () => ({
  requestNonce: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

const { ApiError } = await import("@/lib/knowledge/client");
const DocumentLayout = (await import("@/app/(public)/documents/[id]/layout"))
  .default;

const run = (id: string) =>
  DocumentLayout({ children: "page", params: Promise.resolve({ id }) });
const notFoundThrow = {
  digest: expect.stringMatching(/^NEXT_HTTP_ERROR_FALLBACK;404/),
};

beforeEach(() => {
  app.getDocument.mockReset();
  auth.optionalIdentity.mockReset();
  auth.optionalIdentity.mockResolvedValue(null);
});

describe("a document's misses are a real 404", () => {
  it("an id no document can have, before any read", async () => {
    await expect(run("abc")).rejects.toMatchObject(notFoundThrow);
    await expect(run("0")).rejects.toMatchObject(notFoundThrow);
    expect(auth.optionalIdentity).not.toHaveBeenCalled();
  });

  it("a member's document the API does not give them", async () => {
    auth.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    app.getDocument.mockRejectedValue(new ApiError(404, "not found"));
    await expect(run("999")).rejects.toMatchObject(notFoundThrow);
  });

  it("sends a visitor's miss to sign in with a real redirect, and leaves a fault to the page", async () => {
    app.getDocument.mockRejectedValue(new ApiError(404, "not found"));
    await expect(run("999")).rejects.toMatchObject({
      digest: expect.stringMatching(
        /^NEXT_REDIRECT;replace;\/login\?next=%2Fdocuments%2F999;307;/,
      ),
    });
    app.getDocument.mockReset();
    app.getDocument.mockResolvedValue({ id: 5 });
    await expect(run("5")).resolves.toBeTruthy();
    auth.optionalIdentity.mockResolvedValue({ token: "tok", identity: {} });
    app.getDocument.mockRejectedValue(new ApiError(503, "down"));
    await expect(run("999")).resolves.toBeTruthy();
  });
});
