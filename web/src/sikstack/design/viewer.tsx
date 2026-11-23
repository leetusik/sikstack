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
  framedHeight,
  pageShareUrl,
  recordingWord,
  type DesignBuild,
  type DesignManifest,
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
 */
export interface DesignBuildViewProps {
  project: string;
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

function BackRow({ project }: { project: string }) {
  return (
    <div className="design-top">
      <Link className="back" href={designHref(project)}>
        {DESIGN.back}
      </Link>
    </div>
  );
}

export function DesignBuildView({
  project,
  build,
  manifest,
  share,
  busy = false,
  onShare,
  refused = false,
  failed = false,
  origin = null,
  frameOf,
  timeZone,
  now,
}: DesignBuildViewProps) {
  const f = DESIGN.facts;
  const pages = manifest.pages ?? [];
  const options = manifest.options;
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
        <BackRow project={project} />
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
          <h2 id="design-pages">{DESIGN.pages.title}</h2>
          <p className="meta">{DESIGN.pages.count(pages.length)}</p>
        </SectionHead>
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
              </li>
            ))}
          </ul>
        </Panel>
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
