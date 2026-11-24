"use server";

import { ApiError, sendJson } from "@/lib/knowledge/client";
import { getSession } from "@/lib/session";
import type { DesignBuild } from "@/sikstack/design/model";

import { isBuildId, isProjectId } from "./open";
import { shareRefusal, type ShareAnswer } from "./share";

/**
 * A build's share link on (a new link each time) or off, from its viewer: `POST /app/projects/{id}/design/
 * builds/{build}/share {on}` → `{build}`. Every answer is data, never a throw (`shareRefusal`).
 *
 * NOTE: a `"use server"` module may export ONLY async functions; the answer's type is in `share.ts`.
 */
export async function shareDesignBuild(project: string, build: string, on: boolean): Promise<ShareAnswer> {
  if (!isProjectId(project) || !isBuildId(build) || typeof on !== "boolean") return shareRefusal(404);
  const token = await getSession();
  if (!token) return shareRefusal(401);
  try {
    const answer = await sendJson<{ build?: DesignBuild }>(
      `/app/projects/${encodeURIComponent(project)}/design/builds/${encodeURIComponent(build)}/share`,
      "POST",
      { on },
      { token },
    );
    if (!answer?.build) return shareRefusal(null);
    return { ok: true, build: answer.build };
  } catch (error) {
    return shareRefusal(error instanceof ApiError ? error.status : null);
  }
}
