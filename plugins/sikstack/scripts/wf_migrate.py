"""`sikstack migrate`: move an old agentic-workspace install (bootstrap_agentic_workspace.sh, v102, its last release) into
`.sikstack/`. It runs before the finder (which refuses an old install), so it imports no other engine module; it runs
the engine as a child process once the state has moved.

    sikstack migrate            the plan, printed; nothing is written (a dry run)
    sikstack migrate --apply    the move

Refused, nothing written: uncommitted tracked changes in the old state repo (untracked files are fine: they move with
the folder); an install older than v102 (`works/.workspace-version.json`: run that installer's `--update` first); a
target that already has `.sikstack/`; a state repo with other worktrees (a phase on its own worktree) or a cloud command
left interrupted.

A nested install (`<host>/workflow/`, its own git repo; a single- or multi-repo host):
- `workflow/` becomes `.sikstack/` by a rename, so its history, its untracked files and the operator's own files inside
  go with it;
- then one commit there: the engine's own copies leave (scripts/, adapters/, CLAUDE.workspace.md, the version file,
  and each works/templates/ file v102 shipped unedited), executors.toml becomes config.toml's route rows, an old
  `.hi2vi/link.json` becomes config.toml's [cloud] link, and the generated files are rebuilt by the plugin's engine
  (works/backlog.md, the old engine's view, is rewritten in place, and works/agenda.md is new). The marker (with the
  repo registry) and every phase record stay byte for byte; only each active phase.md's generated `## Slices` header
  line, which names the engine command, is rewritten by that rebuild;
- the host's files: the `.git/info/exclude` block (`/workflow/` -> `/.sikstack/`, the installed skill and agent lines
  dropped once their files are gone), the `CLAUDE.local.md` block (the contract import and the `workflow/` command
  paths, for the plugin), the old installer's skill and agent copies under `.claude/` removed only where each still
  matches what v102 shipped (an edited one is kept and listed), and the old compact-resume hook in
  `.claude/settings.local.json`, which runs a file this move deletes. Text outside the installer's markers is never
  changed.
An at-root install (the state tracked in the product repo): `.sikstack/` gets a fresh git repo seeded from the state,
with one import commit naming the source commit; the at-root files stay, and the `git rm` the user can run is printed.
Nothing is committed in the product repo.
After --apply, `sikstack next` and `sikstack check` run on the moved state, and the command prints what it moved, what
it kept and what is left for the user."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
ENGINE = PLUGIN_ROOT / "scripts" / "workflow.py"
MANIFEST = json.loads((Path(__file__).resolve().parent / "migrate_v102.json").read_text(encoding="utf-8"))
LAST_RELEASE = MANIFEST["version"]
OLD_DIR, STATE_DIR, MARKER = "workflow", ".sikstack", ".agentic-nested.json"
VERSION_FILE = "works/.workspace-version.json"
UPSTREAM = "https://github.com/leetusik/bootstrap_agentic_workspace.sh"
LOCAL_BEGIN, LOCAL_END = "<!-- BEGIN agentic-workspace (nested) -->", "<!-- END agentic-workspace (nested) -->"
EXCLUDE_BEGIN, EXCLUDE_END = "# BEGIN agentic-workspace (nested)", "# END agentic-workspace (nested)"
OLD_HOOK = 'cd "$CLAUDE_PROJECT_DIR" && python3 workflow/adapters/claude_code/adapter.py compact-resume || true'
ROUTE_ROWS = ("high", "research", "design", "critic", "judge", "reader", "code", "mid", "explore")
ALIASES = ("opus", "sonnet", "haiku", "fable")
EFFORTS = ("low", "medium", "high", "xhigh", "max", "")
ROOT_DOCS = ("docs/current", "docs/versions", "docs/reference", "docs/index.json")
COMMIT_MSG = "chore(sikstack): move the workspace into .sikstack/ for the sikstack plugin"


def _mgit(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    # --no-optional-locks: a dry run's `git status` must not refresh (write) the index
    return subprocess.run(["git", "--no-optional-locks", *args], cwd=str(cwd), capture_output=True, text=True)


def _file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rel(path: Path, base: Path) -> str:
    return os.path.relpath(path, base)


# ---- finding the install -------------------------------------------------------------------------------------------

def find_install(cwd: Path):
    """("nested", host, <host>/workflow) for the nearest host above `cwd` holding `workflow/.agentic-nested.json`, or
    ("root", repo, repo) for an at-root install at the git work tree root holding `cwd`, or None."""
    for d in (cwd, *cwd.parents):
        if (d / OLD_DIR / MARKER).is_file():
            return "nested", d, d / OLD_DIR
    top = _mgit(cwd, "rev-parse", "--show-toplevel")
    if top.returncode == 0 and top.stdout.strip():
        t = Path(top.stdout.strip()).resolve()
        works = (t / "works/state.json").exists() or any((t / "works/phases/active").glob("*/phase.json"))
        if (t / "scripts/workflow.py").exists() and works:
            return "root", t, t
    return None


def install_version(state: Path):
    try:
        version = json.loads((state / VERSION_FILE).read_text(encoding="utf-8")).get("workspace_version")
    except (OSError, ValueError, AttributeError):
        return None
    return version if isinstance(version, int) and not isinstance(version, bool) else None


def refusals(layout: str, host: Path, state: Path) -> list:
    out = []
    target = host / STATE_DIR
    if target.exists():
        out.append(f"{target} already exists: this folder is a sikstack workspace already (remove or move it first if it "
                   "is a stray one)")
    version = install_version(state)
    if version is None or version < LAST_RELEASE:
        seen = f"v{version}" if version is not None else f"of no known version (no {VERSION_FILE})"
        out.append(f"this install is {seen}, and migrate reads only the last bootstrap release, v{LAST_RELEASE}: update "
                   f"it first with that installer's --update (from {host}: sh bootstrap_agentic_workspace.sh . --update, "
                   f"the installer from {UPSTREAM}), then run sikstack migrate again")
    if layout == "nested":
        dirty = _mgit(state, "status", "--porcelain", "--untracked-files=no")
        lines = [l for l in dirty.stdout.splitlines() if l.strip()]
        if dirty.returncode != 0:
            out.append(f"{state} is not a git repo git can read ({(dirty.stderr or '').strip()[:120]})")
        elif lines:
            out.append(f"the old state repo {OLD_DIR}/ has uncommitted tracked changes ({len(lines)} path(s), first "
                       f"{lines[0][3:]}): commit them first (git -C {OLD_DIR} add -A && git -C {OLD_DIR} commit); "
                       "untracked files are fine, they move with the folder")
        worktrees = [l for l in _mgit(state, "worktree", "list", "--porcelain").stdout.splitlines() if l.startswith("worktree ")]
        if len(worktrees) > 1:
            out.append(f"the old state repo has {len(worktrees) - 1} other worktree(s) ({worktrees[1][9:]}): a phase "
                       "runs on its own worktree; merge and tear it down first (a move would orphan it)")
        if (state / ".hi2vi" / "journal.json").exists():
            out.append(f"a cloud command was left interrupted ({OLD_DIR}/.hi2vi/journal.json): run "
                       f"python3 {OLD_DIR}/scripts/workflow.py sync first")
    else:
        dirty = _mgit(host, "status", "--porcelain", "--untracked-files=no", "--", "works", "docs", "executors.toml")
        lines = [l for l in dirty.stdout.splitlines() if l.strip()]
        if lines:
            out.append(f"the repo has uncommitted tracked changes in the workspace's files ({len(lines)} path(s), first "
                       f"{lines[0][3:]}): commit them first, so the import names the commit it read")
    return out


# ---- the plan --------------------------------------------------------------------------------------------------------

def convert_routes(text: str) -> tuple:
    """(rows, problems): executors.toml's [claude.<row>] overrides as [(row, key, value)], and each line that cannot
    become a config.toml route row (a retired row, a full model id, a v52 mode line), one string each."""
    rows, problems, section = [], [], None
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip() if not raw.strip().startswith('"') else raw.strip()
        if not line:
            continue
        m = re.fullmatch(r"\[\s*claude\s*\.\s*([^\]\s]+)\s*\]", line)
        if m:
            section = m.group(1)
            if section not in ROUTE_ROWS:
                problems.append(f"line {n}: [claude.{section}] is not a route row any more (retired), dropped")
                section = "-"
            continue
        if line.startswith("["):
            problems.append(f"line {n}: {line} is not a route table, dropped")
            section = "-"
            continue
        m = re.fullmatch(r'(model|effort)\s*=\s*"([^"]*)"', line)
        if m and section and section != "-":
            key, value = m.groups()
            if key == "model" and value not in ALIASES:
                problems.append(f"line {n}: [claude.{section}] model {value!r} is not an Agent-tool alias "
                                f"({', '.join(ALIASES)}), dropped")
            elif key == "effort" and value not in EFFORTS:
                problems.append(f"line {n}: [claude.{section}] effort {value!r} is not a level, dropped")
            else:
                rows.append((section, key, value))
            continue
        if section != "-":
            problems.append(f"line {n}: {line!r} cannot be read as a route row, dropped")
    return rows, problems


def config_text(rows: list, link) -> str:
    text = (PLUGIN_ROOT / "templates" / "config.toml").read_text(encoding="utf-8")
    if rows:
        text = text.rstrip("\n") + "\n\n# Moved from executors.toml by sikstack migrate.\n"
        last = None
        for row, key, value in rows:
            if row != last:
                text += f"[claude.{row}]\n"
                last = row
            text += f'{key} = "{value}"\n'
    if link:
        text = text.rstrip("\n") + "\n\n[cloud]\n# This checkout's link (sikstack link and unlink write it; it holds no key).\n"
        for key in ("schema", "server", "org_id", "project_id", "linked_at", "checkout"):
            value = link.get(key)
            if value is None:
                continue
            text += f"{key} = {value}\n" if isinstance(value, int) and not isinstance(value, bool) else \
                f"{key} = {json.dumps(value if isinstance(value, str) else str(value))}\n"
    return text


def _skill_matches(folder: Path, shipped: dict) -> bool:
    if folder.is_symlink() or not folder.is_dir():
        return False
    found = {}
    for p in folder.rglob("*"):
        if p.is_symlink():
            return False
        if p.is_file():
            found[p.relative_to(folder).as_posix()] = _file_sha(p)
    return found == shipped


def host_copies(host: Path, marker: dict) -> tuple:
    """(remove, keep): the host's .claude/ skill folders and agent files of the old installer, as host-relative paths;
    removed only when a copy matches what v102 shipped, byte for byte."""
    installed = marker.get("installed") if isinstance(marker.get("installed"), dict) else {}
    renames = marker.get("renames") if isinstance(marker.get("renames"), dict) else {}
    remove, keep = [], []
    skills = set(MANIFEST["skills"]) | {s for s in installed.get("skills") or [] if isinstance(s, str)}
    for name in sorted(skills):
        shown = (renames.get("skills") or {}).get(name, name) if name in MANIFEST["skills"] else name
        folder = host / ".claude" / "skills" / shown
        if not os.path.lexists(folder):
            continue
        rel = f".claude/skills/{shown}/"
        if name in MANIFEST["skills"] and _skill_matches(folder, MANIFEST["skills"][name]):
            remove.append(rel)
        elif folder.is_symlink():
            continue  # a link of the operator's own, never the installer's
        else:
            why = "edited since v102 shipped it" if name in MANIFEST["skills"] else "not one v102 shipped (an older release's)"
            keep.append((rel, why))
    agents = set(MANIFEST["agents"]) | {a for a in installed.get("agents") or [] if isinstance(a, str)}
    for name in sorted(agents):
        shown = (renames.get("agents") or {}).get(name, name) if name in MANIFEST["agents"] else name
        path = host / ".claude" / "agents" / f"{shown}.md"
        if not os.path.lexists(path) or path.is_symlink():
            continue
        rel = f".claude/agents/{shown}.md"
        if name in MANIFEST["agents"] and path.is_file() and _file_sha(path) == MANIFEST["agents"][name]:
            remove.append(rel)
        else:
            keep.append((rel, "edited since v102 shipped it" if name in MANIFEST["agents"] else "not one v102 shipped"))
    return remove, keep


def exclude_file(host: Path):
    common = _mgit(host, "rev-parse", "--git-common-dir")
    if common.returncode != 0 or not common.stdout.strip():
        return None
    return (host / common.stdout.strip()).resolve() / "info" / "exclude"


def rewrite_exclude(text: str, gone: set, host: Path) -> tuple:
    """(new text, changes): the installer's block rewritten -- /workflow/ -> /.sikstack/, and a skill or agent line
    dropped when its path is in `gone` (this move removes it) or not there at all; every line outside the markers kept.
    No block: one /.sikstack/ line added at the end (unless the file has one)."""
    lines = text.split("\n")
    try:
        begin, end = lines.index(EXCLUDE_BEGIN), lines.index(EXCLUDE_END)
    except ValueError:
        begin = end = None
    if begin is None or end < begin:
        if any(l.strip() in ("/.sikstack/", ".sikstack/", "/.sikstack", ".sikstack") for l in lines):
            return text, []
        sep = "" if not text or text.endswith("\n") else "\n"
        return text + sep + "/.sikstack/\n", ["add /.sikstack/"]
    block, changes = [], []
    for line in lines[begin + 1:end]:
        bare = line.strip()
        if bare == f"/{OLD_DIR}/":
            block.append("/.sikstack/")
            changes.append(f"/{OLD_DIR}/ -> /.sikstack/")
            continue
        m = re.fullmatch(r"/(\.claude/(?:skills/[^/]+/|agents/[^/]+\.md))", bare)
        if m and (m.group(1) in gone or not os.path.lexists(host / m.group(1).rstrip("/"))):
            changes.append(f"drop {bare}")
            continue
        block.append(line)
    if "/.sikstack/" not in [b.strip() for b in block]:
        block.insert(0, "/.sikstack/")
        changes.append("add /.sikstack/")
    return "\n".join(lines[:begin + 1] + block + lines[end:]), changes


def _local_line(line: str) -> str:
    if line.strip() == f"@{OLD_DIR}/CLAUDE.workspace.md":
        return ("The contract is the sikstack plugin's rules card, which its session-start hook prints; "
                "`/sikstack:sik-mode` is the entry.")
    line = line.replace(f"python3 {OLD_DIR}/scripts/workflow.py", "sikstack")
    line = line.replace(f"python3 {OLD_DIR}/adapters/claude_code/adapter.py", "sikstack-adapter")
    line = line.replace(f"git -C {OLD_DIR} ", f"git -C {STATE_DIR} ")
    line = line.replace("install of the agentic workspace", "install of the sikstack workspace")
    return re.sub(r"(?<![\w./-])" + OLD_DIR + r"/", STATE_DIR + "/", line)


def rewrite_local(text: str) -> tuple:
    """(new text, changed line count): only the lines between the installer's markers change."""
    lines = text.split("\n")
    try:
        begin, end = lines.index(LOCAL_BEGIN), lines.index(LOCAL_END)
    except ValueError:
        return text, None
    if end < begin:
        return text, None
    new = [_local_line(l) for l in lines[begin + 1:end]]
    changed = sum(1 for a, b in zip(lines[begin + 1:end], new) if a != b)
    return "\n".join(lines[:begin + 1] + new + lines[end:]), changed


