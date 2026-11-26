# Design service

**Reach it:** the project rail's "Design" entry: the list at `/projects/<id>/design`, a build's viewer at `/projects/<id>/design/<build>` (entered by a full page load, never a client navigation: the viewer's CSP frames the build's origin). Builds come from the sikstack plugin's `design-publish`, run from a checkout linked to the project. Each build is served at the root of its own host, `<build>.design.sikstack.localhost:<design port>`, by the design origin `up` starts; a member gets in through the app's `/api/design/open` (a one-use ticket), a signed-out browser only through the build's share link while it is on.

`run.sh workspace <dir>` makes that checkout: a scratch repo with a `sikstack init` workspace (the branch's engine), linked to the test account's project `sikstack` by a workspace key it mints through the API and hands to `link` on stdin. The key stays in the home's XDG folder (0700, its file 0600), which `down` removes. `run.sh signin other` signs a second account (its own org, a member of nothing here) into `$SESSION-other`; `run.sh api <method> <path> [json]` calls the API as the test account. Every build is made in a scratch copy of `web/` (deleted when the block ends), never in the design folder itself.

**Drive it:** publish four builds (one with the plugin's options page, one from a `design/data/local/` recording, one carrying a test script, one to delete) and an oversized folder; then the printed URL (the build's viewer) and the bare build host (a 403 linking to it); the viewer's pages, states and options; a non-member, a share link on and off; the private build; the test script against the member's session; the size cap and `design-delete`; the list and the viewer at 1440 and 390; a round's build (`--page` twice): its viewer's two rows and count with no options section, its link to every page (the options and every page) and back; a build without a round at its every-page address (back reads "Pages"); an options-only round (`--page <options entry>`): the options and the link to every page.

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

# 1. The URL design-publish and design-builds print (url=) is the build's viewer on the app, and the member who
#    published opens it there. The build's own host, opened bare (before any viewer has traded a ticket for its
#    cookie), is a 403 with none of the build, whose one link is that viewer (it never says to sign in with no way
#    forward); following it opens the viewer.
PRINTED=$(sed -n "s/^published=$OPT url=\([^ ]*\) .*/\1/p" "$EV/publish.log" | head -1)
[ "$PRINTED" = "$VIEW/$OPT" ] || { echo "design-publish printed url=$PRINTED, not the viewer $VIEW/$OPT"; exit 1; }
sk design-builds >"$EV/builds.log"; cat "$EV/builds.log"
grep -q "^$OPT url=$VIEW/$OPT .* host=$(host "$OPT")/\$" "$EV/builds.log" || { echo "design-builds does not lead $OPT with its viewer"; exit 1; }
page=$(visit "$SESSION" "$(host "$OPT")/")
must "the bare host is a 403 saying where the build opens, never to sign in" "$page" \
  'd["status"] == 403 and "opens from sikstack" in d["text"] and "sign in" not in d["text"].lower() and "3 directions" not in d["text"]'
see "document.querySelectorAll('a').length === 1 && document.querySelector('a').href === '$VIEW/$OPT'"
shot 01-bare-host
pw click "a[href=\"$VIEW/$OPT\"]"
see "location.href === '$VIEW/$OPT'" "$(shows "3 directions")" 'document.querySelectorAll("iframe").length === 3'
pw goto "$WEB/dashboard"
page=$(visit "$SESSION" "$PRINTED")
must "the printed URL opens the viewer for the member who published" "$page" 'd["status"] == 200 and d["url"] == "'"$VIEW/$OPT"'"'
see "$(shows "3 directions")" 'document.querySelectorAll("iframe").length === 3'
shot 01-printed-url
echo "printed url: the viewer, opened by the member; the bare host links to it"

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
links=$(js '() => JSON.stringify([...document.querySelectorAll(".design-pages > .design-page > a")].map(a => [a.textContent, a.getAttribute("href")]))' \
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
playwright-cli -s="$OTHER" click "a[href=\"$VIEW/$OPT\"]" >>"$EV/drive.log" 2>&1
IN="$OTHER" see "location.href === '$VIEW/$OPT'" "$(shows "Project not found")" "!document.querySelector('iframe')"
echo "ok   the refusal's link takes the second account to the app, which refuses it too"
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
playwright-cli -s="$GUEST" click "a[href=\"$VIEW/$OPT\"]" >>"$EV/drive.log" 2>&1
IN="$GUEST" see "location.pathname === '/login'"
echo "ok   the off link's one link asks the signed-out browser to sign in on the app, and opens nothing"
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

# 9. A round's build (design-publish --page, two values, from the folder with an options page): its viewer lists
#    only those two pages, each with its states, says 2 pages, shows no options section (the round did not name the
#    options page) and links once to the whole design; that link lands on the build's every-page list (the options
#    page's three directions, framed as on the viewer, then every manifest page; its way back "This round", the
#    round's list). A round row and a row only the every-page list holds each open their page on the build's host. A
#    build without a round has the every-page list too, its way back "Pages". Screenshots at 1440 and 390.
WS_ROUTE='/projects/[projectId]/workspace'; DB_ROUTE='/projects/[projectId]/design/[build]'
out=$(sk design-publish --folder "$SCR/options" --page "$WS_ROUTE" --page "$DB_ROUTE"); printf '%s\n' "$out" >>"$EV/publish.log"
RND=$(printf '%s\n' "$out" | sed -n 's/^published=\([a-z0-9]*\) .*/\1/p')
[ -n "$RND" ] || { echo "the round's publish failed: $out"; exit 1; }
printf '%s\n' "$out" | grep -q "^published=$RND url=$VIEW/$RND " || { echo "the round's publish did not print its viewer"; exit 1; }
rm=$("$RUN" api GET "/app/projects/$PROJECT/design/builds/$RND" | sed 1d)
must "the round's manifest names the two pages' entries, in the manifest's order" "$rm" \
  '[p["route"] for p in d["manifest"]["pages"] if p["entry"] in d["manifest"]["round"]["pages"]] == ["'"$WS_ROUTE"'", "'"$DB_ROUTE"'"] and len(d["manifest"]["round"]["pages"]) == 2'
ALL=$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])["manifest"]["pages"]))' "$rm")
rows() { js '() => JSON.stringify([...document.querySelectorAll(".design-pages > .design-page > a")].map(a => a.textContent))' | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))'; }
for size in "1440 900" "390 844"; do
  pw resize $size
  pw goto "$VIEW/$RND"
  see "$(shows "This round")" "$(shows "2 pages")" "$(shows "The whole design · $ALL pages")" \
    'document.querySelectorAll(".design-pages > .design-page").length === 2' \
    'document.querySelectorAll(".design-pages .design-page-states a").length > 0' \
    "document.querySelectorAll('a[href=\"/projects/$PROJECT/design/$RND/pages\"]').length === 1" \
    '!document.querySelector("#design-options")' '!document.querySelector("iframe")' \
    'document.querySelector("header.page-top + section")?.getAttribute("aria-labelledby") === "design-pages"'
  must "the round's list holds exactly its two pages" "$(rows)" 'd == ["Workspace · Agenda", "Design build"]'
  shot "09-round-${size%% *}" --full-page
  noerrors
