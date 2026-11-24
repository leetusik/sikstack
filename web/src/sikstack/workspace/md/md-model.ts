import type { Heading, Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * The Workspace's Markdown body (design job 02, frame.md F46), its pure half: no React, no I/O.
 *
 * `prepareMd` shapes a parsed tree the way the signed `Md` draws it, before the renderer turns it into
 * elements: it drops a leading `# …` line when the page's `h1` already says it (`dropTitle`); it gives
 * every heading one of three steps (the shallowest heading in the body takes the first step, the next the
 * second, anything deeper the third) as `div.md-h<step>` with `role="heading"` and `aria-level` counted
 * from `level`; and it gives each first-step heading the id `<anchor>-<n>`, the way to that section.
 */
export interface MdOptions {
  /** Drops a leading `# …` line: the page's `h1` already says it. */
  dropTitle?: boolean;
  /** The `aria-level` of the first heading step: 2 under the page's `h1`, 3 in a panel headed by an `h2`. */
  level?: number;
  /** A prefix for the section ids, unique on the page (`plan`, `result`). */
  anchor?: string;
}

/** A first-step heading: its plain text and the in-page link to it. */
export interface MdSection {
  text: string;
  href: string;
}

/** The fewest first-step headings that earn the way to a section (F46: "three or more"). */
export const MD_OUTLINE_MIN = 3;

export const MD_DEFAULT_LEVEL = 2;
export const MD_DEFAULT_ANCHOR = "md";

/** The plain text of a node: what a heading says, without its marks. */
function plainText(node: Nodes): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  if ("children" in node)
    return (node.children as Nodes[]).map(plainText).join("");
  if (node.type === "image") return node.alt ?? "";
  return "";
}

function headings(root: Root): Heading[] {
  const out: Heading[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "heading") out.push(node);
    if ("children" in node) for (const c of node.children as Nodes[]) walk(c);
  };
  walk(root);
  return out;
}

/** Shapes the tree in place (above) and returns its sections, in order. */
export function prepareMd(root: Root, opts: MdOptions = {}): MdSection[] {
  const anchor = opts.anchor || MD_DEFAULT_ANCHOR;
  const base = Number(opts.level) || MD_DEFAULT_LEVEL;
  const first = root.children[0];
  if (opts.dropTitle && first?.type === "heading" && first.depth === 1)
    root.children.shift();
  const all = headings(root);
  const depths = [...new Set(all.map((h) => h.depth))].sort((a, b) => a - b);
  const sections: MdSection[] = [];
  for (const h of all) {
    const step = Math.min(depths.indexOf(h.depth), 2) + 1;
    const props: Record<string, unknown> = {
      className: [`md-h${step}`],
      role: "heading",
      ariaLevel: base + step - 1,
    };
    if (step === 1) {
      const id = `${anchor}-${sections.length + 1}`;
      props.id = id;
      sections.push({ text: plainText(h).trim(), href: `#${id}` });
    }
    h.data = { ...h.data, hName: "div", hProperties: props as never };
  }
  return sections;
}

/** The remark plugin the renderer runs: `prepareMd` on its own tree. */
export function remarkWorkspaceMd(opts: MdOptions = {}) {
  return (tree: Root) => {
    prepareMd(tree, opts);
  };
}

const parser = unified().use(remarkParse).use(remarkGfm).freeze();

/** The sections of a source as `Md` draws them, for the way to a section. */
export function mdSections(source: string, opts: MdOptions = {}): MdSection[] {
  const tree = parser.runSync(parser.parse(source)) as Root;
  return prepareMd(tree, opts);
}

/** Whether `Md` draws the way to a section: asked for, and three or more first-step headings. */
export function mdHasOutline(
  outline: boolean | undefined,
  sections: readonly MdSection[],
): boolean {
  return !!outline && sections.length >= MD_OUTLINE_MIN;
}

/**
 * Whether an image's address stays on this site (D310): a path, never another host. An address with a scheme
 * (`https:`, `data:`, …) or a protocol-relative one (`//host/…`) would make the reader's browser fetch from wherever
 * it names, so it is drawn as its alt text instead.
 */
export function mdImageSrc(src: string | undefined): string | null {
  if (!src) return null;
  const s = src.trim();
  // a scheme, or two leading slashes in any mix with backslashes (`//host`, `/\\host`), escaped or not: another host
  let plain = s;
  try {
    plain = decodeURIComponent(s);
  } catch {
    // a malformed escape: judged as written
  }
  for (const form of [s, plain])
    if (/^[a-z][a-z0-9+.-]*:/i.test(form) || /^[\\/]{2}/.test(form))
      return null;
  return s;
}
