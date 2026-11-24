"""sikstack installs: registration, sign-in from the machine, the connect page's calls, install Feedback.

Postgres-gated like its neighbours: runs only with a disposable Postgres via
``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) and skips otherwise, bar the dormant
check, which needs none. Each rule of ``server.installs_api`` has its test here:
the pre-user row holds exactly what setup sent; a code is claimed only by a signed-in
account's approval; an install another account claimed is refused; an account whose
email equals the setup email sees nothing it never approved; an expired or unknown
code changes nothing; the workspace key is handed over once; an approval always makes
a project of its own, never joining one that exists; a signed-out read is
rate-limited per address; an install's report lands in the configured project,
limited per install.
"""

from __future__ import annotations

import os
import re
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
_SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
_ENGINE_HEADERS = {"X-Sikstack-Checkout": "test-checkout", "X-Sikstack-Engine": "v99"}
_CODE = re.compile(r"[A-HJKMNP-TW-Z2-9]{4}-[A-HJKMNP-TW-Z2-9]{4}")


def _url(raw: str) -> str:
    return make_url(raw).set(drivername="postgresql+psycopg").render_as_string(hide_password=False)


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A TestClient on a Postgres accounts plane plus a sync engine on it, or skip."""

    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to run the install tests")
    url = _url(_RAW_DSN)
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
    monkeypatch.setenv("KB_PUBLIC_BASE_URL", "https://web.example")
    monkeypatch.delenv("KB_INSTALL_FEEDBACK_PROJECT_ID", raising=False)
    monkeypatch.delenv("KB_INSTALL_RATE_LIMIT", raising=False)
    for name in _SMTP_ENV:
        monkeypatch.delenv(name, raising=False)

    import server.api_auth as api_auth
    import server.feedback.notify as notify
    import server.installs_api as installs_api
    import server.persistence.engine as engine_mod

    monkeypatch.setattr(notify, "send_message", lambda message: None)
    monkeypatch.setattr(installs_api, "_rate_windows", {})
    # Most tests poll back to back; the interval has its own test.
    monkeypatch.setattr(installs_api, "POLL_SLACK_S", 5.0)
    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None

    from server.main import app

    try:
        with TestClient(app) as client:
            yield client, sync_engine
    finally:
        api_auth._tenant_one_cache = None
        engine_mod._engine = None
        engine_mod._session_maker = None
        sync_engine.dispose()


def _signup(client: TestClient, email: str | None = None) -> dict:
    res = client.post(
        "/auth/signup",
        json={"email": email or f"acct-{uuid4().hex}@example.com", "password": "hunter2pass"},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    body["session"] = {"Authorization": f"Bearer {body['token']}"}
    return body


def _register(client: TestClient, install_id: str | None = None, email: str | None = None) -> dict:
    body = {
        "install_id": install_id or str(uuid4()),
        "email": email or f"setup-{uuid4().hex}@example.com",
        "plugin_version": "1.0.0",
    }
    res = client.post("/api/installs", json=body)
    assert res.status_code == 200, res.text
    assert res.json() == {"status": "registered"}
    return body


def _start(client: TestClient, install_id: str, repo: str = "platform") -> dict:
    res = client.post(
        "/api/installs/sign-in", json={"install_id": install_id, "repo": repo, "plugin_version": "1.0.0"}
    )
    assert res.status_code == 200, res.text
    return res.json()


def _poll(client: TestClient, started: dict):
    return client.post("/api/installs/sign-in/poll", json={"poll_token": started["poll_token"]})


def _install_row(engine, install_id: str) -> dict:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM installs WHERE install_id = :i"), {"i": install_id}
        ).mappings().one()
    return dict(row)


def _project_names(client: TestClient, account: dict) -> list[str]:
    res = client.get("/app/projects", headers=account["session"])
    assert res.status_code == 200, res.text
    return sorted(p["name"] for p in res.json()["projects"])


# --- registration (C1) -------------------------------------------------------------


def test_registration_keeps_exactly_the_three_fields_and_a_new_email_updates_the_row(db):
    client, engine = db
    sent = _register(client)
    row = _install_row(engine, sent["install_id"])
    assert set(row) == {
        "id", "install_id", "email", "plugin_version", "created_at", "last_seen_at", "claimed_by", "claimed_at",
    }
    assert (row["install_id"], row["email"], row["plugin_version"]) == (
        sent["install_id"], sent["email"], "1.0.0",
    )
    assert row["claimed_by"] is None and row["claimed_at"] is None

    again = client.post(
        "/api/installs",
        json={"install_id": sent["install_id"], "email": "New@Example.com", "plugin_version": "1.0.1"},
    )
    assert again.status_code == 200 and again.json() == {"status": "registered"}
    updated = _install_row(engine, sent["install_id"])
    assert (updated["id"], updated["email"], updated["plugin_version"]) == (row["id"], "new@example.com", "1.0.1")
    assert updated["created_at"] == row["created_at"] and updated["last_seen_at"] >= row["last_seen_at"]
    with engine.connect() as conn:
        assert conn.execute(
            text("SELECT count(*) FROM installs WHERE install_id = :i"), {"i": sent["install_id"]}
        ).scalar_one() == 1


def test_registration_refuses_a_bad_body_an_oversized_one_and_a_flood_from_one_address(db, monkeypatch):
    client, _ = db
    assert client.post("/api/installs", json={"install_id": str(uuid4()), "email": "a@b.co"}).status_code == 400
    assert client.post(
        "/api/installs", json={"install_id": str(uuid4()), "email": "nope", "plugin_version": "1.0.0"}
    ).status_code == 400
    huge = {"install_id": str(uuid4()), "email": "a@b.co", "plugin_version": "1.0.0", "pad": "x" * 5000}
    assert client.post("/api/installs", json=huge).status_code == 413

    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "2")
    import server.installs_api as installs_api

    monkeypatch.setattr(installs_api, "_rate_windows", {})
    ip = {"X-Real-IP": "203.0.113.7"}
    body = {"install_id": str(uuid4()), "email": "a@b.co", "plugin_version": "1.0.0"}
    assert [client.post("/api/installs", json=body, headers=ip).status_code for _ in range(3)] == [200, 200, 429]
    assert client.post("/api/installs", json=body, headers={"X-Real-IP": "203.0.113.8"}).status_code == 200


# --- start and poll -----------------------------------------------------------------


def test_start_refuses_an_unregistered_install_and_answers_a_code_url_and_poll_token(db):
    client, _ = db
    res = client.post(
        "/api/installs/sign-in", json={"install_id": str(uuid4()), "repo": "platform", "plugin_version": "1.0.0"}
    )
    assert res.status_code == 404 and "/sikstack:setup" in res.json()["detail"]

    sent = _register(client)
    started = _start(client, sent["install_id"])
    assert _CODE.fullmatch(started["code"]), started["code"]
    assert started["url"] == f"https://web.example/connect?code={started['code']}"
    assert started["expires_in"] == 900 and started["interval"] == 5
    assert len(started["poll_token"]) >= 32
    assert _poll(client, started).json() == {"status": "pending"}
    assert client.post("/api/installs/sign-in/poll", json={"poll_token": "nope"}).status_code == 404


def test_a_poll_sooner_than_the_interval_is_slowed_down(db, monkeypatch):
    client, _ = db
    import server.installs_api as installs_api

    monkeypatch.setattr(installs_api, "POLL_SLACK_S", 1.0)
    started = _start(client, _register(client)["install_id"])
    assert _poll(client, started).json() == {"status": "pending"}
    soon = _poll(client, started)
    assert soon.status_code == 429 and soon.json()["status"] == "slow_down"
    assert soon.headers["Retry-After"] == "5"


# --- approve, the one-time key (C3) -----------------------------------------------


def test_approval_claims_the_install_makes_the_repo_project_and_hands_the_key_over_once(db):
    client, engine = db
    sent = _register(client)
    started = _start(client, sent["install_id"], repo="platform")
    owner = _signup(client)

    read = client.get(f"/app/connect/{started['code']}", headers=owner["session"])
    assert read.status_code == 200, read.text
    ready = read.json()
    assert ready["state"] == "ready" and ready["project"] == {"name": "platform"}
    assert ready["install"]["email"] == sent["email"] and ready["install"]["version"] == "1.0.0"
    assert ready["install"]["id"] == f"{sent['install_id'][:4]}…{sent['install_id'][-4:]}"
    assert ready["account"]["email"] == owner["user"]["email"]
    assert [o["id"] for o in ready["account"]["orgs"]] == [owner["tenant"]["id"]]

    approved = client.post(f"/app/connect/{started['code'].lower()}/approve", json={}, headers=owner["session"])
    assert approved.status_code == 200, approved.text
    project_id = approved.json()["project"]["id"]
    assert approved.json()["project"]["name"] == "platform" and approved.json()["org_id"] == owner["tenant"]["id"]
    assert _project_names(client, owner) == ["default", "platform"]

    row = _install_row(engine, sent["install_id"])
    assert str(row["claimed_by"]) == owner["user"]["id"] and row["claimed_at"] is not None

    first = _poll(client, started).json()
    assert first["status"] == "approved" and first["project_id"] == project_id
    assert first["org_id"] == owner["tenant"]["id"] and first["project_name"] == "platform"
    assert first["web_url"] == f"https://web.example/projects/{project_id}/workspace"
    key = first["key"]
    assert key.startswith("vk_")
    head = client.get(
        f"/api/workspace/{project_id}/head", headers={"Authorization": f"Bearer {key}", **_ENGINE_HEADERS}
    )
    assert head.status_code == 200, head.text
    assert head.json()["project_id"] == project_id

    second = _poll(client, started).json()
    assert second["status"] == "approved" and "key" not in second
    with engine.connect() as conn:
        scopes = conn.execute(
            text("SELECT scope FROM project_credentials WHERE project_id = :p"), {"p": project_id}
        ).scalars().all()
    assert scopes == ["workspace"]

    # The page, read again: already connected; signed out, the used code shows nothing.
    assert client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json() == {
        "state": "already", "code": started["code"], "project": {"id": project_id, "name": "platform"},
    }
    assert client.get(f"/app/connect/{started['code']}").json() == {"state": "expired", "code": started["code"]}


# --- an approval makes its own project (never joins one that exists) ----------------


def _approve(client: TestClient, started: dict, account: dict, org_id: str | None = None) -> dict:
    body = {"org_id": org_id} if org_id else {}
    res = client.post(f"/app/connect/{started['code']}/approve", json=body, headers=account["session"])
    assert res.status_code == 200, res.text
    return res.json()["project"]


def _key_opens(client: TestClient, started: dict, project_id: str) -> None:
    """The first poll's key opens exactly this project's workspace, and no other."""

    first = _poll(client, started).json()
    assert first["status"] == "approved" and first["project_id"] == project_id, first
    head = client.get(
        f"/api/workspace/{project_id}/head", headers={"Authorization": f"Bearer {first['key']}", **_ENGINE_HEADERS}
    )
    assert head.status_code == 200, head.text
    assert head.json()["project_id"] == project_id


def _workspace_keys(engine, project_id: str) -> int:
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT count(*) FROM project_credentials WHERE project_id = :p AND scope = 'workspace'"),
            {"p": project_id},
        ).scalar_one()


def test_a_same_named_repo_gets_a_new_project_and_the_first_stays_untouched(db):
    client, engine = db
    owner = _signup(client)
    first = _start(client, _register(client)["install_id"], repo="scratch")
    first_project = _approve(client, first, owner)
    assert first_project["name"] == "scratch"
    _key_opens(client, first, first_project["id"])

    # Another repo with the same folder name, its own install, the same account.
    second = _start(client, _register(client)["install_id"], repo="scratch")
    ready = client.get(f"/app/connect/{second['code']}", headers=owner["session"]).json()
    assert ready["state"] == "ready" and ready["project"] == {"name": "scratch-2"}
    assert [(o["id"], o["project"]) for o in ready["account"]["orgs"]] == [(owner["tenant"]["id"], "scratch-2")]
    second_project = _approve(client, second, owner)
    assert second_project["name"] == "scratch-2" and second_project["id"] != first_project["id"]
    _key_opens(client, second, second_project["id"])

    assert _project_names(client, owner) == ["default", "scratch", "scratch-2"]
    assert _workspace_keys(engine, first_project["id"]) == 1  # the first project got no second key
    assert client.get(f"/app/connect/{second['code']}", headers=owner["session"]).json()["project"] == {
        "id": second_project["id"], "name": "scratch-2",
    }

    # A third takes the next free name.
    third = _start(client, _register(client)["install_id"], repo="scratch")
    assert _approve(client, third, owner)["name"] == "scratch-3"


def test_a_repo_named_default_never_joins_the_orgs_default_project(db):
    client, engine = db
    owner = _signup(client)
    with engine.connect() as conn:
        default_id = str(conn.execute(
            text("SELECT id FROM projects WHERE tenant_id = :t AND name = 'default'"), {"t": owner["tenant"]["id"]}
        ).scalar_one())
    started = _start(client, _register(client)["install_id"], repo="default")
    ready = client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json()
    assert ready["project"] == {"name": "default-2"}
    project = _approve(client, started, owner)
    assert project["name"] == "default-2" and project["id"] != default_id
    _key_opens(client, started, project["id"])
    assert _workspace_keys(engine, default_id) == 0
    assert _project_names(client, owner) == ["default", "default-2"]


def test_a_fresh_name_makes_the_project_by_that_name(db):
    client, _ = db
    owner = _signup(client)
    started = _start(client, _register(client)["install_id"], repo="fresh-repo")
    assert client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json()["project"] == {
        "name": "fresh-repo",
    }
    project = _approve(client, started, owner)
    assert project["name"] == "fresh-repo"
    _key_opens(client, started, project["id"])
    assert _project_names(client, owner) == ["default", "fresh-repo"]


def test_signing_in_again_after_a_lost_key_names_a_new_project_before_connect(db):
    """The same install and repo signing in again (its key lost): the server cannot tell this repo
    from another of the same name on the machine, so it never rejoins. The ready page names the new
    project before Connect, and the old project keeps its records and its one key. Linking back to
    the old project is `sikstack link` with a key minted on that project's page."""

    client, engine = db
    owner = _signup(client)
    sent = _register(client)
    first = _start(client, sent["install_id"], repo="scratch")
    old = _approve(client, first, owner)
    _key_opens(client, first, old["id"])

    again = _start(client, sent["install_id"], repo="scratch")
    ready = client.get(f"/app/connect/{again['code']}", headers=owner["session"]).json()
    assert ready["state"] == "ready" and ready["project"] == {"name": "scratch-2"}
    new = _approve(client, again, owner)
    assert new["name"] == "scratch-2" and new["id"] != old["id"]
    _key_opens(client, again, new["id"])
    assert _workspace_keys(engine, old["id"]) == 1
    assert _project_names(client, owner) == ["default", "scratch", "scratch-2"]


