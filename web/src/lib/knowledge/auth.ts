import "server-only";

import { ApiError, getJson, sendJson } from "./client";
import type { KbIdentity, KbSession, KbTenant, KbUser } from "./types";

// P12.S2 — typed server-side calls against knowledge's `/auth/*` surface, used only
// by the BFF route handlers and the `(app)`/`(auth)` server components.
//
// The one real adaptation is normalizing knowledge's signup/login TENANT ASYMMETRY:
//   POST /auth/signup → 201 { token, user, tenant  }   ← singular
//   POST /auth/login  → 200 { token, user, tenants[] } ← array
//   GET  /auth/me     → 200 { user, tenants[] }
// Callers get one shape (`{ token, user, tenant }`), with `tenants[0]` as the
// active tenant — matching knowledge's own `require_user`. Callers key off STATUS
// CODES (401/409/400), never knowledge's `detail` text.
//
// P58 — the waitlist (`KB_SIGNUP_WAITLIST`, `users.status`). A waitlisted account gets
// no token: sign-up answers `202 {status: "waitlisted", email}` and sign-in answers the
// right password with `403 {detail: "waitlisted", status: "waitlisted", email}`. Both
// calls return `KbWaitlisted` for it instead of a session, so nothing downstream can
// seal a token that is not there.
//
// P78 — an org invite's code (`invite`, from the `/invite` page's sign-in pair) rides either body
// when the form sends one. An account the code joined to its org (approved, if it was waitlisted)
// answers a session with the additive `joined`; the BFF then starts the session in that org.

/** The raw signup/login envelope before normalization (either tenant shape). */
interface RawAuthResponse {
  token: string;
  user: KbUser;
  /** Signup answers this. */
  tenant?: KbTenant;
  /** Login answers this. */
  tenants?: KbTenant[];
  /** The org an invite code joined the account to (either route, additive). */
  joined?: KbTenant;
}

/** The waitlisted answer's body (sign-up's 202; sign-in's 403 adds `detail`). */
interface RawWaitlisted {
  status: "waitlisted";
  email: string;
}

/** The waitlist marker the server sends, in `status` (both answers) and `detail` (the 403). */
export const WAITLISTED = "waitlisted";

/** A sign-up or sign-in that the waitlist answered: an account, but no session. */
export interface KbWaitlisted {
  waitlisted: true;
  /** The account's email as the server answered it (lowercased), else as sent. */
  email: string;
}

/** What sign-up and sign-in resolve to: a session, or the waitlist. */
export type KbAuthAnswer = KbSession | KbWaitlisted;

export function isWaitlisted(answer: KbAuthAnswer): answer is KbWaitlisted {
  return "waitlisted" in answer && answer.waitlisted === true;
}

/** The raw `/auth/me` envelope. */
interface RawMeResponse {
  user: KbUser;
  tenants?: KbTenant[];
  /** The tenant this request acts in (the `X-Sikstack-Org` org, else the first). */
  active_tenant_id?: string;
}

/**
 * The tenant `/auth/me` says this request acts in: the one named by
 * `active_tenant_id`, falling back to `tenants[0]` when the field is absent (an
 * older API) or names no listed tenant.
 */
export function meTenant(raw: RawMeResponse): KbTenant | null {
  const named = raw.active_tenant_id
    ? raw.tenants?.find((tenant) => tenant.id === raw.active_tenant_id)
    : undefined;
  return named ?? activeTenant(raw);
}

/**
 * Collapse knowledge's `tenant` (signup) / `tenants[]` (login) asymmetry to a
 * single active tenant. Exported for the S2 mapping test; prefers the singular
 * field and falls back to `tenants[0]`, yielding `null` when neither is present.
 */
export function activeTenant(raw: {
  tenant?: KbTenant;
  tenants?: KbTenant[];
}): KbTenant | null {
  return raw.tenant ?? raw.tenants?.[0] ?? null;
}

/**
 * Normalize a raw signup OR login response into the single `KbSession` shape.
 * Exported for the S2 mapping test — the whole point is that both knowledge shapes
 * produce an identical result.
 */
