import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AgendaItemPage, itemLines } from "@/sikstack/workspace/agenda-item";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import type { AgendaItem, ThreadEntry } from "@/lib/workspace/types";

// An agenda item's thread and note draw what they hold: each body and the note through the Workspace's block
// Markdown renderer (`Md`), so a folded job's brief keeps its headings and a note its code, quotes and tables. An
// image from another host still never loads (D310), and a feedback entry still links back on its kind.

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/workspace/actions", () => ({
  acceptAgendaItems: vi.fn(),
  noteAgendaItem: vi.fn(),
  deferAgendaItems: vi.fn(),
  deleteAgendaItems: vi.fn(),
  discardChange: vi.fn(),
  dropAgendaItems: vi.fn(),
  editAgendaItem: vi.fn(),
  reopenAgendaItems: vi.fn(),
  retryChange: vi.fn(),
  solveAgendaItems: vi.fn(),
}));

const PROJECT = "3f6c2a9e-8b1d-4e7a-9c05-6d2e1f4b7a10";
const FEEDBACK = "e7a57758-bb40-4a09-9963-bb0752b3c3e9";

const BRIEF = [
  "# Deferred: D32-y7 Log each upload retry",
  "",
  "## Context",
  "",
  "Uploads retry silently.",
  "",
  "## Done when",
  "",
  "- each retry logs its **attempt**",
  "- the log names `upload_id`",
].join("\n");

const NOTE = [
  "## Steps",
  "",
  "```",
  "pnpm export --size 2G",
  "echo done",
  "```",
  "",
  "> it hangs at 99%",
  "",
  "| size | result |",
  "| --- | --- |",
  "| 2 GB | fail |",
  "",
  "![chart](https://evil.example/x.png) and ![own](/assets/own.png)",
].join("\n");

const ITEM_NOTE = "## Why\n\nOne product.\n\n```\nline one\nline two\n```";

function entry(over: Partial<ThreadEntry>): ThreadEntry {
  return {
    id: "e",
    kind: "note",
    author: "person:mina",
    by: "person",
    name: "mina",
    source: "web:agenda",
    created: "2026-11-18T08:00:00Z",
    body: "",
    job: null,
    sync: null,
    ...over,
  };
}

const ENTRIES: ThreadEntry[] = [
  entry({
    id: "fold",
    kind: "issue",
    author: "agent:fold",
    by: "agent",
    name: "fold",
    source: "deferred:D32-y7",
    body: BRIEF,
    job: "D32-y7",
  }),
  entry({ id: "note", body: NOTE }),
  entry({
    id: "fb",
    kind: "feedback",
    author: "person:you",
    name: "you",
    source: `feedback:${FEEDBACK}`,
    body: `## Export hangs\n\nAt **99%**.\n\n/feedback/${FEEDBACK}`,
  }),
];

const ITEM: AgendaItem = {
  id: "A7-m3",
  title: "One product",
  lang: "en",
  note: ITEM_NOTE,
  state: "in_progress",
  created: "2026-11-03",
  changed: "2026-11-14",
  phases: [],
  outcome: "",
  reason: "",
  sync: null,
};

function render(item: AgendaItem): string {
  return renderToStaticMarkup(
    createElement(AgendaItemPage, {
      project: PROJECT,
      back: { href: `/projects/${PROJECT}/workspace`, label: "Agenda" },
      line: null,
      timeZone: "Asia/Seoul",
      now: Date.parse("2026-11-18T09:00:00Z"),
      prose: itemProse(item),
      read: { state: "ready", item, ...itemLines(item, { phases: [] }) },
    }),
  );
}

/** The thread's markup, from its list to the composer. */
function thread(html: string): string {
  return html.slice(
    html.indexOf('<ol class="thread"'),
    html.indexOf("thread-compose"),
  );
}

/** One entry's body, by a text it holds. */
function bodyOf(html: string, text: string): string {
  const t = thread(html);
  const at = t.indexOf(text);
  const start = t.lastIndexOf('class="ws-prose thread-body"', at);
  const next = t.indexOf('class="row thread-entry"', at);
  return t.slice(start, next < 0 ? undefined : next);
}

