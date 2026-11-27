"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { actFailed } from "../../content/feedback-state";
import { StateConfirm } from "./confirm";
import { StateActs, StateLine } from "./line";
import {
  actAsks,
  actsFor,
  shortTitle,
  type FeedbackAct,
  type FeedbackStateRecord,
  type OrgRole,
  type StateAsk,
} from "./model";

/**
 * The next version's new island (P91-v3.S3's design): `src/sikstack/feedback/state/control.tsx` when applied. One
 * piece of feedback's state on its page, as `AgendaScope` is its add: `StateScope` holds the state and the open
 * confirm, `ItemStateLine` draws the line under the title, `ItemStateActs` the actions at the head's end with the
 * confirm. `send` is the page's write (`POST /app/feedback/state`, or `POST /app/feedback/delete`, which answers no
 * state: the page then leaves for the list). Resolve and Reopen act at once and show their busy word in place; Drop
 * and Delete ask first. A failed send is said in the confirm, or for an act at once in the toast `onFailed` shows.
 */
export type StateSend = (
  act: FeedbackAct,
  reason: string | undefined,
  /** The state on screen when it was sent. */
  from: FeedbackStateRecord,
) => Promise<FeedbackStateRecord | "deleted">;

interface StateValue {
  state: FeedbackStateRecord;
  role: OrgRole;
  busy: FeedbackAct | null;
  ask: StateAsk | null;
  counted?: { comments: number; files: number };
  format?: { timeZone?: string; now?: number };
  onAct: (act: FeedbackAct) => void;
  onReason: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}

const StateContext = createContext<StateValue | null>(null);

function useStateScope(): StateValue {
  const value = useContext(StateContext);
  if (!value) throw new Error("ItemStateLine and ItemStateActs need a StateScope");
  return value;
}

export function StateScope({
  id,
  message,
  lang,
  initial,
  role,
  counted,
  format,
  send,
  onDeleted,
  onFailed,
  ask: initialAsk = null,
  busy: initialBusy = null,
  children,
}: {
  id: string;
  message: string;
  lang?: string;
  initial: FeedbackStateRecord;
  role: OrgRole;
  counted?: { comments: number; files: number };
  format?: { timeZone?: string; now?: number };
  send: StateSend;
  onDeleted: () => void;
  onFailed: (text: string) => void;
  /** The confirm open on arrival (the design's states). */
  ask?: Pick<StateAsk, "act" | "reason" | "busy" | "notice"> | null;
  busy?: FeedbackAct | null;
  children: ReactNode;
}) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<FeedbackAct | null>(initialBusy);
  const asking = (act: "drop" | "delete"): StateAsk => ({
    act,
    ids: [id],
    title: shortTitle(message),
    lang,
    reason: "",
    busy: false,
    notice: null,
  });
  const [ask, setAsk] = useState<StateAsk | null>(
    initialAsk ? { ...asking(initialAsk.act), ...initialAsk } : null,
  );

  const run = async (act: FeedbackAct, reason?: string) => {
    try {
      const answer = await send(act, reason, state);
      if (answer === "deleted") {
        onDeleted();
        return true;
      }
      setState(answer);
      return true;
    } catch {
      return false;
    }
  };

  const value: StateValue = {
    state,
    role,
    busy,
    ask,
    counted,
    format,
    onAct: (act) => {
      if (actAsks(act)) {
        setAsk(asking(act));
        return;
      }
      setBusy(act);
      void run(act).then((ok) => {
        setBusy(null);
        if (!ok) onFailed(actFailed(act, 1));
      });
    },
    onReason: (reason) => setAsk((a) => (a ? { ...a, reason } : a)),
    onCancel: () => setAsk(null),
    onConfirm: () => {
      if (!ask || ask.busy) return;
      const sent = ask;
      setAsk({ ...sent, busy: true, notice: null });
      void run(sent.act, sent.act === "drop" ? sent.reason : undefined).then((ok) =>
        setAsk(ok ? null : { ...sent, busy: false, notice: actFailed(sent.act, 1) }),
      );
    },
  };
  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

/** The state line, under the title's line. */
export function ItemStateLine() {
  const { state, format } = useStateScope();
  return <StateLine state={state} format={format} />;
}

/** The state's actions and their confirm. */
export function ItemStateActs() {
  const { state, role, busy, ask, counted, onAct, onReason, onCancel, onConfirm } = useStateScope();
  return (
    <>
      <StateActs acts={actsFor(state.state, role)} busy={busy} onAct={onAct} />
      {ask ? (
        <StateConfirm
          ask={ask}
          counted={counted}
          onReason={onReason}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      ) : null}
    </>
  );
}
