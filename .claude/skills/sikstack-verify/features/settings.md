# Settings (`/settings`, `/projects/<id>/settings`)

**Reach it:** the rail's Settings, last in both forms: the org rail's goes to Org settings (`/settings`: Org name, Public URL, Members, Invites, Delete org), a project's to Project settings (`/projects/<id>/settings`: Visibility, the project's API keys, Delete project). Two accounts: the test account (`$SESSION`) and the second (`$SESSION-other`, `run.sh signin other`), each starting in its sign-up org, `Personal`. Run it on a fresh `up`, before `members` (it starts from one org per account, and leaves each account one org again: the test account its own, the second a fresh `Personal`). The stack's `sikstack` project is the install-feedback project (`up`'s `KB_INSTALL_FEEDBACK_PROJECT_ID`), so it and the test account's org give the real `install_feedback` refusal. There is no tenant #1 on the stack (no `KB_OPERATOR_EMAIL`), so `tenant_one` and `tracked_path` are not reached here.

**Drive it:** the owner's Org settings and its role note, no Step down on a sole owner's row; project home with the badge only; Project settings reached from the rail, its visibility switch both ways; the delete dialog by keyboard (Enter opens it, focus in the field, a half-typed name no error, a wrong one the signed error with the confirm off, Escape closes it back to the opener), then the right name deletes and lands on `/dashboard` without the project; the install-feedback refusal inside both dialogs, nothing deleted; two orgs named `Personal` read apart in the org menu; the second account steps down on its own row (the test account a co-owner) and sees both pages read only; the test account deletes that org, landing on its own; the second account, left with no org, is in a fresh `Personal`. Every view shot at 1440 and 375, each checked for no sideways overflow.

