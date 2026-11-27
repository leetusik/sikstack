import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/knowledge/client";
import type { Feedback } from "@/lib/feedback/types";

// P65-nh.S4 — the Feedback list as signed (job 04 round 02, `result.md` § The list): one list for
// `/feedback` and `/projects/{id}/feedback`; the body in the record's precedence; the count line; the
// project select and the Project column left out with a project picked; the Library's pager only with
// more than one page; No such view and Not found; Clear and a row's way back; no old-page wrapper.

const NOT_FOUND = "NEXT_HTTP_ERROR_FALLBACK;404";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useParams: () => ({}),
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.message === NOT_FOUND) throw error;
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: async () => ({
    token: "t",
    identity: { tenant: { name: "Personal" } },
  }),
}));

const api = vi.hoisted(() => ({
  projects: [] as { id: string; name: string }[] | Error,
  page: { records: [] as unknown[], total: 0 } as
    | { records: unknown[]; total: number; counts?: Record<string, number> }
    | Error,
  calls: [] as unknown[][],
  role: "owner" as "owner" | "member" | Error,
}));
vi.mock("@/lib/knowledge/orgs", () => ({
  getMembers: async () => {
    if (api.role instanceof Error) throw api.role;
    return { role: api.role, members: [] };
  },
}));
vi.mock("@/lib/knowledge/app", () => ({
  listProjects: async () => {
    if (api.projects instanceof Error) throw api.projects;
    return api.projects;
  },
}));
vi.mock("@/lib/feedback/app", () => ({
  listFeedbackPage: async (...args: unknown[]) => {
    api.calls.push(args);
    if (api.page instanceof Error) throw api.page;
    return api.page;
  },
}));

const PROJECTS = [
  { id: "p1", name: "platform" },
  { id: "p2", name: "보캐" },
];

function record(i: number, over: Partial<Feedback> = {}): Feedback {
  return {
    id: `f${i}`,
    message: `message ${i}`,
    source_product: "reader",
    feedback_value: null,
    project_id: "p1",
    ingested_at: "2026-11-15T01:00:00Z",
    ...over,
  } as Feedback;
}

beforeEach(() => {
  api.projects = PROJECTS;
  api.page = { records: [record(1)], total: 1 };
  api.calls = [];
  api.role = "owner";
});

/** The org route's own element: the shared list's body, nothing around it. */
async function orgPage() {
  const { default: Page } = await import("@/app/(app)/feedback/page");
  const { FeedbackListPage } = await import("@/sikstack/feedback/list");
  const node = (await Page({
    searchParams: Promise.resolve({}),
  })) as ReactElement;
  expect(node.type).toBe(FeedbackListPage);
  return orgBody();
}

async function projectPage(
  projectId: string,
  search: Record<string, string> = {},
) {
  const { default: Page } =
    await import("@/app/(app)/projects/[projectId]/feedback/page");
  const { FeedbackListPage } = await import("@/sikstack/feedback/list");
  const node = (await Page({
    params: Promise.resolve({ projectId }),
    searchParams: Promise.resolve(search),
  })) as ReactElement<Parameters<typeof FeedbackListPage>[0]>;
  return renderToStaticMarkup(
    (await FeedbackListPage(node.props)) as ReactElement,
  );
}

async function orgBody(search: Record<string, string> = {}) {
  const { default: Page } = await import("@/app/(app)/feedback/page");
  const { FeedbackListPage } = await import("@/sikstack/feedback/list");
  const node = (await Page({
    searchParams: Promise.resolve(search),
  })) as ReactElement<Parameters<typeof FeedbackListPage>[0]>;
  return renderToStaticMarkup(
    (await FeedbackListPage(node.props)) as ReactElement,
  );
}