export function normalizeAuthResponse(raw: RawAuthResponse): KbSession {
  const session: KbSession = { token: raw.token, user: raw.user, tenant: activeTenant(raw) };
  if (raw.joined && typeof raw.joined.id === "string") session.joined = raw.joined;
  return session;
}

/**
 * A 2xx signup/login body as an answer: the waitlist when it says so, a session when
 * it carries a token. A 2xx with neither is an upstream fault (`ApiError(502)`), never
 * a session with an undefined token.
 */
export function authAnswer(
  raw: RawAuthResponse | RawWaitlisted | undefined,
  email: string,
): KbAuthAnswer {
  if (raw && "status" in raw && raw.status === WAITLISTED) {
    return {
      waitlisted: true,
      email: typeof raw.email === "string" ? raw.email : email,
    };
  }
  if (
    !raw ||
    !("token" in raw) ||
    typeof raw.token !== "string" ||
    !raw.token
  ) {
    throw new ApiError(502, null);
  }
  return normalizeAuthResponse(raw);
}

/**
 * `POST /auth/signup` → 201 `{token, user, tenant}`, or 202 `{status: "waitlisted",
 * email}` (no token) with the waitlist on. Throws `ApiError` on 409 (duplicate email)
 * / 400 (validation) — the route maps the STATUS to the client without echoing
 * knowledge's detail text. `address` is the visitor's (`edgeAddress`), sent as `X-Real-IP` so the API's per-client
 * limit counts the visitor, not this server (P78).
 */
export async function signup(
  email: string,
  password: string,
  invite?: string,
  address?: string | null,
): Promise<KbAuthAnswer> {
  const raw = await sendJson<RawAuthResponse | RawWaitlisted>(
    "/auth/signup",
    "POST",
    invite ? { email, password, invite } : { email, password },
    { address },
  );
  return authAnswer(raw, email);
}

/**
 * `POST /auth/login` → 200 `{token, user, tenants[]}`. A waitlisted account's right
 * password answers 403 `{detail: "waitlisted", …}`, returned as `KbWaitlisted`; any
 * other 403 still throws. Throws `ApiError` on 401 (identical for unknown-email and
 * bad-password — knowledge does not let callers enumerate accounts, and neither does
 * the BFF) / 400 (validation). `address` as `signup`'s (P78).
 */
export async function login(
  email: string,
  password: string,
  invite?: string,
  address?: string | null,
): Promise<KbAuthAnswer> {
  let raw: RawAuthResponse | RawWaitlisted;
  try {
    raw = await sendJson<RawAuthResponse | RawWaitlisted>(
      "/auth/login",
      "POST",
      invite ? { email, password, invite } : { email, password },
      { address },
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 403 &&
      error.detail === WAITLISTED
    ) {
      return { waitlisted: true, email };
    }
    throw error;
  }
  return authAnswer(raw, email);
}

/**
 * `POST /auth/logout` (bearer) → 204 always; idempotent and never 401. Revokes the
 * token server-side. FIRE-AND-FORGET: any transport error is swallowed, because the
 * BFF clears the sealed cookie regardless — the browser's session must end even if
 * knowledge is unreachable.
 */
export async function logout(token: string): Promise<void> {
  try {
    await sendJson<void>("/auth/logout", "POST", undefined, { token });
  } catch {
    // best-effort — the cookie clear is the real end of the browser session
  }
}

/**
 * `GET /auth/me` (bearer) → 200 `{user, tenants[], active_tenant_id}`; 401
 * (missing/unknown/expired, indistinguishable) throws `ApiError(401)`, which the
 * `(app)` layout turns into a redirect to /login; 403 (the org cookie names an org the
 * user is not in) throws `ApiError(403)`, which the guards turn into the org reset.
 *
 * `org` overrides the org cookie for this one call (the switch route confirms a
 * membership with it); omitted, the cookie decides, as for every other call.
 */
export async function me(
  token: string,
  options: { signal?: AbortSignal; org?: string | null } = {},
): Promise<KbIdentity> {
  const raw = await getJson<RawMeResponse>("/auth/me", {
    token,
    signal: options.signal,
    ...(options.org !== undefined ? { org: options.org } : {}),
  });
  return {
    user: raw.user,
    tenant: meTenant(raw),
    tenants: raw.tenants ?? [],
  };
}
