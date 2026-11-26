"""Sections (P75): every document split at its headings, searched and fetched by anchor.

Proved here, with no network (a stub embedder stands in for Gemini):

* the split: native documents at their level-2 and level-3 heading ids (never at an id'd
  code fence or typed block), a lead section for the text before the first heading, a
  typed-block-only section's text from ``_search_block``; md and html by slug anchors,
  or one whole-document section; over the native fixtures the headed count is DECOMP's;
* the rows are derived: a write, a new version and a reindex rebuild them, a delete
  drops them (and their FTS rows), and a v1 -> v2 write keeps every surviving anchor;
* embeddings are keyed by content: a reindex that renumbers every row re-embeds nothing,
  an edited section re-embeds alone, and no key is keyword-only;
* section search: weighted bm25, fused by RRF with the section vectors when a key is
  set; each hit's reader URL ends ``#<anchor>``;
* ``GET /api/sections/search``, ``GET /api/library`` and the single-document read's
  ``anchor``.
"""
from __future__ import annotations

import glob
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import db, embeddings, reindex
from server import search as search_mod
from server import sections

ROOT = Path(__file__).resolve().parent


def _fixtures() -> list[str]:
    files = (
        sorted(glob.glob(str(ROOT / "fixtures/native/*.md")))
        + sorted(glob.glob(str(ROOT / "fixtures/anchors/*.md")))
        + sorted(glob.glob(str(ROOT / "fixtures/book/*.md")))
    )
    return [f for f in files if "/err-" not in f]


def _native(path: str) -> list[sections.Section]:
    return sections.split(format="native", title="T", markdown="", source=Path(path).read_text())


# -- the split -----------------------------------------------------------------------------


def test_native_fixtures_split_at_their_heading_ids():
    files = _fixtures()
    assert len(files) == 22  # the probe's set: 12 native, 3 anchors, 7 book
    secs = {Path(f).name: _native(f) for f in files}
    headed = sum(1 for ss in secs.values() for s in ss if s.anchor)
    # DECOMP's probe: 60 sections at levels 2-3 = 59 headed ones plus prose.md's lead
    # (the only lead its rule, prose containers only, gave text).
    assert headed == 59
    assert [s.anchor for s in secs["prose.md"]] == [
        "", "getting-started", "getting-started-2", "setext-heading-two", "sources-list",
        "s-1", "closing",
    ]
    assert all(s.level in (2, 3) for ss in secs.values() for s in ss if s.anchor)


def test_lead_typed_blocks_and_code_fences():
    # A summary and typed blocks before the first heading make the lead's text.
    graph = _native(str(ROOT / "fixtures/native/diagrams-graph.md"))
    assert [s.anchor for s in graph] == [""] and graph[0].heading == "T"
    assert graph[0].text.strip()  # diagram titles and labels, from _search_block
    # An id'd code fence never starts a section; it stays inside its heading's.
    src = (
        "---\nformat: native\nsyntax: 1\n---\nLead words.\n\n## One {#one}\n\nAlpha.\n\n"
        "```python #snippet\nprint('beta')\n```\n\n### Two {#two}\n\nGamma.\n\n#### Deep {#deep}\n\nDelta.\n"
    )
    secs = sections.split(format="native", title="Doc", markdown="", source=src)
    assert [(s.anchor, s.level) for s in secs] == [("", 0), ("one", 2), ("two", 3)]
    assert secs[0].text == "Lead words." and secs[0].heading == "Doc"
    assert "print('beta')" in secs[1].text
    assert "Delta." in secs[2].text and "Deep" in secs[2].text  # h4 stays inside


def test_md_and_html_anchors():
    md = "# Title\n\nIntro.\n\n## Getting Started\n\nA.\n\n```\n## not a heading\n```\n\n### Next step\n\nB.\n\n## Getting Started\n\nC.\n\n## 검색\n\nD.\n"
    secs = sections.split(format="md", title="T", markdown=md)
    assert [s.anchor for s in secs] == ["", "getting-started", "next-step", "getting-started-2", "s-1"]
    assert "## not a heading" in secs[1].text
    assert [s.anchor for s in sections.split(format="md", title="T", markdown="Just text.")] == [""]
    html = (
        "<html><head><style>.x{}</style></head><body><p>Lead</p><h2 id='own'>Own id</h2>"
        "<p>One</p><script>no()</script><h3>Sub part</h3><p>Two</p></body></html>"
    )
    hs = sections.split(format="html", title="T", markdown="", raw_html=html)
    assert [(s.anchor, s.heading) for s in hs] == [("", "T"), ("own", "Own id"), ("sub-part", "Sub part")]
    assert hs[1].text == "One" and "no()" not in hs[1].text


# -- the rows, through the real write path and reindex --------------------------------------


def _git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    from server.main import app

    return TestClient(app), tmp_path


