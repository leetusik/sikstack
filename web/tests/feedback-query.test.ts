import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  countFeedback,
  getFeedbackDetail,
  listFeedbackPage,
} from "@/lib/feedback/app";
import { feedbackQueryString } from "@/lib/feedback/query";

// The Feedback API's query string and the session reads it feeds.

const PROJECT = "7f1c2a9e-3b4d-4e5f-8a6b-9c0d1e2f3a4b";

describe("the Feedback query string", () => {
  it("drops blanks, trims, escapes, and keeps an empty query bare", () => {
    expect(
      feedbackQueryString({ q: "  결제 ", project_id: PROJECT, tag: "   " }),
    ).toBe(`?q=${encodeURIComponent("결제")}&project_id=${PROJECT}`);
    expect(feedbackQueryString({ feedback_value: 2, limit: 10 })).toBe(
      "?feedback_value=2&limit=10",
    );
    expect(feedbackQueryString({})).toBe("");
  });
});

describe("listFeedbackPage / countFeedback / getFeedbackDetail", () => {
  beforeAll(() => {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
  });
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("reads one numbered page and its total", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ records: [{ id: "a" }], total: 230 }),
    );
    const page = await listFeedbackPage(
      "tok",
      { project_id: PROJECT, q: "slow" },
      3,
    );
    expect(page).toEqual({
      records: [{ id: "a" }],
      total: 230,
      counts: { open: 0, filed: 0, resolved: 0, dropped: 0 },
    });
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(url.pathname).toBe("/app/feedback");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project_id: PROJECT,
      q: "slow",
      page: "3",
    });
  });

  it("counts a window with `limit: 1` and reads only the total", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ records: [{ id: "a" }], total: 42 }),
    );
    const start = "2026-11-01T00:00:00.000Z";
    const end = "2026-12-01T00:00:00.000Z";
    await expect(
      countFeedback("tok", { project_id: PROJECT, start, end }),
    ).resolves.toBe(42);
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      project_id: PROJECT,
      start_ingested_at: start,
      end_ingested_at: end,
      limit: "1",
    });
  });

  it("unwraps `{record}`", async () => {
    const record = { id: PROJECT, comments: [], attachments: [] };
    vi.mocked(fetch).mockResolvedValueOnce(json({ record }));
    await expect(getFeedbackDetail("tok", PROJECT)).resolves.toEqual(record);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
      `http://kb.test:8766/app/feedback/${PROJECT}`,
    );
  });
});
