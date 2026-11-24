import { describe, expect, it } from "vitest";

import { shareRefusal } from "@/lib/design/share";
import { framedHeight, MAX_FRAME_HEIGHT, pageShareUrl } from "@/sikstack/design/model";

// P77 — the Design viewer's rules: a page's share link, the frame height it accepts, and the share
// change's answers.

describe("a page's share link", () => {
  const share = "http://bx.design.sikstack.localhost:3061/_share/tok123";
  it("lands on the page: ?next=<entry>, URL-encoded", () => {
    expect(pageShareUrl(share, "/")).toBe(`${share}?next=%2F`);
    expect(pageShareUrl(share, "/projects/p 1/design/?a=b&c")).toBe(
      `${share}?next=%2Fprojects%2Fp%201%2Fdesign%2F%3Fa%3Db%26c`,
    );
    expect(pageShareUrl(`${share}?x=1`, "/a/")).toBe(`${share}?x=1&next=%2Fa%2F`);
  });
});

describe("a direction frame's height", () => {
  const own = { window: { frame: 1 }, origin: "http://bx.design.sikstack.localhost:3061" };
  const msg = (over: Partial<{ source: unknown; origin: string; data: unknown }> = {}) => ({
    source: own.window,
    origin: own.origin,
    data: { designHeight: 1409.2 },
    ...over,
  });

  it("is taken from its own frame's window and the build's origin", () => {
    expect(framedHeight(msg(), own)).toBe(1410);
  });

  it("ignores a message from any other window or origin", () => {
    expect(framedHeight(msg({ source: { frame: 2 } }), own)).toBeNull();
    expect(framedHeight(msg({ source: null }), own)).toBeNull();
    expect(framedHeight(msg({ origin: "http://sikstack.localhost:3030" }), own)).toBeNull();
    expect(framedHeight(msg({ origin: "http://bother.design.sikstack.localhost:3061" }), own)).toBeNull();
    expect(framedHeight(msg({ origin: "null" }), own)).toBeNull();
    expect(framedHeight(msg(), { window: own.window, origin: null })).toBeNull();
    expect(framedHeight(msg({ source: undefined }), { window: undefined, origin: own.origin })).toBeNull();
  });

  it("takes only a positive, finite designHeight, capped", () => {
    for (const data of [null, "1200", { designHeight: "1200" }, { designHeight: 0 }, { designHeight: -5 }, { designHeight: Infinity }, { designHeight: NaN }, {}])
      expect(framedHeight(msg({ data }), own)).toBeNull();
    expect(framedHeight(msg({ data: { designHeight: 1e9 } }), own)).toBe(MAX_FRAME_HEIGHT);
  });
});

describe("a share change's refusal", () => {
  it("is the private line on 409, else its own reason or failed", () => {
    expect(shareRefusal(409)).toEqual({ ok: false, reason: "private" });
    expect(shareRefusal(404)).toEqual({ ok: false, reason: "not-found" });
    expect(shareRefusal(401)).toEqual({ ok: false, reason: "signed-out" });
    for (const status of [null, 500, 502, 503, 400])
      expect(shareRefusal(status)).toEqual({ ok: false, reason: "failed" });
  });
});
