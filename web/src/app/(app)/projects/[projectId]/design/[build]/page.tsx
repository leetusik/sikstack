import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";

import { DESIGN } from "@/content/design";
import { DesignBuildGone } from "@/sikstack/design/viewer";
import { DesignViewer } from "@/sikstack/design/viewer-island";
import { requireIdentity } from "@/lib/auth-guards";
import { designBuildOrigin } from "@/lib/csp";
import { getDesignBuild } from "@/lib/design/app";
import { getProject } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import { viewerTimeZone } from "@/lib/time-zone";

/**
 * A design build's viewer (P77), the project rail's Design current. Two reads: the project (its name for the
 * gone page; no project of the active org is Not found) and the build with its manifest (`GET …/builds/{id}`;
 * its 404 is the build gone: deleted, or never this project's). The build's origin comes from
 * `KB_DESIGN_ORIGIN`, as the proxy forms the page's CSP (`@/lib/csp`): without one nothing is framed and every
 * page still opens through the open route. The page is entered by a full page load (the list links it so),
 * since the CSP that lets it frame the build is the document's.
 */
export const metadata: Metadata = { title: DESIGN.title };

const missing = (error: unknown) => error instanceof ApiError && [400, 404, 422].includes(error.status);

export default async function DesignBuildPage({
  params,
}: {
  params: Promise<{ projectId: string; build: string }>;
}) {
  const { projectId, build: buildId } = await params;
  const { token } = await requireIdentity();
  let projectName: string;
  try {
    projectName = (await getProject(token, projectId)).name;
  } catch (error) {
    unstable_rethrow(error);
    if (missing(error)) notFound();
    throw error;
  }
  let read;
  try {
    read = await getDesignBuild(token, projectId, buildId);
  } catch (error) {
    unstable_rethrow(error);
    if (missing(error)) return <DesignBuildGone project={projectId} projectName={projectName} />;
    throw error;
  }
  const timeZone = viewerTimeZone(await cookies());
  return (
    <DesignViewer
      project={projectId}
      build={read.build}
      manifest={read.manifest}
      origin={designBuildOrigin(process.env.KB_DESIGN_ORIGIN, read.build.id)}
      timeZone={timeZone}
    />
  );
}
