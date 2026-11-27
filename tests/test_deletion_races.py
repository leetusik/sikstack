"""A write racing a project or org delete (``server/deletion.py``) — Postgres-gated.

Each case puts the delete inside a write's window: after the write has resolved its
project, before it lands. The write is then refused (404 or 409) or lands in a live
project row; nothing of the deleted project or org survives (a row, a file, an index
row); a project made again under the same name starts empty.

* A publish (``POST /api/documents``) and a book PUT, against a project delete and an
  org delete: the delete runs where the handler has resolved its registry project
  and has not yet taken ``WRITE_LOCK``.
* A feedback capture linking an attachment, and a design build publish, against an
  org delete (and a project delete): the capture's or the publish's transaction runs
  while the delete's is open, after it read the attachment keys and build ids. Their
  SQL is the routes': the capture inserts the event and links the uploaded attachment
  in one transaction; the publish places the folder, inserts the row, and removes the
  folder when the insert fails.
* Reader and Listen writes, keyed by the project's name: the delete runs after the
  route resolved the document and before its insert.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from uuid import UUID, uuid4

from fastapi.concurrency import run_in_threadpool
from sqlalchemy import text

from server import deletion, db
from server.design import store as design_store
from server.persistence.models import (
    DesignBuildModel,
    FeedbackAttachmentModel,
    FeedbackEventModel,
)
from tests.test_deletion import (  # noqa: F401 - kb is the fixture
    NAME_KEYED,
    _account,
    _in,
    _new_org,
    _reindex,
    _row,
    kb,
)


LISTEN_FIXTURE = Path(__file__).parent / "fixtures" / "listen" / "doc.md"


# --- a project with documents ---------------------------------------------------------


def _project(client, who, org: str, name: str) -> tuple[str, dict]:
    h = _in(who, org)
    res = client.post("/app/projects", json={"name": name}, headers=h)
    assert res.status_code == 201, res.text
    pid = res.json()["project"]["id"]
    key = client.post("/app/credentials", headers=h).json()["key"]
    return pid, {"Authorization": f"Bearer {key}"}


def _doc(slug: str, name: str) -> dict:
    return {
        "title": f"Doc {slug}", "markdown": f"# Doc {slug}\n\nBody.\n", "project": name,
        "tags": ["t", "u"], "source_repo": name, "date": "2026-03-01", "slug": slug,
    }


def _publish(client, bearer: dict, slug: str, name: str) -> dict:
    res = client.post("/api/documents", headers=bearer, json=_doc(slug, name))
    assert res.status_code == 201, res.text
    return res.json()


def _project_target(who, org: str, pid: str, name: str) -> deletion.ProjectTarget:
    return deletion.ProjectTarget(
        tenant_id=UUID(org), project_id=UUID(pid), name=name, user_id=who.user_id,
        root=deletion.tenant_root(UUID(org), None),
    )


def _tenant_target(who, org: str, name: str) -> deletion.TenantTarget:
    return deletion.TenantTarget(
        tenant_id=UUID(org), name=name, user_id=who.user_id,
        root=deletion.tenant_root(UUID(org), None),
    )


# --- what is left --------------------------------------------------------------------------


def _project_rows(client, org: str, name: str) -> list[str]:
    with client.db.connect() as conn:
        return [str(r) for r in conn.execute(
            text("SELECT id FROM projects WHERE tenant_id = :t AND name = :n"),
            {"t": org, "n": name},
        ).scalars()]


def _index_rows(org: str, name: str) -> dict[str, int]:
    conn = db.connect()
    try:
        q = lambda sql: conn.execute(sql, (org, name)).fetchone()[0]  # noqa: E731
        return {
            "documents": q("SELECT count(*) FROM documents WHERE tenant_id = ? AND project = ?"),
            "books": q("SELECT count(*) FROM books WHERE tenant_id = ? AND project = ?"),
        }
    finally:
        conn.close()


def _content(client, org: str, name: str) -> list[str]:
    root = client.root / "tenants" / org
    out = []
    for sub in (name, f".versions/{name}", f".books/{name}", f".assets/{name}"):
        folder = root / sub
        if folder.exists():
            out += [str(p.relative_to(client.root)) for p in folder.rglob("*") if p.is_file()]
    return out


def _name_keyed(client, org: str, name: str) -> dict[str, int]:
    with client.db.connect() as conn:
        return {
            table: conn.execute(
                text(f"SELECT count(*) FROM {table} WHERE tenant_id = :t AND project = :n"),
                {"t": org, "n": name},
            ).scalar_one()
            for table in NAME_KEYED
        }


def _nothing_survives(client, org: str, name: str, pid: str, *, landed_live: bool) -> None:
    """The race's outcome: nothing of the deleted project is left. When the write
    landed, it landed in a project row made after the delete (another id)."""

    rows = _project_rows(client, org, name)
    assert pid not in rows, rows
    if not landed_live:
        assert rows == [], rows
        assert _index_rows(org, name) == {"documents": 0, "books": 0}
        assert _content(client, org, name) == []
    assert not any(_name_keyed(client, org, name).values()), _name_keyed(client, org, name)


def _remade_is_empty(client, who, org: str, name: str) -> None:
    """A restart's reindex brings nothing back, and the project made again is empty."""

    _reindex(client)
    res = client.post("/app/projects", json={"name": name}, headers=_in(who, org))
    assert res.status_code == 201, res.text
    again = res.json()["project"]["id"]
    docs = client.get(f"/app/documents?project={again}", headers=_in(who, org)).json()
    assert docs["total"] == 0, docs
    assert _index_rows(org, name) == {"documents": 0, "books": 0}
    assert not any(_name_keyed(client, org, name).values())


