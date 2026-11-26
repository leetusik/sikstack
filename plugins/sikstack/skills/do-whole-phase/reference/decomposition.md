# A decomposition slice: the orchestrator's side

The executor's side (the walkthrough first, few big slices, `slice new`, the breakdown in `topics/breakdown.md`, the sets) is `playbooks/decompose.md`. Yours:

- **Plan it at the gate** unless the operator said `auto`: it fixes the shape, risk and cost of everything after it. Dispatch it on the high row. Its plan names what a throwaway run should settle before the cut; the estimate's time comes from the adapter's `meter` `means` block, never a session-$ figure.
- **A visual phase with no `## Design Style` in `intent.md`:** the plan asks the operator first: suggest `build-after` or `paired` with a reason and the drafter (`fable` or `opus`); set the slice `pending --stop-kind decision --on-words "<their answer records the style and DECOMP cuts the slices>"` and stop. `design-only` cannot be chosen here (its apply phase needs `phase new`): that answer goes to `/create-phase`.
- **At its end**, `slice finish <P>.DECOMP` prints an `advice:` line for each middle slice left undeclared, which then runs alone (`slice deps <slice> --depends-on …` declares one). Relay the executor's `parallel:` rounds in a line of your next report and run the phase as drawn.

**In the same commit as that finish:**

1. **Declare the acceptance gate.** `gate <P> require` when the phase changes anything the operator can see, else `gate <P> waive --note "<why nothing operator-visible changes>"`. `review --verdict pass` refuses an undeclared phase. A `design-only` phase ships no production surface, so it takes `--waive --note "design-only: the operator signed each design at its URL"`; `build-after` and `paired` phases are gated by their build slices.
2. **Record the phase's PR branches** (PR rule v1): `pr branch <P> [--repo <name>] --name <branch>` once per repo the phase will change, the name from `intent.md`'s `Branches:` line (or proposed from `repo convention [--repo <name>]`, no IDs, and confirmed here); a recorded base (`Branches: feat/y (base: feat/x, merges after #12)`) adds `--base <that branch>` and the body's series line follows `${CLAUDE_PLUGIN_ROOT}/skills/pr/reference/stack.md`. None for a phase that changes no product file, and none in a repo it will not change: the pass waits for a draft on every recorded branch. **Size never splits a phase:** a large branch splits into PRs at the review.

