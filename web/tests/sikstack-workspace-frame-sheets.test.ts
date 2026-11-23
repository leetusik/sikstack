import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STEPS_GAP, STEPS_LEAST } from "@/sikstack/workspace/frame/steps-model";

// The Workspace's sheets (design job 02, frame.md F35 to F51, F80, F85): the names the Workspace shares with
// the product are promoted into the system (`bundle.css`), each beside its family and under the system's
// name (`.status-wait` is `.status-pending`, `.track` is `.steps`); the Workspace's own frame is
// `workspace/frame.css`; the ten Workspace sheets are loaded once, through the barrel, before the Library's
// boundary.

const web = fileURLToPath(new URL("..", import.meta.url));
const styles = join(web, "src/sikstack/styles");
const workspace = join(styles, "workspace");
const read = (path: string) => readFileSync(path, "utf8");
const SCOPE = "@scope (.ui) to ([data-ui-legacy])";
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (css: string) =>
  stripComments(css)
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .trim();

interface Block {
  prelude: string;
  body: string;
}

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

function styleRules(css: string): Block[] {
  return blocks(css).flatMap((b) =>
    b.prelude.startsWith("@") ? styleRules(b.body) : [b],
  );
}

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

const properties = (body: string) =>
  body
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter(Boolean);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The system's one scope block of a sheet. */
const scopeBody = (path: string) => {
  const scoped = blocks(read(path)).filter((b) => b.prelude === SCOPE);
  expect(scoped, path).toHaveLength(1);
  return scoped[0].body;
};

/** The signed names job 02 drew and the system names they are built under (one name per meaning). */
const RENAMES: [RegExp, string][] = [
  [/\.status-wait\b/g, ".status-pending"],
  [/\.track-cell\b/g, ".steps-cell"],
  [/\.track\b/g, ".steps"],
  [/--track-seg-compact\b/g, "--steps-seg-compact"],
  [/--track-seg\b/g, "--steps-seg"],
  [/--track-n\b/g, "--steps-n"],
];
const renamed = (css: string) =>
  RENAMES.reduce((out, [from, to]) => out.replace(from, to), css);

/** Job 02's `frame.css` rules the system takes, as the signed sheet writes them (sections 1, 2, 3, 6, 7). */
const SIGNED_SHARED = `
.status-ready::before { background: linear-gradient(90deg, var(--ink) 50%, transparent 50%); }
.status-wait { color: var(--accent); font-weight: 600; }
.status-wait::before { border-width: 0 2.5px; border-color: var(--accent); border-radius: 0; background: transparent; }
.status-blocked { color: var(--danger); font-weight: 600; }
.status-blocked::before { border-color: var(--danger); border-radius: var(--radius-xs); background: var(--danger); }
.status-changes::before { width: 6px; height: 6px; margin-inline: 1px; border-radius: 0; transform: rotate(45deg); }
.track-cell { display: flex; flex: 1; align-items: center; min-width: 0; }
.track-cell::before { content: "\\200b"; }
.track { display: flex; flex: 1; gap: var(--space-1); min-width: 0; }
.track > i { flex: none; width: min(var(--track-seg), calc((100% - (var(--track-n, 1) - 1) * var(--space-1)) / var(--track-n, 1))); height: var(--dot); border: 1px solid var(--edge); border-radius: var(--radius-xs); }
.track > i.is-done { border-color: var(--ink); background: var(--ink); }
.track > i.is-now { border-color: var(--accent); background: var(--accent); }
.track.is-compact { --track-seg: var(--track-seg-compact); flex: 0 1 auto; width: calc(var(--track-n, 1) * (var(--track-seg) + var(--space-1)) - var(--space-1)); max-width: 100%; }
.facts { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-6); }
.fact { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
.fact > dt { color: var(--ink-2); font-size: var(--fs-meta); font-weight: 500; line-height: var(--lh-meta); }
.badge.is-waiting { border-style: dashed; }
`;

/** Job 02's layout lengths (its `frame.css` section 1), now the system's. */
const SIGNED_TOKENS: Record<string, string> = {
  "--measure": "72ch",
  "--steps-seg": "72px",
  "--steps-seg-compact": "16px",
  "--id-w": "5.5em",
  "--status-w": "11em",
  "--outline-w": "14em",
  "--code-pad": "3px",
};

