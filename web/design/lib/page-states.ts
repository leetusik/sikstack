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
  { key: "web-waiting", label: "Note, feedback and accept waiting", from: "agenda/agenda-list.tsx Proposed, rows WaitingBadge · data/sample/states/web-waiting.json", data: true },
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
  { key: "proposed", label: "Proposed", from: "agenda-item/model.ts headActions, head.tsx HeadMarks · item.state proposed (recorded: A8-sf, A9-hb; made on another item from A9-hb's proposed)", data: true },
  { key: "note-waiting", label: "Note waiting for sync", from: "agenda-item/thread.tsx WaitingBadge · entry.sync waiting (made: states/web-waiting.json's pending note, put on this item)", data: true },
  { key: "items", label: "Items done and dismissed", from: "agenda-item/thread.tsx items · entry.state done, dismissed (made: the agenda's first item done, its second dismissed)", data: true },
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
const FB_AGENDA = "src/sikstack/feedback/agenda";
const FB_ROUTE = "src/app/(app)/projects/[projectId]/feedback/[feedbackId]";

/**
 * A piece of feedback not on the agenda yet (P61-e9; f3 of the recording): the add in each of its phases, its waiting
 * answer, the two not-offered answers (no workspace linked, no project), and the routes' branches.
 */
export const FEEDBACK_STATES = pageStates("Feedback item", [
  { key: "offered", label: "Add to agenda", from: `${FB}/item/body.tsx offered (linked, on no item) · ${FB_AGENDA}/control.tsx · recording f3, on no item`, data: true },
  { key: "no-workspace", label: "No workspace linked", from: `${FB}/item/body.tsx not offered · lib/feedback/agenda.ts canAdd: linked false` },
  { key: "confirm-new", label: "Confirm: a new item", from: `${FB_AGENDA}/control.tsx:163 isOpen, :179 the choice (A new item)` },
  { key: "confirm-existing", label: "Confirm: an existing item", from: `${FB_AGENDA}/control.tsx:179 the choice (A3-1z picked)` },
  { key: "adding", label: "Adding", from: `${FB_AGENDA}/control.tsx:163 isLocked (Adding…)` },
  { key: "failed", label: "Add failed", from: `${FB_AGENDA}/control.tsx:174 failed notice` },
  { key: "waiting", label: "Added, waiting for sync", from: `${FB_AGENDA}/part.tsx:43, :87 · data/sample/states/web-waiting.json (f3 on A11-vz, waiting)`, data: true },
  { key: "no-project", label: "No project", from: `${FB_AGENDA}/part.tsx:38 not offered, no project (made: no recorded feedback is in no project)` },
  { key: "loading", label: "Loading", from: `${FB_ROUTE}/loading.tsx` },
  { key: "not-found", label: "Not found", from: `${FB_ROUTE}/not-found.tsx` },
  { key: "error", label: "Page error", from: `${FB_ROUTE}/error.tsx` },
]);

/** A piece of feedback already on the agenda (f1: a new item and A3-1z; f2: A3-1z): the part names each item. */
export const FEEDBACK_FILED_STATES = pageStates("Feedback item on the agenda", [
  { key: "filed", label: "On the agenda", from: `${FB_AGENDA}/part.tsx:43 one row an item · recording.json feedback (GET /app/feedback/{id}/agenda)`, data: true },
  { key: "no-workspace", label: "No workspace linked", from: `${FB}/item/body.tsx not offered · lib/feedback/agenda.ts canAdd: linked false, sent() none` },
]);

// ── The org surfaces (P78-s2.S2's design): applied by P78-s2.S4, so each `from` names production's file
// and line (applied: `src/sikstack/shell/shell.tsx`, `src/sikstack/org/`). Their data is made (`org-data.ts`).
const SHELL_NEXT = "src/sikstack/shell/shell.tsx";
const ORG = "src/sikstack/org";

/** The org switcher, in the top bar of every app page (drawn here over org home's address). */
export const ORG_SWITCHER_STATES = pageStates("Org switcher", [
  { key: "several", label: "Several orgs, menu open", from: `${SHELL_NEXT}:169 open === "org", :188 aria-current · org-data.ts OTHER_ORGS (made)` },
  { key: "one", label: "One org, menu open", from: `${SHELL_NEXT}:169 the menu for one org too, :206 New org · recording shell.org` },
  { key: "closed", label: "Menu closed", from: `${SHELL_NEXT}:163 the crumb's button, its chevron` },
]);

