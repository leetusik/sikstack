import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The canvas (P78, F4): html and body take the page's own surface, never the old paper (`--kb-paper`, #f6f2e8), in
// production's root and in the design build's. `canvas.css` cannot read the system's tokens (they are scoped to
// `.ui`), so its values are held equal to `tokens.css`'s here.

const web = join(__dirname, "..");
const read = (path: string) => readFileSync(join(web, path), "utf8");

/** A role's value in the first `tokens.css` block whose selector list starts with `starts`. */
function token(starts: string, role: string): string {
  const css = read("src/sikstack/styles/tokens.css");
  const at = css.indexOf(starts);
  expect(at, starts).toBeGreaterThan(-1);
  const block = css.slice(at, css.indexOf("}", at));
  const m = new RegExp(`${role}:\\s*(#[0-9a-f]{6})`).exec(block);
  expect(m, `${starts} ${role}`).not.toBeNull();
  return m![1];
}

/** The `--page-canvas` value the rule with exactly this selector sets. */
function canvas(selector: string): string {
  const css = read("src/app/canvas.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = m[1].split(",").map((s) => s.trim());
    const value = /--page-canvas:\s*(#[0-9a-f]{6})/.exec(m[2]);
    if (selectors.includes(selector) && value) return value[1];
  }
  throw new Error(`no --page-canvas for ${selector}`);
}

describe("the canvas", () => {
  it("is each page's surface, by tokens.css's own values", () => {
    const light = ':scope, [data-theme="light"]';
    const dark = ':scope[data-theme="dark"]';
    const sepia = '[data-scheme="sepia"]';
    expect(canvas("html")).toBe(token(light, "--bg"));
    expect(canvas('html:has(.ui[data-scheme="dark"])')).toBe(
      token(dark, "--bg"),
    );
    expect(canvas("html:has(.ui .app.reader)")).toBe(token(light, "--surface"));
    expect(canvas('html:has(.ui .app.reader[data-scheme="light"])')).toBe(
      token(light, "--surface"),
    );
    expect(canvas('html:has(.ui .app.reader[data-scheme="dark"])')).toBe(
      token(dark, "--surface"),
    );
    expect(
      canvas(
        'html:has(.ui[data-scheme="dark"] .app.reader:not([data-scheme]))',
      ),
    ).toBe(token(dark, "--surface"));
    expect(canvas('html:has(.ui .app.reader[data-scheme="sepia"])')).toBe(
      token(sepia, "--surface"),
    );
  });

  it("paints html and body, and no root draws the old paper as its canvas", () => {
    const css = read("src/app/canvas.css");
    expect(css).toMatch(
      /html\s*\{[^}]*background-color:\s*var\(--page-canvas\)/,
    );
    expect(css).toMatch(
      /body\s*\{[^}]*background-color:\s*var\(--page-canvas\)/,
    );
    for (const layout of ["src/app/layout.tsx", "design/app/layout.tsx"]) {
      const code = read(layout);
      expect(code, layout).toMatch(
        /import "(\.\/|\.\.\/\.\.\/src\/app\/)canvas\.css";/,
      );
      expect(code, layout).not.toMatch(/<body[^>]*\bbg-canvas\b/);
      expect(code, layout).toMatch(/<html\s+lang="en"/);
    }
    // the reader's rule paints too, so it outranks reader.css's `html:has(.rd-root[…])` (0,2,1) at (0,3,1)
    expect(css).toMatch(
      /html:has\(\.ui \.app\.reader\)\s*\{[^}]*background-color:\s*var\(--page-canvas\)/,
    );
    expect(read("src/app/globals.css")).not.toMatch(
      /body\s*\{\s*@apply[^;]*\bbg-canvas\b/,
    );
    expect(read("src/app/manifest.ts")).not.toMatch(/f6f2e8/i);
  });

  it("an old page inside the Shell paints the system's light ground as its paper, never the old beige", () => {
    const css = read("src/app/canvas.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const m =
      /@media not \(prefers-color-scheme: dark\)\s*\{\s*\.kb-app\.kb-legacy-page\s*\{\s*--kb-paper:\s*(#[0-9a-f]{6});/.exec(
        css,
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe(token(':scope, [data-theme="light"]', "--bg"));
    expect(read("src/sikstack/shell/legacy-page.tsx")).toMatch(/className="kb-app kb-legacy-page"/);
  });
});
