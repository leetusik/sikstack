import type { MouseEvent } from "react";
import Link from "next/link";

import {
  COLUMNS,
  FEEDBACK,
  FILTER,
  RATING,
  PAGES_LABEL,
} from "@/content/feedback-frame";
import { LIST_BODY, LOADING } from "@/content/feedback-list";
import { SIKSTACK_STATES } from "@/content/sikstack-states";
import {
  Absent,
  ClampLink,
  FilterBar,
  Rating,
  StackTable,
  type RatingFilter,
} from "@/sikstack/feedback";
import { Pager } from "@/sikstack/library/pager";
import { cx } from "@/lib/cx";
import { countLine } from "@/lib/feedback/format";
import { langAttr } from "@/lib/feedback/lang";
import {
  feedbackHref,
  feedbackPageHref,
  isFiltered,
  type FeedbackScope,
} from "@/lib/feedback/place";

import {
  ACT_WORD,
  noMatchIn,
  PICK,
  STATE_COLUMNS,
  STATE_FILTER,
  STATE_ORDER,
  STATE_WORD,
  stateEmpty,
} from "@/content/feedback-state";
import { StateConfirm } from "../state/confirm";
import {
  actsFor,
  listPick,
  type FeedbackAct,
  type FeedbackStateName,
  type ListPick,
  type OrgRole,
  type StateAsk,
  type StateCounts,
} from "../state/model";
import {
  filtersSet,
  isBusy,
  isCounting,
  listBody,
  listRange,
  pageCount,
  type FeedbackListRow,
  type ListPhase,
  type ListPlace,
} from "./model";

/**
 * The Feedback list (`Feedback.dc.html` § the list, `FeedbackList.dc.html`, `FeedbackListStates.dc.html`):
 * the head (`h1` Feedback, the count line, Clear while a search or a filter is set), then the list's
 * panel (`section.panel[aria-label=Feedback]`): the bar, one body (the table, eight skeleton rows, or a
 * block), the Library's pager. Presentational: what to show and where a request is come in as props;
 * the handlers are the client island's (`./list.tsx`). Without them every way is a plain link or a GET.
 *
 * P91-v3 (applied from S3's signed design) adds, between the bar and the rows, **the list's head** (`.fl-head`): the box
 * that picks every row on screen, then **the state filter** (Open, Filed, Resolved, Dropped, each with its count from
 * the API's `counts`; Open by default). With rows picked, where the panel has room (52em) the head ends with the count,
 * **Clear** and the actions (`actsFor`: Delete, Drop, Resolve; or Delete, Reopen; Delete an owner's only); narrower,
 * the same come in a strip at the panel's end that stays at the window's foot (`.fl-bulk`), as the Agenda's do. Each
 * row leads with its box. A Filed or Resolved list adds the **Agenda** column, a Dropped one the **Reason** column.
 * Drop and Delete ask in `StateConfirm`. While Resolve or Reopen is on its way, the count says so (`Resolving…`) and
 * the buttons keep their words and sizes, the others disabled (the strip has no room for busy words on a phone).
 */
export interface FeedbackListViewProps {
  /** The project picked in the Shell, or null for the org's own list. */
  scope: FeedbackScope;
  place: ListPlace;
  /** The org's projects: the select's options (left out with a project picked). */
  projects: readonly { id: string; name: string }[];
  rows: readonly FeedbackListRow[];
  /** The list's total as read (the matches under a search or a filter). */
  total: number;
  /** Each state's count under the same search and filters (none while the page loads). */
  counts?: StateCounts;
  /** Who is signed in: an owner deletes (a member by default, so nothing offers Delete unasked). */
  role?: OrgRole;
  phase: ListPhase;
  /** The page asked for while it loads (`paging`): marked current at once. */
  pending?: number | null;
  /** The ticked rows (ids). */
  ticked?: readonly string[];
  /** Resolve or Reopen on its way (they act at once). */
  busy?: FeedbackAct | null;
  /** Drop's or Delete's confirm, while it is open. */
  ask?: StateAsk | null;
  onSearch?: (q: string) => void;
  onProject?: (project: string | null, q: string) => void;
  onRating?: (rating: RatingFilter | null, q: string) => void;
  onState?: (state: FeedbackStateName, event: MouseEvent<HTMLAnchorElement>) => void;
  onClear?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onPage?: (n: number, event: MouseEvent<HTMLAnchorElement>) => void;
  onRetry?: () => void;
  onTick?: (id: string) => void;
  onTickAll?: (pick: ListPick) => void;
  onClearPicks?: () => void;
  onAct?: (act: FeedbackAct, ids: string[]) => void;
  onReason?: (reason: string) => void;
  onCancelAsk?: () => void;
  onConfirmAsk?: () => void;
}

/** The skeleton rows' message bars (`FeedbackList.dc.html`), one a row. */
const SKELETON = [
  "26em",
  "18em",
  "32em",
  "22em",
  "14em",
  "28em",
  "20em",
  "24em",
];

const NO_COUNTS: StateCounts = { open: 0, filed: 0, resolved: 0, dropped: 0 };

