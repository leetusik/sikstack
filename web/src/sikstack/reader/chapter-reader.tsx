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
import { READER_FRAME } from "@/content/reader-frame";
import {
  Bar,
  Display,
  nextSheet,
  ReaderChapters,
  Sheet,
  Versions,
  type BarTool,
} from "@/sikstack/library";
import {
  ListenHeadSlot,
  ListenPlayerSheet,
  listenShown,
  ListenTrack,
  useFollow,
} from "@/sikstack/listen";
import { UiRoot } from "@/sikstack/ui";
import { date } from "@/lib/format";
import { withFrom, type ListOrigin } from "@/lib/library/from";
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
import {
  bookNotesHref,
  LIBRARY_HREF,
  readerHref,
  signInToSaveHref,
} from "@/lib/reader-href";
import { QUIET_MS, TAP_IGNORE } from "@/lib/reader/chrome";
import type { ChapterRow, ReaderView } from "@/lib/reader/types";

import {
  chapterItems,
  chromeOf,
  currentSection,
  endRowsShown,
  endState,
  pillAfterScroll,
  quietBars,
  readerBars,
  scrollBars,
  sectionsOf,
  showBars,
  versionItems,
} from "./model";
import { useLayerHolder, useReaderTopBar, useSlotLift } from "./frame-measure";
import { OldBodyContext, type OldBodyValue } from "./old-root";
import { ReaderEnd } from "./reader-end";
import { ReaderFoot } from "./reader-foot";
import { ReaderHead } from "./reader-head";
import { ReaderSegmentContext } from "./reader-states";
import { slotOf, slotWants } from "./slot";

/**
 * The reader's frame on a chapter (job 03, Library round 02: `## Build` § The frame, § Page: chapter;
 * frame.md F52, F53, F59, F61 to F64, F89, F93, F94, F100, F327):
 *
 *   UiRoot > .page > .app.bare.reader[data-scheme][data-size]
 *     > Bar (outside the Shell, the way back to the book, Notes and Display; never Ask, decision 3)
 *     + .reader-frame > main.reader-main > article.reader-col > ReaderHead, .read-flow (the text), ReaderEnd
 *     + ReaderFoot + one sheet at a time (Contents, Notes, Version history, Display)
 *
 * No `aside.reader-side`: the assistant's panel is not built until P68-jf.
 *
 * The bars hide together past 80 px down and come back near the top, at the end, after 64 px up, on a tap
 * on the text and from Show reading controls (`./model`); the progress line stays. The reader's own moves
 * (the landing at a kept place, a jump to a section, From the top) never hide them.
 *
 * The reader's memory is the product's own and unchanged: `useReading` (the landing and the resume at
 * the kept block or fraction, the position cadence and the beacon, reaching the end, Mark as finished and
 * Mark as unread through `saveReaderPosition`) and `useHashLanding`. The display settings are the
 * `kb_reader` cookie, written as before. The text arrives as `children` (`./body`, P63-fk.S9).
 */
type SheetName = "contents" | "notes" | "versions" | "display";

export interface ChapterReaderProps {
  view: ReaderView;
  /** The annotation layer is mounted (its Notes list fills the Notes sheet's body). */
  notes?: boolean;
  listen?: ListenSeed | null;
  /** The list the reader came through (F328), carried to the book and the next chapter. */
  from?: ListOrigin | null;
  nonce?: string;
  /** The viewer's zone, for dates (decision 5). */
  timeZone?: string;
  children: ReactNode;
}

