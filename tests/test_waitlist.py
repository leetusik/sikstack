"""The sign-up waitlist (``users.status``, ``KB_SIGNUP_WAITLIST``): Postgres-gated.

A waitlisted account never holds a session: sign-up with the switch on mints none,
sign-in with the right password mints none, and every session resolver refuses a
token that belongs to one (the token is inserted directly, since no endpoint mints
it). ``python -m server.waitlist approve`` flips the account and sends one mail.
Runs only with ``KB_TEST_DATABASE_URL`` (or ``DATABASE_URL``) set, like the other
accounts suites; ``smtplib`` is never reached (the send is monkeypatched).
"""

from __future__ import annotations

import os
import smtplib
from datetime import timedelta
from uuid import uuid4

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, make_url, text

from server.feedback.notify import send_message as _REAL_SEND_MESSAGE

_RAW_DSN = os.environ.get("KB_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
SMTP_ENV = ("KB_SMTP_HOST", "KB_SMTP_PORT", "KB_SMTP_USER", "KB_SMTP_PASSWORD", "KB_SMTP_FROM")
PASSWORD = "hunter2pass"
_REAL_SMTP_SEND_MESSAGE = smtplib.SMTP.send_message


@pytest.fixture
def wl(tmp_path, monkeypatch):
    """A TestClient on a Postgres accounts plane, SMTP configured but faked."""

    if not _RAW_DSN:
        pytest.skip(
            "set KB_TEST_DATABASE_URL (or DATABASE_URL) to a disposable Postgres to "
            "run the waitlist tests"
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

    monkeypatch.setenv("KB_DB_PATH", str(tmp_path / "data" / "kb.sqlite3"))
    monkeypatch.setenv("DATABASE_URL", url)
    monkeypatch.setenv("KB_AUTH_RATE_LIMIT", "0")
    for name in SMTP_ENV + ("KB_WAITLIST_ALERT_TO",):
        monkeypatch.delenv(name, raising=False)
    # Configured, so every mail reaches the (faked) send.
    monkeypatch.setenv("KB_SMTP_HOST", "smtp.invalid")
    monkeypatch.setenv("KB_SMTP_FROM", "hi@example.com")
    monkeypatch.setenv("KB_PUBLIC_BASE_URL", "https://kb.example.com")

    import server.feedback.notify as notify
    import server.persistence.engine as engine_mod

    sent: list = []
    monkeypatch.setattr(notify, "send_message", lambda message: sent.append(message))
    engine_mod._engine = None
    engine_mod._session_maker = None

    from server.main import app

    with TestClient(app) as client:
        client.sent = sent  # type: ignore[attr-defined]
        client.db = sync_engine  # type: ignore[attr-defined]
        yield client

    engine_mod._engine = None
    engine_mod._session_maker = None
    sync_engine.dispose()


def _email() -> str:
    return f"P58-{uuid4().hex}@Example.com"


def _status(client, email: str) -> str:
    with client.db.connect() as conn:
        return conn.execute(
            text("SELECT status FROM users WHERE email = :e"), {"e": email.lower()}
        ).scalar_one()


def _token_count(client, email: str) -> int:
    with client.db.connect() as conn:
        return conn.execute(
            text(
                "SELECT count(*) FROM auth_tokens t JOIN users u ON u.id = t.user_id "
                "WHERE u.email = :e"
            ),
            {"e": email.lower()},
        ).scalar_one()


def _waitlisted(client, monkeypatch) -> str:
    """A fresh waitlisted account, made through sign-up with the switch on."""

    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    email = _email()
    res = client.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text
    monkeypatch.delenv("KB_SIGNUP_WAITLIST")
    client.sent.clear()
    return email.lower()


def test_switch_on_signup_answers_waitlisted_and_mints_no_token(wl, monkeypatch):
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    email = _email()
    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text
    assert res.json() == {"status": "waitlisted", "email": email.lower()}
    assert _status(wl, email) == "waitlisted"
    assert _token_count(wl, email) == 0
    with wl.db.connect() as conn:  # the org and project are provisioned as today
        orgs = conn.execute(
            text(
                "SELECT count(*) FROM tenant_members m JOIN users u ON u.id = m.user_id "
                "JOIN projects p ON p.tenant_id = m.tenant_id WHERE u.email = :e"
            ),
            {"e": email.lower()},
        ).scalar_one()
    assert orgs == 1
    # One waitlist mail to the account and one alert to the operator, after the response.
    assert len(wl.sent) == 2
    mail = wl.sent[0]
    assert mail["To"] == email.lower() and mail["From"] == "hi@example.com"
    assert "waitlist" in mail.get_content()
    # The install's own sender is its operator's inbox when no alert address is set.
    assert wl.sent[1]["To"] == "hi@example.com"
    assert wl.sent[1]["Subject"].startswith("Waitlist sign-up:")
    # A taken email answers as today, waitlisted or not.
    again = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert again.status_code == 409


def test_switch_off_signup_is_todays(wl, monkeypatch):
    monkeypatch.delenv("KB_SIGNUP_WAITLIST", raising=False)
    email = _email()
    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    body = res.json()
    assert set(body) == {"token", "user", "tenant", "project"} and body["token"]
    assert _status(wl, email) == "approved"
    assert wl.get("/auth/me", headers={"Authorization": f"Bearer {body['token']}"}).status_code == 200
    assert wl.sent == []


@pytest.mark.parametrize("switch", ["on", None])
def test_waitlisted_signin_never_gets_a_token(wl, monkeypatch, switch):
    email = _waitlisted(wl, monkeypatch)
    if switch:
        monkeypatch.setenv("KB_SIGNUP_WAITLIST", switch)

    right = wl.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert right.status_code == 403, right.text
    assert right.json() == {"detail": "waitlisted", "status": "waitlisted", "email": email}
    assert "token" not in right.json()
    assert _token_count(wl, email) == 0

    wrong = wl.post("/auth/login", json={"email": email, "password": "wrong-password"})
    unknown = wl.post("/auth/login", json={"email": _email(), "password": PASSWORD})
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "invalid email or password"}
    assert wl.sent == []


def _insert_session(client, email: str) -> str:
    from server.accounts.security import generate_opaque_token, sha256_hex
    from server.persistence.models import utc_now

    raw = generate_opaque_token()
    with client.db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO auth_tokens (id, user_id, token_hash, expires_at) "
                "SELECT :id, id, :h, :exp FROM users WHERE email = :e"
            ),
            {"id": uuid4(), "h": sha256_hex(raw), "exp": utc_now() + timedelta(days=1), "e": email},
        )
    return raw


