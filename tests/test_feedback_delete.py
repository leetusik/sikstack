"""Feedback deletion: an org owner's session delete, and the unlinked sweep's own clock.

An owner deletes one feedback or several (``POST /app/feedback/delete {ids}``), all in
the active org or none: the event goes with its comments, state and attachment rows in
one transaction, then its files, best effort. A member is refused. The stale unlinked
upload sweep also runs without an upload: at start-up and on a timer in the app's
lifespan. Postgres-gated like ``test_feedback_api`` (the lifespan cases are not).
"""

from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from tests.test_feedback_api import (  # noqa: F401 - the fixture
    _age,
    _attachment_row,
    _capture,
    _h,
    _key,
    _signup,
    _sql,
    _upload,
    fb,
)
from tests.test_feedback_states import _set, _state


class _Org:
    def __init__(self, client: TestClient) -> None:
        self.owner = _signup(client)
        self.key = _key(client, self.owner)

    def feedback(self, client: TestClient, message: str = "x", *, files: int = 0) -> str:
        """One feedback with a comment, a stored state and ``files`` attachments."""

        ids = [_upload(client, _h(self.key)).json()["attachment_id"] for _ in range(files)]
        fid = _capture(client, _h(self.key), message=message, attachment_ids=ids)["request_id"]
        res = client.post(f"/api/project/feedback/{fid}/comments",
                          json={"body": "seen", "author": "op"}, headers=_h(self.key))
        assert res.status_code == 201, res.text
        assert _set(client, self, [fid], "dropped", reason="dupe").status_code == 200
        return fid


def _delete(client: TestClient, org: _Org, ids: list[str], headers: dict | None = None):
    return client.post("/app/feedback/delete", json={"ids": ids},
                       headers=org.owner["session"] if headers is None else headers)


def _rows(fid: str) -> dict[str, int]:
    """How many rows of each kind still name ``fid``."""

    counts = {}
    for table, column in (("feedback_events", "id"), ("feedback_comments", "feedback_id"),
                          ("feedback_triage", "feedback_id"),
                          ("feedback_attachments", "feedback_id")):
        counts[table] = _sql(f"SELECT count(*) FROM {table} WHERE {column} = :id", id=fid)[0][0]
    return counts


def _files(fid: str) -> list:
    from server.feedback.storage import attachments_dir

    keys = _sql("SELECT storage_key FROM feedback_attachments WHERE feedback_id = :id", id=fid)
    return [attachments_dir() / row.storage_key for row in keys]


@pytest.fixture
def api_log(monkeypatch, caplog):
    """caplog on ``server.feedback_api``; an earlier migration test's alembic
    ``fileConfig`` disables existing loggers, so turn this one back on."""

    monkeypatch.setattr(logging.getLogger("server.feedback_api"), "disabled", False)
    return caplog


_GONE = {"feedback_events": 0, "feedback_comments": 0, "feedback_triage": 0,
         "feedback_attachments": 0}


def _member(client: TestClient, org: _Org) -> dict:
    member = _signup(client)
    _sql("INSERT INTO tenant_members (id, tenant_id, user_id, role) VALUES (:id, :t, :u, 'member')",
         id=uuid4(), t=org.owner["tenant"]["id"], u=member["user"]["id"])
    return {**member["session"], "X-Sikstack-Org": org.owner["tenant"]["id"]}


# --- the owner's delete ----------------------------------------------------------------


def test_an_owner_deletes_one_feedback_with_its_rows_and_files(fb):
    """Claim 1."""

    org = _Org(fb)
    a = org.feedback(fb, "a", files=2)
    keep = org.feedback(fb, "keep", files=1)
    files = _files(a)
    assert len(files) == 2 and all(p.exists() for p in files)
    assert _rows(a) == {"feedback_events": 1, "feedback_comments": 1, "feedback_triage": 1,
                        "feedback_attachments": 2}

    res = _delete(fb, org, [a])
    assert res.status_code == 200, res.text
    assert res.json() == {"deleted": [a], "files": 2}
    assert _rows(a) == _GONE
    assert not any(p.exists() for p in files)
    assert fb.get(f"/app/feedback/{a}", headers=org.owner["session"]).status_code == 404
    # the neighbour is untouched
    assert _rows(keep)["feedback_attachments"] == 1 and all(p.exists() for p in _files(keep))


