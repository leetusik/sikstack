"""The web's agenda writes as inbox entries, and the engine's side of the inbox: Postgres-gated.

The web never writes a workspace file. ``POST /app/projects/{id}/workspace/agenda``
(add), ``…/agenda/changes`` and ``…/inbox/{entry}/discard|retry`` write inbox entries
after the early checks (a title of 1 to 200 characters with the signed refusal, full
agenda ids, a known kind). A linked engine reads the pending entries
(``GET /api/workspace/{id}/inbox``), applies each as its own agenda command, and sends
each result in its next batch; a batch naming an entry that is no longer pending is a
409 and applies nothing. Until then the read model marks the item: ``sync`` is
``'waiting'`` (a pending add is its own row, a pending delete hides its item) or
``{refused, entry}`` (the engine's line, verbatim).

Like its neighbours this runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
_ENGINE_HEADERS = {"X-Sikstack-Checkout": "test-checkout", "X-Sikstack-Engine": "v99"}
_FIXTURES = Path(__file__).parent / "fixtures" / "workspace"
_REFUSAL = "Enter a title of 1–200 characters."
# The engine's agenda id rule, word for word: a number and a two-symbol tail of
# lowercase Crockford base32 without i l o u, at least one symbol a letter.
_AGENDA_ID = re.compile(r"A[0-9]+-(?:[a-hjkmnp-tv-z][0-9a-hjkmnp-tv-z]|[0-9][a-hjkmnp-tv-z])")


@pytest.fixture
def store(tmp_path, monkeypatch):
    """``(client, sync_engine)`` on a Postgres accounts plane, or skip."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the workspace inbox tests"
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
            yield client, sync_engine
    finally:
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        workspace_read.clear_memo()
        sync_engine.dispose()


