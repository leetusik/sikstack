"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";

import { PrintNotice } from "@/components/reader/print-sheet";
import { useLegacyReading } from "@/components/reader/use-legacy-reading";
import { READER_DOCUMENT } from "@/content/reader-document";
import { READER_FRAME } from "@/content/reader-frame";
import { READER_ORIGINAL } from "@/content/reader-original";
import {
  Bar,
  Display,
  nextSheet,
  Sheet,
  Versions,
  type Mark,
} from "@/sikstack/library";
import {
  cleanLabel,
  labelWire,
  removeBookmarkWire,
  undoClock,
  type UndoClock,
  type Wire,
} from "@/sikstack/reader/marks";
import { StateBlock } from "@/sikstack/states";
import { Legacy, UiRoot } from "@/sikstack/ui";
import { date } from "@/lib/format";
import { readBridgeMessage, restoreMessage } from "@/lib/legacy/messages";
import { withFrom } from "@/lib/library/from";
import { readerHomeHref } from "@/lib/library/way-out";
import { loginHref } from "@/lib/next-path";
import {
  readerCookieString,
  type ReaderSettings,
  type TextSize,
  type ThemeChoice,
} from "@/lib/reader-cookie";
import { readerHref, signInToSaveHref } from "@/lib/reader-href";
import { saveBookmark, type BookmarkResult } from "@/lib/reader/actions";
import { QUIET_MS } from "@/lib/reader/chrome";
import type { LegacyMark } from "@/lib/reader/load";
import { newId } from "@/lib/reader/notes";
import type { LegacyFrame, ReaderView, ReaderWrite } from "@/lib/reader/types";

import { versionItems } from "../model";
import { failedState, ReaderSegmentContext } from "../reader-states";
import { ReaderFoot } from "../reader-foot";
import { ReaderHead } from "../reader-head";
import { DocumentNotes, runBookmarkWire } from "./document-notes";
import { missingDocument } from "./document-states";
import {
  documentBack,
  hereAction,
  hereMarked,
  markOf,
  markPlace,
  readingOrder,
  type DocMark,
} from "./model";
import {
  docMarkOf,
  OriginalFrame,
  originalBookmarkWrite,
  originalScroll,
  originalTag,
  ORIGINAL_SCROLL,
  readerDark,
  type OriginalScroll,
} from "./original-parts";

// The frame's own ground (the document's page colour, light or its own dark), as the legacy reader painted it:
// `.lg-docframe` in the legacy reader's sheet, imported with the frame as that reader did (no other rule of it
// matches here: the rest name the legacy reader's own chrome and page, `.lg-page`, which this page has not).
import "@/app/legacy.css";

/** An html document has no sections the parent can read (the head draws no In this document). */
const NO_SECTIONS: readonly { id: string; title: string }[] = [];

/**
 * An html document in its **Original layout** (P63-fk.S13; job 03, Library round 02: `## Build` § Page: document,
 * the state Original layout; `Document.dc.html`, `d4`): the document page's frame around the html as it renders
 * today.
 *
 *   UiRoot > .page > .app.bare.reader[data-scheme][data-size]
 *     > Bar (the way back by `?from=`, the title once the head has left the window, the tag `Original layout`
 *       or `Older version`, Notes and Display; a visitor's Sign in). It never hides: the record keeps it on such
 *       a document (`reading` is the text's, and there is none).
 *     + .reader-frame > main.reader-main > article.reader-col
 *         > the paper notice (print only, `PrintNotice`, inside the old root it is styled by)
 *         > the head (`ReaderHead` with its `tag`)
 *         > .read-flow[data-original]: the sandboxed frame of the raw relay, the whole width of the window and
 *           its height under the bar, the document's only scroller (the record's stand-in)
 *     + ReaderFoot bar={false} (the pill alone, after a resume) + one sheet at a time (Notes, Version history,
 *       Display)
 *
 * No text column and no end (the record: "no text, no end"). The frame's file missing is Document not found and
 * its relay failing is Error, in the bar's frame (the document page's own states); while the frame loads, the
 * Loading state's paragraphs stand over it.
 *
 * Kept from the legacy reader, unchanged: the bridge (`readBridgeMessage`, `restoreMessage`: every message
 * checked, a `navigate` routed, one `restore` on load), the probe that tells a missing file from a failed relay,
 * the frame's quiet focus on a desktop and its ring by keyboard, and the reading memory (`useLegacyReading`: the
 * same writes, cadence, finish at the end and beacon). Its bookmarks are the document page's Notes sheet
 * (`DocumentNotes`), written with the legacy reader's own payload (`originalBookmarkWrite`).
 */
