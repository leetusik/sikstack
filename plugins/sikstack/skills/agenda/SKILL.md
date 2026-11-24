---
name: agenda
description: Show the agenda, or run one agenda command on its items.
allowed-tools: Bash(sikstack:*)
disable-model-invocation: true
---

# agenda

The agenda is the one home for work not being done now. `/agenda` runs `sikstack agenda` (`--json` for stored fields; `.sikstack/works/agenda.md` is the same list, generated); `/agenda show <item>` runs `agenda-show`: the item and its thread. `/agenda <command> …` runs `agenda-<command> …`: `add --title "…" --author person:<name>|agent:<name> [--note "…"]`, `entry <item> --kind note|issue|feedback|question|decision --author … --source <kind>:<ref> --body "…"`, `accept`, `edit <item> [--title …] [--note …]`, `move <item> --first|--last|--before <item>|--after <item>`, `defer`, `solve [--outcome "…"]`, `drop [--reason "…"]`, `reopen`, `delete` (each on one or more items), `merge <into> <from…>`, `link <item> --phase <P>`, `unlink --phase <P>`; `phase new` takes `--agenda <item>`.

An item is a thread: each entry is one file with its kind, author (`person:` or `agent:`), source (`phase:P7-k2`, `slice:P7-k2.S1`, `feedback:<id>`, `pr:<url>`) and date; adding one never rewrites the item, so two writers never conflict. An item takes many phases.

Who opens an item decides where it lands: a person's is Open at once; an agent's is **Proposed**, outside the open order, until the operator's `accept` (Open) or `drop --reason`. An agent's entry on an item that exists is free. `merge` moves every entry and phase link onto the first item and drops the rest as `merged into <it>`.

A loose end is never parked: fix it now, drop it with a reason, or (the exception) an entry on an item that says what would make it actionable. An install from before 3.0.0 runs `sikstack agenda-fold` once: each open deferred job becomes a Proposed item whose first entry carries it.

In a linked checkout, changes made on the web arrive as inbox entries that `sync` and `next` apply as these commands; a refused one shows the command's line on the web.

Items are stored `open | deferred | solved | dropped`; Proposed and In progress are shown, never stored (In progress: an Open item with a linked phase not done). An item never affects `next`. Leave out `--id` (the engine mints `A7-m3`). A command on several items changes all or none; send a text starting with `-` as `--title=<t>`.
