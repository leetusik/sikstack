import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";

import { DESIGN } from "@/content/design";
import { DesignListView } from "@/sikstack/design/list";
import { requireIdentity } from "@/lib/auth-guards";
import { listDesignBuilds } from "@/lib/design/app";
import { ApiError } from "@/lib/knowledge/client";
import { viewerTimeZone } from "@/lib/time-zone";

/**
 * A project's Design (P77): its design builds, newest first, the project rail's Design current. One read,
 * the members' list (`GET /app/projects/{id}/design/builds`). A project that is no project of the active
 * org (the API's 404, 400 or 422): Not found. Any other failed read is the error boundary's.
 */
export const metadata: Metadata = { title: DESIGN.title };

export default async function ProjectDesignPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { token } = await requireIdentity();
  let builds;
  try {
    builds = await listDesignBuilds(token, projectId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && [400, 404, 422].includes(error.status)) notFound();
    throw error;
  }
  const timeZone = viewerTimeZone(await cookies());
  return <DesignListView project={projectId} builds={builds} timeZone={timeZone}/>;
}
