"""Who may publish an item, the once-ever fill, and what a cache may keep — a core test.

Postgres-gated like ``tests/test_org_invites``. Proved here:

* only the owner publishes: a plain member's Public is a 403 on every door (the
  document and book switches, ``POST /api/share`` and a write's ``share`` with a project
  key the member minted, and the member's own session on ``/api``), and nothing is
  written; the owner's Public, the owner's session on ``/api`` and an org key's Public
  succeed; a member's Link and Members succeed everywhere, an unpublish included;
* a member's read of an item's sharing says whether the reader may publish
  (``can_publish``), so the switch can say why Public is off;
* the day-one fill runs once, ever: it fills a public project's existing items on its
  first run, and once it ran (or the owner toggled the project) no restart fills again;
* a read made with a link token is private to caches (``Cache-Control``), a Public
  read may be ``public``;
* a write or version to an existing item that names no ``share`` keeps its state and
  its link, and a book's next chapter keeps the book's.
"""

from __future__ import annotations

import base64
import io

from sqlalchemy import text

from server import db
from tests.test_org_invites import _account, _in, _invite, org  # noqa: F401


def _doc(project, slug, **over):
    return {
        "title": f"Doc {slug}", "markdown": f"# Doc {slug}\n\nBody of {slug}.\n",
        "project": project, "tags": ["t", "u"], "source_repo": project,
        "date": "2026-03-01", "slug": slug, **over,
    }


def _chapter(project, n, **over):
    return _doc(
        project, f"ch{n}", book={"slug": "guide", "kind": "codebase", "title": "Guide"},
        chapter={"key": f"ch{n}", "position": n}, lang="en", **over,
    )


def _bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def _team(client):
    """An owner, a plain member of the owner's org, the private project ``secret``, a
    document and a two-chapter book in it, the owner's org key and the member's
    project key."""

    owner = _account(client)
    oid = owner["default_org"]
    member = _account(client)
    code = _invite(client, owner, oid, member["email"])
    assert client.post(f"/app/invite/{code}/accept", headers=member["h"]).status_code == 200
    oh, mh = _in(owner["h"], oid), _in(member["h"], oid)
    res = client.post("/app/projects", json={"name": "secret"}, headers=oh)
    assert res.status_code == 201, res.text
    pid = res.json()["project"]["id"]
    okey = _bearer(client.post("/app/credentials", headers=oh).json()["key"])
    res = client.post(f"/app/projects/{pid}/credentials", headers=mh)
    assert res.status_code == 201, res.text  # a member mints project keys
    mkey = _bearer(res.json()["key"])
    doc = client.post("/api/documents", headers=okey, json=_doc("secret", "plan"))
    assert doc.status_code == 201 and doc.json()["share"] == "members", doc.text
    for n in (1, 2):
        ch = client.post("/api/documents", headers=okey, json=_chapter("secret", n))
        assert ch.status_code == 201, ch.text
    return {
        "oid": oid, "pid": pid, "oh": oh, "mh": mh, "okey": okey, "mkey": mkey,
        "doc": doc.json(),
    }


def _manifest_put(client, key, share):
    manifest = client.get("/api/books/secret/guide", headers=key).json()
    return client.put("/api/books/secret/guide", headers=key, json={
        "title": "Guide", "kind": "codebase", "share": share,
        "chapters": [{"key": c["key"], "position": c["position"],
                      "variants": {v["lang"]: v["rel_path"] for v in c["variants"]}}
                     for c in manifest["chapters"]],
    })


def _anon_doc(client, doc_id) -> int:
    return client.get(f"/app/documents/{doc_id}").status_code


def _anon_book(client, oid) -> int:
    return client.get(f"/app/orgs/{oid}/secret/books/guide").status_code


