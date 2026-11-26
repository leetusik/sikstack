---
name: agenda
description: Handle the agendas and the product's users' feedback with the operator. Show them, propose a triage per agenda, per item and per piece of feedback with a reason each, and run only what the operator says.
allowed-tools: Bash(sikstack:*)
disable-model-invocation: true
---

# agenda

An **agenda** is one piece of work not being done now (`works/agenda/<AID>/`); it holds **items**, one file each under its `entries/`, each with a kind (note, issue, feedback, question, decision), an author (`person:` or `agent:`), a source (`phase:P7-k2`, `slice:P7-k2.S1`, `feedback:<id>`, `pr:<url>`), a date and a state: `open`, `done` or `dismissed`. `.sikstack/works/agenda.md`, beside `works/backlog.md`, is the generated dashboard. An agenda takes many phases; it never affects `next`.

**Only the operator starts this skill, and it only suggests.** Nothing changes on your own reading: each change runs on the operator's word.

## Show

`/agenda`: `sikstack agenda` (`--json` for the stored fields plus `shown_status`, `items_open` and `phases`), then `agenda-show <A>` for each agenda you propose something on: its status, note, links and every item with its reference (`<A>/<tail>`), state, kind, author, date and source. `/agenda show <A>`: that agenda alone, and stop.

## Triage

Propose one line per agenda that needs a move and per open item that needs one, each with a one-line reason, then wait:

- **open** a Proposed agenda worth doing: `agenda-accept <A>…`
- **propose** an Open one that is not for now (back to Proposed, out of the open order): `agenda-propose <A>… --author person:<the operator>`
- **solve**: `agenda-solve <A>… [--outcome "…"]`; **drop**: `agenda-drop <A>… [--reason "…"]`
- **merge** agendas on one subject: `agenda-merge <into> <from>…` (every item and phase link moves to the first; the rest are Dropped as `merged into <it>`)
- **split** an agenda that holds two subjects: `agenda-split <A> <tail>… --title "…" --author person:<the operator>` (a new agenda holding those items, their state kept; the rest stay)
- per item: **done** `agenda-item done <A>/<tail>… --author person:<the operator>`, **dismiss** `agenda-item dismiss …`, **delete** `agenda-item delete …` (the file goes; its event is the record); `agenda-item reopen …` brings one back

Run only the lines the operator says yes to, as they amend them; a command on several agendas or items changes all or none. Then `check` and commit by the `commit` skill (`chore(agenda): <what>`), skipped in a linked checkout (`next` prints `store=cloud`). Never push.

An agenda closes itself when its last open item goes: Solved when any of its items was done, Dropped when every one was dismissed or deleted. One with no items never closes by itself. Open agendas become phases by `/create-phase open agendas`.

## Feedback

`/agenda feedback`, or after the agendas in a bare `/agenda`: the product's users' feedback, brought onto the agendas. It needs a linked checkout; when `agenda-feedback list` answers that this one is not linked, say so, say that `/sikstack:sign-in` (or `sikstack link <server>/projects/<project-id>`) links it, and stop.

1. `sikstack agenda-feedback list` (`--json` for each piece's whole message, comment and target): every piece neither filed nor dismissed, newest first, its id leading its line.
2. Read each piece against the agendas (`agenda`, and `agenda-show <A>` for a likely home) and suggest one line per piece, each with a one-line reason:
   - **file on `<A>`**, the agenda it is closely related to (items first): `agenda-feedback file <id> --agenda <A> --author person:<the operator>`
   - **propose a new agenda** only when none is: `agenda-feedback file <id> --new --title "…" --author person:<the operator>`
   - **dismiss** it (noise, a duplicate, already fixed): `agenda-feedback dismiss <id> [--reason "…"] --author person:<the operator>`
   - or **leave it** for later: nothing runs, and it lists again next time.
3. Wait. These are suggestions: run only the lines the operator says yes to, as they amend them, and never file or dismiss a piece on your own reading. `file` writes the item, then sikstack records the piece filed; if it ends with the line saying to run it again, run that line as printed (it only records). A filed or dismissed piece never lists again, on any checkout.

## The other commands

`agenda-add --title "…" --author person:<name>|agent:<name> [--note "…"]`, `agenda-item add <A> --kind … --author … --source <kind>:<ref> --body "…"` (`agenda-entry` is its older name), `agenda-edit <A> [--title …] [--note …]`, `agenda-move <A> --first|--last|--before <A>|--after <A>`, `agenda-reopen`, `agenda-delete` (each on one or more agendas), `agenda-link <A> --phase <P>`, `agenda-unlink --phase <P>`; `phase new` takes `--agenda <A>`. Leave out `--id` (the engine mints `A7-m3`); send a text starting with `-` as `--title=<t>`.

## Where new things land

A loose end is never parked: fix it now, drop it with a reason, or (the exception) an item on its agenda that says what would make it actionable. **Items first:** closely related to an existing agenda (a phase's linked agenda first) means an item on it (`agenda-item add`), never a new agenda and never a deferral; only something no agenda is closely related to opens a new one (`agenda-add`). A person's new agenda is Open at once; an agent's is **Proposed**, outside the open order, until the operator accepts or drops it. An agent marks an item done when a phase fixes it; the operator dismisses or deletes.

Agendas are stored `open | solved | dropped`; Proposed and In progress are shown, never stored (In progress: an Open agenda with a linked phase not done). An install that still holds `works/deferred/` runs `sikstack agenda-fold` once, on the default checkout: each open deferred job becomes a Proposed agenda whose first item carries it.

In a linked checkout, changes made on the web arrive as inbox entries that `sync` and `next` apply as these commands; a refused one shows the command's line on the web.