```bash drive
OTHER="$SESSION-other"
OTHER_EMAIL=other-verify@example.com
js() { playwright-cli -s="${2:-$SESSION}" --raw eval "$1"; }
pw() { playwright-cli -s="${S:-$SESSION}" "$@" >>"$EV/drive.log" 2>&1; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
see() { # session, then texts: wait up to 15 s for the page to show each
  local s=$1 t i; shift
  for t in "$@"; do
    i=0
    until [ "$(js "() => document.body.innerText.includes($(q "$t"))" "$s")" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 15 ] && { echo "not seen in $s: $t (at $(js '() => location.href' "$s"))"; return 1; }; sleep 1
    done
    echo "seen in $s: $t"
  done
}
must() { [ $# -eq 3 ] || { echo "FAIL must takes 3 arguments, got $#"; return 1; }; [ "$2" = "$3" ] && echo "ok   $1" || { echo "FAIL $1: got '$2', want '$3'"; return 1; }; }
shots() { # name: 1440 and 375, each checked for sideways overflow, then back to 1440
  local w
  for w in 1440 375; do
    pw resize "$w" 900
    sleep 1
    must "$1 at $w has no sideways overflow" "$(js '() => document.documentElement.scrollWidth <= document.documentElement.clientWidth' "${S:-$SESSION}")" true
    pw screenshot --filename="$EV/settings-$1-$w.png" --full-page
  done
  pw resize 1440 900
}
body() { sed -n '2,$p'; }
status() { sed -n 's/^status=//p' | head -1; }
me() { # what: email, org, name or orgs from /auth/me's answer on stdin
  python3 -c 'import json,sys; d=json.load(sys.stdin); a=d["active_tenant_id"]; print({"email": d["user"]["email"], "org": a, "name": next(t["name"] for t in d["tenants"] if t["id"] == a), "orgs": len(d["tenants"])}[sys.argv[1]])' "$1"
}
role_of() { js "() => { const r = [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$2"))); return r ? r.querySelectorAll('td')[1].innerText.trim() : 'no row'; }" "$1" | tr -d '"'; }
has() { js "() => !!document.querySelector($(q "$2"))" "$1"; } # session, selector
heads() { js '() => [...document.querySelectorAll("main h2, .column h2")].map(h => h.innerText.trim()).join(",")' "$1" | tr -d '"'; }
path() { js '() => location.pathname' "$1" | tr -d '"'; }
focused() { js '() => { const a = document.activeElement; return a ? (a.getAttribute("aria-label") || a.getAttribute("name") || a.innerText || a.tagName).trim() : ""; }' "${1:-$SESSION}" | tr -d '"'; }
land() { # session, path: wait up to 15 s for the page to reach it
  local i=0; until [ "$(path "$1")" = "$2" ]; do i=$((i + 1)); [ "$i" -gt 15 ] && break; sleep 1; done
}
# Org home's Projects table, as the page shows it. Each `run.sh api` call is a login, and the API allows 20 logins per
# 15 minutes from one address: reads go through the pages, the API only does what the pages cannot.
projects() { # session: org home's project names, sorted
  S="${1:-$SESSION}" pw goto "$WEB/dashboard"
  see "${1:-$SESSION}" "Usage, last 30 days" >/dev/null
  js '() => [...document.querySelectorAll("tbody tr a[href^=\"/projects/\"]")].map(a => a.innerText.trim()).sort().join(",")' "${1:-$SESSION}" | tr -d '"'
}
pid() { # name, session: the project's id from org home's Projects table
  S="${2:-$SESSION}" pw goto "$WEB/dashboard"
  see "${2:-$SESSION}" "$1" >/dev/null
  js "() => { const a = [...document.querySelectorAll('tbody tr a[href^=\"/projects/\"]')].find(a => a.innerText.trim() === $(q "$1")); return a ? a.getAttribute('href').split('/')[2] : ''; }" "${2:-$SESSION}" | tr -d '"'
}
link() { # address: the last invite link the API logged for it
  local code="" _
  for _ in $(seq 1 10); do
    code=$(grep -F "no invite mail to $1. The invite link: " "$EV/api.log" | sed -n 's/.*invite?code=\([^ ]*\).*/\1/p' | tail -1)
    [ -n "$code" ] && break; sleep 1
  done
  [ -n "$code" ] || { echo "FAIL no invite link for $1 in $EV/api.log" >&2; return 1; }
  printf '%s' "$code"
}
DIALOG='dialog[open]'
SUBMIT='dialog[open] button[type="submit"]'
FIELD='dialog[open] input[name="name"]'
err() { js "() => { const e = document.querySelector('$DIALOG [role=alert]'); return e ? e.innerText.trim() : ''; }" "${1:-$SESSION}" | tr -d '"'; }
off() { js "() => document.querySelector($(q "$SUBMIT")).disabled" "${1:-$SESSION}"; }

# 0. Both accounts, each in one org named Personal: a new account's org home is Personal, with no project.
"$RUN" signin
"$RUN" signin other
ME=$("$RUN" api GET /auth/me | body)
OWNER_EMAIL=$(printf '%s' "$ME" | me email)
ORG_ID=$(printf '%s' "$ME" | me org)
must "the test account has one org, Personal (fresh up)" "$(printf '%s' "$ME" | me orgs),$(printf '%s' "$ME" | me name)" "1,Personal"
OTHER_ME=$("$RUN" api other GET /auth/me | body)
OTHER_ORG=$(printf '%s' "$OTHER_ME" | me org)
must "a new account's org is Personal, its only one" "$(printf '%s' "$OTHER_ME" | me orgs),$(printf '%s' "$OTHER_ME" | me name)" "1,Personal"
S="$OTHER" pw goto "$WEB/dashboard"
see "$OTHER" "Personal" "No projects yet"
S="$OTHER" shots new-account-home

# 1. The owner's Org settings from the rail: the panels, the role note, a sole owner's row with no Step down.
pw goto "$WEB/dashboard"
must "the org rail has Settings" "$(has "$SESSION" 'nav.rail a[href="/settings"]')" true
pw click 'nav.rail a[href="/settings"]'
land "$SESSION" /settings
see "$SESSION" "Org settings" "Org name" "Public URL" "Members" "Invites" "Delete org" \
  "Owners manage people, the org's name, URL and keys, project visibility, and deletes." \
  "Members make projects and their keys, and write documents, books, feedback and workspaces."
must "Settings is current on /settings" "$(has "$SESSION" 'nav.rail a[href="/settings"][aria-current="page"]')" true
must "a sole owner's row has no Step down" "$(has "$SESSION" 'button[aria-label^="Step down"]')" false
shots org-owner

# 2. Project home keeps the badge only; the project rail's Settings reaches Project settings.
must "the test account makes a project" "$("$RUN" api POST /app/projects '{"name": "scratch"}' | status)" 201
SCRATCH=$(pid scratch)
FEEDBACK=$(pid sikstack)
pw goto "$WEB/projects/$SCRATCH"
see "$SESSION" "scratch" "New items members only"
must "project home has no visibility switch" "$(js '() => [...document.querySelectorAll("button")].some(b => /^Make (public|private)$/.test(b.innerText.trim()))' | tr -d '"')" false
must "project home has no keys panel" "$(heads "$SESSION" | tr ',' '\n' | grep -ci 'keys' || true)" 0
shots project-home
pw click "nav.rail a[href=\"/projects/$SCRATCH/settings\"]"
land "$SESSION" "/projects/$SCRATCH/settings"
see "$SESSION" "Project settings" "Visibility" "Make public" "Delete project" \
  "scratch and everything in it go for good. There is no trash."
must "the project rail's Settings is current" "$(has "$SESSION" "nav.rail a[href=\"/projects/$SCRATCH/settings\"][aria-current=\"page\"]")" true
shots project-owner

# 3. The visibility switch, both ways: the badge and the toast each time.
pw click 'role=button[name="Make public"]'
see "$SESSION" "Make private" "New items public"
pw screenshot --filename="$EV/settings-visibility-public.png"
pw click 'role=button[name="Make private"]'
see "$SESSION" "Make public"
pw reload
see "$SESSION" "Make public" "New items members only"

# 4. The delete dialog by keyboard: Enter opens it, focus in the field, half a name no error, a wrong name the
#    signed error with the confirm off (Enter sends nothing), Escape closes it with focus back on the opener.
OPEN='button[aria-label="Delete scratch"]'
js "() => document.querySelector($(q "$OPEN")).focus()" >/dev/null
pw press Enter
see "$SESSION" "Delete scratch?" "Its documents, books, design builds, feedback, the linked sikstack workspace and its API keys go with it." "Type scratch to confirm"
must "focus starts in the field" "$(focused)" name
must "the confirm is off while empty" "$(off)" true
pw type "scr"
must "half the name is no error" "$(err)" ""
must "the confirm is off for half the name" "$(off)" true
pw type "x"
see "$SESSION" "Type scratch exactly as shown."
must "the field is marked invalid" "$(js "() => document.querySelector($(q "$FIELD")).getAttribute('aria-invalid')" | tr -d '"')" true
must "the confirm is off for a wrong name" "$(off)" true
shots project-delete-wrong
pw press Enter
sleep 1
must "Enter on a wrong name keeps the dialog open" "$(has "$SESSION" "$DIALOG")" true
pw press Tab
must "Tab goes from the field to Cancel" "$(focused)" Cancel
pw press Escape
sleep 1
must "Escape closes the dialog" "$(has "$SESSION" "$DIALOG")" false
must "focus returns to the opener" "$(focused)" "Delete scratch"
must "Enter on a wrong name deleted nothing" "$(projects)" "scratch,sikstack"
pw goto "$WEB/projects/$SCRATCH/settings"
see "$SESSION" "Delete project"

# 5. The right name: the confirm is ready, Enter deletes, the page lands on /dashboard without it, with the toast.
pw click "$OPEN"
see "$SESSION" "Delete scratch?"
pw fill "$FIELD" "scratch"
must "the confirm is ready for the right name" "$(off)" false
shots project-delete-right
pw press Enter
land "$SESSION" /dashboard
must "a project delete lands on /dashboard" "$(path "$SESSION")" /dashboard
see "$SESSION" "scratch deleted." "sikstack"
pw screenshot --filename="$EV/settings-project-deleted-toast.png"
must "the Projects table no longer has scratch" "$(js '() => [...document.querySelectorAll("tbody tr")].some(r => r.innerText.split(/\s/)[0] === "scratch")' | tr -d '"')" false
must "a reload of org home no longer has scratch" "$(projects)" sikstack

# 6. The install-feedback refusal inside both dialogs, the dialog open, the confirm off, nothing deleted.
pw goto "$WEB/projects/$FEEDBACK/settings"
pw click 'button[aria-label="Delete sikstack"]'
pw fill "$FIELD" "sikstack"
pw click "$SUBMIT"
see "$SESSION" "sikstack receives this server's install feedback. It can't be deleted."
must "the refused project's dialog stays open" "$(has "$SESSION" "$DIALOG")" true
must "the refused project's confirm stays off" "$(off)" true
must "focus is back in the field after the refusal" "$(focused)" name
shots project-refused
pw press Escape
pw goto "$WEB/settings"
pw click 'button[aria-label="Delete Personal"]'
see "$SESSION" "Delete Personal?" "Its 1 project and everything in it go for good, for all 1 member."
pw fill "$FIELD" "Personal"
pw click "$SUBMIT"
see "$SESSION" "Personal receives this server's install feedback. It can't be deleted."
must "the refused org's confirm stays off" "$(off)" true
shots org-refused
pw press Escape
must "nothing was deleted" "$(projects)" sikstack

# 7. Two orgs named Personal read apart: the second account invites the test account into its org and makes it an
#    owner; the org menu names each one's owner.
must "the second account invites the test account" "$("$RUN" api other POST /app/invites "{\"email\": \"$OWNER_EMAIL\"}" | status)" 201
CODE=$(link "$OWNER_EMAIL") || exit 1
must "the test account accepts" "$("$RUN" api POST "/app/invite/$CODE/accept" | status)" 200
S="$OTHER" pw goto "$WEB/settings"
see "$OTHER" "$OWNER_EMAIL"
S="$OTHER" pw click "button[aria-label=\"Make $OWNER_EMAIL an owner\"]"
see "$OTHER" "$OWNER_EMAIL is an owner now."
pw goto "$WEB/dashboard"
pw click 'button[aria-label="Org: Personal. Switch org"]'
see "$SESSION" "Owned by you" "Owned by $OTHER_EMAIL"
must "the menu lists two orgs named Personal" "$(js '() => [...document.querySelectorAll(".menu .menu-name")].filter(n => n.innerText.trim() === "Personal").length' | tr -d '"')" 2
for w in 1440 375; do pw resize "$w" 900; sleep 1; pw screenshot --filename="$EV/settings-org-menu-$w.png"; done
pw resize 1440 900
pw press Escape

# 8. The second account, with the test account a co-owner, steps down on its own row (no confirm): its row reads
#    Member, the toast says so, the page is a member's (name read only, no Invites, no Delete org); a reload agrees.
STEP='button[aria-label="Step down to member of Personal"]'
S="$OTHER" pw goto "$WEB/settings"
see "$OTHER" "$OWNER_EMAIL" "Step down"
must "Step down is on the second account's own row" "$(js "() => [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$OTHER_EMAIL"))).querySelector($(q "$STEP")) !== null" "$OTHER")" true
must "no Step down on the other owner's row" "$(js "() => [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$OWNER_EMAIL")) && t.querySelector('td')).querySelectorAll('button').length" "$OTHER" | tr -d '"')" 0
S="$OTHER" shots two-owners
S="$OTHER" pw click "$STEP"
see "$OTHER" "You are a member of Personal now."
S="$OTHER" pw screenshot --filename="$EV/settings-stepped-down-toast.png"
must "the row reads Member" "$(role_of "$OTHER" "$OTHER_EMAIL")" Member
must "no Step down left" "$(has "$OTHER" "$STEP")" false
S="$OTHER" pw goto "$WEB/settings"
see "$OTHER" "Org settings" "Members"
must "a reload keeps the row Member" "$(role_of "$OTHER" "$OTHER_EMAIL")" Member
must "a member's Org settings: Org name, Members only" "$(heads "$OTHER")" "Org name,Members"
must "a member sees no Change" "$(js '() => [...document.querySelectorAll("button")].some(b => b.innerText.trim() === "Change")' "$OTHER" | tr -d '"')" false
see "$OTHER" "Owners manage people"
S="$OTHER" shots member

# 9. A member's Project settings: the badge and the keys, no switch, no Delete project.
must "a member makes a project" "$("$RUN" api other POST /app/projects '{"name": "notes"}' | status)" 201
NOTES=$(pid notes "$OTHER")
S="$OTHER" pw goto "$WEB/projects/$NOTES/settings"
see "$OTHER" "Project settings" "Visibility" "New items members only"
must "a member has no switch" "$(js '() => [...document.querySelectorAll("button")].some(b => /^Make (public|private)$/.test(b.innerText.trim()))' "$OTHER" | tr -d '"')" false
must "a member has no Delete project" "$(heads "$OTHER" | tr ',' '\n' | grep -c '^Delete project$' || true)" 0
must "a member has the keys" "$(heads "$OTHER" | tr ',' '\n' | grep -ci 'keys')" 1
S="$OTHER" shots project-member

# 10. The test account switches to that org (the org menu's form post) and deletes it: a wrong name first, then the
#     right one; it lands on /dashboard of its own org (the one the API returns), with the toast.
js "async () => { const r = await fetch('/api/auth/org', { method: 'POST', body: new URLSearchParams({ org: $(q "$OTHER_ORG") }) }); return r.ok; }" >/dev/null
pw goto "$WEB/settings"
see "$SESSION" "$OTHER_EMAIL" "Delete org"
pw click 'button[aria-label="Delete Personal"]'
see "$SESSION" "Its 1 project and everything in it go for good, for all 2 members."
pw fill "$FIELD" "personal"
see "$SESSION" "Type Personal exactly as shown."
must "the org's confirm is off for a wrong name" "$(off)" true
shots org-delete-wrong
pw fill "$FIELD" "Personal"
must "the org's confirm is ready" "$(off)" false
pw click "$SUBMIT"
land "$SESSION" /dashboard
must "an org delete lands on /dashboard" "$(path "$SESSION")" /dashboard
see "$SESSION" "Personal deleted." "sikstack"
pw screenshot --filename="$EV/settings-org-deleted-toast.png"
ME=$("$RUN" api GET /auth/me | body)
must "the test account is back to its own org alone" "$(printf '%s' "$ME" | me orgs),$(printf '%s' "$ME" | me org)" "1,$ORG_ID"
pw click 'button[aria-label="Org: Personal. Switch org"]'
must "the org menu lists one org, the active one" "$(js '() => document.querySelectorAll(".menu .menu-name").length + ":" + document.querySelectorAll(".menu [aria-current=true]").length' | tr -d '"')" "1:1"
pw press Escape

# 11. The second account, left with no org, is in a fresh Personal of its own, as Owner, with no project.
OTHER_ME=$("$RUN" api other GET /auth/me | body)
FRESH=$(printf '%s' "$OTHER_ME" | me org)
must "the stranded member has one fresh Personal org" "$(printf '%s' "$OTHER_ME" | me orgs),$(printf '%s' "$OTHER_ME" | me name),$([ "$FRESH" != "$OTHER_ORG" ] && [ "$FRESH" != "$ORG_ID" ] && echo fresh)" "1,Personal,fresh"
S="$OTHER" pw goto "$WEB/dashboard"
see "$OTHER" "Personal" "No projects yet"
S="$OTHER" pw goto "$WEB/settings"
see "$OTHER" "$OTHER_EMAIL" "Delete org"
must "it owns the fresh org" "$(role_of "$OTHER" "$OTHER_EMAIL")" Owner
S="$OTHER" shots stranded-fresh
pw goto "$WEB/settings"
see "$SESSION" "Org settings"
pw screenshot --filename="$EV/settings.png"
```

**Proof:** every `must` prints `ok` and every `see` is seen. `settings-new-account-home-{1440,375}.png`: the second account's sign-up org home, `Personal`, with no project. `settings-org-owner-*`: Org settings as a sole owner, with the role note and no Step down. `settings-project-home-*`: project home with the badge, no switch and no keys. `settings-project-owner-*`: Project settings. `settings-visibility-public.png`: the switch at Public. `settings-project-delete-wrong-*`: the typed-wrong error, the confirm off. `settings-project-delete-right-*`: the confirm ready. `settings-project-deleted-toast.png`: `/dashboard` without `scratch`, with the toast. `settings-project-refused-*` and `settings-org-refused-*`: the install-feedback refusal inside each dialog. `settings-org-menu-{1440,375}.png`: two `Personal` orgs, "Owned by you" and "Owned by other-verify@example.com". `settings-two-owners-*`: Step down on the second account's own row only. `settings-stepped-down-toast.png` and `settings-member-*`: its member's view. `settings-project-member-*`: a member's Project settings. `settings-org-delete-wrong-*` and `settings-org-deleted-toast.png`: the org's typed confirm and the landing. `settings-stranded-fresh-*`: the stranded member in a fresh `Personal`, as Owner.