def test_with_two_orgs_each_names_its_own_free_project(db):
    client, engine = db
    owner = _signup(client)
    # A second org for the same account: its own tenant and membership (no route makes one).
    with engine.begin() as conn:
        org_b = str(uuid4())
        conn.execute(
            text("INSERT INTO tenants (id, name, slug, created_at) VALUES (:i, 'Acme', :s, now())"),
            {"i": org_b, "s": f"acme-{uuid4().hex[:8]}"},
        )
        conn.execute(
            text("INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at) VALUES (:i, :t, :u, 'owner', now())"),
            {"i": str(uuid4()), "t": org_b, "u": owner["user"]["id"]},
        )
    taken = _start(client, _register(client)["install_id"], repo="app")
    _approve(client, taken, owner, owner["tenant"]["id"])

    started = _start(client, _register(client)["install_id"], repo="app")
    ready = client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json()
    by_org = {o["id"]: o["project"] for o in ready["account"]["orgs"]}
    assert by_org == {owner["tenant"]["id"]: "app-2", org_b: "app"}
    assert _approve(client, started, owner, org_b)["name"] == "app"


def test_only_a_signed_in_account_approves(db):
    client, engine = db
    sent = _register(client)
    started = _start(client, sent["install_id"])
    assert client.post(f"/app/connect/{started['code']}/approve", json={}).status_code == 401
    assert client.post(
        f"/app/connect/{started['code']}/approve", json={}, headers={"Authorization": "Bearer nope"}
    ).status_code == 401
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _poll(client, started).json() == {"status": "pending"}


