/**
 * The optimistic model the Agenda and an agenda item's page share (F45, F301 to F303): what the
 * page shows of the changes it wrote while the workspace has not taken them yet.
 *
 * The read model lays each open change over the agenda only as a mark (`sync: 'waiting'` or
 * `{refused, entry}`): a waiting add is its own row and a waiting delete hides its agenda, but a
 * waiting edit, move, solve, drop or reopen shows the stored values. (Item changes, a split and a
 * propose the read predicts itself: an item's state, the counts, the auto-close, the new agenda.) So
 * the page keeps what it wrote here and lays it over every read:
 *
 * - **A write marks its agendas Waiting for sync** and shows its result (F36's "After"): an edit's
 *   title and note, a move's place, Propose's Proposed, Solve and Drop's state (with the outcome or
 *   reason), Reopen's Open at the end of the operator's order; an Accept's agenda reads `accepting`
 *   (Open, first in the open order); a note, an item change or a split only marks its agenda; a
 *   delete hides its agendas; an add is first.
 * - **It stays through reads that do not project it**: a read taken before the write, or one that
 *   shows the stored values with the mark.
 * - **It clears on a read that shows it applied or refused**: refused, the read carries the
 *   engine's line itself (the row's `Change refused` mark, or `unplaced`), so the page shows it
 *   once, from the read; applied, the read's rows carry no mark and either already show the result
 *   or come from a sync that landed after the change was written (`synced` past its `created`), so
 *   a change the engine stored otherwise than it was sent clears too; an add or a delete clears as
 *   soon as the read itself shows the row or hides it. A row's `waiting` mark is never taken as
 *   this change seen: another member's waiting change marks the row the same way.
 * - **Never twice**: an id is shown once, an add the read already carries is not added again, and a
 *   change the read shows refused is not also shown waiting.
 * - **Discard and Try again** close the old entry here at once: its mark goes (a discarded add's row
 *   with it) until a read no longer names it. Try again on a refused add waits under the id the
 *   route re-minted, never the old one.
 *
 * The page holds an `Overlay` in its state, adds each write's answer (`written`), and folds every
 * new read in (`reconcile`) before it draws `view(read, overlay)`. All pure; nothing here reads or
 * writes.
 */

import { langOf, todayIn } from "./model";
import type {
  AgendaItem,
  ChangeKind,
  InboxEntry,
  ItemSync,
  Unplaced,
} from "./types";

/** One change this page wrote that the workspace has not taken yet. */
export interface PendingChange {
  /** This page's own key for it. */
  key: string;
  /** The inbox entry the route answered; null while it is being sent. */
  entry: string | null;
  kind: ChangeKind;
  items: string[];
  fields: Record<string, unknown>;
  /** An add's minted id. */
  minted: string | null;
  /** The day it was made, in the viewer's zone: an item it changes reads it as `changed`. */
  day: string;
  /** The inbox entry's own instant (`created_at`); null while it is being sent. */
  created: string | null;
  /** A read named this entry waiting (`unplaced`): a later read without it shows it taken. */
  seen: boolean;
}

/** An entry this page closed (Discard, or the old entry of Try again). */
export interface ClosedEntry {
  entry: string;
  /** A closed add: its row goes with it. */
  add: boolean;
}

export interface Overlay {
  /** Oldest first. */
  changes: PendingChange[];
  closed: ClosedEntry[];
  /** The next local key's number. */
  next: number;
}

/**
 * What a read gives the model: the agenda in the operator's order, the unplaced changes, and the
 * Workspace's sync instant (`workspace.sync.at`: it moves when a batch lands, which carries every
 * change the engine took).
 */
export interface AgendaRead {
  agenda: readonly AgendaItem[];
  unplaced?: readonly Unplaced[];
  synced?: string | null;
}

export const EMPTY_OVERLAY: Overlay = { changes: [], closed: [], next: 1 };

// -- writing -----------------------------------------------------------------------------------

/** A change as it is about to be sent (not an add: its id is the route's). */
export interface Sending {
  kind: Exclude<ChangeKind, "add">;
  items: string[];
  fields: Record<string, unknown>;
}

