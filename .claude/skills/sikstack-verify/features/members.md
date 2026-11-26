# Members

**Reach it:** `/members`, the org rail's section after Feedback, in the active org. Two accounts: the test account (`$SESSION`), the owner of its first org, and the second account (`$SESSION-other`, `run.sh signin other`), which owns only its own sign-up org. The second account joins the test account's org through the API: the owner's invite (`run.sh api POST /app/invites`), whose link the API logs to `$EV/api.log` (no SMTP on the stack), and the second account's accept (`run.sh api other POST /app/invite/<code>/accept`).

**Drive it:** the owner's view before the promotion: Make owner and Remove on the member's row, nothing on the owner's own (a sole owner has no Leave). Make owner turns the row to Owner with a toast, no confirm, and Leave appears on the owner's own row; a reload and the API agree. The second account's view of its own org is a sole owner's: no controls at all. Then, through the API, it hands its own org to the test account (an invite, the accept, Make owner) and leaves it, so the shared org is its only one. It switches to the shared org (the org menu's form post, `/api/auth/org`), sees Leave on its own row as a co-owner, leaves, and lands on the home of a fresh `default` org of its own, as at sign-up: its Members lists it alone, as Owner. The owner's list no longer holds it. Every view is shot at 1440 and 375, each checked for no sideways overflow. (A refused Leave's toast is not driven: the page shows Leave only where the API allows it. `web/tests/org-membership.test.ts` holds each toast's wording.)

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
    pw screenshot --filename="$EV/members-$1-$w.png" --full-page
  done
  pw resize 1440 900
}
body() { sed -n '2,$p'; } # run.sh api's answer without its status line
status() { sed -n 's/^status=//p' | head -1; }
me() { # what: email, org (the active org's id), name (its name) or orgs (how many) from /auth/me's answer on stdin
  python3 -c 'import json,sys; d=json.load(sys.stdin); a=d["active_tenant_id"]; print({"email": d["user"]["email"], "org": a, "name": next(t["name"] for t in d["tenants"] if t["id"] == a), "orgs": len(d["tenants"])}[sys.argv[1]])' "$1"
}
role_of() { # session, email: the Role cell of that address's row, as the page shows it
  js "() => { const r = [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$2"))); return r ? r.querySelectorAll('td')[1].innerText.trim() : 'no row'; }" "$1" | tr -d '"'
}
has() { js "() => !!document.querySelector($(q "$2"))" "$1"; } # session, selector
roles() { "$RUN" api ${1:+$1} GET /app/members | body | python3 -c 'import json,sys; print(",".join(m["email"] + "=" + m["role"] for m in json.load(sys.stdin)["members"]))'; }

# 0. Both accounts; the second joins the test account's first org through the API.
"$RUN" signin
"$RUN" signin other
ME=$("$RUN" api GET /auth/me | body)
OWNER_EMAIL=$(printf '%s' "$ME" | me email)
ORG_ID=$(printf '%s' "$ME" | me org)
ORG_NAME=$(printf '%s' "$ME" | me name)
must "the test account has one org" "$(printf '%s' "$ME" | me orgs)" 1
INVITED=$("$RUN" api POST /app/invites "{\"email\": \"$OTHER_EMAIL\"}")
must "the invite is made" "$(printf '%s\n' "$INVITED" | status)" 201
link() { # address: the last invite link the API logged for it
  local code="" _
  for _ in $(seq 1 10); do
    code=$(grep -F "no invite mail to $1. The invite link: " "$EV/api.log" | sed -n 's/.*invite?code=\([^ ]*\).*/\1/p' | tail -1)
    [ -n "$code" ] && break; sleep 1
  done
  [ -n "$code" ] || { echo "FAIL no invite link for $1 in $EV/api.log" >&2; return 1; }
  printf '%s' "$code"
}
CODE=$(link "$OTHER_EMAIL") || exit 1
must "the second account accepts" "$("$RUN" api other POST "/app/invite/$CODE/accept" | status)" 200
must "the API lists a member" "$(roles)" "$OWNER_EMAIL=owner,$OTHER_EMAIL=member"

# 1. The owner's view before the promotion: Make owner and Remove on the member's row; a sole owner has no Leave.
MAKE="button[aria-label=\"Make $OTHER_EMAIL an owner\"]"
LEAVE="button[aria-label=\"Leave $ORG_NAME\"]"
pw goto "$WEB/members"
see "$SESSION" "$OTHER_EMAIL" "Make owner" "Remove"
must "the member's row reads Member" "$(role_of "$SESSION" "$OTHER_EMAIL")" Member
must "Make owner on the member's row" "$(has "$SESSION" "$MAKE")" true
must "Remove on the member's row" "$(has "$SESSION" "button[aria-label=\"Remove $OTHER_EMAIL from the org\"]")" true
must "a sole owner's row has no Leave" "$(has "$SESSION" "$LEAVE")" false
must "nothing on the owner's own row" "$(js "() => [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$OWNER_EMAIL")) && t.querySelector('td')).querySelectorAll('button').length" | tr -d '"')" 0
shots owner-before

# 2. Make owner: no confirm, the row reads Owner, the toast says so, and Leave appears on the owner's own row.
pw click "$MAKE"
see "$SESSION" "$OTHER_EMAIL is an owner now."
pw screenshot --filename="$EV/members-made-owner-toast.png"
must "the row reads Owner" "$(role_of "$SESSION" "$OTHER_EMAIL")" Owner
must "no Make owner left" "$(has "$SESSION" "$MAKE")" false
must "Leave on the owner's own row" "$(has "$SESSION" "$LEAVE")" true
shots owner-after
must "the API lists two owners" "$(roles)" "$OWNER_EMAIL=owner,$OTHER_EMAIL=owner"
pw goto "$WEB/members"
see "$SESSION" "$OTHER_EMAIL"
must "a reload keeps the row Owner" "$(role_of "$SESSION" "$OTHER_EMAIL")" Owner

