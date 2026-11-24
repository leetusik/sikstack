import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { WS_HEAD } from "@/content/workspace/frame";
import {
  wsFailedTitle,
  wsHeadOf,
  WsItemFailed,
  wsSyncLine,
} from "@/sikstack/workspace/frame";
import { AgendaItemPage } from "@/sikstack/workspace/agenda-item";
import { itemProse } from "@/sikstack/workspace/agenda-item/prose";
import { requireIdentity } from "@/lib/auth-guards";
import { decodeWorkspaceFrom } from "@/lib/workspace/address";
import { readWorkspace } from "@/lib/workspace/read";

import { agendaItemBack } from "./back";
import { loadAgendaItem, requestClock } from "./load";

/**
 * An agenda item (`AgendaItem.dc.html`; frame.md F303 and the carried page) at
 * `/projects/<id>/workspace/agenda/<item>`, in the Shell with Workspace current. The server reads (`load.ts`) and
 * hands the client page the item, its rows, the sync line and the viewer's zone; the client page writes.
 *
 * The tab title is the Workspace's (F36), or the item's id when it did not load (`<id> · sikstack`): the read is
 * shared with the page (`loadOnce`). A failed read is the page's own Error under the back row with the sync line
 * (F49, F84); a render that throws is the route's (`error.tsx`).
 */
type Params = { projectId: string; item: string };
type Search = Record<string, string | string[] | undefined>;

/** The item's read, once a request: the tab title and the page share it. */
const loadOnce = cache(loadAgendaItem);

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { projectId, item } = await params;
  try {
    const { token } = await requireIdentity();
    const read = await loadOnce(token, projectId, item);
    if (read.state === "error") return { title: wsFailedTitle(item) };
  } catch (error) {
    unstable_rethrow(error);
  }
  return { title: WS_HEAD.title };
}

export default async function AgendaItemRoute({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { projectId, item } = await params;
  const from = (await searchParams).from;
  const back = agendaItemBack(projectId, from);
  const { token } = await requireIdentity();
  const read = await loadOnce(token, projectId, item);
  if (read.state === "not-found" && read.missing) notFound();
  const { timeZone, now } = requestClock(await cookies());
  if (read.state === "error") {
    const head = wsHeadOf(await readWorkspace(token, projectId));
    return (
      <WsItemFailed
        back={back}
        line={
          head ? wsSyncLine(head.sync, head.version, { timeZone, now }) : null
        }
      />
    );
  }
  const line = read.head
    ? wsSyncLine(read.head.sync, read.head.version, { timeZone, now })
    : null;
  return (
    <AgendaItemPage
      project={projectId}
      back={back}
      from={decodeWorkspaceFrom(from, projectId)}
      line={line}
      timeZone={timeZone}
      now={now}
      prose={read.state === "ready" ? itemProse(read.item) : undefined}
      read={
        read.state === "ready"
          ? {
              state: "ready",
              item: read.item,
              phases: read.phases,
              synced: read.synced ?? null,
            }
          : { state: "not-found", projectName: read.projectName }
      }
    />
  );
}
