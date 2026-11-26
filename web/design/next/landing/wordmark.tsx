// Applied: `@/content/marketing` (this design keeps the new words at `next/content/marketing/landing.ts`).
import { LANDING } from "../content/marketing/landing";

/**
 * sikstack's mark and name, as the landing's header draws them (the "sik" mark's design; new, applied as
 * `src/sikstack/landing/wordmark.tsx`): the name's first syllable on the mark's tile, then the rest of the
 * name, so it still reads, and is read out, as one word. Live text in the house face on a ground CSS draws
 * (`landing.css` section 10): no image, so it follows the scheme and the text size. It goes inside the
 * header's `.mark.lp-mark` link, which gives it its size, weight and row.
 */
export function Wordmark() {
  const { wordmark, mark } = LANDING;
  return (
    <>
      <span className="lp-sik">{mark}</span>
      <span>{wordmark.slice(mark.length)}</span>
    </>
  );
}
