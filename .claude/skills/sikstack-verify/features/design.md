# Design build

**Reach it:** no stack, no sign-in: the design build is static files. Build it and serve it on loopback, then run the Drive block with `WEB` set to the address `design:serve` prints, `EV` an evidence folder and `SESSION` a browser session name of your own (`run.sh feature design` needs `up`, which this does not):

```bash
pnpm --dir web design:build                       # web/design/out/ and out/manifest.json, from design/data/sample/
pnpm --dir web design:serve -- --port 3040 --log  # http://127.0.0.1:3040/, every request logged; stop it after
awk '/^```bash drive$/{on=1;next} /^```$/{on=0} on' .claude/skills/sikstack-verify/features/design.md >"$EV/design.sh"
WEB=http://127.0.0.1:3040 EV="$EV" SESSION=sikstack-design bash -euo pipefail "$EV/design.sh"
```

The pages sit at production's addresses for the recording's project (`00000000-0000-4000-8000-000000000001`): the Agenda at `/projects/<id>/workspace/`, an item at `…/workspace/agenda/<item>/`. Every change stays in the browser (`localStorage`); **Reset design data** (bottom right) puts the recording back.

**Drive it:** every Agenda action by client clicks, each change seen at once, after a reload and gone after Reset; an item added in the browser opened and edited, its Markdown note drawn; then the network log (only static files from `$WEB`) and the console (no error, so no hydration error).