export function ChapterReader({
  view,
  notes = false,
  listen = null,
  from = null,
  nonce,
  timeZone,
  children,
}: ChapterReaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const book = view.book;
  const target = view.target;
  const member = view.member;
  // P75: a link reader in an org with nothing Public goes home to sikstack, not to "Library not found".
  const { orgLibrary } = useContext(ReaderSegmentContext);

  const [settings, setSettings] = useState<ReaderSettings>(view.settings);
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [hidden, setHidden] = useState(false);
  const [pct, setPct] = useState(0);
  const [section, setSection] = useState<string | null>(null);
  const [os, setOs] = useState<"light" | "dark">("light");
  const [asking, setAsking] = useState(false);
  const [notesHost, setNotesHost] = useState<HTMLElement | null>(null);
  // The marks' bottom slot (P63-fk.S11): the undo line, Sign in to save and the place bar, above the foot bar.
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
  // The top bar, for the reader's memory: its bottom edge is the line a place is sampled at. Set before
  // `useReading`'s own effects run (a layout effect runs first).
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

  // What the device is now, for Display's System line.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setOs(mq.matches ? "dark" : "light");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // ---- the bars, the line and the section being read, on the window's scroll -------------------
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
      // The reader's first scroll drops the pill; the landing, a resize or a late font do not.
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
      const head = listenHeadRef.current;
      const isPast = head
        ? head.getBoundingClientRect().bottom <= bottom
        : false;
      setPast((prev) => (prev === isPast ? prev : isPast));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // The reader's own scrolls (an in-page link, the annotation layer's and the terms' moves) are not
    // gestures, as before.
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

  // A tap on the text brings the bars back (a tap on a control, a selection, never).
  const onTap = (e: MouseEvent<HTMLElement>) => {
    if (sheet !== null) return;
    if ((e.target as Element).closest(TAP_IGNORE)) return;
    if (window.getSelection()?.toString()) return;
    show();
  };

  // ---- display: applied at once, kept on this device (the `kb_reader` cookie) -----------------
  const apply = useCallback((next: ReaderSettings) => {
    setSettings(next);
    document.cookie = readerCookieString(
      next,
      window.location.protocol === "https:",
    );
  }, []);

  // ---- sheets: one at a time ---------------------------------------------------------------------
  const openSheet = (name: SheetName) =>
    setSheet((s) => nextSheet<SheetName>(s, { type: "toggle", name }));
  const closeSheet = useCallback(
    (name?: SheetName) =>
      setSheet((s) => nextSheet<SheetName>(s, { type: "close", name })),
    [],
  );

  // ---- places ------------------------------------------------------------------------------------
  const hasLangs = view.langs.length > 1;
  const older = view.version < view.newest;
  const place = {
    lang: hasLangs ? view.lang : null,
    version: older ? view.version : null,
    section,
  };
  const signIn = signInToSaveHref(target, place);
  const go = (href: string) => router.push(href);
  const carry = (href: string) => withFrom(href, from);
  const bookHrefNow = book ? carry(book.backHref) : LIBRARY_HREF;

  // A language opens that language's newest text at the same section; a member's pending place is
  // written first (the server maps it onto the other language), as before.
  const switchTo = async (lang: string) => {
    if (lang === view.lang) return;
    await rd.flush();
    go(carry(readerHref(target, { lang, section })));
  };
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

  // ---- the chapter list as it reads now (the current row follows the reader's finish and unread) --
  const baseFinished = view.progress?.state === "finished";
  const rows = useMemo<ChapterRow[]>(() => {
    if (!book) return [];
    if (!rd.saves) return book.chapters;
    const st = rd.reading;
    const opened =
      view.progress?.state !== "unopened" || view.version === view.newest;
    return book.chapters.map((row) => {
      if (!row.current) return row;
      if (st.finished)
        return {
          ...row,
          state: "finished",
          percent: undefined,
          updated: rd.updated,
        };
      if (!opened) return row;
      return {
        ...row,
        state: "started",
        percent: Math.round(st.maxFraction * 100),
        updated: false,
      };
    });
  }, [
    book,
    rd.saves,
    rd.reading,
    rd.updated,
    view.progress,
    view.version,
    view.newest,
  ]);
  const finishedCount =
    book && book.finished !== null
      ? Math.max(
          0,
          book.finished +
            (rd.saves
              ? (rd.reading.finished ? 1 : 0) - (baseFinished ? 1 : 0)
              : 0),
        )
      : null;
  const items = useMemo(() => chapterItems(rows, member), [rows, member]);
  const currentKey = rows.find((r) => r.current)?.key;
  const openChapter = (id: string) => {
    closeSheet();
    const row = rows.find((r) => r.key === id);
    if (row) go(carry(row.href));
  };

  // ---- what the old body's parts read from the frame (unchanged contracts) ---------------------
  const progressValue = useMemo<ReaderProgressValue>(
    () => ({
      member,
      saves: rd.saves,
      state: rd.state,
      signInHref: signIn,
      mark: (finished: boolean) => void rd.mark(finished),
      rows,
      finishedCount,
    }),
    [member, rd, signIn, rows, finishedCount],
  );
  const pill = !!rd.pill;
  const notesBookHref =
    target.kind === "chapter"
      ? bookNotesHref(target, {
          from: "chapter",
          chapter: target.chapter,
          lang: hasLangs ? view.lang : null,
          version: older ? view.version : null,
          section,
        })
      : null;
  const notesBridge = useMemo(
    () => ({
      open: sheet === "notes",
      host: sheet === "notes" ? notesHost : null,
      setCount: () => {},
      close: () => closeSheet("notes"),
      sheetOpen: sheet !== null,
      pillUp: pill,
      bookHref: notesBookHref,
      slot: slotHost,
      barsHidden: hidden,
    }),
    [sheet, notesHost, closeSheet, pill, notesBookHref, slotHost, hidden],
  );
  // The frame re-renders when the Listen store changes (a Listen docking or leaving), so `useSlotLift` below
  // measures the dock coming and going after that render; nothing else here reads the store.
  useListen();
  const listenUnit = listen ? unitOfKey(listen.key) : null;
  useFollow(rootRef, listenUnit, listen?.chapter ?? null);
  // F206: no Listen for a visitor or an older version of the text.
  const audioOn = listenShown({
    member,
    version: view.version,
    newest: view.newest,
    seed: listen,
  });
  // The one slot above the foot bar (F93, F207; P64-3y.F4, `./slot`): one holder at a time, in its order (the
  // layer's undo line and Sign in to save, the reader's resume pill or the layer's place bar, then Listen's pill,
  // which wants the head's control under the top bar and no sheet open). The holder stands on the dock while
  // a Listen is under way (F208).
  const layerHolder = useLayerHolder(slotHost);
  const holder = slotOf(
    slotWants({
      layer: layerHolder,
      resume: pill,
      listen: audioOn && past && sheet === null,
    }),
  );
  useSlotLift(rootRef);
  const oldBody = useMemo<OldBodyValue>(
    () => ({ settings, topH }),
    [settings, topH],
  );

  // ---- the parts -----------------------------------------------------------------------------------
  const chrome = chromeOf({ hidden, pct, pill });
  const scheme = settings.theme === "system" ? undefined : settings.theme;
  const state = endState({ member, saves: rd.saves, state: rd.state });
  const next = book?.next;
  const prev = book?.prev;
  const last = !!book && !next;
  const total = book?.total ?? 0;
  const sections = sectionsOf(view.headings);
  const fmt = { timeZone };
  const src = view.staleSource;
  const tools: BarTool[] = ["notes", "display"];
  const onOpen = (what: BarTool) => {
    if (what === "notes" || what === "display") openSheet(what);
  };

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
            back={book?.title ?? READER_FRAME.book}
            backShort={READER_FRAME.book}
            backHref={bookHrefNow}
            homeHref={readerHomeHref({
              member,
              org: target.kind === "chapter" ? target.org : null,
              orgLibrary,
            })}
            tag={
              older
                ? READER_FRAME.tag.olderVersion
                : src
                  ? READER_FRAME.tag.olderTranslation
                  : undefined
            }
            langs={hasLangs ? view.langs.map((l) => l.lang) : undefined}
            lang={view.lang}
            tools={tools}
            viewer={member ? "member" : "visitor"}
            hidden={chrome.bar.hidden}
            progress={chrome.bar.progress}
            signInHref={signIn}
            onLang={(code) => void switchTo(code)}
            onOpen={onOpen}
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
                        noun="chapter"
                        title={view.title}
                        lede={view.summary}
                        lang={view.lang}
                        where={
                          book
                            ? READER_FRAME.head.chapterOf(book.n, book.total)
                            : ""
                        }
                        version={view.version}
                        newest={view.newest}
                        published={date(view.published || view.date, fmt)}
                        translation={
                          src
                            ? {
                                source: src.label,
                                from: src.from,
                                newest: src.newest,
                              }
                            : null
                        }
                        sections={sections}
                        audio={
                          audioOn && listen ? (
                            <ListenHeadSlot
                              seed={listen}
                              signInHref={signIn}
                              onHead={setListenHead}
                            />
                          ) : null
                        }
                        onVersions={() => openSheet("versions")}
                        onNewest={() =>
                          go(
                            carry(
                              readerHref(target, {
                                lang: hasLangs ? view.lang : null,
                              }),
                            ),
                          )
                        }
                        onSource={() =>
                          src &&
                          go(carry(readerHref(target, { lang: src.lang })))
                        }
                        onSection={toSection}
                      />
                      <div className="read-flow">{children}</div>
                      <ReaderEnd
                        kind="chapter"
                        state={state}
                        asking={asking}
                        next={
                          next
                            ? {
                                n: next.n ?? (book?.n ?? 0) + 1,
                                total,
                                title: next.title,
                                lede: next.summary,
                                lang: next.lang,
                              }
                            : null
                        }
                        last={last}
                        rows={
                          endRowsShown({
                            total,
                            finished: rd.reading.finished,
                            last,
                          })
                            ? items
                            : undefined
                        }
                        current={currentKey}
                        progress={
                          member && finishedCount !== null
                            ? READER_FRAME.end.finished(finishedCount, total)
                            : READER_FRAME.end.chapters(total)
                        }
                        signInHref={signIn}
                        onFinish={() => void rd.mark(true)}
                        onUnread={() => void rd.mark(false)}
                        onNext={() => next && go(carry(next.href))}
                        onBook={() => go(bookHrefNow)}
                        onOpen={openChapter}
                        onAsk={() => setAsking(true)}
                        onDismiss={() => setAsking(false)}
                      />
                    </article>
                  </main>
                </div>
                {notes ? (
                  <div className="marks-slot" data-an-ui="" ref={setSlotHost} />
                ) : null}
                {/* The opened player (F211): the reader's sheet from the end side, opened by the dock. */}
                <ListenPlayerSheet signInHref={signIn} />
              </OldBodyContext.Provider>
            </NotesBridgeContext.Provider>
          </ReaderProgressContext.Provider>
          {/* The dock's track (F208, listen:FG1): in the flow before ReaderFoot, sticky to the window's foot. */}
          <ListenTrack
            seed={audioOn ? listen : null}
            shown={audioOn}
            pill={holder === "listen"}
            chapter={!!book}
            hidden={chrome.foot.hidden}
            signInHref={signIn}
          />
          {book ? (
            <ReaderFoot
              n={book.n}
              total={book.total}
              pct={chrome.foot.pct}
              prev={prev?.title ?? null}
              next={next?.title ?? null}
              hidden={chrome.foot.hidden}
              pill={chrome.foot.pill && holder === "resume"}
              onPrev={() => prev && go(carry(prev.href))}
              onNext={() => next && go(carry(next.href))}
              onContents={() => openSheet("contents")}
              onBook={() => go(bookHrefNow)}
              onTop={fromTop}
            />
          ) : null}
          <Sheet
            open={sheet === "contents"}
            title={READER_FRAME.sheets.contents}
            onClose={() => closeSheet("contents")}
          >
            {book ? (
              <>
                <div className="stack gap-1">
                  <p className="strong">{book.title}</p>
                  <p className="meta">
                    {READER_FRAME.sheets.bookLine(
                      book.n,
                      book.total,
                      member ? finishedCount : null,
                    )}
                  </p>
                </div>
                <ReaderChapters
                  rows={items}
                  current={currentKey}
                  sections={sections}
                  section={currentSection(view.headings, section)}
                  onOpen={openChapter}
                  onSection={toSection}
                />
              </>
            ) : null}
          </Sheet>
          <Sheet
            open={sheet === "notes"}
            title={READER_FRAME.sheets.notes}
            onClose={() => closeSheet("notes")}
          >
            {/* The Notes sheet's body is the annotation layer's (P63-fk.S11, `@/sikstack/reader/marks`): the marks
                live there, so it mounts the sheet's body, and its count beside the title, here. */}
            {notes ? <div ref={setNotesHost} /> : null}
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
                go(
                  carry(
                    readerHref(target, {
                      lang: hasLangs ? view.lang : null,
                      version: n === view.newest ? null : n,
                    }),
                  ),
                );
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
