"""Account auth routes: signup, login, logout, and the caller's identity.

Public ``/auth/*`` surface (outside ``/api/*`` so the content-plane bearer
guards never touch it). Signup provisions a user plus an org (tenant) named
``Personal`` and the owner membership in one transaction (the ``provision_signup``
primitive; no project), then mints an opaque DB-backed bearer token; login re-issues one.
Raw tokens are returned once and stored only as a sha256 hash. Responses never
expose ``password_hash`` or any ``token_hash``.

Ported from vocky ``auth_api.py`` (Starlette → FastAPI): body validation is
FastAPI-native (pydantic model params → standard 422), not vocky's Starlette
400-single-string; every other behavior is preserved verbatim — the identical
generic 401 for unknown-email vs wrong-password (no user enumeration), the 409
duplicate, the 30-day session TTL, the singular-``tenant`` signup shape vs
plural-``tenants`` login/me shape, and hash-free serializers. Signup's tenant
naming changed in P18: it now provisions a ``"default"`` org + ``"default"``
project (was ``"<localpart>'s workspace"``) and its response gained an additive
``project`` field. In P88 the org became ``"Personal"`` with no project; the
``project`` key stays, as ``null``, so the shape only ever gained fields.

The waitlist (``KB_SIGNUP_WAITLIST``, ``users.status``): with the switch on, signup
creates the account ``waitlisted`` and answers 202 without a token; login answers a
waitlisted account's right password with a 403, also without one. Both bodies carry
``"status": "waitlisted"`` (``waitlisted_body``). A waitlisted sign-up also alerts the
operator (``server.waitlist.alert_waitlist_signup``), after the response.

An org invite's code may ride either body (``invite``, from the ``/invite`` page):
when it names a valid invite to this very address, the account joins that org as
``member`` and, if it is (or would be) waitlisted, is approved in the same step
(``server.invites.accept``); the answer is the approved one, with the joined org as
an additive ``joined``. A code for any other address, or one that no longer works,
changes nothing: the answer is today's. Sign-in reads the code only for a waitlisted
account; an approved one joins on the invite page.
"""

from __future__ import annotations

import time
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from server import config, invites
from server.accounts.auth import AuthContext, extract_bearer_token, require_user
from server.accounts.security import (
    generate_opaque_token,
    hash_password,
    sha256_hex,
    verify_password,
)
from server.accounts.service import DuplicateEmailError, get_accounts_service
from server.accounts.types import (
    USER_APPROVED,
    USER_WAITLISTED,
    CreateAuthToken,
    CreateUser,
    ProjectRecord,
    TenantRecord,
    UserRecord,
)
from server.email_address import is_plain_address
from server.persistence.models import utc_now
from server.waitlist import alert_waitlist_signup, notify_waitlisted

SESSION_TTL = timedelta(days=30)

# Identical generic 401 for unknown-email vs bad-password (no user enumeration).
_INVALID_CREDENTIALS = "invalid email or password"


def waitlisted_body(email: str) -> dict[str, str]:
    """The waitlisted answer's body, shared by sign-up (202) and sign-in (403).

    Both carry ``"status": "waitlisted"`` and the account's email, so one client
    branch reads either; neither carries a token. Sign-in's adds the ``detail``
    string every other error of this file has.
    """

    return {"status": USER_WAITLISTED, "email": email}

router = APIRouter()