def _request(token: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": [(b"authorization", f"Bearer {token}".encode())],
        }
    )


def test_every_session_resolver_refuses_a_waitlisted_user(wl, monkeypatch):
    from server.accounts.auth import AuthError, optional_user, require_user
    from server.api_auth import _resolve_tenant_bearer

    email = _waitlisted(wl, monkeypatch)
    token = _insert_session(wl, email)

    with pytest.raises(AuthError):
        wl.portal.call(require_user, _request(token))
    assert wl.portal.call(optional_user, _request(token)) is None
    assert wl.portal.call(_resolve_tenant_bearer, token, _request(token)) is None
    me = wl.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401 and me.json() == {"detail": "Unauthorized"}
    api = wl.get("/api/documents", headers={"Authorization": f"Bearer {token}"})
    assert api.status_code == 401

    # The same token resolves once the account is approved: the refusal is the status.
    with wl.db.begin() as conn:
        conn.execute(text("UPDATE users SET status = 'approved' WHERE email = :e"), {"e": email})
    assert wl.portal.call(require_user, _request(token)).user.email == email
    assert wl.portal.call(optional_user, _request(token)) is not None
    assert wl.portal.call(_resolve_tenant_bearer, token, _request(token)) is not None


def test_approve_flips_once_and_mails_once(wl, monkeypatch, capsys):
    from server import waitlist

    first = _waitlisted(wl, monkeypatch)
    second = _waitlisted(wl, monkeypatch)
    listed = [u.email for u in wl.portal.call(waitlist.list_waitlisted)]
    assert listed.index(first) < listed.index(second)  # oldest first

    assert wl.portal.call(waitlist.approve, first) == 0
    assert _status(wl, first) == "approved"
    assert len(wl.sent) == 1
    mail = wl.sent[0]
    assert mail["To"] == first and mail["From"] == "hi@example.com"
    assert "https://kb.example.com/login" in mail.get_content()
    assert first not in [u.email for u in wl.portal.call(waitlist.list_waitlisted)]

    assert wl.portal.call(waitlist.approve, first) == 0  # already approved: nothing
    assert len(wl.sent) == 1
    assert "already approved" in capsys.readouterr().out

    unknown = _email().lower()
    assert wl.portal.call(waitlist.approve, unknown) != 0
    assert len(wl.sent) == 1
    with wl.db.connect() as conn:
        assert conn.execute(
            text("SELECT count(*) FROM users WHERE email = :e"), {"e": unknown}
        ).scalar_one() == 0

    # Approved now, the account signs in with a token.
    login = wl.post("/auth/login", json={"email": first, "password": PASSWORD})
    assert login.status_code == 200 and login.json()["token"]


