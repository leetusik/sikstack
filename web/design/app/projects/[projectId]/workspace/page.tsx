import type { Metadata } from "next";

import { WS_HEAD } from "@/content/workspace/frame";

import { PROJECT } from "../../../../lib/recording";
import { AgendaRoute } from "../../../../lib/screens";

// The Agenda, at production's address (`src/app/(app)/projects/[projectId]/workspace/page.tsx`), for the
// recording's project.
export const metadata: Metadata = { title: WS_HEAD.title };
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ projectId: PROJECT }];
}

export default function AgendaPage() {
  return <AgendaRoute />;
}
