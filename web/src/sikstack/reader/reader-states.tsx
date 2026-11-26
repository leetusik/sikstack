"use client";

import { useParams, usePathname } from "next/navigation";
import { createContext, useContext, type ReactNode } from "react";

import { SIKSTACK_STATES } from "@/content/sikstack-states";
import { READER_FRAME } from "@/content/reader-frame";
import { Bar } from "@/sikstack/library";
import { StateBlock, type StateModel } from "@/sikstack/states";
import { UiRoot } from "@/sikstack/ui";
import {
  DEFAULT_READER_SETTINGS,
  type ReaderSettings,
} from "@/lib/reader-cookie";
import { readerHomeHref } from "@/lib/library/way-out";
import { bookHref, LIBRARY_HREF } from "@/lib/reader-href";
import { loginHref } from "@/lib/next-path";

/**
 * The reader's loading, not found and error screens (`Chapter.dc.html`'s states; frame.md F89, F93):
 *
 * - **Loading** keeps the reader's frame and scheme: the Bar with its way back, Notes and Display and an
 *   empty progress line, no foot bar until the text is ready, then `.skel` bars in the real elements (the
 *   title's line, two lede lines, two facts, three paragraphs), `aria-busy` and a hidden `Loading…`.
 * - **Not found** and **Error** use the bar's frame in the product's scheme
 *   (`.app.bare > Bar + main.app-main > .column > .block.block-page`), through `StateBlock`.
 *
 * Who is reading, the nonce and the display settings come from the route's layout
 * (`ReaderSegmentContext`); the book's address from the route's own params.
 */
export interface ReaderSegmentValue {
  member: boolean;
  nonce?: string;
  settings: ReaderSettings;
  /**
   * Whether the org's public library reads for this reader (P75, `@/lib/library/way-out`): false for a link
   * reader in an org with nothing Public, whose wordmark and way back then lead to the sikstack home. Absent: true.
   */
  orgLibrary?: boolean;
}

export const ReaderSegmentContext = createContext<ReaderSegmentValue>({
  member: false,
  settings: DEFAULT_READER_SETTINGS,
});

export function ReaderSegment({
  children,
  ...value
}: ReaderSegmentValue & { children: ReactNode }) {
  return (
    <ReaderSegmentContext.Provider value={value}>
      {children}
    </ReaderSegmentContext.Provider>
  );
}

type Params = { org?: string; project?: string; book?: string };