type SheetName = "notes" | "versions" | "display";
type Status = "loading" | "ready" | "missing" | "failed";

/** After the frame's `load`, how long the page waits for the bridge before asking the relay (unchanged). */
const HELLO_GRACE_MS = 1500;

const noSubscribe = () => () => {};

function hashAnchor(): string | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // keep it raw
  }
  return id.length > 0 && id.length <= 200 ? id : null;
}

const skel = (width: string) => <span className="skel" style={{ width }} />;

export interface DocumentOriginalProps {
  view: ReaderView;
  frame: LegacyFrame;
  /** The document's bookmarks (`LoadedLegacy.marks`). */
  marks?: readonly LegacyMark[];
  /** The raw `?from=` value: the list the reader came through. */
  from?: string | null;
  /** The org's slug (a visitor's way back). */
  org?: string | null;
  /** The org's display name, as the document's read names it (P63-fk.S26): the way back's label. */
  orgName?: string | null;
  nonce?: string;
  /** The viewer's zone, for dates (decision 5). */
  timeZone?: string;
}

export function DocumentOriginal({
  view,
  frame,
  marks = [],
  from = null,
  org = null,
  orgName = null,
  nonce,
  timeZone,
}: DocumentOriginalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const member = view.member;
  // P75: whether the org's public library reads for this reader (a link reader in an org with nothing Public:
  // no), from the route's segment; no: the wordmark and the way back lead to the sikstack home.
  const { orgLibrary } = useContext(ReaderSegmentContext);
  const target = view.target;
  const older = view.version < view.newest;

  const [settings, setSettings] = useState<ReaderSettings>(view.settings);
  const [os, setOs] = useState<"light" | "dark">("light");
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [status, setStatus] = useState<Status>(
    frame.missing ? "missing" : "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [failRef, setFailRef] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [pill, setPill] = useState(false);
  const [ring, setRing] = useState(false);
  const [showTitle, setShowTitle] = useState(false);
  const [barH, setBarH] = useState<number | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<SheetName | null>(null);
  /** The latest place the bridge reported (the Notes sheet's place on screen). */
  const placeRef = useRef<{ fraction: number; anchor: string | null }>({
    fraction: 0,
    anchor: null,
  });
  const scrollRef = useRef<OriginalScroll>(ORIGINAL_SCROLL);
  const quietUntil = useRef(0);
  /** This attempt has heard from the bridge. */
  const heard = useRef(false);
  /** The frame attempt now on screen; a probe for an earlier one is dropped. */
  const attemptRef = useRef(0);
  /** The restore to send once the bridge speaks; null = none. */
  const pendingRestore = useRef<{
    anchor?: string | null;
    fraction?: number | null;
  } | null>(null);

  const rd = useLegacyReading(view);
  const { sample } = rd;

  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);

  // What the device is now (System's readout, and the frame's colour scheme).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setOs(mq.matches ? "dark" : "light");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // The frame is created on the client only (never in the server html, which could load and speak before the
  // page hydrates); the message listener is a layout effect, in place before the frame can load.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );

  // ---- where to land: the link's place, or the member's resume (then the pill) -----------------------------
  useEffect(() => {
    const anchor = hashAnchor();
    const progress = view.progress;
    if (anchor) {
      pendingRestore.current = {
        anchor,
        fraction: progress?.resume?.fraction ?? null,
      };
      scrollRef.current = { ...scrollRef.current, landing: "quiet" };
      return;
    }
    const r = progress?.resume;
    if (r && progress?.state === "started" && view.version === view.newest) {
      pendingRestore.current = { anchor: r.block, fraction: r.fraction };
      scrollRef.current = { ...scrollRef.current, landing: "pill" };
    }
  }, [view.progress, view.version, view.newest]);

  // ---- loading: a load with no word from the bridge asks the relay (a missing file, or a failed relay) -----
  const probeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const onFrameLoad = useCallback(() => {
    if (heard.current) return;
    const mine = attemptRef.current;
    if (probeTimer.current) clearTimeout(probeTimer.current);
    probeTimer.current = setTimeout(async () => {
      if (heard.current) return;
      let next: Status = "failed";
      let ref: string | null = null;
      try {
        const res = await fetch(frame.src, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (res.status === 404) next = "missing";
        else if (res.ok) next = "ready";
        else {
          const type = res.headers.get("content-type") ?? "";
          if (type.includes("application/json")) {
            const body = (await res.json().catch(() => null)) as {
              ref?: unknown;
            } | null;
            if (
              body &&
              typeof body.ref === "string" &&
              /^lg-[0-9a-f]{8}$/.test(body.ref)
            ) {
              ref = body.ref;
            }
          }
        }
        if (res.ok) await res.body?.cancel().catch(() => {});
      } catch {
        next = "failed";
      }
      // A result for an earlier attempt is dropped.
      if (attemptRef.current === mine && !heard.current) {
        setStatus(next);
        setFailRef(ref);
      }
    }, HELLO_GRACE_MS);
  }, [frame.src]);
  useEffect(
    () => () => {
      if (probeTimer.current) clearTimeout(probeTimer.current);
    },
    [],
  );

  const retry = () => {
    heard.current = false;
    attemptRef.current += 1;
    setFailRef(null);
    setStatus("loading");
    setAttempt((a) => a + 1);
  };

  // ---- focus: quietly into the frame on a desktop; the ring only when focus came by keyboard ----------------
  const focusFrameQuietly = useCallback(() => {
    const el = frameRef.current;
    if (!el || sheetRef.current !== null) return;
    if (!window.matchMedia("(min-width: 64rem)").matches) return;
    const active = document.activeElement;
    if (active && active !== document.body && rootRef.current?.contains(active))
      return;
    setRing(false);
    el.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let lastTab = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Tab") lastTab = Date.now();
    };
    const onBlur = () => {
      // The window blurs as focus moves into the frame's document.
      window.setTimeout(() => {
        if (
          document.activeElement === frameRef.current &&
          Date.now() - lastTab < 150
        ) {
          setRing(true);
        }
      }, 0);
    };
    const clear = () => setRing(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", clear);
    document.addEventListener("focusin", clear);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", clear);
      document.removeEventListener("focusin", clear);
    };
  }, []);

  // ---- the frame under the bar ---------------------------------------------------------------------------
  /** The bar's bottom edge in the window. */
  const barBottom = useCallback(
    () =>
      rootRef.current
        ?.querySelector<HTMLElement>(".bar-wrap")
        ?.getBoundingClientRect().bottom ?? 0,
    [],
  );
  /** Bring the frame up to the bar, so the document has the window (the head scrolls away). */
  const frameToBar = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const gap = stage.getBoundingClientRect().top - barBottom();
    if (gap <= 1) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollBy({ top: gap, behavior: reduce ? "instant" : "smooth" });
  }, [barBottom]);

  // The bar's height sets the frame's (it wraps on a narrow window); the head leaving shows the bar's title.
  useEffect(() => {
    const wrap = rootRef.current?.querySelector<HTMLElement>(".bar-wrap");
    let frameId = 0;
    const measure = () => {
      frameId = 0;
      const bottom = barBottom();
      const head = rootRef.current?.querySelector<HTMLElement>(".read-head");
      const gone = head ? head.getBoundingClientRect().bottom <= bottom : false;
      setShowTitle((prev) => (prev === gone ? prev : gone));
    };
    const onScroll = () => {
      if (!frameId) frameId = requestAnimationFrame(measure);
    };
    const ro =
      wrap && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const h = Math.round(wrap.getBoundingClientRect().height);
            setBarH((prev) => (prev === h ? prev : h));
          })
        : null;
    if (wrap) ro?.observe(wrap);
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      ro?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [barBottom, status]);

  // ---- the bridge -------------------------------------------------------------------------------------------
  const postRestore = useCallback(
    (place: { anchor?: string | null; fraction?: number | null }) => {
      const win = frameRef.current?.contentWindow;
      if (!win) return;
      quietUntil.current = Date.now() + QUIET_MS;
      win.postMessage(restoreMessage(place), "*");
    },
    [],
  );

  const onScrollMessage = useCallback(
    (fraction: number, y: number, anchor: string | null) => {
      const quiet = Date.now() < quietUntil.current;
      const step = originalScroll(
        scrollRef.current,
        { fraction, y, anchor },
        quiet,
      );
      scrollRef.current = step.next;
      setPill((prev) => (prev === step.next.pill ? prev : step.next.pill));
      placeRef.current = step.sample;
      const next = Math.round(fraction * 100);
      setPct((prev) => (prev === next ? prev : next));
      sample(step.sample);
      if (step.down && sheetRef.current === null) frameToBar();
    },
    [sample, frameToBar],
  );

  useLayoutEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = readBridgeMessage(
        e.source,
        frameRef.current?.contentWindow ?? null,
        e.data,
      );
      if (!msg) return;
      if (msg.type === "navigate") {
        router.push(msg.path);
        return;
      }
      // A tap in the document: the bars never hide on such a document, so there is nothing to bring back.
      if (msg.type === "tap") return;
      if (!heard.current) {
        heard.current = true;
        if (probeTimer.current) clearTimeout(probeTimer.current);
        setStatus("ready");
        setFailRef(null);
        focusFrameQuietly();
        const want = pendingRestore.current;
        if (want) {
          pendingRestore.current = null;
          // The first word is the place before the restore; the next is where it landed.
          postRestore(want);
          return;
        }
      }
      onScrollMessage(msg.fraction, msg.y, msg.anchor);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router, focusFrameQuietly, postRestore, onScrollMessage]);

  // ---- settings and sheets ----------------------------------------------------------------------------------
  const apply = useCallback((next: ReaderSettings) => {
    setSettings(next);
    document.cookie = readerCookieString(
      next,
      window.location.protocol === "https:",
    );
  }, []);
  const openSheet = (name: SheetName) =>
    setSheet((s) => nextSheet<SheetName>(s, { type: "toggle", name }));
  const closeSheet = useCallback(
    (name?: SheetName) =>
      setSheet((s) => nextSheet<SheetName>(s, { type: "close", name })),
    [],
  );

  // ---- places -----------------------------------------------------------------------------------------------
  const ready = status === "ready";
  const signIn = signInToSaveHref(target, {
    lang: null,
    version: older ? view.version : null,
    section: null,
  });
  const back = documentBack({
    member,
    from,
    org,
    orgLibrary,
    names: { project: view.project, org: orgName },
  });
  const origin = back?.origin ?? null;
  const here = (version: number | null) =>
    withFrom(readerHref(target, { version }), from ? origin : null);
  const go = (href: string) => router.push(href);
  const homeHref = readerHomeHref({ member, org, orgLibrary });
  const fromTop = () => {
    scrollRef.current = { ...scrollRef.current, pill: false };
    setPill(false);
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    postRestore({ fraction: 0 });
  };
  const openMark = (m: { fraction: number; anchor: string | null }) => {
    closeSheet("notes");
    frameToBar();
    postRestore({ anchor: m.anchor, fraction: m.fraction });
  };

  const scheme = settings.theme === "system" ? undefined : settings.theme;
  const dark = readerDark(settings.theme, os);
  const where = READER_DOCUMENT.where(view.project);
  const notes: "bookmarks" | "none" =
    member && !view.write ? "none" : "bookmarks";
  const stageStyle =
    barH !== null
      ? ({ "--original-bar": `${barH}px` } as CSSProperties)
      : undefined;

  // ---- the frame's file missing, or its relay failing: the document page's own states -----------------------
  if (status === "missing" || status === "failed") {
    const state =
      status === "missing"
        ? missingDocument({
            member,
            back,
            signInHref: loginHref(pathname ?? "/"),
          })
        : failedState(member, failRef);
    return (
      <UiRoot nonce={nonce}>
        <div className="page">
          <div className="app bare">
            <Bar
              back={back?.label}
              backShort={back?.label}
              backHref={back?.href}
              homeHref={homeHref}
              viewer={member ? "member" : "visitor"}
              signInHref={loginHref(pathname ?? "/")}
            />
            <main className="app-main" id="main-content">
              <StateBlock state={state} onRetry={retry} />
            </main>
          </div>
        </div>
      </UiRoot>
    );
  }

  return (
    <UiRoot nonce={nonce}>
      <div className="page">
        <div
          ref={rootRef}
          className="app bare reader"
          data-scheme={scheme}
          data-size={settings.size}
          lang="en"
        >
          <Bar
            back={back?.label}
            backShort={back?.label}
            backHref={back?.href}
            homeHref={homeHref}
            title={view.title}
            meta={where}
            showTitle={showTitle}
            tag={originalTag(view.version, view.newest)}
            tools="notes ask display"
            viewer={member ? "member" : "visitor"}
            hidden={false}
            progress={ready ? pct : 0}
            signInHref={signIn}
            onOpen={(what) => {
              if (what === "notes" || what === "display") openSheet(what);
            }}
          />
          <div className="reader-frame">
            <main className="reader-main" id="main-content">
              <article
                className="reader-col"
                aria-busy={status === "loading" ? true : undefined}
              >
                {/* ⌘P prints this one sheet and nothing else (print only; `app/kb-print.css` part 3). */}
                <Legacy style={NO_BOX}>
                  <div className="rd-root" style={NO_BOX}>
                    <PrintNotice view={view} relay={frame.src} />
                  </div>
                </Legacy>
                <ReaderHead
                  noun="document"
                  title={view.title}
                  lang={view.lang}
                  where={where}
                  version={view.version}
                  newest={view.newest}
                  published={date(view.published || view.date, { timeZone })}
                  sections={NO_SECTIONS}
                  tag={READER_ORIGINAL.tag}
                  onVersions={() => openSheet("versions")}
                  onNewest={() => go(here(null))}
                />
                <div
                  ref={stageRef}
                  className="read-flow"
                  data-original=""
                  style={stageStyle}
                >
                  {mounted ? (
                    <OriginalFrame
                      key={attempt}
                      frameRef={frameRef}
                      src={frame.src}
                      title={view.title}
                      look={frame.look}
                      dark={dark}
                      ring={ring}
                      onLoad={onFrameLoad}
                    />
                  ) : null}
                  {status === "loading" ? (
                    <div data-original-state="">
                      <div
                        className="read"
                        style={{ gap: "var(--space-5)" }}
                        aria-hidden="true"
                      >
                        <p className="stack gap-3">
                          {skel("100%")}
                          {skel("100%")}
                          {skel("64%")}
                        </p>
                        <p className="stack gap-3">
                          {skel("100%")}
                          {skel("100%")}
                          {skel("100%")}
                          {skel("38%")}
                        </p>
                        <p className="stack gap-3">
                          {skel("100%")}
                          {skel("82%")}
                        </p>
                      </div>
                      <span className="sr-only" role="status">
                        {READER_DOCUMENT.loading}
                      </span>
                    </div>
                  ) : null}
                </div>
              </article>
            </main>
          </div>
          <ReaderFoot
            bar={false}
            pill={ready && member && pill && sheet === null}
            onTop={fromTop}
          />
          <Sheet
            open={sheet === "notes"}
            title={READER_FRAME.sheets.notes}
            onClose={() => closeSheet("notes")}
          >
            {notes === "bookmarks" ? (
              <OriginalBookmarks
                open={sheet === "notes"}
                initial={marks}
                member={member}
                write={view.write}
                version={view.version}
                lang={view.lang}
                place={() =>
                  ready ? placeRef.current : { fraction: 0, anchor: null }
                }
                signInHref={signIn}
                onOpen={openMark}
              />
            ) : null}
          </Sheet>
          <Sheet
            open={sheet === "versions"}
            title={READER_FRAME.sheets.versionHistory}
            side="end"
            onClose={() => closeSheet("versions")}
          >
            <Versions
              versions={versionItems(view.versions, { timeZone })}
              reading={view.version}
              failed={view.versions ? !view.versions.ok : true}
              onView={(n) => {
                closeSheet("versions");
                go(here(n === view.newest ? null : n));
              }}
              onRetry={() => router.refresh()}
            />
          </Sheet>
          <Sheet
            open={sheet === "display"}
            title={READER_FRAME.sheets.display}
            side="end"
            onClose={() => closeSheet("display")}
          >
            <Display
              size={settings.size}
              theme={settings.theme}
              deviceScheme={os}
              onSize={(size) => apply({ ...settings, size: size as TextSize })}
              onTheme={(theme) =>
                apply({ ...settings, theme: theme as ThemeChoice })
              }
            />
          </Sheet>
        </div>
      </div>
    </UiRoot>
  );
}

