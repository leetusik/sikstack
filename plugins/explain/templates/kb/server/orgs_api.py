"""Orgs, members and invites: the session routes behind the web's org pages.

Every route but the invite's read needs a session (``require_user``) and acts in the
session's active org (``X-Sikstack-Org``, else the first). An org's ``owner`` (who
made it) renames it, invites and revokes; a ``member`` (who joined by an invite)
reads its members. Routes:

- ``POST /app/orgs {name}``: a new org named ``name`` (1 to ``ORG_NAME_MAX``
  characters once trimmed, no control character; else 422), the caller its owner,
  with one project ``default``, as at sign-up. A name one of the caller's orgs has
  already (any case) is a 409 ``{"reason": "taken"}``. ``201 {"tenant", "project"}``.
- ``PATCH /app/tenant/name {name}``: rename the active org (owner only, else 403;
  the same name rule). The slug (Public URL) stays ``PATCH /app/tenant``.
- ``GET /app/members``: ``{"role", "members": [{id, email, role, joined_at}]}`` in
  the order they joined; an owner's answer adds ``"invites"``, the pending ones
  (neither used, revoked nor expired), newest first: ``[{id, email, invited_at,
  expires_at}]``. A member's has no ``invites`` key.
- ``POST /app/invites {email}`` (owner only, else 403): an invite for one plain
  address (``server.email_address``; else 422 ``{"reason": "address"}``), refused
  when the address is a member already (409 ``member``) or has a pending invite (409
  ``invited``). The code goes only into one mail to that address, after the response
  (``server.invites.send_invite_mail``); ``201 {"invite": {...}}`` carries no code.
- ``DELETE /app/invites/{id}`` (owner only): revoke, no confirm. 404 for an id that
  is not this org's, 409 for one already used; revoking twice is a 204 again.
- ``GET /app/invite/{code}`` (a session or none): the org's name and the invite's
  state (``valid``, ``expired``, ``revoked``, ``used``); on a valid invite also the
  invited address and the inviter's, which the invite page draws. Signed in, it adds
  ``member`` (and the org's id when true). An unknown code is a 404. Rate-limited like
  the connect read: per client address signed out, per account signed in.
- ``POST /app/invite/{code}/accept`` (a session): ``server.invites.accept``. 200
  ``{"state": "joined" | "member", "tenant"}``; 403 ``{"reason": "other"}`` for an
  account whose email is not the invited one; 410 ``{"state"}`` for an invite that
  no longer works; 404 for an unknown code.

Every route answers 404 without ``DATABASE_URL``, as the install routes do.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select

from server import config, invites
from server.accounts.auth import AuthContext, optional_user, require_owner, require_user
from server.accounts.repository import AccountsRepository
from server.accounts.security import sha256_hex
from server.accounts.service import get_accounts_service
from server.accounts.types import ROLE_MEMBER, ROLE_OWNER
from server.auth_api import serialize_project, serialize_tenant
from server.email_address import is_plain_address
from server.installs_api import _require_accounts_plane, _take, _take_address
from server.persistence.engine import get_session_maker
from server.persistence.models import OrgInviteModel, UserModel, utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

ORG_NAME_MAX = 100


def _check_org_name(value: str) -> str:
    name = value.strip()
    if not name:
        raise ValueError("must not be blank")
    if len(name) > ORG_NAME_MAX:
        raise ValueError(f"must be at most {ORG_NAME_MAX} characters")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
        raise ValueError("must not hold a control character")
    return name


class OrgNameInput(BaseModel):
    """An org's name: 1 to ``ORG_NAME_MAX`` characters once trimmed (else 422)."""

    name: str = Field(max_length=1000)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return _check_org_name(value)


class InviteInput(BaseModel):
    """An invite's address, checked by hand so the refusal can say ``address``."""

    email: str = Field(max_length=1000)


def _refused(status: int, reason: str, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail, "reason": reason}, status_code=status)


