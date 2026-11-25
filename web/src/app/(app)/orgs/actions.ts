"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireIdentity } from "@/lib/auth-guards";
import { ApiError } from "@/lib/knowledge/client";
import {
  createInvite,
  createOrg,
  leaveOrg,
  makeOwner,
  removeMember,
  renameOrg,
  revokeInvite,
} from "@/lib/knowledge/orgs";
import { asOrgId, clearedOrgCookieOptions, ORG_COOKIE, orgCookieOptions } from "@/lib/session";
import {
  checkOrgName,
  looksLikeEmail,
  type CreateOrgResult,
  type InviteResult,
  type MembershipRefusal,
} from "@/sikstack/org/model";

/**
 * The org pages' writes as SERVER ACTIONS (the app's rule for signed-in mutations, `dashboard/actions.ts`): behind
 * `requireIdentity()` (outside every `try`, so its redirect is never swallowed), Next's own action CSRF check, the
 * token unsealed here and handed to the API (`lib/knowledge/orgs.ts`), never to the browser. Each answers the plain
 * result the component draws, mapped by the API's STATUS and `reason`, never its `detail` text.
 *
 * - `createOrgAction`: New org. A created org is the active one: the org cookie is set to it (the switch route's
 *   cookie, `/api/auth/org`; the API just made the caller its owner), and the page lands on its home.
 * - `renameOrgAction`: the org home's Org name panel (owner only; the API refuses anyone else).
 * - `sendInviteAction`, `revokeInviteAction`: Members' Invites panel (owner only, the same).
 * - `makeOwnerAction`: Make owner on a member's row (owner only).
 * - `removeMemberAction`: Remove on a member's row (owner only); `leaveOrgAction`: Leave on a member's own row, or on
 *   an owner's when the org has another. A left org is no longer the caller's, so Leave clears the org cookie (the
 *   session acts in its first org again) and lands on that org's home, as the switch does. Neither ever ends an
 *   org's last owner nor an account's only org (the API's 409 `last_owner` and `last_org`, kept as the `reason`
 *   the page words its toast by).
 */

type RenameResult = { ok: true; name: string } | { ok: false; reason: "empty" | "taken" | "failed" };

export async function createOrgAction(name: string): Promise<CreateOrgResult> {
  if (typeof name !== "string" || !checkOrgName(name)) return { ok: false, reason: "empty" };
  const { token } = await requireIdentity();
  try {
    const { tenant } = await createOrg(token, name.trim());
    const id = asOrgId(tenant.id);
    if (id) (await cookies()).set(ORG_COOKIE, id, orgCookieOptions());
    revalidatePath("/", "layout");
    return { ok: true, id: tenant.id, name: tenant.name };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.reason === "taken") {
      return { ok: false, reason: "taken" };
    }
    if (error instanceof ApiError && error.status === 429) return { ok: false, reason: "limit" };
    if (error instanceof ApiError && error.status === 422) return { ok: false, reason: "empty" };
    return { ok: false, reason: "failed" };
  }
}

export async function renameOrgAction(name: string): Promise<RenameResult> {
  if (typeof name !== "string" || !checkOrgName(name)) return { ok: false, reason: "empty" };
  const { token } = await requireIdentity();
  try {
    const { tenant } = await renameOrg(token, name.trim());
    revalidatePath("/", "layout");
    return { ok: true, name: tenant.name };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.reason === "taken") {
      return { ok: false, reason: "taken" };
    }
    if (error instanceof ApiError && error.status === 422) return { ok: false, reason: "empty" };
    return { ok: false, reason: "failed" };
  }
}

export async function sendInviteAction(email: string): Promise<InviteResult> {
  if (typeof email !== "string" || !looksLikeEmail(email)) return { ok: false, reason: "address" };
  const { token } = await requireIdentity();
  try {
    const { invite } = await createInvite(token, email.trim());
    revalidatePath("/members");
    return {
      ok: true,
      invite: {
        id: invite.id,
        email: invite.email,
        invitedAt: invite.invited_at,
        expiresAt: invite.expires_at,
      },
    };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.reason === "address" || error.reason === "member" || error.reason === "invited") {
        return { ok: false, reason: error.reason };
      }
      if (error.status === 429) {
        return { ok: false, reason: error.reason === "recipient" ? "recipient" : "limit" };
      }
    }
    return { ok: false, reason: "failed" };
  }
}

export async function revokeInviteAction(id: string): Promise<{ ok: boolean }> {
  if (typeof id !== "string" || !asOrgId(id)) return { ok: false };
  const { token } = await requireIdentity();
  try {
    await revokeInvite(token, id);
    revalidatePath("/members");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** The API's 409 on a membership's end, by its `reason`; anything else is `failed`. */
function refusal(error: unknown): MembershipRefusal {
  if (error instanceof ApiError && error.status === 409) {
    if (error.reason === "last_owner" || error.reason === "last_org") return error.reason;
  }
  return "failed";
}

export async function makeOwnerAction(id: string): Promise<{ ok: boolean }> {
  if (typeof id !== "string" || !asOrgId(id)) return { ok: false };
  const { token } = await requireIdentity();
  try {
    await makeOwner(token, id);
    revalidatePath("/members");
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function removeMemberAction(
  id: string,
): Promise<{ ok: true } | { ok: false; reason: MembershipRefusal }> {
  if (typeof id !== "string" || !asOrgId(id)) return { ok: false, reason: "failed" };
  const { token } = await requireIdentity();
  try {
    await removeMember(token, id);
    revalidatePath("/members");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: refusal(error) };
  }
}

/** Leave the active org: on success the org cookie is cleared and the page lands on the next org's home. */
export async function leaveOrgAction(): Promise<{ ok: false; reason: MembershipRefusal }> {
  const { token } = await requireIdentity();
  try {
    await leaveOrg(token);
  } catch (error) {
    return { ok: false, reason: refusal(error) };
  }
  (await cookies()).set(ORG_COOKIE, "", clearedOrgCookieOptions());
  revalidatePath("/", "layout");
  redirect("/dashboard");
}
