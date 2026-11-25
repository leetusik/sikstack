"use server";

import { cookies } from "next/headers";

import { acceptInvite } from "@/lib/knowledge/orgs";
import { asOrgId, getSession, ORG_COOKIE, orgCookieOptions } from "@/lib/session";
import { inviteCode } from "@/sikstack/org/model";

/**
 * The invite page's Join, a SERVER ACTION: `POST /app/invite/{code}/accept` with the session's token. Joined (or a
 * member already), the joined org becomes the active one (the org cookie, as the switch route sets it, to the org the
 * API just answered) and the page lands on its home. Anything else (no session, another address, a code that no
 * longer works, no answer) is the page's failed state; the read on the next load says which.
 */
export async function joinInviteAction(code: string): Promise<{ ok: boolean }> {
  const shown = inviteCode(code);
  const token = await getSession();
  if (!shown || !token) return { ok: false };
  try {
    const { tenant } = await acceptInvite(token, shown);
    const id = asOrgId(tenant.id);
    if (id) (await cookies()).set(ORG_COOKIE, id, orgCookieOptions());
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
