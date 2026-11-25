import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthEmailProvider } from "@/app/(auth)/auth-email";
import { ConnectColumn } from "@/app/(auth)/connect/connect-column";
import { POST as connectPOST } from "@/app/api/auth/connect/route";
import {
  codeGroups,
  codeOfNext,
  connectPath,
  expiredView,
  isConnectNext,
  phaseAfterConnect,
  phaseAfterDecline,
  splitEmail,
  viewFromServer,
  type ConnectView,
} from "@/lib/connect/model";
import { ORG_COOKIE, SESSION_COOKIE, sealSession } from "@/lib/session";

// The connect page (job 09 *Install and connect*, `ConnectColumn.dc.html`): the API's answer
// becomes the column's state, each state renders the board's words and markup, and the BFF
// route relays Connect and Don't connect with its ordered checks.

const NOW = Date.parse("2026-11-21T01:00:00Z");
const CODE = "KQ4M-7TZP";
const INSTALL = { id: "3f2a…7f3a", version: "1.0.0", set_up: "2026-11-20T03:00:00+00:00", email: "you@example.com" };
const ORG_A = { id: "11111111-1111-4111-8111-111111111111", name: "Personal" };
const ORG_B = { id: "22222222-2222-4222-8222-222222222222", name: "Acme" };

const out = { state: "out", code: CODE, install: INSTALL, project: { name: "platform" } };
const ready = (orgs: { id: string; name: string; project?: string }[] = [ORG_A], email = "you@example.com") => ({
  state: "ready",
  code: CODE,
  install: INSTALL,
  account: { email, orgs },
  project: { name: "platform" },
});

function view(raw: unknown): ConnectView {
  return viewFromServer(raw, CODE, { timeZone: "UTC", now: NOW });
}

function render(initial: ConnectView, waitlisted: { email: string; next: string } | null = null): string {
  return renderToStaticMarkup(
    createElement(AuthEmailProvider, { initialWaitlisted: waitlisted }, createElement(ConnectColumn, { initial })),
  );
}

