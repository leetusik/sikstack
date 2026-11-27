import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { LegacyReaderPage } from "@/components/reader/legacy-reader-page";
import { SIKSTACK_STATES } from "@/content/sikstack-states";
import { READER_FRAME } from "@/content/reader-frame";
import { ChapterReader } from "@/sikstack/reader";
import { ChapterBody } from "@/sikstack/reader/body/body";
import { requestNonce } from "@/sikstack/shell/data";
import { optionalIdentity } from "@/lib/auth-guards";
import { decodeFrom, FROM_PARAM } from "@/lib/library/from";
import { chapterSeed, readListenState } from "@/lib/listen/seed";
import type { ListenBookKey } from "@/lib/listen/types";
import { READER_COOKIE } from "@/lib/reader-cookie";
import { layerOn } from "@/lib/reader/layer";
import { loadChapterReaderOnce } from "@/lib/reader/load";
import { viewerTimeZone } from "@/lib/time-zone";
import { canonical, readerPath } from "@/sikstack/seo/urls";

// P30.S13 — a chapter of a book in the reader (`01-reader`): the URL is
// `/@{org}/{project}/books/{book}/{key}[?lang=&v=]`, with `{org}` the org slug or the
// tenant id (the server's book read resolves both). Optional identity, exactly like
// the pretty document route: a member reads with their bearer, anyone else tokenless
// (public projects only), and every miss — an unknown org, project, book or chapter,
// a private project — is the same constant not-found, with no word about why.
//
// The reader has no app shell. A legacy (html) chapter, or an html version of one, opens
// in the legacy reader here (P30.S25, `09-legacy-and-print`; it used to redirect to its
// document page). Settings come from the `kb_reader` cookie on the server render, so the
// first paint already has the reader's text size and theme.
//
// P63-fk.S8 — a native or Markdown chapter reads in the sikstack reader's frame (`@/sikstack/reader`,
// job 03 Library round 02): the Bar, the head, the end, the foot and the sheets are new. P63-fk.S9:
// the text is the Library's body (`ChapterBody`); its terms, quiz, highlights and notes keep their
// old look until S10 and S11. `?from=` is
// the list the reader came through (F328), carried to the book and the next chapter. The
// loading, not found and error screens are the frame's, fed by this folder's layout.
//
// The <title> is the chapter's title (P30.S15), through `generateMetadata`. The
// knowledge client is `cache: "no-store"`, so the page and the metadata share ONE load
// per request (`loadChapterReaderOnce`, React `cache`) instead of reading twice. A miss or
// a fault falls back to the static title and leaves the page's own handling (not-found,
// the error screen) to the page.
//
// P41-sr.W2 — Listen: a signed-in reader of a native chapter's current version gets the
// page's Listen seed, the book from this chapter (B1's book key), read beside the page's
// own load the way the document route reads its own (Listen's routes are session-only;
// any miss is "no Listen here", never a failed page). The legacy reader's page asks for `viewport-fit=cover`
// (its bars pad themselves by the safe areas); the native reader's does not.

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function first(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === "" ? null : v;
}

type Params = { org: string; project: string; book: string; chapter: string };
type Query = Record<string, string | string[] | undefined>;

/** The one load both the page and its metadata make. */
async function loadOnce(params: Params, query: Query) {
  const org = safeDecode(params.org);
  const project = safeDecode(params.project);
  const book = safeDecode(params.book);
  const chapter = safeDecode(params.chapter);
  // THE GUARD: our public namespace is `@`-prefixed (the pretty route's rule). Reject
  // before reading the session or calling upstream.
  if (!org.startsWith("@") || org.length < 2) notFound();
  if (project === "" || book === "" || chapter === "") notFound();

  const lang = first(query.lang);
  const rawV = first(query.v);
  const v = rawV !== null && /^\d{1,6}$/.test(rawV) ? Number(rawV) : null;
  const ctx = await optionalIdentity();
  const cookie = (await cookies()).get(READER_COOKIE)?.value;
  return loadChapterReaderOnce(
    ctx?.token,
    org.slice(1),
    project,
    book,
    chapter,
    lang !== null && /^[a-z]{2,3}$/.test(lang) ? lang : null,
    v,
    cookie,
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}): Promise<Metadata> {
  try {
    const loaded = await loadOnce(await params, await searchParams);
    const view =
      loaded.kind === "reader" ? loaded.reader.view : loaded.legacy.view;
    // P87: one canonical URL per chapter, whatever `?lang=` or `?v=` is on screen (`readerPath`).
    if (view.title)
      return {
        title: view.title,
        alternates: canonical(readerPath(view.target)),
      };
  } catch (error) {
    // the page renders the miss or the failure itself; the tab names it the same way
    if (isNotFound(error)) return { title: READER_FRAME.notFound.title };
    return { title: SIKSTACK_STATES.error.title };
  }
  return { title: READER_FRAME.notFound.title };
}

/** `notFound()`'s throw (Next marks it with this digest). */
function isNotFound(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.endsWith(";404");
}

export async function generateViewport({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}): Promise<Viewport> {
  try {
    const loaded = await loadOnce(await params, await searchParams);
    if (loaded.kind === "legacy") return { viewportFit: "cover" };
  } catch {
    // the page renders the miss or the failure itself
  }
  return {};
}

/** This chapter's Listen key: the book from here, in the language asked for (else the server's default). */
function listenKey(params: Params, query: Query): ListenBookKey | null {
  const org = safeDecode(params.org);
  if (!org.startsWith("@") || org.length < 2) return null;
  const lang = first(query.lang);
  return {
    org: org.slice(1),
    project: safeDecode(params.project),
    book: safeDecode(params.book),
    from_chapter: safeDecode(params.chapter),
    ...(lang !== null && /^[a-z]{2,3}$/.test(lang) ? { lang } : {}),
  };
}

export default async function ChapterPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Query>;
}) {
  const p = await params;
  const query = await searchParams;
  const ctx = await optionalIdentity();
  const key = listenKey(p, query);
  const [loaded, listenState, nonce, jar] = await Promise.all([
    loadOnce(p, query),
    ctx?.token && key ? readListenState(ctx.token, key) : Promise.resolve(null),
    requestNonce(),
    cookies(),
  ]);
  if (loaded.kind === "legacy") {
    return (
      <LegacyReaderPage legacy={loaded.legacy} timeZone={viewerTimeZone(jar)} />
    );
  }
  const reader = loaded.reader;
  const rawFrom = first(query[FROM_PARAM]);
  // Keyed by what is on screen (the variant and its version), so another chapter, language or
  // version starts the frame fresh: the hold, the pill and the place end with the view.
  return (
    <ChapterReader
      key={`${reader.docId}:${reader.view.version}`}
      view={reader.view}
      notes={layerOn(reader)}
      listen={key ? chapterSeed(reader.view, listenState, key) : null}
      from={rawFrom === null ? null : decodeFrom(rawFrom)}
      nonce={nonce}
      timeZone={viewerTimeZone(jar)}
    >
      <ChapterBody reader={reader} />
    </ChapterReader>
  );
}
