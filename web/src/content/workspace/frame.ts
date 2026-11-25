// The Workspace's words (design job 02, rounds 01-workspace and 02-agenda-and-links): the frame's ledger
// F36 to F40, F45, F49, F78, F300, F301, F303 and F306, and the fixture's `WORDS`, `KIND`, `STOP` and `RISK`
// (`pages/frame/fixture.js`), verbatim. The status classes are the system's names (`.status-pending` for the
// board's `.status-wait`). Imported by its own path, never through `content/index.ts`.

import { plural } from "@/lib/format";

/** The kinds of thing a status word belongs to (F37, F301, F306). */
export type WsStatusKind =
  "phase" | "slice" | "verdict" | "item" | "entry" | "pr" | "gate" | "doc";

/**
 * F37's table: every stored value of each kind to its word and its status class, by meaning: `status-idle`
 * not started, `status-ready` approved, `status-live` running, the bare `status` handed on, `status-pending`
 * waiting on the operator, `status-blocked` cannot go on, `status-changes` sent back, `status-done` finished,
 * `status-revoked` ended without doing. A verdict's `pending` is **Not reviewed** (a phase's and a slice's
 * `pending` is **Waiting on operator**); an agenda (`item`) has no Deferred, and an agenda's item
 * (`entry`) reads Open, Done or Dismissed; a ready pull request reads **Open** (F306).
 */
export const WS_STATUS: Record<
  WsStatusKind,
  Record<string, readonly [word: string, cls: string]>
> = {
  phase: {
    planned: ["Planned", "status status-idle"],
    in_progress: ["In progress", "status status-live"],
    in_review: ["In review", "status"],
    pending: ["Waiting on operator", "status status-pending"],
    blocked: ["Blocked", "status status-blocked"],
    done: ["Done", "status status-done"],
  },
  slice: {
    todo: ["To do", "status status-idle"],
    ready: ["Ready", "status status-ready"],
    in_progress: ["In progress", "status status-live"],
    in_review: ["In review", "status"],
    changes_requested: ["Changes requested", "status status-changes"],
    pending: ["Waiting on operator", "status status-pending"],
    blocked: ["Blocked", "status status-blocked"],
    done: ["Done", "status status-done"],
  },
  verdict: {
    pending: ["Not reviewed", "status status-idle"],
    pass: ["Pass", "status status-done"],
    changes_requested: ["Changes requested", "status status-changes"],
    blocked: ["Blocked", "status status-blocked"],
  },
  item: {
    open: ["Open", "status status-idle"],
    in_progress: ["In progress", "status status-live"],
    solved: ["Solved", "status status-done"],
    dropped: ["Dropped", "status status-revoked"],
  },
  entry: {
    open: ["Open", "status status-idle"],
    done: ["Done", "status status-done"],
    dismissed: ["Dismissed", "status status-revoked"],
  },
  pr: {
    draft: ["Draft", "status status-idle"],
    open: ["Open", "status"],
    merged: ["Merged", "status status-done"],
    closed: ["Closed", "status status-revoked"],
  },
  gate: {
    not_required: ["Not required", "status status-idle"],
    required: ["Required", "status status-idle"],
    open: ["Open", "status status-pending"],
    cleared: ["Cleared", "status status-done"],
  },
  doc: {
    current: ["Current", "status status-done"],
    stale: ["Stale", "status status-changes"],
    retired: ["Retired", "status status-revoked"],
  },
};

/** F38: a slice's kind, beside a title as the system's `.badge`, in a row or a table plain text in `--ink-2`. */
export const WS_KIND: Record<string, string> = {
  decomposition: "Decomposition",
  implementation: "Implementation",
  research: "Research",
  fix: "Fix",
  docs: "Docs",
  qa: "QA",
  "co-work": "Co-work",
  cycle: "Cycle",
  review: "Review",
};

/** F38: why a slice waits on the operator. */
export const WS_STOP: Record<string, string> = {
  wave: "Wave",
  mockup: "Mockup",
  decision: "Decision",
  "operator-action": "Operator action",
  limit: "Limit",
  other: "Other",
};

