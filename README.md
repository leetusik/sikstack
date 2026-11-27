# sikstack

sikstack is a workflow for Claude Code. You ask for a change. The agent writes it up as a **phase**, cuts it into
**slices**, runs each slice on its own executor, and reviews the result. Then it stops for you to walk it before it
lands.

The plans, verdicts and decisions stay on your machine, in your repo's hidden `.sikstack/` folder. They stay out of
the repo's history.

## Install

In Claude Code:

    /plugin marketplace add leetusik/sikstack
    /plugin install sikstack@sikstack
    /sikstack:setup

Run `/sikstack:setup` once per machine. Then, in any git repository:

    /sikstack:sik-mode

`sik-mode` reads where the repo stands and offers the next step.

To clone only the plugin, not the whole repository, add the marketplace from a shell with a sparse checkout:

    claude plugin marketplace add leetusik/sikstack --sparse .claude-plugin plugins

**Needs** Claude Code, `git`, and `python3` 3.8 or later. No server, no key, no Docker.

## No account needed

Setup asks for an email. It registers the email, a random install id and the plugin version at sikstack.com, and
nothing else. Your work stays on your machine. If sikstack.com can't be reached, setup still finishes and registers
later.

To see your work on the web, sign in later with `/sikstack:sign-in`. It prints a short code and opens a page on
sikstack.com. Check the page shows the same code, sign in, and press Connect. The repo's earlier work then uploads.
An email alone never connects an install.

## On the web

<https://sikstack.com> is for signed-in users. New accounts start on a waitlist.

- **Workspace**: a repo's agenda, its phases, slices and verdicts, and its docs.
- **Library**: books and documents your agents write for you, grounded in the code. Read, listen, or review with a
  quiz. Search in English and Korean. Make a project's documents public.
- **Feedback**: what your users said, captured from your product with a capture-only key.

## Open source

sikstack is MIT licensed. To help:

- send feedback with **Send feedback** on <https://sikstack.com>;
- open an [issue](https://github.com/leetusik/sikstack/issues);
- open a [pull request](https://github.com/leetusik/sikstack/pulls).

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What is in this repository

- `plugins/sikstack/`: the plugin: the workflow engine, its skills, agents and hooks
  ([`CHANGELOG.md`](plugins/sikstack/CHANGELOG.md)). Its `/sikstack:explain` skill writes a document or a book from
  your code and publishes it to your Library. Its history before the move is
  [`leetusik/bootstrap_agentic_workspace.sh`](https://github.com/leetusik/bootstrap_agentic_workspace.sh)'s.
- `server/`, `web/`, `cli/`, `mcp-server/`, `tools/listen-runner/`: the services behind sikstack.com.
- `.claude-plugin/marketplace.json`: the marketplace that lists the plugin.

## Credits

sikstack is my take on [pstack](https://github.com/cursor/plugins/tree/main/pstack), Lauren Tan's plugin for Claude
Code and Cursor. It took her principles: install and go, no account, one setup, an entry point that routes the work.
It took pstack's ideas, not its code. sikstack is not a fork of pstack, and is not affiliated with or endorsed by
Cursor or Lauren Tan. See [`NOTICE`](NOTICE).

## License

MIT, see [`LICENSE`](LICENSE).
