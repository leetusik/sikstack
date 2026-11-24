import type { ReactNode } from "react";

import { WS_ACTIONS, WS_GLOSSARY } from "@/content/workspace/frame";
import { Swap } from "@/sikstack/ui";
import { cx } from "@/lib/cx";
import { langOf } from "@/lib/workspace/model";

import {
  Fact,
  Facts,
  WaitingBadge,
  WsStatus,
  WsText,
} from "@/sikstack/workspace/frame";
import type { Busy } from "@/sikstack/workspace/agenda-item/state";

import { PROPOSED } from "../../content/agenda-thread";
import { Author, authorOf } from "../frame/author";
import type { HeadAction, ItemView } from "./model";

/**
 * The head's actions (`AgendaItemHead.dc.html`; frame.md F81, F303, F309), at the title row's end: **Every linked
 * phase is done.** before the buttons when it holds, then the buttons in their one order. Solve is the primary
 * button only while every linked phase is done. While a send runs every button is disabled and the busy one
 * (Defer, Reopen) shows its pending label at the same width. While a form is open the whole group is away
 * (`.agendaitem-away`): it keeps its width, so the title wraps as before, and has no height.
 *
 * The next version (P61-e9): a Proposed item's **Accept** ends the group, the page's primary, `Accepting…` while it
 * is sent (`accepting`); its marks read Proposed; its facts add **Proposed by**.
 */
export function HeadActions({
  actions,
  allDone = false,
  opened = false,
  busy = null,
  accepting = false,
  loading = false,
  on,
}: {
  actions: HeadAction[];
  allDone?: boolean;
  opened?: boolean;
  busy?: Busy | null;
  /** Accept is on its way. */
  accepting?: boolean;
  loading?: boolean;
  on?: Partial<Record<HeadAction, () => void>>;
}) {
  const off = loading || busy !== null || accepting;
  const press = (action: HeadAction) => () => {
    if (!off && !opened) on?.[action]?.();
  };
  const button = (action: HeadAction) => {
    const swap = action === "defer" || action === "reopen" || action === "accept";
    const sending =
      swap && (action === "accept" ? accepting : busy === action);
    const label =
      action === "edit"
        ? WS_ACTIONS.edit
        : action === "delete"
          ? WS_ACTIONS.delete[0]
          : action === "accept"
            ? PROPOSED.accept[0]
            : WS_ACTIONS[action][0];
    const pending =
      action === "accept"
        ? PROPOSED.accept[1]
        : action === "defer" || action === "reopen"
          ? WS_ACTIONS[action][1]
          : "";
    return (
      <button
        key={action}
        type="button"
        className={cx(
          "btn",
          ((action === "solve" && allDone) || action === "accept") &&
            !loading &&
            "btn-primary",
        )}
        disabled={swap ? off && !sending : off}
        data-busy={sending ? "true" : undefined}
        aria-busy={sending ? true : undefined}
        data-focus={action}
        onClick={press(action)}
      >
        {swap ? <Swap labels={[label, pending]} /> : label}
      </button>
    );
  };
  return (
    <div
      className={cx(
        "cluster to-end agendaitem-actions",
        opened && "agendaitem-away",
      )}
    >
      {allDone && !loading ? (
        <span>{WS_GLOSSARY.sentences.everyPhaseDone}</span>
      ) : null}
      <div className="cluster to-end">{actions.map(button)}</div>
    </div>
  );
}

/** The status and the waiting badge, one group on the title's baseline (`.agendaitem-marks`, agenda-item C03). */
export function HeadMarks({ view }: { view: ItemView }) {
  return (
    <div className="agendaitem-marks">
      {view.proposed ? (
        <span className={PROPOSED.cls}>{PROPOSED.word}</span>
      ) : (
        <WsStatus kind="item" value={view.status} />
      )}
      {view.waiting ? <WaitingBadge /> : null}
    </div>
  );
}

/**
 * The item's facts, 8 px under the title row (F44, F80): Outcome (solved) or Reason (dropped) when the line is not
 * empty, Note when there is one, each on its own line at the measure with its line breaks kept and every id whole;
 * then Created and Changed. A deferred item has no Outcome or Reason (F301).
 */
export function HeadFacts({
  view,
  created,
  changed,
  prose,
}: {
  view: ItemView;
  created: string;
  changed: string;
  /** The stored texts as the server drew them (their Markdown, `itemProse`), by text; plain text without one. */
  prose?: Readonly<Record<string, ReactNode>>;
}) {
  const labels = WS_GLOSSARY.labels.item;
  const by = view.proposed ? authorOf(view.proposed.by) : null;
  const text = (value: string) =>
    (prose && Object.hasOwn(prose, value) ? prose[value] : null) ?? (
      <WsText text={value} />
    );
  return (
    <Facts>
      {view.end ? (
        <Fact
          label={labels[view.end.label]}
          long
          className="agendaitem-long ws-prose"
          lang={langOf(view.end.text)}
        >
          {text(view.end.text)}
        </Fact>
      ) : null}
      {view.note ? (
        <Fact
          label={labels.note}
          long
          className="agendaitem-long ws-prose"
          lang={langOf(view.note)}
        >
          {text(view.note)}
        </Fact>
      ) : null}
      {by ? (
        <Fact label={PROPOSED.by}>
          <Author author={by} />
        </Fact>
      ) : null}
      <Fact label={labels.created}>{created}</Fact>
      <Fact label={labels.changed}>{changed}</Fact>
    </Facts>
  );
}

/** The facts while the page loads: the two dates as bars. */
export function HeadFactsLoading() {
  const labels = WS_GLOSSARY.labels.item;
  return (
    <Facts>
      <Fact label={labels.created}>
        <span className="skel" style={{ width: "3em" }} />
      </Fact>
      <Fact label={labels.changed}>
        <span className="skel" style={{ width: "3em" }} />
      </Fact>
    </Facts>
  );
}
