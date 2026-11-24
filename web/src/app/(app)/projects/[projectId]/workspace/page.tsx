import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { PROJECT_HOME } from "@/content/project";
import { WS_HEAD } from "@/content/workspace/frame";
import {
  AgendaFailed,
  AgendaList,
  deferredPageFrom,
  workspaceHrefs,
} from "@/sikstack/workspace/agenda";
import { NO_LINE, WsNav, wsSyncLine } from "@/sikstack/workspace/frame";
import { requireIdentity } from "@/lib/auth-guards";
import { viewerTimeZone } from "@/lib/time-zone";
import { readWorkspace } from "@/lib/workspace/read";

import { requestOrigin } from "../model";

// The Agenda (design job 02, `Agenda.dc.html`, frame.md F41: the Workspace opens here), inside the Shell, in
// `.app-main > .column`: `WsNav` with the Agenda current, then the agenda's parts. One read, the Workspace's
// (`GET …/workspace`): its sync line, its phases (an item's state and end cell) and the agenda with its unplaced
// changes. Not linked or never synced: `WsNav` alone, its one panel. A project the org does not hold: Not found.
// The read failed: the head stands and the part says it, with Try again (F49). Dates are in the viewer's zone.
//
// The tab title is the static `Workspace` (`Workspace · sikstack`): a title from the read would cost a second one.
export const metadata: Metadata = { title: WS_HEAD.title };

export default async function AgendaPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const { token } = await requireIdentity();
  const timeZone = viewerTimeZone(await cookies());
  const hrefs = workspaceHrefs(projectId);

  const read = await readWorkspace(token, projectId);
  if (read.state === "not-found") notFound();

  if (read.state === "unlinked" || read.state === "never") {
    const origin = requestOrigin(await headers());
    return (
      <div className="column">
        <WsNav
          current="agenda"
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

  if (read.state === "error") {
    return (
      <div className="column">
        <WsNav current="agenda" line={NO_LINE} hrefs={hrefs} />
        <AgendaFailed />
      </div>
    );
  }

  const ws = read.value;
  return (
    <div className="column">
      <WsNav
        current="agenda"
        line={wsSyncLine(ws.sync, ws.version, { timeZone })}
        hrefs={hrefs}
      />
      <AgendaList
        project={projectId}
        read={{ agenda: ws.agenda, unplaced: ws.unplaced, synced: ws.sync.at }}
        phases={ws.phases.map((p) => ({
          id: p.id,
          short: p.short,
          status: p.status,
        }))}
        timeZone={timeZone}
        deferredPage={deferredPageFrom(query.deferred)}
      />
    </div>
  );
}
