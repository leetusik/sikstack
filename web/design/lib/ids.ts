import { AGENDA_ID } from "@/lib/workspace/rules";

/**
 * The agenda ids the browser store mints, by the engine's rule (`AGENDA_ID`): the next numbers after
 * the recording's highest, each with a fixed two-symbol tail. They are known at build time, so the
 * static build has a page for each of the first `POOL` items added in the browser.
 */
export const POOL = 30;

/** Tail letters: lowercase Crockford base32 letters, without `i l o u`. */
const LETTERS = "abcdefghjkmnpqrstvwxyz";

/** An id's number (`A7-m3` → 7); 0 when it has none. */
export function idNumber(id: string): number {
  const m = /^A([0-9]+)-/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** The highest number among the ids. */
export function topNumber(ids: readonly string[]): number {
  return ids.reduce((top, id) => Math.max(top, idNumber(id)), 0);
}

/** The `k`-th id minted after `top` (0 first). Throws if it breaks the engine's rule. */
export function mintedId(top: number, k: number): string {
  const n = top + 1 + k;
  const id = `A${n}-${LETTERS[n % LETTERS.length]}${n % 10}`;
  if (!AGENDA_ID.test(id)) throw new Error(`minted id ${id} breaks AGENDA_ID`);
  return id;
}

/** The ids the first `POOL` adds take, for the static item pages. */
export function mintPool(ids: readonly string[], size = POOL): string[] {
  const top = topNumber(ids);
  return Array.from({ length: size }, (_, k) => mintedId(top, k));
}
