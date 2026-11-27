"""The anonymous sitemap read, ``GET /app/sitemap`` (``server/books_api.py``) — a core test.

It lists every org's Public documents and books for the web's ``/sitemap.xml``, gated per
item exactly as a stranger's org-library read is (``server/sharing.py``). Proved here:

* across two orgs (one with a slug, one without), each holding a Public, a Link, a
  Members and a no-row document and book, only the Public ones are listed, with their
  live chapter keys, and none of the others;
* it needs no session, and a member's session does not widen it;
* each item carries only what a sitemap needs (no title, body, tags or member data);
* a share store that cannot be read lists nothing, never everything.

Postgres-gated like ``tests/test_item_share``. The database may be shared with other
suites, so every assertion is scoped to the orgs this test makes.
"""
from __future__ import annotations

import json
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from server import sharing
from tests.test_documents_api import _project, _signup, documents_client  # noqa: F401
from tests.test_public_read import _set_slug

STATES = ("public", "link", "members", "norow")
DATE = "2026-03-01"
ALLOWED = {
    "book": {"org", "project", "kind", "slug", "updated_at", "chapters"},
    "doc": {"org", "project", "kind", "slug", "id", "canonical_path", "updated_at"},
}


def _key(client, headers) -> dict[str, str]:
    key = client.post("/app/credentials", headers=headers).json()["key"]
    return {"Authorization": f"Bearer {key}"}


def _post(client, key, body):
    r = client.post("/api/documents", headers=key, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _doc(project, slug, **over):
    return {
        "title": f"Secret title {slug}", "markdown": f"# {slug}\n\nBody of {slug}.\n",
        "project": project, "tags": ["t", "u"], "source_repo": project,
        "date": DATE, "slug": slug, **over,
    }


def _forget(sync_engine, project_id, kind, key):
    """Drop an item's share row, so it is the no-row case (which reads as Members)."""

    with sync_engine.begin() as conn:
        gone = conn.execute(
            text(
                "DELETE FROM item_shares WHERE project_id = :p AND kind = :k AND item_key = :i"
            ),
            {"p": project_id, "k": kind, "i": key},
        ).rowcount
    assert gone == 1


def _seed_org(client, sync_engine, *, slug: bool):
    """An org with one private project holding a document and a book in each state."""

    headers, tenant = _signup(client, f"sitemap-{uuid4()}@example.com")
    org = _set_slug(client, headers) if slug else tenant
    key = _key(client, headers)
    project_id = _project(client, headers, "lab")
    for state in STATES:
        doc = _post(client, key, _doc("lab", f"{state}-doc"))
        for n in (1, 2):
            _post(client, key, _doc(
                "lab", f"{state}-ch{n}",
                book={"slug": f"{state}-book", "kind": "codebase", "title": f"Book {state}"},
                chapter={"key": f"ch{n}", "position": n}, lang="en",
            ))
        if state in ("public", "link"):
            r = client.put(f"/app/documents/{doc['id']}/share", json={"state": state}, headers=headers)
            assert r.status_code == 200, r.text
            r = client.put(f"/app/books/lab/{state}-book/share", json={"state": state}, headers=headers)
            assert r.status_code == 200, r.text
        if state == "norow":
            _forget(sync_engine, project_id, "doc", f"{DATE}-norow-doc")
            _forget(sync_engine, project_id, "book", "norow-book")
    return org, headers


def _mine(body, orgs):
    return [i for i in body["items"] if i["org"] in orgs]


def test_only_public_items_are_listed_across_orgs(documents_client):
    client, sync_engine = documents_client
    slugged, headers = _seed_org(client, sync_engine, slug=True)
    bare, _ = _seed_org(client, sync_engine, slug=False)

    res = client.get("/app/sitemap")
    assert res.status_code == 200, res.text
    items = _mine(res.json(), {slugged, bare})

    got = sorted((i["org"], i["kind"], i["slug"]) for i in items)
    assert got == sorted(
        (org, kind, f"public-{'book' if kind == 'book' else 'doc'}")
        for org in (slugged, bare)
        for kind in ("book", "doc")
    )
    for item in items:
        assert set(item) == ALLOWED[item["kind"]], item
        assert item["project"] == "lab"
        assert item["updated_at"]
        if item["kind"] == "book":
            assert [c["key"] for c in item["chapters"]] == ["ch1", "ch2"]
            assert all(c["updated_at"] for c in item["chapters"])
        elif item["org"] == slugged:
            assert item["canonical_path"] == f"/@{slugged}/lab/public-doc"
            # The pretty path reads back, signed out: the sitemap's URL is a real page.
            assert client.get(f"/app/orgs/{slugged}/lab/public-doc").status_code == 200
        else:
            assert item["canonical_path"] is None
            assert client.get(f"/app/documents/{item['id']}").status_code == 200
    # Nothing the read returns names a non-Public item, a title or a body.
    raw = json.dumps(items)
    for word in ("link-", "members-", "norow-", "Secret title", "Body of"):
        assert word not in raw, word

    # A member's session does not widen it.
    signed_in = client.get("/app/sitemap", headers=headers)
    assert _mine(signed_in.json(), {slugged, bare}) == items


def test_an_unreadable_share_store_lists_nothing(documents_client, monkeypatch):
    client, sync_engine = documents_client
    org, _ = _seed_org(client, sync_engine, slug=True)
    assert _mine(client.get("/app/sitemap").json(), {org})  # listed while the store reads

    # The per-org share read fails: that org lists nothing (never every item).
    async def broken_shares(_ids):
        raise sharing.SharingError("down")

    readable = sharing.get_shares
    monkeypatch.setattr(sharing, "get_shares", broken_shares)
    res = client.get("/app/sitemap")
    assert res.status_code == 200 and _mine(res.json(), {org}) == []
    monkeypatch.setattr(sharing, "get_shares", readable)

    # The whole store is down (every sharing read raises): an empty list.
    def no_store():
        def session():
            raise SQLAlchemyError("down")

        return session

    monkeypatch.setattr(sharing, "get_session_maker", no_store)
    res = client.get("/app/sitemap")
    assert res.status_code == 200 and res.json() == {"items": []}
