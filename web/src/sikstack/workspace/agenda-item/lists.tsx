import { AGENDA_ITEM } from "@/content/workspace/agenda-item";
import { WS_GLOSSARY } from "@/content/workspace/frame";
import { Copy } from "@/sikstack/frame";
import { phaseHref } from "@/lib/workspace/address";

import { Steps, stepsN, WsList, WsRow, wsStatus } from "../frame";

import type { ItemView } from "./model";

/**
 * The item's Phases panel (`AgendaItem.dc.html`; frame.md F39, F43, F45, FG5): its count, then one Workspace row a
 * linked phase in the backlog's order (id, the name as the row's link with the current slice under it while the
 * phase is not done, the status, `done/total` and the steps, every row's steps one width). With no phase and the
 * item not ended: the sentence and `/sikstack:create-phase <item id>` in the Copy field, no count. Ended with no phase:
 * nothing (the page leaves the panel out).
 */
export function PhasesPanel({
  project,
  view,
}: {
  project: string;
  view: ItemView;
}) {
  if (view.phasesPanel === null) return null;
  const rows = view.phasesPanel === "rows";
  return (
    <section className="panel" aria-labelledby="agendaitem-phases">
      <div className="panel-head">
        <h2 id="agendaitem-phases">{WS_GLOSSARY.heads.phases}</h2>
        {rows ? (
          <p className="meta">{AGENDA_ITEM.phaseCount(view.phases.length)}</p>
        ) : null}
      </div>
      {rows ? (
        <WsList longest={stepsN(view.phases.map((p) => p.total))}>
          {view.phases.map((p) => (
            <WsRow
              key={p.id}
              id={p.id}
              name={p.name}
              lang={p.lang === "ko" ? "ko" : null}
              href={phaseHref(project, p.id)}
              sub={p.current && p.status !== "done" ? p.current : null}
              subLang={p.currentLang === "ko" ? "ko" : null}
              status={wsStatus("phase", p.status)}
              end={
                <Steps
                  className="ws-end"
                  done={p.done}
                  total={p.total}
                  live={p.status === "in_progress" && p.done < p.total}
                />
              }
            />
          ))}
        </WsList>
      ) : (
        <div className="panel-body has-rule block">
          <p className="block-text">{WS_GLOSSARY.sentences.noPhase}</p>
          <div className="command">
            <Copy
              text={AGENDA_ITEM.command(view.item.id)}
              label={AGENDA_ITEM.copyCommand}
              mono
            />
          </div>
        </div>
      )}
    </section>
  );
}

const WAIT_ROWS = ["14em", "18em", "11em"] as const;
const WAIT_STATES = ["6em", "5em", "6em"] as const;

/** The Phases panel while the page loads: three skeleton rows of a real row's height (`.agendaitem-wait`). */
export function PhasesLoading() {
  return (
    <section
      className="panel"
      aria-labelledby="agendaitem-phases-wait"
      aria-busy="true"
    >
      <div className="panel-head">
        <h2 id="agendaitem-phases-wait">{WS_GLOSSARY.heads.phases}</h2>
      </div>
      <ul className="ws-list">
        {WAIT_ROWS.map((width, i) => (
          <li key={i} className="row ws-row">
            <span className="ws-id">
              <span className="skel" style={{ width: "4em" }} />
            </span>
            <span className="ws-name agendaitem-wait">
              <span className="skel" style={{ width }} />
            </span>
            <span className="ws-state">
              <span className="skel" style={{ width: WAIT_STATES[i] }} />
            </span>
            <span className="ws-end">
              <span className="skel" style={{ width: "10em" }} />
            </span>
          </li>
        ))}
      </ul>
      <span className="sr-only">{AGENDA_ITEM.loading}</span>
    </section>
  );
}