def test_an_owner_deletes_several_at_once(fb):
    """Claim 2: duplicate ids count once; the answer keeps the request's order."""

    org = _Org(fb)
    a, b, c = org.feedback(fb, "a", files=1), org.feedback(fb, "b"), org.feedback(fb, "c", files=2)
    files = _files(a) + _files(c)
    res = _delete(fb, org, [c, a, b, a])
    assert res.status_code == 200, res.text
    assert res.json() == {"deleted": [c, a, b], "files": 3}
    for fid in (a, b, c):
        assert _rows(fid) == _GONE
    assert not any(p.exists() for p in files)


def test_a_member_is_refused_and_nothing_goes(fb):
    """Claim 3, and claim 4's second half: a member's session is a 403 even for ids in
    the org, and even with a bad body."""

    org = _Org(fb)
    a = org.feedback(fb, "a", files=1)
    member = _member(fb, org)
    res = _delete(fb, org, [a], headers=member)
    assert res.status_code == 403, res.text
    assert _delete(fb, org, [], headers=member).status_code == 403
    assert _rows(a)["feedback_events"] == 1 and all(p.exists() for p in _files(a))
    # the member still reads it, and may still set its state
    assert fb.get(f"/app/feedback/{a}", headers=member).status_code == 200


def test_one_id_outside_the_org_deletes_nothing(fb):
    """Claim 4: another org's id or an unknown one refuses the whole selection."""

    org, stranger = _Org(fb), _Org(fb)
    a = org.feedback(fb, "a", files=1)
    theirs = stranger.feedback(fb, "theirs", files=1)
    for ids in ([a, theirs], [a, str(uuid4())], [theirs]):
        res = _delete(fb, org, ids)
        assert res.status_code == 404 and res.json() == {"detail": "feedback not found"}
    assert _rows(a)["feedback_events"] == 1 and all(p.exists() for p in _files(a))
    assert _rows(theirs)["feedback_events"] == 1 and all(p.exists() for p in _files(theirs))

    # bad bodies are 422s with one line; nothing goes
    for body in ({"ids": []}, {"ids": "a"}, {"ids": ["nope"]}, {}, {"ids": [a], "state": "x"},
                 {"ids": [str(uuid4()) for _ in range(101)]}, []):
        res = fb.post("/app/feedback/delete", json=body, headers=org.owner["session"])
        assert res.status_code == 422, (body, res.text)
        assert isinstance(res.json()["detail"], str)
    # no session, or an org the caller is not in
    assert fb.post("/app/feedback/delete", json={"ids": [a]}).status_code == 401
    res = _delete(fb, org, [a], headers={**stranger.owner["session"],
                                         "X-Sikstack-Org": org.owner["tenant"]["id"]})
    assert res.status_code == 403
    assert _rows(a)["feedback_events"] == 1


def test_a_file_that_will_not_delete_is_logged_and_the_call_succeeds(fb, monkeypatch, api_log):
    """Claim 5."""

    from server.feedback.storage import LocalFilesystemAttachmentStorage, StorageError

    org = _Org(fb)
    a = org.feedback(fb, "a", files=2)
    files = _files(a)

    def refuse(self, key):
        raise StorageError("disk says no")

    monkeypatch.setattr(LocalFilesystemAttachmentStorage, "delete", refuse)
    with api_log.at_level(logging.WARNING, logger="server.feedback_api"):
        res = _delete(fb, org, [a])
    assert res.status_code == 200, res.text
    assert res.json() == {"deleted": [a], "files": 2}
    assert _rows(a) == _GONE
    assert all(p.exists() for p in files)  # left behind, and said so
    warned = [r for r in api_log.records if "attachment" in r.getMessage()]
    assert len(warned) == 2


def test_an_agenda_entry_naming_a_deleted_feedback_stays(fb):
    """Claim 8: the delete writes nothing to the workspace."""

    from tests.test_feedback_states import AID, _Org as _WsOrg, _agenda, _commit, _item

    org = _WsOrg(fb)
    a = org.feedback(fb, "a")
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}")])
    before = _sql("SELECT path, rev, sha256 FROM workspace_files WHERE project_id = :p "
                  "ORDER BY path", p=org.pid)
    assert any(f"/{AID}/entries/" in row.path for row in before)
    res = fb.post("/app/feedback/delete", json={"ids": [a]}, headers=org.owner["session"])
    assert res.status_code == 200, res.text
    assert _sql("SELECT path, rev, sha256 FROM workspace_files WHERE project_id = :p "
                "ORDER BY path", p=org.pid) == before


