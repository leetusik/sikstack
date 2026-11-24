import "server-only";

import { ApiError, sendJson } from "@/lib/knowledge/client";

// The Design service's open call (`server/design_api.py`), server to server: the member's
// session asks the API for a ticket to one build, and the API answers the build's own
// address with the ticket in it (`<build origin>/_open?t=…&next=<path>`). The ticket is
// good for one build, one member, a minute and one use; the design origin trades it for its
// own cookie on that build's host (`server/design_serve.py`). The active org comes from the
// org cookie, like every session call.

/** A design build id: `b` and 25 base32 characters (`server/design/store.py`). */
const BUILD_ID = /^b[a-z2-7]{25}$/;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path on the build's host: one leading slash, no scheme, no backslash, no control characters. */
export function buildPath(value: string | null): string | null {
  if (value === null || value === "") return "/";
  if (value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export function isBuildId(value: string | null): value is string {
  return value !== null && BUILD_ID.test(value);
}

export function isProjectId(value: string | null): value is string {
  return value !== null && UUID_SHAPE.test(value);
}

export type OpenAnswer =
  | { ok: true; url: string }
  | { ok: false; status: number };

/** The ticketed address of one build for this session's member, or the status that refused it. */
export async function openDesignBuild(
  token: string,
  projectId: string,
  buildId: string,
  path: string,
): Promise<OpenAnswer> {
  try {
    const body = await sendJson<{ url?: unknown }>(
      `/app/projects/${encodeURIComponent(projectId)}/design/builds/${encodeURIComponent(buildId)}/open`,
      "POST",
      { path },
      { token },
    );
    if (typeof body?.url !== "string") return { ok: false, status: 502 };
    const url = new URL(body.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, status: 502 };
    return { ok: true, url: url.toString() };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, status: error.status };
    throw error;
  }
}
