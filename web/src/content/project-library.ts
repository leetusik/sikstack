// The words of a project's library page (job 03, Library round 02, `ProjectLibrary.dc.html`; `## Build`
// § Page: project-library; frame.md F321, F328). Verbatim from the signed board. The list parts' own
// words (Continue reading, the documents table, a book row's facts) are `@/content/library-page`'s.
// Imported by its own path, never through `content/index.ts`.

export const PROJECT_LIBRARY = {
  /** A member's way back, to the org's library (project-library:Q1, drawn **Library**). */
  back: "Library",
  public: "Public",
  private: "Private",
  /** The books' section head and its list's name. */
  books: "Books",
  /** The Nothing to read panel's name. */
  views: "Books and documents",
  /** Nothing to read: two sentences, each a line of its own (F328). A visitor's is the first alone. */
  nothing: {
    member: (name: string): string => `No books or documents in ${name} yet.`,
    how: "They appear here when your agents write them.",
    visitor: (name: string): string => `Nothing to read in ${name} yet.`,
  },
  notFound: {
    title: "Project not found",
    member: (org: string): string =>
      `This project doesn’t exist, or it isn’t part of ${org}.`,
    visitor:
      "This link doesn’t point at a public project. It may have moved, been made private, or never existed.",
    signIn: "Sign in",
  },
  /** Not found's and Error's way out, a member's: the org's library. */
  backToLibrary: "Back to Library",
} as const;
