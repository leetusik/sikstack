"use server";

import { ApiError, sendJson } from "@/lib/knowledge/client";
import { getSession } from "@/lib/session";

import {
  addBody,
  changeBody,
  ENTRY_ID,
  PROJECT_ID,
  TITLE_REFUSAL,
  type AddInput,
  type Change,
  type MovePlace,
} from "./rules";
import type { InboxEntry, ItemChangeKind, WriteAnswer } from "./types";

/**
 * The web's agenda writes (F45, F301 to F303): every change to a workspace's agenda made on the web
 * goes through these actions, and each is one inbox entry on the API's routes, which a linked
 * engine applies (or refuses) at its next sync. The web writes no workspace file.
 *
 * - add: `POST /app/projects/{id}/workspace/agenda {title, note?}` → `{entry, item}`, the id the
 *   route minted;
 * - edit, move (before or after another agenda), propose (an Open agenda back to Proposed), solve,
 *   drop, reopen, delete, accept (a Proposed agenda made Open) and entry (a note, one item on an
 *   agenda, `{kind: "note", body}`; the server adds its author and source): `POST
 *   …/workspace/agenda/changes {kind, items, fields}` → `{entry}`, one entry for all the agendas (the
 *   engine's commands are all or none);
 * - item-done, item-dismiss, item-reopen, item-delete (`{entries}`, the items' file names, on one
 *   agenda) → `{entry}`; split (`{entries, title}`) → `{entry, agenda}`, the new agenda's id;
 * - discard: `POST …/workspace/inbox/{entry}/discard` → `{entry}` (a waiting or a refused change);
 * - retry (Try again): `POST …/workspace/inbox/{entry}/retry` → `{entry, item?}`, the same change
 *   as a new entry, the refused one closed with it.
 *
 * The early checks run here first (`rules.ts`, the route's own): a change the route would refuse is
 * answered at once and nothing is sent. Every answer is data, never a throw:
 *
 * - `{ok: true, entry, item}`: the entry written (`item`: an add's minted id, else null);
 * - `{ok: false, reason: "title", message}`: the signed title refusal, verbatim, for the field;
 * - `{ok: false, reason: "refused", message}`: another 422, its one line verbatim (`A7-m3 names no
 *   agenda item`);
 * - `{ok: false, reason: "closed", message}`: a 409, the change no longer open (or not refused, on
 *   Try again), the route's line;
 * - `{ok: false, reason: "not-found", message}`: a 404 (no linked workspace, another tenant's
 *   project, an entry the project does not hold);
 * - `{ok: false, reason: "signed-out"}`: no session; `{ok: false, reason: "failed"}`: the send did
 *   not get an answer it can use (F45's `Could not … Try again.`).
 *
 * The actions refresh nothing: a page keeps its optimistic state (`optimistic.ts`) and reads again
 * when it chooses (`router.refresh()`), since the read does not project a waiting change.
 *
 * NOTE: a `"use server"` module may export ONLY async functions; the types are in `types.ts` and
 * `rules.ts`.
 */

function refused(message: string): WriteAnswer {
  return message === TITLE_REFUSAL
    ? { ok: false, reason: "title", message }
    : { ok: false, reason: "refused", message };
}

/** Send one write; map the route's answer to the page's. */
async function send(
  project: string,
  route: string,
  body: unknown,
): Promise<WriteAnswer> {
  if (!PROJECT_ID.test(project)) {
    return { ok: false, reason: "not-found", message: null };
  }
  const token = await getSession();
  if (!token) return { ok: false, reason: "signed-out" };
  try {
    const answer = await sendJson<{
      entry: InboxEntry;
      item?: string | null;
      agenda?: string | null;
    }>(
      `/app/projects/${encodeURIComponent(project)}/workspace/${route}`,
      "POST",
      body,
      { token },
    );
    if (!answer || typeof answer !== "object" || !answer.entry) {
      return { ok: false, reason: "failed" };
    }
    // an add answers its id as `item`, a split (and Try again on one) its new agenda's as `agenda`
    return {
      ok: true,
      entry: answer.entry,
      item: answer.item ?? answer.agenda ?? null,
    };
  } catch (error) {
    if (!(error instanceof ApiError)) return { ok: false, reason: "failed" };
    switch (error.status) {
      case 401:
        return { ok: false, reason: "signed-out" };
      case 404:
        return { ok: false, reason: "not-found", message: error.detail };
      case 409:
        return error.detail
          ? { ok: false, reason: "closed", message: error.detail }
          : { ok: false, reason: "failed" };
      case 422:
        return error.detail
          ? refused(error.detail)
          : { ok: false, reason: "failed" };
      default:
        return { ok: false, reason: "failed" };
    }
  }
}

