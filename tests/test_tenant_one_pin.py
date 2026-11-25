"""Tenant #1 is pinned: no membership change moves it. Postgres-gated.

Tenant #1 (``server.api_auth.get_tenant_one_id``) holds the ``docs/`` corpus, the
``KB_API_TOKEN`` master bearer and ``is_public``. It is the org pinned for the
``KB_OPERATOR_EMAIL`` account in ``tenant_one_pins`` (revision ``0017``), first pinned
from that account's first membership. An owner can hand an org over and leave it, a
co-owner can remove another owner, and an account that loses its last org gets a fresh
one: none of these moves tenant #1, across a restart (a cache reset) and the boot
reindex.

Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set, like the other
accounts suites. Emails are uuid-unique, so a reused database never interferes: the pin
is keyed by the operator's account.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text
from starlette.requests import Request

from tests.test_org_invites import (  # noqa: F401 - the fixture and its helpers
    _RAW_DSN,
    _account,
    _in,
    _invite,
    _member_id,
    _new_org,
    org,
)

MASTER = "p80-tenant-one-master"


def _request(headers: dict[str, str]) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


def _restart() -> None:
    """What an API restart forgets: the process's memo of tenant #1."""

    import server.api_auth as api_auth

    api_auth._tenant_one_cache = None


def _tenant_one(client, monkeypatch, email: str) -> str | None:
    """Tenant #1 as a freshly started API resolves it, for ``email`` as the operator."""

    import server.api_auth as api_auth

    monkeypatch.setenv("KB_OPERATOR_EMAIL", email)
    _restart()
    found = client.portal.call(api_auth.get_tenant_one_id)
    return str(found) if found else None


def _hand_over_and_leave(client, op: dict, org_id: str) -> dict:
    """``op`` invites an heir into ``org_id``, makes it an owner and leaves."""

    heir = _account(client)
    code = _invite(client, op, org_id, heir["email"])
    assert client.post(f"/app/invite/{code}/accept", headers=heir["h"]).status_code == 200
    mid = _member_id(client, op, org_id, heir["email"])
    assert client.post(f"/app/members/{mid}/owner", headers=_in(op["h"], org_id)).status_code == 204
    assert client.post("/app/tenant/leave", headers=_in(op["h"], org_id)).status_code == 204
    return heir


def _orgs(client, who: dict) -> list[str]:
    return [t["id"] for t in client.get("/auth/me", headers=who["h"]).json()["tenants"]]


# --- 1-3: no membership change moves tenant #1 ---------------------------------------


def test_handing_the_sign_up_org_over_and_leaving_keeps_tenant_one(org, monkeypatch):
    op = _account(org)
    personal = op["default_org"]
    krpd = _new_org(org, op, "KRPD")
    assert _tenant_one(org, monkeypatch, op["email"]) == personal

    _hand_over_and_leave(org, op, personal)
    assert _orgs(org, op) == [krpd]
    assert _tenant_one(org, monkeypatch, op["email"]) == personal


def test_leaving_every_org_keeps_tenant_one(org, monkeypatch):
    op = _account(org)
    personal = op["default_org"]
    krpd = _new_org(org, op, "KRPD")
    assert _tenant_one(org, monkeypatch, op["email"]) == personal

    for org_id in (personal, krpd):
        _hand_over_and_leave(org, op, org_id)
    left = _orgs(org, op)
    assert len(left) == 1 and left[0] not in (personal, krpd)  # the fresh `default` org
    assert _tenant_one(org, monkeypatch, op["email"]) == personal


