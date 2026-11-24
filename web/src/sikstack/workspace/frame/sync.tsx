"use client";

import { useEffect, useSyncExternalStore, useTransition } from "react";

import { WS_SYNC } from "@/content/workspace/frame";
import { cx } from "@/lib/cx";

import { NO_LINE, type WsSyncLine } from "./sync-model";

// -- Try again: the page reads again ------------------------------------------------------------

/** How many Try agains are reading the page again; while any is, every sync line on the page is its bar. */
let retrying = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isRetrying(): boolean {
  return retrying > 0;
}

/**
 * Marks a Try again reading the page; the returned function ends it (once). The sync line is the bar until every
 * mark has ended: the page the new read draws then shows the line it gives.
 */
export function markWsRetry(): () => void {
  retrying += 1;
  listeners.forEach((l) => l());
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    retrying -= 1;
    listeners.forEach((l) => l());
  };
}

/** Whether a Try again is reading the page now. */
export function useWsRetrying(): boolean {
  return useSyncExternalStore(subscribe, isRetrying, isRetrying);
}

/**
 * A Workspace page's Try again (F49): `run` sends the read again in a transition (`router.refresh()`, or an error
 * boundary's `boundaryRetry`) and `pending` holds until the new page is drawn; meanwhile the page's sync line is
 * the bar, as while the page loads (F40), on every Workspace page and in every failed state.
 */
export function useWsRetry(): [
  pending: boolean,
  run: (read: () => void) => void,
] {
  const [pending, startTransition] = useTransition();
  useEffect(() => (pending ? markWsRetry() : undefined), [pending]);
  return [pending, (read) => startTransition(read)];
}

// -- the line ----------------------------------------------------------------------------------

/**
 * The sync line (frame.md F40, `WsSync.dc.html`), 12 px at the right end of a Workspace page's first row: the
 * state in its shape and the workspace's version (`Workspace v97` to a screen reader); behind, the words in ink.
 * While the page loads, or a Try again reads it again, a skeleton bar.
 */
export function WsSync({
  line,
  loading = false,
}: {
  line: WsSyncLine;
  loading?: boolean;
}) {
  const bar = useWsRetrying() || loading;
  return (
    <p
      className={cx("sync", !bar && line.state !== "fresh" && "is-behind")}
      aria-busy={bar ? true : undefined}
    >
      {bar ? (
        <>
          <span className="skel" style={{ width: "9em" }} />
          <span className="sr-only">{WS_SYNC.loading}</span>
        </>
      ) : (
        <>
          <span className={line.cls}>{line.text}</span>
          {line.version ? (
            <span>
              <span className="sr-only">{WS_SYNC.versionLabel}</span>
              {line.version}
            </span>
          ) : null}
        </>
      )}
    </p>
  );
}

/**
 * Where a failed state draws no sync line (the read that carries it failed too): nothing, but the bar while a
 * Try again reads the page again, as the page's loading form draws it.
 */
export function WsRetrySync() {
  return useWsRetrying() ? <WsSync line={NO_LINE} loading /> : null;
}
