"""Orgs, members and invites: Postgres-gated.

An account makes orgs (each with one project ``default``) and renames them (owner
only); an owner lists members and pending invites (a member sees members only),
invites an address (one mail with the ``/invite?code=`` link; the code is stored
hashed and lives 7 days) and revokes an invite; anyone holding a code reads the
org's name and the invite's state; a signed-in account whose email is the invited
one accepts and joins as ``member``. Sign-in and sign-up carrying a code approve a
waitlisted (or new) account with the invited address and join it in the same step;
any other address gets today's answer.

Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set, like the other
accounts suites; ``smtplib`` is never reached (the send is monkeypatched). Emails
are uuid-unique, so a reused database never interferes.
"""

from __future__ import annotations

import os
import re
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
PASSWORD = "hunter2pass"
CODE_LINK = re.compile(r"https://kb\.example\.com/invite\?code=(\S+)")


@pytest.fixture
def org(tmp_path, monkeypatch):
    """A TestClient on a Postgres accounts plane, SMTP configured but faked."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the org and invite tests"
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
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "0")
    monkeypatch.delenv("KB_SIGNUP_WAITLIST", raising=False)
    for name in SMTP_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("KB_SMTP_HOST", "smtp.invalid")
    monkeypatch.setenv("KB_SMTP_FROM", "hi@example.com")
    monkeypatch.setenv("KB_PUBLIC_BASE_URL", "https://kb.example.com")

    import server.api_auth as api_auth
    import server.feedback.notify as notify
    import server.persistence.engine as engine_mod

    sent: list = []
    monkeypatch.setattr(notify, "send_message", lambda message: sent.append(message))
    engine_mod._engine = None
    engine_mod._session_maker = None
    api_auth._tenant_one_cache = None

    from server.main import app

    with TestClient(app) as client:
        client.sent = sent  # type: ignore[attr-defined]
        client.db = sync_engine  # type: ignore[attr-defined]
        yield client

    api_auth._tenant_one_cache = None
    engine_mod._engine = None
    engine_mod._session_maker = None
    sync_engine.dispose()


def _email() -> str:
    return f"p78-{uuid4().hex}@example.com"


def _account(client, email: str | None = None) -> dict:
    """An approved account (the waitlist off): its email, token and session header."""

    email = email or _email()
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    return {
        "email": email,
        "token": body["token"],
        "h": {"Authorization": f"Bearer {body['token']}"},
        "default_org": body["tenant"]["id"],
    }


def _in(headers: dict, org_id: str) -> dict:
    return {**headers, "X-Sikstack-Org": org_id}


def _new_org(client, who: dict, name: str = "Acme") -> str:
    res = client.post("/app/orgs", json={"name": name}, headers=who["h"])
    assert res.status_code == 201, res.text
    return res.json()["tenant"]["id"]


def _invite(client, owner: dict, org_id: str, email: str) -> str:
    """Invite ``email`` into ``org_id``; the code, read from the one mail sent."""

    client.sent.clear()
    res = client.post("/app/invites", json={"email": email}, headers=_in(owner["h"], org_id))
    assert res.status_code == 201, res.text
    assert len(client.sent) == 1
    match = CODE_LINK.search(client.sent[0].get_content())
    assert match, client.sent[0].get_content()
    client.sent.clear()
    return match.group(1)


def _waitlisted(client, monkeypatch, email: str) -> None:
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text
    monkeypatch.delenv("KB_SIGNUP_WAITLIST")
    client.sent.clear()


def _status(client, email: str) -> str:
    with client.db.connect() as conn:
        return conn.execute(
            text("SELECT status FROM users WHERE email = :e"), {"e": email}
        ).scalar_one()


def _role(client, org_id: str, email: str) -> str | None:
    with client.db.connect() as conn:
        return conn.execute(
            text(
                "SELECT m.role FROM tenant_members m JOIN users u ON u.id = m.user_id "
                "WHERE m.tenant_id = :t AND u.email = :e"
            ),
            {"t": org_id, "e": email},
        ).scalar_one_or_none()


# --- C1: create an org ------------------------------------------------------------


def test_create_org_makes_tenant_owner_and_one_project(org):
    me = _account(org)
    res = org.post("/app/orgs", json={"name": "  Acme Labs  "}, headers=me["h"])
    assert res.status_code == 201, res.text
    body = res.json()
    new_id = body["tenant"]["id"]
    assert body["tenant"]["name"] == "Acme Labs"
    assert body["project"]["name"] == "default" and body["project"]["tenant_id"] == new_id
    assert _role(org, new_id, me["email"]) == "owner"
    with org.db.connect() as conn:
        assert conn.execute(
            text("SELECT count(*) FROM projects WHERE tenant_id = :t"), {"t": new_id}
        ).scalar_one() == 1

    who = org.get("/auth/me", headers=me["h"]).json()
    assert [t["id"] for t in who["tenants"]] == [me["default_org"], new_id]
    assert who["active_tenant_id"] == me["default_org"]
    switched = org.get("/auth/me", headers=_in(me["h"], new_id)).json()
    assert switched["active_tenant_id"] == new_id
    projects = org.get("/app/projects", headers=_in(me["h"], new_id)).json()["projects"]
    assert [p["name"] for p in projects] == ["default"]


def test_create_org_refuses_a_bad_or_taken_name(org):
    me = _account(org)
    for name in ["", "   ", "x" * 101, "a\nb"]:
        res = org.post("/app/orgs", json={"name": name}, headers=me["h"])
        assert res.status_code == 422, (name, res.text)
    # Every account has an org named "default": a second one is taken, in any case.
    taken = org.post("/app/orgs", json={"name": "Default"}, headers=me["h"])
    assert taken.status_code == 409 and taken.json()["reason"] == "taken"
    assert org.post("/app/orgs", json={"name": "x" * 100}, headers=me["h"]).status_code == 201
    assert org.post("/app/orgs", json={"name": "Acme"}).status_code == 401


# --- C2: rename -------------------------------------------------------------------


def test_owner_renames_member_is_refused_and_bad_names_are_refused(org):
    owner, member = _account(org), _account(org)
    org_id = _new_org(org, owner)
    code = _invite(org, owner, org_id, member["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=member["h"]).status_code == 200

    res = org.patch("/app/tenant/name", json={"name": " Acme Two "}, headers=_in(owner["h"], org_id))
    assert res.status_code == 200, res.text
    assert res.json()["tenant"]["name"] == "Acme Two"
    assert org.get("/app/tenant", headers=_in(owner["h"], org_id)).json()["tenant"]["name"] == "Acme Two"

    refused = org.patch("/app/tenant/name", json={"name": "Mine"}, headers=_in(member["h"], org_id))
    assert refused.status_code == 403
    for name in ["", "  ", "y" * 101]:
        bad = org.patch("/app/tenant/name", json={"name": name}, headers=_in(owner["h"], org_id))
        assert bad.status_code == 422, (name, bad.text)
    with org.db.connect() as conn:
        assert conn.execute(
            text("SELECT name FROM tenants WHERE id = :t"), {"t": org_id}
        ).scalar_one() == "Acme Two"


# --- C3: members ------------------------------------------------------------------


def test_owner_sees_members_and_pending_invites_member_sees_members_only(org):
    owner, member = _account(org), _account(org)
    org_id = _new_org(org, owner)
    code = _invite(org, owner, org_id, member["email"])
    org.post(f"/app/invite/{code}/accept", headers=member["h"])
    pending = _email()
    _invite(org, owner, org_id, pending)

    seen = org.get("/app/members", headers=_in(owner["h"], org_id))
    assert seen.status_code == 200, seen.text
    body = seen.json()
    assert body["role"] == "owner"
    assert [(m["email"], m["role"]) for m in body["members"]] == [
        (owner["email"], "owner"),
        (member["email"], "member"),
    ]
    assert all(set(m) == {"id", "email", "role", "joined_at"} for m in body["members"])
    assert [i["email"] for i in body["invites"]] == [pending]
    assert set(body["invites"][0]) == {"id", "email", "invited_at", "expires_at"}

    as_member = org.get("/app/members", headers=_in(member["h"], org_id)).json()
    assert as_member["role"] == "member"
    assert len(as_member["members"]) == 2
    assert "invites" not in as_member


# --- C4: invite -------------------------------------------------------------------


def test_invite_mails_one_link_stores_a_hash_and_lasts_seven_days(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Mail Org")
    invited = _email()
    res = org.post(
        "/app/invites", json={"email": f"  {invited.upper()} "}, headers=_in(owner["h"], org_id)
    )
    assert res.status_code == 201, res.text
    invite = res.json()["invite"]
    assert invite["email"] == invited
    assert "code" not in invite and "token_hash" not in invite

    assert len(org.sent) == 1
    mail = org.sent[0]
    assert mail["To"] == invited and mail["From"] == "hi@example.com"
    assert "Mail Org" in mail["Subject"] or "Mail Org" in mail.get_content()
    code = CODE_LINK.search(mail.get_content()).group(1)

    from server.accounts.security import sha256_hex

    with org.db.connect() as conn:
        row = conn.execute(
            text("SELECT token_hash, created_at, expires_at, role FROM org_invites WHERE id = :i"),
            {"i": invite["id"]},
        ).one()
    assert row.token_hash == sha256_hex(code) and code not in row.token_hash
    assert row.expires_at - row.created_at == timedelta(days=7)
    assert row.role == "member"


def test_invite_refusals_and_owner_only(org):
    owner, member = _account(org), _account(org)
    org_id = _new_org(org, owner)
    code = _invite(org, owner, org_id, member["email"])
    org.post(f"/app/invite/{code}/accept", headers=member["h"])
    pending = _email()
    _invite(org, owner, org_id, pending)
    h = _in(owner["h"], org_id)

    for bad in ["hana@example", "not an address", "a@b.com, c@d.com", ""]:
        res = org.post("/app/invites", json={"email": bad}, headers=h)
        assert res.status_code == 422 and res.json()["reason"] == "address", (bad, res.text)
    as_member = org.post("/app/invites", json={"email": member["email"].upper()}, headers=h)
    assert as_member.status_code == 409 and as_member.json()["reason"] == "member"
    again = org.post("/app/invites", json={"email": pending}, headers=h)
    assert again.status_code == 409 and again.json()["reason"] == "invited"
    assert org.sent == []

    by_member = org.post("/app/invites", json={"email": _email()}, headers=_in(member["h"], org_id))
    assert by_member.status_code == 403
    assert org.sent == []


def test_an_expired_invite_no_longer_blocks_a_new_one(org):
    owner = _account(org)
    org_id = _new_org(org, owner)
    invited = _email()
    code = _invite(org, owner, org_id, invited)
    with org.db.begin() as conn:
        conn.execute(
            text("UPDATE org_invites SET expires_at = now() - interval '1 minute' WHERE email = :e"),
            {"e": invited},
        )
    assert org.get(f"/app/invite/{code}").json()["state"] == "expired"
    assert _invite(org, owner, org_id, invited)


# --- C5: revoke -------------------------------------------------------------------


def test_revoke_is_owner_only_and_a_revoked_code_cannot_be_accepted(org):
    owner, member = _account(org), _account(org)
    org_id = _new_org(org, owner)
    mcode = _invite(org, owner, org_id, member["email"])
    org.post(f"/app/invite/{mcode}/accept", headers=member["h"])
    invitee = _account(org)
    code = _invite(org, owner, org_id, invitee["email"])
    (invite,) = org.get("/app/members", headers=_in(owner["h"], org_id)).json()["invites"]

    refused = org.delete(f"/app/invites/{invite['id']}", headers=_in(member["h"], org_id))
    assert refused.status_code == 403
    # Another org's owner cannot reach it either.
    assert org.delete(f"/app/invites/{invite['id']}", headers=invitee["h"]).status_code == 404

    assert org.delete(f"/app/invites/{invite['id']}", headers=_in(owner["h"], org_id)).status_code == 204
    assert org.get("/app/members", headers=_in(owner["h"], org_id)).json()["invites"] == []
    assert org.get(f"/app/invite/{code}").json()["state"] == "revoked"
    res = org.post(f"/app/invite/{code}/accept", headers=invitee["h"])
    assert res.status_code == 410 and res.json()["state"] == "revoked"
    assert _role(org, org_id, invitee["email"]) is None


# --- C6: the read by code ---------------------------------------------------------


def test_the_read_by_code_shows_the_org_name_and_state_only(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Read Org")
    invited = _email()
    code = _invite(org, owner, org_id, invited)

    out = org.get(f"/app/invite/{code}")
    assert out.status_code == 200, out.text
    # The signed design draws the invited address and the inviter on a valid code.
    assert out.json() == {
        "state": "valid",
        "org": {"name": "Read Org"},
        "email": invited,
        "invited_by": owner["email"],
    }
    assert org.get("/app/invite/nope-not-a-code").status_code == 404

    invitee = _account(org, invited)
    org.post(f"/app/invite/{code}/accept", headers=invitee["h"])
    used = org.get(f"/app/invite/{code}")
    assert used.status_code == 200 and used.json() == {"state": "used", "org": {"name": "Read Org"}}

    # Signed in, the read also says whether the caller is a member already.
    inside = org.get(f"/app/invite/{code}", headers=invitee["h"]).json()
    assert inside["state"] == "used" and inside["member"] is True and inside["org"]["id"] == org_id


def test_the_signed_out_read_is_rate_limited(org, monkeypatch):
    monkeypatch.setenv("KB_INSTALL_RATE_LIMIT", "2")
    monkeypatch.setenv("KB_INSTALL_RATE_WINDOW_S", "900")
    import server.installs_api as installs_api

    installs_api._rate_windows.clear()
    headers = {"X-Real-IP": f"203.0.113.{uuid4().int % 250}"}
    statuses = [org.get(f"/app/invite/x{n}", headers=headers).status_code for n in range(3)]
    assert statuses == [404, 404, 429]
    installs_api._rate_windows.clear()


# --- C7: accept -------------------------------------------------------------------


def test_accept_joins_as_member_other_account_refused_twice_harmless(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Join Org")
    invitee, other = _account(org), _account(org)
    code = _invite(org, owner, org_id, invitee["email"])

    wrong = org.post(f"/app/invite/{code}/accept", headers=other["h"])
    assert wrong.status_code == 403 and wrong.json()["reason"] == "other"
    assert _role(org, org_id, other["email"]) is None

    res = org.post(f"/app/invite/{code}/accept", headers=invitee["h"])
    assert res.status_code == 200, res.text
    assert res.json()["state"] == "joined" and res.json()["tenant"]["id"] == org_id
    assert _role(org, org_id, invitee["email"]) == "member"
    tenants = org.get("/auth/me", headers=invitee["h"]).json()["tenants"]
    assert org_id in [t["id"] for t in tenants]

    again = org.post(f"/app/invite/{code}/accept", headers=invitee["h"])
    assert again.status_code == 200 and again.json()["state"] == "member"
    assert _role(org, org_id, invitee["email"]) == "member"
    assert org.get("/app/members", headers=_in(owner["h"], org_id)).json()["invites"] == []
    # The used code is spent for anyone else too.
    assert org.post(f"/app/invite/{code}/accept", headers=other["h"]).status_code == 410


# --- C8: the waitlisted invitee ---------------------------------------------------


def test_waitlisted_invitee_signing_in_with_the_code_is_approved_and_joined(org, monkeypatch):
    owner = _account(org)
    org_id = _new_org(org, owner, "Waitlist Org")
    invited = _email()
    _waitlisted(org, monkeypatch, invited)
    code = _invite(org, owner, org_id, invited)

    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    plain = org.post("/auth/login", json={"email": invited, "password": PASSWORD})
    assert plain.status_code == 403  # without the code: today's answer

    res = org.post("/auth/login", json={"email": invited, "password": PASSWORD, "invite": code})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["token"] and body["joined"]["id"] == org_id
    assert org_id in [t["id"] for t in body["tenants"]]
    assert _status(org, invited) == "approved"
    assert _role(org, org_id, invited) == "member"
    me = org.get("/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200


def test_the_code_with_another_email_leaves_that_account_waitlisted(org, monkeypatch):
    owner = _account(org)
    org_id = _new_org(org, owner)
    code = _invite(org, owner, org_id, _email())
    stranger = _email()
    _waitlisted(org, monkeypatch, stranger)

    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    res = org.post("/auth/login", json={"email": stranger, "password": PASSWORD, "invite": code})
    assert res.status_code == 403 and res.json()["status"] == "waitlisted"
    assert "token" not in res.json()
    assert _status(org, stranger) == "waitlisted"
    assert _role(org, org_id, stranger) is None

    # A sign-up with someone else's code is waitlisted as today.
    newcomer = _email()
    up = org.post("/auth/signup", json={"email": newcomer, "password": PASSWORD, "invite": code})
    assert up.status_code == 202 and up.json() == {"status": "waitlisted", "email": newcomer}
    assert _status(org, newcomer) == "waitlisted"
    assert _role(org, org_id, newcomer) is None
    assert org.get(f"/app/invite/{code}").json()["state"] == "valid"


def test_signup_with_the_code_skips_the_waitlist_and_joins(org, monkeypatch):
    owner = _account(org)
    org_id = _new_org(org, owner, "Signup Org")
    invited = _email()
    code = _invite(org, owner, org_id, invited)

    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    res = org.post("/auth/signup", json={"email": invited, "password": PASSWORD, "invite": code})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["token"] and body["joined"]["id"] == org_id
    assert _status(org, invited) == "approved"
    assert _role(org, org_id, invited) == "member"
    assert org.sent == []  # no waitlist mail and no alert: it is not waitlisted
    assert org.get(f"/app/invite/{code}").json()["state"] == "used"


# --- owner-only org writes: the Public URL and org API keys ---------------------------


def test_org_level_writes_are_the_owners_alone(org):
    """A member is refused (403) on every org-level write; the owner still succeeds.

    The org's Public URL (``PATCH /app/tenant``), its org API keys (``POST`` and
    ``DELETE /app/credentials``), its name and its invites belong to the owner. A
    member keeps the project-level work: projects and project keys.
    """

    owner, member = _account(org), _account(org)
    org_id = _new_org(org, owner)
    code = _invite(org, owner, org_id, member["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=member["h"]).status_code == 200
    as_owner, as_member = _in(owner["h"], org_id), _in(member["h"], org_id)
    slug = f"p78-{uuid4().hex[:12]}"

    # The Public URL: a member's claim changes nothing.
    refused = org.patch("/app/tenant", json={"slug": slug}, headers=as_member)
    assert refused.status_code == 403, refused.text
    with org.db.connect() as conn:
        assert conn.execute(
            text("SELECT slug FROM tenants WHERE id = :t"), {"t": org_id}
        ).scalar_one() is None
    claimed = org.patch("/app/tenant", json={"slug": slug}, headers=as_owner)
    assert claimed.status_code == 200 and claimed.json()["tenant"]["slug"] == slug

    # Org API keys: a member mints none and revokes none.
    minted = org.post("/app/credentials", json={"name": "ci"}, headers=as_owner)
    assert minted.status_code == 201, minted.text
    key_id = minted.json()["credential"]["id"]
    assert org.post("/app/credentials", json={"name": "mine"}, headers=as_member).status_code == 403
    assert org.delete(f"/app/credentials/{key_id}", headers=as_member).status_code == 403
    keys = org.get("/app/credentials", headers=as_owner).json()["credentials"]
    assert [(k["name"], k["revoked_at"]) for k in keys] == [("ci", None)]
    assert org.delete(f"/app/credentials/{key_id}", headers=as_owner).status_code == 204

    # The name and invites, owner-only since they were built.
    assert org.patch("/app/tenant/name", json={"name": "Mine"}, headers=as_member).status_code == 403
    assert org.post("/app/invites", json={"email": _email()}, headers=as_member).status_code == 403

    # Project-level work stays a member's.
    made = org.post("/app/projects", json={"name": "member-work"}, headers=as_member)
    assert made.status_code == 201, made.text
    project_id = made.json()["project"]["id"]
    key = org.post(f"/app/projects/{project_id}/credentials", json={"name": "k"}, headers=as_member)
    assert key.status_code == 201, key.text


# --- invite mail is bounded ----------------------------------------------------------------


def _backdate(client, sql: str, params: dict) -> None:
    with client.db.begin() as conn:
        conn.execute(text(sql), params)


def _age_invites_by(client, email: str, interval: str) -> None:
    """Move every invite ``email`` sent back by ``interval`` (a Postgres interval)."""

    _backdate(
        client,
        "UPDATE org_invites SET created_at = created_at - CAST(:i AS interval) "
        "WHERE invited_by = (SELECT id FROM users WHERE email = :e)",
        {"i": interval, "e": email},
    )


def test_an_inviter_sends_at_most_10_invite_mails_an_hour_and_30_a_day(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Busy Org")
    h = _in(owner["h"], org_id)
    org.sent.clear()

    def send(n: int) -> list:
        return [org.post("/app/invites", json={"email": _email()}, headers=h) for _ in range(n)]

    assert [r.status_code for r in send(10)] == [201] * 10
    over = org.post("/app/invites", json={"email": _email()}, headers=h)
    assert over.status_code == 429 and over.json()["reason"] == "limit", over.text
    assert len(org.sent) == 10

    # An hour on, ten more; again; then the day's 30 are spent.
    _age_invites_by(org, owner["email"], "61 minutes")
    assert [r.status_code for r in send(11)] == [201] * 10 + [429]
    _age_invites_by(org, owner["email"], "61 minutes")
    assert [r.status_code for r in send(10)] == [201] * 10
    _age_invites_by(org, owner["email"], "61 minutes")
    day = org.post("/app/invites", json={"email": _email()}, headers=h)
    assert day.status_code == 429 and day.json()["reason"] == "limit"
    assert len(org.sent) == 30

    # A day on, the inviter sends again.
    _age_invites_by(org, owner["email"], "1 day")
    assert send(1)[0].status_code == 201


def test_one_address_gets_at_most_3_invite_mails_a_day_across_orgs(org):
    target = _email()
    owners = [_account(org) for _ in range(4)]
    answers = []
    for owner in owners:
        org_id = _new_org(org, owner, "Some Org")
        org.sent.clear()
        answers.append(
            org.post("/app/invites", json={"email": target}, headers=_in(owner["h"], org_id))
        )
    assert [r.status_code for r in answers] == [201, 201, 201, 429]
    assert answers[-1].json()["reason"] == "recipient"
    assert org.sent == []


def test_revoke_and_resend_counts_against_the_limits(org):
    """The code read's repro: 40 send/revoke cycles to one address mail it 3 times."""

    owner = _account(org)
    org_id = _new_org(org, owner, "Loop Org")
    h = _in(owner["h"], org_id)
    victim = _email()
    org.sent.clear()
    statuses = []
    for _ in range(40):
        res = org.post("/app/invites", json={"email": victim}, headers=h)
        statuses.append(res.status_code)
        if res.status_code == 201:
            invite_id = res.json()["invite"]["id"]
            assert org.delete(f"/app/invites/{invite_id}", headers=h).status_code == 204
    assert statuses.count(201) == 3 and statuses.count(429) == 37
    assert [m["To"] for m in org.sent] == [victim] * 3


