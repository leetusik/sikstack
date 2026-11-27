/**
 * The Feedback states' module (P91-v3, applied from S3's signed design). A piece of
 * feedback's one state and the actions on it, pure, so the list, the item's page and their tests share it.
 *
 * - **The state** is the API's `state {state, agenda, reason, by, at}` on every record (`GET /app/feedback`, `GET
 *   /app/feedback/{id}`; no stored row reads Open with nulls). Filed and Resolved keep the agenda item; Dropped keeps
 *   the reason; Open keeps neither.
 * - **The actions**, in one order everywhere (the Agenda's F309 order: Delete first, the main act last): Open and
 *   Filed **Delete, Drop, Resolve**; Resolved and Dropped **Delete, Reopen**. Delete is an owner's only (`POST
 *   /app/feedback/delete` answers a member 403), so a member's view has none. **Drop and Delete ask**; Resolve and
 *   Reopen act at once (`POST /app/feedback/state`).
 * - **Picking** covers the rows on screen (one page of one state); the box over them picks all or clears them.
 */
import type { FeedbackAct, FeedbackStateName } from "@/content/feedback-state";

export type { FeedbackAct, FeedbackStateName };

/** The API's state of one record. */
export interface FeedbackStateRecord {
  state: FeedbackStateName;
  /** The agenda item it was filed on (Filed, and Resolved after it). */
  agenda: string | null;
  /** Drop's reason, one line (Dropped only). */
  reason: string | null;
  /** `person:<email>`, or the workspace's sync (`agent:sikstack`); null with no stored row. */
  by: string | null;
  at: string | null;
}

/** `GET /app/feedback`'s `counts`: the same filters, its own state filter left out. */
export type StateCounts = Record<FeedbackStateName, number>;

export const OPEN: FeedbackStateRecord = { state: "open", agenda: null, reason: null, by: null, at: null };

/** Who is signed in, as the actions need it: an owner deletes, a member does not. */
export type OrgRole = "owner" | "member";

const ACTS: Record<FeedbackStateName, readonly FeedbackAct[]> = {
  open: ["delete", "drop", "resolve"],
  filed: ["delete", "drop", "resolve"],
  resolved: ["delete", "reopen"],
  dropped: ["delete", "reopen"],
};

/** The actions on feedback in this state, for this role, in the one order. */
export function actsFor(state: FeedbackStateName, role: OrgRole): FeedbackAct[] {
  return ACTS[state].filter((a) => a !== "delete" || role === "owner");
}

/** Drop and Delete ask first; Resolve and Reopen act at once. */
export function actAsks(act: FeedbackAct): act is "drop" | "delete" {
  return act === "drop" || act === "delete";
}

/** The state an action leaves (Delete leaves none). */
export function stateAfter(act: Exclude<FeedbackAct, "delete">): FeedbackStateName {
  return act === "drop" ? "dropped" : act === "resolve" ? "resolved" : "open";
}

/** What `POST /app/feedback/state` stores: Resolved keeps the filed agenda, Dropped the reason, Open clears both. */
export function changed(
  from: FeedbackStateRecord,
  act: Exclude<FeedbackAct, "delete">,
  { by, at, reason }: { by: string; at: string; reason?: string },
): FeedbackStateRecord {
  const state = stateAfter(act);
  return {
    state,
    agenda: state === "resolved" ? from.agenda : null,
    reason: state === "dropped" ? reason?.trim() || null : null,
    by,
    at,
  };
}

/** Who changed it, as the state line says it: an email for a person, the name after the colon otherwise. */
export function byName(by: string | null): string | null {
  if (!by) return null;
  const at = by.indexOf(":");
  return at < 0 ? by : by.slice(at + 1) || null;
}

/** One page of one state's selection, as the list's head and strip draw it. */
export interface ListPick {
  /** The rows on screen, in the order shown: what the box over them picks. */
  shown: string[];
  /** The ticked rows on screen, in the order shown. */
  picked: string[];
  all: boolean;
  some: boolean;
}

export function listPick(shown: readonly string[], ticked: readonly string[]): ListPick {
  const on = new Set(ticked);
  const picked = shown.filter((id) => on.has(id));
  const all = shown.length > 0 && picked.length === shown.length;
  return { shown: [...shown], picked, all, some: picked.length > 0 && !all };
}

/** The box over the rows pressed: every row on screen, or none when all were picked. */
export const toggleAll = (pick: ListPick): string[] => (pick.all ? [] : [...pick.shown]);

/** A row's box pressed. */
export const toggleRow = (ticked: readonly string[], id: string): string[] =>
  ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id];

/** A confirm that is open: Drop or Delete, on these ids, with the first one's message to name it. */
export interface StateAsk {
  act: "drop" | "delete";
  ids: string[];
  /** The one piece's message, cut to a line, when it is one. */
  title: string;
  lang?: string;
  reason: string;
  busy: boolean;
  /** The send's failure, said in the confirm. */
  notice: string | null;
}

/** A message cut to one short line for a confirm's title. */
export function shortTitle(message: string, max = 60): string {
  const line = message.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Drop's reason is one line, at most 500 characters (the API's rule). */
export const REASON_MAX = 500;
