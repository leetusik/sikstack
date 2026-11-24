/**
 * The backlog's model (design job 02: `Backlog.dc.html`, `BacklogWaiting`, `BacklogNow`, `BacklogPhases`; frame.md
 * F48, F79, F83, F304): what the page draws, from the Workspace's one read and the address. Pure (no React, no
 * I/O), so a node test reaches it.
 *
 * - **Waiting on operator**: the pointer's waiting list, in its own order. A stop opens its slice (its kind's
 *   word as a badge, its words as written); a gate opens its phase (the signed line of the workspace's rule).
 *   A stop's `what` is drawn only when the read carries one (it never does yet).
 * - **Now**: one block a stream that has a phase: Phase (its status and compact progress), Slice, and Next on
 *   the default stream only. No stream has a phase: one sentence, by what the phases are. Then **Waiting on
 *   operator** `None` (only when nothing waits).
 * - **Phases**: the phases in play (archived ones left out), their own count, `--steps-n` their longest.
 * - **Archived phases**: their own panel, ten a page, the page from `?archived=N` (held to 1 … the last page).
 *
 * A name or a status the read does not return is `null`, never made up: a slice the read names with no stored
 * name (or an older read with ids only) draws its id alone.
 */

import { BACKLOG } from "@/content/workspace/backlog";
import { WS_GLOSSARY, WS_STOP } from "@/content/workspace/frame";
import {
  backlogHref,
  phaseHref,
  sliceHref,
  type WorkspaceList,
} from "@/lib/workspace/address";
import { langOf } from "@/lib/workspace/model";
import type { PhaseRow, SliceName, Workspace } from "@/lib/workspace/types";

import { wsStatus, type WsStatusWord } from "../frame/status-model";
import { stepsN } from "../frame/steps-model";

/** Archived phases a page (F304). */
export const ARCHIVED_PER = BACKLOG.phases.pager.per;

const PAGE = /^[1-9][0-9]{0,5}$/;

/** The archived table's page the address asks for: `?archived=N`, 1-based; anything else is page 1. */
export function askedPage(value: string | string[] | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  return text !== undefined && PAGE.test(text) ? Number(text) : 1;
}

/** A thing as a link's text: its id, then its name when the read has one. */
export interface BacklogRef {
  id: string;
  name: string | null;
  lang: "en" | "ko";
  href: string;
}

export interface BacklogWaitingItem extends BacklogRef {
  type: "stop" | "gate";
  /** A stop's kind, as its badge reads it; `null` for a gate or a stop of no kind. */
  kind: string | null;
  what: string | null;
  words: string | null;
}

export interface BacklogSteps {
  done: number;
  total: number;
  live: boolean;
}

export interface BacklogCell extends BacklogRef {
  label: string;
  status: WsStatusWord | null;
  /** The Phase cell's progress (compact, its own total wide). */
  steps: BacklogSteps | null;
}

export interface BacklogStream {
  id: string;
  label: string | null;
  branch: string | null;
  cells: BacklogCell[];
}

export interface BacklogPhase {
  id: string;
  name: string;
  lang: "en" | "ko";
  href: string;
  /** The current slice under the name while the phase is not done: `S1`, and its name when the read has one. */
  sub: string | null;
  /** The current slice's name's language (`ko` for a Korean name). */
  subLang: "en" | "ko";
  status: WsStatusWord | null;
  verdict: WsStatusWord;
  steps: BacklogSteps;
}

export interface BacklogArchived {
  count: string;
  longest: number;
  rows: BacklogPhase[];
  total: number;
  page: number;
  pages: number;
}

export interface BacklogView {
  waiting: BacklogWaitingItem[];
  now: {
    /** `2 streams`, only with two or more running streams. */
    streams: string | null;
    blocks: BacklogStream[];
    /** The sentence when no stream has a phase. */
    idle: string | null;
    /** Waiting on operator `None`: only when nothing waits. */
    none: boolean;
  };
  phases: { count: string; longest: number; rows: BacklogPhase[] };
  archived: BacklogArchived | null;
  /** The list a link on this page carries on, so the way back returns to this archived page. */
  from: WorkspaceList | null;
}

const isLive = (p: Pick<PhaseRow, "status" | "done" | "total">) =>
  p.status === "in_progress" && p.done < p.total;

/** No stream has a phase: every phase done, a planned one waiting to run, or neither. */
export function idleSentence(
  phases: readonly Pick<PhaseRow, "status">[],
): string {
  if (phases.length > 0 && phases.every((p) => p.status === "done"))
    return BACKLOG.now.idle.done;
  if (phases.some((p) => p.status === "planned"))
    return BACKLOG.now.idle.planned;
  return BACKLOG.now.idle.plain;
}

