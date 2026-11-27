"""Feedback states: one stored state per feedback, and the loop a landed sync closes.

Every feedback reads ``open | filed | resolved | dropped`` from ``feedback_triage`` (no
row reads Open). The session list filters and counts by it; any org member sets
Resolved, Dropped or Open on one id or several (all in the active org, or none); the
web filing and the engine's mark write Filed; a landed workspace batch files a
feedback a new item names and resolves a Filed one once, when its item turns done or
its agenda turns Solved. Postgres-gated like ``test_feedback_api``.
"""

from __future__ import annotations

import hashlib
import json
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

from tests.test_feedback_api import (  # noqa: F401 - the fixture
    _ENGINE,
    _RAW_DSN,
    _capture,
    _h,
    _key,
    _mark,
    _signup,
    _triage,
    fb,
)

AID = "A3-k7"
ITEM = "20261124T010000.000001Z-aaaa"
ITEM2 = "20261124T010000.000002Z-bbbb"


# --- helpers ---------------------------------------------------------------------------


class _Org:
    def __init__(self, client: TestClient) -> None:
        self.owner = _signup(client)
        self.pid = self.owner["project"]["id"]
        self.ws = _key(client, self.owner, scope="workspace", project=True)
        self.capture = _key(client, self.owner, scope="capture", project=True)
        self.revs: dict[str, int] = {}

    def feedback(self, client: TestClient, message: str = "x", **extra) -> str:
        return _capture(client, _h(self.capture), message=message, **extra)["request_id"]


def _put(org: _Org, path: str, data: dict | str) -> dict:
    content = data if isinstance(data, str) else json.dumps(data) + "\n"
    return {"op": "put", "path": path, "base_rev": org.revs.get(path),
            "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(), "content": content}


def _agenda(org: _Org, aid: str = AID, status: str = "open", note: str | None = None) -> dict:
    record = {"id": aid, "title": "Export", "note": note, "status": status, "order": 1.0,
              "created_at": "2026-11-24T10:00:00Z", "changed_at": "2026-11-24T10:00:00Z",
              "outcome": "done" if status == "solved" else None,
              "reason": "every item dismissed or deleted" if status == "dropped" else None}
    return _put(org, f"works/agenda/{aid}/agenda.json", record)


def _item(org: _Org, source: str, *, aid: str = AID, name: str = ITEM, state: str | None = None,
          by: str | None = "person:op", body: str = "x") -> dict:
    data: dict = {"kind": "feedback", "author": "person:op", "source": source,
                  "created_at": "2026-11-24T10:00:00Z", "body": body}
    if state is not None:
        data.update(state=state, state_by=by, state_at="2026-11-25T10:00:00Z")
        if by is None:
            del data["state_by"]
    return _put(org, f"works/agenda/{aid}/entries/{name}.json", data)


def _commit(client: TestClient, org: _Org, ops: list, *, batch_id: str | None = None,
            expect: int = 200):
    batch = {"batch_id": batch_id or str(uuid4()), "command": ["agenda-item", "done"],
             "origin": "command", "ops": ops, "events": [], "derived": [], "inbox": []}
    res = client.post(f"/api/workspace/{org.pid}/commit", headers={**_h(org.ws), **_ENGINE},
                      json=batch)
    assert res.status_code == expect, res.text
    if res.status_code == 200:
        org.revs.update(res.json()["revs"])
    return batch, res


def _state(client: TestClient, org: _Org, fid: str) -> dict:
    res = client.get(f"/app/feedback/{fid}", headers=org.owner["session"])
    assert res.status_code == 200, res.text
    return res.json()["record"]["state"]


def _set(client: TestClient, org: _Org, ids: list[str], state: str, **extra):
    return client.post("/app/feedback/state", json={"ids": ids, "state": state, **extra},
                       headers=org.owner["session"])


def _file(client: TestClient, org: _Org, fid: str, aid: str = AID) -> None:
    res = _mark(client, org.pid, org.ws, fid, state="filed", agenda=aid, by="agent:sikstack")
    assert res.status_code == 200, res.text


# --- the sync rule --------------------------------------------------------------------


def test_an_items_done_resolves_its_filed_feedback_once(fb):
    """Check 1: the done transition resolves a Filed feedback; a replayed batch and a
    later batch rewriting the same done item leave the row as it was."""

    org = _Org(fb)
    a = org.feedback(fb, "export hangs")
    _file(fb, org, a)
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}")])
    assert _state(fb, org, a)["state"] == "filed"

    batch, _ = _commit(fb, org, [_item(org, f"feedback:{a}", state="done", by="person:op")])
    resolved = _state(fb, org, a)
    assert {k: resolved[k] for k in ("state", "agenda", "reason", "by")} == {
        "state": "resolved", "agenda": AID, "reason": None, "by": "person:op"}
    assert resolved["at"].endswith("Z")

    # the same batch again: its first answer, nothing applied
    res = fb.post(f"/api/workspace/{org.pid}/commit", headers={**_h(org.ws), **_ENGINE},
                  json=batch)
    assert res.status_code == 200, res.text
    assert _state(fb, org, a) == resolved
    # a later batch rewriting the done item (a body edit): still done, nothing moves
    _commit(fb, org, [_item(org, f"feedback:{a}", state="done", by="person:else", body="y")])
    assert _state(fb, org, a) == resolved


