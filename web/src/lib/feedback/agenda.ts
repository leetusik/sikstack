/**
 * The agenda seam (P65-nh, operator decision 2; job 04 round 02, frame.md F341, F342; D237-we; P61-e9): the one
 * place the web decides whether a piece of feedback can be added to its project's agenda and reads what it became.
 * The server derives both from the agenda's entries (`GET /app/feedback/{id}/agenda`, `FeedbackAgenda`): a piece of
 * feedback is on an item when one of the item's entries, stored or still pending, has the source `feedback:<id>`;
 * nothing is stored on the feedback.
 *
 * - `canAdd(record, project, agenda)`: offered (`{ offered: true, project }`) when the record's project has a
 *   linked workspace (the read's `linked`); else the two not-offered cases, in this order: no project, no
 *   workspace.
 * - `sent(record, agenda)`: every item the record is on, in the Agenda's order, each with its page; `sync` is
 *   `waiting` until the workspace takes the change. Empty for none.
 * - The write, `fileAgendaItem` (`./agenda-actions`, a server action): `POST /app/feedback/{id}/agenda {item?}`
 *   files the record on a new item (the server mints its id, titles it `itemTitle(message)` and writes the add and
 *   the `feedback` entry) or on the item named (the entry alone), then answers `sent` anew.
 * - Statuses: an agenda reads one of the Workspace's four (`AgendaStatus`) in the Workspace's word and shape
 *   (`agendaStatus`), or Proposed. There is no Deferred (an older stored one reads Proposed, the server's word).
 *
 * Pure and NOT `server-only`: the Agenda part's client island reads the status map and the types.
 */

import { AGENDA, AGENDA_STATUS_WORDS } from "@/content/feedback-agenda";
import type { StatusState } from "@/sikstack/ui/marks";
import type {
  Feedback,
  FeedbackAgenda,
  FeedbackAgendaItem,
} from "@/lib/feedback/types";
import { agendaItemHref } from "@/lib/workspace/address";

/** The record fields the seam reads. */
export type AgendaRecord = Pick<Feedback, "id" | "message" | "project_id">;

/** An agenda's status: the Workspace's four (F37's `item` kind). */
export type AgendaStatus = "open" | "in_progress" | "solved" | "dropped";

/** An agenda item a piece of feedback is on, as its page's Agenda part draws it: the read's row and the item's page. */
export interface AgendaItem extends FeedbackAgendaItem {
  /** Where the Workspace shows the item: the Agenda part's title links there. */
  href: string;
}

/** Whether the add is offered for a record, and if not, why (F341). */
export type AgendaOffer =
  | { offered: true; project: string }
  | { offered: false; reason: "no-project" }
  | { offered: false; reason: "no-workspace"; project: string };

/**
 * Whether a record can be added to its project's agenda: offered when its project's workspace is linked
 * (`agenda.linked`, the server's answer; no answer reads not linked). `project` is the record's project's name (the
 * sentences and the confirm's title say it); with none known, its id stands in.
 */
export function canAdd(
  record: Pick<Feedback, "project_id">,
  project?: string | null,
  agenda?: Pick<FeedbackAgenda, "linked"> | null,
): AgendaOffer {
  if (!record.project_id) return { offered: false, reason: "no-project" };
  const name = project || record.project_id;
  if (agenda?.linked) return { offered: true, project: name };
  return { offered: false, reason: "no-workspace", project: name };
}

/** The sentence a not-offered add reads in the Agenda part (F341). */
export function notOfferedText(
  offer: Extract<AgendaOffer, { offered: false }>,
): string {
  return offer.reason === "no-project"
    ? AGENDA.noProject
    : AGENDA.noWorkspace(offer.project);
}

/**
 * Every agenda item a record is on (`agenda.items`, in the Agenda's order), each with its page in the record's
 * project; none without a project or an answer.
 */
export function sent(
  record: Pick<Feedback, "project_id">,
  agenda?: Pick<FeedbackAgenda, "items"> | null,
): AgendaItem[] {
  const project = record.project_id;
  if (!project || !agenda) return [];
  return agenda.items.map((item) => ({
    ...item,
    href: agendaItemHref(project, item.id),
  }));
}

/** The Workspace's title limit (its F36: 1 to 200 characters). */
export const AGENDA_TITLE_MAX = 200;

/**
 * An agenda item's title (F342, the fixture's `FB.itemTitle`): the message's first line (the first one
 * with text), whole when it fits in 200 characters; else cut at the last word before the limit (or at
 * the limit when no word ends past its first 120 characters), trailing spaces and `,.;:` dropped, with
 * `…`. Never longer than 200.
 */
export function itemTitle(message: string): string {
  const line = String(message ?? "")
    .trim()
    .split(/\r?\n/)[0]
    .trim();
  if (line.length <= AGENDA_TITLE_MAX) return line;
  const cut = line.slice(0, AGENDA_TITLE_MAX - 1);
  const at = cut.lastIndexOf(" ");
  return (at > 120 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "") + "…";
}

/** What one agenda item's status reads: the Workspace's word and its `Status` shape (F37). */
export interface AgendaStatusView {
  word: string;
  shape: StatusState;
}

/**
 * The Workspace's four statuses, each in its word and F37's shape: Open the ring (`status-idle`), In
 * progress the accent dot (`status-live`), Solved the check (`status-done`), Dropped the struck bar
 * (`status-revoked`).
 */
export const AGENDA_STATUS: Readonly<Record<AgendaStatus, AgendaStatusView>> =
  Object.freeze({
    open: { word: AGENDA_STATUS_WORDS.open, shape: "idle" },
    in_progress: { word: AGENDA_STATUS_WORDS.in_progress, shape: "live" },
    solved: { word: AGENDA_STATUS_WORDS.solved, shape: "done" },
    dropped: { word: AGENDA_STATUS_WORDS.dropped, shape: "revoked" },
  });

export function agendaStatus(state: AgendaStatus): AgendaStatusView {
  return AGENDA_STATUS[state];
}
