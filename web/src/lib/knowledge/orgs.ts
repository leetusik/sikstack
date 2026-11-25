import "server-only";

import { ApiError, getJson, getRaw, sendJson } from "./client";
import type { KbProject, KbTenant } from "./types";

// The org pages' calls to the API (`server/orgs_api.py`), server to server: New org, the org
// home's rename, Members (the list, an invite, a revoke, making an owner, a removal, leaving) and the invite link
// (its read and its accept). Each session call acts in the active org (`X-Sikstack-Org` from the org cookie, as
// every call does), but the invite link's two: its read lists the invite's own org, and its accept
// joins that org, so neither names one (`org: null`), as the connect page's calls do. The refusals
// keep the API's `reason` on the `ApiError` (`taken`, `address`, `member`, `invited`, `other`,
// `limit`, `recipient`, `last_owner`, `last_org`).

/** `POST /app/orgs`: a new org, the caller its owner, with one project `default`. */
export async function createOrg(
  token: string,
  name: string,
): Promise<{ tenant: KbTenant; project: KbProject }> {
  return sendJson("/app/orgs", "POST", { name }, { token });
}

/** `PATCH /app/tenant/name`: rename the active org (owner only). */
export async function renameOrg(token: string, name: string): Promise<{ tenant: KbTenant }> {
  return sendJson("/app/tenant/name", "PATCH", { name }, { token });
}

export interface KbMember {
  id: string;
  email: string;
  role: "owner" | "member";
  joined_at: string;
}

export interface KbInvite {
  id: string;
  email: string;
  invited_at: string;
  expires_at: string;
}

export interface KbMembers {
  /** The caller's role in the active org. */
  role: "owner" | "member";
  members: KbMember[];
  /** The pending invites, newest first: an owner's answer only. */
  invites?: KbInvite[];
}

/** `GET /app/members`: the active org's members (and, for an owner, its pending invites). */
export async function getMembers(token: string): Promise<KbMembers> {
  return getJson<KbMembers>("/app/members", { token });
}

/** `POST /app/invites`: invite one address into the active org (owner only). */
export async function createInvite(token: string, email: string): Promise<{ invite: KbInvite }> {
  return sendJson("/app/invites", "POST", { email }, { token });
}

/** `DELETE /app/invites/{id}`: revoke one of the active org's invites (owner only). */
export async function revokeInvite(token: string, id: string): Promise<void> {
  await sendJson<void>(`/app/invites/${encodeURIComponent(id)}`, "DELETE", undefined, { token });
}

/** `POST /app/members/{id}/owner`: make a member of the active org an owner (owner only; an owner's row: no change). */
export async function makeOwner(token: string, id: string): Promise<void> {
  await sendJson<void>(`/app/members/${encodeURIComponent(id)}/owner`, "POST", undefined, { token });
}

/** `DELETE /app/members/{id}`: remove a member from the active org (owner only; never its last owner, never from its only org). */
export async function removeMember(token: string, id: string): Promise<void> {
  await sendJson<void>(`/app/members/${encodeURIComponent(id)}`, "DELETE", undefined, { token });
}

/** `POST /app/tenant/leave`: leave the active org (never as its last owner, never the caller's only org). */
export async function leaveOrg(token: string): Promise<void> {
  await sendJson<void>("/app/tenant/leave", "POST", undefined, { token });
}

/**
 * `GET /app/invite/{code}`: with the session's token when there is one. Signed out, the API limits
 * the read per client address (it shows the invited address), so the visitor's address goes with it
 * as `X-Real-IP`, as the connect page's read does. The raw JSON (the model reads it), or the status
 * that refused it.
 */
export async function readInvite(
  code: string,
  token: string | null,
  address: string | null,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  try {
    const res = await getRaw(`/app/invite/${encodeURIComponent(code)}`, {
      token: token ?? undefined,
      org: null,
      headers: {
        Accept: "application/json",
        ...(address ? { "X-Real-IP": address } : {}),
      },
    });
    return { ok: true, body: (await res.json()) as unknown };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, status: error.status };
    throw error;
  }
}

/** `POST /app/invite/{code}/accept`: join the invite's org as a member (the invited address only). */
export async function acceptInvite(
  token: string,
  code: string,
): Promise<{ state: "joined" | "member"; tenant: KbTenant }> {
  return sendJson(`/app/invite/${encodeURIComponent(code)}/accept`, "POST", undefined, {
    token,
    org: null,
  });
}
