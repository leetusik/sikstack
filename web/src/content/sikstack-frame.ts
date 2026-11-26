// The words of the frame's shared components (src/sikstack/frame/): Keys, Trend, Copy, Dialog and the
// usage read-out, verbatim from the signed foundations round (job 01, round 03: `Keys.dc.html`,
// `Trend.dc.html`, `Copy.dc.html`, `Dialog.dc.html`, `ProjectHome.dc.html`'s read-out, frame.md F1,
// F3, F4, F17, F21) and the landing's command block (job 06, `LandingCode.dc.html`, F258). Imported by
// its own path, never through `content/index.ts`.

export type KeysScope = "org" | "project";

export const KEYS = {
  heading: { org: "Org API keys", project: "API keys" },
  newKey: "New key",
  /** The form's reach line, with the org's or the project's name. */
  reach: {
    org: (subject: string) =>
      `A key made here reaches every project in ${subject}.`,
    project: (subject: string) => `A key made here reaches ${subject} only.`,
  },
  nameLabel: "Key name",
  nameHint: "Optional",
  namePlaceholder: { org: "e.g. CI ingest", project: "e.g. Production ingest" },
  /** frame.md F4: a name over 200 characters. */
  nameError: "Key names must be 200 characters or fewer.",
  accessLegend: "Access",
  accessFull: "Full access",
  accessCapture: "Capture only",
  accessHint: "A capture-only key can send feedback and nothing else.",
  /** The project form's third option and its hint (the operator's words, 2026-11-17). */
  accessWorkspace: "Workspace sync",
  accessWorkspaceHint:
    "A workspace key links one checkout of this project's workspace and reaches nothing else.",
  /** The keys table's Access cell, by scope. */
  accessWord: {
    full: "Full access",
    capture: "Capture only",
    workspace: "Workspace",
  },
  cancel: "Cancel",
  create: "Create key",
  creating: "Creating…",
  createFailed: "Could not create the key. Try again.",
  columns: {
    name: "Name",
    key: "Key",
    access: "Access",
    status: "Status",
    created: "Created",
    lastUsed: "Last used",
    action: "Action",
  },
  unnamed: "Unnamed key",
  status: { active: "Active", idle: "Idle", revoked: "Revoked" },
  revoke: "Revoke",
  revokeLabel: (label: string) => `Revoke key ${label}`,
  empty: {
    org: "No org keys yet. Create one to send documents and feedback to this org.",
    project:
      "No keys yet. Create one to send documents and feedback to this project.",
  },
  shownTitle: "Copy your new key now",
  shownText:
    "This is the only time this key is shown. If you lose it, revoke it and create a new one.",
  copyKey: "Copy key",
  done: "Done",
  confirmTitle: (label: string) => `Revoke “${label}”?`,
  confirmText:
    "Requests that use this key stop working at once. You cannot undo this.",
  confirmYes: "Yes, revoke",
  revoking: "Revoking…",
  /** A failed revoke (operator, 2026-11-16): F4's form, as `createFailed`; no board draws it. */
  revokeFailed: "Could not revoke the key. Try again.",
  loading: "Loading…",
} as const;

export const TREND = {
  heading: "Searches, last 30 days",
  caption: (total: string, peak: string) =>
    `${total} total, peak ${peak} a day`,
  summary: (first: string, last: string, total: string, peak: string) =>
    `Searches a day from ${first} to ${last}: ${total} in total, at most ${peak} in a day`,
  tip: (day: string, count: string) => `${day}: ${count}`,
  empty: "No searches in the last 30 days.",
  loading: "Loading the search trend",
} as const;

export const COPY = {
  copy: "Copy",
  copied: "Copied",
  failed: "Copy failed. Select the text and copy it by hand.",
} as const;

export const USAGE = {
  window: "Usage, last 30 days",
  stock: "Documents",
  docs30: "Documents created",
  searches30: "Searches",
  deleted30: "Deleted",
  docs: "Active total",
} as const;
