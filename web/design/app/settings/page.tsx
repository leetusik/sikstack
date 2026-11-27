import { OrgSettingsRoute } from "../../lib/org-screens";

// Org settings (P88-ms.S3's design), at the address production will give it (`src/app/(app)/settings/`, to be
// built from this design): the org rail's Settings. `/members` redirects here.
export const metadata = { title: "Org settings" };

export default function OrgSettingsPage() {
  return <OrgSettingsRoute />;
}