/**
 * A change shown at once, before its answer (a drop of a drag): `settle` it with the answer. Its
 * day is today in the viewer's zone.
 */
export function begin(
  overlay: Overlay,
  change: Sending,
  timeZone: string,
  now?: number | Date,
): { overlay: Overlay; key: string } {
  const key = `local-${overlay.next}`;
  const pending: PendingChange = {
    key,
    entry: null,
    kind: change.kind,
    items: [...change.items],
    fields: { ...change.fields },
    minted: null,
    day: todayIn(timeZone, now),
    created: null,
    seen: false,
  };
  return {
    overlay: {
      ...overlay,
      changes: [...overlay.changes, pending],
      next: overlay.next + 1,
    },
    key,
  };
}

/** A begun change's answer: its entry when it was written, else it goes. */
export function settle(
  overlay: Overlay,
  key: string,
  answer: { ok: true; entry: InboxEntry } | { ok: false },
): Overlay {
  const changes = overlay.changes.flatMap((c) => {
    if (c.key !== key) return [c];
    if (!answer.ok) return [];
    return [fromEntry(answer.entry, c.key, c.day)];
  });
  return { ...overlay, changes };
}

function fromEntry(entry: InboxEntry, key: string, day: string): PendingChange {
  return {
    key,
    entry: entry.id,
    kind: entry.kind,
    items: [...entry.items],
    fields: { ...entry.fields },
    minted: entry.minted_id,
    day,
    created: entry.created_at ?? null,
    seen: false,
  };
}

/** A written change, from the route's answer (an add, a change, or Try again's new entry). */
export function written(
  overlay: Overlay,
  entry: InboxEntry,
  timeZone: string,
  now?: number | Date,
): Overlay {
  if (overlay.changes.some((c) => c.entry === entry.id)) return overlay;
  const change = fromEntry(
    entry,
    `local-${overlay.next}`,
    todayIn(timeZone, now),
  );
  return {
    ...overlay,
    changes: [...overlay.changes, change],
    next: overlay.next + 1,
  };
}

/**
 * A discarded change, from the discard route's answer (the entry it closed). A discarded add's row goes with it,
 * unless `stays`: a read taken after the discard still holds an item under the add's id (one the workspace
 * itself made, whose id the add's refusal named), so only its mark goes.
 */
export function discarded(
  overlay: Overlay,
  closed: InboxEntry,
  stays = false,
): Overlay {
  return close(overlay, closed.id, closed.kind === "add" && !stays);
}

/** Try again: the refused entry closes, and its new entry waits. */
export function retried(
  overlay: Overlay,
  refused: string,
  again: InboxEntry,
  timeZone: string,
  now?: number | Date,
): Overlay {
  return written(
    close(overlay, refused, again.kind === "add"),
    again,
    timeZone,
    now,
  );
}

function close(overlay: Overlay, entry: string, add: boolean): Overlay {
  return {
    ...overlay,
    changes: overlay.changes.filter((c) => c.entry !== entry),
    closed: [
      ...overlay.closed.filter((c) => c.entry !== entry),
      { entry, add },
    ],
  };
}

/** Whether this page deleted the item and the workspace has not taken it yet (Item deleted). */
export function deletedHere(overlay: Overlay, item: string): boolean {
  return overlay.changes.some(
    (c) => c.kind === "delete" && c.items.includes(item),
  );
}

// -- reading -----------------------------------------------------------------------------------

function refusedBy(sync: ItemSync): string | null {
  return sync !== null && typeof sync === "object" ? sync.entry : null;
}

/** The entries a read names: refused ones (with the engine's line), waiting unplaced ones. */
function named(read: AgendaRead): {
  refused: Set<string>;
  waiting: Set<string>;
} {
  const refused = new Set<string>();
  const waiting = new Set<string>();
  for (const row of read.agenda) {
    const entry = refusedBy(row.sync);
    if (entry) refused.add(entry);
  }
  for (const u of read.unplaced ?? []) {
    if (u.refused !== null || refusedBy(u.sync)) refused.add(u.entry);
    else waiting.add(u.entry);
  }
  return { refused, waiting };
}

const ENDED = ["solved", "dropped"];

