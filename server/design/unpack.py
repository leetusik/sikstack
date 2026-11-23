"""Unpack an uploaded build (one ``tar.gz``) into a fresh folder, safely and under the caps.

The archive is read as a stream (``r|gz``) and every entry is checked before a byte
of it is written:

- **Only regular files and folders.** A symbolic or hard link, a device, a pipe or a
  sparse file is refused, by name.
- **Clean relative names.** An absolute name, a ``..`` part, a backslash, a NUL or a
  control character, or a name over ``MAX_PATH_CHARS``, is refused; a leading ``./``
  is dropped. ``tarfile.data_filter`` then runs on the entry as a second check.
- **The caps,** each refusal naming the size and the cap: at most ``MAX_FILES`` files,
  ``MAX_UNPACKED_BYTES`` unpacked (counted from each entry's header before it is
  written, and from the bytes written), ``MAX_ENTRIES`` entries of any kind.
- **Nothing outside the folder.** Files are opened ``O_CREAT | O_EXCL | O_NOFOLLOW``
  under the folder, whose own subfolders this code made, so an entry named twice is
  refused and no write follows a link.

Then the folder must hold ``manifest.json`` marked ``$design: sikstack-design-build``.
Any refusal raises ``BuildRefused`` with one line; the caller removes the folder.
"""

from __future__ import annotations

import gzip
import json
import os
import posixpath
import stat
import tarfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from server.design import settings

_CHUNK = 1024 * 1024


class BuildRefused(ValueError):
    """An upload this server will not store; ``str()`` is the one line to show."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True, slots=True)
class Unpacked:
    """What the folder holds: its byte total, its file count and its parsed manifest."""

    size: int
    files: int
    manifest: dict[str, Any]


def mb(value: int) -> str:
    """``16 MB`` for a whole number of MiB, else one decimal (``16.2 MB``)."""

    whole = value / (1024 * 1024)
    return f"{whole:.0f} MB" if value % (1024 * 1024) == 0 else f"{whole:.1f} MB"


def _clean_name(raw: str) -> str | None:
    """The entry's clean relative name (``None`` for the root itself), or a refusal."""

    if len(raw) > settings.MAX_PATH_CHARS:
        raise BuildRefused(f"the entry {raw[:80]!r}... has a name over {settings.MAX_PATH_CHARS} characters")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in raw) or "\\" in raw:
        raise BuildRefused(f"the entry {raw!r} has a backslash or a control character in its name")
    if raw.startswith("/"):
        raise BuildRefused(f"the entry {raw!r} has an absolute name")
    name = raw
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    if name in ("", "."):
        return None
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise BuildRefused(f"the entry {raw!r} leaves its folder or is not a clean relative name")
    return name


def _kind(member: tarfile.TarInfo) -> str:
    if member.issym():
        return "a symbolic link"
    if member.islnk():
        return "a hard link"
    if member.ischr() or member.isblk():
        return "a device"
    if member.isfifo():
        return "a pipe"
    if member.issparse():
        return "a sparse file"
    return "a special entry"


def _inside(root: Path, target: Path) -> None:
    resolved = target.resolve()
    if resolved != root and not resolved.is_relative_to(root):
        raise BuildRefused(f"the entry {target.name!r} would land outside the build's folder")


def _mkdir(folder: Path, name: str) -> None:
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except (FileExistsError, NotADirectoryError):
        raise BuildRefused(f"the entry {name!r} is both a file and a folder") from None


