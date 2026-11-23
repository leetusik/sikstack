"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Copy } from "@/sikstack/frame";
import { StateBlock } from "@/sikstack/states";
import { Button, Panel, Section, SectionHead } from "@/sikstack/ui";
import { at, bytes } from "@/lib/feedback/format";

import { DESIGN } from "../content/design";
import {
  buildTitle,
  designHref,
  designOpenHref,
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
 * one thing a member changes here: on (a new link, shown with Copy) or off. A build made from a private
 * recording says, in one line, that it cannot be shared. No comment, pick, sign-off, edit or delete.
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
  /** What a direction's frame holds; production frames the direction on the build's host. */
  frameOf?: (direction: DesignOptions["directions"][number]) => ReactNode;
  timeZone?: string;
  now?: number;
}

/**
 * A direction framed on the build's host. Its height is the one the framed page posts (`{ designHeight }` from the
 * options page, matched to this frame's window), so the frame never scrolls inside; until it posts, the sheet's
 * height holds. Production owes the options page's side: post its height and drop its own bar when framed.
 */
function DirectionFrame({ src, title }: { src: string; title: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const v = (e.data as { designHeight?: unknown } | null)?.designHeight;
      if (typeof v === "number" && v > 0) setHeight(Math.ceil(v));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return <iframe ref={ref} src={src} title={title} loading="lazy" style={height ? { height } : undefined} />;
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
    ((d: DesignOptions["directions"][number]) => <DirectionFrame src={open(d.entry)} title={d.label} />);

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
                {build.private ? (
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
                <div className="design-frame">{frame(d)}</div>
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
              <li key={p.entry} className="row design-page">
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
