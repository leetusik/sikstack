import "server-only";

import { getJson } from "@/lib/knowledge/client";
import type { DesignBuild, DesignManifest } from "@/sikstack/design/model";

// The Design service's members' reads (`server/design_api.py`), server to server with the
// member's session: a project's builds, newest first, and one build with its manifest. A
// project or build the member cannot see is the API's 404 (`ApiError`), the caller's to map.

/** `GET /app/projects/{id}/design/builds` → `{builds}`, newest first. */
export async function listDesignBuilds(token: string, projectId: string): Promise<DesignBuild[]> {
  const body = await getJson<{ builds?: DesignBuild[] }>(
    `/app/projects/${encodeURIComponent(projectId)}/design/builds`,
    { token },
  );
  return Array.isArray(body?.builds) ? body.builds : [];
}

/** `GET /app/projects/{id}/design/builds/{build}` → `{build, manifest}`. */
export async function getDesignBuild(
  token: string,
  projectId: string,
  buildId: string,
): Promise<{ build: DesignBuild; manifest: DesignManifest }> {
  const body = await getJson<{ build: DesignBuild; manifest: DesignManifest | null }>(
    `/app/projects/${encodeURIComponent(projectId)}/design/builds/${encodeURIComponent(buildId)}`,
    { token },
  );
  const manifest = body.manifest && typeof body.manifest === "object" ? body.manifest : {};
  return { build: body.build, manifest };
}
