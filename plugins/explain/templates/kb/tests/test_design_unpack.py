"""The design build upload's unpacking (``server.design.unpack``): no database needed.

Each guard has its test: only files and folders (a symbolic or hard link, a device,
a pipe is refused by name), only clean relative names (absolute, ``../``, an escape
through a folder), nothing written outside the build's folder, an entry named twice,
the file and unpacked-size caps naming the size and the cap, the manifest and its
mark, and which recordings make a build private.
"""

from __future__ import annotations

import gzip
import io
import json
import os
import tarfile
import time
import tracemalloc

import pytest

from server.design import settings
from server.design import unpack as unpack_module
from server.design.unpack import BuildRefused, facts, unpack

MANIFEST = {
    "$design": "sikstack-design-build",
    "source": {"repo": "platform", "commit": "abc123", "branch": "feat/x", "dirty": False},
    "recording": {"file": "design/data/sample/recording.json", "name": "sample"},
    "pages": [{"name": "Home", "entry": "/"}],
}


def _tar(entries: list[tuple[str, object]]) -> io.BytesIO:
    """A tar.gz of ``(name, bytes | TarInfo-maker)`` entries, in order."""

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as archive:
        for name, content in entries:
            if isinstance(content, bytes):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            else:
                info = content(name)  # type: ignore[operator]
                archive.addfile(info)
    buf.seek(0)
    return buf


def _manifest(data: dict | None = None) -> tuple[str, bytes]:
    return "manifest.json", json.dumps(data or MANIFEST).encode()


def _kind(kind: bytes, linkname: str = ""):
    def make(name: str) -> tarfile.TarInfo:
        info = tarfile.TarInfo(name)
        info.type = kind
        info.linkname = linkname
        return info

    return make


@pytest.fixture
def dest(tmp_path):
    folder = tmp_path / "staging" / "one"
    folder.mkdir(parents=True)
    return folder


def _nothing_outside(tmp_path, dest) -> None:
    outside = sorted(p.relative_to(tmp_path).as_posix() for p in tmp_path.rglob("*") if dest not in (p, *p.parents))
    assert outside == ["staging"], outside


def test_a_clean_build_unpacks_with_its_size_file_count_and_manifest(dest):
    got = unpack(
        _tar([("./", _kind(tarfile.DIRTYPE)), _manifest(), ("./index.html", b"<p>hi</p>"), ("_next/a.js", b"x" * 10)]),
        dest,
    )
    assert got.files == 3
    assert got.size == len(json.dumps(MANIFEST)) + 9 + 10
    assert got.manifest["$design"] == "sikstack-design-build"
    assert (dest / "index.html").read_bytes() == b"<p>hi</p>"
    assert (dest / "_next" / "a.js").is_file()


@pytest.mark.parametrize(
    ("entry", "said"),
    [
        (("evil", _kind(tarfile.SYMTYPE, "/etc/passwd")), "a symbolic link"),
        (("evil", _kind(tarfile.SYMTYPE, "index.html")), "a symbolic link"),
        (("evil", _kind(tarfile.LNKTYPE, "index.html")), "a hard link"),
        (("evil", _kind(tarfile.CHRTYPE)), "a device"),
        (("evil", _kind(tarfile.FIFOTYPE)), "a pipe"),
    ],
)
def test_a_link_device_or_pipe_is_refused_by_name(tmp_path, dest, entry, said):
    with pytest.raises(BuildRefused) as refused:
        unpack(_tar([_manifest(), ("index.html", b"ok"), entry]), dest)
    assert said in str(refused.value) and "'evil'" in str(refused.value)
    assert not (dest / "evil").exists()
    _nothing_outside(tmp_path, dest)


@pytest.mark.parametrize(
    "name",
    ["/etc/escape", "../escape", "a/../../escape", "a/../escape", "./../escape", "a\\..\\escape", "a/./b"],
)
def test_an_absolute_or_escaping_name_is_refused_and_nothing_lands_outside(tmp_path, dest, name):
    with pytest.raises(BuildRefused) as refused:
        unpack(_tar([_manifest(), (name, b"pwned")]), dest)
    assert repr(name) in str(refused.value)
    assert not (tmp_path / "escape").exists() and not (tmp_path / "staging" / "escape").exists()
    _nothing_outside(tmp_path, dest)


