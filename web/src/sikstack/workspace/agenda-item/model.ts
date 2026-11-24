/**
 * An agenda item's page, as pure functions (design job 02, round 02-agenda-and-links: `AgendaItem.dc.html`,
 * `AgendaItemHead.dc.html`; frame.md F45, F301, F303, F309): what the page draws from its read and from the
 * changes it wrote that the workspace has not taken yet. No React and no I/O, so the server page, the client
 * page and the Node tests all import it.
 *
 * - `itemLines(item, workspace)`: the rows the page draws of other records: the item's phases in the backlog's
 *   order (the running one first, then newest first: the Workspace's own order). A phase the Workspace does not
 *   hold is not drawn. (A deferred job the engine folded onto the item reads as its `issue` entry in the thread.)
 * - `headActions(state, proposed)`: the head's buttons in F309's one order: **Delete, Edit, Defer, Drop, Solve**
 *   while the item is open or in progress; **Delete, Edit, Reopen** while it is deferred, solved or dropped;
 *   **Delete, Edit, Drop, Accept** while it is Proposed (P61-e9: an agent opened it and no one accepted it yet),
 *   Accept the primary.
 * - `itemView(read, overlay)`: the item as the page shows it, its state, the primary Solve (only while it is
 *   open and every linked phase is done), its marks (Waiting for sync, a refused change), its long facts and
 *   the Phases panel's form (rows, the command to plan one, or none on an ended item); null when this page
 *   deleted it. It draws the item the page now shows, which is another id only after Try again on a refused add.
 *   A Proposed item reads Proposed and who proposed it and when; one whose Accept waits for the sync (`accepting`)
 *   reads Open already. The view carries the item's thread (`entries`, oldest first) for the Thread panel.
 */

import { PROPOSED, THREAD } from "@/content/workspace/agenda-thread";
import { WS_ACTIONS } from "@/content/workspace/frame";
import {
  everyPhaseDone,
  itemState,
  langOf,
  phaseLookup,
} from "@/lib/workspace/model";
import { view, type Overlay } from "@/lib/workspace/optimistic";
import type {
  AgendaItem,
  ChangeKind,
  ItemState,
  PhaseRow,
  Proposed,
  ThreadEntry,
} from "@/lib/workspace/types";

/** A linked phase as the item's Phases panel draws it (F43, F39). */
export interface PhaseLine {
  id: string;
  short: string;
  name: string;
  lang: "en" | "ko";
  status: string | null;
  done: number;
  total: number;
  /** The slice being worked on, shown under the name while the phase is not done: `S4 Agenda and links`, or
   * its short id alone when the store has no name for it. */
  current: string | null;
  currentLang: "en" | "ko";
}

/** What the page read: the item, and the rows of its phases. */
export interface ItemRead {
  item: AgendaItem;
  phases: PhaseLine[];
  /** The Workspace's sync instant the read carried (`workspace.sync.at`), for the overlay (`AgendaRead.synced`). */
  synced?: string | null;
}

function currentLine(p: PhaseRow): string | null {
  const id = p.currentRef?.id ?? p.current;
  if (!id) return null;
  const name = p.currentRef?.name;
  return name ? `${id} ${name}` : id;
}

/** The rows of the item's phases, in the Workspace's order. */
export function itemLines(
  item: Pick<AgendaItem, "phases">,
  workspace: { phases: readonly PhaseRow[] } | null,
): { phases: PhaseLine[] } {
  if (!workspace) return { phases: [] };
  const linked = new Set(item.phases);
  const phases = workspace.phases
    .filter((p) => linked.has(p.id) || linked.has(p.short))
    .map((p) => ({
      id: p.id,
      short: p.short,
      name: p.name ?? p.id,
      lang: langOf(p.name),
      status: p.status,
      done: p.done,
      total: p.total,
      current: currentLine(p),
      currentLang: langOf(p.currentRef?.name),
    }));
  return { phases };
}

/** A button of the item's head. */
export type HeadAction =
  "delete" | "edit" | "defer" | "drop" | "solve" | "reopen" | "accept";

const SET_ASIDE: readonly ItemState[] = ["deferred", "solved", "dropped"];

/** Whether the item is set aside or ended: its head offers Reopen and it has no Defer, Drop or Solve. */
export function isSetAside(state: ItemState): boolean {
  return SET_ASIDE.includes(state);
}