def test_a_reopened_feedback_stays_open_through_later_batches(fb):
    """Check 2: a member's Reopen sticks: the sync rule moves only Filed, so a body edit
    of the done item, or its reopen and done again, never resolves it; a new item naming
    it leaves its row alone too."""

    org = _Org(fb)
    a = org.feedback(fb)
    _file(fb, org, a)
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}", state="done")])
    assert _state(fb, org, a)["state"] == "resolved"
    assert _set(fb, org, [a], "open").status_code == 200
    assert _state(fb, org, a)["state"] == "open"

    _commit(fb, org, [_item(org, f"feedback:{a}", state="done", body="edited")])
    _commit(fb, org, [_item(org, f"feedback:{a}", state=None, body="edited")])
    _commit(fb, org, [_item(org, f"feedback:{a}", state="done", body="edited")])
    _commit(fb, org, [_item(org, f"feedback:{a}", name=ITEM2)])
    assert _state(fb, org, a)["state"] == "open"
    assert [f["id"] for f in _triage(fb, org.pid, org.ws).json()["feedback"]] == [a]


def test_a_dismissed_item_and_a_dropped_agenda_leave_the_feedback_filed(fb):
    """Check 3."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _file(fb, org, a)
    _file(fb, org, b, "A4-m2")
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}")])
    _commit(fb, org, [_item(org, f"feedback:{a}", state="dismissed")])
    assert _state(fb, org, a)["state"] == "filed"

    # an agenda auto-closed Dropped (its one item dismissed, in the same batch)
    _commit(fb, org, [_agenda(org, "A4-m2"), _item(org, f"feedback:{b}", aid="A4-m2")])
    _commit(fb, org, [_agenda(org, "A4-m2", status="dropped"),
                      _item(org, f"feedback:{b}", aid="A4-m2", state="dismissed")])
    assert _state(fb, org, b)["state"] == "filed"

    # an agenda dropped by hand with its item still open: only Solved closes the loop
    c = org.feedback(fb, "c")
    _file(fb, org, c, "A5-n4")
    _commit(fb, org, [_agenda(org, "A5-n4"), _item(org, f"feedback:{c}", aid="A5-n4")])
    _commit(fb, org, [_agenda(org, "A5-n4", status="dropped")])
    assert _state(fb, org, c)["state"] == "filed"


def test_an_agenda_solved_with_an_open_item_resolves_its_filed_feedback_once(fb):
    """Check 4: ``agenda.json`` turning ``solved`` resolves each non-dismissed item's Filed
    feedback, once; a dismissed item's stays Filed."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _file(fb, org, a)
    _file(fb, org, b)
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}"),
                      _item(org, f"feedback:{b}", name=ITEM2, state="dismissed")])
    _commit(fb, org, [_agenda(org, status="solved")])
    got = _state(fb, org, a)
    assert {k: got[k] for k in ("state", "agenda", "by")} == {
        "state": "resolved", "agenda": AID, "by": "agent:sikstack"}
    assert _state(fb, org, b)["state"] == "filed"

    # solved again (a note edit) never touches it; nor after a member reopens it
    _commit(fb, org, [_agenda(org, status="solved", note="later")])
    assert _state(fb, org, a) == got
    assert _set(fb, org, [a], "open").status_code == 200
    _commit(fb, org, [_agenda(org, status="solved", note="later still")])
    assert _state(fb, org, a)["state"] == "open"


def test_a_conflicting_batch_changes_no_feedback_state(fb):
    """Check 5: a 409 applies nothing, the feedback side included."""

    org = _Org(fb)
    a, c = org.feedback(fb, "a"), org.feedback(fb, "c")
    _file(fb, org, a)
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}")])
    stale = _agenda(org)
    stale["base_rev"] = 999  # not the record's revision: a conflict
    stale["content"] += " "
    stale["sha256"] = hashlib.sha256(stale["content"].encode("utf-8")).hexdigest()
    _commit(fb, org, [_item(org, f"feedback:{a}", state="done"),
                      _item(org, f"feedback:{c}", name=ITEM2), stale], expect=409)
    assert _state(fb, org, a)["state"] == "filed"
    assert _state(fb, org, c)["state"] == "open"