def test_an_entry_named_twice_or_both_file_and_folder_is_refused(dest, tmp_path):
    with pytest.raises(BuildRefused, match="appears twice"):
        unpack(_tar([_manifest(), ("a.txt", b"1"), ("a.txt", b"2")]), dest)
    other = tmp_path / "staging" / "two"
    other.mkdir()
    with pytest.raises(BuildRefused, match="both a file and a folder"):
        unpack(_tar([_manifest(), ("a", b"1"), ("a/b.txt", b"2")]), other)


def test_the_file_cap_names_the_count_and_the_cap(dest, monkeypatch):
    monkeypatch.setattr(settings, "MAX_FILES", 3)
    unpack(_tar([_manifest(), ("1", b"1"), ("2", b"2")]), dest)  # exactly the cap
    other = dest.parent / "two"
    other.mkdir()
    with pytest.raises(BuildRefused) as refused:
        unpack(_tar([_manifest(), ("1", b"1"), ("2", b"2"), ("3", b"3")]), other)
    assert str(refused.value) == "the build holds more than 3 files: the cap is 3 files"


def test_the_unpacked_cap_names_the_size_and_the_cap(dest, monkeypatch):
    monkeypatch.setattr(settings, "MAX_UNPACKED_BYTES", 1024 * 1024)
    with pytest.raises(BuildRefused) as refused:
        unpack(_tar([_manifest(), ("big.bin", b"\0" * (1024 * 1024 + 1))]), dest)
    message = str(refused.value)
    assert message.startswith("the build unpacks to at least ") and message.endswith("the cap is 1 MB unpacked")
    assert f"{1024 * 1024 + 1 + len(json.dumps(MANIFEST)):,} bytes" in message
    assert refused.value.status == 413
    assert not (dest / "big.bin").exists()


def test_the_real_caps_are_the_decided_ones():
    assert settings.MAX_UPLOAD_BYTES == 16 * 1024 * 1024
    assert settings.MAX_UNPACKED_BYTES == 50 * 1024 * 1024
    assert settings.MAX_FILES == 5000


def test_no_manifest_or_an_unmarked_one_is_refused(dest, tmp_path):
    with pytest.raises(BuildRefused, match="no manifest.json"):
        unpack(_tar([("index.html", b"ok")]), dest)
    other = tmp_path / "staging" / "two"
    other.mkdir()
    with pytest.raises(BuildRefused, match=r"not marked \$design: sikstack-design-build"):
        unpack(_tar([_manifest({"$design": "something-else"}), ("index.html", b"ok")]), other)
    third = tmp_path / "staging" / "three"
    third.mkdir()
    with pytest.raises(BuildRefused, match="not JSON"):
        unpack(_tar([("manifest.json", b"{nope"), ("index.html", b"ok")]), third)


def test_a_body_that_is_not_a_tar_gz_is_refused(dest):
    with pytest.raises(BuildRefused, match="not a readable tar.gz"):
        unpack(io.BytesIO(b"plainly not gzip"), dest)


@pytest.mark.parametrize(
    ("file", "private"),
    [
        ("design/data/local/acme.json", True),
        ("design/data/sample/recording.json", False),
        ("design/data/sample/../local/acme.json", True),
        ("data/local/acme.json", True),
        (None, False),
    ],
)
def test_a_recording_under_design_data_local_makes_the_build_private(file, private):
    manifest = {**MANIFEST, "recording": {"file": file} if file else {}}
    about = facts(manifest)
    assert about.private is private
    assert (about.commit, about.branch, about.dirty) == ("abc123", "feat/x", False)


# -- the tar headers: every byte the unpacker reads is under a cap ----------------------

_MIB = 1024 * 1024


