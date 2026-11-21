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
import type { WriteAnswer } from "@/lib/workspace/types";

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
  return { ok: true, entry: out.entry, item: null };
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

export async function deferAgendaItems(
  _project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change({ kind: "defer", items, fields: {} });
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
