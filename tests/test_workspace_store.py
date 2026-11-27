"""The workspace store and its engine-facing API: Postgres-gated.

The sync protocol's server side (``server/workspace/``, ``server/workspace_api.py``):
a batch lands all or nothing under the project's row lock, a stale op is a 409 that
writes nothing, a resent ``batch_id`` gets its first answer, equal content is never
a conflict, appends never conflict, a move keeps its history, content is stored once
per sha, and only the project's own workspace key reaches its routes.

Like its neighbours this runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import time
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
_ENGINE_HEADERS = {"X-Sikstack-Checkout": "test-checkout", "X-Sikstack-Engine": "v99"}


@pytest.fixture
def store(tmp_path, monkeypatch):
    """``(client, url, sync_engine)`` on a Postgres accounts plane, or skip."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the workspace store tests"
        )
    url = (
        make_url(_RAW_DSN)
        .set(drivername="postgresql+psycopg")
        .render_as_string(hide_password=False)
    )
    sync_engine = create_engine(url)
    try:
        with sync_engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - environment dependent
        sync_engine.dispose()
        pytest.skip(f"Postgres at the test DSN is unreachable: {exc}")

    from server.persistence import models  # noqa: F401 - registers the tables
    from server.persistence.base import Base

    Base.metadata.create_all(sync_engine, checkfirst=True)

    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_DIR", str(tmp_path / "attachments"))
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "0")
    for name in _SMTP_ENV:
        monkeypatch.delenv(name, raising=False)

    import server.api_auth as api_auth
    import server.persistence.engine as engine_mod

    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None

    from server.main import app

    try:
        with TestClient(app) as client:
            yield client, url, sync_engine
    finally:
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        sync_engine.dispose()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _signup(client: TestClient) -> dict:
    res = client.post(
        "/auth/signup",
        json={"email": f"wsstore-{uuid4().hex}@example.com", "password": "hunter2pass"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    # A new account's org holds no project; these tests use one named "default".
    made = client.post(
        "/app/projects",
        json={"name": "default"},
        headers={"Authorization": f"Bearer {body['token']}"},
    )
    assert made.status_code == 201, made.text
    body["project"] = made.json()["project"]
    return body


def _workspace_key(client: TestClient, owner: dict, project_id: str) -> dict:
    res = client.post(
        f"/app/projects/{project_id}/credentials",
        json={"scope": "workspace"},
        headers={"Authorization": f"Bearer {owner['token']}"},
    )
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['key']}", **_ENGINE_HEADERS}


def _linked(client: TestClient) -> tuple[str, str, dict]:
    """A new owner's project id, its tenant id and its workspace key headers."""

    owner = _signup(client)
    project_id = owner["project"]["id"]
    return project_id, owner["tenant"]["id"], _workspace_key(client, owner, project_id)


def _put(path: str, content: str, base_rev: int | None, **extra) -> dict:
    data = content.encode("utf-8")
    return {"op": "put", "path": path, "base_rev": base_rev, "sha256": _sha(data),
            "content": content, **extra}


def _commit(client, project_id, key, ops, *, batch_id=None, **extra):
    body = {"batch_id": batch_id or str(uuid4()), "command": ["finish-slice", "X.S1"],
            "origin": "command", "ops": ops, "events": [], "derived": [], "inbox": [], **extra}
    return client.post(f"/api/workspace/{project_id}/commit", json=body, headers=key)


def _ok(res) -> dict:
    assert res.status_code == 200, res.text
    return res.json()


def _fetch(client, project_id, key, paths) -> dict:
    files = _ok(client.post(f"/api/workspace/{project_id}/fetch", json={"paths": paths},
                            headers=key))["files"]
    return {f["path"]: f for f in files}


def _with_service(url: str, call):
    """Run ``call(service)`` on a service with its own engine, in its own event loop."""

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from server.workspace import WorkspaceService

    async def run():
        engine = create_async_engine(url)
        try:
            return await call(WorkspaceService(async_sessionmaker(engine, expire_on_commit=False)))
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _snapshot(sync_engine, project_id: str) -> dict:
    """Everything a batch can write for one project, for before/after comparisons."""

    queries = {
        "head": "SELECT coalesce((SELECT head FROM workspaces WHERE project_id = :p), -1)",
        "files": "SELECT string_agg(path || ':' || rev || ':' || sha256 || ':' || deleted, ',' "
                 "ORDER BY path) FROM workspace_files WHERE project_id = :p",
        "revisions": "SELECT count(*) FROM workspace_revisions WHERE project_id = :p",
        "blobs": "SELECT count(*) FROM workspace_blobs WHERE project_id = :p",
        "events": "SELECT count(*) FROM workspace_events WHERE project_id = :p",
        "derived": "SELECT string_agg(path || ':' || head, ',' ORDER BY path) "
                   "FROM workspace_derived WHERE project_id = :p",
    }
    with sync_engine.connect() as conn:
        return {name: conn.execute(text(sql), {"p": project_id}).scalar()
                for name, sql in queries.items()}


def test_two_concurrent_commits_on_one_path_give_exactly_one_409(store):
    """Two real connections race on one path; the second waits on the row lock."""

    client, url, _sync = store
    project_id, tenant_id, key = _linked(client)
    first = _ok(_commit(client, project_id, key, [_put("works/backlog.md", "v1\n", None)]))
    assert first == {"head": 1, "revs": {"works/backlog.md": 1}}

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from server.workspace import CommitBatch, PutOp, WorkspaceService, Writer

    def batch(content: str) -> CommitBatch:
        data = content.encode()
        return CommitBatch(
            batch_id=uuid4(), command="edit", origin="command",
            ops=(PutOp(path="works/backlog.md", base_rev=1, sha256=_sha(data), content=data),),
        )

    async def race() -> tuple[list[int], int]:
        engine = create_async_engine(url)
        try:
            service = WorkspaceService(async_sessionmaker(engine, expire_on_commit=False))
            pid, tid = UUID(project_id), UUID(tenant_id)
            async with engine.connect() as holder, engine.connect() as watcher:
                await holder.begin()
                await holder.execute(
                    text("SELECT head FROM workspaces WHERE project_id = :p FOR UPDATE"),
                    {"p": project_id},
                )
                tasks = [
                    asyncio.create_task(service.commit(pid, tid, Writer(checkout=name), batch(name)))
                    for name in ("left", "right")
                ]
                waiting = 0
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    waiting = (await watcher.execute(text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                    ))).scalar_one()
                    await watcher.commit()
                    if waiting >= 2 or any(t.done() for t in tasks):
                        break
                    await asyncio.sleep(0.05)
                await holder.commit()
                answers = await asyncio.gather(*tasks)
            return sorted(a.status for a in answers), waiting
        finally:
            await engine.dispose()

    statuses, waiting = asyncio.run(race())
    assert waiting == 2, "both batches should have waited on the project's row lock"
    assert statuses == [200, 409]

    stored = _fetch(client, project_id, key, ["works/backlog.md"])["works/backlog.md"]
    assert stored["rev"] == 2 and stored["content"] in ("left", "right")
    conflict = _commit(client, project_id, key, [_put("works/backlog.md", "late", 1)])
    assert conflict.status_code == 409
    [entry] = conflict.json()["conflicts"]
    assert entry["path"] == "works/backlog.md" and entry["base_rev"] == 1 and entry["rev"] == 2
    assert entry["by"] == f"checkout {stored['content']}" and entry["command"] == "edit"
    assert entry["at"].endswith("Z")


