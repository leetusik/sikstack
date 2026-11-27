"use client";

import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

import { actDone } from "@/content/feedback-state";
import {
  changeFeedbackState,
  deleteFeedback,
} from "@/lib/feedback/state-actions";
import { publishToast } from "@/sikstack/shell";

import { StateScope, type StateSend } from "../state/control";
import {
  stateAfter,
  type FeedbackStateRecord,
  type OrgRole,
} from "../state/model";

/**
 * The item page's state island (P91-v3): the shared `StateScope` on this one piece of feedback, its `send` the
 * list's two server actions (`@/lib/feedback/state-actions`). `./body.tsx` mounts it around the page, then fills the
 * state slot with `ItemStateLine` and the head's end with `ItemStateActs` inside it.
 *
 * - Resolve, Drop and Reopen post `POST /app/feedback/state {ids: [id], state, reason?}` and show the state the API
 *   stored (its `by` and `at`).
 * - Delete posts `POST /app/feedback/delete {ids: [id]}`; the page then goes back to the list it was opened from
 *   (`backHref`, the item address's `?from=`) with the toast the list's own Delete shows.
 * - A refusal throws, so the scope says it as signed: in the confirm for Drop and Delete, the toast for the others.
 */

type Actions = {
  change: typeof changeFeedbackState;
  remove: typeof deleteFeedback;
};

/** The scope's `send` for one piece of feedback, over the two actions (passed in by the tests). */
export function itemStateSend(
  id: string,
  { change, remove }: Actions = {
    change: changeFeedbackState,
    remove: deleteFeedback,
  },
): StateSend {
  return async (act, reason) => {
    if (act === "delete") {
      const answer = await remove([id]);
      if (!answer.ok) throw new Error(answer.reason);
      return "deleted";
    }
    // Drop, Resolve and Reopen leave Dropped, Resolved and Open: never Filed
    const to = stateAfter(act) as "dropped" | "resolved" | "open";
    const answer = await change([id], to, reason);
    if (!answer.ok) throw new Error(answer.reason);
    const stored = answer.states?.find((s) => s.id === id)?.state;
    if (!stored) throw new Error("failed");
    return stored;
  };
}

export function ItemStateScope({
  id,
  message,
  lang,
  initial,
  role,
  counted,
  timeZone,
  backHref,
  children,
}: {
  id: string;
  message: string;
  lang?: string;
  initial: FeedbackStateRecord;
  role: OrgRole;
  counted: { comments: number; files: number };
  timeZone?: string;
  /** The list this page was opened from: where Delete goes back to. */
  backHref: string;
  children: ReactNode;
}) {
  const router = useRouter();
  return (
    <StateScope
      id={id}
      message={message}
      lang={lang}
      initial={initial}
      role={role}
      counted={counted}
      format={timeZone ? { timeZone } : undefined}
      send={itemStateSend(id)}
      onDeleted={() => {
        publishToast(actDone("delete", 1));
        router.push(backHref);
      }}
      onFailed={publishToast}
    >
      {children}
    </StateScope>
  );
}
