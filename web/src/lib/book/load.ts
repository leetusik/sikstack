import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { BOOK_PAGE } from "@/content/book-page";
import { optionalIdentity } from "@/lib/auth-guards";
import { date } from "@/lib/format";
import { getBook, getDocument, getDocumentVersions } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import {
  getReaderBook,
  getReaderBookNotes,
  type KbReaderBook,
} from "@/lib/knowledge/reader";
import type {
  KbBook,
  KbBookChapter,
  KbBookVariant,
} from "@/lib/knowledge/types";
import {
  decodeFrom,
  itemWayBack,
  LIBRARY_ORIGIN,
  wayBack,
  withFrom,
  type ListOrigin,
} from "@/lib/library/from";
import { sectionTitle } from "@/lib/library/continue";
import { readerHomeHref, reachableWayBack } from "@/lib/library/way-out";
import { orgLibraryReadsOnce } from "@/lib/library/way-out-read";
import { validateChapter } from "@/lib/native";
import { loginHref } from "@/lib/next-path";
import { languageName } from "@/lib/reader/language";
import { versionDate } from "@/lib/reader/load";
import { bookHref, bookNotesHref, readerHref } from "@/lib/reader-href";
import { viewerTimeZone } from "@/lib/time-zone";

import {
  contOf,
  headOf,
  isDone,
  isStale,
  orderChapters,
  planContinue,
  rowState,
  rowStateView,
  shapeOf,
  shownVariant,
  type ContChapter,
  type RowState,
  type Viewer,
} from "./model";
import type { BookView, LangLinkView, RowView, VersionGroupView } from "./view";

/**
 * The book page's data (sikstack Library, job 03 round 02, `## Build` § Page: book): the book's manifest
 * (`GET /app/orgs/{org}/{project}/books/{book}`, public-gated) and, signed in, the reader's state of it
 * (`GET /app/reader/books/…`), plus the reads the page composes from: the book's marks, the named
 * chapter's lede and section, and the dates of a chapter that has an earlier version. Every miss on the
 * manifest is the constant 404; a fault anywhere else throws, which is the route's Error, except the
 * optional reads (dates, lede, section), which degrade to nothing rather than take the page down.
 *
 * `from` is the raw `?from=` (F324, F328): the way back, and carried on by every chapter link. Dates are
 * in the viewer's zone (operator decision 5). A version's date is the one the read carries: today the
 * document's own date on every version (D171-qk, OQ2 open); none is invented.
 */

const miss = (error: unknown): never => {
  if (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 400)
  )
    notFound();
  throw error;
};

/**
 * The reader's own state is optional (P75): a signed-in reader of another org who opened the book by its link
 * reads the book with no state (the reader-state routes answer their 404, and a lapsed session its 401), so
 * those read as none; any other fault still throws.
 */
const noState = (error: unknown): null => {
  if (error instanceof ApiError && [401, 403, 404].includes(error.status))
    return null;
  throw error;
};

