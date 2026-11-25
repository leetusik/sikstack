// The words of Add to agenda and the Agenda part (job 04 round 02, `FeedbackItemSend*`,
// `FeedbackItemAgenda*`; frame.md F341 to F344, F143), verbatim. An agenda's status words are the
// Workspace's (job 02 round 02, frame.md F37's `item` kind; there is no Deferred; D237-we). The part's
// name (`PARTS.agenda`) and the waiting mark (`WAITING`) are the frame's, `@/content/feedback-frame`.
// Imported by its own path, never through `content/index.ts`.

/** The add, at the end of an item's head, and its confirm (F341, F143). */
export const ADD = {
  /** The page's one primary; the confirm's primary too. */
  action: "Add to agenda",
  /** The primary while the add is on its way, in the rest label's width. */
  adding: "Adding…",
  /** The head's end after the add, while it waits and once the workspace has it (F344). */
  added: "Added to agenda",
  cancel: "Cancel",
  /** The confirm's title and accessible name. */
  title: (project: string) => `Add this feedback to ${project}’s agenda?`,
  text: "It becomes the first open item there, with this message and a link back to it. You cannot undo this from here.",
  /** A failure before the add leaves the web: the notice in the confirm. */
  failed: "Could not add this feedback to the agenda. Try again.",
} as const;

/** The Agenda part's sentences (F341, F342). */
export const AGENDA = {
  /** Under the item while it waits (F45's sentence). */
  sync: "The workspace takes this change at its next sync.",
  /** Not offered: the project has no workspace linked. */
  noWorkspace: (project: string) =>
    `${project} has no workspace linked, so it has no agenda to add this to.`,
  /** Not offered: the feedback has no project. */
  noProject:
    "This feedback has no project, so there is no agenda to add it to.",
} as const;

/** An agenda's status, the Workspace's word for each of its four (F37 `item`). */
export const AGENDA_STATUS_WORDS = {
  open: "Open",
  in_progress: "In progress",
  solved: "Solved",
  dropped: "Dropped",
} as const;
