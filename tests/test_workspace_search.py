"""The workspace search route: Postgres-gated.

``POST /api/workspace/{project_id}/search`` scans the head's live text records for a
case-insensitive substring and answers path, line and snippet, by path then line,
capped by ``limit``. Binary, deleted and out-of-prefix records never match, and only
the project's own workspace key reaches the route.
"""

from __future__ import annotations

import base64

from tests.test_workspace_store import (  # noqa: F401 - the fixture
    _commit,
    _linked,
    _ok,
    _put,
    _sha,
    store,
)


def _search(client, project_id, key, **body):
    return client.post(f"/api/workspace/{project_id}/search", json=body, headers=key)


def test_a_hit_carries_path_line_and_snippet_and_ignores_case(store):
    client, _url, _engine = store
    project_id, _tid, key = _linked(client)
    long_line = "x" * 400 + " The Cold Set lands here " + "y" * 400
    _ok(_commit(client, project_id, key, [
        _put("works/phases/archived/P1/phase.md", "# P1\n\n  cold set first  \nnothing\n", None),
        _put("works/phases/archived/P2/phase.md", f"intro\n{long_line}\n", None),
        _put("docs/current/product.md", "COLD SET in the docs\n", None),
        {"op": "append", "path": "works/events.jsonl", "lines": ['{"e": "x"}', '{"e": "cold set"}']},
    ]))

    answer = _ok(_search(client, project_id, key, query="  Cold Set "))
    assert answer["head"] == 1 and answer["truncated"] is False
    assert [(h["path"], h["line"]) for h in answer["hits"]] == [
        ("docs/current/product.md", 1),
        ("works/events.jsonl", 2),
        ("works/phases/archived/P1/phase.md", 3),
        ("works/phases/archived/P2/phase.md", 2),
    ]
    snippets = {h["path"]: h["snippet"] for h in answer["hits"]}
    assert snippets["works/phases/archived/P1/phase.md"] == "cold set first"
    assert snippets["works/events.jsonl"] == '{"e": "cold set"}'
    cut = snippets["works/phases/archived/P2/phase.md"]
    assert len(cut) == 240 and "The Cold Set lands here" in cut

    assert _ok(_search(client, project_id, key, query="no such words"))["hits"] == []
    for short in ("a", " b ", "", None, 7, "x" * 201):
        assert _search(client, project_id, key, query=short).status_code == 422, short


def test_binary_deleted_and_out_of_prefix_records_never_match(store):
    client, _url, _engine = store
    project_id, _tid, key = _linked(client)
    nul = b"needle\x00needle"
    latin = "needle caf\xe9".encode("latin-1")
    _ok(_commit(client, project_id, key, [
        {"op": "put", "path": "works/bin/nul.dat", "base_rev": None, "sha256": _sha(nul),
         "content": base64.b64encode(nul).decode(), "encoding": "base64"},
        {"op": "put", "path": "works/bin/latin.txt", "base_rev": None, "sha256": _sha(latin),
         "content": base64.b64encode(latin).decode(), "encoding": "base64"},
        _put("works/gone.md", "needle", None),
        _put("works/phases/archived/P1/a.md", "needle in the archive", None),
        _put("works/phases/active/P2/a.md", "needle in the active", None),
    ]))
    _ok(_commit(client, project_id, key, [{"op": "delete", "path": "works/gone.md", "base_rev": 1}]))

    whole = _ok(_search(client, project_id, key, query="needle"))
    assert [h["path"] for h in whole["hits"]] == [
        "works/phases/active/P2/a.md", "works/phases/archived/P1/a.md"]
    scoped = _ok(_search(client, project_id, key, query="needle",
                         prefix="works/phases/archived/"))
    assert [h["path"] for h in scoped["hits"]] == ["works/phases/archived/P1/a.md"]
    for bad in ("/works", "works/../x", "works//x"):
        assert _search(client, project_id, key, query="needle", prefix=bad).status_code == 400


def test_the_limit_cuts_the_hits_and_is_held_to_200(store):
    client, _url, _engine = store
    project_id, _tid, key = _linked(client)
    body = "".join(f"match {n}\n" for n in range(250))
    _ok(_commit(client, project_id, key, [
        _put("works/a.md", body, None), _put("works/b.md", "match b\n", None)]))

    three = _ok(_search(client, project_id, key, query="match", limit=3))
    assert [(h["path"], h["line"]) for h in three["hits"]] == [
        ("works/a.md", 1), ("works/a.md", 2), ("works/a.md", 3)]
    assert three["truncated"] is True
    assert len(_ok(_search(client, project_id, key, query="match"))["hits"]) == 50
    clamped = _ok(_search(client, project_id, key, query="match", limit=1000))
    assert len(clamped["hits"]) == 200 and clamped["truncated"] is True
    exact = _ok(_search(client, project_id, key, query="match b", limit=1))
    assert len(exact["hits"]) == 1 and exact["truncated"] is False
    for bad in (0, -1, "5", True):
        assert _search(client, project_id, key, query="match", limit=bad).status_code == 422


def test_search_takes_the_projects_own_key_only(store):
    client, _url, _engine = store
    project_a, _ta, key_a = _linked(client)
    _project_b, _tb, key_b = _linked(client)
    _ok(_commit(client, project_a, key_a, [_put("works/a.md", "secret words", None)]))

    other = _search(client, project_a, key_b, query="secret")
    assert other.status_code == 404 and "secret words" not in other.text
    assert _search(client, "not-a-uuid", key_b, query="secret").status_code == 404
    assert client.post(f"/api/workspace/{project_a}/search",
                       json={"query": "secret"}).status_code == 401
    wrong = {**key_a, "Authorization": "Bearer sk_not_a_real_key"}
    assert _search(client, project_a, wrong, query="secret").status_code == 401
    no_checkout = {k: v for k, v in key_a.items() if k != "X-Sikstack-Checkout"}
    assert _search(client, project_a, no_checkout, query="secret").status_code == 400
    assert _ok(_search(client, project_a, key_a, query="SECRET"))["hits"][0]["path"] == "works/a.md"
