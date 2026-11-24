"""Cold state: the engine's one way to read what a linked checkout keeps only in sikstack, and `sikstack cold`.
Imports only wf_store; the wire (the link, the session, the lock) is wf_cloud's, reached through SEAMS.

Local mode (no [cloud] link): every function here answers from the disk exactly as before and opens no socket.
In a linked checkout the cold set (wf_cloud.cloud_cold: archived phases, doc versions, docs/reference,
docs/index.json, the event log) leaves the disk once sikstack holds it, and the sync's base.json keeps {rev, sha256}
for every cold path sikstack holds: a cold path in the base and absent on disk is evicted. A read of an evicted
file goes through `.sikstack/cache/<the same path>`, a read-only copy that counts only while its sha256 equals the
base's; otherwise it is fetched again (P3) and checked. A fetch inside a command uses that command's session, which
holds the checkout's lock; outside one it takes the lock itself. The archived phase ids come from the base's paths,
with no request. A write to an evicted file (agenda-delete, agenda-merge, repo map-anchors) first brings it back to
its own path (`hydrate`, sha-checked); the commit step sends it as a put on the base's rev, and the eviction takes
it off the disk again."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import wf_store  # noqa: E402 -- its _CLOUD_UNDO (the inbox applier's undo notes) is read at call time
from wf_store import (  # noqa: E402
    ACTIVE, ARCHIVE_FOLDER_ID_RE, ARCHIVED, brief_id, id_number, lookup_id_number, read_json, ROOT, shown,
    visible_ids, WORKS,
)

# The names this module calls in a module above it. It never imports that module: the entry (workflow.py) binds
# each name here before any command runs.
SEAMS = {
    "wf_cloud": (
        '_cloud_ignored_dir', 'CLOUD_COLD_FILES', 'CLOUD_COLD_PREFIXES', 'CLOUD_DIR', 'cloud_cold', 'cloud_cold_top',
        'cloud_kind', 'cloud_linked', 'cloud_stop_line', 'cloud_truth_rel', 'CloudError', 'CloudLock', 'CloudSession',
    ),
}

CACHE_DIR = "cache"  # .sikstack/cache/: hidden from the workflow repo's git, outside the truth set (works/, docs/)
CACHE = ROOT / CACHE_DIR
ARCHIVED_REL = "works/phases/archived/"
EVENTS_REL = "works/events.jsonl"
SEARCH_MIN, SEARCH_MAX = 2, 200  # the query's length after trimming, as sikstack's search route holds it
SEARCH_LIMIT, SEARCH_LIMIT_MAX = 50, 200
SEARCH_SNIPPET = 240
SEARCH_PROBE = 8192  # a NUL in the first 8 KB: binary, never searched
# The session hook's way past a cloud stop (wf_cloud.cloud_fail_open) sets this: an evicted file whose cached copy
# is not valid is then read as absent, and nothing is fetched (the hook never waits on the network twice).
LENIENT = False
_BASE_MEMO: dict = {}


def linked() -> bool:
    return cloud_linked()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_sha(path: Path):
    try:
        return _sha(path.read_bytes())
    except OSError:
        return None


def base_files() -> dict:
    """The base's `files` ({rel: {rev, sha256, kind[, offset]}}): the running command's session's, else
    base.json as saved in the sync's folder (read again only when it changed). {} when there is none."""
    session = getattr(CloudSession, "active", None)
    if session is not None and isinstance(session.base.get("files"), dict):
        return session.base["files"]
    path = ROOT / CLOUD_DIR / "base.json"
    try:
        st = path.stat()
    except OSError:
        return {}
    key = (st.st_mtime_ns, st.st_size)
    if _BASE_MEMO.get("key") != key:
        try:
            data = read_json(path)
        except (OSError, ValueError):
            data = {}
        files = data.get("files") if isinstance(data, dict) else None
        _BASE_MEMO.clear()
        _BASE_MEMO.update(key=key, files=files if isinstance(files, dict) else {})
    return _BASE_MEMO["files"]


