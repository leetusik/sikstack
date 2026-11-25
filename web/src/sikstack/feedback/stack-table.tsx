import type { ReactNode, TableHTMLAttributes } from "react";
import Link from "next/link";

import { cx } from "@/lib/cx";

/**
 * A table that stacks (`Stack.dc.html`, frame.md F130, F139): `div.table-scroll.table-stack >
 * table.table`. Under 48em of its own width each row is its main cell (`td.has-control.is-main`), then
 * its other cells on one line in the second ink, the `td.to-end` cell at the line's end; the column
 * heads stay for a screen reader. `set` (`.stack-set`) sets the columns, never sized by what the rows
 * hold: the list's heads take `.stack-rating`, `.stack-project`, `.stack-product`, `.stack-when`, a cell
 * whose value may run long `.stack-wrap`, and its message stops at 56ch (F140). `capped` (P78): the system
 * table's long form, scrolling inside itself under its kept header (`.is-capped`) while it does not stack.
 */
export interface StackTableProps extends TableHTMLAttributes<HTMLTableElement> {
  set?: boolean;
  capped?: boolean;
}

export function StackTable({
  set = false,
  capped = false,
  className,
  ...rest
}: StackTableProps) {
  return (
    <div className={cx("table-scroll table-stack", capped && "is-capped")}>
      <table {...rest} className={cx("table", set && "stack-set", className)} />
    </div>
  );
}

/**
 * A cell's column name, seen only while its table stacks (P78, F14): a count or a date that needs its column's name
 * to read on the stacked line. Hidden from a screen reader, which keeps the column heads.
 */
export function StackLabel({ children }: { children: ReactNode }) {
  return (
    <span className="stack-label" aria-hidden="true">
      {children}{" "}
    </span>
  );
}

/**
 * A row's one link (frame.md F130): `a.link-strong` holding the text cut at two lines (`.clamp-2`),
 * 12 px over and under it, so one line is the 44 px target. The href is the caller's (the item's
 * address, with the way back the list's place gives).
 */
export function ClampLink({
  href,
  lang,
  prefetch,
  children,
}: {
  href: string;
  lang?: string;
  prefetch?: boolean;
  children: ReactNode;
}) {
  return (
    <Link className="link-strong" lang={lang} href={href} prefetch={prefetch}>
      <span className="clamp-2">{children}</span>
    </Link>
  );
}