# --- 1, 3: a publish racing a delete ---------------------------------------------------------


def _delete_inside(monkeypatch, module, attr: str, run_delete) -> dict:
    """Wrap ``module.attr`` (a sync step of the write, before ``WRITE_LOCK``) so the
    first call runs the delete, then the step itself."""

    original = getattr(module, attr)
    seen: dict = {}

    def wrapped(*args, **kwargs):
        if "outcome" not in seen:
            seen["outcome"] = run_delete()
        return original(*args, **kwargs)

    monkeypatch.setattr(module, attr, wrapped)
    return seen


def test_a_publish_racing_a_project_delete_lands_nowhere(kb, monkeypatch):
    import server.main as main

    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "racer")
    _publish(kb, bearer, "early", "racer")
    seen = _delete_inside(
        monkeypatch, main, "_check_document",
        lambda: deletion.delete_project(_project_target(owner, owner.tenant, pid, "racer")),
    )
    res = kb.post("/api/documents", headers=bearer, json=_doc("late", "racer"))
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, owner.tenant, "racer", pid, landed_live=False)
    _remade_is_empty(kb, owner, owner.tenant, "racer")


def test_a_publish_racing_an_org_delete_lands_nowhere(kb, monkeypatch):
    import server.main as main

    owner = _account(kb)
    org = _new_org(kb, owner, "Racers")
    pid, bearer = _project(kb, owner, org, "racer")
    _publish(kb, bearer, "early", "racer")
    seen = _delete_inside(
        monkeypatch, main, "_check_document",
        lambda: deletion.delete_tenant(_tenant_target(owner, org, "Racers")),
    )
    res = kb.post("/api/documents", headers=bearer, json=_doc("late", "racer"))
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, org, "racer", pid, landed_live=False)
    assert not (kb.root / "tenants" / org).exists()
    with kb.db.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM tenants WHERE id = :t"), {"t": org}).scalar_one() == 0
    conn = db.connect()
    try:
        left = conn.execute("SELECT count(*) FROM documents WHERE tenant_id = ?", (org,)).fetchone()[0]
    finally:
        conn.close()
    assert left == 0
    _reindex(kb)
    assert not (kb.root / "tenants" / org).exists()


# --- 2: a book PUT racing a delete ------------------------------------------------------------


def _book(rel: str) -> dict:
    return {"title": "Guide", "kind": "codebase", "commit": False, "chapters": [
        {"key": "ch1", "position": 1, "variants": {"en": rel}},
    ]}


def test_a_book_put_racing_a_project_delete_lands_nowhere(kb, monkeypatch):
    import server.main as main

    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "racer")
    doc = _publish(kb, bearer, "early", "racer")
    seen = _delete_inside(
        monkeypatch, main, "_tenant_root",
        lambda: deletion.delete_project(_project_target(owner, owner.tenant, pid, "racer")),
    )
    res = kb.put("/api/books/racer/guide", headers=bearer, json=_book(doc["rel_path"]))
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, owner.tenant, "racer", pid, landed_live=False)
    _remade_is_empty(kb, owner, owner.tenant, "racer")