def _held(rel: str, files: dict):
    """The base's entry for a cold file sikstack holds as a revisioned file, else None."""
    entry = files.get(rel)
    if isinstance(entry, dict) and entry.get("kind") == "file" and isinstance(entry.get("sha256"), str) and cloud_cold(rel):
        return entry
    return None


def evicted(rel: str, files=None) -> bool:
    """True when a linked checkout's cold file is in the base and absent on disk."""
    files = base_files() if files is None else files
    return _held(rel, files) is not None and not (ROOT / rel).is_file()


def truth_rel(path: Path) -> str:
    """The ROOT-relative POSIX path a disk or cache path stands for (`cache/works/...` is `works/...`)."""
    rel = Path(path).relative_to(ROOT).as_posix()
    return rel[len(CACHE_DIR) + 1:] if rel.startswith(CACHE_DIR + "/") else rel


def keep(rel: str, data: bytes) -> Path:
    """Write sikstack's bytes of `rel` into the cache, read-only (0444). The eviction calls it for an archived
    phase.json it takes off the disk (its bytes were checked against the base at that moment)."""
    path = CACHE / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=path.name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o444)
        os.replace(tmp, str(path))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return path


def _fetch(rels: list) -> dict:
    """{rel: bytes} of sikstack's live records among `rels` (P3, each checked against its own sha256 by the
    session). Inside a command: that command's session, which holds the lock; else one of its own, under the lock.
    A stop is the command's one line (a refusal: the boundary still runs its commit step)."""
    if not rels:
        return {}
    if LENIENT:
        return {}
    session = getattr(CloudSession, "active", None)
    try:
        if session is not None:
            got = session.fetch(rels)
        else:
            with CloudLock():
                got = CloudSession(["cold"]).fetch(rels)
    except CloudError as exc:
        raise SystemExit(cloud_stop_line(exc, "begin"))
    return {rel: data for rel, (_item, data) in got.items()}


def _ensure(rels: list, files=None) -> tuple:
    """({rel: cache path}, fetched) for evicted cold files: a cached copy whose sha256 is the base's is used as it
    is; every other one is fetched in one request, checked against the base and kept read-only. Lenient (the
    hook): a copy that cannot be had is left out."""
    files = base_files() if files is None else files
    out, need = {}, []
    for rel in dict.fromkeys(rels):
        entry = _held(rel, files)
        if entry is None:
            continue
        if _file_sha(CACHE / rel) == entry["sha256"]:
            out[rel] = CACHE / rel
        else:
            need.append(rel)
    got = _fetch(need)
    for rel in need:
        data = got.get(rel)
        if data is None:
            if LENIENT:
                continue
            raise SystemExit(f"{rel} is held only in sikstack ({CLOUD_DIR}/base.json names it), and sikstack has no live "
                             "record of it: run sync to see this checkout against sikstack")
        if _sha(data) != files[rel]["sha256"]:
            if LENIENT:
                continue
            raise SystemExit(f"{rel} changed in sikstack after this command's pull (its sha256 is not the one "
                             f"{CLOUD_DIR}/base.json holds): run the command again")
        out[rel] = keep(rel, data)
    return out, len(need)


def paths(rels) -> dict:
    """{rel: a path to read} for each rel that is on disk (its disk path, as today) or, in a linked checkout,
    evicted (its checked cache copy). A rel that is neither is left out."""
    rels = list(dict.fromkeys(rels))
    out = {rel: ROOT / rel for rel in rels if (ROOT / rel).is_file()}
    if linked():
        files = base_files()
        out.update(_ensure([rel for rel in rels if rel not in out], files)[0])
    return out


def readable(path: Path) -> Path:
    """The path to read a disk path from: itself when on disk (or in local mode), else its checked cache copy
    when it is evicted, else itself (so the read fails as it did)."""
    if path.is_file() or not linked():
        return path
    rel = truth_rel(path)
    return paths([rel]).get(rel, path)


