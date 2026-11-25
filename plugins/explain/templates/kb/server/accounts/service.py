"""Transport-neutral accounts, tenancy, and credential service.

Owns the session lifecycle (open, commit/rollback) and translates SQLAlchemy
errors into domain errors. No HTTP surface, no password hashing (S2 owns
argon2), no token generation (callers pass pre-computed hashes).
"""

from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from server.accounts.repository import AccountsRepository
from server.accounts.slugs import InvalidOrgSlugError, normalize_org_slug
from server.accounts.types import (
    ROLE_OWNER,
    AuthTokenRecord,
    CreateAuthToken,
    CreateProject,
    CreateProjectCredential,
    CreateUser,
    OrgMemberRecord,
    ProjectCredentialRecord,
    ProjectRecord,
    TenantMemberRecord,
    TenantRecord,
    UserRecord,
    validate_credential_scope,
)
from server.persistence.engine import get_session_maker

# The org + project every new user starts with (intent P18): signup and a
# fresh-database seed both provision exactly these, so the two paths never drift.
DEFAULT_ORG_NAME = "default"
DEFAULT_PROJECT_NAME = "default"


class AccountsPersistenceError(RuntimeError):
    """Raised when an accounts write cannot be persisted."""


class AccountsReadError(RuntimeError):
    """Raised when accounts data cannot be read from storage."""


class DuplicateEmailError(AccountsPersistenceError):
    """Raised when creating a user whose email is already registered.

    Lets the signup handler return a clean 409 rather than a generic 500.
    """


class DuplicateOrgSlugError(AccountsPersistenceError):
    """Raised when the requested org slug is already claimed by another tenant.

    The ``UNIQUE(tenants.slug)`` violation, translated — so the slug endpoint
    answers a clean 409 rather than a generic 500 (the ``get_or_create_project``
    ``IntegrityError`` precedent).
    """


class OrgLimitError(RuntimeError):
    """Raised when an account has made as many orgs as ``create_org``'s limit allows."""


