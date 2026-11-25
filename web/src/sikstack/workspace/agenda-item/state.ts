/**
 * An agenda item's page, its state as one reducer (design job 02, round 02-agenda-and-links: `AgendaItem.dc.html`
 * and its head and form boards; frame.md F45, F81, F303). Pure: the client page dispatches what happened and
 * sends the writes itself; the Node tests drive the same reducer.
 *
 * - **One form at a time** in the slot under the head (Edit, Solve, Drop): it opens from the head, whose
 *   actions are then away, and closes only by its own Cancel or its send. The first field takes the focus.
 * - **Sending:** every head button is disabled; the busy one shows its pending label. A form's send that
 *   answers the title refusal puts it under the field (focus back on it); one the route refused or found no
 *   longer open (a 409) shows the route's line over the fields; one that got no answer shows F45's
 *   `Could not … Try again.`; the form stays open with what was typed.
 * - **A write that landed** is laid over the read (`optimistic.ts`) and waits for sync; the focus goes to Edit
 *   after a save, a Reopen or a Propose, to Reopen after a solve or a drop.
 * - **Delete asks first**; after it the page says Item deleted (`gone`), whatever the next read says.
 * - **Try again and Discard** on a refused change: the old entry closes, Try again's new one waits; the notice
 *   that held the pressed button is gone, so the focus goes to Edit (F303's rule for a finished action).
 * - **A change that takes the item from under the page** lands on a drawn state, never on Not found
 *   (`pageView`, `afterSend`):
 *   - Try again on a refused **add**: the route re-sends it under a new id, so the page shows that id, Waiting
 *     for sync, and the address follows it (keeping `?from=`);
 *   - Try again on a refused **delete**: Item deleted, and the Agenda opens, as after Delete;
 *   - Discard on a refused **add**: the next read decides. Holding the item no longer, it was the add's own row:
 *     Item deleted (the add's title), and the Agenda opens. Still holding an item under that id (the workspace
 *     made one; its refusal named it): that item stays, its mark gone. Until that read, the send stays busy.
 */

import { agendaItemHref, type WorkspaceList } from "@/lib/workspace/address";
import {
  discarded,
  EMPTY_OVERLAY,
  reconcile,
  retried,
  written,
  type Overlay,
} from "@/lib/workspace/optimistic";
import { titleError } from "@/lib/workspace/rules";
import type {
  AgendaItem,
  ChangeKind,
  InboxEntry,
  WriteAnswer,
} from "@/lib/workspace/types";

import { itemView, type ItemPageRead, type ItemView } from "./model";

export type FormKind = "edit" | "solve" | "drop";
export type FormPhase = "rest" | "sending" | "title-error" | "send-failed";
/** What is being sent: a form, one of the head's buttons, the confirm's Yes, or the refused notice's buttons. */
export type Busy =
  "form" | "propose" | "reopen" | "delete" | "retry" | "discard";
/** What takes the focus next: a head button, or the open form's first field. */
export type FocusKey =
  "edit" | "solve" | "drop" | "reopen" | "propose" | "delete" | "first";

export interface Draft {
  title: string;
  note: string;
  line: string;
}

export interface PageState {
  overlay: Overlay;
  form: FormKind | null;
  phase: FormPhase;
  /** The route's own line over the form (a refusal, a change no longer open); null for F45's sentence. */
  notice: string | null;
  /** The form's last send got no taking answer: its notice stays over the fields until the next send answers. */
  failed: boolean;
  draft: Draft;
  busy: Busy | null;
  /** The Delete confirm is open. */
  asking: boolean;
  /** Honoured once: `n` grows with each request. */
  focus: { on: FocusKey; n: number } | null;
  /** The title of the item this page deleted: the page says Item deleted. */
  gone: string | null;
  /** The kind of each entry this page wrote, for Try again's pending label. */
  kinds: Record<string, ChangeKind>;
  /** The id Try again re-sent a refused add under: the item the page now shows. */
  moved: string | null;
  /** A discarded add, until the next read says whether an item still holds its id (the title, for Item deleted). */
  discarding: { entry: InboxEntry; title: string } | null;
}

export const INITIAL: PageState = {
  overlay: EMPTY_OVERLAY,
  form: null,
  phase: "rest",
  notice: null,
  failed: false,
  draft: { title: "", note: "", line: "" },
  busy: null,
  asking: false,
  focus: null,
  gone: null,
  kinds: {},
  moved: null,
  discarding: null,
};

/** What a form sends, or null when its title is refused here first (the route's own check). */
export type FormSend =
  | { kind: "edit"; title: string; note: string }
  | { kind: "solve"; outcome: string }
  | { kind: "drop"; reason: string };

/**
 * The form's send: the title trimmed and the note trimmed (F45), the line trimmed; null on the title refusal. A note
 * the edit left as it was (`was`, the item's stored note) is sent untouched (D308): an edit of the title alone never
 * trims the note, so one that starts with an indented code block stays a code block.
 */