def unpack(stream: IO[bytes], dest: Path) -> Unpacked:
    """Unpack the ``tar.gz`` read from ``stream`` into ``dest`` (an empty folder)."""

    root = dest.resolve()
    total = 0
    files = 0
    entries = 0
    try:
        with tarfile.open(fileobj=stream, mode="r|gz") as archive:
            for member in archive:
                entries += 1
                if entries > settings.MAX_ENTRIES:
                    raise BuildRefused(
                        f"the build holds more than {settings.MAX_ENTRIES:,} entries: the cap is {settings.MAX_ENTRIES:,}"
                    )
                name = _clean_name(member.name)
                if not (member.isreg() or member.isdir()) or member.issparse():
                    raise BuildRefused(f"the entry {member.name!r} is {_kind(member)}: a build holds only files and folders")
                if name is None:
                    if member.isreg():
                        raise BuildRefused("the archive's root is a file, not a folder")
                    continue
                try:
                    tarfile.data_filter(member, str(root))
                except tarfile.FilterError as exc:
                    raise BuildRefused(f"the entry {member.name!r} is refused: {exc}") from None
                except (NotADirectoryError, FileExistsError):
                    raise BuildRefused(f"the entry {member.name!r} is both a file and a folder") from None
                target = root / name
                _inside(root, target.parent)
                if member.isdir():
                    if target.exists() and not target.is_dir():
                        raise BuildRefused(f"the entry {member.name!r} is both a file and a folder")
                    _mkdir(target, member.name)
                    continue
                files += 1
                if files > settings.MAX_FILES:
                    raise BuildRefused(
                        f"the build holds more than {settings.MAX_FILES:,} files: the cap is {settings.MAX_FILES:,} files"
                    )
                if total + member.size > settings.MAX_UNPACKED_BYTES:
                    raise BuildRefused(
                        f"the build unpacks to at least {total + member.size:,} bytes "
                        f"({mb(total + member.size)}): the cap is {mb(settings.MAX_UNPACKED_BYTES)} unpacked",
                        status=413,
                    )
                _mkdir(target.parent, member.name)
                _inside(root, target.parent)
                source = archive.extractfile(member)
                if source is None:  # pragma: no cover - isreg() members always have data
                    raise BuildRefused(f"the entry {member.name!r} has no data")
                try:
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                except FileExistsError:
                    raise BuildRefused(f"the entry {member.name!r} appears twice in the archive") from None
                except IsADirectoryError:
                    raise BuildRefused(f"the entry {member.name!r} is both a file and a folder") from None
                with os.fdopen(fd, "wb") as out:
                    while chunk := source.read(_CHUNK):
                        total += len(chunk)
                        if total > settings.MAX_UNPACKED_BYTES:
                            raise BuildRefused(
                                f"the build unpacks to at least {total:,} bytes ({mb(total)}): "
                                f"the cap is {mb(settings.MAX_UNPACKED_BYTES)} unpacked",
                                status=413,
                            )
                        out.write(chunk)
    except BuildRefused:
        raise
    except (tarfile.TarError, zlib.error, EOFError, gzip.BadGzipFile):
        raise BuildRefused("the upload is not a readable tar.gz archive") from None
    if files == 0:
        raise BuildRefused("the archive holds no files")
    return Unpacked(size=total, files=files, manifest=_manifest(root))


def _manifest(root: Path) -> dict[str, Any]:
    path = root / "manifest.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise BuildRefused("the build has no manifest.json at its root: build it with design:build") from None
    if not stat.S_ISREG(info.st_mode):
        raise BuildRefused("the build's manifest.json is not a file")
    if info.st_size > settings.MAX_MANIFEST_BYTES:
        raise BuildRefused(f"the build's manifest.json is over {mb(settings.MAX_MANIFEST_BYTES)}")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BuildRefused("the build's manifest.json is not JSON") from None
    if not isinstance(manifest, dict) or manifest.get("$design") != settings.MANIFEST_MARK:
        raise BuildRefused(
            f"the build's manifest.json is not marked $design: {settings.MANIFEST_MARK}: build it with design:build"
        )
    return manifest


def _text(value: Any, limit: int) -> str | None:
    return value[:limit] if isinstance(value, str) and value.strip() else None


@dataclass(frozen=True, slots=True)
class BuildFacts:
    """What a build's row keeps from its manifest."""

    commit: str | None
    branch: str | None
    dirty: bool | None
    recording: str | None
    private: bool


def facts(manifest: dict[str, Any]) -> BuildFacts:
    """The source commit, branch and dirty flag, the recording file, and whether it is private.

    Private when the recording file sits under ``design/data/local/`` (a real
    project's recording, gitignored), read after normalizing the path.
    """

    source = manifest.get("source") if isinstance(manifest.get("source"), dict) else {}
    recording = manifest.get("recording") if isinstance(manifest.get("recording"), dict) else {}
    dirty = source.get("dirty")
    file = _text(recording.get("file"), 500)
    normalized = posixpath.normpath(file) if file else ""
    private = bool(file) and (
        f"{normalized}/".startswith(settings.PRIVATE_RECORDINGS) or "/data/local/" in f"/{normalized}"
    )
    return BuildFacts(
        commit=_text(source.get("commit"), 64),
        branch=_text(source.get("branch"), 200),
        dirty=dirty if isinstance(dirty, bool) else None,
        recording=file,
        private=private,
    )
