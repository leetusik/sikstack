# design-cowork — the design folder

## What it is

A second build of the product inside its own repo: pages at production's addresses, drawn by the same component
files production imports, on data recorded from the real API, with a browser store standing in for writes. It is
held to the product's lint and typecheck, and the production build never contains it. So a design is real code
from the first draft, and applying it moves files.

The repo's rules file declares it on one `Design:` line: the folder, its commands, its taste file. platform's:

- `web/design/` (its own Next config, static export to `web/design/out/` with `out/manifest.json`);
- `pnpm --dir web design:record` (token on stdin; `--state <name>` for a state's answer; `--to local/<name>` for a
  real project), `design:build`, `design:serve -- --port N --log`, `design:check` (the production-exclusion check:
  production holds none of the design; it measures no page);
- `web/design/TASTE.md`, the one-page taste file; `/system/` in the build, the tokens and every shared
  component's states;
- the click-through: `.claude/skills/sikstack-verify/features/design.md`.

**A product without one** gets it in its first design slice, modelled on platform's: the same shape (a second build
config beside production's, its pages importing production's components, a recording, a manifest, a
production-exclusion check), in the product's own toolchain, and a `Design:` line in its rules file. A product
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
answers is recorded; one no API answers is made, and says so. The widget carries `data-design-states` (the layout
check never measures it), each listed state `data-design-state="<key>"` with `aria-pressed`, and the state on screen
`data-design-current="<key>"`; the page with no `state` shows the first listed state.

## Changing a production component

A design that changes what a production component draws writes the component's **next version** in the design
folder, under the same file and export names (platform: `web/design/next/<path under src/sikstack>/`, e.g.
`next/workspace/agenda/parts.tsx`), its imports pointing at production's modules. The design build draws it in
place of the original: a page that imports the component imports the next version; one drawn inside another
production component is swapped by the folder's build alias (platform: one `turbopack.resolveAlias` entry in
`web/design/next.config.ts` per swapped file, keyed by the import as production writes it, e.g. `"./parts"`; a key
catches every import written that way in the build, so name each one the key catches). Never a CSS override over
production's classes, and never an edit under production's tree. Applying it moves the file over the original and
drops the alias (`build.md`). Two next versions of different `./parts` modules cannot coexist: the one `"./parts"`
key catches every `./parts` import, so the first design that needs two has to change how the alias is keyed first.

## The layout check

The layout check, `${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs`, drives `playwright-cli` over a served build. It
is not the folder's production-exclusion check (platform's `design:check`), which measures no page:

```
node "${CLAUDE_PLUGIN_ROOT}/templates/design/check.mjs" --base http://127.0.0.1:<port> --manifest <folder>/out/manifest.json --out <evidence folder> [--shots <dir>]
```

It walks every page of the manifest (or the URLs given) and each state its widget lists, at 1440, 768 and 375 px
(desktop, tablet, and the iPhone 13 mini: a page that fits it fits every phone), and prints only failures, each with a
cropped screenshot: console errors and failed requests, sideways overflow, clipped text, overlapping or covered
controls, text drawn on top of other text, targets under 24 px. The phone width runs twice: in Chrome, and in WebKit
18.2 with the iPhone 13 Mini profile (every iOS browser is WebKit, and this old one shows grid bugs newer builds
hide); its failures read `w=375 webkit`. The WebKit driver, playwright-core 1.49.1 and its browser, installs on first
use into one folder in the user's cache (a download of about 63 MiB, about 250 MB on disk, once;
`SIKSTACK_WEBKIT_HOME` moves all of it); when it cannot be installed or launched the check stops with a driver error,
and `--no-webkit` skips it on purpose. An overlap passes only under an opened menu or dialog, or under a fixed bar
that some scroll position moves off what it covers: a header over the first line, a foot bar over the last at the
end of the scroll, or a lifted badge over a link fails. A brief that names fewer devices passes their
widths (`--widths 1440` for a desktop-only tool). Every run (a page, at one width, in one state)
opens in a fresh browser context, so no state a run stores reaches the next, and a page with a state widget must
show the state its run names, else `FAIL state` and that run is not measured. A clean build prints one `ok` line;
exit 1 is layout failures, exit 2 a usage or driver error (`driver error: …`: no server, a `playwright-cli`
failure, WebKit not to be had), where nothing was checked. `--shots <dir>` also saves every measured run as viewport-height tiles, what a
person sees, for the critic to open (it runs `--shots <slice folder>/shots`); a tile's name can start with `-`, so
pass `--` before it in a shell command. A product may copy it into its folder. Beside it, `canvas.mjs` walks the
same runs into a claude.ai canvas copy (`claude-canvas.md`). The drafter answers every failure
before it returns; you run it again before a stop.

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
