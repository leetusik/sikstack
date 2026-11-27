import { homeIcon } from "@/lib/mark/mark";

// P87 — `/apple-touch-icon.png`, the address iOS and crawlers ask for with no link tag: the home-screen icon,
// the same picture as `../apple-icon.tsx`, drawn once at build.
export const dynamic = "force-static";

export function GET(): Response {
  return homeIcon();
}
