/** An item's sharing state (`server/sharing.py`). */
export type ShareState = "members" | "link" | "public";

export const SHARE_STATES: readonly ShareState[] = ["members", "link", "public"];

/**
 * A member's view of an item's sharing, as the API answers it on the document and book reads (`share`, null for
 * anyone else): the state, whether it is the document's own or its book's (`kind`), the live link's URL, and
 * whether this reader may make it Public (`can_publish`: the org owner's act; Link and Members are any member's).
 */
export interface ItemShare {
  state: ShareState;
  kind: "doc" | "book";
  url: string | null;
  /** Absent on an older API's answer: read as may publish, and the API still refuses a member's Public. */
  can_publish?: boolean;
}

/** May this reader press `state` on the switch? Public is the owner's; Link and Members are any member's. */
export function mayChooseShare(share: ItemShare, state: ShareState): boolean {
  return state !== "public" || share.can_publish !== false;
}

/** Which item a share change names: a document by its id (a chapter's sets its book's), or a book. */
export type ShareTarget =
  | { kind: "doc"; docId: number }
  | { kind: "book"; project: string; book: string };

/** What a share change answered, as the switch draws it. */
export type ShareChange =
  | { ok: true; share: ItemShare }
  | { ok: false; reason: "not-found" | "signed-out" | "owner-only" | "failed" };

export function isShareState(value: unknown): value is ShareState {
  return value === "members" || value === "link" || value === "public";
}

/**
 * The API's refusal of a share change, mapped: 404 an item gone or not the caller's, 401 the session's, 403 a
 * member's Public (only the org's owner publishes).
 */
export function shareChangeRefusal(status: number | null): ShareChange {
  if (status === 404) return { ok: false, reason: "not-found" };
  if (status === 401) return { ok: false, reason: "signed-out" };
  if (status === 403) return { ok: false, reason: "owner-only" };
  return { ok: false, reason: "failed" };
}

/** The API path of a share change. */
export function sharePath(target: ShareTarget): string {
  const e = encodeURIComponent;
  return target.kind === "doc"
    ? `/app/documents/${target.docId}/share`
    : `/app/books/${e(target.project)}/${e(target.book)}/share`;
}

/** A well-formed share-change target, or null (a server action takes nothing on trust). */
export function asShareTarget(value: unknown): ShareTarget | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "doc" && typeof v.docId === "number" && Number.isInteger(v.docId) && v.docId > 0)
    return { kind: "doc", docId: v.docId };
  if (
    v.kind === "book" &&
    typeof v.project === "string" &&
    typeof v.book === "string" &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(v.project) &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(v.book)
  )
    return { kind: "book", project: v.project, book: v.book };
  return null;
}