/** The page's visible words, tags dropped and the typographic apostrophe kept. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").replace(/ ([,.])/g, "$1").trim();
}

describe("viewFromServer: the API's answer as the column's state", () => {
  it("reads signed out, with the install's facts and the date as Nov 20", () => {
    const v = view(out);
    expect(v.phase).toBe("out");
    expect(v.install).toEqual({ id: "3f2a…7f3a", version: "1.0.0", setUp: "Nov 20", email: "you@example.com" });
    expect(v.account).toBeNull();
    expect(v.project).toEqual({ id: null, name: "platform" });
  });

  it("reads ready with the account and every org", () => {
    const v = view(ready([ORG_A, ORG_B]));
    expect(v.phase).toBe("ready");
    // An org the server named no project for reads the view's project (the first org's).
    expect(v.account).toEqual({
      email: "you@example.com",
      orgs: [
        { ...ORG_A, project: "platform" },
        { ...ORG_B, project: "platform" },
      ],
    });
  });

  it("reads each org's new project name, which a Connect there makes", () => {
    const v = view({
      ...ready([
        { ...ORG_A, project: "platform-2" },
        { ...ORG_B, project: "platform" },
      ]),
      project: { name: "platform-2" },
    });
    expect(v.account?.orgs.map((o) => o.project)).toEqual(["platform-2", "platform"]);
    expect(v.project).toEqual({ id: null, name: "platform-2" });
  });

  it("reads the outcomes the server decides", () => {
    expect(view({ state: "already", code: CODE, project: { id: "p1", name: "platform" } }).phase).toBe("already");
    expect(view({ state: "other", code: CODE }).phase).toBe("other");
    expect(view({ state: "declined", code: CODE }).phase).toBe("declined");
    expect(view({ state: "expired", code: CODE }).phase).toBe("expired");
  });

  it("reads anything malformed or half-known as expired, never a half-drawn install", () => {
    for (const raw of [
      null,
      "nope",
      { state: "connected", code: CODE },
      { state: "waitlisted", code: CODE },
      { state: "out", code: CODE, project: { name: "platform" } },
      { ...ready(), account: { email: "you@example.com", orgs: [] } },
      { state: "already", code: CODE, project: { name: "platform" } },
    ]) {
      expect(view(raw).phase).toBe("expired");
    }
  });
});

describe("the column's small rules", () => {
  it("maps a send's status to its outcome", () => {
    expect(phaseAfterConnect(200)).toBe("connected");
    expect(phaseAfterConnect(410)).toBe("expired");
    expect(phaseAfterConnect(403)).toBe("other");
    expect(phaseAfterConnect(401)).toBe("out");
    expect(phaseAfterConnect(502)).toBe("error");
    expect(phaseAfterConnect(null)).toBe("error");
    expect(phaseAfterDecline(200)).toBe("declined");
    expect(phaseAfterDecline(410)).toBe("expired");
  });

  it("splits the code after its hyphen and an email before its @", () => {
    expect(codeGroups(CODE)).toEqual(["KQ4M-", "7TZP"]);
    expect(splitEmail("you@example.com")).toEqual({ local: "you", domain: "@example.com" });
  });

  it("knows a connect page's next and the code it carries", () => {
    expect(connectPath(CODE)).toBe("/connect?code=KQ4M-7TZP");
    expect(isConnectNext("/connect?code=KQ4M-7TZP")).toBe(true);
    expect(isConnectNext("/dashboard")).toBe(false);
    expect(codeOfNext("/connect?code=kq4m-7tzp")).toBe(CODE);
    expect(codeOfNext("/dashboard")).toBe("");
  });
});

describe("ConnectColumn: each designed state, its words and markup", () => {
  it("signed out: the code first, the question, the install, then Create account and Sign in carrying this page", () => {
    const html = render(view(out));
    expect(html.indexOf("sk-code")).toBeLessThan(html.indexOf("<h1>"));
    expect(html).toContain('<span class="sk-code-group">KQ4M-</span><wbr/><span class="sk-code-group">7TZP</span>');
    expect(text(html)).toContain(
      "Check that Claude Code shows this code KQ4M- 7TZP Connect this install? Sign in to connect this install and see its work on the web.",
    );
    expect(text(html)).toContain("Install 3f2a…7f3a Plugin sikstack 1.0.0 Set up Nov 20 Setup email you @example.com");
    expect(html).not.toContain("Signed in as");
    expect(html).toContain('<a class="btn" href="/signup?next=%2Fconnect%3Fcode%3DKQ4M-7TZP">Create account</a>');
    expect(html).toContain('<a class="btn btn-primary" href="/login?next=%2Fconnect%3Fcode%3DKQ4M-7TZP">Sign in</a>');
    expect(html).not.toContain("notice");
  });

  it("ready: the sentence names the project and the org at weight 500; Don't connect, then Connect with its swap", () => {
    const html = render(view(ready()));
    expect(text(html)).toContain(
      "Connecting creates the project platform in Personal, and this install’s work shows there on the web.",
    );
    expect(html).toContain('<span class="strong">platform</span>');
    expect(html).toContain('<span class="strong">Personal</span>');
    expect(html).not.toContain("<fieldset");
    expect(html).toMatch(/<div class="sk-actions"><button type="button" class="btn">Don’t connect<\/button><button type="button" class="btn btn-primary" data-busy="false"><span class="swap"><span>Connect<\/span><span>Connecting…<\/span><\/span><\/button><\/div>/);
    expect(html).toContain('aria-busy="false"');
  });

  it("ready: the account shows once, right under Connect, with Use another account as a link-styled button", () => {
    const html = render(view(ready()));
    // The facts panel no longer carries it: the install's four rows, then the action pair.
    expect(text(html)).toContain("Install 3f2a…7f3a Plugin sikstack 1.0.0 Set up Nov 20 Setup email you @example.com Don’t connect");
    expect(text(html).match(/Signed in as/g)).toHaveLength(1);
    expect(html.indexOf("Signed in as")).toBeGreaterThan(html.indexOf('class="sk-actions"'));
    expect(text(html)).toMatch(/Connect Connecting… Signed in as you @example\.com Use another account$/);
    // The address splits before its @ as the facts rows do.
    expect(html).toContain('<span class="connect-addr strong"><span>you</span><wbr/><span>@example.com</span></span>');
    expect(html).toContain('<button type="button" class="link link-row">Use another account</button>');
    // Signed out there is no account line.
    expect(render(view(out))).not.toContain("Use another account");
  });

  it("ready with two orgs: an Org fieldset of radios, the first picked", () => {
    const html = render(view(ready([ORG_A, ORG_B])));
    expect(html).toContain('<fieldset class="field"><legend class="label">Org</legend>');
    expect(html).toContain(`<input type="radio" name="connect-org" checked="" value="${ORG_A.id}"/><span>Personal</span>`);
    expect(html).toContain(`<input type="radio" name="connect-org" value="${ORG_B.id}"/><span>Acme</span>`);
  });

  it("ready, the repo's name taken in the org: the sentence names the new project, never the taken one", () => {
    const html = render(
      view({ ...ready([{ ...ORG_A, project: "platform-2" }]), project: { name: "platform-2" } }),
    );
    expect(text(html)).toContain(
      "Connecting creates the project platform-2 in Personal, and this install’s work shows there on the web.",
    );
    expect(html).toContain('<span class="strong">platform-2</span>');
  });

  it("ready with two orgs: the sentence names the picked (first) org's own new project", () => {
    const html = render(
      view({
        ...ready([
          { ...ORG_B, project: "platform" },
          { ...ORG_A, project: "platform-2" },
        ]),
        project: { name: "platform" },
      }),
    );
    expect(text(html)).toContain("Connecting creates the project platform in Acme,");
    const swapped = render(
      view({
        ...ready([
          { ...ORG_A, project: "platform-2" },
          { ...ORG_B, project: "platform" },
        ]),
        project: { name: "platform-2" },
      }),
    );
    expect(text(swapped)).toContain("Connecting creates the project platform-2 in Personal,");
  });

  it("a different setup email: both rows, no mark", () => {
    const html = render(view(ready([ORG_A], "me@example.org")));
    expect(text(html)).toContain("Setup email you @example.com Don’t connect");
    expect(text(html)).toContain("Signed in as me @example.org Use another account");
    expect(html).not.toContain("notice");
  });

  it("waitlisted (carried from a sign-up sent from this page): the built waitlist's title, the address whole, the command", () => {
    const html = render(view(out), { email: "you@example.com", next: "/connect?code=KQ4M-7TZP" });
    expect(html).toContain('<h1 tabindex="-1">Still on the waitlist</h1>');
    expect(html).toContain('<span class="connect-addr"><span>you</span><wbr/><span>@example.com</span></span>');
    expect(text(html)).toContain(
      "Your account is still on the waitlist. We will email you @example.com when sikstack opens. Then run /sikstack:sign-in in Claude Code again.",
    );
    expect(html).toContain('<span class="cmd-inline">/sikstack:sign-in</span>');
    expect(html).not.toContain("sk-code");
    // Another code's waitlist does not carry over.
    expect(render(view(out), { email: "you@example.com", next: "/connect?code=AAAA-BBBB" })).toContain("sk-code");
  });

  it("already connected: its sentence and the way on to the project's Workspace", () => {
    const html = render(view({ state: "already", code: CODE, project: { id: "p-1", name: "platform" } }));
    expect(text(html)).toContain(
      "Already connected This install is already connected to this account. Its work shows in platform on the web. Open platform on the web",
    );
    expect(html).toContain('<p class="cluster gap-1"><a class="link link-row" href="/projects/p-1/workspace">Open platform on the web</a></p>');
  });

  it("another account: its sentence names the release command, and Sign out as a link-styled button", () => {
    const html = render(view({ state: "other", code: CODE }));
    expect(text(html)).toContain(
      "Connected to another account This install is connected to another account. To connect it to this one, run /sikstack:sign-in release in Claude Code on the install’s machine, then Connect the new code. Sign out",
    );
    expect(html).toContain('<span class="cmd-inline">/sikstack:sign-in release</span>');
    expect(html).toContain('<button type="button" class="link link-row">Sign out</button>');
  });

  it("not connected and expired: their sentences and no way on", () => {
    const declined = render(view({ state: "declined", code: CODE }));
    expect(text(declined)).toBe("Not connected Nothing changed. This install keeps working in Claude Code as before.");
    const expired = render(expiredView(CODE));
    expect(text(expired)).toBe("This code no longer works Run /sikstack:sign-in in Claude Code again.");
    expect(expired).toContain('<div class="stack gap-4"><h1 tabindex="-1">');
    expect(expired).not.toContain("link-row");
  });
});

describe("POST /api/auth/connect: the BFF's ordered checks and relay", () => {
  const TOKEN = "connect-test-token-not-real";
  beforeAll(() => {
    process.env.SESSION_SECRET = "p76-connect-test-secret-not-real";
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

  function req(body: unknown, { cookie = true, headers = {} }: { cookie?: boolean; headers?: Record<string, string> } = {}) {
    return new Request("http://localhost:3030/api/auth/connect", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${sealSession(TOKEN)}` } : {}),
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("refuses a non-JSON body, a cross-site request, no session and a bad shape before calling the API", async () => {
    expect((await connectPOST(req({}, { headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await connectPOST(req({}, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    expect((await connectPOST(req({ code: CODE, action: "approve" }, { cookie: false }))).status).toBe(401);
    expect((await connectPOST(req({ code: CODE, action: "steal" }))).status).toBe(422);
    expect((await connectPOST(req({ code: CODE, action: "approve", orgId: "not-an-org" }))).status).toBe(422);
    expect((await connectPOST(req("{"))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("relays approve with the session and the org picked, and makes that org the active one", async () => {
    stubKb(200, { state: "connected", org_id: ORG_B.id, project: { id: "p-1", name: "platform" } });
    const res = await connectPOST(req({ code: CODE, action: "approve", orgId: ORG_B.id }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, project: { id: "p-1", name: "platform" } });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://kb.test:8766/app/connect/KQ4M-7TZP/approve");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe(JSON.stringify({ org_id: ORG_B.id }));
    expect(res.headers.get("set-cookie")).toContain(`${ORG_COOKIE}=${ORG_B.id}`);
  });

  it("relays decline", async () => {
    stubKb(200, { state: "declined" });
    const res = await connectPOST(req({ code: CODE, action: "decline" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("http://kb.test:8766/app/connect/KQ4M-7TZP/decline");
  });

  it("passes the meaningful statuses through bare and turns anything else into a 502", async () => {
    for (const status of [410, 403, 401, 400]) {
      stubKb(status, { detail: "the API's words, never the browser's" });
      const res = await connectPOST(req({ code: CODE, action: "approve" }));
      expect(res.status).toBe(status);
      expect(JSON.stringify(await res.json())).not.toContain("API's words");
    }
    stubKb(500, { detail: "boom" });
    expect((await connectPOST(req({ code: CODE, action: "approve" }))).status).toBe(502);
  });
});
