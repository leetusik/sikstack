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
import { canonical, readerPath } from "@/sikstack/seo/urls";
import {
  documentPhaseRows,
  withDocumentPhases,
  withDocumentShare,
} from "@/sikstack/reader/document/with-phases";
import { optionalIdentity } from "@/lib/auth-guards";
import { ApiError } from "@/lib/knowledge/client";
import { FROM_PARAM } from "@/lib/library/from";
import { loginHref } from "@/lib/next-path";
import { parseReaderCookie, READER_COOKIE } from "@/lib/reader-cookie";
import { chapterRedirectHref } from "@/lib/reader-href";
import { loadLooseReader, type ReaderLoad } from "@/lib/reader/load";
import { viewerTimeZone } from "@/lib/time-zone";
import type { KbDocument } from "@/lib/knowledge/types";

import { getDocumentOnce } from "./read";

// P19 — one document in full, on the OPTIONAL-IDENTITY public route group (the URL
// `/documents/{id}` is unchanged). It branches on `optionalIdentity()`:
//   - a signed-in member → fetched with their bearer (a cross-org member transparently
//     gets a public doc via knowledge's server-side public fallback);
//   - an anonymous visitor → fetched TOKENLESS; a private/nonexistent doc 404s
//     server-side and we bounce to /login with `?next=` back here.
//
// P30.S13 — a native or md document opens in the READER (`01-reader`, the loose-
// document variant: no book navigation, no app shell) from this id URL and from its
// pretty URL; `?v=N` reads an older version. P30.S25 — an html explainer (or an html
// version) opens in the LEGACY READER (`09-legacy-and-print`): the full-screen
// sandboxed frame, the document bar, no app shell. The older frame's copy-link / Export
// PDF / Full width / Delete row is gone with it (delete stays on the console's list).
//
// The <title> is the document's title (P30.S15), through `generateMetadata`. The
// knowledge client is `cache: "no-store"`, so the page and the metadata share ONE
// document read per request (`getDocumentOnce`, React `cache`). A miss or a fault falls
// back to the static title; the page handles the miss itself.
//
// P63-fk.S12 — a native or md document reads in the Library's reader (`renderDocument`, job 03 Library
// round 02, § Page: document), as on its pretty address: the way back by `?from=`, `?v=n` (a version that
// does not exist is Document not found), the marks by format (OQ14). Loading, Not found and Error are the
// document's own.
//
// P64-3y.S6 — job 07 draws Listen on a document: a member on the newest version of a Markdown or native
// document reads its Listen state once after the load (`documentListen`, by the document's write key), and the
// reader mounts it in its head. A visitor, an older version and the html original read none.
//
// P78, F13: the document's read (`getDocumentOnce`) is `./read.ts`'s, shared with the layout, which refuses an id no
// document can have and a member's miss with a real 404 before this page streams.

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  try {
    const id = Number((await params).id);
    if (Number.isInteger(id) && id >= 1) {
      const ctx = await optionalIdentity();
      const doc = await getDocumentOnce(ctx?.token, id);
      // Sent on (a visitor to the pretty address, a bound chapter to its book): nothing renders here.
      if ((!ctx && doc.canonical_path) || chapterRedirectHref(doc)) {
        return { title: doc.title };
      }
      // The version on screen (one that does not exist is Document not found).
      const loaded = await loadOnce(
        ctx?.token,
        id,
        versionOf((await searchParams).v),
        (await cookies()).get(READER_COOKIE)?.value,
      );
      const view =
        loaded.kind === "reader" ? loaded.reader.view : loaded.legacy.view;
      // P87: the document's one public URL (its pretty path, else `/documents/{id}`), as `/sitemap.xml` lists it.
      if (view.title)
        return {
          title: view.title,
          alternates: canonical(readerPath(view.target)),
        };
    }
  } catch (error) {
    // the page renders the miss or the failure itself; the tab names it the same way
    return { title: missTitle(error) };
  }
  return { title: READER_DOCUMENT.notFound.title };
}

/**
 * Fetch one document with the caller's (optional) token, mapping knowledge's 404/400
 * to the caller-appropriate miss. The mapping lives OUTSIDE the render so
 * `notFound()`/`redirect()` — which signal by throwing — are never swallowed by a
 * `try`. 404 (missing OR another tenant's private/nonexistent — 404-never-403, ids
 * cannot be probed) and 400 both map the same way; everything else rethrows (an
 * outage must surface).
 */
async function loadDocument(
  token: string | undefined,
  id: number,
  onMiss: () => never,
): Promise<KbDocument> {
  try {
    return await getDocumentOnce(token, id);
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.status === 400)
    ) {
      onMiss();
    }
    throw error;
  }
}