# -- helpers -------------------------------------------------------------------------


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _signup(client: TestClient) -> dict:
    res = client.post(
        "/auth/signup",
        json={"email": f"wsinbox-{uuid4().hex}@example.com", "password": "hunter2pass"},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _session(owner: dict) -> dict:
    return {"Authorization": f"Bearer {owner['token']}"}


def _owner_with_key(client: TestClient) -> tuple[dict, str, dict]:
    owner = _signup(client)
    project_id = owner["project"]["id"]
    res = client.post(
        f"/app/projects/{project_id}/credentials",
        json={"scope": "workspace"},
        headers=_session(owner),
    )
    assert res.status_code == 201, res.text
    return owner, project_id, {"Authorization": f"Bearer {res.json()['key']}", **_ENGINE_HEADERS}


def _put(path: str, content: str, base_rev: int | None = None) -> dict:
    return {"op": "put", "path": path, "base_rev": base_rev,
            "sha256": _sha(content.encode("utf-8")), "content": content}


def _commit(client, project_id, key, ops=(), inbox=(), derived=()):
    body = {"batch_id": str(uuid4()), "command": ["sync"], "origin": "command",
            "ops": list(ops), "events": [], "derived": list(derived), "inbox": list(inbox)}
    return client.post(f"/api/workspace/{project_id}/commit", json=body, headers=key)


def _store_tree(client, project_id, key) -> dict:
    tree = json.loads((_FIXTURES / "tree.json").read_text(encoding="utf-8"))
    ops = []
    for path, content in tree["files"].items():
        if path in tree["append"]:
            ops.append({"op": "append", "path": path, "lines": content.rstrip("\n").split("\n")})
        else:
            ops.append(_put(path, content))
    derived = [{"path": path, "content": content} for path, content in tree["derived"].items()]
    res = _commit(client, project_id, key, ops, derived=derived)
    assert res.status_code == 200, res.text
    return res.json()


def _linked(client) -> tuple[dict, str, dict, dict]:
    owner, project_id, key = _owner_with_key(client)
    answer = _store_tree(client, project_id, key)
    return owner, project_id, key, answer


def _base(project_id: str) -> str:
    return f"/app/projects/{project_id}/workspace"


def _add(client, owner, project_id, title, **extra):
    return client.post(f"{_base(project_id)}/agenda", json={"title": title, **extra},
                       headers=_session(owner))


def _change(client, owner, project_id, kind, items, fields=None):
    body = {"kind": kind, "items": items}
    if fields is not None:
        body["fields"] = fields
    return client.post(f"{_base(project_id)}/agenda/changes", json=body, headers=_session(owner))


def _agenda(client, owner, project_id) -> list[dict]:
    res = client.get(_base(project_id), headers=_session(owner))
    assert res.status_code == 200, res.text
    return res.json()["agenda"]


def _sync_of(client, owner, project_id) -> dict:
    return {row["id"]: row["sync"] for row in _agenda(client, owner, project_id)}


def _pending(client, project_id, key) -> list[dict]:
    res = client.get(f"/api/workspace/{project_id}/inbox", headers=key)
    assert res.status_code == 200, res.text
    return res.json()["entries"]


def _author(owner: dict) -> str:
    """The author the server writes for this account: ``person:`` and its email's handle."""

    return "person:" + owner["user"]["email"].split("@")[0]


def _inbox_count(client, project_id, key) -> int:
    res = client.get(f"/api/workspace/{project_id}/head", headers=key)
    assert res.status_code == 200, res.text
    return res.json()["inbox_pending"]


# -- the early checks ------------------------------------------------------------------


def test_ids_outside_the_tail_rule_are_refused_before_the_inbox(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    for bad in ("A51-05", "A39-oh", "A2", "a2-k5", "A2-K5", "2-k5", "A2-k5 "):
        res = _change(client, owner, project_id, "solve", [bad])
        assert res.status_code == 422, (bad, res.text)
        assert bad.strip() in res.json()["detail"] or "agenda id" in res.json()["detail"]
    res = _change(client, owner, project_id, "move", ["A2-k5"], {"before": "A39-oh"})
    assert res.status_code == 422, res.text
    assert _inbox_count(client, project_id, key) == 0  # nothing reached the inbox

    assert _change(client, owner, project_id, "solve", ["A2-k5"]).status_code == 201
    assert _inbox_count(client, project_id, key) == 1


def test_a_title_of_201_characters_gets_the_signed_refusal(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    for bad in ("x" * 201, "", "   ", "two\nlines"):
        res = _add(client, owner, project_id, bad)
        assert res.status_code == 422, (bad, res.text)
        assert res.json()["detail"] == _REFUSAL
    res = _change(client, owner, project_id, "edit", ["A2-k5"], {"title": "y" * 201})
    assert res.status_code == 422 and res.json()["detail"] == _REFUSAL
    assert _inbox_count(client, project_id, key) == 0

    res = _add(client, owner, project_id, "x" * 200)
    assert res.status_code == 201, res.text
    assert _change(client, owner, project_id, "edit", ["A2-k5"],
                   {"title": "y" * 200}).status_code == 201
    assert _inbox_count(client, project_id, key) == 2


def test_an_unknown_kind_or_shape_is_refused(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    for kind, items, fields in (
        ("rename", ["A2-k5"], {}),
        ("add", ["A2-k5"], {"title": "t"}),  # an add has its own route
        ("solve", [], {}),
        ("edit", ["A2-k5", "A1-h7"], {"title": "t"}),
        ("edit", ["A2-k5"], {}),
        ("move", ["A2-k5"], {}),
        ("move", ["A2-k5"], {"first": True, "last": True}),
        ("defer", ["A2-k5"], {"reason": "no"}),
    ):
        res = _change(client, owner, project_id, kind, items, fields)
        assert res.status_code == 422, (kind, items, fields, res.text)
    assert _inbox_count(client, project_id, key) == 0


# -- minting -----------------------------------------------------------------------------


def test_the_web_mints_the_next_number_with_a_valid_tail(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    first = _add(client, owner, project_id, "Export is slow")
    assert first.status_code == 201, first.text
    minted = first.json()["item"]
    assert _AGENDA_ID.fullmatch(minted) and minted.startswith("A3-")
    second = _add(client, owner, project_id, "Import is slow")
    assert second.json()["item"].startswith("A4-")  # the pending add counts
    entry = second.json()["entry"]
    assert entry["kind"] == "add" and entry["state"] == "pending"
    assert entry["fields"] == {"title": "Import is slow", "author": _author(owner)}
    assert entry["created_at"].endswith("Z")


def test_minted_tails_always_follow_the_engine_rule():
    from server.workspace_web_api import mint_agenda_id

    known = {"A1-h7", "A2-k5"}
    for _ in range(2000):
        minted = mint_agenda_id(known)
        assert _AGENDA_ID.fullmatch(minted), minted
        assert minted.startswith("A3-")


# -- the read model's sync overlay --------------------------------------------------------


def test_the_overlay_waits_hides_and_shows_a_refusal(store):
    client, _engine = store
    owner, project_id, key, answer = _linked(client)
    base = _base(project_id)

    assert _sync_of(client, owner, project_id) == {"A2-k5": None, "A1-h7": None}

    added = _add(client, owner, project_id, "Export is slow", note="Twice today.").json()
    minted = added["item"]
    rows = _agenda(client, owner, project_id)
    assert rows[0]["id"] == minted  # a pending add is its own row, first in the list
    assert rows[0]["sync"] == "waiting" and rows[0]["title"] == "Export is slow"
    assert rows[0]["note"] == "Twice today." and rows[0]["state"] == "open"
    own = client.get(f"{base}/agenda/{minted}", headers=_session(owner))
    assert own.status_code == 200 and own.json()["sync"] == "waiting"

    deleted = _change(client, owner, project_id, "delete", ["A1-h7"]).json()["entry"]
    assert "A1-h7" not in _sync_of(client, owner, project_id)  # hidden at once
    waiting = client.get(f"{base}/agenda/A1-h7", headers=_session(owner))  # D309-zp
    assert waiting.status_code == 200, waiting.text
    assert waiting.json()["deleting"] is True and waiting.json()["sync"] == "waiting"

    solved = _change(client, owner, project_id, "solve", ["A2-k5"],
                     {"outcome": "Fixed the retry."}).json()["entry"]
    assert _sync_of(client, owner, project_id)["A2-k5"] == "waiting"

    entries = _pending(client, project_id, key)
    assert [e["id"] for e in entries] == [added["entry"]["id"], deleted["id"], solved["id"]]
    assert entries[2]["items"] == ["A2-k5"] and entries[2]["fields"] == {"outcome": "Fixed the retry."}

    line = ("refused: A2-k5 is In progress through P8-q4; "
            "works/agenda/A2-k5/agenda.json status: use open")
    res = _commit(client, project_id, key, inbox=[
        {"id": solved["id"], "state": "refused", "reason": line, "exit": 1},
    ])
    assert res.status_code == 200, res.text
    assert _sync_of(client, owner, project_id)["A2-k5"] == {
        "refused": line, "entry": solved["id"], "kind": "solve"}
    item = client.get(f"{base}/agenda/A2-k5", headers=_session(owner)).json()
    assert item["sync"] == {"refused": line, "entry": solved["id"], "kind": "solve"}

    path = "works/agenda/A1-h7/agenda.json"
    res = _commit(client, project_id, key,
                  ops=[{"op": "delete", "path": path, "base_rev": answer["revs"][path]}],
                  inbox=[{"id": deleted["id"], "state": "applied", "exit": 0}])
    assert res.status_code == 200, res.text
    assert "A1-h7" not in _sync_of(client, owner, project_id)  # gone from the store now
    assert [e["id"] for e in _pending(client, project_id, key)] == [added["entry"]["id"]]

    res = client.post(f"{base}/inbox/{solved['id']}/discard", headers=_session(owner))
    assert res.status_code == 200 and res.json()["entry"]["state"] == "discarded"
    assert _sync_of(client, owner, project_id)["A2-k5"] is None


def test_try_again_sends_the_refused_change_anew(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    base = _base(project_id)

    added = _add(client, owner, project_id, "Export is slow").json()
    _commit(client, project_id, key, inbox=[
        {"id": added["entry"]["id"], "state": "refused", "reason": "A3 exists", "exit": 1},
    ])
    assert _agenda(client, owner, project_id)[0]["sync"] == {
        "refused": "A3 exists", "entry": added["entry"]["id"], "kind": "add"}

    res = client.post(f"{base}/inbox/{added['entry']['id']}/retry", headers=_session(owner))
    assert res.status_code == 201, res.text
    again = res.json()
    assert again["entry"]["kind"] == "add" and again["entry"]["state"] == "pending"
    assert again["item"] != added["item"] and _AGENDA_ID.fullmatch(again["item"])  # re-minted
    rows = _agenda(client, owner, project_id)
    assert [r["id"] for r in rows if r["sync"] is not None] == [again["item"]]
    assert rows[0]["sync"] == "waiting"
    # the refused one is closed: a second Try again or a Discard is a 409
    assert client.post(f"{base}/inbox/{added['entry']['id']}/retry",
                       headers=_session(owner)).status_code == 409
    assert client.post(f"{base}/inbox/{again['entry']['id']}/retry",
                       headers=_session(owner)).status_code == 409  # pending, not refused


def test_the_overlay_never_reaches_the_memo(store):
    client, _engine = store
    owner, project_id, key, answer = _linked(client)
    import server.workspace_read as workspace_read

    _add(client, owner, project_id, "Export is slow")
    _change(client, owner, project_id, "delete", ["A1-h7"])
    _change(client, owner, project_id, "solve", ["A2-k5"])
    rows = _agenda(client, owner, project_id)
    assert {r["id"]: r["sync"] for r in rows}.get("A2-k5") == "waiting"
    client.get(f"{_base(project_id)}/agenda/A2-k5", headers=_session(owner))

    snapshots = [s for s in workspace_read._memo.values() if str(s.project_id) == project_id]
    assert snapshots
    for snap in snapshots:
        memo_rows = list(snap.results.get(("agenda",), []))
        memo_rows += list(snap.results.get(("workspace",), {}).get("agenda", []))
        assert memo_rows
        assert {r["id"] for r in memo_rows} == {"A2-k5", "A1-h7"}
        assert all(r["sync"] is None for r in memo_rows)

    # a change no row carries is listed per request, never memoized
    gone = _change(client, owner, project_id, "edit", ["A1-h7"], {"title": "Renamed"})
    path = "works/agenda/A1-h7/agenda.json"
    assert _commit(client, project_id, key, ops=[
        {"op": "delete", "path": path, "base_rev": answer["revs"][path]}]).status_code == 200
    shape = client.get(_base(project_id), headers=_session(owner)).json()
    assert gone.json()["entry"]["id"] in [u["entry"] for u in shape["unplaced"]]
    for snap in workspace_read._memo.values():
        if str(snap.project_id) == project_id:
            assert "unplaced" not in snap.results.get(("workspace",), {})

    # another request with an empty inbox reads no overlay
    with _engine.begin() as conn:
        conn.execute(text("UPDATE workspace_inbox SET state = 'discarded' WHERE project_id = :p"),
                     {"p": project_id})
    assert _sync_of(client, owner, project_id) == {"A2-k5": None}
    assert client.get(_base(project_id), headers=_session(owner)).json()["unplaced"] == []


def _unplaced(client, owner, project_id) -> list[dict]:
    res = client.get(_base(project_id), headers=_session(owner))
    assert res.status_code == 200, res.text
    return res.json()["unplaced"]


def _delete_file(client, project_id, key, answer, aid):
    path = f"works/agenda/{aid}/agenda.json"
    res = _commit(client, project_id, key,
                  ops=[{"op": "delete", "path": path, "base_rev": answer["revs"][path]}])
    assert res.status_code == 200, res.text


def test_a_change_whose_item_is_gone_stays_listed_until_discarded(store):
    client, _engine = store
    owner, project_id, key, answer = _linked(client)
    base = _base(project_id)
    assert _unplaced(client, owner, project_id) == []

    # a web edit, then another checkout deletes the item: the edit still shows, waiting
    edit = _change(client, owner, project_id, "edit", ["A1-h7"], {"title": "Renamed"})
    assert edit.status_code == 201, edit.text
    edit = edit.json()["entry"]
    _delete_file(client, project_id, key, answer, "A1-h7")
    assert "A1-h7" not in _sync_of(client, owner, project_id)
    [row] = _unplaced(client, owner, project_id)
    assert row["entry"] == edit["id"] and row["kind"] == "edit"
    assert row["items"] == ["A1-h7"] and row["fields"] == {"title": "Renamed"}
    assert row["sync"] == "waiting" and row["refused"] is None
    assert row["created"] == edit["created_at"]

    # the engine refuses it: the line shows, with the entry Discard and Try again name
    line = "refused, exit 1 (agenda-edit A1-h7): A1-h7 names no agenda item"
    res = _commit(client, project_id, key, inbox=[
        {"id": edit["id"], "state": "refused", "reason": line, "exit": 1}])
    assert res.status_code == 200, res.text
    [row] = _unplaced(client, owner, project_id)
    assert row["refused"] == line and row["sync"] == {
        "refused": line, "entry": edit["id"], "kind": "edit"}

    # Try again sends it anew (still listed, waiting); Discard closes it
    again = client.post(f"{base}/inbox/{edit['id']}/retry", headers=_session(owner))
    assert again.status_code == 201, again.text
    again = again.json()["entry"]
    assert [(u["entry"], u["sync"]) for u in _unplaced(client, owner, project_id)] == [
        (again["id"], "waiting")]
    res = client.post(f"{base}/inbox/{again['id']}/discard", headers=_session(owner))
    assert res.status_code == 200, res.text
    assert _unplaced(client, owner, project_id) == []


def test_a_refusal_shown_on_an_item_stays_listed_when_the_item_goes(store):
    client, _engine = store
    owner, project_id, key, answer = _linked(client)

    move = _change(client, owner, project_id, "move", ["A1-h7"], {"first": True}).json()["entry"]
    line = "refused, exit 1 (agenda-move A1-h7): A1-h7 is already first"
    _commit(client, project_id, key, inbox=[
        {"id": move["id"], "state": "refused", "reason": line, "exit": 1}])
    assert _sync_of(client, owner, project_id)["A1-h7"] == {
        "refused": line, "entry": move["id"], "kind": "move"}
    assert _unplaced(client, owner, project_id) == []  # shown on its item, not twice

    _delete_file(client, project_id, key, answer, "A1-h7")
    [row] = _unplaced(client, owner, project_id)
    assert row["entry"] == move["id"] and row["refused"] == line and row["kind"] == "move"


def test_a_refusal_behind_a_newer_change_stays_listed(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    solve = _change(client, owner, project_id, "solve", ["A2-k5"]).json()["entry"]
    line = "refused: A2-k5 is In progress through P8-q4"
    _commit(client, project_id, key, inbox=[
        {"id": solve["id"], "state": "refused", "reason": line, "exit": 1}])
    _change(client, owner, project_id, "edit", ["A2-k5"], {"note": "More."})
    assert _sync_of(client, owner, project_id)["A2-k5"] == "waiting"  # the newest entry
    [row] = _unplaced(client, owner, project_id)  # the older refusal is still in sight
    assert row["entry"] == solve["id"] and row["refused"] == line


def test_a_change_naming_an_id_the_workspace_lacks_is_refused_at_once(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    for kind, items, fields in (
        ("edit", ["A99-zz"], {"title": "Ghost"}),
        ("solve", ["A2-k5", "A99-zz"], None),
        ("delete", ["A99-zz"], None),
        ("move", ["A2-k5"], {"before": "A99-zz"}),
    ):
        res = _change(client, owner, project_id, kind, items, fields)
        assert res.status_code == 422, (kind, items, res.text)
        assert res.json()["detail"] == "A99-zz names no agenda item"
    assert _inbox_count(client, project_id, key) == 0

    # a pending add's id is the workspace's to come: a change may name it
    minted = _add(client, owner, project_id, "Export is slow").json()["item"]
    res = _change(client, owner, project_id, "edit", [minted], {"note": "Twice."})
    assert res.status_code == 201, res.text
    assert _change(client, owner, project_id, "move", ["A2-k5"],
                   {"after": minted}).status_code == 201
    assert _unplaced(client, owner, project_id) == []


# -- the engine's side -----------------------------------------------------------------------


def test_a_batch_naming_an_applied_entry_is_409_and_applies_nothing(store):
    client, engine = store
    owner, project_id, key, answer = _linked(client)
    other = {**key, "X-Sikstack-Checkout": "another-checkout"}

    entry = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]
    result = {"id": entry["id"], "state": "applied", "exit": 0}
    path = "works/agenda/A2-k5/agenda.json"
    first = _commit(client, project_id, key, ops=[_put(path, '{"id": "A2-k5"}\n',
                                                      answer["revs"][path])], inbox=[result])
    assert first.status_code == 200, first.text
    head = first.json()["head"]

    # this checkout again, and another checkout that applied the same entry
    for sender in (key, other):
        twice = _commit(client, project_id, sender,
                        ops=[_put("works/agenda/A2-k5/note.md", "second apply\n")],
                        inbox=[result])
        assert twice.status_code == 409, twice.text
        assert twice.json()["conflicts"] == [
            {"path": None, "inbox": entry["id"], "state": "applied"}]
    probe = client.get(f"/api/workspace/{project_id}/head", headers=key).json()
    assert probe["head"] == head  # nothing applied
    manifest = client.get(f"/api/workspace/{project_id}/manifest?since={head - 1}",
                          headers=key).json()
    assert "works/agenda/A2-k5/note.md" not in {c["path"] for c in manifest["changes"]}

    # a discarded entry: the engine's result is a 409 too
    gone = _change(client, owner, project_id, "reopen", ["A2-k5"]).json()["entry"]
    assert client.post(f"{_base(project_id)}/inbox/{gone['id']}/discard",
                       headers=_session(owner)).status_code == 200
    late = _commit(client, project_id, key, inbox=[{"id": gone["id"], "state": "applied",
                                                    "exit": 0}])
    assert late.status_code == 409
    assert late.json()["conflicts"] == [{"path": None, "inbox": gone["id"], "state": "discarded"}]


def test_an_engine_result_is_checked(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    entry = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]

    for bad in (
        {"id": entry["id"], "state": "refused", "exit": 1},  # a refusal names its line
        {"id": entry["id"], "state": "refused", "reason": "", "exit": 1},
        {"id": entry["id"], "state": "discarded"},  # only the web discards
        {"id": entry["id"], "state": "pending"},
    ):
        res = _commit(client, project_id, key, inbox=[bad])
        assert res.status_code == 400, (bad, res.text)
    twice = [{"id": entry["id"], "state": "applied", "exit": 0}] * 2
    assert _commit(client, project_id, key, inbox=twice).status_code == 400
    assert _inbox_count(client, project_id, key) == 1


def test_discard_closes_only_an_open_entry(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    base = _base(project_id)

    entry = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]
    res = client.post(f"{base}/inbox/{entry['id']}/discard", headers=_session(owner))
    assert res.status_code == 200 and res.json()["entry"]["state"] == "discarded"
    assert _inbox_count(client, project_id, key) == 0
    again = client.post(f"{base}/inbox/{entry['id']}/discard", headers=_session(owner))
    assert again.status_code == 409, again.text

    applied = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]
    _commit(client, project_id, key, inbox=[{"id": applied["id"], "state": "applied", "exit": 0}])
    assert client.post(f"{base}/inbox/{applied['id']}/discard",
                       headers=_session(owner)).status_code == 409
    assert client.post(f"{base}/inbox/{uuid4()}/discard",
                       headers=_session(owner)).status_code == 404
    assert client.post(f"{base}/inbox/not-a-uuid/discard",
                       headers=_session(owner)).status_code in (404, 422)


def test_writes_are_404_outside_the_tenant_and_when_unlinked(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    entry = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]
    stranger = _signup(client)
    base = _base(project_id)

    attempts = (
        ("agenda", {"title": "Mine now"}),
        ("agenda/changes", {"kind": "solve", "items": ["A2-k5"]}),
        (f"inbox/{entry['id']}/discard", None),
        (f"inbox/{entry['id']}/retry", None),
    )
    for route, body in attempts:
        res = client.post(f"{base}/{route}", json=body, headers=_session(stranger))
        assert res.status_code == 404, (route, res.text)
        assert client.post(f"{base}/{route}", json=body).status_code == 401
        assert client.post(f"{base}/{route}", json=body, headers=key).status_code == 401
    # the stranger's own project, linked or not, never sees this entry
    theirs = _base(stranger["project"]["id"])
    assert client.post(f"{theirs}/agenda", json={"title": "Mine"},
                       headers=_session(stranger)).status_code == 404  # unlinked
    assert client.post(f"{theirs}/inbox/{entry['id']}/discard",
                       headers=_session(stranger)).status_code == 404
    assert _inbox_count(client, project_id, key) == 1


def test_the_engine_reads_only_pending_entries_oldest_first(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    a = _change(client, owner, project_id, "defer", ["A2-k5"]).json()["entry"]
    b = _change(client, owner, project_id, "move", ["A2-k5"], {"first": True}).json()["entry"]
    c = _add(client, owner, project_id, "Export is slow").json()["entry"]
    client.post(f"{_base(project_id)}/inbox/{b['id']}/discard", headers=_session(owner))

    entries = _pending(client, project_id, key)
    assert [e["id"] for e in entries] == [a["id"], c["id"]]
    assert set(entries[1]) == {"id", "created_at", "kind", "items", "fields", "minted_id"}
    assert entries[1]["minted_id"] == entries[1]["items"][0]
    assert _inbox_count(client, project_id, key) == 2

    owner2, project2, key2 = _owner_with_key(client)
    assert client.get(f"/api/workspace/{project_id}/inbox", headers=key2).status_code == 404
    assert client.get(f"/api/workspace/{project_id}/inbox",
                      headers=_session(owner)).status_code in (401, 403)


# -- the head probe -------------------------------------------------------------------------


def test_an_up_to_date_head_probe_counts_as_a_sync(store):
    client, engine = store
    owner, project_id, key, answer = _linked(client)
    old = datetime.now(UTC) - timedelta(hours=30)

    def set_last(at):
        with engine.begin() as conn:
            conn.execute(text("UPDATE workspaces SET last_sync_at = :at WHERE project_id = :p"),
                         {"at": at, "p": project_id})

    def last():
        with engine.connect() as conn:
            return conn.execute(text("SELECT last_sync_at FROM workspaces WHERE project_id = :p"),
                                {"p": project_id}).scalar_one()

    set_last(old)
    for stale in ("", "nope", str(answer["head"] - 1)):
        res = client.get(f"/api/workspace/{project_id}/head",
                         headers={**key, "X-Sikstack-Base": stale})
        assert res.status_code == 200
        assert last() == old, stale
    assert _sync_of(client, owner, project_id)  # still readable
    assert client.get(_base(project_id), headers=_session(owner)).json()["sync"]["state"] == "behind"

    res = client.get(f"/api/workspace/{project_id}/head",
                     headers={**key, "X-Sikstack-Base": str(answer["head"])})
    assert res.status_code == 200
    assert last() > old + timedelta(hours=29)
    assert client.get(_base(project_id), headers=_session(owner)).json()["sync"]["state"] == "fresh"


# -- thread entries, accepts, authors and feedback on the agenda (P61-e9) ---------------


def test_a_note_is_one_entry_with_the_sessions_author_and_the_webs_source(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    base = _base(project_id)

    res = _change(client, owner, project_id, "entry", ["A2-k5"],
                  {"kind": "note", "body": "  Seen twice on 3G.  "})
    assert res.status_code == 201, res.text
    entry = res.json()["entry"]
    assert entry["kind"] == "entry" and entry["items"] == ["A2-k5"]
    assert entry["fields"] == {"kind": "note", "body": "Seen twice on 3G.",
                               "author": _author(owner), "source": "web:agenda"}
    assert "@" not in entry["fields"]["author"]
    [pending] = _pending(client, project_id, key)
    assert pending["kind"] == "entry" and pending["fields"] == entry["fields"]

    # an author or a source from the client is refused, never kept
    for extra in ({"author": "person:someone-else"}, {"source": "feedback:x"}):
        res = _change(client, owner, project_id, "entry", ["A2-k5"],
                      {"kind": "note", "body": "Mine.", **extra})
        assert res.status_code == 422, res.text
    assert _inbox_count(client, project_id, key) == 1

    # the thread shows it at once, waiting, and the item reads waiting
    item = client.get(f"{base}/agenda/A2-k5", headers=_session(owner)).json()
    assert item["sync"] == "waiting"
    [shown] = item["entries"]
    assert shown == {"id": entry["id"], "kind": "note", "author": _author(owner),
                     "by": "person", "name": _author(owner).split(":", 1)[1],
                     "source": "web:agenda", "created": entry["created_at"],
                     "body": "Seen twice on 3G.", "job": None, "sync": "waiting"}


def test_an_entry_refuses_a_bad_kind_an_empty_body_and_a_long_one(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)

    for items, fields in (
        (["A2-k5"], {"kind": "rumor", "body": "x"}),
        (["A2-k5"], {"body": "no kind"}),
        (["A2-k5"], {"kind": "note", "body": ""}),
        (["A2-k5"], {"kind": "note", "body": "   \n "}),
        (["A2-k5"], {"kind": "note"}),
        (["A2-k5"], {"kind": "note", "body": "x" * 20_001}),
        (["A2-k5"], {"kind": "note", "body": 7}),
        (["A2-k5", "A1-h7"], {"kind": "note", "body": "two items"}),
        (["A99-zz"], {"kind": "note", "body": "no such item"}),
    ):
        res = _change(client, owner, project_id, "entry", items, fields)
        assert res.status_code == 422, (items, fields, res.text)
    assert _inbox_count(client, project_id, key) == 0
    for kind in ("note", "issue", "feedback", "question", "decision"):
        assert _change(client, owner, project_id, "entry", ["A2-k5"],
                       {"kind": kind, "body": "x" * 20_000}).status_code == 201
    assert _inbox_count(client, project_id, key) == 5


def _proposed_item(client, project_id, key, aid="A3-p7") -> None:
    data = {"id": aid, "title": "Retry storms", "note": None, "status": "open", "order": 3.0,
            "created_at": "2026-11-20T09:00:00+09:00", "changed_at": "2026-11-20T09:00:00+09:00",
            "outcome": None, "reason": None,
            "proposed": {"by": "agent:claude-opus-5-5", "at": "2026-11-20T09:00:00+09:00"}}
    res = _commit(client, project_id, key,
                  ops=[_put(f"works/agenda/{aid}/agenda.json", json.dumps(data) + "\n")])
    assert res.status_code == 200, res.text


def test_accept_is_one_entry_for_a_proposed_item_and_refused_otherwise(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    _proposed_item(client, project_id, key)

    res = _change(client, owner, project_id, "accept", ["A3-p7"])
    assert res.status_code == 201, res.text
    entry = res.json()["entry"]
    assert entry["kind"] == "accept" and entry["items"] == ["A3-p7"] and entry["fields"] == {}
    assert _sync_of(client, owner, project_id)["A3-p7"] == "waiting"

    # not Proposed: refused up front in the engine's own words (agenda-accept)
    res = _change(client, owner, project_id, "accept", ["A2-k5"])
    assert res.status_code == 422
    assert res.json()["detail"] == "A2-k5 is In progress: only a Proposed item is accepted"
    res = _change(client, owner, project_id, "accept", ["A3-p7", "A1-h7"])
    assert res.json()["detail"] == "A1-h7 is Solved: only a Proposed item is accepted"
    minted = _add(client, owner, project_id, "A web add is Open").json()["item"]
    res = _change(client, owner, project_id, "accept", [minted])
    assert res.json()["detail"] == f"{minted} is Open: only a Proposed item is accepted"
    assert _change(client, owner, project_id, "accept", ["A99-zz"]).json()["detail"] == (
        "A99-zz names no agenda item")
    assert _change(client, owner, project_id, "accept", ["A3-p7"],
                   {"first": True}).status_code == 422
    assert _inbox_count(client, project_id, key) == 2  # the accept and the add

    # another account is refused by the same rule as a move
    stranger = _signup(client)
    for kind in ("accept", "move"):
        fields = {"first": True} if kind == "move" else None
        body = {"kind": kind, "items": ["A3-p7"], **({"fields": fields} if fields else {})}
        res = client.post(f"{_base(project_id)}/agenda/changes", json=body,
                          headers=_session(stranger))
        assert res.status_code == 404, (kind, res.text)
    assert _inbox_count(client, project_id, key) == 2


def test_the_inbox_kinds_are_pinned_to_the_routes_fields():
    from server.workspace.types import INBOX_KINDS
    from server.workspace_web_api import _KIND_FIELDS

    assert set(INBOX_KINDS) == set(_KIND_FIELDS) | {"add"}
    assert {"entry", "accept"} <= set(INBOX_KINDS)
    assert _KIND_FIELDS["entry"] == ("kind", "body") and _KIND_FIELDS["accept"] == ()


def test_the_author_is_the_accounts_handle_and_never_its_email():
    from server.workspace.types import ENTRY_AUTHOR_PATTERN, ENTRY_SOURCE_PATTERN, WEB_NOTE_SOURCE
    from server.workspace_web_api import person_author

    author_re = re.compile(ENTRY_AUTHOR_PATTERN, re.DOTALL)
    cases = {
        "june@example.com": "person:june",
        "June.Kim+kb@example.com": "person:June.Kim+kb",
        '"a@b"@example.com': 'person:"ab"',
        ":june@example.com": "person:june",
        "ju ne x@example.com": "person:junex",
        "@example.com": "person:web",
        ":::@example.com": "person:web",
        "": "person:web",
        None: "person:web",
        "no-at-sign": "person:no-at-sign",
    }
    for email, author in cases.items():
        assert person_author(email) == author, email
    long = person_author("x" * 300 + "@example.com")
    assert len(long) == 120 and long.startswith("person:x")
    for email in [*cases, "x" * 300 + "@example.com", "\n\n@x", "a\tb@x"]:
        written = person_author(email)
        assert "@" not in written and author_re.fullmatch(written), email
    assert re.fullmatch(ENTRY_SOURCE_PATTERN, WEB_NOTE_SOURCE)


def test_the_entry_rules_are_the_engines_word_for_word():
    """The server's copies of the engine's entry rules match its source, line for line."""

    source = Path(__file__).resolve().parent.parent / "plugins/sikstack/scripts/wf_agenda.py"
    if not source.is_file():
        pytest.skip("the sikstack engine's source is not in this tree")
    text = source.read_text(encoding="utf-8")
    from server.workspace import types

    kinds = ", ".join(f'"{kind}"' for kind in types.ENTRY_KINDS)
    assert f"ENTRY_KINDS = ({kinds})" in text
    assert f'ENTRY_ONE_LINE = r"{types.ENTRY_ONE_LINE}"' in text
    assert ('ENTRY_AUTHOR_RE = re.compile(rf"(?=.{{1,120}}\\Z)(?:person|agent):[^\\s:]'
            '{ENTRY_ONE_LINE}*", re.DOTALL)') in text
    assert ('ENTRY_SOURCE_RE = re.compile(rf"[a-z][a-z0-9-]{{0,19}}:[^\\s]'
            '{ENTRY_ONE_LINE}{{0,298}}")') in text
    assert types.ENTRY_AUTHOR_PATTERN == (
        r"(?=.{1,120}\Z)(?:person|agent):[^\s:]" + types.ENTRY_ONE_LINE + "*")
    assert types.ENTRY_SOURCE_PATTERN == (
        r"[a-z][a-z0-9-]{0,19}:[^\s]" + types.ENTRY_ONE_LINE + "{0,298}")


def _feedback(client, owner, message: str) -> str:
    res = client.post(f"/app/projects/{owner['project']['id']}/credentials",
                      json={"scope": "capture"}, headers=_session(owner))
    assert res.status_code == 201, res.text
    capture = {"Authorization": f"Bearer {res.json()['key']}"}
    res = client.post("/api/feedback", headers=capture,
                      json={"message": message, "source": {"product": "app-x"}})
    assert res.status_code == 202, res.text
    return res.json()["request_id"]


def _file(client, owner, feedback_id, **body):
    return client.post(f"/app/feedback/{feedback_id}/agenda", json=body or None,
                       headers=_session(owner))


def _became(client, owner, feedback_id) -> dict:
    res = client.get(f"/app/feedback/{feedback_id}/agenda", headers=_session(owner))
    assert res.status_code == 200, res.text
    return res.json()


def test_feedback_files_onto_a_new_item_or_an_existing_one(store):
    client, _engine = store
    owner, project_id, key, _ = _linked(client)
    first = _feedback(client, owner, "Export hangs at 99%\nOn a 2 GB file.")
    second = _feedback(client, owner, "Export never finishes")

    res = _file(client, owner, first)
    assert res.status_code == 201, res.text
    minted = res.json()["item"]
    add, entry = res.json()["entries"]
    assert add["kind"] == "add" and add["minted_id"] == minted
    assert add["fields"] == {"title": "Export hangs at 99%", "author": _author(owner)}
    assert entry["kind"] == "entry" and entry["items"] == [minted]
    assert entry["fields"] == {
        "kind": "feedback", "author": _author(owner), "source": f"feedback:{first}",
        "body": f"Export hangs at 99%\nOn a 2 GB file.\n\n/feedback/{first}"}
    # the engine reads the add first, then the entry on its minted id
    assert [e["id"] for e in _pending(client, project_id, key)] == [add["id"], entry["id"]]
    rows = _agenda(client, owner, project_id)
    assert rows[0]["id"] == minted and rows[0]["sync"] == "waiting"

    # onto the item that exists: the entry alone, no new item
    res = _file(client, owner, second, item=minted)
    assert res.status_code == 201, res.text
    [only] = res.json()["entries"]
    assert only["kind"] == "entry" and only["items"] == [minted]
    assert only["fields"]["source"] == f"feedback:{second}"
    assert len(_agenda(client, owner, project_id)) == 3  # the two stored and the one add
    assert _file(client, owner, second, item=minted).status_code == 409  # already on it
    assert _file(client, owner, second, item="A99-zz").json()["detail"] == (
        "A99-zz names no agenda item")
    assert _file(client, owner, second, item="A2-k5", note="x").status_code == 422
    assert _inbox_count(client, project_id, key) == 3

    # another org's feedback, or one whose project has no linked workspace, is refused
    stranger = _signup(client)
    assert _file(client, stranger, first).status_code == 404
    assert client.get(f"/app/feedback/{first}/agenda",
                      headers=_session(stranger)).status_code == 404
    theirs = _feedback(client, stranger, "Their own feedback")
    res = _file(client, stranger, theirs)
    assert res.status_code == 404 and res.json()["detail"] == "workspace not found"
    assert _became(client, stranger, theirs)["linked"] is False
    assert _inbox_count(client, project_id, key) == 3


def test_what_a_piece_of_feedback_became_reads_from_the_entries(store):
    client, _engine = store
    owner, project_id, key, answer = _linked(client)
    first = _feedback(client, owner, "Export hangs")
    second = _feedback(client, owner, "Export is slow")
    assert _became(client, owner, first) == {"project": project_id, "linked": True, "items": []}

    filed = _file(client, owner, first).json()
    minted = filed["item"]
    assert _file(client, owner, second, item="A2-k5").status_code == 201
    became = _became(client, owner, first)
    assert [(i["id"], i["state"], i["sync"]) for i in became["items"]] == [(minted, "open", "waiting")]
    assert [i["id"] for i in _became(client, owner, second)["items"]] == ["A2-k5"]

    # the engine applies all three: the items now hold the entries, stored
    item = {"id": minted, "title": "Export hangs", "note": None, "status": "open", "order": 1.0,
            "created_at": "2026-11-24T10:00:00+09:00", "changed_at": "2026-11-24T10:00:00+09:00",
            "outcome": None, "reason": None}
    def entry_file(aid, name, feedback_id):
        data = {"kind": "feedback", "author": _author(owner), "source": f"feedback:{feedback_id}",
                "created_at": "2026-11-24T10:00:00+09:00", "body": f"x\n\n/feedback/{feedback_id}"}
        return _put(f"works/agenda/{aid}/entries/{name}.json", json.dumps(data) + "\n")
    pending = _pending(client, project_id, key)
    res = _commit(client, project_id, key, ops=[
        _put(f"works/agenda/{minted}/agenda.json", json.dumps(item) + "\n"),
        entry_file(minted, "20261124T010000.000001Z-aaaa", first),
        entry_file("A2-k5", "20261124T010000.000002Z-bbbb", second),
    ], inbox=[{"id": e["id"], "state": "applied", "exit": 0} for e in pending])
    assert res.status_code == 200, res.text
    assert [(i["id"], i["sync"]) for i in _became(client, owner, first)["items"]] == [(minted, None)]
    assert [(i["id"], i["sync"]) for i in _became(client, owner, second)["items"]] == [("A2-k5", None)]
    thread = client.get(f"{_base(project_id)}/agenda/{minted}", headers=_session(owner)).json()
    assert [(e["kind"], e["source"], e["sync"]) for e in thread["entries"]] == [
        ("feedback", f"feedback:{first}", None)]
