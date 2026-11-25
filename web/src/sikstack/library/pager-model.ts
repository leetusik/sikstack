import { num } from "@/lib/format";

import { PAGER } from "@/content/library-frame";

/**
 * The pager's logic (`Pager.dc.html`, frame.md F325), pure so a node test reaches it.
 *
 * - The numbers: every page when there are 7 or fewer; else always seven places, the first, the last,
 *   the current one with its neighbours and an ellipsis for each gap (`1 2 3 4 5 … 10`,
 *   `1 … 4 5 6 … 10`, `1 … 6 7 8 9 10`), so the ways never move as the page changes.
 * - Previous on the first page and Next on the last are off.
 * - In the build each number, Previous and Next is a link to `?page=n` (or the list's own key), the
 *   list's other query parts kept, so a page can be linked and the way back from a document returns to it.
 */
export type PagerSlot = number | "gap";

/** The places of the numbers for `page` of `pages`. */
export function pagerSlots(page: number, pages: number): PagerSlot[] {
  const all = (a: number, z: number) =>
    Array.from({ length: z - a + 1 }, (_, i) => a + i);
  if (pages <= 7) return all(1, pages);
  if (page <= 4) return [...all(1, 5), "gap", pages];
  if (page >= pages - 3) return [1, "gap", ...all(pages - 4, pages)];
  return [1, "gap", page - 1, page, page + 1, "gap", pages];
}

/** The page shown, held to 1 … pages, and how many there are (at least one). */
export function pagerPlace(
  page: number,
  pages: number,
): { page: number; pages: number } {
  const count = Math.max(1, Math.floor(Number(pages)) || 1);
  const at = Math.min(count, Math.max(1, Math.floor(Number(page)) || 1));
  return { page: at, pages: count };
}

/** Where Previous and Next go; `null` where that way is off (the first page, the last). */
export function pagerWays(
  page: number,
  pages: number,
): { previous: number | null; next: number | null } {
  return {
    previous: page <= 1 ? null : page - 1,
    next: page >= pages ? null : page + 1,
  };
}

/** A list's query parts other than the page: `view`, `q`, `filter` (frame.md F324). */
export type PagerQuery = Record<string, string | null | undefined>;

/**
 * The query key that holds a list's page: the Library's lists use `page`; the
 * backlog's Archived phases `archived` (job 02 frame.md F300), so a page that holds a second list keeps both
 * lists' pages in its address.
 */
export type PagerKey = "page" | "archived";

/**
 * The address of page `n`: `?<key>=n` (`?page=n` by default), after the list's other query parts (empty ones
 * left out).
 */
export function pageHref(
  n: number,
  query: PagerQuery = {},
  key: PagerKey = "page",
): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (name === key || value === null || value === undefined || value === "")
      continue;
    params.set(name, value);
  }
  params.set(key, String(n));
  return `?${params.toString()}`;
}

/** `26–50 of 240`: the rows a page of `size` shows out of `total`. */
export function pagerRange(page: number, size: number, total: number): string {
  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  return PAGER.range(num(first), num(last), num(total));
}
