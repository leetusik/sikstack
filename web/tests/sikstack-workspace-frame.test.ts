import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WS_STATUS } from "@/content/workspace/frame";
import { Pager } from "@/sikstack/library/pager";
import { pageHref } from "@/sikstack/library/pager-model";
import {
  BackRow,
  Fact,
  Facts,
  ItemHead,
  phaseSteps,
  RefusedBadge,
  RefusedNotice,
  splitIds,
  Steps,
  stepsN,
  WaitingBadge,
  WS_ROW_BREAKS,
  wsErrorState,
  WsList,
  WsNav,
  wsNotFoundState,
  WsRow,
  wsRowLayout,
  wsStatus,
  WsStatus,
  wsSteps,
  WsSync,
  wsSyncLine,
  WsText,
} from "@/sikstack/workspace/frame";
import {
  stepsBar,
  stepsDrawing,
  stepsFit,
} from "@/sikstack/workspace/frame/steps-model";

// The Workspace's frame (design job 02, frame.md F35 to F49, F78, F80, F85, F300, F301, F306): the status
// words, progress, the row and its four layouts, the head with its places, the sync line, an item's head,
// facts, a change that waits, the item states and ids that never break. Every word is the record's.

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(web, path), "utf8");
const html = (el: ReactElement) => renderToStaticMarkup(el);

const NOW = Date.parse("2026-11-18T09:00:00Z");
const MIN = 60e3;
const DAY = 24 * 60 * MIN;

/** The signed table (`fixture.js` `WORDS`), with the board's `status-wait` under its system name. */
const SIGNED: Record<string, Record<string, [string, string]>> = {
  phase: {
    planned: ["Planned", "status-idle"],
    in_progress: ["In progress", "status-live"],
    in_review: ["In review", ""],
    pending: ["Waiting on operator", "status-wait"],
    blocked: ["Blocked", "status-blocked"],
    done: ["Done", "status-done"],
  },
  slice: {
    todo: ["To do", "status-idle"],
    ready: ["Ready", "status-ready"],
    in_progress: ["In progress", "status-live"],
    in_review: ["In review", ""],
    changes_requested: ["Changes requested", "status-changes"],
    pending: ["Waiting on operator", "status-wait"],
    blocked: ["Blocked", "status-blocked"],
    done: ["Done", "status-done"],
  },
  verdict: {
    pending: ["Not reviewed", "status-idle"],
    pass: ["Pass", "status-done"],
    changes_requested: ["Changes requested", "status-changes"],
    blocked: ["Blocked", "status-blocked"],
  },
  item: {
    open: ["Open", "status-idle"],
    in_progress: ["In progress", "status-live"],
    deferred: ["Deferred", "status-idle"],
    solved: ["Solved", "status-done"],
    dropped: ["Dropped", "status-revoked"],
  },
  pr: {
    draft: ["Draft", "status-idle"],
    open: ["Open", ""],
    merged: ["Merged", "status-done"],
    closed: ["Closed", "status-revoked"],
  },
  gate: {
    not_required: ["Not required", "status-idle"],
    required: ["Required", "status-idle"],
    open: ["Open", "status-wait"],
    cleared: ["Cleared", "status-done"],
  },
  doc: {
    current: ["Current", "status-done"],
    stale: ["Stale", "status-changes"],
    retired: ["Retired", "status-revoked"],
  },
};

/** Every value the read model stores for each kind (the server's shapes and the engine's states). */
const STORED: Record<string, string[]> = {
  phase: ["planned", "in_progress", "in_review", "pending", "blocked", "done"],
  slice: [
    "todo",
    "ready",
    "in_progress",
    "in_review",
    "changes_requested",
    "pending",
    "blocked",
    "done",
  ],
  verdict: ["pending", "pass", "changes_requested", "blocked"],
  item: ["open", "in_progress", "deferred", "solved", "dropped"],
  pr: ["draft", "open", "merged", "closed"],
  gate: ["not_required", "required", "open", "cleared"],
  doc: ["current", "stale", "retired"],
};