def test_an_org_the_account_is_not_in_is_refused(db):
    client, engine = db
    sent = _register(client)
    started = _start(client, sent["install_id"])
    owner, stranger = _signup(client), _signup(client)
    res = client.post(
        f"/app/connect/{started['code']}/approve", json={"org_id": stranger["tenant"]["id"]}, headers=owner["session"]
    )
    assert res.status_code == 403
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _project_names(client, stranger) == ["default"]


# --- the security rules (C2) -------------------------------------------------------


def test_an_install_another_account_claimed_is_refused(db):
    client, engine = db
    sent = _register(client)
    first = _start(client, sent["install_id"])
    alice, bob = _signup(client), _signup(client)
    assert client.post(f"/app/connect/{first['code']}/approve", json={}, headers=alice["session"]).status_code == 200

    second = _start(client, sent["install_id"], repo="other-repo")
    assert client.get(f"/app/connect/{second['code']}", headers=bob["session"]).json() == {
        "state": "other", "code": second["code"],
    }
    refused = client.post(f"/app/connect/{second['code']}/approve", json={}, headers=bob["session"])
    assert refused.status_code == 403
    assert client.post(f"/app/connect/{second['code']}/decline", headers=bob["session"]).status_code == 403
    assert str(_install_row(engine, sent["install_id"])["claimed_by"]) == alice["user"]["id"]
    assert _project_names(client, bob) == ["default"]
    assert _poll(client, second).json() == {"status": "pending"}
    # Alice's own second repo connects: an install claimed by her takes more projects.
    assert client.post(f"/app/connect/{second['code']}/approve", json={}, headers=alice["session"]).status_code == 200
    assert _project_names(client, alice) == ["default", "other-repo", "platform"]


