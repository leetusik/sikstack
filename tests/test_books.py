"""Books and chapters (P30.S2): the core invariants only.

* a chapter publish places the variant, and the manifest, the derived tables and
  search agree (and the manifest rides in the chapter's own commit);
* reindex from an empty DB reproduces the book tables exactly;
* PUT refuses a binding to a document that does not exist or is in another project;
* a loose publish that sends no new field is byte-for-byte today's;
* a public book route on a private project is a 404 (Postgres-gated);
* a slug-less tenant's book is addressed on its tenant id (P30.S11, OQ26);
* a document's detail names the chapter it is bound as, and a loose one names none
  (P30.F4, OQ183: the web plane redirects a bound chapter's loose address).
"""
from __future__ import annotations

import json
import subprocess
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from server import db, reindex

_INDEX = "# Knowledge Base\n\n## Recent\n\n<!-- explain:recent -->\n\n## Browse\n"


def _git(root, *args):
    return subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, text=True, check=True
    )


_PUBLISHED = "2026-07-02T09:30:00Z"


@pytest.fixture
def client(tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "index.md").write_text(_INDEX, encoding="utf-8")
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "kb-test")
    _git(tmp_path, "config", "user.email", "kb-test@example.com")
    _git(tmp_path, "add", "docs/index.md")
    _git(tmp_path, "commit", "-m", "seed")
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    # P63 (D171-qk): a publish stamps its own time into the header; pin it so the
    # byte-exact file pin below stays exact.
    monkeypatch.setattr("server.documents.now_stamp", lambda: _PUBLISHED)
    from server.main import app

    return TestClient(app), tmp_path


def _payload(**over):
    base = {
        "title": "P8: The reader",
        "markdown": "# P8: The reader\n\nZebracorn chapter body.\n",
        "project": "knowledge",
        "tags": ["reader", "books"],
        "source_repo": "knowledge",
        "date": "2026-10-01",
        "slug": "p8-the-reader",
    }
    base.update(over)
    return base


_BOOK = {"slug": "phases", "title": "knowledge, phase by phase", "kind": "codebase"}


