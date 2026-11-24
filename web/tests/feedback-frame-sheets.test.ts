import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The Feedback frame's sheets change no other page (src/sikstack/styles/README.md; P58-yw's *Isolation* and
// *Class names*), as the Library's do (sikstack-library-frame-sheets.test.ts): every rule sits in the system's
// one scope; no rule names only system or Library classes, so no existing page's markup gains a
// declaration; no markup outside Feedback's own folders draws a Feedback class; the frame's custom
// properties are restored at the old-page boundary; the barrel loads each sheet once, after the Library's.

const web = fileURLToPath(new URL("..", import.meta.url));
const styles = join(web, "src/sikstack/styles");
const feedback = join(styles, "feedback");
const read = (path: string) => readFileSync(path, "utf8");
const SCOPE = "@scope (.ui) to ([data-ui-legacy])";
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

interface Block {
  prelude: string;
  body: string;
}

/** The statements of a stretch of CSS at brace depth 0: `{ prelude, body }` for each block. */
function blocks(css: string): Block[] {
  const text = stripComments(css);
  const out: Block[] = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        out.push({
          prelude: text.slice(start, open).trim(),
          body: text.slice(open + 1, i),
        });
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      out.push({ prelude: text.slice(start, i).trim(), body: "" });
      start = i + 1;
    }
  }
  expect(depth).toBe(0);
  expect(text.slice(start).trim()).toBe("");
  return out;
}

/** Every style rule inside a block, descending into `@container` and `@media`, with its at-rule. */
function styleRules(css: string, within = ""): (Block & { within: string })[] {
  return blocks(css).flatMap((b) =>
    b.prelude.startsWith("@")
      ? styleRules(b.body, b.prelude)
      : [{ ...b, within }],
  );
}

/** A selector list's selectors, split at top-level commas. */
function selectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(prelude.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(prelude.slice(start).trim());
  return out;
}

const classesOf = (css: string) =>
  new Set(
    [...stripComments(css).matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((m) => m[1]),
  );

const declared = (css: string) =>
  new Set(
    [...stripComments(css).matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map(
      (m) => m[1],
    ),
  );

/** `{ property: value }` of one rule's body. */
const declarations = (body: string) =>
  Object.fromEntries(
    body
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return [d.slice(0, i).trim(), d.slice(i + 1).trim()];
      }),
  );

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const SHEETS = readdirSync(feedback)
  .filter((f) => f.endsWith(".css") && f !== "boundary.css")
  .sort();

const frame = () => blocks(read(join(feedback, "frame.css")))[0].body;

/** The rules of the frame whose selector list holds `selector`. */
const rulesOn = (selector: string) =>
  styleRules(frame()).filter((r) => selectors(r.prelude).includes(selector));

/**
 * Where Feedback's classes may be drawn: its parts, its pages, project home's Feedback panel (S7), and the
 * Design list, which composes Feedback's table that stacks and its cells (P77).
 */
const FEEDBACK_MARKUP = [
  "/sikstack/feedback/",
  "/app/(app)/feedback/",
  "/app/(app)/projects/[projectId]/",
  "/sikstack/design/",
  // Members (P78-s2.S2's signed design): its two tables are Feedback's table that stacks (`StackTable`, `td.is-main`).
  "/sikstack/org/members.tsx",
];

