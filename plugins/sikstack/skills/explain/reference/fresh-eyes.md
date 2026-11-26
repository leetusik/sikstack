# The fresh-eyes read

The reader is fresh eyes, not a second model: what it lacks is your context. Dispatch it as a `general-purpose` agent (any model) and give it only:

- the draft's path (or, for a book, every chapter's path in order, and the plan's path);
- the repo root (or the host's repos) and the commit the draft was written at;
- where to write its findings (a file beside the draft, `findings.md`);
- this brief, by path: `${CLAUDE_PLUGIN_ROOT}/skills/explain/reference/fresh-eyes.md`.

Never paste your notes, your outline or your reasoning into the dispatch. It runs once, in the foreground; then you (the editor, for a book) fix once.

## The brief (for the reader)

You read one draft as its stated reader would, in one pass, and write one findings file. You never edit the draft and you never publish.

**Facts against the code.** Open the files the draft names, at the commit it names (`git show <commit>:<path>`, or the working tree when it is HEAD). For each path, command, flag, function, config key and number it states, find it (`git grep`). For each claim about behaviour ("retries three times", "runs before the write"), read the code that does it. A fenced block titled with a path must match that file. A sentence that cites a PR: read it (`gh pr view`, when present). A web source listed under Sources is the writer's; check only that the sentence says no more than a source could.

**Nothing invented.** A sentence stating what neither the code, the history nor the listed sources state is a finding, even when it is true.

**The reader can act.** Follow each "how to use or change it" step as the reader: does the command exist, does the file say what the draft says it does, is a step missing?

**Each section stands alone.** A section that leans on "as above", a term defined only in another section, or a pronoun whose subject is elsewhere.

**No workspace ids.** Any phase or slice id (`P12`, `P12.S3`), agenda id or `.sikstack/` path in the body.

**Readability.** A paragraph a reader would read twice; a term used before it is explained; a picture that would explain a flow better than the paragraph does (or one that only repeats the text).

**For a book, in order:** the flow from chapter to chapter, contradictions between chapters, repeats, a term used before the chapter that teaches it (by the plan's term list), and each chapter against its plan line (goal, owns, assumes, leaves).

**The file.** One `findings.md`: each finding with its place (chapter, section heading), what is wrong, the evidence you saw (the file and line, or the command and its output) and the fix in one line, marked `must-fix` (a wrong fact, an invented claim, a step that fails) or `should-fix` (the rest). End with one line: how many of each. Return that line.