def hydrate(path: Path) -> bool:
    """Bring an evicted cold file back to its own path before a write: fetched (or the checked cache copy) and
    checked against the base's sha256. The commit step then puts it on the base's rev, and the eviction takes it off
    again. False (nothing to do) in local mode or when the file is on disk."""
    if path.is_file() or not linked():
        return False
    rel = truth_rel(path)
    files = base_files()
    got = _ensure([rel], files)[0]
    if rel not in got:
        return False
    data = got[rel].read_bytes()
    if _sha(data) != files[rel]["sha256"]:  # the copy changed under us: never write unchecked bytes
        raise SystemExit(f"{rel}: its cached copy changed while it was read: run the command again")
    target = ROOT / rel
    wf_store._cloud_undo_note(target)  # the inbox applier's undo: an entry that crashes removes it again
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".tmp_", suffix=target.name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, str(target))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return True


def folder(rel_dir: str):
    """A folder to read whole: the disk folder when nothing under it is evicted (always in local mode), else its
    cache copy, which holds every file sikstack holds under it at sikstack's bytes (a disk file equal to the base's
    is copied, the rest fetched) and nothing else. None when neither has it."""
    rel_dir = rel_dir.rstrip("/")
    disk = ROOT / rel_dir
    if not linked():
        return disk if disk.is_dir() else None
    files = base_files()
    under = sorted(r for r in files if r.startswith(rel_dir + "/") and _held(r, files))
    if not any(not (ROOT / r).is_file() for r in under):
        return disk if disk.is_dir() else None
    _materialize(under, files, prune=rel_dir)
    return CACHE / rel_dir


def _materialize(rels: list, files: dict, prune=None) -> tuple:
    """Every rel (held by sikstack) as a checked read-only copy in the cache; with `prune` (a folder), any other
    file in the cache under it is removed, so the copy holds what sikstack holds. Returns (fetched, already cached)."""
    fetch, cached = [], 0
    for rel in rels:
        sha = files[rel]["sha256"]
        if _file_sha(CACHE / rel) == sha:
            cached += 1
            continue
        disk = ROOT / rel
        try:
            data = disk.read_bytes() if disk.is_file() else None
        except OSError:
            data = None
        if data is not None and _sha(data) == sha:
            keep(rel, data)
        else:
            fetch.append(rel)
    fetched = _ensure(fetch, files)[1]
    if prune is not None and (CACHE / prune).is_dir():
        want = {CACHE / rel for rel in rels}
        for path in sorted((CACHE / prune).rglob("*"), reverse=True):
            if path.is_file() and path not in want:
                path.unlink()
            elif path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    return fetched, cached


# Archived phases ---------------------------------------------------------------------------------------------
def archived_base_dirs() -> list:
    """The archive folder names sikstack holds, from the base's paths: no request. [] in local mode."""
    if not linked():
        return []
    names = set()
    for rel in base_files():
        if rel.startswith(ARCHIVED_REL):
            name = rel[len(ARCHIVED_REL):].split("/", 1)[0]
            if name and "/" in rel[len(ARCHIVED_REL):]:
                names.add(name)
    return sorted(names)


def archived_dir_names() -> list:
    """Every archive folder name, on disk or (linked) in the base, sorted (the archive stamp leads the name)."""
    names = {d.name for d in ARCHIVED.iterdir() if d.is_dir()} if ARCHIVED.is_dir() else set()
    return sorted(names | set(archived_base_dirs()))


def archived_phase_files(names=None) -> list:
    """[(folder name, path to read or None)] of each archive folder's phase.json, in name order: on disk, or the
    checked cache copy of an evicted one (one request for every copy missing)."""
    names = archived_dir_names() if names is None else names
    rels = {name: f"{ARCHIVED_REL}{name}/phase.json" for name in names}
    got = paths(list(rels.values()))
    return [(name, got.get(rel)) for name, rel in rels.items()]


