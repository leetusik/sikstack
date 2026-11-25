import type { Metadata } from "next";

import { NEW_ORG } from "@/content/org";
import { requireIdentity } from "@/lib/auth-guards";
import { NewOrgForm } from "@/sikstack/org/new-org";

import { createOrgAction } from "../actions";

/**
 * New org (`/orgs/new`, P78-s2.S2's signed design): a system page in the Shell, reached from the org menu's foot.
 * One field, the org's name; Create org makes the org with one project (as at sign-up), makes it the active org and
 * lands on its home (`createOrgAction`). Cancel goes back to the current org's home.
 */
export const metadata: Metadata = { title: NEW_ORG.title };

export default async function NewOrgPage() {
  const { identity } = await requireIdentity();
  return <NewOrgForm create={createOrgAction} current={identity.tenant?.name ?? ""} />;
}
