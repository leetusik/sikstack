import { readFileSync } from "node:fs";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  andList,
  dates,
  everyPhaseDone,
  itemEnd,
  itemState,
  langOf,
  phaseLookup,
  staleNotes,
  todayIn,
  versionLabel,
} from "@/lib/workspace/model";
import {
  readDoc,
  readFoldedJob,
  readItem,
  readPhase,
  readSlice,
  readWorkspace,
} from "@/lib/workspace/read";
import type { AgendaItem, PhaseRow, Workspace } from "@/lib/workspace/types";

// The Workspace's reads and shared models. Reads go through the BFF's client with the session
// (a stubbed fetch stands in for the API, answering the read model's own expected shapes, the
// server suite's fixture); each read is one request and answers a state a page draws. The models
// are what more than one page derives: an item's state and end cell, a stale doc's notes, and F2's
// dates in the viewer's zone.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const TOKEN = "session-token";

/** The read model's expected shapes (the server suite's fixture). */
const EXPECTED = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/workspace/expected.json", import.meta.url),
    "utf8",
  ),
) as Record<string, Record<string, unknown>>;

const HEAD = {
  version: "97",
  sync: { state: "fresh", at: "2026-11-18T08:40:00Z" },
};
const WORKSPACE = {
  project: PROJECT,
  linked: true,
  ...HEAD,
  ...EXPECTED.workspace,
} as unknown as Workspace;

interface Call {
  url: string;
  init: RequestInit;
}

