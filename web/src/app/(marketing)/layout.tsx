import type { Metadata } from "next";

import { SITE } from "@/content";
import { LANDING } from "@/content/marketing";

// The public route group: the landing at `/` (src/sikstack/landing/). It is public, has no auth gate and
// indexes (the `(auth)` subtree sets robots noindex). The landing renders its own `.ui` root, which
// follows the system scheme; the title is absolute, so the root's " · knowledge" template stays off it.
export const metadata: Metadata = {
  title: { absolute: LANDING.meta.title },
  description: LANDING.meta.description,
  alternates: { canonical: "/" },
  openGraph: {
    title: LANDING.meta.title,
    description: LANDING.meta.description,
    url: SITE.url,
    siteName: LANDING.meta.siteName,
    type: "website",
  },
  // P78, F9: a shared link carries the large picture (`app/opengraph-image.tsx`, `app/twitter-image.tsx`).
  twitter: {
    card: "summary_large_image",
    title: LANDING.meta.title,
    description: LANDING.meta.description,
  },
};

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
