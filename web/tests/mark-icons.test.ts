import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { beforeAll, describe, expect, it } from "vitest";

import {
  HOME_SIZE,
  MARK,
  TAB_PX,
  TAB_SIZES,
  homeIcon,
  packIco,
  tabIcon,
  type TabSize,
} from "@/lib/mark/mark";

// P87 — sikstack's mark as files (direction C, "Live dot", signed in `web/design`): the tab icons' own pixels
// against S1's signed table, the 180 px icon, and `public/favicon.ico` byte-equal to the tab renders.
// `SIKSTACK_REPACK_FAVICON=1 pnpm --dir web exec vitest run tests/mark-icons.test.ts` repacks it after a change
// to the drawing; `SIKSTACK_MARK_DUMP=<dir>` writes the renders there to look at.

const WEB = join(__dirname, "..");
const FAVICON = join(WEB, "public/favicon.ico");

interface Png {
  w: number;
  h: number;
  px: Buffer;
}

/** An RGBA8, non-interlaced PNG's pixels (what `ImageResponse` writes). */
function decode(buf: Buffer): Png {
  let o = 8;
  let w = 0;
  let h = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0)
        throw new Error("not a non-interlaced RGBA8 PNG");
    }
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, px };
}

const hex = (p: Png, x: number, y: number) => {
  const i = (y * p.w + x) * 4;
  return [0, 1, 2, 3]
    .map((k) => p.px[i + k].toString(16).padStart(2, "0"))
    .join("");
};
const GROUND = `${MARK.ground.slice(1)}ff`;
const INK = `${MARK.ink.slice(1)}ff`;
const DOT = `${MARK.dot.slice(1)}ff`;
/** How much of a pixel the ink covers, over the white ground (0 to 1, from its red channel); a cut corner, none. */
const inkCover = (p: Png, x: number, y: number) => {
  const i = (y * p.w + x) * 4;
  return p.px[i + 3] < 255 ? 0 : (255 - p.px[i]) / (255 - 0x14);
};
/** A pixel nearer the accent than the ink or the ground: blue clearly over red. */
const isAccent = (p: Png, x: number, y: number) => {
  const i = (y * p.w + x) * 4;
  return p.px[i + 2] - p.px[i] > 0x40;
};

