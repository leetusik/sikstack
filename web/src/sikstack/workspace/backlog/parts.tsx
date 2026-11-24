import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

import { BACKLOG } from "@/content/workspace/backlog";
import { pagerRange } from "@/sikstack/library/pager-model";

import { Steps } from "../frame/steps";
import { WsRow } from "../frame/row";

import {
  ARCHIVED_PER,
  type BacklogArchived,
  type BacklogCell,
  type BacklogPhase,
  type BacklogRef,
  type BacklogView,
  type BacklogWaitingItem,
} from "./model";
import { ArchivedPager } from "./archived-pager";

/**
 * The backlog's parts (`BacklogWaiting.dc.html`, `BacklogNow.dc.html`, `BacklogPhases.dc.html`), as signed: the
 * system's and the frame's classes, and the page's own in `styles/workspace/backlog.css`. Server-safe markup.
 */

/** An id and its name as one link's text (F48's `.ws-id` 8 px before the name). */
export function Ref({ refd }: { refd: BacklogRef }) {
  return (
    <span className="backlog-ref">
      <span className="ws-id">{refd.id}</span>
      {refd.name ? <span lang={refd.lang}>{refd.name}</span> : null}
    </span>
  );
}

// -- Now ------------------------------------------------------------------------------------------

function NowCell({ cell }: { cell: BacklogCell }) {
  return (
    <div className="backlog-cell">
      <dt>{cell.label}</dt>
      <dd className="backlog-value">
        <Link className="link-strong" href={cell.href}>
          <Ref refd={cell} />
        </Link>
      </dd>
      <dd className="backlog-state">
        {cell.status ? (
          <span className={cell.status.cls}>{cell.status.word}</span>
        ) : null}
        {cell.steps ? (
          <Steps
            done={cell.steps.done}
            total={cell.steps.total}
            live={cell.steps.live}
            compact
            n={cell.steps.total}
          />
        ) : null}
      </dd>
    </div>
  );
}

