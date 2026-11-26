// The link reader's share cookie (P75): the tokens of the links this browser opened, newest first, sent to the
// API as `X-Share-Token` on every server-side read (`@/lib/knowledge/client`), so a signed-out reader reads a
// Link item (and its book's chapters and images) through the same routes as a public read. It is set only by
// `/s/<token>` after the API confirmed the link is live; a link turned off simply stops opening, whatever the
// cookie still holds. `__Host-` like the app's other cookies; `Lax`, so the first navigation from a link
// pasted elsewhere carries it on.

export const SHARE_COOKIE = "__Host-sikstack_share";
export const SHARE_HEADER = "X-Share-Token";
/** How many links one browser keeps at once. */
export const SHARE_KEEP = 8;
const TTL_SECONDS = 30 * 24 * 60 * 60;

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** The cookie's tokens, well-formed only, newest first, at most `SHARE_KEEP`. */
export function parseShareCookie(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const t of raw.split(".")) {
    if (isShareToken(t) && !out.includes(t)) out.push(t);
    if (out.length >= SHARE_KEEP) break;
  }
  return out;
}

/** The cookie with `token` first (moved up when it was there), the oldest dropped past `SHARE_KEEP`. */
export function withShareToken(raw: string | undefined | null, token: string): string {
  return [token, ...parseShareCookie(raw).filter((t) => t !== token)].slice(0, SHARE_KEEP).join(".");
}

/** The `X-Share-Token` value: the tokens comma-separated, or null when there are none. */
export function shareHeaderValue(raw: string | undefined | null): string | null {
  const tokens = parseShareCookie(raw);
  return tokens.length ? tokens.join(",") : null;
}

export function shareCookieOptions() {
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure: true as const,
    path: "/" as const,
    maxAge: TTL_SECONDS,
  };
}