# --- the sweep without an upload ------------------------------------------------------


def test_the_sweep_runs_without_an_upload(fb, monkeypatch):
    """Claim 6: the entry point, a short TTL, no upload call."""

    import server.feedback_api as feedback_api
    from server.feedback.storage import attachments_dir

    owner = _signup(fb)
    key = _key(fb, owner, scope="capture")
    stale, fresh, linked = (_upload(fb, _h(key)).json()["attachment_id"] for _ in range(3))
    eid = _capture(fb, _h(key), attachment_ids=[linked])["request_id"]
    path = {aid: attachments_dir() / _attachment_row(aid)[0].storage_key
            for aid in (stale, fresh, linked)}
    monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_UNLINKED_TTL_S", "60")
    _age(stale, "2 minutes")
    _age(linked, "2 minutes")

    reclaimed = fb.portal.call(feedback_api.sweep_unlinked_attachments)

    assert reclaimed >= 1
    assert _attachment_row(stale) == [] and not path[stale].exists()
    assert _attachment_row(fresh) != [] and path[fresh].exists()
    assert str(_attachment_row(linked)[0].feedback_id) == eid and path[linked].exists()


# --- the lifespan's timer (no Postgres) -----------------------------------------------


@pytest.fixture
def fake_sweep(monkeypatch, tmp_path):
    """The lifespan with a recording sweep in place of the real one."""

    import server.feedback_api as feedback_api
    import server.sharing as sharing

    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))

    async def no_fill(conn, **kwargs):
        return None

    monkeypatch.setattr(sharing, "fill_once", no_fill)
    calls: list[str] = []

    async def sweep(storage=None):
        calls.append("run")
        if len(calls) == 2:
            raise RuntimeError("one bad run")  # logged; the loop goes on
        return 0

    monkeypatch.setattr(feedback_api, "sweep_unlinked_attachments", sweep)
    return calls


def _wait_for(predicate, seconds: float = 3.0) -> bool:
    import time

    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def test_the_lifespan_sweeps_at_start_and_on_its_timer_then_stops(fake_sweep, monkeypatch, api_log):
    """Claim 7: configured, it runs at once and then every interval; a failing run is
    logged and the loop goes on; shutdown cancels it."""

    import server.feedback_api as feedback_api
    from server.main import app

    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://nobody@127.0.0.1:1/none")
    monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_SWEEP_INTERVAL_S", "0.05")
    with api_log.at_level(logging.ERROR, logger="server.feedback_api"):
        with TestClient(app):
            assert _wait_for(lambda: len(fake_sweep) >= 4)
            task = feedback_api._sweep_task
            assert task is not None and not task.done()
    assert task.done() and task.cancelled()
    assert feedback_api._sweep_task is None
    stopped = len(fake_sweep)
    asyncio.run(asyncio.sleep(0.15))
    assert len(fake_sweep) == stopped
    assert any("sweep" in r.getMessage() for r in api_log.records)


@pytest.mark.parametrize("env", [{"DATABASE_URL": None},
                                 {"KB_FEEDBACK_ATTACHMENTS_SWEEP_INTERVAL_S": "0"}])
def test_the_lifespan_sweeps_only_when_feedback_is_configured(fake_sweep, monkeypatch, env):
    """Claim 7: no ``DATABASE_URL`` (no feedback store), or the interval at 0, starts no
    sweep at all."""

    import server.feedback_api as feedback_api
    from server.main import app

    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://nobody@127.0.0.1:1/none")
    monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_SWEEP_INTERVAL_S", "0.05")
    for name, value in env.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)
    with TestClient(app):
        assert getattr(feedback_api, "_sweep_task", None) is None
        assert not _wait_for(lambda: bool(fake_sweep), seconds=0.2)


def test_the_sweep_interval_defaults_to_an_hour(monkeypatch):
    from server import config

    monkeypatch.delenv("KB_FEEDBACK_ATTACHMENTS_SWEEP_INTERVAL_S", raising=False)
    assert config.feedback_attachments_sweep_interval_s() == 3600
    for raw, want in (("0", 0), ("-5", 0), ("junk", 3600), ("120", 120)):
        monkeypatch.setenv("KB_FEEDBACK_ATTACHMENTS_SWEEP_INTERVAL_S", raw)
        assert config.feedback_attachments_sweep_interval_s() == want
