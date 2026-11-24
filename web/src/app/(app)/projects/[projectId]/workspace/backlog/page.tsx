import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { PROJECT_HOME } from "@/content/project";
import { WS_HEAD } from "@/content/workspace/frame";
import { requireIdentity } from "@/lib/auth-guards";
import { viewerTimeZone } from "@/lib/time-zone";
import { agendaHref, backlogHref, docsHref } from "@/lib/workspace/address";
import { readWorkspace } from "@/lib/workspace/read";
import { NO_LINE, WsNav, wsSyncLine } from "@/sikstack/workspace/frame";
import {
  askedPage,
  BacklogFailed,
  BacklogNow,
  BacklogPhases,
  BacklogWaiting,
  backlogView,
} from "@/sikstack/workspace/backlog";

import { requestOrigin } from "../../model";

/**
 * A project's backlog (`Backlog.dc.html`, frame.md F304): `/projects/{id}/workspace/backlog` in the Shell. `WsNav`
 * (Backlog current, the sync line), then **Waiting on operator** (only when something waits), **Now**,
 * **Phases** and **Archived phases** (ten a page, `?archived=N`). One read: the Workspace's lists.
 *
 * A project the Workspace does not hold (another org's, or none) is Not found; a workspace not linked or never
 * synced draws `WsNav`'s one panel and nothing else (F40); a failed read keeps the head and Now's
 * `The backlog did not load.` with Try again, and Phases is not drawn (F49).
 */
type Params = { projectId: string };
type Search = Record<string, string | string[] | undefined>;

export const metadata: Metadata = {
  title: WS_HEAD.title,
  robots: { index: false },
};

export default async function WorkspaceBacklogPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { projectId } = await params;
  const search = await searchParams;
  const { token } = await requireIdentity();
  const read = await readWorkspace(token, projectId);
  if (read.state === "not-found") notFound();

  const hrefs = {
    agenda: agendaHref(projectId),
    backlog: backlogHref(projectId),
    docs: docsHref(projectId),
  };

  if (read.state === "error")
    return (
      <div className="column">
        <WsNav current="backlog" line={NO_LINE} hrefs={hrefs} />
        <BacklogFailed />
      </div>
    );

  const timeZone = viewerTimeZone(await cookies());
  if (read.state === "unlinked" || read.state === "never") {
    const origin = requestOrigin(await headers());
    return (
      <div className="column">
        <WsNav
          current="backlog"
          line={wsSyncLine(read.head.sync, read.head.version, { timeZone })}
          hrefs={hrefs}
          command={
            origin
              ? PROJECT_HOME.workspace.run.command(origin, projectId)
              : null
          }
        />
      </div>
    );
  }

  const ws = read.value;
  const view = backlogView(ws, projectId, askedPage(search.archived));
  return (
    <div className="column">
      <WsNav
        current="backlog"
        line={wsSyncLine(ws.sync, ws.version, { timeZone })}
        hrefs={hrefs}
      />
      <BacklogWaiting items={view.waiting} />
      <BacklogNow now={view.now} />
      <BacklogPhases
        phases={view.phases}
        archived={view.archived}
        project={projectId}
      />
    </div>
  );
}
