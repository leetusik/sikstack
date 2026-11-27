/**
 * sikstack Feedback (`04-feedback` round 02, F128, F134, F340) — the addresses every Feedback surface
 * reads: the list's place, the project the Shell shows, and the way back from a piece of feedback.
 *
 * - **The scope** is the project picked in the Shell, or none for the org's own Feedback. It is a
 *   route of its own, as a project's library is (`/projects/{id}/library`): the org's list is
 *   `/feedback`, a project's is `/projects/{id}/feedback`; one piece of feedback is
 *   `/feedback/{feedbackId}` or `/projects/{id}/feedback/{feedbackId}`, so the item keeps the Shell
 *   its list showed. The Shell reads the scope from the path alone (`sikstack/shell/model.ts`).
 * - **The place** is the list's query: `page`, `q`, `project` (the bar's project filter, the org's
 *   list only: a project's list has no select), `rating` (`liked` | `disliked`) and `state` (the one
 *   state the list shows, P91-v3: `filed` | `resolved` | `dropped`; Open, the default, is no `state`).
 *   Blanks are absent; page 1 is no `page`. The org's list filtered to a project (`/feedback?project={id}`)
 *   keeps the org's Shell: the filter is never the scope.
 * - **The way back** rides in one query value, `?from=`, on the item's address: the list's own
 *   address, built here. It is laundered as the Library's `decodeFrom` (`lib/library/from.ts`) is:
 *   `safeNextPath` leaves it unchanged, it is the list of the item's own scope, its keys are the
 *   list's and each once, its values read; it is rebuilt from those parts, never echoed. Anything
 *   else is the list at rest.
 *
 * Pure, and NOT `server-only`: the pages read it on the server and the list's parts build links in
 * the browser.
 */

import type { FeedbackStateName } from "@/content/feedback-state";
import { safeNextPath } from "@/lib/next-path";

/** A rating filter, as the address writes it. `unrated` is no filter (the API has none). */
export type FeedbackRating = "liked" | "disliked";

/** The project the Shell shows (its id), or `null` for the org's own Feedback. */
export type FeedbackScope = string | null;

/** The list's place, as the page reads its address. */
export interface FeedbackPlace {
  /** 1-based; the page past the last is the page's to answer. */
  page: number;
  /** The search, trimmed; empty for none. */
  q: string;
  /** The bar's project filter (a project id), or null for All projects. Always null in a project's list. */
  project: string | null;
  /** The rating filter, or null for Any rating. */
  rating: FeedbackRating | null;
  /** The state the list shows (P91-v3): Open by default. Neither a search nor a filter: Clear keeps it. */
  state: FeedbackStateName;
}

/** An address no list answers: the page shows No such view. */
export interface InvalidPlace {
  invalid: true;
}

/** The list at rest: no search, no filter, the first page. */
export const AT_REST: Readonly<FeedbackPlace> = Object.freeze({
  page: 1,
  q: "",
  project: null,
  rating: null,
  state: "open",
});

export const NO_SUCH_VIEW: Readonly<InvalidPlace> = Object.freeze({
  invalid: true,
});

/** The query key that carries the list an item was opened from. */
export const FROM_PARAM = "from";

const FEEDBACK = "/feedback";
const PAGE = /^[1-9][0-9]{0,5}$/;
const RATINGS: readonly FeedbackRating[] = ["liked", "disliked"];
/** The states the list shows; `open` reads as no `state` and is never written. */
const STATES: readonly FeedbackStateName[] = [
  "open",
  "filed",
  "resolved",
  "dropped",
];
/** The keys each list's address has, in the order they are written. */
const ORG_KEYS = ["page", "q", "project", "rating", "state"] as const;
const PROJECT_KEYS = ["page", "q", "rating", "state"] as const;
const PARSE_BASE = "https://feedback-from.invalid";

type Params = Record<string, string | string[] | null | undefined>;

function one(value: string | string[] | null | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v.trim() : "";
}

function keysOf(scope: FeedbackScope) {
  return scope === null ? ORG_KEYS : PROJECT_KEYS;
}

/** Whether the address read as No such view. */
export function isInvalid(
  place: FeedbackPlace | InvalidPlace,
): place is InvalidPlace {
  return "invalid" in place;
}

/**
 * The list's place from its address (`searchParams`), or No such view for a page that is not a
 * whole number from 1, a rating other than `liked` and `disliked`, or a state the list does not show
 * (`all` among them: the list has no All view). A repeated key reads its first
 * value; a blank one is absent; a key the list does not have is never read. Never throws.
 */
export function readFeedbackPlace(
  params: Params,
  scope: FeedbackScope = null,
): FeedbackPlace | InvalidPlace {
  const page = one(params.page);
  if (page !== "" && !PAGE.test(page)) return NO_SUCH_VIEW;
  const rating = one(params.rating);
  if (rating !== "" && !RATINGS.includes(rating as FeedbackRating))
    return NO_SUCH_VIEW;
  const state = one(params.state);
  if (state !== "" && !STATES.includes(state as FeedbackStateName))
    return NO_SUCH_VIEW;
  const project = scope === null ? one(params.project) : "";
  return {
    page: page === "" ? 1 : Number(page),
    q: one(params.q),
    project: project || null,
    rating: (rating || null) as FeedbackRating | null,
    state: (state || "open") as FeedbackStateName,
  };
}

