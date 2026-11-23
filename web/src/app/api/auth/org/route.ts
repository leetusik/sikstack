import { NextResponse } from "next/server";

import { json } from "@/lib/bff";
import { me } from "@/lib/knowledge/auth";
import { ApiError } from "@/lib/knowledge/client";
import { safeNextPath } from "@/lib/next-path";
import {
  asOrgId,
  assertSameOrigin,
  clearedOrgCookieOptions,
  openSession,
  ORG_COOKIE,
  ORG_ROUTE,
  orgCookieOptions,
  readSessionCookie,
} from "@/lib/session";

// The active org: switch (POST) and reset (GET). Under `/api/auth/` because the edge
// sends only that part of `/api/` to the web app (`deploy/hi2vi.conf`).
//
// POST is the org menu's plain form post (it works with no JS). It sets the
// `sikstack_org` cookie ONLY to an org the API has just confirmed the user is a member
// of (`GET /auth/me` with that org named answers 200; a non-member is the API's 403),
// then lands on `/dashboard`: a page of the old org's project would 404 in the new one.
//
// GET is the reset: it clears the cookie and returns to `next` (laundered through
// `safeNextPath`, so never off-site). The page guards send a stale or foreign org
// cookie's 403 here, because a server component cannot clear a cookie. A GET with a
// side effect, so it answers only the app's own requests: a `Sec-Fetch-Site` other
// than `same-origin` or `none` (a design build on its same-site host, whose requests
// carry the Strict cookies, or another site) clears nothing and gets a page whose one
// link repeats the reset from the app itself. A browser that sends no fetch metadata
// is answered as before.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LANDING = "/dashboard";
const LOGIN = "/login";

/**
 * A 303 with a RELATIVE `Location` (valid per RFC 9110): behind the edge, `req.url`
 * may carry the internal host, so an absolute URL built from it could point the
 * browser at the wrong origin.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!assertSameOrigin(req)) {
    return json(403, { ok: false });
  }

  const token = openSession(readSessionCookie(req));
  if (!token) return seeOther(LOGIN);

  let org: string | null = null;
  try {
    org = asOrgId((await req.formData()).get("org"));
  } catch {
    org = null;
  }
  if (!org) return seeOther(LANDING);

  try {
    const identity = await me(token, { org });
    const res = seeOther(LANDING);
    // Belt and braces: the API acted in exactly the org we named.
    if (identity.tenant?.id.toLowerCase() === org) {
      res.cookies.set(ORG_COOKIE, org, orgCookieOptions());
    }
    return res;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return seeOther(LOGIN);
    }
    // 403 (not a member) or anything else: set nothing.
    return seeOther(LANDING);
  }
}

/** The reset's own link, for a request the reset refused (`orgResetHref`'s shape). */
function resetLink(next: string): string {
  return `${ORG_ROUTE}?next=${encodeURIComponent(next)}`;
}

export async function GET(req: Request): Promise<Response> {
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    const href = resetLink(next).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return new NextResponse(
      `<!doctype html><meta charset="utf-8"><title>sikstack</title><p><a href="${href}">Continue to sikstack</a></p>\n`,
      {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      },
    );
  }
  const res = seeOther(next);
  res.cookies.set(ORG_COOKIE, "", clearedOrgCookieOptions());
  return res;
}