def settings_without_hook(path: Path):
    """The settings text with the old installer's compact-resume hook removed, or None when there is none, or a string
    reason (str starting "keep:") when it is there but the file is not in the installer's own JSON form."""
    try:
        text = path.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, ValueError):
        return None
    entries = data.get("hooks", {}).get("SessionStart") if isinstance(data, dict) and isinstance(data.get("hooks"), dict) else None
    if not isinstance(entries, list) or not any(isinstance(h, dict) and h.get("command") == OLD_HOOK for e in entries
                                                 if isinstance(e, dict) and isinstance(e.get("hooks"), list) for h in e["hooks"]):
        return None
    if json.dumps(data, indent=2) + "\n" != text and json.dumps(data, indent=2, ensure_ascii=False) + "\n" != text:
        return "keep: the file is not in the installer's JSON layout, so it is left as is"
    hooks = data["hooks"]
    kept = []
    for entry in entries:
        if isinstance(entry, dict) and isinstance(entry.get("hooks"), list):
            inner = [h for h in entry["hooks"] if not (isinstance(h, dict) and h.get("command") == OLD_HOOK)]
            if not inner:
                continue
            entry = {**entry, "hooks": inner}
        kept.append(entry)
    if kept:
        hooks["SessionStart"] = kept
    else:
        del hooks["SessionStart"]
    if not hooks:
        del data["hooks"]
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def old_links(host: Path, old: Path) -> list:
    """Symlinks under the host's .claude/ that point into the old folder: the user re-points them."""
    out = []
    base = host / ".claude"
    if not base.is_dir():
        return out
    for d, dirs, files in os.walk(str(base)):
        for name in dirs + files:
            p = Path(d) / name
            if p.is_symlink():
                target = os.readlink(str(p))
                full = (p.parent / target).resolve() if not os.path.isabs(target) else Path(target).resolve()
                try:
                    full.relative_to(old.resolve())
                except ValueError:
                    continue
                new = re.sub(r"(^|/)" + OLD_DIR + r"(/|$)", r"\1" + STATE_DIR + r"\2", target, count=1)
                out.append((_rel(p, host), target, new))
    return out