describe("status: one word and one shape for every state (F37, F301, F306)", () => {
  it("maps every stored value of every kind to its signed word and the system's class", () => {
    for (const [kind, values] of Object.entries(STORED))
      for (const value of values) {
        const [word, cls] = SIGNED[kind][value];
        const system = cls === "status-wait" ? "status-pending" : cls;
        expect(
          wsStatus(kind as Parameters<typeof wsStatus>[0], value),
          `${kind} ${value}`,
        ).toEqual({ word, cls: `status ${system}`.trim() });
      }
    expect(Object.keys(WS_STATUS).sort()).toEqual(Object.keys(STORED).sort());
    for (const kind of Object.keys(STORED))
      expect(
        Object.keys(WS_STATUS[kind as keyof typeof WS_STATUS]).sort(),
        kind,
      ).toEqual([...STORED[kind]].sort());
  });

  it("names only shapes the system draws", () => {
    const bundle = read("src/sikstack/styles/bundle.css");
    const classes = new Set(
      Object.values(WS_STATUS).flatMap((k) =>
        Object.values(k).flatMap(([, cls]) => cls.split(" ")),
      ),
    );
    for (const cls of classes)
      expect(bundle, cls).toMatch(new RegExp(`\\.${cls}(?:::before)?\\s*\\{`));
  });

  it("says a value it does not know as written, and nothing for none", () => {
    expect(wsStatus("phase", "archived")).toEqual({
      word: "archived",
      cls: "status",
    });
    expect(wsStatus("pr", null)).toBeNull();
    expect(
      html(
        createElement(WsStatus, {
          kind: "slice",
          value: "pending",
          className: "ws-state",
        }),
      ),
    ).toBe(
      '<span class="status status-pending ws-state">Waiting on operator</span>',
    );
  });
});

describe("progress (F39)", () => {
  it("counts done of total and names the steps", () => {
    expect(wsSteps(1, 7, true)).toEqual({
      count: "1/7",
      label: "1 of 7 slices done, 1 in progress",
      segs: ["is-done", "is-now", "", "", "", "", ""],
    });
    expect(wsSteps(1, 1, false)).toEqual({
      count: "1/1",
      label: "1 of 1 slice done",
      segs: ["is-done"],
    });
    expect(wsSteps(0, 2, false).segs).toEqual(["", ""]);
  });

  it("marks one slice running only while the phase is in progress and not every slice is done", () => {
    expect(phaseSteps({ done: 3, total: 7, status: "in_progress" }).label).toBe(
      "3 of 7 slices done, 1 in progress",
    );
    expect(phaseSteps({ done: 3, total: 7, status: "pending" }).label).toBe(
      "3 of 7 slices done",
    );
    expect(
      phaseSteps({ done: 7, total: 7, status: "in_progress" }).segs,
    ).not.toContain("is-now");
  });

  it("gives every row of a list the same segment: its longest phase", () => {
    expect(stepsN([2, 7, 3])).toBe(7);
    expect(stepsN([])).toBe(1);
  });

  it("draws the count and the steps, named as an image", () => {
    const out = html(createElement(Steps, { done: 1, total: 3, live: true }));
    expect(out).toBe(
      '<span class="progress"><span class="progress-count">1/3</span><span class="steps-cell">' +
        '<span class="steps" role="img" aria-label="1 of 3 slices done, 1 in progress">' +
        '<span class="steps-bar" style="--steps-own:3;--steps-done:33.333%;--steps-now:33.333%"></span>' +
        '<i class="is-done"></i><i class="is-now"></i><i></i></span></span></span>',
    );
    expect(
      html(createElement(Steps, { done: 0, total: 2, compact: true, n: 2 })),
    ).toContain('<span class="progress" style="--steps-n:2">');
    expect(
      html(createElement(Steps, { done: 0, total: 2, compact: true })),
    ).toContain('class="steps is-compact"');
  });
});