class AccountsService:
    """Application service for accounts, tenancy, project, and credential data."""

    def __init__(self, session_maker: async_sessionmaker[AsyncSession]) -> None:
        self._session_maker = session_maker

    # -- users ------------------------------------------------------------

    async def create_user(self, payload: CreateUser) -> UserRecord:
        """Persist a user; raise ``DuplicateEmailError`` on a duplicate email."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.create_user(payload)
                await session.commit()
            except IntegrityError as exc:
                # ``users`` has a single unique constraint (uq_users_email), so
                # any integrity violation here is a duplicate email.
                await session.rollback()
                raise DuplicateEmailError(
                    "a user with this email already exists"
                ) from exc
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError("failed to persist user") from exc

        return record

    async def get_user_by_email(self, email: str) -> UserRecord | None:
        """Return one user by email, or None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_user_by_email(email)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read user") from exc

    async def get_user_by_id(self, user_id: UUID) -> UserRecord | None:
        """Return one user by id, or None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_user_by_id(user_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read user") from exc

    async def list_users_by_status(self, status: str) -> tuple[UserRecord, ...]:
        """Return the users with ``status``, oldest first."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_users_by_status(status)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to list users") from exc

    async def update_user_status(
        self, email: str, *, from_status: str, to_status: str
    ) -> UserRecord | None:
        """Move one user from ``from_status`` to ``to_status``; the updated record, or None.

        None when no user has that email or the user is not in ``from_status``: then
        nothing was written.
        """

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.update_user_status(
                    email, from_status=from_status, to_status=to_status
                )
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError("failed to update user status") from exc

        return record

    # -- tenancy ----------------------------------------------------------

    async def create_tenant_with_owner(
        self,
        user_id: UUID,
        name: str,
    ) -> tuple[TenantRecord, TenantMemberRecord]:
        """Create a tenant and its owner membership in one transaction.

        The signup primitive: inserts the tenant plus an ``owner`` row in
        ``tenant_members`` for ``user_id`` atomically, returning both records.
        """

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                tenant = await repository.create_tenant(name)
                member = await repository.add_tenant_member(
                    tenant_id=tenant.id,
                    user_id=user_id,
                    role="owner",
                )
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to create tenant with owner"
                ) from exc

        return tenant, member

    async def add_tenant_member(
        self,
        tenant_id: UUID,
        user_id: UUID,
        role: str = "member",
    ) -> TenantMemberRecord:
        """Add an existing user to an existing tenant with ``role``.

        The membership primitive for a user who belongs to more than one org (the
        accounts merge, and tests); no HTTP route calls it. A user already in the
        tenant violates ``UNIQUE(tenant_id, user_id)`` and raises
        ``AccountsPersistenceError`` like any other failed write.
        """

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                member = await repository.add_tenant_member(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=role,
                )
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to add tenant member"
                ) from exc

        return member

    async def provision_signup(
        self,
        user_id: UUID,
    ) -> tuple[TenantRecord, TenantMemberRecord, ProjectRecord]:
        """Provision a new user's default org + default project in one transaction.

        The signup primitive: inserts the ``"default"`` tenant (org), an ``owner``
        membership for ``user_id``, and the ``"default"`` project under that tenant —
        all atomically in one session — and returns the three records. Distinct from
        ``create_tenant_with_owner`` (which creates no project and is kept for callers
        that want a bare tenant): a fresh signup always lands with a project to save
        into, so signup and the fresh-database seed share this one primitive.
        """

        return await self.create_org(user_id, DEFAULT_ORG_NAME)

    async def create_org(
        self,
        user_id: UUID,
        name: str,
        *,
        made_by_user: bool = False,
        limit: tuple[int, datetime] | None = None,
    ) -> tuple[TenantRecord, TenantMemberRecord, ProjectRecord]:
        """Make an org named ``name``: the tenant, ``user_id`` as its ``owner`` and one
        project ``"default"``, in one transaction (sign-up's ``"default"`` org is one).

        ``made_by_user`` records ``user_id`` as the org's maker (``tenants.made_by``):
        ``POST /app/orgs`` passes it, sign-up does not, so only the orgs an account made
        by hand count against its limit. With ``limit`` ``(most, since)``,
        ``OrgLimitError`` when the account already made ``most`` orgs since ``since``
        (``count_orgs_made_since``); the count and the new org share the transaction
        under a lock per account, so two creates at once never both pass. The caller
        validates ``name`` (``server.orgs_api``).
        """

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            if limit is not None:
                most, since = limit
                await session.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                    {"key": f"org-create:{user_id}"},
                )
                if await repository.count_orgs_made_since(user_id, since) >= most:
                    raise OrgLimitError("the account made as many orgs as it may for now")
            try:
                tenant = await repository.create_tenant(
                    name, made_by=user_id if made_by_user else None
                )
                member = await repository.add_tenant_member(
                    tenant_id=tenant.id,
                    user_id=user_id,
                    role=ROLE_OWNER,
                )
                project = await repository.create_project(
                    CreateProject(tenant_id=tenant.id, name=DEFAULT_PROJECT_NAME)
                )
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to create the org"
                ) from exc

        return tenant, member, project

    async def set_tenant_name(self, tenant_id: UUID, name: str) -> TenantRecord | None:
        """Rename a tenant (its display name; the slug is its own route); None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.set_tenant_name(tenant_id, name)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError("failed to rename tenant") from exc

        return record

    async def get_member_role(self, tenant_id: UUID, user_id: UUID) -> str | None:
        """The user's role in the tenant (``owner``/``member``), or None for a non-member."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_member_role(tenant_id, user_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read membership") from exc

    async def list_org_members(self, tenant_id: UUID) -> tuple[OrgMemberRecord, ...]:
        """A tenant's members with their addresses, in the order they joined."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_org_members(tenant_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read members") from exc

    async def get_tenant(self, tenant_id: UUID) -> TenantRecord | None:
        """Return one tenant by id, or None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_tenant(tenant_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read tenant") from exc

    async def get_tenant_by_slug(self, slug: str) -> TenantRecord | None:
        """Return one tenant by its public org slug, or None when there is no match.

        The public-URL resolution primitive: an anonymous caller's URL segment comes
        in raw, so the value is normalized first and anything that could never be a
        stored slug (bad charset, wrong length, reserved) short-circuits to ``None``
        **without a DB round trip**. Returning ``None`` rather than raising is
        deliberate — every miss on the anonymous surface must be an indistinguishable
        404, so "malformed" and "unclaimed" have to look identical to callers.
        """

        try:
            normalized = normalize_org_slug(slug)
        except InvalidOrgSlugError:
            return None

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_tenant_by_slug(normalized)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read tenant") from exc

    async def set_tenant_slug(self, tenant_id: UUID, slug: str) -> TenantRecord | None:
        """Claim ``slug`` as a tenant's public identity; None when the tenant is missing.

        Validates before writing (``InvalidOrgSlugError`` on a malformed or reserved
        slug — raised before any session is opened), stores the normalized lowercase
        form, and translates the ``UNIQUE`` violation into ``DuplicateOrgSlugError``
        so a taken slug is a 409 and never a 500. Re-setting a tenant's own current
        slug is a no-op update, not a conflict.
        """

        normalized = normalize_org_slug(slug)

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.set_tenant_slug(tenant_id, normalized)
                await session.commit()
            except IntegrityError as exc:
                # ``tenants`` has exactly one unique constraint (uq_tenants_slug), so
                # any integrity violation here is another tenant holding this slug.
                await session.rollback()
                raise DuplicateOrgSlugError(
                    f"the org slug {normalized!r} is already taken"
                ) from exc
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError("failed to set tenant slug") from exc

        return record

    async def list_tenants_for_user(self, user_id: UUID) -> tuple[TenantRecord, ...]:
        """Return the tenants a user is a member of, in the order the user joined them."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_tenants_for_user(user_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read tenants") from exc

    # -- projects ---------------------------------------------------------

    async def create_project(self, payload: CreateProject) -> ProjectRecord:
        """Persist a project and return the stored record."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.create_project(payload)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError("failed to persist project") from exc

        return record

    async def get_project(self, project_id: UUID) -> ProjectRecord | None:
        """Return one project by id, or None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_project(project_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read project") from exc

    async def list_projects_for_tenant(
        self,
        tenant_id: UUID,
    ) -> tuple[ProjectRecord, ...]:
        """Return a tenant's projects, oldest-first."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_projects_for_tenant(tenant_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read projects") from exc

    async def get_project_by_name(
        self,
        tenant_id: UUID,
        name: str,
    ) -> ProjectRecord | None:
        """Return a tenant's project by name (oldest-wins), or None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_project_by_name(tenant_id, name)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read project") from exc

    async def get_or_create_project(
        self,
        tenant_id: UUID,
        name: str,
    ) -> ProjectRecord:
        """Return the tenant's project named ``name``, creating it if absent.

        The write-path (and dupe-name ``POST /app/projects``) primitive: read by
        name first, else insert. Race-safe against ``UNIQUE(tenant_id, name)`` (added
        in 0003) — a concurrent insert that wins the race surfaces as an
        ``IntegrityError`` on flush, which is rolled back and re-read so both callers
        converge on the same row (never a 500).
        """

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                existing = await repository.get_project_by_name(tenant_id, name)
                if existing is not None:
                    return existing
                try:
                    record = await repository.create_project(
                        CreateProject(tenant_id=tenant_id, name=name)
                    )
                    await session.commit()
                    return record
                except IntegrityError:
                    # A concurrent insert won the UNIQUE(tenant_id, name) race —
                    # roll back and re-read the row the other writer committed.
                    await session.rollback()
                    raced = await repository.get_project_by_name(tenant_id, name)
                    if raced is not None:
                        return raced
                    raise
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to get or create project"
                ) from exc

    async def get_owner_email_for_project(self, project_id: UUID) -> str | None:
        """Return the email of the owner of the project's org, or None."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_owner_email_for_project(project_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read project owner") from exc

    async def set_project_visibility(
        self,
        project_id: UUID,
        visibility: str,
    ) -> ProjectRecord | None:
        """Set a project's visibility (``"private"``/``"public"``); None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.set_project_visibility(
                    project_id, visibility
                )
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to set project visibility"
                ) from exc

        return record

    # -- credentials ------------------------------------------------------

    async def create_project_credential(
        self,
        payload: CreateProjectCredential,
    ) -> ProjectCredentialRecord:
        """Persist a project credential and return its metadata record.

        Raises ``ValueError`` before any DB work when ``payload.scope`` is not one of
        ``CREDENTIAL_SCOPES`` (the column has no DB ``CHECK``; this is the guard).
        """

        validate_credential_scope(payload.scope)

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.create_project_credential(payload)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to persist project credential"
                ) from exc

        return record

    async def list_project_credentials(
        self,
        project_id: UUID,
    ) -> tuple[ProjectCredentialRecord, ...]:
        """Return a project's credentials (active and revoked), oldest-first."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_project_credentials(project_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError(
                    "failed to read project credentials"
                ) from exc

    async def list_org_credentials(
        self,
        tenant_id: UUID,
    ) -> tuple[ProjectCredentialRecord, ...]:
        """Return a tenant's org-level credentials (``project_id NULL``), oldest-first."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.list_org_credentials(tenant_id)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError(
                    "failed to read org credentials"
                ) from exc

    async def get_active_credential_by_token_hash(
        self,
        token_hash: str,
    ) -> ProjectCredentialRecord | None:
        """Return the active credential for a token hash, or None."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_active_credential_by_token_hash(
                    token_hash
                )
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError(
                    "failed to read project credential"
                ) from exc

    async def revoke_credential(
        self,
        credential_id: UUID,
    ) -> ProjectCredentialRecord | None:
        """Soft-revoke a credential by id; None when missing."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.revoke_credential(credential_id)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to revoke project credential"
                ) from exc

        return record

    async def touch_credential_last_used(self, credential_id: UUID) -> None:
        """Stamp a credential's ``last_used_at`` to now."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                await repository.touch_credential_last_used(credential_id)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to update project credential"
                ) from exc

    # -- sessions ---------------------------------------------------------

    async def create_auth_token(self, payload: CreateAuthToken) -> AuthTokenRecord:
        """Persist a session token and return its metadata record."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                record = await repository.create_auth_token(payload)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to persist auth token"
                ) from exc

        return record

    async def get_active_auth_token_by_hash(
        self,
        token_hash: str,
    ) -> AuthTokenRecord | None:
        """Return the active session token for a hash, or None."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                return await repository.get_active_auth_token_by_hash(token_hash)
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsReadError("failed to read auth token") from exc

    async def delete_auth_token(self, token_hash: str) -> bool:
        """Delete a session token by hash (logout). True when a row was removed."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                deleted = await repository.delete_auth_token(token_hash)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to delete auth token"
                ) from exc

        return deleted

    async def touch_auth_token_last_used(self, token_hash: str) -> None:
        """Stamp a session token's ``last_used_at`` to now."""

        async with self._session_maker() as session:
            repository = AccountsRepository(session)
            try:
                await repository.touch_auth_token_last_used(token_hash)
                await session.commit()
            except SQLAlchemyError as exc:
                await session.rollback()
                raise AccountsPersistenceError(
                    "failed to update auth token"
                ) from exc


def get_accounts_service() -> AccountsService:
    """Return the shared accounts service."""

    return AccountsService(get_session_maker())