def test_a_failed_approval_mail_keeps_the_approval(wl, monkeypatch, capsys):
    import server.feedback.notify as notify
    from server import waitlist

    email = _waitlisted(wl, monkeypatch)

    def boom(message):
        raise OSError("smtp down")

    monkeypatch.setattr(notify, "send_message", boom)
    code = wl.portal.call(waitlist.approve, email)
    assert code != 0
    assert _status(wl, email) == "approved"
    assert "mail" in capsys.readouterr().err


def test_a_waitlisted_signup_alerts_the_operator_once(wl, monkeypatch):
    """One alert to ``KB_WAITLIST_ALERT_TO`` naming the address and the approve command;
    the account's own mail is unchanged; an approved sign-up sends no alert."""

    from server import waitlist

    monkeypatch.setenv("KB_WAITLIST_ALERT_TO", "alerts@ops.example.org")
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    email = _email().lower()
    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text

    alerts = [m for m in wl.sent if m["To"] == "alerts@ops.example.org"]
    own = [m for m in wl.sent if m["To"] == email]
    assert len(alerts) == 1 and len(own) == 1 and len(wl.sent) == 2
    alert = alerts[0]
    assert alert["From"] == "hi@example.com"
    body = alert.get_content()
    assert email in body
    assert f"docker compose exec api python -m server.waitlist approve {email}" in body
    # The account's mail is the one it got before the alert existed.
    expected = waitlist.render_waitlist_message(email)
    assert own[0]["Subject"] == expected["Subject"]
    assert own[0].get_content() == expected.get_content()

    wl.sent.clear()
    monkeypatch.delenv("KB_SIGNUP_WAITLIST")
    approved = wl.post("/auth/signup", json={"email": _email(), "password": PASSWORD})
    assert approved.status_code == 201
    assert wl.sent == []


def test_the_alert_goes_to_the_installs_own_sender_else_nowhere(wl, monkeypatch):
    """Without ``KB_WAITLIST_ALERT_TO`` the alert goes to ``KB_SMTP_FROM``; with neither
    set (SMTP sending as its login) there is no alert mail and one WARNING."""

    from server import waitlist

    monkeypatch.setenv("KB_SMTP_FROM", "ops@example.org")
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    email = _email().lower()
    assert wl.post("/auth/signup", json={"email": email, "password": PASSWORD}).status_code == 202
    assert sorted(m["To"] for m in wl.sent) == sorted([email, "ops@example.org"])

    # Spied on directly: an earlier suite's logging config may have disabled the logger.
    warnings: list[str] = []
    monkeypatch.setattr(
        waitlist.logger, "warning", lambda msg, *args: warnings.append(msg % args)
    )
    wl.sent.clear()
    monkeypatch.delenv("KB_SMTP_FROM")
    monkeypatch.setenv("KB_SMTP_USER", "mailer")
    other = _email().lower()
    res = wl.post("/auth/signup", json={"email": other, "password": PASSWORD})
    assert res.status_code == 202
    assert [m["To"] for m in wl.sent] == [other]  # the account's own mail only
    assert len(warnings) == 1 and "KB_WAITLIST_ALERT_TO" in warnings[0]


def test_a_failed_alert_never_fails_the_signup(wl, monkeypatch):
    import server.feedback.notify as notify

    def boom(message):
        if message["Subject"].startswith("Waitlist sign-up:"):
            raise OSError("smtp down")

    monkeypatch.setattr(notify, "send_message", boom)
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "on")
    email = _email()
    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text
    assert _status(wl, email) == "waitlisted"


def test_a_failed_waitlist_mail_never_fails_the_signup(wl, monkeypatch):
    import server.feedback.notify as notify

    def boom(message):
        raise OSError("smtp down")

    monkeypatch.setattr(notify, "send_message", boom)
    monkeypatch.setenv("KB_SIGNUP_WAITLIST", "true")
    email = _email()
    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 202, res.text
    assert res.json() == {"status": "waitlisted", "email": email.lower()}
    assert _status(wl, email) == "waitlisted"
    assert _token_count(wl, email) == 0


