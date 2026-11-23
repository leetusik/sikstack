import Link from "next/link";

import { StackTable } from "@/sikstack/feedback";
import { Badge, Status } from "@/sikstack/ui";
import { at, bytes } from "@/lib/feedback/format";

import { DESIGN } from "../content/design";
import {
  buildTitle,
  designHref,
  recordingWord,
  shortCommit,
  type DesignBuild,
} from "./model";

/**
 * The project's Design list (P77): the head (`h1` Design, the count at its end), then one panel holding the
 * builds newest first, as `GET /app/projects/{id}/design/builds` lists them, in Feedback's table that stacks
 * (under 48em a row is its build, then its other cells on one line). Each row: the build (its short commit, the
 * viewer's link, and a mark when the tree had uncommitted changes), its branch, its recording (the sample, or
 * Private for a real project's), its size, its share link (On with the live mark, or Off) and when it was
 * published. No builds: one sentence and the command that publishes one. Read only: nothing here publishes,
 * shares or deletes.
 */
export interface DesignListViewProps {
  project: string;
  builds: readonly DesignBuild[];
  /** The reader's zone and clock, for `Published`. */
  timeZone?: string;
  now?: number;
}

export function DesignListView({ project, builds, timeZone, now }: DesignListViewProps) {
  const c = DESIGN.columns;
  return (
    <div className="column">
      <header className="page-top">
        <div className="page-head">
          <h1>{DESIGN.title}</h1>
          {builds.length > 0 ? <p className="meta">{DESIGN.count(builds.length)}</p> : null}
        </div>
      </header>
      <section className="panel" aria-label={DESIGN.title}>
        {builds.length === 0 ? (
          <div className="block">
            <p className="block-text">
              {DESIGN.none.before}
              <code className="mono design-command">{DESIGN.none.command}</code>
              {DESIGN.none.after}
            </p>
          </div>
        ) : (
          <StackTable className="design-builds">
            <thead>
              <tr>
                <th scope="col">{c.build}</th>
                <th scope="col">{c.branch}</th>
                <th scope="col">{c.recording}</th>
                <th scope="col" className="num">
                  {c.size}
                </th>
                <th scope="col">{c.share}</th>
                <th scope="col" className="num">
                  {c.published}
                </th>
              </tr>
            </thead>
            <tbody>
              {builds.map((b) => (
                <tr key={b.id}>
                  <td className="has-control is-main">
                    <div className="design-build">
                      <Link
                        className="link-strong mono"
                        href={designHref(project, b.id)}
                        aria-label={buildTitle(b)}
                      >
                        {shortCommit(b.commit) ?? b.id.slice(0, 8)}
                      </Link>
                      {b.dirty ? <Badge>{DESIGN.dirty}</Badge> : null}
                    </div>
                  </td>
                  <td className="stack-wrap">{b.branch ?? "—"}</td>
                  <td>{b.private ? <Badge>{DESIGN.private}</Badge> : recordingWord(b)}</td>
                  <td className="num">{bytes(b.size)}</td>
                  {b.share.on ? (
                    <td className="nowrap design-sharing">
                      <Status state="live">{DESIGN.shared}</Status>
                    </td>
                  ) : (
                    <td className="nowrap dim design-sharing">{DESIGN.notShared}</td>
                  )}
                  <td className="num dim to-end">
                    <time dateTime={b.published_at}>{at(b.published_at, { timeZone, now })}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </StackTable>
        )}
      </section>
    </div>
  );
}
