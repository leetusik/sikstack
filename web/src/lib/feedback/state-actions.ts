"use server";

import { getSession } from "@/lib/session";
import { ApiError, sendJson } from "@/lib/knowledge/client";

import type { FeedbackActAnswer, FeedbackState } from "./types";

/**
 * The Feedback list's two writes (P91-v3), on the session as Add to agenda's is (`./agenda-actions.ts`), each all or
 * none on the server:
 *
 * - `changeFeedbackState`: `POST /app/feedback/state {ids, state, reason?}` (S1): Resolve, Reopen, and Drop with one
 *   optional reason for the whole selection (trimmed; a blank one is not sent, and only Drop sends one).
 * - `deleteFeedback`: `POST /app/feedback/delete {ids}` (S2), an owner's only.
 *
 * Neither throws: each answers `ok` with the ids, or why not from the API's status (404 an id outside the org, 403 a
 * member's Delete or a foreign org, 422 a bad body, anything else failed), so the list says it in the confirm or the
 * toast.
 *
 * NOTE: a `"use server"` module may export ONLY async functions.
 */

const why = (error: unknown): Extract<FeedbackActAnswer, { ok: false }> => {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 404) return { ok: false, reason: "not-found" };
  if (status === 403) return { ok: false, reason: "forbidden" };
  if (status === 422) return { ok: false, reason: "refused" };
  return { ok: false, reason: "failed" };
};

const idsOf = (ids: unknown): string[] =>
  Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];

export async function changeFeedbackState(
  ids: string[],
  state: "resolved" | "dropped" | "open",
  reason?: string,
): Promise<FeedbackActAnswer> {
  const token = await getSession();
  if (!token) return { ok: false, reason: "failed" };
  const said = state === "dropped" && typeof reason === "string" ? reason.trim() : "";
  const body: { ids: string[]; state: string; reason?: string } = { ids: idsOf(ids), state };
  if (said) body.reason = said;
  try {
    const read = await sendJson<{ states?: { id: string; state: FeedbackState }[] }>(
      "/app/feedback/state",
      "POST",
      body,
      { token },
    );
    return { ok: true, ids: (read.states ?? []).map((s) => s.id) };
  } catch (error) {
    return why(error);
  }
}

export async function deleteFeedback(ids: string[]): Promise<FeedbackActAnswer> {
  const token = await getSession();
  if (!token) return { ok: false, reason: "failed" };
  try {
    const read = await sendJson<{ deleted?: string[] }>(
      "/app/feedback/delete",
      "POST",
      { ids: idsOf(ids) },
      { token },
    );
    return { ok: true, ids: idsOf(read.deleted) };
  } catch (error) {
    return why(error);
  }
}
