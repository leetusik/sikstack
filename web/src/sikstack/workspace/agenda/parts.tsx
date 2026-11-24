import type { CSSProperties, MouseEventHandler, ReactNode, Ref } from "react";
import Link from "next/link";

import { AGENDA } from "@/content/workspace/agenda";
import { Author, RefusedBadge, WaitingBadge } from "@/sikstack/workspace/frame";
import { cx } from "@/lib/cx";

import type { AgendaRowModel } from "./model";

// The Agenda's parts that hold no state of their own (`AgendaList.dc.html`, frame.md F302, F303): a part's head,
// a row, the loading part. Shared by the client list and the server's loading state.

/**
 * A part's head (`.panel-head.agenda-head`, a grid): an empty 44 px cell over the grips (from 30em of the part),
 * the column of the rows' boxes, then the title and its count, baseline-aligned, and the part's actions at the
 * end. `check` takes the boxes' column (the select-all box); without it the column stays empty.
 */
export function PartHead({
  headId,
  head,
  count,
  check,
  children,
}: {
  headId: string;
  head: string;
  /** `5 items`; `"loading"` a bar; `null` none (the part failed). */
  count: string | "loading" | null;
  check?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="panel-head agenda-head">
      <span className="agenda-head-pad" aria-hidden="true" />
      {check ?? null}
      <div className="agenda-head-main">
        <div className="agenda-head-title">
          <h2 id={headId}>{head}</h2>
          {count === "loading" ? (
            <p className="meta">
              <span className="skel" style={{ width: "4em" }} />
            </p>
          ) : count !== null ? (
            <p className="meta agenda-head-count">{count}</p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A row (`li.row.agenda-row`, F302): the grip's column, the boxes' column, the frame's Workspace row as the body
 * (a size container, so F43's four layouts follow the body's width), then **Delete**. `lead` is the open part's grip;
 * without it the grip's column is the empty `span.agenda-nogrip`, so the three parts share their edges. `check` is
 * the row's box; `className` carries `is-selected` (a picked row) and `is-lifted`.
 *
 * `action` takes Delete's place (P61-e9: a Proposed row's **Accept**); a Proposed row's end cell is who proposed it
 * (an agent marked `Agent`) and the day.
 */
export function AgendaRow({
  row,
  href,
  className,
  style,
  lead,
  check,
  linkRef,
  deleteRef,
  onDelete,
  action,
}: {
  row: AgendaRowModel;
  href: string;
  className?: string;
  /** A drag's slide (`transform`), while a pointer drags the open part's rows. */
  style?: CSSProperties;
  lead?: ReactNode;
  check?: ReactNode;
  linkRef?: Ref<HTMLAnchorElement>;
  deleteRef?: Ref<HTMLButtonElement>;
  onDelete?: MouseEventHandler<HTMLButtonElement>;
  /** What stands in Delete's place, when the row's part acts otherwise. */
  action?: ReactNode;
}) {
  return (
    <li
      className={cx("row agenda-row", className)}
      style={style}
      data-row={row.id}
    >
      {lead ?? <span className="agenda-nogrip" aria-hidden="true" />}
      {check ?? null}
      <div className="agenda-body">
        <div className="ws-row agenda-cells">
          <span className="ws-id">{row.id}</span>
          <Link
            className="link-strong ws-open ws-name"
            href={href}
            ref={linkRef}
          >
            <span className="row-stack">
              <span className="agenda-title">
                <span className="ws-name-text" lang={row.lang}>
                  {row.title}
                </span>
                {row.mark === "waiting" ? <WaitingBadge /> : null}
                {row.mark === "refused" ? <RefusedBadge /> : null}
              </span>
            </span>
          </Link>
          <span className={cx(row.status.cls, "ws-state")}>
            {row.status.word}
          </span>
          {row.proposed ? (
            <span className="ws-end agenda-by">
              {row.proposed.by ? <Author author={row.proposed.by} /> : null}
              <span className="dim">{row.proposed.day}</span>
            </span>
          ) : row.end ? (
            <span className="dim ws-end">{row.end}</span>
          ) : null}
        </div>
      </div>
      {action ?? (
        <button
          type="button"
          className="agenda-del"
          aria-label={AGENDA.row.deleteLabel(row.title)}
          ref={deleteRef}
          onClick={onDelete}
        >
          {AGENDA.row.delete}
        </button>
      )}
    </li>
  );
}

const WAIT: [string, string, string, string][] = [
  ["3em", "18em", "6em", "9em"],
  ["3em", "24em", "4em", "9em"],
  ["3.5em", "14em", "4em", "7em"],
  ["3em", "21em", "4em", "7em"],
  ["3.5em", "16em", "4em", "9em"],
];

/** Five skeleton rows of a row's height, a bar inside each cell's own element (F24, F49). */
export function LoadingRows() {
  return (
    <ul className="ws-list" aria-hidden="true">
      {WAIT.map(([id, name, state, end], i) => (
        <li key={i} className="row ws-row agenda-wait">
          <span className="ws-id">
            <span className="skel" style={{ width: id }} />
          </span>
          <span className="ws-name">
            <span className="skel" style={{ width: name }} />
          </span>
          <span className="ws-state">
            <span className="skel" style={{ width: state }} />
          </span>
          <span className="ws-end">
            <span className="skel" style={{ width: end }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The agenda while it loads (Loading): the first part's head stands with a bar for its count and **Add item**
 * disabled; five skeleton rows; `aria-busy` and a hidden `Loading…`. The other parts are not drawn.
 */
export function AgendaLoading({ headId }: { headId: string }) {
  return (
    <div className="stack gap-5">
      <section
        className="panel agenda-part"
        aria-labelledby={headId}
        aria-busy="true"
      >
        <PartHead headId={headId} head={AGENDA.heads.open} count="loading">
          <div className="cluster agenda-head-acts agenda-add">
            <button type="button" className="btn" disabled>
              {AGENDA.addItem}
            </button>
          </div>
        </PartHead>
        <LoadingRows />
        <span className="sr-only">{AGENDA.loading}</span>
      </section>
    </div>
  );
}
