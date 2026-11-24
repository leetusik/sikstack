import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/knowledge/client";
import type { FeedbackDetail } from "@/lib/feedback/types";

// P65-nh.S5 — one piece of feedback as signed (job 04 round 02, `FeedbackItem.dc.html`; frame.md F121,
// F124, F126, F132, F142): every label stays, with the dash when absent; the optional long values and
// raw JSON only with content; Tags always; operator comments oldest first; files named; Feedback not
// found for a malformed id, another org's and (in a project's route) another project's; S6's two slots
// filled as not offered (the head's end empty, the Agenda part's sentence); no old-page wrapper.

const detail = vi.fn();
const projects = vi.fn();
let zoneCookie: string | undefined;

vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: async () => ({
    token: "t",
    identity: { tenant: { name: "Personal" } },
  }),
}));
vi.mock("@/lib/feedback/app", () => ({
  getFeedbackDetail: (...args: unknown[]) => detail(...args),
  // a project's workspace not linked: the Agenda part says so, no add (P61-e9's seam)
  getFeedbackAgenda: async () => ({ project: null, linked: false, items: [] }),
}));
vi.mock("@/lib/knowledge/app", () => ({
  listProjects: (...args: unknown[]) => projects(...args),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "kb_tz" && zoneCookie !== undefined
        ? { value: zoneCookie }
        : undefined,
  }),
}));

const ID = "0b9a6a52-2a0e-4c62-9a63-4a3c3f6d2f11";
const PROJECT = "7c1e1f7e-3f5c-4d55-8d0e-1b4b0f5f9a01";
const OTHER = "9d2f6b1a-0c3e-4b7f-a1d2-5e6f7a8b9c0d";

/** A record with no optional field set. */
function bare(over: Partial<FeedbackDetail> = {}): FeedbackDetail {
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
    ...over,
  };
}

const LABELS = [
  "Project",
  "Rating",
  "Product",
  "Integration",
  "Channel",
  "Recorded by",
  "Trigger",
  "Target type",
  "Target role",
  "Conversation",
  "Session",
  "End user",
  "Happened at",
  "Captured at",
  "Record ID",
];
const DASH =
  '<span class="absent"><span aria-hidden="true">—</span><span class="sr-only">Not recorded</span></span>';

const labels = (html: string) =>
  [...html.matchAll(/<dt>([^<]*)<\/dt>/g)].map((m) => m[1]);

async function orgPage(id = ID, search: Record<string, string> = {}) {
  const { default: Page } =
    await import("@/app/(app)/feedback/[feedbackId]/page");
  const node = (await Page({
    params: Promise.resolve({ feedbackId: id }),
    searchParams: Promise.resolve(search),
  })) as ReactElement;
  return renderToStaticMarkup(await resolve(node));
}

