import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// P91-v3 — the Feedback list's two writes, server actions on the session: a state change through
// `POST /app/feedback/state {ids, state, reason?}` and an owner's delete through `POST /app/feedback/delete {ids}`.
// Each answers what the list shows: `ok` (the rows leave this state, the toast), or why not (the confirm's failed
// line, or the failed toast), from the API's status. The fetch is the seam: the bodies are the ones S1 and S2 take.

const session = vi.hoisted(() => ({ token: "t" as string | null }));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: async () => session.token,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import {
  changeFeedbackState,
  deleteFeedback,
} from "@/lib/feedback/state-actions";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const BASE = "http://kb.test:8766";

type Sent = { url: string; method: string; body: unknown; auth: string | null };

function answer(status: number, body: unknown) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      sent.push({
        url,
        method: String(init.method),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.get("authorization"),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return sent;
}

const state = (id: string, s: string, reason: string | null = null) => ({
  id,
  state: { state: s, agenda: null, reason, by: "person:o@example.com", at: "2026-11-27T01:00:00Z" },
});

beforeEach(() => {
  process.env.KB_API_BASE_URL = BASE;
  session.token = "t";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the state change", () => {
  it("posts {ids, state} for Resolve and Reopen, and answers the ids changed", async () => {
    const sent = answer(200, { states: [state(A, "resolved"), state(B, "resolved")] });
    expect(await changeFeedbackState([A, B], "resolved")).toEqual({ ok: true, ids: [A, B] });
    answer(200, { states: [state(A, "open")] });
    expect(await changeFeedbackState([A], "open")).toEqual({ ok: true, ids: [A] });
    expect(sent).toEqual([
      {
        url: `${BASE}/app/feedback/state`,
        method: "POST",
        body: { ids: [A, B], state: "resolved" },
        auth: "Bearer t",
      },
    ]);
  });

  it("sends Drop's reason trimmed, and none when it is blank", async () => {
    const sent = answer(200, { states: [state(A, "dropped", "dup")] });
    await changeFeedbackState([A], "dropped", "  dup  ");
    await changeFeedbackState([A], "dropped", "   ");
    await changeFeedbackState([A], "dropped");
    await changeFeedbackState([A], "resolved", "ignored");
    expect(sent.map((s) => s.body)).toEqual([
      { ids: [A], state: "dropped", reason: "dup" },
      { ids: [A], state: "dropped" },
      { ids: [A], state: "dropped" },
      { ids: [A], state: "resolved" },
    ]);
  });

  it("maps 404, 403, 422 and anything else to why it failed", async () => {
    answer(404, { detail: "feedback not found" });
    expect(await changeFeedbackState([A], "resolved")).toEqual({ ok: false, reason: "not-found" });
    answer(403, { detail: "not a member of that org" });
    expect(await changeFeedbackState([A], "resolved")).toEqual({ ok: false, reason: "forbidden" });
    answer(422, { detail: "reason is one line" });
    expect(await changeFeedbackState([A], "dropped", "x")).toEqual({ ok: false, reason: "refused" });
    answer(500, { detail: "boom" });
    expect(await changeFeedbackState([A], "resolved")).toEqual({ ok: false, reason: "failed" });
  });

  it("fails without a session and sends nothing", async () => {
    session.token = null;
    const sent = answer(200, { states: [] });
    expect(await changeFeedbackState([A], "resolved")).toEqual({ ok: false, reason: "failed" });
    expect(sent).toEqual([]);
  });
});

describe("the delete", () => {
  it("posts {ids} and answers the ids deleted", async () => {
    const sent = answer(200, { deleted: [A, B], files: 1 });
    expect(await deleteFeedback([A, B])).toEqual({ ok: true, ids: [A, B] });
    expect(sent).toEqual([
      {
        url: `${BASE}/app/feedback/delete`,
        method: "POST",
        body: { ids: [A, B] },
        auth: "Bearer t",
      },
    ]);
  });

  it("maps 404, a member's 403, 422 and anything else to why it failed", async () => {
    answer(404, { detail: "feedback not found" });
    expect(await deleteFeedback([A])).toEqual({ ok: false, reason: "not-found" });
    answer(403, { detail: "only an owner of this org can do that" });
    expect(await deleteFeedback([A])).toEqual({ ok: false, reason: "forbidden" });
    answer(422, { detail: "ids holds 1 to 100 ids" });
    expect(await deleteFeedback([])).toEqual({ ok: false, reason: "refused" });
    answer(502, {});
    expect(await deleteFeedback([A])).toEqual({ ok: false, reason: "failed" });
  });
});
