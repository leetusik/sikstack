"""Unpack an uploaded build (one ``tar.gz``) into a fresh folder, safely and under the caps.

The archive is read as a stream and every entry is checked before a byte of it is
written:

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

**Every byte read is under a cap too, headers included.** ``tarfile`` reads a GNU
long-name or long-link (``L``, ``K``) or a pax (``x``, ``g``, ``X``) header's whole
declared size into memory before it yields the entry it describes
(``TarInfo._proc_gnulong``, ``_proc_pax``), and a GNU sparse entry's extension
blocks or a pax sparse map block by block until they end (``_proc_sparse``,
``_proc_gnusparse_10``). So the gzip is opened here and read through ``_Bounded``,
and each 512-byte header is checked by ``_proc_member`` (the hook ``tarfile`` names
for a subclass) before ``tarfile`` reads what it declares:

- each extended header declares at most ``MAX_HEADER_BYTES``; all the global (``g``)
  ones together at most ``MAX_GLOBAL_HEADER_BYTES``, since every entry copies them;
  at most ``MAX_HEADER_CHAIN`` extended headers precede one entry; a GNU sparse
  (``S``) entry is refused before its extension blocks;
- at most ``MAX_HEADER_SPAN`` bytes are read between two entries (headers, padding, a
  pax sparse map);
- the uncompressed tar stream is at most ``MAX_UNPACKED_BYTES`` plus
  ``MAX_TAR_OVERHEAD_BYTES``, which bounds the decompression whatever the ratio;
- an entry's pax records are dropped once it is read, so ``tarfile``'s list of the
  entries read keeps no header text, and a malformed header is one refusal line.

Then the folder must hold ``manifest.json`` marked ``$design: sikstack-design-build``.
Any refusal raises ``BuildRefused`` with one line; the caller removes the folder.
An upload into ``.staging/<random>/`` first sweeps what dead uploads left beside it
(``sweep_staging``): the folders and ``.tar.gz`` files of a process that was killed.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import posixpath
import re
import shutil
import stat
import tarfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from server.design import settings

_CHUNK = 1024 * 1024
_KIB = 1024

logger = logging.getLogger(__name__)

#: One extended header (``L``, ``K``, ``x``, ``g``, ``X``): a name or a link is at
#: most ``MAX_PATH_CHARS`` and a build's pax records are a few hundred bytes.
MAX_HEADER_BYTES = 64 * _KIB
#: All global (``g``) headers together: ``tarfile`` copies them into every entry.
MAX_GLOBAL_HEADER_BYTES = 4 * _KIB
#: Extended headers before one entry (``g``, ``L``, ``K``, ``x`` at most, in practice one).
MAX_HEADER_CHAIN = 4
#: The bytes read between two entries: their headers, padding, a pax sparse map.
MAX_HEADER_SPAN = 512 * _KIB
#: The tar stream beyond the files' own bytes: 512 per header, a pax record per entry
#: (a float mtime), up to 511 of padding per file, for ``MAX_ENTRIES`` entries.
MAX_TAR_OVERHEAD_BYTES = 64 * 1024 * 1024
#: A staged upload older than this, or than this process, is a dead upload's.
STALE_SECONDS = 60 * 60

_STAGING = ".staging"  # store.STAGING; this module imports no database code
_STAGED = re.compile(r"([0-9a-f]{24})(\.tar\.gz)?")
_STARTED = time.time()
_EXTENDED = {
    tarfile.GNUTYPE_LONGNAME: "a long-name (L) header",
    tarfile.GNUTYPE_LONGLINK: "a long-link (K) header",
    tarfile.XHDTYPE: "a pax (x) header",
    tarfile.XGLTYPE: "a global pax (g) header",
    tarfile.SOLARIS_XHDTYPE: "a Solaris pax (X) header",
}
_UNREADABLE = "the upload is not a readable tar.gz archive"


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


def _size(value: int) -> str:
    """``64 KB`` under a MiB, else ``mb()``."""

    return f"{value // _KIB} KB" if value < 1024 * 1024 and value % _KIB == 0 else mb(value)


class _Bounded:
    """The uncompressed tar stream, read through the stream cap and the span between entries."""

    def __init__(self, raw: IO[bytes], limit: int) -> None:
        self._raw = raw
        self._limit = limit
        self.count = 0
        self._span_from: int | None = 0

    def read(self, size: int | None = -1) -> bytes:
        size = _CHUNK if size is None or size < 0 else min(size, _CHUNK)
        chunk = self._raw.read(size)
        self.count += len(chunk)
        if self.count > self._limit:
            files, limit = settings.MAX_UNPACKED_BYTES, self._limit
            raise BuildRefused(
                f"the build's tar stream is over {mb(limit)} uncompressed: the cap is {mb(limit)} "
                f"({mb(files)} of files and {_size(limit - files)} of tar headers)",
                status=413,
            )
        if self._span_from is not None and self.count - self._span_from > MAX_HEADER_SPAN:
            raise BuildRefused(
                f"the archive reads more than {_size(MAX_HEADER_SPAN)} of tar headers before one entry: "
                f"the cap is {_size(MAX_HEADER_SPAN)}",
                status=413,
            )
        return chunk

    def headers(self) -> None:
        """From here to the next entry, only headers and padding: under the span."""

        self._span_from = self.count

    def data(self) -> None:
        """An entry's data follows, under the unpacked cap."""

        self._span_from = None


