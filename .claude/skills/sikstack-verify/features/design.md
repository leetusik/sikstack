# Design build

**Reach it:** no stack, no sign-in: the design build is static files. Build it and serve it on loopback, then run the Drive block with `WEB` set to the address `design:serve` prints, `EV` an evidence folder and `SESSION` a browser session name of your own (`run.sh feature design` needs `up`, which this does not):

```bash
pnpm --dir web design:build                       # web/design/out/ and out/manifest.json, from design/data/sample/
pnpm --dir web design:serve -- --port 3040 --log  # http://127.0.0.1:3040/, every request logged; stop it after
awk '/^```bash drive$/{on=1;next} /^```$/{on=0} on' .claude/skills/sikstack-verify/features/design.md >"$EV/design.sh"
WEB=http://127.0.0.1:3040 EV="$EV" SESSION=sikstack-design bash -euo pipefail "$EV/design.sh"
```

**Two checks, two names:** `pnpm --dir web design:check` is the production-exclusion check (a production build holds none of the design; it measures no page). The layout check is the sikstack plugin's `check.mjs`, over the served build: `node plugins/sikstack/templates/design/check.mjs --base "$WEB" --manifest web/design/out/manifest.json --out "$EV/layout"` prints one `ok` line, or one `FAIL` line per failure with a crop (exit 1); exit 2 is a usage or driver error, where nothing was checked. Each of its runs starts from empty storage.

