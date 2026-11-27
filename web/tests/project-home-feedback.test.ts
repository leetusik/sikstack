import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Feedback } from "@/lib/feedback/types";

// Project home's Feedback panel (job 01 round 03, `ProjectHomeFeedback`; D247-4x; operator D3): the
// month's count over the viewer's month, the Feedback job's Rating, each message's `lang`, the
// project-scoped addresses, and the panel's own failed form in place of the page's error.

const feedbackApp = vi.hoisted(() => ({
  listFeedbackPage: vi.fn(),
  countFeedback: vi.fn(),
  listFeedback: vi.fn(),
}));
const knowledgeApp = vi.hoisted(() => ({
  getProjectUsage: vi.fn(),
  getDocuments: vi.fn(),
  getOrgLibrary: vi.fn(),
}));
const zone = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("@/lib/feedback/app", () => feedbackApp);
vi.mock("@/lib/knowledge/app", () => knowledgeApp);
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: vi.fn(async () => ({
    token: "t",
    identity: { tenant: { id: "t1", slug: "june", name: "Personal" } },
  })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === "kb_tz" && zone.value ? { value: zone.value } : undefined,
  })),
  headers: vi.fn(async () => new Headers({ host: "sikstack.com" })),
}));
vi.mock("@/lib/workspace/read", () => ({
  readWorkspace: vi.fn(async () => ({
    state: "unlinked",
    head: { version: null, sync: { state: "unlinked", at: null } },
  })),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/(app)/projects/[projectId]/actions", () => ({
  setProjectVisibilityAction: vi.fn(),
  mintCredentialAction: vi.fn(),
  revokeCredentialAction: vi.fn(),
}));

const { default: ProjectHomePage } =
  await import("@/app/(app)/projects/[projectId]/page");
const { feedbackRows, monthWindow } =
  await import("@/app/(app)/projects/[projectId]/model");

const record = (id: string, message: string, value: 1 | 2 | null): Feedback =>
  ({
    id,
    message,
    feedback_value: value,
    ingested_at: "2026-11-15T08:00:00Z",
  }) as unknown as Feedback;

const RECORDS = [
  record("f1", "Search finds the page but not the paragraph.", 1),
  record("f2", "재생 속도를 기억해 주면 좋겠어요.", 2),
  record("f3", "On my phone the top bar runs off the screen.", null),
];

beforeEach(() => {
  vi.clearAllMocks();
  zone.value = undefined;
  knowledgeApp.getProjectUsage.mockResolvedValue({
    project: {
      id: "p1",
      name: "platform",
      created_at: "2026-03-02T00:00:00Z",
      visibility: "private",
    },
    totals: { documents_created: 1, searches: 2, documents_deleted: 0 },
    daily_counts: [],
    credentials: [],
  });
  knowledgeApp.getDocuments.mockResolvedValue({ documents: [], total: 0 });
  knowledgeApp.getOrgLibrary.mockResolvedValue({
    org: { id: "t1", slug: "june", name: "Personal", label: "june" },
    member: true,
    projects: [],
    books: [],
    documents: [],
  });
  feedbackApp.listFeedbackPage.mockResolvedValue({
    records: RECORDS,
    total: 40,
  });
  feedbackApp.countFeedback.mockResolvedValue(23);
});

async function render(): Promise<string> {
  return renderToStaticMarkup(
    await ProjectHomePage({ params: Promise.resolve({ projectId: "p1" }) }),
  );
}

