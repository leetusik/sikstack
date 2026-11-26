"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { COPY } from "@/content/sikstack-frame";
import { Copy } from "@/sikstack/frame";
import { copyMachine, type CopyResult } from "@/sikstack/frame/copy-state";
import { StateBlock } from "@/sikstack/states";
import { Button, buttonClass, FieldError, Panel, Section, SectionHead, Swap } from "@/sikstack/ui";
import { at, bytes } from "@/lib/feedback/format";

import { DESIGN } from "@/content/design";
import {
  buildTitle,
  designHref,
  designOpenHref,
  designPagesHref,
  framedHeight,
  pageShareUrl,
  recordingWord,
  roundPages,
  roundShowsOptions,
  type DesignBuild,
  type DesignManifest,
  type DesignManifestPage,
  type DesignOptions,
} from "./model";

/**
 * A build's viewer (P77), `/projects/<id>/design/<build>`: the way back to the list, the build's title (its short
 * commit), its facts, its share link, then the options page's directions side by side (when its manifest lists
 * one) and the manifest's pages. Every page and direction opens on the build's own host, through the app's open
 * route (`designOpenHref`), in a new tab, from its name (one look for the one action); each direction is also
 * framed beside the others, at its page's full height, so the page's own scroll moves the directions together and
 * no frame scrolls inside. The share link is the
 * one thing a member changes here: on (a new link, shown with Copy) or off. While it is on, each page row copies
 * the share link that lands on that page (`pageShareUrl`). A build made from a private recording says, in one
 * line, that it cannot be shared (also when the API refuses the change with its 409); any other failed change
 * says so in one line under the control. No comment, pick, sign-off, edit or delete.
 *
 * A build published with a round (`manifest.round`, `design-publish --page`) lists only the round's pages, with
 * their count and one link to every page (`designPagesHref`, `scope="all"`), and the options page's directions only
 * when the round names the options page; a round of the options alone shows them, says so in place of a count and
 * lists no page. The every-page list shows the whole design: the options page's directions (when the manifest lists
 * one), framed as on a build without a round, and every manifest page; its way back names the list it returns to,
 * "This round" for a round's build and "Pages" for a build without one (the every-page route serves any build). A
 * build without a round lists every page, with no such link. Each page row lists its states, each opening the page
 * in that state.
 */
export interface DesignBuildViewProps {
  project: string;
  /** The round's list (the build's viewer, the default) or the every-page list (`…/<build>/pages`). */
  scope?: "round" | "all";
  build: DesignBuild;
  manifest: DesignManifest;
  /** The share link as it is now (the build's, until a change answers). */
  share: { on: boolean; url: string | null };
  /** A share change is on its way: its button shows it and both wait. */
  busy?: boolean;
  onShare?: (on: boolean) => void;
  /** The last change was refused for a private build (the API's 409): the one line, in place of the control. */
  refused?: boolean;
  /** The last change failed otherwise: one line under the control. */
  failed?: boolean;
  /**
   * The build's own origin (`KB_DESIGN_ORIGIN` with its id), or null when the app has none: then nothing is framed
   * and every page and direction still opens in a new tab through the open route.
   */
  origin?: string | null;
  /** What a direction's frame holds; production frames the direction on the build's host. */
  frameOf?: (direction: DesignOptions["directions"][number]) => ReactNode;
  /**
   * Where the round's list links to every page (`whole`) and where the every-page list goes back (`back`):
   * production's routes (`designPagesHref`, `designHref`) unless given. The design folder draws both lists as states
   * of one page, so it gives that page's states.
   */
  links?: { whole?: string; back?: string };
  timeZone?: string;
  now?: number;
}

/**
 * A direction framed on the build's host, sandboxed to `allow-scripts allow-same-origin` (a Next export needs its
 * own origin for its files and `localStorage`; the frame stays cross-origin to the app, so it cannot lift the
 * sandbox, and top navigation, popups and forms stay barred). Its height is the one the framed page posts
 * (`{ designHeight }`), taken only from this frame's own window and the build's origin (`framedHeight`), so the
 * frame never scrolls inside; until it posts, the sheet's height holds. Only the options page's directions are
 * framed, never a Next page of the build (those log focus-policy errors under the sandbox).
 */