def _post(tc, **over):
    body = {
        "title": "The write lock", "format": "native", "project": "lab", "tags": ["t", "u"],
        "source_repo": "acme/repo", "date": "2026-10-21", "slug": "write-lock",
        "markdown": Path(ROOT / "fixtures/anchors/chapter-v1.md").read_text().split("---\n", 2)[2],
    }
    body.update(over)
    r = tc.post("/api/documents", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _rows(doc_id):
    conn = db.connect()
    try:
        return sections.list_sections(conn, doc_id)
    finally:
        conn.close()


def test_a_write_and_a_version_rebuild_the_rows_and_keep_anchors(client):
    tc, _ = client
    v1 = _post(tc)
    a1 = [r["anchor"] for r in _rows(v1["id"])]
    assert a1 == ["overview", "fuel", "lenses", "keepers"]
    v2_body = Path(ROOT / "fixtures/anchors/chapter-v2.md").read_text().split("---\n", 2)[2]
    v2 = _post(tc, markdown=v2_body, new_version=True)
    assert v2["id"] == v1["id"]
    a2 = [r["anchor"] for r in _rows(v2["id"])]
    assert set(a1) - {"lenses"} <= set(a2) and "lenses" not in a2

    # Anchor read: one section's text, and a missing anchor is a 404.
    one = tc.get(f"/api/documents/{v1['id']}", params={"anchor": "fuel"}).json()
    assert one["section"]["anchor"] == "fuel" and "markdown" not in one
    by_path = tc.get(f"/api/documents/by-path/{v1['rel_path']}", params={"anchor": "keepers"})
    assert by_path.status_code == 200 and by_path.json()["section"]["heading"]
    assert tc.get(f"/api/documents/{v1['id']}", params={"anchor": "lenses"}).status_code == 404
    assert "markdown" in tc.get(f"/api/documents/{v1['id']}").json()

    # A delete drops the rows and their index entries (the cascade fires the FTS trigger).
    assert tc.delete(f"/api/documents/{v1['id']}").status_code in (200, 204)
    conn = db.connect()
    try:
        assert sections.count(conn) == 0
        n = conn.execute(
            "SELECT COUNT(*) AS n FROM document_sections_fts WHERE document_sections_fts MATCH 'fuel'"
        ).fetchone()["n"]
        assert n == 0
    finally:
        conn.close()


class Stub:
    """A deterministic embedder: a vector per concept word, and a call counter."""

    CONCEPTS = {"semaphore": 0, "mutex": 0, "fuel": 1, "lantern": 1, "oil": 1, "keeper": 2}

    def __init__(self):
        self.calls = 0

    def __call__(self, texts, *, kind, retries=0):
        out = []
        for t in texts:
            self.calls += 1
            v = [0.0, 0.0, 0.0]
            for word, i in self.CONCEPTS.items():
                if word in t.lower():
                    v[i] += 1.0
            out.append(v if sum(v) else [0.01, 0.01, 0.01])
        return out


def _seed_files(root: Path):
    for name in ("chapter-v1.md",):
        text = Path(ROOT / "fixtures/anchors" / name).read_text()
        text = text.replace("---\n", '---\ntitle: "Lanterns"\ndate: 2026-10-01\n', 1)
        dest = root / "docs" / "lab" / "2026-10-01-lanterns.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text)
    md = root / "docs" / "lab" / "2026-10-02-locks.md"
    md.write_text(
        '---\ntitle: "Locks"\ndate: 2026-10-02\ntags: [x]\n---\n\nWhy locks.\n\n'
        "## The mutex\n\nOne writer at a time holds the mutex.\n\n## Waiting\n\nOthers queue.\n"
    )
    return md


def test_reindex_rebuilds_rows_and_embeds_by_content(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    md = _seed_files(tmp_path)

    # No key: rows are built, nothing is embedded.
    r0 = reindex.reindex()
    assert r0["sections"]["skipped_reason"] == "no api key"
    total = r0["sections"]["count"]
    assert total == 4 + 3  # lanterns' four headings; locks' lead + two headings

    monkeypatch.setenv("GOOGLE_API_KEY", "stub-not-a-key")
    stub = Stub()
    monkeypatch.setattr(embeddings, "embed_texts", stub)
    # The document-level vectors (keyed by row id, outside this claim) stay out of the count.
    monkeypatch.setattr(reindex, "_sync_embeddings", lambda conn: {})
    r1 = reindex.reindex()["sections"]
    assert r1["embedded"] == total and stub.calls == total  # one call per section

    # Renumber every row: wipe the documents (sections cascade) and reindex. The vectors
    # are keyed by content, so nothing is embedded again.
    conn = db.connect()
    before = {r["id"] for r in conn.execute("SELECT id FROM document_sections")}
    docs_before = {r["id"] for r in conn.execute("SELECT id FROM documents")}
    conn.execute("DELETE FROM documents")
    # A placeholder at a high id pushes every re-inserted document past it; the reindex
    # drops it again (its file is not on disk).
    conn.execute(
        "INSERT INTO documents (id, project, slug, date, title, rel_path, markdown, "
        "created_at, updated_at) VALUES (1000, 'lab', 'gone', '2026-01-01', 'Gone', "
        "'lab/2026-01-01-gone.md', 'gone', 'x', 'x')"
    )
    conn.commit()
    conn.close()
    stub.calls = 0
    r2 = reindex.reindex()["sections"]
    conn = db.connect()
    after = {r["id"] for r in conn.execute("SELECT id FROM document_sections")}
    docs_after = {r["id"] for r in conn.execute("SELECT id FROM documents")}
    conn.close()
    assert after and not (after & before)  # every section row renumbered
    assert docs_after and min(docs_after) > 1000 and not (docs_after & docs_before)
    assert (r2["embedded"], stub.calls, r2["cached"], r2["removed"]) == (0, 0, total, 0)

    # Edit one section: it alone re-embeds; its old vector is collected.
    md.write_text(md.read_text().replace("Others queue.", "Others queue and wait."))
    stub.calls = 0
    r3 = reindex.reindex()["sections"]
    assert (r3["embedded"], stub.calls, r3["removed"]) == (1, 1, 1)


def _viewer():
    return sections.Viewer(member=True, org="acme")


def test_section_search_keyword_and_hybrid(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    _seed_files(tmp_path)
    reindex.reindex()
    conn = db.connect()
    try:
        kw = search_mod.search_sections(conn, "mutex", tenant="", limit=5, viewer=_viewer())
        assert kw["mode"] == "bm25"
        top = kw["results"][0]
        assert top["anchor"] == "the-mutex" and top["heading"] == "The mutex"
        assert top["document"]["rel_path"] == "lab/2026-10-02-locks.md"
        assert top["url"].endswith("/@acme/lab/locks#the-mutex")
        assert "<mark>" in top["snippet"]
        # Weighted: a heading hit outranks a text-only hit.
        both = search_mod.search_sections(conn, "waiting", tenant="", limit=5, viewer=_viewer())
        assert both["results"][0]["anchor"] == "waiting"
        # Another tenant's scope sees nothing.
        assert search_mod.search_sections(conn, "mutex", tenant="other", limit=5, viewer=_viewer())["total"] == 0
        # Legacy (no org): addressed by id.
        legacy = search_mod.search_sections(conn, "mutex", tenant=None, limit=1, viewer=sections.Viewer(member=True))
        assert "/documents/" in legacy["results"][0]["url"] and legacy["results"][0]["url"].endswith("#the-mutex")
    finally:
        conn.close()

    monkeypatch.setenv("GOOGLE_API_KEY", "stub-not-a-key")
    monkeypatch.setattr(embeddings, "embed_texts", Stub())
    reindex.reindex()
    conn = db.connect()
    try:
        # "semaphore" matches no section's words, but embeds next to the mutex section.
        hy = search_mod.search_sections(conn, "semaphore", tenant="", limit=3, viewer=_viewer())
        assert hy["mode"] == "hybrid"
        assert hy["results"][0]["anchor"] == "the-mutex"
        assert "<mark>" not in hy["results"][0]["snippet"]
    finally:
        conn.close()


def test_a_non_member_sees_only_public_items(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    _seed_files(tmp_path)
    reindex.reindex()
    conn = db.connect()
    try:
        stranger = sections.Viewer(member=False, org="acme", public=frozenset())
        assert search_mod.search_sections(conn, "mutex", tenant="", limit=5, viewer=stranger)["total"] == 0
        public = sections.Viewer(member=False, org="acme",
                                 public=frozenset({("lab", "doc", "2026-10-02-locks")}))
        hits = search_mod.search_sections(conn, "mutex", tenant="", limit=10, viewer=public)
        assert search_mod.search_sections(conn, "fuel", tenant="", limit=10, viewer=public)["total"] == 0
        assert hits["results"] and {h["document"]["rel_path"] for h in hits["results"]} == {"lab/2026-10-02-locks.md"}
    finally:
        conn.close()


def test_the_api_routes_in_legacy_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    _seed_files(tmp_path)
    reindex.reindex()
    from server.main import app

    tc = TestClient(app)
    body = tc.get("/api/sections/search", params={"q": "fuel"}).json()
    assert body["mode"] == "bm25" and body["results"][0]["anchor"] == "fuel"
    assert body["results"][0]["url"].endswith("#fuel")
    lib = tc.get("/api/library").json()
    assert {d["rel_path"] for d in lib["documents"]} == {
        "lab/2026-10-01-lanterns.md", "lab/2026-10-02-locks.md",
    }
    assert lib["books"] == []


def test_reader_urls():
    slugged = sections.Viewer(member=True, org="acme", org_label="acme")
    bare = sections.Viewer(member=True, org=None, org_label="0b6c-tenant")
    doc = dict(doc_id=7, project="lab", slug="locks", anchor="the-mutex")
    assert sections.reader_url(slugged, **doc).endswith("/@acme/lab/locks#the-mutex")
    # A loose document's pretty path needs the org's slug; without one it goes by id.
    assert sections.reader_url(bare, **doc).endswith("/documents/7#the-mutex")
    ch = dict(doc, book="guide", chapter_key="ch1", lang="ko")
    assert sections.reader_url(bare, **ch).endswith("/@0b6c-tenant/lab/books/guide/ch1?lang=ko#the-mutex")
    assert sections.reader_url(slugged, **dict(doc, anchor="")).endswith("/@acme/lab/locks")
