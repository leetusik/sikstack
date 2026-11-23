import type { Metadata } from "next";

import { buildPageIds } from "../../../../../lib/design-data";
import { DesignBuildRoute } from "../../../../../lib/design-screens";
import { PROJECT } from "../../../../../lib/recording";

// A design build's viewer, at the address production will give it (`…/design/[build]/`): one page for each
// recorded build, and one for the build deleted while recording (drawn gone).
export const metadata: Metadata = { title: "Design" };
export const dynamicParams = false;

export function generateStaticParams() {
  return buildPageIds().map((build) => ({ projectId: PROJECT, build }));
}

export default async function DesignBuildPage({
  params,
}: {
  params: Promise<{ build: string }>;
}) {
  const { build } = await params;
  return <DesignBuildRoute id={build} />;
}
