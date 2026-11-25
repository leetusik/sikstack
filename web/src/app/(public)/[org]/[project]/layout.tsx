import { headers } from "next/headers";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import type { ReactNode } from "react";

import { optionalIdentity } from "@/lib/auth-guards";
import { readProjectPlace } from "@/lib/library/list-place";
import { REQUEST_PATH_HEADER } from "@/lib/next-path";
import {
  exactProjectSearch,
  loadPublicProjectOnce,
  projectAt,
  type ProjectParams,
} from "@/lib/project-library/load";
import { projectLibraryHref } from "@/lib/reader-href";

/**
 * A member of the org at a public project's address, `/@{org}/{project}`, is sent to the project's library
 * in the Shell, `/projects/{id}/library`, with the place (`?page`, `?q`) kept (P63, OQ7, OQ27): a 307
 * decided here, above the page's `loading.tsx`, so it answers before any byte of the visitor's frame.
 *
 * It decides only on the exact `/@org/project` address (the request's path, `REQUEST_PATH_HEADER`): every
 * nested page (a book, a chapter, notes, a document) passes straight through with no read. On the exact
 * address its reads are the page's own (`projectAt`, then `optionalIdentity` and `loadPublicProjectOnce`,
 * each `cache`d). A fault renders the page, which draws it; a member's answer redirects.
 *
 * P78, F13: the misses answer a real HTTP 404, decided here before anything streams. An address with no `@`
 * (`/sikstack/sikstack`, at any depth) is no public address at all, refused before any read; on the exact
 * address, a project this reader cannot see (private, unknown, an unknown org) is refused by the same read. Both
 * land on `../not-found.tsx` (Page not found, or Project not found in the bar's frame). The page keeps its own
 * redirect and miss for a client navigation that reuses this layout (a book of the project back to its library).
 */
export default async function PublicProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<ProjectParams>;
}) {
  const at = projectAt(await params);
  if (!at) notFound();
  const search = exactProjectSearch((await headers()).get(REQUEST_PATH_HEADER));
  if (search) {
    let target: string | null = null;
    let missing = false;
    try {
      const ctx = await optionalIdentity();
      const read = await loadPublicProjectOnce(ctx?.token, at.org, at.project);
      if (!read) missing = true;
      else if (ctx && read.memberId)
        target = projectLibraryHref(read.memberId, readProjectPlace(search));
    } catch (error) {
      // A fault is the page's to draw (its error boundary sits inside this layout); a redirect of
      // `optionalIdentity`'s own (a stale org cookie) goes on.
      unstable_rethrow(error);
    }
    if (missing) notFound();
    if (target) redirect(target);
  }
  return children;
}