describe("which body shows", () => {
  it("follows the record: failed, a request out, rows, no project, no match, none yet", async () => {
    const { listBody } = await import("@/sikstack/feedback/list/model");
    const all = {
      rows: 3,
      projects: 2,
      filtered: true,
      counts: { open: 3, filed: 0, resolved: 0, dropped: 0 },
    };
    expect(listBody({ ...all, phase: "failed" })).toBe("failed");
    expect(listBody({ ...all, phase: "searching" })).toBe("waiting");
    expect(listBody({ ...all, phase: "loading" })).toBe("waiting");
    expect(listBody({ ...all, phase: "paging" })).toBe("rows");
    expect(listBody({ ...all, phase: "ready" })).toBe("rows");
    expect(listBody({ ...all, rows: 0, projects: 0, phase: "ready" })).toBe(
      "no-projects",
    );
    expect(listBody({ ...all, rows: 0, phase: "ready" })).toBe("no-match");
    expect(
      listBody({
        ...all,
        rows: 0,
        filtered: false,
        phase: "ready",
        counts: { open: 0, filed: 0, resolved: 0, dropped: 0 },
      }),
    ).toBe("none");
  });

  it("tells no feedback, none in this state and no match apart by the counts and the filters (frs7)", async () => {
    const { listBody } = await import("@/sikstack/feedback/list/model");
    const zero = { open: 0, filed: 0, resolved: 0, dropped: 0 };
    const elsewhere = { ...zero, filed: 2, dropped: 1 };
    const empty = { phase: "ready", rows: 0, projects: 2 } as const;
    expect(listBody({ ...empty, filtered: false, counts: zero })).toBe("none");
    expect(listBody({ ...empty, filtered: false, counts: elsewhere })).toBe(
      "state-empty",
    );
    expect(listBody({ ...empty, filtered: true, counts: zero })).toBe(
      "no-match",
    );
    expect(listBody({ ...empty, filtered: true, counts: elsewhere })).toBe(
      "no-match",
    );
    api.page = { records: [], total: 0, counts: elsewhere };
    const none = await orgBody();
    expect(none).toContain("No open feedback.");
    expect(none).not.toContain("No feedback yet.");
    expect(await orgBody({ state: "resolved" })).toContain(
      "No resolved feedback.",
    );
    expect(await orgBody({ state: "dropped", q: "refund" })).toContain(
      "No dropped feedback contains “refund”.",
    );
    api.page = { records: [], total: 0, counts: zero };
    expect(await orgBody()).toContain(
      "No feedback yet. Your product sends it here with a",
    );
  });

  it("draws each body's words", async () => {
    api.page = { records: [], total: 0 };
    expect(await orgBody()).toContain(
      "No feedback yet. Your product sends it here with a",
    );
    expect(await orgBody({ q: "refund" })).toContain(
      "No open feedback contains “refund”.",
    );
    expect(await orgBody({ q: "x", rating: "liked", project: "p1" })).toContain(
      "No open feedback contains “x” with these filters.",
    );
    expect(await orgBody({ rating: "liked" })).toContain(
      "No open feedback matches this filter.",
    );
    api.projects = [];
    const none = await orgBody();
    expect(none).toContain("No projects yet. Create one on");
    expect(none).toMatch(
      /<a class="link fl-inline" href="\/dashboard">Overview<\/a>,/,
    );
    api.projects = PROJECTS;
    api.page = new ApiError(500, "boom");
    const failed = await orgBody();
    expect(failed).toContain("Feedback did not load.");
    expect(failed).toContain(">Try again</button>");
    expect(failed).toMatch(/<p class="meta" role="status"><\/p>/);
  });
});

describe("the state it reads (P91-v3)", () => {
  it("asks the API for the address's state, Open by default, and passes the counts and the caller's role", async () => {
    const { readFeedbackList } = await import("@/sikstack/feedback/list/load");
    const counts = { open: 4, filed: 1, resolved: 0, dropped: 2 };
    api.page = { records: [record(1)], total: 2, counts };
    const read = await readFeedbackList(null, { state: "dropped", q: "x" });
    expect(api.calls[0][1]).toMatchObject({ state: "dropped", q: "x" });
    expect(read).toMatchObject({
      kind: "list",
      list: { counts, role: "owner", place: { state: "dropped" } },
    });
    await readFeedbackList(null, {});
    expect(api.calls[1][1]).toMatchObject({ state: "open" });
    api.role = "member";
    expect(await readFeedbackList(null, {})).toMatchObject({
      list: { role: "member" },
    });
    api.role = new ApiError(500, "boom");
    expect(await readFeedbackList(null, {})).toMatchObject({
      list: { role: "member" },
    });
  });

  it("is No such view for a state the list does not show", async () => {
    expect(await orgBody({ state: "all" })).toContain("No such view");
  });
});

