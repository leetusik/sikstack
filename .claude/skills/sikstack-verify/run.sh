#!/usr/bin/env bash
# sikstack local verification stack: doctor | up | signin | seed | expect | feature <name> | status | down
#
# Runs the whole product on loopback without touching the checkout: a throwaway
# postgres:17 container, the API on the host (scratch KB_ROOT, KB_GIT_COMMIT=false),
# the design origin (server.design_serve), the web dev server, a local test account,
# and a headless playwright-cli session. The app is reached at sikstack.localhost:<web>
# and each design build at <build>.design.sikstack.localhost:<design>: same-site, never
# the same host, as sikstack.com and its subdomains will be (Chromium resolves every
# *.localhost name to loopback; Next 16's dev guard allows **.localhost by default).
# Every process starts from a scrubbed environment: no vendor API keys, no SMTP, no
# operator account, whatever the caller's shell exports.
# Everything it writes (state, logs, screenshots, the saved sign-in) lives under
# $SIKSTACK_VERIFY_HOME (default: one folder per checkout under ${TMPDIR}/sikstack-verify/).
# The container and the browser session are named after that home, so two homes run
# side by side, and `down` stops only what `up` recorded starting: each server leads its own
# process group, recorded at launch, and `down` signals that group while its leader's pid and
# start time still match the record; and the container it created.
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
_tmp="${TMPDIR:-/tmp}"; _tmp="${_tmp%/}"
abs() { # path: absolute and logically normalized (no ., .. or //), so every spelling names one home
  local p="$1" seg out="" IFS=/
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  for seg in $p; do
    case "$seg" in ""|.) ;; ..) out="${out%/*}" ;; *) out="$out/$seg" ;; esac
  done
  printf '%s\n' "${out:-/}"
}
hash8() { printf '%08x' "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
HOME_DIR="$(abs "${SIKSTACK_VERIFY_HOME:-$_tmp/sikstack-verify/$(hash8 "$REPO")}")"
STATE="$HOME_DIR/state.env"
OWNED="$HOME_DIR/owned.tsv" # pid <TAB> start time <TAB> pgid, one line per server group leader and member
CONTAINER="sikstack-verify-pg-$(hash8 "$HOME_DIR")"
SESSION="sikstack-verify-$(hash8 "$HOME_DIR")"
LABEL="sikstack-verify.home"
CLI_VERSION="0.1.25"
APP_HOST="sikstack.localhost"
# The only variables the servers inherit; everything else (GOOGLE_API_KEY, GEMINI_API_KEY,
# KB_SMTP_*, KB_OPERATOR_*, KB_API_TOKEN, KB_GIT_PUSH, UV_ENV_FILE, ...) is dropped.
BASE_ENV=(PATH="$PATH" HOME="${HOME:-}" USER="${USER:-}" LOGNAME="${LOGNAME:-}" TMPDIR="$_tmp/"
  LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" NEXT_TELEMETRY_DISABLED=1)

say() { printf '%s\n' "$*"; [ -n "${EV:-}" ] && [ -d "$EV" ] && printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >>"$EV/run.log"; return 0; }
die() { [ -n "${UPPING:-}" ] && own_refresh; say "error: $*"; exit 1; }
listening() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }
who_listens() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" (pid "$2")"}'; }
free_port() { local p=$1; while [ -n "$(listening "$p")" ]; do p=$((p + 1)); done; echo "$p"; }
load_state() { # the names always come from the home, never from the file
  [ -f "$STATE" ] && . "$STATE"
  CONTAINER="sikstack-verify-pg-$(hash8 "$HOME_DIR")"; SESSION="sikstack-verify-$(hash8 "$HOME_DIR")"; return 0
}

