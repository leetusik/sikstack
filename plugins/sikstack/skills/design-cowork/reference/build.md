# design-cowork — applying a signed design, and verifying it

## Applying — a file move

An apply slice moves the signed design's files from the design folder into production: the components it wrote
under the folder move to production's component tree, and production's page imports them in place of what it drew
before. A component's next version (`folder.md`, *Changing a production component*) moves over the original it
replaces, its imports turned back to production's own, and its build alias is dropped; production's tests that
pin what the original drew change with it. The design used
production's own components and passed the product's checks, so nothing is redrawn.
**RESPECT THE DESIGN:** ship every element and state as signed; never drop, simplify or "improve" one to save
effort. What the design needs and production lacks (an API field, a write) is built as backing and named, never
quietly dropped. The plan names the signed slice's `design-signoff.json` (its words and the product repo's commit)
and `## Operator Runtime`; the design folder's page stays as the design of record, or is updated to production.

## Verifying — matches the design, and works

Two yardsticks, both mandatory: it **matches the signed design** (side by side with the design build, each state),
and it **works as a product**. Matching is the floor, never acceptance.

**The functional sweep, on real wiring.** Each item is a defect when it fails, even with perfect pixels:
- every visible control does something observable;
- focus, hover and the keyboard path on every control, browser defaults included;
- liveness: watch a timer tick; polling never destroys input in progress;
- anything live (search, validation, autosave) is exercised by typing and waiting.

**Where it runs.** In the runtime `## Operator Runtime` (the operations doc) names, and also in the production
build when the two differ, at every viewport it names. A section absent or still `UNFILLED` is `needs_operator`.

**With what.** `playwright-cli` (`@playwright/cli`), the agent's own headless browser on a throwaway profile,
never the operator's; you pick each next action (`open`, `snapshot`, `click e5`, `fill`, `press`, `resize`,
`screenshot --filename=<abs path>`, `console`, `close`), in place of a pre-written suite.

**The browser is never a blocker.** Missing: `npm install -g @playwright/cli@0.1.25`, typed exactly so. No
browser: `playwright-cli install-browser chrome-for-testing`. Stuck: `playwright-cli kill-all`, unless another
agent's session runs; use a named session (`-s=<name>`) and close what you open. A saved sign-in: the operator saves
it once (`state-save`, its path under `## Operator Runtime`'s `Saved sign-in:`); you `open`, `state-load`, then
`goto`. Only a credential, a sign-in or a paid account you cannot have is `needs_operator`.

**How to call it.** Plainly, `playwright-cli <command>`: no leading environment variable, no `cd … &&` chain, no
pipe into another tool, so the allow rule matches (an allow rule matches no command past an unknown leading
assignment, and every part of a compound command must be allowed). Output files go to `.playwright-cli/` in the
current directory: run from a scratch or evidence folder, never a product tree. Every command echoes what it ran:
send a password's `fill` to `/dev/null`. `playwright-cli` blocks `file:` URLs: serve a folder to open it.

Name the instrument in `result.md`, and never report a browser run you did not make.

**When the design never drew it** (a focus treatment, an empty or error state, copy that reads wrong in the
product): catalogue it as a one-line question on `phase.md`'s `## Operator Questions`, never invent it; the review
routes every entry. **Signing a design is not accepting the product**: the operator meets the wired thing at the
phase's acceptance gate and may change their mind there.

## Never

- Verify only against the design, or only in whichever runtime is convenient.
- Fix a design gap silently, or "improve" it: catalogue it.