def test_an_item_naming_another_projects_or_a_bad_id_changes_nothing(fb):
    """Check 6: the sync rule is scoped to the workspace's own project; a malformed or
    unknown id is skipped, never raised on."""

    org = _Org(fb)
    stranger = _Org(fb)
    theirs = stranger.feedback(fb, "theirs")
    _file(fb, stranger, theirs)
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{theirs}"),
                      _item(org, "feedback:not-a-uuid", name=ITEM2)])
    _commit(fb, org, [_item(org, f"feedback:{theirs}", state="done"),
                      _item(org, "feedback:not-a-uuid", name=ITEM2, state="done"),
                      _item(org, f"feedback:{uuid4()}", name="20261124T010000.000003Z-cccc",
                            state="done")])
    _commit(fb, org, [_agenda(org, status="solved")])
    got = _state(fb, stranger, theirs)
    assert got["state"] == "filed" and got["by"] == "agent:sikstack"

    # a fresh feedback of another project named by a new item stays Open (no row)
    other = stranger.feedback(fb, "other")
    _commit(fb, org, [_item(org, f"feedback:{other}", name="20261124T010000.000004Z-dddd")])
    assert _state(fb, stranger, other)["state"] == "open"


def test_a_new_item_naming_a_feedback_with_no_row_files_it(fb):
    """The sync rule's first step: an item written by hand with a feedback source files a
    feedback that has no row; a done one in the same batch then resolves it."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}"),
                      _item(org, f"feedback:{b}", name=ITEM2, state="done")])
    got = _state(fb, org, a)
    assert {k: got[k] for k in ("state", "agenda", "by")} == {
        "state": "filed", "agenda": AID, "by": "agent:sikstack"}
    assert _state(fb, org, b)["state"] == "resolved"


# --- the engine's routes --------------------------------------------------------------


def test_the_engines_marks_store_the_one_state_and_the_queue_is_the_open_set(fb):
    """Check 8: both bodies still answer 200; ``dismissed`` reads Dropped on the session
    read; the queue leaves out Filed, Resolved and Dropped and holds a reopened one; the
    engine's GET keeps its words."""

    org = _Org(fb)
    a, b, c, d = (org.feedback(fb, m) for m in ("a", "b", "c", "d"))
    _file(fb, org, a)
    res = _mark(fb, org.pid, org.ws, b, state="dismissed", reason="dupe", by="person:op")
    assert res.status_code == 200, res.text
    assert res.json()["triage"]["state"] == "dismissed"
    got = _state(fb, org, b)
    assert {k: got[k] for k in ("state", "reason", "by")} == {
        "state": "dropped", "reason": "dupe", "by": "person:op"}
    assert _state(fb, org, a)["state"] == "filed"
    assert _set(fb, org, [c], "resolved").status_code == 200
    assert [f["id"] for f in _triage(fb, org.pid, org.ws).json()["feedback"]] == [d]

    assert _set(fb, org, [b], "open").status_code == 200
    assert [f["id"] for f in _triage(fb, org.pid, org.ws).json()["feedback"]] == [d, b]

    def word(fid: str) -> str:
        res = fb.get(f"/api/feedback/{org.pid}/triage/{fid}", headers=_h(org.ws))
        return res.json()["feedback"]["triage"]["state"]

    assert _mark(fb, org.pid, org.ws, d, state="dismissed", by="person:op").status_code == 200
    assert [word(x) for x in (a, b, c, d)] == ["filed", "untriaged", "resolved", "dismissed"]


# --- the session list -----------------------------------------------------------------


