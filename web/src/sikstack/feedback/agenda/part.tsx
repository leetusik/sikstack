import Link from "next/link";
import type { Ref } from "react";

import { ADD, AGENDA } from "@/content/feedback-agenda";
import { PARTS } from "@/content/feedback-frame";
import { Status } from "@/sikstack/ui/marks";
import { agendaStatus, type AgendaStatus } from "@/lib/feedback/agenda";
import { PAGE_LANG } from "@/lib/feedback/lang";

import { PROPOSED } from "@/content/workspace/agenda-thread";

import { Waiting } from "../marks";
import type { AgendaPageState, AgendaPartItem } from "./model";

/** The Agenda part's states: what the feedback became, or why the add is not offered. */
export type AgendaPartState = Exclude<AgendaPageState, { kind: "offered" }>;

/**
 * The Agenda part (`FeedbackItemAgenda.dc.html`; `result.md` § The Agenda part; frame.md F341, F342,
 * F344), between Comment and Details, only once the feedback was added (waiting, then filed) or when
 * the add is not offered. Waiting and filed: one row, the item's id in the second ink, its title as the
 * link to the item in the Workspace with `Waiting for sync` beside it while it waits, and its status in
 * the Workspace's word and shape; waiting adds the sync sentence under it. Not offered: the sentence
 * that says why. Presentational; renders on the server or in the add's island alike.
 *
 * Decided as drawn: the board's `button.link-strong.fi-item-open` (its `on-open-item`) is a link to the
 * item's own page (`item.href`), drawn in the board's classes.
 *
 * P61-e9: one row for each item the feedback is on, in the Agenda's order, each
 * with its own `Waiting for sync`; the sync sentence once, under the rows, while any of them waits. An item still
 * Proposed reads Proposed.
 */
export function AgendaPart({ state }: { state: AgendaPartState }) {
  return (
    <section className="panel" aria-label={PARTS.agenda}>
      <div className="panel-head">
        <h2>{PARTS.agenda}</h2>
      </div>
      {state.kind === "not-offered" ? (
        <div className="panel-body has-rule block">
          <p className="block-text">{state.text}</p>
        </div>
      ) : (
        <AgendaItemRows state={state} />
      )}
    </section>
  );
}

const KNOWN: readonly string[] = [
  "open",
  "in_progress",
  "deferred",
  "solved",
  "dropped",
];

/** The item's state in the Workspace's word and shape; Proposed in its own (the Agenda's Proposed part). */
function ItemStatus({ state }: { state: string | null }) {
  if (state === "proposed")
    return <span className={PROPOSED.cls}>{PROPOSED.word}</span>;
  const status = agendaStatus(
    (KNOWN.includes(state ?? "") ? state : "open") as AgendaStatus,
  );
  return <Status state={status.shape}>{status.word}</Status>;
}

function AgendaItemRows({
  state,
}: {
  state: Extract<AgendaPartState, { kind: "filed" | "waiting" }>;
}) {
  const waiting = state.kind === "waiting";
  return (
    <>
      <ul className="fi-items">
        {state.items.map((item: AgendaPartItem) => (
          <li key={item.id} className="row fi-item">
            <span className="dim">{item.id}</span>
            <span className="fi-item-title">
              <Link
                className="link-strong fi-item-open"
                href={item.href}
                lang={item.lang !== PAGE_LANG ? item.lang : undefined}
              >
                {item.title ?? item.id}
              </Link>
              {item.sync === "waiting" ? <Waiting /> : null}
            </span>
            <ItemStatus state={item.state} />
          </li>
        ))}
      </ul>
      {waiting ? (
        <div className="panel-body has-rule">
          <p className="meta">{AGENDA.sync}</p>
        </div>
      ) : null}
    </>
  );
}

/**
 * The head's end once added (F341, F344): `Added to agenda` at weight 500, no badge, waiting or not. It
 * holds the button's place, one control tall (`div.fi-send`), and takes focus once after an add
 * (`tabindex=-1`, the add's island focuses it); a page that opens on a record already added moves none.
 */
export function AddedToAgenda({
  statusRef,
}: {
  statusRef?: Ref<HTMLParagraphElement>;
}) {
  return (
    <div className="fi-send">
      <p
        className="cluster baseline"
        role="status"
        tabIndex={-1}
        ref={statusRef}
      >
        <span className="strong">{ADD.added}</span>
      </p>
    </div>
  );
}
