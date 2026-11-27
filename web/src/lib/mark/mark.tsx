import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ImageResponse } from "next/og";
import type { CSSProperties } from "react";

/**
 * sikstack's mark as a raster (P87, direction C, "Live dot", signed in `web/design`): lowercase "sik" in IBM Plex
 * Sans SemiBold, ink letters on the surface, the dot of the i in the accent. On a page the mark is live text
 * (`@/sikstack/landing/wordmark`); where a file is required it is an `ImageResponse` of the same drawing:
 * `app/icon.tsx` (the tab sizes 16, 32 and 48), `app/apple-icon.tsx` and `app/apple-touch-icon.png/` (180), and
 * the landing's shared image (`app/(marketing)/share-image.tsx`). `public/favicon.ico` packs the three tab PNGs
 * (`packIco`); `tests/mark-icons.test.ts` holds it byte-equal to these renders and holds the pixels below.
 * A raster cannot read the CSS tokens, so the colours are values here, outside `src/sikstack/` (whose code names
 * no colour but through `tokens.css`).
 *
 * The faces are IBM's own TTFs (`./fonts/`, from the `@ibm/plex-sans@1.3.6` release of github.com/IBM/plex, under
 * the SIL Open Font License 1.1 that `public/fonts/plex/IBMPlex-OFL.txt` carries): `ImageResponse` reads TTF, OTF
 * and WOFF, not the WOFF2 the pages load. They are read from the working directory (`web/`) when an image is
 * drawn; every image here is drawn at build time.
 */

/** The mark's colours: `tokens.css`'s light `--surface`, `--ink` and `--accent`. There is no dark-scheme icon. */
export const MARK = { ground: "#ffffff", ink: "#14171c", dot: "#1d4ed8" };

/**
 * C at the tab sizes, in the file's own pixels (S1's signed table, the options page's `PX`): the letters' size,
 * the baseline's row, the drawn dot's side (a square at 2 px, a disc above) and its foot's height over the
 * baseline. At 16 the stem's left edge sits on a pixel's edge; at 32 and 48 its middle does.
 */
export const TAB_PX = {
  16: { font: 10.5, base: 12, dot: 2, foot: 7, edge: true },
  32: { font: 21, base: 24, dot: 4, foot: 13, edge: false },
  48: { font: 31.5, base: 36, dot: 6, foot: 19, edge: false },
} as const;
export type TabSize = keyof typeof TAB_PX;
export const TAB_SIZES = [16, 32, 48] as const satisfies readonly TabSize[];

/**
 * Plex Sans SemiBold, in em, read from the TTF (its `hmtx` and the i's outline in `glyf`): the advances of s, i
 * and k, the i's stem (74 to 202: its middle from the i's origin and half its width), and the height over the
 * baseline of the gap between the stem (to 0.522) and the glyph's own dot (from 0.598), where the glyph is cut
 * (the options page's 0.5625). The options page's `I` read the stem from the browser as 0.1375 ± 0.0675. `ascent` is the face's hhea
 * ascender and `descent` its descender: a text line of `lineHeight` 1 puts the baseline `(1 + ascent - descent)
 * / 2` em under its top, as a browser does.
 */
const PLEX = {
  s: 0.499,
  i: 0.276,
  k: 0.562,
  stemMid: 0.138,
  stemHalf: 0.064,
  cut: 0.5625,
  ascent: 1.025,
  descent: 0.275,
};
const BASELINE = (1 + PLEX.ascent - PLEX.descent) / 2;

const FONTS = join(process.cwd(), "src/lib/mark/fonts");
let faces: { semibold: Buffer; regular: Buffer } | null = null;

/** The two faces, read once. */
export function plexFaces() {
  faces ??= {
    semibold: readFileSync(join(FONTS, "IBMPlexSans-SemiBold.ttf")),
    regular: readFileSync(join(FONTS, "IBMPlexSans-Regular.ttf")),
  };
  return faces;
}

/** `ImageResponse`'s `fonts`: Plex Sans at 600 and 400. */
export function plexFonts() {
  const { semibold, regular } = plexFaces();
  return [
    {
      name: "IBM Plex Sans",
      data: semibold,
      weight: 600 as const,
      style: "normal" as const,
    },
    {
      name: "IBM Plex Sans",
      data: regular,
      weight: 400 as const,
      style: "normal" as const,
    },
  ];
}

/**
 * The i that carries its own dot in the accent (the 180 px icon, the shared image; the header's `.lp-dot`): one
 * glyph, two paints clipped to it, a hard stop between the dot and the stem. The stops are explicit: the
 * renderer draws the two-position shorthand (`#1d4ed8 0 35.5%`) as one colour. The span's box is its line, one
 * em at `lineHeight` 1, so the stop sits `BASELINE - cut` em under its top.
 */
