# design-cowork — the design folder

## What it is

A second build of the product inside its own repo: pages at production's addresses, drawn by the same component
files production imports, on data recorded from the real API, with a browser store standing in for writes. It is
held to the product's lint and typecheck, and the production build never contains it. So a design is real code
from the first draft, and applying it moves files.

The repo's rules file declares it on one `Design:` line: the folder, its commands, its taste file. platform's:

- `web/design/` (its own Next config, static export to `web/design/out/` with `out/manifest.json`);
- `pnpm --dir web design:record` (token on stdin; `--state <name>` for a state's answer; `--to local/<name>` for a
  real project), `design:build`, `design:serve -- --port N --log`, `design:check` (production holds none of it);
- `web/design/TASTE.md`, the one-page taste file; `/system/` in the build, the tokens and every shared
  component's states;
- the click-through: `.claude/skills/sikstack-verify/features/design.md`.

**A product without one** gets it in its first design slice, modelled on platform's: the same shape (a second build
config beside production's, its pages importing production's components, a recording, a manifest, a check that
production holds none of it), in the product's own toolchain, and a `Design:` line in its rules file. A product
starting from zero, with no components yet, starts from an options page (below).

## Data

- **Real recordings from the real API**, by default: the folder's record command against a sample project.
- **A committed recording comes only from a sample project.** A real project's recording goes to the folder's
  gitignored place (platform: `web/design/data/local/`).
- **Synthesize only what no API answers**, and say so where it is made (platform: `web/design/lib/answers.ts`).

## States

Every page lists only its own states in the design-only state widget (platform: `web/design/lib/states.tsx`,
`pageStates` and `StatePage`; the operator's bar rule), each read from a branch production draws (`from` names the
file and line), never invented. A state opens as `?state=<key>`, so it can be linked and checked. A state the API
answers is recorded; one no API answers is made, and says so.

## Changing a production component

A design that changes what a production component draws writes the component's **next version** in the design
folder, under the same file and export names (platform: `web/design/next/<path under src/sikstack>/`, e.g.
`next/workspace/agenda/parts.tsx`), its imports pointing at production's modules. The design build draws it in
place of the original: a page that imports the component imports the next version; one drawn inside another
production component is swapped by the folder's build alias (platform: one `turbopack.resolveAlias` entry in
`web/design/next.config.ts` per swapped file, keyed by the import as production writes it, e.g. `"./parts"`; a key
catches every import written that way in the build, so name each one the key catches). Never a CSS override over
production's classes, and never an edit under production's tree. Applying it moves the file over the original and
drops the alias (`build.md`).

## The check

`${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs` drives `playwright-cli` over a served build:

```
node "${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs" --base http://127.0.0.1:<port> --manifest <folder>/out/manifest.json --out <evidence folder>
```

It walks every page of the manifest (or the URLs given) and each state its widget lists, at 1440 and 390 px, and
prints only failures, each with a cropped screenshot: console errors and failed requests, sideways overflow,
clipped text, overlapping or covered controls, targets under 24 px. A clean build prints one `ok` line. A product
may copy it into its folder. The drafter answers every failure before it returns; you run it again before a stop.

## Options

Options exist only for a **named decision** (no decision, no options). When the direction is open, gather
references first and let the operator pick the directions before anything is built. Then copy
`${CLAUDE_PLUGIN_ROOT}/templates/design/options.html` into the design folder: two or three labelled directions on
the same sample screens behind one switcher, the decision at the top, each direction a token set with its type
choices. After the pick, the chosen tokens move into the product and the options page is deleted.

## The taste file

`<folder>/TASTE.md`, one page, from `${CLAUDE_PLUGIN_ROOT}/templates/design/TASTE.md`: the operator's standing
rules quoted with their dates, and the product's look in a few lines, each with its source. When the operator
states a new standing rule, add it verbatim with its date; never add your own taste.
