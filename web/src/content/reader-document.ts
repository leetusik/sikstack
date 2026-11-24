// The words of a loose document in the Library's reader (src/sikstack/reader/document/): its head's fact, the
// sections' fold, the Notes sheet's body (DocumentNotes: bookmarks only) and its loading and not found
// screens. Verbatim from the signed boards of Library round 02 (job 03: `Document.dc.html`,
// `DocumentNotes.dc.html`; `## Build` § Page: document). The frame's own words (the head's facts, the end,
// the foot, the sheets) are `@/content/reader-frame`; a mark's row's are `@/content/library-frame`. Imported
// by its own path, never through `content/index.ts`.

const count = (n: number) => n.toLocaleString("en-US");

export const READER_DOCUMENT = {
  /** The head's first fact and the bar's meta: `Document in platform`. */
  where: (project: string) => `Document in ${project}`,

  /** The sections' fold (F68's fold, FG8): more than six sections list five, then this control. */
  fold: {
    showAll: (n: number) => `Show all ${count(n)} sections`,
    showFewer: "Show fewer",
  },

  /** The Notes sheet's body (`DocumentNotes`): a loose document takes bookmarks only. */
  notes: {
    count: (n: number) => `${count(n)} ${n === 1 ? "bookmark" : "bookmarks"}`,
    section: "Bookmark this section",
    position: "Bookmark this position",
    here: "Bookmarked here",
    /** The empty line names the button's own words. */
    empty: (action: string) =>
      `No bookmarks in this document yet. ${action} keeps your place.`,
    /** A position's place in its row. */
    place: (pct: number) => `About ${pct}% through`,
  },

  /**
   * The way back to the phases the document was explained from (`DocumentPhases`, a member's only): the
   * heading, then one row a phase, its name over its id and role. Unsigned: it mirrors the phase page's
   * signed **Explained in** (P61-e9, taken as drawn).
   */
  phases: {
    heading: "Explained from",
    role: { explain: "Explain phase", source: "Source phase" },
    /** The line under a phase's name: `P48-q4 · Explain phase`. */
    sub: (id: string, role: string) => `${id} · ${role}`,
  },

  /** The way back's word at the end and on Not found: `Back to Library`, `Back to Personal`. */
  backTo: (name: string) => `Back to ${name}`,

  loading: "Loading…",

  notFound: {
    title: "Document not found",
    member: "This document doesn’t exist, or it isn’t part of your org.",
    visitor:
      "This link doesn’t point at a shared document. It may have moved, been unshared, or never existed.",
    signIn: "Sign in",
  },
} as const;
