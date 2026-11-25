// The Workspace's Agenda (design job 02, rounds 01-workspace and 02-agenda-and-links: `Agenda.dc.html`,
// `AgendaList.dc.html`, frame.md F301 to F303, F309): its three parts (Proposed first, P61-e9; no Deferred), the add form, the rows with their grip, box and
// Delete, the picked rows' actions in the head or the strip, Drop's and Delete's confirm, the open changes no row
// carries, its loading and failed parts. Words: `@/content/workspace/agenda`.
//
// - `AgendaList` (client): the list, holding what the page wrote over each read, what is picked and what is lifted;
//   `AddForm`, `AgendaConfirm` its form and its confirm.
// - `Grip`, `RowCheck`, `PartCheck`, `PartBar`, `BulkStrip`: the reorder and picking controls, no state of their own.
// - Reorder (pure): `liftedOrder`, `movePlace`, `gripKey`, `gripBlur`, `dragAt`, `dragShift`, `edgeScroll`,
//   `dragDelta`.
// - Picked rows (pure): `rowsOnScreen`, `partPicks`, `partPick`, `toggleAll`, `toggleRow`, `sendOrder`, `actAsks`, `actSending`, `PART_ACTS`;
//   `sendAct` sends one action for the picked ids.
// - `AgendaFailed` (client): the part that failed, with Try again.
// - `AgendaLoading`, `PartHead`, `AgendaRow`, `LoadingRows`: the parts with no state of their own.
// - The pure model: `agendaParts`, `openEnd`, `endedShown`, `emptyText`, `addIsPrimary`, `workspaceHrefs`, `workspaceProjectId`, `writeShown`; `unplacedDone`, what Discard or Try again on
//   an open change no row carries leaves (the overlay, and the box that takes the focus).
export {
  AddForm,
  AgendaConfirm,
  AgendaFailed,
  AgendaList,
  type AgendaAsk,
  type AgendaForm,
  type AgendaListProps,
  type AgendaPhase,
} from "./agenda-list";
export { AgendaLoading, AgendaRow, LoadingRows, PartHead } from "./parts";
export {
  addIsPrimary,
  AGENDA_SHOWN,
  agendaParts,
  emptyText,
  endedShown,
  openEnd,
  workspaceHrefs,
  workspaceProjectId,
  writeShown,
  type AgendaPartKey,
  type AgendaParts,
  type AgendaRowModel,
  type WriteShown,
} from "./model";
export { BulkStrip, Grip, PartBar, PartCheck, RowCheck } from "./controls";
export {
  dragAt,
  dragDelta,
  dragShift,
  DRAG_START,
  EDGE_SPEED,
  EDGE_ZONE,
  edgeScroll,
  gripBlur,
  gripKey,
  liftedOrder,
  movePlace,
  type Drag,
  type GripStep,
  type Lift,
} from "./reorder";
export {
  actAsks,
  actSending,
  NO_PICKS,
  PART_ACTS,
  partPick,
  partPicks,
  rowsOnScreen,
  sendOrder,
  toggleAll,
  toggleRow,
  type AgendaAct,
  type OnScreen,
  type PartPick,
  type Picks,
} from "./select";
export { sendAct } from "./send";
export { unplacedDone, type UnplacedDone } from "./unplaced";
