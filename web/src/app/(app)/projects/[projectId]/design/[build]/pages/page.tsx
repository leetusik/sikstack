import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { DESIGN } from "@/content/design";
import { buildTitle } from "@/sikstack/design/model";
import { DesignBuildGone } from "@/sikstack/design/viewer";
import { DesignViewer } from "@/sikstack/design/viewer-island";
import { requireIdentity } from "@/lib/auth-guards";
import { getDesignBuild } from "@/lib/design/app";
import { getProject } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import { viewerTimeZone } from "@/lib/time-zone";

/**
 * A design build's every-page list (P84), `/projects/<id>/design/<build>/pages`: every page of the build's
 * manifest, whatever its round, one link from the round's list (the build's viewer, `../page.tsx`) and back. The
 * same reads as the viewer (the project, then the build with its manifest; its 404 is the build gone) and the
 * same component (`scope="all"`). It frames nothing (no options page here), so it needs no build origin and is
 * served under the app's own CSP.
 */
const missing = (error: unknown) => error instanceof ApiError && [400, 404, 422].includes(error.status);

const buildOnce = cache((token: string, project: string, build: string) =>
  getDesignBuild(token, project, build),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; build: string }>;
}): Promise<Metadata> {
  const { projectId, build } = await params;
  try {
    const { token } = await requireIdentity();
    return {
      title: `${DESIGN.whole.title} · ${buildTitle((await buildOnce(token, projectId, build)).build)}`,
    };
  } catch (error) {
    unstable_rethrow(error);
    return { title: missing(error) ? DESIGN.gone.title : DESIGN.title };
  }
}

export default async function DesignBuildPagesPage({
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
    read = await buildOnce(token, projectId, buildId);
  } catch (error) {
    unstable_rethrow(error);
    if (missing(error)) return <DesignBuildGone project={projectId} projectName={projectName} />;
    throw error;
  }
  const timeZone = viewerTimeZone(await cookies());
  return (
    <DesignViewer
      project={projectId}
      scope="all"
      build={read.build}
      manifest={read.manifest}
      origin={null}
      timeZone={timeZone}
    />
  );
}
