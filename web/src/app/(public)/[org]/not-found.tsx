import { headers } from "next/headers";

import { PageNotFound } from "@/components/states/page-not-found";
import { REQUEST_PATH_HEADER } from "@/lib/next-path";
import { publicOrgOf } from "@/lib/public-library/model";

import PublicProjectNotFound from "./[project]/not-found";

/**
 * The miss `[project]/layout.tsx` refuses with a real HTTP 404 (P78, F12 and F13), above the project's own
 * folder: an address with no `@` (`/sikstack/sikstack`) is a page that does not exist, the app's Page not found;
 * an `@` address whose project this reader cannot see is Project not found, in the bar's frame, as the page's
 * own miss draws it (`[project]/not-found.tsx`). The tab's title is the page's (`[project]/page.tsx`).
 */
export default async function PublicAddressNotFound() {
  const path = (await headers()).get(REQUEST_PATH_HEADER) ?? "/";
  const segment = path.split(/[?#]/)[0].split("/")[1] ?? "";
  return publicOrgOf(segment) !== null ? (
    <PublicProjectNotFound />
  ) : (
    <PageNotFound />
  );
}
