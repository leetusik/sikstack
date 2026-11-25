import type { Metadata } from "next";
import { headers } from "next/headers";

import { INVITE } from "@/content/org";
import { optionalIdentity } from "@/lib/auth-guards";
import { edgeAddress } from "@/lib/knowledge/connect";
import { readInvite } from "@/lib/knowledge/orgs";
import { ORG_ROUTE } from "@/lib/session";
import { InviteColumn } from "@/sikstack/org/invite";
import { inviteCode, inviteViewFromServer } from "@/sikstack/org/model";

import "../connect.css";
import { joinInviteAction } from "./actions";
import { CarryInviteEmail } from "./carry-email";

// `/invite?code=…` (P78-s2.S2's signed design): the link an invite mail holds, in the `(auth)` frame beside
// `/connect`, whose sheet it reads. Unguarded: signed out it names the org and leads to sign in or create an
// account with the invited address (carried into Email, `CarryInviteEmail`; the pair's `next` is this page, and the
// sign-in form sends the code along). Server component: it reads the code for this session from the API
// (`GET /app/invite/{code}`, with the session's token when there is one and the visitor's address for the API's
// per-address limit signed out) and hands the column its first view; Join is `joinInviteAction`. A code the API
// does not know, or no code, is the signed `expired` page with no org named (P78, OQ3: the same words as an
// expired, revoked or used code); a refused read (the limit, the API down) is the error page.
export const metadata: Metadata = {
  title: INVITE.pageTitle,
};

/** What the API would say of a code it does not know: no usable state and no org's name. */
const UNKNOWN = { state: "expired", org: { name: "" } };

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const code = inviteCode((await searchParams).code);
  const session = await optionalIdentity();
  const account = session?.identity.user.email ?? null;
  if (!code) {
    return <InviteColumn initial={inviteViewFromServer(UNKNOWN, "", account)} join={joinInviteAction} orgRoute={ORG_ROUTE} />;
  }
  const read = await readInvite(code, session?.token ?? null, edgeAddress(await headers()));
  if (!read.ok && read.status !== 404) {
    throw new Error(`the invite read answered ${read.status}`);
  }
  const view = inviteViewFromServer(read.ok ? read.body : UNKNOWN, code, account);
  return (
    <>
      {view.phase === "out" ? <CarryInviteEmail email={view.email} /> : null}
      <InviteColumn initial={view} join={joinInviteAction} orgRoute={ORG_ROUTE} />
    </>
  );
}