/** Whether the read comes from after a sync that landed once the change was written. */
function landedAfter(
  synced: string | null | undefined,
  created: string | null,
): boolean {
  if (!synced || !created) return false;
  const at = Date.parse(synced);
  const made = Date.parse(created);
  return Number.isFinite(at) && Number.isFinite(made) && at > made;
}

/** Whether the read's rows already show the change's result. */
function shown(change: PendingChange, read: AgendaRead): boolean {
  const rows = read.agenda.filter((r) => change.items.includes(r.id));
  const all = (test: (row: AgendaItem) => boolean) =>
    rows.length > 0 && rows.every(test);
  const f = change.fields;
  switch (change.kind) {
    case "propose":
      return all((r) => r.state === "proposed" && !r.accepting);
    case "solve":
      return all((r) => r.state === "solved");
    case "drop":
      return all((r) => r.state === "dropped");
    case "reopen":
      return all((r) => !ENDED.includes(r.state ?? ""));
    case "accept":
      return all((r) => r.state !== "proposed" || r.accepting === true);
    case "edit":
      return all(
        (r) =>
          (f.title === undefined || r.title === f.title) &&
          (f.note === undefined || r.note === f.note),
      );
    case "move": {
      const ids = read.agenda.map((r) => r.id);
      const at = ids.indexOf(change.items[0]);
      if (at === -1) return false;
      if (typeof f.before === "string") return ids[at + 1] === f.before;
      if (typeof f.after === "string") return ids[at - 1] === f.after;
      return false;
    }
    default:
      return false;
  }
}

/** Fold a new read into the overlay: what it shows applied or refused clears. */
export function reconcile(overlay: Overlay, read: AgendaRead): Overlay {
  const { refused, waiting } = named(read);
  const ids = new Set(read.agenda.map((r) => r.id));
  const changes: PendingChange[] = [];
  for (const c of overlay.changes) {
    // Not answered yet: no read can know it.
    if (c.entry === null) {
      changes.push(c);
      continue;
    }
    // Refused: the read shows the engine's line itself.
    if (refused.has(c.entry)) continue;
    // Waiting, its items gone: the read lists it in `unplaced`.
    if (waiting.has(c.entry)) {
      changes.push({ ...c, seen: true });
      continue;
    }
    if (c.kind === "add") {
      // The read carries the add's row (waiting, refused or taken): it is the read's now.
      if (c.minted !== null && ids.has(c.minted)) continue;
      changes.push(c);
      continue;
    }
    if (c.kind === "delete") {
      // The read hides the items (waiting) or no longer holds them (taken).
      if (c.items.every((id) => !ids.has(id))) continue;
      changes.push(c);
      continue;
    }
    const rows = read.agenda.filter((r) => c.items.includes(r.id));
    if (rows.length === 0) continue; // its items are gone, and no change of them is open
    // Marked waiting: this change, or another member's on the same item; it stays either way.
    if (rows.some((r) => r.sync === "waiting")) {
      changes.push(c);
      continue;
    }
    // No mark: taken, once a read named it waiting, its result shows, or a sync landed after it
    // (the engine may store it otherwise than it was sent); else a read from before it.
    if (c.seen || shown(c, read) || landedAfter(read.synced, c.created))
      continue;
    changes.push(c);
  }
  // A closed entry stays hidden while a read still names it (a read from before the close).
  const closed = overlay.closed.filter(
    (c) => refused.has(c.entry) || waiting.has(c.entry),
  );
  return { ...overlay, changes, closed };
}

