import { describe, expect, it } from "vitest";

import {
  parseShareCookie,
  SHARE_KEEP,
  shareHeaderValue,
  withShareToken,
} from "@/lib/sharing/cookie";
import { asShareTarget, sharePath, shareChangeRefusal } from "@/lib/sharing/model";

const T = (c: string) => c.repeat(32);

describe("the share cookie", () => {
  it("keeps the newest link first, once, and at most SHARE_KEEP", () => {
    let raw = "";
    for (const c of "abcdefghij") raw = withShareToken(raw, T(c));
    const held = parseShareCookie(raw);
    expect(held).toHaveLength(SHARE_KEEP);
    expect(held[0]).toBe(T("j"));
    expect(held).not.toContain(T("a"));
    // Opening a link again moves it up instead of holding it twice.
    const again = parseShareCookie(withShareToken(raw, T("e")));
    expect(again[0]).toBe(T("e"));
    expect(again.filter((t) => t === T("e"))).toHaveLength(1);
  });

  it("drops anything that is not a token, and sends none when nothing is left", () => {
    expect(parseShareCookie(`x.${T("a")}.not a token.${T("a")}`)).toEqual([T("a")]);
    expect(shareHeaderValue(undefined)).toBeNull();
    expect(shareHeaderValue("junk")).toBeNull();
    expect(shareHeaderValue(`${T("a")}.${T("b")}`)).toBe(`${T("a")},${T("b")}`);
  });
});

describe("a share change", () => {
  it("names a document by id and a book by project and slug, and refuses anything else", () => {
    expect(sharePath({ kind: "doc", docId: 7 })).toBe("/app/documents/7/share");
    expect(sharePath({ kind: "book", project: "lab", book: "guide" })).toBe("/app/books/lab/guide/share");
    expect(asShareTarget({ kind: "doc", docId: 7 })).toEqual({ kind: "doc", docId: 7 });
    expect(asShareTarget({ kind: "doc", docId: -1 })).toBeNull();
    expect(asShareTarget({ kind: "book", project: "../x", book: "g" })).toBeNull();
    expect(asShareTarget("doc")).toBeNull();
  });

  it("maps the API's refusals to the switch's words", () => {
    expect(shareChangeRefusal(404)).toEqual({ ok: false, reason: "not-found" });
    expect(shareChangeRefusal(401)).toEqual({ ok: false, reason: "signed-out" });
    expect(shareChangeRefusal(503)).toEqual({ ok: false, reason: "failed" });
    expect(shareChangeRefusal(null)).toEqual({ ok: false, reason: "failed" });
  });
});