def test_one_stale_op_in_a_batch_writes_nothing(store):
    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    _ok(_commit(client, project_id, key, [
        _put("works/a.md", "a1", None), _put("works/b.md", "b1", None),
        {"op": "append", "path": "works/events.jsonl", "lines": ['{"e": 1}']},
    ], derived=[{"path": "works/state.json", "content": "{}"}]))
    _ok(_commit(client, project_id, key, [_put("works/a.md", "a2", 1)]))
    before = _snapshot(sync_engine, project_id)

    res = _commit(client, project_id, key, [
        _put("works/c.md", "brand new content", None),
        _put("works/a.md", "a3 from a stale read", 1),
        {"op": "move", "from": "works/b.md", "to": "works/b2.md", "base_rev": 1},
        {"op": "append", "path": "works/events.jsonl", "lines": ['{"e": 2}']},
    ], derived=[{"path": "works/state.json", "content": '{"changed": true}'}])

    assert res.status_code == 409, res.text
    paths = [c["path"] for c in res.json()["conflicts"]]
    assert paths == ["works/a.md"]
    assert _snapshot(sync_engine, project_id) == before
    assert "works/c.md" not in _fetch(client, project_id, key, ["works/c.md"])


def test_a_replayed_batch_id_returns_the_first_answer_and_applies_nothing(store):
    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    batch_id = str(uuid4())
    ops = [_put("works/x.md", "x", None),
           {"op": "append", "path": "works/events.jsonl", "lines": ["one", "two"]}]
    first = _ok(_commit(client, project_id, key, ops, batch_id=batch_id))
    after_first = _snapshot(sync_engine, project_id)

    again = _ok(_commit(client, project_id, key, ops, batch_id=batch_id))
    other_body = _ok(_commit(client, project_id, key, [_put("works/y.md", "y", None)],
                             batch_id=batch_id))
    assert again == first == other_body
    assert _snapshot(sync_engine, project_id) == after_first
    assert after_first["revisions"] == 2 and after_first["events"] == 2

    # A refused batch is answered the same way again, even once it would apply.
    stale_id = str(uuid4())
    refused = _commit(client, project_id, key, [_put("works/x.md", "x2", 7)], batch_id=stale_id)
    assert refused.status_code == 409
    resent = _commit(client, project_id, key, [_put("works/x.md", "x2", 1)], batch_id=stale_id)
    assert resent.status_code == 409 and resent.json() == refused.json()


