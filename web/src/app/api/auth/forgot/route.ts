import { z } from "zod";

import { json, publicJsonGate } from "@/lib/bff";
import { ApiError } from "@/lib/knowledge/client";
import { edgeAddress } from "@/lib/knowledge/connect";
import { forgotPassword } from "@/lib/knowledge/password";

// P78 — BFF "Forgot password?": `/forgot`'s form POSTs `{email}` here (same origin, JSON), and this route asks the
// API for a reset link (`POST /auth/password/forgot`, the visitor's address as `X-Real-IP`). The answer is
// `200 {ok: true}` whether or not an account has the address, as the API's is; the API limits per address and per
// client, this route per IP first. Only the status reaches the browser.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FORGOT_RATE_LIMIT = 5;
const FORGOT_RATE_WINDOW_MS = 15 * 60_000;

const schema = z.object({ email: z.string().trim().min(1).max(320) });

export async function POST(req: Request): Promise<Response> {
  const gate = await publicJsonGate(req, {
    bucket: "auth-forgot",
    limit: FORGOT_RATE_LIMIT,
    windowMs: FORGOT_RATE_WINDOW_MS,
    schema,
  });
  if ("refused" in gate) return gate.refused;
  try {
    await forgotPassword(gate.body.email, edgeAddress(req.headers));
  } catch (error) {
    if (error instanceof ApiError && (error.status === 429 || error.status === 422)) {
      return json(error.status, { ok: false });
    }
    return json(502, { ok: false });
  }
  return json(200, { ok: true });
}
