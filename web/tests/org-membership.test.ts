import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// An org's membership ends, its invite mail is bounded, and publishing is the owner's (P78-s2.F1): the org actions
// map the API's refusals (429 `limit` and `recipient`, 409 `last_owner` and `last_org`) to the forms' cases, Make
// owner, Remove and Leave call the API's routes (Leave clears the org cookie and lands on the next org's home),
// Members draws Make owner and Remove on an owner's member rows, Leave on a member's own row and on an owner's own
// row when the org has another owner, and the project head hides the public/private switch from a member. The
// session guard, Next's cache and cookies are mocked; the API is a stubbed fetch.

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

const { createOrgAction, leaveOrgAction, makeOwnerAction, removeMemberAction, sendInviteAction } = await import(
  "@/app/(app)/orgs/actions"
);
const { memberControls } = await import("@/sikstack/org/model");
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

  it("a refused Remove (the last owner, the account's only org, a member's try) keeps the API's reason", async () => {
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await removeMemberAction(MEMBER_ID)).toEqual({ ok: false, reason: "last_owner" });
    answer(409, { detail: "x", reason: "last_org" });
    expect(await removeMemberAction(MEMBER_ID)).toEqual({ ok: false, reason: "last_org" });
    answer(403, { detail: "x" });
    expect(await removeMemberAction(MEMBER_ID)).toEqual({ ok: false, reason: "failed" });
    expect(await removeMemberAction("not-an-id")).toEqual({ ok: false, reason: "failed" });
  });

  it("Make owner posts to the member's row in the active org", async () => {
    const fetchMock = answer(204);
    expect(await makeOwnerAction(MEMBER_ID)).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://kb.test:8766/app/members/${MEMBER_ID}/owner`);
    expect(init.method).toBe("POST");
  });

  it("a refused Make owner (a member's try, another org's row) changes nothing", async () => {
    answer(403, { detail: "x" });
    expect(await makeOwnerAction(MEMBER_ID)).toEqual({ ok: false });
    answer(404, { detail: "x" });
    expect(await makeOwnerAction(MEMBER_ID)).toEqual({ ok: false });
    const fetchMock = answer(204);
    expect(await makeOwnerAction("not-an-id")).toEqual({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Leave leaves the active org, clears the org cookie and lands on the next org's home", async () => {
    const fetchMock = answer(204);
    await expect(leaveOrgAction()).rejects.toThrow(/^REDIRECT:\/dashboard$/);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/app/tenant/leave");
    expect(init.method).toBe("POST");
    expect(jar.set).toHaveBeenCalledWith(ORG_COOKIE, "", expect.objectContaining({ maxAge: 0 }));
  });

  it("a refused Leave stays, and says why", async () => {
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await leaveOrgAction()).toEqual({ ok: false, reason: "last_owner" });
    answer(409, { detail: "x", reason: "last_org" });
    expect(await leaveOrgAction()).toEqual({ ok: false, reason: "last_org" });
    answer(500, { detail: "x" });
    expect(await leaveOrgAction()).toEqual({ ok: false, reason: "failed" });
    expect(jar.set).not.toHaveBeenCalled();
    expect(MEMBERS.members.leaveLastOrg("Acme")).toContain("Acme");
    expect(MEMBERS.members.leaveLastOwner("Acme")).toContain("Acme");
    expect(MEMBERS.members.removeLastOrg("sora@example.com", "Acme")).toContain("sora@example.com");
  });
});

describe("Members draws Make owner, Remove and Leave", () => {
  const FORMAT = { timeZone: "UTC", now: Date.parse("2026-11-25T00:00:00Z") };
  const OWNER = { id: "m1", email: "owner@example.com", role: "owner" as const, joinedAt: "2026-11-01T00:00:00Z" };
  const SORA = { id: "m2", email: "sora@example.com", role: "member" as const, joinedAt: "2026-11-02T00:00:00Z" };
  const JUN = { id: "m3", email: "jun@example.com", role: "owner" as const, joinedAt: "2026-11-03T00:00:00Z" };
  const view = (me: { email: string; role: "owner" | "member" }, members = [OWNER, SORA]) =>
    renderToStaticMarkup(
      createElement(MembersView, {
        org: "Acme",
        me,
        members,
        invites: [],
        invite: async () => ({ ok: false, reason: "failed" }) as const,
        revoke: async () => ({ ok: true }),
        promote: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
        leave: async () => ({ ok: true }),
        format: FORMAT as never,
      }),
    );
  const M = MEMBERS.members;

  it("a sole owner's view: Make owner and Remove on each member's row, nothing on its own", () => {
    const html = view({ email: "owner@example.com", role: "owner" });
    expect(html).toContain(`aria-label="${M.makeOwnerLabel("sora@example.com")}"`);
    expect(html).toContain(`aria-label="${M.removeLabel("sora@example.com")}"`);
    expect(html.indexOf(M.makeOwnerLabel("sora@example.com"))).toBeLessThan(
      html.indexOf(M.removeLabel("sora@example.com")),
    );
    expect(html).not.toContain(`aria-label="${M.makeOwnerLabel("owner@example.com")}"`);
    expect(html).not.toContain(`aria-label="${M.removeLabel("owner@example.com")}"`);
    expect(html).not.toContain(`>${M.leave}<`);
  });

  it("a co-owner's view: Leave on its own row, nothing on the other owner's", () => {
    const html = view({ email: "owner@example.com", role: "owner" }, [OWNER, SORA, JUN]);
    expect(html).toContain(`aria-label="${M.leaveLabel("Acme")}"`);
    expect(html.split(`>${M.leave}<`).length - 1).toBe(1);
    expect(html).not.toContain(M.makeOwnerLabel("jun@example.com"));
    expect(html).not.toContain(M.removeLabel("jun@example.com"));
    expect(html).toContain(`aria-label="${M.makeOwnerLabel("sora@example.com")}"`);
  });

  it("a member's view: Leave on its own row, no Make owner and no Remove", () => {
    const html = view({ email: "sora@example.com", role: "member" }, [OWNER, SORA, JUN]);
    expect(html).toContain(`aria-label="${M.leaveLabel("Acme")}"`);
    expect(html).not.toContain(M.removeLabel("owner@example.com"));
    expect(html).not.toContain(`>${M.remove}<`);
    expect(html).not.toContain(`>${M.makeOwner}<`);
  });

  it("the controls, row by row", () => {
    const owner = { email: "owner@example.com", role: "owner" as const };
    expect(memberControls(SORA, owner, [OWNER, SORA])).toEqual(["promote", "remove"]);
    expect(memberControls(OWNER, owner, [OWNER, SORA])).toEqual([]);
    expect(memberControls(OWNER, owner, [OWNER, SORA, JUN])).toEqual(["leave"]);
    expect(memberControls(JUN, owner, [OWNER, SORA, JUN])).toEqual([]);
    const member = { email: "sora@example.com", role: "member" as const };
    expect(memberControls(SORA, member, [OWNER, SORA])).toEqual(["leave"]);
    expect(memberControls(OWNER, member, [OWNER, SORA])).toEqual([]);
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
