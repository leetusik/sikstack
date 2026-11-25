"""The design part: `design-sign`, and (2.1.0) `design-publish`, `design-builds` and `design-delete`. Imports wf_store;
the publish verbs import wf_cloud when they run, for the link, the key and the transport.

A product's design lives in its own repo, in the design folder its rules file declares (platform's is web/design/,
built and served by the repo's own commands); the engine reads it only through git, and design-publish only its
built out/ folder. `design-sign` records the
operator's literal sign-off words for a slice's design, with where the design stood in the product repo: its HEAD
commit, the folder's own last commit and the folder's uncommitted paths. The record is the slice folder's
design-signoff.json; a later sign-off of the same slice is appended, never replacing the earlier one.

Records of the retired canvas flow (.sikstack/docs/reference/design/: design.json, jobs/, rounds/) stay on disk as
plain files that nothing reads."""
from __future__ import annotations

import argparse
import json
import re
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


def _product_repo(name, prog="design-sign"):
    """(name, path) of the product repo the design folder lives in: a registry entry on a multi-repo host (its
    worktree in a parallel set when it has one there), else the one product repo around the workspace."""
    repos = nested_repos()
    if repos:
        names = [r.get("name") for r in repos]
        if name is None:
            if len(repos) != 1:
                raise SystemExit(f"{prog}: this host holds {len(repos)} repos; name the design's with --repo "
                                 f"({', '.join(map(str, names))})")
            name = names[0]
        found = [r for r in repos if r.get("name") == name]
        if not found:
            raise SystemExit(f"{prog}: no registered repo {name!r} (registered: {', '.join(map(str, names))})")
        in_set = HOST_ROOT / found[0]["path"]
        return name, in_set if in_set.is_dir() else (MAIN_HOST or HOST_ROOT) / found[0]["path"]
    if name is not None:
        raise SystemExit(f"{prog}: --repo names a repo of a multi-repo host; this workspace has one product repo")
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


# -- publish: the design folder's build to the linked project's Design service ----------------------------------
# The three verbs talk to the design API (`/api/design/<project>/builds`) with the linked checkout's [cloud] link and
# its workspace key, read by wf_cloud.CloudLink from the key file (never argv, never printed), over wf_cloud's own
# transport (its stall rules, no redirect followed, no proxy for a local server). They touch no workspace truth, so
# they run outside the cloud boundary (no pull, no batch, no lock): workflow.run reads DESIGN_API_COMMANDS.
DESIGN_API_COMMANDS = ("design-publish", "design-builds", "design-delete")
MANIFEST_MARK = "sikstack-design-build"
CAP_UNPACKED = 50 * 1024 * 1024  # the server's caps (server/design/settings.py), checked here before anything is sent
CAP_FILES = 5_000
CAP_COMPRESSED = 16 * 1024 * 1024


def _mb(value: int) -> str:
    """`16 MB` for a whole number of MiB, else one decimal, as the server names its caps."""
    whole = value / (1024 * 1024)
    return f"{whole:.0f} MB" if value % (1024 * 1024) == 0 else f"{whole:.1f} MB"


def _design_link(prog: str, nothing: str):
    """The linked checkout's CloudLink (server, project, key), or one line: the sign-in line when unlinked
    (wf_cloud.api_link, the link every API verb shares)."""
    import wf_cloud
    return wf_cloud.api_link(prog, nothing)


def _design_call(link, prog: str, nothing: str, method: str, suffix: str = "", body=None) -> dict:
    """One request to the design API; the 2xx answer's JSON, else one line (the server's own, with its status)."""
    from urllib.parse import quote
    import wf_cloud
    return wf_cloud.api_call(link, prog, nothing, method, f"/api/design/{quote(link.project, safe='')}/builds{suffix}",
                             body=body, content_type="application/gzip")


