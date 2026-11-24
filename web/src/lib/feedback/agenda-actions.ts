"use server";

import { getSession } from "@/lib/session";
import { sendJson } from "@/lib/knowledge/client";

import { sent, type AgendaItem } from "./agenda";
import { getFeedbackAgenda } from "./app";
import type { FeedbackFiled } from "./types";

/**
 * Add to agenda's one write (P61-e9): files a piece of feedback on its project's agenda, on a new item (`{}`: the
 * server mints its id and writes the add and the `feedback` entry) or on an item already there (`{item}`: the entry
 * alone), through `POST /app/feedback/{id}/agenda`; then answers every item the feedback is on now
 * (`GET …/agenda`), each waiting for the sync until the workspace takes it. Any failure throws: the confirm then
 * reads its failed notice (a 409, the same feedback twice on one item, among them).
 *
 * NOTE: a `"use server"` module may export ONLY async functions.
 */
export async function fileAgendaItem(
  feedbackId: string,
  pick: { kind: "new" } | { kind: "item"; id: string },
): Promise<AgendaItem[]> {
  const token = await getSession();
  if (!token) throw new Error("signed out");
  const path = `/app/feedback/${encodeURIComponent(feedbackId)}/agenda`;
  const body =
    pick?.kind === "item" && typeof pick.id === "string"
      ? { item: pick.id }
      : {};
  await sendJson<FeedbackFiled>(path, "POST", body, { token });
  const agenda = await getFeedbackAgenda(token, feedbackId);
  return sent({ project_id: agenda.project }, agenda);
}