def test_an_account_makes_at_most_10_new_orgs_a_day(org):
    """The code read's repro: 30 new orgs with an invite each make 10 orgs and 10 mails."""

    me = _account(org)
    org.sent.clear()
    made, refused = [], []
    for n in range(30):
        res = org.post("/app/orgs", json={"name": f"Spam {n}"}, headers=me["h"])
        if res.status_code == 201:
            made.append(res.json()["tenant"]["id"])
        else:
            refused.append(res)
    assert len(made) == 10 and len(refused) == 20
    assert all(r.status_code == 429 and r.json()["reason"] == "limit" for r in refused)
    for org_id in made:
        org.post("/app/invites", json={"email": _email()}, headers=_in(me["h"], org_id))
    assert len(org.sent) == 10

    # A day on, the account makes orgs again (its sign-up org never counted).
    _backdate(
        org,
        "UPDATE tenants SET created_at = created_at - interval '1 day' WHERE id IN "
        "(SELECT tenant_id FROM tenant_members "
        "WHERE user_id = (SELECT id FROM users WHERE email = :e))",
        {"e": me["email"]},
    )
    _backdate(
        org,
        "UPDATE tenant_members SET created_at = created_at - interval '1 day' "
        "WHERE user_id = (SELECT id FROM users WHERE email = :e)",
        {"e": me["email"]},
    )
    assert org.post("/app/orgs", json={"name": "Later"}, headers=me["h"]).status_code == 201


