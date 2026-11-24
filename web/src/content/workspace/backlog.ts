// The backlog's words (design job 02, rounds 01-workspace and 02-agenda-and-links: `Backlog*.dc.html`, frame.md
// F36, F78, F304), verbatim. The shared heads, labels and sentences are the frame's (`./frame`); this file holds
// what only the backlog says. Imported by its own path, never through `content/index.ts`.

import { plural } from "@/lib/format";

import { WS_GLOSSARY, WS_PAGER, WS_STATES } from "./frame";

export const BACKLOG = {
  /** What waits on the operator: the panel's name and its head (`BacklogWaiting.dc.html`). */
  waiting: WS_GLOSSARY.heads.waiting,
  now: {
    head: WS_GLOSSARY.heads.now,
    /** The head's end with two or more running streams. */
    streams: (n: number) => `${n} streams`,
    /** Read before a stream's branch by a screen reader. */
    branch: "Branch ",
    labels: WS_GLOSSARY.labels.pointer,
    /** No stream has a phase: one sentence, by what the phases are. */
    idle: {
      done: "Nothing is in progress. Every phase is done.",
      planned:
        "Nothing is in progress. A planned phase starts when it is run in the workspace.",
      plain: "Nothing is in progress.",
    },
    failed: WS_STATES.partFailed.backlog,
    retry: WS_STATES.retry,
  },
  phases: {
    head: WS_GLOSSARY.heads.phases,
    archived: WS_GLOSSARY.heads.archivedPhases,
    /** A panel's count (F304): `12 phases`. */
    count: (n: number) => plural(n, "phase"),
    /** The column labels from 68em of list width. */
    columns: {
      phase: WS_GLOSSARY.labels.backlogColumns[0],
      status: WS_GLOSSARY.labels.backlogColumns[1],
      review: WS_GLOSSARY.labels.backlogColumns[2],
      slices: WS_GLOSSARY.labels.backlogColumns[3],
    },
    /** Before each verdict, visible under 68em and read by a screen reader from 68em. */
    review: WS_GLOSSARY.labels.backlogColumns[2],
    pager: WS_PAGER.archived,
  },
  loading: "Loading…",
} as const;
