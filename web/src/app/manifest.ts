import type { MetadataRoute } from "next";

import { SITE } from "@/content";

// The web app manifest (P78, F5): sikstack's name and description (`SITE`), the app's light ground as the
// background (`--bg`, never the old paper) and its accent as the theme colour, both `tokens.css`'s light values;
// the icons are the product's mark (`public/favicon.svg`) and its 180 px raster copy.
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
      {
        src: "/favicon.svg",
        type: "image/svg+xml",
        sizes: "any",
        purpose: "any",
      },
      {
        src: "/apple-touch-icon.png",
        type: "image/png",
        sizes: "180x180",
        purpose: "any",
      },
    ],
  };
}
