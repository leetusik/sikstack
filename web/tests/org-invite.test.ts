import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as loginPOST } from "@/app/api/auth/login/route";
import { POST as signupPOST } from "@/app/api/auth/signup/route";
import { ORG_COOKIE } from "@/lib/session";
import { inviteCodeOf, inviteViewFromServer } from "@/sikstack/org/model";

// P78-s2.S4 — an org invite through the web: the invite page's view from the API's read (which phase a code and a
// session draw), the code a sign-in's `next` carries, and the BFF's sign-in and sign-up forwarding it, a joined
// account starting its session in the joined org. The pages and the API are proven live (the verify stack).

const ORG = "11111111-2222-4333-8444-555555555555";

describe("the invite page's view", () => {
  const valid = { state: "valid", org: { name: "Acme" }, email: "sora@example.com", invited_by: "owner@example.com" };

  it("signed out, a valid code is the sign-in pair for the invited address", () => {
    const view = inviteViewFromServer(valid, "c1", null);
    expect(view).toMatchObject({ phase: "out", email: "sora@example.com", invitedBy: "owner@example.com" });
    expect(view.org.name).toBe("Acme");
  });

  it("signed in as the invited address (any case), Join; as another, the other-account outcome", () => {
    expect(inviteViewFromServer({ ...valid, member: false }, "c1", "Sora@Example.com").phase).toBe("ready");
    expect(inviteViewFromServer({ ...valid, member: false }, "c1", "jun@example.com").phase).toBe("other");
  });

  it("a member already sees that outcome with the org's id to open it", () => {
    const view = inviteViewFromServer(
      { ...valid, member: true, org: { id: ORG, name: "Acme" } },
      "c1",
      "sora@example.com",
    );
    expect(view.phase).toBe("member");
    expect(view.org.id).toBe(ORG);
  });

  it("expired, revoked and used are one page, signed in or out", () => {
    for (const state of ["expired", "revoked", "used"]) {
      expect(inviteViewFromServer({ state, org: { name: "Acme" } }, "c1", null).phase).toBe("expired");
      expect(inviteViewFromServer({ state, org: { name: "Acme" }, member: false }, "c1", "a@b.co").phase).toBe(
        "expired",
      );
    }
  });
});

describe("the code a sign-in's next carries", () => {
  it("is the invite page's code only", () => {
    expect(inviteCodeOf("/invite?code=abc%2Bx")).toBe("abc+x");
    expect(inviteCodeOf("/invite")).toBeNull();
    expect(inviteCodeOf("/connect?code=abc")).toBeNull();
    expect(inviteCodeOf("/dashboard")).toBeNull();
  });
});

describe("sign-in and sign-up with an invite code", () => {
  beforeAll(() => {
    process.env.SESSION_SECRET = "p78-s4-test-secret-not-a-real-one";
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const USER = { id: "u1", email: "sora@example.com", created_at: "2026-11-25T00:00:00+00:00" };
  const TENANT = { id: "t1", name: "default", slug: null, plan: "free", created_at: "2026-11-25T00:00:00+00:00" };
  const JOINED = { id: ORG, name: "Acme", slug: null, plan: "free", created_at: "2026-11-25T00:00:00+00:00" };

  function stub(status: number, body: unknown) {
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      ),
    );
  }
  function req(path: string, body: Record<string, string>, ip: string) {
    return new Request(`http://localhost:3030${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  }
  const sent = () => JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)) as Record<string, string>;

  it("forwards the code to the API, and only when the form sends one", async () => {
    stub(201, { token: "tok-1", user: USER, tenant: TENANT });
    await signupPOST(req("/api/auth/signup", { email: "sora@example.com", password: "pw-123456", invite: "c1" }, "10.7.0.1"));
    expect(sent()).toEqual({ email: "sora@example.com", password: "pw-123456", invite: "c1" });

    vi.mocked(fetch).mockClear();
    stub(200, { token: "tok-2", user: USER, tenants: [TENANT] });
    await loginPOST(req("/api/auth/login", { email: "sora@example.com", password: "pw-123456" }, "10.7.0.2"));
    expect(sent()).toEqual({ email: "sora@example.com", password: "pw-123456" });
  });

  it("a joined account starts its session in the joined org and the answer names it", async () => {
    stub(200, { token: "tok-3", user: USER, tenants: [TENANT, JOINED], joined: JOINED });
    const res = await loginPOST(
      req("/api/auth/login", { email: "sora@example.com", password: "pw-123456", invite: "c1" }, "10.7.0.3"),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, joined: "Acme" });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${ORG_COOKIE}=${ORG};`));
  });

  it("an answer that joined nothing clears the org, as every new session does", async () => {
    stub(201, { token: "tok-4", user: USER, tenant: TENANT });
    const res = await signupPOST(
      req("/api/auth/signup", { email: "sora@example.com", password: "pw-123456", invite: "c1" }, "10.7.0.4"),
    );
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${ORG_COOKIE}=;[^,]*Max-Age=0`));
  });

  it("refuses a code longer than any the API makes before calling it", async () => {
    const res = await loginPOST(
      req("/api/auth/login", { email: "a@b.co", password: "pw-123456", invite: "x".repeat(201) }, "10.7.0.5"),
    );
    expect(res.status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
});
