// The Feedback states' words (P91-v3, applied from S3's signed design, which drew them first). A piece of
// feedback's one state (Open, Filed, Resolved, Dropped), the actions on it (Resolve, Drop, Reopen, Delete), their
// confirms and their answers, shared by the Feedback list and one piece of feedback. The Agenda's own words stay the
// Agenda's (`@/content/workspace/agenda`); the verbs and their busy forms are the Workspace's (`WS_ACTIONS`).
// Imported by its own path, never through `content/index.ts`.

import { WS_ACTIONS } from "@/content/workspace/frame";

export type FeedbackStateName = "open" | "filed" | "resolved" | "dropped";

/** The four states, in the list's filter order: Open first, the default. */
export const STATE_ORDER: readonly FeedbackStateName[] = ["open", "filed", "resolved", "dropped"];

/** A state's word: the filter's label and the item's state line. */
export const STATE_WORD: Record<FeedbackStateName, string> = {
  open: "Open",
  filed: "Filed",
  resolved: "Resolved",
  dropped: "Dropped",
};

/** The state filter's accessible name. */
export const STATE_FILTER = "State";

/** The actions on feedback. Drop and Delete ask first; Resolve and Reopen act at once. */
export type FeedbackAct = "delete" | "drop" | "resolve" | "reopen";

export const ACT_WORD: Record<FeedbackAct, readonly [string, string]> = {
  delete: WS_ACTIONS.delete,
  drop: WS_ACTIONS.drop,
  resolve: ["Resolve", "Resolving…"],
  reopen: WS_ACTIONS.reopen,
};

const pieces = (n: number) => (n === 1 ? "piece of feedback" : "pieces of feedback");

/** Picking rows on the list: the boxes' names, the count, Clear, the strip's name. */
export const PICK = {
  row: (message: string): string => `Select: ${message}`,
  all: (n: number, state: FeedbackStateName): string => `Select all ${n} ${STATE_WORD[state].toLowerCase()} on this page`,
  count: (n: number, total: number): string => `${n} of ${total} selected`,
  clear: "Clear",
  /** The box column's head, for a screen reader. */
  column: "Select",
  bulk: "Act on the selected feedback",
} as const;

/** The list's columns a state adds: the agenda item a filed or resolved piece is on, a dropped piece's reason. */
export const STATE_COLUMNS = {
  agenda: "Agenda",
  reason: "Reason",
} as const;

/**
 * What stands in place of the rows when a state holds none (no search or filter set; the org has feedback in
 * another state). The state filter beside it shows where the rest is.
 */
export const stateEmpty = (state: FeedbackStateName): string => `No ${STATE_WORD[state].toLowerCase()} feedback.`;

/**
 * No match, in the state it was looked for in: a search alone, a search with filters, filters alone. `filters` is how
 * many of the project and rating filters are set.
 */
export function noMatchIn(state: FeedbackStateName, q: string, filters: number): string {
  const text = q.trim();
  const which = filters === 1 ? "this filter" : "these filters";
  const s = STATE_WORD[state].toLowerCase();
  if (text) return `No ${s} feedback contains “${text}”${filters ? ` with ${which}` : ""}.`;
  return `No ${s} feedback matches ${which}.`;
}

/** Drop asks first, naming what it acts on; one optional reason covers the whole selection. */
export const CONFIRM_DROP = {
  before: "Drop “",
  after: "”?",
  title: (message: string): string => `Drop “${message}”?`,
  titleMany: (n: number): string => `Drop ${n} ${pieces(n)}?`,
  text: "It moves to Dropped. Reopen brings it back.",
  textMany: "They move to Dropped. Reopen brings one back.",
  reason: WS_ACTIONS.reason,
  cancel: WS_ACTIONS.cancel,
  yes: ["Yes, drop", WS_ACTIONS.drop[1]] as const,
} as const;

const things = (comments: number, files: number): string => {
  const c = comments === 1 ? "1 comment" : `${comments} comments`;
  const f = files === 1 ? "1 attachment" : `${files} attachments`;
  if (comments && files) return `, its ${c} and ${f}`;
  if (comments) return ` and its ${c}`;
  if (files) return ` and its ${f}`;
  return "";
};

/**
 * Delete asks first (owners only), naming what goes. The item's page knows its comments and files; the list does
 * not (its records carry neither), so it names them as a kind.
 */
export const CONFIRM_DELETE = {
  before: "Delete “",
  after: "”?",
  title: (message: string): string => `Delete “${message}”?`,
  titleMany: (n: number): string => `Delete ${n} ${pieces(n)}?`,
  /** The item's page: what goes, counted. */
  textCounted: (comments: number, files: number): string =>
    `The feedback${things(comments, files)} ${comments || files ? "are" : "is"} deleted for good. Agenda items that name it stay.`,
  text: "It is deleted for good, with its comments and attachments. Agenda items that name it stay.",
  textMany: "They are deleted for good, with their comments and attachments. Agenda items that name them stay.",
  cancel: WS_ACTIONS.cancel,
  yes: ["Yes, delete", WS_ACTIONS.delete[1]] as const,
} as const;

/** An action with no usable answer: said in its confirm, or as the toast for one that acts at once. */
export const actFailed = (act: FeedbackAct, n: number): string =>
  `Could not ${act} the ${n === 1 ? "feedback" : `${n} ${pieces(n)}`}. Try again.`;

/** The toast after an action on the list: the rows leave the state on screen. */
export const actDone = (act: FeedbackAct, n: number): string => {
  const done = { delete: "Deleted", drop: "Dropped", resolve: "Resolved", reopen: "Reopened" }[act];
  return `${done} ${n} ${pieces(n)}.`;
};
