/**
 * The Workspace's addresses: every page under `/projects/<id>/workspace`, built here and only here,
 * and the way back from an item to the list page it was opened from.
 *
 * - `/projects/<id>/workspace`: the Agenda;
 * - `…/workspace/agenda/<item>`;
 * - `…/workspace/backlog` (`?archived=N`), `…/workspace/phases/<phase>`, `…/workspace/slices/<slice>`;
 * - `…/workspace/docs`, `…/workspace/docs/<doc>`, `…/workspace/docs/<doc>?version=<stored id>`.
 *
 * The deferred jobs pages are retired (P61-e9): `…/workspace/deferred` redirects to the Agenda, and
 * `…/workspace/deferred/<job>` to the item its fold entry names (`retiredJobHref`).
 *
 * Pages are 1-based in the address and page 1 is written as no key (F300). A filter or a search
 * resets the page: the caller passes no page with a new filter.
 *
 * **The way back** (F300: "the way back from an item returns to the page it was opened from") rides
 * in `?from=` on the item's address: the list's own address. `decodeWorkspaceFrom` is the
 * Workspace's own decoder (modelled on the Library's `decodeFrom`, which it never widens): it
 * admits only a Workspace list address of the **same project**, with the list's known keys and
 * their real charsets, each once, and rebuilds the list from those parts. Anything else (a foreign
 * path, another project, an unknown or repeated key, a value outside its charset, an escaped
 * segment, a hash) is no list at all, and the item goes back to its own default.
 *
 * The way back names its destination by a key (`to`), never by text from the address: the page
 * draws the destination's own name (F36).
 *
 * Deliberately NOT `server-only`: pages decode on the server, and client islands build links.
 */

import { safeNextPath } from "@/lib/next-path";

/** The query key that carries where an item was opened from. */
export const FROM_PARAM = "from";

/** A Workspace list page an item can be opened from, at its place. */
export type WorkspaceList =
  | { list: "agenda" }
  | { list: "backlog"; archived?: number }
  | { list: "docs" };

/** A list page's own address keys. */
const LIST_KEYS: Record<WorkspaceList["list"], readonly string[]> = {
  agenda: [],
  backlog: ["archived"],
  docs: [],
};

const PAGE = /^[1-9][0-9]{0,5}$/;
/** A project id as the server writes it (`projects.id`, a UUID), unescaped. */
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,35}$/;
const PARSE_BASE = "https://from.invalid";

function seg(value: string): string {
  return encodeURIComponent(value);
}

function base(project: string): string {
  return `/projects/${seg(project)}/workspace`;
}

/** A page number for the address: 1-based, page 1 (or anything not a page) written as none. */
function pageValue(page: number | undefined): string | null {
  return page !== undefined && Number.isInteger(page) && page > 1
    ? String(page)
    : null;
}

