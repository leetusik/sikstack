import Link from "next/link";

import { READER_DOCUMENT } from "@/content/reader-document";

import type { DocPhaseRow } from "./model";

/**
 * The way back from a document to the phases it was explained from (P61-e9; unsigned, it mirrors the phase
 * page's signed **Explained in**): a heading, then one row a phase, the explain phase first, its name as a link
 * to its phase page with `P48-q4 · Explain phase` under it. Under the document's end, in the reader's column.
 * No rows (a visitor, a project with no linked workspace, a document no phase names), nothing.
 */
export function DocumentPhases({ rows }: { rows: readonly DocPhaseRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="read-end" aria-labelledby="doc-phases-head">
      <h2 id="doc-phases-head" className="end-next-title">
        {READER_DOCUMENT.phases.heading}
      </h2>
      <ul className="chapters">
        {rows.map((r) => (
          <li key={r.key}>
            <Link className="link-strong chapter-open" href={r.href}>
              <span className="row-stack">
                <span lang={r.lang}>{r.name}</span>
                <span className="meta">{r.sub}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