describe("a Workspace row (F43)", () => {
  it("takes four layouts by the list's width, at 22em, 30em and 52em", () => {
    expect(WS_ROW_BREAKS).toEqual([22, 30, 52]);
    expect([0, 21.9, 22, 29.9, 30, 51.9, 52, 90].map(wsRowLayout)).toEqual([
      "one-column",
      "one-column",
      "status-under",
      "status-under",
      "end-under",
      "end-under",
      "one-line",
      "one-line",
    ]);
    const css = read("src/sikstack/styles/workspace/frame.css");
    for (const em of WS_ROW_BREAKS)
      expect(css).toContain(`@container (min-width: ${em}em)`);
  });

  it("reads id, name as the row's one link, status, then its own cell", () => {
    const out = html(
      createElement(
        WsList,
        { longest: 7 },
        createElement(WsRow, {
          id: "P57-4q",
          name: "sikstack design",
          href: "/projects/platform/workspace/phases/P57-4q",
          sub: "S1 Foundations and shell",
          status: wsStatus("phase", "in_progress"),
          end: createElement(Steps, {
            done: 1,
            total: 7,
            live: true,
            className: "ws-end",
          }),
        }),
        createElement(WsRow, {
          id: "A141-4r",
          name: "하이라이트 색을 직접 고르고 싶어요",
          lang: "ko",
          href: "/projects/platform/workspace/agenda/A141-4r",
          status: wsStatus("item", "deferred"),
          end: "Nov 9",
        }),
      ),
    );
    expect(out).toMatch(/^<ul class="ws-list" style="--steps-n:7">/);
    expect(out).toContain(
      '<li class="row ws-row"><span class="ws-id">P57-4q</span>' +
        '<a class="link-strong ws-open ws-name" href="/projects/platform/workspace/phases/P57-4q">' +
        '<span class="row-stack"><span class="ws-name-text">sikstack design</span>' +
        '<span class="meta ws-sub">S1 Foundations and shell</span></span></a>' +
        '<span class="status status-live ws-state">In progress</span><span class="progress ws-end">',
    );
    expect(out).toContain(
      '<span class="ws-name-text" lang="ko">하이라이트 색을 직접 고르고 싶어요</span>',
    );
    expect(out).toContain(
      '<span class="status status-idle ws-state">Deferred</span><span class="ws-end">Nov 9</span>',
    );
  });
});

describe("the sync line (F40)", () => {
  it("says how fresh the copy is, and its version", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(
      wsSyncLine({ state: "fresh", at: at(2 * MIN) }, "v97", { now: NOW }),
    ).toEqual({
      state: "fresh",
      text: "Synced 2m ago",
      cls: "status status-done",
      version: "v97",
    });
    expect(
      wsSyncLine({ state: "fresh", at: at(20 * 1000) }, "v97", { now: NOW })
        .text,
    ).toBe("Synced just now");
    expect(
      wsSyncLine({ state: "behind", at: at(4 * DAY) }, "v96", { now: NOW }),
    ).toEqual({
      state: "behind",
      text: "Last synced 4d ago",
      cls: "status status-idle",
      version: "v96",
    });
    expect(
      wsSyncLine({ state: "behind", at: "2026-11-08T16:00:00Z" }, "v96", {
        now: NOW,
        timeZone: "Asia/Seoul",
      }).text,
    ).toBe("Last synced Nov 9");
    expect(
      wsSyncLine({ state: "never", at: null }, null, { now: NOW }),
    ).toEqual({
      state: "never",
      text: "Not synced yet",
      cls: "status status-idle",
      version: "",
    });
    expect(wsSyncLine(null, null, { now: NOW }).state).toBe("unlinked");
    expect(
      wsSyncLine({ state: "unlinked", at: null }, null, { now: NOW }).text,
    ).toBe("No workspace linked");
  });

  it("draws fresh, behind and loading", () => {
    const fresh = wsSyncLine(
      { state: "fresh", at: new Date(NOW - 2 * MIN).toISOString() },
      "v97",
      { now: NOW },
    );
    expect(html(createElement(WsSync, { line: fresh }))).toBe(
      '<p class="sync"><span class="status status-done">Synced 2m ago</span>' +
        '<span><span class="sr-only">Workspace </span>v97</span></p>',
    );
    const behind = wsSyncLine(
      { state: "behind", at: new Date(NOW - 4 * DAY).toISOString() },
      "v96",
      { now: NOW },
    );
    expect(html(createElement(WsSync, { line: behind }))).toMatch(
      /^<p class="sync is-behind"><span class="status status-idle">Last synced 4d ago<\/span>/,
    );
    expect(html(createElement(WsSync, { line: fresh, loading: true }))).toBe(
      '<p class="sync" aria-busy="true"><span class="skel" style="width:9em"></span><span class="sr-only">Loading…</span></p>',
    );
  });
});