def _build_folder(args, prog: str) -> Path:
    """The design folder: an absolute path as given, else a path inside the product repo (--repo on a multi-repo host)."""
    raw = Path(args.folder).expanduser()
    if raw.is_absolute():
        folder = raw
    else:
        rel = PurePosixPath(args.folder.strip().strip("/"))
        if not str(rel) or ".." in rel.parts or str(rel) == ".":
            raise SystemExit(f"{prog}: --folder {args.folder!r} must be the design folder's path inside the product "
                             "repo (e.g. web/design) or an absolute path")
        name, repo = _product_repo(args.repo, prog)
        folder = repo / rel
    if not folder.is_dir():
        raise SystemExit(f"{prog}: refused -- no design folder at {folder} (nothing was published)")
    return folder


def _measure(out: Path, prog: str) -> tuple:
    """(bytes, files) of the build folder, refusing a link or a special file (a build holds only files and folders)."""
    import os
    total = files = 0
    for here, dirs, names in os.walk(out):
        for name in sorted(dirs + names):
            path = Path(here) / name
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise SystemExit(f"{prog}: refused -- {path.relative_to(out)} in {out} is a link or a special file: "
                                 "a build holds only files and folders (nothing was published)")
        for name in names:
            files += 1
            total += (Path(here) / name).stat().st_size
    return total, files


def design_publish(args: argparse.Namespace) -> None:
    """Publish the design folder's build (out/, manifest.json at its root) to the linked project: refused unmarked,
    over a cap or unlinked before anything is sent; prints the build's URL to open (`url=`, its viewer on sikstack, as
    the server names it: the build's own host admits only a ticket or a share link, so it is `host=`, last) and
    whether it is private."""
    import tarfile
    import tempfile
    prog, nothing = "design-publish", "nothing was published"
    folder = _build_folder(args, prog)
    out = folder / "out"
    manifest_path = out / "manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(f"{prog}: refused -- {folder} has no build: {manifest_path} is missing (build the folder with "
                         f"its own build command first) ({nothing})")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as exc:
        raise SystemExit(f"{prog}: refused -- {manifest_path} cannot be read ({exc.__class__.__name__}) ({nothing})")
    if not isinstance(manifest, dict) or manifest.get("$design") != MANIFEST_MARK:
        raise SystemExit(f"{prog}: refused -- {manifest_path} is not a design build's manifest (no "
                         f"\"$design\": \"{MANIFEST_MARK}\") ({nothing})")
    size, files = _measure(out, prog)
    if files > CAP_FILES:
        raise SystemExit(f"{prog}: refused -- the build holds {files:,} files: the cap is {CAP_FILES:,} files ({nothing})")
    if size > CAP_UNPACKED:
        raise SystemExit(f"{prog}: refused -- the build is {size:,} bytes ({_mb(size)}) unpacked: the cap is "
                         f"{_mb(CAP_UNPACKED)} unpacked ({nothing})")
    link = _design_link(prog, nothing)
    with tempfile.TemporaryFile(prefix="sikstack-design-") as tmp:
        with tarfile.open(fileobj=tmp, mode="w:gz", compresslevel=6) as tar:
            for child in sorted(out.iterdir()):
                tar.add(str(child), arcname=child.name)
        packed = tmp.tell()
        if packed > CAP_COMPRESSED:
            raise SystemExit(f"{prog}: refused -- the build is {packed:,} bytes ({_mb(packed)}) compressed: the cap is "
                             f"{_mb(CAP_COMPRESSED)} compressed ({nothing})")
        tmp.seek(0)
        body = tmp.read()
    # The key first, by one small request: the server refuses a key before it reads a body, so a refused key on a
    # megabytes upload would reach this checkout as a broken pipe instead of the server's one line.
    _design_call(link, prog, nothing, "GET")
    answer = _design_call(link, prog, nothing, "POST", body=body)
    build = answer.get("build") if isinstance(answer.get("build"), dict) else {}
    private = bool(build.get("private"))
    print(f"published={build.get('id')} url={_open_url(build, answer)} private={'yes' if private else 'no'} "
          f"commit={str(build.get('commit') or 'none')[:12]} branch={build.get('branch') or 'none'} "
          f"size={build.get('size')} files={build.get('files')} compressed={packed} "
          f"host={answer.get('url') or build.get('url')}")
    if private:
        print(f"private: made from a private recording ({build.get('recording') or 'design/data/local/'}), so its "
              "share link cannot be turned on")