/** New org (`/orgs/new`). */
export const NEW_ORG_STATES = pageStates("New org", [
  { key: "ready", label: "Ready", from: `${ORG}/new-org.tsx:100 phase ready` },
  { key: "empty", label: "No name", from: `${ORG}/new-org.tsx:61 phase empty (checkOrgName)` },
  { key: "taken", label: "Name taken", from: `${ORG}/new-org.tsx:61 phase taken (the API's answer; made: org-data.ts designCreate)` },
  { key: "creating", label: "Creating", from: `${ORG}/new-org.tsx:138 busy, Creating…` },
  { key: "failed", label: "Create failed", from: `${ORG}/new-org.tsx:101 the notice (no answer)` },
]);

/** Members (`/members`): the owner's view in each phase of the invite form, then a member's view. */
export const MEMBERS_STATES = pageStates("Members", [
  { key: "members", label: "Members and invites", from: `${ORG}/members.tsx:179 members, :289 invites · org-data.ts (made)` },
  { key: "owner-only", label: "Only the owner", from: `${ORG}/members.tsx:312 no invites, Invite primary · org-data.ts OWNER (made)` },
  { key: "open", label: "Invite form open", from: `${ORG}/members.tsx:224 phase open` },
  { key: "sending", label: "Sending", from: `${ORG}/members.tsx:269 busy, Sending…` },
  { key: "sent", label: "Invite sent", from: `${ORG}/members.tsx:127 the row first, the toast` },
  { key: "not-address", label: "Not an address", from: `${ORG}/members.tsx:102 phase address (looksLikeEmail)` },
  { key: "already-member", label: "Already a member", from: `${ORG}/members.tsx:102 phase member (the API's refusal; made)` },
  { key: "already-invited", label: "Already invited", from: `${ORG}/members.tsx:102 phase invited (the API's refusal; made)` },
  { key: "send-failed", label: "Send failed", from: `${ORG}/members.tsx:226 the notice (no answer)` },
  { key: "member-view", label: "A member's view", from: `${ORG}/members.tsx:200 owner false: no Invites panel` },
]);

/** The invite link (`/invite?code=…`), in the sign-in frame. */
export const INVITE_STATES = pageStates("Invite", [
  { key: "out", label: "Signed out", from: `${ORG}/invite.tsx:102 phase out, the sign-in pair` },
  { key: "ready", label: "Signed in, invited address", from: `${ORG}/invite.tsx:148 phase ready, Join` },
  { key: "joining", label: "Joining", from: `${ORG}/invite.tsx:148 phase joining, Joining…` },
  { key: "failed", label: "Join failed", from: `${ORG}/invite.tsx:95 phase failed, the notice` },
  { key: "other", label: "Another account", from: `${ORG}/invite.tsx:163 phase other (model.ts invitePhase)` },
  { key: "member", label: "Already a member", from: `${ORG}/invite.tsx:181 phase member` },
  { key: "expired", label: "Expired, revoked or used", from: `${ORG}/invite.tsx:193 phase expired (one state for the three)` },
]);

// ── The landing (P83-8k.S1's design, the landing around the plugin): production's route branches, drawn by the
// next `Landing` (`next/landing/landing.tsx`); the header is production's (`src/sikstack/landing/header.tsx`).
const MKT = "src/app/(marketing)/page.tsx";
const LP_NEXT = "next/landing/landing.tsx";
const LP_HEAD = "src/sikstack/landing/header.tsx";

/** The landing (`/`): who reads it, and whether the server holds the feedback control's key. */
export const LANDING_STATES = pageStates("Landing", [
  { key: "signed-out", label: "Signed out", from: `${MKT}:30 signedIn false, :31 key held (as on sikstack.com) · ${LP_NEXT}:119 Create account, Sign in; :224 Send feedback · ${LP_HEAD}:65 Sign in, Create account` },
  { key: "signed-in", label: "Signed in", from: `${MKT}:16 optionalIdentity, :30 signedIn true · ${LP_NEXT}:119 Open dashboard · ${LP_HEAD}:65 Dashboard` },
  { key: "no-feedback-key", label: "No feedback key", from: `${MKT}:31 feedback.configured false · ${LP_NEXT}:224 the footer's links alone` },
]);
export type LandingState = (typeof LANDING_STATES.list)[number]["key"];
