# Native blocks: what a light document uses

A native document is CommonMark plus GFM (tables, strikethrough, autolinks) and three extensions: **callouts**, **typed fenced blocks** and **heading ids**. The server rejects anything else at publish (and `knowledge check` before it) with a line-numbered list; it never repairs silently.

## Hard rules (each is a 422)

- **The body only:** no `---` header and no `# H1` (title, summary and tags are `save` flags).
- **No raw HTML** anywhere: no tag, no `<br>`, no `<!-- -->`. A `<` that cannot read as a tag (`a < b`) is fine.
- **Headings are `##`, `###`, `####` only,** at the top level (never inside a list, quote or callout).
- **Typed blocks are top-level only.** A fence's info string is only `` ```[lang] [title="…"] [#id] ``. The body is YAML.
- **Links:** `#id` (in this document), `http(s)://…`, `doc:[<project>/]<slug>`, `chapter:[<project>/]<book>/<key>[#id]`, `term:<id>` (a glossary term). No relative paths, bare file names or `mailto:`. A `#id` that matches nothing is an error.
- **Images** are `![alt](asset:NAME)`, each name attached at publish (`--asset NAME=PATH`); never an `http(s)` image URL.
- **YAML strings:** quote any value holding `: `, a leading `#`, `{`, `[`, `*`, `&`, `!`, `|`, `>`, `%`, `@` or a backtick, and any number-looking label (`label: "2024"`). No anchors, aliases or duplicate keys; unknown keys are rejected.

## Ids

`[a-z0-9][a-z0-9-]{0,63}`, unique in the document. Give every `##` and `###` heading one (`## How a write lands {#write-path}`), and every typed block (`` ```diagram #write-flow ``). These ids are the section anchors search and links use: keep them across versions and translations. The Sources heading is `## Sources {#sources-list}`.

## Callouts

A blockquote whose first line is `[!TYPE]` and an optional title; a `-` right after the type collapses it. Types: `NOTE`, `IMPORTANT` (the key-idea box, used for "In one paragraph"), `WARNING`, `CAUTION`, `SKIP` (skip this if you know), `DEFINITION`.

````markdown
> [!IMPORTANT] In one paragraph
> After this you can add a route and its test. Every route goes through one auth dependency.

> [!NOTE]- Why the lock is per project
> Secondary depth goes in a collapsed note so the main line reads fast.
````

## Code

A standard fence with `title="path"` and an optional id. The title carries the code location, so the prose need not repeat it.

````markdown
```python title="server/main.py" #save-route
@app.post("/api/documents")
def save(...): ...
```
````

## Diagrams

Drawn by the reader from data. Every diagram has `kind` and `title`; `caption` is optional Markdown. The title and caption are what Listen reads aloud, so together they say the point in a sentence ("A request goes to the cache first and reaches the database only on a miss"), never "diagram showing boxes". Tones: `default`, `muted`, `accent`, `ok`, `warn`, `bad`, `store`, `series-1`…`series-6`.

- `flow`: `nodes[{id, label, sub?, at?: [row, col], shape?: box|pill|store|entity, fields?[], tone?}]`, `groups?[{id, label, nodes[]}]`, `edges[{from, to, label?, style?: solid|dashed, tone?}]`, `direction?: down|right`.
- `state`: a `flow` plus `initial` and `final`.
- `sequence`: `actors[{id, label}]`, `steps[{from, to, label, style?, note?}]`.
- `stack`: `layers[{label, items?[], tone?}]`, `nested?: bool`.
- `timeline`: `axis{unit, from, to, ticks?}`, `lanes[{label, bars[{from, to, label?, tone?}], marks?[{at, label}]}]`.
- `chart`: `type: bar|line|interval`, `x{label, categories? | numeric{from, to}}`, `y{label, min?, max?}`, `series[{name, values[], tone?}]`.

Limits: 60 nodes, 100 edges, 12 lanes, 200 chart points.

````markdown
```diagram #write-flow
kind: flow
title: A save goes through the API, which indexes it before it answers
direction: right
nodes:
  - {id: cli, label: knowledge save, shape: pill}
  - {id: api, label: API}
  - {id: db, label: Index, shape: store, tone: store}
edges:
  - {from: cli, to: api, label: POST}
  - {from: api, to: db, label: index}
```
````

A `mermaid` fence is just code; do not use it for a picture.

## On request only

- **Glossary:** one `` ```glossary #glossary `` block before Sources, `terms: [{id, term, aliases?, short}]`; link a term's first use with `[text](term:<id>)`.
- **Quiz:** a `` ```quiz #quiz `` block; run `knowledge check` on it, which names any field it refuses.
- **Formula:** `` ```formula #id `` with `tex` (in a `|` block scalar), `alt` (spoken), `reading` (no math) and `where: [{sym, means}]`; inline math is `` $`…`$ ``.
- **Figure** (`src`, `alt`, `caption`) and **figures** rows for an image the operator gave you; an `svg` block (one `<svg>` with a `viewBox`, colour only via `currentColor` or `kb-fill-<tone>` classes, no script or style) when no diagram kind fits.

## Before you check

No `#` or `#####` heading, no raw HTML, every `#id` link resolves, every `asset:` name is attached, no colon-bearing or number-like YAML string left unquoted. Then `knowledge check` (`reference/publish.md`).
