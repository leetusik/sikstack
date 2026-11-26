"""`sikstack init`: make a repo's (or a multi-repo host folder's) `.sikstack/` workspace. It runs before any state
exists, so it imports no other engine module (wf_store finds the state at import, or exits 2).

What it makes, never overwriting a file that is already there (a second run repairs what is missing and changes
nothing else):
- `.sikstack/`, its own git repo, as the old `workflow/` was, so the workflow-state commit is `git -C .sikstack ...`;
- `works/` (the phase and agenda folders and the event log) and `docs/current/` from the plugin's doc bodies;
- `config.toml`, the operator's settings: the executor route rows, all commented at their defaults;
- `.agentic-nested.json`, the marker that says the state is nested in the folder above (`host_root: ".."`);
- `.gitattributes` (the event log merges by union);
- one `/.sikstack/` line in the repo's `.git/info/exclude` (never `.gitignore`), plus `/<repo>/` for each repo a
  multi-repo host registers;
then the generated files by `check`, and one commit in `.sikstack/` when git has an identity there."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ".sikstack"
MARKER = ".agentic-nested.json"
OLD_MARKER = Path("workflow") / ".agentic-nested.json"
DOC_TYPES = ("product", "architecture", "operations", "qa", "decisions")
WORKS_DIRS = ("works/phases/active", "works/phases/archived", "works/agenda", "docs/current")
CONFIG_SEED = PLUGIN_ROOT / "templates" / "config.toml"


def _init_git(cwd: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def _toplevel(start: Path):
    """The git work tree root holding `start`, skipping a `.sikstack/` repo itself, or None outside git."""
    proc = _init_git(start, "rev-parse", "--show-toplevel")
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    top = Path(proc.stdout.strip()).resolve()
    if top.name == STATE_DIR:
        return _toplevel(top.parent)
    return top


def _write_new(path: Path, text: str, made: list) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    made.append(path)


def _exclude(repo: Path, lines: list) -> list:
    """Add each `/<path>/` line to the repo's common info/exclude once; returns the lines it added."""
    proc = _init_git(repo, "rev-parse", "--git-common-dir")
    if proc.returncode != 0 or not proc.stdout.strip():
        return []
    exclude = (repo / proc.stdout.strip()).resolve() / "info" / "exclude"
    existing = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
    have = {line.strip() for line in existing.splitlines()}
    added = [line for line in lines if not ({line, line.strip("/"), line.lstrip("/"), line.rstrip("/")} & have)]
    if added:
        exclude.parent.mkdir(parents=True, exist_ok=True)
        sep = "\n" if existing and not existing.endswith("\n") else ""
        exclude.write_text(existing + sep + "".join(f"{line}\n" for line in added), encoding="utf-8")
    return added


def init_main(argv: list) -> int:
    if argv and argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    if argv:
        print(f"sikstack init: takes no arguments (got {' '.join(argv)}); run it inside the repo or host folder", file=sys.stderr)
        return 2
    cwd = Path.cwd().resolve()
    top = _toplevel(cwd)
    if top is None:
        print(f"sikstack init: {cwd} is not in a git repo; run `git init` first (sikstack keeps its state beside a repo) "
              "-- nothing was written", file=sys.stderr)
        return 2
    for d in (top, *top.parents):
        if (d / OLD_MARKER).is_file():
            print(f"sikstack init: {d} holds an old workflow/ install; run `sikstack migrate` there to move it into "
                  ".sikstack/ -- nothing was written", file=sys.stderr)
            return 2
        if d != top and (d / STATE_DIR).is_dir():
            print(f"sikstack init: {top} is already inside the workspace at {d / STATE_DIR}; a second one here would hide "
                  "it from every command run below -- nothing was written", file=sys.stderr)
            return 2
    state = top / STATE_DIR
    fresh = not state.exists()
    made: list = []
    for rel in WORKS_DIRS:
        (state / rel).mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    _write_new(state / "works" / "events.jsonl",
               json.dumps({"ts": now, "type": "bootstrap", "project": top.name}, ensure_ascii=False) + "\n", made)
    for doc in DOC_TYPES:
        body = (PLUGIN_ROOT / "templates" / "docs" / f"{doc}.md").read_text(encoding="utf-8")
        _write_new(state / "docs" / "current" / f"{doc}.md",
                   body.replace("__PROJECT_NAME__", top.name).replace("__PROJECT_SUMMARY__", "_One paragraph: what this repo is for._"),
                   made)
    _write_new(state / "config.toml", CONFIG_SEED.read_text(encoding="utf-8"), made)
    _write_new(state / ".gitattributes", (PLUGIN_ROOT / "templates" / "gitattributes").read_text(encoding="utf-8"), made)
    marker = {"schema": 1, "host_root": "..",
              "commit_convention": {"inferred": None, "confirmed": False, "text": None, "coauthor_trailers": "unknown"},
              "renames": {"skills": {}, "agents": {}}}
    _write_new(state / MARKER, json.dumps(marker, indent=2) + "\n", made)
    if not (state / ".git").exists():
        if _init_git(state, "init", "-q").returncode != 0:
            print(f"sikstack init: git init failed in {state}", file=sys.stderr)
            return 1
    _exclude(state, ["/.hi2vi/", "/cache/"])  # cloud mode's bookkeeping and its cold reads' cache (wf_cold)
    try:
        repos = json.loads((state / MARKER).read_text(encoding="utf-8")).get("repos") or []
    except (OSError, ValueError, AttributeError):
        repos = []
    added = _exclude(top, [f"/{STATE_DIR}/"] + [f"/{r['path']}/" for r in repos if isinstance(r, dict) and isinstance(r.get("path"), str)])
    check = subprocess.run([sys.executable, str(PLUGIN_ROOT / "scripts" / "workflow.py"), "check"], cwd=str(top),
                           capture_output=True, text=True, env={**os.environ, "SIKSTACK_ROOT": str(state)})
    if check.returncode != 0:
        sys.stderr.write(check.stdout + check.stderr)
        print(f"sikstack init: the new workspace did not validate; see above ({state})", file=sys.stderr)
        return 1
    committed = None
    if fresh:
        _init_git(state, "add", "-A")
        commit = _init_git(state, "commit", "-q", "-m", "chore(sikstack): start the workspace")
        committed = commit.returncode == 0
    print(f"{'initialized' if fresh else 'repaired' if made or added else 'already initialized'}: {state}")
    for path in made:
        print(f"- wrote {path.relative_to(top)}")
    for line in added:
        print(f"- excluded {line} in the repo's .git/info/exclude")
    if committed is False:
        print(f"note: no commit in {STATE_DIR}/ (git has no identity there); commit it yourself: git -C {STATE_DIR} add -A && "
              f"git -C {STATE_DIR} commit -m \"chore(sikstack): start the workspace\"")
    print("next: /sikstack:sik-mode, to start the first phase")
    return 0
