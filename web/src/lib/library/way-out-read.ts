/**
 * Does the org's public library read for this reader (P75, `./way-out`)? The server's answer, one a request.
 *
 * - A signed-in reader: true, and nothing is read. Their way out is their own Library either way.
 * - A visitor holding no share link: true, and nothing is read. Without a link a visitor reads only Public
 *   items, which the org's public library lists, so it reads for them.
 * - A visitor holding a share link (the share cookie, `@/lib/sharing/cookie`): the org's public library is read
 *   exactly as `/@{org}` reads it for them (`loadPublicLibraryOnce`, the same `cache`d read, and
 *   `publicLibraryView`): a miss, or nothing to show, is false. A fault is false too: the sikstack home always
 *   reads.
 */
import "server-only";

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { optionalIdentity } from "@/lib/auth-guards";
import { loadPublicLibraryOnce } from "@/lib/public-library/load";
import { publicLibraryView } from "@/lib/public-library/model";
import { parseShareCookie, SHARE_COOKIE } from "@/lib/sharing/cookie";

async function orgLibraryReads(org: string | null): Promise<boolean> {
  if (!org) return true;
  try {
    if ((await optionalIdentity()) !== null) return true;
    const jar = await cookies();
    if (parseShareCookie(jar.get(SHARE_COOKIE)?.value).length === 0)
      return true;
    const read = await loadPublicLibraryOnce(undefined, org);
    if (!read) return false;
    return (
      publicLibraryView(read.listing, read.state, { org, ids: read.ids }) !==
      null
    );
  } catch (error) {
    unstable_rethrow(error);
    return false;
  }
}

/** One answer a request per org (React `cache`; a primitive argument). */
export const orgLibraryReadsOnce = cache(orgLibraryReads);
