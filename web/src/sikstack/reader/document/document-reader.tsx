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
  type MouseEvent,
  type ReactNode,
} from "react";

import { NotesBridgeContext } from "@/components/reader/reader-notes";
import {
  ReaderProgressContext,
  type ReaderProgressValue,
} from "@/components/reader/reader-progress";
import { useHashLanding } from "@/components/reader/use-hash-landing";
import { useReading } from "@/components/reader/use-reading";
import { READER_DOCUMENT } from "@/content/reader-document";
import { READER_FRAME } from "@/content/reader-frame";
import { Bar, Display, nextSheet, Sheet, Versions } from "@/sikstack/library";
import {
  ListenHeadSlot,
  ListenPlayerSheet,
  listenShown,
  ListenTrack,
  useFollow,
} from "@/sikstack/listen";
import { UiRoot } from "@/sikstack/ui";
import { date } from "@/lib/format";
import { withFrom } from "@/lib/library/from";
import { readerHomeHref } from "@/lib/library/way-out";
import { unitOfKey } from "@/lib/listen/book";
import { useListen } from "@/lib/listen/store";
import type { ListenSeed } from "@/lib/listen/types";
import {
  readerCookieString,
  type ReaderSettings,
  type TextSize,
  type ThemeChoice,
} from "@/lib/reader-cookie";
import { readerHref, signInToSaveHref } from "@/lib/reader-href";
import { QUIET_MS, TAP_IGNORE } from "@/lib/reader/chrome";
import type { ReaderView } from "@/lib/reader/types";

import {
  chromeOf,
  endState,
  pillAfterScroll,
  quietBars,
  readerBars,
  scrollBars,
  sectionsOf,
  showBars,
  versionItems,
} from "../model";
import { useLayerHolder, useReaderTopBar, useSlotLift } from "../frame-measure";
import { OldBodyContext, type OldBodyValue } from "../old-root";
import { ReaderEnd } from "../reader-end";
import { ReaderFoot } from "../reader-foot";
import { ReaderHead } from "../reader-head";
import { ReaderSegmentContext } from "../reader-states";
import { slotOf, slotWants } from "../slot";
import { DocumentBookmarks } from "./document-notes";
import type { ItemShare, ShareTarget } from "@/lib/sharing/model";
import { ShareControl } from "@/sikstack/reader/share-control";

import { DocumentPhases } from "./document-phases";
import {
  documentBack,
  foldSections,
  type DocMark,
  type DocPhaseRow,
  type DocumentMarks,
} from "./model";

/**
 * The reader on a loose document (job 03, Library round 02: `## Build` § Page: document, § The frame;
 * `Document.dc.html`; frame.md F52, F61, F64, F68, F100, F324, F328):
 *
 *   UiRoot > .page > .app.bare.reader[data-scheme][data-size]
 *     > Bar (the way back by `?from=`, the title and `Document in <project>` once the head has left the window,
 *       Older version, Notes and Display; never Ask, decision 3)
 *     + .reader-frame > main.reader-main > article.reader-col > ReaderHead (noun document, sections folded
 *       past six), .read-flow (the text), ReaderEnd kind="document", then the way back to the phases the
 *       document was explained from (`DocumentPhases`, a member's, when the read names any; P61-e9)
 *     + ReaderFoot bar={false} (the pill alone) + one sheet at a time (Notes, Version history, Display)
 *
 * Listen (P64-3y.S6; job 07 round 01, `## Build` › Listen, F206 to F211, listen:FG1, FG8): AudioHead in
 * ReaderHead's slot (`ListenHeadSlot`, the document's three tallest notes held: preparing stopped, the daily limit,
 * offline stopped), follow along, the dock's track before ReaderFoot (16 px from the foot: a document has no foot
 * bar), Listen's pill once the head's control is under the top bar, and the player's document form (no
 * Previous/Next, no Chapters, the head's `Document in <project>`). A member on the newest version only, with the
 * page's seed (`documentListen`); the html original is another frame and has none.
 *
 * No `aside.reader-side` (Ask waits for P68-jf).
 * The marks follow the document's format (OQ14, `./model` `documentMarks`): a Markdown document's Notes
 * sheet is `DocumentBookmarks` (bookmarks only); a native one's is the annotation layer's own body, mounted by
 * the text (`ChapterBody`) through the notes bridge, as a chapter's is.
 *
 * The reader's memory is the product's own and unchanged (`useReading`, `useHashLanding`, the `kb_reader`
 * cookie), as on a chapter.
 */
type SheetName = "notes" | "versions" | "display";

