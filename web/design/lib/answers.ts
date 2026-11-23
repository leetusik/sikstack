import emptyRaw from "../data/sample/states/empty.json";
import manyRaw from "../data/sample/states/many.json";
import neverRaw from "../data/sample/states/never.json";
import unlinkedRaw from "../data/sample/states/unlinked.json";
import waitingRaw from "../data/sample/states/waiting.json";

import type { Unplaced, Workspace, WorkspaceHead } from "@/lib/workspace/types";

import { mintPool } from "./ids";
import { NOW, RECORDING, type Recording } from "./recording";

/**
 * The answers the pages' state presets read (`screens.tsx`), beside the recording the store starts from.
 * Each file under `data/sample/states/` is the local API's own answer, taken by `design:record --state
 * <name>` from a sample project in that state:
 *
 * - `unlinked`: a project with no linked workspace; `never`: a workspace key that probed the head, no batch;
 * - `empty`: a linked, synced workspace with no agenda item; `many`: 46 items (23 open, 14 deferred, 9 ended);
 * - `waiting`: three web changes the engine has not taken yet (an add, a defer, an edit: rows marked waiting).
 *
 * Two are made here, because no API answer holds them on demand: `behind` (a sync older than the server's 24
 * hours, which only time makes) and `waiting`'s one open change that no row carries (the engine applies the
 * inbox before any local change it syncs, so the race never shows on demand).
 */

/** A data set the store can hold: a workspace and each item as its own route answered it. */
export type DataSet = Pick<Recording, "workspace" | "items">;

/** An answer whose Workspace may be unlinked or never synced: only its head is read. */
interface HeadAnswer {
  workspace: { linked: boolean } & WorkspaceHead;
}

const asSet = (raw: unknown): DataSet => raw as DataSet;

/** The head of the unlinked and never-synced answers (`page.tsx` draws `WsNav` alone from it). */
export const HEADS: Record<"unlinked" | "never", WorkspaceHead> = {
  unlinked: headOf(unlinkedRaw as HeadAnswer),
  never: headOf(neverRaw as HeadAnswer),
};

function headOf(a: HeadAnswer): WorkspaceHead {
  return { version: a.workspace.version, sync: a.workspace.sync };
}

/** Made, not recorded: a sync three days before the recording's clock (the server says behind after 24 h). */
const BEHIND_AT = new Date(NOW - 3 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");

/** Made, not recorded: one open change that no row carries, in the shape `GET …/workspace` lists it. */
const UNPLACED: Unplaced = {
  entry: "5d2c7a8e-3f41-4b6a-9c0d-7e2f1a4b8c63",
  kind: "defer",
  items: ["A6-r2"],
  fields: {},
  sync: "waiting",
  refused: null,
  created: (waitingRaw as DataSet).workspace.sync.at,
};

const waiting = asSet(waitingRaw);

/** The data sets the Agenda's presets put in the store, by preset name. */
export const DATA_SETS = {
  recorded: { workspace: RECORDING.workspace, items: RECORDING.items },
  empty: asSet(emptyRaw),
  many: asSet(manyRaw),
  waiting: {
    ...waiting,
    workspace: { ...waiting.workspace, unplaced: [...waiting.workspace.unplaced, UNPLACED] },
  },
  behind: {
    workspace: {
      ...RECORDING.workspace,
      sync: { state: "behind", at: BEHIND_AT },
    } satisfies Workspace,
    items: RECORDING.items,
  },
} satisfies Record<string, DataSet>;

export type DataName = keyof typeof DATA_SETS;

/**
 * Every item page the build makes: each item of every data set, and for each set the ids the store mints
 * for the first items added in the browser (`ids.ts`), so a click on any row the design can draw lands.
 */
export function itemPageIds(): string[] {
  const out = new Set<string>();
  for (const set of Object.values(DATA_SETS)) {
    const ids = set.workspace.agenda.map((a) => a.id);
    for (const id of [...ids, ...mintPool(ids)]) out.add(id);
  }
  return [...out];
}
