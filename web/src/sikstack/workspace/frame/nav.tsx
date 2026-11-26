import Link from "next/link";

import { WS_HEAD, WS_PLACES, type WsPlace } from "@/content/workspace/frame";
import { Copy } from "@/sikstack/frame";

import { WsSync } from "./sync";
import type { WsSyncLine } from "./sync-model";

const PLACES: WsPlace[] = ["agenda", "backlog", "docs"];

/**
 * The Workspace head (frame.md F40, F41, `WsNav.dc.html`) on each of the three places: the `h1` **Workspace** and
 * the sync line in one 44 px row, then the three places as real links on a hairline, the current one
 * `aria-current="page"`. While the page loads the line is a bar and the title and places stand.
 *
 * A workspace that has never synced, or is not linked, draws the title and one panel instead, and the page draws
 * nothing else: `Nothing has synced yet. …`, or `No workspace linked yet. Run this in a terminal, …` with
 * the link command in the system's Copy field (mono, 28em at most). The page passes the command
 * (`PROJECT_HOME.workspace.run.command`); without one the sentence stands alone.
 *
 * Returns the head and the panel as siblings in the page's `.column`.
 */
export function WsNav({
  current,
  line,
  hrefs,
  loading = false,
  command = null,
}: {
  current: WsPlace;
  line: WsSyncLine;
  hrefs: Record<WsPlace, string>;
  loading?: boolean;
  command?: string | null;
}) {
  const unlinked = !loading && line.state === "unlinked";
  const never = !loading && line.state === "never";
  const placed = !unlinked && !never;
  return (
    <>
      <header className="page-top">
        <div className="page-head">
          <h1>{WS_HEAD.title}</h1>
          {placed ? <WsSync line={line} loading={loading} /> : null}
        </div>
        {placed ? (
          <nav className="subnav" aria-label={WS_HEAD.nav}>
            {PLACES.map((place) => (
              <Link
                key={place}
                className="subnav-item"
                aria-current={place === current ? "page" : undefined}
                href={hrefs[place]}
              >
                {WS_PLACES[place]}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>
      {unlinked ? (
        <section className="panel" aria-label={WS_HEAD.unlinked.label}>
          <div className="block">
            <p className="block-text">{WS_HEAD.unlinked.text}</p>
            {command ? (
              <div className="command">
                <Copy text={command} label={WS_HEAD.unlinked.copy} mono />
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {never ? (
        <section className="panel" aria-label={WS_HEAD.never.label}>
          <div className="block">
            <p className="block-text">{WS_HEAD.never.text}</p>
          </div>
        </section>
      ) : null}
    </>
  );
}
