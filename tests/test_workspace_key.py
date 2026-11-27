"""The ``workspace`` key scope: Postgres-gated.

A ``workspace`` key links one checkout of one project's workspace and reaches
nothing else. It is minted only on the project's key route, bound to that project;
the org key route refuses it (422). ``resolve_api_workspace(request, project_id)``
lets through only that project's workspace key: another project's workspace key is
a 404 (a key cannot probe projects), a ``full`` or ``capture`` key, the master
bearer or a session a 403, a revoked key a 401, and legacy mode (no
``DATABASE_URL``) a 404. Feedback capture and the Library routes refuse it (403).

The workspace routes themselves are mounted elsewhere, so the resolver is proved
through a probe route this file mounts on the app for one test and removes after.
Like its neighbours this runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise.
"""

from __future__ import annotations

import logging
import os
from uuid import UUID, uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_PROBE = "/__probe__/workspace/{project_id}"
_SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")


@pytest.fixture
def ws(tmp_path, monkeypatch):
    """A TestClient on a Postgres accounts plane with the probe route mounted, or skip."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the workspace key tests"
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
    import server.feedback.notify as notify
    import server.persistence.engine as engine_mod

    monkeypatch.setattr(notify, "send_message", lambda message: None)
    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None

    from server.main import app

    async def probe(project_id: UUID, request: Request) -> dict[str, str]:
        ctx = await api_auth.resolve_api_workspace(request, project_id)
        return {"project_id": str(ctx.project_id), "tenant_id": str(ctx.tenant_id), "scope": ctx.scope}

    app.add_api_route(_PROBE, probe, methods=["GET"])
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != _PROBE]
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        sync_engine.dispose()


def _signup(client: TestClient) -> dict:
    res = client.post(
        "/auth/signup",
        json={"email": f"wskey-{uuid4().hex}@example.com", "password": "hunter2pass"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    body["session"] = {"Authorization": f"Bearer {body['token']}"}
    # A new account's org holds no project; these tests write into one named "default".
    made = client.post("/app/projects", json={"name": "default"}, headers=body["session"])
    assert made.status_code == 201, made.text
    body["project"] = made.json()["project"]
    return body


def _mint(client: TestClient, owner: dict, scope: str, *, project_id: str | None = None):
    """Mint a key; ``project_id`` picks the project route, ``None`` the org route."""

    path = f"/app/projects/{project_id}/credentials" if project_id else "/app/credentials"
    return client.post(path, json={"scope": scope}, headers=owner["session"])


def _bearer(res) -> dict:
    assert res.status_code == 201, res.text
    return {"Authorization": f"Bearer {res.json()['key']}"}


def _probe(client: TestClient, project_id: str, headers: dict):
    return client.get(_PROBE.format(project_id=project_id), headers=headers)


def _second_project(client: TestClient, owner: dict, name: str) -> str:
    res = client.post("/app/projects", json={"name": name}, headers=owner["session"])
    assert res.status_code == 201, res.text
    return res.json()["project"]["id"]


def test_the_project_route_mints_a_workspace_key_bound_to_it(ws):
    owner = _signup(ws)
    project_id = owner["project"]["id"]
    res = _mint(ws, owner, "workspace", project_id=project_id)
    assert res.status_code == 201, res.text
    credential = res.json()["credential"]
    assert credential["scope"] == "workspace" and credential["project_id"] == project_id
    listed = ws.get(f"/app/projects/{project_id}/credentials", headers=owner["session"])
    assert [c["scope"] for c in listed.json()["credentials"]] == ["workspace"]


def test_the_org_route_refuses_a_workspace_key(ws):
    owner = _signup(ws)
    res = _mint(ws, owner, "workspace")
    assert res.status_code == 422, res.text
    assert "workspace key must name a project" in res.text
    # Nothing was minted, and the other scopes still mint there.
    assert ws.get("/app/credentials", headers=owner["session"]).json()["credentials"] == []
    assert _mint(ws, owner, "capture").status_code == 201


def test_an_unbound_workspace_credential_never_reaches_the_table(ws):
    from server.accounts.types import CreateProjectCredential

    owner = _signup(ws)
    with pytest.raises(ValueError):
        CreateProjectCredential(
            tenant_id=UUID(owner["tenant"]["id"]),
            token_prefix="vk_x",
            token_hash=uuid4().hex,
            scope="workspace",
        )


def test_the_workspace_resolver_admits_only_its_own_projects_workspace_key(ws, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    owner = _signup(ws)
    project_a = owner["project"]["id"]
    project_b = _second_project(ws, owner, "other")
    mint_a = _mint(ws, owner, "workspace", project_id=project_a)
    key_a = _bearer(mint_a)
    key_b = _bearer(_mint(ws, owner, "workspace", project_id=project_b))

    ok = _probe(ws, project_a, key_a)
    assert ok.status_code == 200, ok.text
    assert ok.json() == {
        "project_id": project_a, "tenant_id": owner["tenant"]["id"], "scope": "workspace",
    }

    # Another project's workspace key, same org or another org: 404, never 403.
    stranger = _signup(ws)
    key_c = _bearer(_mint(ws, stranger, "workspace", project_id=stranger["project"]["id"]))
    for headers in (key_b, key_c):
        miss = _probe(ws, project_a, headers)
        assert miss.status_code == 404, miss.text
        assert miss.json()["detail"] == "project not found"
    assert _probe(ws, str(uuid4()), key_a).status_code == 404

    # A full key, a capture key (org or project-bound) and a session: 403, naming the scope.
    refused = {
        "full": _bearer(_mint(ws, owner, "full")),
        "full (project)": _bearer(_mint(ws, owner, "full", project_id=project_a)),
        "capture": _bearer(_mint(ws, owner, "capture", project_id=project_a)),
        "session": owner["session"],
    }
    for label, headers in refused.items():
        res = _probe(ws, project_a, headers)
        assert res.status_code == 403, (label, res.text)
        scope = label.split()[0] if label != "session" else "full"
        assert res.json()["detail"] == (
            f"this key's scope is {scope}: workspace routes need a workspace key"
        ), label

    # The master bearer: 403 too.
    import server.api_auth as api_auth

    monkeypatch.setenv("KB_API_TOKEN", "wskey-master-bearer")
    monkeypatch.setenv("KB_OPERATOR_EMAIL", owner["user"]["email"])
    api_auth._tenant_one_cache = None
    master = _probe(ws, project_a, {"Authorization": "Bearer wskey-master-bearer"})
    assert master.status_code == 403, master.text

    # No bearer, an unknown one: 401.
    assert _probe(ws, project_a, {}).status_code == 401
    assert _probe(ws, project_a, {"Authorization": "Bearer vk_unknown"}).status_code == 401

    # The key's secret appears in no response but its own mint, and in no log line.
    secret = mint_a.json()["key"]
    for res in (ok, _probe(ws, project_b, key_a), _probe(ws, project_a, refused["full"])):
        assert secret not in res.text
    assert all(secret not in record.getMessage() for record in caplog.records)


def test_a_revoked_workspace_key_is_401(ws):
    owner = _signup(ws)
    project_id = owner["project"]["id"]
    mint = _mint(ws, owner, "workspace", project_id=project_id)
    key = _bearer(mint)
    assert _probe(ws, project_id, key).status_code == 200
    revoke = ws.delete(
        f"/app/projects/{project_id}/credentials/{mint.json()['credential']['id']}",
        headers=owner["session"],
    )
    assert revoke.status_code == 204, revoke.text
    assert _probe(ws, project_id, key).status_code == 401


def test_legacy_mode_answers_404(ws, monkeypatch):
    owner = _signup(ws)
    project_id = owner["project"]["id"]
    key = _bearer(_mint(ws, owner, "workspace", project_id=project_id))
    monkeypatch.delenv("DATABASE_URL")
    assert _probe(ws, project_id, key).status_code == 404
    assert _probe(ws, project_id, {}).status_code == 404


def test_a_workspace_key_reaches_no_capture_and_no_library_route(ws):
    owner = _signup(ws)
    key = _bearer(_mint(ws, owner, "workspace", project_id=owner["project"]["id"]))
    capture = ws.post(
        "/api/feedback",
        json={"message": "the button is broken", "source": {"product": "app-x"}, "user_id": "u-1"},
        headers=key,
    )
    assert capture.status_code == 403, capture.text
    upload = ws.post(
        "/api/feedback/attachments?user_id=u-1&source_product=app-x",
        files={"file": ("shot.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, "image/png")},
        headers=key,
    )
    assert upload.status_code == 403, upload.text
    assert ws.get("/api/projects", headers=key).status_code == 403
    assert ws.get("/api/project/feedback", headers=key).status_code == 403
    doc = {
        "title": "Workspace Key", "markdown": "# Workspace Key\n\nBody.\n",
        "project": "default", "tags": ["testing"], "source_repo": "wskey", "commit": False,
    }
    assert ws.post("/api/documents", json=doc, headers=key).status_code == 403

    # The two capture scopes still capture.
    for scope in ("capture", "full"):
        other = _bearer(_mint(ws, owner, scope))
        res = ws.post(
            "/api/feedback",
            json={"message": "still fine", "source": {"product": "app-x"}, "user_id": "u-1"},
            headers=other,
        )
        assert res.status_code == 202, (scope, res.text)


_ENGINE = {"X-Sikstack-Checkout": "wskey-checkout", "X-Sikstack-Engine": "v99"}


def _last_used(client: TestClient, owner: dict, credential_id: str, *, project_id: str | None = None):
    path = f"/app/projects/{project_id}/credentials" if project_id else "/app/credentials"
    listed = client.get(path, headers=owner["session"])
    assert listed.status_code == 200, listed.text
    (row,) = [c for c in listed.json()["credentials"] if c["id"] == credential_id]
    return row["last_used_at"]


def test_every_workspace_route_stamps_the_keys_last_use(ws):
    owner = _signup(ws)
    project_id = owner["project"]["id"]
    base = f"/api/workspace/{project_id}"
    calls = {
        "head": lambda h: ws.get(f"{base}/head", headers=h),
        "manifest": lambda h: ws.get(f"{base}/manifest?since=0", headers=h),
        "fetch": lambda h: ws.post(f"{base}/fetch", json={"paths": []}, headers=h),
        "inbox": lambda h: ws.get(f"{base}/inbox", headers=h),
        "commit": lambda h: ws.post(
            f"{base}/commit", json={"batch_id": str(uuid4()), "ops": []}, headers=h
        ),
    }
    for route, call in calls.items():
        mint = _mint(ws, owner, "workspace", project_id=project_id)
        credential_id = mint.json()["credential"]["id"]
        assert _last_used(ws, owner, credential_id, project_id=project_id) is None
        res = call({**_bearer(mint), **_ENGINE})
        assert res.status_code == 200, (route, res.text)
        assert _last_used(ws, owner, credential_id, project_id=project_id), route


def test_a_failed_stamp_never_fails_a_workspace_request(ws, monkeypatch):
    from server.accounts.service import AccountsService

    async def broken(self, credential_id):
        raise RuntimeError("stamp store down")

    owner = _signup(ws)
    project_id = owner["project"]["id"]
    mint = _mint(ws, owner, "workspace", project_id=project_id)
    monkeypatch.setattr(AccountsService, "touch_credential_last_used", broken)
    res = ws.get(f"/api/workspace/{project_id}/head", headers={**_bearer(mint), **_ENGINE})
    assert res.status_code == 200, res.text
    monkeypatch.undo()


def test_a_capture_key_on_feedback_is_still_stamped(ws):
    owner = _signup(ws)
    mint = _mint(ws, owner, "capture")
    credential_id = mint.json()["credential"]["id"]
    assert _last_used(ws, owner, credential_id) is None
    res = ws.post(
        "/api/feedback",
        json={"message": "stamp me", "source": {"product": "app-x"}, "user_id": "u-1"},
        headers=_bearer(mint),
    )
    assert res.status_code == 202, res.text
    assert _last_used(ws, owner, credential_id)
