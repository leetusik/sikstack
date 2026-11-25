# The sikstack design system's sheets

The product's own copy of the signed system (`design-system/hi2vi/project/` in the workspace that drew it):
`tokens.css`, and `bundle.css` with sections 1 to 6 of the signed bundle plus the Done status. Values and
class names are the signed ones; the only changes are the isolation below, listed at the top of each file.

| File | Holds |
| --- | --- |
| `tokens.css` | The colour roles (light, and dark under `data-scheme="dark"`), spacing, radii, type steps, line heights, the two font stacks, the `.type-*` classes. |
| `bundle.css` | Layout tokens, base, primitives, app layout, shell, components, `.status-done`; Listen and Review's shared parts (job 07: its five layout tokens, `.hold`, the marks `.ico` and `.btn-ico`, the state word `.say` with `.status-busy` and `.status-fail`, the thin line `.meter`, `.badge.is-wrap`) and the Workspace's (job 02: its seven layout lengths, `--measure` among them, the status shapes `.status-ready`, `.status-pending`, `.status-blocked` and `.status-changes`, the steps `.steps`, the facts `.facts` / `.fact`, the waiting badge `.badge.is-waiting`), each beside its family; then `@keyframes skel` and `say-turn`. |
| `boundary.css` | The old-page boundary: the copies on `:root` and the restore at `[data-ui-legacy]`. |
| `index.css` | The three, in that order, then the Library's sheets, then Listen's and Review's, then the Workspace's, then the Library's boundary, then Feedback's. The root layout imports it after `globals.css`. |
| `library/frame.css` | The Library's frame (job 03, round 02): its tokens (`--read-*`, `--sheet-w`, `--side-w`, `--line-h`, `--row-h`), Choice, the bar outside the Shell, the reader's layout, a text's body, head, end and foot, chapters, the sheet, Sign in to save, shelves, a mark's row, Display and Version history, the pager. Its changes from the signed sheet are listed at its top. |
| `library/<part>.css` | One sheet a Library part, each owned by one slice and named in its header: `lists`, `project-library`, `public-library`, `book`, `reader`, `blocks`, `annotations`, `document`, `book-notes`. |
| `listen/listen.css` | Listen's own classes (job 07: the head's slot, the dock, the player, the book's audio line, follow along), added by the slices that build them. |
| `review/review.css` | Review's own classes (job 07: the focused frame, the head, the card, the rating pair, the end; `Review.css`'s `.rv-*`), added by the slices that build them. |
| `workspace/frame.css` | The Workspace's frame (job 02, rounds 01 and 02): progress, the Workspace row and its four layouts, a page's first row with the sync line, the three places, an item's title row, a long fact and a link fact, an id that never breaks, a command to copy, an author on the agenda. Its changes from the signed sheet are listed at its top. |
| `workspace/<page>.css` | One sheet a Workspace page or part, each built by the part it names in its header: `workspace/md` (the Markdown body), `workspace/home` (project home's Workspace panel), `workspace/agenda`, `workspace/agenda-item`, `workspace/backlog`, `workspace/phase`, `workspace/slice`, `workspace/docs`. |
| `library/boundary.css` | The Library's own custom properties restored at the old-page boundary, as `boundary.css` does the system's. |
| `feedback/frame.css` | The Feedback frame (job 04, round 02): its tokens (`--measure`, `--fact-min`, `--rating-mark`, `--json-lines`, `--seg-rule`), Rating, Tag, Absent, Raw JSON, Facts (`.facts.is-grid`), the search and filter bar with its `.seg` toggles, the table that stacks (`.stack-*`), Waiting. No pager: the list uses the Library's. Its changes from the signed sheet are listed at its top. |
| `feedback/<part>.css` | One sheet a Feedback part, each owned by one slice and named in its header: `list`, `item`, `agenda`. |
| `feedback/boundary.css` | The Feedback frame's five custom properties restored at the old-page boundary, as `library/boundary.css` does the Library's. |
| `org.css` | The org surfaces (P78): `.menu-rule` (the org menu's rule before New org), `.org-form` (New org's form width), the Members panel's top edge. Loaded last; it declares no custom property. |

## How it stays out of the old pages

The app also runs Tailwind v4 (its layers `theme, base, components, utilities`) and the old `kb-*` sheets,
and the new shell wraps old pages. So:

1. **Scope.** `tokens.css` and `bundle.css` are each one `@scope (.ui) to ([data-ui-legacy]) { … }` block.
   A rule matches only inside a `.ui` root and never at or under an element with `data-ui-legacy`. A page
   without a `.ui` root matches none of them.
2. **Root rules read `:scope`.** Inside `@scope`, a bare selector matches the root's descendants only
   (`.page` on the root itself would not match), so the signed `:root` and `.ui` rules read `:scope`, which
   keeps the specificity of `.ui`. The root is therefore a bare wrapper: put `.page`, `.app` and every other
   system class on its descendants (`UiRoot > .page > .app > .app-frame …`).
3. **Unlayered.** The sheets sit in no cascade layer, so inside `.ui` they outrank all of Tailwind's layers
   (preflight included) whatever the specificity: a `.grid` or `.gap-5` there is the system's, never
   Tailwind's utility of the same name. Outside `.ui` they match nothing, so Tailwind's still apply.
4. **The boundary.** Custom properties and inherited properties cross a scope boundary. `boundary.css`
   copies every custom property the system declares, as `:root` has it, into `--sikstack-legacy-*` (new names
   nothing else reads), and at `.ui [data-ui-legacy]` sets each back and resets what the `.ui` root makes
   old content inherit (colour, font, numerals, word breaks, colour scheme) to what `<body>` gives it.
   `tests/sikstack-styles.test.ts` holds that list equal to the system's.
5. **Not through Tailwind.** Tailwind emits a theme variable on `:root` whenever its input names it, even
   in a comment. The sheets are imported by the root layout, not by `globals.css`, so the system's
   `var(--radius-xs)` never makes Tailwind emit its own `--radius-xs`. For the same reason `globals.css`
   says `@source not "../sikstack"`, and no comment in it names a theme variable the system reads.

## Using it

- A page opts in by rendering inside `UiRoot` (`src/sikstack/ui/`): one root a page, outermost, never nested
  (a nested root starts light again). It sets `data-scheme` before the first paint; `scheme="light"` pins
  light (the sign-in screens). A route under a nonce CSP passes `nonce`.
- Old content inside a `.ui` root goes inside `Legacy` (`<div data-ui-legacy>`): no system rule reaches it
  and it inherits as a child of `<body>` does.
- New markup inside `.ui` uses the system's classes only; no Tailwind utility is needed there.
- A later sheet of system classes (a job's frame components) is scoped the same way:
  `@scope (.ui) to ([data-ui-legacy]) { … }`, with root rules as `:scope`, and loaded outside Tailwind. It is
  imported once, here, never by a page or a component (so no route segment hoists a sheet of its own), and a
  custom property it declares is restored at the boundary (`library/boundary.css`).
  `tests/sikstack-library-frame-sheets.test.ts` holds the Library's sheets to this: every rule in the scope, no
  rule that names only system classes (one name per meaning) beyond `button.link-row`, and the boundary list.
- Schemes: `UiRoot` sets `light` or `dark` on the root. The Library's reader sets its own on its root
  (`data-scheme` `light`, `dark` or `sepia`, job 03 frame.md F57); `tokens.css` answers all three there.

## Browsers

`@scope`: Chrome 118, Safari 17.4 to 18.6 and from 26.4, Firefox 146 (MDN browser-compat-data 8.1.9,
2026-11-12). Safari 26.0 to 26.3 did not apply `@scope` rules to `input` and `textarea`. A browser without
`@scope` drops both blocks: `.ui` pages go unstyled and the old pages are untouched. `::backdrop` inherits
the dialog's custom properties from Chrome 122, Safari 17.4 and Firefox 120.

## Known differences from the canvas

- `body { background: var(--bg) }` is not built: the tokens live on the `.ui` root, so `<body>` (and an
  overscroll past the page) keeps the app's own ground. `.page` paints the system's.
- Tailwind's preflight sits under the system: where the system sets nothing, an element inside `.ui` takes
  preflight's reset rather than the browser default the canvas had (an `h4` inherits its size and weight;
  `code` takes the old mono stack). One such reset is undone: preflight's `margin: 0` would pin a modal
  `.dlg` to the top-left corner, so `bundle.css` gives `.dlg:modal` the browser's `margin: auto` back.