def test_the_setup_email_alone_claims_nothing(db):
    client, engine = db
    setup_email = f"same-{uuid4().hex}@example.com"
    sent = _register(client, email=setup_email)
    started = _start(client, sent["install_id"])

    # An account with the setup email that approved nothing: no install, no project.
    same = _signup(client, email=setup_email)
    assert _project_names(client, same) == ["default"]
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _poll(client, started).json() == {"status": "pending"}

    # Another account approves; the same-email account still sees none of it.
    owner = _signup(client)
    assert client.post(f"/app/connect/{started['code']}/approve", json={}, headers=owner["session"]).status_code == 200
    assert _project_names(client, same) == ["default"]
    assert client.get(f"/app/connect/{started['code']}", headers=same["session"]).json()["state"] == "other"
    assert str(_install_row(engine, sent["install_id"])["claimed_by"]) == owner["user"]["id"]


def test_an_expired_or_unknown_code_changes_nothing(db):
    client, engine = db
    sent = _register(client)
    started = _start(client, sent["install_id"], repo="expired-repo")
    with engine.begin() as conn:
        conn.execute(
            text("UPDATE install_sign_ins SET expires_at = now() - :d WHERE code = :c"),
            {"d": timedelta(seconds=1), "c": started["code"].replace("-", "")},
        )
    owner = _signup(client)
    assert client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json() == {
        "state": "expired", "code": started["code"],
    }
    assert client.get(f"/app/connect/{started['code']}").json()["state"] == "expired"
    for verb in ("approve", "decline"):
        res = client.post(f"/app/connect/{started['code']}/{verb}", json={}, headers=owner["session"])
        assert res.status_code == 410, res.text
    for unknown in ("AAAA-AAAA", "not-a-code"):
        assert client.get(f"/app/connect/{unknown}", headers=owner["session"]).json()["state"] == "expired"
        assert client.post(f"/app/connect/{unknown}/approve", json={}, headers=owner["session"]).status_code == 410
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _project_names(client, owner) == ["default"]
    assert _poll(client, started).json() == {"status": "expired"}


