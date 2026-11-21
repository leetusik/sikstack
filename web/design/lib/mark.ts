/**
 * The design build's mark. Every recording carries it (`"$design"`), the browser store keys its
 * `localStorage` with it and the frame stamps it on the page, so the production-exclusion check
 * (`design/scripts/check-production.mjs`) can prove a production build holds none of the design.
 */
export const DESIGN_MARK = "sikstack-design-build";

/** The browser store's `localStorage` key, one per recording. */
export function storeKey(recording: string): string {
  return `${DESIGN_MARK}:agenda:${recording}`;
}