def test_equal_content_is_a_no_op_even_with_a_stale_base_rev(store):
    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    _ok(_commit(client, project_id, key, [_put("works/phase.md", "one", None)]))
    _ok(_commit(client, project_id, key, [_put("works/phase.md", "two", 1)]))
    before = _snapshot(sync_engine, project_id)

    same = _ok(_commit(client, project_id, key, [_put("works/phase.md", "two", 1)]))
    assert same == {"head": 2, "revs": {"works/phase.md": 2}}
    after = _snapshot(sync_engine, project_id)
    assert after["head"] == before["head"] == 2
    assert after["revisions"] == before["revisions"] == 2

    # A delete of a record already gone is a no-op too; ``revs`` names every op's path.
    _ok(_commit(client, project_id, key, [{"op": "delete", "path": "works/phase.md",
                                           "base_rev": 2}]))
    gone = _ok(_commit(client, project_id, key, [
        {"op": "delete", "path": "works/phase.md", "base_rev": 1},
        _put("works/new.md", "n", None)]))
    assert gone == {"head": 4, "revs": {"works/phase.md": 3, "works/new.md": 4}}


def test_a_move_keeps_its_history(store):
    client, url, _sync = store
    project_id, _tid, key = _linked(client)
    _ok(_commit(client, project_id, key, [_put("works/phases/active/P1/phase.json", "{1}", None)]))
    _ok(_commit(client, project_id, key, [_put("works/phases/active/P1/phase.json", "{2}", 1)]))
    moved = _ok(_commit(client, project_id, key, [{
        "op": "move", "from": "works/phases/active/P1/phase.json",
        "to": "works/phases/archived/P1/phase.json", "base_rev": 2,
    }]))
    assert moved == {"head": 3, "revs": {"works/phases/archived/P1/phase.json": 3}}

    manifest = _ok(client.get(f"/api/workspace/{project_id}/manifest?since=2", headers=key))
    changes = {c["path"]: c for c in manifest["changes"]}
    assert changes["works/phases/active/P1/phase.json"]["deleted"] is True
    archived = changes["works/phases/archived/P1/phase.json"]
    assert archived["deleted"] is False and archived["sha256"] == _sha(b"{2}")
    assert _fetch(client, project_id, key, ["works/phases/archived/P1/phase.json"])[
        "works/phases/archived/P1/phase.json"]["content"] == "{2}"

    history = _with_service(url, lambda service: service.history(
        UUID(project_id), "works/phases/archived/P1/phase.json"))
    assert [(h.rev, h.op, h.path) for h in history] == [
        (3, "move", "works/phases/archived/P1/phase.json"),
        (2, "put", "works/phases/active/P1/phase.json"),
        (1, "put", "works/phases/active/P1/phase.json"),
    ]
    assert history[0].from_path == "works/phases/active/P1/phase.json"


