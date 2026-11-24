/**
 * A phase's page as pure rules (design job 02: `Phase.dc.html`, `PhaseGate.dc.html`, `PhaseSlices.dc.html`,
 * `PhaseNotebook.dc.html`; frame.md F37, F48, F83, F306). No React and no I/O, so the page's choices are tested
 * on their own.
 *
 * - `pullRequestView`: a branch's pull request (F306): the link's text and name, its state word, or the
 *   not-opened line.
 * - `askedDates`, `sliceSub`, `isCurrentSlice`: a slice row's line under its name and its `aria-current`.
 * - `gatePlace`: where the acceptance gate sits: first in the main column while it is open, in the side while
 *   it is not, nowhere while the phase has not declared it.
 * - `notebookQuestions`, `NOTEBOOK_DECISIONS_SHOWN`, `notebookShows`: the notebook's order and its groups.
 * - `originalParagraphs`: the operator's words, as written, never parsed as Markdown.
 * - `agendaItemOf`: the phase's agenda item as the Agenda holds it now, with its state and mark.
 * - `explainedDocuments`: the documents **Explained in** lists, each a link to the Library's reader.
 *
 * Deliberately free of `server-only`: the page and its client islands share it.
 */

import { WS_GLOSSARY } from "@/content/workspace/frame";
import { PHASE_PAGE } from "@/content/workspace/phase";
import { wsStatus, type WsStatusWord } from "@/sikstack/workspace/frame";
import { itemState, phaseLookup } from "@/lib/workspace/model";
import type {
  AgendaItem,
  Branch,
  ExplainDocument,
  Gate,
  Notebook,
  NotebookQuestion,
  Phase,
  PhaseRow,
  SliceRow,
} from "@/lib/workspace/types";

/** A phase id as the workspace writes them (`P8-q4`, `P12`, `P-7kq2`): what Loading may draw from the address. */
export const PHASE_ID = /^P[0-9A-Za-z-]{1,40}$/;

// -- a branch's pull request (F306) ----------------------------------------------------------------

export type PullRequestView =
  | {
      opened: true;
      /** The link's address: only an http(s) URL; anything else draws the text without a link. */
      href: string | null;
      text: string;
      label: string;
      state: WsStatusWord | null;
    }
  | { opened: false; text: string };

const WEB_URL = /^https?:\/\//i;

/** A branch's pull request: `Pull request #38` and its state word, or `Pull request not opened`. */
export function pullRequestView(branch: Branch): PullRequestView {
  const pr = branch.pr;
  if (!pr) return { opened: false, text: PHASE_PAGE.noPullRequest };
  const state = wsStatus("pr", pr.state);
  return {
    opened: true,
    href: typeof pr.url === "string" && WEB_URL.test(pr.url) ? pr.url : null,
    text: PHASE_PAGE.pullRequest(pr.number),
    label: PHASE_PAGE.pullRequestName(
      pr.number,
      branch.repo,
      state?.word ?? null,
    ),
    state,
  };
}

// -- slices (F48, F83) -----------------------------------------------------------------------------

/**
 * The slices whose row says when a decision was asked: a `pending` slice stopped for a `decision`, while the
 * notebook holds an open question (what is asked is that question, said once, in the notebook). By short id,
 * the stop's `since` as F2 writes it.
 */
export function askedDates(
  phase: Pick<Phase, "slices" | "notebook">,
  date: (value: string) => string,
): Record<string, string> {
  const asked: Record<string, string> = {};
  const open = (phase.notebook?.questions ?? []).some(
    (q) => q.state === "open",
  );
  if (!open) return asked;
  for (const s of phase.slices) {
    if (s.status === "pending" && s.stop?.kind === "decision" && s.stop.since)
      asked[s.id] = date(s.stop.since);
  }
  return asked;
}

/**
 * The line under a slice's name: its outcome; for a slice that is stopped or blocked, `Decision asked Nov 14`
 * when it is in `asked`, else its stop's own sentence (none is stored today: nothing is drawn).
 */
export function sliceSub(
  slice: Pick<SliceRow, "id" | "status" | "outcome" | "stop">,
  asked: Record<string, string>,
): string {
  if (slice.outcome) return slice.outcome;
  const stopped =
    slice.stop !== null &&
    (slice.status === "pending" || slice.status === "blocked");
  if (!stopped) return "";
  if (Object.hasOwn(asked, slice.id))
    return WS_GLOSSARY.sentences.decisionAsked(asked[slice.id]);
  return slice.stop?.what ?? "";
}