/** The head's buttons for a state, in F309's order; a Proposed item's end on Accept, its way in, with Drop its way out. */
export function headActions(state: ItemState, proposed = false): HeadAction[] {
  if (proposed) return ["delete", "edit", "drop", "accept"];
  return isSetAside(state)
    ? ["delete", "edit", "reopen"]
    : ["delete", "edit", "defer", "drop", "solve"];
}

export interface ItemView {
  item: AgendaItem;
  status: ItemState;
  actions: HeadAction[];
  /** Every linked phase is done and the item is open: the sentence, and Solve is the primary button. */
  allDone: boolean;
  waiting: boolean;
  /** A change the workspace refused: what it said, and the entry Discard and Try again name. */
  refused: { said: string; entry: string; kind: ChangeKind | null } | null;
  /** Outcome (solved) or Reason (dropped), when the line is not empty. */
  end: { label: "outcome" | "reason"; text: string } | null;
  note: string | null;
  phases: PhaseLine[];
  /** The Phases panel: its rows, the command to plan one (no phase, not ended), or none (no phase, ended). */
  phasesPanel: "rows" | "command" | null;
  /** While the item reads Proposed: who opened it and when (Accept is then the head's primary); else null. */
  proposed: Proposed | null;
  /** Its thread, oldest first (a waiting web entry last), as the item read gives it. */
  thread: ThreadEntry[];
}

/** What the server page read: the item with its rows, or nothing (the project named for Not found). */
export type ItemPageRead =
  | ({ state: "ready" } & ItemRead)
  | { state: "not-found"; projectName: string | null };

/**
 * The item as the page shows it: the read, with what the page wrote laid over it; null when it deleted it.
 *
 * `id` is the item the page now shows, the read's own by default. It differs only after Try again on a refused
 * add, which the route re-sent under a new id: that add is drawn from what the page wrote, with no phase (an add
 * holds none), and `read` may be null (the old id's read no longer holds anything).
 */
export function itemView(
  read: ItemRead | null,
  overlay: Overlay,
  id: string | null = read?.item.id ?? null,
): ItemView | null {
  const own = read !== null && read.item.id === id;
  const shown = view({ agenda: read ? [read.item] : [] }, overlay).agenda.find(
    (row) => row.id === id,
  );
  if (!shown) return null;
  const phases = own ? read.phases : [];
  const lookup = phaseLookup(phases);
  const status = itemState(shown, lookup);
  const ended = status === "solved" || status === "dropped";
  const endText =
    status === "solved"
      ? shown.outcome
      : status === "dropped"
        ? shown.reason
        : "";
  const sync = shown.sync;
  // an Accept that waits for the sync (`accepting`): the item reads Open already, and offers no second Accept
  const proposed =
    shown.state === "proposed" && !shown.accepting
      ? (shown.proposed ?? { by: null, at: null })
      : null;
  return {
    item: shown,
    status,
    actions: headActions(status, proposed !== null),
    allDone:
      status === "open" &&
      phases.length > 0 &&
      everyPhaseDone({ phases: phases.map((p) => p.id) }, lookup),
    waiting: sync === "waiting",
    refused:
      sync !== null && typeof sync === "object"
        ? { said: sync.refused, entry: sync.entry, kind: sync.kind ?? null }
        : null,
    end: endText
      ? { label: status === "solved" ? "outcome" : "reason", text: endText }
      : null,
    note: shown.note ? shown.note : null,
    phases,
    phasesPanel: phases.length > 0 ? "rows" : ended ? null : "command",
    proposed,
    thread: shown.entries ?? [],
  };
}

/** A change's own pending label, for Try again on the refused notice (F45: `Saving…` for an edit). */
export const PENDING_LABEL: Record<ChangeKind, string> = {
  add: WS_ACTIONS.add[1],
  edit: WS_ACTIONS.save[1],
  move: WS_ACTIONS.save[1],
  defer: WS_ACTIONS.defer[1],
  solve: WS_ACTIONS.solve[1],
  drop: WS_ACTIONS.drop[1],
  reopen: WS_ACTIONS.reopen[1],
  delete: WS_ACTIONS.delete[1],
  entry: THREAD.composer.add[1],
  accept: PROPOSED.accept[1],
};

/**
 * Try again's pending label on a refused change: its kind's own (`Dropping…` for a drop), `Saving…` when no kind
 * is known (a read from an older server).
 */
export function retryLabel(kind: ChangeKind | null | undefined): string {
  return PENDING_LABEL[kind ?? "edit"] ?? PENDING_LABEL.edit;
}