async function change(project: string, value: Change): Promise<WriteAnswer> {
  const checked = changeBody(value);
  if (!checked.ok) return refused(checked.error);
  return send(project, "agenda/changes", checked.body);
}

/** Add an item: it goes first in the agenda, under the id the route mints. */
export async function addAgendaItem(
  project: string,
  input: AddInput,
): Promise<WriteAnswer> {
  const checked = addBody(input);
  if (!checked.ok) return refused(checked.error);
  return send(project, "agenda", checked.body);
}

/** Edit an item's title, note or both. */
export async function editAgendaItem(
  project: string,
  item: string,
  fields: { title?: string; note?: string },
): Promise<WriteAnswer> {
  return change(project, { kind: "edit", items: [item], fields });
}

/** Move an item before or after another (a drop of a drag, a keyboard move put down). */
export async function moveAgendaItem(
  project: string,
  item: string,
  place: MovePlace,
): Promise<WriteAnswer> {
  return change(project, { kind: "move", items: [item], fields: place });
}

/** Propose agendas back: each Open one reads Proposed again, out of the open order (Deferred is gone). */
export async function proposeAgendaItems(
  project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change(project, { kind: "propose", items, fields: {} });
}

/**
 * Done, Dismiss, Reopen or Delete items of one agenda, by their full file names (`ThreadEntry.file`): one entry for
 * all of them. The last open item going closes the agenda at the sync (the read predicts it meanwhile).
 */
export async function changeAgendaEntries(
  project: string,
  kind: ItemChangeKind,
  agenda: string,
  entries: string[],
): Promise<WriteAnswer> {
  return change(project, { kind, items: [agenda], fields: { entries } });
}

/**
 * Split items off an agenda onto a new one under `title`: the answer's `item` is the new agenda's id (the route
 * minted it), whose page reads it with its items while the split waits.
 */
export async function splitAgenda(
  project: string,
  agenda: string,
  entries: string[],
  title: string,
): Promise<WriteAnswer> {
  return change(project, {
    kind: "split",
    items: [agenda],
    fields: { entries, title },
  });
}

/** Solve items, with an optional outcome. */
export async function solveAgendaItems(
  project: string,
  items: string[],
  outcome?: string,
): Promise<WriteAnswer> {
  return change(project, {
    kind: "solve",
    items,
    fields: outcome === undefined ? {} : { outcome },
  });
}

/** Drop items, with an optional reason. */
export async function dropAgendaItems(
  project: string,
  items: string[],
  reason?: string,
): Promise<WriteAnswer> {
  return change(project, {
    kind: "drop",
    items,
    fields: reason === undefined ? {} : { reason },
  });
}

/** Reopen agendas (solved or dropped). */
export async function reopenAgendaItems(
  project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change(project, { kind: "reopen", items, fields: {} });
}

/** Delete items: they leave the agenda for good (F303). */
export async function deleteAgendaItems(
  project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change(project, { kind: "delete", items, fields: {} });
}

/** Accept Proposed items (P61-e9): each becomes Open, first in the open order, at the next sync. */
export async function acceptAgendaItems(
  project: string,
  items: string[],
): Promise<WriteAnswer> {
  return change(project, { kind: "accept", items, fields: {} });
}

/** Write a note on an item's thread (P61-e9): one `entry`, by the signed-in account, from the web. */
export async function noteAgendaItem(
  project: string,
  item: string,
  body: string,
): Promise<WriteAnswer> {
  return change(project, {
    kind: "entry",
    items: [item],
    fields: { kind: "note", body },
  });
}

/** Discard a change that waits or was refused. */
export async function discardChange(
  project: string,
  entry: string,
): Promise<WriteAnswer> {
  if (!ENTRY_ID.test(entry)) {
    return { ok: false, reason: "not-found", message: null };
  }
  return send(project, `inbox/${encodeURIComponent(entry)}/discard`, undefined);
}

/** Try again: send a refused change anew (an add under a new id). */
export async function retryChange(
  project: string,
  entry: string,
): Promise<WriteAnswer> {
  if (!ENTRY_ID.test(entry)) {
    return { ok: false, reason: "not-found", message: null };
  }
  return send(project, `inbox/${encodeURIComponent(entry)}/retry`, undefined);
}
