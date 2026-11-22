"""The design part: `design-sign`, the one design command left (2.0.0). Imports only wf_store.

A product's design lives in its own repo, in the design folder its rules file declares (platform's is web/design/,
built and served by the repo's own commands); the engine never reads it beyond git. `design-sign` records the
operator's literal sign-off words for a slice's design, with where the design stood in the product repo: its HEAD
commit, the folder's own last commit and the folder's uncommitted paths. The record is the slice folder's
design-signoff.json; a later sign-off of the same slice is appended, never replacing the earlier one.

Records of the retired canvas flow (.sikstack/docs/reference/design/: design.json, jobs/, rounds/) stay on disk as
plain files that nothing reads."""
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path, PurePosixPath

from wf_store import (  # noqa: E402
    HOST_ROOT, MAIN_HOST, nested_repos, now_iso, read_json, require_slice, ROOT, shown, write_json,
)

SIGNOFF_FILE = "design-signoff.json"
SIGNOFF_SCHEMA = 1


def _design_git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"design-sign: git {' '.join(args)} failed in {repo}: {(proc.stderr or proc.stdout).strip()}")
    return proc.stdout


def _uncommitted(repo: Path, rel: PurePosixPath) -> tuple[list[str], list[dict]]:
    """The folder's uncommitted paths as they are on disk, from `git status --porcelain=v1 -z`: NUL-separated and
    never quoted, so a name with spaces or non-ASCII letters is kept as it is. A rename or copy is its new path, and
    is also listed in `renamed` with the path it came `from`."""
    proc = subprocess.run(["git", "-C", str(repo), "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", str(rel)],
                          capture_output=True)
    if proc.returncode != 0:
        raise SystemExit(f"design-sign: git status failed in {repo}: {proc.stderr.decode('utf-8', 'replace').strip()}")
    fields = proc.stdout.decode("utf-8", "replace").split("\0")
    paths, renames, i = set(), [], 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if len(rec) < 4:
            continue
        xy, path = rec[:2], rec[3:]
        paths.add(path)
        if "R" in xy or "C" in xy:  # -z writes the new path, then the old one as its own field
            renames.append({"path": path, "from": fields[i] if i < len(fields) else ""})
            i += 1
    return sorted(paths), sorted(renames, key=lambda r: r["path"])


def _product_repo(name):
    """(name, path) of the product repo the design folder lives in: a registry entry on a multi-repo host (its
    worktree in a parallel set when it has one there), else the one product repo around the workspace."""
    repos = nested_repos()
    if repos:
        names = [r.get("name") for r in repos]
        if name is None:
            if len(repos) != 1:
                raise SystemExit(f"design-sign: this host holds {len(repos)} repos; name the design's with --repo "
                                 f"({', '.join(map(str, names))})")
            name = names[0]
        found = [r for r in repos if r.get("name") == name]
        if not found:
            raise SystemExit(f"design-sign: no registered repo {name!r} (registered: {', '.join(map(str, names))})")
        in_set = HOST_ROOT / found[0]["path"]
        return name, in_set if in_set.is_dir() else (MAIN_HOST or HOST_ROOT) / found[0]["path"]
    if name is not None:
        raise SystemExit("design-sign: --repo names a repo of a multi-repo host; this workspace has one product repo")
    path = HOST_ROOT if HOST_ROOT is not None else ROOT.parent
    return path.name, path


def design_sign(args: argparse.Namespace) -> None:
    """Record the operator's literal sign-off of a slice's design: the words, the time, the product repo's HEAD,
    the design folder's last commit and its uncommitted paths. Refuses empty words and a folder that is not there."""
    if not args.words.strip():
        raise SystemExit("design-sign: --words must carry the operator's literal words")
    sdir = require_slice(args.slice)
    rel = PurePosixPath(args.folder.strip().strip("/"))
    if not str(rel) or rel.is_absolute() or ".." in rel.parts or str(rel) == ".":
        raise SystemExit(f"design-sign: --folder {args.folder!r} must be the design folder's path inside the product repo (e.g. web/design)")
    name, repo = _product_repo(args.repo)
    if not (repo / rel).is_dir():
        raise SystemExit(f"design-sign: refused -- no design folder {rel} in {name} ({repo})")
    head = _design_git(repo, "rev-parse", "HEAD").strip()
    folder_commit = _design_git(repo, "log", "-1", "--format=%H", "--", str(rel)).strip() or None
    uncommitted, renames = _uncommitted(repo, rel)
    entry = {"words": args.words, "signed_at": now_iso(), "repo": name, "folder": str(rel), "commit": head,
             "folder_commit": folder_commit, "uncommitted": uncommitted}
    if renames:
        entry["renamed"] = renames
    path = sdir / SIGNOFF_FILE
    record = read_json(path) if path.is_file() else {"schema": SIGNOFF_SCHEMA, "slice": args.slice, "signoffs": []}
    record.setdefault("signoffs", []).append(entry)
    write_json(path, record)
    print(f"signed={args.slice} repo={name} folder={rel} commit={head[:12]} folder_commit={(folder_commit or 'none')[:12]} "
          f"uncommitted={len(uncommitted)} signoffs={len(record['signoffs'])} record={shown(path)}")


def add_design_parsers(sub) -> None:
    """design-sign: registered by the entry's build_parser in its place."""
    p = sub.add_parser("design-sign", help="Record the operator's literal sign-off of a slice's design: the words, the time, the product "
                       "repo's HEAD, the design folder's last commit and its uncommitted paths, in the slice folder's "
                       f"{SIGNOFF_FILE} (a later sign-off is appended); refuses empty --words",
                       description="Run only on the operator's literal words in the session. The design folder is the one the "
                       "product repo's rules file declares (e.g. web/design); --repo names the repo on a multi-repo host.")
    p.add_argument("--slice", required=True, help="the slice whose design is signed (e.g. P48-k2.S1)")
    p.add_argument("--words", required=True, help="the operator's literal sign-off words, recorded verbatim")
    p.add_argument("--folder", required=True, help="the design folder's path inside the product repo (e.g. web/design)")
    p.add_argument("--repo", default=None, help="the product repo's registered name (a multi-repo host with more than one repo)")
    p.set_defaults(func=design_sign)