export function dotI(ink: string, dot: string): CSSProperties {
  const at = `${((BASELINE - PLEX.cut) * 100).toFixed(2)}%`;
  return {
    display: "flex",
    lineHeight: 1,
    backgroundImage: `linear-gradient(to bottom, ${dot} 0%, ${dot} ${at}, ${ink} ${at}, ${ink} 100%)`,
    backgroundClip: "text",
    color: "transparent",
  };
}

/**
 * A box at a fractional position. The layout engine rounds a box's place to whole pixels (measured: a `left` of
 * 0.63 drew at 1), so the whole pixels go in `left` and `top` and the rest in a translation, which it keeps.
 */
function at(x: number, y: number): CSSProperties {
  const [left, top] = [Math.floor(x), Math.floor(y)];
  const [dx, dy] = [x - left, y - top];
  return {
    position: "absolute",
    display: "flex",
    left,
    top,
    ...(dx || dy ? { transform: `translate(${dx}px, ${dy}px)` } : {}),
  };
}

/** C at a tab size: the letters on a pixel grid, the glyph's own dot cut away and a drawn dot in its place. */
export function tabIcon(side: TabSize): ImageResponse {
  const spec = TAB_PX[side];
  const em = spec.font;
  const w = (PLEX.s + PLEX.i + PLEX.k) * em;
  const s = PLEX.s * em;
  // The stem (its edge or its middle) on a pixel's edge, the nearest to where centring the three letters puts it.
  const off = spec.edge ? PLEX.stemHalf * em : 0;
  const mid = Math.round((side - w) / 2 + s + PLEX.stemMid * em - off) + off;
  const x0 = mid - s - PLEX.stemMid * em;
  const top = spec.base - spec.foot - spec.dot;
  return new ImageResponse(
    <div
      style={{
        width: side,
        height: side,
        display: "flex",
        position: "relative",
        background: MARK.ground,
        borderRadius: side / 8,
      }}
    >
      <div
        style={{
          // the renderer puts a line's baseline a whole number of pixels under its top (measured: 28 for
          // 27.56 at 31.5 px), so the top is the baseline's row less that rounding
          ...at(x0, spec.base - Math.round(BASELINE * em)),
          fontFamily: "IBM Plex Sans",
          fontWeight: 600,
          fontSize: em,
          lineHeight: 1,
          color: MARK.ink,
        }}
      >
        sik
      </div>
      {/* the glyph's own dot goes: the ground over the i's column, down to the cut */}
      <div
        style={{
          ...at(x0 + s, 0),
          width: PLEX.i * em,
          height: Math.round(spec.base - PLEX.cut * em),
          background: MARK.ground,
        }}
      />
      {/* the drawn dot takes its place: Plex's dot is round, so a disc; at 2 px a disc is a blur, so a square */}
      <div
        style={{
          ...at(Math.round(mid - spec.dot / 2), top),
          width: spec.dot,
          height: spec.dot,
          background: MARK.dot,
          borderRadius: spec.dot >= 4 ? spec.dot / 2 : 0,
        }}
      />
    </div>,
    { width: side, height: side, fonts: plexFonts() },
  );
}

/** The home-screen icon, 180 px: a full square (iOS cuts the corners), the letters at 96 px, centred, the glyph's own dot in the accent. */
export const HOME_SIZE = 180;
export function homeIcon(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: HOME_SIZE,
        height: HOME_SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: MARK.ground,
        color: MARK.ink,
        fontFamily: "IBM Plex Sans",
        fontWeight: 600,
        fontSize: 96,
        lineHeight: 1,
        letterSpacing: "-0.02em",
      }}
    >
      {/* the letters have ascenders and no descenders: lifted so the block of them sits on the middle */}
      <div style={{ display: "flex", paddingBottom: "0.04em" }}>
        <span>s</span>
        <span style={dotI(MARK.ink, MARK.dot)}>i</span>
        <span>k</span>
      </div>
    </div>,
    { width: HOME_SIZE, height: HOME_SIZE, fonts: plexFonts() },
  );
}

/**
 * A PNG-in-ICO file (`ICONDIR`, one 16-byte `ICONDIRENTRY` per image, then each PNG verbatim): how
 * `public/favicon.ico` is packed from the tab icons, smallest first.
 */
export function packIco(pngs: { side: number; png: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ side, png }, n) => {
    const e = 6 + 16 * n;
    head.writeUInt8(side >= 256 ? 0 : side, e);
    head.writeUInt8(side >= 256 ? 0 : side, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.png)]);
}
