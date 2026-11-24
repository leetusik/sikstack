import "server-only";

import { ApiError, sendJson } from "./client";

// The password calls to the API (`server/password_reset.py`), server to server. Forgot, the code's check and the
// reset are public: the visitor's address goes with each as `X-Real-IP` (`edgeAddress`), for the API's per-client
// limit. The change carries the session's token. Callers key off the STATUS (and the change's `reason`), never the
// API's `detail` text.

/** `POST /auth/password/forgot`: the API answers 202 whatever the address; it mails an account only. */
export async function forgotPassword(email: string, address: string | null): Promise<void> {
  await sendJson<unknown>("/auth/password/forgot", "POST", { email }, { address });
}

/**
 * `POST /auth/password/reset/check`: `valid`, or `invalid` for a code that is unknown, used or expired (the API's
 * 410). Any other refusal (the limit, the API down) throws `ApiError`.
 */
export async function checkResetCode(
  code: string,
  address: string | null,
): Promise<"valid" | "invalid"> {
  try {
    await sendJson<unknown>("/auth/password/reset/check", "POST", { code }, { address });
    return "valid";
  } catch (error) {
    if (error instanceof ApiError && (error.status === 410 || error.status === 422)) return "invalid";
    throw error;
  }
}

/** `POST /auth/password/reset`: the new password by code; every session of the account ends. Throws `ApiError`. */
export async function resetPassword(
  code: string,
  password: string,
  address: string | null,
): Promise<{ email: string }> {
  const body = await sendJson<{ email?: unknown }>(
    "/auth/password/reset",
    "POST",
    { code, password },
    { address },
  );
  return { email: typeof body?.email === "string" ? body.email : "" };
}

/** `POST /auth/password/change` (the session): the current password, then the new one. Throws `ApiError`. */
export async function changePassword(token: string, current: string, password: string): Promise<void> {
  await sendJson<unknown>("/auth/password/change", "POST", { current, password }, { token, org: null });
}