/** The Feedback panel's own markup. */
function feedbackPanel(html: string): string {
  const start = html.indexOf('aria-label="Feedback"');
  expect(start).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("the month's window", () => {
  it("is the viewer's month, the first at 00:00 there to the next month's first", () => {
    // Nov 30, 20:00 UTC is already Dec 1 in Seoul.
    const now = Date.parse("2026-11-30T20:00:00Z");
    expect(monthWindow({ now, timeZone: "Asia/Seoul" })).toEqual({
      start: "2026-11-30T15:00:00.000Z",
      end: "2026-12-31T15:00:00.000Z",
    });
    expect(monthWindow({ now, timeZone: "UTC" })).toEqual({
      start: "2026-11-01T00:00:00.000Z",
      end: "2026-12-01T00:00:00.000Z",
    });
    // Behind UTC, across a DST change: Nov 1, 03:00 UTC is still Oct 31 in New York.
    expect(
      monthWindow({
        now: Date.parse("2026-11-01T03:00:00Z"),
        timeZone: "America/New_York",
      }),
    ).toEqual({
      start: "2026-10-01T04:00:00.000Z",
      end: "2026-11-01T04:00:00.000Z",
    });
  });

  it("is UTC's month while the zone is unknown", () => {
    expect(monthWindow({ now: Date.parse("2026-12-31T23:30:00Z") })).toEqual({
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });

  /** The window of the month `month` (1-based) of `year` in `timeZone`, read mid-month. */
  const windowOf = (timeZone: string, year: number, month: number) =>
    monthWindow({ now: Date.UTC(year, month - 1, 15, 12), timeZone });

  it.each([
    // Local midnight on the 1st is skipped: the clock jumps from 23:59:59 to 01:00.
    ["America/Havana", 2001, 4, "2001-04-01T05:00:00.000Z"],
    ["America/Havana", 2012, 4, "2012-04-01T05:00:00.000Z"],
    ["America/Asuncion", 2000, 10, "2000-10-01T04:00:00.000Z"],
    ["America/Asuncion", 2002, 9, "2002-09-01T04:00:00.000Z"],
    ["America/Asuncion", 2017, 10, "2017-10-01T04:00:00.000Z"],
    ["America/Asuncion", 2023, 10, "2023-10-01T04:00:00.000Z"],
    // Local midnight on the 1st happens twice (01:00 falls back to 00:00): the first one.
    ["Asia/Gaza", 2004, 10, "2004-09-30T21:00:00.000Z"],
    // 00:00 NDT on the 1st, one minute before the clock falls back to Oct 31, 23:01 NST.
    ["America/St_Johns", 2009, 11, "2009-11-01T02:30:00.000Z"],
    ["UTC", 2026, 11, "2026-11-01T00:00:00.000Z"],
    ["Asia/Seoul", 2026, 11, "2026-10-31T15:00:00.000Z"],
    ["America/New_York", 2026, 3, "2026-03-01T05:00:00.000Z"],
    ["America/New_York", 2026, 11, "2026-11-01T04:00:00.000Z"],
    ["Europe/London", 2026, 4, "2026-03-31T23:00:00.000Z"],
    ["Australia/Lord_Howe", 2026, 4, "2026-03-31T13:00:00.000Z"],
    ["Australia/Lord_Howe", 2026, 10, "2026-09-30T13:30:00.000Z"],
    ["Pacific/Kiritimati", 2026, 11, "2026-10-31T10:00:00.000Z"],
  ])(
    "starts %s %i-%i at the first instant of the 1st there",
    (zone, year, month, start) => {
      expect(windowOf(zone, year, month).start).toBe(start);
    },
  );

  // The years of the named cases above, where a zone moved its clock at or across midnight on a
  // 1st, plus a recent one. The whole 2000 to 2030 range is too slow to run always: monthWindow
  // builds its formatters per call, keeping no per-zone state on the request path. About 2 s
  // here, so a slower runner gets its own timeout.
  const SWEEP_YEARS = [2000, 2001, 2002, 2004, 2009, 2012, 2017, 2023, 2026];

  it("starts every month of the swept years at the first instant of the 1st, and ends where the next starts", { timeout: 15_000 }, () => {
    const HOUR = 3_600_000;
    const days = new Map<string, Intl.DateTimeFormat>();
    // The zone's local date at `at`, YYYY-MM-DD.
    const dateAt = (at: number, timeZone: string) => {
      let f = days.get(timeZone);
      if (!f) {
        f = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        days.set(timeZone, f);
      }
      return f.format(at);
    };
    // The local clock minus the instant, read from the date and time Intl gives.
    const clocks = new Map<string, Intl.DateTimeFormat>();
    const offsetAt = (at: number, timeZone: string) => {
      let f = clocks.get(timeZone);
      if (!f) {
        f = new Intl.DateTimeFormat("en-CA", {
          timeZone,
          hourCycle: "h23",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        clocks.set(timeZone, f);
      }
      const p = Object.fromEntries(
        f.formatToParts(at).map((x) => [x.type, x.value]),
      );
      return (
        Date.parse(
          `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`,
        ) - at
      );
    };
    // Is there an instant in [from, to) whose local date is `first`? Where the offset holds still
    // the clock only moves forward, so `to` - 1 s is the latest; otherwise minute by minute.
    const reachedBefore = (
      from: number,
      to: number,
      first: string,
      zone: string,
    ) => {
      const offsets = new Set<number>();
      for (let t = from; t < to; t += 3 * HOUR) offsets.add(offsetAt(t, zone));
      offsets.add(offsetAt(to - 1000, zone));
      if (offsets.size === 1) return dateAt(to - 1000, zone) >= first;
      for (let t = from; t < to; t += 60_000)
        if (dateAt(t, zone) === first) return true;
      return dateAt(to - 1000, zone) === first;
    };
    const ZONES = [
      "UTC",
      "Asia/Seoul",
      "America/New_York",
      "Europe/London",
      "Australia/Lord_Howe",
      "Pacific/Kiritimati",
      "America/Havana",
      "America/Asuncion",
      "Asia/Gaza",
      "Asia/Hebron",
      "America/St_Johns",
      "America/Santiago",
      "Pacific/Chatham",
      "Pacific/Apia",
      "Asia/Tehran",
      "Asia/Kathmandu",
      "America/Sao_Paulo",
      "Africa/Cairo",
      "Asia/Beirut",
      "Asia/Amman",
      "Atlantic/Azores",
      "America/Nuuk",
      "Africa/Casablanca",
      "Etc/GMT+12",
    ];
    const wrong: string[] = [];
    for (const zone of ZONES) {
      for (const year of SWEEP_YEARS) {
        for (let month = 1; month <= 12; month += 1) {
          const { start, end } = windowOf(zone, year, month);
          const at = Date.parse(start);
          const first = new Date(Date.UTC(year, month - 1, 1))
            .toISOString()
            .slice(0, 10);
          const ok =
            dateAt(at, zone) === first &&
            dateAt(at - 1, zone) < first &&
            !reachedBefore(at - 15 * HOUR, at, first, zone) &&
            end === windowOf(zone, year, month + 1).start;
          if (!ok) wrong.push(`${zone} ${year}-${month}: ${start}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("is the window the page asks the count for, in the viewer's zone, and the head shows the API's total", async () => {
    zone.value = "Asia/Seoul";
    const html = feedbackPanel(await render());
    expect(feedbackApp.countFeedback).toHaveBeenCalledTimes(1);
    const [, window] = feedbackApp.countFeedback.mock.calls[0];
    expect(window.project_id).toBe("p1");
    expect(window.start).toMatch(/T15:00:00\.000Z$/);
    expect(Date.parse(window.end)).toBeGreaterThan(Date.parse(window.start));
    expect(html).toContain('<p class="meta">23 this month</p>');
  });
});

describe("the rows", () => {
  it("read Liked, Disliked and Unrated, never a five-point score", async () => {
    const html = feedbackPanel(await render());
    expect(html).toContain('class="rating rating-liked ph-rating">Liked<');
    expect(html).toContain(
      'class="rating rating-disliked ph-rating">Disliked<',
    );
    expect(html).toContain('class="rating rating-unrated ph-rating">Unrated<');
    expect(html).not.toMatch(/\d\/5/);
  });

  it("mark a Korean message lang=ko and leave an English one the page's", () => {
    const rows = feedbackRows(RECORDS, "p1", { timeZone: "UTC" });
    expect(rows[1].lang).toBe("ko");
    expect(rows[0].lang).toBeUndefined();
  });

  it("lead to the project-scoped addresses, and so does the foot", async () => {
    const html = feedbackPanel(await render());
    expect(html).toContain('lang="ko"');
    expect(html).toContain('href="/projects/p1/feedback/f1"');
    expect(html).toContain('href="/projects/p1/feedback"');
    expect(html).not.toContain("/feedback?project=");
    expect(feedbackApp.listFeedbackPage).toHaveBeenCalledWith(
      "t",
      // every state, as before P91-v3: the API answers Open alone without `state`
      { project_id: "p1", limit: 5, state: "all" },
      1,
    );
  });
});

describe("a long message", () => {
  it("is cut at the list's two lines by its clamp, the link, its lang and its whole text kept", async () => {
    const long =
      "The search box loses what I typed when the results come back.\n\nIt looks like the page reloads the whole list.\n\nPlease keep the field as it is.";
    feedbackApp.listFeedbackPage.mockResolvedValue({
      records: [record("f9", long, 2), RECORDS[1]],
      total: 2,
    });
    const html = feedbackPanel(await render());
    const links = [
      ...html.matchAll(/<a\b([^>]*)>(<span\b[^>]*>)([^<]*)<\/span><\/a>/g),
    ].filter((m) => m[1].includes("ph-open"));
    expect(links).toHaveLength(2);
    for (const [, a, span] of links) {
      expect(a).toContain('class="link-strong ph-open ph-said"');
      expect(span).toContain('class="ph-name-text clamp-2"');
    }
    // the whole message is the link's only content, so its accessible name; the clamp only cuts the view
    expect(links[0][1]).toContain('href="/projects/p1/feedback/f9"');
    expect(links[0][2]).not.toContain("lang=");
    expect(links[0][3]).toBe(long);
    expect(links[1][1]).toContain('href="/projects/p1/feedback/f2"');
    expect(links[1][2]).toContain('lang="ko"');
    expect(links[1][3]).toBe("재생 속도를 기억해 주면 좋겠어요.");
  });
});

describe("a failed Feedback read", () => {
  it("keeps the page and shows the panel's failed form with Try again", async () => {
    feedbackApp.listFeedbackPage.mockRejectedValue(new Error("502"));
    const html = await render();
    expect(html).toContain('aria-label="Library"');
    const panel = feedbackPanel(html);
    expect(panel).toContain("Feedback did not load.");
    expect(panel).toContain("Try again");
    expect(panel).not.toContain("See all in Feedback");
  });

  it("a failed count read is the failed form too", async () => {
    feedbackApp.countFeedback.mockRejectedValue(new Error("502"));
    const panel = feedbackPanel(await render());
    expect(panel).toContain("Feedback did not load.");
    expect(panel).not.toContain("this month");
  });
});