describe("the Workspace head (F41, F40)", () => {
  const hrefs = {
    agenda: "/projects/platform/workspace",
    backlog: "/projects/platform/workspace/backlog",
    docs: "/projects/platform/workspace/docs",
  };
  const fresh = wsSyncLine(
    { state: "fresh", at: new Date(NOW - 2 * MIN).toISOString() },
    "v97",
    { now: NOW },
  );

  it("draws the title, the sync line and three real links, the current one marked, no Deferred (P61-e9)", () => {
    const out = html(
      createElement(WsNav, { current: "backlog", line: fresh, hrefs }),
    );
    expect(out).toContain(
      '<header class="page-top"><div class="page-head"><h1>Workspace</h1><p class="sync">',
    );
    expect(out).toContain(
      '<nav class="subnav" aria-label="Workspace">' +
        '<a class="subnav-item" href="/projects/platform/workspace">Agenda</a>' +
        '<a class="subnav-item" aria-current="page" href="/projects/platform/workspace/backlog">Backlog</a>' +
        '<a class="subnav-item" href="/projects/platform/workspace/docs">Docs</a></nav>',
    );
    expect(out.match(/aria-current/g)).toHaveLength(1);
  });

  it("keeps the title and the places while loading, the line a bar", () => {
    const out = html(
      createElement(WsNav, {
        current: "agenda",
        line: fresh,
        hrefs,
        loading: true,
      }),
    );
    expect(out).toContain('<p class="sync" aria-busy="true">');
    expect(out).toContain('<nav class="subnav"');
  });

  it("draws one panel and no places when nothing has synced", () => {
    const never = wsSyncLine({ state: "never", at: null }, null, { now: NOW });
    const out = html(
      createElement(WsNav, { current: "agenda", line: never, hrefs }),
    );
    expect(out).not.toContain("subnav");
    expect(out).not.toContain('class="sync');
    expect(out).toContain(
      '<section class="panel" aria-label="Not synced yet"><div class="block"><p class="block-text">Nothing has synced yet. This workspace shows here after its first sync.</p></div></section>',
    );
  });

  it("draws the link command to copy when no workspace is linked", () => {
    const command =
      "sikstack link https://sikstack.com/projects/platform";
    const out = html(
      createElement(WsNav, {
        current: "agenda",
        line: wsSyncLine(null, null, { now: NOW }),
        hrefs,
        command,
      }),
    );
    expect(out).not.toContain("subnav");
    expect(out).toContain(
      '<section class="panel" aria-label="No workspace linked"><div class="block">',
    );
    expect(out).toContain(
      '<p class="block-text">No workspace linked yet. Run this in the project’s repo.</p><div class="command">',
    );
    expect(out).toContain(`<span class="copy-value mono">${command}</span>`);
    expect(out).toContain('aria-label="Copy the link command"');
  });
});

