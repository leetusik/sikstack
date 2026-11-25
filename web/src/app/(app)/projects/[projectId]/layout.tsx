import type { Metadata } from "next";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { PROJECT_HOME } from "@/content/project";
import { SITE } from "@/content";
import { requireIdentity } from "@/lib/auth-guards";
import { getProject } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";

import { isMissingProjectStatus } from "./model";

/** The project's one read for the tab titles, once a request. */
const projectOnce = cache((token: string, projectId: string) =>
  getProject(token, projectId),
);

/**
 * A project's pages' tab titles (P78, F17): every page under `/projects/<id>` names the project, so two tabs on
 * two projects read apart. The overview's title is the project's name (`<name> · sikstack`); a page's own title
 * goes before it (`Workspace · <name> · sikstack`, `A1 Title · <name> · sikstack`, `Library · <name> · sikstack`). A project the API does not give
 * this reader is Project not found; a failed read leaves the pages' own titles under the site's template.
 * The read is one light `GET /app/projects/{id}` a request.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): Promise<Metadata> {
  const { projectId } = await params;
  try {
    const { token } = await requireIdentity();
    const { name } = await projectOnce(token, projectId);
    return {
      title: {
        // the root's template wraps a default (`<name> · sikstack`), never a template's own title
        default: name,
        template: SITE.titleTemplate.replace("%s", `%s · ${name}`),
      },
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ApiError && isMissingProjectStatus(error.status))
      return {
        title: {
          absolute: SITE.titleTemplate.replace(
            "%s",
            PROJECT_HOME.notFound.title,
          ),
        },
      };
    return {};
  }
}

export default function ProjectLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
