import type { DesignBuild } from "@/sikstack/design/model";

/** What a share change answered, as the viewer draws it. */
export type ShareAnswer =
  | { ok: true; build: DesignBuild }
  | { ok: false; reason: "private" | "not-found" | "signed-out" | "failed" };

/**
 * The API's refusal of a share change, mapped (`POST …/builds/{id}/share`): 409 is a build made from a
 * private recording (its one line is the viewer's), 404 a build or project gone, 401 the session's;
 * anything else, or no status at all, failed.
 */
export function shareRefusal(status: number | null): ShareAnswer {
  switch (status) {
    case 409:
      return { ok: false, reason: "private" };
    case 404:
      return { ok: false, reason: "not-found" };
    case 401:
      return { ok: false, reason: "signed-out" };
    default:
      return { ok: false, reason: "failed" };
  }
}