describe("an item's head (F35, F84, F85)", () => {
  const line = wsSyncLine(
    { state: "fresh", at: new Date(NOW - 2 * MIN).toISOString() },
    "v97",
    { now: NOW },
  );

  it("keeps the back link and the sync line in the first row", () => {
    expect(
      html(
        createElement(BackRow, {
          href: "/projects/platform/workspace/backlog",
          label: "Backlog",
          line,
        }),
      ),
    ).toBe(
      '<div class="ws-top"><a class="back" href="/projects/platform/workspace/backlog">Backlog</a>' +
        '<p class="sync"><span class="status status-done">Synced 2m ago</span><span><span class="sr-only">Workspace </span>v97</span></p></div>',
    );
  });

  it("puts the id in the title before the name, the status on its baseline, the actions at its end", () => {
    const out = html(
      createElement(ItemHead, {
        back: {
          href: "/projects/platform/workspace/backlog",
          label: "Backlog",
        },
        line,
        id: "P57-4q",
        name: "sikstack design",
        status: wsStatus("phase", "in_progress"),
        actions: createElement(
          "button",
          { type: "button", className: "btn" },
          "Edit",
        ),
      }),
    );
    expect(out).toBe(
      '<header class="page-top"><div class="ws-top"><a class="back" href="/projects/platform/workspace/backlog">Backlog</a>' +
        '<p class="sync"><span class="status status-done">Synced 2m ago</span><span><span class="sr-only">Workspace </span>v97</span></p></div>' +
        '<div class="page-head ws-head"><div class="page-title"><h1><span class="ws-id">P57-4q</span> sikstack design</h1>' +
        '<span class="status status-live">In progress</span></div><button type="button" class="btn">Edit</button></div></header>',
    );
  });

  it("marks a Korean name with its language", () => {
    const out = html(
      createElement(ItemHead, {
        back: { href: "/projects/glide/workspace", label: "Agenda" },
        line,
        id: "A12-p8",
        name: "하이라이트 색을 직접 고르고 싶어요",
        lang: "ko",
        status: wsStatus("item", "open"),
      }),
    );
    expect(out).toContain(
      '<h1><span class="ws-id">A12-p8</span> <span lang="ko">하이라이트 색을 직접 고르고 싶어요</span></h1>',
    );
  });
});

describe("facts (F44, F80)", () => {
  it("are label-over-value pairs; a long value has its own line; a link's box is its hit area", () => {
    const out = html(
      createElement(
        Facts,
        null,
        createElement(Fact, { label: "Created" }, "Nov 13"),
        createElement(Fact, {
          label: "Source",
          links: [
            {
              id: "P56-t8.S3",
              href: "/projects/platform/workspace/slices/P56-t8.S3",
            },
          ],
        }),
        createElement(
          Fact,
          { label: "Deferred because", long: true },
          "The cache key needs the tenant first.",
        ),
      ),
    );
    expect(out).toBe(
      '<dl class="facts"><div class="fact"><dt>Created</dt><dd>Nov 13</dd></div>' +
        '<div class="fact"><dt>Source</dt><dd class="ws-fact-links"><a class="link ws-fact-link" href="/projects/platform/workspace/slices/P56-t8.S3">' +
        '<span class="ws-fact-link-id">P56-t8.S3</span></a></dd></div>' +
        '<div class="fact ws-fact-long"><dt>Deferred because</dt><dd>The cache key needs the tenant first.</dd></div></dl>',
    );
  });
});

describe("a change that waits, and one refused (F45)", () => {
  it("marks a waiting change with the dashed badge, a refused one with the plain badge", () => {
    expect(html(createElement(WaitingBadge))).toBe(
      '<span class="badge is-waiting">Waiting for sync</span>',
    );
    expect(html(createElement(RefusedBadge))).toBe(
      '<span class="badge">Change refused</span>',
    );
  });

  it("says what the workspace said, with Try again and Discard", () => {
    const out = html(
      createElement(RefusedNotice, {
        said: "The item was solved there on Nov 14.",
        onRetry: () => {},
        onDiscard: () => {},
      }),
    );
    expect(out).toBe(
      '<div class="notice notice-danger stack gap-3" role="alert"><p>The workspace did not take this change. The item was solved there on Nov 14.</p>' +
        '<div class="cluster"><button type="button" class="btn">Try again</button><button type="button" class="btn btn-quiet">Discard</button></div></div>',
    );
    expect(
      html(
        createElement(RefusedNotice, {
          said: "A13-n1 names no agenda item",
          onRetry: () => {},
          onDiscard: () => {},
        }),
      ),
    ).toContain(
      '<p>The workspace did not take this change. <span class="ws-nobr">A13-n1</span> names no agenda item.</p>',
    );
  });
});

