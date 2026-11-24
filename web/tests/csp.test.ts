import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_CSP,
  designBuildOrigin,
  designViewerBuild,
  designViewerCsp,
  isReaderPath,
  newNonce,
  readerCsp,
} from "@/lib/csp";
import { proxy } from "@/proxy";

// P30.S12 — the app CSP (defense in depth). Core because a wrong policy either
// silently disables the defense or blanks every reader page in production.

describe("app CSP", () => {
  it("blocks plugins, <base> hijack, foreign frames and third-party images everywhere", () => {
    expect(APP_CSP).toBe(
      "object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'none'; img-src 'self' data:",
    );
  });

  it("gives the reader routes a nonce'd script-src on top of the app policy", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const policy = readerCsp(nonce);
    expect(policy.startsWith(`${APP_CSP}; `)).toBe(true);
    expect(policy).toContain(
      `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    );
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toContain("unsafe-inline");
    // dev: React needs eval, and Next's dev server leaves its chunk tags un-nonced, so
    // same-origin scripts are trusted instead of 'strict-dynamic' (P30.S13)
    const dev = readerCsp(nonce, true);
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(dev).not.toContain("strict-dynamic");
  });

  it("scopes the nonce policy to the pages that render document bodies", () => {
    expect(isReaderPath("/documents/12")).toBe(true);
    expect(isReaderPath("/documents/12/versions/2")).toBe(true);
    expect(isReaderPath("/@acme/proj/books/b/c")).toBe(true);
    expect(isReaderPath("/documents")).toBe(false);
    expect(isReaderPath("/dashboard")).toBe(false);
    expect(isReaderPath("/")).toBe(false);
  });
});

// P77 — a Design build's viewer frames that build's options directions. Core because one
// wrong policy either blocks the frames (two policies on the response, or the wrong origin)
// or opens `frame-src` app-wide.
describe("the Design viewer's CSP", () => {
  const build = "babcdefghijklmnopqrstuvwxy";
  const pattern = "http://{build}.design.sikstack.localhost:3061";
  const origin = `http://${build}.design.sikstack.localhost:3061`;

  it("names the viewer route's build, and only that route", () => {
    expect(designViewerBuild(`/projects/p1/design/${build}`)).toBe(build);
    expect(designViewerBuild(`/projects/p1/design/${build}/`)).toBe(build);
    for (const path of [
      "/projects/p1/design",
      "/projects/p1/design/",
      "/projects/p1/design/not-a-build",
      `/projects/p1/design/${build}/more`,
      `/projects/p1/feedback/${build}`,
      `/design/${build}`,
      "/dashboard",
    ])
      expect(designViewerBuild(path)).toBeNull();
  });

  it("forms the build's exact origin from KB_DESIGN_ORIGIN, as the API reads it", () => {
    expect(designBuildOrigin(pattern, build)).toBe(origin);
    expect(designBuildOrigin(`${pattern}/`, build)).toBe(origin);
    expect(designBuildOrigin("https://d-{build}.sikstack.com", build)).toBe(
      `https://d-${build}.sikstack.com`,
    );
    for (const bad of [
      undefined,
      null,
      "",
      "  ",
      "http://design.sikstack.localhost:3061", // no {build}
      "http://{build}.{build}.example.com", // two
      "ftp://{build}.example.com",
      "http://example.com/{build}", // not in the host
      "http://{build}.example.com/path",
      "not a url {build}",
    ])
      expect(designBuildOrigin(bad, build)).toBeNull();
    expect(designBuildOrigin(pattern, "../evil")).toBeNull();
  });

  it("is the app's one policy with frame-src naming that origin, nothing wider", () => {
    const policy = designViewerCsp(origin);
    expect(policy).toBe(
      `object-src 'none'; base-uri 'none'; frame-src 'self' ${origin}; frame-ancestors 'none'; img-src 'self' data:`,
    );
    expect(policy).not.toContain("*");
    expect(policy.match(/frame-src/g)).toHaveLength(1);
  });

  describe("in the proxy", () => {
    const saved = process.env.KB_DESIGN_ORIGIN;
    afterEach(() => {
      if (saved === undefined) delete process.env.KB_DESIGN_ORIGIN;
      else process.env.KB_DESIGN_ORIGIN = saved;
    });
    const csp = (path: string) =>
      proxy(new NextRequest(`http://sikstack.localhost:3030${path}`)).headers.get(
        "content-security-policy",
      );

    it("sets the viewer's one policy, replacing APP_CSP, and leaves every other route to APP_CSP", () => {
      process.env.KB_DESIGN_ORIGIN = pattern;
      expect(csp(`/projects/p1/design/${build}`)).toBe(designViewerCsp(origin));
      // other routes: the proxy sets none, so next.config's `headers()` APP_CSP is the one policy
      for (const path of ["/projects/p1/design", "/dashboard", "/projects/p1/feedback"])
        expect(csp(path)).toBeNull();
      // the reader's nonce policy stands, with frame-src 'self'
      expect(csp("/documents/12")).toContain("frame-src 'self';");
    });

    it("frames nothing without KB_DESIGN_ORIGIN or with a malformed one", () => {
      delete process.env.KB_DESIGN_ORIGIN;
      expect(csp(`/projects/p1/design/${build}`)).toBeNull();
      process.env.KB_DESIGN_ORIGIN = "http://design.example.com";
      expect(csp(`/projects/p1/design/${build}`)).toBeNull();
    });
  });
});
