import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// An org's membership ends, its invite mail is bounded, and publishing is the owner's (P78-s2.F1): the org actions
// map the API's refusals (429 `limit` and `recipient`, 409 `last_owner`) to the forms' cases, Remove and Leave call
// the API's routes (Leave clears the org cookie and lands on the next org's home), Members draws Remove on an
// owner's member rows and Leave on a member's own row, and the project head hides the public/private switch from a
// member. The session guard, Next's cache and cookies are mocked; the API is a stubbed fetch.

const jar = { set: vi.fn() };
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({ token: "tok", identity: {} })),
}));

const { createOrgAction, leaveOrgAction, removeMemberAction, sendInviteAction } = await import(
  "@/app/(app)/orgs/actions"
);
const { MembersView } = await import("@/sikstack/org/members");
const { ProjectHead } = await import("@/app/(app)/projects/[projectId]/project-head");
const { MEMBERS, NEW_ORG } = await import("@/content/org");
const { ORG_COOKIE } = await import("@/lib/session");

const MEMBER_ID = "33333333-4444-4555-8666-777777777777";

beforeAll(() => {
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
beforeEach(() => {
  jar.set.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown = { detail: "x" }) {
  const fetchMock = vi.fn(
    async () =>
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the invite and new org limits", () => {
  it("an inviter past its limit and an address past its own are the form's refusals", async () => {
    answer(429, { detail: "x", reason: "limit" });
    expect(await sendInviteAction("sora@example.com")).toEqual({ ok: false, reason: "limit" });
    answer(429, { detail: "x", reason: "recipient" });
    expect(await sendInviteAction("sora@example.com")).toEqual({ ok: false, reason: "recipient" });
    expect(MEMBERS.invites.errors.limit).toMatch(/\S/);
    expect(MEMBERS.invites.errors.recipient("sora@example.com")).toContain("sora@example.com");
  });

  it("an account past its new orgs for the day is New org's refusal", async () => {
    answer(429, { detail: "x", reason: "limit" });
    expect(await createOrgAction("Acme")).toEqual({ ok: false, reason: "limit" });
    expect(NEW_ORG.errors.limit).toMatch(/\S/);
  });
});

describe("membership ends", () => {
  it("Remove deletes the member's row in the active org", async () => {
    const fetchMock = answer(204);
    expect(await removeMemberAction(MEMBER_ID)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://kb.test:8766/app/members/${MEMBER_ID}`);
    expect(init.method).toBe("DELETE");
  });

  it("a refused Remove (the last owner, a member's try) changes nothing", async () => {
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await removeMemberAction(MEMBER_ID)).toEqual({ ok: false });
    expect(await removeMemberAction("not-an-id")).toEqual({ ok: false });
  });

  it("Leave leaves the active org, clears the org cookie and lands on the next org's home", async () => {
    const fetchMock = answer(204);
    await expect(leaveOrgAction()).rejects.toThrow(/^REDIRECT:\/dashboard$/);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/app/tenant/leave");
    expect(init.method).toBe("POST");
    expect(jar.set).toHaveBeenCalledWith(ORG_COOKIE, "", expect.objectContaining({ maxAge: 0 }));
  });

  it("a refused Leave stays, and says so", async () => {
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await leaveOrgAction()).toEqual({ ok: false });
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("Members draws Remove and Leave", () => {
  const FORMAT = { timeZone: "UTC", now: Date.parse("2026-11-25T00:00:00Z") };
  const members = [
    { id: "m1", email: "owner@example.com", role: "owner" as const, joinedAt: "2026-11-01T00:00:00Z" },
    { id: "m2", email: "sora@example.com", role: "member" as const, joinedAt: "2026-11-02T00:00:00Z" },
  ];
  const view = (me: { email: string; role: "owner" | "member" }) =>
    renderToStaticMarkup(
      createElement(MembersView, {
        org: "Acme",
        me,
        members,
        invites: [],
        invite: async () => ({ ok: false, reason: "failed" }) as const,
        revoke: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
        leave: async () => ({ ok: true }),
        format: FORMAT as never,
      }),
    );

  it("an owner's view: Remove on each member's row, none on an owner's", () => {
    const html = view({ email: "owner@example.com", role: "owner" });
    expect(html).toContain(`aria-label="${MEMBERS.members.removeLabel("sora@example.com")}"`);
    expect(html).not.toContain(`aria-label="${MEMBERS.members.removeLabel("owner@example.com")}"`);
    expect(html).not.toContain(`>${MEMBERS.members.leave}<`);
  });

  it("a member's view: Leave on its own row, no Remove", () => {
    const html = view({ email: "sora@example.com", role: "member" });
    expect(html).toContain(`aria-label="${MEMBERS.members.leaveLabel("Acme")}"`);
    expect(html).not.toContain(MEMBERS.members.removeLabel("owner@example.com"));
    expect(html).not.toContain(`>${MEMBERS.members.remove}<`);
  });
});

describe("publishing is the owner's", () => {
  const head = (owner: boolean) =>
    renderToStaticMarkup(
      createElement(ProjectHead, {
        projectId: "p1",
        name: "platform",
        org: "Acme",
        created: "Nov 2",
        visibility: "private",
        owner,
      }),
    );

  it("the owner sees Make public; a member sees the badge alone", () => {
    expect(head(true)).toContain("Make public");
    expect(head(false)).not.toContain("Make public");
    expect(head(false)).not.toContain("Make private");
    expect(head(false)).toContain("Private");
  });
});