def test_the_list_reads_open_by_default_and_its_counts_match_each_filter(fb):
    """Check 9: no ``state`` is Open; ``counts`` hold what each state filter returns,
    across ``q``, ``project_id`` and rating filters."""

    org = _Org(fb)
    ids = {
        "o1": org.feedback(fb, "export one", feedback_value=1),
        "o2": org.feedback(fb, "search two", feedback_value=2),
        "f1": org.feedback(fb, "export three", feedback_value=2),
        "r1": org.feedback(fb, "export four", feedback_value=1),
        "d1": org.feedback(fb, "search five", feedback_value=2),
    }
    _file(fb, org, ids["f1"])
    assert _set(fb, org, [ids["r1"]], "resolved").status_code == 200
    assert _set(fb, org, [ids["d1"]], "dropped", reason="noise").status_code == 200

    session = org.owner["session"]
    plain = fb.get("/app/feedback", headers=session).json()
    assert [r["id"] for r in plain["records"]] == [ids["o2"], ids["o1"]]
    assert plain["total"] == 2
    assert plain["counts"] == {"open": 2, "filed": 1, "resolved": 1, "dropped": 1}
    assert plain["records"][0]["state"] == {"state": "open", "agenda": None, "reason": None,
                                            "by": None, "at": None}
    everything = fb.get("/app/feedback?state=all", headers=session).json()
    assert everything["total"] == 5 and everything["counts"] == plain["counts"]
    dropped = fb.get("/app/feedback?state=dropped", headers=session).json()
    assert dropped["records"][0]["state"]["reason"] == "noise"
    assert dropped["records"][0]["state"]["by"].startswith("person:")

    for filters in ("", "q=export", f"project_id={org.pid}", "feedback_value=2",
                    "q=search&feedback_value=2"):
        counts = fb.get(f"/app/feedback?{filters}", headers=session).json()["counts"]
        for state in ("open", "filed", "resolved", "dropped"):
            got = fb.get(f"/app/feedback?{filters}&state={state}", headers=session).json()
            assert got["total"] == counts[state] == len(got["records"]), (filters, state)
            assert all(r["state"]["state"] == state for r in got["records"])
    assert fb.get("/app/feedback?state=closed", headers=session).status_code == 400


# --- the state route ------------------------------------------------------------------


def test_the_state_route_sets_one_or_several_all_or_none(fb):
    """Check 10."""

    org = _Org(fb)
    a, b, c = (org.feedback(fb, m) for m in ("a", "b", "c"))
    _file(fb, org, a)
    email = org.owner["user"]["email"]

    res = _set(fb, org, [a], "resolved")
    assert res.status_code == 200, res.text
    [one] = res.json()["states"]
    assert one["id"] == a and one["state"]["state"] == "resolved"
    assert one["state"]["agenda"] == AID and one["state"]["by"] == f"person:{email}"
    at = one["state"]["at"]

    # the same state again is a no-op: who and when stay
    again = _set(fb, org, [a], "resolved").json()["states"][0]["state"]
    assert again["at"] == at and again["by"] == f"person:{email}"

    res = _set(fb, org, [b, c], "dropped", reason="  out of scope  ")
    assert res.status_code == 200, res.text
    assert [s["id"] for s in res.json()["states"]] == [b, c]
    for fid in (b, c):
        got = _state(fb, org, fid)
        assert (got["state"], got["reason"], got["agenda"]) == ("dropped", "out of scope", None)

    res = _set(fb, org, [a, b], "open")
    assert res.status_code == 200, res.text
    assert _state(fb, org, a) == {**_state(fb, org, a), "state": "open", "agenda": None,
                                  "reason": None}
    assert _state(fb, org, b)["reason"] is None

    # one id outside the org refuses the whole call; nothing changed
    stranger = _Org(fb)
    theirs = stranger.feedback(fb, "theirs")
    res = _set(fb, org, [c, theirs], "resolved")
    assert res.status_code == 404 and res.json() == {"detail": "feedback not found"}
    assert _state(fb, org, c)["state"] == "dropped"
    assert _state(fb, stranger, theirs)["state"] == "open"
    assert _set(fb, org, [c, str(uuid4())], "resolved").status_code == 404
    assert _state(fb, org, c)["state"] == "dropped"

    # bad bodies are 422s
    for body in ({"ids": [a], "state": "filed"}, {"ids": [a], "state": "dismissed"},
                 {"ids": [a]}, {"ids": [], "state": "open"}, {"ids": "a", "state": "open"},
                 {"ids": ["nope"], "state": "open"},
                 {"ids": [a], "state": "resolved", "reason": "x"},
                 {"ids": [a], "state": "dropped", "reason": "two\nlines"},
                 {"ids": [a], "state": "dropped", "reason": "x" * 501},
                 {"ids": [a], "state": "open", "note": "x"},
                 {"ids": [str(uuid4()) for _ in range(101)], "state": "open"}):
        res = fb.post("/app/feedback/state", json=body, headers=org.owner["session"])
        assert res.status_code == 422, (body, res.text)
        assert isinstance(res.json()["detail"], str)
    assert _state(fb, org, a)["state"] == "open"

    # not a member: a stranger's session sees none of it, and naming the org is a 403
    res = fb.post("/app/feedback/state", json={"ids": [c], "state": "open"},
                  headers=stranger.owner["session"])
    assert res.status_code == 404
    res = fb.post("/app/feedback/state", json={"ids": [c], "state": "open"},
                  headers={**stranger.owner["session"],
                           "X-Sikstack-Org": org.owner["tenant"]["id"]})
    assert res.status_code == 403
    assert fb.post("/app/feedback/state", json={"ids": [c], "state": "open"}).status_code == 401
    assert _state(fb, org, c)["state"] == "dropped"


