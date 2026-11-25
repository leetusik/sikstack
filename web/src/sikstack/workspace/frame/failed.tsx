"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { StateBlock } from "@/sikstack/states";

import { BackRow } from "./item-head";
import { wsErrorState, type WsBack } from "./states-model";
import { useWsRetry, WsRetrySync } from "./sync";
import type { WsSyncLine } from "./sync-model";

/**
 * An item page that did not load (frame.md F49, F84; F5's app error), one drawing for the phase, the slice, the
 * agenda and the doc: the back row with the sync line when the workspace answered (its bar
 * while Try again reads the page again, F40; unknown, the way back alone and the bar while it reads), then
 * **This page did not load**, F5's sentence, **Try again** (primary) and the item's own way back, and the
 * reference when the error has a digest (the route's boundary; a read that failed has none).
 *
 * Try again renders the route again on the server: a boundary's own retry (`retry`, `boundaryRetry`), else
 * `router.refresh()`. `whileRetrying` is what the page draws meanwhile (a phase draws its Loading); without it the
 * block stands and only the line is the bar. Inside a boundary (`retry` given) the way back is a plain `a`, a whole
 * page load, as `StateBlock`'s links are there.
 */
export function WsItemFailed({
  back,
  backLabel,
  line,
  digest = null,
  retry,
  whileRetrying,
}: {
  back: WsBack;
  /** The back link's accessible name when its text is not its whole name (a slice's reads the phase's id). */
  backLabel?: string;
  /** The sync line; null when the workspace did not answer either. */
  line: WsSyncLine | null;
  digest?: string | null;
  retry?: () => void;
  whileRetrying?: ReactNode;
}) {
  const router = useRouter();
  const [pending, run] = useWsRetry();
  if (pending && whileRetrying !== undefined) return <>{whileRetrying}</>;
  const boundary = retry !== undefined;
  return (
    <div className="column">
      <header className="page-top">
        {line ? (
          <BackRow {...back} ariaLabel={backLabel} line={line} />
        ) : (
          <div className="ws-top">
            {boundary ? (
              <a className="back" href={back.href} aria-label={backLabel}>
                {back.label}
              </a>
            ) : (
              <Link className="back" href={back.href} aria-label={backLabel}>
                {back.label}
              </Link>
            )}
            <WsRetrySync />
          </div>
        )}
        <StateBlock
          state={wsErrorState(back, digest)}
          onRetry={() => run(retry ?? (() => router.refresh()))}
        />
      </header>
    </div>
  );
}
