import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { PROJECT_LIBRARY } from "@/content/project-library";
import { SIKSTACK_STATES } from "@/content/sikstack-states";
import { requestNonce } from "@/sikstack/shell/data";
import { optionalIdentity } from "@/lib/auth-guards";
import type { FormatOptions } from "@/lib/format";
import { readProjectPlace } from "@/lib/library/list-place";
import { loginHref } from "@/lib/next-path";
import {
  loadPublicProjectOnce,
  projectAt,
  type ProjectParams,
} from "@/lib/project-library/load";
import { projectLibraryView, visitorSource } from "@/lib/project-library/model";
import {
  projectLibraryHref,
  publicLibraryHref,
  publicProjectHref,
} from "@/lib/reader-href";
import { viewerTimeZone } from "@/lib/time-zone";

import {
  ProjectHead,
  ProjectParts,
  PublicProjectFrame,
} from "@/app/(app)/projects/[projectId]/library/parts";

/**
 * A public project's library, a visitor's (`ProjectLibrary.dc.html`, the visitor; frame.md F52, F321):
 * `/@{org}/{project}` in the bar's frame. The head (no way back of its own: the Bar's is the org's
 * public library), Books, Documents (no search, no Delete, no reading state), or Nothing to read. The
 * page is the address's (`?page=…`); every book and document opened here carries this list on (F324).
 *
 * The record draws this address for a visitor. A signed-in member of the org (the reader's active org)
 * is sent to the project's library in the Shell, `/projects/{id}/library`, with the address's place
 * (`?page`, `?q`) kept (P63, OQ7); any other reader, signed in or not, reads the visitor's page here
 * (a signed-in one without Sign in). A private project, an unknown project and an unknown org are one
 * miss to a non-member, Project not found (`notFound()`). An address without the `@` is no public address:
 * the guard rejects it before any read. The static `(public)/[org]/graph` segment wins over a project
 * named `graph` (its own route, a redirect to the org's library).
 */
type Params = ProjectParams;
type Search = Record<string, string | string[] | undefined>;

/** The address's org (without its `@`) and project; `notFound()` for anything else. */
function addressOf(params: Params): { org: string; project: string } {
  // THE GUARD: our public namespace is `@`-prefixed. Reject before reading the session or upstream.
  const at = projectAt(params);
  if (!at) notFound();
  return at;
}

async function readOnce(params: Params) {
  const at = addressOf(params);
  const ctx = await optionalIdentity();
  const read = await loadPublicProjectOnce(ctx?.token, at.org, at.project);
  if (!read) notFound();
  return { at, read, signedIn: !!ctx };
}

/** `notFound()`'s throw: Next marks it with this digest. */
const isNotFound = (error: unknown) =>
  typeof (error as { digest?: unknown })?.digest === "string" &&
  (error as { digest: string }).digest.startsWith(
    "NEXT_HTTP_ERROR_FALLBACK;404",
  );

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  // No `@`: no public address, a page that does not exist (P78, F12; the layout's 404).
  if (!projectAt(await params))
    return { title: SIKSTACK_STATES.notFound.title };
  try {
    const { read } = await readOnce(await params);
    return { title: read.project };
  } catch (error) {
    // the page renders the miss or the failure itself
    return {
      title: isNotFound(error)
        ? PROJECT_LIBRARY.notFound.title
        : SIKSTACK_STATES.error.title,
    };
  }
}

export default async function PublicProjectPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { at, read, signedIn } = await readOnce(await params);
  const place = readProjectPlace(await searchParams);
  // A member reads their own project in the Shell: before anything of the visitor's page is drawn. A hard
  // load is answered by the layout's 307 first; this one serves a client navigation that keeps the layout.
  if (read.memberId) {
    redirect(
      projectLibraryHref(read.memberId, { page: place.page, q: place.q }),
    );
  }
  const [jar, nonce] = await Promise.all([cookies(), requestNonce()]);
  const format: FormatOptions = { timeZone: viewerTimeZone(jar) };
  const view = projectLibraryView(
    read.listing,
    null,
    read.project,
    { viewer: "visitor", org: at.org },
    place,
    visitorSource(read.listing),
    format,
  );
  const here = publicProjectHref(
    { org: at.org, project: read.project },
    { page: view.docs.page },
  );
  return (
    <PublicProjectFrame
      nonce={nonce}
      back={{ href: publicLibraryHref(at.org), label: read.orgName }}
      signInHref={signedIn ? undefined : loginHref(here)}
    >
      <div className="column">
        <ProjectHead view={view} viewer="visitor" />
        <ProjectParts view={view} />
      </div>
    </PublicProjectFrame>
  );
}
