import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Org settings and Project settings (P88-ms.S3's signed design, applied by P88-ms.S4): the three API calls they add
// (a project's delete, an org's delete, Step down) and the refusals they keep; the server actions over them (an org's
// delete moves the org cookie to the org the API names, Step down revalidates the members list); the landing a delete
// makes (the toast, then org home); the delete confirm's typed name; the org menu's line for two orgs of one name; and
// what a member's view leaves out. Next's cache, cookies and router are mocked; the API is a stubbed fetch.

const jar = { set: vi.fn() };
const toasts = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => jar), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  useRouter: vi.fn(),
}));
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({ token: "tok", identity: {} })),
}));
vi.mock("@/sikstack/shell", () => ({ publishToast: toasts.publish }));

const { revalidatePath } = await import("next/cache");
const { deleteProject } = await import("@/lib/knowledge/app");
const { deleteOrg, stepDown } = await import("@/lib/knowledge/orgs");
const { ApiError } = await import("@/lib/knowledge/client");
const { deleteOrgAction, stepDownAction } = await import("@/app/(app)/settings/actions");
const { deleteProjectAction } = await import("@/app/(app)/projects/[projectId]/settings/actions");
const { DELETE_LANDING, landAfterDelete } = await import("@/sikstack/frame/delete-landing");
const { DeleteDialog, typedNameMatches, typedNameWrong } = await import("@/sikstack/frame/delete-dialog");
const { orgLine } = await import("@/sikstack/shell/model");
const { OrgSettingsView } = await import("@/sikstack/org/settings");
const { ProjectSettingsView } = await import("@/sikstack/project/settings");
const { SETTINGS } = await import("@/content/settings");
const { MEMBERS, ORG_NAME } = await import("@/content/org");
const { ORG_COOKIE } = await import("@/lib/session");

const PROJECT = "11111111-2222-4333-8444-555555555555";
const MEMBER_ID = "33333333-4444-4555-8666-777777777777";
const NEXT_ORG = "99999999-8888-4777-8666-555555555555";