/** The print notice's old root and its boundary add no box on screen: the notice is `.pp-only`. */
const NO_BOX: CSSProperties = { display: "contents" };

/**
 * An html document's bookmarks, the body of its Notes sheet (`DocumentNotes`, as on a Markdown document): made at
 * the place the bridge last reported (**Bookmark this position**; **Bookmarked here** within the legacy
 * reader's own window), labelled, removed with the row's undo line (sent when its ten seconds pass, when the
 * sheet closes, or on leaving). Each write is the legacy reader's: `saveBookmark` with its payload
 * (`originalBookmarkWrite`), `removeBookmark({id})`; a label is the existing `editBookmark`. A row's first line
 * lands the document at the bookmark (the bridge's `restore`).
 */
export function OriginalBookmarks({
  open,
  initial,
  member,
  write,
  version,
  lang,
  place,
  signInHref,
  onOpen,
  save = saveBookmark,
  send = runBookmarkWire,
}: {
  open: boolean;
  initial: readonly LegacyMark[];
  member: boolean;
  write: ReaderWrite | null;
  version: number;
  lang: string;
  /** The place on screen: the bridge's last `{fraction, anchor}`. */
  place: () => { fraction: number; anchor: string | null };
  signInHref: string;
  onOpen: (m: { fraction: number; anchor: string | null }) => void;
  save?: typeof saveBookmark;
  send?: (w: Wire) => Promise<BookmarkResult>;
}) {
  const [marks, setMarks] = useState<LegacyMark[]>(() => [...initial]);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [fraction, setFraction] = useState(0);
  const [asking, setAsking] = useState(false);
  const clock = useRef<UndoClock | null>(null);
  if (clock.current === null) clock.current = undoClock();
  const sent = useRef(new Map<string, Promise<void>>());
  const placeRef = useRef(place);
  useEffect(() => {
    placeRef.current = place;
  });

  // The place on screen, read as the sheet opens (the document does not scroll under an open sheet).
  useEffect(() => {
    if (!open) return;
    setFraction(placeRef.current().fraction);
    setAsking(false);
  }, [open]);

  // A removed bookmark is gone when the sheet closes, and on leaving the page.
  useEffect(() => {
    if (!open) clock.current?.flush();
  }, [open]);
  useEffect(() => () => clock.current?.flush(), []);

  const docMarks = useMemo<DocMark[]>(() => marks.map(docMarkOf), [marks]);
  const live = useMemo(
    () => docMarks.filter((m) => !pending[m.id]),
    [docMarks, pending],
  );
  const rows = useMemo(
    () =>
      readingOrder(docMarks, []).map((m) => ({
        mark: markOf(m),
        place: markPlace(m, () => null),
      })),
    [docMarks],
  );
  const here = { kind: "position" as const, section: null, fraction };

  const bookmark = () => {
    if (!member) {
      setAsking(true);
      return;
    }
    if (!write) return;
    const p = place();
    const id = newId();
    setMarks((list) => [
      ...list,
      {
        id,
        fraction: p.fraction,
        anchor: p.anchor,
        label: "",
        lang,
        version,
      },
    ]);
    setFraction(p.fraction);
    void save(originalBookmarkWrite({ write, id, version, place: p })).then(
      (r) => {
        if (!r.ok) setMarks((list) => list.filter((m) => m.id !== id));
      },
    );
  };

  const label = (id: string, text: string) => {
    const before = marks.find((m) => m.id === id)?.label ?? "";
    const clean = cleanLabel(text);
    if (clean === before) return;
    const put = (value: string) =>
      setMarks((list) =>
        list.map((m) => (m.id === id ? { ...m, label: value } : m)),
      );
    put(clean);
    void send(labelWire(id, clean)).then((r) => {
      if (!r.ok) put(before);
    });
  };

  const remove = (id: string) => {
    setPending((p) => ({ ...p, [id]: true }));
    clock.current?.start(id, () => {
      const done = send(removeBookmarkWire(id)).then((r) => {
        if (!r.ok) throw new Error("not removed");
        setMarks((list) => list.filter((m) => m.id !== id));
        setPending((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
      });
      sent.current.set(id, done);
      done.catch(() => {});
    });
  };

  const undo = (id: string) => {
    clock.current?.undo(id);
    setPending((p) => {
      const next = { ...p };
      delete next[id];
      return next;
    });
  };

  const gone = (id: string) => {
    clock.current?.fire(id);
    return sent.current.get(id);
  };

  const openMark = (m: Mark) => {
    const mark = marks.find((x) => x.id === m.id);
    if (mark) onOpen({ fraction: mark.fraction, anchor: mark.anchor });
  };

  return (
    <DocumentNotes
      count={READER_DOCUMENT.notes.count(live.length)}
      action={hereAction(here)}
      hereMarked={member && hereMarked(here, live)}
      asking={asking}
      rows={rows}
      placeLang={lang}
      signInHref={signInHref}
      onBookmark={bookmark}
      onOpen={openMark}
      onLabel={label}
      onDelete={remove}
      onUndo={undo}
      onGone={gone}
      onDismiss={() => setAsking(false)}
    />
  );
}
