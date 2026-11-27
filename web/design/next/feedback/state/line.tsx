import { Badge, Button } from "@/sikstack/ui";
import { when } from "@/lib/feedback/format";
import { langAttr } from "@/lib/feedback/lang";

import { ACT_WORD, STATE_WORD, type FeedbackAct } from "../../content/feedback-state";
import { byName, type FeedbackStateRecord } from "./model";

/**
 * The next version's new parts (P91-v3.S3's design): `src/sikstack/feedback/state/line.tsx` when applied.
 *
 * - `StateLine`: one piece of feedback's state, under its title's line: the state's word in a badge (the state is
 *   always its word, never a colour), then what that state holds (the agenda item a filed or resolved piece is on, a
 *   dropped piece's reason, in ink), then who changed it and when, dim. Open with no stored row is its word alone.
 * - `StateActs`: the actions on it, in the one order (Delete, Drop, Resolve; or Delete, Reopen), each a default
 *   button that shows its busy word in place while it is sent. The head's one primary stays Add to agenda.
 */
export function StateLine({
  state,
  format,
}: {
  state: FeedbackStateRecord;
  format?: { timeZone?: string; now?: number };
}) {
  const by = byName(state.by);
  const hold = state.state === "dropped" ? state.reason : state.state === "open" ? null : state.agenda;
  return (
    <p className="cluster baseline gap-3 fi-state">
      <Badge>{STATE_WORD[state.state]}</Badge>
      {hold ? (
        <span className={state.state === "dropped" ? "fi-state-reason" : "ws-id"} lang={langAttr(hold)}>
          {hold}
        </span>
      ) : null}
      {state.state !== "open" && (by || state.at) ? (
        <span className="dim">
          {by}
          {by && state.at ? " · " : null}
          {state.at ? <time dateTime={state.at}>{when(state.at, format)}</time> : null}
        </span>
      ) : null}
    </p>
  );
}

export function StateActs({
  acts,
  busy = null,
  onAct,
}: {
  acts: readonly FeedbackAct[];
  /** The act on its way (Resolve or Reopen, which act at once). */
  busy?: FeedbackAct | null;
  onAct?: (act: FeedbackAct) => void;
}) {
  return (
    <div className="cluster fi-acts">
      {acts.map((act) => (
        <Button
          key={act}
          busy={busy === act}
          busyLabel={ACT_WORD[act][1]}
          disabled={busy !== null && busy !== act}
          onClick={() => {
            if (busy === null) onAct?.(act);
          }}
        >
          {ACT_WORD[act][0]}
        </Button>
      ))}
    </div>
  );
}