async function png(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

const renders = new Map<number, Buffer>();
beforeAll(async () => {
  for (const side of TAB_SIZES) renders.set(side, await png(tabIcon(side)));
  renders.set(HOME_SIZE, await png(homeIcon()));
  const dump = process.env.SIKSTACK_MARK_DUMP;
  if (dump)
    for (const [side, buf] of renders)
      writeFileSync(join(dump, `icon-${side}.png`), buf);
  if (process.env.SIKSTACK_REPACK_FAVICON === "1")
    writeFileSync(
      FAVICON,
      packIco(TAB_SIZES.map((side) => ({ side, png: renders.get(side)! }))),
    );
});

describe("the tab icons, in their own pixels (S1's table)", () => {
  for (const side of TAB_SIZES) {
    const spec = TAB_PX[side as TabSize];
    describe(`${side} px`, () => {
      let p: Png;
      beforeAll(() => {
        p = decode(renders.get(side)!);
      });

      it("is the side square, ground white, corners an eighth of the side", () => {
        expect([p.w, p.h]).toEqual([side, side]);
        expect(hex(p, side / 2, 1)).toBe(GROUND);
        expect(hex(p, side / 2, side - 2)).toBe(GROUND);
        // the corner pixel is cut; one pixel past the radius, along either edge, is ground
        for (const [x, y] of [
          [0, 0],
          [side - 1, 0],
          [0, side - 1],
          [side - 1, side - 1],
        ])
          expect(
            p.px[(y * side + x) * 4 + 3],
            `alpha at ${x},${y}`,
          ).toBeLessThan(255);
        expect(hex(p, side / 8 + 1, 0)).toBe(GROUND);
        expect(hex(p, 0, side / 8 + 1)).toBe(GROUND);
      });

      it(`sets the letters at ${spec.font} px in ink, on the baseline row ${spec.base}`, () => {
        let top: number = side;
        let low = -1;
        let solid = 0;
        for (let y = 0; y < side; y++)
          for (let x = 0; x < side; x++) {
            if (inkCover(p, x, y) > 0.5 && !isAccent(p, x, y)) {
              top = Math.min(top, y);
              low = Math.max(low, y);
            }
            if (hex(p, x, y) === INK) solid++;
          }
        expect(low, "the letters end on the row over the baseline").toBe(
          spec.base - 1,
        );
        // k's ascender is 0.740 em over the baseline: the topmost row more than half inked holds it
        expect(Math.abs(top - (spec.base - 0.74 * spec.font))).toBeLessThan(1);
        expect(solid, "pixels of solid ink").toBeGreaterThan(0);
      });

      it(`draws the dot, ${spec.dot} px, ${spec.foot} px over the baseline, centred on the stem, the glyph's own cut away`, () => {
        const accent: [number, number][] = [];
        for (let y = 0; y < side; y++)
          for (let x = 0; x < side; x++)
            if (isAccent(p, x, y)) accent.push([x, y]);
        const xs = accent.map(([x]) => x);
        const ys = accent.map(([, y]) => y);
        const [left, right] = [Math.min(...xs), Math.max(...xs)];
        const [top, foot] = [Math.min(...ys), Math.max(...ys)];
        expect([right - left + 1, foot - top + 1]).toEqual([
          spec.dot,
          spec.dot,
        ]);
        expect(foot, "the dot's foot").toBe(spec.base - spec.foot - 1);
        // its middle pixels are the accent itself; at 2 px it is a square, above that a disc (its corners not solid)
        const c = spec.dot / 2;
        for (const [dx, dy] of [
          [c - 1, c - 1],
          [c, c - 1],
          [c - 1, c],
          [c, c],
        ])
          expect(hex(p, left + dx, top + dy)).toBe(DOT);
        if (spec.dot === 2) expect(accent).toHaveLength(4);
        else expect(hex(p, left, top)).not.toBe(DOT);

        // the stem, read in its body two rows over the baseline: its ink's centre, beside the dot's
        const dotMid = left + spec.dot / 2;
        let sum = 0;
        let weight = 0;
        // the columns the stem touches, half a pixel either side of it, short of the s and the k
        const reach = 0.064 * spec.font + 0.5;
        const cols: number[] = [];
        for (let x = 0; x < side; x++)
          if (Math.abs(x + 0.5 - dotMid) <= reach) cols.push(x);
        for (const x of cols) {
          const k = inkCover(p, x, spec.base - 2);
          sum += (x + 0.5) * k;
          weight += k;
        }
        const stemMid = sum / weight;
        expect(
          Math.abs(stemMid - dotMid),
          "dot centred on the stem",
        ).toBeLessThanOrEqual(0.5);
        // the stem is 0.128 em wide (the TTF: 74 to 202)
        expect(Math.abs(weight - 0.128 * spec.font)).toBeLessThan(0.35);
        if (spec.edge) {
          // at 16 its left edge is on a pixel's edge: one solid column, the column before it clear (the
          // rasteriser's filter leaves under 5% there)
          const edge = Math.round(stemMid - 0.064 * spec.font);
          for (let y = spec.base - 4; y < spec.base; y++) {
            expect(hex(p, edge, y), `solid stem at ${edge},${y}`).toBe(INK);
            expect(inkCover(p, edge - 1, y)).toBeLessThan(0.05);
          }
        }

        // between the dot and the stem's top (0.522 em), and over the stem up to the top: ground, the dot aside
        const stemTop = Math.floor(spec.base - 0.522 * spec.font);
        for (let y = 0; y < stemTop; y++)
          for (const x of cols) {
            if (x >= left && x <= right && y >= top && y <= foot) continue;
            // ground, but for the rasteriser's filter at a shape's edge (under 5%)
            expect(inkCover(p, x, y), `ground at ${x},${y}`).toBeLessThan(0.05);
          }
      });
    });
  }
});

describe("the home-screen icon (180 px)", () => {
  let p: Png;
  beforeAll(() => {
    p = decode(renders.get(HOME_SIZE)!);
  });

  it("is a full square of the ground: iOS cuts its corners", () => {
    expect([p.w, p.h]).toEqual([180, 180]);
    for (const [x, y] of [
      [0, 0],
      [179, 0],
      [0, 179],
      [179, 179],
    ])
      expect(hex(p, x, y)).toBe(GROUND);
  });

  it("sets the letters at 96 px, centred, with the glyph's own dot in the accent", () => {
    let [l, r, t, b] = [180, -1, 180, -1];
    let blue = 0;
    for (let y = 0; y < 180; y++)
      for (let x = 0; x < 180; x++) {
        if (isAccent(p, x, y)) blue++;
        if (inkCover(p, x, y) > 0.5 || isAccent(p, x, y)) {
          [l, r, t, b] = [
            Math.min(l, x),
            Math.max(r, x),
            Math.min(t, y),
            Math.max(b, y),
          ];
        }
      }
    // the i's dot tops the letters at 0.746 em, the baseline under them
    expect(Math.abs(b + 1 - t - 0.746 * 96)).toBeLessThan(2);
    expect(Math.abs((l + r + 1) / 2 - 90), "centred across").toBeLessThan(3);
    expect(Math.abs((t + b + 1) / 2 - 90), "centred down").toBeLessThan(4);
    // the accent is only the dot: a round of about (0.15 em)² · π/4 ≈ 160 px, and none of it under the cut
    expect(blue).toBeGreaterThan(120);
    const cut = b + 1 - 0.5625 * 96;
    for (let y = Math.ceil(cut); y < 180; y++)
      for (let x = 0; x < 180; x++)
        expect(isAccent(p, x, y), `accent at ${x},${y}`).toBe(false);
  });
});

describe("the shared image (`/opengraph-image`, `/twitter-image`)", () => {
  it("draws today's layout in Plex, the name's i dot in the accent and nothing else blue", async () => {
    const { shareImage } = await import("@/app/(marketing)/share-image");
    const res = shareImage();
    const buf = await png(res);
    const dump = process.env.SIKSTACK_MARK_DUMP;
    if (dump) writeFileSync(join(dump, "share.png"), buf);
    const p = decode(buf);
    expect([p.w, p.h]).toEqual([1200, 630]);
    // the name, 44 px SemiBold from the padding's corner (96, 88): its ink spans Plex's advances, s's left
    // bearing (0.029 em) to the last k's right edge (3.839 em)
    let [l, r] = [1200, -1];
    const blue: [number, number][] = [];
    for (let y = 88; y < 88 + 44; y++)
      for (let x = 0; x < 600; x++) {
        if (inkCover(p, x, y) > 0.5) [l, r] = [Math.min(l, x), Math.max(r, x)];
      }
    for (let y = 0; y < 630; y++)
      for (let x = 0; x < 1200; x++) if (isAccent(p, x, y)) blue.push([x, y]);
    expect(Math.abs(l - (96 + 0.029 * 44))).toBeLessThan(1.5);
    expect(Math.abs(r + 1 - (96 + 3.839 * 44))).toBeLessThan(1.5);
    // the dot: over the i (its origin 0.499 em in, the dot 0.063 to 0.213 em of it), above the stem
    expect(blue.length).toBeGreaterThan(30);
    const iAt = 96 + 0.499 * 44;
    for (const [x, y] of blue) {
      expect(x).toBeGreaterThanOrEqual(Math.floor(iAt + 0.063 * 44) - 1);
      expect(x).toBeLessThanOrEqual(Math.ceil(iAt + 0.213 * 44) + 1);
      expect(y).toBeLessThan(88 + 44);
    }
  });
});

describe("public/favicon.ico", () => {
  it("packs the three tab renders, byte for byte (repack with SIKSTACK_REPACK_FAVICON=1)", () => {
    const ico = readFileSync(FAVICON);
    expect(ico.readUInt16LE(2), "an icon").toBe(1);
    expect(ico.readUInt16LE(4), "three images").toBe(3);
    const entries = TAB_SIZES.map((side, n) => {
      const e = 6 + 16 * n;
      const size = ico.readUInt32LE(e + 8);
      const at = ico.readUInt32LE(e + 12);
      return { w: ico[e], h: ico[e + 1], png: ico.subarray(at, at + size) };
    });
    for (const [n, side] of TAB_SIZES.entries()) {
      expect([entries[n].w, entries[n].h]).toEqual([side, side]);
      expect(
        entries[n].png.equals(renders.get(side)!),
        `the ${side} px entry`,
      ).toBe(true);
    }
    expect(
      ico.equals(
        packIco(TAB_SIZES.map((side) => ({ side, png: renders.get(side)! }))),
      ),
    ).toBe(true);
  });
});

describe("web/public", () => {
  it("holds no SVG and no old mark", () => {
    const pub = join(WEB, "public");
    expect(readdirSync(pub).filter((f) => f.endsWith(".svg"))).toEqual([]);
    expect(existsSync(join(pub, "logo.svg"))).toBe(false);
    expect(existsSync(join(pub, "apple-touch-icon.png"))).toBe(false);
  });
});
