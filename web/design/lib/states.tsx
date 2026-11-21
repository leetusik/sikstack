"use client";

/**
 * The design's state widget: a small pill, fixed to the window's bottom left, that names the page and the
 * state on screen and opens to that page's states (and Reset). A state lives in the address (`?state=<key>`),
 * so it can be linked, reloaded and screenshotted; no `state` is the page's default. Usage, in a page's route:
 *
 *   const STATES = pageStates("Agenda", [
 *     { key: "recorded", label: "Recorded", from: "workspace/page.tsx:75", data: true },
 *     { key: "loading", label: "Loading", from: "workspace/loading.tsx" },
 *   ]);
 *   <StatePage states={STATES} implied={keyOfTheStoreNow} enter={putDataInPlace} reset={reset}>
 *     {(state, pick, query) => <Screen state={state} retry={() => pick("recorded")} query={query} />}
 *   </StatePage>
 *
 * List only states production draws for this page (`from` names the branch). A `data` state is the page's
 * data: `enter` puts it in place when the address names it (doing nothing when it is there already), and
 * `implied` (what the data is now) is shown as current, so a click on the design itself is never contradicted.
 * A preset never leaves the page.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import css from "./states.module.css";

export interface StateDef<K extends string> {
  key: K;
  /** The preset's words on the widget. */
  label: string;
  /** Where production draws it (a file and line, or a component), shown as the preset's tooltip. */
  from: string;
  /** The state is the page's data (the store), not a view over it. */
  data?: boolean;
}

export interface PageStates<K extends string> {
  page: string;
  list: readonly StateDef<K>[];
}

/** A page's states, typed by their keys; the first is the default. */
export function pageStates<const K extends string>(
  page: string,
  list: readonly StateDef<K>[],
): PageStates<K> {
  if (list.length === 0) throw new Error(`${page}: a page has at least one state`);
  return { page, list };
}

type Render<K extends string> = (
  state: K,
  pick: (key: K) => void,
  query: URLSearchParams | null,
) => ReactNode;

interface Props<K extends string> {
  states: PageStates<K>;
  /** The data state the page's data is in now, when it is one. */
  implied?: K | null;
  /** Put a data state's data in place (the address named it). */
  enter?: (key: K) => void;
  /** Put the design's data back; the widget then drops `state` from the address. */
  reset?: () => void;
  children: Render<K>;
}

/** The page in the state its address names, with the widget. The build draws the default. */
export function StatePage<K extends string>(props: Props<K>) {
  const fallback = props.implied ?? props.states.list[0].key;
  return (
    <Suspense
      fallback={
        <>
          {props.children(fallback, () => {}, null)}
          <StateWidget states={props.states} current={fallback} />
        </>
      }
    >
      <Addressed {...props} />
    </Suspense>
  );
}

function Addressed<K extends string>({ states, implied, enter, reset, children }: Props<K>) {
  const query = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const raw = query.get("state");
  const named = states.list.find((s) => s.key === raw) ?? null;

  // A data state the address names is put in place when the address comes to name it (`enter` decides
  // whether the data is already there).
  const enterRef = useRef(enter);
  useLayoutEffect(() => {
    enterRef.current = enter;
  });
  useLayoutEffect(() => {
    if (named?.data) enterRef.current?.(named.key);
  }, [named]);

  const fallback = implied ?? states.list[0].key;
  const current: K = named && !named.data ? named.key : implied ?? named?.key ?? fallback;

  const go = (next: URLSearchParams) => {
    const q = next.toString();
    router.replace(q ? `${path}?${q}` : path, { scroll: false });
  };
  const pick = (key: K) => {
    const next = new URLSearchParams(query.toString());
    next.set("state", key);
    // The address may name it already (a click on the design changed the data since): put it in place.
    if (raw === key && states.list.find((s) => s.key === key)?.data) enter?.(key);
    go(next);
  };
  const onReset = reset
    ? () => {
        reset();
        const next = new URLSearchParams(query.toString());
        next.delete("state");
        go(next);
      }
    : undefined;

  return (
    <>
      {children(current, pick, query)}
      <StateWidget states={states} current={current} pick={pick} reset={onReset} />
    </>
  );
}

function StateWidget<K extends string>({
  states,
  current,
  pick,
  reset,
}: {
  states: PageStates<K>;
  current: K;
  pick?: (key: K) => void;
  reset?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const root = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const now = states.list.find((s) => s.key === current) ?? states.list[0];

  // Escape or a click outside closes it; Escape gives the focus back to the pill.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      pill.current?.focus();
    };
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
    };
  }, [open]);

  return (
    // The pill comes first, so Tab goes from it into the open list; the list is drawn above it (CSS).
    <div ref={root} className={css.root} data-design-states="" aria-label="Design states" role="region">
      <button
        ref={pill}
        type="button"
        className={css.pill}
        aria-expanded={open}
        aria-controls={open ? panel : undefined}
        aria-label={`Design states: ${states.page}, ${now.label}`}
        title={`${states.page} · ${now.label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={css.tag}>
          <span className={css.long}>Design</span>
          <span className={css.short}>D</span>
        </span>
        <span className={css.page}>{states.page}</span>
        <span className={css.now}>{now.label}</span>
        <span className={css.chev} aria-hidden="true" />
      </button>
      {open ? (
        <div id={panel} className={css.panel}>
          <p className={css.caption}>Design only · states of this page</p>
          <div role="group" aria-label={`${states.page} states`} className={css.list}>
            {states.list.map((s) => (
              <button
                key={s.key}
                type="button"
                className={css.state}
                aria-pressed={s.key === current}
                title={s.from}
                data-design-state={s.key}
                onClick={() => pick?.(s.key)}
              >
                {s.label}
              </button>
            ))}
            {states.list.length === 1 ? <span className={css.note}>Only state</span> : null}
          </div>
          {reset ? (
            <button type="button" className={css.reset} data-design-reset="" onClick={reset}>
              Reset design data
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
