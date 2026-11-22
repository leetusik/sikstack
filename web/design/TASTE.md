# TASTE: sikstack

The product's one-page taste file. The drafter reads it before every draft; the critic judges against it. The
tokens and components say the rest: `src/sikstack/styles/tokens.css`, `@/sikstack/ui`, and the system page at
`/system/` of the design build.

## The operator's standing rules

1. **The page's states sit in a small design-only widget that follows the scroll; it lists only the states of
   the page on screen, and clicking one shows the page in that state.** (`lib/states.tsx`)
   - "I would like to have what we had on claude design. the status bar on the top. maybe improved version ok.
     scroll following maybe good, maybe some kind of little widget could work. the point, I can see the various
     status of the page, by clicking the statuses." The operator, 2026-11-22, at the click-through of the first
     design-folder trial.
   - Kept from the old state bar: "the status nav should contain only what the showing page got. not the whole."
     The operator, at the old design canvas's state bar (its standing rule 1).
2. **Not wordy, not generated-looking.** "too much descriptive, ai slob like design." The operator, at the
   mood-directions round of the foundations design (quoted in the signed round's handoff, below); and of two signed
   rounds: "too long and fat", "only remove the descriptive texts. leave only essential ones."

## The look (the signed foundations, "Instrument")

Source: the foundations and Shell design, its "Instrument" round, signed by the operator 2026-11-15 ("accept."): its
house style and layout rules.

- **Mood:** Instrument: a precise tool, light by default, one blue accent; a dark scheme beside it.
- **Type:** IBM Plex Sans (IBM Plex Sans KR for Korean) in five steps: 12 meta, 14 text, 16 head, 22 title,
  28 figure; weights 400, 500 for names and labels, 600 for headings and figures. Figures are tabular.
- **Space and shape:** one control height, 44 px, for every button, field, menu row and link target; radii 6
  for controls and panels, 4 for marks; a centred column of at most 1200 px; container queries in em, never
  px media queries.
- **Colour:** only the roles in `tokens.css`. The accent is for the primary action, links, what is live and
  focus; danger only for a destructive confirm and an error. State is never colour alone.
- **Copy:** English chrome in sentence case; no exclamation mark, no "please", no "oops". One `h1` a page, named
  for the thing. A way back names where it goes ("< Personal"). Korean appears as data, never broken inside a
  word.

## Never

- An eyebrow over a heading, a subtitle that restates the title, a line under a control saying what it does.
- More than one primary button a screen; an action far from the thing it acts on.
- SVG artwork: "Svg artwork sucks overall" (the operator, quoted in the 1.0.0 drafter's craft standard). Marks
  are drawn in CSS.
