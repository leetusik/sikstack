# Workspace agenda

**Reach it:** the project rail's "Workspace" entry: the Agenda at `/projects/<id>/workspace`, an agenda's page at `…/workspace/agenda/<agenda>` (its **items**, each with its state, Done, Dismiss, Reopen and Delete, and the Split); a feedback item's "Add to agenda" at `/feedback/<id>`. Words: an **agenda** is a `works/agenda/<AID>/` record (a row of the Agenda), an **item** one file of its `entries/`. The Agenda is the linked checkout's, read through the API after each `sikstack sync`, so every step here is a web change, then a sync in the checkout, then what the engine prints. `run.sh workspace <dir>` makes that checkout (the branch's engine, linked to the test account's project `sikstack`; see `design-service.md`); `run.sh signin other` signs in the second account, a member of nothing here, and `run.sh api other …` calls the API as it.

The checkout is seeded by hand: `agenda-add` (one Open item), two deferred jobs written into `works/deferred/open/<id>/{deferred.json,brief.md}` as the old engine left them (one linked to that item, one not), `agenda-fold` (the linked job becomes an `issue` by `agent:fold` on the item, the other a Proposed item) and `agenda-add --author agent:…` (a second Proposed item). In zsh, never name a loop variable `path`.

**Drive it:** two feedback messages from the dashboard; the first onto a new agenda, the second onto that agenda; a note in an agenda's composer, with its author; its items, oldest first; the Proposed part and Accept, a non-member refused; an item Done, then a Split onto a new agenda, then Done on the last open item, which closes the agenda (Solved, predicted while it waits, then the engine's); Propose on the Agenda where Defer was, no Deferred anywhere; the old deferred-job addresses, by `curl -sI` and in the browser.

