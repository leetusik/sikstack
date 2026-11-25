"use client";

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AGENDA_ITEM } from "@/content/workspace/agenda-item";
import { PROPOSED } from "@/content/workspace/agenda-thread";
import { WS_ACTIONS, WS_CHANGE, WS_STATES } from "@/content/workspace/frame";
import { Dialog, DialogActions } from "@/sikstack/frame";
import { StateBlock, type StateModel } from "@/sikstack/states";
import { Button, Swap } from "@/sikstack/ui";
import {
  acceptAgendaItems,
  changeAgendaEntries,
  deleteAgendaItems,
  discardChange,
  dropAgendaItems,
  editAgendaItem,
  noteAgendaItem,
  proposeAgendaItems,
  reopenAgendaItems,
  retryChange,
  solveAgendaItems,
  splitAgenda,
} from "@/lib/workspace/actions";
import { agendaItemHref, type WorkspaceList } from "@/lib/workspace/address";
import { dates } from "@/lib/workspace/model";
import type { WriteAnswer } from "@/lib/workspace/types";

import {
  BackRow,
  ItemHead,
  NO_LINE,
  wsNotFoundState,
  WsText,
  type WsBack,
  type WsSyncLine,
} from "../frame";

import { AgendaItemForm } from "./form";
import { HeadActions, HeadFacts, HeadMarks } from "./head";
import { PhasesPanel } from "./lists";
import { retryLabel, type HeadAction, type ItemPageRead } from "./model";
import {
  afterSend,
  formSend,
  INITIAL,
  pageView,
  reduce,
  vanished,
  type Busy,
} from "./state";
import { Thread } from "./thread";
import { ITEM_KIND, threadView } from "./thread-model";

export type { ItemPageRead } from "./model";

/**
 * An agenda item's page (`AgendaItem.dc.html`; frame.md F35, F45, F81, F84, F303), in one column:
 *
 * 1. the back row: **Agenda** (the way back, at the page it was opened from) and the sync line;
 * 2. the head: the id and the title, the status and Waiting for sync as one group, the actions; the facts;
 * 3. the form slot (Edit, Solve or Drop, one at a time);
 * 4. a change the workspace refused: its line, then **Discard** and **Try again** at the notice's right end;
 * 5. **Items** (P61-e9's thread): every item oldest first with its state and Done, Dismiss, Reopen, Delete; the
 *    Split; then the note composer;
 * 6. **Phases**.
 *
 * On a Proposed item the head offers **Accept** (P61-e9, the head's primary): it becomes Open, first in the open
 * order, and waits for the sync; the read then says so (`accepting`), so a reload offers no second Accept.
 *
 * Every write is one inbox entry through the Workspace's actions; it is laid over the read until a read shows
 * it applied or refused, and the page reads again after each one. An item change is the read's to show: it
 * predicts the item's state and the agenda's (its last open item gone, the agenda reads Solved or Dropped), marked
 * Waiting for sync. A Split opens the new agenda (the id the route minted), which reads its items while the split
 * waits. After its own Delete the page says **Agenda deleted** and the Agenda opens. An item the read does not hold is Not found, under the back row. A change
 * that takes the item from under the page lands on a drawn state (`state.ts`): Try again on a refused add opens
 * the id it was re-sent under.
 */
