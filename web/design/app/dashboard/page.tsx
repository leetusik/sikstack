import { OrgSwitcherRoute } from "../../lib/org-screens";

// The org switcher (P78-s2.S2's design), in the top bar of every app page, drawn over org home's address
// (`src/app/(app)/dashboard/`), where an org pick lands. Org home itself is not in this design.
export const metadata = { title: "Org switcher" };

export default function OrgSwitcherPage() {
  return <OrgSwitcherRoute />;
}
