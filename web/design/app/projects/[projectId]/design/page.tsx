import type { Metadata } from "next";

import { DesignListRoute } from "../../../../lib/design-screens";
import { PROJECT } from "../../../../lib/recording";

// The project's Design list, at the address production will give it (`src/app/(app)/projects/[projectId]/design/`,
// to be built from this design), for the recording's project.
export const metadata: Metadata = { title: "Design" };
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ projectId: PROJECT }];
}

export default function DesignListPage() {
  return <DesignListRoute />;
}
