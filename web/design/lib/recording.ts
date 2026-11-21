import raw from "design-recording";

import type { AgendaItem, WorkspaceHead, Workspace } from "@/lib/workspace/types";

import { DESIGN_MARK } from "./mark";

/**
 * A recording of the real API (`design/scripts/record.mjs`): `GET /app/projects/{id}/workspace` and
 * each `GET …/workspace/agenda/{item}`, with the project id and every date normalized, plus the
 * Shell's names (never the account's) and the moment it was taken, which the design's clock reads.
 */
export interface Recording {
  $design: typeof DESIGN_MARK;
  /** Which recording, for the store's key (`sample`, or the `data/local/` file's name). */
  name: string;
  /** The recording's clock: "Synced … ago" and an item's dates read from it, on the build and in the browser. */
  now: string;
  timeZone: string;
  shell: {
    org: { id: string; name: string };
    project: { name: string; visibility: "private" | "public"; created_at: string };
    email: string;
  };
  workspace: Workspace;
  items: Record<string, AgendaItem & { workspace: WorkspaceHead }>;
}

function check(value: unknown): Recording {
  const r = value as Partial<Recording> | null;
  if (!r || r.$design !== DESIGN_MARK || !r.workspace || !Array.isArray(r.workspace.agenda))
    throw new Error("design-recording is not a design recording (no $design mark or no workspace)");
  return r as Recording;
}

export const RECORDING = check(raw);
export const PROJECT = RECORDING.workspace.project;
export const NOW = Date.parse(RECORDING.now);
export const TIME_ZONE = RECORDING.timeZone;
