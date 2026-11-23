# Design service

**Reach it:** the project rail's "Design" entry: the list at `/projects/<id>/design`, a build's viewer at `/projects/<id>/design/<build>` (entered by a full page load, never a client navigation: the viewer's CSP frames the build's origin). Builds come from the sikstack plugin's `design-publish`, run from a checkout linked to the project. Each build is served at the root of its own host, `<build>.design.sikstack.localhost:<design port>`, by the design origin `up` starts; a member gets in through the app's `/api/design/open` (a one-use ticket), a signed-out browser only through the build's share link while it is on.

`run.sh workspace <dir>` makes that checkout: a scratch repo with a `sikstack init` workspace (the branch's engine), linked to the test account's project `sikstack` by a workspace key it mints through the API and hands to `link` on stdin. The key stays in the home's XDG folder (0700, its file 0600), which `down` removes. `run.sh signin other` signs a second account (its own org, a member of nothing here) into `$SESSION-other`; `run.sh api <method> <path> [json]` calls the API as the test account. Every build is made in a scratch copy of `web/` (deleted when the block ends), never in the design folder itself.

**Drive it:** publish four builds (one with the plugin's options page, one from a `design/data/local/` recording, one carrying a test script, one to delete) and an oversized folder; then the viewer's pages, states and options; a non-member, a share link on and off; the private build; the test script against the member's session; the size cap and `design-delete`; the list and the viewer at 1440 and 390.

```bash drive
OTHER="$SESSION-other"; GUEST="$SESSION-guest"
REPO=$(cd "$(dirname "$RUN")/../../.." && pwd)
pw() { playwright-cli -s="$SESSION" "$@" >>"$EV/drive.log" 2>&1; }
js() { playwright-cli -s="${2:-$SESSION}" --raw eval "$1"; }
q() { printf '%s' "$1" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'; }
see() { # JS expressions: wait up to 10 s for each to be true in $SESSION (or $IN)
  local e i
  for e in "$@"; do
    i=0
    until [ "$(js "() => ($e)" "${IN:-$SESSION}")" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 10 ] && { echo "not seen: $e (at $(js '() => location.href' "${IN:-$SESSION}"))"; return 1; }; sleep 1
    done
    echo "seen: $e"
  done
}
shows() { printf 'document.body.innerText.includes(%s)' "$(q "$1")"; }
visit() { # session url: one full load; prints {status, url, text} as JSON
  playwright-cli -s="$1" --raw run-code "async page => { const r = await page.goto($(q "$2")); return JSON.stringify({ status: r ? r.status() : 0, url: page.url(), text: (await page.innerText('body')).slice(0, 400) }); }" \
    | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))'
}
field() { python3 -c 'import json,sys; print(json.loads(sys.argv[2])[sys.argv[1]])' "$1" "$2"; }
must() { # what, then a python expression over d (the JSON in $2)
  python3 -c 'import json,sys; d=json.loads(sys.argv[2]); ok=eval(sys.argv[3]); print(("ok   " if ok else "FAIL ")+sys.argv[1]+("" if ok else "\n     got: "+sys.argv[2][:600])); sys.exit(0 if ok else 1)' "$1" "$2" "$3"
}
noerrors() { # session: the page now loaded logged no console error
  local out; out=$(playwright-cli -s="${1:-$SESSION}" console 2>&1); printf '%s\n' "$out" >>"$EV/console.log"
  printf '%s\n' "$out" | grep -q 'Errors: 0' || { echo "console errors on $(js '() => location.href' "${1:-$SESSION}"):"; printf '%s\n' "$out"; return 1; }
}
allframes() { # the frames load lazily: bring each into view (it loads and posts its height), so a full-page shot holds all three
  local i
  for i in 0 1 2; do
    js "() => { document.querySelectorAll('iframe')[$i].scrollIntoView(); return true; }" >/dev/null
    see "document.querySelectorAll('iframe')[$i].style.height !== ''"
  done
  js '() => { window.scrollTo(0, 0); return true; }' >/dev/null
}
shot() { pw screenshot --filename="$EV/design-service-$1.png" "${@:2}"; }
: >"$EV/console.log"

# 0. Two accounts, the linked checkout, four builds in a scratch copy of web/.
"$RUN" signin
"$RUN" signin other
eval "$("$RUN" workspace "$EV/design-ws-$(date +%H%M%S)")"
sk() { (cd "$WS" && env -u SIKSTACK_ROOT XDG_CONFIG_HOME="$XDG" SIKSTACK_NO_OFFER=1 "$SK" "$@"); }
SCR=$(mktemp -d "${TMPDIR:-/tmp}/sikstack-verify-design.XXXXXX")
trap 'rm -rf "$SCR"' EXIT
mkdir -p "$SCR/web"
rsync -a --exclude node_modules --exclude .next --exclude design/out --exclude design/data/local "$REPO/web/" "$SCR/web/"
cp -cR "$REPO/web/node_modules" "$SCR/web/node_modules" 2>/dev/null || cp -R "$REPO/web/node_modules" "$SCR/web/node_modules"
source_of() { # folder: the scratch copy is no git checkout, so its manifest takes the checkout's commit, branch and tree
  python3 - "$1/out/manifest.json" "$(git -C "$REPO" rev-parse HEAD)" "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" \
    "$([ -n "$(git -C "$REPO" status --porcelain -- web)" ] && echo 1)" <<'PY'
import json, sys
path, commit, branch, dirty = sys.argv[1:]
m = json.load(open(path)); m["source"] = {"repo": "platform", "commit": commit, "branch": branch, "dirty": bool(dirty)}
open(path, "w").write(json.dumps(m, indent=2) + "\n")
PY
}
publish() { # folder: design-publish it; prints the build id
  local out; out=$(sk design-publish --folder "$1"); printf '%s\n' "$out" >>"$EV/publish.log"
  printf '%s\n' "$out" | sed -n 's/^published=\([a-z0-9]*\) .*/\1/p'
}
# (a) the plugin's options page in the design folder's public/, so design:build writes manifest.options
mkdir -p "$SCR/web/design/public/options"
cp "$REPO/plugins/sikstack/templates/design/options.html" "$SCR/web/design/public/options/index.html"
(cd "$SCR/web" && node design/scripts/build.mjs) >>"$EV/design-build.log" 2>&1
mkdir -p "$SCR/options" && mv "$SCR/web/design/out" "$SCR/options/out" && source_of "$SCR/options"
# (b) a real project's recording: design/data/local/, so the build is private
mkdir -p "$SCR/web/design/data/local" && cp "$SCR/web/design/data/sample/recording.json" "$SCR/web/design/data/local/acme.json"
(cd "$SCR/web" && node design/scripts/build.mjs --data local/acme) >>"$EV/design-build.log" 2>&1
mkdir -p "$SCR/private" && mv "$SCR/web/design/out" "$SCR/private/out" && source_of "$SCR/private"
# (c) the test script: posts, a form post, reads and document.cookie against the app, from the build's own host
mkdir -p "$SCR/attack/out"
printf '{"$design": "sikstack-design-build", "recording": {"file": "design/data/sample/recording.json"}, "pages": [{"name": "Attack", "route": "/", "entry": "/"}]}\n' >"$SCR/attack/out/manifest.json"
cat >"$SCR/attack/out/index.html" <<'HTML'
<!doctype html>
<html><head><meta charset="utf-8"><title>Attack build</title></head>
<body>
<h1>Attack build</h1>
<pre id="out">running</pre>
<form id="f" method="POST" action="__WEB__/api/auth/logout"><input type="hidden" name="x" value="1"></form>
<script>
const WEB = "__WEB__";
const PROJECT = "__PROJECT__";
const results = { posts: [], reads: [], cookie: null };
async function post([path, headers]) {
  try {
    const r = await fetch(WEB + path, { method: "POST", credentials: "include", headers, body: "{}" });
    return { path, read: true, status: r.status };
  } catch (e) { return { path, read: false, error: e.name }; }
}
async function read(path) {
  try {
    const r = await fetch(WEB + path, { credentials: "include" });
    const text = await r.text();
    return { path, read: true, status: r.status, length: text.length };
  } catch (e) { return { path, read: false, error: e.name }; }
}
if (new URLSearchParams(location.search).has("form")) { document.title = "Attack build: form"; document.getElementById("f").submit(); }
else (async () => {
  const plain = { "Content-Type": "text/plain" };
  const posts = [["/api/auth/logout", plain], ["/api/auth/org", plain], ["/api/auth/connect", plain], ["/api/reader/position", plain],
    ["/api/listen/position", plain], ["/api/auth/connect", { "Content-Type": "application/json" }],
    ["/projects/" + PROJECT + "/design", { "Next-Action": "0".repeat(42) }]];
  for (const p of posts) results.posts.push(await post(p));
  for (const p of ["/dashboard", "/projects/" + PROJECT + "/design", "/api/design/open?project=" + PROJECT + "&build=x&path=%2F"]) {
    results.reads.push(await read(p));
  }
  results.cookie = document.cookie;
  window.__attack = results;
  document.getElementById("out").textContent = JSON.stringify(results);
  document.title = "Attack build: done";
})();
</script>
</body></html>
HTML
sed -i '' -e "s#__WEB__#$WEB#g" -e "s#__PROJECT__#$PROJECT#g" "$SCR/attack/out/index.html" 2>/dev/null \
  || sed -i -e "s#__WEB__#$WEB#g" -e "s#__PROJECT__#$PROJECT#g" "$SCR/attack/out/index.html"
# (d) over the cap: 51 MiB unpacked (it compresses to almost nothing, so only the unpacked cap refuses it)
mkdir -p "$SCR/big/out" && cp "$SCR/attack/out/manifest.json" "$SCR/big/out/manifest.json"
python3 -c 'import sys; open(sys.argv[1], "wb").truncate(51 * 1024 * 1024)' "$SCR/big/out/big.bin"
OPT=$(publish "$SCR/options"); PRIV=$(publish "$SCR/private"); ATK=$(publish "$SCR/attack"); DEL=$(publish "$SCR/options")
[ -n "$OPT" ] && [ -n "$PRIV" ] && [ -n "$ATK" ] && [ -n "$DEL" ] || { echo "a publish failed: see $EV/publish.log"; exit 1; }
grep -q "^published=$PRIV .* private=yes" "$EV/publish.log" && grep -q "^published=$OPT .* private=no" "$EV/publish.log"
host() { printf '%s' "${DESIGN/\{build\}/$1}"; }
VIEW="$WEB/projects/$PROJECT/design"
echo "builds: options $OPT, private $PRIV, attack $ATK, to delete $DEL"

# 2. The viewer: the options directions side by side, bar hidden, each frame at its page's full height, in one
#    screenshot; every manifest page opened from the viewer's link and a state clicked; no console error.
pw resize 1440 900
pw goto "$VIEW/$OPT"
see "$(shows "3 directions")" 'document.querySelectorAll("iframe").length === 3' \
  '[...document.querySelectorAll("iframe")].every(f => parseInt(f.style.height) > 900)'
frames=$(playwright-cli -s="$SESSION" --raw run-code 'async page => { const out = []; for (const el of await page.$$("iframe")) { const box = await el.boundingBox(); const f = await el.contentFrame(); out.push({ box, ...(await f.evaluate(() => ({ url: location.href, bar: getComputedStyle(document.querySelector(".bar")).display, framed: document.documentElement.classList.contains("framed"), height: document.documentElement.scrollHeight }))) }); } return JSON.stringify(out); }' \
  | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))')
echo "frames: $frames"
must "three directions, one top edge, left to right, none overlapping" "$frames" \
  'len(d) == 3 and len({round(f["box"]["y"]) for f in d}) == 1 and all(d[i]["box"]["x"] + d[i]["box"]["width"] <= d[i+1]["box"]["x"] for i in range(2))'
must "each frame is the build's options page for its direction, framed, its bar hidden" "$frames" \
  'all(f["url"].startswith("'"$(host "$OPT")"'/options/?direction=") and f["framed"] and f["bar"] == "none" for f in d)'
must "each frame is as tall as its page (no scroll inside)" "$frames" 'all(abs(f["box"]["height"] - f["height"]) <= 1 for f in d)'
js '() => { window.scrollTo(0, 0); return true; }' >/dev/null
shot 02-options --full-page
noerrors
links=$(js '() => JSON.stringify([...document.querySelectorAll(".design-pages a")].map(a => [a.textContent, a.getAttribute("href")]))' \
  | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))')
manifest=$("$RUN" api GET "/app/projects/$PROJECT/design/builds/$OPT" | sed 1d)
python3 - "$manifest" "$links" <<'PY' >"$EV/pages.tsv"
import json, sys
m, links = json.loads(sys.argv[1])["manifest"], dict(json.loads(sys.argv[2]))
assert [p["name"] for p in m["pages"]] == list(links), (list(links), [p["name"] for p in m["pages"]])
for p in m["pages"]:
    states = [s["key"] for s in p.get("states") or []]
    print("\t".join([p["name"], p["entry"], links[p["name"]], states[1] if len(states) > 1 else ""]))
PY
n=0
while IFS=$'\t' read -r name entry href state; do
  n=$((n + 1))
  page=$(visit "$SESSION" "$WEB$href")
  must "$name opens on the build's host at $entry" "$page" 'd["status"] == 200 and d["url"] == "'"$(host "$OPT")$entry"'"'
  pw localstorage-clear # a state another page picked lives in the build's storage (an Agenda state swaps its items)
  pw reload
  if [ -n "$state" ]; then
    pw click 'role=button[name^="Design states: "]'
    pw click "[data-design-state=$state]"
    see "location.search.includes('state=$state')"
    [ "$(js "() => document.querySelector('[data-design-state=$state]') !== null")" = true ] || pw click 'role=button[name^="Design states: "]'
    see "document.querySelector('[data-design-state=$state]')?.getAttribute('aria-pressed') === 'true'"
  else
    first=$(js '() => document.querySelector("main a[href*=\"state=\"]")?.getAttribute("href") ?? ""' | tr -d '"')
    if [ -n "$first" ]; then # the front page lists every page's states as links: one is followed
      pw click "main a[href=\"$first\"]"
      see "location.search.includes('state=')"
    fi
  fi
  shot "02-page-$n"
  noerrors
done <"$EV/pages.tsv"
[ "$n" -ge 6 ] || { echo "only $n pages in the manifest"; exit 1; }
echo "pages: $n opened, a state clicked on each that has one"

# 3. A non-member gets no list, viewer or build host. With sharing on, a signed-out browser opens that build and no
#    other, and a page's copy link lands on that page; once off, the same link and the open tab get nothing more.
for url in "$VIEW" "$VIEW/$OPT"; do
  playwright-cli -s="$OTHER" goto "$url" >>"$EV/drive.log" 2>&1
  IN="$OTHER" see "$(shows "Project not found")" "!document.body.innerText.includes('$OPT') && !document.querySelector('iframe')"
  echo "ok   the second account gets no Design page at $url"
done
page=$(visit "$OTHER" "$WEB/api/design/open?project=$PROJECT&build=$OPT&path=%2F")
must "the second account gets no ticket to the build" "$page" 'd["status"] == 404 and d["url"].startswith("'"$WEB"'")'
page=$(visit "$OTHER" "$(host "$OPT")/")
must "the second account is refused at the build's own host" "$page" 'd["status"] == 403 and "opens from sikstack" in d["text"]'
pw goto "$VIEW/$OPT"
playwright-cli -s="$SESSION" --raw run-code "async page => { await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: $(q "$WEB") }); return 'ok'; }" >/dev/null
pw click 'role=button[name="Turn on"]'
see 'document.querySelector(".design-share-on") !== null' "$(shows "Turn off")"
pw click 'role=button[name="Copy share link"]'
LINK=$(js '() => navigator.clipboard.readText()' | tr -d '"')
pw click 'role=button[name="Copy share link to System"]'
PAGE_LINK=$(js '() => navigator.clipboard.readText()' | tr -d '"')
case "$LINK" in "$(host "$OPT")/_share/"*) ;; *) echo "share link not on the build's host"; exit 1 ;; esac
[ "$PAGE_LINK" = "$LINK?next=%2Fsystem%2F" ] || { echo "the System copy link is not the share link to /system/"; exit 1; }
pw resize 390 844
allframes
shot 08-viewer-shared-390 --full-page
pw resize 1440 900
playwright-cli -s="$GUEST" close >/dev/null 2>&1 || true
playwright-cli -s="$GUEST" open --config="$EV/cli.config.json" >>"$EV/drive.log" 2>&1
page=$(visit "$GUEST" "$PAGE_LINK")
must "a signed-out browser lands on System by its copy link" "$page" 'd["status"] == 200 and d["url"] == "'"$(host "$OPT")"'/system/" and "sikstack system" in d["text"]'
playwright-cli -s="$GUEST" screenshot --filename="$EV/design-service-03-guest-system.png" >>"$EV/drive.log" 2>&1
page=$(visit "$GUEST" "$(host "$ATK")/")
must "the share link opens no other build" "$page" 'd["status"] == 403 and "opens from sikstack" in d["text"]'
page=$(visit "$GUEST" "$VIEW/$OPT")
must "nor the app's viewer" "$page" '"/login" in d["url"]'
page=$(visit "$GUEST" "$LINK")
must "the share link itself lands on the build's front page" "$page" 'd["status"] == 200 and d["url"] == "'"$(host "$OPT")"'/"'
page=$(visit "$GUEST" "$(host "$OPT")/system/")
must "the guest's tab is open on the build" "$page" 'd["status"] == 200'
pw click 'role=button[name="Turn off"]'
see "$(shows "Turn on")" 'document.querySelector(".design-share-on") === null' '!document.querySelector("[aria-label^=\"Copy share link to \"]")'
tab=$(js '() => fetch("/", { cache: "no-store" }).then(r => r.status + " " + location.pathname)' "$GUEST" | tr -d '"')
[ "$tab" = "403 /system/" ] || { echo "the open tab still gets pages after sharing is off: $tab"; exit 1; }
page=$(visit "$GUEST" "$(host "$OPT")/system/")
must "the open tab's next page is refused" "$page" 'd["status"] == 403 and "opens from sikstack" in d["text"]'
page=$(visit "$GUEST" "$PAGE_LINK")
must "the same copy link is off" "$page" 'd["status"] == 403 and "This share link is off." in d["text"]'
playwright-cli -s="$GUEST" close >>"$EV/drive.log" 2>&1
echo "sharing: a non-member refused three ways; a signed-out browser in by the link and out after it was turned off"

# 4. The private build: marked private in the list, the one line on the viewer, and its share refused in one line.
pw goto "$VIEW"
see "[...document.querySelectorAll('tr')].some(tr => tr.querySelector('a[href\$=\"/$PRIV\"]') && tr.innerText.includes('Private'))"
pw goto "$VIEW/$PRIV"
see "$(shows "Made from a private recording (design/data/local/acme.json), so it cannot be shared.")" \
  '![...document.querySelectorAll("button")].some(b => b.textContent.includes("Turn on"))'
shot 04-private
refused=$("$RUN" api POST "/app/projects/$PROJECT/design/builds/$PRIV/share" '{"on": true}')
printf '%s\n' "$refused"
[ "$(printf '%s\n' "$refused" | sed -n 1p)" = "status=409" ] || { echo "the private build's share was not refused with 409"; exit 1; }
detail=$(printf '%s\n' "$refused" | sed 1d | python3 -c 'import json,sys; print(json.load(sys.stdin)["detail"])')
[ "$(printf '%s\n' "$detail" | wc -l | tr -d ' ')" = 1 ] && case "$detail" in *private*) ;; *) false ;; esac \
  || { echo "the refusal is not one line naming the private recording: $detail"; exit 1; }

# 5. The test script, run while the member is signed in: every post refused, the form post refused, nothing read,
#    no cookie; the app's session cookie never reaches the build's host; the member is still signed in after.
mark=$(wc -l <"$EV/web.log")
cat >"$EV/attack-run.js" <<'JS'
async page => {
  const seen = [];
  const onResponse = async (r) => {
    const q = r.request();
    const h = await q.allHeaders();
    const names = (h.cookie || "").split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
    seen.push({ method: q.method(), url: q.url(), status: r.status(), site: h["sec-fetch-site"] || null, cookies: names });
  };
  page.on("response", onResponse);
  await page.goto(__OPEN__);
  await page.waitForFunction(() => document.title === "Attack build: done", null, { timeout: 20000 });
  const attack = await page.evaluate(() => window.__attack);
  const shown = await page.innerText("#out");
  await page.goto(new URL("/?form=1", page.url()).toString());
  await page.waitForTimeout(1500);
  page.off("response", onResponse);
  return JSON.stringify({ attack, shown, formLanded: page.url(), seen });
}
JS
open_url=$(q "$WEB/api/design/open?project=$PROJECT&build=$ATK&path=%2F")
python3 -c 'import sys; p=sys.argv[1]; t=open(p).read(); open(p, "w").write(t.replace("__OPEN__", sys.argv[2]))' "$EV/attack-run.js" "$open_url"
attack=$(playwright-cli -s="$SESSION" --raw run-code --filename="$EV/attack-run.js" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))')
printf '%s\n' "$attack" >"$EV/attack.json"
must "the script ran on the attack build's own host" "$attack" 'any(s["url"] == "'"$(host "$ATK")"'/" and s["status"] == 200 for s in d["seen"])'
must "no post's answer reached the script" "$attack" 'len(d["attack"]["posts"]) == 7 and all(not p["read"] for p in d["attack"]["posts"])'
must "no session-only read reached the script" "$attack" 'len(d["attack"]["reads"]) == 3 and all(not r["read"] for r in d["attack"]["reads"])'
must "document.cookie is empty on the build's host" "$attack" 'd["attack"]["cookie"] == ""'
must "the form post was refused (403) though the browser sent the session cookie (same-site)" "$attack" \
  'any(s["method"] == "POST" and s["url"] == "'"$WEB"'/api/auth/logout" and s["status"] == 403 and s["site"] == "same-site" and "__Host-knowledge_session" in s["cookies"] for s in d["seen"])'
must "the app's session cookie never reached a build's host" "$attack" \
  'not any(".design." in s["url"] and any(c.startswith("__Host-") or c == "knowledge_session" for c in s["cookies"]) for s in d["seen"])'
tail -n +"$((mark + 1))" "$EV/web.log" | grep -E '^ *(POST|PUT|PATCH|DELETE|OPTIONS) ' >"$EV/attack-web.log" || true
cat "$EV/attack-web.log"
[ "$(grep -c '^ *POST /api/' "$EV/attack-web.log")" -ge 6 ] || { echo "the app did not see the script's posts"; exit 1; }
if grep -E '^ *POST ' "$EV/attack-web.log" | grep -vE ' (403|415) in '; then echo "a post from the build was not refused"; exit 1; fi
if grep -E '^ *POST /projects/' "$EV/attack-web.log"; then echo "a server action post reached the app"; exit 1; fi
page=$(visit "$SESSION" "$WEB/dashboard")
must "the member is still signed in" "$page" 'd["url"] == "'"$WEB"'/dashboard"'

# 6. Over the cap: refused by the plugin before upload and by the server at upload, each naming the size and the cap.
#    Then design-delete: gone from both lists, and its URL answers 404.
before=$(grep -c 'POST /api/design/' "$EV/api.log" || true)
if refusal=$(sk design-publish --folder "$SCR/big" 2>&1); then echo "the oversized folder was published"; exit 1; fi
printf '%s\n' "$refusal"
printf '%s\n' "$refusal" | grep -q 'refused -- the build is 53,477,[0-9,]* bytes (51.0 MB) unpacked: the cap is 50 MB unpacked (nothing was published)'
[ "$(grep -c 'POST /api/design/' "$EV/api.log" || true)" = "$before" ] || { echo "the plugin sent an upload"; exit 1; }
served=$(XDG="$XDG" API="$API" PROJECT="$PROJECT" python3 - "$SCR/big/out" <<'PY'
import io, json, os, sys, tarfile, urllib.error, urllib.request
keys = json.load(open(os.path.join(os.environ["XDG"], "sikstack", "workspace-keys.json")))
key = keys[os.environ["API"]][os.environ["PROJECT"]]["key"]
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as tar:
    for name in sorted(os.listdir(sys.argv[1])):
        tar.add(os.path.join(sys.argv[1], name), arcname=name)
req = urllib.request.Request(f"{os.environ['API']}/api/design/{os.environ['PROJECT']}/builds", data=buf.getvalue(), method="POST",
                             headers={"Authorization": f"Bearer {key}", "Content-Type": "application/gzip"})
try:
    with urllib.request.urlopen(req) as r:
        print(f"{r.status} {r.read().decode()}")
except urllib.error.HTTPError as e:
    print(f"{e.code} {json.loads(e.read())['detail']}")
PY
)
printf 'server: %s\n' "$served"
case "$served" in "413 "*" 53,477,"*" bytes (51 MB): the cap is 50 MB unpacked") ;; # the server stops at the file that crosses the cap
  "413 "*"(51.0 MB)"*"the cap is 50 MB unpacked"*) ;; *) echo "the server did not refuse the oversized build naming its size and the cap"; exit 1 ;; esac
sk design-delete "$DEL" | grep -qx "deleted=$DEL"
if sk design-builds | grep -q "^$DEL "; then echo "$DEL is still listed by design-builds"; exit 1; fi
pw goto "$VIEW"
see "document.querySelector('a[href\$=\"/$OPT\"]') !== null" "document.querySelector('a[href\$=\"/$DEL\"]') === null"
gone=$(playwright-cli -s="$SESSION" --raw run-code "async page => { const r = await page.goto($(q "$(host "$DEL")/")); return r.status(); }")
[ "$gone" = 404 ] || { echo "the deleted build's URL answered $gone"; exit 1; }
page=$(visit "$SESSION" "$VIEW/$DEL")
must "the viewer says the deleted build is gone" "$page" '"Build not found" in d["text"]'

# 8. The list and the viewer at 1440 and 390, for the walkthrough beside the signed design's screenshots.
for size in "1440 900" "390 844"; do
  pw resize $size
  pw goto "$VIEW"
  see "$(shows "3 builds")"
  shot "08-list-${size%% *}" --full-page
  pw goto "$VIEW/$OPT"
  see "$(shows "3 directions")"
  allframes
  shot "08-viewer-${size%% *}" --full-page
  if [ "${size%% *}" = 390 ]; then # Chromium paints a cross-origin frame only near the viewport: a full-page shot
    for i in 0 1 2; do             # at 390 leaves the lower directions blank, so each gets its own shot in view
      js "() => { document.querySelectorAll('iframe')[$i].scrollIntoView(); return true; }" >/dev/null
      sleep 1
      shot "08-viewer-390-direction-$((i + 1))"
    done
  fi
  noerrors
done
pw resize 1440 900
pw goto "$VIEW"
pw screenshot --filename="$EV/design-service.png"
echo "design-service: PASS"
```

**Proof:** the block ends `design-service: PASS`, each step's `ok` line in the log above it. In `$EV`: `design-service-02-options.png` (the three directions side by side, full height, no bar), `design-service-02-page-<n>.png` (each manifest page, a state picked), `design-service-03-guest-system.png` (a signed-out browser on System by its copy link), `design-service-04-private.png`, `design-service-08-list-<1440|390>.png`, `design-service-08-viewer-<1440|390>.png` and `design-service-08-viewer-shared-390.png`; `attack.json` (the script's own results and every response it caused, with the cookies each request carried) and `attack-web.log` (the app's answers to its posts: 403, or 415 for a content type the route refuses first; the JSON and server-action posts never sent, stopped at the browser's preflight); `publish.log`, `pages.tsv`, `console.log`. The linked checkout is `$EV/design-ws` (no key in it). A run takes about two minutes, most of it the two design builds.