done
pw resize 1440 900
pw goto "$VIEW/$RND"
pw click "a[href=\"/projects/$PROJECT/design/$RND/pages\"]"
see "location.pathname === '/projects/$PROJECT/design/$RND/pages'" "$(shows "Every page")" "$(shows "$ALL pages")" \
  "document.querySelectorAll('.design-pages > .design-page').length === $ALL" \
  "document.querySelector('a.back')?.getAttribute('href') === '/projects/$PROJECT/design/$RND'" \
  "document.querySelector('a.back')?.textContent === 'This round'" \
  "$(shows "3 directions")" 'document.querySelectorAll(".design-directions iframe").length === 3' \
  'document.querySelector("header.page-top + section")?.getAttribute("aria-labelledby") === "design-options"'
# A direction posts its height once on load (and on resize): on the route's first, cold compile under `next dev` the
# frames can load before the page hydrates and listens, and keep the sheet's height. A reload, warm, takes them all.
pw reload
allframes
noerrors
for size in "1440 900" "390 844"; do
  pw resize $size
  shot "09-every-page-${size%% *}" --full-page
done
pw resize 1440 900
system=$(js '() => document.querySelector(".design-pages > .design-page > a[aria-label^=\"System,\"]").getAttribute("href")' | tr -d '"')
page=$(visit "$SESSION" "$WEB$system")
must "a row only the every-page list holds (System) opens on the build's host" "$page" 'd["status"] == 200 and d["url"] == "'"$(host "$RND")"'/system/"'
pw goto "$VIEW/$RND/pages"
pw click 'a.back'
see "location.pathname === '/projects/$PROJECT/design/$RND'" "$(shows "This round")"
wsrow=$(js '() => document.querySelector(".design-pages > .design-page > a").getAttribute("href")' | tr -d '"')
page=$(visit "$SESSION" "$WEB$wsrow")
must "a round row (Workspace · Agenda) opens on the build's host" "$page" 'd["status"] == 200 and d["url"].startswith("'"$(host "$RND")"'/projects/")'
echo "round: the viewer lists the round's 2 pages, no options, one link to all $ALL (the options with them), and back"
# A build without a round ($OPT): its every-page list's way back names the build's list, "Pages", not a round.
pw goto "$VIEW/$OPT/pages"
see "$(shows "Every page")" "$(shows "$ALL pages")" "!document.body.innerText.includes('This round')" \
  "document.querySelector('a.back')?.textContent === 'Pages'" \
  "document.querySelector('a.back')?.getAttribute('href') === '/projects/$PROJECT/design/$OPT'" \
  'document.querySelectorAll(".design-directions iframe").length === 3'