def test_a_member_cannot_publish_on_any_door(org):
    t = _team(org)
    did, rel = t["doc"]["id"], t["doc"]["rel_path"]

    # 1. The reader's switches.
    r = org.put(f"/app/documents/{did}/share", json={"state": "public"}, headers=t["mh"])
    assert r.status_code == 403, r.text
    r = org.put("/app/books/secret/guide/share", json={"state": "public"}, headers=t["mh"])
    assert r.status_code == 403, r.text
    # 2. POST /api/share with the member's project key, and with the member's session.
    for who in (t["mkey"], t["mh"]):
        r = org.post("/api/share", headers=who, json={"document": rel, "state": "public"})
        assert r.status_code == 403, r.text
        r = org.post("/api/share", headers=who,
                     json={"book": "guide", "project": "secret", "state": "public"})
        assert r.status_code == 403, r.text
    # 3. A write's share=public with that key: refused before anything is written.
    r = org.post("/api/documents", headers=t["mkey"], json=_doc("secret", "leak", share="public"))
    assert r.status_code == 403, r.text
    conn = db.connect()
    try:
        assert db.get_document_by_path_or_alias(
            conn, "secret/2026-03-01-leak.md", tenant_id=t["oid"]
        ) is None
    finally:
        conn.close()
    r = org.post("/api/documents", headers=t["mkey"],
                 json=_doc("secret", "plan", new_version=True, share="public"))
    assert r.status_code == 403, r.text
    assert _manifest_put(org, t["mkey"], "public").status_code == 403
    # Nothing reads signed out.
    assert _anon_doc(org, did) == 404 and _anon_book(org, t["oid"]) == 404

    # A member's Link and Members succeed on every door.
    r = org.put(f"/app/documents/{did}/share", json={"state": "link"}, headers=t["mh"])
    assert r.status_code == 200 and r.json()["share"]["state"] == "link"
    r = org.post("/api/share", headers=t["mkey"], json={"document": rel, "state": "members"})
    assert r.status_code == 200 and r.json()["share"]["state"] == "members"
    r = org.put("/app/books/secret/guide/share", json={"state": "link"}, headers=t["mh"])
    assert r.status_code == 200 and r.json()["share"]["state"] == "link"
    r = org.post("/api/documents", headers=t["mkey"], json=_doc("secret", "linked", share="link"))
    assert r.status_code == 201 and r.json()["share"] == "link"
    assert _manifest_put(org, t["mkey"], "members").status_code == 200

    # The owner publishes: the switch, the owner's own session on /api, the org key.
    r = org.put(f"/app/documents/{did}/share", json={"state": "public"}, headers=t["oh"])
    assert r.status_code == 200 and _anon_doc(org, did) == 200
    r = org.post("/api/share", headers=t["oh"],
                 json={"book": "guide", "project": "secret", "state": "public"})
    assert r.status_code == 200 and _anon_book(org, t["oid"]) == 200
    r = org.post("/api/documents", headers=t["okey"], json=_doc("secret", "open", share="public"))
    assert r.status_code == 201 and r.json()["share"] == "public"
    assert _anon_doc(org, r.json()["id"]) == 200
    assert _manifest_put(org, t["okey"], "public").status_code == 200

    # A member may still take an item out of public view (Members and Link are a member's).
    r = org.put(f"/app/documents/{did}/share", json={"state": "members"}, headers=t["mh"])
    assert r.status_code == 200 and _anon_doc(org, did) == 404


def test_a_members_read_says_who_publishes(org):
    t = _team(org)
    did = t["doc"]["id"]
    owner_read = org.get(f"/app/documents/{did}", headers=t["oh"]).json()["share"]
    member_read = org.get(f"/app/documents/{did}", headers=t["mh"]).json()["share"]
    assert owner_read["can_publish"] is True and member_read["can_publish"] is False
    for who, can in ((t["oh"], True), (t["mh"], False)):
        book = org.get("/app/books/secret/guide", headers=who).json()["share"]
        assert book["can_publish"] is can
        slug = org.get(f"/app/orgs/{t['oid']}/secret/books/guide", headers=who).json()["share"]
        assert slug["can_publish"] is can
    # The switch's own answer carries it too, so a change keeps the switch right.
    r = org.put(f"/app/documents/{did}/share", json={"state": "link"}, headers=t["mh"])
    assert r.json()["share"]["can_publish"] is False
    r = org.put("/app/books/secret/guide/share", json={"state": "link"}, headers=t["oh"])
    assert r.json()["share"]["can_publish"] is True


