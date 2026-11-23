import { awayParams } from "../../lib/away";
import { PROJECT } from "../../lib/recording";
import { AwayScreen } from "../../lib/screens";

// The pages the design links to but does not draw (`away.ts`): one stub each.
export const metadata = { title: "Not in this design" };
export const dynamicParams = false;

export function generateStaticParams() {
  return awayParams(PROJECT);
}

export default async function AwayPage({
  params,
}: {
  params: Promise<{ away: string[] }>;
}) {
  const { away } = await params;
  return <AwayScreen path={`/${away.map(encodeURIComponent).join("/")}`} />;
}
