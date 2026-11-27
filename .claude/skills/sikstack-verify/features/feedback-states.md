# Feedback states

**Reach it:** the "Feedback" tab (`/feedback`, the org's list; a project's list is the same component) and one piece of feedback's page (`/feedback/<id>`). Each piece has one state: **Open** (the default the list opens on), **Filed** (on an agenda item), **Resolved** and **Dropped** (with an optional reason). The list's state filter shows each state with its count; picking rows acts on them at once. The item's page shows its state under the title and its acts at the head's end, before Add to agenda: Delete, Drop, Resolve on Open and Filed; Delete, Reopen on Resolved and Dropped. Delete is an owner's only; Drop and Delete ask first. Two accounts: the test account (`$SESSION`), the owner, and the second account (`$SESSION-other`, `run.sh signin other`), invited into the test account's org as `members.md` does it (the invite's link from `$EV/api.log`, the accept through `run.sh api other`), then switched to it with the org menu's form post (`/api/auth/org`). Filing and solving need the linked scratch checkout `run.sh workspace <dir>` makes (see `workspace.md`).

**Drive it:** the walkthrough's web lines, each shot at 1440 and 375 (checked for no sideways overflow): (1) the list opens on Open with the four counts, as the API answers them; (2) an org with no feedback says No feedback yet, and a search that matches nothing says so; (3) the member resolves one piece on its page, drops three from the list with one reason, and reopens one on its page; (4) the member has no Delete on the list or the page; (5) the owner deletes one from its page (back to the list it came from, with the toast) and two from the list, behind the confirm; (6) a web filing reads Filed on the page and under the list's Filed filter; (7) after `agenda-item done` and a `sync` in the checkout, the page reads Resolved. The keyboard path on the page: Drop's confirm opens on Cancel, Escape gives focus back to Drop. (The member's 403 on the delete route and the attachment files' removal are pytest's: `tests/test_feedback_delete*.py`.)

