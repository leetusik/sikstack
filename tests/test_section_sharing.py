"""Section search respects each item's sharing (P75) — Postgres-gated, like the share tests.

* a key reads its own org's sections (``GET /api/sections/search``), with reader URLs on
  the org's slug, a chapter's landing on its chapter;
* ``GET /api/library`` lists the key's books with their chapters, plus loose documents;
* the in-process door (``sections.viewer_for``): a member reads every item; anyone else
  only the Public ones, so a Members or Link item never appears; a chapter follows its
  book's state;
* a ``workspace`` key gets the existing 403 on both routes.
"""
from __future__ import annotations

from server import db, sections
from server import search as search_mod
from tests.test_documents_api import _project, documents_client  # noqa: F401
from tests.test_item_share import _book, _doc, _org, _post, _share


def _search(client, tenant, q, *, member):
    async def run():
        viewer = await sections.viewer_for(tenant, member=member)
        conn = db.connect()
        try:
            return search_mod.search_sections(conn, q, tenant=str(tenant), limit=20, viewer=viewer)
        finally:
            conn.close()

    return client.portal.call(run)


def _body(word):
    return f"Lead about {word}.\n\n## Part {word}\n\nThe {word} section text.\n"


def test_sections_follow_each_items_sharing(documents_client):
    from uuid import UUID

    client, _ = documents_client
    headers, tenant, org, key = _org(client)
    _project(client, headers, "lab")
    pub = _post(client, key, _doc("lab", "pub", markdown=_body("zebra"), share="public"))
    _post(client, key, _doc("lab", "mem", markdown=_body("zebra")))
    linked = _post(client, key, _doc("lab", "lnk", markdown=_body("zebra")))
    _share(client, headers, linked["id"], "link")
    _book(client, key, "lab")  # Members; chapters say "Body of chN."

    # A key reads its own org: every item, URLs on the org slug.
    r = client.get("/api/sections/search", params={"q": "zebra", "limit": 50}, headers=key)
    assert r.status_code == 200, r.text
    hits = r.json()["results"]
    assert {h["document"]["rel_path"].split("-", 3)[-1] for h in hits} == {"pub.md", "mem.md", "lnk.md"}
    part = next(h for h in hits if h["anchor"] == "part-zebra" and h["document"]["id"] == pub["id"])
    assert part["url"].endswith(f"/@{org}/lab/pub#part-zebra")
    ch = client.get("/api/sections/search", params={"q": "ch1"}, headers=key).json()["results"]
    assert ch and ch[0]["document"]["book"] == "guide" and ch[0]["document"]["chapter"] == "ch1"
    assert f"/@{org}/lab/books/guide/ch1" in ch[0]["url"]

    lib = client.get("/api/library", headers=key).json()
    assert [b["slug"] for b in lib["books"]] == ["guide"]
    assert [c["key"] for c in lib["books"][0]["chapters"]] == ["ch1", "ch2"]
    assert {d["slug"] for d in lib["documents"]} == {"pub", "mem", "lnk"}

    # In process: a member reads all; a stranger only the Public item.
    tid = UUID(tenant)
    member = _search(client, tid, "zebra", member=True)
    assert {h["document"]["id"] for h in member["results"]} >= {pub["id"], linked["id"]}
    stranger = _search(client, tid, "zebra", member=False)
    assert {h["document"]["id"] for h in stranger["results"]} == {pub["id"]}
    assert _search(client, tid, "ch1", member=False)["total"] == 0

    # A chapter follows its book's state.
    assert client.put("/app/books/lab/guide/share", json={"state": "public"},
                      headers=headers).status_code == 200
    assert _search(client, tid, "ch1", member=False)["total"] >= 1


def test_a_workspace_key_is_refused(documents_client):
    client, _ = documents_client
    headers, _tenant, _org_slug, _key = _org(client)
    pid = _project(client, headers, "lab")
    res = client.post(f"/app/projects/{pid}/credentials", json={"scope": "workspace"}, headers=headers)
    assert res.status_code == 201, res.text
    ws = {"Authorization": f"Bearer {res.json()['key']}"}
    assert client.get("/api/sections/search", params={"q": "x"}, headers=ws).status_code == 403
    assert client.get("/api/library", headers=ws).status_code == 403