export function AgendaItemPage({
  project,
  back,
  line,
  timeZone,
  now,
  read,
  prose,
  from = null,
}: {
  project: string;
  back: WsBack;
  /** The list page the item was opened from, kept when the page moves to another id. */
  from?: WorkspaceList | null;
  /** The sync line; null when no read could say it. */
  line: WsSyncLine | null;
  timeZone: string;
  now: number;
  read: ItemPageRead;
  /** The item's note, outcome and reason as the server drew them (`itemProse`); plain text without them. */
  prose?: Readonly<Record<string, ReactNode>>;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(reduce, INITIAL);
  /** The read an Accept was sent on: Accept stays busy until the next read, which reads the item Open. */
  const [acceptSent, setAcceptSent] = useState<object | null>(null);
  const [acceptFailed, setAcceptFailed] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const readItem = read.state === "ready" ? read.item : null;

  // a new read folds in: what it shows applied or refused leaves the overlay
  const synced = read.state === "ready" ? (read.synced ?? null) : null;
  useEffect(() => {
    if (readItem) dispatch({ type: "read", item: readItem, synced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readItem]);
  const accepting = acceptSent !== null && acceptSent === readItem;

  // a discarded add the next read no longer holds: Item deleted, and the Agenda opens
  const away = vanished(read, state);
  useEffect(() => {
    if (!away) return;
    dispatch({ type: "missing" });
    router.push(back.href);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [away]);

  // the page Try again opened for a re-sent add: Edit takes the focus there (F303), once
  useEffect(() => {
    if (!readItem || !arrived(readItem.id)) return;
    root.current?.querySelector<HTMLElement>('[data-focus="edit"]')?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the button (or field) the page asked for takes the focus, once
  const focusN = state.focus?.n;
  useEffect(() => {
    const on = state.focus?.on;
    if (on)
      root.current?.querySelector<HTMLElement>(`[data-focus="${on}"]`)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusN]);

  const fmt = dates(timeZone, now);

  const top = <TopRow back={back} line={line} />;

  const draw = pageView(read, state);
  if (draw.kind === "gone") {
    return (
      <div className="column">
        <header className="page-top">
          {top}
          <StateBlock state={deletedState(draw.title, back)} />
        </header>
      </div>
    );
  }
  if (draw.kind === "not-found") {
    return (
      <div className="column">
        <header className="page-top">
          {top}
          <StateBlock
            state={wsNotFoundState(
              "item",
              draw.projectName ?? AGENDA_ITEM.thisProject,
              back,
            )}
          />
        </header>
      </div>
    );
  }

  const view = draw.view;
  const item = view.item;
  const id = item.id;
  const busy = state.busy;

  async function sendHead(
    kind: Exclude<Busy, "form">,
    send: () => Promise<WriteAnswer>,
    extra: { refusedEntry?: string; title?: string } = {},
  ) {
    if (state.busy) return;
    dispatch({ type: "send", busy: kind });
    const answer = await send();
    dispatch({ type: "answer", answer, timeZone, ...extra });
    const step = afterSend(kind, answer, {
      project,
      shown: id,
      from,
      back: back.href,
    });
    if (step.go === "push") router.push(step.href);
    else if (step.go === "replace") {
      arriveAt(step.item);
      router.replace(step.href);
    } else router.refresh();
  }

  async function submitForm() {
    if (!state.form || state.busy) return;
    const out = formSend(state.form, state.draft, { note: item.note });
    dispatch({ type: "submit" });
    if (!out) return;
    const answer =
      out.kind === "edit"
        ? await editAgendaItem(project, id, {
            title: out.title,
            note: out.note,
          })
        : out.kind === "solve"
          ? await solveAgendaItems(project, [id], out.outcome)
          : await dropAgendaItems(project, [id], out.reason);
    dispatch({ type: "answer", answer, timeZone });
    if (answer.ok || answer.reason !== "title") router.refresh();
  }

  /** Accept (P61-e9): one `accept` entry; the page reads again and shows the item Open, waiting for the sync. */
  async function accept() {
    if (accepting || state.busy) return;
    setAcceptSent(readItem);
    setAcceptFailed(null);
    const answer = await acceptAgendaItems(project, [id]);
    // taken: Accept stays busy until the next read, which reads the item Open (`accepting`)
    if (!answer.ok) {
      setAcceptSent(null);
      setAcceptFailed(
        answer.reason === "refused" || answer.reason === "closed"
          ? answer.message
          : PROPOSED.failed,
      );
    }
    router.refresh();
  }

  const open = (form: "edit" | "solve" | "drop") => () =>
    dispatch({ type: "open", form, item });
  const on: Partial<Record<HeadAction, () => void>> = {
    edit: open("edit"),
    solve: open("solve"),
    drop: open("drop"),
    propose: () =>
      void sendHead("propose", () => proposeAgendaItems(project, [id])),
    reopen: () =>
      void sendHead("reopen", () => reopenAgendaItems(project, [id])),
    delete: () => dispatch({ type: "ask" }),
    accept: () => void accept(),
  };
  const title = item.title ?? id;
  const refused = view.refused;
  const deleting = busy === "delete";

  return (
    <div className="column" ref={root}>
      <ItemHead
        back={back}
        line={line ?? NO_LINE}
        id={id}
        name={title}
        lang={item.lang === "ko" ? "ko" : null}
        after={<HeadMarks view={view} />}
        headClass="agendaitem-row"
        actions={
          <HeadActions
            actions={view.actions}
            allDone={view.allDone}
            opened={state.form !== null}
            busy={busy}
            accepting={accepting}
            on={on}
          />
        }
      >
        <HeadFacts
          view={view}
          prose={prose}
          created={fmt.date(item.created)}
          changed={fmt.date(item.changed)}
        />
      </ItemHead>
      {state.form ? (
        <AgendaItemForm
          key={state.form}
          kind={state.form}
          phase={state.phase}
          notice={state.notice}
          failed={state.failed}
          draft={state.draft}
          onChange={(field, value) =>
            dispatch({ type: "change", field, value })
          }
          onSubmit={() => void submitForm()}
          onCancel={() => dispatch({ type: "cancel" })}
        />
      ) : null}
      {state.asking ? (
        <Dialog
          label={AGENDA_ITEM.confirm.title(title)}
          initialFocus={cancelRef as RefObject<HTMLElement | null>}
          locked={deleting}
          onClose={() => dispatch({ type: "ask-cancel" })}
        >
          <h2>{AGENDA_ITEM.confirm.title(title)}</h2>
          <p>{AGENDA_ITEM.confirm.text}</p>
          <DialogActions>
            <Button
              ref={cancelRef}
              disabled={deleting}
              onClick={() => dispatch({ type: "ask-cancel" })}
            >
              {WS_ACTIONS.cancel}
            </Button>
            <Button
              variant="danger"
              busy={deleting}
              busyLabel={AGENDA_ITEM.confirm.pending}
              onClick={() =>
                void sendHead(
                  "delete",
                  () => deleteAgendaItems(project, [id]),
                  {
                    title,
                  },
                )
              }
            >
              {AGENDA_ITEM.confirm.yes}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
      {refused ? (
        <div className="notice notice-danger stack gap-3" role="alert">
          <p>
            <WsText text={WS_CHANGE.refused(refused.said)} />
          </p>
          <div className="cluster to-end">
            <button
              type="button"
              className="btn"
              disabled={busy === "retry"}
              onClick={() =>
                void sendHead(
                  "discard",
                  () => discardChange(project, refused.entry),
                  { title },
                )
              }
            >
              {WS_CHANGE.discard}
            </button>
            <button
              type="button"
              className="btn"
              data-busy={busy === "retry" ? "true" : undefined}
              aria-busy={busy === "retry" ? true : undefined}
              onClick={() =>
                void sendHead(
                  "retry",
                  () => retryChange(project, refused.entry),
                  { refusedEntry: refused.entry, title },
                )
              }
            >
              <Swap
                labels={[
                  WS_CHANGE.retry,
                  retryLabel(state.kinds[refused.entry] ?? refused.kind),
                ]}
              />
            </button>
          </div>
        </div>
      ) : null}
      {acceptFailed ? (
        <p className="notice notice-danger" role="alert">
          {acceptFailed}
        </p>
      ) : null}
      <Thread
        entries={threadView(view.thread, {
          project,
          when: (value) => fmt.when(value),
        })}
        prose={prose}
        onAdd={async (body) => {
          const answer = await noteAgendaItem(project, id, body);
          router.refresh();
          return answer;
        }}
        onItem={async (action, entry) => {
          const answer = await changeAgendaEntries(
            project,
            ITEM_KIND[action],
            id,
            [entry.file as string],
          );
          if (answer.ok) dispatch({ type: "written", entry: answer.entry, timeZone });
          router.refresh();
          return answer;
        }}
        onSplit={async (files, splitTitle) => {
          const answer = await splitAgenda(project, id, files, splitTitle);
          const minted = answer.ok
            ? (answer.item ?? answer.entry.minted_id)
            : null;
          if (minted) router.push(agendaItemHref(project, minted, from));
          else router.refresh();
          return answer;
        }}
      />
      <PhasesPanel project={project} view={view} />
    </div>
  );
}

/**
 * Where the id Try again re-sent a refused add under is kept while the page goes there: the new address mounts
 * the page anew, so the focus F303 gives Edit after Try again is handed over (this tab only, once).
 */
const ARRIVING = "sikstack.workspace.agenda-item.arriving";

function arriveAt(item: string) {
  try {
    sessionStorage.setItem(ARRIVING, item);
  } catch {
    // no storage (a private window may refuse it): the page opens without moving the focus
  }
}

/** Whether Try again opened this item's page; it is told once. */
function arrived(item: string): boolean {
  try {
    if (sessionStorage.getItem(ARRIVING) !== item) return false;
    sessionStorage.removeItem(ARRIVING);
    return true;
  } catch {
    return false;
  }
}

function TopRow({ back, line }: { back: WsBack; line: WsSyncLine | null }) {
  if (line) return <BackRow {...back} line={line} />;
  return (
    <div className="ws-top">
      <Link className="back" href={back.href}>
        {back.label}
      </Link>
    </div>
  );
}

/** After the page's own Delete (F303): Item deleted, its sentence, **Back to Agenda**. */
export function deletedState(title: string, back: WsBack): StateModel {
  return {
    title: AGENDA_ITEM.deleted.title,
    text: AGENDA_ITEM.deleted.text(title),
    actions: [
      {
        kind: "link",
        label: WS_STATES.back(back.label),
        href: back.href,
        variant: "default",
      },
    ],
    reference: null,
  };
}
