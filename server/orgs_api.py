"""Orgs, members and invites: the session routes behind the web's org pages.

Every route but the invite's read needs a session (``require_user``) and acts in the
session's active org (``X-Sikstack-Org``, else the first). An org's ``owner`` (who
made it, or was made one) renames it, invites, revokes, removes members, makes a
member an owner and steps an owner (itself included) down to member; a ``member`` (who joined by an invite) reads its members and may
leave. Every account keeps at least one org: when a leave, a removal or the org's
delete ends the account's last membership, the same transaction gives it a fresh org,
as sign-up does
(``Personal``, the account its owner, no project). Routes:

- ``POST /app/orgs {name}``: a new org named ``name`` (1 to ``ORG_NAME_MAX``
  characters once trimmed, no control character; else 422), the caller its owner,
  with no project, as at sign-up. A name one of the caller's orgs has
  already (any case) is a 409 ``{"reason": "taken"}``; an account that made
  ``ORGS_PER_DAY`` orgs with this route in the last day (``tenants.made_by``: an org it
  was made owner of, its sign-up org and a fresh org never count) gets a 429
  ``{"reason": "limit"}``. ``201 {"tenant", "project": null}`` (the ``project`` key
  stays from when the route made one).
- ``PATCH /app/tenant/name {name}``: rename the active org (owner only, else 403;
  the same name rule). The slug (Public URL) stays ``PATCH /app/tenant``.
- ``GET /app/members``: ``{"role", "members": [{id, email, role, joined_at}]}`` in
  the order they joined; an owner's answer adds ``"invites"``, the pending ones
  (neither used, revoked nor expired), newest first: ``[{id, email, invited_at,
  expires_at}]``. A member's has no ``invites`` key.
- ``POST /app/invites {email}`` (owner only, else 403): an invite for one plain
  address (``server.email_address``; else 422 ``{"reason": "address"}``), refused
  when the address is a member already (409 ``member``) or has a pending invite (409
  ``invited``). Each invite is one mail, so invites are bounded (every one counts,
  revoked or not): an account sends at most ``INVITES_PER_HOUR`` an hour and
  ``INVITES_PER_DAY`` a day (else 429 ``{"reason": "limit"}``), and one address gets
  at most ``INVITES_PER_ADDRESS_DAY`` a day from every org together (else 429
  ``{"reason": "recipient"}``). The code goes only into one mail to that address,
  after the response (``server.invites.send_invite_mail``); ``201 {"invite": {...}}``
  carries no code.
- ``DELETE /app/invites/{id}`` (owner only): revoke, no confirm. 404 for an id that
  is not this org's, 409 for one already used; revoking twice is a 204 again.
- ``POST /app/members/{id}/owner`` (owner only; ``id`` is a member row's, as
  listed): the row's role becomes ``owner`` (its ``joined_at`` stays), so an owner can
  hand the org over and then leave. 204; 404 for an id that is not this org's; a row
  that is an owner already is a 204 that changes nothing.
- ``POST /app/members/{id}/member`` (owner only; ``id`` is a member row's, as
  listed): step an owner down, the caller itself included; the row's role becomes
  ``member`` (its ``joined_at`` stays). 204; 404 for an id that is not this org's; a
  row that is a member already is a 204 that changes nothing; 409 ``{"reason":
  "last_owner"}`` when the row is the org's last owner.
- ``DELETE /app/members/{id}`` (owner only; ``id`` is a member row's, as listed):
  the member is out of the org at once (its next request naming the org is the
  ``X-Sikstack-Org`` 403), and gets a fresh org when this was its only one. 204; 404
  for an id that is not this org's; 409 ``{"reason": "last_owner"}`` for the org's
  last owner.
- ``POST /app/tenant/leave``: the caller leaves the active org, and gets a fresh org
  when this was its only one. 204; 409 ``{"reason": "last_owner"}`` for its last owner.
- ``DELETE /app/tenant {name}`` (owner only, else 403): delete the active org and
  everything in it for good (``server.deletion``), ``name`` its name typed again (a
  missing one is a 422, another a 409 ``{"reason": "name"}``). Every member whose only
  org it was, the caller included, gets a fresh org in the same transaction. 409
  ``{"reason": "tenant_one"}`` for the instance's own org (it holds ``docs/`` and the
  master token) and ``install_feedback`` for the org holding the install-feedback
  project. ``200 {"tenant"}``: the caller's first org afterwards.
- ``GET /app/invite/{code}`` (a session or none): the org's name and the invite's
  state (``valid``, ``expired``, ``revoked``, ``used``); on a valid invite also the
  invited address and the inviter's, which the invite page draws. Signed in, it adds
  ``member`` (and the org's id when true). An unknown code is a 404. Rate-limited like
  the connect read: per client address signed out, per account signed in.
- ``POST /app/invite/{code}/accept`` (a session): ``server.invites.accept``. 200
  ``{"state": "joined" | "member", "tenant"}``; 403 ``{"reason": "other"}`` for an
  account whose email is not the invited one; 410 ``{"state"}`` for an invite that
  no longer works; 404 for an unknown code.

Make owner, Step down and Remove check the caller's role twice: before (``require_owner``) and
again among the rows they lock, so an owner removed while its act waits on the lock gets
a 403 and nothing changes. Invite and revoke check it once: a late invite from a removed
owner stays revocable by any owner left.

Every route answers 404 without ``DATABASE_URL``, as the install routes do.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, or_, select, text, update
from starlette.concurrency import run_in_threadpool

from server import config, deletion, invites
from server.accounts.auth import AuthContext, optional_user, require_owner, require_user
from server.api_auth import get_tenant_one_id
from server.accounts.repository import AccountsRepository
from server.accounts.security import sha256_hex
from server.accounts.service import (
    DEFAULT_ORG_NAME,
    OrgLimitError,
    get_accounts_service,
)
from server.accounts.types import ROLE_MEMBER, ROLE_OWNER
from server.auth_api import serialize_tenant
from server.email_address import is_plain_address
from server.installs_api import _require_accounts_plane, _take, _take_address
from server.persistence.engine import get_session_maker
from server.persistence.models import OrgInviteModel, TenantMemberModel, UserModel, utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

ORG_NAME_MAX = 100

#: Invite mails one account may send: an hour, and a day.
INVITES_PER_HOUR = 10
INVITES_PER_DAY = 30
#: Invite mails one address may get a day, from every org together.
INVITES_PER_ADDRESS_DAY = 3
#: Orgs one account may make a day with ``POST /app/orgs`` (``tenants.made_by``).
ORGS_PER_DAY = 10

HOUR = timedelta(hours=1)
DAY = timedelta(days=1)


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


async def _lock(session, key: str) -> None:
    """A transaction-scoped lock on ``key``: a count and the insert it guards never race."""

    await session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": key}
    )


async def _count_invites(session, *conditions) -> int:
    query = select(func.count()).select_from(OrgInviteModel).where(*conditions)
    return int((await session.execute(query)).scalar_one())


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
    """Make an org with the caller as its owner and no project."""

    if await _name_taken(ctx, payload.name):
        return _refused(409, "taken", "you already have an org with that name")
    try:
        tenant, _member = await get_accounts_service().create_org(
            ctx.user.id,
            payload.name,
            made_by_user=True,
            limit=(ORGS_PER_DAY, utc_now() - DAY),
        )
    except OrgLimitError:
        return _refused(429, "limit", "you made as many orgs as you may today; try tomorrow")
    return {"tenant": serialize_tenant(tenant), "project": None}


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
        # The sender's lock, then the address's: always that order, so never a deadlock.
        await _lock(session, f"invite-sender:{ctx.user.id}")
        await _lock(session, f"invite-recipient:{email}")
        waiting = (
            await session.execute(
                _pending(select(OrgInviteModel.id), now).where(
                    OrgInviteModel.tenant_id == ctx.tenant.id, OrgInviteModel.email == email
                )
            )
        ).first()
        if waiting is not None:
            return _refused(409, "invited", "that address has a pending invite already")
        sent_by = OrgInviteModel.invited_by == ctx.user.id
        if (
            await _count_invites(session, sent_by, OrgInviteModel.created_at > now - HOUR)
            >= INVITES_PER_HOUR
            or await _count_invites(session, sent_by, OrgInviteModel.created_at > now - DAY)
            >= INVITES_PER_DAY
        ):
            return _refused(429, "limit", "you sent as many invites as you may for now")
        if (
            await _count_invites(
                session, OrgInviteModel.email == email, OrgInviteModel.created_at > now - DAY
            )
            >= INVITES_PER_ADDRESS_DAY
        ):
            return _refused(429, "recipient", "that address got as many invites as it may today")
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


def _locked_rows(tenant_id: UUID, user_id: UUID | None = None):
    """The org's member rows, and ``user_id``'s own rows in every org, locked in id order.

    One statement, ``ORDER BY id`` under ``FOR UPDATE``: Postgres sorts before it locks,
    so every membership change takes the rows it shares with another in the same order
    and two of them never deadlock; and two leaves of one account from two orgs at once
    both lock the account's rows, so the later one counts them once the first commits.
    """

    where = TenantMemberModel.tenant_id == tenant_id
    if user_id is not None:
        where = or_(where, TenantMemberModel.user_id == user_id)
    return select(TenantMemberModel).where(where).order_by(TenantMemberModel.id).with_for_update()


async def _end_membership(
    tenant_id: UUID,
    *,
    member_id: UUID | None = None,
    user_id: UUID | None = None,
    by: UUID | None = None,
) -> str:
    """Delete one membership row of ``tenant_id``: ``ended``, ``unknown``, ``forbidden``
    or ``last_owner``.

    The org's member rows and every membership of the row's account are locked first
    (``_locked_rows``), so two owners leaving at once never leave the org with none, and
    of two leaves of one account at once the later counts the account's rows after the
    first commits. ``by`` (a removal's caller) must still be an owner among the locked
    rows, else ``forbidden``. When the row is the account's last membership, the same
    transaction gives the account a fresh org (``_fresh_org``).
    """

    async with get_session_maker()() as session, session.begin():
        if user_id is None:
            # The row's account, read unlocked: a row's account never changes, and the
            # locked read below finds the row again or not at all.
            user_id = (
                await session.execute(
                    select(TenantMemberModel.user_id).where(
                        TenantMemberModel.id == member_id,
                        TenantMemberModel.tenant_id == tenant_id,
                    )
                )
            ).scalar_one_or_none()
            if user_id is None:
                return "unknown"
        rows = (await session.execute(_locked_rows(tenant_id, user_id))).scalars().all()
        in_org = [r for r in rows if r.tenant_id == tenant_id]
        if by is not None and not _owns(in_org, by):
            return "forbidden"
        target = next(
            (
                r
                for r in in_org
                if r.user_id == user_id and (member_id is None or r.id == member_id)
            ),
            None,
        )
        if target is None:
            return "unknown"
        if target.role == ROLE_OWNER and sum(r.role == ROLE_OWNER for r in in_org) <= 1:
            return "last_owner"
        last = sum(r.user_id == user_id for r in rows) <= 1
        await session.execute(delete(TenantMemberModel).where(TenantMemberModel.id == target.id))
        if last:
            await _fresh_org(session, user_id)
    return "ended"


def _owns(rows, user_id: UUID) -> bool:
    """Whether ``user_id`` holds an owner row among ``rows`` (an org's locked rows)."""

    return any(r.user_id == user_id and r.role == ROLE_OWNER for r in rows)


async def _fresh_org(session, user_id: UUID) -> None:
    """A fresh org for an account whose last membership just ended, in the caller's
    transaction, as at sign-up (``AccountsService.provision_signup``): the tenant
    ``Personal`` with no maker (it never counts against the daily limit), the account its
    owner, and no project."""

    repository = AccountsRepository(session)
    tenant = await repository.create_tenant(DEFAULT_ORG_NAME)
    await repository.add_tenant_member(tenant_id=tenant.id, user_id=user_id, role=ROLE_OWNER)


_REFUSALS = {"last_owner": "an org keeps at least one owner"}
#: ``require_owner``'s 403 detail, for the same refusal found under the lock.
_NOT_AN_OWNER = "only an owner of this org can do that"


@router.post("/app/members/{member_id}/owner", status_code=204)
async def make_owner(member_id: UUID, ctx: AuthContext = Depends(require_user)) -> Response:
    """Make a member of the active org an owner (owner only; no confirm)."""

    _require_accounts_plane()
    await require_owner(ctx)
    async with get_session_maker()() as session, session.begin():
        rows = (await session.execute(_locked_rows(ctx.tenant.id))).scalars().all()
        if not _owns(rows, ctx.user.id):  # removed while this waited on the lock
            raise HTTPException(status_code=403, detail=_NOT_AN_OWNER)
        target = next((r for r in rows if r.id == member_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="member not found")
        if target.role != ROLE_OWNER:
            await session.execute(
                update(TenantMemberModel)
                .where(TenantMemberModel.id == target.id)
                .values(role=ROLE_OWNER)
            )
    return Response(status_code=204)


@router.post("/app/members/{member_id}/member", status_code=204, response_model=None)
async def step_down(
    member_id: UUID, ctx: AuthContext = Depends(require_user)
) -> Response | JSONResponse:
    """Step an owner of the active org down to member (owner only; the caller may step
    itself down while another owner stays)."""

    _require_accounts_plane()
    await require_owner(ctx)
    async with get_session_maker()() as session, session.begin():
        rows = (await session.execute(_locked_rows(ctx.tenant.id))).scalars().all()
        if not _owns(rows, ctx.user.id):  # removed or stepped down while this waited
            raise HTTPException(status_code=403, detail=_NOT_AN_OWNER)
        target = next((r for r in rows if r.id == member_id), None)
        if target is None:
            raise HTTPException(status_code=404, detail="member not found")
        if target.role == ROLE_OWNER:
            if sum(r.role == ROLE_OWNER for r in rows) <= 1:
                return _refused(409, "last_owner", _REFUSALS["last_owner"])
            await session.execute(
                update(TenantMemberModel)
                .where(TenantMemberModel.id == target.id)
                .values(role=ROLE_MEMBER)
            )
    return Response(status_code=204)


@router.delete("/app/members/{member_id}", status_code=204, response_model=None)
async def remove_member(
    member_id: UUID, ctx: AuthContext = Depends(require_user)
) -> Response | JSONResponse:
    """Remove a member from the active org (owner only; no confirm)."""

    _require_accounts_plane()
    await require_owner(ctx)
    ended = await _end_membership(ctx.tenant.id, member_id=member_id, by=ctx.user.id)
    if ended == "unknown":
        raise HTTPException(status_code=404, detail="member not found")
    if ended == "forbidden":  # removed while this waited on the lock
        raise HTTPException(status_code=403, detail=_NOT_AN_OWNER)
    if ended in _REFUSALS:
        return _refused(409, ended, _REFUSALS[ended])
    return Response(status_code=204)


@router.post("/app/tenant/leave", status_code=204, response_model=None)
async def leave_org(ctx: AuthContext = Depends(require_user)) -> Response | JSONResponse:
    """Leave the active org (not as its last owner; an only org leaves a fresh one)."""

    _require_accounts_plane()
    ended = await _end_membership(ctx.tenant.id, user_id=ctx.user.id)
    if ended in _REFUSALS:
        return _refused(409, ended, _REFUSALS[ended])
    return Response(status_code=204)


# --- the invite's link --------------------------------------------------------------


# --- delete the org -----------------------------------------------------------------


class ConfirmOrgNameInput(BaseModel):
    """The org's name, typed again to delete it (required; else 422)."""

    name: str = Field(max_length=1000)


@router.delete("/app/tenant", response_model=None)
async def delete_org(
    payload: ConfirmOrgNameInput, ctx: AuthContext = Depends(require_user)
) -> dict[str, object] | JSONResponse:
    """Delete the active org and everything in it for good (owner only; ``server.deletion``)."""

    _require_accounts_plane()
    await require_owner(ctx)
    tenant_one_id = await get_tenant_one_id()
    refusal = deletion.refusal_for_tenant(tenant_id=ctx.tenant.id, tenant_one_id=tenant_one_id)
    if refusal is None and not deletion.typed_name_matches(payload.name, ctx.tenant.name):
        refusal = deletion.WRONG_NAME
    if refusal is not None:
        return _refused(409, refusal.reason, refusal.detail)
    target = deletion.TenantTarget(
        tenant_id=ctx.tenant.id,
        name=payload.name,
        user_id=ctx.user.id,
        root=deletion.tenant_root(ctx.tenant.id, tenant_one_id),
    )
    try:
        outcome = await run_in_threadpool(deletion.delete_tenant, target)
    except Exception:
        logger.error("org delete failed before its commit", exc_info=True)
        raise HTTPException(status_code=503, detail="could not delete the org; try again")
    if outcome == "unknown":
        raise HTTPException(status_code=404, detail="tenant not found")
    if outcome == "forbidden":  # no longer an owner by the time the lock was held
        raise HTTPException(status_code=403, detail=_NOT_AN_OWNER)
    if isinstance(outcome, deletion.Refusal):
        return _refused(409, outcome.reason, outcome.detail)
    tenants = await get_accounts_service().list_tenants_for_user(ctx.user.id)
    return {"tenant": serialize_tenant(tenants[0])}


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