# --- in-process per-IP throttle for the unauthenticated grant (P13.S5) --------
#
# WHY HERE, NOT AT THE EDGE. P13.S5 publishes ``/auth/*`` to the internet — an
# unauthenticated password grant (``login``) and open signup — where before the
# only throttle was the Next BFF's 5/IP/15min, which a *direct* API call bypasses
# entirely. nginx would be the usual home for a rate limit, but three facts route
# it here instead: (1) ``deploy/knowledge.conf`` bans ``limit_req_zone`` in this
# vhost (zone names are global across the shared ``conf.d/`` tree, and a duplicate
# is a hard ``nginx -t`` failure that blocks the reload for *every* site on the
# edge); (2) the local stack has no nginx, so an edge throttle could never be
# exercised by the E2E smoke this slice ships — it would be asserted, never
# proven; (3) ``server/main.py`` pins a SINGLE uvicorn worker as a load-bearing
# invariant, so an in-memory per-IP counter has no cross-worker split-state
# problem and is exactly coherent. So the throttle is server-side, in-process, and
# gates ``signup`` + ``login`` only.
#
# TRUST MODEL for the client IP. Keyed on ``X-Real-IP``, then ``request.client.host``.
# The API has two callers and no public port: the edge, which SETS ``X-Real-IP`` from
# the Cloudflare-restored visitor address on every request it proxies (``deploy/
# sikstack.conf`` real_ip + proxy_set_header), overwriting any a client sent; and the
# web, inside the network, which passes on the ``X-Real-IP`` the edge set on the
# request it is serving (``web/src/lib/client-ip.ts``, P78), so a sign-in through the
# web counts its visitor rather than the web container. ``X-Forwarded-For`` is never
# read (P78): the edge appends to what a client sent, so its first hop is the client's
# to choose, and reading it would let a caller pick its own bucket. A directly
# reachable API could be spoofed. Locally (no nginx, direct :8766) there is no such
# header and it falls back to the peer address, which is still a stable per-client key.
#
# GENERIC-401 SAFETY. The check runs before any credential work and keys off the
# IP, never the email, so it cannot leak whether an account exists: unknown-email
# and wrong-password stay byte-identical (both still reach the generic 401); a 429
# is orthogonal and IP-based. The whole function does no ``await``, so under the
# single worker's event loop it runs atomically — no lock is needed.

# key ("<ip>:<path>") -> (window_start_monotonic, count_in_window)
_rate_windows: dict[str, tuple[float, int]] = {}
# Defensive cap so a distributed flood of distinct real IPs cannot grow the dict
# without bound. Well above any plausible legitimate concurrent-client count.
_RATE_MAX_KEYS = 20_000


def _client_ip(request: Request) -> str:
    """The real client IP behind the edge — see the TRUST MODEL note above."""

    real_ip = (request.headers.get("X-Real-IP") or "").strip()
    if real_ip:
        return real_ip
    client = request.client
    return client.host if client else "unknown"


