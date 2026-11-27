import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackDetail, FeedbackState } from "@/lib/feedback/types";

// P91-v3 — one piece of feedback's state on its page, as signed (S3's design; f3's and f1's states): the state slot
// under the title draws the stored state (Open, Filed with its agenda item, Resolved with its item and who and when,
// Dropped with its reason), and the head's end holds the state's actions before Add to agenda, in the one order, for
// the caller's role (an owner's Delete; Reopen only from Resolved or Dropped). The scope's writes are the list's two
// server actions; Delete leaves for the list (checked in a real browser: the suite has no DOM).

const detail = vi.fn();
const role = vi.hoisted(() => ({ value: "owner" as "owner" | "member" | Error }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: async () => ({
    token: "t",
    identity: { tenant: { name: "Personal" } },
  }),
}));
vi.mock("@/lib/feedback/app", () => ({
  getFeedbackDetail: (...args: unknown[]) => detail(...args),
  getFeedbackAgenda: async () => ({ project: null, linked: false, items: [] }),
}));
vi.mock("@/lib/knowledge/app", () => ({
  listProjects: async () => [],
}));
vi.mock("@/lib/knowledge/orgs", () => ({
  getMembers: async () => {
    if (role.value instanceof Error) throw role.value;
    return { role: role.value, members: [] };
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { FeedbackItemBody } from "@/sikstack/feedback/item/body";
import { itemStateSend } from "@/sikstack/feedback/item/state";
import { OPEN } from "@/sikstack/feedback/state/model";

const ID = "0b9a6a52-2a0e-4c62-9a63-4a3c3f6d2f11";

function record(state?: FeedbackState): FeedbackDetail {
  return {
    id: ID,
    message: "Search finds the page but not the paragraph.",
    source_product: "",
    feedback_value: null,
    comment: null,
    channel: null,
    source_integration: null,
    recorded_by: null,
    conversation_id: null,
    session_id: null,
    user_id: null,
    trigger_type: null,
    trigger_message: null,
    trigger_metadata: {},
    target_type: null,
    target_id: null,
    target_role: null,
    target_text: null,
    event_at: null,
    ingested_at: "2026-11-15T01:00:00Z",
    tags: [],
    messages: [],
    used_context: [],
    source_metadata: {},
    attributes: {},
    project_id: null,
    comments: [],
    attachments: [],
    ...(state ? { state } : {}),
  };
}

const AT = "2026-11-20T03:04:00Z";
const FILED: FeedbackState = { state: "filed", agenda: "A12-k3", reason: null, by: "agent:sikstack", at: AT };
const RESOLVED: FeedbackState = { state: "resolved", agenda: "A12-k3", reason: null, by: "agent:sikstack", at: AT };
const DROPPED: FeedbackState = {
  state: "dropped",
  agenda: null,
  reason: "Answered in the release notes",
  by: "person:owner@example.com",
  at: AT,
};

async function page(state?: FeedbackState) {
  detail.mockResolvedValue(record(state));
  const node = await FeedbackItemBody({ scope: null, feedbackId: ID, from: undefined });
  return renderToStaticMarkup(node as ReactElement);
}

/** The state line's markup (`p.fi-state`), or null. */
const line = (html: string) => html.match(/<p class="[^"]*fi-state[^"]*">.*?<\/p>/)?.[0] ?? null;

/** The state's actions at the head's end, by their first word, in order. */
function acts(html: string): string[] {
  const at = html.indexOf('class="cluster fi-acts"');
  if (at < 0) return [];
  const end = html.indexOf("</div>", at);
  return [...html.slice(at, end).matchAll(/<button[^>]*>(?:<[^>]*>)*([^<]+)/g)].map((m) => m[1]);
}

beforeEach(() => {
  detail.mockReset();
  role.value = "owner";
});

describe("the state slot draws the stored state", () => {
  it("Open: its word alone (no stored row reads Open too)", async () => {
    for (const s of [undefined, OPEN]) {
      const l = line(await page(s));
      expect(l).toContain(">Open<");
      expect(l).not.toContain("dim");
    }
  });

  it("Filed: its agenda item", async () => {
    const l = line(await page(FILED));
    expect(l).toContain(">Filed<");
    expect(l).toContain('<span class="ws-id">A12-k3</span>');
  });

  it("Resolved: its agenda item, by and when", async () => {
    const l = line(await page(RESOLVED));
    expect(l).toContain(">Resolved<");
    expect(l).toContain("A12-k3");
    expect(l).toContain("sikstack");
    expect(l).toContain(`dateTime="${AT}"`);
  });

  it("Dropped: its reason", async () => {
    const l = line(await page(DROPPED));
    expect(l).toContain(">Dropped<");
    expect(l).toContain("Answered in the release notes");
    expect(l).toContain("owner@example.com");
  });

  it("sits under the title, inside the title block", async () => {
    const html = await page(FILED);
    const title = html.indexOf('<div class="page-title">');
    expect(title).toBeGreaterThan(-1);
    expect(html.indexOf("fi-state")).toBeGreaterThan(title);
    expect(html.indexOf("fi-state")).toBeLessThan(html.indexOf("fi-head-end"));
  });
});

describe("the acts follow the state and the role", () => {
  it("an owner: Delete, Drop, Resolve on Open and Filed; Delete, Reopen on Resolved and Dropped", async () => {
    expect(acts(await page())).toEqual(["Delete", "Drop", "Resolve"]);
    expect(acts(await page(FILED))).toEqual(["Delete", "Drop", "Resolve"]);
    expect(acts(await page(RESOLVED))).toEqual(["Delete", "Reopen"]);
    expect(acts(await page(DROPPED))).toEqual(["Delete", "Reopen"]);
  });

  it("a member has no Delete; a failed role read counts as a member", async () => {
    role.value = "member";
    expect(acts(await page())).toEqual(["Drop", "Resolve"]);
    expect(acts(await page(DROPPED))).toEqual(["Reopen"]);
    role.value = new Error("members read failed");
    expect(acts(await page(RESOLVED))).toEqual(["Reopen"]);
  });

  it("the acts sit in the head's end, before what Add to agenda put there", async () => {
    const html = await page();
    const end = html.indexOf('class="cluster fi-head-end"');
    expect(end).toBeGreaterThan(-1);
    expect(html.indexOf("fi-acts")).toBeGreaterThan(end);
  });
});

describe("the scope's writes", () => {
  const stored = { ...DROPPED, at: "2026-11-27T01:00:00Z" };

  it("Resolve, Drop and Reopen post the state route and answer the state it stored", async () => {
    const change = vi.fn(async () => ({ ok: true as const, ids: [ID], states: [{ id: ID, state: stored }] }));
    const remove = vi.fn();
    const send = itemStateSend(ID, { change, remove });
    expect(await send("drop", "Answered in the release notes", OPEN)).toEqual(stored);
    expect(change).toHaveBeenCalledWith([ID], "dropped", "Answered in the release notes");
    await send("resolve", undefined, OPEN);
    expect(change).toHaveBeenLastCalledWith([ID], "resolved", undefined);
    await send("reopen", undefined, stored);
    expect(change).toHaveBeenLastCalledWith([ID], "open", undefined);
    expect(remove).not.toHaveBeenCalled();
  });

  it("Delete posts the delete route and answers deleted (the page leaves for the list)", async () => {
    const remove = vi.fn(async () => ({ ok: true as const, ids: [ID] }));
    const send = itemStateSend(ID, { change: vi.fn(), remove });
    expect(await send("delete", undefined, OPEN)).toBe("deleted");
    expect(remove).toHaveBeenCalledWith([ID]);
  });

  it("a refusal throws, so the scope says it as signed", async () => {
    const no = async () => ({ ok: false as const, reason: "forbidden" as const });
    const send = itemStateSend(ID, { change: no, remove: no });
    await expect(send("delete", undefined, OPEN)).rejects.toThrow("forbidden");
    await expect(send("resolve", undefined, OPEN)).rejects.toThrow();
    const none = itemStateSend(ID, { change: async () => ({ ok: true as const, ids: [] }), remove: no });
    await expect(none("resolve", undefined, OPEN)).rejects.toThrow();
  });
});