def _raw_tar(*parts: bytes | tuple[bytes, int]) -> io.BytesIO:
    """A tar.gz written block by block: ``bytes`` as is, ``(block, n)`` as ``n`` copies."""

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=1) as gz:
        for part in parts:
            if isinstance(part, tuple):
                block, count = part
                step = max(1, _MIB // len(block))
                for start in range(0, count, step):
                    gz.write(block * min(step, count - start))
            else:
                gz.write(part)
        gz.write(b"\0" * 1024)
    buf.seek(0)
    return buf


def _header(kind: bytes, size: int, name: str = "././@LongLink") -> bytes:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = size
    return info.tobuf(format=tarfile.GNU_FORMAT)


def _member(name: str, data: bytes = b"", kind: bytes = tarfile.REGTYPE) -> bytes:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.size = len(data)
    padding = b"\0" * (-len(data) % tarfile.BLOCKSIZE)
    return info.tobuf(format=tarfile.USTAR_FORMAT) + data + padding


def _pax(records: dict[str, str], kind: bytes = tarfile.XHDTYPE) -> bytes:
    payload = b"".join(_record(key, value) for key, value in records.items())
    return _header(kind, len(payload), "././@PaxHeader") + payload + b"\0" * (-len(payload) % tarfile.BLOCKSIZE)


def _record(key: str, value: str) -> bytes:
    body = f" {key}={value}\n".encode()
    length = len(body) + 1
    while len(str(length)) + len(body) != length:
        length += 1
    return f"{length}{body.decode()}".encode()


def _a_build() -> tuple[bytes, ...]:
    return (_member("manifest.json", json.dumps(MANIFEST).encode()), _member("index.html", b"<p>hi</p>"))


def _peak(run) -> tuple[object, int]:
    """Run ``run()`` and return what it raised (or returned) and the peak bytes it allocated."""

    tracemalloc.start()
    try:
        try:
            got: object = run()
        except Exception as exc:  # noqa: BLE001 - the test reads what was raised
            got = exc
        return got, tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()


@pytest.mark.parametrize(
    ("kind", "said"),
    [
        (tarfile.GNUTYPE_LONGNAME, "a long-name (L) header"),
        (tarfile.GNUTYPE_LONGLINK, "a long-link (K) header"),
        (tarfile.XHDTYPE, "a pax (x) header"),
        (tarfile.XGLTYPE, "a global pax (g) header"),
        (tarfile.SOLARIS_XHDTYPE, "a Solaris pax (X) header"),
    ],
)
def test_an_extended_header_over_the_cap_is_refused_before_it_is_read(dest, kind, said):
    size = 64 * _MIB
    archive = _raw_tar(_header(kind, size), (b"\0" * tarfile.BLOCKSIZE, size // tarfile.BLOCKSIZE), *_a_build())
    got, peak = _peak(lambda: unpack(archive, dest))
    assert isinstance(got, BuildRefused), got
    assert str(got) == f"the archive holds {said} of {size:,} bytes: the cap is 64 KB per tar header"
    assert got.status == 413
    assert peak < 4 * _MIB, f"peak {peak:,} bytes"


def test_an_extended_header_under_the_cap_still_unpacks(dest):
    comment = "c" * (60 * 1024)
    got = unpack(_raw_tar(_pax({"comment": comment}), *_a_build()), dest)
    assert got.files == 2


def test_a_chain_of_extended_headers_is_refused(dest):
    chain = _pax({"comment": "x"})
    archive = _raw_tar((chain, 3000), *_a_build())
    got, _ = _peak(lambda: unpack(archive, dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got) == "the archive has more than 4 extended tar headers before one entry: the cap is 4"


def test_global_pax_headers_over_their_cap_are_refused(dest):
    keys = {f"k{i:05d}": "1" for i in range(600)}
    got, _ = _peak(lambda: unpack(_raw_tar(_pax(keys, tarfile.XGLTYPE), *_a_build()), dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got).startswith("the archive's global pax (g) headers hold ")
    assert str(got).endswith("bytes: the cap is 4 KB for all of them")


def test_pax_records_are_not_kept_for_every_entry(dest):
    folders = []
    for n in range(200):
        records = {f"k{n:03d}.{i:04d}": "1" for i in range(3800)}
        folders.append(_pax(records) + _member(f"d{n:03d}", kind=tarfile.DIRTYPE))
    archive = _raw_tar(*folders, *_a_build())
    got, peak = _peak(lambda: unpack(archive, dest))
    assert not isinstance(got, Exception), repr(got)
    assert peak < 16 * _MIB, f"peak {peak:,} bytes"


def test_the_tar_stream_is_capped_once_uncompressed(dest, monkeypatch):
    monkeypatch.setattr(settings, "MAX_UNPACKED_BYTES", _MIB)
    monkeypatch.setattr(unpack_module, "MAX_TAR_OVERHEAD_BYTES", 64 * 1024)
    folders = [_member(f"d{n:04d}", kind=tarfile.DIRTYPE) for n in range(2500)]
    got, _ = _peak(lambda: unpack(_raw_tar(*_a_build(), *folders), dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got) == (
        "the build's tar stream is over 1.1 MB uncompressed: the cap is 1.1 MB (1 MB of files and 64 KB of tar headers)"
    )
    assert got.status == 413


def test_an_old_gnu_sparse_entry_is_refused_before_its_extension_blocks(dest):
    sparse = tarfile.TarInfo("holes")
    sparse.type = tarfile.GNUTYPE_SPARSE
    head = bytearray(sparse.tobuf(format=tarfile.GNU_FORMAT))
    head[482] = 1  # isextended: extension blocks follow
    head[148:156] = b"%06o\0 " % (sum(head[:148]) + sum(head[156:]) + 8 * 32)
    block = bytearray(b"%011o\0%011o\0" % (1, 1) * 21 + b"\0" * 8)
    block[504] = 1
    got, peak = _peak(lambda: unpack(_raw_tar(bytes(head), (bytes(block), 32 * 1024)), dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got) == "the entry 'holes' is a sparse file: a build holds only files and folders"
    assert peak < 4 * _MIB, f"peak {peak:,} bytes"


def test_a_pax_sparse_map_is_bounded_and_refused_with_one_line(dest):
    pax = _pax({"GNU.sparse.major": "1", "GNU.sparse.minor": "0", "GNU.sparse.name": "holes"})
    data = b"99999999\n" + b"1\n" * (8 * _MIB)
    head = tarfile.TarInfo("holes")
    head.size = len(data)
    archive = _raw_tar(pax, head.tobuf(format=tarfile.USTAR_FORMAT), data, *_a_build())
    got, peak = _peak(lambda: unpack(archive, dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got) == "the archive reads more than 512 KB of tar headers before one entry: the cap is 512 KB"
    assert peak < 8 * _MIB, f"peak {peak:,} bytes"


@pytest.mark.parametrize(
    "records",
    [
        {"GNU.sparse.size": "many"},
        {"GNU.sparse.map": "1,x"},
        {"GNU.sparse.major": "1", "GNU.sparse.minor": "0"},
    ],
)
def test_a_malformed_extended_header_is_one_line_not_a_crash(dest, records):
    archive = _raw_tar(_pax(records), _member("holes", b"not a map"), *_a_build())
    got, _ = _peak(lambda: unpack(archive, dest))
    assert isinstance(got, BuildRefused), repr(got)
    assert str(got) in (
        "the upload is not a readable tar.gz archive",
        "the entry 'holes' is a sparse file: a build holds only files and folders",
    )


@pytest.mark.parametrize("fmt", [tarfile.PAX_FORMAT, tarfile.GNU_FORMAT])
def test_deep_long_names_in_pax_or_gnu_headers_still_unpack(dest, fmt):
    deep = "projects/0b5c8f0e-1a2b-4c3d-9e8f-0123456789ab/workspace/agenda/" + "/".join(["segment"] * 30)
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=fmt) as archive:
        for name, data in [("manifest.json", json.dumps(MANIFEST).encode())] + [
            (f"{deep}/page-{n}.html", b"<p>%d</p>" % n) for n in range(50)
        ]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = 1700000000.5
            archive.addfile(info, io.BytesIO(data))
    buf.seek(0)
    got = unpack(buf, dest)
    assert got.files == 51
    assert (dest / deep / "page-7.html").read_bytes() == b"<p>7</p>"


# -- the staging leftovers ----------------------------------------------------------------


def test_leftovers_of_a_dead_upload_are_swept_by_the_next_one(tmp_path):
    staging = tmp_path / "builds" / ".staging"
    dead, live = "a" * 24, "b" * 24
    for name in (dead, live):
        (staging / name / "_next").mkdir(parents=True)
        (staging / name / "_next" / "a.js").write_bytes(b"x")
        (staging / f"{name}.tar.gz").write_bytes(b"x")
    (staging / "keep-me").mkdir()
    long_ago = time.time() - 2 * 3600
    for path in (staging / dead, staging / dead / "_next", staging / f"{dead}.tar.gz"):
        os.utime(path, (long_ago, long_ago))
    folder = staging / ("c" * 24)
    folder.mkdir()
    unpack(_tar([_manifest(), ("index.html", b"ok")]), folder)
    left = sorted(p.name for p in staging.iterdir())
    assert left == sorted([live, f"{live}.tar.gz", "keep-me", "c" * 24]), left


def test_a_negative_size_from_a_pax_header_is_refused(dest):
    archive = _raw_tar(_pax({"size": "-1"}), _member("neg.bin", b"abc"), *_a_build())
    with pytest.raises(BuildRefused, match="the entry 'neg.bin' has a negative size"):
        unpack(archive, dest)
