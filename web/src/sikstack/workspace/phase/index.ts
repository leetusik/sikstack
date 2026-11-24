// A phase's page (design job 02, rounds 01-workspace and 02-agenda-and-links: `Phase.dc.html`, `PhaseGate.dc.html`,
// `PhaseSlices.dc.html`, `PhaseNotebook.dc.html`; frame.md F48, F306). Its sheet is ../../styles/workspace/phase.css,
// its words `@/content/workspace/phase` beside the frame's.
//
// - `PhaseView`: the head (the facts with each branch's pull request), the main column (the gate while open,
//   Slices, Notebook, Intent) and the side (Agenda item, Review, the gate while not open, Explained in).
// - `PhaseLoading`, `PhaseMissing`, `PhaseFailed`: Loading, Not found and Error, each under the back row.
// - The pure rules (`./model`) are tested on their own.
export {
  PhaseAgendaItem,
  PhaseExplained,
  PhaseGate,
  PhaseIntent,
  PhaseNotebook,
  PhaseReview,
  PhaseSlices,
  PhaseView,
  type PhaseLinks,
} from "./parts";
export { DecisionList, NotebookDecisions, DECISIONS_ID } from "./decisions";
export { PhaseLoading } from "./loading-view";
export { PhaseFailed, PhaseMissing } from "./states";
export {
  agendaItemOf,
  askedDates,
  explainedDocuments,
  gatePlace,
  isCurrentSlice,
  NOTEBOOK_DECISIONS_SHOWN,
  PHASE_ID,
  notebookQuestions,
  notebookShows,
  originalParagraphs,
  pullRequestView,
  sliceSub,
  type ExplainedRow,
  type PhaseItemView,
  type PullRequestView,
} from "./model";