```bash drive
P=00000000-0000-4000-8000-000000000001
AGENDA="$WEB/projects/$P/workspace/"
pw() { playwright-cli -s="$SESSION" "$@" >>"$EV/drive.log" 2>&1; }
js() { playwright-cli -s="$SESSION" --raw eval "$1"; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
see() { # JS expressions: wait up to 10 s for each to be true
  local e i
  for e in "$@"; do
    i=0
    until [ "$(js "() => ($e)")" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 10 ] && { echo "not seen: $e"; return 1; }; sleep 1
    done
    echo "seen: $e"
  done
}
shows() { printf 'document.body.innerText.includes(%s)' "$(q "$1")"; }
norow() { printf '![...document.querySelectorAll("li a")].some(a => a.textContent === %s)' "$(q "$1")"; }
inpart() { # part, title: the part's rows hold the title
  printf '[...document.querySelectorAll("section")].some(s => s.querySelector("h2")?.textContent.trim() === %s && [...s.querySelectorAll("li a")].some(a => a.textContent === %s))' "$(q "$1")" "$(q "$2")"
}
open_is() { # the open rows' titles, in order, joined by " | "
  printf '[...document.querySelectorAll("button[aria-label^=\\"Reorder: \\"]")].map(b => b.getAttribute("aria-label").slice(9)).join(" | ") === %s' "$(q "$1")"
}
logs() { # the requests and console messages of the page now loaded
  playwright-cli -s="$SESSION" requests >>"$EV/network.log" 2>&1
  playwright-cli -s="$SESSION" console >>"$EV/console.log" 2>&1
}
shot() { pw screenshot --filename="$EV/design-$1.png"; }
pick() { pw check "role=checkbox[name=\"Select: $1\"]"; }
act() { pw click "role=region[name=\"$1\"] >> role=button[name=\"$2\"]"; }
: >"$EV/network.log"; : >"$EV/console.log"
printf '{"outputDir": "%s"}\n' "$EV/cli-output" >"$EV/cli.config.json"

# 1. The Agenda from the recording, in the Shell, the clock pinned ("Synced 4m ago").
pw open "$AGENDA" --config="$EV/cli.config.json"
pw resize 1440 900
pw localstorage-clear
pw reload
see "$(shows "Synced 4m ago")" "$(open_is "Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Deferred" "Draft the release note")" "$(inpart "Solved and dropped" "Try a darker sidebar")"
shot 01-agenda
logs

# 2. Reorder by keyboard (Space, ArrowDown, Space) and by drag.
pw eval 'el => el.focus()' 'role=button[name="Reorder: Write the onboarding checklist"]'
pw press Space; pw press ArrowDown; pw press Space
see "$(open_is "Show the sync time in the header | Write the onboarding checklist | Check the empty state copy | Pick a name for the export button")"
pw drag 'role=button[name="Reorder: Pick a name for the export button"]' 'role=button[name="Reorder: Show the sync time in the header"]'
see "$(open_is "Pick a name for the export button | Show the sync time in the header | Write the onboarding checklist | Check the empty state copy")"
shot 02-reordered

# 3. Pick rows and Defer, Solve, Drop (with a reason), Reopen, Delete.
pick "Show the sync time in the header"; act "Open and in progress" Defer
see "$(inpart "Deferred" "Show the sync time in the header")"
pick "Check the empty state copy"; act "Open and in progress" Solve
see "$(inpart "Solved and dropped" "Check the empty state copy")"
pick "Pick a name for the export button"; act "Open and in progress" Drop
pw fill 'role=textbox[name="Reason (optional)"]' "Export reads best"
pw click 'role=button[name="Yes, drop"]'
see "$(inpart "Solved and dropped" "Pick a name for the export button")"
pick "Draft the release note"; act Deferred Reopen
see "$(open_is "Write the onboarding checklist | Draft the release note")"
pw click 'role=button[name="Delete: Try a darker sidebar"]'
pw click 'role=button[name="Yes, delete"]'
see "$(norow "Try a darker sidebar")" "!($(shows "Waiting for sync"))"
shot 03-acted

# 4. Every change survives a reload.
pw reload
see "$(open_is "Write the onboarding checklist | Draft the release note")" "$(inpart "Deferred" "Show the sync time in the header")" \
  "$(inpart "Solved and dropped" "Check the empty state copy")" "$(inpart "Solved and dropped" "Pick a name for the export button")" \
  "$(norow "Try a darker sidebar")"
shot 04-reloaded
logs

# 5. Add an item with a Markdown note, then open it: its page exists although the build never saw it.
pw click 'role=button[name="Add item"]'
pw fill 'role=textbox[name="Title"]' "Plan the design review"
pw fill 'role=textbox[name="Note (optional)"]' "$(printf 'Bring:\n\n- the **static build**\n- two screenshots')"
pw click 'role=button[name="Add"]'
see "$(open_is "Plan the design review | Write the onboarding checklist | Draft the release note")"
pw click 'role=link[name="Plan the design review"]'
see 'location.pathname.includes("/agenda/A8-")' 'document.querySelector("h1")?.innerText.includes("Plan the design review")' \
  'document.querySelectorAll("main ul li").length === 2' 'document.querySelector("main strong")?.textContent === "static build"'
shot 05-added-item

# 6. Edit its title and note: the new Markdown draws at once and after a reload.
pw click 'role=button[name="Edit"]'
pw fill 'role=textbox[name="Title"]' "Plan the design review with the team"
pw fill 'role=textbox[name="Note (optional)"]' "$(printf 'Bring:\n\n1. the **static build**\n2. two screenshots\n\nAsk about `Reset`.')"
pw click 'role=button[name="Save"]'
see 'document.querySelector("h1")?.innerText.includes("Plan the design review with the team")' \
  'document.querySelectorAll("main ol li").length === 2' 'document.querySelector("main code")?.textContent === "Reset"'
pw reload
see 'document.querySelector("h1")?.innerText.includes("Plan the design review with the team")' 'document.querySelectorAll("main ol li").length === 2'
shot 06-edited
logs

# 7. Back to the Agenda by its link; a recorded item's Markdown note; a page the design does not draw.
pw click 'main >> role=link[name="Agenda"]'
see "$(open_is "Plan the design review with the team | Write the onboarding checklist | Draft the release note")"
pw click 'role=link[name="Write the onboarding checklist"]'
see 'document.querySelectorAll("main ul li").length === 3' 'document.querySelector("main code")?.textContent === "sikstack link"'
shot 07-recorded-item
pw click 'role=link[name="Library"]'
see "$(shows "Not in this design")"
logs

# 8. Reset puts the recording back, and it stays back after a reload.
pw goto "$AGENDA"
pw click 'role=button[name="Reset design data"]'
see "$(open_is "Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Solved and dropped" "Try a darker sidebar")" "$(norow "Plan the design review with the team")"
pw reload
see "$(open_is "Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Deferred" "Draft the release note")"
shot 08-reset
logs

# 9. Nothing left the browser: every request went to $WEB and found a file; no console error (no hydration error).
pw close
other=$(grep -E '^[0-9]+\. \[' "$EV/network.log" | grep -vF " $WEB/" || true)
[ -z "$other" ] || { echo "requests outside $WEB:"; echo "$other"; exit 1; }
bad=$(grep -E '^[0-9]+\. \[' "$EV/network.log" | grep -v '=> \[200\]' || true)
[ -z "$bad" ] || { echo "requests that did not find a file:"; echo "$bad"; exit 1; }
grep -E 'Errors: [1-9]' "$EV/console.log" && { echo "console errors: see $EV/console.log"; exit 1; }
echo "design: PASS ($(grep -cE '^[0-9]+\. \[' "$EV/network.log") requests, all static files from $WEB; no console error)"
```

**Proof:** the screenshots `design-01-agenda.png` to `design-08-reset.png` in `$EV`; the block ends `design: PASS`. `network.log` holds only `$WEB` requests answered 200 (HTML, `_next/static` chunks, the `__next.*.txt` route payloads); `console.log` reads `Errors: 0` for every page; `design:serve --log` shows the same requests from the server's side. Stop the server and check `playwright-cli list` shows no `$SESSION`.
