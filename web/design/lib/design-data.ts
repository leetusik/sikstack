import type { StaticImageData } from "next/image";

import emptyRaw from "../data/sample/states/design-empty.json";
import manyRaw from "../data/sample/states/design-many.json";
import oneRaw from "../data/sample/states/design-one.json";
import privateRaw from "../data/sample/states/design-private.json";
import sharedRaw from "../data/sample/states/design-shared.json";
import shotA from "../data/sample/design/options-a.png";
import shotB from "../data/sample/design/options-b.png";
import shotC from "../data/sample/design/options-c.png";
import type { DesignBuild, DesignManifest } from "@/sikstack/design/model";

import { RECORDING } from "./recording";

/**
 * The Design service's answers (`design/scripts/record.mjs --design`), recorded from the local stack's members'
 * routes after builds were published into a sample project with the branch's engine (`sikstack design-publish`):
 *
 * - the recording's `design` part: the list of five builds (one shared, one private from a `--data local/acme`
 *   build, one with an options page from a tree with uncommitted changes, one from `main`), each build's own
 *   answer (`{build, manifest}`), the 409 line sharing the private one answered, and the 404 a deleted build's
 *   address answered;
 * - `states/design-*.json`: the list as it was at each step: before any publish (`empty`), after the first
 *   (`one`), with that build shared (`shared`), after the private build (`private`), at the end (`many`).
 *
 * Two things are stand-ins, said here: a direction's frame (production frames the build's own host, which a static
 * build has not) is the recorded screenshot of that direction at 360 px (`data/sample/design/options-<key>.png`,
 * taken through the member open route), and a share link the design turns on is made from the build's address
 * and the recorded links' fixed token (the API mints a new one each time).
 */

export interface DesignDetail {
  build: DesignBuild;
  manifest: DesignManifest;
}

interface DesignPart {
  builds: DesignBuild[];
  details: Record<string, DesignDetail>;
  shareRefused: Record<string, string>;
  gone: { build: string; status: number; detail: string | null };
}

const part = (RECORDING as unknown as { design?: DesignPart }).design;
if (!part || !Array.isArray(part.builds) || !part.details || !part.gone)
  throw new Error("the recording has no design part: record it with design:record --design");
export const DESIGN_PART: DesignPart = part;

const listOf = (raw: unknown): DesignBuild[] => (raw as { design: { builds: DesignBuild[] } }).design.builds;

/** The list the Design list's states draw, by state key. */
export const DESIGN_LISTS = {
  many: listOf(manyRaw),
  one: listOf(oneRaw),
  shared: listOf(sharedRaw),
  private: listOf(privateRaw),
  empty: listOf(emptyRaw),
} as const;

/** The viewer's states: what kind of build a recorded build is. */
export type BuildKind = "no-options" | "options" | "shared" | "private";

export function kindOf(build: DesignBuild): BuildKind {
  if (build.private) return "private";
  if (build.share.on) return "shared";
  return build.options ? "options" : "no-options";
}

/** Every build page the design draws: each recorded build, and the deleted one (drawn gone). */
export function buildPageIds(): string[] {
  return [...part!.builds.map((b) => b.id), part!.gone.build];
}

/** The build a viewer state draws on a build's page: the page's own when it is in that state, else the first recorded build that is. */
export function detailFor(kind: BuildKind, own: string): DesignDetail {
  const mine = part!.details[own];
  if (mine && kindOf(mine.build) === kind) return mine;
  const b = part!.builds.find((x) => kindOf(x) === kind);
  if (!b) throw new Error(`no recorded build is ${kind}`);
  return part!.details[b.id];
}

/** Made, not recorded: the share link a turned-on build shows, the recorded links' shape and fixed token. */
export function madeShareUrl(build: DesignBuild): string | null {
  const recorded = part!.builds.find((b) => b.share.url)?.share.url;
  const token = recorded ? recorded.slice(recorded.lastIndexOf("/") + 1) : null;
  return build.url && token ? `${build.url.replace(/\/?$/, "/")}_share/${token}` : null;
}

/** A direction's recorded screenshot, for its frame. */
export const DIRECTION_SHOTS: Record<string, StaticImageData> = { a: shotA, b: shotB, c: shotC };
