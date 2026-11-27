import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Production's own mark (`web/public/favicon.ico`, sikstack's "sik" at 16, 32 and 48 px), written into the build
// as a static file. The build runs from `web/` (`next build design`) or from `web/design/`.
export const dynamic = "force-static";

export function GET() {
  const file = [
    path.join(process.cwd(), "public", "favicon.ico"),
    path.join(process.cwd(), "..", "public", "favicon.ico"),
  ].find((p) => existsSync(p));
  if (!file) throw new Error("web/public/favicon.ico not found");
  return new Response(readFileSync(file), { headers: { "Content-Type": "image/x-icon" } });
}