const ITEM_WITH = { ...ITEM, entries: ENTRIES };
const html = render(ITEM_WITH);

describe("a thread entry's body draws its Markdown (P61-e9.F1)", () => {
  it("1. draws a folded brief's headings as headings, each on its own", () => {
    const b = bodyOf(html, "Context");
    expect(b).toMatch(/<div class="md-h1"[^>]*role="heading"[^>]*>Deferred: /);
    expect(b).toMatch(
      /<div class="md-h2"[^>]*role="heading"[^>]*>Context<\/div>/,
    );
    expect(b).toMatch(/<div class="md-h2"[^>]*>Done when<\/div>/);
    expect(b).not.toContain("# Deferred");
    // a heading in a panel headed by an h2 sits a step under it
    expect(b).toMatch(/aria-level="3"[^>]*>Deferred: /);
  });

  it("2. draws a note's heading as a heading", () => {
    expect(bodyOf(html, "Steps")).toMatch(
      /<div class="md-h1"[^>]*role="heading"[^>]*>Steps<\/div>/,
    );
  });

  it("3. keeps a fenced code block's lines", () => {
    expect(bodyOf(html, "pnpm export")).toContain(
      "<pre><code>pnpm export --size 2G\necho done\n</code></pre>",
    );
  });

  it("4. draws a blockquote as a quote", () => {
    expect(bodyOf(html, "hangs at 99%")).toMatch(
      /<blockquote>\s*<p>it hangs at 99%<\/p>\s*<\/blockquote>/,
    );
  });

  it("5. draws a table as a table", () => {
    const b = bodyOf(html, "2 GB");
    expect(b).toContain('<table class="table">');
    expect(b).toContain('<th scope="col">size</th>');
    expect(b).toContain("<td>2 GB</td>");
  });

  it("6. still draws lists, bold and inline code", () => {
    const b = bodyOf(html, "Done when");
    expect(b).toMatch(
      /<ul>\s*<li>each retry logs its <strong>attempt<\/strong><\/li>/,
    );
    expect(b).toContain("<code>upload_id</code>");
  });

  it("7. draws a waiting note as it draws a synced one (D305)", () => {
    const waiting = render({
      ...ITEM,
      entries: [entry({ id: "w", body: NOTE, sync: "waiting" })],
    });
    const synced = render({
      ...ITEM,
      entries: [entry({ id: "w", body: NOTE })],
    });
    expect(waiting).toContain("Waiting for sync");
    expect(bodyOf(waiting, "Steps")).toBe(bodyOf(synced, "Steps"));
    expect(bodyOf(waiting, "Steps")).toContain('<table class="table">');
  });

  it("8. never loads an image from another host (D310)", () => {
    const b = bodyOf(html, "2 GB");
    expect(b).not.toContain("evil.example");
    expect(b).toContain("chart and ");
    expect(b).toContain('<img src="/assets/own.png" alt="own"/>');
  });

  it("9. links a feedback entry back on its kind, its last /feedback line hidden, its body drawn", () => {
    const t = thread(html);
    expect(t).toContain(
      `<a class="link" href="/projects/${PROJECT}/feedback/${FEEDBACK}">Feedback</a>`,
    );
    const b = bodyOf(html, "Export hangs");
    expect(b).toMatch(/<div class="md-h1"[^>]*>Export hangs<\/div>/);
    expect(b).toContain("At <strong>99%</strong>.");
    expect(b).not.toContain(`/feedback/${FEEDBACK}`);
  });

  it("10. draws the item's own note the same way", () => {
    const head = html.slice(0, html.indexOf('<ol class="thread"'));
    expect(head).toMatch(
      /<div class="md-h1"[^>]*role="heading"[^>]*>Why<\/div>/,
    );
    expect(head).toContain("<pre><code>line one\nline two\n</code></pre>");
  });

  it("gives every Markdown body on the page its own ids", () => {
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
