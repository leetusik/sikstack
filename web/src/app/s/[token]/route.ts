import { NextResponse } from "next/server";

import { SHARING } from "@/content/sharing";
import { ApiError, getJson } from "@/lib/knowledge/client";
import {
  isShareToken,
  SHARE_COOKIE,
  shareCookieOptions,
  withShareToken,
} from "@/lib/sharing/cookie";

// P75 — a Library item's link, `/s/<token>`: the address `knowledge share … link` and the reader's switch hand
// out. It asks the API what the live link opens (`GET /app/shared/{token}`, anyone may ask: the link is the
// credential), keeps the token in the share cookie (`@/lib/sharing/cookie`), and sends the reader on to the
// item's own reader address, where every read carries the token. A link that is off, or never was, is a 404
// at this same address. Nothing here needs a session.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Shared {
  path?: string;
}

/** The item's reader address the API named, only when it is one of ours (`/@…` or `/documents/<id>`). */
function safeTarget(path: unknown): string | null {
  if (typeof path !== "string") return null;
  return /^\/(@[^/\s?#]+\/[^\s?#]+|documents\/\d+)$/.test(path) ? path : null;
}

function gone(): Response {
  const g = SHARING.gone;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${g.title} · sikstack</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem;color:#1d1d1f}h1{font-size:1.5rem;margin:0 0 .5rem}a{color:inherit}</style></head><body><main><h1>${g.title}</h1><p>${g.body}</p><p><a href="/">${g.home}</a></p></main></body></html>`;
  return new NextResponse(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  if (!isShareToken(token)) return gone();
  let target: string | null = null;
  try {
    const shared = await getJson<Shared>(`/app/shared/${encodeURIComponent(token)}`);
    target = safeTarget(shared?.path);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) return gone();
    throw error;
  }
  if (!target) return gone();
  // A RELATIVE Location (RFC 9110): behind the edge `req.url` may carry the internal host.
  const res = new NextResponse(null, {
    status: 303,
    headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
  const cookie = req.headers.get("cookie") ?? "";
  const held = /(?:^|;\s*)__Host-sikstack_share=([^;]*)/.exec(cookie)?.[1];
  res.cookies.set(SHARE_COOKIE, withShareToken(held, token), shareCookieOptions());
  return res;
}
