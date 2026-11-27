import { TAB_SIZES, tabIcon, type TabSize } from "@/lib/mark/mark";

// The tab icons (P87): sikstack's mark at 16, 32 and 48 px, each its own `/icon/<side>`, drawn by
// `@/lib/mark/mark` at build time. `public/favicon.ico` packs the same three renders.
export function generateImageMetadata() {
  return TAB_SIZES.map((side) => ({
    id: String(side),
    size: { width: side, height: side },
    contentType: "image/png",
  }));
}

export default async function Icon({ id }: { id: Promise<string> }) {
  return tabIcon(Number(await id) as TabSize);
}