describe("not found and error on an item's page (F49, F84)", () => {
  const back = {
    href: "/projects/platform/workspace/backlog",
    label: "Backlog",
  };

  it("names the item and its project, with the item's own way back", () => {
    expect(wsNotFoundState("phase", "platform", back)).toEqual({
      title: "Phase not found",
      text: "This phase doesn’t exist, or it isn’t part of platform.",
      actions: [
        {
          kind: "link",
          label: "Back to Backlog",
          href: back.href,
          variant: "default",
        },
      ],
      reference: null,
    });
    expect(wsNotFoundState("slice", "vocky", back).title).toBe(
      "Slice not found",
    );
    expect(wsNotFoundState("doc", "vocky", back).title).toBe("Doc not found");
    expect(wsNotFoundState("item", "vocky", back).title).toBe(
      "Agenda item not found",
    );
  });

  it("is F5's error with Try again and the way back", () => {
    expect(wsErrorState(back, "7f3a-2c91")).toEqual({
      title: "This page did not load",
      text: "Something failed on our side. Try again. If it keeps failing, send us the reference.",
      actions: [
        { kind: "retry", label: "Try again", variant: "primary" },
        {
          kind: "link",
          label: "Back to Backlog",
          href: back.href,
          variant: "default",
        },
      ],
      reference: "Reference 7f3a-2c91",
    });
    expect(wsErrorState(back).reference).toBeNull();
  });
});

describe("a workspace id never breaks inside a sentence (F80)", () => {
  it("finds each id the workspace writes", () => {
    const parts = splitIds(
      "Folded P56-t8.S3 and P57-4q.DECOMP into D141-4r and D-09e2; see A7-m3, P-7kq2 and P12.",
    );
    expect(parts.filter((p) => p.id).map((p) => p.text)).toEqual([
      "P56-t8.S3",
      "P57-4q.DECOMP",
      "D141-4r",
      "D-09e2",
      "A7-m3",
      "P-7kq2",
    ]);
    expect(parts.map((p) => p.text).join("")).toBe(
      "Folded P56-t8.S3 and P57-4q.DECOMP into D141-4r and D-09e2; see A7-m3, P-7kq2 and P12.",
    );
    expect(splitIds("A mid-sized well-known change")).toEqual([
      { text: "A mid-sized well-known change", id: false },
    ]);
  });

  it("wraps each id at render", () => {
    expect(html(createElement(WsText, { text: "Promoted to P58-yw." }))).toBe(
      'Promoted to <span class="ws-nobr">P58-yw</span>.',
    );
  });
});

describe("the one pager takes its list's address key (F300)", () => {
  it("keeps the list's other query keys and writes its own", () => {
    expect(
      pageHref(3, { q: "cache", status: "deferred", page: "9" }, "page"),
    ).toBe("?q=cache&status=deferred&page=3");
    expect(pageHref(2, { page: "4" }, "deferred")).toBe("?page=4&deferred=2");
    expect(pageHref(2, { archived: "5" }, "archived")).toBe("?archived=2");
    // the Library's lists keep `?page=`
    expect(
      pageHref(2, { view: "all", q: "web hook", filter: "", page: "9" }),
    ).toBe("?view=all&q=web+hook&page=2");
  });

  it("links every number and way with that key", () => {
    const out = html(
      createElement(Pager, {
        page: 2,
        pages: 6,
        range: "11–20 of 52",
        label: "Archived phases, pages",
        pageKey: "archived",
      }),
    );
    expect(out).toContain(
      '<nav class="pager" aria-label="Archived phases, pages">',
    );
    expect(out).toContain(
      '<a class="btn pager-prev" aria-label="Previous" href="?archived=1">',
    );
    expect(out).toContain(
      '<a class="btn pager-num" aria-label="Page 6" href="?archived=6">6</a>',
    );
    expect(out).not.toContain("page=");
  });
});

