/** What the password change answers: changed, or why not. */
export type ChangePasswordResult =
  | { ok: true }
  | { ok: false; reason: "current" | "short" | "limited" | "failed" };

export type PasswordPhase = "rest" | "change" | "saving" | "current" | "short" | "limited" | "failed";

/** The check before any send: an empty current password, then a new one under 8 characters. */
export function checkPasswordChange(current: string, next: string): PasswordPhase | null {
  if (current.length === 0) return "current";
  if (next.length < 8) return "short";
  return null;
}

/** The phase an answer leaves the panel in: at rest once changed, else the refusal's. */
export function phaseAfterChange(result: ChangePasswordResult): PasswordPhase {
  return result.ok ? "rest" : result.reason;
}

/** The BFF's answer (`/api/auth/password`) as a result, by its status. */
export function changeResultFor(status: number | null): ChangePasswordResult {
  if (status !== null && status >= 200 && status < 300) return { ok: true };
  if (status === 403) return { ok: false, reason: "current" };
  if (status === 400 || status === 422) return { ok: false, reason: "short" };
  if (status === 429) return { ok: false, reason: "limited" };
  return { ok: false, reason: "failed" };
}

/**
 * Send the change to the BFF route (`POST /api/auth/password`), which reads the session from its cookie. A route,
 * not a server action: `next dev` logs a server action's arguments, and passwords reach no log.
 */
export async function sendPasswordChange(
  current: string,
  password: string,
  send: typeof fetch = fetch,
): Promise<ChangePasswordResult> {
  try {
    const res = await send("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current, password }),
    });
    return changeResultFor(res.status);
  } catch {
    return changeResultFor(null);
  }
}
