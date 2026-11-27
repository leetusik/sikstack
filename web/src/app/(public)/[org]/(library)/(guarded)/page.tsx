import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";

import { SIKSTACK_STATES } from "@/content/sikstack-states";
import { PUBLIC_LIBRARY } from "@/content/public-library";
import { optionalIdentity } from "@/lib/auth-guards";
import { loginHref } from "@/lib/next-path";
import { loadPublicLibraryOnce } from "@/lib/public-library/load";
import { publicLibraryView, publicOrgOf } from "@/lib/public-library/model";
import { publicLibraryHref } from "@/lib/reader-href";
import { viewerTimeZone } from "@/lib/time-zone";
import { canonical } from "@/sikstack/seo/urls";

import { PublicLibraryHead, PublicShelves } from "../parts";

/**
 * An org's public library (`PublicLibrary.dc.html`; `## Build` § Page: public-library): `/@{org}`, the
 * org's public projects only, in the frame the layout chose. The head, then one `Shelf` per public
 * project with something to read; a visitor's rows carry no reading state, a signed-in reader's carry
 * their own. A shelf's foot link goes to the project's library: a member of the org's
 * (`/projects/{id}/library`, in the Shell), anyone else's (`/@{org}/{project}`, the bar's frame). Every
 * book and document opened here carries this list on, so its way back returns here (F324).
 *
 * An unknown org, and an org with nothing public to read, are Library not found to a visitor (and to a
 * signed-in reader of another org); the last is Nothing public to a member of the org. That miss is
 * found by a read under `loading.tsx`, so it streams as a 200 marked noindex (OQ6). The tab title is
 * the org's name, through the site's template (one set of reads a request). P87: its canonical URL is
 * `/@{org}` on the org's label (its slug, else its tenant id), the one `/sitemap.xml` lists.
 */
type Params = { org: string };

async function readOnce(params: Params) {
  const org = publicOrgOf(params.org);
  if (org === null) notFound();
  const ctx = await optionalIdentity();
  const read = await loadPublicLibraryOnce(ctx?.token, org);
  if (!read) notFound();
  return { org, read, signedIn: ctx !== null };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const org = publicOrgOf((await params).org);
  // No `@`: no public library, a page that does not exist (P78, F12).
  if (org === null) return { title: SIKSTACK_STATES.notFound.title };
  try {
    const ctx = await optionalIdentity();
    const read = await loadPublicLibraryOnce(ctx?.token, org);
    if (!read) return { title: PUBLIC_LIBRARY.notFound.title };
    const view = publicLibraryView(read.listing, read.state, {
      org,
      ids: read.ids,
    });
    if (!view) return { title: PUBLIC_LIBRARY.notFound.title };
    return {
      title: read.listing.org.name,
      alternates: canonical(publicLibraryHref(read.listing.org.label)),
    };
  } catch (error) {
    unstable_rethrow(error);
    // the page renders the failure itself
    return { title: SIKSTACK_STATES.error.title };
  }
}

export default async function PublicLibraryPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { org, read, signedIn } = await readOnce(await params);
  const format = { timeZone: viewerTimeZone(await cookies()) };
  const view = publicLibraryView(
    read.listing,
    read.state,
    { org, ids: read.ids },
    format,
  );
  if (!view) notFound();
  const viewer = signedIn ? "member" : "visitor";
  return (
    <div className="column">
      <PublicLibraryHead
        orgName={view.orgName}
        count={view.count}
        viewer={viewer}
        phase={view.phase}
        signInHref={signedIn ? undefined : loginHref(publicLibraryHref(org))}
      />
      {view.phase === "ready" ? (
        <PublicShelves shelves={view.shelves} from={view.from} />
      ) : null}
    </div>
  );
}
