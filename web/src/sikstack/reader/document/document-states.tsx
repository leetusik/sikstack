"use client";

import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useContext, type ReactNode } from "react";

import { READER_DOCUMENT } from "@/content/reader-document";
import { READER_FRAME } from "@/content/reader-frame";
import { Bar } from "@/sikstack/library";
import { StateBlock, type StateModel } from "@/sikstack/states";
import { UiRoot } from "@/sikstack/ui";
import { FROM_PARAM } from "@/lib/library/from";
import { loginHref } from "@/lib/next-path";
import { readerHomeHref } from "@/lib/library/way-out";
import { LIBRARY_HREF } from "@/lib/reader-href";

import { failedState, ReaderSegmentContext } from "../reader-states";
import { documentBack } from "./model";

/**
 * A loose document's loading, not found and error screens (`Document.dc.html`'s states; frame.md F89, F93):
 *
 * - **Loading** keeps the reader's frame and scheme: the Bar complete (its way back by `?from=`, Notes and
 *   Display, an empty progress line), then `.skel` bars for the title, two facts and three paragraphs in the
 *   column, `aria-busy` and a `.sr-only` `Loading…`.
 * - **Not found** and **Error** use the bar's frame (`.app.bare > Bar + main.app-main`, and `StateBlock`'s `.column`) through
 *   `StateBlock`: Document not found in a member's or a visitor's words.
 *
 * Who is reading, the nonce and the display settings come from the route's layout (`ReaderSegment`); the
 * org and the project from the address (`/@<org>/<project>/<slug>`; P63-fk.F4: they name the way back
 * until the document is read), the list from `?from=`. P75: the segment also says whether the org's public library
 * reads for this reader; a link reader in an org with nothing Public goes home to sikstack (`@/lib/library/way-out`).
 */
function decoded(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The way back from the address and `?from=`, as the page draws it. */
function useBack() {
  const { member, orgLibrary } = useContext(ReaderSegmentContext);
  const params = (useParams() ?? {}) as Record<string, string | string[]>;
  const search = useSearchParams();
  const at = decoded(params.org);
  const org = at.startsWith("@") && at.length > 1 ? at.slice(1) : null;
  const back = documentBack({
    member,
    from: search?.get(FROM_PARAM) ?? null,
    org,
    names: { project: decoded(params.project) || null },
    orgLibrary,
  });
  const homeHref = readerHomeHref({ member, org, orgLibrary });
  return { member, back, homeHref };
}

const skel = (width?: string) => (
  <span className="skel" style={width ? { width } : undefined} />
);

export function DocumentLoading() {
  const { nonce, settings } = useContext(ReaderSegmentContext);
  const { member, back, homeHref } = useBack();
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
            back={back?.label}
            backShort={back?.label}
            backHref={back?.href}
            homeHref={homeHref}
            tools="notes ask display"
            viewer={member ? "member" : "visitor"}
            progress={0}
          />
          <div className="reader-frame">
            <main className="reader-main" id="main-content">
              <article className="reader-col" aria-busy="true">
                <div className="read-head" aria-hidden="true">
                  <p className="read-title">{skel("14em")}</p>
                  <div className="read-facts">
                    {skel()}
                    {skel()}
                  </div>
                </div>
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
              </article>
            </main>
          </div>
        </div>
      </div>
    </UiRoot>
  );
}

/** The bar's frame around a whole-page state, in the product's scheme. */
function PlainFrame({ children }: { children: ReactNode }) {
  const { nonce } = useContext(ReaderSegmentContext);
  const { member, back, homeHref } = useBack();
  const signIn = loginHref(usePathname() ?? "/");
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
            signInHref={signIn}
          />
          <main className="app-main" id="main-content">
            {children}
          </main>
        </div>
      </div>
    </UiRoot>
  );
}

/**
 * Document not found (`Document.dc.html`: Not found, Not found visitor). A member: **Back to Library** (or the
 * list's name). A visitor: the visitor's sentence and **Sign in**, which returns to this address.
 */
export function missingDocument(p: {
  member: boolean;
  back: { href: string; label: string } | null;
  signInHref: string;
}): StateModel {
  const n = READER_DOCUMENT.notFound;
  return {
    title: n.title,
    text: p.member ? n.member : n.visitor,
    actions: [
      p.member
        ? {
            kind: "link",
            label: READER_DOCUMENT.backTo(
              p.back?.label ?? READER_FRAME.library,
            ),
            href: p.back?.href ?? LIBRARY_HREF,
            variant: "default",
          }
        : {
            kind: "link",
            label: n.signIn,
            href: p.signInHref,
            variant: "default",
          },
    ],
    reference: null,
  };
}

export function DocumentMissing() {
  const { member, back } = useBack();
  const signIn = loginHref(usePathname() ?? "/");
  return (
    <PlainFrame>
      <StateBlock
        state={missingDocument({ member, back, signInHref: signIn })}
      />
    </PlainFrame>
  );
}

/**
 * Error, in the bar's frame. **Try again** (primary) shows Loading, then the document (`onRetry` re-fetches:
 * `boundaryRetry`); **Back to Library** for a member; the reference.
 */
export function DocumentFailed({
  digest,
  retrying,
  onRetry,
}: {
  digest?: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { member } = useContext(ReaderSegmentContext);
  if (retrying) return <DocumentLoading />;
  return (
    <PlainFrame>
      <StateBlock state={failedState(member, digest)} onRetry={onRetry} />
    </PlainFrame>
  );
}
