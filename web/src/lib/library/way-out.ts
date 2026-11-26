/**
 * A reader's way out of an item (P75): where the wordmark and the way back lead when the org's public library
 * does not read for them.
 *
 * A signed-out reader's way out of a document, a book or a chapter is the org's public library (`/@{org}`), or
 * its project's page there. A reader who came by a share link (`/s/<token>`) to an org with nothing Public finds
 * those "Library not found": the org's library lists only Public items, and a Link item is listed nowhere. For
 * that reader the way out is the sikstack home (`/`, the landing), which always reads, named `sikstack`. A
 * member's way out (the Library) and a reader whose org library lists something are as before.
 *
 * `orgLibrary` says whether the org's public library reads for this reader; the server finds it out
 * (`./way-out-read`) and the reader's segment carries it to the client (`ReaderSegmentValue.orgLibrary`). It
 * defaults to true, so a caller that does not know keeps the old links. Pure, and not `server-only`.
 */
import { SITE } from "@/content/site";
import { LIBRARY_HREF, publicLibraryHref } from "@/lib/reader-href";

/** The sikstack home: the landing for a signed-out reader. */
export const SIKSTACK_HOME = "/";

/** The way back that always reads, for a reader the org's public library refuses. */
export const HOME_WAY_BACK = { href: SIKSTACK_HOME, label: SITE.name } as const;

/**
 * Where the wordmark goes: a member's Library; a visitor's org public library while it reads for them, else the
 * sikstack home; the Library when there is no org to name (as before).
 */
export function readerHomeHref(p: {
  member: boolean;
  org: string | null | undefined;
  orgLibrary?: boolean;
}): string {
  if (p.member || !p.org) return LIBRARY_HREF;
  return p.orgLibrary === false ? SIKSTACK_HOME : publicLibraryHref(p.org);
}

/**
 * A visitor's way back, kept while the org's public library reads for them. A visitor's way back is always one
 * of the org's public pages (its library, or a project's page there), so when that library does not read, the
 * way back is the sikstack home. A member's, and no way back at all, are kept.
 */
export function reachableWayBack<T extends { href: string; label: string }>(
  back: T | null,
  p: { member: boolean; orgLibrary?: boolean },
): T | typeof HOME_WAY_BACK | null {
  if (back === null || p.member || p.orgLibrary !== false) return back;
  return HOME_WAY_BACK;
}

/** The org an address's first segment names (`@{org}`, URL-encoded or not), without its `@`; null for no `@`. */
export function addressOrg(segment: string): string | null {
  let at = segment;
  try {
    at = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return at.startsWith("@") && at.length > 1 ? at.slice(1) : null;
}