def nested_plan(host: Path, old: Path) -> dict:
    marker = json.loads((old / MARKER).read_text(encoding="utf-8"))
    plan = {"layout": "nested", "host": host, "old": old, "marker": marker}
    plan["multi"] = bool(marker.get("repos"))
    plan["commits"] = int((_mgit(old, "rev-list", "--count", "HEAD").stdout or "0").strip() or 0)
    engine = [f for f in MANIFEST["engine_files"] + [MANIFEST["contract"], VERSION_FILE] if (old / f).exists()]
    plan["engine_rm"] = engine
    shipped = MANIFEST["templates"]
    tmpl = old / "works" / "templates"
    plan["tmpl_rm"], plan["tmpl_keep"] = [], []
    if tmpl.is_dir():
        for p in sorted(tmpl.iterdir()):
            if p.is_file() and shipped.get(p.name) == _file_sha(p):
                plan["tmpl_rm"].append(f"works/templates/{p.name}")
            elif p.is_file():
                plan["tmpl_keep"].append(f"works/templates/{p.name}")
    leftover = []
    for folder in ("scripts", "adapters"):
        if (old / folder).is_dir():
            for p in sorted((old / folder).rglob("*")):
                rel = p.relative_to(old).as_posix()
                if p.is_file() and rel not in engine and "__pycache__" not in p.parts:
                    leftover.append(rel)
    plan["engine_keep"] = leftover
    exe = old / "executors.toml"
    plan["routes"], plan["route_problems"] = convert_routes(exe.read_text(encoding="utf-8")) if exe.is_file() else ([], [])
    plan["config_exists"] = (old / "config.toml").exists()
    link_path = old / ".hi2vi" / "link.json"
    plan["link"] = None
    if link_path.is_file():
        try:
            plan["link"] = json.loads(link_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            plan["link"] = "unreadable"
    plan["remove"], plan["keep"] = host_copies(host, marker)
    ex = exclude_file(host)
    plan["exclude"] = ex
    if ex is not None:
        text = ex.read_text(encoding="utf-8") if ex.is_file() else ""
        plan["exclude_text"], plan["exclude_changes"] = rewrite_exclude(text, set(plan["remove"]), host)
    local = host / "CLAUDE.local.md"
    plan["local"] = None
    if local.is_file():
        new, changed = rewrite_local(local.read_text(encoding="utf-8"))
        plan["local"] = (new, changed)
    settings = host / ".claude" / "settings.local.json"
    plan["settings"] = settings_without_hook(settings) if settings.is_file() else None
    plan["allow_lines"] = []
    if settings.is_file():
        try:
            allow = json.loads(settings.read_text(encoding="utf-8")).get("permissions", {}).get("allow", [])
            plan["allow_lines"] = [a for a in allow if isinstance(a, str) and f"{OLD_DIR}/" in a]
        except (OSError, ValueError, AttributeError):
            pass
    plan["links"] = old_links(host, old)
    return plan


def root_plan(repo: Path) -> dict:
    plan = {"layout": "root", "host": repo, "old": repo}
    head = _mgit(repo, "rev-parse", "HEAD")
    plan["source"] = head.stdout.strip() if head.returncode == 0 else None
    shipped = MANIFEST["templates_at_root"]
    plan["tmpl_skip"], plan["tmpl_copy"] = [], []
    tmpl = repo / "works" / "templates"
    if tmpl.is_dir():
        for p in sorted(tmpl.iterdir()):
            if p.is_file():
                (plan["tmpl_skip"] if shipped.get(p.name) == _file_sha(p) else plan["tmpl_copy"]).append(p.name)
    plan["docs"] = [d for d in ROOT_DOCS if (repo / d).exists()]
    exe = repo / "executors.toml"
    plan["routes"], plan["route_problems"] = convert_routes(exe.read_text(encoding="utf-8")) if exe.is_file() else ([], [])
    tracked = set(_mgit(repo, "ls-files").stdout.splitlines())
    candidates = [*[f for f in MANIFEST["engine_files"]], "works", *ROOT_DOCS, "executors.toml", "docs/README.md",
                  ".github/workflows/workspace-ci.yml"]
    plan["git_rm"] = [c for c in candidates if c in tracked or any(t.startswith(c + "/") for t in tracked)]
    plan["by_hand"] = [p for p in ("CLAUDE.md", ".claude/skills", ".claude/agents", ".claude/settings.json")
                       if p in tracked or any(t.startswith(p + "/") for t in tracked)]
    plan["exclude"] = exclude_file(repo)
    return plan


# ---- printing and applying -----------------------------------------------------------------------------------------

def print_plan(plan: dict, version) -> None:
    host = plan["host"]
    if plan["layout"] == "nested":
        kind = "a nested multi-repo host" if plan["multi"] else "a nested install"
        print(f"sikstack migrate: {host} holds {kind} at v{version}")
        print("move:")
        print(f"- {OLD_DIR}/ -> {STATE_DIR}/, a rename: its git history ({plan['commits']} commits), its untracked files and "
              "your own files inside it go with it")
        print(f"in {STATE_DIR}/, one commit ({COMMIT_MSG}):")
        for f in plan["engine_rm"]:
            print(f"- remove {f} (the old engine's own copy)")
        for f in plan["tmpl_rm"]:
            print(f"- remove {f} (as v{LAST_RELEASE} shipped it: the plugin's template applies)")
        exe = plan["old"] / "executors.toml"
        if plan["config_exists"]:
            print("- keep config.toml as it is (it exists already); executors.toml stays for you to fold in")
        elif exe.is_file():
            print(f"- executors.toml -> config.toml: {len(plan['routes'])} route override(s) carried"
                  + (f", {len(plan['route_problems'])} line(s) not carried (executors.toml kept)" if plan["route_problems"] else ""))
        else:
            print("- write config.toml (every route row at its default)")
        if plan["link"] == "unreadable":
            print("- .hi2vi/link.json cannot be read: kept, not moved into config.toml")
        elif plan["link"]:
            print(f"- .hi2vi/link.json -> config.toml's [cloud] link ({plan['link'].get('server')} project "
                  f"{plan['link'].get('project_id')})")
        print("- rebuild the generated files with the plugin's engine (works/backlog.md, works/agenda.md, works/state.json, "
              "works/index.json, each active phase.md's generated ## Slices header); the marker, the repo registry and "
              "every phase record stay byte for byte")
        print("the host's files:")
        if plan["exclude"] is not None:
            print(f"- {_rel(plan['exclude'], host)}: " + ("; ".join(plan["exclude_changes"]) or "unchanged"))
        if plan["local"] is not None:
            new, changed = plan["local"]
            print("- CLAUDE.local.md: " + (f"{changed} line(s) of the installer's block rewritten for the plugin (the contract "
                                           "import, the workflow/ command paths); text outside the markers unchanged"
                                           if changed is not None else "no installer block found: unchanged"))
        for rel in plan["remove"]:
            print(f"- remove {rel} (as v{LAST_RELEASE} shipped it: the plugin carries it now)")
        if isinstance(plan["settings"], str) and not plan["settings"].startswith("keep:"):
            print("- .claude/settings.local.json: remove the old compact-resume hook (it runs "
                  f"{OLD_DIR}/adapters/claude_code/adapter.py, which this move deletes); nothing else there changes")
    else:
        print(f"sikstack migrate: {host} holds an at-root install at v{version}")
        print(f"in {STATE_DIR}/ (a new git repo), one import commit naming {plan['source'] or 'the source commit'}:")
        print("- copy works/ (less the old works/backlog.md, which the rebuild rewrites, and the version file" + (", and the unedited templates" if plan["tmpl_skip"] else "")
              + ")" + ("".join(f", {d}" for d in plan["docs"])))
        print(f"- write config.toml ({len(plan['routes'])} route override(s) from executors.toml), the marker and .gitattributes")
        print(f"- add /.sikstack/ to {_rel(plan['exclude'], host) if plan['exclude'] else '.git/info/exclude'}; nothing is "
              "committed in the repo and the at-root files stay where they are")


def print_kept(plan: dict) -> list:
    """The kept and left-for-you lines (printed in the dry run and after the move)."""
    kept, left = [], []
    if plan["layout"] == "nested":
        for f in plan["tmpl_keep"]:
            kept.append(f"{STATE_DIR}/{f} (" + ("edited since v{LAST_RELEASE} shipped it: it overrides the plugin's template of "
                                                "that name; delete it to follow the plugin's)".format(LAST_RELEASE=LAST_RELEASE)
                                                if f.rsplit("/", 1)[1] in MANIFEST["templates"] else
                                                f"not a template v{LAST_RELEASE} shipped: kept as it is)"))
        for f in plan["engine_keep"]:
            kept.append(f"{STATE_DIR}/{f} (in the engine's folder, but not one of its files)")
        for rel, why in plan["keep"]:
            kept.append(f"{rel} ({why}; delete it if the plugin's copy should load instead)")
        for p in plan["route_problems"]:
            left.append(f"executors.toml {p}: set it in {STATE_DIR}/config.toml by hand, then delete executors.toml")
        if isinstance(plan["settings"], str) and plan["settings"].startswith("keep:"):
            left.append(f".claude/settings.local.json still runs {OLD_DIR}/adapters/claude_code/adapter.py at compaction "
                        f"({plan['settings'][6:]}): remove that SessionStart hook; the plugin has its own")
        if plan["allow_lines"]:
            left.append(".claude/settings.local.json allows " + ", ".join(plan["allow_lines"])
                        + ": rules for the old paths, harmless; drop them when you like (the plugin's guard hook needs none)")
        for rel, target, new in plan["links"]:
            left.append(f"{rel} is a link into {OLD_DIR}/ ({target}): re-point it with ln -sfn {new} {rel}")
        if plan["local"] is not None and plan["local"][1] is None:
            left.append(f"CLAUDE.local.md has no installer block: point any {OLD_DIR}/ path in it at {STATE_DIR}/ yourself")
    else:
        for name in plan["tmpl_copy"]:
            kept.append(f"works/templates/{name} copied ({STATE_DIR}/works/templates/{name} overrides the plugin's template)")
        for p in plan["route_problems"]:
            left.append(f"executors.toml {p}: set it in {STATE_DIR}/config.toml by hand")
        if plan["git_rm"]:
            left.append("the at-root files are still tracked in the repo; when you are ready: git rm -r -q -- "
                        + " ".join(plan["git_rm"]) + " && git commit -m \"chore: move the workspace to sikstack\"")
        if plan["by_hand"]:
            left.append(", ".join(plan["by_hand"]) + ": the workspace's copies live in these; remove the workspace's own "
                        "parts by hand (the plugin carries its skills, agents and contract)")
    for line in kept:
        print(f"keep: {line}")
    for line in left:
        print(f"left for you: {line}")
    return left


def _write(path: Path, text: str) -> None:
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
    tmp = path.with_name(f".tmp_{path.name}")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def _engine(host: Path, state: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "SIKSTACK_ROOT": str(state)}
    env.pop("WORKFLOW_CMD", None)
    return subprocess.run([sys.executable, str(ENGINE), *args], cwd=str(host), capture_output=True, text=True, env=env)


def _exclude_hi2vi(state: Path) -> None:
    ex = exclude_file(state)
    if ex is None:
        return
    text = ex.read_text(encoding="utf-8") if ex.is_file() else ""
    if not ({"/.hi2vi/", ".hi2vi/", "/.hi2vi", ".hi2vi"} & {l.strip() for l in text.splitlines()}):
        ex.parent.mkdir(parents=True, exist_ok=True)
        ex.write_text(text + ("" if not text or text.endswith("\n") else "\n") + "/.hi2vi/\n", encoding="utf-8")


def apply_nested(plan: dict) -> bool:
    host, old = plan["host"], plan["old"]
    state = host / STATE_DIR
    os.rename(str(old), str(state))  # the move: same parent, one rename
    print(f"moved: {OLD_DIR}/ -> {STATE_DIR}/")
    rm = plan["engine_rm"] + plan["tmpl_rm"]
    tracked = set(_mgit(state, "ls-files").stdout.splitlines())
    if any(f in tracked for f in rm):
        _mgit(state, "rm", "-q", "--ignore-unmatch", "--", *[f for f in rm if f in tracked])
    for f in rm:
        if (state / f).exists():
            (state / f).unlink()
    for folder in ("scripts", "adapters"):
        for cache in sorted((state / folder).rglob("__pycache__"), reverse=True) if (state / folder).is_dir() else []:
            shutil.rmtree(str(cache), ignore_errors=True)
        for d in sorted([p for p in (state / folder).rglob("*") if p.is_dir()] + [state / folder], reverse=True) \
                if (state / folder).is_dir() else []:
            try:
                d.rmdir()
            except OSError:
                pass
    tmpl = state / "works" / "templates"
    if tmpl.is_dir() and not any(tmpl.iterdir()):
        tmpl.rmdir()
    exe = state / "executors.toml"
    link = plan["link"] if isinstance(plan["link"], dict) else None
    if not plan["config_exists"]:
        (state / "config.toml").write_text(config_text(plan["routes"], link), encoding="utf-8")
        if exe.is_file() and not plan["route_problems"]:
            if "executors.toml" in tracked:
                _mgit(state, "rm", "-q", "--", "executors.toml")
            else:
                exe.unlink()
        if link:
            (state / ".hi2vi" / "link.json").unlink()
    _exclude_hi2vi(state)
    # the host's files
    if plan["exclude"] is not None:
        _write(plan["exclude"], plan["exclude_text"]) if plan["exclude"].exists() else plan["exclude"].write_text(plan["exclude_text"], encoding="utf-8")
    if plan["local"] is not None and plan["local"][1]:
        _write(host / "CLAUDE.local.md", plan["local"][0])
    for rel in plan["remove"]:
        path = host / rel.rstrip("/")
        if rel.endswith("/"):
            shutil.rmtree(str(path))
        else:
            path.unlink()
    for folder in (host / ".claude" / "skills", host / ".claude" / "agents"):
        if plan["remove"] and folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
    if isinstance(plan["settings"], str) and not plan["settings"].startswith("keep:"):
        _write(host / ".claude" / "settings.local.json", plan["settings"])
    # the generated files, by the plugin's engine, into the same commit
    check = _engine(host, state, "check")
    _mgit(state, "add", "-u")
    for f in ("config.toml", "works/backlog.md", "works/agenda.md"):
        if (state / f).exists():
            _mgit(state, "add", "--", f)
    commit = _mgit(state, "commit", "-q", "-m", COMMIT_MSG)
    if commit.returncode == 0:
        print(f"committed in {STATE_DIR}/: {COMMIT_MSG}")
    else:
        print(f"note: no commit in {STATE_DIR}/ ({(commit.stderr or commit.stdout).strip().splitlines()[-1:] or ['git refused']}); "
              f"commit it yourself: git -C {STATE_DIR} commit -m \"{COMMIT_MSG}\"")
    if check.returncode != 0:
        sys.stdout.write(check.stdout + check.stderr)
    return check.returncode == 0


def apply_root(plan: dict) -> bool:
    repo = plan["host"]
    state = repo / STATE_DIR
    skip_tmpl = set(plan["tmpl_skip"])

    def ignore(folder, names):
        here = Path(folder)
        out = set()
        if here == repo / "works":
            out |= {n for n in names if n in (".workspace-version.json", "backlog.md")}
        if here == repo / "works" / "templates":
            out |= {n for n in names if n in skip_tmpl}
        return out

    state.mkdir()
    shutil.copytree(str(repo / "works"), str(state / "works"), ignore=ignore, symlinks=True)
    tmpl = state / "works" / "templates"
    if tmpl.is_dir() and not any(tmpl.iterdir()):
        tmpl.rmdir()
    for d in plan["docs"]:
        src, dst = repo / d, state / d
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(str(src), str(dst), symlinks=True) if src.is_dir() else shutil.copy2(str(src), str(dst))
    (state / "docs" / "current").mkdir(parents=True, exist_ok=True)
    for rel in ("works/phases/active", "works/phases/archived", "works/agenda"):
        (state / rel).mkdir(parents=True, exist_ok=True)
    (state / "config.toml").write_text(config_text(plan["routes"], None), encoding="utf-8")
    (state / ".gitattributes").write_text((PLUGIN_ROOT / "templates" / "gitattributes").read_text(encoding="utf-8"), encoding="utf-8")
    marker = {"schema": 1, "host_root": "..",
              "commit_convention": {"inferred": None, "confirmed": False, "text": None, "coauthor_trailers": "unknown"},
              "renames": {"skills": {}, "agents": {}}}
    (state / MARKER).write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    _mgit(state, "init", "-q")
    _exclude_hi2vi(state)
    ex = plan["exclude"]
    if ex is not None:
        text = ex.read_text(encoding="utf-8") if ex.is_file() else ""
        new, _ = rewrite_exclude(text, set(), repo)
        ex.parent.mkdir(parents=True, exist_ok=True)
        ex.write_text(new, encoding="utf-8")
    check = _engine(repo, state, "check")
    _mgit(state, "add", "-A")
    msg = f"chore(sikstack): import the workspace from {repo.name} at {(plan['source'] or 'its working tree')[:12]}"
    commit = _mgit(state, "commit", "-q", "-m", msg)
    print(f"made {STATE_DIR}/ from the at-root state" + (f"; committed: {msg}" if commit.returncode == 0 else
                                                         f"; no commit (git refused: commit it yourself: git -C {STATE_DIR} add -A && git -C {STATE_DIR} commit -m \"{msg}\")"))
    if check.returncode != 0:
        sys.stdout.write(check.stdout + check.stderr)
    return check.returncode == 0


def migrate_main(argv: list) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    extra = [a for a in argv if a != "--apply"]
    if extra:
        print(f"sikstack migrate: unknown argument(s) {' '.join(extra)} (takes only --apply) -- nothing was written", file=sys.stderr)
        return 2
    apply = "--apply" in argv
    cwd = Path.cwd().resolve()
    found = find_install(cwd)
    if found is None:
        print(f"sikstack migrate: no old workflow/ install found from {cwd} (a host holding workflow/.agentic-nested.json, "
              "or a repo with scripts/workflow.py and works/) -- nothing was written", file=sys.stderr)
        return 2
    layout, host, state = found
    refused = refusals(layout, host, state)
    if refused:
        for line in refused:
            print(f"sikstack migrate: refused -- {line}", file=sys.stderr)
        print("nothing was written", file=sys.stderr)
        return 1
    version = install_version(state)
    plan = nested_plan(host, state) if layout == "nested" else root_plan(host)
    print_plan(plan, version)
    if not apply:
        print_kept(plan)
        print("then: sikstack next and sikstack check run on the moved state")
        print("dry run: nothing was written; run `sikstack migrate --apply` to make the move")
        return 0
    ok = apply_nested(plan) if layout == "nested" else apply_root(plan)
    new_state = host / STATE_DIR
    left = print_kept(plan)
    nxt = _engine(host, new_state, "next")
    chk = _engine(host, new_state, "check", "--no-rebuild")
    print("sikstack next:")
    sys.stdout.write("".join(f"  {l}\n" for l in (nxt.stdout + nxt.stderr).splitlines()))
    print(f"sikstack check --no-rebuild: {'passed' if chk.returncode == 0 else 'FAILED'}")
    if chk.returncode != 0:
        sys.stdout.write("".join(f"  {l}\n" for l in (chk.stdout + chk.stderr).splitlines()[-12:]))
    dirty = [l for l in _mgit(new_state, "status", "--porcelain", "--untracked-files=no").stdout.splitlines() if l.strip()]
    if dirty:
        print(f"note: {STATE_DIR}/ has {len(dirty)} uncommitted tracked change(s) after the move (first {dirty[0][3:]})")
    done = ok and nxt.returncode == 0 and chk.returncode == 0
    print(f"migrate={'done' if done else 'done-with-problems'}" + (f" ({len(left)} item(s) left for you, above)" if left else ""))
    return 0 if done else 1


if __name__ == "__main__":
    raise SystemExit(migrate_main(sys.argv[1:]))