// A phase longer than its lane (this host's longest is 37 slices): where a step would be drawn narrower than
// 4 px the steps are one bar, filled to the done share; where they fit, the signed steps. The switch is the
// sheet's (the steps' own width against `stepsFit`, at layout); the model states it for the widths each layout gives.
describe("a phase too long for its steps", () => {
  it("draws the bar where a step would be under 4 px, the steps where it is not", () => {
    expect(stepsFit(37)).toBe(292);
    expect(stepsFit(18)).toBe(140);
    expect(stepsDrawing(37, 173).kind).toBe("bar");
    expect(stepsDrawing(18, 173)).toMatchObject({ kind: "steps" });
    expect(stepsDrawing(37, 292)).toMatchObject({ kind: "steps", seg: 4 });
    expect(stepsDrawing(37, 291).kind).toBe("bar");
    expect(stepsDrawing(7, 1200)).toMatchObject({ kind: "steps", seg: 72 });
  });

  it("fills the bar to the done share, the running slice after it", () => {
    expect(stepsBar(30, 37, true)).toEqual({ done: 30 / 37, now: 1 / 37 });
    expect(stepsBar(36, 37, false)).toEqual({ done: 36 / 37, now: 0 });
    expect(stepsBar(37, 37, true)).toEqual({ done: 1, now: 0 });
    expect(stepsBar(0, 0, true)).toEqual({ done: 0, now: 0 });
    const out = html(
      createElement(Steps, { done: 30, total: 37, live: true, n: 37 }),
    );
    expect(out).toContain(
      '<span class="steps" role="img" aria-label="30 of 37 slices done, 1 in progress">' +
        '<span class="steps-bar" style="--steps-own:37;--steps-done:81.081%;--steps-now:2.703%"></span>' +
        '<i class="is-done"></i>',
    );
    expect(out.match(/<i\b/g)).toHaveLength(37);
  });

  // The lanes at a phone's width (390 and 320), from the sheets' lengths at the body's 14 px: the main column's
  // 16 px edges, a panel's 1 px border, a row's 16 px edges and 16 px columns, the count's 3em and its 16 px.
  const EM = 14;
  const lanes = (viewport: number) => {
    const list = viewport - 2 * 16 - 2;
    const row = list - 2 * 16;
    const count = 3 * EM + 16;
    const ws =
      wsRowLayout(list / EM) === "one-column" ? row : row - 5.5 * EM - 16;
    // project home: the id's 3em column, then the count and the steps under the name, in every layout under 44em
    const home = row - 3 * EM - 16;
    return {
      "a Workspace row (backlog, archived, agenda item, promoted to)":
        ws - count,
      "project home's panel": home - count,
      "a phase's title row (compact)": viewport - 2 * 16 - 3 * EM - 8,
    };
  };

  it("never draws a row wider than its lane at 390 or 320, for phases of 1 to 60 slices", () => {
    expect(
      lanes(390)[
        "a Workspace row (backlog, archived, agenda item, promoted to)"
      ],
    ).toBe(173);
    expect(lanes(390)["project home's panel"]).toBe(208);
    for (const viewport of [390, 320])
      for (const [place, width] of Object.entries(lanes(viewport)))
        for (let n = 1; n <= 60; n++) {
          const d = stepsDrawing(n, width);
          expect(
            d.width,
            `${place} at ${viewport}, ${n} slices`,
          ).toBeLessThanOrEqual(width);
          if (d.kind === "steps")
            expect(
              d.seg,
              `${place} at ${viewport}, ${n} slices`,
            ).toBeGreaterThanOrEqual(4);
        }
    expect(stepsDrawing(37, lanes(390)["project home's panel"]).kind).toBe(
      "bar",
    );
    expect(
      stepsDrawing(37, lanes(390)["a phase's title row (compact)"]).kind,
    ).toBe("steps");
  });
});
