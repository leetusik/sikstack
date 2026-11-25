import type { Metadata } from "next";

import { PageNotFound } from "@/components/states/page-not-found";
import { SIKSTACK_STATES } from "@/content/sikstack-states";

/**
 * The root not-found (job 01 round 03-instrument, Shared states: Not found): every address that matches
 * no route, and a `notFound()` from any segment without a nearer `not-found.tsx` (the `(public)` pages
 * that have none of their own). The block and its frame are `PageNotFound`'s: the Shell signed in, its own
 * `UiRoot` and "Go to sikstack" signed out.
 *
 * Before P58 there was no root not-found: Next's default 404 page answered both cases. The tab says so (P78, F17).
 */
export const metadata: Metadata = { title: SIKSTACK_STATES.notFound.title };

export default function RootNotFound() {
  return <PageNotFound />;
}