def archived_phase_dir(phase_id: str):
    """The ROOT-relative folder of the newest archive of `phase_id` (by its phase.json `id`; a folder whose name
    carries the id is read first), or None."""
    names = archived_dir_names()
    named = [n for n in names if (ARCHIVE_FOLDER_ID_RE.search(n) or [None, None])[1] == phase_id]
    for group in ([named, [n for n in names if n not in named]] if named else [names]):
        hits = []
        for name, path in archived_phase_files(group):
            try:
                data = read_json(path) if path is not None else None
            except (OSError, ValueError):
                data = None
            if isinstance(data, dict) and data.get("id") == phase_id:
                hits.append(name)
        if hits:
            return ARCHIVED_REL + hits[-1]
    return None


def archived_glob(pattern: str, siblings=()) -> list:
    """[path] of the archived files matching `pattern` (a glob under works/phases/archived/; `*` never crosses a
    `/`): in local mode `ARCHIVED.glob(pattern)` as before; linked, the evicted ones too, as checked cache copies,
    with their `siblings` (file names in the same folder, such as result.md) brought into the cache beside them."""
    disk = list(ARCHIVED.glob(pattern)) if ARCHIVED.is_dir() else []
    if not linked():
        return disk
    files = base_files()
    rx = re.compile(re.escape(ARCHIVED_REL) + "".join("[^/]*" if c == "*" else re.escape(c) for c in pattern))
    gone = sorted(rel for rel in files if rx.fullmatch(rel) and _held(rel, files) and not (ROOT / rel).is_file())
    more = [f"{rel.rsplit('/', 1)[0]}/{name}" for rel in gone for name in siblings]
    got = _ensure(gone + [rel for rel in more if evicted(rel, files)], files)[0]
    return disk + [got[rel] for rel in gone if rel in got]


# The event log -----------------------------------------------------------------------------------------------
def event_log() -> bytes:
    """The whole event log: the disk's file in local mode; linked, sikstack's record (fetched into the cache every
    time: it grows with every command) and then this disk's lines not yet sent (past the base's offset)."""
    path = ROOT / EVENTS_REL
    try:
        local = path.read_bytes()
    except OSError:
        local = b""
    if not linked():
        return local
    entry = base_files().get(EVENTS_REL)
    cloud = _fetch([EVENTS_REL]).get(EVENTS_REL)
    if cloud is None:  # sikstack holds no log yet (or the hook's lenient read): the disk's is all there is
        cached = CACHE / EVENTS_REL
        cloud = cached.read_bytes() if LENIENT and cached.is_file() else b""
        if not cloud:
            return local
    else:
        keep(EVENTS_REL, cloud)
    offset = entry.get("offset") if isinstance(entry, dict) else None
    if not (isinstance(offset, int) and 0 <= offset <= len(local) and _sha(local[:offset]) == entry.get("sha256")):
        offset = len(local) if not isinstance(entry, dict) else 0
    return cloud + local[offset:]


def all_events(counts=None) -> list:
    """`wf_store.all_events` through the layer: the whole log in file order (sikstack's first, in a linked
    checkout). `counts["skipped"]` gets the number of unreadable lines."""
    if not linked():
        return wf_store.all_events(counts)
    events, skipped = [], 0
    for line in event_log().decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            skipped += 1
            continue
        if isinstance(obj, dict):
            events.append(obj)
    if counts is not None:
        counts["skipped"] = skipped
    return events


# sikstack cold ------------------------------------------------------------------------------------------------
def _target_rel(raw: str) -> str:
    text = raw.strip().replace("\\", "/")
    for lead in ("./", ".sikstack/"):
        while text.startswith(lead):
            text = text[len(lead):]
    return text.rstrip("/")


