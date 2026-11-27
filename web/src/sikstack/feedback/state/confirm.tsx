"use client";

import { useId, useRef, type RefObject } from "react";

import { Dialog, DialogActions } from "@/sikstack/frame/dialog";
import { Swap } from "@/sikstack/ui";

import { CONFIRM_DELETE, CONFIRM_DROP } from "@/content/feedback-state";
import { REASON_MAX, type StateAsk } from "./model";

/**
 * The state confirm (P91-v3, applied from S3's signed design). Drop's and
 * Delete's confirm, for one piece of feedback or a selection, in the shared dialog (`@/sikstack/frame/dialog`), drawn
 * as the Agenda's `AgendaConfirm` is: the question naming what it acts on (`Drop “<message>”?`, `Delete 3 pieces of
 * feedback?`), one sentence, Drop's one optional **Reason** (Enter in it drops), **Cancel** and the act. Drop's act is
 * `.btn-primary` (Reopen brings it back); Delete's is `.btn-danger`, the one place the danger colour is spent. Focus
 * opens on Cancel; Escape does nothing while it is sent. `counted` is the item page's comments and files (the list
 * knows neither, and names them as a kind).
 */
export function StateConfirm({
  ask,
  counted,
  onReason,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  ask: StateAsk;
  counted?: { comments: number; files: number };
  onReason?: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const cancelRef: RefObject<HTMLButtonElement | null> = useRef(null);
  const reasonId = useId();
  const drop = ask.act === "drop";
  const w = drop ? CONFIRM_DROP : CONFIRM_DELETE;
  const one = ask.ids.length === 1;
  const text = drop
    ? one
      ? CONFIRM_DROP.text
      : CONFIRM_DROP.textMany
    : one
      ? counted
        ? CONFIRM_DELETE.textCounted(counted.comments, counted.files)
        : CONFIRM_DELETE.text
      : CONFIRM_DELETE.textMany;
  const cancel = () => {
    if (!ask.busy) onCancel();
  };
  return (
    <Dialog
      label={one ? w.title(ask.title) : w.titleMany(ask.ids.length)}
      onClose={cancel}
      initialFocus={cancelRef}
      returnFocus={returnFocus}
      locked={ask.busy}
    >
      <h2>
        {one ? (
          <>
            {w.before}
            <span lang={ask.lang}>{ask.title}</span>
            {w.after}
          </>
        ) : (
          w.titleMany(ask.ids.length)
        )}
      </h2>
      <p>{text}</p>
      {ask.notice !== null ? (
        <p className="notice notice-danger" role="alert">
          {ask.notice}
        </p>
      ) : null}
      {drop ? (
        <div className="field">
          <label className="label" htmlFor={reasonId}>
            {CONFIRM_DROP.reason}
          </label>
          <input
            className="input"
            id={reasonId}
            type="text"
            autoComplete="off"
            maxLength={REASON_MAX}
            value={ask.reason}
            disabled={ask.busy}
            onChange={(e) => onReason?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onConfirm();
              }
            }}
          />
        </div>
      ) : null}
      <DialogActions>
        <button
          type="button"
          className="btn"
          ref={cancelRef}
          disabled={ask.busy}
          onClick={cancel}
        >
          {w.cancel}
        </button>
        <button
          type="button"
          className={drop ? "btn btn-primary" : "btn btn-danger"}
          data-busy={ask.busy ? "true" : undefined}
          aria-busy={ask.busy ? true : undefined}
          onClick={() => {
            if (!ask.busy) onConfirm();
          }}
        >
          <Swap labels={[...w.yes]} />
        </button>
      </DialogActions>
    </Dialog>
  );
}