noerrors
shot "09-every-page-no-round-1440"
pw click 'a.back'
see "location.pathname === '/projects/$PROJECT/design/$OPT'" "$(shows "Pages")" "!document.body.innerText.includes('This round')"
echo "no round: the every-page list's way back reads Pages and lands on the build's list"
# An options-only round (--page <options.entry>): its viewer shows the options and the link to the whole design, and
# no page list or page count.
OENT=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["manifest"]["options"]["entry"])' "$rm")
out=$(sk design-publish --folder "$SCR/options" --page "$OENT"); printf '%s\n' "$out" >>"$EV/publish.log"
ORND=$(printf '%s\n' "$out" | sed -n 's/^published=\([a-z0-9]*\) .*/\1/p')
[ -n "$ORND" ] || { echo "the options round's publish failed: $out"; exit 1; }
orm=$("$RUN" api GET "/app/projects/$PROJECT/design/builds/$ORND" | sed 1d)
must "the options round's manifest names only the options entry" "$orm" 'd["manifest"]["round"]["pages"] == ["'"$OENT"'"]'
pw resize 1440 900
pw goto "$VIEW/$ORND"
see "$(shows "This round")" "$(shows "The options above")" "$(shows "The whole design · $ALL pages")" \
  'document.querySelectorAll(".design-directions iframe").length === 3' \
  '!document.querySelector(".design-pages")' "!document.body.innerText.includes('0 pages')"
shot "09-options-round-1440" --full-page
noerrors
pw click "a[href=\"/projects/$PROJECT/design/$ORND/pages\"]"
see "location.pathname === '/projects/$PROJECT/design/$ORND/pages'" "$(shows "Every page")" "$(shows "$ALL pages")" \
  'document.querySelectorAll(".design-directions iframe").length === 3' \
  "document.querySelector('a.back')?.textContent === 'This round'"
echo "round: an options-only round shows the options and the link to all $ALL, which shows them too"

pw resize 1440 900
pw goto "$VIEW"
pw screenshot --filename="$EV/design-service.png"
echo "design-service: PASS"
```

**Proof:** the block ends `design-service: PASS`, each step's `ok` line in the log above it. In `$EV`: `design-service-01-printed-url.png` (the URL `design-publish` printed, opened by the member: the viewer), `design-service-01-bare-host.png` (the build's own host without a ticket: a 403 whose one link is the viewer), `design-service-02-options.png` (the three directions side by side, full height, no bar), `design-service-02-page-<n>.png` (each manifest page, a state picked), `design-service-03-guest-system.png` (a signed-out browser on System by its copy link), `design-service-04-private.png`, `design-service-08-list-<1440|390>.png`, `design-service-08-viewer-<1440|390>.png` and `design-service-08-viewer-shared-390.png`; `design-service-09-round-<1440|390>.png` (a `--page` build's viewer: the round's two pages with their states first under the header, no options section, and the link to the whole design), `design-service-09-options-round-1440.png` (an options-only round: the directions, "The options above", the link to the whole design) `design-service-09-every-page-<1440|390>.png` (that build's every-page list: the three directions, then every page) and `design-service-09-every-page-no-round-1440.png` (a build without a round: its every-page list, its way back "Pages"); `attack.json` (the script's own results and every response it caused, with the cookies each request carried) and `attack-web.log` (the app's answers to its posts: 403, or 415 for a content type the route refuses first; the JSON and server-action posts never sent, stopped at the browser's preflight); `publish.log`, `pages.tsv`, `console.log`. The linked checkout is `$EV/design-ws` (no key in it). A run takes about two minutes, most of it the two design builds.
