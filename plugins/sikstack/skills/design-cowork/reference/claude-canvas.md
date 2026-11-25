# design-cowork — a copy on a claude.ai canvas

The design folder stays the source. On the operator's ask, or when the repo's `Design:` line says
`publish: claude.ai`, its screens also go onto a claude.ai Design canvas. There is one artboard per page and state,
holding its 1440 and 390 full-page shots side by side. Teammates open the canvas in claude.ai and comment on its
artboards. The clickable build stays the sikstack web viewer's share link.

Only a session with the Artifact tool can publish to claude.ai, and the engine never does. Without the tool, say so
and offer sikstack web (`design-publish`). The tool takes canvas files only when you write them with your own file
tool, so the script writes a plan, and you write the files from it.

1. **Shoot.** Build and serve the folder on a free loopback port, as for Show. Then run the canvas script beside the
   layout check:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/templates/design/canvas.mjs" --base http://127.0.0.1:<port> --manifest <folder>/out/manifest.json --out <scratch>/canvas --title "<repo> design @ <commit>"
   ```
   It walks what the layout check walks, each run in a fresh context, and fails (exit 1) on a page that does not
   show its run's state. It hides the state widget, then writes `shots/` and `plan.json`. `plan.json` holds:
   - `canvas`: the index;
   - `artboards`: each one's file, title and whole `.dc.html` text, with an `@@shot:<file>@@` placeholder per image. The first is `Main.dc.html`;
   - `uploads`: batches of at most 25 shots and 15 MB.

   Act on its warnings: use `--pages` for fewer pages, or `--format jpeg` when the shots pass about 120 MB. To plan
   again from shots already taken, use `--plan-only <scratch>/canvas/shots` in place of `--base`. Keep the folder in
   scratch. Never commit it.
2. **Open every shot.** The Artifact tool publishes nothing it has not seen. Say the cost before you start: one
   image read per shot and one Write per artboard. Platform's build has 148 shots and 74 artboards.
3. **Create the canvas.** Find the Design type with the Artifact tool's quickstart, `intent: design`. Never use a
   hard-coded type link. Create the canvas with the title the script got: the repo and the design folder's commit.
4. **Upload each batch** of `plan.uploads` as the canvas's assets, one call per batch. Keep each shot's `/_blob/` url.
5. **Write and publish the entry.** With your own file tool, write `<scratch>/canvas/project/canvas.json` from
   `plan.canvas`, setting `createdOnFiles.at` to now. Then write `project/Main.dc.html`, copying its plan text with its
   upload urls in place of the placeholders. Publish those two in one call, with `root` = `<scratch>/canvas`.
6. **Write and publish the rest.** Write every other artboard the same way, with parallel Writes, about 25 to a
   message. Then run the check over what you wrote:
   `node "${CLAUDE_PLUGIN_ROOT}/tests/canvas_check.mjs" <scratch>/canvas`. It checks the skeleton, each frame, that
   boards, order and files agree, that no frames overlap, and that every `<img>` has a `/_blob/` url with no
   placeholder left. Fix what it names, then publish the rest with the same `url` and `root`: one new artboard as
   `file_path`, the others in `files`. Each call carries only files that no earlier call sent.
7. **Never publish a file a script wrote.** Where the create result's instructions differ from the plan (a name, a
   limit, the skeleton), follow them, and tell the operator what you changed.
8. **Report the canvas link.** It is private until the operator shares it from claude.ai. Each publish makes a new
   canvas. Never publish unasked. A publish is never a sign-off.