/** The org segment of a canonical path (`/@{org}/…`), or the one asked for. */
function canonicalOrg(book: KbBook, asked: string): string {
  const m = /^\/@([^/]+)\//.exec(book.canonical_path ?? "");
  if (!m) return asked;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** A read that may fail without failing the page. */
async function soft<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

interface DateInfo {
  /** The current version's date, as the read carries it (`YYYY-MM-DD` or an instant), or "". */
  current: string;
  /** Whether that date is a one-time best-effort fill (P63): kept as data, drawn as a plain date. */
  currentBestEffort: boolean;
  /** Earlier versions, newest first, each with the date its read carries. */
  older: { v: number; date: string; bestEffort: boolean }[];
}

/**
 * Where the reader came from. A visitor opened from no list goes back to the org's public library,
 * since the Library is a member's page.
 */
function originOf(raw: string, owner: string, signedIn: boolean): ListOrigin {
  if (!raw && !signedIn)
    return { origin: "public-library", org: owner, place: {} };
  return decodeFrom(raw);
}

/**
 * The book's way back (F324, P63-fk.F4): `itemWayBack` with what the reads carry. The list `from` names
 * is kept only when it is the book's own (a member's Library or project page, the public library of the
 * book's org, its project's page there); anything else is the book's default, as with no list. The org's
 * name (the book read's `org.name`, P63; a member's own tenant's when an older backend carries none)
 * labels the book's own public library, else the slug of the book's own address. P75: a visitor the org's public
 * library refuses (a link reader in an org with nothing Public) goes back to the sikstack home. Pure.
 */
export function bookBack(
  from: ListOrigin,
  read: {
    /** A signed-in reader: their lists are theirs to go back to; a visitor's default is the org's library. */
    member: boolean;
    /** The book's org segment (`canonicalOrg`): its slug, else its tenant id. */
    owner: string;
    /** The org's slug as the read names it, when it has one. */
    slug?: string | null;
    orgName: string | null;
    project: string;
    /** Whether the org's public library reads for this reader (P75, `@/lib/library/way-out`); absent: true. */
    orgLibrary?: boolean;
  },
): { href: string; label: string } {
  const back = itemWayBack(from, {
    member: read.member,
    orgs: [read.owner, read.slug],
    project: read.project,
    orgName: read.orgName,
  });
  const out = reachableWayBack(
    back ? { href: back.href, label: back.label } : null,
    { member: read.member, orgLibrary: read.orgLibrary },
  );
  return out ? { href: out.href, label: out.label } : wayBack(LIBRARY_ORIGIN);
}

export async function loadBook(
  org: string,
  project: string,
  bookSlug: string,
  fromRaw: string,
): Promise<BookView> {
  const ctx = await optionalIdentity();
  const token = ctx?.token;
  const timeZone = viewerTimeZone(await cookies());
  const [book, state]: [KbBook, KbReaderBook | null] = await Promise.all([
    getBook(token, org, project, bookSlug).catch(miss),
    token
      ? getReaderBook(token, org, project, bookSlug).catch(noState)
      : Promise.resolve(null),
  ]);
  const owner = canonicalOrg(book, org);
  const tenants = ctx ? [ctx.identity.tenant, ...ctx.identity.tenants] : [];
  const tenant = tenants.find(
    (t) => !!t && (t.slug?.trim() ? t.slug.trim() : t.id) === owner,
  );
  const viewer: Viewer = !ctx ? "anon" : tenant ? "member" : "other";
  const signedIn = viewer !== "anon";
  const target = { org: owner, project, book: book.slug };
  const from = originOf(fromRaw, owner, signedIn);
  // P75: a link reader in an org with nothing Public has no org library to go back to (`@/lib/library/way-out`).
  const orgLibrary = signedIn ? true : await orgLibraryReadsOnce(owner);

  const chapters = orderChapters(book.chapters);
  const M = chapters.length;
  const byKey = new Map((state?.chapters ?? []).map((c) => [c.key, c]));

  const shown = chapters.map((c) => {
    const st = byKey.get(c.key);
    return {
      chapter: c,
      variant: shownVariant(c, signedIn ? st?.position?.lang : null),
      state: signedIn ? rowState(st) : ("unopened" as RowState),
      pct: Math.round((st?.position?.max_fraction ?? 0) * 100),
    };
  });
  const done = shown.filter((s) => isDone(s.state)).length;
  const started = shown.filter((s) => s.state === "started").length;
  const touched = shown.filter((s) => s.state !== "unopened").length;
  const marks = state?.counts?.marks ?? 0;

  // The pointer: the most recently updated position among this book's chapters.
  const ptr = state?.continue ?? null;
  const ptrIndex = ptr
    ? chapters.findIndex((c) => c.key === ptr.chapter_key)
    : -1;
  const plan = planContinue(
    shown.map((s, i) => ({ n: i + 1, state: s.state, summary: "" })),
    signedIn,
    ptr && ptrIndex >= 0
      ? { index: ptrIndex, section: "", pct: Math.round(ptr.fraction * 100) }
      : null,
  );
  const startPlan = planContinue([], false, null);
  const named = shown[plan.index] ?? shown[0];
  const first = shown[0];
  const hasData = signedIn && (touched > 0 || marks > 0);

  // Every language of a chapter that has Version history: its rows carry each version's date,
  // a translation still at v1 included (the board's `한국어 v1 · Published Oct 15`).
  const multi = shown.flatMap((s) =>
    s.chapter.variants.some((v) => v.version > 1) ? s.chapter.variants : [],
  );
  const ptrVariant =
    plan.kind === "continue" && ptr
      ? chapters[plan.index].variants.find((v) => v.lang === ptr.lang)
      : undefined;
  const wantsLede = plan.kind === "start" || plan.kind === "next";
  // the way on after a clear is chapter 1's start, with its lede
  const wantsFirstLede =
    hasData && !(plan.kind === "start" && plan.index === 0);
  const [dates, sectionAt, lede, firstLede, notesRead] = await Promise.all([
    Promise.all(multi.map((v) => soft(() => datesOf(token, v)))),
    ptrVariant && ptr?.anchor_id && ptrVariant.format === "native"
      ? soft(() => sectionOf(token, ptrVariant, ptr.anchor_id as string))
      : Promise.resolve(null),
    wantsLede && named
      ? soft(() => ledeOf(token, named.variant))
      : Promise.resolve(null),
    wantsFirstLede && first
      ? soft(() => ledeOf(token, first.variant))
      : Promise.resolve(null),
    hasData
      ? getReaderBookNotes(token as string, target).catch(miss)
      : Promise.resolve(null),
  ]);
  const dateOf = new Map<number, DateInfo>();
  multi.forEach((v, i) => {
    const d = dates[i];
    if (d) dateOf.set(v.doc_id, d);
  });
  const day = (value: string) => (value ? date(value, { timeZone }) : "");

  const chapterHref = (key: string, lang: string | null, v?: number | null) =>
    withFrom(
      readerHref(
        { kind: "chapter", ...target, chapter: key },
        { lang, version: v ?? null },
      ),
      from,
    );
  const notFirst = (c: KbBookChapter, lang: string) =>
    lang === c.variants[0].lang ? null : lang;
  const t = BOOK_PAGE.contents;

  const rows: RowView[] = shown.map((s, i) => {
    const c = s.chapter;
    const n = i + 1;
    const langs = c.variants;
    const multiLang = langs.length > 1;
    const multiVer = langs.some((v) => v.version > 1);
    const links: LangLinkView[] = multiLang
      ? langs.map((v) => {
          const name = languageName(v.lang);
          return {
            code: v.lang,
            label: t.language(name, v.version),
            aria: t.languageAria(name, v.version, n),
            stale: isStale(c, v),
            href: chapterHref(c.key, notFirst(c, v.lang)),
          };
        })
      : [];
    const groups: VersionGroupView[] = multiVer
      ? langs.map((v) => {
          const info = dateOf.get(v.doc_id);
          const name = languageName(v.lang);
          const versions = [
            {
              n: v.version,
              date: info?.current ?? "",
              bestEffort: info?.currentBestEffort ?? false,
              from: v.translated_from
                ? t.translatedFrom(
                    languageName(v.translated_from.lang),
                    v.translated_from.version,
                  )
                : "",
            },
            ...(info?.older ?? [])
              .filter((o) => o.v < v.version)
              .map((o) => ({
                n: o.v,
                date: o.date,
                bestEffort: o.bestEffort,
                from: "",
              })),
          ];
          return {
            code: v.lang,
            label: name,
            rows: versions.map((r) => {
              const current = r.n === v.version;
              return {
                n: r.n,
                current,
                published: r.date ? t.published(day(r.date)) : "",
                bestEffort: r.bestEffort,
                from: r.from,
                aria: t.viewAria(r.n, name),
                href: chapterHref(
                  c.key,
                  notFirst(c, v.lang),
                  current ? null : r.n,
                ),
              };
            }),
          };
        })
      : [];
    return {
      key: c.key,
      n,
      title: c.title || s.variant.title,
      lang: s.variant.lang,
      href: chapterHref(c.key, notFirst(c, s.variant.lang)),
      updated: signedIn && s.state === "updated",
      state: rowStateView(s.state, s.pct, signedIn),
      langs: links,
      one:
        !multiLang && multiVer
          ? t.one(
              langs[0].version,
              day(dateOf.get(langs[0].doc_id)?.current ?? ""),
            )
          : "",
      multiVer,
      groups,
    };
  });

  const contChapters: ContChapter[] = rows.map((r) => ({
    n: r.n,
    title: r.title,
    lang: r.lang,
    href: r.href,
  }));
  const cont = contOf(plan, contChapters, {
    section: plan.kind === "continue" ? (sectionAt ?? "") : "",
    lede: lede ?? "",
  });
  const start =
    plan.kind === "start" && plan.index === 0
      ? cont
      : contOf(startPlan, contChapters, { section: "", lede: firstLede ?? "" });

  const noteN = notesRead
    ? notesRead.annotations.length +
      notesRead.unanchored.length +
      notesRead.bookmarks.length
    : 0;
  const noteChapters = notesRead
    ? new Set(
        [
          ...notesRead.annotations,
          ...notesRead.unanchored,
          ...notesRead.bookmarks,
        ]
          .map((m) => m.chapter_key)
          .filter((k): k is string => !!k),
      ).size
    : 0;

  const kind = book.kind === "subject" ? "subject" : "codebase";
  const place = BOOK_PAGE.head.place(
    kind,
    viewer === "member"
      ? book.project
      : BOOK_PAGE.head.publicPlace(owner, book.project),
  );

  return {
    org: owner,
    project,
    slug: book.slug,
    title: book.title,
    viewer,
    signedIn,
    share: viewer === "member" ? (book.share ?? null) : null,
    head: headOf({
      title: book.title,
      sub: book.sub?.trim() ?? "",
      subLang: book.sub_lang,
      description: book.description ?? "",
      place,
      signedIn,
      done,
      started,
      total: M,
    }),
    cont,
    start,
    notes:
      signedIn && noteN > 0
        ? {
            href: bookNotesHref(target, { from: "book" }),
            line: BOOK_PAGE.notes.count(noteN, noteChapters),
          }
        : null,
    count: t.count(M),
    shapeNote: shapeOf(book.chapters).kind === "phases" ? t.phases : "",
    rows,
    data: hasData ? { chapters: touched, marks } : null,
    back: bookBack(from, {
      member: signedIn,
      owner,
      slug: book.org?.slug,
      orgName: book.org?.name || tenant?.name || null,
      project: book.project,
      orgLibrary,
    }),
    homeHref: readerHomeHref({ member: signedIn, org: owner, orgLibrary }),
    signInHref: loginHref(withFrom(bookHref(target), fromRaw ? from : null)),
  };
}

/** The dates of one variant's versions, as the reads carry them: the current's, and the earlier ones. */
async function datesOf(
  token: string | undefined,
  variant: KbBookVariant,
): Promise<DateInfo> {
  const [doc, page] = await Promise.all([
    getDocument(token, variant.doc_id),
    getDocumentVersions(token, variant.doc_id),
  ]);
  // P63 (D171-qk): each version's own publish time, else the document's date as before.
  const own = versionDate(doc);
  return {
    current: own.date,
    currentBestEffort: own.bestEffort,
    older: [...page.versions]
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ v: v.version, ...versionDate(v) })),
  };
}

/**
 * The title of the heading the saved place is under, in the variant's current text: the book's "Left off at …".
 * Only the name: Continue reading resumes the saved place itself (F242), never the heading.
 */
async function sectionOf(
  token: string | undefined,
  variant: KbBookVariant,
  anchorId: string,
): Promise<string> {
  const doc = await getDocument(token, variant.doc_id);
  if (doc.format !== "native" || !doc.source) return "";
  return sectionTitle(doc.source, anchorId);
}

/** A native chapter's lede (its header's `summary`), or "". */
async function ledeOf(
  token: string | undefined,
  variant: KbBookVariant,
): Promise<string> {
  if (variant.format !== "native") return "";
  const doc = await getDocument(token, variant.doc_id);
  if (doc.format !== "native" || !doc.source) return "";
  return validateChapter(doc.source, "native").tree.summary || "";
}

/**
 * One load per request, shared by the page and its metadata (the knowledge client is `no-store`, so two
 * calls would read twice). Primitive arguments: React's `cache` keys on identity.
 */
export const loadBookOnce = cache(loadBook);
