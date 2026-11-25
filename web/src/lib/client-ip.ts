/**
 * The visitor's address, as the edge recorded it (P78: one reading for the whole web).
 *
 * The edge (`deploy/sikstack.conf`) SETS `X-Real-IP` to the connecting address on every request it proxies,
 * overwriting whatever a client sent, so behind it that header is the visitor's own address. `X-Forwarded-For`
 * is not: the edge appends to what the client sent, so its first hop is the client's to choose. It is read only
 * when there is no `X-Real-IP` at all, which is a server with no edge in front (a local stack), never production.
 *
 * Two uses, one reading: the BFF's own per-IP limiters key on it (`clientIp`), and every web call to an API route
 * that limits per client passes it on as `X-Real-IP` (`edgeAddress`, through `sendJson`'s `address` or `getRaw`'s
 * headers), so the API's limit counts the visitor rather than this server, which would otherwise be one client.
 */
export function edgeAddress(h: Headers): string | null {
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

/** The BFF limiters' key: the visitor's address (`edgeAddress`), or an `"unknown"` sentinel. */
export function clientIp(h: Headers): string {
  return edgeAddress(h) ?? "unknown";
}