/**
 * Whether the list answers this place in this org (No such view when not): a place that read, whose
 * project filter, if any, is one of the org's projects.
 */
export function valid(
  org: { projects: readonly { id: string }[] },
  place: FeedbackPlace | InvalidPlace,
): place is FeedbackPlace {
  if (isInvalid(place)) return false;
  return (
    place.project === null || org.projects.some((p) => p.id === place.project)
  );
}

/** A search or a filter is set: the count line reads the matches, and Clear shows. */
export function isFiltered(place: FeedbackPlace): boolean {
  return place.q !== "" || place.project !== null || place.rating !== null;
}

/** The API's `feedback_value` for a rating filter (1 Liked, 2 Disliked). */
export function ratingValue(rating: FeedbackRating): 1 | 2 {
  return rating === "liked" ? 1 : 2;
}

/** The list's path for a scope: `/feedback`, or `/projects/{id}/feedback`. */
function listPath(scope: FeedbackScope): string {
  return scope === null
    ? FEEDBACK
    : `/projects/${encodeURIComponent(scope)}${FEEDBACK}`;
}

function query(scope: FeedbackScope, place: Partial<FeedbackPlace>): string {
  const search = new URLSearchParams();
  for (const key of keysOf(scope)) {
    const value = place[key];
    if (key === "page") {
      if (typeof value === "number" && Number.isInteger(value) && value > 1)
        search.set("page", String(value));
    } else if (key === "state") {
      if (value !== "open" && STATES.includes(value as FeedbackStateName))
        search.set("state", value as string);
    } else if (typeof value === "string" && value.trim() !== "") {
      search.set(key, value.trim());
    }
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * The list at rest for what the Shell shows (no search, no filter, the first page): the rail's
 * Feedback, Clear, No such view's Back to Feedback, project home's foot.
 */
export function feedbackHref(scope: FeedbackScope = null): string {
  return listPath(scope);
}

/** The list at a place (blank parts and page 1 left out of the address). */
export function feedbackListHref(
  scope: FeedbackScope,
  place: Partial<FeedbackPlace>,
): string {
  return `${listPath(scope)}${query(scope, place)}`;
}

/** Page `n` of the list: the search and filters kept (the pager's `hrefFor`). */
export function feedbackPageHref(
  scope: FeedbackScope,
  place: FeedbackPlace,
  n: number,
): string {
  return feedbackListHref(scope, { ...place, page: n });
}

/** What a search, the project select, a rating toggle or the state filter changes. */
export type FeedbackChange = Partial<
  Pick<FeedbackPlace, "q" | "project" | "rating" | "state">
>;

/** The place after a search, a filter or a state change: the rest kept, and the first page. */
export function withChange(
  place: FeedbackPlace,
  change: FeedbackChange,
): FeedbackPlace {
  return { ...place, ...change, page: 1 };
}

/** The list's address after a search or a filter change (the first page). */
export function feedbackChangeHref(
  scope: FeedbackScope,
  place: FeedbackPlace,
  change: FeedbackChange,
): string {
  return feedbackListHref(scope, withChange(place, change));
}

/**
 * One piece of feedback, in the Shell its list showed: `/feedback/{id}` or
 * `/projects/{scope}/feedback/{id}`, with `?from=` the list's address when the list was not at rest
 * (at rest the way back needs none).
 */
export function feedbackItemHref(
  scope: FeedbackScope,
  feedbackId: string,
  from?: FeedbackPlace | null,
): string {
  const path = `${listPath(scope)}/${encodeURIComponent(feedbackId)}`;
  const back = from ? query(scope, from) : "";
  if (back === "") return path;
  return `${path}?${new URLSearchParams({ [FROM_PARAM]: `${listPath(scope)}${back}` })}`;
}

/**
 * The list a `?from=` value names, for an item in `scope`: the list's place when the value is that
 * scope's list address as our links write it, else the list at rest. Rejected: a missing, empty or
 * repeated value; what `safeNextPath` refuses or rewrites (`//host`, `https:`, `\`, control
 * characters, `..`); another path (`/library`, another scope's list); a hash; a key the list does
 * not have, or one given twice; a value the list does not read (`rating=unrated`, `page=0`,
 * `state=all`).
 * Never throws.
 */
export function decodeFeedbackFrom(
  raw: string | string[] | null | undefined,
  scope: FeedbackScope,
): FeedbackPlace {
  const rest = { ...AT_REST };
  if (typeof raw !== "string" || raw.length === 0) return rest;
  if (safeNextPath(raw) !== raw) return rest;
  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return rest;
  }
  if (url.origin !== PARSE_BASE || url.hash !== "") return rest;
  if (url.pathname !== listPath(scope)) return rest;
  const keys: readonly string[] = keysOf(scope);
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key) || seen.has(key)) return rest;
    seen.add(key);
  }
  const place = readFeedbackPlace(Object.fromEntries(url.searchParams), scope);
  return isInvalid(place) ? rest : place;
}

/**
 * The way back from an item (`a.back` Feedback, and Back to Feedback in its error and not-found
 * blocks): the list's last address, laundered; the list at rest for the item's scope otherwise.
 */
export function feedbackBackHref(
  scope: FeedbackScope,
  raw: string | string[] | null | undefined,
): string {
  return feedbackListHref(scope, decodeFeedbackFrom(raw, scope));
}
