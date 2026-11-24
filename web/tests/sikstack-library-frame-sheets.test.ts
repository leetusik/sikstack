import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The Library's sheets change no other page (src/sikstack/styles/README.md; P58-yw's *Isolation* and
// *Class names*): every rule sits in the system's one scope, so nothing outside a `.ui` root and nothing
// at or under `[data-ui-legacy]` matches; no rule names only system classes (a job's sheet never
// redefines a system name), so no existing system page's markup gains a declaration; the custom
// properties the Library adds are restored at the old-page boundary; the barrel loads each sheet once.

const web = fileURLToPath(new URL("..", import.meta.url));
const styles = join(web, "src/sikstack/styles");
const library = join(styles, "library");
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

/** Every style rule inside a block, descending into `@container` and `@media`. */
function styleRules(css: string): Block[] {
  return blocks(css).flatMap((b) =>
    b.prelude.startsWith("@") ? styleRules(b.body) : [b],
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

/** Custom properties declared (`--x:`) in a stretch of CSS. */
const declared = (css: string) =>
  new Set(
    [...stripComments(css).matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map(
      (m) => m[1],
    ),
  );

/** The declarations of one rule's body, by property. */
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

const SHEETS = readdirSync(library)
  .filter((f) => f.endsWith(".css") && f !== "boundary.css")
  .sort();

/** The one rule on a system name, with why it changes no page: see the test below. */
const ON_SYSTEM_NAMES = new Set(["button.link-row"]);

/** The Library's parts: the only folders whose `.tsx` may draw `.link-row` on a `<button>`. */
const LIBRARY_PARTS = [
  "/sikstack/library/",
  "/components/book/",
  "/sikstack/reader/",
  // Listen's and Review's heads (job 07): their boards draw `button.link-row` (Listen's Start over, F207;
  // Review's head), and they mount only on the reading pages and Review, never on a page from before the Library.
  "/sikstack/listen/",
  "/sikstack/review/",
  // The Workspace's agenda (job 02): its board draws `button.link link-row` (the ended part's Show all),
  // and it mounts only under a project's Workspace, never on a page from before the Library.
  "/sikstack/workspace/",
  // sikstack's connect page (job 09): its board draws `button.link link-row` (another account's Sign out, F532),
  // and it is a page of its own in the sign-in frame, never a page from before the Library.
  "/app/(auth)/connect/",
  // The invite link's column (P78-s2.S2's signed design), drawn as the connect page's: another account's Sign out
  // and Already a member's Open <org> are `button.link link-row`, on a page of its own in the sign-in frame.
  "/sikstack/org/invite.tsx",
];

describe("the Library's sheets", () => {
  it("are the frame and one sheet a later part, each owned and named", () => {
    expect(SHEETS).toEqual([
      "annotations.css",
      "blocks.css",
      "book-notes.css",
      "book.css",
      "document.css",
      "frame.css",
      "lists.css",
      "project-library.css",
      "public-library.css",
      "reader.css",
    ]);
    for (const name of SHEETS.filter((f) => f !== "frame.css"))
      expect(read(join(library, name)), name).toMatch(/Owner: P63-fk\.S\d+/);
  });

  it("scope every rule to .ui, stopped at the old-page boundary", () => {
    for (const name of SHEETS) {
      const top = blocks(read(join(library, name)));
      expect(
        top.map((b) => b.prelude),
        name,
      ).toEqual([SCOPE]);
    }
  });

  it("add no rule that names only system classes, but for the custom properties of a root", () => {
    const system = new Set([
      ...classesOf(read(join(styles, "tokens.css"))),
      ...classesOf(read(join(styles, "bundle.css"))),
    ]);
    const offenders: string[] = [];
    for (const name of SHEETS) {
      for (const [scoped] of [blocks(read(join(library, name)))])
        for (const rule of styleRules(scoped.body)) {
          const onlyCustom = properties(rule.body).every((p) =>
            p.startsWith("--"),
          );
          for (const sel of selectors(rule.prelude)) {
            const own = [...classesOf(sel)].filter((c) => !system.has(c));
            if (own.length === 0 && !onlyCustom && !ON_SYSTEM_NAMES.has(sel))
              offenders.push(`${name}: ${sel}`);
          }
        }
    }
    expect(offenders).toEqual([]);
  });

  it("put .link-row's button form on no button outside the Library's parts", () => {
    // `button.link-row` (frame.css section 1) only makes a `<button>` read as the system's `.link-row`
    // does on an `a`. It stays inside the Library's parts (LIBRARY_PARTS: the Library's own folder,
    // the book page and the reader's head and foot), so no page from before the Library changes its look.
    const tsx = filesUnder(join(web, "src")).filter(
      (f) =>
        f.endsWith(".tsx") && !LIBRARY_PARTS.some((part) => f.includes(part)),
    );
    const onButtons: string[] = [];
    for (const file of tsx) {
      const code = read(file);
      for (const m of code.matchAll(/className=\{?["'`][^"'`]*\blink-row\b/g)) {
        const tag = /<([A-Za-z][\w.]*)[^<]*$/.exec(code.slice(0, m.index));
        if (tag && tag[1].toLowerCase() === "button") onButtons.push(file);
      }
    }
    expect(onButtons).toEqual([]);
  });

  it("restore, at the boundary, every custom property they add to the system's", () => {
    const system = new Set([
      ...declared(read(join(styles, "tokens.css"))),
      ...declared(read(join(styles, "bundle.css"))),
    ]);
    const added = new Set(
      SHEETS.flatMap((name) => [...declared(read(join(library, name)))]).filter(
        (p) => !system.has(p),
      ),
    );
    expect(added.size).toBeGreaterThan(0);
    const [saves, restores] = blocks(read(join(library, "boundary.css")));
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

  it("are loaded once, through the system's barrel, after the system and before their boundary", () => {
    const imports = [
      ...read(join(styles, "index.css")).matchAll(/@import "([^"]+)";/g),
    ].map((m) => m[1]);
    expect(imports.slice(0, 4)).toEqual([
      "./tokens.css",
      "./bundle.css",
      "./boundary.css",
      "./library/frame.css",
    ]);
    // the Library's parts are one run, its boundary last; Listen's, Review's and the Workspace's sheets
    // sit between them, and a later job's sheets (Feedback's) follow the boundary
    const own = imports.filter((i) => i.startsWith("./library/"));
    const at = imports.indexOf("./library/frame.css");
    expect(imports.slice(at, at + own.length - 1)).toEqual(own.slice(0, -1));
    expect(own.at(-1)).toBe("./library/boundary.css");
    expect(new Set(imports).size).toBe(imports.length);
    expect(
      imports
        .filter((i) => i.startsWith("./library/"))
        .map((i) => i.slice("./library/".length))
        .sort(),
    ).toEqual([...SHEETS, "boundary.css"].sort());
    // no page or component imports a Library sheet of its own (D155-bn)
    for (const file of filesUnder(join(web, "src")).filter((f) =>
      /\.(tsx?|css)$/.test(f),
    ))
      expect(read(file), file).not.toMatch(
        /import\s+["'][^"']*styles\/library\//,
      );
  });

  it("answer the reader's three schemes: light, dark and sepia (F57)", () => {
    const tokens = stripComments(read(join(styles, "tokens.css")));
    expect(tokens).toMatch(/\[data-scheme="light"\]\s*\{/);
    const sepia = /\[data-scheme="sepia"\]\s*\{([^}]*)\}/.exec(tokens);
    expect(sepia).not.toBeNull();
    const roles = declared(sepia![1]);
    for (const role of [
      "--bg",
      "--surface",
      "--ink",
      "--ink-2",
      "--line",
      "--edge",
      "--accent",
      "--accent-tint",
      "--on-accent",
      "--danger",
      "--danger-tint",
      "--hover",
      "--scrim",
      "--shadow",
    ])
      expect(roles.has(role), role).toBe(true);
  });
});
