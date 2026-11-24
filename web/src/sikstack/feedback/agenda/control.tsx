"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ADD } from "@/content/feedback-agenda";
import { PICK } from "@/content/workspace/agenda-thread";
import { Dialog, DialogActions } from "@/sikstack/frame/dialog";
import { Button } from "@/sikstack/ui/button";
import { Notice } from "@/sikstack/ui/field";

import {
  answer,
  ask,
  cancel,
  focusBack,
  isLocked,
  isOpen,
  NEW_ITEM,
  send,
  type AddPhase,
  type AgendaPartItem,
  type AgendaPick,
  type PickItem,
} from "./model";
import { AddedToAgenda, AgendaPart } from "./part";

/**
 * Add to agenda (`FeedbackItemSend.dc.html`; `result.md` § The add to the agenda; frame.md F143, F341
 * to F344), the client island for a record whose add is offered. `AgendaScope` holds the add's phase
 * and the item it filed and wraps the whole item, so its two places read one state: `AgendaHeadEnd`
 * at the head's end (the button and its confirm, then `Added to agenda`) and `AgendaSlot` between
 * Comment and Details (the Agenda part, once added). The page mounts the scope only when `canAdd`
 * offers the add (its project's workspace is linked) and the record is on no item yet.
 *
 * The confirm is the frame's `Dialog` (`dialog.dlg`, `showModal()`): it opens on Cancel; Cancel and
 * Escape close it and return focus to the button; while the add is in flight Cancel is disabled,
 * Escape does nothing and the primary reads `Adding…` in a swap; a failure keeps it open with the
 * notice; a success closes it, the head reads `Added to agenda` and focus lands once on that status.
 *
 * P61-e9: the confirm is a choice, **Add it to**: **A new item** (checked first,
 * the signed add) or one of the agenda's items not ended (`pickable`), one radio each, id and title; the sentence
 * under it follows the choice. The add files the feedback where it was picked and answers every item it is on now.
 */
export interface AgendaScopeProps {
  /** The project's name: the confirm's title says it. */
  project: string;
  /** The add: files the record where it was picked (`POST /app/feedback/{id}/agenda {item?}`) and answers the
   * items it is on now (`GET …/agenda`). */
  add?: (pick: AgendaPick) => Promise<AgendaPartItem[]>;
  /** The items the confirm offers beside a new one (`pickable`). */
  items?: readonly PickItem[];
  /** The phase to start in (`rest` on a page; the tests and the harness drive every state with it). */
  phase?: AddPhase;
  /** The choice to start with (a new item by default). */
  pick?: AgendaPick;
  /** The items it is on already, with `phase="added"`. */
  filed?: AgendaPartItem[];
  children: ReactNode;
}

interface AgendaScopeValue {
  project: string;
  phase: AddPhase;
  filed: AgendaPartItem[];
  items: readonly PickItem[];
  pick: AgendaPick;
  onPick: (pick: AgendaPick) => void;
  onAsk: () => void;
  onCancel: () => void;
  onSend: () => void;
}

const AgendaContext = createContext<AgendaScopeValue | null>(null);

export function AgendaScope({
  project,
  add,
  items = [],
  phase: initialPhase = "rest",
  pick: initialPick = NEW_ITEM,
  filed: initialFiled = [],
  children,
}: AgendaScopeProps) {
  const [phase, setPhase] = useState<AddPhase>(initialPhase);
  const [filed, setFiled] = useState<AgendaPartItem[]>(initialFiled);
  const [pick, setPick] = useState<AgendaPick>(initialPick);
  /** An answer lands only on the add that started it, and never after the page is left. */
  const ticket = useRef(0);
  useEffect(
    () => () => {
      ticket.current += 1;
    },
    [],
  );

  async function run() {
    const mine = ++ticket.current;
    let on: AgendaPartItem[] | null = null;
    try {
      if (add) on = await add(pick);
    } catch {
      on = null;
    }
    if (mine !== ticket.current) return;
    if (on) setFiled(on);
    setPhase((current) => answer(current, on !== null));
  }

  const value: AgendaScopeValue = {
    project,
    phase,
    filed,
    items,
    pick,
    onPick: (next) => {
      if (!isLocked(phase)) setPick(next);
    },
    onAsk: () => setPhase(ask),
    onCancel: () => setPhase(cancel),
    onSend: () => {
      if (send(phase) === phase) return;
      setPhase(send(phase));
      void run();
    },
  };
  return (
    <AgendaContext.Provider value={value}>{children}</AgendaContext.Provider>
  );
}

function useAgendaScope(): AgendaScopeValue {
  const value = useContext(AgendaContext);
  if (!value)
    throw new Error("AgendaHeadEnd and AgendaSlot need an AgendaScope");
  return value;
}

/** The head's end: the button and its confirm, then `Added to agenda`. */
export function AgendaHeadEnd() {
  const { project, phase, items, pick, onPick, onAsk, onCancel, onSend } =
    useAgendaScope();
  const uid = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const title = ADD.title(project);
  const open = isOpen(phase);
  // the picked item stays in view in a long list when the confirm opens on it
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLInputElement>("input:checked")
      ?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const locked = isLocked(phase);

  if (phase === "added") return <AddedToAgenda statusRef={statusRef} />;
  return (
    <div className="fi-send">
      <Button ref={buttonRef} variant="primary" onClick={onAsk}>
        {ADD.action}
      </Button>
      {isOpen(phase) ? (
        <Dialog
          label={title}
          onClose={onCancel}
          initialFocus={cancelRef}
          returnFocus={() =>
            focusBack<HTMLElement>(statusRef.current, buttonRef.current)
          }
          locked={locked}
        >
          <h2>{title}</h2>
          {phase === "failed" ? (
            <Notice danger role="alert">
              {ADD.failed}
            </Notice>
          ) : null}
          <fieldset className="field fi-pick">
            <legend className="label">{PICK.legend}</legend>
            <div className="fi-pick-list" ref={listRef}>
              <label className="check fi-pick-option">
                <input
                  type="radio"
                  name={`${uid}-pick`}
                  checked={pick.kind === "new"}
                  disabled={locked}
                  onChange={() => onPick(NEW_ITEM)}
                />
                <span>{PICK.newItem}</span>
              </label>
              {items.map((item) => (
                <label key={item.id} className="check fi-pick-option">
                  <input
                    type="radio"
                    name={`${uid}-pick`}
                    checked={pick.kind === "item" && pick.id === item.id}
                    disabled={locked}
                    onChange={() => onPick({ kind: "item", id: item.id })}
                  />
                  <span className="fi-pick-item">
                    <span className="ws-id dim">{item.id}</span>
                    <span lang={item.lang}>{item.title}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p>
            {pick.kind === "new"
              ? PICK.text.newItem
              : PICK.text.existing(pick.id)}
          </p>
          <DialogActions>
            <Button ref={cancelRef} disabled={locked} onClick={onCancel}>
              {ADD.cancel}
            </Button>
            <Button
              variant="primary"
              busy={locked}
              busyLabel={ADD.adding}
              onClick={onSend}
            >
              {ADD.action}
            </Button>
          </DialogActions>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The Agenda part's place: the items once added; nothing before. */
export function AgendaSlot() {
  const { filed } = useAgendaScope();
  if (filed.length === 0) return null;
  return (
    <AgendaPart
      state={
        filed.some((i) => i.sync !== null)
          ? { kind: "waiting", items: filed }
          : { kind: "filed", items: filed }
      }
    />
  );
}
