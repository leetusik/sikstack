// An agenda item's page (design job 02, round 02-agenda-and-links: `AgendaItem.dc.html`, `AgendaItemHead.dc.html`,
// `AgendaItemForm.dc.html`; frame.md F45, F301, F303), its own words, verbatim. The words every Workspace page
// shares (the actions and their pending labels, the facts' labels, the field error, the refused notice, Waiting
// for sync, the no-phase sentence) are `./frame`. Imported by its own path, never through `content/index.ts`.

import { plural } from "@/lib/format";

import { WS_ACTIONS, WS_CHANGE } from "./frame";

/** The three forms that open in the slot under the head, each named, with its button and its failed send (F45). */
export const AGENDA_ITEM_FORMS = {
  edit: {
    name: "Edit item",
    submit: WS_ACTIONS.save[0],
    pending: WS_ACTIONS.save[1],
    failed: WS_CHANGE.saveFailed,
  },
  solve: {
    name: "Solve item",
    submit: WS_ACTIONS.solve[0],
    pending: WS_ACTIONS.solve[1],
    failed: WS_CHANGE.solveFailed,
  },
  drop: {
    name: "Drop item",
    submit: WS_ACTIONS.drop[0],
    pending: WS_ACTIONS.drop[1],
    failed: WS_CHANGE.dropFailed,
  },
} as const;

export const AGENDA_ITEM = {
  /** The Delete confirm (F303), one item. */
  confirm: {
    title: (title: string) => `Delete “${title}”?`,
    text: "It leaves the agenda for good, with its note. Its phases and deferred jobs stay. You cannot undo this.",
    yes: "Yes, delete",
    pending: WS_ACTIONS.delete[1],
  },
  /** The page after its own Delete (F303). */
  deleted: {
    title: "Item deleted",
    text: (title: string) =>
      `“${title}” leaves the workspace at the next sync.`,
  },
  /** The Phases panel's count (FG5): `4 phases`. */
  phaseCount: (n: number) => plural(n, "phase"),
  /** The command that plans a phase for an item, in the Copy field (F45). */
  command: (item: string) => `/create-phase ${item}`,
  copyCommand: "Copy the command",
  /** The not-found sentence's project when its name is not known (the canvas's own fallback). */
  thisProject: "this project",
  loading: "Loading…",
} as const;