def _open_url(build: dict, answer: dict | None = None):
    """The address a person opens a build at: the server's `viewer` (the build's viewer on sikstack), else (a server
    from before it named one) the build's host. Composed by the server, never here."""
    answer = answer or {}
    return answer.get("viewer") or build.get("viewer") or answer.get("url") or build.get("url")


def design_builds(args: argparse.Namespace) -> None:
    """The linked project's design builds, newest first, one line each: the id, then the URL to open (`url=`)."""
    prog, nothing = "design-builds", "nothing was read"
    link = _design_link(prog, nothing)
    builds = _design_call(link, prog, nothing, "GET").get("builds")
    builds = [b for b in builds if isinstance(b, dict)] if isinstance(builds, list) else []
    print(f"builds={len(builds)} project={link.project}")
    for b in builds:
        share = b.get("share") if isinstance(b.get("share"), dict) else {}
        print(f"{b.get('id')} url={_open_url(b)} published_at={b.get('published_at')} "
              f"commit={str(b.get('commit') or 'none')[:12]} branch={b.get('branch') or 'none'} size={b.get('size')} "
              f"files={b.get('files')} private={'yes' if b.get('private') else 'no'} "
              f"share={'on' if share.get('on') else 'off'} host={b.get('url')}")


def design_delete(args: argparse.Namespace) -> None:
    """Delete one design build of the linked project: its row, then its files; its host answers 404 and its viewer
    says it is gone."""
    from urllib.parse import quote
    prog = "design-delete"
    nothing = "nothing was deleted"
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.build or ""):
        raise SystemExit(f"{prog}: {args.build!r} is not a build id (design-builds lists them) ({nothing})")
    link = _design_link(prog, nothing)
    answer = _design_call(link, prog, nothing, "DELETE", suffix="/" + quote(args.build, safe=""))
    print(f"deleted={answer.get('deleted') or args.build}")


def add_design_parsers(sub) -> None:
    """design-sign and the publish verbs: registered by the entry's build_parser in its place."""
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
    p = sub.add_parser("design-publish", help="Publish the design folder's build (<folder>/out, manifest.json at its root, "
                       "marked $design: sikstack-design-build) to the linked project's Design service with this checkout's "
                       "workspace key (read from the key file, never argv); refused before anything is sent when unlinked, "
                       f"unmarked or over a cap ({_mb(CAP_UNPACKED)} unpacked, {CAP_FILES:,} files, {_mb(CAP_COMPRESSED)} "
                       "compressed); prints the URL to open the build at (its viewer on sikstack; the build's own host is host=) "
                       "and whether it is private (a --data local/<name> recording)",
                       description="Run only when the operator's words ask to publish; publishing is never a sign-off. "
                       "Every publish is a new build, kept beside the earlier ones.")
    p.add_argument("--folder", required=True, help="the design folder: its path inside the product repo (e.g. web/design) or an absolute path")
    p.add_argument("--repo", default=None, help="the product repo's registered name (a multi-repo host with more than one repo)")
    p.set_defaults(func=design_publish)
    p = sub.add_parser("design-builds", help="List the linked project's design builds, newest first: id, the URL to "
                       "open (its viewer on sikstack), when, commit, branch, size, files, private, share and its host")
    p.set_defaults(func=design_builds)
    p = sub.add_parser("design-delete", help="Delete one design build of the linked project (an id design-builds lists); "
                       "its host answers 404 and its viewer says it is gone")
    p.add_argument("build", help="the build's id (b followed by 25 letters and digits)")
    p.set_defaults(func=design_delete)
