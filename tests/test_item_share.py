"""Each document and book carries its own sharing (``server/sharing.py``) — a core test.

Postgres-gated like ``tests/test_public_read``. Proved here:

* a new item starts at its project's default (Public for a public project, Members
  for a private one) unless the write names ``share``; an item with no row is Members;
* the link: on mints a token, a signed-out reader reads the document through the same
  routes as a public read while holding it (``X-Share-Token``), off kills it, on again
  mints another and the old one stays dead; ``/app/shared/{token}`` names the item;
* every miss is the same 404 (Members, a dead token, another org, a missing item);
* a Link item is never in the org library listing (nor a Members one), a Public one is;
* a book's state covers its chapters, and a chapter has no state of its own;
* reader state stays session-only, and a link item has none for another org's reader;
* ``POST /api/share`` (``knowledge share``) sets a state with a full key;
* a deleted document's row goes, so the next one under its stem starts afresh;
* the fill primitive is idempotent, and leaves an item whose state was set alone (its
  once-ever guard: ``tests/test_item_share_authority``).
"""
from __future__ import annotations

from uuid import uuid4

from server import db
from tests.test_documents_api import _project, _signup, documents_client  # noqa: F401
from tests.test_public_read import _fill, _set_public, _set_slug


def _key(client, headers) -> dict[str, str]:
    key = client.post("/app/credentials", headers=headers).json()["key"]
    return {"Authorization": f"Bearer {key}"}


def _doc(project, slug, **over):
    return {
        "title": f"Doc {slug}", "markdown": f"# Doc {slug}\n\nBody of {slug}.\n",
        "project": project, "tags": ["t", "u"], "source_repo": project,
        "date": "2026-03-01", "slug": slug, **over,
    }


def _org(client):
    headers, tenant = _signup(client, f"share-{uuid4()}@example.com")
    org = _set_slug(client, headers)
    return headers, tenant, org, _key(client, headers)


