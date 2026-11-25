import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedbackDetail } from "@/lib/feedback/types";

// P65-nh.S6, P61-e9 — Add to agenda and the Agenda part, behind the agenda seam (job 04 round 02,
// `FeedbackItemSend*`, `FeedbackItemAgenda*`; frame.md F143, F341 to F344; operator decision 2;
// D237-we): the seam reads `GET /app/feedback/{id}/agenda` and files through `POST …/agenda {item?}`.
// The suite has no DOM: the confirm's native behaviour (showModal, focus moves) is checked in a real
// browser; here its rules are pure steps and its states static markup, driven by props.

const detail = vi.fn();
const projects = vi.fn();
const agendaRead = vi.fn();
const workspace = vi.fn();

vi.mock("@/lib/auth-guards", () => ({
  requireIdentity: async () => ({
    token: "t",
    identity: { tenant: { name: "Personal" } },
  }),
}));
vi.mock("@/lib/feedback/app", () => ({
  getFeedbackDetail: (...args: unknown[]) => detail(...args),
  getFeedbackAgenda: (...args: unknown[]) => agendaRead(...args),
}));
vi.mock("@/lib/workspace/read", () => ({
  readWorkspace: (...args: unknown[]) => workspace(...args),
}));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  getSession: async () => "t",
}));
vi.mock("@/lib/knowledge/app", () => ({
  listProjects: (...args: unknown[]) => projects(...args),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

import { ADD, AGENDA } from "@/content/feedback-agenda";
import {
  AgendaHeadEnd,
  AgendaPart,
  AgendaScope,
  AgendaSlot,
  agendaPageState,
  answer,
  ask,
  cancel,
  focusBack,
  isLocked,
  pickable,
  send,
  type AddPhase,
  type AgendaPick,
  type AgendaScopeProps,
  type PickItem,
} from "@/sikstack/feedback/agenda";
import { FeedbackItemBody } from "@/sikstack/feedback/item/body";
import {
  AGENDA_STATUS,
  agendaStatus,
  canAdd,
  itemTitle,
  sent,
  type AgendaItem,
  type AgendaStatus,
} from "@/lib/feedback/agenda";
import { fileAgendaItem } from "@/lib/feedback/agenda-actions";
import type { FeedbackAgenda } from "@/lib/feedback/types";

const ID = "0b9a6a52-2a0e-4c62-9a63-4a3c3f6d2f11";
const PROJECT = "7c1e1f7e-3f5c-4d55-8d0e-1b4b0f5f9a01";
const NO_WORKSPACE =
  "platform has no workspace linked, so it has no agenda to add this to.";
const NO_PROJECT =
  "This feedback has no project, so there is no agenda to add it to.";

function record(over: Partial<FeedbackDetail> = {}): FeedbackDetail {
  return {
    id: ID,
    message: "On my phone the top bar runs off the screen.",
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

function item(over: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: "A13-n1",
    title: "On my phone the top bar runs off the screen.",
    lang: "en",
    state: "open",
    sync: "waiting",
    href: "/agenda/A13-n1",
    ...over,
  };
}

/** `GET /app/feedback/{id}/agenda`'s answer. */
function onAgenda(
  linked: boolean,
  items: FeedbackAgenda["items"] = [],
): FeedbackAgenda {
  return { project: PROJECT, linked, items };
}

async function page(
  over: Partial<FeedbackDetail> = {},
  agenda: FeedbackAgenda = onAgenda(false),
) {
  detail.mockResolvedValue(record(over));
  agendaRead.mockResolvedValue(agenda);
  const node = await FeedbackItemBody({
    scope: null,
    feedbackId: ID,
    from: undefined,
  });
  return renderToStaticMarkup(node as ReactElement);
}

function headEnd(
  phase: AddPhase,
  filed: AgendaItem[] = [],
  pick?: AgendaPick,
  items: PickItem[] = [],
) {
  return renderToStaticMarkup(
    createElement(
      AgendaScope,
      { project: "platform", phase, filed, pick, items } as Omit<
        AgendaScopeProps,
        "children"
      > as AgendaScopeProps,
      createElement(AgendaHeadEnd),
      createElement(AgendaSlot),
    ),
  );
}

beforeEach(() => {
  detail.mockReset();
  projects.mockReset();
  agendaRead.mockReset();
  workspace.mockReset();
  projects.mockResolvedValue([{ id: PROJECT, name: "platform" }]);
  workspace.mockResolvedValue({ state: "error", status: 503 });
});

describe("the seam (decision 2, P61-e9): GET /app/feedback/{id}/agenda", () => {
  it("offers the add when the project's workspace is linked; else no project, then no workspace", () => {
    expect(canAdd({ project_id: null })).toEqual({
      offered: false,
      reason: "no-project",
    });
    expect(canAdd({ project_id: PROJECT }, "platform")).toEqual({
      offered: false,
      reason: "no-workspace",
      project: "platform",
    });
    expect(
      canAdd({ project_id: PROJECT }, "platform", onAgenda(false)),
    ).toEqual({ offered: false, reason: "no-workspace", project: "platform" });
    expect(canAdd({ project_id: PROJECT }, "platform", onAgenda(true))).toEqual(
      { offered: true, project: "platform" },
    );
    expect(canAdd({ project_id: null }, null, onAgenda(true))).toEqual({
      offered: false,
      reason: "no-project",
    });
  });

  it("reads every item the record is on, each linking to its page in the record's project", () => {
    const on = onAgenda(true, [
      {
        id: "A10-3n",
        title: "Export",
        lang: "en",
        state: "open",
        sync: "waiting",
      },
      {
        id: "A3-1z",
        title: "Uploads",
        lang: "en",
        state: "proposed",
        sync: null,
      },
    ]);
    expect(sent({ project_id: PROJECT }, on)).toEqual([
      {
        ...on.items[0],
        href: `/projects/${PROJECT}/workspace/agenda/A10-3n`,
      },
      {
        ...on.items[1],
        href: `/projects/${PROJECT}/workspace/agenda/A3-1z`,
      },
    ]);
    expect(sent({ project_id: PROJECT }, null)).toEqual([]);
    expect(sent({ project_id: null }, on)).toEqual([]);
  });

  it("reads the agenda route and keeps its three fields", async () => {
    const { getFeedbackAgenda } =
      await vi.importActual<typeof import("@/lib/feedback/app")>(
        "@/lib/feedback/app",
      );
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(
          JSON.stringify({ project: PROJECT, linked: true, items: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    try {
      expect(await getFeedbackAgenda("t", ID)).toEqual(onAgenda(true));
      expect(urls).toEqual([`http://kb.test:8766/app/feedback/${ID}/agenda`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("files on a new item with {} and on an item with {item}, then answers every item it is on", async () => {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
    const posts: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({
          url,
          method: String(init.method),
          body: init.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ item: "A14-x2", entries: [] }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    agendaRead.mockResolvedValue(
      onAgenda(true, [
        {
          id: "A14-x2",
          title: "Export",
          lang: "en",
          state: "open",
          sync: "waiting",
        },
      ]),
    );
    try {
      const filed = await fileAgendaItem(ID, { kind: "new" });
      await fileAgendaItem(ID, { kind: "item", id: "A3-1z" });
      expect(posts).toEqual([
        {
          url: `http://kb.test:8766/app/feedback/${ID}/agenda`,
          method: "POST",
          body: {},
        },
        {
          url: `http://kb.test:8766/app/feedback/${ID}/agenda`,
          method: "POST",
          body: { item: "A3-1z" },
        },
      ]);
      expect(filed).toEqual([
        {
          id: "A14-x2",
          title: "Export",
          lang: "en",
          state: "open",
          sync: "waiting",
          href: `/projects/${PROJECT}/workspace/agenda/A14-x2`,
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws when the filing is refused (the same feedback twice on one item), so the confirm says it failed", async () => {
    process.env.KB_API_BASE_URL = "http://kb.test:8766";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ detail: "this feedback is on A3-1z already" }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      await expect(
        fileAgendaItem(ID, { kind: "item", id: "A3-1z" }),
      ).rejects.toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves the web's own id minting behind: the server mints the id", async () => {
    const seam = await import("@/lib/feedback/agenda");
    expect("mintAgendaId" in seam).toBe(false);
    expect("AgendaUnavailableError" in seam).toBe(false);
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../src/lib/feedback/agenda.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/no agenda store yet/i);
  });
});

describe("itemTitle (F342)", () => {
  it("keeps a short first line whole, and takes only the first line", () => {
    expect(itemTitle("Short title.")).toBe("Short title.");
    expect(itemTitle("First line.\nSecond line.")).toBe("First line.");
    expect(itemTitle("결제가 안 돼요\n두 번째 줄")).toBe("결제가 안 돼요");
  });

  it("cuts a line over 200 at the last word before the limit, with an ellipsis", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const title = itemTitle(words);
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith("…")).toBe(true);
    const kept = title.slice(0, -1);
    expect(words.startsWith(kept + " ")).toBe(true);
    expect(itemTitle("x".repeat(200))).toBe("x".repeat(200));
    expect(itemTitle("x".repeat(201))).toBe("x".repeat(199) + "…");
  });
});

describe("the four statuses (F37, D237-we; no Deferred)", () => {
  it("reads each in the Workspace's word and shape; there is no Deferred", () => {
    const all: Record<AgendaStatus, [string, string]> = {
      open: ["Open", "idle"],
      in_progress: ["In progress", "live"],
      solved: ["Solved", "done"],
      dropped: ["Dropped", "revoked"],
    };
    for (const [state, [word, shape]] of Object.entries(all)) {
      expect(agendaStatus(state as AgendaStatus)).toEqual({ word, shape });
    }
    expect(Object.keys(AGENDA_STATUS)).toEqual(Object.keys(all));
    const html = renderToStaticMarkup(
      createElement(AgendaPart, {
        state: {
          kind: "filed",
          items: [item({ state: "solved", sync: null })],
        },
      }),
    );
    expect(html).toContain('<span class="status status-done">Solved</span>');
    expect(html).not.toContain("Deferred");
    // an item still Proposed reads Proposed, the Agenda's own mark
    const proposed = renderToStaticMarkup(
      createElement(AgendaPart, {
        state: {
          kind: "filed",
          items: [item({ state: "proposed", sync: null })],
        },
      }),
    );
    expect(proposed).toContain(
      '<span class="status status-pending">Proposed</span>',
    );
  });
});

describe("the page's state (filed, else waiting, else not offered, else the add)", () => {
  const notOffered = canAdd({ project_id: null });
  const offered = { offered: true as const, project: "platform" };

  it("puts the items before the offer, and waiting while any of them waits", () => {
    expect(agendaPageState(notOffered, [item({ sync: null })]).kind).toBe(
      "filed",
    );
    expect(agendaPageState(offered, [item({ sync: null })]).kind).toBe("filed");
    expect(agendaPageState(notOffered, [item()]).kind).toBe("waiting");
    expect(
      agendaPageState(offered, [item({ sync: null }), item({ id: "A3-1z" })])
        .kind,
    ).toBe("waiting");
    expect(agendaPageState(notOffered, [])).toEqual({
      kind: "not-offered",
      reason: "no-project",
      text: NO_PROJECT,
    });
    expect(agendaPageState(offered, [])).toEqual({
      kind: "offered",
      project: "platform",
    });
  });
});

describe("the page: the add mounted when offered, the Agenda part says why when not (F341)", () => {
  it("reads a project's record with no workspace linked as no workspace, a project-less one as no project", async () => {
    expect(AGENDA.noWorkspace("platform")).toBe(NO_WORKSPACE);
    expect(AGENDA.noProject).toBe(NO_PROJECT);
    const withProject = await page({ project_id: PROJECT }, onAgenda(false));
    expect(withProject).toContain(`<p class="block-text">${NO_WORKSPACE}</p>`);
    expect(withProject).not.toContain(NO_PROJECT);
    expect(withProject).not.toContain(ADD.action);
    const without = await page({ project_id: null });
    expect(without).toContain(`<p class="block-text">${NO_PROJECT}</p>`);
    expect(without).not.toContain("has no workspace linked");
    expect(without).not.toContain(ADD.action);
    // a record in no project reads no agenda at all
    expect(agendaRead).toHaveBeenCalledTimes(1);
  });

  it("mounts Add to agenda for a record in a linked project that is on no item yet", async () => {
    const html = await page({ project_id: PROJECT }, onAgenda(true));
    expect(html).toContain(
      '<div class="fi-send"><button type="button" class="btn btn-primary">Add to agenda</button></div>',
    );
    expect(agendaRead).toHaveBeenCalledWith("t", ID);
    expect(workspace).toHaveBeenCalledWith("t", PROJECT);
  });

  it("reads Added to agenda once the record is on an item, and offers no second add (as drawn)", async () => {
    const html = await page(
      { project_id: PROJECT },
      onAgenda(true, [
        {
          id: "A10-3n",
          title: "Export",
          lang: "en",
          state: "open",
          sync: null,
        },
        {
          id: "A3-1z",
          title: "Uploads",
          lang: "en",
          state: "open",
          sync: "waiting",
        },
      ]),
    );
    expect(html).toContain("Added to agenda");
    expect(html).not.toContain(
      '<button type="button" class="btn btn-primary">Add to agenda</button>',
    );
    expect(html).toContain(
      `href="/projects/${PROJECT}/workspace/agenda/A10-3n"`,
    );
    expect(html).toContain(
      `href="/projects/${PROJECT}/workspace/agenda/A3-1z"`,
    );
    expect(html).toContain(AGENDA.sync);
  });
});

describe("the choice: a new item, or an item not ended (as drawn)", () => {
  it("lists every item not ended, in the Agenda's order, less those that hold the feedback", () => {
    const agenda = [
      { id: "A8-sf", title: "Proposed one", lang: "en", state: "proposed" },
      { id: "A10-3n", title: "Open one", lang: "en", state: "open" },
      { id: "A2-k5", title: "Running", lang: "en", state: "in_progress" },
      { id: "A5-d2", title: "Done", lang: "en", state: "solved" },
      { id: "A6-e3", title: "Gone", lang: "en", state: "dropped" },
      { id: "A7-gg", title: "결제가 안 돼요", lang: "ko", state: "open" },
    ];
    expect(pickable(agenda, [{ id: "A10-3n" }]).map((i) => i.id)).toEqual([
      "A8-sf",
      "A2-k5",
      "A7-gg",
    ]);
    expect(pickable(agenda, []).find((i) => i.id === "A7-gg")?.lang).toBe("ko");
  });

  it("draws A new agenda checked first, then each agenda; the sentence follows the choice", () => {
    const items: PickItem[] = [
      { id: "A3-1z", title: "Uploads", lang: "en" },
      { id: "A7-gg", title: "결제가 안 돼요", lang: "ko" },
    ];
    const fresh = headEnd("confirm", [], undefined, items);
    expect(fresh).toContain('<legend class="label">Add it to</legend>');
    expect(fresh.indexOf("A new agenda")).toBeLessThan(fresh.indexOf("A3-1z"));
    expect(fresh).toMatch(
      /<input type="radio"[^>]*checked=""[^>]*\/><span>A new agenda<\/span>/,
    );
    expect(fresh).toContain(ADD.text);
    const existing = headEnd(
      "confirm",
      [],
      { kind: "item", id: "A3-1z" },
      items,
    );
    expect(existing).toContain(
      "It joins A3-1z as an item, with this message and a link back to it. You cannot undo this from here.",
    );
    expect(existing).toContain('<span lang="ko">결제가 안 돼요</span>');
  });
});

describe("the add's phases (F143)", () => {
  it("does nothing on Cancel or Escape while adding; Cancel otherwise closes", () => {
    expect(isLocked("adding")).toBe(true);
    expect(cancel("adding")).toBe("adding");
    expect(isLocked("confirm")).toBe(false);
    expect(cancel("confirm")).toBe("rest");
    expect(cancel("failed")).toBe("rest");
  });

  it("asks, adds, and answers added or failed; a failure can be sent again", () => {
    expect(ask("rest")).toBe("confirm");
    expect(send("confirm")).toBe("adding");
    expect(answer("adding", true)).toBe("added");
    expect(answer("adding", false)).toBe("failed");
    expect(send("failed")).toBe("adding");
    expect(send("adding")).toBe("adding");
  });

  it("returns focus to the button on Cancel, and to the status after an add", () => {
    const button = { name: "button" };
    const status = { name: "status" };
    expect(focusBack(null, button)).toBe(button);
    expect(focusBack(status, null)).toBe(status);
    // the status took the button's place: it wins whenever it stands
    expect(focusBack(status, button)).toBe(status);
  });
});

describe("the add's markup, every state by props", () => {
  it("at rest: the page's one primary, no confirm", () => {
    const html = headEnd("rest");
    expect(html).toBe(
      '<div class="fi-send"><button type="button" class="btn btn-primary">Add to agenda</button></div>',
    );
  });

  it("asking: the confirm's title, the choice, the text, Cancel then Add to agenda", () => {
    const html = headEnd("confirm");
    expect(html).toMatch(
      /<dialog class="dlg" aria-label="Add this feedback to platform’s agenda\?"><div class="dlg-body"><h2>Add this feedback to platform’s agenda\?<\/h2><fieldset class="field fi-pick"><legend class="label">Add it to<\/legend><div class="fi-pick-list"><label class="check fi-pick-option"><input type="radio" name="[^"]+" checked=""\/><span>A new agenda<\/span><\/label><\/div><\/fieldset><p>It becomes the first open item there, with this message and a link back to it. You cannot undo this from here.<\/p><div class="dlg-actions"><button type="button" class="btn">Cancel<\/button><button type="button" class="btn btn-primary"><span class="swap"><span>Add to agenda<\/span><span>Adding…<\/span><\/span><\/button><\/div><\/div><\/dialog>/,
    );
    expect(html).not.toContain('role="alert"');
  });

  it("adding: Cancel disabled, the primary busy with Adding… in its swap", () => {
    const html = headEnd("adding");
    expect(html).toContain(
      '<button disabled="" type="button" class="btn">Cancel</button>',
    );
    expect(html).toContain(
      '<button type="button" class="btn btn-primary" data-busy="true" aria-busy="true"><span class="swap"><span>Add to agenda</span><span>Adding…</span></span></button>',
    );
  });

  it("failed: the notice with role=alert between the title and the choice", () => {
    const html = headEnd("failed");
    expect(html).toContain(
      '</h2><p role="alert" class="notice notice-danger">Could not add this feedback to the agenda. Try again.</p><fieldset class="field fi-pick">',
    );
  });

  it("added: the head reads Added to agenda, a status that can take focus; the Agenda part shows the item waiting", () => {
    const html = headEnd("added", [item()]);
    expect(html).toContain(
      '<div class="fi-send"><p class="cluster baseline" role="status" tabindex="-1"><span class="strong">Added to agenda</span></p></div>',
    );
    expect(html).not.toContain("<button");
    expect(html).toContain(
      '<li class="row fi-item"><span class="dim">A13-n1</span><span class="fi-item-title"><a class="link-strong fi-item-open" href="/agenda/A13-n1">On my phone the top bar runs off the screen.</a><span class="badge is-waiting is-ink">Waiting for sync</span></span><span class="status status-idle">Open</span></li>',
    );
    expect(html).toContain(
      '<div class="panel-body has-rule"><p class="meta">The workspace takes this change at its next sync.</p></div>',
    );
  });

  it("filed: no waiting mark and no sync sentence; a Korean title is marked", () => {
    const html = renderToStaticMarkup(
      createElement(AgendaPart, {
        state: {
          kind: "filed",
          items: [item({ sync: null, title: "결제가 안 돼요", lang: "ko" })],
        },
      }),
    );
    expect(html).toContain('lang="ko"');
    expect(html).not.toContain("Waiting for sync");
    expect(html).not.toContain(AGENDA.sync);
  });
});
