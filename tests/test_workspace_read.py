"""The workspace read model and the web's read routes: Postgres-gated.

A made-up workspace tree (``tests/fixtures/workspace/tree.json``) is committed through
the engine's sync API, then read back through ``/app/projects/{id}/workspace/…`` and
compared field for field with ``tests/fixtures/workspace/expected.json``. Also: every
item route carries the sync line of now, a pull request reads its number and state, a
doc version its place in the history, every read route answers 404 for another
tenant's project and for an unknown one, a resolved question reads ``resolved``, the
memo follows the head, and the sync state
reads ``unlinked``, ``never``, ``fresh`` and ``behind`` as the store moves.

Like its neighbours this runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
_ENGINE_HEADERS = {"X-Sikstack-Checkout": "test-checkout", "X-Sikstack-Engine": "v99"}
_FIXTURES = Path(__file__).parent / "fixtures" / "workspace"


@pytest.fixture
def store(tmp_path, monkeypatch):
    """``(client, url, sync_engine)`` on a Postgres accounts plane, or skip."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the workspace read tests"
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
    import server.workspace_read as workspace_read

    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None
    workspace_read.clear_memo()

    from server.main import app

    try:
        with TestClient(app) as client:
            yield client, url, sync_engine
    finally:
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        workspace_read.clear_memo()
        sync_engine.dispose()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _signup(client: TestClient) -> dict:
    res = client.post(
        "/auth/signup",
        json={"email": f"wsread-{uuid4().hex}@example.com", "password": "hunter2pass"},
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


def _session(owner: dict) -> dict:
    return {"Authorization": f"Bearer {owner['token']}"}


def _owner_with_key(client: TestClient) -> tuple[dict, str, dict]:
    """A new owner, their project id and its workspace key headers."""

    owner = _signup(client)
    project_id = owner["project"]["id"]
    res = client.post(
        f"/app/projects/{project_id}/credentials",
        json={"scope": "workspace"},
        headers=_session(owner),
    )
    assert res.status_code == 201, res.text
    return owner, project_id, {"Authorization": f"Bearer {res.json()['key']}", **_ENGINE_HEADERS}


def _put(path: str, content: str, base_rev: int | None = None, **extra) -> dict:
    return {"op": "put", "path": path, "base_rev": base_rev,
            "sha256": _sha(content.encode("utf-8")), "content": content, **extra}


def _commit(client, project_id, key, ops, derived=()) -> dict:
    body = {"batch_id": str(uuid4()), "command": ["rebuild"], "origin": "command",
            "ops": ops, "events": [], "derived": list(derived), "inbox": []}
    res = client.post(f"/api/workspace/{project_id}/commit", json=body, headers=key)
    assert res.status_code == 200, res.text
    return res.json()


def _tree() -> dict:
    return json.loads((_FIXTURES / "tree.json").read_text(encoding="utf-8"))


def _expected() -> dict:
    return json.loads((_FIXTURES / "expected.json").read_text(encoding="utf-8"))


def _store_tree(client, project_id, key) -> dict:
    """Commit the fixture tree (its derived records with it); returns the answer."""

    tree = _tree()
    ops = []
    for path, content in tree["files"].items():
        if path in tree["append"]:
            ops.append({"op": "append", "path": path, "lines": content.rstrip("\n").split("\n")})
        else:
            ops.append(_put(path, content))
    derived = [{"path": path, "content": content} for path, content in tree["derived"].items()]
    return _commit(client, project_id, key, ops, derived)


def _get(client, owner, url) -> dict:
    res = client.get(url, headers=_session(owner))
    assert res.status_code == 200, res.text
    return res.json()


def _routes(project_id: str) -> list[str]:
    base = f"/app/projects/{project_id}/workspace"
    return [
        base,
        f"{base}/phases/P8-q4",
        f"{base}/phases/P8",
        f"{base}/slices/P8-q4.S1",
        f"{base}/docs/product",
        f"{base}/docs/product?version=v0001",
        f"{base}/agenda/A2-k5",
    ]


def test_shapes_come_back_field_for_field(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    expected = _expected()
    base = f"/app/projects/{project_id}/workspace"

    ws = _get(client, owner, base)
    assert ws.pop("project") == project_id
    assert ws.pop("linked") is True
    assert ws.pop("version") == "v99"
    sync = ws.pop("sync")
    assert sync["state"] == "fresh" and sync["at"].endswith("Z")
    assert ws == expected["workspace"]
    assert "deferred" not in ws  # the deferred list retired

    head = {"version": "v99", "sync": sync}

    def record(url: str) -> dict:
        body = _get(client, owner, url)
        assert body.pop("workspace") == head, url
        return body

    assert record(f"{base}/phases/P8-q4") == expected["phase"]
    assert record(f"{base}/phases/P8") == expected["phase"]  # by short id
    assert record(f"{base}/slices/P8-q4.S1") == expected["slice"]
    assert record(f"{base}/docs/product") == expected["doc"]
    assert record(f"{base}/docs/product?version=v0001") == expected["doc_v0001"]
    # the address keeps the stored id; its leading token names the same version
    assert record(f"{base}/docs/product?version=v0001_bootstrap") == expected["doc_v0001"]
    assert record(f"{base}/docs/product?version=v2611020550_the_retry_queue") == expected["doc"]
    item = record(f"{base}/agenda/A2-k5")
    assert item == expected["item"] and "deferred" not in item
    # an agenda's items: a stored state read with who set it and when, an absent one open
    assert record(f"{base}/agenda/A1-h7") == expected["item_with_items"]

    planned = _get(client, owner, f"{base}/phases/P9-r5")
    assert planned["explain"] == {"title": "How export works", "documents": []}
    assert planned["explainedIn"] == []
    assert planned["notebook"] is None and planned["current"] is None
    archived = _get(client, owner, f"{base}/phases/P7-m3")
    assert archived["archived"] is True and archived["slices"][0]["full"] == "P7-m3.S1"
    retired = _get(client, owner, f"{base}/docs/experience")
    assert retired["state"] == "retired" and retired["sections"][0]["title"] == "Journeys"

    for missing in ("phases/P99-zz", "slices/P8-q4.S9", "deferred/D1-zz", "docs/nope",
                    "docs/product?version=v0009", "docs/product?version=2",
                    "agenda/A9-zz"):
        res = client.get(f"{base}/{missing}", headers=_session(owner))
        assert res.status_code == 404, (missing, res.text)


def test_a_resolved_question_reads_resolved(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    phase = _get(client, owner, f"/app/projects/{project_id}/workspace/phases/P8-q4")
    states = {q["id"]: (q["state"], q["answer"]) for q in phase["notebook"]["questions"]}
    assert states == {"OQ1": ("open", ""), "OQ2": ("resolved", "D1 (one endpoint)")}


def test_another_tenants_project_is_404_on_every_read_route(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    stranger = _signup(client)

    for url in _routes(project_id):
        assert client.get(url, headers=_session(owner)).status_code == 200, url
        res = client.get(url, headers=_session(stranger))
        assert res.status_code == 404, (url, res.text)
        assert "P8-q4" not in res.text and "Retry" not in res.text
        unknown = client.get(url.replace(project_id, str(uuid4())), headers=_session(owner))
        assert unknown.status_code == 404, (url, unknown.text)
        assert client.get(url).status_code == 401, url
        # the workspace key is the engine's, never a web session
        assert client.get(url, headers=key).status_code == 401, url


def test_the_memo_is_keyed_by_head(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    answer = _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    path = "works/phases/active/P9-r5/phase.json"
    first = _get(client, owner, base)
    assert [p["name"] for p in first["phases"]][1] == "Export to Markdown"
    assert _get(client, owner, f"{base}/phases/P9-r5")["name"] == "Export to Markdown"

    data = json.loads(_tree()["files"][path])
    data["name"] = "Export to Markdown and HTML"
    _commit(client, project_id, key,
            [_put(path, json.dumps(data, indent=2) + "\n", answer["revs"][path])])

    second = _get(client, owner, base)
    assert [p["name"] for p in second["phases"]][1] == "Export to Markdown and HTML"
    assert _get(client, owner, f"{base}/phases/P9-r5")["name"] == "Export to Markdown and HTML"


def test_a_renamed_slice_reads_its_new_name_at_the_new_head(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    answer = _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    path = "works/phases/active/P8-q4/slices/P8-q4.S2/slice.json"

    def named(ws: dict) -> list:
        return [ws["streams"][0]["sliceRef"]["name"], ws["pointer"]["sliceRef"]["name"],
                ws["phases"][0]["currentRef"]["name"]]

    first = _get(client, owner, base)
    assert named(first) == ["재시도 버튼을 화면에 연결"] * 3
    assert first["pointer"]["waiting"][0]["sliceRef"]["name"] == "재시도 버튼을 화면에 연결"
    assert first["pointer"]["nextRef"] == {"id": "S3", "full": "P8-q4.S3",
                                           "name": None, "status": None}

    data = json.loads(_tree()["files"][path])
    data["name"] = "Wire the retry button"
    data["status"] = "in_progress"
    _commit(client, project_id, key,
            [_put(path, json.dumps(data, indent=2) + "\n", answer["revs"][path])])

    second = _get(client, owner, base)
    assert named(second) == ["Wire the retry button"] * 3
    assert second["pointer"]["sliceRef"]["status"] == "in_progress"
    assert second["phases"][0]["currentRef"] == {"id": "S2", "full": "P8-q4.S2",
                                                 "name": "Wire the retry button",
                                                 "status": "in_progress"}
    assert second["pointer"]["waiting"][0]["type"] == "gate"  # no longer a stop


def _item_routes(project_id: str) -> list[str]:
    base = f"/app/projects/{project_id}/workspace"
    return [f"{base}/phases/P8-q4", f"{base}/slices/P8-q4.S1",
            f"{base}/docs/product", f"{base}/docs/product?version=v0001", f"{base}/agenda/A2-k5"]


def test_every_item_route_reads_the_sync_line_of_now(store):
    client, _url, engine = store
    owner, project_id, key = _owner_with_key(client)
    answer = _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"

    def heads() -> list[dict]:
        ws = _get(client, owner, base)
        want = {"version": ws["version"], "sync": ws["sync"]}
        got = [_get(client, owner, url)["workspace"] for url in _item_routes(project_id)]
        assert got == [want] * len(got)
        return got

    first = heads()[0]
    assert first["version"] == "v99" and first["sync"]["state"] == "fresh"

    # the same head, an older last sync: every route reads behind (never the memo's copy)
    _set_last_sync(engine, project_id, datetime.now(UTC) - timedelta(hours=25))
    behind = heads()[0]
    assert behind["sync"]["state"] == "behind" and behind["version"] == "v99"

    # a new batch from a newer engine moves them all
    path = "works/agenda/A1-h7/agenda.json"
    data = json.loads(_tree()["files"][path])
    data["note"] = "다시 느려졌어요."
    newer = {**key, "X-Sikstack-Engine": "v100"}
    _commit(client, project_id, newer,
            [_put(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                  answer["revs"][path])])
    moved = heads()[0]
    assert moved["version"] == "v100" and moved["sync"]["state"] == "fresh"
    assert moved["sync"]["at"] > behind["sync"]["at"]


def _set_last_sync(engine, project_id: str, at: datetime) -> None:
    with engine.begin() as conn:
        conn.execute(text("UPDATE workspaces SET last_sync_at = :at WHERE project_id = :p"),
                     {"at": at, "p": project_id})


def test_sync_reads_unlinked_never_fresh_and_behind(store):
    client, url, engine = store
    owner, project_id, key = _owner_with_key(client)
    base = f"/app/projects/{project_id}/workspace"

    ws = _get(client, owner, base)
    assert ws == {"project": project_id, "linked": False, "version": None,
                  "sync": {"state": "unlinked", "at": None}}
    assert client.get(f"{base}/phases/P8-q4", headers=_session(owner)).status_code == 404

    res = client.get(f"/api/workspace/{project_id}/head", headers=key)
    assert res.status_code == 200 and res.json()["head"] == 0
    ws = _get(client, owner, base)
    assert ws["linked"] is True and ws["sync"] == {"state": "never", "at": None}
    assert ws["phases"] == [] and ws["agenda"] == []

    _store_tree(client, project_id, key)
    assert _get(client, owner, base)["sync"]["state"] == "fresh"

    _set_last_sync(engine, project_id, datetime.now(UTC) - timedelta(hours=25))
    assert _get(client, owner, base)["sync"]["state"] == "behind"


def test_an_up_to_date_head_probe_moves_last_sync_throttled(store):
    client, url, engine = store
    owner, project_id, key = _owner_with_key(client)
    answer = _store_tree(client, project_id, key)
    head = answer["head"]

    from server.persistence.engine import get_session_maker
    from server.workspace_read import note_head_probe

    old = datetime.now(UTC) - timedelta(hours=30)
    _set_last_sync(engine, project_id, old)
    pid = UUID(project_id)

    async def probe(base: int, at: datetime) -> bool:
        return await note_head_probe(pid, base, get_session_maker(), at=at)

    now = datetime.now(UTC)
    assert asyncio.run(probe(head - 1, now)) is False  # a stale checkout is not a sync
    assert asyncio.run(probe(head, now)) is True
    assert asyncio.run(probe(head, now + timedelta(seconds=30))) is False  # throttled
    assert asyncio.run(probe(head, now + timedelta(seconds=61))) is True
    with engine.connect() as conn:
        at = conn.execute(text("SELECT last_sync_at FROM workspaces WHERE project_id = :p"),
                          {"p": project_id}).scalar_one()
    assert at > old + timedelta(hours=29)


def test_question_and_result_readers():
    from server.workspace_read import notebook_entries, parse_questions, parse_result

    entries = notebook_entries([
        "_guidance_",
        "- **OQ3** (resolved → taken (yes: keep it), by the operator): Keep it (or not)?",
        "- **OQ4 (P1-ab.S2):** Which one?",
        "  more of OQ4",
        "",
        "A paragraph that is no entry.",
    ])
    assert parse_questions(entries) == [
        {"id": "OQ3", "text": "Keep it (or not)?", "state": "resolved",
         "answer": "taken (yes: keep it), by the operator"},
        {"id": "OQ4", "text": "Which one?\n  more of OQ4", "state": "open", "answer": ""},
    ]
    assert parse_result(None) is None
    plain = parse_result("- status: done\n- summary: ok\n\nBody text.\n")
    assert plain["verdict"]["status"] == "done" and plain["verdict"]["files"] is None
    assert plain["body"] == "Body text."


def test_a_pull_request_reads_its_number_and_state():
    from server.workspace_read import pull_request

    url = "https://github.com/june/platform/pull/38"

    def entry(**fields) -> dict:
        return {"repo": "platform", "branch": "feat/retry-queue", "base": "main",
                "url": url, "recorded_at": "2026-11-11T09:31:00+09:00",
                "opened_at": "2026-11-15T10:05:00+09:00", **fields}

    def read(**fields) -> dict | None:
        return pull_request(entry(**fields))

    assert read(state="draft") == {"number": 38, "state": "draft", "url": url}
    assert read(state="ready")["state"] == "open"
    assert read(state="merged")["state"] == "merged"
    assert read(state="closed")["state"] == "closed"
    assert read()["state"] == "draft"  # unsynced: the engine opens drafts
    assert read(state=None)["state"] == "draft"
    assert read(opened_at=None) == {"number": 38, "state": None, "url": url}
    assert read(state="ready", opened_at=None)["state"] == "open"
    assert read(state="reopened")["state"] is None  # a word the engine never writes
    assert read(url=None, opened_at=None) is None
    assert read(url="") is None
    assert read(url="https://github.com/june/vocky/pull/1205/")["number"] == 1205
    assert read(url="https://github.com/june/vocky/pull/12#issuecomment-9")["number"] == 12
    assert read(url="https://github.com/team42/vocky/pull/12")["number"] == 12
    assert read(url="https://github.com/june/vocky/pulls")["number"] is None


def test_a_refused_change_names_its_kind_on_the_row_and_unplaced():
    from server.workspace.types import INBOX_KINDS, InboxEntry
    from server.workspace_read import WorkspaceReader

    at = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)
    line = "refused, exit 1 (agenda-drop A2-k5): A2-k5 is In progress through P8-q4"
    for kind in INBOX_KINDS:
        entry = InboxEntry(
            id=uuid4(), kind=kind, items=("A2-k5",), fields={}, state="refused",
            minted_id="A2-k5" if kind == "add" else None, created_at=at, reason=line,
        )
        gone = InboxEntry(
            id=uuid4(), kind=kind, items=("A9-z1",), fields={}, state="refused",
            minted_id="A9-z1" if kind == "add" else None, created_at=at, reason=line,
        )
        reader = WorkspaceReader(None, uuid4(), None, None, inbox=[entry, gone])
        stored = [{"id": "A2-k5", "sync": None}]
        shown = reader._overlay(stored)
        row = next(r for r in shown if r["id"] == "A2-k5")
        assert row["sync"] == {"refused": line, "entry": str(entry.id), "kind": kind}, kind
        if kind == "add":
            continue  # a refused add is its own row: nothing left unplaced
        (u,) = reader._unplaced(stored, shown)
        assert u["kind"] == kind
        assert u["sync"] == {"refused": line, "entry": str(gone.id), "kind": kind}, kind
    # a pending change still reads waiting, with no kind
    waiting = InboxEntry(id=uuid4(), kind="drop", items=("A2-k5",), fields={},
                         state="pending", minted_id=None, created_at=at)
    reader = WorkspaceReader(None, uuid4(), None, None, inbox=[waiting])
    assert reader._overlay([{"id": "A2-k5", "sync": None}])[0]["sync"] == "waiting"


# -- the overlay's predictions: the engine's item rules (no database) -------------------
#
# Each case is the engine's own rule, ``plugins/sikstack/scripts/wf_agenda.py`` at this
# branch: ``agenda_item_change`` (lines 1185-1246: done and dismiss take open items, reopen
# closed ones, delete any, all or none; no auto-close after a reopen), ``_agenda_auto_close``
# (lines 1159-1178: an agenda stored ``open``, so Open, Proposed or In progress, that held
# items and holds none open is Solved when any is done, outcome ``ITEM_SOLVED_OUTCOME``,
# else Dropped, reason ``ITEM_DROPPED_REASON``, lines 324-325), ``agenda_split`` (lines
# 1249-1297: the named items move whole, never none or every one, then the source may
# close) and ``agenda_propose`` (lines 976-999: Open or In progress only).

_AT = datetime(2026, 11, 25, 1, 0, tzinfo=UTC)
_X = "20261120T000000.000001Z-xa01.json"
_Y = "20261121T000000.000001Z-yb02.json"
_Z = "20261122T000000.000001Z-zc03.json"


def _items_of(aid: str, **states: str) -> list[dict]:
    """Thread entries of ``aid`` as the reader builds them, one per name in ``states``."""

    from server.workspace_read import _thread_entry

    names = {"X": _X, "Y": _Y, "Z": _Z}
    out = []
    for key, state in states.items():
        data = {"kind": "note", "author": "person:june", "source": "web:agenda",
                "created_at": "2026-11-20T09:00:00+09:00", "body": key}
        if state != "absent":
            data.update(state=state, state_by="agent:x", state_at="2026-11-21T09:00:00+09:00")
        out.append(_thread_entry(aid, names[key][:-5], data))
    return out


def _pending(kind: str, items: tuple, fields: dict | None = None, minted: str | None = None,
             state: str = "pending"):
    from server.workspace.types import InboxEntry

    return InboxEntry(id=uuid4(), kind=kind, items=items,
                      fields={"author": "person:june", **(fields or {})}, minted_id=minted,
                      state=state, created_at=_AT, reason=None if state == "pending" else "no")


def _rows(*pairs: tuple[str, str]) -> list[dict]:
    return [{"id": aid, "state": state, "outcome": "", "reason": "", "proposed": None,
             "entryCount": 0, "itemsOpen": 0, "sync": None, "accepting": False}
            for aid, state in pairs]


def test_the_overlay_predicts_the_last_open_items_auto_close_as_the_engine_does():
    from server.workspace_read import predict

    rows = _rows(("A2-k5", "in_progress"), ("A1-h7", "solved"))
    threads = {"A2-k5": _items_of("A2-k5", X="absent", Y="dismissed")}

    # done on the last open item: Solved, the outcome naming the done and dismissed ones
    done = _pending("item-done", ("A2-k5",), {"entries": [_X]})
    p = predict(rows, threads, [done])
    assert p.states["A2-k5"] == {"state": "solved", "proposed": None, "reason": "",
                                 "outcome": "all items dealt with: 1 done, 1 dismissed"}
    assert p.files["A2-k5"][_X]["state"] == "done"
    assert p.files["A2-k5"][_X]["stateBy"] == "person:june"
    assert p.files["A2-k5"][_X]["stateAt"] == "2026-11-25T01:00:00Z"

    # dismissing it instead, none done: Dropped
    dismiss = _pending("item-dismiss", ("A2-k5",), {"entries": [_X]})
    assert predict(rows, threads, [dismiss]).states["A2-k5"] == {
        "state": "dropped", "outcome": "", "reason": "every item dismissed or deleted",
        "proposed": None}
    # deleting every item, none done: Dropped, the items marked deleting
    delete = _pending("item-delete", ("A2-k5",), {"entries": [_X, _Y]})
    p = predict(rows, threads, [delete])
    assert p.states["A2-k5"]["state"] == "dropped" and p.files["A2-k5"] == {}
    assert set(p.deleted["A2-k5"]) == {_X, _Y} and p.deleted["A2-k5"][_X]["deleting"] is True

    # an item still open, a pending note (an open item to come) or a Solved agenda: no close
    two = {"A2-k5": _items_of("A2-k5", X="absent", Y="absent")}
    assert predict(rows, two, [done]).states == {}
    note = _pending("entry", ("A2-k5",), {"kind": "note", "body": "more"})
    assert predict(rows, threads, [note, done]).states == {}
    assert predict(rows, threads, [done, note]).states["A2-k5"]["state"] == "solved"
    solved = {"A1-h7": _items_of("A1-h7", X="absent")}
    assert predict(rows, solved, [_pending("item-done", ("A1-h7",),
                                           {"entries": [_X]})]).states == {}

    # a reopen never reopens or closes its agenda; done on a closed item is the engine's
    # refusal, and a refused entry predicts nothing
    reopen = _pending("item-reopen", ("A2-k5",), {"entries": [_Y]})
    p = predict(rows, threads, [reopen])
    assert p.states == {} and p.files["A2-k5"][_Y]["state"] == "open"
    assert predict(rows, threads, [_pending("item-done", ("A2-k5",),
                                            {"entries": [_X, _Y]})]).states == {}
    assert predict(rows, threads, [_pending("item-done", ("A2-k5",), {"entries": [_X]},
                                            state="refused")]).states == {}
    assert predict(rows, threads, [_pending("item-done", ("A2-k5",),
                                            {"entries": [_Z]})]).states == {}


def test_the_overlay_predicts_a_split_and_a_propose_as_the_engine_does():
    from server.workspace_read import WorkspaceReader, predict

    rows = _rows(("A2-k5", "open"), ("A1-h7", "solved"))
    threads = {"A2-k5": _items_of("A2-k5", X="absent", Y="done", Z="absent")}

    split = _pending("split", ("A2-k5",), {"entries": [_Z, _X], "title": "Retry storms"},
                     minted="A3-p7")
    p = predict(rows, threads, [split])
    assert list(p.files["A3-p7"]) == [_X, _Z]  # moved whole, in name order
    assert p.files["A3-p7"][_X]["ref"] == "A3-p7/xa01"
    assert list(p.files["A2-k5"]) == [_Y]
    # the source keeps only a done item: it closes itself, Solved
    assert p.states["A2-k5"]["state"] == "solved"
    assert p.states["A2-k5"]["outcome"] == "all items dealt with: 1 done, 0 dismissed"
    assert "A3-p7" not in p.states and p.splits == {"A3-p7": split}

    # none or every item: the engine refuses it, nothing predicted
    every = _pending("split", ("A2-k5",), {"entries": [_X, _Y, _Z], "title": "All"},
                     minted="A4-q8")
    assert predict(rows, threads, [every]).splits == {}

    # the overlay: the new agenda its own row, first in the open part, waiting, its counts
    # the items it takes; the source's counts what is left, its predicted close last
    reader = WorkspaceReader(None, uuid4(), None, None, inbox=[split])
    shown = reader._overlay(rows, threads=threads)
    assert [(r["id"], r["state"]) for r in shown] == [
        ("A3-p7", "open"), ("A2-k5", "solved"), ("A1-h7", "solved")]
    new, source = shown[0], shown[1]
    assert new["title"] == "Retry storms" and new["sync"] == "waiting"
    assert (new["entryCount"], new["itemsOpen"]) == (2, 2)
    assert (source["entryCount"], source["itemsOpen"]) == (1, 0)
    assert source["sync"] == "waiting"

    # propose: Open or In progress reads Proposed, first; a Solved one is refused
    propose = _pending("propose", ("A2-k5",))
    reader = WorkspaceReader(None, uuid4(), None, None, inbox=[propose])
    shown = reader._overlay(_rows(("A9-zz", "proposed"), ("A1-h7", "solved"),
                                  ("A2-k5", "in_progress")), threads={})
    assert [(r["id"], r["state"]) for r in shown] == [
        ("A9-zz", "proposed"), ("A2-k5", "proposed"), ("A1-h7", "solved")]
    assert shown[1]["proposed"] == {"by": "person:june", "at": "2026-11-25T01:00:00Z"}
    assert predict(rows, {}, [_pending("propose", ("A1-h7",))]).states == {}


def test_a_doc_version_reads_its_place_in_the_stored_history():
    from server.workspace_read import version_ordinals

    versions = [
        {"id": "v0001_bootstrap", "created_at": "2026-09-01T09:00:00+09:00"},
        {"id": "v0002_installer_source_tree", "created_at": "2026-09-03T09:00:00+09:00"},
        {"id": "v2611020550_the_design_round", "created_at": "2026-11-02T05:50:00+09:00"},
        {"id": "v2611171507_regression_checklist", "created_at": "2026-11-17T15:07:00+09:00"},
    ]
    assert [version_ordinals(versions)[v["id"]] for v in versions] == [1, 2, 3, 4]


# -- Proposed, threads, the folded-job lookup and the explain links (P61-e9) ----------


def _agenda_json(aid: str, title: str, **extra) -> str:
    data = {"id": aid, "title": title, "note": None, "status": "open", "order": 3.0,
            "created_at": "2026-11-20T09:00:00+09:00", "changed_at": "2026-11-20T09:00:00+09:00",
            "outcome": None, "reason": None, **extra}
    return json.dumps(data, indent=2) + "\n"


def _index_with(*rows: dict) -> dict:
    index = json.loads(_tree()["derived"]["works/index.json"])
    index["agenda"] = [*rows, *index["agenda"]]
    return {"path": "works/index.json", "content": json.dumps(index, indent=2) + "\n"}


def _state_record() -> dict:
    return {"path": "works/state.json", "content": _tree()["derived"]["works/state.json"]}


def test_a_proposed_item_reads_proposed_apart_and_first(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    proposed = {"by": "agent:claude-opus-5-5", "at": "2026-11-20T09:00:00+09:00"}
    _commit(client, project_id, key, [
        _put("works/agenda/A3-p7/agenda.json", _agenda_json("A3-p7", "Retry storms", proposed=proposed)),
        _put("works/agenda/A4-q8/agenda.json", _agenda_json("A4-q8", "Plain open work")),
    ])

    # neither is in index.json: the stored `proposed` key decides; a Proposed item leads,
    # and the rest keep the engine's order, the items it does not list after
    rows = _get(client, owner, base)["agenda"]
    assert [(r["id"], r["state"]) for r in rows] == [
        ("A3-p7", "proposed"), ("A2-k5", "in_progress"), ("A1-h7", "solved"), ("A4-q8", "open")]
    assert rows[0]["proposed"] == proposed
    assert all(r["proposed"] is None for r in rows[1:])
    item = _get(client, owner, f"{base}/agenda/A3-p7")
    assert item["state"] == "proposed" and item["proposed"] == proposed

    # the engine's shown_status wins when index.json lists the item
    accepted = {"id": "A3-p7", "title": "Retry storms", "status": "open", "shown_status": "Open",
                "order": 1.0, "proposed": None, "phases": [], "phases_done": 0}
    _commit(client, project_id, key, [], derived=[_index_with(accepted), _state_record()])
    rows = _get(client, owner, base)["agenda"]
    first = next(r for r in rows if r["id"] == "A3-p7")
    assert first["state"] == "open" and first["proposed"] is None

    shown = {**accepted, "id": "A4-q8", "title": "Plain open work", "shown_status": "Proposed",
             "proposed": {"by": "agent:fold", "at": "2026-11-21T09:00:00+09:00"}}
    _commit(client, project_id, key, [], derived=[_index_with(shown, accepted), _state_record()])
    rows = _get(client, owner, base)["agenda"]
    assert rows[0]["id"] == "A4-q8" and rows[0]["state"] == "proposed"
    assert rows[0]["proposed"] == {"by": "agent:fold", "at": "2026-11-21T09:00:00+09:00"}
    assert [r["state"] for r in rows[1:]] == ["open", "in_progress", "solved"]


def test_an_older_deferred_agenda_reads_proposed_and_nothing_reads_deferred(store):
    """0.6.0 retired Deferred: a stored ``deferred`` (an older engine's, or another
    checkout still on 0.5.x) reads Proposed, as the engine reads it (``wf_agenda.py``
    ``_agenda_proposed``), whether ``index.json`` lists it or not, and an older
    ``index.json`` row's ``Deferred`` word reads Proposed too."""

    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    _commit(client, project_id, key, [
        _put("works/agenda/A3-p7/agenda.json", _agenda_json("A3-p7", "Retry storms",
                                                           status="deferred", order=None)),
    ])

    rows = _get(client, owner, base)["agenda"]
    assert [(r["id"], r["state"]) for r in rows] == [
        ("A3-p7", "proposed"), ("A2-k5", "in_progress"), ("A1-h7", "solved")]
    assert rows[0]["proposed"] == {"by": None, "at": None}
    item = _get(client, owner, f"{base}/agenda/A3-p7")
    assert item["state"] == "proposed"

    # an older engine's index row says Deferred: it reads Proposed
    old = {"id": "A3-p7", "title": "Retry storms", "status": "deferred",
           "shown_status": "Deferred", "order": None, "phases": [], "phases_done": 0}
    _commit(client, project_id, key, [], derived=[_index_with(old), _state_record()])
    ws = _get(client, owner, base)
    assert [(r["id"], r["state"]) for r in ws["agenda"]][0] == ("A3-p7", "proposed")
    assert all(r["state"] != "deferred" for r in ws["agenda"])
    assert _get(client, owner, f"{base}/agenda/A3-p7")["state"] == "proposed"


def _entry_file(aid: str, name: str, body: str, *, created: str, kind: str = "note",
                author: str = "person:june", source: str = "web:agenda", **extra) -> dict:
    data = {"kind": kind, "author": author, "source": source, "created_at": created,
            "body": body, **extra}
    return _put(f"works/agenda/{aid}/entries/{name}.json", json.dumps(data, indent=2) + "\n")


def test_an_item_reads_its_thread_in_name_order_skipping_malformed_files(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    newer = "20261124T011500.000001Z-b2c3"
    older = "20261123T001500.000001Z-a1b2"
    _commit(client, project_id, key, [
        _entry_file("A2-k5", newer, "Still failing on 3G.", created="2026-11-24T10:15:00+09:00",
                    author="agent:claude-opus-5-5", source="slice:P8-q4.S1", kind="issue"),
        _entry_file("A2-k5", older, "Seen twice.", created="2026-11-23T09:15:00+09:00"),
        _put("works/agenda/A2-k5/entries/20261122T000000.000000Z-zz99.json", "not json\n"),
        _put("works/agenda/A2-k5/entries/20261122T000001.000000Z-zz98.json", "[1, 2]\n"),
        _put("works/agenda/A2-k5/entries/20261122T000002.000000Z-zz97.json", '{"kind": "note"}\n'),
    ])

    item = _get(client, owner, f"{base}/agenda/A2-k5")
    unset = {"state": "open", "stateBy": None, "stateAt": None, "deleting": False}
    assert item["entries"] == [
        {"id": older, "file": f"{older}.json", "ref": "A2-k5/a1b2", "kind": "note",
         "author": "person:june", "by": "person", "name": "june",
         "source": "web:agenda", "created": "2026-11-23T09:15:00+09:00", "body": "Seen twice.",
         "job": None, **unset, "sync": None},
        {"id": newer, "file": f"{newer}.json", "ref": "A2-k5/b2c3", "kind": "issue",
         "author": "agent:claude-opus-5-5", "by": "agent",
         "name": "claude-opus-5-5", "source": "slice:P8-q4.S1",
         "created": "2026-11-24T10:15:00+09:00", "body": "Still failing on 3G.", "job": None,
         **unset, "sync": None},
    ]
    row = next(r for r in _get(client, owner, base)["agenda"] if r["id"] == "A2-k5")
    assert row["entryCount"] == 2 and row["itemsOpen"] == 2 and row["latest"] == "2026-11-24"
    assert "entries" not in row  # the list carries counts, never the thread
    assert item["entryCount"] == 2 and item["deleting"] is False


def test_a_folded_job_leads_to_the_item_whose_entry_carries_it(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    job = {"id": "D31-x9", "title": "Retry the upload queue", "source": "P8-q4",
           "reason": "Not now.", "trigger": "When uploads fail again.",
           "created_at": "2026-11-01T09:00:00+09:00"}
    body = "Folded from deferred job D31-x9, created 2026-11-01T09:00:00+09:00.\nTitle: Retry"
    _commit(client, project_id, key, [
        _entry_file("A2-k5", "20261124T011500.000001Z-f0f0", body, kind="issue",
                    created="2026-11-24T10:15:00+09:00", author="agent:fold",
                    source="phase:P8-q4", job=job),
    ])

    # the lookup answers only the item, never the job's own shape
    found = client.get(f"{base}/deferred/D31-x9", headers=_session(owner))
    assert found.status_code == 200, found.text
    assert found.json() == {"agenda": "A2-k5"}
    item = _get(client, owner, f"{base}/agenda/A2-k5")
    assert item["entries"][0]["job"] == "D31-x9"
    assert "deferred" not in item

    # a stored job no entry carries, and a job nothing names: both 404, agenda null
    for job_id in ("D20-a3", "D77-zz"):
        gone = client.get(f"{base}/deferred/{job_id}", headers=_session(owner))
        assert gone.status_code == 404, (job_id, gone.text)
        assert gone.json()["agenda"] is None and set(gone.json()) == {"detail", "agenda"}

    # another account's lookup is the tenant's 404, the item never named
    stranger = _signup(client)
    res = client.get(f"{base}/deferred/D31-x9", headers=_session(stranger))
    assert res.status_code == 404 and "A2-k5" not in res.text
    assert "deferred" not in _get(client, owner, base)


def test_the_published_section_parses_in_all_three_shapes():
    from server.workspace_read import explain_phase_ids, published_rel_paths

    rows = """# REVIEW

## Published

| url | rel_path | version |
|---|---|---|
| https://old-host.example.com/@june/kb/u10 | kb/2026-10-29-u10-end-to-end.md | 1 (id 71) |

Project kb.
"""
    fields = """## Published

| field | value |
|---|---|
| url | https://old-host.example.com/@june/kb/our-bar |
| rel_path | `kb/2026-10-27-our-bar.md` |
| id | 67 (unchanged) |

## Next
| rel_path | kb/not-published.md |
"""
    book = """## Published

**The credential.** Never printed.

| # | key | id | url | rel_path | version |
|---|---|---|---|---|---|
| 1 | `the-curve` | 74 | https://x/@june/kb/the-curve | kb/2026-11-12-the-curve.md | 1 |
| 2 | `luck` | 75 | https://x/@june/kb/luck | kb/2026-11-12-luck.md | 1 |
"""
    assert published_rel_paths(rows) == ["kb/2026-10-29-u10-end-to-end.md"]
    assert published_rel_paths(fields) == ["kb/2026-10-27-our-bar.md"]
    assert published_rel_paths(book) == ["kb/2026-11-12-the-curve.md", "kb/2026-11-12-luck.md"]
    assert published_rel_paths("## Published\n\nNothing was saved.\n") == []
    assert published_rel_paths(None) == []
    assert explain_phase_ids(["- unit: book", "- phases: P53-jq, P42, P58-pm"]) == [
        "P53-jq", "P42", "P58-pm"]
    assert explain_phase_ids(["- unit: document", "- project: kb (private)"]) == []


def _explain_phase(pid: str, name: str, explain_lines: list[str], published: str) -> list[dict]:
    root = f"works/phases/active/{pid}/"
    phase = {"id": pid, "name": name, "status": "done", "created_at": "2026-11-20T09:00:00+09:00"}
    review = {"id": f"{pid}.REVIEW", "phase_id": pid, "name": "review", "kind": "review",
              "status": "done", "order": 9999, "completed_at": "2026-11-21T09:00:00+09:00"}
    intent = "# Intent\n\n## Explain\n\n" + "\n".join(explain_lines) + "\n"
    result = "# REVIEW\n\n- status: pass\n\n## Published\n\n" + published
    return [
        _put(root + "phase.json", json.dumps(phase, indent=2) + "\n"),
        _put(root + "intent.md", intent),
        _put(root + f"slices/{pid}.REVIEW/slice.json", json.dumps(review, indent=2) + "\n"),
        _put(root + f"slices/{pid}.REVIEW/result.md", result),
    ]


def _seed_doc(tenant_id: str, project: str, slug: str, title: str) -> tuple[int, str]:
    from server import db

    rel_path = f"{project}/2026-11-20-{slug}.md"
    conn = db.connect()
    try:
        doc_id = db.upsert_document(
            conn, project=project, slug=slug, date="2026-11-20", title=title, tags=[],
            source_repo=None, rel_path=rel_path, markdown="# " + title, related=[],
            tenant_id=tenant_id,
        )
    finally:
        conn.close()
    return doc_id, rel_path


def test_explain_links_run_both_ways_through_the_projects_own_documents(store):
    client, _url, _engine = store
    owner, project_id, key = _owner_with_key(client)
    _store_tree(client, project_id, key)
    base = f"/app/projects/{project_id}/workspace"
    tenant, project = owner["tenant"]["id"], owner["project"]["name"]
    doc_id, rel_path = _seed_doc(tenant, project, "the-retry-queue", "How the retry queue works")
    other_project = client.post("/app/projects", json={"name": "elsewhere"},
                                headers=_session(owner))
    assert other_project.status_code == 201, other_project.text
    _away_id, away_path = _seed_doc(tenant, "elsewhere", "elsewhere-doc", "Not this project's")

    _commit(client, project_id, key, [
        # the newer form: a phases line, a field/value table
        *_explain_phase("P10-x1", "Explain the retry queue",
                        ["- unit: document", "- phases: P8-q4, P99-zz", f"- project: {project} (private)"],
                        f"| field | value |\n|---|---|\n| url | https://old-host.example.com/@x/{project}/old |\n"
                        f"| rel_path | {rel_path} |\n"),
        # the older form, no phases line; its path resolves to no document
        *_explain_phase("P11-y2", "Explain nothing yet", ["- unit: document"],
                        "| url | rel_path | version |\n|---|---|---|\n"
                        f"| https://x | {project}/2026-11-20-missing.md | 1 |\n"),
        # a path to another project's document: never linked
        *_explain_phase("P12-z3", "Explain elsewhere", ["- unit: document", "- phases: P8-q4"],
                        f"| url | rel_path | version |\n|---|---|---|\n| https://x | {away_path} | 1 |\n"),
    ])

    doc = {"id": doc_id, "rel_path": rel_path, "title": "How the retry queue works",
           "href": f"/documents/{doc_id}"}
    explain = _get(client, owner, f"{base}/phases/P10-x1")
    assert explain["explain"] == {"title": "Explain the retry queue", "documents": [doc]}
    assert explain["explainedIn"] == [{**doc, "phase": "P10-x1", "role": "explain"}]
    source = _get(client, owner, f"{base}/phases/P8-q4")
    assert source["explain"] is None
    assert source["explainedIn"] == [{**doc, "phase": "P10-x1", "role": "source"}]
    for unlinked in ("P11-y2", "P12-z3"):
        phase = _get(client, owner, f"{base}/phases/{unlinked}")
        assert phase["explain"]["documents"] == [] and phase["explainedIn"] == []

    read = _get(client, owner, f"/app/documents/{doc_id}")
    assert read["phases"] == [
        {"id": "P10-x1", "name": "Explain the retry queue", "role": "explain"},
        {"id": "P8-q4", "name": source["name"], "role": "source"},
    ]
    away = _get(client, owner, f"/app/documents/{_away_id}")
    assert away["phases"] == []


# -- the content cache: each cached text counted once (no database) ------------------


@pytest.fixture
def small_cache(monkeypatch):
    """The content cache, emptied, with its cap at 100."""

    import server.workspace_read as workspace_read

    monkeypatch.setattr(workspace_read, "CONTENT_CACHE_BYTES", 100)
    workspace_read.clear_memo()
    yield workspace_read
    workspace_read.clear_memo()


def _counted(wr) -> tuple[int, int]:
    """``(entries, counted size)``, after checking the count against the texts."""

    assert wr._content_bytes == sum(len(t) for t in wr._content.values())
    assert wr._content_bytes <= wr.CONTENT_CACHE_BYTES
    return len(wr._content), wr._content_bytes


def test_a_text_remembered_again_is_counted_once(small_cache):
    wr = small_cache
    project = uuid4()
    for _ in range(3):
        wr._remember_content((project, "a"), "x" * 40)
    assert _counted(wr) == (1, 40)
    wr._remember_content((project, "b"), "y" * 10)
    assert _counted(wr) == (2, 50)
    assert (project, "a") in wr._content


def test_a_text_evicted_then_remembered_again_is_counted_once(small_cache):
    wr = small_cache
    project = uuid4()
    wr._remember_content((project, "a"), "a" * 40)
    wr._remember_content((project, "b"), "b" * 40)
    wr._remember_content((project, "c"), "c" * 40)  # evicts "a"
    assert (project, "a") not in wr._content
    assert _counted(wr) == (2, 80)
    wr._remember_content((project, "a"), "a" * 40)  # evicts "b"
    assert list(wr._content) == [(project, "c"), (project, "a")]
    assert _counted(wr) == (2, 80)


def test_the_counted_size_follows_any_sequence(small_cache):
    import random

    wr = small_cache
    rng = random.Random(7)
    projects = [uuid4(), uuid4()]
    for _ in range(2000):
        key = (rng.choice(projects), rng.choice("abcdefgh"))
        wr._remember_content(key, "z" * rng.choice([0, 1, 9, 30, 55, 100, 101]))
        _counted(wr)
        if rng.random() < 0.01:
            wr.clear_memo()
            assert _counted(wr) == (0, 0)


def test_concurrent_misses_count_a_text_once(small_cache):
    import threading

    wr = small_cache
    key = (uuid4(), "new-head")
    start = threading.Barrier(8)

    def remember():
        start.wait()
        for _ in range(50):
            wr._remember_content(key, "q" * 30)

    threads = [threading.Thread(target=remember) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert _counted(wr) == (1, 30)
