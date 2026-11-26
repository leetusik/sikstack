# A book

A book is several chapters a reader takes in order, toward one end goal. It is written in parallel, so it needs a contract the chapters share: the plan.

## 1. The plan, confirmed once

Read the sources first (the card's order), enough to cut the subject. Then show the operator the plan and wait for their word. The plan is the contract; every chapter writer gets it whole.

- **The reader and the end goal:** who reads it and what they can do after the last chapter.
- **The chapter order**, and per chapter:
  - **goal:** what the reader can do after this chapter;
  - **owns:** the ideas, files and tasks this chapter explains, and no other chapter does;
  - **assumes:** what it may take from earlier chapters, by name;
  - **leaves:** what it mentions but leaves to a later chapter (named);
  - **terms:** the terms it introduces.
- **One term list:** each term once, with the chapter that teaches it and a one-line meaning.
- **A voice note:** two or three lines on tone, person and length (for example "second person, plain, about 1,500 words a chapter").
- The book's project, slug, title and kind (`codebase`, or `subject` with its label), and that it publishes as Members.

A chapter added to an existing book reads the book's chapters first (`knowledge read`), writes a short plan for the new chapter in the same shape (its place, goal, owns, assumes, leaves, terms), and shows it with the book's term list; the rest of this file applies to that one chapter.

## 2. Chapters on background agents

Dispatch one writer per chapter, in parallel, in the background. Each gets:

- the whole plan (never only its own line), the voice note and the term list;
- the sources to read for its part (paths, PRs, the workspace commands of the card);
- the card's writing rules and `reference/blocks.md`;
- where to write its draft (a scratch folder, `<chapter-key>.md`), and that it does not publish.

A writer that needs a term or idea another chapter owns uses the term list's meaning and a one-sentence recap, never a second explanation. A writer that finds the plan wrong (a file in two chapters, a missing idea) writes what it found at the top of its draft instead of re-cutting the book.

## 3. One fresh-eyes reader, the whole book in order

When every draft is in, dispatch one fresh-eyes reader (`reference/fresh-eyes.md`) over all chapters in order. Beyond the facts check, it reads for the book: flow from chapter to chapter, contradictions between chapters, repeats, a term used before the chapter that teaches it, and each chapter meeting its plan's goal. One findings file.

## 4. One editor across the chapters

One editor (you, or one agent given the plan, the drafts and the findings) applies the findings across the chapters once: removing repeats, settling contradictions, fixing terms. It writes each chapter's opener (what this chapter does for the reader, given the last) and its closing recap **last**, after the bodies are settled. No second fresh-eyes round.

## 5. Publish together

Publish every chapter in one go, in order (`reference/publish.md`, *Books*), all as Members. A book's sharing covers its chapters; change it with `knowledge share <book> …`. Report the book's URL and each chapter's.

## A refresh of a book

Read the commit each chapter names under Sources, `git diff <that>..HEAD` over its files, and rewrite only the chapters (and within them the sections) whose sources changed, each as its next version. The plan is kept; a chapter whose scope moved is a plan change to show the operator first.
