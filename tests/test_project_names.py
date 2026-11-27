"""One project-name rule on every write path, and the names tenant #1 may not take
(``server/project_names.py``) — Postgres-gated.

Proved here:

* a 201-character project name gets the same words (``PROJECT_NAME_LENGTH_ERROR``) on
  every path that writes one: ``POST /app/projects``, ``POST /api/documents`` and its
  dry run, ``PUT /api/books``, a Feedback capture, an install's sign-in (its repo is
  its project's name), Listen and reader state; a 200-character name passes the rule;
* an install Connect's ``-N`` suffix never takes a name past 200;
* tenant #1 cannot make a project named ``assets``, ``javascripts`` or
  ``stylesheets`` (any case) on any path that creates one; another org can;
* a new account's org holds no project, and the paths that make ``default`` on first
  write (a capture with no project, ``POST /app/projects``) still do.

Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from server import project_names
from tests.test_deletion import Account, _account, _join, _tenant_one, kb  # noqa: F401

LONG = "p" * 201
EDGE = "p" * 200
ERR = project_names.PROJECT_NAME_LENGTH_ERROR
RESERVED = project_names.PROJECT_NAME_RESERVED_ERROR


def _doc(project: str, slug: str = "note") -> dict:
    return {
        "title": "Note",
        "markdown": "# Note\n\nBody.\n",
        "project": project,
        "tags": ["testing", "names"],
        "source_repo": "names",
        "slug": slug,
    }


def _says(res, words: str) -> bool:
    return words in res.text


def _key(client, who: Account, scope: str = "full") -> dict:
    res = client.post("/app/credentials", json={"scope": scope}, headers=who.h)
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['key']}"}


def _capture(client, headers: dict, project: str | None):
    body = {"message": "hello", "source": {"product": "app-x"}, "user_id": "u-1"}
    if project is not None:
        body["project"] = project
    return client.post("/api/feedback", json=body, headers=headers)


def _names(client, who: Account) -> list[str]:
    return [p["name"] for p in client.get("/app/projects", headers=who.h).json()["projects"]]


def _listen(client, who: Account, project: str):
    return client.post(
        "/app/listen/start", headers=who.h, json={"org": who.tenant, "project": project, "doc": "x"}
    )


def _position(client, who: Account, project: str):
    return client.put(
        "/app/reader/positions",
        headers=who.h,
        json={"org": who.tenant, "project": project, "doc": "x", "fraction": 0.5},
    )


# --- C5: one length rule ---------------------------------------------------------------


def test_a_201_character_name_gets_the_same_refusal_on_every_path(kb, monkeypatch):
    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "0")
    who = _account(kb)
    full = _key(kb, who)
    book = {"title": "Guide", "kind": "codebase", "chapters": []}
    refusals = {
        "app/projects": kb.post("/app/projects", json={"name": LONG}, headers=who.h),
        "app/projects trimmed": kb.post(
            "/app/projects", json={"name": f"  {LONG}  "}, headers=who.h
        ),
        "api/documents": kb.post("/api/documents", json=_doc(LONG), headers=full),
        "api/documents/check": kb.post("/api/documents/check", json=_doc(LONG), headers=full),
        "api/books": kb.put(f"/api/books/{LONG}/guide", json=book, headers=full),
        "feedback": _capture(kb, full, LONG),
        "install sign-in": kb.post(
            "/api/installs/sign-in",
            json={"install_id": "x" * 20, "repo": LONG, "plugin_version": "1.0.0"},
        ),
        "listen": _listen(kb, who, LONG),
        "reader": _position(kb, who, LONG),
    }
    for path, res in refusals.items():
        assert res.status_code in (400, 422) and _says(res, ERR), (path, res.status_code, res.text)
    assert _names(kb, who) == []


def test_a_200_character_name_passes_the_rule_on_every_path(kb, monkeypatch):
    who = _account(kb)
    full = _key(kb, who)
    made = kb.post("/app/projects", json={"name": f" {EDGE} "}, headers=who.h)
    assert made.status_code == 201 and made.json()["project"]["name"] == EDGE, made.text
    checked = kb.post("/api/documents/check", json=_doc(EDGE), headers=full)
    assert checked.status_code == 200, checked.text
    published = kb.post("/api/documents", json=_doc(EDGE), headers=full)
    assert published.status_code == 201, published.text
    rel = published.json()["rel_path"]
    book = {"title": "Guide", "kind": "codebase",
            "chapters": [{"key": "one", "position": 1, "variants": {"en": rel}}]}
    put = kb.put(f"/api/books/{EDGE}/guide", json=book, headers=full)
    assert put.status_code in (200, 201), put.text
    assert _capture(kb, full, EDGE).status_code == 202
    # Listen and reader state reach their own lookup (no such document), past the rule.
    for res in (_listen(kb, who, EDGE), _position(kb, who, EDGE)):
        assert not _says(res, ERR), res.text
        assert res.status_code == 404, res.text
    assert _names(kb, who) == [EDGE]


# --- C6: the Connect's suffix ----------------------------------------------------------


def _connect(kb, who: Account, repo: str) -> dict:
    reg = {"install_id": f"inst-{len(_names(kb, who))}-{who.tenant}", "email": who.email,
           "plugin_version": "1.0.0"}
    assert kb.post("/api/installs", json=reg).status_code == 200
    started = kb.post("/api/installs/sign-in",
                      json={"install_id": reg["install_id"], "repo": repo, "plugin_version": "1.0.0"})
    assert started.status_code == 200, started.text
    code = started.json()["code"]
    ready = kb.get(f"/app/connect/{code}", headers=who.h).json()
    res = kb.post(f"/app/connect/{code}/approve", json={}, headers=who.h)
    assert res.status_code == 200, res.text
    name = res.json()["project"]["name"]
    assert ready["project"] == {"name": name}
    return res.json()["project"]


def test_the_connect_suffix_never_takes_a_name_past_200(kb, monkeypatch):
    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "0")
    who = _account(kb)
    names = [_connect(kb, who, EDGE)["name"] for _ in range(11)]
    assert names[0] == EDGE
    assert names[1] == f"{EDGE[:198]}-2" and names[10] == f"{EDGE[:197]}-11"
    assert all(len(n) <= 200 for n in names) and len(set(names)) == 11


# --- C7: tenant #1's reserved names ------------------------------------------------------


def test_tenant_one_cannot_make_a_tracked_folders_project_on_any_path(kb, monkeypatch):
    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "0")
    owner = _tenant_one(kb, monkeypatch)
    full = _key(kb, owner)
    tracked = kb.root / "docs" / "assets" / "site.css"
    tracked.parent.mkdir(parents=True)
    tracked.write_text("body{}")
    for name in ("assets", "Javascripts", "STYLESHEETS"):
        made = kb.post("/app/projects", json={"name": name}, headers=owner.h)
        assert made.status_code == 422 and _says(made, RESERVED), (name, made.text)
        for path in ("/api/documents", "/api/documents/check"):
            res = kb.post(path, json=_doc(name), headers=full)
            assert res.status_code == 422 and _says(res, RESERVED), (name, path, res.text)
        put = kb.put(f"/api/books/{name}/guide", headers=full,
                     json={"title": "Guide", "kind": "codebase", "chapters": []})
        assert put.status_code == 422 and _says(put, RESERVED), (name, put.text)
        captured = _capture(kb, full, name)
        assert captured.status_code == 400 and _says(captured, RESERVED), (name, captured.text)
    # A Connect of a repo so named lands beside it, never in it.
    assert _connect(kb, owner, "assets")["name"] == "assets-2"
    assert _names(kb, owner) == ["assets-2"]
    assert sorted(p.name for p in (kb.root / "docs").iterdir()) == ["assets"]
    assert tracked.read_text() == "body{}"


def test_another_org_may_name_a_project_so(kb, monkeypatch):
    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "0")
    _tenant_one(kb, monkeypatch)
    other = _account(kb)
    full = _key(kb, other)
    assert kb.post("/app/projects", json={"name": "assets"}, headers=other.h).status_code == 201
    assert kb.post("/api/documents", json=_doc("javascripts"), headers=full).status_code == 201
    assert _capture(kb, full, "Stylesheets").status_code == 202
    assert _connect(kb, other, "assets")["name"] == "assets-2"  # taken by its own project
    assert sorted(_names(kb, other)) == sorted(["assets", "javascripts", "Stylesheets", "assets-2"])


# --- C8, C9: a new account's org ----------------------------------------------------------


def test_a_new_account_starts_in_personal_with_no_project_and_grows_default_on_first_write(kb):
    email = "fresh-" + _account(kb).email
    res = kb.post("/auth/signup", json={"email": email, "password": "hunter2pass"})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["tenant"]["name"] == "Personal" and body["project"] is None and "project" in body
    h = {"Authorization": f"Bearer {body['token']}"}
    assert [t["name"] for t in kb.get("/auth/me", headers=h).json()["tenants"]] == ["Personal"]
    assert kb.get("/app/projects", headers=h).json()["projects"] == []
    with kb.db.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM projects WHERE tenant_id = :t"),
                            {"t": body["tenant"]["id"]}).scalar_one() == 0

    # A capture-only org key with no project lands in "default", made on first capture.
    key = kb.post("/app/credentials", json={"scope": "capture"}, headers=h)
    assert key.status_code == 201, key.text
    capture = {"Authorization": f"Bearer {key.json()['key']}"}
    assert _capture(kb, capture, None).status_code == 202
    names = [p["name"] for p in kb.get("/app/projects", headers=h).json()["projects"]]
    assert names == ["default"]


def test_a_made_org_and_a_fresh_org_after_a_leave_hold_no_project(kb):
    who = _account(kb)
    made = kb.post("/app/orgs", json={"name": "Side"}, headers=who.h)
    assert made.status_code == 201, made.text
    assert "project" in made.json() and made.json()["project"] is None
    side = made.json()["tenant"]["id"]
    assert kb.get("/app/projects", headers={**who.h, "X-Sikstack-Org": side}).json()["projects"] == []

    # A co-owner in each org lets the account leave both; the last leave gives it a
    # fresh org.
    other = _account(kb)
    for org in (who.tenant, side):
        _join(kb, other, org, "owner")
    assert kb.post("/app/tenant/leave", headers=who.h).status_code == 204
    assert kb.post("/app/tenant/leave", headers={**who.h, "X-Sikstack-Org": side}).status_code == 204
    (only,) = kb.get("/auth/me", headers=who.h).json()["tenants"]
    assert only["name"] == "Personal" and only["id"] not in (who.tenant, side)
    assert kb.get("/app/projects", headers=who.h).json()["projects"] == []


@pytest.mark.parametrize("name", ["", "   "])
def test_a_blank_name_gets_the_rule_too(kb, name):
    who = _account(kb)
    res = kb.post("/app/projects", json={"name": name}, headers=who.h)
    assert res.status_code == 422 and _says(res, ERR), res.text
