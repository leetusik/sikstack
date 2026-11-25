import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";

import { SITE } from "@/content";
import { LIBRARY_PAGE } from "@/content/library-page";
import { PROJECT_LIBRARY } from "@/content/project-library";
import { requireIdentity } from "@/lib/auth-guards";
import type { FormatOptions } from "@/lib/format";
import { readProjectPlace, type ProjectPlace } from "@/lib/library/list-place";
import { loadDocsSource } from "@/lib/library/load-lists";
import type { DocsSource } from "@/lib/library/lists";
import type { KbOrgLibrary } from "@/lib/knowledge/types";
import { loadMemberProjectOnce } from "@/lib/project-library/load";
import { projectLibraryView } from "@/lib/project-library/model";
import { viewerTimeZone } from "@/lib/time-zone";

import { ProjectHead, ProjectParts } from "./parts";

/**
 * A project's library, a member's (`ProjectLibrary.dc.html`; frame.md F321): `/projects/{id}/library`
 * in the Shell (the rail's Library current, the project picked). The head, Continue reading within the
 * project, Books, Documents (search, Delete, 25 a page), or Nothing to read. The page and search are
 * the address's (`?page=…&q=…`), so every book and document opened here carries this list on (F324).
 *
 * An id that is no project of the active org is Project not found (`notFound()`); a fault of the
 * page's reads is the route's Error; a fault of the table's own reads (the text search) is the
 * table's failed state, the rest standing. Dates are in the viewer's zone. The tab title is the
 * project's name, through the site's template (one read a request, `loadMemberProjectOnce`).
 */
type Params = { projectId: string };
type Search = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { projectId } = await params;
  try {
    const { token, identity } = await requireIdentity();
    const read = await loadMemberProjectOnce(token, identity, projectId);
    // P78, F17: `Library · <project>` through the project's template (the folder above names the project).
    return {
      title: read
        ? LIBRARY_PAGE.title
        : {
            absolute: SITE.titleTemplate.replace(
              "%s",
              PROJECT_LIBRARY.notFound.title,
            ),
          },
      robots: { index: false },
    };
  } catch (error) {
    unstable_rethrow(error);
    // the page renders the failure itself
    return { robots: { index: false } };
  }
}

async function readSource(
  token: string,
  listing: KbOrgLibrary,
  project: string,
  place: ProjectPlace,
): Promise<DocsSource | null> {
  try {
    return await loadDocsSource(token, listing, {
      q: place.q,
      filter: project,
      page: place.page,
    });
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

export default async function ProjectLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { projectId } = await params;
  const place = readProjectPlace(await searchParams);
  const { token, identity } = await requireIdentity();
  const read = await loadMemberProjectOnce(token, identity, projectId);
  if (!read) notFound();
  const format: FormatOptions = { timeZone: viewerTimeZone(await cookies()) };
  const source = await readSource(token, read.listing, read.project, place);
  const view = projectLibraryView(
    read.listing,
    read.state,
    read.project,
    { viewer: "member", id: projectId },
    place,
    source ?? { tags: new Map(), text: null },
    format,
  );
  return (
    <div className="column">
      <ProjectHead view={view} viewer="member" />
      <ProjectParts
        view={view}
        continueItems={read.continue}
        docsFailed={source === null}
      />
    </div>
  );
}
