"use client";

import { useState, type MouseEvent } from "react";

import { publishToast } from "@/sikstack/shell";
import { AT_REST } from "@/lib/feedback/place";

import { actDone, actFailed } from "@/content/feedback-state";
import { FeedbackListView } from "@/sikstack/feedback/list/view";
import { listRows, type ListPhase, type ListPlace } from "@/sikstack/feedback/list/model";
import {
  changed,
  shortTitle,
  toggleAll,
  toggleRow,
  type FeedbackAct,
  type FeedbackStateName,
  type OrgRole,
  type StateAsk,
} from "@/sikstack/feedback/state/model";
import { countsOf, LIST_RECORDS, ME_BY, type ListRecord } from "./feedback-list-data";
import { FEEDBACK_LIST_STATES } from "./page-states";
import { NOW, PROJECT, TIME_ZONE } from "./recording";
import { Frame, SHELL } from "./screens";
import { StatePage } from "./states";

/**
 * The Feedback list (`/feedback`, P91-v3.S3's design, applied in S4): production's `FeedbackListView` on made
 * data (`feedback-list-data.ts`), wired as production's island wires it (`src/sikstack/feedback/list/list.tsx`):
 * the state filter, the search and filters, picking rows and acting on them run in the browser. Resolve and Reopen
 * answer after a short wait; Drop and Delete after their confirm; the rows then leave the state on screen and a toast
 * says what was done (the API's `POST /app/feedback/state` and `/delete`, answered here).
 */

type ListState = (typeof FEEDBACK_LIST_STATES.list)[number]["key"];

const WAIT = 700;
const FORMAT = { timeZone: TIME_ZONE, now: NOW };
const PROJECTS = [{ id: PROJECT, name: SHELL.project.name }];

interface Setup {
  records: ListRecord[];
  place: ListPlace;
  role: OrgRole;
  phase: ListPhase;
  ticked: string[];
  busy: FeedbackAct | null;
  ask: Omit<StateAsk, "ids" | "title" | "lang"> | null;
}

const openIds = LIST_RECORDS.filter((r) => r.state.state === "open").map((r) => r.id);

function setup(key: ListState): Setup {
  const base: Setup = {
    records: LIST_RECORDS,
    place: { ...AT_REST, state: "open" },
    role: "owner",
    phase: "ready",
    ticked: [],
    busy: null,
    ask: null,
  };
  const at = (state: FeedbackStateName): Setup => ({ ...base, place: { ...base.place, state } });
  const several = { ...base, ticked: openIds.slice(0, 3) };
  switch (key) {
    case "open":
      return base;
    case "filed":
    case "resolved":
    case "dropped":
      return at(key);
    case "none":
      return { ...base, records: [] };
    case "state-empty":
      return { ...base, records: LIST_RECORDS.filter((r) => r.state.state !== "open") };
    case "no-match":
      return { ...base, place: { ...base.place, q: "Windows" } };
    case "one":
      return { ...base, ticked: openIds.slice(0, 1) };
    case "several":
      return several;
    case "resolving":
      return { ...several, busy: "resolve" };
    case "confirm-drop":
      return {
        ...several,
        ask: { act: "drop", reason: "Answered in the release notes", busy: false, notice: null },
      };
    case "confirm-delete":
      return { ...several, ask: { act: "delete", reason: "", busy: false, notice: null } };
    case "member":
      return { ...several, role: "member" };
    case "loading":
      return { ...base, phase: "loading" };
    case "failed":
      return { ...base, phase: "failed" };
  }
}

/** The records a place reads: its search, project and rating (the API's filters; the state is the caller's). */
function matching(records: readonly ListRecord[], place: ListPlace) {
  const q = place.q.trim().toLowerCase();
  return records.filter(
    (r) =>
      (!q || r.message.toLowerCase().includes(q)) &&
      (!place.project || r.project_id === place.project) &&
      (!place.rating || r.feedback_value === (place.rating === "liked" ? 1 : 2)),
  );
}