```bash drive
OTHER="$SESSION-other"
OTHER_EMAIL=other-verify@example.com
pw() { playwright-cli -s="${S:-$SESSION}" "$@" >>"$EV/drive.log" 2>&1; }
js() { playwright-cli -s="${2:-${S:-$SESSION}}" --raw eval "$1"; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
see() { # JS expressions: wait up to 15 s for each to be true in ${S:-$SESSION}
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
must() { [ $# -eq 3 ] || { echo "FAIL must takes 3 arguments, got $#"; return 1; }; [ "$2" = "$3" ] && echo "ok   $1" || { echo "FAIL $1: got '$2', want '$3'"; return 1; }; }
shots() { # name: 1440 and 375, each checked for sideways overflow, then back to 1440
  local w
  for w in 1440 375; do
    pw resize "$w" 900
    sleep 1
    must "$1 at $w has no sideways overflow" "$(js '() => document.documentElement.scrollWidth <= document.documentElement.clientWidth')" true
    pw screenshot --filename="$EV/states-$1-$w.png" --full-page
  done
  pw resize 1440 900
}
body() { sed -n '2,$p'; }
status() { sed -n 's/^status=//p' | head -1; }
counts() { # the state filter as the page shows it: open,filed,resolved,dropped
  js '() => [...document.querySelectorAll("nav.fl-states .fl-n")].map(n => n.textContent.trim()).join(",")' | tr -d '"'
}
rows() { js '() => document.querySelectorAll("section.fl-panel tbody tr").length' | tr -d '"'; }
line() { js '() => document.querySelector("main .fi-state")?.innerText.replace(/\s+/g, " ").trim() ?? "none"' | tr -d '"'; }
acts() { # the item page's acts, in order
  js '() => [...document.querySelectorAll("main .fi-acts button")].map(b => b.querySelector(".swap > span")?.textContent ?? b.textContent).join(",")' | tr -d '"'
}
head_acts() { # the list's acts on the picked rows
  js '() => [...document.querySelectorAll("main .fl-head-acts .fl-acts button")].map(b => b.querySelector(".swap > span")?.textContent ?? b.textContent).join(",")' | tr -d '"'
}
act() { pw click "main .fi-acts >> role=button[name=\"$1\"]"; }
list_act() { pw click "main .fl-head-acts >> role=button[name=\"$1\"]"; }
tick() { pw check "role=checkbox[name=\"Select: $1\"]"; }
yes() { # the open confirm's own act (Yes, drop / Yes, delete)
  js "() => { const b = [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.startsWith($(q "$1"))); b?.click(); return !!b; }" >/dev/null
}
api_state() { # id: the stored state's name, as GET /app/feedback/{id} answers the owner
  "$RUN" api GET "/app/feedback/$1" | body | python3 -c 'import json,sys; print(json.load(sys.stdin)["record"]["state"]["state"])'
}
send_feedback() { # message: from the dashboard's Send feedback; prints the feedback's id
  pw goto "$WEB/dashboard"
  pw click 'role=button[name="Send feedback"]'
  pw fill 'role=textbox[name="Message"]' "$1"
  pw click 'role=button[name="Send"]'
  "$RUN" expect "Feedback sent" >/dev/null
  pw goto "$WEB/feedback"
  see "$(shows "$1")" >/dev/null
  js "() => [...document.querySelectorAll('a[href^=\"/feedback/\"]')].find(a => a.innerText.includes($(q "$1")))?.getAttribute('href').split('?')[0].split('/').pop()" | tr -d '"'
}

# 0. Both accounts; the second joins the test account's org as a member.
"$RUN" signin
"$RUN" signin other
ME=$("$RUN" api GET /auth/me | body)
ORG_ID=$(printf '%s' "$ME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["active_tenant_id"])')
must "the invite is made" "$("$RUN" api POST /app/invites "{\"email\": \"$OTHER_EMAIL\"}" | status)" 201
CODE=""
for _ in $(seq 1 10); do
  CODE=$(grep -F "no invite mail to $OTHER_EMAIL. The invite link: " "$EV/api.log" | sed -n 's/.*invite?code=\([^ ]*\).*/\1/p' | tail -1 || true)
  [ -n "$CODE" ] && break; sleep 1
done
must "the second account accepts" "$("$RUN" api other POST "/app/invite/$CODE/accept" | status)" 200

# 2. An org with no feedback: No feedback yet, not "matches"; a search that matches nothing says so.
pw goto "$WEB/feedback"
see "$(shows "No feedback yet.")" "!($(shows "matches"))"
shots 02-none
pw goto "$WEB/feedback?q=zzzz"
see "$(shows "No open feedback contains “zzzz”.")"
shots 02-no-match

# 1. Eight pieces of feedback; the list opens on Open, the filter's counts are the API's, and the rows match.
M_RES="States: resolve me on my page"
M_D1="States: drop one, then reopen"
M_D2="States: drop two"
M_D3="States: drop three"
M_PAGE="States: the owner deletes me on my page"
M_L1="States: the owner deletes me from the list"
M_L2="States: the owner deletes me too"
M_FILE="States: file me, then solve my item"
F_RES=$(send_feedback "$M_RES"); F_D1=$(send_feedback "$M_D1"); F_D2=$(send_feedback "$M_D2"); F_D3=$(send_feedback "$M_D3")
F_PAGE=$(send_feedback "$M_PAGE"); F_L1=$(send_feedback "$M_L1"); F_L2=$(send_feedback "$M_L2"); F_FILE=$(send_feedback "$M_FILE")
for f in "$F_RES" "$F_D1" "$F_D2" "$F_D3" "$F_PAGE" "$F_L1" "$F_L2" "$F_FILE"; do [ -n "$f" ] || { echo "FAIL a feedback id was not found"; exit 1; }; done
LISTED=$("$RUN" api GET /app/feedback | body)
must "line 1: GET /app/feedback with no state lists Open only, with the four counts" \
  "$(printf '%s' "$LISTED" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d["records"]), {r["state"]["state"] for r in d["records"]} == {"open"}, ",".join(str(d["counts"][s]) for s in ("open","filed","resolved","dropped")))')" "8 True 8,0,0,0"
must "line 1: a bad state is a 400" "$("$RUN" api GET "/app/feedback?state=nope" | status)" 400
pw goto "$WEB/feedback"
see "$(shows "$M_FILE")"
must "line 1: the filter shows the API's counts" "$(counts)" "8,0,0,0"
must "line 1: the rows are Open's count" "$(rows)" 8
must "line 1: Open is the current state" "$(js '() => document.querySelector("nav.fl-states [aria-current=page]")?.textContent.replace(/[0-9]/g, "").trim()' | tr -d '"')" Open
shots 01-open

# 3. The member, in the shared org: resolves one on its page, drops three from the list with one reason, reopens one.
js "async () => { const r = await fetch('/api/auth/org', { method: 'POST', body: new URLSearchParams({ org: $(q "$ORG_ID") }) }); return r.ok; }" "$OTHER" >/dev/null
export S="$OTHER"
pw goto "$WEB/feedback"
see "$(shows "$M_RES")"
must "line 3: the member's list is the shared org's" "$(counts)" "8,0,0,0"
pw goto "$WEB/feedback/$F_RES"
see '!!document.querySelector("main .fi-state")'
must "line 4: the member's acts on an Open piece have no Delete" "$(acts)" "Drop,Resolve"
shots 04-member-item
act Resolve
see "$(shows "Reopen")"
must "line 3: the page reads Resolved, by the member" "$(line | sed 's/ · .*//')" "Resolved $OTHER_EMAIL"
must "line 3: the member's acts on a Resolved piece" "$(acts)" Reopen
must "line 3: the API stored Resolved" "$(api_state "$F_RES")" resolved
shots 03-item-resolved
pw goto "$WEB/feedback"
see "$(shows "$M_D1")" "!($(shows "$M_RES"))"
for m in "$M_D1" "$M_D2" "$M_D3"; do tick "$m"; done
see "$(shows "3 of 7 selected")"
must "line 4: the member's acts on picked rows have no Delete" "$(head_acts)" "Drop,Resolve"
shots 04-member-list
list_act Drop
see 'document.querySelector("dialog[open]") !== null' "$(shows "Drop 3 pieces of feedback?")"
pw fill 'dialog[open] >> role=textbox' "Answered in the release notes"
shots 03-confirm-drop
yes "Yes, drop"
see "$(shows "Dropped 3 pieces of feedback.")" "!($(shows "$M_D2"))"
must "line 3: the counts moved" "$(counts)" "4,0,1,3"
pw goto "$WEB/feedback?state=dropped"
see "$(shows "$M_D3")"
must "line 3: the Dropped rows show the reason" "$(js '() => [...document.querySelectorAll("section.fl-panel tbody tr")].filter(r => r.innerText.includes("Answered in the release notes")).length' | tr -d '"')" 3
shots 03-list-dropped
pw goto "$WEB/feedback/$F_D1"
see '!!document.querySelector("main .fi-state")'
must "line 3: the page shows the reason" "$(line | sed 's/ other-verify.*//')" "Dropped Answered in the release notes"
shots 03-item-dropped
act Reopen
see "$(shows "Resolve")"
must "line 3: Reopen reads Open again" "$(line)" Open
must "line 3: the API stored Open" "$(api_state "$F_D1")" open
pw goto "$WEB/feedback?state=resolved"
see "$(shows "$M_RES")"
shots 03-list-resolved
unset S

# 5. The owner deletes: one from its page, opened from the list (back to it, with the toast), two from the list.
pw goto "$WEB/feedback"
see "$(shows "$M_PAGE")"
pw click "main >> role=link[name=\"$M_PAGE\"]"
see "location.pathname === '/feedback/$F_PAGE'" '!!document.querySelector("main .fi-acts")'
must "line 5: the owner's acts on an Open piece" "$(acts)" "Delete,Drop,Resolve"
act Delete
see 'document.querySelector("dialog[open]") !== null' "$(shows "Delete “${M_PAGE}”?")" "$(shows "deleted for good")"
must "the confirm opens on Cancel" "$(js '() => document.activeElement?.textContent.trim()' | tr -d '"')" Cancel
shots 05-confirm-delete-item
yes "Yes, delete"
see "location.pathname === '/feedback'" "$(shows "Deleted 1 piece of feedback.")" "!($(shows "$M_PAGE"))"
shots 05-deleted-from-page
must "line 5: the deleted piece is gone from the API" "$("$RUN" api GET "/app/feedback/$F_PAGE" | status)" 404
tick "$M_L1"; tick "$M_L2"
see "$(shows "2 of 4 selected")"
must "line 5: the owner's acts on picked rows" "$(head_acts)" "Delete,Drop,Resolve"
list_act Delete
see 'document.querySelector("dialog[open]") !== null' "$(shows "Delete 2 pieces of feedback?")"
shots 05-confirm-delete-list
yes "Yes, delete"
see "$(shows "Deleted 2 pieces of feedback.")" "!($(shows "$M_L1"))" "!($(shows "$M_L2"))"
must "line 5: the list's counts after the deletes" "$(counts)" "2,0,1,2"
for f in "$F_L1" "$F_L2"; do must "line 5: $f is gone from the API" "$("$RUN" api GET "/app/feedback/$f" | status)" 404; done
shots 05-list-after-delete

# The keyboard path on the page: Drop's confirm opens on Cancel; Escape closes it and focus returns to Drop.
pw goto "$WEB/feedback/$F_D1"
see '!!document.querySelector("main .fi-acts")'
js '() => [...document.querySelectorAll("main .fi-acts button")].find(b => b.textContent.startsWith("Drop")).focus()' >/dev/null
pw press Enter
see 'document.querySelector("dialog[open]") !== null'
must "keyboard: Drop's confirm opens on Cancel" "$(js '() => document.activeElement?.textContent.trim()' | tr -d '"')" Cancel
pw press Escape
see 'document.querySelector("dialog[open]") === null'
must "keyboard: Escape gives focus back to Drop" "$(js '() => document.activeElement?.textContent.startsWith("Drop")' | tr -d '"')" true

# 6. Filing reads Filed: the checkout linked, Add to agenda (a new agenda) on the page; the page and Filed show it.
pw goto "$WEB/feedback/$F_FILE"
see "$(shows "has no workspace linked")"
shots 06-no-workspace
eval "$("$RUN" workspace "$EV/states-ws-$(date +%H%M%S)")"
sk() { (cd "$WS" && env -u SIKSTACK_ROOT XDG_CONFIG_HOME="$XDG" SIKSTACK_NO_OFFER=1 "$SK" "$@"); }
sk sync >>"$EV/sync.log" 2>&1
pw goto "$WEB/feedback/$F_FILE"
see '[...document.querySelectorAll("main button")].some(b => b.textContent.trim() === "Add to agenda")'
must "the acts come before Add to agenda" "$(js '() => [...document.querySelectorAll("main .fi-head-end button")].map(b => b.querySelector(".swap > span")?.textContent ?? b.textContent.trim()).join(",")' | tr -d '"')" "Delete,Drop,Resolve,Add to agenda"
shots 06-offered
pw click 'main >> role=button[name="Add to agenda"]'
see 'document.querySelector("dialog input[type=radio]")?.checked === true'
pw click 'role=dialog >> role=button[name="Add to agenda"]'
see "$(shows "Added to agenda")"
must "line 6: the API stored Filed at once" "$(api_state "$F_FILE")" filed
AGENDA=$("$RUN" api GET "/app/feedback/$F_FILE" | body | python3 -c 'import json,sys; print(json.load(sys.stdin)["record"]["state"]["agenda"])')
pw reload
see '!!document.querySelector("main .fi-state")'
must "line 6: the page reads Filed, on its agenda" "$(line | cut -d' ' -f1-2)" "Filed $AGENDA"
shots 06-item-filed
pw goto "$WEB/feedback?state=filed"
see "$(shows "$M_FILE")" "$(shows "$AGENDA")"
must "line 6: the Filed filter holds it" "$(counts)" "1,1,1,2"
shots 06-list-filed

# 7. Solving closes it: the item done in the checkout, a sync; the page reads Resolved, by the person, on its agenda.
sk sync >>"$EV/sync.log" 2>&1
show=$(sk agenda-show "$AGENDA"); printf '%s\n' "$show" >"$EV/states-agenda-show.txt"
ITEM=$(python3 -c 'import json,pathlib,sys; print(next(p.name for p in sorted(pathlib.Path(sys.argv[1]).glob("*.json")) if json.loads(p.read_text()).get("source") == "feedback:" + sys.argv[2]))' \
  "$WS/.sikstack/works/agenda/$AGENDA/entries" "$F_FILE")
echo "the feedback's item: $ITEM"
sk agenda-item done --author person:verify "$ITEM" >>"$EV/sync.log" 2>&1
sk sync >>"$EV/sync.log" 2>&1
must "line 7: the API stored Resolved after the sync" "$(api_state "$F_FILE")" resolved
pw goto "$WEB/feedback/$F_FILE"
see '!!document.querySelector("main .fi-state")'
must "line 7: the page reads Resolved, on its agenda, by the person" "$(line | cut -d' ' -f1-3)" "Resolved $AGENDA verify"
must "line 7: Reopen is offered" "$(acts)" "Delete,Reopen"
shots 07-item-resolved
sk sync >>"$EV/sync.log" 2>&1
must "line 7: a later sync leaves it Resolved" "$(api_state "$F_FILE")" resolved
pw goto "$WEB/feedback"
pw screenshot --filename="$EV/feedback-states.png"
echo "feedback-states: PASS"
```

**Proof:** every `must` prints `ok`, every `see` is seen, and the block ends `feedback-states: PASS`. The shots are in `$EV`, each at 1440 and 375 (`states-<step>-{1440,375}.png`): `02-none` (No feedback yet), `02-no-match`, `01-open` (Open current, the counts 8,0,0,0), `04-member-item` and `04-member-list` (no Delete), `03-item-resolved` (Resolved, by the member, Reopen), `03-confirm-drop` (one reason for three), `03-list-dropped` (the Reason column), `03-item-dropped` (the reason under the title), `03-list-resolved`, `05-confirm-delete-item` (what goes, focus on Cancel), `05-deleted-from-page` (back on the list with the toast), `05-confirm-delete-list`, `05-list-after-delete`, `06-no-workspace`, `06-offered` (the acts before Add to agenda), `06-item-filed` (Filed and its agenda after a reload), `06-list-filed`, `07-item-resolved` (Resolved by `person:verify` on its agenda), and `feedback-states.png`. `states-agenda-show.txt` is the agenda after the filing; `sync.log` each sync. The checkout stays under `$EV/states-ws-<time>/`; `run.sh down` removes its key.
