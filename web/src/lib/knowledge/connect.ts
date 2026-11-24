import "server-only";

import { ApiError, getRaw, sendJson } from "./client";

// The connect page's three calls to the API (`server/installs_api.py`), server to server:
//
// - `readConnect` (`GET /app/connect/{code}`): with the session's token when there is one,
//   without it otherwise. The API limits a signed-out read per client address (it shows the
//   setup email), so the visitor's address goes with it as `X-Real-IP`: the one the edge set
//   on the request being served (`deploy/sikstack.conf` overwrites any a client sends).
// - `approveConnect` and `declineConnect` (`POST /app/connect/{code}/approve|decline`): the
//   session's token, called by the BFF route `/api/auth/connect`.
//
// None names the active org (`org: null`): the read lists every org of the account, and
// approve names the one picked in its body.

/** The visitor's address as the edge recorded it, or the best guess behind no edge. */
export function edgeAddress(h: Headers): string | null {
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

/** The API's answer for a code (the raw JSON; `viewFromServer` reads it), or the status that refused it. */
export async function readConnect(
  code: string,
  token: string | null,
  address: string | null,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  try {
    const res = await getRaw(`/app/connect/${encodeURIComponent(code)}`, {
      token: token ?? undefined,
      org: null,
      headers: {
        Accept: "application/json",
        ...(address ? { "X-Real-IP": address } : {}),
      },
    });
    return { ok: true, body: (await res.json()) as unknown };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, status: error.status };
    throw error;
  }
}

export interface ConnectApproval {
  state: "connected";
  org_id: string;
  project: { id: string; name: string };
}

export async function approveConnect(
  token: string,
  code: string,
  orgId: string | null,
): Promise<ConnectApproval> {
  return sendJson<ConnectApproval>(
    `/app/connect/${encodeURIComponent(code)}/approve`,
    "POST",
    orgId ? { org_id: orgId } : {},
    { token, org: null },
  );
}

export async function declineConnect(token: string, code: string): Promise<void> {
  await sendJson<unknown>(
    `/app/connect/${encodeURIComponent(code)}/decline`,
    "POST",
    undefined,
    { token, org: null },
  );
}
