"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";

import { Swap } from "@/sikstack/ui";
import { RefusedBadge, WaitingBadge, WsText } from "@/sikstack/workspace/frame";
import { langOf } from "@/lib/workspace/model";
import type { WriteAnswer } from "@/lib/workspace/types";

import { THREAD } from "../../content/agenda-thread";
import { Author } from "../frame/author";
import { noteBody, type EntryView } from "./thread-model";

/**
 * An item's thread (P61-e9), a panel under the item's head, before Phases: **Thread** and its count, then each entry
 * oldest first, one row each: the author (an agent marked `Agent`), the kind and the source on one baseline with
 * the time at the row's end, the body under it at the measure (its Markdown as the server drew it, `prose`). A web
 * entry the workspace has not taken reads `Waiting for sync`; one it refused, `Change refused` and its line. The
 * panel ends with the note composer: **Note** and **Add note** (`Adding…` while it is sent); the note shows in the
 * thread at once, under its author, waiting for the sync. New in this design: applying it adds this file to
 * `src/sikstack/workspace/agenda-item/`, its sheet to `src/sikstack/styles/workspace/agenda-item.css`.
 */
export function Thread({
  entries,
  prose,
  onAdd,
}: {
  entries: EntryView[];
  /** Each body as the server drew it (`itemProse`), by its text; plain text without one. */
  prose?: Readonly<Record<string, ReactNode>>;
  /** Sends a note (`noteAgendaItem`); the page reads again after it. */
  onAdd: (body: string) => Promise<WriteAnswer>;
}) {
  const uid = useId();
  const ids = { head: `${uid}-head`, note: `${uid}-note`, error: `${uid}-error` };
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"rest" | "sending" | "empty" | "failed">("rest");
  const [notice, setNotice] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const sending = phase === "sending";

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
    setNotice(
      answer.reason === "refused" || answer.reason === "closed"
        ? answer.message
        : THREAD.composer.failed,
    );
  }

  const body = (text: string) =>
    (prose && Object.hasOwn(prose, text) ? prose[text] : null) ?? <WsText text={text} />;

  return (
    <section className="panel" aria-labelledby={ids.head}>
      <div className="panel-head thread-head">
        <h2 id={ids.head}>{THREAD.head}</h2>
        <p className="meta thread-count">{THREAD.count(entries.length)}</p>
      </div>
      {entries.length > 0 ? (
        <ol className="thread">
          {entries.map((e) => (
            <li key={e.id} className="row thread-entry">
              <p className="thread-by">
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
                  <time className="meta thread-when" dateTime={e.iso ?? undefined}>
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
            </li>
          ))}
        </ol>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{THREAD.empty}</p>
        </div>
      )}
      <div className="panel-body has-rule">
      <form
        className="stack gap-3 thread-compose"
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
