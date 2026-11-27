// Barrel for the typed @/content module. Consumers import structured content +
// types from "@/content" — never hardcode copy or anchor ids inline. S1 exports
// only the design-system-preview symbols; the auth / app-shell / dashboard /
// project / documents copy modules land with their slices (P12.S2–S5).
export { SECTION_IDS } from "./section-ids";
export type { SectionId } from "./section-ids";

export { SITE } from "./site";
export { NAV_LINKS, SKIP_TO_CONTENT } from "./nav";

export type { Cta, NavLink, SiteMeta } from "./types";

// Authenticated app shell (P12.S2) — chrome labels + rail nav.
export { APP_NAV, APP_NAV_GROUPS, APP_SHELL, dueText } from "./app";
export type { AppNavGroup, AppNavItem } from "./app";

// Tenant dashboard (P12.S3) — usage tiles / trend / projects / activity + create.
// P18.S3 adds the org-level API-keys panel copy + its status-keyed mint/revoke errors;
// P25.S5 adds the public-URL (org slug) panel + its status-keyed save errors.
export {
  CREATE_PROJECT_ERRORS,
  DASHBOARD,
  MINT_ORG_CREDENTIAL_ERRORS,
  REVOKE_ORG_CREDENTIAL_ERRORS,
  SET_ORG_SLUG_ERRORS,
} from "./dashboard";
export type {
  ActivityEmphasis,
  ActivityTemplate,
  DashboardCopy,
} from "./dashboard";

// Project detail (P12.S4) — project info / usage / credential mint-list-revoke +
// the status-keyed mint/revoke errors. P19 adds the visibility toggle errors.
export {
  MINT_CREDENTIAL_ERRORS,
  PROJECT,
  REVOKE_CREDENTIAL_ERRORS,
  SET_VISIBILITY_ERRORS,
} from "./project";
export type { ProjectCopy } from "./project";

// Documents (P12.S5): the Library's Delete errors (P21) and the full-width exit's label; the
// old list and past-version page retired into the Library (P63).
export { DELETE_DOCUMENT_ERRORS, DOCUMENTS } from "./documents";

// System states (P28.S3 — round 03 §5) — the cross-surface editorial 500 block,
// the `Not found · 404` eyebrow the six not-found pages share, and the loading
// region's accessible name. Cross-surface by nature: `app/error.tsx` catches
// throws from every console page, so the copy belongs to no single surface.
export { STATES } from "./states";
export type { StatesCopy } from "./states";

// Native / md chapter render pipeline (P30.S12) — the plumbing's own words: the
// "couldn't be shown" placeholders, the missing-link suffix and region names.
export { CHAPTER } from "./chapter";

// The reader shell (P30.S13) — the `01-reader` round's strings for the top bar, the
// chapter bar, the Contents and Display sheets, Sign in to save and the states.
export { READER } from "./reader";

// The library's title (the way back's label). `BOOK` and `LISTEN` left the barrel with the old Listen views
// (P64-3y.S10): job 07's Listen (`sikstack/listen/**`) imports `@/content/book` and `@/content/listen` directly.
export { LIBRARY } from "./library";

// sikstack's own feedback control (job 08, round 01-landing-diagram-feedback, `## Build` §2 and §5): the
// trigger, the dialog, its states and the check's sentences, on the landing and on org home.
export { feedbackNumber, SEND_FEEDBACK } from "./send-feedback";
export type { SendFeedbackCopy } from "./send-feedback";
