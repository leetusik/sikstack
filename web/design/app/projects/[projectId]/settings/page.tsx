import type { Metadata } from "next";

import { ProjectSettingsRoute } from "../../../../lib/org-screens";
import { PROJECT } from "../../../../lib/recording";

// Project settings (P88-ms.S3's design), at the address production will give it
// (`src/app/(app)/projects/[projectId]/settings/`, to be built from this design), for the recording's project: the
// project rail's Settings.
export const metadata: Metadata = { title: "Project settings" };
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ projectId: PROJECT }];
}

export default function ProjectSettingsPage() {
  return <ProjectSettingsRoute />;
}
