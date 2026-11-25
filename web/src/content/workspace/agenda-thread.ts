// The words of an agenda's items and of Add to agenda (P61-e9, then the agenda items phase: an agenda's items with
// their state, Done, Dismiss, Reopen and Delete on each, the Split, the note composer, Proposed and Accept, the
// choice between a new agenda and one already on the workspace). An **agenda** is the record; what it holds are its
// **items**. What the frame and Add to agenda already say is taken from them, never retyped.
import { plural } from "@/lib/format";
import { ADD } from "@/content/feedback-agenda";

/** The Proposed part of the Agenda and a Proposed item's head. */
export const PROPOSED = {
  head: "Proposed",
  /** The status word, in the shape of a state that waits on a person (`status-pending`). */
  word: "Proposed",
  cls: "status status-pending",
  accept: ["Accept", "Accepting…"] as const,
  acceptLabel: (title: string): string => `Accept: ${title}`,
  /** The agenda's fact under its title. */
  by: "Proposed by",
  failed: "Could not accept this agenda. Try again.",
  said: (title: string): string =>
    `“${title}” accepted, first in the open agendas. It waits for the next sync.`,
} as const;

/** The kinds of an item, as a word (the engine's `ENTRY_KINDS`). */
export const ENTRY_KIND: Record<string, string> = {
  note: "Note",
  issue: "Issue",
  feedback: "Feedback",
  question: "Question",
  decision: "Decision",
};

/** An agenda's items and the note composer. */
export const THREAD = {
  head: "Items",
  count: (n: number): string => plural(n, "item"),
  /** Beside the count while some are open: `3 items, 1 open`. */
  countOpen: (n: number, open: number): string =>
    `${plural(n, "item")}, ${open} open`,
  empty: "Nothing on this agenda yet.",
  /** The mark after an agent's name. */
  agent: "Agent",
  /** Where an item came from, by the kind of its source (`web:agenda`, `feedback:<id>`, `slice:P7-k2.S1`, …). */
  source: {
    web: "Web",
    feedback: "Feedback",
    job: (id: string): string => `Deferred job ${id}`,
  },
  composer: {
    label: "Note",
    add: ["Add note", "Adding…"] as const,
    failed: "Could not add this note. Try again.",
    empty: "Write the note first.",
  },
  said: "Note added. It waits for the next sync.",
} as const;

/** What each item offers, each with its pending label, and what a change says (one inbox entry each). */
export const ITEM = {
  /** An item's state as a word (`entry` in F37's table: Open, Done, Dismissed); a delete that waits says so. */
  deleting: "Deleted",
  done: ["Done", "Saving…"] as const,
  dismiss: ["Dismiss", "Dismissing…"] as const,
  reopen: ["Reopen", "Reopening…"] as const,
  delete: ["Delete", "Deleting…"] as const,
  /** Each button named for its item: `Done: A2-k5/xa01`. */
  label: (action: string, ref: string): string => `${action}: ${ref}`,
  /** The box that picks an item for the Split. */
  pick: (ref: string): string => `Select: ${ref}`,
  /** Who set the state, after the state's word. */
  stateBy: "by",
  failed: "Could not change this item. Try again.",
  /** Delete asks first, naming the item. */
  confirm: {
    title: (ref: string): string => `Delete ${ref}?`,
    text: "It leaves the agenda for good. You cannot undo this.",
    yes: ["Yes, delete", "Deleting…"] as const,
    cancel: "Cancel",
  },
  said: {
    "item-done": (ref: string): string =>
      `${ref} done. It waits for the next sync.`,
    "item-dismiss": (ref: string): string =>
      `${ref} dismissed. It waits for the next sync.`,
    "item-reopen": (ref: string): string =>
      `${ref} reopened. It waits for the next sync.`,
    "item-delete": (ref: string): string =>
      `${ref} deleted. It leaves the agenda at the next sync.`,
  },
} as const;

/** The Split: pick items, give the new agenda a title. */
export const SPLIT = {
  open: "Split",
  name: "Split into a new agenda",
  /** How many are picked: `2 of 5 selected`. */
  count: (n: number, total: number): string => `${n} of ${total} selected`,
  title: "Title",
  titlePlaceholder: "e.g. Retry uploads on slow networks",
  hint: "The selected items move to a new Open agenda; the rest stay here.",
  none: "Select the items to move first.",
  all: "Leave at least one item here.",
  cancel: "Cancel",
  submit: ["Split", "Splitting…"] as const,
  failed: "Could not split this agenda. Try again.",
} as const;

/** Add to agenda's choice (the confirm), beside the signed words of `ADD`. */
export const PICK = {
  legend: "Add it to",
  newItem: "A new agenda",
  /** The confirm's sentence for each choice; the first is the signed one. */
  text: {
    newItem: ADD.text,
    existing: (id: string): string =>
      `It joins ${id} as an item, with this message and a link back to it. You cannot undo this from here.`,
  },
} as const;
