/**
 * The design build's mark. Every recording carries it (`"$design"`), the browser store keys its
 * `localStorage` with it and the frame stamps it on the page, so the production-exclusion check
 * (`design/scripts/check-production.mjs`) can prove a production build holds none of the design.
 */
export const DESIGN_MARK = "sikstack-design-build";

/**
 * The build's stamp: a hash of the recording, the state answers and the store's own files, set at build time by
 * `next.config.ts`. The browser store keeps it in every snapshot and drops a snapshot stamped by another build.
 */
export const DESIGN_STAMP: string = process.env.DESIGN_STAMP ?? "unstamped";

/** The browser store's `localStorage` key, one per recording; the snapshot under it carries `DESIGN_STAMP`. */
export function storeKey(recording: string): string {
  return `${DESIGN_MARK}:agenda:${recording}`;
}