The pages sit at production's addresses for the recording's project (`00000000-0000-4000-8000-000000000001`): the Agenda at `/projects/<id>/workspace/`, an item at `…/workspace/agenda/<item>/`. Every change stays in the browser (`localStorage`). The **state widget** (`web/design/lib/states.tsx`, the pill at the window's bottom left, `Design states: <page>, <state>`) opens to the page's own states and **Reset design data**; a state is in the address as `?state=<key>`.

**Drive it:** every Agenda action by client clicks, each change seen at once, after a reload and gone after Reset; an item added in the browser opened and edited, its Markdown note drawn; each page's states, each clicked, shown and kept by a reload; the widget by keyboard; the widget over no control at 1440 and 390 wide, scrolled to the top, middle and bottom; then the network log (only static files from `$WEB`) and the console (no error, so no hydration error).

```bash drive
P=00000000-0000-4000-8000-000000000001
AGENDA="$WEB/projects/$P/workspace/"
T10="The export button says Download on my phone but Export on my laptop. Which one is it?"  # A10-3n, filed from feedback f1
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

# 1. The Agenda from the recording, in the Shell, the clock pinned ("Synced just now"): Proposed (A8-sf by fold, A9-hb
#    by an agent) apart and before Open, whose first item is A10-3n, the item feedback f1 made.
pw open "$AGENDA" --config="$EV/cli.config.json"
pw resize 1440 900
pw localstorage-clear
pw reload
see "$(shows "Synced just now")" "$(open_is "$T10 | Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Proposed" "Retry a sync once after a network error")" "$(inpart "Proposed" "Show who wrote each note on an item")" \
  "$(inpart "Proposed" "Draft the release note")" "$(inpart "Solved and dropped" "Try a darker sidebar")" "!($(shows "Deferred"))"
shot 01-agenda
logs

# 2. Reorder by keyboard (Space, ArrowDown, Space) and by drag.
pw eval 'el => el.focus()' 'role=button[name="Reorder: Write the onboarding checklist"]'
pw press Space; pw press ArrowDown; pw press Space
see "$(open_is "$T10 | Show the sync time in the header | Write the onboarding checklist | Check the empty state copy | Pick a name for the export button")"
pw drag 'role=button[name="Reorder: Pick a name for the export button"]' 'role=button[name="Reorder: Show the sync time in the header"]'
see "$(open_is "$T10 | Pick a name for the export button | Show the sync time in the header | Write the onboarding checklist | Check the empty state copy")"
shot 02-reordered

# 3. Pick rows and Propose (back to Proposed: there is no Deferred), Solve, Drop (with a reason); Delete; Accept a
#    Proposed one (first in the open order, marked waiting as the read gives an accept).
pick "Show the sync time in the header"; act "Open and in progress" Propose
see "$(inpart "Proposed" "Show the sync time in the header")"
pick "Check the empty state copy"; act "Open and in progress" Solve
see "$(inpart "Solved and dropped" "Check the empty state copy")"
pick "Pick a name for the export button"; act "Open and in progress" Drop
pw fill 'role=textbox[name="Reason (optional)"]' "Export reads best"
pw click 'role=button[name="Yes, drop"]'
see "$(inpart "Solved and dropped" "Pick a name for the export button")"
pw click 'role=button[name="Delete: Try a darker sidebar"]'
pw click 'role=button[name="Yes, delete"]'
see "$(norow "Try a darker sidebar")" "!($(shows "Waiting for sync"))"
pw click 'role=button[name="Accept: Draft the release note"]'
see "$(open_is "Draft the release note | $T10 | Write the onboarding checklist")"
shot 03-acted

# 4. Every change survives a reload.
pw reload
see "$(open_is "Draft the release note | $T10 | Write the onboarding checklist")" "$(inpart "Proposed" "Show the sync time in the header")" \
  "$(inpart "Solved and dropped" "Check the empty state copy")" "$(inpart "Solved and dropped" "Pick a name for the export button")" \
  "$(norow "Try a darker sidebar")"
shot 04-reloaded
logs

# 5. Add an agenda with a Markdown note, then open it: its page exists although the build never saw it.
pw click 'role=button[name="Add agenda"]'
pw fill 'role=textbox[name="Title"]' "Plan the design review"
pw fill 'role=textbox[name="Note (optional)"]' "$(printf 'Bring:\n\n- the **static build**\n- two screenshots')"
pw click 'role=button[name="Add"]'
see "$(open_is "Plan the design review | Draft the release note | $T10 | Write the onboarding checklist")"
pw click 'role=link[name="Plan the design review"]'
see 'location.pathname.includes("/agenda/A11-")' 'document.querySelector("h1")?.innerText.includes("Plan the design review")' \
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

# 7. Back to the Agenda by its link; a recorded agenda's Markdown note; a page the design does not draw.
pw click 'main >> role=link[name="Agenda"]'
see "$(open_is "Plan the design review with the team | Draft the release note | $T10 | Write the onboarding checklist")"
pw click 'role=link[name="Write the onboarding checklist"]'
see 'document.querySelectorAll("main ul li").length === 3' 'document.querySelector("main code")?.textContent === "sikstack link"'
shot 07-recorded-item
pw click 'role=link[name="Library"]'
see "$(shows "Not in this design")"
logs

# 8. Reset (in the state widget) puts the recording back, and it stays back after a reload.
pw goto "$AGENDA"
pw click 'role=button[name^="Design states: "]'
pw click 'role=button[name="Reset design data"]'
see "$(open_is "$T10 | Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Solved and dropped" "Try a darker sidebar")" "$(norow "Plan the design review with the team")"
pw reload
see "$(open_is "$T10 | Write the onboarding checklist | Show the sync time in the header | Check the empty state copy | Pick a name for the export button")" \
  "$(inpart "Proposed" "Draft the release note")"
shot 08-reset
logs

# 9. Each page's widget lists exactly its own states; each click shows the state (one screenshot each); a reload
#    of the state's address shows it again; the current one is aria-pressed.
widget() { pw click 'role=button[name^="Design states: "]'; see 'document.querySelector("[data-design-state]") !== null'; }
states_are() { see "[...document.querySelectorAll('[data-design-state]')].map(b => b.dataset.designState).join(' ') === '$1'"; }
pressed() { printf "document.querySelector('[data-design-state=%s]')?.getAttribute('aria-pressed') === 'true' && location.search.includes('state=%s')" "$1" "$1"; }
state() { # page tag, state key, then texts the state shows
  local tag=$1 key=$2; shift 2
  pw click "[data-design-state=$key]"
  local e=("$(pressed "$key")"); for t in "$@"; do e+=("$(shows "$t")"); done
  see "${e[@]}"
  shot "09-$tag-$key"
}
pw goto "$AGENDA"
widget
states_are "recorded many empty waiting web-waiting behind loading unlinked never failed not-found error"
state agenda many "23 agendas" "Write tests for the reorder keys"
state agenda empty "No agendas yet."
state agenda waiting "A6-r2" "Plan the design review"
state agenda web-waiting "Synced 1m ago" "A11-vz" "The Agenda list gets long. I would like to collapse the Solved part."
state agenda behind "Last synced 3d ago"
state agenda loading "Loading…"
state agenda unlinked "No workspace linked yet."
state agenda never "Nothing has synced yet."
state agenda failed "The agenda did not load."
state agenda not-found "Project not found"
state agenda error "This page did not load"
state agenda recorded "Synced just now" "$T10"
pw goto "$AGENDA?state=never"
see "$(shows "Nothing has synced yet.")"
pw goto "$AGENDA?state=many"
see "$(shows "23 agendas")"
pw reload
see "$(shows "23 agendas")" "$(shows "Write tests for the reorder keys")"
widget
see "$(pressed many)"
ITEM="$WEB/projects/$P/workspace/agenda/A46-mr/"
pw click 'role=link[name="Write tests for the reorder keys"]'
see 'location.pathname.includes("/agenda/A46-mr")'
widget
states_are "open proposed note-waiting items solved dropped waiting loading not-found project-not-found failed error"
see "document.querySelector('[data-design-state=open]').getAttribute('aria-pressed') === 'true'"
state item proposed "Proposed by" "Accept"
state item note-waiting "Waiting for sync"
state item items "Done" "Dismissed" "A46-mr/mad1" "Split"
state item solved "Outcome"
state item dropped "Reason"
state item waiting "Waiting for sync"
state item loading "Loading…"
state item not-found "Agenda not found"
state item project-not-found "Project not found"
state item failed "This page did not load" "Synced just now"
state item error "This page did not load" "Back to Agenda"
state item open "Write tests for the reorder keys" "Propose"
pw goto "$ITEM?state=solved"   # a reload of a state's address; the item's state is the Agenda's data too
see "$(shows "Outcome")"
pw goto "$AGENDA"
see "$(shows "22 agendas")" "$(inpart "Solved and dropped" "Write tests for the reorder keys")"
logs

# 9b. The agenda with the most items (A3-1z): its six items oldest first, each with its ref, state, author and kind,
#     the two feedback items' kinds linking to their feedback. Then the feedback pages: f3 (on no agenda) and f1 (on
#     A10-3n and A3-1z), each widget listing exactly its states, each state shown.
before() { printf '(t => t.indexOf(%s) >= 0 && t.indexOf(%s) > t.indexOf(%s))(document.querySelector("main").innerText)' "$(q "$1")" "$(q "$2")" "$(q "$1")"; }
FB="$WEB/projects/$P/feedback/00000000-0000-4000-8000-0000000000f"
pw goto "$AGENDA?state=recorded"
pw goto "$WEB/"
pw click 'role=link[name="Agenda item"]'
see 'location.pathname.endsWith("/agenda/A3-1z/")' "$(shows "6 items, 6 open")" "$(shows "A3-1z/cfwk")" \
  "$(before "Folded from deferred job D1-k4" "Download reads like a file save")" "$(before "Download reads like a file save" "On a phone the button is an icon only")" \
  "$(before "On a phone the button is an icon only" "Going with Export")" "$(before "Going with Export" "I could not find where to export")" \
  "$(before "I could not find where to export" "$T10")" "$(before "Issue · P2-m7.S3" "Question · P2-m7.S4")" "$(shows "mina")" \
  '[...document.querySelectorAll("main a")].filter(a => a.textContent === "Feedback" && /\/feedback\/0+-0000-4000-8000-0000000000f[12]\/$/.test(a.getAttribute("href"))).length === 2'
shot 09b-entry-thread
logs
pw goto "${FB}3/"
widget
states_are "offered no-workspace confirm-new confirm-existing adding failed waiting no-project loading not-found error"
see "document.querySelector('[data-design-state=offered]')?.getAttribute('aria-pressed') === 'true'" "$(shows "Add to agenda")"
state feedback no-workspace "sample-product has no workspace linked, so it has no agenda to add this to."
by_address() { # page tag, key, texts: the confirm is modal and covers the widget, so its states open by their address
  local tag=$1 key=$2; shift 2
  pw goto "${FB}3/?state=$key"
  local e=("location.search.includes('state=$key')" 'document.querySelector("dialog")?.open === true'); for t in "$@"; do e+=("$(shows "$t")"); done
  see "${e[@]}"
  shot "09-$tag-$key"
}
by_address feedback confirm-new "A new agenda" "It becomes the first open item there"
by_address feedback confirm-existing "It joins A3-1z as an item"
by_address feedback adding "Adding…"
by_address feedback failed "Could not add this feedback to the agenda. Try again."
pw goto "${FB}3/?state=waiting"
see "$(shows "Added to agenda")" "$(shows "A11-vz")" "$(shows "Waiting for sync")"
shot 09-feedback-waiting
widget
see "$(pressed waiting)"
state feedback no-project "This feedback has no project, so there is no agenda to add it to."
state feedback loading "Loading…"
state feedback not-found "Feedback not found"
state feedback error "This page did not load"
state feedback offered "Add to agenda" "The Agenda list gets long."
logs
pw goto "${FB}1/"
widget
states_are "filed no-workspace"
see "document.querySelector('[data-design-state=filed]')?.getAttribute('aria-pressed') === 'true'" "$(shows "Added to agenda")" "$(shows "A10-3n")" "$(shows "A3-1z")"
state filed no-workspace "sample-product has no workspace linked, so it has no agenda to add this to."
state filed filed "A10-3n" "A3-1z"
logs

# 10. By keyboard: Tab reaches the pill, Enter opens it, Tab and Space pick a state, Escape closes and gives
#     the focus back to the pill.
pw goto "$AGENDA?state=recorded"
pw eval 'el => el.focus()' 'role=button[name^="Design states: "]'
pw press Enter
see 'document.querySelector("[data-design-state]") !== null'
pw press Tab
see 'document.activeElement?.dataset.designState === "recorded"'
pw press Tab
pw press Space
see "$(pressed many)" "$(shows "23 agendas")"
pw press Tab
pw press Enter
see "$(pressed empty)" "$(shows "No agendas yet.")"
pw press Escape
see 'document.querySelector("[data-design-state]") === null' 'document.activeElement?.getAttribute("aria-label") === "Design states: Agenda, Empty agenda"'
shot 10-keyboard

# 11. It follows the scroll and covers no control: at 1440 and 390 wide, scrolled to the top, the middle and the
#     bottom of the long Agenda, nothing a click or a key could reach lies under the widget.
under='(() => { const w = document.querySelector("[data-design-states]"); const r = w.getBoundingClientRect(); const hit = new Set();
  for (let x = r.left + 1; x < r.right; x += 3) for (let y = r.top + 1; y < r.bottom; y += 3)
    for (const el of document.elementsFromPoint(x, y)) { if (w.contains(el)) continue;
      const c = el.closest("a,button,input,select,textarea,summary,label,[role=button],[role=checkbox],[tabindex]");
      if (c) hit.add(c.tagName + " " + (c.getAttribute("aria-label") || c.textContent.trim().slice(0, 40))); }
  return [...hit].join(" | ") === "" && r.bottom <= innerHeight && r.top >= 0; })()'
pw goto "$AGENDA?state=many"
for size in "1440 900" "390 844"; do
  pw resize $size
  for at in top middle bottom; do
    case $at in top) y=0 ;; middle) y='(document.documentElement.scrollHeight - innerHeight) / 2' ;; bottom) y=document.documentElement.scrollHeight ;; esac
    js "() => { window.scrollTo(0, $y); return true; }" >/dev/null
    see "$under"
    shot "11-${size%% *}-$at"
  done
done
pw resize 1440 900
logs

# 12. The system page (/system/, linked from the index): every token of tokens.css (design:build already held the
#     page's list equal to the file's and every shared export drawn or listed), the light accent painted by the
#     token itself, both dialogs open in place (not modal), the toast on its board, no sideways scroll; one
#     screenshot a section at 1440 and 390.
pw goto "$WEB/"
pw click 'role=link[name="System"]'
see '[...new Set([...document.querySelectorAll("[data-token]")].map(e => e.dataset.token))].length >= 30' \
  'document.querySelectorAll("[data-component]").length > 40' \
  '(() => { const s = document.querySelector("[data-scheme=light] [data-token=\"--accent\"]"); return getComputedStyle(s.firstElementChild).backgroundColor !== "rgba(0, 0, 0, 0)"; })()' \
  '[...document.querySelectorAll("dialog")].length === 2 && [...document.querySelectorAll("dialog")].every(d => d.open && !d.matches(":modal"))' \
  '!!document.querySelector(".toast")'
for size in "1440 900" "390 844"; do
  pw resize $size
  see 'document.documentElement.scrollWidth <= innerWidth'
  for part in tokens ui frame states shell exports; do
    js "() => { document.getElementById('$part').scrollIntoView(); return true; }" >/dev/null
    shot "12-system-${size%% *}-$part"
  done
done
pw resize 1440 900
logs

# 13. Nothing left the browser: every request went to $WEB and found a file; no console error (no hydration error).
pw close
other=$(grep -E '^[0-9]+\. \[' "$EV/network.log" | grep -vF " $WEB/" || true)
[ -z "$other" ] || { echo "requests outside $WEB:"; echo "$other"; exit 1; }
bad=$(grep -E '^[0-9]+\. \[' "$EV/network.log" | grep -v '=> \[200\]' || true)
[ -z "$bad" ] || { echo "requests that did not find a file:"; echo "$bad"; exit 1; }
grep -E 'Errors: [1-9]' "$EV/console.log" && { echo "console errors: see $EV/console.log"; exit 1; }
echo "design: PASS ($(grep -cE '^[0-9]+\. \[' "$EV/network.log") requests, all static files from $WEB; no console error)"
```

**Proof:** the screenshots `design-01-agenda.png` to `design-08-reset.png`, `design-09-<page>-<state>.png` (one per state, the feedback pages' too), `design-09b-entry-thread.png`, `design-10-keyboard.png` and `design-11-<width>-<top|middle|bottom>.png`, `design-12-system-<width>-<section>.png` in `$EV`; the block ends `design: PASS`. `network.log` holds only `$WEB` requests answered 200 (HTML, `_next/static` chunks, the `__next.*.txt` route payloads); `console.log` reads `Errors: 0` for every page; `design:serve --log` shows the same requests from the server's side. Stop the server and check `playwright-cli list` shows no `$SESSION`.
