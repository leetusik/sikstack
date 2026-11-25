"""The design part: `design-sign`, and (2.1.0) `design-publish`, `design-builds` and `design-delete`, and (0.7.0)
`design-link`. Imports wf_store; the publish verbs import wf_cloud when they run, for the link, the key and the
transport.

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
# The three verbs talk to the design API (`/api/design/<project>/builds`) with this checkout's link and its workspace
# key, read by wf_cloud.CloudLink from the key file (never argv, never printed), over wf_cloud's own transport (its
# stall rules, no redirect followed, no proxy for a local server). The link is the [cloud] table in a linked checkout,
# exactly as before; in a local workspace it is the design link, config.toml's [design] table (server and project_id,
# never the key), which `design-link` writes. [design] is not cloud mode: cloud_linked() reads only [cloud], so a
# design link leaves every command local and every worktree phase running. The verbs touch no workspace truth, so they
# run outside the cloud boundary (no pull, no batch, no lock): workflow.run reads DESIGN_API_COMMANDS. design-link is
# there too: in a linked checkout it refuses before anything is read or written.
DESIGN_API_COMMANDS = ("design-publish", "design-builds", "design-delete", "design-link")
DESIGN_TABLE = "design"
DESIGN_TABLE_NOTE = ("# The design link: design-publish, design-builds and design-delete publish here (sikstack design-link "
                     "writes it; it holds no key, and it is not cloud mode).")
DESIGN_SCHEMA = 1
MANIFEST_MARK = "sikstack-design-build"
CAP_UNPACKED = 50 * 1024 * 1024  # the server's caps (server/design/settings.py), checked here before anything is sent
CAP_FILES = 5_000
CAP_COMPRESSED = 16 * 1024 * 1024
UNLINKED_LINE = ("this checkout is not linked to sikstack (no [cloud] table, and no [design] table in config.toml here "
                 "or in the main checkout): run sikstack design-link to publish design builds from a local workspace, "
                 "or run /sikstack:sign-in for cloud mode")


def _mb(value: int) -> str:
    """`16 MB` for a whole number of MiB, else one decimal, as the server names its caps."""
    whole = value / (1024 * 1024)
    return f"{whole:.0f} MB" if value % (1024 * 1024) == 0 else f"{whole:.1f} MB"


def _main_config() -> Path:
    """The workflow repo's main worktree's config.toml: the first entry of `git worktree list` from this checkout (never
    found by a branch name), the file every phase worktree cut later inherits; this checkout's own when ROOT is not a
    git repo of its own."""
    from wf_store import _git, _git_available, _worktree_entries
    own = ROOT / "config.toml"
    try:
        if not _git_available():
            return own
        top = _git(["rev-parse", "--show-toplevel"], check=False)
        if top.returncode != 0 or Path(top.stdout.strip()).resolve() != ROOT.resolve():
            return own  # ROOT sits inside another repo: that repo's worktrees are not the workflow repo's
        entries = _worktree_entries()
    except (OSError, SystemExit):
        return own
    return Path(entries[0][0]) / "config.toml" if entries else own


def design_read_link() -> tuple:
    """(the design link as a dict, the config.toml it came from), or (None, None): the [design] table of the workflow
    repo's main worktree's config.toml, else this checkout's. The main worktree's comes first because design-link
    writes it there: a phase worktree cut before the link has no table of its own, and one cut after holds only a copy,
    so a replaced link reaches every checkout at once. A table that cannot be read raises ValueError."""
    import wf_cloud
    seen = []
    for path in (_main_config(), ROOT / "config.toml"):
        if path.resolve() in seen:
            continue
        seen.append(path.resolve())
        link = wf_cloud.config_read_table(path, DESIGN_TABLE)
        if link is not None:
            return link, path
    return None, None


def _design_link(prog: str, nothing: str):
    """This checkout's CloudLink (server, project, key): the [cloud] link when linked, exactly as before; else the
    design link ([design]), built from it with the same key file, the same key reading and the same server check; else
    one line naming design-link, before any request."""
    import wf_cloud
    if wf_cloud.cloud_linked():
        return wf_cloud.api_link(prog, nothing)  # the link every API verb shares
    try:
        link, path = design_read_link()
    except (OSError, ValueError) as exc:
        raise SystemExit(f"{prog}: the [{DESIGN_TABLE}] table is unreadable ({exc}): run design-link --replace ({nothing})")
    if link is None:
        raise SystemExit(f"{prog}: {UNLINKED_LINE} ({nothing})")
    if not isinstance(link.get("server"), str) or not link.get("project_id"):
        raise SystemExit(f"{prog}: {path}'s [{DESIGN_TABLE}] table lacks its server or project_id: run design-link "
                         f"--replace ({nothing})")
    try:
        return wf_cloud.CloudLink({"server": link["server"], "project_id": str(link["project_id"])}, again="design-link")
    except wf_cloud.CloudError as exc:
        raise SystemExit(f"{prog}: {exc}")


def design_link(args: argparse.Namespace) -> int:
    """design-link: give a local workspace a design link (see its parser's help). Every refusal comes before anything
    is read from the server or written."""
    import sys
    import wf_cloud
    prog, nothing = "design-link", "nothing was written"
    if wf_cloud.cloud_linked():
        raise SystemExit(f"{prog}: this checkout is linked to sikstack (cloud mode: the [cloud] table in "
                         f"{wf_cloud.cloud_config_file()}), and that link already publishes design builds ({nothing})")
    if bool(args.address) == bool(args.data_dir):
        raise SystemExit(f"{prog}: give one of the project's page address (<server>/projects/<project-id>, then paste "
                         f"its workspace key) or --data-dir (the connect page, which makes a new project) ({nothing})")
    target = _main_config()
    try:
        current, where = design_read_link()
    except (OSError, ValueError) as exc:
        if not args.replace:
            raise SystemExit(f"{prog}: the [{DESIGN_TABLE}] table is unreadable ({exc}): run design-link --replace to "
                             f"write it again ({nothing})")
        current, where = None, None
    problem = wf_cloud.cloud_key_problem(wf_cloud.cloud_key_file())
    if problem:
        raise SystemExit(f"{prog}: {problem}")

    def already(form: str):
        raise SystemExit(f"{prog}: this workspace already has a design link (server={current.get('server')} "
                         f"project={current.get('project_id')}): it is in {where}; run design-link --replace {form} to "
                         f"point it elsewhere ({nothing})")

    if args.address:
        try:
            server, project = wf_cloud.cloud_parse_address(args.address, prog)
        except wf_cloud.CloudError as exc:
            raise SystemExit(f"{prog}: {exc}")
        same = current is not None and str(current.get("server") or "").rstrip("/") == server \
            and str(current.get("project_id")) == project
        if current is not None and not same and not args.replace:
            already(args.address)
        try:
            key = wf_cloud.cloud_read_key()
        except wf_cloud.CloudError as exc:
            raise SystemExit(f"{prog}: {exc}")
        return _design_link_with(prog, server, project, None, key, target)
    import wf_setup
    if current is not None and not args.replace:
        already("--data-dir <the plugin's data folder>")
    data_dir = wf_setup.data_dir_arg(args.data_dir, prog)
    try:
        server = wf_cloud.cloud_server_check(wf_setup.machine_server(data_dir))
    except (wf_cloud.CloudError, ValueError) as exc:
        raise SystemExit(f"{prog}: {exc}")

    def approved(answer: dict, project: str, key: str) -> int:
        print(f"connected: the install now belongs to your account; keeping a design link to "
              f"{answer.get('project_name') or project}")
        sys.stdout.flush()
        code = _design_link_with(prog, server, project, answer.get("org_id"), key, target)
        if answer.get("web_url"):
            print(f"on the web: {answer['web_url']}")
        return code

    again = f"`sikstack design-link{' --replace' if args.replace else ''} --data-dir <the plugin's data folder>`"
    # The new project is named after the main host checkout's folder, never a phase worktree's.
    repo = (MAIN_HOST or HOST_ROOT or ROOT.parent).name
    return wf_cloud.cloud_device_sign_in(args, prog, server, data_dir, wf_cloud._signin_file(data_dir, target.parent, "design"),
                                         repo, again, again, "keep a design link", approved)


def _design_link_with(prog: str, server: str, project: str, org, key: str, target: Path) -> int:
    """design-link past its refusals: probe the design API with the key (any answer but a 2xx refuses, nothing
    written), keep the key (wf_cloud.cloud_save_key: 0600, never printed), then write [design] into `target`, the main
    worktree's config.toml. It is not committed: a commit there would land in another checkout's index, which a session
    on the main checkout may be using; the verbs read the file from the disk, and the workflow repo's next commit
    takes it."""
    import wf_cloud
    nothing = "nothing was written"
    try:
        probe = wf_cloud.CloudLink({"server": server, "project_id": project}, key=key, again="design-link")
    except wf_cloud.CloudError as exc:
        raise SystemExit(f"{prog}: {exc}")
    _design_call(probe, prog, nothing, "GET")
    try:
        wf_cloud.cloud_save_key(server, project, org, key)
    except wf_cloud.CloudError as exc:
        raise SystemExit(f"{prog}: {exc}")
    wf_cloud.config_write_table(target, DESIGN_TABLE, DESIGN_TABLE_NOTE,
                                {"schema": DESIGN_SCHEMA, "server": server, "project_id": project, "linked_at": now_iso()})
    print(f"design_link=written server={server} project={project} config={target}")
    print(f"the key is kept in {wf_cloud.cloud_key_file()}, never in config.toml. Every checkout of this workspace, a "
          "phase's worktree included, publishes with it (sikstack design-publish --folder <folder>); the workspace "
          "stays local (no cloud mode)")
    print(f"note: {target} is not committed; the workflow repo's next commit takes it")
    return 0


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
                       "workspace key (read from the key file, never argv). The link is the [cloud] table in a linked "
                       "checkout, else the design link ([design], which design-link writes; read from the main checkout's "
                       "config.toml, so a phase's worktree publishes too). Refused before anything is sent with no link, "
                       f"unmarked or over a cap ({_mb(CAP_UNPACKED)} unpacked, {CAP_FILES:,} files, {_mb(CAP_COMPRESSED)} "
                       "compressed); prints the URL to open the build at (its viewer on sikstack; the build's own host is host=) "
                       "and whether it is private (a --data local/<name> recording)",
                       description="Run only when the operator's words ask to publish; publishing is never a sign-off. "
                       "Every publish is a new build, kept beside the earlier ones.")
    p.add_argument("--folder", required=True, help="the design folder: its path inside the product repo (e.g. web/design) or an absolute path")
    p.add_argument("--repo", default=None, help="the product repo's registered name (a multi-repo host with more than one repo)")
    p.set_defaults(func=design_publish)
    p = sub.add_parser("design-builds", help="List the linked (or design-linked) project's design builds, newest first: id, the URL to "
                       "open (its viewer on sikstack), when, commit, branch, size, files, private, share and its host")
    p.set_defaults(func=design_builds)
    p = sub.add_parser("design-delete", help="Delete one design build of the linked (or design-linked) project (an id design-builds lists); "
                       "its host answers 404 and its viewer says it is gone")
    p.add_argument("build", help="the build's id (b followed by 25 letters and digits)")
    p.set_defaults(func=design_delete)
    p = sub.add_parser("design-link", help="Give a local workspace a design link, so design-publish, design-builds and "
                       "design-delete work without linking it to sikstack: the workspace stays local (no cloud mode, no "
                       "sync) and its worktree phases keep running. With --data-dir it runs the connect-page sign-in (as "
                       "sign-in does: a code, the connect page, a wait; exit 3 still waiting, run it again), which makes a "
                       "new project named after the main host checkout's folder and hands its workspace key over once. "
                       "With the project's page address, <server>/projects/<project-id>, it reads a workspace key pasted "
                       "at a prompt (one stdin line when not a terminal), never on the command line. Either way the key is "
                       "probed against the design API first, then kept in $XDG_CONFIG_HOME/sikstack/workspace-keys.json "
                       "(folder 0700, file 0600; never printed), and the link is written as the [design] table (server, "
                       "project_id; no key) of the workflow repo's main checkout's config.toml, also from a phase's "
                       "worktree, uncommitted (its path is printed). Refused, nothing written: a cloud-linked checkout "
                       "(its link already publishes), a key file or folder open to group or others, a key the design API "
                       "refuses, and a [design] table naming another link (any, for --data-dir) unless --replace. Prints "
                       "design_link=written server= project= config=",
                       description="Run with the operator: the connect page is theirs to confirm. design-publish then "
                       "prints the build's viewer; sharing is turned on there, by a member, never by the engine.")
    p.add_argument("address", nargs="?", default=None,
                   help="the project's page address, <server>/projects/<project-id>, for a pasted key (else --data-dir)")
    p.add_argument("--data-dir", default=None, dest="data_dir",
                   help="the plugin's data folder (${CLAUDE_PLUGIN_DATA}): run the connect-page sign-in")
    p.add_argument("--no-browser", action="store_true", dest="no_browser", help="print the connect page's address without opening it")
    p.add_argument("--wait", type=int, default=540, help="seconds to wait for the connect page in this run (default 540)")
    p.add_argument("--replace", action="store_true",
                   help="replace a [design] table that names another link (the old key stays in the key file)")
    p.set_defaults(func=design_link)