def test_the_invite_subject_names_no_org_and_the_body_holds_it_as_plain_data(org):
    owner = _account(org)
    bait = "Your account is locked - verify at evil.example now"
    org_id = _new_org(org, owner, bait)
    org.sent.clear()
    invited = _email()
    res = org.post("/app/invites", json={"email": invited}, headers=_in(owner["h"], org_id))
    assert res.status_code == 201, res.text
    (mail,) = org.sent
    assert bait not in mail["Subject"] and "evil" not in mail["Subject"]
    assert mail["Subject"] == "You're invited to an org on sikstack"
    body = mail.get_content()
    assert f"Org: {bait}\n" in body and f"Invited by: {owner['email']}\n" in body
    assert mail.get_content_type() == "text/plain"
    # The only link is the invite's own.
    assert re.findall(r"https?://\S+", body) == [CODE_LINK.search(body).group(0)]


# --- membership ends -------------------------------------------------------------------------


def _member_id(client, owner: dict, org_id: str, email: str) -> str:
    members = client.get("/app/members", headers=_in(owner["h"], org_id)).json()["members"]
    return next(m["id"] for m in members if m["email"] == email)


def _joined(client, owner: dict, org_id: str) -> dict:
    member = _account(client)
    code = _invite(client, owner, org_id, member["email"])
    assert client.post(f"/app/invite/{code}/accept", headers=member["h"]).status_code == 200
    return member