def test_a_declined_code_denies_the_poll_and_claims_nothing(db):
    client, engine = db
    sent = _register(client)
    started = _start(client, sent["install_id"])
    owner = _signup(client)
    assert client.post(f"/app/connect/{started['code']}/decline", headers=owner["session"]).json() == {
        "state": "declined",
    }
    assert _poll(client, started).json() == {"status": "denied"}
    assert client.get(f"/app/connect/{started['code']}", headers=owner["session"]).json()["state"] == "declined"
    assert client.post(f"/app/connect/{started['code']}/approve", json={}, headers=owner["session"]).status_code == 410
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _project_names(client, owner) == ["default"]


def test_a_signed_out_read_shows_the_setup_email_and_is_rate_limited_per_address(db, monkeypatch):
    client, _ = db
    sent = _register(client)
    started = _start(client, sent["install_id"])
    out = client.get(f"/app/connect/{started['code']}").json()
    assert out["state"] == "out" and out["install"]["email"] == sent["email"]
    assert "account" not in out and out["project"] == {"name": "platform"}

    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "3")
    import server.installs_api as installs_api

    monkeypatch.setattr(installs_api, "_rate_windows", {})
    ip = {"X-Real-IP": "198.51.100.4"}
    codes = [client.get(f"/app/connect/{started['code']}", headers=ip).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
    assert client.get(f"/app/connect/{started['code']}", headers={"X-Real-IP": "198.51.100.5"}).status_code == 200


# --- release: `sikstack sign-in --release` moves an install to another account ------


_FIVE_KEYS = {"code", "url", "poll_token", "expires_in", "interval"}


def _start_with(client: TestClient, install_id: str, **extra):
    body = {"install_id": install_id, "repo": "platform", "plugin_version": "1.0.0", **extra}
    return client.post("/api/installs/sign-in", json=body)


def _sign_in_rows(engine, install_id: str) -> dict[str, dict]:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT s.* FROM install_sign_ins s JOIN installs i ON i.id = s.install_id "
                "WHERE i.install_id = :i"
            ),
            {"i": install_id},
        ).mappings().all()
    return {row["code"]: dict(row) for row in rows}


