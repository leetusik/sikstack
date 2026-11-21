import { todayIn } from "@/lib/workspace/model";
import type { InboxEntry, Workspace } from "@/lib/workspace/types";

import { applyChange, type AgendaChange } from "./apply";
import { mintedId, topNumber } from "./ids";
import { storeKey } from "./mark";
import { RECORDING, TIME_ZONE } from "./recording";

/**
 * The design build's browser store: the workspace the pages draw, seeded from the recording and kept
 * in `localStorage`, so every change shows at once and survives a reload; Reset puts the recording
 * back. Read through `useSyncExternalStore`: the build (and hydration) draws the recording, the
 * browser then draws what it kept.
 */
export interface Snap {
  workspace: Workspace;
  /** How many items this browser added: the next add takes `mintedId(top, minted)`. */
  minted: number;
}

const KEY = storeKey(RECORDING.name);

/** The recording as the store starts: each agenda row as its own item route answered it. */
function seed(): Snap {
  const ws = RECORDING.workspace;
  const agenda = ws.agenda.map((row) => {
    const own = RECORDING.items[row.id];
    if (!own) return row;
    const item: Partial<typeof own> = { ...own };
    delete item.workspace;
    return { ...row, ...item };
  });
  return { workspace: { ...ws, agenda }, minted: 0 };
}

const SEED: Snap = seed();
/** The recorded ids' highest number: minted ids count on from it, as the pool of static pages does. */
const TOP = topNumber(SEED.workspace.agenda.map((a) => a.id));

let snap: Snap | null = null;
/** A change applied and kept, not yet shown (`apply`). */
let pending: Snap | null = null;
const subs = new Set<() => void>();

function read(): Snap {
  if (snap) return snap;
  try {
    const raw = window.localStorage.getItem(KEY);
    snap = raw ? (JSON.parse(raw) as Snap) : SEED;
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

/** Apply one change and keep it; the inbox entry it would have been, or the engine's refusal. */
export function apply(
  change: AgendaChange,
): { ok: true; entry: InboxEntry } | { ok: false; refused: string } {
  const cur = pending ?? read();
  let minted = cur.minted;
  const out = applyChange(cur.workspace, change, {
    day: todayIn(TIME_ZONE),
    mint: () => mintedId(TOP, minted++),
  });
  if (!out.ok) return out;
  const next: Snap = { workspace: out.workspace, minted };
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
      id: uuid(),
      kind: change.kind,
      items: change.kind === "add" ? [] : [...change.items],
      fields: { ...change.fields },
      minted_id: out.minted,
      state: "applied",
      reason: null,
      created_at: new Date().toISOString(),
    },
  };
}
