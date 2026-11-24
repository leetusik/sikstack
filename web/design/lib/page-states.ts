/**
 * Every page's states, as plain data: the state widget draws them (`states.tsx`) and the build's front page
 * (`app/page.tsx`) and manifest (`lib/pages.ts`, `scripts/build.mjs`) list them. Kept out of the "use client"
 * screens so a server module reads the lists themselves, not client references. A new page's states go here.
 */

export interface StateDef<K extends string> {
  key: K;
  /** The preset's words on the widget. */
  label: string;
  /** Where production draws it (a file and line, or a component), shown as the preset's tooltip. */
  from: string;
  /** The state is the page's data (the store), not a view over it. */
  data?: boolean;
}

export interface PageStates<K extends string> {
  page: string;
  list: readonly StateDef<K>[];
}

/** A page's states, typed by their keys; the first is the default. */
export function pageStates<const K extends string>(
  page: string,
  list: readonly StateDef<K>[],
): PageStates<K> {
  if (list.length === 0) throw new Error(`${page}: a page has at least one state`);
  return { page, list };
}

const WS = "src/app/(app)/projects/[projectId]/workspace";

/** The Agenda's states: every branch of its route (`page.tsx`, `loading.tsx`, `error.tsx`, `not-found.tsx`)
 * and the data shapes its parts draw. The data states put a data set from `answers.ts` in the store. */
export const AGENDA_STATES = pageStates("Agenda", [
  { key: "recorded", label: "Recorded", from: `${WS}/page.tsx:75 (ready) · data/sample/recording.json`, data: true },
  { key: "many", label: "Many items", from: `${WS}/page.tsx:75 (ready) · data/sample/states/many.json`, data: true },
  { key: "empty", label: "Empty agenda", from: "agenda-list.tsx:853 emptyText · data/sample/states/empty.json", data: true },
  { key: "waiting", label: "Waiting for sync", from: "agenda-list.tsx:760 unplaced, WaitingBadge · data/sample/states/waiting.json", data: true },
  { key: "web-waiting", label: "Note, feedback and accept waiting", from: "next/workspace/agenda/agenda-list.tsx:763 Proposed, rows WaitingBadge · data/sample/states/web-waiting.json", data: true },
  { key: "behind", label: "Synced long ago", from: "frame/sync-model.ts:44 behind (made: answers.ts)", data: true },
  { key: "loading", label: "Loading", from: `${WS}/loading.tsx` },
  { key: "unlinked", label: "Not linked", from: `${WS}/page.tsx:48 unlinked · data/sample/states/unlinked.json` },
  { key: "never", label: "Never synced", from: `${WS}/page.tsx:48 never · data/sample/states/never.json` },
  { key: "failed", label: "Read failed", from: `${WS}/page.tsx:66 error` },
  { key: "not-found", label: "Not found", from: `${WS}/page.tsx:46 notFound() → not-found.tsx` },
  { key: "error", label: "Page error", from: `${WS}/error.tsx` },
]);
const ITEM = `${WS}/agenda/[item]`;

/** An agenda item's states: every branch of its route (`page.tsx`, `load.ts`, `loading.tsx`, `error.tsx`)
 * and the item in each state the store can give it. The data states set this item's own fields. */
export const ITEM_STATES = pageStates("Agenda item", [
  { key: "open", label: "Open", from: "agenda-item/item-page.tsx (ready) · item.state open", data: true },
  { key: "proposed", label: "Proposed", from: "next/workspace/agenda-item/model.ts:131 headActions, head.tsx:111 · item.state proposed (recorded: A8-sf, A9-hb; made on another item from A9-hb's proposed)", data: true },
  { key: "note-waiting", label: "Note waiting for sync", from: "next/workspace/agenda-item/thread.tsx:99 WaitingBadge · entry.sync waiting (made: states/web-waiting.json's pending note, put on this item)", data: true },
  { key: "deferred", label: "Deferred", from: "agenda-item/item-page.tsx (ready) · item.state deferred", data: true },
  { key: "solved", label: "Solved", from: "agenda-item/item-page.tsx (ready) · item.state solved, its outcome", data: true },
  { key: "dropped", label: "Dropped", from: "agenda-item/item-page.tsx (ready) · item.state dropped, its reason", data: true },
  { key: "waiting", label: "Waiting for sync", from: "frame/waiting.tsx WaitingBadge · item.sync waiting (states/waiting.json)", data: true },
  { key: "loading", label: "Loading", from: `${ITEM}/loading.tsx` },
  { key: "not-found", label: "Not found", from: `${ITEM}/page.tsx:98 · load.ts:67 (no such item)` },
  { key: "project-not-found", label: "Project not found", from: `${ITEM}/page.tsx:65 notFound() → workspace/not-found.tsx` },
  { key: "failed", label: "Read failed", from: `${ITEM}/page.tsx:67 · load.ts:66 error` },
  { key: "error", label: "Page error", from: `${ITEM}/error.tsx` },
]);
const LIST = "src/sikstack/design/list.tsx";
const VIEW = "src/sikstack/design/viewer.tsx";

