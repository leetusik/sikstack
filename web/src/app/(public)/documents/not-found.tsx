import type { Metadata } from "next";

import { READER_DOCUMENT } from "@/content/reader-document";
import { DocumentMissing } from "@/sikstack/reader/document";

import { DocumentSegment } from "./[id]/segment";

/**
 * Document not found for the misses `[id]/layout.tsx` refuses with a real HTTP 404 (P78, F13): the same block
 * and frame as the page's own (`[id]/not-found.tsx`), in the segment that layout would have given it.
 */
export const metadata: Metadata = { title: READER_DOCUMENT.notFound.title };

export default function DocumentsNotFound() {
  return (
    <DocumentSegment>
      <DocumentMissing />
    </DocumentSegment>
  );
}
