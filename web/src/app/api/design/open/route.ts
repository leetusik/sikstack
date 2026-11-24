import { NextResponse } from "next/server";

import { buildPath, isBuildId, isProjectId, openDesignBuild } from "@/lib/design/open";
import { loginHref } from "@/lib/next-path";
import { openSession, readSessionCookie } from "@/lib/session";

// Open a design build: `GET /api/design/open?project=<id>&build=<id>[&path=/page/]`.
//
// The viewer frames (or links) this route; it asks the API for a ticket to that one build
// for the signed-in member (`lib/design/open.ts`) and answers a 303 to the build's own host,
// which trades the ticket for its own cookie there. The app's session never leaves this
// origin: only the one-minute, one-use ticket rides the redirect.
//
// Only from the app itself: a request whose `Sec-Fetch-Site` is anything but `same-origin` or
// `none` (a typed address) is refused, so a build's own script, on its same-site host, cannot
// make the app mint tickets. Signed out: the sign-in page, back here after. A project or build
// the member cannot see: 404, as the API answers.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function plain(status: number, line: string): NextResponse {
  return new NextResponse(`${line}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: Request): Promise<Response> {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return plain(403, "Open a design build from sikstack.");
  }
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const build = url.searchParams.get("build");
  const path = buildPath(url.searchParams.get("path"));
  if (!isProjectId(project) || !isBuildId(build) || path === null) {
    return plain(400, "This design build address is malformed.");
  }

  const token = openSession(readSessionCookie(req));
  if (!token) {
    const back = `/api/design/open?${url.searchParams.toString()}`;
    return new NextResponse(null, {
      status: 303,
      headers: { Location: loginHref(back), "Cache-Control": "no-store" },
    });
  }

  const answer = await openDesignBuild(token, project, build, path);
  if (answer.ok) {
    return new NextResponse(null, {
      status: 303,
      headers: {
        Location: answer.url,
        "Cache-Control": "no-store",
        // The ticket is in the address: never send it on as a referrer.
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (answer.status === 401) return plain(401, "Sign in again to open this design build.");
  if (answer.status === 404 || answer.status === 403) return plain(404, "This design build was not found.");
  if (answer.status === 503) return plain(503, "This server does not serve design builds.");
  return plain(502, "The design build could not be opened.");
}
