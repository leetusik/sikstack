import type { Metadata, MetadataRoute } from "next";

import { SITE } from "@/content";
import type { KbSitemapItem } from "@/lib/knowledge/sitemap";
import {
  bookHref,
  publicLibraryHref,
  readerHref,
  type ReaderTarget,
} from "@/lib/reader-href";

/**
 * P87 — one public URL per item kind, the same in a page's canonical tag and in `/sitemap.xml`
 * (`app/sitemap.ts`). Every path comes from the reader's own builders (`@/lib/reader-href`), on the
 * org segment the server names (`org_label`: the slug, else the tenant id):
 *
 * - a loose document: its pretty path `/@{org}/{project}/{slug}` when the server gives one, else
 *   `/documents/{id}` (a slug-less org);
 * - a book: `/@{org}/{project}/books/{book}`; a chapter: that, then `/{chapter}`, with no `?lang=` or
 *   `?v=` (a language or an older version is the same page);
 * - an org's public library: `/@{org}`.
 *
 * Each is absolute on `SITE.url`, so the tag and the sitemap's `<loc>` are the same string.
 */

/** `path` on the site's origin. */
export function absoluteUrl(path: string): string {
  return `${homeUrl()}${path}`;
}

/** The landing's URL as its canonical tag and the sitemap name it: the origin, no trailing slash. */
export function homeUrl(): string {
  return SITE.url.replace(/\/+$/, "");
}

/** The public path of what a reader page shows: a chapter's, or a loose document's. */
export function readerPath(target: ReaderTarget): string {
  return readerHref(target);
}

/** A page's `alternates`, its canonical URL being `path` on the site's origin. */
export function canonical(path: string): NonNullable<Metadata["alternates"]> {
  return { canonical: absoluteUrl(path) };
}

/** The public URL of each Public item (and of each org's public library holding one), for the sitemap. */
export function sitemapEntries(items: KbSitemapItem[]): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  const orgs = new Map<string, string | null>();
  const at = (stamp: string | null) => (stamp ? { lastModified: stamp } : {});
  const newer = (a: string | null | undefined, b: string | null) =>
    a && b ? (a > b ? a : b) : (a ?? b);
  for (const item of items) {
    orgs.set(item.org, newer(orgs.get(item.org), item.updated_at));
    if (item.kind === "doc") {
      entries.push({
        url: absoluteUrl(
          readerPath({
            kind: "document",
            id: item.id,
            canonicalPath: item.canonical_path,
          }),
        ),
        ...at(item.updated_at),
      });
      continue;
    }
    const book = { org: item.org, project: item.project, book: item.slug };
    entries.push({ url: absoluteUrl(bookHref(book)), ...at(item.updated_at) });
    for (const chapter of item.chapters) {
      entries.push({
        url: absoluteUrl(
          readerPath({ kind: "chapter", ...book, chapter: chapter.key }),
        ),
        ...at(chapter.updated_at),
      });
    }
  }
  const libraries: MetadataRoute.Sitemap = [...orgs].map(([org, stamp]) => ({
    url: absoluteUrl(publicLibraryHref(org)),
    ...at(stamp),
  }));
  return [...libraries, ...entries];
}