function DirectionFrame({ src, title, origin }: { src: string; title: string; origin: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = framedHeight(e, { window: ref.current?.contentWindow ?? null, origin });
      if (h !== null) setHeight(h);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [origin]);
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      loading="lazy"
      sandbox="allow-scripts allow-same-origin"
      style={height ? { height } : undefined}
    />
  );
}

/** A page row's copy of the share link that lands on that page: `Copy link`, `Copied` for 2 s at the same width. */
function CopyPageLink({ text, page }: { text: string; page: string }) {
  const [result, setResult] = useState<CopyResult>("rest");
  const [machine] = useState(() => copyMachine((r) => setResult(r)));
  useEffect(() => () => machine.dispose(), [machine]);
  return (
    <>
      <button
        type="button"
        className={buttonClass("quiet", "design-page-copy")}
        aria-label={DESIGN.share.copyPageLabel(page)}
        data-swap={result === "copied" ? "true" : undefined}
        onClick={() => {
          void machine.press(text, typeof navigator === "undefined" ? undefined : navigator.clipboard);
        }}
      >
        <Swap labels={[DESIGN.share.copyPage, COPY.copied]} />
      </button>
      <span className="sr-only" role="status">
        {result === "copied" ? COPY.copied : ""}
      </span>
      {result === "failed" ? (
        <FieldError role="alert" className="design-page-copy-failed">
          {COPY.failed}
        </FieldError>
      ) : null}
    </>
  );
}

/**
 * The way back: to the Design list, or from the every-page list to the build's own list (`build`), named by that
 * list's heading (`label`).
 */
function BackRow({ project, build }: { project: string; build?: { href: string; label: string } }) {
  return (
    <div className="design-top">
      {build ? (
        // A full page load: the viewer's CSP, which lets it frame the build, is the document's.
        <a className="back" href={build.href}>
          {build.label}
        </a>
      ) : (
        <Link className="back" href={designHref(project)}>
          {DESIGN.back}
        </Link>
      )}
    </div>
  );
}

