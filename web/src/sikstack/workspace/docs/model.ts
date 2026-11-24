/**
 * The docs pages' pure model (design job 02, page docs; frame.md F42, F79, F80, F82): what the list, a doc and an
 * earlier version draw of the read model, worded and formatted, with the addresses already built. No React, no I/O.
 *
 * - A row: the title (its link), the status word (F37), what a stale doc waits for (`4 notes from P7-m3 and
 *   P8-q4`), `v<ordinal>`, the versioned day, the phases it came from joined `a`, `a and b`, `a, b and c`, or none.
 * - The counts: `5 docs, 2 stale`; Retired's `2 docs`.
 * - A doc: the doc itself, or an earlier version of it (five changes: the title says the version, the back link
 *   reads the doc's title and returns to it, the badge **Earlier version** for the status, the notice naming the
 *   current version, the facts Versioned and Summary; no Earlier versions). A retired doc has no notice and no
 *   earlier versions.
 *
 * The address keeps the stored id (`?version=v0002`); a page draws only the ordinal (`v2`).
 */

import { WS_DOCS } from "@/content/workspace/docs";
import { plural } from "@/lib/format";
import { WS_GLOSSARY } from "@/content/workspace/frame";
import type { WsPlace } from "@/content/workspace/frame";
import {
  agendaHref,
  backlogHref,
  docHref,
  docsHref,
  phaseHref,
  type WorkspaceList,
} from "@/lib/workspace/address";
import {
  andList,
  type Dates,
  langOf,
  staleNotes,
  versionLabel,
} from "@/lib/workspace/model";
import type { Doc, DocRow } from "@/lib/workspace/types";
import {
  wsStatus,
  type WsStatusWord,
} from "@/sikstack/workspace/frame/status-model";

const NONE = WS_GLOSSARY.none;

/** A row of the Docs or the Retired table. */
export interface DocsRowView {
  id: string;
  title: string;
  lang: "en" | "ko";
  href: string;
  status: WsStatusWord | null;
  /** What a stale doc waits for; `''` when nothing does (and on a retired doc). */
  notes: string;
  version: string;
  versioned: string;
  /** The phases it came from, joined; `null` for none (the cell reads `—`, the stacked line leaves it out). */
  from: string | null;
}

export function docsRow(
  project: string,
  doc: DocRow,
  dates: Dates,
): DocsRowView {
  return {
    id: doc.id,
    title: doc.title,
    lang: langOf(doc.title),
    href: docHref(project, doc.id),
    status: wsStatus("doc", doc.state),
    notes: doc.state === "retired" ? "" : staleNotes(doc),
    version: versionLabel(doc.ordinal),
    versioned: dates.date(doc.versioned),
    from: doc.from.length ? andList(doc.from) : null,
  };
}

/** The Docs panel's count: `5 docs`, or `5 docs, 2 stale`. */
export function docsCount(docs: readonly Pick<DocRow, "state">[]): string {
  return WS_DOCS.count(
    docs.length,
    docs.filter((d) => d.state === "stale").length,
  );
}

/** The Retired panel's count: `2 docs`. */
export function retiredCount(retired: readonly unknown[]): string {
  return WS_DOCS.retiredCount(retired.length);
}

// -- one doc -----------------------------------------------------------------------------------

/** A stale doc's notice: the notes, the phases (each a link) and `is` for one note. */
export interface StaleNotice {
  kind: "stale";
  count: string;
  phases: { id: string; href: string }[];
  single: boolean;
}

/** An earlier version's notice: the current version (a link to the doc) and its day. */
export interface EarlierNotice {
  kind: "earlier";
  current: string;
  currentDate: string;
  href: string;
}

export interface VersionRowView {
  version: string;
  label: string;
  href: string;
  date: string;
  summary: string;
}

