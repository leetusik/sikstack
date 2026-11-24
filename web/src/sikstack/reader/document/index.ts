// The reader on a loose document (P63-fk.S12; job 03, Library round 02: `## Build` § Page: document): the frame
// (`DocumentReader`), the Notes sheet's body on a Markdown document (`DocumentNotes`, `DocumentBookmarks`), its
// loading, not found and error screens, and their rules (`./model`). The text is `ChapterBody`
// (`@/sikstack/reader/body/body`, imported by its path). Words: `@/content/reader-document`; the sheet is
// `styles/library/document.css` (the page adds no class of its own: the frame's and `reader.css`'s).
export { DocumentReader, type DocumentReaderProps } from "./document-reader";
// The way back to the phases a document was explained from (P61-e9). The page's read and its hand-over to the
// reader (`documentPhaseRows`, `withDocumentPhases`) are server-only: import them from `./with-phases`.
export { DocumentPhases } from "./document-phases";
export {
  DocumentBookmarks,
  DocumentNotes,
  runBookmarkWire,
  type DocumentNotesProps,
} from "./document-notes";
export {
  DocumentFailed,
  DocumentLoading,
  DocumentMissing,
  missingDocument,
} from "./document-states";
export * from "./model";
// An html document's Original layout (P63-fk.S13): the same frame around the html as it renders today.
export {
  DocumentOriginal,
  OriginalBookmarks,
  type DocumentOriginalProps,
} from "./original";
export * from "./original-parts";
