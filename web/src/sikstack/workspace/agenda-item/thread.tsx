"use client";

import Link from "next/link";
import {
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { ITEM, SPLIT, THREAD } from "@/content/workspace/agenda-thread";
import { Dialog, DialogActions } from "@/sikstack/frame/dialog";
import { Swap } from "@/sikstack/ui";
import { langOf } from "@/lib/workspace/model";
import type { WriteAnswer } from "@/lib/workspace/types";

import { Author, RefusedBadge, WaitingBadge, WsText } from "../frame";

import {
  ITEM_KIND,
  noteBody,
  openCount,
  splitError,
  type EntryView,
  type ItemAction,
} from "./thread-model";

const ACTION_WORDS: Record<ItemAction, readonly [string, string]> = {
  done: ITEM.done,
  dismiss: ITEM.dismiss,
  reopen: ITEM.reopen,
  delete: ITEM.delete,
};

/** Why a send was not taken, as a line: the route's own, or the fallback. */
function notTaken(answer: WriteAnswer, fallback: string): string {
  if (answer.ok) return "";
  return (answer.reason === "refused" ||
    answer.reason === "closed" ||
    answer.reason === "title") &&
    answer.message
    ? answer.message
    : fallback;
}

/**
 * An agenda's items (the Thread panel of P61-e9, now **Items**), a panel under the agenda's head, before Phases:
 * **Items** and its count (`3 items, 1 open`), **Split** at the head's end; then each item oldest first, one row
 * each: its state (Open, Done, Dismissed; Deleted while its delete waits) and who set it, its ref, the author (an
 * agent marked `Agent`), the kind and the source on one baseline with the time at the row's end, the body under it
 * at the measure (its Markdown as the server drew it, `prose`), then its actions: **Done, Dismiss, Delete** on an
 * open item, **Reopen, Delete** on a done or dismissed one (Delete asks first). Each is one inbox entry; the page
 * reads again after it, and the read shows the state the engine will give (the agenda closing itself when its last
 * open item goes), `Waiting for sync` until the sync. A change the workspace refused reads `Change refused` and its
 * line.
 *
 * **Split** opens its form in place under the head: a box on each item that can move, **Title**, then **Cancel**
 * and **Split** (`Splitting…`); the page then opens the new agenda. The panel ends with the note composer: **Note**
 * and **Add note** (`Adding…` while it is sent). Its rules are `workspace/agenda-item.css`'s; no new look.
 */
export function Thread({
  entries,
  prose,
  onAdd,
  onItem,
  onSplit,
}: {
  entries: EntryView[];
  /** Each body as the server drew it (`itemProse`), by its text; plain text without one. */
  prose?: Readonly<Record<string, ReactNode>>;
  /** Sends a note (`noteAgendaItem`); the page reads again after it. */
  onAdd: (body: string) => Promise<WriteAnswer>;
  /** Sends one item change; the page reads again after it. */
  onItem?: (action: ItemAction, item: EntryView) => Promise<WriteAnswer>;
  /** Sends the Split; on its answer the page opens the new agenda. */
  onSplit?: (files: string[], title: string) => Promise<WriteAnswer>;
}) {
  const uid = useId();
  const ids = {
    head: `${uid}-head`,
    note: `${uid}-note`,
    error: `${uid}-error`,
    title: `${uid}-title`,
    titleError: `${uid}-title-error`,
  };
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"rest" | "sending" | "empty" | "failed">(
    "rest",
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const sending = phase === "sending";

  // an item's change on its way, one at a time; a change not taken says why over the items
  const [busy, setBusy] = useState<{ file: string; action: ItemAction } | null>(
    null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const [asking, setAsking] = useState<EntryView | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // the Split's form
  const [splitting, setSplitting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [splitPhase, setSplitPhase] = useState<"rest" | "sending">("rest");
  const [splitWrong, setSplitWrong] = useState<{
    field: "items" | "title" | "send";
    message: string;
  } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const movable = entries.filter((e) => e.file && !e.deleting);
  const files = movable.map((e) => e.file as string);
  const canSplit = onSplit !== undefined && movable.length > 1;

  async function submit() {
    if (sending) return;
    const body = noteBody(draft);
    if (body === null) {
      setPhase("empty");
      field.current?.focus();
      return;
    }
    setPhase("sending");
    setNotice(null);
    const answer = await onAdd(body);
    if (answer.ok) {
      setDraft("");
      setPhase("rest");
      setSaid(THREAD.said);
      return;
    }
    setPhase("failed");
    setNotice(notTaken(answer, THREAD.composer.failed));
  }

  async function act(action: ItemAction, item: EntryView) {
    if (busy || !onItem || !item.ref) return;
    setBusy({ file: item.file as string, action });
    setFailed(null);
    const answer = await onItem(action, item);
    setBusy(null);
    setAsking(null);
    if (answer.ok) {
      setSaid(ITEM.said[ITEM_KIND[action]](item.ref));
      return;
    }
    setFailed(notTaken(answer, ITEM.failed));
  }

  function openSplit() {
    setSplitting(true);
    setPicked([]);
    setTitle("");
    setSplitWrong(null);
    setTimeout(() => titleRef.current?.focus(), 0);
  }

  async function split() {
    if (!onSplit || splitPhase === "sending") return;
    const wrong = splitError(picked, files, title);
    if (wrong) {
      setSplitWrong(wrong);
      if (wrong.field === "title") titleRef.current?.focus();
      return;
    }
    setSplitPhase("sending");
    setSplitWrong(null);
    const chosen = files.filter((f) => picked.includes(f));
    const answer = await onSplit(chosen, title);
    setSplitPhase("rest");
    if (answer.ok) {
      setSplitting(false);
      return;
    }
    setSplitWrong(
      answer.reason === "title"
        ? { field: "title", message: answer.message }
        : { field: "send", message: notTaken(answer, SPLIT.failed) },
    );
  }

  const body = (text: string) =>
    (prose && Object.hasOwn(prose, text) ? prose[text] : null) ?? (
      <WsText text={text} />
    );
  const open = openCount(entries);
  // an item whose delete waits leaves the count, as it leaves the read's
  const held = entries.filter((e) => !e.deleting).length;

  return (
    <section className="panel" aria-labelledby={ids.head}>
      <div className="panel-head thread-head">
        <h2 id={ids.head}>{THREAD.head}</h2>
        <p className="meta thread-count">
          {splitting
            ? SPLIT.count(picked.filter((f) => files.includes(f)).length, files.length)
            : open > 0
              ? THREAD.countOpen(held, open)
              : THREAD.count(held)}
        </p>
        {canSplit && !splitting ? (
          <div className="top-end">
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={openSplit}
            >
              {SPLIT.open}
            </button>
          </div>
        ) : null}
      </div>
      {splitting ? (
        <form
          className="panel-body has-rule"
          aria-label={SPLIT.name}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void split();
          }}
        >
          <div className="stack agenda-form thread-compose">
            {splitWrong && splitWrong.field !== "title" ? (
              <p className="notice notice-danger" role="alert">
                {splitWrong.message}
              </p>
            ) : null}
            <p className="meta">{SPLIT.hint}</p>
            <div className="field">
              <label className="label" htmlFor={ids.title}>
                {SPLIT.title}
              </label>
              <input
                ref={titleRef}
                className="input"
                id={ids.title}
                type="text"
                autoComplete="off"
                placeholder={SPLIT.titlePlaceholder}
                lang={langOf(title)}
                value={title}
                disabled={splitPhase === "sending"}
                aria-invalid={splitWrong?.field === "title" ? true : undefined}
                aria-describedby={
                  splitWrong?.field === "title" ? ids.titleError : undefined
                }
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (splitWrong?.field === "title") setSplitWrong(null);
                }}
              />
              {splitWrong?.field === "title" ? (
                <p className="field-error" id={ids.titleError}>
                  {splitWrong.message}
                </p>
              ) : null}
            </div>
            <div className="cluster to-end">
              <button
                type="button"
                className="btn"
                disabled={splitPhase === "sending"}
                onClick={() => setSplitting(false)}
              >
                {SPLIT.cancel}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                data-busy={splitPhase === "sending" ? "true" : undefined}
                aria-busy={splitPhase === "sending" ? true : undefined}
              >
                <Swap labels={[...SPLIT.submit]} />
              </button>
            </div>
          </div>
        </form>
      ) : null}
      {failed ? (
        <div className="panel-body has-rule">
          <p className="notice notice-danger" role="alert">
            {failed}
          </p>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <ol className="thread">
          {entries.map((e) => (
            <li key={e.id} className="row thread-entry" data-ref={e.ref ?? undefined}>
              <p className="thread-by">
                {splitting && e.file && !e.deleting ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={picked.includes(e.file)}
                      disabled={splitPhase === "sending"}
                      onChange={() => {
                        const f = e.file as string;
                        setPicked((p) =>
                          p.includes(f) ? p.filter((x) => x !== f) : [...p, f],
                        );
                        if (splitWrong?.field === "items") setSplitWrong(null);
                      }}
                    />
                    <span className="sr-only">{ITEM.pick(e.ref ?? e.id)}</span>
                  </label>
                ) : null}
                <span className={e.status.cls}>{e.status.word}</span>
                {e.stateBy ? (
                  <span className="dim">
                    {ITEM.stateBy} <Author author={e.stateBy} />
                  </span>
                ) : null}
                {e.ref ? <span className="ws-id">{e.ref}</span> : null}
                {e.author ? <Author author={e.author} /> : null}
                <span className="dim thread-what">
                  {e.source?.href ? (
                    // a source with a page (a piece of feedback): the kind is the link to it
                    <Link className="link" href={e.source.href}>
                      {e.kind}
                    </Link>
                  ) : (
                    <>
                      {e.kind}
                      {e.source ? (
                        <>
                          {" · "}
                          <WsText text={e.source.text} />
                        </>
                      ) : null}
                    </>
                  )}
                </span>
                {e.mark === "waiting" ? <WaitingBadge /> : null}
                {e.mark === "refused" ? <RefusedBadge /> : null}
                {e.when ? (
                  <time
                    className="meta thread-when"
                    dateTime={e.iso ?? undefined}
                  >
                    {e.when}
                  </time>
                ) : null}
              </p>
              <div className="ws-prose thread-body" lang={langOf(e.body)}>
                {body(e.body)}
              </div>
              {e.refused ? (
                <p className="notice notice-danger thread-body">
                  <WsText text={e.refused} />
                </p>
              ) : null}
              {onItem && e.ref && e.actions.length > 0 && !splitting ? (
                <div className="cluster">
                  {e.actions.map((action) => {
                    const [label, pending] = ACTION_WORDS[action];
                    const on = busy?.file === e.file && busy.action === action;
                    return (
                      <button
                        key={action}
                        type="button"
                        className="btn btn-quiet"
                        aria-label={ITEM.label(label, e.ref as string)}
                        disabled={busy !== null && !on}
                        data-busy={on ? "true" : undefined}
                        aria-busy={on ? true : undefined}
                        onClick={() =>
                          action === "delete"
                            ? setAsking(e)
                            : void act(action, e)
                        }
                      >
                        <Swap labels={[label, pending]} />
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{THREAD.empty}</p>
        </div>
      )}
      {asking && asking.ref ? (
        <Dialog
          label={ITEM.confirm.title(asking.ref)}
          initialFocus={cancelRef as RefObject<HTMLElement | null>}
          locked={busy !== null}
          onClose={() => {
            if (busy === null) setAsking(null);
          }}
        >
          <h2>{ITEM.confirm.title(asking.ref)}</h2>
          <p>{ITEM.confirm.text}</p>
          <DialogActions>
            <button
              type="button"
              className="btn"
              ref={cancelRef}
              disabled={busy !== null}
              onClick={() => setAsking(null)}
            >
              {ITEM.confirm.cancel}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-busy={busy !== null ? "true" : undefined}
              aria-busy={busy !== null ? true : undefined}
              onClick={() => void act("delete", asking)}
            >
              <Swap labels={[...ITEM.confirm.yes]} />
            </button>
          </DialogActions>
        </Dialog>
      ) : null}
      <div className="panel-body has-rule">
        <form
          className="stack thread-compose gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {phase === "failed" && notice ? (
            <p className="notice notice-danger" role="alert">
              {notice}
            </p>
          ) : null}
          <div className="field">
            <label className="label" htmlFor={ids.note}>
              {THREAD.composer.label}
            </label>
            <textarea
              ref={field}
              className="input"
              id={ids.note}
              rows={3}
              lang={langOf(draft)}
              value={draft}
              disabled={sending}
              aria-invalid={phase === "empty" ? true : undefined}
              aria-describedby={phase === "empty" ? ids.error : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (phase === "empty") setPhase("rest");
              }}
            />
            {phase === "empty" ? (
              <p className="field-error" id={ids.error}>
                {THREAD.composer.empty}
              </p>
            ) : null}
          </div>
          <div className="cluster to-end">
            <button
              type="submit"
              className="btn"
              data-busy={sending ? "true" : undefined}
              aria-busy={sending ? true : undefined}
            >
              <Swap labels={[...THREAD.composer.add]} />
            </button>
          </div>
          <p className="sr-only" role="status">
            {said}
          </p>
        </form>
      </div>
    </section>
  );
}
