#!/usr/bin/env bash
# The sikstack plugin's smoke suite: the engine (scripts/), the Claude Code adapter (adapters/claude_code/), the
# hooks (hooks/), and the shipped skills, agents and contract, checked from the plugin's own folder.
#
# Every workspace here is made the way a user makes one: `sikstack init` in a scratch git repo under $TMPDIR, so
# its state is that repo's `.sikstack/` (its own git repo, nested in the repo). A test that names a workspace `$F`
# means that `.sikstack/` folder, run from inside it (the engine walks up to the nearest `.sikstack/`, which is
# itself); the product repo around it is `$F/..`. Test numbers follow the workspace suite this was ported from
# (bootstrap_agentic_workspace's tests/retrofit_smoke.sh at v102).
#
# Cut with the installer (sikstack ships no installer: the plugin is the install, `sikstack init` makes the state):
#   1-3 (retrofit, its idempotence, a foreign scripts/workflow.py), 4 (docs seeding over a docs system),
#   6-7 (dual-apply and the built installer), 8 (--with-explain), 15-16 (--nested installs and their --update),
#   12 (the at-root worktree: there is no at-root workspace any more; the nested worktree is 11, 14, 17 and 28),
#   and the install/--update/--to-multi-repo parts of 5, 17, 19, 23 and 25. Test 0's pins moved to
#   tests/static_pins.py, less the installer's own; Test 29 is new (the finder, init, the hooks, the shipped text), and
#   so are Test 30 (setup, the registration retry, the rules card), Test 31 (migrate from an old install), Test 32
#   (sign-in and feedback against the fake server), Test 33 (the design publish verbs against it) and
#   Test 34 (the cold set in cloud mode, run after Test 23) and Test 35 (the cold reads and `sikstack cold`, after 34),
#   Test 36 (the engine's agent behind the fake's Cloudflare gate, the 403 block reading and sign-in --release),
#   Test 37 (an edge block in every form: Cloudflare's JSON problem, a page echoing the key, sign-in's start and poll),
#   Test 38 (agenda-feedback: the linked project's feedback onto the agenda, against the fake's triage routes),
#   Test 39 (the design link of a local workspace, publishing from a phase's worktree, run after Test 33),
#   Test 40 (the engine stamp, works/engine.json: an older engine refuses to write, a newer one raises it) and
#   Test 41 (the Migration notes after an update: the session-start hook's block and the first write's).
#
# Usage:  bash plugins/sikstack/tests/smoke.sh        (alone in its shell call: never chained)
# Exit 0 if every check passes; non-zero otherwise. Re-runnable; self-cleaning.

set -u
export PYTHONDONTWRITEBYTECODE=1   # keep scratch repos free of __pycache__/

PLUGIN="${SMOKE_PLUGIN_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
REPO_ROOT="$PLUGIN"                       # the old suite's name for the source root
ENG="$PLUGIN/scripts/workflow.py"         # `sikstack`
ADP="$PLUGIN/adapters/claude_code/adapter.py"   # `sikstack-adapter`
SK="$PLUGIN/bin/sikstack"
SKA="$PLUGIN/bin/sikstack-adapter"
export PATH="$PLUGIN/bin:$PATH"   # the bare commands the engine prints (`sikstack ...`) run as printed
export ENG ADP PLUGIN
unset SIKSTACK_ROOT WORKFLOW_CMD
# A refused command's own line is what most tests read, so the friction offer the engine adds after it (one line naming
# /sikstack:feedback) is held off here, the way an engine run inside another holds it off; Test 29(g) lifts it and
# checks the offer itself.
export SIKSTACK_NO_OFFER=1

FAILS=0
TMPDIRS=()
cleanup() { for d in "${TMPDIRS[@]:-}"; do [ -n "${d:-}" ] && rm -rf "$d"; done; }
trap cleanup EXIT

ok()  { printf 'PASS: %s\n' "$1"; }
bad() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }
newtmp() { local _d; _d=$(mktemp -d); TMPDIRS+=("$_d"); printf -v "$1" '%s' "$_d"; }
sha_stdin() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  else sha256sum | awk '{print $1}'; fi
}
sha() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
engine_src() { cat "$PLUGIN"/scripts/*.py; }
# The adapter owns route, meter and compact-resume; a wrapper that runs both picks the entry by the first word.
wf_entry() { case "$1" in route|meter|compact-resume) printf '%s' "$ADP" ;; *) printf '%s' "$ENG" ;; esac; }
# git reads one scratch global config here: an identity (CI has none), `main` as the first branch, no user hooks.
newtmp GITHOME
printf '[user]\n\temail = smoke@example.invalid\n\tname = smoke\n[init]\n\tdefaultBranch = main\n' > "$GITHOME/gitconfig"
export GIT_CONFIG_GLOBAL="$GITHOME/gitconfig" GIT_CONFIG_NOSYSTEM=1
# mkhost <dir>: a scratch product repo at <dir> (one empty commit) with its workspace made by `sikstack init`.
mkhost() {
  mkdir -p "$1" && git -C "$1" init -q \
    && { git -C "$1" rev-parse -q --verify HEAD >/dev/null || git -C "$1" commit -q --allow-empty -m "chore: start"; } \
    && ( cd "$1" && python3 "$ENG" init >/dev/null )
}
# mkws <var>: a workspace for a test that once ran on an at-root install. The variable names a folder to make
# (or an empty one); the repo goes there and the variable is set to its `.sikstack/`, the state folder.
mkws() { local _h="${!1}"; mkhost "$_h" || return 1; printf -v "$1" '%s' "$_h/.sikstack"; }
# set_link <.sikstack> <server>: write the cloud link the way `link` does, as config.toml's [cloud] table (replacing one).
set_link() { python3 - "$1/config.toml" "$2" <<'PY'
import re, sys
path, server = sys.argv[1:]
text = re.sub(r"\n*\[cloud\]\n(?:[^\[\n][^\n]*\n|\n)*", "\n", open(path).read()).rstrip("\n") + "\n"
open(path, "w").write(text + f'\n[cloud]\nschema = 1\nserver = "{server}"\norg_id = "org-1"\nproject_id = "proj-1"\nlinked_at = "2026-11-18T00:00:00Z"\n')
PY
}

command -v git >/dev/null 2>&1 || { echo "git is required to run this smoke test"; exit 2; }

# ---------------------------------------------------------------------------
echo "== Test 0: the shipped text pins -- tests/static_pins.py over the plugin's skills, agents, contract, templates and engine source, every failing pin reported =="
t0_out=$(python3 - "$PLUGIN/tests/static_pins.py" "$PLUGIN" <<'PY' 2>&1
import ast, sys
path, plugin = sys.argv[1], sys.argv[2]
src = open(path, encoding="utf-8").read()
ns = {"__name__": "static_pins"}
sys.argv = [path, plugin]
fails = 0
for node in ast.parse(src).body:
    try:
        exec(compile(ast.Module(body=[node], type_ignores=[]), path, "exec"), ns)
    except Exception as e:  # one line per failing statement: where, what, the first line of the statement
        fails += 1
        first = (ast.get_source_segment(src, node) or "").split("\n")[0][:120]
        print(f"static_pins.py:{node.lineno}: {type(e).__name__}: {str(e)[:200]} :: {first}")
print(f"statements={len(ast.parse(src).body)} failed={fails}")
sys.exit(1 if fails else 0)
PY
); t0_rc=$?
if [ "$t0_rc" = 0 ]; then ok "the plugin's text pins hold ($(printf '%s\n' "$t0_out" | tail -1)): 16 skills and their invocation metadata, the skill directories (cores of 8,192 B or less, every named reference shipped), the playbooks, agents and contract wording, the contract's 4,096 B cap"
else printf '%s\n' "$t0_out"; bad "a shipped text pin failed (lines above)"; fi

# ---------------------------------------------------------------------------
echo "== Test 5: a fresh workspace (sikstack init): it validates, seeds no phase, and the gate, the kinds, rotate, archive, the route table, the meter, --help, the resume card and the typed stop hold =="
newtmp F
mkws F >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && ok "sikstack init makes a workspace (exit 0)" || bad "sikstack init exit=$rc"
( cd "$F" && python3 "$ENG" check --no-rebuild >/dev/null 2>&1 ) && ok "fresh workspace validates" || bad "fresh workspace failed validate"
nphf=$(find "$F/works/phases/active" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
[ "$nphf" = "0" ] && ok "fresh install seeds no phases (empty start)" || bad "fresh install seeded $nphf phase(s)"
seed_er=$(cd "$F" && python3 "$ADP" route 2>&1)
printf '%s\n' "$seed_er" | grep -qE '^mid +sikstack:slice-executor +opus +medium +default$' && ! printf '%s\n' "$seed_er" | grep -q '^cheap ' \
  && ! printf '%s\n' "$seed_er" | grep -q '^override=' \
  && ok "a fresh install has no cheap row (v83) and its mid row is opus@medium, with no override= line" || bad "a fresh install's route table or override lines wrong: $seed_er"
# v32 operator acceptance gate, probed once against a real engine (throwaway workspace).
( cd "$F" && python3 "$ENG" phase new --phase P1 --name "Gate probe" --objective "probe the gate" >/dev/null 2>&1 ) \
  && grep -q '"acceptance"' "$F/works/phases/active/P1/phase.json" && ok "phase new stamps the acceptance gate block" || bad "phase new did not stamp the acceptance block"
( cd "$F" && python3 "$ENG" review P1 --verdict pass 2>&1 | grep -q 'gate P1 require' ) \
  && ok "review --verdict pass refuses an undeclared acceptance gate" || bad "an undeclared acceptance gate did not refuse the pass"
( cd "$F" && python3 "$ENG" gate P1 waive >/dev/null 2>&1 ) && bad "gate waive should require --note" || ok "gate waive without --note is rejected"
# The v34 kind set, probed against the same throwaway engine. slice new makes an unknown kind with one
# advice: line naming the set (exit 0); validate() only WARNS of it.
uk=$( cd "$F" && python3 "$ENG" slice new --phase P1 --slice P1.S9 --name "typo" --kind cowork 2>&1 ); uk_rc=$?
[ "$uk_rc" -eq 0 ] && [ -d "$F/works/phases/active/P1/slices/P1.S9" ] \
  && [ "$(printf '%s\n' "$uk" | grep -c '^advice: kind cowork is not one of co-work, decomposition, docs, fix, implementation, qa, research, review; it routes on the high row$')" -eq 1 ] \
  && ok "slice new makes an unknown --kind with one advice: line naming the set, research included (exit 0)" || bad "slice new on an unknown --kind (rc $uk_rc) -- $uk"
rm -r "$F/works/phases/active/P1/slices/P1.S9" && ( cd "$F" && python3 "$ENG" check >/dev/null 2>&1 )
# 0.3.0 retired deferred jobs: defer-job, deferred, promote-deferred and drop-deferred each refuse in one line,
# exit 1, naming the agenda's way, and write nothing (here with the old verbs' own arguments).
rv_tree() { ( cd "$F" && find works -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
rv_t0=$(rv_tree); rv_bad=""
for rv_cmd in "defer-job --title x --reason r --trigger t --source manual" "deferred" "promote-deferred D1 --phase P8 --slice P8.S1 --create-phase" "drop-deferred D1 --reason x"; do
  rv=$( cd "$F" && python3 "$ENG" $rv_cmd 2>&1 ); rv_rc=$?; rv_v=${rv_cmd%% *}  # shellcheck disable=SC2086
  { [ "$rv_rc" -eq 1 ] && [ "$(printf '%s\n' "$rv" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$rv" | grep -qE "^sikstack $rv_v is retired \(deferred jobs are agenda items now, since 0\.3\.0\): .*agenda"; } || rv_bad="$rv_bad [$rv_v rc=$rv_rc: $rv]"
done
[ -z "$rv_bad" ] && [ "$rv_t0" = "$(rv_tree)" ] && [ ! -d "$F/works/phases/active/P8" ] \
  && ok "defer-job, deferred, promote-deferred and drop-deferred each refuse in one line, exit 1, pointing at the agenda; nothing written" \
  || bad "a retired deferred verb is not a one-line refusal --$rv_bad"
( cd "$F" && python3 "$ENG" slice new --phase P1 --slice P1.S1 --name "design round" --kind co-work >/dev/null 2>&1 ) \
  && ok "slice new accepts --kind co-work (absent from history, present in the set)" || bad "slice new rejected --kind co-work"
# v36 research kind: in the set (the advice above names it) and creatable.
( cd "$F" && python3 "$ENG" slice new --phase P1 --slice P1.S2 --name "learn first" --kind research --risk high >/dev/null 2>&1 ) \
  && grep -q '"kind": "research"' "$F/works/phases/active/P1/slices/P1.S2/slice.json" \
  && ok "slice new accepts --kind research (v36, findings-only, always the high tier)" || bad "slice new rejected --kind research"
# Doc consolidation is retired: a passing review stamps no debt, and a phase.json still carrying an older
# install's `consolidation: "pending"` is ignored -- validate passes,
# next names no debt, and the phase archives like any other.
( cd "$F" && python3 "$ENG" phase new --phase P2 --name "Old debt probe" --objective "probe" >/dev/null 2>&1 \
  && python3 "$ENG" gate P2 waive --note "probe" >/dev/null 2>&1 \
  && python3 "$ENG" slice status P2.DECOMP done >/dev/null 2>&1 \
  && python3 "$ENG" slice status P2.REVIEW done >/dev/null 2>&1 \
  && python3 "$ENG" review P2 --verdict pass >/dev/null 2>&1 ) || bad "old-debt probe: could not pass P2"
! grep -q '"consolidation"' "$F/works/phases/active/P2/phase.json" \
  && ok "a passing review stamps no doc-consolidation debt" || bad "the passing review stamped a consolidation field"
python3 - "$F/works/phases/active/P2/phase.json" <<'PY2'
import json, sys
p = sys.argv[1]
d = json.load(open(p)); d["consolidation"] = "pending"; d["consolidates"] = ["P1"]
json.dump(d, open(p, "w"), indent=2)
PY2
old_next=$( cd "$F" && python3 "$ENG" next 2>&1 ); old_val=$( cd "$F" && python3 "$ENG" check --no-rebuild 2>&1 ); old_rc=$?
[ "$old_rc" -eq 0 ] && ! printf '%s\n%s\n' "$old_next" "$old_val" | grep -q "consolidation\|stale_docs\|oversized_doc_sections" \
  && ok "an older install's consolidation fields are ignored: validate passes and neither next nor validate names a debt" \
  || bad "the retired consolidation fields were read (rc=$old_rc): $old_val"
# phase rotate (v54; the docs-phase branches retired with the debt): rotate=archive is its one result off a
# parallel stream, archiving every cleanly archivable phase and leaving the open ones. Probed on a copy.
newtmp ROT; cp -R "$F/../." "$ROT/"; ROT="$ROT/.sikstack"
rot_out=$( cd "$ROT" && python3 "$ENG" phase rotate 2>&1 ); rot_rc=$?
[ "$rot_rc" -eq 0 ] && [ "$(printf '%s\n' "$rot_out" | head -1)" = "rotate=archive" ] && printf '%s\n' "$rot_out" | grep -q "^rotated 1 done phase(s) to archived:" \
  && [ ! -d "$ROT/works/phases/active/P2" ] && [ -d "$ROT/works/phases/active/P1" ] \
  && ( cd "$ROT" && python3 "$ENG" check --no-rebuild >/dev/null 2>&1 ) \
  && ok "phase rotate prints rotate=archive and archives the done phase (its old consolidation stamp ignored), leaving the open one" \
  || bad "phase rotate did not archive the done phase with rotate=archive (rc=$rot_rc): $rot_out"
( cd "$ROT" && python3 "$ENG" phase rotate --archive-only 2>&1 | grep -q "^rotate=" ) \
  && bad "phase rotate --archive-only printed a rotate= line" \
  || ok "phase rotate --archive-only prints no rotate= line"
( cd "$F" && python3 "$ENG" phase archive P2 >/dev/null 2>&1 ) && [ ! -d "$F/works/phases/active/P2" ] \
  && ok "phase archive archives a phase carrying an older install's consolidation stamp" || bad "phase archive held a phase on a retired consolidation stamp"
# The fixture becomes a git repo here; the later dashboard test re-inits it harmlessly.
( cd "$F" && git init -q . >/dev/null 2>&1 && git add -A >/dev/null 2>&1 \
    && git -c user.email=smoke@example.invalid -c user.name=smoke commit -qm "fixture baseline" >/dev/null 2>&1 ) \
  || bad "could not make the fixture a git repo"
python3 - "$F/works/phases/active/P1/slices/P1.S1/slice.json" <<'PY2'
import json, sys
p = sys.argv[1]
d = json.load(open(p)); d["kind"] = "invented-by-an-adopter"
json.dump(d, open(p, "w"), indent=2)
PY2
kind_out=$( cd "$F" && python3 "$ENG" check --no-rebuild 2>&1 ); kind_rc=$?
printf '%s\n' "$kind_out" | grep -q "unknown kind 'invented-by-an-adopter'" && [ "$kind_rc" -eq 0 ] \
  && ok "validate warns on an unknown kind and still exits 0 (adopting history survives)" \
  || bad "validate did not warn exit-code-neutrally on an unknown kind (rc=$kind_rc)"
python3 - "$F/works/phases/active/P1/slices/P1.S1/slice.json" <<'PY2'
import json, sys
p = sys.argv[1]
d = json.load(open(p)); d["kind"] = "co-work"
json.dump(d, open(p, "w"), indent=2)
PY2
# v53 route table: .sikstack/config.toml's [claude.<row>] tables override the adapter's rows key by key, and route prints
# the routing decision, writing nothing (sync-agents retired with the installer: every row is passed per dispatch). Its
# probes unset the environment variables it reads, so a run inside an ocx session (a loopback ANTHROPIC_BASE_URL) or on
# Bedrock still sees the plain table.
erenv() { env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY -u ANTHROPIC_DEFAULT_HAIKU_MODEL "$@"; }
er() { ( cd "$F" && erenv python3 "$ADP" route "$@" 2>&1 ); }
printf '[claude.high]\nmodel = "fable"\n' > "$F/config.toml"; er_out=$(er P1.DECOMP)
printf '%s\n' "$er_out" | grep -qx 'model=fable' && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:slice-executor' \
  && grep -q "^model: opus$" "$PLUGIN/agents/slice-executor.md" \
  && ok "a [claude.high] alias override shows in route and touches no agent file (the row is passed per dispatch)" \
  || bad "a [claude.high] override is missing from route, or an agent file changed: $er_out"
printf '[claude.high]\nmodel = "claude-opus-5-5"\n' > "$F/config.toml"
hi_out=$( cd "$F" && python3 "$ADP" route 2>&1 ); hi_rc=$?
[ "$hi_rc" -ne 0 ] && printf '%s\n' "$hi_out" | grep -q 'must be an Agent-tool alias' \
  && ok "a full model id on any row is refused (every row is passed per dispatch, so an alias only)" || bad "[claude.high] full id not refused (rc=$hi_rc): $hi_out"
printf '[notes]\nserver = "https://example.invalid"\n\n[claude.mid]\nmodel = "sonnet"\n' > "$F/config.toml"; er_out=$(er)
printf '%s\n' "$er_out" | grep -qE '^mid +sikstack:slice-executor +sonnet +medium +model config.toml / effort default$' \
  && ok "config.toml's other tables are skipped whole; its [claude.mid] row is read" || bad "a foreign table in config.toml broke route: $er_out"
printf 'mode = "flex"\n' > "$F/config.toml"
mode_out=$( cd "$F" && python3 "$ADP" route 2>&1 ); mode_rc=$?
[ "$mode_rc" -ne 0 ] && printf '%s\n' "$mode_out" | grep -q 'retired in workspace v53' \
  && ok "a leftover mode = line is refused with the v53 migration message" || bad "mode = \"flex\" was not refused with the v53 migration (rc=$mode_rc): $mode_out"
printf '[claude.low]\nmodel = "sonnet"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'retired in workspace v23' ) && ok "retired [claude.low] section rejected with a migration message" || bad "[claude.low] should be rejected as a retired tier"
printf '[codex.high]\nmodel = "gpt-5.6-sol"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'removed in workspace v31' ) && ok "leftover [codex.*] section rejected with the v31 migration message" || bad "[codex.*] should be rejected as removed support"
printf '[claude.cheap]\nmodel = "haiku"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'the cheap row was retired in workspace v83' ) \
  && ok "a leftover [claude.cheap] is refused with the v83 migration message" || bad "[claude.cheap] should be rejected as a retired row"
printf '[claude.research]\nmodel = "claude-opus-5-5"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'must be an Agent-tool alias' ) \
  && ok "a full model id on the research row is refused (it runs a file the mid row owns, so an alias only)" || bad "[claude.research] accepted a full model id"
printf '[claude.research]\neffort = "hgih"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'effort must be one of' ) \
  && ok "an effort outside the Agent tool's levels is refused" || bad "[claude.research] accepted an unknown effort"
printf '[claude.nope]\nmodel = "opus"\n' > "$F/config.toml"
( cd "$F" && python3 "$ADP" route 2>&1 | grep -q 'unknown route' ) \
  && ok "an unknown [claude.<row>] is refused" || bad "[claude.nope] was accepted"
rm -f "$F/config.toml"
er_out=$(er)
[ "$(printf '%s\n' "$er_out" | grep -cE '^(high|research|design|critic|mid|explore) ')" = "6" ] && ! printf '%s\n' "$er_out" | grep -qE '^(cheap|judge) ' && printf '%s\n' "$er_out" | grep -qx 'proxy=none' \
  && printf '%s\n' "$er_out" | grep -qE '^route +agent +model +effort +source$' \
  && printf '%s\n' "$er_out" | grep -qE '^design +sikstack:design-drafter +fable +high +default$' \
  && printf '%s\n' "$er_out" | grep -qE '^critic +sikstack:design-critic +opus +high +default$' \
  && printf '%s\n' "$er_out" | grep -qE '^high +sikstack:slice-executor +opus +high +default$' && printf '%s\n' "$er_out" | grep -qE '^research +sikstack:slice-executor +opus +high +default$' \
  && printf '%s\n' "$er_out" | grep -qE '^mid +sikstack:slice-executor +opus +medium +default$' \
  && printf '%s\n' "$er_out" | grep -qE '^explore +sikstack:Explore +haiku +xhigh +default$' \
  && ! printf '%s\n' "$er_out" | grep -q '^warning=fairness' && ! printf '%s\n' "$er_out" | grep -q 'tier' && ! printf '%s\n' "$er_out" | grep -q '^fallback=' \
  && ok "route (bare) prints the seven-row route table with its agent column, no tier and no cheap row (v80 defaults: every opus row @high, mid opus@medium, explore haiku@xhigh; v83) and proxy=none" || bad "route bare table wrong: $er_out"
er_out=$(er P1.DECOMP)
printf '%s\n' "$er_out" | grep -qx 'route=high' && ! printf '%s\n' "$er_out" | grep -q '^tier=' \
  && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:slice-executor' && printf '%s\n' "$er_out" | grep -qx 'model=opus' \
  && printf '%s\n' "$er_out" | grep -qx 'effort=high' && printf '%s\n' "$er_out" | grep -qx 'attribution=Claude Opus 5.5' \
  && ok "route sends a decomposition slice to the high row (slice-executor, opus@high, Claude Opus 5.5, no tier= line)" || bad "route P1.DECOMP wrong: $er_out"
er_out=$(er P1.S2)
printf '%s\n' "$er_out" | grep -qx 'route=research' && printf '%s\n' "$er_out" | grep -qx 'effort=high' \
  && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:slice-executor' \
  && ok "route sends a research slice to the research row (slice-executor, opus@high)" || bad "route research slice wrong: $er_out"
( cd "$F" && python3 "$ENG" slice new --phase P1 --slice P1.S9 --name "docs probe" --kind docs --risk low >/dev/null 2>&1 ) \
  || bad "route probe: slice new P1.S9 (docs, low) failed"
er_out=$(er P1.S9)
printf '%s\n' "$er_out" | grep -qx 'route=mid' && printf '%s\n' "$er_out" | grep -qx 'reason=kind docs rated low' && ! printf '%s\n' "$er_out" | grep -q '^tier=' \
  && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:slice-executor' && printf '%s\n' "$er_out" | grep -qx 'model=opus' \
  && printf '%s\n' "$er_out" | grep -qx 'effort=medium' && printf '%s\n' "$er_out" | grep -qx 'attribution=Claude Opus 5.5' && ! printf '%s\n' "$er_out" | grep -q '^fallback=' \
  && ok "a low docs slice runs on the mid row, opus@medium (v83: no Haiku slice row)" || bad "route low docs slice wrong: $er_out"
er_out=$( cd "$F" && erenv CLAUDE_CODE_USE_BEDROCK=1 python3 "$ADP" route P1.S9 2>&1 )
er_x=$( cd "$F" && erenv CLAUDE_CODE_USE_FOUNDRY=1 python3 "$ADP" route --explore 2>&1 )
printf '%s\n' "$er_out" | grep -qx 'model=opus' && ! printf '%s\n' "$er_out" | grep -q '^fallback=' \
  && printf '%s\n' "$er_x" | grep -qx 'model=haiku' && ! printf '%s\n' "$er_x" | grep -q '^fallback=' \
  && ok "on Bedrock and Foundry nothing falls back: a low docs slice stays on the mid row and explore keeps haiku" || bad "platform fallback wrong: $er_out / $er_x"
er_out=$(er P1.S9 --retry)
printf '%s\n' "$er_out" | grep -qx 'route=high' && printf '%s\n' "$er_out" | grep -qx 'attempt=2' && printf '%s\n' "$er_out" | grep -qx 'reason=second attempt' \
  && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:slice-executor' && printf '%s\n' "$er_out" | grep -qx 'model=opus' \
  && ok "route --retry sends a second attempt to the high row (the same slice-executor, on opus)" || bad "route --retry wrong: $er_out"
printf '[claude.mid]\nmodel = "sonnet"\neffort = "high"\n' > "$F/config.toml"
er_out=$(er P1.S9)
printf '%s\n' "$er_out" | grep -qx 'model=sonnet' && printf '%s\n' "$er_out" | grep -qx 'attribution=Claude Sonnet 5.5' \
  && ok "a [claude.mid] override carries a low docs slice with it (sonnet, attributed to Claude Sonnet 5.5)" || bad "route mid override on a docs slice wrong: $er_out"
er_out=$( cd "$F" && env -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE ANTHROPIC_BASE_URL=http://127.0.0.1:10100 python3 "$ADP" route P1.S9 2>&1 )
printf '%s\n' "$er_out" | grep -qx 'model=sonnet' && ! printf '%s\n' "$er_out" | grep -q '^fallback=' \
  && ok "behind a loopback ANTHROPIC_BASE_URL (ocx/Kiro) a slice row never falls back" || bad "route proxy moved a slice row: $er_out"
er_out=$(er)
printf '%s\n' "$er_out" | grep -qx 'override=mid sonnet@high (default opus@medium)' && [ "$(printf '%s\n' "$er_out" | grep -c '^override=')" = "1" ] \
  && ok "the bare table prints an override= line for the row executors.toml pins, beside its default" || bad "route override= line wrong: $er_out"
printf '[claude.mid]\nmodel = "opus"\neffort = "medium"\n' > "$F/config.toml"
er_out=$(er)
printf '%s\n' "$er_out" | grep -q '^override=mid opus@medium same as the default ' \
  && ok "a row set to its default prints override=... same as the default" || bad "route same-as-default override wrong: $er_out"
er_out=$( cd "$F" && env -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE ANTHROPIC_BASE_URL=http://127.0.0.1:10100 python3 "$ADP" route --explore 2>&1 )
printf '%s\n' "$er_out" | grep -qx 'model=sonnet' && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:Explore' \
  && ok "behind the same proxy route --explore falls back to sonnet" || bad "route --explore proxy fallback wrong: $er_out"
er_out=$(er --drafter)
printf '%s\n' "$er_out" | grep -qx 'agent=design-drafter' && printf '%s\n' "$er_out" | grep -qx 'route=design' \
  && ! printf '%s\n' "$er_out" | grep -q '^tier=' && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:design-drafter' \
  && printf '%s\n' "$er_out" | grep -qx 'model=fable' && printf '%s\n' "$er_out" | grep -qx 'effort=high' \
  && ok "route --drafter names design-drafter on its own design row (no tier= line, fable@high)" || bad "route --drafter wrong: $er_out"
# v96: a phase's `Drafter:` line under intent.md's ## Design Style picks the drafter's model at the design row's
# effort; no line is the design row; behind a loopback proxy (no Fable) a Fable drafter falls back to opus.
cp "$F/works/phases/active/P1/intent.md" "$F/intent.bak"
er_out=$(er --drafter --phase P1)
printf '%s\n' "$er_out" | grep -qx 'model=fable' && printf '%s\n' "$er_out" | grep -qx 'drafter_source=design row' \
  && ok "route --drafter --phase on a phase naming no drafter is the design row (fable)" || bad "route --drafter --phase default wrong: $er_out"
printf '\n## Design Style\n\nbuild-after: one flow.\nMockup: on request\nDrafter: opus\n' >> "$F/works/phases/active/P1/intent.md"
er_out=$(er --drafter --phase P1)
printf '%s\n' "$er_out" | grep -qx 'model=opus' && printf '%s\n' "$er_out" | grep -qx 'drafter_source=phase P1 Drafter: opus' \
  && ok "a phase's Drafter: opus keeps Opus against the Fable default" || bad "route --drafter --phase opus wrong: $er_out"
cp "$F/intent.bak" "$F/works/phases/active/P1/intent.md"
printf '\n## Design Style\n\nbuild-after: one flow.\nMockup: on request\nDrafter: fable\n' >> "$F/works/phases/active/P1/intent.md"
er_out=$(er --drafter --phase P1)
printf '%s\n' "$er_out" | grep -qx 'model=fable' && printf '%s\n' "$er_out" | grep -qx 'effort=high' \
  && printf '%s\n' "$er_out" | grep -qx 'attribution=Claude Fable 5.2' && printf '%s\n' "$er_out" | grep -qx 'drafter_source=phase P1 Drafter: fable' \
  && ok "a phase's Drafter: fable dispatches the drafter on fable at the design row's effort" || bad "route --drafter --phase fable wrong: $er_out"
er_out=$( cd "$F" && env -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE ANTHROPIC_BASE_URL=http://127.0.0.1:10100 python3 "$ADP" route --drafter --phase P1 2>&1 )
printf '%s\n' "$er_out" | grep -qx 'model=opus' && printf '%s\n' "$er_out" | grep -q '^fallback=design model fable -> opus ' \
  && ok "behind a loopback proxy a Fable drafter falls back to opus" || bad "route --drafter proxy fallback wrong: $er_out"
er_c=$(er --critic --phase P1); er_crc=$?
[ "$er_crc" -ne 0 ] && printf '%s\n' "$er_c" | grep -q 'goes with --drafter only' \
  && ok "--phase without --drafter is refused" || bad "route --critic --phase not refused (rc=$er_crc): $er_c"
sed 's/^Drafter: fable$/**Drafter:** fable/' "$F/works/phases/active/P1/intent.md" > "$F/intent.tmp" && mv "$F/intent.tmp" "$F/works/phases/active/P1/intent.md"
er_out=$(er --drafter --phase P1)
printf '%s\n' "$er_out" | grep -qx 'model=fable' \
  && ok "a bold **Drafter:** label is read, never dropped for its form" || bad "route --drafter dropped a bold Drafter: line: $er_out"
sed 's/^\*\*Drafter:\*\* fable$/Drafter: haiku/' "$F/works/phases/active/P1/intent.md" > "$F/intent.tmp" && mv "$F/intent.tmp" "$F/works/phases/active/P1/intent.md"
er_out=$(er --drafter --phase P1); er_rc=$?
[ "$er_rc" -ne 0 ] && printf '%s\n' "$er_out" | grep -q "names the drafter 'haiku'" \
  && ok "a Drafter: other than fable or opus is refused" || bad "route --drafter accepted Drafter: haiku (rc=$er_rc): $er_out"
{ cat "$F/intent.bak"; printf '\n### Design style notes\n\nfrom the brief.\n\n## Design Style\n\nDrafter: fable\n'; } > "$F/works/phases/active/P1/intent.md"
er_out=$(er --drafter --phase P1)
printf '%s\n' "$er_out" | grep -qx 'model=fable' \
  && ok "an earlier '### Design style' subsection never hides the real section's Drafter: line" || bad "route --drafter lost the real Design Style section: $er_out"
mv "$F/intent.bak" "$F/works/phases/active/P1/intent.md"
# P36.S5B, v75: the critic runs design-critic and may share the drafter's model. 2.0.0 retired the judge row:
# --judge is gone, and a [claude.judge] table left in config.toml is a warning= line, never an error.
er_out=$(er --critic); er_j=$( cd "$F" && python3 "$ADP" route --judge 2>&1 ); er_jrc=$?
printf '%s\n' "$er_out" | grep -qx 'route=critic' && printf '%s\n' "$er_out" | grep -qx 'subagent_type=sikstack:design-critic' \
  && printf '%s\n' "$er_out" | grep -qx 'model=opus' && printf '%s\n' "$er_out" | grep -qx 'effort=high' \
  && [ "$er_jrc" = 2 ] && printf '%s\n' "$er_j" | grep -q 'unrecognized arguments: --judge' \
  && ok "route --critic (opus@high) dispatches design-critic; route --judge is gone (usage error)" || bad "route --critic/--judge wrong: $er_out / $er_j"
printf '[claude.critic]\nmodel = "opus"\neffort = "xhigh"\n' > "$F/config.toml"
er_out=$( cd "$F" && env -u ANTHROPIC_BASE_URL python3 "$ADP" route --critic 2>&1 ); er_rc=$?
[ "$er_rc" -eq 0 ] && printf '%s\n' "$er_out" | grep -qx 'model=opus' \
  && ! printf '%s\n' "$(er)" | grep -q '^warning=fairness' \
  && ok "a critic on the drafter's model is accepted (exit 0, model=opus) and the bare table does not warn (v75)" || bad "the critic on the drafter's model was refused or warned (rc=$er_rc): $er_out"
printf '[claude.judge]\nmodel = "fable"\neffort = "high"\n[claude.mid]\neffort = "high"\n' > "$F/config.toml"
er_out=$( cd "$F" && env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE python3 "$ADP" route 2>&1 ); er_rc=$?
er_s=$( cd "$F" && env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_EFFORT_LEVEL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE python3 "$ADP" route P1.DECOMP 2>&1 ); er_src=$?
[ "$er_rc" -eq 0 ] && [ "$er_src" -eq 0 ] && printf '%s\n' "$er_out" | grep -q '^warning=config.toml line 1: the \[claude.judge\] row retired in sikstack 2.0.0' \
  && printf '%s\n' "$er_out" | grep -qE '^mid +sikstack:slice-executor +opus +high ' && ! printf '%s\n' "$er_out" | grep -q '^judge ' \
  && printf '%s\n' "$er_s" | grep -q '^warning=config.toml line 1: the \[claude.judge\]' \
  && ok "a [claude.judge] table left in config.toml is a warning= line (exit 0), skipped, and the rows after it still read" || bad "a [claude.judge] table was refused or silent (rc=$er_rc/$er_src): $er_out / $er_s"
rm -f "$F/config.toml"
( cd "$F" && env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_SUBAGENT_MODEL_FORCE CLAUDE_CODE_EFFORT_LEVEL=high python3 "$ADP" route P1.DECOMP 2>&1 | grep -q '^warning=CLAUDE_CODE_EFFORT_LEVEL' ) \
  && ok "route warns that CLAUDE_CODE_EFFORT_LEVEL outranks every per-dispatch effort" || bad "route did not warn on CLAUDE_CODE_EFFORT_LEVEL"
cp "$PLUGIN/templates/config.toml" "$F/config.toml"
er_out=$(er)
printf '%s\n' "$er_out" | grep -qE '^mid +sikstack:slice-executor +opus +medium +default$' && ! printf '%s\n' "$er_out" | grep -q '^agent files' \
  && ! printf '%s\n' "$er_out" | grep -q '^override=' \
  && ok "the shipped config.toml seed sets no row: the defaults, no override= line" || bad "route on the shipped config.toml seed wrong: $er_out"
( cd "$F" && python3 "$ENG" executor-mode 2>&1 | grep -q 'invalid choice' ) \
  && ok "executor-mode is gone from the engine (v53: route replaces it)" || bad "the engine still accepts executor-mode"
# v61 transcript meter (P37.S2), the adapter's `meter` since the thin engine: it meters the main thread and the
# spans from Claude Code's transcripts -- one request per message id with its largest output, spans attributed by
# their `slice:` line, list-priced (an unknown model never guessed), a span ending on a usage limit is `limit` --
# and reads each slice's verdict from its result.md (the status: line) or slice.json. record-dispatch is retired.
rd() { ( cd "$F" && CLAUDE_CONFIG_DIR="$F/.no-claude-config" python3 "$(wf_entry "$1")" "$@" 2>&1 ); }
( cd "$F" && python3 "$ADP" record-dispatch P1.DECOMP --verdict done >/dev/null 2>&1 ); rc1=$?
( cd "$F" && python3 "$ENG" record-dispatch P1.DECOMP --verdict done >/dev/null 2>&1 ); rc2=$?
[ "$rc1" -eq 2 ] && [ "$rc2" -eq 2 ] && ok "record-dispatch is retired: the adapter and the engine both exit 2" || bad "record-dispatch still runs (adapter rc=$rc1, engine rc=$rc2)"
printf -- '- status: escalate\n- summary: probe\n' > "$F/works/phases/active/P1/slices/P1.DECOMP/result.md"
ds_out=$(rd meter --phase P1); ds_rc=$?; ds_one=$(rd meter --slice P1.DECOMP)
rm -f "$F/works/phases/active/P1/slices/P1.DECOMP/result.md"
[ "$ds_rc" -eq 0 ] && printf '%s\n' "$ds_out" | grep -q '^transcripts=none found under ' && printf '%s\n' "$ds_out" | grep -qE '^decomposition +1 +0 +1 +0 +0 +0$' \
  && printf '%s\n' "$ds_one" | grep -qx 'slice=P1.DECOMP kind=decomposition verdict=escalate source=result.md' \
  && ok "meter with no transcripts: one line, then each slice's verdict read from its result.md status: line" || bad "meter without transcripts wrong (rc=$ds_rc): $ds_out / $ds_one"
rd meter --phase P7 >/dev/null; rc1=$?
[ "$rc1" -eq 1 ] && ok "meter --phase: an unknown phase exits 1" || bad "meter --phase P7 rc=$rc1"
newtmp MT
cp -R "$F/.." "$MT/host" && ln -s host/.sikstack "$MT/ws"
( cd "$MT/ws" && python3 "$ENG" slice new --phase P1 --slice P1.S7 --name "meter probe" --kind implementation --risk low >/dev/null 2>&1 )
python3 - "$MT" <<'PY'
import json, os, sys
mt = sys.argv[1]
ev = os.path.join(mt, "ws", "works", "events.jsonl")
with open(ev, "a") as f:
    for ts, old, new in (("2026-01-01T10:00:00+00:00", "todo", "in_progress"), ("2026-01-01T11:00:00+00:00", "in_progress", "done")):
        f.write(json.dumps({"ts": ts, "type": "slice_status_changed", "slice": "P1.S7", "old_status": old, "new_status": new}) + "\n")
proj = os.path.join(mt, "projects", "-fixture")
sub = os.path.join(proj, "sess1", "subagents")
os.makedirs(sub)
def asst(ts, mid, model, out, cr=0, w1h=0, w5=0, inp=0, content=None, stop="end_turn"):
    return {"type": "assistant", "timestamp": ts, "message": {"id": mid, "model": model, "content": content or [], "stop_reason": stop,
            "usage": {"input_tokens": inp, "cache_read_input_tokens": cr, "cache_creation_input_tokens": w1h + w5,
                      "cache_creation": {"ephemeral_1h_input_tokens": w1h, "ephemeral_5m_input_tokens": w5}, "output_tokens": out}}}
def user(ts, text):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}
def write(path, rows):
    with open(path, "w") as f:
        f.write("".join(json.dumps(r) + "\n" for r in rows))
write(os.path.join(proj, "sess1.jsonl"), [
    user("2026-01-01T10:29:00.000Z", "go"),
    asst("2026-01-01T10:30:00.000Z", "m1", "claude-opus-5-5", 5, cr=1000000, w1h=100000, inp=10),
    asst("2026-01-01T10:30:01.000Z", "m1", "claude-opus-5-5", 500, cr=1000000, w1h=100000, inp=10),
    asst("2026-01-01T10:31:00.000Z", "m2", "claude-opus-5-5", 100, inp=1000)])
write(os.path.join(sub, "agent-aaa.jsonl"), [
    user("2026-01-01T10:35:00.000Z", "slice: P1.S7\nfolder: works/phases/active/P1/slices/P1.S7"),
    asst("2026-01-01T10:40:00.000Z", "s1", "claude-opus-5-5", 50, inp=2000, content=[{"type": "text", "text": "Done.\n- status: done"}]),
    asst("2026-01-01T10:41:00.000Z", "s3", "claude-opus-5-5", 3, inp=500, stop=None)])  # a stream-start entry: no final usage ever follows
json.dump({"agentType": "slice-executor-high", "model": "opus", "effort": "high", "finished": True}, open(os.path.join(sub, "agent-aaa.meta.json"), "w"))
write(os.path.join(sub, "agent-bbb.jsonl"), [
    user("2026-01-01T10:41:00.000Z", "round: 01-x/01-x\nslice: P1.S7"),
    asst("2026-01-01T10:42:00.000Z", "s2", "claude-mystery-1", 10, inp=100),
    {"type": "assistant", "timestamp": "2026-01-01T10:43:00.000Z", "error": "rate_limit", "isApiErrorMessage": True,
     "message": {"id": "syn1", "model": "<synthetic>", "content": [{"type": "text", "text": "You've hit your session limit · resets 3:10am (Asia/Seoul)"}],
                 "usage": {"input_tokens": 0, "output_tokens": 0}}}])
json.dump({"agentType": "design-drafter", "model": "opus", "effort": "xhigh", "finished": True}, open(os.path.join(sub, "agent-bbb.meta.json"), "w"))
open(os.path.join(mt, "ws", "works", "phases", "active", "P1", "slices", "P1.S7", "result.md"), "w").write("# P1.S7\n\n- status: done\n- summary: probe\n")
PY
mt_json=$( cd "$MT/ws" && python3 "$ADP" meter --phase P1 --json --transcripts "$MT/projects/-fixture" 2>&1 )
printf '%s\n' "$mt_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)["metered"]["slices"]["P1.S7"]
m = d["main"]
assert m["requests"] == 2 and m["output"] == 600, m
spans = {s["agent"]: s for s in d["spans"]}
assert spans["slice-executor-high"]["slice"] == "P1.S7" and spans["slice-executor-high"]["attributed_by"] == "slice-line", spans
assert spans["slice-executor-high"]["outcome"] == "done", spans
assert spans["design-drafter"]["outcome"] == "limit" and spans["design-drafter"]["reset"] == "3:10am (Asia/Seoul)", spans
assert spans["design-drafter"]["usage"]["requests"] == 1 and spans["design-drafter"]["usage"]["unpriced"] == 1, spans
u = spans["slice-executor-high"]["usage"]
assert u["requests"] == 2 and u["no_final"] == 1 and u["output_floor"] is True and spans["design-drafter"]["usage"]["output_floor"] is False, u
assert m["output_floor"] is False, m
' && printf '%s\n' "$mt_json" | python3 -c '
import json, sys
v = json.load(sys.stdin)["verdicts"]
assert v["slices"]["P1.S7"] == {"kind": "implementation", "verdict": "done", "source": "result.md"}, v["slices"]
assert v["by_kind"]["implementation"]["done"] >= 1, v["by_kind"]
' && ok "the meter: two main-thread ids from three entries keep the largest output, spans attributed by their slice: line, a span ending on a usage limit is limit with its reset; a finished slice's result.md reads done" || bad "the transcript meter miscounted: $mt_json"
mt_out=$( cd "$MT/ws" && python3 "$ADP" meter --phase P1 --transcripts "$MT/projects/-fixture" 2>&1 )
printf '%s\n' "$mt_out" | grep -qE '^main +- +2 +1\.10M +600 +1\.02 ' && printf '%s\n' "$mt_out" | grep -qE '^design-drafter +1 +1 +100 +10 +\? ' \
  && ok "meter prices the main thread at list price (\$1.02) and leaves an unknown model unpriced (?)" || bad "meter pricing wrong: $mt_out"
printf '%s\n' "$mt_out" | grep -qE '^note=output_floor spans=1/3 \(33%\) main=0/2 ' && printf '%s\n' "$mt_out" | grep -qE '^slice-executor-high +1 +2 +[^ ]+ +≥53 +≥[0-9.]+ ' \
  && ! printf '%s\n' "$mt_out" | grep -E '^(main|design-drafter) ' | grep -q '≥' \
  && ok "meter flags a span request that never logged a final usage: the note= count and the ≥ floor on that group only" || bad "meter floor note/mark wrong: $mt_out"
# v66: a DECOMP estimates time, not session-$, and writes a `spends money:` line per slice; the [means] header says so.
grep -q 'never a session-\$ figure' "$PLUGIN/skills/do-whole-phase/reference/decomposition.md" \
  && grep -q 'spends money:' "$PLUGIN/skills/do-whole-phase/playbooks/decompose.md" && ! grep -q '\$ per span' "$PLUGIN/skills/do-whole-phase/playbooks/decompose.md" \
  && grep -q 'a DECOMP estimates time from these' "$PLUGIN/adapters/claude_code/adapter.py" \
  && ok "a DECOMP estimates time only and writes a per-slice spends-money line (the orchestrator reference, the decompose playbook, the [means] header)" || bad "the DECOMP time-only / spends-money wording is missing or a session-\$ estimate remains"
# v66: one slice-executor runs every slice row, so the meter reads its route from the kind and the model
# (research by kind, haiku as cheap, the high row's family as high, else mid); an old slice-executor-high
# span keeps its reading. v80: on the defaults high and mid are both opus, so the span's effort tells them apart.
rm -f "$MT/ws/config.toml"
python3 - "$MT" <<'PY'
import json, os, sys
proj = os.path.join(sys.argv[1], "projects", "-fixture2")
sub = os.path.join(proj, "sess2", "subagents")
os.makedirs(sub)
def row(ts, kind, payload):
    return json.dumps({"type": kind, "timestamp": ts, "message": payload}) + "\n"
open(os.path.join(proj, "sess2.jsonl"), "w").write(row("2026-01-01T10:29:00.000Z", "user", {"role": "user", "content": "go"}))
for n, (agent, model, sid, effort) in enumerate((("slice-executor", "claude-opus-5-5", "P1.S7", "high"), ("slice-executor", "claude-opus-5-5", "P1.S7", "medium"),
                                                 ("slice-executor", "claude-haiku-5-5", "P1.S7", None), ("slice-executor", "claude-opus-5-5", "P1.S2", None),
                                                 ("slice-executor-high", "claude-opus-5-5", "P1.S7", None), ("slice-executor", "claude-sonnet-5-5", "P1.S7", None))):
    ts = f"2026-01-01T10:3{n}:00.000Z"
    with open(os.path.join(sub, f"agent-x{n}.jsonl"), "w") as f:
        f.write(row(ts, "user", {"role": "user", "content": f"slice: {sid}"}))
        f.write(row(ts, "assistant", {"id": f"x{n}", "model": model, "content": [{"type": "text", "text": "- status: done"}], "stop_reason": "end_turn",
                                      "usage": {"input_tokens": 10, "output_tokens": 5}}))
    json.dump({"agentType": agent, "finished": True, **({"effort": effort} if effort else {})}, open(os.path.join(sub, f"agent-x{n}.meta.json"), "w"))
PY
mt2=$( cd "$MT/ws" && python3 "$ADP" meter --phase P1 --json --transcripts "$MT/projects/-fixture2" 2>&1 )
printf '%s\n' "$mt2" | python3 -c '
import json, sys
slices = json.load(sys.stdin)["metered"]["slices"]
routes = {s["id"]: (s["agent"], s["route"]) for d in slices.values() for s in d["spans"]}
assert routes == {"x0": ("slice-executor", "high"), "x1": ("slice-executor", "mid"), "x2": ("slice-executor", "cheap"),
                  "x3": ("slice-executor", "research"), "x4": ("slice-executor-high", "high"), "x5": ("slice-executor", "mid")}, routes
' && ok "the meter reads slice-executor spans by kind, model and effort (opus@high high, opus@medium mid, haiku cheap, sonnet mid, a research slice research) and still reads an old slice-executor-high span" \
  || bad "the meter misread slice-executor routes: $mt2"
# A minted, tailed slice id (P<n>-<tail>.S1) attributes by its `slice:` line, and meter --phase takes the
# brief name (the bare number, while one phase holds it).
mt_tok=$( cd "$MT/ws" && python3 "$ENG" phase new --name "Meter token" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p' )
mt_num=$(printf '%s\n' "$mt_tok" | sed -nE 's/^P([0-9]+)-[0-9a-z]{2}$/\1/p')
( cd "$MT/ws" && python3 "$ENG" slice new --phase "$mt_num" --slice S1 --name "token meter" --kind implementation --risk low ) >/dev/null 2>&1 || bad "token meter probe: slice new failed"
python3 - "$MT" "$mt_tok.S1" <<'PY'
import json, os, sys
sub = os.path.join(sys.argv[1], "projects", "-fixture2", "sess2", "subagents")
with open(os.path.join(sys.argv[1], "ws", "works", "events.jsonl"), "a") as f:  # the slice's window, so the phase filter finds the session
    for ts, old, new in (("2026-01-01T10:00:00+00:00", "todo", "in_progress"), ("2026-01-01T10:55:00+00:00", "in_progress", "done")):
        f.write(json.dumps({"ts": ts, "type": "slice_status_changed", "slice": sys.argv[2], "old_status": old, "new_status": new}) + "\n")
with open(os.path.join(sub, "agent-t0.jsonl"), "w") as f:
    f.write(json.dumps({"type": "user", "timestamp": "2026-01-01T10:50:00.000Z", "message": {"role": "user", "content": "slice: " + sys.argv[2]}}) + "\n")
    f.write(json.dumps({"type": "assistant", "timestamp": "2026-01-01T10:51:00.000Z", "message": {"id": "t0", "model": "claude-sonnet-5-5", "content": [{"type": "text", "text": "- status: done"}],
                                                                                              "stop_reason": "end_turn", "usage": {"input_tokens": 10, "output_tokens": 5}}}) + "\n")
json.dump({"agentType": "slice-executor", "finished": True}, open(os.path.join(sub, "agent-t0.meta.json"), "w"))
PY
mt3=$( cd "$MT/ws" && python3 "$ADP" meter --phase "$mt_num" --json --transcripts "$MT/projects/-fixture2" 2>&1 )
printf '%s\n' "$mt3" | python3 -c '
import json, sys
spans = [s for d in json.load(sys.stdin)["metered"]["slices"].values() for s in d["spans"]]
assert [(s["slice"], s["attributed_by"]) for s in spans] == [(sys.argv[1] + ".S1", "slice-line")], spans
' "$mt_tok" && [ -n "$mt_num" ] && ok "the meter attributes a minted, tailed slice id ($mt_tok.S1) by its slice: line, and meter --phase takes the bare number" \
  || bad "the meter did not attribute a minted slice id: $mt3"
# v61 pure compaction (P37.S3): compaction is Claude Code's own -- no PreCompact hook, no compact-gate. After
# a compaction the SessionStart hook runs the adapter's compact-resume, which prints the engine's resume card (`next --card`) with the running spans:
# computed from state, at most 2,048 B, naming files and never asking for a re-read. A pending stop is typed
# (slice status ... pending --stop-kind --on-words), printed by next and the card, cleared on leaving pending.
newtmp CGT
CG="$CGT/ws"
mkws CG >/dev/null 2>&1 \
  && ( cd "$CG" && python3 "$ENG" phase new --phase P1 --name "Card probe" --objective "probe the resume card" >/dev/null 2>&1 ) \
  || bad "resume card: could not build the fixture"
cg_help=$( cd "$CG" && python3 "$ENG" --help 2>&1 ); cg_help_rc=$?
( cd "$CG" && python3 "$ENG" compact-gate </dev/null >/dev/null 2>&1 ); cg_rc=$?
[ "$cg_help_rc" -eq 0 ] && printf '%s\n' "$cg_help" | grep -q 'next' && [ "$cg_rc" -ne 0 ] && ! printf '%s\n' "$cg_help" | grep -q 'compact-gate' && ! engine_src "$CG" | grep -qE 'cmd_compact_gate|AGENTIC_COMPACT_|COMPACT_RESUME_LINE' \
  && ok "compact-gate is gone from the engine (no subcommand, no knobs, no resume line)" || bad "compact-gate still present (rc=$cg_rc)"
# every subcommand's --help exits 0 (a crash in an argparse help string once hid behind a green suite);
# the list is the engine's own, read from the top-level help
( cd "$CG" && printf '%s\n' "$cg_help" | python3 -c '
import os, re, subprocess, sys
names = re.search(r"\{([^}]+)\}", " ".join(sys.stdin.read().split())).group(1).split(",")
bad = [n for n in names if subprocess.run([sys.executable, __import__("os").environ["ENG"], n, "--help"], capture_output=True).returncode != 0]
assert len(names) > 20 and not bad, bad
' ) && ok "every subcommand's --help exits 0 (the list read from the engine's own top-level help)" || bad "a subcommand's --help fails"
# W1: the engine's --help lists the eleven verbs and the named parts' own commands, 45 in all, and no
# command of the Claude Code adapter (route, sync-agents, meter, compact-resume, nor their old names).
( printf '%s\n' "$cg_help" | python3 -c '
import re, sys
names = re.search(r"\{([^}]+)\}", " ".join(sys.stdin.read().split())).group(1).split(",")
verbs = {"init", "next", "phase", "slice", "section", "review", "gate", "pr", "worktree", "repo", "close", "check"}
design = {"design-sign", "design-publish", "design-builds", "design-delete", "design-link"}  # 2.0.0 retired the ten canvas commands; 2.1.0 publishes; 0.7.0 design-link
agenda = {"agenda", "agenda-add", "agenda-accept", "agenda-propose", "agenda-item", "agenda-entry", "agenda-show",
          "agenda-split", "agenda-merge", "agenda-fold", "agenda-edit", "agenda-move", "agenda-solve", "agenda-drop",
          "agenda-reopen", "agenda-delete", "agenda-link", "agenda-unlink",
          "agenda-feedback"}  # 0.3.0: the four deferred-job verbs retired; 0.6.0: agenda-defer retired, agenda-feedback added
cloud = {"link", "sign-in", "unlink", "sync", "mark-committed", "cold"}
machine = {"setup", "feedback", "migrate"}  # beside init, run before any workspace is found
assert len(names) == 45 and set(names) == verbs | design | agenda | cloud | machine, sorted(set(names) ^ (verbs | design | agenda | cloud | machine))
' ) && ok "the engine's --help lists 45 commands: init and the eleven verbs, setup, feedback and migrate, plus design-sign, the three publish verbs, design-link and the agenda, cloud and cold parts' own, no adapter command" \
  || bad "the engine's command list moved -- $(printf '%s\n' "$cg_help" | sed -n 2p)"
card_ok() { # card_ok <text>: at most 2,048 bytes, no re-read, the pointer, the next action and the file paths
  [ "$(printf '%s' "$1" | wc -c | tr -d ' ')" -le 2048 ] && ! printf '%s\n' "$1" | grep -qi 're-read' \
    && printf '%s\n' "$1" | grep -q '^pointer: phase P1 ' && printf '%s\n' "$1" | grep -q '^next action: ' \
    && printf '%s\n' "$1" | grep -q '^plan: .sikstack/works/phases/active/P1/slices/P1.DECOMP/plan.md' && printf '%s\n' "$1" | grep -q '^result: not yet' \
    && printf '%s\n' "$1" | grep -q '^phase: .sikstack/works/phases/active/P1/phase.md' && printf '%s\n' "$1" | grep -q '^intent: .sikstack/works/phases/active/P1/intent.md'
}
card=$( cd "$CG" && python3 "$ENG" next --card 2>&1 ); cr_rc=$?
[ "$cr_rc" -eq 0 ] && card_ok "$card" && printf '%s\n' "$card" | grep -q '^next action: slice start P1.DECOMP, then plan it' \
  && ! printf '%s\n' "$card" | grep -q '^running spans' && printf '%s\n' "$card" | grep -qF "pin its route (the adapter's \`route P1.DECOMP\`)" \
  && ok "next --card prints the resume card: <= 2,048 B, the pointer, the next action (plan it), the file paths, no re-read, no spans (the engine reads no transcript)" || bad "next --card wrong (rc=$cr_rc): $card"
( cd "$CG" && python3 "$ENG" slice start P1.DECOMP >/dev/null 2>&1 && printf 'the plan\n' > works/phases/active/P1/slices/P1.DECOMP/plan.md ) || bad "resume card: slice start failed"
mkdir -p "$CGT/proj/s1/subagents" && printf '{}\n' > "$CGT/proj/s1.jsonl"
printf '{"agentType":"slice-executor-high","description":"P1.DECOMP decomposition executor"}' > "$CGT/proj/s1/subagents/agent-a.meta.json"
printf '{"agentType":"Explore","description":"an old lookup","finished":true}' > "$CGT/proj/s1/subagents/agent-b.meta.json"
cr_out=$( cd "$CG" && printf '{"source":"compact","transcript_path":"%s","cwd":"%s"}' "$CGT/proj/s1.jsonl" "$CG" | python3 "$ADP" compact-resume 2>&1 ); cr_rc=$?
cr_card=$(printf '%s\n' "$cr_out" | sed 1d)
[ "$cr_rc" -eq 0 ] && [ "$(printf '%s\n' "$cr_out" | head -1)" = "compaction=done source=compact" ] && card_ok "$cr_card" \
  && printf '%s\n' "$cr_card" | grep -qx 'running spans: slice-executor-high: P1.DECOMP decomposition executor' \
  && printf '%s\n' "$cr_card" | grep -q '^next action: an executor is running (see spans): wait for its notification, never re-dispatch' \
  && ok "compact-resume (fake hook stdin) prints the card: running spans from the session's unfinished .meta.json only, wait -- never re-dispatch" || bad "compact-resume card wrong (rc=$cr_rc): $cr_out"
cr_out=$( cd "$CG" && printf 'not json' | python3 "$ADP" compact-resume 2>&1 ); cr_rc=$?
[ "$cr_rc" -eq 0 ] && printf '%s\n' "$cr_out" | head -1 | grep -qx 'compaction=done source=compact' && printf '%s\n' "$cr_out" | grep -q '^pointer: phase P1 ' \
  && ok "compact-resume on garbage stdin still prints the card and exits 0" || bad "compact-resume garbage stdin wrong (rc=$cr_rc): $cr_out"
( cd "$CG" && python3 "$ENG" slice status P1.DECOMP in_progress --stop-kind decision --on-words x >/dev/null 2>&1 ); tp_rc=$?
[ "$tp_rc" -ne 0 ] && ok "slice status refuses --stop-kind/--on-words without pending" || bad "slice status accepted --stop-kind without pending"
tp_set=$( cd "$CG" && python3 "$ENG" slice status P1.DECOMP pending --stop-kind decision --on-words "choose the design style; DECOMP records it and cuts the slices" 2>&1 ); tp_rc=$?
tp_next=$( cd "$CG" && python3 "$ENG" next 2>&1 )
tp_card=$( cd "$CG" && python3 "$ENG" next --card 2>&1 )
( cd "$CG" && python3 "$ENG" check --no-rebuild >/dev/null 2>&1 ); tp_val=$?
[ "$tp_rc" -eq 0 ] && [ "$tp_val" -eq 0 ] && python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["pending"]; assert set(p)=={"kind","on_words","since"} and p["kind"]=="decision", p' "$CG/works/phases/active/P1/slices/P1.DECOMP/slice.json" \
  && printf '%s\n' "$tp_next" | grep -qx 'stop_kind=decision' && printf '%s\n' "$tp_next" | grep -qx 'on_words=choose the design style; DECOMP records it and cuts the slices' \
  && printf '%s\n' "$tp_card" | grep -q '^stop: decision (since .*) -- the operator.s words will: choose the design style' && [ "$(printf '%s' "$tp_card" | wc -c | tr -d ' ')" -le 2048 ] \
  && ok "a typed pending stop is stored as pending {kind, on_words, since}; next and the card print the kind and the words; validate passes" || bad "typed pending wrong (rc=$tp_rc val=$tp_val): $tp_set / $tp_next / $tp_card"
( cd "$CG" && python3 "$ENG" slice status P1.DECOMP in_progress >/dev/null 2>&1 ) \
  && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "pending" not in d and d["status"]=="in_progress", d' "$CG/works/phases/active/P1/slices/P1.DECOMP/slice.json" \
  && ok "leaving pending clears the typed record" || bad "the pending record survived slice status in_progress"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["pending"]={"kind":"nap","on_words":"x","since":"t"}; json.dump(d,open(p,"w"))' "$CG/works/phases/active/P1/slices/P1.DECOMP/slice.json"
tp_val=$( cd "$CG" && python3 "$ENG" check --no-rebuild 2>&1 ); tp_rc=$?
[ "$tp_rc" -ne 0 ] && printf '%s\n' "$tp_val" | grep -q 'carries a pending record' \
  && ok "validate rejects a pending record on a slice that is not pending" || bad "validate missed a stray pending record: $tp_val"

# ---------------------------------------------------------------------------
echo "== Test 9: v35 phase notebook -- template seed, generated ## Slices block, slice finish --outcome =="
# Runs against the fresh workspace from Test 5 ($F), which already carries the gate-probe P1 (P2 was archived above,
# and an archived id is spent since v73, so the notebook probe is P4).
sig() { python3 -c "import hashlib,os,sys;p=sys.argv[1];print(hashlib.sha256(open(p,'rb').read()).hexdigest(),os.stat(p).st_mtime_ns)" "$1"; }
PM="$F/works/phases/active/P4/phase.md"
( cd "$F" && python3 "$ENG" phase new --phase P4 --name "Notebook" --objective "notebook probe" >/dev/null 2>&1 )
grep -q '<!-- slices:begin -->' "$PM" && grep -q '<!-- slices:end -->' "$PM" && grep -q '^## Now$' "$PM" \
  && ok "phase new seeds phase.md from the template (both markers + ## Now)" || bad "seeded phase.md is not the v35 shape"
grep -q '^| `P4.DECOMP` |' "$PM" && ok "phase new renders the generated ## Slices block" || bad "## Slices block was not filled on phase creation"
( cd "$F" && python3 "$ENG" slice new --phase P4 --slice P4.S1 --name "probe" >/dev/null 2>&1 )
out=$( cd "$F" && python3 "$ENG" slice finish P4.S1 --outcome "did X" 2>&1 )
grep -q '| did X |' "$PM" && ok "slice finish --outcome lands in the slice's generated row" || bad "outcome missing from the ## Slices row -- $out"
out=$( cd "$F" && python3 "$ENG" slice finish P4.DECOMP 2>&1 ); rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -q '^warning: no --outcome recorded for P4.DECOMP' \
  && ok "slice finish without --outcome warns and still succeeds" || bad "omitted --outcome must warn, never fail (exit=$rc) -- $out"
before=$(sig "$PM"); ( cd "$F" && python3 "$ENG" check >/dev/null 2>&1 )
[ "$(sig "$PM")" = "$before" ] && ok "an unchanged phase.md is not rewritten by rebuild (no notebook churn)" || bad "rebuild rewrote an unchanged phase.md"
python3 - "$PM" <<'STRIP'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text("\n".join(l for l in p.read_text().split("\n") if "slices:begin" not in l and "slices:end" not in l))
STRIP
before=$(sig "$PM"); ( cd "$F" && python3 "$ENG" check >/dev/null 2>&1 )
[ "$(sig "$PM")" = "$before" ] && ok "a marker-less phase.md is left byte-identical (legacy no-op, no migration)" || bad "rebuild touched a marker-less phase.md"
grep -qF '_Generated by `sikstack check` from each slice' "$PLUGIN/templates/works/phase.md" && grep -qF '_Generated by `sikstack check` from each slice' "$PM" \
  && ok "the notebook seed is the plugin's templates/works/phase.md, and its generated line names sikstack check" || bad "phase.md was not seeded from the plugin's template"

# ---------------------------------------------------------------------------
echo "== Test 10: v35/v39 notebook guardrails -- budget warning, no dashboard timestamp churn =="
# Continues on $F (P4's phase.md lost its markers in Test 9; irrelevant here). v39's cap is
# bytes-only (v61: 40 KB, an index), so the filler is generated, never checked in: pad the
# notebook past it in one edit.
python3 - "$PM" <<'PAD'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
p.write_text(p.read_text() + "\n## Filler\n\n" + "- filler\n" * 50_000)  # ~450 KB
PAD
out=$( cd "$F" && python3 "$ENG" check --no-rebuild 2>&1 ); rc=$?
[ "$rc" -eq 0 ] && ok "validate exits 0 with notebook warnings (warn, never error)" || bad "validate exited $rc on warnings -- $out"
printf '%s\n' "$out" | grep -q 'phase P4: phase.md is .* over the notebook budget of 40960 bytes; biggest sections: ## Filler ' \
  && ok "an over-budget phase.md warns (40 KB) and names its largest section" || bad "no over-budget warning naming the largest section -- $out"
( cd "$F" && python3 "$ENG" slice new --phase P4 --slice P4.S2 --name "budget probe" >/dev/null 2>&1 )
out=$( cd "$F" && python3 "$ENG" slice finish P4.S2 --outcome "probe" 2>&1 )
printf '%s\n' "$out" | grep -q '^phase.md: .* bytes (budget 40960 bytes)' && printf '%s\n' "$out" | grep -q 'OVER BUDGET' \
  && ok "slice finish prints the notebook size and flags it over budget" || bad "slice finish notebook size print missing -- $out"
printf '%s\n' "$out" | grep -q 'biggest sections: ## Filler ' && printf '%s\n' "$out" | grep -q 'topics/<slug>.md' \
  && ok "slice finish names the biggest sections and suggests topics/ when over budget" || bad "over-budget size line does not name the largest section -- $out"
grep -q 'Rebuilt at' "$F/works/backlog.md" "$F/works/agenda.md" \
  && bad "a markdown dashboard still carries a Rebuilt at timestamp" || ok "no Rebuilt at timestamp in any markdown dashboard (backlog, agenda)"
# The churn this removes: repeated `next` calls must not dirty the three dashboards.
( cd "$F" && git init -q . >/dev/null 2>&1 && git add -A >/dev/null 2>&1 \
    && git -c user.email=smoke@example.invalid -c user.name=smoke commit -qm "smoke baseline" >/dev/null 2>&1 )
( cd "$F" && python3 "$ENG" next >/dev/null 2>&1; python3 "$ENG" next >/dev/null 2>&1 )
tracked=$( cd "$F" && git ls-files works/backlog.md works/agenda.md | wc -l | tr -d ' ' )
dirty=$( cd "$F" && git status --short -- works/backlog.md works/agenda.md )
[ "$tracked" = "2" ] && [ -z "$dirty" ] && [ ! -e "$F/works/deferred.md" ] && [ ! -e "$F/works/deferred" ] \
  && ok "two next calls leave the dashboards byte-identical (no timestamp churn), and no works/deferred.md or works/deferred/ is written" || bad "next dirtied the dashboards (tracked=$tracked) or wrote the deferred dashboard -- $dirty"

# ---------------------------------------------------------------------------
echo "== Test 10b: v61 section -- phase.md is an index, read and written one section at a time =="
# Runs on a copy of $F so the probe phase never reaches the later tests' pointer.
newtmp PSW; cp -R "$F/.." "$PSW/ws"; PW="$PSW/ws/.sikstack"; ps() { ( cd "$PW" && python3 "$ENG" section "$@" ); }
( cd "$PW" && python3 "$ENG" phase new --phase P8 --name "Index probe" --objective "section probe" >/dev/null 2>&1 )
PN="$PW/works/phases/active/P8/phase.md"
python3 - "$PN" <<'SEED'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
# an older notebook (before the retirement) also carries ## Doc impact: section still reads and appends to it
t = t.replace("## Operator Questions\n", "## Doc impact\n\n_One line per durable-truth change._\n\n## Operator Questions\n\n- **OQ1 (S1):** Should the probe keep the old shape?\n  A second line of context.\n- **OQ2 (S1):** Another one?\n", 1)
t = t.replace("## Now\n", "## Now\n\n- old now line\n", 1)
p.write_text(t)
SEED
out=$(ps P8); printf '%s\n' "$out" | grep -q 'Objective$' && printf '%s\n' "$out" | grep -q 'Operator Questions$' && printf '%s\n' "$out" | grep -q 'total' \
  && ok "section <P> lists the headings with their bytes and a total" || bad "section index wrong -- $out"
out=$(ps P8 Now); printf '%s\n' "$out" | grep -qx '## Now' && printf '%s\n' "$out" | grep -q 'old now line' && ! printf '%s\n' "$out" | grep -q '## Decisions' \
  && ok "section <P> Now prints that section, heading included, and nothing else" || bad "section Now wrong -- $out"
ps P8 nope >/dev/null 2>&1; rc=$?; [ "$rc" -eq 1 ] && ok "an unknown section exits 1" || bad "unknown section exit=$rc"
cp "$PN" "$PSW/before.md"
printf 'fresh now\n' | ps P8 Now --replace >/dev/null 2>&1
python3 - "$PSW/before.md" "$PN" <<'SPLICE'
import sys
old, new = (open(p, encoding="utf-8").read() for p in sys.argv[1:3])
cut = old.index("## Now\n")
assert new[:cut] == old[:cut], "bytes before ## Now changed"
assert new[cut:].startswith("## Now\n") and "fresh now" in new[cut:] and "old now line" not in new, "the section was not replaced"
SPLICE
[ $? -eq 0 ] && ok "--replace of Now keeps every byte before the section identical and swaps its body" || bad "--replace changed bytes outside the section"
printf 'mid decision\n' > "$PSW/dec.txt"; cp "$PN" "$PSW/before2.md"; ps P8 Decisions --replace --file "$PSW/dec.txt" >/dev/null 2>&1
python3 - "$PSW/before2.md" "$PN" <<'SPLICE2'
import re, sys
old, new = (open(p, encoding="utf-8").read() for p in sys.argv[1:3])
split = lambda t: re.split(r"(?m)^(?=## )", t)
a, b = split(old), split(new)
assert len(a) == len(b)
for x, y in zip(a, b):
    if x.startswith("## Decisions"):
        assert "mid decision" in y
    else:
        assert x == y, x[:30]
SPLICE2
[ $? -eq 0 ] && ok "--replace of a middle section (Decisions, from --file) leaves every other section byte-identical" || bad "--replace of Decisions touched another section"
printf 'x\n' | ps P8 Slices --replace >/dev/null 2>&1; rc=$?
[ "$rc" -ne 0 ] && ok "--replace refuses the generated Slices section" || bad "--replace of Slices was accepted"
cp "$PN" "$PSW/ao.md"; out=$(printf -- '- x\n' | ps P8 "Operator Questions" --replace 2>&1); rc=$?; ao=$(cmp -s "$PSW/ao.md" "$PN" && echo same); cp "$PSW/ao.md" "$PN"
[ "$rc" -eq 0 ] && [ -z "$ao" ] && [ "$(printf '%s\n' "$out" | grep -c '^advice: Operator Questions is append-only by custom; --resolve collapses an answered entry$')" -eq 1 ] \
  && ok "--replace of Operator Questions writes, with one advice: line (append-only by custom)" || bad "--replace of Operator Questions (rc $rc) -- $out"
printf 'x\n' | ps P8 Slices --append >/dev/null 2>&1; [ $? -ne 0 ] && ok "--append refuses the generated Slices section" || bad "--append of Slices was accepted"
printf '%s\n' '- widget.md: a new line (S1)' | ps P8 "Doc impact" --append >/dev/null 2>&1
ps P8 "Doc impact" | grep -q 'widget.md: a new line' && ok "--append adds a line to an older notebook's Doc impact" || bad "--append to Doc impact lost the line"
ps P8 "Operator Questions" --append <<'OQAPP' >/dev/null 2>&1
- **OQ3 (S2):** Third?
OQAPP
ps P8 "Operator Questions" | grep -q 'OQ3 (S2)' && ok "--append adds an Operator Questions entry" || bad "--append to Operator Questions lost the entry"
out=$(ps P8 --resolve OQ1 --pointer "Decisions line 2"); rc=$?
ps P8 "Operator Questions" > "$PSW/oq.txt"
[ "$rc" -eq 0 ] && grep -qx -- '- \*\*OQ1\*\* (resolved → Decisions line 2): Should the probe keep the old shape?' "$PSW/oq.txt" \
  && ! grep -q 'A second line of context' "$PSW/oq.txt" && grep -q 'OQ2 (S1)' "$PSW/oq.txt" && grep -q 'OQ3 (S2)' "$PSW/oq.txt" \
  && ok "--resolve collapses a two-line entry to one resolved line and leaves its neighbours" || bad "--resolve result wrong (rc=$rc) -- $(cat "$PSW/oq.txt")"
ps P8 --resolve OQ1 --pointer "again" >/dev/null 2>&1; [ $? -ne 0 ] && ok "a second --resolve of the same entry is refused" || bad "an already-resolved entry was resolved again"
ps P8 --resolve OQ9 --pointer "x" >/dev/null 2>&1; [ $? -ne 0 ] && ok "--resolve of a missing entry is refused" || bad "--resolve of a missing entry succeeded"
( cd "$PW" && python3 "$ENG" check --no-rebuild >/dev/null 2>&1 ) ; mkdir -p "$PW/works/phases/active/P8/topics" && printf '# topic\n' > "$PW/works/phases/active/P8/topics/contract.md"
out=$( cd "$PW" && python3 "$ENG" check --no-rebuild 2>&1 ); rc=$?
[ "$rc" -eq 0 ] && ! printf '%s\n' "$out" | grep -q 'P8' && ok "validate accepts a topics/ folder beside phase.md without a word" || bad "validate flagged topics/ (rc=$rc) -- $out"
python3 - "$PW/works/phases/active/P8/phase.md" <<'BIG'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); p.write_text(p.read_text() + "\n".join("- long decision line %d padding padding padding" % i for i in range(1500)) + "\n")
BIG
out=$( cd "$PW" && python3 "$ENG" check --no-rebuild 2>&1 )
printf '%s\n' "$out" | grep -q 'phase P8: phase.md is .* over the notebook budget of 40960 bytes; biggest sections: ## ' && printf '%s\n' "$out" | grep -q 'topics/<slug>.md' \
  && ok "a notebook over 40 KB warns in validate, names its biggest sections and points at topics/" || bad "no 40 KB warning with sections -- $out"
# Entries: --entry K --replace writes one entry, --to-topic moves entries losslessly behind gist lines, and
# every refusal writes nothing. On a fresh probe phase P9 with a small synthetic notebook.
( cd "$PW" && python3 "$ENG" phase new --phase P9 --name "Entry probe" --objective "entry probe" >/dev/null 2>&1 )
PE="$PW/works/phases/active/P9/phase.md"
python3 - "$PE" <<'SEED'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
dec = ("1. **Alpha:** the first decision, short enough to be its own gist.\n"
       "2. **Beta:** a long decision. " + "It carries detail the next slice reads only when it needs it. " * 12 + "\n"
       "   - a nested point under Beta\n"
       "3. [topics/x.md](topics/x.md)\n")
t = t.replace("`topics/breakdown.md`._\n", "`topics/breakdown.md`._\n\n" + dec, 1)
t = t.replace("Last on purpose._\n", "Last on purpose._\n\n- now line\n", 1)
p.write_text(t)
SEED
cp "$PE" "$PSW/e0.md"; printf 'the **Alpha** decision, replaced\n' | ps P9 Decisions --entry alpha --replace >/dev/null 2>&1
python3 - "$PSW/e0.md" "$PE" <<'ENTRY'
import sys
old, new = (open(p, encoding="utf-8").read() for p in sys.argv[1:3])
line = "1. **Alpha:** the first decision, short enough to be its own gist."
assert old.count(line) == 1 and new == old.replace(line, "1. the **Alpha** decision, replaced", 1), "bytes outside the entry changed"
ENTRY
[ $? -eq 0 ] && ok "--entry K --replace swaps only that entry (its marker kept) and leaves every other byte identical" || bad "--entry --replace touched bytes outside the entry"
cp "$PE" "$PSW/e1.md"
for refusal in "Decisions --to-topic decisions --entry 3" "Decisions --to-topic breakdown --entry 1" "Now --to-topic now" \
               "Doc_impact --to-topic notes"; do
  # shellcheck disable=SC2086
  set -- $refusal; sect=$(printf '%s' "$1" | tr '_' ' '); shift
  printf 'x\n' | ps P9 "$sect" "$@" >/dev/null 2>&1; rc=$?
  [ "$rc" -ne 0 ] && cmp -s "$PSW/e1.md" "$PE" && [ ! -e "$PW/works/phases/active/P9/topics" ] \
    && ok "section refuses $sect $* and writes nothing" || bad "section $sect $* was not refused cleanly (rc=$rc)"
done
out=$(ps P9 Decisions --entry 1 --remove 2>&1); rc=$?; dr=$(cmp -s "$PSW/e1.md" "$PE" && echo same); cp "$PSW/e1.md" "$PE"
[ "$rc" -eq 0 ] && [ -z "$dr" ] && printf '%s\n' "$out" | grep -qx 'advice: Decisions keeps every decision by custom: a superseded one is replaced in place (--entry K --replace)' \
  && ok "section Decisions --entry 1 --remove writes, with one advice: line" || bad "Decisions --entry 1 --remove (rc=$rc) -- $out"
ps P9 Decisions --to-topic decisions --entry 1-2 --dry-run >/dev/null 2>&1; dry_rc=$?
dry_clean=no; cmp -s "$PSW/e1.md" "$PE" && [ ! -e "$PW/works/phases/active/P9/topics" ] && dry_clean=yes
ps P9 Decisions --to-topic decisions --entry 1-2 >/dev/null 2>&1; mv_rc=$?
python3 - "$PSW/e1.md" "$PE" "$PW/works/phases/active/P9/topics/decisions.md" <<'MOVE'
import re, sys
old, new, topic = (open(p, encoding="utf-8").read() for p in sys.argv[1:4])
dec = lambda t: re.search(r"(?ms)^## Decisions\n.*?(?=^## )", t).group(0)
others = lambda t: t.replace(dec(t), "")
assert others(old) == others(new), "a section other than Decisions changed"
body = dec(old).split("\n")
starts = [i for i, l in enumerate(body) if re.match(r"\d+\. ", l)]
entries = ["\n".join(body[s:e]).rstrip("\n") for s, e in zip(starts, starts[1:] + [len(body)])]
for n, entry in enumerate(entries[:2], 1):
    assert f"## Decisions {n}\n\n{entry}\n" in topic, f"entry {n} is not verbatim in the topic"
    ptr = re.search(rf"(?m)^{n}\. (.+) → \[topics/decisions\.md\]\(topics/decisions\.md\) § Decisions {n}$", dec(new))
    assert ptr and len(re.sub(r"[*`]", "", ptr.group(1))) >= 24 and len(ptr.group(1)) <= 160, f"pointer {n} lacks a gist"
assert entries[2] in dec(new), "the unmoved entry changed"
MOVE
[ $? -eq 0 ] && [ "$dry_rc" -eq 0 ] && [ "$dry_clean" = yes ] && [ "$mv_rc" -eq 0 ] \
  && ok "--to-topic --dry-run writes nothing; the move puts each entry verbatim in topics/<slug>.md and leaves a pointer line with a gist" \
  || bad "--to-topic was not lossless (dry rc=$dry_rc clean=$dry_clean, move rc=$mv_rc)"
# Budgets and paging (design §4-§5): a probe phase P10 whose Decisions (~70 KB, one entry bigger than a
# page) is over its 12 KB budget, read in 24 KB pages; then a dangling pointer warns in validate.
( cd "$PW" && python3 "$ENG" phase new --phase P10 --name "Page probe" --objective "page probe" >/dev/null 2>&1 )
PP="$PW/works/phases/active/P10/phase.md"
python3 - "$PP" <<'SEED'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
dec = "".join(f"- **D{n}:** decision {n}. " + "detail " * 140 + "\n" for n in range(1, 41))
dec += "- **Huge:** " + "x" * 30000 + "\n\nA prose paragraph after the entries.\n"
t = t.replace("`topics/breakdown.md`._\n", "`topics/breakdown.md`._\n\n" + dec, 1)
p.write_text(t)
SEED
out=$(ps P10)
printf '%s\n' "$out" | grep -q '12288  over,long:41 Decisions$' && printf '%s\n' "$out" | grep -qx 'move: section P10 "Decisions" --to-topic decisions --entry 1-41' \
  && val=$( cd "$PW" && python3 "$ENG" check --no-rebuild 2>&1 ) && printf '%s\n' "$val" | grep -q 'phase P10: phase.md ## Decisions: .* over its 12288 B budget; long entries: 1, 2, 3, 4, 5, 6, 7, 8 +33 more; move: section P10 "Decisions"' \
  && ok "an over-budget section and its long entries are named, with the move command, by the index (heading last) and validate" || bad "budget report wrong -- $out"
pg_rc=0; ps P10 Decisions > "$PSW/plain.txt" || pg_rc=1; n=$(head -1 "$PSW/plain.txt" | sed -n 's/^<!-- page 1 of \([0-9]*\) · Decisions · entries 1–[0-9]* of 41 · next: section P10 "Decisions" --page 2 -->$/\1/p')
: > "$PSW/pages.txt"; for k in $(seq 1 "${n:-0}"); do ps P10 Decisions --page "$k" > "$PSW/page$k.txt" || pg_rc=1; done
python3 - "$PP" "$PSW" "${n:-0}" <<'PAGES'
import re, sys
text, d, n = open(sys.argv[1], encoding="utf-8").read(), sys.argv[2], int(sys.argv[3])
sec = re.search(r"(?ms)^## Decisions\n.*?(?=^## )", text).group(0).rstrip("\n") + "\n"
pages = [open(f"{d}/page{k}.txt", encoding="utf-8").read() for k in range(1, n + 1)]
assert n >= 3 and pages[0] == open(f"{d}/plain.txt", encoding="utf-8").read(), "a plain read is not page 1"
assert all(p.startswith("<!-- page ") for p in pages) and pages[-1].split("\n")[0].endswith("· last page -->")
assert "".join(p.split("\n", 1)[1] for p in pages) == sec, "the pages do not concatenate to the section"
for p in pages[1:]:
    assert re.match(r"(- \*\*|A prose)", p.split("\n", 1)[1]), "a page starts inside an entry"
assert any(len(p.encode()) > 24 * 1024 for p in pages), "the entry bigger than a page was split"
PAGES
[ $? -eq 0 ] && [ "$pg_rc" -eq 0 ] && ok "a section over 24 KB reads in pages: a plain read is page 1, pages break only between entries and concatenate to the section byte for byte" \
  || bad "paged read wrong (n=$n rc=$pg_rc) -- $(head -1 "$PSW/plain.txt" | cut -c1-200)"
cp "$PP" "$PSW/p0.md"; r1=0; r2=0; ps P10 Decisions --page 99 >/dev/null 2>&1 || r1=1; printf 'x\n' | ps P10 Decisions --page 1 --replace >/dev/null 2>&1 || r2=1
[ "$r1" -eq 1 ] && [ "$r2" -eq 1 ] && cmp -s "$PSW/p0.md" "$PP" && ok "--page out of range and --page with a write flag are refused, writing nothing" || bad "--page refusals wrong (range=$r1 write=$r2)"
ps P10 Decisions --to-topic decisions --entry 1 >/dev/null 2>&1
q=$( cd "$PW" && python3 "$ENG" check --no-rebuild 2>&1 | grep -c 'the moved entry is lost' ); rm "$PW/works/phases/active/P10/topics/decisions.md"
lost=$( cd "$PW" && python3 "$ENG" check --no-rebuild 2>&1 ); lost_rc=$?
[ "$q" = 0 ] && [ "$lost_rc" -eq 0 ] && printf '%s\n' "$lost" | grep -q 'phase P10: phase.md ## Decisions entry 1 points at topics/decisions.md, which does not exist: the moved entry is lost' \
  && ok "validate stays quiet on a good pointer and warns on a dangling one (a lost decision), exit 0" || bad "dangling-pointer warning wrong (quiet=$q rc=$lost_rc) -- $lost"
# The required step (design §6): over 40 KB, next / slice start / the card print it; silent under budget and when done.
newtmp NBW; cp -R "$F/.." "$NBW/ws"; NW="$NBW/ws/.sikstack"; rm -rf "$NW/works/phases/active/"* "$NW/works/phases/archived/"*; nb() { ( cd "$NW" && python3 "$ENG" "$@" ); }
nb phase new --phase P11 --name "Step probe" --objective "step probe" >/dev/null 2>&1; NP="$NW/works/phases/active/P11/phase.md"
nb slice start P11.DECOMP >/dev/null 2>&1; base=$(nb next 2>&1); base_card=$(nb next --card 2>&1)
python3 - "$NP" <<'SEED'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
dec = "".join(f"- **D{n}:** decision {n}. " + "detail " * 400 + "\n" for n in range(1, 18))
p.write_text(t.replace("`topics/breakdown.md`._\n", "`topics/breakdown.md`._\n\n" + dec, 1))
SEED
out=$(nb next 2>&1); card=$(nb next --card 2>&1); st=$(nb slice status P11.DECOMP todo >/dev/null 2>&1; nb slice start P11.DECOMP 2>&1)
printf '%s\n' "$out" | grep -q '^notebook_over_budget=P11 ([0-9]* of 40960 B) -- advice: move long entries to topics before the next dispatch (gists stay, nothing is lost)$' \
  && printf '%s\n' "$out" | grep -qx 'notebook_move=section P11 "Decisions" --to-topic decisions --entry 1-17' \
  && printf '%s\n' "$card" | grep -q '^notebook: over budget ([0-9]*/40960 B) -- run the notebook_move lines `next` prints before the next dispatch$' \
  && printf '%s\n' "$st" | grep -qx 'started P11.DECOMP' && printf '%s\n' "$st" | grep -q '^warning: notebook P11 is over budget ' \
  && ok "over 40 KB with a long entry, next prints the advice step and its move, the card one line, slice start a warning and still starts" || bad "advice step wrong -- $out / $st"
nb section P11 Decisions --to-topic decisions --entry 1-17 >/dev/null 2>&1
[ "$(nb next 2>&1)" = "$base" ] && [ "$(nb next --card 2>&1)" = "$base_card" ] \
  && ok "after the move the notebook is under budget and next and the card are byte-identical to before" || bad "under-budget next or card changed after the move"
python3 - "$NP" <<'SEED'
import pathlib, sys
p = pathlib.Path(sys.argv[1]); t = p.read_text()
oq = "".join(f"- **OQ{n} (S1):** question {n}? " + "context " * 400 + "\n" for n in range(1, 18))
p.write_text(t.replace("## Operator Questions\n", "## Operator Questions\n\n" + oq, 1))
SEED
out=$(nb next 2>&1)
printf '%s\n' "$out" | grep -q '^notebook_over_budget=P11 ([0-9]* of 40960 B) -- advisory: nothing left to move (Slices [0-9]* B generated; Operator Questions [0-9]* B: collapse answered entries with --resolve OQ<n> --pointer <ref>)$' \
  && ! printf '%s\n' "$out" | grep -q '^notebook_move=' \
  && ok "when nothing can move, next prints the advisory step and no notebook_move line" || bad "advisory step wrong -- $out"
nb phase status P11 done >/dev/null 2>&1
! nb next 2>&1 | grep -q 'notebook' && ! nb next --card 2>&1 | grep -q '^notebook:' \
  && ok "a done phase over budget prints no step in next or the card" || bad "a done phase still prints the step"

# ---------------------------------------------------------------------------
echo "== Test 10d: P42 the ready set -- an undeclared phase keeps its plain pointer, a declared dependency binds =="
# On a copy of $F emptied of its phases: P1 is undeclared (the pointer, as before); P2 is declared and read through next once P1 is done.
newtmp RSW; cp -R "$F/.." "$RSW/ws"; SW="$RSW/ws/.sikstack"; rm -rf "$SW/works/phases/active/"* "$SW/works/phases/archived/"*; rs() { ( cd "$SW" && python3 "$ENG" "$@" ); }
{ for n in 1 2; do rs phase new --phase "P$n" --name "Ready probe $n" --objective "ready probe" && rs slice finish "P$n.DECOMP" --outcome cut; done \
  && rs slice new --phase P1 --slice P1.S1 --name s1 && rs slice new --phase P1 --slice P1.S2 --name s2 \
  && rs slice new --phase P2 --slice P2.S1 --name s1 --depends-on none && rs slice new --phase P2 --slice P2.S2 --name s2 --depends-on P2.S1; } >/dev/null 2>&1 \
  || bad "ready-set probe: setup failed"
plain=$(rs next 2>&1); card=$(rs next --card 2>&1)
printf '%s\n' "$plain" | grep -qx 'current_slice=P1.S1' \
  && ! printf '%s\n%s\n' "$plain" "$card" | grep -q -e '^ready_slices=' -e '^running_slices=' -e '^wave: ' \
  && ok "an undeclared phase's ready set is its first open slice alone: next and the card print no ready, running or wave line" \
  || bad "undeclared phase output changed -- $plain / $card"
rs phase status P1 done >/dev/null 2>&1 || bad "ready-set probe: could not set P1 done"
r1=$(rs next 2>&1); rs slice start P2.S1 >/dev/null 2>&1; r2=$(rs next 2>&1); rs slice finish P2.S1 --outcome x >/dev/null 2>&1; r3=$(rs next 2>&1)
rs slice new --phase P2 --slice P2.S0 --name s0 --order 5 --depends-on P2.S2 >/dev/null 2>&1; fwd=$?
printf '%s\n' "$r1" | grep -qx 'ready_slices=P2.S1' && printf '%s\n' "$r2" | grep -qx 'ready_slices=none' && printf '%s\n' "$r2" | grep -qx 'running_slices=P2.S1' \
  && printf '%s\n' "$r3" | grep -qx 'ready_slices=P2.S2' && [ "$fwd" -ne 0 ] && [ ! -e "$SW/works/phases/active/P2/slices/P2.S0" ] \
  && ok "a declared slice is never ready before its dependency is done, and slice new refuses a dependency not ordered before it" \
  || bad "declared ready set wrong (fwd rc=$fwd) -- $r1 / $r2 / $r3"
{ rs slice start P2.S2 && rs slice finish P2.S2 --outcome x && rs slice start P2.REVIEW \
  && : > "$SW/works/phases/active/P2/slices/P2.REVIEW/result.md" && rs gate P2 require && rs gate P2 open --walkthrough probe; } >/dev/null 2>&1 \
  || bad "ready-set probe: could not open P2's acceptance gate"
gn=$(rs next 2>&1); gc=$(rs next --card 2>&1)
printf '%s\n' "$gn" | grep -qx 'waiting_on_operator=P2' && printf '%s\n' "$gc" | grep -q '^stop: phase P2 acceptance gate open ' \
  && ! printf '%s\n%s\n' "$gn" "$gc" | grep -q -e '^running_slices=' -e '^wave: ' \
  && ok "a declared phase at its open acceptance gate reads as a stop: the running REVIEW is a barrier, never a wave's running or returned slice" \
  || bad "declared gate reads as a wave -- $gn / $gc"
# v77: a decomposition that leaves a middle slice undeclared finishes with one advice: line naming it (it runs
# alone); slice deps declares one, and slice finish prints the engine's parallel plan. An explain phase is exempt.
{ rs phase new --phase P3 --name "Forced probe" --objective "forced declaration" && rs slice new --phase P3 --slice P3.S1 --name s1; } >/dev/null 2>&1 \
  || bad "forced-declaration probe: setup failed"
fr=$(rs slice finish P3.DECOMP --outcome cut 2>&1); fr_rc=$?; fr_done=$(grep -c '"status": "done"' "$SW/works/phases/active/P3/slices/P3.DECOMP/slice.json")
{ rs slice deps P3.S1 --depends-on none && rs slice new --phase P3 --slice P3.S2 --name s2 --depends-on none \
  && rs slice new --phase P3 --slice P3.S3 --name s3 --depends-on P3.S1; } >/dev/null 2>&1 || bad "forced-declaration probe: declaring failed"
fp=$(rs slice finish P3.DECOMP --outcome cut 2>&1); fp_rc=$?
{ rs phase new --phase P4 --name "Explain probe" --objective "explain exempt" && printf '\n## Explain\n\n- subject: P3\n' >> "$SW/works/phases/active/P4/intent.md" \
  && rs slice new --phase P4 --slice P4.S1 --name chapter; } >/dev/null 2>&1 || bad "forced-declaration probe: explain setup failed"
rs slice finish P4.DECOMP --outcome cut >/dev/null 2>&1; fe_rc=$?
[ "$fr_rc" -eq 0 ] && [ "$fr_done" -eq 1 ] && [ "$(printf '%s\n' "$fr" | grep -c '^advice: ')" -eq 1 ] \
  && printf '%s\n' "$fr" | grep -q '^advice: P3.S1 is a middle slice left undeclared, so it runs alone: .*slice deps P3.S1 --depends-on' \
  && [ "$fp_rc" -eq 0 ] && ! printf '%s\n' "$fp" | grep -q '^advice:' && printf '%s\n' "$fp" | grep -qx 'parallel_plan=P3: S1 + S2 -> S3 -> REVIEW' \
  && printf '%s\n' "$fp" | grep -q '^parallel_rounds=3 rounds for 4 open slices; 2 run beside another' && [ "$fe_rc" -eq 0 ] \
  && ok "a decomposition finishing over an undeclared middle slice prints one advice: line naming it, slice deps declares it, slice finish prints the engine's parallel plan, and an explain phase is exempt (v77)" \
  || bad "declaration advice wrong (advice rc=$fr_rc, pass rc=$fp_rc, explain rc=$fe_rc) -- $fr / $fp"

# ---------------------------------------------------------------------------
echo "== Test 10e: ids -- P<n>-<tail> minted with the next number beside P<n> and v73's P- tokens, an archived id is spent, two branches mint the same number and merge clean =="
# On a copy of $F emptied of its phases and git history. Explicit P<n>, tailed and v73 token ids keep working.
newtmp MIW; cp -R "$F/.." "$MIW/ws"; MW="$MIW/ws/.sikstack"; rm -rf "$MW/.git" "$MW/works/phases/active/"* "$MW/works/phases/archived/"*
mi() { ( cd "$MW" && python3 "$ENG" "$@" ); }
tail_re='([a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])'  # two Crockford symbols, a letter among them
m1=$(mi phase new --name "Minted" --objective "mint probe" 2>&1); mp=$(printf '%s\n' "$m1" | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
printf '%s\n' "$mp" | grep -qxE "P1-$tail_re" && [ -d "$MW/works/phases/active/$mp/slices/$mp.DECOMP" ] && [ -d "$MW/works/phases/active/$mp/slices/$mp.REVIEW" ] \
  && ok "phase new without --phase mints P1-<tail> on an empty workspace (two Crockford symbols, a letter among them) with its DECOMP and REVIEW" \
  || bad "minted ids wrong -- $m1"
pm=$(mi phase new --name "to promote" --objective probe 2>&1); pp=$(printf '%s\n' "$pm" | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
printf '%s\n' "$pp" | grep -qxE "P2-$tail_re" && ok "the next phase new mints the next number (P2-<tail> after P1-<tail>)" || bad "phase new did not mint the next number -- $pm"
mi phase archive "$pp" --force >/dev/null 2>&1; arch=$(ls "$MW/works/phases/archived")
re_tok=$(mi phase new --phase "$pp" --name again --objective again 2>&1); re_act=$(mi phase new --phase "$mp" --name again --objective again 2>&1)
nact=$(ls "$MW/works/phases/active" | wc -l | tr -d ' ')
p3=$(mi phase new --name "After archive" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
printf '%s\n' "$arch" | grep -qE "^[0-9]{8}_[0-9]{6}_${pp}_to_promote$" && printf '%s\n' "$re_tok" | grep -q "phase already exists (archived): $pp" \
  && printf '%s\n' "$re_act" | grep -q "phase already exists: $mp" && [ "$nact" = 1 ] \
  && printf '%s\n' "$p3" | grep -qxE "P3-$tail_re" \
  && ok "a tailed phase archives as <stamp>_P2-<tail>_<slug>; phase new refuses an explicit id that exists active or archived (an archived id is spent); the next mint counts the archived P2 (P3-<tail>)" \
  || bad "archived tailed id not spent, or the next number missed it -- $arch / $re_tok / $re_act / $nact / $p3"
( for n in 9 10; do mi phase new --phase "P$n" --name "Numeric $n" --objective probe || exit 1; done \
  && mi phase new --phase P11-ab --name "Tailed 11" --objective probe ) >/dev/null 2>&1 || bad "mixed-id probe: setup failed"
p12=$(mi phase new --name "After P11-ab" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
printf '%s\n' "$p12" | grep -qxE "P12-$tail_re" \
  && ok "an explicit tailed id counts toward the next number (after P9, P10 and P11-ab a mint draws P12-<tail>)" || bad "the mint missed the tailed P11-ab -- $p12"
( mi phase new --phase P46-k2 --name "Tailed 46" --objective probe && mi phase new --phase P-7kq2 --name "Token" --objective probe ) >/dev/null 2>&1 \
  || bad "mixed-id probe: could not add P46-k2 or P-7kq2"
val_mix=$(mi check --no-rebuild 2>&1); val_rc=$?
[ "$val_rc" -eq 0 ] && printf '%s\n' "$val_mix" | grep -q '^Workflow validation passed' \
  && ok "mixed phase ids (P9, P10, P11-ab, P12-<tail>, P46-k2, P-7kq2) validate" || bad "mixed phase ids invalid -- $val_mix"
# Two branches of one repo each mint a phase unseen by the other, so both draw number 1: the merge conflicts in
# generated files only, and taking either side then `check` (payload/gitattributes) leaves both phases, valid,
# and the shared number is refused until the tail is typed.
newtmp TBW; cp -R "$F/.." "$TBW/ws"; TW="$TBW/ws/.sikstack"; rm -rf "$TW/.git" "$TW/works/phases/active/"* "$TW/works/phases/archived/"*; : > "$TW/works/events.jsonl"
tw() { ( cd "$TW" && python3 "$ENG" "$@" ); }
tg() { git -C "$TW" -c user.email=smoke@example.invalid -c user.name=smoke "$@"; }
( tw check && tg init -q && tg add -A && tg commit -q --allow-empty -m base \
  && tg checkout -q -b one && tw phase new --name "Branch one" --objective one && tg add -A && tg commit -qm one \
  && tg checkout -q - && tg checkout -q -b two && tw phase new --name "Branch two" --objective two ) >/dev/null 2>&1 \
  || bad "two-branch probe: setup failed"
tb_p1=$(tg show --name-only --format= one | sed -n 's|^works/phases/active/\([^/]*\)/phase.json$|\1|p')
# Deterministic: a same-tail draw (1 in 924) is the add/add conflict the engine documents, never a silent mix -- so
# when branch two drew branch one's tail, it redoes its side with an explicit, distinct tail.
if [ -d "$TW/works/phases/active/$tb_p1" ]; then
  tb_t=ab; [ "$tb_p1" = P1-ab ] && tb_t=ac
  ( tg reset -q --hard && tg clean -qfd && tw phase new --phase "P1-$tb_t" --name "Branch two" --objective two ) >/dev/null 2>&1 || bad "two-branch probe: the same-tail redo failed"
fi
( tg add -A && tg commit -qm two ) >/dev/null 2>&1 || bad "two-branch probe: branch two did not commit"
tg merge -q --no-edit one >/dev/null 2>&1; conflicted=$(tg diff --name-only --diff-filter=U | tr '\n' ' ')
outside=$(printf '%s\n' $conflicted | grep -vxE 'works/(state\.json|index\.json|backlog\.md|agenda\.md)')
( for f in $conflicted; do tg checkout --theirs -- "$f" || exit 1; done; tw check && tg add -A && tg commit -qm merge ) >/dev/null 2>&1
tb_val=$(tw check --no-rebuild 2>&1); tb_rc=$?; tb_run=$(tw gate 1 2>&1); tb_run_rc=$?
[ -z "$outside" ] && [ "$(ls "$TW/works/phases/active" | grep -cE "^P1-$tail_re$")" = 2 ] \
  && [ "$tb_rc" -eq 0 ] && [ -z "$(tg status --porcelain)" ] && [ "$(grep -c '"type": "phase_created"' "$TW/works/events.jsonl")" = 2 ] \
  && [ "$tb_run_rc" -ne 0 ] && printf '%s\n' "$tb_run" | grep -qE "names 2 phases numbered 1: .*P1-$tail_re.*P1-$tail_re.*type the tail" \
  && ok "two branches each mint a phase with the same number (P1-) and merge with conflicts only in generated files (${conflicted:-none}); either side + rebuild validates, and gate 1 then lists both" \
  || bad "two-branch mint did not merge clean -- conflicted: $conflicted / outside: $outside / $tb_val / $tb_run"

# ---------------------------------------------------------------------------
echo "== Test 10f: brief names -- 13 / P13 name the one P13-<tail>, a shared number is refused and listed, an exact P12 wins, 7kq2 / P-7kq2 still name a v73 id =="
# A copy of $F emptied of its phases: a v73 token phase beside P12 and P12-ab. Brief names go through one choke point after argparse.
newtmp BNW; cp -R "$F/.." "$BNW/ws"; BN="$BNW/ws/.sikstack"; rm -rf "$BN/.git" "$BN/works/phases/active/"* "$BN/works/phases/archived/"*; bn() { ( cd "$BN" && python3 "$ENG" "$@" ); }
bn_pid=7kq2; bn_up=7KQ2
( bn phase new --phase "P-$bn_pid" --name "Brief" --objective probe && bn phase new --phase 12 --name "Numbered" --objective probe \
  && bn phase new --phase P12-ab --name "Twelve tailed" --objective probe ) >/dev/null 2>&1 || bad "brief-name probe: setup failed"
bn_gate=$(bn gate "$bn_pid" waive --note probe 2>&1); bn_show=$(bn gate "p-$bn_up" 2>&1); bn_old=$(bn gate 12 2>&1); bn_bad=$(bn gate "P$bn_pid" 2>&1); bn_bad_rc=$?
printf '%s\n' "$bn_gate" | grep -qx "phase P-$bn_pid: operator acceptance WAIVED -- probe" && printf '%s\n' "$bn_show" | grep -qx "phase=P-$bn_pid" && printf '%s\n' "$bn_old" | grep -qx 'phase=P12' \
  && [ "$bn_bad_rc" -ne 0 ] && printf '%s\n' "$bn_bad" | grep -q "not a phase id" \
  && ok "a phase argument takes the brief name (gate 7kq2, p-7KQ2, 12) and refuses P7kq2 with the shapes" || bad "brief names on commands wrong -- $bn_gate / $bn_show / $bn_old / $bn_bad"
bn_t=$(bn phase new --name "Tailed" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p'); bn_tu=$(printf '%s' "${bn_t#P13-}" | tr '[:lower:]' '[:upper:]')
bn_ag=$(bn gate p13 2>&1); bn_agt=$(bn gate "p13-$bn_tu" 2>&1)
bn_sl=$(bn slice new --phase 13 --slice 13.S1 --name brief --kind implementation --risk low --depends-on none 2>&1)
bn_t2=ab; [ "$bn_t" = P13-ab ] && bn_t2=ac
bn phase new --phase "13-$bn_t2" --name "Twin" --objective probe >/dev/null 2>&1 || bad "brief-name probe: the twin P13-$bn_t2 failed"
bn_amb=$(bn gate 13 2>&1); bn_amb_rc=$?; bn_full=$(bn gate "p13-$(printf '%s' "$bn_t2" | tr '[:lower:]' '[:upper:]')" 2>&1)
printf '%s\n' "$bn_t" | grep -qxE "P13-$tail_re" && printf '%s\n' "$bn_agt" | grep -qx "phase=$bn_t" && printf '%s\n' "$bn_ag" | grep -qx "phase=$bn_t" \
  && printf '%s\n' "$bn_sl" | grep -q "^created slice $bn_t.S1: " \
  && [ "$bn_amb_rc" -ne 0 ] && printf '%s\n' "$bn_amb" | grep -q "names 2 phases numbered 13: .*type the tail" && printf '%s\n' "$bn_full" | grep -qx "phase=P13-$bn_t2" \
  && ok "a bare phase new mints the next number over P12 and P12-ab ($bn_t); p13 and p13-<TAIL> name it while it is the only P13 (gate, slice new --slice 13.S1); a second P13 makes 13 a refusal listing both, and 13-<tail> still names one" \
  || bad "the number lookup is wrong -- $bn_t / $bn_agt / $bn_ag / $bn_sl / $bn_amb / $bn_full"

# ---------------------------------------------------------------------------
echo "== Test 10i: agenda -- agendas, ids, transitions, order, links, the generated page, validate, two branches (the gate's exemption for an added agenda: Test 12) =="
# A fresh install. Agendas live in works/agenda/<AID>/agenda.json; works/agenda.md (beside works/backlog.md, 0.8.0), index.json's
# agenda keys and the backlog's count are generated from them; an agenda never moves `next`.
newtmp AGW; AG="$AGW/ws"
mkws AG >/dev/null 2>&1 || bad "agenda probe: fresh install failed"
ag() { ( cd "$AG" && python3 "$ENG" "$@" ); }
ag_tree() { ( cd "$AG" && find works -type f ! -name '*.md' ! -name index.json ! -name state.json | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
ag_items() { ( cd "$AG/works/agenda" && for f in */agenda.json; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
ag_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], "<absent>"))' "$AG/works/agenda/$1/agenda.json" "$2"; }
ag_order() { ag agenda --json | python3 -c 'import json,sys; print(" ".join(i["id"] for i in json.load(sys.stdin)))'; }
tail_re='([a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])'
# (a) the generated page and the index, before any item and after: stable bytes, the keys, the backlog line.
pg0=$(sha "$AG/works/agenda.md" 2>/dev/null); rm -f "$AG/works/agenda.md"; sleep 1  # a stamp would move with the clock
ag check >/dev/null 2>&1; pg1=$(sha "$AG/works/agenda.md" 2>/dev/null)
ag_idx() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(not ("agenda_counts" in d and "agenda" in d))' "$AG/works/index.json"; }
[ -n "$pg0" ] && [ "$pg0" = "$pg1" ] && [ ! -e "$AG/agenda.md" ] && [ ! -e "$AG/backlog.md" ] && ag_idx && grep -qxF -e '- Open agendas: `0`' "$AG/works/backlog.md" \
  && ok "a fresh install has works/agenda.md beside works/backlog.md (neither at the root) with no agenda, byte-identical across rebuilds; index.json has agenda_counts and agenda; backlog.md says Open agendas: 0" \
  || bad "the empty agenda page or index keys missing -- [$pg0] [$pg1] $(grep -F 'agenda' "$AG/works/backlog.md")"
# (b) ids: A1-<tail> first, its own number sequence, an explicit tailed id once, brief forms.
a1=$(ag agenda-add --title "first" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
a2=$(ag agenda-add --title "second" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
p1=$(ag phase new --name "Plain" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
ex1=$(ag agenda-add --id A13-n1 --title "thirteen" --author person:smoke 2>&1); ex2=$(ag agenda-add --id A13-n1 --title "again" --author person:smoke 2>&1); ex2_rc=$?
ag agenda-edit 1 --title "first, by 1" >/dev/null 2>&1; ag agenda-edit A2 --title "second, by A2" >/dev/null 2>&1
printf '%s\n' "$a1" | grep -qxE "A1-$tail_re" && printf '%s\n' "$a2" | grep -qxE "A2-$tail_re" \
  && printf '%s\n' "$p1" | grep -qxE "P1-$tail_re" \
  && [ "$ex1" = "added A13-n1: thirteen" ] && [ "$ex2_rc" -ne 0 ] && [ "$(printf '%s\n' "$ex2" | wc -l | tr -d ' ')" = 1 ] \
  && [ "$(ag_key "$a1" title)" = "first, by 1" ] && [ "$(ag_key "$a2" title)" = "second, by A2" ] \
  && ok "agenda-add mints A1-<tail> then A2-<tail> and spends no phase number (P1- next); --id A13-n1 is taken once and refused in one line after; 1 and A2 name their items" \
  || bad "agenda ids wrong -- $a1 / $a2 / $p1 / $ex1 / $ex2"
# (c) transitions: propose (Open -> Proposed, the stored shape `open` + `proposed`), accept, solve with an outcome,
# reopen, drop with a reason, reopen (both cleared); a refused transition is one line and non-zero; a bulk call with
# one bad id writes nothing; agenda-defer is gone (an unknown command, exit 2).
st=""
for step in "agenda-propose $a2 --author person:smoke" "agenda-accept $a2" "agenda-solve $a2 --outcome shipped" "agenda-reopen $a2" "agenda-drop $a2 --reason dup" "agenda-reopen $a2"; do
  ag $step >/dev/null 2>&1 || st="$st [refused: $step]"
  st="$st $(ag_key "$a2" status)/$(ag_key "$a2" outcome)/$(ag_key "$a2" reason)/$([ "$(ag_key "$a2" proposed)" = "<absent>" ] && echo - || echo P)"
done
rf=$(ag agenda-reopen "$a1" 2>&1); rf_rc=$?
tr0=$(ag_tree); bk=$(ag agenda-propose A13 A99-zz --author person:smoke 2>&1); bk_rc=$?; tr1=$(ag_tree)
df=$(ag agenda-defer A13 2>&1); df_rc=$?; tr2=$(ag_tree)
[ "$st" = " open/None/None/P open/None/None/- solved/shipped/None/- open/None/None/- dropped/None/dup/- open/None/None/-" ] \
  && [ "$rf_rc" -ne 0 ] && [ "$(printf '%s\n' "$rf" | wc -l | tr -d ' ')" = 1 ] \
  && [ "$bk_rc" -ne 0 ] && [ "$tr0" = "$tr1" ] && [ "$(ag_key A13-n1 status)" = open ] \
  && [ "$df_rc" -eq 2 ] && printf '%s\n' "$df" | grep -q "invalid choice: 'agenda-defer'" && [ "$tr1" = "$tr2" ] \
  && ok "propose (stored open + proposed), accept, solve --outcome, reopen, drop --reason, reopen (outcome and reason cleared); reopening an Open agenda is refused in one line; agenda-propose A13 A99-zz changes nothing; agenda-defer is an unknown command" \
  || bad "agenda transitions wrong -- $st / $rf / $bk / rc=$df_rc $(printf '%s\n' "$df" | tail -1)"
uo=$(ag agenda-add --title x --author person:smoke --bogus 2>&1); uo_rc=$?; tr2=$(ag_tree)
[ "$uo_rc" -eq 2 ] && [ "$(printf '%s\n' "$uo" | wc -l | tr -d ' ')" = 1 ] && [ "$tr1" = "$tr2" ] \
  && ok "an unknown option on an agenda command (agenda-add --bogus) is one line, exit 2, nothing written" \
  || bad "an unknown agenda option is not one line and exit 2 (rc=$uo_rc) -- $uo"
# (d) order: the newest item first, a reopened item last, a move rewrites only the moved item's file.
o1=$(ag_order); it0=$(ag_items); ag agenda-move A13 --last >/dev/null 2>&1; it1=$(ag_items)
moved=$(diff <(printf '%s\n' "$it0") <(printf '%s\n' "$it1") | sed -n 's/^> \([^/]*\)\/.*/\1/p' | tr '\n' ' ')
[ "$o1" = "A13-n1 $a1 $a2" ] && [ "$moved" = "A13-n1 " ] && [ "$(ag_order)" = "$a1 $a2 A13-n1" ] \
  && ok "a new item lists first and a reopened one last ($o1); agenda-move --last rewrites only the moved item's agenda.json" \
  || bad "agenda order wrong -- $o1 / moved: $moved / $(ag_order)"
# (e) links: phase new --agenda links and the item reads In progress; a second item cannot take that phase;
# no agenda command changes `next`; agenda-delete clears the link and the phase stays, with no agenda key.
p2=$(ag phase new --name "Linked" --objective probe --agenda 1 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
nx1=$(ag next 2>&1); lk=$(ag agenda-link 2 --phase "$p2" 2>&1); lk_rc=$?
shown=$(ag agenda 2>&1 | grep "^$a1 ")
ag agenda-add --title "noise" --author person:smoke >/dev/null 2>&1; ag agenda-propose 14 --author person:smoke >/dev/null 2>&1; ag agenda-move A13 --first >/dev/null 2>&1; nx2=$(ag next 2>&1)
dl=$(ag agenda-delete "$a1" 2>&1); dl_rc=$?; nx3=$(ag next 2>&1)
pj="$AG/works/phases/active/$p2/phase.json"
[ -n "$p2" ] && [ "$lk_rc" -ne 0 ] && printf '%s\n' "$shown" | grep -q 'In progress' \
  && [ "$nx1" = "$nx2" ] && [ "$nx2" = "$nx3" ] \
  && [ "$dl_rc" -eq 0 ] && [ -f "$pj" ] && ! grep -q '"agenda"' "$pj" && [ ! -d "$AG/works/agenda/$a1" ] \
  && ok "phase new --agenda links $p2 and $a1 reads In progress; a second item cannot take it ($lk); agenda commands leave next unchanged; agenda-delete clears the link and the phase stays with no agenda key" \
  || bad "agenda links wrong -- $p2 / $lk / $shown / $dl / next changed: $([ "$nx1" = "$nx2" ] && [ "$nx2" = "$nx3" ] && echo no || echo yes)"
grep -qxF -e '- Open agendas: `2`' "$AG/works/backlog.md" && [ "$(sha "$AG/works/agenda.md")" != "$pg0" ] \
  && ok "the backlog counts Open and In progress agendas, never a Proposed one (2), and agenda.md follows the agendas" \
  || bad "the backlog count or the agenda page did not follow -- $(grep -F 'agenda' "$AG/works/backlog.md")"
# (f) validate: a `Z` stamp (JavaScript's toISOString form) passes on every Python, 3.9 and 3.10 included
# (the engine reads its own stamp form, never fromisoformat); a dangling link is a warning (validate passes);
# a corrupt agenda.json still rebuilds (check, exit 1) and fails validate, naming the folder.
z_dir=$(cd "$AG/works/agenda" && ls -d A*-* | grep -vx 'A13-n1' | head -n 1)
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["changed_at"]="2026-11-17T10:00:00.123Z"; open(p,"w").write(json.dumps(d, indent=2)+"\n")' "$AG/works/agenda/$z_dir/agenda.json"
z_val=$(ag check --no-rebuild 2>&1); z_rc=$?
[ -n "$z_dir" ] && [ "$z_rc" -eq 0 ] && ! printf '%s\n' "$z_val" | grep -q "agenda/$z_dir" \
  && ok "an agenda item whose changed_at ends in Z (2026-11-17T10:00:00.123Z) passes validate on $(python3 -V 2>&1)" \
  || bad "a Z changed_at failed validate on $(python3 -V 2>&1) -- $z_dir / $z_rc -- $(printf '%s\n' "$z_val" | grep -i agenda)"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["agenda"]="A77-zz"; open(p,"w").write(json.dumps(d, indent=2)+"\n")' "$pj"
v1=$(ag check --no-rebuild 2>&1); v1_rc=$?
printf '{' > "$AG/works/agenda/A13-n1/agenda.json"
rb=$(ag check 2>&1); rb_rc=$?; v2=$(ag check --no-rebuild 2>&1); v2_rc=$?
[ "$v1_rc" -eq 0 ] && printf '%s\n' "$v1" | grep -q "^warning: .*$p2.*A77-zz" \
  && [ "$rb_rc" -eq 1 ] && printf '%s\n' "$rb" | grep -qx 'rebuilt workflow' && [ "$v2_rc" -ne 0 ] && printf '%s\n' "$v2" | grep -q 'works/agenda/A13-n1' \
  && ok "a dangling agenda link is a validate warning (exit 0); a corrupt agenda.json still rebuilds and fails check naming works/agenda/A13-n1" \
  || bad "agenda validate wrong -- $v1_rc / $rb_rc / $v2_rc -- $(printf '%s\n' "$v1" "$v2" | grep -i agenda)"
# A hand-edited field can hold any JSON value: a list-valued status leaves rebuild and next at 0 (no traceback)
# and fails validate, naming the folder and the key.
ls_dir=$(cd "$AG/works/agenda" && ls -d A*-* | grep -vx 'A13-n1' | head -n 1)
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["status"]=[1]; open(p,"w").write(json.dumps(d, indent=2)+"\n")' "$AG/works/agenda/$ls_dir/agenda.json"
ls_rb=$(ag check 2>&1); ls_rb_rc=$?; ls_nx=$(ag next 2>&1); ls_nx_rc=$?; ls_v=$(ag check --no-rebuild 2>&1); ls_v_rc=$?
[ -n "$ls_dir" ] && [ "$ls_rb_rc" -eq 1 ] && printf '%s\n' "$ls_rb" | grep -qx 'rebuilt workflow' && [ "$ls_nx_rc" -eq 0 ] && [ "$ls_v_rc" -ne 0 ] \
  && printf '%s\n' "$ls_v" | grep -q "works/agenda/$ls_dir: status \[1\]" && ! printf '%s\n' "$ls_rb" "$ls_nx" "$ls_v" | grep -q Traceback \
  && ok "a list-valued agenda status still rebuilds, leaves next at exit 0 and fails check naming works/agenda/$ls_dir" \
  || bad "a list-valued agenda status broke a read or passed validate -- $ls_dir / $ls_rb_rc / $ls_nx_rc / $ls_v_rc -- $(printf '%s\n' "$ls_rb" "$ls_nx" "$ls_v" | grep -iE 'agenda|Traceback|Error' | tail -3)"
# The same item is refused as unusable, in one line naming its file and agenda-delete, never "reopen it first" (which
# would be refused too); nothing is written. A13-n1 goes first: every agenda command reads every item.
rm -rf "$AG/works/agenda/A13-n1"; ls_t0=$(ag_tree); ls_df=$(ag agenda-propose "$ls_dir" --author person:smoke 2>&1); ls_df_rc=$?
[ -n "$ls_dir" ] && [ "$ls_df_rc" -eq 1 ] && [ "$(printf '%s\n' "$ls_df" | wc -l | tr -d ' ')" = 1 ] \
  && printf '%s\n' "$ls_df" | grep -qF "works/agenda/$ls_dir/agenda.json" && printf '%s\n' "$ls_df" | grep -qF "agenda-delete $ls_dir" \
  && ! printf '%s\n' "$ls_df" | grep -q reopen && [ "$(ag_tree)" = "$ls_t0" ] \
  && ok "agenda-propose of an agenda with a list-valued status is refused in one line naming works/agenda/$ls_dir/agenda.json and agenda-delete, not reopen; nothing written" \
  || bad "an unusable agenda status is refused without its file or way out -- rc=$ls_df_rc -- $(printf '%s\n' "$ls_df" | head -2 | cut -c1-240)"
# (g) two branches each add an item: the merge conflicts in generated files only, and either side + rebuild lists both.
newtmp AGB; AB="$AGB/ws"; mkws AB >/dev/null 2>&1 || bad "agenda probe: second install failed"
ab() { ( cd "$AB" && python3 "$ENG" "$@" ); }
abg() { git -C "$AB" -c user.email=smoke@example.invalid -c user.name=smoke "$@"; }
( abg init -q && abg add -A && abg commit -q --allow-empty -m base \
  && abg checkout -q -b one && ab agenda-add --id A1-ab --title one --author person:smoke && abg add -A && abg commit -qm one \
  && abg checkout -q - && abg checkout -q -b two && ab agenda-add --id A1-ac --title two --author person:smoke && abg add -A && abg commit -qm two ) >/dev/null 2>&1 \
  || bad "agenda two-branch probe: setup failed"
abg merge -q --no-edit one >/dev/null 2>&1; ab_conf=$(abg diff --name-only --diff-filter=U | tr '\n' ' ')
ab_out=$(printf '%s\n' $ab_conf | grep -vxE 'works/(state\.json|index\.json|backlog\.md|agenda\.md)')
( for f in $ab_conf; do abg checkout --theirs -- "$f" || exit 1; done; ab check && abg add -A && abg commit -qm merge ) >/dev/null 2>&1
ab_val=$(ab check --no-rebuild 2>&1); ab_rc=$?
[ -n "$ab_conf" ] && [ -z "$ab_out" ] && [ "$ab_rc" -eq 0 ] && [ -z "$(abg status --porcelain)" ] \
  && [ "$(ab agenda 2>&1 | grep -cE '^A1-a[bc] ')" = 2 ] && grep -q 'A1-ab' "$AB/works/agenda.md" && grep -q 'A1-ac' "$AB/works/agenda.md" \
  && ok "two branches each add an item (A1-ab, A1-ac) and merge with conflicts only in generated files ($ab_conf); either side + rebuild lists both, valid and clean" \
  || bad "agenda two-branch merge wrong -- conflicted: $ab_conf / outside: $ab_out / $ab_val"

# ---------------------------------------------------------------------------
echo "== Test 10j: agenda threads (0.3.0) -- an entry is one new file and never rewrites agenda.json, an item takes two phases, an agent's item waits as Proposed until agenda-accept, agenda-merge is all or none, check names each malformed entry, agenda-fold carries every open deferred job once, two clones' entries merge with no truth-file conflict =="
newtmp THW; TH="$THW/ws"; mkws TH >/dev/null 2>&1 || bad "thread probe: fresh install failed"
th() { ( cd "$TH" && python3 "$ENG" "$@" ); }
th_tree() { ( cd "$TH" && find works -type f ! -name '*.md' ! -name index.json ! -name state.json ! -name events.jsonl | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
th_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], "<absent>"))' "$TH/works/agenda/$1/agenda.json" "$2"; }
# (a) a person's note and an agent's issue on one item: one new file each, agenda.json byte-identical, both shown in
# time order with kind, author, source and date; the item stays Open.
ta=$(th agenda-add --title "threaded" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
ta_sha=$(sha "$TH/works/agenda/$ta/agenda.json")
te1=$(th agenda-entry 1 --kind note --author person:smoke --source phase:P1 --body "a person's note" 2>&1); te1_n=$(ls "$TH/works/agenda/$ta/entries" 2>/dev/null | wc -l | tr -d ' ')
te2=$(th agenda-entry "$ta" --kind issue --author agent:claude-opus-5-5 --source slice:P1.S1 --body "an agent's issue" 2>&1); te2_n=$(ls "$TH/works/agenda/$ta/entries" 2>/dev/null | wc -l | tr -d ' ')
tshow=$(th agenda-show 1 2>&1)
tlines=$(printf '%s\n' "$tshow" | grep -E "^- $ta/[0-9a-z]{4}  " | sed -E 's/^- [^ ]+  //; s/  [0-9]{4}-[0-9]{2}-[0-9]{2}  / /')
[ -n "$ta" ] && [ "$te1_n" = 1 ] && [ "$te2_n" = 2 ] && [ "$(sha "$TH/works/agenda/$ta/agenda.json")" = "$ta_sha" ] \
  && printf '%s\n' "$te1" | grep -qE "^added item $ta/([0-9a-z]{4}) \([0-9]{8}T[0-9]{6}\.[0-9]{6}Z-\1\.json\): note by person:smoke \(phase:P1\)$" \
  && printf '%s\n' "$te2" | grep -qE "^added item $ta/.*: issue by agent:claude-opus-5-5 \(slice:P1\.S1\)$" \
  && [ "$tlines" = "$(printf 'open  note  by person:smoke (phase:P1)\nopen  issue  by agent:claude-opus-5-5 (slice:P1.S1)')" ] \
  && printf '%s\n' "$tshow" | grep -qx "$ta  Open  threaded" && printf '%s\n' "$tshow" | grep -qx 'items: 2 (2 open, 0 done, 0 dismissed)' \
  && ok "agenda-entry (agenda-item add's older name) writes exactly one new file under works/agenda/$ta/entries/ per item and leaves agenda.json byte-identical; agenda-show prints both in time order with their reference, state, kind, author, date and source; the agenda stays Open" \
  || bad "agenda entries wrong -- $te1 / $te2 / n=$te1_n,$te2_n / $tshow"
th_bad=""; for tb in "--kind memo --author person:x --source phase:P1 --body b" "--kind note --author someone --source phase:P1 --body b" \
    "--kind note --author person:x --source P1 --body b" "--kind note --author person:x --source phase:P1 --body ' '"; do
  tt0=$(th_tree); eval "th agenda-entry $ta $tb" > "$THW/tb.txt" 2>&1; tb_rc=$?
  { [ "$tb_rc" -ne 0 ] && [ "$(grep -c '' "$THW/tb.txt")" = 1 ] && [ "$(th_tree)" = "$tt0" ]; } || th_bad="$th_bad [$tb: rc=$tb_rc $(head -2 "$THW/tb.txt")]"
done
[ -z "$th_bad" ] && ok "agenda-entry refuses a bad kind, author, source or an empty body in one line, nothing written" || bad "a bad agenda-entry was not refused in one line --$th_bad"
# (b) one item carries two phases: the listing counts both, agenda-show names both.
tp1=$(th phase new --name "First" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
tp2=$(th phase new --name "Second" --objective probe 2>&1 | sed -n 's/^created phase \(P[^:]*\):.*/\1/p')
th agenda-link 1 --phase "$tp1" >/dev/null 2>&1; th agenda-link "$ta" --phase "$tp2" >/dev/null 2>&1
tl=$(th agenda 2>&1 | grep "^$ta "); ts=$(th agenda-show 1 2>&1 | grep '^phases: ')
printf '%s\n' "$tl" | grep -q 'In progress' && printf '%s\n' "$tl" | grep -qF '(0 of 2 phases done, 2 items, 2 open)' \
  && printf '%s\n' "$ts" | grep -q "$tp1" && printf '%s\n' "$ts" | grep -q "$tp2" \
  && ok "agenda-link takes two phases onto one agenda: agenda shows 0 of 2 phases done (and its 2 items, 2 open), agenda-show names both" \
  || bad "two phases on one item wrong -- $tl / $ts"
# (c) who opens an item: no --author is refused; an agent's item is Proposed, outside the open order, shown apart in
# agenda, works/agenda.md, index.json and backlog.md; it does not move; agenda-accept makes it Open, first.
tn=$(th agenda-add --title "anonymous" 2>&1); tn_rc=$?
tq=$(th agenda-add --title "an agent's idea" --author agent:claude-opus-5-5 2>&1); tq_id=$(printf '%s\n' "$tq" | sed -n 's/^added \(A[^:]*\):.*/\1/p')
tq2=$(th agenda-add --title "a stale idea" --author agent:claude-opus-5-5 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
tlist=$(th agenda 2>&1); tmv=$(th agenda-move "$tq_id" --first 2>&1); tmv_rc=$?
tmd=$(sed -n '/^## Proposed/,/^## Open/p' "$TH/works/agenda.md"); tmd_open=$(sed -n '/^## Open/,/^## Solved and dropped/p' "$TH/works/agenda.md")
tix=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r={x["id"]: x for x in d["agenda"]}; a=r[sys.argv[2]]; t=r[sys.argv[3]]; print(d["agenda_counts"]["proposed"], a["shown_status"], a["proposed"]["by"], t["entries"], t["latest_entry"] is not None)' "$TH/works/index.json" "$tq_id" "$ta")
[ "$tn_rc" -eq 2 ] && [ "$(printf '%s\n' "$tn" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$tn" | grep -q -- '--author' \
  && printf '%s\n' "$tq" | grep -qx "added $tq_id: an agent's idea (Proposed: agenda-accept or agenda-drop it)" \
  && [ "$(printf '%s\n' "$tlist" | head -2 | awk '{print $2}' | tr '\n' ' ')" = "Proposed Proposed " ] \
  && [ "$tmv_rc" -ne 0 ] && printf '%s\n' "$tmv" | grep -q "is Proposed" \
  && printf '%s\n' "$tmd" | grep -qF "| \`$tq_id\` | an agent's idea | agent:claude-opus-5-5 | - |" && ! printf '%s\n' "$tmd_open" | grep -qF "$tq_id" \
  && printf '%s\n' "$tmd_open" | grep -qE "\| \`$ta\` \| In progress \| threaded \| 0 of 2 phases done \| 2 of 2 open \([0-9]{4}-[0-9]{2}-[0-9]{2}\) \|" \
  && [ "$tix" = "2 Proposed agent:claude-opus-5-5 2 True" ] && grep -qxF -e '- Proposed agendas: `2`' "$TH/works/backlog.md" \
  && ! grep -qi 'deferred' "$TH/works/backlog.md" "$TH/works/agenda.md" \
  && ok "agenda-add without --author is refused in one line; an agent's agenda is Proposed: first in agenda, under ## Proposed in agenda.md (not in the open order), shown_status Proposed in index.json, counted in backlog.md; it does not move; the agenda's row shows how many of its items are open and the newest one's date" \
  || bad "Proposed wrong -- $tn / $tq / $(printf '%s\n' "$tlist" | head -3) / $tmv / $tix / $(grep -F 'agendas' "$TH/works/backlog.md")"
tac=$(th agenda-accept "$tq_id" 2>&1); tac_rc=$?; tdr=$(th agenda-drop "$tq2" --reason "a duplicate" 2>&1)
tac2=$(th agenda-accept "$ta" 2>&1); tac2_rc=$?
[ "$tac_rc" -eq 0 ] && printf '%s\n' "$tac" | grep -qx "accepted $tq_id: Open, 1 in the open order" && [ "$(th_key "$tq_id" proposed)" = "<absent>" ] \
  && th agenda 2>&1 | grep -qE "^$tq_id +Open " && [ "$(th agenda --json | python3 -c 'import json,sys; print([i["id"] for i in json.load(sys.stdin) if i["shown_status"] in ("Open", "In progress")][0])')" = "$tq_id" ] \
  && [ "$(th_key "$tq2" status)" = dropped ] && [ "$(th_key "$tq2" reason)" = "a duplicate" ] && [ "$(th_key "$tq2" proposed)" = "<absent>" ] \
  && [ "$tac2_rc" -ne 0 ] && printf '%s\n' "$tac2" | grep -q "only a Proposed agenda is accepted" \
  && ok "agenda-accept makes a Proposed item Open, first in the open order; agenda-drop --reason drops another; accepting an Open item is refused" \
  || bad "accept or drop of a Proposed item wrong -- $tac / $tdr / $tac2"
# (d) merge: every entry and phase link moves onto the target, each from-item Dropped `merged into`; a bad id changes nothing.
tm=$(th agenda-add --title "merge target" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
tt0=$(th_tree); tmb=$(th agenda-merge "$tm" "$ta" A99-zz 2>&1); tmb_rc=$?; tt1=$(th_tree)
tmg=$(th agenda-merge "$tm" "$ta" "$tq_id" 2>&1); tmg_rc=$?
tmn=$(ls "$TH/works/agenda/$tm/entries" 2>/dev/null | wc -l | tr -d ' ')
[ "$tmb_rc" -ne 0 ] && [ "$tt0" = "$tt1" ] && [ "$tmg_rc" -eq 0 ] && [ "$tmn" = 2 ] && [ ! -e "$TH/works/agenda/$ta/entries" ] \
  && [ "$(th_key "$ta" status)" = dropped ] && [ "$(th_key "$ta" reason)" = "merged into $tm" ] && [ "$(th_key "$tq_id" reason)" = "merged into $tm" ] \
  && grep -q "\"agenda\": \"$tm\"" "$TH/works/phases/active/$tp1/phase.json" && grep -q "\"agenda\": \"$tm\"" "$TH/works/phases/active/$tp2/phase.json" \
  && printf '%s\n' "$tmg" | grep -qx "merged $ta into $tm: 2 items and 2 phase links moved; $ta is Dropped (merged into $tm)" \
  && th check >/dev/null 2>&1 \
  && ok "agenda-merge moves every entry and phase link onto the target and drops each from-item (merged into $tm); with a bad id it changes nothing" \
  || bad "agenda-merge wrong -- rc=$tmb_rc/$tmg_rc n=$tmn / $tmb / $tmg"
# (e) check names each malformed entry in one line: a bad kind, author, source, stamp, file name, empty body.
tv=$(cd "$TH/works/agenda/$tm/entries" && ls | head -1); tvd="$TH/works/agenda/$tm/entries"
python3 - "$tvd/$tv" <<'PY'
import json, sys, os
src = sys.argv[1]; d = json.load(open(src)); folder = os.path.dirname(src); name = os.path.basename(src)
second = name.split(".")[0]
def put(n, **change):
    open(os.path.join(folder, n), "w").write(json.dumps({**d, **change}) + "\n")
put(second + ".000001Z-aaa1.json", kind="memo")
put(second + ".000002Z-aaa2.json", author="nobody")
put(second + ".000003Z-aaa3.json", source="P1")
put(second + ".000004Z-aaa4.json", created_at="2026-11-24 10:00")
put("entry-five.json")
put(second + ".000006Z-aaa6.json", body="   ")
PY
tvc=$(th check --no-rebuild 2>&1); tvc_rc=$?; tvl=$(printf '%s\n' "$tvc" | grep -c "works/agenda/$tm: item ")
for f in "$tvd"/*aaa* "$tvd/entry-five.json"; do rm -f "$f"; done; tvc2=$(th check --no-rebuild 2>&1); tvc2_rc=$?
[ "$tvc_rc" -ne 0 ] && [ "$tvl" = 6 ] && printf '%s\n' "$tvc" | grep -q "aaa1.json: kind 'memo' is not one of" && printf '%s\n' "$tvc" | grep -q "aaa2.json: author must be" \
  && printf '%s\n' "$tvc" | grep -q "aaa3.json: source must be" && printf '%s\n' "$tvc" | grep -q "aaa4.json: created_at must be" \
  && printf '%s\n' "$tvc" | grep -q "entry-five.json: its file name is not" && printf '%s\n' "$tvc" | grep -q "aaa6.json: body must be" \
  && [ "$tvc2_rc" -eq 0 ] \
  && ok "check fails on a malformed entry with one line each (kind, author, source, stamp, file name, empty body) and passes on valid ones" \
  || bad "entry validation wrong -- rc=$tvc_rc/$tvc2_rc lines=$tvl -- $(printf '%s\n' "$tvc" | grep 'item ' | head -6)"
# (e2) every entry input check names a bad value in one line and never raises: a created_at whose UTC second falls
# outside the years 0001-9999, an author past 120 characters, an author or source holding a line break by
# splitlines() (\x0b, \x0c, \x85, U+2028), a Proposed item's `by` holding one; an author of exactly 120 passes. The
# same form holds at agenda-entry and agenda-add.
python3 - "$tvd/$tv" "$TH/works/agenda/$tq_id/agenda.json" <<'PY'
import json, sys, os
src, item = sys.argv[1:]; d = json.load(open(src)); folder = os.path.dirname(src); second = os.path.basename(src).split(".")[0]
def put(n, **change):
    open(os.path.join(folder, f"{second}.{n:06d}Z-bb{n:02d}.json"), "w").write(json.dumps({**d, **change}) + "\n")
put(1, created_at="9999-12-31T23:59:59-01:00"); put(2, created_at="0001-01-01T00:00:00+01:00")
put(3, author="person:" + "x" * 119); put(4, author="person:" + "x" * 114)
for n, brk in enumerate(("\x0b", "\x0c", "\x85", " "), 5):
    put(n, author=f"person:a{brk}b"); put(n + 4, source=f"phase:a{brk}b")
put(13, author="person:" + "x" * 113)
i = json.load(open(item)); i["status"], i["proposed"] = "open", {"by": "agent:a\x0bb", "at": "2026-11-24T00:00:00Z"}
open(item, "w").write(json.dumps(i) + "\n")
PY
tvc=$(th check --no-rebuild 2>&1); tvc_rc=$?; tvl=$(printf '%s\n' "$tvc" | grep -c "works/agenda/$tm: item .*-bb[0-9]*\.json: ")
tvn=""; for n in 01 02 03 04 05 06 07 08 09 10 11 12; do [ "$(printf '%s\n' "$tvc" | grep -c "0000${n}Z-bb$n\.json: ")" = 1 ] || tvn="$tvn $n"; done
tvp=$(printf '%s\n' "$tvc" | grep -c "works/agenda/$tq_id.*proposed must be")
python3 - "$TH/works/agenda/$tq_id/agenda.json" <<'PY'
import json, sys
i = json.load(open(sys.argv[1])); i["status"] = "dropped"; i.pop("proposed", None); open(sys.argv[1], "w").write(json.dumps(i) + "\n")
PY
for f in "$tvd"/*-bb0[1-9].json "$tvd"/*-bb1[0-2].json; do rm -f "$f"; done; tvc2=$(th check --no-rebuild 2>&1); tvc2_rc=$?
[ "$tvc_rc" -eq 1 ] && ! printf '%s\n' "$tvc" | grep -q Traceback && [ "$tvl" = 12 ] && [ -z "$tvn" ] && [ "$tvp" = 1 ] \
  && printf '%s\n' "$tvc" | grep -q "bb01.json: created_at .* outside the years 0001-9999" && ! printf '%s\n' "$tvc" | grep -q "bb13.json" \
  && [ "$tvc2_rc" -eq 0 ] \
  && ok "check names each entry stamp outside the years 0001-9999 in UTC, each author past 120 characters and each author, source or proposed-by holding a splitlines() break in one line, never raising; a 120-character author passes" \
  || bad "entry input checks wrong -- rc=$tvc_rc/$tvc2_rc lines=$tvl missing:$tvn proposed=$tvp -- $(printf '%s\n' "$tvc" | grep -E 'Error|item |proposed' | head -8)"
tvx=$(printf 'x%.0s' $(seq 113)); tl2028=$(printf 'phase:a\342\200\250b')
th_bad=""; for tb in "agenda-entry $tm --kind note --author person:xx$tvx --source phase:P1 --body b" \
    "agenda-entry $tm --kind note --author \$'person:a\\vb' --source phase:P1 --body b" \
    "agenda-entry $tm --kind note --author person:x --source \"\$tl2028\" --body b" \
    "agenda-add --title t --author \$'agent:a\\fb'"; do
  tt0=$(th_tree); eval "th $tb" > "$THW/tb.txt" 2>&1; tb_rc=$?
  { [ "$tb_rc" -ne 0 ] && [ "$(grep -c '' "$THW/tb.txt")" = 1 ] && ! grep -q Traceback "$THW/tb.txt" && [ "$(th_tree)" = "$tt0" ]; } \
    || th_bad="$th_bad [$tb: rc=$tb_rc $(head -2 "$THW/tb.txt")]"
done
tv120=$(th agenda-entry "$tm" --kind note --author "person:$tvx" --source phase:P1 --body "a 120-character author" 2>&1); tv120_rc=$?
[ -z "$th_bad" ] && [ "$tv120_rc" -eq 0 ] && th check --no-rebuild >/dev/null 2>&1 \
  && ok "agenda-entry and agenda-add refuse an author past 120 characters or an author or source holding a line break in one line, nothing written; a 120-character author is taken" \
  || bad "the entry flags' form is not the stated one --$th_bad / $tv120"
# (f) agenda-fold on an install with open, promoted and dropped jobs as an older engine wrote them: check names the
# fold first; then one Proposed item per open job (an entry on its linked item for a linked one) whose first entry
# carries the job, one deferred_folded event per job, works/deferred/ and deferred.md gone; a second run folds nothing.
newtmp FDW; FD="$FDW/ws"; mkws FD >/dev/null 2>&1 || bad "fold probe: fresh install failed"
fd() { ( cd "$FD" && python3 "$ENG" "$@" ); }
fl=$(fd agenda-add --title "linked before" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p')
python3 - "$FD/works" "$fl" <<'PY'
import json, os, sys
works, linked = sys.argv[1], sys.argv[2]
T = "# Deferred: __DEFERRED_ID__ __TITLE__\n\n## Context\n\n## Why Deferred\n\n## Trigger to Promote\n\n## Notes\n\n"
def job(place, did, title, source, extra=None, note=""):
    d = os.path.join(works, "deferred", place, did); os.makedirs(d)
    data = {"id": did, "title": title, "status": {"open": "deferred"}.get(place, place), "source": source, "reason": f"why {did}",
            "trigger": f"when {did}", "created_at": "2026-10-01T09:00:00+09:00", "promoted_to": None, "dropped_reason": None, **(extra or {})}
    json.dump(data, open(os.path.join(d, "deferred.json"), "w"), indent=2)
    brief = T.replace("__DEFERRED_ID__", did).replace("__TITLE__", title).replace("## Why Deferred\n", f"## Why Deferred\n\n{data['reason']}\n")
    open(os.path.join(d, "brief.md"), "w").write(brief.replace("## Trigger to Promote\n", f"## Trigger to Promote\n\n{data['trigger']}\n") + note)
job("open", "D1-ab", "edited job", "P3.REVIEW", note="a hand-written note\n")
job("open", "D2", "plain job", "operator, by hand")
job("open", "D-m3xa", "linked job", "P4", {"agenda": linked})
job("promoted", "D4-cd", "promoted job", "P3.S1", {"status": "promoted", "promoted_to": {"phase_id": "P5", "slice_id": "P5.S1", "path": "x"}})
job("dropped", "D5-ef", "dropped job", "P3.S2", {"status": "dropped", "dropped_reason": "stale"})
open(os.path.join(works, "deferred.md"), "w").write("# Deferred Jobs\n")
PY
fc=$(fd check 2>&1); fc_rc=$?
ff=$(fd agenda-fold 2>&1); ff_rc=$?; ff2=$(fd agenda-fold 2>&1); ff2_rc=$?; fc2=$(fd check 2>&1); fc2_rc=$?
fr=$(python3 - "$FD/works" "$fl" <<'PY'
import json, os, sys, glob
works, linked = sys.argv[1], sys.argv[2]
entries = {}
for f in glob.glob(os.path.join(works, "agenda", "*", "entries", "*.json")):
    e = json.load(open(f)); entries[e["job"]["id"]] = (os.path.basename(os.path.dirname(os.path.dirname(f))), e)
ok = sorted(entries) == ["D-m3xa", "D1-ab", "D2"]
for did, (aid, e) in entries.items():
    item = json.load(open(os.path.join(works, "agenda", aid, "agenda.json")))
    ok = ok and e["kind"] == "issue" and e["author"] == "agent:fold" and all(e["job"][k] for k in ("title", "reason", "trigger", "source", "created_at"))
    ok = ok and all(s in e["body"] for s in (did, e["job"]["title"], f"why {did}", f"when {did}", e["job"]["source"], "2026-10-01"))
    ok = ok and ((aid == linked and "proposed" not in item) if did == "D-m3xa" else (item["proposed"]["by"] == "agent:fold" and item["title"] == e["job"]["title"]))
ok = ok and "a hand-written note" in entries["D1-ab"][1]["body"] and "Brief:" not in entries["D2"][1]["body"]
ok = ok and entries["D1-ab"][1]["source"] == "slice:P3.REVIEW" and entries["D2"][1]["source"] == "deferred:D2" and entries["D-m3xa"][1]["source"] == "phase:P4"
ev = [json.loads(l) for l in open(os.path.join(works, "events.jsonl")) if '"deferred_folded"' in l]
ok = ok and sorted(e["deferred"] for e in ev) == ["D-m3xa", "D1-ab", "D2", "D4-cd", "D5-ef"]
ok = ok and {e["deferred"]: e["end"] for e in ev}["D4-cd"] == "promoted" and {e["deferred"]: e.get("reason") for e in ev}["D5-ef"] == "stale"
print("ok" if ok else f"bad: {sorted(entries)} {[(e['deferred'], e['end']) for e in ev]}")
PY
)
[ "$fc_rc" -eq 1 ] && [ "$(printf '%s\n' "$fc" | grep -c 'agenda-fold')" = 1 ] && printf '%s\n' "$fc" | grep -q 'works/deferred/ holds 3 open deferred jobs' \
  && [ "$ff_rc" -eq 0 ] && printf '%s\n' "$ff" | head -1 | grep -qx 'folded 3 open jobs into the agenda (2 new Proposed agendas, 1 item on linked agendas); 2 closed jobs left with a deferred_folded event; works/deferred/ removed' \
  && [ "$fr" = ok ] && [ ! -e "$FD/works/deferred" ] && [ ! -e "$FD/works/deferred.md" ] \
  && [ "$ff2_rc" -eq 0 ] && [ "$ff2" = "nothing to fold: works/deferred/ is gone" ] && [ "$fc2_rc" -eq 0 ] \
  && [ "$(fd agenda 2>&1 | grep -c ' Proposed ')" = 2 ] \
  && ok "before the fold check fails naming agenda-fold (3 open jobs); agenda-fold makes one Proposed item per open job (the linked one an entry on its item), each first entry carrying the job's id, title, reason, trigger, source, created date and its brief when edited; 5 deferred_folded events; works/deferred/ and deferred.md gone; a second run folds nothing" \
  || bad "agenda-fold wrong -- rc=$fc_rc/$ff_rc/$ff2_rc/$fc2_rc $fr / $(printf '%s\n' "$fc" | grep -i defer) / $(printf '%s\n' "$ff" | head -1) / $ff2"
# (f2) every open job lands in an active view: a job linked to a Solved or Dropped agenda (or to no agenda) becomes a
# Proposed agenda whose first item names the old link; one linked to an Open agenda or to an older engine's stored
# `deferred` one (hand-written here: 0.6.0 writes none, and reads it as Proposed) is an item on it, and `agenda` lists
# the old record as Proposed; the closed agendas take no item.
newtmp FSW; FS="$FSW/ws"; mkws FS >/dev/null 2>&1 || bad "fold-status probe: fresh install failed"
fs() { ( cd "$FS" && python3 "$ENG" "$@" ); }
fs_add() { fs agenda-add --title "$1" --author person:smoke 2>&1 | sed -n 's/^added \(A[^:]*\):.*/\1/p'; }
fso=$(fs_add "open item"); fss=$(fs_add "solved item"); fsd=$(fs_add "dropped item"); fsf=$(fs_add "deferred item")
{ fs agenda-solve "$fss" && fs agenda-drop "$fsd" --reason stale; } >/dev/null 2>&1 || bad "fold-status probe: could not close the agendas"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.update(status="deferred", order=None); open(p,"w").write(json.dumps(d, indent=2)+"\n")' "$FS/works/agenda/$fsf/agenda.json"
python3 - "$FS/works" "$fso" "$fss" "$fsd" "$fsf" <<'PY'
import json, os, sys
works, links = sys.argv[1], dict(zip(("open", "solved", "dropped", "deferred", "gone"), sys.argv[2:] + ["A9-zz"]))
for word, aid in links.items():
    d = os.path.join(works, "deferred", "open", f"D-{word}"); os.makedirs(d)
    json.dump({"id": f"D-{word}", "title": f"job on {word}", "status": "deferred", "source": "P4", "reason": "why",
               "trigger": "when", "created_at": "2026-10-01T09:00:00+09:00", "promoted_to": None, "dropped_reason": None,
               "agenda": aid}, open(os.path.join(d, "deferred.json"), "w"), indent=2)
PY
fsf_out=$(fs agenda-fold 2>&1); fsf_rc=$?; fsc=$(fs check 2>&1); fsc_rc=$?; fsl=$(fs agenda 2>&1)
fsr=$(python3 - "$FS/works" "$fso" "$fss" "$fsd" "$fsf" <<'PY'
import json, os, sys, glob
works, (o, s, d, f) = sys.argv[1], sys.argv[2:]
entries = {}
for p in glob.glob(os.path.join(works, "agenda", "*", "entries", "*.json")):
    e = json.load(open(p)); entries[e["job"]["id"]] = (os.path.basename(os.path.dirname(os.path.dirname(p))), e)
item = lambda aid: json.load(open(os.path.join(works, "agenda", aid, "agenda.json")))
page = open(os.path.join(works, "agenda.md")).read()
bad = []
if sorted(entries) != ["D-deferred", "D-dropped", "D-gone", "D-open", "D-solved"]: bad.append(f"jobs {sorted(entries)}")
for did, want in (("D-open", o), ("D-deferred", f)):
    if entries.get(did, (None,))[0] != want: bad.append(f"{did} not an entry on {want}")
for did, old, word in (("D-solved", s, "Solved"), ("D-dropped", d, "Dropped"), ("D-gone", "A9-zz", "no such agenda")):
    aid, e = entries.get(did, (None, {}))
    if aid in (o, s, d, f) or aid is None or (item(aid).get("proposed") or {}).get("by") != "agent:fold":
        bad.append(f"{did} landed on {aid}, not a new Proposed item")
    elif f"was linked to {old} ({word})" not in e["body"] or e["job"].get("agenda") != old or f"job on {did[2:]}" not in page:
        bad.append(f"{did} does not name its old link {old} ({word}) or is not on agenda.md")
for closed in (s, d):
    if os.path.isdir(os.path.join(works, "agenda", closed, "entries")): bad.append(f"{closed} took an entry")
print("; ".join(bad) or "ok")
PY
)
[ "$fsf_rc" -eq 0 ] && printf '%s\n' "$fsf_out" | head -1 | grep -qx 'folded 5 open jobs into the agenda (3 new Proposed agendas, 2 items on linked agendas); 0 closed jobs left with a deferred_folded event; works/deferred/ removed' \
  && printf '%s\n' "$fsf_out" | grep -qE "^D-solved -> A[^ ]+ \(Proposed; was linked to $fss \(Solved\)\)$" \
  && printf '%s\n' "$fsf_out" | grep -qE "^D-dropped -> A[^ ]+ \(Proposed; was linked to $fsd \(Dropped\)\)$" \
  && printf '%s\n' "$fsf_out" | grep -qx "D-deferred -> $fsf (its linked agenda, Proposed)" \
  && printf '%s\n' "$fsf_out" | grep -qx "D-open -> $fso (its linked agenda, Open)" \
  && [ "$fsr" = ok ] && [ "$fsc_rc" -eq 0 ] && printf '%s\n' "$fsl" | grep -qE "^$fsf +Proposed +deferred item +\(1 item, 1 open\)$" \
  && [ "$(printf '%s\n' "$fsl" | grep -c ' Proposed ')" = 4 ] && [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$FS/works/agenda/$fsf/agenda.json")" = deferred ] \
  && ok "agenda-fold lands every open job in an active view: linked to Solved, Dropped or no agenda it is a new Proposed agenda naming the old link; linked to Open or to an older stored deferred agenda it is an item there, agenda lists that old record as Proposed, check passes and leaves it stored as it was" \
  || bad "agenda-fold left a job outside the active views -- rc=$fsf_rc/$fsc_rc $fsr / $(printf '%s\n' "$fsf_out" | tr '\n' '|') / $(printf '%s\n' "$fsl" | tr '\n' '|')"
# (f3) the fold runs once, on the default checkout: on another branch, on a parallel stream's branch and in a linked
# worktree it refuses in one line naming the default checkout and writes nothing, and check there says where to run
# it; on the default checkout it folds, once.
newtmp FWW; FWH="$FWW/host"; FW="$FWH"; mkws FW >/dev/null 2>&1 || bad "fold-stream probe: fresh install failed"
fw() { ( cd "$FW" && python3 "$ENG" "$@" ); }
fw_tree() { ( cd "$1" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
python3 - "$FW/works" <<'PY'
import json, os, sys
d = os.path.join(sys.argv[1], "deferred", "open", "D1-ab"); os.makedirs(d)
json.dump({"id": "D1-ab", "title": "one job", "status": "deferred", "source": "P4", "reason": "why", "trigger": "when",
           "created_at": "2026-10-01T09:00:00+09:00"}, open(os.path.join(d, "deferred.json"), "w"), indent=2)
PY
( fw phase new --phase P1 --name Side --objective toy && cd "$FW" && git add -A && git commit -qm jobs ) >/dev/null 2>&1 || bad "fold-stream probe: could not commit the job"
fw_refused() {  # <label> <dir to run in> <expected reason, a grep -E pattern>
  local _t1 _t2 _out _rc _chk
  _t1=$(fw_tree "$2"); _out=$( cd "$2" && python3 "$ENG" agenda-fold 2>&1 ); _rc=$?; _t2=$(fw_tree "$2")
  _chk=$( cd "$2" && python3 "$ENG" check 2>&1 ); ( cd "$2" && git reset -q --hard && git clean -qfd ) >/dev/null 2>&1  # each case starts clean
  [ "$_rc" -eq 1 ] && [ "$(printf '%s\n' "$_out" | grep -c '')" = 1 ] && [ "$_t1" = "$_t2" ] \
    && printf '%s\n' "$_out" | grep -qE "^agenda-fold refused, nothing was written: $3; the fold runs once, on the default checkout \(.*branch main\)" \
    && printf '%s\n' "$_chk" | grep -qE 'run sikstack agenda-fold once, on the default checkout \(.*branch main\), never here' \
    && ok "agenda-fold on $1 refuses in one line naming the default checkout and writes nothing; check there says where to run it" \
    || bad "agenda-fold on $1 did not refuse cleanly -- rc=$_rc $_out / $(printf '%s\n' "$_chk" | grep agenda-fold) / $(diff <(echo "$_t1") <(echo "$_t2") | head -3)"
}
git -C "$FW" checkout -q -b side
fw_refused "a branch other than the default" "$FW" "this checkout is on branch side, not the default branch main"
git -C "$FW" checkout -q main
python3 - "$FW/works/phases/active/P1/phase.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["execution"] = {"mode": "parallel", "branch": "phase/P1-side", "worktree": None}
open(sys.argv[1], "w").write(json.dumps(d, indent=2) + "\n")
PY
( cd "$FW" && git add -A && git commit -qm stamp && git checkout -q -b phase/P1-side ) >/dev/null 2>&1 || bad "fold-stream probe: could not stamp the stream"
fw_refused "a parallel stream's branch" "$FW" "this checkout is the parallel stream phase/P1-side"
git -C "$FW" checkout -q main
git -C "$FWH" worktree add -q --detach "$FWW/hwt" >/dev/null 2>&1 && git -C "$FW" worktree add -q --detach "$FWW/hwt/.sikstack" >/dev/null 2>&1 \
  || bad "fold-stream probe: could not add the linked worktrees"
fw_refused "a linked worktree" "$FWW/hwt/.sikstack" "this checkout is a linked worktree, not the default checkout"
fwf=$(fw agenda-fold 2>&1); fwf_rc=$?; fwf2=$(fw agenda-fold 2>&1)
[ "$fwf_rc" -eq 0 ] && printf '%s\n' "$fwf" | head -1 | grep -q '^folded 1 open job into the agenda (1 new Proposed agenda, ' \
  && [ "$fwf2" = "nothing to fold: works/deferred/ is gone" ] \
  && ok "on the default checkout agenda-fold folds the job once; a second run has nothing to fold" \
  || bad "agenda-fold on the default checkout wrong -- rc=$fwf_rc $fwf / $fwf2"
# (f4) the fold reads every input before its first write: a brief.md or a works/templates/deferred_brief.md that is
# not UTF-8 refuses in one line naming the file, nothing written; a job stamp whose UTC instant falls outside the
# years 0001-9999 never raises (the fold sorts the jobs by it) and folds.
newtmp FNW; FN="$FNW/ws"; mkws FN >/dev/null 2>&1 || bad "fold-input probe: fresh install failed"
fn_tree() { ( cd "$FN" && find . -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
python3 - "$FN/works" <<'PY'
import json, os, sys
for did, at in (("D-m3xa", "9999-12-31T23:59:59-01:00"), ("D-m4xb", "0001-01-01T00:00:00+01:00"), ("D1-ab", "2026-10-01T09:00:00+09:00")):
    d = os.path.join(sys.argv[1], "deferred", "open", did); os.makedirs(d)
    json.dump({"id": did, "title": f"job {did}", "status": "deferred", "source": "P4", "reason": "why", "trigger": "when",
               "created_at": at}, open(os.path.join(d, "deferred.json"), "w"), indent=2)
open(os.path.join(sys.argv[1], "deferred", "open", "D1-ab", "brief.md"), "wb").write(b"# Deferred \xff\xfe not UTF-8\n")
PY
fn_t1=$(fn_tree); fnb=$( cd "$FN" && python3 "$ENG" agenda-fold 2>&1 ); fnb_rc=$?; fn_t2=$(fn_tree)
printf '# Deferred: a brief\n' > "$FN/works/deferred/open/D1-ab/brief.md"; mkdir -p "$FN/works/templates"
printf '# Deferred \377 template\n' > "$FN/works/templates/deferred_brief.md"
fn_t3=$(fn_tree); fnt=$( cd "$FN" && python3 "$ENG" agenda-fold 2>&1 ); fnt_rc=$?; fn_t4=$(fn_tree)
rm -f "$FN/works/templates/deferred_brief.md"; fnf=$( cd "$FN" && python3 "$ENG" agenda-fold 2>&1 ); fnf_rc=$?
[ "$fnb_rc" -eq 1 ] && [ "$(printf '%s\n' "$fnb" | grep -c '')" = 1 ] && [ "$fn_t1" = "$fn_t2" ] \
  && printf '%s\n' "$fnb" | grep -qE '^agenda-fold refused, nothing was written: .*works/deferred/open/D1-ab/brief\.md is not UTF-8 text' \
  && [ "$fnt_rc" -eq 1 ] && [ "$(printf '%s\n' "$fnt" | grep -c '')" = 1 ] && [ "$fn_t3" = "$fn_t4" ] \
  && printf '%s\n' "$fnt" | grep -qE '^agenda-fold refused, nothing was written: .*works/templates/deferred_brief\.md is not UTF-8 text' \
  && [ "$fnf_rc" -eq 0 ] && printf '%s\n' "$fnf" | head -1 | grep -q '^folded 3 open jobs into the agenda (3 new Proposed agendas, ' \
  && ( cd "$FN" && python3 "$ENG" check >/dev/null 2>&1 ) \
  && ok "agenda-fold refuses a brief.md or a deferred_brief.md template that is not UTF-8 in one line naming it, nothing written; jobs stamped outside the years 0001-9999 in UTC fold, never raising" \
  || bad "the fold's input checks wrong -- rc=$fnb_rc/$fnt_rc/$fnf_rc [$(printf '%s\n' "$fnb" | tail -1)] [$(printf '%s\n' "$fnt" | tail -1)] [$(printf '%s\n' "$fnf" | tail -1)] $( [ "$fn_t1" = "$fn_t2" ] || echo 'brief case wrote'; [ "$fn_t3" = "$fn_t4" ] || echo 'template case wrote')"
# (g) two clones each add an entry to one item: no truth file conflicts (each entry is its own new file), the
# generated files are regenerated by check, and both entries are on the merged item.
newtmp TGW; TG="$TGW/ws"; mkws TG >/dev/null 2>&1 || bad "two-clone probe: fresh install failed"
tgc() { git -C "$TG" -c user.email=smoke@example.invalid -c user.name=smoke "$@"; }
tge() { ( cd "$TG" && python3 "$ENG" "$@" ); }
( tge agenda-add --id A1-k2 --title one --author person:smoke && tgc init -q && tgc add -A && tgc commit -qm base \
  && tgc checkout -q -b one && tge agenda-entry A1-k2 --kind note --author person:smoke --source phase:P1 --body one && tgc add -A && tgc commit -qm one \
  && tgc checkout -q - && tgc checkout -q -b two && tge agenda-entry A1-k2 --kind issue --author agent:smoke --source phase:P1 --body two && tgc add -A && tgc commit -qm two ) >/dev/null 2>&1 \
  || bad "two-clone probe: setup failed"
tgc merge -q --no-edit one >/dev/null 2>&1; tg_conf=$(tgc diff --name-only --diff-filter=U | tr '\n' ' ')
tg_truth=$(printf '%s\n' $tg_conf | grep -vxE 'works/(state\.json|index\.json|backlog\.md|agenda\.md)')
( for f in $tg_conf; do tgc checkout --theirs -- "$f" || exit 1; done; tge check && tgc add -A && tgc commit -qm merge ) >/dev/null 2>&1
[ -z "$tg_truth" ] && [ "$(ls "$TG/works/agenda/A1-k2/entries" | wc -l | tr -d ' ')" = 2 ] && tge check --no-rebuild >/dev/null 2>&1 \
  && [ -z "$(tgc status --porcelain)" ] && tge agenda-show A1-k2 | grep -qx 'items: 2 (2 open, 0 done, 0 dismissed)' \
  && ok "two clones each add an entry to A1-k2 and merge with no truth-file conflict (only generated files: ${tg_conf:-none}); after check both entries are on the item, valid and clean" \
  || bad "two clones' entries did not merge clean -- conflicted: $tg_conf / truth: $tg_truth"

# ---------------------------------------------------------------------------
echo "== Test 10k: agenda items (0.6.0) -- the dashboard beside backlog.md in works/ (0.8.0; the root copies an older engine left removed), no Deferred anywhere (an old stored deferred reads Proposed), an item's state on its own file (an older file read open and never rewritten), item references, all-or-none item commands, the auto-close, agenda-split =="
newtmp IKW; IK="$IKW/ws"; mkws IK >/dev/null 2>&1 || bad "items probe: fresh install failed"
ik() { ( cd "$IK" && python3 "$ENG" "$@" ); }
ikg() { git -C "$IK" -c user.email=smoke@example.invalid -c user.name=smoke "$@"; }
ik_tree() { ( cd "$IK" && find works -type f ! -name index.json ! -name state.json ! -name events.jsonl | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
ik_add() { ik agenda-item add "$1" --kind issue --author agent:smoke --source phase:P1 --body "$2" 2>&1 | sed -n 's/^added item \([^ ]*\) .*/\1/p'; }
ik_file() { ls "$IK/works/agenda/${1%%/*}/entries" | grep -- "-${1##*/}\.json$"; }   # an item ref's file name
ik_state() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("state", "<absent>"), d.get("state_by", "-"))' "$IK/works/agenda/${1%%/*}/entries/$(ik_file "$1")"; }
ik_key() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], "<absent>"))' "$IK/works/agenda/$1/agenda.json" "$2"; }
# (a) walkthrough 1: check writes agenda.md beside backlog.md, both in works/ and neither at the root; the root copies
# an older engine (0.6.0 to 0.7.0) left are removed by check.
ik check >/dev/null 2>&1; ik_a0=$( [ -f "$IK/works/agenda.md" ] && [ -f "$IK/works/backlog.md" ] && [ ! -e "$IK/agenda.md" ] && [ ! -e "$IK/backlog.md" ] && echo ok )
printf '# Agenda\n\nan older engine wrote this\n' > "$IK/agenda.md"; printf '# Backlog\n\nan older engine wrote this\n' > "$IK/backlog.md"
ik check >/dev/null 2>&1; ik_a1=$?
[ "$ik_a0" = ok ] && [ "$ik_a1" -eq 0 ] && [ ! -e "$IK/agenda.md" ] && [ ! -e "$IK/backlog.md" ] && [ -f "$IK/works/agenda.md" ] && grep -qx '# Agenda' "$IK/works/agenda.md" \
  && grep -qx '# Backlog' "$IK/works/backlog.md" \
  && ok "check writes agenda.md beside backlog.md in works/ and neither at the root; the root copies an older engine left are removed by check" \
  || bad "the dashboards are not in works/, or a stale root agenda.md or backlog.md survived check -- [$ik_a0] rc=$ik_a1 $(ls "$IK" "$IK/works" | tr '\n' ' ')"
# (b) walkthrough 3: an older engine's item file (no state) lists open; check and agenda-show leave its bytes as they were.
ik agenda-add --id A1-ab --title "items" --author person:smoke >/dev/null 2>&1
ik_r1=$(ik_add A1-ab one); ik_r2=$(ik_add 1 two); ik_r3=$(ik_add A1 three)
ik_old=$(ik_file "$ik_r1")
( ikg init -q && ikg add -A && ikg commit -qm base ) >/dev/null 2>&1 || bad "items probe: the base commit failed"
ik check >/dev/null 2>&1; ik_show=$(ik agenda-show A1-ab 2>&1); ik_json=$(ik agenda-show 1 --json 2>&1)
[ -n "$ik_r3" ] && ! grep -q '"state"' "$IK/works/agenda/A1-ab/entries/$ik_old" && ikg diff --exit-code --quiet -- "works/agenda/A1-ab/entries/$ik_old" \
  && printf '%s\n' "$ik_show" | grep -qE "^- $ik_r1  open  issue  by agent:smoke  [0-9]{4}-[0-9]{2}-[0-9]{2}  \(phase:P1\)$" \
  && printf '%s\n' "$ik_show" | grep -qx 'items: 3 (3 open, 0 done, 0 dismissed)' \
  && [ "$(printf '%s\n' "$ik_json" | python3 -c 'import json,sys; print(" ".join(e["ref"] + ":" + e["state"] for e in json.load(sys.stdin)["entries"]))')" = "$ik_r1:open $ik_r2:open $ik_r3:open" ] \
  && ok "an item file with no state lists open (agenda-show: reference, state, kind, author, date, source; --json: ref and state), and check and agenda-show leave its bytes unchanged (git diff --exit-code)" \
  || bad "an item with no state is not read open or was rewritten -- $ik_r1 / $(printf '%s\n' "$ik_show" | head -4 | tr '\n' '|') / $(ikg diff --stat | tail -1)"
# (c) walkthrough 4: a refused item command is one line and writes nothing -- an unknown tail, an unknown agenda, a ref
# off the form, a done item done again, a bulk call with one bad ref; a tail two items share (after a merge) is refused
# naming both, and the full name still works.
ik_t0=$(ik_tree); ik_bad=""
for ik_c in "agenda-item done A1-ab/zzzz --author person:smoke" "agenda-item done A9-zz/${ik_r1##*/} --author person:smoke" \
    "agenda-item dismiss nonsense --author person:smoke" "agenda-item done $ik_r1 A1-ab/zzzz --author person:smoke" \
    "agenda-item reopen $ik_r2 --author person:smoke" "agenda-item done $ik_r1 --author nobody"; do
  ik $ik_c > "$IKW/c.txt" 2>&1; ik_rc=$?
  { [ "$ik_rc" -ne 0 ] && [ "$(grep -c '' "$IKW/c.txt")" = 1 ] && ! grep -q Traceback "$IKW/c.txt" && [ "$(ik_tree)" = "$ik_t0" ]; } || ik_bad="$ik_bad [$ik_c: rc=$ik_rc $(head -2 "$IKW/c.txt")]"
done
ik_twin="20200101T000000.000000Z-${ik_r2##*/}.json"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["created_at"]="2020-01-01T00:00:00Z"; open(sys.argv[2],"w").write(json.dumps(d, indent=2)+"\n")' "$IK/works/agenda/A1-ab/entries/$ik_old" "$IK/works/agenda/A1-ab/entries/$ik_twin"
ik_t1=$(ik_tree); ik_amb=$(ik agenda-item done "$ik_r2" --author person:smoke 2>&1); ik_amb_rc=$?; ik_t2=$(ik_tree)
ik_full=$(ik agenda-item delete "A1/$ik_twin" --author person:smoke 2>&1); ik_full_rc=$?
[ -z "$ik_bad" ] && [ "$ik_amb_rc" -eq 1 ] && [ "$(printf '%s\n' "$ik_amb" | grep -c '')" = 1 ] && [ "$ik_t1" = "$ik_t2" ] \
  && printf '%s\n' "$ik_amb" | grep -qF "names 2 items of A1-ab: $ik_twin, $(ik_file "$ik_r2" | grep -v '^2020')" \
  && [ "$ik_full_rc" -eq 0 ] && [ ! -e "$IK/works/agenda/A1-ab/entries/$ik_twin" ] && [ "$(ik_tree | grep -c 'entries/')" = 3 ] \
  && ok "agenda-item refuses an unknown tail or agenda, a ref off the form, a wrong transition, a bad author and a bulk call with one bad ref in one line, nothing written; a tail two items share is refused naming both, and the full name deletes one" \
  || bad "an item reference or a refusal is wrong --$ik_bad / amb rc=$ik_amb_rc $ik_amb / full rc=$ik_full_rc $ik_full"
# (d) walkthrough 4: done and dismiss (brief agenda forms, a tail in capitals) rewrite only the named items' files, one
# event each; reopen puts one back; the agenda stays Open while an item is open.
ik_t3=$(ik_tree); ik_e0=$(grep -c '' "$IK/works/events.jsonl")
ik_d=$(ik agenda-item done "1/$(printf '%s' "${ik_r1##*/}" | tr '[:lower:]' '[:upper:]')" "A1/${ik_r2##*/}" --author agent:smoke 2>&1); ik_d_rc=$?
ik_changed=$(diff <(printf '%s\n' "$ik_t3") <(ik_tree) | sed -n 's/^> works\/agenda\/A1-ab\/entries\/\([^ ]*\) .*/\1/p' | LC_ALL=C sort | tr '\n' ' ')
ik_events=$(tail -n +"$((ik_e0 + 1))" "$IK/works/events.jsonl" | python3 -c 'import json,sys; print(" ".join(json.loads(l)["type"] for l in sys.stdin))')
ik_ro=$(ik agenda-item reopen "$ik_r2" --author person:smoke 2>&1)
[ "$ik_d_rc" -eq 0 ] && [ "$ik_d" = "$(printf 'done %s\ndone %s' "$ik_r1" "$ik_r2")" ] \
  && [ "$ik_changed" = "$(printf '%s\n' "$(ik_file "$ik_r1")" "$(ik_file "$ik_r2")" | LC_ALL=C sort | tr '\n' ' ')" ] \
  && [ "$ik_events" = "agenda_item_done agenda_item_done" ] && [ "$(ik_state "$ik_r1")" = "done agent:smoke" ] \
  && [ "$ik_ro" = "reopened $ik_r2" ] && [ "$(ik_state "$ik_r2")" = "open person:smoke" ] && [ "$(ik_key A1-ab status)" = open ] \
  && ik check >/dev/null 2>&1 \
  && ok "agenda-item done (1/<TAIL>, A1/<tail>) rewrites only the two named items' files (state, state_by), one agenda_item_done event each; reopen puts one back open; the agenda stays Open; check passes" \
  || bad "agenda-item done or reopen wrong -- rc=$ik_d_rc $ik_d / changed: $ik_changed / events: $ik_events / $ik_ro / $(ik_state "$ik_r2")"
# (e) walkthrough 5: the last open item done closes the agenda Solved, naming the counts; adding an item never reopens
# it (the listing shows its open item); an agenda whose items are all dismissed or deleted closes Dropped; an agenda
# with no items never closes by itself.
ik_s=$(ik agenda-item dismiss "$ik_r2" "$ik_r3" --author person:smoke 2>&1)
ik_sj=$(ik agenda --json | python3 -c 'import json,sys; r={x["id"]: x for x in json.load(sys.stdin)}["A1-ab"]; print(r["shown_status"], r["outcome"], r["items_open"])')
ik_ra=$(ik_add A1-ab four); ik_sl=$(ik agenda 2>&1 | grep '^A1-ab ')
ik agenda-add --id A2-cd --title "to drop" --author person:smoke >/dev/null 2>&1; ik_q1=$(ik_add A2-cd x); ik_q2=$(ik_add A2-cd y)
ik_dr=$(ik agenda-item dismiss "$ik_q1" --author person:smoke 2>&1; ik agenda-item delete "$ik_q2" --author person:smoke 2>&1)
ik agenda-add --id A3-ef --title "no items" --author person:smoke >/dev/null 2>&1; ik check >/dev/null 2>&1
ik_ev=$(grep -cE '"agenda_(solved|dropped)"' "$IK/works/events.jsonl")
[ "$ik_s" = "$(printf 'dismissed %s\ndismissed %s\nA1-ab is Solved: all items dealt with: 1 done, 2 dismissed' "$ik_r2" "$ik_r3")" ] \
  && [ "$ik_sj" = "Solved all items dealt with: 1 done, 2 dismissed 0" ] \
  && [ -n "$ik_ra" ] && printf '%s\n' "$ik_sl" | grep -qE '^A1-ab +Solved +items +\(4 items, 1 open\)$' && [ "$(ik_key A1-ab status)" = solved ] \
  && printf '%s\n' "$ik_dr" | grep -qx 'A2-cd is Dropped: every item dismissed or deleted' && [ "$(ik_key A2-cd status)" = dropped ] \
  && [ "$(ik_key A2-cd reason)" = "every item dismissed or deleted" ] && [ "$(ik_key A3-ef status)" = open ] && [ "$ik_ev" = 2 ] \
  && ok "the last open item dismissed after one done closes A1-ab Solved (all items dealt with: 1 done, 2 dismissed; agenda --json says so); a new item leaves it Solved with 1 open; dismiss then delete closes A2-cd Dropped (every item dismissed or deleted); A3-ef with no items stays Open; one event per close" \
  || bad "the auto-close is wrong -- $ik_s / $ik_sj / $ik_sl / $ik_dr / $(ik_key A3-ef status) events=$ik_ev"
# (f) walkthrough 6: agenda-split moves exactly the named items, files whole with their state, into a new agenda (Open
# for a person); refused for every item and for none; the agenda split from keeps the rest.
ik agenda-add --id A4-gh --title "to split" --author person:smoke >/dev/null 2>&1
ik_p1=$(ik_add A4-gh p); ik_p2=$(ik_add A4-gh q); ik_p3=$(ik_add A4-gh r)
ik agenda-item done "$ik_p2" --author agent:smoke >/dev/null 2>&1
ik_f2=$(ik_file "$ik_p2"); ik_f3=$(ik_file "$ik_p3"); ik_sha2=$(sha "$IK/works/agenda/A4-gh/entries/$ik_f2")
ik_t4=$(ik_tree); ik_all=$(ik agenda-split A4-gh "${ik_p1##*/}" "${ik_p2##*/}" "${ik_p3##*/}" --title all --author person:smoke 2>&1); ik_all_rc=$?
ik_none=$(ik agenda-split A4-gh zzzz --title none --author person:smoke 2>&1); ik_none_rc=$?; ik_t5=$(ik_tree); ik_n5=$(ls "$IK/works/agenda" | tr '\n' ' ')
ik_sp=$(ik agenda-split 4 "${ik_p2##*/}" "$ik_f3" --title "split out" --author person:smoke --id A5-jk 2>&1); ik_sp_rc=$?
[ "$ik_all_rc" -eq 1 ] && [ "$(printf '%s\n' "$ik_all" | grep -c '')" = 1 ] && printf '%s\n' "$ik_all" | grep -q 'would take every item of A4-gh' \
  && [ "$ik_none_rc" -eq 1 ] && [ "$ik_t4" = "$ik_t5" ] && [ "$ik_n5" = "A1-ab A2-cd A3-ef A4-gh " ] || ik_split_bad=1
[ -z "${ik_split_bad:-}" ] && [ "$ik_sp_rc" -eq 0 ] && [ "$ik_sp" = "split 2 items of A4-gh into A5-jk: split out" ] \
  && [ "$(ls "$IK/works/agenda/A5-jk/entries" | tr '\n' ' ')" = "$ik_f2 $ik_f3 " ] && [ "$(ls "$IK/works/agenda/A4-gh/entries")" = "$(ik_file "$ik_p1")" ] \
  && [ "$(sha "$IK/works/agenda/A5-jk/entries/$ik_f2")" = "$ik_sha2" ] && [ "$(ik_key A5-jk status)" = open ] && [ "$(ik_key A5-jk proposed)" = "<absent>" ] \
  && [ "$(ik_key A4-gh status)" = open ] && ik check >/dev/null 2>&1 \
  && ok "agenda-split moves exactly the named items (a tail and a full name) into A5-jk, Open for a person, each file whole with its state (byte-equal); A4-gh keeps the rest and stays Open; a split of every item or of none is refused in one line, nothing written" \
  || bad "agenda-split wrong -- all rc=$ik_all_rc $ik_all / none rc=$ik_none_rc $ik_none / rc=$ik_sp_rc $ik_sp / $(ls "$IK/works/agenda/A5-jk/entries" 2>&1 | tr '\n' ' ')"
# (g) walkthrough 2: an Open agenda proposed back reads Proposed (stored open + proposed, out of the open order) and
# accept returns it; an older engine's stored `deferred` lists as Proposed and check passes, leaving it stored; no
# generated file and no listing names Deferred.
ik_pr=$(ik agenda-propose A4 --author person:smoke 2>&1); ik_pk=$(ik_key A4-gh status)/$(ik_key A4-gh proposed)
ik_po=$(ik agenda --json | python3 -c 'import json,sys; print([x["id"] for x in json.load(sys.stdin) if x["shown_status"] in ("Open", "In progress")])')
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.update(status="deferred", order=None); open(p,"w").write(json.dumps(d, indent=2)+"\n")' "$IK/works/agenda/A3-ef/agenda.json"
ik_c=$(ik check 2>&1); ik_c_rc=$?; ik_l=$(ik agenda 2>&1); ik_lj=$(ik agenda --json 2>&1); ik_sh=$(ik agenda-show A3-ef 2>&1)
ik_dg=$(cd "$IK" && /usr/bin/grep -ril deferred works/agenda.md works/backlog.md works/index.json works/state.json); ik_dl=$(printf '%s\n' "$ik_l" "$ik_lj" "$ik_sh" | grep -ci deferred)
ik_ac=$(ik agenda-accept A3-ef A4-gh 2>&1); ik_ac_rc=$?
[ "$ik_pr" = "proposed A4-gh: Proposed, out of the open order (sikstack agenda-accept A4-gh puts it back)" ] && printf '%s\n' "$ik_pk" | grep -q "^open/{'by': 'person:smoke', 'at': " \
  && ! printf '%s\n' "$ik_po" | grep -q A4-gh && [ "$ik_c_rc" -eq 0 ] && printf '%s\n' "$ik_l" | grep -qE '^A3-ef +Proposed +no items$' \
  && [ -z "$ik_dg" ] && [ "$ik_dl" = 0 ] && [ "$ik_ac_rc" -eq 0 ] && [ "$(ik_key A3-ef status)" = open ] && [ "$(ik_key A4-gh proposed)" = "<absent>" ] \
  && ok "agenda-propose moves an Open agenda back to Proposed (stored open + proposed, out of the open order); an older stored deferred lists as Proposed and passes check; no generated file and no listing names Deferred; agenda-accept returns both" \
  || bad "propose or the old deferred record wrong -- $ik_pr / $ik_pk / $ik_po / rc=$ik_c_rc / $(printf '%s\n' "$ik_l" | grep A3-ef) / grep: $ik_dg $ik_dl / $ik_ac"

# ---------------------------------------------------------------------------
echo "== Test 10h: v74 a read leaves the tree clean -- next, rebuild and validate on a committed install change no tracked file; a real change still moves the stamps =="
# Before v74 every rebuild rewrote state.json's updated_at and both index.json stamps, so a plain
# `next` dirtied the tree. The sleep makes a rewritten stamp differ from the committed one.
newtmp RCW; RC="$RCW/ws"; mkws RC >/dev/null 2>&1 || bad "read-clean probe: the fresh install failed"
rcw() { ( cd "$RC" && python3 "$ENG" "$@" ); }
rc_stamp() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["updated_at"])' "$RC/works/state.json" 2>/dev/null; }
( cd "$RC" && git init -q . >/dev/null 2>&1 && git add -A >/dev/null 2>&1 \
    && git -c user.email=smoke@example.invalid -c user.name=smoke commit -q --allow-empty -m "read-clean baseline" >/dev/null 2>&1 ) \
  || bad "read-clean probe: could not make the fixture a git repo"
sleep 1
for rc_cmd in next check "check --no-rebuild"; do rcw $rc_cmd >/dev/null 2>&1; done  # shellcheck disable=SC2086
rc_dirty=$(git -C "$RC" status --porcelain 2>&1)
[ -z "$rc_dirty" ] && ok "next, check and check --no-rebuild leave a committed install's tree clean (no stamp-only write)" \
  || bad "a read dirtied the tree -- $rc_dirty"
rc_before=$(rc_stamp); sleep 1
rcw phase new --name "Read clean probe" --objective "a real change" >/dev/null 2>&1
rc_after=$(rc_stamp); rc_dirty=$(git -C "$RC" status --porcelain 2>&1)
[ -n "$rc_before" ] && [ "$rc_before" != "$rc_after" ] && printf '%s\n' "$rc_dirty" | grep -q '^ M works/state.json$' && printf '%s\n' "$rc_dirty" | grep -q '^ M works/index.json$' \
  && ok "a real change (phase new) still rewrites state.json and index.json with a new stamp" \
  || bad "a real change did not move the stamps ($rc_before -> $rc_after) -- $rc_dirty"

# ---------------------------------------------------------------------------
echo "== Test 11: v41 phase scope -- the phase's boundary is read from git, advisory everywhere =="
# $F is the workspace; its product repo is $F/.. (FH). A phase created (it records the repo's HEAD), then one product
# file committed after it: the boundary is exactly that file, and nothing of .sikstack/.
FH=$(cd "$F/.." && pwd)
( cd "$F" && python3 "$ENG" phase new --phase P3 --name "Scope probe" --objective "probe the boundary" >/dev/null 2>&1 \
    && git add -A >/dev/null 2>&1 && git commit -qm "create P3" >/dev/null 2>&1 ) \
  || bad "phase scope probe: could not create and commit P3"
p3_created=$( cd "$FH" && git rev-parse HEAD 2>/dev/null )
mkdir -p "$FH/src" && printf 'print("probe")\n' > "$FH/src/probe.py"
( cd "$FH" && git add src >/dev/null 2>&1 && git commit -qm "P3 product change" >/dev/null 2>&1 ) \
  || bad "phase scope probe: could not commit the product change"
scope_out=$( cd "$F" && python3 "$ENG" phase scope P3 2>&1 ); scope_rc=$?
[ "$scope_rc" -eq 0 ] && printf '%s\n' "$scope_out" | grep -q "^creation_commit=$p3_created" \
  && printf '%s\n' "$scope_out" | grep -q "^  A src/probe.py$" \
  && ! printf '%s\n' "$scope_out" | grep -qE "^  [AMDR] \.sikstack/" \
  && ok "phase scope names the creation commit (the repo's HEAD at phase new) and the changed product file, and excludes .sikstack/" \
  || bad "phase scope did not print the boundary (rc=$scope_rc) -- $scope_out"
( cd "$F" && python3 "$ENG" phase scope P3 --json 2>/dev/null | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["mode"] == "nested" and d["creation_commit"] == sys.argv[1] and d["commits"] == 1, d
assert {"status": "A", "path": "src/probe.py"} in d["files"], d
' "$p3_created" ) \
  && ok "phase scope --json parses and carries the same creation commit, mode and file list" \
  || bad "phase scope --json is not the same answer as the text form"
# F2: it prints the pathspec it read with, paste-ready after `--` (a guessed `.` would list works/), the same in
# --json and from the phase-less `phase scope --pathspec` that the read-code skill runs.
p3_spec=$(printf '%s\n' "$scope_out" | sed -n 's/^pathspec=//p')
p3_diff=$( cd "$FH" && eval "git diff --name-only $p3_created HEAD -- $p3_spec" 2>&1 )
p3_json=$( cd "$F" && python3 "$ENG" phase scope P3 --json 2>/dev/null | python3 -c 'import json, shlex, sys; print(json.load(sys.stdin)["pathspec"] == shlex.split(sys.argv[1]))' "$p3_spec" 2>&1 )
[ "$p3_spec" = ". ':(exclude).sikstack'" ] && [ "$p3_diff" = "src/probe.py" ] && [ "$p3_json" = True ] \
  && [ "$( cd "$F" && python3 "$ENG" phase scope --pathspec 2>&1 )" = "pathspec=$p3_spec" ] \
  && ok "phase scope prints pathspec=, which pasted after -- lists only the product file; --json and phase scope --pathspec carry the same value" \
  || bad "phase scope pathspec= missing or wrong (spec=$p3_spec json=$p3_json) -- $p3_diff"
nogit_py=$( command -v python3 )
nogit_scope=$( cd "$F" && PATH="/var/empty" "$nogit_py" "$ENG" phase scope P3 2>&1 ); nogit_rc=$?
[ "$nogit_rc" -eq 0 ] && printf '%s\n' "$nogit_scope" | grep -q "^phase scope: no git history readable in the host " \
  && ok "phase scope without git is advisory: the no-history line and exit 0" \
  || bad "phase scope failed or was silent without git (rc=$nogit_rc) -- $nogit_scope"

# ---------------------------------------------------------------------------
echo "== Test 13: design-sign, the one design command left (2.0.0) -- the ten canvas commands are gone from --help; an empty --words and a missing design folder refuse with nothing written; a real sign-off records the words verbatim, the product repo's HEAD, the folder's last commit and its uncommitted paths in the slice folder, and a second one is appended; the retired canvas record on disk is read by nothing (check passes over a broken one) =="
newtmp DS
mkhost "$DS/prod" || bad "design-sign probe: mkhost failed"
dw() { ( cd "$DS/prod/.sikstack" && python3 "$ENG" "$@" ); }
dw phase new --phase P1 --name design --objective design >/dev/null 2>&1 && dw slice new --phase P1 --slice P1.S1 --name look --kind co-work >/dev/null 2>&1 \
  || bad "design-sign probe: phase or slice new failed"
SO="$DS/prod/.sikstack/works/phases/active/P1/slices/P1.S1/design-signoff.json"
help_out=$(dw --help 2>&1)
gone=""
for c in design-init design-system design-open design-check design-canvas design-publish-plan design-preview design-readback design-close design-migrate; do
  printf '%s\n' "$help_out" | grep -q -- "$c\b" && gone="$gone $c"
done
[ -z "$gone" ] && printf '%s\n' "$help_out" | grep -q 'design-sign' \
  && ok "--help lists design-sign and none of the ten retired design commands" || bad "--help still lists:$gone"
e_out=$(dw design-sign --slice P1.S1 --words "  " --folder web/design 2>&1); e_rc=$?
mkdir -p "$DS/prod/web"
f_out=$(dw design-sign --slice P1.S1 --words "approved" --folder web/design 2>&1); f_rc=$?
x_out=$(dw design-sign --slice P1.S1 --words "approved" --folder ../elsewhere 2>&1); x_rc=$?
[ "$e_rc" = 1 ] && printf '%s\n' "$e_out" | grep -Fq -- "--words must carry the operator's literal words" \
  && [ "$f_rc" = 1 ] && printf '%s\n' "$f_out" | grep -Fq 'refused -- no design folder web/design' \
  && [ "$x_rc" = 1 ] && [ ! -e "$SO" ] \
  && ok "design-sign refuses empty --words, a missing design folder and a path outside the repo, writing nothing" \
  || bad "design-sign refusals wrong (rc=$e_rc/$f_rc/$x_rc) -- $e_out / $f_out / $x_out"
mkdir -p "$DS/prod/web/design/app" && printf 'page\n' > "$DS/prod/web/design/app/page.tsx" \
  && git -C "$DS/prod" add web && git -C "$DS/prod" commit -qm "feat: design folder" \
  && git -C "$DS/prod" commit -q --allow-empty -m "chore: later" && printf 'draft\n' > "$DS/prod/web/design/app/new.tsx"
s_out=$(dw design-sign --slice P1.S1 --words 'approved, ship it "as is"' --folder web/design/ 2>&1); s_rc=$?
s2_out=$(dw design-sign --slice P1.S1 --words "second look: yes" --folder web/design 2>&1); s2_rc=$?
HEADC=$(git -C "$DS/prod" rev-parse HEAD); FOLDERC=$(git -C "$DS/prod" rev-parse HEAD~1)
[ "$s_rc" = 0 ] && [ "$s2_rc" = 0 ] && printf '%s\n' "$s_out" | grep -q "^signed=P1.S1 repo=prod folder=web/design commit=${HEADC:0:12} folder_commit=${FOLDERC:0:12} uncommitted=1 signoffs=1 " \
  && python3 - "$SO" "$HEADC" "$FOLDERC" <<'PY' && ok "design-sign records the words verbatim, HEAD, the folder's last commit and its uncommitted path in the slice's design-signoff.json; a second sign-off is appended" || bad "the sign-off record is wrong -- $s_out / $s2_out / $(cat "$SO" 2>&1)"
import json, sys
rec = json.load(open(sys.argv[1]))
first, second = rec["signoffs"]
assert rec["schema"] == 1 and rec["slice"] == "P1.S1", rec
assert first["words"] == 'approved, ship it "as is"' and first["repo"] == "prod" and first["folder"] == "web/design", first
assert first["commit"] == sys.argv[2] and first["folder_commit"] == sys.argv[3], first
assert first["uncommitted"] == ["web/design/app/new.tsx"] and first["signed_at"], first
assert second["words"] == "second look: yes", second
PY
# The uncommitted paths are the paths on disk (porcelain v1 -z, never C-quoted): a name with a space, a Korean name,
# and a staged rename recorded as its new path, with the path it came from under `renamed`.
printf 'edit\n' > "$DS/prod/web/design/app/page.tsx" && git -C "$DS/prod" mv web/design/app/page.tsx "web/design/app/pa ge.tsx" \
  && printf 'ko\n' > "$DS/prod/web/design/app/한글 이름.tsx" && printf 'sp\n' > "$DS/prod/web/design/app/c d.tsx"
p_out=$(dw design-sign --slice P1.S1 --words "paths: ok" --folder web/design 2>&1); p_rc=$?
[ "$p_rc" = 0 ] && python3 - "$SO" "$DS/prod" <<'PY' && ok "design-sign records real paths: a space name, a Korean name and a rename's new path as on disk (unquoted), the rename's old path under renamed" || bad "design-sign recorded quoted or arrowed paths (rc=$p_rc) -- $p_out / $(cat "$SO" 2>&1)"
import json, os, sys
last = json.load(open(sys.argv[1], encoding="utf-8"))["signoffs"][-1]
want = ["web/design/app/c d.tsx", "web/design/app/new.tsx", "web/design/app/pa ge.tsx", "web/design/app/한글 이름.tsx"]
assert last["uncommitted"] == want, last["uncommitted"]
assert last["renamed"] == [{"path": "web/design/app/pa ge.tsx", "from": "web/design/app/page.tsx"}], last.get("renamed")
assert all(os.path.exists(os.path.join(sys.argv[2], p)) for p in last["uncommitted"]), last["uncommitted"]
PY
mkdir -p "$DS/prod/.sikstack/docs/reference/design/jobs/01-x" && printf '{broken' > "$DS/prod/.sikstack/docs/reference/design/design.json" \
  && printf '{' > "$DS/prod/.sikstack/docs/reference/design/jobs/01-x/job.json"
c_out=$(dw check 2>&1); c_rc=$?
[ "$c_rc" = 0 ] && ! printf '%s\n' "$c_out" | grep -qi 'design' \
  && ok "check passes over a broken retired design record: nothing reads docs/reference/design/ any more" || bad "check read the retired design record (rc=$c_rc) -- $c_out"

# ---------------------------------------------------------------------------
echo "== Test 14: P28 nested engine -- .sikstack/.agentic-nested.json: host anchors, host-side phase scope, the paired worktree lifecycle (v86: an explain phase's detached pair), the convention gate, a malformed marker fails validate =="
# A host repo with one product commit and its workspace made by `sikstack init` at host/.sikstack/, its marker
# rewritten below. Every command runs from the host root, the way a session does.
newtmp NS
NH="$NS/host"
mkhost "$NH" && ( cd "$NH" && mkdir -p src && printf 'print("host")\n' > src/app.py && git add src >/dev/null 2>&1 \
       && git commit -qm "host baseline" >/dev/null 2>&1 ) \
  || bad "nested probe: could not build the host + .sikstack/ fixture"
cat > "$NH/.sikstack/.agentic-nested.json" <<'NESTED'
{"schema": 1, "host_root": "..",
 "commit_convention": {"inferred": "type(scope): summary", "confirmed": false, "text": null, "coauthor_trailers": "unknown"},
 "renames": {"skills": {}, "agents": {"design-drafter": "wf-design-drafter"}}}
NESTED
nw() { ( cd "$NH" && python3 "$(wf_entry "$1")" "$@" ); }
{ nw check && nw phase new --phase P1 --name "Nested probe" --objective "probe the host"; } >/dev/null 2>&1 \
  || bad "nested probe: rebuild / phase new failed"
host_head=$( cd "$NH" && git rev-parse HEAD )
if python3 - "$NH/.sikstack/works/phases/active/P1/phase.json" "$host_head" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
assert data.get("host_anchors") == {"created": sys.argv[2]}, data.get("host_anchors")
PY
then ok "phase new records host_anchors.created = the host HEAD in phase.json"; else bad "phase.json carries no host anchor equal to the host HEAD"; fi
# The host's own docs/ is product; an untracked file inside the nested repo is not.
mkdir -p "$NH/docs" && printf 'guide\n' > "$NH/docs/guide.md" && printf 'print("feature")\n' > "$NH/src/feature.py"
( cd "$NH" && git add src docs >/dev/null 2>&1 && git commit -qm "product change" >/dev/null 2>&1 ) || bad "nested probe: could not commit the product change"
printf 'scratch\n' > "$NH/.sikstack/scratch.txt"
scope_out=$(nw phase scope P1 2>&1); scope_rc=$?
[ "$scope_rc" -eq 0 ] && printf '%s\n' "$scope_out" | grep -q "^mode=nested$" \
  && printf '%s\n' "$scope_out" | grep -q "^base=$host_head (" \
  && printf '%s\n' "$scope_out" | grep -qx "  A src/feature.py" && printf '%s\n' "$scope_out" | grep -qx "  A docs/guide.md" \
  && ! printf '%s\n' "$scope_out" | grep -qE "^  [AMDR] (\.sikstack/|src/app.py)" \
  && ok "phase scope reads the host repo from the anchor: the product commit's files (the host's docs/ included), nothing under .sikstack/" \
  || bad "nested phase scope did not read the host boundary (rc=$scope_rc) -- $scope_out"
printf '%s\n' "$scope_out" | grep -qx "pathspec=. ':(exclude).sikstack'" && [ "$(nw phase scope --pathspec 2>&1)" = "pathspec=. ':(exclude).sikstack'" ] \
  && ok "nested phase scope and phase scope --pathspec print the host pathspec: the .sikstack/ folder excluded, the host's docs/ kept" \
  || bad "nested pathspec= line missing or wrong -- $scope_out"
ps_out=$(nw worktree start P1 2>&1); ps_rc=$?
[ "$ps_rc" -ne 0 ] && printf '%s\n' "$ps_out" | grep -q "^worktree start in a nested install needs --host-branch <name>" \
  && ! grep -q '"execution"' "$NH/.sikstack/works/phases/active/P1/phase.json" \
  && ok "nested worktree start without --host-branch refuses and writes nothing" || bad "nested worktree start did not refuse a missing --host-branch (rc=$ps_rc) -- $ps_out"
nx=$(nw next 2>&1)
printf '%s\n' "$nx" | grep -q "^nested_host=/" && printf '%s\n' "$nx" | grep -q "^host_commit_convention=UNCONFIRMED (inferred: type(scope): summary)" \
  && printf '%s\n' "$nx" | grep -qx "slice_path=.sikstack/works/phases/active/P1/slices/P1.DECOMP" \
  && ok "next names the host, holds the unconfirmed convention, and prints host-relative paths" || bad "nested next lines missing -- $nx"
nw repo convention --confirm --text "type(scope): summary" --trailers forbidden >/dev/null 2>&1 || bad "nested probe: repo convention --confirm failed"
nx=$(nw next 2>&1)
if printf '%s\n' "$nx" | grep -q "^host_commit_convention=confirmed (coauthor_trailers=forbidden)" && ! printf '%s\n' "$nx" | grep -q "UNCONFIRMED" \
    && python3 -c 'import json,sys; c=json.load(open(sys.argv[1]))["commit_convention"]; assert c["confirmed"] is True and c["text"] == "type(scope): summary" and c["inferred"] == "type(scope): summary", c' "$NH/.sikstack/.agentic-nested.json"; then
  ok "repo convention --confirm records the text and the trailer rule, and next stops flagging it"; else bad "repo convention --confirm did not flip the convention -- $nx"; fi
nw check --no-rebuild >/dev/null 2>&1 && ok "validate passes on a well-formed nested install" || bad "validate failed on a well-formed nested install -- $(nw check --no-rebuild 2>&1)"
# v61: the resume card from the host prints host-relative paths, within its 2,048 B.
card=$(nw next --card 2>&1); cr_rc=$?
[ "$cr_rc" -eq 0 ] && [ "$(printf '%s' "$card" | wc -c | tr -d ' ')" -le 2048 ] && printf '%s\n' "$card" | grep -qx 'phase: .sikstack/works/phases/active/P1/phase.md' \
  && printf '%s\n' "$card" | grep -qF 'commands run as `sikstack <command>`' \
  && ok "nested: next --card names host-relative paths and the nested engine command, within 2,048 B" || bad "nested next --card wrong (rc=$cr_rc): $card"
printf '{"schema": 1, "host_root": ".."' > "$NH/.sikstack/.agentic-nested.json"
val_out=$(nw check --no-rebuild 2>&1); val_rc=$?; nx_out=$(nw next 2>&1); nx_rc=$?
[ "$val_rc" -ne 0 ] && printf '%s\n' "$val_out" | grep -Fq ".agentic-nested.json: cannot be read as JSON" \
  && [ "$nx_rc" -ne 0 ] && printf '%s\n' "$nx_out" | grep -Fq ".agentic-nested.json is malformed" \
  && ok "a malformed .agentic-nested.json fails validate and stops every other command (never read as at-root mode)" \
  || bad "a malformed .agentic-nested.json passed validate or ran next (rc=$val_rc/$nx_rc) -- $val_out $nx_out"
cr_out=$(printf '{}' | nw compact-resume 2>&1); cr_rc=$?
[ "$cr_rc" -eq 0 ] && [ "$(printf '%s\n' "$cr_out" | head -1)" = "compaction=done source=compact" ] \
  && ok "a malformed marker never stops the resume hook: the adapter's compact-resume still runs and exits 0" \
  || bad "the resume hook refused on a malformed marker (rc=$cr_rc): $cr_out"
# The paired worktree lifecycle (P35): a nested phase runs in a host worktree with the nested worktree inside,
# claims its own stream, shows in the main backlog's Streams view, resumes through the compaction hook's cwd, is
# guarded at teardown and is retired nested-first, keeping the host branch. It runs last: it restores a valid
# marker (the truncated one above is the previous assertion's) and commits the fixture's nested repo.
cat > "$NH/.sikstack/.agentic-nested.json" <<'NESTED'
{"schema": 1, "host_root": "..",
 "commit_convention": {"inferred": "type(scope): summary", "confirmed": true, "text": "type(scope): summary", "coauthor_trailers": "forbidden"},
 "renames": {"skills": {}, "agents": {"design-drafter": "wf-design-drafter"}}}
NESTED
NW="$NH/.sikstack"
printf '/workflow/\n/.claude/agents/\n' >> "$NH/.git/info/exclude"
printf 'temp/\n' >> "$NW/.git/info/exclude"
( cd "$NW" && git config user.email smoke@example.invalid && git config user.name smoke && git branch -M main >/dev/null 2>&1 \
    && git add -A >/dev/null 2>&1 && git commit -qm "nested baseline" >/dev/null 2>&1 ) || bad "paired lifecycle: could not commit the nested fixture"
nw check >/dev/null 2>&1; ( cd "$NW" && git add -A >/dev/null 2>&1 && git commit -qm "rebuild" >/dev/null 2>&1 )
ps_out=$(nw worktree start P1 --host-branch feat/side 2>&1); ps_rc=$?
HWT=$(printf '%s\n' "$ps_out" | sed -n 's/^host_worktree=//p'); PBR=$(printf '%s\n' "$ps_out" | sed -n 's/^branch=//p')
if [ "$ps_rc" -eq 0 ] && [ -d "$HWT/.sikstack" ] && git -C "$NH" worktree list | grep -qF "$HWT" && git -C "$NW" worktree list | grep -qF "$HWT/.sikstack" \
    && [ -z "$(git -C "$NH" status --short)" ]; then
  ok "paired worktree start: both repos list the new worktree, <host-wt>/.sikstack exists and the host's git status is empty"
else bad "paired worktree start (rc=$ps_rc) -- $ps_out -- host status: $(git -C "$NH" status --short)"; fi
wt_next=$( cd "$HWT" && python3 "$ENG" next 2>&1 ); main_next=$(nw next 2>&1)
nw check >/dev/null 2>&1
if printf '%s\n' "$wt_next" | grep -q "^stream=phase/P1-" && ! printf '%s\n' "$main_next" | grep -q "^current_phase=P1" \
    && grep -A8 '^## Streams' "$NW/works/backlog.md" | grep -E '^\|' | grep -F 'P1' | grep -qF 'feat/side'; then
  ok "the worktree's next prints stream=phase/P1-..., the main checkout skips P1, and backlog.md's ## Streams row carries P1 with feat/side"
else bad "stream claim or Streams row wrong -- worktree: $wt_next -- main: $main_next -- $(grep -A8 '^## Streams' "$NW/works/backlog.md")"; fi
# v67: a state change in the worktree refreshes the main checkout's backlog, read from the worktree's files (uncommitted).
( cd "$HWT" && python3 "$ENG" slice status P1.DECOMP in_progress >/dev/null 2>&1 )
grep -F '`P1.DECOMP`' "$NW/works/backlog.md" | grep -qF '`in_progress`' && grep -qF '_Read live from its worktree `' "$NW/works/backlog.md" \
  && ok "a slice status changed in the worktree shows in the main checkout's backlog, with nothing run there" \
  || bad "the main backlog did not follow the worktree -- $(grep -F 'P1.' "$NW/works/backlog.md")"
hook_out=$(cd "$NS" && printf '{"session_id":"t","source":"compact","cwd":"%s"}' "$HWT" | CLAUDE_PROJECT_DIR="$NH" python3 "$PLUGIN/hooks/session_start.py" 2>&1)
printf '%s\n' "$hook_out" | grep -q "^stream=phase/P1-" && printf '%s\n' "$hook_out" | grep -q "^pointer: phase P1 " \
  && ok "the plugin's SessionStart hook on a compaction, given the worktree's cwd, answers from the worktree's own .sikstack/ stream" \
  || bad "the compaction hook did not follow the worktree cwd -- $hook_out"
printf 'product\n' > "$HWT/src/side.py" && git -C "$HWT" add src/side.py >/dev/null 2>&1 && git -C "$HWT" commit -qm "side" >/dev/null 2>&1
mkdir -p "$HWT/.sikstack/temp" && printf 'note\n' > "$HWT/.sikstack/temp/note.txt"
git -C "$HWT/.sikstack" checkout -q -- . >/dev/null 2>&1   # drop the regenerated works/ files `next` rewrote
printf 'merged\n' > "$HWT/.sikstack/merged.txt" && git -C "$HWT/.sikstack" add -A >/dev/null 2>&1 && git -C "$HWT/.sikstack" commit -qm "phase work" >/dev/null 2>&1
git -C "$NW" add -A >/dev/null 2>&1 && git -C "$NW" commit -qm "regenerated works" >/dev/null 2>&1
git -C "$NW" merge --no-ff -q -m "merge phase" "$PBR" >/dev/null 2>&1 || bad "paired lifecycle: could not merge $PBR into the nested default branch"
td_out=$(nw worktree teardown P1 2>&1); td_rc=$?
[ "$td_rc" -ne 0 ] && printf '%s\n' "$td_out" | grep -qF "worktree teardown P1 refused -- nothing was removed:" \
  && printf '%s\n' "$td_out" | grep -qF "ignored, worktree-only files would be deleted" && printf '%s\n' "$td_out" | grep -qF "temp/" \
  && [ -d "$HWT/.sikstack" ] && git -C "$NH" worktree list | grep -qF "$HWT" \
  && ok "paired worktree teardown refuses first on the ignored worktree-only temp/ and removes nothing" \
  || bad "the teardown guard did not refuse (rc=$td_rc) -- $td_out"
td_out=$(nw worktree teardown P1 --discard-ignored 2>&1); td_rc=$?
nested_at=$(printf '%s\n' "$td_out" | grep -n '^removed nested worktree' | head -1 | cut -d: -f1); host_at=$(printf '%s\n' "$td_out" | grep -n '^removed host worktree' | head -1 | cut -d: -f1)
if [ "$td_rc" -eq 0 ] && [ -n "$nested_at" ] && [ -n "$host_at" ] && [ "$nested_at" -lt "$host_at" ] && printf '%s\n' "$td_out" | grep -q "^kept host branch feat/side:" \
    && [ -n "$(git -C "$NH" branch --list feat/side)" ] && [ ! -e "$HWT" ] \
    && ! git -C "$NH" worktree list | grep -qF "$HWT" && ! git -C "$NW" worktree list | grep -qF "$HWT" \
    && ! git -C "$NH" worktree list --porcelain | grep -q '^prunable' && ! git -C "$NW" worktree list --porcelain | grep -q '^prunable' \
    && ! grep -q '"execution"' "$NW/works/phases/active/P1/phase.json" && ! nw worktree status 2>&1 | grep -q '^== P1'; then
  ok "paired worktree teardown --discard-ignored removes the nested worktree before the host worktree and keeps the host branch feat/side; it clears the execution block, so worktree status stops listing P1"
else bad "paired teardown wrong (rc=$td_rc) -- $td_out"; fi
# v86 (§9.4): an explain phase's pair goes detached without --host-branch -- no host branch is made, kept or deleted.
{ nw phase new --phase P2 --name "Explain: probe" --objective "detached host" \
    && printf '\n## Explain\n\n- unit: document\n' >> "$NW/works/phases/active/P2/intent.md"; } >/dev/null 2>&1 || bad "detached pair: could not create the explain phase"
hb_before=$(git -C "$NH" branch --list | wc -l | tr -d ' ')
ps_out=$(nw worktree start P2 2>&1); ps_rc=$?
HWT2=$(printf '%s\n' "$ps_out" | sed -n 's/^host_worktree=//p'); PBR2=$(printf '%s\n' "$ps_out" | sed -n 's/^branch=//p')
if [ "$ps_rc" -eq 0 ] && printf '%s\n' "$ps_out" | grep -q '^host_branch=- (detached host worktree' && [ -d "$HWT2/.sikstack" ] \
    && ! git -C "$HWT2" symbolic-ref -q HEAD >/dev/null 2>&1 && [ "$(git -C "$NH" branch --list | wc -l | tr -d ' ')" = "$hb_before" ] \
    && python3 -c 'import json,sys; e=json.load(open(sys.argv[1]))["execution"]; assert e["host_branch"] is None and e["host_branch_created"] is False, e' "$NW/works/phases/active/P2/phase.json" \
    && nw check --no-rebuild >/dev/null 2>&1; then
  ok "nested worktree start of an explain phase with no --host-branch cuts a detached host worktree: host_branch null, no host branch made, validate passes"
else bad "detached explain pair wrong (rc=$ps_rc) -- $ps_out -- $(nw check --no-rebuild 2>&1 | tail -3)"; fi
PG="$HWT2/.sikstack/works/phases/active/P2/doc/pages"
mkdir -p "$PG" && printf '*\n!.gitignore\n' > "$PG/.gitignore" && printf 'cached\n' > "$PG/p1.html" \
  && git -C "$HWT2/.sikstack" add works/phases/active/P2/doc >/dev/null 2>&1 && git -C "$HWT2/.sikstack" commit -qm "dossier" >/dev/null 2>&1 \
  && git -C "$NW" add -A >/dev/null 2>&1 && { git -C "$NW" commit -qm "default state" >/dev/null 2>&1; git -C "$NW" merge --no-ff -q -m "merge P2" "$PBR2" >/dev/null 2>&1; } \
  || bad "detached pair: could not commit the dossier or merge $PBR2"
td_out=$(nw worktree teardown P2 --discard-ignored 2>&1); td_rc=$?
if [ "$td_rc" -eq 0 ] && printf '%s\n' "$td_out" | grep -q '^no host branch: the host worktree was detached' && printf '%s\n' "$td_out" | grep -q '^deleted 1 ignored' \
    && [ ! -e "$HWT2" ] && [ "$(git -C "$NH" branch --list | wc -l | tr -d ' ')" = "$hb_before" ] \
    && ! git -C "$NH" worktree list | grep -qF "$HWT2" && ! git -C "$NW" worktree list | grep -qF "$HWT2" && nw check --no-rebuild >/dev/null 2>&1; then
  ok "the detached pair's teardown --discard-ignored drops the ignored pages/ and both worktrees and leaves no host branch"
else bad "detached pair teardown wrong (rc=$td_rc) -- $td_out"; fi

# ---------------------------------------------------------------------------
echo "== Test 17: multi-repo host -- init and repo add make the host (the repo registry with per-repo conventions, the repos hidden), phase scope reads each repo on its own, pr check never passes a repo with no body, and a worktree set refuses to tear down what it did not stamp and then retires clean =="
# Identity comes from the environment of one call (mr), never from a git config.
mr() { env GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.invalid GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.invalid "$@"; }
mr_repo() { mkdir -p "$1" && ( cd "$1" && mr git init -q . && mr git symbolic-ref HEAD refs/heads/main && printf '%s\n' "$2" > "$2.txt" \
  && mr git add -A && mr git commit -qm "feat: $2" ) >/dev/null 2>&1 || bad "multi-repo probe: could not build the $2 repo"; }
# A tree's listing, its non-.git file contents and every repo's HEAD and status in it: a refusal or a dry run leaves it unchanged.
mr_sig() { ( cd "$1" && find . -name .git -prune -print -o -print | LC_ALL=C sort; find . -name .git -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 cat; \
  find . -name .git -prune -print | while read -r g; do git -C "$(dirname "$g")" rev-parse HEAD 2>&1; git -C "$(dirname "$g")" status --porcelain 2>&1; done ) | sha_stdin; }
pjget() { python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d[k]
print(d)' "$1" "$2"; }
# (a) a multi-repo host the way a user makes one: a folder of repos given its own git repo (one empty commit), then
# `sikstack init` there, `repo add` for each repo and `init` again, which hides the registered repos in the host's exclude.
newtmp MR; MH="$MR/host"; mr_repo "$MH/alpha" alpha; mr_repo "$MH/beta" beta
hw() { ( cd "$MH" && mr python3 "$ENG" "$@" ); }
out=$( { git -C "$MH" init -q && mr git -C "$MH" commit -q --allow-empty -m "chore: start the host history" && mkhost "$MH" \
  && hw repo add alpha && hw repo add beta && ( cd "$MH" && python3 "$ENG" init ); } 2>&1 ); rc=$?
if [ "$rc" -eq 0 ] && [ "$(git -C "$MH" rev-list --count HEAD)" = 1 ] \
    && [ -z "$(git -C "$MH" status --porcelain --untracked-files=all)" ] && grep -qx '/alpha/' "$MH/.git/info/exclude" && grep -qx '/beta/' "$MH/.git/info/exclude" && grep -qx '/.sikstack/' "$MH/.git/info/exclude" \
    && python3 -c 'import json,sys; r = json.load(open(sys.argv[1]))["repos"]; assert [x["name"] for x in r] == ["alpha", "beta"], r; assert all(not (x["commit_convention"] or {}).get("confirmed") for x in r), r' "$MH/.sikstack/.agentic-nested.json" \
    && hw check --no-rebuild >/dev/null 2>&1 && hw next 2>&1 | grep -q "^repo_conventions=.*UNCONFIRMED"; then
  ok "a multi-repo host made by init and repo add: its one empty commit, both repos registered with unconfirmed conventions, and init's second run hides them (and .sikstack/) with a clean host status"
else bad "a multi-repo host was not made by init and repo add (rc=$rc) -- $out / $(git -C "$MH" status --porcelain | head -3)"; fi
# (c) phase scope reads each repo on its own, from the anchor stamped at phase new.
hw phase new --phase P1 --name "Multi" --objective "probe the host" >/dev/null 2>&1 || bad "multi-repo probe: phase new failed"
printf 'one\n' > "$MH/alpha/one.txt" && mr git -C "$MH/alpha" add one.txt >/dev/null 2>&1 && mr git -C "$MH/alpha" commit -qm "feat: one" >/dev/null 2>&1 || bad "multi-repo probe: could not commit in alpha"
sc=$(hw phase scope P1 2>&1); sc_rc=$?; a_head=$(git -C "$MH/alpha" rev-parse --short HEAD)
[ "$sc_rc" -eq 0 ] && printf '%s\n' "$sc" | grep -q "^repo=alpha path=alpha/ .*head=$a_head .*commits=1$" && printf '%s\n' "$sc" | grep -qx '    A alpha/one.txt' \
  && printf '%s\n' "$sc" | grep -q "^repo=beta path=beta/ commits=0 " \
  && ok "phase scope prints one block per repo: alpha holds its commit and file, beta shows no commits" || bad "multi-repo phase scope wrong (rc=$sc_rc) -- $sc"
printf '%s\n' "$sc" | grep -qx 'repo=alpha pathspec=.' && printf '%s\n' "$sc" | grep -qx 'repo=beta pathspec=.' \
  && printf '%s\n' "$sc" | grep -qx "repo=. (host) pathspec=. ':(exclude).sikstack' ':(exclude)alpha' ':(exclude)beta'" \
  && ok "multi-repo phase scope prints one pathspec per repo and the host's, which excludes .sikstack/ and every repo folder" \
  || bad "multi-repo pathspec lines missing or wrong -- $sc"
# (c2) pr check on a multi-repo host never passes a repo with no body: alpha's lines say body=missing and warn; with no
# branch recorded and no --repo nothing is measured, which warns too.
pc_a=$(hw pr check P1 --repo alpha 2>&1); pc_a_rc=$?; pc_n=$(hw pr check P1 2>&1); pc_n_rc=$?
[ "$pc_a_rc" -eq 0 ] && printf '%s\n' "$pc_a" | grep -qx 'repo=alpha pr_check=alpha:main base=main' && printf '%s\n' "$pc_a" | grep -q '^repo=alpha body=missing (topics/pr-body-alpha.md)$' \
  && printf '%s\n' "$pc_a" | grep -qx 'pr_check=warn' && [ "$pc_n_rc" -eq 0 ] && printf '%s\n' "$pc_n" | grep -q '^pr_branches=none recorded' && printf '%s\n' "$pc_n" | grep -qx 'pr_check=warn' \
  && ok "multi-repo pr check: a repo with no topics/pr-body-<repo>.md prints repo=<name> body=missing and pr_check=warn; no recorded branch and no --repo warns too, never pass" \
  || bad "multi-repo pr check missing-body verdict wrong (rc $pc_a_rc/$pc_n_rc) -- $pc_a / $pc_n"
# (d) a worktree set: worktree start --repo cuts a worktree per repo; teardown refuses a dirty repo worktree and a hand-made one it did not stamp, then retires the set.
git -C "$MH/.sikstack" add -A >/dev/null 2>&1 && mr git -C "$MH/.sikstack" commit -qm "chore: install and create the phase" >/dev/null 2>&1 || bad "multi-repo probe: could not commit the nested repo"
ps_out=$(hw worktree start P1 --host-branch hb --repo alpha=feat/a --repo beta=feat/b --repo-base alpha=main --repo-base beta=main 2>&1); ps_rc=$?
PJ="$MH/.sikstack/works/phases/active/P1/phase.json"; WT=$(pjget "$PJ" execution.host_worktree); PB=$(pjget "$PJ" execution.branch)
wl() { git -C "$MH/alpha" worktree list; git -C "$MH/beta" worktree list; git -C "$MH" worktree list; git -C "$MH/.sikstack" worktree list; }
[ "$ps_rc" -eq 0 ] && [ -f "$WT/alpha/.git" ] && [ -f "$WT/beta/.git" ] && [ "$(pjget "$PJ" execution.repos.beta.branch)" = "feat/b" ] \
  && ok "worktree start --repo cuts a worktree per repo inside the host worktree and stamps each in execution.repos" || bad "worktree start --repo did not cut the set (rc=$ps_rc) -- $ps_out"
wl_before=$(wl); printf 'dirty\n' > "$WT/alpha/dirty.txt"
td_out=$(hw worktree teardown P1 2>&1); td_rc=$?
[ "$td_rc" -ne 0 ] && [ "$(wl)" = "$wl_before" ] && [ -f "$WT/alpha/dirty.txt" ] \
  && ok "worktree teardown refuses a repo worktree with uncommitted work and removes nothing" || bad "teardown did not refuse a dirty repo worktree (rc=$td_rc) -- $td_out"
rm -f "$WT/alpha/dirty.txt"
printf '/vendor/\n' >> "$MH/.git/info/exclude"   # hidden from the host worktree's status, so only the stamp can tell it from the set's own
mr git -C "$MH/alpha" worktree add -q --detach "$WT/vendor" >/dev/null 2>&1 && printf 'wip\n' > "$WT/vendor/wip.txt" || bad "multi-repo probe: could not make the hand-made worktree"
wl_before=$(wl); val_out=$(hw check --no-rebuild 2>&1); val_rc=$?; td_out=$(hw worktree teardown P1 --discard-ignored 2>&1); td_rc=$?
[ "$val_rc" -eq 0 ] && printf '%s\n' "$val_out" | grep -q "^warning: .*/vendor" && [ "$td_rc" -ne 0 ] && [ "$(wl)" = "$wl_before" ] && [ -f "$WT/vendor/wip.txt" ] \
  && [ "$(pjget "$PJ" execution.repos.alpha.worktree)" != None ] \
  && ok "a hand-made worktree in the host worktree: validate warns (rc 0), teardown refuses even with --discard-ignored, its uncommitted file and every worktree list untouched" \
  || bad "the hand-made worktree was not warned about and refused (validate rc=$val_rc, teardown rc=$td_rc) -- $val_out $td_out"
{ mr git -C "$MH/alpha" worktree remove --force "$WT/vendor" && printf 'b\n' > "$WT/beta/b2.txt" && mr git -C "$WT/beta" add b2.txt \
  && mr git -C "$WT/beta" commit -qm "feat: beta work" && mr git -C "$WT/.sikstack" commit -q --allow-empty -m "chore(works): slice work" \
  && mr git -C "$MH/.sikstack" merge -q --no-ff -m "merge: the phase" "$PB"; } >/dev/null 2>&1 || bad "multi-repo probe: could not integrate the set"
td_out=$(hw worktree teardown P1 --discard-ignored 2>&1); td_rc=$?
if [ "$td_rc" -eq 0 ] && [ ! -e "$WT" ] && [ -z "$(git -C "$MH/alpha" branch --list feat/a)" ] && [ -n "$(git -C "$MH/beta" branch --list feat/b)" ] \
    && [ "$(git -C "$MH/alpha" worktree list | wc -l | tr -d ' ')" = 1 ] && [ "$(git -C "$MH/beta" worktree list | wc -l | tr -d ' ')" = 1 ] \
    && ! pjget "$PJ" execution >/dev/null 2>&1 && hw check --no-rebuild >/dev/null 2>&1; then
  ok "with the hand-made worktree gone, teardown removes the repo worktrees, clears the execution block, deletes the created branch with no commits and keeps the one with a commit; validate passes"
else bad "the set did not retire cleanly (rc=$td_rc) -- $td_out"; fi
# (d2) a repo added mid-phase, from inside the set, is stamped on the phase branch only; the default stream's worktree status must still list it.
{ hw phase new --phase P2 --name "Mid" --objective "add a repo mid-phase" && git -C "$MH/.sikstack" add -A && mr git -C "$MH/.sikstack" commit -qm "chore: create the second phase" \
  && hw worktree start P2 --host-branch hb2 --repo alpha=feat/a2 --repo-base alpha=main; } >/dev/null 2>&1 || bad "multi-repo probe: could not cut the second set"
PJ2="$MH/.sikstack/works/phases/active/P2/phase.json"; WT2=$(pjget "$PJ2" execution.host_worktree)
add_out=$( cd "$WT2" && mr python3 "$ENG" worktree add-repo P2 --repo beta=feat/b2 --repo-base main 2>&1 ); add_rc=$?
st_out=$(hw worktree status 2>&1); st_rc=$?
[ "$add_rc" -eq 0 ] && ! pjget "$PJ2" execution.repos.beta >/dev/null 2>&1 && [ "$st_rc" -eq 0 ] && printf '%s\n' "$st_out" | grep -q '^  source=branch phase/P2' \
  && printf '%s\n' "$st_out" | grep -q '^  repo beta: branch=feat/b2 (created) ' \
  && ok "a repo added mid-phase (stamped on the phase branch only) is listed by the default stream's worktree status, which reads the set's repos from the branch it reports" \
  || bad "the default stream's worktree status lost the repo added mid-phase (add rc=$add_rc, status rc=$st_rc) -- $add_out $st_out"

# ---------------------------------------------------------------------------
echo "== Test 19: P51 PR rule v1 -- the pr block and its commands, pr check's size/budgets/leaks/headings, the pass guard, validate and next, the drafts opening with no stop (a REVIEW stop halts a run), the pr skill and pr-reader, the team-rule banner, the symlinked skills exclude, the root linguist lines, the _is_ancestor regression; zero GitHub writes =="
# Tiny and core only. Every remote is local (a bare origin) and gh is a stub on PATH: nothing reaches GitHub.
pr_t0=$(date +%s)
newtmp PRW; PRR="$PRW/ws"
mkhost "$PRR" > "$PRW/install.txt" 2>&1 || bad "pr probe: the fresh install failed"
PRG="$PRW/gh"; mkdir -p "$PRG"; printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/gh.log"\necho "stub: no such PR" >&2; exit 1\n' "$PRG" > "$PRG/gh"; chmod +x "$PRG/gh"
pw() { ( cd "$PRR" && PATH="$PRG:$PATH" python3 "$(wf_entry "$1")" "$@" ); }
pgit() { git -C "$PRR" "$@"; }
pj() { python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d.get(k) if isinstance(d, dict) else (d[int(k)] if isinstance(d, list) and len(d) > int(k) else None)
print(json.dumps(d, sort_keys=True))' "$PRR/.sikstack/works/phases/active/$1/phase.json" "$2"; }
pgit config user.email smoke@example.invalid; pgit config user.name smoke
mkdir -p "$PRR/src" "$PRR/tests" "$PRR/gen"; printf 'gen/** linguist-generated=true\n' >> "$PRR/.gitattributes"
seq 1 50 | sed 's/^/old /' > "$PRR/src/old.py"; printf 'a\nb\nc\n' > "$PRR/src/app.py"; printf '{}\n' > "$PRR/package-lock.json"
( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m baseline && cd .. && git add -A && git commit -q --allow-empty -m baseline ) >/dev/null 2>&1 || bad "pr probe: baseline commit failed"
# (1) phase new stamps the empty pr block.
pw phase new --phase P1 --name "PR probe" --objective "toy" >/dev/null 2>&1 && ( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m p1 && cd .. && git add -A && git commit -q --allow-empty -m p1 ) >/dev/null 2>&1
[ "$(pj P1 pr)" = '{"branches": [], "waived": null}' ] && ok "phase new stamps pr = {branches: [], waived: null}" || bad "phase new pr block wrong: $(pj P1 pr)"
# (2) pr branch: three refusals leave phase.json byte-identical; then it cuts and records the branch.
pgit branch feat/other main
h0=$(sha "$PRR/.sikstack/works/phases/active/P1/phase.json")
pw pr branch P1 --name feat/other > "$PRW/r1.txt" 2>&1; r1=$?
pw pr branch P1 --name main > "$PRW/r2.txt" 2>&1; r2=$?
echo dirty >> "$PRR/src/app.py"; pw pr branch P1 --name feat/b > "$PRW/r3.txt" 2>&1; r3=$?; pgit checkout -q -- src/app.py
h1=$(sha "$PRR/.sikstack/works/phases/active/P1/phase.json")
b_out=$(pw pr branch P1 --name feat/a 2>&1); b_rc=$?
[ "$r1" -eq 1 ] && grep -q "already exists .* is not checked out there" "$PRW/r1.txt" && [ "$r2" -eq 1 ] && grep -q "that is the base or default branch itself" "$PRW/r2.txt" \
  && [ "$r3" -eq 1 ] && grep -q "uncommitted tracked changes a switch would carry onto feat/b: src/app.py" "$PRW/r3.txt" && [ "$h0" = "$h1" ] \
  && [ "$b_rc" -eq 0 ] && printf '%s\n' "$b_out" | grep -qx 'pr_branch=host:feat/a base=main' && [ "$(pgit branch --show-current)" = feat/a ] \
  && [ "$(pj P1 pr.branches.0.branch)" = '"feat/a"' ] && [ "$(pj P1 pr.branches.0.url)" = null ] \
  && ok "pr branch refuses an existing unchecked-out branch, the default branch and a dirty tracked tree (phase.json byte-identical), then cuts feat/a from main and records it" \
  || bad "pr branch wrong (rc $r1/$r2/$r3/$b_rc, sha $h0 -> $h1) -- $(cat "$PRW/r1.txt" "$PRW/r2.txt" "$PRW/r3.txt") / $b_out"
# (3) pr check size: a generated file, a lockfile, a deletion and a binary are excluded; test lines count.
seq 1 30 > "$PRR/gen/out.txt"; printf '{"a":1}\n' > "$PRR/package-lock.json"; pgit rm -q src/old.py; printf '\000\001\002bin' > "$PRR/src/logo.bin"
seq 1 20 | sed 's/^/assert /' > "$PRR/tests/test_app.py"; printf 'd\ne\n' >> "$PRR/src/app.py"
( cd "$PRR" && git add gen src tests package-lock.json && git commit -qm "feat: toy" ) >/dev/null 2>&1 || bad "pr probe: product commit failed"
c_out=$(pw pr check P1 2>&1); c_rc=$?
[ "$c_rc" -eq 0 ] && printf '%s\n' "$c_out" | grep -qx 'size=22 size_status=info' \
  && printf '%s\n' "$c_out" | grep -qx 'size_excluded=4 files (generated 1, lockfiles 1, deleted 1, binary 1; counted 2 files)' \
  && printf '%s\n' "$c_out" | grep -qx 'pr_check=host:feat/a base=main' && printf '%s\n' "$c_out" | grep -q '^body=missing (topics/pr-body.md)$' \
  && printf '%s\n' "$c_out" | grep -qx 'pr_check=warn' \
  && ok "pr check size excludes the generated file, the lockfile, the deletion and the binary (size_excluded=4) and counts the test lines; the label is host:, and a missing default body is body=missing and pr_check=warn (exit 0), never pass" || bad "pr check size or missing-body verdict wrong (rc=$c_rc) -- $c_out"
# (4)(5) bodies: the three budgets, the leaks, the warn, the passes, and the headings (default order, then a team template).
python3 - "$PRW" <<'PY'
import sys
d = sys.argv[1]
def body(review="Check the parser.", changed="The parser reads two more lines.", why="It needed them.", extra="", order=None):
    secs = {"Summary": "Adds two lines to the toy app.", "Review": review, "What is changed": changed, "Why": why, "Related issue": "None."}
    return "".join(f"## {h}\n\n{secs[h]}\n\n" for h in (order or list(secs))) + extra
bodies = {"ok": body(), "first": body(review="word " * 320), "visible": body(changed="word " * 720),
          "whole": body(extra="<!--\n" + "word " * 1300 + "\n-->\n"), "phase": body(why="It was planned in P51."),
          "path": body(why="See workflow/docs/current/qa.md."), "warn": body(why="One slice was enough."),
          "sik": body(why="Moved the notes under .sikstack/works/ for later."), "sikbare": body(why="The `.sikstack` folder holds them."),
          "pass": body(why="The S3 bucket p95 latency dropped, as sikstack and foo.sikstack.dev measured."),
          "order": body(order=["Summary", "Review", "Why", "What is changed", "Related issue"]),
          "missing": body(order=["Summary", "Review", "What is changed", "Why"])}
for k, v in bodies.items():
    open(f"{d}/body-{k}.md", "w").write(v)
PY
pcb() { pw pr check P1 --body "$PRW/body-$1.md" > "$PRW/check-$1.txt" 2>&1; printf '%s' "$?"; }
pcl() { grep -qx "$2" "$PRW/check-$1.txt"; }
if [ "$(pcb ok)" = 0 ] && pcl ok 'pr_check=pass' && pcl ok 'headings=ok' && pcl ok 'leaks=none' \
    && [ "$(pcb first)" = 1 ] && pcl first 'first_screen=[0-9]*/1500 over' && [ "$(pcb visible)" = 1 ] && pcl visible 'visible=[0-9]*/3500 over' && pcl visible 'first_screen=[0-9]*/1500 ok' \
    && [ "$(pcb whole)" = 1 ] && pcl whole 'whole=[0-9]*/6000 over' && pcl whole 'visible=[0-9]*/3500 ok' \
    && [ "$(pcb phase)" = 1 ] && grep -q '^leak=phase_id:P51 ' "$PRW/check-phase.txt" && [ "$(pcb path)" = 1 ] && grep -q '^leak=workspace_path:workflow/ ' "$PRW/check-path.txt" \
    && [ "$(pcb sik)" = 1 ] && grep -q '^leak=workspace_path:.sikstack ' "$PRW/check-sik.txt" && [ "$(pcb sikbare)" = 1 ] && grep -q '^leak=workspace_path:.sikstack ' "$PRW/check-sikbare.txt" \
    && [ "$(pcb warn)" = 0 ] && grep -q '^leak_warn=slice x1 ' "$PRW/check-warn.txt" && pcl warn 'pr_check=warn' \
    && [ "$(pcb pass)" = 0 ] && pcl pass 'leaks=none' && pcl pass 'pr_check=pass' \
    && [ "$(pcb order)" = 1 ] && pcl order 'headings=order:Why' && [ "$(pcb missing)" = 1 ] && pcl missing 'headings=missing:Related issue'; then
  ok "pr check bodies: each of the three budgets fails over and passes within; P51, workflow/ and .sikstack (as a path or bare) fail; 'slice' alone warns (exit 0); 'S3 bucket', 'p95' and the plain word sikstack pass; out-of-order and missing headings fail against the default order"
else bad "pr check body checks wrong -- $(for k in ok first visible whole phase path sik sikbare warn pass order missing; do printf '[%s] %s ' "$k" "$(grep -E 'first_screen|visible=|whole=|leak|headings|pr_check=' "$PRW/check-$k.txt" | tr '\n' ' ')"; done)"; fi
mkdir -p "$PRR/.github"; printf '## Summary\n\n## What is changed\n\n## Why\n\n## Related issue\n' > "$PRR/.github/pull_request_template.md"
if [ "$(pcb ok)" = 0 ] && pcl ok 'template=.github/pull_request_template.md' && [ "$(pcb order)" = 1 ] && pcl order 'headings=order:Why' \
    && [ "$(pcb missing)" = 1 ] && pcl missing 'headings=missing:Related issue' && pcl missing 'template=.github/pull_request_template.md'; then
  ok "pr check headings: out-of-order and missing headings fail against the team's template too, and a body keeping its order passes"
else bad "pr check template headings wrong -- $(cat "$PRW/check-ok.txt" "$PRW/check-order.txt" "$PRW/check-missing.txt")"; fi
rm -f "$PRR/.github/pull_request_template.md"
# (F2) a missing --body file fails; by hand (no phase) a clean --body passes against the default branch; no phase and no
# --body is refused in one line naming both forms, writing nothing. Size has no default limit (D4 amended): a big branch with a
# clean body is info and passes; only a team's --limit warns (over), on either route; a 0 or non-integer limit is refused.
pw pr check P1 --body "$PRW/no-such-body.md" > "$PRW/check-nobody.txt" 2>&1; a4=$?
pw pr check --body "$PRW/body-ok.md" > "$PRW/check-hand.txt" 2>&1; a6=$?
e0=$(sha "$PRR/.sikstack/works/events.jsonl"); pw pr check > "$PRW/check-none.txt" 2>&1; a7=$?; e1=$(sha "$PRR/.sikstack/works/events.jsonl")
{ pgit switch -qc feat/big && seq 1 1100 > "$PRR/src/big.py" && pgit add src/big.py && pgit commit -qm "feat: big" && pgit switch -q feat/a; } >/dev/null 2>&1
pw pr check --body "$PRW/body-ok.md" --branch feat/big > "$PRW/check-big.txt" 2>&1; a8=$?
pw pr check --body "$PRW/body-ok.md" --branch feat/big --limit 400 > "$PRW/check-lim.txt" 2>&1; a9=$?
pw pr check P1 --body "$PRW/body-ok.md" --limit 400 > "$PRW/check-limok.txt" 2>&1; a10=$?
pw pr check P1 --body "$PRW/body-ok.md" --limit 10 > "$PRW/check-limph.txt" 2>&1; a11=$?
pw pr check P1 --body "$PRW/body-ok.md" --limit 0 > "$PRW/check-lim0.txt" 2>&1; a12=$?
pw pr check --body "$PRW/body-ok.md" --limit 4k > "$PRW/check-limx.txt" 2>&1; a13=$?
if [ "$a4" = 1 ] && pcl nobody "body=missing ($PRW/no-such-body.md)" && pcl nobody 'pr_check=fail' \
    && [ "$a6" = 0 ] && pcl hand 'pr_check=host:feat/a base=main' && pcl hand 'note=by hand (no phase) -- measured feat/a against the default branch main' \
    && pcl hand 'size=22 size_status=info' && pcl hand 'headings=ok' && pcl hand 'pr_check=pass' \
    && [ "$a7" -ne 0 ] && [ "$(wc -l < "$PRW/check-none.txt" | tr -d ' ')" = 1 ] && grep -q 'pr check <P>' "$PRW/check-none.txt" && grep -q 'pr check --body <file>' "$PRW/check-none.txt" && [ "$e0" = "$e1" ] \
    && [ "$a8" = 0 ] && grep -q '^size=1[0-9][0-9][0-9] size_status=info$' "$PRW/check-big.txt" && pcl big 'pr_check=pass' && ! grep -qE '^size_over=|target=|flag=' "$PRW/check-big.txt" \
    && [ "$a9" = 0 ] && grep -q '^size=1[0-9][0-9][0-9] limit=400 size_status=over$' "$PRW/check-lim.txt" && grep -q '^size_over=[0-9]* changed lines over the team' "$PRW/check-lim.txt" && pcl lim 'pr_check=warn' \
    && [ "$a10" = 0 ] && pcl limok 'size=22 limit=400 size_status=ok' && pcl limok 'pr_check=pass' \
    && [ "$a11" = 0 ] && pcl limph 'size=22 limit=10 size_status=over' && pcl limph 'size_over=12 changed lines over the team'"'"'s limit of 10 -- split this branch (a stack or a series: the pr skill'"'"'s reference/split.md) or name the exception in ## Review' && pcl limph 'pr_check=warn' \
    && [ "$a12" = 1 ] && [ "$(wc -l < "$PRW/check-lim0.txt" | tr -d ' ')" = 1 ] && grep -q '^pr check --limit 0: refused' "$PRW/check-lim0.txt" \
    && [ "$a13" = 1 ] && [ "$(wc -l < "$PRW/check-limx.txt" | tr -d ' ')" = 1 ] && grep -q '^pr check --limit 4k: refused' "$PRW/check-limx.txt"; then
  ok "pr check: a missing --body file fails (exit 1); by hand with no phase, a clean --body on feat/a passes against the default branch main; no phase and no --body is refused in one line naming both forms, writing nothing; with no team limit a 1,000-line branch is size_status=info and passes; a team --limit warns over it (by hand and in a phase, with size_over=) and is ok within it; --limit 0 and 4k are refused in one line"
else bad "pr check missing --body / by-hand route / size limit wrong (rc $a4/$a6/$a7/$a8/$a9/$a10/$a11/$a12/$a13) -- $(cat "$PRW/check-nobody.txt" "$PRW/check-hand.txt" "$PRW/check-none.txt" "$PRW/check-big.txt" "$PRW/check-lim.txt" "$PRW/check-limok.txt" "$PRW/check-limph.txt" "$PRW/check-lim0.txt" "$PRW/check-limx.txt")"; fi
# (6a) the drafts open when the review passes, with no stop (F3): while the REVIEW runs with a branch unopened, next prints
# pr_draft=due; while the REVIEW is pending (a decision on a waived gate, or an open failure's operator-action), next
# prints no pr_draft=due (D120, P52).
{ pw slice finish P1.DECOMP --outcome cut && pw gate P1 waive --note toy && pw slice start P1.REVIEW \
  && : > "$PRR/.sikstack/works/phases/active/P1/slices/P1.REVIEW/result.md"; } >/dev/null 2>&1 \
  || bad "pr probe: could not bring P1 to its review"
P1D="$PRR/.sikstack/works/phases/active/P1"; gsig() { cat "$P1D/phase.json" "$PRR/.sikstack/works/events.jsonl" "$P1D/slices/P1.REVIEW/slice.json" | sha_stdin; }
plain=$(pw next 2>&1)
if printf '%s\n' "$plain" | grep -q '^pr_draft=due -- when the review would pass: open the draft(s) (pr skill: Open the drafts' \
    && printf '%s\n' "$plain" | grep -qx 'pr_branch=host:feat/a base=main url=none'; then
  ok "while a waived gate's REVIEW runs with a branch unopened, next prints pr_branch= and pr_draft=due"
else bad "the drafts' due line wrong -- next: $plain"; fi

pw slice status P1.REVIEW pending --stop-kind decision --on-words "an answer resumes it" >/dev/null 2>&1; nx_d=$(pw next 2>&1)
pw slice status P1.REVIEW in_progress >/dev/null 2>&1
pw slice status P1.REVIEW pending --stop-kind operator-action --on-words "gh auth login resumes the open" >/dev/null 2>&1; nx_o=$(pw next 2>&1)
pw slice status P1.REVIEW in_progress >/dev/null 2>&1
u_out=$(pw pr record P1 --url https://github.com/example/toy/pull/1 2>&1); nx_u=$(pw next 2>&1)
if printf '%s\n' "$nx_d" | grep -qx 'waiting_on_operator=P1.REVIEW' && ! printf '%s\n' "$nx_d" | grep -q '^pr_draft=' \
    && printf '%s\n' "$nx_o" | grep -qx 'waiting_on_operator=P1.REVIEW' && ! printf '%s\n' "$nx_o" | grep -q '^pr_draft=' \
    && printf '%s\n' "$nx_u" | grep -qx 'pr_branch=host:feat/a base=main url=https://github.com/example/toy/pull/1' && ! printf '%s\n' "$nx_u" | grep -q '^pr_draft=\|^pr_push='; then
  ok "a REVIEW stop on a waived gate (decision, or an open failure's operator-action) is a stop next waits on, and next prints no pr_draft=due while the REVIEW is pending (D120; it prints while in_progress and in_review); once pr record --url ran, next prints the url and no due line"
else bad "REVIEW stop / url wrong -- decision: $nx_d / operator-action: $nx_o / url: $nx_u"; fi
{ pw slice status P1.REVIEW in_progress && pw review P1 --verdict pass; } > "$PRW/pass1.txt" 2>&1 \
  && grep -q '^phase P1 review: pass' "$PRW/pass1.txt" && ! grep -q '^advice: pr_draft=due' "$PRW/pass1.txt" && printf '%s\n' "$u_out" | grep -q '^advice: the draft.s state was not read (gh pr failed: stub: no such PR)' \
  && ok "with the draft's URL recorded the pass records with no pr_draft advice; gh answering no PR, pr record --url records the URL with an advice line" || bad "pass after pr record --url wrong -- $u_out / $(cat "$PRW/pass1.txt")"
( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m "p1 done" && cd .. && git add -A && git commit -q --allow-empty -m "p1 done" ) >/dev/null 2>&1
# (6b) the draft PR before a pass is advice (v102; v101 refused both): a recorded branch unopened, and an empty block with
# committed product files, each pass with one advice: pr_draft=due line; pr branch records the checked-out branch.
pw phase new --phase P2 --name "PR probe 2" --objective "toy" >/dev/null 2>&1; ( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m p2 && cd .. && git add -A && git commit -q --allow-empty -m p2 && git switch -qc feat/c \
  && echo more >> src/app.py && git add src && git commit -qm "feat: more" ) >/dev/null 2>&1
{ pw slice finish P2.DECOMP --outcome cut && pw gate P2 waive --note toy && pw slice start P2.REVIEW && : > "$PRR/.sikstack/works/phases/active/P2/slices/P2.REVIEW/result.md"; } >/dev/null 2>&1
k_out=$(pw pr branch P2 --name feat/c 2>&1); pw slice status P2.REVIEW in_review >/dev/null 2>&1; nx2=$(pw next 2>&1)
e_out=$(pw review P2 --verdict pass 2>&1); e_rc=$?
( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m "p2 done" && cd .. && git add -A && git commit -q --allow-empty -m "p2 done" ) >/dev/null 2>&1
pw phase new --phase P5 --name "PR probe 5" --objective "toy" >/dev/null 2>&1; ( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m p5 && cd .. && git add -A && git commit -q --allow-empty -m p5 \
  && echo five >> src/app.py && git add src && git commit -qm "feat: five" ) >/dev/null 2>&1
{ pw slice finish P5.DECOMP --outcome cut && pw gate P5 waive --note toy && pw slice start P5.REVIEW && : > "$PRR/.sikstack/works/phases/active/P5/slices/P5.REVIEW/result.md"; } >/dev/null 2>&1
f_out=$(pw review P5 --verdict pass 2>&1); f_rc=$?
if printf '%s\n' "$k_out" | grep -q '^pr branch: feat/c recorded (already checked out)' && printf '%s\n' "$nx2" | grep -q '^pr_draft=due ' \
    && [ "$e_rc" -eq 0 ] && printf '%s\n' "$e_out" | grep -q '^phase P2 review: pass' && printf '%s\n' "$e_out" | grep -q '^advice: pr_draft=due -- host:feat/c (base main) has no draft PR: the draft opens when the review passes (pr skill: Open the drafts)' \
    && [ "$f_rc" -eq 0 ] && printf '%s\n' "$f_out" | grep -q '^phase P5 review: pass' && printf '%s\n' "$f_out" | grep -q '^advice: pr_draft=due -- phase P5 changed 1 product file(s) (phase scope P5) but records no PR branch'; then
  ok "the draft PR before a pass is advice: pr branch records a checked-out branch and next prints pr_draft=due (REVIEW in_review); the pass with that branch unopened, and a pass with an empty block over committed product files, each record with one advice: pr_draft=due line"
else bad "the pr_draft advice at a pass wrong (rc $e_rc/$f_rc) -- $k_out / $nx2 / $e_out / $f_out"; fi
( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m "p5 done" && cd .. && git add -A && git commit -q --allow-empty -m "p5 done" ) >/dev/null 2>&1
# (6c) an uncleared required gate still refuses with the PR waived; (6d) a phase with
# no pr block (an older phase) passes as before and prints no pr line.
{ pw phase new --phase P3 --name "PR probe 3" --objective "toy" && pw slice finish P3.DECOMP --outcome cut && pw gate P3 require \
  && pw slice start P3.REVIEW && : > "$PRR/.sikstack/works/phases/active/P3/slices/P3.REVIEW/result.md" && pw pr record P3 --waive --note "toy"; } >/dev/null 2>&1
q_out=$(pw review P3 --verdict pass 2>&1); q_rc=$?; nx3=$(pw next 2>&1)
pw gate P3 open --walkthrough "probe" >/dev/null 2>&1
[ "$q_rc" -ne 0 ] && printf '%s\n' "$q_out" | grep -q 'gate P3 open --walkthrough' && printf '%s\n' "$nx3" | grep -qx 'pr_waived=toy' \
  && ok "an uncleared required acceptance gate still refuses the pass with the PR waived (next prints pr_waived=)" || bad "required gate with a waived PR wrong (rc=$q_rc) -- $q_out / $nx3"
w_out=$( { pw gate P3 clear --words accept && pw review P3 --verdict pass; } 2>&1 ); w_rc=$?
[ "$w_rc" -eq 0 ] && printf '%s\n' "$w_out" | grep -q '^pr: waived (toy) -- pass recorded without a draft PR' && ! printf '%s\n' "$w_out" | grep -q '^advice: pr_draft' \
  && ok "cleared with words, the waived PR's pass records with its pr: waived line and no pr_draft advice" || bad "the waived pass wrong (rc $w_rc) -- $w_out"
{ pw phase new --phase P4 --name "Old phase" --objective "toy" && python3 - "$PRR/.sikstack/works/phases/active/P4/phase.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d.pop("pr"); json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
} >/dev/null 2>&1
( cd "$PRR/.sikstack" && git add -A && git commit -q --allow-empty -m p4 && cd .. && git add -A && git commit -q --allow-empty -m p4 && echo again >> src/app.py && git add src && git commit -qm "feat: again" ) >/dev/null 2>&1
{ pw slice finish P4.DECOMP --outcome cut && pw gate P4 waive --note toy && pw slice start P4.REVIEW && : > "$PRR/.sikstack/works/phases/active/P4/slices/P4.REVIEW/result.md"; } >/dev/null 2>&1
nx4=$(pw next 2>&1); o_out=$(pw review P4 --verdict pass 2>&1); o_rc=$?
[ "$o_rc" -eq 0 ] && ! printf '%s\n' "$nx4" | grep '^pr_' | grep -qv '^pr_open=P1 ' && ! printf '%s\n' "$o_out" | grep -q '^pr' \
  && ok "a phase with no pr block (created before P51) passes as before, and next prints no pr line for it (P52: only the other phase's pr_open= line)" || bad "an older phase changed (rc=$o_rc) -- $nx4 / $o_out"
# (7) validate flags a malformed pr block (an unknown key, a duplicate pair, a bad URL, a repo at root) and a malformed pr_rules.
cp "$P1D/phase.json" "$PRW/p1.json"
pr_bad() { python3 - "$P1D/phase.json" "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); b = d["pr"]; e = b["branches"][0]
kind = sys.argv[2]
if kind == "key": b["extra"] = 1
elif kind == "dup": b["branches"].append(dict(e))
elif kind == "url": e["url"] = "ftp://example/x"
elif kind == "repo": e["repo"] = "nosuch"
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
pw check --no-rebuild > "$PRW/val-$1.txt" 2>&1; v=$?; cp "$PRW/p1.json" "$P1D/phase.json"; printf '%s' "$v"; }
vk=$(pr_bad key); vd=$(pr_bad dup); vu=$(pr_bad url); vr=$(pr_bad repo)
PRM="$PRR/.sikstack/.agentic-nested.json"; cp "$PRM" "$PRW/marker.json"   # nested: the rules live in the marker's pr_rules key
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["pr_rules"]={"decided": [{"rule": "x"}]}; json.dump(d, open(sys.argv[1], "w"), indent=2)' "$PRM"
pw check --no-rebuild > "$PRW/val-rules.txt" 2>&1; vp=$?; cp "$PRW/marker.json" "$PRM"
if [ "$vk" != 0 ] && [ "$vd" != 0 ] && [ "$vu" != 0 ] && [ "$vr" != 0 ] && [ "$vp" -ne 0 ] && grep -q 'pr: unknown field(s) extra' "$PRW/val-key.txt" \
    && grep -q 'host:feat/a is recorded twice' "$PRW/val-dup.txt" && grep -q "url 'ftp://example/x' must be null or an http(s) URL" "$PRW/val-url.txt" \
    && grep -q "repo 'nosuch': this install has no repos registry" "$PRW/val-repo.txt" && grep -q '.agentic-nested.json: pr_rules.decided\[0\]: missing field' "$PRW/val-rules.txt" && pw check --no-rebuild >/dev/null 2>&1; then
  ok "validate flags a malformed pr block (unknown key, duplicate pair, non-http(s) URL, a repo with no registry) and a malformed pr_rules, and passes once restored"
else bad "validate missed a malformed pr block or pr_rules (rc $vk/$vd/$vu/$vr/$vp) -- $(for k in key dup url repo rules; do printf '[%s] %s ' "$k" "$(grep -i 'pr' "$PRW/val-$k.txt" | head -2 | tr '\n' ' ')"; done)"; fi
# (8 stub) the pr skill's two push commands, taken from its close checklist (reference/close.md), run against a local bare origin and a stub gh:
# a --draft create with --body-file; a stub draft refusal is exactly one create call and a stop for the operator's plain|waive
# (reference/open.md; never an automatic retry), and only on plain the same create runs without --draft and with no --reviewer.
newtmp GHS; git init -q --bare "$GHS/origin.git"; pgit remote add origin "$GHS/origin.git"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/gh.log"\ncase "$*" in *--draft*) [ -n "${GH_STUB_REFUSE_DRAFT:-}" ] && { echo "Draft pull requests are not supported in this repository" >&2; exit 1; };; esac\necho https://github.com/example/toy/pull/9\n' "$GHS" > "$GHS/gh"; chmod +x "$GHS/gh"
pr_cmds=$(python3 - "$PLUGIN/skills/pr/reference/close.md" <<'PY'
import re, sys
t = open(sys.argv[1]).read().split("## Open the drafts, when the review passes", 1)[1]
push = re.search(r"^1\. `(git push [^`]+)`", t, re.M).group(1); create = re.search(r"^2\. `(gh pr create [^`]+)`", t, re.M).group(1)
for c in (push, create):
    print(c.replace("<b>", "feat/c").replace("<base>", "main").replace('"<title>"', '"Toy change"').replace("<body>", "BODY"))
PY
)
pr_gitpush=$(printf '%s\n' "$pr_cmds" | sed -n 1p); pr_create=$(printf '%s\n' "$pr_cmds" | sed -n 2p | sed "s|BODY|$PRW/body-ok.md|")
( cd "$PRR" && eval "$pr_gitpush" ) >/dev/null 2>&1; s_push=$?
( cd "$PRR" && export PATH="$GHS:$PATH" && eval "$pr_create" ) >/dev/null 2>&1; s_create=$?
( cd "$PRR" && export PATH="$GHS:$PATH" GH_STUB_REFUSE_DRAFT=1 && eval "$pr_create" ) >/dev/null 2>&1; s_refused=$?; n_refused=$(wc -l < "$GHS/gh.log" | tr -d ' ')
( cd "$PRR" && export PATH="$GHS:$PATH" GH_STUB_REFUSE_DRAFT=1 && eval "$(printf '%s' "$pr_create" | sed 's/ --draft//')" ) >/dev/null 2>&1; s_plain=$?
if [ "$s_push" -eq 0 ] && git -C "$GHS/origin.git" rev-parse --verify --quiet refs/heads/feat/c >/dev/null && [ "$s_create" -eq 0 ] && [ "$s_refused" -ne 0 ] && [ "$n_refused" = 2 ] && [ "$s_plain" -eq 0 ] \
    && [ "$(sed -n 1p "$GHS/gh.log")" = "pr create --draft --base main --head feat/c --title Toy change --body-file $PRW/body-ok.md" ] \
    && [ "$(wc -l < "$GHS/gh.log" | tr -d ' ')" = 3 ] && sed -n 3p "$GHS/gh.log" | grep -q -- '--body-file' && ! sed -n 3p "$GHS/gh.log" | grep -q -- '--draft' && ! grep -q -- '--reviewer' "$GHS/gh.log" \
    && python3 - "$PLUGIN/skills/pr" <<'PY'
import sys
from pathlib import Path
d = Path(sys.argv[1]); core = (d / "SKILL.md").read_text(); ref = (d / "reference/open.md").read_text(); flat = lambda s: " ".join(s.split())
for t in (core, ref): assert "retry **once**" not in t and "retries once" not in t
for s in ("**If GitHub refuses the draft**", "never retry it as a plain PR, which notifies people: stop for the operator's `plain` or `waive` (`reference/open.md`)."): assert s in core, s
for s in ("Set the `REVIEW` slice `pending --stop-kind decision --on-words \"plain opens it as a plain PR (ready for review at once: it requests code-owner reviews and notifies watchers; no reviewers are requested); waive records pr record --waive and the pass\"`",
          "attempt no second one before the operator's word", "**`plain`:** the same `gh pr create` without `--draft`, and no `--reviewer`.",
          "**`waive`:** `sikstack pr record <P> --waive --note", "Drafts already opened stay open. On `plain`, the open continues bottom-up from the refused one"):
    assert flat(s) in flat(ref), s
PY
then
  ok "the pr skill's push commands push to the (local) origin and create a --draft PR with --body-file on a stub gh; a stub draft refusal is one create call and a stop for plain|waive (no automatic retry); plain creates without --draft and no --reviewer"
else bad "pr skill push commands or refused-draft stop wrong (push $s_push, create $s_create, refused $s_refused/$n_refused, plain $s_plain) -- $pr_cmds / $(cat "$GHS/gh.log" 2>/dev/null)"; fi
# (S7) the pr skill: its name, an allowed-tools list with no remote write and no recording command, its two references, its core size.
python3 - "$PLUGIN/skills/pr" <<'PY' && ok "the pr skill: name: pr, no git push / gh pr create|comment|edit|ready|merge / pr record / pr branch / pr sync / --record / bare Bash in allowed-tools (gh pr checks and the bare pr team read allowed), its core names exactly reference/body.md, close.md, open.md, reopen.md, split.md and stack.md (all shipped), core <= 8,192 B" || bad "the pr skill's frontmatter, references or core size changed"
import re, sys
from pathlib import Path
d = Path(sys.argv[1]); core = (d / "SKILL.md").read_bytes(); text = core.decode()
fm = text.split("---\n", 2)[1]
assert re.search(r"^name: pr$", fm, re.M)
tools = re.search(r"^allowed-tools: (.*)$", fm, re.M).group(1)
for gone in ("git push", "gh pr create", "gh pr comment", "gh pr edit", "gh pr ready", "gh pr merge", "pr record", "pr branch", "pr sync", "--record"):
    assert gone not in tools, gone
tl = [t.strip() for t in tools.split(",")]
assert "Bash" not in tl, "bare Bash"
assert "Bash(gh pr checks:*)" in tl and "Bash(sikstack pr team)" in tl, tl
assert set(re.findall(r"`reference/([\w.-]+\.md)`", text)) == {"body.md", "close.md", "open.md", "reopen.md", "split.md", "stack.md"} == {p.name for p in (d / "reference").glob("*.md")}
assert len(core) <= 8192, len(core)
PY
# (S8) pr-reader: the reader row's dispatch lines; the plugin ships the agent.
r_out=$(pw route --reader 2>&1)
printf '%s\n' "$r_out" | grep -qx 'subagent_type=sikstack:pr-reader' && printf '%s\n' "$r_out" | grep -qx 'model=opus' && printf '%s\n' "$r_out" | grep -qx 'effort=high' \
  && [ -f "$PLUGIN/agents/pr-reader.md" ] && grep -qx 'name: pr-reader' "$PLUGIN/agents/pr-reader.md" \
  && ok "route --reader prints subagent_type=pr-reader, model=opus and effort=high, and the plugin ships agents/pr-reader.md" || bad "pr-reader route or fresh install wrong -- $r_out"
# code-reader: the code row's dispatch lines; the agent installs fresh.
c_out=$(pw route --code 2>&1)
printf '%s\n' "$c_out" | grep -qx 'route=code' && printf '%s\n' "$c_out" | grep -qx 'subagent_type=sikstack:code-reader' && printf '%s\n' "$c_out" | grep -qx 'model=opus' && printf '%s\n' "$c_out" | grep -qx 'effort=high' \
  && [ -f "$PLUGIN/agents/code-reader.md" ] && grep -qx 'name: code-reader' "$PLUGIN/agents/code-reader.md" \
  && ok "route --code prints route=code, subagent_type=code-reader, model=opus and effort=high, and the plugin ships agents/code-reader.md" || bad "code-reader route or fresh install wrong -- $c_out"
# A bare nested host for the regression below (the installer's team-rule banners were cut with it).
newtmp PRH; { mkdir -p "$PRH/bare" && echo hi > "$PRH/bare/README.md" && git -C "$PRH/bare" init -q && git -C "$PRH/bare" add -A && git -C "$PRH/bare" commit -qm "chore: init" && mkhost "$PRH/bare"; } >/dev/null 2>&1
# (9) the regression S6 fixed: a nested phase whose host branch left the default branch (merge-base != anchor != HEAD) gets a
# phase scope and a passing review, no TypeError (a duplicate _is_ancestor shadowed P40's); no top-level def is defined twice.
BH="$PRH/bare"; bw() { ( cd "$BH" && PATH="$PRG:$PATH" python3 "$ENG" "$@" ); }
( cd "$BH" && git switch -qc feat/toy && echo b > b.txt && git add b.txt && git commit -qm "feat: b" ) >/dev/null 2>&1
bw phase new --phase P1 --name toy --objective toy >/dev/null 2>&1; ( cd "$BH" && echo c > c.txt && git add c.txt && git commit -qm "feat: c" ) >/dev/null 2>&1
s_out=$(bw phase scope P1 2>&1); s_rc=$?
{ bw slice finish P1.DECOMP --outcome cut && bw gate P1 waive --note toy && bw slice start P1.REVIEW && : > "$BH/.sikstack/works/phases/active/P1/slices/P1.REVIEW/result.md" \
  && bw pr branch P1 --name feat/toy && bw pr record P1 --url https://github.com/example/toy/pull/2; } >/dev/null 2>&1
v_out=$(bw review P1 --verdict pass 2>&1); v_rc=$?
if [ "$s_rc" -eq 0 ] && printf '%s\n' "$s_out" | grep -q '^product_files=1 ' && [ "$v_rc" -eq 0 ] && printf '%s\n' "$v_out" | grep -q '^phase P1 review: pass' \
    && ! printf '%s\n%s\n' "$s_out" "$v_out" | grep -q TypeError \
    && python3 - "$PLUGIN"/scripts/*.py <<'PY'
import ast, collections, sys
names = collections.Counter(n.name for f in sys.argv[1:] for n in ast.parse(open(f).read()).body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)))
assert not [k for k, v in names.items() if v > 1], [k for k, v in names.items() if v > 1]
PY
then ok "a nested phase whose host branch left main gets its phase scope and a passing review (no _is_ancestor TypeError), and no engine function is defined twice"
else bad "the _is_ancestor regression is back (scope rc=$s_rc, review rc=$v_rc) -- $s_out / $v_out"; fi
# (S13) on a nested host with an origin, a PR base is recorded as the branch name gh pr create --base takes, and pr check
# diffs origin/<base>: the default records main (not origin/main); --base origin/main records main; a stack part's base stays
# feat/o; a sha is refused; an old record holding base=origin/main reads as main; a base with no remote ref diffs the local branch.
newtmp PRO; git init -q --bare "$PRO/origin.git"; NH="$PRO/host"; mkdir -p "$NH"; ngit() { git -C "$NH" "$@"; }
nw() { ( cd "$NH" && python3 "$ENG" "$@" ); }
{ ngit init -q . && ngit symbolic-ref HEAD refs/heads/main && ngit config user.email smoke@example.invalid && ngit config user.name smoke \
  && echo a > "$NH/app.txt" && ngit add app.txt && ngit commit -qm "chore: init" && ngit remote add origin "$PRO/origin.git" \
  && ngit push -q origin main && ngit remote set-head origin main && mkhost "$NH" \
  && git -C "$NH/.sikstack" config user.email smoke@example.invalid && git -C "$NH/.sikstack" config user.name smoke \
  && nw phase new --phase P1 --name base --objective toy; } >/dev/null 2>&1 || bad "pr base probe: the nested host with an origin failed to set up"
o1=$(nw pr branch P1 --name feat/o 2>&1); { echo b >> "$NH/app.txt" && ngit commit -qam "feat: b"; } >/dev/null 2>&1
o2=$(nw pr branch P1 --name feat/p --base origin/main 2>&1); ngit switch -q feat/o
o3=$(nw pr branch P1 --name feat/q --base feat/o 2>&1); ngit switch -q feat/o
nw pr branch P1 --name feat/s --base "$(ngit rev-parse main)" > "$PRO/o4.txt" 2>&1; o4=$?
oc1=$(nw pr check P1 --branch feat/o 2>&1); oc3=$(nw pr check P1 --branch feat/q 2>&1)
python3 - "$NH/.sikstack/works/phases/active/P1/phase.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["pr"]["branches"][0]["base"] = "origin/main"; json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
oc_old=$(nw pr check P1 --branch feat/o 2>&1); o_nx=$(nw next 2>&1); o_val=$(nw check --no-rebuild 2>&1); o_vrc=$?
if printf '%s\n' "$o1" | grep -qx 'pr_branch=host:feat/o base=main' && printf '%s\n' "$o2" | grep -qx 'pr_branch=host:feat/p base=main' \
    && printf '%s\n' "$o3" | grep -qx 'pr_branch=host:feat/q base=feat/o' && [ "$o4" -eq 1 ] && grep -q 'a PR base must be a branch' "$PRO/o4.txt" \
    && printf '%s\n' "$oc1" | grep -qx 'pr_check=host:feat/o base=main' && printf '%s\n' "$oc1" | grep -qx 'diff_base=origin/main' \
    && printf '%s\n' "$oc1" | grep -qx 'size=1 size_status=info' && printf '%s\n' "$oc3" | grep -qx 'diff_base=feat/o' \
    && printf '%s\n' "$oc1" | grep -q '^body=missing (topics/pr-body.md)$' && printf '%s\n' "$oc1" | grep -qx 'pr_check=warn' \
    && printf '%s\n' "$oc_old" | grep -qx 'pr_check=host:feat/o base=main' && printf '%s\n' "$oc_old" | grep -qx 'diff_base=origin/main' \
    && printf '%s\n' "$o_nx" | grep -qx 'pr_branch=host:feat/o base=main url=none' && [ "$o_vrc" -eq 0 ]; then
  ok "with an origin, pr branch records the PR base as a branch name (default main, --base origin/main as main, a stack part's feat/o) and refuses a sha; pr check prints diff_base=origin/main, or the local branch with no remote ref; an old base=origin/main record reads as main; a nested host keeps host: and a missing default body warns, never passes"
else bad "PR base as a branch name wrong (sha rc $o4, validate rc $o_vrc) -- $o1 / $o2 / $o3 / $(cat "$PRO/o4.txt") / $oc1 / $oc3 / $oc_old / $(printf '%s\n' "$o_nx" | grep pr_) / $(printf '%s\n' "$o_val" | tail -3)"; fi
echo "pr rule test runtime: $(( $(date +%s) - pr_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 20: P52 PR lifecycle after the draft -- pr sync (all or nothing, ready_at once), pr team (solo/team/unknown, --record), pr_open= on every next path and the card, the archive hold (merged releases it, --force bypasses, rotate still proposes the docs), pr_stack= (moved/merged by ancestry or record, active or archived/gone) and the base re-record, phase reopen (nested worktree on the PR branch, its refusals, -reopen2), review refusing a change request on a done phase with an open PR, and a multi-repo host's --repo; zero GitHub writes =="
# Every remote is a local bare repo and gh is a stub on PATH that answers canned files, logs every call and refuses any write.
lc_t0=$(date +%s)
newtmp QW; QW=$(cd "$QW" && pwd -P); QG="$QW/gh"; mkdir -p "$QG"   # the engine prints resolved paths (macOS: /private/var)
cat > "$QG/gh" <<'STUB'
#!/bin/sh
# A stub gh: canned answers from its own folder, every call logged, every write refused. Nothing reaches GitHub.
D=$(cd "$(dirname "$0")" && pwd); printf '%s\n' "$*" >> "$D/gh.log"
[ -f "$D/fail" ] && { cat "$D/fail" >&2; exit 1; }
case "$1 $2" in
  "pr view") n=$(basename "$3"); [ -f "$D/pr-$n.json" ] || { echo "GraphQL: Could not resolve to a PullRequest with the number of $n." >&2; exit 1; }; cat "$D/pr-$n.json";;
  "pr checks") cat "$D/checks.txt" 2>/dev/null; exit "$(cat "$D/checks.rc" 2>/dev/null || echo 0)";;
  api\ *) for a in "$@"; do case "$a" in -X|--method|-f|-F|--field|--raw-field) echo "stub: a write refused" >&2; exit 9;; esac; done
    [ -f "$D/collab-403" ] && { echo "gh: Must have push access to view repository collaborators. (HTTP 403)" >&2; exit 1; }; cat "$D/collab.txt" 2>/dev/null;;
  *) echo "stub: refused $*" >&2; exit 9;;
esac
STUB
chmod +x "$QG/gh"
qpr() { printf '{"state":"%s","isDraft":%s,"mergedAt":%s,"baseRefName":"%s","headRefOid":"0123456789abcdef0123456789abcdef01234567","reviewDecision":%s}\n' "$2" "$3" "$4" "${5:-main}" "${6:-null}" > "$QG/pr-$1.json"; }
# --- the nested host: a toy product with a local bare origin, its install committed ---
git init -q --bare "$QW/origin.git"; QH="$QW/host"; mkdir -p "$QH"
qw() { ( cd "$QH" && PATH="$QG:$PATH" python3 "$ENG" "$@" ); }
qg() { git -C "$QH" "$@"; }; qn() { git -C "$QH/.sikstack" "$@"; }
qj() { python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d.get(k) if isinstance(d, dict) else (d[int(k)] if isinstance(d, list) and len(d) > int(k) else None)
print(json.dumps(d, sort_keys=True))' "$QH/.sikstack/works/phases/active/$1/phase.json" "$2"; }
qsig() { { qn rev-parse HEAD; qn status --porcelain; cat "$QH/.sikstack/works/events.jsonl"; } | sha_stdin; }
{ qg init -q . && qg symbolic-ref HEAD refs/heads/main && qg config user.email smoke@example.invalid && qg config user.name smoke \
  && echo a > "$QH/app.txt" && qg add app.txt && qg commit -qm "chore: init" && qg remote add origin "$QW/origin.git" && qg push -q origin main \
  && qg remote set-head origin main && mkhost "$QH" && qn config user.email smoke@example.invalid && qn config user.name smoke \
  && qw repo convention --confirm --text "type(scope): summary" --trailers forbidden && qn add -A && qn commit -qm "chore: install"; } > "$QW/setup.txt" 2>&1 \
  || bad "lifecycle probe: the nested host failed to set up -- $(tail -3 "$QW/setup.txt")"
# a waived-gate phase cut to its review: qnew <P>; driven to done: qpass <P>
qnew() { qw phase new --phase "$1" --name "$1 toy" --objective toy && qw gate "$1" waive --note toy && qw slice status "$1.DECOMP" done; }
qpass() { { qw slice status "$1.REVIEW" in_progress && : > "$QH/.sikstack/works/phases/active/$1/slices/$1.REVIEW/result.md" && qw review "$1" --verdict pass \
  && qn add -A && qn commit -qm "chore: $1 done"; } > "$QW/pass-$1.txt" 2>&1 || bad "lifecycle probe: $1 did not pass -- $(tail -3 "$QW/pass-$1.txt")"; }
# P1: a required-gate phase done with its draft recorded the P51 way (a URL, no lifecycle state).
{ qw phase new --phase P1 --name "Toy" --objective toy && qw gate P1 require && qw slice status P1.DECOMP done \
  && qw pr branch P1 --name feat/one && echo one >> "$QH/app.txt" && qg commit -qam "feat: one" && qg push -q -u origin feat/one \
  && qw pr record P1 --url https://github.com/acme/toy/pull/1 && qw slice status P1.REVIEW in_progress \
  && : > "$QH/.sikstack/works/phases/active/P1/slices/P1.REVIEW/result.md" && qw gate P1 open --walkthrough probe && qw gate P1 clear --words accept \
  && qw review P1 --verdict pass && qn add -A && qn commit -qm "chore: P1 done"; } > "$QW/p1.txt" 2>&1 || bad "lifecycle probe: P1 failed -- $(tail -3 "$QW/p1.txt")"
P1J="$QH/.sikstack/works/phases/active/P1/phase.json"; QEV="$QH/.sikstack/works/events.jsonl"
# (1) a P51-era entry validates and reads unsynced: the close is due; no active phase, so the line is on the no-phase path and the card.
q_val=$(qw check --no-rebuild 2>&1); q_vrc=$?; q_nx=$(qw next 2>&1); q_card=$(qw next --card 2>&1)
if [ "$q_vrc" -eq 0 ] && printf '%s\n' "$q_nx" | grep -qx 'pr_open=P1 host:feat/one state=unsynced url=https://github.com/acme/toy/pull/1 -- the close is due (close P1)' \
    && printf '%s\n' "$q_nx" | grep -q '^no active slice' && printf '%s\n' "$q_card" | grep -qx 'pr_open: P1 host:feat/one state=unsynced (close due)'; then
  ok "a P51-era pr entry (a URL, no lifecycle state) validates and reads state=unsynced: next's no-active-phase path and the resume card print pr_open= with the close due"
else bad "P51-era entry / pr_open= on the no-phase path wrong (validate rc=$q_vrc) -- $q_val / $q_nx / $q_card"; fi
# (2) pr sync: gh unauthenticated and an unknown PR each exit 1 writing nothing; a draft, then ready (ready_at stamped), then a
# second ready sync keeps ready_at.
s0=$(cat "$P1J" "$QEV" | sha_stdin)
echo "gh: To get started with GitHub CLI, please run:  gh auth login" > "$QG/fail"; q_a=$(qw pr sync P1 2>&1); q_arc=$?; rm -f "$QG/fail"
q_u=$(qw pr sync P1 2>&1); q_urc=$?; s1=$(cat "$P1J" "$QEV" | sha_stdin)
qpr 1 OPEN true null; q_d=$(qw pr sync P1 2>&1); q_dst=$(qj P1 pr.branches.0.state); q_dra=$(qj P1 pr.branches.0.ready_at)
qpr 1 OPEN false null main '"REVIEW_REQUIRED"'; q_r=$(qw pr sync P1 2>&1); q_rst=$(qj P1 pr.branches.0.state); q_rra=$(qj P1 pr.branches.0.ready_at)
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["pr"]["branches"][0]["ready_at"]="2026-01-01T00:00:00Z"; json.dump(d,open(sys.argv[1],"w"),indent=2)' "$P1J"
qw pr sync P1 >/dev/null 2>&1; q_rra2=$(qj P1 pr.branches.0.ready_at)
if [ "$q_arc" -eq 1 ] && printf '%s\n' "$q_a" | grep -q 'gh is not authenticated .*nothing was written$' && [ "$q_urc" -eq 1 ] && printf '%s\n' "$q_u" | grep -q 'Could not resolve.*nothing was written$' && [ "$s0" = "$s1" ] \
    && printf '%s\n' "$q_d" | grep -qx 'pr_sync=host:feat/one state=draft base=main head=0123456 review=none merged_at=none' && [ "$q_dst" = '"draft"' ] && [ "$q_dra" = null ] \
    && printf '%s\n' "$q_r" | grep -qx 'pr_sync=host:feat/one state=ready base=main head=0123456 review=REVIEW_REQUIRED merged_at=none' && [ "$q_rst" = '"ready"' ] && [ "$q_rra" != null ] \
    && [ "$q_rra2" = '"2026-01-01T00:00:00Z"' ]; then
  ok "pr sync: gh unauthenticated and an unknown PR exit 1 naming the cause and write nothing (phase.json and events.jsonl unchanged); a draft records state=draft with no ready_at, Ready stamps ready_at, and a later sync never re-stamps it"
else bad "pr sync lifecycle wrong (rc $q_arc/$q_urc, unchanged=$([ "$s0" = "$s1" ] && echo y)) -- $q_a / $q_u / $q_d / $q_r / ready_at $q_dra $q_rra $q_rra2"; fi
# (3) pr team, bare: solo (one collaborator), team (two, a bot dropped), solo again on a 403 (authors only); --record needs
# --evidence, records, then a re-record replaces; validate refuses a malformed ownership record.
qg remote set-url origin https://github.com/acme/toy.git
printf 'leetusik\n' > "$QG/collab.txt"; q_t1=$(qw pr team 2>&1)
printf 'leetusik\nalice\nrenovate[bot]\n' > "$QG/collab.txt"; q_t2=$(qw pr team 2>&1)
: > "$QG/collab-403"; q_t3=$(qw pr team 2>&1); rm -f "$QG/collab-403"; qg remote set-url origin "$QW/origin.git"
qw pr team --record solo > "$QW/t-noev.txt" 2>&1; q_t4=$?
q_t5=$(qw pr team --record solo --evidence "one login" 2>&1); q_t6=$(qw pr team --record team --evidence "two logins" 2>&1)
QMK="$QH/.sikstack/.agentic-nested.json"; q_own=$(python3 -c 'import json,sys; o=json.load(open(sys.argv[1]))["pr_rules"]["ownership"]; print(len(o), o[0]["mode"], o[0]["repo"])' "$QMK")
cp "$QMK" "$QW/marker.bak"; python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["pr_rules"]["ownership"][0]["mode"]="duo"; json.dump(d,open(sys.argv[1],"w"),indent=2)' "$QMK"
qw check --no-rebuild > "$QW/val-own.txt" 2>&1; q_t7=$?; cp "$QW/marker.bak" "$QMK"
if printf '%s\n' "$q_t1" | grep -qx 'pr_team=host recorded=none detected=solo evidence="collaborators: 1 (leetusik); authors: 1"' \
    && printf '%s\n' "$q_t2" | grep -qx 'pr_team=host recorded=none detected=team evidence="collaborators: 2 (alice, leetusik); authors: 1"' \
    && printf '%s\n' "$q_t3" | grep -qx 'pr_team=host recorded=none detected=solo evidence="collaborators: unavailable; authors: 1"' \
    && [ "$q_t4" -eq 1 ] && grep -q 'needs --evidence.*nothing was written' "$QW/t-noev.txt" && printf '%s\n' "$q_t5" | grep -q '^pr team: recorded -- host is solo' \
    && printf '%s\n' "$q_t6" | grep -q '^pr team: replaced -- host is team' && [ "$q_own" = "1 team None" ] && [ "$q_t7" -ne 0 ] && grep -q 'duo' "$QW/val-own.txt" && qw check --no-rebuild >/dev/null 2>&1; then
  ok "pr team: detects solo (one collaborator), team (two, a [bot] dropped) and solo from authors when collaborators answer 403; --record without --evidence writes nothing, records solo, then team replaces it (one ownership entry); validate refuses mode duo and passes restored"
else bad "pr team wrong (noev rc $q_t4, validate rc $q_t7, ownership '$q_own') -- $q_t1 / $q_t2 / $q_t3 / $q_t5 / $q_t6 / $(cat "$QW/val-own.txt" | tail -3)"; fi
# (4) the archive hold is advice now: P2 holds two PRs (a split); a sync whose second read fails writes nothing; once both read
# merged phase archive archives it with no advice. P3's closed PR keeps phase rotate's sweep off it; phase archive P3 archives it
# with one advice: line.
{ qnew P2 && qg switch -q main && qw pr branch P2 --name feat/two && echo two > "$QH/two.txt" && qg add two.txt && qg commit -qm "feat: two" && qg push -q -u origin feat/two \
  && qw pr branch P2 --name feat/three --base feat/two && echo three > "$QH/three.txt" && qg add three.txt && qg commit -qm "feat: three" && qg push -q -u origin feat/three \
  && qw pr record P2 --branch feat/two --url https://github.com/acme/toy/pull/2 && qw pr record P2 --branch feat/three --url https://github.com/acme/toy/pull/3; } > "$QW/p2.txt" 2>&1 \
  || bad "lifecycle probe: P2 failed -- $(tail -3 "$QW/p2.txt")"
qpass P2; P2J="$QH/.sikstack/works/phases/active/P2/phase.json"
qpr 2 MERGED false '"2026-11-05T08:00:00Z"'; s0=$(cat "$P2J" "$QEV" | sha_stdin); q_h1=$(qw pr sync P2 2>&1); q_h1rc=$?; s1=$(cat "$P2J" "$QEV" | sha_stdin)
qpr 3 MERGED false '"2026-11-05T09:00:00Z"' feat/two; qw pr sync P2 >/dev/null 2>&1; q_h3=$(qw phase archive P2 2>&1); q_h3rc=$?
{ qnew P3 && qg switch -q main && qw pr branch P3 --name feat/four && echo four > "$QH/four.txt" && qg add four.txt && qg commit -qm "feat: four" && qg push -q -u origin feat/four \
  && qw pr record P3 --url https://github.com/acme/toy/pull/4; } > "$QW/p3.txt" 2>&1 || bad "lifecycle probe: P3 failed -- $(tail -3 "$QW/p3.txt")"
qpass P3; qpr 4 CLOSED false null; qw pr sync P3 >/dev/null 2>&1
q_h4=$(qw next 2>&1); q_h6=$(qw phase rotate 2>&1); q_h6rc=$?; q_h6a=$([ -d "$QH/.sikstack/works/phases/active/P3" ] && [ -d "$QH/.sikstack/works/phases/active/P1" ] && echo y)
q_h5=$(qw phase archive P3 2>&1); q_h5rc=$?
if [ "$q_h1rc" -eq 1 ] && printf '%s\n' "$q_h1" | grep -q '^pr sync: host:feat/three .*nothing was written$' && [ "$s0" = "$s1" ] \
    && [ "$q_h3rc" -eq 0 ] && printf '%s\n' "$q_h3" | grep -q '^archived phase P2' && ! printf '%s\n' "$q_h3" | grep -q '^advice:' \
    && printf '%s\n' "$q_h4" | grep -qx 'pr_open=P3 host:feat/four state=closed url=https://github.com/acme/toy/pull/4 -- closed without merging: reopen it on GitHub and pr sync P3, or phase archive P3 (archived with advice)' \
    && [ "$q_h6rc" -eq 0 ] && [ "$(printf '%s\n' "$q_h6" | head -1)" = "rotate=archive" ] && [ "$q_h6a" = y ] \
    && [ "$q_h5rc" -eq 0 ] && printf '%s\n' "$q_h5" | grep -qx 'advice: P3: PR host:feat/four is closed, not merged (pr sync P3 reads it); archived anyway, so next no longer lists it' \
    && printf '%s\n' "$q_h5" | grep -q '^archived phase P3' && [ ! -d "$QH/.sikstack/works/phases/active/P3" ]; then
  ok "the archive hold is advice: a split's sync whose second read fails writes nothing; once pr sync reads both merged phase archive archives with no advice; a closed PR prints its pr_open= hint, phase rotate's sweep leaves it (and P1's open PR) active, and phase archive P3 archives it with one advice: line"
else bad "archive hold wrong (rc $q_h1rc/$q_h3rc/$q_h5rc/$q_h6rc, rotate kept '$q_h6a') -- $q_h1 / $q_h3 / $(printf '%s\n' "$q_h4" | grep pr_) / $q_h5 / $q_h6"; fi
# (5) pr_open= on the plain pointer and WAITING paths, then pr_stack=: P5 stacked on P4's feat/lo. A teammate's push to the lower
# branch reads lower=moved; its steps, run as printed, clear it. A true --no-ff landing of feat/lo reads lower=merged by ancestry.
{ qw phase new --phase P4 --name lower --objective toy && qg switch -q main && qw pr branch P4 --name feat/lo && echo lo > "$QH/lo.txt" && qg add lo.txt && qg commit -qm "feat: lo" && qg push -q -u origin feat/lo \
  && qw pr record P4 --url https://github.com/acme/toy/pull/5 && qw phase new --phase P5 --name upper --objective toy && qw pr branch P5 --name feat/up --base feat/lo \
  && echo up > "$QH/up.txt" && qg add up.txt && qg commit -qm "feat: up" && qg push -q -u origin feat/up && qw pr record P5 --url https://github.com/acme/toy/pull/6 \
  && qn add -A && qn commit -qm "chore: the stack"; } > "$QW/p45.txt" 2>&1 || bad "lifecycle probe: P4/P5 failed -- $(tail -3 "$QW/p45.txt")"
q_p1=$(qw next 2>&1); qw slice status P4.DECOMP pending --stop-kind decision --on-words "an answer resumes it" >/dev/null 2>&1; q_p2=$(qw next 2>&1); q_p2c=$(qw next --card 2>&1)
qw slice status P4.DECOMP in_progress >/dev/null 2>&1
newtmp QCL; { git clone -q -b main "$QW/origin.git" "$QCL/c" && git -C "$QCL/c" switch -q feat/lo && echo fix >> "$QCL/c/lo.txt" \
  && git -C "$QCL/c" -c user.email=mate@example.invalid -c user.name=mate commit -qam "fix: lo" && git -C "$QCL/c" push -q && qg fetch -q origin; } >/dev/null 2>&1
q_mv=$(qw next 2>&1 | grep '^pr_stack='); ( eval "${q_mv#* -- }" ) >/dev/null 2>&1; q_mvrc=$?; q_mv2=$(qw next 2>&1 | grep -c '^pr_stack=')
{ qg switch -q main && qg merge -q --no-ff feat/lo -m "merge feat/lo" && qg push -q origin main; } >/dev/null 2>&1
q_mg=$(qw next 2>&1 | grep '^pr_stack='); q_mgc=$(qw next --card 2>&1 | grep '^pr_stack:')
if printf '%s\n' "$q_p1" | grep -q '^pr_open=P1 host:feat/one state=ready ' && printf '%s\n' "$q_p1" | grep -qx 'current_slice=P4.DECOMP' \
    && printf '%s\n' "$q_p2" | grep -q '^pr_open=P1 host:feat/one state=ready ' && printf '%s\n' "$q_p2" | grep -q '^WAITING ON OPERATOR' && printf '%s\n' "$q_p2c" | grep -q '^pr_open: P1 host:feat/one state=ready' \
    && [ "$q_mv" = "pr_stack=P5 host:feat/up base=feat/lo lower=moved -- git -C $QH merge --no-ff origin/feat/lo; git -C $QH push" ] && [ "$q_mvrc" -eq 0 ] && [ "$q_mv2" = 0 ] \
    && [ "$q_mg" = "pr_stack=P5 host:feat/up base=feat/lo lower=merged -- git -C $QH fetch origin; git -C $QH switch feat/up; git -C $QH merge --no-ff origin/main; git -C $QH push; gh pr edit 6 --base main; sikstack pr branch P5 --name feat/up --base main" ] \
    && [ "$q_mgc" = 'pr_stack: P5 host:feat/up base=feat/lo lower=merged (`next` prints the steps)' ]; then
  ok "pr_open= prints on next's plain pointer and WAITING paths and the card; pr_stack= reads a teammate's push to the lower branch as lower=moved, whose printed steps (merge, never rebase; push, never --force) clear it, and a true --no-ff landing as lower=merged with the fetch/switch/merge/push/gh pr edit/re-record steps, in next and the card"
else bad "pr_open= paths or pr_stack= moved/merged wrong (steps rc $q_mvrc, after $q_mv2) -- $(printf '%s\n' "$q_p1" "$q_p2" | grep 'pr_\|WAITING\|current_slice') / $q_mv / $q_mg / $q_mgc"; fi
# (6) the base re-record on a not-checked-out branch with a dirty tree: HEAD, branch and status untouched, lifecycle fields kept, no line after.
qpr 6 OPEN true null feat/lo; qw pr sync P5 >/dev/null 2>&1; echo dirty >> "$QH/app.txt"
q_h0=$(qg rev-parse HEAD); q_s0=$(qg status --porcelain); q_b0=$(qg branch --show-current)
q_rr=$(qw pr branch P5 --name feat/up --base main 2>&1); q_rrc=$?
q_same=$([ "$q_h0" = "$(qg rev-parse HEAD)" ] && [ "$q_s0" = "$(qg status --porcelain)" ] && [ "$q_b0" = "$(qg branch --show-current)" ] && echo y)
q_rrs=$(qj P5 pr.branches.0.state); q_rrn=$(qw next 2>&1 | grep -c '^pr_stack='); qg checkout -q -- app.txt
[ "$q_rrc" -eq 0 ] && printf '%s\n' "$q_rr" | grep -qx 'pr_branch=host:feat/up base=main' && printf '%s\n' "$q_rr" | grep -q '^pr branch: feat/up base re-recorded from feat/lo -- no switch; nothing moved' \
  && [ "$q_same" = y ] && [ "$q_rrs" = '"draft"' ] && [ "$(qj P5 pr.branches.0.base)" = '"main"' ] && [ "$q_rrn" = 0 ] \
  && ok "pr branch --base on a recorded branch that is not checked out, over a dirty tree, re-records the base only (HEAD, branch and status untouched, state=draft kept), and no pr_stack= line follows" \
  || bad "the base re-record wrong (rc $q_rrc, untouched '$q_same', state $q_rrs, lines $q_rrn) -- $q_rr"
# (7) a squash landing has no ancestry: no line until the lower PR's record reads merged, active and then archived; a vanished
# lower branch reads lower=gone, and an entry with no URL drops the gh step.
{ qnew P6 && qw pr branch P6 --name feat/l2 && echo l2 > "$QH/l2.txt" && qg add l2.txt && qg commit -qm "feat: l2" && qg push -q -u origin feat/l2 && qw pr record P6 --url https://github.com/acme/toy/pull/7 \
  && qw phase new --phase P7 --name u2 --objective toy && qw pr branch P7 --name feat/u2 --base feat/l2 && echo u2 > "$QH/u2.txt" && qg add u2.txt && qg commit -qm "feat: u2" && qg push -q -u origin feat/u2 \
  && qw pr record P7 --url https://github.com/acme/toy/pull/8 && qg switch -q main && qg merge -q --squash feat/l2 && qg commit -qm "feat: l2 (squash)" && qg push -q origin main \
  && qn add -A && qn commit -qm "chore: P6 P7"; } > "$QW/p67.txt" 2>&1 || bad "lifecycle probe: P6/P7 failed -- $(tail -3 "$QW/p67.txt")"
q_sq0=$(qw next 2>&1 | grep -c '^pr_stack=P7'); qpass P6; qpr 7 MERGED false '"2026-11-05T10:00:00Z"'; qw pr sync P6 >/dev/null 2>&1
q_sq1=$(qw next 2>&1 | grep '^pr_stack=P7'); qw phase archive P6 >/dev/null 2>&1; q_sq2=$(qw next 2>&1 | grep '^pr_stack=P7')
{ qw phase new --phase P8 --name u3 --objective toy && qg switch -q -c feat/l3 && qw pr branch P8 --name feat/u3 --base feat/l3 && qg branch -q -D feat/l3; } > "$QW/p8.txt" 2>&1 || bad "lifecycle probe: P8 failed -- $(tail -3 "$QW/p8.txt")"
q_gone=$(qw next 2>&1 | grep '^pr_stack=P8')
q_sqx="pr_stack=P7 host:feat/u2 base=feat/l2 lower=merged -- git -C $QH fetch origin; git -C $QH switch feat/u2; git -C $QH merge --no-ff origin/main; git -C $QH push; gh pr edit 8 --base main; sikstack pr branch P7 --name feat/u2 --base main"
[ "$q_sq0" = 0 ] && [ "$q_sq1" = "$q_sqx" ] && [ "$q_sq2" = "$q_sqx" ] && [ ! -d "$QH/.sikstack/works/phases/active/P6" ] \
  && [ "$q_gone" = "pr_stack=P8 host:feat/u3 base=feat/l3 lower=gone -- git -C $QH fetch origin; git -C $QH merge --no-ff origin/main; git -C $QH push; sikstack pr branch P8 --name feat/u3 --base main" ] \
  && ok "pr_stack=: a squash landing prints nothing until the lower PR's record reads merged, then lower=merged from the active record and, archived, from the archived one; a vanished lower branch reads lower=gone, and with no URL the gh pr edit step is dropped" \
  || bad "pr_stack= squash/record/gone wrong (no-record lines $q_sq0) -- $q_sq1 / $q_sq2 / $q_gone"
qg switch -q main; qn add -A; qn commit -qm "chore: before the reopen" >/dev/null 2>&1
# (8) the nested reopen's refusals, each writing nothing: review changes_requested on a done phase with an open PR, an empty
# note, a phase not done, an archived phase, the host's main checkout holding the PR branch, and every PR recorded merged.
r0=$(qsig)
q_c1=$(qw review P1 --verdict changes_requested --note x 2>&1); q_c1rc=$?
q_c2=$(qw phase reopen P1 --note "  " 2>&1); q_c2rc=$?
q_c3=$(qw phase reopen P4 --note "team-reported: x" 2>&1); q_c3rc=$?
q_c4=$(qw phase reopen P3 --note "team-reported: x" 2>&1); q_c4rc=$?
qg switch -q feat/one; q_c5=$(qw phase reopen P1 --note "team-reported: x" 2>&1); q_c5rc=$?; qg switch -q main
cp "$P1J" "$QW/p1.bak"; python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["pr"]["branches"][0]["state"]="merged"; json.dump(d,open(sys.argv[1],"w"),indent=2)' "$P1J"
q_c6=$(qw phase reopen P1 --note "team-reported: x" 2>&1); q_c6rc=$?; cp "$QW/p1.bak" "$P1J"; r1=$(qsig)
if [ "$q_c1rc" -ne 0 ] && printf '%s\n' "$q_c1" | grep -q 'P1 is done and its PR is still open .*phase reopen P1' && [ "$q_c2rc" -ne 0 ] && printf '%s\n' "$q_c2" | grep -q -- '--note is empty.*operator-reported: <what>' \
    && [ "$q_c3rc" -ne 0 ] && printf '%s\n' "$q_c3" | grep -q "P4 is 'planned', not 'done'" && [ "$q_c4rc" -ne 0 ] && printf '%s\n' "$q_c4" | grep -q 'P3 is archived' \
    && [ "$q_c5rc" -ne 0 ] && printf '%s\n' "$q_c5" | grep -q "checked out in the main checkout .* switch main" && [ "$q_c6rc" -ne 0 ] && printf '%s\n' "$q_c6" | grep -q 'every recorded PR reads state=merged .*pr sync P1' \
    && [ "$(printf '%s\n' "$q_c1" "$q_c2" "$q_c3" "$q_c4" "$q_c5" "$q_c6" | grep -c 'nothing was written')" = 6 ] && [ "$r0" = "$r1" ] && [ "$(qj P1 status)" = '"done"' ]; then
  ok "phase reopen refuses an empty note, a phase not done, an archived phase, the host's main checkout holding the PR branch and every PR recorded merged, and review refuses changes_requested on a done phase with an open PR pointing at phase reopen; each writes nothing (nested HEAD, status and events unchanged)"
else bad "the reopen refusals wrong (rc $q_c1rc/$q_c2rc/$q_c3rc/$q_c4rc/$q_c5rc/$q_c6rc, unchanged=$([ "$r0" = "$r1" ] && echo y)) -- $q_c1 / $q_c2 / $q_c3 / $q_c4 / $q_c5 / $q_c6"; fi
# (9) the nested reopen: one stamp commit, the worktree pair on the PR branch, next in both checkouts, a refusal from the phase's
# own stream, the fix and the pass there with phase scope covering it, host main untouched; a still-stamped pair refuses a second
# reopen until the teardown, and a stale branch name gives -reopen2.
q_m0=$(qg rev-parse main); q_n0=$(qn rev-list --count HEAD)
q_ro=$(qw phase reopen P1 --note "team-reported: rename the toy flag" 2>&1); q_rorc=$?
QWT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["execution"]["host_worktree"] or "")' "$P1J" 2>/dev/null)
qwt() { ( cd "$QWT" && PATH="$QG:$PATH" python3 "$ENG" "$@" ); }
git -C "$QWT/.sikstack" config user.email smoke@example.invalid; git -C "$QWT/.sikstack" config user.name smoke
q_dn=$(qw next 2>&1); q_wn=$(qwt next 2>&1); q_ws=$(qwt phase reopen P1 --note "team-reported: again" 2>&1); q_wsrc=$?
{ qwt slice status P1.REVIEW in_progress && echo fix > "$QWT/fix.py" && git -C "$QWT" add fix.py && git -C "$QWT" commit -qm "fix: rename" \
  && qwt gate P1 open --walkthrough again && qwt gate P1 clear --words accept && qwt review P1 --verdict pass && git -C "$QWT/.sikstack" add -A && git -C "$QWT/.sikstack" commit -qm "chore: P1 re-pass"; } > "$QW/repass.txt" 2>&1
q_rprc=$?; q_sc=$(qwt phase scope P1 2>&1)
if [ "$q_rorc" -eq 0 ] && printf '%s\n' "$q_ro" | grep -qx "reopened=P1 branch=host:feat/one worktree=$QH/.claude/worktrees/P1-toy" && [ "$(( $(qn rev-list --count HEAD) - q_n0 ))" = 1 ] \
    && [ "$(qn log -1 --format=%s)" = "chore(works): reopen P1 in its own worktree" ] && [ "$(git -C "$QWT" branch --show-current)" = feat/one ] \
    && [ "$(qj P1 review.status)" = '"changes_requested"' ] && [ "$(qj P1 review.note)" = '"team-reported: rename the toy flag"' ] && [ "$(qj P1 review.fix_passes)" = 1 ] \
    && printf '%s\n' "$q_dn" | grep -q '^parallel_phases_elsewhere=P1:phase/P1-toy ' && printf '%s\n' "$q_wn" | grep -qx 'current_phase=P1' && printf '%s\n' "$q_wn" | grep -qx 'current_slice=P1.REVIEW' \
    && [ "$q_wsrc" -ne 0 ] && printf '%s\n' "$q_ws" | grep -q "P1 is 'in_progress', not 'done'" \
    && [ "$q_rprc" -eq 0 ] && grep -q '^phase P1 review: pass' "$QW/repass.txt" && printf '%s\n' "$q_sc" | grep -qx '  A fix.py' && printf '%s\n' "$q_sc" | grep -qx '  M app.txt' \
    && [ "$q_m0" = "$(qg rev-parse main)" ]; then
  ok "phase reopen on a nested install: one stamp commit, a worktree pair on the PR branch feat/one, the review changes_requested with the team's note; the default stream lists it elsewhere, the worktree's next selects P1.REVIEW and refuses a second reopen there; the fix and the pass land in the worktree, phase scope covers fix.py, and host main is untouched"
else bad "the nested reopen wrong (rc $q_rorc/$q_wsrc/$q_rprc) -- $q_ro / $(printf '%s\n' "$q_dn" | grep parallel_) / $(printf '%s\n' "$q_wn" | grep current_) / $q_ws / $(tail -3 "$QW/repass.txt") / $q_sc"; fi
{ qn add -A && qn commit -qm "chore: rebuild"; qn merge -q --no-ff -m "merge(P1): Toy" phase/P1-toy || { qn checkout -q --theirs works/backlog.md && qn add -A && qn commit -qm "merge(P1): Toy"; }; \
  qw worktree merge-finish && qn add -A && qn commit -qm "chore: integrated"; } > "$QW/merge.txt" 2>&1
q_st=$(qw phase reopen P1 --note "team-reported: again" 2>&1); q_strc=$?
{ qw worktree teardown P1 && qn add -A && qn commit -qm "chore: teardown" && qn branch phase/P1-toy; } > "$QW/teardown.txt" 2>&1
q_r2=$(qw phase reopen P1 --note "operator-reported: again" 2>&1); q_r2rc=$?
if [ "$(qj P1 status)" != null ] && [ "$q_strc" -ne 0 ] && printf '%s\n' "$q_st" | grep -q 'worktree teardown P1 first' \
    && [ "$q_r2rc" -eq 0 ] && printf '%s\n' "$q_r2" | grep -qx 'branch=phase/P1-toy-reopen2' && printf '%s\n' "$q_r2" | grep -q '^reopened=P1 branch=host:feat/one ' \
    && printf '%s\n' "$q_r2" | grep -q "^next: .* -- read the operator's request (the reopen note 'operator-reported: again', plus any PR comment or failing check it points at), cut fix slices" \
    && ! printf '%s\n' "$q_r2" | grep -q "team's review" && printf '%s\n' "$q_ro" | grep -q "^next: .* -- read the team's review (gh pr view <n> --json reviews,comments), cut fix slices" \
    && [ "$q_m0" = "$(qg rev-parse main)" ] && ! git -C "$QH" merge-base --is-ancestor feat/one main; then
  ok "after the integration a still-stamped pair refuses a second reopen (worktree teardown first); after the teardown, with the old phase branch still present, the second reopen (operator-reported) cuts phase/P1-toy-reopen2 and its next: line reads the operator's request, never the team's review (the first, team-reported, reads the team's); host main never moved and feat/one is not in it"
else bad "the still-stamped refusal or -reopen2 wrong (rc $q_strc/$q_r2rc) -- $q_st / $q_r2 / $(tail -3 "$QW/merge.txt") / $(tail -3 "$QW/teardown.txt")"; fi
# (11) a multi-repo host: pr sync --repo reads one repo's PR; pr team needs --repo there; the pr_stack= steps carry --repo; the
# reopen needs --host-branch and builds its set from the open PR branches.
newtmp QMW; QMW=$(cd "$QMW" && pwd -P); QM="$QMW/host"; mkdir -p "$QM"
for r in api web; do git init -q --bare "$QMW/$r.git"; mkdir -p "$QM/$r"; ( cd "$QM/$r" && git init -q . && git symbolic-ref HEAD refs/heads/main && git config user.email smoke@example.invalid \
  && git config user.name smoke && echo "$r" > "$r.txt" && git add -A && git commit -qm "feat: $r" && git remote add origin "$QMW/$r.git" && git push -q origin main && git remote set-head origin main ) >/dev/null 2>&1; done
qm() { ( cd "$QM" && PATH="$QG:$PATH" python3 "$ENG" "$@" ); }
{ mkhost "$QM" && qm repo add api && qm repo add web && ( cd "$QM" && python3 "$ENG" init ) \
  && git -C "$QM" config user.email smoke@example.invalid && git -C "$QM" config user.name smoke && git -C "$QM/.sikstack" config user.email smoke@example.invalid && git -C "$QM/.sikstack" config user.name smoke \
  && qm phase new --phase P1 --name multi --objective toy && qm gate P1 waive --note toy && qm slice status P1.DECOMP done \
  && qm pr branch P1 --repo api --name feat/api && echo x >> "$QM/api/api.txt" && git -C "$QM/api" commit -qam "feat: x" && git -C "$QM/api" push -q -u origin feat/api \
  && qm pr branch P1 --repo web --name feat/web && echo y >> "$QM/web/web.txt" && git -C "$QM/web" commit -qam "feat: y" && git -C "$QM/web" push -q -u origin feat/web \
  && qm pr record P1 --repo api --url https://github.com/acme/api/pull/11 && qm pr record P1 --repo web --url https://github.com/acme/web/pull/21 \
  && qm slice status P1.REVIEW in_progress && : > "$QM/.sikstack/works/phases/active/P1/slices/P1.REVIEW/result.md" && qm review P1 --verdict pass \
  && git -C "$QM/.sikstack" add -A && git -C "$QM/.sikstack" commit -qm "P1 done"; } > "$QMW/setup.txt" 2>&1 || bad "multi-repo lifecycle probe: setup failed -- $(tail -3 "$QMW/setup.txt")"
mv "$QG/gh.log" "$QG/gh.log.nested" 2>/dev/null
qpr 11 OPEN false null; q_ms=$(qm pr sync P1 --repo api 2>&1); q_msrc=$?; q_mslog=$(cat "$QG/gh.log" 2>/dev/null)
q_mt0=$(qm pr team 2>&1); q_mt0rc=$?; q_mt=$(qm pr team --repo api 2>&1); q_mtr=$(qm pr team --record solo --repo api --evidence "one author" 2>&1); q_mo=$(qm next 2>&1 | grep '^pr_open=P1 api:')
{ qm phase new --phase P2 --name up --objective toy && qm pr branch P2 --repo api --name feat/api2 --base feat/api && echo z >> "$QM/api/api.txt" && git -C "$QM/api" commit -qam "feat: z" \
  && git -C "$QM/api" push -q -u origin feat/api2 && qm pr record P2 --repo api --url https://github.com/acme/api/pull/12 && git -C "$QM/api" switch -q main \
  && git -C "$QM/api" merge -q --no-ff feat/api -m "merge feat/api" && git -C "$QM/api" push -q origin main && git -C "$QM/web" switch -q main \
  && git -C "$QM/.sikstack" add -A && git -C "$QM/.sikstack" commit -qm "P2"; } > "$QMW/p2.txt" 2>&1 || bad "multi-repo lifecycle probe: P2 failed -- $(tail -3 "$QMW/p2.txt")"
q_mst=$(qm next 2>&1 | grep '^pr_stack=')
q_mr0=$(qm phase reopen P1 --note "team-reported: x" 2>&1); q_mr0rc=$?
q_mr=$(qm phase reopen P1 --note "team-reported: x" --host-branch hostfix 2>&1); q_mrrc=$?
if [ "$q_msrc" -eq 0 ] && printf '%s\n' "$q_ms" | grep -qx 'pr_sync=api:feat/api state=ready base=main head=0123456 review=none merged_at=none' && ! printf '%s\n' "$q_ms" | grep -q 'web:' \
    && [ "$q_mslog" = "pr view https://github.com/acme/api/pull/11 --json state,isDraft,mergedAt,baseRefName,headRefOid,reviewDecision,updatedAt,comments" ] \
    && [ "$q_mt0rc" -ne 0 ] && printf '%s\n' "$q_mt0" | grep -q 'needs --repo <name> (registered: api, web)' && printf '%s\n' "$q_mt" | grep -q '^pr_team=api recorded=none detected=solo ' \
    && printf '%s\n' "$q_mtr" | grep -q '^pr team: recorded -- api is solo' && printf '%s\n' "$q_mo" | grep -q "the close's merge is due" \
    && [ "$q_mst" = "pr_stack=P2 api:feat/api2 base=feat/api lower=merged -- git -C $QM/api fetch origin; git -C $QM/api switch feat/api2; git -C $QM/api merge --no-ff origin/main; git -C $QM/api push; gh pr edit 12 --base main; sikstack pr branch P2 --repo api --name feat/api2 --base main" ] \
    && [ "$q_mr0rc" -ne 0 ] && printf '%s\n' "$q_mr0" | grep -q -- '--host-branch <name> -- nothing was written' \
    && [ "$q_mrrc" -eq 0 ] && printf '%s\n' "$q_mr" | grep -qx "reopened=P1 branch=api:feat/api,web:feat/web worktree=$QM/.claude/worktrees/P1-multi"; then
  ok "multi-repo: pr sync --repo api reads only api's PR (one gh call); pr team needs --repo, reads api: and records it solo (its pr_open= hint then says the merge is due); the pr_stack= steps run in the api checkout and re-record with --repo api; the reopen refuses with no --host-branch, then builds the set api:feat/api,web:feat/web"
else bad "multi-repo lifecycle wrong (rc $q_msrc/$q_mt0rc/$q_mr0rc/$q_mrrc) -- $q_ms / log: $q_mslog / $q_mt0 / $q_mt / $q_mtr / $q_mo / $q_mst / $q_mr0 / $q_mr"; fi
# (12) zero GitHub writes: every call the stub saw is a read (pr view, the collaborators GET).
cat "$QG/gh.log.nested" "$QG/gh.log" 2>/dev/null > "$QG/gh.all"
q_w=$(grep -cvE '^(pr view https://github\.com/[^ ]+ --json [a-zA-Z,]+|api repos/[^ ]+/collaborators --paginate --jq \.\[\]\.login)$' "$QG/gh.all")
[ "$q_w" = 0 ] && [ "$(grep -c '' "$QG/gh.all")" -gt 10 ] && ok "zero GitHub writes: every one of the $(grep -c '' "$QG/gh.all") calls the stub gh saw is a read (pr view --json, the collaborators GET)" \
  || bad "the stub gh saw a call that is not a read -- $(grep -vE '^(pr view |api repos/)' "$QG/gh.all" | head -3)"
echo "pr lifecycle test runtime: $(( $(date +%s) - lc_t0 ))s"

# The engine counts a review cycle's fix passes: the first changes_requested prints the fix-slice hint and no count,
# a blocked verdict adds nothing, the second prints fix_passes=2 and the stop in place of the hint, and a pass
# ends the cycle (the next change request counts one again).
newtmp QRW; QR="$QRW/ws"; mkhost "$QR" >/dev/null 2>&1; qr() { ( cd "$QR" && python3 "$ENG" "$@" ); }
qr phase new --phase P9 --name count --objective count >/dev/null 2>&1
fp1=$(qr review P9 --verdict changes_requested --note one 2>&1)
fpb=$(qr review P9 --verdict blocked --note wait 2>&1)
fp2=$(qr review P9 --verdict changes_requested --note two 2>&1)
fpn() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["review"].get("fix_passes"))' "$QR/.sikstack/works/phases/active/P9/phase.json"; }
fp2n=$(fpn); qr gate P9 waive --note probe >/dev/null 2>&1; fpp=$(qr review P9 --verdict pass 2>&1); fppn=$(fpn)
fp3=$(qr review P9 --verdict changes_requested --note three 2>&1); fp3n=$(fpn)
if ! printf '%s\n' "$fp1$fpb" | grep -q 'fix_passes=' && printf '%s\n' "$fp1" | grep -q '^create fix slices' \
    && printf '%s\n' "$fp2" | grep -q "^fix_passes=2: the one fix pass already ran -- a further fix needs the operator's word" \
    && printf '%s\n' "$fp2" | grep -q 'slice status P9.REVIEW pending --stop-kind decision' \
    && ! printf '%s\n' "$fp2" | grep -q '^create fix slices' && [ "$fp2n" = 2 ] \
    && ! printf '%s\n' "$fp3" | grep -q 'fix_passes=' && printf '%s\n' "$fp3" | grep -q '^create fix slices' && [ "$fp3n" = 1 ]; then
  ok "review counts the cycle's fix passes: the hint and no count on the first changes_requested, fix_passes=2 with the stop in its place on the second, a blocked verdict adds none, a pass clears it"
else bad "the fix-pass count is wrong ($fp2n/$fppn/$fp3n) -- $fp1 / $fpb / $fp2 / $fpp / $fp3"; fi

# ---------------------------------------------------------------------------
echo "== Test 21: cloud mode at the command boundary -- inert without a [cloud] link in config.toml (no socket opened, no .hi2vi written); with a link, against a local fake sikstack: one batch after a command (its own files origin command, an agent's result.md origin carried, the P9 records, both headers, the key only as a Bearer), equal content sends nothing, an archive goes as move ops and events.jsonl only as appends, a cloud-only change is pulled at the next command and the generated files rebuilt =="
cl_t0=$(date +%s)
newtmp CLW; CL="$CLW/host"; CLX="$CLW/xdg"; CL_OUT="$CLW/out.txt"; : > "$CL_OUT"
cl() { ( cd "$CL" && XDG_CONFIG_HOME="$CLX" python3 "$ENG" "$@" ) 2>&1 | tee -a "$CL_OUT"; }
# One engine command under a socket guard: any connect (or urlopen) ends the process with 97.
cl_nosock() { ( cd "$CL" && XDG_CONFIG_HOME="$CLX" python3 - "$@" <<'PY'
import os, runpy, socket, sys, urllib.request
def guard(*a, **k):
    sys.stderr.write("SOCKET-OPENED\n")
    os._exit(97)
socket.socket.connect = guard
socket.create_connection = guard
urllib.request.urlopen = guard
urllib.request.OpenerDirector.open = guard
sys.argv = [__import__("os").environ["ENG"]] + sys.argv[1:]
runpy.run_path(__import__("os").environ["ENG"], run_name="__main__")
PY
); }
{ mkhost "$CL" \
  && git -C "$CL" config user.email smoke@example.invalid && git -C "$CL" config user.name smoke \
  && git -C "$CL/.sikstack" config user.email smoke@example.invalid && git -C "$CL/.sikstack" config user.name smoke; } > "$CLW/setup.txt" 2>&1 \
  || bad "cloud probe: the install failed -- $(tail -3 "$CLW/setup.txt")"
# (a) local mode: no link file, so no command opens a socket or writes .hi2vi/ (byte-equal: the whole suite).
cl_in=""
for c in "next" "phase new --phase P1 --name One --objective toy" "phase new --phase P2 --name Two --objective toy" \
    "agenda-add --title a --author person:smoke" "agenda-add --title x --author agent:smoke" "check" "check --no-rebuild" "next --card"; do
  # shellcheck disable=SC2086
  cl_nosock $c > "$CLW/nosock.txt" 2>&1; [ "$?" = 97 ] && cl_in="$cl_in [$c: $(tail -1 "$CLW/nosock.txt")]"
done
[ -z "$cl_in" ] && [ ! -e "$CL/.sikstack/.hi2vi" ] && [ -d "$CL/.sikstack/works/phases/active/P2" ] \
  && ok "local mode: with no [cloud] link, next, phase new, agenda-add (a person's and an agent's), check, check --no-rebuild and next --card open no socket and write no .hi2vi/" \
  || bad "local mode reached the network or wrote .hi2vi/ --$cl_in $(ls -a "$CL/.sikstack/.hi2vi" 2>/dev/null)"
# (b) link the checkout by hand to a fake sikstack on a free port (the link command itself is not part of this check).
CLK="cloud-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$CLK" > "$CLW/key"; chmod 600 "$CLW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$CLW/fake" --port-file "$CLW/port" --key-file "$CLW/key" \
  --project proj-1 --org org-1 --lifetime 600 > "$CLW/fake.txt" 2>&1 &
CL_PID=$!
for _ in $(seq 1 100); do [ -s "$CLW/port" ] && break; sleep 0.1; done
CLS="http://127.0.0.1:$(cat "$CLW/port" 2>/dev/null)"
# The key sits in the pre-plugin engine's key file ($XDG_CONFIG_HOME/sikstack/), which the engine still reads.
mkdir -p "$CL/.sikstack/.hi2vi" "$CLX/hi2vi" && chmod 700 "$CLX/hi2vi" && set_link "$CL/.sikstack" "$CLS"
python3 - "$CLX/hi2vi/workspace-keys.json" "$CLS" "$CLW/key" <<'PY' || bad "cloud probe: could not write the link"
import json, os, sys
keys, server, keyfile = sys.argv[1:]
with open(keyfile) as f:
    key = f.read().strip()
fd = os.open(keys, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({server: {"proj-1": {"key": key, "org_id": "org-1", "saved_at": "2026-11-18T00:00:00Z"}}}, f)
PY
cl_mark() { if [ -f "$CLW/fake/requests.jsonl" ]; then grep -c '' "$CLW/fake/requests.jsonl"; else echo 0; fi; }
# cl_check <mark> <check> [args]: one named assertion over the fake's requests since <mark>, its state and base.json.
cl_check() { python3 - "$CLW/fake/requests.jsonl" "$CLS" "$CL/.sikstack" "$@" <<'PY'
import http.client, json, sys
from pathlib import Path
from urllib.parse import urlparse
log, server, root, mark, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6:]
lines = Path(log).read_text().splitlines() if Path(log).exists() else []
R = [json.loads(l) for l in lines[mark:]]
C = [r for r in R if r["path"].endswith("/commit")]
ops = [op for c in C for op in c["batch"]["ops"]]
u = urlparse(server)
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("GET", "/_fake/state")
S = json.loads(conn.getresponse().read())
base = json.loads((root / ".hi2vi/base.json").read_text()) if (root / ".hi2vi/base.json").exists() else {}
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
need(R and all(r["checkout"] and (r["engine"] or "").startswith("v") and r["auth"] == "ok" for r in R),
     f"a request lacked X-Sikstack-Checkout, X-Sikstack-Engine: v<NN> or the Bearer key: {R[:1]}")
need(all(op["op"] != "put" or op["path"] != "works/events.jsonl" for op in ops), "works/events.jsonl went as a put")
if check == "first":
    need(len(C) == 1 and C[0]["status"] == 200, f"one batch expected, got {[c['status'] for c in C]}")
    need(all(op["origin"] == "carried" for op in ops), "a first sync's files are carried")
    need(all(op["op"] in ("put", "append") and op.get("base_rev") is None for op in ops), "a first sync only adds")
    need(any(op["op"] == "append" and op["path"] == "works/events.jsonl" for op in ops), "events.jsonl not sent as an append")
    need(not any(p.startswith("works/templates/") or p in ("works/state.json", "works/index.json",
         "works/backlog.md", "works/agenda.md", "works/.workspace-version.json") for p in live), f"a non-truth file reached the cloud: {sorted(live)}")
    need("works/phases/active/P2/phase.json" in live and "docs/current/product.md" in live and "docs/index.json" not in live,
         "a truth file is missing in the cloud (the plain docs/current files are truth since the docs subsystem retired)")
    need(C[0]["batch"]["derived"] == ["works/index.json", "works/state.json"], f"the P9 records: {C[0]['batch']['derived']}")
    need(base.get("head") == S["head"] == 1 and set(base.get("files", {})) == set(live), "base.json does not match the cloud")
elif check == "carried":
    need(len(C) == 1 and C[0]["status"] == 200 and C[0]["batch"]["command"].startswith("agenda-add "), "one agenda-add batch expected")
    by = {(op["op"], op.get("path")): op for op in ops}
    res = by.get(("put", "works/phases/active/P1/slices/P1.DECOMP/result.md"))
    need(res is not None and res["origin"] == "carried" and res["base_rev"] is None, f"result.md: {res}")
    dj = [op for op in ops if op.get("path", "").endswith("/agenda.json")]
    need(dj and all(op["op"] == "put" and op["origin"] == "command" for op in dj), f"agenda.json: {dj}")
    ev = by.get(("append", "works/events.jsonl"))
    need(ev is not None and ev["origin"] == "command" and ev["lines"] >= 1, f"events: {ev}")
    need(C[0]["batch"]["derived"] == ["works/index.json", "works/state.json"], "the P9 records")
    need(base.get("head") == S["head"] and all(base["files"][p]["rev"] == live[p]["rev"] for p in live), "base.json not updated on 200")
elif check == "noop":
    need(not C and len([r for r in R if r["path"].endswith("/head")]) >= 2, f"equal content sent {len(C)} batch(es)")
elif check == "archive":
    need(len(C) == 1 and C[0]["status"] == 200, "one archive batch expected")
    mv = [op for op in ops if op["op"] == "move"]
    need(mv and all(op["from"].startswith("works/phases/active/P1/") and op["to"].startswith("works/phases/archived/") for op in mv), f"moves: {mv}")
    need(not [op for op in ops if op["op"] == "delete"], f"deletes sent: {[op for op in ops if op['op'] == 'delete']}")
    need(any(op["from"].endswith("/P1.DECOMP/result.md") for op in mv), "the carried result.md did not move")
    need([op["op"] for op in ops if op.get("path") == "works/events.jsonl"] == ["append"], "events.jsonl not one append")
    need(not [p for p in live if p.startswith("works/phases/active/P1/")], "P1 still live in the cloud")
elif check == "pulled":
    need(any(r["path"].endswith("/manifest") for r in R), "no manifest was read")
    need(any("works/phases/active/P2/phase.json" in (r.get("paths") or []) for r in R), "phase.json was not fetched")
    need(base.get("head") == S["head"], f"base head {base.get('head')} != cloud head {S['head']}")
    need(json.loads((root / "works/phases/active/P2/phase.json").read_text())["name"] == "Two, renamed in sikstack", "disk not pulled")
print("ok")
PY
}
cl_m=$(cl_mark); cl next >/dev/null; cl_r=$(cl_check "$cl_m" first)
[ "$cl_r" = ok ] && ok "linked: the first command sends the truth set as one carried batch (works/events.jsonl as an append, never generated files, templates or the version marker), with the two P9 records; every request carries X-Sikstack-Checkout, X-Sikstack-Engine: v<NN> and the Bearer key; base.json holds the cloud's head" \
  || bad "linked first batch wrong -- $cl_r"
# (c) an agent writes result.md with plain file I/O; the next command's batch carries it.
printf 'an agent wrote this\n' > "$CL/.sikstack/works/phases/active/P1/slices/P1.DECOMP/result.md"
cl_m=$(cl_mark); cl agenda-add --title b --author person:smoke >/dev/null; cl_r=$(cl_check "$cl_m" carried)
[ "$cl_r" = ok ] && ok "an agent-written result.md rides agenda-add's one batch with origin carried, beside the command's agenda.json (origin command) and its events.jsonl lines (an append), and base.json takes the revisions on 200" \
  || bad "the carried batch wrong -- $cl_r"
# (d) equal content: the same bytes rewritten, then a rebuild and a read: no batch, base.json unchanged.
cl_b0=$(sha "$CL/.sikstack/.hi2vi/base.json"); sleep 1
printf 'an agent wrote this\n' > "$CL/.sikstack/works/phases/active/P1/slices/P1.DECOMP/result.md"
cl_m=$(cl_mark); cl check >/dev/null; cl next >/dev/null; cl_r=$(cl_check "$cl_m" noop)
[ "$cl_r" = ok ] && [ "$cl_b0" = "$(sha "$CL/.sikstack/.hi2vi/base.json")" ] \
  && ok "equal content is a no-op: result.md rewritten with its own bytes, then rebuild and next, send no batch and leave base.json byte-equal" \
  || bad "equal content sent a batch or moved base.json -- $cl_r"
# (e) an archive's folder move: move ops paired by sha, no delete, events.jsonl one append.
cl_m=$(cl_mark); cl phase archive P1 --force >/dev/null; cl_r=$(cl_check "$cl_m" archive)
[ "$cl_r" = ok ] && ok "phase archive's folder move goes as move ops paired by sha (no delete, the carried result.md moved too) and works/events.jsonl as one append, never a revisioned put" \
  || bad "the archive batch wrong -- $cl_r"
# (f) a change made only in the cloud (another checkout renames P2) is pulled at the next command, and the
# generated files are rebuilt after the pull: section is a read that renders nothing, so only the pull's rebuild can.
python3 - "$CLS" "$CL/.sikstack/works/phases/active/P2/phase.json" <<'PY' || bad "cloud probe: the fake write failed"
import http.client, json, sys
from urllib.parse import urlparse
data = json.load(open(sys.argv[2]))
data["name"] = "Two, renamed in sikstack"
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/write", json.dumps({"path": "works/phases/active/P2/phase.json",
             "content": json.dumps(data, ensure_ascii=False, indent=2) + "\n"}), {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
cl_m=$(cl_mark); cl section P2 Objective >/dev/null; cl_r=$(cl_check "$cl_m" pulled)
[ "$cl_r" = ok ] && grep -qF 'Two, renamed in sikstack' "$CL/.sikstack/works/backlog.md" \
  && grep -qF 'Two, renamed in sikstack' "$CL/.sikstack/works/index.json" \
  && ok "a cloud-only change is pulled at the next command's begin step (manifest, fetch, base.json at the cloud's head) and backlog.md and index.json are rebuilt from it" \
  || bad "the cloud-only change was not pulled and rebuilt -- $cl_r / $(grep -F 'Two' "$CL/.sikstack/works/backlog.md" | head -2)"
# (g) the key never reaches the tree, the command output or the fake's request log.
if grep -rqF "$CLK" "$CL" "$CL_OUT" "$CLW/fake" 2>/dev/null; then bad "the workspace key leaked into the tree, the output or the request log"
else ok "the workspace key appears nowhere in the checkout, the commands' output or the fake's request log"; fi
kill "$CL_PID" 2>/dev/null; wait "$CL_PID" 2>/dev/null
echo "cloud mode test runtime: $(( $(date +%s) - cl_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 22: cloud mode's safety half, against the local fake sikstack -- offline a command is refused with the one P8 line and the tree unchanged, and compact-resume fails open; a lost commit answer is resent with the same batch_id and lands once; a batch never sent goes at the next command; a command that dies midway leaves the journal running and the next command refuses naming sync; a pull killed at any step of an append-only file's merge (the event log, a local order of its own) leaves each line in sikstack once; a stale write (409) keeps the disk, writes nothing in sikstack and exits 1, then the mismatch refuses with nothing changed; two engine processes in one checkout are serialized by .hi2vi/lock; a change over 8,000,000 B goes as several batches, and one file too big for any batch is refused; every failure inside the boundary is one line, never a traceback (a cut or malformed answer, a commit answer cut mid-body, a fetch that does not decode, a write error during a pull), and the hook's note; compact-resume stays inside the hook's 15 s on a slow, dripping or slow-but-moving server; a request fails only when it stalls: a slow but moving pull, push and pushing resend each finish past 10 s, a stalled or dripping server ends an ordinary command in one line in bounded time, a 409 whose body stalls keeps its batch (never 0 conflicts), and no late timer turns a whole answer into a failure; every wait is judged, the set-up included: behind an HTTPS proxy that answers its CONNECT late or drips it, the hook keeps its 9 s and an ordinary command ends in one line; over TLS a byte counts as it crosses the socket and the handshake still verifies; a key holding a control character is refused unquoted =="
sf_t0=$(date +%s)
newtmp SFW; SF="$SFW/host"; SFX="$SFW/xdg"; SF_OUT="$SFW/out.txt"; : > "$SF_OUT"
sf() { ( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 "$(wf_entry "$1")" "$@" ) 2>&1 | tee -a "$SF_OUT"; return "${PIPESTATUS[0]}"; }
# sf_crash kill|raise|pull <args>: the command, with agenda-add made to die after it wrote its files (os._exit, or a
# raise), or (pull) the process killed when a pull has written its files but not yet base.json.
sf_crash() { _m=$1; shift; ( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - "$_m" "$@" <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
agenda, cloud = sys.modules["wf_agenda"], sys.modules["wf_cloud"]  # the parts the engine imported
mode, real = sys.argv[1], agenda.agenda_add
def crash(args):
    real(args)
    if mode == "kill":
        os._exit(9)
    raise RuntimeError("a crash in the middle of the command")
agenda.agenda_add = crash
if mode == "pull":
    cloud.CloudSession.save_base = lambda self: os._exit(9)
sys.exit(mod.main(sys.argv[2:]))
PY
) >> "$SF_OUT" 2>&1; }
# The whole workflow tree's sha list (.git aside), to prove a refusal changed nothing.
sf_tree() { python3 - "$SF/.sikstack" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
for d, dirs, files in sorted(os.walk(root)):
    dirs[:] = sorted(x for x in dirs if not (d == root and x == ".git"))
    for f in sorted(files):
        p = os.path.join(d, f)
        print(os.path.relpath(p, root), hashlib.sha256(open(p, "rb").read()).hexdigest())
PY
}
{ mkhost "$SF" \
  && ( cd "$SF" && python3 "$ENG" phase new --phase P1 --name One --objective toy ); } > "$SFW/setup.txt" 2>&1 \
  || bad "cloud safety probe: the install failed -- $(tail -3 "$SFW/setup.txt")"
SFK="cloud-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$SFK" > "$SFW/key"; chmod 600 "$SFW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$SFW/fake" --port-file "$SFW/port" --key-file "$SFW/key" \
  --project proj-1 --org org-1 --lifetime 600 > "$SFW/fake.txt" 2>&1 &
SF_PID=$!
for _ in $(seq 1 100); do [ -s "$SFW/port" ] && break; sleep 0.1; done
SFS="http://127.0.0.1:$(cat "$SFW/port" 2>/dev/null)"
mkdir -p "$SF/.sikstack/.hi2vi" "$SFX/sikstack" && chmod 700 "$SFX/sikstack" && set_link "$SF/.sikstack" "$SFS"
python3 - "$SFX/sikstack/workspace-keys.json" "$SFS" "$SFW/key" <<'PY' || bad "cloud safety probe: could not write the link"
import json, os, sys
keys, server, keyfile = sys.argv[1:]
with open(keyfile) as f:
    key = f.read().strip()
fd = os.open(keys, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump({server: {"proj-1": {"key": key}}}, f)
PY
sf_ctl() { python3 - "$SFS" "$1" <<'PY'
import http.client, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/control", sys.argv[2], {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
# sf_put <path> <file>: another checkout writes <file>'s text to <path> in sikstack.
sf_put() { python3 - "$SFS" "$1" "$2" <<'PY' || bad "cloud safety probe: the fake write failed"
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/write", json.dumps({"path": sys.argv[2], "content": open(sys.argv[3]).read()}), {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
sf_mark() { if [ -f "$SFW/fake/requests.jsonl" ]; then grep -c '' "$SFW/fake/requests.jsonl"; else echo 0; fi; }
# sf_check <mark> <check> [args]: one named assertion over the fake's requests since <mark>, its records, base.json,
# the journal and the disk.
sf_check() { python3 - "$SFW/fake/requests.jsonl" "$SFS" "$SF/.sikstack" "$@" <<'PY'
import base64, hashlib, http.client, json, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, mark, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6:]
R = [json.loads(l) for l in (Path(log).read_text().splitlines() if Path(log).exists() else [])[mark:]]
C = [r for r in R if r["path"].endswith("/commit")]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())
S = get("/_fake/state")[1]
base = json.loads((root / ".hi2vi/base.json").read_text()) if (root / ".hi2vi/base.json").exists() else {}
journal = json.loads((root / ".hi2vi/journal.json").read_text()) if (root / ".hi2vi/journal.json").exists() else None
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
def sha(p):
    return hashlib.sha256((root / p).read_bytes()).hexdigest()
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
def synced():
    """base.json, sikstack and the disk agree: the head, every record's rev, every file's sha; the event log is cold
    (0.4.0): once a push lands its sent lines leave the disk, so the file there is empty."""
    outbox = root / ".hi2vi/outbox"
    need(journal is None and (not outbox.exists() or not any(outbox.iterdir())), f"the journal or the outbox is left: {journal}")
    need(base.get("head") == S["head"], f"base head {base.get('head')} != sikstack head {S['head']}")
    need(set(base["files"]) == set(live), f"base and sikstack hold different paths: {sorted(set(base['files']) ^ set(live))[:4]}")
    for p, f in live.items():
        need(base["files"][p]["rev"] == f["rev"], f"{p}: base rev {base['files'][p]['rev']} != sikstack rev {f['rev']}")
        if p == "works/events.jsonl":
            need(not (root / p).exists() or (root / p).read_bytes() == b"", f"{p}: the disk still holds sent lines")
        else:
            need((root / p).is_file() and sha(p) == f["sha256"], f"{p}: the disk differs from sikstack")
if check == "first":
    need(len(C) == 1 and C[0]["status"] == 200, f"one first batch expected: {[c['status'] for c in C]}")
    synced()
elif check == "lost":  # extra: revisions before the command
    need(len(C) == 1 and str(C[0]["status"]).startswith("drop-after"), f"the commit's answer was not lost: {[c['status'] for c in C]}")
    need(journal is not None and journal.get("state") == "pushing" and journal.get("batches") == [C[0]["batch"]["batch_id"]],
         f"the journal does not name the lost batch: {journal}")
    need(S["revisions"] > int(extra[0]), "the batch did not land in sikstack")
elif check == "unsent":  # extra: revisions before the command
    need(len(C) == 1 and C[0]["status"] == "drop-before", f"the commit was not dropped: {[c['status'] for c in C]}")
    need(journal is not None and journal.get("state") == "pushing" and journal.get("batches") == [C[0]["batch"]["batch_id"]],
         f"the journal does not name the unsent batch: {journal}")
    need(S["revisions"] == int(extra[0]), "a dropped batch landed")
elif check == "resent":  # extra: the batch id, revisions after it landed (or before, for a batch never applied), replay
    bid, revs, replay = extra[0], int(extra[1]), extra[2] == "replay"
    need(C and C[0]["batch"]["batch_id"] == bid and C[0]["status"] == 200 and C[0]["batch"]["replay"] == replay,
         f"the next command did not resend batch {bid} first: {[(c['batch']['batch_id'], c['status'], c['batch']['replay']) for c in C]}")
    need((S["revisions"] == revs) if replay else (S["revisions"] > revs), f"the batch landed twice or never: {S['revisions']} vs {revs}")
    synced()
elif check == "interrupted":  # extra: the crash's class or -
    need(journal is not None and journal.get("state") == "running" and journal.get("command", "").startswith("agenda-add"),
         f"the journal is not running agenda-add: {journal}")
    need((journal.get("crashed") == extra[0]) if extra[0] != "-" else "crashed" not in journal, f"crashed: {journal.get('crashed')}")
    need(not C, "a crashed command sent a batch")
elif check == "stale":  # extra: the path, revisions and head before, the cloud's content
    path, revs, head, cloud = extra[0], int(extra[1]), int(extra[2]), extra[3]
    need(len(C) == 1 and C[0]["status"] == 409, f"one refused batch expected: {[c['status'] for c in C]}")
    need(S["head"] == head + 1 and S["revisions"] == revs + 1, f"sikstack wrote more than the other checkout's change: {S['head']} {S['revisions']}")
    content = base64.b64decode(get("/_fake/file?path=" + quote(path))[1]["content"]).decode()
    need(content == cloud, "sikstack's copy is not the other checkout's")
    need("changed here" in (root / path).read_text(), "the disk lost this checkout's change")
    need(base["files"][path]["sha256"] != sha(path), "base.json no longer names the unsent change")
    need(journal is None, f"a refused batch left the journal: {journal}")
elif check == "serialized":
    need(len(C) == 2 and all(c["status"] == 200 and not c["batch"]["replay"] for c in C), f"two landed batches expected: {[(c['status'], c['batch']['replay']) for c in C]}")
    heads = [r for r in R if r["path"].endswith("/head")]
    need(len(heads) == 2, f"each process asks head once: {len(heads)}")
    dj = sorted(p for p in live if p.endswith("/agenda.json"))
    need(dj == sorted(str(p.relative_to(root)) for p in (root / "works/agenda").glob("*/agenda.json")), "sikstack lacks an agenda item")
    synced()
elif check == "split":  # extra: the number of big files
    need(len(C) >= 2 and all(c["status"] == 200 for c in C), f"several landed batches expected: {[(c['status'], c.get('bytes')) for c in C]}")
    need(all(0 < c["bytes"] < 8_000_000 for c in C), f"a batch over 8,000,000 B: {[c.get('bytes') for c in C]}")
    need(len({c["batch"]["batch_id"] for c in C}) == len(C), "two batches shared a batch_id")
    need(len([p for p in live if "/topics/big-" in p]) == int(extra[0]), "a big file is missing in sikstack")
    synced()
elif check == "toobig":
    need(not C, f"a batch was sent: {[(c['status'], c.get('bytes')) for c in C]}")
    need(journal is None, f"the journal is left: {journal}")
elif check == "synced":
    synced()
elif check == "nofetch":  # extra: a path no fetch since the mark asked for
    need(not [r for r in R if r["path"].endswith("/fetch") and extra[0] in (r.get("paths") or [])], f"{extra[0]} was fetched")
elif check == "once":  # extra: the append-only paths (comma-separated), then marks each once in sikstack
    import collections
    need(journal is None and base.get("head") == S["head"], f"not settled: journal {journal}, base head {base.get('head')} vs {S['head']}")
    cloud_lines = []
    for p in extra[0].split(","):
        c = base64.b64decode(get("/_fake/file?path=" + quote(p))[1]["content"]).decode().splitlines()
        d = (root / p).read_text().splitlines()
        twice = sorted(l for l, n in collections.Counter(c).items() if n > 1)
        need(not twice, f"{p}: sikstack holds {len(twice)} line(s) twice, first {twice[:1]}")
        need(not d, f"{p}: the disk's log still holds {len(d)} line(s) once the push landed (sent lines leave the disk)")
        cloud_lines += c
    for mark in extra[1:]:
        n = sum(mark in l for l in cloud_lines)
        need(n == 1, f"{mark}: {n} line(s) in sikstack, not 1")
print("ok")
PY
}
sf_revs() { python3 - "$SFS" "$1" <<'PY'
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("GET", "/_fake/state")
print(json.loads(conn.getresponse().read())[sys.argv[2]])
PY
}
sf_m=$(sf_mark); sf next >/dev/null; sf_r=$(sf_check "$sf_m" first)
[ "$sf_r" = ok ] || bad "cloud safety probe: the first sync failed -- $sf_r"
# (a) offline: the begin step's P1 fails, so the command never runs: exit 1, one line, the tree unchanged.
sf_ctl '{"offline": true}'
sf_t1=$(sf_tree); sf agenda-add --title off --author person:smoke > "$SFW/a.txt"; sf_rc=$?; sf_t2=$(sf_tree)
[ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/a.txt")" = 1 ] && [ "$sf_t1" = "$sf_t2" ] \
  && grep -qE '^sikstack is not reachable at http://127\.0\.0\.1:[0-9]+ \(.+\): in cloud mode nothing runs offline, and nothing was changed\.$' "$SFW/a.txt" \
  && ok "offline: agenda-add is refused before it runs with exit 1 and P8's one line, and the workflow tree's sha list is equal before and after" \
  || bad "offline refusal wrong -- rc=$sf_rc $(head -3 "$SFW/a.txt") $(diff <(echo "$sf_t1") <(echo "$sf_t2") | head -3)"
echo '{}' | sf compact-resume > "$SFW/a2.txt"; sf_rc=$?
[ "$sf_rc" = 0 ] && grep -q '^compaction=done' "$SFW/a2.txt" && grep -qE '^note: sikstack is not reachable at ' "$SFW/a2.txt" \
  && ok "offline: compact-resume (the session hook) fails open: exit 0, the resume card from the disk, P8's line as a note" \
  || bad "compact-resume offline did not fail open -- rc=$sf_rc $(head -3 "$SFW/a2.txt")"
sf_ctl '{"offline": false}'
# (b) a crash after the push landed and before the base was updated (the answer lost): the next command resends the
# same batch_id first, sikstack answers it once (a replay), and base.json, sikstack and the disk agree.
sf_ctl '{"commit": "drop-after"}'; sf_v=$(sf_revs revisions); sf_m=$(sf_mark)
sf agenda-add --title lost --author person:smoke > "$SFW/b.txt"; sf_rc=$?
sf_r=$(sf_check "$sf_m" lost "$sf_v"); sf_bid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["batches"][0])' "$SF/.sikstack/.hi2vi/journal.json" 2>/dev/null)
sf_v=$(sf_revs revisions); sf_m=$(sf_mark); sf next > "$SFW/b2.txt"; sf_rc2=$?; sf_r2=$(sf_check "$sf_m" resent "$sf_bid" "$sf_v" replay)
[ "$sf_rc" = 1 ] && tail -1 "$SFW/b.txt" | grep -q '^this change is on disk but not in sikstack (sikstack unreachable: .*): run sync$' \
  && [ "$sf_r" = ok ] && [ "$sf_rc2" = 0 ] && [ "$sf_r2" = ok ] \
  && ok "a lost commit answer: the command exits 1 (on disk but not in sikstack), the journal names the batch, the next command resends the same batch_id, sikstack replays it (the revisions land once) and the base catches up" \
  || bad "the lost-answer row wrong -- rc=$sf_rc/$sf_rc2 $sf_r / $sf_r2 / $(tail -1 "$SFW/b.txt")"
# (c) a crash before the push landed (the batch never applied): the next command sends it, and it lands now.
sf_ctl '{"commit": "drop-before"}'; sf_v=$(sf_revs revisions); sf_m=$(sf_mark)
sf agenda-add --title unsent --author person:smoke > "$SFW/c.txt"; sf_rc=$?
sf_r=$(sf_check "$sf_m" unsent "$sf_v"); sf_bid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["batches"][0])' "$SF/.sikstack/.hi2vi/journal.json" 2>/dev/null)
sf_m=$(sf_mark); sf next > "$SFW/c2.txt"; sf_rc2=$?; sf_r2=$(sf_check "$sf_m" resent "$sf_bid" "$sf_v" first)
[ "$sf_rc" = 1 ] && [ "$sf_r" = ok ] && [ "$sf_rc2" = 0 ] && [ "$sf_r2" = ok ] \
  && ok "a batch that never landed: the journal keeps it, the next command sends that batch_id and it lands once" \
  || bad "the unsent row wrong -- rc=$sf_rc/$sf_rc2 $sf_r / $sf_r2"
# (d) a crash during the command (a hard exit, then a raise): the journal stays running, and the next command refuses
# with one line naming sync and changes nothing. (sync is the way out; here the journal is removed by hand instead.)
sf_m=$(sf_mark); sf_crash kill agenda-add --title killed --author person:smoke; sf_rc=$?
sf_r=$(sf_check "$sf_m" interrupted -)
sf_t1=$(sf_tree); sf next > "$SFW/d.txt"; sf_rc2=$?; sf_t2=$(sf_tree)
[ "$sf_rc" = 9 ] && [ "$sf_r" = ok ] && [ "$sf_rc2" = 1 ] && [ "$(grep -c '' "$SFW/d.txt")" = 1 ] && [ "$sf_t1" = "$sf_t2" ] \
  && grep -qE '^the last command here \(agenda-add --title killed .*\) stopped before it finished: [0-9]+ file\(s\) changed by it are on disk but not in sikstack \(interrupted\): run sync to see them \(nothing was changed\)$' "$SFW/d.txt" \
  && ok "a command killed midway leaves the journal running; the next command is refused with one line naming sync, and the tree is unchanged" \
  || bad "the interrupted row (kill) wrong -- rc=$sf_rc/$sf_rc2 $sf_r / $(head -2 "$SFW/d.txt")"
rm -f "$SF/.sikstack/.hi2vi/journal.json"; sf next >/dev/null
sf_m=$(sf_mark); sf_crash raise agenda-add --title raised --author person:smoke; sf_rc=$?
sf_r=$(sf_check "$sf_m" interrupted RuntimeError); sf next > "$SFW/d2.txt"; sf_rc2=$?
[ "$sf_rc" = 1 ] && [ "$sf_r" = ok ] && [ "$sf_rc2" = 1 ] && grep -qF 'stopped before it finished, RuntimeError: ' "$SFW/d2.txt" \
  && ok "a command that raises (not a refusal) sends nothing, its journal names the crash, and the next command refuses naming it and sync" \
  || bad "the interrupted row (raise) wrong -- rc=$sf_rc/$sf_rc2 $sf_r / $(head -2 "$SFW/d2.txt")"
rm -f "$SF/.sikstack/.hi2vi/journal.json"; sf next >/dev/null
# The crash table's last row: killed during a pull, after the file was written and before base.json was. The disk's
# sha equals sikstack's, which reads as the same: the next command is not refused and the base is fixed.
printf 'renamed in sikstack\n' > "$SFW/pulled.md"; sf_put works/phases/active/P1/intent.md "$SFW/pulled.md"
sf_crash pull next; sf_rc=$?
cmp -s "$SFW/pulled.md" "$SF/.sikstack/works/phases/active/P1/intent.md"; sf_w=$?
sf_m=$(sf_mark); sf next > "$SFW/d3.txt"; sf_rc2=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 9 ] && [ "$sf_w" = 0 ] && [ "$sf_rc2" = 0 ] && [ "$sf_r" = ok ] \
  && ok "a pull killed after its write and before base.json: the next command reads the file as the same (no mismatch) and the base catches up" \
  || bad "the pull-crash row wrong -- rc=$sf_rc/$sf_rc2 written=$sf_w $sf_r / $(tail -1 "$SFW/d3.txt")"
# The crash table's append rows. The event log is cold (0.4.0): a pull never writes another checkout's lines here
# (sikstack keeps them), and once a push lands the log's sent lines leave the disk, so the file holds only the lines
# not yet sent. Killed at any step, the next command sends only this checkout's own lines: sikstack holds each once.
# sf_kill fetch|write|wrote|base <path> <args>: the command, killed (os._exit) once a fetch has returned <path>, just
# before or just after <path> is written (the eviction's rewrite of the log), or once the generated files are rebuilt
# after a pull.
sf_kill() { _s=$1; _f=$2; shift 2; ( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - "$_s" "$_f" "$@" <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
cloud = sys.modules["wf_cloud"]  # the cloud part the engine imported
step, target = sys.argv[1], sys.argv[2]
real_write, real_fetch = cloud._cloud_write_bytes, cloud.CloudSession.fetch
def write(path, data):
    hit = str(path).endswith("/" + target)
    if hit and step == "write":
        os._exit(9)
    real_write(path, data)
    if hit and step == "wrote":
        os._exit(9)
def fetch(self, paths):
    got = real_fetch(self, paths)
    if step == "fetch" and target in got:
        os._exit(9)
    return got
cloud._cloud_write_bytes, cloud.CloudSession.fetch = write, fetch
if step == "base":
    cloud.cloud_rebuild = lambda rels: os._exit(9)
sys.exit(mod.main(sys.argv[3:]))
PY
) >> "$SF_OUT" 2>&1; }
# sf_add <path> <line>...: another checkout appends these lines to <path> in sikstack.
sf_add() { python3 - "$SFS" "$@" <<'PY' || bad "cloud safety probe: the fake append failed"
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/write", json.dumps({"path": sys.argv[2], "lines": sys.argv[3:]}), {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
sf_ev=works/events.jsonl
# Another checkout's line and a local one: the pull records the log's rev and fetches nothing of it; only the local
# line is sent, and the disk's log is empty after the push.
printf '{"type": "smoke_local", "mark": "local-pull"}\n' >> "$SF/.sikstack/$sf_ev"
sf_add "$sf_ev" '{"type": "agenda_added", "agenda": "cloud-pull"}'
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" once "$sf_ev" '"local-pull"' '"cloud-pull"')
sf_f=$(sf_check "$sf_m" nofetch "$sf_ev")
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] && [ "$sf_f" = ok ] \
  && ok "a pull never takes another checkout's event lines (the log's rev recorded, nothing fetched or written): the local line is sent once, sikstack holds each line once, and the disk's log is empty after" \
  || bad "an append pull wrote sikstack's lines here or sent them back -- rc=$sf_rc $sf_r / $sf_f"
# Killed when the push has landed and the eviction is about to rewrite the log to its unsent tail (write), or has
# rewritten it but not yet base.json (wrote); then, from that second state, killed again once the next command's
# settle has fetched sikstack's copy (fetch). The next command sends only what sikstack lacks.
sf_bad=""
for sf_step in write wrote fetch; do
  printf '{"type": "smoke_local", "mark": "local-%s"}\n' "$sf_step" >> "$SF/.sikstack/$sf_ev"
  sf_add "$sf_ev" "{\"type\": \"agenda_added\", \"agenda\": \"cloud-$sf_step\"}"
  if [ "$sf_step" = fetch ]; then sf_kill wrote "$sf_ev" next; printf '{"type": "smoke_local", "mark": "local-fetch2"}\n' >> "$SF/.sikstack/$sf_ev"; fi
  sf_kill "$sf_step" "$sf_ev" next; sf_rc=$?
  sf_m=$(sf_mark); sf next >/dev/null; sf_rc2=$?; sf_r=$(sf_check "$sf_m" once "$sf_ev" "\"local-$sf_step\"" "\"cloud-$sf_step\"")
  [ "$sf_step" = fetch ] && [ "$sf_r" = ok ] && sf_r=$(sf_check "$sf_m" once "$sf_ev" '"local-fetch2"')
  { [ "$sf_rc" = 9 ] && [ "$sf_rc2" = 0 ] && [ "$sf_r" = ok ]; } || sf_bad="$sf_bad [$sf_step: rc=$sf_rc/$sf_rc2 $sf_r]"
done
[ -z "$sf_bad" ] \
  && ok "the event log's eviction killed before its rewrite or after it (before base.json), and the settle after that killed once it fetched sikstack's copy: the next command sends only the lines sikstack lacks, sikstack holds each line once, and the disk's log is empty" \
  || bad "an eviction or pull killed midway lost or re-sent an event line --$sf_bad"
# sync --keep cloud brings sikstack's whole log here; the next command takes its lines off the disk again.
sf sync --keep cloud "$sf_ev" >/dev/null; [ -s "$SF/.sikstack/$sf_ev" ]; sf_full=$?
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_full" = 0 ] && [ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] \
  || bad "the event log did not come back and leave again around sync --keep cloud -- full=$sf_full rc=$sf_rc $sf_r"
# (e) a stale write: another checkout changes the same file between this command's begin and its commit. sikstack refuses
# the whole batch (409), the disk keeps this checkout's change, exit 1 though next succeeded; then the begin step's
# mismatch refuses with nothing changed, until the two sides agree.
sf_p=works/phases/active/P1/intent.md; printf 'changed here\n' >> "$SF/.sikstack/$sf_p"
sf_ctl "{\"race\": {\"path\": \"$sf_p\", \"content\": \"changed in sikstack by another checkout\\n\"}}"
sf_v=$(sf_revs revisions); sf_h=$(sf_revs head); sf_m=$(sf_mark)
sf next > "$SFW/e.txt"; sf_rc=$?; sf_r=$(sf_check "$sf_m" stale "$sf_p" "$sf_v" "$sf_h" "changed in sikstack by another checkout
")
[ "$sf_rc" = 1 ] && [ "$(tail -1 "$SFW/e.txt")" = "this change is on disk but not in sikstack (1 conflict(s)): run sync" ] && [ "$sf_r" = ok ] \
  && ok "a stale write is refused: 409, nothing of the batch written in sikstack, the disk keeps the change, base.json still names it, no journal left, and exit 1 though next itself succeeded" \
  || bad "the stale write wrong -- rc=$sf_rc $sf_r / $(tail -1 "$SFW/e.txt")"
sf_t1=$(sf_tree); sf next > "$SFW/e2.txt"; sf_rc=$?; sf_t2=$(sf_tree)
[ "$sf_rc" = 1 ] && [ "$(cat "$SFW/e2.txt")" = "1 files differ between this checkout and sikstack: run sync to see them (nothing was changed)" ] && [ "$sf_t1" = "$sf_t2" ] \
  && ok "then the begin step's mismatch: the next command is refused with one line naming sync, and the tree is unchanged" \
  || bad "the mismatch refusal wrong -- rc=$sf_rc $(head -2 "$SFW/e2.txt")"
sf_put "$sf_p" "$SF/.sikstack/$sf_p"
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] || bad "equal content on both sides did not clear the mismatch -- rc=$sf_rc $sf_r"
# (f) two engine processes in one checkout at once. The fake holds the first two head requests until both arrive (or
# 3 s pass), so without the lock both would begin at the same head and base and race (a double push of the event
# lines, a lost base). The lock serializes them: each batch lands once and base.json, sikstack and the disk agree.
sf_ctl '{"gate": {"route": "head", "count": 2, "timeout": 3}}'; sf_m=$(sf_mark)
sf agenda-add --title one --author person:smoke > "$SFW/f1.txt" & sf_p1=$!
sf agenda-add --title two --author person:smoke > "$SFW/f2.txt" & sf_p2=$!
wait "$sf_p1"; sf_rc=$?; wait "$sf_p2"; sf_rc2=$?
sf_ctl '{"gate": null}'; sf_r=$(sf_check "$sf_m" serialized)
[ "$sf_rc" = 0 ] && [ "$sf_rc2" = 0 ] && [ "$sf_r" = ok ] \
  && ok "two agenda-add processes at once in one checkout are serialized by .hi2vi/lock: two batches, none resent, both items in sikstack, and the event log, every rev and base.json's head agree" \
  || bad "two engine processes were not serialized -- rc=$sf_rc/$sf_rc2 $sf_r / $(tail -1 "$SFW/f1.txt") / $(tail -1 "$SFW/f2.txt")"
# compact-resume while another process holds the lock: it waits a bounded time, then fails open with the line as a note.
python3 -c 'import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT); fcntl.flock(fd, fcntl.LOCK_EX); open(sys.argv[2], "w").close(); time.sleep(20)' \
  "$SF/.sikstack/.hi2vi/lock" "$SFW/held" & sf_hp=$!
for _ in $(seq 1 100); do [ -e "$SFW/held" ] && break; sleep 0.1; done
sf_s=$(date +%s); echo '{}' | sf compact-resume > "$SFW/f3.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s ))
kill "$sf_hp" 2>/dev/null; wait "$sf_hp" 2>/dev/null
[ "$sf_rc" = 0 ] && [ "$sf_s" -lt 15 ] && grep -q '^compaction=done' "$SFW/f3.txt" && grep -qF "note: another engine command has held this checkout's lock" "$SFW/f3.txt" \
  && ok "compact-resume with the lock held elsewhere waits a bounded time (${sf_s}s), then fails open: exit 0, the card, the lock line as a note" \
  || bad "compact-resume did not fail open on a held lock -- rc=$sf_rc ${sf_s}s $(head -3 "$SFW/f3.txt")"
# (g) a change over the server's limit goes as several batches in order, each under 8,000,000 B as sent with its own
# batch_id; one file too big for any batch is refused before anything is sent.
mkdir -p "$SF/.sikstack/works/phases/active/P1/topics"
for i in 1 2 3; do python3 -c 'import sys; open(sys.argv[1], "w").write(("line of a big topic %s\n" % sys.argv[2]) * 140000)' \
  "$SF/.sikstack/works/phases/active/P1/topics/big-$i.md" "$i"; done
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" split 3)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] \
  && ok "a 9 MB change goes as several batches in order, each under 8,000,000 B as sent with its own batch_id, and all of it lands" \
  || bad "the big change was not split -- rc=$sf_rc $sf_r"
python3 -c 'import sys; open(sys.argv[1], "w").write("x" * 8100000)' "$SF/.sikstack/works/phases/active/P1/topics/huge.md"
sf_m=$(sf_mark); sf next > "$SFW/g.txt"; sf_rc=$?; sf_r=$(sf_check "$sf_m" toobig)
[ "$sf_rc" = 1 ] && [ "$sf_r" = ok ] && tail -1 "$SFW/g.txt" | grep -qE "^works/phases/active/P1/topics/huge\.md is [0-9,]+ bytes as sent, over sikstack's 8,000,000-byte batch limit: it is on disk but not in sikstack" \
  && ok "one file too big for any batch is refused with one line naming it, exit 1, nothing sent" \
  || bad "the too-big file was not refused -- rc=$sf_rc $sf_r / $(tail -1 "$SFW/g.txt")"
rm -f "$SF/.sikstack/works/phases/active/P1/topics/huge.md"
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] || bad "the checkout did not settle after the too-big file left -- rc=$sf_rc $sf_r"
# (i) every failure inside the boundary ends in one line, never a traceback: a cut or malformed answer (http.client's
# IncompleteRead, BadStatusLine, LineTooLong) refuses the command with P8's line and the tree unchanged, and the
# session hook still prints its card with the line as a note.
sf_no_tb() { ! grep -q '^Traceback' "$1"; }
for sf_how in truncate:IncompleteRead status:BadStatusLine longline:LineTooLong; do
  sf_ctl "{\"break\": {\"route\": \"head\", \"how\": \"${sf_how%%:*}\"}}"
  sf_t1=$(sf_tree); sf next > "$SFW/i.txt"; sf_rc=$?; sf_t2=$(sf_tree)
  echo '{}' | sf compact-resume > "$SFW/i2.txt"; sf_rc2=$?
  sf_ctl '{"break": null}'
  [ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/i.txt")" = 1 ] && [ "$sf_t1" = "$sf_t2" ] \
    && grep -qE "^sikstack is not reachable at http://127\.0\.0\.1:[0-9]+ \(${sf_how#*:}.*\): in cloud mode nothing runs offline, and nothing was changed\.$" "$SFW/i.txt" \
    && [ "$sf_rc2" = 0 ] && grep -q '^compaction=done' "$SFW/i2.txt" && grep -qE "^note: sikstack is not reachable at .*\(${sf_how#*:}" "$SFW/i2.txt" && sf_no_tb "$SFW/i2.txt" \
    && ok "an answer cut or malformed at the begin step (${sf_how#*:}): the command is refused with P8's one line and the tree unchanged, and compact-resume prints its card with the line as a note, exit 0" \
    || bad "a ${sf_how#*:} at the begin step was not one line -- rc=$sf_rc/$sf_rc2 $(head -2 "$SFW/i.txt") / $(tail -2 "$SFW/i2.txt")"
done
# The answers that were already one line stay so: a proxy's 502 in front of a stopped API, a body that is not JSON.
sf_bad=""
for sf_how in "bad-gateway:^sikstack is not reachable at .* \(HTTP 502 on head\): in cloud mode nothing runs offline, and nothing was changed\.$" \
              "garbage:^sikstack answered for project None, not proj-1: this checkout's link is broken, and nothing was changed$"; do
  sf_ctl "{\"break\": {\"route\": \"head\", \"how\": \"${sf_how%%:*}\"}}"
  sf next > "$SFW/i0.txt"; sf_rc=$?; sf_ctl '{"break": null}'
  { [ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/i0.txt")" = 1 ] && grep -qE "${sf_how#*:}" "$SFW/i0.txt"; } || sf_bad="$sf_bad [${sf_how%%:*}: rc=$sf_rc $(head -1 "$SFW/i0.txt")]"
done
[ -z "$sf_bad" ] && ok "a 502 from a proxy and a body that is not JSON still end in their one line, exit 1" || bad "a 502 or a non-JSON answer --$sf_bad"
# A commit answer cut mid-body is a lost answer: one line, the journal keeps the batch, the next command resends it.
sf_ctl '{"break": {"route": "commit", "how": "truncate"}}'
sf agenda-add --title cut --author person:smoke > "$SFW/i3.txt"; sf_rc=$?
sf_ctl '{"break": null}'; sf_m=$(sf_mark); sf next >/dev/null; sf_rc2=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 1 ] && sf_no_tb "$SFW/i3.txt" && [ "$(tail -1 "$SFW/i3.txt")" != "" ] \
  && tail -1 "$SFW/i3.txt" | grep -q '^this change is on disk but not in sikstack (sikstack unreachable: IncompleteRead(.*)): run sync$' \
  && [ "$sf_rc2" = 0 ] && [ "$sf_r" = ok ] \
  && ok "a commit answer cut mid-body: the command exits 1 with the one on-disk line, and the next command resends the batch and settles" \
  || bad "a cut commit answer wrong -- rc=$sf_rc/$sf_rc2 $sf_r / $(tail -2 "$SFW/i3.txt")"
# A fetch whose base64 does not decode stops the pull before anything is written.
printf 'pulled as base64\n' > "$SFW/b64.md"; sf_put works/phases/active/P1/topics/b64.md "$SFW/b64.md"
sf_ctl '{"break": {"route": "fetch", "how": "badbase64"}}'
sf_t1=$(sf_tree); sf next > "$SFW/i4.txt"; sf_rc=$?; sf_t2=$(sf_tree)
echo '{}' | sf compact-resume > "$SFW/i5.txt"; sf_rc2=$?
sf_ctl '{"break": null}'; sf_m=$(sf_mark); sf next >/dev/null; sf_rc3=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/i4.txt")" = 1 ] && [ "$sf_t1" = "$sf_t2" ] \
  && grep -qE '^sikstack is not reachable at .* \(a fetched file did not decode as base64: works/phases/active/P1/topics/b64\.md\): in cloud mode nothing runs offline, and nothing was changed\.$' "$SFW/i4.txt" \
  && [ "$sf_rc2" = 0 ] && grep -q '^compaction=done' "$SFW/i5.txt" && grep -q '^note: sikstack is not reachable at .*did not decode as base64' "$SFW/i5.txt" \
  && [ "$sf_rc3" = 0 ] && [ "$sf_r" = ok ] \
  && ok "a fetch whose base64 does not decode: one line naming the file, nothing written, the hook's note; the next good answer pulls it" \
  || bad "bad base64 in a fetch wrong -- rc=$sf_rc/$sf_rc2/$sf_rc3 $sf_r / $(head -2 "$SFW/i4.txt") / $(tail -1 "$SFW/i5.txt")"
# A write error during the pull (a file stands where sikstack's folder goes): one line naming the path; the file pulled
# before it is on disk and recorded in base.json with the head kept, and once the way is clear the pull resumes.
printf 'pulled first\n' > "$SFW/pa.md"; printf 'pulled second\n' > "$SFW/pb.md"
sf_put works/phases/active/P1/topics/a-first.md "$SFW/pa.md"; sf_put works/phases/active/P1/topics/blocked/b.md "$SFW/pb.md"
printf 'in the way\n' > "$SF/.sikstack/works/phases/active/P1/topics/blocked"
sf_h0=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["head"])' "$SF/.sikstack/.hi2vi/base.json")
sf next > "$SFW/i6.txt"; sf_rc=$?
sf_rec=$(python3 - "$SF/.sikstack" "$sf_h0" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, h0 = Path(sys.argv[1]), int(sys.argv[2])
base = json.loads((root / ".hi2vi/base.json").read_text())
a = "works/phases/active/P1/topics/a-first.md"
ok = (base["head"] == h0 and base["files"].get(a, {}).get("sha256") == hashlib.sha256((root / a).read_bytes()).hexdigest()
      and "works/phases/active/P1/topics/blocked/b.md" not in base["files"] and not (root / ".hi2vi/journal.json").exists())
print("ok" if ok else f"base {base['head']} vs {h0}: {base['files'].get(a)}")
PY
)
echo '{}' | sf compact-resume > "$SFW/i7.txt"; sf_rc2=$?
rm -f "$SF/.sikstack/works/phases/active/P1/topics/blocked"; sf_m=$(sf_mark); sf next >/dev/null; sf_rc3=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/i6.txt")" = 1 ] && [ "$sf_rec" = ok ] \
  && grep -qE '^works/phases/active/P1/topics/blocked/b\.md could not be written here from sikstack \([A-Za-z]+Error: .*\): 1 pulled path\(s\) landed before it and are recorded in \.hi2vi/base\.json; fix it, then run the command again \(the pull resumes from there\)$' "$SFW/i6.txt" \
  && [ "$sf_rc2" = 0 ] && grep -q '^compaction=done' "$SFW/i7.txt" && grep -q '^note: works/phases/active/P1/topics/blocked/b\.md could not be written' "$SFW/i7.txt" \
  && [ "$sf_rc3" = 0 ] && [ "$sf_r" = ok ] \
  && ok "a write error during a pull: one line naming the path, what landed before it recorded in base.json (the head kept, no journal), the hook's note; then the pull resumes and settles" \
  || bad "a write error during a pull wrong -- rc=$sf_rc/$sf_rc2/$sf_rc3 $sf_rec $sf_r / $(head -2 "$SFW/i6.txt") / $(tail -1 "$SFW/i7.txt")"
# The session hook's budget: a slow but answering server (5 s per answer, a pull waiting: head, manifest and fetch
# would take 15 s), then one that sends a byte a second (no socket read ever times out). compact-resume stays inside
# the hook's 15 s timeout (its cloud time is held to 9 s) and prints its card with the line as a note.
printf 'pulled slowly\n' > "$SFW/slow.md"; sf_put works/phases/active/P1/topics/slow.md "$SFW/slow.md"
for sf_sw in "slow:5:answers each request 5 s late" "drip:1:sends its answers a byte a second"; do
  sf_k=${sf_sw%%:*}; sf_n=${sf_sw#*:}; sf_lbl=${sf_n#*:}; sf_n=${sf_n%%:*}
  sf_ctl "{\"$sf_k\": $sf_n}"
  sf_s=$(date +%s); echo '{}' | sf compact-resume > "$SFW/i8.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s ))
  sf_ctl "{\"$sf_k\": 0}"
  [ "$sf_rc" = 0 ] && [ "$sf_s" -lt 15 ] && grep -q '^compaction=done' "$SFW/i8.txt" && grep -qF "note: sikstack is not reachable at $SFS (the session hook's 9 s for sikstack ran out)" "$SFW/i8.txt" \
    && ok "compact-resume on a server that $sf_lbl ends in ${sf_s}s, inside the hook's 15 s: exit 0, the card, the budget's line as a note" \
    || bad "compact-resume on a server that $sf_lbl -- rc=$sf_rc ${sf_s}s $(tail -2 "$SFW/i8.txt")"
done
sleep 2; sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] || bad "the checkout did not settle after the slow server -- rc=$sf_rc $sf_r"
# A request fails when it stalls, never while its bytes still move. On a steady slow link (the fake reads and sends at
# 48,000 B/s) a 624 KB file takes about 13 s to pull and as long to push: a limit on the whole request would refuse
# each. The session hook still stops at its 9 s with the note; an ordinary command pulls and pushes it whole, and a
# batch left `pushing` is resent at the begin step over the same link.
sf_big() { python3 -c 'import sys; open(sys.argv[1], "w").write((sys.argv[2] + " of a slow transfer\n") * 24000)' "$1" "$2"; }
sf_big "$SFW/slowpull.md" pulled; sf_put works/phases/active/P1/topics/slow-pull.md "$SFW/slowpull.md"
sf_ctl '{"rate": 48000}'
sf_s=$(date +%s); echo '{}' | sf compact-resume > "$SFW/s1.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s ))
[ "$sf_rc" = 0 ] && [ "$sf_s" -lt 15 ] && grep -q '^compaction=done' "$SFW/s1.txt" && grep -qF "note: sikstack is not reachable at $SFS (the session hook's 9 s for sikstack ran out)" "$SFW/s1.txt" \
  && ok "compact-resume with a 624 KB pull waiting on a slow link ends in ${sf_s}s, inside the hook's 15 s: exit 0, the card, the budget's line as a note" \
  || bad "compact-resume on a slow link -- rc=$sf_rc ${sf_s}s $(tail -2 "$SFW/s1.txt")"
sf_s=$(date +%s); sf_m=$(sf_mark); sf next > "$SFW/s2.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s )); sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_s" -gt 10 ] && [ "$sf_r" = ok ] && sf_no_tb "$SFW/s2.txt" \
  && ok "a slow but moving pull finishes: a 624 KB file at 48,000 B/s takes ${sf_s}s, over 10 s, and lands whole (exit 0, base, sikstack and the disk agree)" \
  || bad "a slow but moving pull was refused -- rc=$sf_rc ${sf_s}s $sf_r / $(grep -m1 'sikstack' "$SFW/s2.txt")"
sf_big "$SF/.sikstack/works/phases/active/P1/topics/slow-push.md" pushed
sf_s=$(date +%s); sf_m=$(sf_mark); sf next > "$SFW/s3.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s )); sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_s" -gt 10 ] && [ "$sf_r" = ok ] && sf_no_tb "$SFW/s3.txt" \
  && ok "a slow but moving push finishes: a 624 KB change at 48,000 B/s takes ${sf_s}s, over 10 s, and lands once" \
  || bad "a slow but moving push was refused -- rc=$sf_rc ${sf_s}s $sf_r / $(tail -1 "$SFW/s3.txt")"
sf_ctl '{"rate": 0, "commit": "drop-before"}'; sf_big "$SF/.sikstack/works/phases/active/P1/topics/slow-resend.md" resent
sf_v=$(sf_revs revisions); sf_m=$(sf_mark); sf next > "$SFW/s4.txt"; sf_rc=$?; sf_r=$(sf_check "$sf_m" unsent "$sf_v")
sf_bid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["batches"][0])' "$SF/.sikstack/.hi2vi/journal.json" 2>/dev/null)
sf_ctl '{"rate": 48000}'
sf_s=$(date +%s); sf_m=$(sf_mark); sf next > "$SFW/s5.txt"; sf_rc2=$?; sf_s=$(( $(date +%s) - sf_s )); sf_r2=$(sf_check "$sf_m" resent "$sf_bid" "$sf_v" first)
sf_ctl '{"rate": 0}'
[ "$sf_rc" = 1 ] && [ "$sf_r" = ok ] && [ "$sf_rc2" = 0 ] && [ "$sf_s" -gt 10 ] && [ "$sf_r2" = ok ] \
  && ok "a pushing batch resent at the begin step over a slow link (${sf_s}s, over 10 s) lands once" \
  || bad "a slow resend of a pushing batch -- rc=$sf_rc/$sf_rc2 ${sf_s}s $sf_r / $sf_r2 / $(tail -1 "$SFW/s5.txt")"
# A stalled server and a dripping one still end an ordinary command in one line, in bounded time: no byte for 10 s, or
# fewer than 1024 bytes in a 10 s window (a byte a second).
sf_bad=""
for sf_sw in "slow:12:no byte moved for 10 s" "drip:1:fewer than 1024 bytes moved in 10 s"; do
  sf_k=${sf_sw%%:*}; sf_n=${sf_sw#*:}; sf_why=${sf_n#*:}; sf_n=${sf_n%%:*}
  sf_ctl "{\"$sf_k\": $sf_n}"
  sf_t1=$(sf_tree); sf_s=$(date +%s); sf next > "$SFW/s6.txt"; sf_rc=$?; sf_s=$(( $(date +%s) - sf_s )); sf_t2=$(sf_tree)
  sf_ctl "{\"$sf_k\": 0}"
  { [ "$sf_rc" = 1 ] && [ "$sf_s" -le 22 ] && [ "$sf_t1" = "$sf_t2" ] && [ "$(grep -c '' "$SFW/s6.txt")" = 1 ] \
    && grep -qF "sikstack is not reachable at $SFS ($sf_why): in cloud mode nothing runs offline, and nothing was changed." "$SFW/s6.txt"; } \
    || sf_bad="$sf_bad [$sf_k: rc=$sf_rc ${sf_s}s $(head -1 "$SFW/s6.txt")]"
done
[ -z "$sf_bad" ] && ok "a server that stalls (no byte for 10 s) or drips (a byte a second) ends an ordinary command in one line within 22 s, the tree unchanged" \
  || bad "a stalled or dripping server --$sf_bad"
sleep 2
# A 409 whose body stalls is no answer: it never reads as a batch with no conflicts. The journal keeps the batch; the
# next command resends it and meets sikstack's whole 409 (1 conflict), then the mismatch waits for sync.
sf_p=works/phases/active/P1/topics/slow-pull.md; printf 'changed here\n' >> "$SF/.sikstack/$sf_p"
sf_ctl "{\"race\": {\"path\": \"$sf_p\", \"content\": \"changed in sikstack by another checkout\\n\"}, \"break\": {\"route\": \"commit\", \"how\": \"hold\"}}"
sf next > "$SFW/s7.txt"; sf_rc=$?; sf_ctl '{"break": null}'
sf_j=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("state"))' "$SF/.sikstack/.hi2vi/journal.json" 2>/dev/null)
sf next > "$SFW/s8.txt"; sf_rc2=$?
[ "$sf_rc" = 1 ] && [ "$(tail -1 "$SFW/s7.txt")" = "this change is on disk but not in sikstack (sikstack unreachable: no byte moved for 10 s): run sync" ] \
  && [ "$sf_j" = pushing ] && [ "$sf_rc2" = 1 ] && grep -qF "(1 conflict(s)): run sync" "$SFW/s8.txt" && sf_no_tb "$SFW/s8.txt" \
  && ok "a 409 whose body stalls is one line and keeps the batch (never 0 conflicts); the resend meets sikstack's whole 409 with its conflict" \
  || bad "a 409 with a stalled body -- rc=$sf_rc/$sf_rc2 journal=$sf_j $(tail -1 "$SFW/s7.txt") / $(tail -1 "$SFW/s8.txt")"
sf_put "$sf_p" "$SF/.sikstack/$sf_p"
sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] || bad "the checkout did not settle after the stalled 409 -- rc=$sf_rc $sf_r"
# No timer can turn a whole answer into an unreachable one: with the limit at 1 s and 1.5 s spent after the answer is
# read (where a wall-clock alarm would land), the request still returns sikstack's answer.
sf_late=$( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - <<'PY' 2>&1
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
cloud = sys.modules["wf_cloud"]  # the cloud part the engine imported
cloud.CLOUD_TIMEOUT = 1
real = cloud.CloudLink._exchange
def late(self, *a, **k):
    answer = real(self, *a, **k)
    time.sleep(1.5)
    return answer
cloud.CloudLink._exchange = late
try:
    status, payload = cloud.CloudLink().call("GET", "head")
    print(f"answer {status} {isinstance(payload.get('head'), int)}")
except Exception as exc:
    print(f"{exc.__class__.__name__}: {exc}")
PY
)
[ "$sf_late" = "answer 200 True" ] && ok "an answer already read is never turned into unreachable by a late timer" || bad "a late timer turned a whole answer into a failure -- $sf_late"
# The connection's set-up is judged too. Behind an HTTPS proxy that answers its CONNECT 6 s late and then forwards
# nothing, or drips its CONNECT answer a byte every 2 s, the session hook still ends inside its 9 s with the note and an
# ordinary command in one line in about 10 s (the connect is one wait the idle limit bounds; then the floor judges each
# step of the tunnel and the TLS handshake, its window counted from the request's start and only the peer's bytes counted
# in it). The checkout points at an
# https sikstack only the proxy could reach (never resolved here: urllib hands the name to the proxy); each command is
# cut at 40 s by pid, so a hang fails the row, not the suite.
cat > "$SFW/proxy.py" <<'PY'
import os, socket, sys, threading, time
port_file, mode = sys.argv[1], sys.argv[2]
def serve(c):
    try:
        c.recv(4096)
        if mode == "late":
            time.sleep(6)
            c.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            while c.recv(4096):
                pass
        else:
            c.sendall(b"HTTP/1.1 200 Connection established\r\n")
            while True:
                for b in b"X-Wait: y\r\n":
                    c.sendall(bytes([b]))
                    time.sleep(2)
    except OSError:
        pass
    finally:
        c.close()
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0))
s.listen(8)
with open(port_file + ".tmp", "w") as f:
    f.write(str(s.getsockname()[1]))
os.replace(port_file + ".tmp", port_file)
threading.Timer(300, lambda: os._exit(0)).start()
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
PY
# sf_capped <out> <proxy> <args>: one engine command behind HTTPS_PROXY, cut at 40 s; prints "<rc|killed> <seconds>".
sf_capped() { _out=$1; _px=$2; shift 2; ( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - "$_out" "$_px" "$@" <<'PY'
import os, subprocess, sys, time
out, proxy, args = sys.argv[1], sys.argv[2], sys.argv[3:]
env = dict(os.environ, HTTPS_PROXY=proxy, https_proxy=proxy)
for k in ("NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"):
    env.pop(k, None)
t = time.monotonic()
entry = __import__("os").environ["ADP"] if args[:1] == ["compact-resume"] else __import__("os").environ["ENG"]
p = subprocess.Popen([sys.executable, entry] + args, env=env, stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    data, _ = p.communicate(b"{}" if args[:1] == ["compact-resume"] else b"", timeout=40)
    rc = p.returncode
except subprocess.TimeoutExpired:
    p.kill()
    data, _ = p.communicate()
    rc = "killed"
open(out, "wb").write(data)
print(f"{rc} {time.monotonic() - t:.0f}")
PY
); }
sf_px_pids=()
for sf_k in late drip; do
  python3 "$SFW/proxy.py" "$SFW/px-$sf_k" "$sf_k" > /dev/null 2>&1 & sf_px_pids+=($!)
done
for _ in $(seq 1 50); do [ -s "$SFW/px-late" ] && [ -s "$SFW/px-drip" ] && break; sleep 0.1; done
cp "$SF/.sikstack/config.toml" "$SFW/link.bak"; cp "$SFX/sikstack/workspace-keys.json" "$SFW/keys2.bak"
set_link "$SF/.sikstack" "https://sikstack.invalid"
python3 - "$SFX/sikstack/workspace-keys.json" "$SFS" <<'PY'
import json, sys
keys, old = sys.argv[1:]
k = json.load(open(keys)); k["https://sikstack.invalid"] = k[old]; json.dump(k, open(keys, "w"))
PY
sf_bad=""
for sf_k in late drip; do
  sf_px="http://127.0.0.1:$(cat "$SFW/px-$sf_k")"
  read -r sf_rc sf_s < <(sf_capped "$SFW/p-$sf_k-hook.txt" "$sf_px" compact-resume)
  { [ "$sf_rc" = 0 ] && [ "$sf_s" -le 11 ] && grep -q '^compaction=done' "$SFW/p-$sf_k-hook.txt" \
    && grep -qF "note: sikstack is not reachable at https://sikstack.invalid (the session hook's 9 s for sikstack ran out)" "$SFW/p-$sf_k-hook.txt"; } \
    || sf_bad="$sf_bad [$sf_k hook: rc=$sf_rc ${sf_s}s $(tail -1 "$SFW/p-$sf_k-hook.txt")]"
  sf_t1=$(sf_tree); read -r sf_rc sf_s < <(sf_capped "$SFW/p-$sf_k-next.txt" "$sf_px" next); sf_t2=$(sf_tree)
  { [ "$sf_rc" = 1 ] && [ "$sf_s" -le 12 ] && [ "$sf_t1" = "$sf_t2" ] && [ "$(grep -c '' "$SFW/p-$sf_k-next.txt")" = 1 ] \
    && grep -qF "sikstack is not reachable at https://sikstack.invalid (fewer than 1024 bytes moved in 10 s): in cloud mode nothing runs offline, and nothing was changed." "$SFW/p-$sf_k-next.txt"; } \
    || sf_bad="$sf_bad [$sf_k next: rc=$sf_rc ${sf_s}s $(head -1 "$SFW/p-$sf_k-next.txt")]"
done
kill "${sf_px_pids[@]}" 2>/dev/null; wait "${sf_px_pids[@]}" 2>/dev/null
cp "$SFW/link.bak" "$SF/.sikstack/config.toml"; cp "$SFW/keys2.bak" "$SFX/sikstack/workspace-keys.json"; chmod 600 "$SFX/sikstack/workspace-keys.json"
# The set-up floor counts only the peer's bytes, whatever this machine's TLS library sends (a ClientHello is about
# 200 B on LibreSSL, over 1,500 B on OpenSSL 3.5). In-process, the limit at 2 s: a peer answers 39 B at 1.2 s and then
# swallows a 2,000 B ClientHello; the floor ends the set-up at 2 s (counting our own bytes, the idle limit at 3.2 s).
sf_own=$( cd "$SF" && python3 - <<'PY' 2>&1
import importlib.util, socket, sys, threading, time
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec); sys.modules["workflow_engine"] = mod; spec.loader.exec_module(mod)
mod = sys.modules["wf_cloud"]  # the cloud part the engine imported: its names, and the limit it reads
mod.CLOUD_TIMEOUT = 2
a, b = socket.socketpair()
def peer():
    time.sleep(1.2); b.sendall(b"HTTP/1.1 200 Connection established\r\n"[:37] + b"\r\n")
    while b.recv(65536): pass
threading.Thread(target=peer, daemon=True).start()
s, t = mod._CloudSocket(a, mod._CloudWire()), time.monotonic()
try:
    s.recv_into(bytearray(64)); s.sendall(b"x" * 2000); s.recv_into(bytearray(64)); print("no stall")
except mod._CloudStall as exc:
    print(f"{exc} {'early' if time.monotonic() - t < 2.8 else 'late'}")
PY
)
[ "$sf_own" = "fewer than 1024 bytes moved in 2 s early" ] || sf_bad="$sf_bad [own set-up bytes: $sf_own]"
[ -z "$sf_bad" ] && ok "behind an HTTPS proxy that answers CONNECT 6 s late then forwards nothing, or drips it, compact-resume ends inside its 9 s with the note and next in one line within 12 s, the tree unchanged; the set-up's floor counts only the peer's bytes" \
  || bad "a late or dripping HTTPS proxy --$sf_bad"
# Over TLS a byte counts as it crosses the socket, never a whole record at a time; the handshake keeps the context's
# verification. In-process, with the idle limit scaled to 2 s: a local TLS server behind a 4,000 B/s link sends a
# 17,000-byte answer, its first record 16 KiB (4 s on that link); a quick answer verifies its certificate (made here
# by openssl) and hostname, and an untrusted one is refused.
if command -v openssl >/dev/null 2>&1 && openssl req -x509 -newkey rsa:2048 -nodes -keyout "$SFW/tls.key" -out "$SFW/tls.crt" -days 2 \
     -subj /CN=localhost -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" > "$SFW/openssl.txt" 2>&1; then
  sf_tls=$( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - "$SFW/tls.crt" "$SFW/tls.key" <<'PY' 2>&1
import importlib.util, json, socket, ssl, sys, threading, time
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
mod = sys.modules["wf_cloud"]  # the cloud part the engine imported: its names, and the limits it reads
mod.CLOUD_TIMEOUT, mod.CLOUD_FLOOR = 2, 1024
cert, key = sys.argv[1], sys.argv[2]
server_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
server_ctx.load_cert_chain(cert, key)
def listener():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    return s
def answer(c, body):
    c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
def tls_origin(s):  # head: a quick answer; big: 17,000 bytes in one write (records of 16 KiB)
    while True:
        c, _ = s.accept()
        try:
            c = server_ctx.wrap_socket(c, server_side=True)
            line = c.recv(65536).split(b"\r\n")[0]
            answer(c, json.dumps({"x": "y" * 17000} if b"/big" in line else {"head": 1}).encode())
        except (OSError, ssl.SSLError):
            pass
        finally:
            c.close()
def link(up_port, rate):  # a slow link: each direction forwarded at <rate> bytes a second
    s = listener()
    def pump(a, b):
        try:
            while True:
                d = a.recv(max(1, rate // 20))
                if not d:
                    break
                b.sendall(d)
                time.sleep(len(d) / rate)
        except OSError:
            pass
        for x in (a, b):
            try:
                x.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
    def run():
        while True:
            c, _ = s.accept()
            u = socket.create_connection(("127.0.0.1", up_port))
            threading.Thread(target=pump, args=(c, u), daemon=True).start()
            threading.Thread(target=pump, args=(u, c), daemon=True).start()
    threading.Thread(target=run, daemon=True).start()
    return s.getsockname()[1]
def call(port, route):
    link_ = mod.CloudLink({"server": f"https://localhost:{port}", "project_id": "proj-1"}, "k-tls")
    t = time.monotonic()
    try:
        status, payload = link_.call("GET", route)
        return f"{status} {len(payload.get('x', ''))} {time.monotonic() - t:.1f}s"
    except Exception as exc:  # noqa: BLE001
        return f"{exc.__class__.__name__}: {str(exc)[:90]} {time.monotonic() - t:.1f}s"
origin = listener()
threading.Thread(target=tls_origin, args=(origin,), daemon=True).start()
slow = link(origin.getsockname()[1], 4000)
trusted = lambda: ssl.create_default_context(cafile=cert)
ssl._create_default_https_context = ssl.create_default_context
print("untrusted:", call(origin.getsockname()[1], "head"))
ssl._create_default_https_context = trusted
print("quick:", call(origin.getsockname()[1], "head"))
print("record:", call(slow, "big"))
PY
)
  printf '%s\n' "$sf_tls" | grep -q '^untrusted: CloudUnreachable: .*CERTIFICATE_VERIFY_FAILED' \
    && printf '%s\n' "$sf_tls" | grep -qE '^quick: 200 0 ' \
    && printf '%s\n' "$sf_tls" | grep -qE '^record: 200 17000 ([3-9]|1[0-9])\.[0-9]s$' \
    && ok "over TLS the handshake verifies its certificate (an untrusted one refused) and a 16 KiB record crossing a slow link counts byte by byte: 17,000 B at 4,000 B/s finish with the idle limit at 2 s ($(printf '%s' "$sf_tls" | tr '\n' ' '))" \
    || bad "TLS waits -- $(printf '%s' "$sf_tls" | tr '\n' ' ')"
else
  echo "note: no openssl to make a test certificate: the TLS row is skipped ($(tail -1 "$SFW/openssl.txt" 2>/dev/null))"
fi
# Any other failure inside the begin or the commit step (simulated: the step raises a RuntimeError) is one line too:
# before the command, it did not run (the hook prints its card and the note); after it, the change is on disk only, the
# journal stays running and names the failure, and the next command refuses naming sync.
sf_boom() { _s=$1; shift; ( cd "$SF" && XDG_CONFIG_HOME="$SFX" python3 - "$_s" "$@" <<'PY'
import importlib.util, sys
entry = __import__("os").environ["ADP"] if sys.argv[2:3] == ["compact-resume"] else __import__("os").environ["ENG"]
spec = importlib.util.spec_from_file_location("workflow_entry", entry)
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_entry"] = mod
spec.loader.exec_module(mod)
def boom(self, *a, **k):
    raise RuntimeError("a failure inside the step")
setattr(sys.modules["wf_cloud"].CloudSession, sys.argv[1], boom)
sys.exit(mod.main(sys.argv[2:]))
PY
) 2>&1 | tee -a "$SF_OUT"; return "${PIPESTATUS[0]}"; }
sf_t1=$(sf_tree); sf_boom begin next > "$SFW/j.txt"; sf_rc=$?; sf_t2=$(sf_tree)
echo '{}' | sf_boom begin compact-resume > "$SFW/j2.txt"; sf_rc2=$?
sf_boom commit agenda-add --title boom --author person:smoke > "$SFW/j3.txt"; sf_rc3=$?
sf next > "$SFW/j4.txt"; sf_rc4=$?
[ "$sf_rc" = 1 ] && [ "$(cat "$SFW/j.txt")" = "the step before the command stopped (RuntimeError: a failure inside the step), so the command did not run: run sync to see this checkout against sikstack" ] \
  && [ "$sf_t1" = "$sf_t2" ] && [ "$sf_rc2" = 0 ] && grep -q '^compaction=done' "$SFW/j2.txt" && grep -q '^note: the step before the command stopped (RuntimeError' "$SFW/j2.txt" \
  && [ "$sf_rc3" = 1 ] && sf_no_tb "$SFW/j3.txt" && [ "$(tail -1 "$SFW/j3.txt")" = "this change is on disk but not in sikstack (RuntimeError: a failure inside the step): run sync" ] \
  && [ "$sf_rc4" = 1 ] && grep -qF 'stopped before it finished, RuntimeError: ' "$SFW/j4.txt" \
  && ok "any other failure of the begin or the commit step is one line: the command did not run (the hook's note), or its change is on disk only with the journal naming it to the next command" \
  || bad "a non-cloud failure inside the boundary -- rc=$sf_rc/$sf_rc2/$sf_rc3/$sf_rc4 $(head -1 "$SFW/j.txt") / $(tail -1 "$SFW/j2.txt") / $(tail -1 "$SFW/j3.txt") / $(head -1 "$SFW/j4.txt")"
rm -f "$SF/.sikstack/.hi2vi/journal.json"; sf_m=$(sf_mark); sf next >/dev/null; sf_rc=$?; sf_r=$(sf_check "$sf_m" synced)
[ "$sf_rc" = 0 ] && [ "$sf_r" = ok ] || bad "the checkout did not settle after the simulated failure -- rc=$sf_rc $sf_r"
# A key in the key file that holds a control character is refused, and never quoted in the line.
sf_kf="$SFX/sikstack/workspace-keys.json"; cp "$sf_kf" "$SFW/keys.bak"
python3 - "$sf_kf" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for projects in d.values():
    projects["proj-1"]["key"] += "\ntail"
json.dump(d, open(sys.argv[1], "w"))
PY
sf next > "$SFW/i9.txt"; sf_rc=$?; cp "$SFW/keys.bak" "$sf_kf"; chmod 600 "$sf_kf"
[ "$sf_rc" = 1 ] && [ "$(grep -c '' "$SFW/i9.txt")" = 1 ] && ! grep -qF "$SFK" "$SFW/i9.txt" && grep -q 'holds spaces or control characters' "$SFW/i9.txt" \
  && ok "a key file whose key holds a newline is refused with one line, and the key is not in it" \
  || bad "a key with a newline -- rc=$sf_rc $(head -2 "$SFW/i9.txt" | sed "s/$SFK/<key>/g")"
# (h) the key never reaches the tree (journal and outbox included), the output or the fake's request log.
if grep -rqF "$SFK" "$SF" "$SF_OUT" "$SFW/fake" 2>/dev/null; then bad "the workspace key leaked into the tree, the output or the request log"
else ok "the workspace key appears nowhere in the checkout (journal and outbox included), the output or the fake's request log"; fi
kill "$SF_PID" 2>/dev/null; wait "$SF_PID" 2>/dev/null
echo "cloud safety test runtime: $(( $(date +%s) - sf_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 23: link, unlink and sync against the local fake sikstack, with a scratch XDG_CONFIG_HOME -- init hides .hi2vi/ in the workflow repo; link refuses http:// to a non-local host, uncommitted changes, another worktree, a phase in flight on a stream, a key file open to group or others, a wrong key and an already-linked checkout, each with nothing written; link reads the key from stdin, keeps it 0600 in a 0700 folder and uploads the truth set in batches under 8,000,000 B; next prints store=cloud and head sends X-Sikstack-Base; worktree start is refused in cloud mode with nothing written; a second checkout joins from an unused install (following fetch's rest) or an equal set, and a used one is refused with the list; a typed brief id is resolved after the pull (it names what another checkout made, on the first try, and a number shared once the pull lands is refused); sync pulls and pushes the clean changes, lists a stale write, shows its diff, refuses --keep with no path, on a folder and on a path on neither side, and resolves only on --keep local|cloud, lists an interrupted command's files and pushes none until --keep; unlink refuses on a mismatch, then leaves a local-mode tree that validates and opens no socket; unlink --from-disk runs offline; the key appears nowhere =="
lk_t0=$(date +%s)
newtmp LKW; LKX="$LKW/xdg"; LK_OUT="$LKW/out.txt"; : > "$LK_OUT"
LKA="$LKW/a"; LKB="$LKW/b"; LKC="$LKW/c"; LKR="$LKW/root"
# lk <host> <args>: one engine command in that host's nested workspace, with the scratch XDG; stdin passes through.
lk() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$LKX" python3 "$(wf_entry "$1")" "$@" ) 2>&1 | tee -a "$LK_OUT"; return "${PIPESTATUS[0]}"; }
# lk_nosock <engine> <args>: the same under a socket guard (any connect or urlopen ends the process with 97).
lk_nosock() { _e=$1; shift; ( cd "$(dirname "$(dirname "$_e")")" && XDG_CONFIG_HOME="$LKX" python3 - "$ENG" "$@" <<'PY'
import os, runpy, socket, sys, urllib.request
def guard(*a, **k):
    sys.stderr.write("SOCKET-OPENED\n")
    os._exit(97)
socket.socket.connect = guard
socket.create_connection = guard
urllib.request.urlopen = guard
urllib.request.OpenerDirector.open = guard
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
PY
) 2>&1 | tee -a "$LK_OUT"; return "${PIPESTATUS[0]}"; }
lk_install() { { mkhost "$@" \
  && git -C "$1/.sikstack" config user.email smoke@example.invalid && git -C "$1/.sikstack" config user.name smoke \
  && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m install; } > "$1.setup.txt" 2>&1 || bad "link probe: the install of $1 failed -- $(tail -3 "$1.setup.txt")"; }
lk_commit() { git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -qm "$2" >/dev/null; }
# The whole workflow tree's sha list (.git aside) plus the XDG folder's, to prove a refusal wrote nothing.
lk_tree() { python3 - "$1" "$LKX" <<'PY'
import hashlib, os, sys
for root in sys.argv[1:]:
    for d, dirs, files in sorted(os.walk(root)):
        dirs[:] = sorted(x for x in dirs if not (d == root and x == ".git"))
        for f in sorted(files):
            p = os.path.join(d, f)
            print(os.path.relpath(p, root), oct(os.stat(p).st_mode), hashlib.sha256(open(p, "rb").read()).hexdigest())
PY
}
lk_install "$LKA"; lk_install "$LKB"; lk_install "$LKC"
LKK="link-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; LKO="other-secret-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$LKK" > "$LKW/key"; chmod 600 "$LKW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$LKW/fake" --port-file "$LKW/port" --key-file "$LKW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$LKW/fake.txt" 2>&1 &
LK_PID=$!
for _ in $(seq 1 100); do [ -s "$LKW/port" ] && break; sleep 0.1; done
LKS="http://127.0.0.1:$(cat "$LKW/port" 2>/dev/null)"; LKU="$LKS/projects/proj-1"
lk_mark() { if [ -f "$LKW/fake/requests.jsonl" ]; then grep -c '' "$LKW/fake/requests.jsonl"; else echo 0; fi; }
lk_ctl() { python3 - "$LKS" "$1" <<'PY'
import http.client, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/control", sys.argv[2], {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
lk_put() { python3 - "$LKS" "$1" "$2" <<'PY' || bad "link probe: the fake write failed"
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/write", json.dumps({"path": sys.argv[2], "content": sys.argv[3]}), {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
# lk_check <workflow dir> <mark> <check> [args]: one named assertion over the fake's requests since <mark>, its
# records, the checkout's base.json and journal, and its disk.
lk_check() { python3 - "$LKW/fake/requests.jsonl" "$LKS" "$@" <<'PY'
import base64, hashlib, http.client, json, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, mark, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6:]
R = [json.loads(l) for l in (Path(log).read_text().splitlines() if Path(log).exists() else [])[mark:]]
C = [r for r in R if r["path"].endswith("/commit")]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())
S = get("/_fake/state")[1]
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
hi = root / ".hi2vi"
base = json.loads((hi / "base.json").read_text()) if (hi / "base.json").exists() else {}
journal = json.loads((hi / "journal.json").read_text()) if (hi / "journal.json").exists() else None
def sha(p):
    return hashlib.sha256((root / p).read_bytes()).hexdigest()
def cloud(p):
    return base64.b64decode(get("/_fake/file?path=" + quote(p))[1]["content"]).decode()
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
def synced():
    need(journal is None, f"the journal is left: {journal}")
    need(base.get("head") == S["head"], f"base head {base.get('head')} != sikstack head {S['head']}")
    need(set(base["files"]) == set(live), f"base and sikstack hold different paths: {sorted(set(base['files']) ^ set(live))[:4]}")
    for p, f in live.items():
        if p == "works/events.jsonl":  # cold (0.4.0): once a push lands its sent lines leave the disk
            need(base["files"][p]["rev"] == f["rev"] and (not (root / p).exists() or (root / p).read_bytes() == b""),
                 f"{p}: the base's rev is not sikstack's, or the disk still holds sent lines")
            continue
        need(base["files"][p]["rev"] == f["rev"] and (root / p).is_file() and sha(p) == f["sha256"], f"{p}: base, disk and sikstack disagree")
if check == "nothing":  # a refusal: no request reached the fake
    need(not R, f"a refused link reached sikstack: {[r['path'] for r in R]}")
elif check == "upload":
    need(len(C) >= 2 and all(c["status"] == 200 for c in C), f"several landed batches expected: {[(c['status'], c.get('bytes')) for c in C]}")
    need(all(0 < c["bytes"] < 8_000_000 for c in C), f"a batch over 8,000,000 B: {[c.get('bytes') for c in C]}")
    need(all(c["batch"]["command"].startswith("link ") for c in C), "the upload's batches do not name link")
    ops = [op for c in C for op in c["batch"]["ops"]]
    need(all(op["op"] in ("put", "append") and op.get("base_rev") is None for op in ops), "the first upload only adds")
    need(len([p for p in live if "/topics/big-" in p]) == 3 and "works/phases/active/P1/phase.json" in live, "a file is missing in sikstack")
    import re as _re
    table = _re.search(r"(?ms)^\[cloud\]\n(.*?)(?=^\[|\Z)", (root / "config.toml").read_text())
    link = dict(_re.findall(r'(?m)^(\w+) = "?([^"\n]*)"?$', table.group(1))) if table else {}
    need(link.get("server") == server and link.get("org_id") == "org-1" and link.get("project_id") == "proj-1" and "key" not in link
         and not (hi / "link.json").exists(), f"config.toml's [cloud] link: {link}")
    synced()
elif check == "next":  # extra: the line next printed
    heads = [r for r in R if r["path"].endswith("/head")]
    need(heads and all(r.get("base") == str(base.get("head")) for r in heads), f"head did not send X-Sikstack-Base {base.get('head')}: {[r.get('base') for r in heads]}")
    need(extra[0] == f"store=cloud server={server} project=proj-1", f"next's store line: {extra[0]!r}")
elif check == "join":  # extra: page (the fetch followed rest)
    fetches = [r for r in R if r["path"].endswith("/fetch")]
    need(not C or all(c["status"] == 200 for c in C), "a join's batch failed")
    need(len(fetches) >= 2 and any(r.get("rest") for r in fetches), f"the join did not follow rest: {[(len(r['paths']), r.get('rest')) for r in fetches]}")
    synced()
elif check == "synced":
    synced()
elif check == "stale":  # extra: path, the cloud's content, revisions before
    path, content = extra[0], extra[1]
    need(all(op.get("path") != path for c in C for op in c["batch"]["ops"]), "sync sent the stale path")
    need(cloud(path) == content, "sikstack's copy changed")
    need("changed here" in (root / path).read_text(), "the disk lost this checkout's change")
elif check == "clean":  # extra: the pulled path, the pushed path
    need((root / extra[0]).is_file() and extra[0] in live and sha(extra[0]) == live[extra[0]]["sha256"], "the clean cloud change was not pulled")
    need(extra[1] in live and sha(extra[1]) == live[extra[1]]["sha256"], "the clean local change was not pushed")
elif check == "kept-local":  # extra: path
    need(len(C) == 1 and C[0]["status"] == 200 and C[0]["batch"]["command"] == f"sync --keep local {extra[0]}", f"one keep batch expected: {[(c['status'], c['batch'].get('command')) for c in C]}")
    need(cloud(extra[0]) == (root / extra[0]).read_text(), "sikstack does not hold the disk's copy")
elif check == "kept-cloud":  # extra: path, content
    need(not C, "keep cloud sent a batch")
    need((root / extra[0]).read_text() == extra[1] == cloud(extra[0]), "the disk does not hold sikstack's copy")
elif check == "interrupted":  # extra: revisions before
    need(not C and S["revisions"] == int(extra[0]), "sync pushed an interrupted command's changes")
    need(journal is not None and journal.get("state") == "running", f"the journal is not running: {journal}")
elif check == "kept-append":
    ops = [op for c in C for op in c["batch"]["ops"] if op.get("path") == "works/events.jsonl"]
    need(len(C) == 1 and C[0]["status"] == 200 and [op["op"] for op in ops] == ["append"], f"events.jsonl kept as {[op['op'] for op in ops]}")
elif check == "revs":  # extra: revisions before (unchanged)
    need(S["revisions"] == int(extra[0]) and not C, "a refused sync changed sikstack")
elif check == "quiet":  # a refusal or a read after a pull: no batch sent, the pull recorded, no journal left
    need(not C, f"a batch was sent: {[c['batch'].get('command') for c in C]}")
    synced()
print("ok")
PY
}
lk_revs() { python3 - "$LKS" <<'PY'
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("GET", "/_fake/state")
print(json.loads(conn.getresponse().read())["revisions"])
PY
}
# (h) sikstack init hides .hi2vi/ in the workflow repo's own info/exclude, fresh and on a second run (a repair).
lk_ex="$LKB/.sikstack/.git/info/exclude"; grep -qx '/.hi2vi/' "$LKA/.sikstack/.git/info/exclude"; lk_rc=$?
grep -vx '/.hi2vi/' "$lk_ex" > "$LKW/ex"; cat "$LKW/ex" > "$lk_ex"; grep -qx '/.hi2vi/' "$lk_ex"; lk_rc2=$?
( cd "$LKB" && python3 "$ENG" init ) > "$LKW/update.txt" 2>&1; lk_rc3=$?
[ "$lk_rc" = 0 ] && [ "$lk_rc2" = 1 ] && [ "$lk_rc3" = 0 ] && grep -qx '/.hi2vi/' "$lk_ex" \
  && ok "sikstack init hides .hi2vi/ in the workflow repo's own info/exclude, fresh and again on a second run" \
  || bad "the .hi2vi/ exclude is missing -- fresh=$lk_rc stripped=$lk_rc2 update=$lk_rc3 $(tail -2 "$LKW/update.txt")"
# A phase with three 3 MB topics in A (committed): the first upload must split.
( lk "$LKA" phase new --phase P1 --name One --objective toy >/dev/null ) && mkdir -p "$LKA/.sikstack/works/phases/active/P1/topics"
for i in 1 2 3; do python3 -c 'import sys; open(sys.argv[1], "w").write(("line of a big topic %s\n" % sys.argv[2]) * 140000)' \
  "$LKA/.sikstack/works/phases/active/P1/topics/big-$i.md" "$i"; done
lk_commit "$LKA" phase
# (a) the refusals, each one line with nothing written: no request, the tree and the XDG folder unchanged.
lk_ref() {  # lk_ref <label> <expected line ERE> <host> <engine> <args...>: run under the socket guard, key on stdin
  _l=$1; _x=$2; _h=$3; shift 3; _t1=$(lk_tree "$_h"); _m=$(lk_mark)
  printf '%s\n' "$LKK" | lk_nosock "$@" > "$LKW/ref.txt"; _rc=$?
  _t2=$(lk_tree "$_h"); _r=$(lk_check "$_h" "$_m" nothing)
  [ "$_rc" = 1 ] && [ "$(grep -v '^Paste a workspace key' "$LKW/ref.txt" | grep -c '')" = 1 ] && grep -qE "$_x" "$LKW/ref.txt" && [ "$_t1" = "$_t2" ] && [ "$_r" = ok ] \
    && [ ! -e "$_h/.hi2vi" ] && ! grep -qF "$LKK" "$LKW/ref.txt" \
    && ok "link refuses $_l with one line, opens no socket and writes nothing" \
    || bad "link did not refuse $_l cleanly -- rc=$_rc $_r $(head -2 "$LKW/ref.txt") $(diff <(echo "$_t1") <(echo "$_t2") | head -3)"
}
lk_ref "http:// to a non-local host" '^sikstack server http://sikstack\.example must be https://' "$LKA/.sikstack" "$LKA/.sikstack/scripts/workflow.py" link http://sikstack.example/projects/proj-1
printf 'not committed\n' > "$LKA/.sikstack/works/phases/active/P1/topics/loose.md"
lk_ref "uncommitted changes in the workflow repo" '^link refuses a workflow repo with uncommitted changes \(1 path\(s\), first works/phases/active/P1/topics/loose\.md\)' "$LKA/.sikstack" "$LKA/.sikstack/scripts/workflow.py" link "$LKU"
rm -f "$LKA/.sikstack/works/phases/active/P1/topics/loose.md"
git -C "$LKA/.sikstack" worktree add -q "$LKW/wt" -b side >/dev/null 2>&1
lk_ref "while the workflow repo has another worktree" '^link refuses while the workflow repo has another worktree' "$LKA/.sikstack" "$LKA/.sikstack/scripts/workflow.py" link "$LKU"
git -C "$LKA/.sikstack" worktree remove "$LKW/wt" >/dev/null 2>&1; git -C "$LKA/.sikstack" branch -q -D side >/dev/null 2>&1
( lk "$LKC" phase new --phase P1 --name Other --objective toy >/dev/null ) && lk_commit "$LKC" phase
python3 - "$LKC/.sikstack/works/phases/active/P1/phase.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["execution"] = {"mode": "parallel", "branch": "phase/P1-other", "worktree": None}
open(sys.argv[1], "w").write(json.dumps(d, indent=2) + "\n")
PY
lk_commit "$LKC" stamp
lk_ref "while a phase is in flight on its own stream" '^link refuses while a phase is in flight on its own stream \(P1\)' "$LKC/.sikstack" "$LKC/.sikstack/scripts/workflow.py" link "$LKU"
git -C "$LKC/.sikstack" reset -q --hard HEAD~1
mkdir -p "$LKX/sikstack" && chmod 700 "$LKX/sikstack" && printf '{"https://elsewhere.example": {"p": {"key": "%s"}}}\n' "$LKO" > "$LKX/sikstack/workspace-keys.json" && chmod 644 "$LKX/sikstack/workspace-keys.json"
lk_ref "a key file open to group or others (with the chmod fix, never the key)" "workspace-keys\.json can be read by group or others \(mode 0644\), and it holds workspace keys: run chmod 600 .*workspace-keys\.json, then run this again" "$LKA/.sikstack" "$LKA/.sikstack/scripts/workflow.py" link "$LKU"
grep -qF "$LKO" "$LKW/ref.txt" && bad "the 0644 refusal printed a key"
chmod 600 "$LKX/sikstack/workspace-keys.json"
lk_t1=$(lk_tree "$LKA/.sikstack"); printf 'not-the-key\n' | lk "$LKA" link "$LKU" > "$LKW/a6.txt"; lk_rc=$?; lk_t2=$(lk_tree "$LKA/.sikstack")
[ "$lk_rc" = 1 ] && grep -qx "sikstack refused this key (HTTP 401): make a workspace key under Keys on the project's page: nothing was written" "$LKW/a6.txt" && [ "$lk_t1" = "$lk_t2" ] && [ ! -e "$LKA/.sikstack/.hi2vi" ] \
  && ok "link refuses a key sikstack does not take (401) with one line and writes nothing (no .hi2vi/, the key file unchanged)" \
  || bad "a wrong key was not refused cleanly -- rc=$lk_rc $(tail -2 "$LKW/a6.txt")"
# (b) the link: the key from stdin, kept owner-only beside the other server's; the truth set uploaded in batches.
lk_m=$(lk_mark); printf '%s\n' "$LKK" | lk "$LKA" link "$LKU" > "$LKW/b.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" upload)
lk_modes=$(python3 -c 'import os, stat, sys; print("%o %o" % (stat.S_IMODE(os.stat(sys.argv[1]).st_mode), stat.S_IMODE(os.stat(sys.argv[2]).st_mode)))' "$LKX/sikstack" "$LKX/sikstack/workspace-keys.json")
lk_keys=$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); print(sorted(d), d[sys.argv[2]]["proj-1"]["key"] == sys.argv[3], d[sys.argv[2]]["proj-1"]["org_id"])' "$LKX/sikstack/workspace-keys.json" "$LKS" "$LKK")
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && [ "$lk_modes" = "700 600" ] && [ "$lk_keys" = "['$LKS', 'https://elsewhere.example'] True org-1" ] \
  && grep -qxE "store=cloud server=$LKS project=proj-1 head=r[0-9]+" "$LKW/b.txt" && [ "$(git -C "$LKA/.sikstack" status --porcelain)" = " M works/events.jsonl" ] \
  && ok "link reads the key from stdin, verifies it by head, keeps it in a 0700 folder's 0600 file beside the other server's key, writes the link as config.toml's [cloud] table without it (committed alone) and uploads the truth set as several batches under 8,000,000 B; the workflow repo's only change is the event log's sent lines leaving the disk (.hi2vi/ excluded)" \
  || bad "the link upload wrong -- rc=$lk_rc $lk_r modes=$lk_modes keys=$lk_keys $(tail -2 "$LKW/b.txt") $(git -C "$LKA/.sikstack" status --porcelain | head -3)"
lk_m=$(lk_mark); lk "$LKA" next > "$LKW/b2.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" next "$(grep '^store=' "$LKW/b2.txt")")
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && ok "next prints store=cloud server=<server> project=<id> in a linked checkout, and its head request sends X-Sikstack-Base: <synced head>" \
  || bad "next's store line or X-Sikstack-Base wrong -- rc=$lk_rc $lk_r"
lk_ref "an already-linked checkout" '^this checkout is already linked \(store=cloud server=' "$LKB/.sikstack" "$LKA/.sikstack/scripts/workflow.py" link "$LKU"
# (f) O7: in cloud mode a stream command is refused with one line, before any request, with nothing written.
lk_t1=$(lk_tree "$LKA/.sikstack"); lk_m=$(lk_mark); lk_nosock "$LKA/.sikstack/scripts/workflow.py" worktree start P1 --host-branch side > "$LKW/f.txt"; lk_rc=$?; lk_t2=$(lk_tree "$LKA/.sikstack")
[ "$lk_rc" = 1 ] && [ "$(grep -c '' "$LKW/f.txt")" = 1 ] && grep -q '^worktree start is refused in cloud mode: ' "$LKW/f.txt" && [ "$lk_t1" = "$lk_t2" ] && [ "$(lk_check "$LKA/.sikstack" "$lk_m" nothing)" = ok ] \
  && [ -z "$(git -C "$LKA/.sikstack" branch --list 'phase/*')" ] \
  && ok "worktree start in a linked checkout is refused with one line, no request, no branch and nothing written" \
  || bad "worktree start was not refused in cloud mode -- rc=$lk_rc $(head -2 "$LKW/f.txt")"
lk_bad=""; lk_t1=$(lk_tree "$LKA/.sikstack"); lk_m=$(lk_mark)
for c in "worktree gate P1" "worktree teardown P1" "worktree merge-finish" "phase reopen P1 --note x"; do
  # shellcheck disable=SC2086
  lk_nosock "$LKA/.sikstack/scripts/workflow.py" $c > "$LKW/f2.txt"; lk_rc=$?
  { [ "$lk_rc" = 1 ] && [ "$(grep -c '' "$LKW/f2.txt")" = 1 ] && grep -q "^${c%% P1*} is refused in cloud mode: " "$LKW/f2.txt"; } || lk_bad="$lk_bad [$c: rc=$lk_rc $(head -1 "$LKW/f2.txt")]"
done
lk_t2=$(lk_tree "$LKA/.sikstack")
[ -z "$lk_bad" ] && [ "$lk_t1" = "$lk_t2" ] && [ "$(lk_check "$LKA/.sikstack" "$lk_m" nothing)" = ok ] \
  && ok "the other stream commands (worktree gate, -teardown, -merge-finish, phase reopen) are refused in cloud mode with one line each, nothing written" \
  || bad "a stream command ran in cloud mode --$lk_bad"
# (c) a second checkout: an unused install joins (the fetch paged, following rest); a used one is refused with the list.
lk_ctl '{"fetch_page": 4000}'; lk_m=$(lk_mark); printf '%s\n' "$LKK" | lk "$LKB" link "$LKU" > "$LKW/c.txt"; lk_rc=$?; lk_r=$(lk_check "$LKB/.sikstack" "$lk_m" join)
lk_ctl '{"fetch_page": null}'
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && grep -q "^linked: joined sikstack's workspace ([0-9]* file(s) taken from sikstack, this unused install's seed files replaced)" "$LKW/c.txt" \
  && [ -f "$LKB/.sikstack/works/phases/active/P1/topics/big-2.md" ] && grep -qF 'One' "$LKB/.sikstack/works/backlog.md" \
  && ok "a second checkout joins from an unused install: its seed files give way, every file is taken from sikstack (fetch pages followed through rest) and the generated files are rebuilt" \
  || bad "the unused install did not join -- rc=$lk_rc $lk_r $(tail -3 "$LKW/c.txt")"
lk_t1=$(lk_tree "$LKC/.sikstack"); lk_m=$(lk_mark); printf '%s\n' "$LKK" | lk "$LKC" link "$LKU" > "$LKW/c2.txt"; lk_rc=$?; lk_t2=$(lk_tree "$LKC/.sikstack")
[ "$lk_rc" = 1 ] && grep -q "^link refuses: sikstack already holds this project's workspace (r[0-9]*), and [0-9]* path(s) here differ from it" "$LKW/c2.txt" \
  && grep -qx 'differs  works/phases/active/P1/phase.json' "$LKW/c2.txt" && [ "$lk_t1" = "$lk_t2" ] && [ ! -e "$LKC/.sikstack/.hi2vi" ] \
  && ok "a used checkout is refused at the join with the list of differing paths, and nothing is written" \
  || bad "a used checkout's join was not refused with the list -- rc=$lk_rc $(head -4 "$LKW/c2.txt")"
lk_nosock "$LKB/.sikstack/scripts/workflow.py" unlink --from-disk > "$LKW/c3.txt"; lk_rc=$?
[ "$lk_rc" = 0 ] && [ ! -e "$LKB/.sikstack/.hi2vi" ] && grep -q '^unlinked from the disk, offline: changes made in sikstack after r[0-9]* are not on this disk' "$LKW/c3.txt" \
  && grep -qx 'local mode: the files on disk are the truth again; commit them (git -C .sikstack add -A && git -C .sikstack commit)' "$LKW/c3.txt" \
  && ok "unlink --from-disk runs offline (no socket), removes .hi2vi/ and says what the disk cannot hold" \
  || bad "unlink --from-disk wrong -- rc=$lk_rc $(head -3 "$LKW/c3.txt")"
lk_commit "$LKB" unlinked; lk_m=$(lk_mark); printf '%s\n' "$LKK" | lk "$LKB" link "$LKU" > "$LKW/c4.txt"; lk_rc=$?; lk_r=$(lk_check "$LKB/.sikstack" "$lk_m" synced)
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && grep -q "^linked: joined sikstack's workspace (0 file(s) taken from sikstack)" "$LKW/c4.txt" \
  && ok "a checkout whose files equal sikstack's joins with nothing taken" || bad "an equal set did not join -- rc=$lk_rc $lk_r $(tail -2 "$LKW/c4.txt")"
# A typed id is resolved after the begin step's pull: a brief id names what another checkout made since this one
# last pulled, on the first try (A makes each record, then B's very next command names it by its brief form).
lk_bad=""
lk_brief() {  # lk_brief <A's command> <B's command> <B's expected line ERE>
  _a=$1; _b=$2; _x=$3
  # shellcheck disable=SC2086
  lk "$LKA" $_a > "$LKW/br-a.txt" || lk_bad="$lk_bad [A: $_a: $(tail -1 "$LKW/br-a.txt")]"
  # shellcheck disable=SC2086
  lk "$LKB" $_b > "$LKW/br-b.txt"; _rc=$?
  { [ "$_rc" = 0 ] && grep -qE "$_x" "$LKW/br-b.txt"; } || lk_bad="$lk_bad [B: $_b: rc=$_rc $(head -1 "$LKW/br-b.txt")]"
}
lk_brief "phase new --phase 7-ab --name Brief --objective toy" "section 7" '^ +[0-9]+  Objective$'
lk_brief "slice new --phase P7-ab --slice P7-ab.S1 --name s" "route 7.S1" '^slice=P7-ab\.S1$'
lk_brief "agenda-add --id 7-ef --title brief --author person:smoke" "agenda-solve 7 --outcome done" '^solved A7-ef'
[ -z "$lk_bad" ] \
  && ok "in a linked checkout a brief id names what another checkout made since the last pull, on the first try: a phase number (section 7), a slice's brief phase part (route 7.S1) and an agenda item's (agenda-solve 7)" \
  || bad "a brief id was resolved against the stale disk, before the pull --$lk_bad"
# A number unique on B's stale disk but shared once the pull lands is refused with the list, one line; the
# refusal still runs the commit step (no journal left, the pull recorded, nothing sent), and the full id runs.
( lk "$LKA" phase new --phase 7-zz --name Twin --objective toy >/dev/null )
lk_m=$(lk_mark); lk "$LKB" section 7 > "$LKW/br-c.txt"; lk_rc=$?; lk_r=$(lk_check "$LKB/.sikstack" "$lk_m" quiet)
lk_m=$(lk_mark); lk "$LKB" section 7-zz > "$LKW/br-d.txt"; lk_rc2=$?; lk_r2=$(lk_check "$LKB/.sikstack" "$lk_m" quiet)
lk "$LKA" route 7-ab.S1 > "$LKW/br-e.txt"; lk_rc3=$?
[ "$lk_rc" = 1 ] && [ "$(grep -c '' "$LKW/br-c.txt")" = 1 ] && grep -qx "'7' names 2 phases numbered 7: P7-ab, P7-zz -- type the tail (e.g. P7-ab or 7-ab)" "$LKW/br-c.txt" \
  && [ "$lk_r" = ok ] && [ "$lk_rc2" = 0 ] && grep -qE '^ +[0-9]+  Objective$' "$LKW/br-d.txt" && [ "$lk_r2" = ok ] \
  && [ "$lk_rc3" = 0 ] && grep -qx 'slice=P7-ab.S1' "$LKW/br-e.txt" \
  && ok "a brief id unique on the stale disk but shared after the pull is refused with the list in one line, exit 1; the commit step still runs (no journal left, the pull recorded, nothing sent); the full id then runs, and a tailed brief id of a record on the disk still resolves" \
  || bad "a number shared after the pull was not refused cleanly -- rc=$lk_rc/$lk_rc2/$lk_rc3 $lk_r / $lk_r2 $(head -2 "$LKW/br-c.txt")"
# (d) sync in A: a stale write (409) beside a clean change on each side.
lk_p=works/phases/active/P1/intent.md; printf 'changed here\n' >> "$LKA/.sikstack/$lk_p"
lk_ctl "{\"race\": {\"path\": \"$lk_p\", \"content\": \"changed in sikstack by another checkout\\n\"}}"
lk "$LKA" next > "$LKW/d0.txt"; lk_rc0=$?
lk_put works/phases/active/P1/topics/cloud.md 'written in sikstack
'; printf 'written here\n' > "$LKA/.sikstack/works/phases/active/P1/topics/local.md"
lk_v=$(lk_revs); lk_m=$(lk_mark); lk "$LKA" sync > "$LKW/d.txt"; lk_rc=$?
lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" clean works/phases/active/P1/topics/cloud.md works/phases/active/P1/topics/local.md)
lk_r2=$(lk_check "$LKA/.sikstack" "$lk_m" stale "$lk_p" 'changed in sikstack by another checkout
' "$lk_v")
[ "$lk_rc0" = 1 ] && [ "$lk_rc" = 1 ] && [ "$lk_r" = ok ] && [ "$lk_r2" = ok ] \
  && grep -qE "^differs  $lk_p  here: changed since r[0-9]+ \(.+\)  sikstack: r[0-9]+$" "$LKW/d.txt" && [ "$(grep -cE '^(differs|here only|cloud only|deleted|interrupted)' "$LKW/d.txt")" = 1 ] \
  && ok "sync pulls the clean sikstack change, pushes the clean local one, and lists the stale write (differs, both sides' facts), resolving nothing: exit 1" \
  || bad "sync's list wrong -- rc=$lk_rc0/$lk_rc $lk_r / $lk_r2 / $(head -4 "$LKW/d.txt")"
lk "$LKA" sync --diff "$lk_p" > "$LKW/d2.txt"; lk_rc=$?
[ "$lk_rc" = 0 ] && grep -qx -- '-changed in sikstack by another checkout' "$LKW/d2.txt" && grep -qx -- '+changed here' "$LKW/d2.txt" && grep -q "^--- sikstack/$lk_p (r[0-9]*)" "$LKW/d2.txt" \
  && ok "sync --diff shows sikstack's copy against the disk as a unified diff" || bad "sync --diff wrong -- rc=$lk_rc $(head -5 "$LKW/d2.txt")"
lk_v=$(lk_revs); lk_m=$(lk_mark); lk "$LKA" sync --keep local > "$LKW/d3.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" revs "$lk_v")
lk "$LKA" next > "$LKW/d4.txt"; lk_rc2=$?
[ "$lk_rc" != 0 ] && [ "$(grep -c '' "$LKW/d3.txt")" = 1 ] && grep -q '^sync --keep needs at least one path' "$LKW/d3.txt" && [ "$lk_r" = ok ] \
  && [ "$lk_rc2" = 1 ] && grep -q '^1 files differ between this checkout and sikstack: run sync' "$LKW/d4.txt" \
  && ok "sync --keep with no path is refused with one line and nothing sent; the stale write still stops the next command" \
  || bad "sync --keep without a path was not refused -- rc=$lk_rc/$lk_rc2 $lk_r $(head -2 "$LKW/d3.txt") / $(head -1 "$LKW/d4.txt")"
# --keep takes only a file on one side or the other: a folder, or a path on neither side, is refused with one line,
# nothing sent and nothing written (never "sikstack holds it now", never a traceback); so is --diff on a folder.
lk_bad=""
for lk_args in "--keep local works/agenda" "--keep local works/no-such-file.md" "--keep cloud works/agenda" "--keep cloud works/no-such-file.md" "--diff works/agenda"; do
  lk_v=$(lk_revs); lk_m=$(lk_mark); lk_t1=$(lk_tree "$LKA/.sikstack")
  # shellcheck disable=SC2086
  lk "$LKA" sync $lk_args > "$LKW/d9.txt"; lk_rc=$?; lk_t2=$(lk_tree "$LKA/.sikstack"); lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" revs "$lk_v")
  case "$lk_args" in *agenda) lk_want='^works/agenda is a folder: sync takes file paths, one by one as sync lists them \(nothing was changed\)$' ;;
    *) lk_want='^sync --keep refused: works/no-such-file\.md names no file here or in sikstack; it takes the file paths sync lists \(nothing was changed\)$' ;; esac
  { [ "$lk_rc" = 1 ] && [ "$(grep -c '' "$LKW/d9.txt")" = 1 ] && grep -qE "$lk_want" "$LKW/d9.txt" && [ "$lk_r" = ok ] && [ "$lk_t1" = "$lk_t2" ]; } \
    || lk_bad="$lk_bad [sync $lk_args: rc=$lk_rc $lk_r $(head -1 "$LKW/d9.txt")]"
done
lk "$LKA" next > "$LKW/d4.txt"; lk_rc2=$?
[ -z "$lk_bad" ] && [ "$lk_rc2" = 1 ] && grep -q '^1 files differ between this checkout and sikstack: run sync' "$LKW/d4.txt" \
  && ok "sync --keep local|cloud on a folder or on a path on neither side, and sync --diff on a folder, are refused with one line each, nothing sent, the tree unchanged; the stale write still waits" \
  || bad "sync --keep on a folder or an unknown path was not refused --$lk_bad rc=$lk_rc2 $(head -1 "$LKW/d4.txt")"
lk_m=$(lk_mark); lk "$LKA" sync --keep local "$lk_p" > "$LKW/d5.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" kept-local "$lk_p")
lk_m=$(lk_mark); lk "$LKA" sync > "$LKW/d6.txt"; lk_rc2=$?; lk_r2=$(lk_check "$LKA/.sikstack" "$lk_m" synced)
lk "$LKA" sync --status > "$LKW/d7.txt"; lk_rc3=$?
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && [ "$lk_rc2" = 0 ] && [ "$lk_r2" = ok ] && grep -q '^in sync: ' "$LKW/d6.txt" && grep -qE '^in sync: head=r([0-9]+) base=r\1$' "$LKW/d5.txt" && [ "$lk_rc3" = 0 ] \
  && grep -qxE "store=cloud server=$LKS project=proj-1 head=r([0-9]+) base=r\1 here=0 differ=0 inbox=0" "$LKW/d7.txt" \
  && ok "sync --keep local <path> pushes the disk's copy over sikstack's revision (recorded as that command); then sync is clean and sync --status reads head=base, here=0 differ=0" \
  || bad "sync --keep local wrong -- rc=$lk_rc/$lk_rc2/$lk_rc3 $lk_r / $lk_r2 / $(cat "$LKW/d7.txt")"
printf 'changed here again\n' >> "$LKA/.sikstack/$lk_p"
lk_ctl "{\"race\": {\"path\": \"$lk_p\", \"content\": \"sikstack wins this one\\n\"}}"; lk "$LKA" next >/dev/null
lk_m=$(lk_mark); lk "$LKA" sync --keep cloud "$lk_p" > "$LKW/d8.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" kept-cloud "$lk_p" 'sikstack wins this one
')
lk_m=$(lk_mark); lk "$LKA" next >/dev/null; lk_rc2=$?; lk_r2=$(lk_check "$LKA/.sikstack" "$lk_m" synced)
[ "$lk_rc" = 0 ] && [ "$lk_r" = ok ] && [ "$lk_rc2" = 0 ] && [ "$lk_r2" = ok ] \
  && ok "sync --keep cloud <path> writes sikstack's copy over the disk, and the next command runs synced" \
  || bad "sync --keep cloud wrong -- rc=$lk_rc/$lk_rc2 $lk_r / $lk_r2 $(tail -2 "$LKW/d8.txt")"
# An interrupted command: sync lists its files as interrupted and pushes none of them until --keep.
( cd "$LKA" && XDG_CONFIG_HOME="$LKX" python3 - agenda-add --title killed --author person:smoke <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("workflow_engine", __import__("os").environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
agenda = sys.modules["wf_agenda"]  # the agenda part the engine imported
real = agenda.agenda_add
def crash(args):
    real(args)
    os._exit(9)
agenda.agenda_add = crash
sys.exit(mod.main(sys.argv[1:]))
PY
) >> "$LK_OUT" 2>&1
lk_v=$(lk_revs); lk_m=$(lk_mark); lk "$LKA" sync > "$LKW/e.txt"; lk_rc=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" interrupted "$lk_v")
lk_ip=$(grep '^interrupted  ' "$LKW/e.txt" | awk '{print $2}' | tr '\n' ' ')
[ "$lk_rc" = 1 ] && [ "$lk_r" = ok ] && echo "$lk_ip" | grep -q 'works/agenda/.*/agenda.json' \
  && ok "after a command killed midway, sync lists its files as interrupted and pushes none of them (the journal stays running)" \
  || bad "sync did not hold the interrupted files -- rc=$lk_rc $lk_r $(head -3 "$LKW/e.txt")"
# shellcheck disable=SC2086
lk_m=$(lk_mark); lk "$LKA" sync --keep local $lk_ip > "$LKW/e2.txt"; lk_rc=$?; lk_r0=$(lk_check "$LKA/.sikstack" "$lk_m" kept-append)
lk_m=$(lk_mark); lk "$LKA" next >/dev/null; lk_rc2=$?; lk_r=$(lk_check "$LKA/.sikstack" "$lk_m" synced)
[ "$lk_rc" = 0 ] && [ "$lk_rc2" = 0 ] && [ "$lk_r0" = ok ] && [ "$lk_r" = ok ] && grep -q '^the interrupted command (agenda-add --title killed' "$LKW/e2.txt" \
  && ok "sync --keep local on the interrupted files pushes them (works/events.jsonl as its new lines, never a put), clears the journal, and the next command runs synced" \
  || bad "resolving the interrupted state wrong -- rc=$lk_rc/$lk_rc2 $lk_r0 / $lk_r $(head -3 "$LKW/e2.txt")"
# (e) unlink: refused on a mismatch (still linked), then the way back to local mode.
printf 'one more\n' >> "$LKA/.sikstack/$lk_p"
lk_ctl "{\"race\": {\"path\": \"$lk_p\", \"content\": \"and another\\n\"}}"; lk "$LKA" next >/dev/null
lk "$LKA" unlink > "$LKW/g.txt"; lk_rc=$?
[ "$lk_rc" = 1 ] && grep -qx '\[cloud\]' "$LKA/.sikstack/config.toml" && grep -q '^unlink refused, the checkout is still linked: 1 files differ between this checkout and sikstack' "$LKW/g.txt" \
  && ok "unlink refuses on a mismatch with one line, and the checkout stays linked" || bad "unlink did not refuse on a mismatch -- rc=$lk_rc $(head -2 "$LKW/g.txt")"
lk "$LKA" sync --keep local "$lk_p" >/dev/null
lk_m=$(lk_mark); lk "$LKA" unlink > "$LKW/g2.txt"; lk_rc=$?
lk "$LKA" check --no-rebuild > "$LKW/g3.txt"; lk_rc2=$?
lk_in=""; for c in "next" "phase new --phase P2 --name Two --objective toy" "agenda-add --title local --author person:smoke" "check"; do
  # shellcheck disable=SC2086
  lk_nosock "$LKA/.sikstack/scripts/workflow.py" $c > "$LKW/g4.txt"; [ "$?" = 97 ] && lk_in="$lk_in [$c]"
done
[ "$lk_rc" = 0 ] && [ ! -e "$LKA/.sikstack/.hi2vi" ] && ! grep -qx '\[cloud\]' "$LKA/.sikstack/config.toml" && grep -qx 'local mode: the files on disk are the truth again; commit them (git -C .sikstack add -A && git -C .sikstack commit)' "$LKW/g2.txt" \
  && [ "$lk_rc2" = 0 ] && [ -z "$lk_in" ] && [ -d "$LKA/.sikstack/works/phases/active/P2" ] && grep -qF "$LKS" "$LKX/sikstack/workspace-keys.json" \
  && ok "unlink pulls and pushes, removes .hi2vi/ and the [cloud] table and prints the one-commit line; the tree validates, local commands open no socket, and the key stays in user config" \
  || bad "unlink wrong -- rc=$lk_rc/$lk_rc2 nosock:$lk_in $(head -3 "$LKW/g2.txt") / $(tail -2 "$LKW/g3.txt")"
# The key file's mode is checked at every linked command too (B is linked): 0644 refuses before any request.
chmod 644 "$LKX/sikstack/workspace-keys.json"; lk_m=$(lk_mark); lk "$LKB" next > "$LKW/k.txt"; lk_rc=$?; chmod 600 "$LKX/sikstack/workspace-keys.json"
[ "$lk_rc" = 1 ] && grep -q 'workspace-keys.json can be read by group or others (mode 0644)' "$LKW/k.txt" && [ "$(lk_check "$LKB/.sikstack" "$lk_m" nothing)" = ok ] \
  && ok "a linked command with the key file at 0644 is refused with the chmod fix, before any request" \
  || bad "a 0644 key file was used by a linked command -- rc=$lk_rc $(head -2 "$LKW/k.txt")"
# (g) the key never reaches a tree (.hi2vi/ included), the output, the events or the fake's request log.
if grep -rqF "$LKK" "$LKA" "$LKB" "$LKC" "$LKR" "$LK_OUT" "$LKW/fake" "$LKW"/*.txt 2>/dev/null; then bad "the workspace key leaked into a tree, the output or the request log"
else ok "the workspace key appears nowhere in the checkouts (.hi2vi/ and events included), the commands' output or the fake's request log"; fi
kill "$LK_PID" 2>/dev/null; wait "$LK_PID" 2>/dev/null
echo "link test runtime: $(( $(date +%s) - lk_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 34: the cold set in cloud mode, against the local fake sikstack -- link uploads every truth path (archived phases, doc versions, docs/index.json, docs/reference, the event log) and then keeps only the working set on disk; an archive's move lands and the archived folder leaves the disk, and sync then sends no delete (run 3); a lost answer on that move evicts nothing until the resend lands; a cold file the base lacks or holds at other bytes, and a folder whose .gitignore is *, stay; sync --keep cloud brings a cold file back and the next command takes it off again; the event log's lines reach sikstack once across a lost answer and a stop mid-eviction; a fresh join writes no cold path; sync never lists an evicted path; unlink restores every cold file byte-equal to sikstack's; unlink --from-disk, offline, writes back what the cache holds at sikstack's bytes, keeps each archived folder (and its phase id) with a marker naming what only sikstack holds, even after cold clear and in a clone, and each line it prints is true when followed, a later local phase included =="
co_t0=$(date +%s)
newtmp COW; COX="$COW/xdg"; COA="$COW/a"; COB="$COW/b"; CO_OUT="$COW/out.txt"; : > "$CO_OUT"
co() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$COX" python3 "$(wf_entry "$1")" "$@" ) 2>&1 | tee -a "$CO_OUT"; return "${PIPESTATUS[0]}"; }
co_install() { { mkhost "$1" \
  && git -C "$1/.sikstack" config user.email smoke@example.invalid && git -C "$1/.sikstack" config user.name smoke \
  && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m install; } > "$1.setup.txt" 2>&1 || bad "cold probe: the install of $1 failed -- $(tail -3 "$1.setup.txt")"; }
co_install "$COA"; co_install "$COB"
# A: two phases archived in local mode (one with an agent's topic), a live one, a doc version, docs/index.json, two
# docs/reference files and a local cache under docs/reference whose .gitignore is `*` (never in the truth set).
{ for p in P1 P2 P3; do ( cd "$COA" && python3 "$ENG" phase new --phase "$p" --name "Phase $p" --objective toy >/dev/null ) || exit 1; done
  mkdir -p "$COA/.sikstack/works/phases/active/P1/topics" "$COA/.sikstack/docs/versions/product" "$COA/.sikstack/docs/reference/cache"
  printf 'an agent wrote this topic\n' > "$COA/.sikstack/works/phases/active/P1/topics/note.md"
  ( cd "$COA" && python3 "$ENG" phase archive P1 --force >/dev/null ) || exit 1
  printf '# product v0002\n' > "$COA/.sikstack/docs/versions/product/v0002_cold.md"
  printf '{"docs": []}\n' > "$COA/.sikstack/docs/index.json"
  printf 'reference one\n' > "$COA/.sikstack/docs/reference/one.md"
  printf 'reference two\n' > "$COA/.sikstack/docs/reference/two.md"
  printf '*\n' > "$COA/.sikstack/docs/reference/cache/.gitignore"; printf 'a local cache\n' > "$COA/.sikstack/docs/reference/cache/blob.txt"
  git -C "$COA/.sikstack" add -A && git -C "$COA/.sikstack" commit -qm setup; } > "$COW/setup.txt" 2>&1 || bad "cold probe: the setup failed -- $(tail -3 "$COW/setup.txt")"
COK="cold-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$COK" > "$COW/key"; chmod 600 "$COW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$COW/fake" --port-file "$COW/port" --key-file "$COW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$COW/fake.txt" 2>&1 &
CO_PID=$!
for _ in $(seq 1 100); do [ -s "$COW/port" ] && break; sleep 0.1; done
COS="http://127.0.0.1:$(cat "$COW/port" 2>/dev/null)"; COU="$COS/projects/proj-1"
co_mark() { if [ -f "$COW/fake/requests.jsonl" ]; then grep -c '' "$COW/fake/requests.jsonl"; else echo 0; fi; }
co_ctl() { python3 - "$COS" "$1" <<'PY'
import http.client, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/control", sys.argv[2], {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
# co_snap <workflow dir> <out>: {rel: sha256} of every file under works/ and docs/ (the generated ones included).
co_snap() { python3 - "$1" "$2" <<'PY'
import hashlib, json, os, sys
root, out = sys.argv[1], sys.argv[2]
snap = {}
for top in ("works", "docs"):
    for d, _dirs, files in os.walk(os.path.join(root, top)):
        for f in files:
            p = os.path.join(d, f)
            snap[os.path.relpath(p, root)] = hashlib.sha256(open(p, "rb").read()).hexdigest()
json.dump(snap, open(out, "w"), indent=1, sort_keys=True)
PY
}
# co_check <workflow dir> <mark> <check> [args]: one named assertion over the fake's requests since <mark>, its records,
# the checkout's base.json and journal, and its disk.
co_check() { python3 - "$COW/fake/requests.jsonl" "$COS" "$@" <<'PY'
import base64, collections, hashlib, http.client, json, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, mark, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6:]
R = [json.loads(l) for l in (Path(log).read_text().splitlines() if Path(log).exists() else [])[mark:]]
C = [r for r in R if r["path"].endswith("/commit")]
ops = [op for c in C for op in c["batch"]["ops"]]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())
S = get("/_fake/state")[1]
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
hi = root / ".hi2vi"
base = json.loads((hi / "base.json").read_text()) if (hi / "base.json").exists() else {}
journal = json.loads((hi / "journal.json").read_text()) if (hi / "journal.json").exists() else None
EV = "works/events.jsonl"
def cold(p):
    return p.startswith(("works/phases/archived/", "docs/versions/", "docs/reference/")) or p in ("docs/index.json", EV)
def cloud(p):
    return base64.b64decode(get("/_fake/file?path=" + quote(p))[1]["content"])
def sha(b):
    return hashlib.sha256(b).hexdigest()
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
def thin():
    """The disk holds the working set only: every cold file sikstack holds is off the disk and in the base at
    sikstack's sha; every working file equals sikstack's; the event log on disk holds nothing sikstack holds."""
    need(journal is None, f"the journal is left: {journal}")
    need(base.get("head") == S["head"], f"base head {base.get('head')} != sikstack head {S['head']}")
    need(set(base["files"]) == set(live), f"base and sikstack hold different paths: {sorted(set(base['files']) ^ set(live))[:4]}")
    for p, f in live.items():
        if p == EV:
            here = (root / p).read_bytes() if (root / p).exists() else b""
            need(here == b"", f"the event log on disk is not thin: {here[:80]!r}")
            need(base["files"][p]["rev"] == f["rev"], "the event log's rev is not the base's")
        elif cold(p):
            need(not (root / p).exists(), f"{p}: a cold file sikstack holds is still on disk")
            need(base["files"][p]["sha256"] == f["sha256"] and base["files"][p]["rev"] == f["rev"], f"{p}: base and sikstack disagree")
        else:
            need((root / p).is_file() and sha((root / p).read_bytes()) == f["sha256"] and base["files"][p]["rev"] == f["rev"],
                 f"{p}: base, disk and sikstack disagree")
if check == "uploaded":  # extra: the snapshot before the link
    before = json.load(open(extra[0]))
    truth_cold = sorted(p for p in before if cold(p) and p != EV and "/cache/" not in p)
    need(len(truth_cold) >= 7, f"the setup made too few cold files: {truth_cold}")
    need(C and all(c["status"] == 200 for c in C) and all(op["op"] in ("put", "append") for op in ops), "the upload did not land as adds")
    for p in truth_cold:
        need(p in live and live[p]["sha256"] == before[p], f"{p}: not uploaded at its bytes")
    need(EV in live and cloud(EV) and sha(cloud(EV)) == before[EV], "the event log was not uploaded whole")
    need("docs/reference/cache/blob.txt" not in live and "docs/reference/cache/.gitignore" not in live, "a .gitignore * cache reached sikstack")
    after = {str(p.relative_to(root)) for top in ("works", "docs") for p in (root / top).rglob("*") if p.is_file()}
    need(after == set(before) - set(truth_cold), f"the disk is not the working set: gone {sorted(set(before) - after - set(truth_cold))[:3]}, left {sorted(after & set(truth_cold))[:3]}")
    need((root / "docs/reference/cache/blob.txt").read_text() == "a local cache\n", "the .gitignore * cache was touched")
    thin()
elif check == "run3":  # the archive's move landed, nothing deleted in sikstack, the archived folder off the disk
    need(not [op for op in ops if op["op"] == "delete"], f"a delete was sent: {[op['path'] for op in ops if op['op'] == 'delete']}")
    arch = [p for p in live if p.startswith("works/phases/archived/") and "_P2_" in p]
    need(len(arch) >= 3 and not [p for p in live if p.startswith("works/phases/active/P2/")], f"sikstack does not hold P2 archived: {arch}")
    need(len([p for p in live if p.startswith("works/phases/archived/") and "_P1_" in p and p.endswith("/topics/note.md")]) == 1, "P1's archived topic left sikstack")
    need(not list((root / "works/phases").glob("archived/*_P2_*")), "the archived P2 folder is still on disk")
    thin()
elif check == "held":  # extra: the phase; a lost answer: its archived folder still here, sikstack still holds it active
    need(journal is not None and journal.get("state") == "pushing", f"the journal does not hold the push: {journal}")
    need(list((root / "works/phases").glob(f"archived/*_{extra[0]}_*/phase.json")), f"the archived {extra[0]} left the disk before its push landed")
    need(not [p for p in base["files"] if p.startswith("works/phases/archived/") and f"_{extra[0]}_" in p], "the base names the archive before it landed")
elif check == "landed":  # extra: the phase
    need(not list((root / "works/phases").glob(f"archived/*_{extra[0]}_*")), f"the archived {extra[0]} is still on disk after its push landed")
    need([p for p in live if p.startswith("works/phases/archived/") and f"_{extra[0]}_" in p], f"sikstack lacks the archived {extra[0]}")
    need(not [op for op in ops if op["op"] == "delete"], "a delete was sent")
    thin()
elif check == "once":  # extra: a file of lines that must be in sikstack's log exactly once each
    need(journal is None, f"the journal is left: {journal}")
    log_lines = cloud(EV).decode().splitlines()
    twice = sorted(l for l, n in collections.Counter(log_lines).items() if n > 1)
    need(not twice, f"sikstack holds {len(twice)} line(s) twice, first {twice[:1]}")
    for line in Path(extra[0]).read_text().splitlines():
        need(log_lines.count(line) == 1, f"a line is in sikstack {log_lines.count(line)} time(s): {line[:80]}")
    thin()
elif check == "joined":  # a fresh join: the working set only on disk; its one cold read is the archived phase.json files
    # the agenda's link holders need (the rebuild after the pull), and those land in .sikstack/cache/, never on disk
    import re
    fetched = [p for r in R if r["path"].endswith("/fetch") for p in r.get("paths") or []]
    stray = [p for p in fetched if cold(p) and not re.fullmatch(r"works/phases/archived/[^/]+/phase\.json", p)]
    need(fetched and not stray, f"the join fetched a cold path beyond the link holders: {stray[:3]}")
    need(all((root / "cache" / p).is_file() for p in fetched if cold(p)), "a link holder's read did not land in .sikstack/cache/")
    on_disk = [str(p.relative_to(root)) for top in ("works", "docs") for p in (root / top).rglob("*") if p.is_file()]
    need(not [p for p in on_disk if cold(p) and p != EV], f"a cold path is on the joined disk: {[p for p in on_disk if cold(p)][:3]}")
    need(not C, "the join sent a batch")
    thin()
elif check == "restored":  # every cold file sikstack holds is on disk at its bytes; the event log is sikstack's whole log
    need(not hi.exists(), ".hi2vi/ is left after unlink")
    n = 0
    for p, f in live.items():
        if cold(p):
            need((root / p).is_file() and (root / p).read_bytes() == cloud(p), f"{p}: not restored byte-equal to sikstack's copy")
            n += p != EV
    need(n >= 8, f"too few cold files restored: {n}")
    print(f"ok {n}")
    sys.exit(0)
print("ok")
PY
}
# (a) link uploads everything, then thins the disk to the working set (C4); the .gitignore * cache stays (C3).
co_snap "$COA/.sikstack" "$COW/before.json"
co_m=$(co_mark); printf '%s\n' "$COK" | co "$COA" link "$COU" > "$COW/a.txt"; co_rc=$?; co_r=$(co_check "$COA/.sikstack" "$co_m" uploaded "$COW/before.json")
co_nb=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$COW/before.json"); co_snap "$COA/.sikstack" "$COW/after.json"
co_na=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$COW/after.json")
co_dirty=$(git -C "$COA/.sikstack" status --porcelain | awk '{print $2}' | grep -vE '^(works/events\.jsonl|works/phases/archived/|docs/versions/|docs/index\.json|docs/reference/)' | head -3)
[ "$co_rc" = 0 ] && [ "$co_r" = ok ] && grep -q '^cold: [0-9]* file(s) .* are kept in sikstack only' "$COW/a.txt" && [ -z "$co_dirty" ] \
  && ok "link uploads every truth path (an archived phase with its agent topic, a doc version, docs/index.json, docs/reference, the whole event log; never the .gitignore * cache), then keeps only the working set on disk ($co_nb files before, $co_na after; the event log empty), and the workflow repo's only changes are the evicted cold paths" \
  || bad "the link's upload and thinning wrong -- rc=$co_rc $co_r / $(tail -3 "$COW/a.txt") / dirty: $co_dirty"
# (b) run 3: archive in a linked checkout, then (as the plan's run did by hand) any archived folder still on disk
# moved out, then sync. No delete may reach sikstack, and the archived phase stays live there (C1).
co_m=$(co_mark); co "$COA" phase archive P2 --force > "$COW/b.txt"; co_rc=$?
for d in "$COA"/.sikstack/works/phases/archived/*_P2_*; do [ -d "$d" ] && mv "$d" "$COW/hand-evicted-$(basename "$d")"; done
co "$COA" sync > "$COW/b2.txt"; co_rc2=$?; co "$COA" sync --status > "$COW/b3.txt"; co_r=$(co_check "$COA/.sikstack" "$co_m" run3)
[ "$co_rc" = 0 ] && [ "$co_rc2" = 0 ] && [ "$co_r" = ok ] && grep -q '^in sync: ' "$COW/b2.txt" && grep -qE ' here=0 differ=0 ' "$COW/b3.txt" \
  && ok "run 3: phase archive's move lands as move ops and the archived folder leaves the disk; sync then sends no delete, sikstack still holds every archived file, and sync and sync --status list nothing" \
  || bad "run 3 still loses the archive -- rc=$co_rc/$co_rc2 $co_r / $(head -3 "$COW/b2.txt") / $(cat "$COW/b3.txt")"
# (c) a lost answer on the commit that carries the archive move: nothing is evicted until the resend lands (C2).
co_ctl '{"commit": "drop-before"}'; co_m=$(co_mark); co "$COA" phase archive P3 --force > "$COW/c.txt"; co_rc=$?
co_r=$(co_check "$COA/.sikstack" "$co_m" held P3)
co_m=$(co_mark); co "$COA" next > "$COW/c2.txt"; co_rc2=$?; co_r2=$(co_check "$COA/.sikstack" "$co_m" landed P3)
[ "$co_rc" = 1 ] && [ "$co_r" = ok ] && [ "$co_rc2" = 0 ] && [ "$co_r2" = ok ] \
  && ok "a lost answer on the archive's commit: the archived folder stays on disk and the base does not name it; the next command resends, it lands, and only then the folder leaves the disk" \
  || bad "eviction ran before the archive's push landed -- rc=$co_rc/$co_rc2 $co_r / $co_r2 / $(tail -1 "$COW/c.txt")"
# (d) sync --keep cloud brings a cold file back; the next command takes it off again. Changed here, or new here, a
# cold file stays through an eviction (the base's sha differs, or the base lacks it); the next command sends both
# and then takes them off (C3).
co_ref=docs/reference/one.md
co "$COA" sync --keep cloud "$co_ref" > "$COW/d.txt"; co_rc=$?; [ -f "$COA/.sikstack/$co_ref" ]; co_back=$?
co "$COA" next >/dev/null; co_rc2=$?; [ -f "$COA/.sikstack/$co_ref" ]; co_gone=$?
co "$COA" sync --keep cloud "$co_ref" >/dev/null; printf 'changed here\n' >> "$COA/.sikstack/$co_ref"
printf 'new here\n' > "$COA/.sikstack/docs/reference/new.md"
co_ev=$( cd "$COA" && XDG_CONFIG_HOME="$COX" python3 - <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("workflow_engine", os.environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
cloud = sys.modules["wf_cloud"]
session = cloud.CloudSession(["probe"])
session.cloud_head = session.base["head"]  # the base at head, no journal: the eviction's own rules decide
print(session.evict())
PY
)
[ -f "$COA/.sikstack/$co_ref" ] && [ -f "$COA/.sikstack/docs/reference/new.md" ]; co_kept=$?
co_m=$(co_mark); co "$COA" next >/dev/null; co_rc3=$?; co_r=$(co_check "$COA/.sikstack" "$co_m" landed P3)
[ "$co_rc" = 0 ] && [ "$co_back" = 0 ] && [ "$co_rc2" = 0 ] && [ "$co_gone" = 1 ] && [ "$co_ev" = 0 ] && [ "$co_kept" = 0 ] \
  && [ "$co_rc3" = 0 ] && [ "$co_r" = ok ] && [ ! -e "$COA/.sikstack/docs/reference/new.md" ] && [ -f "$COA/.sikstack/docs/reference/cache/blob.txt" ] \
  && ok "sync --keep cloud brings a cold file back and the next command takes it off again; an eviction leaves a cold file changed here and one sikstack lacks (and the .gitignore * cache); the next command sends both, then takes them off" \
  || bad "the eviction took an unsynced cold file or kept a synced one -- rc=$co_rc/$co_rc2/$co_rc3 back=$co_back gone=$co_gone evicted=$co_ev kept=$co_kept $co_r"
# (e) the event log after eviction: lines appended across a lost answer and a stop mid-eviction reach sikstack once (C7).
co "$COA" agenda-add --title first --author person:smoke >/dev/null; co_rc=$?
co_ctl '{"commit": "drop-after"}'; co "$COA" agenda-add --title lost --author person:smoke > "$COW/e.txt"; co_rc2=$?
cp "$COA/.sikstack/works/events.jsonl" "$COW/pending.txt"; co_np=$(grep -c '' "$COW/pending.txt")
( cd "$COA" && XDG_CONFIG_HOME="$COX" python3 - agenda-add --title killed --author person:smoke <<'PY'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("workflow_engine", os.environ["ENG"])
mod = importlib.util.module_from_spec(spec)
sys.modules["workflow_engine"] = mod
spec.loader.exec_module(mod)
cloud = sys.modules["wf_cloud"]
real = cloud._cloud_write_bytes
def write(path, data):  # the eviction's rewrite of the log lands, then the process dies before base.json
    real(path, data)
    if str(path).endswith("/works/events.jsonl"):
        os._exit(9)
cloud._cloud_write_bytes = write
sys.exit(mod.main(sys.argv[1:]))
PY
) >> "$CO_OUT" 2>&1; co_rc3=$?
co_m=$(co_mark); co "$COA" agenda-add --title after --author person:smoke >/dev/null; co_rc4=$?; co_r=$(co_check "$COA/.sikstack" "$co_m" once "$COW/pending.txt")
[ "$co_rc" = 0 ] && [ "$co_rc2" = 1 ] && [ "$co_np" -ge 1 ] && [ "$co_rc3" = 9 ] && [ "$co_rc4" = 0 ] && [ "$co_r" = ok ] \
  && ok "event lines appended after eviction reach sikstack once: a lost answer keeps them on disk until the resend lands, a stop between the log's rewrite and base.json re-sends nothing, and the disk's log is empty after ($co_np pending line(s) checked)" \
  || bad "the event log lost or doubled a line across eviction -- rc=$co_rc/$co_rc2/$co_rc3/$co_rc4 pending=$co_np $co_r"
# (f) a fresh join takes the working set only (C5); sync lists nothing there.
co_m=$(co_mark); printf '%s\n' "$COK" | co "$COB" link "$COU" > "$COW/f.txt"; co_rc=$?; co_r=$(co_check "$COB/.sikstack" "$co_m" joined)
co "$COB" sync > "$COW/f2.txt"; co_rc2=$?; co "$COB" sync --status > "$COW/f3.txt"
[ "$co_rc" = 0 ] && [ "$co_r" = ok ] && grep -q "^linked: joined sikstack's workspace" "$COW/f.txt" && [ -f "$COB/.sikstack/docs/current/product.md" ] \
  && [ "$co_rc2" = 0 ] && grep -qE ' here=0 differ=0 ' "$COW/f3.txt" \
  && ok "a fresh join writes no cold path to disk (the working set only; the archived phase.json files the agenda's links need are read into .sikstack/cache/), and sync and sync --status there list nothing" \
  || bad "the fresh join pulled the cold set -- rc=$co_rc/$co_rc2 $co_r / $(tail -2 "$COW/f.txt") / $(cat "$COW/f3.txt")"
# (g) unlink restores every cold file byte-equal to sikstack's (C6). First a change in sikstack after B's join.
co "$COA" agenda-add --title "after the join" --author person:smoke >/dev/null
co "$COA" unlink > "$COW/g.txt"; co_rc=$?; co_r=$(co_check "$COA/.sikstack" 0 restored)
( cd "$COA" && python3 "$ENG" check --no-rebuild ) > "$COW/g2.txt" 2>&1; co_rc2=$?
[ "$co_rc" = 0 ] && [ "${co_r%% *}" = ok ] && grep -q '^restored [0-9]* cold file(s) from sikstack' "$COW/g.txt" && [ "$co_rc2" = 0 ] \
  && ok "unlink restores every cold file byte-equal to sikstack's copy (${co_r#ok } files) and its whole event log, and the tree validates" \
  || bad "unlink did not restore the cold set -- rc=$co_rc/$co_rc2 $co_r / $(head -3 "$COW/g.txt") / $(tail -2 "$COW/g2.txt")"
# co_fromdisk <workflow dir> <its --from-disk output> <mark> <cache|cleared>: what unlink --from-disk left and printed.
# No request since the mark; every cold file sikstack holds is either back on disk at sikstack's bytes (only from the
# checkout's cache: with `cache`, exactly the archived phase.json files, one per archived folder; with `cleared`,
# none) or absent and still live in sikstack; an archived folder with a file absent holds HELD_IN_SIKSTACK.md naming
# exactly those files and its phase id, and no other folder holds one; each line printed states those counts; no
# line names link (a re-link is no way back); the last line's commit command is printed for the caller to follow.
co_fromdisk() { python3 - "$COW/fake/requests.jsonl" "$COS" "$@" <<'PY'
import base64, collections, http.client, json, re, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, out, mark, mode = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4], int(sys.argv[5]), sys.argv[6]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    return json.loads(conn.getresponse().read())
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
R = (Path(log).read_text().splitlines() if Path(log).exists() else [])[mark:]
need(not R, f"{len(R)} request(s) since the mark, first {R[:1]}")
live = {p: f for p, f in get("/_fake/state")["files"].items() if not f["deleted"]}
ARCH, TOPS = "works/phases/archived/", ("works/phases/archived/", "docs/versions/", "docs/reference/")
cold = sorted(p for p in live if p.startswith(TOPS) or p == "docs/index.json")
back = [p for p in cold if (root / p).is_file()]
miss = [p for p in cold if not (root / p).is_file()]
for p in back:
    need((root / p).read_bytes() == base64.b64decode(get("/_fake/file?path=" + quote(p))["content"]), f"{p}: not sikstack's bytes")
folders = sorted({p[len(ARCH):].split("/", 1)[0] for p in cold if p.startswith(ARCH)})
if mode == "cache":
    need(len(folders) >= 3 and back == [f"{ARCH}{n}/phase.json" for n in folders], f"not every archived phase.json came back from the cache: {back}")
else:
    need(not back, f"a cold file came back with the cache cleared: {back[:3]}")
need(len(miss) >= 5, f"too few cold files left in sikstack only: {miss}")
def counts(ps):
    c = collections.Counter(next((t for t in TOPS if p.startswith(t)), p) for p in ps)
    return ", ".join(f"{t} {n}" for t, n in sorted(c.items()))
lines = Path(out).read_text().splitlines()
marked = 0
for name in folders:
    gone = sorted(p[len(ARCH) + len(name) + 1:] for p in miss if p.startswith(f"{ARCH}{name}/"))
    marker = root / ARCH / name / "HELD_IN_SIKSTACK.md"
    if not gone:
        need(not marker.exists(), f"{name}: a marker in a folder with nothing missing")
        continue
    need(marker.is_file(), f"{name}: no HELD_IN_SIKSTACK.md, {len(gone)} file(s) missing")
    text = marker.read_text()
    listed = sorted(l[2:].strip("`") for l in text.splitlines() if l.startswith("- "))
    pid = re.search(r"_(P[0-9]+(?:-[0-9a-z]{2})?)_", name).group(1)
    need(listed == gone and pid in text, f"{name}: the marker lists {listed[:3]}, missing {gone[:3]}, or lacks {pid}")
    marked += 1
want = [f"cannot restore offline: {len(miss)} cold file(s) held only in sikstack ({counts(miss)}); they stay there",
        f"kept {marked} archived phase folder(s) with HELD_IN_SIKSTACK.md naming the files held only in sikstack, so "
        "their phase ids are never minted again"]
if back:
    want.append(f"restored {len(back)} cold file(s) from this checkout's cache, at sikstack's bytes ({counts(back)})")
for w in want:
    need([l for l in lines if l.startswith(w)], f"no line starting {w!r}: {lines}")
need(not [l for l in lines if l.startswith("restored ")] or back, "a restored line with nothing restored")
need(not [l for l in lines if re.search(r"\blink\b", l)], f"a line names link: {[l for l in lines if re.search(r'link', l)]}")
first = re.fullmatch(r"unlinked from the disk, offline: changes made in sikstack after r([0-9]+) are not on this disk", lines[0])
need(first is not None, f"the first line: {lines[0]}")
later = [p for p, f in live.items() if f["rev"] > int(first.group(1)) and not p.startswith(TOPS) and p != "works/events.jsonl"]
need(mode == "cleared" or later, f"no change in sikstack after r{first.group(1)} to check the first line against")
for p in later:
    need(not (root / p).is_file() or (root / p).read_bytes() != base64.b64decode(get("/_fake/file?path=" + quote(p))["content"]),
         f"{p}: changed in sikstack after r{first.group(1)}, and on this disk at those bytes")
if "cannot restore offline: works/events.jsonl holds only the lines never sent; the sent ones are in sikstack" in lines:
    sent = set(base64.b64decode(get("/_fake/file?path=works/events.jsonl")["content"]).decode().splitlines())
    here = (root / "works/events.jsonl").read_text().splitlines() if (root / "works/events.jsonl").exists() else []
    need(sent and not sent & set(here), "the event log line is not true: a sent line is on disk, or sikstack holds none")
hint = re.fullmatch(r"local mode: the files on disk are the truth again; commit them \((git -C \S+ add -A && git -C \S+ commit)\)", lines[-1])
need(hint is not None, f"the last line is not the commit line: {lines[-1]}")
print(f"ok {len(back)} {len(miss)} {marked} {hint.group(1)}")
PY
}
# co_follow <host> <co_fromdisk's ok line>: follow the commit line exactly as printed (a message added); the
# workflow repo is then clean.
co_follow() { local hint="${2#ok * * * }"; [ "${2%% *}" = ok ] && ( cd "$1" && eval "$hint -qm 'local mode again'" ) >> "$CO_OUT" 2>&1 \
  && [ -z "$(git -C "$1/.sikstack" status --porcelain --untracked-files=all)" ]; }
# (h) unlink --from-disk, offline, with the cache as the join and its reads left it: every cached archived phase.json
# goes back to its own path, so the archived ids stay spent and their links count; each line it prints is true when
# followed; a later local phase leaves every line true.
co_ctl '{"offline": true}'; co_m=$(co_mark); co "$COB" unlink --from-disk > "$COW/h.txt"; co_rc=$?; co_ctl '{"offline": false}'
co_r=$(co_fromdisk "$COB/.sikstack" "$COW/h.txt" "$co_m" cache); co_follow "$COB" "$co_r"; co_rc2=$?
( cd "$COB" && python3 "$ENG" check ) > "$COW/h2.txt" 2>&1; co_rc3=$?
( cd "$COB" && python3 "$ENG" phase new --name Four --objective toy ) > "$COW/h3.txt" 2>&1; co_rc4=$?
co_miss=$(cd "$COB/.sikstack" && ls -d works/phases/archived/*_P1_* | head -1)
co_m=$(co_mark); ( cd "$COB" && python3 "$ENG" cold fetch "$co_miss/phase.md" ) > "$COW/h4.txt" 2>&1; co_rc5=$?
co_r2=$(co_fromdisk "$COB/.sikstack" "$COW/h.txt" "$co_m" cache)
[ "$co_rc" = 0 ] && [ "${co_r%% *}" = ok ] && [ "$co_rc2" = 0 ] && [ "$co_rc3" = 0 ] \
  && grep -q '^warning: 3 archived phase folder(s) hold HELD_IN_SIKSTACK.md' "$COW/h2.txt" \
  && [ "$co_rc4" = 0 ] && grep -qE '^created phase P4-[0-9a-z]{2}' "$COW/h3.txt" \
  && [ "$co_rc5" = 1 ] && grep -q 'not on disk (local mode reads only this disk' "$COW/h4.txt" && [ "${co_r2%% *}" = ok ] \
  && ok "unlink --from-disk offline (the cache as the join left it) sends nothing, writes each archived phase.json back from the cache at sikstack's bytes, keeps HELD_IN_SIKSTACK.md in each archived folder naming exactly the files only sikstack holds, and names no re-link; its commit line, followed, leaves the workflow repo clean, check passes with one warning, phase new mints P4 (P1-P3 are archived), and after that the cold files are still in sikstack only and cold fetch asks nothing ($co_r)" \
  || bad "unlink --from-disk left a broken local workspace -- rc=$co_rc/$co_rc2/$co_rc3/$co_rc4/$co_rc5 [$co_r] [$co_r2] / $(tr '\n' '|' < "$COW/h.txt") / $(tail -2 "$COW/h2.txt" | tr '\n' '|') / $(head -1 "$COW/h3.txt") / $(cat "$COW/h4.txt")"
# (i) the same with the cache cleared first: nothing comes back, each archived folder stays by the base's name with
# only its marker, and a clone of the committed workflow repo never mints an archived number either.
COC="$COW/c"; co_install "$COC"
printf '%s\n' "$COK" | co "$COC" link "$COU" > "$COW/i.txt"; co_rc=$?; co "$COC" cold clear >> "$COW/i.txt"
co_ctl '{"offline": true}'; co_m=$(co_mark); co "$COC" unlink --from-disk > "$COW/i2.txt"; co_rc2=$?; co_ctl '{"offline": false}'
co_r=$(co_fromdisk "$COC/.sikstack" "$COW/i2.txt" "$co_m" cleared); co_follow "$COC" "$co_r"; co_rc3=$?
co_held=$(find "$COC/.sikstack/works/phases/archived" -type f | sed 's|.*/||' | sort | uniq -c | awk '{print $1 " " $2}' | tr '\n' ',')
co_cl="$COW/clone"; { mkdir -p "$co_cl" && git -C "$co_cl" init -q && git -C "$co_cl" commit -q --allow-empty -m start \
  && git clone -q "$COC/.sikstack" "$co_cl/.sikstack"; } >> "$CO_OUT" 2>&1
( cd "$co_cl" && python3 "$ENG" phase new --name Four --objective toy ) > "$COW/i3.txt" 2>&1; co_rc4=$?
( cd "$COC" && python3 "$ENG" phase new --name Four --objective toy ) > "$COW/i4.txt" 2>&1; co_rc5=$?
co_m=$(co_mark); ( cd "$COC" && python3 "$ENG" cold fetch 1 ) > "$COW/i5.txt" 2>&1; co_rc6=$?; co_m2=$(co_mark)
[ "$co_rc" = 0 ] && [ "$co_rc2" = 0 ] && [ "${co_r%% *}" = ok ] && [ "$co_rc3" = 0 ] && [ "$co_held" = "3 HELD_IN_SIKSTACK.md," ] \
  && [ "$co_rc4" = 0 ] && grep -qE '^created phase P4-[0-9a-z]{2}' "$COW/i3.txt" && [ "$co_rc5" = 0 ] && grep -qE '^created phase P4-[0-9a-z]{2}' "$COW/i4.txt" \
  && [ "$co_rc6" = 0 ] && [ "$co_m" = "$co_m2" ] && grep -qE '/works/phases/archived/[^/]+_P1_[^/]+$' "$COW/i5.txt" \
  && grep -q '^cold fetch: on disk with only HELD_IN_SIKSTACK.md: unlink --from-disk left the files it names in sikstack only' "$COW/i5.txt" \
  && ok "unlink --from-disk offline after cold clear writes no record it does not hold, keeps each archived folder by the base's name with only HELD_IN_SIKSTACK.md in it, and phase new mints P4 there and in a clone of the committed workflow repo; cold fetch 1 there prints the kept folder and says only its note is on disk, asking nothing ($co_r)" \
  || bad "an archived id is not spent after cold clear and unlink --from-disk -- rc=$co_rc/$co_rc2/$co_rc3/$co_rc4/$co_rc5/$co_rc6 held=$co_held $(tr '\n' '|' < "$COW/i5.txt") [$co_r] / $(tr '\n' '|' < "$COW/i2.txt") / $(head -2 "$COW/i3.txt") / $(head -2 "$COW/i4.txt")"
if grep -rqF "$COK" "$COA" "$COB" "$COC" "$CO_OUT" "$COW/fake" 2>/dev/null; then bad "the workspace key leaked into a tree, the output or the request log"; fi
kill "$CO_PID" 2>/dev/null; wait "$CO_PID" 2>/dev/null
echo "cold test runtime: $(( $(date +%s) - co_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 35: the cold reads in cloud mode, against the local fake sikstack -- with every archived phase, doc version and the event log evicted, agenda and agenda-show still count an archived phase's link; section and phase scope of an evicted phase print what they did on disk; the next phase number is never an evicted one's; agenda-delete rewrites an evicted phase.json in sikstack and leaves it off the disk; meter reads the whole log; cold fetch / status / clear / search work, a tampered cached copy is fetched again, and cold search finds the same line in local mode; after unlink --from-disk, agenda and agenda-show print what a full unlink prints =="
cr_t0=$(date +%s)
newtmp CRW; CRX="$CRW/xdg"; CRH="$CRW/h"; CR_OUT="$CRW/out.txt"; : > "$CR_OUT"; CRS_=""
cr() { ( cd "$CRH" && XDG_CONFIG_HOME="$CRX" python3 "$(wf_entry "$1")" "$@" ) 2>&1 | tee -a "$CR_OUT"; return "${PIPESTATUS[0]}"; }
CRA="$CRH/.sikstack"
# Local mode: A1 linked by P1 and A2 by P2, both archived (P2, the highest number, with a slice, its result.md, a
# topic and the meter's events); two versions of a doc, docs/index.json, a docs/reference file and a .gitignore * cache.
{ mkhost "$CRH" && git -C "$CRA" config user.email smoke@example.invalid && git -C "$CRA" config user.name smoke \
  && cr agenda-add --id A1-aa --title "kept item" --author person:smoke && cr agenda-add --id A2-bb --title "item to delete" --author person:smoke \
  && cr phase new --phase P1 --name "Phase one" --objective first --agenda A1-aa && cr phase archive P1 --force \
  && cr phase new --phase P2 --name "Phase two" --objective second --agenda A2-bb \
  && cr slice new --phase P2 --slice P2.S1 --name probe --kind implementation --risk low \
  && mkdir -p "$CRA/works/phases/active/P2/topics" "$CRA/docs/versions/product" "$CRA/docs/reference/cache" \
  && printf '# P2.S1\n\n- status: done\n- summary: probe\n\nThe quick COLD fox jumped over the archived dog.\n' > "$CRA/works/phases/active/P2/slices/P2.S1/result.md" \
  && printf '# a topic\n\n## One\n\nan agent wrote this\n' > "$CRA/works/phases/active/P2/topics/note.md" \
  && python3 - "$CRA" "$CRW/projects/-fixture" <<'PY'
import json, os, sys
root, proj = sys.argv[1], sys.argv[2]
with open(os.path.join(root, "works", "events.jsonl"), "a") as f:
    for ts, old, new in (("2026-01-01T10:00:00+00:00", "todo", "in_progress"), ("2026-01-01T11:00:00+00:00", "in_progress", "done")):
        f.write(json.dumps({"ts": ts, "type": "slice_status_changed", "slice": "P2.S1", "old_status": old, "new_status": new}) + "\n")
os.makedirs(proj)
rows = [{"type": "user", "timestamp": "2026-01-01T10:29:00.000Z", "message": {"role": "user", "content": "go"}},
        {"type": "assistant", "timestamp": "2026-01-01T10:30:00.000Z", "message": {"id": "m1", "model": "claude-opus-5-5", "content": [],
         "stop_reason": "end_turn", "usage": {"input_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 50}}}]
open(os.path.join(proj, "sess1.jsonl"), "w").write("".join(json.dumps(r) + "\n" for r in rows))
PY
  } > "$CRW/setup.txt" 2>&1 && cr phase archive P2 --force > "$CRW/setup2.txt" 2>&1 \
  && { printf '# product v0001\n' > "$CRA/docs/versions/product/v0001_first.md"; printf '# product v0002 cold\n' > "$CRA/docs/versions/product/v0002_cold.md"
       printf '{"docs": {"product": {"latest": "v0002_cold", "current_path": "docs/current/product.md", "versions": [{"id": "v0001_first", "path": "docs/versions/product/v0001_first.md"}, {"id": "v0002_cold", "path": "docs/versions/product/v0002_cold.md"}]}}}\n' > "$CRA/docs/index.json"
       printf 'reference one\n' > "$CRA/docs/reference/one.md"; printf '*\n' > "$CRA/docs/reference/cache/.gitignore"; printf 'a local cache\n' > "$CRA/docs/reference/cache/blob.txt"; } \
  || bad "cold reads probe: the setup failed -- $(tail -3 "$CRW/setup.txt") $(cat "$CRW/setup2.txt" 2>/dev/null)"
# cr_reads <tag>: the reads C1 and C2 compare, each command's output and exit in <tag>.<n>.txt.
cr_reads() { local i=0 c; for c in "agenda" "agenda-show A1" "agenda-show A2" "section P2" "section P2 Objective" "section P2 --topic note" "section P1 Now" "phase scope P2" "check --no-rebuild"; do
  i=$((i + 1)); # shellcheck disable=SC2086
  cr $c > "$CRW/$1.$i.txt"; echo "exit=$?" >> "$CRW/$1.$i.txt"; done; }
cr_same() { local i bad=""; for i in 1 2 3 4 5 6 7 8 9; do cmp -s "$CRW/$1.$i.txt" "$CRW/$2.$i.txt" || bad="$bad [$i: $(diff "$CRW/$1.$i.txt" "$CRW/$2.$i.txt" | head -4 | tr '\n' ' ')]"; done; printf '%s' "$bad"; }
cr_reads local
cr meter --phase P2 --json --transcripts "$CRW/projects/-fixture" > "$CRW/meter.local.json"; cr_mrc=$?
cr cold search "quick cold fox" > "$CRW/search.local.txt"; cr_src=$?
git -C "$CRA" add -A >/dev/null 2>&1; git -C "$CRA" commit -qm setup >/dev/null 2>&1
[ "$(grep -c '(1 of 1 phase done)' "$CRW/local.1.txt")" = 2 ] || bad "cold reads probe: the local agenda does not count both archived links -- $(head -5 "$CRW/local.1.txt")"
[ "$cr_mrc" = 0 ] && [ "$cr_src" = 0 ] && grep -q 'result.md:6: \[P2\] The quick COLD fox' "$CRW/search.local.txt" \
  && ok "cold search in local mode scans the disk by sikstack's rules: an archived result.md's line, its path, line and phase ($(head -1 "$CRW/search.local.txt" | cut -c1-60)...)" \
  || bad "cold search in local mode wrong -- rc=$cr_mrc/$cr_src $(cat "$CRW/search.local.txt")"
# The link: everything goes up, then the cold set leaves the disk.
CRK="cold-reads-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$CRK" > "$CRW/key"; chmod 600 "$CRW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$CRW/fake" --port-file "$CRW/port" --key-file "$CRW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$CRW/fake.txt" 2>&1 &
CR_PID=$!
for _ in $(seq 1 100); do [ -s "$CRW/port" ] && break; sleep 0.1; done
CRS_="http://127.0.0.1:$(cat "$CRW/port" 2>/dev/null)"
cr_mark() { if [ -f "$CRW/fake/requests.jsonl" ]; then grep -c '' "$CRW/fake/requests.jsonl"; else echo 0; fi; }
# cr_unexclude: the exclude a checkout linked before 0.4.0 holds (link wrote /.hi2vi/ only): its /cache/ line removed.
# cr_excl: the exclude's /cache/ and /.hi2vi/ line counts and its sha256.
CR_EXCL="$CRA/.git/info/exclude"
cr_unexclude() { python3 - "$CR_EXCL" <<'PY'
import sys
p = sys.argv[1]
kept = [l for l in open(p).read().splitlines(True) if l.strip() not in ("/cache/", "cache/", "/cache", "cache")]
open(p, "w").write("".join(kept))
PY
}
cr_excl() { printf '%s %s %s' "$(grep -cxF '/cache/' "$CR_EXCL")" "$(grep -cxF '/.hi2vi/' "$CR_EXCL")" "$(sha "$CR_EXCL")"; }
# cr_py <check> [args]: one named assertion over the fake (its records and the requests since a mark) and the checkout.
cr_py() { python3 - "$CRW/fake/requests.jsonl" "$CRS_" "$CRA" "$@" <<'PY'
import base64, hashlib, http.client, json, os, stat, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), sys.argv[4], sys.argv[5:]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    return json.loads(conn.getresponse().read())
S = get("/_fake/state")
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
def cloud(p):
    return base64.b64decode(get("/_fake/file?path=" + quote(p))["content"])
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
def since(mark):
    lines = Path(log).read_text().splitlines() if Path(log).exists() else []
    return [json.loads(l) for l in lines[int(mark):]]
arch = lambda pid: sorted(p for p in live if p.startswith("works/phases/archived/") and f"_{pid}_" in p)
if check == "thin":  # every archived file, doc version, docs/index.json and docs/reference file is off the disk
    cold = [p for p in live if p.startswith(("works/phases/archived/", "docs/versions/", "docs/reference/")) or p == "docs/index.json"]
    need(len(cold) >= 12, f"too few cold records in sikstack: {len(cold)}")
    need(not [p for p in cold if (root / p).exists()], f"cold files left on disk: {[p for p in cold if (root / p).exists()][:3]}")
    need((root / "docs/reference/cache/blob.txt").is_file(), "the .gitignore * cache left the disk")
    need((root / "works/events.jsonl").read_bytes() == b"", "the event log on disk is not thin")
    print(f"ok {len(cold)}")
    sys.exit(0)
elif check == "rev":  # extra: phase id; the rev of its archived phase.json
    print(live[[p for p in arch(extra[0]) if p.endswith("/phase.json")][0]]["rev"])
    sys.exit(0)
elif check == "folder":  # extra: printed folder, phase id: the cache copy is sikstack's folder, byte for byte, read-only
    folder, pid = Path(extra[0]), extra[1]
    files = arch(pid)
    prefix = files[0].split("/")[3]
    need(str(folder).endswith("/.sikstack/cache/works/phases/archived/" + prefix), f"not the cache folder: {folder}")
    got = sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file())
    want = sorted(p.split("/", 4)[4] for p in files)
    need(got == want, f"the cache folder holds {got}, sikstack {want}")
    for p in files:
        here = folder / p.split("/", 4)[4]
        need(here.read_bytes() == cloud(p), f"{p}: the cache copy differs from sikstack's")
        need(not (here.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH)), f"{p}: the cache copy is writable")
    print(f"ok {len(files)}")
    sys.exit(0)
elif check == "file":  # extra: printed path, record path: the cache copy equals sikstack's record
    need(extra[0].endswith("/.sikstack/cache/" + extra[1]) and Path(extra[0]).read_bytes() == cloud(extra[1]),
         f"{extra[0]} is not sikstack's {extra[1]}")
elif check == "refetched":  # extra: mark, cache path, record path: fetched again since mark, now sikstack's bytes
    asked = [p for r in since(extra[0]) if r["path"].endswith("/fetch") for p in r.get("paths") or []]
    need(extra[2] in asked, f"{extra[2]} was not fetched again: {asked[:4]}")
    need(Path(extra[1]).read_bytes() == cloud(extra[2]), "the cache copy is not sikstack's bytes")
elif check == "deleted":  # extra: the rev before: P2's phase.json lost its link in sikstack, at a new rev, off the disk
    p = [x for x in arch("P2") if x.endswith("/phase.json")][0]
    data = json.loads(cloud(p))
    need("agenda" not in data and data.get("id") == "P2", f"sikstack's P2 phase.json still links: {data.get('agenda')}")
    need(live[p]["rev"] > int(extra[0]), f"P2's phase.json rev did not move: {live[p]['rev']}")
    need(not (root / p).exists() and not list((root / "works/phases").glob("archived/*_P2_*")), "P2's archived folder is on disk after the command")
    base = json.loads((root / ".hi2vi/base.json").read_text())
    need(base["files"][p]["sha256"] == live[p]["sha256"] and not (root / ".hi2vi/journal.json").exists(), "the base does not hold the new P2 phase.json")
    puts = [op for r in since(extra[1]) if r["path"].endswith("/commit") for op in r["batch"]["ops"] if op.get("path") == p]
    need(puts and puts[0]["op"] == "put" and puts[0]["base_rev"] == int(extra[0]), f"not a put on the base's rev: {puts}")
print("ok")
PY
}
cr_m=$(cr_mark); printf '%s\n' "$CRK" | cr link "$CRS_/projects/proj-1" > "$CRW/link.txt"; cr_rc=$?; cr_r=$(cr_py thin)
[ "$cr_rc" = 0 ] && [ "${cr_r%% *}" = ok ] || bad "cold reads probe: the link did not thin the disk -- rc=$cr_rc $cr_r / $(tail -3 "$CRW/link.txt")"
# C8: meter reads sikstack's log and the evicted slice through the cache, and prints what local mode printed.
cr meter --phase P2 --json --transcripts "$CRW/projects/-fixture" > "$CRW/meter.cloud.json"; cr_rc=$?
[ "$cr_rc" = 0 ] && cmp -s "$CRW/meter.local.json" "$CRW/meter.cloud.json" && grep -q '"P2.S1"' "$CRW/meter.cloud.json" \
  && ok "meter --phase in cloud mode, with the event log and the archived phase off the disk, prints exactly what local mode printed (the same slice rows, its main thread attributed by the log's window)" \
  || bad "meter in cloud mode differs from local mode -- rc=$cr_rc $(diff "$CRW/meter.local.json" "$CRW/meter.cloud.json" | head -6 | tr '\n' ' ')"
# C1, C2: the reads print what they printed on disk.
cr_reads cloud; cr_d=$(cr_same local cloud)
[ -z "$cr_d" ] \
  && ok "with every archived phase evicted: agenda still counts each item's archived link ($(grep -c '(1 of 1 phase done)' "$CRW/cloud.1.txt") items at 1 of 1 phase done), agenda-show lists them, section (index, a section, a topic) and phase scope of an evicted phase and check print exactly what they printed on disk" \
  || bad "a read of an evicted phase differs from the disk's --$cr_d"
# C6: a tampered cached copy is never read: it is fetched again (a link holder and a section's folder).
cr_p1=$(ls "$CRA"/cache/works/phases/archived/*_P1_*/phase.json 2>/dev/null | head -1); cr_p2=$(ls "$CRA"/cache/works/phases/archived/*_P2_*/phase.md 2>/dev/null | head -1)
chmod u+w "$cr_p1" "$cr_p2" 2>/dev/null; printf '{"id": "P1", "agenda": "A9-zz"}\n' > "$cr_p1"; printf '## Objective\n\ntampered\n' > "$cr_p2"
cr_m=$(cr_mark); cr agenda > "$CRW/t1.txt"; echo "exit=$?" >> "$CRW/t1.txt"; cr section P2 Objective > "$CRW/t2.txt"; echo "exit=$?" >> "$CRW/t2.txt"
cr_r1=$(cr_py refetched "$cr_m" "$cr_p1" "${cr_p1#"$CRA"/cache/}"); cr_r2=$(cr_py refetched "$cr_m" "$cr_p2" "${cr_p2#"$CRA"/cache/}")
[ -n "$cr_p1" ] && [ -n "$cr_p2" ] && cmp -s "$CRW/local.1.txt" "$CRW/t1.txt" && cmp -s "$CRW/local.5.txt" "$CRW/t2.txt" && [ "$cr_r1" = ok ] && [ "$cr_r2" = ok ] \
  && ok "a tampered cached copy (a link holder's phase.json, an evicted phase.md) is never read: the layer fetches it again, checks it against the base, and agenda and section print what the disk printed" \
  || bad "a tampered cache copy was read -- $cr_r1 / $cr_r2 / $(diff "$CRW/local.1.txt" "$CRW/t1.txt" | head -3 | tr '\n' ' ') / $(diff "$CRW/local.5.txt" "$CRW/t2.txt" | head -3 | tr '\n' ' ')"
# C7: cold search finds the same line through sikstack's search route.
cr_m=$(cr_mark); cr cold search "quick cold fox" > "$CRW/search.cloud.txt"; cr_rc=$?
cr_searched=$(tail -n +"$((cr_m + 1))" "$CRW/fake/requests.jsonl" | grep -c '"/api/workspace/proj-1/search"')
[ "$cr_rc" = 0 ] && cmp -s "$CRW/search.local.txt" "$CRW/search.cloud.txt" && [ "$cr_searched" = 1 ] \
  && ok "cold search in cloud mode asks sikstack's search route once and prints the evicted result.md's line exactly as local mode found it on disk (path, line, [P2], snippet)" \
  || bad "cold search in cloud mode wrong -- rc=$cr_rc searched=$cr_searched $(cat "$CRW/search.cloud.txt")"
cr cold search "a" > "$CRW/s2.txt" 2>&1; cr_rc=$?; cr cold search "phase" --limit 1 > "$CRW/s3.txt"; cr_rc2=$?
[ "$cr_rc" = 1 ] && grep -q '2 to 200 characters' "$CRW/s2.txt" && [ "$cr_rc2" = 0 ] && [ "$(grep -c '' "$CRW/s3.txt")" = 2 ] && grep -q '^truncated: the first 1 hit' "$CRW/s3.txt" \
  && ok "cold search refuses a one-character text in one line, and a cut answer ends with its truncated line" \
  || bad "cold search's refusal or truncated line wrong -- rc=$cr_rc/$cr_rc2 $(cat "$CRW/s2.txt" "$CRW/s3.txt")"
# C5: cold fetch, status and clear.
cr cold clear > /dev/null; cr_unexclude; cr_x0="$(grep -cxF '/cache/' "$CR_EXCL") $(grep -cxF '/.hi2vi/' "$CR_EXCL")"
cr cold fetch 2 > "$CRW/f1.txt"; cr_rc=$?; cr_r=$(cr_py folder "$(head -1 "$CRW/f1.txt")" P2)
cr_x1=$(cr_excl); cr_st=$(git -C "$CRA" status --porcelain --untracked-files=all | grep 'cache')
[ "$cr_x0" = "0 1" ] && [ "${cr_x1%% *}" = 1 ] && [ "$(echo "$cr_x1" | cut -d' ' -f2)" = 1 ] && [ -z "$cr_st" ] && [ -n "$(find "$CRA/cache" -type f 2>/dev/null)" ] \
  && ok "a checkout linked before the exclude named /cache/ (link wrote /.hi2vi/ only): its first cold fetch writes the cache and the exclude's one /cache/ line with it, so git status --untracked-files=all shows no cache path" \
  || bad "cold fetch left the cache visible to git on a pre-0.4.0 link -- before=$cr_x0 after=[$cr_x1] status=[$(echo "$cr_st" | head -3 | tr '\n' ' ')]"
cr cold fetch 2 > /dev/null; cr_x2=$(cr_excl); cr init > "$CRW/reinit.txt"; cr_rc4=$?; cr_x3=$(cr_excl)
[ "$cr_x2" = "$cr_x1" ] && [ "$cr_x3" = "$cr_x1" ] && [ "$cr_rc4" = 0 ] \
  && ok "idempotent: a second cold fetch and a fresh init leave the exclude byte-equal, one /cache/ and one /.hi2vi/ line" \
  || bad "the exclude changed on a second command or init -- [$cr_x1] [$cr_x2] [$cr_x3] rc=$cr_rc4 $(tail -2 "$CRW/reinit.txt")"
cr cold fetch product@v0001 > "$CRW/f2.txt"; cr_rc2=$?; cr_r2=$(cr_py file "$(head -1 "$CRW/f2.txt")" docs/versions/product/v0001_first.md)
cr cold fetch product > "$CRW/f3.txt"; cr_rc3=$?; cr_r3=$(cr_py file "$(head -1 "$CRW/f3.txt")" docs/versions/product/v0002_cold.md)
[ "$cr_rc" = 0 ] && [ "${cr_r%% *}" = ok ] && grep -q '^cold fetch: [0-9]* file(s) under .sikstack/cache/, read-only' "$CRW/f1.txt" && [ "$cr_rc2" = 0 ] && [ "$cr_r2" = ok ] \
  && [ "$cr_rc3" = 0 ] && [ "$cr_r3" = ok ] && [ -z "$(git -C "$CRA" status --porcelain | grep 'cache')" ] \
  && ok "cold fetch 2 brings P2's whole archived folder into .sikstack/cache/ byte-equal to sikstack's and read-only (${cr_r#ok } files); product@v0001 brings that version and product the latest (through docs/index.json); git never sees the cache" \
  || bad "cold fetch wrong -- rc=$cr_rc/$cr_rc2/$cr_rc3 $cr_r / $cr_r2 / $cr_r3 / $(cat "$CRW/f1.txt" "$CRW/f2.txt" "$CRW/f3.txt" | tr '\n' ' ')"
# C9: every path cold fetch prints stays in the workspace. Another checkout writes docs/index.json in sikstack with
# version paths that leave docs/ (a relative escape, an absolute path): cold fetch of either doc, bare and @version,
# refuses in one line, exit 1, printing no path and caching nothing of it. With the good index back, product@v0001
# still fetches sikstack's bytes.
printf 'outside the workspace\n' > "$CRW/outside.txt"
cr_put() { python3 - "$CRS_" "$1" "$2" <<'PY'
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/write", json.dumps({"path": sys.argv[2], "content": open(sys.argv[3]).read()}), {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
python3 - "$CRS_" "$CRW" <<'PY'
import base64, http.client, json, os, sys
from urllib.parse import urlparse
u, w = urlparse(sys.argv[1]), sys.argv[2]
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("GET", "/_fake/file?path=docs/index.json")
good = base64.b64decode(json.loads(conn.getresponse().read())["content"])
open(os.path.join(w, "index.good.json"), "wb").write(good)
evil = json.loads(good)
evil["docs"]["evil"] = {"latest": "v1", "versions": [{"id": "v1", "path": "../../outside.txt"}]}
evil["docs"]["abs"] = {"latest": "v1", "versions": [{"id": "v1", "path": os.path.join(w, "outside.txt")}]}
open(os.path.join(w, "index.evil.json"), "w").write(json.dumps(evil) + "\n")
PY
cr cold clear > /dev/null; cr_put docs/index.json "$CRW/index.evil.json"; cr_d=""; cr_i=0
for t in evil evil@v1 abs abs@v1; do
  cr_i=$((cr_i + 1)); cr cold fetch "$t" > "$CRW/esc.$cr_i.txt" 2>&1; cr_rc=$?
  { [ "$cr_rc" = 1 ] && [ "$(grep -c '' "$CRW/esc.$cr_i.txt")" = 1 ] && grep -q 'refused, nothing was read' "$CRW/esc.$cr_i.txt" \
    && ! grep -q 'outside' "$CRW/esc.$cr_i.txt"; } || cr_d="$cr_d [$t: rc=$cr_rc $(tr '\n' '|' < "$CRW/esc.$cr_i.txt")]"
done
cr_left=$(find "$CRA/cache" -type f ! -path "$CRA/cache/docs/index.json" 2>/dev/null | head -3)
cr_put docs/index.json "$CRW/index.good.json"; cr cold fetch product@v0001 > "$CRW/f4.txt"; cr_rc=$?
cr_r=$(cr_py file "$(head -1 "$CRW/f4.txt")" docs/versions/product/v0001_first.md)
[ -z "$cr_d" ] && [ -z "$cr_left" ] && [ "$cr_rc" = 0 ] && [ "$cr_r" = ok ] \
  && ok "with docs/index.json in sikstack naming a version path that leaves the workspace (../../outside.txt, an absolute path), cold fetch of that doc, bare or @version, refuses in one line, exit 1, prints no path and caches nothing of it; with the good index back, product@v0001 fetches sikstack's bytes" \
  || bad "cold fetch followed an index path out of the workspace --$cr_d left=[$cr_left] good: rc=$cr_rc $cr_r $(tr '\n' '|' < "$CRW/f4.txt")"
printf 'new here\n' > "$CRA/docs/reference/new.md"
cr cold status > "$CRW/st.txt"; cr_rc=$?; cr cold clear > "$CRW/cl.txt"; cr_rc2=$?
[ "$cr_rc" = 0 ] && grep -qE '^works/phases/archived/ [0-9]+ in sikstack: [0-9]+ evicted, 0 on disk' "$CRW/st.txt" \
  && grep -qF '  docs/reference/cache/ 2 file(s), 16 B (.gitignore *: never synced)' "$CRW/st.txt" \
  && grep -qF '  docs/reference/new.md 1 file(s), 9 B (not in sikstack)' "$CRW/st.txt" && grep -qE '^cache: [1-9][0-9]* file' "$CRW/st.txt" \
  && [ "$cr_rc2" = 0 ] && grep -q '^cold clear: removed [1-9]' "$CRW/cl.txt" && [ -z "$(find "$CRA/cache" -type f 2>/dev/null)" ] \
  && ok "cold status lists the cold paths by prefix (evicted, on disk), the cache, a .gitignore * cache and a file sikstack lacks under docs/reference/; cold clear empties the cache" \
  || bad "cold status or clear wrong -- rc=$cr_rc/$cr_rc2 $(cat "$CRW/st.txt" "$CRW/cl.txt" | tr '\n' '|')"
# C3: the highest number was P2's, archived and evicted: the next phase is P3.
cr phase new --name Three --objective third > "$CRW/n.txt"; cr_rc=$?
[ "$cr_rc" = 0 ] && grep -qE 'P3-[0-9a-z]{2}' "$CRW/n.txt" \
  && ok "with P2 (the highest number) archived and evicted, phase new mints P3, never an evicted phase's number ($(grep -oE 'P[0-9]+-[0-9a-z]{2}' "$CRW/n.txt" | head -1))" \
  || bad "phase new reused an evicted number -- rc=$cr_rc $(cat "$CRW/n.txt")"
# The eviction's cache copy, alone: on a pre-0.4.0 link with an empty cache, archiving P3 moves it in sikstack and the
# eviction keeps its phase.json in the cache; git never sees it, and the exclude gains its one /cache/ line.
cr cold clear > /dev/null; cr_unexclude
cr phase archive P3 --force > "$CRW/a3.txt"; cr_rc=$?; cr_x=$(cr_excl); cr_st=$(git -C "$CRA" status --porcelain --untracked-files=all | grep 'cache')
cr_kept=$(ls "$CRA"/cache/works/phases/archived/*_P3-*/phase.json 2>/dev/null | head -1)
[ "$cr_rc" = 0 ] && [ -n "$cr_kept" ] && [ -z "$(ls -d "$CRA"/works/phases/archived/*_P3-* 2>/dev/null)" ] && [ "${cr_x%% *}" = 1 ] && [ -z "$cr_st" ] \
  && ok "a pre-0.4.0 link's first eviction: archiving P3 takes it off the disk, keeps its phase.json in the cache, and writes the exclude's one /cache/ line, so git status shows no cache path" \
  || bad "the eviction's cache copy is visible to git on a pre-0.4.0 link -- rc=$cr_rc kept=[$cr_kept] exclude=[$cr_x] status=[$(echo "$cr_st" | head -3 | tr '\n' ' ')] $(tail -2 "$CRW/a3.txt")"
# C4: agenda-delete of an item an evicted phase links: that phase.json is rewritten in sikstack, then off the disk.
cr_rev=$(cr_py rev P2); cr_m=$(cr_mark); cr agenda-delete A2 > "$CRW/del.txt"; cr_rc=$?; cr_r=$(cr_py deleted "$cr_rev" "$cr_m")
[ "$cr_rc" = 0 ] && grep -q '^deleted A2-bb: 1 link cleared' "$CRW/del.txt" && [ "$cr_r" = ok ] \
  && ok "agenda-delete of an item an evicted phase links rewrites that phase.json in sikstack (a put on the base's rev r$cr_rev, the agenda key gone) and the file is off the disk again after the command" \
  || bad "agenda-delete did not reach the evicted phase.json -- rc=$cr_rc $cr_r / $(cat "$CRW/del.txt")"
# An offline unlink keeps the evicted archive's agenda links: agenda and agenda-show print, byte for byte, what a full
# unlink of the same checkout prints (a twin copied before either ran).
cr_ctl() { python3 - "$CRS_" "$1" <<'PY'
import http.client, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", "/_fake/control", sys.argv[2], {"Content-Type": "application/json"})
assert conn.getresponse().status == 200
PY
}
cp -R "$CRH" "$CRW/twin"
tw() { ( cd "$CRW/twin" && XDG_CONFIG_HOME="$CRX" python3 "$ENG" "$@" ) 2>&1; }
tw unlink > "$CRW/u.full.txt"; cr_rc=$?
cr_ctl '{"offline": true}'; cr unlink --from-disk > "$CRW/u.disk.txt"; cr_rc2=$?; cr_ctl '{"offline": false}'
cr_d=""; cr_i=0
for c in "agenda" "agenda-show A1" "agenda-show A2"; do
  cr_i=$((cr_i + 1)); # shellcheck disable=SC2086
  tw $c > "$CRW/u.full.$cr_i.txt"; echo "exit=$?" >> "$CRW/u.full.$cr_i.txt"
  cr $c > "$CRW/u.disk.$cr_i.txt"; echo "exit=$?" >> "$CRW/u.disk.$cr_i.txt"
  cmp -s "$CRW/u.full.$cr_i.txt" "$CRW/u.disk.$cr_i.txt" || cr_d="$cr_d [$c: $(diff "$CRW/u.full.$cr_i.txt" "$CRW/u.disk.$cr_i.txt" | head -4 | tr '\n' ' ')]"
done
[ "$cr_rc" = 0 ] && [ "$cr_rc2" = 0 ] && [ -z "$cr_d" ] && grep -q '(1 of 1 phase done)' "$CRW/u.disk.1.txt" \
  && ok "after unlink --from-disk offline, agenda and agenda-show still count the evicted archived phase's link, byte-equal to a full unlink of the same checkout" \
  || bad "unlink --from-disk lost an archived agenda link -- rc=$cr_rc/$cr_rc2$cr_d / $(tr '\n' '|' < "$CRW/u.disk.txt")"
if grep -rqF "$CRK" "$CRH" "$CRW/twin" "$CR_OUT" "$CRW/fake" 2>/dev/null; then bad "the workspace key leaked into the tree, the output or the request log"; fi
kill "$CR_PID" 2>/dev/null; wait "$CR_PID" 2>/dev/null
# C10: local mode, the same rule on the disk. docs/index.json names version paths that leave docs/ (../../, a
# docs/versions/../../../../ walk, an absolute path) or name a file outside docs/versions/ (docs/current/x.md: a
# doc version is a docs/versions/ file); a version file, a doc folder and a docs/reference folder are symlinks out
# of the workspace, and docs/reference/ holds one. Every such cold fetch refuses in one line, exit 1, printing no
# path and writing nothing. A good version, a symlink that stays inside docs/ and the path form of docs/current/x.md
# still print their disk path.
CLH="$CRW/l"; CLA="$CLH/.sikstack"
cl() { ( cd "$CLH" && XDG_CONFIG_HOME="$CRX" python3 "$ENG" "$@" ) 2>&1; }
mkdir -p "$CRW/outdir"; printf 'outside dir\n' > "$CRW/outdir/v0001_far.md"
{ mkhost "$CLH" && mkdir -p "$CLA/docs/versions/product" "$CLA/docs/versions/link" "$CLA/docs/reference" \
  && printf '# product v0001\n' > "$CLA/docs/versions/product/v0001_one.md" && ln -s v0001_one.md "$CLA/docs/versions/product/v0002_alias.md" \
  && printf 'current x\n' > "$CLA/docs/current/x.md" && ln -s "$CRW/outside.txt" "$CLA/docs/versions/link/v0001_out.md" \
  && ln -s "$CRW/outdir" "$CLA/docs/versions/far" && ln -s "$CRW/outdir" "$CLA/docs/reference/out" \
  && python3 - "$CLA/docs/index.json" "$CRW/outside.txt" <<'PY'
import json, sys
v = lambda p: {"latest": "v1", "versions": [{"id": "v1", "path": p}]}
docs = {"product": {"latest": "v0001_one", "versions": [{"id": "v0001_one", "path": "docs/versions/product/v0001_one.md"},
                                                        {"id": "v0002_alias", "path": "docs/versions/product/v0002_alias.md"}]},
        "evil": v("../../outside.txt"), "walk": v("docs/versions/../../../../outside.txt"), "abs": v(sys.argv[2]),
        "cur": v("docs/current/x.md"), "lnk": v("docs/versions/link/v0001_out.md")}
open(sys.argv[1], "w").write(json.dumps({"docs": docs}) + "\n")
PY
  git -C "$CLA" add -A && git -C "$CLA" commit -qm setup; } > "$CRW/l.setup.txt" 2>&1 || bad "cold fetch containment probe: the setup failed -- $(tail -3 "$CRW/l.setup.txt")"
cl_x0=$(sha "$CLA/.git/info/exclude"); cl_d=""; cl_i=0
for t in evil evil@v1 walk abs abs@v1 cur cur@v1 lnk link far docs/versions/link/v0001_out.md docs/reference/out docs/reference docs/versions/far/v0001_far.md; do
  cl_i=$((cl_i + 1)); cl cold fetch "$t" > "$CRW/lesc.$cl_i.txt"; cl_rc=$?
  { [ "$cl_rc" = 1 ] && [ "$(grep -c '' "$CRW/lesc.$cl_i.txt")" = 1 ] && grep -q 'refused, nothing was read' "$CRW/lesc.$cl_i.txt" \
    && ! grep -q 'outside\|outdir' "$CRW/lesc.$cl_i.txt"; } || cl_d="$cl_d [$t: rc=$cl_rc $(tr '\n' '|' < "$CRW/lesc.$cl_i.txt")]"
done
cl_ok=""
for t in "product@v0001:docs/versions/product/v0001_one.md" "product:docs/versions/product/v0001_one.md" \
         "product@v0002:docs/versions/product/v0001_one.md" "docs/current/x.md:docs/current/x.md" "docs/versions/product:"; do
  cl cold fetch "${t%%:*}" > "$CRW/lok.txt"; cl_rc=$?; cl_p=$(head -1 "$CRW/lok.txt"); cl_want="${t#*:}"
  { [ "$cl_rc" = 0 ] && grep -q '^cold fetch: on disk' "$CRW/lok.txt" && case "$cl_p" in "$(cd "$CLA" && pwd -P)"/docs/*) true ;; *) false ;; esac \
    && { [ -z "$cl_want" ] || cmp -s "$cl_p" "$CLA/$cl_want"; }; } || cl_ok="$cl_ok [${t%%:*}: rc=$cl_rc $(tr '\n' '|' < "$CRW/lok.txt")]"
done
[ -z "$cl_d" ] && [ -z "$cl_ok" ] && [ ! -e "$CLA/cache" ] && [ -z "$(git -C "$CLA" status --porcelain)" ] && [ "$(sha "$CLA/.git/info/exclude")" = "$cl_x0" ] \
  && ok "local mode: cold fetch refuses, in one line with exit 1 and no path, every docs/index.json version path that leaves the workspace (../../, a docs/versions/../ walk, an absolute path) or docs/versions/ (docs/current/x.md), and every version file, doc folder or docs/ folder that is or holds a symlink out of the workspace; a good version, a symlink inside docs/ and docs/current/x.md by path still print their disk path, byte-equal; nothing was written, the exclude included" \
  || bad "cold fetch in local mode led out of the workspace --$cl_d$cl_ok cache=$([ -e "$CLA/cache" ] && echo yes) $(git -C "$CLA" status --porcelain | head -3 | tr '\n' ' ')"
echo "cold reads test runtime: $(( $(date +%s) - cr_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 24: the web's agenda inbox, applied by a linked engine against the local fake sikstack -- at next and sync, entries oldest first, each run in-process as its agenda command: exit 0 applied, each in a batch of its own with exactly the files its command wrote; a refusal's one line sent verbatim with exit 1, a usage error's with exit 2; a brief id refused unrun with nothing written; an entry another checkout applied first is a 409, its change dropped here and sikstack's copy pulled, never applied twice; a crash inside a command leaves the entry pending and the tree as it was; a delete clears its links in the same batch; the applier never deadlocks on .hi2vi/lock =="
ib_t0=$(date +%s)
newtmp IBW; IBX="$IBW/xdg"; IBA="$IBW/a"; IBL="$IBW/local"
# ib <host> <args>: one engine command in that host's nested workspace, with the scratch XDG, killed after 60 s
# (a deadlock on .hi2vi/lock would wait the lock's 120 s): exit 124 then.
ib() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$IBX" python3 - "$@" <<'PY'
import subprocess, sys
try:
    sys.exit(subprocess.run([sys.executable, __import__("os").environ["ENG"]] + sys.argv[1:], timeout=60).returncode)
except subprocess.TimeoutExpired:
    print("TIMEOUT after 60 s")
    sys.exit(124)
PY
) 2>&1; }
ib_install() { { mkhost "$1" \
  && git -C "$1/.sikstack" config user.email smoke@example.invalid && git -C "$1/.sikstack" config user.name smoke \
  && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m install; } > "$1.setup.txt" 2>&1 || bad "inbox probe: the install of $1 failed -- $(tail -3 "$1.setup.txt")"; }
ib_install "$IBA"; ib_install "$IBL"
# A's workspace before the link: two phases, both linked to A1-k2; an Open A2-m3 and A4-n5; a Proposed A5-p1.
{ ib "$IBA" phase new --phase P1 --name One --objective toy && ib "$IBA" agenda-add --id A1-k2 --title one --author person:smoke \
  && ib "$IBA" agenda-add --id A2-m3 --title two --author person:smoke && ib "$IBA" agenda-add --id A4-n5 --title four --author person:smoke \
  && ib "$IBA" agenda-add --id A5-p1 --title five --author agent:smoke \
  && ib "$IBA" agenda-link A1-k2 --phase P1 && ib "$IBA" phase new --phase P2 --name Two --objective toy --agenda A1-k2 \
  && git -C "$IBA/.sikstack" add -A && git -C "$IBA/.sikstack" commit -qm seed; } > "$IBW/seed.txt" 2>&1 || bad "inbox probe: the seed failed -- $(tail -3 "$IBW/seed.txt")"
IBK="inbox-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$IBK" > "$IBW/key"; chmod 600 "$IBW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$IBW/fake" --port-file "$IBW/port" --key-file "$IBW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$IBW/fake.txt" 2>&1 &
IB_PID=$!
for _ in $(seq 1 100); do [ -s "$IBW/port" ] && break; sleep 0.1; done
IBS="http://127.0.0.1:$(cat "$IBW/port" 2>/dev/null)"
printf '%s\n' "$IBK" | ( cd "$IBA" && XDG_CONFIG_HOME="$IBX" python3 "$ENG" link "$IBS/projects/proj-1" ) > "$IBW/link.txt" 2>&1 || bad "inbox probe: the link failed -- $(tail -2 "$IBW/link.txt")"
ib_mark() { if [ -f "$IBW/fake/requests.jsonl" ]; then grep -c '' "$IBW/fake/requests.jsonl"; else echo 0; fi; }
# ib_post <route> <json>: a test-only POST to the fake; prints the answer's id (an inbox entry's) when it has one.
ib_post() { python3 - "$IBS" "$1" "$2" <<'PY'
import http.client, json, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("POST", sys.argv[2], sys.argv[3], {"Content-Type": "application/json"})
resp = conn.getresponse()
assert resp.status == 200, resp.status
print(json.loads(resp.read()).get("id") or "")
PY
}
ib_web() { ib_post /_fake/inbox "$1"; }
# The workflow tree's sha list (.git and .hi2vi aside): what a refusal or an undone crash must leave equal.
ib_tree() { python3 - "$1" <<'PY'
import hashlib, os, sys
root, rows = sys.argv[1], []
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if not (d == root and x in (".git", ".hi2vi"))]
    for f in files:
        p = os.path.join(d, f)
        rows.append(f"{os.path.relpath(p, root)} {hashlib.sha256(open(p, 'rb').read()).hexdigest()}")
print("\n".join(sorted(rows)))
PY
}
# ib_check <mark> <check> [args]: one named assertion over the fake's requests since <mark>, its records and
# inbox, and A's base, journal and disk.
ib_check() { python3 - "$IBW/fake/requests.jsonl" "$IBS" "$IBA/.sikstack" "$@" <<'PY'
import base64, hashlib, http.client, json, sys
from pathlib import Path
from urllib.parse import urlparse, quote
log, server, root, mark, check, extra = sys.argv[1], sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]), sys.argv[5], sys.argv[6:]
R = [json.loads(l) for l in Path(log).read_text().splitlines()[mark:]]
C = [r for r in R if r["path"].endswith("/commit")]
u = urlparse(server)
def get(path):
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())
S, I = get("/_fake/state")[1], {e["id"]: e for e in get("/_fake/inbox")[1]["entries"]}
live = {p: f for p, f in S["files"].items() if not f["deleted"]}
hi = root / ".hi2vi"
base = json.loads((hi / "base.json").read_text())
journal = json.loads((hi / "journal.json").read_text()) if (hi / "journal.json").exists() else None
def sha(p):
    return hashlib.sha256((root / p).read_bytes()).hexdigest()
def cloud(p):
    return base64.b64decode(get("/_fake/file?path=" + quote(p))[1]["content"]).decode()
def need(cond, why):
    if not cond:
        print(why)
        sys.exit(1)
def synced():
    need(journal is None, f"the journal is left: {journal}")
    need(base.get("head") == S["head"], f"base head {base.get('head')} != sikstack head {S['head']}")
    need(set(base["files"]) == set(live), f"base and sikstack hold different paths: {sorted(set(base['files']) ^ set(live))[:4]}")
    for p, f in live.items():
        if p == "works/events.jsonl":  # cold (0.4.0): once a push lands its sent lines leave the disk
            need(base["files"][p]["rev"] == f["rev"] and (not (root / p).exists() or (root / p).read_bytes() == b""),
                 f"{p}: the base's rev is not sikstack's, or the disk still holds sent lines")
            continue
        need(base["files"][p]["rev"] == f["rev"] and (root / p).is_file() and sha(p) == f["sha256"], f"{p}: base, disk and sikstack disagree")
def with_result(eid):
    return [c for c in C if any(r["id"] == eid for r in c["batch"]["inbox"])]
if check == "applied":  # extra: the entry ids, oldest first; each applied, alone in its own landed batch with its files
    ids = extra
    batches = [c for c in C if c["batch"]["inbox"]]
    need([c["batch"]["inbox"][0]["id"] for c in batches] == ids, f"batches in the wrong order or count: {[c['batch']['inbox'] for c in batches]}")
    for eid, c in zip(ids, batches):
        need(c["status"] == 200 and len(c["batch"]["inbox"]) == 1, f"{eid}: not alone in a landed batch: {c['status']} {c['batch']['inbox']}")
        need(c["batch"]["inbox"][0] == {"id": eid, "state": "applied", "exit": 0, "reason": None}, f"{eid}: result {c['batch']['inbox'][0]}")
        need(I[eid]["state"] == "applied" and I[eid]["batch_id"] == c["batch"]["batch_id"], f"{eid}: sikstack holds {I[eid]['state']}")
        paths = sorted(op["path"] for op in c["batch"]["ops"])
        need(paths and all(p.startswith("works/agenda/") or p == "works/events.jsonl" for p in paths), f"{eid}: unrelated files ride its batch: {paths}")
        need(c["batch"]["command"].startswith("agenda-"), f"{eid}: the batch names {c['batch']['command']!r}")
    need(json.loads((root / "works/agenda/A3-x2/agenda.json").read_text())["title"] == "from the web", "A3-x2 is not on disk")
    a2 = json.loads((root / "works/agenda/A2-m3/agenda.json").read_text())
    need(a2["status"] == "open" and a2.get("proposed", {}).get("by") == "person:web", f"A2-m3 is not Proposed by the web: {a2}")
    synced()
elif check == "thread":  # extra: the entry ids, oldest first: a web entry on A3-x2 and the web's accept of A5-p1
    for eid, c in zip(extra, [c for c in C if c["batch"]["inbox"]]):
        need(c["status"] == 200 and c["batch"]["inbox"][0] == {"id": eid, "state": "applied", "exit": 0, "reason": None}, f"{eid}: {c['batch']['inbox']}")
        need(all(op["path"].startswith("works/agenda/") or op["path"] == "works/events.jsonl" for op in c["batch"]["ops"]), f"{eid}: {c['batch']['ops']}")
    web = [json.loads(p.read_text()) for p in (root / "works/agenda/A3-x2/entries").glob("*.json")]
    need(any(e["author"] == "person:web" and e["source"] == "web:inbox" and e["kind"] == "note" for e in web), f"no web entry: {web}")
    need("proposed" not in json.loads((root / "works/agenda/A5-p1/agenda.json").read_text()), "A5-p1 is still Proposed")
    synced()
elif check == "items":  # extra: <refused entry id> then the applied entry ids, oldest first; each alone in its batch
    refused, ids = extra[0], extra[1:]
    batches = [c for c in C if c["batch"]["inbox"]]
    landed = [c for c in batches if c["batch"]["inbox"][0]["id"] in ids]
    need([c["batch"]["inbox"][0]["id"] for c in landed] == ids, f"batches in the wrong order or count: {[c['batch']['inbox'] for c in batches]}")
    for eid, c in zip(ids, landed):
        need(c["status"] == 200 and c["batch"]["inbox"] == [{"id": eid, "state": "applied", "exit": 0, "reason": None}], f"{eid}: {c['status']} {c['batch']['inbox']}")
        need(I[eid]["state"] == "applied", f"{eid}: sikstack holds {I[eid]['state']}")
        paths = [p for op in c["batch"]["ops"] for p in (op.get("path"), op.get("from"), op.get("to")) if p]  # a split's items go as moves
        need(paths and all(p.startswith("works/agenda/") or p == "works/events.jsonl" for p in paths), f"{eid}: {c['batch']['ops']}")
    r = with_result(refused)
    need(len(r) == 1 and not r[0]["batch"]["ops"] and r[0]["batch"]["inbox"][0]["state"] == "refused" and r[0]["batch"]["inbox"][0]["exit"] == 2,
         f"{refused}: {[(x['status'], x['batch']['inbox'], x['batch']['ops']) for x in r]}")
    synced()
elif check == "refused":  # extra: <entry id> <exit> <reason>; the result alone in a batch with no file
    eid, code, reason = extra[0], int(extra[1]), extra[2]
    c = with_result(eid)
    need(len(c) == 1 and c[0]["status"] == 200 and not c[0]["batch"]["ops"], f"{eid}: batches {[(x['status'], x['batch']['ops']) for x in c]}")
    need(c[0]["batch"]["inbox"] == [{"id": eid, "state": "refused", "exit": code, "reason": reason}], f"{eid}: sent {c[0]['batch']['inbox']}")
    need(I[eid]["state"] == "refused" and I[eid]["reason"] == reason and I[eid]["exit"] == code, f"{eid}: sikstack holds {I[eid]}")
    synced()
elif check == "taken":  # extra: <entry id> <path>: one 409 batch, the disk equal to sikstack's copy, applied once (by the other)
    eid, path = extra
    c = with_result(eid)
    need(len(c) == 1 and c[0]["status"] == 409, f"{eid}: batches {[x['status'] for x in c]}")
    need(I[eid]["state"] == "applied" and I[eid]["by"] == "checkout other", f"{eid}: sikstack holds {I[eid]}")
    need((root / path).read_text() == cloud(path), f"{path}: the disk is not sikstack's copy")
    need("agenda_edited" not in (root / "works/events.jsonl").read_text(), "the dropped edit's event is still on disk")
    synced()
elif check == "pending":  # extra: <entry id>: no result was sent and the entry waits
    eid = extra[0]
    need(not with_result(eid) and I[eid]["state"] == "pending", f"{eid}: sent {len(with_result(eid))}, sikstack holds {I[eid]['state']}")
    need(not any(c["batch"]["ops"] for c in C), f"a crashed entry's files were sent: {[c['batch']['ops'] for c in C]}")
    synced()
elif check == "delete":  # extra: <entry id>: one batch holds the delete, the cleared links and the result
    eid = extra[0]
    c = with_result(eid)
    need(len(c) == 1 and c[0]["status"] == 200, f"{eid}: batches {[x['status'] for x in c]}")
    ops = {(op["op"], op["path"]) for op in c[0]["batch"]["ops"]}
    phases = ["works/phases/active/P1/phase.json", "works/phases/active/P2/phase.json"]
    need(("delete", "works/agenda/A1-k2/agenda.json") in ops and all(("put", p) in ops for p in phases),
         f"{eid}: the batch holds {sorted(ops)}")
    for p in phases:
        need("agenda" not in json.loads((root / p).read_text()) and "agenda" not in json.loads(cloud(p)), f"{p} keeps its link")
    need(not (root / "works/agenda/A1-k2").exists() and "works/agenda/A1-k2/agenda.json" not in live, "A1-k2 is still there")
    synced()
else:
    need(False, f"unknown check {check}")
print("ok")
PY
}
ib_lockfree() { python3 - "$IBA/.sikstack/.hi2vi/lock" <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("free")
except OSError:
    print("held")
PY
}
# (a) next applies two web changes, oldest first, each alone in its batch, and still prints its pointer.
ib_e1=$(ib_web '{"kind": "add", "minted_id": "A3-x2", "items": ["A3-x2"], "fields": {"title": "from the web"}}')
ib_e2=$(ib_web '{"kind": "propose", "items": ["A2-m3"]}')
ib_m=$(ib_mark); ib "$IBA" next > "$IBW/a.txt"; ib_rc=$?; ib_r=$(ib_check "$ib_m" applied "$ib_e1" "$ib_e2")
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && grep -qx "inbox $ib_e1: applied (agenda-add A3-x2): added A3-x2: from the web" "$IBW/a.txt" \
  && grep -qx "inbox $ib_e2: applied (agenda-propose A2-m3): proposed A2-m3: Proposed, out of the open order (sikstack agenda-accept A2-m3 puts it back)" "$IBW/a.txt" && grep -q '^store=cloud ' "$IBW/a.txt" \
  && [ "$(ib_lockfree)" = free ] \
  && ok "next applies the web's agenda changes oldest first, each alone in a landed batch with exactly its own files, then runs as always (no deadlock on .hi2vi/lock, the lock free after)" \
  || bad "next did not apply the inbox -- rc=$ib_rc $ib_r $(head -3 "$IBW/a.txt")"
# (b) a brief id is refused unrun: exit 2, its line verbatim, nothing written (A1-k2 stays Open).
ib_e3=$(ib_web '{"kind": "solve", "items": ["A1"]}')
ib_t1=$(ib_tree "$IBA/.sikstack"); ib_m=$(ib_mark); ib "$IBA" sync > "$IBW/b.txt"; ib_rc=$?; ib_t2=$(ib_tree "$IBA/.sikstack")
ib_line="sikstack agenda-solve: error: A1 is not a full agenda id (like A7-m3): the inbox applies full ids only, so nothing ran"
ib_r=$(ib_check "$ib_m" refused "$ib_e3" 2 "$ib_line")
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && [ "$ib_t1" = "$ib_t2" ] && grep -qxF "inbox $ib_e3: refused, exit 2 (agenda-solve A1): $ib_line" "$IBW/b.txt" \
  && ok "a brief id in an inbox entry is refused unrun (exit 2, one line, nothing written, the result alone in a batch)" \
  || bad "a brief id was not refused unrun -- rc=$ib_rc $ib_r $(head -3 "$IBW/b.txt") $(diff <(echo "$ib_t1") <(echo "$ib_t2") | head -3)"
# (c) a refusal (exit 1) and a usage error (exit 2) reach the entry verbatim: the same line the engine prints.
ib_e4=$(ib_web '{"kind": "reopen", "items": ["A4-n5"]}')
ib_e5=$(ib_web '{"kind": "propose", "items": []}')
ib_l5=$(cd "$IBL" && python3 "$ENG" agenda-propose --author=person:web 2>&1); ib_rc5=$?
ib_l4="A4-n5 is Open already"
ib_m=$(ib_mark); ib "$IBA" sync > "$IBW/c.txt"; ib_rc=$?
ib_r=$(ib_check "$ib_m" refused "$ib_e4" 1 "$ib_l4"); ib_r2=$(ib_check "$ib_m" refused "$ib_e5" 2 "$ib_l5")
[ "$ib_rc" = 0 ] && [ "$ib_rc5" = 2 ] && [ "$ib_r" = ok ] && [ "$ib_r2" = ok ] && grep -qxF "inbox $ib_e4: refused, exit 1 (agenda-reopen A4-n5): $ib_l4" "$IBW/c.txt" \
  && ok "a refused agenda command's one line reaches its entry verbatim with exit 1, and a usage error's (as the engine prints it) with exit 2" \
  || bad "a refusal's line did not reach its entry -- rc=$ib_rc/$ib_rc5 $ib_r / $ib_r2 $(head -3 "$IBW/c.txt")"
# (d) another checkout applies an entry first: A's batch is a 409, its change dropped, sikstack's copy pulled, once.
ib_e6=$(ib_web '{"kind": "edit", "items": ["A3-x2"], "fields": {"title": "renamed"}}')
ib_other=$(python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); d.update(title="renamed", changed_at="2026-11-18T10:00:00+00:00"); print(json.dumps(d, indent=2))' "$IBA/.sikstack/works/agenda/A3-x2/agenda.json")
ib_post /_fake/control "$(python3 -c 'import json, sys; print(json.dumps({"inbox_race": sys.argv[1], "race": {"path": "works/agenda/A3-x2/agenda.json", "content": sys.argv[2] + "\n"}}))' "$ib_e6" "$ib_other")" > /dev/null
ib_m=$(ib_mark); ib "$IBA" sync > "$IBW/d.txt"; ib_rc=$?; ib_r=$(ib_check "$ib_m" taken "$ib_e6" works/agenda/A3-x2/agenda.json)
ib "$IBA" sync > "$IBW/d2.txt"; ib_rc2=$?
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && grep -qxF "inbox $ib_e6: not applied here (agenda-edit A3-x2): sikstack holds it applied already (another checkout); this checkout's change was dropped and sikstack's copy pulled" "$IBW/d.txt" \
  && [ "$ib_rc2" = 0 ] && ! grep -q "^inbox " "$IBW/d2.txt" \
  && ok "an entry another checkout applied first is a 409: this checkout's change is dropped and sikstack's copy pulled, never applied twice" \
  || bad "an entry taken elsewhere was mishandled -- rc=$ib_rc/$ib_rc2 $ib_r $(head -3 "$IBW/d.txt")"
# (e) a crash inside a command (A1-k2's folder cannot be removed) leaves the entry pending and the tree as it was.
ib_e7=$(ib_web '{"kind": "delete", "items": ["A1-k2"]}')
chmod 555 "$IBA/.sikstack/works/agenda/A1-k2"
ib_t1=$(ib_tree "$IBA/.sikstack"); ib_m=$(ib_mark); ib "$IBA" next > "$IBW/e.txt"; ib_rc=$?; ib_t2=$(ib_tree "$IBA/.sikstack")
chmod 755 "$IBA/.sikstack/works/agenda/A1-k2"; ib_r=$(ib_check "$ib_m" pending "$ib_e7")
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && [ "$ib_t1" = "$ib_t2" ] \
  && grep -qxF "inbox $ib_e7: left pending (agenda-delete A1-k2): PermissionError inside the command; its changes were undone" "$IBW/e.txt" \
  && ok "a crash inside an agenda command leaves its entry pending (no result sent) and the tree as it was before that entry" \
  || bad "a crashed entry was not undone -- rc=$ib_rc $ib_r $(head -3 "$IBW/e.txt") $(diff <(echo "$ib_t1") <(echo "$ib_t2") | head -4)"
# (f) at the next next the delete applies: its links cleared in the same batch as the item's removal and its result.
ib_m=$(ib_mark); ib "$IBA" next > "$IBW/f.txt"; ib_rc=$?; ib_r=$(ib_check "$ib_m" delete "$ib_e7")
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && grep -q "^inbox $ib_e7: applied (agenda-delete A1-k2): deleted A1-k2: 2 links cleared" "$IBW/f.txt" \
  && ok "next applies a web delete: the item's removal, its cleared links (two phases) and the result land in one batch" \
  || bad "a web delete did not clear its links in one batch -- rc=$ib_rc $ib_r $(head -3 "$IBW/f.txt")"
# (g) the web's entry and accept (P72): mapped to agenda-entry (the web's writer, person:web) and agenda-accept.
ib_e8=$(ib_web '{"kind": "entry", "items": ["A3-x2"], "fields": {"kind": "note", "body": "a note from the web"}}')
ib_e9=$(ib_web '{"kind": "accept", "items": ["A5-p1"]}')
ib_m=$(ib_mark); ib "$IBA" next > "$IBW/g.txt"; ib_rc=$?; ib_r=$(ib_check "$ib_m" thread "$ib_e8" "$ib_e9")
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && grep -qE "^inbox $ib_e8: applied \(agenda-item add A3-x2\): added item A3-x2/[0-9a-z]{4} \(.*\.json\): note by person:web \(web:inbox\)$" "$IBW/g.txt" \
  && grep -qx "inbox $ib_e9: applied (agenda-accept A5-p1): accepted A5-p1: Open, 1 in the open order" "$IBW/g.txt" \
  && ok "next applies the web's entry (agenda-item add as person:web) and accept (agenda-accept), each alone in its landed batch" \
  || bad "the web's entry or accept was not applied -- rc=$ib_rc $ib_r $(head -3 "$IBW/g.txt")"
# (h) two writers on one item: another writer's entry lands in sikstack just before this checkout's own entry is
# committed; both land, and the next sync pulls the other's with no differs line.
ib_other=$(python3 -c 'import datetime, json; t = datetime.datetime.now(datetime.timezone.utc); print(json.dumps({"path": "works/agenda/A3-x2/entries/" + t.strftime("%Y%m%dT%H%M%S") + ".000001Z-wb2k.json", "content": json.dumps({"kind": "feedback", "author": "person:web", "source": "web:other", "created_at": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "body": "from another writer"}) + "\n"}))')
ib_post /_fake/control "$(python3 -c 'import json, sys; print(json.dumps({"race": json.loads(sys.argv[1])}))' "$ib_other")" > /dev/null
ib "$IBA" agenda-entry A3-x2 --kind issue --author agent:smoke --source slice:P1.S1 --body "from this checkout" > "$IBW/h.txt"; ib_rc=$?
ib "$IBA" sync > "$IBW/h2.txt"; ib_rc2=$?
ib_n=$(ls "$IBA/.sikstack/works/agenda/A3-x2/entries" | wc -l | tr -d ' ')
[ "$ib_rc" = 0 ] && [ "$ib_rc2" = 0 ] && ! grep -qi 'differ' "$IBW/h.txt" "$IBW/h2.txt" && [ "$ib_n" = 3 ] \
  && ls "$IBA/.sikstack/works/agenda/A3-x2/entries" | grep -q 'wb2k' && ib "$IBA" check --no-rebuild >/dev/null 2>&1 \
  && ok "another writer's entry and this checkout's entry on one item both land: the command and the next sync exit 0 with no differs line, all three entries on disk" \
  || bad "two writers' entries conflicted -- rc=$ib_rc/$ib_rc2 n=$ib_n $(tail -2 "$IBW/h.txt") / $(tail -2 "$IBW/h2.txt")"
# (i) 0.6.0's item kinds and split, and an old pending defer: three web items on A4-n5, then item-done, item-dismiss,
# a split of the third into A6-q7 (A4-n5, left with no open item, closes Solved), item-reopen of the first (A4-n5 stays
# Solved) and item-delete of A6-q7's one item (it closes Dropped), each its agenda-item or agenda-split command, each
# alone in its landed batch; the old defer is refused with one line (exit 2), never run, nothing written for it.
for ib_b in one two three; do ib_web "{\"kind\": \"entry\", \"items\": [\"A4-n5\"], \"fields\": {\"kind\": \"issue\", \"body\": \"$ib_b\"}}" > /dev/null; done
ib "$IBA" next > "$IBW/i0.txt"
ib_n1=$(ls "$IBA/.sikstack/works/agenda/A4-n5/entries" | sed -n 1p); ib_n2=$(ls "$IBA/.sikstack/works/agenda/A4-n5/entries" | sed -n 2p); ib_n3=$(ls "$IBA/.sikstack/works/agenda/A4-n5/entries" | sed -n 3p)
ib_ent() { printf '{"kind": "%s", "items": ["%s"], "fields": {"entries": ["%s"]%s}%s}' "$1" "$2" "$3" "${4:-}" "${5:-}"; }
ib_e10=$(ib_web '{"kind": "defer", "items": ["A4-n5"]}')
ib_e11=$(ib_web "$(ib_ent item-done A4-n5 "$ib_n1")"); ib_e12=$(ib_web "$(ib_ent item-dismiss A4-n5 "$ib_n2")")
ib_e13=$(ib_web "$(ib_ent split A4-n5 "$ib_n3" ', "title": "split on the web"' ', "minted_id": "A6-q7"')")
ib_e14=$(ib_web "$(ib_ent item-reopen A4-n5 "$ib_n1")"); ib_e15=$(ib_web "$(ib_ent item-delete A6-q7 "$ib_n3")")
ib_m=$(ib_mark); ib "$IBA" next > "$IBW/i.txt"; ib_rc=$?; ib_r=$(ib_check "$ib_m" items "$ib_e10" "$ib_e11" "$ib_e12" "$ib_e13" "$ib_e14" "$ib_e15")
ib_d=$(python3 - "$IBA/.sikstack/works/agenda" "$ib_n1" "$ib_n2" "$ib_n3" <<'PY'
import json, sys
from pathlib import Path
root, n1, n2, n3 = Path(sys.argv[1]), *sys.argv[2:]
a4, a6 = (json.loads((root / a / "agenda.json").read_text()) for a in ("A4-n5", "A6-q7"))
e1, e2 = (json.loads((root / "A4-n5/entries" / n).read_text()) for n in (n1, n2))
bad = []
if (a4["status"], a4["outcome"]) != ("solved", "all items dealt with: 1 done, 1 dismissed"): bad.append(f"A4-n5 {a4['status']} {a4['outcome']}")
if (a6["status"], a6["reason"], a6["title"]) != ("dropped", "every item dismissed or deleted", "split on the web"): bad.append(f"A6-q7 {a6}")
if (e1.get("state"), e1.get("state_by")) != ("open", "person:web") or (e2.get("state"), e2.get("state_by")) != ("dismissed", "person:web"): bad.append(f"states {e1.get('state')} {e2.get('state')}")
if (root / "A4-n5/entries" / n3).exists() or (root / "A6-q7/entries" / n3).exists(): bad.append("the split item is still on disk")
print("; ".join(bad) or "ok")
PY
)
ib_l10="sikstack: error: the inbox entry's kind defer is retired: Deferred is gone since 0.6.0, so propose the agenda back instead (kind propose); nothing ran"
[ "$ib_rc" = 0 ] && [ "$ib_r" = ok ] && [ "$ib_d" = ok ] && [ -n "$ib_n3" ] \
  && grep -qxF "inbox $ib_e10: refused, exit 2 (agenda A4-n5): $ib_l10" "$IBW/i.txt" \
  && grep -qE "^inbox $ib_e11: applied \(agenda-item done A4-n5\): done A4-n5/[0-9a-z]{4}$" "$IBW/i.txt" \
  && grep -qE "^inbox $ib_e13: applied \(agenda-split A4-n5 A6-q7\): split 1 item of A4-n5 into A6-q7: split on the web$" "$IBW/i.txt" \
  && grep -qE "^inbox $ib_e15: applied \(agenda-item delete A6-q7\): deleted A6-q7/[0-9a-z]{4}$" "$IBW/i.txt" \
  && ok "next applies the web's item-done, item-dismiss, split (A4-n5 then closes Solved), item-reopen (A4-n5 stays Solved) and item-delete (A6-q7 closes Dropped) as their commands, each alone in its landed batch; an old pending defer is refused with one line, exit 2, never run" \
  || bad "the web's item kinds or split were not applied, or the old defer ran -- rc=$ib_rc $ib_r / $ib_d / $(grep '^inbox' "$IBW/i.txt" | head -7 | tr '\n' '|')"
if grep -rqF "$IBK" "$IBA" "$IBW"/*.txt "$IBW/fake" 2>/dev/null; then bad "the workspace key leaked into the tree, the output or the request log"; fi
kill "$IB_PID" 2>/dev/null; wait "$IB_PID" 2>/dev/null
echo "inbox test runtime: $(( $(date +%s) - ib_t0 ))s"

# ---------------------------------------------------------------------------
echo "== Test 25: a linked checkout's waiting-commit record and update, against the local fake sikstack -- next prints commits_waiting= (the done slices finished since the link with no committed_at, in finish order; none for one done before the link); mark-committed records it in slice.json (synced to sikstack), refuses a slice not done and local mode with nothing written, and leaving done clears it; review records a passing REVIEW itself; local mode prints no line and writes no field; --update on a linked checkout leaves changed works/ files unchanged and uncommitted and prints the update's own paths to stage, never add -A; --to-multi-repo refuses a linked install =="
wc_t0=$(date +%s)
newtmp WCW; WCX="$WCW/xdg"; WCA="$WCW/a"; WCL="$WCW/local"
wc() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$WCX" python3 "$ENG" "$@" ) 2>&1; }
wc_install() { { mkhost "$1" \
  && git -C "$1/.sikstack" config user.email smoke@example.invalid && git -C "$1/.sikstack" config user.name smoke \
  && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m install; } > "$1.setup.txt" 2>&1 || bad "commit-record probe: the install of $1 failed -- $(tail -3 "$1.setup.txt")"; }
# wc_seed <host>: P1 with its DECOMP done (and committed, as every pre-link slice is) and two declared slices open.
wc_seed() { { wc "$1" phase new --phase P1 --name One --objective toy && wc "$1" slice start P1.DECOMP \
  && wc "$1" slice new --phase P1 --slice P1.S1 --name one --depends-on none && wc "$1" slice new --phase P1 --slice P1.S2 --name two --depends-on none \
  && wc "$1" slice finish P1.DECOMP --outcome cut && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -qm seed; } > "$1.seed.txt" 2>&1 \
  || bad "commit-record probe: the seed of $1 failed -- $(tail -3 "$1.seed.txt")"; }
wc_install "$WCA"; wc_install "$WCL"; wc_seed "$WCA"; wc_seed "$WCL"
WCK="record-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$WCK" > "$WCW/key"; chmod 600 "$WCW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$WCW/fake" --port-file "$WCW/port" --key-file "$WCW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$WCW/fake.txt" 2>&1 &
WC_PID=$!
for _ in $(seq 1 100); do [ -s "$WCW/port" ] && break; sleep 0.1; done
WCS="http://127.0.0.1:$(cat "$WCW/port" 2>/dev/null)"
sleep 1  # a second boundary: the link's stamp falls after the seed's finish
printf '%s\n' "$WCK" | ( cd "$WCA" && XDG_CONFIG_HOME="$WCX" python3 "$ENG" link "$WCS/projects/proj-1" ) > "$WCW/link.txt" 2>&1 || bad "commit-record probe: the link failed -- $(tail -2 "$WCW/link.txt")"
WCJ="$WCA/.sikstack/works/phases/active/P1/slices"
wc_has() { python3 -c 'import json, sys; print("yes" if "committed_at" in json.load(open(sys.argv[1])) else "no")' "$WCJ/$1/slice.json"; }
wc_cloud_has() { python3 - "$WCS" "$1" <<'PY'
import base64, http.client, json, sys
from urllib.parse import urlparse, quote
u = urlparse(sys.argv[1]); conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request("GET", "/_fake/file?path=" + quote(sys.argv[2])); resp = conn.getresponse()
print("yes" if resp.status == 200 and "committed_at" in json.loads(base64.b64decode(json.loads(resp.read())["content"])) else "no")
PY
}
wc_tree() { ( cd "$1" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
# (a) the done-before-link DECOMP never waits; a slice finished since waits until mark-committed records it.
wc_n0=$(wc "$WCA" next | grep '^commits_waiting=')
wc "$WCA" slice start P1.S1 >/dev/null; wc "$WCA" slice finish P1.S1 --outcome one >/dev/null
wc_n1=$(wc "$WCA" next | grep '^commits_waiting='); wc_h1=$(wc_has P1.S1)
wc_t1=$(wc_tree "$WCA/.sikstack/works"); wc_o2=$(wc "$WCA" mark-committed P1.S1 P1.S2); wc_rc2=$?; wc_t2=$(wc_tree "$WCA/.sikstack/works")
wc_o3=$(wc "$WCA" mark-committed 1.S1); wc_rc3=$?
wc_n3=$(wc "$WCA" next | grep '^commits_waiting=')
[ "$wc_n0" = "commits_waiting=none" ] && [ "$wc_n1" = "commits_waiting=P1.S1" ] && [ "$wc_h1" = no ] \
  && [ "$wc_rc2" = 1 ] && printf '%s\n' "$wc_o2" | grep -q "P1.S2 is todo, not done" && [ "$wc_t1" = "$wc_t2" ] \
  && [ "$wc_rc3" = 0 ] && printf '%s\n' "$wc_o3" | grep -q "^P1.S1: committed_at=" && [ "$wc_n3" = "commits_waiting=none" ] \
  && [ "$(wc_has P1.S1)" = yes ] && [ "$(wc_cloud_has works/phases/active/P1/slices/P1.S1/slice.json)" = yes ] \
  && ok "a linked checkout's waiting commit: next lists a slice finished since the link (not the DECOMP done before it) in commits_waiting=, mark-committed refuses a slice not done with nothing written, then records committed_at (synced to sikstack) and the line reads none" \
  || bad "the linked waiting-commit record is wrong -- [$wc_n0] [$wc_n1] has=$wc_h1 rc=$wc_rc2/$wc_rc3 [$wc_n3] $(printf '%s' "$wc_o2" | head -2)"
# (b) leaving done clears the record (it waits again once done); a second finish keeps it; review records a REVIEW.
wc "$WCA" slice status P1.S1 in_progress >/dev/null; wc_h4=$(wc_has P1.S1); wc "$WCA" slice finish P1.S1 --outcome again >/dev/null
wc_n4=$(wc "$WCA" next | grep '^commits_waiting='); wc "$WCA" mark-committed P1.S1 >/dev/null; wc "$WCA" slice finish P1.S1 --outcome third >/dev/null
wc_n5=$(wc "$WCA" next | grep '^commits_waiting=')
{ wc "$WCA" slice start P1.S2 && wc "$WCA" slice finish P1.S2 --outcome two && wc "$WCA" mark-committed P1.S2 && wc "$WCA" gate P1 waive --note toy \
  && wc "$WCA" slice start P1.REVIEW && wc "$WCA" review P1 --verdict pass; } > "$WCW/review.txt" 2>&1; wc_rc6=$?
wc_n6=$(wc "$WCA" next | grep '^commits_waiting=')
[ "$wc_h4" = no ] && [ "$wc_n4" = "commits_waiting=P1.S1" ] && [ "$wc_n5" = "commits_waiting=none" ] && [ "$wc_rc6" = 0 ] \
  && [ "$wc_n6" = "commits_waiting=none" ] && [ "$(wc_has P1.REVIEW)" = yes ] \
  && ok "leaving done clears committed_at and the slice waits again once done; a second slice finish keeps it; review --verdict pass records the REVIEW's commit itself" \
  || bad "the record's lifecycle is wrong -- has=$wc_h4 [$wc_n4] [$wc_n5] rc=$wc_rc6 [$wc_n6] $(tail -2 "$WCW/review.txt")"
# (c) local mode: no line, no field; mark-committed is refused with nothing written.
wc "$WCL" slice start P1.S1 >/dev/null; wc "$WCL" slice finish P1.S1 --outcome one >/dev/null
wc_ln=$(wc "$WCL" next)
wc_t7=$(wc_tree "$WCL/.sikstack"); wc_o7=$(wc "$WCL" mark-committed P1.S1); wc_rc7=$?; wc_t8=$(wc_tree "$WCL/.sikstack")
! printf '%s\n' "$wc_ln" | grep -q 'commits_waiting' && ! grep -rq committed_at "$WCL/.sikstack/works" \
  && [ "$wc_rc7" = 1 ] && printf '%s\n' "$wc_o7" | grep -q "^mark-committed is for a linked checkout" && [ "$wc_t7" = "$wc_t8" ] \
  && ok "local mode: next prints no commits_waiting= line, no slice.json gains committed_at, and mark-committed is refused with nothing written" \
  || bad "local mode leaked the linked record -- rc=$wc_rc7 $(printf '%s\n' "$wc_ln" | grep commits_waiting) $(grep -rl committed_at "$WCL/.sikstack/works" | head -2)"
if grep -rqF "$WCK" "$WCA" "$WCL" "$WCW"/*.txt "$WCW/fake" 2>/dev/null; then bad "the workspace key leaked into the tree, the output or the request log"; fi
kill "$WC_PID" 2>/dev/null; wait "$WC_PID" 2>/dev/null
echo "commit-record test runtime: $(( $(date +%s) - wc_t0 ))s"
unset -f wc   # this test's wc() wrapper would shadow wc(1) for the tests after it

# ---------------------------------------------------------------------------
echo "== Test 26: the core flow -- a toy phase through the verbs that stay: phase and slice lifecycle, a section read and append, a typed stop that halts next and releases, the pass refused while the gate is required and uncleared, --waive needing --note, pr branch refusing a dirty switch, validate exiting 1 on a broken slice.json, the pass and the archive =="
# The pin a command rename must keep green: each verb is called only through its wrapper below, so a rename
# touches one line here. A fresh workspace (`sikstack init`) in its own repo; no other test's state is read.
newtmp CFT; CW="$CFT/ws"
mkws CW > "$CFT/install.txt" 2>&1 || bad "core flow: the fresh install failed"
CH="$CFT/ws"; cfg() { git -C "$CH" "$@"; }  # the product repo; CW is its .sikstack/
wf() { ( cd "$CW" && python3 "$ENG" "$@" 2>&1 ); }
wf_next() { wf next; }
wf_new_phase() { wf phase new "$@"; }
wf_new_slice() { wf slice new "$@"; }
wf_slice_start() { wf slice start "$1"; }
wf_slice_finish() { wf slice finish "$1" --outcome "$2"; }
wf_slice_status() { wf slice status "$@"; }
wf_section() { wf section "$@"; }
wf_gate_require() { wf gate "$1" require; }
wf_gate_waive() { wf gate "$1" waive "${@:2}"; }
wf_gate_open() { wf gate "$1" open --walkthrough "$2"; }
wf_gate_clear() { wf gate "$1" clear "${@:2}"; }
wf_review_pass() { wf review "$1" --verdict pass; }
wf_pr_branch() { wf pr branch "$1" --name "$2"; }
wf_check() { wf check --no-rebuild; }
wf_archive() { wf phase archive "$1"; }
cf_status() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$CW/works/phases/active/$1"; }
{ printf 'a\n' > "$CH/app.txt" && cfg add -A && cfg commit -qm base; } >/dev/null 2>&1 \
  || bad "core flow: the base commit failed"
# (1) the phase and slice lifecycle: a phase is made with DECOMP and REVIEW, a slice is made, started and finished with its outcome.
c1=$(wf_new_phase --phase P1 --name "Core" --objective "the core flow"); c1_rc=$?
c2=$(wf_slice_finish P1.DECOMP "planned"); c2_rc=$?
c3=$(wf_new_slice --phase P1 --slice P1.S1 --name "probe" --kind implementation --risk low); c3_rc=$?
c4=$(wf_slice_start P1.S1); c4_rc=$?; c4_st=$(cf_status P1/slices/P1.S1/slice.json)
[ "$c1_rc$c2_rc$c3_rc$c4_rc" = 0000 ] && [ -d "$CW/works/phases/active/P1/slices/P1.DECOMP" ] && [ -d "$CW/works/phases/active/P1/slices/P1.REVIEW" ] \
  && [ "$(cf_status P1/slices/P1.DECOMP/slice.json)" = done ] && [ "$c4_st" = in_progress ] \
  && grep -q '| planned |' "$CW/works/phases/active/P1/phase.md" \
  && ok "core flow: a new phase carries DECOMP and REVIEW; DECOMP finishes with its outcome in the ## Slices row; a new slice starts in_progress" \
  || bad "core flow: phase and slice lifecycle broke (rc $c1_rc/$c2_rc/$c3_rc/$c4_rc, S1 $c4_st) -- $c1 / $c2 / $c3 / $c4"
# (2) a section read and an append, one section at a time.
c5=$(wf_section P1 Now); c5_rc=$?
c6=$(printf -- '- core: a settled point\n' | wf_section P1 Decisions --append --file /dev/stdin); c6_rc=$?
c7=$(wf_section P1 Decisions); c7_rc=$?
[ "$c5_rc$c6_rc$c7_rc" = 000 ] && [ "$(printf '%s\n' "$c5" | head -1)" = '## Now' ] && ! printf '%s\n' "$c5" | grep -q '^## Decisions' \
  && printf '%s\n' "$c7" | grep -qx -- '- core: a settled point' && grep -qx -- '- core: a settled point' "$CW/works/phases/active/P1/phase.md" \
  && ok "core flow: section reads one section (## Now alone) and appends an entry that the next read and phase.md both show" \
  || bad "core flow: the section read or append broke (rc $c5_rc/$c6_rc/$c7_rc) -- $c5 / $c6 / $c7"
# (3) a typed stop: bare or half-typed is refused; typed, next prints WAITING ON OPERATOR and no dispatchable slice; leaving pending releases it.
c8b=$(wf_slice_status P1.S1 pending); c8b_rc=$?; c8b_st=$(cf_status P1/slices/P1.S1/slice.json)
c8=$(wf_slice_status P1.S1 pending --stop-kind decision); c8_rc=$?; c8_st=$(cf_status P1/slices/P1.S1/slice.json)
c9=$(wf_slice_status P1.S1 pending --stop-kind decision --on-words "the operator picks one"); c9_rc=$?
c10=$(wf_next); c10_rc=$?
c11=$(wf_slice_status P1.S1 in_progress); c11_rc=$?
c12=$(wf_next)
[ "$c8b_rc" = 1 ] && [ "$c8b_st" = in_progress ] && [ "$c8_rc" = 1 ] && [ "$c8_st" = in_progress ] && [ "$c9_rc$c10_rc$c11_rc" = 000 ] \
  && printf '%s\n' "$c10" | grep -q '^WAITING ON OPERATOR: slice P1.S1 is pending' && printf '%s\n' "$c10" | grep -qx 'waiting_on_operator=P1.S1' \
  && printf '%s\n' "$c10" | grep -qx 'stop_kind=decision' && printf '%s\n' "$c10" | grep -qx 'on_words=the operator picks one' \
  && ! printf '%s\n' "$c10" | grep -q '^current_slice=' \
  && ! printf '%s\n' "$c12" | grep -q 'WAITING ON OPERATOR' && printf '%s\n' "$c12" | grep -qx 'current_slice=P1.S1' \
  && ok "core flow: a bare or half-typed pending stop is refused unwritten; a typed pending stop makes next print WAITING ON OPERATOR with its kind and words and no slice, and in_progress releases it" \
  || bad "core flow: the typed stop did not halt and release next (rc $c8b_rc/$c8_rc/$c9_rc/$c10_rc/$c11_rc) -- $c8 / $c10 / $c12"
c13=$(wf_slice_finish P1.S1 "did the probe"); c13_rc=$?
[ "$c13_rc" = 0 ] && [ "$(cf_status P1/slices/P1.S1/slice.json)" = done ] && grep -q '| did the probe |' "$CW/works/phases/active/P1/phase.md" \
  && ok "core flow: slice finish marks the slice done and lands its outcome in the ## Slices row" || bad "core flow: finishing P1.S1 broke (rc $c13_rc) -- $c13"
# (4) the pass is refused while the gate is required and not cleared; (5) gate waive without --note is refused.
c14=$(wf_gate_require P1); c14_rc=$?
c15=$(wf_slice_start P1.REVIEW); c16=$(wf_review_pass P1); c16_rc=$?
c17=$(wf_gate_waive P1); c17_rc=$?
pj_req=$(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])).get("acceptance") or {}; print(a.get("required"), a.get("note"))' "$CW/works/phases/active/P1/phase.json")
[ "$c14_rc" = 0 ] && [ "$c16_rc" = 1 ] && printf '%s\n' "$c16" | grep -q 'requires operator acceptance and the gate is not cleared' \
  && [ "$(cf_status P1/phase.json)" != done ] \
  && ok "core flow: review --verdict pass is refused while the gate is required and uncleared, and the phase stays open" \
  || bad "core flow: the pass was not refused behind the required gate (rc $c14_rc/$c16_rc, phase $(cf_status P1/phase.json)) -- $c14 / $c16"
[ "$c17_rc" = 1 ] && printf '%s\n' "$c17" | grep -q 'gate P1 waive requires --note' && [ "$pj_req" = "True None" ] \
  && ok "core flow: gate waive without --note is refused and the gate stays required" \
  || bad "core flow: gate waive without --note was not refused (rc $c17_rc, acceptance $pj_req) -- $c17"
# (6) pr branch refuses a switch that would carry uncommitted tracked changes: the branch and phase.json stay as they were.
c18_h0=$(sha "$CW/works/phases/active/P1/phase.json"); printf 'b\n' >> "$CH/app.txt"
c18=$(wf_pr_branch P1 feat/core); c18_rc=$?
c18_br=$(cfg branch --show-current); c18_h1=$(sha "$CW/works/phases/active/P1/phase.json"); cfg checkout -q -- app.txt
[ "$c18_rc" = 1 ] && printf '%s\n' "$c18" | grep -q 'uncommitted tracked changes a switch would carry onto feat/core: app.txt' \
  && [ "$c18_br" = main ] && [ "$c18_h0" = "$c18_h1" ] && ! cfg rev-parse -q --verify refs/heads/feat/core >/dev/null \
  && ok "core flow: pr branch refuses a dirty tracked tree, cutting no branch and leaving phase.json byte-identical" \
  || bad "core flow: pr branch did not refuse the dirty switch (rc $c18_rc, on $c18_br) -- $c18"
# (7) validate exits 1 on a broken slice.json, and 0 again once it is restored.
c19_sj="$CW/works/phases/active/P1/slices/P1.S1/slice.json"; cp "$c19_sj" "$CFT/slice.json.keep"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); d["status"]="no-such-status"; json.dump(d, open(sys.argv[1], "w"))' "$c19_sj"
c19=$(wf_check); c19_rc=$?
cp "$CFT/slice.json.keep" "$c19_sj"; c20=$(wf_check); c20_rc=$?
[ "$c19_rc" = 1 ] && printf '%s\n' "$c19" | grep -q '^Workflow validation failed' && printf '%s\n' "$c19" | grep -q 'no-such-status' \
  && [ "$c20_rc" = 0 ] && printf '%s\n' "$c20" | grep -q '^Workflow validation passed' \
  && ok "core flow: validate exits 1 naming a slice.json with an unknown status, and passes once it is restored" \
  || bad "core flow: validate did not catch the broken slice.json (rc $c19_rc, then $c20_rc) -- $(printf '%s\n' "$c19" | tail -3)"
# (8) the pass after the gate is opened and cleared with the operator's words (a clear without them is refused, nothing
# written; a waive with its note passes a second phase), then the archive.
c21=$(wf_gate_open P1 "walk the toy"); c21_rc=$?; c22=$(wf_next)
c23_h0=$(sha "$CW/works/phases/active/P1/phase.json"); c23n=$(wf_gate_clear P1 --note "walked it"); c23n_rc=$?; c23_h1=$(sha "$CW/works/phases/active/P1/phase.json")
c23=$(wf_gate_clear P1 --words "accept" --note "walked it"); c23_rc=$?
c23_w=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["acceptance"].get("words"))' "$CW/works/phases/active/P1/phase.json")
[ "$c23n_rc" = 1 ] && printf '%s\n' "$c23n" | grep -q -- "--words \"<the operator's literal words>\" is required" && [ "$c23_h0" = "$c23_h1" ] \
  && [ "$c23_rc" = 0 ] && [ "$c23_w" = accept ] \
  && ok "core flow: gate clear without --words is refused with phase.json byte-identical; with --words \"accept\" it records the words" \
  || bad "core flow: gate clear's words guard broke (rc $c23n_rc/$c23_rc, words $c23_w) -- $c23n / $c23"
c24=$(wf_slice_finish P1.REVIEW "reviewed"); c25=$(wf_review_pass P1); c25_rc=$?; c25_st=$(cf_status P1/phase.json)
c26=$(wf_archive P1); c26_rc=$?
[ "$c21_rc$c23_rc$c25_rc$c26_rc" = 0000 ] && printf '%s\n' "$c22" | grep -q '^WAITING ON OPERATOR: phase P1 is pending' \
  && [ "$c25_st" = done ] && [ ! -d "$CW/works/phases/active/P1" ] && ls -d "$CW"/works/phases/archived/*_P1_* >/dev/null 2>&1 \
  && ok "core flow: an open gate halts next; cleared, the pass sets the phase done and phase archive moves it to archived/" \
  || bad "core flow: the cleared pass or the archive broke (rc $c21_rc/$c23_rc/$c25_rc/$c26_rc, phase $c25_st) -- $c22 / $c25 / $c26"
c27=$( { wf_new_phase --phase P2 --name "Waived" --objective "a waived pass" && wf_slice_finish P2.DECOMP "planned" \
  && wf_gate_waive P2 --note "nothing the operator can see" && wf_slice_start P2.REVIEW && wf_slice_finish P2.REVIEW "reviewed" && wf_review_pass P2; } 2>&1 ); c27_rc=$?
c28=$(wf_check); c28_rc=$?
[ "$c27_rc" = 0 ] && [ "$(cf_status P2/phase.json)" = done ] && [ "$c28_rc" = 0 ] \
  && ok "core flow: a gate waived with its note passes the second phase, and the workspace validates after the archive" \
  || bad "core flow: the waived pass or the final validate broke (rc $c27_rc/$c28_rc) -- $(printf '%s\n' "$c27" | tail -3) / $c28"

# ---------------------------------------------------------------------------
echo "== Test 27: the plugin path -- the engine and adapter copied to a folder outside any repo read a host's .sikstack/ from the host and from a nested repo's subfolder, take the workspace SIKSTACK_ROOT names, write nothing into their own folders own folder (no works/, no __pycache__), and with no workspace above exits 2 with one line =="
newtmp PLW; PLE="$PLW/plugin/scripts"; PLH="$PLW/host"; PLA="$PLH/app/sub"
{ mkdir -p "$PLE" "$PLW/plugin/adapters/claude_code" && cp "$PLUGIN"/scripts/*.py "$PLE/" && cp "$PLUGIN/adapters/claude_code/adapter.py" "$PLW/plugin/adapters/claude_code/" && cp -R "$PLUGIN/templates" "$PLW/plugin/" \
  && mkhost "$PLH" \
  && mkdir -p "$PLA" && git -C "$PLH/app" init -q; } > "$PLW/setup.txt" 2>&1 || bad "plugin path: the fixture failed -- $(tail -3 "$PLW/setup.txt")"
# pl <cwd> <args>: the copied engine under a python that would write bytecode beside it (no opt-out, no prefix).
pl() { _d=$1; shift; ( cd "$_d" && env -u PYTHONDONTWRITEBYTECODE -u SIKSTACK_ROOT -u WORKFLOW_CMD PYTHONPYCACHEPREFIX= python3 -X pycache_prefix= "$PLE/workflow.py" "$@" ) 2>&1; }
plr() { _r=$1; _d=$2; shift 2; ( cd "$_d" && env -u PYTHONDONTWRITEBYTECODE -u WORKFLOW_CMD SIKSTACK_ROOT="$_r" PYTHONPYCACHEPREFIX= python3 -X pycache_prefix= "$PLE/workflow.py" "$@" ) 2>&1; }
pl_sig() { ( cd "$PLW/plugin" && find . | LC_ALL=C sort ); }
pl_s0=$(pl_sig); pl_h=$(cd "$PLH" && pwd -P); pl_w=$(cd "$PLW" && pwd -P)
pl1=$(pl "$PLH" next); pl1_rc=$?
pl2=$(pl "$PLA" phase new --phase P1 --name Plugin --objective "made from a repo subfolder"); pl2_rc=$?
pl3=$(pl "$PLA" next); pl3_rc=$?
pl4=$(plr "$PLH" "$PLW" next); pl4_rc=$?
pl5=$(pl "$PLW" next); pl5_rc=$?
pl6=$( cd "$PLA" && env -u PYTHONDONTWRITEBYTECODE -u SIKSTACK_ROOT -u WORKFLOW_CMD -u ANTHROPIC_BASE_URL PYTHONPYCACHEPREFIX= python3 -X pycache_prefix= "$PLW/plugin/adapters/claude_code/adapter.py" route P1.DECOMP 2>&1 ); pl6_rc=$?
[ "$pl6_rc" = 0 ] && printf '%s\n' "$pl6" | grep -qx 'route=high' && printf '%s\n' "$pl6" | grep -qx 'subagent_type=sikstack:slice-executor' \
  && ok "plugin path: the adapter beside the copied engine routes a slice of the nested host from a repo's subfolder" \
  || bad "plugin path: the adapter did not route from the plugin folder (rc $pl6_rc) -- $pl6"
[ "$pl1_rc$pl2_rc$pl3_rc$pl4_rc" = 0000 ] && [ "$(printf '%s\n' "$pl1" | head -1)" = "nested_host=$pl_h" ] \
  && [ -f "$PLH/.sikstack/works/phases/active/P1/phase.json" ] && printf '%s\n' "$pl3" | grep -q 'P1' && [ "$pl4" = "$pl3" ] \
  && printf '%s\n' "$pl1" | grep -q ': sikstack repo convention ' \
  && ok "plugin path: the copied engine reads the nested host from the host, writes and reads it from a repo's subfolder (its hints name it sikstack), and SIKSTACK_ROOT names it from outside" \
  || bad "plugin path: the copied engine did not find the host (rc $pl1_rc/$pl2_rc/$pl3_rc/$pl4_rc) -- $(printf '%s\n' "$pl1" | head -2) / $pl2 / $(printf '%s\n' "$pl3" | head -2) / $(printf '%s\n' "$pl4" | head -2)"
[ "$pl5_rc" = 2 ] && [ "$pl5" = "no sikstack workspace found from $pl_w: run \`sikstack init\` in the repo (or set SIKSTACK_ROOT)" ] \
  && ok "plugin path: with no workspace above, the copied engine exits 2 with one line" \
  || bad "plugin path: with no workspace above (rc $pl5_rc) -- $pl5"
[ "$(pl_sig)" = "$pl_s0" ] && ok "plugin path: nothing was written into the engine's own folder (no works/, no __pycache__)" \
  || bad "plugin path: the engine wrote into its own folder -- $(diff <(printf '%s\n' "$pl_s0") <(pl_sig) | tail -5 | tr '\n' ' ')"
# 2.0.0: the design critic and drafter carry no engine harness (the canvas preview retired); they read the shipped
# check script's output. The script parses as an ES module wherever node runs (CI's runner has it).
if ! grep -q 'design_preview\|design_root\|```python' "$PLUGIN/agents/design-critic.md" "$PLUGIN/agents/design-drafter.md" \
    && [ -f "$PLUGIN/templates/design/check.mjs" ] && [ -f "$PLUGIN/templates/design/options.html" ] && [ -f "$PLUGIN/templates/design/TASTE.md" ]; then
  if command -v node >/dev/null 2>&1; then
    ck_out=$(node --check "$PLUGIN/templates/design/check.mjs" 2>&1) && ck_help=$(node "$PLUGIN/templates/design/check.mjs" --help 2>&1) \
      && printf '%s\n' "$ck_help" | grep -q 'usage: node check.mjs' && printf '%s\n' "$ck_help" | grep -q 'exit 2: a usage error, or a driver error' \
      && ok "the design agents bind no engine harness; templates/design/ ships check.mjs (it parses and prints its usage), options.html and TASTE.md" \
      || bad "templates/design/check.mjs does not parse or print its usage -- $ck_out $ck_help"
    # The layout check's run plan, without a browser: every page at every width, the default first and expecting the
    # first listed state, then each other state; every step opens in a fresh browser context (empty storage), so a
    # state one run stores never reaches the next run's label. Importing the script runs nothing.
    ck_plan=$(CK_FILE="$PLUGIN/templates/design/check.mjs" node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      const m = await import(pathToFileURL(process.env.CK_FILE).href);
      const assert = (c, msg) => { if (!c) { console.log("plan: " + msg); process.exit(1); } };
      const base = "http://127.0.0.1:9";
      const pages = m.pagesFromManifest({ pages: [
        { name: "Agenda", entry: "/ws/", states: ["recorded", { key: "behind" }, "loading"] },
        { name: "Item", entry: "/ws/a/1/", entries: ["/ws/a/1/", "/ws/a/2/"], states: ["open", "deferred"] },
        { name: "System", entry: "/system/" } ] }, false);
      assert(pages.length === 3 && pages[0].states.join() === "recorded,behind,loading" && pages[2].states === null, "pagesFromManifest " + JSON.stringify(pages));
      assert(m.pagesFromManifest({ pages: [{ entry: "/ws/a/1/", entries: ["/ws/a/1/", "/ws/a/2/"] }] }, true).length === 2, "all entries");
      pages[2].states = [];
      const steps = m.plan(pages, [1440, 390], base);
      const at = (s) => s.page + "@" + s.width + ":" + (s.state ?? "default") + ">" + (s.expect ?? "-");
      assert(steps.map(at).join(" ") === "/ws/@1440:default>recorded /ws/@1440:behind>behind /ws/@1440:loading>loading /ws/@390:default>recorded /ws/@390:behind>behind /ws/@390:loading>loading /ws/a/1/@1440:default>open /ws/a/1/@1440:deferred>deferred /ws/a/1/@390:default>open /ws/a/1/@390:deferred>deferred /system/@1440:default>- /system/@390:default>-", "order " + steps.map(at).join(" "));
      assert(steps.every((s) => s.fresh === true), "a step reuses a browser context");
      assert(steps[1].url === base + "/ws/?state=behind" && steps[3].url === base + "/ws/" && steps[3].state === null, "urls " + steps[1].url + " " + steps[3].url);
      const d = m.discoverStep({ name: "x", url: "/x/" }, 1440, base);
      assert(d.fresh === true && d.discover === true && d.expect === null, "discover step");
      console.log("plan ok");
    ' 2>&1)
    [ "$ck_plan" = "plan ok" ] \
      && ok "the layout check's run plan (no browser): pages x widths x states in order, the default first expecting the first listed state at every width, every step in a fresh browser context" \
      || bad "the layout check's run plan is wrong -- $ck_plan"
    # Nothing served: a driver error, exit 2, never a layout FAIL (playwright-cli absent is a driver error too).
    ck_port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
    newtmp CKT
    ck_drv=$(cd "$CKT" && node "$PLUGIN/templates/design/check.mjs" --base "http://127.0.0.1:$ck_port" --widths 390 --out "$CKT/out" / 2>&1); ck_drv_rc=$?
    [ "$ck_drv_rc" = 2 ] && printf '%s\n' "$ck_drv" | grep -q '^driver error: ' && ! printf '%s\n' "$ck_drv" | grep -q '^FAIL ' \
      && ok "the layout check with no server prints a driver error and exits 2, with no FAIL line" \
      || bad "the layout check with no server (rc=$ck_drv_rc) -- $ck_drv"
    # 0.7.0: the claude.ai canvas copy, without a browser. canvas.mjs --plan-only pairs shots already taken (fake PNG
    # headers here) with a fake manifest's runs and writes plan.json: one artboard per page x state, its widths side by
    # side, the first Main.dc.html, the artboards of a canvas page stacked apart, upload batches; over 40 pages, no
    # canvas pages. A folder written from the plan with /_blob/ urls passes tests/canvas_check.mjs (the orchestrator's
    # check), and the check fails on a placeholder left, a src not /_blob/, a missing file and an overlap.
    newtmp CVT
    cv_plan=$(CV_DIR="$CVT" CV_FILE="$PLUGIN/templates/design/canvas.mjs" CK_FILE="$PLUGIN/templates/design/check.mjs" node --input-type=module -e '
      import { pathToFileURL } from "node:url";
      import { mkdirSync, writeFileSync } from "node:fs";
      const cv = await import(pathToFileURL(process.env.CV_FILE).href), ck = await import(pathToFileURL(process.env.CK_FILE).href);
      const assert = (c, msg) => { if (!c) { console.log("canvas: " + msg); process.exit(1); } };
      assert(cv.SHOT_MAX === 7968 && cv.MAX_H === 8000, "a shot is cut at 8000 less its 32 px caption");
      const D = process.env.CV_DIR, manifest = { pages: [
        { name: "Workspace · Agenda", entry: "/ws/", states: ["recorded", "behind", "loading"] },
        { name: "All pages", entry: "/" },
        { name: "Item", entry: "/ws/a/1/", states: ["open", "deferred"] } ] };
      writeFileSync(D + "/manifest.json", JSON.stringify(manifest));
      const pages = ck.pagesFromManifest(manifest); pages[1].states = [];
      const shots = cv.shotList(ck.plan(pages, [1440, 390], "http://127.0.0.1:9"));
      assert(shots.length === 12 && new Set(shots.map((s) => s.file)).size === 12, "shots " + shots.length);
      mkdirSync(D + "/shots", { recursive: true });
      shots.forEach((s, i) => {
        const b = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
        b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii"); b.writeUInt32BE(s.width, 16); b.writeUInt32BE([900, cv.SHOT_MAX, 2400, 844][i % 4], 20);
        writeFileSync(D + "/" + s.file, b);
      });
      // over 40 pages: no canvas pages; the first artboard is still Main.dc.html
      const many = ck.pagesFromManifest({ pages: Array.from({ length: 41 }, (_, i) => ({ name: "P" + i, entry: "/p" + i + "/", states: ["a"] })) });
      const big = cv.planCanvas(cv.shotList(ck.plan(many, [1440], "http://x")).map((s) => Object.assign(s, { w: 1440, h: 900, bytes: 1 })), { title: "Big" });
      assert(big.canvas.pages.length === 0 && big.artboards.length === 41 && big.canvas.order[0] === "Main.dc.html"
        && Object.values(big.canvas.boards).every((b) => b.page === undefined && b.w === 1440 && b.h === 932), "over 40 pages");
      const small = cv.planCanvas(cv.shotList(ck.plan(many.slice(0, 40), [1440], "http://x")).map((s) => Object.assign(s, { w: 1440, h: 900, bytes: 1 })), { title: "Forty" });
      assert(small.canvas.pages.length === 40, "40 pages");
      console.log("fake ok");
    ' 2>&1)
    cv_run=$(node "$PLUGIN/templates/design/canvas.mjs" --plan-only "$CVT/shots" --manifest "$CVT/manifest.json" --out "$CVT" --title Fake 2>&1); cv_run_rc=$?
    cv_shape=$(CV_DIR="$CVT" node --input-type=module -e '
      import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
      const D = process.env.CV_DIR, p = JSON.parse(readFileSync(D + "/plan.json", "utf8"));
      const assert = (c, msg) => { if (!c) { console.log("plan: " + msg); process.exit(1); } };
      const { canvas, artboards, uploads } = p;
      assert(artboards.length === 6 && canvas.order.length === 6 && canvas.order[0] === "Main.dc.html" && artboards[0].file === "Main.dc.html", "order " + canvas.order);
      assert(artboards[0].title === "Workspace · Agenda · recorded" && artboards[3].file === "p02-all-pages--default.dc.html", "names " + artboards.map((a) => a.file + "=" + a.title));
      assert(canvas.pages.length === 3 && canvas.boards["Main.dc.html"].page === canvas.pages[0].id && !("notes" in canvas) && canvas.createdOnFiles.at === null, "index");
      const b0 = canvas.boards["Main.dc.html"], b1 = canvas.boards[canvas.order[1]];
      assert(b0.w === 1910 && b0.h === 932 && b1.h === 8000 && b1.y === b0.y + b0.h + 120 && b1.x === 0, "frames " + JSON.stringify([b0, b1]));
      assert(artboards.every((a) => (a.html.match(/@@shot:/g) || []).length === 2 && a.shots.every((s) => a.html.includes("@@shot:" + s + "@@"))), "placeholders");
      assert(artboards[0].html.includes(">1440 px</p>") && artboards[0].html.indexOf("1440 px") < artboards[0].html.indexOf("390 px"), "captions");
      assert(uploads.length === 1 && uploads[0].length === 12, "uploads");
      // a folder written from the plan, as the orchestrator writes it; then four broken copies
      const write = (dir, mut) => {
        mkdirSync(dir + "/project", { recursive: true });
        const c = JSON.parse(JSON.stringify(canvas)); c.createdOnFiles.at = "2026-11-25T00:00:00Z";
        let n = 0; const html = Object.fromEntries(artboards.map((a) => [a.file, a.html.replace(/@@shot:[^@]+@@/g, () => "/_blob/x" + n++)]));
        if (mut) mut(c, html);
        writeFileSync(dir + "/project/canvas.json", JSON.stringify(c));
        for (const [f, h] of Object.entries(html)) if (h !== null) writeFileSync(dir + "/project/" + f, h);
      };
      write(D + "/ok");
      write(D + "/left", (c, h) => { h[artboards[2].file] = artboards[2].html; });
      write(D + "/src", (c, h) => { h["Main.dc.html"] = h["Main.dc.html"].replace(/\/_blob\/x0/, "shots/a.png"); });
      write(D + "/gone", (c, h) => { h[artboards[4].file] = null; });
      write(D + "/over", (c, h) => { c.boards[c.order[1]].y = 100; });
      console.log("plan ok");
    ' 2>&1)
    cv_ok=$(node "$PLUGIN/tests/canvas_check.mjs" "$CVT/ok" 2>&1); cv_ok_rc=$?
    # each broken copy must fail (exit 1) naming its own problem
    cv_bad=""
    for cv_case in "left:a placeholder is left" "src:is not a /_blob/ url" "gone:missing file: project/" "over:frames overlap: "; do
      cv_o=$(node "$PLUGIN/tests/canvas_check.mjs" "$CVT/${cv_case%%:*}" 2>&1) && cv_bad="$cv_bad ${cv_case%%:*}:passed"
      printf '%s\n' "$cv_o" | grep -qF "${cv_case#*:}" || cv_bad="$cv_bad ${cv_case%%:*}:$(printf '%s' "$cv_o" | head -2 | tr '\n' '|')"
    done
    [ "$cv_plan" = "fake ok" ] && [ "$cv_run_rc" = 0 ] && printf '%s\n' "$cv_run" | grep -q '^artboards=6 shots=12 pages=3 widths=1440,390 cut=3 ' \
      && [ "$cv_shape" = "plan ok" ] \
      && ok "canvas.mjs --plan-only (no browser): plan.json holds one artboard per page x state with its widths side by side, Main.dc.html first, frames stacked 120 px apart, upload batches; over 40 pages, no canvas pages" \
      || bad "canvas.mjs's plan is wrong -- $cv_plan / rc=$cv_run_rc $cv_run / $cv_shape"
    [ "$cv_ok_rc" = 0 ] && [ "$cv_ok" = "canvas ok 6" ] && [ -z "$cv_bad" ] \
      && ok "canvas_check passes a folder written from the plan with /_blob/ urls, and fails a placeholder left, a src not /_blob/, a missing file and an overlap" \
      || bad "canvas_check -- ok: rc=$cv_ok_rc $cv_ok / broken:$cv_bad"
    # 0.7.0: the shoot in a real browser, over a fixture build tests/canvas_shoot.mjs serves itself: a lazy image and
    # iframe 6000 px down are drawn, a fixed tint covers a tall page's shot to its bottom row, a page that grows with
    # the window keeps its first measured height, a 100vh page keeps its own, and a cut shot fits its artboard whole.
    if command -v playwright-cli >/dev/null 2>&1; then
      cv_shoot=$(node "$PLUGIN/tests/canvas_shoot.mjs" 2>&1); cv_shoot_rc=$?
      [ "$cv_shoot_rc" = 0 ] && [ "$cv_shoot" = "shoot ok" ] \
        && ok "canvas.mjs's shots (a browser over a fixture): lazy images and iframes drawn, a fixed overlay over the whole shot, a page that tracks the window not grown, a cut shot whole in its artboard" \
        || bad "canvas.mjs's shots (rc=$cv_shoot_rc) -- $(printf '%s' "$cv_shoot" | head -4 | tr '\n' '|')"
    else ok "canvas.mjs's shots in a browser (playwright-cli absent: skipped)"; fi
  else ok "the design agents bind no engine harness; templates/design/ ships check.mjs, options.html and TASTE.md (node absent: parse skipped)"; fi
else bad "a design agent still carries the canvas harness, or templates/design/ is missing a file"; fi

# ---------------------------------------------------------------------------
echo "== Test 28: close -- the close's fixed order against a stub gh: an uncleared required gate is refused first, writing nothing; pr record --url stores the draft's head, updatedAt and comment count and pr sync says whether the PR is unchanged since; a PR changed since its draft stops at the re-read; an unchanged one records the pass and stops at Ready, then walks to the landing step; a red check stops at the CI step; merged, it stops for the one commit, then reads close=done; zero GitHub writes =="
# A toy workspace (sikstack init) in its own repo (CLH; CLW is its .sikstack/); gh is a stub on PATH that answers canned files, logs every call and refuses the rest.
newtmp CLT; CLW="$CLT/ws"; CLG="$CLT/gh"; mkdir -p "$CLG"
mkws CLW > "$CLT/install.txt" 2>&1 || bad "close: the fresh install failed"
cat > "$CLG/gh" <<'STUB'
#!/bin/sh
D=$(cd "$(dirname "$0")" && pwd); printf '%s\n' "$*" >> "$D/gh.log"
case "$1 $2" in
  "pr view") cat "$D/pr-$(basename "$3").json" 2>/dev/null || { echo "GraphQL: Could not resolve to a PullRequest" >&2; exit 1; };;
  "pr checks") cat "$D/checks.json"; exit "$(cat "$D/checks.rc" 2>/dev/null || echo 0)";;
  *) echo "stub: refused $*" >&2; exit 9;;
esac
STUB
chmod +x "$CLG/gh"
cl() { ( cd "$CLW" && PATH="$CLG:$PATH" python3 "$ENG" "$@" 2>&1 ); }
clg() { git -C "$CLW" "$@"; }; CLH="$CLT/ws"; hg() { git -C "$CLH" "$@"; }
# cpr <state> <isDraft> <head> <updatedAt> <comments>: the one PR's canned gh pr view answer.
cpr() { printf '{"state":"%s","isDraft":%s,"mergedAt":%s,"baseRefName":"main","headRefOid":"%s","reviewDecision":null,"updatedAt":"%s","comments":[%s]}\n' \
  "$1" "$2" "$([ "$1" = MERGED ] && echo '"2026-11-20T10:00:00Z"' || echo null)" "$3" "$4" "$5" > "$CLG/pr-1.json"; }
cck() { printf '[{"name":"smoke","bucket":"%s"}]\n' "$1" > "$CLG/checks.json"; }
clj() { python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d = d.get(k) if isinstance(d, dict) else (d[int(k)] if isinstance(d, list) and len(d) > int(k) else None)
print(json.dumps(d, sort_keys=True))' "$CLW/works/phases/active/P1/phase.json" "$1"; }
clsig() { cat "$CLW/works/phases/active/P1/phase.json" "$CLW/works/events.jsonl" | sha_stdin; }
H1=1111111111111111111111111111111111111111; H2=2222222222222222222222222222222222222222
{ echo a > "$CLH/app.txt" && hg add app.txt && hg commit -qm base \
  && cl phase new --phase P1 --name "Close" --objective toy && cl gate P1 require && cl slice finish P1.DECOMP --outcome cut \
  && clg add -A && clg commit -qm p1 && cl pr branch P1 --name feat/close && echo b >> "$CLH/app.txt" && hg commit -qam "feat: b" \
  && cl slice start P1.REVIEW && : > "$CLW/works/phases/active/P1/slices/P1.REVIEW/result.md"; } > "$CLT/setup.txt" 2>&1 \
  || bad "close: the toy phase failed to set up -- $(tail -3 "$CLT/setup.txt")"
# (1) the draft's state: pr record --url reads it; pr sync compares against it.
cpr OPEN true $H1 2026-11-20T01:00:00Z '{"body":"details"}'
c_rec=$(cl pr record P1 --url https://github.com/acme/close/pull/1); c_s1=$(cl pr sync P1)
cpr OPEN true $H2 2026-11-20T01:00:00Z '{"body":"details"}'; c_s2=$(cl pr sync P1); cpr OPEN true $H1 2026-11-20T01:00:00Z '{"body":"details"}'
if printf '%s\n' "$c_rec" | grep -qx 'pr_draft_state=host:feat/close head=1111111 updated_at=2026-11-20T01:00:00Z comments=1' \
    && [ "$(clj pr.branches.0.head)" = "\"$H1\"" ] && [ "$(clj pr.branches.0.updated_at)" = '"2026-11-20T01:00:00Z"' ] && [ "$(clj pr.branches.0.comments)" = 1 ] \
    && printf '%s\n' "$c_s1" | grep -qx 'unchanged_since_draft=yes pr=host:feat/close' && printf '%s\n' "$c_s2" | grep -qx 'unchanged_since_draft=no pr=host:feat/close' \
    && [ "$(clj pr.branches.0.head)" = "\"$H1\"" ]; then
  ok "close: pr record --url stores the draft's head, updatedAt and comment count from gh pr view; pr sync prints unchanged_since_draft=yes on the same answer and no on a moved head, keeping the draft's record"
else bad "close: the draft's state wrong -- $c_rec / $c_s1 / $c_s2 / head $(clj pr.branches.0.head)"; fi
# (2) an uncleared required gate is refused before anything is read or written; gate clear without --words is refused unwritten.
cl gate P1 open --walkthrough "walk it" > /dev/null; c_g0=$(clsig); : > "$CLG/gh.log"
c_gate=$(cl close P1); c_gate_rc=$?; c_nw=$(cl gate P1 clear); c_nw_rc=$?; c_g1=$(clsig)
if [ "$c_gate_rc" = 1 ] && printf '%s\n' "$c_gate" | grep -q "^close P1: refused -- the acceptance gate is required and not cleared with the operator's words" \
    && [ "$c_nw_rc" = 1 ] && printf '%s\n' "$c_nw" | grep -q -- '--words "<the operator.s literal words>" is required' && [ "$c_g0" = "$c_g1" ] && [ ! -s "$CLG/gh.log" ]; then
  ok "close: a required gate not cleared with words is refused first (no gh call, phase.json and events unchanged), and gate clear without --words is refused unwritten"
else bad "close: the uncleared gate was not refused first (rc $c_gate_rc/$c_nw_rc) -- $c_gate / $c_nw / gh: $(cat "$CLG/gh.log")"; fi
# (3) cleared with words; a PR changed since its draft stops at the re-read, with no pass recorded.
cl gate P1 clear --words "accept" > /dev/null
cpr OPEN true $H2 2026-11-20T02:00:00Z '{"body":"details"}'; c_chg=$(cl close P1); c_chg_rc=$?
if [ "$c_chg_rc" = 0 ] && [ "$(clj acceptance.words)" = '"accept"' ] && printf '%s\n' "$c_chg" | grep -qx 'step=gate state=done -- cleared with the words '"'accept'" \
    && printf '%s\n' "$c_chg" | grep -qx 'step=reread state=stop' && printf '%s\n' "$c_chg" | grep -q '^stop=reread do=host:feat/close changed since its draft: read it (gh pr view https://github.com/acme/close/pull/1 --json title,body,commits,reviews,comments)' \
    && printf '%s\n' "$c_chg" | grep -qx 'step=pass state=due' && [ "$(clj status)" != '"done"' ]; then
  ok "close: gate clear --words records the words; a PR whose head moved since its draft stops at the re-read (the pass not recorded, the read-and-re-record steps printed)"
else bad "close: a changed PR did not stop at the re-read (rc $c_chg_rc) -- $c_chg"; fi
# (4) unchanged: the pass is recorded and the close stops at Ready; Ready (updatedAt moved) and green, it walks to the landing step.
cpr OPEN true $H1 2026-11-20T01:00:00Z '{"body":"details"}'; c_rd=$(cl close P1)
cpr OPEN false $H1 2026-11-20T03:00:00Z '{"body":"details"}'; cck pass; cl pr team --record solo --evidence "one owner" > /dev/null
c_ld=$(cl close P1)
if printf '%s\n' "$c_rd" | grep -qx 'step=pass state=done -- recorded' && printf '%s\n' "$c_rd" | grep -qx 'stop=ready do=gh pr ready https://github.com/acme/close/pull/1; then sikstack close P1' \
    && [ "$(clj status)" = '"done"' ] && [ "$(clj review.status)" = '"pass"' ] \
    && printf '%s\n' "$c_ld" | grep -qx 'step=ci state=done -- host:feat/close green' && printf '%s\n' "$c_ld" | grep -qx 'step=land state=stop' \
    && printf '%s\n' "$c_ld" | grep -q '^stop=land do=land host:feat/close by its repo.s custom' && [ "$(clj pr.branches.0.ci)" = '"green"' ]; then
  ok "close: a PR unchanged since its draft records the pass and stops at Ready (gh pr ready printed, never run); Ready and green, it walks to the landing step"
else bad "close: the unchanged walk wrong -- $c_rd / $c_ld"; fi
# (5) a red check stops at the CI step, naming the reopen.
cck fail; c_red=$(cl close P1)
printf '%s\n' "$c_red" | grep -qx 'step=ci state=stop' && printf '%s\n' "$c_red" | grep -q '^stop=ci do=CI is red on host:feat/close: the phase is done' \
  && printf '%s\n' "$c_red" | grep -qx 'step=land state=due' && [ "$(clj pr.branches.0.ci)" = '"red"' ] \
  && ok "close: a red check stops at the CI step (recorded ci=red) and names the reopen on the operator's word" || bad "close: a red check did not stop at CI -- $c_red"
# (6) merged: the close records it, checks, and stops for the one commit; committed, it reads close=done.
cpr MERGED false $H1 2026-11-20T04:00:00Z '{"body":"details"}'; c_mg=$(cl close P1); clg add -A >/dev/null 2>&1; clg commit -qm "chore: close" >/dev/null 2>&1; c_dn=$(cl close P1)
if printf '%s\n' "$c_mg" | grep -qx 'step=land state=done' && printf '%s\n' "$c_mg" | grep -qx 'step=check state=done' && printf '%s\n' "$c_mg" | grep -q '^stop=commit do=' \
    && [ "$(clj pr.branches.0.state)" = '"merged"' ] && [ "$(printf '%s\n' "$c_dn" | tail -1)" = close=done ] && printf '%s\n' "$c_dn" | grep -qx 'step=commit state=done'; then
  ok "close: a merged PR passes the landing step, check runs, the close stops for the one workflow commit, and once committed reads close=done"
else bad "close: the merged walk wrong -- $c_mg / $c_dn"; fi
# (7) zero GitHub writes: every call the stub saw is a read.
c_w=$(grep -cvE '^(pr view https://github\.com/[^ ]+ --json [a-zA-Z,]+|pr checks https://github\.com/[^ ]+ --json name,bucket)$' "$CLG/gh.log")
[ "$c_w" = 0 ] && [ "$(grep -c '' "$CLG/gh.log")" -ge 5 ] && ok "close: zero GitHub writes -- every one of the $(grep -c '' "$CLG/gh.log") calls the stub gh saw is a read (pr view --json, pr checks --json)" \
  || bad "close: the stub gh saw a call that is not a read -- $(grep -vE '^pr (view|checks) ' "$CLG/gh.log" | head -3)"
# (8) a worktree phase: close in the worktree commits the pass on the branch itself (commit-pass: `--only` the phase folder
# and the generated works/ files; the operator's tracked edit, staged file and untracked file stay as they were), so
# worktree gate opens; merged in the main checkout, close walks merge and teardown to close=done. At root (gate required,
# and waived with the pass recorded earlier), nested and on a multi-repo host. A phase with no worktree prints no commit-pass.
cwt() {  # <root|nested|multi> <required|waived> <dir>: prints one line, "ok" or what went wrong
  ( export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.invalid GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.invalid
    H="$3/host"; L="$3/log.txt"; WF=.sikstack; mkdir -p "$3"
    g0() { mkdir -p "$1" && git -C "$1" init -q && git -C "$1" symbolic-ref HEAD refs/heads/main && echo a > "$1/a.txt" && git -C "$1" add -A && git -C "$1" commit -qm base; }
    case $1 in
      nested) g0 "$H" && mkhost "$H" > "$L" 2>&1 ;;
      multi) g0 "$H/alpha" && mkhost "$H" > "$L" 2>&1 && ( cd "$H" && python3 "$ENG" repo add alpha && python3 "$ENG" init ) >> "$L" 2>&1 ;;
    esac || { echo "install failed: $(tail -2 "$L")"; exit; }
    m() { ( cd "$H" && python3 "$ENG" "$@" 2>&1 ); }
    m phase new --phase P1 --name Wt --objective x >> "$L" && if [ "$2" = waived ]; then m gate P1 waive --note "no gate"; else m gate P1 require; fi >> "$L" \
      && git -C "$H/$WF" add -A && git -C "$H/$WF" commit -qm p1 || { echo "setup failed"; exit; }
    case $1 in root) m worktree start P1 ;; nested) m worktree start P1 --host-branch feat/wt ;;
      multi) m worktree start P1 --host-branch hb --repo alpha=feat/a --repo-base alpha=main ;; esac >> "$L" || { echo "worktree start failed"; exit; }
    WT=$(ls -d "$H"/.claude/worktrees/P1-*); BR=$(git -C "$WT/$WF" branch --show-current); w() { ( cd "$WT" && python3 "$ENG" "$@" 2>&1 ); }
    { w slice finish P1.DECOMP --outcome cut && w slice start P1.REVIEW && : > "$WT/$WF/works/phases/active/P1/slices/P1.REVIEW/result.md" \
      && w pr record P1 --waive --note "no product" && echo v1 > "$WT/$WF/op.md" && git -C "$WT/$WF" add -A && git -C "$WT/$WF" commit -qm "branch work" \
      && if [ "$2" = waived ]; then w slice finish P1.REVIEW --outcome done && w review P1 --verdict pass --reviewer smoke; \
         else w gate P1 open --walkthrough walk && w gate P1 clear --words accept; fi; } >> "$L" || { echo "branch work failed"; exit; }
    echo v2 > "$WT/$WF/op.md"; echo s > "$WT/$WF/op-staged.md"; git -C "$WT/$WF" add op-staged.md; echo u > "$WT/$WF/op-new.md"
    h0=$(git -C "$WT/$WF" rev-parse HEAD); dry=$(w close P1 --dry-run)
    [ "$(git -C "$WT/$WF" rev-parse HEAD)" = "$h0" ] && printf '%s\n' "$dry" | grep -q '^step=commit-pass state=due -- would commit ' || { echo "dry run: $dry"; exit; }
    c1=$(w close P1); files=$(git -C "$WT/$WF" show --name-only --format= HEAD | LC_ALL=C sort | tr '\n' ' ')
    want="works/backlog.md works/events.jsonl works/index.json works/phases/active/P1/phase.json works/phases/active/P1/phase.md works/phases/active/P1/slices/P1.REVIEW/slice.json works/state.json "
    printf '%s\n' "$c1" | grep -q "^step=commit-pass state=done -- committed [0-9a-f]\{7\} chore(works): record P1's pass on its branch" \
      && printf '%s\n' "$c1" | grep -q "^stop=merge do=the pass is committed on $BR; from this worktree: sikstack worktree gate P1 " \
      && [ "$(git -C "$WT/$WF" rev-parse HEAD^)" = "$h0" ] && [ "$files" = "$want" ] \
      && [ "$(git -C "$WT/$WF" status --porcelain | LC_ALL=C sort | tr '\n' '|')" = " M op.md|?? op-new.md|A  op-staged.md|" ] \
      || { echo "close in the worktree: $c1 / files: $files / status: $(git -C "$WT/$WF" status --porcelain | tr '\n' '|')"; exit; }
    w close P1 | grep -q "^step=commit-pass state=done -- nothing to commit: $BR already holds" && [ "$(git -C "$WT/$WF" rev-parse HEAD^)" = "$h0" ] \
      || { echo "a second close made another commit"; exit; }
    w worktree gate P1 | grep -qx 'GATE OPEN' || { echo "gate: $(w worktree gate P1 | grep '^GATE')"; exit; }
    git -C "$WT/$WF" add -A && git -C "$WT/$WF" commit -qm "operator: own files"   # the operator settles their own files
    [ -z "$(git -C "$H/$WF" status --porcelain -- works)" ] || { git -C "$H/$WF" add works && git -C "$H/$WF" commit -qm "chore(works): refresh"; }
    if ! git -C "$H/$WF" merge --no-ff -q "$BR" -m "merge(P1): Wt" >> "$L" 2>&1; then  # a generated file's conflict: take either side
      for f in $(git -C "$H/$WF" diff --name-only --diff-filter=U); do case $f in works/backlog.md|works/agenda.md|works/index.json|works/state.json) git -C "$H/$WF" checkout --theirs -- "$f" && git -C "$H/$WF" add -- "$f" ;; *) echo "merge conflict in $f"; exit ;; esac; done
      git -C "$H/$WF" commit -q --no-edit || { echo "merge commit failed"; exit; }
    fi
    c2=$(m close P1); git -C "$H/$WF" add works && git -C "$H/$WF" commit -qm "chore(works): close P1"; c3=$(m close P1)
    printf '%s\n' "$c2" | grep -qx 'step=merge state=done' && printf '%s\n' "$c2" | grep -qx 'step=teardown state=done' && printf '%s\n' "$c2" | grep -q '^stop=commit do=' \
      && [ "$(printf '%s\n' "$c3" | tail -1)" = close=done ] && [ ! -e "$WT" ] || { echo "main checkout: $c2 / $c3"; exit; }
    echo ok )
}
newtmp CWT
for c in "nested required" "nested waived" "multi required"; do
  set -- $c; r=$(cwt "$1" "$2" "$CWT/$1-$2" | tail -3)
  [ "$r" = ok ] && ok "close, a worktree phase ($1, gate $2): the close in the worktree commits the pass on the branch (only the phase folder and the generated works/ files, the operator's edited, staged and untracked files left as they were; --dry-run commits nothing, a second close nothing more), worktree gate opens, and after the merge the main checkout's close walks merge and teardown to close=done" \
    || bad "close, a worktree phase ($1, gate $2): $r"
done
! printf '%s\n' "$c_dn" | grep -q '^step=commit-pass' && [ "$(printf '%s\n' "$c_dn" | grep -c '^step=')" = 11 ] \
  && ok "close: a phase with no worktree prints the 11 steps, no commit-pass" || bad "close: a phase with no worktree printed a commit-pass step -- $c_dn"

# ---------------------------------------------------------------------------
echo "== Test 29: the plugin -- the engine roots in the nearest .sikstack/ and nowhere else, init is idempotent and hides .sikstack/, the guard hook's decisions, the SessionStart hook's card on every source (the resume card after it on a compaction), no shipped text or template names an unprefixed agent, a workflow/scripts path or the old layout, and a refusal ends with the one /sikstack:feedback line =="
# (a) The finder (P74 finding 1). A copy of the plugin in a scratch folder outside every workspace: its own folder
# holds templates/ (and once a works/), never a .sikstack/, so from inside it the engine exits 2 with one line and
# writes nothing. Two nested repos each with a .sikstack/ (the inner made first: init refuses inside another workspace): a folder deep in the inner one roots there, a folder in
# the outer one outside the inner roots in the outer; SIKSTACK_ROOT names either; an old workflow/ install gets one
# pointer line.
newtmp FDW; cp -R "$PLUGIN" "$FDW/plugin"; mkdir -p "$FDW/plugin/works/phases"   # the old rule's bait
FE="$FDW/plugin/scripts/workflow.py"
fd_sig() { ( cd "$FDW" && find . -path ./outer -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done ); }
fd0=$(fd_sig)
fd_out=$( cd "$FDW/plugin" && python3 "$FE" next 2>&1 ); fd_rc=$?
fd_out2=$( cd "$FDW/plugin/scripts" && python3 "$FE" phase new --name x --objective y 2>&1 ); fd_rc2=$?
[ "$fd_rc" -eq 2 ] && [ "$fd_rc2" -eq 2 ] && [ "$(printf '%s\n' "$fd_out" | wc -l | tr -d ' ')" = 1 ] \
  && printf '%s\n' "$fd_out" | grep -q '^no sikstack workspace found from .*: run `sikstack init` in the repo (or set SIKSTACK_ROOT)$' \
  && [ "$(fd_sig)" = "$fd0" ] && [ ! -e "$FDW/plugin/.sikstack" ] && [ -z "$(find "$FDW/plugin" -name __pycache__)" ] \
  && ok "from inside the plugin's own folder (works/ planted there too), next and phase new exit 2 with one line naming sikstack init and write nothing" \
  || bad "the engine rooted in, or wrote into, its own folder (rc=$fd_rc/$fd_rc2) -- $fd_out / $fd_out2"
mkhost "$FDW/outer/a/inner" >/dev/null 2>&1 && mkhost "$FDW/outer" >/dev/null 2>&1 \
  && ( cd "$FDW/outer" && python3 "$FE" phase new --phase P1 --name Outer --objective o >/dev/null 2>&1 ) \
  && ( cd "$FDW/outer/a/inner" && python3 "$FE" phase new --phase P7 --name Inner --objective i >/dev/null 2>&1 ) \
  && mkdir -p "$FDW/outer/a/inner/src/deep" "$FDW/outer/b/c" || bad "finder probe: could not build the nested repos"
fd_in=$( cd "$FDW/outer/a/inner/src/deep" && python3 "$FE" next 2>&1 ); fd_out_=$( cd "$FDW/outer/b/c" && python3 "$FE" next 2>&1 )
fd_mid=$( cd "$FDW/outer/a" && python3 "$FE" next 2>&1 ); fd_st=$( cd "$FDW/outer/a/inner/.sikstack/works" && python3 "$FE" next 2>&1 )
fd_env=$( cd "$FDW" && SIKSTACK_ROOT="$FDW/outer/a/inner" python3 "$FE" next 2>&1 ); fd_env2=$( cd "$FDW" && SIKSTACK_ROOT="$FDW/outer/.sikstack" python3 "$FE" next 2>&1 )
fd_bad=$( cd "$FDW" && SIKSTACK_ROOT="$FDW/plugin" python3 "$FE" next 2>&1 ); fd_bad_rc=$?
printf '%s\n' "$fd_in" | grep -qx 'current_phase=P7' && printf '%s\n' "$fd_out_" | grep -qx 'current_phase=P1' \
  && printf '%s\n' "$fd_mid" | grep -qx 'current_phase=P1' && printf '%s\n' "$fd_st" | grep -qx 'current_phase=P7' \
  && printf '%s\n' "$fd_env" | grep -qx 'current_phase=P7' && printf '%s\n' "$fd_env2" | grep -qx 'current_phase=P1' \
  && [ "$fd_bad_rc" -eq 2 ] && printf '%s\n' "$fd_bad" | grep -q 'names no .sikstack/ folder' \
  && ok "the engine roots in the nearest .sikstack/ above the cwd (inner from deep in the inner repo and from inside its own .sikstack/, outer elsewhere), SIKSTACK_ROOT names either, and one naming no .sikstack/ exits 2" \
  || bad "the finder rooted wrong -- inner: $fd_in / outer: $fd_out_ / mid: $fd_mid / state: $fd_st / env: $fd_env / $fd_env2 / bad: $fd_bad"
mkdir -p "$FDW/old/workflow/works/phases/active" "$FDW/old/repo" && printf '{"schema": 1}\n' > "$FDW/old/workflow/.agentic-nested.json"
fd_old=$( cd "$FDW/old/repo" && python3 "$FE" next 2>&1 ); fd_old_rc=$?
[ "$fd_old_rc" -eq 2 ] && [ "$(printf '%s\n' "$fd_old" | wc -l | tr -d ' ')" = 1 ] && printf '%s\n' "$fd_old" | grep -q 'holds an old workflow/ install.*sikstack migrate' \
  && [ ! -e "$FDW/old/.sikstack" ] && ok "an old workflow/ install above the cwd gets one line pointing at sikstack migrate, exit 2, nothing written" \
  || bad "the old layout was read or not pointed at migrate (rc=$fd_old_rc) -- $fd_old"
# (b) init: a fresh repo gets .sikstack/ (its own repo, one commit), the exclude line once, and a second run changes
# nothing; the product repo's status stays clean; outside git, or inside another workspace, it refuses unwritten.
newtmp INW; git -C "$INW" init -q && git -C "$INW" commit -q --allow-empty -m start
in1=$( cd "$INW" && python3 "$ENG" init 2>&1 ); in1_rc=$?
in_sig() { ( cd "$INW" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done; sha .git/info/exclude ); }
in_s1=$(in_sig); in2=$( cd "$INW" && mkdir -p sub && cd sub && python3 "$ENG" init 2>&1 ); in2_rc=$?; in_s2=$(in_sig)
[ "$in1_rc" -eq 0 ] && [ "$in2_rc" -eq 0 ] && printf '%s\n' "$in1" | grep -q '^initialized: ' && printf '%s\n' "$in2" | grep -q '^already initialized: ' \
  && [ "$in_s1" = "$in_s2" ] && [ "$(grep -cx '/.sikstack/' "$INW/.git/info/exclude")" = 1 ] && [ -z "$(git -C "$INW" status --porcelain)" ] \
  && [ "$(git -C "$INW/.sikstack" log --oneline | wc -l | tr -d ' ')" = 1 ] && [ -z "$(git -C "$INW/.sikstack" status --porcelain)" ] \
  && [ -f "$INW/.sikstack/config.toml" ] && [ -f "$INW/.sikstack/works/backlog.md" ] && [ -f "$INW/.sikstack/docs/current/qa.md" ] \
  && [ ! -e "$INW/.sikstack/works/templates" ] && grep -q '"host_root": ".."' "$INW/.sikstack/.agentic-nested.json" \
  && ok "sikstack init makes .sikstack/ (its own repo, one commit; config.toml, works/backlog.md, the five docs, no templates copy), one /.sikstack/ exclude line, a clean product status; run again from a subfolder it changes nothing" \
  || bad "init or its second run went wrong (rc=$in1_rc/$in2_rc) -- $in1 / $in2 / $(git -C "$INW" status --porcelain)"
newtmp INX; inx=$( cd "$INX" && python3 "$ENG" init 2>&1 ); inx_rc=$?
mkdir -p "$INW/nested" && git -C "$INW/nested" init -q
iny=$( cd "$INW/nested" && python3 "$ENG" init 2>&1 ); iny_rc=$?
[ "$inx_rc" -eq 2 ] && printf '%s\n' "$inx" | grep -q 'not in a git repo' && [ -z "$(ls -A "$INX")" ] \
  && [ "$iny_rc" -eq 2 ] && printf '%s\n' "$iny" | grep -q 'already inside the workspace at' && [ ! -e "$INW/nested/.sikstack" ] \
  && ok "init refuses outside git, and inside another workspace's tree, with one line and nothing written" \
  || bad "init's refusals wrong (rc=$inx_rc/$iny_rc) -- $inx / $iny"
# (c) the guard hook (R5: a plugin's settings permissions are ignored): its PreToolUse JSON for each form.
gd() { python3 -c 'import json,sys; print(json.dumps({"hook_event_name":"PreToolUse","tool_name":sys.argv[1],"tool_input":{"command":sys.argv[2]}}))' "$1" "$2" \
  | python3 "$PLUGIN/hooks/guard.py" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.loads(t)["hookSpecificOutput"]["permissionDecision"] if t.strip() else "pass")'; }
gd_bad=""
for c in 'git push --force origin main' 'git push -f' 'git push -fu origin x' 'git -C repo push --force-with-lease origin x' 'git push --force-with-lease=main:abc origin' \
    'git push origin +main' 'git push origin +HEAD:refs/heads/x' 'rm -rf build' 'rm -fr build' 'rm -r -f build' 'rm -Rf /tmp/x' 'sudo rm -rf /' 'cd x && rm -rf y' 'echo ok; git push --force'; do
  [ "$(gd Bash "$c")" = deny ] || gd_bad="$gd_bad [deny? $c]"
done
for c in 'playwright-cli --version' 'playwright-cli -s=s goto http://127.0.0.1:3030' 'npm install -g @playwright/cli@0.1.25'; do
  [ "$(gd Bash "$c")" = allow ] || gd_bad="$gd_bad [allow? $c]"
done
for c in 'git push origin main' 'git push -u origin feat/x' 'git push origin --delete feat/x' 'rm -r build' 'rm -f x' 'ls -la' 'playwright-cli open && curl x' 'echo --force'; do
  [ "$(gd Bash "$c")" = pass ] || gd_bad="$gd_bad [pass? $c]"
done
[ "$(gd Read 'rm -rf /')" = pass ] || gd_bad="$gd_bad [non-Bash]"
gd_reason=$(python3 -c 'import json; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"rm -rf x"}}))' | python3 "$PLUGIN/hooks/guard.py")
gd_junk=$(printf 'not json' | python3 "$PLUGIN/hooks/guard.py"; echo "rc=$?")
[ -z "$gd_bad" ] && printf '%s\n' "$gd_reason" | python3 -c 'import json,sys; o=json.load(sys.stdin)["hookSpecificOutput"]; assert o["hookEventName"]=="PreToolUse" and o["permissionDecisionReason"].startswith("sikstack guard: ") and "\n" not in o["permissionDecisionReason"], o' \
  && [ "$gd_junk" = "rc=0" ] && python3 -c 'import json,sys; h=json.load(open(sys.argv[1]))["hooks"]; assert [m["matcher"] for m in h["PreToolUse"]] == ["Bash"] and len(h["SessionStart"]) == 1, h' "$PLUGIN/hooks/hooks.json" \
  && ok "the guard denies every force-push form (--force, -f, --force-with-lease, a +refspec) and rm -rf / -fr / -r -f, each with a one-line reason; allows playwright-cli and its pinned install alone; passes the rest, other tools and bad input through" \
  || bad "the guard hook decided wrong --$gd_bad / $gd_reason / $gd_junk"
# (d) the SessionStart hook on every source: a fresh, resumed, cleared, compacted or forked session gets the card
# (the contract, at most 4,096 B) inside a workspace; a compaction gets the card and then the resume card in one hook,
# within Claude Code's 10,000-character cap on a hook's stdout (an oversized resume card is cut, never the card);
# outside any workspace one line, never a resume card. hooks.json's one SessionStart entry names all five sources,
# so dropping one fails here. Each source runs as Claude Code would: every entry whose matcher matches it.
if python3 - "$PLUGIN" "$FDW/outer/a/inner/src/deep" "$FDW/plugin" <<'PY'
import json, os, re, subprocess, sys
from pathlib import Path
plugin, inside, outside = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
contract = (plugin / "contract.md").read_text(encoding="utf-8").rstrip("\n")
entries = json.loads((plugin / "hooks/hooks.json").read_text())["hooks"]["SessionStart"]
env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PROJECT_DIR", "CLAUDE_PLUGIN_DATA")}
def session(source, cwd):
    out = []
    for e in entries:
        m = e.get("matcher", "")
        if m in ("", "*") or re.fullmatch(m, source):
            for h in e["hooks"]:
                p = subprocess.run(h["command"].replace("${CLAUDE_PLUGIN_ROOT}", str(plugin)), shell=True, env=env,
                                   input=json.dumps({"session_id": "t", "source": source, "cwd": cwd}), capture_output=True, text=True)
                assert p.returncode == 0, (source, p.returncode, p.stderr)
                out.append(p.stdout)
    return out
for source in ("startup", "resume", "clear", "compact", "fork"):
    out = session(source, inside)
    assert len(out) == 1, (source, len(out))  # one hook per source: the order inside it is the order the session sees
    text = out[0]
    assert text.startswith(contract + "\n\n"), (source, text[:200])
    card = text.split("\ncompaction=done source=compact\n")[0]
    assert len(card.encode("utf-8")) <= 4096 and card.count("\n") == contract.count("\n") + 3, (source, len(card.encode()))
    assert "Nothing is pushed, merged or paid for without the operator's word" in card, source
    if source == "compact":
        assert "\ncompaction=done source=compact\n" in text and re.search(r"^pointer: phase P7 ", text, re.M), text[-600:]
        assert text.index("compaction=done") > text.index("Reports are truthful"), "the resume card came before the card"
    else:
        assert "compaction=done" not in text and "pointer:" not in text, (source, text[-300:])
    assert len(text) <= 10000, (source, len(text))
for source in ("startup", "compact", "clear"):
    out = "".join(session(source, outside))
    assert out.count("\n") == 1 and "no .sikstack/ workspace is here" in out and "compaction=done" not in out, (source, out)
# the cap: an oversized resume card is cut to fit, the card kept whole
sys.path.insert(0, str(plugin / "hooks")); import session_start as ss
big = ss.fit("C" * 4000 + "\n", "".join(f"line {i} " + "x" * 90 + "\n" for i in range(200)))
assert len(big) <= ss.HOOK_CAP and big.startswith("C" * 4000 + "\n") and big.rstrip("\n").endswith(ss.CUT_LINE), len(big)
small = ss.fit("C\n", "r\n"); assert small == "C\n\nr\n", repr(small)
PY
then ok "the SessionStart hook prints the card (the contract, at most 4,096 B) on startup, resume, clear, compact and fork inside a workspace; on compact the card comes first and the resume card after it, within the 10,000-character cap (an oversized resume card is cut); outside a workspace one line and no resume card"
else bad "the SessionStart hook missed a source, an order or a cap (above)"; fi
# (e) the shipped text (C3): no skill, agent, contract or template line names the engine by a workflow/scripts path or a
# script path, a sync-agents step, or a plugin agent without its sikstack: prefix (a bare Explore reaches the
# built-in one); the bin/ commands exist and run.
# The templates `init` seeds (docs, works, config.toml, gitattributes) get the engine-path and old-layout checks too: a
# planted `python3 scripts/workflow.py` line in a copy's templates fails the scan.
shipped_scan() { python3 - "$1" <<'PY'
import re, sys
from pathlib import Path
root = Path(sys.argv[1])
texts = sorted(list((root / "skills").rglob("*.md")) + list((root / "agents").glob("*.md")) + [root / "contract.md"])
templates = sorted(f for f in (root / "templates").rglob("*") if f.is_file())
agents = sorted(p.stem for p in (root / "agents").glob("*.md"))
assert agents == ["Explore", "code-reader", "design-critic", "design-drafter", "pr-reader", "slice-executor"], agents
assert len(templates) >= 9, [str(t) for t in templates]
hyph = "|".join(a for a in agents if "-" in a)
problems = []
for f in texts + templates:
    for n, line in enumerate(f.read_text(encoding="utf-8").split("\n"), 1):
        where = f"{f.relative_to(root)}:{n}"
        if re.match(r"^name:\s", line):
            continue
        if re.search(r"workflow/scripts|scripts/workflow\.py|adapters/claude_code/adapter\.py|(?<![\w-])adapter\.py\b|sync-agents|executors\.toml", line):
            problems.append(f"{where}: engine path: {line.strip()[:120]}")
        # the old layout: the old state folder (named only as "an old workflow/ install"); works/backlog.md, the old
        # engine's dashboard path, is the plugin's own again since 0.8.0
        if re.search(r"(?<!old )(?<![\w./-])workflow/", line):
            problems.append(f"{where}: old layout: {line.strip()[:120]}")
        if f in templates:
            continue
        if re.search(r"(?<![\w:/.-])(" + hyph + r")(?![\w-]|\.md)", line):
            problems.append(f"{where}: unprefixed agent: {line.strip()[:120]}")
        if re.search(r"`Explore`|subagent_type[:=]\s*`?(Explore|" + hyph + r")\b", line):
            problems.append(f"{where}: unprefixed Explore or subagent_type: {line.strip()[:120]}")
assert not problems, "\n".join(problems)
PY
}
newtmp SCW; cp -R "$PLUGIN" "$SCW/plugin"; printf 'Run `python3 scripts/workflow.py next` first.\n' >> "$SCW/plugin/templates/docs/qa.md"
sc_plant=$(shipped_scan "$SCW/plugin" 2>&1); sc_plant_rc=$?
if shipped_scan "$PLUGIN" && [ "$sc_plant_rc" -ne 0 ] && printf '%s\n' "$sc_plant" | grep -q 'templates/docs/qa.md:[0-9]*: engine path: Run `python3 scripts/workflow.py next`'; then
  ok "no shipped skill, agent, contract or template line names workflow/scripts, a script path, sync-agents, executors.toml or the old workflow/ layout, nor (outside templates) a plugin agent without its sikstack: prefix; a planted template line fails the scan"
else bad "a shipped line names an engine path, the old layout or an unprefixed plugin agent, or the planted template line passed (rc=$sc_plant_rc) -- $sc_plant"; fi
bin_out=$( cd "$FDW/outer/b/c" && "$SK" next 2>&1 | grep -x 'current_phase=P1'; cd "$FDW/outer/b/c" && "$SKA" route --explore 2>&1 | grep -x 'subagent_type=sikstack:Explore' )
[ -x "$SK" ] && [ -x "$SKA" ] && [ "$(printf '%s\n' "$bin_out" | wc -l | tr -d ' ')" = 2 ] \
  && ok "bin/sikstack and bin/sikstack-adapter run the engine and the adapter as bare commands" || bad "the bin/ commands did not run -- $bin_out"
# (g) the friction offer: a refused or failed command (exit 1 or 2) ends with one line naming /sikstack:feedback, once,
# on stderr; never on a success, an advice exit, a dry run, a check's verdict, feedback itself, the finder's
# no-workspace line, a run nested in another engine run, or the SessionStart hook; the contract and sik-mode say to
# relay it once and send only on a yes.
unset SIKSTACK_NO_OFFER   # the offer as a user's session sees it; set again after (g)
OFFER="If this looks like sikstack's fault, \`/sikstack:feedback\` drafts a short report and sends it only on a yes."
of() { ( cd "$FDW/outer/b/c" && "$@" ) 2>&1 >/dev/null; }
ofn() { printf '%s\n' "$1" | grep -cxF "$OFFER"; }  # the offer line itself (the hook's card names the skill in the contract)
of_ref=$(of "$SK" slice status P9.S1 done); of_use=$(of "$SK" no-such-command); of_crash=$(of "$SKA" route NOPE.S9)
of_ok=$(of "$SK" next); of_adv=$(of "$SK" gate P1); of_help=$(of "$SK" slice --help)
of_dry=$(of "$SK" section P1 Nope --to-topic x --dry-run); of_mig=$(of "$SK" migrate)
printf '## Summary\n\nSee P51.\n' > "$FDW/leaky.md"; of_pr=$(of "$SK" pr check --body "$FDW/leaky.md")
of_fb=$(of "$SK" feedback --data-dir "$FDW/nodata" --message hi); of_none=$(cd "$FDW" && "$SK" next 2>&1)
of_nest=$(cd "$FDW/outer/b/c" && SIKSTACK_NO_OFFER=1 "$SK" slice status P9.S1 done 2>&1)
of_hook=$(cd "$FDW" && printf '{"source":"compact","cwd":"%s"}' "$FDW/outer/b/c" | env -u CLAUDE_PROJECT_DIR python3 "$PLUGIN/hooks/session_start.py" 2>&1)
if [ "$(ofn "$of_ref")" = 1 ] && [ "$(printf '%s\n' "$of_ref" | tail -1)" = "$OFFER" ] && printf '%s\n' "$of_ref" | head -1 | grep -q '^slice not found: P9.S1$' \
    && [ "$(ofn "$of_use")" = 1 ] && [ "$(printf '%s\n' "$of_use" | tail -1)" = "$OFFER" ] && [ "$(ofn "$of_crash")" = 1 ] \
    && [ "$(ofn "$of_ok$of_adv$of_help$of_dry$of_mig$of_pr$of_fb$of_none$of_nest$of_hook")" = 0 ] && ( cd "$FDW/outer/b/c" && "$SK" pr check --body "$FDW/leaky.md" 2>/dev/null ) | grep -q '^leak=phase_id:P51 ' \
    && grep -qF -- '- An engine refusal or error ends with a `/sikstack:feedback` line: relay it once; send only on a yes.' "$PLUGIN/contract.md" \
    && grep -qF 'relay that offer to the operator once in the session' "$PLUGIN/skills/sik-mode/SKILL.md" \
    && ! grep -q 'sikstack:feedback' "$PLUGIN/hooks/guard.py"; then
  ok "a refused command, a usage error and an adapter refusal each end with the one /sikstack:feedback line; a success, gate's advice, --help, a dry run, migrate's dry run, pr check's verdict, feedback, the no-workspace line, a nested run and the SessionStart hook print none; the contract and sik-mode say relay once, send only on a yes"
export SIKSTACK_NO_OFFER=1
else export SIKSTACK_NO_OFFER=1; bad "the friction offer -- refused=[$of_ref] usage=[$(printf '%s' "$of_use" | tail -1)] adapter=[$of_crash] ok=[$of_ok] advice=[$of_adv] dry=[$of_dry] migrate=[$of_mig] pr=[$(printf '%s' "$of_pr" | tail -2)] fb=[$of_fb] none=[$of_none] nested=[$of_nest]"; fi
# (f) the plugin's manifest: valid JSON naming sikstack with a semver version; `claude plugin validate` where the CLI is installed (CI has none).
if python3 -c 'import json,re,sys; m=json.load(open(sys.argv[1])); assert m["name"]=="sikstack" and re.fullmatch(r"\d+\.\d+\.\d+", m["version"]), m' "$PLUGIN/.claude-plugin/plugin.json"; then
  ok "plugin.json names sikstack with a semver version"
else bad "plugin.json is not a sikstack manifest with a semver version"; fi
if command -v claude >/dev/null 2>&1; then
  pv=$(claude plugin validate "$PLUGIN" 2>&1); pv_rc=$?
  [ "$pv_rc" = 0 ] && ok "claude plugin validate passes on the plugin folder" || bad "claude plugin validate failed (rc $pv_rc) -- $(printf '%s\n' "$pv" | tail -3)"
else echo "note: claude CLI not installed; plugin validate skipped"; fi

# ---------------------------------------------------------------------------
echo "== Test 30: setup, the registration retry and the rules card -- setup registers {install_id, email, plugin_version} once per new email under one install id and sets only autoCompactWindow in the user settings; with the server down it finishes, marks the registration pending, and the next SessionStart hook run registers it and clears the mark; the card is the contract inside a .sikstack/ repo (at most 4,096 B) and one line elsewhere =="
newtmp SUW; printf 'setup-smoke\n' > "$SUW/key"
su_fake() {  # su_fake <name> [port]: a fake server logging into $SUW/<name>/, its port in $SUW/<name>.port; prints its PID
  python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$SUW/$1" --port-file "$SUW/$1.port" --key-file "$SUW/key" --project p --org o \
    --lifetime 300 ${2:+--port "$2"} > "$SUW/$1.txt" 2>&1 &
  _p=$!; for _ in $(seq 1 100); do [ -s "$SUW/$1.port" ] && break; sleep 0.1; done; echo "$_p"
}
su_reqs() { [ -f "$SUW/$1/requests.jsonl" ] && grep -c '"route": "installs"' "$SUW/$1/requests.jsonl" || echo 0; }
su_setup() { CLAUDE_CONFIG_DIR="$SUW/cfg" SIKSTACK_SERVER="$1" python3 "$ENG" setup --email "$2" --data-dir "$3"; }
mkdir -p "$SUW/cfg" && printf '{\n  "model": "opus",\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)"\n    ]\n  },\n  "enabledPlugins": {\n    "x@y": true\n  }\n}\n' > "$SUW/cfg/settings.json"
cp "$SUW/cfg/settings.json" "$SUW/settings.before"
su_up=$(su_fake up); SUS="http://127.0.0.1:$(cat "$SUW/up.port")"
# (a) server up: one registration with exactly the three fields; the settings gain one line; a re-run sends nothing and
# keeps the id; a new email registers again under the same id.
( cd "$SUW" && su_setup "$SUS" a@example.com "$SUW/data" ) > "$SUW/a1.txt" 2>&1; su_rc=$?
su_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["install_id"])' "$SUW/data/install.json" 2>/dev/null)
( cd "$SUW" && su_setup "$SUS" a@example.com "$SUW/data" ) > "$SUW/a2.txt" 2>&1; su_rc2=$?; su_n2=$(su_reqs up)
( cd "$SUW" && su_setup "$SUS" b@example.com "$SUW/data" ) > "$SUW/a3.txt" 2>&1; su_rc3=$?
su_id3=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["install_id"])' "$SUW/data/install.json" 2>/dev/null)
su_body=$(python3 - "$SUW/up/requests.jsonl" "$su_id" "$PLUGIN/.claude-plugin/plugin.json" <<'PY'
import json, sys
reqs = [json.loads(l) for l in open(sys.argv[1]) if '"route": "installs"' in l]
version = json.load(open(sys.argv[3]))["version"]
want = [{"install_id": sys.argv[2], "email": e, "plugin_version": version} for e in ("a@example.com", "b@example.com")]
ok = [r["body"] for r in reqs] == want and all(r["authorization"] is None and r["content_type"] == "application/json" for r in reqs)
print("ok" if ok else f"bad {[r['body'] for r in reqs]} want {want}")
PY
)
su_diff=$(diff "$SUW/settings.before" "$SUW/cfg/settings.json" | grep '^[<>]')
su_json=$(python3 -c 'import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); a["autoCompactWindow"]=500000; print(a==b)' "$SUW/settings.before" "$SUW/cfg/settings.json")
[ "$su_rc" = 0 ] && [ "$su_rc2" = 0 ] && [ "$su_rc3" = 0 ] && [ -n "$su_id" ] && [ "$su_id" = "$su_id3" ] && [ "$su_n2" = 1 ] && [ "$su_body" = ok ] \
  && grep -q '^registration: a@example.com registered with ' "$SUW/a1.txt" && grep -q 'already registered' "$SUW/a2.txt" \
  && [ "$su_diff" = '>   "autoCompactWindow": 500000,' ] && [ "$su_json" = True ] && grep -q '^compaction window: already 500k in ' "$SUW/a2.txt" && grep -q '^compaction window: set to 500k in ' "$SUW/a1.txt" && grep -qE '^install id: [0-9a-f-]{36} \(made now\)$' "$SUW/a1.txt" && grep -qE '^install id: [0-9a-f-]{36} \(kept\)$' "$SUW/a2.txt" \
  && [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$SUW/data/registration.json")" = registered ] \
  && ok "setup registers exactly {install_id, email, plugin_version} (no auth) once per new email under one install id, and adds only the autoCompactWindow line to the user settings" \
  || bad "setup with the server up -- rc=$su_rc/$su_rc2/$su_rc3 id=$su_id/$su_id3 reqs-after-rerun=$su_n2 body=$su_body diff=[$su_diff] json=$su_json $(cat "$SUW/a1.txt")"
# (b) server down: setup still exits 0 and marks the registration pending; the next SessionStart hook run (the server up
# again at that address) registers it and clears the mark; a later run sends nothing.
su_gone=$(su_fake gone); su_gp=$(cat "$SUW/gone.port"); kill "$su_gone" 2>/dev/null; wait "$su_gone" 2>/dev/null
( cd "$SUW" && su_setup "http://127.0.0.1:$su_gp" c@example.com "$SUW/data2" ) > "$SUW/b1.txt" 2>&1; su_rc=$?
su_state=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$SUW/data2/registration.json" 2>/dev/null)
su_back=$(su_fake back "$su_gp")
su_hook() { printf '{"source":"startup","cwd":"%s"}' "$SUW" | env -u CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_DATA="$SUW/data2" python3 "$PLUGIN/hooks/session_start.py"; }
su_h1=$(su_hook; echo "rc=$?"); su_n1=$(su_reqs back)
su_state2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["state"])' "$SUW/data2/registration.json" 2>/dev/null)
su_h2=$(su_hook; echo "rc=$?"); su_nb=$(su_reqs back)
kill "$su_back" "$su_up" 2>/dev/null; wait "$su_back" "$su_up" 2>/dev/null
su_id2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["install_id"])' "$SUW/data2/install.json" 2>/dev/null)
[ "$su_rc" = 0 ] && grep -q '^registration: pending -- ' "$SUW/b1.txt" && [ "$su_state" = pending ] \
  && [ "$(printf '%s\n' "$su_h1" | tail -1)" = rc=0 ] && [ "$su_n1" = 1 ] && [ "$su_state2" = registered ] && [ "$su_nb" = 1 ] \
  && grep -q "\"install_id\": \"$su_id2\", \"email\": \"c@example.com\"" "$SUW/back/requests.jsonl" \
  && ok "with the server down setup exits 0 and marks the registration pending; the next SessionStart hook run registers it once and clears the mark" \
  || bad "the pending registration -- rc=$su_rc state=$su_state/$su_state2 reqs=$su_n1/$su_nb hook=$su_h1 $(cat "$SUW/b1.txt")"
# (c) a missing settings file is made with the one key; a bad email or an unsubstituted data folder is refused, unwritten.
mkdir -p "$SUW/cfg2"; ( cd "$SUW" && CLAUDE_CONFIG_DIR="$SUW/cfg2" SIKSTACK_SERVER="http://127.0.0.1:$su_gp" python3 "$ENG" setup --email d@example.com --data-dir "$SUW/data3" ) >/dev/null 2>&1
su_bad=$( cd "$SUW" && python3 "$ENG" setup --email nope --data-dir "$SUW/data4" 2>&1; echo "rc=$?" )
su_bad2=$( cd "$SUW" && python3 "$ENG" setup --email e@example.com --data-dir '${CLAUDE_PLUGIN_DATA}' 2>&1; echo "rc=$?" )
[ "$(cat "$SUW/cfg2/settings.json")" = "$(printf '{\n  "autoCompactWindow": 500000\n}')" ] \
  && printf '%s\n' "$su_bad" | grep -q 'rc=2' && printf '%s\n' "$su_bad2" | grep -q 'rc=2' && [ ! -e "$SUW/data4" ] && [ ! -e "$SUW/\${CLAUDE_PLUGIN_DATA}" ] \
  && ok "setup makes a missing settings file with the one key, and refuses a bad email or an unsubstituted data folder with nothing written" \
  || bad "setup's edges -- $(cat "$SUW/cfg2/settings.json" 2>&1) / $su_bad / $su_bad2"
# (d) the card: the contract plus the start line inside a .sikstack/ repo (from a subfolder too), at most 4,096 B; one
# line outside any workspace and one naming migrate above an old install; the hook never fails on bad input.
mkhost "$SUW/repo" && mkdir -p "$SUW/repo/src/deep" "$SUW/none" "$SUW/old/workflow" && printf '{"schema": 1}\n' > "$SUW/old/workflow/.agentic-nested.json"
su_card() { printf '{"source":"startup","cwd":"%s"}' "$1" | env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_DATA python3 "$PLUGIN/hooks/session_start.py"; }
su_card "$SUW/repo/src/deep" > "$SUW/card.txt"; su_card "$SUW/none" > "$SUW/out.txt"; su_card "$SUW/old" > "$SUW/old.txt"
su_junk=$(printf 'not json' | env -u CLAUDE_PROJECT_DIR python3 "$PLUGIN/hooks/session_start.py" >/dev/null; echo "rc=$?")
su_bytes=$(wc -c < "$SUW/card.txt" | tr -d ' ')
python3 - "$SUW/card.txt" "$PLUGIN/contract.md" <<'PY' && su_cc=ok || su_cc=bad
import sys
card, contract = open(sys.argv[1]).read(), open(sys.argv[2]).read().rstrip("\n")
assert card.startswith(contract + "\n\n"), "the card does not open with the contract"
rest = card[len(contract) + 2:]
assert rest.count("\n") == 1 and "/sikstack:sik-mode" in rest, rest
for rule in ("Nothing is pushed, merged or paid for without the operator's word", "A sign-off is the operator's literal words",
             "The operator's own work is never touched", "Reports are truthful", "## Principles (steer by name)"):
    assert rule in card, rule
PY
[ "$su_cc" = ok ] && [ "$su_bytes" -le 4096 ] && [ "$(grep -c '' "$SUW/out.txt")" = 1 ] && grep -q 'sikstack is installed.*/sikstack:sik-mode' "$SUW/out.txt" \
  && [ "$(grep -c '' "$SUW/old.txt")" = 1 ] && grep -q 'sikstack migrate' "$SUW/old.txt" && [ "$su_junk" = rc=0 ] \
  && ok "the SessionStart card is the contract plus one start line inside a .sikstack/ repo ($su_bytes B <= 4,096), one line outside, one naming migrate above an old install; bad input exits 0" \
  || bad "the card -- contract=$su_cc bytes=$su_bytes out=$(cat "$SUW/out.txt") old=$(cat "$SUW/old.txt") junk=$su_junk"

# ---------------------------------------------------------------------------
echo "== Test 31: sikstack migrate -- refusals (uncommitted tracked changes, an install before v102, a target with .sikstack/) write nothing; the dry run writes nothing (a tree hash, the host's files and both .git folders included); --apply on a nested multi-repo host moves workflow/ to .sikstack/ (history kept: one cleanup commit, untracked files moved, the marker and every phase record byte for byte), carries executors.toml and link.json into config.toml, rewrites the exclude and CLAUDE.local.md blocks only, removes only the installer copies that match what it shipped, and next and check run; an at-root install gets a seeded .sikstack/ with one import commit =="
newtmp MGW; cp -R "$PLUGIN" "$MGW/plugin"; ME="$MGW/plugin/scripts/workflow.py"; MGA="$MGW/plugin/adapters/claude_code/adapter.py"
mg_tree() { python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]; h = hashlib.sha256()
for d, dirs, files in os.walk(root):
    dirs.sort()
    for n in sorted(dirs + files):
        p = os.path.join(d, n)
        body = ("L" + os.readlink(p)).encode() if os.path.islink(p) else b"D" if os.path.isdir(p) else b"F" + open(p, "rb").read()
        h.update(os.path.relpath(p, root).encode() + oct(os.lstat(p).st_mode).encode() + hashlib.sha256(body).digest())
print(h.hexdigest())
PY
}
# The fixture: a multi-repo host made by the plugin (Tests 17's shape), then aged into a v102 nested install.
MGH="$MGW/host"; mkdir -p "$MGH" && git -C "$MGH" init -q && git -C "$MGH" commit -q --allow-empty -m start
for r in alpha beta; do mkdir -p "$MGH/$r" && git -C "$MGH/$r" init -q && printf '# rules\n' > "$MGH/$r/CLAUDE.md" && git -C "$MGH/$r" add -A && git -C "$MGH/$r" commit -qm init; done
( cd "$MGH" && python3 "$ENG" init && python3 "$ENG" repo add alpha && python3 "$ENG" repo add beta && python3 "$ENG" init \
  && python3 "$ENG" phase new --phase P1 --name Move --objective o && python3 "$ENG" slice new --phase P1 --slice S1 --name Build --risk low ) > "$MGW/mk.txt" 2>&1 || bad "migrate fixture: could not build the host -- $(tail -3 "$MGW/mk.txt")"
mg_next0=$( cd "$MGH" && python3 "$ENG" next 2>&1 | grep -E '^(current_phase|current_slice|next_slice)=' )
git -C "$MGH/.sikstack" add -A && git -C "$MGH/.sikstack" commit -qm "phase P1"
mv "$MGH/.sikstack" "$MGH/workflow"
python3 - "$MGH" "$MGW/plugin/scripts/migrate_v102.json" <<'PY'
import hashlib, json, os, sys
from pathlib import Path
host, manifest = Path(sys.argv[1]), Path(sys.argv[2])
w = host / "workflow"
sha = lambda t: hashlib.sha256(t.encode()).hexdigest()
def put(p, t):
    p.parent.mkdir(parents=True, exist_ok=True); p.write_text(t)
for f in ("scripts/workflow.py", "scripts/wf_store.py", "adapters/claude_code/adapter.py"):
    put(w / f, "# the old engine\n")
put(w / "CLAUDE.workspace.md", "# the old contract\n")
put(w / "executors.toml", '# routes\n[claude.mid]\nmodel = "sonnet"   # cheaper\neffort = "high"\n')
put(w / "works/.workspace-version.json", json.dumps({"workspace_version": 102}) + "\n")
put(w / "works/backlog.md", "# the old engine's backlog\n")
(w / "works/agenda.md").unlink()
(w / "config.toml").unlink()
put(w / "works/templates/intent.md", "shipped intent\n")
put(w / "works/templates/phase.md", "an edited phase template\n")
marker = json.loads((w / ".agentic-nested.json").read_text())
marker["installed"] = {"skills": ["agenda", "commit"], "agents": ["slice-executor"]}
(w / ".agentic-nested.json").write_text(json.dumps(marker, indent=2) + "\n")
put(host / ".claude/skills/commit/SKILL.md", "shipped commit skill\n"); put(host / ".claude/skills/commit/.gitignore", "*\n")
put(host / ".claude/skills/agenda/SKILL.md", "an edited agenda skill\n"); put(host / ".claude/skills/agenda/.gitignore", "*\n")
put(host / ".claude/agents/slice-executor.md", "shipped executor\n")
os.symlink("../../workflow/tools/mine", host / ".claude/skills/mine")
hook = 'cd "$CLAUDE_PROJECT_DIR" && python3 workflow/adapters/claude_code/adapter.py compact-resume || true'
put(host / ".claude/settings.local.json", json.dumps({"autoCompactWindow": 500000, "permissions": {"allow": ["Bash(python3 workflow/scripts/workflow.py:*)", "Read"]},
    "hooks": {"SessionStart": [{"matcher": "compact", "hooks": [{"type": "command", "command": hook, "timeout": 15}]}]}}, indent=2) + "\n")
put(host / "CLAUDE.local.md", "# my own notes, workflow/ stays here\n\n<!-- BEGIN agentic-workspace (nested) -->\nA private install of the agentic workspace: `workflow/` (its own git repo).\n\n@workflow/CLAUDE.workspace.md\n\n- Run `python3 workflow/scripts/workflow.py next`; commit with `git -C workflow commit`.\n<!-- END agentic-workspace (nested) -->\nmy tail line names workflow/ too\n")
ex = host / ".git/info/exclude"
ex.write_text("# git's own lines\n/mine-outside/\n# BEGIN agentic-workspace (nested)\n/workflow/\n/CLAUDE.local.md\n/.claude/settings.local.json\n"
              "/.claude/skills/agenda/\n/.claude/skills/commit/\n/.claude/skills/run-loop/\n/.claude/agents/slice-executor.md\n/alpha/\n/beta/\n# END agentic-workspace (nested)\n/.claude/skills/mine\n")
m = json.loads(manifest.read_text())
m["skills"] = {"commit": {"SKILL.md": sha("shipped commit skill\n"), ".gitignore": sha("*\n")},
               "agenda": {"SKILL.md": sha("the agenda skill as shipped\n"), ".gitignore": sha("*\n")}}
m["agents"] = {"slice-executor": sha("shipped executor\n")}
m["templates"] = {"intent.md": sha("shipped intent\n"), "phase.md": sha("the phase template as shipped\n")}
manifest.write_text(json.dumps(m))
PY
git -C "$MGH/workflow" add -A && git -C "$MGH/workflow" commit -qm "the old install"
mkdir -p "$MGH/workflow/notes" && printf 'mine, untracked\n' > "$MGH/workflow/notes/mine.md"
mg_count=$(git -C "$MGH/workflow" rev-list --count HEAD)
mg_marker=$(sha "$MGH/workflow/.agentic-nested.json")
mg_phases=$( cd "$MGH/workflow" && find works/phases -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done )
mg_local0=$(cat "$MGH/CLAUDE.local.md")
# (a) the refusals, each writing nothing.
mg_t0=$(mg_tree "$MGH"); printf 'x\n' >> "$MGH/workflow/works/events.jsonl"; mg_t1=$(mg_tree "$MGH")
mg_r1=$( cd "$MGH/alpha" && python3 "$ME" migrate --apply 2>&1; echo "rc=$?" ); mg_t2=$(mg_tree "$MGH")
git -C "$MGH/workflow" checkout -q -- works/events.jsonl
newtmp MGO; mkdir -p "$MGO/workflow/works" && git -C "$MGO" init -q && git -C "$MGO/workflow" init -q && printf '{"schema": 1}\n' > "$MGO/workflow/.agentic-nested.json" \
  && printf '{"workspace_version": 95}\n' > "$MGO/workflow/works/.workspace-version.json" && git -C "$MGO/workflow" add -A && git -C "$MGO/workflow" commit -qm v95
mg_o0=$(mg_tree "$MGO"); mg_r2=$( cd "$MGO" && python3 "$ME" migrate --apply 2>&1; echo "rc=$?" ); mg_o1=$(mg_tree "$MGO")
printf '{"workspace_version": 102}\n' > "$MGO/workflow/works/.workspace-version.json" && git -C "$MGO/workflow" commit -qam v102 && mkdir "$MGO/.sikstack"
mg_o2=$(mg_tree "$MGO"); mg_r3=$( cd "$MGO" && python3 "$ME" migrate 2>&1; echo "rc=$?" ); mg_o3=$(mg_tree "$MGO")
[ "$mg_t1" = "$mg_t2" ] && printf '%s\n' "$mg_r1" | grep -q 'refused -- the old state repo workflow/ has uncommitted tracked changes (1 path(s), first works/events.jsonl)' && printf '%s\n' "$mg_r1" | grep -qx 'rc=1' \
  && [ "$mg_o0" = "$mg_o1" ] && printf '%s\n' "$mg_r2" | grep -q 'refused -- this install is v95, and migrate reads only the last bootstrap release, v102: update it first with that installer.s --update' \
  && [ "$mg_o2" = "$mg_o3" ] && printf '%s\n' "$mg_r3" | grep -q 'refused -- .*\.sikstack already exists' \
  && ok "migrate refuses uncommitted tracked changes, a v95 install (naming the installer's --update) and a target with .sikstack/, each writing nothing" \
  || bad "migrate's refusals -- $mg_r1 / $mg_r2 / $mg_r3"
# (b) the dry run writes nothing, the host's files and both .git folders included.
mg_t0=$(mg_tree "$MGH"); mg_d=$( cd "$MGH" && python3 "$ME" migrate 2>&1; echo "rc=$?" ); mg_t3=$(mg_tree "$MGH")
[ "$mg_t3" = "$mg_t0" ] && printf '%s\n' "$mg_d" | grep -qx 'rc=0' && printf '%s\n' "$mg_d" | grep -q '^dry run: nothing was written' \
  && printf '%s\n' "$mg_d" | grep -q '^- workflow/ -> .sikstack/, a rename' \
  && ok "migrate with no flag prints the plan and writes nothing (a tree hash of the host, its .git and the state repo's, before and after)" \
  || bad "the dry run wrote or failed -- $(printf '%s\n' "$mg_d" | tail -3)"
# (c) --apply on the nested multi-repo host.
( cd "$MGH" && python3 "$ME" migrate --apply ) > "$MGW/apply.txt" 2>&1; mg_rc=$?
MGS="$MGH/.sikstack"
mg_phases2=$( cd "$MGS" && find works/phases -type f | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$f")"; done )
mg_next1=$( cd "$MGH/beta" && python3 "$ME" next 2>&1 | grep -E '^(current_phase|current_slice|next_slice)=' )
mg_route=$( cd "$MGH" && python3 "$MGA" route 2>&1 | grep -x 'override=mid sonnet@high (default opus@medium)' )
mg_problems=""
[ "$mg_rc" = 0 ] || mg_problems="$mg_problems [rc=$mg_rc]"
[ ! -e "$MGH/workflow" ] && [ -d "$MGS/.git" ] || mg_problems="$mg_problems [moved]"
[ "$(git -C "$MGS" rev-list --count HEAD)" = $((mg_count + 1)) ] || mg_problems="$mg_problems [history $(git -C "$MGS" rev-list --count HEAD) vs $mg_count+1]"
[ "$(cat "$MGS/notes/mine.md")" = "mine, untracked" ] || mg_problems="$mg_problems [untracked file]"
for f in scripts adapters CLAUDE.workspace.md executors.toml works/.workspace-version.json works/templates/intent.md backlog.md agenda.md; do
  [ ! -e "$MGS/$f" ] || mg_problems="$mg_problems [left $f]"; done
[ "$(cat "$MGS/works/templates/phase.md")" = "an edited phase template" ] && [ -f "$MGS/works/backlog.md" ] && ! grep -q 'the old engine' "$MGS/works/backlog.md" \
  && [ "$(git -C "$MGS" ls-files works/backlog.md works/agenda.md | wc -l | tr -d ' ')" = 2 ] \
  || mg_problems="$mg_problems [kept template/rebuilt dashboards]"
[ -n "$mg_route" ] || mg_problems="$mg_problems [route: no mid override]"
[ "$(sha "$MGS/.agentic-nested.json")" = "$mg_marker" ] && [ "$mg_phases2" = "$mg_phases" ] || mg_problems="$mg_problems [records changed]"
[ "$mg_next1" = "$mg_next0" ] && [ -n "$mg_next0" ] || mg_problems="$mg_problems [next: $mg_next1 vs $mg_next0]"
( cd "$MGH" && python3 "$ME" check --no-rebuild >/dev/null 2>&1 ) || mg_problems="$mg_problems [check]"
[ -z "$(git -C "$MGS" status --porcelain --untracked-files=no)" ] && [ -z "$(git -C "$MGH" status --porcelain)" ] || mg_problems="$mg_problems [dirty: $(git -C "$MGS" status --porcelain --untracked-files=no | head -2) $(git -C "$MGH" status --porcelain | head -2)]"
[ "$(sed -n '/# BEGIN/,/# END/p' "$MGH/.git/info/exclude" | tr '\n' ' ')" = "# BEGIN agentic-workspace (nested) /.sikstack/ /CLAUDE.local.md /.claude/settings.local.json /.claude/skills/agenda/ /alpha/ /beta/ # END agentic-workspace (nested) " ] \
  && grep -qx '/mine-outside/' "$MGH/.git/info/exclude" && grep -qx '/.claude/skills/mine' "$MGH/.git/info/exclude" || mg_problems="$mg_problems [exclude: $(tr '\n' ' ' < "$MGH/.git/info/exclude")]"
python3 - "$MGH/CLAUDE.local.md" "$mg_local0" <<'PY' || mg_problems="$mg_problems [CLAUDE.local.md]"
import sys
new, old = open(sys.argv[1]).read(), sys.argv[2] + "\n"
b, e = "<!-- BEGIN agentic-workspace (nested) -->", "<!-- END agentic-workspace (nested) -->"
assert new.split(b)[0] == old.split(b)[0] and new.split(e)[1] == old.split(e)[1], "text outside the markers changed"
inner = new.split(b)[1].split(e)[0]
assert "workflow/" not in inner and "@workflow" not in inner and "`sikstack next`" in inner and "git -C .sikstack commit" in inner and "`.sikstack/`" in inner, inner
PY
[ ! -e "$MGH/.claude/skills/commit" ] && [ ! -e "$MGH/.claude/agents/slice-executor.md" ] && [ "$(cat "$MGH/.claude/skills/agenda/SKILL.md")" = "an edited agenda skill" ] \
  && [ -L "$MGH/.claude/skills/mine" ] || mg_problems="$mg_problems [host copies]"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert "hooks" not in d and d["permissions"]["allow"]==["Bash(python3 workflow/scripts/workflow.py:*)","Read"] and d["autoCompactWindow"]==500000, d' "$MGH/.claude/settings.local.json" || mg_problems="$mg_problems [settings]"
grep -q '^keep: .claude/skills/agenda/ (edited since v102 shipped it' "$MGW/apply.txt" && grep -q '^left for you: .claude/skills/mine is a link into workflow/' "$MGW/apply.txt" \
  && grep -q '^sikstack check --no-rebuild: passed' "$MGW/apply.txt" && grep -q '^migrate=done' "$MGW/apply.txt" || mg_problems="$mg_problems [report]"
[ -z "$mg_problems" ] \
  && ok "migrate --apply on a nested multi-repo host: workflow/ renamed to .sikstack/ with its history (+1 cleanup commit) and untracked files, engine copies gone, executors.toml's override in config.toml, the marker and phase records byte for byte, the exclude and CLAUDE.local.md blocks rewritten and nothing outside them, only the matching installer copies removed, the old hook dropped, next unchanged and check passing" \
  || bad "migrate --apply (nested) --$mg_problems $(tail -5 "$MGW/apply.txt")"
# (d) a linked install: link.json becomes config.toml's [cloud] table, which the engine reads as the link (with no key
# in a scratch XDG_CONFIG_HOME, its next names that server and project and stops, so the migrate reports a problem).
newtmp MGL; newtmp MGX; mkhost "$MGL" >/dev/null 2>&1 && mv "$MGL/.sikstack" "$MGL/workflow" && rm -f "$MGL/workflow/config.toml" && mkdir -p "$MGL/workflow/.hi2vi" \
  && printf '{"workspace_version": 102}\n' > "$MGL/workflow/works/.workspace-version.json" \
  && printf '{"schema": 1, "server": "https://kb.example", "org_id": "org-9", "project_id": "proj-9", "linked_at": "2026-11-01T00:00:00Z"}\n' > "$MGL/workflow/.hi2vi/link.json" \
  && git -C "$MGL/workflow" add -A && git -C "$MGL/workflow" commit -qm old
( cd "$MGL" && XDG_CONFIG_HOME="$MGX" python3 "$ME" migrate --apply ) > "$MGW/linked.txt" 2>&1; mg_rc=$?
[ "$mg_rc" = 1 ] && [ ! -e "$MGL/.sikstack/.hi2vi/link.json" ] && grep -qx '\[cloud\]' "$MGL/.sikstack/config.toml" && grep -qx 'server = "https://kb.example"' "$MGL/.sikstack/config.toml" \
  && grep -qx 'org_id = "org-9"' "$MGL/.sikstack/config.toml" && grep -qx 'project_id = "proj-9"' "$MGL/.sikstack/config.toml" && grep -qx 'schema = 1' "$MGL/.sikstack/config.toml" \
  && grep -q "^  no workspace key for https://kb.example project proj-9 in $MGX/sikstack/workspace-keys.json (or the older $MGX/hi2vi/workspace-keys.json)" "$MGW/linked.txt" \
  && grep -q '^migrate=done-with-problems' "$MGW/linked.txt" && grep -qx '/.hi2vi/' "$MGL/.sikstack/.git/info/exclude" \
  && ok "migrate moves a linked install's .hi2vi/link.json into config.toml's [cloud] table, which the engine then reads as the link (no key here: next names its server and project, and migrate says it is done with problems)" \
  || bad "migrate (linked) -- rc=$mg_rc $(tail -6 "$MGW/linked.txt")"
# (e) an at-root install: a seeded .sikstack/ with one import commit; the repo's tracked files untouched.
MGR="$MGW/atroot"; mkhost "$MGW/seed" >/dev/null 2>&1 && ( cd "$MGW/seed" && python3 "$ENG" phase new --phase P3 --name Root --objective o >/dev/null )
mkdir -p "$MGR" && git -C "$MGR" init -q && cp -R "$MGW/seed/.sikstack/works" "$MGR/works" && mkdir -p "$MGR/docs" && cp -R "$MGW/seed/.sikstack/docs/current" "$MGR/docs/current" \
  && mkdir -p "$MGR/scripts" && printf '# old engine\n' > "$MGR/scripts/workflow.py" && printf '# CLAUDE.md\n' > "$MGR/CLAUDE.md" && printf 'app\n' > "$MGR/app.py" \
  && printf '{"workspace_version": 102}\n' > "$MGR/works/.workspace-version.json" && printf '# the old engine backlog\n' > "$MGR/works/backlog.md" \
  && printf '[claude.high]\nmodel = "fable"\n' > "$MGR/executors.toml" && git -C "$MGR" add -A && git -C "$MGR" commit -qm "at-root workspace"
mg_src=$(git -C "$MGR" rev-parse HEAD); mg_ls0=$(git -C "$MGR" ls-files | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$MGR/$f")"; done)
( cd "$MGR" && python3 "$ME" migrate --apply ) > "$MGW/root.txt" 2>&1; mg_rc=$?
mg_ls1=$(git -C "$MGR" ls-files | LC_ALL=C sort | while read -r f; do printf '%s %s\n' "$f" "$(sha "$MGR/$f")"; done)
mg_rn=$( cd "$MGR" && python3 "$ME" next 2>&1 | grep -x 'current_phase=P3' )
[ "$mg_rc" = 0 ] && [ "$(git -C "$MGR/.sikstack" rev-list --count HEAD)" = 1 ] && git -C "$MGR/.sikstack" log -1 --format=%s | grep -q "import the workspace from atroot at ${mg_src:0:12}" \
  && [ "$mg_ls0" = "$mg_ls1" ] && [ -z "$(git -C "$MGR" status --porcelain)" ] && [ "$(git -C "$MGR" rev-parse HEAD)" = "$mg_src" ] && [ -n "$mg_rn" ] \
  && grep -qx 'model = "fable"' "$MGR/.sikstack/config.toml" && [ ! -e "$MGR/.sikstack/works/.workspace-version.json" ] && [ -f "$MGR/.sikstack/works/backlog.md" ] \
  && ! grep -q 'the old engine' "$MGR/.sikstack/works/backlog.md" && [ -f "$MGR/.sikstack/works/agenda.md" ] && [ ! -e "$MGR/.sikstack/backlog.md" ] \
  && grep -q '^left for you: the at-root files are still tracked in the repo; when you are ready: git rm -r -q -- .*scripts/workflow.py.*works' "$MGW/root.txt" \
  && [ -z "$(git -C "$MGR/.sikstack" status --porcelain)" ] && grep -q '^migrate=done' "$MGW/root.txt" \
  && ok "migrate --apply on an at-root install seeds .sikstack/ (one import commit naming the source commit, the routes carried), leaves every tracked file and the repo's HEAD as they were, and prints the git rm to run" \
  || bad "migrate --apply (at-root) -- rc=$mg_rc $(tail -6 "$MGW/root.txt")"

# ---------------------------------------------------------------------------
echo "== Test 32: sign-in and feedback -- sign-in refuses an unregistered machine and a dirty workflow repo with nothing written; it prints the code and the connect address (never opening a browser with --no-browser), waits while the code is pending (exit 3 after --wait), keeps the same code on the next run, and on approval keeps the key (never printed) in the key file, writes and commits the [cloud] table and uploads the workspace; a declined or expired code ends with one line and nothing written; feedback sends {install_id, message, plugin_version} with no auth, reports the per-install limit in one line, and refuses a report naming a path outside the plugin or the repo, sending nothing =="
newtmp SIW; printf 'signin-smoke-key\n' > "$SIW/key"
si_fake() {  # si_fake <name>: a fake server logging into $SIW/<name>/; prints its PID
  python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$SIW/$1" --port-file "$SIW/$1.port" --key-file "$SIW/key" --project p-si --org o-si \
    --lifetime 300 > "$SIW/$1.txt" 2>&1 &
  _p=$!; for _ in $(seq 1 100); do [ -s "$SIW/$1.port" ] && break; sleep 0.1; done; echo "$_p"
}
si_up=$(si_fake up); SIS="http://127.0.0.1:$(cat "$SIW/up.port")"
si_eng() { ( cd "$SIW/$1" && XDG_CONFIG_HOME="$SIW/xdg" python3 "$ENG" "${@:2}" ) 2>&1; }
si_decide() { curl -s -X POST "$SIS/_fake/sign-in" -d "{\"code\":\"$1\",\"state\":\"$2\"}" >/dev/null; }
si_code() { sed -n 's/^code: \([A-Z0-9-]*\) .*/\1/p' "$1" | head -1; }
mkhost "$SIW/repo" && git -C "$SIW/repo/.sikstack" add -A && git -C "$SIW/repo/.sikstack" commit -qm "seed" >/dev/null 2>&1
# (a) not set up yet: refused, nothing written.
si_none=$(si_eng repo sign-in --data-dir "$SIW/nodata" --no-browser --wait 1; echo "rc=$?")
# (b) set up; a dirty workflow repo is refused before any request.
( cd "$SIW/repo" && CLAUDE_CONFIG_DIR="$SIW/cfg" SIKSTACK_SERVER="$SIS" python3 "$ENG" setup --email s@example.com --data-dir "$SIW/data" ) >/dev/null 2>&1
printf 'x\n' > "$SIW/repo/.sikstack/scratch.txt"
si_dirty=$(si_eng repo sign-in --data-dir "$SIW/data" --no-browser --wait 1; echo "rc=$?")
rm -f "$SIW/repo/.sikstack/scratch.txt"
si_starts0=$(grep -c '"route": "sign-in"' "$SIW/up/requests.jsonl" 2>/dev/null); si_starts0=${si_starts0:-0}
# (c) pending: the code and address, exit 3 after --wait; the next run keeps the same code.
si_eng repo sign-in --data-dir "$SIW/data" --no-browser --wait 2 > "$SIW/c1.txt"; si_rc1=$?
si_eng repo sign-in --data-dir "$SIW/data" --no-browser --wait 2 > "$SIW/c2.txt"; si_rc2=$?
si_c1=$(si_code "$SIW/c1.txt"); si_c2=$(si_code "$SIW/c2.txt")
si_starts=$(grep -c '"route": "sign-in"' "$SIW/up/requests.jsonl")
[ "$(printf '%s\n' "$si_none" | tail -1)" = rc=1 ] && printf '%s\n' "$si_none" | grep -q '/sikstack:setup first' \
  && [ "$(printf '%s\n' "$si_dirty" | tail -1)" = rc=1 ] && printf '%s\n' "$si_dirty" | grep -q 'uncommitted changes' && [ "$si_starts0" = 0 ] \
  && [ "$si_rc1" = 3 ] && [ "$si_rc2" = 3 ] && [ -n "$si_c1" ] && [ "$si_c1" = "$si_c2" ] && [ "$si_starts" = 1 ] \
  && grep -q "^connect page: http://127.0.0.1:$(cat "$SIW/up.port")/connect?code=$si_c1 (open it in your browser)" "$SIW/c1.txt" \
  && grep -q 'still waiting for the connect page' "$SIW/c1.txt" && grep -q '^waiting for the connect page again' "$SIW/c2.txt" \
  && grep -q '"repo": "repo"' "$SIW/up/requests.jsonl" && ! grep -q '"poll_token"' "$SIW/up/requests.jsonl" \
  && ok "sign-in refuses an unset machine and a dirty workflow repo before any request; it prints the code and the connect address, waits (exit 3 after --wait) and keeps the same code on the next run" \
  || bad "sign-in before approval -- none=[$si_none] dirty=[$si_dirty] rc=$si_rc1/$si_rc2 codes=$si_c1/$si_c2 starts=$si_starts0/$si_starts $(cat "$SIW/c1.txt")"
# (d) approved: the key is kept (0600, never printed), the [cloud] table written and committed, the workspace uploaded.
( si_eng repo sign-in --data-dir "$SIW/data" --no-browser --wait 30 > "$SIW/d.txt"; echo "rc=$?" >> "$SIW/d.txt" ) &
si_bg=$!; sleep 1; si_decide "$si_c1" approved; wait "$si_bg"
si_key=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d[sys.argv[2]]["p-si"]["key"])' "$SIW/xdg/sikstack/workspace-keys.json" "$SIS" 2>/dev/null)
si_mode=$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$SIW/xdg/sikstack/workspace-keys.json" 2>/dev/null)
si_head=$(curl -s "$SIS/_fake/state" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("head"))')
grep -q '^rc=0' "$SIW/d.txt" && [ "$si_key" = signin-smoke-key ] && [ "$si_mode" = 0o600 ] && ! grep -q signin-smoke-key "$SIW/d.txt" \
  && grep -qx 'project_id = "p-si"' "$SIW/repo/.sikstack/config.toml" && grep -qx "server = \"$SIS\"" "$SIW/repo/.sikstack/config.toml" \
  && [ "$(git -C "$SIW/repo/.sikstack" status --porcelain)" = " M works/events.jsonl" ] && git -C "$SIW/repo/.sikstack" log -1 --format=%s | grep -q 'link this checkout' \
  && [ "$si_head" -ge 1 ] 2>/dev/null && grep -q '^linked: [0-9]* file(s) sent' "$SIW/d.txt" && grep -q '^on the web: ' "$SIW/d.txt" \
  && [ -z "$(ls "$SIW/data/sign-in" 2>/dev/null)" ] \
  && ok "on approval sign-in keeps the key in the key file (0600, never printed), writes and commits the [cloud] table and uploads the workspace (head r$si_head; the event log's sent lines then leave the disk, its one change in the workflow repo)" \
  || bad "sign-in on approval -- key=$si_key mode=$si_mode head=$si_head $(cat "$SIW/d.txt")"
# (e) declined and expired codes end with one line; nothing is written.
mkhost "$SIW/repo2" && git -C "$SIW/repo2/.sikstack" add -A && git -C "$SIW/repo2/.sikstack" commit -qm seed >/dev/null 2>&1
for si_end in denied expired; do
  ( si_eng repo2 sign-in --data-dir "$SIW/data" --no-browser --wait 30 > "$SIW/e-$si_end.txt"; echo "rc=$?" >> "$SIW/e-$si_end.txt" ) &
  si_bg=$!; sleep 1; si_decide "$(si_code "$SIW/e-$si_end.txt")" "$si_end"; wait "$si_bg"
done
grep -q '^rc=1' "$SIW/e-denied.txt" && grep -q 'declined on the connect page: nothing was written' "$SIW/e-denied.txt" \
  && grep -q '^rc=1' "$SIW/e-expired.txt" && grep -q 'no longer works: run /sikstack:sign-in again' "$SIW/e-expired.txt" \
  && ! grep -q '^\[cloud\]' "$SIW/repo2/.sikstack/config.toml" && [ -z "$(git -C "$SIW/repo2/.sikstack" status --porcelain)" ] \
  && ok "a declined or an expired code ends sign-in with one line, the checkout unlinked and clean" \
  || bad "sign-in declined/expired -- $(cat "$SIW/e-denied.txt") / $(cat "$SIW/e-expired.txt")"
# (f) feedback: a second install that never signed in sends; past the per-install limit one line; a path or the repo's
# name is refused before any request.
( cd "$SIW/repo2" && CLAUDE_CONFIG_DIR="$SIW/cfg" SIKSTACK_SERVER="$SIS" python3 "$ENG" setup --email t@example.com --data-dir "$SIW/data2" ) >/dev/null 2>&1
si_fb() { ( cd "$SIW/repo2" && python3 "$ENG" feedback --data-dir "$SIW/data2" "$@" ) 2>&1; echo "rc=$?"; }
si_f1=$(printf 'sign-in printed its code twice; expected once. plugin 1.0.0\n' | si_fb)
si_f2=$(si_fb --message "a second report")
si_f3=$(si_fb --message "a third report")
si_f4=$(si_fb --message "it broke at /home/me/app/main.py")
si_f5=$(si_fb --message "the repo2 checkout failed")
si_id2=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["install_id"])' "$SIW/data2/install.json")
si_pv=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN/.claude-plugin/plugin.json")
si_rep=$(curl -s "$SIS/_fake/reports" | python3 -c 'import json,sys; r=json.load(sys.stdin)["reports"]; print(len(r), r[0])')
kill "$si_up" 2>/dev/null; wait "$si_up" 2>/dev/null
printf '%s\n' "$si_f1" | grep -q '^sent: ' && [ "$(printf '%s\n' "$si_f1" | tail -1)" = rc=0 ] && printf '%s\n' "$si_f2" | grep -q '^sent: ' \
  && [ "$(printf '%s\n' "$si_f3" | grep -c '')" = 2 ] && printf '%s\n' "$si_f3" | grep -q 'refused -- this install has sent as many reports as it may for now (HTTP 429)' \
  && printf '%s\n' "$si_f4" | grep -q 'names a path outside the plugin' && [ "$(printf '%s\n' "$si_f4" | tail -1)" = rc=2 ] \
  && printf '%s\n' "$si_f5" | grep -q 'names this repo (repo2)' \
  && [ "$si_rep" = "2 {'install_id': '$si_id2', 'message': 'sign-in printed its code twice; expected once. plugin 1.0.0', 'plugin_version': '$si_pv'}" ] \
  && [ "$(grep -c '"route": "feedback"' "$SIW/up/requests.jsonl")" = 3 ] \
  && ok "feedback sends {install_id, message, plugin_version} from an install that never signed in, reports the per-install limit in one line, and refuses a path or the repo's name before any request" \
  || bad "feedback -- f1=[$si_f1] f2=[$si_f2] f3=[$si_f3] f4=[$si_f4] f5=[$si_f5] reports=[$si_rep]"

# ---------------------------------------------------------------------------
echo "== Test 33: the design publish verbs against the local fake sikstack -- design-publish refuses an unlinked checkout with the sign-in line, a folder with no manifest or an unmarked one, and a build over a cap (files, unpacked, compressed) naming the size and the cap, each before any request; it uploads out/ as one tar.gz (manifest.json at its root) with the workspace key as a Bearer, outside the cloud boundary, and prints the build's viewer on sikstack first (url=, as the server answers it), private= and the build's host last (host=); a second publish is a second row listed first; a local/ recording is private; design-delete removes one (a second delete is the server's 404 line); a wrong key and the server's 403 and 413 are one line each; --page names the round's pages (an entry or a route) into the packed manifest's round, a value no page has refused unsent; a build from another commit than its repo's HEAD is refused unsent, a dirty one publishes with a stale: line; the key appears nowhere =="
newtmp DPW; DPX="$DPW/xdg"; DPH="$DPW/prod"; DPU="$DPW/unlinked"
dp() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$DPX" python3 "$ENG" "$@" ) 2>&1; }
{ mkhost "$DPH" && git -C "$DPH/.sikstack" add -A && git -C "$DPH/.sikstack" commit -q --allow-empty -m install && mkhost "$DPU"; } > "$DPW/setup.txt" 2>&1 \
  || bad "design publish probe: the installs failed -- $(tail -3 "$DPW/setup.txt")"
# dp_build <folder> <recording file> [no-mark] [commit] [dirty]: a small design build at <folder>/out. Its source
# commit is the folder's repo HEAD when it sits in one (as build.mjs stamps it), else a fixed one; [commit] overrides
# it (none: no source at all), [dirty] marks the tree dirty. Two pages share a route, as the real build's do.
dp_build() { mkdir -p "$1/out/_next/static" "$1/out/system" && printf '<html>%s</html>\n' "$1" > "$1/out/index.html" \
  && printf 'x' > "$1/out/_next/static/a.js" && printf '<html>system</html>\n' > "$1/out/system/index.html" \
  && python3 - "$1/out/manifest.json" "$2" "${3:-}" "${4:-$(git -C "$1" rev-parse HEAD 2>/dev/null || echo 0123456789abcdef0123)}" "${5:-}" <<'PY2'
import json, sys
path, rec, nomark, commit, dirty = sys.argv[1:]
m = {"source": {"repo": "prod", "commit": commit, "branch": "main", "dirty": bool(dirty)},
     "recording": {"file": rec, "name": "x"},
     "pages": [{"name": "All pages", "route": "/", "entry": "/"},
               {"name": "Feedback item", "route": "/f/[id]", "entry": "/f/1/", "states": [{"key": "a", "label": "A"}]},
               {"name": "Feedback item on the agenda", "route": "/f/[id]", "entry": "/f/2/"},
               {"name": "Design", "route": "/d", "entry": "/d/"},
               {"name": "System", "route": "/system", "entry": "/system/"}]}
if commit == "none":
    del m["source"]
if not nomark:
    m = {"$design": "sikstack-design-build", **m}
open(path, "w").write(json.dumps(m))
PY2
}
dp_build "$DPH/web/design" design/data/sample/recording.json; dp_build "$DPW/private" design/data/local/acme/recording.json
dp_build "$DPW/unmarked" design/data/sample/recording.json nomark; mkdir -p "$DPW/nobuild/out"
DPK="design-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$DPK" > "$DPW/key"; chmod 600 "$DPW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$DPW/fake" --port-file "$DPW/port" --key-file "$DPW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$DPW/fake.txt" 2>&1 &
DP_PID=$!
for _ in $(seq 1 100); do [ -s "$DPW/port" ] && break; sleep 0.1; done
DPS="http://127.0.0.1:$(cat "$DPW/port" 2>/dev/null)"
printf '%s\n' "$DPK" | ( cd "$DPH" && XDG_CONFIG_HOME="$DPX" python3 "$ENG" link "$DPS/projects/proj-1" ) > "$DPW/link.txt" 2>&1 \
  || bad "design publish probe: the link failed -- $(tail -2 "$DPW/link.txt")"
DPL="$DPW/fake/requests.jsonl"
dp_n() { grep -c "\"route\": \"design\"" "$DPL" 2>/dev/null || true; }
dp_ws() { grep -c '"path": "/api/workspace/' "$DPL" 2>/dev/null || true; }
# (a) unlinked: the sign-in line, nothing sent.
dp_o1=$(dp "$DPU" design-publish --folder "$DPH/web/design"); dp_rc1=$?
dp_o1b=$(dp "$DPU" design-builds); dp_rc1b=$?
[ "$dp_rc1" = 1 ] && [ "$dp_rc1b" = 1 ] && printf '%s\n' "$dp_o1" | grep -q '^design-publish: this checkout is not linked to sikstack .*run /sikstack:sign-in' \
  && printf '%s\n' "$dp_o1b" | grep -q '^design-builds: this checkout is not linked' && [ "$(printf '%s\n' "$dp_o1" | grep -c '')" = 1 ] \
  && ok "an unlinked checkout is refused with the one sign-in line, publish and list alike" \
  || bad "the unlinked refusal is wrong -- rc=$dp_rc1/$dp_rc1b [$dp_o1] [$dp_o1b]"
# (b) two publishes of the same commit: two rows, newest first; the body is one tar.gz with manifest.json at its root;
# no workspace request around them (outside the boundary).
dp_ws0=$(dp_ws)
dp_o2=$(dp "$DPH" design-publish --folder web/design); dp_rc2=$?
dp_o3=$(dp "$DPH" design-publish --folder web/design); dp_rc3=$?
dp_id2=$(printf '%s\n' "$dp_o2" | sed -n 's/^published=\([^ ]*\) .*/\1/p'); dp_id3=$(printf '%s\n' "$dp_o3" | sed -n 's/^published=\([^ ]*\) .*/\1/p')
dp_o4=$(dp "$DPH" design-builds); dp_rc4=$?
dp_post=$(grep '"route": "design"' "$DPL" | grep '"method": "POST"' | head -1)
[ "$dp_rc2" = 0 ] && [ "$dp_rc3" = 0 ] && [ -n "$dp_id2" ] && [ -n "$dp_id3" ] && [ "$dp_id2" != "$dp_id3" ] \
  && printf '%s\n' "$dp_o2" | grep -q "^published=$dp_id2 url=$DPS/projects/proj-1/design/$dp_id2 private=no commit=$(git -C "$DPH" rev-parse HEAD | cut -c1-12) branch=main size=[0-9]* files=[0-9]* compressed=[0-9]* host=http://$dp_id2.design.fake.localhost/\$" \
  && [ "$dp_rc4" = 0 ] && [ "$(printf '%s\n' "$dp_o4" | sed -n 1p)" = "builds=2 project=proj-1" ] \
  && printf '%s\n' "$dp_o4" | sed -n 2p | grep -q "^$dp_id3 " && printf '%s\n' "$dp_o4" | sed -n 3p | grep -q "^$dp_id2 url=$DPS/projects/proj-1/design/$dp_id2 published_at=.* private=no share=off host=http://$dp_id2.design.fake.localhost/\$" \
  && printf '%s\n' "$dp_post" | grep -q '"auth": "ok"' && printf '%s\n' "$dp_post" | grep -q '"content_type": "application/gzip"' \
  && printf '%s\n' "$dp_post" | grep -q '"names": \["_next", "_next/static", "_next/static/a.js", "index.html", "manifest.json", "system", "system/index.html"\]' \
  && [ "$(dp_ws)" = "$dp_ws0" ] \
  && ok "design-publish uploads out/ as one tar.gz (manifest.json at its root) with the key as a Bearer, prints published= led by the build's viewer on sikstack (url=), private=no and its host last (host=); design-builds leads each row with the id and that url=; a second publish of the same commit is a second row, listed first by design-builds; no workspace request around them" \
  || bad "publish and list are wrong -- rc=$dp_rc2/$dp_rc3/$dp_rc4 [$dp_o2] [$dp_o4] post=[$dp_post] ws=$dp_ws0/$(dp_ws)"
# (c) a local/ recording publishes as private, and the verb says so.
dp_o5=$(dp "$DPH" design-publish --folder "$DPW/private"); dp_rc5=$?
[ "$dp_rc5" = 0 ] && printf '%s\n' "$dp_o5" | sed -n 1p | grep -q "^published=b[a-z2-7]* url=$DPS/projects/proj-1/design/b[a-z2-7]* private=yes " \
  && printf '%s\n' "$dp_o5" | sed -n 2p | grep -q '^private: made from a private recording (design/data/local/acme/recording.json), so its share link cannot be turned on$' \
  && ok "a build from a design/data/local/ recording publishes as private=yes, with the one line saying its share link cannot be turned on" \
  || bad "the private publish is wrong -- rc=$dp_rc5 [$dp_o5]"
# (d) refusals before any request: no manifest, an unmarked one, and each cap naming the size and the cap.
mkdir -p "$DPW/files/out" && printf '{"$design": "sikstack-design-build"}' > "$DPW/files/out/manifest.json" \
  && ( cd "$DPW/files/out" && for i in $(seq 1 5000); do : > "f$i"; done )
mkdir -p "$DPW/big/out" && cp "$DPW/files/out/manifest.json" "$DPW/big/out/" && dd if=/dev/zero of="$DPW/big/out/blob" bs=1048576 count=51 2>/dev/null
mkdir -p "$DPW/packed/out" && cp "$DPW/files/out/manifest.json" "$DPW/packed/out/" && head -c 17000000 /dev/urandom > "$DPW/packed/out/noise"
dp_n0=$(dp_n)
dp_o6=$(dp "$DPH" design-publish --folder "$DPW/nobuild"); dp_rc6=$?
dp_o7=$(dp "$DPH" design-publish --folder "$DPW/unmarked"); dp_rc7=$?
dp_o8=$(dp "$DPH" design-publish --folder "$DPW/files"); dp_rc8=$?
dp_o9=$(dp "$DPH" design-publish --folder "$DPW/big"); dp_rc9=$?
dp_o10=$(dp "$DPH" design-publish --folder "$DPW/packed"); dp_rc10=$?
[ "$dp_rc6$dp_rc7$dp_rc8$dp_rc9$dp_rc10" = 11111 ] && [ "$(dp_n)" = "$dp_n0" ] \
  && printf '%s\n' "$dp_o6" | grep -q "^design-publish: refused -- .*nobuild has no build: .*manifest.json is missing" \
  && printf '%s\n' "$dp_o7" | grep -q '^design-publish: refused -- .*manifest.json is not a design build.s manifest (no "\$design": "sikstack-design-build")' \
  && printf '%s\n' "$dp_o8" | grep -q '^design-publish: refused -- the build holds 5,001 files: the cap is 5,000 files (nothing was published)$' \
  && printf '%s\n' "$dp_o9" | grep -q '^design-publish: refused -- the build is 53,477,[0-9,]* bytes (51.0 MB) unpacked: the cap is 50 MB unpacked' \
  && printf '%s\n' "$dp_o10" | grep -q '^design-publish: refused -- the build is [0-9,]* bytes (16.[2-9] MB) compressed: the cap is 16 MB compressed' \
  && ok "a folder with no manifest, an unmarked manifest, and a build over each cap (5,000 files, 50 MB unpacked, 16 MB compressed) are refused naming the size and the cap, before any request" \
  || bad "a pre-upload refusal is wrong -- rc=$dp_rc6$dp_rc7$dp_rc8$dp_rc9$dp_rc10 sent=$dp_n0/$(dp_n) [$dp_o6] [$dp_o7] [$dp_o8] [$dp_o9] [$dp_o10]"
# (e) delete: gone from the list; a second delete is the server's 404 line; a bad id is refused unsent.
dp_o11=$(dp "$DPH" design-delete "$dp_id2"); dp_rc11=$?
dp_o12=$(dp "$DPH" design-builds)
dp_o13=$(dp "$DPH" design-delete "$dp_id2"); dp_rc13=$?
dp_o14=$(dp "$DPH" design-delete "../x"); dp_rc14=$?
[ "$dp_rc11" = 0 ] && [ "$dp_o11" = "deleted=$dp_id2" ] && [ "$(printf '%s\n' "$dp_o12" | sed -n 1p)" = "builds=2 project=proj-1" ] \
  && ! printf '%s\n' "$dp_o12" | grep -q "^$dp_id2 " && [ "$dp_rc13" = 1 ] \
  && [ "$dp_o13" = "design-delete: sikstack refused (HTTP 404): build not found (nothing was deleted)" ] \
  && [ "$dp_rc14" = 1 ] && printf '%s\n' "$dp_o14" | grep -q "is not a build id" \
  && ok "design-delete removes the build (gone from design-builds); deleting it again relays the server's 404 in one line; a malformed id is refused unsent" \
  || bad "delete is wrong -- rc=$dp_rc11/$dp_rc13/$dp_rc14 [$dp_o11] [$dp_o12] [$dp_o13] [$dp_o14]"
# (f) a wrong key (401), the server's 403 and 413: one line each.
dp_ctl() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$DPS/_fake/control" >/dev/null; }
cp "$DPX/sikstack/workspace-keys.json" "$DPW/keys.saved"
python3 - "$DPX/sikstack/workspace-keys.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for projects in d.values():
    for entry in projects.values():
        entry["key"] = "wrong-key"
open(p, "w").write(json.dumps(d))
PY2
dp_o15=$(dp "$DPH" design-builds); dp_rc15=$?
cp "$DPW/keys.saved" "$DPX/sikstack/workspace-keys.json"; chmod 600 "$DPX/sikstack/workspace-keys.json"
dp_ctl '{"design_answer": {"status": 403, "detail": "this key cannot reach a workspace"}}'
dp_o16=$(dp "$DPH" design-builds); dp_rc16=$?
dp_ctl '{"design_answer": {"status": 413, "detail": "the build is 52,428,801 bytes (50.0 MB) unpacked: the cap is 50 MB", "method": "POST"}}'
dp_o17=$(dp "$DPH" design-publish --folder web/design); dp_rc17=$?
# a wrong key on a big upload: the server refuses before reading the body, so the key is checked before the upload.
mkdir -p "$DPW/wide/out" && cp "$DPW/files/out/manifest.json" "$DPW/wide/out/" && head -c 4000000 /dev/urandom > "$DPW/wide/out/noise"
python3 - "$DPX/sikstack/workspace-keys.json" <<'PY2'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for projects in d.values():
    for entry in projects.values():
        entry["key"] = "wrong-key"
open(p, "w").write(json.dumps(d))
PY2
dp_n18=$(dp_n); dp_o18=$(dp "$DPH" design-publish --folder "$DPW/wide"); dp_rc18=$?
cp "$DPW/keys.saved" "$DPX/sikstack/workspace-keys.json"; chmod 600 "$DPX/sikstack/workspace-keys.json"
[ "$dp_rc15$dp_rc16$dp_rc17$dp_rc18" = 1111 ] \
  && [ "$dp_o18" = "design-publish: sikstack refused (HTTP 401): a workspace key is required; make a workspace key under Keys on the project's page and link again (nothing was published)" ] \
  && [ "$(dp_n)" = "$((dp_n18 + 1))" ] \
  && [ "$dp_o15" = "design-builds: sikstack refused (HTTP 401): a workspace key is required; make a workspace key under Keys on the project's page and link again (nothing was read)" ] \
  && [ "$dp_o16" = "design-builds: sikstack refused (HTTP 403): this key cannot reach a workspace; this is not a workspace key: make one under Keys on the project's page (nothing was read)" ] \
  && [ "$dp_o17" = "design-publish: sikstack refused (HTTP 413): the build is 52,428,801 bytes (50.0 MB) unpacked: the cap is 50 MB (nothing was published)" ] \
  && ok "a wrong key's 401, the server's 403 and its 413 each end the verb in one line naming the status and the server's words; a wrong key on a 4 MB publish is refused by one small request before the upload" \
  || bad "the server's refusals are wrong -- rc=$dp_rc15$dp_rc16$dp_rc17$dp_rc18 [$dp_o15] [$dp_o16] [$dp_o17] [$dp_o18]"
# (g) the round (--page): entries and routes (a route selects every page with it) give round.pages, unique, in the
# manifest's order, in the packed manifest only (out/manifest.json unchanged); no --page, no round key; a value no
# page has is refused in one line before any request.
dp_round() { python3 - "$DPL" "$1" <<'PY2'
import json, sys
posts = [json.loads(l) for l in open(sys.argv[1]) if '"route": "design"' in l and '"method": "POST"' in l]
print(json.dumps(posts[int(sys.argv[2])].get("round", "unlogged")))
PY2
}
dp_sum0=$(sha_stdin < "$DPH/web/design/out/manifest.json")
dp_o19=$(dp "$DPH" design-publish --folder web/design --page /d/ --page '/f/[id]' --page /f/2/); dp_rc19=$?
dp_r19=$(dp_round -1); dp_r2=$(dp_round 0)
dp_n20=$(dp_n); dp_o20=$(dp "$DPH" design-publish --folder web/design --page /d/ --page /nope/); dp_rc20=$?
[ "$dp_rc19" = 0 ] && printf '%s\n' "$dp_o19" | grep -q '^published=b' && [ "$dp_r19" = '{"pages": ["/f/1/", "/f/2/", "/d/"]}' ] \
  && [ "$dp_r2" = '"absent"' ] && [ "$(sha_stdin < "$DPH/web/design/out/manifest.json")" = "$dp_sum0" ] \
  && [ "$dp_rc20" = 1 ] && [ "$(dp_n)" = "$dp_n20" ] && [ "$(printf '%s\n' "$dp_o20" | grep -c '')" = 1 ] \
  && printf '%s\n' "$dp_o20" | grep -q "^design-publish: refused -- --page '/nope/' is no page of the build.*(nothing was published)\$" \
  && ok "design-publish --page takes a page's entry or route (a route selects both pages that share it): the packed manifest's round.pages are the matched entries, unique, in the manifest's order, and out/manifest.json is unchanged; a publish with no --page uploads no round; --page /nope/ is refused in one line naming it, before any request" \
  || bad "the round's publish is wrong -- rc=$dp_rc19/$dp_rc20 round=[$dp_r19] plain=[$dp_r2] sent=$dp_n20/$(dp_n) [$dp_o19] [$dp_o20]"
# (g2) an options round: in a build with an options page, --page <options.entry> is the options page, recorded last
# in round.pages (after the pages, in the manifest's order); a round may name only the options page; a build with no
# options page refuses that value, unsent.
dp_build "$DPW/opts" design/data/sample/recording.json && python3 - "$DPW/opts/out/manifest.json" <<'PY2'
import json, sys
m = json.load(open(sys.argv[1]))
m["options"] = {"name": None, "entry": "/options/", "directions": [{"key": "a", "label": "A", "entry": "/options/?direction=a"}]}
json.dump(m, open(sys.argv[1], "w"))
PY2
dp_o21=$(dp "$DPH" design-publish --folder "$DPW/opts" --page /options/ --page /d/); dp_rc21=$?; dp_r21=$(dp_round -1)
dp_o22=$(dp "$DPH" design-publish --folder "$DPW/opts" --page /options/); dp_rc22=$?; dp_r22=$(dp_round -1)
dp_n23=$(dp_n); dp_o23=$(dp "$DPH" design-publish --folder web/design --page /options/); dp_rc23=$?
[ "$dp_rc21" = 0 ] && printf '%s\n' "$dp_o21" | grep -q '^published=b' && [ "$dp_r21" = '{"pages": ["/d/", "/options/"]}' ] \
  && [ "$dp_rc22" = 0 ] && printf '%s\n' "$dp_o22" | grep -q '^published=b' && [ "$dp_r22" = '{"pages": ["/options/"]}' ] \
  && [ "$dp_rc23" = 1 ] && [ "$(dp_n)" = "$dp_n23" ] \
  && printf '%s\n' "$dp_o23" | grep -q "^design-publish: refused -- --page '/options/' is no page of the build.*(nothing was published)\$" \
  && ok "design-publish --page takes the options page's entry (manifest options.entry): round.pages records it last, after the pages; a round may name only the options page; a build with no options page refuses it unsent" \
  || bad "the options round's publish is wrong -- rc=$dp_rc21/$dp_rc22/$dp_rc23 round=[$dp_r21] [$dp_r22] [$dp_o21] [$dp_o22] [$dp_o23]"
# (h) the stale-commit check, in a repo of its own: a build from another commit than HEAD is refused (both commits
# named, no request); one from a dirty tree publishes with one stale: line; one with no source is not checked.
DPR="$DPW/stalerepo"; mkdir -p "$DPR" && git -C "$DPR" init -q && git -C "$DPR" commit -q --allow-empty -m one \
  && git -C "$DPR" commit -q --allow-empty -m two
dp_old=$(git -C "$DPR" rev-parse HEAD~1); dp_head=$(git -C "$DPR" rev-parse HEAD)
dp_build "$DPR/old" design/data/sample/recording.json "" "$dp_old"
dp_build "$DPR/dirty" design/data/sample/recording.json "" "$dp_head" dirty
dp_build "$DPR/nosource" design/data/sample/recording.json "" none
dp_n21=$(dp_n); dp_o21=$(dp "$DPH" design-publish --folder "$DPR/old"); dp_rc21=$?; dp_n21b=$(dp_n)
dp_o22=$(dp "$DPH" design-publish --folder "$DPR/dirty"); dp_rc22=$?
dp_o23=$(dp "$DPH" design-publish --folder "$DPR/nosource"); dp_rc23=$?
[ "$dp_rc21" = 1 ] && [ "$dp_n21b" = "$dp_n21" ] && [ "$(printf '%s\n' "$dp_o21" | grep -c '')" = 1 ] \
  && printf '%s\n' "$dp_o21" | grep -q "^design-publish: refused -- the build was made from commit ${dp_old:0:7}, but its repo is at ${dp_head:0:7}: build the design folder again after the commit, then publish (nothing was published)\$" \
  && [ "$dp_rc22" = 0 ] && [ "$(printf '%s\n' "$dp_o22" | grep -c '')" = 2 ] && printf '%s\n' "$dp_o22" | sed -n 1p | grep -q '^published=b' \
  && printf '%s\n' "$dp_o22" | sed -n 2p | grep -q "^stale: the build was made from uncommitted changes on ${dp_head:0:7}" \
  && [ "$dp_rc23" = 0 ] && [ "$(printf '%s\n' "$dp_o23" | grep -c '')" = 1 ] && printf '%s\n' "$dp_o23" | grep -q '^published=b.* commit=none ' \
  && ok "the stale-commit check: a build made from a commit that is not its repo's HEAD is refused in one line naming both, before any request; a dirty tree's build publishes with one stale: line; a manifest with no source publishes with no line" \
  || bad "the stale-commit check is wrong -- rc=$dp_rc21/$dp_rc22/$dp_rc23 sent=$dp_n21/$dp_n21b [$dp_o21] [$dp_o22] [$dp_o23]"
if grep -rqF "$DPK" "$DPH" "$DPW"/*.txt "$DPW/fake" 2>/dev/null || printf '%s\n' "$dp_o2$dp_o4$dp_o5$dp_o13$dp_o15" | grep -qF "$DPK"; then
  bad "the workspace key leaked into the tree, the output or the request log"
fi
kill "$DP_PID" 2>/dev/null; wait "$DP_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "== Test 39: the design link in a local workspace, against the local fake sikstack -- with no [cloud] and no [design] table, design-publish, design-builds and design-delete each refuse in one line naming design-link, before any request; design-link refuses a cloud-linked checkout, a key folder open to others, a key the design API refuses (401, 403), and another project over a set link without --replace (and with it, a probe's 404), each with nothing written; from a phase's worktree it reads a pasted key (stdin, never argv), keeps it 0600 and writes [design] (server and project_id, no key) into the main checkout's config.toml, saying where; then the worktree cut before the link and the main checkout both publish and design-builds lists both, while next prints no store=cloud and worktree start still runs; the connect-page form run in a worktree names the new project after the main host folder and writes [design], never [cloud]; the key appears nowhere =="
newtmp DLW; DLX="$DLW/xdg"; DLH="$DLW/dlhost"; DL2="$DLW/dlhost2"
dl() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$DLX" python3 "$ENG" "$@" ) 2>&1; }
# dl_install <host>: a nested install with phase P1 in its own worktree pair, cut now (before any link); prints the host worktree.
dl_install() {
  mkhost "$1" >/dev/null && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m install >/dev/null \
    && ( cd "$1" && python3 "$ENG" phase new --phase P1 --name "Probe" --objective "probe the design link" >/dev/null ) \
    && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -q --allow-empty -m p1 >/dev/null \
    && ( cd "$1" && python3 "$ENG" worktree start P1 --host-branch feat/p1 ) | sed -n 's/^host_worktree=//p'
}
DLT=$(dl_install "$DLH" 2>"$DLW/install.txt"); DL2T=$(dl_install "$DL2" 2>>"$DLW/install.txt")
{ [ -d "$DLT/.sikstack" ] && [ -d "$DL2T/.sikstack" ]; } || bad "design link probe: an install or its worktree failed -- $(tail -3 "$DLW/install.txt")"
DLK="design-link-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$DLK" > "$DLW/key"; chmod 600 "$DLW/key"
python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$DLW/fake" --port-file "$DLW/port" --key-file "$DLW/key" \
  --project proj-d --org org-d --lifetime 900 > "$DLW/fake.txt" 2>&1 &
DL_PID=$!
for _ in $(seq 1 100); do [ -s "$DLW/port" ] && break; sleep 0.1; done
DLS="http://127.0.0.1:$(cat "$DLW/port" 2>/dev/null)"
DLL="$DLW/fake/requests.jsonl"
dl_n() { cat "$DLL" 2>/dev/null | grep -c '' | tr -d ' '; }  # every request the fake received
dl_ctl() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$DLS/_fake/control" >/dev/null; }
dl_cfg() { cat "$1/.sikstack/config.toml"; }
dp_build "$DLH/web/design" design/data/sample/recording.json
# (a) no [cloud], no [design]: each verb refuses in one line naming design-link, and the fake receives nothing.
dl_a1=$(dl "$DLH" design-publish --folder "$DLH/web/design"; echo "rc=$?")
dl_a2=$(dl "$DLT" design-builds; echo "rc=$?")
dl_a3=$(dl "$DLT" design-delete bnotabuildbutwellformed; echo "rc=$?")
dl_a_ok=1
for dl_pair in "design-publish|nothing was published|$dl_a1" "design-builds|nothing was read|$dl_a2" "design-delete|nothing was deleted|$dl_a3"; do
  dl_v=${dl_pair%%|*}; dl_rest=${dl_pair#*|}; dl_nw=${dl_rest%%|*}; dl_o=${dl_rest#*|}
  { [ "$(printf '%s\n' "$dl_o" | grep -c '')" = 2 ] && [ "$(printf '%s\n' "$dl_o" | tail -1)" = rc=1 ] \
    && printf '%s\n' "$dl_o" | head -1 | grep -q "^$dl_v: this checkout is not linked to sikstack .*run sikstack design-link .*/sikstack:sign-in .*($dl_nw)\$"; } || dl_a_ok=0
done
[ "$dl_a_ok" = 1 ] && [ "$(dl_n)" = 0 ] \
  && ok "with no [cloud] and no [design] table, design-publish, design-builds and design-delete (main checkout and a phase's worktree) each refuse in one line naming design-link (and /sikstack:sign-in for cloud mode); the fake receives no request" \
  || bad "the unlinked refusal naming design-link is wrong -- sent=$(dl_n) [$dl_a1] [$dl_a2] [$dl_a3]"
# (b) design-link's refusals, each with nothing written: a cloud-linked checkout, a key folder open to others, a key the
# design API refuses (401, 403).
mkhost "$DLW/linked" >/dev/null 2>&1 && set_link "$DLW/linked/.sikstack" "$DLS"
dl_c0=$(dl_cfg "$DLW/linked"); dl_n0=$(dl_n)
dl_b1=$(printf '%s\n' "$DLK" | dl "$DLW/linked" design-link "$DLS/projects/proj-d"; echo "rc=$?")
dl_cfg0=$(dl_cfg "$DLH")
mkdir -p "$DLX/sikstack" && chmod 755 "$DLX/sikstack"
dl_b2=$(printf '%s\n' "$DLK" | dl "$DLT" design-link "$DLS/projects/proj-d"; echo "rc=$?")
chmod 700 "$DLX/sikstack"
dl_n2=$(dl_n)
dl_b3=$(printf 'wrong-key\n' | dl "$DLT" design-link "$DLS/projects/proj-d"; echo "rc=$?")
dl_ctl '{"design_answer": {"status": 403, "detail": "this key cannot reach a workspace"}}'
dl_b4=$(printf '%s\n' "$DLK" | dl "$DLT" design-link "$DLS/projects/proj-d"; echo "rc=$?")
[ "$(printf '%s\n' "$dl_b1" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_b1" | head -1 | grep -q '^design-link: this checkout is linked to sikstack (cloud mode: the \[cloud\] table in .*), and that link already publishes design builds (nothing was written)$' \
  && [ "$dl_n2" = "$dl_n0" ] && [ "$(dl_cfg "$DLW/linked")" = "$dl_c0" ] \
  && [ "$(printf '%s\n' "$dl_b2" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_b2" | grep -q '^design-link: .*can be read by group or others (mode 0755)' \
  && [ "$(printf '%s\n' "$dl_b3" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_b3" | grep -q '^design-link: sikstack refused (HTTP 401): .*(nothing was written)$' \
  && [ "$(printf '%s\n' "$dl_b4" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_b4" | grep -q '^design-link: sikstack refused (HTTP 403): this key cannot reach a workspace.*(nothing was written)$' \
  && [ "$(dl_cfg "$DLH")" = "$dl_cfg0" ] && ! grep -q '^\[design\]' "$DLT/.sikstack/config.toml" && [ ! -e "$DLX/sikstack/workspace-keys.json" ] \
  && ok "design-link refuses a cloud-linked checkout (its link already publishes; no request), a key folder open to others, and a key the design API answers 401 or 403, each in one line with nothing written: no [design] table, no key file" \
  || bad "a design-link refusal is wrong -- [$dl_b1] [$dl_b2] [$dl_b3] [$dl_b4] sent=$dl_n0/$dl_n2 keys=$(ls "$DLX/sikstack" 2>&1)"
# (c) from the phase's worktree: the pasted key (stdin) is probed, kept 0600, and [design] lands in the main checkout's
# config.toml, never the worktree's, and never [cloud].
printf '%s\n' "$DLK" | dl "$DLT" design-link "$DLS/projects/proj-d" > "$DLW/c.txt"; dl_rc=$?
dl_mode=$(python3 -c 'import os,stat,sys; print(oct(stat.S_IMODE(os.stat(sys.argv[1]).st_mode)))' "$DLX/sikstack/workspace-keys.json" 2>/dev/null)
dl_saved=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]]["proj-d"]["key"])' "$DLX/sikstack/workspace-keys.json" "$DLS" 2>/dev/null)
dl_tbl=$(python3 - "$DLH/.sikstack/config.toml" <<'PY2'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(r"^\[design\]\n((?:[^\[\n][^\n]*\n|\n)*)", text, re.M)
print(" ".join(l.split(" = ")[0] for l in (m.group(1).splitlines() if m else []) if l.strip() and not l.startswith("#")))
PY2
)
[ "$dl_rc" = 0 ] && grep -q "^design_link=written server=$DLS project=proj-d config=/.*/dlhost/\.sikstack/config\.toml\$" "$DLW/c.txt" \
  && [ "$dl_mode" = 0o600 ] && [ "$dl_saved" = "$DLK" ] && [ "$dl_tbl" = "schema server project_id linked_at" ] \
  && grep -qx "server = \"$DLS\"" "$DLH/.sikstack/config.toml" && grep -qx 'project_id = "proj-d"' "$DLH/.sikstack/config.toml" \
  && ! grep -q '^\[cloud\]' "$DLH/.sikstack/config.toml" && ! grep -q '^\[design\]' "$DLT/.sikstack/config.toml" \
  && ! grep -qF "$DLK" "$DLW/c.txt" "$DLH/.sikstack/config.toml" \
  && ok "design-link from a phase's worktree reads the pasted key from stdin, keeps it in the key file (0600, never printed) and writes [design] (schema, server, project_id, linked_at; no key) into the main checkout's config.toml, naming that file; the worktree's own config.toml and [cloud] stay untouched" \
  || bad "design-link (pasted key, from a worktree) is wrong -- rc=$dl_rc mode=$dl_mode table=[$dl_tbl] $(cat "$DLW/c.txt")"
# (d) the worktree (cut before the link) and the main checkout both publish; design-builds lists both, newest first;
# no workspace request, no cloud mode.
dl_p1=$(dl "$DLT" design-publish --folder "$DLH/web/design"); dl_prc1=$?
dl_p2=$(dl "$DLH" design-publish --folder "$DLH/web/design"); dl_prc2=$?
dl_id1=$(printf '%s\n' "$dl_p1" | sed -n 's/^published=\([^ ]*\) .*/\1/p'); dl_id2=$(printf '%s\n' "$dl_p2" | sed -n 's/^published=\([^ ]*\) .*/\1/p')
dl_ls=$(dl "$DLT" design-builds); dl_lrc=$?
dl_nx1=$(dl "$DLH" next); dl_nx2=$(dl "$DLT" next)
[ "$dl_prc1" = 0 ] && [ "$dl_prc2" = 0 ] && [ -n "$dl_id1" ] && [ -n "$dl_id2" ] && [ "$dl_id1" != "$dl_id2" ] \
  && printf '%s\n' "$dl_p1" | grep -q "^published=$dl_id1 url=$DLS/projects/proj-d/design/$dl_id1 private=no .* host=http://$dl_id1.design.fake.localhost/\$" \
  && [ "$dl_lrc" = 0 ] && [ "$(printf '%s\n' "$dl_ls" | sed -n 1p)" = "builds=2 project=proj-d" ] \
  && printf '%s\n' "$dl_ls" | sed -n 2p | grep -q "^$dl_id2 url=" && printf '%s\n' "$dl_ls" | sed -n 3p | grep -q "^$dl_id1 url=" \
  && [ "$(grep '"route": "design"' "$DLL" | grep '"method": "POST"' | grep -c '"auth": "ok"')" = 2 ] && ! grep -q '"/api/workspace/' "$DLL" \
  && ! printf '%s\n' "$dl_nx1$dl_nx2" | grep -q 'store=cloud' && printf '%s\n' "$dl_nx2" | grep -q '^stream=phase/P1-' \
  && ok "with [design] set, the worktree cut before the link and the main checkout each print published= (the viewer url=, the build's host=), and design-builds lists both, newest first; no workspace request; next prints no store=cloud in either checkout" \
  || bad "publishing with the design link is wrong -- rc=$dl_prc1/$dl_prc2/$dl_lrc [$dl_p1] [$dl_p2] [$dl_ls] next=[$dl_nx2]"
# (e) worktree start still runs; another project over the set link is refused unless --replace, and --replace probes
# before writing (the fake has no proj-x: its 404), so the link stays.
( cd "$DLH" && python3 "$ENG" phase new --phase P2 --name "Second" --objective "cut after the link" >/dev/null 2>&1 )
dl_w2=$( cd "$DLH" && python3 "$ENG" worktree start P2 --host-branch feat/p2 2>&1 ); dl_wrc=$?
dl_n3=$(dl_n)
dl_r1=$(printf '%s\n' "$DLK" | dl "$DLH" design-link "$DLS/projects/proj-x"; echo "rc=$?")
dl_n4=$(dl_n)
dl_r2=$(printf '%s\n' "$DLK" | dl "$DLH" design-link --replace "$DLS/projects/proj-x"; echo "rc=$?")
dl_r3=$(dl "$DLH" design-link --data-dir "$DLW/data" --no-browser --wait 1; echo "rc=$?")
[ "$dl_wrc" = 0 ] && printf '%s\n' "$dl_w2" | grep -q '^branch=phase/P2-' \
  && [ "$(printf '%s\n' "$dl_r1" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_r1" | head -1 | grep -q '^design-link: this workspace already has a design link (server=.* project=proj-d).*--replace.*(nothing was written)$' \
  && [ "$dl_n4" = "$dl_n3" ] \
  && [ "$(printf '%s\n' "$dl_r2" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_r2" | grep -q '^design-link: sikstack refused (HTTP 404): .*(nothing was written)$' \
  && [ "$(printf '%s\n' "$dl_r3" | tail -1)" = rc=1 ] && printf '%s\n' "$dl_r3" | head -1 | grep -q '^design-link: this workspace already has a design link .*--replace' \
  && grep -qx 'project_id = "proj-d"' "$DLH/.sikstack/config.toml" && [ "$(grep -c '^\[design\]' "$DLH/.sikstack/config.toml")" = 1 ] \
  && ! grep -q '"route": "sign-in"' "$DLL" \
  && ok "worktree start still runs after the link; another project over the set link is refused unless --replace (no request), --replace probes first (a 404 writes nothing), and the connect-page form refuses over a set link before any sign-in" \
  || bad "worktree start or a replace refusal is wrong -- rc=$dl_wrc [$dl_r1] [$dl_r2] [$dl_r3] sent=$dl_n3/$dl_n4"
# (f) the connect-page form, run in a phase's worktree of a second install: the new project is named after the main host
# folder (never the worktree's), the key is kept, [design] lands in the main checkout's config.toml, never [cloud].
( cd "$DL2" && CLAUDE_CONFIG_DIR="$DLW/cfg" SIKSTACK_SERVER="$DLS" python3 "$ENG" setup --email d@example.com --data-dir "$DLW/data" ) >/dev/null 2>&1
( cd "$DL2T" && XDG_CONFIG_HOME="$DLX" python3 "$ENG" design-link --data-dir "$DLW/data" --no-browser --wait 30 > "$DLW/f.txt" 2>&1; echo "rc=$?" >> "$DLW/f.txt" ) &
dl_bg=$!
for _ in $(seq 1 100); do grep -q '^code: ' "$DLW/f.txt" 2>/dev/null && break; sleep 0.1; done
dl_code=$(sed -n 's/^code: \([A-Z0-9-]*\) .*/\1/p' "$DLW/f.txt" | head -1)
curl -s -X POST "$DLS/_fake/sign-in" -d "{\"code\":\"$dl_code\",\"state\":\"approved\"}" >/dev/null; wait "$dl_bg"
dl_nx3=$(dl "$DL2T" next)
grep -q '^rc=0' "$DLW/f.txt" && [ -n "$dl_code" ] && grep -q "^connect page: $DLS/connect?code=$dl_code" "$DLW/f.txt" \
  && grep '"route": "sign-in"' "$DLL" | grep -q '"repo": "dlhost2"' && ! grep '"route": "sign-in"' "$DLL" | grep -q '"repo": "P1-' \
  && grep -q "^design_link=written server=$DLS project=proj-d config=/.*/dlhost2/\.sikstack/config\.toml\$" "$DLW/f.txt" \
  && grep -qx 'project_id = "proj-d"' "$DL2/.sikstack/config.toml" && ! grep -q '^\[cloud\]' "$DL2/.sikstack/config.toml" \
  && ! grep -q '^\[design\]' "$DL2T/.sikstack/config.toml" && ! grep -qF "$DLK" "$DLW/f.txt" "$DL2/.sikstack/config.toml" \
  && ! printf '%s\n' "$dl_nx3" | grep -q 'store=cloud' && [ -z "$(ls "$DLW/data/sign-in" 2>/dev/null)" ] \
  && ok "the connect-page form of design-link, run in a phase's worktree, names the new project after the main host folder, keeps the key unprinted and writes [design] (never [cloud]) into the main checkout's config.toml; next stays local" \
  || bad "design-link's connect-page form is wrong -- code=$dl_code $(cat "$DLW/f.txt") sign-ins=$(grep '"route": "sign-in"' "$DLL")"
if grep -rqF "$DLK" "$DLH" "$DL2" "$DLW"/*.txt "$DLW/fake" 2>/dev/null; then
  bad "the workspace key leaked into a tree, the output or the request log"
fi
kill "$DL_PID" 2>/dev/null; wait "$DL_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "== Test 36: the engine's agent, the block reading and sign-in --release, against the local fake sikstack behind its Cloudflare gate -- a request without a sikstack/ agent is the gate's text 403 (the gate is not vacuous) and the engine's are let through; a non-JSON 403 reads as a block (never as not a workspace key) at link, the cloud session's stop line, a commit and design-builds, and a JSON 403 reads as before; sign-in without --release sends exactly its three fields; --release sends release: true, drops the pending code for a new one, prints the released or the not-connected line, and a server that answers no released is refused with nothing kept; a release that is not a boolean is the fake's 400 =="
newtmp RLW; RLK="release-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"; printf '%s\n' "$RLK" > "$RLW/key"; chmod 600 "$RLW/key"
python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$RLW/fake" --port-file "$RLW/port" --key-file "$RLW/key" --project p-rl --org o-rl \
  --lifetime 300 > "$RLW/fake.txt" 2>&1 &
RL_PID=$!
for _ in $(seq 1 100); do [ -s "$RLW/port" ] && break; sleep 0.1; done
RLS="http://127.0.0.1:$(cat "$RLW/port" 2>/dev/null)"; RLL="$RLW/fake/requests.jsonl"
rl_ctl() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$RLS/_fake/control" >/dev/null; }
rl() { _h=$1; shift; ( cd "$RLW/$_h" && XDG_CONFIG_HOME="$RLW/xdg" python3 "$ENG" "$@" ) 2>&1; }
rl_code() { sed -n 's/^code: \([A-Z0-9-]*\) .*/\1/p' "$1" | head -1; }
# (a) the gate: urllib's own agent is the block, a sikstack/ agent reaches the API (its 401 here, no key sent).
rl_gate=$(python3 - "$RLS" <<'PY'
import sys, urllib.error, urllib.request
for agent in (None, "sikstack/0.0.0"):
    headers = {"User-Agent": agent} if agent else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(sys.argv[1] + "/api/workspace/p-rl/head", headers=headers)) as r:
            print(r.status)
    except urllib.error.HTTPError as e:
        print(e.code, e.headers.get("Content-Type"), e.read().decode())
PY
)
rl_blocked=$(grep -c '"route": "blocked"' "$RLL" 2>/dev/null)
[ "$(printf '%s\n' "$rl_gate" | sed -n 1p)" = "403 text/plain; charset=UTF-8 error code: 1010" ] \
  && printf '%s\n' "$rl_gate" | sed -n 2p | grep -q '^401 application/json' && [ "$rl_blocked" = 1 ] \
  && grep '"route": "blocked"' "$RLL" | grep -q '"agent": "Python-urllib/' \
  && ok "the fake's gate answers urllib's own agent with the text 403 'error code: 1010' (logged as blocked) and lets a sikstack/ agent through to the API" \
  || bad "the fake's gate -- [$rl_gate] blocked=$rl_blocked"
# (b) link: a block, then the API's JSON 403, each one line with nothing written; then the link lands.
{ mkhost "$RLW/repo" && git -C "$RLW/repo/.sikstack" add -A && git -C "$RLW/repo/.sikstack" commit -q --allow-empty -m seed; } >/dev/null 2>&1
rl_ctl '{"block": "head"}'
rl_l1=$(printf '%s\n' "$RLK" | rl repo link "$RLS/projects/p-rl"); rl_lrc1=$?
rl_ctl '{"workspace_answer": {"status": 403, "detail": "a member key cannot reach a workspace", "route": "head"}}'
rl_l2=$(printf '%s\n' "$RLK" | rl repo link "$RLS/projects/p-rl"); rl_lrc2=$?
rl_cloud0=$(grep -c '^\[cloud\]' "$RLW/repo/.sikstack/config.toml")
rl_l3=$(printf '%s\n' "$RLK" | rl repo link "$RLS/projects/p-rl"); rl_lrc3=$?
[ "$rl_lrc1" = 1 ] && printf '%s\n' "$rl_l1" | grep -q "the request to $RLS was blocked before it reached sikstack (HTTP 403: error code: 1010), by something in front of it: nothing was written" \
  && ! printf '%s\n' "$rl_l1" | grep -q 'not a workspace key' \
  && [ "$rl_lrc2" = 1 ] && printf '%s\n' "$rl_l2" | grep -q 'this key cannot reach a workspace (HTTP 403: it is not a workspace key)' \
  && ! printf '%s\n' "$rl_l2" | grep -q 'blocked before' && [ "$rl_cloud0" = 0 ] && [ "$rl_lrc3" = 0 ] \
  && ok "link reads a non-JSON 403 as a block (HTTP 403 and the body's line, never 'not a workspace key') and the API's JSON 403 as before, each with nothing written; then it links" \
  || bad "link's 403 split -- rc=$rl_lrc1/$rl_lrc2/$rl_lrc3 [$rl_l1] [$rl_l2] cloud=$rl_cloud0 [$(printf '%s\n' "$rl_l3" | tail -2)]"
# (c) a linked command: a block at the begin step's head is the stop line; a block on the commit is its unsent line.
rl_ctl '{"block": "head"}'
rl_n1=$(rl repo next); rl_nrc1=$?
rl_ctl '{"block": "commit"}'
rl_n2=$(rl repo agenda-add --title "blocked commit" --author person:smoke); rl_nrc2=$?
rl_n3=$(rl repo sync); rl_nrc3=$?
[ "$rl_nrc1" != 0 ] && printf '%s\n' "$rl_n1" | grep -q "sikstack is not reachable at $RLS: the request was blocked before it reached sikstack (HTTP 403: error code: 1010), by something in front of it; in cloud mode nothing runs offline, and nothing was changed." \
  && ! printf '%s\n' "$rl_n1" | grep -q 'not a workspace key' \
  && [ "$rl_nrc2" = 1 ] && printf '%s\n' "$rl_n2" | grep -q '^this change is on disk but not in sikstack (the request was blocked before it reached sikstack (HTTP 403: error code: 1010)): run sync$' \
  && [ "$rl_nrc3" = 0 ] \
  && ok "in a linked checkout a block at the begin step stops the command with the block's line, and a block on the commit leaves the change on disk with it (sync then sends it)" \
  || bad "the session's block lines -- rc=$rl_nrc1/$rl_nrc2/$rl_nrc3 [$rl_n1] [$rl_n2] [$rl_n3]"
# (d) design: a block, then the API's JSON 403.
rl_ctl '{"block": "builds"}'
rl_d1=$(rl repo design-builds); rl_drc1=$?
rl_ctl '{"design_answer": {"status": 403, "detail": "this key cannot reach a workspace"}}'
rl_d2=$(rl repo design-builds); rl_drc2=$?
[ "$rl_drc1" = 1 ] && [ "$rl_d1" = "design-builds: the request to $RLS was blocked before it reached sikstack (HTTP 403: error code: 1010), by something in front of it (nothing was read)" ] \
  && [ "$rl_drc2" = 1 ] && [ "$rl_d2" = "design-builds: sikstack refused (HTTP 403): this key cannot reach a workspace; this is not a workspace key: make one under Keys on the project's page (nothing was read)" ] \
  && ok "design-builds reads a non-JSON 403 as a block and the API's JSON 403 as before, one line each" \
  || bad "design's 403 split -- rc=$rl_drc1/$rl_drc2 [$rl_d1] [$rl_d2]"
# (e) sign-in --release on a second checkout.
{ mkhost "$RLW/rel" && git -C "$RLW/rel/.sikstack" add -A && git -C "$RLW/rel/.sikstack" commit -q --allow-empty -m seed; } >/dev/null 2>&1
( cd "$RLW/rel" && CLAUDE_CONFIG_DIR="$RLW/cfg" SIKSTACK_SERVER="$RLS" python3 "$ENG" setup --email r@example.com --data-dir "$RLW/data" ) >/dev/null 2>&1
rl_si() { rl rel sign-in --data-dir "$RLW/data" --no-browser --wait 1 "$@"; echo "rc=$?"; }
rl_si > "$RLW/s1.txt"                          # plain: three fields, a pending code
rl_si --release > "$RLW/s2.txt"                # not claimed yet: a new code, the not-connected line
curl -s -X POST "$RLS/_fake/sign-in" -d "{\"code\":\"$(rl_code "$RLW/s2.txt")\",\"state\":\"approved\"}" >/dev/null   # another account claims it
rl_si --release > "$RLW/s3.txt"                # claimed: released, a new code
rl_ctl '{"no_release": true}'
rl_si --release > "$RLW/s4.txt"                # a server from before release
rl_ctl '{"no_release": false}'
rl_left=$(ls "$RLW/data/sign-in" 2>/dev/null)
rl_bodies=$(python3 - "$RLL" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e.get("route") == "sign-in":
        b = e["body"]
        print(",".join(sorted(b)) + ("" if "release" not in b else f" release={json.dumps(b['release'])}"))
PY
)
rl_bad=$(python3 - "$RLS" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["install_id"])' "$RLW/data/install.json")" <<'PY'
import json, sys, urllib.error, urllib.request
for value in ("yes", None, 1):
    body = json.dumps({"install_id": sys.argv[2], "repo": "rel", "plugin_version": "x", "release": value}).encode()
    req = urllib.request.Request(sys.argv[1] + "/api/installs/sign-in", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "sikstack/0.0.0"})
    try:
        urllib.request.urlopen(req)
        print("200")
    except urllib.error.HTTPError as e:
        print(e.code, json.loads(e.read())["detail"])
PY
)
c1=$(rl_code "$RLW/s1.txt"); c2=$(rl_code "$RLW/s2.txt"); c3=$(rl_code "$RLW/s3.txt")
grep -q '^rc=3' "$RLW/s1.txt" && grep -q '^rc=3' "$RLW/s2.txt" && grep -q '^rc=3' "$RLW/s3.txt" \
  && [ -n "$c1" ] && [ -n "$c2" ] && [ -n "$c3" ] && [ "$c1" != "$c2" ] && [ "$c2" != "$c3" ] \
  && ! grep -q '^release' "$RLW/s1.txt" \
  && grep -qx 'release: this install was not connected to an account, so nothing was released' "$RLW/s2.txt" \
  && grep -qx 'released: this install no longer belongs to its previous account; the next Connect claims it' "$RLW/s3.txt" \
  && ! grep -q 'waiting for the connect page again' "$RLW/s2.txt" "$RLW/s3.txt" \
  && grep -q '^rc=1' "$RLW/s4.txt" && grep -qx "sikstack sign-in: $RLS does not support --release yet: nothing was released" "$RLW/s4.txt" \
  && [ -z "$rl_left" ] \
  && [ "$rl_bodies" = "$(printf 'install_id,plugin_version,repo\ninstall_id,plugin_version,release,repo release=true\ninstall_id,plugin_version,release,repo release=true\ninstall_id,plugin_version,release,repo release=true')" ] \
  && [ "$rl_bad" = "$(printf '400 release is not valid\n400 release is not valid\n400 release is not valid')" ] \
  && ok "sign-in sends exactly its three fields; --release sends release: true, drops the pending code for a new one and prints the not-connected or the released line; a server that answers no released is refused in one line with no pending code kept; the fake's start refuses a release that is not a boolean" \
  || bad "sign-in --release -- codes=$c1/$c2/$c3 left=[$rl_left] bodies=[$rl_bodies] bad=[$rl_bad] [$(cat "$RLW/s1.txt")] [$(cat "$RLW/s2.txt")] [$(cat "$RLW/s3.txt")] [$(cat "$RLW/s4.txt")]"
if grep -rqF "$RLK" "$RLW"/*.txt "$RLW/fake" "$RLW/repo" 2>/dev/null || printf '%s\n' "$rl_l1$rl_l2$rl_n1$rl_n2$rl_d1$rl_d2" | grep -qF "$RLK"; then
  bad "the workspace key leaked into the tree, the output or the request log"
fi
kill "$RL_PID" 2>/dev/null; wait "$RL_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "== Test 37: an edge block in every form, against the local fake sikstack -- a 403 is sikstack's own only when it is the API's JSON (Content-Type application/json, an object with detail and none of an RFC 9457 problem's members): Cloudflare's JSON problem for a 1xxx error (what it answers a request that accepts JSON) reads as a block at link and design-builds, never as not a workspace key; a block page that echoes the key across its 80th character prints none of it; sign-in's start and its poll and feedback read a block as one: a blocked start writes nothing, a blocked poll ends the wait with the block's line and keeps the code, and the next run resumes it =="
newtmp BKW; BKK=$(python3 -c 'import secrets; print("vk_" + secrets.token_urlsafe(32))'); printf '%s\n' "$BKK" > "$BKW/key"; chmod 600 "$BKW/key"
python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$BKW/fake" --port-file "$BKW/port" --key-file "$BKW/key" --project p-bk --org o-bk \
  --lifetime 300 > "$BKW/fake.txt" 2>&1 &
BK_PID=$!
for _ in $(seq 1 100); do [ -s "$BKW/port" ] && break; sleep 0.1; done
BKS="http://127.0.0.1:$(cat "$BKW/port" 2>/dev/null)"; BKL="$BKW/fake/requests.jsonl"
bk_ctl() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$BKS/_fake/control" >/dev/null; }
bk() { _h=$1; shift; ( cd "$BKW/$_h" && XDG_CONFIG_HOME="$BKW/xdg" python3 "$ENG" "$@" ) 2>&1; echo "rc=$?"; }
bk_block="blocked before it reached sikstack (HTTP 403: error code: 1010)"
# (a) the rule, in the engine's own process: only the API's JSON is sikstack's 403.
bk_rule=$(PYTHONPATH="$PLUGIN/scripts" python3 - "$BKK" <<'PY' 2>&1
import json, sys
import wf_setup
key = sys.argv[1]
problem = json.dumps({"type": "https://developers.cloudflare.com/x", "title": "Error 1010: Access denied", "status": 403,
                      "detail": "blocked", "instance": "r", "error_code": 1010, "ray_id": "r", "cloudflare_error": True}).encode()
cases = [
    (403, b'{"detail":"the scope is full: workspace routes need a workspace key"}', "application/json", None),
    (403, b'{"detail":"not a member of that org"}', "application/json; charset=utf-8", None),
    (401, b"error code: 1010", "text/plain", None),
    (403, b'{"detail":"x"}', "application/problem+json", "blocked before it reached sikstack (HTTP 403: x)"),
    (403, b'{"detail":"x"}', "", "blocked before it reached sikstack (HTTP 403: x)"),
    (403, b'{"detail":"x","status":403}', "application/json", "blocked before it reached sikstack (HTTP 403: x)"),
    (403, b'{"message":"no"}', "application/json", "blocked before it reached sikstack (HTTP 403: no)"),
    (403, problem, "application/json; charset=utf-8", "blocked before it reached sikstack (HTTP 403: error code: 1010)"),
    (403, problem, "application/problem+json", "blocked before it reached sikstack (HTTP 403: error code: 1010)"),
    (403, b"error code: 1010", "text/plain; charset=UTF-8", "blocked before it reached sikstack (HTTP 403: error code: 1010)"),
    (403, b"<html>\n<title>Forbidden</title>", "text/html", "blocked before it reached sikstack (HTTP 403: <html>)"),
    (403, b"", "", "blocked before it reached sikstack (HTTP 403)"),
]
for status, raw, kind, want in cases:
    got = wf_setup.block_line(status, raw, kind, key)
    print("ok" if got == want else f"MISS {status} {raw[:40]!r} {kind!r}: {got!r}")
for filler in (0, 20, 41, 60, 75):
    got = wf_setup.block_line(403, b"x" * filler + b" Authorization: Bearer " + key.encode() + b" refused", "text/plain", key)
    leaked = [key[i:i + 6] for i in range(len(key) - 5) if key[i:i + 6] in got]
    print("ok" if not leaked and len(got) <= 127 else f"LEAK {filler}: {got!r}")
PY
)
[ -n "$bk_rule" ] && ! printf '%s\n' "$bk_rule" | grep -qv '^ok$' \
  && ok "a 403 is sikstack's own only as the API's JSON (application/json, an object with detail, no problem members); a problem, problem+json, text, HTML or an empty body is a block, and a body that echoes the key never shows any of it" \
  || bad "the block rule -- [$bk_rule]"
# (b) Cloudflare's JSON problem (the form it answers a request that accepts JSON) at link and at design-builds.
{ mkhost "$BKW/repo" && git -C "$BKW/repo/.sikstack" add -A && git -C "$BKW/repo/.sikstack" commit -q --allow-empty -m seed; } >/dev/null 2>&1
bk_ctl '{"block_form": "json"}'
bk_ctl '{"block": "head"}'
bk_l1=$(printf '%s\n' "$BKK" | bk repo link "$BKS/projects/p-bk")
bk_json=$(grep '"route": "blocked"' "$BKL" | tail -1)
bk_cloud0=$(grep -c '^\[cloud\]' "$BKW/repo/.sikstack/config.toml")
bk_l2=$(printf '%s\n' "$BKK" | bk repo link "$BKS/projects/p-bk")
bk_ctl '{"block": "builds"}'
bk_d1=$(bk repo design-builds)
printf '%s\n' "$bk_json" | grep -q '"form": "json"' && printf '%s\n' "$bk_json" | grep -q '"accept": "application/json"' \
  && [ "$(printf '%s\n' "$bk_l1" | tail -1)" = rc=1 ] && printf '%s\n' "$bk_l1" | grep -qF "the request to $BKS was $bk_block, by something in front of it: nothing was written" \
  && ! printf '%s\n' "$bk_l1" | grep -q 'not a workspace key' && [ "$bk_cloud0" = 0 ] && [ "$(printf '%s\n' "$bk_l2" | tail -1)" = rc=0 ] \
  && [ "$bk_d1" = "$(printf '%s\nrc=1' "design-builds: the request to $BKS was $bk_block, by something in front of it (nothing was read)")" ] \
  && ok "Cloudflare's JSON problem for a 1xxx error (the engine accepts JSON, so that is the form it gets) reads as a block at link and at design-builds, never as not a workspace key; then the link lands" \
  || bad "the JSON problem -- json=[$bk_json] cloud=$bk_cloud0 [$bk_l1] [$(printf '%s\n' "$bk_l2" | tail -2)] [$bk_d1]"
# (c) a block page that echoes the Authorization header with the key across its 80th character.
bk_ctl '{"block_form": "echo"}'
bk_ctl '{"block": "head"}'
bk_e1=$(bk repo next)
bk_ctl '{"block_form": "text"}'
bk_leak=$(python3 - "$BKK" "$bk_e1" <<'PY'
import sys
key, out = sys.argv[1], sys.argv[2]
print(" ".join(key[i:i + 6] for i in range(len(key) - 5) if key[i:i + 6] in out))
PY
)
printf '%s\n' "$bk_e1" | grep -qF "the request was blocked before it reached sikstack (HTTP 403: refused at the edge; it carried Authorization: Bearer <key> and nothing else), by something in front of it" \
  && [ -z "$bk_leak" ] && [ "$(printf '%s\n' "$bk_e1" | tail -1)" != rc=0 ] \
  && ok "a block page that echoes the key across its 80th character prints <key> in its place and none of the key" \
  || bad "the echoed key -- leaked=[$bk_leak] [$bk_e1]"
# (d) sign-in's start, its poll and feedback, each blocked.
{ mkhost "$BKW/si" && git -C "$BKW/si/.sikstack" add -A && git -C "$BKW/si/.sikstack" commit -q --allow-empty -m seed; } >/dev/null 2>&1
( cd "$BKW/si" && CLAUDE_CONFIG_DIR="$BKW/cfg" SIKSTACK_SERVER="$BKS" python3 "$ENG" setup --email b@example.com --data-dir "$BKW/data" ) >/dev/null 2>&1
bk_si() { bk si sign-in --data-dir "$BKW/data" --no-browser --wait 1 "$@"; }
bk_ctl '{"block": "sign-in"}'
bk_s1=$(bk_si); bk_left1=$(ls "$BKW/data/sign-in" 2>/dev/null)
bk_ctl '{"block_form": "json"}'
bk_ctl '{"block": "sign-in"}'
bk_s2=$(bk_si --release); bk_left2=$(ls "$BKW/data/sign-in" 2>/dev/null)
bk_ctl '{"block_form": "text"}'
bk_s3=$(bk_si); bk_c3=$(printf '%s\n' "$bk_s3" | sed -n 's/^code: \([A-Z0-9-]*\) .*/\1/p' | head -1)
bk_ctl '{"block": "poll"}'
bk_s4=$(bk_si); bk_left4=$(ls "$BKW/data/sign-in" 2>/dev/null)
bk_s5=$(bk_si)
bk_ctl '{"block": "feedback"}'
bk_f1=$( ( cd "$BKW/si" && python3 "$ENG" feedback --data-dir "$BKW/data" --message "a blocked report" ) 2>&1; echo "rc=$?")
bk_rep=$(curl -s "$BKS/_fake/reports" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["reports"]))')
bk_start="sikstack sign-in: the request to $BKS was $bk_block, by something in front of it: nothing was written"
[ "$bk_s1" = "$(printf '%s\nrc=1' "$bk_start")" ] && [ -z "$bk_left1" ] \
  && [ "$bk_s2" = "$(printf '%s\nrc=1' "$bk_start")" ] && [ -z "$bk_left2" ] \
  && [ -n "$bk_c3" ] && [ "$(printf '%s\n' "$bk_s3" | tail -1)" = rc=3 ] \
  && printf '%s\n' "$bk_s4" | grep -qx "waiting for the connect page again (code $bk_c3)" \
  && printf '%s\n' "$bk_s4" | grep -qxF "sikstack sign-in: the request to $BKS was $bk_block, by something in front of it: the code $bk_c3 is kept; run \`sikstack sign-in\` again to keep waiting" \
  && [ "$(printf '%s\n' "$bk_s4" | tail -1)" = rc=1 ] && ! printf '%s\n' "$bk_s4" | grep -q 'still waiting' && [ -n "$bk_left4" ] \
  && printf '%s\n' "$bk_s5" | grep -qx "waiting for the connect page again (code $bk_c3)" && [ "$(printf '%s\n' "$bk_s5" | tail -1)" = rc=3 ] \
  && [ "$bk_f1" = "$(printf '%s\nrc=1' "sikstack feedback: the request to $BKS was $bk_block, by something in front of it: nothing was sent")" ] && [ "$bk_rep" = 0 ] \
  && ok "sign-in's start reads a block (text or JSON) as one and writes nothing; a blocked poll ends the wait with the block's line and keeps the code, and the next run resumes it; feedback reads a block as one" \
  || bad "sign-in and feedback under a block -- c3=$bk_c3 left=[$bk_left1|$bk_left2|$bk_left4] reports=$bk_rep [$bk_s1] [$bk_s2] [$bk_s3] [$bk_s4] [$bk_s5] [$bk_f1]"
if grep -rqF "$BKK" "$BKW"/*.txt "$BKW/fake" "$BKW/repo" "$BKW/si" 2>/dev/null || printf '%s\n' "$bk_l1$bk_l2$bk_d1$bk_e1$bk_s1$bk_s2$bk_s3$bk_s4$bk_s5$bk_f1" | grep -qF "$BKK"; then
  bad "the workspace key leaked into the tree, the output or the request log"
fi
kill "$BK_PID" 2>/dev/null; wait "$BK_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "== Test 38: agenda-feedback against the local fake sikstack -- an unlinked checkout is refused with the sign-in line and nothing is written; list prints the untriaged feedback newest first, one line each led by its id, outside the cloud boundary; file --agenda writes a feedback item (source feedback:<id>, the message and its URL) then records filed; file --new opens a new agenda by agenda-add's rule (an agent's is Proposed) holding it; a failed record leaves the item, lands it in sikstack and prints one line saying to run it again, and the rerun records without a second item; dismiss records with its reason and writes nothing here; a filed or dismissed piece never lists again, on this checkout or another; the key appears nowhere =="
newtmp AFW; AFX="$AFW/xdg"; AFH="$AFW/prod"; AFU="$AFW/unlinked"; AFO="$AFW/other"
af() { _h=$1; shift; ( cd "$_h" && XDG_CONFIG_HOME="$AFX" python3 "$ENG" "$@" ) 2>&1; }
{ mkhost "$AFH" && mkhost "$AFU" && mkhost "$AFO"; } > "$AFW/setup.txt" 2>&1 || bad "agenda-feedback probe: the installs failed -- $(tail -3 "$AFW/setup.txt")"
AFK="feedback-smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$AFK" > "$AFW/key"; chmod 600 "$AFW/key"
python3 "$REPO_ROOT/tests/fake_sikstack.py" --dir "$AFW/fake" --port-file "$AFW/port" --key-file "$AFW/key" \
  --project proj-1 --org org-1 --lifetime 900 > "$AFW/fake.txt" 2>&1 &
AF_PID=$!
for _ in $(seq 1 100); do [ -s "$AFW/port" ] && break; sleep 0.1; done
AFS="http://127.0.0.1:$(cat "$AFW/port" 2>/dev/null)"
for _h in "$AFH" "$AFO"; do
  printf '%s\n' "$AFK" | ( cd "$_h" && XDG_CONFIG_HOME="$AFX" python3 "$ENG" link "$AFS/projects/proj-1" ) >> "$AFW/link.txt" 2>&1 \
    || bad "agenda-feedback probe: the link failed -- $(tail -2 "$AFW/link.txt")"
done
AFL="$AFW/fake/requests.jsonl"
af_add() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$AFS/_fake/feedback" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'; }
af_ctl() { curl -s -X POST -H 'Content-Type: application/json' -d "$1" "$AFS/_fake/control" >/dev/null; }
af_ws() { grep -c '"path": "/api/workspace/' "$AFL" 2>/dev/null || true; }
af_items() { find "$1/.sikstack/works/agenda" -path '*/entries/*.json' 2>/dev/null | wc -l | tr -d ' '; }
AF_A=$(af_add '{"message": "Export hangs at 99%\nOn a 2 GB file", "channel": "web", "value": 2, "comment": "every time"}')
AF_B=$(af_add '{"message": "Search is slow"}')
AF_C=$(af_add '{"message": "Love the pager"}')
AF_D=$(af_add '{"message": "spam spam"}')
af_aid=$(af "$AFH" agenda-add --title "Export" --author person:op | sed -n 's/^added \(A[0-9]*-[a-z0-9]*\): .*/\1/p')
mkdir -p "$AFU/.sikstack/works/agenda" && cp -R "$AFH/.sikstack/works/agenda/$af_aid" "$AFU/.sikstack/works/agenda/"
# (a) unlinked: the sign-in line, nothing written, nothing sent.
af_u0=$(af_items "$AFU"); af_n0=$(grep -c '"route": "triage"' "$AFL" 2>/dev/null || true)
af_o1=$(af "$AFU" agenda-feedback list); af_rc1=$?
af_o2=$(af "$AFU" agenda-feedback file "$AF_A" --agenda "$af_aid" --author person:op); af_rc2=$?
af_o3=$(af "$AFU" agenda-feedback dismiss "$AF_A" --author person:op); af_rc3=$?
[ "$af_rc1$af_rc2$af_rc3" = 111 ] && [ -n "$af_aid" ] \
  && printf '%s\n' "$af_o1" | grep -q '^agenda-feedback list: this checkout is not linked to sikstack .*run /sikstack:sign-in .*(nothing was read)$' \
  && printf '%s\n' "$af_o2" | grep -q '^agenda-feedback file: this checkout is not linked to sikstack .*(nothing was filed)$' \
  && printf '%s\n' "$af_o3" | grep -q '^agenda-feedback dismiss: this checkout is not linked to sikstack .*(nothing was dismissed)$' \
  && [ "$(printf '%s\n' "$af_o2" | grep -c '^agenda-feedback')" = 1 ] && [ "$(af_items "$AFU")" = "$af_u0" ] \
  && [ "$(grep -c '"route": "triage"' "$AFL" 2>/dev/null || true)" = "$af_n0" ] \
  && ok "an unlinked checkout is refused with the one sign-in line by list, file and dismiss; nothing is written or sent" \
  || bad "the unlinked refusal is wrong -- aid=$af_aid rc=$af_rc1$af_rc2$af_rc3 [$af_o1] [$af_o2] [$af_o3]"
# (b) list: newest first, one line each led by its id; outside the cloud boundary.
af_ws0=$(af_ws)
af_o4=$(af "$AFH" agenda-feedback list); af_rc4=$?
[ "$af_rc4" = 0 ] && [ "$(printf '%s\n' "$af_o4" | sed -n 1p)" = "untriaged=4 more=no project=proj-1" ] \
  && printf '%s\n' "$af_o4" | sed -n 2p | grep -q "^$AF_D at=" && printf '%s\n' "$af_o4" | sed -n 4p | grep -q "^$AF_B at=" \
  && printf '%s\n' "$af_o4" | sed -n 5p | grep -qxF "$AF_A at=2026-11-25T01:00:00Z channel=web value=2 url=http://fake.localhost/feedback/$AF_A -- Export hangs at 99% On a 2 GB file | comment: every time" \
  && [ "$(af_ws)" = "$af_ws0" ] \
  && ok "agenda-feedback list prints the untriaged feedback newest first, one line each led by its id (when, channel, value, url, the message and its comment), with no workspace request around it" \
  || bad "the list is wrong -- rc=$af_rc4 ws=$af_ws0/$(af_ws) [$af_o4]"
# (c) file --agenda: the item, then the mark; file --new: an agent's new agenda is Proposed, holding it.
af_o5=$(af "$AFH" agenda-feedback file "$AF_A" --agenda "$af_aid" --author person:op); af_rc5=$?
af_o6=$(af "$AFH" agenda-feedback file "$AF_B" --new --title "Search speed" --author agent:claude-opus-5-5); af_rc6=$?
af_new=$(printf '%s\n' "$af_o6" | sed -n 's/^added \(A[0-9]*-[a-z0-9]*\): Search speed (Proposed: agenda-accept or agenda-drop it)$/\1/p')
af_item=$(find "$AFH/.sikstack/works/agenda/$af_aid/entries" -name '*.json' | head -1)
af_post=$(grep '"route": "triage"' "$AFL" | grep '"method": "POST"' | head -1)
af_body=$(python3 - "$af_item" "$AF_A" <<'PY2' 2>&1
import json, sys
d = json.load(open(sys.argv[1]))
assert d["kind"] == "feedback" and d["source"] == "feedback:" + sys.argv[2] and d["author"] == "person:op", d
assert d["body"] == "Export hangs at 99%\nOn a 2 GB file\n\nhttp://fake.localhost/feedback/" + sys.argv[2], d
print("ok")
PY2
)
af_shown=$(af "$AFH" agenda --json | python3 -c 'import json,sys; print([a["shown_status"] for a in json.load(sys.stdin) if a["id"] == sys.argv[1]][0])' "$af_new" 2>&1)
[ "$af_rc5" = 0 ] && [ "$af_rc6" = 0 ] && [ -n "$af_new" ] && [ "$af_body" = ok ] && [ "$af_shown" = Proposed ] \
  && printf '%s\n' "$af_o5" | sed -n 1p | grep -q "^added item $af_aid/[0-9a-z]\{4\} (.*): feedback by person:op (feedback:$AF_A)\$" \
  && [ "$(printf '%s\n' "$af_o5" | sed -n 2p)" = "filed=$AF_A agenda=$af_aid" ] \
  && [ "$(printf '%s\n' "$af_o6" | tail -1)" = "filed=$AF_B agenda=$af_new" ] \
  && printf '%s\n' "$af_post" | grep -qF "\"body\": {\"state\": \"filed\", \"agenda\": \"$af_aid\", \"by\": \"person:op\"}" \
  && ok "file --agenda writes a feedback item (source feedback:<id>, the message and its URL) then records filed on that agenda; file --new opens an agent's Proposed agenda holding it and records filed there" \
  || bad "file is wrong -- rc=$af_rc5/$af_rc6 new=$af_new shown=$af_shown body=[$af_body] post=[$af_post] [$af_o5] [$af_o6]"
# (d) a failed record: the item stays (and lands in sikstack), one line says to run it again; the rerun only records.
af_ctl '{"triage_answer": {"status": 503, "detail": "the store is unavailable", "method": "POST"}}'
af_i7=$(af_items "$AFH")
af_o7=$(af "$AFH" agenda-feedback file "$AF_C" --agenda "$af_aid" --author person:op); af_rc7=$?
af_i8=$(af_items "$AFH")
af_o8=$(af "$AFH" agenda-feedback file "$AF_C" --agenda "$af_aid" --author person:op); af_rc8=$?
af_landed=$(curl -s "$AFS/_fake/state" | python3 -c 'import json,sys; print(sum(1 for p, r in json.load(sys.stdin)["files"].items() if "/entries/" in p and not r["deleted"]))')
[ "$af_rc7" = 1 ] && [ "$af_rc8" = 0 ] && [ "$af_i8" = "$((af_i7 + 1))" ] && [ "$(af_items "$AFH")" = "$af_i8" ] \
  && printf '%s\n' "$af_o7" | grep -q "^added item $af_aid/" \
  && printf '%s\n' "$af_o7" | grep -qxF "agenda-feedback file: sikstack refused (HTTP 503): the store is unavailable (not recorded); the item stays on $af_aid: run sikstack agenda-feedback file $AF_C --agenda $af_aid --author person:op again to record it" \
  && [ "$af_landed" = 3 ] \
  && [ "$af_o8" = "$(printf '%s\n%s' "already on $af_aid: an item there holds feedback:$AF_C, so only the mark is recorded" "filed=$AF_C agenda=$af_aid")" ] \
  && ok "a failed record leaves the item (it still lands in sikstack) and one line saying to run file again; the rerun records the mark without a second item" \
  || bad "the failed record is wrong -- rc=$af_rc7/$af_rc8 items=$af_i7/$af_i8/$(af_items "$AFH") landed=$af_landed [$af_o7] [$af_o8]"
# (e) dismiss: the mark with its reason, nothing written here; then nothing lists, on this checkout or another.
af_i9=$(af_items "$AFH"); af_ws9=$(af_ws)
af_o9=$(af "$AFH" agenda-feedback dismiss "$AF_D" --reason "spam" --author person:op); af_rc9=$?
af_o10=$(af "$AFO" agenda-feedback list); af_rc10=$?
af_o11=$(af "$AFH" agenda-feedback list --json)
[ "$af_rc9" = 0 ] && [ "$af_o9" = "dismissed=$AF_D reason=spam" ] && [ "$(af_items "$AFH")" = "$af_i9" ] && [ "$(af_ws)" = "$af_ws9" ] \
  && grep '"route": "triage"' "$AFL" | grep -qF "\"body\": {\"state\": \"dismissed\", \"reason\": \"spam\", \"by\": \"person:op\"}" \
  && [ "$af_rc10" = 0 ] && [ "$af_o10" = "untriaged=0 more=no project=proj-1" ] \
  && printf '%s\n' "$af_o11" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d == {"project": "proj-1", "feedback": [], "more": False}, d' \
  && ok "dismiss records the mark with its reason and writes nothing here; a filed or dismissed piece never lists again, on this checkout or another linked one (--json alike)" \
  || bad "dismiss or the second list is wrong -- rc=$af_rc9/$af_rc10 [$af_o9] [$af_o10] [$af_o11]"
# (f) refusals before any request: a bad id, an unknown agenda, --new without --title, --title without --new.
af_n12=$(grep -c '"route": "triage"' "$AFL"); af_i12=$(af_items "$AFH")
af_o12=$(af "$AFH" agenda-feedback file nope --agenda "$af_aid" --author person:op); af_rc12=$?
af_o13=$(af "$AFH" agenda-feedback file "$AF_A" --agenda A99-zz --author person:op); af_rc13=$?
af_o14=$(af "$AFH" agenda-feedback file "$AF_A" --new --author person:op); af_rc14=$?
af_o15=$(af "$AFH" agenda-feedback file "$AF_A" --agenda "$af_aid" --title x --author person:op); af_rc15=$?
[ "$af_rc12$af_rc13$af_rc14$af_rc15" = 1111 ] && [ "$(grep -c '"route": "triage"' "$AFL")" = "$af_n12" ] && [ "$(af_items "$AFH")" = "$af_i12" ] \
  && printf '%s\n' "$af_o12" | grep -q "^agenda-feedback file: 'nope' is not a feedback id" \
  && printf '%s\n' "$af_o13" | grep -qx 'A99-zz names no agenda' \
  && printf '%s\n' "$af_o14" | grep -q '^agenda-feedback file: --new needs --title' \
  && printf '%s\n' "$af_o15" | grep -q '^agenda-feedback file: --title goes with --new only' \
  && ok "a bad feedback id, an unknown agenda, --new without --title and --title without --new are refused in one line before any request" \
  || bad "a refusal is wrong -- rc=$af_rc12$af_rc13$af_rc14$af_rc15 [$af_o12] [$af_o13] [$af_o14] [$af_o15]"
if grep -rqF "$AFK" "$AFH" "$AFO" "$AFW"/*.txt "$AFW/fake" 2>/dev/null || printf '%s\n' "$af_o4$af_o5$af_o7$af_o9" | grep -qF "$AFK"; then
  bad "the workspace key leaked into the tree, the output or the request log"
fi
kill "$AF_PID" 2>/dev/null; wait "$AF_PID" 2>/dev/null

# ---------------------------------------------------------------------------
echo "== Test 40: the engine stamp (works/engine.json) -- init commits it; against a stamp of a later release a write refuses in one line (both versions, restart Claude Code, the rollback way out, no friction offer) with nothing written, in-process through workflow.run too, and next and check run with one warning line and no rebuild; a newer engine raises it at its first real change (not at a same-bytes rewrite) and records (old, new) once; with no stamp the backlog's version line seeds old by release order (2.1.0 before 0.3.0), never refusing; a worktree's start commit carries it, the gate's exemption counts it, and merge-finish keeps the later release of the two sides; in cloud mode the refusal comes before any effect: unlink --from-disk keeps .hi2vi/ and the link, and a linked next leaves the web inbox pending for a current engine =="
# es_copy <var> <version>: a copy of this plugin whose plugin.json says <version>, listed atop its CHANGELOG like a release.
es_copy() { local _esd; newtmp _esd; cp -R "$PLUGIN/." "$_esd/"; python3 - "$_esd" "$2" <<'PY'
import json, sys
d, v = sys.argv[1:]
p = f"{d}/.claude-plugin/plugin.json"; j = json.load(open(p)); old = j["version"]; j["version"] = v; open(p, "w").write(json.dumps(j, indent=2) + "\n")
c = f"{d}/CHANGELOG.md"; t = open(c).read(); i = t.index(f"## {old} — ")
newer = [u for u in ("0.98.0", "0.99.0") if u == v or (v == "0.99.0" and u == "0.98.0")]
open(c, "w").write(t[:i] + "".join(f"## {u} — 2099-01-01\n\n- a later release.\n\n" for u in reversed(newer)) + t[i:])
PY
printf -v "$1" '%s' "$_esd/scripts/workflow.py"; }
es_copy ES98 0.98.0; es_copy ES99 0.99.0
ES_RUN=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN/.claude-plugin/plugin.json")
es_stamp() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$1/works/engine.json" 2>/dev/null || echo none; }
es_set() { printf '{\n  "version": "%s"\n}\n' "$2" > "$1/works/engine.json" && git -C "$1" add works/engine.json && git -C "$1" commit -qm "stamp $2"; }
es_tree() { ( cd "$1" && { git status --short; find works docs -type f -exec shasum {} +; } | sha_stdin ); }
newtmp ESH; mkhost "$ESH" >/dev/null 2>&1; ES="$ESH/.sikstack"
[ "$(es_stamp "$ES")" = "$ES_RUN" ] && [ "$(git -C "$ES" show HEAD:works/engine.json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')" = "$ES_RUN" ] \
  && [ -z "$(git -C "$ES" status --short)" ] \
  && ok "init writes works/engine.json at the plugin's version ($ES_RUN) and commits it with the workspace" || bad "init's stamp is wrong: $(es_stamp "$ES") / $(git -C "$ES" status --short)"
# (a) an older engine than the stamp: each write refuses in one line and writes nothing.
( cd "$ES" && python3 "$ENG" phase new --phase P1 --name probe --objective o >/dev/null && git add -A && git commit -qm p1 )
es_set "$ES" 99.0.0; es_t0=$(es_tree "$ES"); es_bad=""
for es_cmd in "phase new --phase P2 --name x --objective y" "slice status P1.DECOMP in_progress" "section P1 Now --append"; do
  es_o=$( cd "$ES" && printf -- '- a note\n' | env -u SIKSTACK_NO_OFFER python3 "$ENG" $es_cmd 2>&1 ); es_rc=$?  # shellcheck disable=SC2086
  { [ "$es_rc" = 1 ] && [ "$(printf '%s\n' "$es_o" | grep -c .)" = 1 ] \
      && printf '%s\n' "$es_o" | grep -qF "sikstack $ES_RUN is older than sikstack 99.0.0, which last wrote this workspace (.sikstack/works/engine.json), so it writes nothing: restart Claude Code to load the updated plugin, after updating it first if this machine's install is older (\`claude plugin update sikstack@sikstack\`) -- nothing was written (on a deliberate rollback to $ES_RUN: set that file's version to \"$ES_RUN\" and commit it)"; } \
    || es_bad="$es_bad [$es_cmd rc=$es_rc: $es_o]"
done
[ -z "$es_bad" ] && [ "$es_t0" = "$(es_tree "$ES")" ] && [ -z "$(git -C "$ES" status --short)" ] \
  && ok "against a stamp of 99.0.0, phase new, slice status and section --append each refuse in one line naming both versions, restart Claude Code and the rollback way out, exit 1, no friction offer, nothing written" \
  || bad "a write against a later stamp did not refuse cleanly --$es_bad -- $(git -C "$ES" status --short)"
es_o=$( cd "$ES" && python3 - "$PLUGIN/scripts" <<'PY' 2>&1
import sys
sys.path.insert(0, sys.argv[1])
import workflow
tokens = ["slice", "status", "P1.DECOMP", "in_progress"]
args = workflow.build_parser().parse_args(tokens)
args.cmd = f"{args.cmd} {args.verb}"
print(f"rc={workflow.with_offer(lambda: workflow.run(args, tokens), tokens)}")
PY
)
printf '%s\n' "$es_o" | grep -qx 'rc=1' && printf '%s\n' "$es_o" | grep -q "^sikstack $ES_RUN is older than sikstack 99.0.0, .*restart Claude Code" && [ "$es_t0" = "$(es_tree "$ES")" ] \
  && ok "the same write run in-process through workflow.run (the adapter's path) refuses the same way, nothing written" || bad "the in-process write did not refuse: $es_o"
# (b) reads still run: one warning line on stderr, no rebuild (the backlog keeps its inode).
es_ino=$(ls -i "$ES/works/backlog.md" | awk '{print $1}'); es_rbad=""
for es_cmd in "next" "check --no-rebuild" "check"; do
  es_out=$( cd "$ES" && python3 "$ENG" $es_cmd 2>"$ESH/err.txt" ); es_rc=$?  # shellcheck disable=SC2086
  { [ "$es_rc" = 0 ] && [ -n "$es_out" ] && [ "$(grep -c . "$ESH/err.txt")" = 1 ] \
      && grep -qx "warning: sikstack $ES_RUN is older than sikstack 99.0.0, which last wrote this workspace (.sikstack/works/engine.json): this command ran read-only and rebuilt nothing; restart Claude Code to load the updated plugin, after updating it first if this machine's install is older (\`claude plugin update sikstack@sikstack\`)" "$ESH/err.txt"; } \
    || es_rbad="$es_rbad [$es_cmd rc=$es_rc: $(cat "$ESH/err.txt")]"
done
[ -z "$es_rbad" ] && [ "$es_ino" = "$(ls -i "$ES/works/backlog.md" | awk '{print $1}')" ] && [ "$es_t0" = "$(es_tree "$ES")" ] \
  && ok "against it, next, check --no-rebuild and check exit 0 with their output and one warning line, and rewrite no dashboard" || bad "a read against a later stamp is wrong --$es_rbad"
es_set "$ES" "$ES_RUN"
( cd "$ES" && python3 "$ENG" slice status P1.DECOMP in_progress >/dev/null 2>&1 ) && [ "$(es_stamp "$ES")" = "$ES_RUN" ] \
  && ok "after the rollback edit the refusal names (the stamp set to the running version and committed), the write runs" || bad "the rollback way out did not work"
git -C "$ES" add -A && git -C "$ES" commit -qm work
# (c) a newer engine raises it at its first real change, once; a same-bytes rewrite alone raises nothing.
es_drive() { ( cd "$ES" && python3 - "$1" "${@:2}" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import workflow, wf_store
tokens = sys.argv[2:]
args = workflow.build_parser().parse_args(tokens)
if getattr(args, "verb", None):
    args.cmd = f"{args.cmd} {args.verb}"
code = workflow.with_offer(lambda: workflow.run(args, tokens), tokens)
print(f"rc={code} raised={wf_store._ENGINE['raised']}")
PY
) 2>&1 | tail -1; }
es_r1=$(es_drive "$(dirname "$ES98")" next); es_s1=$(es_stamp "$ES")
es_r2=$(es_drive "$(dirname "$ES98")" slice status P1.DECOMP ready); git -C "$ES" add -A && git -C "$ES" commit -qm raised
git -C "$ES" show HEAD~1:works/engine.json > "$ES/works/engine.json" && git -C "$ES" commit -qam "stamp back, the dashboards already the newer engine's"
es_r3=$(es_drive "$(dirname "$ES98")" next); es_s3=$(es_stamp "$ES")
[ "$es_r1" = "rc=0 raised=('$ES_RUN', '0.98.0')" ] && [ "$es_s1" = 0.98.0 ] && [ "$es_r2" = "rc=0 raised=None" ] \
  && [ "$es_r3" = "rc=0 raised=None" ] && [ "$es_s3" = "$ES_RUN" ] && [ -z "$(git -C "$ES" status --short)" ] \
  && ok "a newer engine's first next raises the stamp to its version and records (old, new) = ($ES_RUN, 0.98.0); its next command records nothing; a same-bytes rewrite alone raises nothing" \
  || bad "the raise is wrong -- [$es_r1 stamp $es_s1] [$es_r2] [$es_r3 stamp $es_s3 status $(git -C "$ES" status --short)]"
# (d) no stamp: the backlog's sikstack version line seeds old (release order), never refusing.
es_cbad=""
for es_case in "0.8.0:('0.8.0', '$ES_RUN')" "2.1.0:('2.1.0', '$ES_RUN')" "unknown:(None, '$ES_RUN')" "none:(None, '$ES_RUN')" "99.0.0:(None, '$ES_RUN')"; do
  es_line=${es_case%%:*}; es_want=${es_case#*:}
  newtmp ESN; mkhost "$ESN" >/dev/null 2>&1; ES="$ESN/.sikstack"
  git -C "$ES" rm -q works/engine.json
  if [ "$es_line" = none ]; then sed -i.bak '/^- sikstack version:/d' "$ES/works/backlog.md"
  else sed -i.bak "s/^- sikstack version: .*/- sikstack version: \`$es_line\`/" "$ES/works/backlog.md"; fi
  rm -f "$ES/works/backlog.md.bak"; git -C "$ES" add -A && git -C "$ES" commit -qm "line $es_line"
  es_r=$(es_drive "$PLUGIN/scripts" phase new --phase P1 --name x --objective y)
  [ "$es_r" = "rc=0 raised=$es_want" ] && [ "$(es_stamp "$ES")" = "$ES_RUN" ] || es_cbad="$es_cbad [$es_line: $es_r]"
done
es_order=$( cd "$ES" && python3 - "$PLUGIN/scripts" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import wf_store
print(all(wf_store.release_cmp("2.1.0", v) < 0 for v in ("0.3.0", "0.4.0", "0.5.0", "0.5.1", "0.6.0", "0.7.0", "0.8.0", "0.8.1")))
PY
)
[ -z "$es_cbad" ] && [ "$es_order" = True ] \
  && ok "with no stamp a backlog line of 0.8.0 or 2.1.0 seeds old, unknown, no line or an unlisted 99.0.0 give None, none refuses, the stamp is written; 2.1.0 reads older than every 0.x release from 0.3.0 up" \
  || bad "the pre-stamp fallback is wrong --$es_cbad (2.1.0 older than 0.3.0 up: $es_order)"
# (e) a worktree phase: the start commit carries the stamp, the gate counts it, merge-finish keeps the later release.
newtmp ESW; mkhost "$ESW" >/dev/null 2>&1; ES="$ESW/.sikstack"; printf '/.claude/\n' >> "$ESW/.git/info/exclude"
git -C "$ES" rm -q works/engine.json && git -C "$ES" commit -qm "an older workspace, no stamp"
( cd "$ES" && python3 "$ENG" phase new --phase P1 --name Side --objective o && python3 "$ENG" phase new --phase P2 --name Busy --objective o \
  && python3 "$ENG" slice status P2.DECOMP in_progress && rm works/engine.json && git add -A && git commit -qm phases ) >/dev/null 2>&1
es_ws=$( cd "$ESW" && python3 "$ENG" worktree start P1 --host-branch feat/side 2>&1 ); ESWT=$(printf '%s\n' "$es_ws" | sed -n 's/^host_worktree=//p'); ES_BR=$(printf '%s\n' "$es_ws" | sed -n 's/^branch=//p')
git -C "$ES" show --name-only --format= HEAD | grep -qx works/engine.json && [ -z "$(git -C "$ES" status --short)" ] \
  && ok "worktree start on a workspace with no stamp raises it and its stamp commit carries works/engine.json (the tree left clean)" \
  || bad "the start commit lacks the stamp -- $(git -C "$ES" show --name-only --format= HEAD | tr '\n' ' ') / $(git -C "$ES" status --short)"
( cd "$ESWT" && python3 "$ES98" slice status P1.DECOMP in_progress && git -C .sikstack add -A && git -C .sikstack commit -qm "P1 at 0.98.0" ) >/dev/null 2>&1
es_g=$( cd "$ESW" && python3 "$ENG" worktree gate P1 2>&1 | grep '^exemption=' )
git -C "$ES" diff --name-only main..."$ES_BR" | grep -qx works/engine.json && printf '%s\n' "$es_g" | grep -q '^exemption=phase-folder-only (' \
  && ok "a branch changing only its phase folder, the generated files and works/engine.json reads exemption=phase-folder-only" || bad "the gate's exemption did not count the stamp: $es_g"
( cd "$ES" && python3 "$ES99" agenda-add --title "main work" --author person:smoke && git add -A && git commit -qm "main at 0.99.0" ) >/dev/null 2>&1
git -C "$ES" merge -q --no-ff -m "merge P1" "$ES_BR" >/dev/null 2>&1
git -C "$ES" checkout -q --theirs -- works/engine.json
for es_f in $(git -C "$ES" diff --name-only --diff-filter=U | grep -v '^works/engine.json$'); do git -C "$ES" checkout -q --ours -- "$es_f"; done
git -C "$ES" add -A && git -C "$ES" commit -qm "merge P1 (the branch's stamp taken)"
es_m0=$(es_stamp "$ES"); es_mf98=$( cd "$ESW" && python3 "$ES98" worktree merge-finish 2>&1 ); es_mrc98=$?; es_m1=$(es_stamp "$ES")
es_mf99=$( cd "$ESW" && python3 "$ES99" worktree merge-finish 2>&1 ); es_mrc99=$?; es_m2=$(es_stamp "$ES")
[ "$es_m0" = 0.98.0 ] && [ "$es_mrc98" = 1 ] && printf '%s\n' "$es_mf98" | grep -q '^sikstack 0.98.0 is older than sikstack 0.99.0, which last wrote this workspace (.sikstack/works/engine.json, on one side of the merge)' \
  && [ "$es_m1" = 0.98.0 ] && [ "$es_mrc99" = 0 ] && [ "$es_m2" = 0.99.0 ] \
  && ok "two sides raised differently (0.98.0 taken over 0.99.0): merge-finish by 0.98.0 refuses naming 0.99.0, and by 0.99.0 leaves 0.99.0" \
  || bad "merge-finish did not keep the later release -- taken $es_m0; 0.98.0 rc=$es_mrc98 ($es_mf98) -> $es_m1; 0.99.0 rc=$es_mrc99 -> $es_m2"
# (f) cloud mode: in a stale process the refusal comes before any of the command's effects. unlink --from-disk, offline,
# refuses in one line with .hi2vi/ and the [cloud] table as they were (and runs after the rollback edit); against the
# fake, a linked next whose pull brings a later stamp leaves a pending web add pending (never refused) and sends
# nothing, and a current engine's next then applies it.
newtmp ESC; mkhost "$ESC" >/dev/null 2>&1; ES="$ESC/.sikstack"
set_link "$ES" "http://127.0.0.1:9"; mkdir -p "$ES/.hi2vi"; printf '{"head": 3, "files": {}}\n' > "$ES/.hi2vi/base.json"
git -C "$ES" add -A && git -C "$ES" commit -qm "linked, offline"; es_set "$ES" 0.99.0
es_u=$( cd "$ES" && python3 "$ENG" unlink --from-disk 2>&1 ); es_urc=$?
es_kept=no; [ -f "$ES/.hi2vi/base.json" ] && grep -q '^\[cloud\]' "$ES/config.toml" && es_kept=yes
es_set "$ES" "$ES_RUN"
es_u2=$( cd "$ES" && python3 "$ENG" unlink --from-disk 2>&1 ); es_u2rc=$?
( cd "$ES" && python3 "$ENG" next >/dev/null 2>&1 ); es_n3rc=$?
[ "$es_urc" = 1 ] && [ "$(printf '%s\n' "$es_u" | grep -c .)" = 1 ] && printf '%s\n' "$es_u" | grep -q "^sikstack $ES_RUN is older than sikstack 0.99.0, " \
  && [ "$es_kept" = yes ] && [ "$es_u2rc" = 0 ] && ! grep -q '^\[cloud\]' "$ES/config.toml" && [ "$es_n3rc" = 0 ] \
  && ok "unlink --from-disk offline against a stamp of 0.99.0 refuses in one line with .hi2vi/ and the [cloud] table untouched; after the rollback edit it runs and next exits 0" \
  || bad "a stale unlink --from-disk landed halfway -- rc=$es_urc ($es_u) kept=$es_kept; after the rollback rc=$es_u2rc ($es_u2), next rc=$es_n3rc"
newtmp ESF; mkhost "$ESF/a" >/dev/null 2>&1; ES="$ESF/a/.sikstack"
printf 'stamp-smoke-key\n' > "$ESF/key"; chmod 600 "$ESF/key"
python3 "$PLUGIN/tests/fake_sikstack.py" --dir "$ESF/fake" --port-file "$ESF/port" --key-file "$ESF/key" \
  --project proj-1 --org org-1 --lifetime 300 > "$ESF/fake.txt" 2>&1 &
ES_PID=$!
for _ in $(seq 1 100); do [ -s "$ESF/port" ] && break; sleep 0.1; done
ESS="http://127.0.0.1:$(cat "$ESF/port" 2>/dev/null)"
# es_fake <method> <path> [json]: a test-only request to the fake; prints the answer's JSON.
es_fake() { python3 - "$ESS" "$@" <<'PY'
import http.client, sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
conn = http.client.HTTPConnection(u.hostname, u.port, timeout=10)
conn.request(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else None, {"Content-Type": "application/json"})
print(conn.getresponse().read().decode())
PY
}
es_state() { es_fake GET /_fake/inbox | python3 -c 'import json, sys; print({e["id"]: e["state"] for e in json.load(sys.stdin)["entries"]}.get(sys.argv[1]))' "$1"; }
printf 'stamp-smoke-key\n' | ( cd "$ES" && XDG_CONFIG_HOME="$ESF/xdg" python3 "$ENG" link "$ESS/projects/proj-1" ) > "$ESF/link.txt" 2>&1
es_fake POST /_fake/write '{"path": "works/engine.json", "content": "{\n  \"version\": \"0.99.0\"\n}\n"}' >/dev/null
es_id=$(es_fake POST /_fake/inbox '{"kind": "add", "minted_id": "A3-x2", "items": ["A3-x2"], "fields": {"title": "from the web"}}' | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')
es_m=$(grep -c '' "$ESF/fake/requests.jsonl")
( cd "$ES" && XDG_CONFIG_HOME="$ESF/xdg" python3 "$ENG" next ) > "$ESF/n1.txt" 2>&1; es_n1rc=$?
es_s1=$(es_state "$es_id"); es_c1=$(tail -n +"$((es_m + 1))" "$ESF/fake/requests.jsonl" | grep -c '/commit"')
( cd "$ES" && XDG_CONFIG_HOME="$ESF/xdg" python3 "$ES99" next ) > "$ESF/n2.txt" 2>&1; es_n2rc=$?
es_s2=$(es_state "$es_id")
kill "$ES_PID" 2>/dev/null; wait "$ES_PID" 2>/dev/null
[ "$es_n1rc" = 0 ] && [ "$es_s1" = pending ] && [ "$es_c1" = 0 ] && [ "$(es_stamp "$ES")" = 0.99.0 ] && grep -q "^warning: sikstack $ES_RUN is older than sikstack 0.99.0" "$ESF/n1.txt" \
  && [ "$es_n2rc" = 0 ] && [ "$es_s2" = applied ] && [ -f "$ES/works/agenda/A3-x2/agenda.json" ] \
  && ok "linked, the pull brings a stamp of 0.99.0: next exits 0 with the warning, sends no commit and leaves the web's pending add pending; a 0.99.0 engine's next then applies it" \
  || bad "a stale linked next answered the inbox -- rc=$es_n1rc state=$es_s1 commits=$es_c1 stamp=$(es_stamp "$ES") ($(tail -2 "$ESF/n1.txt" | tr '\n' ' ')); current rc=$es_n2rc state=$es_s2 ($(tail -2 "$ESF/n2.txt" | tr '\n' ' '))"

# ---------------------------------------------------------------------------
echo "== Test 41: the Migration notes after an update -- against a stamp of 0.8.0 the session-start hook prints, after the card, one block of the notes of each release after 0.8.0 (newest first, within HOOK_CAP); an equal stamp leaves the card byte-identical; a later stamp gets the update line; on compact the block shows once, before the resume card, and fit() keeps card and notes whole; the first command that raises the stamp prints the same block on stderr once (a --json stdout stays valid), the next none =="
mn_hook() { printf '{"source":"%s","cwd":"%s"}' "$2" "$1" | env -u CLAUDE_PROJECT_DIR -u CLAUDE_PLUGIN_DATA python3 "$PLUGIN/hooks/session_start.py"; }
mn_set() { printf '{\n  "version": "%s"\n}\n' "$2" > "$1/.sikstack/works/engine.json" && git -C "$1/.sikstack" add -A && git -C "$1/.sikstack" commit -qm "stamp $2"; }
mn_card=$(python3 -c 'import sys; print(open(sys.argv[1]).read().rstrip("\n") + "\n\nThis repo has a sikstack workspace: start or continue with `/sikstack:sik-mode` (it reads `sikstack next`).")' "$PLUGIN/contract.md")
newtmp MNH; mkhost "$MNH" >/dev/null 2>&1
mn_eq=$(mn_hook "$MNH" startup; echo x); mn_eq=${mn_eq%x}
[ "$mn_eq" = "$mn_card"$'\n' ] && ok "a stamp equal to the running version ($ES_RUN): the hook's output is the card alone, byte for byte" \
  || bad "an equal stamp changed the hook's output: $(printf '%s' "$mn_eq" | tail -3)"
mn_set "$MNH" 0.8.0 >/dev/null 2>&1
mn_out=$(mn_hook "$MNH" startup; echo x); mn_out=${mn_out%x}
mn_check() { python3 - "$1" "$2" "$ES_RUN" "$3" <<'PY'
import sys
text, card, running, want_resume = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "resume"
head = f"sikstack updated from 0.8.0 to {running} in this workspace: the Migration notes below may need manual steps. Tell the operator, and run a step only on their word.\n"
assert text.startswith(card + "\n\n" + head), text[len(card):len(card) + 300]
block = text[len(card) + 2:].split("\ncompaction=done", 1)[0] if want_resume else text[len(card) + 2:]
items = [line for line in block.splitlines()[1:] if line.startswith("- ")]
assert items and items[0].startswith(f"- {running}: ") and any(i.startswith("- 0.9.0: ") for i in items), items
assert not any(i.startswith(("- 0.8.0: ", "- 0.7.0: ")) for i in items), items
assert text.count("sikstack updated from") == 1 and len(text) <= 10000, len(text)
if want_resume:
    assert "\ncompaction=done source=compact\n" in text and text.index("compaction=done") > text.index(head)
PY
}
mn_check "$mn_out" "$mn_card" startup && ok "a stamp of 0.8.0: after the card, one block naming both versions lists the notes of the releases after 0.8.0 up to $ES_RUN, newest first, within HOOK_CAP" \
  || bad "the startup notes block is wrong: $(printf '%s' "$mn_out" | tail -5)"
mn_cmp=$(mn_hook "$MNH" compact; echo x); mn_cmp=${mn_cmp%x}
mn_fit=$(python3 - "$PLUGIN" "$MNH/.sikstack" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1] + "/hooks")
import session_start as ss
state = Path(sys.argv[2]); head = ss.card(state) + "\n" + ss.notes(state)
out = ss.fit(head, "".join(f"line {i} " + "x" * 90 + "\n" for i in range(200)))
print(len(out) <= ss.HOOK_CAP and out.startswith(head) and "sikstack updated from 0.8.0" in head and out.rstrip("\n").endswith(ss.CUT_LINE))
PY
)
mn_check "$mn_cmp" "$mn_card" resume && [ "$mn_fit" = True ] \
  && ok "on compact the block shows once, after the card and before the resume card, within HOOK_CAP; an oversized resume card is cut by fit() with the card and the notes whole" \
  || bad "the compact notes are wrong (fit: $mn_fit): $(printf '%s' "$mn_cmp" | grep -n 'updated from\|compaction=done')"
mn_set "$MNH" 99.0.0 >/dev/null 2>&1
mn_new=$(mn_hook "$MNH" startup; echo x); mn_new=${mn_new%x}
[ "$mn_new" = "$mn_card"$'\n'$'\n'"this workspace was last written by sikstack 99.0.0, newer than this install's $ES_RUN: update the plugin (\`claude plugin update sikstack@sikstack\`), then restart Claude Code"$'\n' ] \
  && ok "a stamp of a later release: one line after the card, update the plugin, then restart Claude Code" || bad "the newer-stamp line is wrong: $(printf '%s' "$mn_new" | tail -2)"
# the first command that raises the stamp: the same block on stderr, once; the next prints none.
mn_set "$MNH" 0.8.0 >/dev/null 2>&1
mn_w1=$( cd "$MNH" && python3 "$ENG" phase new --phase P1 --name probe --objective o 2>"$MNH/err1.txt" ); mn_rc1=$?
mn_w2=$( cd "$MNH" && python3 "$ENG" slice status P1.DECOMP in_progress 2>"$MNH/err2.txt" ); mn_rc2=$?
mn_blk=$(printf '%s' "$mn_out" | python3 -c 'import sys; t = sys.stdin.read(); print(t[t.index("sikstack updated from"):], end="")')
case "$mn_blk" in "sikstack updated from 0.8.0 to $ES_RUN in this workspace"*) ;; *) mn_blk="(no block: $mn_blk)" ;; esac
[ "$mn_rc1" = 0 ] && [ "$mn_rc2" = 0 ] && printf '%s\n' "$mn_w1" | grep -q '^created phase P1' && [ "$(cat "$MNH/err1.txt")" = "$mn_blk" ] \
  && [ ! -s "$MNH/err2.txt" ] && [ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MNH/.sikstack/works/engine.json")" = "$ES_RUN" ] \
  && ok "the first command that raises the stamp prints the hook's block on stderr once, after its own output; the stamp is $ES_RUN and the next command prints none" \
  || bad "the first write's notes are wrong (rc $mn_rc1/$mn_rc2) -- [$(cat "$MNH/err1.txt")] [$(cat "$MNH/err2.txt")]"
{ git -C "$MNH/.sikstack" add -A && git -C "$MNH/.sikstack" commit -qm work && mn_set "$MNH" 0.8.0; } >/dev/null 2>&1
( cd "$MNH" && python3 - "$PLUGIN/scripts" >"$MNH/j_out.txt" 2>"$MNH/j_err.txt" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import workflow, wf_store
wf_store.engine_verdict()
wf_store.engine_mutation(wf_store.ROOT / "works" / "x")  # a write inside the boundary (a linked checkout's pull) raises it
tokens = ["agenda", "--json"]
args = workflow.build_parser().parse_args(tokens)
sys.exit(workflow.with_offer(lambda: workflow.run(args, tokens), tokens))
PY
)
python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$MNH/j_out.txt" 2>/dev/null && [ "$(cat "$MNH/j_err.txt")" = "$mn_blk" ] \
  && ok "agenda --json in the process that raised: stdout is valid JSON, the block went to stderr" || bad "agenda --json after a raise: [$(head -c 300 "$MNH/j_out.txt")] [$(cat "$MNH/j_err.txt")]"

# ---------------------------------------------------------------------------
echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL SIKSTACK SMOKE TESTS PASSED"
  exit 0
else
  echo "$FAILS CHECK(S) FAILED"
  exit 1
fi
