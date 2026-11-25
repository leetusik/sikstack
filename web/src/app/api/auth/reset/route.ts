import { z } from "zod";

import { json, publicJsonGate } from "@/lib/bff";
import { ApiError } from "@/lib/knowledge/client";
import { edgeAddress } from "@/lib/knowledge/connect";
import { resetPassword } from "@/lib/knowledge/password";

// P78 — BFF reset: `/reset`'s form POSTs `{code, password}` here (same origin, JSON), and this route sets the new
// password by the mail's code (`POST /auth/password/reset`, the visitor's address as `X-Real-IP`). The API ends every
// session of the account and mints none, so no cookie is set here: the page goes on to sign in. Answers
// `200 {ok: true, email}` (the account's address, carried into sign-in's Email), or the bare status: 410 (the link
// no longer works), 422 (a password under 8 characters), 429; anything else is 502. The password is never logged.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESET_RATE_LIMIT = 10;
const RESET_RATE_WINDOW_MS = 15 * 60_000;

const schema = z.object({
  code: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await publicJsonGate(req, {
    bucket: "auth-reset",
    limit: RESET_RATE_LIMIT,
    windowMs: RESET_RATE_WINDOW_MS,
    schema,
  });
  if ("refused" in gate) return gate.refused;
  try {
    const { email } = await resetPassword(gate.body.code, gate.body.password, edgeAddress(req.headers));
    return json(200, { ok: true, email });
  } catch (error) {
    if (error instanceof ApiError && [410, 422, 429].includes(error.status)) {
      return json(error.status, { ok: false });
    }
    return json(502, { ok: false });
  }
}
