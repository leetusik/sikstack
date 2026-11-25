// Project home's three parts (`ProjectHomeWorkspace`, `ProjectHomeLibrary`, `ProjectHomeFeedback`):
// server-safe markup, so `page.tsx` and `loading.tsx` both render them. Each panel's Try again is its
// client island (`library-retry.tsx`, `feedback-retry.tsx`).

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { PROJECT_HOME } from "@/content/project";
import { PROPOSED } from "@/content/workspace/agenda-thread";
import {
  Badge,
  Block,
  BlockText,
  Panel,
  PanelHead,
  Skeleton,
} from "@/sikstack/ui";
import { Rating } from "@/sikstack/feedback";
import { Steps, WsStatus } from "@/sikstack/workspace/frame";
import { date, type FormatOptions } from "@/lib/format";

import type { FeedbackRow, LibraryRow, WorkspacePart } from "./model";
import { workspaceWords } from "./model";

/** Three skeleton rows of a row's height (F24), the second bar `tail` wide. */
export function WaitRows({ tail }: { tail: string }) {
  return (
    <>
      <ul>
        {["16em", "12em", "14em"].map((w) => (
          <li key={w} className="row ph-wait">
            <Skeleton width={w} />
            <Skeleton width={tail} />
          </li>
        ))}
      </ul>
      <span className="sr-only">{PROJECT_HOME.loading}</span>
    </>
  );
}

/**
 * Workspace (`ProjectHomeWorkspace.dc.html`, on the Workspace's own frame parts): `Workspace` and the
 * agenda's count (`4 open · 1 proposed`), a link to the Agenda, in the head; then (P78, F16) the items that count
 * counts, one row each (the id, the title as a link to the item, its status), at most five, so the body lists what
 * the head counts, and with no item and no phase one line that says so; one row a phase, at most five, newest first: the id,
 * the name as a link to the phase with its current slice under it, the status (F37), the count and
 * the steps (F39); the foot **See all in Workspace**. Not linked or never synced: the signed sentence,
 * `No workspace linked yet. Run <link command> in the project’s repo.`, the command built from the
 * page's `origin` and the `projectId`, with no count and no foot. Loading: three skeleton rows.
 */
export function WorkspacePanel({
  part,
  origin,
  projectId,
}: {
  part: WorkspacePart;
  origin: string | null;
  projectId: string | null;
}) {
  const w = workspaceWords({ origin, projectId });
  return (
    <Panel
      className="ph-part"
      aria-label={w.heading}
      aria-busy={part.kind === "loading" ? "true" : undefined}
    >
      <PanelHead>
        <h2>{w.heading}</h2>
        {part.kind === "phases" ? (
          <p className="meta">
            <Link href={part.agenda.href} className="link">
              {part.agenda.text}
            </Link>
          </p>
        ) : null}
      </PanelHead>
      {part.kind === "phases" ? (
        <>
          {part.items.length === 0 && part.phases.length === 0 ? (
            <Block className="panel-body has-rule">
              <BlockText>{PROJECT_HOME.workspace.nothing}</BlockText>
            </Block>
          ) : null}
          <ul
            className="ph-list"
            style={{ "--steps-n": part.longest } as CSSProperties}
          >
            {part.items.map((it) => (
              <li key={it.key} className="row ph-phase">
                <span className="dim ph-id">{it.id}</span>
                <Link href={it.href} className="link-strong ph-open ph-name">
                  <span className="ph-name-text" lang={it.lang}>
                    {it.title}
                  </span>
                </Link>
                {it.state === "proposed" ? (
                  <span className={`${PROPOSED.cls} ph-state`}>
                    {PROPOSED.word}
                  </span>
                ) : (
                  <WsStatus kind="item" value={it.state} className="ph-state" />
                )}
              </li>
            ))}
            {part.phases.map((ph) => (
              <li key={ph.key} className="row ph-phase">
                <span className="dim ph-id">{ph.id}</span>
                <Link href={ph.href} className="link-strong ph-open ph-name">
                  <span className="row-stack">
                    <span className="ph-name-text" lang={ph.lang}>
                      {ph.name}
                    </span>
                    {ph.slice !== null ? (
                      <span
                        className="meta ph-sub"
                        lang={ph.sliceLang ?? undefined}
                      >
                        {ph.slice}
                      </span>
                    ) : null}
                  </span>
                </Link>
                <WsStatus kind="phase" value={ph.status} className="ph-state" />
                <Steps
                  done={ph.done}
                  total={ph.total}
                  live={ph.live}
                  className="ph-progress"
                />
              </li>
            ))}
          </ul>
          <div className="panel-foot">
            <Link href={part.all} className="link link-row">
              {PROJECT_HOME.workspace.all}
            </Link>
          </div>
        </>
      ) : null}
      {part.kind === "link" ? (
        <Block className="panel-body has-rule">
          <BlockText>
            {w.empty}
            {w.run ? (
              <>
                {" "}
                {w.run.before}
                <code className="mono ph-cmd">{w.run.command}</code>
                {w.run.after}
              </>
            ) : null}
          </BlockText>
        </Block>
      ) : null}
      {part.kind === "loading" ? <WaitRows tail="6em" /> : null}
    </Panel>
  );
}

const L = PROJECT_HOME.library;

/** The Library panel's head: `Library` and, once known and above 0, the active total. */
function LibraryHead({ count }: { count: string | null }) {
  return (
    <PanelHead>
      <h2>{L.heading}</h2>
      {count !== null ? <p className="meta">{count}</p> : null}
    </PanelHead>
  );
}