class _Headers:
    """Each 512-byte header, checked before ``tarfile`` reads what it declares."""

    def __init__(self) -> None:
        self.chain = 0
        self.global_bytes = 0

    def check(self, info: tarfile.TarInfo) -> None:
        kind = _EXTENDED.get(info.type)
        if kind is None:
            self.chain = 0
            if info.type == tarfile.GNUTYPE_SPARSE:
                raise BuildRefused(f"the entry {info.name!r} is a sparse file: a build holds only files and folders")
            return
        self.chain += 1
        if self.chain > MAX_HEADER_CHAIN:
            raise BuildRefused(
                f"the archive has more than {MAX_HEADER_CHAIN} extended tar headers before one entry: "
                f"the cap is {MAX_HEADER_CHAIN}"
            )
        if info.size > MAX_HEADER_BYTES:
            raise BuildRefused(
                f"the archive holds {kind} of {info.size:,} bytes: the cap is {_size(MAX_HEADER_BYTES)} per tar header",
                status=413,
            )
        if info.type == tarfile.XGLTYPE:
            self.global_bytes += info.size
            if self.global_bytes > MAX_GLOBAL_HEADER_BYTES:
                raise BuildRefused(
                    f"the archive's global pax (g) headers hold {self.global_bytes:,} bytes: "
                    f"the cap is {_size(MAX_GLOBAL_HEADER_BYTES)} for all of them",
                    status=413,
                )

    def info_class(self) -> type[tarfile.TarInfo]:
        headers = self

        class _CheckedInfo(tarfile.TarInfo):
            def _proc_member(self, archive: tarfile.TarFile) -> tarfile.TarInfo:
                headers.check(self)
                return super()._proc_member(archive)  # type: ignore[misc]

        return _CheckedInfo


def _next(members: Any) -> tarfile.TarInfo | None:
    """The next entry; a malformed header ``tarfile`` trips on is one refusal line."""

    try:
        return next(members, None)
    except BuildRefused:
        raise
    except ValueError:
        raise BuildRefused(_UNREADABLE) from None


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
    if root.parent.name == _STAGING:
        sweep_staging(root.parent, keep=root.name)
    total = 0
    files = 0
    entries = 0
    try:
        tar = _Bounded(gzip.GzipFile(fileobj=stream, mode="rb"), settings.MAX_UNPACKED_BYTES + MAX_TAR_OVERHEAD_BYTES)
        try:
            archive = tarfile.open(fileobj=tar, mode="r|", tarinfo=_Headers().info_class())
        except BuildRefused:
            raise
        except ValueError:
            raise BuildRefused(_UNREADABLE) from None
        with archive:
            members = iter(archive)
            while (member := _next(members)) is not None:
                member.pax_headers = {}
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
                    tar.headers()
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
                    tar.headers()
                    continue
                files += 1
                if files > settings.MAX_FILES:
                    raise BuildRefused(
                        f"the build holds more than {settings.MAX_FILES:,} files: the cap is {settings.MAX_FILES:,} files"
                    )
                if member.size < 0:
                    raise BuildRefused(f"the entry {member.name!r} has a negative size")
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
                tar.data()
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
                tar.headers()
    except BuildRefused:
        raise
    except (tarfile.TarError, zlib.error, EOFError, gzip.BadGzipFile):
        raise BuildRefused(_UNREADABLE) from None
    if files == 0:
        raise BuildRefused("the archive holds no files")
    return Unpacked(size=total, files=files, manifest=_manifest(root))


def sweep_staging(staging: Path, keep: str = "") -> list[str]:
    """Remove the folders and ``.tar.gz`` files dead uploads left in ``staging``; their names.

    A staged upload is a ``<24 hex>/`` folder and its ``<24 hex>.tar.gz``, taken
    together. It is a dead upload's when both are older than this process (the API
    runs one worker, so an older one was a killed process's) or than
    ``STALE_SECONDS``. ``keep`` (the caller's own) and any other name are left alone;
    a failure is logged, never raised.
    """

    cutoff = max(_STARTED, time.time() - STALE_SECONDS)
    newest: dict[str, float] = {}
    kinds: dict[str, list[tuple[str, bool]]] = {}
    try:
        names = os.listdir(staging)
    except OSError:
        return []
    for name in names:
        match = _STAGED.fullmatch(name)
        if not match or match.group(1) == keep:
            continue
        try:
            info = os.lstat(staging / name)
        except OSError:
            continue
        stem = match.group(1)
        newest[stem] = max(newest.get(stem, 0.0), info.st_mtime)
        kinds.setdefault(stem, []).append((name, stat.S_ISDIR(info.st_mode)))
    swept: list[str] = []
    for stem, when in newest.items():
        if when >= cutoff:
            continue
        for name, is_dir in kinds[stem]:
            try:
                if is_dir:
                    shutil.rmtree(staging / name)
                else:
                    os.unlink(staging / name)
            except OSError:
                logger.warning("design: could not sweep %s", staging / name, exc_info=True)
                continue
            swept.append(name)
    if swept:
        logger.info("design: swept %d staged leftover(s) of dead uploads", len(swept))
    return sorted(swept)


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
