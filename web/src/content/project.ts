// Project-detail copy (P12.S4) — the per-project drill-down: project info, this
// project's usage, its ingest credentials, and the mint/revoke flows. Copy-as-data
// per the S1 convention: the page never hardcodes strings inline.
//
// As in `auth.ts` / `dashboard.ts`, form error copy is keyed by HTTP STATUS, never
// by knowledge's `detail` text — the text is a server-side implementation detail
// that may change wording at any time.

import type { CredentialStatus } from "@/lib/knowledge/credential-status";

/**
 * Status-keyed mint-credential error copy.
 *
 * NOTE knowledge answers a too-long name as a **422** (FastAPI body validation),
 * not vocky's 400 — the action maps both to `invalidName`.
 */
export const MINT_CREDENTIAL_ERRORS = {
  /** Client-side zod rejection, or knowledge's own 400/422 (name >200 chars). */
  invalidName: "Key names must be 200 characters or fewer.",
  /** 401 — the session died mid-request; the next navigation bounces to /login. */
  sessionExpired: "Your session has expired. Sign in again to continue.",
  /** 404 — the project vanished (or was never ours) between render and submit. */
  notFound: "This project no longer exists.",
  /** 5xx / network / anything else. */
  generic: "Could not create the key. Please try again.",
} as const;

/** Status-keyed revoke-credential error copy. */
export const REVOKE_CREDENTIAL_ERRORS = {
  /** A tampered/garbled hidden input — the ids are not user-facing fields. */
  invalidRequest: "Could not revoke that key. Reload the page and try again.",
  sessionExpired: "Your session has expired. Sign in again to continue.",
  /** 404 — the key or project is gone (or is another tenant's). */
  notFound: "That key no longer exists.",
  generic: "Could not revoke the key. Please try again.",
} as const;

/** Status-keyed set-visibility error copy (P19) — the project's public/private toggle. */
export const SET_VISIBILITY_ERRORS = {
  /** A tampered hidden input, or knowledge's 400/422 on a bad value. */
  invalidRequest: "Could not update visibility. Reload the page and try again.",
  sessionExpired: "Your session has expired. Sign in again to continue.",
  /** 404 — the project vanished (or was never ours) between render and submit. */
  notFound: "This project no longer exists.",
  generic: "Could not update visibility. Please try again.",
} as const;

export const PROJECT = {
  /** Document <title> (the SITE template appends " · knowledge"). STATIC — the
   * knowledge client is `cache: "no-store"`, so a `generateMetadata` title would
   * cost a second uncached round-trip for a cosmetic gain. */
  title: "Project",

  header: {
    /**
     * Mono eyebrow suffix above the title, rendered as `{tenant} · {eyebrow}` —
     * the same shape as every other console page. Round 03 §4.4 requires the REAL
     * org name first (on a phone the eyebrow is the only place the org appears),
     * so the literal "Org · " prefix this string used to carry is now the tenant.
     */
    eyebrow: "Project",
    /** Prefix for the created-date sub-line, rendered as `{prefix} {date}`. */
    createdPrefix: "Created",
  },

  /**
   * Per-project visibility (P19) — the header Public/Private badge + the toggle
   * button beside it. `badge` labels the current state (`active`=Public / `idle`=
   * Private via the closed Badge enum); `toggle` labels the ACTION (the inverse of
   * the current state); `hint` is a one-line explanation under the toggle.
   */
  visibility: {
    badge: {
      public: "Public",
      private: "Private",
    },
    toggle: {
      /** Shown when the project is private — the button makes it public. */
      makePublic: "Make public",
      /** Shown when the project is public — the button makes it private. */
      makePrivate: "Make private",
      pendingLabel: "Saving…",
    },
    /** Explains what public visibility means, once, beside the toggle. */
    hint: {
      public: "Anyone with the link can read this project's documents.",
      private: "Only your org can read this project's documents.",
    },
  },

  usage: {
    /** The four stat-tile eyebrows, in render order. No deltas (operator decision). */
    tiles: {
      documentsCreated: "Documents created",
      searches: "Searches",
      deleted: "Deleted",
      activeTotal: "Active total",
    },
  },

  trend: {
    heading: "Searches · last 30 days",
    /** Mono caption beside the heading: `{total} total · peak {peak}/day`. */
    caption: (total: number, peak: number): string =>
      `${total.toLocaleString("en-US")} total · peak ${peak.toLocaleString(
        "en-US",
      )}/day`,
    /** Accessible name + sr-only summary prefix for the chart. */
    ariaLabel: "Search volume over the last 30 days",
    /** Shown in place of the chart when there is no series. */
    empty: "No search activity in this window yet.",
  },

  credentials: {
    heading: "API keys",
    /** Explains what the keys are for, once, above the table. */
    lead: "Use a key's value as the API credential your service sends to knowledge.",
    columns: {
      name: "Name",
      key: "Key",
      status: "Status",
      created: "Created",
      lastUsed: "Last used",
      /** Header for the trailing actions column (visually empty, sr-only text). */
      actions: "Actions",
    },
    /** Overrides `DataTable`'s built-in default, which bypasses copy-as-data. */
    empty: "No keys yet. Create one to start ingesting documents.",
    /** `name === null` — the key was minted without a label. */
    unnamed: "Unnamed key",
    /** The Badge beside a `capture`-scope key's name (a `full` key shows none). */
    captureBadge: "Capture only",
    /** `last_used_at === null` — the key has never been used to ingest. */
    never: "Never",
    /** The three derived states (`credential-status.ts`), keyed for the Badge label. */
    status: {
      active: "Active",
      idle: "Idle",
      revoked: "Revoked",
    } satisfies Record<CredentialStatus, string>,
  },

  mint: {
    /** The disclosure trigger in the panel head (a plus icon precedes it). */
    newKeyLabel: "New key",
    nameLabel: "Key name",
    /** Optional: knowledge defaults an omitted/blank name to `null`. */
    nameHint: "Optional — a label to tell your keys apart.",
    namePlaceholder: "e.g. Production ingest",
    /** The scope choice (a radio pair; `full` is checked by default). */
    scopeLegend: "Access",
    scopeFull: "Full access",
    scopeCapture: "Capture only",
    scopeHint: "A capture-only key can send feedback and nothing else.",
    submitLabel: "Create key",
    submitPendingLabel: "Creating…",
    cancelLabel: "Cancel",
  },

  /**
   * The show-once reveal modal. knowledge returns the plaintext `vk_` key EXACTLY
   * ONCE and stores only its hash — there is no "reveal again". The copy carries
   * that weight, because a dismissed modal is a lost key.
   */
  keyPanel: {
    heading: "Copy your new key now",
    warning:
      "This is the only time this key will ever be shown. It cannot be recovered — if you lose it, revoke it and create a new one.",
    /** Accessible name for the key value itself. */
    keyLabel: "New API key",
    copyLabel: "Copy",
    copiedLabel: "Copied",
    copyFailedLabel: "Copy failed — select the key and copy it manually.",
    dismissLabel: "Dismiss",
  },

  revoke: {
    label: "Revoke",
    /** Shown in place of the button once the confirm step is armed. */
    confirmPrompt: "Revoke?",
    confirmLabel: "Yes, revoke",
    cancelLabel: "Cancel",
    pendingLabel: "Revoking…",
    /** Accessible name for the per-row action (the label alone is ambiguous). */
    ariaLabelPrefix: "Revoke key",
  },

  /** The page frame's link to this project's feedback. */
  feedbackLink: "Feedback",

  /** The branded not-found (`not-found.tsx`), on the `.kb-empty` empty-state classes. */
  notFound: {
    title: "Project not found",
    sub: "This project doesn't exist, or it isn't part of your org.",
    backLabel: "Back to dashboard",
  },
} as const;

