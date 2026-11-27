import type { Metadata } from "next";

import { ListenRoot } from "@/components/listen/listen-root";
import { SITE } from "@/content";
import {
  fraunces,
  jetbrains,
  plexMono,
  plexSans,
  plexSansKr,
  pretendard,
  source,
} from "@/lib/fonts";
import { TimeZoneCookie } from "@/lib/time-zone-cookie";
import "./globals.css";
import "@/sikstack/styles/index.css";
// The Shell's sheet, here as well as in `AppShell` (P78, F7): the root not-found renders the Shell, so Next put
// its sheet in that boundary's chunk and preloaded it on every page, where it went unused ("preloaded but not
// used"). Loaded by the root, it is in every page's own CSS.
import "@/sikstack/shell/shell.css";
// The canvas: html and body take the page's own surface (P78, F4), after the system's sheets.
import "./canvas.css";

// Base metadata. `metadataBase` resolves canonical/OG URLs from SITE.url
// (NEXT_PUBLIC_APP_URL → local-dev origin fallback). The icons (P87) are sikstack's mark, by Next's file
// conventions, so no `icons` here (a config `icons` would turn the files' tags off): `icon.tsx` (16, 32 and 48 px)
// and `apple-icon.tsx` (180 px) beside this file; `public/favicon.ico` packs the three tab sizes for the
// browsers that ask `/favicon.ico` unprompted, and `apple-touch-icon.png/` answers iOS's default address. The
// shared image is `(marketing)/opengraph-image.tsx` (F9).
export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: SITE.title,
    template: SITE.titleTemplate,
  },
  description: SITE.description,
  applicationName: SITE.name,
};

// Root layout. English (`lang="en"`, P78 F6): the chrome is English, and Korean appears as data,
// marked `lang="ko"` where it is drawn, still read in the full Pretendard Hangul fallback. The self-hosted
// next/font variables (Source Sans 3 / Fraunces / JetBrains Mono / Pretendard)
// are applied to <html> so font-sans / font-display / font-mono resolve
// everywhere. `data-md-color-scheme="default"` sets the light Knowledge Base
// scheme as the base; the `(auth)` group overrides it to the dark `slate` gate
// on its own stage, while the `(app)` shell carries `default` on its `.kb-app`
// root. The body is scheme-neutral (text-ink resolves to --kb-* per the active
// scheme); its background is the page's own surface (`canvas.css`), never the old paper.
//
// The sikstack design system's faces (IBM Plex Sans, Sans KR, Mono) add their three variables here too.
// They are read only inside a `.ui` root (`src/sikstack/styles/`), are never preloaded, and change no
// old page; the scheme of a `.ui` root is its own `data-scheme`, set by `UiRoot` (`src/sikstack/ui/`).
//
// P41-sr.W1: `ListenRoot` is Listen's persistent player, above every route so a Listen
// survives moving between reader pages. It renders and loads nothing off a reader or
// book path, and reads no request data, so no page here becomes dynamic.
//
// `TimeZoneCookie` writes the viewer's zone once into the cookie every page formats its
// dates in (the one time zone, `src/lib/time-zone.ts`). It renders nothing and reads no request data.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-md-color-scheme="default"
      className={`${pretendard.variable} ${source.variable} ${fraunces.variable} ${jetbrains.variable} ${plexSans.variable} ${plexSansKr.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-dvh flex-col font-sans text-ink antialiased">
        {children}
        <ListenRoot />
        <TimeZoneCookie />
      </body>
    </html>
  );
}