def test_a_co_owner_removing_the_operator_keeps_tenant_one(org, monkeypatch):
    op = _account(org)
    personal = op["default_org"]
    assert _tenant_one(org, monkeypatch, op["email"]) == personal

    heir = _account(org)
    code = _invite(org, op, personal, heir["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=heir["h"]).status_code == 200
    mid = _member_id(org, op, personal, heir["email"])
    assert org.post(f"/app/members/{mid}/owner", headers=_in(op["h"], personal)).status_code == 204
    op_mid = _member_id(org, heir, personal, op["email"])
    assert org.delete(f"/app/members/{op_mid}", headers=_in(heir["h"], personal)).status_code == 204
    assert personal not in _orgs(org, op)
    assert _tenant_one(org, monkeypatch, op["email"]) == personal


# --- 4-5: the readers of tenant #1 follow the pin ----------------------------------------


def test_the_boot_reindex_stamps_docs_with_the_pinned_org(org, monkeypatch):
    import server.persistence.engine as engine_mod
    from server import config, db
    from server.main import app

    op = _account(org)
    personal = op["default_org"]
    krpd = _new_org(org, op, "KRPD")
    assert _tenant_one(org, monkeypatch, op["email"]) == personal
    for org_id in (personal, krpd):
        _hand_over_and_leave(org, op, org_id)
    fresh = _orgs(org, op)[0]

    doc = config.docs_root() / "notes" / "2026-11-25-handover.md"
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_text(
        '---\ntitle: "Handover"\ndate: 2026-11-25\ntags:\n  - probe\n'
        "source:\n  project: notes\n  repo: /tmp/notes\n---\n\n# Handover\n\nA body.\n"
    )

    # A restart: a new process boots the app, and its lifespan reindexes docs/.
    monkeypatch.setenv("KB_STARTUP_REINDEX", "true")
    _restart()
    engine_mod._engine = None
    engine_mod._session_maker = None
    with TestClient(app):
        pass
    engine_mod._engine = None
    engine_mod._session_maker = None

    conn = db.connect()
    try:
        owners = {
            r[0]
            for r in conn.execute(
                "SELECT tenant_id FROM documents WHERE rel_path LIKE 'notes/%'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert owners == {personal}, (owners, fresh)


def test_the_master_bearer_and_is_public_follow_the_pin(org, monkeypatch):
    import server.api_auth as api_auth

    op = _account(org)
    personal = op["default_org"]
    krpd = _new_org(org, op, "KRPD")
    assert _tenant_one(org, monkeypatch, op["email"]) == personal
    _hand_over_and_leave(org, op, personal)

    monkeypatch.setenv("KB_API_TOKEN", MASTER)
    _restart()
    master = org.portal.call(api_auth.resolve_api_read, _request({"Authorization": f"Bearer {MASTER}"}))
    assert str(master.tenant_id) == personal and master.is_public

    in_krpd = org.portal.call(
        api_auth.resolve_api_read,
        _request({"Authorization": op["h"]["Authorization"], "X-Sikstack-Org": krpd}),
    )
    assert str(in_krpd.tenant_id) == krpd and not in_krpd.is_public


# --- 7: a database with no pin pins at its first resolution, once -------------------------


def _pins(client, user_id: str) -> list[str]:
    with client.db.connect() as conn:
        rows = conn.execute(
            text("SELECT tenant_id FROM tenant_one_pins WHERE user_id = :u"), {"u": user_id}
        ).all()
    return [str(r[0]) for r in rows]


def _user_id(client, who: dict) -> str:
    return client.get("/auth/me", headers=who["h"]).json()["user"]["id"]


def test_an_operator_who_signs_up_later_is_pinned_at_the_first_resolution(org, monkeypatch):
    email = f"p80-later-{uuid4().hex}@example.com"
    assert _tenant_one(org, monkeypatch, email) is None  # no account yet: no pin, no memo

    op = _account(org, email)
    personal = op["default_org"]
    assert _pins(org, _user_id(org, op)) == []
    assert _tenant_one(org, monkeypatch, email) == personal
    assert _pins(org, _user_id(org, op)) == [personal]


def test_concurrent_first_resolutions_write_one_pin(org, monkeypatch):
    import server.api_auth as api_auth
    from server.accounts.service import get_accounts_service

    op = _account(org)
    personal = op["default_org"]
    monkeypatch.setenv("KB_OPERATOR_EMAIL", op["email"])
    _restart()

    async def both():
        return await asyncio.gather(api_auth.get_tenant_one_id(), api_auth.get_tenant_one_id())

    assert [str(t) for t in org.portal.call(both)] == [personal, personal]
    assert _pins(org, _user_id(org, op)) == [personal]

    # Two writers racing with different answers: the first pin stands, and both read it.
    other = _account(org)
    uid = UUID(_user_id(org, other))
    rival = UUID(_new_org(org, other, "Rival"))
    service = get_accounts_service()

    async def race():
        return await asyncio.gather(
            service.pin_tenant_one(uid, UUID(other["default_org"])),
            service.pin_tenant_one(uid, rival),
        )

    first, second = org.portal.call(race)
    assert first == second and str(first) in (other["default_org"], str(rival))
    assert _pins(org, str(uid)) == [str(first)]


# --- 8: legacy mode and no operator: as before -------------------------------------------


def test_legacy_mode_and_no_operator_email_have_no_tenant_one(org, monkeypatch):
    import server.api_auth as api_auth

    monkeypatch.delenv("KB_OPERATOR_EMAIL", raising=False)
    _restart()
    assert org.portal.call(api_auth.get_tenant_one_id) is None

    op = _account(org)
    monkeypatch.setenv("KB_OPERATOR_EMAIL", op["email"])
    monkeypatch.delenv("DATABASE_URL")
    _restart()
    assert asyncio.run(api_auth.get_tenant_one_id()) is None


# --- 6: the migration pins today's tenant #1 ---------------------------------------------


def _scratch_db(prefix: str):
    base = make_url(_RAW_DSN).set(drivername="postgresql+psycopg")
    name = f"{prefix}_{uuid4().hex[:10]}"
    admin = create_engine(base.render_as_string(hide_password=False), isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as conn:
            conn.execute(text(f'CREATE DATABASE "{name}"'))
    except Exception as exc:  # pragma: no cover - environment dependent
        admin.dispose()
        pytest.skip(f"cannot create a scratch database: {exc}")
    return admin, name, base.set(database=name).render_as_string(hide_password=False)


def test_the_pin_migration_backfills_the_operators_first_membership(monkeypatch, capsys):
    """``0017`` on a database at ``0016``: with ``KB_OPERATOR_EMAIL`` naming an account,
    the pin is that account's first membership (by when it joined, not the org's age),
    and one line names the org's id and name, never the email. With no email, or no such
    account, nothing is written. A downgrade drops the table; an upgrade again works."""

    if not _RAW_DSN:
        pytest.skip("set KB_TEST_DATABASE_URL to a disposable Postgres to run the migration test")
    ini = Path(__file__).resolve().parents[1] / "alembic.ini"
    if not ini.is_file():
        pytest.skip("no alembic/ here (the plugin template ships none)")
    from alembic import command
    from alembic.config import Config

    admin, name, url = _scratch_db("kb_pin")
    monkeypatch.setenv("DATABASE_URL", url)
    cfg = Config(str(ini))
    engine = create_engine(url)
    op_id, other = uuid4(), uuid4()
    op_email = f"P80-Op-{uuid4().hex}@Example.com"
    # The operator's sign-up org (joined first); an older org it joined later; another
    # account's org.
    personal, elder, theirs = uuid4(), uuid4(), uuid4()
    tenants = [(personal, "Personal", "2026-11-02"), (elder, "Elder", "2026-10-01"),
               (theirs, "Theirs", "2026-10-02")]
    rows = [
        (personal, op_id, "owner", "2026-11-02"),
        (elder, op_id, "owner", "2026-11-03"),
        (theirs, other, "owner", "2026-10-02"),
    ]
    pins = text("SELECT user_id, tenant_id FROM tenant_one_pins")
    has_table = text("SELECT count(*) FROM pg_tables WHERE tablename = 'tenant_one_pins'")
    try:
        command.upgrade(cfg, "0016_tenant_made_by")
        with engine.begin() as conn:
            for user, email in ((op_id, op_email.lower()), (other, f"{other.hex}@example.com")):
                conn.execute(
                    text("INSERT INTO users (id, email, password_hash) VALUES (:id, :e, 'x')"),
                    {"id": user, "e": email},
                )
            for tenant, tname, day in tenants:
                conn.execute(
                    text("INSERT INTO tenants (id, name, created_at) "
                         "VALUES (:id, :n, CAST(:d AS timestamptz))"),
                    {"id": tenant, "n": tname, "d": day},
                )
            for tenant, user, role, day in rows:
                conn.execute(
                    text(
                        "INSERT INTO tenant_members (id, tenant_id, user_id, role, created_at) "
                        "VALUES (:id, :t, :u, :r, CAST(:d AS timestamptz))"
                    ),
                    {"id": uuid4(), "t": tenant, "u": user, "r": role, "d": day},
                )

        # No KB_OPERATOR_EMAIL: the table, no pin.
        monkeypatch.delenv("KB_OPERATOR_EMAIL", raising=False)
        command.upgrade(cfg, "0017_tenant_one_pin")
        with engine.connect() as conn:
            assert conn.execute(has_table).scalar_one() == 1
            assert conn.execute(pins).all() == []

        # An email that names no account: no pin.
        command.downgrade(cfg, "0016_tenant_made_by")
        monkeypatch.setenv("KB_OPERATOR_EMAIL", f"nobody-{uuid4().hex}@example.com")
        command.upgrade(cfg, "0017_tenant_one_pin")
        with engine.connect() as conn:
            assert conn.execute(pins).all() == []

        # The operator's email (as typed in .env, any case): its first membership.
        command.downgrade(cfg, "0016_tenant_made_by")
        with engine.connect() as conn:
            assert conn.execute(has_table).scalar_one() == 0
        monkeypatch.setenv("KB_OPERATOR_EMAIL", f"  {op_email}  ")
        capsys.readouterr()
        command.upgrade(cfg, "0017_tenant_one_pin")
        said = capsys.readouterr().out
        with engine.connect() as conn:
            assert conn.execute(pins).all() == [(op_id, personal)]
        assert f"tenant #1 pinned to {personal}" in said and '"Personal"' in said, said
        assert op_email.lower() not in said.lower()

        # Down and up again: the same pin.
        command.downgrade(cfg, "0016_tenant_made_by")
        command.upgrade(cfg, "0017_tenant_one_pin")
        with engine.connect() as conn:
            assert conn.execute(pins).all() == [(op_id, personal)]
    finally:
        engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        admin.dispose()