def test_a_member_who_is_not_the_owner_sets_states(fb):
    """Any org member's act, not only the owner's."""

    org = _Org(fb)
    a = org.feedback(fb, "a")
    member = _signup(fb)
    url = make_url(_RAW_DSN).set(drivername="postgresql+psycopg")
    engine = create_engine(url.render_as_string(hide_password=False))
    try:
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO tenant_members (id, tenant_id, user_id, role) "
                              "VALUES (:id, :t, :u, 'member')"),
                         {"id": uuid4(), "t": org.owner["tenant"]["id"],
                          "u": member["user"]["id"]})
    finally:
        engine.dispose()
    headers = {**member["session"], "X-Sikstack-Org": org.owner["tenant"]["id"]}
    res = fb.post("/app/feedback/state", json={"ids": [a], "state": "dropped"}, headers=headers)
    assert res.status_code == 200, res.text
    assert _state(fb, org, a)["by"] == f"person:{member['user']['email']}"


# --- the web filing -------------------------------------------------------------------


def test_the_web_filing_reads_filed_at_once(fb):
    """Check 11: on an existing item and on a new one."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org)])
    res = fb.post(f"/app/feedback/{a}/agenda", json={"item": AID}, headers=org.owner["session"])
    assert res.status_code == 201, res.text
    got = _state(fb, org, a)
    assert (got["state"], got["agenda"]) == ("filed", AID)
    assert got["by"] == f"person:{org.owner['user']['email']}"

    res = fb.post(f"/app/feedback/{b}/agenda", json={}, headers=org.owner["session"])
    assert res.status_code == 201, res.text
    got = _state(fb, org, b)
    assert (got["state"], got["agenda"]) == ("filed", res.json()["item"])
    assert [f["id"] for f in _triage(fb, org.pid, org.ws).json()["feedback"]] == []


# --- Filed follows the entry that filed it ---------------------------------------------


A8 = "A8-p3"


def _queue(client: TestClient, org: _Org) -> list[str]:
    return [f["id"] for f in _triage(client, org.pid, org.ws).json()["feedback"]]


def _web_file(client: TestClient, org: _Org, fid: str, item: str | None = None) -> dict:
    res = client.post(f"/app/feedback/{fid}/agenda", json={} if item is None else {"item": item},
                      headers=org.owner["session"])
    assert res.status_code == 201, res.text
    return res.json()


def _discard(client: TestClient, org: _Org, entry: str) -> None:
    res = client.post(f"/app/projects/{org.pid}/workspace/inbox/{entry}/discard",
                      headers=org.owner["session"])
    assert res.status_code == 200, res.text


def _results(client: TestClient, org: _Org, results: list[dict], ops: list | None = None):
    batch = {"batch_id": str(uuid4()), "command": ["sync"], "origin": "command",
             "ops": ops or [], "events": [], "derived": [], "inbox": results}
    res = client.post(f"/api/workspace/{org.pid}/commit", headers={**_h(org.ws), **_ENGINE},
                      json=batch)
    assert res.status_code == 200, res.text
    org.revs.update(res.json()["revs"])


def _delete(org: _Org, path: str) -> dict:
    return {"op": "delete", "path": path, "base_rev": org.revs[path]}


def _entry_path(aid: str = AID, name: str = ITEM) -> str:
    return f"works/agenda/{aid}/entries/{name}.json"


def _open(client: TestClient, org: _Org, fid: str) -> None:
    got = _state(client, org, fid)
    assert (got["state"], got["agenda"]) == ("open", None), got
    assert fid in _queue(client, org)
    res = client.get(f"/api/feedback/{org.pid}/triage/{fid}", headers=_h(org.ws))
    assert res.json()["feedback"]["triage"]["state"] == "untriaged"


def test_a_web_filing_onto_a_new_agenda_whose_pending_agenda_is_discarded_reads_open(fb):
    """Case (a): discarding the pending agenda (its add), or the filing's own entry,
    returns the feedback to Open and to the engine's queue."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org)])
    added = _web_file(fb, org, a)
    assert _state(fb, org, a)["state"] == "filed" and a not in _queue(fb, org)
    add, _entry = (e["id"] for e in added["entries"])
    _discard(fb, org, add)
    _open(fb, org, a)

    entry = _web_file(fb, org, b)["entries"][1]["id"]
    _discard(fb, org, entry)
    _open(fb, org, b)


