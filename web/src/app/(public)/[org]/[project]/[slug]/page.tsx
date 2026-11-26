import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import {
  documentListen,
  firstOf,
  missTitle,
  renderDocument,
} from "@/components/reader/document-page";
import { READER_DOCUMENT } from "@/content/reader-document";
import { requestNonce } from "@/sikstack/shell/data";
import {
  documentPhaseRows,
  withDocumentPhases,
  withDocumentShare,
} from "@/sikstack/reader/document/with-phases";
import { optionalIdentity } from "@/lib/auth-guards";
import { resolveDocument } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import type { KbDocument } from "@/lib/knowledge/types";
import { FROM_PARAM } from "@/lib/library/from";
import { parseReaderCookie, READER_COOKIE } from "@/lib/reader-cookie";
import { chapterRedirectHref } from "@/lib/reader-href";
import { loadLooseReader, type ReaderLoad } from "@/lib/reader/load";
import { viewerTimeZone } from "@/lib/time-zone";

// P25.S3 — the PRETTY public document URL, `/@{org}/{project}/{doc-slug}`. Same page
// as `(public)/documents/[id]`, addressed by DURABLE parts instead of the disposable
// `documents.id` rowid: the org slug lives in the Postgres accounts plane and the
// project + doc slug are `rel_path`'s own components, so a shared link survives a full
// content reindex. Nothing here re-derives that URL — the backend hands it back as
// `canonical_path`, and this route only consumes it.
//
// ROUTE PRECEDENCE (phase.md Q1, verified empirically against the built
// `routes-manifest.json`): this is the catch-all for EVERY unmatched three-segment
// URL. Next compiles each route to a full-path regex and matches static routes before
// dynamic ones, so `/documents/{id}/versions/{v}` and `/api/documents/{id}/versions/{v}/raw`
// keep winning — but `/anything/at/all` lands here. That is why the `@` guard below is
// load-bearing rather than cosmetic: without it this page would happily fetch upstream
// for arbitrary junk paths.
//
// Branching mirrors the id page (`optionalIdentity()`): a signed-in member reads with
// their bearer, an anonymous visitor TOKENLESS. Both map a miss to the co-located
// branded not-found. The anonymous branch deliberately does NOT bounce to /login the
// way the id page does: the resolver's 404 already collapses private/unknown/malformed
// into one indistinguishable answer, so a login bounce would leak nothing and only add
// friction on a share surface.
//
// P30.S13 — a native or md document opens in the READER here too (the loose-document
// variant, `01-reader`); `?v=N` reads an older version. P30.S25 — an html explainer (or
// an html version) opens in the LEGACY READER (`09-legacy-and-print`), with no app shell.
//
// P63-fk.S12 — a native or md document reads in the Library's reader (`@/sikstack/reader/document`, job 03
// Library round 02, § Page: document; `renderDocument`): the way back by `?from=` (F328), an earlier version
// at `?v=n` (one that does not exist is Document not found), Version history, the marks by format (OQ14).
// Library round 02 drew no Listen on a document (job 07 draws it; P64-3y.S6 below).
// Loading, Not found and Error are the document's own, fed by this folder's layout. An unknown
// three-segment address (`/nope/x/y`) reaches the same Document not found (D249-7z).
//
// P64-3y.S6 — job 07 draws Listen on a document: a member on the newest version of a Markdown or native
// document reads its Listen state once after the load (`documentListen`, by the document's write key), and the
// reader mounts it in its head. A visitor, an older version and the html original read none.
//
// The <title> is the document's title (P30.S15), through `generateMetadata`. The
// knowledge client is `cache: "no-store"`, so the page and the metadata share ONE
// resolver read per request (`resolveDocumentOnce`, React `cache`); a miss names the tab
// Document not found and a fault Error, and the page handles both itself.
const resolveDocumentOnce = cache(
  (
    token: string | undefined,
    org: string,
    project: string,
    slug: string,
  ): Promise<KbDocument> => resolveDocument(token, org, project, slug),
);

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; project: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  try {
    const p = await params;
    const org = safeDecode(p.org);
    if (org.startsWith("@") && org.length >= 2) {
      const ctx = await optionalIdentity();
      const doc = await resolveDocumentOnce(
        ctx?.token,
        org.slice(1),
        safeDecode(p.project),
        safeDecode(p.slug),
      );
      if (chapterRedirectHref(doc)) return { title: doc.title };
      // The version on screen (one that does not exist is Document not found).
      const loaded = await loadOnce(
        ctx?.token,
        org.slice(1),
        safeDecode(p.project),
        safeDecode(p.slug),
        versionOf((await searchParams).v),
        (await cookies()).get(READER_COOKIE)?.value,
      );
      const title =
        loaded.kind === "reader"
          ? loaded.reader.view.title
          : loaded.legacy.view.title;
      if (title) return { title };
    }
  } catch (error) {
    // the page renders the miss or the failure itself; the tab names it the same way
    return { title: missTitle(error) };
  }
  return { title: READER_DOCUMENT.notFound.title };
}