export function formSend(
  form: FormKind,
  draft: Draft,
  was: { note?: string | null } = {},
): FormSend | null {
  if (form === "edit") {
    if (titleError(draft.title) !== null) return null;
    const note =
      typeof was.note === "string" && draft.note === was.note
        ? draft.note
        : draft.note.trim();
    return { kind: "edit", title: draft.title.trim(), note };
  }
  return form === "solve"
    ? { kind: "solve", outcome: draft.line.trim() }
    : { kind: "drop", reason: draft.line.trim() };
}

export type PageEvent =
  /** A head button opens its form, with the item's values (Edit) or an empty line. */
  | { type: "open"; form: FormKind; item: Pick<AgendaItem, "title" | "note"> }
  | { type: "change"; field: keyof Draft; value: string }
  | { type: "cancel" }
  | { type: "submit" }
  /** Propose, Reopen, Yes delete, Try again or Discard was pressed. */
  | { type: "send"; busy: Exclude<Busy, "form"> }
  | { type: "ask" }
  | { type: "ask-cancel" }
  | {
      type: "answer";
      answer: WriteAnswer;
      timeZone: string;
      now?: number | Date;
      /** Try again: the refused entry it sent anew. */
      refusedEntry?: string;
      /** Delete, Try again and Discard: the item's title, for Item deleted. */
      title?: string;
    }
  /** A new read of the item, and the Workspace's sync instant it carried. */
  | { type: "read"; item: AgendaItem; synced?: string | null }
  /** An item change the Items panel wrote: the agenda waits until a read shows it taken (the read predicts the rest). */
  | {
      type: "written";
      entry: InboxEntry;
      timeZone: string;
      now?: number | Date;
    }
  /** A new read holds no item under the page's id. */
  | { type: "missing" };

function focusOn(state: PageState, on: FocusKey): PageState["focus"] {
  return { on, n: (state.focus?.n ?? 0) + 1 };
}

const AFTER: Record<Busy | FormKind, FocusKey | null> = {
  edit: "edit",
  solve: "reopen",
  drop: "reopen",
  form: null,
  propose: "edit",
  reopen: "edit",
  delete: null,
  retry: "edit",
  discard: "edit",
};

export function reduce(state: PageState, event: PageEvent): PageState {
  switch (event.type) {
    case "open":
      if (state.busy || state.form || state.gone) return state;
      return {
        ...state,
        form: event.form,
        phase: "rest",
        notice: null,
        failed: false,
        draft:
          event.form === "edit"
            ? { title: event.item.title ?? "", note: event.item.note, line: "" }
            : { title: "", note: "", line: "" },
        focus: focusOn(state, "first"),
      };
    case "change":
      if (state.phase === "sending") return state;
      return {
        ...state,
        draft: { ...state.draft, [event.field]: event.value },
        // a field error leaves when its field is edited (F22); a notice stays until the next send answers
        phase:
          event.field === "title" && state.phase === "title-error"
            ? "rest"
            : state.phase,
      };
    case "cancel":
      if (!state.form || state.phase === "sending") return state;
      return {
        ...state,
        form: null,
        phase: "rest",
        notice: null,
        failed: false,
        focus: focusOn(state, state.form),
      };
    case "submit": {
      if (!state.form || state.busy) return state;
      if (formSend(state.form, state.draft) === null)
        return {
          ...state,
          phase: "title-error",
          focus: focusOn(state, "first"),
        };
      return { ...state, phase: "sending", busy: "form" };
    }
    case "send":
      if (state.busy || state.gone) return state;
      return { ...state, busy: event.busy };
    case "ask":
      if (state.busy || state.form) return state;
      return { ...state, asking: true };
    case "ask-cancel":
      if (state.busy === "delete") return state;
      return { ...state, asking: false };
    case "answer":
      return answer(state, event);
    case "written":
      return {
        ...state,
        overlay: written(state.overlay, event.entry, event.timeZone, event.now),
        kinds: { ...state.kinds, [event.entry.id]: event.entry.kind },
      };
    case "read": {
      const held = state.discarding;
      // a read after Discard on a refused add still holds an item under its id: that item stays, its mark gone
      const overlay = held
        ? discarded(state.overlay, held.entry, true)
        : state.overlay;
      const next: PageState = {
        ...state,
        overlay: reconcile(overlay, {
          agenda: [event.item],
          synced: event.synced ?? null,
        }),
      };
      return held
        ? {
            ...next,
            busy: null,
            discarding: null,
            focus: focusOn(state, AFTER.discard as FocusKey),
          }
        : next;
    }
    case "missing": {
      // a read after Discard on a refused add holds nothing under its id: the add's own row is gone
      const held = state.discarding;
      if (!held) return state;
      return {
        ...state,
        overlay: discarded(state.overlay, held.entry),
        busy: null,
        discarding: null,
        gone: held.title,
      };
    }
  }
}

