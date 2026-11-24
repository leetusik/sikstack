// Add to agenda and the Agenda part (job 04 round 02, `FeedbackItemSend*`, `FeedbackItemAgenda*`,
// `Waiting`; frame.md F143, F341 to F344; operator decision 2; P61-e9). The record's state comes from the
// agenda seam (`@/lib/feedback/agenda`: `canAdd`, `sent`, over `GET /app/feedback/{id}/agenda`), read in
// `../item/body.tsx`, the one place they are mounted (the item's `headEnd` and `agenda` slots); the add is
// `@/lib/feedback/agenda-actions`' `fileAgendaItem`.
//
// - `AgendaPart`, `AddedToAgenda` (`./part`): the Agenda part and the head's end once added,
//   presentational, rendered on the server for a record not offered or already added.
// - `AgendaScope`, `AgendaHeadEnd`, `AgendaSlot` (`./control`, client): the add's island, mounted only
//   when `canAdd` offers the add and the record is on no item yet; its confirm picks a new item or one
//   already on the agenda (`pickable`).
// - `./model`: the rules, pure.
//
// Its sheet is `src/sikstack/styles/feedback/agenda.css`; its words `@/content/feedback-agenda`.
export { AddedToAgenda, AgendaPart, type AgendaPartState } from "./part";
export {
  AgendaHeadEnd,
  AgendaScope,
  AgendaSlot,
  type AgendaScopeProps,
} from "./control";
export {
  agendaPageState,
  answer,
  ask,
  cancel,
  focusBack,
  isLocked,
  isOpen,
  NEW_ITEM,
  pickable,
  send,
  type AddPhase,
  type AgendaPageState,
  type AgendaPartItem,
  type AgendaPick,
  type PickItem,
} from "./model";
