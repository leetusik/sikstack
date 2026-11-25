"""Org invites: the code, the state, the accept and the invite mail.

An org's owner invites an address (``server.orgs_api``); the invite binds to that
address. Its code (``inv_`` and a high-entropy URL-safe token) goes only into the
mail, as ``<KB_PUBLIC_BASE_URL>/invite?code=<code>``; the row keeps its sha256
(``org_invites.token_hash``, revision ``0014``). An invite is, at a given moment,
exactly one of:

- ``used``: accepted (``accepted_at``), whatever else is true;
- ``revoked``: revoked by an owner before it was used;
- ``expired``: ``expires_at`` (7 days after it was made, ``INVITE_TTL``) has passed;
- ``valid``: none of those.

:func:`accept` is the one way in: an account whose email equals the invited address
joins the org as ``member`` and the invite becomes used, under the invite's row lock,
in one transaction. Another account is refused (``other``) and changes nothing. With
``approve`` (sign-in and sign-up carrying the code, ``server.auth_api``) the same
transaction flips a ``waitlisted`` account to ``approved``, so a waitlisted invitee
gets in through the invite, and only through an invite to its own address.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.message import EmailMessage

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from server import config
from server.accounts.repository import AccountsRepository
from server.accounts.security import generate_opaque_token, sha256_hex
from server.accounts.types import USER_APPROVED, USER_WAITLISTED, TenantRecord, UserRecord
from server.feedback import notify
from server.persistence.engine import get_session_maker
from server.persistence.models import OrgInviteModel, TenantMemberModel, UserModel, utc_now
from server.waitlist import _message

logger = logging.getLogger(__name__)

INVITE_TTL = timedelta(days=7)
CODE_PREFIX = "inv_"
#: A carried code longer than this is no code of ours (read without a lookup).
MAX_CODE_CHARS = 200

STATE_VALID = "valid"
STATE_EXPIRED = "expired"
STATE_REVOKED = "revoked"
STATE_USED = "used"

#: Fixed: an org's name is any text its owner chose, so it never goes in a subject.
INVITE_SUBJECT = "You're invited to an org on sikstack"
#: The org's name and the inviter's address are data, each on its own labelled line of
#: a plain-text mail (an org name holds no control character, ``server.orgs_api``);
#: the only link is the invite's own.
INVITE_BODY = """\
Hi,

You're invited to join an org on sikstack as a member.

Org: {org}
Invited by: {inviter}

Join here: {url}

The link works for 7 days, for {email} only: sign in or create an account with that address.

sikstack
"""


def new_code() -> str:
    """A new invite code: ``inv_`` and 43 URL-safe characters."""

    return CODE_PREFIX + generate_opaque_token()


def normalize_email(raw: str) -> str:
    """An address as invites store and compare it: trimmed, lowercase."""

    return raw.strip().lower()


def invite_url(code: str) -> str:
    """The invite's link: the web's ``/invite`` page on the public origin."""

    return f"{config.public_base_url()}/invite?code={code}"


def invite_state(row: OrgInviteModel, now: datetime) -> str:
    """``used``, ``revoked``, ``expired`` or ``valid``, in that order of precedence."""

    if row.accepted_at is not None:
        return STATE_USED
    if row.revoked_at is not None:
        return STATE_REVOKED
    if row.expires_at <= now:
        return STATE_EXPIRED
    return STATE_VALID


async def find_by_code(session, code: str | None, *, lock: bool = False) -> OrgInviteModel | None:
    """The invite a carried code names, or None (no lookup for a code that cannot be one)."""

    if not code or len(code) > MAX_CODE_CHARS:
        return None
    query = select(OrgInviteModel).where(OrgInviteModel.token_hash == sha256_hex(code))
    if lock:
        query = query.with_for_update()
    return (await session.execute(query)).scalar_one_or_none()


@dataclass(slots=True)
class AcceptResult:
    """What an accept did.

    ``state``: ``joined`` (the account joined now), ``member`` (it was a member
    already), ``other`` (the invite is for another address), ``unknown`` (no such
    code), or the invite's own ``expired``/``revoked``/``used``. ``accepted`` is True
    only when this call used a valid invite (``joined``, or ``member`` on a valid one);
    only then did ``approve`` approve the account.
    """

    state: str
    tenant: TenantRecord | None = None
    accepted: bool = False


async def accept(user: UserRecord, code: str | None, *, approve: bool = False) -> AcceptResult:
    """Accept the invite ``code`` names as ``user`` (see the module docstring)."""

    now = utc_now()
    async with get_session_maker()() as session, session.begin():
        row = await find_by_code(session, code, lock=True)
        if row is None:
            return AcceptResult("unknown")
        repository = AccountsRepository(session)
        tenant = await repository.get_tenant(row.tenant_id)
        is_member = await repository.get_member_role(row.tenant_id, user.id) is not None
        state = invite_state(row, now)
        if state != STATE_VALID:
            return AcceptResult("member" if is_member else state, tenant)
        if normalize_email(user.email) != row.email:
            return AcceptResult("other", tenant)
        if not is_member:
            await session.execute(
                pg_insert(TenantMemberModel)
                .values(tenant_id=row.tenant_id, user_id=user.id, role=row.role, created_at=now)
                .on_conflict_do_nothing(index_elements=["tenant_id", "user_id"])
            )
        row.accepted_at = now
        row.accepted_by = user.id
        if approve:
            await session.execute(
                update(UserModel)
                .where(UserModel.id == user.id, UserModel.status == USER_WAITLISTED)
                .values(status=USER_APPROVED)
            )
        return AcceptResult("member" if is_member else "joined", tenant, accepted=True)


def render_invite_message(to_email: str, org_name: str, inviter: str, code: str) -> EmailMessage:
    """The invite mail: who invites, into which org, the link, and the address it is for."""

    body = INVITE_BODY.format(inviter=inviter, org=org_name, url=invite_url(code), email=to_email)
    return _message(INVITE_SUBJECT, body, to_email)


async def send_invite_mail(to_email: str, org_name: str, inviter: str, code: str) -> None:
    """Send the invite mail; never raises (scheduled after the invite's response).

    With SMTP unconfigured (a local stack, a self-hosted install without mail) the link
    is logged instead, so the owner can hand it over; with SMTP configured it never is.
    """

    if not config.smtp_configured():
        logger.warning(
            "SMTP is not configured; no invite mail to %s. The invite link: %s",
            to_email,
            invite_url(code),
        )
        return
    try:
        message = render_invite_message(to_email, org_name, inviter, code)
        await asyncio.to_thread(notify.send_message, message)
    except Exception:  # best-effort: a mail never fails an invite
        logger.exception("Invite mail to %s failed; dropped", to_email)
