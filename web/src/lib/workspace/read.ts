/**
 * The Workspace's reads: the API's six workspace routes, through the BFF with the caller's session
 * (the client adds the active org), each one request, never cached (`no-store`).
 *
 * - `GET /app/projects/{id}/workspace`: the Workspace, lists only. A project with no linked
 *   workspace reads `unlinked`; a linked one with no batch landed reads `never` (F40: the page draws
 *   the Shell and `WsNav` alone).
 * - `GET …/workspace/phases/{phase}`, `…/slices/{full}`, `…/docs/{doc}[?version=]`,
 *   `…/agenda/{item}`: one record, with the Workspace's sync facts beside it
 *   (`workspace {version, sync}`), so an item page makes one read for its back row's sync line.
 * - `GET …/workspace/deferred/{job}`: the folded-job lookup only (`{agenda}`, the item whose fold
 *   entry carries the job), which an old deferred job's address redirects through.
 *
 * Each answers a state, never a throw, for what a page draws: `ready`; `not-found` (a 404: a
 * record the workspace does not hold, a project with no linked workspace, or another tenant's);
 * `error` (a 503, the workspace store unavailable, or any other fault). A 401 is the session's and
 * is thrown, so the app's guard sends the reader to sign in.
 */
import "server-only";

import { ApiError, getJson } from "@/lib/knowledge/client";

import type {
  AgendaItem,
  Doc,
  FoldedJob,
  Phase,
  Slice,
  WithHead,
  Workspace,
  WorkspaceBase,
  WorkspaceHead,
} from "./types";

/** A read's answer, as a page draws it. */
export type Read<T> =
  | { state: "ready"; value: T }
  | { state: "not-found" }
  | { state: "error"; status: number | null };

/** The Workspace's answer: also unlinked or never synced, each with its sync facts. */
export type WorkspaceRead =
  | Read<Workspace>
  | { state: "unlinked"; head: WorkspaceHead }
  | { state: "never"; head: WorkspaceHead };

function path(project: string, ...rest: string[]): string {
  return ["/app/projects", project, "workspace", ...rest]
    .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
    .join("/");
}

async function read<T>(
  token: string,
  url: string,
  signal?: AbortSignal,
): Promise<Read<T>> {
  try {
    return { state: "ready", value: await getJson<T>(url, { token, signal }) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) throw error;
      if (error.status === 404) return { state: "not-found" };
      return { state: "error", status: error.status };
    }
    if (error instanceof Error && error.name === "AbortError") throw error;
    return { state: "error", status: null };
  }
}

/** The Workspace of a project: its lists, or unlinked, never synced, not found, failed. */
export async function readWorkspace(
  token: string,
  project: string,
  signal?: AbortSignal,
): Promise<WorkspaceRead> {
  const answer = await read<Workspace | WorkspaceBase>(
    token,
    path(project),
    signal,
  );
  if (answer.state !== "ready") return answer;
  const ws = answer.value;
  const head: WorkspaceHead = { version: ws.version, sync: ws.sync };
  if (!ws.linked || ws.sync.state === "unlinked")
    return { state: "unlinked", head };
  if (ws.sync.state === "never" || !("agenda" in ws))
    return { state: "never", head };
  return { state: "ready", value: ws as Workspace };
}

/** One phase, by its full or short id. */
export function readPhase(
  token: string,
  project: string,
  phase: string,
  signal?: AbortSignal,
): Promise<Read<WithHead<Phase>>> {
  return read(token, path(project, "phases", phase), signal);
}

/** One slice, by its full id, with its plan and result. */
export function readSlice(
  token: string,
  project: string,
  slice: string,
  signal?: AbortSignal,
): Promise<Read<WithHead<Slice>>> {
  return read(token, path(project, "slices", slice), signal);
}

/**
 * The agenda item an old deferred job's fold entry carries it onto (`{agenda}`); not found for a job
 * no entry names (the route's 404, `{detail, agenda: null}`).
 */
export function readFoldedJob(
  token: string,
  project: string,
  job: string,
  signal?: AbortSignal,
): Promise<Read<FoldedJob>> {
  return read(token, path(project, "deferred", job), signal);
}

/** One doc, at its latest version or the stored version named (`v0002`). */
export function readDoc(
  token: string,
  project: string,
  doc: string,
  version?: string | null,
  signal?: AbortSignal,
): Promise<Read<WithHead<Doc>>> {
  const query = version
    ? `?${new URLSearchParams({ version }).toString()}`
    : "";
  return read(token, `${path(project, "docs", doc)}${query}`, signal);
}

/** One agenda item, with its mark (a pending delete answers it marked `deleting`). */
export function readItem(
  token: string,
  project: string,
  item: string,
  signal?: AbortSignal,
): Promise<Read<WithHead<AgendaItem>>> {
  return read(token, path(project, "agenda", item), signal);
}
