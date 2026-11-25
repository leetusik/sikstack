"""Password reset and the signed-in password change: Postgres-gated.

``POST /auth/password/forgot`` answers the same whether or not the address has an
account and mails a one-use, one-hour ``/reset?code=`` link only to an account;
``POST /auth/password/reset`` sets a new password by that code and ends every
session of the account; ``POST /auth/password/change`` needs the current password
and ends every other session. Rate-limited per address and per client; a waitlisted
account's reset never gets it a session.

Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set, like the other
accounts suites; ``smtplib`` is never reached (the send is monkeypatched), so the
mail is proven by the rendered message. Emails are uuid-unique.
"""

from __future__ import annotations

import os
import re
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

from server.accounts.security import sha256_hex

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
PASSWORD = "hunter2pass"
NEW_PASSWORD = "correct-horse-9"
RESET_LINK = re.compile(r"https://kb\.example\.com/reset\?code=(\S+)")


@pytest.fixture
def kb(tmp_path, monkeypatch):
    """A TestClient on a Postgres accounts plane, SMTP configured but faked."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the password reset tests"
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
    import server.auth_api as auth_api
    import server.feedback.notify as notify
    import server.persistence.engine as engine_mod

    sent: list = []
    monkeypatch.setattr(notify, "send_message", lambda message: sent.append(message))
    monkeypatch.setattr(auth_api, "_rate_windows", {})
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
    return f"p78-reset-{uuid4().hex}@example.com"


def _account(client, email: str | None = None) -> dict:
    email = email or _email()
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    token = res.json()["token"]
    return {"email": email, "token": token, "h": {"Authorization": f"Bearer {token}"}}


def _login(client, email: str, password: str):
    return client.post("/auth/login", json={"email": email, "password": password})


def _session(client, email: str, password: str = PASSWORD) -> dict:
    res = _login(client, email, password)
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


def _forgot(client, email: str):
    return client.post("/auth/password/forgot", json={"email": email})


def _code(client, email: str) -> str:
    """Ask a reset for ``email``; the code, read from the one mail it sent."""

    client.sent.clear()
    assert _forgot(client, email).status_code == 202
    assert len(client.sent) == 1
    match = RESET_LINK.search(client.sent[0].get_content())
    assert match, client.sent[0].get_content()
    client.sent.clear()
    return match.group(1)


def _reset(client, code: str, password: str = NEW_PASSWORD):
    return client.post("/auth/password/reset", json={"code": code, "password": password})


# --- C1: the same answer whatever the address; one mail, only to an account -------------


def test_forgot_answers_the_same_and_mails_only_an_account(kb):
    me = _account(kb)
    kb.sent.clear()

    known = _forgot(kb, me["email"].upper())
    unknown = _forgot(kb, _email())
    assert known.status_code == unknown.status_code == 202
    assert known.json() == unknown.json()
    assert known.headers.get("content-type") == unknown.headers.get("content-type")

    assert len(kb.sent) == 1
    message = kb.sent[0]
    assert message["To"] == me["email"]
    assert message["From"] == "hi@example.com"
    assert "password" in message["Subject"].lower()
    body = message.get_content()
    match = RESET_LINK.search(body)
    assert match and match.group(1).startswith("pwr_")
    assert "1 hour" in body


def test_forgot_refuses_a_malformed_body_alike(kb):
    for body in [{}, {"email": ""}, {"email": "x" * 2000}]:
        assert kb.post("/auth/password/forgot", json=body).status_code == 422


# --- C2: stored hashed, works once, expires after 1 hour --------------------------------


def test_the_code_is_stored_hashed_and_lasts_one_hour(kb):
    me = _account(kb)
    code = _code(kb, me["email"])
    with kb.db.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT r.token_hash, r.expires_at - r.created_at, r.used_at "
                "FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = :e"
            ),
            {"e": me["email"]},
        ).all()
    assert len(rows) == 1
    token_hash, lifetime, used_at = rows[0]
    assert token_hash == sha256_hex(code) and code not in token_hash
    assert lifetime == timedelta(hours=1)
    assert used_at is None


def test_the_code_works_once_and_a_wrong_or_expired_one_is_refused(kb):
    me = _account(kb)
    code = _code(kb, me["email"])

    assert kb.post("/auth/password/reset/check", json={"code": code}).json() == {"state": "valid"}
    assert _reset(kb, code).status_code == 200
    used = _reset(kb, code, "another-pass-1")
    assert used.status_code == 410
    assert kb.post("/auth/password/reset/check", json={"code": code}).status_code == 410
    assert _reset(kb, "pwr_" + "x" * 43).status_code == 410
    assert _reset(kb, "").status_code in (410, 422)
    assert _login(kb, me["email"], "another-pass-1").status_code == 401

    late = _code(kb, me["email"])
    with kb.db.connect() as conn, conn.begin():
        conn.execute(
            text("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash = :h"),
            {"h": sha256_hex(late)},
        )
    assert kb.post("/auth/password/reset/check", json={"code": late}).status_code == 410
    assert _reset(kb, late, "too-late-pass").status_code == 410
    assert _login(kb, me["email"], "too-late-pass").status_code == 401


def test_a_new_password_follows_sign_ups_rule(kb):
    me = _account(kb)
    code = _code(kb, me["email"])
    assert _reset(kb, code, "short").status_code == 422
    # A refused password leaves the code working.
    assert _reset(kb, code).status_code == 200


def test_a_reset_retires_the_accounts_other_codes(kb):
    me = _account(kb)
    first = _code(kb, me["email"])
    second = _code(kb, me["email"])
    assert _reset(kb, second).status_code == 200
    assert _reset(kb, first, "first-code-pass").status_code == 410


# --- C3: a reset signs the account out everywhere; the new password signs in ------------


def test_a_reset_ends_every_session_and_the_new_password_signs_in(kb):
    me = _account(kb)
    other = _session(kb, me["email"])
    assert kb.get("/auth/me", headers=me["h"]).status_code == 200

    res = _reset(kb, _code(kb, me["email"]))
    assert res.status_code == 200, res.text
    assert "token" not in res.json()

    assert kb.get("/auth/me", headers=me["h"]).status_code == 401
    assert kb.get("/auth/me", headers=other).status_code == 401
    assert _login(kb, me["email"], PASSWORD).status_code == 401
    assert _login(kb, me["email"], NEW_PASSWORD).status_code == 200


# --- C4: rate-limited per address and per client ----------------------------------------


def _from(client, email: str, address: str):
    return client.post(
        "/auth/password/forgot", json={"email": email}, headers={"X-Real-IP": address}
    )


def test_strangers_never_lock_an_owner_out_of_a_reset(kb):
    """Five strangers' requests for an address leave its owner's own answered 202, like
    any other; the address gets at most 3 reset mails an hour, and never a refusal."""

    me = _account(kb)
    unknown = _email()
    kb.sent.clear()
    for n in range(5):
        assert _from(kb, me["email"], f"203.0.113.{n + 1}").status_code == 202
        assert _from(kb, unknown, f"203.0.113.{n + 1}").status_code == 202
    own = _from(kb, me["email"], "198.51.100.7")
    other = _from(kb, unknown, "198.51.100.7")
    assert own.status_code == other.status_code == 202
    assert own.json() == other.json() == {"status": "sent"}
    assert [m["To"] for m in kb.sent] == [me["email"]] * 3

    # An hour on, the owner's request mails again.
    with kb.db.begin() as conn:
        conn.execute(
            text(
                "UPDATE password_resets SET created_at = created_at - interval '61 minutes' "
                "WHERE user_id = (SELECT id FROM users WHERE email = :e)"
            ),
            {"e": me["email"]},
        )
    kb.sent.clear()
    assert _from(kb, me["email"], "198.51.100.7").status_code == 202
    assert [m["To"] for m in kb.sent] == [me["email"]]


def test_forgot_and_reset_are_limited_per_client(kb, monkeypatch):
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "2")
    for _ in range(2):
        assert _forgot(kb, _email()).status_code == 202
    assert _forgot(kb, _email()).status_code == 429
    for _ in range(2):
        assert _reset(kb, "pwr_nope").status_code == 410
    assert _reset(kb, "pwr_nope").status_code == 429


# --- C5: the signed-in change needs the current password --------------------------------


def test_change_needs_the_current_password_and_ends_other_sessions(kb):
    me = _account(kb)
    other = _session(kb, me["email"])

    wrong = kb.post(
        "/auth/password/change",
        json={"current": "not-my-password", "password": NEW_PASSWORD},
        headers=me["h"],
    )
    assert wrong.status_code == 403 and wrong.json()["reason"] == "current"
    assert kb.get("/auth/me", headers=other).status_code == 200
    assert _login(kb, me["email"], NEW_PASSWORD).status_code == 401

    short = kb.post(
        "/auth/password/change", json={"current": PASSWORD, "password": "short"}, headers=me["h"]
    )
    assert short.status_code == 422

    ok = kb.post(
        "/auth/password/change", json={"current": PASSWORD, "password": NEW_PASSWORD}, headers=me["h"]
    )
    assert ok.status_code == 200, ok.text
    assert kb.get("/auth/me", headers=me["h"]).status_code == 200  # this session stays
    assert kb.get("/auth/me", headers=other).status_code == 401  # the others end
    assert _login(kb, me["email"], PASSWORD).status_code == 401
    assert _login(kb, me["email"], NEW_PASSWORD).status_code == 200

    assert kb.post(
        "/auth/password/change", json={"current": NEW_PASSWORD, "password": PASSWORD}
    ).status_code == 401


def test_change_is_limited_per_account(kb, monkeypatch):
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "2")
    me = _account(kb)
    body = {"current": "not-my-password", "password": NEW_PASSWORD}
    for _ in range(2):
        assert kb.post("/auth/password/change", json=body, headers=me["h"]).status_code == 403
    assert kb.post("/auth/password/change", json=body, headers=me["h"]).status_code == 429


# --- C6: a waitlisted account's reset never gets it past the waitlist -------------------


def test_a_waitlisted_accounts_reset_never_signs_it_in(kb, monkeypatch):
    email = _email()
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    assert kb.post("/auth/signup", json={"email": email, "password": PASSWORD}).status_code == 202

    code = _code(kb, email)
    res = _reset(kb, code)
    assert res.status_code == 200 and "token" not in res.json()
    with kb.db.connect() as conn:
        assert conn.execute(
            text("SELECT status FROM users WHERE email = :e"), {"e": email}
        ).scalar_one() == "waitlisted"
        assert conn.execute(
            text("SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = :e"),
            {"e": email},
        ).scalar_one() == 0
    after = _login(kb, email, NEW_PASSWORD)
    assert after.status_code == 403 and after.json()["status"] == "waitlisted"
    assert "token" not in after.json()