function answer(
  state: PageState,
  event: Extract<PageEvent, { type: "answer" }>,
): PageState {
  const busy = state.busy;
  if (!busy) return state;
  const a = event.answer;
  const idle = { ...state, busy: null };
  if (!a.ok) {
    if (busy !== "form") return idle;
    if (a.reason === "title")
      return {
        ...idle,
        phase: "title-error",
        notice: null,
        failed: false,
        focus: focusOn(state, "first"),
      };
    const line =
      (a.reason === "refused" ||
        a.reason === "closed" ||
        a.reason === "not-found") &&
      a.message
        ? a.message
        : null;
    return { ...idle, phase: "send-failed", notice: line, failed: true };
  }
  const kinds = { ...state.kinds, [a.entry.id]: a.entry.kind };
  if (busy === "discard" && a.entry.kind === "add") {
    // whether an item still holds the add's id is the next read's to say: the send stays busy until it does
    const title =
      typeof a.entry.fields.title === "string"
        ? a.entry.fields.title
        : (event.title ?? "");
    return { ...state, kinds, discarding: { entry: a.entry, title } };
  }
  let overlay: Overlay;
  if (busy === "discard") overlay = discarded(state.overlay, a.entry);
  else if (busy === "retry" && event.refusedEntry)
    overlay = retried(
      state.overlay,
      event.refusedEntry,
      a.entry,
      event.timeZone,
      event.now,
    );
  else overlay = written(state.overlay, a.entry, event.timeZone, event.now);
  // Try again on a refused add: the route re-minted it, and the page shows the new id
  const minted =
    busy === "retry" && a.entry.kind === "add"
      ? (a.entry.minted_id ?? a.item)
      : null;
  const next: PageState = {
    ...idle,
    overlay,
    kinds,
    moved: minted ?? state.moved,
  };
  // Try again on a refused delete: the item leaves, as after Delete
  if (busy === "retry" && a.entry.kind === "delete")
    return { ...next, gone: event.title ?? "" };
  if (busy === "form") {
    const form = state.form;
    return {
      ...next,
      form: null,
      phase: "rest",
      notice: null,
      failed: false,
      focus: form ? focusOn(state, AFTER[form] as FocusKey) : state.focus,
    };
  }
  if (busy === "delete")
    return { ...next, asking: false, gone: event.title ?? "" };
  const after = AFTER[busy];
  return after ? { ...next, focus: focusOn(state, after) } : next;
}

/** What the page draws: the item, Item deleted (with the title), or Not found (the project named when known). */
export type PageDraw =
  | { kind: "item"; view: ItemView }
  | { kind: "gone"; title: string }
  | { kind: "not-found"; projectName: string | null };

/**
 * What the page draws from its read and its state: an item this page took away is Item deleted, never Not found;
 * so is one whose delete waits for the sync (the read's `deleting`), on a reload or after a failed read.
 */
export function pageView(read: ItemPageRead, state: PageState): PageDraw {
  if (state.gone !== null) return { kind: "gone", title: state.gone };
  const ready = read.state === "ready" ? read : null;
  if (ready?.item.deleting && state.moved === null)
    return { kind: "gone", title: ready.item.title ?? ready.item.id };
  // a read after Discard on a refused add holds nothing under its id: the add's own row went with it
  if (!ready && state.discarding)
    return { kind: "gone", title: state.discarding.title };
  const view = itemView(
    ready,
    state.overlay,
    state.moved ?? ready?.item.id ?? null,
  );
  if (view) return { kind: "item", view };
  return {
    kind: "not-found",
    projectName: read.state === "not-found" ? read.projectName : null,
  };
}

/** Whether a read after Discard on a refused add holds nothing under its id: the page leaves for the Agenda. */
export function vanished(read: ItemPageRead, state: PageState): boolean {
  return read.state === "not-found" && state.discarding !== null;
}

/** Where the page goes once a head send or a notice's button is answered. */
export type AfterSend =
  | { go: "push"; href: string }
  | { go: "replace"; href: string; item: string }
  | { go: "refresh" };

/**
 * After a send: the Agenda opens after a Delete (or Try again on a refused delete); Try again on a refused add goes
 * to the id the route re-minted, keeping where the item was opened from; anything else reads the page again.
 */
export function afterSend(
  busy: Exclude<Busy, "form">,
  answer: WriteAnswer,
  at: {
    project: string;
    /** The id the page shows. */
    shown: string;
    from: WorkspaceList | null;
    /** The way back's address. */
    back: string;
  },
): AfterSend {
  if (!answer.ok) return { go: "refresh" };
  if (busy === "delete" || (busy === "retry" && answer.entry.kind === "delete"))
    return { go: "push", href: at.back };
  if (busy === "retry" && answer.entry.kind === "add") {
    const minted = answer.entry.minted_id ?? answer.item;
    if (minted && minted !== at.shown)
      return {
        go: "replace",
        href: agendaItemHref(at.project, minted, at.from),
        item: minted,
      };
  }
  return { go: "refresh" };
}