function withQuery(path: string, query: URLSearchParams): string {
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

// -- the list pages ----------------------------------------------------------------------------

/** The Workspace: it opens on the Agenda (F41). */
export function workspaceHref(project: string): string {
  return base(project);
}

/** The Agenda (it has no paged part: Deferred is gone). */
export function agendaHref(project: string): string {
  return base(project);
}

/** The backlog, at the Archived phases' page. */
export function backlogHref(
  project: string,
  place: { archived?: number } = {},
): string {
  const query = new URLSearchParams();
  const page = pageValue(place.archived);
  if (page) query.set("archived", page);
  return withQuery(`${base(project)}/backlog`, query);
}

/** The docs list. */
export function docsHref(project: string): string {
  return `${base(project)}/docs`;
}

/** A list page's address at its place. */
export function listHref(project: string, list: WorkspaceList): string {
  switch (list.list) {
    case "agenda":
      return agendaHref(project);
    case "backlog":
      return backlogHref(project, { archived: list.archived });
    case "docs":
      return docsHref(project);
  }
}

// -- the item pages ----------------------------------------------------------------------------

function itemHref(
  path: string,
  project: string,
  from: WorkspaceList | null | undefined,
  query: URLSearchParams = new URLSearchParams(),
): string {
  if (from) query.set(FROM_PARAM, listHref(project, from));
  return withQuery(path, query);
}

/** An agenda item's page. */
export function agendaItemHref(
  project: string,
  item: string,
  from?: WorkspaceList | null,
): string {
  return itemHref(`${base(project)}/agenda/${seg(item)}`, project, from);
}

/** A phase's page, by its full id. */
export function phaseHref(
  project: string,
  phase: string,
  from?: WorkspaceList | null,
): string {
  return itemHref(`${base(project)}/phases/${seg(phase)}`, project, from);
}

/** A slice's page, by its full id (`P8-q4.S1`). */
export function sliceHref(
  project: string,
  slice: string,
  from?: WorkspaceList | null,
): string {
  return itemHref(`${base(project)}/slices/${seg(slice)}`, project, from);
}

/**
 * Where a retired deferred job's old address leads (P61-e9): the agenda item whose fold entry carries the job, or
 * the Agenda when no entry names it (or the lookup failed).
 */
export function retiredJobHref(project: string, agenda: string | null): string {
  return agenda ? agendaItemHref(project, agenda) : agendaHref(project);
}

/** A doc's page, at its latest version or the stored version named (`v0002`, never `v2`). */
export function docHref(
  project: string,
  doc: string,
  place: { version?: string | null } = {},
  from?: WorkspaceList | null,
): string {
  const query = new URLSearchParams();
  if (place.version) query.set("version", place.version);
  return itemHref(`${base(project)}/docs/${seg(doc)}`, project, from, query);
}

// -- the way back ------------------------------------------------------------------------------

function pageOf(value: string): number | null {
  return PAGE.test(value) ? Number(value) : null;
}

/**
 * The list a `?from=` value names, when it is a Workspace list page of `project`; else null.
 * Never throws. Strict: one unknown, repeated or malformed part rejects the whole value.
 */
export function decodeWorkspaceFrom(
  raw: string | string[] | null | undefined,
  project: string,
): WorkspaceList | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // What `safeNextPath` refuses or rewrites (control characters, `\`, `//`, encoded slashes,
  // `..`) is no address our links wrote.
  if (safeNextPath(raw) !== raw) return null;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return null;
  }
  if (url.origin !== PARSE_BASE || url.hash !== "") return null;
  // Segments are matched as they stand, never decoded: an escape matches no segment of ours.
  const segments = url.pathname.split("/").slice(1);
  if (
    segments.length < 3 ||
    segments[0] !== "projects" ||
    segments[2] !== "workspace" ||
    !PROJECT_ID.test(segments[1]) ||
    segments[1] !== project
  ) {
    return null;
  }
  const rest = segments.slice(3);
  let list: WorkspaceList["list"];
  if (rest.length === 0) list = "agenda";
  else if (rest.length === 1 && rest[0] === "backlog") list = "backlog";
  else if (rest.length === 1 && rest[0] === "docs") list = "docs";
  else return null;

  const allowed = LIST_KEYS[list];
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) return null;
    seen.add(key);
  }
  const value = (key: string) => url.searchParams.get(key);

  switch (list) {
    case "agenda":
      return { list };
    case "backlog": {
      const raw = value("archived");
      if (raw === null) return { list };
      const page = pageOf(raw);
      return page === null ? null : { list, archived: page };
    }
    case "docs":
      return { list };
  }
}

/** The item a way back belongs to. */
export type WayBackItem =
  | { kind: "agenda-item" }
  | { kind: "phase" }
  | { kind: "doc" }
  /** A slice goes back to its phase (its full id), carrying the phase's own way back. */
  | { kind: "slice"; phase: string }
  /** An earlier version goes back to its doc, at its latest version. */
  | { kind: "doc-version"; doc: string };

/** Where a way back leads; the page labels it with that place's or record's own name (F36). */
export type WayBackTo = "agenda" | "backlog" | "docs" | "phase" | "doc";

/** The list each item kind goes back to, and the one list it trusts a `from` for. */
const HOME: Record<WayBackItem["kind"], WorkspaceList["list"]> = {
  "agenda-item": "agenda",
  phase: "backlog",
  doc: "docs",
  slice: "backlog",
  "doc-version": "docs",
};

/**
 * The way back from an item (F36, F300): its own list (the Agenda from an item, the backlog from a
 * phase, Docs from a doc), at the page `from` names when `from` is that same
 * list; a slice goes back to its phase and an earlier version to its doc, each carrying that
 * `from` on. A `from` of another list is ignored, so the label (the destination's name) always
 * matches where the link leads. `list` is the `from` kept, for the item's own links to pass on.
 */
export function wayBack(
  project: string,
  item: WayBackItem,
  from: WorkspaceList | null,
): { href: string; to: WayBackTo; list: WorkspaceList | null } {
  const home = HOME[item.kind];
  const list = from && from.list === home ? from : null;
  switch (item.kind) {
    case "slice":
      return { href: phaseHref(project, item.phase, list), to: "phase", list };
    case "doc-version":
      return { href: docHref(project, item.doc, {}, list), to: "doc", list };
    default:
      return {
        href: listHref(project, list ?? ({ list: home } as WorkspaceList)),
        to: home,
        list,
      };
  }
}
