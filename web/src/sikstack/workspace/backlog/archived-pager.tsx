"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { useRouter } from "next/navigation";

import { Pager } from "@/sikstack/library/pager";

import { archivedHref } from "./model";

/**
 * The Archived phases panel's pager (F300, F304): the product's one pager, its links `?archived=N`. A page asked for
 * from it keeps the operator on the panel, as the Agenda's Deferred part does: the page
 * stays where it is while the next page is read, then the panel's head comes to the top. A modified click (a new
 * tab, a new window) is the link's own.
 */
export function ArchivedPager({
  project,
  page,
  pages,
  range,
  label,
}: {
  project: string;
  page: number;
  pages: number;
  range: string;
  label: string;
}) {
  const router = useRouter();
  const here = useRef<HTMLDivElement>(null);
  const paged = useRef(false);
  useEffect(() => {
    if (!paged.current) return;
    paged.current = false;
    here.current?.closest("section")?.scrollIntoView({ block: "start" });
  }, [page]);
  const onPage = (n: number, event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    paged.current = true;
    router.push(archivedHref(project, n), { scroll: false });
  };
  return (
    <div ref={here}>
      <Pager
        page={page}
        pages={pages}
        range={range}
        label={label}
        pageKey="archived"
        hrefFor={(n) => archivedHref(project, n)}
        onPage={onPage}
      />
    </div>
  );
}