/** A page's states, each opening the page in that state (`<entry>?state=<key>`) on the build's host. */
function PageStates({ page, open }: { page: DesignManifestPage; open: (path: string) => string }) {
  const states = page.states ?? [];
  if (states.length === 0) return null;
  const sep = page.entry.includes("?") ? "&" : "?";
  return (
    <ul className="design-page-states" aria-label={DESIGN.pages.statesLabel(page.name)}>
      {states.map((st) => (
        <li key={st.key}>
          <a
            className="link"
            href={open(`${page.entry}${sep}state=${encodeURIComponent(st.key)}`)}
            target="_blank"
            rel="noopener"
            aria-label={DESIGN.opensLabel(`${page.name}, ${st.label}`)}
          >
            {st.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function DesignBuildView({
  project,
  scope = "round",
  build,
  manifest,
  share,
  busy = false,
  onShare,
  refused = false,
  failed = false,
  origin = null,
  frameOf,
  links,
  timeZone,
  now,
}: DesignBuildViewProps) {
  const f = DESIGN.facts;
  const all = manifest.pages ?? [];
  const round = roundPages(manifest);
  const whole = scope === "all";
  const pages = whole ? all : (round ?? all);
  // Under a round, the options show only when the round names them (`roundShowsOptions`); on the every-page list and
  // without a round, always (the whole design holds them).
  const options = !whole && round && !roundShowsOptions(manifest) ? undefined : manifest.options;
  const optionsOnly = !whole && round !== null && round.length === 0;
  const open = (path: string) => designOpenHref(project, build.id, path);
  const frame =
    frameOf ??
    (origin
      ? (d: DesignOptions["directions"][number]) => (
          <DirectionFrame src={open(d.entry)} title={d.label} origin={origin} />
        )
      : null);
  const shareUrl = !build.private && !refused && share.on ? share.url : null;

  return (
    <div className="column">
      <header className="page-top">
        <BackRow
          project={project}
          build={
            whole
              ? {
                  href: links?.back ?? designHref(project, build.id),
                  label: round ? DESIGN.pages.round : DESIGN.pages.title,
                }
              : undefined
          }
        />
        <div className="page-head">
          <h1>{buildTitle(build)}</h1>
        </div>
        <div className="design-head">
          <dl className="facts">
            <div className="fact">
              <dt>{f.branch}</dt>
              <dd>{build.branch ?? "—"}</dd>
            </div>
            <div className="fact">
              <dt>{f.tree}</dt>
              <dd>{build.dirty ? DESIGN.dirty : DESIGN.clean}</dd>
            </div>
            <div className="fact">
              <dt>{f.recording}</dt>
              <dd>{recordingWord(build)}</dd>
            </div>
            <div className="fact">
              <dt>{f.size}</dt>
              <dd>
                {bytes(build.size)} · {DESIGN.files(build.files)}
              </dd>
            </div>
            <div className="fact">
              <dt>{f.published}</dt>
              <dd>
                <time dateTime={build.published_at}>{at(build.published_at, { timeZone, now })}</time>
              </dd>
            </div>
          </dl>
          <dl className="facts">
            <div className="fact design-share">
              <dt>{DESIGN.share.label}</dt>
              <dd>
                {build.private || refused ? (
                  <p className="design-share-line">
                    {DESIGN.share.refused(build.recording ?? DESIGN.private)}
                  </p>
                ) : share.on && share.url ? (
                  <div className="design-share-on">
                    <Copy text={share.url} label={DESIGN.share.copyLabel} />
                    <Button
                      busy={busy}
                      busyLabel={DESIGN.share.turningOff}
                      disabled={busy}
                      onClick={() => onShare?.(false)}
                    >
                      {DESIGN.share.turnOff}
                    </Button>
                  </div>
                ) : (
                  <div className="cluster gap-3">
                    <span className="design-share-line">{DESIGN.share.off}</span>
                    <Button
                      busy={busy}
                      busyLabel={DESIGN.share.turningOn}
                      disabled={busy}
                      onClick={() => onShare?.(true)}
                    >
                      {DESIGN.share.turnOn}
                    </Button>
                  </div>
                )}
                {failed && !build.private && !refused ? (
                  <FieldError role="alert">{DESIGN.share.failed}</FieldError>
                ) : null}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      {options ? (
        <Section aria-labelledby="design-options">
          <SectionHead>
            <h2 id="design-options">{options.name ?? DESIGN.options.title}</h2>
            <p className="meta">{DESIGN.options.count(options.directions.length)}</p>
          </SectionHead>
          <div className="design-directions">
            {options.directions.map((d) => (
              <figure key={d.key} className="design-direction">
                <figcaption className="design-direction-head">
                  <a
                    className="link-strong"
                    href={open(d.entry)}
                    target="_blank"
                    rel="noopener"
                    aria-label={DESIGN.opensLabel(d.label)}
                  >
                    {d.label}
                  </a>
                </figcaption>
                {frame ? <div className="design-frame">{frame(d)}</div> : null}
              </figure>
            ))}
          </div>
        </Section>
      ) : null}

      <Section aria-labelledby="design-pages">
        <SectionHead>
          <h2 id="design-pages">
            {whole ? DESIGN.whole.title : round ? DESIGN.pages.round : DESIGN.pages.title}
          </h2>
          <p className="meta">{optionsOnly ? DESIGN.pages.optionsOnly : DESIGN.pages.count(pages.length)}</p>
        </SectionHead>
        {optionsOnly ? null : (
        <Panel>
          <ul className="design-pages">
            {pages.map((p) => (
              <li key={p.entry} className={shareUrl ? "row design-page has-copy" : "row design-page"}>
                <a
                  className="link-strong"
                  href={open(p.entry)}
                  target="_blank"
                  rel="noopener"
                  aria-label={DESIGN.opensLabel(p.name)}
                >
                  {p.name}
                </a>
                {p.route ? <span className="mono meta">{p.route}</span> : null}
                {shareUrl ? <CopyPageLink text={pageShareUrl(shareUrl, p.entry)} page={p.name} /> : null}
                <PageStates page={p} open={open} />
              </li>
            ))}
          </ul>
        </Panel>
        )}
        {round && !whole ? (
          <p className="design-whole">
            <a className="link-strong" href={links?.whole ?? designPagesHref(project, build.id)}>
              {DESIGN.whole.link(all.length)}
            </a>
          </p>
        ) : null}
      </Section>
    </div>
  );
}

/** A build that is gone (the API's 404: deleted with the CLI, or never this project's): the way back and one line. */
export function DesignBuildGone({ project, projectName }: { project: string; projectName: string }) {
  return (
    <div className="column">
      <header className="page-top">
        <BackRow project={project} />
        <StateBlock
          state={{
            title: DESIGN.gone.title,
            text: DESIGN.gone.text(projectName),
            actions: [],
            reference: null,
          }}
        />
      </header>
    </div>
  );
}
