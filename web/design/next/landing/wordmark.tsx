// Applied: `@/content/marketing` (this design keeps the new words at `next/content/marketing/landing.ts`).
import { LANDING } from "../content/marketing/landing";

/**
 * sikstack's name as the landing's header draws it (the "sik" mark's design, direction C, "Live dot"; new,
 * applied as `src/sikstack/landing/wordmark.tsx`): the name as text, as it was, with the dot of the mark's i in
 * the accent (`landing.css` section 10). Live text in the house face: no image and no tile, so it follows the
 * scheme and the text size. It goes inside the header's `.mark.lp-mark` link, which gives it its size, weight
 * and row. The link is a flex row, so the name is one span, one flex item: split into three items it would be
 * read out, and copied, as "s i kstack".
 */
export function Wordmark() {
  const { wordmark, mark } = LANDING;
  const at = mark.indexOf("i");
  return (
    <span>
      {wordmark.slice(0, at)}
      <span className="lp-dot">{wordmark.slice(at, at + 1)}</span>
      {wordmark.slice(at + 1)}
    </span>
  );
}
