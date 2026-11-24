import { readdirSync, readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Core from "@/lib/send-feedback/core";
import type { FeedbackSettings } from "@/lib/send-feedback/config";

// sikstack's own feedback control: the guards of the send, on `core.ts` with injected
// headers, key, post and identity, and the env reading of `config.ts`. Each test gets
// a fresh module graph, so the in-memory limiter starts empty.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const KEY = "vk_test_capture_key";
const SETTINGS: FeedbackSettings = {
  maxChars: 20,
  ipLimit: 2,
  ipWindowS: 600,
  accountLimit: 2,
  accountWindowS: 600,
  dailyCeiling: 3,
};

let core: typeof Core;
let ApiError: typeof import("@/lib/knowledge/client").ApiError;

beforeEach(async () => {
  vi.resetModules();
  core = await import("@/lib/send-feedback/core");
  ({ ApiError } = await import("@/lib/knowledge/client"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function hdrs(values: Record<string, string> = {}): Core.HeaderReader {
  const h = new Headers({ "sec-fetch-site": "same-origin", ...values });
  return { get: (name) => h.get(name) };
}

function visitorDeps(over: Partial<Core.SendDeps> = {}) {
  const post = vi.fn(async (_body: Core.CaptureBody, _key: string) => ({
    status: "accepted",
  }));
  const log = vi.fn();
  return {
    post,
    log,
    deps: {
      headers: hdrs({ "x-real-ip": "198.51.100.7" }),
      settings: SETTINGS,
      captureKey: KEY,
      post,
      log,
      ...over,
    } satisfies Core.SendDeps,
  };
}

function accountDeps(over: Partial<Core.AccountSendDeps> = {}) {
  const post = vi.fn(async (_body: Core.CaptureBody, _key: string) => ({
    status: "accepted",
  }));
  return {
    post,
    deps: {
      headers: hdrs(),
      settings: SETTINGS,
      captureKey: KEY,
      post,
      log: vi.fn(),
      identify: async () => ({ userId: "user-1", email: "june@example.com" }),
      ...over,
    } satisfies Core.AccountSendDeps,
  };
}

describe("the visitor's guards", () => {
  it("refuses a cross-origin request before anything is counted or posted", async () => {
    const limit = vi.fn(() => ({ ok: true }));
    const refused: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site", "x-real-ip": "198.51.100.7" },
      {
        "sec-fetch-site": "",
        origin: "https://evil.example",
        host: "sikstack.com",
      },
      { "sec-fetch-site": "" },
    ];
    for (const h of refused) {
      const { deps, post } = visitorDeps({ headers: hdrs(h), limit });
      expect(
        await core.sendVisitorFeedback({ message: "hello" }, deps),
      ).toEqual({
        status: "failed",
      });
      expect(post).not.toHaveBeenCalled();
    }
    expect(limit).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot as sent, posting and counting nothing", async () => {
    const limit = vi.fn(() => ({ ok: true }));
    const { deps, post } = visitorDeps({ limit });
    expect(
      await core.sendVisitorFeedback(
        { message: "buy now", website: "spam.example" },
        deps,
      ),
    ).toEqual({ status: "sent" });
    expect(post).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("never posts or counts an empty, overlong or badly addressed message", async () => {
    const limit = vi.fn(() => ({ ok: true }));
    const { deps, post } = visitorDeps({ limit });
    const cases: [Core.VisitorInput, unknown][] = [
      [
        { message: "" },
        { status: "invalid", field: "message", reason: "empty" },
      ],
      [
        { message: "   \n " },
        { status: "invalid", field: "message", reason: "empty" },
      ],
      [
        { message: 42 },
        { status: "invalid", field: "message", reason: "empty" },
      ],
      [
        { message: "x".repeat(21) },
        { status: "invalid", field: "message", reason: "too-long" },
      ],
      [
        { message: "hi", email: "a@x.invalid, b@y.invalid" },
        { status: "invalid", field: "email", reason: "not-one" },
      ],
      [
        { message: "hi", email: "Name <a@x.invalid>" },
        { status: "invalid", field: "email", reason: "not-one" },
      ],
      [
        { message: "hi", email: "noor@example" },
        { status: "invalid", field: "email", reason: "not-one" },
      ],
    ];
    for (const [input, answer] of cases) {
      expect(await core.sendVisitorFeedback(input, deps)).toEqual(answer);
    }
    expect(post).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("counts length in code points of the trimmed message", async () => {
    const { deps, post } = visitorDeps();
    // 20 emoji are 40 UTF-16 units but 20 characters: at the cap, not past it.
    const message = `  ${"😀".repeat(20)}  `;
    expect(await core.sendVisitorFeedback({ message }, deps)).toEqual({
      status: "sent",
    });
    expect(post.mock.calls[0][0].message).toBe("😀".repeat(20));
  });

  it("refuses past the per-address limit and never posts the refused one", async () => {
    const { deps, post } = visitorDeps();
    expect(await core.sendVisitorFeedback({ message: "one" }, deps)).toEqual({
      status: "sent",
    });
    expect(await core.sendVisitorFeedback({ message: "two" }, deps)).toEqual({
      status: "sent",
    });
    expect(await core.sendVisitorFeedback({ message: "three" }, deps)).toEqual({
      status: "refused",
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keys the limit on X-Real-IP alone, whatever X-Forwarded-For says", async () => {
    const { deps, post } = visitorDeps();
    const send = (xff: string, realIp = "198.51.100.7") =>
      core.sendVisitorFeedback(
        { message: "hi" },
        {
          ...deps,
          headers: hdrs({ "x-real-ip": realIp, "x-forwarded-for": xff }),
        },
      );
    expect(await send("203.0.113.1")).toEqual({ status: "sent" });
    expect(await send("203.0.113.2")).toEqual({ status: "sent" });
    expect(await send("203.0.113.3")).toEqual({ status: "refused" });
    expect(await send("203.0.113.3", "198.51.100.8")).toEqual({
      status: "sent",
    });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("refuses for today past the site-wide ceiling, without posting", async () => {
    const { deps, post } = visitorDeps();
    const from = (ip: string) =>
      core.sendVisitorFeedback(
        { message: "hi" },
        { ...deps, headers: hdrs({ "x-real-ip": ip }) },
      );
    for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
      expect(await from(ip)).toEqual({ status: "sent" });
    }
    expect(await from("192.0.2.4")).toEqual({ status: "refused-site" });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("posts no IP address, and the reply email only when given", async () => {
    const { deps, post } = visitorDeps({
      headers: hdrs({
        "x-real-ip": "198.51.100.7",
        "x-forwarded-for": "203.0.113.9",
      }),
    });
    await core.sendVisitorFeedback(
      { message: " hello ", email: " reader@example.com " },
      deps,
    );
    await core.sendVisitorFeedback({ message: "again" }, deps);
    const [withEmail, without] = post.mock.calls.map((call) => call[0]);
    expect(withEmail).toEqual({
      message: "hello",
      source: { product: "sikstack", integration: "landing" },
      channel: "web",
      source_metadata: { reply_email: "reader@example.com" },
    });
    expect(without).not.toHaveProperty("source_metadata");
    const posted = JSON.stringify(post.mock.calls);
    expect(posted).not.toContain("198.51.100.7");
    expect(posted).not.toContain("203.0.113.9");
  });
});

describe("the signed-in guards", () => {
  it("refuses past the per-account limit", async () => {
    const { deps, post } = accountDeps();
    expect(await core.sendAccountFeedback({ message: "one" }, deps)).toEqual({
      status: "sent",
    });
    expect(await core.sendAccountFeedback({ message: "two" }, deps)).toEqual({
      status: "sent",
    });
    expect(await core.sendAccountFeedback({ message: "three" }, deps)).toEqual({
      status: "refused",
    });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("never posts or counts an empty or overlong message", async () => {
    const limit = vi.fn(() => ({ ok: true }));
    const { deps, post } = accountDeps({ limit });
    for (const [message, reason] of [
      ["", "empty"],
      ["  \n ", "empty"],
      [42, "empty"],
      ["x".repeat(21), "too-long"],
    ] as const) {
      expect(await core.sendAccountFeedback({ message }, deps)).toEqual({
        status: "invalid",
        field: "message",
        reason,
      });
    }
    expect(post).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it("takes the email and the integration from the session, never the client", async () => {
    const { deps, post } = accountDeps();
    const tampered = {
      message: "hello",
      email: "attacker@evil.example",
      source: { integration: "landing" },
      integration: "landing",
    };
    expect(await core.sendAccountFeedback(tampered, deps)).toEqual({
      status: "sent",
    });
    expect(post.mock.calls[0][0]).toEqual({
      message: "hello",
      source: { product: "sikstack", integration: "org-home" },
      channel: "web",
      user_id: "user-1",
      source_metadata: { reply_email: "june@example.com" },
    });
  });

  it("refuses a cross-origin request before the identity is asked", async () => {
    const identify = vi.fn(async () => ({ userId: "u", email: null }));
    const { deps, post } = accountDeps({
      headers: hdrs({ "sec-fetch-site": "cross-site" }),
      identify,
    });
    expect(await core.sendAccountFeedback({ message: "hi" }, deps)).toEqual({
      status: "failed",
    });
    expect(identify).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("the post", () => {
  it("maps the API's 429 to refused and anything else to failed, logging the status only", async () => {
    const answers: [unknown, string][] = [
      [new ApiError(429, "too many requests"), "refused"],
      [new ApiError(500, "storage write failed"), "failed"],
      [new TypeError("fetch failed"), "failed"],
    ];
    for (const [error, status] of answers) {
      const log = vi.fn();
      const post = vi.fn(async () => {
        throw error;
      });
      const { deps } = visitorDeps({
        post,
        log,
        headers: hdrs({ "x-real-ip": `10.0.0.${status.length}` }),
      });
      expect(
        await core.sendVisitorFeedback(
          { message: "secret words", email: "reader@example.com" },
          deps,
        ),
      ).toEqual({ status });
      const logged = JSON.stringify(log.mock.calls);
      for (const leak of ["secret words", "reader@example.com", KEY]) {
        expect(logged).not.toContain(leak);
      }
    }
  });

  it("posts nothing without a capture key", async () => {
    const { deps, post } = visitorDeps({ captureKey: null });
    expect(await core.sendVisitorFeedback({ message: "hi" }, deps)).toEqual({
      status: "failed",
    });
    const signedIn = accountDeps({ captureKey: null });
    expect(
      await core.sendAccountFeedback({ message: "hi" }, signedIn.deps),
    ).toEqual({
      status: "failed",
    });
    expect(post).not.toHaveBeenCalled();
    expect(signedIn.post).not.toHaveBeenCalled();
  });

  it("sends the key as the bearer, with no org and no address headers, even with an org cookie", async () => {
    vi.stubEnv("KB_API_BASE_URL", "http://kb.test:8766");
    const fetchMock = vi.fn(
      async (..._args: [string, RequestInit]) =>
        new Response("{}", { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // A signed-in member's request carries their active org in its cookie.
    const { cookies } = await import("next/headers");
    vi.mocked(cookies).mockResolvedValue({
      get: (name: string) =>
        name === "__Host-sikstack_org" ? { name, value: ORG } : undefined,
    } as unknown as Awaited<ReturnType<typeof cookies>>);
    const sentHeaders = (call: number) =>
      fetchMock.mock.calls[call][1].headers as Record<string, string>;
    // The cookie is live: a token call that does not override the org names it.
    const { sendJson } = await import("@/lib/knowledge/client");
    await sendJson("/probe", "POST", {}, { token: "session-token" });
    expect(sentHeaders(0)["X-Sikstack-Org"]).toBe(ORG);

    await core.postCapture(
      {
        message: "hi",
        source: { product: "sikstack", integration: "landing" },
        channel: "web",
      },
      KEY,
    );
    const [url] = fetchMock.mock.calls[1];
    expect(url).toBe("http://kb.test:8766/api/feedback");
    const sent = sentHeaders(1);
    expect(sent.Authorization).toBe(`Bearer ${KEY}`);
    const names = Object.keys(sent).map((k) => k.toLowerCase());
    expect(names).not.toContain("x-sikstack-org");
    expect(names).not.toContain("x-real-ip");
  });
});

/** A visitor's send from `ip` (no header when `null`), with its own post. */
function visit(
  ip: string | null,
  post: Core.Poster,
  settings: FeedbackSettings,
  over: Partial<Core.SendDeps> = {},
) {
  return core.sendVisitorFeedback(
    { message: "hi" },
    {
      headers: hdrs(ip === null ? {} : { "x-real-ip": ip }),
      settings,
      captureKey: KEY,
      post,
      log: vi.fn(),
      ...over,
    },
  );
}

/** A signed-in send as `userId`, with its own post. */
function asAccount(
  userId: string,
  post: Core.Poster,
  settings: FeedbackSettings,
  over: Partial<Core.AccountSendDeps> = {},
) {
  return core.sendAccountFeedback(
    { message: "hi" },
    {
      headers: hdrs(),
      settings,
      captureKey: KEY,
      post,
      log: vi.fn(),
      identify: async () => ({ userId, email: null }),
      ...over,
    },
  );
}

const ORG = "11111111-2222-4333-8444-555555555555";
const delivered = () => vi.fn(async () => ({ status: "accepted" }));
const failing = (error: unknown) =>
  vi.fn(async () => {
    throw error;
  });
/** A post that never settles and ignores its signal: only the bound ends it. */
const stalled = () => vi.fn(() => new Promise<never>(() => {}));
const later = (ms: number) =>
  vi.fn(
    () =>
      new Promise<{ status: string }>((resolve) =>
        setTimeout(() => resolve({ status: "accepted" }), ms),
      ),
  );
const WIDE: FeedbackSettings = { ...SETTINGS, ipLimit: 5, dailyCeiling: 200 };
/** Node fetch's transport failure: a `TypeError` whose `cause` carries the code. */
const transport = (code?: string) =>
  new TypeError("fetch failed", {
    cause: code ? Object.assign(new Error(code), { code }) : undefined,
  });
/** A local API stand-in; `respond` decides what each fully read post gets. */
async function localApi(respond: (res: ServerResponse) => void) {
  let stored = 0;
  let closed = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stored++;
      respond(res);
    });
  });
  server.on("connection", (socket) => socket.on("close", () => closed++));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("KB_API_BASE_URL", `http://127.0.0.1:${port}`);
  return {
    stored: () => stored,
    closed: () => closed,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
/** A port nothing listens on: taken from the system, then let go. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

describe("what a send costs: only a send surely never stored is free", () => {
  it("5 sends against a 503 leave the visitor's budget whole", async () => {
    for (let i = 0; i < 5; i++) {
      expect(
        await visit("198.51.100.7", failing(new ApiError(503, null)), WIDE),
      ).toEqual({ status: "failed" });
    }
    expect(await visit("198.51.100.7", delivered(), WIDE)).toEqual({
      status: "sent",
    });
  });

  it("200 undelivered landing sends leave the site ceiling unspent", async () => {
    for (let i = 0; i < 200; i++) {
      expect(
        await visit(`10.0.0.${i}`, failing(new ApiError(503, null)), WIDE),
      ).toEqual({ status: "failed" });
    }
    expect(await visit("192.0.2.200", delivered(), WIDE)).toEqual({
      status: "sent",
    });
  });

  it("a ceiling refusal spends no address slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const settings = { ...WIDE, ipWindowS: 172_800, dailyCeiling: 1 };
      expect(await visit("192.0.2.1", delivered(), settings)).toEqual({
        status: "sent",
      });
      for (let i = 0; i < 6; i++) {
        expect(await visit("192.0.2.2", delivered(), settings)).toEqual({
          status: "refused-site",
        });
      }
      vi.setSystemTime(Date.now() + 86_400_001);
      expect(await visit("192.0.2.2", delivered(), settings)).toEqual({
        status: "sent",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("2 sends answered 500 leave the account's budget whole; a delivered one counts once", async () => {
    for (let i = 0; i < 2; i++) {
      expect(
        await asAccount("user-1", failing(new ApiError(500, null)), SETTINGS),
      ).toEqual({ status: "failed" });
    }
    for (const answer of ["sent", "sent", "refused"]) {
      expect(await asAccount("user-1", delivered(), SETTINGS)).toEqual({
        status: answer,
      });
    }
  });

  it("every non-2xx answer is free on both paths", async () => {
    const cases: [number, string][] = [
      [401, "failed"],
      [403, "failed"],
      [413, "failed"],
      [429, "refused"],
      [500, "failed"],
      [503, "failed"],
    ];
    const tight = {
      ...SETTINGS,
      ipLimit: 1,
      accountLimit: 1,
      dailyCeiling: cases.length,
    };
    for (const [index, [status, answer]] of cases.entries()) {
      const name = String(status);
      const post = () => failing(new ApiError(status, null));
      const ip = `203.0.113.${index}`;
      expect([name, await visit(ip, post(), tight)]).toEqual([
        name,
        { status: answer },
      ]);
      expect([name, await visit(ip, delivered(), tight)]).toEqual([
        name,
        { status: "sent" },
      ]);
      const user = `user-${name}`;
      expect([name, await asAccount(user, post(), tight)]).toEqual([
        name,
        { status: answer },
      ]);
      expect([name, await asAccount(user, delivered(), tight)]).toEqual([
        name,
        { status: "sent" },
      ]);
    }
  });

  it("a transport error frees the slots only when the connection was never made", async () => {
    // [case, post, the next send's answer under a limit of 1]
    const cases: [string, () => Core.Poster, string][] = [
      // Never connected: nothing reached the API, so the slots come back.
      ...[
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].map((code): [string, () => Core.Poster, string] => [
        code,
        () => failing(transport(code)),
        "sent",
      ]),
      // Anything else may have been written and stored: the slots stay spent.
      ...["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "ETIMEDOUT", undefined].map(
        (code): [string, () => Core.Poster, string] => [
          code ?? "no cause",
          () => failing(transport(code)),
          "refused",
        ],
      ),
      ["a bare error", () => failing(new Error("boom")), "refused"],
      ["stalled", stalled, "refused"],
    ];
    const tight = {
      ...SETTINGS,
      ipLimit: 1,
      accountLimit: 1,
      dailyCeiling: 99,
    };
    const bound = { timeoutMs: 50 };
    for (const [index, [name, post, next]] of cases.entries()) {
      const ip = `203.0.113.${index}`;
      expect([name, await visit(ip, post(), tight, bound)]).toEqual([
        name,
        { status: "failed" },
      ]);
      expect([name, await visit(ip, delivered(), tight)]).toEqual([
        name,
        { status: next },
      ]);
      const user = `user-${name}`;
      expect([name, await asAccount(user, post(), tight, bound)]).toEqual([
        name,
        { status: "failed" },
      ]);
      expect([name, await asAccount(user, delivered(), tight)]).toEqual([
        name,
        { status: next },
      ]);
    }
  });

  it("a slow post inside the bound is sent and counted once", async () => {
    const bound = { timeoutMs: 400 };
    for (const answer of ["sent", "sent", "refused"]) {
      expect(await visit("198.51.100.7", later(150), SETTINGS, bound)).toEqual({
        status: answer,
      });
    }
  });

  /** The API stores the post, then answers 202 after the bound has passed. */
  const lateApi = () =>
    localApi((res) =>
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(202).end("{}");
      }, 300),
    );
  const BOUND = { timeoutMs: 100 };

  it("an answer after the bound is failed and keeps the address slot", async () => {
    const api = await lateApi();
    const tight = { ...WIDE, ipLimit: 1 };
    try {
      expect(
        await visit("198.51.100.7", core.postCapture, tight, BOUND),
      ).toEqual({ status: "failed" });
      expect(await visit("198.51.100.7", delivered(), tight)).toEqual({
        status: "refused",
      });
      expect(api.stored()).toBe(1);
    } finally {
      await api.stop();
    }
  });

  it("an answer after the bound keeps its ceiling slot spent", async () => {
    const api = await lateApi();
    const full = { ...WIDE, dailyCeiling: 1 };
    try {
      expect(await visit("192.0.2.1", core.postCapture, full, BOUND)).toEqual({
        status: "failed",
      });
      expect(await visit("192.0.2.2", delivered(), full)).toEqual({
        status: "refused-site",
      });
      expect(api.stored()).toBe(1);
    } finally {
      await api.stop();
    }
  });

  it("an answer after the bound keeps the account slot", async () => {
    const api = await lateApi();
    const tight = { ...SETTINGS, accountLimit: 1 };
    try {
      expect(await asAccount("user-1", core.postCapture, tight, BOUND)).toEqual(
        { status: "failed" },
      );
      expect(await asAccount("user-1", delivered(), tight)).toEqual({
        status: "refused",
      });
      expect(api.stored()).toBe(1);
    } finally {
      await api.stop();
    }
  });

  it("an API that accepts and never answers fails within the bound, aborting the post, and keeps the slots", async () => {
    const api = await localApi(() => {
      /* never answer */
    });
    const tight = { ...SETTINGS, ipLimit: 1, accountLimit: 1 };
    try {
      const started = Date.now();
      expect(
        await visit("198.51.100.7", core.postCapture, tight, {
          timeoutMs: 300,
        }),
      ).toEqual({ status: "failed" });
      expect(Date.now() - started).toBeLessThan(2000);
      await vi.waitFor(() => expect(api.closed()).toBe(1));
      expect(await visit("198.51.100.7", delivered(), tight)).toEqual({
        status: "refused",
      });
      expect(
        await asAccount("user-1", core.postCapture, tight, { timeoutMs: 300 }),
      ).toEqual({ status: "failed" });
      expect(await asAccount("user-1", delivered(), tight)).toEqual({
        status: "refused",
      });
    } finally {
      await api.stop();
    }
  });

  it("a connection dropped after the post was written keeps the slots", async () => {
    const api = await localApi((res) => res.socket?.destroy());
    const tight = { ...SETTINGS, ipLimit: 1, accountLimit: 1 };
    try {
      expect(await visit("198.51.100.7", core.postCapture, tight)).toEqual({
        status: "failed",
      });
      expect(await visit("198.51.100.7", delivered(), tight)).toEqual({
        status: "refused",
      });
      expect(await asAccount("user-1", core.postCapture, tight)).toEqual({
        status: "failed",
      });
      expect(await asAccount("user-1", delivered(), tight)).toEqual({
        status: "refused",
      });
      expect(api.stored()).toBe(2);
    } finally {
      await api.stop();
    }
  });

  it("a connection never made fails fast and spends no slot, on both paths", async () => {
    const port = await closedPort();
    const tight = { ...SETTINGS, ipLimit: 1, accountLimit: 1 };
    const bound = { timeoutMs: 4000 };
    // 127.0.0.1 refuses with one error; localhost may try ::1 too (an AggregateError).
    for (const host of ["127.0.0.1", "localhost"]) {
      vi.stubEnv("KB_API_BASE_URL", `http://${host}:${port}`);
      const started = Date.now();
      expect([
        host,
        await visit("198.51.100.8", core.postCapture, tight, bound),
      ]).toEqual([host, { status: "failed" }]);
      expect([
        host,
        await asAccount("user-1", core.postCapture, tight, bound),
      ]).toEqual([host, { status: "failed" }]);
      expect(Date.now() - started).toBeLessThan(2000);
    }
    expect(await visit("198.51.100.8", delivered(), tight)).toEqual({
      status: "sent",
    });
    expect(await asAccount("user-1", delivered(), tight)).toEqual({
      status: "sent",
    });
  });

  it("concurrent sends at the address limit's edge never exceed it", async () => {
    const post = later(20);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => visit("198.51.100.7", post, SETTINGS)),
    );
    expect(answers.filter((a) => a.status === "sent")).toHaveLength(2);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("concurrent sends at the site ceiling's edge never exceed it", async () => {
    const post = later(20);
    const answers = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        visit(`192.0.2.${i}`, post, SETTINGS),
      ),
    );
    expect(answers.filter((a) => a.status === "sent")).toHaveLength(3);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("concurrent sends at the account limit's edge never exceed it", async () => {
    const post = later(20);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => asAccount("user-1", post, SETTINGS)),
    );
    expect(answers.filter((a) => a.status === "sent")).toHaveLength(2);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe("the visitor bucket is a sender", () => {
  const bucket = (ip: string) => core.visitorBucket(hdrs({ "x-real-ip": ip }));

  it("six addresses of one /64 share one budget", async () => {
    const answers: string[] = [];
    for (let i = 1; i <= 6; i++) {
      answers.push(
        (await visit(`2001:db8:1:2::${i}`, delivered(), WIDE)).status,
      );
    }
    expect(answers).toEqual([
      "sent",
      "sent",
      "sent",
      "sent",
      "sent",
      "refused",
    ]);
  });

  it("two /64s are independent", async () => {
    const tight = { ...SETTINGS, ipLimit: 1 };
    for (const [ip, answer] of [
      ["2001:db8:1:2::1", "sent"],
      ["2001:db8:1:3::1", "sent"],
      ["2001:db8:1:2:ffff::9", "refused"],
    ]) {
      expect([ip, await visit(ip, delivered(), tight)]).toEqual([
        ip,
        { status: answer },
      ]);
    }
  });

  it("an IPv4-mapped address counts with its IPv4", async () => {
    const tight = { ...SETTINGS, ipLimit: 1 };
    expect(await visit("198.51.100.7", delivered(), tight)).toEqual({
      status: "sent",
    });
    expect(await visit("::ffff:198.51.100.7", delivered(), tight)).toEqual({
      status: "refused",
    });
    const v4 = `${core.IP_BUCKET}198.51.100.7`;
    expect(bucket("::FFFF:c633:6407")).toBe(v4);
    expect(bucket("0:0:0:0:0:ffff:198.51.100.7")).toBe(v4);
  });

  it("every spelling of one address shares a bucket", async () => {
    const key = `${core.IP_BUCKET}2001:db8:1:2::/64`;
    for (const spelling of [
      "2001:db8:1:2::abcd",
      "2001:DB8:1:2::ABCD",
      "2001:0db8:0001:0002:0000:0000:0000:abcd",
      "2001:db8:1:2:0:0:0:abcd",
      " 2001:db8:1:2::abcd ",
    ]) {
      expect([spelling, bucket(spelling)]).toEqual([spelling, key]);
    }
    expect(bucket("2001:db8::1")).toBe(`${core.IP_BUCKET}2001:db8:0:0::/64`);
    expect(bucket("::1")).toBe(`${core.IP_BUCKET}0:0:0:0::/64`);
    const tight = { ...SETTINGS, ipLimit: 1 };
    expect(await visit("2001:db8:1:2::abcd", delivered(), tight)).toEqual({
      status: "sent",
    });
    expect(await visit("2001:DB8:1:2::ABCD", delivered(), tight)).toEqual({
      status: "refused",
    });
  });

  it("a malformed X-Real-IP goes to the unknown bucket", async () => {
    for (const bad of [
      "not-an-ip",
      "1.2.3",
      "1.2.3.4.5",
      "256.1.1.1",
      "1.2.3.-4",
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "12345::",
      "2001:db8:g::1",
      "::ffff:1.2.3.999",
      "fe80::1%eth0",
      "[2001:db8::1]",
      ":::",
    ]) {
      expect([bad, bucket(bad)]).toEqual([bad, core.UNKNOWN_IP_BUCKET]);
    }
    const tight = { ...SETTINGS, ipLimit: 2 };
    expect(await visit("not-an-ip", delivered(), tight)).toEqual({
      status: "sent",
    });
    expect(await visit(null, delivered(), tight)).toEqual({ status: "sent" });
    expect(await visit("1.2.3.4.5", delivered(), tight)).toEqual({
      status: "refused",
    });
  });

  it("keeps IPv4 per address", () => {
    for (const ip of ["198.51.100.7", "198.51.100.8", "0.0.0.0"]) {
      expect(bucket(ip)).toBe(`${core.IP_BUCKET}${ip}`);
    }
  });
});

describe("the limiter's give-back", () => {
  it("takes a slot as checkRateLimit does, and gives that slot back once", async () => {
    const { takeRateLimit } = await import("@/lib/rate-limit");
    const first = takeRateLimit("give-back", 2, 60_000);
    const second = takeRateLimit("give-back", 2, 60_000);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(takeRateLimit("give-back", 2, 60_000).ok).toBe(false);
    second.release();
    second.release();
    expect(takeRateLimit("give-back", 2, 60_000).ok).toBe(true);
    expect(takeRateLimit("give-back", 2, 60_000).ok).toBe(false);
  });
});

describe("the config", () => {
  it("is not configured without a key, and never hands the key to a page", async () => {
    const { feedbackControl } = await import("@/lib/send-feedback/config");
    vi.stubEnv("SIKSTACK_FEEDBACK_CAPTURE_KEY", "");
    expect(feedbackControl()).toEqual({ configured: false, limit: 2000 });
    vi.stubEnv("SIKSTACK_FEEDBACK_CAPTURE_KEY", "   ");
    expect(feedbackControl().configured).toBe(false);
    vi.stubEnv("SIKSTACK_FEEDBACK_CAPTURE_KEY", KEY);
    const control = feedbackControl();
    expect(control).toEqual({ configured: true, limit: 2000 });
    expect(JSON.stringify(control)).not.toContain(KEY);
  });

  it("falls back to each default when a number is unset or not a positive integer", async () => {
    const { feedbackSettings, FEEDBACK_DEFAULTS } =
      await import("@/lib/send-feedback/config");
    const names = [
      "SIKSTACK_FEEDBACK_MAX_CHARS",
      "SIKSTACK_FEEDBACK_IP_LIMIT",
      "SIKSTACK_FEEDBACK_IP_WINDOW_S",
      "SIKSTACK_FEEDBACK_ACCOUNT_LIMIT",
      "SIKSTACK_FEEDBACK_ACCOUNT_WINDOW_S",
      "SIKSTACK_FEEDBACK_DAILY_CEILING",
    ];
    for (const bad of [
      undefined,
      "",
      "abc",
      "0",
      "-3",
      "1.5",
      "1e3",
      "12abc",
    ]) {
      for (const name of names) vi.stubEnv(name, bad);
      expect(feedbackSettings()).toEqual(FEEDBACK_DEFAULTS);
    }
    for (const name of names) vi.stubEnv(name, " 7 ");
    expect(Object.values(feedbackSettings())).toEqual([7, 7, 7, 7, 7, 7]);
  });

  it("reads the box's older HI2VI_FEEDBACK_* names when the new ones are unset", async () => {
    const { feedbackControl, feedbackSettings, readCaptureKey } =
      await import("@/lib/send-feedback/config");
    vi.stubEnv("SIKSTACK_FEEDBACK_CAPTURE_KEY", undefined);
    vi.stubEnv("HI2VI_FEEDBACK_CAPTURE_KEY", KEY);
    vi.stubEnv("SIKSTACK_FEEDBACK_MAX_CHARS", undefined);
    vi.stubEnv("HI2VI_FEEDBACK_MAX_CHARS", "900");
    expect(feedbackControl()).toEqual({ configured: true, limit: 900 });
    expect(readCaptureKey()).toBe(KEY);
    vi.stubEnv("SIKSTACK_FEEDBACK_MAX_CHARS", "1200");
    expect(feedbackSettings().maxChars).toBe(1200);
    vi.stubEnv("HI2VI_FEEDBACK_CAPTURE_KEY", undefined);
    vi.stubEnv("HI2VI_FEEDBACK_MAX_CHARS", undefined);
  });

  it("reads the key only in server-only modules", () => {
    const dir = join(__dirname, "../src/lib/send-feedback");
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      if (/SIKSTACK_FEEDBACK_CAPTURE_KEY|readCaptureKey|captureKey/.test(text)) {
        expect(
          text.startsWith('import "server-only"') ||
            text.startsWith('"use server"'),
        ).toBe(true);
      }
    }
  });
});