beforeAll(() => {
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
beforeEach(() => {
  jar.set.mockClear();
  vi.mocked(revalidatePath).mockClear();
  toasts.publish.mockClear();
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

function sent(fetchMock: ReturnType<typeof answer>) {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

async function refusedReason(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
  } catch (error) {
    if (error instanceof ApiError) return error.reason;
    throw error;
  }
  throw new Error("no refusal");
}

describe("the API calls", () => {
  it("a project's delete is DELETE /app/projects/{id} with the typed name", async () => {
    const fetchMock = answer(204);
    await deleteProject("tok", PROJECT, "platform");
    expect(sent(fetchMock)).toEqual({
      url: `http://kb.test:8766/app/projects/${PROJECT}`,
      method: "DELETE",
      body: { name: "platform" },
    });
  });

  it("an org's delete is DELETE /app/tenant with the typed name, and answers the next org", async () => {
    const fetchMock = answer(200, { tenant: { id: NEXT_ORG, name: "Personal" } });
    expect((await deleteOrg("tok", "Acme")).tenant.id).toBe(NEXT_ORG);
    expect(sent(fetchMock)).toEqual({ url: "http://kb.test:8766/app/tenant", method: "DELETE", body: { name: "Acme" } });
  });

  it("Step down is POST /app/members/{id}/member with no body", async () => {
    const fetchMock = answer(204);
    await stepDown("tok", MEMBER_ID);
    expect(sent(fetchMock)).toEqual({
      url: `http://kb.test:8766/app/members/${MEMBER_ID}/member`,
      method: "POST",
      body: undefined,
    });
  });

  it("each refusal keeps the API's reason", async () => {
    for (const reason of ["name", "tenant_one", "install_feedback"]) {
      answer(409, { detail: "x", reason });
      expect(await refusedReason(() => deleteOrg("tok", "Acme"))).toBe(reason);
    }
    for (const reason of ["name", "install_feedback", "tracked_path"]) {
      answer(409, { detail: "x", reason });
      expect(await refusedReason(() => deleteProject("tok", PROJECT, "assets"))).toBe(reason);
    }
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await refusedReason(() => stepDown("tok", MEMBER_ID))).toBe("last_owner");
  });
});

describe("the actions", () => {
  it("an org's delete makes the org the API names the active one", async () => {
    const fetchMock = answer(200, { tenant: { id: NEXT_ORG, name: "Personal" } });
    expect(await deleteOrgAction("  Acme ")).toEqual({ ok: true });
    expect(sent(fetchMock).body).toEqual({ name: "Acme" });
    expect(jar.set).toHaveBeenCalledTimes(1);
    expect(jar.set.mock.calls[0][0]).toBe(ORG_COOKIE);
    expect(jar.set.mock.calls[0][1]).toBe(NEXT_ORG);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("a refused org delete keeps the org and the cookie, and words the refusal by its reason", async () => {
    for (const reason of ["name", "tenant_one", "install_feedback"] as const) {
      answer(409, { detail: "x", reason });
      expect(await deleteOrgAction("Acme")).toEqual({ ok: false, reason });
    }
    answer(503, { detail: "x" });
    expect(await deleteOrgAction("Acme")).toEqual({ ok: false, reason: "failed" });
    answer(403, { detail: "x" });
    expect(await deleteOrgAction("Acme")).toEqual({ ok: false, reason: "failed" });
    expect(jar.set).not.toHaveBeenCalled();
    const fetchMock = answer(200, {});
    expect(await deleteOrgAction("   ")).toEqual({ ok: false, reason: "name" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a project's delete sends the project's id and the typed name, then revalidates the app", async () => {
    const fetchMock = answer(204);
    expect(await deleteProjectAction(PROJECT, "platform")).toEqual({ ok: true });
    expect(sent(fetchMock)).toEqual({
      url: `http://kb.test:8766/app/projects/${PROJECT}`,
      method: "DELETE",
      body: { name: "platform" },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    for (const reason of ["name", "install_feedback", "tracked_path"] as const) {
      answer(409, { detail: "x", reason });
      expect(await deleteProjectAction(PROJECT, "platform")).toEqual({ ok: false, reason });
    }
    const untouched = answer(204);
    expect(await deleteProjectAction("not-a-uuid", "platform")).toEqual({ ok: false, reason: "failed" });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("Step down revalidates the members list; the org's last owner is refused by name", async () => {
    answer(204);
    expect(await stepDownAction(MEMBER_ID)).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/settings");
    vi.mocked(revalidatePath).mockClear();
    answer(409, { detail: "x", reason: "last_owner" });
    expect(await stepDownAction(MEMBER_ID)).toEqual({ ok: false, reason: "last_owner" });
    answer(500);
    expect(await stepDownAction(MEMBER_ID)).toEqual({ ok: false, reason: "failed" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("a delete lands on org home, read again, with the toast naming what went", () => {
    const router = { push: vi.fn(), refresh: vi.fn() };
    landAfterDelete(router, "Acme");
    expect(DELETE_LANDING).toBe("/dashboard");
    expect(router.push).toHaveBeenCalledWith("/dashboard");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(toasts.publish).toHaveBeenCalledWith("Acme deleted.");
  });
});

describe("the delete confirm", () => {
  it("matches the exact name, outer spaces aside, case counted", () => {
    expect(typedNameMatches("Acme Labs", "Acme Labs")).toBe(true);
    expect(typedNameMatches("  Acme Labs ", "Acme Labs")).toBe(true);
    expect(typedNameMatches("acme labs", "Acme Labs")).toBe(false);
    expect(typedNameMatches("Acme", "Acme Labs")).toBe(false);
    expect(typedNameMatches("", "Acme Labs")).toBe(false);
  });

  it("calls a name wrong only once it can no longer become the name", () => {
    expect(typedNameWrong("", "Acme Labs")).toBe(false);
    expect(typedNameWrong("Acme L", "Acme Labs")).toBe(false);
    expect(typedNameWrong("Acme Labs", "Acme Labs")).toBe(false);
    expect(typedNameWrong("acme", "Acme Labs")).toBe(true);
    expect(typedNameWrong("Acme Labz", "Acme Labs")).toBe(true);
    expect(typedNameWrong("Acme Labs!", "Acme Labs")).toBe(true);
  });

  const dialog = (typed: string, phase?: "typing" | "name" | "tenant_one") =>
    renderToStaticMarkup(
      createElement(DeleteDialog, {
        name: "Acme",
        text: "goes",
        confirm: SETTINGS.confirm.deleteOrg,
        remove: async () => ({ ok: true }) as const,
        onDeleted: () => {},
        onClose: () => {},
        refusal: () => SETTINGS.confirm.refused.tenant_one("Acme"),
        typed,
        phase,
      }),
    );
  /** The danger button's markup: the form's submit. */
  const confirmButton = (html: string) => html.slice(html.lastIndexOf("<button", html.indexOf(SETTINGS.confirm.deleteOrg)));

  it("keeps Delete off until the typed name matches, and says a wrong one in the signed words", () => {
    expect(confirmButton(dialog(""))).toMatch(/^<button[^>]*disabled/);
    expect(confirmButton(dialog("Acm"))).toMatch(/^<button[^>]*disabled/);
    expect(confirmButton(dialog("Acme"))).not.toMatch(/^<button[^>]*disabled/);
    const wrong = dialog("acme");
    expect(confirmButton(wrong)).toMatch(/^<button[^>]*disabled/);
    expect(wrong).toContain("Type Acme exactly as shown.");
    expect(wrong).toContain('aria-invalid="true"');
    expect(dialog("Acm")).not.toContain("exactly as shown");
    // The API's 409 `name` is the same error; a refusal is the notice, with Delete off for good.
    expect(dialog("Acme", "name")).toContain("Type Acme exactly as shown.");
    const refused = dialog("Acme", "tenant_one");
    expect(refused).toContain("this server&#x27;s own org");
    expect(confirmButton(refused)).toMatch(/^<button[^>]*disabled/);
  });
});

describe("the org menu's second line", () => {
  const org = (id: string, name: string, extra: { address?: string | null; owner?: string | null } = {}) => ({
    id,
    name,
    address: extra.address ?? null,
    projects: 1,
    owner: extra.owner ?? null,
  });

  it("is the public URL first, whatever the name", () => {
    const a = org("a", "Personal", { address: "sikstack.com/@june", owner: "me@example.com" });
    expect(orgLine(a, [a, org("b", "Personal")], "me@example.com")).toEqual({
      kind: "address",
      address: "sikstack.com/@june",
    });
  });

  it("tells two orgs of one name apart by their owner, and is none for a name of its own", () => {
    const mine = org("a", "Personal", { owner: "Me@Example.com" });
    const theirs = org("b", " personal ", { owner: "jun@example.com" });
    const other = org("c", "Acme", { owner: "jun@example.com" });
    const orgs = [mine, theirs, other];
    expect(orgLine(mine, orgs, "me@example.com")).toEqual({ kind: "owner", mine: true, email: "Me@Example.com" });
    expect(orgLine(theirs, orgs, "me@example.com")).toEqual({ kind: "owner", mine: false, email: "jun@example.com" });
    expect(orgLine(other, orgs, "me@example.com")).toEqual({ kind: "none" });
    // An owner the API does not know: the old line.
    expect(orgLine(org("d", "Personal"), [mine, org("d", "Personal")], "me@example.com")).toEqual({ kind: "none" });
    expect(SETTINGS.orgLine.mine).toBe("Owned by you");
    expect(SETTINGS.orgLine.owned("jun@example.com")).toBe("Owned by jun@example.com");
  });
});

describe("a member's view is read only", () => {
  const FORMAT = { timeZone: "UTC", now: Date.parse("2026-11-25T00:00:00Z") };
  const OWNER = { id: "m1", email: "owner@example.com", role: "owner" as const, joinedAt: "2026-11-01T00:00:00Z" };
  const SORA = { id: "m2", email: "sora@example.com", role: "member" as const, joinedAt: "2026-11-02T00:00:00Z" };
  const orgSettings = (role: "owner" | "member", slug: string | null = "acme") =>
    renderToStaticMarkup(
      createElement(OrgSettingsView, {
        org: { name: "Acme", slug, projects: 2 },
        me: role === "owner" ? { email: OWNER.email, role } : { email: SORA.email, role },
        members: [OWNER, SORA],
        invites: role === "owner" ? [{ id: "i1", email: "new@example.com", invitedAt: "2026-11-20T00:00:00Z", expiresAt: "2026-11-27T00:00:00Z" }] : [],
        rename: async () => ({ ok: false, reason: "failed" }) as const,
        saveSlug: async () => ({ ok: false, reason: "failed" }) as const,
        invite: async () => ({ ok: false, reason: "failed" }) as const,
        revoke: async () => ({ ok: true }),
        promote: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
        leave: async () => ({ ok: true }),
        stepDown: async () => ({ ok: true }),
        deleteOrg: async () => ({ ok: true }) as const,
        onDeleted: () => {},
        format: FORMAT as never,
      }),
    );
  const projectSettings = (owner: boolean) =>
    renderToStaticMarkup(
      createElement(ProjectSettingsView, {
        project: { id: "p1", name: "platform", visibility: "private" },
        org: "Acme",
        owner,
        keys: [],
        setVisibility: async () => ({ ok: true }),
        mint: async () => ({ ok: false, reason: "failed" }) as const,
        revoke: async () => ({ ok: true }),
        deleteProject: async () => ({ ok: true }) as const,
        onDeleted: () => {},
        format: FORMAT,
      }),
    );

  it("Org settings: an owner's has the name's Change, Invites and Delete org; a member's none of them", () => {
    const owner = orgSettings("owner");
    expect(owner).toContain(`<h1>${SETTINGS.org.title}</h1>`);
    expect(owner).toContain(`aria-label="${SETTINGS.org.delete.openLabel("Acme")}"`);
    expect(owner).toContain(`>${MEMBERS.invites.heading}<`);
    expect(owner).toContain(`>${ORG_NAME.change}<`);
    // The role note, under the members.
    expect(owner).toContain("manage people");
    expect(owner).toContain("make projects and their keys");

    const member = orgSettings("member");
    expect(member).toContain(`<h1>${SETTINGS.org.title}</h1>`);
    expect(member).toContain(`>${ORG_NAME.heading}<`);
    expect(member).not.toContain(SETTINGS.org.delete.heading);
    expect(member).not.toContain(`>${MEMBERS.invites.heading}<`);
    expect(member).not.toContain(`>${ORG_NAME.change}<`);
    expect(member).not.toContain(MEMBERS.members.makeOwnerLabel("owner@example.com"));
    expect(member).toContain("make projects and their keys");
    // No Public URL panel for a member while the org has none.
    expect(orgSettings("member", null)).not.toContain("Public URL");
  });

  it("Project settings: an owner's has the switch and Delete project; a member's the badge and the keys alone", () => {
    const owner = projectSettings(true);
    expect(owner).toContain(`<h1>${SETTINGS.project.title}</h1>`);
    expect(owner).toContain("Make public");
    expect(owner).toContain(`aria-label="${SETTINGS.project.delete.openLabel("platform")}"`);
    expect(owner).toContain(">API keys<");

    const member = projectSettings(false);
    expect(member).toContain("New items members only");
    expect(member).toContain(">API keys<");
    expect(member).not.toContain("Make public");
    expect(member).not.toContain("Make private");
    expect(member).not.toContain(SETTINGS.project.delete.heading);
  });
});

describe("/members", () => {
  it("answers a permanent redirect to Org settings", async () => {
    const nextConfig = (await import("../next.config")).default;
    const rules = await nextConfig.redirects!();
    expect(rules).toContainEqual({ source: "/members", destination: "/settings", permanent: true });
  });
});