/** The pointer (`BacklogNow`): one body a running stream, or the sentence, then None while nothing waits. */
export function BacklogNow({ now }: { now: BacklogView["now"] }) {
  const L = BACKLOG.now.labels;
  return (
    <section className="panel" aria-label={BACKLOG.now.head}>
      <div className="panel-head">
        <h2>{BACKLOG.now.head}</h2>
        {now.streams ? <p className="meta">{now.streams}</p> : null}
      </div>
      {now.blocks.map((b) => (
        <div key={b.id} className="panel-body has-rule stack gap-3">
          {now.streams ? (
            <div className="cluster baseline">
              <h3>{b.label}</h3>
              <span className="dim">
                <span className="sr-only">{BACKLOG.now.branch}</span>
                {b.branch}
              </span>
            </div>
          ) : null}
          <dl className="backlog-pointer">
            {b.cells.map((c) => (
              <NowCell key={c.label} cell={c} />
            ))}
          </dl>
        </div>
      ))}
      {now.idle ? (
        <div className="panel-body has-rule block">
          <p className="block-text">{now.idle}</p>
        </div>
      ) : null}
      {now.none ? (
        <div className="panel-body has-rule backlog-facts">
          <dl className="backlog-pointer is-facts">
            <div className="backlog-cell">
              <dt>{L.waiting}</dt>
              <dd className="backlog-value is-none">
                <span className="backlog-ref">
                  <span>{L.none}</span>
                </span>
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

const skel = (width: string) => <span className="skel" style={{ width }} />;

/** Now while the page loads: the head, the labels, bars in the value and state rows. */
export function BacklogNowLoading() {
  const L = BACKLOG.now.labels;
  const cell = (label: string, value: string, state: string) => (
    <div className="backlog-cell">
      <dt>{label}</dt>
      <dd className="backlog-value">{skel(value)}</dd>
      <dd className="backlog-state">
        <span>{skel(state)}</span>
      </dd>
    </div>
  );
  return (
    <section className="panel" aria-label={BACKLOG.now.head} aria-busy="true">
      <div className="panel-head">
        <h2>{BACKLOG.now.head}</h2>
      </div>
      <div className="panel-body has-rule">
        <dl className="backlog-pointer">
          {cell(L.phase, "11em", "9em")}
          {cell(L.slice, "13em", "6em")}
          {cell(L.next, "9em", "4em")}
        </dl>
      </div>
      <div className="panel-body has-rule backlog-facts">
        <dl className="backlog-pointer is-facts">
          <div className="backlog-cell">
            <dt>{L.waiting}</dt>
            <dd className="backlog-value">{skel("3em")}</dd>
          </div>
        </dl>
      </div>
      <span className="sr-only">{BACKLOG.loading}</span>
    </section>
  );
}

/** Now when the backlog did not load: the head, the sentence and Try again (the page's own button). */
export function BacklogNowFailed({ retry }: { retry: ReactNode }) {
  return (
    <section className="panel" aria-label={BACKLOG.now.head}>
      <div className="panel-head">
        <h2>{BACKLOG.now.head}</h2>
      </div>
      <div className="panel-body has-rule block">
        <p className="block-text">{BACKLOG.now.failed}</p>
        {retry}
      </div>
    </section>
  );
}

// -- Phases and Archived phases -------------------------------------------------------------------

function Columns() {
  const C = BACKLOG.phases.columns;
  return (
    <div className="row ws-row backlog-cols" aria-hidden="true">
      <span>
        <span className="backlog-col">{C.phase}</span>
      </span>
      <span className="ws-state">
        <span className="backlog-col">{C.status}</span>
      </span>
      <span className="ws-end backlog-end">
        <span className="backlog-verdict">
          <span className="backlog-col">{C.review}</span>
        </span>
        <span className="progress">
          <span className="backlog-col">{C.slices}</span>
        </span>
      </span>
    </div>
  );
}

function PhaseRowItem({ ph }: { ph: BacklogPhase }) {
  return (
    <WsRow
      id={ph.id}
      name={ph.name}
      href={ph.href}
      lang={ph.lang}
      sub={ph.sub}
      subLang={ph.subLang}
      status={ph.status}
      end={
        <span className="ws-end backlog-end">
          <span className="backlog-verdict">
            <span className="backlog-k">{BACKLOG.phases.review}</span>
            <span className={ph.verdict.cls}>{ph.verdict.word}</span>
          </span>
          <Steps
            done={ph.steps.done}
            total={ph.steps.total}
            live={ph.steps.live}
          />
        </span>
      }
    />
  );
}

const stepsStyle = (n: number) => ({ "--steps-n": n }) as CSSProperties;

const HEAD_ID = "backlog-phases-head";
const ARCHIVED_ID = "backlog-archived-head";

function Archived({
  archived,
  project,
}: {
  archived: BacklogArchived;
  project: string;
}) {
  return (
    <section className="panel" aria-labelledby={ARCHIVED_ID}>
      <div className="panel-head">
        <h2 id={ARCHIVED_ID}>{BACKLOG.phases.archived}</h2>
        <p className="meta">{archived.count}</p>
      </div>
      <div
        className="ws-list backlog-phases"
        style={stepsStyle(archived.longest)}
      >
        <Columns />
        <ul>
          {archived.rows.map((ph) => (
            <PhaseRowItem key={ph.id} ph={ph} />
          ))}
        </ul>
      </div>
      {archived.total > ARCHIVED_PER ? (
        <div className="panel-foot backlog-foot">
          <ArchivedPager
            project={project}
            page={archived.page}
            pages={archived.pages}
            range={pagerRange(archived.page, ARCHIVED_PER, archived.total)}
            label={BACKLOG.phases.pager.label}
          />
        </div>
      ) : null}
    </section>
  );
}

/** The phases in play, then the archived ones in a panel of their own (F304). */
export function BacklogPhases({
  phases,
  archived,
  project,
}: {
  phases: BacklogView["phases"];
  archived: BacklogArchived | null;
  project: string;
}) {
  return (
    <div className="stack gap-5">
      <section className="panel" aria-labelledby={HEAD_ID}>
        <div className="panel-head">
          <h2 id={HEAD_ID}>{BACKLOG.phases.head}</h2>
          <p className="meta">{phases.count}</p>
        </div>
        <div
          className="ws-list backlog-phases"
          style={stepsStyle(phases.longest)}
        >
          <Columns />
          <ul>
            {phases.rows.map((ph) => (
              <PhaseRowItem key={ph.id} ph={ph} />
            ))}
          </ul>
        </div>
      </section>
      {archived ? <Archived archived={archived} project={project} /> : null}
    </div>
  );
}

const SKELETON_NAMES = ["11em", "15em", "9em", "13em", "10em"];
const SKELETON_STATES = ["6em", "5em", "6em", "4em", "4em"];

/** Phases while the page loads: the head with a bar for its count, the labels, five rows of a row's height. */
export function BacklogPhasesLoading() {
  return (
    <div className="stack gap-5">
      <section className="panel" aria-labelledby={HEAD_ID} aria-busy="true">
        <div className="panel-head">
          <h2 id={HEAD_ID}>{BACKLOG.phases.head}</h2>
          <p className="meta">{skel("5em")}</p>
        </div>
        <div className="ws-list backlog-phases" style={stepsStyle(1)}>
          <Columns />
          <ul>
            {SKELETON_NAMES.map((name, i) => (
              <li key={i} className="row ws-row">
                <span className="ws-id">{skel("3.5em")}</span>
                <span className="ws-name backlog-skel">{skel(name)}</span>
                <span className="ws-state">{skel(SKELETON_STATES[i])}</span>
                <span className="ws-end backlog-end">
                  <span className="backlog-verdict">{skel("5em")}</span>
                  <span className="progress">
                    <span>{skel("10em")}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <span className="sr-only">{BACKLOG.loading}</span>
        </div>
      </section>
    </div>
  );
}
