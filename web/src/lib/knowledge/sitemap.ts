import "server-only";

import { readKbApiEnv } from "@/lib/env";

import { ApiError } from "./client";

/**
 * The anonymous sitemap read (P87): `GET /app/sitemap` (`server/books_api.py::public_sitemap`), every
 * org's Public documents and books, gated per item as a stranger's org library is (never a Link,
 * Members or no-row item). `/app/*` is not on the public edge, so only this server reads it.
 *
 * Unlike every other knowledge call (`client.ts`, `cache: "no-store"`), this one is the same for every
 * visitor and carries no bearer, org or share header: no cookie is read, so nothing per-user can reach
 * it, and its answer is kept in Next's data cache for an hour (`next.revalidate`). Next keeps only a
 * 200, so a failed read is never cached: the next request asks again. Throws on any failure (an
 * `ApiError` for a non-2xx, the fetch's own error otherwise); the sitemap falls back to `/` alone.
 */

/** A chapter of a Public book: its key (the reader's URL segment) and its newest variant's time. */
export interface KbSitemapChapter {
  key: string;
  updated_at: string | null;
}

export type KbSitemapItem =
  | {
      kind: "book";
      /** `org_label`: the org slug, else the tenant id. */
      org: string;
      project: string;
      slug: string;
      updated_at: string | null;
      chapters: KbSitemapChapter[];
    }
  | {
      kind: "doc";
      org: string;
      project: string;
      slug: string;
      id: number;
      /** `/@{org}/{project}/{slug}`, or null for a slug-less org (the document reads at `/documents/{id}`). */
      canonical_path: string | null;
      updated_at: string | null;
    };

/** How long a good answer is kept, in seconds (about hourly). */
export const SITEMAP_REVALIDATE = 3600;

export async function getPublicSitemap(): Promise<KbSitemapItem[]> {
  const { KB_API_BASE_URL } = readKbApiEnv();
  const res = await fetch(
    `${KB_API_BASE_URL.replace(/\/+$/, "")}/app/sitemap`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      next: { revalidate: SITEMAP_REVALIDATE },
    },
  );
  if (!res.ok) throw new ApiError(res.status, null);
  const body = (await res.json()) as { items?: unknown };
  if (!Array.isArray(body.items)) throw new Error("sitemap read: no items");
  return body.items as KbSitemapItem[];
}