function addedRow(change: PendingChange): AgendaItem {
  const title =
    typeof change.fields.title === "string" ? change.fields.title : null;
  return {
    id: change.minted as string,
    title,
    lang: langOf(title),
    note: typeof change.fields.note === "string" ? change.fields.note : "",
    state: "open",
    created: change.day,
    changed: change.day,
    phases: [],
    outcome: "",
    reason: "",
    sync: "waiting",
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The agenda as the page shows it: the read, with what the page wrote laid over it. */
export function view(
  read: AgendaRead,
  overlay: Overlay,
): { agenda: AgendaItem[]; unplaced: Unplaced[] } {
  const closed = new Map(overlay.closed.map((c) => [c.entry, c]));
  const { refused } = named(read);
  let rows: AgendaItem[] = [];
  for (const row of read.agenda) {
    const entry = refusedBy(row.sync);
    const gone = entry !== null ? closed.get(entry) : undefined;
    if (gone?.add) continue;
    rows.push(gone ? { ...row, sync: null } : { ...row });
  }

  for (const c of overlay.changes) {
    if (c.entry !== null && refused.has(c.entry)) continue;
    const touch = (
      row: AgendaItem,
      patch: Partial<AgendaItem>,
    ): AgendaItem => ({
      ...row,
      ...patch,
      sync: "waiting",
    });
    switch (c.kind) {
      case "add":
        if (c.minted !== null && !rows.some((r) => r.id === c.minted)) {
          rows.unshift(addedRow(c));
        }
        break;
      case "delete":
        rows = rows.filter((r) => !c.items.includes(r.id));
        break;
      case "edit":
        rows = rows.map((r) => {
          if (!c.items.includes(r.id)) return r;
          const patch: Partial<AgendaItem> = { changed: c.day };
          if (typeof c.fields.title === "string") {
            patch.title = c.fields.title;
            patch.lang = langOf(c.fields.title);
          }
          if (typeof c.fields.note === "string") patch.note = c.fields.note;
          return touch(r, patch);
        });
        break;
      case "propose":
        // Proposed again, out of the open order, until the sync takes it (the read says who proposed it then)
        rows = rows.map((r) =>
          c.items.includes(r.id)
            ? touch(r, {
                state: "proposed",
                accepting: false,
                proposed: r.proposed ?? { by: null, at: null },
                outcome: "",
                reason: "",
                changed: c.day,
              })
            : r,
        );
        break;
      case "item-done":
      case "item-dismiss":
      case "item-reopen":
      case "item-delete":
      case "split":
        // An item change: the agenda waits; the read itself predicts its items, counts and status (the
        // engine's auto-close), so nothing more is laid over it here.
        rows = rows.map((r) => (c.items.includes(r.id) ? touch(r, {}) : r));
        break;
      case "solve":
      case "drop":
        rows = rows.map((r) =>
          c.items.includes(r.id)
            ? touch(r, {
                state: c.kind === "solve" ? "solved" : "dropped",
                outcome: c.kind === "solve" ? text(c.fields.outcome) : "",
                reason: c.kind === "drop" ? text(c.fields.reason) : "",
                changed: c.day,
              })
            : r,
        );
        break;
      case "accept":
        // Open, first in the open order (after the Proposed part), until the sync takes it.
        rows = rows.map((r) =>
          c.items.includes(r.id) && r.state === "proposed"
            ? touch(r, { accepting: true })
            : r,
        );
        break;
      case "entry":
        // A note on the thread: the item waits; the thread itself is the read's.
        rows = rows.map((r) => (c.items.includes(r.id) ? touch(r, {}) : r));
        break;
      case "reopen": {
        // Open (In progress as its phases say: `itemState`), at the end of the operator's order.
        const moved = rows
          .filter((r) => c.items.includes(r.id))
          .map((r) =>
            touch(r, {
              state: "open",
              outcome: "",
              reason: "",
              changed: c.day,
            }),
          );
        rows = [...rows.filter((r) => !c.items.includes(r.id)), ...moved];
        break;
      }
      case "move": {
        const id = c.items[0];
        const at = rows.findIndex((r) => r.id === id);
        if (at === -1) break;
        const row = touch(rows[at], {});
        const rest = rows.filter((_, i) => i !== at);
        const before =
          typeof c.fields.before === "string" ? c.fields.before : null;
        const after =
          typeof c.fields.after === "string" ? c.fields.after : null;
        const target = rest.findIndex((r) => r.id === (before ?? after));
        if (target === -1) {
          rows = rows.map((r, i) => (i === at ? row : r));
          break;
        }
        rest.splice(before !== null ? target : target + 1, 0, row);
        rows = rest;
        break;
      }
    }
  }

  // An id is shown once: the first place wins.
  const seen = new Set<string>();
  rows = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const unplaced = (read.unplaced ?? []).filter((u) => !closed.has(u.entry));
  return { agenda: rows, unplaced };
}
