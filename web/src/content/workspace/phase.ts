// A phase's page (design job 02, rounds 01-workspace and 02-agenda-and-links: `Phase.dc.html`, `PhaseGate.dc.html`,
// `PhaseSlices.dc.html`, `PhaseNotebook.dc.html`; frame.md F36, F48, F78, F306), the words the frame's glossary
// (`./frame.ts`) does not already hold, verbatim from the boards. Imported by its own path.

import { WS_GLOSSARY } from "./frame";

const P = WS_GLOSSARY.labels.phase;

export const PHASE_PAGE = {
  /** The tab title of a phase: its id and its name, through the site's template. */
  title: (id: string, name: string | null) => (name ? `${id} ${name}` : id),
  notFoundTitle: "Phase not found",
  /** Read before a decision's slice by a screen reader: `Decided in S1` (`PhaseNotebook.dc.html`). */
  decidedIn: "Decided in ",
  /** Under each explaining document's title (`Phase.dc.html`, Explained in). */
  library: "Library",
  /** A part that loads, to a screen reader. */
  loading: "Loading…",
  /** A branch whose record names no repo: F42's empty value in its place. */
  branch: (repo: string | null) => P.branch(repo ?? WS_GLOSSARY.none),
  /** The link's text (F306): `Pull request #38`; a URL with no number reads the words alone. */
  pullRequest: (n: number | null) =>
    n === null ? "Pull request" : P.pullRequest(n),
  /** The link's name (F306): `Pull request #38 in platform on GitHub, Draft`; no state, no state word. */
  pullRequestName: (
    n: number | null,
    repo: string | null,
    state: string | null,
  ) => {
    const what = n === null ? "Pull request" : P.pullRequest(n);
    return `${what} in ${repo ?? WS_GLOSSARY.none} on GitHub${state ? `, ${state}` : ""}`;
  },
  noPullRequest: P.noPullRequest,
} as const;