def _phase_target(text: str):
    """The stored phase id `text` names (any brief form), or None when it names no phase this workspace sees."""
    static = brief_id("P", text)
    if static is None:
        return None
    number = id_number(static)
    if number and number[1] is None:
        found, tailed = lookup_id_number("P", number[0])
        if found is None and tailed:
            raise SystemExit(f"cold fetch: {text} names {len(tailed)} phases ({', '.join(tailed)}): type the tail")
        return found
    return static if (ACTIVE / static).is_dir() or static in visible_ids("P") else None


def _doc_index() -> dict:
    path = paths(["docs/index.json"]).get("docs/index.json")
    try:
        data = read_json(path) if path is not None else {}
    except (OSError, ValueError):
        data = {}
    docs = data.get("docs") if isinstance(data, dict) else None
    return docs if isinstance(docs, dict) else {}


def _doc_target(text: str):
    """The docs/versions/ file `doc[@version]` names: through docs/index.json (fetched first when it is evicted),
    else the doc's folder; no version is the latest. None when the doc has no version anywhere."""
    doc, _, version = text.partition("@")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", doc):
        return None
    entry = _doc_index().get(doc)
    found = []
    if isinstance(entry, dict) and isinstance(entry.get("versions"), list):
        found = [(v["id"], v["path"]) for v in entry["versions"]
                 if isinstance(v, dict) and isinstance(v.get("id"), str) and isinstance(v.get("path"), str)]
    if not found:
        prefix = f"docs/versions/{doc}/"
        rels = {r for r in base_files() if r.startswith(prefix)} if linked() else set()
        folder_path = ROOT / prefix
        rels |= {f"{prefix}{p.name}" for p in folder_path.iterdir() if p.is_file()} if folder_path.is_dir() else set()
        found = sorted((Path(r).stem, r) for r in rels if "/" not in r[len(prefix):])
    if not found:
        return None
    if not version:
        latest = entry.get("latest") if isinstance(entry, dict) else None
        return next((p for i, p in found if i == latest), found[-1][1])
    exact = [p for i, p in found if i == version]
    if exact:
        return exact[0]
    near = [(i, p) for i, p in found if i.startswith(version)]
    if len(near) == 1:
        return near[0][1]
    if near:
        raise SystemExit(f"cold fetch: {text} names {len(near)} versions of {doc} ({', '.join(i for i, _ in near)}): type more of it")
    raise SystemExit(f"cold fetch: {doc} has no version {version} (its versions: {', '.join(i for i, _ in found)})")


def _fetch_rel(rel: str) -> tuple:
    """(path to print, line) for a truth path or folder: on disk when nothing of it is evicted, else the cache."""
    if not linked():
        path = ROOT / rel
        if not path.exists():
            raise SystemExit(f"cold fetch: {rel} is not on disk (local mode: every record is on disk)")
        return path, "cold fetch: on disk (local mode: every record is on disk; nothing was copied)"
    files = base_files()
    held = sorted(r for r in files if (r == rel or r.startswith(rel + "/")) and _held(r, files))
    gone = [r for r in held if not (ROOT / r).is_file()]
    if not gone:
        path = ROOT / rel
        if not path.exists():
            raise SystemExit(f"cold fetch: {rel} names no record on disk or in sikstack")
        return path, "cold fetch: on disk (nothing of it is held only in sikstack; nothing was copied)"
    fetched, cached = _materialize(held, files, prune=rel if rel not in held else None)
    copied = len(held) - fetched - cached
    return CACHE / rel, (f"cold fetch: {len(held)} file(s) under .sikstack/{CACHE_DIR}/, read-only, sha-checked against "
                         f"the base ({fetched} fetched from sikstack, {cached} already cached"
                         + (f", {copied} copied from disk" if copied else "") + ")")


