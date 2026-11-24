import { THREAD } from "@/content/workspace/agenda-thread";

import type { AuthorName } from "./author-model";

/** An author on the agenda (P61-e9): the name, and an agent's `Agent` mark after it on the name's baseline. */
export function Author({ author }: { author: AuthorName }) {
  return (
    <span className="ws-author">
      <span className="strong">{author.name}</span>
      {author.agent ? <span className="badge">{THREAD.agent}</span> : null}
    </span>
  );
}