def test_a_book_put_racing_an_org_delete_lands_nowhere(kb, monkeypatch):
    import server.main as main

    owner = _account(kb)
    org = _new_org(kb, owner, "Racers")
    pid, bearer = _project(kb, owner, org, "racer")
    doc = _publish(kb, bearer, "early", "racer")
    seen = _delete_inside(
        monkeypatch, main, "_tenant_root",
        lambda: deletion.delete_tenant(_tenant_target(owner, org, "Racers")),
    )
    res = kb.put("/api/books/racer/guide", headers=bearer, json=_book(doc["rel_path"]))
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, org, "racer", pid, landed_live=False)
    assert not (kb.root / "tenants" / org).exists()


# --- 4, 5: a capture or a design build inside the delete's transaction ------------------------


def _inside_the_delete(monkeypatch, other) -> dict:
    """Run ``other`` (another connection's transaction) in a thread right after the
    delete has read the build ids and attachment keys, while its transaction is open.
    ``blocked`` says whether ``other`` was still waiting a second later."""

    original = deletion._builds_and_keys
    seen: dict = {}

    async def wrapped(session, project_ids):
        found = await original(session, project_ids)
        if "thread" not in seen:
            worker = threading.Thread(target=lambda: seen.update(result=other()))
            worker.start()
            worker.join(1.0)  # the event loop waits too: the delete is on it
            seen["thread"] = worker
            seen["blocked"] = worker.is_alive()
        return found

    monkeypatch.setattr(deletion, "_builds_and_keys", wrapped)
    return seen


def _attachment_capture(client, pid: str):
    """An uploaded, unlinked attachment (its file and row), and the capture that links
    it: the event insert and the link in one transaction, as
    ``create_feedback_event_with_attachments`` does."""

    key = f"fb/late-{uuid4().hex}.png"
    path = client.root / "attachments" / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"img")
    with client.db.begin() as conn:
        attachment = _row(conn, FeedbackAttachmentModel, id=uuid4(), storage_key=key,
                          claimed_source_product="p")["id"]

    def capture():
        try:
            with client.db.begin() as conn:
                event = _row(conn, FeedbackEventModel, id=uuid4(), project_id=UUID(pid),
                             source_product="p")["id"]
                conn.execute(
                    text("UPDATE feedback_attachments SET feedback_id = :f WHERE id = :a"),
                    {"f": event, "a": attachment},
                )
            return "captured"
        except Exception as exc:  # noqa: BLE001 - the route answers an error, the upload stays
            return f"refused: {type(exc).__name__}"

    return capture


def _orphan_attachments(client) -> list[str]:
    folder = client.root / "attachments"
    files = [str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file()] if folder.is_dir() else []
    with client.db.connect() as conn:
        keys = set(conn.execute(text("SELECT storage_key FROM feedback_attachments")).scalars())
    return [f for f in files if f not in keys]


def _build_publish(client, pid: str):
    """``publish_build``'s order: the folder placed, then the row; a failed insert
    removes the folder."""

    def publish():
        build = design_store.new_build_id()
        folder = client.root / "builds" / build
        folder.mkdir(parents=True)
        (folder / "index.html").write_text("<p>late</p>")
        try:
            with client.db.begin() as conn:
                _row(conn, DesignBuildModel, id=build, project_id=UUID(pid))
            return "published"
        except Exception as exc:  # noqa: BLE001
            design_store.remove_folder(folder)
            return f"refused: {type(exc).__name__}"

    return publish


def _orphan_builds(client) -> list[str]:
    folder = client.root / "builds"
    names = [p.name for p in folder.iterdir() if p.is_dir() and design_store.is_build_id(p.name)] \
        if folder.is_dir() else []
    with client.db.connect() as conn:
        ids = set(conn.execute(text("SELECT id FROM design_builds")).scalars())
    return [n for n in names if n not in ids]


def _race_inside(kb, monkeypatch, make_other, kind: str) -> dict:
    owner = _account(kb)
    org = _new_org(kb, owner, "Racers")
    pid, bearer = _project(kb, owner, org, "racer")
    _publish(kb, bearer, "early", "racer")
    seen = _inside_the_delete(monkeypatch, make_other(kb, pid))
    if kind == "tenant":
        res = kb.request("DELETE", "/app/tenant", json={"name": "Racers"}, headers=_in(owner, org))
        assert res.status_code == 200, res.text
    else:
        res = kb.request("DELETE", f"/app/projects/{pid}", json={"name": "racer"},
                         headers=_in(owner, org))
        assert res.status_code == 204, res.text
    seen["thread"].join(30)
    monkeypatch.undo()
    return seen


def test_a_capture_with_an_attachment_racing_an_org_delete_leaves_no_orphan_file(kb, monkeypatch):
    seen = _race_inside(kb, monkeypatch, _attachment_capture, "tenant")
    assert seen["blocked"], f"the capture did not wait for the delete: {seen.get('result')}"
    assert seen["result"].startswith("refused"), seen
    assert _orphan_attachments(kb) == []