def test_a_landed_item_deleted_later_returns_its_feedback_to_open(fb):
    """Case (b): a later batch deletes the entry file that filed it (by the sync rule,
    by the engine's mark, or by the web filing that landed)."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org), _item(org, f"feedback:{a}")])
    _file(fb, org, b)
    _commit(fb, org, [_item(org, f"feedback:{b}", name=ITEM2)])
    assert _state(fb, org, a)["state"] == _state(fb, org, b)["state"] == "filed"
    _commit(fb, org, [_delete(org, _entry_path()), _delete(org, _entry_path(name=ITEM2))])
    _open(fb, org, a)
    _open(fb, org, b)

    # a new item naming it later files it again (no row: the sync rule's first step)
    _commit(fb, org, [_item(org, f"feedback:{a}", name="20261124T010000.000003Z-cccc")])
    assert _state(fb, org, a)["state"] == "filed"


def test_a_moved_item_carries_its_feedbacks_agenda(fb):
    """Case (c): a move op, and a split written as a delete and a put in one batch: the
    stored agenda is the new one, as the panel and the engine's ``agendas`` say."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org), _agenda(org, A8), _item(org, f"feedback:{a}"),
                      _item(org, f"feedback:{b}", name=ITEM2)])
    src = _entry_path()
    _commit(fb, org, [{"op": "move", "from": src, "to": _entry_path(A8),
                       "base_rev": org.revs[src]}])
    _commit(fb, org, [_delete(org, _entry_path(name=ITEM2)),
                      _item(org, f"feedback:{b}", aid=A8, name=ITEM2)])
    for fid in (a, b):
        got = _state(fb, org, fid)
        assert (got["state"], got["agenda"]) == ("filed", A8), got
        panel = fb.get(f"/app/feedback/{fid}/agenda", headers=org.owner["session"]).json()
        assert [i["id"] for i in panel["items"]] == [A8]
        res = fb.get(f"/api/feedback/{org.pid}/triage/{fid}", headers=_h(org.ws))
        assert res.json()["feedback"]["triage"]["agendas"] == [A8]
        assert res.json()["feedback"]["triage"]["agenda"] == A8
    # then done on its new agenda: resolved there
    _commit(fb, org, [_item(org, f"feedback:{a}", aid=A8, state="done")])
    assert (_state(fb, org, a)["state"], _state(fb, org, a)["agenda"]) == ("resolved", A8)


def test_a_pending_web_filing_onto_an_existing_item_discarded_reads_open(fb):
    """Case (d)."""

    org = _Org(fb)
    a = org.feedback(fb, "a")
    _commit(fb, org, [_agenda(org)])
    entry = _web_file(fb, org, a, AID)["entries"][0]["id"]
    _discard(fb, org, entry)
    _open(fb, org, a)


def test_a_pending_filing_the_engine_refuses_reads_open_until_tried_again(fb):
    """Case (e): the engine's ``refused`` result, for the filing's entry or for the add
    of its new agenda, returns the feedback to Open; Try again files it again."""

    org = _Org(fb)
    a, b = org.feedback(fb, "a"), org.feedback(fb, "b")
    _commit(fb, org, [_agenda(org)])
    entry = _web_file(fb, org, a, AID)["entries"][0]["id"]
    _results(fb, org, [{"id": entry, "state": "refused", "reason": "no", "exit": 1}])
    _open(fb, org, a)

    add = _web_file(fb, org, b)["entries"][0]["id"]
    _results(fb, org, [{"id": add, "state": "refused", "reason": "no", "exit": 1}])
    _open(fb, org, b)

    res = fb.post(f"/app/projects/{org.pid}/workspace/inbox/{entry}/retry",
                  headers=org.owner["session"])
    assert res.status_code == 201, res.text
    got = _state(fb, org, a)
    assert (got["state"], got["agenda"]) == ("filed", AID)
    assert a not in _queue(fb, org)


