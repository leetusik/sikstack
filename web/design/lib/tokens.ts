/**
 * The product's tokens as `src/sikstack/styles/tokens.css` writes them, read from the file at build time
 * (`app/system/page.tsx`), never copied by hand. Pure: the page passes the file's text in. A group is one
 * rule of the file (the light roles, the dark roles, Sepia, the scale), in the file's order, its custom
 * properties in the file's order; the `.type-*` rules are the type classes. `design/scripts/build.mjs`
 * reads the file again on its own and fails when `/system/`'s list differs from it.
 */
export type TokenKind = "colour" | "shadow" | "space" | "radius" | "size" | "line" | "font" | "other";

export interface Token {
  name: string;
  value: string;
  kind: TokenKind;
}

export interface TokenGroup {
  /** The rule's selector, as the file writes it. */
  selector: string;
  /** `light`, `dark`, `sepia` for the colour roles (the scheme a sample must sit in); `null` for the scale. */
  scheme: "light" | "dark" | "sepia" | null;
  tokens: Token[];
  /** The rule's other declarations (`color-scheme: light`). */
  other: { name: string; value: string }[];
}

export interface TypeClass {
  name: string;
  declarations: { name: string; value: string }[];
}

export interface TokenSheet {
  groups: TokenGroup[];
  typeClasses: TypeClass[];
}

function kindOf(name: string, value: string): TokenKind {
  if (name.includes("shadow")) return "shadow";
  if (/^--space-/.test(name)) return "space";
  if (/^--radius-/.test(name)) return "radius";
  if (/^--fs-/.test(name)) return "size";
  if (/^--lh-/.test(name)) return "line";
  if (/^--font-/.test(name)) return "font";
  if (/^(#|rgba?\(|hsla?\()/.test(value)) return "colour";
  return "other";
}

function schemeOf(selector: string): TokenGroup["scheme"] {
  if (selector.includes('"dark"')) return "dark";
  if (selector.includes('"sepia"')) return "sepia";
  if (selector.includes('"light"')) return "light";
  return null;
}

function declarations(body: string): { name: string; value: string }[] {
  return body
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(":");
      return { name: d.slice(0, at).trim(), value: d.slice(at + 1).trim() };
    });
}

export function parseTokens(css: string): TokenSheet {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const groups: TokenGroup[] = [];
  const typeClasses: TypeClass[] = [];
  // The innermost rules: a selector, then a body with no nested braces.
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, " ");
    const decls = declarations(m[2]);
    if (/^\.type-/.test(selector)) {
      typeClasses.push({ name: selector.slice(1), declarations: decls });
      continue;
    }
    const tokens = decls
      .filter((d) => d.name.startsWith("--"))
      .map((d) => ({ ...d, kind: kindOf(d.name, d.value) }));
    if (tokens.length === 0) continue;
    groups.push({
      selector,
      scheme: schemeOf(selector),
      tokens,
      other: decls.filter((d) => !d.name.startsWith("--")),
    });
  }
  return { groups, typeClasses };
}

/** Every custom property the sheet declares, once each, in the file's order. */
export function tokenNames(sheet: TokenSheet): string[] {
  return [...new Set(sheet.groups.flatMap((g) => g.tokens.map((t) => t.name)))];
}
