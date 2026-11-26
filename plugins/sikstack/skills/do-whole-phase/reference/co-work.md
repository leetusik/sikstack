# do-whole-phase — a design slice (`kind: co-work`)

A design slice runs inline, with dispatched spans, per the `design-cowork` skill, which owns the loop. This file
keeps only what the phase loop adds.

- **Who runs what.** The brief, the build, the stop and the operator's words stay inline; the **drafting is
  dispatched to `sikstack:design-drafter`** on the design row or the phase's `Drafter:` line, and the **critique
  to `sikstack:design-critic`** only when the operator asked for a critic. The slice is a barrier that never
  shares a slice wave.
- **The stop.** One per draft shown, in this order: commit the design folder (the draft commit), build, serve on
  loopback, run the layout check, then `sikstack design-publish --folder <design folder> [--repo <name>] --page
  <entry or route>` …, one `--page` per page in the brief; then `sikstack slice status <slice_id> pending
  --stop-kind wave --on-words "<what their words will do>"`, with `url=` first in your report (the build's list
  page on sikstack web), then the pages and states and the screenshots. With no design link yet, the first stop
  leads with `design-link`'s connect page and code instead (`design-cowork`'s `reference/publish.md`).
- **The words.** A sign-off: `sikstack design-sign --slice <slice_id> --words "<their literal words>" --folder
  <design folder> [--repo <name>]`, then `slice finish`, commit. Feedback: recorded verbatim in the slice's
  `feedback.md`, one revise pass, one more stop.
- **Commits.** The draft is one commit in the product repo before the build (the design folder only), since
  `design-publish` refuses a build made from another commit than the repo's HEAD, and one in the workflow state;
  the sign-off is one more workflow commit. A revise pass adds a commit, a build, a publish and a stop.
- **An older phase.** A `Mockup:` line in `intent.md` is ignored. A canvas round still open from before 2.0.0
  finishes on the plugin version that opened it.
