/**
 * Where the book page's states (loading, Book not found, Error) send the reader, from the address alone:
 * they have no book read to name the list by. The way back is the list in `?from=` (F324) when it is the
 * book's own by its address (`/@{org}/{project}/…`, P63-fk.F4), else, for a visitor, the org's public
 * library taken from the address, else the Library; its label is the address's slug, never `from`'s text.
 * Pure, and free of `next/headers`: the server states pass the request's path, the error boundary the
 * browser's. P75: `orgLibrary` false (a link reader in an org with nothing Public, `@/lib/library/way-out`) sends
 * a visitor's wordmark and way back to the sikstack home instead of the org's public library.
 */
import {
  decodeFrom,
  itemWayBack,
  LIBRARY_ORIGIN,
  wayBack,
} from "@/lib/library/from";
import { readerHomeHref, reachableWayBack } from "@/lib/library/way-out";
import { loginHref } from "@/lib/next-path";

export interface StatePlace {
  back: { href: string; label: string };
  homeHref: string;
  signInHref: string;
  visitor: boolean;
}

export function statePlace(
  path: string,
  signedIn: boolean,
  orgLibrary = true,
): StatePlace {
  let url: URL | null = null;
  try {
    url = new URL(path.startsWith("/") ? path : "/", "https://book.invalid");
  } catch {
    url = null;
  }
  const from = url?.searchParams.get("from") ?? "";
  const at = url ? /^\/@([^/]+)(?:\/([^/]+))?/.exec(url.pathname) : null;
  const org = at?.[1] ? decoded(at[1]) : null;
  const project = at?.[2] ? decoded(at[2]) : null;
  const way = itemWayBack(from ? decodeFrom(from) : null, {
    member: signedIn,
    orgs: [org],
    project,
  });
  const back =
    reachableWayBack(way ? { href: way.href, label: way.label } : null, {
      member: signedIn,
      orgLibrary,
    }) ?? wayBack(LIBRARY_ORIGIN);
  return {
    back: { href: back.href, label: back.label },
    homeHref: readerHomeHref({ member: signedIn, org, orgLibrary }),
    signInHref: loginHref(url ? `${url.pathname}${url.search}` : "/"),
    visitor: !signedIn,
  };
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
