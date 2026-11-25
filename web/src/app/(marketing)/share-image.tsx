import { ImageResponse } from "next/og";

import { LANDING } from "@/content/marketing";

/**
 * The landing's shared image (P78, F9): what a link to sikstack.com shows on a social network or in a chat. Type
 * only, on the product's light tokens (`tokens.css`: `--bg`, `--ink`, `--ink-2`), no artwork: the wordmark, the
 * landing's title and its line. Drawn by this segment's `opengraph-image.tsx` and `twitter-image.tsx` (each a
 * file convention of its own, so Next links `og:image` and `twitter:image` on the landing), generated once at
 * build time (nothing here reads the request).
 */
export const SHARE_IMAGE_SIZE = { width: 1200, height: 630 };
export const SHARE_IMAGE_ALT = LANDING.meta.title;

export function shareImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "88px 96px",
        background: "#f2f4f7",
        color: "#14171c",
      }}
    >
      <div style={{ display: "flex", fontSize: 44, fontWeight: 600 }}>
        {LANDING.wordmark}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 600,
            lineHeight: 1.15,
            maxWidth: 960,
          }}
        >
          {LANDING.hero.title}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 34,
            lineHeight: 1.4,
            color: "#4a5362",
            maxWidth: 960,
          }}
        >
          {LANDING.hero.lede}
        </div>
      </div>
    </div>,
    SHARE_IMAGE_SIZE,
  );
}
