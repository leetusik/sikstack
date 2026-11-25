import type { ShellOrg } from "@/sikstack/shell";

import type { CreateOrgResult, InviteResult, InviteRow, InviteView, MemberRow } from "@/sikstack/org/model";
import { NOW, RECORDING } from "./recording";

/**
 * The org surfaces' data (P78-s2.S2's design). **Synthesized, every line:** no API answered org creation, members
 * or invites when it was drawn (the brief), so nothing here was recorded; the recording's sample project has none
 * since (`server/orgs_api.py`, P78-s2.S3). The account, its active org and the clock are the
 * recording's (`RECORDING.shell`, `NOW`); the other orgs, the members, the invites and the invite link's code are
 * made here, with reserved addresses (`example.com`, `example.invalid`). A Korean org name is data, as TASTE says.
 * The design's actions answer in the browser after a short wait, as the store's do (`actions.ts`).
 */

const DAY = 86_400_000;
const at = (days: number) => new Date(NOW + days * DAY).toISOString().replace(/\.\d+Z$/, "Z");

/** The signed-in account (recorded). */
export const ME = RECORDING.shell.email;

/** The active org (recorded), as the org menu lists it: no public URL, its one project. */
export const CURRENT_ORG: ShellOrg = { ...RECORDING.shell.org, address: null, projects: 1 };

/** Made: two more orgs of the account, one with a public URL, one with a Korean name and none. */
export const OTHER_ORGS: ShellOrg[] = [
  { id: "00000000-0000-4000-8000-0000000000b2", name: "Side Projects", address: "sikstack.com/@side", projects: 4 },
  { id: "00000000-0000-4000-8000-0000000000c3", name: "서울 디자인 랩", address: null, projects: 2 },
];

/** Made: the org's people. The account owns the org (it made it three weeks before the recording's clock). */
export const OWNER: MemberRow = { id: "m-owner", email: ME, role: "owner", joinedAt: at(-21) };
export const MEMBERS_MANY: MemberRow[] = [
  OWNER,
  { id: "m-mina", email: "mina.park@example.com", role: "member", joinedAt: at(-3) },
  { id: "m-jun", email: "jun.lee@example.com", role: "member", joinedAt: at(-2) },
];

/** Made: pending invites (a link works 7 days: the length is the operator's to confirm). */
export const INVITES_MANY: InviteRow[] = [
  { id: "i-sora", email: "sora.kim@example.com", invitedAt: at(-1), expiresAt: at(6) },
  {
    id: "i-long",
    email: "hyunwoo.choi.design-lead@studio-partners.example.com",
    invitedAt: at(-4),
    expiresAt: at(3),
  },
];

/** Made: the address the invite form holds in its states (a new one, and the refused ones). */
export const NEW_ADDRESS = "hana.yoon@example.com";
export const NOT_AN_ADDRESS = "hana.yoon@example";

/** The invite a send just made, first in the table. */
export function sentInvite(email: string, id = `i-${email}`): InviteRow {
  return { id, email, invitedAt: at(0), expiresAt: at(7) };
}

const wait = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** The design's send: the API's refusals for an address that is a member or invited already; else sent. */
export function designInvite(members: readonly MemberRow[], invites: readonly InviteRow[]) {
  return (email: string): Promise<InviteResult> => {
    const key = email.trim().toLowerCase();
    if (members.some((m) => m.email.toLowerCase() === key)) return wait(500, { ok: false, reason: "member" });
    if (invites.some((i) => i.email.toLowerCase() === key)) return wait(500, { ok: false, reason: "invited" });
    return wait(700, { ok: true, invite: sentInvite(email.trim()) });
  };
}

export const designRevoke = (): Promise<{ ok: boolean }> => wait(400, { ok: true });

/** The design's Remove: the row goes. Its Leave: refused (the design never leaves the page it draws). */
export const designRemove = (): Promise<{ ok: boolean }> => wait(400, { ok: true });
export const designLeave = (): Promise<{ ok: boolean }> => wait(400, { ok: false });

/** The design's create: a name the account's orgs already have is `taken`; else made. */
export function designCreate(name: string): Promise<CreateOrgResult> {
  const key = name.trim().toLowerCase();
  const orgs = [CURRENT_ORG, ...OTHER_ORGS];
  if (orgs.some((o) => o.name.toLowerCase() === key)) return wait(500, { ok: false, reason: "taken" });
  return wait(700, { ok: true, id: "00000000-0000-4000-8000-0000000000d4", name: name.trim() });
}

export const designJoin = (): Promise<{ ok: boolean }> => wait(700, { ok: true });

/** Made: the invite link's answer, the recording's org inviting a new address. */
export const INVITE_VIEW: Omit<InviteView, "phase" | "account"> = {
  code: "inv_7Hq2kD9xLm",
  org: { id: RECORDING.shell.org.id, name: RECORDING.shell.org.name },
  email: "sora.kim@example.com",
  invitedBy: ME,
};
/** Made: the other account a forwarded link is opened in. */
export const OTHER_ACCOUNT = "jun.lee@example.com";