/** The list's address in a state (Open is the address without `state`). */
function stateHref(scope: FeedbackScope, state: FeedbackStateName): string {
  const base = feedbackHref(scope);
  return state === "open" ? base : `${base}?state=${state}`;
}

export function FeedbackListView({
  scope,
  place,
  projects,
  rows,
  total,
  counts = NO_COUNTS,
  role = "member",
  phase,
  pending = null,
  ticked = [],
  busy = null,
  ask = null,
  onSearch,
  onProject,
  onRating,
  onState,
  onClear,
  onPage,
  onRetry,
  onTick,
  onTickAll,
  onClearPicks,
  onAct,
  onReason,
  onCancelAsk,
  onConfirmAsk,
}: FeedbackListViewProps) {
  const picked = scope !== null;
  const filtered = isFiltered(place);
  const body = listBody({
    phase,
    rows: rows.length,
    projects: projects.length,
    filtered,
    counts,
  });
  const counting = isCounting(phase);
  const pages = pageCount(total);
  const asked =
    phase === "paging" && pending !== null && pending >= 1
      ? Math.min(pending, pages)
      : null;
  const state = place.state;
  const pick = listPick(
    body === "rows" ? rows.map((r) => r.id) : [],
    ticked,
  );
  const acts = actsFor(state, role);
  const holds =
    state === "dropped" ? "reason" : state === "open" ? null : "agenda";
  const stateless = phase === "loading" || projects.length === 0;

  const picking =
    pick.picked.length > 0 ? (
      <>
        <p className="meta fl-count" role="status">
          {busy ? ACT_WORD[busy][1] : PICK.count(pick.picked.length, total)}
        </p>
        <button type="button" className="btn" onClick={onClearPicks}>
          {PICK.clear}
        </button>
        <div className="cluster fl-acts">
          {acts.map((act) => (
            <button
              key={act}
              type="button"
              className="btn"
              data-busy={busy === act ? "true" : undefined}
              aria-busy={busy === act ? true : undefined}
              disabled={busy !== null && busy !== act}
              onClick={() => {
                if (busy === null) onAct?.(act, pick.picked);
              }}
            >
              {ACT_WORD[act][0]}
            </button>
          ))}
        </div>
      </>
    ) : null;

  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <h1>{FEEDBACK}</h1>
          <div className="cluster gap-4">
            <p className="meta" role="status">
              {counting ? (
                <>
                  <span className="skel" />
                  <span className="sr-only">{LOADING}</span>
                </>
              ) : phase !== "failed" ? (
                countLine(total, filtered)
              ) : null}
            </p>
            {filtered ? (
              <Link
                className="btn"
                aria-label={FILTER.clearLabel}
                href={stateHref(scope, state)}
                onClick={onClear}
              >
                {FILTER.clear}
              </Link>
            ) : null}
          </div>
        </div>
      </header>
      <section
        className="panel fl-panel"
        aria-label={FEEDBACK}
        aria-busy={isBusy(phase) ? true : undefined}
      >
        <FilterBar
          action={feedbackHref(scope)}
          keep={state === "open" ? {} : { state }}
          q={place.q}
          projects={picked ? null : projects}
          project={place.project}
          rating={place.rating}
          disabled={stateless}
          onSearch={onSearch}
          onProject={onProject}
          onRating={onRating}
        />
        {body === "none" || body === "no-projects" || body === "failed" ? null : (
        <div className="fl-head">
          {body === "rows" ? (
            <label className="check fl-check">
              <input
                type="checkbox"
                checked={pick.all}
                ref={(el) => {
                  if (el) el.indeterminate = pick.some;
                }}
                onChange={() => onTickAll?.(pick)}
              />
              <span className="sr-only">
                {PICK.all(pick.shown.length, state)}
              </span>
            </label>
          ) : (
            <span className="fl-check" aria-hidden="true" />
          )}
          <nav className="seg fl-states" aria-label={STATE_FILTER}>
            {STATE_ORDER.map((s) => (
              <Link
                key={s}
                className="seg-item"
                href={stateHref(scope, s)}
                aria-current={s === state ? "page" : undefined}
                onClick={onState ? (event) => onState(s, event) : undefined}
              >
                {STATE_WORD[s]}
                <span className="fl-n">
                  {counting ? <span className="skel" /> : counts[s]}
                </span>
              </Link>
            ))}
          </nav>
          {picking ? <div className="fl-head-acts">{picking}</div> : null}
        </div>
        )}
        {body === "rows" || body === "waiting" ? (
          <StackTable set className={cx(body === "rows" && "fl-picks")}>
            <thead>
              <tr>
                <th scope="col" className="fl-pick">
                  <span className="sr-only">{PICK.column}</span>
                </th>
                <th scope="col" className="stack-rating">
                  {COLUMNS.rating}
                </th>
                <th scope="col">{COLUMNS.feedback}</th>
                {picked ? null : (
                  <th scope="col" className="stack-project">
                    {COLUMNS.project}
                  </th>
                )}
                <th scope="col" className="stack-product">
                  {COLUMNS.product}
                </th>
                {holds ? (
                  <th
                    scope="col"
                    className={holds === "reason" ? "fl-reason" : "fl-agenda"}
                  >
                    {STATE_COLUMNS[holds]}
                  </th>
                ) : null}
                <th scope="col" className="num stack-when">
                  {COLUMNS.when}
                </th>
              </tr>
            </thead>
            <tbody>
              {body === "rows"
                ? rows.map((r) => {
                    const on = pick.picked.includes(r.id);
                    return (
                      <tr key={r.id} className={on ? "is-selected" : undefined}>
                        <td className="fl-pick">
                          <label className="check fl-check">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => onTick?.(r.id)}
                            />
                            <span className="sr-only">
                              {PICK.row(r.message)}
                            </span>
                          </label>
                        </td>
                        <td className="nowrap">
                          <Rating value={r.value} />
                        </td>
                        <td className="has-control is-main">
                          <ClampLink href={r.href} lang={r.lang}>
                            {r.message}
                          </ClampLink>
                        </td>
                        {picked ? null : (
                          <td className="stack-wrap" lang={r.projectLang}>
                            {r.project ?? <Absent />}
                          </td>
                        )}
                        <td className="stack-wrap">
                          {r.product ?? <Absent />}
                        </td>
                        {holds === "agenda" ? (
                          <td className="nowrap">
                            {r.state.agenda ? (
                              <span className="ws-id">{r.state.agenda}</span>
                            ) : (
                              <Absent />
                            )}
                          </td>
                        ) : null}
                        {holds === "reason" ? (
                          <td
                            className="stack-wrap fl-reason-text"
                            lang={langAttr(r.state.reason)}
                          >
                            {r.state.reason ?? <Absent />}
                          </td>
                        ) : null}
                        <td className="num dim to-end">
                          <time dateTime={r.at}>{r.when}</time>
                        </td>
                      </tr>
                    );
                  })
                : SKELETON.map((width, i) => (
                    <tr key={i} aria-hidden="true">
                      <td className="fl-pick" />
                      <td className="nowrap">
                        <span className="swap fl-ghost">
                          <span className="skel" style={{ width: "100%" }} />
                          <span className="rating rating-disliked">
                            {RATING.disliked}
                          </span>
                        </span>
                      </td>
                      <td className="has-control is-main">
                        <span className="link-strong">
                          <span className="skel" style={{ width }} />
                        </span>
                      </td>
                      {picked ? null : (
                        <td className="nowrap">
                          <span>
                            <span className="skel" style={{ width: "5em" }} />
                          </span>
                        </td>
                      )}
                      <td className="nowrap">
                        <span>
                          <span className="skel" style={{ width: "4em" }} />
                        </span>
                      </td>
                      {holds ? (
                        <td className="nowrap">
                          <span>
                            <span className="skel" style={{ width: "4em" }} />
                          </span>
                        </td>
                      ) : null}
                      <td className="num to-end">
                        <span>
                          <span className="skel" style={{ width: "3em" }} />
                        </span>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </StackTable>
        ) : null}
        {body === "none" ? (
          <div className="fl-body block">
            <p className="block-text">
              {LIST_BODY.none.before}
              <span className="fl-keep">{LIST_BODY.none.key}</span>
            </p>
          </div>
        ) : null}
        {body === "state-empty" ? (
          <div className="fl-body block">
            <p className="block-text">{stateEmpty(state)}</p>
          </div>
        ) : null}
        {body === "no-projects" ? (
          <div className="fl-body block">
            <p className="block-text">
              {LIST_BODY.noProjects.before}
              <span className="fl-keep">
                <Link
                  className="link fl-inline"
                  href={SIKSTACK_STATES.orgHomeHref}
                >
                  {LIST_BODY.noProjects.overview}
                </Link>
                {LIST_BODY.noProjects.comma}
              </span>
              {LIST_BODY.noProjects.middle}
              <span className="fl-keep">{LIST_BODY.noProjects.key}</span>
            </p>
          </div>
        ) : null}
        {body === "no-match" ? (
          <div className="fl-body block">
            <p className="block-text">
              {noMatchIn(state, place.q, filtersSet(place))}
            </p>
          </div>
        ) : null}
        {body === "failed" ? (
          <div className="fl-body block">
            <p className="block-text">{LIST_BODY.failed}</p>
            <button type="button" className="btn" onClick={onRetry}>
              {LIST_BODY.retry}
            </button>
          </div>
        ) : null}
        {body === "rows" && pages > 1 ? (
          <Pager
            page={asked ?? place.page}
            pages={pages}
            range={listRange(place.page, total)}
            label={PAGES_LABEL}
            hrefFor={(n) => feedbackPageHref(scope, place, n)}
            onPage={onPage}
          />
        ) : null}
        {picking ? (
          <div className="fl-bulk" role="group" aria-label={PICK.bulk}>
            {picking}
          </div>
        ) : null}
      </section>
      {ask ? (
        <StateConfirm
          ask={ask}
          onReason={onReason}
          onCancel={() => onCancelAsk?.()}
          onConfirm={() => onConfirmAsk?.()}
        />
      ) : null}
    </div>
  );
}