def test_the_owner_removes_a_member_and_access_ends_at_once(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Remove Org")
    member = _joined(org, owner, org_id)
    as_member = _in(member["h"], org_id)
    assert org.get("/app/projects", headers=as_member).status_code == 200
    mid = _member_id(org, owner, org_id, member["email"])

    # A member removes no one; another org's owner cannot reach the row.
    other_owner = _account(org)
    assert org.delete(f"/app/members/{mid}", headers=as_member).status_code == 403
    assert org.delete(f"/app/members/{mid}", headers=other_owner["h"]).status_code == 404
    assert org.delete(f"/app/members/{uuid4()}", headers=_in(owner["h"], org_id)).status_code == 404

    assert org.delete(f"/app/members/{mid}", headers=_in(owner["h"], org_id)).status_code == 204
    assert _role(org, org_id, member["email"]) is None
    # The next request in that org is refused; the account acts in its own org again.
    assert org.get("/app/projects", headers=as_member).status_code == 403
    assert org.get("/auth/me", headers=as_member).status_code == 403
    me = org.get("/auth/me", headers=member["h"]).json()
    assert org_id not in [t["id"] for t in me["tenants"]]
    assert me["active_tenant_id"] == member["default_org"]
    listed = org.get("/app/members", headers=_in(owner["h"], org_id)).json()["members"]
    assert [m["email"] for m in listed] == [owner["email"]]
    # Removing twice is a 404; the address may be invited again.
    assert org.delete(f"/app/members/{mid}", headers=_in(owner["h"], org_id)).status_code == 404
    assert _invite(org, owner, org_id, member["email"])


def test_a_member_leaves_and_the_last_owner_can_neither_leave_nor_be_removed(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Leave Org")
    member = _joined(org, owner, org_id)
    as_member, as_owner = _in(member["h"], org_id), _in(owner["h"], org_id)

    left = org.post("/app/tenant/leave", headers=as_member)
    assert left.status_code == 204, left.text
    assert _role(org, org_id, member["email"]) is None
    assert org.get("/app/members", headers=as_member).status_code == 403

    refused = org.post("/app/tenant/leave", headers=as_owner)
    assert refused.status_code == 409 and refused.json()["reason"] == "last_owner"
    oid = _member_id(org, owner, org_id, owner["email"])
    removed = org.delete(f"/app/members/{oid}", headers=as_owner)
    assert removed.status_code == 409 and removed.json()["reason"] == "last_owner"
    assert _role(org, org_id, owner["email"]) == "owner"
    # A sign-up org has one owner too: its owner never leaves it.
    own = org.post("/app/tenant/leave", headers=owner["h"])
    assert own.status_code == 409 and own.json()["reason"] == "last_owner"


# --- owners hand an org over -------------------------------------------------------------------


def _joined_at(client, org_id: str, email: str):
    with client.db.connect() as conn:
        return conn.execute(
            text(
                "SELECT m.created_at FROM tenant_members m JOIN users u ON u.id = m.user_id "
                "WHERE m.tenant_id = :t AND u.email = :e"
            ),
            {"t": org_id, "e": email},
        ).scalar_one()


def _promote(client, owner: dict, org_id: str, email: str):
    mid = _member_id(client, owner, org_id, email)
    return client.post(f"/app/members/{mid}/owner", headers=_in(owner["h"], org_id))


def _co_owned(client) -> tuple[dict, dict, str]:
    """An account whose only org is its sign-up org, and a second account made its co-owner."""

    first = _account(client)
    org_id = first["default_org"]
    second = _joined(client, first, org_id)
    assert _promote(client, first, org_id, second["email"]).status_code == 204
    return first, second, org_id


def test_an_owner_makes_a_member_an_owner(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Promote Org")
    member = _joined(org, owner, org_id)
    as_member, as_owner = _in(member["h"], org_id), _in(owner["h"], org_id)
    mid = _member_id(org, owner, org_id, member["email"])
    joined = _joined_at(org, org_id, member["email"])

    # A member promotes no one, itself included; another org's owner cannot reach the row.
    assert org.post(f"/app/members/{mid}/owner", headers=as_member).status_code == 403
    other_owner = _account(org)
    assert org.post(f"/app/members/{mid}/owner", headers=other_owner["h"]).status_code == 404
    assert org.post(f"/app/members/{uuid4()}/owner", headers=as_owner).status_code == 404
    assert _role(org, org_id, member["email"]) == "member"
    assert org.post(f"/app/members/{mid}/owner").status_code == 401

    done = org.post(f"/app/members/{mid}/owner", headers=as_owner)
    assert done.status_code == 204, done.text
    assert _role(org, org_id, member["email"]) == "owner"
    assert _joined_at(org, org_id, member["email"]) == joined
    listed = org.get("/app/members", headers=as_owner).json()["members"]
    assert [(m["email"], m["role"]) for m in listed] == [
        (owner["email"], "owner"),
        (member["email"], "owner"),
    ]
    # The new owner acts as one at once: it lists the invites and sends one.
    assert "invites" in org.get("/app/members", headers=as_member).json()
    assert _invite(org, member, org_id, _email())

    # Promoting an owner (twice, or the caller's own row) is a success that changes nothing.
    assert org.post(f"/app/members/{mid}/owner", headers=as_owner).status_code == 204
    oid = _member_id(org, owner, org_id, owner["email"])
    assert org.post(f"/app/members/{oid}/owner", headers=as_owner).status_code == 204
    assert _role(org, org_id, member["email"]) == "owner"
    assert _role(org, org_id, owner["email"]) == "owner"
    assert _joined_at(org, org_id, member["email"]) == joined


def test_a_co_owner_leaves_and_the_last_owner_still_cannot(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Handover Org")
    heir = _joined(org, owner, org_id)
    assert _promote(org, owner, org_id, heir["email"]).status_code == 204

    left = org.post("/app/tenant/leave", headers=_in(owner["h"], org_id))
    assert left.status_code == 204, left.text
    assert _role(org, org_id, owner["email"]) is None
    assert org.get("/app/members", headers=_in(owner["h"], org_id)).status_code == 403
    me = org.get("/auth/me", headers=owner["h"]).json()
    assert org_id not in [t["id"] for t in me["tenants"]]

    refused = org.post("/app/tenant/leave", headers=_in(heir["h"], org_id))
    assert refused.status_code == 409 and refused.json()["reason"] == "last_owner"
    assert _role(org, org_id, heir["email"]) == "owner"


def test_no_account_leaves_or_is_removed_from_its_only_org(org):
    # An owner row: the sign-up org is the account's only one, and it has a co-owner.
    first, second, org_id = _co_owned(org)
    as_first, as_second = _in(first["h"], org_id), _in(second["h"], org_id)
    left = org.post("/app/tenant/leave", headers=as_first)
    assert left.status_code == 409 and left.json()["reason"] == "last_org"
    fid = _member_id(org, second, org_id, first["email"])
    removed = org.delete(f"/app/members/{fid}", headers=as_second)
    assert removed.status_code == 409 and removed.json()["reason"] == "last_org"
    assert _role(org, org_id, first["email"]) == "owner"

    # A member row: the account joined another org, then left its sign-up org.
    joined_id = second["default_org"]
    code = _invite(org, second, joined_id, first["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=first["h"]).status_code == 200
    assert org.post("/app/tenant/leave", headers=as_first).status_code == 204
    me = org.get("/auth/me", headers=first["h"]).json()
    assert [t["id"] for t in me["tenants"]] == [joined_id]
    left = org.post("/app/tenant/leave", headers=_in(first["h"], joined_id))
    assert left.status_code == 409 and left.json()["reason"] == "last_org"
    mid = _member_id(org, second, joined_id, first["email"])
    removed = org.delete(f"/app/members/{mid}", headers=_in(second["h"], joined_id))
    assert removed.status_code == 409 and removed.json()["reason"] == "last_org"
    assert _role(org, joined_id, first["email"]) == "member"
    # The last owner's refusal is checked first, as before.
    lone = org.post("/app/tenant/leave", headers=as_second)
    assert lone.status_code == 409 and lone.json()["reason"] == "last_owner"


def test_leaving_two_orgs_back_to_back_keeps_the_last(org):
    first, second, org_id = _co_owned(org)
    joined_id = second["default_org"]
    code = _invite(org, second, joined_id, first["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=first["h"]).status_code == 200

    assert org.post("/app/tenant/leave", headers=_in(first["h"], org_id)).status_code == 204
    second_leave = org.post("/app/tenant/leave", headers=_in(first["h"], joined_id))
    assert second_leave.status_code == 409 and second_leave.json()["reason"] == "last_org"
    assert _role(org, joined_id, first["email"]) == "member"


def test_a_leave_waits_on_the_accounts_other_membership_and_counts_after_it(org):
    """Two leaves from two orgs at once: the second waits on the account's row in the first's
    org, which the first holds, and counts the account's rows after it commits. The first leave
    is replayed by hand in a transaction of the test's own: a lock on its org's rows only (the
    account's row there among them; a leave locks more), then its delete, committed only once
    the request waits on the lock. A leave that locked only its own org's rows would not wait."""

    import threading
    import time

    first, second, org_id = _co_owned(org)
    joined_id = second["default_org"]
    code = _invite(org, second, joined_id, first["email"])
    assert org.post(f"/app/invite/{code}/accept", headers=first["h"]).status_code == 200
    with org.db.connect() as conn:
        user_id = conn.execute(
            text("SELECT id FROM users WHERE email = :e"), {"e": first["email"]}
        ).scalar_one()

    answers: dict[str, object] = {}
    with org.db.connect() as other_leave:
        held = other_leave.begin()
        other_leave.execute(
            text("SELECT id FROM tenant_members WHERE tenant_id = :t ORDER BY id FOR UPDATE"),
            {"t": org_id},
        )

        def act() -> None:
            answers["res"] = org.post("/app/tenant/leave", headers=_in(first["h"], joined_id))

        worker = threading.Thread(target=act)
        worker.start()
        waiting, until = 0, time.monotonic() + 15
        while waiting == 0 and time.monotonic() < until and worker.is_alive():
            with org.db.connect() as watch:
                waiting = watch.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                        "AND wait_event_type = 'Lock'"
                    )
                ).scalar_one()
            time.sleep(0.02)
        assert waiting, "the leave never waited on the account's other membership"
        other_leave.execute(
            text("DELETE FROM tenant_members WHERE tenant_id = :t AND user_id = :u"),
            {"t": org_id, "u": user_id},
        )
        held.commit()
    worker.join(30)
    assert not worker.is_alive()
    res = answers["res"]
    assert res.status_code == 409 and res.json()["reason"] == "last_org", res.text
    assert _role(org, joined_id, first["email"]) == "member"


def test_a_promoted_account_still_makes_its_new_orgs_for_the_day(org):
    owner = _account(org)
    promoted = _joined(org, owner, owner["default_org"])
    assert _promote(org, owner, owner["default_org"], promoted["email"]).status_code == 204
    statuses = [
        org.post("/app/orgs", json={"name": f"Mine {n}"}, headers=promoted["h"]).status_code
        for n in range(11)
    ]
    assert statuses == [201] * 10 + [429]


# --- publishing is an org act ----------------------------------------------------------------


def test_a_projects_visibility_is_the_owners_alone(org):
    owner = _account(org)
    org_id = _new_org(org, owner, "Publish Org")
    member = _joined(org, owner, org_id)
    as_member, as_owner = _in(member["h"], org_id), _in(owner["h"], org_id)
    made = org.post("/app/projects", json={"name": "shared"}, headers=as_member)
    assert made.status_code == 201, made.text
    project_id = made.json()["project"]["id"]

    for visibility in ("public", "private"):
        refused = org.patch(
            f"/app/projects/{project_id}", json={"visibility": visibility}, headers=as_member
        )
        assert refused.status_code == 403, refused.text
    assert org.get(f"/app/projects/{project_id}", headers=as_owner).json()["project"][
        "visibility"
    ] == "private"
    for visibility in ("public", "private"):
        done = org.patch(
            f"/app/projects/{project_id}", json={"visibility": visibility}, headers=as_owner
        )
        assert done.status_code == 200 and done.json()["project"]["visibility"] == visibility
