/**
 * Add to agenda's rules (job 04 round 02, `FeedbackItemSend.dc.html`, `FeedbackItemAgenda.dc.html`;
 * frame.md F143, F341 to F344), pure so they can be tested without a DOM.
 *
 * - The page's state, in the board's order (`FB.canSend`, `FB.sent`): filed, else waiting, else not
 *   offered, else the add's phase.
 * - The add's phases: `rest` (the button), `confirm` (the dialog open), `adding` (in flight: Cancel
 *   disabled, Escape does nothing), `failed` (the dialog open with its notice), `added` (the head reads
 *   Added to agenda, the Agenda part shows the item).
 * - Focus: the dialog opens on Cancel; when it closes, focus goes to what stands at the head's end:
 *   the status after an add (the button is gone), else the button that opened it.
 *
 * The next version (P61-e9, design folder): a piece of feedback can be on more than one item, read from
 * `GET /app/feedback/{id}/agenda` (`FeedbackAgenda`: the server derives it from the entries, never from the
 * feedback), so filed and waiting carry the items; the confirm is a choice between **A new item** and an item already
 * on the agenda (`AgendaPick`, `pickable`).
 */

import { notOfferedText, type AgendaOffer } from "@/lib/feedback/agenda";
import type { FeedbackAgendaItem } from "@/lib/feedback/types";

/** An agenda item a piece of feedback is on, as the Agenda part draws it: the read's row and the item's page. */
export interface AgendaPartItem extends FeedbackAgendaItem {
  href: string;
}

export type AgendaPageState =
  | { kind: "filed"; items: AgendaPartItem[] }
  | { kind: "waiting"; items: AgendaPartItem[] }
  | { kind: "not-offered"; reason: "no-project" | "no-workspace"; text: string }
  | { kind: "offered"; project: string };

/**
 * The page's state from `canAdd` and the items it is on: filed (on at least one item, none waiting), else waiting
 * (one of them waits for the sync), else not offered, else offered.
 */
export function agendaPageState(
  offer: AgendaOffer,
  items: readonly AgendaPartItem[],
): AgendaPageState {
  if (items.length > 0)
    return items.some((i) => i.sync !== null)
      ? { kind: "waiting", items: [...items] }
      : { kind: "filed", items: [...items] };
  if (!offer.offered)
    return {
      kind: "not-offered",
      reason: offer.reason,
      text: notOfferedText(offer),
    };
  return { kind: "offered", project: offer.project };
}

export type AddPhase = "rest" | "confirm" | "adding" | "failed" | "added";

/** Where the confirm adds the feedback: a new item (the default, the signed add), or an item already on the agenda. */
export type AgendaPick = { kind: "new" } | { kind: "item"; id: string };

export const NEW_ITEM: AgendaPick = { kind: "new" };

/** An item the confirm offers: its id, title and the title's language. */
export interface PickItem {
  id: string;
  title: string;
  lang: "en" | "ko";
}

const PICKABLE = ["proposed", "open", "in_progress", "deferred"];

/**
 * The items a piece of feedback can join, in the Agenda's order: those not ended (Proposed, Open, In progress,
 * Deferred) that do not hold it already (the server refuses the same feedback twice on one item, a 409).
 */
export function pickable(
  agenda: readonly { id: string; title: string | null; lang: string; state: string | null }[],
  on: readonly { id: string }[],
): PickItem[] {
  const held = new Set(on.map((i) => i.id));
  return agenda
    .filter((a) => PICKABLE.includes(a.state ?? "open") && !held.has(a.id))
    .map((a) => ({ id: a.id, title: a.title ?? a.id, lang: a.lang === "ko" ? "ko" : "en" }));
}

/** The confirm is open. */
export function isOpen(phase: AddPhase): boolean {
  return phase === "confirm" || phase === "adding" || phase === "failed";
}

/** While the add is in flight, Cancel is disabled and Escape does nothing (F143). */
export function isLocked(phase: AddPhase): boolean {
  return phase === "adding";
}

/** The button opens the confirm. */
export function ask(phase: AddPhase): AddPhase {
  return phase === "rest" ? "confirm" : phase;
}

/** Cancel or Escape: closes the confirm, unless the add is in flight. */
export function cancel(phase: AddPhase): AddPhase {
  return phase === "confirm" || phase === "failed" ? "rest" : phase;
}

/** Add to agenda, in the confirm: the add starts (again, after a failure). */
export function send(phase: AddPhase): AddPhase {
  return phase === "confirm" || phase === "failed" ? "adding" : phase;
}

/** The add's answer: added, or the confirm stays open with its notice. */
export function answer(phase: AddPhase, ok: boolean): AddPhase {
  if (phase !== "adding") return phase;
  return ok ? "added" : "failed";
}

/**
 * Where focus goes when the confirm closes (F143): the status that took the button's place after an
 * add, else the button that opened it.
 */
export function focusBack<T>(status: T | null, button: T | null): T | null {
  return status ?? button;
}
