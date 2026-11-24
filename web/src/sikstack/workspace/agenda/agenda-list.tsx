"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";

import { AGENDA, type AgendaAct } from "@/content/workspace/agenda";
import { PROPOSED } from "@/content/workspace/agenda-thread";
import { Dialog, DialogActions } from "@/sikstack/frame/dialog";
import { Pager } from "@/sikstack/library/pager";
import { pagerRange } from "@/sikstack/library/pager-model";
import { Swap } from "@/sikstack/ui";
import { retryLabel } from "@/sikstack/workspace/agenda-item/model";
import {
  RefusedNotice,
  useWsRetry,
  WaitingBadge,
  WsList,
} from "@/sikstack/workspace/frame";
import { WS_CHANGE } from "@/content/workspace/frame";
import {
  acceptAgendaItems,
  addAgendaItem,
  discardChange,
  moveAgendaItem,
  retryChange,
} from "@/lib/workspace/actions";
import { agendaHref, agendaItemHref } from "@/lib/workspace/address";
import { cx } from "@/lib/cx";
import { dates, phaseLookup } from "@/lib/workspace/model";
import {
  begin,
  EMPTY_OVERLAY,
  reconcile,
  settle,
  view,
  written,
  type AgendaRead,
  type Overlay,
  type Sending,
} from "@/lib/workspace/optimistic";
import { cleanTitle, titleError, type MovePlace } from "@/lib/workspace/rules";
import type { PhaseRow, Unplaced, WriteAnswer } from "@/lib/workspace/types";

import { BulkStrip, Grip, PartBar, PartCheck, RowCheck } from "./controls";
import { unplacedDone } from "./unplaced";
import {
  addIsPrimary,
  agendaFrom,
  agendaParts,
  AGENDA_SHOWN,
  emptyText,
  writeShown,
  type AgendaPartKey,
  type AgendaRowModel,
} from "./model";
import { AgendaLoading, AgendaRow, PartHead } from "./parts";
import {
  dragAt,
  dragDelta,
  dragShift,
  DRAG_START,
  edgeScroll,
  gripBlur,
  gripKey,
  liftedOrder,
  movePlace,
  type Drag,
  type Lift,
} from "./reorder";
import {
  actAsks,
  actSending,
  NO_PICKS,
  partPicks,
  rowsOnScreen,
  sendOrder,
  toggleAll,
  toggleRow,
  type Picks,
} from "./select";
import { sendAct } from "./send";

/** The phases an item's state and end cell need: their ids and status. */
export type AgendaPhase = Pick<PhaseRow, "id" | "short" | "status">;

