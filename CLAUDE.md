# CLAUDE.md — the sikstack platform

The Library and Feedback at <https://sikstack.com>: a document API, a web app, a CLI, an MCP server, a Claude Code plugin, and a Mac voice runner for Listen. This file holds only what the code does not say.

## Layout

- `server/`: the FastAPI document and accounts API (`server.main:app`). `alembic/`: its accounts-plane migrations. `tests/`: its pytest suite.
- `server/feedback_api.py` serves the Feedback REST surfaces over `server/feedback/` (domain, storage, the owner alert); dormant without `DATABASE_URL`.
- `web/`: the Next.js web app (pnpm).
- `cli/` (the `knowledge` CLI), `mcp-server/` (MCP over HTTP: `/mcp` for Library retrieval, `/feedback/mcp` for write-only Feedback capture), `tools/listen-runner/` (the Mac Listen runner, a LaunchAgent): each its own uv project with its own tests.
- `deploy/`: the box's deploy scripts and nginx vhosts (the apex `sikstack.conf`, the design builds' hosts `sikstack-design.conf`; the old domain's `hi2vi.conf`, `knowledge.conf` and `vocky.conf` redirect only). `compose.prod.yml` is production; `compose.yml` is local.
- `docs/`: the library's content root (the box writes tenant #1's projects under `docs/<project>/`), plus the MkDocs site sources (`index.md`, `tags.md`, `graph.md`, `assets/`, `javascripts/`, `stylesheets/`, `mkdocs.yml`).
- `scripts/`: the Feedback skill's parity guard, the name guard, the smokes and the book migration.
- `skills/vocky-feedback/SKILL.md`: the Feedback capture skill, served at `/feedback/SKILL.md`.
- `plugins/sikstack/`: the sikstack plugin, the workflow engine's source (`scripts/`, the Claude Code adapter in `adapters/claude_code/`, `skills/`, `agents/`, `hooks/`, `bin/`, `templates/`, `tests/`); the only plugin `.claude-plugin/marketplace.json` lists. `/sikstack:explain`, which writes and publishes Library documents and books, is one of its skills (`plugins/sikstack/skills/explain/`: the card and its `reference/`). Its history came over from bootstrap_agentic_workspace.

## Commands

- Python: `uv run pytest` (root suite); `uv run uvicorn server.main:app --port 8766` (local API). `cli/`, `mcp-server/` and `tools/listen-runner/` run `uv run pytest` from their own folder.
- Web: `pnpm --dir web typecheck`, `lint`, `test`, `dev` (`http://127.0.0.1:3030`). Run `pnpm --dir web build` in a scratch copy of `web/`, never in a checkout whose dev server is running: the build rewrites `web/.next`.
- Design: `web/design/` is the design folder, a static build of production's own components on recorded data, held to web's lint and typecheck: `pnpm --dir web design:record` (a recording; a real project's goes to the gitignored `design/data/local/`), `design:build` (`design/out/` and `out/manifest.json`), `design:serve -- --port N`, `design:check` (the production-exclusion check: a production build holds none of the design; it measures no page). The layout check, which measures every page and state at 1440, 768 and 375 px (375 also on WebKit 18.2, the iPhone 13 mini, installed on first use into the user's cache), is the sikstack plugin's `plugins/sikstack/templates/design/check.mjs`, run over the served build: `node plugins/sikstack/templates/design/check.mjs --base http://127.0.0.1:N --manifest web/design/out/manifest.json --out <dir>`. `web/design/TASTE.md` is the product's one-page taste file.
- Verify in a browser: `bash .claude/skills/sikstack-verify/run.sh doctor | up | signin | feature <name> | webkit phone|tablet <path> | down` runs the whole stack on loopback, outside the checkout, and drives it with `playwright-cli` at 1440, 768 and 375; `webkit phone|tablet` opens one page signed in on WebKit 18.2 (the iPhone 13 mini at 375, the iPad mini at 768) for a layout an iPhone on iOS 18 draws unlike Chrome; the steps and the feature map are in `.claude/skills/sikstack-verify/` (`SKILL.md`, `features/`).
- Parity: `python3 scripts/skills_parity.py` (CI: `.github/workflows/plugin-ci.yml`).
- Name guard: `python3 scripts/name_guard.py` fails on any `hi2vi` line its allowlist (`scripts/name_guard_allow.txt`) does not hold (CI: `.github/workflows/name-guard.yml`). The product was hi2vi before sikstack; its old hosts only redirect to sikstack.com.
- sikstack: `bash plugins/sikstack/tests/smoke.sh`, alone in its shell call (CI: `.github/workflows/sikstack-ci.yml`, on changes under `plugins/sikstack/**`).

## Rules

- The explain skill has one copy, `plugins/sikstack/skills/explain/`, and no parity guard; it ships with the sikstack plugin's version.
- The Feedback capture skill has two copies: `skills/vocky-feedback/SKILL.md` (canonical) and `web/public/feedback/SKILL.md` (served, byte-identical). Edit the canonical one and copy it over; `skills_parity.py` fails on drift.
- Library content never enters git: `.gitignore` keeps every project folder under `docs/` (only the MkDocs site sources' folders stay tracked), `tenants/`, `data/` and `.assets/` out of the tree. Who reads an item is its own share state in the accounts plane, per document and per book: Members (the default), Anyone with the link, or Public (`server/sharing.py`, table `item_shares`); a project's visibility is only the state a new item starts at. Change it with `knowledge share <document|book> members|link|public` or the reader's share switch. Making an item Public is the org owner's act (the owner's session, the master bearer or an org key); Link and Members are any member's. The day-one fill, `python -m server.sharing fill [--dry-run]`, gives every existing item of a public project a Public row; it runs at every start-up but fills each project only once, ever (a `kind='fill'` marker row, which the owner's visibility switch writes too), and only ever inserts missing rows.
- The accounts schema changes only through a new `alembic/versions/` revision; Production Deploy applies it (`alembic upgrade head`). Never alter the database by hand.
- No secrets in the repo: deploy keys live on the box (`deploy/SECRETS.md`); `.env` files are gitignored.

## Release

Users install `sikstack@sikstack` from `.claude-plugin/marketplace.json` and pull an update only when its `version` changes, so any change under `plugins/sikstack/**` (the explain skill included) bumps `plugins/sikstack/.claude-plugin/plugin.json`'s semver `version` and adds its entry to `plugins/sikstack/CHANGELOG.md`, in the same PR (CI checks the bump).

The catalog's `"renames": {"explain": null}` turns an installed `explain@sikstack` (the old separate plugin) off instead of failing to load; keep it while old installs may exist (`claude plugin validate` does not flag it).

## Deploy

Production is the box's checkout at `/opt/knowledge`, deployed only by dispatching the `Production Deploy` workflow from `main` (`.github/workflows/deploy-production.yml` → `deploy/oracle-production-deploy-remote.sh`). It reconciles the checkout with `origin/main`, rebuilds, migrates and health-gates the services. Never change code or containers on the box by hand: the deploy refuses a dirty tracked tree. The Listen runner on the Mac is installed by `tools/listen-runner/install.sh`, not by the deploy.

## Where the workspace lives

Phases, plans, durable docs and the operator's decisions live in the host's workflow state, outside this repo. The engine's source lives here, in `plugins/sikstack/`: its checks run from `plugins/sikstack/tests/` against scratch repos made with `sikstack init`, never against this checkout. Keep no `.sikstack/` workspace in this repo. The old in-repo workspace's frozen records left the tree; read them in the history at commit `ee61f98c` (`git show ee61f98c:archive/workspace/README.md`).
