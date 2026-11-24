import { z } from "zod";

import { json, publicJsonGate } from "@/lib/bff";
import { ApiError } from "@/lib/knowledge/client";
import { changePassword } from "@/lib/knowledge/password";
import { openSession, readSessionCookie } from "@/lib/session";

// P78 — BFF password change (`/account`'s Password panel): `{current, password}` POSTed here (same origin, JSON),
// the session's token unsealed from the httpOnly cookie and handed to the API (`POST /auth/password/change`), which
// keeps this session and ends the others. A route handler, not a server action, on purpose: `next dev` logs a server
// action's arguments (`ƒ action("…", "…")` in its output), and passwords reach no log. Answers `200 {ok: true}`, or
// `{ok: false, reason}` keyed by the API's status: 403 `current` (the current password is not right), 422 `short`,
// 429 `limited`, 401 (no session), anything else 502 `failed`. Never the API's `detail`; the passwords are never logged.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHANGE_RATE_LIMIT = 10;
const CHANGE_RATE_WINDOW_MS = 15 * 60_000;

const schema = z.object({
  current: z.string().min(1).max(1024),
  password: z.string().min(1).max(1024),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await publicJsonGate(req, {
    bucket: "auth-password",
    limit: CHANGE_RATE_LIMIT,
    windowMs: CHANGE_RATE_WINDOW_MS,
    schema,
  });
  if ("refused" in gate) return gate.refused;
  const token = openSession(readSessionCookie(req));
  if (!token) return json(401, { ok: false });
  try {
    await changePassword(token, gate.body.current, gate.body.password);
    return json(200, { ok: true });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 403 && error.reason === "current") return json(403, { ok: false, reason: "current" });
      if (error.status === 422) return json(422, { ok: false, reason: "short" });
      if (error.status === 429) return json(429, { ok: false, reason: "limited" });
      if (error.status === 401) return json(401, { ok: false });
    }
    return json(502, { ok: false, reason: "failed" });
  }
}
