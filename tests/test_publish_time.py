"""Each version's own publish time (P63, D171-qk).

A publish stamps ``published: "<UTC time>"`` into the version's header, the archive
keeps it with the body, and reindex re-derives it from the file alone (never from a
file time), so it survives a rebuild from an empty store over a copy whose file times
are new. A file without the line reads exactly as before. (The one-time fill that gave
older versions a best-effort time ran once and left with the git publish.)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db, documents, reindex
from server.native import parse_chapter

_REL = "alpha/2026-07-02-one.md"
_ARCHIVE_V1 = ".versions/alpha/2026-07-02-one/v0001.md"
_PAYLOAD = {
    "title": "One",
    "markdown": "# One\n\nFirst edition.\n",
    "project": "alpha",
    "tags": ["t", "u"],
    "source_repo": "repo",
    "date": "2026-07-02",
    "slug": "one",
}
_T1 = "2026-11-01T10:00:00Z"
_T2 = "2026-11-05T12:30:45Z"


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    )


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "index.md").write_text("# KB\n\n<!-- explain:recent -->\n")
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "kb-test")
    _git(tmp_path, "config", "user.email", "kb-test@example.com")
    _git(tmp_path, "add", "docs/index.md")
    _git(tmp_path, "commit", "-m", "seed")
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    stamps = iter([_T1, _T2])
    monkeypatch.setattr("server.documents.now_stamp", lambda: next(stamps))
    from server.main import app

    return TestClient(app), tmp_path


def _age(root: Path) -> None:
    """Give every file a fresh time, as a clone or a plain copy does."""
    now = time.time() + 3600
    for path in root.rglob("*"):
        if path.is_file():
            os.utime(path, (now, now))


def _times(conn, rel=_REL):
    doc = db.get_document_by_path(conn, rel)
    rows = db.list_document_versions(conn, rel)
    return (
        (doc["published"], doc["published_best_effort"]),
        {r["version"]: (r["published"], r["published_best_effort"]) for r in rows},
    )


def test_a_version_carries_its_own_time_through_reindex_and_a_rebuild(client, tmp_path):
    tc, root = client
    first = tc.post("/api/documents", json=_PAYLOAD)
    assert first.status_code == 201, first.text
    assert f'published: "{_T1}"\n' in (root / "docs" / _REL).read_text()
    got = tc.get(f"/api/documents/by-path/{_REL}").json()
    assert (got["published"], got["published_best_effort"]) == (_T1, False)

    second = tc.post(
        "/api/documents",
        json={**_PAYLOAD, "new_version": True, "markdown": "# One\n\nSecond edition.\n"},
    )
    assert second.status_code == 201, second.text
    assert f'published: "{_T2}"\n' in (root / "docs" / _REL).read_text()
    # The archived v1 keeps v1's own time, in its header and in the version read.
    assert f'published: "{_T1}"\n' in (root / "docs" / _ARCHIVE_V1).read_text()
    page = tc.get(f"/api/documents/by-path/{_REL}/versions").json()
    assert [(v["version"], v["published"], v["published_best_effort"])
            for v in page["versions"]] == [(1, _T1, False)]
    assert tc.get(f"/api/documents/by-path/{_REL}").json()["published"] == _T2
    # Nothing is committed (no git publish): HEAD is still the seed.
    assert _git(root, "rev-list", "--count", "HEAD").stdout.strip() == "1"

    # A reindex in place, then a rebuild from an empty store over a copy whose file
    # times are all new: the times come from the headers, never from the files.
    conn = db.connect()
    try:
        reindex.reindex(conn=conn)
        assert _times(conn) == ((_T2, False), {1: (_T1, False)})
    finally:
        conn.close()
    copy = tmp_path / "copy"
    shutil.copytree(root / "docs", copy / "docs", copy_function=shutil.copyfile)
    _age(copy)
    fresh = db.connect(tmp_path / "fresh.sqlite3")
    try:
        reindex.reindex(conn=fresh, docs_root=copy / "docs")
        assert _times(fresh) == ((_T2, False), {1: (_T1, False)})
    finally:
        fresh.close()


def _write(path: Path, text: str, mtime: float | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def _md(title: str, date: str, body: str, version: int = 1, extra: str = "") -> str:
    v = f"version: {version}\n" if version >= 2 else ""
    return (
        f'---\ntitle: "{title}"\ndate: {date}\n{v}{extra}tags:\n  - t\n'
        f"source:\n  project: alpha\n  repo: r\n---\n\n{body}"
    )


def test_a_file_without_the_stamp_reads_as_before(tmp_path):
    docs = tmp_path / "docs"
    _write(docs / "alpha/2026-07-02-one.md", _md("One", "2026-07-02", "# One\n\nNow.\n", 2))
    _write(docs / _ARCHIVE_V1, _md("One", "2026-07-02", "# One\n\nThen.\n", 1), 1_700_000_000)
    conn = db.connect(tmp_path / "kb.sqlite3")
    try:
        report = reindex.reindex(conn=conn, docs_root=docs)
        assert report["skipped"] == []
        assert _times(conn) == ((None, False), {1: (None, False)})
        # The archive time still comes from the file, exactly as before P63.
        (row,) = db.list_document_versions(conn, _REL)
        assert row["created_at"].startswith("2023-11-1")
    finally:
        conn.close()


def test_a_malformed_stamp_is_no_time_and_never_skips_the_file(tmp_path):
    docs = tmp_path / "docs"
    _write(docs / _REL, _md("One", "2026-07-02", "# One\n", extra="published: soon\n"))
    conn = db.connect(tmp_path / "kb.sqlite3")
    try:
        assert reindex.reindex(conn=conn, docs_root=docs)["skipped"] == []
        assert _times(conn)[0] == (None, False)
    finally:
        conn.close()


def test_the_published_line_forms_parse():
    assert documents.parse_published(_T1) == (_T1, False)
    assert documents.parse_published({"at": "2026-07-02", "best_effort": True}) == (
        "2026-07-02", True,
    )
    assert documents.parse_published("2026-11-01T19:00:00+09:00") == (_T1, False)
    assert documents.parse_published("later") is None
    assert documents.parse_published({"best_effort": True}) is None


def test_a_native_header_takes_both_forms():
    content, _offset = documents.native_file_content(
        title="N", date="2026-07-02", tags=[], project="alpha", source_repo="r",
        body="Text.\n", published=_T1,
    )
    parsed = parse_chapter(content)
    assert f'published: "{_T1}"' in parsed.source
    filled = documents.set_frontmatter_published(
        content.replace(f'published: "{_T1}"\n', ""), "2026-07-02", best_effort=True
    )
    assert '"best_effort": true' in parse_chapter(filled).source