/**
 * The lines the Feedback build (job 04) writes for the same drawing, byte for byte: both branches write
 * them identically, so their merge holds one rule each.
 */
const SHARED_WITH_FEEDBACK = [
  ".fact { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }",
  ".fact > dt { color: var(--ink-2); font-size: var(--fs-meta); font-weight: 500; line-height: var(--lh-meta); }",
  ".badge.is-waiting { border-style: dashed; }",
];

const SHEETS = [
  "frame.css",
  "md.css",
  "home.css",
  "agenda.css",
  "agenda-item.css",
  "backlog.css",
  "phase.css",
  "slice.css",
  "deferred.css",
  "docs.css",
];

describe("job 02's shared names in the system", () => {
  const bundle = read(join(styles, "bundle.css"));
  const rules = new Map(
    styleRules(scopeBody(join(styles, "bundle.css"))).map((r) => [
      squash(r.prelude),
      squash(r.body),
    ]),
  );

  it("are the signed declarations, under the system's names", () => {
    for (const rule of styleRules(renamed(SIGNED_SHARED))) {
      const name = squash(rule.prelude);
      expect(rules.get(name), name).toBe(squash(rule.body));
    }
  });

  it("declare the Workspace's layout lengths on the root, as signed", () => {
    const roots = styleRules(scopeBody(join(styles, "bundle.css")))
      .filter((r) => r.prelude === ":scope")
      .map((r) => r.body)
      .join(";");
    for (const [name, value] of Object.entries(SIGNED_TOKENS)) {
      const m = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`).exec(roots);
      expect(m?.[1].trim(), name).toBe(value);
    }
  });

  it("sit beside their families, never at the file's end", () => {
    const at = (needle: string) => {
      const i = bundle.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = (...needles: string[]) => {
      const places = needles.map(at);
      expect(places, needles.join(" < ")).toEqual(
        [...places].sort((a, b) => a - b),
      );
    };
    order("--seek-thumb:", "--measure:", "/* 2 ── base");
    order(
      ".status-live::before",
      ".status-ready::before",
      ".status-pending {",
      ".status-blocked {",
      ".status-changes::before",
      "/* panel and section */",
    );
    order(".badge.is-wrap", ".badge.is-waiting", ".count {");
    order(".stat-value", ".facts {", ".fact {", "/* trend:");
    order(
      ".meter-row > .meter",
      ".steps-cell {",
      ".steps.is-compact",
      "/* copy:",
    );
    expect(bundle.lastIndexOf(".status-done::before")).toBeGreaterThan(
      at(".steps.is-compact"),
    );
  });

  it("are written byte for byte as the Feedback build writes them", () => {
    const lines = bundle.split("\n").map((l) => l.trim());
    for (const line of SHARED_WITH_FEEDBACK)
      expect(lines, line).toContain(line);
  });

  it("keep no renamed signed name anywhere in the system or the Workspace", () => {
    const files = [
      join(styles, "tokens.css"),
      join(styles, "bundle.css"),
      ...readdirSync(workspace).map((f) => join(workspace, f)),
      ...filesUnder(join(web, "src/sikstack/workspace")),
    ];
    for (const file of files)
      expect(stripComments(read(file)), file).not.toMatch(
        /\.status-wait\b|\bstatus-wait\b|\.track\b|\btrack-cell\b|--track-|\bis-track\b/,
      );
  });
});

describe("one name, one meaning, once the Workspace's facts are the system's", () => {
  it("leaves Review's end card no class the system draws as label-over-value facts", () => {
    // Review's end card (job 07) draws a dotted line of facts, another meaning: its own names keep the
    // system's `.fact { flex-direction: column }` off it, so its separators stay on the line.
    const review = stripComments(read(join(styles, "review/review.css")));
    expect(review).not.toMatch(/\.facts?(?:-in)?\b(?![-\w])/);
    expect(review).toMatch(/\.end-cont \.end-fact\b/);
    const end = read(join(web, "src/sikstack/review/end.tsx"));
    expect(end).not.toMatch(
      /className="(?:[\w-]+ )*facts?(?:-in)?(?: [\w-]+)*"/,
    );
    expect(end).toMatch(/className="dim end-facts"/);
  });
});

describe("the Workspace's sheets", () => {
  it("are the frame and one sheet a page, each naming what it holds", () => {
    expect(
      readdirSync(workspace)
        .filter((f) => f.endsWith(".css"))
        .sort(),
    ).toEqual([...SHEETS].sort());
    for (const name of SHEETS) {
      const css = read(join(workspace, name));
      expect(css, name).toMatch(/^\/\* sikstack — the Workspace's /);
      // product code names no phase or slice of the workspace that built it
      expect(css, name).not.toMatch(/\bP\d+-[a-z0-9]+\b|\.S\d+\b|workflow\//);
    }
  });

  it("scope every rule to .ui, stopped at the old-page boundary", () => {
    for (const name of SHEETS)
      expect(
        blocks(read(join(workspace, name))).map((b) => b.prelude),
        name,
      ).toEqual([SCOPE]);
  });

  it("hold the frame's parts in frame.css, declaring no custom property of their own", () => {
    const body = scopeBody(join(workspace, "frame.css"));
    expect(styleRules(body).length).toBeGreaterThan(20);
    expect(body).not.toMatch(/(?:^|[;{\s])--[a-z0-9-]+\s*:/);
  });

  it("add no rule that names only system classes", () => {
    const system = new Set([
      ...classesOf(read(join(styles, "tokens.css"))),
      ...classesOf(read(join(styles, "bundle.css"))),
    ]);
    const offenders: string[] = [];
    for (const name of SHEETS) {
      const body = scopeBody(join(workspace, name));
      for (const rule of styleRules(body))
        for (const sel of selectors(rule.prelude)) {
          const own = [...classesOf(sel)].filter((c) => !system.has(c));
          if (own.length === 0) offenders.push(`${name}: ${sel}`);
        }
    }
    expect(offenders).toEqual([]);
  });

  it("lay out a Workspace row four ways by the list's width: 22em, 30em, 52em (F43)", () => {
    const top = blocks(scopeBody(join(workspace, "frame.css")));
    const at = (q: string) => {
      const found = top.filter(
        (b) => squash(b.prelude) === `@container (min-width:${q})`,
      );
      expect(found, q).toHaveLength(1);
      const row = styleRules(found[0].body).find(
        (r) => r.prelude === ".ws-row",
      );
      expect(row, q).toBeDefined();
      return squash(row!.body);
    };
    const base = styleRules(scopeBody(join(workspace, "frame.css"))).find(
      (r) => r.prelude === ".ws-row",
    );
    expect(squash(base!.body)).toContain(
      'grid-template-areas:"id" "name" "status" "end"',
    );
    expect(at("22em")).toContain(
      'grid-template-areas:"id name" ". status" ". end"',
    );
    expect(at("30em")).toContain(
      'grid-template-areas:"id name status" ". end end"',
    );
    expect(at("52em")).toContain('grid-template-areas:"id name status end"');
    expect(at("52em")).toContain(
      "grid-template-columns:var(--id-w) minmax(12em,2fr) var(--status-w) minmax(0,1.4fr)",
    );
    expect(squash(read(join(workspace, "frame.css")))).toContain(
      ".ws-list{container-type:inline-size;}",
    );
  });

  it("are loaded once, through the barrel, after Review's and before the Library's boundary", () => {
    const imports = [
      ...read(join(styles, "index.css")).matchAll(/@import "([^"]+)";/g),
    ].map((m) => m[1]);
    expect(new Set(imports).size).toBe(imports.length);
    const ws = imports.filter((i) => i.startsWith("./workspace/"));
    expect(ws).toEqual(SHEETS.map((s) => `./workspace/${s}`));
    const first = imports.indexOf(ws[0]);
    expect(imports.slice(first, first + ws.length)).toEqual(ws);
    expect(imports[first - 1]).toBe("./review/review.css");
    expect(imports[first + ws.length]).toBe("./library/boundary.css");
    // the Library's boundary is last but for later jobs' sheets (Feedback's and Design's, which follow it)
    expect(
      imports
        .filter((i) => !i.startsWith("./feedback/") && !i.startsWith("./design/"))
        .at(-1),
    ).toBe(
      "./library/boundary.css",
    );
    for (const file of filesUnder(join(web, "src")).filter((f) =>
      /\.(tsx?|css)$/.test(f),
    ))
      expect(read(file), file).not.toMatch(
        /import\s+["'][^"']*styles\/workspace\//,
      );
  });

  it("are listed in the sheets' README", () => {
    const readme = read(join(styles, "README.md"));
    for (const name of SHEETS)
      expect(readme, name).toContain(`workspace/${name.replace(".css", "")}`);
  });
});

describe("long status words and long phases in the Workspace's rows", () => {
  const bundle = styleRules(scopeBody(join(styles, "bundle.css")));
  const rule = (prelude: string) => {
    const found = bundle.filter((r) => squash(r.prelude) === prelude);
    expect(found, prelude).toHaveLength(1);
    return squash(found[0].body);
  };

  it("give project home's status column the Workspace's status width", () => {
    // the formatter breaks a long track list inside its parentheses
    const home = squash(read(join(workspace, "home.css")))
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")");
    expect(home).toContain(
      "@container (min-width:44em){.ph-phase{grid-template-columns:3em minmax(10em,19em) var(--status-w) minmax(0,1fr);",
    );
    expect(home).not.toContain("7.5em");
  });

  it("switch the steps to one bar under the least step the model draws", () => {
    const tokens = squash(read(join(styles, "tokens.css")));
    expect(tokens).toContain(`--space-1:${STEPS_GAP}px;`);
    // the least width the list's steps need, n * (least + gap) - gap, against the steps' own width
    const under = `clamp(0px,calc((var(--steps-n,1) * (${STEPS_LEAST}px + var(--space-1)) - var(--space-1) - 100%) * 100000),100%)`;
    expect(rule(".steps-cell > .steps")).toBe(
      "flex-wrap:wrap;height:var(--dot);overflow:clip;",
    );
    // under the fit every step takes a line of its own, out of sight; at or over it, its signed width
    expect(rule(".steps-cell > .steps > i")).toBe(`min-width:${under};`);
    // the bar: as long as its steps would be, no width where they fit, the signed edge, done and now colours
    expect(rule(".steps-bar")).toBe(
      "position:relative;flex:none;width:calc(100% * var(--steps-own,1) / var(--steps-n,1));" +
        `max-width:${under};height:var(--dot);margin-inline-end:calc(-1 * var(--space-1));` +
        "overflow:clip;border-radius:var(--radius-xs);box-shadow:inset 0 0 0 1px var(--edge);",
    );
    expect(rule(".steps-bar::before")).toBe(
      "inset-inline-start:0;width:var(--steps-done);background:var(--ink);",
    );
    expect(rule(".steps-bar::after")).toBe(
      "inset-inline-start:var(--steps-done);width:var(--steps-now);background:var(--accent);",
    );
  });
});

describe("a long word in a list's cell (frame.md F43, F80)", () => {
  /** The declarations every style rule of a sheet gives `selector` (inside any `@container`). */
  const declared = (sheet: string, selector: string) =>
    styleRules(scopeBody(join(workspace, sheet)))
      .filter((r) => selectors(r.prelude).map(squash).includes(selector))
      .map((r) => squash(r.body))
      .join("");

  // Each list's text that sits in a link as wide as its text (`.link-strong`'s `width: fit-content`) or in a flex
  // item (its least width is its longest word): breaking anywhere makes that least width one character, so the row
  // stays inside its list at 320 px whatever word it holds.
  const CELLS: [where: string, sheet: string, selector: string][] = [
    ["every Workspace row's name", "frame.css", ".ws-name-text"],
    [
      "the line under a row's name (an outcome, a trigger, a slice)",
      "frame.css",
      ".ws-sub",
    ],
    ["a row's end cell (a job's source)", "frame.css", ".ws-row > .ws-end"],
    [
      "the backlog's Now cells and waiting list",
      "backlog.css",
      ".backlog-ref > span",
    ],
    ["project home's phase name", "home.css", ".ph-phase .ph-name-text"],
    ["project home's current slice", "home.css", ".ph-phase .ph-sub"],
    ["the docs table's cells", "docs.css", ".docs-table td"],
    // stored prose (`WsProse`) sits in a flex or grid item wherever a page draws it (a slice's one sentence, a
    // stop's words, a job's facts, an item's note, a version's summary, a phase's objective)
    ["stored prose, inline", "frame.css", ".ws-prose"],
    ["stored prose, a long value's block", "frame.css", ".ws-prose-block"],
    // the Markdown body: its paragraphs, list items and table cells inherit it from the text's box
    ["the Markdown body's text", "md.css", ".md"],
  ];

  it.each(CELLS)("breaks inside %s", (_, sheet, selector) => {
    expect(declared(sheet, selector)).toContain("overflow-wrap:anywhere;");
  });
});