/** The Library panel's states (`ProjectHomeLibraryStates.dc.html`). */
export type LibraryState =
  /** `all`: the foot's address, the project's own library (`projectLibraryHref`). */
  | { kind: "rows"; rows: readonly LibraryRow[]; all: string }
  | { kind: "failed"; retry: ReactNode }
  /** Fetched again after Try again: the count stays, three skeleton rows. */
  | { kind: "loading" }
  /** Nothing known yet: no count, three skeleton rows. */
  | { kind: "first-load" };

/**
 * Library (`ProjectHomeLibrary.dc.html`): the active total in the head, the five newest documents
 * (the title as a link with `lang` set, a book with its `Book` badge and second title, the length and
 * the date), the foot to the Library; its empty, failed, loading-again and first-load forms.
 */
export function LibraryPanel({
  count,
  state,
  format,
}: {
  count: string | null;
  state: LibraryState;
  format?: FormatOptions;
}) {
  const waiting = state.kind === "loading" || state.kind === "first-load";
  const rows = state.kind === "rows" ? state.rows : null;
  const all = state.kind === "rows" ? state.all : null;
  return (
    <Panel
      className="ph-part"
      aria-label={L.heading}
      aria-busy={waiting ? "true" : undefined}
    >
      <LibraryHead count={state.kind === "first-load" ? null : count} />
      {rows !== null && rows.length > 0 ? (
        <>
          <ul className="ph-list">
            {rows.map((row) => (
              <li key={row.key} className="row ph-doc">
                <Link href={row.href} className="link-strong ph-open">
                  <span className="row-stack">
                    <span className="cluster baseline">
                      <span className="ph-name-text" lang={row.lang}>
                        {row.title}
                      </span>
                      {row.book ? <Badge>{L.book}</Badge> : null}
                    </span>
                    {row.sub !== null ? (
                      <span className="meta ph-sub" lang={row.subLang}>
                        {row.sub}
                      </span>
                    ) : null}
                  </span>
                </Link>
                <span className="dim ph-len">{row.length ?? ""}</span>
                <span className="dim ph-date">
                  {row.date !== null ? date(row.date, format) : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="panel-foot">
            <Link href={all ?? "/library"} className="link link-row">
              {L.all}
            </Link>
          </div>
        </>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <Block className="panel-body has-rule">
          <BlockText>{L.empty}</BlockText>
        </Block>
      ) : null}
      {state.kind === "failed" ? (
        <Block className="panel-body has-rule">
          <BlockText>{L.failed}</BlockText>
          {state.retry}
        </Block>
      ) : null}
      {waiting ? <WaitRows tail="3em" /> : null}
    </Panel>
  );
}

const F = PROJECT_HOME.feedback;

/** The Feedback panel's states: the board's, and the Library's failed form (D247-4x). */
export type FeedbackState =
  /** `all`: the foot's address, the project's own Feedback list (`feedbackHref(projectId)`). */
  | { kind: "rows"; rows: readonly FeedbackRow[]; all: string }
  | { kind: "failed"; retry: ReactNode }
  /** Fetched again after Try again: the count stays, three skeleton rows. */
  | { kind: "loading" }
  /** Nothing known yet: no count, three skeleton rows. */
  | { kind: "first-load" };

/**
 * Feedback (`ProjectHomeFeedback.dc.html`): `N this month` in the head; the five newest messages, each
 * its Rating (the Feedback job's Liked, Disliked, Unrated: operator D3) in the rating column at the
 * panel's weight, the text as a link to the message in the project's Shell (`lang` set) and the time;
 * the foot to the project's Feedback list. Empty drops the count and the foot; the failed form is the
 * Library's (`Feedback did not load.` and Try again, the head kept).
 *
 * A long message is cut at the Feedback list's two lines by the list's own `.clamp-2`, put on the text
 * span rather than through `ClampLink`, which would drop `.ph-open`'s text-only underline, the text's
 * weight 400 and the span's `lang`. The link keeps one 12 px over and under: `.ph-open` and the list's
 * `.link-strong:has(> .clamp-2)` set the same `padding-block` to the same step, never adding up.
 */
export function FeedbackPanel({
  count,
  state,
}: {
  /** `23 this month`, or `null` when not known. */
  count: string | null;
  state: FeedbackState;
}) {
  const waiting = state.kind === "loading" || state.kind === "first-load";
  const rows = state.kind === "rows" ? state.rows : null;
  const shown =
    state.kind === "first-load" || (rows !== null && rows.length === 0)
      ? null
      : count;
  return (
    <Panel
      className="ph-part"
      aria-label={F.heading}
      aria-busy={waiting ? "true" : undefined}
    >
      <PanelHead>
        <h2>{F.heading}</h2>
        {shown !== null ? <p className="meta">{shown}</p> : null}
      </PanelHead>
      {rows !== null && rows.length > 0 ? (
        <>
          <ul className="ph-list">
            {rows.map((m) => (
              <li key={m.id} className="row ph-msg">
                <Rating value={m.rating} className="ph-rating" />
                <Link href={m.href} className="link-strong ph-open ph-said">
                  <span className="ph-name-text clamp-2" lang={m.lang}>
                    {m.text}
                  </span>
                </Link>
                <span className="dim ph-when">{m.when}</span>
              </li>
            ))}
          </ul>
          <div className="panel-foot">
            <Link
              href={state.kind === "rows" ? state.all : "/feedback"}
              className="link link-row"
            >
              {F.all}
            </Link>
          </div>
        </>
      ) : null}
      {rows !== null && rows.length === 0 ? (
        <Block className="panel-body has-rule">
          <BlockText>{F.empty}</BlockText>
        </Block>
      ) : null}
      {state.kind === "failed" ? (
        <Block className="panel-body has-rule">
          <BlockText>{F.failed}</BlockText>
          {state.retry}
        </Block>
      ) : null}
      {waiting ? <WaitRows tail="3em" /> : null}
    </Panel>
  );
}