# --- one plain address: the sign-up rule and the mailer's guard -------------------
#
# A sign-up email that names more than one address, or carries a display name, was
# stored and then put in the waitlist mail's ``To:``, which ``smtplib`` mails to
# every address it names. Sign-up now refuses it (422, no row, no mail), and the
# mailer sends only to a stored email that is exactly one plain address. ``{u}``
# keeps each run's rows apart on a reused test database.

REFUSED_SIGNUPS = [
    "one{u}@victim.invalid, two@victim.invalid, three@victim.invalid",
    "one{u}@victim.invalid; two@victim.invalid",
    '"Claim prize" <three{u}@victim.invalid>',
    "Name <a{u}@b.invalid>",
    "six{u}@victim.invalid\r\nBcc: seven@victim.invalid",
    "six{u}@victim.invalid\nseven@victim.invalid",
    "a {u}@victim.invalid",
    "x{u}:a@b.invalid,c@d.invalid;",
    "a{u}@b@victim.invalid",
    "@victim{u}.invalid",
    "a{u}@",
    "a{u}@b..invalid",
    "noor{u}@example",
    "{u}" + "a" * (255 - 15 - 32) + "@victim.invalid",  # 255 characters
    # RFC 2047 encoded words: one address as typed, another (or several) in To:.
    "a{u}@=?utf-8?q?evil.example=2C_c=40x?=.invalid",
    "=?utf-8?q?a{u}=2C_b=40evil.example?=@victim.invalid",
    "=?UTF-8?Q?a{u}=2C_b=40evil.example?=@victim.invalid",
    "=?utf-8?b?YSwgYkBldmlsLmV4YW1wbGU=?=@victim{u}.invalid",
    "=?utf-8?q?Claim_your_prize?=@victim{u}.invalid",
]
ACCEPTED_SIGNUPS = [
    "five{u}@victim.invalid",
    "Review-Wait{u}@p58.test",
    "a+b{u}@c.invalid",
    "a{u}@mail.sub.victim.invalid",
    "a{u}@my-host.victim.invalid",
    "{u}" + "a" * (254 - 15 - 32) + "@victim.invalid",  # 254 characters
]


def _fill(template: str) -> str:
    return template.replace("{u}", uuid4().hex)


@pytest.fixture
def rcpt(wl, monkeypatch):
    """A recording SMTP stand-in: the real ``send_message`` up to RCPT, nothing sent.

    It keeps ``smtplib.SMTP.send_message``'s own recipient derivation (the
    ``To``/``Cc``/``Bcc`` headers through ``email.utils.getaddresses``) and records
    the recipient list that would reach ``RCPT TO``, one list per mail.
    """

    import server.feedback.notify as notify

    recorded: list[list[str]] = []

    class RecordingSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self, **kwargs):
            pass

        def login(self, *args):
            pass

        def ehlo_or_helo_if_needed(self):
            pass

        def has_extn(self, name):
            return False

        send_message = _REAL_SMTP_SEND_MESSAGE

        def sendmail(self, from_addr, to_addrs, msg, mail_options=(), rcpt_options=()):
            recorded.append(list(to_addrs))
            return {}

    monkeypatch.setattr(notify, "send_message", _REAL_SEND_MESSAGE)
    monkeypatch.setattr(smtplib, "SMTP", RecordingSMTP)
    monkeypatch.setattr(smtplib, "SMTP_SSL", RecordingSMTP)
    return recorded


def _user_count(client, email: str | None = None) -> int:
    with client.db.connect() as conn:
        if email is None:
            return conn.execute(text("SELECT count(*) FROM users")).scalar_one()
        return conn.execute(
            text("SELECT count(*) FROM users WHERE email = :e"), {"e": email}
        ).scalar_one()


@pytest.mark.parametrize("switch", ["on", None])
@pytest.mark.parametrize("template", REFUSED_SIGNUPS)
def test_signup_refuses_anything_but_one_plain_address(wl, rcpt, monkeypatch, template, switch):
    if switch:
        monkeypatch.setenv("KB_SIGNUP_WAITLIST", switch)
    email = _fill(template)
    stored = email.strip().lower()
    users_before = _user_count(wl)

    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})

    assert res.status_code == 422, res.text
    assert res.json()["detail"][0]["loc"] == ["body", "email"]
    assert _user_count(wl, stored) == 0
    assert _user_count(wl) == users_before
    assert rcpt == [] and wl.sent == []


