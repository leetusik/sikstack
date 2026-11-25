import type { Metadata } from "next";

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
import "../../src/app/globals.css";
import "@/sikstack/styles/index.css";
import "@/sikstack/shell/shell.css";
import "../../src/app/canvas.css";

// The design build's root: production's root layout (`src/app/layout.tsx`) as it draws a signed-in page,
// its sheets, faces and body classes, without the request-bound parts (Listen, the zone cookie).
export const metadata: Metadata = {
  title: { default: SITE.title, template: SITE.titleTemplate },
  description: "sikstack design build",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};

export default function DesignRoot({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-md-color-scheme="default"
      className={`${pretendard.variable} ${source.variable} ${fraunces.variable} ${jetbrains.variable} ${plexSans.variable} ${plexSansKr.variable} ${plexMono.variable}`}
    >
      <body className="flex min-h-dvh flex-col font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
