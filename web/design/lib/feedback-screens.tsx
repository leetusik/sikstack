"use client";

import { useCallback, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { feedbackItemView, zoneMetaOf } from "@/sikstack/feedback/item";
import { publishToast } from "@/sikstack/shell";
import {
  FeedbackItemErrorState,
  FeedbackItemLoadingState,
  FeedbackItemNotFoundState,
} from "@/sikstack/feedback/item/states";
import {
  AddedToAgenda,
  AgendaHeadEnd,
  AgendaPart,
  agendaPageState,
  AgendaScope,
  AgendaSlot,
  NEW_ITEM,
  pickable,
  type AddPhase,
  type AgendaPartItem,
  type AgendaPick,
} from "@/sikstack/feedback/agenda";
import { canAdd, itemTitle, notOfferedText, sent } from "@/lib/feedback/agenda";
import { zoneLabel } from "@/lib/feedback/format";
import { feedbackBackHref } from "@/lib/feedback/place";
import { agendaItemHref } from "@/lib/workspace/address";

import { actDone } from "@/content/feedback-state";
import { FeedbackItem } from "../next/feedback/item/item";
import { ItemStateActs, ItemStateLine, StateScope, type StateSend } from "@/sikstack/feedback/state/control";
import { changed, OPEN, type FeedbackAct, type FeedbackStateRecord, type OrgRole, type StateAsk } from "@/sikstack/feedback/state/model";
import { FEEDBACK, feedbackItemsIn } from "./answers";
import { MADE_STATES, MADE_COMMENT, MADE_FILE, ME_BY, RECORDED_STATES } from "./feedback-list-data";
import { FEEDBACK_FILED_STATES, FEEDBACK_STATES } from "./page-states";
import { NOW, PROJECT, TIME_ZONE } from "./recording";
import { Frame, SHELL, THROWN, useSnap } from "./screens";
import { StatePage } from "./states";
import { apply, current, dataOf, getSnapshot, load, reset } from "./store";

/**
 * One piece of feedback (`/projects/<id>/feedback/<feedbackId>`), production's `FeedbackItem` on a recorded
 * record (`GET /app/feedback/{id}`), with production's Agenda part and Add to agenda (P61-e9). The
 * items it is on are read from the store's workspace (`feedbackItemsIn`, the server's own rule), so an add made in
 * the browser shows here, on the Agenda and on the item's thread at once. Production's page body
 * (`src/sikstack/feedback/item/body.tsx`) is a server component: this screen fills the same two slots it fills.
 *
 * P91-v3.S3's design: the item is the next version (`next/feedback/item/item.tsx`) with its third slot, the state
 * line, and the state's actions before the add at the head's end, in one `StateScope` (production's
 * `src/sikstack/feedback/state/`, applied in P91-v3.S4). The
 * states are made (`feedback-list-data.ts`): the recording predates them.
 */

type FeedbackState = (typeof FEEDBACK_STATES.list)[number]["key"];
type FiledState = (typeof FEEDBACK_FILED_STATES.list)[number]["key"];

/** The project's name the record's project is (the recording's Shell names it). */
const PROJECT_NAME = SHELL.project.name;

/** A piece of feedback the recording files on an item has the filed page's states; one on none, the add's. */
const isFiled = (id: string) => (FEEDBACK[id]?.agenda.items.length ?? 0) > 0;

const withHref =
  (project: string) =>
  <T extends { id: string }>(i: T): T & { href: string } => ({
    ...i,
    href: agendaItemHref(project, i.id),
  });

/**
 * Add to agenda in the design: what `POST /app/feedback/{id}/agenda {item?}` writes, as the engine takes it (an
 * `add` and a `feedback` entry, or the entry alone, by the signed-in account, its source `feedback:<id>`), then the
 * items `GET …/agenda` answers. Each waits for the sync (the design never syncs).
 */
async function fileFeedback(id: string, pick: AgendaPick): Promise<AgendaPartItem[]> {
  const record = FEEDBACK[id]?.record;
  if (!record) throw new Error(`no recorded feedback ${id}`);
  const body = `${record.message}\n\n/feedback/${id}`;
  let item: string;
  if (pick.kind === "new") {
    const title = itemTitle(record.message);
    const added = apply({ kind: "add", items: [], fields: { title, note: "", waiting: true } });
    if (!added.ok || !added.entry.minted_id) throw new Error("add refused");
    item = added.entry.minted_id;
  } else item = pick.id;
  const entry = apply(
    { kind: "entry", items: [item], fields: { kind: "feedback", body } },
    `feedback:${id}`,
  );
  if (!entry.ok) throw new Error(entry.refused);
  const ws = current().workspace;
  return feedbackItemsIn(ws.agenda, id).map(withHref(ws.project));
}

const PHASE: Partial<Record<FeedbackState, AddPhase>> = {
  offered: "rest",
  "confirm-new": "confirm",
  "confirm-existing": "confirm",
  adding: "adding",
  failed: "failed",
};

const WAIT = 700;

/** The state's setup a design state names: the state on arrival, who is signed in, a confirm or a send open. */
function stateSetup(id: string, state: string) {
  const filed = isFiled(id);
  let initial: FeedbackStateRecord = RECORDED_STATES[id] ?? OPEN;
  if (state === "resolved") initial = MADE_STATES.resolved(filed ? (FEEDBACK[id]?.agenda.items[0]?.id ?? null) : null);
  if (state === "dropped") initial = MADE_STATES.dropped;
  const role: OrgRole = state === "member" ? "member" : "owner";
  const ask: Pick<StateAsk, "act" | "reason" | "busy" | "notice"> | null =
    state === "confirm-drop"
      ? { act: "drop", reason: "", busy: false, notice: null }
      : state === "confirm-delete"
        ? { act: "delete", reason: "", busy: false, notice: null }
        : null;
  const busy: FeedbackAct | null = state === "resolving" ? "resolve" : null;
  return { initial, role, ask, busy, counted: state === "confirm-delete" };
}

/** The design's write: what `POST /app/feedback/state` stores, or `/delete`'s answer, after a short wait. */
const designSend: StateSend = (act, reason, from) =>
  new Promise((resolve) =>
    setTimeout(() => {
      if (act === "delete") resolve("deleted");
      else resolve(changed(from, act, { by: ME_BY, at: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z"), reason }));
    }, WAIT),
  );

/** The head's end: the state's actions, then what the add put there. */
function HeadEnd({ children }: { children?: ReactNode }) {
  return (
    <div className="cluster fi-head-end">
      <ItemStateActs />
      {children}
    </div>
  );
}

export function FeedbackScreen({
  id,
  state,
  retry = () => {},
}: {
  id: string;
  state: FeedbackState | FiledState;
  retry?: () => void;
}) {
  const ws = useSnap().workspace;
  const router = useRouter();
  const set = stateSetup(id, state);
  // The counted Delete confirm names a made comment and file (the recorded pieces have none): the page shows them.
  const record = set.counted
    ? { ...FEEDBACK[id].record, comments: [MADE_COMMENT], attachments: [MADE_FILE] }
    : FEEDBACK[id].record;
  const view = feedbackItemView(record, {
    projectName: PROJECT_NAME,
    zone: zoneMetaOf(TIME_ZONE, (tz) => zoneLabel(tz, NOW)),
    format: { timeZone: TIME_ZONE, now: NOW },
  });
  const backHref = feedbackBackHref(PROJECT, null);
  const on = feedbackItemsIn(ws.agenda, id).map(withHref(ws.project));
  const scoped = (page: ReactNode) => (
    <Frame>
      <StateScope
        key={state}
        id={id}
        message={record.message}
        lang={view.lang}
        initial={set.initial}
        role={set.role}
        counted={{ comments: record.comments.length, files: record.attachments.length }}
        format={{ timeZone: TIME_ZONE, now: NOW }}
        send={designSend}
        ask={set.ask}
        busy={set.busy}
        onDeleted={() => {
          publishToast(actDone("delete", 1));
          router.push("/feedback/");
        }}
        onFailed={publishToast}
      >
        {page}
      </StateScope>
    </Frame>
  );
  const line = <ItemStateLine />;

  switch (state) {
    case "loading":
      return (
        <Frame>
          <FeedbackItemLoadingState />
        </Frame>
      );
    case "not-found":
      return (
        <Frame>
          <FeedbackItemNotFoundState />
        </Frame>
      );
    case "error":
      return (
        <Frame>
          <FeedbackItemErrorState error={THROWN} reset={retry} />
        </Frame>
      );
    case "no-workspace": {
      // Production's page (`body.tsx`) for a project with no workspace linked: the seam's read says `linked: false`
      // and no item, so the add is not offered and the part says why.
      const unlinked = { project: record.project_id ?? null, linked: false, items: [] };
      const none = agendaPageState(
        canAdd(record, PROJECT_NAME, unlinked),
        sent(record, unlinked),
      );
      return scoped(
        <FeedbackItem
          view={view}
          backHref={backHref}
          state={line}
          headEnd={<HeadEnd>{none.kind === "not-offered" || none.kind === "offered" ? null : <AddedToAgenda />}</HeadEnd>}
          agenda={none.kind === "offered" ? null : <AgendaPart state={none} />}
        />,
      );
    }
    case "no-project":
      return scoped(
        <FeedbackItem
          view={view}
          backHref={backHref}
          state={line}
          headEnd={<HeadEnd />}
          agenda={
            <AgendaPart
              state={{
                kind: "not-offered",
                reason: "no-project",
                text: notOfferedText({ offered: false, reason: "no-project" }),
              }}
            />
          }
        />,
      );
    case "filed":
    case "waiting":
      return filedPage();
    case "resolved":
    case "confirm-delete":
      // The filed page's own states draw its part as filed; the add's page draws them with the add.
      if (isFiled(id)) return filedPage();
  }

  function filedPage() {
    const filed = agendaPageState({ offered: true, project: PROJECT_NAME }, on);
    return scoped(
      <FeedbackItem
        view={view}
        backHref={backHref}
        state={line}
        headEnd={<HeadEnd>{filed.kind === "filed" || filed.kind === "waiting" ? <AddedToAgenda /> : null}</HeadEnd>}
        agenda={filed.kind === "filed" || filed.kind === "waiting" ? <AgendaPart state={filed} /> : null}
      />,
    );
  }
  const items = pickable(ws.agenda, on);
  const existing = items.find((i) => i.id === "A3-1z") ?? items[0];
  return scoped(
    <AgendaScope
      key={state}
      project={PROJECT_NAME}
      items={items}
      phase={PHASE[state as FeedbackState] ?? "rest"}
      pick={state === "confirm-existing" && existing ? { kind: "item", id: existing.id } : NEW_ITEM}
      add={(pick) => fileFeedback(id, pick)}
    >
      <FeedbackItem
        view={view}
        backHref={backHref}
        state={line}
        headEnd={
          <HeadEnd>
            <AgendaHeadEnd />
          </HeadEnd>
        }
        agenda={<AgendaSlot />}
      />
    </AgendaScope>,
  );
}

/** What the store's workspace says of this piece of feedback: on no item (offered), waiting, or filed. */
function feedbackImplied(id: string, agenda: Parameters<typeof feedbackItemsIn>[0]) {
  const items = feedbackItemsIn(agenda, id);
  if (items.length === 0) return "offered" as const;
  return items.some((i) => i.sync !== null) ? ("waiting" as const) : ("filed" as const);
}

/** A piece of feedback at its address, in the state `?state=` names. */
export function FeedbackRoute({ id }: { id: string }) {
  const snap = useSnap();
  const implied = feedbackImplied(id, snap.workspace.agenda);
  const filedPage = isFiled(id);
  const enter = useCallback(
    (key: FeedbackState | FiledState) => {
      const now = getSnapshot();
      const is = feedbackImplied(id, now.workspace.agenda);
      if (key === "waiting" && is !== "waiting") load("web-waiting");
      if ((key === "offered" || key === "filed") && (is !== key || dataOf(now) !== "recorded")) load("recorded");
    },
    [id],
  );
  if (filedPage)
    return (
      <StatePage
        states={FEEDBACK_FILED_STATES}
        implied={implied === "filed" ? "filed" : null}
        enter={enter}
        reset={reset}
      >
        {(state, pick) => <FeedbackScreen id={id} state={state} retry={() => pick("filed")} />}
      </StatePage>
    );
  return (
    <StatePage
      states={FEEDBACK_STATES}
      implied={implied === "filed" ? null : implied}
      enter={enter}
      reset={reset}
    >
      {(state, pick) => <FeedbackScreen id={id} state={state} retry={() => pick("offered")} />}
    </StatePage>
  );
}
