import { ApiError } from "@/lib/knowledge/client";
import type { DeleteResult } from "@/sikstack/frame/delete-dialog";

/** Why a delete did not happen, as the delete dialog draws it. */
export type DeleteFailure = Exclude<DeleteResult, { ok: true }>["reason"];

/**
 * The API's answer to a delete (`DELETE /app/tenant`, `DELETE /app/projects/{id}`), as the dialog draws it: a 409's
 * `reason` (`name`, `tenant_one`, `install_feedback`, `tracked_path`), a 422 (no name) as the typed name, anything
 * else `failed` (the dialog's notice, the button ready again). A plain module, so both delete actions share it (a
 * `"use server"` file exports only actions; the dialog's own module is the client's).
 */
export function deleteRefusal(error: unknown): DeleteFailure {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      const reason = error.reason;
      if (reason === "name" || reason === "tenant_one" || reason === "install_feedback" || reason === "tracked_path") {
        return reason;
      }
    }
    if (error.status === 422) return "name";
  }
  return "failed";
}
