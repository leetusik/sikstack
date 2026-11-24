// An agenda item's page (design job 02, round 02-agenda-and-links: `AgendaItem.dc.html`, `AgendaItemHead.dc.html`,
// `AgendaItemForm.dc.html`; frame.md F45, F81, F301, F303, F309). Its parts emit the signed markup and the classes
// of src/sikstack/styles/ (the system's, `workspace/frame.css` and `workspace/agenda-item.css`); its words are
// `@/content/workspace/agenda-item` and `@/content/workspace/frame`. The pure models are tested on their own.
//
// - `AgendaItemPage` (client): the page, its writes and the state they leave (`state.ts`).
// - `AgendaItemLoading`: the page while it loads.
// - `itemLines`, `itemView`, `headActions`: what the page draws from its read (`model.ts`).
// - `Thread` (client, P61-e9): the item's thread and its note composer; `threadView`, `entrySource`, `noteBody`: what
//   each entry shows and what the composer sends (`thread-model.ts`).
export { AgendaItemPage, deletedState, type ItemPageRead } from "./item-page";
export { AgendaItemLoading } from "./loading";
export {
  headActions,
  isSetAside,
  itemLines,
  itemView,
  PENDING_LABEL,
  retryLabel,
  type HeadAction,
  type ItemRead,
  type ItemView,
  type PhaseLine,
} from "./model";
export {
  afterSend,
  formSend,
  INITIAL,
  pageView,
  reduce,
  vanished,
  type AfterSend,
  type Draft,
  type FormKind,
  type FormSend,
  type PageDraw,
  type PageEvent,
  type PageState,
} from "./state";
export { Thread } from "./thread";
export {
  entrySource,
  NOTE_MAX,
  noteBody,
  threadView,
  type EntrySource,
  type EntryView,
} from "./thread-model";
