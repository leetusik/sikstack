# Connect

**Reach it:** `/connect?code=<code>`, the page `/sikstack:sign-in` opens from Claude Code. A code comes from the API, never the web: register an install (`POST /api/installs`) and start a sign-in for it (`POST /api/installs/sign-in`), both unauthenticated, with curl against the API `run.sh status` prints. `{"release": true}` on a start frees an install another account claimed (`/sikstack:sign-in release`): the claim is cleared, the install's older codes end, the answer carries `released`.

**Drive it:** the test account (`$SESSION`) reads a code (ready: the account once, right under Connect, with "Use another account") and Connects it, which claims the install. The second account (`$SESSION-other`, `run.sh signin other`) reads a new code: `other`, naming `/sikstack:sign-in release`. A `release: true` start answers `released: true`; the older code reads expired; the second account Connects the released code and the install is its. Last, "Use another account" signs the second account out and lands on the same code, signed out. Ready and `other` are shot at 1440 and 390, each checked for no sideways overflow.

```bash drive
OTHER="$SESSION-other"
API=$("$RUN" status | sed -n 's/^api *\(http[^ ]*\).*/\1/p')
[ -n "$API" ] || { echo "no API address in run.sh status"; exit 1; }
js() { playwright-cli -s="${2:-$SESSION}" --raw eval "$1"; }
pw() { playwright-cli -s="${S:-$SESSION}" "$@" >>"$EV/drive.log" 2>&1; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
field() { # key json: the key's value (a boolean as JSON's true/false); a missing key fails
  python3 -c 'import json,sys; d=json.loads(sys.argv[2]); k=sys.argv[1]; k in d or sys.exit(f"no {k} in {sys.argv[2]}"); v=d[k]; print(json.dumps(v) if isinstance(v,bool) else v)' "$1" "$2"
}
keys() { python3 -c 'import json,sys; print(",".join(sorted(json.loads(sys.argv[1]))))' "$1"; }
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
shots() { # name: 1440 and 390, each checked for sideways overflow, then back to 1440
  local w
  for w in 1440 390; do
    pw resize "$w" 900
    sleep 1
    must "$1 at $w has no sideways overflow" "$(js '() => document.documentElement.scrollWidth <= document.documentElement.clientWidth' "${S:-$SESSION}")" true
    pw screenshot --filename="$EV/connect-$1-$w.png" --full-page
  done
  pw resize 1440 900
}
post() { curl -sS -X POST "$API$1" -H 'Content-Type: application/json' -d "$2"; } # path body
start() { # [release]: a new code for the install; prints the API's answer
  local extra=""
  [ "${1:-}" = release ] && extra=', "release": true'
  post /api/installs/sign-in "$(printf '{"install_id": "%s", "repo": "verify-repo", "plugin_version": "0.5.1"%s}' "$INSTALL" "$extra")"
}
poll() { post /api/installs/sign-in/poll "$(printf '{"poll_token": "%s"}' "$1")"; }

# 0. Both accounts, and an install registered through the API.
"$RUN" signin
"$RUN" signin other
INSTALL="verify-$(date +%s)-$RANDOM"
REGISTERED=$(post /api/installs "$(printf '{"install_id": "%s", "email": "setup-verify@example.com", "plugin_version": "0.5.1"}' "$INSTALL")")
must "registered" "$REGISTERED" '{"status":"registered"}'

# 1. Ready: the account shows once, right under Connect, with Use another account. Connect claims the install.
FIRST=$(start); CODE1=$(field code "$FIRST")
must "a plain start answers today's five keys" "$(keys "$FIRST")" "code,expires_in,interval,poll_token,url"
pw goto "$WEB/connect?code=$CODE1"
see "$SESSION" "Connect this install?" "Signed in as" "Use another account"
must "the account shows once" "$(js '() => document.body.innerText.split("Signed in as").length - 1')" 1
must "the account line sits under the action pair" \
  "$(js '() => { const a = document.querySelector(".sk-actions"); const l = [...document.querySelectorAll("p")].find(p => p.innerText.startsWith("Signed in as")); return !!(a && l && a.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && !document.querySelector(".sk-facts").innerText.includes("Signed in as"); }')" true
must "Use another account is a link-styled button" "$(js '() => !!document.querySelector("button.link.link-row") && document.querySelector("button.link.link-row").innerText === "Use another account"')" true
shots ready
pw click 'button.btn-primary'
see "$SESSION" "Connected"
must "the first code is approved" "$(field status "$(poll "$(field poll_token "$FIRST")")")" approved

# 2. Another account: the other outcome names the release command.
SECOND=$(start); CODE2=$(field code "$SECOND")
S="$OTHER" pw goto "$WEB/connect?code=$CODE2"
see "$OTHER" "Connected to another account" "/sikstack:sign-in release" "on the install’s machine, then Connect the new code."
must "the command is in .cmd-inline" "$(js '() => [...document.querySelectorAll(".cmd-inline")].some(e => e.innerText === "/sikstack:sign-in release")' "$OTHER")" true
S="$OTHER" shots other

# 3. Release: the claim is cleared, the older code ends, the second account's Connect claims the install.
THIRD=$(start release); CODE3=$(field code "$THIRD")
must "a release start answers released: true" "$(field released "$THIRD")" true
must "the older code polls expired" "$(field status "$(poll "$(field poll_token "$SECOND")")")" expired
S="$OTHER" pw goto "$WEB/connect?code=$CODE2"
see "$OTHER" "This code no longer works"
S="$OTHER" pw goto "$WEB/connect?code=$CODE3"
see "$OTHER" "Connect this install?" "Signed in as other-verify@example.com"
S="$OTHER" pw click 'button.btn-primary'
see "$OTHER" "Connected"
must "the released code is approved" "$(field status "$(poll "$(field poll_token "$THIRD")")")" approved
S="$OTHER" pw screenshot --filename="$EV/connect-released-connected.png"
# The install is the second account's now: the test account reads a new code as other.
FOURTH=$(start); CODE4=$(field code "$FOURTH")
pw goto "$WEB/connect?code=$CODE4"
see "$SESSION" "Connected to another account"

# 4. Use another account: signs out and lands on the same code, signed out.
FIFTH=$(start); CODE5=$(field code "$FIFTH")
S="$OTHER" pw goto "$WEB/connect?code=$CODE5"
see "$OTHER" "Signed in as other-verify@example.com" "Use another account"
S="$OTHER" pw click 'button.link.link-row'
see "$OTHER" "Sign in to connect this install and see its work on the web." "Create account"
must "still the same code" "$(js '() => new URLSearchParams(location.search).get("code")' "$OTHER" | tr -d '"')" "$CODE5"
must "signed out: no account line" "$(js '() => document.body.innerText.includes("Signed in as")' "$OTHER")" false
S="$OTHER" pw screenshot --filename="$EV/connect-after-use-another.png"
S="$OTHER" pw resize 390 900
S="$OTHER" pw screenshot --filename="$EV/connect-after-use-another-390.png" --full-page
pw screenshot --filename="$EV/connect.png"
```

**Proof:** every `must` prints `ok` and every `see` is seen; `connect-ready-{1440,390}.png` show the account under Don't connect / Connect with "Use another account" and the facts panel without it; `connect-other-{1440,390}.png` show the sentence with `/sikstack:sign-in release` in the mono face; `connect-released-connected.png` the second account's Connect after the release; `connect-after-use-another{,-390}.png` the same code signed out. The second account's saved sign-in ends signed out (the next `signin other` logs in again).