def _boot(client):
    """What the API runs at start-up: the once-ever fill."""

    from server import sharing

    async def run():
        conn = db.connect()
        try:
            return await sharing.fill_once(conn)
        finally:
            conn.close()

    return client.portal.call(run)


def _seed(tenant, project, slug):
    conn = db.connect()
    try:
        return db.upsert_document(
            conn, project=project, slug=slug, date="2026-01-01", title=slug, tags=[],
            source_repo="r", rel_path=f"{project}/2026-01-01-{slug}.md", markdown="body",
            related=[], version=1, tenant_id=tenant,
        )
    finally:
        conn.close()


def _set_visibility_before_sharing(client, project_id, visibility):
    """A project made public before item sharing existed: set in the registry directly,
    never through the owner's toggle (which settles the project)."""

    with client.db.begin() as c:
        c.execute(text("UPDATE projects SET visibility = :v WHERE id = :id"),
                  {"v": visibility, "id": project_id})


def test_the_fill_runs_once_ever(org):
    owner = _account(org)
    oid = owner["default_org"]
    h = _in(owner["h"], oid)
    pid_open = org.post("/app/projects", json={"name": "open"}, headers=h).json()["project"]["id"]
    pid_quiet = org.post("/app/projects", json={"name": "quiet"}, headers=h).json()["project"]["id"]
    _set_visibility_before_sharing(org, pid_open, "public")
    old_open = _seed(oid, "open", "old")
    old_quiet = _seed(oid, "quiet", "old")
    # Day one (the app's own start-up may have run first): an existing item of a public
    # project reads Public, a private one's stays Members, and a second run adds nothing.
    _boot(org)
    assert _anon_doc(org, old_open) == 200 and _anon_doc(org, old_quiet) == 404
    again = _boot(org)
    assert again is None or again.added == 0

    # The owner switches "quiet" to New items public: nothing existing changes, and a
    # restart (the next fill) changes nothing either (probe p2, inverted).
    r = org.patch(f"/app/projects/{pid_quiet}", json={"visibility": "public"}, headers=h)
    assert r.status_code == 200
    assert _anon_doc(org, old_quiet) == 404
    _boot(org)
    assert _anon_doc(org, old_quiet) == 404

    # Even with every share row gone, a project the fill already saw is never filled again.
    with org.db.begin() as c:
        c.execute(text("DELETE FROM item_shares WHERE project_id = :p AND kind <> 'fill'"),
                  {"p": pid_open})
    assert _anon_doc(org, old_open) == 404
    _boot(org)
    assert _anon_doc(org, old_open) == 404

    # A project born after the first run and toggled public before any restart.
    pid_late = org.post("/app/projects", json={"name": "late"}, headers=h).json()["project"]["id"]
    late = _seed(oid, "late", "old")
    assert org.patch(f"/app/projects/{pid_late}", json={"visibility": "public"},
                     headers=h).status_code == 200
    _boot(org)
    assert _anon_doc(org, late) == 404


