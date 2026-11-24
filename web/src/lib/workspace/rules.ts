/**
 * The agenda's early checks, the same ones the write routes make before an entry is written
 * (`server/workspace_web_api.py`), so a change the route would refuse is never sent: the forms show
 * the error at once, and the write actions answer it without a request.
 *
 * Each check's words are the route's own (the title's is the signed refusal, F45). Everything past
 * these checks is the engine's to refuse, at its next sync.
 *
 * Deliberately free of `server-only`: the actions and the client forms share it.
 */

import type { ChangeKind, EntryKind } from "./types";

/** The signed field error (F45), the route's refusal word for word. */
export const TITLE_REFUSAL = "Enter a title of 1–200 characters.";

/** A title's most characters (the engine's rule). */
export const TITLE_MAX = 200;
/** A note's, an outcome's or a reason's most characters, and a change's most items. */
export const TEXT_MAX = 20_000;
export const ITEMS_MAX = 1000;

/**
 * The engine's agenda id, word for word: a number and a two-symbol tail of lowercase Crockford
 * base32 without `i l o u`, at least one symbol a letter. Only a full id is ever sent.
 */
export const AGENDA_ID =
  /^A[0-9]+-(?:[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])$/;

/** An inbox entry's id (a UUID). */
export const ENTRY_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project's id (a UUID). */
export const PROJECT_ID = ENTRY_ID;

/** What Python's `str.splitlines` splits on: a title is one line by that rule. */
const LINE_BREAK = /[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/;

/** A title's length as the server counts it: code points, not UTF-16 units. */
function length(text: string): number {
  return Array.from(text).length;
}

/** The title as it is stored (trimmed), or null when the route would refuse it. */
export function cleanTitle(raw: unknown): string | null {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title || length(title) > TITLE_MAX || LINE_BREAK.test(title))
    return null;
  return title;
}

/** The field error for a title, or null when it passes. */
export function titleError(raw: unknown): string | null {
  return cleanTitle(raw) === null ? TITLE_REFUSAL : null;
}

/** A text field's error (a note, an outcome, a reason), in the route's words. */
export function textError(raw: unknown, name: string): string | null {
  return typeof raw === "string" && length(raw) <= TEXT_MAX
    ? null
    : `${name} must be text of at most ${TEXT_MAX} characters`;
}

/** An id's error, in the route's words. */
export function idError(raw: unknown): string | null {
  if (typeof raw === "string" && AGENDA_ID.test(raw)) return null;
  const shown =
    typeof raw === "string" && raw.length <= 40 ? raw : "that value";
  return `${shown} is not a full agenda id (like A7-m3)`;
}

/** A move's place: before or after another item. */
export type MovePlace = { before: string } | { after: string };

/** The fields each kind takes (an add has its own route). */
export type ChangeFields = {
  edit: { title?: string; note?: string };
  move: MovePlace;
  defer: Record<string, never>;
  solve: { outcome?: string };
  drop: { reason?: string };
  reopen: Record<string, never>;
  delete: Record<string, never>;
  /** One entry on the item's thread; the server adds its author and source. */
  entry: { kind: EntryKind; body: string };
  accept: Record<string, never>;
};

/** The entry kinds the server takes (the engine's `ENTRY_KINDS`). */
export const ENTRY_KINDS: readonly EntryKind[] = [
  "note",
  "issue",
  "feedback",
  "question",
  "decision",
];

/** One change, as the changes route takes it: `{kind, items, fields}`. */
export type Change = {
  [K in Exclude<ChangeKind, "add">]: {
    kind: K;
    items: string[];
    fields: ChangeFields[K];
  };
}[Exclude<ChangeKind, "add">];

/** An add, as its route takes it: `{title, note?}`. */
export interface AddInput {
  title: string;
  note?: string;
}

/**
 * The add's body, or the error the route would answer: the title trimmed, the note only when it
 * says something.
 */
export function addBody(
  input: AddInput,
):
  | { ok: true; body: { title: string; note?: string } }
  | { ok: false; error: string } {
  const title = cleanTitle(input.title);
  if (title === null) return { ok: false, error: TITLE_REFUSAL };
  const body: { title: string; note?: string } = { title };
  if (input.note !== undefined && input.note.trim() !== "") {
    const error = textError(input.note, "note");
    if (error) return { ok: false, error };
    body.note = input.note;
  }
  return { ok: true, body };
}

