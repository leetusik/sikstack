import type { MetadataRoute } from "next";

import { SITE } from "@/content";
import { HOME_SIZE, TAB_SIZES } from "@/lib/mark/mark";

// The web app manifest (P78, F5): sikstack's name and description (`SITE`), the app's light ground as the
// background (`--bg`, never the old paper) and its accent as the theme colour, both `tokens.css`'s light values;
// the icons are sikstack's mark (P87), PNGs only: the tab sizes (`icon.tsx`, `/icon/<side>`) and the 180 px
// home-screen icon (`apple-touch-icon.png/`).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.description,
    start_url: "/",
    display: "standalone",
    background_color: "#f2f4f7",
    theme_color: "#1d4ed8",
    icons: [
      ...TAB_SIZES.map((side) => ({
        src: `/icon/${side}`,
        type: "image/png",
        sizes: `${side}x${side}`,
        purpose: "any" as const,
      })),
      {
        src: "/apple-touch-icon.png",
        type: "image/png",
        sizes: `${HOME_SIZE}x${HOME_SIZE}`,
        purpose: "any",
      },
    ],
  };
}
