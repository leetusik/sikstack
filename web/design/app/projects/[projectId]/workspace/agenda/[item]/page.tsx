import type { Metadata } from "next";

import { WS_HEAD } from "@/content/workspace/frame";

import { mintPool } from "../../../../../../lib/ids";
import { PROJECT, RECORDING } from "../../../../../../lib/recording";
import { ItemRoute } from "../../../../../../lib/screens";

// An agenda item, at production's address (`…/workspace/agenda/[item]/page.tsx`): one page for each recorded
// item, and one for each id the browser store mints for the first items added in the browser (`ids.ts`).
export const metadata: Metadata = { title: WS_HEAD.title };
export const dynamicParams = false;

export function generateStaticParams() {
  const recorded = RECORDING.workspace.agenda.map((a) => a.id);
  return [...recorded, ...mintPool(recorded)].map((item) => ({
    projectId: PROJECT,
    item,
  }));
}

export default async function AgendaItemPage({
  params,
}: {
  params: Promise<{ item: string }>;
}) {
  const { item } = await params;
  return <ItemRoute id={item} />;
}