describe("the Feedback frame's sheets", () => {
  it("are the frame and one sheet a page, each owned and named", () => {
    expect(SHEETS).toEqual(["agenda.css", "frame.css", "item.css", "list.css"]);
    const owners: Record<string, string> = {
      "list.css": "S4",
      "item.css": "S5",
      "agenda.css": "S6",
    };
    for (const [name, slice] of Object.entries(owners))
      expect(read(join(feedback, name)), name).toMatch(
        new RegExp(`Owner: P65-nh\\.${slice}\\b`),
      );
  });

  it("scope every rule to .ui, stopped at the old-page boundary", () => {
    for (const name of SHEETS)
      expect(
        blocks(read(join(feedback, name))).map((b) => b.prelude),
        name,
      ).toEqual([SCOPE]);
  });

  it("add no rule that names only system or Library classes, but for the custom properties of a root", () => {
    const shared = new Set([
      ...classesOf(read(join(styles, "tokens.css"))),
      ...classesOf(read(join(styles, "bundle.css"))),
      ...readdirSync(join(styles, "library")).flatMap((f) => [
        ...classesOf(read(join(styles, "library", f))),
      ]),
    ]);
    const offenders: string[] = [];
    for (const name of SHEETS)
      for (const rule of styleRules(
        blocks(read(join(feedback, name)))[0].body,
      )) {
        const onlyCustom = Object.keys(declarations(rule.body)).every((p) =>
          p.startsWith("--"),
        );
        for (const sel of selectors(rule.prelude)) {
          const own = [...classesOf(sel)].filter((c) => !shared.has(c));
          if (own.length === 0 && !onlyCustom)
            offenders.push(`${name}: ${sel}`);
        }
      }
    expect(offenders).toEqual([]);
  });

  it("are drawn by no markup outside Feedback's own folders", () => {
    const shared = new Set([
      ...classesOf(read(join(styles, "tokens.css"))),
      ...classesOf(read(join(styles, "bundle.css"))),
      ...readdirSync(join(styles, "library")).flatMap((f) => [
        ...classesOf(read(join(styles, "library", f))),
      ]),
    ]);
    const own = [...classesOf(frame())].filter((c) => !shared.has(c));
    expect(own.length).toBeGreaterThan(20);
    const drawn: string[] = [];
    for (const file of filesUnder(join(web, "src")).filter(
      (f) =>
        /\.tsx?$/.test(f) && !FEEDBACK_MARKUP.some((dir) => f.includes(dir)),
    )) {
      const code = read(file);
      const strings = [
        ...code.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g),
        ...code.matchAll(/\bcx\(([^)]*)\)/g),
      ].flatMap((m) =>
        [...m[1].matchAll(/["'`]?([^"'`\s,]+)/g)].map((t) => t[1]),
      );
      for (const name of own)
        if (strings.includes(name)) drawn.push(`${file}: ${name}`);
    }
    expect(drawn).toEqual([]);
  });

  it("build no canvas-only part and no second pager", () => {
    const css = stripComments(frame());
    expect(css).not.toMatch(/data-proto|\.pager\b|\.sc-host|#dc-root/);
  });

  it("restore, at the boundary, every custom property the frame adds", () => {
    const added = declared(frame());
    expect(added).toEqual(
      new Set([
        "--measure",
        "--fact-min",
        "--rating-mark",
        "--json-lines",
        "--seg-rule",
      ]),
    );
    const [saves, restores] = blocks(read(join(feedback, "boundary.css")));
    expect([saves.prelude, restores.prelude]).toEqual([
      ":root",
      ".ui [data-ui-legacy]",
    ]);
    const pairs = (body: string) => [
      ...stripComments(body).matchAll(
        /(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/g,
      ),
    ];
    const saved = pairs(saves.body);
    expect(saved.every((m) => m[1] === `--sikstack-legacy${m[2].slice(1)}`)).toBe(
      true,
    );
    expect(new Set(saved.map((m) => m[2]))).toEqual(added);
    const restored = pairs(restores.body);
    expect(
      restored.every((m) => m[2] === `--sikstack-legacy${m[1].slice(1)}`),
    ).toBe(true);
    expect(new Set(restored.map((m) => m[1]))).toEqual(added);
  });

  it("are loaded once, through the system's barrel, after the Library's", () => {
    const imports = [
      ...read(join(styles, "index.css")).matchAll(/@import "([^"]+)";/g),
    ].map((m) => m[1]);
    const first = imports.findIndex((i) => i.startsWith("./feedback/"));
    // Feedback's run, then only the Design service's one sheet (P77) and the org surfaces' (P78), which follow it
    expect(imports.slice(first)).toEqual([
      "./feedback/frame.css",
      "./feedback/list.css",
      "./feedback/item.css",
      "./feedback/agenda.css",
      "./feedback/boundary.css",
      "./design/design.css",
      "./org.css",
    ]);
    expect(imports[first - 1]).toBe("./library/boundary.css");
    expect(new Set(imports).size).toBe(imports.length);
    for (const file of filesUnder(join(web, "src")).filter((f) =>
      /\.(tsx?|css)$/.test(f),
    ))
      expect(read(file), file).not.toMatch(
        /import\s+["'][^"']*styles\/feedback\//,
      );
  });
});

describe("the frame's rules, as signed", () => {
  it("keep Unrated's place for the mark in a column, and nowhere else (F122)", () => {
    expect(declarations(rulesOn(".rating-unrated::before")[0].body)).toEqual({
      display: "none",
    });
    const column = rulesOn(".table td > .rating-unrated::before");
    expect(column.map((r) => r.within)).toEqual([""]);
    expect(selectors(column[0].prelude)).toEqual([
      ".table td > .rating-unrated::before",
      ".row > .rating-unrated::before",
    ]);
    expect(declarations(column[0].body)).toEqual({ display: "block" });
    // a stacked row is no column: the mark's place goes again
    const stacked = rulesOn(".table-stack .table td > .rating-unrated::before");
    expect(stacked.map((r) => r.within)).toEqual([
      "@container tstack (max-width: 48em)",
    ]);
    expect(declarations(stacked[0].body)).toEqual({ display: "none" });
  });

  it("cap raw JSON at its lines and set the mono face only there (F126)", () => {
    expect(declarations(rulesOn(".json")[0].body)["max-height"]).toBe(
      "calc(var(--json-lines) * var(--fs-meta) * var(--lh-head) + 2 * var(--space-3) + 2px)",
    );
    const mono = styleRules(frame()).filter((r) =>
      r.body.includes("--font-mono"),
    );
    expect(mono.map((r) => r.prelude)).toEqual([".json > pre"]);
  });

  it("sink a disabled group of toggles (F144)", () => {
    expect(
      declarations(rulesOn(".seg:has(> .seg-item:disabled)")[0].body),
    ).toEqual({
      "border-radius": "var(--radius-m)",
      background: "var(--bg)",
      "box-shadow": "inset 0 0 0 1px var(--line)",
    });
  });

  it("set the list's columns and stop its message at 56ch (F139, F140)", () => {
    expect(declarations(rulesOn(".stack-set")[0].body)).toEqual({
      "table-layout": "fixed",
    });
    expect(declarations(rulesOn(".stack-set .clamp-2")[0].body)).toEqual({
      "max-width": "56ch",
    });
    expect(declarations(rulesOn(".stack-rating")[0].body)).toEqual({
      width: "9em",
    });
  });

  it("name the grid of facts and the ink waiting mark as the system does (D238-rm)", () => {
    expect(rulesOn(".facts")).toEqual([]);
    expect(declarations(rulesOn(".facts.is-grid")[0].body).display).toBe(
      "grid",
    );
    // the dashed badge and a fact are one drawing for Feedback and the Workspace, declared once, by the
    // system (bundle.css, since the Workspace's build); the ink word is Feedback's own
    expect(rulesOn(".badge.is-waiting")).toEqual([]);
    expect(rulesOn(".fact")).toEqual([]);
    const system = styleRules(
      blocks(read(join(styles, "bundle.css"))).find((b) => b.prelude === SCOPE)!
        .body,
    );
    expect(
      system
        .filter((r) => selectors(r.prelude).includes(".badge.is-waiting"))
        .map((r) => declarations(r.body)),
    ).toEqual([{ "border-style": "dashed" }]);
    expect(declarations(rulesOn(".badge.is-ink")[0].body)).toEqual({
      color: "var(--ink)",
    });
  });
});
