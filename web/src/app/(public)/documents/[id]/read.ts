import { cache } from "react";

import { getDocument } from "@/lib/knowledge/app";
import type { KbDocument } from "@/lib/knowledge/types";

/**
 * The document's one read a request (React `cache`), shared by the layout's miss check (P78, F13), the page and
 * its title: the knowledge client is `cache: "no-store"`, so without this each would read again.
 */
export const getDocumentOnce = cache(
  (token: string | undefined, id: number): Promise<KbDocument> =>
    getDocument(token, id),
);

/** The address's id, when it is one a document can have (a positive integer), else `null`. */
export function documentIdOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 ? id : null;
}