def _table(engine, name: str) -> list[dict]:
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(text(f"SELECT * FROM {name} ORDER BY id")).mappings().all()]


def test_release_frees_a_claimed_install_keeps_its_projects_and_keys_and_ends_its_older_codes(db):
    client, engine = db
    sent = _register(client)
    alice, bob = _signup(client), _signup(client)
    approved = _start(client, sent["install_id"], repo="platform")
    project = _approve(client, approved, alice)
    _key_opens(client, approved, project["id"])
    declined = _start(client, sent["install_id"], repo="declined-repo")
    assert client.post(f"/app/connect/{declined['code']}/decline", headers=alice["session"]).status_code == 200
    older = _start(client, sent["install_id"], repo="platform")
    assert str(_install_row(engine, sent["install_id"])["claimed_by"]) == alice["user"]["id"]

    install_before = _install_row(engine, sent["install_id"])
    rows_before = _sign_in_rows(engine, sent["install_id"])
    projects_before = _table(engine, "projects")
    keys_before = _table(engine, "project_credentials")

    res = _start_with(client, sent["install_id"], release=True)
    assert res.status_code == 200, res.text
    answer = res.json()
    assert set(answer) == _FIVE_KEYS | {"released"} and answer["released"] is True
    assert alice["user"]["email"] not in res.text and alice["user"]["id"] not in res.text

    install = _install_row(engine, sent["install_id"])
    assert install["claimed_by"] is None and install["claimed_at"] is None
    for column in ("id", "install_id", "email", "created_at"):
        assert install[column] == install_before[column], column
    assert _table(engine, "projects") == projects_before
    assert _table(engine, "project_credentials") == keys_before

    rows = _sign_in_rows(engine, sent["install_id"])
    new_code = answer["code"].replace("-", "")
    assert set(rows) == set(rows_before) | {new_code}
    for code, before in rows_before.items():
        after = rows[code]
        if before["state"] == "pending":
            assert after["expires_at"] <= rows[new_code]["created_at"]
            assert {k: v for k, v in after.items() if k != "expires_at"} == {
                k: v for k, v in before.items() if k != "expires_at"
            }
        else:
            assert after == before, code
    # The older code is ended: expired to read (either account, or none) and to poll.
    for headers in (bob["session"], alice["session"], {}):
        assert client.get(f"/app/connect/{older['code']}", headers=headers).json() == {
            "state": "expired", "code": older["code"],
        }
    assert _poll(client, older).json() == {"status": "expired"}
    assert client.post(f"/app/connect/{older['code']}/approve", json={}, headers=alice["session"]).status_code == 410
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    # The approved and declined codes read as before.
    assert _poll(client, approved).json()["status"] == "approved"
    assert _poll(client, declined).json() == {"status": "denied"}

    # The released code is Bob's to Connect: it claims the install for him.
    assert _poll(client, answer).json() == {"status": "pending"}
    ready = client.get(f"/app/connect/{answer['code']}", headers=bob["session"]).json()
    assert ready["state"] == "ready" and ready["account"]["email"] == bob["user"]["email"]
    bobs = _approve(client, answer, bob)
    _key_opens(client, answer, bobs["id"])
    assert str(_install_row(engine, sent["install_id"])["claimed_by"]) == bob["user"]["id"]
    assert _project_names(client, bob) == ["default", "platform"]
    assert _project_names(client, alice) == ["default", "platform"]
    assert _workspace_keys(engine, project["id"]) == 1


def test_release_on_an_unclaimed_install_answers_false_and_still_ends_its_older_codes(db):
    client, engine = db
    sent = _register(client)
    older = _start(client, sent["install_id"])
    res = _start_with(client, sent["install_id"], release=True)
    assert res.status_code == 200, res.text
    answer = res.json()
    assert set(answer) == _FIVE_KEYS | {"released"} and answer["released"] is False
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    assert _poll(client, older).json() == {"status": "expired"}
    assert _poll(client, answer).json() == {"status": "pending"}
    # An unregistered install releases nothing: today's 404.
    missing = _start_with(client, str(uuid4()), release=True)
    assert missing.status_code == 404 and "/sikstack:setup" in missing.json()["detail"]


