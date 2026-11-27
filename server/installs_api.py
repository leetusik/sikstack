"""sikstack installs: registration, sign-in from the machine, the connect page's calls, install Feedback.

The sikstack plugin works with no account. ``/sikstack:setup`` registers the machine
(an *install*); ``/sikstack:sign-in`` later claims it for an account through a short
code the person confirms on the web, in the shape of a device authorization (RFC
8628's flow, not its wire format). Routes:

- ``POST /api/installs {install_id, email, plugin_version}`` (no auth): the pre-user
  row. Idempotent per install id: a second call updates the email and version and
  the last-seen time; nothing else is stored. ``200 {"status": "registered"}``.
- ``POST /api/installs/sign-in {install_id, repo, plugin_version, release?}`` (no
  auth): start. Refused (404) for an install id never registered. Answers ``{code,
  url, poll_token, expires_in, interval}``: the code is 8 characters in two groups of
  four (``KQ4M-7TZP``) from an alphabet without look-alikes, the url is the web's
  ``/connect?code=…`` (``KB_PUBLIC_BASE_URL``), the poll token is the plugin's to
  keep (only its sha256 is stored), the code lives ``CODE_TTL`` (15 minutes) and the
  plugin polls every ``POLL_INTERVAL_S`` seconds. ``release: true``
  (``/sikstack:sign-in release``) also frees the install, in the transaction that
  makes the code: its claim (``claimed_by``, ``claimed_at``) is cleared and its other
  pending codes end (they read ``expired``), so the next Connect claims it for the
  account that approves; projects, keys and decided codes stay. The answer then
  carries ``released`` (whether a claim was cleared) and never names the previous
  account: the install id is the only credential, the trust a start already gives
  it. ``release`` absent or ``false`` is a plain start; any other value is a 400.
- ``POST /api/installs/sign-in/poll {poll_token}`` (the token is the auth):
  ``{"status": "pending" | "denied" | "expired" | "approved"}``. A poll sooner than
  the interval after the last one is a 429 (``slow_down``). The first poll after an
  approval mints the project's ``workspace`` key and carries it, with ``org_id``,
  ``project_id``, ``project_name`` and ``web_url``; every later poll answers
  ``approved`` without it. The key is minted when the machine collects it, so its
  plaintext never rests on the server.
- ``GET /app/connect/{code}`` (a session, or none): what the connect page draws.
  ``state`` is ``out`` (signed out, the code pending: the install's facts, its setup
  email among them), ``ready`` (signed in, the code pending: the facts, the account
  and its orgs, each with the name of the new project a Connect there makes),
  ``already`` (this account approved this code), ``other`` (the install
  belongs to another account), ``declined`` (this account declined this code) or
  ``expired`` (unknown, expired, or used, and every signed-out read of a used code).
  Signed out it is rate-limited per client address, since it shows the setup email.
- ``POST /app/connect/{code}/approve {org_id?}`` (a session): claim. The install
  becomes this account's (its row records the claimer and the time; an install
  another account claimed is a 403 ``other``), a new project is made for the repo in
  the picked org, or the account's only one, and the code is approved. The project is
  named after the repo's folder, made unique in the org (``app``, then ``app-2``): an
  approval never joins a project that exists, since a folder name says nothing about
  which repo it is (two repos named ``app``, or one named ``default``). The same repo
  signing in again (its key lost) gets a new project too, named on the page before
  Connect. An expired or unknown code is a 410 and changes nothing.
- ``POST /app/connect/{code}/decline`` (a session): the code is denied; nothing else
  changes.
- ``POST /api/installs/feedback {install_id, message, plugin_version}`` (the install
  id is the key): ``/sikstack:feedback``'s report, from an install that need not be
  signed in. It lands in the project ``KB_INSTALL_FEEDBACK_PROJECT_ID`` names (the
  route is dormant, 404, without it), tagged ``sikstack`` and ``install:<id>``; a
  claimed install's report carries its account. Limited per client address (the
  Feedback capture limit) and per install (``KB_INSTALL_FEEDBACK_RATE_LIMIT``).

An install is claimed only by a signed-in account's approval of one of its codes:
the setup email is shown on the connect page and stored, and never matched to an
account. Every route answers 404 without ``DATABASE_URL``, as Feedback does. Bodies
are read under ``MAX_BODY_BYTES`` (the report: the Feedback cap) and parsed by hand.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from server import config, project_names
from server.accounts.auth import AuthContext, optional_user, require_user
from server.accounts.security import generate_opaque_token, sha256_hex
from server.accounts.service import get_accounts_service
from server.accounts.types import CREDENTIAL_SCOPE_WORKSPACE
from server.api_auth import get_tenant_one_id
from server.auth_api import _client_ip
from server.feedback.notify import notify_feedback_captured
from server.feedback.service import FeedbackPersistenceError, get_feedback_service
from server.feedback.types import CreateFeedbackEvent
from server.persistence.engine import get_session_maker
from server.persistence.models import (
    InstallModel,
    InstallSignInModel,
    ProjectCredentialModel,
    ProjectModel,
    utc_now,
)

logger = logging.getLogger(__name__)

router = APIRouter()

#: 29 characters, none that reads as another: no 0/O, 1/I/L or U/V.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZ23456789"
CODE_LENGTH = 8
CODE_TTL = timedelta(minutes=15)
POLL_INTERVAL_S = 5
#: A poll this much sooner than the interval still counts as on time (clock and network jitter).
POLL_SLACK_S = 1.0
MAX_BODY_BYTES = 4096
MAX_REPORT_CHARS = 4000

STATE_PENDING = "pending"
STATE_APPROVED = "approved"
STATE_DENIED = "denied"

_INSTALL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
_VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+_-]{0,49}")
_NOT_REGISTERED = "this install is not registered: run /sikstack:setup"


# --- small helpers ------------------------------------------------------------


def _require_accounts_plane() -> None:
    if config.database_url() is None:
        raise HTTPException(status_code=404, detail="Not Found")


def _bad(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


# key -> (window_start_monotonic, count). One uvicorn worker (server/main.py), so an
# in-process counter is coherent, like the /auth/* and Feedback limiters.
_rate_windows: dict[str, tuple[float, int]] = {}
_RATE_MAX_KEYS = 20_000


def _take(bucket: str, limit: int, window_s: int) -> None:
    """Count one request in ``bucket``; 429 past ``limit`` in the fixed window."""

    if limit <= 0:
        return
    now = time.monotonic()
    if len(_rate_windows) >= _RATE_MAX_KEYS:
        for key in [k for k, (start, _) in _rate_windows.items() if now - start >= window_s]:
            del _rate_windows[key]
        if len(_rate_windows) >= _RATE_MAX_KEYS:
            for key in sorted(_rate_windows, key=lambda k: _rate_windows[k][0])[: _RATE_MAX_KEYS // 2]:
                del _rate_windows[key]
    start, count = _rate_windows.get(bucket, (now, 0))
    if now - start >= window_s:
        start, count = now, 0
    count += 1
    _rate_windows[bucket] = (start, count)
    if count > limit:
        raise HTTPException(
            status_code=429,
            detail="too many requests — please retry later",
            headers={"Retry-After": str(max(1, int(window_s - (now - start))))},
        )


def _take_address(request: Request, route: str) -> None:
    _take(f"{route}:ip:{_client_ip(request)}", config.install_rate_limit(), config.install_rate_window_s())


async def _json_body(request: Request, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any]:
    """The JSON object sent, read under ``max_bytes`` (413 past it, 400 when malformed)."""

    too_large = HTTPException(status_code=413, detail=f"request body must not exceed {max_bytes} bytes")
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > max_bytes:
                raise too_large
        except ValueError:
            raise _bad("invalid Content-Length") from None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise too_large
        chunks.append(chunk)
    try:
        body = json.loads(b"".join(chunks) or b"null")
    except ValueError:
        raise _bad("request body must be valid JSON") from None
    if not isinstance(body, dict):
        raise _bad("request body must be a JSON object")
    return body


def _text(body: dict[str, Any], name: str, pattern: re.Pattern[str] | None = None, max_len: int = 200) -> str:
    value = body.get(name)
    if not isinstance(value, str) or not value.strip():
        raise _bad(f"{name} is required")
    value = value.strip()
    if len(value) > max_len or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        raise _bad(f"{name} is not valid")
    if pattern is not None and not pattern.fullmatch(value):
        raise _bad(f"{name} is not valid")
    return value


def _email(body: dict[str, Any]) -> str:
    value = _text(body, "email", max_len=320).lower()
    local, _, domain = value.partition("@")
    if not local or "." not in domain or any(ch.isspace() for ch in value) or "@" in domain:
        raise _bad("email is not valid")
    return value


def shown_code(code: str) -> str:
    """``KQ4M7TZP`` as people read it, ``KQ4M-7TZP``."""

    return f"{code[:4]}-{code[4:]}"


def normalize_code(raw: str) -> str | None:
    """The stored form of a code as typed or carried (case, hyphen and spaces ignored), or None."""

    code = re.sub(r"[\s-]+", "", raw or "").upper()
    if len(code) != CODE_LENGTH or any(ch not in CODE_ALPHABET for ch in code):
        return None
    return code


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _expired(row: InstallSignInModel, now: datetime) -> bool:
    return row.state == STATE_PENDING and row.expires_at <= now


def shown_install_id(install_id: str) -> str:
    """An install id as the connect page shows it: its first four, an ellipsis, its last four."""

    return install_id if len(install_id) <= 9 else f"{install_id[:4]}…{install_id[-4:]}"


def _web_url(path: str) -> str:
    return f"{config.public_base_url()}{path}"


async def _free_project_name(session, org: UUID, repo: str) -> str:
    """The name a Connect in ``org`` gives the repo's new project: the folder's name, or the
    first of ``<name>-2``, ``<name>-3``, ... that no project in the org has.

    Every name stays inside the shared rule (``project_names.PROJECT_NAME_MAX``): the
    folder's name is cut to make room for the suffix. In tenant #1 a tracked ``docs/``
    folder's name counts as taken (``project_names.reserved_for_tenant_one``), so the
    repo ``assets`` connects as ``assets-2`` there."""

    taken = set((await session.execute(select(ProjectModel.name).where(ProjectModel.tenant_id == org))).scalars())
    tenant_one = org == await get_tenant_one_id()

    def free(name: str) -> bool:
        return name not in taken and not (tenant_one and project_names.reserved_for_tenant_one(name))

    limit = project_names.PROJECT_NAME_MAX
    if free(repo[:limit]):
        return repo[:limit]
    n = 2
    while True:
        suffix = f"-{n}"
        name = f"{repo[: limit - len(suffix)]}{suffix}"
        if free(name):
            return name
        n += 1


# --- registration ---------------------------------------------------------------


@router.post("/api/installs")
async def register_install(request: Request) -> dict[str, str]:
    """Keep the pre-user row: exactly the install id, the email and the plugin version (plus times)."""

    _require_accounts_plane()
    _take_address(request, "installs")
    body = await _json_body(request)
    install_id = _text(body, "install_id", _INSTALL_ID, 100)
    email = _email(body)
    version = _text(body, "plugin_version", _VERSION, 50)
    now = utc_now()
    statement = pg_insert(InstallModel).values(
        install_id=install_id, email=email, plugin_version=version, created_at=now, last_seen_at=now
    )
    statement = statement.on_conflict_do_update(
        index_elements=[InstallModel.install_id],
        set_={"email": email, "plugin_version": version, "last_seen_at": now},
    )
    async with get_session_maker()() as session, session.begin():
        await session.execute(statement)
    return {"status": "registered"}


# --- sign-in from the machine ---------------------------------------------------


@router.post("/api/installs/sign-in")
async def start_sign_in(request: Request) -> dict[str, object]:
    """Start a sign-in for a registered install: a code to confirm on the web and a token to poll with."""

    _require_accounts_plane()
    _take_address(request, "sign-in")
    body = await _json_body(request)
    install_id = _text(body, "install_id", _INSTALL_ID, 100)
    repo = _text(body, "repo", max_len=1000)
    if len(repo) > project_names.PROJECT_NAME_MAX:  # the repo's name becomes its project's
        raise _bad(project_names.PROJECT_NAME_LENGTH_ERROR)
    version = _text(body, "plugin_version", _VERSION, 50)
    release = body.get("release", False)
    if not isinstance(release, bool):
        raise _bad("release is not valid")
    poll_token = generate_opaque_token()
    now = utc_now()
    released: bool | None = None
    async with get_session_maker()() as session, session.begin():
        install = (
            await session.execute(select(InstallModel).where(InstallModel.install_id == install_id))
        ).scalar_one_or_none()
        if install is None:
            raise HTTPException(status_code=404, detail=_NOT_REGISTERED)
        if release:
            # Lock in an approval's order (its code, then the install), so the two never deadlock:
            # an approval that commits first is cleared here; one that waits reads the time only once it
            # holds the code, after this commit, so it finds its code ended.
            pending = (
                await session.execute(
                    select(InstallSignInModel)
                    .where(InstallSignInModel.install_id == install.id, InstallSignInModel.state == STATE_PENDING)
                    .with_for_update()
                )
            ).scalars()
            for row in pending:
                if row.expires_at > now:
                    row.expires_at = now
            install = (
                await session.execute(
                    select(InstallModel)
                    .where(InstallModel.id == install.id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            ).scalar_one()
            released = install.claimed_by is not None
            install.claimed_by = None
            install.claimed_at = None
        install.last_seen_at = now
        install.plugin_version = version
        for _ in range(8):
            code = _new_code()
            taken = (
                await session.execute(select(InstallSignInModel.id).where(InstallSignInModel.code == code))
            ).first()
            if taken is None:
                break
        else:  # pragma: no cover - 30^8 codes
            raise HTTPException(status_code=503, detail="no code is free right now — please retry")
        session.add(
            InstallSignInModel(
                install_id=install.id,
                code=code,
                poll_token_hash=sha256_hex(poll_token),
                repo_name=repo,
                plugin_version=version,
                state=STATE_PENDING,
                created_at=now,
                expires_at=now + CODE_TTL,
            )
        )
    answer: dict[str, object] = {
        "code": shown_code(code),
        "url": _web_url(f"/connect?code={shown_code(code)}"),
        "poll_token": poll_token,
        "expires_in": int(CODE_TTL.total_seconds()),
        "interval": POLL_INTERVAL_S,
    }
    if released is not None:
        answer["released"] = released
    return answer


@router.post("/api/installs/sign-in/poll")
async def poll_sign_in(request: Request) -> JSONResponse:
    """The sign-in's state for the plugin; the first poll after an approval carries the workspace key, once."""

    _require_accounts_plane()
    body = await _json_body(request)
    token = _text(body, "poll_token", max_len=200)
    now = utc_now()
    async with get_session_maker()() as session, session.begin():
        row = (
            await session.execute(
                select(InstallSignInModel)
                .where(InstallSignInModel.poll_token_hash == sha256_hex(token))
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            return JSONResponse({"status": "expired"}, status_code=404)
        last = row.last_poll_at
        if last is not None and (now - last).total_seconds() < POLL_INTERVAL_S - POLL_SLACK_S:
            return JSONResponse(
                {"status": "slow_down", "detail": f"poll at most every {POLL_INTERVAL_S} seconds"},
                status_code=429,
                headers={"Retry-After": str(POLL_INTERVAL_S)},
            )
        row.last_poll_at = now
        if _expired(row, now):
            return JSONResponse({"status": "expired"})
        if row.state == STATE_DENIED:
            return JSONResponse({"status": "denied"})
        if row.state != STATE_APPROVED:
            return JSONResponse({"status": "pending"})
        project = await session.get(ProjectModel, row.project_id) if row.project_id else None
        if project is None:  # the project was deleted after the approval: nothing to link
            return JSONResponse({"status": "expired"})
        answer: dict[str, object] = {
            "status": "approved",
            "org_id": str(project.tenant_id),
            "project_id": str(project.id),
            "project_name": project.name,
            "web_url": _web_url(f"/projects/{project.id}/workspace"),
        }
        if row.delivered_at is None:
            row.delivered_at = now
            key = f"vk_{generate_opaque_token()}"
            session.add(
                ProjectCredentialModel(
                    tenant_id=project.tenant_id,
                    project_id=project.id,
                    name=f"sikstack sign-in ({row.repo_name})"[:200],
                    token_prefix=key[:12],
                    token_hash=sha256_hex(key),
                    scope=CREDENTIAL_SCOPE_WORKSPACE,
                    created_at=now,
                )
            )
            answer["key"] = key
    return JSONResponse(answer)


# --- the connect page (through the web's BFF) ----------------------------------


async def _sign_in_by_code(session, code: str | None, *, lock: bool = False):
    if code is None:
        return None, None
    query = select(InstallSignInModel).where(InstallSignInModel.code == code)
    if lock:
        query = query.with_for_update()
    row = (await session.execute(query)).scalar_one_or_none()
    if row is None:
        return None, None
    query = select(InstallModel).where(InstallModel.id == row.install_id)
    if lock:
        query = query.with_for_update()
    install = (await session.execute(query)).scalar_one()
    return row, install


def _install_facts(install: InstallModel) -> dict[str, object]:
    return {
        "id": shown_install_id(install.install_id),
        "version": install.plugin_version,
        "set_up": install.created_at.isoformat(),
        "email": install.email,
    }


@router.get("/app/connect/{code}")
async def read_connect(code: str, request: Request, ctx: AuthContext | None = Depends(optional_user)) -> dict[str, object]:
    """What the connect page shows for ``code`` and this session (see the module docstring)."""

    _require_accounts_plane()
    if ctx is None:
        _take_address(request, "connect-read")
    else:
        _take(f"connect-read:user:{ctx.user.id}", config.install_rate_limit(), config.install_rate_window_s())
    stored = normalize_code(code)
    now = utc_now()
    async with get_session_maker()() as session:
        row, install = await _sign_in_by_code(session, stored)
    shown = shown_code(stored) if stored else code[:20]
    gone: dict[str, object] = {"state": "expired", "code": shown}
    if row is None or _expired(row, now):
        return gone
    if ctx is None:
        if row.state != STATE_PENDING:
            return gone
        return {"state": "out", "code": shown, "install": _install_facts(install), "project": {"name": row.repo_name}}
    me = ctx.user.id
    if install.claimed_by is not None and install.claimed_by != me:
        return {"state": "other", "code": shown}
    if row.state == STATE_APPROVED:
        if row.decided_by != me:
            return {"state": "other", "code": shown}
        async with get_session_maker()() as session:
            made = await session.get(ProjectModel, row.project_id) if row.project_id else None
        project = {"id": str(made.id), "name": made.name} if made else {"id": None, "name": row.repo_name}
        return {"state": "already", "code": shown, "project": project}
    if row.state == STATE_DENIED:
        return {"state": "declined", "code": shown} if row.decided_by == me else gone
    tenants = await get_accounts_service().list_tenants_for_user(me)
    async with get_session_maker()() as session:
        orgs = [
            {"id": str(t.id), "name": t.name, "project": await _free_project_name(session, t.id, row.repo_name)}
            for t in tenants
        ]
    return {
        "state": "ready",
        "code": shown,
        "install": _install_facts(install),
        "account": {"email": ctx.user.email, "orgs": orgs},
        # The project a Connect in the first org makes (the page names the picked org's).
        "project": {"name": orgs[0]["project"] if orgs else row.repo_name},
    }


async def _session_body(request: Request) -> dict[str, Any]:
    if not request.headers.get("content-length") and request.headers.get("transfer-encoding") is None:
        return {}
    return await _json_body(request)


@router.post("/app/connect/{code}/approve")
async def approve_connect(code: str, request: Request, ctx: AuthContext = Depends(require_user)) -> dict[str, object]:
    """Claim the install for this account and make the repo a new project; the code becomes approved."""

    _require_accounts_plane()
    body = await _session_body(request)
    tenants = await get_accounts_service().list_tenants_for_user(ctx.user.id)
    wanted = body.get("org_id")
    if wanted is not None:
        try:
            org = UUID(str(wanted))
        except ValueError:
            raise _bad("org_id is not valid") from None
        if org not in {t.id for t in tenants}:
            raise HTTPException(status_code=403, detail="not a member of that org")
    elif len(tenants) == 1:
        org = tenants[0].id
    else:
        raise _bad("pick the org to connect this install to (org_id)")
    stored = normalize_code(code)
    async with get_session_maker()() as session, session.begin():
        row, install = await _sign_in_by_code(session, stored, lock=True)
        # The time is read once the code and the install are held: a release this waited on ended the code at
        # its own earlier reading, so the code reads as ended here.
        now = utc_now()
        if row is None or row.state != STATE_PENDING or _expired(row, now):
            raise HTTPException(status_code=410, detail="this code no longer works")
        if install.claimed_by is not None and install.claimed_by != ctx.user.id:
            raise HTTPException(status_code=403, detail="this install is connected to another account")
        # Always a new project: a name another approval took meanwhile is skipped, never joined.
        project_id = None
        for _ in range(8):
            name = await _free_project_name(session, org, row.repo_name)
            project_id = (
                await session.execute(
                    pg_insert(ProjectModel)
                    .values(tenant_id=org, name=name, created_at=now)
                    .on_conflict_do_nothing(index_elements=[ProjectModel.tenant_id, ProjectModel.name])
                    .returning(ProjectModel.id)
                )
            ).scalar_one_or_none()
            if project_id is not None:
                break
        else:  # pragma: no cover - eight approvals racing for one name
            raise HTTPException(status_code=503, detail="could not make the project right now — please retry")
        project = await session.get(ProjectModel, project_id)
        if install.claimed_by is None:
            install.claimed_by = ctx.user.id
            install.claimed_at = now
        install.last_seen_at = now
        row.state = STATE_APPROVED
        row.decided_by = ctx.user.id
        row.decided_at = now
        row.tenant_id = org
        row.project_id = project.id
        answer = {"state": "connected", "org_id": str(org), "project": {"id": str(project.id), "name": project.name}}
    return answer


@router.post("/app/connect/{code}/decline")
async def decline_connect(code: str, ctx: AuthContext = Depends(require_user)) -> dict[str, str]:
    """Deny the code; the install and every project stay as they were."""

    _require_accounts_plane()
    stored = normalize_code(code)
    async with get_session_maker()() as session, session.begin():
        row, install = await _sign_in_by_code(session, stored, lock=True)
        # The time is read once the code and the install are held: a release this waited on ended the code at
        # its own earlier reading, so the code reads as ended here.
        now = utc_now()
        if row is None or row.state != STATE_PENDING or _expired(row, now):
            raise HTTPException(status_code=410, detail="this code no longer works")
        if install.claimed_by is not None and install.claimed_by != ctx.user.id:
            raise HTTPException(status_code=403, detail="this install is connected to another account")
        row.state = STATE_DENIED
        row.decided_by = ctx.user.id
        row.decided_at = now
    return {"state": "declined"}


# --- an install's Feedback ------------------------------------------------------


@router.post("/api/installs/feedback")
async def install_feedback(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    """Take ``/sikstack:feedback``'s report from a registered install into the configured project."""

    _require_accounts_plane()
    destination = config.install_feedback_project_id()
    if destination is None:
        raise HTTPException(status_code=404, detail="Not Found")
    _take(f"install-feedback:ip:{_client_ip(request)}", config.feedback_rate_limit(), config.feedback_rate_window_s())
    body = await _json_body(request, config.feedback_max_body_bytes())
    install_id = _text(body, "install_id", _INSTALL_ID, 100)
    version = _text(body, "plugin_version", _VERSION, 50)
    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        raise _bad("message is required")
    message = message.strip()
    if len(message) > MAX_REPORT_CHARS:
        raise _bad(f"message must not exceed {MAX_REPORT_CHARS} characters")
    _take(
        f"install-feedback:install:{install_id}",
        config.install_feedback_rate_limit(),
        config.install_rate_window_s(),
    )
    try:
        project_id = UUID(destination)
    except ValueError:
        logger.error("KB_INSTALL_FEEDBACK_PROJECT_ID is not a project id")
        raise HTTPException(status_code=404, detail="Not Found") from None
    async with get_session_maker()() as session, session.begin():
        install = (
            await session.execute(select(InstallModel).where(InstallModel.install_id == install_id))
        ).scalar_one_or_none()
        if install is None:
            raise HTTPException(status_code=404, detail=_NOT_REGISTERED)
        project = await session.get(ProjectModel, project_id)
        await session.execute(
            update(InstallModel).where(InstallModel.id == install.id).values(last_seen_at=utc_now())
        )
        claimed_by = install.claimed_by
    if project is None:
        logger.error("KB_INSTALL_FEEDBACK_PROJECT_ID names no project")
        raise HTTPException(status_code=404, detail="Not Found")
    attributes: dict[str, Any] = {"install_id": install_id, "plugin_version": version}
    user_id = None
    if claimed_by is not None:
        account = await get_accounts_service().get_user_by_id(claimed_by)
        user_id = str(claimed_by)
        if account is not None:
            attributes["account_email"] = account.email
    event = CreateFeedbackEvent(
        message=message,
        source_product="sikstack",
        source_integration="plugin",
        project_id=project_id,
        recorded_by="agent",
        user_id=user_id,
        tags=("sikstack", f"install:{install_id}"),
        attributes=attributes,
    )
    try:
        record = await get_feedback_service().create_feedback_event_with_attachments(event)
    except FeedbackPersistenceError:
        logger.exception("Failed to persist an install's feedback")
        raise HTTPException(status_code=500, detail="storage write failed") from None
    background_tasks.add_task(notify_feedback_captured, record)
    accepted = record.ingested_at.astimezone(UTC).isoformat() if isinstance(record.ingested_at, datetime) else None
    return JSONResponse({"request_id": str(record.id), "accepted_at": accepted, "status": "accepted"}, status_code=202)
