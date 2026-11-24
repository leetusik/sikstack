/**
 * An agenda item's thread, as pure functions (P61-e9; the read's `entries`, `ThreadEntry`): what each entry shows
 * and what the note composer sends. No React and no I/O.
 *
 * - `threadView(entries, at)`: each entry oldest first, as the read gives them (a waiting web entry last): its
 *   author (a person or an agent), its kind's word, its source (a piece of feedback is a link to it, on the kind's
 *   word, and the body's last line back to it is left out; the web says `Web`; a slice or a phase is its id), when
 *   (F2's `when`), its body, and its mark (Waiting for sync, or the workspace's refusal).
 * - `noteBody(text)`: what the composer sends, or null for nothing written.
 */
import { ENTRY_KIND, THREAD } from "@/content/workspace/agenda-thread";
import { feedbackItemHref } from "@/lib/feedback/place";
import type { ThreadEntry } from "@/lib/workspace/types";

import { authorOf, type AuthorName } from "../frame/author-model";

export interface EntrySource {
  text: string;
  href: string | null;
}

export interface EntryView {
  id: string;
  author: AuthorName | null;
  /** `Note`, `Issue`, … (the stored kind as written when the engine adds one this does not know). */
  kind: string;
  source: EntrySource | null;
  /** `2m ago`, `Nov 13`; `''` without a time. */
  when: string;
  iso: string | null;
  body: string;
  mark: "waiting" | "refused" | null;
  /** The workspace's line when it refused the entry. */
  refused: string | null;
}

/** A source as the thread says it: `web:agenda` → Web; `feedback:<id>` → Feedback, its page; `slice:P7-k2.S1` → the id. */
export function entrySource(
  source: string | null,
  project: string,
): EntrySource | null {
  if (!source) return null;
  const at = source.indexOf(":");
  const kind = at > 0 ? source.slice(0, at) : "";
  const ref = at > 0 ? source.slice(at + 1) : source;
  if (kind === "web") return { text: THREAD.source.web, href: null };
  if (kind === "feedback" && ref)
    return {
      text: THREAD.source.feedback,
      href: feedbackItemHref(project, ref),
    };
  if (kind === "deferred" && ref)
    return { text: THREAD.source.job(ref), href: null };
  return { text: ref || source, href: null };
}

/**
 * The body as the thread shows it: a piece of feedback's entry ends on the way back to it (`/feedback/<id>`, as the
 * server writes it), which the entry's kind already links, so that last line is left out.
 */
function shownBody(e: ThreadEntry): string {
  const ref = e.source?.startsWith("feedback:")
    ? e.source.slice("feedback:".length)
    : null;
  if (!ref) return e.body;
  const tail = `/feedback/${ref}`;
  const body = e.body.trimEnd();
  return body.endsWith(tail)
    ? body.slice(0, -tail.length).trimEnd() || body
    : e.body;
}

export function threadView(
  entries: readonly ThreadEntry[],
  at: { project: string; when: (value: string | null) => string },
): EntryView[] {
  return entries.map((e) => {
    const sync = e.sync;
    const refused =
      sync !== null && typeof sync === "object" ? sync.refused : null;
    return {
      id: e.id,
      author: authorOf(e.author),
      kind: (e.kind && ENTRY_KIND[e.kind]) ?? e.kind ?? "",
      source: entrySource(e.source, at.project),
      when: e.created ? at.when(e.created) : "",
      iso: e.created,
      body: shownBody(e),
      mark:
        sync === "waiting" ? "waiting" : refused !== null ? "refused" : null,
      refused,
    };
  });
}

/** The server's bound on an entry's body (`_MAX_TEXT`): a longer one is refused with its line. */
export const NOTE_MAX = 20_000;

/** What the composer sends: the note stripped, as the server stores it; null when nothing is written. */
export function noteBody(text: string): string | null {
  const body = text.trim();
  return body ? body : null;
}