/**
 * The page's one load (reader or legacy reader), deduped per request so the metadata
 * and the page read once. Every argument is
 * a primitive; the settings arrive as the raw cookie value.
 */
const loadOnce = cache(
  async (
    token: string | undefined,
    id: number,
    v: number | null,
    cookie: string | undefined,
  ): Promise<ReaderLoad> =>
    loadLooseReader({
      token,
      doc: await getDocumentOnce(token, id),
      v,
      settings: parseReaderCookie(cookie),
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

/** The page as it renders: the reader, or the legacy reader (`renderDocument`); a member's reader with its Listen. */
async function render(
  loaded: ReaderLoad,
  query: Record<string, string | string[] | undefined>,
  token?: string,
  doc?: KbDocument,
) {
  const [nonce, jar, listen, phases] = await Promise.all([
    requestNonce(),
    cookies(),
    documentListen(loaded, token),
    doc ? documentPhaseRows(token, doc) : Promise.resolve([]),
  ]);
  const org = loaded.kind === "reader" ? orgOf(loaded.reader.view) : null;
  // P61-e9: a member's way back to the phases the document was explained from, under its end.
  // P75: a member's sharing switch for the document, under its end.
  const page = withDocumentPhases(
    renderDocument(loaded, {
      from: firstOf(query[FROM_PARAM]),
      org,
      nonce,
      timeZone: viewerTimeZone(jar),
      listen,
    }),
    phases,
  );
  return doc ? withDocumentShare(page, doc) : page;
}

/** The org's slug a document's own address names (`/@{org}/…`), for a visitor's way back. */
function orgOf(view: { write: { org: string } | null }): string | null {
  return view.write?.org ?? null;
}

export default async function DocumentPage({
  params,
  searchParams,
}: {
  // Next 16: dynamic route params arrive as a Promise.
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: idParam } = await params;
  const query = await searchParams;
  // Doc ids are integers. A non-integer / non-positive id is effectively not-found
  // for everyone (the backend would 422 it) and leaks nothing regardless of auth, so
  // short-circuit to the branded not-found BEFORE reading the session. Outside any
  // try, so the `notFound()` throw is never swallowed.
  const id = Number(idParam);
  if (!Number.isInteger(id) || id < 1) notFound();

  const ctx = await optionalIdentity();
  const v = versionOf(query.v);
  const cookie = (await cookies()).get(READER_COOKIE)?.value;

  // ── Member branch. ─────────────────────────────────────────────────────────
  if (ctx) {
    const doc = await loadDocument(ctx.token, id, notFound);
    // P30.F4 (X4 / OQ183): a document bound as a book chapter reads inside its book.
    // Temporary (307), like the pretty-URL redirect below; the browser keeps `#section`.
    const chapter = chapterRedirectHref(doc, { v, lang: langOf(query.lang) });
    if (chapter) redirect(chapter);
    return render(
      await loadOnce(ctx.token, id, v, cookie),
      query,
      ctx.token,
      doc,
    );
  }

  // ── Anonymous branch — public-only read, no token. A miss bounces to /login. ─
  // P30.S11 (D18) — with `?next=` back to this document, so signing in finishes
  // the trip the visitor started (a private document then reads as a member's).
  const doc = await loadDocument(undefined, id, () =>
    redirect(loginHref(`/documents/${id}`)),
  );
  // P30.F4 (X4 / OQ183): a bound chapter goes straight to its chapter URL.
  const chapter = chapterRedirectHref(doc, { v, lang: langOf(query.lang) });
  if (chapter) redirect(chapter);
  // P25.S3 — an anonymous visitor who followed an old id link is sent on to the
  // PRETTY URL when the document has one (`canonical_path`, built once in the backend
  // from durable parts; `null` until the owning tenant claims an org slug, and then
  // this page just serves as it always has — no link ever breaks).
  //
  // Anonymous ONLY: a signed-in member keeps the id URL, and the intent explicitly
  // allows internal navigation to stay id-keyed.
  //
  // TEMPORARY (307 via `redirect()`), never permanent: org slugs are mutable in this
  // phase, and a 308 would be cached by browsers past a slug change. One-way only —
  // the pretty page never redirects back here, so there is no loop.
  // Top level, outside any try: `redirect()` signals by throwing.
  if (doc.canonical_path) {
    redirect(v !== null ? `${doc.canonical_path}?v=${v}` : doc.canonical_path);
  }
  return render(await loadOnce(undefined, id, v, cookie), query);
}
