import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard",
  redirect: vi.fn(),
}));

const { POST: forgotPOST } = await import("@/app/api/auth/forgot/route");
const { POST: resetPOST } = await import("@/app/api/auth/reset/route");
const { SignInForm } = await import("@/app/(auth)/sign-in-form");
const { ForgotForm, forgotErrorFor } = await import("@/app/(auth)/forgot/forgot-form");
const { ResetForm, resetOutcome } = await import("@/app/(auth)/reset/reset-form");
const { changeResultFor, checkPasswordChange, phaseAfterChange } = await import(
  "@/app/(app)/account/password-model"
);
const { POST: passwordPOST } = await import("@/app/api/auth/password/route");
const { SESSION_COOKIE, sealSession } = await import("@/lib/session");
const { Keys } = await import("@/sikstack/frame/keys");
const { UrlReadPanel } = await import("@/sikstack/org/url-panel");
const { FORGOT_COPY, RESET_COPY } = await import("@/content/auth");
const { KEYS } = await import("@/content/sikstack-frame");

// P78 (F10, OQ4) — the password reset through the web and the org home a member sees: the BFF's forgot and reset
// routes against a stubbed API (the same answer whatever the address, the visitor's address passed on, the API's text
// never echoed), the forms' first render and status mapping, the account page's check, and the org keys panel with no
// controls for a member. The pages and the API are proven live (the verify stack).