/** A phase row's current slice under its name while it is not done: `S9 The backlog page`, or `S9` alone. */
function currentSub(p: PhaseRow): Pick<BacklogPhase, "sub" | "subLang"> {
  if (!p.current || p.status === "done") return { sub: null, subLang: "en" };
  const name =
    p.currentRef?.id === p.current ? p.currentRef.name?.trim() || null : null;
  return {
    sub: name ? `${p.current} ${name}` : p.current,
    subLang: langOf(name),
  };
}

/** The backlog of a linked, synced Workspace, at the archived table's page the address asks for. */
export function backlogView(
  ws: Workspace,
  project: string,
  asked: number = 1,
): BacklogView {
  const byId = new Map<string, PhaseRow>();
  for (const p of ws.phases) byId.set(p.id, p);
  for (const p of ws.phases) if (!byId.has(p.short)) byId.set(p.short, p);

  const live = ws.phases.filter((p) => !p.archived);
  const gone = ws.phases.filter((p) => p.archived);
  const pages = Math.max(1, Math.ceil(gone.length / ARCHIVED_PER));
  const page = Math.min(Math.max(1, Math.floor(asked) || 1), pages);
  const from: WorkspaceList | null =
    page > 1 ? { list: "backlog", archived: page } : null;

  const phaseRef = (id: string): BacklogRef => {
    const p = byId.get(id);
    const name = p?.name ?? null;
    return {
      id: p?.id ?? id,
      name,
      lang: langOf(name),
      href: phaseHref(project, p?.id ?? id, from),
    };
  };
  const sliceRef = (full: string, named?: SliceName | null): BacklogRef => {
    const name = named?.full === full ? named.name?.trim() || null : null;
    return {
      id: full,
      name,
      lang: langOf(name),
      href: sliceHref(project, full, from),
    };
  };
  const sliceStatus = (full: string, named?: SliceName | null) =>
    named?.full === full ? wsStatus("slice", named.status) : null;

  const waiting: BacklogWaitingItem[] = ws.pointer.waiting.map((w) => {
    const stop = w.type === "stop" && !!w.slice;
    const ref = stop
      ? sliceRef(w.slice as string, w.sliceRef)
      : phaseRef(w.phase);
    return {
      ...ref,
      type: stop ? "stop" : "gate",
      kind: stop && w.kind ? (WS_STOP[w.kind] ?? w.kind) : null,
      what: w.what || null,
      words: stop
        ? w.words || null
        : w.words || WS_GLOSSARY.sentences.gateWords,
    };
  });

  const running = ws.streams.filter((s) => s.phase);
  const blocks: BacklogStream[] = running.map((s) => {
    const p = byId.get(s.phase as string) ?? null;
    const cells: BacklogCell[] = [
      {
        ...phaseRef(s.phase as string),
        label: BACKLOG.now.labels.phase,
        status: wsStatus("phase", p?.status),
        steps: p ? { done: p.done, total: p.total, live: isLive(p) } : null,
      },
    ];
    if (s.slice)
      cells.push({
        ...sliceRef(s.slice, s.sliceRef),
        label: BACKLOG.now.labels.slice,
        status: sliceStatus(s.slice, s.sliceRef),
        steps: null,
      });
    if (s.id === "default" && ws.pointer.next)
      cells.push({
        ...sliceRef(ws.pointer.next, ws.pointer.nextRef),
        label: BACKLOG.now.labels.next,
        status: sliceStatus(ws.pointer.next, ws.pointer.nextRef),
        steps: null,
      });
    return { id: s.id, label: s.label, branch: s.branch, cells };
  });

  const row = (p: PhaseRow): BacklogPhase => ({
    id: p.id,
    name: p.name ?? WS_GLOSSARY.none,
    lang: langOf(p.name),
    href: phaseHref(project, p.id, from),
    ...currentSub(p),
    status: wsStatus("phase", p.status),
    verdict: wsStatus("verdict", p.review.verdict ?? "pending") ?? {
      word: "",
      cls: "status",
    },
    steps: { done: p.done, total: p.total, live: isLive(p) },
  });

  const shown = gone.slice((page - 1) * ARCHIVED_PER, page * ARCHIVED_PER);

  return {
    waiting,
    now: {
      streams: running.length > 1 ? BACKLOG.now.streams(running.length) : null,
      blocks,
      idle: running.length === 0 ? idleSentence(ws.phases) : null,
      none: waiting.length === 0,
    },
    phases: {
      count: BACKLOG.phases.count(live.length),
      longest: stepsN(live.map((p) => p.total)),
      rows: live.map(row),
    },
    archived:
      gone.length === 0
        ? null
        : {
            count: BACKLOG.phases.count(gone.length),
            longest: stepsN(gone.map((p) => p.total)),
            rows: shown.map(row),
            total: gone.length,
            page,
            pages,
          },
    from,
  };
}

/** Page `n` of the archived table: the backlog's own address, page 1 written as none. */
export function archivedHref(project: string, n: number): string {
  return backlogHref(project, { archived: n });
}