function api(
  answer: (url: string) => { status: number; body: unknown },
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { status, body } = answer(url);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

beforeAll(() => {
  process.env.KB_API_BASE_URL = "http://kb.test:8766";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading the Workspace", () => {
  it("reads the lists in one request, with the session", async () => {
    const calls = api(() => ({ status: 200, body: WORKSPACE }));
    const read = await readWorkspace(TOKEN, PROJECT);
    expect(read.state).toBe("ready");
    if (read.state !== "ready") return;
    expect(read.value.agenda.map((i) => i.id)).toEqual(["A2-k5", "A1-h7"]);
    // each slice it names comes with its stored name and status (none stored: null)
    expect(read.value.pointer.sliceRef?.name).toBe("재시도 버튼을 화면에 연결");
    expect(read.value.pointer.nextRef).toEqual({
      id: "S3",
      full: "P8-q4.S3",
      name: null,
      status: null,
    });
    expect(read.value.phases[0].currentRef?.status).toBe("pending");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `http://kb.test:8766/app/projects/${PROJECT}/workspace`,
    );
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.cache).toBe("no-store");
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("reads an unlinked project and one never synced as their states", async () => {
    api(() => ({
      status: 200,
      body: {
        project: PROJECT,
        linked: false,
        version: null,
        sync: { state: "unlinked", at: null },
      },
    }));
    expect(await readWorkspace(TOKEN, PROJECT)).toEqual({
      state: "unlinked",
      head: { version: null, sync: { state: "unlinked", at: null } },
    });
    api(() => ({
      status: 200,
      body: { ...WORKSPACE, version: null, sync: { state: "never", at: null } },
    }));
    expect((await readWorkspace(TOKEN, PROJECT)).state).toBe("never");
  });

  it("answers a 404 as not found and a 503 as an error", async () => {
    api(() => ({ status: 404, body: { detail: "project not found" } }));
    expect(await readWorkspace(TOKEN, PROJECT)).toEqual({ state: "not-found" });
    api(() => ({
      status: 503,
      body: { detail: "the workspace store is unavailable" },
    }));
    expect(await readWorkspace(TOKEN, PROJECT)).toEqual({
      state: "error",
      status: 503,
    });
    expect(await readPhase(TOKEN, PROJECT, "P8-q4")).toEqual({
      state: "error",
      status: 503,
    });
    api(() => ({ status: 404, body: { detail: "agenda item not found" } }));
    expect(await readItem(TOKEN, PROJECT, "A9-zz")).toEqual({
      state: "not-found",
    });
  });

  it("throws a 401, the session's, for the guard", async () => {
    api(() => ({ status: 401, body: { detail: "not signed in" } }));
    await expect(readWorkspace(TOKEN, PROJECT)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("reads each item from its own route, in one request with the sync facts", async () => {
    const records: Record<string, unknown> = {
      [`/workspace/phases/P8-q4`]: EXPECTED.phase,
      [`/workspace/slices/P8-q4.S1`]: EXPECTED.slice,
      [`/workspace/docs/product?version=v0001`]: EXPECTED.doc_v0001,
      [`/workspace/agenda/A2-k5`]: EXPECTED.item,
    };
    const calls = api((url) => {
      const key = Object.keys(records).find((k) => url.endsWith(k));
      return key
        ? {
            status: 200,
            body: { ...(records[key] as object), workspace: HEAD },
          }
        : { status: 404, body: { detail: "not found" } };
    });
    const reads = [
      await readPhase(TOKEN, PROJECT, "P8-q4"),
      await readSlice(TOKEN, PROJECT, "P8-q4.S1"),
      await readDoc(TOKEN, PROJECT, "product", "v0001"),
      await readItem(TOKEN, PROJECT, "A2-k5"),
    ];
    expect(calls).toHaveLength(4);
    for (const read of reads) {
      expect(read.state).toBe("ready");
      if (read.state === "ready") expect(read.value.workspace).toEqual(HEAD);
    }
    const doc = reads[2];
    if (doc.state === "ready" && "ordinal" in doc.value) {
      expect(versionLabel(doc.value.ordinal)).toBe("v1");
    }
  });

  it("reads an old deferred job's address through the folded-job lookup: its item, or not found", async () => {
    const calls = api((url) =>
      url.endsWith("/workspace/deferred/D31-x9")
        ? { status: 200, body: { agenda: "A2-k5" } }
        : {
            status: 404,
            body: { detail: "D77-zz names no deferred job", agenda: null },
          },
    );
    expect(await readFoldedJob(TOKEN, PROJECT, "D31-x9")).toEqual({
      state: "ready",
      value: { agenda: "A2-k5" },
    });
    expect(await readFoldedJob(TOKEN, PROJECT, "D77-zz")).toEqual({
      state: "not-found",
    });
    expect(calls.map((c) => c.url)).toEqual([
      `http://kb.test:8766/app/projects/${PROJECT}/workspace/deferred/D31-x9`,
      `http://kb.test:8766/app/projects/${PROJECT}/workspace/deferred/D77-zz`,
    ]);
  });

  it("escapes an id from the address into its one path segment", async () => {
    const calls = api(() => ({
      status: 404,
      body: { detail: "phase not found" },
    }));
    await readPhase(TOKEN, PROJECT, "../../keys");
    await readDoc(TOKEN, PROJECT, "product", "v1&x=y");
    expect(calls[0].url).toBe(
      `http://kb.test:8766/app/projects/${PROJECT}/workspace/phases/..%2F..%2Fkeys`,
    );
    expect(calls[1].url).toBe(
      `http://kb.test:8766/app/projects/${PROJECT}/workspace/docs/product?version=v1%26x%3Dy`,
    );
  });
});

/** Phases as the Workspace lists them, a few fields each. */
function phases(
  ...rows: [string, string][]
): Pick<PhaseRow, "id" | "short" | "status">[] {
  return rows.map(([id, status]) => ({ id, short: id.split("-")[0], status }));
}

function item(patch: Partial<AgendaItem>): AgendaItem {
  return {
    id: "A2-k5",
    title: "Uploads that fail",
    lang: "en",
    note: "Seen twice last week.",
    state: "open",
    created: "2026-11-09",
    changed: "2026-11-11",
    phases: [],
    outcome: "",
    reason: "",
    sync: null,
    ...patch,
  };
}

describe("an agenda item's state and end cell", () => {
  const lookup = phaseLookup(
    phases(
      ["P8-q4", "in_progress"],
      ["P7-m3", "done"],
      ["P6-b2", "done"],
      ["P5-c9", "planned"],
    ),
  );

  it("keeps the item's own states, deferred over a running phase", () => {
    expect(
      itemState(item({ state: "deferred", phases: ["P8-q4"] }), lookup),
    ).toBe("deferred");
    expect(
      itemState(item({ state: "solved", phases: ["P8-q4"] }), lookup),
    ).toBe("solved");
    expect(itemState(item({ state: "dropped" }), lookup)).toBe("dropped");
  });

  it("reads In progress while a phase it holds is not done, else Open", () => {
    expect(itemState(item({ phases: ["P7-m3", "P8-q4"] }), lookup)).toBe(
      "in_progress",
    );
    expect(itemState(item({ phases: ["P5-c9"] }), lookup)).toBe("in_progress");
    expect(itemState(item({ phases: ["P7-m3", "P6-b2"] }), lookup)).toBe(
      "open",
    );
    expect(itemState(item({ phases: ["P99-zz"] }), lookup)).toBe("open");
    expect(itemState(item({ state: "in_progress", phases: ["P8-q4"] }))).toBe(
      "in_progress",
    );
  });

  it("says how far its phases are", () => {
    expect(
      itemEnd(item({ phases: ["P7-m3", "P8-q4", "P6-b2", "P5-c9"] }), lookup)
        .text,
    ).toBe("2 of 4 phases done");
    expect(itemEnd(item({ phases: ["P7-m3"] }), lookup).text).toBe(
      "1 of 1 phase done",
    );
    expect(itemEnd(item({}), lookup)).toEqual({
      phases: 0,
      done: 0,
      text: "",
    });
    // A phase the Workspace does not hold is not counted.
    expect(itemEnd(item({ phases: ["P7-m3", "P99-zz"] }), lookup).text).toBe(
      "1 of 1 phase done",
    );
    expect(everyPhaseDone(item({ phases: ["P7-m3", "P6-b2"] }), lookup)).toBe(
      true,
    );
    expect(everyPhaseDone(item({ phases: ["P7-m3", "P8-q4"] }), lookup)).toBe(
      false,
    );
    expect(everyPhaseDone(item({}), lookup)).toBe(false);
  });

  it("finds a phase by its short id too", () => {
    expect(itemState(item({ phases: ["P8"] }), lookup)).toBe("in_progress");
  });
});

describe("docs", () => {
  it("says what a stale doc waits for", () => {
    expect(
      staleNotes({
        stale: [
          { phase: "P7-m3", notes: 3 },
          { phase: "P8-q4", notes: 1 },
        ],
      }),
    ).toBe("4 notes from P7-m3 and P8-q4");
    expect(staleNotes({ stale: [{ phase: "P8-q4", notes: 1 }] })).toBe(
      "1 note from P8-q4",
    );
    expect(staleNotes({ stale: [] })).toBe("");
    expect(andList(["P1-a2", "P2-b3", "P3-c4"])).toBe("P1-a2, P2-b3 and P3-c4");
    expect(versionLabel(14)).toBe("v14");
    expect(versionLabel(null)).toBe("—");
  });

  it("tells a Korean title", () => {
    expect(langOf("검색이 느려요")).toBe("ko");
    expect(langOf("Uploads that fail")).toBe("en");
  });
});

describe("dates in the viewer's zone", () => {
  const NOW = Date.parse("2026-11-18T09:00:00Z");

  it("turns an instant into the viewer's day and year", () => {
    const seoul = dates("Asia/Seoul", NOW);
    const la = dates("America/Los_Angeles", NOW);
    // 23:30 UTC on Dec 31 is Jan 1 in Seoul, still Dec 31 in Los Angeles.
    expect(seoul.date("2026-12-31T23:30:00Z")).toBe("Jan 1, 2027");
    expect(la.date("2026-12-31T23:30:00Z")).toBe("Dec 31");
    expect(seoul.date("2026-11-17T16:10:00Z")).toBe("Nov 18");
    expect(la.date("2026-11-17T16:10:00Z")).toBe("Nov 17");
  });

  it("reads a calendar day as written, in any zone", () => {
    expect(dates("Asia/Seoul", NOW).date("2026-11-13")).toBe("Nov 13");
    expect(dates("Pacific/Honolulu", NOW).date("2026-11-13")).toBe("Nov 13");
    expect(dates("UTC", NOW).date("2025-12-09")).toBe("Dec 9, 2025");
    expect(dates("UTC", NOW).date(null)).toBe("—");
  });

  it("says how long ago, and today's day in the zone", () => {
    expect(dates("UTC", NOW).when("2026-11-18T08:58:00Z")).toBe("2m ago");
    expect(dates("UTC", NOW).when(null)).toBe("Never");
    expect(todayIn("Asia/Seoul", Date.parse("2026-11-18T16:00:00Z"))).toBe(
      "2026-11-19",
    );
    expect(todayIn("UTC", Date.parse("2026-11-18T16:00:00Z"))).toBe(
      "2026-11-18",
    );
  });
});
