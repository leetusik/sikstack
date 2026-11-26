import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookBar } from "@/components/book/book-bar";
import { BookBody } from "@/components/book/book-body";
import { BookFrame } from "@/components/book/book-frame";
import { BOOK_PAGE } from "@/content/book-page";
import { SIKSTACK_STATES } from "@/content/sikstack-states";
import { optionalIdentity } from "@/lib/auth-guards";
import { loadBookOnce } from "@/lib/book/load";
import type { BookView } from "@/lib/book/view";
import { readBookSeed } from "@/lib/listen/seed";
import { ShareControl } from "@/sikstack/reader/share-control";
import { requestNonce } from "@/sikstack/shell/data";

// The book page (sikstack Library, job 03 round 02, `## Build` § Page: book): `/@{org}/{project}/books/{book}`,
// with `{org}` the org slug or the tenant id (the server's book read resolves both). Optional identity: a
// signed-in reader reads with their bearer, anyone else tokenless (public projects only), and every miss
// (an unknown org, project or book, a private project) is the same constant not-found.
//
// Wholly new: the Bar's frame (`.ui > .page > .app.bare > Bar + main.app-main > .column.is-narrow`) with
// BookHead, the way on, Contents and Your reading data. `?from=` is the list it was opened from (F324,
// F328): the Bar's way back, carried on by every chapter link. The tab title is the book's, through the
// site's template; the page and its metadata share one load per request (`loadBookOnce`).
//
// Listen (job 07, round 01: F206, F209, F234): a signed-in reader gets the head's Listen, the rows' audio and the
// dock's track, seeded as before (the book from its first chapter, and the place left part-way); any miss is "no
// Listen here", never a failed page.

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

type Params = { org: string; project: string; book: string };
type Search = Record<string, string | string[] | undefined>;

const fromOf = (search: Search): string =>
  typeof search.from === "string" ? search.from : "";

async function loadOnce(params: Params, from: string) {
  const org = safeDecode(params.org);
  const project = safeDecode(params.project);
  const book = safeDecode(params.book);
  // THE GUARD: our public namespace is `@`-prefixed (the pretty route's rule). Reject before reading
  // the session or calling upstream.
  if (!org.startsWith("@") || org.length < 2) notFound();
  if (project === "" || book === "") notFound();
  return loadBookOnce(org.slice(1), project, book, from);
}

/** `notFound()`'s throw: Next marks it with this digest. */
const isNotFound = (error: unknown) =>
  typeof (error as { digest?: unknown })?.digest === "string" &&
  (error as { digest: string }).digest.startsWith(
    "NEXT_HTTP_ERROR_FALLBACK;404",
  );

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  try {
    return {
      title: (await loadOnce(await params, fromOf(await searchParams))).title,
    };
  } catch (error) {
    // the page renders the miss or the failure itself
    return {
      title: isNotFound(error)
        ? BOOK_PAGE.states.notFound.title
        : SIKSTACK_STATES.error.title,
    };
  }
}

export default async function BookRoute({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const p = await params;
  const view = await loadOnce(p, fromOf(await searchParams));
  const [ctx, nonce] = await Promise.all([optionalIdentity(), requestNonce()]);
  const listen =
    ctx?.token && view.signedIn
      ? await readBookSeed(
          ctx.token,
          { org: view.org, project: view.project, book: view.slug },
          {
            title: view.title,
            href: bookPath(p),
            chapters: chaptersOf(view),
          },
          variantsOf(view),
        )
      : null;
  return (
    <BookFrame
      own
      nonce={nonce}
      listenSignInHref={view.signInHref}
      bar={
        <BookBar
          back={view.back}
          homeHref={view.homeHref}
          title={view.title}
          meta={view.signedIn ? view.head.state.word : view.head.count}
          visitor={!view.signedIn}
          signInHref={view.signInHref}
        />
      }
    >
      <BookBody
        key={`${view.org}/${view.project}/${view.slug}`}
        view={view}
        listen={listen}
        signInHref={view.signInHref}
      />
      {view.share ? (
        <div className="column is-narrow book-col book-share">
          <ShareControl
            target={{ kind: "book", project: view.project, book: view.slug }}
            share={view.share}
          />
        </div>
      ) : null}
    </BookFrame>
  );
}

/** The book page's own path, as asked. */
function bookPath(p: Params): string {
  return `/${p.org}/${p.project}/books/${p.book}`;
}

/** The book's chapters, in its order, as the player names them. */
function chaptersOf(view: BookView) {
  return view.rows.map((r) => ({
    key: r.key,
    n: r.n,
    title: r.title,
    lang: r.lang,
    href: r.href,
  }));
}

/** Each chapter's variants, by language: the page a Listen opens for the language it reads. */
function variantsOf(view: BookView): Record<string, Record<string, string>> {
  return Object.fromEntries(
    view.rows.map((r) => [
      r.key,
      Object.fromEntries(r.langs.map((l) => [l.code, l.href])),
    ]),
  );
}