export type ProjectCopy = typeof PROJECT;

/**
 * P58 — project home's words (job 01, round 03-instrument, `ProjectHome*.dc.html`), verbatim.
 * Imported by path (`@/content/project`), never through the barrel. The older `PROJECT` above stays
 * for its other readers; nothing here renames or removes one of its keys.
 *
 * The Workspace panel, once the project's workspace has synced: `Workspace`, the agenda's count, the
 * phases and `See all in Workspace`. Not linked (or never synced), its signed two sentences: `empty`,
 * then `run.before`, the link command (`run.command`, read as code) and `run.after`. The command is
 * the operator's signed words, filled with the page's origin and the project's id.
 */
export const PROJECT_HOME = {
  head: {
    back: (org: string): string => `Back to ${org}`,
    /**
     * P75: a project's visibility is only the default its NEW documents and books start at; each item keeps its
     * own sharing (Members, Anyone with the link, Public), set from the reader.
     */
    badge: { public: "New items public", private: "New items members only" },
    created: (when: string): string => `Created ${when}`,
    makePublic: "Make public",
    makePrivate: "Make private",
    saving: "Saving…",
    failed: "Could not update visibility. Try again.",
    defaultNote:
      "Sets only what new documents and books start as. Each one keeps its own sharing, changed from the reader.",
    toast: {
      public: (name: string): string =>
        `New documents and books in ${name} now start public. Existing ones keep their sharing.`,
      private: (name: string, org: string): string =>
        `New documents and books in ${name} now start for ${org} members only. Existing ones keep their sharing.`,
    },
  },
  workspace: {
    heading: "Workspace",
    /**
     * The head's count, a link to the Agenda: the Open and In progress items, then the Proposed ones
     * apart (`4 open · 1 proposed`), in the signed panel's place for its count.
     */
    agenda: (open: string, proposed: string): string =>
      `${open} open · ${proposed} proposed`,
    all: "See all in Workspace",
    /** P78, F16: a synced workspace with no open or proposed item and no phase, in one line. */
    nothing: "Nothing open on the agenda, and no phases yet.",
    empty: "No workspace linked yet.",
    run: {
      before: "Run ",
      after: " in the project’s repo.",
      command: (origin: string, projectId: string): string =>
        `sikstack link ${origin}/projects/${projectId}`,
    },
  },
  library: {
    heading: "Library",
    one: "document",
    book: "Book",
    chapter: "chapter",
    /** A document's reading time, as the board draws it (`6 min`). */
    minutes: (n: number): string => `${n} min`,
    all: "See all in Library",
    empty:
      "No documents yet. An agent publishes them with one of this project’s API keys.",
    failed: "Documents did not load.",
    retry: "Try again",
  },
  feedback: {
    heading: "Feedback",
    /** The head's count over the viewer's month (`23 this month`); the board has one form for every number. */
    month: (count: string): string => `${count} this month`,
    all: "See all in Feedback",
    empty:
      "No feedback yet. Your users’ messages arrive through a Capture only key.",
    /** The Library's failed form, in the Feedback job's words (D247-4x). */
    failed: "Feedback did not load.",
    retry: "Try again",
  },
  notFound: {
    title: "Project not found",
    text: (org: string): string =>
      `This project doesn’t exist, or it isn’t part of ${org}.`,
    back: (org: string): string => `Back to ${org}`,
  },
  loading: "Loading…",
} as const;
