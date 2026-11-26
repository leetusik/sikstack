// The Design service's rules as pure functions (P77): what a build's row and its viewer show, from the members'
// routes of `server/design_api.py` (`GET /app/projects/{id}/design/builds` → `{builds}`, `GET …/builds/{build}` →
// `{build, manifest}`). No React and no I/O.

import { DESIGN } from "@/content/design";

/** A build as the members' routes answer it (`_build_json`, `member=True`). */
export interface DesignBuild {
  id: string;
  url: string | null;
  commit: string | null;
  branch: string | null;
  dirty: boolean | null;
  /** The recording's file in the product repo: `design/data/sample/recording.json`, or one under `design/data/local/`. */
  recording: string | null;
  recording_name: string | null;
  private: boolean;
  size: number;
  files: number;
  pages: number;
  options: boolean;
  published_at: string;
  published_from: string | null;
  share: { on: boolean; url?: string | null };
}

/**
 * A manifest page (`web/design/scripts/build.mjs`): its name, its route in the product, the path it opens at and
 * its states (each a link at `<entry>?state=<key>`; the build's front page lists them). The manifest's first page
 * is the build's front page, `All pages` (`/`), and the viewer lists the pages in the manifest's order.
 */
export interface DesignManifestPage {
  name: string;
  route?: string;
  entry: string;
  states?: { key: string; label: string }[];
}

/** A named decision's options page: its entry and each direction, `?direction=<key>` opening one. */
export interface DesignOptions {
  name: string | null;
  entry: string;
  directions: { key: string; label: string; entry: string }[];
}

export interface DesignManifest {
  pages?: DesignManifestPage[];
  options?: DesignOptions;
  /**
   * The pages the round made (`sikstack design-publish --page`): their entries. With one, the build's viewer lists
   * only those pages and links to every page (`designPagesHref`); a build published without one has none.
   */
  round?: { pages: string[] };
}

/** A build's address in the app: its viewer. */
export function designHref(project: string, build?: string): string {
  const list = `/projects/${encodeURIComponent(project)}/design`;
  return build ? `${list}/${encodeURIComponent(build)}` : list;
}

/** A build's every-page list: `/projects/<id>/design/<build>/pages`, every manifest page whatever its round. */
export function designPagesHref(project: string, build: string): string {
  return `${designHref(project, build)}/pages`;
}

/**
 * The round's pages: the manifest pages whose entry its `round` names, in the manifest's order (an entry the
 * manifest lacks is ignored), or null when the build has no round (none, an empty or invalid one, or one naming no
 * page the manifest holds): then the viewer lists every page, as before rounds.
 */
export function roundPages(manifest: DesignManifest): DesignManifestPage[] | null {
  const round = (manifest as { round?: unknown }).round;
  const named =
    round !== null && typeof round === "object" ? (round as { pages?: unknown }).pages : undefined;
  if (!Array.isArray(named)) return null;
  const set = new Set(named.filter((e): e is string => typeof e === "string"));
  if (set.size === 0) return null;
  const pages = (manifest.pages ?? []).filter((p) => set.has(p.entry));
  return pages.length > 0 ? pages : null;
}

/**
 * A build's page, opened on the build's own host: the app's open route mints a member ticket and answers a 303
 * there (`src/app/api/design/open/route.ts`).
 */
export function designOpenHref(project: string, build: string, path: string): string {
  const q = new URLSearchParams({ project, build, path });
  return `/api/design/open?${q.toString()}`;
}

/**
 * A page's share link: the build's share link (`<design origin>/_share/<token>`), landing on that page
 * (`?next=<entry>`, the entry URL-encoded). The design origin honours `next` once the link has set its cookie;
 * the build's front page lists every state, so a page's link is enough (no link per state).
 */
export function pageShareUrl(shareUrl: string, entry: string): string {
  return `${shareUrl}${shareUrl.includes("?") ? "&" : "?"}next=${encodeURIComponent(entry)}`;
}

/** The tallest height a framed direction may ask for, in CSS pixels: a guard against a runaway page. */
export const MAX_FRAME_HEIGHT = 40_000;

/**
 * The height a direction's frame takes from a `message` event, or null to change nothing. Only a message from that
 * frame's own window (`e.source`) and from the build's origin (`e.origin`) counts, carrying
 * `{ designHeight: <positive number> }` (the options page posts it when framed, again on resize). A message from any
 * other window or origin, the app's included, is ignored.
 */
export function framedHeight(
  e: { source: unknown; origin: string; data: unknown },
  own: { window: unknown; origin: string | null },
): number | null {
  if (!own.origin || own.window === null || own.window === undefined) return null;
  if (e.source !== own.window || e.origin !== own.origin) return null;
  const v =
    e.data !== null && typeof e.data === "object"
      ? (e.data as { designHeight?: unknown }).designHeight
      : undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return Math.min(Math.ceil(v), MAX_FRAME_HEIGHT);
}

/** A commit's short form: its first 7 characters. */
export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** A build's title: its short commit, or the id's head when the build has none. */
export function buildTitle(build: Pick<DesignBuild, "id" | "commit">): string {
  return DESIGN.buildTitle(shortCommit(build.commit) ?? build.id.slice(0, 8));
}

/** The recording, in a word: the sample's, or Private for a real project's. */
export function recordingWord(build: Pick<DesignBuild, "private" | "recording_name">): string {
  if (build.private) return DESIGN.private;
  if (!build.recording_name || build.recording_name === "sample") return DESIGN.sample;
  return build.recording_name;
}