def cmd_cold_fetch(args: argparse.Namespace) -> None:
    """`cold fetch <P | doc[@version] | path>`: where to read a record; linked, a read-only copy in the cache."""
    text = args.target.strip()
    if not text:
        raise SystemExit("cold fetch: name a phase, doc[@version] or a path under works/ or docs/")
    rel = None
    if "/" not in text and "@" not in text:
        phase = _phase_target(text)
        if phase is not None:
            if (ACTIVE / phase).is_dir():
                print(ACTIVE / phase)
                print("cold fetch: on disk (an active phase; nothing was copied)")
                return
            rel = archived_phase_dir(phase)
            if rel is None:
                raise SystemExit(f"cold fetch: {phase} has no archive folder on disk or in sikstack")
    if rel is None and "/" not in text:
        rel = _doc_target(text)
        if rel is None and "@" in text:
            raise SystemExit(f"cold fetch: {text.partition('@')[0]} is no doc with versions (docs/index.json, docs/versions/)")
    if rel is None:
        rel = _target_rel(text)
        if not rel.startswith(("works/", "docs/")) or any(p in ("", ".", "..") for p in rel.split("/")):
            raise SystemExit(f"cold fetch: {text!r} names no phase, doc or path under works/ or docs/")
    path, line = _fetch_rel(rel)
    print(path)
    print(line)


