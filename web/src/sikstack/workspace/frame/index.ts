// The Workspace's frame (design job 02, rounds 01-workspace and 02-agenda-and-links; frame.md F35 to F49, F78,
// F80, F85): the parts every Workspace page shares. They emit the signed markup and the classes of
// src/sikstack/styles/ (the system's `bundle.css` and `workspace/frame.css`), with no styling of their own. Their
// words are `@/content/workspace/frame`. The pure models (no React, no I/O) are tested on their own.
//
// - `wsStatus(kind, value)`, `WsStatus`: F37's word and shape for every stored value.
// - `wsSteps`, `phaseSteps`, `stepsN`, `Steps`: a phase's progress (F39).
// - `WsList`, `WsRow`, `wsRowLayout`, `WS_ROW_BREAKS`: a Workspace row and its four layouts (F43).
// - `WsNav`: the head of the three places, or the never-synced and not-linked panel (F40, F41).
// - `wsSyncLine`, `WsSync`: the sync line (F40); `useWsRetry` (a page's Try again: the line is the bar while it
//   reads again), `WsRetrySync` (the bar alone where a failed state draws no line), `markWsRetry`, `useWsRetrying`.
// - `BackRow`, `ItemHead`: an item page's first row and title row (F35, F84, F85).
// - `Facts`, `Fact`: label-over-value facts, a long one, links as a value (F44, F80).
// - `WaitingBadge`, `RefusedBadge`, `RefusedNotice`: a change that waits, one refused (F45).
// - `wsNotFoundState`, `wsErrorState`: an item page's Not found and Error, for `StateBlock` (F49).
// - `WsItemFailed`: every item page's failed state, its read's or its boundary's (F49, F84); `wsHeadOf` (the sync
//   facts from the Workspace's read), `wsFailedTitle` (the tab's `<id>`).
// - `WsProse` (`./prose`, not in this barrel: server only): stored prose drawn as its Markdown (F46, F80).
// - `splitIds`, `WsText`, `WsId`: an id never breaks inside a sentence (F80).
// - `authorOf`, `Author`: who wrote or opened something on the agenda, an agent marked `Agent` (P61-e9).
// - `NO_LINE`: the sync line a page draws when its read gave no sync facts (nothing made up).
export { wsStatus, type WsStatusWord } from "./status-model";
export { WsStatus } from "./status";
export {
  phaseSteps,
  stepsN,
  wsSteps,
  type WsStep,
  type WsSteps,
} from "./steps-model";
export { Steps } from "./steps";
export { WS_ROW_BREAKS, wsRowLayout, type WsRowLayout } from "./row-model";
export { WsList, WsRow } from "./row";
export {
  NO_LINE,
  wsSyncLine,
  type WsSyncLine,
  type WsSyncState,
} from "./sync-model";
export {
  markWsRetry,
  useWsRetry,
  useWsRetrying,
  WsRetrySync,
  WsSync,
} from "./sync";
export { WsNav } from "./nav";
export { BackRow, ItemHead } from "./item-head";
export { Fact, Facts, type FactLink } from "./facts";
export { RefusedBadge, RefusedNotice, WaitingBadge } from "./waiting";
export { wsErrorState, wsNotFoundState, type WsBack } from "./states-model";
export { wsFailedTitle, wsHeadOf } from "./failed-model";
export { WsItemFailed } from "./failed";
export { splitIds, type WsTextPart } from "./ids";
export { WsId, WsText } from "./text";
export { authorOf, type AuthorName } from "./author-model";
export { Author } from "./author";