def test_appends_never_conflict_and_land_in_sequence_order(store):
    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    _ok(_commit(client, project_id, key, [
        {"op": "append", "path": "works/events.jsonl", "lines": ["a"]}]))
    # Two checkouts that both last saw only "a" append their own lines.
    left = _ok(_commit(client, project_id, key, [
        {"op": "append", "path": "works/events.jsonl", "lines": ["b1", "b2"]}]))
    right = _ok(_commit(client, project_id, key, [
        {"op": "append", "path": "works/events.jsonl", "lines": ["c"]}]))
    assert (left["head"], right["head"]) == (2, 3)

    content = "a\nb1\nb2\nc\n"
    stored = _fetch(client, project_id, key, ["works/events.jsonl"])["works/events.jsonl"]
    assert stored["content"] == content and stored["sha256"] == _sha(content.encode())
    with sync_engine.connect() as conn:
        lines = conn.execute(text(
            "SELECT line FROM workspace_events WHERE project_id = :p ORDER BY seq"
        ), {"p": project_id}).scalars().all()
    assert lines == ["a", "b1", "b2", "c"]
    manifest = _ok(client.get(f"/api/workspace/{project_id}/manifest?since=0", headers=key))
    assert manifest["changes"] == [{"path": "works/events.jsonl", "rev": 3,
                                    "sha256": _sha(content.encode()), "size": len(content),
                                    "deleted": False, "kind": "append"}]

    # A moved append-only file keeps its content; new lines follow it.
    _ok(_commit(client, project_id, key, [
        {"op": "move", "from": "works/events.jsonl", "to": "works/old/events.jsonl",
         "base_rev": 3},
        {"op": "append", "path": "works/old/events.jsonl", "lines": ["d"]},
    ]))
    moved = _fetch(client, project_id, key, ["works/old/events.jsonl"])["works/old/events.jsonl"]
    assert moved["content"] == content + "d\n"


def test_another_projects_key_gets_404_on_every_route(store):
    client, _url, sync_engine = store
    project_a, _ta, key_a = _linked(client)
    project_b, _tb, key_b = _linked(client)
    _ok(_commit(client, project_a, key_a, [_put("works/a.md", "a", None)]))
    before = _snapshot(sync_engine, project_a)

    for res in (
        client.get(f"/api/workspace/{project_a}/head", headers=key_b),
        client.get(f"/api/workspace/{project_a}/manifest?since=0", headers=key_b),
        client.post(f"/api/workspace/{project_a}/fetch", json={"paths": ["works/a.md"]},
                    headers=key_b),
        _commit(client, project_a, key_b, [_put("works/a.md", "overwritten", 1)]),
        client.get("/api/workspace/not-a-uuid/head", headers=key_b),
    ):
        assert res.status_code == 404, res.text
        assert "works/a.md" not in res.text
    assert _snapshot(sync_engine, project_a) == before
    assert _snapshot(sync_engine, project_b)["head"] == -1  # B was never linked by A's routes

    own = _ok(client.get(f"/api/workspace/{project_a}/head", headers=key_a))
    assert own["head"] == 1 and own["project_id"] == project_a and own["inbox_pending"] == 0
    assert client.get(f"/api/workspace/{project_a}/head").status_code == 401
    no_engine = {k: v for k, v in key_a.items() if k != "X-Sikstack-Engine"}
    assert client.get(f"/api/workspace/{project_a}/head", headers=no_engine).status_code == 400


@pytest.mark.parametrize("prefix", ["X-Sikstack-", "X-Hi2vi-"])
def test_an_engine_syncs_under_either_header_name(store, prefix):
    """A sikstack engine sends ``X-Sikstack-*``; one from before the rename sends
    ``X-Hi2vi-*``. Both link, commit, read the manifest and count a head probe."""

    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    auth = {"Authorization": key["Authorization"]}
    engine = {**auth, f"{prefix}Checkout": f"co-{prefix}", f"{prefix}Engine": "v101"}
    assert _ok(client.get(f"/api/workspace/{project_id}/head", headers=engine))["head"] == 0
    answer = _ok(_commit(client, project_id, engine, [_put("works/a.md", "a body", None)]))
    assert answer["head"] == 1
    changes = _ok(client.get(f"/api/workspace/{project_id}/manifest", params={"since": 0},
                             headers=engine))["changes"]
    assert [c["path"] for c in changes] == ["works/a.md"]
    probe = {**engine, f"{prefix}Base": str(answer["head"])}
    assert _ok(client.get(f"/api/workspace/{project_id}/head", headers=probe))["head"] == 1
    with sync_engine.connect() as conn:
        row = conn.execute(text(
            "SELECT checkout, engine_version FROM workspace_batches WHERE project_id = :p"
        ), {"p": project_id}).one()
    assert tuple(row) == (f"co-{prefix}", "v101")
    assert client.get(f"/api/workspace/{project_id}/head", headers=auth).status_code == 400


