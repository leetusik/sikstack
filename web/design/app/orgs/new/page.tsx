import { NewOrgRoute } from "../../../lib/org-screens";

// New org (P78-s2.S2's design), at production's address (`src/app/(app)/orgs/new/`), reached from
// the org menu's foot.
export const metadata = { title: "New org" };

export default function NewOrgPage() {
  return <NewOrgRoute />;
}
