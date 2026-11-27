import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { SETTINGS } from "@/content/settings";
import { requireIdentity } from "@/lib/auth-guards";
import { getProjectUsage } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import { getMembers } from "@/lib/knowledge/orgs";
import type { KbProjectUsage } from "@/lib/knowledge/types";

import { isMissingProjectStatus, keyRowOf, projectHomeFormat } from "../model";
import { ProjectSettings } from "./project-settings";

/**
 * Project settings (`/projects/<id>/settings`, P88-ms.S3's signed design): the project rail's Settings. Its title is
 * `Project settings · <project> · sikstack` (the folder's layout). Reads, in parallel: `getProjectUsage` (the project
 * and its keys, as project home reads them; a missing or another org's id is Not found, 404-never-403) and
 * `GET /app/members` (the viewer's role: the visibility switch and Delete project are the org owner's; a role read
 * that fails draws a member's view, and the API refuses a member's writes either way). Dates in the viewer's zone.
 */
export const metadata: Metadata = { title: SETTINGS.project.title };

async function loadProject(token: string, projectId: string): Promise<KbProjectUsage> {
  try {
    return await getProjectUsage(token, projectId);
  } catch (error) {
    if (error instanceof ApiError && isMissingProjectStatus(error.status)) notFound();
    throw error;
  }
}

async function readRole(token: string): Promise<"owner" | "member" | null> {
  try {
    return (await getMembers(token)).role;
  } catch {
    return null;
  }
}

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { token, identity } = await requireIdentity();
  const format = projectHomeFormat(await cookies());
  const [usage, role] = await Promise.all([loadProject(token, projectId), readRole(token)]);
  const { project } = usage;
  return (
    <ProjectSettings
      project={{ id: project.id, name: project.name, visibility: project.visibility }}
      org={identity.tenant?.name ?? "—"}
      owner={role === "owner"}
      keys={usage.credentials.map(keyRowOf)}
      format={format}
    />
  );
}
