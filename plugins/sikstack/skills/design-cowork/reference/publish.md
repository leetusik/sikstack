# design-cowork — publishing a build to sikstack web

Every stop publishes (`SKILL.md`, **Show**), for every user. `sikstack design-publish --folder <folder>
[--repo <name>] --page '<entry or route>' …` (each value quoted) uploads the build to the project's Design service, from the main checkout
or a worktree; `--folder` needs a built `out/` that this checkout can see. It prints `url=`, the build's list page on
sikstack: the round's pages, with one link to every page. The options page shows there only when the round names
its entry (`options.entry` in `out/manifest.json`); a round that made only the options names only that. A build made from another commit than the repo's HEAD is
refused: commit, then build again. One made from uncommitted changes publishes with one `stale:` line.

**No link yet.** When `design-publish` refuses naming `design-link`, the first stop offers the connect code:

1. Run `sikstack design-link --data-dir "${CLAUDE_PLUGIN_DATA}" --no-browser` in the background (the Bash tool's
   `run_in_background`). It prints a code and the connect page, then waits for the operator to confirm there; that
   makes a new project named after the repo.
2. Stop `pending --stop-kind wave`: the stop's report leads with the connect page and the code, then the pages and
   states and the screenshots.
3. Exit 0 prints `design_link=written`. Exit 3 is still waiting: run it again, and it keeps the same code. Once they
   have connected, publish and report `url=`.

For an existing project the operator runs `sikstack design-link <server>/projects/<id>` in their own terminal and
pastes a workspace key; never ask for a key. The workspace stays local. `design-link` leaves the `[design]` table
uncommitted in the main checkout's `config.toml`; the operator commits it or not.

**The local URL is only the fallback.** Report a local URL only when the operator has no account or declines one.
Serve the build on loopback (or give a Tailscale address when one exists), leave the server running, and stop it when
their words come back. In the report it is named as the fallback, never as the design's home.

**Sharing.** Report the `url=`: sharing is turned on in that viewer, by a member, and the share link copied there is
what a teammate with no account opens. The engine never turns it on.