# --- what this run started -------------------------------------------------------------
# Each server is launched as the leader of its own process group and recorded straight after $!, as
# "pid <TAB> start time <TAB> pgid" (a leader's pgid is its own pid); its group's members are recorded the
# same way. A start time survives exec, a command line does not: nothing here reads a command line to
# decide what is ours.
proc_start() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/ *$//'; }
proc_pgid() { ps -o pgid= -p "$1" 2>/dev/null | tr -d ' '; }
proc_cmd() { ps -ww -o command= -p "$1" 2>/dev/null; } # for messages only
group_alive() { kill -0 -- "-$1" 2>/dev/null; }
group_members() { ps -A -o pid=,pgid= 2>/dev/null | awk -v g="$1" '$2==g{print $1}'; }
owned_line() { [ -f "$OWNED" ] && awk -F'\t' -v p="$1" '$1==p' "$OWNED" | tail -1; }
owned_groups() { [ -f "$OWNED" ] && awk -F'\t' '$1==$3{print $1}' "$OWNED" | sort -un; }
recorded() { # pid: alive, with the start time recorded for that pid
  local rec st; rec=$(owned_line "$1"); [ -n "$rec" ] || return 1
  st=$(proc_start "$1"); [ -n "$st" ] && [ "$st" = "$(printf '%s' "$rec" | cut -f2)" ]
}
group_ours() { # pgid: a group up launched, and still that group
  local g=$1 m
  owned_groups | grep -qx "$g" || return 1
  if [ -n "$(proc_start "$g")" ]; then recorded "$g"; return; fi # the leader lives: its start time decides
  # The leader is gone. Its pid (the group's id) is not reused while the group lives (POSIX fork()), but the
  # group may have ended and the id been taken since: only a live member the record names keeps it ours.
  group_alive "$g" || return 1
  for m in $(group_members "$g"); do
    recorded "$m" && [ "$(owned_line "$m" | cut -f3)" = "$g" ] && return 0
  done
  return 1
}
is_ours() { # pid: a process up recorded (pid and start time), or a member of a group that is still ours
  local g; recorded "$1" && return 0
  g=$(proc_pgid "$1"); [ -n "$g" ] && group_ours "$g"
}
launched() { # pid: record a server up has just started as the leader of its own group (called straight after $!)
  local st; st=$(proc_start "$1")
  [ -n "$st" ] && [ "$(proc_pgid "$1")" = "$1" ] || return 1
  printf '%s\t%s\t%s\n' "$1" "$st" "$1" >>"$OWNED"
}
own_refresh() { # record every member of this run's groups (pid, start time, pgid), while the groups are ours
  local g m st
  for g in $(owned_groups); do
    group_ours "$g" || continue
    for m in $(group_members "$g"); do
      recorded "$m" && continue
      st=$(proc_start "$m"); [ -n "$st" ] && printf '%s\t%s\t%s\n' "$m" "$st" "$g" >>"$OWNED"
    done
  done
  return 0
}
dev_lock_holders() { # pids holding this checkout's Next dev lock (Next 16 allows one next dev per web/)
  local lock
  for lock in "$REPO/web/.next/dev/lock" "$REPO/web/.next/lock"; do
    [ -e "$lock" ] && lsof -t -- "$lock" 2>/dev/null
  done | sort -u
}
wait_http() { # url seconds
  local i=0
  while [ "$i" -lt "$2" ]; do
    curl -fsS -o /dev/null "$1" 2>/dev/null && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

doctor() {
  local bad=0 who pid
  docker info >/dev/null 2>&1 && say "ok   docker running" || { say "FIX  docker is not running: start Docker Desktop"; bad=1; }
  for t in uv pnpm node curl lsof; do
    command -v "$t" >/dev/null && say "ok   $t" || { say "FIX  $t is missing: install it"; bad=1; }
  done
  if [ ! -d "$REPO/web/node_modules" ]; then
    say "..   web/node_modules missing: pnpm --dir web install --frozen-lockfile"
    pnpm --dir "$REPO/web" install --frozen-lockfile >/dev/null 2>&1 && say "ok   web/node_modules installed" || { say "FIX  pnpm install failed"; bad=1; }
  else say "ok   web/node_modules"; fi
  if [ ! -d "$REPO/.venv" ]; then
    say "..   .venv missing: uv sync"
    (cd "$REPO" && uv sync >/dev/null 2>&1) && say "ok   .venv created" || { say "FIX  uv sync failed"; bad=1; }
  else say "ok   .venv"; fi
  if ! command -v playwright-cli >/dev/null; then
    say "..   playwright-cli missing: npm install -g @playwright/cli@$CLI_VERSION"
    npm install -g "@playwright/cli@$CLI_VERSION" >/dev/null 2>&1 && say "ok   playwright-cli installed" || { say "FIX  npm install -g @playwright/cli@$CLI_VERSION failed"; bad=1; }
  else say "ok   playwright-cli $(playwright-cli --version 2>/dev/null)"; fi
  for pid in $(dev_lock_holders); do
    if is_ours "$pid"; then say "ok   web/.next dev lock held by this run's next dev (pid $pid)"
    else
      say "FIX  a next dev already runs in this checkout's web/: $(proc_cmd "$pid" | cut -c1-80) (pid $pid). Next allows one per web/, on any port: stop it, or run this skill from another worktree"
      bad=1
    fi
  done
  for p in 3030 8766 3061; do
    who=$(who_listens "$p")
    if [ -z "$who" ]; then say "ok   port $p free"
    else say "note port $p is taken by $who (not ours: left alone); up uses port $(free_port "$p")"; fi
  done
  [ "$bad" = 0 ] && say "doctor: ready" || say "doctor: fix the FIX lines above"
  return "$bad"
}

write_state() {
  mkdir -p "$HOME_DIR"
  {
    echo "EV='$EV'"; echo "KB_ROOT_DIR='$KB_ROOT_DIR'"; echo "PG_PORT='$PG_PORT'"
    echo "API_PORT='$API_PORT'"; echo "WEB_PORT='$WEB_PORT'"; echo "API_PID='${API_PID:-}'"
    echo "WEB_PID='${WEB_PID:-}'"; echo "WEB='http://$APP_HOST:$WEB_PORT'"; echo "ENV_FILE='$ENV_FILE'"
    echo "DESIGN_PORT='${DESIGN_PORT:-}'"; echo "DESIGN_PID='${DESIGN_PID:-}'"; echo "DESIGN='${DESIGN:-}'"
    echo "CONTAINER='$CONTAINER'"; echo "CONTAINER_ID='${CONTAINER_ID:-}'"; echo "SESSION='$SESSION'"
  } >"$STATE"
}

# api_start <db url> [VAR=value...]: launch the API as its own process group (set -m for this launch only: bash sets
# the pgid before $! returns, so down stops it and all its children by that group, whatever the server execs into),
# record it and wait for /healthz. KB_PUBLIC_BASE_URL is the web's address (the sikstack connect page's links);
# SIKSTACK_VERIFY_WAITLIST=1 in the caller's environment turns the sign-up waitlist on. The design settings
# (DESIGN_ENV: the builds folder, the origin pattern, the app's origin, the secret) are the design origin's own.
api_start() {
  local db=$1; shift
  set -m
  (cd "$REPO" && exec env -i "${BASE_ENV[@]}" DATABASE_URL="$db" KB_ROOT="$KB_ROOT_DIR" KB_GIT_COMMIT=false \
    KB_GIT_PUSH=false KB_STARTUP_REINDEX=false KB_PUBLIC_BASE_URL="http://$APP_HOST:$WEB_PORT" \
    KB_SIGNUP_WAITLIST="${SIKSTACK_VERIFY_WAITLIST:-false}" "${DESIGN_ENV[@]}" "$@" \
    nohup uv run uvicorn server.main:app --host 127.0.0.1 --port "$API_PORT") </dev/null >>"$EV/api.log" 2>&1 &
  API_PID=$!; set +m; launched "$API_PID" || die "the API did not start (see $EV/api.log)"; write_state
  wait_http "http://127.0.0.1:$API_PORT/healthz" 60 || die "API /healthz did not answer (see $EV/api.log)"
  own_refresh
}

up() {
  if [ -f "$STATE" ]; then
    load_state
    if [ -n "${WEB_PID:-}" ] && is_ours "$WEB_PID"; then say "already up: $WEB (session $SESSION, evidence $EV)"; return 0; fi
    die "an earlier run left $STATE: run '$0 down' first (it stops only what that run started)"
  fi
  doctor >/dev/null || die "doctor failed: run '$0 doctor'"
  if [ -n "$(docker ps -aq --filter "name=^/$CONTAINER\$" 2>/dev/null)" ]; then
    die "a container named $CONTAINER exists that this home has no record of: left alone. Remove it yourself if it is yours, or set another SIKSTACK_VERIFY_HOME"
  fi
  EV="${1:-$HOME_DIR/runs/$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$EV/cli-output" || die "cannot create $EV"
  EV="$(cd "$EV" && pwd)"
  mkdir -p "$HOME_DIR"; rm -f "$OWNED"
  KB_ROOT_DIR="$HOME_DIR/kb-root"; rm -rf "$KB_ROOT_DIR"; mkdir -p "$KB_ROOT_DIR"
  ENV_FILE="$HOME_DIR/web.env"; rm -f "$ENV_FILE"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  PG_PORT=$(free_port 55471); API_PORT=$(free_port 8766); WEB_PORT=$(free_port 3030); DESIGN_PORT=$(free_port 3061)
  while [ "$DESIGN_PORT" = "$WEB_PORT" ] || [ "$DESIGN_PORT" = "$API_PORT" ]; do DESIGN_PORT=$(free_port $((DESIGN_PORT + 1))); done
  DESIGN="http://{build}.design.$APP_HOST:$DESIGN_PORT"
  DESIGN_ENV=(KB_DESIGN_BUILDS_DIR="$KB_ROOT_DIR/data/design-builds" KB_DESIGN_ORIGIN="$DESIGN"
    KB_DESIGN_APP_ORIGIN="http://$APP_HOST:$WEB_PORT" KB_DESIGN_SECRET="$(openssl rand -hex 32)")
  API_PID=""; WEB_PID=""; DESIGN_PID=""; CONTAINER_ID=""; write_state; UPPING=1
  say "up: evidence $EV; ports pg $PG_PORT, api $API_PORT, web $WEB_PORT, design $DESIGN_PORT; container $CONTAINER; session $SESSION"

  docker run -d --name "$CONTAINER" --label "$LABEL=$HOME_DIR" -e POSTGRES_DB=kb -e POSTGRES_USER=kb -e POSTGRES_PASSWORD=kb \
    -p "127.0.0.1:$PG_PORT:5432" postgres:17 >/dev/null 2>>"$EV/run.log"
  local rc=$?
  CONTAINER_ID=$(docker ps -aq --no-trunc --filter "name=^/$CONTAINER\$" --filter "label=$LABEL=$HOME_DIR" 2>/dev/null | head -1)
  write_state
  [ "$rc" = 0 ] || die "docker run failed (see $EV/run.log)"
  local db="postgresql+psycopg://kb:kb@127.0.0.1:$PG_PORT/kb" i=0
  until docker exec "$CONTAINER_ID" pg_isready -U kb -d kb >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && die "postgres did not become ready"; sleep 1
  done
  sleep 1
  (cd "$REPO" && exec env -i "${BASE_ENV[@]}" DATABASE_URL="$db" uv run alembic upgrade head) >>"$EV/run.log" 2>&1 \
    || die "alembic upgrade failed (see $EV/run.log)"
  say "up: migrated"

  api_start "$db"
  say "up: api http://127.0.0.1:$API_PORT/healthz ok${SIKSTACK_VERIFY_WAITLIST:+ (waitlist on)}"

  (cd "$REPO" && exec env -i "${BASE_ENV[@]}" DATABASE_URL="$db" \
    uv run python scripts/dev_feedback_key.py --env-file "$ENV_FILE" --api "http://127.0.0.1:$API_PORT") >>"$EV/run.log" 2>&1 \
    || die "dev_feedback_key.py failed (see $EV/run.log)"
  say "up: test account ready (credentials in $ENV_FILE, never printed)"

  # The sikstack plugin's install Feedback lands in the test account's project sikstack: the API learns its id only
  # now, so it starts again with KB_INSTALL_FEEDBACK_PROJECT_ID set (the first group stopped by its recorded pgid).
  FEEDBACK_PROJECT=$(docker exec "$CONTAINER_ID" psql -U kb -d kb -tAc \
    "SELECT id FROM projects WHERE name = 'sikstack' ORDER BY created_at LIMIT 1" 2>>"$EV/run.log" | tr -d '[:space:]')
  [ -n "$FEEDBACK_PROJECT" ] || die "no project sikstack for the install Feedback (see $EV/run.log)"
  group_ours "$API_PID" && kill -TERM -- "-$API_PID" 2>/dev/null
  local i=0; while group_alive "$API_PID" && [ "$i" -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  group_alive "$API_PID" && die "the first API did not stop (pgid $API_PID)"
  api_start "$db" KB_INSTALL_FEEDBACK_PROJECT_ID="$FEEDBACK_PROJECT"
  say "up: api restarted with the install Feedback project (sikstack, $FEEDBACK_PROJECT)"

  # The design origin: each published build at the root of its own host (server.design_serve), its own group.
  set -m
  (cd "$REPO" && exec env -i "${BASE_ENV[@]}" DATABASE_URL="$db" KB_ROOT="$KB_ROOT_DIR" "${DESIGN_ENV[@]}" \
    nohup uv run uvicorn server.design_serve:app --host 127.0.0.1 --port "$DESIGN_PORT") </dev/null >>"$EV/design.log" 2>&1 &
  DESIGN_PID=$!; set +m; launched "$DESIGN_PID" || die "the design origin did not start (see $EV/design.log)"; write_state
  wait_http "http://127.0.0.1:$DESIGN_PORT/_healthz" 60 || die "the design origin's /_healthz did not answer (see $EV/design.log)"
  own_refresh
  say "up: design origin $DESIGN ok"

  local secret key
  secret=$(openssl rand -hex 32)
  key=$(sed -n 's/^SIKSTACK_FEEDBACK_CAPTURE_KEY=//p' "$ENV_FILE" | tr -d '"')
  set -m
  (cd "$REPO" && exec env -i "${BASE_ENV[@]}" KB_API_BASE_URL="http://127.0.0.1:$API_PORT" SESSION_SECRET="$secret" \
    NEXT_PUBLIC_APP_URL="http://$APP_HOST:$WEB_PORT" SIKSTACK_FEEDBACK_CAPTURE_KEY="$key" \
    nohup pnpm --dir web exec next dev -H 127.0.0.1 -p "$WEB_PORT") </dev/null >"$EV/web.log" 2>&1 &
  WEB_PID=$!; set +m; launched "$WEB_PID" || die "next dev did not start (see $EV/web.log)"; write_state
  wait_http "http://127.0.0.1:$WEB_PORT/login" 120 || die "web /login did not answer (see $EV/web.log)"
  own_refresh; UPPING=""
  say "up: web http://$APP_HOST:$WEB_PORT/login ok"
  say "up: ready. next: $0 signin; drive with playwright-cli -s=$SESSION <command>"
}

cli() { playwright-cli -s="$SESSION" "$@"; }

signin() {
  load_state
  [ -n "${WEB_PID:-}" ] || die "not up: run '$0 up' first"
  local auth="$EV/auth-state.json" email pw url
  printf '{"outputDir": "%s"}\n' "$EV/cli-output" >"$EV/cli.config.json"
  cli close >/dev/null 2>&1 || true # this home's own session only
  cli open "$WEB/login" --config="$EV/cli.config.json" >>"$EV/run.log" 2>&1 || die "playwright-cli open failed"
  if [ -f "$auth" ]; then
    cli state-load "$auth" >>"$EV/run.log" 2>&1
    cli goto "$WEB/dashboard" >>"$EV/run.log" 2>&1
    url=$(cli --raw eval "() => location.pathname" 2>/dev/null | tr -d '"')
    if [ "$url" = "/dashboard" ]; then say "signin: reused the saved sign-in ($auth), no new login"; return 0; fi
    say "signin: saved sign-in no longer valid; signing in again"
    cli goto "$WEB/login" >>"$EV/run.log" 2>&1
  fi
  email=$(sed -n 's/^SIKSTACK_DEV_TEST_EMAIL=//p' "$ENV_FILE" | tr -d '"')
  pw=$(sed -n 's/^SIKSTACK_DEV_TEST_PASSWORD=//p' "$ENV_FILE" | tr -d '"')
  [ -n "$email" ] && [ -n "$pw" ] || die "no test account in $ENV_FILE"
  cli fill 'role=textbox[name="Email"]' "$email" >>"$EV/run.log" 2>&1 || die "no Email field on /login"
  # The CLI echoes filled text and a snapshot shows a field's value: the password goes nowhere but the page.
  cli fill 'role=textbox[name="Password"]' "$pw" --submit >/dev/null 2>&1 || die "no Password field on /login"
  local i=0
  while [ "$i" -lt 20 ]; do
    url=$(cli --raw eval "() => location.pathname" 2>/dev/null | tr -d '"')
    [ "$url" = "/dashboard" ] && break
    sleep 1; i=$((i + 1))
  done
  [ "$url" = "/dashboard" ] || die "sign-in did not reach /dashboard (at '$url')"
  cli state-save "$auth" >>"$EV/run.log" 2>&1
  if grep -rqF -- "$pw" "$EV"; then die "the password reached $EV: delete that run folder"; fi
  say "signin: signed in as the local test account; saved $auth"
}

seed() { # publish one sample document into the scratch library through the API
  load_state
  [ -n "${API_PORT:-}" ] || die "not up: run '$0 up' first"
  env -i "${BASE_ENV[@]}" API="http://127.0.0.1:$API_PORT" ENV_FILE="$ENV_FILE" python3 - <<'PY' >>"$EV/run.log" 2>&1 || die "seed failed (see $EV/run.log)"
import json, os, urllib.error, urllib.request
api, env = os.environ["API"], {}
for line in open(os.environ["ENV_FILE"]):
    k, _, v = line.strip().partition("=")
    env[k] = v.strip('"')
def call(method, path, body=None, token=None):
    req = urllib.request.Request(api + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} answered {e.code}: {e.read().decode()[:400]}")
token = call("POST", "/auth/login", {"email": env["SIKSTACK_DEV_TEST_EMAIL"], "password": env["SIKSTACK_DEV_TEST_PASSWORD"]})["token"]
pid = next(p["id"] for p in call("GET", "/app/projects", token=token)["projects"] if p["name"] == "sikstack")
key = call("POST", f"/app/projects/{pid}/credentials", {"name": "verify seed", "scope": "full"}, token=token)["key"]
doc = call("POST", "/api/documents", {"title": "Verify sample document", "markdown": "# Verify sample document\n\nSeeded by the verify skill.\n",
           "project": "sikstack", "tags": ["verify", "sample"], "source_repo": "local", "commit": False}, token=key)
print("seed: published", doc.get("rel_path") or doc.get("id"))
PY
  say "seed: published 'Verify sample document' to project sikstack (scratch KB_ROOT, no git commit)"
}

expect() { # text...: wait up to 15 s for the page to show every text
  local t i
  for t in "$@"; do
    i=0
    until [ "$(cli --raw eval "() => document.body.innerText.includes($(printf '%s' "$t" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))'))" 2>/dev/null)" = "true" ]; do
      i=$((i + 1)); [ "$i" -gt 15 ] && { say "expect: '$t' not on $(cli --raw eval '() => location.href' 2>/dev/null)"; return 1; }
      sleep 1
    done
    say "expect: '$t' shown"
  done
}

feature() { # name: run the Drive block of features/<name>.md
  load_state
  local f="$SKILL_DIR/features/$1.md"
  [ -f "$f" ] || die "no feature file $f"
  [ -n "${WEB_PID:-}" ] || die "not up: run '$0 up' first"
  say "feature $1: running the Drive block of $f"
  awk '/^```bash drive$/{on=1;next} /^```$/{on=0} on' "$f" >"$EV/feature-$1.sh"
  if (export WEB EV SESSION RUN="$SKILL_DIR/run.sh"; cd "$EV" && bash -euo pipefail "$EV/feature-$1.sh") >>"$EV/feature-$1.log" 2>&1; then
    say "feature $1: PASS (log $EV/feature-$1.log, screenshot $EV/$1.png)"
  else
    say "feature $1: FAIL (log $EV/feature-$1.log)"; return 1
  fi
}

status() {
  load_state
  if [ ! -f "$STATE" ]; then say "status: nothing up in $HOME_DIR (no state.env)"; fi
  [ -n "${WEB:-}" ] && say "web      $WEB ($( [ -n "${WEB_PID:-}" ] && is_ours "$WEB_PID" && echo running || echo stopped))"
  [ -n "${API_PORT:-}" ] && say "api      http://127.0.0.1:$API_PORT ($( [ -n "${API_PID:-}" ] && is_ours "$API_PID" && echo running || echo stopped))"
  [ -n "${DESIGN:-}" ] && say "design   $DESIGN ($( [ -n "${DESIGN_PID:-}" ] && is_ours "$DESIGN_PID" && echo running || echo stopped))"
  say "postgres $(docker ps --filter "name=^/$CONTAINER\$" --format '{{.Names}} {{.Status}}' 2>/dev/null | grep . || echo "no $CONTAINER")"
  say "browser  $(playwright-cli list 2>/dev/null | grep -F "$SESSION" || echo "no $SESSION session") (drive: playwright-cli -s=$SESSION <command>)"
  [ -n "${EV:-}" ] && say "evidence $EV"
  say "repo     $(git -C "$REPO" status --porcelain | wc -l | tr -d ' ') changed path(s) in $REPO"
}

down() {
  if [ ! -f "$STATE" ]; then say "down: nothing recorded in $HOME_DIR (no state.env): nothing stopped"; return 0; fi
  load_state
  local pw g p who mine="" left="" still i
  pw=$(sed -n 's/^SIKSTACK_DEV_TEST_PASSWORD=//p' "${ENV_FILE:-/dev/null}" 2>/dev/null | tr -d '"')
  if [ -n "$pw" ] && [ -d "${EV:-}" ]; then
    grep -rqF -- "$pw" "$EV" && say "down: WARNING the test password appears under $EV" || say "down: password check: not found under $EV"
  fi
  playwright-cli -s="$SESSION" close >/dev/null 2>&1 || true # named after this home: no other run's session
  for g in $(owned_groups); do
    if group_ours "$g"; then mine="$mine $g"
    elif [ -n "$(proc_start "$g")" ] || group_alive "$g"; then say "down: process group $g is no longer the one up started: left alone"; fi
  done
  for g in $mine; do kill -TERM -- "-$g" 2>/dev/null; done
  # A group alive at every check since the TERM is still the same group: its id is not reused while it lives.
  left="$mine"; i=0
  while [ -n "$left" ] && [ "$i" -lt 20 ]; do
    sleep 0.5; i=$((i + 1))
    still=""; for g in $left; do group_alive "$g" && still="$still $g"; done; left="$still"
  done
  for g in $left; do kill -KILL -- "-$g" 2>/dev/null; done
  i=0; while [ -n "$left" ] && [ "$i" -lt 10 ]; do
    still=""; for g in $left; do group_alive "$g" && still="$still $g"; done; left="$still"
    [ -n "$left" ] && sleep 0.2; i=$((i + 1))
  done
  for p in ${WEB_PORT:-} ${API_PORT:-} ${DESIGN_PORT:-}; do
    who=$(who_listens "$p")
    [ -n "$who" ] && say "down: port $p is held by $who, not started by this run: left alone"
  done
  if [ -n "${CONTAINER_ID:-}" ]; then
    if [ "$(docker inspect -f "{{.Name}}|{{index .Config.Labels \"$LABEL\"}}" "$CONTAINER_ID" 2>/dev/null)" = "/$CONTAINER|$HOME_DIR" ]; then
      docker rm -fv "$CONTAINER_ID" >/dev/null 2>&1 && say "down: removed container $CONTAINER and its volume"
    else say "down: container $CONTAINER_ID is gone or not this home's: left alone"; fi
  fi
  rm -rf "$HOME_DIR/kb-root"; rm -f "$HOME_DIR/web.env" "$OWNED" "$STATE"
  say "down: stopped what this run started (process groups:${mine:- none}${left:+; still alive after KILL:$left}); browser session $SESSION closed${EV:+; evidence kept in $EV}"
}

case "${1:-}" in
  doctor) doctor ;;
  up) shift; up "$@" ;;
  signin) signin ;;
  seed) seed ;;
  expect) shift; load_state; expect "$@" ;;
  feature) shift; [ $# -ge 1 ] || die "usage: $0 feature <name>"; for n in "$@"; do feature "$n" || exit 1; done ;;
  status) status ;;
  down) down ;;
  *) echo "usage: $0 doctor | up [evidence-dir] | signin | seed | expect <text>... | feature <name>... | status | down"; exit 2 ;;
esac
