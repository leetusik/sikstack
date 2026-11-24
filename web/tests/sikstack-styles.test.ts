import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// What the repo can see of the sikstack system's isolation (src/sikstack/styles/README.md): every rule of the
// signed sheets sits in the one scope, the boundary restores every custom property the system declares,
// no canvas-only class is built, and no colour is written outside the tokens.

const web = fileURLToPath(new URL("..", import.meta.url));
const styles = join(web, "src/sikstack/styles");
const read = (path: string) => readFileSync(path, "utf8");
const SCOPE = "@scope (.ui) to ([data-ui-legacy])";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The top-level statements of a sheet: `{ prelude, body }` for each block, at brace depth 0. */
function topLevel(css: string): { prelude: string; body: string }[] {
  const text = stripComments(css);
  const out: { prelude: string; body: string }[] = [];
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

/** Custom properties declared (`--x:`) in a stretch of CSS. */
function declared(css: string): Set<string> {
  return new Set(
    [...stripComments(css).matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map(
      (m) => m[1],
    ),
  );
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("the sikstack sheets", () => {
  it("scope every rule of tokens.css and bundle.css to .ui, stopped at the boundary", () => {
    for (const name of ["tokens.css", "bundle.css"]) {
      const blocks = topLevel(read(join(styles, name)));
      const scoped = blocks.filter((b) => b.prelude === SCOPE);
      const other = blocks.filter((b) => b.prelude !== SCOPE);
      expect(scoped.length, name).toBe(1);
      // A keyframes rule matches no element; nothing else may sit outside the scope.
      expect(
        other.map((b) => b.prelude),
        name,
      ).toEqual(
        name === "bundle.css" ? ["@keyframes skel", "@keyframes say-turn"] : [],
      );
    }
  });

  it("restore, at the boundary, every custom property the system declares", () => {
    const system = new Set([
      ...declared(read(join(styles, "tokens.css"))),
      ...declared(read(join(styles, "bundle.css"))),
    ]);
    const blocks = topLevel(read(join(styles, "boundary.css")));
    expect(blocks.map((b) => b.prelude)).toEqual([
      ":root",
      ".ui [data-ui-legacy]",
    ]);
    const [saves, restores] = blocks;

    const saveDecls = [
      ...stripComments(saves.body).matchAll(
        /(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/g,
      ),
    ];
    // On :root only new names are declared, each a copy of one system name.
    expect(
      saveDecls.every((m) => m[1] === `--sikstack-legacy${m[2].slice(1)}`),
    ).toBe(true);
    expect(new Set(saveDecls.map((m) => m[2]))).toEqual(system);
    expect(declared(saves.body).size).toBe(system.size);

    const restored = [
      ...stripComments(restores.body).matchAll(
        /(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)/g,
      ),
    ];
    expect(
      restored.every((m) => m[2] === `--sikstack-legacy${m[1].slice(1)}`),
    ).toBe(true);
    expect(new Set(restored.map((m) => m[1]))).toEqual(system);
  });

  it("are loaded once, by the root layout, outside Tailwind's processing", () => {
    const layout = read(join(web, "src/app/layout.tsx"));
    expect(layout).toMatch(
      /import "\.\/globals\.css";\s*import "@\/sikstack\/styles\/index\.css";/,
    );
    const globals = read(join(web, "src/app/globals.css"));
    expect(globals).not.toMatch(/@import[^;]*sikstack/);
    expect(globals).toMatch(/@source not "\.\.\/sikstack";/);
    expect(read(join(styles, "index.css"))).toMatch(
      /@import "\.\/tokens\.css";\s*@import "\.\/bundle\.css";\s*@import "\.\/boundary\.css";/,
    );
  });

  it("load the system, then each job's sheets as one run: the Library's (its boundary after Listen's, Review's and the Workspace's), then Feedback's, then Design's", () => {
    const imports = [
      ...read(join(styles, "index.css")).matchAll(/@import "([^"]+)";/g),
    ].map((m) => m[1]);
    const group = (i: string) => /^\.\/([a-z-]+)\//.exec(i)?.[1] ?? "system";
    const runs = imports
      .map(group)
      .filter((g, i, all) => i === 0 || all[i - 1] !== g);
    expect(runs).toEqual([
      "system",
      "library",
      "listen",
      "review",
      "workspace",
      "library",
      "feedback",
      "design",
    ]);
  });
});

describe("src/sikstack", () => {
  const files = filesUnder(join(web, "src/sikstack")).filter((f) =>
    /\.(css|tsx?)$/.test(f),
  );

  it("builds no canvas-only class (bundle section 7, the state bar, the stand-ins)", () => {
    for (const file of files) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(
        /\.spec\b|\.spec-|\.sc-host|data-proto|#dc-root/,
      );
    }
  });

  it("writes no colour value outside tokens.css", () => {
    for (const file of files.filter((f) => !f.endsWith("styles/tokens.css"))) {
      const code = stripComments(read(file));
      expect(code, file).not.toMatch(
        /#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\(|\bhsla?\(/,
      );
    }
  });
});

describe("the app's stylesheets and fonts", () => {
  it("name no Google font host", () => {
    for (const file of filesUnder(join(web, "src")).filter((f) =>
      /\.(css|tsx?)$/.test(f),
    )) {
      expect(read(file), file).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});
