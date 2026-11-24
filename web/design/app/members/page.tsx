import { MembersRoute } from "../../lib/org-screens";

// Members (P78-s2.S2's design), at the address production will give it (`src/app/(app)/members/`), the org rail's
// section after Feedback.
export const metadata = { title: "Members" };

export default function MembersPage() {
  return <MembersRoute />;
}
