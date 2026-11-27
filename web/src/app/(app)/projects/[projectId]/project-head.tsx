import Link from "next/link";

import { PROJECT_HOME } from "@/content/project";
import { Badge, Skeleton } from "@/sikstack/ui";

import type { Visibility } from "./model";

const W = PROJECT_HOME.head;

/** The back link to org home (`.back`, accessible name `Back to <org>`). */
function Back({ org }: { org: string }) {
  return (
    <Link href="/dashboard" className="back" aria-label={W.back(org)}>
      {org}
    </Link>
  );
}

/**
 * The head (`ProjectHomeHead.dc.html`): the back link, the project's name with its Public or Private
 * badge and `Created …`. The switch that flipped it (Make public, Make private) is Project settings'
 * Visibility panel since P88-ms.S3's signed design (`/projects/<id>/settings`); the badge stays here,
 * and every save there revalidates this page.
 */
export function ProjectHead({
  name,
  org,
  created,
  visibility,
}: {
  name: string;
  org: string;
  /** The created date, already formatted (`Mar 2`). */
  created: string;
  visibility: Visibility;
}) {
  return (
    <div className="stack">
      <header className="page-top">
        <Back org={org} />
        <div className="page-head">
          <div className="page-title ph-title">
            <h1>{name}</h1>
            <Badge>
              {visibility === "public" ? W.badge.public : W.badge.private}
            </Badge>
            <span className="meta">{W.created(created)}</span>
          </div>
        </div>
      </header>
    </div>
  );
}

/** The head while the page loads: the back link, and the `h1` holding a 7em skeleton. */
export function ProjectHeadLoading({ org }: { org: string }) {
  return (
    <div className="stack">
      <header className="page-top">
        <Back org={org} />
        <div className="page-head">
          <div className="page-title ph-title">
            <h1 aria-busy="true">
              <Skeleton width="7em" />
              <span className="sr-only">{PROJECT_HOME.loading}</span>
            </h1>
          </div>
        </div>
      </header>
    </div>
  );
}