function decoded(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The address's org (without its `@`) and its book's page, when the params name them. */
function useBookPlace(): { org: string; book: string | null } {
  const params = (useParams() ?? {}) as Params;
  const at = decoded(params.org);
  const org = at.startsWith("@") ? at.slice(1) : "";
  const project = decoded(params.project);
  const book = decoded(params.book);
  return {
    org,
    book: org && project && book ? bookHref({ org, project, book }) : null,
  };
}

/** The skeleton's bars: inline widths, as the board draws them. */
const skel = (width: string) => <span className="skel" style={{ width }} />;

export function ReaderLoading() {
  const { nonce, settings } = useContext(ReaderSegmentContext);
  const place = useBookPlace();
  const scheme = settings.theme === "system" ? undefined : settings.theme;
  return (
    <UiRoot nonce={nonce}>
      <div className="page">
        <div
          className="app bare reader"
          data-scheme={scheme}
          data-size={settings.size}
          lang="en"
        >
          <Bar
            back={READER_FRAME.book}
            backShort={READER_FRAME.book}
            backHref={place.book ?? LIBRARY_HREF}
            homeHref={LIBRARY_HREF}
            tools={["notes", "display"]}
            progress={0}
          />
          <div className="reader-frame">
            <main className="reader-main" id="main-content">
              <article className="reader-col" aria-busy="true">
                <div className="read-head" aria-hidden="true">
                  <p className="read-title">{skel("12em")}</p>
                  <p className="read-lede">
                    {skel("100%")}
                    {skel("58%")}
                  </p>
                  <div className="read-facts">
                    {skel("7em")}
                    {skel("9em")}
                  </div>
                </div>
                <div className="read-flow" aria-hidden="true">
                  <div className="read">
                    <p>
                      {skel("100%")}
                      {skel("100%")}
                      {skel("100%")}
                      {skel("64%")}
                    </p>
                    <p>
                      {skel("100%")}
                      {skel("100%")}
                      {skel("38%")}
                    </p>
                    <p>
                      {skel("100%")}
                      {skel("100%")}
                      {skel("100%")}
                      {skel("81%")}
                    </p>
                  </div>
                </div>
                <span className="sr-only">{READER_FRAME.loading}</span>
              </article>
            </main>
          </div>
        </div>
      </div>
    </UiRoot>
  );
}

/** The bar's frame around a whole-page state, in the product's scheme. */
function PlainFrame({
  back,
  backHref,
  viewer,
  homeHref,
  signInHref,
  children,
}: {
  back?: string;
  backHref?: string;
  viewer: "member" | "visitor";
  homeHref: string;
  signInHref?: string;
  children: ReactNode;
}) {
  const { nonce } = useContext(ReaderSegmentContext);
  return (
    <UiRoot nonce={nonce}>
      <div className="page">
        <div className="app bare">
          <Bar
            back={back}
            backShort={back}
            backHref={backHref}
            homeHref={homeHref}
            viewer={viewer}
            signInHref={signInHref}
          />
          <main className="app-main" id="main-content">
            {children}
          </main>
        </div>
      </div>
    </UiRoot>
  );
}

/** The model of Chapter not found (frame.md F28's two sentences, the chapter's own words). */
export function missingState(member: boolean, signInHref: string): StateModel {
  const n = READER_FRAME.notFound;
  return {
    title: n.title,
    text: member ? n.member : n.visitor,
    actions: [
      member
        ? {
            kind: "link",
            label: n.backToLibrary,
            href: LIBRARY_HREF,
            variant: "default",
          }
        : {
            kind: "link",
            label: n.signIn,
            href: signInHref,
            variant: "default",
          },
    ],
    reference: null,
  };
}

/** The model of Error (F5's words): Try again, and for a member Back to Library; the reference. */
export function failedState(
  member: boolean,
  digest: string | null | undefined,
): StateModel {
  const e = SIKSTACK_STATES.error;
  return {
    title: e.title,
    text: e.text,
    actions: [
      { kind: "retry", label: e.retry, variant: "primary" },
      ...(member
        ? [
            {
              kind: "link" as const,
              label: READER_FRAME.notFound.backToLibrary,
              href: LIBRARY_HREF,
              variant: "default" as const,
            },
          ]
        : []),
    ],
    reference: digest ? e.reference(digest) : null,
  };
}

/**
 * Chapter not found, in the bar's frame. A member: the bar's way back `Library`, and **Back to
 * Library**. A visitor: no way back in the bar, and **Sign in**, which returns to this address.
 */
export function ReaderMissing() {
  const { member, orgLibrary } = useContext(ReaderSegmentContext);
  const place = useBookPlace();
  const signIn = loginHref(usePathname());
  return (
    <PlainFrame
      back={member ? READER_FRAME.library : undefined}
      backHref={member ? LIBRARY_HREF : undefined}
      viewer={member ? "member" : "visitor"}
      homeHref={readerHomeHref({ member, org: place.org, orgLibrary })}
      signInHref={signIn}
    >
      <StateBlock state={missingState(member, signIn)} />
    </PlainFrame>
  );
}

/**
 * Error, in the bar's frame, the bar's way back to the book. **Try again** (primary) shows Loading, then
 * the chapter (`onRetry` re-fetches: `boundaryRetry`); **Back to Library** for a member; the reference.
 */
export function ReaderFailed({
  digest,
  retrying,
  onRetry,
}: {
  digest?: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { member, orgLibrary } = useContext(ReaderSegmentContext);
  const place = useBookPlace();
  const signIn = loginHref(usePathname());
  if (retrying) return <ReaderLoading />;
  return (
    <PlainFrame
      back={READER_FRAME.book}
      backHref={place.book ?? LIBRARY_HREF}
      viewer={member ? "member" : "visitor"}
      homeHref={readerHomeHref({ member, org: place.org, orgLibrary })}
      signInHref={signIn}
    >
      <StateBlock state={failedState(member, digest)} onRetry={onRetry} />
    </PlainFrame>
  );
}
