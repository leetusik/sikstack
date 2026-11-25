import type { Metadata } from "next";
import { cookies } from "next/headers";

import { MEMBERS } from "@/content/org";
import { requireIdentity } from "@/lib/auth-guards";
import { getMembers } from "@/lib/knowledge/orgs";
import { MembersView } from "@/sikstack/org/members";

import { orgHomeFormat } from "../dashboard/org-home-model";
import {
  leaveOrgAction,
  makeOwnerAction,
  removeMemberAction,
  revokeInviteAction,
  sendInviteAction,
} from "../orgs/actions";

/**
 * Members (`/members`, P78-s2.S2's signed design): the org rail's section after Feedback. One read,
 * `GET /app/members` in the active org: its members, and for an owner its pending invites, whose panel holds the
 * invite form (`sendInviteAction`) and each row's Revoke (`revokeInviteAction`), each member row's Make owner
 * (`makeOwnerAction`) and Remove (`removeMemberAction`), and the owner's own row's Leave when the org has another
 * owner. A member's view has the members only, its own row with Leave (`leaveOrgAction`). Dates in the viewer's
 * zone (`kb_tz`). A failed read is the route's error page.
 */
export const metadata: Metadata = { title: MEMBERS.title };

export default async function MembersPage() {
  const { token, identity } = await requireIdentity();
  const answer = await getMembers(token);
  const format = orgHomeFormat(await cookies());
  return (
    <MembersView
      org={identity.tenant?.name ?? ""}
      me={{ email: identity.user.email, role: answer.role }}
      members={answer.members.map((m) => ({
        id: m.id,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at,
      }))}
      invites={(answer.invites ?? []).map((i) => ({
        id: i.id,
        email: i.email,
        invitedAt: i.invited_at,
        expiresAt: i.expires_at,
      }))}
      invite={sendInviteAction}
      revoke={revokeInviteAction}
      promote={makeOwnerAction}
      remove={removeMemberAction}
      leave={leaveOrgAction}
      format={format}
    />
  );
}