def _dump_book_tables(conn):
    return {
        t: [tuple(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2, 3, 4").fetchall()]
        for t in ("books", "chapters", "chapter_variants")
    }


def test_chapter_publish_places_variant_and_index_agrees(client):
    tc, root = client
    r = tc.post(
        "/api/documents",
        json=_payload(
            book=_BOOK,
            chapter={"key": "p8", "position": 8, "source": {"phase": "P8"}},
            lang="en",
        ),
    )
    assert r.status_code == 201, r.text
    en = r.json()
    assert (en["book"], en["chapter_key"], en["lang"]) == ("phases", "p8", "en")
    assert en["book_created"] is True and en["chapter_created"] is True
    assert en["manifest_path"] == ".books/knowledge/phases.json"
    # Written on disk, never committed (no git publish).
    assert (root / "docs" / en["manifest_path"]).is_file()
    assert en["committed"] is False
    assert _git(root, "rev-list", "--count", "HEAD").stdout.strip() == "1"

    # A second language joins the same chapter as its own document.
    r = tc.post(
        "/api/documents",
        json=_payload(
            title="P8: 리더",
            slug="p8-the-reader-ko",
            book=_BOOK,
            chapter={"key": "p8"},
            lang="ko",
            translated_from={"lang": "en", "version": 1},
        ),
    )
    assert r.status_code == 201, r.text
    ko = r.json()
    assert ko["chapter_created"] is False and ko["book_created"] is False
    ko_file = (root / "docs" / ko["rel_path"]).read_text(encoding="utf-8")
    assert "\nlang: ko\n" in ko_file and "translated_from:\n  lang: en\n  version: 1\n" in ko_file

    # Re-publishing (book, key, lang) is that variant's next version: same rel_path,
    # whatever date/slug the request computes, with no new_version flag.
    r = tc.post(
        "/api/documents",
        json=_payload(date="2026-10-05", slug="renamed", book=_BOOK, chapter={"key": "p8"}, lang="en"),
    )
    assert r.status_code == 201, r.text
    assert r.json()["rel_path"] == en["rel_path"] and r.json()["version"] == 2

    manifest = json.loads((root / "docs" / en["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest == {
        "slug": "phases",
        "title": "knowledge, phase by phase",
        "kind": "codebase",
        "subject": None,
        "description": None,
        "chapters": [
            {
                "key": "p8",
                "position": 8,
                "variants": {"en": en["rel_path"], "ko": ko["rel_path"]},
                "source": {"phase": "P8"},
            }
        ],
    }

    # The derived tables (via the route) agree with the manifest.
    book = tc.get("/api/books/knowledge/phases").json()
    assert [c["key"] for c in book["chapters"]] == ["p8"]
    variants = {v["lang"]: v for v in book["chapters"][0]["variants"]}
    assert {k: v["rel_path"] for k, v in variants.items()} == manifest["chapters"][0]["variants"]
    assert variants["en"]["doc_id"] == en["id"] and variants["en"]["version"] == 2
    assert variants["ko"]["translated_from"] == {"lang": "en", "version": 1}
    assert tc.get("/api/books", params={"project": "knowledge"}).json()["items"][0]["chapter_count"] == 1

    # Search hits carry the binding; a loose document carries nulls.
    tc.post("/api/documents", json=_payload(title="Loose zebracorn", slug="loose", date="2026-09-01"))
    hits = {h["slug"]: h for h in tc.get("/api/search", params={"q": "zebracorn"}).json()["results"]}
    assert (hits["p8-the-reader"]["book"], hits["p8-the-reader"]["chapter_key"], hits["p8-the-reader"]["lang"]) == ("phases", "p8", "en")
    assert (hits["loose"]["book"], hits["loose"]["chapter_key"], hits["loose"]["lang"]) == (None, None, None)


def test_reindex_from_empty_db_reproduces_book_tables(client, tmp_path):
    tc, root = client
    for lang, slug in (("en", "a-en"), ("ko", "a-ko")):
        r = tc.post(
            "/api/documents",
            json=_payload(slug=slug, book=_BOOK, chapter={"key": "a", "title": "A"}, lang=lang),
        )
        assert r.status_code == 201, r.text
    r = tc.post("/api/documents", json=_payload(slug="b", book=_BOOK, chapter={"key": "b", "position": 2.5}))
    assert r.status_code == 201, r.text

    conn = db.connect()
    before = _dump_book_tables(conn)
    conn.close()
    assert len(before["chapter_variants"]) == 3

    db_file = tmp_path / "data" / "kb.sqlite3"
    for suffix in ("", "-wal", "-shm"):
        (db_file.parent / (db_file.name + suffix)).unlink(missing_ok=True)
    report = reindex.reindex()
    assert report["books_indexed"] == 1 and report["books_removed"] == 0

    conn = db.connect()
    assert _dump_book_tables(conn) == before
    conn.close()

    # A manifest removed from disk takes its rows with it on the next reindex.
    (root / "docs" / ".books" / "knowledge" / "phases.json").unlink()
    report = reindex.reindex()
    assert report["books_removed"] == 1
    conn = db.connect()
    assert all(rows == [] for rows in _dump_book_tables(conn).values())
    conn.close()


def test_put_refuses_missing_or_foreign_documents(client):
    tc, _root = client
    mine = tc.post("/api/documents", json=_payload(slug="mine")).json()
    other = tc.post("/api/documents", json=_payload(slug="theirs", project="elsewhere")).json()

    def put(variants):
        return tc.put(
            "/api/books/knowledge/guide",
            json={"title": "Guide", "kind": "codebase",
                  "chapters": [{"key": "one", "position": 1, "variants": variants}]},
        )

    # A document that does not exist is refused, and nothing is written.
    r = put({"en": "knowledge/2026-10-01-nope.md"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["missing"] == ["knowledge/2026-10-01-nope.md"]
    # A document of another project is refused before anything else (a book never
    # spans projects).
    assert put({"en": other["rel_path"]}).status_code == 422
    assert tc.get("/api/books/knowledge/guide").status_code == 404

    r = put({"en": mine["rel_path"]})
    assert r.status_code == 200, r.text
    assert r.json()["created"] is True
    assert r.json()["chapters"][0]["variants"][0]["doc_id"] == mine["id"]
    # The same document cannot join a second book.
    r = tc.put(
        "/api/books/knowledge/other",
        json={"title": "Other", "kind": "codebase",
              "chapters": [{"key": "x", "position": 1, "variants": {"en": mine["rel_path"]}}]},
    )
    assert r.status_code == 409, r.text


def test_loose_publish_without_new_fields_is_unchanged(client):
    """The regression pin: no book field -> the pre-P30 file and response, no commit."""
    tc, root = client
    r = tc.post("/api/documents", json=_payload(slug="plain"))
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {
        "id", "rel_path", "url", "title", "project", "slug", "date", "tags", "related",
        "format", "version", "previous_version", "archived_path", "recent_updated",
        "landing_created", "committed", "commit_sha", "pushed", "push_pending", "share",
    }
    assert (root / "docs" / body["rel_path"]).read_text(encoding="utf-8") == (
        "---\n"
        'title: "P8: The reader"\n'
        "date: 2026-10-01\n"
        'published: "2026-07-02T09:30:00Z"\n'
        "tags:\n  - reader\n  - books\n"
        "source:\n  project: knowledge\n  repo: knowledge\n"
        "---\n\n"
        "# P8: The reader\n\nZebracorn chapter body.\n"
    )
    assert body["committed"] is False and body["share"] is None  # legacy: no sharing
    assert _git(root, "rev-list", "--count", "HEAD").stdout.strip() == "1"
    assert not (root / "docs" / "knowledge" / "index.md").exists()  # no landing
    assert not (root / "docs" / ".books").exists()


# --- the public book route (Postgres-gated, like every /app/orgs read) ----------

from tests.test_documents_api import _project, _signup, documents_client  # noqa: E402,F401
from tests.test_public_read import _fill  # noqa: E402


def _seed_books(tenant: str) -> None:
    conn = db.connect()
    try:
        for project in ("shelf", "secret"):
            rel = f"{project}/2026-01-01-ch1.md"
            db.upsert_document(
                conn, project=project, slug="ch1", date="2026-01-01", title="Chapter one",
                tags=[], source_repo="r", rel_path=rel, markdown="body", tenant_id=tenant,
            )
            db.replace_book(
                conn, tenant_id=tenant, project=project,
                manifest={"slug": "intro", "title": "Intro", "kind": "codebase",
                          "subject": None, "description": None,
                          "chapters": [{"key": "ch1", "position": 1, "variants": {"en": rel}}]},
                manifest_path=f".books/{project}/intro.json",
            )
    finally:
        conn.close()


def _tenant_with_books(client) -> tuple[dict[str, str], str]:
    headers, tenant = _signup(client, f"books-{uuid4()}@example.com")
    pub = _project(client, headers, "shelf")
    _project(client, headers, "secret")  # stays private
    assert client.patch(
        f"/app/projects/{pub}", json={"visibility": "public"}, headers=headers
    ).status_code == 200
    _seed_books(tenant)
    _fill(client)  # day one: the public project's existing items read Public
    return headers, tenant


def test_public_book_route_is_404_on_a_private_project(documents_client):
    client, _ = documents_client
    headers, tenant = _tenant_with_books(client)
    org = f"org-{uuid4().hex[:10]}"
    assert client.patch("/app/tenant", json={"slug": org}, headers=headers).status_code == 200

    # Anonymous: the public project's book reads; the private one is the same 404
    # as a book that does not exist (never a 403).
    ok = client.get(f"/app/orgs/{org}/shelf/books/intro")
    assert ok.status_code == 200, ok.text
    assert ok.json()["chapters"][0]["variants"][0]["title"] == "Chapter one"
    assert "tenant_id" not in ok.json()
    priv = client.get(f"/app/orgs/{org}/secret/books/intro")
    missing = client.get(f"/app/orgs/{org}/secret/books/nope")
    assert priv.status_code == missing.status_code == 404
    assert priv.json() == missing.json()

    # The member reads their own private book.
    assert client.get(f"/app/orgs/{org}/secret/books/intro", headers=headers).status_code == 200
    assert client.get("/app/books/secret/intro", headers=headers).status_code == 200


def test_public_book_route_names_its_org(documents_client):
    """P63: the public book read carries the owning org as the org library names it
    (``org``: slug and display name), for a visitor's way back; a private project's
    book stays the one 404, so the name leaks nowhere new."""

    client, _ = documents_client
    headers, tenant = _tenant_with_books(client)
    # A slug-less tenant: addressed on its id, its slug null.
    name = client.get(f"/app/orgs/{tenant}/library").json()["org"]["name"]
    assert name
    ok = client.get(f"/app/orgs/{tenant}/shelf/books/intro")
    assert ok.json()["org"] == {"slug": None, "name": name}
    org = f"org-{uuid4().hex[:10]}"
    assert client.patch("/app/tenant", json={"slug": org}, headers=headers).status_code == 200
    for hdrs in ({}, headers):
        hit = client.get(f"/app/orgs/{org}/shelf/books/intro", headers=hdrs)
        assert hit.json()["org"] == {"slug": org, "name": name}
    assert client.get(f"/app/orgs/{org}/secret/books/intro", headers=headers).json()["org"]["name"] == name
    priv = client.get(f"/app/orgs/{org}/secret/books/intro")
    assert priv.status_code == 404 and "org" not in priv.json()


def test_slugless_tenant_book_is_addressed_on_its_tenant_id(documents_client):
    """P30.S11 (OQ26): `org` is the slug, or the tenant id when there is none."""

    client, _ = documents_client
    headers, tenant = _tenant_with_books(client)

    # No slug: the member read names the tenant-id path, and that path resolves,
    # still gated (the private project is the same 404 as a missing book).
    member = client.get("/app/books/shelf/intro", headers=headers)
    assert member.json()["canonical_path"] == f"/@{tenant}/shelf/books/intro"
    ok = client.get(f"/app/orgs/{tenant}/shelf/books/intro")
    assert ok.status_code == 200, ok.text
    assert ok.json()["canonical_path"] == f"/@{tenant}/shelf/books/intro"
    priv = client.get(f"/app/orgs/{tenant}/secret/books/intro")
    assert priv.status_code == 404
    assert priv.json() == client.get(f"/app/orgs/{uuid4()}/shelf/books/intro").json()

    # Once the org claims a slug, the id path still resolves and names the slug.
    org = f"org-{uuid4().hex[:10]}"
    assert client.patch("/app/tenant", json={"slug": org}, headers=headers).status_code == 200
    again = client.get(f"/app/orgs/{tenant}/shelf/books/intro")
    assert again.json()["canonical_path"] == f"/@{org}/shelf/books/intro"


# --- the org library (P30.S22) ---------------------------------------------------


def _seed_loose(tenant: str, project: str, slug: str, subject: str | None = None) -> None:
    conn = db.connect()
    try:
        db.upsert_document(
            conn, project=project, slug=slug, date="2026-02-01", title=f"Doc {slug}",
            tags=[], source_repo="r", rel_path=f"{project}/2026-02-01-{slug}.md",
            markdown="body", tenant_id=tenant, subject=subject,
        )
    finally:
        conn.close()


def test_org_library_shows_a_stranger_only_public_projects(documents_client):
    client, _ = documents_client
    headers, tenant = _tenant_with_books(client)
    _seed_loose(tenant, "shelf", "open-note", subject="Law")
    _seed_loose(tenant, "secret", "closed-note")
    _fill(client)
    org = f"org-{uuid4().hex[:10]}"
    assert client.patch("/app/tenant", json={"slug": org}, headers=headers).status_code == 200

    # Anonymous: the public project's book and loose document, nothing of the private one.
    anon = client.get(f"/app/orgs/{org}/library")
    assert anon.status_code == 200, anon.text
    body = anon.json()
    assert body["member"] is False
    assert [p["name"] for p in body["projects"]] == ["shelf"]
    assert [b["project"] for b in body["books"]] == ["shelf"]
    assert [d["slug"] for d in body["documents"]] == ["open-note"]
    assert body["documents"][0]["canonical_path"] == f"/@{org}/shelf/open-note"
    assert "secret" not in anon.text

    # The member sees both, and `scope=public` narrows them to the stranger's view.
    mem = client.get(f"/app/orgs/{org}/library", headers=headers).json()
    assert mem["member"] is True
    assert {"shelf", "secret"} <= {p["name"] for p in mem["projects"]}
    assert {b["project"] for b in mem["books"]} == {"shelf", "secret"}
    assert {d["slug"] for d in mem["documents"]} == {"open-note", "closed-note"}
    pub = client.get(f"/app/orgs/{org}/library?scope=public", headers=headers).json()
    assert [b["project"] for b in pub["books"]] == ["shelf"]

    # A chapter variant is never a loose document.
    assert all(d["slug"] != "ch1" for d in mem["documents"])

    # Another org's member is a stranger: public only.
    other, _ = _signup(client, f"stranger-{uuid4()}@example.com")
    cross = client.get(f"/app/orgs/{org}/library", headers=other).json()
    assert cross["member"] is False and [b["project"] for b in cross["books"]] == ["shelf"]


def test_org_library_misses_are_one_404(documents_client):
    client, _ = documents_client
    headers, tenant = _signup(client, f"closed-{uuid4()}@example.com")
    _project(client, headers, "hidden")  # private: nothing public at all
    org = f"org-{uuid4().hex[:10]}"
    assert client.patch("/app/tenant", json={"slug": org}, headers=headers).status_code == 200
    nothing = client.get(f"/app/orgs/{org}/library")
    unknown = client.get(f"/app/orgs/no-such-{uuid4().hex[:8]}/library")
    assert nothing.status_code == unknown.status_code == 404
    assert nothing.json() == unknown.json()
    # The member still reads their own (empty) library, and its public view.
    assert client.get(f"/app/orgs/{org}/library", headers=headers).status_code == 200
    mine = client.get(f"/app/orgs/{org}/library?scope=public", headers=headers)
    assert mine.status_code == 200 and mine.json()["projects"] == []


def test_detail_names_the_chapter_a_document_is_bound_as(client):
    tc, _ = client
    ch = tc.post(
        "/api/documents",
        json=_payload(book=_BOOK, chapter={"key": "p8", "position": 8}, lang="en"),
    ).json()
    loose = tc.post("/api/documents", json=_payload(slug="loose-note", title="Loose")).json()

    from server import documents_api

    conn = db.connect()
    try:
        bound = documents_api._chapter_of(conn, db.get_document(conn, ch["id"]))
        free = documents_api._chapter_of(conn, db.get_document(conn, loose["id"]))
    finally:
        conn.close()
    assert bound == {"book": "phases", "chapter_key": "p8", "lang": "en"}
    assert free is None


# --- a book's second title (P63, D248-j7) ---------------------------------------

from server import books as books_mod  # noqa: E402
from server.documents import ConventionError  # noqa: E402


def _manifest(**over):
    base = {"slug": "phases", "title": "Phases", "kind": "codebase", "chapters": []}
    base.update(over)
    return base


def test_a_second_title_is_optional_and_sits_beside_the_title():
    # Without it the canonical form is exactly as before: no new key appears.
    plain = books_mod.normalize_manifest(_manifest(), project="knowledge")
    assert list(plain) == ["slug", "title", "kind", "subject", "description", "chapters"]
    # With it, the second title and its language follow the title.
    full = books_mod.normalize_manifest(
        _manifest(subtitle="단계별로 본 지식", subtitle_lang="ko"), project="knowledge"
    )
    assert list(full)[:4] == ["slug", "title", "subtitle", "subtitle_lang"]
    assert (full["subtitle"], full["subtitle_lang"]) == ("단계별로 본 지식", "ko")
    # The language is optional; null means unset.
    alone = books_mod.normalize_manifest(_manifest(subtitle="Second"), project="knowledge")
    assert alone["subtitle"] == "Second" and "subtitle_lang" not in alone
    nulls = books_mod.normalize_manifest(
        _manifest(subtitle=None, subtitle_lang=None), project="knowledge"
    )
    assert list(nulls) == list(plain)


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"subtitle": 5}, "invalid book subtitle: 5"),
        ({"subtitle": ["a"]}, "invalid book subtitle: ['a']"),
        ({"subtitle": "   "}, "invalid book subtitle: '   '"),
        ({"subtitle": "x" * 301}, "book subtitle is longer than 300 characters"),
        ({"subtitle": "Second", "subtitle_lang": "KO"}, "invalid book subtitle_lang"),
        ({"subtitle": "Second", "subtitle_lang": "korean"}, "invalid book subtitle_lang"),
        ({"subtitle": "Second", "subtitle_lang": 1}, "invalid book subtitle_lang"),
        ({"subtitle_lang": "ko"}, "book subtitle_lang needs a subtitle"),
        ({"subtitle": None, "subtitle_lang": "ko"}, "book subtitle_lang needs a subtitle"),
    ],
)
def test_a_malformed_second_title_is_refused(fields, message):
    with pytest.raises(ConventionError) as exc:
        books_mod.normalize_manifest(_manifest(**fields), project="knowledge")
    assert message in str(exc.value)


def test_a_second_title_rides_the_index_through_a_reindex(client, tmp_path):
    tc, root = client
    r = tc.post(
        "/api/documents",
        json=_payload(book=_BOOK, chapter={"key": "p8", "position": 8}, lang="en"),
    )
    assert r.status_code == 201, r.text
    # A book with none reads back with none.
    book = tc.get("/api/books/knowledge/phases").json()
    assert (book["sub"], book["sub_lang"]) == (None, None)

    # The author writes it into the manifest; the index carries it after a reindex,
    # and a rebuild from an empty store reproduces it.
    path = root / "docs" / ".books" / "knowledge" / "phases.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest.update(subtitle="단계별로 본 지식", subtitle_lang="ko")
    path.write_text(books_mod.serialize_manifest(manifest), encoding="utf-8")
    reindex.reindex()
    book = tc.get("/api/books/knowledge/phases").json()
    assert (book["sub"], book["sub_lang"]) == ("단계별로 본 지식", "ko")
    (item,) = tc.get("/api/books", params={"project": "knowledge"}).json()["items"]
    assert (item["sub"], item["sub_lang"]) == ("단계별로 본 지식", "ko")

    db_file = tmp_path / "data" / "kb.sqlite3"
    for suffix in ("", "-wal", "-shm"):
        (db_file.parent / (db_file.name + suffix)).unlink(missing_ok=True)
    reindex.reindex()
    book = tc.get("/api/books/knowledge/phases").json()
    assert (book["sub"], book["sub_lang"]) == ("단계별로 본 지식", "ko")


def test_a_store_from_before_the_second_title_gains_its_columns(tmp_path):
    import sqlite3

    path = tmp_path / "old.sqlite3"
    old = sqlite3.connect(str(path))
    old.execute(
        "CREATE TABLE books (tenant_id TEXT NOT NULL DEFAULT '', project TEXT NOT NULL, "
        "slug TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, "
        "description TEXT, manifest_path TEXT NOT NULL, PRIMARY KEY (tenant_id, project, slug))"
    )
    old.execute(
        "INSERT INTO books VALUES ('', 'knowledge', 'phases', 'Phases', 'codebase', NULL, NULL, "
        "'.books/knowledge/phases.json')"
    )
    old.commit()
    old.close()

    conn = db.connect(path)
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(books)").fetchall()}
        assert {"subtitle", "subtitle_lang"} <= cols
        book = db.get_book(conn, project="knowledge", slug="phases")
        assert (book["sub"], book["sub_lang"]) == (None, None)
        # Opening it again is a no-op.
        db.init_db(conn)
    finally:
        conn.close()


def test_an_author_writes_the_second_title_on_a_publish_and_a_put(client):
    tc, root = client
    # A publish that creates the book seeds its second title into the manifest.
    book = {**_BOOK, "subtitle": "단계별로 본 지식", "subtitle_lang": "ko"}
    r = tc.post(
        "/api/documents",
        json=_payload(book=book, chapter={"key": "p8", "position": 8}, lang="en"),
    )
    assert r.status_code == 201, r.text
    en = r.json()
    path = root / "docs" / en["manifest_path"]
    manifest = json.loads(path.read_text(encoding="utf-8"))
    assert list(manifest)[:4] == ["slug", "title", "subtitle", "subtitle_lang"]
    assert (manifest["subtitle"], manifest["subtitle_lang"]) == ("단계별로 본 지식", "ko")
    got = tc.get("/api/books/knowledge/phases").json()
    assert (got["sub"], got["sub_lang"]) == ("단계별로 본 지식", "ko")

    # An existing book keeps its manifest: a later publish's book fields are ignored.
    r = tc.post(
        "/api/documents",
        json=_payload(slug="p9", title="P9", book={**_BOOK, "subtitle": "Other"},
                      chapter={"key": "p9", "position": 9}, lang="en"),
    )
    assert r.status_code == 201, r.text
    assert json.loads(path.read_text(encoding="utf-8"))["subtitle"] == "단계별로 본 지식"

    # A malformed one is refused before anything is written.
    r = tc.post(
        "/api/documents",
        json=_payload(slug="other", book={"slug": "other", "kind": "codebase", "subtitle_lang": "ko"},
                      chapter={"key": "a", "position": 1}, lang="en"),
    )
    assert r.status_code == 422 and "book subtitle_lang needs a subtitle" in r.text
    assert not (root / "docs" / ".books" / "knowledge" / "other.json").exists()

    # PUT replaces the whole manifest: it sets, changes and clears the second title.
    chapters = manifest["chapters"]
    r = tc.put(
        "/api/books/knowledge/phases",
        json={"title": "Phases", "kind": "codebase", "subtitle": "Fases", "subtitle_lang": "es",
              "chapters": json.loads(path.read_text(encoding="utf-8"))["chapters"]},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["sub"], r.json()["sub_lang"]) == ("Fases", "es")
    on_disk = json.loads(path.read_text(encoding="utf-8"))
    assert (on_disk["subtitle"], on_disk["subtitle_lang"]) == ("Fases", "es")
    r = tc.put(
        "/api/books/knowledge/phases",
        json={"title": "Phases", "kind": "codebase", "subtitle_lang": "es", "chapters": chapters},
    )
    assert r.status_code == 422 and "book subtitle_lang needs a subtitle" in r.text
    r = tc.put(
        "/api/books/knowledge/phases",
        json={"title": "Phases", "kind": "codebase",
              "chapters": json.loads(path.read_text(encoding="utf-8"))["chapters"]},
    )
    assert r.status_code == 200, r.text
    assert (r.json()["sub"], r.json()["sub_lang"]) == (None, None)
    assert "subtitle" not in json.loads(path.read_text(encoding="utf-8"))
