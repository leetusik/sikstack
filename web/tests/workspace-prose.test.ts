import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeadFacts } from "@/sikstack/workspace/agenda-item/head";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import { BacklogWaiting } from "@/sikstack/workspace/backlog";
import { DocVersions } from "@/sikstack/workspace/docs";
import { wsSyncLine } from "@/sikstack/workspace/frame";
import { WsProse } from "@/sikstack/workspace/frame/prose";
import { PhaseSlices } from "@/sikstack/workspace/phase/parts";
import { SliceHead } from "@/sikstack/workspace/slice";
import type { ItemView } from "@/sikstack/workspace/agenda-item/model";
import type { Slice, SliceRow } from "@/lib/workspace/types";

// Stored prose drawn as its Markdown on every Workspace page (frame.md F46, F80): what the workspace and the
// operator write carries the workspace's inline Markdown (bold, code, links to its own files), and every place
// that draws such a text shows it as text, never its marks: the backlog's waiting list, a phase's slice rows, a
// slice's sentence and a stop's words, an agenda item's note, outcome and reason and its thread's entries, a doc
// version's summary. Titles stay plain text.

const html = (el: ReactElement) => renderToStaticMarkup(el);

/** Written the way the engine and the operator write: bold, a code chip, a link to a workspace file, an id. */
const PROSE =
  "**Decided** to cap `KB_FEEDBACK_ATTACHMENTS_TOTAL_MAX_BYTES` at 25 MB, see [the breakdown](topics/breakdown.md) and P12-k3.S7.";

/** The text drawn, without its marks, its code a chip and the id whole. */
function expectDrawn(out: string) {
  expect(out).toContain("<strong>Decided</strong>");
  expect(out).toContain("<code>KB_FEEDBACK_ATTACHMENTS_TOTAL_MAX_BYTES</code>");
  expect(out).toContain("see the breakdown and ");
  expect(out).toContain('<span class="ws-nobr">P12-k3.S7</span>');
  for (const mark of ["**", "`", "](", "topics/breakdown.md"])
    expect(out).not.toContain(mark);
  // its container takes the frame's prose rules (bold weight, the code chip)
  expect(out).toMatch(/class="[^"]*\bws-prose\b/);
}

const LINE = wsSyncLine({ state: "fresh", at: "2026-11-18T08:40:00Z" }, "97", {
  now: Date.parse("2026-11-18T08:42:00Z"),
});
const BACK = { href: "/back", label: "Back" };

