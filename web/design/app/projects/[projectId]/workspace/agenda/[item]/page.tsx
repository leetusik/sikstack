import type { Metadata } from "next";

import { WS_HEAD } from "@/content/workspace/frame";

import { itemPageIds } from "../../../../../../lib/answers";
import { PROJECT } from "../../../../../../lib/recording";
import { ItemRoute } from "../../../../../../lib/screens";

// An agenda item, at production's address (`…/workspace/agenda/[item]/page.tsx`): one page for each item of
// every data set the store can hold (`answers.ts`), and one for each id the browser store mints for the first
// items added in the browser on each (`ids.ts`).
export const metadata: Metadata = { title: WS_HEAD.title };
export const dynamicParams = false;

export function generateStaticParams() {
  return itemPageIds().map((item) => ({
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