def test_blobs_are_stored_once_per_sha(store):
    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)
    _ok(_commit(client, project_id, key, [
        _put("docs/a.md", "same body", None), _put("docs/b.md", "same body", None)]))
    _ok(_commit(client, project_id, key, [_put("docs/c.md", "same body", None)]))
    with sync_engine.connect() as conn:
        blobs = conn.execute(text(
            "SELECT count(*) FROM workspace_blobs WHERE project_id = :p AND sha256 = :s"
        ), {"p": project_id, "s": _sha(b"same body")}).scalar()
    assert blobs == 1
    files = _fetch(client, project_id, key, ["docs/a.md", "docs/b.md", "docs/c.md"])
    assert {f["content"] for f in files.values()} == {"same body"}


def test_bodies_contents_and_pages(store, monkeypatch):
    """413 over the limit, base64 contents, a checked sha, fetch pages, derived, inbox."""

    client, _url, sync_engine = store
    project_id, _tid, key = _linked(client)

    import server.workspace.service as service_mod
    import server.workspace_api as api

    with monkeypatch.context() as patched:
        patched.setattr(api, "MAX_BODY_BYTES", 2000)
        big = _commit(client, project_id, key, [_put("works/big.md", "x" * 3000, None)])
    assert big.status_code == 413 and "smaller batches" in big.json()["detail"]

    binary = bytes(range(256))
    wrong = _commit(client, project_id, key, [{**_put("works/bad.md", "a", None), "content": "b"}])
    assert wrong.status_code == 400
    landed = _ok(_commit(client, project_id, key, [
        {"op": "put", "path": "docs/logo.png", "base_rev": None, "sha256": _sha(binary),
         "content": base64.b64encode(binary).decode(), "encoding": "base64"},
        _put("works/one.md", "1" * 100, None), _put("works/two.md", "2" * 100, None),
    ], derived=[{"path": "works/state.json", "content": '{"current_phase": "P1"}'}]))
    logo = _fetch(client, project_id, key, ["docs/logo.png"])["docs/logo.png"]
    assert logo["encoding"] == "base64" and base64.b64decode(logo["content"]) == binary

    monkeypatch.setattr(service_mod, "FETCH_PAGE_BUDGET", 300)
    page = _ok(client.post(f"/api/workspace/{project_id}/fetch",
                           json={"paths": ["works/one.md", "works/missing.md", "works/two.md"]},
                           headers=key))
    assert [f["path"] for f in page["files"]] == ["works/one.md"]
    assert page["rest"] == ["works/two.md"]  # a path with no record is simply absent

    with sync_engine.begin() as conn:
        assert conn.execute(text(
            "SELECT head, content FROM workspace_derived WHERE project_id = :p"
        ), {"p": project_id}).one() == (landed["head"], '{"current_phase": "P1"}')
        entry = conn.execute(text(
            "INSERT INTO workspace_inbox (id, project_id, kind, items) "
            "VALUES (:i, :p, 'solve', '[\"A1-ab\"]') RETURNING id"
        ), {"i": str(uuid4()), "p": project_id}).scalar()
    assert _ok(client.get(f"/api/workspace/{project_id}/head", headers=key))["inbox_pending"] == 1
    result = {"id": str(entry), "state": "applied", "exit": 0}
    _ok(_commit(client, project_id, key, [], inbox=[result]))
    assert _ok(client.get(f"/api/workspace/{project_id}/head", headers=key))["inbox_pending"] == 0
    twice = _commit(client, project_id, key, [], inbox=[result])
    assert twice.status_code == 409
    assert twice.json()["conflicts"] == [{"path": None, "inbox": str(entry), "state": "applied"}]