/**
 * The change's body as the route takes it, or the route's own error line: full ids, one item for
 * an edit or a move, the kind's own fields only, a title by the signed rule. Repeated ids are sent
 * once, in their first place.
 */
export function changeBody(
  change: Change,
): { ok: true; body: Change } | { ok: false; error: string } {
  const items = Array.isArray(change.items) ? change.items : [];
  if (items.length === 0) {
    return { ok: false, error: "items must list one or more agenda ids" };
  }
  if (items.length > ITEMS_MAX) {
    return { ok: false, error: `a change takes at most ${ITEMS_MAX} items` };
  }
  for (const id of items) {
    const error = idError(id);
    if (error) return { ok: false, error };
  }
  const ids = Array.from(new Set(items));
  if (
    (change.kind === "edit" ||
      change.kind === "move" ||
      change.kind === "entry") &&
    ids.length !== 1
  ) {
    return { ok: false, error: `${change.kind} takes exactly one item` };
  }
  switch (change.kind) {
    case "edit": {
      const fields: { title?: string; note?: string } = {};
      const raw = change.fields ?? {};
      if (raw.title === undefined && raw.note === undefined) {
        return { ok: false, error: "edit takes a title, a note or both" };
      }
      if (raw.title !== undefined) {
        const title = cleanTitle(raw.title);
        if (title === null) return { ok: false, error: TITLE_REFUSAL };
        fields.title = title;
      }
      if (raw.note !== undefined) {
        const error = textError(raw.note, "note");
        if (error) return { ok: false, error };
        fields.note = raw.note;
      }
      return { ok: true, body: { kind: "edit", items: ids, fields } };
    }
    case "move": {
      const raw = (change.fields ?? {}) as Partial<{
        before: string;
        after: string;
      }>;
      const places = (["before", "after"] as const).filter(
        (p) => raw[p] !== undefined,
      );
      if (places.length !== 1) {
        return {
          ok: false,
          error: "move takes exactly one of first, last, before or after",
        };
      }
      const place = places[0];
      const other = raw[place];
      const error = idError(other);
      if (error) return { ok: false, error };
      if (other === ids[0]) {
        return { ok: false, error: `an item cannot move ${place} itself` };
      }
      const fields = (
        place === "before" ? { before: other } : { after: other }
      ) as MovePlace;
      return { ok: true, body: { kind: "move", items: ids, fields } };
    }
    case "solve":
    case "drop": {
      const name = change.kind === "solve" ? "outcome" : "reason";
      const raw = (change.fields ?? {}) as Record<string, string | undefined>;
      const text = raw[name];
      const fields: Record<string, string> = {};
      if (text !== undefined && text.trim() !== "") {
        const error = textError(text, name);
        if (error) return { ok: false, error };
        fields[name] = text.trim();
      }
      return {
        ok: true,
        body: { kind: change.kind, items: ids, fields } as Change,
      };
    }
    case "entry": {
      // The route's checks: a known kind, a body with text, at most TEXT_MAX; it stores the body stripped.
      const raw = (change.fields ?? {}) as Partial<{
        kind: string;
        body: unknown;
      }>;
      if (!ENTRY_KINDS.includes(raw.kind as EntryKind)) {
        return {
          ok: false,
          error: `an entry's kind must be one of ${ENTRY_KINDS.join(", ")}`,
        };
      }
      const body = typeof raw.body === "string" ? raw.body.trim() : "";
      if (!body) return { ok: false, error: "an entry needs a body of text" };
      if (length(body) > TEXT_MAX)
        return {
          ok: false,
          error: `body must be text of at most ${TEXT_MAX} characters`,
        };
      return {
        ok: true,
        body: {
          kind: "entry",
          items: ids,
          fields: { kind: raw.kind as EntryKind, body },
        },
      };
    }
    case "defer":
    case "reopen":
    case "delete":
    case "accept":
      return { ok: true, body: { kind: change.kind, items: ids, fields: {} } };
    default:
      return {
        ok: false,
        error:
          "kind must be one of edit, move, defer, solve, drop, reopen, delete, entry, accept (an add has its own route)",
      };
  }
}