export interface AgendaListProps {
  project: string;
  /** The Workspace's agenda (the operator's order) and its unplaced changes, as the page read them. */
  read: AgendaRead;
  phases: readonly AgendaPhase[];
  /** The viewer's zone: a day a change is made under, and F2's dates. */
  timeZone: string;
  /** The Deferred part's page the address names (`?deferred=N`), or null. */
  deferredPage: number | null;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

export type AgendaForm = null | {
  title: string;
  note: string;
  phase: "edit" | "adding" | "title-error" | "failed";
  /** Over the fields when the send failed: F45's sentence or the route's line. */
  notice: string | null;
};

/** What the confirm asks about (F303): Delete (the default) or Drop, the ids it acts on, Drop's reason. */
export interface AgendaAsk {
  kind?: "delete" | "drop";
  ids: string[];
  title: string;
  lang: "en" | "ko";
  busy: boolean;
  notice: string | null;
  reason?: string;
}

type Ask =
  | null
  | (AgendaAsk & {
      kind: "delete" | "drop";
      part: AgendaPartKey;
      reason: string;
    });

/** A pointer drag under way: where it started, the rows' middles then, the order it moves in. */
interface Grab {
  id: string;
  title: string;
  pointerId: number;
  startY: number;
  /** The window's scroll when it started, and the pointer's place in the window now. */
  startScroll: number;
  y: number;
  order: string[];
  mids: number[];
  from: number;
  h: number;
  at: number;
  lifted: boolean;
}

/**
 * The Agenda's list (`AgendaList.dc.html`, frame.md F301 to F303, F309): the three parts in a `.stack.gap-5`.
 *
 * - **Open and in progress** (always drawn): its head with the count and **Add item** (primary only while the
 *   agenda holds nothing; away while the form is open); the add form in place under the head; the open web changes
 *   no row carries (`unplaced`, F45's own notice); the rows in the operator's order, each led by its grip, or the
 *   empty sentence; the list's status line.
 * - **Deferred** (when any): newest first by `changed`, ten a page, the pager in its foot (`?deferred=N`).
 * - **Solved and dropped** (when any): newest first, five, then **Show all N**.
 *
 * **Reorder** (F302): the grip drags (pointer, touch) or lifts (Space, Enter; the arrows move, Escape or Tab puts it
 * back); a put down at another place writes one `move`, shown at once and Waiting for sync; each step is said.
 * **Picked rows** (F303, F309): each part's boxes cover its rows on screen; with any picked the head's count reads
 * `N of M selected` and the part's actions come in the head (52em of the part) or the strip at its end. Defer, Solve
 * and Reopen act at once; Drop and Delete ask. Every write is one inbox entry through the agenda's actions; the page
 * keeps what it wrote (`Overlay`) over each read until a read shows it applied or refused, and reads again after a
 * write (`router.refresh()`).
 *
 * **Proposed** (P61-e9, when any) comes first, before the open work: the items an agent opened, in the read's
 * order, no grip and no box (their columns stay, so every part keeps its edges), each row's end cell who proposed it
 * and the day, and **Accept** in Delete's place (disabled and busy while it is sent). Accept writes one `accept`;
 * the item becomes Open, first in the open order, Waiting for sync.
 */
export function AgendaList({
  project,
  read,
  phases,
  timeZone,
  deferredPage,
}: AgendaListProps) {
  const router = useRouter();
  const uid = useId();
  const ids = {
    proposed: `${uid}-proposed`,
    open: `${uid}-open`,
    deferred: `${uid}-deferred`,
    ended: `${uid}-ended`,
    title: `${uid}-title`,
    note: `${uid}-note`,
    error: `${uid}-error`,
    how: `${uid}-how`,
    reason: `${uid}-reason`,
  };

  // What this page wrote, laid over every read until a read shows it taken or refused.
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [seen, setSeen] = useState(read);
  if (seen !== read) {
    setSeen(read);
    setOverlay(reconcile(overlay, read));
  }

  const [form, setForm] = useState<AgendaForm>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [said, setSaid] = useState("");
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState<Record<string, "retry" | "discard">>({});
  const [picks, setPicks] = useState<Picks>(NO_PICKS);
  const [lift, setLift] = useState<Lift | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [failed, setFailed] = useState<null | {
    part: AgendaPartKey;
    message: string;
  }>(null);
  /** The Proposed row whose Accept is on its way, and an Accept that was not taken (P61-e9). */
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptFailed, setAcceptFailed] = useState<string | null>(null);

  const addRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const focus = useRef<"add" | "title" | "more" | null>(null);
  /** The part a confirmed action acted on: its box takes the focus when the confirm closes. */
  const acted = useRef<AgendaPartKey | null>(null);
  /** The part an action that acts at once acted on: its box takes the focus after it. */
  const focusPart = useRef<AgendaPartKey | null>(null);
  /** The grip a reorder step keeps focused (the list re-orders under it). */
  const focusGrip = useRef<string | null>(null);
  const boxes = useRef<Partial<Record<AgendaPartKey, HTMLInputElement | null>>>(
    {},
  );
  const grips = useRef(new Map<string, HTMLButtonElement>());
  const grab = useRef<Grab | null>(null);
  /** Ends what a lifted drag runs beside it: Escape's listener and the edge scroll's frames. */
  const stopLift = useRef<(() => void) | null>(null);

  /** The part's box, or Add item when the part (or its box) is gone (F303). */
  const partFocus = (part: AgendaPartKey): HTMLElement | null => {
    const box = boxes.current[part];
    return box && box.isConnected ? box : addRef.current;
  };

  useEffect(() => {
    if (focus.current === "add" && addRef.current) {
      focus.current = null;
      addRef.current.focus();
    } else if (focus.current === "title" && titleRef.current) {
      focus.current = null;
      titleRef.current.focus();
    }
    if (focusGrip.current !== null) {
      const el = grips.current.get(focusGrip.current);
      focusGrip.current = null;
      if (el && document.activeElement !== el) el.focus();
    }
    if (focusPart.current !== null) {
      const part = focusPart.current;
      focusPart.current = null;
      partFocus(part)?.focus();
    }
  });

  // A drag in motion ends with the page.
  useEffect(() => () => stopLift.current?.(), []);

  const phaseOf = useMemo(() => phaseLookup(phases), [phases]);
  const fmt = useMemo(() => dates(timeZone), [timeZone]);
  const shown = view(read, overlay);
  const parts = agendaParts(shown.agenda, phaseOf, fmt.date);
  const on = rowsOnScreen(parts, deferredPage, all);
  const place = on.place;
  const deferredRows = on.deferred;
  const from = agendaFrom(place.page);
  const hrefOf = (row: AgendaRowModel) => agendaItemHref(project, row.id, from);