def test_an_agenda_deleted_with_its_entries_returns_its_only_feedback_to_open(fb):
    """Case (f), and the must-stay: a feedback another live or pending entry still names
    stays Filed, on that entry's agenda."""

    org = _Org(fb)
    a, b, c = org.feedback(fb, "a"), org.feedback(fb, "b"), org.feedback(fb, "c")
    third = "20261124T010000.000003Z-cccc"
    _commit(fb, org, [_agenda(org), _agenda(org, A8), _item(org, f"feedback:{a}"),
                      _item(org, f"feedback:{b}", name=ITEM2),
                      _item(org, f"feedback:{b}", aid=A8, name=ITEM2),
                      _item(org, f"feedback:{c}", name=third)])
    _commit(fb, org, [_agenda(org, "A9-z9")])
    _web_file(fb, org, c, "A9-z9")  # pending: a filing that has not landed
    _file(fb, org, c)  # the engine's mark, on the agenda about to go
    assert [_state(fb, org, x)["agenda"] for x in (a, b, c)] == [AID, AID, AID]

    agenda = f"works/agenda/{AID}/agenda.json"
    _commit(fb, org, [_delete(org, agenda), _delete(org, _entry_path()),
                      _delete(org, _entry_path(name=ITEM2)),
                      _delete(org, _entry_path(name=third))])
    _open(fb, org, a)
    assert [(_state(fb, org, x)["state"], _state(fb, org, x)["agenda"]) for x in (b, c)] == [
        ("filed", A8), ("filed", "A9-z9")]
    assert _queue(fb, org) == [a]


def test_a_manual_state_never_follows_an_entry(fb):
    """Must stay: Resolved, Dropped and Open (a Reopen) are never changed by a withdrawn
    or moved entry, a discarded filing or a refused one."""

    org = _Org(fb)
    r, d, o, w = (org.feedback(fb, m) for m in ("r", "d", "o", "w"))
    third, fourth = "20261124T010000.000003Z-cccc", "20261124T010000.000004Z-dddd"
    _commit(fb, org, [_agenda(org), _agenda(org, A8), _item(org, f"feedback:{r}"),
                      _item(org, f"feedback:{d}", name=ITEM2),
                      _item(org, f"feedback:{o}", name=third)])
    entry = _web_file(fb, org, w, AID)["entries"][0]["id"]
    assert _set(fb, org, [r], "resolved").status_code == 200
    assert _set(fb, org, [d], "dropped", reason="noise").status_code == 200
    assert _set(fb, org, [o, w], "open").status_code == 200
    before = {x: _state(fb, org, x) for x in (r, d, o, w)}

    src = _entry_path(name=third)
    _commit(fb, org, [{"op": "move", "from": src, "to": _entry_path(A8, third),
                       "base_rev": org.revs[src]}])
    _commit(fb, org, [_delete(org, _entry_path()), _delete(org, _entry_path(name=ITEM2))])
    _results(fb, org, [{"id": entry, "state": "refused", "reason": "no", "exit": 1}])
    _discard(fb, org, entry)
    assert {x: _state(fb, org, x) for x in (r, d, o, w)} == before
    _commit(fb, org, [_item(org, f"feedback:{o}", name=fourth)])
    assert _state(fb, org, o) == before[o]


# --- the migration --------------------------------------------------------------------