describe("stored prose drawn as its Markdown", () => {
  it("in the backlog's waiting list: a stop's what and words", () => {
    const out = html(
      createElement(BacklogWaiting, {
        items: [
          {
            id: "P12-k3.S7",
            name: "Attachments",
            lang: "en",
            href: "/s",
            type: "stop",
            kind: "decision",
            what: PROSE,
            words: "“accept” signs it, or say `moveon`.",
          },
        ],
      }),
    );
    expectDrawn(out);
    expect(out).toContain("<code>moveon</code>");
  });

  it("in a phase's slice rows: a slice's outcome under its name, the name plain", () => {
    const row: SliceRow = {
      id: "S7",
      full: "P12-k3.S7",
      phase: "P12-k3",
      name: "Cap **attachments**",
      kind: "implementation",
      status: "done",
      risk: "low",
      deps: [],
      started: null,
      completed: null,
      outcome: PROSE,
      stop: null,
    };
    const out = html(
      createElement(PhaseSlices, {
        slices: [row],
        current: null,
        asked: {},
        href: (full: string) => `/s/${full}`,
      }),
    );
    expectDrawn(out.replace("Cap **attachments**", ""));
    // a title is plain text, as the board draws it
    expect(out).toContain("Cap **attachments**");
  });

  it("in a slice's head: its one sentence and a stop's words", () => {
    const slice = {
      id: "S7",
      full: "P12-k3.S7",
      phase: "P12-k3",
      name: "Attachments",
      kind: "implementation",
      status: "pending",
      risk: "low",
      deps: [],
      started: null,
      completed: null,
      outcome: null,
      plan: null,
      result: null,
      stop: {
        kind: "decision",
        what: PROSE,
        words: "Say `accept`.",
        since: "2026-11-16",
      },
      workspace: { version: "97", sync: { state: "fresh", at: null } },
    } as unknown as Slice;
    const out = html(
      createElement(SliceHead, {
        slice,
        back: BACK,
        line: LINE,
        date: (v: string | null | undefined) => v ?? "—",
        depHref: (full: string) => `/s/${full}`,
      }),
    );
    expectDrawn(out);
    expect(out).toContain("Say <code>accept</code>.");
  });

  it("in an agenda item's facts: outcome and note, lines and lists as written", () => {
    const item = {
      note: "Two steps:\n\n- ship `v97`\n- walk it",
      outcome: PROSE,
      reason: "",
    };
    const view = {
      end: { label: "outcome", text: item.outcome },
      note: item.note,
    } as unknown as ItemView;
    const out = html(
      createElement(HeadFacts, {
        view,
        created: "Nov 14",
        changed: "Nov 18",
        prose: itemProse(item),
      }),
    );
    expectDrawn(out);
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>ship <code>v97</code></li>");
    // a change still waiting draws its own text plain, until the next read draws it
    const waiting = html(
      createElement(HeadFacts, {
        view: { ...view, note: "Changed **here**" } as ItemView,
        created: "Nov 14",
        changed: "Nov 18",
        prose: itemProse(item),
      }),
    );
    expect(waiting).toContain("Changed **here**");
  });

  it("in a doc's earlier versions: each version's summary", () => {
    const out = html(
      createElement(DocVersions, {
        rows: [
          {
            version: "v3",
            label: "Version 3",
            href: "/d?version=3",
            date: "Nov 14",
            summary: PROSE,
          },
        ],
      }),
    );
    expectDrawn(out);
  });

  it("keeps every link as its text: a workspace file's path and a web address alike", () => {
    // a line sits inside a row's link, which may hold no second link, and a workspace file has no address here
    const out = html(
      createElement(WsProse, {
        text: "Moved to [the retrofit guide](../../retrofit-guide.md); see [the PR](https://github.com/o/r/pull/9).",
      }),
    );
    expect(out).toBe("Moved to the retrofit guide; see the PR.");
  });
});

// The renderer is server-only by where it is imported: a client component (and everything it imports) must never
// reach it, or the Markdown renderer ships in the client bundle.
describe("the Markdown renderer stays out of the client bundle", () => {
  const web = fileURLToPath(new URL("..", import.meta.url));
  const src = join(web, "src");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory()
        ? files(path)
        : /\.tsx?$/.test(name)
          ? [path]
          : [];
    });
  const resolveImport = (from: string, spec: string): string | null => {
    const base = spec.startsWith("@/")
      ? join(src, spec.slice(2))
      : spec.startsWith(".")
        ? resolve(dirname(from), spec)
        : null;
    if (base === null) return null;
    for (const path of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ])
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        // try the next
      }
    return null;
  };
  /** Imports that reach code at run time (`import type` and `export type` erased). */
  const imports = (path: string) =>
    [
      ...readFileSync(path, "utf8").matchAll(
        /^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm,
      ),
    ].map((m) => m[1]);

  it("no client component reaches WsProse or react-markdown", () => {
    const all = files(src);
    const clients = all.filter((p) =>
      /^["']use client["']/.test(readFileSync(p, "utf8")),
    );
    expect(clients.length).toBeGreaterThan(20);
    const prose = join(src, "sikstack/workspace/frame/prose.tsx");
    const offenders: string[] = [];
    for (const client of clients) {
      const seen = new Set<string>();
      const walk = (path: string, trail: string[]) => {
        if (seen.has(path)) return;
        seen.add(path);
        for (const spec of imports(path)) {
          if (spec === "react-markdown" && path.includes("/workspace/"))
            offenders.push([...trail, path, spec].join(" → "));
          const next = resolveImport(path, spec);
          if (next === prose)
            offenders.push([...trail, path, "prose.tsx"].join(" → "));
          else if (next) walk(next, [...trail, path]);
        }
      };
      walk(client, []);
    }
    expect(offenders.map((o) => o.replaceAll(src, ""))).toEqual([]);
  });
});
