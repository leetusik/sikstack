import type { MouseEvent } from "react";
import Link from "next/link";

import { PAGER } from "@/content/library-frame";

import {
  pageHref,
  pagerPlace,
  pagerSlots,
  pagerWays,
  type PagerKey,
  type PagerQuery,
} from "./pager-model";

/**
 * Pager (`Pager.dc.html`, frame.md F325): the product's one pager. `nav.pager` named by `label`
 * (`Pages of documents`): the range and the total at the start (`26–50 of 240`, tabular), then
 * **Previous**, the numbers, **Next**, each a 44 px `.btn`. The current page is `aria-current="page"`,
 * filled as a pressed choice, and not a link; a gap is `…` in a number's width, hidden from a screen
 * reader. Previous on the first page and Next on the last are `disabled`. Under 36em of the pager the
 * range takes its own line and the numbers give way to `Page 5 of 10`; under 22em the ways are their
 * chevrons, still named. In the build each number, Previous and Next is a link to `?page=n` (the list's
 * other query parts kept; `pageKey` names another key, as the Workspace's lists do, job 02 F300). A list of one
 * page has no pager: the list leaves it out.
 */
export interface PagerProps {
  page: number;
  pages: number;
  /** `26–50 of 240` (`pagerRange`). */
  range: string;
  /** The nav's name. */
  label?: string;
  /** The list's query parts other than the page, kept in each link. */
  query?: PagerQuery;
  /** The query key that holds this list's page: `page` (default) or `archived`. */
  pageKey?: PagerKey;
  /** Where page `n` is, when a list's address is not `?…&page=n`. */
  hrefFor?: (n: number) => string;
  /** Heard on a click of a number, Previous or Next, before the link goes. */
  onPage?: (n: number, event: MouseEvent<HTMLAnchorElement>) => void;
}

export function Pager({
  page: pageIn,
  pages: pagesIn,
  range,
  label = PAGER.label,
  query,
  pageKey = "page",
  hrefFor,
  onPage,
}: PagerProps) {
  const { page, pages } = pagerPlace(pageIn, pagesIn);
  const ways = pagerWays(page, pages);
  const href = (n: number) =>
    hrefFor ? hrefFor(n) : pageHref(n, query, pageKey);
  const link = (n: number) => ({
    href: href(n),
    onClick: onPage
      ? (event: MouseEvent<HTMLAnchorElement>) => onPage(n, event)
      : undefined,
  });

  return (
    <nav className="pager" aria-label={label}>
      <div className="pager-row">
        <p className="meta pager-range">{range}</p>
        <div className="pager-ways">
          {ways.previous === null ? (
            <button
              type="button"
              className="btn pager-prev"
              aria-label={PAGER.previous}
              disabled
            >
              <span className="pager-way">{PAGER.previous}</span>
            </button>
          ) : (
            <Link
              className="btn pager-prev"
              aria-label={PAGER.previous}
              {...link(ways.previous)}
            >
              <span className="pager-way">{PAGER.previous}</span>
            </Link>
          )}
          {pagerSlots(page, pages).map((slot, i) =>
            slot === "gap" ? (
              <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">
                …
              </span>
            ) : slot === page ? (
              <button
                key={slot}
                type="button"
                className="btn pager-num"
                aria-current="page"
                aria-label={PAGER.page(slot)}
              >
                {slot}
              </button>
            ) : (
              <Link
                key={slot}
                className="btn pager-num"
                aria-label={PAGER.page(slot)}
                {...link(slot)}
              >
                {slot}
              </Link>
            ),
          )}
          <span className="pager-of">{PAGER.pageOf(page, pages)}</span>
          {ways.next === null ? (
            <button
              type="button"
              className="btn pager-next"
              aria-label={PAGER.next}
              disabled
            >
              <span className="pager-way">{PAGER.next}</span>
            </button>
          ) : (
            <Link
              className="btn pager-next"
              aria-label={PAGER.next}
              {...link(ways.next)}
            >
              <span className="pager-way">{PAGER.next}</span>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}