def test_the_states_migration_keeps_marks_and_backfills_filed(monkeypatch):
    """Check 7: ``0020`` keeps ``filed``, turns ``dismissed`` into ``dropped`` and files a
    feedback that only an item of its own project names (stored, or pending in the
    inbox); it resolves nothing. Downgrade, then upgrade again."""

    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL to a disposable Postgres to run the migration test")
    from pathlib import Path

    from alembic.config import Config

    from alembic import command

    ini = Path(__file__).resolve().parents[1] / "alembic.ini"
    base = make_url(_RAW_DSN).set(drivername="postgresql+psycopg")
    name = f"kb_states_{uuid4().hex[:10]}"
    admin = create_engine(base.render_as_string(hide_password=False), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{name}"'))
    except Exception as exc:  # pragma: no cover - environment dependent
        admin.dispose()
        pytest.skip(f"cannot create a scratch database: {exc}")
    url = base.set(database=name).render_as_string(hide_password=False)
    monkeypatch.setenv("DATABASE_URL", url)
    cfg = Config(str(ini))
    engine = create_engine(url)

    tenant, project, other = uuid4(), uuid4(), uuid4()
    ev = {k: uuid4() for k in ("filed", "dismissed", "stored", "pending", "plain", "foreign",
                               "done", "bad")}

    def blob(data: dict | str) -> tuple[str, bytes]:
        raw = (data if isinstance(data, str) else json.dumps(data)).encode("utf-8")
        return hashlib.sha256(raw).hexdigest(), raw

    try:
        command.upgrade(cfg, "0019_item_shares")
        with engine.begin() as conn:
            conn.execute(text("INSERT INTO tenants (id, name) VALUES (:t, 'T')"), {"t": tenant})
            conn.execute(text("INSERT INTO projects (id, tenant_id, name) VALUES "
                              "(:p, :t, 'one'), (:o, :t, 'two')"),
                         {"p": project, "o": other, "t": tenant})
            for key, fid in ev.items():
                conn.execute(text("INSERT INTO feedback_events (id, project_id, message, "
                                  "source_product) VALUES (:id, :p, :m, 'app')"),
                             {"id": fid, "p": other if key == "foreign" else project, "m": key})
            conn.execute(text("INSERT INTO feedback_triage (feedback_id, state, agenda, reason, "
                              "triaged_by) VALUES (:f, 'filed', 'A1-x2', NULL, 'agent:e'), "
                              "(:d, 'dismissed', NULL, 'dupe', 'person:op')"),
                         {"f": ev["filed"], "d": ev["dismissed"]})
            files = {
                f"works/agenda/A5-q2/entries/{ITEM}.json":
                    {"source": f"feedback:{ev['stored']}", "body": "x"},
                f"works/agenda/A5-q2/entries/{ITEM2}.json":
                    {"source": f"feedback:{ev['filed']}", "body": "x"},
                "works/agenda/A6-r3/entries/20261124T010000.000003Z-cccc.json":
                    {"source": f"feedback:{ev['foreign']}", "body": "x"},
                "works/agenda/A6-r3/entries/20261124T010000.000004Z-dddd.json":
                    {"source": f"feedback:{ev['done']}", "body": "x", "state": "done"},
                "works/agenda/A6-r3/entries/20261124T010000.000005Z-eeee.json": "{not json",
                "works/agenda/A6-r3/agenda.json":
                    {"id": "A6-r3", "source": f"feedback:{ev['bad']}"},
            }
            for path, data in files.items():
                sha, raw = blob(data)
                conn.execute(text("INSERT INTO workspace_blobs (project_id, sha256, size, content) "
                                  "VALUES (:p, :s, :n, :c) ON CONFLICT DO NOTHING"),
                             {"p": project, "s": sha, "n": len(raw), "c": raw})
                conn.execute(text("INSERT INTO workspace_files (project_id, path, rev, sha256, "
                                  "size, kind, deleted, blob_sha256) VALUES "
                                  "(:p, :path, 1, :s, :n, 'file', false, :s)"),
                             {"p": project, "path": path, "s": sha, "n": len(raw)})
            for state, fid in (("pending", ev["pending"]), ("applied", ev["plain"])):
                conn.execute(text("INSERT INTO workspace_inbox (id, project_id, kind, items, "
                                  "fields, state) VALUES (:id, :p, 'entry', CAST(:items AS jsonb), "
                                  "CAST(:fields AS jsonb), :state)"),
                             {"id": uuid4(), "p": project, "items": json.dumps(["A7-s4"]), "state": state,
                              "fields": json.dumps({"source": f"feedback:{fid}", "body": "x"})})

        rows = text("SELECT feedback_id, state, agenda, reason, triaged_by FROM feedback_triage")

        def read() -> dict[UUID, tuple]:
            with engine.connect() as conn:
                return {r[0]: tuple(r[1:]) for r in conn.execute(rows)}

        command.upgrade(cfg, "head")
        got = read()
        assert got == {
            ev["filed"]: ("filed", "A1-x2", None, "agent:e"),
            ev["dismissed"]: ("dropped", None, "dupe", "person:op"),
            ev["stored"]: ("filed", "A5-q2", None, "agent:sikstack"),
            ev["done"]: ("filed", "A6-r3", None, "agent:sikstack"),
            ev["pending"]: ("filed", "A7-s4", None, "agent:sikstack"),
        }

        with engine.begin() as conn:
            conn.execute(text("UPDATE feedback_triage SET state = 'resolved' WHERE feedback_id = :d"),
                         {"d": ev["done"]})
            conn.execute(text("INSERT INTO feedback_triage (feedback_id, state, triaged_by) "
                              "VALUES (:p, 'open', 'person:op')"), {"p": ev["plain"]})
        command.downgrade(cfg, "0019_item_shares")
        down = read()
        assert down[ev["dismissed"]][0] == "dismissed"
        assert down[ev["done"]][0] == "filed" and ev["plain"] not in down
        assert {state for state, *_ in down.values()} == {"filed", "dismissed"}

        command.upgrade(cfg, "head")
        again = read()
        assert again[ev["dismissed"]][0] == "dropped"
        assert again[ev["done"]][0] == "filed" and ev["plain"] not in again
        assert set(again) == set(got)
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