def _search_snippet(line: str, needle: str) -> str:
    text = line.strip()
    if len(text) <= SEARCH_SNIPPET:
        return text
    at = max(text.casefold().find(needle), 0)
    start = max(0, min(at - (SEARCH_SNIPPET - len(needle)) // 2, len(text) - SEARCH_SNIPPET))
    return text[start:start + SEARCH_SNIPPET]


def _search_disk(query: str, prefix: str, limit: int) -> tuple:
    """Local mode's search, by sikstack's rules: the truth set on disk under `prefix`, by path then line,
    casefolded substring, binary files skipped. (hits, truncated)."""
    needle, hits = query.casefold(), []
    rels = []
    for top in ("works", "docs"):
        for dirpath, dirnames, filenames in os.walk(str(ROOT / top)):
            here = Path(dirpath)
            if _cloud_ignored_dir(here):
                dirnames[:] = []
                continue
            for name in filenames:
                rel = (here / name).relative_to(ROOT).as_posix()
                if cloud_truth_rel(rel) and rel.startswith(prefix):
                    rels.append(rel)
    for rel in sorted(rels):
        try:
            data = (ROOT / rel).read_bytes()
        except OSError:
            continue
        if b"\x00" in data[:SEARCH_PROBE]:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if needle not in text.casefold():
            continue
        for number, line in enumerate(text.split("\n"), start=1):
            if needle in line.casefold():
                hits.append({"path": rel, "line": number, "snippet": _search_snippet(line, needle)})
                if len(hits) > limit:
                    return hits[:limit], True
    return hits, False


def _search_cloud(query: str, prefix: str, limit: int) -> tuple:
    session = getattr(CloudSession, "active", None)
    body = {"query": query, "limit": limit}
    if prefix:
        body["prefix"] = prefix
    try:
        if session is None:
            with CloudLock():
                session = CloudSession(["cold", "search"])
                status, payload = session.link.call("POST", "search", body)
        else:
            status, payload = session.link.call("POST", "search", body)
    except CloudError as exc:
        why = session._unreachable(str(exc)) if session is not None else exc
        raise SystemExit(cloud_stop_line(why, "begin"))
    if status != 200:
        detail = payload.get("detail") or payload.get("error")
        detail = detail if isinstance(detail, str) else ""
        raise SystemExit(f"cold search: sikstack refused the search (HTTP {status}{': ' + detail if detail else ''})")
    hits = [h for h in payload.get("hits") or [] if isinstance(h, dict) and isinstance(h.get("path"), str)]
    return hits, bool(payload.get("truncated"))


def cmd_cold_search(args: argparse.Namespace) -> None:
    """`cold search "<text>"`: sikstack's search route in a linked checkout, the disk by the same rules in local mode."""
    query = args.text.strip()
    if not SEARCH_MIN <= len(query) <= SEARCH_MAX:
        raise SystemExit(f"cold search: the text must be {SEARCH_MIN} to {SEARCH_MAX} characters (spaces at its ends do not count)")
    if args.limit < 1:
        raise SystemExit("cold search: --limit must be 1 or more")
    limit = min(args.limit, SEARCH_LIMIT_MAX)
    prefix = args.prefix.strip()
    if prefix:
        bare = prefix[:-1] if prefix.endswith("/") else prefix
        if prefix.startswith("/") or "\\" in prefix or any(p in ("", ".", "..") for p in bare.split("/")):
            raise SystemExit(f"cold search: --prefix takes a path prefix under the workspace, such as works/phases/archived/ (got {prefix!r})")
    hits, truncated = (_search_cloud if linked() else _search_disk)(query, prefix, limit)
    for hit in hits:
        match = ARCHIVE_FOLDER_ID_RE.search(hit["path"]) if hit["path"].startswith(ARCHIVED_REL) else None
        print(f"{hit['path']}:{hit.get('line')}: " + (f"[{match.group(1)}] " if match else "") + str(hit.get("snippet") or ""))
    if not hits:
        print(f"cold search: no line holds {query!r}" + (f" under {prefix}" if prefix else ""))
    if truncated:
        print(f"truncated: the first {limit} hit(s); narrow it with --prefix or raise --limit (at most {SEARCH_LIMIT_MAX})")


def _cache_count() -> tuple:
    n = size = 0
    for path in CACHE.rglob("*") if CACHE.is_dir() else []:
        if path.is_file():
            n += 1
            size += path.stat().st_size
    return n, size


def _tree_count(folder: Path) -> tuple:
    n = size = 0
    for path in folder.rglob("*"):
        if path.is_file():
            n += 1
            size += path.stat().st_size
    return n, size


def cmd_cold_status(args: argparse.Namespace) -> None:
    """`cold status`: what is cold (by prefix: in sikstack, evicted, on disk), the cache, and what is left on disk
    under a cold prefix that sikstack lacks or holds at other bytes."""
    n, size = _cache_count()
    cache_line = f"cache: {n} file(s), {size} B in .sikstack/{CACHE_DIR}/" + (" (cold clear empties it)" if n else "")
    if not linked():
        print("store=local: every record is on disk, nothing is cold; cold fetch prints a record's own path and "
              "cold search scans the disk")
        if n:
            print(cache_line + ", left from a link")
        return
    files = base_files()
    tops: dict = {}
    for rel in files:
        if _held(rel, files):
            row = tops.setdefault(cloud_cold_top(rel), [0, 0])
            row[0 if not (ROOT / rel).is_file() else 1] += 1
    held = sum(a + b for a, b in tops.values())
    gone = sum(a for a, _ in tops.values())
    print(f"store=cloud cold={held} evicted={gone} on_disk={held - gone}")
    for top in list(CLOUD_COLD_PREFIXES) + [f for f in CLOUD_COLD_FILES if cloud_kind(f) == "file"]:
        a, b = tops.get(top, [0, 0])
        print(f"{top} {a + b} in sikstack: {a} evicted, {b} on disk")
    log = ROOT / EVENTS_REL
    try:
        data = log.read_bytes()
    except OSError:
        data = b""
    entry = files.get(EVENTS_REL) if isinstance(files.get(EVENTS_REL), dict) else {}
    offset = entry.get("offset")
    if not (isinstance(offset, int) and 0 <= offset <= len(data) and _sha(data[:offset]) == entry.get("sha256")):
        offset = 0
    unsent = data[offset:].count(b"\n")
    print(f"{EVENTS_REL}: {unsent} unsent line(s) on disk; the rest is in sikstack")
    print(cache_line)
    left = []  # (rel shown, files, bytes, why)
    for top in CLOUD_COLD_PREFIXES:
        for dirpath, dirnames, filenames in os.walk(str(ROOT / top)):
            here = Path(dirpath)
            if _cloud_ignored_dir(here):
                dirnames[:] = []
                count, total = _tree_count(here)
                left.append((here.relative_to(ROOT).as_posix() + "/", count, total, ".gitignore *: never synced"))
                continue
            dirnames.sort()
            for name in sorted(filenames):
                path = here / name
                rel = path.relative_to(ROOT).as_posix()
                why = _left_why(rel, path, files)
                if why:
                    left.append((rel, 1, path.stat().st_size, why))
    for rel in CLOUD_COLD_FILES:
        path = ROOT / rel
        if cloud_kind(rel) == "file" and path.is_file():
            why = _left_why(rel, path, files)
            if why:
                left.append((rel, 1, path.stat().st_size, why))
    if not left:
        print("left on disk: nothing that sikstack lacks or holds at other bytes")
        return
    print(f"left on disk: {sum(r[1] for r in left)} file(s), {sum(r[2] for r in left)} B that sikstack lacks or holds "
          "at other bytes")
    for rel, count, total, why in sorted(left):
        print(f"  {rel} {count} file(s), {total} B ({why})")


def _left_why(rel: str, path: Path, files: dict):
    if not cloud_truth_rel(rel):
        return "outside the synced set"
    entry = _held(rel, files)
    if entry is None:
        return "not in sikstack"
    if _file_sha(path) != entry["sha256"]:
        return "differs from sikstack"
    return None


def cmd_cold_clear(args: argparse.Namespace) -> None:
    """`cold clear`: empty .sikstack/cache/. The records stay where they are held."""
    n, size = _cache_count()
    if CACHE.exists():
        shutil.rmtree(str(CACHE))
    print(f"cold clear: removed {n} file(s), {size} B from .sikstack/{CACHE_DIR}/" if n else
          f"cold clear: .sikstack/{CACHE_DIR}/ is empty")


def add_cold_parsers(sub) -> None:
    """cold fetch | search | status | clear: this part's command, registered by the entry's build_parser."""
    cold = sub.add_parser("cold", help="Read what a linked checkout keeps only in sikstack (archived phases, doc versions, "
                          "docs/reference, docs/index.json, the event log): fetch, search, status, clear. In local mode "
                          "every record is on disk and these read it there").add_subparsers(dest="verb", required=True).add_parser
    p = cold("fetch", help="Print where to read a record: a phase in any brief form (its whole folder), doc[@version] "
             "(through docs/index.json; no @ is the latest), or a path or folder under works/ or docs/. Linked, what is "
             "held only in sikstack is copied read-only into .sikstack/cache/<its path>, sha-checked against the base; "
             "local mode copies nothing")
    p.add_argument("target", help="P46 / 46 / P46-k2, product or product@v0002, or works/... / docs/...")
    p.set_defaults(func=cmd_cold_fetch)
    p = cold("search", help="Every line holding TEXT (2-200 characters, any case) in the workspace as sikstack holds it, "
             "as path:line: snippet ([P<n>] before an archived phase's snippet), then a truncated line when --limit cut "
             "them. Local mode scans the disk by the same rules")
    p.add_argument("text", help="the text to find")
    p.add_argument("--prefix", default="", help="only paths starting with this, such as works/phases/archived/")
    p.add_argument("--limit", type=int, default=SEARCH_LIMIT, help=f"at most this many hits (default {SEARCH_LIMIT}, "
                   f"at most {SEARCH_LIMIT_MAX})")
    p.set_defaults(func=cmd_cold_search)
    p = cold("status", help="What is cold: the paths sikstack holds by prefix (evicted, on disk), the cache, and what "
             "is left on disk under a cold prefix that sikstack lacks or holds at other bytes (.gitignore * folders too)")
    p.set_defaults(func=cmd_cold_status)
    p = cold("clear", help="Empty .sikstack/cache/; the records stay in sikstack")
    p.set_defaults(func=cmd_cold_clear)
