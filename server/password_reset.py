"""Password reset by mail, and the signed-in password change.

Routes (public ``/auth/*``, beside sign-in; the change needs a session):

- ``POST /auth/password/forgot {email}``: ``202 {"status": "sent"}`` whatever the
  address, so the answer never says whether an account has it. Only for an account
  does anything happen, after the response: one code is made (``pwr_`` and a
  high-entropy URL-safe token; the row keeps its sha256, revision ``0015``, and it
  lives ``RESET_TTL``, 1 hour) and one mail goes from ``KB_SMTP_FROM`` with
  ``<KB_PUBLIC_BASE_URL>/reset?code=<code>``. Limited per client (the sign-in
  limiter, ``KB_AUTH_RATE_LIMIT``). An account gets at most ``MAIL_LIMIT`` reset mails
  an hour: past that the request makes no code and sends nothing, and still answers
  the same 202. The cap only stops mails, never refuses, so a stranger asking for
  someone's address can never keep its owner from a reset.
- ``POST /auth/password/reset/check {code}``: ``200 {"state": "valid"}``, or ``410``
  for a code that is unknown, used or expired (one answer for all three). The reset
  page reads it before it draws the form. Limited per client.
- ``POST /auth/password/reset {code, password}``: the new password (sign-up's rule:
  at least 8 characters, else 422) replaces the old under the code's row lock, the
  code and every other open code of the account become used, and every session of
  the account ends. ``200 {"status": "reset", "email"}``; no session is minted, so
  the person signs in with the new password, and sign-in still decides: a waitlisted
  account stays waitlisted (its reset never gets it a session). ``410`` as above.
  Limited per client.
- ``POST /auth/password/change {current, password}`` (a session): the current
  password must match (else ``403 {"reason": "current"}``); the new one replaces it,
  the account's open reset codes become used, and every session but this one ends.
  ``200 {"status": "changed"}``. Limited per account (the sign-in limiter's numbers).

Without SMTP configured (a local stack, a self-hosted install without mail) the reset
link is logged at WARNING instead of mailed, as the invite link is; with SMTP it never
is. Every route answers 404 without ``DATABASE_URL``.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import timedelta
from email.message import EmailMessage

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select, update

from server import auth_api, config
from server.accounts.auth import AuthContext, extract_bearer_token, require_user
from server.accounts.security import (
    generate_opaque_token,
    hash_password,
    sha256_hex,
    verify_password,
)
from server.accounts.service import get_accounts_service
from server.email_address import is_plain_address
from server.feedback import notify
from server.installs_api import _require_accounts_plane
from server.persistence.engine import get_session_maker
from server.persistence.models import AuthTokenModel, PasswordResetModel, UserModel, utc_now
from server.waitlist import _message

logger = logging.getLogger(__name__)

router = APIRouter()

RESET_TTL = timedelta(hours=1)
CODE_PREFIX = "pwr_"
#: A carried code longer than this is no code of ours (refused without a lookup).
MAX_CODE_CHARS = 200
#: Reset mails an account gets per ``MAIL_WINDOW`` (counted from its stored codes);
#: a request past it sends nothing and answers the same.
MAIL_LIMIT = 3
MAIL_WINDOW = timedelta(hours=1)

RESET_SUBJECT = "Reset your sikstack password"
RESET_BODY = """\
Hi,

Someone asked to reset the password of the sikstack account for {email}.

Set a new password here: {url}

The link works once, for 1 hour. If you did not ask, ignore this mail: your password stays as it is.

sikstack
"""

_LINK_REFUSED = "this link no longer works"


def new_code() -> str:
    """A new reset code: ``pwr_`` and 43 URL-safe characters."""

    return CODE_PREFIX + generate_opaque_token()


def reset_url(code: str) -> str:
    """The reset link: the web's ``/reset`` page on the public origin."""

    return f"{config.public_base_url()}/reset?code={code}"


