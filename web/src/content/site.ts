// Site-level brand + metadata. Single source for the wordmark and the
// title/description used by the Metadata API (wired in layout.tsx). The app is
// Korean-first (root lang="ko", matching hi2vi_web), rendered in the full
// Pretendard face. `url` reads the deploy env var and falls back to a local-dev
// origin (production origin is a P14 deploy concern).
import type { SiteMeta } from "./types";

//
// The tab title and the description name sikstack (operator, OQ15); the landing itself sets its own absolute
// title. P87: the description says plainly what sikstack is, a Claude Code plugin and web app, in the
// landing's own words (under 160 characters, no figures, F262); `LANDING.meta.description` is the same line.
export const SITE: SiteMeta = {
  name: "sikstack",
  title: "sikstack",
  titleTemplate: "%s · sikstack",
  description:
    "sikstack is a Claude Code plugin and web app: what your coding agents plan and run, what they write for you to read, and your users’ feedback.",
  url: process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3030",
};