beforeAll(() => {
  process.env.SESSION_SECRET = "p78-s5-test-secret-not-a-real-one";
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubKb(status: number, body: unknown) {
  vi.mocked(fetch).mockImplementation(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

function req(path: string, body: unknown, ip: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3030${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": ip,
      "x-real-ip": ip,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("POST /api/auth/forgot", () => {
  it("answers the same whatever the API knows, and passes the visitor's address on", async () => {
    stubKb(202, { status: "sent" });
    const res = await forgotPOST(req("/api/auth/forgot", { email: " sora@example.com " }, "10.5.0.1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/auth/password/forgot");
    expect(JSON.parse(String(init.body))).toEqual({ email: "sora@example.com" });
    expect((init.headers as Record<string, string>)["X-Real-IP"]).toBe("10.5.0.1");
  });

  it("refuses cross-site, non-JSON and an empty address before the API", async () => {
    expect((await forgotPOST(req("/api/auth/forgot", { email: "a@b.co" }, "10.5.0.2", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect((await forgotPOST(req("/api/auth/forgot", { email: "a@b.co" }, "10.5.0.3", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await forgotPOST(req("/api/auth/forgot", { email: "  " }, "10.5.0.4"))).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes the API's limit on, and limits per IP itself", async () => {
    stubKb(429, { detail: "too many requests" });
    const limited = await forgotPOST(req("/api/auth/forgot", { email: "a@b.co" }, "10.5.0.5"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false });
    stubKb(202, { status: "sent" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await forgotPOST(req("/api/auth/forgot", { email: "a@b.co" }, "10.5.0.6"))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("POST /api/auth/reset", () => {
  it("answers ok with the account's address and sets no cookie", async () => {
    stubKb(200, { status: "reset", email: "sora@example.com" });
    const res = await resetPOST(req("/api/auth/reset", { code: "pwr_x", password: "a-new-pass" }, "10.5.1.1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "sora@example.com" });
    expect(res.headers.get("set-cookie")).toBeNull();
    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/auth/password/reset");
  });

  it("passes a refused link, a short password and the limit through bare; anything else is 502", async () => {
    for (const [status, ip] of [
      [410, "10.5.1.2"],
      [422, "10.5.1.3"],
      [429, "10.5.1.4"],
    ] as const) {
      stubKb(status, { detail: "secret detail text" });
      const res = await resetPOST(req("/api/auth/reset", { code: "pwr_x", password: "a-new-pass" }, ip));
      expect(res.status).toBe(status);
      expect(JSON.stringify(await res.json())).not.toContain("secret");
    }
    stubKb(500, { detail: "boom" });
    expect((await resetPOST(req("/api/auth/reset", { code: "pwr_x", password: "a-new-pass" }, "10.5.1.5"))).status).toBe(502);
  });
});

describe("POST /api/auth/password (the account page's change)", () => {
  const TOKEN = "0GkQ3vJ8bYd1wZs5RfN7tXcA2eLmPqU9hVjK4oIyB6M";
  const cookie = () => `${SESSION_COOKIE}=${sealSession(TOKEN)}`;

  it("hands the session's token and both passwords to the API and answers ok", async () => {
    stubKb(200, { status: "changed" });
    const res = await passwordPOST(
      req("/api/auth/password", { current: "old-pass-1", password: "new-pass-1" }, "10.5.2.1", { cookie: cookie() }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/auth/password/change");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ current: "old-pass-1", password: "new-pass-1" });
  });

  it("refuses without a session, and maps a wrong current password, a short one and the limit", async () => {
    const body = { current: "old-pass-1", password: "new-pass-1" };
    expect((await passwordPOST(req("/api/auth/password", body, "10.5.2.2"))).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    for (const [status, reason, ip] of [
      [403, "current", "10.5.2.3"],
      [422, "short", "10.5.2.4"],
      [429, "limited", "10.5.2.5"],
    ] as const) {
      stubKb(status, { detail: "secret detail text", reason: "current" });
      const res = await passwordPOST(req("/api/auth/password", body, ip, { cookie: cookie() }));
      expect(res.status).toBe(status);
      const answer = await res.json();
      expect(answer).toEqual({ ok: false, reason });
      expect(changeResultFor(res.status)).toEqual({ ok: false, reason });
    }
    expect(changeResultFor(200)).toEqual({ ok: true });
    expect(changeResultFor(null)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("the forms", () => {
  it("sign in has Forgot password?, sign up has not", () => {
    const signIn = renderToStaticMarkup(createElement(SignInForm, { screen: "sign-in" }));
    expect(signIn).toContain(`href="${FORGOT_COPY.href}"`);
    expect(text(signIn)).toContain(FORGOT_COPY.link);
    const signUp = renderToStaticMarkup(createElement(SignInForm, { screen: "sign-up" }));
    expect(text(signUp)).not.toContain(FORGOT_COPY.link);
  });

  it("forgot opens on Email and Send link", () => {
    const html = text(renderToStaticMarkup(createElement(ForgotForm)));
    expect(html).toContain(FORGOT_COPY.title);
    expect(html).toContain(FORGOT_COPY.submit);
    expect(forgotErrorFor(429)).toBe("limited");
    expect(forgotErrorFor(422)).toBe("invalid");
    expect(forgotErrorFor(null)).toBe("failed");
  });

  it("reset opens on the form for a working link and on the refused state otherwise", () => {
    const form = text(renderToStaticMarkup(createElement(ResetForm, { code: "pwr_x", initial: "form" })));
    expect(form).toContain(RESET_COPY.label);
    const refused = renderToStaticMarkup(createElement(ResetForm, { code: "", initial: "refused" }));
    expect(text(refused)).toContain(RESET_COPY.refusedTitle);
    expect(refused).toContain(`href="${FORGOT_COPY.href}"`);
    expect(resetOutcome(410)).toBe("refused");
    expect(resetOutcome(422)).toBe("invalid");
    expect(resetOutcome(429)).toBe("limited");
  });

  it("the account page's change checks before it sends and maps the answer", () => {
    expect(checkPasswordChange("", "long-enough")).toBe("current");
    expect(checkPasswordChange("old-pass", "short")).toBe("short");
    expect(checkPasswordChange("old-pass", "long-enough")).toBeNull();
    expect(phaseAfterChange({ ok: true })).toBe("rest");
    expect(phaseAfterChange({ ok: false, reason: "current" })).toBe("current");
  });
});

describe("the org home a member sees", () => {
  const rows = [
    {
      id: "k1",
      name: "ci",
      prefix: "vk_abcdefgh",
      access: "full" as const,
      status: "active" as const,
      created: "2026-11-20T00:00:00Z",
      lastUsed: null,
    },
  ];
  const noop = async () => ({ ok: false as const, reason: "failed" as const });

  it("the org keys list without New key or Revoke", () => {
    const props = { scope: "org" as const, subject: "Acme", rows, mint: noop, revoke: async () => ({ ok: false }) };
    const owner = text(renderToStaticMarkup(createElement(Keys, props)));
    expect(owner).toContain(KEYS.newKey);
    expect(owner).toContain(KEYS.revoke);
    const member = text(renderToStaticMarkup(createElement(Keys, { ...props, readOnly: true })));
    expect(member).not.toContain(KEYS.newKey);
    expect(member).not.toContain(KEYS.revoke);
    expect(member).toContain("ci");
  });

  it("the Public URL's address without Change or a form", () => {
    const html = renderToStaticMarkup(createElement(UrlReadPanel, { slug: "acme" }));
    expect(html).not.toContain("<form");
    expect(text(html)).not.toContain("Change");
    expect(text(html)).toContain("acme");
  });
});
