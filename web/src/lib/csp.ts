/**
 * P30.S12 — the app's Content-Security-Policy, defense in depth (P29 *Render
 * model*: "the format needs no CSP relaxation … P30 should add one").
 *
 * Two layers:
 *
 * - **`APP_CSP`, every response** (next.config.ts `headers()`, so it also covers
 *   prerendered marketing pages): no plugins, no `<base>` hijack, only
 *   same-origin frames (the legacy explainer iframe is `/api/documents/{id}/raw`),
 *   never framed by another site (it matches `X-Frame-Options: DENY`), and images
 *   only from this origin or `data:`. It sets no `script-src`: a prerendered page
 *   cannot carry a per-request nonce, and Next's inline bootstrap scripts would
 *   otherwise be blocked.
 *
 * - **`readerCsp(nonce)`, the reader routes** (`src/proxy.ts`, per request):
 *   `APP_CSP` plus `script-src 'self' 'nonce-…' 'strict-dynamic'`. Next reads the
 *   nonce from the request's CSP header and stamps it on every script it emits,
 *   so a script that did not come from Next — which the render pipeline could
 *   never produce anyway — does not run. Dev adds `'unsafe-eval'`, which React's
 *   development build needs, and trusts same-origin scripts instead of
 *   `'strict-dynamic'` (see `readerCsp`); production never does either.
 *
 * - **`designViewerCsp(origin)`, a Design build's viewer only** (P77,
 *   `/projects/<id>/design/<build>`, `src/proxy.ts`, per request): `APP_CSP` with
 *   `frame-src 'self' <that build's exact origin>`, the origin formed from
 *   `KB_DESIGN_ORIGIN` (the API's pattern, `{build}` where the id goes) at request
 *   time, so the viewer can frame the build's options directions. The proxy SETS
 *   the response's one `Content-Security-Policy`, replacing `APP_CSP` from
 *   `headers()` (two policies would both be enforced, and `frame-src 'self'` would
 *   block the frames). Every other route keeps `frame-src 'self'`; without
 *   `KB_DESIGN_ORIGIN` (or with a malformed one) the viewer keeps it too and frames
 *   nothing. A CSP is the document's: a client-side navigation keeps the policy of
 *   the page it started from, so the viewer is entered by a full page load.
 *
 * The two raw-HTML relays keep their own stricter `sandbox` policy (next.config).
 * `style-src` is left open: React's `style={…}` props are inline style attributes
 * on existing surfaces; the native pipeline itself emits none.
 */

const APP_DIRECTIVES = [
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
] as const;

export const APP_CSP = APP_DIRECTIVES.join("; ");

/** The pages that render document bodies: `/documents/…` and the `/@{org}/…` pretty and reader URLs. */
export function isReaderPath(pathname: string): boolean {
  return pathname.startsWith("/documents/") || pathname.startsWith("/@");
}

export function readerCsp(nonce: string, dev = false): string {
  // P30.S13 — in dev, Next 16 (Turbopack) renders the segment's `loading.tsx` and
  // client-chunk `<script src>` tags into the HTML WITHOUT the nonce; under
  // `'strict-dynamic'` (which makes `'self'` inert) the browser blocks them and the
  // reader never hydrates. Production nonces every script it emits (verified), so only
  // dev drops `'strict-dynamic'` and trusts same-origin scripts, beside the
  // `'unsafe-eval'` React's development build already needs.
  const script = dev
    ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [...APP_DIRECTIVES, script].join("; ");
}

/** A fresh per-request nonce: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** A design build id: `b` and 25 base32 characters (`server/design/store.py`, `@/lib/design/open`). */
const DESIGN_BUILD_ID = /^b[a-z2-7]{25}$/;

/** A Design build's viewer: `/projects/<id>/design/<build>` (a trailing slash allowed); its build id, else null. */
export function designViewerBuild(pathname: string): string | null {
  const m = /^\/projects\/[^/]+\/design\/([^/]+)\/?$/.exec(pathname);
  return m && DESIGN_BUILD_ID.test(m[1]) ? m[1] : null;
}

const PLACEHOLDER = "{build}";

/**
 * A build's own origin from the `KB_DESIGN_ORIGIN` pattern, read as the API reads it
 * (`server/design/settings.py`): `http(s)://host-with-{build}[:port]`, one `{build}` in
 * the host, no path. Null when the pattern is unset or malformed, or the id is not one.
 */
export function designBuildOrigin(
  pattern: string | null | undefined,
  build: string,
): string | null {
  if (!DESIGN_BUILD_ID.test(build)) return null;
  const raw = (pattern ?? "").trim().replace(/\/+$/, "");
  if (!raw || raw.split(PLACEHOLDER).length !== 2) return null;
  let url: URL;
  try {
    url = new URL(raw.replace(PLACEHOLDER, build));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    return null;
  // the id must land in the host, not elsewhere in the address
  if (!url.hostname.split(".").some((label) => label.includes(build))) return null;
  return url.origin;
}

/** The viewer's one policy: the app's, its `frame-src` naming that build's exact origin. */
export function designViewerCsp(origin: string): string {
  return APP_DIRECTIVES.map((d) =>
    d === "frame-src 'self'" ? `frame-src 'self' ${origin}` : d,
  ).join("; ");
}