# 3. The second account in its own org: a sole owner's view, no controls at all.
S="$OTHER" pw goto "$WEB/members"
see "$OTHER" "$OTHER_EMAIL"
must "the second account's own org is one row" "$(js '() => document.querySelectorAll("tbody tr").length' "$OTHER" | tr -d '"')" 1
must "a sole owner's view has no Leave" "$(js '() => !!document.querySelector("button[aria-label^=\"Leave \"]")' "$OTHER")" false
S="$OTHER" shots sole-owner

# 4. Through the API, the second account hands its own org to the test account and leaves it: the shared org is
#    then its only org. (Its header-less org is its own until it leaves; the test account's stays the shared one.)
OTHER_ME=$("$RUN" api other GET /auth/me | body)
OTHER_ORG=$(printf '%s' "$OTHER_ME" | me org)
must "the second account's header-less org is its own" "$([ "$OTHER_ORG" != "$ORG_ID" ] && echo own)" own
must "the second account invites the test account" "$("$RUN" api other POST /app/invites "{\"email\": \"$OWNER_EMAIL\"}" | status)" 201
CODE=$(link "$OWNER_EMAIL") || exit 1
must "the test account accepts" "$("$RUN" api POST "/app/invite/$CODE/accept" | status)" 200
OWNER_ROW=$("$RUN" api other GET /app/members | body | python3 -c 'import json,sys; print(next(m["id"] for m in json.load(sys.stdin)["members"] if m["email"] == sys.argv[1]))' "$OWNER_EMAIL")
must "the second account makes the test account an owner of its org" "$("$RUN" api other POST "/app/members/$OWNER_ROW/owner" | status)" 204
must "the second account leaves its own org" "$("$RUN" api other POST /app/tenant/leave | status)" 204
OTHER_ME=$("$RUN" api other GET /auth/me | body)
must "the shared org is the second account's only org" "$(printf '%s' "$OTHER_ME" | me orgs),$(printf '%s' "$OTHER_ME" | me org)" "1,$ORG_ID"

# 5. The second account switches to the shared org (the org menu's form post), sees Leave as a co-owner, and leaves
#    its only org: it lands on the home of a fresh `default` org of its own, the only row on its Members, as Owner.
js "async () => { const r = await fetch('/api/auth/org', { method: 'POST', body: new URLSearchParams({ org: $(q "$ORG_ID") }) }); return r.ok; }" "$OTHER" >/dev/null
S="$OTHER" pw goto "$WEB/members"
see "$OTHER" "$OWNER_EMAIL" "Leave"
must "the co-owner's view: Leave on its own row" "$(has "$OTHER" "$LEAVE")" true
must "the co-owner's view: nothing on the other owner's row" "$(js "() => [...document.querySelectorAll('tr')].find(t => t.innerText.includes($(q "$OWNER_EMAIL")) && t.querySelector('td')).querySelectorAll('button').length" "$OTHER" | tr -d '"')" 0
S="$OTHER" shots co-owner
S="$OTHER" pw click "$LEAVE"
i=0; until [ "$(js '() => location.pathname' "$OTHER" | tr -d '"')" = /dashboard ]; do i=$((i + 1)); [ "$i" -gt 15 ] && break; sleep 1; done
must "the co-owner left its only org and landed on a home" "$(js '() => location.pathname' "$OTHER" | tr -d '"')" /dashboard
OTHER_ME=$("$RUN" api other GET /auth/me | body)
FRESH=$(printf '%s' "$OTHER_ME" | me org)
must "the second account has one org, a fresh default" "$(printf '%s' "$OTHER_ME" | me orgs),$(printf '%s' "$OTHER_ME" | me name),$([ "$FRESH" != "$ORG_ID" ] && [ "$FRESH" != "$OTHER_ORG" ] && echo fresh)" "1,default,fresh"
must "the API lists it alone in its fresh org, as owner" "$(roles other)" "$OTHER_EMAIL=owner"
S="$OTHER" pw goto "$WEB/members"
see "$OTHER" "$OTHER_EMAIL"
must "its Members is one row" "$(js '() => document.querySelectorAll("tbody tr").length' "$OTHER" | tr -d '"')" 1
must "its row reads Owner" "$(role_of "$OTHER" "$OTHER_EMAIL")" Owner
S="$OTHER" shots fresh-org
must "the owner's list no longer holds it" "$(roles)" "$OWNER_EMAIL=owner"
pw goto "$WEB/members"
see "$SESSION" "$OWNER_EMAIL"
must "the owner is the sole owner again: no Leave" "$(has "$SESSION" "$LEAVE")" false
pw screenshot --filename="$EV/members.png"
```

**Proof:** every `must` prints `ok` and every `see` is seen; `members-owner-before-{1440,375}.png` show Make owner beside Remove on the member's row and nothing on the owner's (a sole owner); `members-made-owner-toast.png` the row as Owner with the toast; `members-owner-after-{1440,375}.png` the row as Owner and Leave on the owner's own row; `members-sole-owner-{1440,375}.png` the second account alone in its org, no controls; `members-co-owner-{1440,375}.png` the second account's Leave as a co-owner; `members-fresh-org-{1440,375}.png` the second account alone, as Owner, in the fresh org its last Leave gave it. The stack ends with the second account out of the test account's org, in a fresh `default` org of its own, and the test account owning the second account's sign-up org as well (its own first org stays its header-less one).
