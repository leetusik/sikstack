import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  parseShareCookie,
  SHARE_KEEP,
  shareHeaderValue,
  withShareToken,
} from "@/lib/sharing/cookie";
import { SHARING } from "@/content/sharing";
import { asShareTarget, mayChooseShare, sharePath, shareChangeRefusal, type ItemShare } from "@/lib/sharing/model";
import { ShareControl } from "@/sikstack/reader/share-control";

// The switch's server action never runs here: the switch is only drawn.
vi.mock("@/lib/sharing/actions", () => ({ setItemShare: vi.fn() }));

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
    expect(shareChangeRefusal(403)).toEqual({ ok: false, reason: "owner-only" });
    expect(shareChangeRefusal(503)).toEqual({ ok: false, reason: "failed" });
    expect(shareChangeRefusal(null)).toEqual({ ok: false, reason: "failed" });
  });
});

describe("who may make an item Public", () => {
  const member: ItemShare = { state: "members", kind: "doc", url: null, can_publish: false };
  const owner: ItemShare = { ...member, can_publish: true };
  const target = { kind: "doc", docId: 7 } as const;

  // The buttons in the switch's order (Members, Link, Public): whether each is disabled.
  function disabled(share: ItemShare): boolean[] {
    const html = renderToStaticMarkup(createElement(ShareControl, { target, share }));
    return [...html.matchAll(/<button[^>]*>/g)].map((m) => / disabled=""/.test(m[0]));
  }

  it("is the owner's: a member may choose Link and Members only", () => {
    expect(mayChooseShare(member, "public")).toBe(false);
    expect(mayChooseShare(member, "link")).toBe(true);
    expect(mayChooseShare(member, "members")).toBe(true);
    expect(mayChooseShare(owner, "public")).toBe(true);
    // An older API's answer, with no flag, leaves the choice to the API.
    expect(mayChooseShare({ state: "members", kind: "doc", url: null }, "public")).toBe(true);
  });

  it("draws a member's Public off, with the one line that says why", () => {
    expect(disabled(member)).toEqual([false, false, true]);
    expect(renderToStaticMarkup(createElement(ShareControl, { target, share: member }))).toContain(
      SHARING.ownerPublishes,
    );
  });

  it("draws all three for an owner, and no such line", () => {
    expect(disabled(owner)).toEqual([false, false, false]);
    expect(renderToStaticMarkup(createElement(ShareControl, { target, share: owner }))).not.toContain(
      SHARING.ownerPublishes,
    );
  });
});
