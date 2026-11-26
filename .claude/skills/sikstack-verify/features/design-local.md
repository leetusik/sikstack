# Design from a local workspace

**Reach it:** a workspace with no `[cloud]` table (local mode) publishes design builds once it has a design link: `sikstack design-link <server>/projects/<id>` (a pasted workspace key, on stdin) or `sikstack design-link --data-dir …` (the connect page). It writes a `[design]` table (server and project, never the key) into the main checkout's `.sikstack/config.toml`; the key stays in `$XDG_CONFIG_HOME/sikstack/workspace-keys.json`. Then `design-publish --folder <build>` runs from the main checkout or any phase's worktree, a worktree cut before the link included, and prints `url=`, the build's viewer, where a member turns sharing on and copies the share link a teammate with no account opens. This is the path design-cowork's publish step takes in a local workspace; `design-service` is the cloud-linked one.

`run.sh local <dir>` makes that workspace: a scratch nested install (the branch's engine) with phase P1 in its own worktree, cut before any link, then the design link set from that worktree with a workspace key it mints through the API for the test account's project `sikstack` and hands to `design-link` on stdin. The key stays in the home's XDG folder, which `down` removes. The build is platform's own `web/design`, made in a scratch copy of `web/` (deleted when the block ends). The signed-out sweep is `design-local.sweep.js` beside this file, run with `run-code --filename=`.

**Drive it:** the link leaves the workspace local (no `store=cloud`, no `[cloud]`, no key in `config.toml`; `worktree start` on a new phase runs); publish from the worktree and from the main checkout, both in `design-builds`; the member opens the printed viewer, turns sharing on and copies the link; a signed-out browser on that link clicks every page from the build's front page and every state from each page's state bar at 1440 and 375, closing a modal state with its own Cancel before the next pick, and the counts match the manifest with no console error and no link off the build's host.

```bash drive
GUEST="$SESSION-guest"
REPO=$(cd "$(dirname "$RUN")/../../.." && pwd)
pw() { playwright-cli -s="$SESSION" "$@" >>"$EV/drive.log" 2>&1; }
js() { playwright-cli -s="${2:-$SESSION}" --raw eval "$1"; }
see() { # JS expressions: wait up to 10 s for each to be true in $SESSION
  local e i
  for e in "$@"; do
    i=0
    until [ "$(js "() => ($e)")" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 10 ] && { echo "not seen: $e (at $(js '() => location.href'))"; return 1; }; sleep 1
    done
    echo "seen: $e"
  done
}
fail() { echo "FAIL $*"; exit 1; }

# 0. The member's session; the unlinked install with P1's worktree and its design link; the build in a scratch web/.
"$RUN" signin
eval "$("$RUN" local "$EV/design-local-$(date +%H%M%S)")"
sk() { local d=$1; shift; (cd "$d" && env -u SIKSTACK_ROOT XDG_CONFIG_HOME="$XDG" SIKSTACK_NO_OFFER=1 "$SK" "$@"); }
grep -q '^design_link=written server=http://127.0.0.1:[0-9]* project='"$PROJECT"' config='"$WS"'/.sikstack/config.toml$' "$EV/run.log" \
  || fail "design-link did not print design_link=written into the main checkout's config.toml (see $EV/run.log)"
echo "ok   design-link from the worktree $WT wrote the main checkout's config.toml"
SCR=$(mktemp -d "${TMPDIR:-/tmp}/sikstack-verify-design-local.XXXXXX")
trap 'rm -rf "$SCR"' EXIT
mkdir -p "$SCR/web"
rsync -a --exclude node_modules --exclude .next --exclude design/out --exclude design/data/local "$REPO/web/" "$SCR/web/"
cp -cR "$REPO/web/node_modules" "$SCR/web/node_modules" 2>/dev/null || cp -R "$REPO/web/node_modules" "$SCR/web/node_modules"
(cd "$SCR/web" && node design/scripts/build.mjs) >>"$EV/design-build.log" 2>&1
mkdir -p "$SCR/build" && mv "$SCR/web/design/out" "$SCR/build/out"
python3 - "$SCR/build/out/manifest.json" "$(git -C "$REPO" rev-parse HEAD)" "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" <<'PY'
import json, sys
path, commit, branch = sys.argv[1:]
m = json.load(open(path)); m["source"] = {"repo": "platform", "commit": commit, "branch": branch, "dirty": True}
open(path, "w").write(json.dumps(m, indent=2) + "\n")
PY
cp "$SCR/build/out/manifest.json" "$EV/design-local-manifest.json"

# 1. The link keeps the workspace local: next prints no store=cloud from either checkout, config.toml holds [design]
#    and no [cloud] and no key, and worktree start on a new phase runs.
for d in "$WT" "$WS"; do
  sk "$d" next >"$EV/design-local-next.txt" 2>&1 || fail "next failed in $d"
  ! grep -q '^store=cloud' "$EV/design-local-next.txt" || fail "next prints store=cloud in $d"
done
XDG="$XDG" API="$API" PROJECT="$PROJECT" python3 - "$WS/.sikstack/config.toml" "$WT/.sikstack/config.toml" "$EV" <<'PY' || fail "config.toml or the key file is wrong"
import json, os, re, sys, pathlib
main, wt, ev = sys.argv[1:]
key = json.load(open(os.path.join(os.environ["XDG"], "sikstack", "workspace-keys.json")))[os.environ["API"]][os.environ["PROJECT"]]["key"]
text = open(main).read()
assert re.search(r"(?m)^\[design\]$", text), "no [design] in the main checkout's config.toml"
assert f'project_id = "{os.environ["PROJECT"]}"' in text, "[design] names another project"
for f in (main, wt):
    assert not re.search(r"(?m)^\[cloud\]$", open(f).read()), f"[cloud] in {f}"
leaks = [str(p) for p in pathlib.Path(ev).rglob("*") if p.is_file() and key.encode() in p.read_bytes()]
leaks += [f for f in (main, wt) if key in open(f).read()]
assert not leaks, f"the key appears in {leaks}"
print("ok   [design] in the main checkout's config.toml; no [cloud] in either; the key only in the 0600 key file")
PY
sk "$WS" phase new --phase P2 --name "Second" --objective "cut after the design link" >/dev/null
sk "$WS" worktree start P2 --host-branch feat/p2 >"$EV/design-local-p2.txt" 2>&1 || { cat "$EV/design-local-p2.txt"; fail "worktree start P2 after the link"; }
grep -q '^host_worktree=' "$EV/design-local-p2.txt" || fail "worktree start P2 printed no host_worktree="
echo "ok   next prints no store=cloud in the worktree or the main checkout; worktree start P2 runs after the link"

# 2. Publish from the worktree (cut before the link) and from the main checkout; design-builds lists both, newest first.
publish() { # checkout: design-publish the build from it; prints the build id
  local out; out=$(sk "$1" design-publish --folder "$SCR/build"); printf '%s\n' "$out" >>"$EV/publish.log"
  printf '%s\n' "$out" | sed -n 's/^published=\([a-z0-9]*\) .*/\1/p'
}
: >"$EV/publish.log"
FROM_WT=$(publish "$WT"); FROM_MAIN=$(publish "$WS")
[ -n "$FROM_WT" ] && [ -n "$FROM_MAIN" ] && [ "$FROM_WT" != "$FROM_MAIN" ] || { cat "$EV/publish.log"; fail "a publish printed no published="; }
VIEW="$WEB/projects/$PROJECT/design"
for id in "$FROM_WT" "$FROM_MAIN"; do
  grep -q "^published=$id url=$VIEW/$id .*host=${DESIGN/\{build\}/$id}/\$" "$EV/publish.log" || fail "published=$id does not print the viewer url= and the build's host="
done
sk "$WT" design-builds >"$EV/design-local-builds.txt" || fail "design-builds failed in the worktree"
cat "$EV/design-local-builds.txt"
[ "$(sed -n 's/^\([a-z0-9]*\) url=.*/\1/p' "$EV/design-local-builds.txt" | head -2 | tr '\n' ' ')" = "$FROM_MAIN $FROM_WT " ] \
  || fail "design-builds does not list $FROM_MAIN then $FROM_WT first"
echo "ok   published $FROM_WT from the worktree and $FROM_MAIN from the main checkout; design-builds lists both, newest first"

# 3. The member opens the printed url= (the viewer), turns sharing on and copies the share link.
URL=$(sed -n "s/^published=$FROM_MAIN url=\([^ ]*\) .*/\1/p" "$EV/publish.log")
pw resize 1440 900
pw goto "$URL"
see "location.href === '$URL'" 'document.body.innerText.includes("Share link")' '[...document.querySelectorAll("button")].some(b => b.textContent.startsWith("Turn on"))'
playwright-cli -s="$SESSION" --raw run-code "async page => { await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: '$WEB' }); return 'ok'; }" >/dev/null
pw click 'role=button[name="Turn on"]'
see 'document.querySelector(".design-share-on") !== null'
pw click 'role=button[name="Copy share link"]'
LINK=$(js '() => navigator.clipboard.readText()' | tr -d '"')
case "$LINK" in "${DESIGN/\{build\}/$FROM_MAIN}/_share/"*) ;; *) fail "the copied share link is not on the build's host" ;; esac
pw screenshot --filename="$EV/design-local-viewer-shared.png"
echo "ok   the member turned sharing on in the viewer and copied the share link"

# 4. A signed-out browser holding only that link sweeps the build at 1440 and 375, by click.
sed -e "s#__LINK__#$LINK#" -e "s#__SHOTS__#$EV#" "$(dirname "$RUN")/features/design-local.sweep.js" >"$EV/design-local-sweep.js"
playwright-cli -s="$GUEST" close >/dev/null 2>&1 || true
playwright-cli -s="$GUEST" open --config="$EV/cli.config.json" >>"$EV/drive.log" 2>&1
playwright-cli -s="$GUEST" --raw run-code --filename="$EV/design-local-sweep.js" \
  | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()))' >"$EV/design-local-sweep.json"
playwright-cli -s="$GUEST" close >>"$EV/drive.log" 2>&1
python3 - "$EV/design-local-manifest.json" "$EV/design-local-sweep.json" <<'PY' || fail "the sweep fell short (see $EV/design-local-sweep.json)"
import json, sys
m, s = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
pages = {p["entry"]: p for p in m["pages"] if p["entry"] != "/"}
want_states = sum(len(p.get("states") or []) for p in pages.values())
bad = []
if not s["landed"].startswith(s["origin"] + "/"): bad.append(f"the share link landed off the build: {s['landed']}")
for size in s["sizes"]:
    w, seen, states, modals, busy, front = size["width"], set(), 0, [], [], 0
    for r in size["pages"]:
        p = pages.get(r["path"])
        if not p or not r["onBuild"]: bad.append(f"{w}: {r['href']} landed on {r['landed']}, no manifest page"); continue
        seen.add(r["path"])
        keys = [x["key"] for x in r["states"]]
        if sorted(keys) != sorted(x["key"] for x in p.get("states") or []) or r["stateFailures"]:
            bad.append(f"{w}: {p['name']} switched {keys}, failed {r['stateFailures']}")
        if not all(x["onBuild"] for x in r["states"]): bad.append(f"{w}: {p['name']}: a state left the build")
        if r["offBuildLinks"]: bad.append(f"{w}: {p['name']} links off the build: {r['offBuildLinks'][:3]}")
        states += len(keys); modals += [f"{p['name']}:{k}" for k in r["modalsClosed"]]
        busy += [f"{p['name']}:{k}" for k in r["modalsBusy"]]; front += sum(x["via"] == "front" for x in r["states"])
    if seen != set(pages): bad.append(f"{w}: pages not reached: {sorted(set(pages) - seen)}")
    if size["frontStateLinks"] != want_states: bad.append(f"{w}: the front page links {size['frontStateLinks']} states, not {want_states}")
    if "Feedback item:confirm-new" not in modals: bad.append(f"{w}: confirm-new was not closed by its own Cancel ({modals})")
    print(f"seen {w}: {len(seen)}/{len(pages)} pages from the front page, {states}/{want_states} states by click"
          f" ({states - front} from the bars, {front} from the front page past a busy modal: {busy}); modals closed by Cancel: {modals}")
if s["errors"]: bad.append(f"errors: {s['errors'][:3]}")
if s["badDocs"]: bad.append(f"documents >= 400: {s['badDocs'][:3]}")
print(f"seen {s['docCount']} documents, {len(s['badDocs'])} >= 400, {len(s['errors'])} console or page errors")
for b in bad: print("FAIL " + b)
sys.exit(1 if bad else 0)
PY
echo "ok   a signed-out browser on the share link reached every page and state at 1440 and 375, on the build's host only"
pw goto "$VIEW"
see "document.querySelector('a[href\$=\"/$FROM_WT\"]') !== null" "document.querySelector('a[href\$=\"/$FROM_MAIN\"]') !== null"
pw screenshot --filename="$EV/design-local.png"
echo "design-local: PASS"
```

**Proof:** the block ends `design-local: PASS`, each step's `ok` line above it in `feature-design-local.log`. In `$EV`: `run.log` (the install, its P1 worktree and `design-link`'s `design_link=written` line, no key), `design-local-next.txt`, `design-local-p2.txt`, `publish.log` (two `published=` lines), `design-local-builds.txt` (both ids, newest first), `design-local-viewer-shared.png` (the viewer with sharing on), `design-local-sweep.json` (each page's landing, the states each bar switched, the modals closed by Cancel, links off the build, errors and document statuses), `design-local-<1440|375>-<nn>.png` (the front page as `00`, then each page; a modal state as `-modal-<key>`), `design-local.png` (the Design list with both builds). A run takes about three minutes, most of it the build and the sweep.