@pytest.mark.parametrize("switch", ["on", None])
@pytest.mark.parametrize("template", ACCEPTED_SIGNUPS)
def test_signup_accepts_one_plain_address_and_mails_only_it(
    wl, rcpt, monkeypatch, template, switch
):
    if switch:
        monkeypatch.setenv("KB_SIGNUP_WAITLIST", switch)
    email = _fill(template)
    stored = email.lower()

    res = wl.post("/auth/signup", json={"email": email, "password": PASSWORD})

    assert res.status_code == (202 if switch else 201), res.text
    assert _user_count(wl, stored) == 1
    assert rcpt == ([[stored], ["hi@example.com"]] if switch else [])


LEGACY_ROWS = [
    "one{u}@victim.invalid, two@victim.invalid, three@victim.invalid",
    "one{u}@victim.invalid; two@victim.invalid",
    '"claim prize" <three{u}@victim.invalid>',
    "x{u}:a@b.invalid,c@d.invalid;",
    "six{u}@victim.invalid\r\nbcc: seven@victim.invalid",
    "a{u}@b@victim.invalid",
    "a{u}@=?utf-8?q?evil.example=2c_c=40x?=.invalid",  # as sign-up lowercased it
    "=?utf-8?q?a{u}=2c_b=40evil.example?=@victim.invalid",
    "=?utf-8?q?claim_your_prize?=@victim{u}.invalid",
]
ENCODED_ROWS = [t for t in LEGACY_ROWS if "=?" in t]


def _legacy_row(client, template: str, status: str = "waitlisted") -> str:
    """A row as an earlier sign-up could store it: the service checks no address."""

    from server.accounts.security import hash_password
    from server.accounts.service import get_accounts_service
    from server.accounts.types import CreateUser

    email = _fill(template)
    client.portal.call(
        get_accounts_service().create_user,
        CreateUser(email=email, password_hash=hash_password(PASSWORD), status=status),
    )
    return email


@pytest.mark.parametrize("template", LEGACY_ROWS)
def test_the_mailer_never_mails_a_stored_row_that_is_not_one_address(
    wl, rcpt, monkeypatch, capsys, template
):
    from server import waitlist

    email = _legacy_row(wl, template)

    wl.portal.call(waitlist.notify_waitlisted, email)
    assert rcpt == []

    capsys.readouterr()
    assert wl.portal.call(waitlist.approve, email) == 1
    out = capsys.readouterr()
    assert "not one plain address" in out.err and "no mail sent" in out.err
    assert _status(wl, email) == "waitlisted"  # nothing changed
    assert rcpt == []

    # `list` still lists it, on one line, marked.
    users = wl.portal.call(waitlist.list_waitlisted)
    lines = [waitlist.list_line(u) for u in users if u.email == email]
    assert len(lines) == 1
    assert "\n" not in lines[0] and "\r" not in lines[0]
    assert "not one plain address" in lines[0]


@pytest.mark.parametrize("template", ENCODED_ROWS)
def test_the_mailers_own_check_holds_without_the_rule(
    wl, rcpt, monkeypatch, capsys, template
):
    """Defence in depth: with the rule waved through (a rule that missed a case),
    the mailer's read-back of the rendered mail still sends nothing, and approve
    still changes nothing."""

    from server import waitlist

    email = _legacy_row(wl, template)
    monkeypatch.setattr(waitlist, "is_plain_address", lambda value: True)

    wl.portal.call(waitlist.notify_waitlisted, email)
    assert rcpt == []

    capsys.readouterr()
    assert wl.portal.call(waitlist.approve, email) == 1
    out = capsys.readouterr()
    assert "nothing changed, no mail sent" in out.err
    assert _status(wl, email) == "waitlisted"
    assert rcpt == []


def test_the_approval_mail_goes_to_exactly_the_account(wl, rcpt, monkeypatch):
    from server import waitlist

    email = _waitlisted(wl, monkeypatch)
    users = wl.portal.call(waitlist.list_waitlisted)
    (user,) = [u for u in users if u.email == email]
    assert waitlist.list_line(user) == f"{email}\t{user.created_at.isoformat()}"  # as before

    rcpt.clear()
    assert wl.portal.call(waitlist.approve, email) == 0
    assert rcpt == [[email]]


@pytest.mark.parametrize("template", LEGACY_ROWS)
def test_signin_keeps_reading_an_odd_stored_email(wl, template):
    """Sign-in is not narrowed: an existing odd row still signs in; no match is the 401."""

    email = _legacy_row(wl, template, status="approved")
    ok = wl.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert ok.status_code == 200 and ok.json()["token"]
    nobody = wl.post("/auth/login", json={"email": _fill(template), "password": PASSWORD})
    assert nobody.status_code == 401
    assert nobody.json() == {"detail": "invalid email or password"}
