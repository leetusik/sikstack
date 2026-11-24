import type { ReactNode } from "react";

import { WsProseBlock } from "@/sikstack/workspace/frame/prose";
import type { AgendaItem } from "@/lib/workspace/types";

/** An item's stored prose, each text drawn as its Markdown, by the text itself. */
export type ItemProse = Readonly<Record<string, ReactNode>>;

/**
 * The item's note, outcome and reason as the server draws them (`WsProseBlock`: lines and lists as written, frame.md F46, F80), for the client page
 * that cannot carry the Markdown renderer. Keyed by the text: a change still waiting shows its own text, which has
 * no entry, and is drawn plain until the next read draws it.
 *
 * P61-e9: each body of the item's thread too, a waiting note among them (D305).
 */
export function itemProse(
  item: Pick<AgendaItem, "note" | "outcome" | "reason" | "entries">,
): ItemProse {
  const out: Record<string, ReactNode> = {};
  for (const text of [
    item.note,
    item.outcome,
    item.reason,
    ...(item.entries ?? []).map((e) => e.body),
  ])
    if (text) out[text] = <WsProseBlock text={text} />;
  return out;
}