/** The current slice's row carries `aria-current="step"`, until it is done. */
export function isCurrentSlice(
  slice: Pick<SliceRow, "id" | "status">,
  current: string | null,
): boolean {
  return current !== null && slice.id === current && slice.status !== "done";
}

// -- the acceptance gate ---------------------------------------------------------------------------

/** Where the gate's panel sits: `main` while it is open, `side` while not, `null` while undeclared. */
export function gatePlace(gate: Pick<Gate, "state">): "main" | "side" | null {
  if (gate.state === null || gate.state === undefined) return null;
  return gate.state === "open" ? "main" : "side";
}

// -- the notebook ----------------------------------------------------------------------------------

/** Decisions shown before **Show all N decisions**. */
export const NOTEBOOK_DECISIONS_SHOWN = 5;

/** Open questions first; the rest keep the notebook's order. */
export function notebookQuestions(
  questions: readonly NotebookQuestion[],
): NotebookQuestion[] {
  return [
    ...questions.filter((q) => q.state === "open"),
    ...questions.filter((q) => q.state !== "open"),
  ];
}

/** Which groups a notebook draws: a group with nothing is not drawn. */
export function notebookShows(nb: Notebook) {
  return {
    now: !!nb.now && nb.now.trim() !== "",
    questions: nb.questions.length > 0,
    decisions: nb.decisions.length > 0,
    docImpact: nb.docImpact.length > 0,
    notes: nb.notes.length > 0,
    topics: nb.topics.length > 0,
  };
}

// -- intent ----------------------------------------------------------------------------------------

/**
 * The operator's words as written: a blank line starts a new paragraph, a line break stays a line break, and
 * nothing else is read (no Markdown, no HTML: every character is drawn as the text it is).
 */
export function originalParagraphs(text: string | null): string[][] {
  if (!text) return [];
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.trim() !== "")
    .map((p) => p.split("\n"));
}

// -- the agenda item -------------------------------------------------------------------------------

export interface PhaseItemView {
  id: string;
  title: string;
  lang: "en" | "ko";
  state: WsStatusWord | null;
  /** F45's mark: a change waiting for the next sync, or one the workspace refused. */
  mark: "waiting" | "refused" | null;
}

/**
 * The phase's agenda item as the Agenda holds it now (its title, its state over the Workspace's phases, its
 * mark); `null` when the phase has none, or the Agenda no longer holds it.
 */
export function agendaItemOf(
  id: string | null,
  agenda: readonly AgendaItem[],
  phases: readonly Pick<PhaseRow, "id" | "short" | "status">[],
): PhaseItemView | null {
  if (!id) return null;
  const item = agenda.find((x) => x.id === id);
  if (!item) return null;
  return {
    id: item.id,
    title: item.title ?? item.id,
    lang: item.lang === "ko" ? "ko" : "en",
    state: wsStatus("item", itemState(item, phaseLookup(phases))),
    mark: item.sync === "waiting" ? "waiting" : item.sync ? "refused" : null,
  };
}

// -- Explained in ----------------------------------------------------------------------------------

/** One row of **Explained in**: the document's title, a link to it in the Library's reader. */
export interface ExplainedRow {
  /** The document's id, the row's key. */
  key: number;
  title: string;
  /** The reader's address (`/documents/<id>`), never the project's library list. */
  href: string;
}

/**
 * The documents a phase is explained in: an explain phase's own (`explain.documents`, its newest REVIEW's
 * `## Published`), then every document `explainedIn` names (the phase as a source, or as the explain phase),
 * each once, by id, in that order. Empty when the read names none (an older read names neither list): the
 * page then draws no panel.
 */
export function explainedDocuments(
  phase: Pick<Phase, "explain" | "explainedIn">,
): ExplainedRow[] {
  const seen = new Set<number>();
  const rows: ExplainedRow[] = [];
  const add = (d: ExplainDocument) => {
    if (seen.has(d.id) || !d.href) return;
    seen.add(d.id);
    rows.push({
      key: d.id,
      title: d.title?.trim() || d.rel_path,
      href: d.href,
    });
  };
  for (const d of phase.explain?.documents ?? []) add(d);
  for (const d of phase.explainedIn ?? []) add(d);
  return rows;
}
