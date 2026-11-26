# sikstack

sikstack is a phase-and-slice workflow for Claude Code. You ask for a change; the agent writes it up as a
**phase**, cuts it into **slices**, runs each slice on its own executor, reviews the result, and stops for you to
walk it before it lands. The plan, the verdicts and the decisions stay on your machine, in your repo's hidden
`.sikstack/` folder, kept out of the repo's history.

It installs as a Claude Code plugin and needs no account: one setup per machine, then work.

## Install

In Claude Code:

    /plugin marketplace add leetusik/sikstack
    /plugin install sikstack@sikstack
    /sikstack:setup

`/sikstack:setup` runs once per machine. Then start working, in any git repository:

    /sikstack:sik-mode

`sik-mode` reads where the repo stands and offers the next step: making the `.sikstack/` folder, starting a phase,
running the one in flight, or showing what waits on you.

To clone only the plugins rather than the whole repository, add the marketplace from a shell with a sparse
checkout:

    claude plugin marketplace add leetusik/sikstack --sparse .claude-plugin plugins

**Needs** Claude Code, `git`, and `python3` 3.8 or later. Nothing else: no server, no key, no Docker.

## No account needed

Setup asks for an email and registers it, with a random install id, at sikstack.com. That is all the server keeps
before you sign in. Your phases and their records stay on your machine, and sikstack works fully without signing
in. If sikstack.com cannot be reached, setup still finishes and registers on a later run.

**Sign in later to see your work on the web.** `/sikstack:sign-in` prints a short code and opens a page on
sikstack.com; you confirm the same code there, signed in to your account, and the install is connected. The repo's
earlier work then uploads, and you see its phases on the web. An email alone never connects an install: only a
code you confirm does.

## On the web, for signed-in users

<https://sikstack.com> holds the web services, for signed-in users (new accounts start on a waitlist):

- **Workspace**: a connected repo's phases, slices and verdicts, its agenda and its docs.
- **Library**: books and documents your agents write for you to read, grounded in the code; read, listen,
  review with a quiz, search in English and Korean, and publish a project's documents in your org's public library.
- **Feedback**: what your users said, captured from your product with a capture-only key.

## What is in this repository

- `plugins/sikstack/`: the sikstack plugin, the workflow engine and its skills, agents and hooks
  ([`CHANGELOG.md`](plugins/sikstack/CHANGELOG.md)). Its history before the move is
  `leetusik/bootstrap_agentic_workspace.sh`'s. Its `/sikstack:explain` skill writes a document or a book from your
  code (and your phases' records, when you keep them) and publishes it to your Library.
- `server/`, `web/`, `cli/`, `mcp-server/`, `tools/listen-runner/`: the services behind sikstack.com.
- `.claude-plugin/marketplace.json`: the marketplace, which lists the sikstack plugin.

## Credits

sikstack is my personal take on [pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's
Claude Code and Cursor plugin: her principles (install and go, no account, a setup once, an entry point that
routes the work to playbooks), reshaped around this phase-and-slice workflow. It took pstack's ideas, not its code.
sikstack is not a fork of pstack, and it is not affiliated with or endorsed by Cursor or Lauren Tan. See
[`NOTICE`](NOTICE).

## License

MIT, see [`LICENSE`](LICENSE).
