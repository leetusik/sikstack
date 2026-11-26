# Publishing

Explain publishes to the sikstack Library at https://sikstack.com through the `knowledge` CLI. Self-hosting runs the platform repo itself (https://github.com/leetusik/sikstack); point the CLI at it with `--base-url` or `KB_API_BASE_URL`.

## Connect (once per machine)

`knowledge --version` answers when the CLI is installed. When it does not:

    uv tool install git+https://github.com/leetusik/sikstack#subdirectory=cli
    knowledge init

`knowledge init` is run by the operator in their own terminal: it signs them in to https://sikstack.com and writes `~/.config/knowledge-kb/config.json` with an org key. Never ask for, read, print or pass the key yourself; the CLI reads it from that file or `$KB_API_TOKEN`. A 401 means the key is missing or revoked: ask the operator to run `knowledge init` again.

One org key serves every repo: each document goes to the project you name (by default the repo's folder name).

## Check, then save

Write the body to a scratch file (`body.md`: no front matter, no `# H1`), then dry-run it with the same flags you will publish with. `check` writes nothing; exit 1 lists every refused line: fix them all and check again.

    knowledge check body.md --format native --title "<Title>" --project <project>

    knowledge save body.md --format native --share members --json \
      --title "<Title>" --summary "<one-line lede>" --tag <tag> --tag <tag> \
      --lang en --project <project> --co-authored-by "<model> <noreply@…>" \
      [--asset <name>=<path> ...]

- `--share members` is explain's only publish state: the org reads it, nobody else.
- Tags: 2 to 5, lowercase-kebab. The title says what the document explains, no trailing period.
- On a 201 (exit 0), report the `url` and `version` from the JSON. Warnings are not failures.
- **409** (a document already at that path): it is the same topic again. Tell the operator its title and `rel_path` and publish as a new version on their word.
- **422**: one list naming every violation by line and code; fix them all and publish once more. The same list twice: stop and report it.
- **A transport failure** (no response) does not mean the save failed: read the document back once (`knowledge read <rel_path>`) before you publish again.

## Versions and refresh

A refresh of a loose document is its next version, never a new document:

    knowledge list --project <project>          # its rel_path
    knowledge read <rel_path> --source          # the prior body, its ids and its Sources commit
    knowledge save body.md --format native --share members --new-version --rel-path <rel_path> …

Keep the id of every heading and block that survives. A version inherits no images: attach again every `asset:` it still names.

A translation is a new document beside its source: `--slug <source slug>-<lang> --lang <lang> --translated-from <src lang>@<version>`, with every id, block and formula of the source kept.

## Books

A chapter is placed with `--book` and `--chapter` together; re-sending the same book, key and `--lang` is the chapter's next version.

    knowledge save ch1.md --format native --share members --json \
      --title "<Chapter title>" --project <project> \
      --book <book-slug> --chapter <key> --position <n> --chapter-title "<Chapter title>" \
      [--book-title "<Book title>" --book-kind codebase|subject [--book-subject "<label>"]]

- `--position` and `--chapter-title` matter only for a new chapter; `--book-title`, `--book-kind` and `--book-subject` only when the book is new (send them with the first chapter).
- The server keeps the book's manifest (its chapter order and titles) from these flags: publish chapters in order, first to last.
- The book's sharing covers its chapters: send the same `--share members` on each.

## Sharing

Explain never changes sharing on its own. The operator does, per document or per book:

    knowledge share <document rel_path | book slug> members|link|public [--project <project>]

- `members`: the org only (the default).
- `link`: anyone holding the printed URL, read-only, no sign-in. Turning it on mints a new link; turning it off kills the old one.
- `public`: listed and readable signed out.

The reader's share switch does the same.
