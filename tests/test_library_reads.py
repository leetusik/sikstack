"""The reads the Library and org home draw (P63): a document's reading time on the
library, book and document reads, and a live per-project active-document count on
``GET /app/dashboard``.

Postgres-gated like ``tests/test_documents_api.py`` (whose fixture and seed helpers it
reuses): runs only when ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) names a
disposable Postgres, and skips cleanly otherwise.
"""
from __future__ import annotations

import sqlite3
from uuid import uuid4

from server import db, reading_time
from tests.test_public_read import _fill
from tests.test_documents_api import (  # noqa: F401 - the fixture is used by name
    _project,
    _seed_doc,
    _seeded_file,
    _signup,
    documents_client,
)

WPM = reading_time.WORDS_PER_MINUTE


def _words(n: int) -> str:
    return " ".join(f"word{i}" for i in range(n))


def _counts(client, headers) -> dict[str, object]:
    res = client.get("/app/dashboard", headers=headers)
    assert res.status_code == 200, res.text
    return {row["name"]: row["active_documents"] for row in res.json()["projects"]}


def test_the_count_equals_the_documents_total_and_drops_a_deleted_one(
    documents_client, tmp_path, monkeypatch
):
    client, _ = documents_client
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.delenv("KB_OPERATOR_EMAIL", raising=False)
    headers, tenant = _signup(client, f"count-{uuid4()}@example.com")
    ids = {
        "alpha": _project(client, headers, "alpha"),
        "beta": _project(client, headers, "beta"),
        "empty": _project(client, headers, "empty"),
    }
    for i in range(3):
        _seed_doc(tenant, "alpha", slug=f"a{i}", title=f"A{i}", markdown="body")
    gone = _seed_doc(tenant, "beta", slug="gone", title="Gone", markdown="body")
    _seed_doc(tenant, "beta", slug="kept", title="Kept", markdown="body")
    _seeded_file(tmp_path, tenant, "beta/2026-01-01-gone.md")
    # Another org's documents in a project of the same name never count here.
    _, other = _signup(client, f"count-other-{uuid4()}@example.com")
    _seed_doc(other, "alpha", slug="theirs", title="Theirs", markdown="body")

    assert _counts(client, headers) == {"alpha": 3, "beta": 2, "empty": 0}

    assert client.delete(f"/app/documents/{gone}", headers=headers).status_code == 204
    counts = _counts(client, headers)
    assert counts == {"alpha": 3, "beta": 1, "empty": 0}

    # The same number /app/documents?project= answers, project by project.
    res = client.get("/app/dashboard", headers=headers).json()
    for row in res["projects"]:
        total = client.get(
            "/app/documents", params={"project": row["id"], "limit": 1}, headers=headers
        ).json()["total"]
        assert row["active_documents"] == total, row["name"]
    assert {row["id"] for row in res["projects"]} >= set(ids.values())


def test_the_counts_are_one_read_whatever_the_number_of_projects(
    documents_client, monkeypatch
):
    client, _ = documents_client
    headers, tenant = _signup(client, f"oneread-{uuid4()}@example.com")
    for name in ("p1", "p2", "p3", "p4"):
        _project(client, headers, name)
        _seed_doc(tenant, name, slug="d", title="D", markdown="body")

    calls = []
    real = db.list_projects

    def spy(conn, tenant_id=None):
        calls.append(tenant_id)
        return real(conn, tenant_id=tenant_id)

    monkeypatch.setattr(db, "list_projects", spy)
    assert _counts(client, headers) == {"p1": 1, "p2": 1, "p3": 1, "p4": 1}
    assert calls == [tenant]


def test_a_count_that_cannot_be_read_keeps_the_projects_panel(
    documents_client, monkeypatch
):
    """P58-yw's code reader: one failed count must not hide org home's whole Projects
    panel. One read now answers every project; when it fails, the dashboard still
    answers, every count reads null, and the rest of each row stands."""

    client, _ = documents_client
    headers, _ = _signup(client, f"failcount-{uuid4()}@example.com")
    _project(client, headers, "alpha")

    def broken(conn, tenant_id=None):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db, "list_projects", broken)
    res = client.get("/app/dashboard", headers=headers)
    assert res.status_code == 200, res.text
    rows = {row["name"]: row for row in res.json()["projects"]}
    assert set(rows) == {"alpha"}
    assert all(row["active_documents"] is None for row in rows.values())
    assert rows["alpha"]["keys"] == 0 and rows["alpha"]["documents"] == 0


