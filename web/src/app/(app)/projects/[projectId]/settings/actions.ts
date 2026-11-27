"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireIdentity } from "@/lib/auth-guards";
import { deleteProject } from "@/lib/knowledge/app";
import type { DeleteResult } from "@/sikstack/frame/delete-dialog";

import { deleteRefusal } from "../../../settings/refusal";

/**
 * Project settings' own write (P88-ms.S3's signed design), a SERVER ACTION in the project pages' pattern
 * (`../actions.ts`, whose visibility, mint and revoke actions the page uses as project home did): behind
 * `requireIdentity()` (outside the `try`), the token handed to the API, the answer mapped by STATUS and `reason`.
 *
 * `deleteProjectAction`: Delete project's confirm (`DELETE /app/projects/{id}` with the typed name). Deleted, the
 * layout is revalidated (the Shell's project picker loses it) and the page moves to org home (the dialog's
 * `onDeleted`, `project-settings.tsx`), so the confirm's answer reaches the page and its toast shows.
 */
export async function deleteProjectAction(projectId: string, typed: string): Promise<DeleteResult> {
  const id = z.uuid().safeParse(projectId);
  if (!id.success) return { ok: false, reason: "failed" };
  if (typeof typed !== "string" || typed.trim() === "") return { ok: false, reason: "name" };
  const { token } = await requireIdentity();
  try {
    await deleteProject(token, id.data, typed.trim());
  } catch (error) {
    return { ok: false, reason: deleteRefusal(error) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
