import { plural } from "@/lib/format";

import {
  WS_ACTIONS,
  WS_CHANGE,
  WS_GLOSSARY,
  WS_PAGER,
  WS_STATES,
} from "./frame";

/** An action on picked rows (F303). */
export type AgendaAct = "delete" | "defer" | "reopen" | "drop" | "solve";
/** The Agenda's three parts. */
export type AgendaPartName = "open" | "deferred" | "ended";

const PART_NAMES: Record<AgendaPartName, string> = {
  open: "open items",
  deferred: "deferred items",
  ended: "solved and dropped items",
};

const ACTED: Record<Exclude<AgendaAct, "delete">, string> = {
  defer: "deferred",
  solve: "solved",
  drop: "dropped",
  reopen: "reopened, at the end of the open items",
};

const SAID_DELETED = (title: string): string =>
  `“${title}” deleted. It leaves the workspace at the next sync.`;
const SAID_DELETED_MANY = (n: number): string =>
  `${n} items deleted. They leave the workspace at the next sync.`;

/**
 * The Agenda's words (design job 02, rounds 01-workspace and 02-agenda-and-links: `AgendaList.dc.html`, frame.md
 * F36, F45, F49, F78, F301 to F303), verbatim. Imported by path (`@/content/workspace/agenda`). What the frame
 * already says (the heads, the actions, a change that waits, the part that failed, the pager's name) is taken from
 * `./frame`, never retyped.
 */
export const AGENDA = {
  heads: {
    open: WS_GLOSSARY.heads.openAndInProgress,
    deferred: WS_GLOSSARY.heads.deferred,
    ended: WS_GLOSSARY.heads.solvedAndDropped,
  },
  /** A part's count: `5 items`, `1 item`, `0 items`. */
  count: (n: number): string => plural(n, "item"),
  addItem: WS_ACTIONS.addItem,
  form: {
    title: WS_ACTIONS.title,
    titlePlaceholder: "e.g. Sign-in emails land in spam",
    note: WS_ACTIONS.note,
    cancel: WS_ACTIONS.cancel,
    add: WS_ACTIONS.add,
    titleError: WS_CHANGE.titleError,
    failed: WS_CHANGE.addFailed,
  },
  /** The list's status line (`role="status"`). */
  said: {
    added: (title: string): string =>
      `“${title}” added. It waits for the next sync.`,
    deleted: (title: string): string => SAID_DELETED(title),
    deletedMany: (n: number): string => SAID_DELETED_MANY(n),
    /** A reorder's steps (F302), `at` and `of` 1-based. */
    pickedUp: (title: string, at: number, of: number): string =>
      `“${title}” picked up, ${at} of ${of}. The arrow keys move it, Space puts it down, Escape puts it back.`,
    /** A pointer's lift: the keys' sentence does not apply to it. */
    pickedUpByPointer: (title: string, at: number, of: number): string =>
      `“${title}” picked up, ${at} of ${of}.`,
    movedTo: (title: string, at: number, of: number): string =>
      `“${title}” moved to ${at} of ${of}.`,
    putDown: (title: string, at: number, of: number): string =>
      `“${title}” put down at ${at} of ${of}. It waits for the next sync.`,
    putBack: (title: string): string => `“${title}” put down where it was.`,
    cancelled: (title: string, at: number, of: number): string =>
      `Move cancelled. “${title}” is back at ${at} of ${of}.`,
    /** An action on the picked rows (F303): `3 items deferred. They wait for the next sync.` */
    acted: (kind: AgendaAct, n: number, title: string): string => {
      const who = n === 1 ? `“${title}”` : `${n} items`;
      if (kind === "delete")
        return n === 1 ? SAID_DELETED(title) : SAID_DELETED_MANY(n);
      return `${who} ${ACTED[kind]}. ${n === 1 ? "It waits" : "They wait"} for the next sync.`;
    },
  },
  /** The grip (F302): named for its item, described by one hidden sentence. */
  grip: {
    label: (title: string): string => `Reorder: ${title}`,
    how: "Space picks the item up. The arrow keys move it, Space puts it down, Escape puts it back.",
  },
  /** Picked rows (F303, F309): the boxes, the count, Clear, the actions and the narrow strip. */
  pick: {
    row: (title: string): string => `Select: ${title}`,
    /** The part's box, named for the rows on screen. */
    all: (part: AgendaPartName, shown: number, total: number): string =>
      shown === total
        ? `Select all ${total} ${PART_NAMES[part]}`
        : `Select the ${shown} ${PART_NAMES[part]} on this page`,
    count: (n: number, total: number): string => `${n} of ${total} selected`,
    clear: "Clear",
    bulk: (part: AgendaPartName): string =>
      `Act on the selected ${PART_NAMES[part]}`,
    acts: {
      delete: WS_ACTIONS.delete[0],
      defer: WS_ACTIONS.defer[0],
      reopen: WS_ACTIONS.reopen[0],
      drop: WS_ACTIONS.drop[0],
      solve: WS_ACTIONS.solve[0],
    },
  },
  /** F4's sentence for an action or a move whose send got no usable answer (F45's pattern; listed for the walk). */
  actFailed: (kind: AgendaAct | "move", n: number): string =>
    `Could not ${kind} the ${n === 1 ? "item" : "items"}. Try again.`,
  /** Drop asks first (F303), naming what it acts on; one optional Reason. */
  confirmDrop: {
    title: (title: string): string => `Drop “${title}”?`,
    before: "Drop “",
    after: "”?",
    titleMany: (n: number): string => `Drop ${n} items?`,
    text: "It moves to Solved and dropped. Reopen brings it back.",
    textMany: "They move to Solved and dropped. Reopen brings one back.",
    reason: WS_ACTIONS.reason,
    cancel: WS_ACTIONS.cancel,
    yes: ["Yes, drop", WS_ACTIONS.drop[1]] as const,
  },
  empty: {
    none: "No items yet. Add what you want done or dealt with, at any size.",
    noOpen: "No open items. Add what you want done or dealt with next.",
  },
  failed: WS_STATES.partFailed.agenda,
  retry: WS_STATES.retry,
  loading: "Loading…",
  row: {
    delete: WS_ACTIONS.delete[0],
    /** The row's Delete, named for its item (F302). */
    deleteLabel: (title: string): string => `Delete: ${title}`,
  },
  /** Delete asks first (F303), naming what it acts on. */
  confirmDelete: {
    title: (title: string): string => `Delete “${title}”?`,
    /** The title in the dialog's `h2`, around the item's own title (its `lang` kept). */
    before: "Delete “",
    after: "”?",
    titleMany: (n: number): string => `Delete ${n} items?`,
    text: "It leaves the agenda for good, with its thread. Its phases stay. You cannot undo this.",
    textMany:
      "They leave the agenda for good, with their threads. Their phases stay. You cannot undo this.",
    cancel: WS_ACTIONS.cancel,
    yes: ["Yes, delete", WS_ACTIONS.delete[1]] as const,
    /** F4's sentence for a send that did not get an answer (F45's pattern; listed for the walk). */
    failed: "Could not delete the item. Try again.",
  },
  pager: WS_PAGER.deferredItems,
  showAll: WS_GLOSSARY.buttons.showAll,
} as const;