def test_reading_minutes_ride_the_library_book_and_document_reads(documents_client):
    client, _ = documents_client
    headers, tenant = _signup(client, f"minutes-{uuid4()}@example.com")
    _project(client, headers, "alpha")
    loose = _seed_doc(
        tenant, "alpha", slug="loose", title="Loose", markdown=_words(2 * WPM + 1)
    )
    _seed_doc(tenant, "alpha", slug="ch1", title="Chapter one", markdown=_words(WPM))
    conn = db.connect()
    try:
        db.replace_book(
            conn,
            tenant_id=tenant,
            project="alpha",
            manifest={
                "slug": "guide",
                "title": "Guide",
                "kind": "subject",
                "chapters": [
                    {"key": "one", "position": 1, "variants": {"en": "alpha/2026-01-01-ch1.md"}}
                ],
            },
            manifest_path=".books/alpha/guide.json",
        )
    finally:
        conn.close()

    org = tenant  # a slug-less org is addressed by its tenant id
    lib = client.get(f"/app/orgs/{org}/library", headers=headers)
    assert lib.status_code == 200, lib.text
    body = lib.json()
    assert [(d["slug"], d["reading_minutes"]) for d in body["documents"]] == [("loose", 3)]
    (book,) = body["books"]
    assert book["chapters"][0]["variants"][0]["reading_minutes"] == 1

    found = client.get(f"/app/orgs/{org}/alpha/books/guide", headers=headers).json()
    assert found["chapters"][0]["variants"][0]["reading_minutes"] == 1

    detail = client.get(f"/app/documents/{loose}", headers=headers).json()
    assert detail["reading_minutes"] == 3
    # The list's key set is pinned (test_documents_api._LIST_KEYS): no new field there.
    listed = client.get("/app/documents", headers=headers).json()["items"]
    assert all("reading_minutes" not in item for item in listed)


def test_a_books_second_title_rides_every_read_that_lists_or_opens_it(documents_client):
    """D248-j7: the manifest's ``subtitle`` / ``subtitle_lang`` reach the reads as
    ``sub`` / ``sub_lang``: the org library (the Library, project home, a project's
    library and the public ones), both book reads and the book list. A book without
    one reads back null."""

    client, _ = documents_client
    headers, tenant = _signup(client, f"subtitle-{uuid4()}@example.com")
    pid = _project(client, headers, "alpha")
    assert client.patch(
        f"/app/projects/{pid}", json={"visibility": "public"}, headers=headers
    ).status_code == 200
    _seed_doc(tenant, "alpha", slug="ch1", title="Chapter one", markdown="body")
    _seed_doc(tenant, "alpha", slug="ch2", title="Chapter two", markdown="body")
    conn = db.connect()
    try:
        for slug, rel, extra in (
            ("guide", "alpha/2026-01-01-ch1.md", {"subtitle": "길잡이", "subtitle_lang": "ko"}),
            ("plain", "alpha/2026-01-01-ch2.md", {}),
        ):
            db.replace_book(
                conn,
                tenant_id=tenant,
                project="alpha",
                manifest={
                    "slug": slug,
                    "title": slug.title(),
                    **extra,
                    "kind": "codebase",
                    "chapters": [{"key": "one", "position": 1, "variants": {"en": rel}}],
                },
                manifest_path=f".books/alpha/{slug}.json",
            )
    finally:
        conn.close()
    _fill(client)  # day one: the public project's existing items read Public

    org = tenant  # a slug-less org is addressed by its tenant id
    want = {"guide": ("길잡이", "ko"), "plain": (None, None)}

    def pairs(books):
        return {b["slug"]: (b["sub"], b["sub_lang"]) for b in books}

    # The org library: a member's, its public view, and a stranger's.
    for who in (headers, None):
        for scope in ("all", "public"):
            res = client.get(f"/app/orgs/{org}/library", params={"scope": scope}, headers=who)
            assert res.status_code == 200, res.text
            assert pairs(res.json()["books"]) == want
    # Both book reads, member and stranger, and the member's book list.
    for slug, pair in want.items():
        for who in (headers, None):
            found = client.get(f"/app/orgs/{org}/alpha/books/{slug}", headers=who).json()
            assert (found["sub"], found["sub_lang"]) == pair
        mine = client.get(f"/app/books/alpha/{slug}", headers=headers).json()
        assert (mine["sub"], mine["sub_lang"]) == pair
    listed = client.get("/app/books", headers=headers).json()["items"]
    assert pairs(listed) == want


def test_a_visitors_listing_carries_tags_only_of_documents_they_may_read(documents_client):
    """OQ8: the org library's loose documents carry their tags, so a visitor's
    documents table draws them; a private project's documents, and so their tags,
    never reach a stranger or the org's public view."""

    client, _ = documents_client
    headers, tenant = _signup(client, f"tags-{uuid4()}@example.com")
    pid = _project(client, headers, "open")
    _project(client, headers, "closed")
    assert client.patch(
        f"/app/projects/{pid}", json={"visibility": "public"}, headers=headers
    ).status_code == 200
    _seed_doc(tenant, "open", slug="a", title="A", markdown="x", tags=["capture", "alert"])
    _seed_doc(tenant, "open", slug="b", title="B", markdown="x")
    _seed_doc(tenant, "closed", slug="c", title="C", markdown="x", tags=["secret-plan"])
    _fill(client)

    org = tenant

    def tags(who, scope):
        res = client.get(f"/app/orgs/{org}/library", params={"scope": scope}, headers=who)
        assert res.status_code == 200, res.text
        assert "secret-plan" not in res.text or (who is headers and scope == "all")
        return {d["slug"]: d["tags"] for d in res.json()["documents"]}

    public = {"a": ["capture", "alert"], "b": []}
    assert tags(None, "public") == public
    assert tags(None, "all") == public  # a stranger reads the public ones only
    assert tags(headers, "public") == public
    assert tags(headers, "all") == {**public, "c": ["secret-plan"]}
