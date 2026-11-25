import AuthLayout from "@/app/(auth)/layout";
import "@/app/(auth)/connect.css";

import { INVITE } from "@/content/org";
import { InviteRoute } from "../../lib/org-screens";

// The invite link (P78-s2.S2's design), at production's address (`src/app/(auth)/invite/`,
// `/invite?code=…`), in the sign-in frame the `(auth)` layout draws, beside `/connect`, whose sheet it reads.
export const metadata = { title: INVITE.pageTitle };

export default function InvitePage() {
  return (
    <AuthLayout>
      <InviteRoute />
    </AuthLayout>
  );
}
