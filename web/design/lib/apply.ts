import { langOf } from "@/lib/workspace/model";
import type {
  AgendaItem,
  ChangeKind,
  InboxKind,
  ThreadEntry,
  Workspace,
} from "@/lib/workspace/types";

/**
 * One agenda change applied to a workspace, as the engine applies it at its next sync
 * (`plugins/sikstack/scripts/wf_agenda.py`), so the design shows what production shows once the
 * change is taken. Pure: the store (`store.ts`) holds the state; nothing here reads or writes.
 *
 * - add: first in the agenda, Open, under the id `mint` gives;
 * - edit: the title, the note or both;
 * - move: an Open item before or after another Open item;
 * - defer (from Open), solve and drop (from Open or Deferred, with the outcome or reason), reopen
 *   (from Deferred, Solved or Dropped: last in the open order, outcome and reason cleared);
 * - delete: the items leave the agenda;
 * - accept (P61-e9): Proposed items become Open, first in the open order, their `proposed` gone;
 * - entry (P61-e9): one entry on an item's thread, last, `Waiting for sync` (the design never syncs, so it waits, as
 *   a pending web entry reads until the engine takes it); its author is the signed-in account's (`ctx.author`).
 *
 * A change the engine would refuse comes back as its line (`{ok: false, refused}`), unapplied.
 */
export interface AgendaChange {
  kind: InboxKind;
  items: string[];
  fields: Record<string, unknown>;
}

export type Applied =
  | { ok: true; workspace: Workspace; minted: string | null }
  | { ok: false; refused: string };

const SHOWN: Record<string, string> = {
  open: "Open",
  in_progress: "In progress",
  deferred: "Deferred",
  solved: "Solved",
  dropped: "Dropped",
};

const FROM: Partial<Record<ChangeKind, string[]>> = {
  defer: ["open"],
  solve: ["open", "deferred"],
  drop: ["open", "deferred"],
  reopen: ["deferred", "solved", "dropped"],
};

const TO: Partial<Record<ChangeKind, string>> = {
  defer: "deferred",
  solve: "solved",
  drop: "dropped",
  reopen: "open",
};

const text = (v: unknown) => (typeof v === "string" ? v : "");

