import emptyRaw from "../data/sample/states/empty.json";
import manyRaw from "../data/sample/states/many.json";
import neverRaw from "../data/sample/states/never.json";
import unlinkedRaw from "../data/sample/states/unlinked.json";
import waitingRaw from "../data/sample/states/waiting.json";
import webWaitingRaw from "../data/sample/states/web-waiting.json";

import type { FeedbackAgendaItem } from "@/lib/feedback/types";
import type { AgendaItem, Unplaced, Workspace, WorkspaceHead } from "@/lib/workspace/types";

import { mintPool } from "./ids";
import { NOW, RECORDING, type Recording } from "./recording";

/**
 * The answers the pages' state presets read (`screens.tsx`), beside the recording the store starts from.
 * Each file under `data/sample/states/` is the local API's own answer, taken by `design:record --state
 * <name>` from a sample project in that state:
 *
 * - `unlinked`: a project with no linked workspace; `never`: a workspace key that probed the head, no batch;
 * - `empty`: a linked, synced workspace with no agenda; `many`: 46 agendas (14 Proposed, 23 open, 9 ended; the
 *   recording's 14 stored Deferred, which the read now gives as Proposed);
 * - `waiting`: three web changes the engine has not taken yet (an add and two edits: rows marked waiting, their
 *   stored values shown);
 * - `web-waiting` (P61-e9): the recording's project after three web writes the engine has not taken yet: a note on
 *   A3-1z's thread (its entry last, waiting), the third piece of feedback filed on a new item (A11-vz, waiting) and
 *   an accept of A9-hb (the read keeps it Proposed, marked waiting, until the sync).
 *
 * The recording itself (P61-e9) holds three Proposed agendas (A8-sf, folded from an old job by `agent:fold`; A9-hb,
 * opened by `agent:claude-opus-5-5`; A4-jq, stored Deferred, which reads Proposed), A3-1z's items by agents and
 * people (each with its file, ref and state), and three pieces of feedback: f1 filed on a new agenda (A10-3n) and on
 * A3-1z, f2 on A3-1z, f3 on none.
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
  kind: "propose",
  items: ["A6-r2"],
  fields: {},
  sync: "waiting",
  refused: null,
  created: (waitingRaw as DataSet).workspace.sync.at,
};

const waiting = asSet(waitingRaw);
const webWaiting = asSet(webWaitingRaw);

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
  "web-waiting": webWaiting,
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

// -- P61-e9: who writes, and the feedback on the agenda -----------------------------------------------------------

/**
 * The signed-in account as the server writes it on an entry (`person_author`): `person:<handle>`, the handle its
 * email's part before `@`. The design's account is the Shell's (`design@example.invalid`), so a note written in the
 * browser reads `design`; the recorded web notes are the local stack's test account's (`you`).
 */
export const ME = `person:${RECORDING.shell.email.split("@")[0]}`;

/** The recorded pieces of feedback, by sample id (`record.mjs --feedback`). */
export const FEEDBACK = RECORDING.feedback ?? {};

/**
 * The items a piece of feedback is on, as `GET /app/feedback/{id}/agenda` answers them (`feedback_items`): each
 * item whose thread holds an entry with `source: feedback:<id>`, in the Agenda's order. Read from the store's
 * workspace, so an add made in the browser shows; the recorded answers are checked against it below.
 */
export function feedbackItemsIn(
  agenda: readonly AgendaItem[],
  feedbackId: string,
): FeedbackAgendaItem[] {
  const source = `feedback:${feedbackId}`;
  return agenda
    .filter((a) => (a.entries ?? []).some((e) => e.source === source))
    .map((a) => ({
      id: a.id,
      title: a.title,
      lang: a.lang,
      state: a.state,
      sync: (a.sync ?? null) as FeedbackAgendaItem["sync"],
    }));
}

/** Each recorded answer, as the store's rows would give it: the recording's and `web-waiting`'s. */
function checkFeedback(set: DataSet & { feedback?: Recording["feedback"] }, name: string) {
  const rows = set.workspace.agenda.map((r) => ({ ...r, ...(set.items[r.id] ?? {}) }));
  for (const [id, { agenda }] of Object.entries(set.feedback ?? {})) {
    const derived = JSON.stringify(feedbackItemsIn(rows, id));
    if (derived !== JSON.stringify(agenda.items))
      throw new Error(`${name}: feedback ${id}'s recorded agenda is not what its entries say`);
  }
}
checkFeedback(RECORDING, "recording.json");
checkFeedback(webWaiting as DataSet & { feedback?: Recording["feedback"] }, "states/web-waiting.json");

/** Made from `web-waiting`'s answer: the note it holds waiting on A3-1z, put on any item for its Note waiting state. */
export const WAITING_NOTE: string =
  webWaiting.items["A3-1z"]?.entries?.find((e) => e.sync === "waiting")?.body ?? "";