def _prune_rate_windows(now: float, window: float) -> None:
    """Bound memory: drop expired windows, and if still capped, the oldest ones.

    Only does work once the dict is large — expired keys are otherwise rolled over
    lazily on access, so this is purely a defensive memory bound, not correctness.
    """

    if len(_rate_windows) < _RATE_MAX_KEYS:
        return
    for key in [k for k, (start, _) in _rate_windows.items() if now - start >= window]:
        del _rate_windows[key]
    if len(_rate_windows) >= _RATE_MAX_KEYS:
        # An active flood from many live IPs. Drop the oldest half; the worst case
        # is a few counters resetting early, which only ever UNDER-counts.
        oldest = sorted(_rate_windows, key=lambda k: _rate_windows[k][0])
        for key in oldest[: _RATE_MAX_KEYS // 2]:
            del _rate_windows[key]


def _enforce_rate_limit(request: Request) -> None:
    """Fixed-window per-IP throttle for ``signup``/``login``; raise 429 when tripped.

    The limit and window are read at call time (``config._env`` pattern) so a test
    or the smoke can force a low value via the env. A tripped request answers 429
    with a generic body and a ``Retry-After`` header (seconds until the window
    resets), never touching the DB or the credential path.
    """

    limit = config.auth_rate_limit()
    if limit <= 0:  # disabled
        return
    window = float(config.auth_rate_window_s())
    now = time.monotonic()
    _prune_rate_windows(now, window)

    key = f"{_client_ip(request)}:{request.url.path}"
    start, count = _rate_windows.get(key, (now, 0))
    if now - start >= window:  # window rolled over
        start, count = now, 0
    count += 1
    _rate_windows[key] = (start, count)

    if count > limit:
        retry_after = max(1, int(window - (now - start)))
        raise HTTPException(
            status_code=429,
            detail="too many requests — please retry later",
            headers={"Retry-After": str(retry_after)},
        )


class _EmailPasswordInput(BaseModel):
    """Shared email + password shape for signup and login."""

    email: str
    password: str = Field(min_length=8)
    #: An org invite's code, carried from the ``/invite`` page (``server.invites``).
    invite: str | None = Field(default=None, max_length=200)

    @field_validator("email")
    @classmethod
    def _normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized:
            raise ValueError("must not be blank")
        if "@" not in normalized:
            raise ValueError("must be a valid email address")
        return normalized


class SignupIn(_EmailPasswordInput):
    """Signup request body: the email must be exactly one plain address.

    Checked after the shared trim + lowercase, before any row exists or any mail
    goes (``server.email_address``); anything else is the standard 422.
    """

    @field_validator("email")
    @classmethod
    def _one_plain_address(cls, value: str) -> str:
        if not is_plain_address(value):
            raise ValueError("must be one plain email address, like you@example.com")
        return value


class LoginIn(_EmailPasswordInput):
    """Login request body.

    Deliberately not narrowed to one plain address: an account stored before that
    rule must still sign in, and a string that matches no account gets the same
    generic 401 as any unknown email.
    """


def serialize_user(record: UserRecord) -> dict[str, object]:
    """Serialize a user for a response (never exposes ``password_hash``)."""

    return {
        "id": str(record.id),
        "email": record.email,
        "created_at": record.created_at.isoformat(),
    }


def serialize_tenant(record: TenantRecord) -> dict[str, object]:
    """Serialize a tenant for a response.

    The canonical tenant shape — signup, login, ``/auth/me`` and ``/app/tenant`` all
    go through here, so the additive ``slug`` (``None`` until the tenant claims one)
    and ``plan`` (``"free"`` by default; read-only over the API) appear on every one
    of them at once.
    """

    return {
        "id": str(record.id),
        "name": record.name,
        "slug": record.slug,
        "plan": record.plan,
        "created_at": record.created_at.isoformat(),
    }


def serialize_project(record: ProjectRecord) -> dict[str, object]:
    """Serialize a project for a response.

    Mirrors ``server.app_api.serialize_project`` (the canonical project serializer)
    byte-for-byte so signup can return its new default project without importing
    ``app_api`` — which imports ``serialize_tenant`` back from this module, so the
    dependency has to point one way.
    """

    return {
        "id": str(record.id),
        "name": record.name,
        "tenant_id": str(record.tenant_id),
        "visibility": record.visibility,
        "created_at": record.created_at.isoformat(),
    }


async def _mint_token(user_id: UUID) -> str:
    """Mint an opaque bearer token, store its hash, and return the raw token."""

    raw_token = generate_opaque_token()
    await get_accounts_service().create_auth_token(
        CreateAuthToken(
            user_id=user_id,
            token_hash=sha256_hex(raw_token),
            expires_at=utc_now() + SESSION_TTL,
        )
    )
    return raw_token


@router.post("/auth/signup", status_code=201)
async def signup(
    payload: SignupIn,
    request: Request,
    response: Response,
    background_tasks: BackgroundTasks,
) -> dict[str, object]:
    """Create a user with an org and its owner membership; mint a token.

    The org is named ``"Personal"`` and holds no project (``provision_signup``); the
    response keeps its ``project`` key as ``null`` alongside the ``tenant`` (the
    ``/auth/*`` contract is frozen, so signup's shape only gains fields and never
    loses one).

    With ``KB_SIGNUP_WAITLIST`` on, the account (and its org and project) is created
    ``waitlisted``, no token is minted, and the answer is ``202 {"status":
    "waitlisted", "email": ...}``; the waitlist mail goes after the response,
    best-effort. Off (the default), the answer is the 201 above, unchanged.
    """

    _enforce_rate_limit(request)
    service = get_accounts_service()
    waitlisted = config.signup_waitlist_enabled()
    try:
        user = await service.create_user(
            CreateUser(
                email=payload.email,
                password_hash=hash_password(payload.password),
                status=USER_WAITLISTED if waitlisted else USER_APPROVED,
            )
        )
    except DuplicateEmailError:
        raise HTTPException(
            status_code=409, detail="a user with this email already exists"
        )

    tenant, _member = await service.provision_signup(user.id)
    joined = None
    if payload.invite:
        result = await invites.accept(user, payload.invite, approve=True)
        if result.accepted:
            joined, waitlisted = result.tenant, False
    if waitlisted:
        response.status_code = 202
        background_tasks.add_task(notify_waitlisted, user.email)
        background_tasks.add_task(alert_waitlist_signup, user.email)
        return waitlisted_body(user.email)

    token = await _mint_token(user.id)

    body: dict[str, object] = {
        "token": token,
        "user": serialize_user(user),
        "tenant": serialize_tenant(tenant),
        "project": None,
    }
    if joined is not None:
        body["joined"] = serialize_tenant(joined)
    return body


@router.post("/auth/login")
async def login(payload: LoginIn, request: Request, response: Response) -> dict[str, object]:
    """Verify credentials and mint a session token.

    Answers an identical generic 401 for an unknown email and a wrong password
    so callers cannot enumerate registered accounts. The per-IP throttle runs
    first and keys off the IP alone, so it never perturbs that generic 401.

    The password is checked first, so only someone who knows it learns an account
    is waitlisted: the right password on a ``waitlisted`` account answers ``403
    {"detail": "waitlisted", "status": "waitlisted", "email": ...}`` and mints no
    token, whatever ``KB_SIGNUP_WAITLIST`` says.
    """

    _enforce_rate_limit(request)
    service = get_accounts_service()
    user = await service.get_user_by_email(payload.email)
    if user is None or not verify_password(user.password_hash, payload.password):
        raise HTTPException(status_code=401, detail=_INVALID_CREDENTIALS)
    joined = None
    if not user.is_approved:
        result = (
            await invites.accept(user, payload.invite, approve=True)
            if payload.invite
            else None
        )
        if result is None or not result.accepted:
            response.status_code = 403
            return {"detail": USER_WAITLISTED, **waitlisted_body(user.email)}
        joined = result.tenant

    token = await _mint_token(user.id)
    tenants = await service.list_tenants_for_user(user.id)

    body: dict[str, object] = {
        "token": token,
        "user": serialize_user(user),
        "tenants": [serialize_tenant(tenant) for tenant in tenants],
    }
    if joined is not None:
        body["joined"] = serialize_tenant(joined)
    return body


@router.post("/auth/logout", status_code=204)
async def logout(request: Request) -> Response:
    """Revoke the presented session token (idempotent; no auth required)."""

    token = extract_bearer_token(request)
    if token is not None:
        await get_accounts_service().delete_auth_token(sha256_hex(token))
    return Response(status_code=204)


@router.get("/auth/me")
async def me(context: AuthContext = Depends(require_user)) -> dict[str, object]:
    """Return the authenticated caller, their tenants and the one this request acts in.

    ``tenants`` keeps its oldest-first order (the CLI reads ``tenants[0]``);
    ``active_tenant_id`` is the tenant ``require_user`` picked for this request (the
    ``X-Sikstack-Org`` header's org, else the first).
    """

    tenants = await get_accounts_service().list_tenants_for_user(context.user.id)

    return {
        "user": serialize_user(context.user),
        "tenants": [serialize_tenant(tenant) for tenant in tenants],
        "active_tenant_id": str(context.tenant.id),
    }