/** The Design list's states: the recorded list at each step of the publishes (`design-data.ts`). */
export const DESIGN_LIST_STATES = pageStates("Design", [
  { key: "many", label: "Many builds", from: `${LIST}:67 rows · data/sample/recording.json design.builds` },
  { key: "one", label: "One build", from: `${LIST}:67 rows · data/sample/states/design-one.json` },
  { key: "private", label: "A private build", from: `${LIST}:84 Private · data/sample/states/design-private.json` },
  { key: "shared", label: "A shared build", from: `${LIST}:88 Shared · data/sample/states/design-shared.json` },
  { key: "empty", label: "No builds yet", from: `${LIST}:42 none · data/sample/states/design-empty.json` },
]);
/** The viewer's states: the build's own, or a recorded build in the state named; gone is the API's 404. */
export const DESIGN_BUILD_STATES = pageStates("Design build", [
  { key: "no-options", label: "No options", from: `${VIEW}:270 pages · recording design.details (no manifest options)` },
  { key: "options", label: "Options", from: `${VIEW}:236 options side by side · recording design.details (manifest options)` },
  { key: "shared", label: "Shared", from: `${VIEW}:202 share on, Copy · recording design.details (share.on)` },
  { key: "private", label: "Private", from: `${VIEW}:198 one line · recording design.shareRefused (409)` },
  { key: "gone", label: "Gone", from: `${VIEW}:293 DesignBuildGone · recording design.gone (404)` },
]);

const FB = "src/sikstack/feedback";
const NEXT_FB = "next/feedback/agenda";
const FB_ROUTE = "src/app/(app)/projects/[projectId]/feedback/[feedbackId]";

/**
 * A piece of feedback not on the agenda yet (P61-e9; f3 of the recording): today's page first, as production draws it
 * now (the add never offered), then the next version's add in each of its phases, its waiting answer, and the routes'
 * branches.
 */
export const FEEDBACK_STATES = pageStates("Feedback item", [
  { key: "offered", label: "Add to agenda", from: `${FB}/item/body.tsx:126 offered (never mounted today) · ${NEXT_FB}/control.tsx · recording f3, on no item`, data: true },
  { key: "today", label: "Today (not offered)", from: `${FB}/item/body.tsx:139 · lib/feedback/agenda.ts:74 canAdd: no workspace, never offered` },
  { key: "confirm-new", label: "Confirm: a new item", from: `${NEXT_FB}/control.tsx:163 isOpen, :179 the choice (A new item)` },
  { key: "confirm-existing", label: "Confirm: an existing item", from: `${NEXT_FB}/control.tsx:179 the choice (A3-1z picked)` },
  { key: "adding", label: "Adding", from: `${NEXT_FB}/control.tsx:163 isLocked (Adding…)` },
  { key: "failed", label: "Add failed", from: `${NEXT_FB}/control.tsx:174 failed notice` },
  { key: "waiting", label: "Added, waiting for sync", from: `${NEXT_FB}/part.tsx:43, :87 · data/sample/states/web-waiting.json (f3 on A11-vz, waiting)`, data: true },
  { key: "no-project", label: "No project", from: `${NEXT_FB}/part.tsx:38 not offered, no project (made: no recorded feedback is in no project)` },
  { key: "loading", label: "Loading", from: `${FB_ROUTE}/loading.tsx` },
  { key: "not-found", label: "Not found", from: `${FB_ROUTE}/not-found.tsx` },
  { key: "error", label: "Page error", from: `${FB_ROUTE}/error.tsx` },
]);

/** A piece of feedback already on the agenda (f1: a new item and A3-1z; f2: A3-1z): the part names each item. */
export const FEEDBACK_FILED_STATES = pageStates("Feedback item on the agenda", [
  { key: "filed", label: "On the agenda", from: `${NEXT_FB}/part.tsx:43 one row an item · recording.json feedback (GET /app/feedback/{id}/agenda)`, data: true },
  { key: "today", label: "Today (not offered)", from: `${FB}/item/body.tsx:139 · lib/feedback/agenda.ts:98 sent() finds nothing today` },
]);
