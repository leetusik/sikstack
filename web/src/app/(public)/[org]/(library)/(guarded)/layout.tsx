import { notFound, unstable_rethrow } from "next/navigation";

import { optionalIdentity } from "@/lib/auth-guards";
import { loadPublicLibraryOnce } from "@/lib/public-library/load";
import { publicLibraryView, publicOrgOf } from "@/lib/public-library/model";

/**
 * The public library's guard (D249-7z): our public namespace is `@`-prefixed, so an address without the
 * `@` (`/nope`) is no public library and is refused here, before any session or API read and above this
 * folder's `loading.tsx`. Nothing has streamed yet, so its `notFound()` answers a real HTTP 404 with the
 * parent folder's not found (`../not-found.tsx`: Page not found for an address with no `@`).
 *
 * P78, F13: an `@` address whose library this reader cannot see (an unknown org, or one with nothing public to
 * them) is refused here too, by the page's own read (`loadPublicLibraryOnce` and `publicLibraryView`, the same
 * `cache`d read the page and its title use), so it is a real 404 rather than a 200 marked noindex. A read that
 * fails is the page's to draw (its error boundary sits under this layout).
 */
export default async function PublicLibraryGuard({
  params,
  children,
}: {
  params: Promise<{ org: string }>;
  children: React.ReactNode;
}) {
  const org = publicOrgOf((await params).org);
  if (org === null) notFound();
  let missing = false;
  try {
    const ctx = await optionalIdentity();
    const read = await loadPublicLibraryOnce(ctx?.token, org);
    missing =
      !read ||
      publicLibraryView(read.listing, read.state, { org, ids: read.ids }) ===
        null;
  } catch (error) {
    unstable_rethrow(error);
  }
  if (missing) notFound();
  return children;
}
