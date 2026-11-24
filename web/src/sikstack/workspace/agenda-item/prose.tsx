import type { ReactNode } from "react";

import { WsProseBlock } from "@/sikstack/workspace/frame/prose";
import { Md } from "@/sikstack/workspace/md";
import type { AgendaItem } from "@/lib/workspace/types";

import { shownBody } from "./thread-model";

/** An item's stored prose, each text drawn as its Markdown, by the text itself. */
export type ItemProse = Readonly<Record<string, ReactNode>>;

/**
 * The item's note, outcome and reason, and each body of its thread, as the server draws them, for the client page
 * that cannot carry the Markdown renderer. Keyed by the text: a change still waiting shows its own text, which has
 * no entry, and is drawn plain until the next read draws it.
 *
 * - The outcome and the reason are a line or two: `WsProseBlock` (lines and lists as written, frame.md F46, F80).
 * - The note and each thread body (P61-e9) are whole texts, a folded job's brief among them: the Workspace's
 *   block renderer `Md` (headings, code, quotes, tables; an image from another host never loads, D310). The note
 *   sits under the page's `h1`, its headings from level 2; a body sits in Thread, under its `h2`, from level 3.
 *   A body is keyed as the thread shows it (`shownBody`: a feedback entry's way back left out), and a waiting
 *   note is in the read's thread, so it is drawn as a synced one is (D305). Each text gets its own ids.
 */
export function itemProse(
  item: Pick<AgendaItem, "note" | "outcome" | "reason" | "entries">,
): ItemProse {
  const out: Record<string, ReactNode> = {};
  const md = (text: string, level: number, anchor: string) => {
    if (text && !Object.hasOwn(out, text))
      out[text] = <Md source={text} level={level} anchor={anchor} />;
  };
  md(item.note, 2, "agendaitem-note");
  (item.entries ?? []).forEach((e, i) =>
    md(shownBody(e), 3, `thread-entry-${i + 1}`),
  );
  for (const text of [item.outcome, item.reason])
    if (text && !Object.hasOwn(out, text))
      out[text] = <WsProseBlock text={text} />;
  return out;
}