async def _name_taken(ctx: AuthContext, name: str, *, besides: UUID | None = None) -> bool:
    tenants = await get_accounts_service().list_tenants_for_user(ctx.user.id)
    wanted = name.casefold()
    return any(t.name.casefold() == wanted and t.id != besides for t in tenants)


def serialize_invite(row: OrgInviteModel) -> dict[str, object]:
    """A pending invite as the owner's list shows it (never its code or hash)."""

    return {
        "id": str(row.id),
        "email": row.email,
        "invited_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat(),
    }


# --- orgs -------------------------------------------------------------------------


@router.post("/app/orgs", status_code=201, response_model=None)
async def create_org(
    payload: OrgNameInput, ctx: AuthContext = Depends(require_user)
) -> dict[str, object] | JSONResponse:
    """Make an org with the caller as its owner and one project ``default``."""

    if await _name_taken(ctx, payload.name):
        return _refused(409, "taken", "you already have an org with that name")
    tenant, _member, project = await get_accounts_service().create_org(ctx.user.id, payload.name)
    return {"tenant": serialize_tenant(tenant), "project": serialize_project(project)}


@router.patch("/app/tenant/name", response_model=None)
async def rename_org(
    payload: OrgNameInput, ctx: AuthContext = Depends(require_user)
) -> dict[str, object] | JSONResponse:
    """Rename the active org (owner only)."""

    await require_owner(ctx)
    if await _name_taken(ctx, payload.name, besides=ctx.tenant.id):
        return _refused(409, "taken", "you already have an org with that name")
    updated = await get_accounts_service().set_tenant_name(ctx.tenant.id, payload.name)
    if updated is None:  # the session's own tenant vanished mid-request
        raise HTTPException(status_code=404, detail="tenant not found")
    return {"tenant": serialize_tenant(updated)}


# --- members and invites ----------------------------------------------------------


def _pending(query, now):
    return query.where(
        OrgInviteModel.accepted_at.is_(None),
        OrgInviteModel.revoked_at.is_(None),
        OrgInviteModel.expires_at > now,
    )


@router.get("/app/members")
async def list_members(ctx: AuthContext = Depends(require_user)) -> dict[str, object]:
    """The active org's members; its pending invites too, for an owner."""

    _require_accounts_plane()
    service = get_accounts_service()
    role = await service.get_member_role(ctx.tenant.id, ctx.user.id)
    members = await service.list_org_members(ctx.tenant.id)
    body: dict[str, object] = {
        "role": role,
        "members": [
            {
                "id": str(m.id),
                "email": m.email,
                "role": m.role,
                "joined_at": m.joined_at.isoformat(),
            }
            for m in members
        ],
    }
    if role == ROLE_OWNER:
        query = _pending(select(OrgInviteModel), utc_now()).where(
            OrgInviteModel.tenant_id == ctx.tenant.id
        )
        async with get_session_maker()() as session:
            rows = (
                await session.execute(
                    query.order_by(OrgInviteModel.created_at.desc(), OrgInviteModel.id)
                )
            ).scalars().all()
        body["invites"] = [serialize_invite(row) for row in rows]
    return body


