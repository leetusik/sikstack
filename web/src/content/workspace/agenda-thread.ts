// The words this design adds to the Workspace's agenda and to Add to agenda (P61-e9: an item's thread, its note
// composer, Proposed and Accept, the choice between a new item and one already on the agenda). Applying the design
// moves this file to `src/content/workspace/agenda-thread.ts`; the next versions import it by that path then. What
// the frame and Add to agenda already say is taken from them, never retyped.
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
  /** The item's fact under its title. */
  by: "Proposed by",
  failed: "Could not accept this item. Try again.",
  said: (title: string): string =>
    `“${title}” accepted, first in the open items. It waits for the next sync.`,
} as const;

/** The kinds of a thread's entry, as a word (the engine's `ENTRY_KINDS`). */
export const ENTRY_KIND: Record<string, string> = {
  note: "Note",
  issue: "Issue",
  feedback: "Feedback",
  question: "Question",
  decision: "Decision",
};

/** An item's thread and its composer. */
export const THREAD = {
  head: "Thread",
  count: (n: number): string => plural(n, "entry", "entries"),
  empty: "Nothing written on this item yet.",
  /** The mark after an agent's name. */
  agent: "Agent",
  /** Where an entry came from, by the kind of its source (`web:agenda`, `feedback:<id>`, `slice:P7-k2.S1`, …). */
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

/** Add to agenda's choice (the confirm), beside the signed words of `ADD`. */
export const PICK = {
  legend: "Add it to",
  newItem: "A new item",
  /** The confirm's sentence for each choice; the first is the signed one. */
  text: {
    newItem: ADD.text,
    existing: (id: string): string =>
      `It joins ${id}’s thread, with this message and a link back to it. You cannot undo this from here.`,
  },
} as const;
