import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The options page's faces (`public/options/index.html`, the "sik" mark): production's own IBM Plex Sans files
// (`web/public/fonts/plex/`), written into the build at the address production serves them from. A plain HTML
// page cannot name the hashed copies `next/font` makes. Deleted with the options page after the pick. The build
// runs from `web/` (`next build design`) or from `web/design/`.
export const dynamic = "force-static";
export const dynamicParams = false;

const FILES = ["IBMPlexSans-Regular.woff2", "IBMPlexSans-Medium.woff2", "IBMPlexSans-SemiBold.woff2"];

export function generateStaticParams() {
  return FILES.map((file) => ({ file }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILES.includes(file)) return new Response(null, { status: 404 });
  const found = [
    path.join(process.cwd(), "public", "fonts", "plex", file),
    path.join(process.cwd(), "..", "public", "fonts", "plex", file),
  ].find((p) => existsSync(p));
  if (!found) throw new Error(`web/public/fonts/plex/${file} not found`);
  return new Response(readFileSync(found), { headers: { "Content-Type": "font/woff2" } });
}
