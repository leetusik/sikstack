---
name: explain
description: "Explain code, a change or a subject as a short native document (or, on request, a book) in the sikstack Library: written in this session from the code at HEAD first, the workspace's records for the why when they exist, git log and PR bodies when they do not, and the web only for a subject the code does not hold. One fresh-eyes read, one fix, then a Members-only publish."
argument-hint: "[<topic> | <path> | <PR, branch or range> | book <topic> | refresh <document> | translate <document> <lang>]"
---

# explain

Explain writes a document a person can read and act on: what something does, how to use or change it, and what is still open. It runs here, in the operator's session, on any repo: no phase, no worktree and no workspace are needed. A book is the one case that asks first.

Read a reference only when the run needs it:

- `reference/book.md`: a book or a chapter added to one.
- `reference/blocks.md`: the native Markdown the server accepts (callouts, diagrams, code titles, ids).
- `reference/publish.md`: installing the `knowledge` CLI, `knowledge init`, `save`, versions, books and `share`.
- `reference/fresh-eyes.md`: the brief for the fresh-eyes reader.

## Where it runs, and what it reads

**Scope follows where you run.** In a repo, the subject lives in that repo. At a multi-repo host (a `.sikstack/` whose `sikstack repo list` names product repos), it may span those repos; read each repo's rules files (`CLAUDE.md`, `AGENTS.md`) before you describe how that repo works.

**Sources, in this order:**

1. **The code at HEAD.** Read the files themselves, never your memory of them. Note the short commit (`git rev-parse --short HEAD`) you read at.
2. **The records, when there are any, for the why.** With a `.sikstack/` workspace, read through the engine, never by walking its folders: `sikstack next` (what is active), `sikstack section <P> [<section>]` (one phase's notebook), `sikstack cold search <text>` and `sikstack cold fetch <phase|doc|path>` (archived phases and durable docs). Records add reasons; the code says what is true now. Where they disagree, the code wins and you say so.
3. **No records:** `git log` (and `git log -L` or `--follow` on the files that matter) and PR bodies (`gh pr view <n>` or `gh pr list --search`, when `gh` is installed and signed in). A why you cannot find is said in one line ("the history does not say why"), never invented.
4. **The web, only for a subject the code does not hold** (a protocol, a library's own behaviour, a topic with no code): a short lookup, every page you used listed under Sources. When a subject is too big for a short lookup, say so and suggest a research phase; do not start one.

**Open work** comes from the agenda when a workspace has one: `sikstack agenda` lists the agendas, `sikstack agenda-show <agenda>` its items; use the **Proposed** and **Open** items only, in plain words. Without a workspace, use open issues or TODOs the code holds, or leave the section out.

## The situations

| You are asked for | What you make |
| --- | --- |
| Code in this repo, with records | A document: the code for what, the records for why. |
| Code in this repo, no records | A document: the code, plus git log and PR bodies for why. |
| A change (a PR, a branch, a range of commits, a phase) | A change note: what the system does now, why it changed, what to watch. Read `git diff <base>..<head>` and the PR body; organise by idea, never commit by commit. |
| A subject outside the code | A document from a short web lookup, every source listed; or a research suggestion when it is too big. |
| A book | Ask once with its plan, then write it: `reference/book.md`. |
| A chapter added to a book | Read the book's existing plan and chapters first, then write the chapter to fit it: `reference/book.md`. |
| A refresh of a document | Read the document and the commit it names under Sources; `git diff <that>..HEAD` over its files; rewrite only the sections whose code moved; publish as a new version (`reference/publish.md`). |
| A translation | One pass over the published body, ids and blocks kept byte for byte; no fresh-eyes read. |
| A tiny question ("what does this flag do?") | Answer in chat. No document. |

## Asking

- **A document runs straight away.** Its first line to the operator names the reader you are writing for, the project it publishes to (the repo's folder name unless told otherwise) and that it publishes as **Members**. The operator can stop or redirect you at that line; do not wait for an answer.
- **A book asks once:** its plan (`reference/book.md`). Nothing is written before the operator confirms it.
- Write in **English** unless the operator asks for another language.

## A document's shape

No fixed outline; the subject decides the headings. By default:

1. **In one paragraph** (before the first heading): what the reader can do after reading, and the one idea it rests on.
2. **What it does:** the system as it works now, shown through its real code (fenced, the block titled with its path).
3. **How to use or change it:** the commands, the files to edit, the checks to run, each with its path.
4. **What is open:** the agenda's Proposed and Open items or known gaps, in plain words. Leave it out when there is nothing.
5. **Sources** (`## Sources {#sources-list}`): the code files with the commit, the PRs and records read (in plain words), the web pages used.

**Diagrams are not a rule.** A document holds none, one or many, as the subject needs: draw one where a flow, a structure or a sequence is easier seen than read. A quiz or a glossary only on request.

**Writing:**

- Short paragraphs, plain words, each term explained where it first appears. Show the code or the example first, then say what it means.
- **Each section stands alone.** A section may be read by itself (search returns sections, and an assistant quotes them), so it names its subject in its own first sentence and never leans on "as above" or "see the previous section". A short recap beats a pointer.
- **Cite code paths and PRs** (`server/main.py`, `#42`), never phase or slice ids, agenda ids or `.sikstack/` paths. The records feed the why; they are never the subject, a heading or a citation.
- Say only what the sources say. A gap is stated in one line, never filled from general knowledge.
- Light means shorter, not less accurate: a reader should finish a document in a few minutes.

## The fresh-eyes read, then one fix

Before publishing, dispatch one fresh-eyes reader (`reference/fresh-eyes.md`): an agent with none of your context, on any model, given only the draft's path, the repo and the brief. It makes one pass and writes one findings file. Fix what it found once, then publish. There is no second round: a finding you disagree with, say why in your report. A translation and a chat answer skip it.

## Publishing

Keep the draft, the findings and any images in a scratch folder outside the repo (`mktemp -d`); explain writes nothing into the repo or the workspace. Check the body with `knowledge check`, then publish a new document (or a new book's first chapter) with `knowledge save … --format native --share members`. A refresh or a next chapter sends no `--share`, so the item keeps its sharing; `reference/publish.md` has the full rule. A new item starts as **Members**: only the org can read it. To change who can read it afterwards, the operator runs `knowledge share <document|book> members|link|public`, or uses the reader's share switch; never change it unasked. With no CLI or no key, `reference/publish.md` says how to install and connect, and the draft stays on disk until then.

## The report

End with: the document's URL (or the book's), the reader and project, the commit read, what the fresh-eyes read found and what you fixed, any finding you left and why, and the gaps you stated.
