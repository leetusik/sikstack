/**
 * The Agenda's pure model (design job 02, `AgendaList.dc.html`, frame.md F43, F79, F300 to F303): what the list
 * draws from the agenda as the page shows it (the read with the page's own changes laid over it). No React and
 * no I/O, so server pages, the client list and the tests share it.
 *
 * - The three parts: **Proposed** (P61-e9: the agendas an agent opened, or someone proposed back, that no one
 *   accepted yet, the read's `state: "proposed"`, listed first) in the read's order, each row's end cell who proposed
 *   it and the day; **Open and in progress** in the operator's order, an accepted agenda that waits for the sync
 *   (`accepting`) first; **Solved and dropped** newest first, five and **Show all N**. An agenda's part is its state
 *   (`itemState`). There is no Deferred part: an older stored Deferred reads Proposed (the server's word).
 * - A row: its id, title, `lang`, status word, mark (Waiting for sync, Change refused) and end cell (an open
 *   agenda's open items, `2 open items`, and its phases, `1 of 4 phases done`, or nothing; the other parts' the day
 *   it last changed).
 * - Add agenda is primary only while no part holds an agenda.
 */
import type { WsStatusWord } from "@/sikstack/workspace/frame/status-model";
import { wsStatus } from "@/sikstack/workspace/frame/status-model";
import { agendaHref, backlogHref, docsHref } from "@/lib/workspace/address";
import {
  itemEnd,
  itemState,
  type PhaseLookup,
} from "@/lib/workspace/model";
import type { AgendaItem, ItemState, WriteAnswer } from "@/lib/workspace/types";

import { AGENDA } from "@/content/workspace/agenda";
import { PROPOSED } from "@/content/workspace/agenda-thread";
import type { WsPlace } from "@/content/workspace/frame";

import { authorOf, type AuthorName } from "../frame/author-model";

/** Solved and dropped shows its newest five until Show all (F82). */
export const AGENDA_SHOWN = 5;

export type AgendaPartKey = "open" | "ended";

export interface AgendaRowModel {
  id: string;
  title: string;
  lang: "en" | "ko";
  state: ItemState;
  status: WsStatusWord;
  /** A change that waits, one the workspace refused, or none (F45). */
  mark: "waiting" | "refused" | null;
  /** The end cell's text; `''` draws no cell. */
  end: string;
  /** A Proposed row: who proposed it and the day (its end cell), else absent. */
  proposed?: { by: AuthorName | null; day: string } | null;
}

export interface AgendaParts {
  /** The items an agent proposed, before the open work (P61-e9). */
  proposed: AgendaRowModel[];
  open: AgendaRowModel[];
  ended: AgendaRowModel[];
}

/** An open agenda's end cell: its open items (the read's `itemsOpen`, predicted) and how far its phases are. */
export function openEnd(item: AgendaItem, phaseOf: PhaseLookup): string {
  const open =
    typeof item.itemsOpen === "number" && item.itemsOpen > 0
      ? AGENDA.itemsOpen(item.itemsOpen)
      : "";
  return [open, itemEnd(item, phaseOf).text].filter(Boolean).join(" · ");
}

function markOf(item: AgendaItem): AgendaRowModel["mark"] {
  if (item.sync === "waiting") return "waiting";
  if (item.sync !== null && typeof item.sync === "object") return "refused";
  return null;
}

/** Newest first by the day it last changed; a tie keeps the operator's order (the sort is stable). */
function newest(a: AgendaItem, b: AgendaItem): number {
  const x = a.changed ?? "";
  const y = b.changed ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

/**
 * The agenda (in the operator's order) as its four parts. An accepted item that waits for the sync (`accepting`)
 * is Open already, first in the open order, as the engine will place it. `dateOf` writes a day as F2 does (`Nov 12`). */
export function agendaParts(
  agenda: readonly AgendaItem[],
  phaseOf: PhaseLookup,
  dateOf: (day: string | null) => string,
): AgendaParts {
  const proposed: AgendaItem[] = [];
  const open: AgendaItem[] = [];
  const ended: AgendaItem[] = [];
  const states = new Map<string, ItemState>();
  for (const item of agenda) {
    if (item.state === "proposed" && !item.accepting) {
      proposed.push(item);
      states.set(item.id, "open");
      continue;
    }
    const state = itemState(item, phaseOf);
    states.set(item.id, state);
    if (state === "solved" || state === "dropped") ended.push(item);
    else open.push(item);
  }
  const row = (item: AgendaItem, end: string): AgendaRowModel => {
    const state = states.get(item.id) as ItemState;
    return {
      id: item.id,
      title: item.title ?? "",
      lang: item.lang === "ko" ? "ko" : "en",
      state,
      status: wsStatus("item", state) as WsStatusWord,
      mark: markOf(item),
      end,
    };
  };
  return {
    proposed: proposed.map((it) => ({
      ...row(it, ""),
      status: { word: PROPOSED.word, cls: PROPOSED.cls },
      proposed: {
        by: authorOf(it.proposed?.by),
        day: dateOf(it.proposed?.at ?? it.created),
      },
    })),
    open: open.map((it) => row(it, openEnd(it, phaseOf))),
    ended: [...ended].sort(newest).map((it) => row(it, dateOf(it.changed))),
  };
}

/** The Solved and dropped rows on screen: the newest five, or all once asked; `more` is Show all's count. */
export function endedShown<T>(
  rows: readonly T[],
  all: boolean,
): { rows: T[]; more: number | null } {
  if (all || rows.length <= AGENDA_SHOWN)
    return { rows: [...rows], more: null };
  return { rows: rows.slice(0, AGENDA_SHOWN), more: rows.length };
}

/** The open part's empty sentence: none at all, or none open while others are proposed or ended. */
export function emptyText(parts: AgendaParts): string {
  return parts.proposed.length || parts.ended.length
    ? AGENDA.empty.noOpen
    : AGENDA.empty.none;
}

/** Add agenda is the primary button only while the workspace holds no agenda at all. */
export function addIsPrimary(parts: AgendaParts): boolean {
  return (
    parts.proposed.length === 0 &&
    parts.open.length === 0 &&
    parts.ended.length === 0
  );
}

/** The three places' addresses, for `WsNav`. */
export function workspaceHrefs(project: string): Record<WsPlace, string> {
  return {
    agenda: agendaHref(project),
    backlog: backlogHref(project),
    docs: docsHref(project),
  };
}

/** The project's id from a Workspace page's path (`/projects/<id>/workspace…`), for the loading state. */
export function workspaceProjectId(path: string | null): string | null {
  const m = /^\/projects\/([^/?#]+)\/workspace(?:[/?#]|$)/.exec(path ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/**
 * What a write's answer shows, beside the field or over the form (F45): the signed title refusal under Title;
 * the route's own line for a change it refused or closed; F4's `Could not … Try again.` when nothing usable came
 * back; `signed-out` for the page to read again (the guard sends the reader to sign in).
 */
export type WriteShown =
  | { kind: "ok" }
  | { kind: "title"; message: string }
  | { kind: "notice"; message: string }
  | { kind: "signed-out" };

export function writeShown(answer: WriteAnswer, failed: string): WriteShown {
  if (answer.ok) return { kind: "ok" };
  switch (answer.reason) {
    case "title":
      return { kind: "title", message: answer.message };
    case "refused":
    case "closed":
      return { kind: "notice", message: answer.message };
    case "not-found":
      return { kind: "notice", message: answer.message ?? failed };
    case "signed-out":
      return { kind: "signed-out" };
    default:
      return { kind: "notice", message: failed };
  }
}
