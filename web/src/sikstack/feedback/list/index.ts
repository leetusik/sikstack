// The Feedback list (job 04 round 02, `result.md` § The list; `Feedback.dc.html`, `FeedbackList.dc.html`,
// `FeedbackListStates.dc.html`): one list for both routes, `/feedback` and `/projects/{id}/feedback`.
// The routes mount `FeedbackListPage` (the server body), `FeedbackListLoading` and `FeedbackListNotFound`.
// The island (`./list.tsx`) and the view (`./view.tsx`) import their siblings by path, never this barrel,
// which holds a server-only read.
export { FeedbackListPage } from "./page";
export { FeedbackListLoading } from "./loading";
export { FeedbackListNotFound } from "./not-found";
export { FeedbackList, type FeedbackListProps } from "./list";
export { FeedbackListView, type FeedbackListViewProps } from "./view";
export { readFeedbackList, type FeedbackListRead } from "./load";
export {
  filtersSet,
  isBusy,
  isCounting,
  listBody,
  listRange,
  listRows,
  noSuchView,
  pageCount,
  PAGE_SIZE,
  type FeedbackListRecord,
  type FeedbackListRow,
  type ListBody,
  type ListPhase,
  type ListPlace,
} from "./model";
