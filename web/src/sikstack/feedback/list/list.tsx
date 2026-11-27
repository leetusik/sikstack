"use client";

import type { MouseEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { actDone, actFailed } from "@/content/feedback-state";
import { publishToast } from "@/sikstack/shell";
import {
  feedbackChangeHref,
  feedbackListHref,
  feedbackPageHref,
  type FeedbackChange,
  type FeedbackPlace,
} from "@/lib/feedback/place";
import {
  changeFeedbackState,
  deleteFeedback,
} from "@/lib/feedback/state-actions";
import type { FeedbackActAnswer } from "@/lib/feedback/types";

import type { ListPhase } from "./model";
import { FeedbackListView, type FeedbackListViewProps } from "./view";
import {
  shortTitle,
  stateAfter,
  toggleAll,
  toggleRow,
  type FeedbackAct,
  type StateAsk,
  type StateCounts,
} from "../state/model";

/** What the server read: everything but where a request is and what is picked. */
export type FeedbackListProps = Omit<
  FeedbackListViewProps,
  | "phase"
  | "pending"
  | "ticked"
  | "busy"
  | "ask"
  | "onSearch"
  | "onProject"
  | "onRating"
  | "onState"
  | "onClear"
  | "onPage"
  | "onRetry"
  | "onTick"
  | "onTickAll"
  | "onClearPicks"
  | "onAct"
  | "onReason"
  | "onCancelAsk"
  | "onConfirmAsk"
> & {
  /** The list did not load. */
  failed: boolean;
};

type Held = Pick<FeedbackListProps, "rows" | "total" | "place">;

type Asked = {
  phase: "loading" | "searching" | "paging";
  page: number | null;
  /**
   * The place asked for, drawn at once while the request is out, as the board does: the search, the
   * project and the rating as sent (so Clear shows as soon as one is set), or on Clear the field empty,
   * Any rating pressed and Clear gone. The bar's field and select take a new value in place (no redraw),
   * so focus stays where it was.
   */
  shown?: Partial<FeedbackPlace>;
};

/**
 * What an action took off the screen, for the rows it was taken from: those rows leave the state on screen at once
 * and the counts move with them, until the server's new read (a new `rows`) replaces them.
 */
type Gone = {
  rows: FeedbackListProps["rows"];
  ids: readonly string[];
  act: FeedbackAct;
};

/** Clear's place, drawn at once (`page` stays until the rows land). */
const CLEARED = { q: "", project: null, rating: null } as const;

const NO_COUNTS: StateCounts = { open: 0, filed: 0, resolved: 0, dropped: 0 };

/** A click the browser should keep (a new tab, a download): never taken over. */
const ownClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button !== 0 ||
  event.metaKey ||
  event.ctrlKey ||
  event.shiftKey ||
  event.altKey;

/** The counts with `n` rows moved out of `from` by `act` (into its state; Delete moves them nowhere). */
function movedCounts(
  counts: StateCounts,
  from: keyof StateCounts,
  act: FeedbackAct,
  n: number,
): StateCounts {
  const next = { ...counts, [from]: Math.max(0, counts[from] - n) };
  if (act !== "delete") next[stateAfter(act)] += n;
  return next;
}

/**
 * The list's client island (`result.md` § The list, *Wiring*; F141, F340): every way through the list is
 * an App Router navigation to its address (S3's place), in one transition.
 *
 * - **A newer request replaces one in flight**: each is a `router.push` in a transition. The router
 *   still commits an overtaken navigation when its answer comes first (seen in P65-nh.S9: two quick page
 *   clicks drew the first page's rows for a moment), so while a page is asked for the island keeps
 *   drawing the rows, total and place it had when the first request left (`held`), and only the newest
 *   answer, once the transition ends, replaces them.
 * - **Search, a filter, the state filter, Clear**: the rows become skeleton rows and the count a bar until
 *   it lands (`searching`); the bar stays usable and shows what was asked at once (`Asked.shown`). A state
 *   change keeps the search and filters (the counts it shows are under them); Clear keeps the state.
 * - **A page**: the page asked for is marked current at once, the rows on screen stay with the panel
 *   `aria-busy` until it lands (`paging`), then the window goes to its top.
 * - **Try again** reads the page again on the server (`router.refresh()`): the page's loading state
 *   (`loading`, the bar disabled), then the list or this block again.
 * - **Acting on picked rows** (P91-v3): Resolve and Reopen send at once, the count saying so; Drop and
 *   Delete ask first, in the confirm. Sent, the rows leave the state on screen, the counts move with them,
 *   a toast says what was done, and the page is read again (the page before when every row on a later
 *   page went). A refusal or no answer is said in the confirm, or in a toast for an act at once.
 */
export function FeedbackList({ failed, ...data }: FeedbackListProps) {
  const router = useRouter();
  const [inFlight, start] = useTransition();
  const [, startRead] = useTransition();
  const [asked, setAsked] = useState<Asked | null>(null);
  /** What was on screen when the first request of this transition left: drawn while a page loads. */
  const [held, setHeld] = useState<Held | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<FeedbackAct | null>(null);
  const [ask, setAsk] = useState<StateAsk | null>(null);
  const [gone, setGone] = useState<Gone | null>(null);
  const toTop = useRef(false);
  const { scope, place } = data;
  const counts = data.counts ?? NO_COUNTS;

  useEffect(() => {
    if (inFlight || !toTop.current) return;
    toTop.current = false;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [inFlight, place.page]);

  const go = (href: string, next: Asked) => {
    toTop.current = next.phase === "paging";
    setAsked(next);
    setTicked([]);
    setHeld((h) =>
      inFlight && h ? h : { rows: data.rows, total: data.total, place },
    );
    start(() => {
      router.push(href, { scroll: false });
    });
  };
  const change = (to: FeedbackChange) =>
    go(feedbackChangeHref(scope, place, to), {
      phase: "searching",
      page: null,
      shown: to,
    });

  /** The rows this action took off the screen, still drawn by the read they came from. */
  const out = gone && gone.rows === data.rows ? gone : null;
  const outIds = new Set(out?.ids ?? []);
  const rows = out ? data.rows.filter((r) => !outIds.has(r.id)) : data.rows;
  const shownCounts = out
    ? movedCounts(counts, place.state, out.act, outIds.size)
    : counts;
  const total = out ? Math.max(0, data.total - outIds.size) : data.total;

  /** An action answered: what was done, or the failure said where the view says it. */
  const answered = (act: FeedbackAct, ids: string[], answer: FeedbackActAnswer) => {
    if (!answer.ok) return false;
    const n = ids.length;
    setGone({ rows: data.rows, ids, act });
    setTicked([]);
    publishToast(actDone(act, n));
    const emptied = rows.every((r) => ids.includes(r.id));
    startRead(() => {
      if (emptied && place.page > 1)
        router.push(feedbackPageHref(scope, place, place.page - 1), {
          scroll: false,
        });
      else router.refresh();
    });
    return true;
  };

  const send = (
    act: FeedbackAct,
    ids: string[],
    reason?: string,
  ): Promise<FeedbackActAnswer> =>
    (act === "delete"
      ? deleteFeedback(ids)
      : changeFeedbackState(
          ids,
          act === "drop" ? "dropped" : act === "resolve" ? "resolved" : "open",
          reason,
        )
    ).catch(() => ({ ok: false, reason: "failed" }) as const);

  const phase: ListPhase =
    inFlight && asked ? asked.phase : failed ? "failed" : "ready";

  return (
    <FeedbackListView
      {...data}
      rows={rows}
      total={total}
      counts={shownCounts}
      {...(phase === "paging" && held ? held : null)}
      {...(phase === "searching" && asked?.shown
        ? { place: { ...place, ...asked.shown } }
        : null)}
      phase={phase}
      pending={phase === "paging" ? (asked?.page ?? null) : null}
      ticked={ticked}
      busy={busy}
      ask={ask}
      onSearch={(q) => change({ q: q.trim() })}
      onProject={(project, q) => change({ project, q: q.trim() })}
      onRating={(rating, q) => change({ rating, q: q.trim() })}
      onState={(state, event) => {
        if (ownClick(event)) return;
        event.preventDefault();
        change({ state });
      }}
      onClear={(event) => {
        if (ownClick(event)) return;
        event.preventDefault();
        go(feedbackListHref(scope, { state: place.state }), {
          phase: "searching",
          page: null,
          shown: CLEARED,
        });
      }}
      onPage={(n, event) => {
        if (ownClick(event)) return;
        event.preventDefault();
        go(feedbackPageHref(scope, place, n), { phase: "paging", page: n });
      }}
      onRetry={() => {
        toTop.current = false;
        setAsked({ phase: "loading", page: null });
        start(() => {
          router.refresh();
        });
      }}
      onTick={(id) => setTicked((t) => toggleRow(t, id))}
      onTickAll={(pick) => setTicked(toggleAll(pick))}
      onClearPicks={() => setTicked([])}
      onAct={(act, ids) => {
        if (busy !== null || ask !== null || ids.length === 0) return;
        if (act === "drop" || act === "delete") {
          const first = rows.find((r) => r.id === ids[0]);
          setAsk({
            act,
            ids,
            title: shortTitle(first?.message ?? ""),
            lang: first?.lang,
            reason: "",
            busy: false,
            notice: null,
          });
          return;
        }
        setBusy(act);
        void send(act, ids).then((answer) => {
          setBusy(null);
          if (!answered(act, ids, answer))
            publishToast(actFailed(act, ids.length));
        });
      }}
      onReason={(reason) => setAsk((a) => (a ? { ...a, reason } : a))}
      onCancelAsk={() => setAsk((a) => (a && !a.busy ? null : a))}
      onConfirmAsk={() => {
        if (!ask || ask.busy) return;
        const sent = ask;
        setAsk({ ...sent, busy: true, notice: null });
        void send(sent.act, sent.ids, sent.reason).then((answer) => {
          if (answered(sent.act, sent.ids, answer)) setAsk(null);
          else
            setAsk({
              ...sent,
              busy: false,
              notice: actFailed(sent.act, sent.ids.length),
            });
        });
      }}
    />
  );
}
