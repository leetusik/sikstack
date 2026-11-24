import "server-only";

import { getProject } from "@/lib/knowledge/app";
import { ApiError } from "@/lib/knowledge/client";
import {
  readItem,
  readWorkspace,
  type WorkspaceRead,
} from "@/lib/workspace/read";
import type { WorkspaceHead } from "@/lib/workspace/types";
import { viewerTimeZone, type CookieReader } from "@/lib/time-zone";
import { itemLines, type ItemRead } from "@/sikstack/workspace/agenda-item/model";

/**
 * What an agenda item's page reads, and no more (one page, its own reads):
 *
 * - **the item's own route** (`GET …/workspace/agenda/{item}`), which carries the Workspace's sync facts for the
 *   back row's line;
 * - **plus `GET …/workspace`** only when the item holds a phase, for those rows (their names, statuses and
 *   progress); an item that holds none is one read.
 *
 * An item the route does not hold (a 404: no such item, no linked workspace) is Not found (a delete that waits is
 * answered as the item, marked `deleting`: the page draws Item deleted),
 * which says the project's name and keeps the sync line under the back row: it reads the project and the
 * Workspace, together. A project the org does not hold is the project's own Not found (`missing`). A failed
 * read is `error`: the route's boundary draws it. A 401 is the session's and is thrown.
 */
export type ItemLoad =
  | ({ state: "ready"; head: WorkspaceHead } & ItemRead)
  | {
      state: "not-found";
      head: WorkspaceHead | null;
      projectName: string | null;
      missing: boolean;
    }
  | { state: "error" };

function headOf(read: WorkspaceRead): WorkspaceHead | null {
  if (read.state === "ready")
    return { version: read.value.version, sync: read.value.sync };
  if (read.state === "unlinked" || read.state === "never") return read.head;
  return null;
}

async function projectName(
  token: string,
  project: string,
): Promise<{ name: string | null; missing: boolean }> {
  try {
    return { name: (await getProject(token, project)).name, missing: false };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) throw error;
      if (error.status === 404 || error.status === 400)
        return { name: null, missing: true };
    }
    return { name: null, missing: false };
  }
}

export async function loadAgendaItem(
  token: string,
  project: string,
  itemId: string,
): Promise<ItemLoad> {
  const read = await readItem(token, project, itemId);
  if (read.state === "error") return { state: "error" };
  if (read.state === "not-found") {
    const [ws, named] = await Promise.all([
      readWorkspace(token, project),
      projectName(token, project),
    ]);
    return {
      state: "not-found",
      head: headOf(ws),
      projectName: named.name,
      missing: named.missing,
    };
  }
  const { workspace: head, ...item } = read.value;
  const synced = head.sync?.at ?? null;
  if (item.phases.length === 0)
    return { state: "ready", head, item, phases: [], synced };
  const ws = await readWorkspace(token, project);
  if (ws.state === "error") return { state: "error" };
  const lines = itemLines(item, ws.state === "ready" ? ws.value : null);
  return { state: "ready", head, item, ...lines, synced };
}

/** The request's clock, read once, and the viewer's zone, for every date and the sync line on the page. */
export function requestClock(store: CookieReader): {
  timeZone: string;
  now: number;
} {
  return { timeZone: viewerTimeZone(store), now: Date.now() };
}
