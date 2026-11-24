import { todayIn } from "@/lib/workspace/model";
import type { AgendaItem, ChangeKind, InboxEntry, Workspace } from "@/lib/workspace/types";

import { DATA_SETS, ME, type DataName, type DataSet } from "./answers";
import { applyChange, type AgendaChange } from "./apply";
import { mintedId, topNumber } from "./ids";
import { DESIGN_STAMP, storeKey } from "./mark";
import { NOW, RECORDING, TIME_ZONE } from "./recording";

/**
 * The design build's browser store: the workspace the pages draw, seeded from the recording and kept
 * in `localStorage`, so every change shows at once and survives a reload; Reset puts the recording
 * back. Read through `useSyncExternalStore`: the build (and hydration) draws the recording, the
 * browser then draws what it kept. A state preset puts another data set in it (`load`) or sets one
 * item's state (`setItem`); `data` names the set it holds, so the state widget can read it back. Every snapshot
 * carries the build's stamp (`mark.ts`); one kept by another build or recording is dropped on load.
 */
export interface Snap {
  workspace: Workspace;
  /** How many items this browser added: the next add takes `mintedId(top, minted)`. */
  minted: number;
  /** The data set's highest id number (minted ids count on from it); the recording's when absent. */
  top?: number;
  /** The data set it holds (`answers.ts`); the recording's when absent. */
  data?: DataName;
  /** The build that kept it (`DESIGN_STAMP`); a snapshot from another build is dropped. */
  stamp?: string;
}

const KEY = storeKey(RECORDING.name);

/** A data set as the store holds it: each agenda row as its own item route answered it. */
function seed(set: DataSet = RECORDING, data: DataName = "recorded"): Snap {
  const ws = set.workspace;
  const agenda = ws.agenda.map((row) => {
    const own = set.items[row.id];
    if (!own) return row;
    const item: Partial<typeof own> = { ...own };
    delete item.workspace;
    return { ...row, ...item };
  });
  const top = topNumber(agenda.map((a) => a.id));
  return { workspace: { ...ws, agenda }, minted: 0, top, data, stamp: DESIGN_STAMP };
}

const SEED: Snap = seed();
/** The recorded ids' highest number: minted ids count on from it, as the pool of static pages does. */
const TOP = SEED.top ?? 0;

let snap: Snap | null = null;
/** A change applied and kept, not yet shown (`apply`). */
let pending: Snap | null = null;
const subs = new Set<() => void>();

function read(): Snap {
  if (snap) return snap;
  try {
    const raw = window.localStorage.getItem(KEY);
    const kept = raw ? (JSON.parse(raw) as Snap) : null;
    if (kept && kept.stamp !== DESIGN_STAMP) window.localStorage.removeItem(KEY);
    snap = kept && kept.stamp === DESIGN_STAMP ? kept : SEED;
  } catch {
    snap = SEED;
  }
  return snap;
}

function publish(next: Snap | null) {
  snap = next;
  subs.forEach((f) => f());
}

function onStorage(event: StorageEvent) {
  if (event.key === KEY || event.key === null) publish(null);
}

export function subscribe(f: () => void): () => void {
  subs.add(f);
  if (subs.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    subs.delete(f);
    if (subs.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export const getSnapshot = (): Snap => read();
export const getServerSnapshot = (): Snap => SEED;

/** An entry id (a v4 UUID, as `ENTRY_ID` reads it); `randomUUID` only exists in a secure context. */
function uuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Put the recording back. */
export function reset(): void {
  pending = null;
  window.localStorage.removeItem(KEY);
  publish(SEED);
}

/** What the store holds with every applied change, shown or not yet (a second change in one task reads the first). */
export const current = (): Snap => pending ?? read();

/** The data set the store holds now. */
export const dataOf = (s: Snap): DataName => s.data ?? "recorded";

function keep(snapshot: Snap) {
  pending = null;
  const next = { ...snapshot, stamp: DESIGN_STAMP };
  window.localStorage.setItem(KEY, JSON.stringify(next));
  publish(next);
}

/** A preset: hold another data set (`answers.ts`), as recorded, with nothing added yet. */
export function load(data: DataName): void {
  keep(seed(DATA_SETS[data], data));
}

/** A preset: set one item's own fields (its state, its mark), as the read would answer them. */
export function setItem(id: string, fields: Partial<AgendaItem>): void {
  const cur = pending ?? read();
  if (!cur.workspace.agenda.some((a) => a.id === id)) return;
  const agenda = cur.workspace.agenda.map((a) => (a.id === id ? { ...a, ...fields } : a));
  keep({ ...cur, workspace: { ...cur.workspace, agenda } });
}

/** Apply one change and keep it; the inbox entry it would have been, or the engine's refusal. An `entry` is
 * written by the signed-in account (`ME`, `person:<handle>`), from the web unless `source` names another place. */
export function apply(
  change: AgendaChange,
  source?: string,
): { ok: true; entry: InboxEntry } | { ok: false; refused: string } {
  const cur = pending ?? read();
  let minted = cur.minted;
  const id = uuid();
  const out = applyChange(cur.workspace, change, {
    day: todayIn(TIME_ZONE),
    mint: () => mintedId(cur.top ?? TOP, minted++),
    // the design's clock is the recording's: a note written now reads "just now" beside it
    entry: { id, at: new Date(NOW).toISOString().replace(/\.\d+Z$/, "Z"), author: ME, source },
  });
  if (!out.ok) return out;
  const next: Snap = { ...cur, workspace: out.workspace, minted, stamp: DESIGN_STAMP };
  window.localStorage.setItem(KEY, JSON.stringify(next));
  // The pages see it on the next task, after the action has answered: production's components lay the
  // answered change over the read until a read shows it taken, so the read must come after the answer.
  pending = next;
  setTimeout(() => {
    if (pending !== next) return;
    pending = null;
    publish(next);
  }, 0);
  return {
    ok: true,
    entry: {
      id,
      // `entry` and `accept` are inbox kinds `InboxEntry` does not type yet (lib/workspace/types.ts says so).
      kind: change.kind as ChangeKind,
      items: change.kind === "add" ? [] : [...change.items],
      fields: { ...change.fields },
      minted_id: out.minted,
      state: "applied",
      reason: null,
      created_at: new Date().toISOString(),
    },
  };
}