```bash drive
OTHER="$SESSION-other"
P() { printf '%s' "$WEB/projects/$PROJECT/workspace$1"; }
pw() { playwright-cli -s="$SESSION" "$@" >>"$EV/drive.log" 2>&1; }
js() { playwright-cli -s="$SESSION" --raw eval "$1"; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
see() { # JS expressions: wait up to 15 s for each to be true
  local e i
  for e in "$@"; do
    i=0
    until [ "$(js "() => ($e)")" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 15 ] && { echo "not seen: $e (at $(js '() => location.href'))"; return 1; }; sleep 1
    done
    echo "seen: $e"
  done
}
shows() { printf 'document.body.innerText.includes(%s)' "$(q "$1")"; }
before() { # a, b: the page shows a, then b further down
  printf '(t => t.indexOf(%s) >= 0 && t.indexOf(%s) > t.indexOf(%s))(document.querySelector("main").innerText)' "$(q "$1")" "$(q "$2")" "$(q "$1")"
}
inpart() { # part, text: the section headed part holds the text
  printf '[...document.querySelectorAll("section")].some(s => s.querySelector("h2")?.textContent.trim() === %s && s.innerText.includes(%s))' "$(q "$1")" "$(q "$2")"
}
openfirst() { # text: the first row of Open and in progress holds it
  printf '[...document.querySelectorAll("section")].find(s => s.querySelector("h2")?.textContent.trim() === "Open and in progress")?.querySelector("li")?.innerText.includes(%s) === true' "$(q "$1")"
}
must() { # what, then a python expression over s (the text in $2)
  python3 -c 'import re,sys; s=sys.argv[2]; ok=eval(sys.argv[3]); print(("ok   " if ok else "FAIL ")+sys.argv[1]+("" if ok else "\n     got: "+s[:800])); sys.exit(0 if ok else 1)' "$1" "$2" "$3"
}
addable() { printf '[...document.querySelectorAll("main button")].some(b => b.textContent.trim() === "Add to agenda")'; }
shot() { pw screenshot --filename="$EV/workspace-$1.png"; }
sync() { local out; out=$(sk sync 2>&1); printf '%s\n' "$out" >>"$EV/sync.log"; printf '%s\n' "$out" | grep -q '^in sync' || { echo "sync: $out"; return 1; }; }
item_of() { # a title: the newest item's id with that title, from the engine's list
  sk agenda --json | python3 -c 'import json,sys; t=sys.argv[1]; print(max((int(i["id"][1:].split("-")[0]), i["id"]) for i in json.load(sys.stdin) if i["title"] == t)[1])' "$1"
}
open_ids() { # the Open items' ids, in the engine's order
  sk agenda --json | python3 -c 'import json,sys; print(" ".join(i["id"] for i in json.load(sys.stdin) if i.get("shown_status") == "Open"))'
}
send_feedback() { # message: from the dashboard's Send feedback; prints the feedback's id
  pw goto "$WEB/dashboard"
  pw click 'role=button[name="Send feedback"]'
  pw fill 'role=textbox[name="Message"]' "$1"
  pw click 'role=button[name="Send"]'
  "$RUN" expect "Feedback sent" >/dev/null
  pw goto "$WEB/feedback"
  see "$(shows "$(printf '%s' "$1" | head -1)")" >/dev/null
  js "() => [...document.querySelectorAll('a[href^=\"/feedback/\"]')].find(a => a.innerText.includes($(q "$(printf '%s' "$1" | head -1)")))?.getAttribute('href').split('/').pop()" | tr -d '"'
}

# 0. The linked checkout, seeded: an Open item, two deferred jobs folded (one onto it, one Proposed), an agent's
#    Proposed item; then a sync. Both accounts signed in.
"$RUN" signin
"$RUN" signin other
eval "$("$RUN" workspace "$EV/workspace-ws-$(date +%H%M%S)")"
sk() { (cd "$WS" && env -u SIKSTACK_ROOT XDG_CONFIG_HOME="$XDG" SIKSTACK_NO_OFFER=1 "$SK" "$@"); }
sk agenda-add --title "Retry the upload on a slow network" --author person:verify >>"$EV/seed.log"
NOTED=$(item_of "Retry the upload on a slow network")
job() { # id, title, linked item or "": a deferred job as the old engine wrote it
  local d="$WS/.sikstack/works/deferred/open/$1"
  mkdir -p "$d"
  python3 -c 'import json,sys; d={"id": sys.argv[1], "title": sys.argv[2], "source": "P1-aa.S1", "reason": "Not this phase", "trigger": "When it bites", "created_at": "2026-11-20T10:00:00Z", "status": "open"}; sys.argv[3] and d.update(agenda=sys.argv[3]); print(json.dumps(d, indent=2))' "$1" "$2" "$3" >"$d/deferred.json"
  printf '# Deferred: %s %s\n\n## Context\n\nWritten by hand for the verify skill.\n' "$1" "$2" >"$d/brief.md"
}
job D31-x9 "Tidy the release script" ""
job D32-y7 "Log each upload retry" "$NOTED"
sk agenda-fold | tee -a "$EV/seed.log"
FOLDED=$(item_of "Tidy the release script")
sk agenda-add --title "Cache the dashboard counts" --author agent:claude-opus-5-5 >>"$EV/seed.log"
AGENT=$(item_of "Cache the dashboard counts")
sync
echo "seeded: $NOTED (Open, holds D32-y7), $FOLDED (Proposed from D31-x9), $AGENT (Proposed by an agent)"

# 1. Feedback onto a new item: Add to agenda, A new item. The Agenda shows it first in Open, waiting; after the
#    sync, agenda-show prints one feedback entry by a person, its source feedback:<id> and a link back.
MSG1="Verify: the export button is hard to find"
MSG2="Verify: export is still hard to find from the list"
FB1=$(send_feedback "$MSG1"); FB2=$(send_feedback "$MSG2")
[ -n "$FB1" ] && [ -n "$FB2" ] || { echo "a feedback id was not found ($FB1, $FB2)"; exit 1; }
pw goto "$WEB/feedback/$FB1"
see "$(addable)"
pw click 'main >> role=button[name="Add to agenda"]'
see 'document.querySelector("dialog input[type=radio]")?.checked === true' "$(shows "A new agenda")"
shot 01-confirm-new
pw click 'role=dialog >> role=button[name="Add to agenda"]'
see "$(shows "Added to agenda")" "$(shows "Waiting for sync")"
shot 01-added
pw goto "$(P "")"
see "$(openfirst "$MSG1")" "$(shows "Waiting for sync")"
shot 01-agenda-waiting
sync
NEW=$(item_of "$MSG1")
[ "$(open_ids | cut -d' ' -f1)" = "$NEW" ] || { echo "$NEW is not first in Open: $(open_ids)"; exit 1; }
show=$(sk agenda-show "$NEW"); printf '%s\n' "$show" >"$EV/agenda-show-new-1.txt"
must "line 1: one feedback entry by a person, from feedback:$FB1, linking back" "$show" \
  "len(re.findall(r'feedback +by person:\S+ .*\(feedback:', s)) == 1 and 'feedback:$FB1' in s and '/feedback/$FB1' in s and '$MSG1' in s"

# 2. The second feedback onto that item: no new item; after the sync, two feedback entries; both feedback pages'
#    Agenda part names it.
count=$(sk agenda --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
pw goto "$WEB/feedback/$FB2"
see "$(addable)"
pw click 'main >> role=button[name="Add to agenda"]'
pw check "role=dialog >> role=radio[name*=\"$NEW\"]"
see "$(shows "It joins $NEW")"
shot 02-confirm-existing
pw click 'role=dialog >> role=button[name="Add to agenda"]'
see "$(shows "Added to agenda")" "$(inpart "Agenda" "$NEW")"
sync
[ "$(sk agenda --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')" = "$count" ] || { echo "a new item was made"; exit 1; }
show=$(sk agenda-show "$NEW"); printf '%s\n' "$show" >"$EV/agenda-show-new-2.txt"
must "line 2: two feedback entries on $NEW, one for each feedback" "$show" \
  "len(re.findall(r'feedback +by person:\S+ .*\(feedback:', s)) == 2 and 'feedback:$FB1' in s and 'feedback:$FB2' in s"
for fb in "$FB1" "$FB2"; do
  pw goto "$WEB/feedback/$fb"
  see "$(inpart "Agenda" "$NEW")" "!($(shows "Waiting for sync"))"
done
shot 02-feedback-agenda-part

# 3. A note in the composer: in the thread at once, waiting, under the writer's name; after the sync, agenda-show
#    prints `note by person:<handle>`, and the page shows that name with nothing waiting.
pw goto "$(P "/agenda/$NOTED")"
pw fill 'role=textbox[name="Note"]' "$(printf 'Seen twice on **2 GB** files; try `retry` with backoff.')"
pw click 'role=button[name="Add note"]'
see "$(shows "Waiting for sync")" '[...document.querySelectorAll("main strong")].some(e => e.textContent === "2 GB")' \
  '[...document.querySelectorAll("main code")].some(e => e.textContent === "retry")'
shot 03-note-waiting
pw reload
see "$(shows "Waiting for sync")" "$(shows "Seen twice on")"
sync
show=$(sk agenda-show "$NOTED"); printf '%s\n' "$show" >"$EV/agenda-show-noted.txt"
must "line 3: the note is by a person, from the web" "$show" "re.search(r'note +by person:\S+ .*\(web:agenda\)', s) is not None"
HANDLE=$(printf '%s\n' "$show" | sed -n 's/.*note  *by person:\([^ ]*\) .*(web:agenda).*/\1/p' | head -1)
pw reload
see "!($(shows "Waiting for sync"))" "$(shows "$HANDLE")" "!document.querySelector('main').innerText.includes('@')"

# 4. The thread, oldest first: the fold's issue (fold, Agent, from the job's slice, carrying D32-y7), then the
#    note (the person, Web), each Open with its ref.
see "$(before "Folded from deferred job D32-y7" "Seen twice on")" "$(before "Issue · P1-aa.S1" "Note · Web")" "$(before "Agent" "$HANDLE")" \
  "$(shows "2 items, 2 open")" 'document.querySelectorAll("main li[data-ref]").length === 2'
shot 04-thread

# 5. The Proposed part, apart from Open and before it, with who proposed each item.
pw goto "$(P "")"
see "$(inpart "Proposed" "Tidy the release script")" "$(inpart "Proposed" "Cache the dashboard counts")" \
  "$(inpart "Proposed" "claude-opus-5-5")" "$(before "Proposed" "Open and in progress")" \
  "!($(inpart "Open and in progress" "Cache the dashboard counts"))" "!($(shows "Deferred"))"
shot 05-proposed

# 6. A non-member's accept and move are refused by the same rule; Accept from the list puts the item first in Open,
#    waiting; after the sync the engine lists it Open, first, and its agenda.json has no proposed key.
for body in "{\"kind\": \"accept\", \"items\": [\"$AGENT\"], \"fields\": {}}" "{\"kind\": \"move\", \"items\": [\"$AGENT\"], \"fields\": {\"first\": true}}"; do
  out=$("$RUN" api other POST "/app/projects/$PROJECT/workspace/agenda/changes" "$body")
  printf '%s\n%s\n' "$body" "$out" >>"$EV/other-refused.txt"
  must "line 6: the second account is refused ($(printf '%s' "$body" | cut -c1-20)…)" "$out" "s.startswith('status=404') and 'project not found' in s"
done
pw click "li:has-text(\"$AGENT\") >> role=button[name=\"Accept: Cache the dashboard counts\"]"
see "$(shows "“Cache the dashboard counts” accepted, first in the open agendas. It waits for the next sync.")" \
  "$(openfirst "$AGENT")" "$(openfirst "Cache the dashboard counts")"
shot 06-accepted
pw reload
see "![...document.querySelectorAll('li')].some(li => li.innerText.includes($(q "$AGENT")) && li.querySelector('[aria-label^=\"Accept: \"]'))" "$(openfirst "$AGENT")"
sync
[ "$(open_ids | cut -d' ' -f1)" = "$AGENT" ] || { echo "$AGENT is not first in Open: $(open_ids)"; exit 1; }
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(1 if "proposed" in d else 0)' "$WS/.sikstack/works/agenda/$AGENT/agenda.json" \
  || { echo "$AGENT's agenda.json still has proposed"; exit 1; }
echo "ok   line 6: $AGENT is Open and first ($(open_ids)); its agenda.json has no proposed key"

# 6b. An agenda's items (walkthrough 12). $NEW holds the two feedback items: Done on the first reads Done at once,
#     waiting, the agenda still Open (one item open); after the sync the engine prints it done by the person.
ref_at() { js "() => document.querySelectorAll('main li[data-ref]')[$1]?.dataset.ref" | tr -d '"'; }
status_of() { sk agenda --json | python3 -c 'import json,sys; print(next(i["shown_status"] for i in json.load(sys.stdin) if i["id"] == sys.argv[1]))' "$1"; }
pw goto "$(P "/agenda/$NEW")"
see 'document.querySelectorAll("main li[data-ref]").length === 2'
R1=$(ref_at 0); R2=$(ref_at 1)
pw click "role=button[name=\"Done: $R1\"]"
see "$(shows "Waiting for sync")" "document.querySelector('main li[data-ref=\"$R1\"] .status')?.textContent === 'Done'" \
  "$(shows "2 items, 1 open")" '[...document.querySelectorAll("main h1 ~ * .status, .agendaitem-marks .status")].some(s => s.textContent === "Open")'
shot 06b-item-done-waiting
sync
show=$(sk agenda-show "$NEW"); printf '%s\n' "$show" >"$EV/agenda-show-new-3.txt"
must "line 12: one item done, one open, the agenda Open" "$show" "'1 done' in s and '1 open' in s and s.splitlines()[0].split()[1] == 'Open'"
pw reload
see "!($(shows "Waiting for sync"))" "document.querySelector('main li[data-ref=\"$R1\"] .status')?.textContent === 'Done'"

# 6c. A Split: $NOTED holds the fold's issue and the note; the note moves to a new agenda. The page lands on the new
#     agenda (the id the route minted), holding the note, waiting; after the sync the engine lists the new agenda Open
#     with that item, and $NOTED keeps the issue alone.
pw goto "$(P "/agenda/$NOTED")"
see 'document.querySelectorAll("main li[data-ref]").length === 2'
NOTE_REF=$(ref_at 1)
pw click 'main >> role=button[name="Split"]'
pw check "role=checkbox[name=\"Select: $NOTE_REF\"]"
pw fill 'role=textbox[name="Title"]' "Retry uploads with back-off"
shot 06c-split-form
pw click 'role=form[name="Split into a new agenda"] >> role=button[name="Split"]'
see "!location.pathname.endsWith($(q "/agenda/$NOTED"))" 'location.pathname.includes("/agenda/A")' \
  "$(shows "Retry uploads with back-off")" "$(shows "Seen twice on")" "$(shows "Waiting for sync")" "!($(shows "Folded from deferred job D32-y7"))"
SPLIT=$(js '() => location.pathname.split("/").pop()' | tr -d '"')
shot 06c-split-landed
sync
show=$(sk agenda-show "$SPLIT"); printf '%s\n' "$show" >"$EV/agenda-show-split.txt"
must "line 12: the new agenda $SPLIT is Open and holds the note" "$show" "s.splitlines()[0].split()[1] == 'Open' and 'Seen twice on' in s and 'items: 1' in s"
show=$(sk agenda-show "$NOTED"); printf '%s\n' "$show" >"$EV/agenda-show-noted-after-split.txt"
must "line 12: $NOTED keeps the issue alone" "$show" "'items: 1' in s and 'Folded from deferred job D32-y7' in s and 'Seen twice on' not in s"

# 6d. Done on the last open item of $NEW: the agenda closes itself. The page reads it Solved at once (the read's
#     prediction, with the engine's outcome words), waiting; after the sync the engine lists it Solved.
pw goto "$(P "/agenda/$NEW")"
pw click "role=button[name=\"Done: $R2\"]"
see "$(shows "Waiting for sync")" "$(shows "all items dealt with: 2 done, 0 dismissed")" \
  '[...document.querySelectorAll(".agendaitem-marks .status")].some(s => s.textContent === "Solved")' "$(shows "2 items")"
shot 06d-auto-close-predicted
sync
[ "$(status_of "$NEW")" = "Solved" ] || { echo "$NEW is $(status_of "$NEW"), not Solved"; exit 1; }
pw reload
see "!($(shows "Waiting for sync"))" '[...document.querySelectorAll(".agendaitem-marks .status")].some(s => s.textContent === "Solved")' \
  "$(shows "all items dealt with: 2 done, 0 dismissed")"
shot 06d-auto-close-applied
echo "ok   line 12: $NEW closed itself (Solved) once its last open item was done"

# 6e. Propose where Defer was (walkthrough 11): pick the split agenda on the Agenda and Propose it; it moves to
#     Proposed at once, waiting; after the sync the engine lists it Proposed. No Deferred on the page.
pw goto "$(P "")"
pw check 'role=checkbox[name="Select: Retry uploads with back-off"]'
see '[...document.querySelectorAll("main button")].some(b => b.textContent.trim() === "Propose")' \
  '![...document.querySelectorAll("main button")].some(b => b.textContent.trim() === "Defer")'
pw click 'role=region[name="Open and in progress"] >> role=button[name="Propose"]'
see "$(inpart "Proposed" "Retry uploads with back-off")" "$(shows "Waiting for sync")" "!($(shows "Deferred"))"
shot 06e-proposed
sync
[ "$(status_of "$SPLIT")" = "Proposed" ] || { echo "$SPLIT is $(status_of "$SPLIT"), not Proposed"; exit 1; }
echo "ok   line 11: Propose on the Agenda moved $SPLIT to Proposed"

# 7. The deferred pages are gone: no Deferred in the nav; each old address is a 307 to the Agenda or to the item
#    carrying the job (signed in), to the sign-in signed out; then the same addresses in the browser:
#    opened, and clicked as a link on a page.
see '![...document.querySelectorAll("nav a")].some(a => a.textContent.trim() === "Deferred")' "!($(shows "Deferred jobs"))"
COOKIE=$(python3 -c 'import json,sys; print("; ".join(c["name"]+"="+c["value"] for c in json.load(open(sys.argv[1]))["cookies"] if "localhost" in c["domain"]))' "$EV/auth-state.json")
redirect() { # path, expected Location (a path), [signed-out]
  local h st to
  if [ -n "${3:-}" ]; then h=$(curl -sI "$WEB$1"); else h=$(curl -sI -H "Cookie: $COOKIE" "$WEB$1"); fi
  st=$(printf '%s\n' "$h" | sed -n '1s/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p')
  to=$(printf '%s\n' "$h" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p' | sed "s#^$WEB##")
  printf '%s -> %s %s%s\n' "$1" "$st" "$to" "${3:+ (signed out)}" | tee -a "$EV/redirects.txt"
  [ "$st" = 307 ] && [ "$to" = "$2" ] || { echo "expected 307 $2"; return 1; }
}
: >"$EV/redirects.txt"
WSP="/projects/$PROJECT/workspace"
redirect "$WSP/deferred" "$WSP"
redirect "$WSP/deferred?page=2" "$WSP"
redirect "$WSP/deferred/D32-y7" "$WSP/agenda/$NOTED"
redirect "$WSP/deferred/D31-x9" "$WSP/agenda/$FOLDED"
redirect "$WSP/deferred/D99-zz" "$WSP"
redirect "$WSP/deferred/D32-y7" "/login?next=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$WSP/deferred/D32-y7")" out
pw goto "$WEB$WSP/deferred/D32-y7"
see "location.pathname === $(q "$WSP/agenda/$NOTED")" "$(shows "Retry the upload on a slow network")" "$(shows "Folded from deferred job D32-y7")"
shot 07-old-job-link
js "() => { const a = document.createElement('a'); a.href = $(q "$WSP/deferred/D31-x9"); a.textContent = 'An old job link'; document.querySelector('main').prepend(a); return true; }" >/dev/null
pw click 'role=link[name="An old job link"]'
see "location.pathname === $(q "$WSP/agenda/$FOLDED")" "$(shows "Tidy the release script")" "$(shows "Folded from deferred job D31-x9")"
pw goto "$WEB$WSP/deferred"
see "location.pathname === $(q "$WSP")" "$(inpart "Open and in progress" "Cache the dashboard counts")"
"$RUN" expect "Cache the dashboard counts" "$MSG1" "Retry the upload on a slow network" "Proposed"
pw screenshot --filename="$EV/workspace.png"
echo "workspace: PASS (agendas $NOTED, $NEW, $FOLDED, $AGENT, $SPLIT; feedback $FB1, $FB2)"
```

**Proof:** the block ends `workspace: PASS`; `workspace-01-*.png` to `workspace-07-*.png` (with `06b-item-done-waiting`, `06c-split-form`, `06c-split-landed`, `06d-auto-close-predicted`, `06d-auto-close-applied`, `06e-proposed`) and `workspace.png` (the Agenda after every step) in `$EV`, with `agenda-show-new-1.txt` (one `feedback by person:<handle> (feedback:<id>)` entry), `agenda-show-new-2.txt` (two), `agenda-show-new-3.txt` (one done, one open), `agenda-show-split.txt` (the new agenda Open with the note), `agenda-show-noted-after-split.txt` (the issue alone), `agenda-show-noted.txt` (`issue by agent:fold (slice:P1-aa.S1)` first, then `note by person:<handle> (web:agenda)`), `other-refused.txt` (two `status=404` `project not found`), `redirects.txt` (six 307s with their Locations; the browser opens one old job link and clicks another) and `sync.log` (each `in sync`). The checkout stays under `$EV/workspace-ws-<time>/`; `run.sh down` removes its key.
