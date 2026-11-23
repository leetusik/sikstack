"""The design build upload's unpacking (``server.design.unpack``): no database needed.

Each guard has its test: only files and folders (a symbolic or hard link, a device,
a pipe is refused by name), only clean relative names (absolute, ``../``, an escape
through a folder), nothing written outside the build's folder, an entry named twice,
the file and unpacked-size caps naming the size and the cap, the manifest and its
mark, and which recordings make a build private.
"""

from __future__ import annotations

import io
import json
import tarfile

import pytest

from server.design import settings
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