export interface DocumentReaderProps {
  view: ReaderView;
  marks: DocumentMarks;
  /** A Markdown document's bookmarks (`marks` = `bookmarks`). */
  bookmarks?: readonly DocMark[];
  /** The raw `?from=` value: the list the reader came through. */
  from?: string | null;
  /** The org's slug, from the document's address (a visitor's way back). */
  org?: string | null;
  /** The org's display name, as the document's read names it (P63-fk.S26): the way back's label. */
  orgName?: string | null;
  nonce?: string;
  /** The viewer's zone, for dates (decision 5). */
  timeZone?: string;
  /** The document's Listen seed, read by the page (`documentListen`); null: no Listen here. */
  listen?: ListenSeed | null;
  /** The phases the document was explained from (`phaseRows`, `withDocumentPhases`); none: nothing shows. */
  phases?: readonly DocPhaseRow[];
  /** A member's sharing switch for this document (P75, `withDocumentShare`); absent: nothing shows. */
  share?: { target: ShareTarget; share: ItemShare } | null;
  // The text (`ChapterBody`).
  children?: ReactNode;
}

export function DocumentReader({
  view,
  marks,
  bookmarks = [],
  from = null,
  org = null,
  orgName = null,
  nonce,
  timeZone,
  listen = null,
  phases = [],
  share = null,
  children,
}: DocumentReaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const target = view.target;
  const member = view.member;
  // P75: whether the org's public library reads for this reader (a link reader in an org with nothing Public:
  // no), from the route's segment; no: the wordmark and the way back lead to the sikstack home.
  const { orgLibrary } = useContext(ReaderSegmentContext);

  const [settings, setSettings] = useState<ReaderSettings>(view.settings);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [hidden, setHidden] = useState(false);
  const [pct, setPct] = useState(0);
  const [section, setSection] = useState<string | null>(null);
  const [os, setOs] = useState<"light" | "dark">("light");
  const [asking, setAsking] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [showTitle, setShowTitle] = useState(false);
  const [notesHost, setNotesHost] = useState<HTMLElement | null>(null);
  const [slotHost, setSlotHost] = useState<HTMLElement | null>(null);
  const [past, setPast] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLElement | null>(null);
  const bars = useRef(readerBars(0));
  const sheetRef = useRef<SheetName | null>(null);
  const listenHeadRef = useRef<HTMLDivElement | null>(null);
  const setListenHead = useCallback((el: HTMLDivElement | null) => {
    listenHeadRef.current = el;
  }, []);

  const quiet = useCallback(() => {
    bars.current = quietBars(bars.current, Date.now(), QUIET_MS);
  }, []);

  // P64-3y.F4: the top bar's real height (`--reader-top-h`), written before the page's landings run.
  const topH = useReaderTopBar(rootRef);
  useLayoutEffect(() => {
    topRef.current =
      rootRef.current?.querySelector<HTMLElement>(".bar-wrap > .bar") ?? null;
  }, []);

  const rd = useReading({ view, ready: true, rootRef, topRef, quiet });
  useHashLanding({
    ready: true,
    place: `${pathname}|${view.lang}|${view.version}`,
    rootRef,
    quiet,
  });
  const { dismissPill } = rd;
  const pillRef = useRef(false);
  useEffect(() => {
    pillRef.current = !!rd.pill;
  }, [rd.pill]);
  useEffect(() => {
    sheetRef.current = sheet;
  }, [sheet]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setOs(mq.matches ? "dark" : "light");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // ---- the bars, the line, the section being read and the bar's title, on the window's scroll -----------
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const now = Date.now();
      setPct((prev) => {
        const next =
          max > 0 ? Math.round((100 * Math.min(Math.max(y, 0), max)) / max) : 0;
        return next === prev ? prev : next;
      });
      const moved = y !== bars.current.last;
      const step = scrollBars(bars.current, {
        y,
        max,
        now,
        sheetOpen: sheetRef.current !== null,
      });
      bars.current = step;
      setHidden((prev) => (prev === step.hidden ? prev : step.hidden));
      if (
        pillRef.current &&
        !pillAfterScroll(true, { moved, now, quietUntil: step.quietUntil })
      ) {
        pillRef.current = false;
        dismissPill();
      }
      const bottom = topRef.current?.getBoundingClientRect().bottom ?? 57;
      const line = bottom + 16 + 8;
      let found: string | null = null;
      rootRef.current
        ?.querySelectorAll<HTMLElement>("[data-reader-article] :is(h2, h3)[id]")
        .forEach((h) => {
          if (h.getBoundingClientRect().top <= line) found = h.id;
        });
      setSection((prev) => (prev === found ? prev : found));
      // The bar shows the title once `.read-head` has left the window.
      const head = rootRef.current?.querySelector<HTMLElement>(".read-head");
      const gone = head ? head.getBoundingClientRect().bottom <= bottom : false;
      setShowTitle((prev) => (prev === gone ? prev : gone));
      // Listen's pill (F207): once the head's control is under the top bar.
      const slot = listenHeadRef.current;
      const isPast = slot
        ? slot.getBoundingClientRect().bottom <= bottom
        : false;
      setPast((prev) => (prev === isPast ? prev : isPast));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const onLink = (e: Event) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && a.getAttribute("href")?.startsWith("#")) quiet();
    };
    if (window.location.hash) quiet();
    bars.current = { ...bars.current, last: window.scrollY };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("hashchange", quiet);
    window.addEventListener("reader:quiet", quiet);
    document.addEventListener("click", onLink, true);
    document.fonts?.ready.then(onScroll).catch(() => {});
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("hashchange", quiet);
      window.removeEventListener("reader:quiet", quiet);
      document.removeEventListener("click", onLink, true);
    };
  }, [quiet, dismissPill, settings.size]);

  const show = useCallback(() => {
    bars.current = showBars(bars.current);
    setHidden(false);
  }, []);

  const onTap = (e: MouseEvent<HTMLElement>) => {
    if (sheet !== null) return;
    if ((e.target as Element).closest(TAP_IGNORE)) return;
    if (window.getSelection()?.toString()) return;
    show();
  };

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

  // ---- places --------------------------------------------------------------------------------------------
  const older = view.version < view.newest;
  const signIn = signInToSaveHref(target, {
    lang: null,
    version: older ? view.version : null,
    section,
  });
  const back = documentBack({
    member,
    from,
    org,
    orgLibrary,
    names: { project: view.project, org: orgName },
  });
  const origin = back?.origin ?? null;
  const go = (href: string) => router.push(href);
  const here = (version: number | null) =>
    withFrom(readerHref(target, { version }), from ? origin : null);
  const toSection = (id: string) => {
    closeSheet();
    const el = document.getElementById(id);
    if (!el || !rootRef.current?.contains(el)) return;
    quiet();
    el.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const fromTop = () => {
    quiet();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    pillRef.current = false;
    dismissPill();
  };

  // ---- what the body's parts read from the frame ---------------------------------------------------------
  const progressValue = useMemo<ReaderProgressValue>(
    () => ({
      member,
      saves: rd.saves,
      state: rd.state,
      signInHref: signIn,
      mark: (finished: boolean) => void rd.mark(finished),
      rows: [],
      finishedCount: null,
    }),
    [member, rd, signIn],
  );
  const pill = !!rd.pill;
  const layer = marks === "layer";
  const notesBridge = useMemo(
    () => ({
      open: sheet === "notes",
      host: sheet === "notes" && layer ? notesHost : null,
      setCount: () => {},
      close: () => closeSheet("notes"),
      sheetOpen: sheet !== null,
      pillUp: pill,
      bookHref: null,
      slot: slotHost,
      barsHidden: hidden,
    }),
    [sheet, layer, notesHost, closeSheet, pill, slotHost, hidden],
  );
  // The frame re-renders when the Listen store changes (a Listen docking or leaving), so `useSlotLift` below
  // measures the dock coming and going after that render; nothing else here reads the store.
  useListen();
  const oldBody = useMemo<OldBodyValue>(
    () => ({ settings, topH }),
    [settings, topH],
  );
  useFollow(rootRef, listen ? unitOfKey(listen.key) : null, null);
  // F206: no Listen for a visitor or an older version of the text.
  const audioOn = listenShown({
    member,
    version: view.version,
    newest: view.newest,
    seed: listen,
  });
  // The one slot above the foot (F93, F207; P64-3y.F4, `../slot`): one holder at a time, in its order (the layer's
  // undo line and Sign in to save, the reader's resume pill or the layer's place bar, then Listen's pill, which
  // wants the head's control under the top bar and no sheet open). The holder stands on the dock while a Listen
  // is under way (F208).
  const layerHolder = useLayerHolder(slotHost);
  const holder = slotOf(
    slotWants({
      layer: layerHolder,
      resume: pill,
      listen: audioOn && past && sheet === null,
    }),
  );
  useSlotLift(rootRef);

  // ---- the parts ------------------------------------------------------------------------------------------
  const chrome = chromeOf({ hidden, pct, pill });
  const scheme = settings.theme === "system" ? undefined : settings.theme;
  const state = endState({ member, saves: rd.saves, state: rd.state });
  const sections = useMemo(() => sectionsOf(view.headings), [view.headings]);
  const folded = foldSections(sections, tocOpen);
  const titles = useMemo(
    () => new Map(view.headings.map((h) => [h.id, h.text])),
    [view.headings],
  );
  const sectionTitle = useCallback(
    (id: string) => titles.get(id) ?? null,
    [titles],
  );
  const sectionOrder = useMemo(() => sections.map((s) => s.id), [sections]);
  const fmt = { timeZone };
  const where = READER_DOCUMENT.where(view.project);
  const homeHref = readerHomeHref({ member, org, orgLibrary });

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
            tag={older ? READER_FRAME.tag.olderVersion : undefined}
            tools="notes ask display"
            viewer={member ? "member" : "visitor"}
            hidden={chrome.bar.hidden}
            progress={chrome.bar.progress}
            signInHref={signIn}
            onOpen={(what) => {
              if (what === "notes" || what === "display") openSheet(what);
            }}
            onBars={(h) => {
              if (!h) show();
            }}
          />
          <ReaderProgressContext.Provider value={progressValue}>
            <NotesBridgeContext.Provider value={notesBridge}>
              <OldBodyContext.Provider value={oldBody}>
                <div className="reader-frame">
                  <main
                    className="reader-main"
                    id="main-content"
                    onClick={onTap}
                  >
                    <article className="reader-col">
                      <ReaderHead
                        noun="document"
                        title={view.title}
                        lede={view.summary}
                        lang={view.lang}
                        where={where}
                        version={view.version}
                        newest={view.newest}
                        published={date(view.published || view.date, fmt)}
                        sections={folded.shown}
                        audio={
                          audioOn && listen ? (
                            <ListenHeadSlot
                              seed={listen}
                              signInHref={signIn}
                              onHead={setListenHead}
                            />
                          ) : null
                        }
                        fold={
                          folded.fold
                            ? {
                                ...folded.fold,
                                onToggle: () => setTocOpen((o) => !o),
                              }
                            : null
                        }
                        onVersions={() => openSheet("versions")}
                        onNewest={() => go(here(null))}
                        onSection={toSection}
                      />
                      <div className="read-flow">{children}</div>
                      <ReaderEnd
                        kind="document"
                        state={state}
                        asking={asking}
                        backLabel={
                          back ? READER_DOCUMENT.backTo(back.label) : undefined
                        }
                        signInHref={signIn}
                        onFinish={() => void rd.mark(true)}
                        onUnread={() => void rd.mark(false)}
                        onLibrary={() => go(back?.href ?? homeHref)}
                        onAsk={() => setAsking(true)}
                        onDismiss={() => setAsking(false)}
                      />
                      <DocumentPhases rows={phases} />
                      {share ? (
                        <ShareControl
                          target={share.target}
                          share={share.share}
                        />
                      ) : null}
                    </article>
                  </main>
                </div>
                {layer ? (
                  <div className="marks-slot" data-an-ui="" ref={setSlotHost} />
                ) : null}
                {/* The opened player (F211, listen:FG8): a document's form, its meta line the head's. */}
                <ListenPlayerSheet signInHref={signIn} docWhere={where} />
              </OldBodyContext.Provider>
            </NotesBridgeContext.Provider>
          </ReaderProgressContext.Provider>
          {/* The dock's track (F208, listen:FG1): before ReaderFoot, 16 px from the foot (no foot bar). */}
          <ListenTrack
            seed={audioOn ? listen : null}
            shown={audioOn}
            pill={holder === "listen"}
            chapter={false}
            hidden={chrome.foot.hidden}
            signInHref={signIn}
          />
          <ReaderFoot
            bar={false}
            hidden={chrome.foot.hidden}
            pill={chrome.foot.pill && holder === "resume"}
            onTop={fromTop}
          />
          <Sheet
            open={sheet === "notes"}
            title={READER_FRAME.sheets.notes}
            onClose={() => closeSheet("notes")}
          >
            {layer ? <div ref={setNotesHost} /> : null}
            {marks === "bookmarks" ? (
              <DocumentBookmarks
                open={sheet === "notes"}
                initial={bookmarks}
                member={member}
                write={view.write}
                version={view.version}
                lang={view.lang}
                rootRef={rootRef}
                sectionTitle={sectionTitle}
                sectionOrder={sectionOrder}
                signInHref={signIn}
                onClose={() => closeSheet("notes")}
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
              versions={versionItems(view.versions, fmt)}
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