def render_reset_message(to_email: str, code: str) -> EmailMessage:
    """The reset mail: the account's address and the one-use link."""

    body = RESET_BODY.format(email=to_email, url=reset_url(code))
    return _message(RESET_SUBJECT, body, to_email)


# --- limits -------------------------------------------------------------------------

# key -> (window_start_monotonic, count). One uvicorn worker (server/main.py), so an
# in-process counter is coherent, like the sign-in limiter it sits beside.
_MAX_KEYS = 20_000


def _count(windows: dict[str, tuple[float, int]], key: str, limit: int, window_s: float) -> None:
    """Count one request under ``key``; 429 past ``limit`` in the fixed window."""

    if limit <= 0:
        return
    now = time.monotonic()
    if len(windows) >= _MAX_KEYS:
        for stale in [k for k, (start, _) in windows.items() if now - start >= window_s]:
            del windows[stale]
        if len(windows) >= _MAX_KEYS:
            for old in sorted(windows, key=lambda k: windows[k][0])[: _MAX_KEYS // 2]:
                del windows[old]
    start, count = windows.get(key, (now, 0))
    if now - start >= window_s:
        start, count = now, 0
    count += 1
    windows[key] = (start, count)
    if count > limit:
        raise HTTPException(
            status_code=429,
            detail="too many requests — please retry later",
            headers={"Retry-After": str(max(1, int(window_s - (now - start))))},
        )


def _limit_account(ctx: AuthContext) -> None:
    _count(
        auth_api._rate_windows,
        f"password-change:user:{ctx.user.id}",
        config.auth_rate_limit(),
        float(config.auth_rate_window_s()),
    )


# --- bodies -------------------------------------------------------------------------


class ForgotIn(BaseModel):
    email: str = Field(max_length=320)

    @field_validator("email")
    @classmethod
    def _normalize(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized


class CodeIn(BaseModel):
    code: str = Field(min_length=1, max_length=MAX_CODE_CHARS)


class ResetIn(CodeIn):
    #: Sign-up's rule (``auth_api._EmailPasswordInput``).
    password: str = Field(min_length=8)


class ChangeIn(BaseModel):
    current: str = Field(min_length=1)
    password: str = Field(min_length=8)


def _refused() -> JSONResponse:
    return JSONResponse({"detail": _LINK_REFUSED, "state": "invalid"}, status_code=410)


# --- the request ----------------------------------------------------------------------


async def send_reset(email: str) -> None:
    """Make a code for the account with ``email`` and mail it; nothing for no account,
    and nothing once the account has had ``MAIL_LIMIT`` codes in ``MAIL_WINDOW``.

    Runs after the forgot's response, best-effort: it never raises. The count and the
    new code share one transaction under the account's row lock, so two requests at
    once never both pass the cap.
    """

    try:
        user = await get_accounts_service().get_user_by_email(email)
        if user is None:
            return
        if not is_plain_address(user.email):
            logger.warning("No reset mail: the account's stored address is not one plain address")
            return
        code = new_code()
        now = utc_now()
        async with get_session_maker()() as session, session.begin():
            await session.get(UserModel, user.id, with_for_update=True)
            recent = (
                await session.execute(
                    select(func.count())
                    .select_from(PasswordResetModel)
                    .where(
                        PasswordResetModel.user_id == user.id,
                        PasswordResetModel.created_at > now - MAIL_WINDOW,
                    )
                )
            ).scalar_one()
            if recent >= MAIL_LIMIT:
                logger.info("Reset mail cap reached for an account; no mail this time")
                return
            session.add(
                PasswordResetModel(
                    user_id=user.id,
                    token_hash=sha256_hex(code),
                    created_at=now,
                    expires_at=now + RESET_TTL,
                )
            )
        if not config.smtp_configured():
            logger.warning(
                "SMTP is not configured; no reset mail to %s. The reset link: %s",
                user.email,
                reset_url(code),
            )
            return
        message = render_reset_message(user.email, code)
        await asyncio.to_thread(notify.send_message, message)
    except Exception:  # best-effort: the answer went out already, and is the same
        logger.exception("Reset mail failed; dropped")


@router.post("/auth/password/forgot", status_code=202)
async def forgot(
    payload: ForgotIn, request: Request, background_tasks: BackgroundTasks
) -> dict[str, str]:
    """Ask for a reset link (see the module docstring); the same answer for any address."""

    _require_accounts_plane()
    auth_api._enforce_rate_limit(request)
    background_tasks.add_task(send_reset, payload.email)
    return {"status": "sent"}


# --- the code -------------------------------------------------------------------------


async def _open_row(session, code: str, *, lock: bool = False) -> PasswordResetModel | None:
    """The unused, unexpired reset a code names, or None."""

    if not code or len(code) > MAX_CODE_CHARS:
        return None
    query = select(PasswordResetModel).where(PasswordResetModel.token_hash == sha256_hex(code))
    if lock:
        query = query.with_for_update()
    row = (await session.execute(query)).scalar_one_or_none()
    if row is None or row.used_at is not None or row.expires_at <= utc_now():
        return None
    return row


@router.post("/auth/password/reset/check", response_model=None)
async def check_code(payload: CodeIn, request: Request) -> dict[str, str] | JSONResponse:
    """Whether a reset link still works."""

    _require_accounts_plane()
    auth_api._enforce_rate_limit(request)
    async with get_session_maker()() as session:
        row = await _open_row(session, payload.code)
    return {"state": "valid"} if row is not None else _refused()


@router.post("/auth/password/reset", response_model=None)
async def reset(payload: ResetIn, request: Request) -> dict[str, str] | JSONResponse:
    """Set a new password by a reset code; every session of the account ends."""

    _require_accounts_plane()
    auth_api._enforce_rate_limit(request)
    now = utc_now()
    async with get_session_maker()() as session, session.begin():
        row = await _open_row(session, payload.code, lock=True)
        if row is None:
            return _refused()
        user = await session.get(UserModel, row.user_id)
        if user is None:  # pragma: no cover - the row cascades with its user
            return _refused()
        user.password_hash = hash_password(payload.password)
        await session.execute(
            update(PasswordResetModel)
            .where(PasswordResetModel.user_id == row.user_id, PasswordResetModel.used_at.is_(None))
            .values(used_at=now)
            .execution_options(synchronize_session=False)
        )
        await session.execute(
            delete(AuthTokenModel)
            .where(AuthTokenModel.user_id == row.user_id)
            .execution_options(synchronize_session=False)
        )
        email = user.email
    return {"status": "reset", "email": email}


# --- the signed-in change -------------------------------------------------------------


@router.post("/auth/password/change", response_model=None)
async def change(
    payload: ChangeIn, request: Request, ctx: AuthContext = Depends(require_user)
) -> dict[str, str] | JSONResponse:
    """Change the password given the current one; every other session ends."""

    _require_accounts_plane()
    _limit_account(ctx)
    token = extract_bearer_token(request)
    kept = sha256_hex(token) if token else ""
    now = utc_now()
    async with get_session_maker()() as session, session.begin():
        user = await session.get(UserModel, ctx.user.id, with_for_update=True)
        if user is None or not verify_password(user.password_hash, payload.current):
            return JSONResponse(
                {"detail": "the current password is not right", "reason": "current"},
                status_code=403,
            )
        user.password_hash = hash_password(payload.password)
        await session.execute(
            update(PasswordResetModel)
            .where(PasswordResetModel.user_id == user.id, PasswordResetModel.used_at.is_(None))
            .values(used_at=now)
            .execution_options(synchronize_session=False)
        )
        await session.execute(
            delete(AuthTokenModel)
            .where(AuthTokenModel.user_id == user.id, AuthTokenModel.token_hash != kept)
            .execution_options(synchronize_session=False)
        )
    return {"status": "changed"}