export function applyChange(
  workspace: Workspace,
  change: AgendaChange,
  ctx: {
    day: string;
    mint: () => string;
    /** The entry's id (its inbox id) and when it was written, for an `entry`. */
    entry?: { id: string; at: string; author: string; source?: string };
  },
): Applied {
  const agenda: AgendaItem[] = workspace.agenda.map((a) => ({ ...a }));
  const find = (id: string) => agenda.find((a) => a.id === id);
  const done = (next: AgendaItem[], minted: string | null = null): Applied => ({
    ok: true,
    workspace: { ...workspace, agenda: next },
    minted,
  });

  if (change.kind === "add") {
    const title = text(change.fields.title);
    const id = ctx.mint();
    const row: AgendaItem = {
      id,
      title,
      lang: langOf(title),
      note: text(change.fields.note),
      state: "open",
      created: ctx.day,
      changed: ctx.day,
      phases: [],
      outcome: "",
      reason: "",
      sync: change.fields.waiting === true ? "waiting" : null,
      proposed: null,
      entryCount: 0,
      latest: ctx.day,
      entries: [],
    };
    // first in the open order: after the Proposed items, which the read lists before it
    const at = agenda.findIndex((a) => a.state !== "proposed");
    const next = [...agenda];
    next.splice(at === -1 ? next.length : at, 0, row);
    return done(next, id);
  }

  for (const id of change.items) {
    if (!find(id)) return { ok: false, refused: `${id} names no agenda item` };
  }

  if (change.kind === "entry") {
    const row = find(change.items[0]) as AgendaItem;
    const e = ctx.entry;
    if (!e) return { ok: false, refused: "an entry needs its author" };
    const body = text(change.fields.body).trim();
    if (!body) return { ok: false, refused: "an entry needs a body of text" };
    const author = e.author;
    const at = author.indexOf(":");
    const entry: ThreadEntry = {
      id: e.id,
      kind: text(change.fields.kind) || "note",
      author,
      by: author.startsWith("agent:") ? "agent" : "person",
      name: at > 0 ? author.slice(at + 1) : author,
      source: e.source ?? "web:agenda",
      created: e.at,
      body,
      job: null,
      sync: "waiting",
    };
    row.entries = [...(row.entries ?? []), entry];
    // the read marks an item whose thread holds a pending web entry waiting, as it does any open change on it
    row.sync = "waiting";
    row.entryCount = (row.entryCount ?? 0) + 1;
    row.latest = ctx.day;
    return done(agenda);
  }

  if (change.kind === "accept") {
    for (const id of change.items) {
      const row = find(id) as AgendaItem;
      if (row.state !== "proposed")
        return { ok: false, refused: `${id} is ${SHOWN[row.state ?? ""] ?? row.state}: only a Proposed item is accepted` };
    }
    // each becomes Open, first in the open order (after the Proposed items left), in the order named
    const moved = change.items.map((id) => {
      const row = find(id) as AgendaItem;
      row.state = "open";
      row.proposed = null;
      row.changed = ctx.day;
      row.sync = "waiting";
      return row;
    });
    const rest = agenda.filter((a) => !change.items.includes(a.id));
    const at = rest.findIndex((a) => a.state !== "proposed");
    rest.splice(at === -1 ? rest.length : at, 0, ...moved);
    return done(rest);
  }

  if (change.kind === "delete") {
    return done(agenda.filter((a) => !change.items.includes(a.id)));
  }

  if (change.kind === "edit") {
    const row = find(change.items[0]) as AgendaItem;
    if (typeof change.fields.title === "string") {
      row.title = change.fields.title;
      row.lang = langOf(row.title);
    }
    if (typeof change.fields.note === "string") row.note = change.fields.note;
    row.changed = ctx.day;
    return done(agenda);
  }

  if (change.kind === "move") {
    const id = change.items[0];
    const row = find(id) as AgendaItem;
    if (row.state !== "open")
      return {
        ok: false,
        refused: `${id} is ${SHOWN[row.state ?? ""] ?? row.state}: only an Open item moves; reopen it first`,
      };
    const before = text(change.fields.before);
    const after = text(change.fields.after);
    const targetId = before || after;
    const target = find(targetId);
    if (!target) return { ok: false, refused: `${targetId} names no agenda item` };
    if (target.state !== "open")
      return {
        ok: false,
        refused: `${targetId} is ${SHOWN[target.state ?? ""] ?? target.state}: an item moves only beside an Open item`,
      };
    const rest = agenda.filter((a) => a.id !== id);
    const at = rest.findIndex((a) => a.id === targetId);
    rest.splice(before ? at : at + 1, 0, row);
    return done(rest);
  }

  const kind = change.kind as ChangeKind;
  const to = TO[kind];
  const from = FROM[kind];
  if (!to || !from) return { ok: false, refused: `${change.kind} is not an agenda change` };
  for (const id of change.items) {
    const row = find(id) as AgendaItem;
    if (!from.includes(row.state ?? ""))
      return {
        ok: false,
        refused: `${id} is ${SHOWN[row.state ?? ""] ?? row.state}: it cannot be ${to === "open" ? "reopened" : to}`,
      };
  }
  let next = agenda;
  for (const id of change.items) {
    const row = find(id) as AgendaItem;
    row.state = to;
    row.changed = ctx.day;
    row.outcome = to === "solved" ? text(change.fields.outcome) : "";
    row.reason = to === "dropped" ? text(change.fields.reason) : "";
    if (to === "open") {
      // last in the open order: after the last Open row
      next = next.filter((a) => a.id !== id);
      let last = -1;
      next.forEach((a, i) => {
        if (a.state === "open" || a.state === "in_progress") last = i;
      });
      next.splice(last + 1, 0, row);
    }
  }
  return done(next);
}