def test_a_start_without_release_answers_todays_five_keys_and_keeps_the_claim(db):
    client, engine = db
    sent = _register(client)
    owner = _signup(client)
    _approve(client, _start(client, sent["install_id"]), owner)
    older = _start(client, sent["install_id"])
    for extra in ({}, {"release": False}):
        res = _start_with(client, sent["install_id"], **extra)
        assert res.status_code == 200, res.text
        assert set(res.json()) == _FIVE_KEYS, extra
    assert str(_install_row(engine, sent["install_id"])["claimed_by"]) == owner["user"]["id"]
    assert _poll(client, older).json() == {"status": "pending"}


def test_a_release_that_is_not_a_boolean_is_refused_and_changes_nothing(db):
    client, engine = db
    sent = _register(client)
    owner = _signup(client)
    _approve(client, _start(client, sent["install_id"]), owner)
    older = _start(client, sent["install_id"])
    install_before = _install_row(engine, sent["install_id"])
    rows_before = _sign_in_rows(engine, sent["install_id"])
    for bad in ("true", "yes", 1, 0, None, [], [True], {}):
        for install_id in (sent["install_id"], str(uuid4())):
            res = _start_with(client, install_id, release=bad)
            assert res.status_code == 400, (bad, res.text)
            assert res.json() == {"detail": "release is not valid"}, bad
    assert _install_row(engine, sent["install_id"]) == install_before
    assert _sign_in_rows(engine, sent["install_id"]) == rows_before
    assert _poll(client, older).json() == {"status": "pending"}


@pytest.mark.parametrize("verb", ["approve", "decline"])
def test_an_approval_or_decline_that_waited_on_a_release_finds_its_code_ended(db, monkeypatch, verb):
    """A Connect or a decline that reached the code while a release held it reads the time after the lock, so the
    release's end of the code holds: 410, the claim stays clear and the code stays as the release left it. The
    release is replayed by hand in a transaction of the test's own: the code's lock, then the install's (the
    release's order), its expiry and its cleared claim, committed only once the request waits on the lock."""

    import threading
    import time

    import server.installs_api as installs_api

    client, engine = db
    real_now = installs_api.utc_now
    sent = _register(client)
    owner = _signup(client)
    _approve(client, _start(client, sent["install_id"]), owner)
    started = _start(client, sent["install_id"])
    code = started["code"].replace("-", "")
    t0 = real_now()
    clock = {"now": t0}
    monkeypatch.setattr(installs_api, "utc_now", lambda: clock["now"])
    answers: dict[str, object] = {}
    with engine.connect() as release:
        held = release.begin()
        release.execute(text("SELECT id FROM install_sign_ins WHERE code = :c FOR UPDATE"), {"c": code})
        release.execute(
            text("SELECT id FROM installs WHERE install_id = :i FOR UPDATE"), {"i": sent["install_id"]}
        )

        def act() -> None:
            answers["res"] = client.post(f"/app/connect/{started['code']}/{verb}", json={}, headers=owner["session"])

        worker = threading.Thread(target=act)
        worker.start()
        waiting, until = 0, time.monotonic() + 15
        while waiting == 0 and time.monotonic() < until and worker.is_alive():
            with engine.connect() as watch:
                waiting = watch.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                        "AND wait_event_type = 'Lock'"
                    )
                ).scalar_one()
            time.sleep(0.02)
        assert waiting, f"the {verb} never waited on the release's lock"
        clock["now"] = t0 + timedelta(milliseconds=50)  # the release read its clock after the request did
        release.execute(
            text("UPDATE install_sign_ins SET expires_at = :n WHERE code = :c AND expires_at > :n"),
            {"n": clock["now"], "c": code},
        )
        release.execute(
            text("UPDATE installs SET claimed_by = NULL, claimed_at = NULL WHERE install_id = :i"),
            {"i": sent["install_id"]},
        )
        held.commit()
    worker.join(30)
    assert not worker.is_alive()
    monkeypatch.setattr(installs_api, "utc_now", real_now)
    res = answers["res"]
    assert res.status_code == 410, (verb, res.status_code, res.text)
    assert res.json() == {"detail": "this code no longer works"}
    assert _install_row(engine, sent["install_id"])["claimed_by"] is None
    row = _sign_in_rows(engine, sent["install_id"])[code]
    assert row["state"] == "pending" and row["expires_at"] == clock["now"]
    assert row["decided_by"] is None and row["project_id"] is None


# --- an install's Feedback ----------------------------------------------------------


def _report(client: TestClient, install_id: str, message: str = "setup said pending twice"):
    return client.post(
        "/api/installs/feedback",
        json={"install_id": install_id, "message": message, "plugin_version": "1.0.0"},
    )


