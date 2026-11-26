# Operations

## Status

No operations truth is finalized yet.

## Purpose

Use this doc for local development, environment variables, deployment, infra, jobs, observability, backups, and recovery.

## Local Development

- Install:
- Run:
- Test:
- Build:

## Operator Runtime

How the **operator** runs and views this product. Any slice claiming "verified in a real
browser" verifies here — this runtime, this access path, these devices — and additionally in
the production build when the two differ.

- Run command(s):
- Mode: <dev or production build; say where they differ — dev may enable StrictMode / Fast Refresh, production does not>
- Origin / host the operator browses: <localhost, LAN IP, Tailscale host, deployed URL>
- Devices / viewports / browsers: <e.g. desktop 1440px Chrome, phone 390px Safari>
- Browser instrument for the agent: playwright-cli (`@playwright/cli`, driven from the shell; the agent installs, starts and closes it itself, headless on a throwaway profile, never the operator's)
- Saved sign-in: <path of a `playwright-cli state-save` file the operator makes once (signed into a test account, never their own), which the agent `state-load`s; or none>
- Production build command + origin (when different):
- Also needed to see what the operator sees: <auth/test account, seeded data, feature flags>
- Status: UNFILLED — fill before any slice claims real-browser verification

An absent section and an unfilled one mean the same thing: the slice stops `pending` and asks
the operator, it never assumes. Remove the `Status:` line once the fields above are real.

## Environment Variables

| Name | Required | Purpose | Notes |
|---|---|---|---|
| <NAME> | yes/no | <purpose> | <notes> |

## Explain (/sikstack:explain)

`/sikstack:explain <topic>` writes a short document from this repository's code, in the session:
the code at HEAD first, the phases' records for the why when they exist, git log and PR bodies when
they do not. A book asks once with its plan. It publishes to the sikstack Library as Members, with
the `knowledge` CLI (`knowledge init` connects it once); `knowledge share` changes who reads it.

## Deployment

- Target:
- Process:
- Rollback:

## Scheduled Jobs / Workers

- <job>: <schedule/trigger>

## Observability

- Logs:
- Metrics:
- Alerts:

## Backup / Restore

- <policy>

## Open Questions

-