@router.post("/app/invites", status_code=201, response_model=None)
async def create_invite(
    payload: InviteInput,
    background_tasks: BackgroundTasks,
    ctx: AuthContext = Depends(require_user),
) -> dict[str, object] | JSONResponse:
    """Invite one address into the active org as a member (owner only)."""

    _require_accounts_plane()
    await require_owner(ctx)
    email = invites.normalize_email(payload.email)
    if not is_plain_address(email):
        return _refused(422, "address", "enter one email address, like name@example.com")
    members = await get_accounts_service().list_org_members(ctx.tenant.id)
    if any(m.email.strip().lower() == email for m in members):
        return _refused(409, "member", "that address is a member of this org already")

    now = utc_now()
    code = invites.new_code()
    async with get_session_maker()() as session, session.begin():
        waiting = (
            await session.execute(
                _pending(select(OrgInviteModel.id), now).where(
                    OrgInviteModel.tenant_id == ctx.tenant.id, OrgInviteModel.email == email
                )
            )
        ).first()
        if waiting is not None:
            return _refused(409, "invited", "that address has a pending invite already")
        row = OrgInviteModel(
            tenant_id=ctx.tenant.id,
            email=email,
            role=ROLE_MEMBER,
            token_hash=sha256_hex(code),
            invited_by=ctx.user.id,
            created_at=now,
            expires_at=now + invites.INVITE_TTL,
        )
        session.add(row)
        await session.flush()
        answer = serialize_invite(row)
    background_tasks.add_task(
        invites.send_invite_mail, email, ctx.tenant.name, ctx.user.email, code
    )
    return {"invite": answer}


@router.delete("/app/invites/{invite_id}", status_code=204)
async def revoke_invite(invite_id: UUID, ctx: AuthContext = Depends(require_user)) -> Response:
    """Revoke one of the active org's invites (owner only; no confirm)."""

    _require_accounts_plane()
    await require_owner(ctx)
    async with get_session_maker()() as session, session.begin():
        row = (
            await session.execute(
                select(OrgInviteModel)
                .where(OrgInviteModel.id == invite_id, OrgInviteModel.tenant_id == ctx.tenant.id)
                .with_for_update()
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(status_code=404, detail="invite not found")
        if row.accepted_at is not None:
            raise HTTPException(status_code=409, detail="that invite was used already")
        if row.revoked_at is None:
            row.revoked_at = utc_now()
    return Response(status_code=204)


# --- the invite's link --------------------------------------------------------------


@router.get("/app/invite/{code}")
async def read_invite(
    code: str, request: Request, ctx: AuthContext | None = Depends(optional_user)
) -> dict[str, object]:
    """What the invite page needs for ``code`` (see the module docstring)."""

    _require_accounts_plane()
    if ctx is None:
        _take_address(request, "invite-read")
    else:
        _take(
            f"invite-read:user:{ctx.user.id}",
            config.install_rate_limit(),
            config.install_rate_window_s(),
        )
    async with get_session_maker()() as session:
        row = await invites.find_by_code(session, code)
        if row is None:
            raise HTTPException(status_code=404, detail="invite not found")
        tenant = await AccountsRepository(session).get_tenant(row.tenant_id)
        tenant_name = tenant.name if tenant is not None else None
        inviter = (
            await session.get(UserModel, row.invited_by) if row.invited_by is not None else None
        )
    state = invites.invite_state(row, utc_now())
    body: dict[str, object] = {"state": state, "org": {"name": tenant_name}}
    if state == invites.STATE_VALID:
        body["email"] = row.email
        body["invited_by"] = inviter.email if inviter is not None else None
    if ctx is not None:
        role = await get_accounts_service().get_member_role(row.tenant_id, ctx.user.id)
        body["member"] = role is not None
        if role is not None:
            body["org"] = {"id": str(row.tenant_id), "name": tenant_name}
    return body


@router.post("/app/invite/{code}/accept", response_model=None)
async def accept_invite(
    code: str, ctx: AuthContext = Depends(require_user)
) -> dict[str, object] | JSONResponse:
    """Join the invite's org as ``member`` (the invited address only)."""

    _require_accounts_plane()
    result = await invites.accept(ctx.user, code)
    if result.state == "unknown":
        raise HTTPException(status_code=404, detail="invite not found")
    if result.state == "other":
        return _refused(403, "other", "this invite is for another address")
    if result.state in ("joined", "member"):
        return {"state": result.state, "tenant": serialize_tenant(result.tenant)}
    return JSONResponse(
        {"detail": "this invite no longer works", "state": result.state}, status_code=410
    )
