/**
 * The Agenda's pure model (design job 02, `AgendaList.dc.html`, frame.md F43, F79, F300 to F303): what the list
 * draws from the agenda as the page shows it (the read with the page's own changes laid over it). No React and
 * no I/O, so server pages, the client list and the tests share it.
 *
 * - The three parts: **Open and in progress** in the operator's order; **Deferred** newest first by `changed`,
 *   ten a page; **Solved and dropped** newest first, five and **Show all N**. An item's part is its state
 *   (`itemState`): deferred, solved and dropped are its own, so a deferred item stays Deferred while a phase it
 *   holds runs (F301).
 * - A row: its id, title, `lang`, status word, mark (Waiting for sync, Change refused) and end cell (an open
 *   item's `1 of 4 phases done, 3 deferred jobs`, or nothing; the other parts' the day it last changed).
 * - The Deferred part's page from the address (`?deferred=N`, 1-based): a value that is not a page, or past the
 *   last page, reads page 1.
 *
 * The next version (P61-e9, design folder): a fourth part, **Proposed**, before the open work: the items an agent
 * opened that no one accepted yet (the read's `state: "proposed"`, listed first), in the read's order, each row's end
 * cell who proposed it and the day. Add item is primary only while no part holds an item.
 */
import type { WsStatusWord } from "@/sikstack/workspace/frame/status-model";
import { wsStatus } from "@/sikstack/workspace/frame/status-model";
import {
  agendaHref,
  backlogHref,
  deferredHref,
  docsHref,
  type WorkspaceList,
} from "@/lib/workspace/address";
import { itemEnd, itemState, type PhaseLookup } from "@/lib/workspace/model";
import type { AgendaItem, ItemState, WriteAnswer } from "@/lib/workspace/types";

import { AGENDA } from "@/content/workspace/agenda";
import type { WsPlace } from "@/content/workspace/frame";

import { PROPOSED } from "../../content/agenda-thread";
import { authorOf, type AuthorName } from "../frame/author";

/** The Deferred part's rows a page (F300). */
export const AGENDA_PER = AGENDA.pager.per;
/** Solved and dropped shows its newest five until Show all (F82). */
export const AGENDA_SHOWN = 5;

export type AgendaPartKey = "open" | "deferred" | "ended";

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
  deferred: AgendaRowModel[];
  ended: AgendaRowModel[];
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

/** The agenda (in the operator's order) as its three parts. `dateOf` writes a day as F2 does (`Nov 12`). */
export function agendaParts(
  agenda: readonly AgendaItem[],
  phaseOf: PhaseLookup,
  dateOf: (day: string | null) => string,
): AgendaParts {
  const proposed: AgendaItem[] = [];
  const open: AgendaItem[] = [];
  const deferred: AgendaItem[] = [];
  const ended: AgendaItem[] = [];
  const states = new Map<string, ItemState>();
  for (const item of agenda) {
    if (item.state === "proposed") {
      proposed.push(item);
      states.set(item.id, "open");
      continue;
    }
    const state = itemState(item, phaseOf);
    states.set(item.id, state);
    if (state === "deferred") deferred.push(item);
    else if (state === "solved" || state === "dropped") ended.push(item);
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
    open: open.map((it) => row(it, itemEnd(it, phaseOf).text)),
    deferred: [...deferred]
      .sort(newest)
      .map((it) => row(it, dateOf(it.changed))),
    ended: [...ended].sort(newest).map((it) => row(it, dateOf(it.changed))),
  };
}

const PAGE = /^[1-9][0-9]{0,5}$/;

/** The page the address names (`?deferred=3` → 3), or null when it names none or not a page. */
export function deferredPageFrom(
  raw: string | string[] | null | undefined,
): number | null {
  return typeof raw === "string" && PAGE.test(raw) ? Number(raw) : null;
}

export interface DeferredPlace {
  /** 1-based. */
  page: number;
  pages: number;
  /** The rows of that page. */
  from: number;
  to: number;
  /** More than one page: the pager is drawn. */
  paged: boolean;
}

/**
 * Where the Deferred part is: the address's page when there is one, else page 1; a page past the last (an action
 * emptied it) is held to the last page, as the Deferred jobs list and the Backlog's Archived phases do.
 */
export function deferredPlace(
  asked: number | null,
  total: number,
): DeferredPlace {
  const pages = Math.max(1, Math.ceil(total / AGENDA_PER));
  const page = asked !== null && asked >= 1 ? Math.min(asked, pages) : 1;
  return {
    page,
    pages,
    from: (page - 1) * AGENDA_PER,
    to: Math.min(total, page * AGENDA_PER),
    paged: total > AGENDA_PER,
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

/** The open part's empty sentence: none at all, or none open while others are deferred or ended. */
export function emptyText(parts: AgendaParts): string {
  return parts.proposed.length || parts.deferred.length || parts.ended.length
    ? AGENDA.empty.noOpen
    : AGENDA.empty.none;
}

/** Add item is the primary button only while the agenda holds no item at all. */
export function addIsPrimary(parts: AgendaParts): boolean {
  return (
    parts.proposed.length === 0 &&
    parts.open.length === 0 &&
    parts.deferred.length === 0 &&
    parts.ended.length === 0
  );
}

/** The list an item is opened from, for its way back: the Agenda at the Deferred part's page. */
export function agendaFrom(page: number): WorkspaceList | null {
  return page > 1 ? { list: "agenda", deferred: page } : null;
}

/** The four places' addresses, for `WsNav`. */
export function workspaceHrefs(project: string): Record<WsPlace, string> {
  return {
    agenda: agendaHref(project),
    backlog: backlogHref(project),
    deferred: deferredHref(project),
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