/** F38: a slice's risk. */
export const WS_RISK: Record<string, string> = {
  low: "Low",
  mid: "Mid",
  high: "High",
};

/** The three places, as the row of links reads them (F36, F41). */
export type WsPlace = "agenda" | "backlog" | "docs";

export const WS_PLACES: Record<WsPlace, string> = {
  agenda: "Agenda",
  backlog: "Backlog",
  docs: "Docs",
};

/** The Workspace head (`WsNav.dc.html`, F40, F41) and the sync line (`WsSync.dc.html`, F40). */
export const WS_HEAD = {
  /** The `h1` and the page title of each of the three places (F36). */
  title: "Workspace",
  /** The row of places' name. */
  nav: "Workspace",
  unlinked: {
    label: "No workspace linked",
    text: "No workspace linked yet. Run this in the project’s repo.",
    copy: "Copy the link command",
  },
  never: {
    label: "Not synced yet",
    text: "Nothing has synced yet. This workspace shows here after its first sync.",
  },
} as const;

export const WS_SYNC = {
  fresh: (ago: string) => `Synced ${ago}`,
  behind: (ago: string) => `Last synced ${ago}`,
  never: "Not synced yet",
  unlinked: "No workspace linked",
  /** Read before the version by a screen reader: `Workspace v97`. */
  versionLabel: "Workspace ",
  loading: "Loading…",
} as const;

/** A change that waits, and one the workspace refused (F45). */
export const WS_CHANGE = {
  waiting: "Waiting for sync",
  /** An item's page may say it once. */
  waitingText: "The workspace takes this change at its next sync.",
  /** In a list, a refused change's badge (the plain `.badge`); the notice is on the item's page. */
  refusedBadge: "Change refused",
  /** `The workspace did not take this change. <what it said>.` */
  refused: (said: string) => {
    const line = said.trim();
    return `The workspace did not take this change.${line ? ` ${/[.!?…]$/.test(line) ? line : `${line}.`}` : ""}`;
  },
  retry: "Try again",
  discard: "Discard",
  /** F45: a send that fails before it leaves the web. */
  addFailed: "Could not add the agenda. Try again.",
  saveFailed: "Could not save the agenda. Try again.",
  solveFailed: "Could not solve the agenda. Try again.",
  dropFailed: "Could not drop the agenda. Try again.",
  titleError: "Enter a title of 1–200 characters.",
} as const;

/** F36: the actions, each with its pending label (F303 adds Delete; Propose puts an Open agenda back). */
export const WS_ACTIONS = {
  addItem: "Add agenda",
  add: ["Add", "Adding…"],
  edit: "Edit",
  save: ["Save", "Saving…"],
  solve: ["Solve", "Solving…"],
  drop: ["Drop", "Dropping…"],
  reopen: ["Reopen", "Reopening…"],
  propose: ["Propose", "Proposing…"],
  delete: ["Delete", "Deleting…"],
  cancel: "Cancel",
  outcome: "Outcome (optional)",
  reason: "Reason (optional)",
  title: "Title",
  note: "Note (optional)",
} as const;

/** The kinds of item a Workspace page shows on its own (F49): its not-found title and sentence. */
export type WsItemKind = "phase" | "slice" | "doc" | "item";

const ITEM_NAMES: Record<WsItemKind, [title: string, thing: string]> = {
  phase: ["Phase", "phase"],
  slice: ["Slice", "slice"],
  doc: ["Doc", "doc"],
  item: ["Agenda", "agenda"],
};

/** Empty, loading, error and not found in the Workspace (F49); the error's own words are F5's. */
export const WS_STATES = {
  notFound: {
    title: (kind: WsItemKind) => `${ITEM_NAMES[kind][0]} not found`,
    text: (kind: WsItemKind, project: string) =>
      `This ${ITEM_NAMES[kind][1]} doesn’t exist, or it isn’t part of ${project}.`,
  },
  /** The item's own way back: `Back to Backlog`. */
  back: (destination: string) => `Back to ${destination}`,
  /** A part that failed keeps its head and says it, then Try again. */
  partFailed: {
    agenda: "The agenda did not load.",
    backlog: "The backlog did not load.",
    docs: "Docs did not load.",
  },
  retry: "Try again",
} as const;