describe("the count line", () => {
  it("reads the total at rest and the matches under a search or a filter", async () => {
    api.page = { records: [record(1)], total: 230 };
    expect(await orgBody()).toContain(
      '<p class="meta" role="status">230 pieces of feedback</p>',
    );
    api.page = { records: [record(1)], total: 12 };
    expect(await orgBody({ q: "export" })).toContain(
      '<p class="meta" role="status">12 matches</p>',
    );
  });
});

describe("a project picked", () => {
  it("leaves out the project select and the Project column", async () => {
    const org = await orgBody();
    expect(org).toContain('aria-label="Project"');
    expect(org).toContain(">Project</th>");
    const project = await projectPage("p1");
    expect(project).not.toContain('aria-label="Project"');
    expect(project).not.toContain(">Project</th>");
    expect(project).toContain(">Product</th>");
    expect(api.calls.at(-1)?.[1]).toMatchObject({ project_id: "p1" });
  });

  it("is Not found for an id that is no project of the org", async () => {
    await expect(projectPage("nope")).rejects.toThrow(NOT_FOUND);
  });
});

describe("the pager", () => {
  it("is not drawn on one page", async () => {
    api.page = { records: [record(1)], total: 50 };
    expect(await orgBody()).not.toContain("Feedback pages");
  });

  it("is the Library's, named Feedback pages, its links keeping the search and filters", async () => {
    api.page = { records: [record(1)], total: 230 };
    const html = await orgBody({ q: "a", rating: "liked", page: "2" });
    expect(html).toContain('<nav class="pager" aria-label="Feedback pages">');
    expect(html).toContain("51–100 of 230");
    expect(html).toContain('href="/feedback?page=3&amp;q=a&amp;rating=liked"');
    expect(html).toContain('href="/feedback?q=a&amp;rating=liked"');
    expect(html).toMatch(/aria-current="page"[^>]*>2</);
  });

  it("marks the page asked for at once and keeps the rows while it loads", async () => {
    const { FeedbackListView } = await import("@/sikstack/feedback/list/view");
    const { AT_REST } = await import("@/lib/feedback/place");
    const { OPEN } = await import("@/sikstack/feedback/state/model");
    const html = renderToStaticMarkup(
      createElement(FeedbackListView, {
        scope: null,
        place: AT_REST,
        projects: PROJECTS,
        rows: [
          {
            id: "f1",
            value: 1,
            message: "kept",
            project: "platform",
            product: "reader",
            at: "2026-11-15T01:00:00Z",
            when: "1h ago",
            href: "/feedback/f1",
            state: OPEN,
          },
        ],
        total: 230,
        phase: "paging",
        pending: 4,
      }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("kept");
    expect(html).toMatch(/aria-current="page"[^>]*>4</);
    expect(html).toContain(
      '<p class="meta" role="status">230 pieces of feedback</p>',
    );
  });
});

describe("No such view", () => {
  it.each([
    [{ project: "elsewhere" }],
    [{ rating: "unrated" }],
    [{ page: "0" }],
    [{ page: "x" }],
  ])("is drawn for %j, with Back to Feedback at rest", async (search) => {
    const html = await orgBody(search);
    expect(html).toContain("No such view");
    expect(html).toContain(
      "That filter doesn’t match a project or a rating in Personal.",
    );
    expect(html).toContain('href="/feedback">Back to Feedback</a>');
    expect(html).not.toContain('aria-label="Feedback"');
  });

  it("is drawn for a page past the last and for the API's refusal", async () => {
    api.page = { records: [], total: 60 };
    expect(await orgBody({ page: "9" })).toContain("No such view");
    api.page = new ApiError(400, "bad page");
    expect(await orgBody({ page: "2" })).toContain("No such view");
  });

  it("goes back to the project's list with a project picked", async () => {
    const html = await projectPage("p1", { rating: "unrated" });
    expect(html).toContain('href="/projects/p1/feedback">Back to Feedback</a>');
  });
});

describe("the ways out", () => {
  it("Clear goes to page 1 with no search and no filter, only while one is set", async () => {
    expect(await orgBody()).not.toContain(">Clear<");
    const html = await orgBody({ q: "x", rating: "disliked", page: "1" });
    expect(html).toContain(
      '<a class="btn" aria-label="Clear search and filters" href="/feedback">Clear</a>',
    );
  });

  it("a row's message opens the item with the way back to this place", async () => {
    api.page = { records: [record(7, { message: "결제 오류" })], total: 1 };
    const html = await orgBody({ q: "결제" });
    expect(html).toContain(
      `href="/feedback/f7?${new URLSearchParams({ from: `/feedback?${new URLSearchParams({ q: "결제" })}` })}"`,
    );
    expect(html).toContain('lang="ko"');
    api.page = { records: [record(1)], total: 1 };
    const rest = await projectPage("p1");
    expect(rest).toContain('href="/projects/p1/feedback/f1"');
  });
});

describe("the org's list", () => {
  it("is a system page: no old-page wrapper", async () => {
    const html = await orgPage();
    expect(html).not.toContain("kb-legacy-page");
    expect(html).not.toContain("data-ui-legacy");
    expect(html).toContain("<h1>Feedback</h1>");
  });

  it("loads with the count a bar, the bar disabled and eight skeleton rows", async () => {
    const { default: Loading } = await import("@/app/(app)/feedback/loading");
    const html = renderToStaticMarkup(createElement(Loading));
    expect(html).not.toContain("kb-legacy-page");
    expect(html).toContain('<span class="sr-only">Loading…</span>');
    expect(html.match(/<tr aria-hidden="true">/g)?.length).toBe(8);
    expect(html).toMatch(
      /<button type="submit" class="btn" disabled="">Search/,
    );
  });
});

/**
 * What the list's filter bar sends with no script (before the island hydrates, or none at all): the
 * form data set a browser builds for a GET submit of the rendered markup. Named controls that are not
 * disabled, the select's selected option (else its first), and of the submit buttons only the
 * submitter; Enter submits through the form's first submit button. `typed` is what is in the field.
 */
function sent(html: string, by: string, typed?: string) {
  const form = /<form [^>]*class="filterbar"[\s\S]*?<\/form>/.exec(html)![0];
  const decode = (s: string) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const attr = (tag: string, name: string) => {
    const m = new RegExp(` ${name}="([^"]*)"`).exec(tag);
    return m ? decode(m[1]) : null;
  };
  const open = (control: string) => /^<[^>]*>/.exec(control)![0];
  const controls = [
    ...form.matchAll(
      /<input\b[^>]*>|<button\b[^>]*>[^<]*|<select\b[^>]*>[\s\S]*?<\/select>/g,
    ),
  ].map((m) => m[0]);
  const buttons = controls.filter(
    (c) => c.startsWith("<button") && attr(open(c), "type") === "submit",
  );
  const submitter =
    by === "Enter"
      ? buttons[0]
      : buttons.find((b) => b.slice(open(b).length) === by);
  if (!submitter) throw new Error(`no submit button ${by}`);
  if (attr(open(submitter), "disabled") !== null)
    throw new Error(`${by} is disabled`);
  const params = new URLSearchParams();
  for (const control of controls) {
    const tag = open(control);
    const name = attr(tag, "name");
    if (name === null || name === "" || attr(tag, "disabled") !== null)
      continue;
    if (control.startsWith("<button")) {
      if (control === submitter) params.append(name, attr(tag, "value") ?? "");
    } else if (control.startsWith("<select")) {
      const options = [...control.matchAll(/<option\b[^>]*>/g)].map(
        (m) => m[0],
      );
      const picked =
        options.find((o) => attr(o, "selected") !== null) ?? options[0];
      params.append(name, attr(picked, "value") ?? "");
    } else if (attr(tag, "type") === "search" && typed !== undefined) {
      params.append(name, typed);
    } else {
      params.append(name, attr(tag, "value") ?? "");
    }
  }
  return { action: decode(attr(open(form), "action")!), params };
}

/** The place the list reads from what the bar sent; no key is sent twice. */
async function landed(
  out: ReturnType<typeof sent>,
  scope: string | null = null,
) {
  const { readFeedbackPlace } = await import("@/lib/feedback/place");
  for (const key of out.params.keys())
    expect(out.params.getAll(key)).toHaveLength(1);
  const params = Object.fromEntries(out.params);
  return {
    action: out.action,
    params,
    place: readFeedbackPlace(params, scope),
  };
}

describe("the bar without script", () => {
  it("Search carries the pressed rating; the toggles are the only other controls named rating", async () => {
    const set = await orgBody({ q: "x", rating: "disliked" });
    const form = /<form [^>]*class="filterbar"[\s\S]*?<\/form>/.exec(set)![0];
    expect(
      [...form.matchAll(/<button\b[^>]*name="rating"[^>]*>([^<]*)/g)].map(
        (m) => [m[1], /value="(\w*)"/.exec(m[0])![1]],
      ),
    ).toEqual([
      ["Search", "disliked"],
      ["Any rating", ""],
      ["Liked", "liked"],
      ["Disliked", "disliked"],
    ]);
    expect(form).not.toMatch(/<input\b[^>]*name="rating"/);
    expect(await orgBody({ q: "x" })).toContain(
      '<button type="submit" class="btn">Search</button>',
    );
  });

  it("(a) the org's list, Disliked, the Search button: the rating and the search kept, page 1", async () => {
    const out = await landed(
      sent(await orgBody({ rating: "disliked" }), "Search", "latency"),
    );
    expect(out.action).toBe("/feedback");
    expect(out.params).toEqual({
      q: "latency",
      project: "",
      rating: "disliked",
    });
    expect(out.place).toEqual({
      page: 1,
      q: "latency",
      project: null,
      rating: "disliked",
      state: "open",
    });
  });

  it("(b) the same with Enter in the field", async () => {
    const out = await landed(
      sent(await orgBody({ rating: "disliked" }), "Enter", "latency"),
    );
    expect(out.params).toEqual({
      q: "latency",
      project: "",
      rating: "disliked",
    });
  });

  it("(c) a project's list, a rating set, Search or Enter: the rating kept, the scope the path's", async () => {
    for (const by of ["Search", "Enter"]) {
      const out = await landed(
        sent(await projectPage("p1", { rating: "liked" }), by, "latency"),
        "p1",
      );
      expect(out.action).toBe("/projects/p1/feedback");
      expect(out.params).toEqual({ q: "latency", rating: "liked" });
      expect(out.place).toEqual({
        page: 1,
        q: "latency",
        project: null,
        rating: "liked",
        state: "open",
      });
    }
  });

  it("(d) the org's list, a project and a rating set, Search: both kept", async () => {
    const out = await landed(
      sent(
        await orgBody({ project: "p1", rating: "disliked" }),
        "Search",
        "latency",
      ),
    );
    expect(out.params).toEqual({
      q: "latency",
      project: "p1",
      rating: "disliked",
    });
  });

  it("(e) a toggle sends its own rating once, the search and the project kept", async () => {
    const html = await orgBody({ q: "x", project: "p1", rating: "disliked" });
    for (const [by, rating] of [
      ["Liked", "liked"],
      ["Disliked", "disliked"],
    ] as const) {
      const out = await landed(sent(html, by));
      expect(out.params).toEqual({ q: "x", project: "p1", rating });
    }
    const project = await landed(
      sent(await projectPage("p1", { q: "x", rating: "liked" }), "Disliked"),
      "p1",
    );
    expect(project.params).toEqual({ q: "x", rating: "disliked" });
  });

  it("(f) Any rating sends no rating; a search with none set sends no rating key", async () => {
    const any = await landed(
      sent(await orgBody({ q: "x", rating: "liked" }), "Any rating"),
    );
    expect(any.params.rating ?? "").toBe("");
    expect(any.place).toEqual({
      page: 1,
      q: "x",
      project: null,
      rating: null,
      state: "open",
    });
    const none = await landed(sent(await orgBody({ q: "x" }), "Search", "y"));
    expect(none.params).toEqual({ q: "y", project: "" });
  });

  it("(h) a state other than Open rides along as a hidden field, so a search keeps it", async () => {
    const out = await landed(
      sent(await orgBody({ state: "dropped" }), "Search", "late"),
    );
    expect(out.params).toEqual({ q: "late", project: "", state: "dropped" });
    expect(out.place).toEqual({
      page: 1,
      q: "late",
      project: null,
      rating: null,
      state: "dropped",
    });
  });

  it("(g) a search or a toggle starts at page 1", async () => {
    api.page = { records: [record(1)], total: 230 };
    const html = await orgBody({ q: "a", rating: "liked", page: "2" });
    for (const by of ["Search", "Enter", "Disliked"]) {
      const out = await landed(sent(html, by, "b"));
      expect(out.params.page).toBeUndefined();
      expect(out.place).toMatchObject({ page: 1 });
    }
  });
});
