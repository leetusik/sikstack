// One piece of feedback (job 04 round 02, `FeedbackItem.dc.html`, `FeedbackItemComments*`,
// `FeedbackItemFiles*`), shared by its two routes: `app/(app)/feedback/[feedbackId]/` and
// `app/(app)/projects/[projectId]/feedback/[feedbackId]/`.
//
// - `./body` (server only, imported by its own path so no client file pulls `next/headers` in):
//   `FeedbackItemBody` reads the record and renders the page, the one place S6's two slots are filled
//   (`headEnd`, `agenda`) and the state slot (P91-v3); `feedbackItemMetadata` gives the tab title.
// - `./state` (client): `ItemStateScope`, the state's island over the list's two server actions.
// - `FeedbackItem`, `FeedbackItemLoading`: the markup; `feedbackItemView` and the rest of `./model`:
//   the rules, pure.
// - `FeedbackItemLoadingState`, `FeedbackItemNotFoundState`, `FeedbackItemErrorState` (client): what
//   each route's `loading.tsx`, `not-found.tsx` and `error.tsx` render.
//
// Its sheet is `src/sikstack/styles/feedback/item.css`; its words `@/content/feedback-item`.
export { FeedbackItem, FeedbackItemLoading } from "./item";
export {
  attachmentHref,
  FACT_LABELS,
  feedbackItemView,
  inScope,
  isFeedbackId,
  zoneMetaOf,
  type FeedbackItemView,
  type ItemComment,
  type ItemFact,
  type ItemFile,
  type ItemLong,
  type ItemRaw,
} from "./model";
export {
  FeedbackItemErrorState,
  FeedbackItemLoadingState,
  FeedbackItemNotFoundState,
} from "./states";
