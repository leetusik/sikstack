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
  { key: "round", label: "A round's build", from: `${VIEW} roundPages, the options hidden (roundShowsOptions), the whole design's link · data/sample/states/design-round.json (manifest round)` },
  { key: "options-only", label: "A round of the options", from: `${VIEW} optionsOnly (roundPages []) · data/sample/states/design-options-round.json (round: the options entry)` },
  { key: "every-page", label: "Every page", from: `${VIEW} scope="all", the options and every page · …/design/[build]/pages/page.tsx · data/sample/states/design-round.json` },
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

/** The org switcher, in the top bar of every app page (drawn here over org home's address). Since P88-ms.S3's
 * design it is drawn by the Shell's next version (`next/shell/shell.tsx`), whose lines the `from`s name. */
const SHELL_P88 = "design/next/shell/shell.tsx";
export const ORG_SWITCHER_STATES = pageStates("Org switcher", [
  { key: "several", label: "Several orgs, menu open", from: `${SHELL_P88}:216 open === "org", :235 aria-current · org-data.ts OTHER_ORGS (made)` },
  { key: "same-name", label: "Two orgs with the same name", from: `${SHELL_P88}:245 OrgLineText, :427 Owned by · next/shell/model.ts:38 orgLine · org-data.ts SAME_NAME_ORG (made: no API answers an org's owner yet)` },
  { key: "one", label: "One org, menu open", from: `${SHELL_P88}:216 the menu for one org too, New org · recording shell.org` },
  { key: "closed", label: "Menu closed", from: `${SHELL_P88} the crumb's button, its chevron` },
]);

/** New org (`/orgs/new`). */
export const NEW_ORG_STATES = pageStates("New org", [
  { key: "ready", label: "Ready", from: `${ORG}/new-org.tsx:100 phase ready` },
  { key: "empty", label: "No name", from: `${ORG}/new-org.tsx:61 phase empty (checkOrgName)` },
  { key: "taken", label: "Name taken", from: `${ORG}/new-org.tsx:61 phase taken (the API's answer; made: org-data.ts designCreate)` },
  { key: "creating", label: "Creating", from: `${ORG}/new-org.tsx:138 busy, Creating…` },
  { key: "failed", label: "Create failed", from: `${ORG}/new-org.tsx:101 the notice (no answer)` },
]);

// ── The settings pages (P88-ms.S3's design): new components in `design/next/` (applied by a later slice), so each
// `from` names the next file and line. Their data is made (`org-data.ts`, Settings). `/members` (P78-s2.S2's page)
// is a part of Org settings now; the invite form's phases (P78's Members states) are unchanged and not listed again.
const N = "design/next";

/** Org settings (`/settings`): who is looking, the invites, the delete dialog's phases, the API's refusals. */
export const ORG_SETTINGS_STATES = pageStates("Org settings", [
  { key: "owner", label: "Owner, pending invites", from: `${N}/org/settings.tsx:88 owner: NamePanel, UrlPanel, :105 Delete org · ${N}/org/members.tsx:463 invites · org-data.ts (made)` },
  { key: "no-invites", label: "Owner, no invites", from: `${N}/org/members.tsx:394 Invite primary, no invites · org-data.ts OWNER alone (made)` },
  { key: "two-owners", label: "Owner with another owner", from: `${N}/org/model.ts:106 Step down, Leave on the account's row · org-data.ts MEMBERS_TWO_OWNERS, ORG_SLUG (made)` },
  { key: "member", label: "A member's view", from: `${N}/org/settings.tsx:98 NameReadPanel, :100 UrlReadPanel, no Delete org · ${N}/org/members.tsx:386 no Invites` },
  { key: "delete-empty", label: "Delete org: empty", from: `${N}/frame/delete-dialog.tsx:157 Delete off until the name matches` },
  { key: "delete-wrong", label: "Delete org: name typed wrong", from: `${N}/frame/delete-dialog.tsx:84 typedNameWrong, :144 the field's error` },
  { key: "delete-right", label: "Delete org: name typed right", from: `${N}/frame/delete-dialog.tsx:157 Delete ready (typedNameMatches)` },
  { key: "deleting", label: "Deleting", from: `${N}/frame/delete-dialog.tsx:90 phase deleting, Deleting…, locked` },
  { key: "delete-failed", label: "Delete failed", from: `${N}/frame/delete-dialog.tsx:105 the notice (no answer)` },
  { key: "tenant-one", label: "Refused: the server's own org", from: `${N}/frame/delete-dialog.tsx:82 refused · DELETE /app/tenant 409 tenant_one (made)` },
  { key: "last-owner", label: "Step down refused: last owner", from: `${N}/org/members.tsx:89 stepDownLastOwner, the toast · POST /app/members/{id}/member 409 last_owner (made)` },
]);

/** Project settings (`/projects/<id>/settings`): who is looking, the delete dialog's phases, the API's refusals. */
export const PROJECT_SETTINGS_STATES = pageStates("Project settings", [
  { key: "owner", label: "Owner", from: `${N}/project/settings.tsx:77 Make public, :141 Keys, :143 Delete project · org-data.ts PROJECT_KEYS (made)` },
  { key: "member", label: "A member's view", from: `${N}/project/settings.tsx:77 owner false: the badge alone, no Delete project` },
  { key: "delete-empty", label: "Delete project: empty", from: `${N}/frame/delete-dialog.tsx:157 Delete off until the name matches` },
  { key: "delete-wrong", label: "Delete project: name typed wrong", from: `${N}/frame/delete-dialog.tsx:84 typedNameWrong, :144 the field's error` },
  { key: "delete-right", label: "Delete project: name typed right", from: `${N}/frame/delete-dialog.tsx:157 Delete ready (typedNameMatches)` },
  { key: "deleting", label: "Deleting", from: `${N}/frame/delete-dialog.tsx:90 phase deleting, Deleting…, locked` },
  { key: "delete-failed", label: "Delete failed", from: `${N}/frame/delete-dialog.tsx:105 the notice (no answer)` },
  { key: "install-feedback", label: "Refused: install feedback", from: `${N}/frame/delete-dialog.tsx:82 refused · DELETE /app/projects/{id} 409 install_feedback (made)` },
  { key: "tracked-path", label: "Refused: a site folder's name", from: `${N}/frame/delete-dialog.tsx:82 refused · DELETE /app/projects/{id} 409 tracked_path (made)` },
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

// ── The landing (P87's design, applied: the "sik" mark in its header and the open-source section): production's
// route branches, drawn by production's `Landing` and its header.
const MKT = "src/app/(marketing)/page.tsx";
const LP = "src/sikstack/landing/landing.tsx";
const LP_HEAD = "src/sikstack/landing/header.tsx";

/** The landing (`/`): who reads it, and whether the server holds the feedback control's key. */
export const LANDING_STATES = pageStates("Landing", [
  { key: "signed-out", label: "Signed out", from: `${MKT}:30 signedIn false, :31 key held (as on sikstack.com) · ${LP}:72 Create account, Sign in; :459 Send feedback under Contribute, :505 in the footer · ${LP_HEAD}:70 Sign in, Create account` },
  { key: "signed-in", label: "Signed in", from: `${MKT}:18 optionalIdentity, :30 signedIn true · ${LP}:72 Open dashboard · ${LP_HEAD}:70 Dashboard` },
  { key: "no-feedback-key", label: "No feedback key", from: `${MKT}:31 feedback.configured false · ${LP}:459 Contribute's three links, :505 the footer's links alone` },
]);
export type LandingState = (typeof LANDING_STATES.list)[number]["key"];