  // Another page of the Deferred part: what was picked on the last one is not on screen any more.
  const [pickedPage, setPickedPage] = useState(place.page);
  if (pickedPage !== place.page) {
    setPickedPage(place.page);
    setPicks((p) => ({ ...p, deferred: [] }));
  }

  // A page asked for from the pager opens with the Deferred part's head in view:
  // the page stays where it was while the next page is read, then the part's head comes to the top.
  const deferredPart = useRef<HTMLElement>(null);
  const paged = useRef(false);
  useEffect(() => {
    if (!paged.current) return;
    paged.current = false;
    deferredPart.current?.scrollIntoView({ block: "start" });
  }, [place.page]);
  const onPage = (n: number, event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    paged.current = true;
    router.push(agendaHref(project, { deferred: n }), { scroll: false });
  };

  const open = parts.open;
  const openIds = open.map((r) => r.id);
  const titles = new Map(
    [...parts.proposed, ...parts.open, ...parts.deferred, ...parts.ended].map(
      (r) => [r.id, r],
    ),
  );
  const titleOf = (id: string) => titles.get(id)?.title ?? id;
  const liveLift = lift !== null && openIds.includes(lift.id) ? lift : null;
  const openRows = liftedOrder(open, liveLift);

  const pickOf = partPicks(on, parts, picks);

  // -- what a write's answer shows, when it is not taken ---------------------------------------

  const notTaken = (
    part: AgendaPartKey,
    answer: WriteAnswer,
    fallback: string,
  ) => {
    const result = writeShown(answer, fallback);
    if (result.kind === "signed-out") router.refresh();
    else if (result.kind === "notice" || result.kind === "title")
      setFailed({ part, message: result.message });
  };

  /** Show a change at once, send it, and keep it only if it was written (a drop of a drag, Defer, Solve, Reopen). */
  const sendNow = async (
    change: Sending,
    send: () => Promise<WriteAnswer>,
  ): Promise<WriteAnswer> => {
    let key = "";
    setOverlay((o) => {
      const b = begin(o, change, timeZone);
      key = b.key;
      return b.overlay;
    });
    const answer = await send();
    // Queued after the begin above, so `key` is set when this runs.
    setOverlay((o) => settle(o, key, answer));
    if (answer.ok) router.refresh();
    return answer;
  };

  // -- Accept (P61-e9) ------------------------------------------------------------------------

  /**
   * Accept a Proposed item: it becomes Open, first in the open order, and waits for the sync; the open part's box
   * (or Add item) takes the focus, the row it was on having left. After a reload the read says so itself
   * (`accepting`), so no second Accept is offered.
   */
  const accept = async (row: AgendaRowModel) => {
    if (accepting !== null) return;
    setAccepting(row.id);
    setAcceptFailed(null);
    const answer = await acceptAgendaItems(project, [row.id]);
    setAccepting(null);
    if (answer.ok) {
      // shown at once: the row leaves Proposed, Open and first in the open order, Waiting for sync
      setOverlay((o) => written(o, answer.entry, timeZone));
      setSaid(PROPOSED.said(row.title));
      focusPart.current = "open";
      router.refresh();
      return;
    }
    const result = writeShown(answer, PROPOSED.failed);
    if (result.kind === "signed-out") router.refresh();
    else if (result.kind !== "ok") setAcceptFailed(result.message);
  };

  // -- the add form --------------------------------------------------------------------------