async function projectPage(projectId: string, id = ID) {
  const { default: Page } =
    await import("@/app/(app)/projects/[projectId]/feedback/[feedbackId]/page");
  const node = (await Page({
    params: Promise.resolve({ projectId, feedbackId: id }),
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  return renderToStaticMarkup(await resolve(node));
}

/** The page returns the async body; render it on the server's terms (await its element). */
async function resolve(node: ReactElement): Promise<ReactElement> {
  const type = node.type as unknown;
  if (typeof type === "function") {
    const out = (type as (p: unknown) => unknown)(node.props);
    if (out instanceof Promise) return (await out) as ReactElement;
  }
  return node;
}

async function notFoundOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return (error as { digest?: string }).digest ?? String(error);
  }
  return "rendered";
}
const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

beforeEach(() => {
  detail.mockReset();
  projects.mockReset();
  projects.mockResolvedValue([{ id: PROJECT, name: "platform" }]);
  zoneCookie = undefined;
});

describe("Details", () => {
  it("keeps every one of the fifteen labels, in order, with the dash when absent", async () => {
    detail.mockResolvedValue(bare());
    const html = await orgPage();
    expect(labels(html)).toEqual([...LABELS, "Tags"]);
    // Project … Happened at absent (Rating is Unrated, Captured at and Record ID are set), plus Tags
    expect(html.split(DASH).length - 1).toBe(12 + 1);
  });

  it("shows Trigger message, Target text and each raw JSON block only with content", async () => {
    detail.mockResolvedValue(bare());
    const empty = await orgPage();
    for (const label of [
      "Trigger message",
      "Target text",
      "Trigger metadata",
      "Source metadata",
      "Attributes",
      "Messages",
      "Used context",
    ])
      expect(empty).not.toContain(`<dt>${label}</dt>`);

    detail.mockResolvedValue(
      bare({
        trigger_message: "Was this helpful?",
        target_text: "재생 속도 1.0×",
        trigger_metadata: { a: 1 },
        source_metadata: { b: 2 },
        attributes: { c: 3 },
        messages: [{ role: "user" }],
        used_context: [{ id: "d1" }],
        tags: ["결제", "checkout"],
      }),
    );
    const full = await orgPage();
    expect(labels(full)).toEqual([
      ...LABELS,
      "Trigger message",
      "Target text",
      "Tags",
      "Trigger metadata",
      "Source metadata",
      "Attributes",
      "Messages",
      "Used context",
    ]);
    expect(full).toContain(
      '<p class="keep-lines" lang="ko">재생 속도 1.0×</p>',
    );
    expect(full).toContain(
      '<div class="json" tabindex="0" role="region" aria-label="Attributes">',
    );
  });

  it("keeps Tags a fact always, with its tags or the dash", async () => {
    detail.mockResolvedValue(bare());
    expect(await orgPage()).toContain(
      `<div class="fact is-wide"><dt>Tags</dt><dd>${DASH}</dd></div>`,
    );
    detail.mockResolvedValue(bare({ tags: ["결제"] }));
    expect(await orgPage()).toContain(
      '<dt>Tags</dt><dd><ul class="tags"><li class="tag" lang="ko">결제</li></ul></dd>',
    );
  });

  it("says the zone once: the viewer's when known, else Times in UTC", async () => {
    detail.mockResolvedValue(bare());
    expect(await orgPage()).toContain('<p class="meta">Times in UTC</p>');
    zoneCookie = "Asia/Seoul";
    expect(await orgPage()).toContain('<p class="meta">Local time, GMT+9</p>');
  });
});

describe("Operator comments and Attachments", () => {
  it("runs comments oldest first, with Unknown author for none", async () => {
    detail.mockResolvedValue(
      bare({
        comments: [
          {
            id: "c3",
            author: "triage-agent",
            body: "Third",
            created_at: "2026-11-15T00:36:00Z",
          },
          {
            id: "c1",
            author: "june",
            body: "First",
            created_at: "2026-11-14T23:30:00Z",
          },
          {
            id: "c2",
            author: null,
            body: "Second",
            created_at: "2026-11-14T23:48:00Z",
          },
        ],
      }),
    );
    const html = await orgPage();
    const bodies = [
      ...html.matchAll(/<p class="keep-lines">(First|Second|Third)<\/p>/g),
    ].map((m) => m[1]);
    expect(bodies).toEqual(["First", "Second", "Third"]);
    expect(html).toContain('<span class="strong dim">Unknown author</span>');
    expect(html).toContain('<p class="meta">3 comments</p>');
  });

  it("names a file with no name Untitled file, and gives each download its accessible name", async () => {
    detail.mockResolvedValue(
      bare({
        attachments: [
          {
            id: "a1",
            content_type: "image/png",
            byte_size: 248112,
            filename: "search-miss.png",
            created_at: "",
            url: "",
          },
          {
            id: "a2",
            content_type: "application/json",
            byte_size: 1536,
            filename: null,
            created_at: "",
            url: "",
          },
        ],
      }),
    );
    const html = await orgPage();
    expect(html).toContain('<span class="strong dim">Untitled file</span>');
    expect(html).toContain(
      `<a class="btn btn-quiet fi-get" href="/api/app/feedback/${ID}/attachments/a1" download="search-miss.png" aria-label="Download search-miss.png">Download</a>`,
    );
    expect(html).toContain('aria-label="Download untitled file">Download</a>');
    expect(html).toContain('<p class="meta">2 files</p>');
  });
});

describe("Feedback not found", () => {
  it("answers a malformed id without asking the API", async () => {
    expect(await notFoundOf(() => orgPage("not-a-uuid"))).toBe(NOT_FOUND);
    expect(detail).not.toHaveBeenCalled();
  });

  it("answers another org's record (the API's 404) and a 400 alike", async () => {
    detail.mockRejectedValue(new ApiError(404, null));
    expect(await notFoundOf(() => orgPage())).toBe(NOT_FOUND);
    detail.mockRejectedValue(new ApiError(400, null));
    expect(await notFoundOf(() => orgPage())).toBe(NOT_FOUND);
  });

  it("answers, in a project's route, a record of another project or of none", async () => {
    detail.mockResolvedValue(bare({ project_id: PROJECT }));
    expect(await notFoundOf(() => projectPage(OTHER))).toBe(NOT_FOUND);
    expect(await projectPage(PROJECT)).toContain(
      "<h1>Feedback on platform</h1>",
    );
    detail.mockResolvedValue(bare({ project_id: null }));
    expect(await notFoundOf(() => projectPage(PROJECT))).toBe(NOT_FOUND);
    expect(await orgPage()).toContain("<h1>Feedback</h1>");
  });
});

describe("the page's frame", () => {
  it("fills S6's two slots as not offered: the head ends at its title, the Agenda part says why between Comment and Details", async () => {
    detail.mockResolvedValue(bare());
    const html = await orgPage();
    expect(html).toMatch(
      /<div class="page-head fi-head"><div class="page-title">.*?<\/p><\/div><\/div><\/header>/,
    );
    expect(html).toContain(
      'No comment.</p></div></section><section class="panel" aria-label="Agenda"><div class="panel-head"><h2>Agenda</h2></div><div class="panel-body has-rule block"><p class="block-text">This feedback has no project, so there is no agenda to add it to.</p></div></section><section class="panel" aria-label="Details">',
    );
  });

  it("has no old-page wrapper around the item, in either route", async () => {
    const app = join(__dirname, "..", "src", "app", "(app)");
    expect(
      existsSync(join(app, "feedback", "[feedbackId]", "layout.tsx")),
    ).toBe(false);
    expect(
      existsSync(
        join(
          app,
          "projects",
          "[projectId]",
          "feedback",
          "[feedbackId]",
          "layout.tsx",
        ),
      ),
    ).toBe(false);
    detail.mockResolvedValue(bare({ project_id: PROJECT }));
    for (const html of [await orgPage(), await projectPage(PROJECT)]) {
      expect(html).not.toContain("kb-legacy-page");
      expect(html).not.toContain("data-ui-legacy");
      expect(
        html.startsWith('<div class="column"><header class="page-top">'),
      ).toBe(true);
    }
  });

  it("goes back to the list it came from, laundered", async () => {
    detail.mockResolvedValue(bare());
    expect(
      await orgPage(ID, { from: "/feedback?page=2&rating=liked" }),
    ).toContain(
      '<a class="back" href="/feedback?page=2&amp;rating=liked">Feedback</a>',
    );
    expect(await orgPage(ID, { from: "//evil.example/feedback" })).toContain(
      '<a class="back" href="/feedback">Feedback</a>',
    );
  });
});
