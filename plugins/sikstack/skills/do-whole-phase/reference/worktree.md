# A phase in its own worktree

**The phase runs on this checkout unless the operator asked for a worktree.** Never run `worktree start` on your own initiative: a `hint:` about a queued phase is relayed, not acted on.

**Start.** On the operator's word (`worktree`, `in a worktree`, `in parallel`, `on its own branch`) and with the phase still `planned`: `sikstack worktree start <P>` (nested: `--host-branch <name>`, the name proposed from `repo convention` and confirmed), `EnterWorktree` into the printed path (nested: the host worktree), re-run `next` there (`stream=…`) and run the whole loop in that session. The same when the operator ran `worktree start` themselves.

**Integrate after a `pass`** by the close checklist, the one place it is written: `${CLAUDE_PLUGIN_ROOT}/skills/pr/reference/close.md` (`close <P>`'s `merge` and `teardown` stops: the gate first, never past a closed one; the merge; the gate sections the branch review's `result.md` holds under `## Gate sections (written at merge)`; the teardown, `worktree teardown <P> --discard-ignored` in a nested install when what it lists are caches).

**When the merge cannot run** (a closed gate, something staged, a conflict outside the generated files): leave the branch `done` and unmerged and say so. `next` on the default stream then prints `merge_ready=<P>:<branch>`; whoever drives that stream integrates it at its next slice boundary, `worktree gate <P>` first.