export interface DocView {
  kind: "doc" | "earlier";
  /** The doc's own title (the back link of an earlier version reads it). */
  title: string;
  lang: "en" | "ko";
  /** The `h1`: the title, or the title then the version (`Architecture v12`). */
  heading: string;
  /** The status word on a doc; `null` on an earlier version (its badge stands there). */
  status: WsStatusWord | null;
  notice: StaleNotice | EarlierNotice | null;
  /** Version, Versioned, From on a doc; Versioned, Summary on an earlier version. */
  facts: { label: string; value: string; ids: boolean }[];
  sectionCount: string;
  /** The Text: each section as `## <title>`, then its text. */
  source: string;
  /** Earlier versions, newest first; none on an earlier version or a retired doc. */
  versions: VersionRowView[];
}

/** The Text's Markdown: each section under its own first-step heading. */
export function docSource(sections: Doc["sections"]): string {
  return sections.map((s) => `## ${s.title}\n\n${s.md}`).join("\n\n");
}

/**
 * What a doc's page draws. `latest` is the doc at its latest version; `shown` the version the address names
 * (the same read when it names none, or names the latest). `list` is the way back kept, passed on.
 */
export function docView(
  project: string,
  latest: Doc,
  shown: Doc,
  dates: Dates,
  list: WorkspaceList | null = null,
): DocView {
  const earlier = shown.version !== latest.version;
  const title = latest.title;
  const lang = langOf(title);
  const doc = earlier ? shown : latest;
  const retired = latest.state === "retired";
  const base = {
    title,
    lang,
    sectionCount: WS_DOCS.sections(doc.sections.length),
    source: docSource(doc.sections),
  };
  if (earlier) {
    const own = latest.versions.find((v) => v.version === shown.version);
    const version = versionLabel(shown.ordinal ?? own?.ordinal);
    return {
      ...base,
      kind: "earlier",
      heading: WS_DOCS.earlierTitle(title, version),
      status: null,
      notice: {
        kind: "earlier",
        current: versionLabel(latest.ordinal),
        currentDate: dates.date(latest.versioned),
        href: docHref(project, latest.id, {}, list),
      },
      facts: [
        {
          label: WS_GLOSSARY.labels.doc.versioned,
          value: dates.date(shown.versioned ?? own?.date),
          ids: false,
        },
        {
          label: WS_DOCS.summary,
          value: own?.summary?.trim() || NONE,
          ids: true,
        },
      ],
      versions: [],
    };
  }
  const notes = retired ? 0 : latest.stale.reduce((n, x) => n + x.notes, 0);
  return {
    ...base,
    kind: "doc",
    heading: title,
    status: wsStatus("doc", latest.state),
    notice:
      !retired && latest.stale.length
        ? {
            kind: "stale",
            count: plural(notes, "note"),
            phases: latest.stale.map((x) => ({
              id: x.phase,
              href: phaseHref(project, x.phase),
            })),
            single: notes === 1,
          }
        : null,
    facts: [
      {
        label: WS_GLOSSARY.labels.doc.version,
        value: versionLabel(latest.ordinal),
        ids: false,
      },
      {
        label: WS_GLOSSARY.labels.doc.versioned,
        value: dates.date(latest.versioned),
        ids: false,
      },
      {
        label: WS_GLOSSARY.labels.doc.from,
        value: latest.from.length ? andList(latest.from) : NONE,
        ids: true,
      },
    ],
    versions: retired
      ? []
      : latest.versions
          .filter((v) => v.version)
          .map((v) => {
            const version = versionLabel(v.ordinal);
            return {
              version,
              label: WS_DOCS.openVersion(version),
              href: docHref(project, latest.id, { version: v.version }, list),
              date: dates.date(v.date),
              summary: v.summary ?? "",
            };
          }),
  };
}

// -- the three places ---------------------------------------------------------------------------

/** The Workspace head's three places for a project (F41), each a real link. */
export function placeHrefs(project: string): Record<WsPlace, string> {
  return {
    agenda: agendaHref(project),
    backlog: backlogHref(project),
    docs: docsHref(project),
  };
}