def test_a_capture_with_an_attachment_racing_a_project_delete_leaves_no_orphan_file(kb, monkeypatch):
    seen = _race_inside(kb, monkeypatch, _attachment_capture, "project")
    assert seen["blocked"] and seen["result"].startswith("refused"), seen
    assert _orphan_attachments(kb) == []


def test_a_design_build_racing_an_org_delete_leaves_no_orphan_folder(kb, monkeypatch):
    seen = _race_inside(kb, monkeypatch, _build_publish, "tenant")
    assert seen["blocked"], f"the build publish did not wait for the delete: {seen.get('result')}"
    assert seen["result"].startswith("refused"), seen
    assert _orphan_builds(kb) == []


def test_a_design_build_racing_a_project_delete_leaves_no_orphan_folder(kb, monkeypatch):
    seen = _race_inside(kb, monkeypatch, _build_publish, "project")
    assert seen["blocked"] and seen["result"].startswith("refused"), seen
    assert _orphan_builds(kb) == []


# --- 6: reader and Listen state racing a project delete ----------------------------------------


def _delete_after(monkeypatch, module, attr: str, target) -> dict:
    """Wrap the async ``module.attr`` (the route's document resolve) so the delete
    runs once it has returned, before the route's insert."""

    original = getattr(module, attr)
    seen: dict = {}

    async def wrapped(*args, **kwargs):
        found = await original(*args, **kwargs)
        if "outcome" not in seen:
            seen["outcome"] = await run_in_threadpool(deletion.delete_project, target)
        return found

    monkeypatch.setattr(module, attr, wrapped)
    return seen


def _reader_case(kb, monkeypatch, module_name: str, attr: str, call):
    import importlib

    module = importlib.import_module(module_name)
    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "racer")
    _publish(kb, bearer, "early", "racer")
    conn = db.connect()
    try:  # a native document, which a Listen makes a unit for
        db.upsert_document(
            conn, project="racer", slug="talk", date="2026-03-01", title="Talk", tags=[],
            source_repo=None, rel_path="racer/2026-03-01-talk.md", markdown="Body.",
            format="native", version=1, tenant_id=owner.tenant,
            source=LISTEN_FIXTURE.read_text(encoding="utf-8"),
        )
    finally:
        conn.close()
    seen = _delete_after(monkeypatch, module, attr,
                         _project_target(owner, owner.tenant, pid, "racer"))
    res = call(kb, owner)
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, owner.tenant, "racer", pid, landed_live=False)
    _remade_is_empty(kb, owner, owner.tenant, "racer")


def _where(owner) -> dict:
    return {"org": owner.tenant, "project": "racer", "doc": "2026-03-01-early"}


def test_a_reader_position_racing_a_project_delete_leaves_no_row(kb, monkeypatch):
    _reader_case(kb, monkeypatch, "server.reader_api", "_doc_ref", lambda c, o: c.put(
        "/app/reader/positions", headers=o.h, json={**_where(o), "fraction": 0.5},
    ))


def test_a_reader_bookmark_racing_a_project_delete_leaves_no_row(kb, monkeypatch):
    _reader_case(kb, monkeypatch, "server.reader_api", "_doc_ref", lambda c, o: c.post(
        "/app/reader/bookmarks", headers=o.h,
        json={**_where(o), "id": str(uuid4()), "anchor": {"fraction": 0.5}},
    ))


def test_a_listen_position_racing_a_project_delete_leaves_no_row(kb, monkeypatch):
    _reader_case(kb, monkeypatch, "server.listen_api", "_resolve", lambda c, o: c.put(
        "/app/listen/position", headers=o.h, json={**_where(o), "seconds": 3.0},
    ))


def test_a_listen_start_racing_a_project_delete_leaves_no_row(kb, monkeypatch):
    _reader_case(kb, monkeypatch, "server.listen_api", "_resolve", lambda c, o: c.post(
        "/app/listen/start", headers=o.h, json={**_where(o), "doc": "2026-03-01-talk"},
    ))


def test_a_reader_write_with_no_registry_row_still_lands(kb):
    """A project whose documents predate the registry (no ``projects`` row) keeps its
    reader state: only a project that is gone refuses."""

    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "legacy")
    _publish(kb, bearer, "early", "legacy")
    with kb.db.begin() as conn:  # as if never registered
        conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": pid})
    res = kb.put("/app/reader/positions", headers=owner.h, json={
        "org": owner.tenant, "project": "legacy", "doc": "2026-03-01-early", "fraction": 0.5,
    })
    assert res.status_code == 200, res.text
    assert _name_keyed(kb, owner.tenant, "legacy")["reader_positions"] == 1


