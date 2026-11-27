"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { requireIdentity } from "@/lib/auth-guards";
import { ApiError } from "@/lib/knowledge/client";
import { deleteOrg, stepDown } from "@/lib/knowledge/orgs";
import { asOrgId, clearedOrgCookieOptions, ORG_COOKIE, orgCookieOptions } from "@/lib/session";
import type { DeleteResult } from "@/sikstack/frame/delete-dialog";
import type { MembershipResult } from "@/sikstack/org/model";

import { deleteRefusal } from "./refusal";

/**
 * Org settings' own writes (P88-ms.S3's signed design) as SERVER ACTIONS, in the org pages' pattern
 * (`../orgs/actions.ts`): behind `requireIdentity()` (outside every `try`, so its redirect is never swallowed), the
 * token unsealed here and handed to the API, each answer mapped by the API's STATUS and `reason`, never its `detail`.
 * The rest of the page's writes (rename, Public URL, invites, Make owner, Remove, Leave) are the actions it had.
 *
 * - `deleteOrgAction`: Delete org's confirm. Deleted, the API answers the caller's first org after it, and the org
 *   cookie names that org (the switch route's cookie write, `/api/auth/org`); the page then moves to `/dashboard`
 *   (the dialog's `onDeleted`, `org-settings.tsx`), so the confirm's answer reaches the page and its toast shows.
 * - `stepDownAction`: Step down on the account's own row (`POST /app/members/{id}/member`); the members list is
 *   revalidated. The API's 409 `last_owner` is kept as the `reason` the toast words.
 */

export async function deleteOrgAction(typed: string): Promise<DeleteResult> {
  if (typeof typed !== "string" || typed.trim() === "") return { ok: false, reason: "name" };
  const { token } = await requireIdentity();
  let next: string | null;
  try {
    const { tenant } = await deleteOrg(token, typed.trim());
    next = asOrgId(tenant.id);
  } catch (error) {
    return { ok: false, reason: deleteRefusal(error) };
  }
  const jar = await cookies();
  if (next) jar.set(ORG_COOKIE, next, orgCookieOptions());
  else jar.set(ORG_COOKIE, "", clearedOrgCookieOptions());
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function stepDownAction(id: string): Promise<MembershipResult> {
  if (typeof id !== "string" || !asOrgId(id)) return { ok: false, reason: "failed" };
  const { token } = await requireIdentity();
  try {
    await stepDown(token, id);
  } catch (error) {
    const lastOwner = error instanceof ApiError && error.status === 409 && error.reason === "last_owner";
    return { ok: false, reason: lastOwner ? "last_owner" : "failed" };
  }
  revalidatePath("/settings");
  return { ok: true };
}
