/**
 * Picked rows (design job 02, `AgendaList.dc.html`, frame.md F303, F309): pure, so the client list and the tests
 * share it.
 *
 * - **Selection is a part's own** and covers the part's rows **on screen**: the Solved and dropped part's newest five
 *   until Show all (round:Q2). A ticked id that is no longer on screen is not picked.
 * - The part's box picks every row on screen, or clears them when all are picked; it is half set when some are.
 * - The actions, in one order everywhere (F309): Open **Delete, Propose, Drop, Solve**; Solved and dropped **Delete,
 *   Reopen**. **Drop and Delete ask**; Propose, Solve and Reopen act at once.
 * - Each action is one change for all the picked ids, sent in the agenda's own order (the engine reopens in the
 *   order the ids are given, and the page shows a reopen in the agenda's order: the two agree).
 */
import {
  AGENDA,
  type AgendaAct,
  type AgendaPartName,
} from "@/content/workspace/agenda";
import type { Sending } from "@/lib/workspace/optimistic";

import { endedShown, type AgendaParts, type AgendaRowModel } from "./model";

export type { AgendaAct };

/** What is ticked, by part (ids; only those on screen count). */
export type Picks = Record<AgendaPartName, readonly string[]>;

export const NO_PICKS: Picks = { open: [], ended: [] };

/** Each part's actions, in the one order (F309). */
export const PART_ACTS: Record<AgendaPartName, readonly AgendaAct[]> = {
  open: ["delete", "propose", "drop", "solve"],
  ended: ["delete", "reopen"],
};

/** Drop and Delete ask first (F303); the others act at once. */
export function actAsks(kind: AgendaAct): kind is "drop" | "delete" {
  return kind === "drop" || kind === "delete";
}

/** One part's selection, as its head, its rows and its strip draw it. */
export interface PartPick {
  part: AgendaPartName;
  /** The part's rows on screen, in the order shown: what its box picks. */
  shown: string[];
  /** The ticked rows on screen, in the order shown. */
  picked: string[];
  /** Every row on screen is ticked (the part's box is checked). */
  all: boolean;
  /** Some, not all (the box is half set). */
  some: boolean;
  /** `3 of 25 selected`, or the part's count at rest. */
  count: string;
  /** The box's name: `Select all 5 open agendas`, `Select the 5 solved and dropped agendas on this page`. */
  allLabel: string;
  /** The strip's name: `Act on the selected open agendas`. */
  bulkLabel: string;
  acts: readonly AgendaAct[];
}

/** A part's selection from what is ticked: only the rows on screen count. `total` is the part's whole count. */
export function partPick(
  part: AgendaPartName,
  shown: readonly string[],
  total: number,
  ticked: readonly string[],
): PartPick {
  const on = new Set(ticked);
  const picked = shown.filter((id) => on.has(id));
  const all = shown.length > 0 && picked.length === shown.length;
  return {
    part,
    shown: [...shown],
    picked,
    all,
    some: picked.length > 0 && !all,
    count: picked.length
      ? AGENDA.pick.count(picked.length, total)
      : AGENDA.count(total),
    allLabel: AGENDA.pick.all(part, shown.length, total),
    bulkLabel: AGENDA.pick.bulk(part),
    acts: PART_ACTS[part],
  };
}

/** Each part's rows on screen: the open rows, the Solved and dropped part's five or all. */
export interface OnScreen {
  open: AgendaRowModel[];
  ended: AgendaRowModel[];
  /** Show all's count, or null when every ended row is shown. */
  more: number | null;
}

export function rowsOnScreen(parts: AgendaParts, all: boolean): OnScreen {
  const ended = endedShown(parts.ended, all);
  return {
    open: [...parts.open],
    ended: ended.rows,
    more: ended.more,
  };
}

/** Each part's selection: its rows on screen against what is ticked, counted against the whole part. */
export function partPicks(
  on: OnScreen,
  parts: AgendaParts,
  ticked: Picks,
): Record<AgendaPartName, PartPick> {
  const pick = (part: AgendaPartName) =>
    partPick(
      part,
      on[part].map((r) => r.id),
      parts[part].length,
      ticked[part],
    );
  return {
    open: pick("open"),
    ended: pick("ended"),
  };
}

/** The part's box pressed: every row on screen, or none when all of them were picked. */
export function toggleAll(pick: PartPick): string[] {
  return pick.all ? [] : [...pick.shown];
}

/** A row's box pressed. */
export function toggleRow(ticked: readonly string[], id: string): string[] {
  return ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id];
}

/** The picked ids in the agenda's own order (the order sent). */
export function sendOrder(
  agenda: readonly { id: string }[],
  picked: readonly string[],
): string[] {
  const on = new Set(picked);
  return agenda.filter((it) => on.has(it.id)).map((it) => it.id);
}

/** An action that acts at once, as the overlay shows it before its answer (Solve with no outcome, round:Q3). */
export function actSending(
  kind: "propose" | "solve" | "reopen",
  items: readonly string[],
): Sending {
  return { kind, items: [...items], fields: {} };
}
