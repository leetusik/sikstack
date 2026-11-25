/**
 * An agenda's items, as pure functions (P61-e9, then the agenda items phase; the read's `entries`, `ThreadEntry`):
 * what each item shows, what it offers, what the Split sends and what the note composer sends. No React and no I/O.
 *
 * - `threadView(entries, at)`: each item oldest first, as the read gives them (a waiting web note last): its ref
 *   (`A2-k5/xa01`, what the engine's commands take), its state (Open, Done, Dismissed; Deleted while its delete
 *   waits), who set it, its author (a person or an agent), its kind's word, its source (a piece of feedback is a
 *   link to it, on the kind's word, and the body's last line back to it is left out; the web says `Web`; a slice or
 *   a phase is its id), when (F2's `when`), its body, its mark (Waiting for sync, or the workspace's refusal) and
 *   its actions. While a change waits, the state is the one the read predicts.
 * - `itemActions(item)`: **Done, Dismiss, Delete** on an open item; **Reopen, Delete** on a done or dismissed one;
 *   none on one whose delete waits, or on a note not yet written (it has no file).
 * - `splitError(picked, files, title)`: why a Split would be refused here first, or null.
 * - `noteBody(text)`: what the composer sends, or null for nothing written.
 */
import { ENTRY_KIND, ITEM, SPLIT, THREAD } from "@/content/workspace/agenda-thread";
import { feedbackItemHref } from "@/lib/feedback/place";
import { titleError } from "@/lib/workspace/rules";
import type {
  EntryState,
  ItemChangeKind,
  ThreadEntry,
} from "@/lib/workspace/types";

import { authorOf, type AuthorName } from "../frame/author-model";
import { wsStatus, type WsStatusWord } from "../frame/status-model";

/** What an item offers. */
export type ItemAction = "done" | "dismiss" | "reopen" | "delete";

/** Each action's inbox kind. */
export const ITEM_KIND: Record<ItemAction, ItemChangeKind> = {
  done: "item-done",
  dismiss: "item-dismiss",
  reopen: "item-reopen",
  delete: "item-delete",
};

export interface EntrySource {
  text: string;
  href: string | null;
}

export interface EntryView {
  id: string;
  /** The full file name an item change sends; null for a note not yet written. */
  file: string | null;
  /** `A2-k5/xa01`; null for a note not yet written. */
  ref: string | null;
  state: EntryState;
  /** The state's word and class (`Deleted` while its delete waits). */
  status: WsStatusWord;
  /** Who set the state (done or dismissed), when known. */
  stateBy: AuthorName | null;
  /** Its delete waits for the sync. */
  deleting: boolean;
  actions: ItemAction[];
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
export function shownBody(e: Pick<ThreadEntry, "body" | "source">): string {
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

/** An item's state as stored or predicted; anything else reads open. */
export function entryState(raw: string | null | undefined): EntryState {
  return raw === "done" || raw === "dismissed" ? raw : "open";
}

/** What an item offers, in one order. */
export function itemActions(
  e: Pick<ThreadEntry, "file" | "deleting" | "state">,
): ItemAction[] {
  if (!e.file || e.deleting) return [];
  return entryState(e.state) === "open"
    ? ["done", "dismiss", "delete"]
    : ["reopen", "delete"];
}

export function threadView(
  entries: readonly ThreadEntry[],
  at: { project: string; when: (value: string | null) => string },
): EntryView[] {
  return entries.map((e) => {
    const sync = e.sync;
    const refused =
      sync !== null && typeof sync === "object" ? sync.refused : null;
    const state = entryState(e.state);
    const deleting = e.deleting === true;
    return {
      id: e.id,
      file: e.file ?? null,
      ref: e.ref ?? null,
      state,
      status: deleting
        ? { word: ITEM.deleting, cls: "status status-revoked" }
        : (wsStatus("entry", state) as WsStatusWord),
      stateBy: state === "open" ? null : authorOf(e.stateBy ?? null),
      deleting,
      actions: itemActions(e),
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

/** The items open now (a pending delete leaves the count), for the panel's count. */
export function openCount(items: readonly EntryView[]): number {
  return items.filter((e) => e.file && !e.deleting && e.state === "open")
    .length;
}

/**
 * Why a Split is refused here first (the route's own rules): no item picked, every item of the agenda picked (one
 * must stay), or a title the route would refuse. `files` are the agenda's items that can move.
 */
export function splitError(
  picked: readonly string[],
  files: readonly string[],
  title: string,
): { field: "items" | "title"; message: string } | null {
  const chosen = picked.filter((f) => files.includes(f));
  if (chosen.length === 0) return { field: "items", message: SPLIT.none };
  if (chosen.length >= files.length) return { field: "items", message: SPLIT.all };
  const error = titleError(title);
  return error ? { field: "title", message: error } : null;
}

/** What the composer sends: the note stripped, as the server stores it; null when nothing is written. */
export function noteBody(text: string): string | null {
  const body = text.trim();
  return body ? body : null;
}
