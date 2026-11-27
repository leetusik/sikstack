# Contributing

Three ways to help:

- **Feedback**: press **Send feedback** on <https://sikstack.com>.
- **Issues**: report a bug or ask for a change at <https://github.com/leetusik/sikstack/issues>.
- **Pull requests**: open one at <https://github.com/leetusik/sikstack/pulls>.

## Before you open a pull request

Run the checks for what you changed:

- Python (`server/`, `tests/`): `uv run pytest`. `cli/`, `mcp-server/` and `tools/listen-runner/` run it from
  their own folder.
- Web (`web/`): `pnpm --dir web typecheck`, `pnpm --dir web lint` and `pnpm --dir web test`.
- The plugin (`plugins/sikstack/`): `bash plugins/sikstack/tests/smoke.sh`. Bump the `version` in
  `plugins/sikstack/.claude-plugin/plugin.json` and add an entry to `plugins/sikstack/CHANGELOG.md`, in the same
  pull request. Users only get an update when the version changes, and CI checks the bump.

## License

By contributing, you agree your work is released under the MIT license in [`LICENSE`](LICENSE).