  const openForm = () => {
    focus.current = "title";
    setPicks((p) => ({ ...p, open: [] }));
    setLift(null);
    setForm({ title: "", note: "", phase: "edit", notice: null });
  };
  const closeForm = () => {
    focus.current = "add";
    setForm(null);
  };
  const adding = form?.phase === "adding";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || adding) return;
    if (titleError(form.title) !== null) {
      focus.current = "title";
      setForm({ ...form, phase: "title-error", notice: null });
      return;
    }
    const typed = form;
    setForm({ ...typed, phase: "adding", notice: null });
    const answer = await addAgendaItem(project, {
      title: typed.title,
      note: typed.note,
    });
    const result = writeShown(answer, AGENDA.form.failed);
    if (answer.ok) {
      setOverlay((o) => written(o, answer.entry, timeZone));
      setSaid(AGENDA.said.added(cleanTitle(typed.title) ?? typed.title));
      closeForm();
      router.refresh();
      return;
    }
    if (result.kind === "signed-out") {
      router.refresh();
      setForm({ ...typed, phase: "edit", notice: null });
    } else if (result.kind === "title") {
      focus.current = "title";
      setForm({ ...typed, phase: "title-error", notice: null });
    } else if (result.kind === "notice") {
      setForm({ ...typed, phase: "failed", notice: result.message });
    }
  };

  const formKey = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape" && !adding) {
      event.preventDefault();
      closeForm();
    }
  };

  // -- reorder: the keyboard -------------------------------------------------------------------

  /** A put down at another place: one `move`, shown at once and Waiting for sync. */
  const put = async (id: string, to: MovePlace) => {
    setFailed(null);
    const answer = await sendNow(
      { kind: "move", items: [id], fields: to },
      () => moveAgendaItem(project, id, to),
    );
    if (answer.ok) return;
    // Not taken: the row is back where it was, so the status line no longer says it waits; the part's notice says why.
    setSaid("");
    notTaken("open", answer, AGENDA.actFailed("move", 1));
  };

  const gripKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (grab.current !== null) return;
    const step = gripKey(openIds, titleOf, liveLift, id, event.key);
    if (step === null) return;
    event.preventDefault();
    if (step.focus !== null) focusGrip.current = step.focus;
    setLift(step.lift);
    if (step.said !== null) setSaid(step.said);
    if (step.put !== null) void put(step.put.id, step.put.place);
  };

  const gripBlurred = (id: string) => {
    const step = gripBlur(openIds, titleOf, liveLift, id, focusGrip.current);
    if (step === null) return;
    setLift(null);
    if (step.said !== null) setSaid(step.said);
  };

  // -- reorder: pointer and touch --------------------------------------------------------------

  const endGrab = () => {
    grab.current = null;
    stopLift.current?.();
    stopLift.current = null;
    setDrag(null);
  };

  /** Escape, a cancelled pointer or a lost capture: the row goes back where it was. */
  const putBack = () => {
    const g = grab.current;
    if (g === null) return;
    endGrab();
    if (g.lifted)
      setSaid(AGENDA.said.cancelled(g.title, g.from + 1, g.order.length));
  };

  const pointerDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || liveLift !== null || grab.current !== null)
      return;
    const fromAt = openIds.indexOf(id);
    const rects = openIds.map(
      (x) =>
        grips.current.get(x)?.closest("li")?.getBoundingClientRect() ?? null,
    );
    if (fromAt === -1 || rects.some((r) => r === null)) return;
    const boxesOf = rects as DOMRect[];
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    grab.current = {
      id,
      title: titleOf(id),
      pointerId: event.pointerId,
      startY: event.clientY,
      startScroll: window.scrollY,
      y: event.clientY,
      order: [...openIds],
      mids: boxesOf.map((r) => r.top + r.height / 2),
      from: fromAt,
      h: boxesOf[fromAt].height,
      at: fromAt,
      lifted: false,
    };
  };

  /** The lifted row follows the pointer and the window's scroll together (`dragDelta`). */
  const follow = (g: Grab) => {
    const dy = dragDelta(g.y, g.startY, window.scrollY, g.startScroll);
    const at = dragAt(g.mids, g.from, dy);
    if (at !== g.at) {
      g.at = at;
      setSaid(AGENDA.said.movedTo(g.title, at + 1, g.order.length));
    }
    setDrag({ id: g.id, from: g.from, at, dy, h: g.h });
  };

  /**
   * While the row is lifted, each frame scrolls the window when the pointer is near its top or bottom edge
   * (`edgeScroll`, stopping at the ends; an instant scroll, the only motion it adds), and the row follows any scroll.
   */
  const edgeFrames = (g: Grab) => {
    let frame = 0;
    let seen = window.scrollY;
    const tick = () => {
      if (grab.current !== g) return;
      const root = document.documentElement;
      const step = edgeScroll(
        g.y,
        window.innerHeight,
        window.scrollY,
        root.scrollHeight - window.innerHeight,
      );
      if (step !== 0) window.scrollBy({ top: step, behavior: "instant" });
      if (window.scrollY !== seen) {
        seen = window.scrollY;
        follow(g);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  };

  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    g.y = event.clientY;
    if (!g.lifted) {
      if (Math.abs(event.clientY - g.startY) < DRAG_START) return;
      g.lifted = true;
      setSaid(
        AGENDA.said.pickedUpByPointer(g.title, g.from + 1, g.order.length),
      );
      const key = (e: globalThis.KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          putBack();
        }
      };
      window.addEventListener("keydown", key);
      const stopFrames = edgeFrames(g);
      stopLift.current = () => {
        window.removeEventListener("keydown", key);
        stopFrames();
      };
    }
    follow(g);
  };

  const pointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const g = grab.current;
    if (g === null || event.pointerId !== g.pointerId) return;
    endGrab();
    if (!g.lifted) return;
    const to = movePlace(g.order, g.id, g.at);
    if (to === null) {
      setSaid(AGENDA.said.putBack(g.title));
      return;
    }
    setSaid(AGENDA.said.putDown(g.title, g.at + 1, g.order.length));
    void put(g.id, to);
  };

  // -- picked rows -----------------------------------------------------------------------------

  const pickIn = (
    part: AgendaPartKey,
    next: (ticked: readonly string[]) => string[],
  ) => setPicks((p) => ({ ...p, [part]: next(p[part]) }));

  const clearPart = (part: AgendaPartKey) => {
    focusPart.current = part;
    pickIn(part, () => []);
  };

  /** Defer, Solve, Reopen: at once, for every picked id; the box takes the focus. */
  const actNow = async (
    part: AgendaPartKey,
    kind: "defer" | "solve" | "reopen",
    items: string[],
  ) => {
    setFailed(null);
    focusPart.current = part;
    pickIn(part, () => []);
    setSaid(AGENDA.said.acted(kind, items.length, titleOf(items[0])));
    const answer = await sendNow(actSending(kind, items), () =>
      sendAct(project, kind, items),
    );
    if (answer.ok) return;
    // Not taken: the rows are back where they were, still picked, and the part says so; the status line no longer
    // says they wait.
    setSaid("");
    pickIn(part, () => items);
    notTaken(part, answer, AGENDA.actFailed(kind, items.length));
  };

  const onAct = (part: AgendaPartKey, kind: AgendaAct) => {
    const items = sendOrder(shown.agenda, pickOf[part].picked);
    if (items.length === 0) return;
    if (actAsks(kind)) {
      const first = titles.get(items[0]);
      acted.current = null;
      setAsk({
        kind,
        part,
        ids: items,
        title: first?.title ?? items[0],
        lang: first?.lang ?? "en",
        busy: false,
        notice: null,
        reason: "",
      });
      return;
    }
    void actNow(part, kind, items);
  };

  // -- Delete on a row, and the confirm --------------------------------------------------------

  const askDelete = (part: AgendaPartKey, row: AgendaRowModel) => {
    acted.current = null;
    setAsk({
      kind: "delete",
      part,
      ids: [row.id],
      title: row.title,
      lang: row.lang,
      busy: false,
      notice: null,
      reason: "",
    });
  };
  const confirmAsk = async () => {
    if (!ask || ask.busy) return;
    const asked = ask;
    setAsk({ ...asked, busy: true, notice: null });
    const answer = await sendAct(project, asked.kind, asked.ids, asked.reason);
    const n = asked.ids.length;
    if (answer.ok) {
      acted.current = asked.part;
      setOverlay((o) => written(o, answer.entry, timeZone));
      pickIn(asked.part, () => []);
      setFailed(null);
      setSaid(AGENDA.said.acted(asked.kind, n, asked.title));
      setAsk(null);
      router.refresh();
      return;
    }
    const result = writeShown(
      answer,
      asked.kind === "delete" && n === 1
        ? AGENDA.confirmDelete.failed
        : AGENDA.actFailed(asked.kind, n),
    );
    if (result.kind === "signed-out") router.refresh();
    setAsk({
      ...asked,
      busy: false,
      notice:
        result.kind === "notice" || result.kind === "title"
          ? result.message
          : null,
    });
  };

  // -- the open changes no row carries ---------------------------------------------------------

  // The pressed button goes with its notice (or was disabled while it ran): the open part's box takes the focus.
  const unplacedAct = async (u: Unplaced, act: "discard" | "retry") => {
    setBusy((b) => ({ ...b, [u.entry]: act }));
    const answer = await (act === "discard" ? discardChange : retryChange)(
      project,
      u.entry,
    );
    setBusy((b) => without(b, u.entry));
    const done = (o: Overlay) =>
      unplacedDone(o, u.entry, act, answer, timeZone);
    focusPart.current = done(EMPTY_OVERLAY).focus;
    setOverlay((o) => done(o).overlay);
    router.refresh();
  };
  const discard = (u: Unplaced) => unplacedAct(u, "discard");
  const retry = (u: Unplaced) => unplacedAct(u, "retry");

  // -- drawing ---------------------------------------------------------------------------------

  const boxOf = (part: AgendaPartKey) => (
    <PartCheck
      pick={pickOf[part]}
      boxRef={(el) => {
        boxes.current[part] = el;
      }}
      onToggle={() => pickIn(part, () => toggleAll(pickOf[part]))}
    />
  );
  const checkOf = (part: AgendaPartKey, row: AgendaRowModel) => (
    <RowCheck
      title={row.title}
      checked={pickOf[part].picked.includes(row.id)}
      onToggle={() => pickIn(part, (t) => toggleRow(t, row.id))}
    />
  );
  const picked = (part: AgendaPartKey) => pickOf[part].picked.length > 0;
  const barOf = (part: AgendaPartKey) =>
    picked(part) ? (
      <PartBar
        pick={pickOf[part]}
        onClear={() => clearPart(part)}
        onAct={(kind) => onAct(part, kind)}
      />
    ) : null;
  const stripOf = (part: AgendaPartKey) =>
    picked(part) ? (
      <BulkStrip
        pick={pickOf[part]}
        onClear={() => clearPart(part)}
        onAct={(kind) => onAct(part, kind)}
      />
    ) : null;
  const failedOf = (part: AgendaPartKey) =>
    failed !== null && failed.part === part ? (
      <div className="panel-body has-rule">
        <p className="notice notice-danger" role="alert">
          {failed.message}
        </p>
      </div>
    ) : null;

  return (
    <div className={cx("stack gap-5", drag !== null && "agenda-dragging")}>
      {parts.proposed.length > 0 ? (
        <section className="panel agenda-part" aria-labelledby={ids.proposed}>
          <PartHead
            headId={ids.proposed}
            head={PROPOSED.head}
            count={AGENDA.count(parts.proposed.length)}
          />
          {acceptFailed ? (
            <div className="panel-body has-rule">
              <p className="notice notice-danger" role="alert">
                {acceptFailed}
              </p>
            </div>
          ) : null}
          <WsList>
            {parts.proposed.map((row) => (
              <AgendaRow
                key={row.id}
                row={row}
                href={hrefOf(row)}
                action={
                  // Delete's quiet button, so every part keeps its columns; while it is sent it is disabled and busy
                  <button
                    type="button"
                    className="agenda-del"
                    aria-label={PROPOSED.acceptLabel(row.title)}
                    disabled={accepting !== null}
                    aria-busy={accepting === row.id ? true : undefined}
                    onClick={() => void accept(row)}
                  >
                    {PROPOSED.accept[0]}
                  </button>
                }
              />
            ))}
          </WsList>
        </section>
      ) : null}
      <section className="panel agenda-part" aria-labelledby={ids.open}>
        <PartHead
          headId={ids.open}
          head={AGENDA.heads.open}
          count={pickOf.open.count}
          check={open.length > 0 ? boxOf("open") : null}
        >
          {barOf("open")}
          {form === null ? (
            <div
              className={cx(
                "cluster agenda-head-acts agenda-add",
                picked("open") && "is-picking",
              )}
            >
              <button
                type="button"
                className={addIsPrimary(parts) ? "btn btn-primary" : "btn"}
                ref={addRef}
                onClick={openForm}
              >
                {AGENDA.addItem}
              </button>
            </div>
          ) : null}
        </PartHead>
        {form !== null ? (
          <AddForm
            ids={ids}
            form={form}
            titleRef={titleRef}
            onChange={setForm}
            onSubmit={submit}
            onKeyDown={formKey}
            onCancel={closeForm}
          />
        ) : null}
        {failedOf("open")}
        {shown.unplaced.length > 0 ? (
          <div className="panel-body has-rule stack gap-3">
            {shown.unplaced.map((u) =>
              u.refused !== null ||
              (u.sync !== null && typeof u.sync === "object") ? (
                <RefusedNotice
                  key={u.entry}
                  said={
                    u.refused ??
                    (typeof u.sync === "object" ? u.sync.refused : "")
                  }
                  busy={busy[u.entry] ?? null}
                  retryPending={retryLabel(
                    u.kind ??
                      (typeof u.sync === "object" ? u.sync.kind : undefined),
                  )}
                  onRetry={() => retry(u)}
                  onDiscard={() => discard(u)}
                />
              ) : (
                <div key={u.entry} className="notice stack gap-3">
                  <p className="cluster">
                    {u.items.map((id) => (
                      <span key={id} className="ws-id">
                        {id}
                      </span>
                    ))}
                    <WaitingBadge />
                  </p>
                  <div className="cluster">
                    <button
                      type="button"
                      className="btn btn-quiet"
                      disabled={busy[u.entry] !== undefined}
                      data-busy={busy[u.entry] ? "true" : undefined}
                      onClick={() => discard(u)}
                    >
                      {WS_CHANGE.discard}
                    </button>
                  </div>
                </div>
              ),
            )}
          </div>
        ) : null}
        {open.length > 0 ? (
          <>
            <WsList>
              {openRows.map((row) => {
                const lifted = liveLift?.id === row.id || drag?.id === row.id;
                const shift = dragShift(openIds.indexOf(row.id), drag);
                return (
                  <AgendaRow
                    key={row.id}
                    row={row}
                    href={hrefOf(row)}
                    className={cx(
                      pickOf.open.picked.includes(row.id) && "is-selected",
                      lifted && "is-lifted",
                    )}
                    style={
                      shift
                        ? { transform: `translateY(${Math.round(shift)}px)` }
                        : undefined
                    }
                    lead={
                      <Grip
                        title={row.title}
                        howId={ids.how}
                        lifted={lifted}
                        gripRef={(el) => {
                          if (el) grips.current.set(row.id, el);
                          else grips.current.delete(row.id);
                        }}
                        onPointerDown={(e) => pointerDown(e, row.id)}
                        onPointerMove={pointerMove}
                        onPointerUp={pointerUp}
                        onPointerCancel={putBack}
                        onLostPointerCapture={putBack}
                        onKeyDown={(e) => gripKeyDown(e, row.id)}
                        onBlur={() => gripBlurred(row.id)}
                      />
                    }
                    check={checkOf("open", row)}
                    onDelete={() => askDelete("open", row)}
                  />
                );
              })}
            </WsList>
            <p className="sr-only" id={ids.how}>
              {AGENDA.grip.how}
            </p>
          </>
        ) : (
          <div className="panel-body has-rule block">
            <p className="block-text">{emptyText(parts)}</p>
          </div>
        )}
        {stripOf("open")}
        <p className="sr-only" role="status">
          {said}
        </p>
      </section>

      {parts.deferred.length > 0 ? (
        <section
          className="panel agenda-part"
          aria-labelledby={ids.deferred}
          ref={deferredPart}
        >
          <PartHead
            headId={ids.deferred}
            head={AGENDA.heads.deferred}
            count={pickOf.deferred.count}
            check={boxOf("deferred")}
          >
            {barOf("deferred")}
          </PartHead>
          {failedOf("deferred")}
          <WsList>
            {deferredRows.map((row) => (
              <AgendaRow
                key={row.id}
                row={row}
                href={hrefOf(row)}
                className={cx(
                  pickOf.deferred.picked.includes(row.id) && "is-selected",
                )}
                check={checkOf("deferred", row)}
                onDelete={() => askDelete("deferred", row)}
              />
            ))}
          </WsList>
          {place.paged ? (
            <div className="panel-foot agenda-foot">
              <Pager
                page={place.page}
                pages={place.pages}
                range={pagerRange(
                  place.page,
                  AGENDA.pager.per,
                  parts.deferred.length,
                )}
                label={AGENDA.pager.label}
                pageKey="deferred"
                hrefFor={(n) => agendaHref(project, { deferred: n })}
                onPage={onPage}
              />
            </div>
          ) : null}
          {stripOf("deferred")}
        </section>
      ) : null}

      {parts.ended.length > 0 ? (
        <section className="panel agenda-part" aria-labelledby={ids.ended}>
          <PartHead
            headId={ids.ended}
            head={AGENDA.heads.ended}
            count={pickOf.ended.count}
            check={boxOf("ended")}
          >
            {barOf("ended")}
          </PartHead>
          {failedOf("ended")}
          <WsList>
            {on.ended.map((row, i) => (
              <AgendaRow
                key={row.id}
                row={row}
                href={hrefOf(row)}
                className={cx(
                  pickOf.ended.picked.includes(row.id) && "is-selected",
                )}
                linkRef={
                  i === AGENDA_SHOWN
                    ? (el) => {
                        if (el && focus.current === "more") {
                          focus.current = null;
                          el.focus();
                        }
                      }
                    : undefined
                }
                check={checkOf("ended", row)}
                onDelete={() => askDelete("ended", row)}
              />
            ))}
          </WsList>
          {on.more !== null ? (
            <div className="panel-foot">
              <button
                type="button"
                className="link link-row"
                onClick={() => {
                  focus.current = "more";
                  setAll(true);
                }}
              >
                {AGENDA.showAll(on.more)}
              </button>
            </div>
          ) : null}
          {stripOf("ended")}
        </section>
      ) : null}

      {ask !== null ? (
        <AgendaConfirm
          ask={ask}
          cancelRef={cancelRef}
          reasonId={ids.reason}
          onReason={(reason) => setAsk({ ...ask, reason })}
          onCancel={() => setAsk(null)}
          onConfirm={confirmAsk}
          returnFocus={() =>
            acted.current !== null ? partFocus(acted.current) : null
          }
        />
      ) : null}
    </div>
  );
}

