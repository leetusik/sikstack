// The words of the Library's lists (job 03, Library round 02): the library page (`Library.dc.html`),
// Continue reading (`LibraryContinue.dc.html`), a project's section (`Shelf.dc.html`) and the documents
// table (`LibraryDocs.dc.html`, with F69's delete dialog as `Library.dc.html` draws it); frame.md F54,
// F320 to F323, F328. Verbatim from the signed boards. Imported by its own path, never through
// `content/index.ts`.

const num = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`): string =>
  `${num(n)} ${n === 1 ? one : many}`;

export const LIBRARY_PAGE = {
  /** The page's `h1` and its tab title (the SITE template adds the suffix). */
  title: "Library",
  publicLibrary: "Public library",
  /** The views' section, and the failed and nothing-to-read panels. */
  views: "Books and documents",
  view: {
    label: "View",
    project: "By project",
    all: "All documents",
  },
  /** `3 books, 240 documents`, `58 documents`, `1 book`, `0 documents` (`LB.countLine`). */
  countLine: (books: number, docs: number): string =>
    [
      books ? plural(books, "book") : "",
      docs || !books ? plural(docs, "document") : "",
    ]
      .filter(Boolean)
      .join(", "),
  /** All documents' count: `240 documents`; searched `14 of 240 documents`. */
  docsCount: (total: number, matched: number | null): string =>
    matched === null
      ? plural(total, "document")
      : `${num(matched)} of ${plural(total, "document")}`,
  emptyProjects: (n: number): string =>
    n === 1
      ? "1 project has nothing to read yet."
      : `${num(n)} projects have nothing to read yet.`,
  nothing:
    "No books or documents yet. They appear here when your agents write them.",
  failed: "The library did not load.",
  retry: "Try again",
  loading: "Loading…",
  deleted: "Document deleted.",
} as const;

export const CONTINUE = {
  heading: "Continue reading",
  also: "Also in progress",
  chapterOf: (n: number, total: number): string => `Chapter ${n} of ${total}`,
  document: "Document",
  /** `Left off at Deduplication, 68%` is `leftOffAt` + the section + `sectionPct`. */
  leftOffAt: "Left off at ",
  sectionPct: (pct: number): string => `, ${pct}%`,
  leftOffPct: (pct: number): string => `Left off at ${pct}%`,
  finished: (n: number): string => `You finished chapter ${n}`,
  go: "Continue reading",
  goNext: "Read next",
  loading: "Loading…",
} as const;

export const SHELF = {
  public: "Public",
  private: "Private",
  books: (name: string): string => `Books in ${name}`,
  documents: (name: string): string => `Documents in ${name}`,
  /** The foot link to the project's page (F321). */
  more: (docs: number, name: string): string =>
    docs > 1
      ? `All ${num(docs)} documents`
      : docs === 1
        ? "The one document"
        : `Open ${name}`,
  chapters: (n: number): string => plural(n, "chapter"),
  originalLayout: "Original layout",
  /** A reading state's word (frame.md F54). */
  state: {
    notStarted: "Not started",
    started: "Started",
    startedPct: (pct: number): string => `Started, ${pct}%`,
    finished: "Finished",
    ofBook: (done: number, total: number): string =>
      `${done} of ${total} finished`,
  },
} as const;

export const DOCS = {
  heading: "Documents",
  searchLabel: "Search documents",
  placeholder: "Search titles, tags and text",
  project: "Project",
  allProjects: "All projects",
  search: "Search",
  reset: "Reset",
  tags: "Tags",
  /** The tags past the third: `+2` on the last one shown, and its spoken form. */
  more: (n: number): string => `⁠+${n}`,
  moreLabel: (rest: string[]): string =>
    `, and ${rest.length} more: ${rest.join(", ")}`,
  delete: "Delete",
  deleteLabel: (title: string): string => `Delete document ${title}`,
  deleteFailed: "Could not delete this document. Try again.",
  loading: "Loading…",
  empty: "No documents yet. They appear here when your agents write them.",
  none: (q: string, scope: string | null): string =>
    `No document${scope ? ` of ${scope}` : ""} contains “${q}”.`,
  failed: "Documents did not load.",
  retry: "Try again",
  pagesLabel: "Pages of documents",
  /** F69's dialog (`Library.dc.html`). The title is `Delete “<title>”?`. */
  dialog: {
    before: "Delete “",
    after: "”?",
    title: (title: string): string => `Delete “${title}”?`,
    text: "It is removed from the library and from search, and links to it stop working. You cannot undo this.",
    cancel: "Cancel",
    confirm: "Yes, delete",
    deleting: "Deleting…",
  },
} as const;
