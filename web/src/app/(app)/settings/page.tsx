import type { Metadata } from "next";
import { cookies } from "next/headers";

import { SETTINGS } from "@/content/settings";
import { requireIdentity } from "@/lib/auth-guards";
import { listProjects } from "@/lib/knowledge/app";
import { getMembers } from "@/lib/knowledge/orgs";

import { saveOrgSlug } from "../dashboard/actions";
import { orgHomeFormat } from "../dashboard/org-home-model";
import {
  leaveOrgAction,
  makeOwnerAction,
  removeMemberAction,
  renameOrgAction,
  revokeInviteAction,
  sendInviteAction,
} from "../orgs/actions";
import { deleteOrgAction, stepDownAction } from "./actions";
import { OrgSettings } from "./org-settings";

/**
 * Org settings (`/settings`, P88-ms.S3's signed design): the org rail's Settings, and where `/members` redirects
 * (`next.config.ts`). Reads, in parallel, in the active org: `GET /app/members` (the caller's role, the members and,
 * for an owner, the pending invites) and `GET /app/projects` (the count the delete's confirm names); the org's name
 * and slug are the session's (`/auth/me`). The writes: Org name (`renameOrgAction`), Public URL (`saveOrgSlug`), the
 * Members and Invites panels' (P78's actions, `../orgs/actions.ts`), Step down (`stepDownAction`) and Delete org
 * (`deleteOrgAction`). A member's view is the view's own (the name and URL read only, no Invites, no Delete org).
 * Dates in the viewer's zone (`kb_tz`). A failed read is the route's error page.
 */
export const metadata: Metadata = { title: SETTINGS.org.title };

export default async function OrgSettingsPage() {
  const { token, identity } = await requireIdentity();
  const [answer, projects] = await Promise.all([getMembers(token), listProjects(token)]);
  const format = orgHomeFormat(await cookies());
  return (
    <OrgSettings
      org={{
        name: identity.tenant?.name ?? "",
        slug: identity.tenant?.slug ?? null,
        projects: projects.length,
      }}
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
      rename={renameOrgAction}
      saveSlug={saveOrgSlug}
      invite={sendInviteAction}
      revoke={revokeInviteAction}
      promote={makeOwnerAction}
      remove={removeMemberAction}
      leave={leaveOrgAction}
      stepDown={stepDownAction}
      deleteOrg={deleteOrgAction}
      format={format}
    />
  );
}
