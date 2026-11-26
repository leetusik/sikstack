"use server";

import { ApiError, sendJson } from "@/lib/knowledge/client";
import { getSession } from "@/lib/session";

import { asShareTarget, isShareState, sharePath, shareChangeRefusal, type ItemShare, type ShareChange } from "./model";

/**
 * Set one item's sharing from the reader's switch: `PUT /app/documents/{id}/share` or
 * `PUT /app/books/{project}/{book}/share` `{state}` → `{share}`. Session-only (a member's own item). Every answer
 * is data, never a throw (`shareChangeRefusal`), like the design builds' share action.
 *
 * NOTE: a `"use server"` module may export ONLY async functions; the types are in `model.ts`.
 */
export async function setItemShare(target: unknown, state: unknown): Promise<ShareChange> {
  const t = asShareTarget(target);
  if (!t || !isShareState(state)) return shareChangeRefusal(404);
  const token = await getSession();
  if (!token) return shareChangeRefusal(401);
  try {
    const answer = await sendJson<{ share?: ItemShare }>(sharePath(t), "PUT", { state }, { token });
    if (!answer?.share) return shareChangeRefusal(null);
    return { ok: true, share: answer.share };
  } catch (error) {
    return shareChangeRefusal(error instanceof ApiError ? error.status : null);
  }
}
