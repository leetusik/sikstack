import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { PROJECT_HOME } from "@/content/project";
import { WS_HEAD } from "@/content/workspace/frame";
import {
  docsCount,
  DocsList,
  DocsListFailed,
  docsRow,
  placeHrefs,
  retiredCount,
} from "@/sikstack/workspace/docs";
import { WsNav } from "@/sikstack/workspace/frame/nav";
import {
  wsSyncLine,
  type WsSyncLine,
} from "@/sikstack/workspace/frame/sync-model";
import { requireIdentity } from "@/lib/auth-guards";
import { viewerTimeZone } from "@/lib/time-zone";
import { dates } from "@/lib/workspace/model";
import { readWorkspace } from "@/lib/workspace/read";

import { requestOrigin } from "../../model";

/**
 * The docs (`Docs.dc.html`, the list; F41, F79, F82): one of the Workspace's three places. The Workspace head with
 * Docs current, then panel **Docs** (`5 docs, 2 stale`, the table) and panel **Retired** when the workspace has
 * retired docs. One read, `GET …/workspace`. Never synced and not linked are the head's one panel alone (F40); a
 * read that failed keeps the places and the panel's head, `Docs did not load.` and **Try again**; a project that is
 * not the org's is Not found.
 */
export const metadata: Metadata = { title: WS_HEAD.title };

/** The places with no sync line to show: the read failed, so nothing is known of the workspace's sync. */
const UNKNOWN_LINE: WsSyncLine = {
  state: "fresh",
  text: "",
  cls: "",
  version: "",
};

export default async function WorkspaceDocsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { token } = await requireIdentity();
  const zone = viewerTimeZone(await cookies());
  const read = await readWorkspace(token, projectId);
  if (read.state === "not-found") notFound();
  const hrefs = placeHrefs(projectId);

  if (read.state === "error") {
    return (
      <div className="column">
        <WsNav current="docs" line={UNKNOWN_LINE} hrefs={hrefs} />
        <DocsListFailed />
      </div>
    );
  }

  if (read.state === "unlinked" || read.state === "never") {
    const origin = requestOrigin(await headers());
    return (
      <div className="column">
        <WsNav
          current="docs"
          line={wsSyncLine(read.head.sync, read.head.version, {
            timeZone: zone,
          })}
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
  const d = dates(zone);
  return (
    <div className="column">
      <WsNav
        current="docs"
        line={wsSyncLine(ws.sync, ws.version, { timeZone: zone })}
        hrefs={hrefs}
      />
      <DocsList
        state={{
          kind: "ok",
          rows: ws.docs.map((doc) => docsRow(projectId, doc, d)),
          count: docsCount(ws.docs),
          retired: ws.retired.map((doc) => docsRow(projectId, doc, d)),
          retiredCount: retiredCount(ws.retired),
        }}
      />
    </div>
  );
}
