import { INDEX_PAGE, PAGES, type BuildPage } from "../../lib/pages";

// The build's pages as data, for `scripts/build.mjs`, which writes the manifest's `pages` from it (the recording's
// file and the item pages it finds in `out/` added) and then removes this file from `out/`.
export const dynamic = "force-static";

const plain = ({ states, ...page }: BuildPage) => ({
  ...page,
  ...(states ? { states: states.list.map(({ key, label }) => ({ key, label })) } : {}),
});

export function GET() {
  return Response.json({ pages: [INDEX_PAGE, ...PAGES].map(plain) });
}
