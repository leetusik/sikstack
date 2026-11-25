// The design build's `@/lib/workspace/actions` (`next.config.ts` aliases it here): the same exports
// and the same answers (`WriteAnswer`), with the same early checks (`rules.ts`), answered by the
// browser store instead of the API, so the production components cannot tell the difference.
import {
  addBody,
  changeBody,
  TITLE_REFUSAL,
  type AddInput,
  type Change,
  type MovePlace,
} from "@/lib/workspace/rules";
import type { ItemChangeKind, WriteAnswer } from "@/lib/workspace/types";

import { apply } from "./store";

function refused(message: string): WriteAnswer {
  return message === TITLE_REFUSAL
    ? { ok: false, reason: "title", message }
    : { ok: false, reason: "refused", message };
}

async function change(value: Change): Promise<WriteAnswer> {
  const checked = changeBody(value);
  if (!checked.ok) return refused(checked.error);
  const out = apply({
    kind: checked.body.kind,
    items: checked.body.items,
    fields: checked.body.fields as Record<string, unknown>,
  });
  if (!out.ok) return refused(out.refused);
  // a split answers its new agenda's id, as the route's `{entry, agenda}`
  return { ok: true, entry: out.entry, item: out.entry.minted_id };
}

export async function addAgendaItem(
  _project: string,
  input: AddInput,
): Promise<WriteAnswer> {
  const checked = addBody(input);
  if (!checked.ok) return refused(checked.error);
  const out = apply({ kind: "add", items: [], fields: checked.body });
  if (!out.ok) return refused(out.refused);
  return { ok: true, entry: out.entry, item: out.entry.minted_id };
}

export async function editAgendaItem(
  _project: string,
  item: string,
  fields: { title?: string; note?: string },
): Promise<WriteAnswer> {
  return change({ kind: "edit", items: [item], fields });
}

export async function moveAgendaItem(
  _project: string,
  item: string,
  place: MovePlace,
): Promise<WriteAnswer> {
  return change({ kind: "move", items: [item], fields: place });
}

export async function proposeAgendaItems(
  _project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change({ kind: "propose", items, fields: {} });
}

export async function changeAgendaEntries(
  _project: string,
  kind: ItemChangeKind,
  agenda: string,
  entries: string[],
): Promise<WriteAnswer> {
  return change({ kind, items: [agenda], fields: { entries } });
}

export async function splitAgenda(
  _project: string,
  agenda: string,
  entries: string[],
  title: string,
): Promise<WriteAnswer> {
  return change({ kind: "split", items: [agenda], fields: { entries, title } });
}

export async function solveAgendaItems(
  _project: string,
  items: string[],
  outcome?: string,
): Promise<WriteAnswer> {
  return change({
    kind: "solve",
    items,
    fields: outcome === undefined ? {} : { outcome },
  });
}

export async function dropAgendaItems(
  _project: string,
  items: string[],
  reason?: string,
): Promise<WriteAnswer> {
  return change({
    kind: "drop",
    items,
    fields: reason === undefined ? {} : { reason },
  });
}

export async function reopenAgendaItems(
  _project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change({ kind: "reopen", items, fields: {} });
}

export async function deleteAgendaItems(
  _project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change({ kind: "delete", items, fields: {} });
}

/** Every change applies at once, so none waits or is refused later: there is nothing to discard. */
export async function discardChange(): Promise<WriteAnswer> {
  return { ok: false, reason: "not-found", message: null };
}

/** Nor to try again. */
export async function retryChange(): Promise<WriteAnswer> {
  return { ok: false, reason: "not-found", message: null };
}

// -- P61-e9: an item's thread and Proposed (the design's; production's actions add these two) -------------------

/** The server's bound on an entry's body (`_MAX_TEXT` in server/workspace_web_api.py). */
const BODY_MAX = 20_000;

/**
 * A note on an item's thread: `POST …/workspace/agenda/changes {kind: "entry", items: [AID], fields: {kind: "note",
 * body}}`. Its author is the server's (the signed-in account, `person:<handle>`), never the page's.
 */
export async function noteAgendaItem(
  _project: string,
  item: string,
  body: string,
): Promise<WriteAnswer> {
  const text = body.trim();
  if (!text) return refused("an entry needs a body of text");
  if (text.length > BODY_MAX) return refused(`body must be text of at most ${BODY_MAX} characters`);
  const out = apply({ kind: "entry", items: [item], fields: { kind: "note", body: text } });
  if (!out.ok) return refused(out.refused);
  return { ok: true, entry: out.entry, item: null };
}

/** Accept Proposed items: `POST …/workspace/agenda/changes {kind: "accept", items}`. */
export async function acceptAgendaItems(
  _project: string,
  items: string[],
): Promise<WriteAnswer> {
  const out = apply({ kind: "accept", items, fields: {} });
  if (!out.ok) return refused(out.refused);
  return { ok: true, entry: out.entry, item: null };
}
