import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  MD_DEFAULT_ANCHOR,
  MD_DEFAULT_LEVEL,
  mdHasOutline,
  mdImageSrc,
  type MdSection,
  mdSections,
  remarkWorkspaceMd,
} from "./md-model";
import { MD_WORDS } from "./words";

export interface MdProps {
  /** The Markdown, a string. */
  source: string;
  /** Drops a leading `# …` line: the page's `h1` already says it. */
  dropTitle?: boolean;
  /** Draws the way to a section (with three or more first-step headings). */
  outline?: boolean;
  /** The `aria-level` of the first heading step: 2 (default) under the page's `h1`, 3 in a panel headed by an `h2`. */
  level?: number;
  /** A prefix for the section ids, unique on the page (`plan`, `result`). */
  anchor?: string;
}

/**
 * A link's address when it is one the reader can open: an absolute web address. Any other (a path to a workspace
 * file, `../../retrofit-guide.md`, `topics/x.md`, `intent.md`; a path in the app; a fragment; another scheme) has
 * no address here and would land on the app's Not found, so its link draws as its text alone, as stored prose
 * draws every link (`WsProse`).
 */
function mdLinkHref(href: string | undefined): string | null {
  return href && /^https?:\/\/[^/]/i.test(href) ? href : null;
}

/**
 * A code block and a table each scroll sideways in their own focusable box, named Code or Table, so the page
 * never does (F46). A table is the system's `.table`; its head cells name their column.
 */
const COMPONENTS: Components = {
  pre: ({ node: _node, ...rest }) => (
    <div
      className="table-scroll md-code"
      tabIndex={0}
      role="region"
      aria-label={MD_WORDS.code}
    >
      <pre {...rest} />
    </div>
  ),
  table: ({ node: _node, className: _className, ...rest }) => (
    <div
      className="table-scroll md-table"
      tabIndex={0}
      role="region"
      aria-label={MD_WORDS.table}
    >
      <table {...rest} className="table" />
    </div>
  ),
  th: ({ node: _node, ...rest }) => <th scope="col" {...rest} />,
  img: ({ node: _node, src, alt, ...rest }) => {
    const own = mdImageSrc(typeof src === "string" ? src : undefined);
    // eslint-disable-next-line @next/next/no-img-element
    return own ? <img {...rest} src={own} alt={alt ?? ""} /> : <>{alt ?? ""}</>;
  },
  a: ({ node: _node, href, children, ...rest }) =>
    mdLinkHref(href) ? (
      <a {...rest} href={href}>
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
};

function SectionList({ sections }: { sections: readonly MdSection[] }) {
  return (
    <ul>
      {sections.map((s) => (
        <li key={s.href}>
          <a className="md-outline-link" href={s.href}>
            {s.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The Workspace's Markdown body (design job 02, frame.md F46; `Md.dc.html`): plans, results, intents, briefs
 * and docs, drawn by a real renderer (`react-markdown` with GitHub's tables, `remark-gfm`) with the `.md`
 * classes. It always sits in a `.panel-body` under a head that names it. Raw HTML in a source is never
 * rendered: it shows as the text it is. A link to an absolute web address is an ordinary link to it; any other
 * link is its text (`mdLinkHref`). An image from another host is its alt text (`mdImageSrc`, D310).
 *
 * With `outline` and three or more first-step headings, the way to a section: a closed **Sections**
 * disclosure above the text, and a list beside it that stays in view from 60em of the body's box (the sheet
 * shows one or the other by the box's width).
 */
export function Md({
  source,
  dropTitle = false,
  outline = false,
  level = MD_DEFAULT_LEVEL,
  anchor = MD_DEFAULT_ANCHOR,
}: MdProps) {
  const opts = { dropTitle, level, anchor };
  const sections = mdSections(source, opts);
  const hasOutline = mdHasOutline(outline, sections);
  return (
    <div className="md-wrap">
      <div className="md-layout">
        {hasOutline ? (
          <details className="md-jump">
            <summary>{MD_WORDS.sections}</summary>
            <SectionList sections={sections} />
          </details>
        ) : null}
        <div className="md" id={anchor}>
          <Markdown
            remarkPlugins={[remarkGfm, [remarkWorkspaceMd, opts]]}
            components={COMPONENTS}
          >
            {source}
          </Markdown>
        </div>
        {hasOutline ? (
          <nav className="md-outline" aria-label={MD_WORDS.sections}>
            <p className="md-outline-title">{MD_WORDS.sections}</p>
            <SectionList sections={sections} />
          </nav>
        ) : null}
      </div>
    </div>
  );
}