def _post(client, key, body):
    r = client.post("/api/documents", headers=key, json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _share(client, headers, doc_id, state):
    r = client.put(f"/app/documents/{doc_id}/share", json={"state": state}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["share"]


def test_a_new_item_starts_at_its_projects_default(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _set_public(client, headers, _project(client, headers, "open"))
    _project(client, headers, "closed")

    pub = _post(client, key, _doc("open", "a"))
    priv = _post(client, key, _doc("closed", "b"))
    named = _post(client, key, _doc("open", "c", share="members"))
    assert (pub["share"], priv["share"], named["share"]) == ("public", "members", "members")

    assert client.get(f"/app/documents/{pub['id']}").status_code == 200
    assert client.get(f"/app/orgs/{org}/open/a").status_code == 200
    for d in (priv, named):
        assert client.get(f"/app/documents/{d['id']}").status_code == 404
    # A new version keeps the item's state unless the write names one.
    v2 = _post(client, key, _doc("open", "c", new_version=True))
    assert v2["share"] == "members"
    v3 = _post(client, key, _doc("open", "c", new_version=True, share="public"))
    assert v3["share"] == "public" and client.get(f"/app/orgs/{org}/open/c").status_code == 200


def test_the_link_reads_only_while_it_is_on(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    doc = _post(client, key, _doc("lab", "note"))
    did = doc["id"]
    anon_miss = client.get(f"/app/documents/{did}")
    assert anon_miss.status_code == 404

    on = _share(client, headers, did, "link")
    assert on["state"] == "link" and on["kind"] == "doc" and on["url"].count("/s/") == 1
    token = on["url"].rsplit("/s/", 1)[1]
    assert _share(client, headers, did, "link")["url"] == on["url"]  # setting it again keeps it
    hold = {"X-Share-Token": token}

    # Signed out, holding the link: the same routes a public read uses.
    assert client.get(f"/app/documents/{did}").status_code == 404  # no token: still a miss
    hit = client.get(f"/app/documents/{did}", headers=hold)
    assert hit.status_code == 200 and hit.json()["share"] is None  # a link reader sees no state
    assert client.get(f"/app/orgs/{org}/lab/note", headers=hold).status_code == 200
    assert client.get(f"/app/documents/{did}/versions", headers=hold).status_code == 200
    shared = client.get(f"/app/shared/{token}")
    assert shared.status_code == 200
    assert shared.json() == {
        "kind": "doc", "org": org, "project": "lab", "doc_id": did, "path": f"/@{org}/lab/note",
    }
    # Unlisted: not in the org library, for a stranger or on the member's public view.
    assert client.get(f"/app/orgs/{org}/library").status_code == 404
    assert client.get(f"/app/orgs/{org}/library?scope=public", headers=headers).json()["documents"] == []
    assert client.get(f"/app/orgs/{org}/library", headers=headers).json()["documents"][0]["share"] == "link"

    # Off: the same link is the same 404 as everything else.
    off = _share(client, headers, did, "members")
    assert off == {"state": "members", "kind": "doc", "url": None, "can_publish": True}
    dead = client.get(f"/app/documents/{did}", headers=hold)
    assert dead.status_code == 404 and dead.json() == anon_miss.json()
    assert client.get(f"/app/shared/{token}").status_code == 404

    # On again: a new link; the old one stays dead.
    again = _share(client, headers, did, "link")
    new_token = again["url"].rsplit("/s/", 1)[1]
    assert new_token != token
    assert client.get(f"/app/documents/{did}", headers=hold).status_code == 404
    assert client.get(f"/app/documents/{did}", headers={"X-Share-Token": new_token}).status_code == 200
    # Public clears the token too.
    assert _share(client, headers, did, "public")["url"] is None
    assert client.get(f"/app/shared/{new_token}").status_code == 404
    assert client.get(f"/app/documents/{did}").status_code == 200


def test_every_miss_is_the_same_404(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    doc = _post(client, key, _doc("lab", "private-note"))
    tok = _share(client, headers, _post(client, key, _doc("lab", "linked"))["id"], "link")["url"]
    token = tok.rsplit("/s/", 1)[1]
    stranger, _ = _signup(client, f"stranger-{uuid4()}@example.com")

    misses = [
        client.get(f"/app/orgs/{org}/lab/private-note"),  # Members, signed out
        client.get(f"/app/orgs/{org}/lab/private-note", headers=stranger),  # another org
        client.get(f"/app/orgs/{org}/lab/private-note", headers={"X-Share-Token": token}),  # another item's link
        client.get(f"/app/orgs/{org}/lab/nope"),  # no such item
        client.get(f"/app/orgs/{org}/lab/linked", headers={"X-Share-Token": "x" * 32}),  # a wrong token
    ]
    assert {m.status_code for m in misses} == {404}
    assert len({m.text for m in misses}) == 1
    assert client.get(f"/app/documents/{doc['id']}", headers=stranger).status_code == 404
    assert client.get("/app/shared/" + "y" * 32).json() == client.get("/app/shared/short").json()
    # Setting a state is the member's own: another org's id is the read's 404.
    r = client.put(f"/app/documents/{doc['id']}/share", json={"state": "public"}, headers=stranger)
    assert r.status_code == 404
    assert client.put(f"/app/documents/{doc['id']}/share", json={"state": "public"}).status_code == 401


def _book(client, key, project, share=None):
    chapters = []
    for n in (1, 2):
        body = _doc(project, f"ch{n}", book={"slug": "guide", "kind": "codebase", "title": "Guide"},
                    chapter={"key": f"ch{n}", "position": n}, lang="en")
        if share and n == 1:
            body["share"] = share
        chapters.append(_post(client, key, body))
    return chapters


def test_a_books_state_covers_its_chapters(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")  # private: the book starts as Members
    ch1, ch2 = _book(client, key, "lab")
    assert ch1["share"] == ch2["share"] == "members"
    book_path = f"/app/orgs/{org}/lab/books/guide"
    assert client.get(book_path).status_code == 404
    assert client.get(f"/app/documents/{ch1['id']}").status_code == 404

    # Public through the book's own switch: the book and every chapter read signed out.
    r = client.put("/app/books/lab/guide/share", json={"state": "public"}, headers=headers)
    assert r.status_code == 200 and r.json()["share"]["kind"] == "book"
    assert client.get(book_path).status_code == 200
    for ch in (ch1, ch2):
        assert client.get(f"/app/documents/{ch['id']}").status_code == 200
    lib = client.get(f"/app/orgs/{org}/library").json()
    assert [b["slug"] for b in lib["books"]] == ["guide"] and lib["documents"] == []

    # A chapter has no state of its own: its switch sets the book's.
    link = _share(client, headers, ch2["id"], "link")
    assert link["kind"] == "book"
    token = link["url"].rsplit("/s/", 1)[1]
    hold = {"X-Share-Token": token}
    assert client.get(book_path).status_code == 404
    assert client.get(book_path, headers=hold).status_code == 200
    for ch in (ch1, ch2):
        assert client.get(f"/app/documents/{ch['id']}").status_code == 404
        assert client.get(f"/app/documents/{ch['id']}", headers=hold).status_code == 200
    assert client.get(f"/app/shared/{token}").json()["path"] == f"/@{org}/lab/books/guide"
    assert client.get(f"/app/orgs/{org}/library").status_code == 404  # unlisted
    member = client.get("/app/books/lab/guide", headers=headers).json()
    assert member["share"]["state"] == "link"


def test_a_book_write_and_the_manifest_put_take_share(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    _book(client, key, "lab", share="public")
    assert client.get(f"/app/orgs/{org}/lab/books/guide").status_code == 200
    manifest = client.get("/api/books/lab/guide", headers=key).json()
    put = client.put("/api/books/lab/guide", headers=key, json={
        "title": "Guide", "kind": "codebase", "share": "members",
        "chapters": [{"key": c["key"], "position": c["position"],
                      "variants": {v["lang"]: v["rel_path"] for v in c["variants"]}}
                     for c in manifest["chapters"]],
    })
    assert put.status_code == 200, put.text
    assert put.json()["share"] == "members" and put.json()["committed"] is False
    assert client.get(f"/app/orgs/{org}/lab/books/guide").status_code == 404


def test_reader_state_has_no_link_reader(documents_client):
    client, _ = documents_client
    headers, tenant, _org_slug, key = _org(client)
    _project(client, headers, "lab")
    doc = _post(client, key, _doc("lab", "note"))
    token = _share(client, headers, doc["id"], "link")["url"].rsplit("/s/", 1)[1]
    stem = "2026-03-01-note"
    # Signed out: the reader-state routes stay session-only.
    assert client.get(f"/app/reader/docs/{tenant}/lab/{stem}",
                      headers={"X-Share-Token": token}).status_code == 401
    # Another org's signed-in reader holding the link reads the content, but no state.
    other, _ = _signup(client, f"reader-{uuid4()}@example.com")
    assert client.get(f"/app/documents/{doc['id']}",
                      headers={**other, "X-Share-Token": token}).status_code == 200
    assert client.get(f"/app/reader/docs/{tenant}/lab/{stem}", headers=other).status_code == 404
    _share(client, headers, doc["id"], "public")
    assert client.get(f"/app/reader/docs/{tenant}/lab/{stem}", headers=other).status_code == 200


def test_the_key_route_sets_a_state(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    doc = _post(client, key, _doc("lab", "note"))
    _book(client, key, "lab")
    r = client.post("/api/share", headers=key, json={"document": doc["rel_path"], "state": "link"})
    assert r.status_code == 200, r.text
    assert r.json()["share"]["state"] == "link" and "/s/" in r.json()["share"]["url"]
    r = client.post("/api/share", headers=key, json={"book": "guide", "project": "lab", "state": "public"})
    assert r.status_code == 200 and r.json()["share"] == {
        "state": "public", "kind": "book", "url": None, "can_publish": True,
    }
    assert client.get(f"/app/orgs/{org}/lab/books/guide").status_code == 200
    assert client.post("/api/share", headers=key, json={"book": "guide", "state": "public"}).status_code == 422
    assert client.post("/api/share", headers=key, json={"document": "lab/nope.md", "state": "public"}).status_code == 404
    other_key = _key(client, _signup(client, f"o-{uuid4()}@example.com")[0])
    assert client.post("/api/share", headers=other_key,
                       json={"document": doc["rel_path"], "state": "public"}).status_code == 404
    assert client.post("/api/share", json={"document": doc["rel_path"], "state": "public"}).status_code == 401


def test_a_deleted_documents_row_goes(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    doc = _post(client, key, _doc("lab", "note", share="link"))
    assert doc["share"] == "link"
    assert client.delete(f"/api/documents/{doc['id']}", headers=key).status_code == 200
    again = _post(client, key, _doc("lab", "note"))
    assert again["share"] == "members"  # the project's default, not the old link


def test_the_fill_is_idempotent_and_keeps_a_set_state(documents_client):
    client, _ = documents_client
    headers, tenant, org, _key_h = _org(client)
    _set_public(client, headers, _project(client, headers, "old"))
    conn = db.connect()
    try:
        ids = [
            db.upsert_document(
                conn, project="old", slug=s, date="2026-01-01", title=s, tags=[],
                source_repo="r", rel_path=f"old/2026-01-01-{s}.md", markdown="body",
                tenant_id=tenant,
            )
            for s in ("one", "two")
        ]
    finally:
        conn.close()
    # Before the fill: no row, so Members (fail closed).
    assert client.get(f"/app/documents/{ids[0]}").status_code == 404
    first = _fill(client)
    assert first.added >= 2
    for i in ids:
        assert client.get(f"/app/documents/{i}").status_code == 200
    _share(client, headers, ids[1], "members")
    second = _fill(client)
    assert second.added == 0  # nothing changes on a second run
    assert client.get(f"/app/documents/{ids[1]}").status_code == 404  # the set state is kept


def test_a_reader_may_hold_several_links(documents_client):
    client, _ = documents_client
    headers, _tenant, org, key = _org(client)
    _project(client, headers, "lab")
    a = _post(client, key, _doc("lab", "one"))
    b = _post(client, key, _doc("lab", "two"))
    ta = _share(client, headers, a["id"], "link")["url"].rsplit("/s/", 1)[1]
    tb = _share(client, headers, b["id"], "link")["url"].rsplit("/s/", 1)[1]
    both = {"X-Share-Token": f"{tb},not a token,{ta}"}
    for d in (a, b):
        assert client.get(f"/app/documents/{d['id']}", headers=both).status_code == 200
    assert client.get(f"/app/documents/{a['id']}", headers={"X-Share-Token": tb}).status_code == 404
