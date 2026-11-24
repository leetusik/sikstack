"""Transport-neutral accounts, tenancy, and credential data types.

No ORM objects cross this boundary. Records carry metadata only; raw session
tokens and project keys are never returned, and credential records expose only
the short ``token_prefix`` (never ``token_hash``).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

# The allowed values of the two app-validated value columns (no DB ``CHECK``, the
# ``projects.visibility`` convention). One place each: every write path checks here.
#: ``tenants.plan``: an org's plan. Only the migration default writes it today.
TENANT_PLANS: frozenset[str] = frozenset({"free"})
#: ``project_credentials.scope``: ``full`` reaches every Library and capture surface;
#: ``capture`` only the Feedback capture surfaces (``server.api_auth.resolve_api_capture``);
#: ``workspace`` only its own project's workspace routes
#: (``server.api_auth.resolve_api_workspace``), so it is always bound to a project.
CREDENTIAL_SCOPE_WORKSPACE = "workspace"
CREDENTIAL_SCOPES: frozenset[str] = frozenset({"full", "capture", CREDENTIAL_SCOPE_WORKSPACE})
#: ``users.status`` (0010): only an ``approved`` user holds a session. A ``waitlisted``
#: one (signed up while ``KB_SIGNUP_WAITLIST`` was on) gets no token from sign-up or
#: sign-in, and every session resolver refuses one until ``python -m server.waitlist
#: approve`` flips it.
USER_APPROVED = "approved"
USER_WAITLISTED = "waitlisted"
USER_STATUSES: frozenset[str] = frozenset({USER_APPROVED, USER_WAITLISTED})


def validate_credential_scope(scope: str) -> str:
    """Return ``scope`` when it is a known credential scope, else raise ``ValueError``."""

    if scope not in CREDENTIAL_SCOPES:
        raise ValueError(
            f"unknown credential scope {scope!r}; expected one of {sorted(CREDENTIAL_SCOPES)}"
        )
    return scope


def validate_user_status(status: str) -> str:
    """Return ``status`` when it is a known user status, else raise ``ValueError``."""

    if status not in USER_STATUSES:
        raise ValueError(
            f"unknown user status {status!r}; expected one of {sorted(USER_STATUSES)}"
        )
    return status


@dataclass(slots=True, kw_only=True)
class CreateUser:
    """Input for creating a user. ``password_hash`` is pre-computed by the caller.

    ``status`` is ``approved`` unless sign-up runs with the waitlist switch on.
    """

    email: str
    password_hash: str
    status: str = USER_APPROVED


@dataclass(slots=True, kw_only=True)
class UserRecord:
    """Stored user. Carries ``password_hash`` so login can verify it.

    ``status`` is one of ``USER_STATUSES``; only an ``approved`` user holds a session
    (``is_approved``).
    """

    id: UUID
    email: str
    password_hash: str
    created_at: datetime
    status: str = USER_APPROVED

    @property
    def is_approved(self) -> bool:
        return self.status == USER_APPROVED


@dataclass(slots=True, kw_only=True)
class TenantRecord:
    """Stored tenant.

    ``slug`` is the tenant's public URL identity, or ``None`` when it has never
    claimed one (in which case it simply has no pretty URL and keeps today's
    id/uuid links). Always lowercase — see ``server.accounts.slugs``. ``plan`` is
    one of ``TENANT_PLANS`` (``"free"`` by default; no API route writes it).
    """

    id: UUID
    name: str
    slug: str | None
    plan: str
    created_at: datetime


@dataclass(slots=True, kw_only=True)
class TenantMemberRecord:
    """Stored tenant membership."""

    id: UUID
    tenant_id: UUID
    user_id: UUID
    role: str
    created_at: datetime


#: ``tenant_members.role``: an org's owner (made it, renames it, invites and revokes)
#: and a member (joined by an invite). App-validated, like the values above.
ROLE_OWNER = "owner"
ROLE_MEMBER = "member"


@dataclass(slots=True, kw_only=True)
class OrgMemberRecord:
    """One member of an org as its members list shows it: the address and the role."""

    id: UUID
    user_id: UUID
    email: str
    role: str
    joined_at: datetime


@dataclass(slots=True, kw_only=True)
class CreateProject:
    """Input for creating a project under a tenant.

    ``visibility`` defaults to ``"private"`` so every existing creation path keeps
    making private projects; only an explicit caller opts a new row into ``"public"``.
    """

    tenant_id: UUID
    name: str
    visibility: str = "private"


@dataclass(slots=True, kw_only=True)
class ProjectRecord:
    """Stored project. ``visibility`` is ``"private"`` or ``"public"``."""

    id: UUID
    tenant_id: UUID
    name: str
    visibility: str
    created_at: datetime


@dataclass(slots=True, kw_only=True)
class CreateProjectCredential:
    """Input for storing a credential.

    ``tenant_id`` is always set (the credential is authorized at org scope from it).
    ``project_id`` binds the credential to a project for attribution; an org-level
    credential (introduced by the org-mint path) leaves it ``None``. The caller
    computes ``token_prefix`` (short display prefix) and ``token_hash`` (sha256 hex
    of the plaintext key); the raw key is never stored. ``scope`` is one of
    ``CREDENTIAL_SCOPES`` (``"full"`` unless the minter asks for another). A
    ``workspace`` credential without a ``project_id`` is a ``ValueError`` here, so an
    unbound one never reaches the table whichever path builds it.
    """

    tenant_id: UUID
    token_prefix: str
    token_hash: str
    project_id: UUID | None = None
    name: str | None = None
    scope: str = "full"

    def __post_init__(self) -> None:
        if self.scope == CREDENTIAL_SCOPE_WORKSPACE and self.project_id is None:
            raise ValueError("a workspace credential must be bound to a project")


@dataclass(slots=True, kw_only=True)
class ProjectCredentialRecord:
    """Stored credential metadata. Never exposes ``token_hash``.

    ``project_id`` is ``None`` for an org-level credential (project-bound rows keep
    it set for attribution). ``scope`` is one of ``CREDENTIAL_SCOPES``.
    """

    id: UUID
    tenant_id: UUID
    project_id: UUID | None
    name: str | None
    token_prefix: str
    scope: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


@dataclass(slots=True, kw_only=True)
class CreateAuthToken:
    """Input for storing a session token.

    ``token_hash`` is the sha256 hex of the opaque bearer token; the raw token is
    never stored. ``expires_at`` NULL means no expiry (policy set by the caller).
    """

    user_id: UUID
    token_hash: str
    expires_at: datetime | None = None


@dataclass(slots=True, kw_only=True)
class AuthTokenRecord:
    """Stored session token metadata. Never exposes ``token_hash``."""

    id: UUID
    user_id: UUID
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