/**
 * Resolve one document by its durable `(org, project, slug)` triple with the caller's
 * (optional) token, mapping knowledge's 404/400 to the branded not-found. The mapping
 * lives OUTSIDE the render so `notFound()` — which signals by throwing — is never
 * swallowed by the `try` (the repo-wide convention; see the id page's `loadDocument`).
 *
 * `org` arrives here WITHOUT its `@`: the prefix is a web-plane routing marker and the
 * resolver route takes the bare slug.
 *
 * A 404 covers every miss the resolver has (unknown org / project / doc slug, a
 * private project, legacy mode) — they are indistinguishable by design. Anything else
 * rethrows, so a real outage surfaces instead of masquerading as a missing page.
 */
async function loadDocument(
  token: string | undefined,
  org: string,
  project: string,
  slug: string,
): Promise<KbDocument> {
  try {
    return await resolveDocumentOnce(token, org, project, slug);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 400)
    ) {
      notFound();
    }
    throw error;
  }
}

/**
 * The page's one load (reader or legacy reader), deduped per request so the metadata
 * and the page read once.
 */
const loadOnce = cache(
  async (
    token: string | undefined,
    org: string,
    project: string,
    slug: string,
    v: number | null,
    cookie: string | undefined,
  ): Promise<ReaderLoad> =>
    loadLooseReader({
      token,
      doc: await resolveDocumentOnce(token, org, project, slug),
      v,
      settings: parseReaderCookie(cookie),
      org,
      strictVersion: true,
    }),
);

function langOf(raw: string | string[] | undefined): string | null {
  const l = Array.isArray(raw) ? raw[0] : raw;
  return l && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : null;
}

function versionOf(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^\d{1,6}$/.test(v) ? Number(v) : null;
}

export default async function PrettyDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; project: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const {
    org: orgParam,
    project: projectParam,
    slug: slugParam,
  } = await params;
  const query = await searchParams;
  const v = versionOf(query.v);

  const org = safeDecode(orgParam);
  const project = safeDecode(projectParam);
  const slug = safeDecode(slugParam);

  // THE GUARD (load-bearing, see ROUTE PRECEDENCE above): our public namespace is
  // `@`-prefixed. Reject before reading the session or calling upstream.
  if (!org.startsWith("@") || org.length < 2) notFound();
  if (project === "" || slug === "") notFound();
  const orgSlug = org.slice(1);

  const ctx = await optionalIdentity();
  const cookie = (await cookies()).get(READER_COOKIE)?.value;
  // A miss is the branded not-found (outside any try, so the throw survives).
  const doc = await loadDocument(ctx?.token, orgSlug, project, slug);
  // P30.F4 (X4 / OQ183): a document bound as a book chapter reads inside its book.
  // Temporary (307), outside any try; the browser keeps `#section`.
  const chapter = chapterRedirectHref(doc, { v, lang: langOf(query.lang) });
  if (chapter) redirect(chapter);
  const [loaded, nonce, jar, phases] = await Promise.all([
    loadOnce(ctx?.token, orgSlug, project, slug, v, cookie),
    requestNonce(),
    cookies(),
    documentPhaseRows(ctx?.token, doc),
  ]);
  const listen = await documentListen(loaded, ctx?.token);
  // P61-e9: a member's way back to the phases the document was explained from, under its end.
  // P75: a member's sharing switch for the document, under its end.
  return withDocumentShare(
    withDocumentPhases(
      renderDocument(loaded, {
        from: firstOf(query[FROM_PARAM]),
        org: orgSlug,
        nonce,
        timeZone: viewerTimeZone(jar),
        listen,
      }),
      phases,
    ),
    doc,
  );
}

/** `decodeURIComponent` that returns the input unchanged on a malformed escape. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