/**
 * The add form, in place under the open part's head (`AgendaList.dc.html`, F81): **Title** (one line, its
 * placeholder), **Note (optional)** (two rows), then **Cancel** and **Add** (`Adding…` while it is sent; both
 * fields and Cancel are disabled then). A title the route would refuse puts the signed sentence under the field
 * (`.field-error`, `aria-invalid`, `aria-describedby`), gone when the field is edited; a send that failed puts its
 * sentence over the fields (`role="alert"`), the form open with what was typed.
 */
export function AddForm({
  ids,
  form,
  titleRef,
  onChange,
  onSubmit,
  onKeyDown,
  onCancel,
}: {
  ids: { title: string; note: string; error: string };
  form: NonNullable<AgendaForm>;
  titleRef?: RefObject<HTMLInputElement | null>;
  onChange: (form: NonNullable<AgendaForm>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const adding = form.phase === "adding";
  const fieldError = form.phase === "title-error";
  const noted = form.notice;
  return (
    <form
      className="panel-body has-rule"
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      noValidate
    >
      <div className="stack agenda-form">
        {noted !== null ? (
          <p className="notice notice-danger" role="alert">
            {noted}
          </p>
        ) : null}
        <div className="field">
          <label className="label" htmlFor={ids.title}>
            {AGENDA.form.title}
          </label>
          <input
            className="input"
            id={ids.title}
            type="text"
            autoComplete="off"
            placeholder={AGENDA.form.titlePlaceholder}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? ids.error : undefined}
            value={form.title}
            disabled={adding}
            ref={titleRef}
            onChange={(e) =>
              onChange({
                ...form,
                title: e.target.value,
                phase: fieldError ? "edit" : form.phase,
              })
            }
          />
          {fieldError ? (
            <p className="field-error" id={ids.error}>
              {AGENDA.form.titleError}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label className="label" htmlFor={ids.note}>
            {AGENDA.form.note}
          </label>
          <textarea
            className="input"
            id={ids.note}
            rows={2}
            value={form.note}
            disabled={adding}
            onChange={(e) => onChange({ ...form, note: e.target.value })}
          />
        </div>
        <div className="cluster to-end">
          <button
            type="button"
            className="btn"
            disabled={adding}
            onClick={onCancel}
          >
            {AGENDA.form.cancel}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            data-busy={adding ? "true" : undefined}
            aria-busy={adding ? true : undefined}
          >
            <Swap labels={[...AGENDA.form.add]} />
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * Drop and Delete ask first (F303; the system's `Dialog`, F3), naming what they act on: `Delete “<title>”?` or
 * `Delete 3 items?` with Delete's sentence, **Cancel** and **Yes, delete** (`.btn-danger`, `Deleting…` while it is
 * sent); `Drop “<title>”?` or `Drop 3 items?` with Drop's sentence, one field **Reason (optional)** (Enter in it
 * drops), **Cancel** and **Yes, drop** (`.btn-primary`, `Dropping…`). Escape does nothing while it is sent. Focus
 * opens on Cancel; Cancel or Escape closes it and focus goes back to the button that opened it (`returnFocus()`
 * null). After it acts, focus goes to `returnFocus()`: the part's box (Add item when the part is gone).
 */
export function AgendaConfirm({
  ask,
  cancelRef,
  reasonId,
  onReason,
  onCancel,
  onConfirm,
  returnFocus,
}: {
  ask: AgendaAsk;
  cancelRef: RefObject<HTMLButtonElement | null>;
  /** Drop's Reason field: its id and its edits. */
  reasonId?: string;
  onReason?: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const drop = ask.kind === "drop";
  const w = drop ? AGENDA.confirmDrop : AGENDA.confirmDelete;
  const one = ask.ids.length === 1;
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
      <p>{one ? w.text : w.textMany}</p>
      {ask.notice !== null ? (
        <p className="notice notice-danger" role="alert">
          {ask.notice}
        </p>
      ) : null}
      {drop ? (
        <div className="field">
          <label className="label" htmlFor={reasonId}>
            {AGENDA.confirmDrop.reason}
          </label>
          <input
            className="input"
            id={reasonId}
            type="text"
            autoComplete="off"
            value={ask.reason ?? ""}
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
          data-cancel="true"
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
          onClick={onConfirm}
        >
          <Swap labels={[...w.yes]} />
        </button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * The agenda did not load (F49: a part that failed keeps its head): the first part's title alone, `The agenda did
 * not load.` and **Try again**, which shows the loading part while the page reads again.
 */
export function AgendaFailed() {
  const router = useRouter();
  const uid = useId();
  const [pending, start] = useWsRetry();
  if (pending) return <AgendaLoading headId={`${uid}-open`} />;
  return (
    <div className="stack gap-5">
      <section className="panel agenda-part" aria-labelledby={`${uid}-open`}>
        <PartHead
          headId={`${uid}-open`}
          head={AGENDA.heads.open}
          count={null}
        />
        <div className="panel-body has-rule block">
          <p className="block-text">{AGENDA.failed}</p>
          <button
            type="button"
            className="btn"
            onClick={() => start(() => router.refresh())}
          >
            {AGENDA.retry}
          </button>
        </div>
      </section>
    </div>
  );
}
