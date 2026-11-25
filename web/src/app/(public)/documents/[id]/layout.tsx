import { notFound, redirect, unstable_rethrow } from "next/navigation";

import { optionalIdentity } from "@/lib/auth-guards";
import { ApiError } from "@/lib/knowledge/client";
import { loginHref } from "@/lib/next-path";

import { documentIdOf, getDocumentOnce } from "./read";
import { DocumentSegment } from "./segment";

/**
 * The document's segment (`./segment.tsx`: who reads, the nonce, the reader's settings), and (P78, F13) its
 * misses as a real HTTP 404, decided here above the page's `loading.tsx`, before anything streams: an id no
 * document can have (`/documents/abc`), refused before any read, and for a member a document the API does not
 * give them (404 or 400: missing, or another org's private one; ids cannot be probed), by the page's own
 * `cache`d read. Both land on `../not-found.tsx`, Document not found in the bar's frame. A visitor's miss (no
 * document, or a private one: the two read alike) is sent to sign in with the way back (P30.S11), here as a real
 * redirect rather than the page's streamed one; a fault is the page's to draw.
 */
export default async function DocumentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const id = documentIdOf((await params).id);
  if (id === null) notFound();
  let miss: "member" | "visitor" | null = null;
  try {
    const ctx = await optionalIdentity();
    try {
      await getDocumentOnce(ctx?.token, id);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 400)
      )
        miss = ctx ? "member" : "visitor";
      else throw error;
    }
  } catch (error) {
    unstable_rethrow(error);
  }
  if (miss === "member") notFound();
  if (miss === "visitor") redirect(loginHref(`/documents/${id}`));
  return <DocumentSegment>{children}</DocumentSegment>;
}
