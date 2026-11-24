# Architecture

## Status

__PROJECT_NAME__ is newly bootstrapped. This document should describe stable system-level truth as the app takes shape.

## Current Repo Shape

- `<product folders>`: <what each top-level folder holds>

The sikstack workspace is `.sikstack/`, its own git repo, hidden from this repo's git (`sikstack --help` names the engine's commands):

- `.sikstack/docs/current/`: the durable docs, plain files edited in place
- `.sikstack/config.toml`: the executor routes and the cloud link
- `.sikstack/backlog.md`: generated human dashboard
- `.sikstack/works/state.json`: current/next pointer; `.sikstack/works/index.json`: generated machine index
- `.sikstack/works/phases/active/` and `.sikstack/works/phases/archived/`: phase folders
- `.sikstack/works/agenda/`: agenda item folders, each `agenda.json` and its thread, one file per entry under `entries/`; `.sikstack/works/agenda.md` is the generated list

## System Shape

- <frontend runtime>
- <backend runtime>
- <database / persistence>
- <background workers / queues>
- <external integrations>

## Boundaries

- Frontend boundary:
- Backend boundary:
- Data boundary:
- External service boundary:

## What the Code Cannot Say

Agents read the code, so this doc never restates it. It keeps only what the code cannot show about the modules, the data, the API and the security model:

- Invariants and ownership: <rule the code relies on but does not state>
- Data: <retention, migration or consistency rule>
- API: <contract with an outside client or service>
- Security: <trust boundary, secret handling, permission model>

## Cross-Cutting Constraints

- <constraint>

## Open Questions

-