def test_a_reader_write_waits_for_a_delete_holding_the_project(kb):
    """A reader insert issued while a delete holds the project row waits for it, and
    is refused once it commits."""

    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "racer")
    _publish(kb, bearer, "early", "racer")
    answers: dict = {}
    with kb.db.connect() as held_conn:
        held = held_conn.begin()
        held_conn.execute(text("SELECT id FROM projects WHERE id = :p FOR UPDATE"), {"p": pid})
        worker = threading.Thread(target=lambda: answers.update(res=kb.put(
            "/app/reader/positions", headers=owner.h,
            json={**_where(owner), "fraction": 0.5},
        )))
        worker.start()
        time.sleep(1.0)
        assert worker.is_alive(), answers["res"].text
        # The delete's work while it holds the row: its folders aside, the row gone.
        root = deletion.tenant_root(UUID(owner.tenant), None)
        staged = deletion.stage("project", UUID(pid), deletion.project_paths(root, "racer"),
                                builds=[], attachments=[])
        held_conn.execute(text("DELETE FROM projects WHERE id = :p"), {"p": pid})
        held.commit()
    worker.join(30)
    deletion.discard(staged.folder)
    assert answers["res"].status_code == 404, answers["res"].text
    assert not any(_name_keyed(kb, owner.tenant, "racer").values())


def _share_case(kb, monkeypatch, path_of):
    """A share switch whose project is deleted after it found its item: the delete
    runs at ``sharing.may_publish``, which the switch calls after its index lookup."""

    from server import sharing

    owner = _account(kb)
    pid, bearer = _project(kb, owner, owner.tenant, "racer")
    doc = _publish(kb, bearer, "early", "racer")
    res = kb.put("/api/books/racer/guide", headers=bearer, json=_book(doc["rel_path"]))
    assert res.status_code in (200, 201), res.text
    original = sharing.may_publish
    seen: dict = {}

    async def wrapped(*args):
        if "outcome" not in seen:
            seen["outcome"] = await run_in_threadpool(
                deletion.delete_project, _project_target(owner, owner.tenant, pid, "racer")
            )
        return await original(*args)

    monkeypatch.setattr(sharing, "may_publish", wrapped)
    res = kb.put(path_of(doc), headers=owner.h, json={"state": "public"})
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code in (404, 409), res.text
    _nothing_survives(kb, owner.tenant, "racer", pid, landed_live=False)
    with kb.db.connect() as conn:
        shares = conn.execute(text(
            "SELECT count(*) FROM item_shares s JOIN projects p ON p.id = s.project_id"
            " WHERE p.tenant_id = :t AND p.name = 'racer'"
        ), {"t": owner.tenant}).scalar_one()
    assert shares == 0


def test_a_document_share_switch_racing_a_project_delete_makes_no_project(kb, monkeypatch):
    _share_case(kb, monkeypatch, lambda doc: f"/app/documents/{doc['id']}/share")


def test_a_book_share_switch_racing_a_project_delete_makes_no_project(kb, monkeypatch):
    _share_case(kb, monkeypatch, lambda doc: "/app/books/racer/guide/share")


def test_a_publish_making_a_new_project_racing_an_org_delete_is_refused(kb, monkeypatch):
    """The write's get-or-create of a new project runs after the org is gone (its
    insert's ``tenants`` row is missing): a 409, not a 500."""

    from server.accounts.service import AccountsService

    owner = _account(kb)
    org = _new_org(kb, owner, "Racers")
    _pid, bearer = _project(kb, owner, org, "racer")
    original = AccountsService.get_or_create_project
    seen: dict = {}

    async def wrapped(self, tenant_id, name):
        if "outcome" not in seen:
            seen["outcome"] = await run_in_threadpool(
                deletion.delete_tenant, _tenant_target(owner, org, "Racers")
            )
        return await original(self, tenant_id, name)

    monkeypatch.setattr(AccountsService, "get_or_create_project", wrapped)
    res = kb.post("/api/documents", headers=bearer, json=_doc("late", "fresh"))
    monkeypatch.undo()
    assert isinstance(seen["outcome"], deletion.Deleted), seen
    assert res.status_code == 409, res.text
    assert _project_rows(kb, org, "fresh") == []
    assert not (kb.root / "tenants" / org).exists()
