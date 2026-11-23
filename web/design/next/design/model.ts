// The Design service's rules as pure functions (P77): what a build's row and its viewer show, from the members'
// routes of `server/design_api.py` (`GET /app/projects/{id}/design/builds` → `{builds}`, `GET …/builds/{build}` →
// `{build, manifest}`). No React and no I/O.

import { DESIGN } from "../content/design";

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

/** A manifest page (`web/design/scripts/build.mjs`): its name, its route in the product and the path it opens at. */
export interface DesignManifestPage {
  name: string;
  route?: string;
  entry: string;
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
}

/** A build's address in the app: its viewer. */
export function designHref(project: string, build?: string): string {
  const list = `/projects/${encodeURIComponent(project)}/design`;
  return build ? `${list}/${encodeURIComponent(build)}` : list;
}

/**
 * A build's page, opened on the build's own host: the app's open route mints a member ticket and answers a 303
 * there (`src/app/api/design/open/route.ts`).
 */
export function designOpenHref(project: string, build: string, path: string): string {
  const q = new URLSearchParams({ project, build, path });
  return `/api/design/open?${q.toString()}`;
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