def test_install_feedback_is_dormant_until_its_project_is_set(db):
    client, _ = db
    assert _report(client, _register(client)["install_id"]).status_code == 404


def test_an_installs_report_lands_in_the_configured_project_limited_per_install(db, monkeypatch):
    client, engine = db
    operator = _signup(client)
    destination = client.post("/app/projects", json={"name": "sikstack"}, headers=operator["session"]).json()
    monkeypatch.setenv("KB_INSTALL_FEEDBACK_PROJECT_ID", destination["project"]["id"])
    monkeypatch.setenv("KB_INSTALL_FEEDBACK_RATE_LIMIT", "2")

    anonymous = _register(client)
    assert _report(client, str(uuid4())).status_code == 404  # never registered
    first = _report(client, anonymous["install_id"])
    assert first.status_code == 202, first.text
    assert first.json()["status"] == "accepted"
    assert _report(client, anonymous["install_id"]).status_code == 202
    limited = _report(client, anonymous["install_id"])
    assert limited.status_code == 429

    # Another install still sends; a claimed install's report carries its account.
    claimed = _register(client)
    started = _start(client, claimed["install_id"])
    owner = _signup(client)
    assert client.post(f"/app/connect/{started['code']}/approve", json={}, headers=owner["session"]).status_code == 200
    assert _report(client, claimed["install_id"], "sign-in opened the page").status_code == 202

    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT message, source_product, user_id, tags, attributes FROM feedback_events "
                "WHERE project_id = :p ORDER BY ingested_at"
            ),
            {"p": destination["project"]["id"]},
        ).mappings().all()
    assert len(rows) == 3
    assert rows[0]["source_product"] == "sikstack" and rows[0]["user_id"] is None
    assert list(rows[0]["tags"]) == ["sikstack", f"install:{anonymous['install_id']}"]
    assert rows[0]["attributes"] == {"install_id": anonymous["install_id"], "plugin_version": "1.0.0"}
    assert rows[2]["message"] == "sign-in opened the page" and rows[2]["user_id"] == owner["user"]["id"]
    assert rows[2]["attributes"]["account_email"] == owner["user"]["email"]


# --- dormant and the migration -----------------------------------------------------


def test_every_install_route_is_dormant_without_a_database(tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    monkeypatch.setenv("KB_ROOT", str(tmp_path))
    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("KB_INSTALL_FEEDBACK_PROJECT_ID", str(uuid4()))
    from server.main import app

    with TestClient(app) as client:
        for path in ("/api/installs", "/api/installs/sign-in", "/api/installs/sign-in/poll", "/api/installs/feedback"):
            assert client.post(path, json={}).status_code == 404, path
        assert client.get("/app/connect/AAAA-AAAA").status_code == 404


def test_the_installs_migration_applies_on_a_fresh_database(monkeypatch):
    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL to a disposable Postgres to run the migration test")
    ini = Path(__file__).resolve().parents[1] / "alembic.ini"
    if not ini.is_file():
        pytest.skip("no alembic/ here (the plugin template ships none)")
    from alembic import command
    from alembic.autogenerate import compare_metadata
    from alembic.config import Config
    from alembic.migration import MigrationContext

    from server.persistence import models  # noqa: F401
    from server.persistence.base import Base

    base = make_url(_url(_RAW_DSN))
    name = f"kb_inst_{uuid4().hex[:10]}"
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
    tables = ["installs", "install_sign_ins"]
    engine = create_engine(url)
    count = text("SELECT count(*) FROM pg_tables WHERE tablename = ANY(:t)")
    try:
        command.upgrade(cfg, "head")
        with engine.connect() as conn:
            assert conn.execute(count, {"t": tables}).scalar_one() == 2
            assert compare_metadata(
                MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata
            ) == []
        command.downgrade(cfg, "0011_workspace_store")
        with engine.connect() as conn:
            assert conn.execute(count, {"t": tables}).scalar_one() == 0
        command.upgrade(cfg, "head")
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()


def test_a_code_is_eight_characters_without_look_alikes():
    from server.installs_api import CODE_ALPHABET, normalize_code, shown_code

    assert not set("0O1ILUV") & set(CODE_ALPHABET)
    assert normalize_code(" kq4m-7tzp ") == "KQ4M7TZP" and shown_code("KQ4M7TZP") == "KQ4M-7TZP"
    for bad in ("KQ4M-7TZ", "KQ4M-7TZ0", "", "KQ4M-7TZPP"):
        assert normalize_code(bad) is None
    assert UUID(int=0)  # the module imports clean without a database
