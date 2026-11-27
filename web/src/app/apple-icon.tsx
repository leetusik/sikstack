import { HOME_SIZE, homeIcon } from "@/lib/mark/mark";

// The home-screen icon (P87): sikstack's mark at 180 px, linked as `apple-touch-icon` on every page. The same
// picture answers at `/apple-touch-icon.png` (`./apple-touch-icon.png/route.ts`), the address iOS and crawlers
// ask for with no link tag.
export const size = { width: HOME_SIZE, height: HOME_SIZE };
export const contentType = "image/png";

export default function AppleIcon() {
  return homeIcon();
}