def _png() -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (8, 6), (200, 10, 10)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_a_link_read_is_private_to_caches(org):
    owner = _account(org)
    oid = owner["default_org"]
    h = _in(owner["h"], oid)
    org.post("/app/projects", json={"name": "pics"}, headers=h)
    key = _bearer(org.post("/app/credentials", headers=h).json()["key"])
    slug = f"org-{oid[:8]}"
    assert org.patch("/app/tenant", json={"slug": slug}, headers=h).status_code == 200
    body = {"title": "Images", "format": "native", "markdown": "## Images\n\nA body.\n",
            "project": "pics", "tags": ["a", "b"], "source_repo": "r", "date": "2026-10-21",
            "slug": "images", "assets": [{"name": "red", "media_type": "image/png",
                                           "content_base64": _png()}]}
    d = org.post("/api/documents", headers=key, json=body)
    assert d.status_code == 201, d.text
    did, f = d.json()["id"], d.json()["assets"]["red"]["file"]
    on = org.put(f"/app/documents/{did}/share", json={"state": "link"}, headers=h).json()["share"]
    token = on["url"].rsplit("/s/", 1)[1]
    hold = {"X-Share-Token": token}

    def scope(path, headers):
        r = org.get(path, headers=headers)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
        return r.headers.get("cache-control") or ""

    def private(value):
        return "public" not in value and ("private" in value or "no-store" in value)

    # A link holder's reads: the image (both addresses), the document, the link itself.
    assert private(scope(f"/app/documents/{did}/assets/{f}", hold))
    assert private(scope(f"/app/orgs/{slug}/pics/images/assets/{f}", hold))
    assert private(scope(f"/app/documents/{did}", hold))
    assert private(scope(f"/app/orgs/{slug}/pics/images", hold))
    assert private(scope(f"/app/shared/{token}", {}))
    # A member's read stays private.
    assert private(scope(f"/app/documents/{did}/assets/{f}", h))
    # A Public read may be shared by a cache, with or without a token held.
    org.put(f"/app/documents/{did}/share", json={"state": "public"}, headers=h)
    assert scope(f"/app/documents/{did}/assets/{f}", {}).startswith("public")
    assert scope(f"/app/documents/{did}/assets/{f}", hold).startswith("public")


def test_a_write_keeps_sharing_unless_it_names_it(org):
    owner = _account(org)
    oid = owner["default_org"]
    h = _in(owner["h"], oid)
    org.post("/app/projects", json={"name": "lab"}, headers=h)
    key = _bearer(org.post("/app/credentials", headers=h).json()["key"])
    # A new document and a new book's first chapter, as explain sends them: Members.
    d = org.post("/api/documents", headers=key, json=_doc("lab", "ref", share="members")).json()
    assert d["share"] == "members"
    ch1 = org.post("/api/documents", headers=key,
                   json=_doc("lab", "ch1", book={"slug": "guide", "kind": "codebase",
                                                 "title": "Guide"},
                             chapter={"key": "ch1", "position": 1}, lang="en",
                             share="members")).json()
    assert ch1["share"] == "members"
    # The operator shares the document's link; a refresh that names no share keeps it.
    on = org.put(f"/app/documents/{d['id']}/share", json={"state": "link"}, headers=h).json()
    hold = {"X-Share-Token": on["share"]["url"].rsplit("/s/", 1)[1]}
    v2 = org.post("/api/documents", headers=key, json=_doc("lab", "ref", new_version=True))
    assert v2.status_code == 201 and v2.json()["share"] == "link"
    assert org.get(f"/app/documents/{d['id']}", headers=hold).status_code == 200
    # Public stays Public across a refresh.
    org.put(f"/app/documents/{d['id']}/share", json={"state": "public"}, headers=h)
    v3 = org.post("/api/documents", headers=key, json=_doc("lab", "ref", new_version=True))
    assert v3.json()["share"] == "public" and _anon_doc(org, d["id"]) == 200
    # A Public book's next chapter, and a chapter's next version, keep the book's state.
    org.put("/app/books/lab/guide/share", json={"state": "public"}, headers=h)
    ch2 = org.post("/api/documents", headers=key,
                   json=_doc("lab", "ch2", book={"slug": "guide"},
                             chapter={"key": "ch2", "position": 2}, lang="en"))
    assert ch2.status_code == 201 and ch2.json()["share"] == "public", ch2.text
    again = org.post("/api/documents", headers=key,
                     json=_doc("lab", "ch1", book={"slug": "guide"},
                               chapter={"key": "ch1"}, lang="en"))
    assert again.status_code == 201 and again.json()["share"] == "public", again.text
    assert org.get(f"/app/orgs/{oid}/lab/books/guide").status_code == 200