/** The pager's names on the Workspace's paged list, and its rows a page (F300, F304). */
export const WS_PAGER = {
  archived: { label: "Archived phases, pages", per: 10, key: "archived" },
} as const;

/** F39: a phase's progress, `1/7`, and its sentence `1 of 7 slices done, 1 in progress`. */
export const WS_PROGRESS = {
  count: (done: number, total: number) => `${done}/${total}`,
  label: (done: number, total: number, live: boolean) =>
    `${done} of ${plural(total, "slice")} done${live ? ", 1 in progress" : ""}`,
} as const;

/**
 * F36 and F78: the heads, labels, groups and sentences the pages share. A page takes its words from here;
 * a word the record does not draw is never added.
 */
export const WS_GLOSSARY = {
  heads: {
    phases: "Phases",
    slices: "Slices",
    plan: "Plan",
    result: "Result",
    intent: "Intent",
    agendaItem: "Agenda",
    openAndInProgress: "Open and in progress",
    solvedAndDropped: "Solved and dropped",
    now: "Now",
    waiting: "Waiting on operator",
    notebook: "Notebook",
    review: "Review",
    gate: "Acceptance gate",
    explainedIn: "Explained in",
    text: "Text",
    retired: "Retired",
    earlierVersions: "Earlier versions",
    archivedPhases: "Archived phases",
    commits: "Commits",
  },
  labels: {
    pointer: {
      phase: "Phase",
      slice: "Slice",
      next: "Next",
      waiting: "Waiting on operator",
      none: "None",
    },
    backlogColumns: ["Phase", "Status", "Review", "Slices"],
    item: {
      outcome: "Outcome",
      reason: "Reason",
      note: "Note",
      created: "Created",
      changed: "Changed",
    },
    phase: {
      created: "Created",
      started: "Started",
      completed: "Completed",
      branch: (repo: string) => `Branch in ${repo}`,
      pullRequest: (n: number) => `Pull request #${n}`,
      pullRequestName: (n: number, repo: string, state: string) =>
        `Pull request #${n} in ${repo} on GitHub, ${state}`,
      noPullRequest: "Pull request not opened",
    },
    slice: {
      risk: "Risk",
      dependsOn: "Depends on",
      started: "Started",
      completed: "Completed",
      stop: "Stop",
      since: "Since",
    },
    doc: { version: "Version", versioned: "Versioned", from: "From" },
    verdict: {
      returned: "Returned",
      route: "Route",
      model: "Model",
      effort: "Effort",
      filesChanged: "Files changed",
      summary: "Summary",
      validation: "Validation",
      deviations: "Deviations",
      docImpact: "Doc impact",
    },
  },
  groups: {
    notebook: [
      "Now",
      "Operator questions",
      "Decisions",
      "Doc impact",
      "Notes for later slices",
      "Topics",
    ],
    intent: { original: "Original words", confirmed: "Confirmed intent" },
    walkthrough: "Walkthrough",
  },
  question: { open: "Open", resolved: "Resolved" },
  /** A value that does not apply, or a date that has not happened (F42). */
  none: "—",
  sentences: {
    noPhase: "No phase yet. Run this in the project’s repo to plan one.",
    cleared: (date: string) => `Cleared on ${date}.`,
    decisionAsked: (date: string) => `Decision asked ${date}`,
    everyPhaseDone: "Every linked phase is done.",
    gateWords: "“accept” clears the gate and closes the phase.",
    earlierVersion: "Earlier version",
  },
  buttons: {
    showAll: (n: number) => `Show all ${n}`,
    showAllDecisions: (n: number) => `Show all ${n} decisions`,
    showFirst: "Show the first 5",
    previous: "Previous",
    next: "Next",
  },
} as const;
