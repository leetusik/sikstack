import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { SITE } from "@/content";
import { getPublicSitemap } from "@/lib/knowledge/sitemap";
import { sitemapEntries } from "@/sikstack/seo/urls";

// P14.S2 — the sitemap of the public surface: the landing at `/`. The authenticated app (/dashboard, …)
// and the `(auth)` gate are private / noindex, so they are deliberately absent.
//
// P87 — plus every Public document, book and chapter of every org, and each org's public library that
// holds one, read from the anonymous `GET /app/sitemap` (`@/lib/knowledge/sitemap`), which lists only
// Public items (never a Link, Members or no-row one). Each URL is the one that page's canonical tag
// names (`@/sikstack/seo/urls`).
//
// `connection()` renders it per request, never frozen at build time, when the API is unreachable; the
// read itself is kept for an hour in Next's data cache (`SITEMAP_REVALIDATE`), and only a good answer
// is kept. A read that fails lists `/` alone.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const home: MetadataRoute.Sitemap[number] = {
    url: SITE.url,
    lastModified: new Date(),
    changeFrequency: "monthly",
    priority: 1,
  };
  try {
    return [home, ...sitemapEntries(await getPublicSitemap())];
  } catch {
    return [home];
  }
}