const own = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

function ListScreen({ start }: { start: Setup }) {
  const [records, setRecords] = useState(start.records);
  const [place, setPlace] = useState(start.place);
  const [ticked, setTicked] = useState<string[]>(start.ticked);
  const [busy, setBusy] = useState<FeedbackAct | null>(start.busy);
  const [ask, setAsk] = useState<StateAsk | null>(() => {
    if (!start.ask) return null;
    const first = records.find((r) => r.id === start.ticked[0]);
    return {
      ...start.ask,
      ids: start.ticked,
      title: shortTitle(first?.message ?? ""),
    };
  });

  const matched = matching(records, place);
  const inState = matched.filter((r) => r.state.state === place.state);
  const rows =
    start.phase === "ready"
      ? listRows(inState, { scope: null, place, projects: PROJECTS, ...FORMAT })
      : [];
  const counts = countsOf(matched);

  const go = (to: Partial<ListPlace>) => {
    setPlace((p) => ({ ...p, page: 1, ...to }));
    setTicked([]);
  };

  /** What the API answers: the ids' new state, or gone. */
  const apply = (act: FeedbackAct, ids: readonly string[], reason?: string) => {
    const on = new Set(ids);
    const at = new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z");
    setRecords((rs) =>
      act === "delete"
        ? rs.filter((r) => !on.has(r.id))
        : rs.map((r) =>
            on.has(r.id) ? { ...r, state: changed(r.state, act, { by: ME_BY, at, reason }) } : r,
          ),
    );
    setTicked([]);
    publishToast(actDone(act, ids.length));
  };

  return (
    <FeedbackListView
      scope={null}
      place={place}
      projects={PROJECTS}
      rows={rows}
      total={inState.length}
      counts={counts}
      role={start.role}
      phase={start.phase}
      ticked={ticked}
      busy={busy}
      ask={ask}
      onSearch={(q) => go({ q: q.trim() })}
      onProject={(project, q) => go({ project, q: q.trim() })}
      onRating={(rating, q) => go({ rating, q: q.trim() })}
      onState={(state, event) => {
        if (own(event)) return;
        event.preventDefault();
        go({ state });
      }}
      onClear={(event) => {
        if (own(event)) return;
        event.preventDefault();
        go({ q: "", project: null, rating: null });
      }}
      onPage={(n, event) => {
        if (own(event)) return;
        event.preventDefault();
        go({ page: n });
      }}
      onTick={(id) => setTicked((t) => toggleRow(t, id))}
      onTickAll={(pick) => setTicked(toggleAll(pick))}
      onClearPicks={() => setTicked([])}
      onAct={(act, ids) => {
        if (act === "drop" || act === "delete") {
          const first = records.find((r) => r.id === ids[0]);
          setAsk({
            act,
            ids,
            title: shortTitle(first?.message ?? ""),
            reason: "",
            busy: false,
            notice: null,
          });
          return;
        }
        setBusy(act);
        setTimeout(() => {
          setBusy(null);
          apply(act, ids);
        }, WAIT);
      }}
      onReason={(reason) => setAsk((a) => (a ? { ...a, reason } : a))}
      onCancelAsk={() => setAsk(null)}
      onConfirmAsk={() => {
        if (!ask || ask.busy) return;
        const sent = ask;
        setAsk({ ...sent, busy: true });
        setTimeout(() => {
          if (sent.act === "delete" && start.role !== "owner") {
            setAsk({ ...sent, busy: false, notice: actFailed("delete", sent.ids.length) });
            return;
          }
          setAsk(null);
          apply(sent.act, sent.ids, sent.reason);
        }, WAIT);
      }}
    />
  );
}

export function FeedbackListRoute() {
  return (
    <StatePage states={FEEDBACK_LIST_STATES}>
      {(state: ListState) => (
        <Frame>
          <ListScreen key={state} start={setup(state)} />
        </Frame>
      )}
    </StatePage>
  );
}
